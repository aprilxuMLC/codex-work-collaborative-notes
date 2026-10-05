import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import vm from "node:vm";
import { afterEach, test } from "node:test";

import { createSourcedNote, createNote, editNote, deleteNote, readNotes } from "../../plugins/collaborative-notes/server/lib/notes-ops.js";
import { getSetupState, setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { changeLocation } from "../../plugins/collaborative-notes/server/lib/location-change.js";
import { acquireLock, releaseLock } from "../../plugins/collaborative-notes/server/lib/lane-store.js";
import { pathKey, withProjectWrite } from "../../plugins/collaborative-notes/server/lib/project-write.js";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";
import { createMcpServer } from "../../plugins/collaborative-notes/server/mcp.mjs";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";

const threadId = "thread-location";
const lane = "conversation_todo";
const temporary = [];

afterEach(async () => {
  while (temporary.length) await fs.rm(temporary.pop(), { recursive: true, force: true });
});

async function fixture(prefix = "cn-location-") {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(base);
  const project = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(project);
  return { base, project, dataDir };
}

function stubAppServer(project) {
  return {
    async readThread(id) { return { id, cwd: project, name: "Location test" }; },
    close() {},
  };
}

async function startService({ project, dataDir, platform = "win32" }) {
  const secret = "a".repeat(64);
  const service = new PanelService({
    dataDir,
    secret,
    platform,
    appserver: stubAppServer(project),
    threadContext: async (id) => ({ holder: id, projectPath: project, title: "Location test" }),
    preferredPort: 0,
    idleMs: 60_000,
    env: { ...process.env, CN_FORK_WATCH: "0" },
  });
  service.server = { address: () => ({ port: 4321 }), close: (callback) => callback?.() };
  const running = { close: async () => service.close?.() };
  const request = async (suffix, body, method = "POST") => {
    const input = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    input.method = method;
    input.url = `/api/t/${threadId}${suffix}`;
    input.headers = { "content-type": "application/json", "x-cn-token": panelToken(secret, threadId) };
    const result = { status: 200, body: "" };
    const response = {
      destroyed: false,
      writeHead(status) { result.status = status; },
      end(value = "") { result.body += value; },
    };
    await service.request(input, response);
    return { status: result.status, json: async () => JSON.parse(result.body) };
  };
  return { service, running, request };
}

async function folderSnapshot(root) {
  const entries = [];
  async function visit(current, relative = "") {
    for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const next = relative ? path.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        entries.push([next, "directory", null]);
        await visit(path.join(current, entry.name), next);
      }
      else entries.push([next, entry.isFile() ? "file" : "other", entry.isFile() ? (await fs.readFile(path.join(current, entry.name))).toString("base64") : null]);
    }
  }
  await visit(root);
  return entries;
}

test("Windows move copies managed notes, keeps the old root, and switches later writes", async () => {
  const { project, dataDir, base } = await fixture();
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  const sourceReal = await fs.realpath(source);
  const context = { dataDir, projectPath: project, holder: threadId, platform: "win32" };
  assert.equal((await createNote(context, lane, { content: "keep me" })).ok, true);

  const { service, running, request } = await startService({ project, dataDir });
  try {
    const response = await request("/location/move", {
      expectedRoot: sourceReal,
      targetPath: target,
    });
    const payload = await response.json();
    const targetReal = await fs.realpath(target);
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.oldRoot, sourceReal);
    assert.equal(payload.root, targetReal);
    assert.equal(payload.copiedFiles, 1);
    assert.equal(await fs.access(path.join(source, lane, `${threadId}.md`)).then(() => true, () => false), true);
    assert.match(await fs.readFile(path.join(target, lane, `${threadId}.md`), "utf8"), /keep me/);
    assert.equal((await getSetupState(dataDir, project)).root, targetReal);
    assert.equal((await createNote(context, lane, { content: "new root" })).ok, true);
    assert.match(await fs.readFile(path.join(target, lane, `${threadId}.md`), "utf8"), /new root/);
    assert.doesNotMatch(await fs.readFile(path.join(source, lane, `${threadId}.md`), "utf8"), /new root/);
  } finally {
    await running.close();
    await service.close?.();
  }
});

