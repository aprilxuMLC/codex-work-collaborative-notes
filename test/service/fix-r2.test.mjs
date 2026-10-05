import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { setup, ensureRootForWrite, resolveRoot } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { acquireLock, readLane, releaseLock, writeLane } from "../../plugins/collaborative-notes/server/lib/lane-store.js";
import { createNote, createSourcedNote, editNote, readNotes } from "../../plugins/collaborative-notes/server/lib/notes-ops.js";
import { getItemKey, parseLaneBody, serializeLaneBody } from "../../plugins/collaborative-notes/server/lib/structured-item.js";
import { createPanelLauncher, runHook } from "../../plugins/collaborative-notes/server/hook.mjs";
import { createMcpServer } from "../../plugins/collaborative-notes/server/mcp.mjs";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";

const threadId = "thread-child";
const parentThreadId = "thread-parent";
const lane = "conversation_todo";
const lane2 = "deferred_work";

async function fixture(prefix = "cn-fix-r2-") {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(project);
  return { base, project, dataDir };
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function invoke(service, thread, route, { method = "GET", body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = route;
  request.headers = { "x-cn-token": panelToken(service.secret, thread) };
  const result = { status: 0, body: "" };
  const response = {
    writeHead(status) { result.status = status; },
    end(value = "") { result.body += value; },
  };
  await service.request(request, response);
  return { status: result.status, value: result.body ? JSON.parse(result.body) : null };
}

async function carryFixture(prefix = "cn-fix-r2-carry-") {
  const value = await fixture(prefix);
  const parentProject = path.join(value.base, "parent");
  await fs.mkdir(parentProject);
  await setup(value.dataDir, parentProject, "default");
  await setup(value.dataDir, value.project, "default");
  const projects = { [threadId]: value.project, [parentThreadId]: parentProject };
  const appserver = {
    async readThread(id) { return { id, forkedFromId: id === threadId ? parentThreadId : undefined }; },
    async listItems() { return { data: [] }; },
  };
  const context = async (id) => ({ projectPath: projects[id], title: id });
  return { ...value, parentProject, projects, appserver, context };
}

test("R2-1 empty, NaN, and zero-pid locks remain live during initialization", async () => {
  const value = await fixture();
  try {
    for (const [index, contents] of ["", "NaN\n", "0\n"].entries()) {
      const lockPath = path.join(value.base, `lock-${index}`);
      await fs.writeFile(lockPath, contents);
      const result = await acquireLock(lockPath, { waitMs: 20, retryMs: 1, staleOnlyIfHolderDead: true });
      if (result.ok) await releaseLock(lockPath, result.handle);
      else assert.equal(result.code, "LOCKED", contents);
    }
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R2-2 carry keeps borrowed lane locks until its outer cleanup", async () => {
  const value = await carryFixture();
  const lockChecks = [];
  try {
    await createNote({ dataDir: value.dataDir, projectPath: value.parentProject, holder: parentThreadId }, lane, { content: "parent one" });
    await createNote({ dataDir: value.dataDir, projectPath: value.parentProject, holder: parentThreadId }, lane2, { content: "parent two" });
    let service;
    service = new PanelService({
      dataDir: value.dataDir,
      secret: "a".repeat(64),
      appserver: value.appserver,
      threadContext: value.context,
      carryWriteLane: async (root, key, holder, body, options) => {
        if (key === lane2) lockChecks.push(await exists(path.join(root, lane, `${holder}.md.lock`)));
        return writeLane(root, key, holder, body, options);
      },
    });
    service.server = { address: () => ({ port: 4321 }) };
    const result = await invoke(service, threadId, `/api/t/${threadId}/carry`, {
      method: "POST", body: { choice: "some", lanes: [lane, lane2] },
    });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    assert.deepEqual(lockChecks, [true]);
    assert.equal(await exists(path.join(value.project, "notes", lane, `${threadId}.md.lock`)), false);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R2-3 overwrite reapplies its edit to the latest lane body", async () => {
  const value = await fixture();
  try {
    await setup(value.dataDir, value.project, "default");
    const context = { dataDir: value.dataDir, projectPath: value.project, holder: threadId };
    const first = await createNote(context, lane, { content: "A old" });
    const second = await createNote(context, lane, { content: "B old" });
    const current = await readLane(path.join(value.project, "notes"), lane, threadId);
    const lockPath = path.join(value.project, "notes", lane, `${threadId}.md.lock`);
    const lock = await acquireLock(lockPath);
    const pending = editNote(context, lane, first.itemKey, "A new", current.version, { overwrite: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const parsed = parseLaneBody(current.body);
    parsed.nodes.find((node) => node.type === "item" && getItemKey(node.item) === second.itemKey).item.comment = "B new";
    await fs.writeFile(path.join(value.project, "notes", lane, `${threadId}.md`), serializeLaneBody(parsed));
    await releaseLock(lockPath, lock.handle);
    const result = await pending;
    assert.equal(result.ok, true, JSON.stringify(result));
    const latest = await readNotes(context, lane);
    assert.deepEqual(latest.notes.map((note) => note.authored), ["A new", "B new"]);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R2-4 search editing reloads fresh content and refuses a disappeared note", async () => {
  const source = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  const begin = source.slice(source.indexOf("async function beginEdit"), source.indexOf("async function saveComposer"));
  assert.match(begin, /await loadLane\(laneKey\)/);
  assert.match(begin, /ITEM_UNRESOLVED/);
  assert.match(begin, /fresh|latest|laneData\.get\(laneKey\)/);
});

test("R2-5 overwrite status follows the boolean save outcome and preserves drafts on failure", async () => {
  const source = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  const composer = source.slice(source.indexOf("async function saveComposer"), source.indexOf("async function saveEdit"));
  const edit = source.slice(source.indexOf("async function saveEdit"), source.indexOf("async function deleteNote"));
  const conflict = source.slice(source.indexOf("async function resolveConflict"), source.indexOf("async function performSearch"));
  assert.match(composer, /const result\s*=\s*quoted\s*\?/);
  assert.match(composer, /return true/);
  assert.match(edit, /await api\(/);
  assert.match(edit, /return true/);
  assert.match(conflict, /pending\.operation\(\)/);
  assert.match(conflict, /if \(overwritten\)/);
  assert.match(conflict, /status\.overwritten/);
});

test("R2-6 partial carry persists the original decision and renders a continuation", async () => {
  const source = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  const carry = await fs.readFile(new URL("../../plugins/collaborative-notes/server/service.mjs", import.meta.url), "utf8");
  assert.match(source, /status === "partial"/);
  assert.match(source, /carry\.choice/);
  assert.match(source, /carry\.selectedLanes|carry\.lanes/);
  assert.match(carry, /writePartialCarryMarker/);
  assert.match(carry, /selectedLanes/);

  const value = await carryFixture("cn-fix-r2-partial-");
  try {
    await createNote({ dataDir: value.dataDir, projectPath: value.parentProject, holder: parentThreadId }, lane, { content: "parent one" });
    await createNote({ dataDir: value.dataDir, projectPath: value.parentProject, holder: parentThreadId }, lane2, { content: "parent two" });
    let failOnce = true;
    const service = new PanelService({
      dataDir: value.dataDir,
      secret: "a".repeat(64),
      appserver: value.appserver,
      threadContext: value.context,
      carryWriteLane: async (root, key, holder, body, options) => {
        if (key === lane2 && failOnce) { failOnce = false; return { ok: false, code: "STALE" }; }
        return writeLane(root, key, holder, body, options);
      },
    });
    service.server = { address: () => ({ port: 4321 }) };
    const result = await invoke(service, threadId, `/api/t/${threadId}/carry`, {
      method: "POST", body: { choice: "some", lanes: [lane, lane2] },
    });
    assert.equal(result.value.code, "CARRY_PARTIAL", JSON.stringify(result.value));
    const marker = JSON.parse(await fs.readFile(path.join(value.project, "notes", ".carry-over", `${threadId}.json`), "utf8"));
    assert.equal(marker.status, "partial");
    assert.equal(marker.choice, "some");
    assert.deepEqual(marker.selectedLanes, [lane, lane2]);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R2-7 prepared polling enters Attaching and restores ticks on failure", async () => {
  const source = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  const polling = source.slice(source.indexOf("function startSelectionPolling"), source.indexOf("function renderLaneTabs"));
  assert.match(polling, /binding\.prepared/);
  assert.match(polling, /selection\s*=\s*\{\s*targets:\s*\[\],\s*generation:\s*latest\.generation,\s*lastBinding:\s*binding\s*\}/);
  assert.match(polling, /selection\.targets/);
  assert.match(polling, /selectionFailure/);
});

test("R2-8 consumed turns are idempotent and pending prepared selections reconcile before a new turn", async () => {
  const value = await fixture();
  try {
    await setup(value.dataDir, value.project, "default");
    const context = { dataDir: value.dataDir, projectPath: value.project, holder: threadId };
    const first = await createNote(context, lane, { content: "first" });
    const second = await createNote(context, lane, { content: "second" });
    const turns = new Set();
    const service = new PanelService({
      dataDir: value.dataDir,
      secret: "b".repeat(64),
      threadContext: async () => ({ projectPath: value.project }),
      appserver: { async listTurns() { return { data: [...turns].map((id) => ({ id })) }; } },
    });
    await service.saveSelection(threadId, { targets: [{ lane, itemKey: first.itemKey }], generation: 1, lastBinding: null });
    const prepared = await service.consumeReference(threadId, "turn-one", "en");
    assert.equal(prepared.prepared, true);
    await service.saveSelection(threadId, { targets: [{ lane, itemKey: second.itemKey }], generation: 2, lastBinding: null });
    const replay = await service.consumeReference(threadId, "turn-one", "en");
    assert.equal(replay.text, prepared.text);
    assert.deepEqual((await service.loadSelection(threadId)).targets, [{ lane, itemKey: second.itemKey }]);

    await service.saveSelection(threadId, { targets: [{ lane, itemKey: first.itemKey }], generation: 3, lastBinding: null });
    const pending = await service.consumeReference(threadId, "turn-three", "en");
    assert.equal(pending.prepared, true);
    const reconciled = await service.consumeReference(threadId, "turn-four", "en");
    assert.equal(reconciled.count, 1);
    assert.match(reconciled.text, /first/);
    assert.equal((await service.loadSelection(threadId)).targets.length, 0);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R2-9 carry writes partial progress after each lane and retains it if finalization fails", async () => {
  const source = await fs.readFile(new URL("../../plugins/collaborative-notes/server/service.mjs", import.meta.url), "utf8");
  assert.match(source, /markerLanes\[entry\.lane\]\s*=\s*\{ outcome, committed: true/);
  assert.match(source, /writePartialCarryMarker\(/);
  assert.match(source, /carryMarker\(plan\.parentThreadId, markerLanes, "decided"/);
  assert.match(source, /finalMarker|decidedMarker|CARRY_PARTIAL/);
});

test("R2-10 retrying a pending default-root binding confirms it before reads", async () => {
  const value = await fixture();
  try {
    await setup(value.dataDir, value.project, "default");
    const root = path.join(value.project, "notes");
    await fs.mkdir(root);
    const statePath = path.join(value.dataDir, "bindings.json");
    const before = JSON.parse(await fs.readFile(statePath, "utf8"));
    const binding = before.bindings[await fs.realpath(value.project)];
    assert.equal(binding.confirmedAt, null);
    const ensured = await ensureRootForWrite(value.dataDir, value.project);
    assert.equal(ensured.ok, true);
    const after = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.equal(typeof after.bindings[await fs.realpath(value.project)].confirmedAt, "string");
    await fs.rm(root, { recursive: true, force: true });
    assert.equal((await resolveRoot(value.dataDir, value.project)).code, "CONFIGURED_ROOT_UNAVAILABLE");
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R2-13 an observed default root stays unavailable after it is removed", async () => {
  for (const platform of ["darwin", "win32"]) {
    const value = await fixture(`cn-fix-r2-root-${platform}-`);
    try {
      await setup(value.dataDir, value.project, "default", undefined, { platform });
      const root = path.join(await fs.realpath(value.project), "notes");
      await fs.mkdir(path.join(root, lane), { recursive: true });
      await fs.writeFile(path.join(root, lane, `${threadId}.md`), "hand-created\n");
      const context = { dataDir: value.dataDir, projectPath: value.project, holder: threadId, platform };
      assert.equal((await readNotes(context, lane)).ok, undefined);
      const statePath = path.join(value.dataDir, "bindings.json");
      const confirmed = JSON.parse(await fs.readFile(statePath, "utf8"));
      assert.equal(typeof confirmed.bindings[await fs.realpath(value.project)].confirmedAt, "string");

      await fs.rename(root, path.join(value.base, "moved-notes"));
      const existing = (await readNotes(context, lane));
      assert.equal(existing.code, "CONFIGURED_ROOT_UNAVAILABLE");
      assert.equal((await createNote(context, lane, { content: "must not recreate" })).code, "CONFIGURED_ROOT_UNAVAILABLE");
      assert.equal((await createSourcedNote(context, lane, {
        snapshot: "source", source: { threadId, itemId: "source-item" }, comment: "source",
      })).code, "CONFIGURED_ROOT_UNAVAILABLE");
      assert.equal((await editNote(context, lane, "item-key", "edited", "0")).code, "CONFIGURED_ROOT_UNAVAILABLE");
      assert.equal(await exists(root), false);

      const mcp = createMcpServer({
        platform,
        resolveDataDirectory: async () => value.dataDir,
        contextResolver: async () => ({ projectPath: value.project }),
      });
      const read = await mcp.callTool("notes-read", { lane }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
      assert.equal(JSON.parse(read.content[0].text).code, "NOTES_CONFIGURED_ROOT_UNAVAILABLE");
      const write = await mcp.callTool("notes-write", { lane, content: "must not recreate" }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
      assert.equal(JSON.parse(write.content[0].text).code, "NOTES_CONFIGURED_ROOT_UNAVAILABLE");
      assert.equal(await exists(root), false);
    } finally { await fs.rm(value.base, { recursive: true, force: true }); }
  }
});

test("R2-14 a never-created Windows default remains lazy until its first write", async () => {
  const value = await fixture("cn-fix-r2-root-win-lazy-");
  try {
    await setup(value.dataDir, value.project, "default", undefined, { platform: "win32" });
    const root = path.join(await fs.realpath(value.project), "notes");
    assert.equal(await exists(root), false);
    const created = await createNote({ dataDir: value.dataDir, projectPath: value.project, holder: threadId, platform: "win32" }, lane, { content: "first write" });
    assert.equal(created.ok, true);
    assert.equal(await exists(root), true);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R2-11 source re-entry preserves a resolved source when context lookup fails", async () => {
  const value = await fixture();
  try {
    await setup(value.dataDir, value.project, "default");
    const appserver = {
      async listItems() { return { data: [{ item: { type: "agentMessage", id: "source-1", text: "source text" } }] }; },
      async listTurns() { throw new Error("context unavailable"); },
    };
    const server = createMcpServer({
      appserver,
      resolveDataDirectory: async () => value.dataDir,
      contextResolver: async () => ({ projectPath: value.project }),
    });
    const noteResult = await server.callTool("notes-write", { lane, content: "plain" }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
    assert.equal(noteResult.isError, undefined);
    const { createSourcedNote } = await import("../../plugins/collaborative-notes/server/lib/notes-ops.js");
    const note = await createSourcedNote({ dataDir: value.dataDir, projectPath: value.project, holder: threadId }, lane, {
      snapshot: "source text", source: { threadId, itemId: "source-1" }, comment: "comment",
    });
    const result = await server.callTool("notes-source-reentry", { lane, itemKey: note.itemKey }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
    const parsed = JSON.parse(result.content[0].text);
    assert.equal(parsed.source, "resolved");
    assert.equal(parsed.match, "exact");
    assert.equal(parsed.contextUnavailable, true);
    assert.deepEqual(parsed.surroundingContext, []);
    assert.equal(parsed.sourceMessage.text, "source text");
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R2-12 launcher and callers fail safely when the opener emits error", async () => {
  const child = new EventEmitter();
  child.unref = () => { child.unrefCalled = true; };
  const launcher = createPanelLauncher({ spawn: () => child, opener: "stub" });
  const pending = launcher("http://127.0.0.1:1");
  child.emit("error", new Error("spawn failed"));
  assert.equal(await pending, false);
  assert.equal(child.unrefCalled, true);

  const opened = [];
  const server = createMcpServer({
    platform: "darwin", resolveDataDirectory: async () => "/tmp/notes-r2-launcher",
    contextResolver: async () => ({ projectPath: "/tmp" }),
    ensure: async () => ({ port: 4321, dataDir: "/tmp/notes-r2-launcher" }),
    secretReader: async () => "c".repeat(64),
    open: async () => false,
    desktop: async () => true,
  });
  const result = await server.callTool("notes-open-panel", {}, { threadId });
  assert.equal(result.isError, true);
  assert.deepEqual(opened, []);

  await assert.doesNotReject(runHook({ hook_event_name: "SessionStart", source: "startup", session_id: threadId }, {
    env: { CN_ASSUME_DESKTOP: "1", CN_OPENER: "stub", PLUGIN_DATA: "/tmp/notes-r2-launcher" },
    ensure: async () => ({ port: 4321, dataDir: "/tmp/notes-r2-launcher" }),
    secretReader: async () => "d".repeat(64),
    request: async () => ({ status: 200, value: { recent: false } }),
    open: async () => false,
  }));
});

test("plugin version is the same across the declared clients", async () => {
  const plugin = JSON.parse(await fs.readFile(new URL("../../plugins/collaborative-notes/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  const service = await fs.readFile(new URL("../../plugins/collaborative-notes/server/service.mjs", import.meta.url), "utf8");
  const mcp = await fs.readFile(new URL("../../plugins/collaborative-notes/server/mcp.mjs", import.meta.url), "utf8");
  const appserver = await fs.readFile(new URL("../../plugins/collaborative-notes/server/lib/appserver.js", import.meta.url), "utf8");
  const version = plugin.version.replaceAll(".", "\\.");
  assert.match(service, new RegExp(`PLUGIN_VERSION = "${version}"`));
  assert.match(mcp, new RegExp(`serverInfo: \\{ name: "collaborative-notes", version: "${version}" \\}`));
  assert.match(appserver, new RegExp(`clientInfo = \\{ name: "collaborative-notes", version: "${version}" \\}`));
});

test("panel deep link: Mac keeps codex://browser; Windows opens the thread with browserUrl", async () => {
  const { panelDeepLink } = await import("../../plugins/collaborative-notes/server/hook.mjs");
  const id = "0190aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
  const url = `http://127.0.0.1:4567/t/${id}?k=abc`;
  assert.equal(panelDeepLink(url, "darwin"), `codex://browser?url=${encodeURIComponent(url)}`);
  assert.equal(panelDeepLink(url, "win32"), `codex://threads/${id}?browserUrl=${encodeURIComponent(url)}`);
  const other = "http://127.0.0.1:4567/help";
  assert.equal(panelDeepLink(other, "win32"), `codex://browser?url=${encodeURIComponent(other)}`);
});
