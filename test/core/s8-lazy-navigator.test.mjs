import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MirrorHistoryCache,
  compactNavigatorTurn,
  searchMirrorTurns,
} from "../../plugins/collaborative-notes/server/lib/thread-mirror.js";

function makeTurn(index, threadId = "thread-abcdefgh") {
  const turnId = `${threadId}-turn-${index}`;
  return {
    id: turnId,
    timestamp: `2026-10-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    items: [
      { item: { type: "userMessage", id: `${turnId}-user`, content: [{ type: "text", text: `request ${index}` }] }, turnId, threadId },
      { item: { type: "agentMessage", id: `${turnId}-answer`, text: `answer ${index}` }, turnId, threadId },
    ],
  };
}

function appserverWithTurns(turns) {
  return {
    async listTurns(threadId, options = {}) {
      const source = turns.get(threadId) || [];
      const limit = options.limit || 50;
      const descending = options.sortDirection === "desc";
      const offset = options.cursor ? Number(options.cursor) : 0;
      const ordered = descending ? [...source].reverse() : source;
      const page = ordered.slice(offset, offset + limit);
      return {
        data: page,
        ...(offset + limit < ordered.length ? { nextCursor: String(offset + limit) } : {}),
      };
    },
    async listItems(threadId) {
      return { data: (turns.get(threadId) || []).flatMap((turn) => turn.items) };
    },
  };
}

test("S8 compact recent turns use localizable heads and optional indexes", () => {
  const turn = {
    turnId: "turn-1",
    time: "2026-10-01T00:01:00.000Z",
    items: [
      { id: "u-1", role: "user", text: "first\nrequest" },
      { id: "a-1", role: "assistant", phase: "final_answer", text: "final answer" },
    ],
  };
  assert.deepEqual(compactNavigatorTurn(turn, { index: 4, noted: true }), {
    turnId: "turn-1",
    time: "2026-10-01T00:01:00.000Z",
    userHead: "first request",
    answerHead: "final answer",
    items: [
      { id: "u-1", role: "user", text: "first\nrequest" },
      { id: "a-1", role: "assistant", text: "final answer" },
    ],
    noted: true,
    index: 4,
  });
  assert.equal(compactNavigatorTurn(turn).index, undefined);
});

test("S8 cache builds ascending pages and searches with the cached compact turn", async () => {
  const threadId = "thread-abcdefgh";
  const turns = new Map([[threadId, Array.from({ length: 55 }, (_value, index) => makeTurn(index + 1))]]);
  const calls = [];
  const base = appserverWithTurns(turns);
  const appserver = {
    ...base,
    async listTurns(id, options) {
      calls.push(options);
      return base.listTurns(id, options);
    },
  };
  const cache = new MirrorHistoryCache(appserver, { now: () => 1000 });
  const entry = await cache.get(threadId);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => [call.sortDirection, call.limit]), [["asc", 50], ["asc", 50]]);
  assert.equal(entry.turns.length, 55);
  assert.equal(entry.turns[0].index, 1);
  assert.equal(entry.turns.at(-1).index, 55);

  const results = searchMirrorTurns(entry.turns, "REQUEST 54");
  assert.equal(results.length, 1);
  assert.equal(results[0].index, 54);
  assert.equal(results[0].turn.turnId, `${threadId}-turn-54`);
  assert.equal(results[0].turn.items[0].text, "request 54");
});

test("S8 cache shares concurrent first builds, tops up, and evicts by LRU and idle age", async () => {
  let now = 1000;
  const threads = new Map([
    ["thread-abcdefgh", [makeTurn(1)]],
    ["thread-bcdefghi", [makeTurn(1, "thread-bcdefghi")]],
    ["thread-cdefghij", [makeTurn(1, "thread-cdefghij")]],
    ["thread-defghijk", [makeTurn(1, "thread-defghijk")]],
  ]);
  const calls = [];
  const base = appserverWithTurns(threads);
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const appserver = {
    ...base,
    async listTurns(id, options) {
      calls.push({ id, options });
      if (calls.length === 1) await blocked;
      return base.listTurns(id, options);
    },
  };
  const cache = new MirrorHistoryCache(appserver, { now: () => now });
  const first = cache.get("thread-abcdefgh");
  const second = cache.get("thread-abcdefgh");
  release();
  await Promise.all([first, second]);
  assert.equal(calls.filter(({ id }) => id === "thread-abcdefgh").length, 1);

  threads.get("thread-abcdefgh").push(makeTurn(2));
  now += 6_000;
  const topped = await cache.get("thread-abcdefgh");
  assert.deepEqual(topped.turns.map((turn) => turn.turnId), ["thread-abcdefgh-turn-1", "thread-abcdefgh-turn-2"]);

  await cache.get("thread-bcdefghi");
  await cache.get("thread-cdefghij");
  await cache.get("thread-abcdefgh");
  await cache.get("thread-defghijk");
  assert.equal(cache.peek("thread-bcdefghi"), undefined);
  now += 600_001;
  cache.evict();
  assert.equal(cache.size, 0);
});

test("S8 cached source resolution falls back for an item newer than the cache", async () => {
  const threadId = "thread-abcdefgh";
  const turns = new Map([[threadId, [makeTurn(1)]]]);
  const cache = new MirrorHistoryCache(appserverWithTurns(turns), { now: () => 1000 });
  await cache.get(threadId);
  turns.get(threadId).push(makeTurn(2));
  const itemId = "thread-abcdefgh-turn-2-answer";
  const resolved = await cache.resolveSourceItem(threadId, threadId, itemId);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.item.id, itemId);
  const window = await cache.sourceTurns(threadId, itemId, 1, 1);
  assert.equal(window.ok, true);
  assert.deepEqual(window.turns.map((turn) => turn.turnId), ["thread-abcdefgh-turn-1", "thread-abcdefgh-turn-2"]);
});

test("settled turns include failed and interrupted ones and carry the app-server start time", async () => {
  const { normalizeTurns } = await import("../../plugins/collaborative-notes/server/lib/thread-mirror.js");
  const item = (id) => ({ type: "agentMessage", id, text: "seen", phase: "final_answer" });
  const turns = normalizeTurns({ data: [
    { id: "t1", status: "completed", startedAt: 1790000000, items: [item("a1")] },
    { id: "t2", status: "failed", startedAt: 1790000060, items: [item("a2")] },
    { id: "t3", status: "interrupted", items: [item("a3")] },
    { id: "t4", status: "inProgress", items: [item("a4")] },
  ] }, "thread-abcdefgh");
  assert.deepEqual(turns.map((turn) => [turn.turnId, turn.completed]), [["t1", true], ["t2", true], ["t3", true], ["t4", false]]);
  assert.equal(turns[0].time, new Date(1790000000 * 1000).toISOString());
});