test("Windows move endpoint refuses every invalid validation case without changing either folder", async () => {
  const cases = [
    { name: "stale expectedRoot", code: "LOCATION_CHANGED", target: ({ base }) => path.join(base, "target"), expected: ({ base }) => path.join(base, "stale") },
    { name: "unchanged root", code: "LOCATION_UNCHANGED", target: ({ source }) => source },
    { name: "target inside source", code: "LOCATION_OVERLAP", target: ({ source }) => path.join(source, "nested-target") },
    { name: "source inside target", code: "LOCATION_OVERLAP", target: ({ container }) => container, sourceInContainer: true },
    { name: "target used by another project", code: "LOCATION_OCCUPIED", target: ({ otherRoot }) => otherRoot, otherProject: true },
    { name: "non-empty target", code: "TARGET_NOT_EMPTY", target: ({ target }) => target, nonEmpty: true },
    { name: "unknown managed contents", code: "UNKNOWN_NOTE_FILE", target: ({ target }) => target, unknown: true },
  ];

  for (const validation of cases) {
    const { project, dataDir, base } = await fixture(`cn-location-validation-${validation.name.replaceAll(" ", "-")}-`);
    const rootBase = await fs.realpath(base);
    const container = path.join(rootBase, "container");
    const source = validation.sourceInContainer ? path.join(container, "source") : path.join(rootBase, "source");
    const target = path.join(rootBase, "target");
    const otherProject = path.join(rootBase, "other-project");
    const otherRoot = path.join(rootBase, "other-root");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(target);
    if (validation.otherProject) await fs.mkdir(otherProject);
    if (validation.otherProject) await fs.mkdir(otherRoot);
    assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true, validation.name);
    if (validation.otherProject) assert.equal((await setup(dataDir, otherProject, "custom", otherRoot, { platform: "win32" })).ok, true, validation.name);
    const sourceReal = await fs.realpath(source);
    const targetPath = validation.target({ base: rootBase, source, target, container, otherRoot });
    await fs.mkdir(targetPath, { recursive: true });
    if (validation.nonEmpty) await fs.writeFile(path.join(target, ".hidden"), "keep");
    if (validation.unknown) {
      await fs.mkdir(path.join(source, lane));
      await fs.writeFile(path.join(source, lane, "unrecognized.txt"), "do not guess");
    }

    const expectedRoot = validation.expected ? validation.expected({ base }) : sourceReal;
    const sourceBefore = await folderSnapshot(source);
    const targetBefore = await folderSnapshot(targetPath);
    const stateBefore = await getSetupState(dataDir, project);
    const started = await startService({ project, dataDir, platform: "win32" });
    try {
      const response = await started.request("/location/move", { expectedRoot, targetPath });
      assert.equal((await response.json()).code, validation.code, validation.name);
      const conflictStatus = ["LOCATION_CHANGED", "LOCATION_UNCHANGED", "LOCATION_OVERLAP", "TARGET_NOT_EMPTY"].includes(validation.code) ? 409 : 400;
      assert.equal(response.status, conflictStatus, validation.name);
    } finally {
      await started.running.close();
      await started.service.close?.();
    }
    assert.deepEqual(await getSetupState(dataDir, project), stateBefore, validation.name);
    assert.deepEqual(await folderSnapshot(source), sourceBefore, validation.name);
    assert.deepEqual(await folderSnapshot(targetPath), targetBefore, validation.name);
  }
});

test("Windows move refuses a non-empty target and preserves the old binding after failure", async () => {
  const { project, dataDir, base } = await fixture();
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  await fs.writeFile(path.join(target, ".hidden"), "x");
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  const result = await changeLocation(dataDir, project, { expectedRoot: await fs.realpath(source), targetPath: target }, { platform: "win32" });
  assert.equal(result.code, "TARGET_NOT_EMPTY");
  assert.equal((await getSetupState(dataDir, project)).root, await fs.realpath(source));
});

