import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, it } from "node:test";

import {
  BEGIN_LINE,
  BODY_LINE,
  END_LINE,
  KIND_SOURCE_AWARE,
  KIND_SOURCE_INDEPENDENT,
  getItemKey,
  makeItem,
  parseLaneBody,
  serializeItem,
  serializeLaneBody,
  withItemKey,
} from "../../plugins/collaborative-notes/server/lib/structured-item.js";
import {
  LANE_KEYS,
  defaultLabels,
  resolveLanes,
  sanitizeLaneConfig,
} from "../../plugins/collaborative-notes/server/lib/lanes.js";
import { readLane, writeLane } from "../../plugins/collaborative-notes/server/lib/lane-store.js";
import {
  ensureRootForWrite,
  getSetupState,
  resolveRoot,
  setup,
} from "../../plugins/collaborative-notes/server/lib/binding.js";
import {
  createNote,
  createSourcedNote,
  deleteNote,
  editNote,
  readNotes,
} from "../../plugins/collaborative-notes/server/lib/notes-ops.js";

const session = "session-abcdefgh";
const holder = "thread-abcdefgh";
const lane = "conversation_todo";
const tempRoots = [];

async function tempDirectory(prefix = "collab-notes-") {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(directory);
  return directory;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const directory = tempRoots.pop();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

describe("structured-item", () => {
  it("round-trips code-point lengths, host, payload, and item keys", () => {
    const sourcePayload = { sessionId: session, messageId: "message-😀-1" };
    const item = withItemKey(makeItem({
      kind: KIND_SOURCE_AWARE,
      captureOrigin: session,
      snapshot: "引用：中文 😀\n第二行",
      comment: "评论",
      sourcePayload,
      host: "codex",
      unknownMeta: [{ raw: "dsh-meta future: retained" }],
    }), "ik-test");
    const body = `${serializeItem(item)}\n`;
    const parsed = parseLaneBody(body);
    assert.equal(serializeLaneBody(parsed), body);
    assert.equal(parsed.nodes[0].item.host, "codex");
    assert.deepEqual(parsed.nodes[0].item.sourcePayload, sourcePayload);
    assert.equal(getItemKey(parsed.nodes[0].item), "ik-test");
  });

  it("keeps malformed and legacy-mixed bodies opaque and byte-stable", () => {
    const fixture = [
      "legacy before",
      "",
      BEGIN_LINE,
      "dsh-meta kind: source-independent",
      "dsh-meta origin: session-abcdefgh",
      "dsh-meta body-length: 10",
      BODY_LINE,
      "DSH sample",
      END_LINE,
      "",
      "legacy after",
      "",
    ].join("\n");
    assert.equal(serializeLaneBody(parseLaneBody(fixture)), fixture);

    const invalidPayload = [
      BEGIN_LINE,
      "dsh-meta kind: source-aware",
      `dsh-meta origin: ${session}`,
      "dsh-meta snapshot-length: 1",
      "dsh-meta source-payload: {\"sessionId\":\"session-abcdefgh\",\"messageId\":\"m\",\"extra\":true}",
      BODY_LINE,
      "x",
      END_LINE,
    ].join("\n");
    const parsed = parseLaneBody(invalidPayload);
    assert.equal(parsed.nodes.length, 1);
    assert.equal(parsed.nodes[0].type, "legacy");
    assert.equal(serializeLaneBody(parsed), invalidPayload);
  });
});

describe("lanes", () => {
  it("resolves order, ids, locale labels, and DSH hints", () => {
    const lanes = resolveLanes({
      displayOrder: ["lesson_candidate", "unknown", "lesson_candidate"],
      laneOverrides: { lesson_candidate: { displayId: "X", label: " Lessons " } },
    }, "en");
    assert.deepEqual(lanes.map((item) => item.key), [
      "lesson_candidate", "conversation_todo", "deferred_work", "knowledge_candidate",
    ]);
    assert.equal(lanes[0].label, "X Lessons");
    assert.equal(lanes[0].descriptive, "Lessons");
    assert.equal(lanes[2].target, "a formal discussion/todo list (ask the user where)");
    assert.deepEqual(Object.keys(defaultLabels("zh")), LANE_KEYS);
  });

  it("rejects unsafe config text", () => {
    assert.equal(sanitizeLaneConfig({ laneOverrides: { conversation_todo: { label: "../bad" } } }).ok, false);
    assert.equal(sanitizeLaneConfig({ laneOverrides: { conversation_todo: { target: "/tmp" } } }).ok, false);
    assert.equal(sanitizeLaneConfig({ laneOverrides: { conversation_todo: { action: "x\n y" } } }).ok, false);
    assert.equal(sanitizeLaneConfig({ laneOverrides: { conversation_todo: { label: "  safe  " } } }).ok, true);
  });
});

describe("lane-store", () => {
  it("supports absent/create, stale, precondition, symlink refusal, and size limit", async () => {
    const root = await tempDirectory();
    let current = await readLane(root, lane, holder);
    assert.deepEqual(current, { status: "absent", version: "0", body: "" });
    const created = await writeLane(root, lane, holder, "one", { expectedVersion: "0" });
    assert.equal(created.ok, true);
    current = await readLane(root, lane, holder);
    assert.equal(current.body, "one");
    assert.equal((await writeLane(root, lane, holder, "two")).code, "PRECONDITION_REQUIRED");
    const stale = await writeLane(root, lane, holder, "two", { expectedVersion: "0" });
    assert.equal(stale.code, "STALE");
    assert.equal(stale.body, "one");
    assert.equal((await writeLane(root, lane, holder, "x".repeat(1024 * 1024 + 1), { overwrite: true })).code, "TOO_LARGE");

    await fs.symlink(path.join(root, "elsewhere"), path.join(root, "deferred_work"));
    assert.equal((await readLane(root, "deferred_work", holder)).code, "SYMLINK_REFUSED");
  });

  it("allows exactly one concurrent writer for the same version", async () => {
    const root = await tempDirectory();
    await writeLane(root, lane, holder, "base", { expectedVersion: "0" });
    const modulePath = fileURLToPath(new URL("../../plugins/collaborative-notes/server/lib/lane-store.js", import.meta.url));
    const childCode = `
      const { readLane, writeLane } = await import(${JSON.stringify(pathToFileUrl(modulePath))});
      const current = await readLane(process.env.TEST_ROOT, process.env.TEST_LANE, process.env.TEST_HOLDER);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const result = await writeLane(process.env.TEST_ROOT, process.env.TEST_LANE, process.env.TEST_HOLDER, process.env.TEST_BODY, { expectedVersion: current.version });
      process.stdout.write(JSON.stringify(result));
    `;
    const run = (body) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", childCode], {
        env: { ...process.env, TEST_ROOT: root, TEST_LANE: lane, TEST_HOLDER: holder, TEST_BODY: body },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.on("error", reject);
      child.on("close", (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error("child failed")));
    });
    const results = await Promise.all([run("left"), run("right")]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.code === "STALE").length, 1);
  });
});

function pathToFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

describe("binding", () => {
  it("implements setup, lazy default creation, fail-closed roots, adoption, and no rebind", async () => {
    const base = await tempDirectory();
    const project = path.join(base, "project");
    const dataDir = path.join(base, "data");
    await fs.mkdir(project);
    assert.equal((await resolveRoot(dataDir, project)).code, "SETUP_REQUIRED");
    const initialized = await setup(dataDir, project, "default");
    assert.equal(initialized.ok, true);
    assert.equal((await getSetupState(dataDir, project)).state, "INITIALIZED");
    assert.equal((await resolveRoot(dataDir, project)).pendingDefault, true);
    assert.equal((await ensureRootForWrite(dataDir, project)).ok, true);
    assert.equal((await resolveRoot(dataDir, project)).ok, true);
    await fs.rm(path.join(project, "notes"), { recursive: true });
    assert.equal((await resolveRoot(dataDir, project)).code, "CONFIGURED_ROOT_UNAVAILABLE");
    assert.equal((await setup(dataDir, project, "custom", base)).code, "ALREADY_INITIALIZED");

    const legacyProject = path.join(base, "legacy-project");
    const legacyData = path.join(base, "legacy-data");
    await fs.mkdir(path.join(legacyProject, "notes", lane), { recursive: true });
    await fs.writeFile(path.join(legacyProject, "notes", lane, `${session}.md`), "legacy");
    assert.equal((await setup(legacyData, legacyProject, "default")).code, "LEGACY_ADOPTION_REQUIRED");
    assert.equal((await setup(legacyData, legacyProject, "adopt")).ok, true);
  });

  it("validates custom locations and occupied locations", async () => {
    const base = await tempDirectory();
    const project = path.join(base, "project");
    const dataDir = path.join(base, "data");
    const custom = path.join(base, "custom");
    await fs.mkdir(project);
    assert.equal((await setup(dataDir, project, "custom", path.join(base, "missing"))).code, "LOCATION_INVALID");
    await fs.mkdir(custom);
    await fs.mkdir(path.join(custom, lane));
    await fs.writeFile(path.join(custom, lane, `${session}.md`), "occupied");
    assert.equal((await setup(dataDir, project, "custom", custom)).code, "LOCATION_OCCUPIED");
  });
});

describe("notes-ops", () => {
  it("creates, reads, edits, preserves source bytes, rejects ambiguity, and deletes", async () => {
    const base = await tempDirectory();
    const project = path.join(base, "project");
    const dataDir = path.join(base, "data");
    await fs.mkdir(project);
    assert.equal((await createNote({ dataDir, projectPath: project, holder }, lane, { content: "first" })).code, "SETUP_REQUIRED");
    await setup(dataDir, project, "default");
    const created = await createNote({ dataDir, projectPath: project, holder }, lane, { content: "first" });
    assert.equal(created.ok, true);
    const firstKey = created.note.itemKey;
    const firstVersion = created.version;
    const sourced = await createSourcedNote({ dataDir, projectPath: project, holder }, lane, {
      snapshot: "exact snapshot",
      source: { threadId: session, itemId: "message-1" },
      comment: "comment",
    });
    assert.equal(sourced.ok, true);
    const read = await readNotes({ dataDir, projectPath: project, holder }, lane);
    assert.equal(read.notes.length, 2);
    assert.equal(read.notes[1].source.threadId, session);
    const edited = await editNote({ dataDir, projectPath: project, holder }, lane, firstKey, "changed", read.version);
    assert.equal(edited.ok, true);
    const afterEdit = await readNotes({ dataDir, projectPath: project, holder }, lane);
    assert.equal(afterEdit.notes[0].authored, "changed");
    assert.equal(afterEdit.notes[1].sourceSnapshot, "exact snapshot");
    assert.equal((await editNote({ dataDir, projectPath: project, holder }, lane, "missing", "x", edited.version)).code, "ITEM_UNRESOLVED");
    assert.equal((await editNote({ dataDir, projectPath: project, holder }, lane, firstKey, "x", firstVersion)).code, "STALE");
    const deleted = await deleteNote({ dataDir, projectPath: project, holder }, lane, firstKey, edited.version);
    assert.equal(deleted.ok, true);
    const final = await readNotes({ dataDir, projectPath: project, holder }, lane);
    assert.equal(final.notes.length, 1);
    assert.equal(final.notes[0].sourceSnapshot, "exact snapshot");
  });
});
