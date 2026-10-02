import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";
import { setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { createMcpServer } from "../../plugins/collaborative-notes/server/mcp.mjs";
import { createSourcedNote } from "../../plugins/collaborative-notes/server/lib/notes-ops.js";

const threadId = "thread-abcdefgh";

function appFixture(project) {
  const user = { type: "userMessage", id: "user-1", content: [{ type: "text", text: "## My request:\ncontinue" }] };
  const agent = { type: "agentMessage", id: "msg-1", text: "one **source** 🙂\none source" };
  const hidden = { type: "reasoning", id: "reason-1", text: "secret" };
  const execution = { type: "commandExecution", id: "command-1", command: "echo secret" };
  const records = [
    ...[user, agent, hidden, execution].map((item) => ({ item, turnId: "turn-1", threadId })),
  ];
  return {
    async readThread(id) { return { id, cwd: project, name: "Fixture thread" }; },
    async listItems() { return { data: records }; },
    async listTurns() { return { data: [{ id: "turn-1", items: records }] }; },
  };
}

async function invoke(service, thread, route, { method = "GET", body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = route;
  request.headers = { "x-cn-token": panelToken(service.secret, thread) };
  const result = { status: 0, body: "" };
  const response = { writeHead(status) { result.status = status; }, end(value = "") { result.body += value; } };
  await service.request(request, response);
  return { status: result.status, json: JSON.parse(result.body) };
}

test("Phase 3 mirror filters host items and sourced capture verifies visible text", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-phase3-service-"));
  try {
    const project = path.join(base, "project");
    const dataDir = path.join(base, "data");
    await fs.mkdir(project);
    const appserver = appFixture(project);
    const service = new PanelService({ dataDir, secret: "a".repeat(64), appserver, threadContext: async (id) => ({ holder: id, projectPath: project, title: "Fixture thread" }) });
    service.server = { address: () => ({ port: 4321 }) };
    await setup(dataDir, project, "default");
    const mirror = await invoke(service, threadId, `/api/t/${threadId}/mirror?limit=5`);
    assert.deepEqual(mirror.json.turns[0].items.map((item) => item.id), ["user-1", "msg-1"]);
    const created = await invoke(service, threadId, `/api/t/${threadId}/lanes/conversation_todo/sourced-notes`, {
      method: "POST", body: { snapshot: "source 🙂", source: { threadId, itemId: "msg-1" }, comment: "" },
    });
    assert.equal(created.status, 200);
    const rejected = await invoke(service, threadId, `/api/t/${threadId}/lanes/conversation_todo/sourced-notes`, {
      method: "POST", body: { snapshot: "not in source", source: { threadId, itemId: "msg-1" }, comment: "" },
    });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.json.code, "NOTES_SOURCE_UNVERIFIED");
    const note = (await invoke(service, threadId, `/api/t/${threadId}/lanes/conversation_todo`)).json.notes[0];
    const source = await invoke(service, threadId, `/api/t/${threadId}/source?lane=conversation_todo&itemKey=${note.itemKey}&before=1&after=1`);
    assert.equal(source.status, 200);
    assert.equal(source.json.targetItemId, "msg-1");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("Phase 3 MCP re-entry reports exact and not-located source states", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-phase3-mcp-"));
  try {
    const project = path.join(base, "project");
    const dataDir = path.join(base, "data");
    await fs.mkdir(project);
    await setup(dataDir, project, "default");
    const appserver = appFixture(project);
    const server = createMcpServer({ appserver, resolveDataDirectory: async () => dataDir, contextResolver: async () => ({ projectPath: project }) });
    await server.callTool("notes-write", { lane: "conversation_todo", content: "plain" }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
    const read = await server.callTool("notes-read", { lane: "conversation_todo" }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
    const plain = JSON.parse(read.content[0].text).notes[0];
    const plainResult = await server.callTool("notes-source-reentry", { lane: "conversation_todo", itemKey: plain.itemKey }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
    const plainValue = JSON.parse(plainResult.content[0].text);
    assert.equal(plainValue.status, "unavailable");
    assert.deepEqual({ source: plainValue.source, match: plainValue.match }, { source: "unavailable", match: "not-located" });
    const sourced = await createSourcedNote({ dataDir, projectPath: project, holder: threadId }, "conversation_todo", {
      snapshot: "source", source: { threadId, itemId: "msg-1" }, comment: "comment",
    });
    const sourcedResult = await server.callTool("notes-source-reentry", { lane: "conversation_todo", itemKey: sourced.itemKey }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
    const sourcedValue = JSON.parse(sourcedResult.content[0].text);
    assert.deepEqual({ source: sourcedValue.source, match: sourcedValue.match }, { source: "resolved", match: "exact" });
    // Another conversation reads this conversation's sourced note and its
    // source, read-only (the user named the conversation).
    const otherThread = "01a00000-0000-7000-8000-000000000002";
    const cross = await server.callTool("notes-source-reentry", { lane: "conversation_todo", itemKey: sourced.itemKey, thread: threadId, contextWindow: 20 }, { threadId: otherThread, plugin_id: "collaborative-notes@collaborative-notes" });
    const crossValue = JSON.parse(cross.content[0].text);
    assert.deepEqual({ source: crossValue.source, match: crossValue.match, crossThread: crossValue.crossThread, readOnly: crossValue.readOnly }, { source: "resolved", match: "exact", crossThread: true, readOnly: true });
    assert.equal(crossValue.sourceMessage.itemId, "msg-1");
    const tooWide = await server.callTool("notes-source-reentry", { lane: "conversation_todo", itemKey: sourced.itemKey, contextWindow: 31 }, { threadId, plugin_id: "collaborative-notes@collaborative-notes" });
    assert.equal(tooWide.isError, true);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