test("Windows copy or binding failure leaves the old binding active", async () => {
  const { project, dataDir, base } = await fixture();
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  const sourceReal = await fs.realpath(source);
  const context = { dataDir, projectPath: project, holder: threadId, platform: "win32" };
  assert.equal((await createNote(context, lane, { content: "preserve" })).ok, true);
  const originalCopy = fs.copyFile;
  try {
    fs.copyFile = async () => { throw Object.assign(new Error("injected"), { code: "EIO" }); };
    assert.equal((await changeLocation(dataDir, project, { expectedRoot: sourceReal, targetPath: target }, { platform: "win32" })).code, "COPY_FAILED");
  } finally { fs.copyFile = originalCopy; }
  assert.equal((await getSetupState(dataDir, project)).root, await fs.realpath(source));
  assert.match(await fs.readFile(path.join(source, lane, `${threadId}.md`), "utf8"), /preserve/);
});

test("move is unavailable on darwin and project writes do not create lock files there", async () => {
  const { project, dataDir, base } = await fixture();
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "darwin" })).ok, true);
  let called = false;
  const result = await withProjectWrite(dataDir, project, async (resolved) => {
    called = true;
    assert.equal(resolved, undefined);
    return { ok: true };
  }, { platform: "darwin" });
  assert.deepEqual(result, { ok: true });
  assert.equal(called, true);
  assert.equal(await fs.access(path.join(dataDir, "project-write-locks")).then(() => true, () => false), false);
  const { service, running, request } = await startService({ project, dataDir, platform: "darwin" });
  try {
    const response = await request("/location/move", { expectedRoot: await fs.realpath(source), targetPath: target });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "NOT_FOUND");
  } finally {
    await running.close();
    await service.close?.();
  }
});

test("first-use overlap protection is Windows-only", async () => {
  const { project, dataDir, base } = await fixture();
  const otherProject = path.join(base, "other-project");
  const shared = path.join(base, "shared");
  await Promise.all([fs.mkdir(otherProject), fs.mkdir(shared)]);
  assert.equal((await setup(dataDir, otherProject, "custom", shared, { platform: "win32" })).ok, true);
  assert.equal((await setup(dataDir, project, "custom", shared, { platform: "darwin" })).ok, true);
  const secondData = path.join(base, "second-data");
  const winProject = path.join(base, "win-project");
  await fs.mkdir(winProject);
  assert.equal((await setup(secondData, otherProject, "custom", shared, { platform: "win32" })).ok, true);
  assert.equal((await setup(secondData, winProject, "custom", shared, { platform: "win32" })).code, "LOCATION_OCCUPIED");
});

test("a Windows move reports unavailable current roots without changing state", async () => {
  const { project, dataDir, base } = await fixture();
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  const sourceReal = await fs.realpath(source);
  await fs.rm(source, { recursive: true });
  const result = await changeLocation(dataDir, project, { expectedRoot: sourceReal, targetPath: target }, { platform: "win32" });
  assert.equal(result.code, "CONFIGURED_ROOT_UNAVAILABLE");
});

test("path lock keys are stable for the injected Windows platform", async () => {
  const { project, dataDir } = await fixture();
  const called = await withProjectWrite(dataDir, project, async (resolved) => pathKey(resolved, "win32"), { platform: "win32" });
  assert.equal(typeof called, "string");
  await fs.rm(path.join(dataDir, "project-write-locks"), { recursive: true, force: true });
});

