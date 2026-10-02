import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";
import { setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { createSourcedNote } from "../../plugins/collaborative-notes/server/lib/notes-ops.js";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";

const threadId = "thread-abcdefgh";

function appFixture() {
  const makeTurn = (id, items, time) => ({ id, time, items: items.map((item) => ({ item, turnId: id, threadId })) });
  const turns = [
    makeTurn("turn-1", [
      { type: "userMessage", id: "u-1", content: [{ type: "text", text: "## My request:\nfirst request" }] },
      { type: "agentMessage", id: "a-1", text: "first answer" },
    ], "2026-10-01T00:01:00.000Z"),
    makeTurn("turn-2", [
      { type: "userMessage", id: "u-2", content: [{ type: "text", text: "second request" }] },
      { type: "agentMessage", id: "a-2c", phase: "commentary", text: "commentary" },
      { type: "agentMessage", id: "a-2f", phase: "final_answer", text: "Final answer" },
    ], "2026-10-01T00:02:00.000Z"),
    makeTurn("turn-3", [
      { type: "userMessage", id: "u-3", content: [{ type: "text", text: "third request" }] },
      { type: "agentMessage", id: "a-3", text: "last answer" },
    ], "2026-10-01T00:03:00.000Z"),
  ];
  return {
    async listTurns(_id, options = {}) {
      if (options.cursor === "page-2") return { data: options.sortDirection === "desc" ? [turns[0]] : [turns[2]] };
      const ordered = options.sortDirection === "desc" ? [...turns].reverse() : turns;
      return { data: ordered.slice(0, 2), nextCursor: "page-2" };
    },
    async listItems() { return { data: turns.flatMap((turn) => turn.items) }; },
  };
}

async function invoke(service, route) {
  const request = Readable.from([]);
  request.method = "GET";
  request.url = route;
  request.headers = { "x-cn-token": panelToken(service.secret, threadId) };
  const result = { status: 0, body: "" };
  const response = {
    writeHead(status) { result.status = status; },
    end(value = "") { result.body += value; },
  };
  await service.request(request, response);
  return { status: result.status, json: JSON.parse(result.body) };
}

test("S8 recent and cache-backed turn routes expose compact history and note markers", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-s7-service-"));
  try {
    const projectPath = path.join(base, "project");
    const dataDir = path.join(base, "data");
    await fs.mkdir(projectPath);
    await setup(dataDir, projectPath, "default");
    const service = new PanelService({
      dataDir,
      secret: "a".repeat(64),
      appserver: appFixture(),
      threadContext: async (id) => ({ holder: id, projectPath, title: "S7" }),
    });
    service.server = { address: () => ({ port: 4321 }) };
    const created = await createSourcedNote({ dataDir, projectPath, holder: threadId }, "conversation_todo", {
      snapshot: "Final answer", source: { threadId, itemId: "a-2f" }, comment: "marked",
    });
    assert.equal(created.ok, true);

    const recent = await invoke(service, `/api/t/${threadId}/mirror/recent?limit=10`);
    assert.equal(recent.status, 200);
    assert.deepEqual(recent.json.turns.map(({ turnId, userHead, answerHead, noted, index }) => ({ turnId, userHead, answerHead, noted, index })), [
      { turnId: "turn-3", userHead: "third request", answerHead: "last answer", noted: false, index: undefined },
      { turnId: "turn-2", userHead: "second request", answerHead: "Final answer", noted: true, index: undefined },
    ]);

    const turn = await invoke(service, `/api/t/${threadId}/mirror/turn?turnId=turn-2`);
    assert.equal(turn.status, 200);
    assert.deepEqual(turn.json, {
      turnId: "turn-2",
      items: [
        { id: "u-2", role: "user", text: "second request" },
        { id: "a-2c", role: "assistant", text: "commentary" },
        { id: "a-2f", role: "assistant", text: "Final answer" },
      ],
    });
    const missing = await invoke(service, `/api/t/${threadId}/mirror/turn?turnId=missing`);
    assert.equal(missing.status, 404);
    assert.equal(missing.json.code, "NOT_FOUND");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("S7 search accepts transcript whitespace and is validated and limited", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-s7-search-"));
  try {
    const projectPath = path.join(base, "project");
    const dataDir = path.join(base, "data");
    await fs.mkdir(projectPath);
    const service = new PanelService({
      dataDir,
      secret: "a".repeat(64),
      appserver: appFixture(),
      threadContext: async (id) => ({ holder: id, projectPath, title: "S7" }),
    });
    service.server = { address: () => ({ port: 4321 }) };

    const found = await invoke(service, `/api/t/${threadId}/mirror/search?q=${encodeURIComponent("final\nanswer")}`);
    assert.equal(found.status, 200);
    assert.deepEqual(found.json.results.map(({ turnId, index, itemId, role, matches }) => ({ turnId, index, itemId, role, matches })), [
      { turnId: "turn-2", index: 2, itemId: "a-2f", role: "assistant", matches: 1 },
    ]);
    assert.match(found.json.results[0].snippet, /Final answer/);

    const invalid = await invoke(service, `/api/t/${threadId}/mirror/search?q=`);
    assert.equal(invalid.status, 400);
    assert.equal(invalid.json.code, "INVALID_QUERY");
    const tooLong = await invoke(service, `/api/t/${threadId}/mirror/search?q=${"x".repeat(2001)}`);
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.json.code, "INVALID_QUERY");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("S8 panel wires recent paging, cache-backed navigator endpoints, and literal highlights safely", async () => {
  const app = await fs.readFile("plugins/collaborative-notes/server/panel/app.js", "utf8");
  const html = await fs.readFile("plugins/collaborative-notes/server/panel/index.html", "utf8");
  assert.match(app, /\/mirror\/recent/);
  assert.match(app, /\/mirror\/turn\?turnId=/);
  assert.match(app, /\/mirror\/search\?q=/);
  assert.match(app, /highlightLiteral/);
  assert.match(app, /300/);
  assert.match(app, /20/);
  assert.doesNotMatch(app, /\/mirror\/outline/);
  assert.doesNotMatch(app, /mirror-show-more/);
  assert.doesNotMatch(app, /innerHTML/);
  assert.doesNotMatch(html, /mirror-load-earlier/);
});
