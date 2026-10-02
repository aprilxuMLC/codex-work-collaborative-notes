import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { test } from "node:test";

import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";

const threadId = "thread-abcdefgh";

function makeTurn(index) {
  const turnId = `turn-${index}`;
  return {
    id: turnId,
    timestamp: `2026-10-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    items: [
      { item: { type: "userMessage", id: `u-${index}`, content: [{ type: "text", text: `request ${index}` }] }, turnId, threadId },
      { item: { type: "agentMessage", id: `a-${index}`, phase: "final_answer", text: `answer ${index}` }, turnId, threadId },
    ],
  };
}

function countedAppserver(initial = Array.from({ length: 25 }, (_value, index) => makeTurn(index + 1))) {
  let turns = initial;
  const calls = [];
  const appserver = {
    get turns() { return turns; },
    set turns(value) { turns = value; },
    calls,
    async listTurns(_threadId, options = {}) {
      calls.push(options);
      const limit = options.limit || 50;
      const offset = options.cursor ? Number(options.cursor) : 0;
      const ordered = options.sortDirection === "desc" ? [...turns].reverse() : turns;
      const data = ordered.slice(offset, offset + limit);
      return { data, ...(offset + limit < ordered.length ? { nextCursor: String(offset + limit) } : {}) };
    },
    async listItems() { return { data: turns.flatMap((turn) => turn.items) }; },
  };
  return appserver;
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

async function serviceFixture(appserver) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-s8-service-"));
  const projectPath = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(projectPath);
  const service = new PanelService({
    dataDir,
    secret: "a".repeat(64),
    appserver,
    threadContext: async (id) => ({ holder: id, projectPath, title: "S8" }),
  });
  service.server = { address: () => ({ port: 4321 }) };
  return { base, service };
}

test("S8 recent pages descending, caps at 20, and does not build the cache", async () => {
  const appserver = countedAppserver(Array.from({ length: 25 }, (_value, index) => makeTurn(index + 1)));
  const { base, service } = await serviceFixture(appserver);
  try {
    const response = await invoke(service, `/api/t/${threadId}/mirror/recent?limit=99&cursor=`);
    assert.equal(response.status, 200);
    assert.equal(response.json.turns.length, 20);
    assert.equal(response.json.turns[0].turnId, "turn-25");
    assert.equal(response.json.nextCursor, "20");
    assert.deepEqual(appserver.calls[0], { cursor: undefined, limit: 20, sortDirection: "desc", itemsView: "full" });
    assert.equal(service.mirrorCache.size, 0);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("S8 first search builds once; later search and turn use the cache and include full result turns", async () => {
  const appserver = countedAppserver();
  const { base, service } = await serviceFixture(appserver);
  try {
    const first = await invoke(service, `/api/t/${threadId}/mirror/search?q=${encodeURIComponent("answer 24")}`);
    assert.equal(first.status, 200);
    assert.equal(first.json.results[0].turn.turnId, "turn-24");
    const callsAfterFirst = appserver.calls.length;
    const second = await invoke(service, `/api/t/${threadId}/mirror/search?q=${encodeURIComponent("answer 23")}`);
    const turn = await invoke(service, `/api/t/${threadId}/mirror/turn?turnId=turn-23`);
    assert.equal(second.status, 200);
    assert.equal(turn.status, 200);
    assert.equal(appserver.calls.length, callsAfterFirst);
    assert.equal(turn.json.turnId, "turn-23");
    assert.equal((await invoke(service, `/api/t/${threadId}/mirror/turn?turnId=missing`)).status, 404);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("S8 panel removes the full outline and uses recent plus cache-backed turn/search routes", async () => {
  const app = await fs.readFile("plugins/collaborative-notes/server/panel/app.js", "utf8");
  const html = await fs.readFile("plugins/collaborative-notes/server/panel/index.html", "utf8");
  const i18n = await fs.readFile("plugins/collaborative-notes/server/panel/i18n.js", "utf8");
  assert.match(app, /\/mirror\/recent/);
  assert.match(app, /\/mirror\/turn\?turnId=/);
  assert.match(app, /\/mirror\/search\?q=/);
  assert.match(app, /300/);
  assert.doesNotMatch(app, /\/mirror\/outline/);
  assert.doesNotMatch(app, /mirror-show-more/);
  assert.doesNotMatch(app, /innerHTML/);
  assert.doesNotMatch(html, /mirror-load-earlier/);

  const sandbox = { globalThis: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(i18n, sandbox);
  const { zh, en } = sandbox.CollaborativeNotesI18n;
  assert.equal(zh["label.mirrorHint"], "找更早的内容？在下面搜索或粘贴一段文字——会搜索整个对话。");
  assert.equal(en["label.mirrorHint"], "Looking for something earlier? Search or paste a passage below — it searches the whole conversation.");
  assert.equal(zh["status.mirrorSearching"], "正在搜索整个对话…");
  assert.equal(en["status.mirrorSearching"], "Searching the whole conversation…");
});