test("production MCP note writers use the Windows project lock and stay direct on Darwin", async () => {
  const windows = await fixture("cn-mcp-project-lock-");
  const source = path.join(windows.base, "source");
  await fs.mkdir(source);
  assert.equal((await setup(windows.dataDir, windows.project, "custom", source, { platform: "win32" })).ok, true);
  const context = { dataDir: windows.dataDir, projectPath: windows.project, holder: threadId, platform: "win32" };
  const created = await createNote(context, lane, { content: "editable" });
  assert.equal(created.ok, true);
  const current = await readNotes(context, lane);
  const note = current.notes[0];

  let enter;
  let finish;
  const entered = new Promise((resolve) => { enter = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  const active = withProjectWrite(windows.dataDir, windows.project, async () => {
    enter();
    await hold;
    return { ok: true };
  }, { platform: "win32" });
  await entered;
  try {
    const server = createMcpServer({
      platform: "win32",
      resolveDataDirectory: async () => windows.dataDir,
      contextResolver: async () => ({ projectPath: windows.project }),
    });
    const [write, edit] = await Promise.all([
      server.callTool("notes-write", { lane, content: "blocked" }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" }),
      server.callTool("notes-edit", { lane, itemKey: note.itemKey, content: "blocked edit", expectedVersion: current.version }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" }),
    ]);
    assert.equal(JSON.parse(write.content[0].text).code, "NOTES_LOCATION_BUSY");
    assert.equal(JSON.parse(edit.content[0].text).code, "NOTES_LOCATION_BUSY");
  } finally {
    finish();
    await active;
  }

  const darwin = await fixture("cn-mcp-darwin-direct-");
  const darwinRoot = path.join(darwin.base, "notes");
  await fs.mkdir(darwinRoot);
  assert.equal((await setup(darwin.dataDir, darwin.project, "custom", darwinRoot, { platform: "darwin" })).ok, true);
  const darwinServer = createMcpServer({
    platform: "darwin",
    resolveDataDirectory: async () => darwin.dataDir,
    contextResolver: async () => ({ projectPath: darwin.project }),
  });
  const written = await darwinServer.callTool("notes-write", { lane, content: "direct" }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
  assert.equal(written.isError, undefined);
  assert.equal(await fs.access(path.join(darwin.dataDir, "project-write-locks")).then(() => true, () => false), false);
});

test("readNotes follows the switched binding with realpath-normalized roots", async () => {
  const { project, dataDir, base } = await fixture();
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  const context = { dataDir, projectPath: project, holder: threadId, platform: "win32" };
  await createNote(context, lane, { content: "portable" });
  const moved = await changeLocation(dataDir, project, { expectedRoot: await fs.realpath(source), targetPath: target }, { platform: "win32" });
  assert.equal(moved.root, await fs.realpath(target));
  assert.deepEqual((await readNotes(context, lane)).notes.map((note) => note.authored), ["portable"]);
});

test("Darwin setup validates before taking the bindings lock and preserves main validation precedence", async () => {
  const { project, dataDir } = await fixture("cn-darwin-equivalence-");
  await fs.mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, "bindings.json.lock");
  const held = await acquireLock(lockPath, { staleOnlyIfHolderDead: true });
  assert.equal(held.ok, true);
  try {
    const startedAt = Date.now();
    const invalidSetup = await setup(dataDir, project, "invalid", undefined, { platform: "darwin" });
    assert.deepEqual(invalidSetup, { ok: false, code: "BAD_ACTION" });
    assert.ok(Date.now() - startedAt < 1000, "invalid Darwin setup must not wait on bindings.json.lock");
  } finally {
    await releaseLock(lockPath, held.handle);
  }
  assert.equal(await fs.access(lockPath).then(() => true, () => false), false);

  assert.equal((await createNote({}, lane, { content: "" })).code, "EMPTY_CONTENT");
  assert.equal((await createSourcedNote({}, lane, { snapshot: "" })).code, "EMPTY_SNAPSHOT");
  assert.equal((await editNote({}, lane, "item", undefined, "0")).code, "INVALID_CONTENT");
  assert.equal((await deleteNote({}, lane, "item", "0")).code, "INVALID_CONTEXT");
});

test("Darwin context response has the exact main shape, without locationChange", async () => {
  const { project, dataDir } = await fixture("cn-darwin-context-");
  const { service, running, request } = await startService({ project, dataDir, platform: "darwin" });
  try {
    const result = await request("/context", undefined, "GET");
    assert.equal(Object.hasOwn(await result.json(), "locationChange"), false);
  } finally {
    await running.close();
    await service.close?.();
  }
});

test("Darwin carry validation happens before any Windows project-lock work", async () => {
  const { project, dataDir } = await fixture("cn-darwin-carry-");
  const { service, running, request } = await startService({ project, dataDir, platform: "darwin" });
  try {
    const response = await request("/carry", { choice: "invalid" });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_CHOICE");
    assert.equal(await fs.access(path.join(dataDir, "project-write-locks")).then(() => true, () => false), false);
  } finally {
    await running.close();
    await service.close?.();
  }
});

test("existing i18n keys remain byte-equivalent to main while Windows move keys are namespaced", async () => {
  const file = "plugins/collaborative-notes/server/panel/i18n.js";
  const load = (source) => {
    const sandbox = {};
    vm.runInNewContext(source, sandbox);
    return sandbox.CollaborativeNotesI18n;
  };
  const current = load(await fs.readFile(file, "utf8"));
  const main = load(execFileSync("/usr/bin/git", ["show", `9c530f1:${file}`], { encoding: "utf8" }));
  for (const locale of ["zh", "en"]) {
    for (const key of Object.keys(main[locale])) assert.equal(current[locale][key], main[locale][key], `${locale}.${key}`);
  }
  assert.equal(current.en["error.LOCATION_OCCUPIED"], undefined);
  assert.equal(typeof current.en["location.error.LOCATION_OCCUPIED"], "string");
});

test("Windows enumeration copies case-variant managed directories and canonical file names", async () => {
  const { project, dataDir, base } = await fixture("cn-location-case-");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  await fs.mkdir(path.join(source, "Conversation_Todo"));
  await fs.writeFile(path.join(source, "Conversation_Todo", `${threadId}.MD`), "case variant note");
  const result = await changeLocation(dataDir, project, {
    expectedRoot: await fs.realpath(source), targetPath: target,
  }, { platform: "win32" });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await fs.readFile(path.join(target, "conversation_todo", `${threadId}.md`), "utf8"), "case variant note");
});

test("Windows enumeration refuses ambiguous case-duplicate managed entries", async () => {
  const { project, dataDir, base } = await fixture("cn-location-ambiguous-");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  await fs.mkdir(path.join(source, "Conversation_Todo"));
  await fs.writeFile(path.join(source, "Conversation_Todo", `${threadId}.md`), "case variant");
  const sourceReal = await fs.realpath(source);
  const originalReaddir = fs.readdir;
  try {
    fs.readdir = async (directory, ...args) => {
      const entries = await originalReaddir(directory, ...args);
      if (path.resolve(directory) === sourceReal) entries.push({ name: "conversation_todo" });
      return entries;
    };
    const result = await changeLocation(dataDir, project, {
      expectedRoot: await fs.realpath(source), targetPath: target,
    }, { platform: "win32" });
    assert.equal(result.code, "AMBIGUOUS_NOTE_LAYOUT");
  } finally { fs.readdir = originalReaddir; }
  assert.equal((await getSetupState(dataDir, project)).root, await fs.realpath(source));
});

test("Windows light rebind checks expectedRoot and current-root unavailability under the lock", async () => {
  const { project, dataDir, base } = await fixture("cn-location-rebind-");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  const sourceReal = await fs.realpath(source);
  await fs.rm(source, { recursive: true });
  const { service, running, request } = await startService({ project, dataDir });
  try {
    const stale = await request("/location", { action: "custom", customPath: target, expectedRoot: path.join(base, "stale") });
    assert.equal((await stale.json()).code, "LOCATION_CHANGED");
    const moved = await request("/location", { action: "custom", customPath: target, expectedRoot: sourceReal });
    assert.equal(moved.status, 200, JSON.stringify(await moved.json()));
    assert.equal((await getSetupState(dataDir, project)).root, await fs.realpath(target));
  } finally {
    await running.close();
    await service.close?.();
  }
});

test("Windows light rebind refuses another project's overlapping root", async () => {
  const { project, dataDir, base } = await fixture("cn-location-rebind-overlap-");
  const otherProject = path.join(base, "other-project");
  const source = path.join(base, "source");
  const otherRoot = path.join(base, "other-root");
  await Promise.all([fs.mkdir(otherProject), fs.mkdir(source), fs.mkdir(otherRoot)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  assert.equal((await setup(dataDir, otherProject, "custom", otherRoot, { platform: "win32" })).ok, true);
  const sourceReal = await fs.realpath(source);
  await fs.rm(source, { recursive: true });
  const started = await startService({ project, dataDir });
  const result = await started.request("/location", {
    action: "custom", customPath: otherRoot, expectedRoot: sourceReal,
  });
  assert.equal((await result.json()).code, "LOCATION_OCCUPIED");
  assert.equal((await getSetupState(dataDir, project)).root, sourceReal);
  await started.running.close();
  await started.service.close?.();
});

test("Windows light-rebind persistence failure keeps the old binding", async () => {
  const { project, dataDir, base } = await fixture("cn-location-rebind-write-");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  const sourceReal = await fs.realpath(source);
  await fs.rm(source, { recursive: true });
  const originalRename = fs.rename;
  try {
    fs.rename = async (from, to) => {
      if (String(to).endsWith("bindings.json")) throw Object.assign(new Error("injected binding failure"), { code: "EIO" });
      return originalRename(from, to);
    };
    const started = await startService({ project, dataDir });
    const result = await started.request("/location", {
      action: "custom", customPath: target, expectedRoot: sourceReal,
    });
    assert.equal((await result.json()).code, "STATE_WRITE_FAILED");
    await started.running.close();
    await started.service.close?.();
  } finally { fs.rename = originalRename; }
  assert.equal((await getSetupState(dataDir, project)).root, sourceReal);
});

test("a live Windows project write lock older than the stale threshold is never reclaimed", async () => {
  const { project, dataDir, base } = await fixture("cn-location-live-lock-");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  let enter;
  let finish;
  const entered = new Promise((resolve) => { enter = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  const active = withProjectWrite(dataDir, project, async () => {
    enter();
    await hold;
    return { ok: true };
  }, { platform: "win32" });
  await entered;
  const realProject = await fs.realpath(project);
  const lockFile = path.join(dataDir, "project-write-locks", `${createHash("sha256").update(pathKey(realProject, "win32")).digest("hex")}.lock`);
  const old = new Date(Date.now() - 15_000);
  await fs.utimes(lockFile, old, old);
  assert.equal((await createNote({ dataDir, projectPath: project, holder: "thread-writer", platform: "win32" }, lane, { content: "blocked" })).code, "LOCATION_BUSY");
  assert.equal((await changeLocation(dataDir, project, {
    expectedRoot: await fs.realpath(source), targetPath: target,
  }, { platform: "win32" })).code, "LOCATION_BUSY");
  assert.match(await fs.readFile(lockFile, "utf8"), new RegExp(`^${process.pid}\\n`));
  finish();
  await active;
  assert.equal(await fs.access(lockFile).then(() => true, () => false), false);
});

test("a pending Windows default root can move before its directory is created", async () => {
  const { project, dataDir, base } = await fixture("cn-location-empty-default-");
  const target = path.join(base, "empty-target");
  await fs.mkdir(target);
  const configured = await setup(dataDir, project, "default", undefined, { platform: "win32" });
  assert.equal(configured.ok, true);
  assert.equal(await fs.access(configured.root).then(() => true, () => false), false);
  const moved = await changeLocation(dataDir, project, {
    expectedRoot: configured.root, targetPath: target,
  }, { platform: "win32" });
  assert.deepEqual(moved, { ok: true, oldRoot: configured.root, root: await fs.realpath(target), copiedFiles: 0 });
  assert.equal(await fs.access(configured.root).then(() => true, () => false), false);
});

test("copy and binding failures preserve the old Windows binding and partial target", async () => {
  const { project, dataDir, base } = await fixture("cn-location-copy-failure-");
  const source = path.join(base, "source");
  const copyTarget = path.join(base, "copy-target");
  const bindTarget = path.join(base, "bind-target");
  await Promise.all([fs.mkdir(source), fs.mkdir(copyTarget), fs.mkdir(bindTarget)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  assert.equal((await createNote({ dataDir, projectPath: project, holder: threadId, platform: "win32" }, lane, { content: "preserve" })).ok, true);
  const sourceReal = await fs.realpath(source);
  const originalCopy = fs.copyFile;
  try {
    fs.copyFile = async () => { throw Object.assign(new Error("injected copy failure"), { code: "EIO" }); };
    const failed = await changeLocation(dataDir, project, { expectedRoot: sourceReal, targetPath: copyTarget }, { platform: "win32" });
    assert.equal(failed.code, "COPY_FAILED");
    assert.equal((await getSetupState(dataDir, project)).root, sourceReal);
  } finally { fs.copyFile = originalCopy; }
  const originalRename = fs.rename;
  try {
    fs.rename = async (from, to) => {
      if (String(to).endsWith("bindings.json")) throw Object.assign(new Error("injected binding failure"), { code: "EIO" });
      return originalRename(from, to);
    };
    const failed = await changeLocation(dataDir, project, { expectedRoot: sourceReal, targetPath: bindTarget }, { platform: "win32" });
    assert.equal(failed.code, "STATE_WRITE_FAILED");
    assert.equal((await getSetupState(dataDir, project)).root, sourceReal);
    assert.match(await fs.readFile(path.join(bindTarget, lane, `${threadId}.md`), "utf8"), /preserve/);
  } finally { fs.rename = originalRename; }
});

test("Windows carry writes use the project lock before planning carry", async () => {
  const { project, dataDir, base } = await fixture("cn-location-carry-lock-");
  const source = path.join(base, "source");
  await fs.mkdir(source);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  const started = await startService({ project, dataDir });
  let enter;
  let finish;
  const entered = new Promise((resolve) => { enter = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  const active = withProjectWrite(dataDir, project, async () => {
    enter();
    await hold;
    return { ok: true };
  }, { platform: "win32" });
  try {
    await entered;
    const response = await started.request("/carry", { choice: "none", lanes: [] });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).code, "LOCATION_BUSY");
    assert.equal(await fs.access(path.join(source, ".carry-over", `${threadId}.json`)).then(() => true, () => false), false);
  } finally {
    finish();
    await active;
    await started.running.close();
    await started.service.close?.();
  }
});

test("a default Windows notes folder created mid-move blocks the switch", async () => {
  const { project, dataDir, base } = await fixture("cn-location-default-race-");
  const source = path.join(project, "notes");
  const target = path.join(base, "target");
  await fs.mkdir(target);
  const configured = await setup(dataDir, project, "default", undefined, { platform: "win32" });
  assert.equal(configured.root, path.join(await fs.realpath(project), "notes"));
  const targetReal = await fs.realpath(target);
  const originalReaddir = fs.readdir;
  let targetReads = 0;
  try {
    fs.readdir = async (directory, ...args) => {
      const result = await originalReaddir(directory, ...args);
      if (path.resolve(directory) === targetReal && ++targetReads === 2) {
        await fs.mkdir(source);
        await fs.mkdir(path.join(source, lane));
        await fs.writeFile(path.join(source, lane, `${threadId}.md`), "external note");
      }
      return result;
    };
    const result = await changeLocation(dataDir, project, { expectedRoot: configured.root, targetPath: target }, { platform: "win32" });
    assert.equal(result.code, "SOURCE_CHANGED");
    assert.equal((await getSetupState(dataDir, project)).root, configured.root);
    assert.deepEqual(await fs.readdir(target), []);
  } finally { fs.readdir = originalReaddir; }
});

test("closing the HTTP client does not cancel an active Windows move", async () => {
  const { project, dataDir, base } = await fixture("cn-location-client-close-");
  const source = path.join(base, "source");
  const target = path.join(base, "target");
  await Promise.all([fs.mkdir(source), fs.mkdir(target)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  assert.equal((await createNote({ dataDir, projectPath: project, holder: threadId, platform: "win32" }, lane, { content: "copy continues" })).ok, true);
  const secret = "e".repeat(64);
  const service = new PanelService({
    dataDir,
    secret,
    platform: "win32",
    appserver: stubAppServer(project),
    threadContext: async (id) => ({ holder: id, projectPath: project, title: "Close test" }),
    preferredPort: 0,
    idleMs: 60_000,
    env: { ...process.env, CN_FORK_WATCH: "0" },
  });
  const running = await service.start();
  const originalCopy = fs.copyFile;
  let enter;
  let finish;
  const copying = new Promise((resolve) => { enter = resolve; });
  const hold = new Promise((resolve) => { finish = resolve; });
  try {
    fs.copyFile = async (...args) => {
      enter();
      await hold;
      return originalCopy(...args);
    };
    const controller = new AbortController();
    const response = fetch(`http://127.0.0.1:${running.port}/api/t/${threadId}/location/move`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-cn-token": panelToken(secret, threadId) },
      body: JSON.stringify({ expectedRoot: await fs.realpath(source), targetPath: target }),
      signal: controller.signal,
    });
    await copying;
    controller.abort();
    await assert.rejects(response);
    finish();
    let context;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const check = await fetch(`http://127.0.0.1:${running.port}/api/t/${threadId}/context`, {
        headers: { "x-cn-token": panelToken(secret, threadId) },
      });
      context = await check.json();
      if (context.setup.root === await fs.realpath(target) && context.locationChange?.active === false) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(context.setup.root, await fs.realpath(target));
    assert.equal(context.locationChange.active, false);
    assert.match(await fs.readFile(path.join(target, lane, `${threadId}.md`), "utf8"), /copy continues/);
  } finally {
    finish();
    fs.copyFile = originalCopy;
    await running.close();
  }
});

test("source edits and target verification mismatches prevent a Windows binding commit", async () => {
  const { project, dataDir, base } = await fixture("cn-location-source-change-");
  const source = path.join(base, "source");
  const verifyTarget = path.join(base, "verify-target");
  const changedTarget = path.join(base, "changed-target");
  await Promise.all([fs.mkdir(source), fs.mkdir(verifyTarget), fs.mkdir(changedTarget)]);
  assert.equal((await setup(dataDir, project, "custom", source, { platform: "win32" })).ok, true);
  assert.equal((await createNote({ dataDir, projectPath: project, holder: threadId, platform: "win32" }, lane, { content: "original" })).ok, true);
  const sourceReal = await fs.realpath(source);
  const sourceFile = path.join(source, lane, `${threadId}.md`);
  const sourceFileReal = await fs.realpath(sourceFile);
  const originalCopy = fs.copyFile;
  try {
    fs.copyFile = async (from, to, flags) => {
      await originalCopy(from, to, flags);
      await fs.writeFile(to, "corrupted destination");
    };
    assert.equal((await changeLocation(dataDir, project, { expectedRoot: sourceReal, targetPath: verifyTarget }, { platform: "win32" })).code, "COPY_VERIFY_FAILED");
  } finally { fs.copyFile = originalCopy; }
  try {
    fs.copyFile = async (from, to, flags) => {
      await originalCopy(from, to, flags);
      if (path.resolve(from) === sourceFileReal) await fs.writeFile(from, "changed outside the plugin");
    };
    assert.equal((await changeLocation(dataDir, project, { expectedRoot: sourceReal, targetPath: changedTarget }, { platform: "win32" })).code, "SOURCE_CHANGED");
  } finally { fs.copyFile = originalCopy; }
  assert.equal((await getSetupState(dataDir, project)).root, sourceReal);
});
