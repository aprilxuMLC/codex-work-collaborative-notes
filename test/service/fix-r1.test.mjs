import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { writeLane, readLane } from "../../plugins/collaborative-notes/server/lib/lane-store.js";
import { createNote, editNote } from "../../plugins/collaborative-notes/server/lib/notes-ops.js";
import { resolveSourceItem } from "../../plugins/collaborative-notes/server/lib/thread-mirror.js";
import { createMcpServer } from "../../plugins/collaborative-notes/server/mcp.mjs";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";

const threadId = "thread-child";
const parentThreadId = "thread-parent";
const lane = "conversation_todo";

async function tempFixture(prefix = "cn-fix-r1-") {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(project);
  return { base, project, dataDir };
}

test("F1 search edit carries the search read version into beginEdit", async () => {
  const source = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  assert.match(source, /laneVersion:\s*data\.version/);
  assert.match(source, /version:\s*fresh\.version/);
});

test("F2 carry rejects an omitted or invalid choice instead of defaulting to all", async () => {
  const source = await fs.readFile(new URL("../../plugins/collaborative-notes/server/service.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /includes\(body\.choice\)[\s\S]{0,80}:\s*"all"/);
  assert.match(source, /choice\s*===\s*"some"/);
  assert.match(source, /choice\s*===\s*"all"/);
});

test("F3 carry detection does not materialize a pending default root", async () => {
  const fixture = await tempFixture();
  try {
    const service = new PanelService({
      dataDir: fixture.dataDir,
      secret: "a".repeat(64),
      threadContext: async () => ({ projectPath: fixture.project }),
      appserver: { async readThread() { return { id: threadId, forkedFromId: parentThreadId }; } },
    });
    await setup(fixture.dataDir, fixture.project, "default");
    await service.carryStatus(threadId, { projectPath: fixture.project });
    await assert.rejects(fs.stat(path.join(fixture.project, "notes")), { code: "ENOENT" });
  } finally {
    await fs.rm(fixture.base, { recursive: true, force: true });
  }
});

test("F4 concurrent setup keeps the first binding and rejects the second", async () => {
  const fixture = await tempFixture();
  const first = path.join(fixture.base, "first");
  const second = path.join(fixture.base, "second");
  try {
    await fs.mkdir(first);
    await fs.mkdir(second);
    const results = await Promise.all([
      setup(fixture.dataDir, fixture.project, "custom", first),
      setup(fixture.dataDir, fixture.project, "custom", second),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1);
    assert.equal(results.filter((result) => result.code === "ALREADY_INITIALIZED").length, 1);
  } finally {
    await fs.rm(fixture.base, { recursive: true, force: true });
  }
});

test("F5 oversized reference text keeps the selection", async () => {
  const fixture = await tempFixture();
  try {
    await setup(fixture.dataDir, fixture.project, "default");
    const service = new PanelService({
      dataDir: fixture.dataDir,
      secret: "b".repeat(64),
      threadContext: async () => ({ projectPath: fixture.project }),
      appserver: { async readThread() { return { id: threadId }; } },
    });
    const note = await createNote({ dataDir: fixture.dataDir, projectPath: fixture.project, holder: threadId }, lane, { content: "x".repeat(9000) });
    await service.saveSelection(threadId, { targets: [{ lane, itemKey: note.itemKey }], generation: 1, lastBinding: null });
    const result = await service.consumeReference(threadId, "turn-too-large", "en");
    assert.equal(result.ok, false);
    assert.equal(result.selected, true);
    assert.equal((await service.loadSelection(threadId)).targets.length, 1);
  } finally {
    await fs.rm(fixture.base, { recursive: true, force: true });
  }
});

test("F7 a live lane lock is not stolen because it is old", async () => {
  const fixture = await tempFixture();
  try {
    const root = fixture.base;
    const targetDir = path.join(root, lane);
    await fs.mkdir(targetDir);
    await fs.writeFile(path.join(targetDir, `${threadId}.md`), "base");
    const lockPath = path.join(targetDir, `${threadId}.md.lock`);
    await fs.writeFile(lockPath, `${process.pid}\n${Date.now() - 20_000}\n`);
    const current = await readLane(root, lane, threadId);
    const result = await writeLane(root, lane, threadId, "new", { expectedVersion: current.version });
    assert.equal(result.code, "LOCKED");
  } finally {
    await fs.rm(fixture.base, { recursive: true, force: true });
  }
});

test("F9 source re-entry dereferences the stored source without holder membership", async () => {
  const result = await resolveSourceItem({
    async listItems(id) {
      return id === parentThreadId ? { data: [{ item: { type: "agentMessage", id: "source-1", text: "source" } }] } : { data: [] };
    },
  }, threadId, parentThreadId, "source-1");
  assert.equal(result.ok, true);
});

test("F12 overwrite edit uses the overwrite path", async () => {
  const fixture = await tempFixture();
  try {
    await setup(fixture.dataDir, fixture.project, "default");
    const context = { dataDir: fixture.dataDir, projectPath: fixture.project, holder: threadId };
    const note = await createNote(context, lane, { content: "old" });
    const first = await editNote(context, lane, note.itemKey, "newer", note.version);
    const overwritten = await editNote(context, lane, note.itemKey, "draft", note.version, { overwrite: true });
    assert.equal(first.ok, true);
    assert.equal(overwritten.ok, true);
  } finally {
    await fs.rm(fixture.base, { recursive: true, force: true });
  }
});

test("F15 lane configuration requires panel authentication", async () => {
  const fixture = await tempFixture();
  try {
    const service = new PanelService({ dataDir: fixture.dataDir, secret: "c".repeat(64), threadContext: async () => ({ projectPath: fixture.project }), appserver: { close() {} } });
    service.server = { address: () => ({ port: 4321 }) };
    const request = { method: "GET", url: "/api/lane-config", headers: {} };
    const result = { status: 0 };
    await service.request(request, { writeHead(status) { result.status = status; }, end() {} });
    assert.equal(result.status, 403);
  } finally {
    await fs.rm(fixture.base, { recursive: true, force: true });
  }
});

test("F6 carry uses dead-holder locks and records partial progress", async () => {
  const service = await fs.readFile(new URL("../../plugins/collaborative-notes/server/service.mjs", import.meta.url), "utf8");
  assert.match(service, /staleOnlyIfHolderDead:\s*true/);
  assert.match(service, /CARRY_PARTIAL/);
  assert.match(service, /committed:\s*true/);
});

test("F6 partial carry records committed lanes and does not duplicate them on retry", async () => {
  const fixture = await tempFixture("cn-fix-r1-carry-");
  const parentProject = path.join(fixture.base, "parent");
  const lane2 = "deferred_work";
  try {
    await fs.mkdir(parentProject);
    await setup(fixture.dataDir, parentProject, "default");
    await setup(fixture.dataDir, fixture.project, "default");
    const projects = { [threadId]: fixture.project, [parentThreadId]: parentProject };
    const appserver = {
      async readThread(id) { return { id, forkedFromId: id === threadId ? parentThreadId : undefined }; },
      async listItems() { return { data: [] }; },
    };
    const parentContext = { dataDir: fixture.dataDir, projectPath: parentProject, holder: parentThreadId };
    await createNote(parentContext, lane, { content: "parent one" });
    await createNote(parentContext, lane2, { content: "parent two" });
    let failOnce = true;
    const service = new PanelService({
      dataDir: fixture.dataDir,
      secret: "e".repeat(64),
      appserver,
      threadContext: async (id) => ({ projectPath: projects[id] }),
      carryWriteLane: async (root, key, holder, body, options) => {
        if (key === lane2 && failOnce) { failOnce = false; return { ok: false, code: "STALE" }; }
        return writeLane(root, key, holder, body, options);
      },
    });
    service.server = { address: () => ({ port: 4321 }) };
    const invoke = async (body) => {
      const request = Readable.from([Buffer.from(JSON.stringify(body))]);
      request.method = "POST";
      request.url = `/api/t/${threadId}/carry`;
      request.headers = { "x-cn-token": (await import("../../plugins/collaborative-notes/server/lib/service-client.js")).panelToken(service.secret, threadId) };
      const result = { status: 0, body: "" };
      await service.request(request, { writeHead(status) { result.status = status; }, end(value = "") { result.body += value; } });
      return { status: result.status, value: JSON.parse(result.body) };
    };
    const body = { choice: "some", lanes: [lane, lane2] };
    const partial = await invoke(body);
    assert.equal(partial.value.code, "CARRY_PARTIAL", JSON.stringify(partial.value));
    const markerPath = path.join(fixture.project, "notes", ".carry-over", `${threadId}.json`);
    const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
    assert.equal(marker.lanes[lane].committed, true);
    const completed = await invoke(body);
    assert.equal(completed.status, 200);
    const notes = await import("../../plugins/collaborative-notes/server/lib/notes-ops.js").then(({ readNotes }) => readNotes({ dataDir: fixture.dataDir, projectPath: fixture.project, holder: threadId }, lane));
    assert.equal(notes.notes.length, 1);
  } finally {
    await fs.rm(fixture.base, { recursive: true, force: true });
  }
});

test("F10 adapter declaration names the supported and unprotected mutation paths", async () => {
  const declaration = await fs.readFile(new URL("../../docs/chatgpt-desktop-adapter.md", import.meta.url), "utf8");
  assert.match(declaration, /panel/);
  assert.match(declaration, /MCP/);
  assert.match(declaration, /Files tab/);
  assert.match(declaration, /behavioural/);
});

test("F11 delegated context-dependent capture is refused unless the user agrees to a source-less rewrite", async () => {
  const skill = await fs.readFile(new URL("../../plugins/collaborative-notes/skills/collab-notes/SKILL.md", import.meta.url), "utf8");
  assert.match(skill, /save conversation content as such/);
  assert.match(skill, /will have no source/);
});

test("F14 notes-open-panel opens only a desktop session and does not return the deeplink", async () => {
  const opened = [];
  const server = createMcpServer({
    platform: "darwin", resolveDataDirectory: async () => "/tmp/notes-open-panel-test",
    contextResolver: async () => ({ projectPath: "/tmp" }),
    ensure: async () => ({ port: 4321, dataDir: "/tmp/notes-open-panel-test" }),
    secretReader: async () => "d".repeat(64),
    open: (url) => { opened.push(url); return true; },
    desktop: async (id) => id === threadId,
  });
  const refused = await server.callTool("notes-open-panel", {}, { threadId: "01a00000-0000-7000-8000-000000000002" });
  assert.equal(refused.isError, true);
  assert.equal(opened.length, 0);
  const result = await server.callTool("notes-open-panel", {}, { threadId });
  const value = JSON.parse(result.content[0].text);
  assert.deepEqual(value, { opened: true });
  assert.equal(opened.length, 1);
  assert.doesNotMatch(result.content[0].text, /4321|codex:\/\/|token|[0-9a-f]{64}/i);
});

test("F15 sourced-note edits may be empty in the panel", async () => {
  const source = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  assert.match(source, /!editor\.sourced\s*&&\s*!editor\.content\.trim\(\)/);
});
