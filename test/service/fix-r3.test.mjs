import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { acquireLock, readLane, writeLane } from "../../plugins/collaborative-notes/server/lib/lane-store.js";
import { MirrorHistoryCache, searchMirrorTurns } from "../../plugins/collaborative-notes/server/lib/thread-mirror.js";
import { createNote, readNotes } from "../../plugins/collaborative-notes/server/lib/notes-ops.js";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";

const threadId = "thread-child";
const parentThreadId = "thread-parent";
const lane = "conversation_todo";
const lane2 = "deferred_work";

async function fixture(prefix = "cn-fix-r3-") {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(project);
  return { base, project, dataDir };
}

function invoke(service, thread, route, { method = "GET", body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = route;
  request.headers = { "x-cn-token": panelToken(service.secret, thread) };
  const result = { status: 0, body: "" };
  const response = {
    writeHead(status) { result.status = status; },
    end(value = "") { result.body += value; },
  };
  return service.request(request, response).then(() => ({ status: result.status, value: JSON.parse(result.body) }));
}

function appserverForTurns(turnsRef) {
  return {
    async listTurns(_threadId, options = {}) {
      const source = turnsRef.value;
      const limit = options.limit || 50;
      const offset = options.cursor ? Number(options.cursor) : 0;
      const ordered = options.sortDirection === "desc" ? [...source].reverse() : source;
      const data = ordered.slice(offset, offset + limit);
      return { data, ...(offset + limit < ordered.length ? { nextCursor: String(offset + limit) } : {}) };
    },
    async listItems() { return { data: [] }; },
  };
}

function mirrorTurn(index, answer = `answer ${index}`) {
  const turnId = `turn-${index}`;
  return {
    id: turnId,
    timestamp: `2026-10-01T00:${String(index).padStart(2, "0")}:00.000Z`,
    items: [
      { item: { type: "userMessage", id: `user-${index}`, content: [{ type: "text", text: `request ${index}` }] }, turnId },
      { item: { type: "agentMessage", id: `answer-${index}`, phase: "final_answer", text: answer }, turnId },
    ],
  };
}

function carryFixture(prefix = "cn-fix-r3-carry-") {
  return fixture(prefix).then(async (value) => {
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
  });
}

test("R3-01 two contenders cannot both acquire a stale lock", async () => {
  const value = await fixture("cn-fix-r3-lock-");
  const lockPath = path.join(value.base, "shared.lock");
  try {
    await fs.writeFile(lockPath, `${Number.MAX_SAFE_INTEGER}\n${Date.now() - 20_000}\n`);
    const results = await Promise.all([
      acquireLock(lockPath, { waitMs: 40, retryMs: 1, staleOnlyIfHolderDead: true }),
      acquireLock(lockPath, { waitMs: 40, retryMs: 1, staleOnlyIfHolderDead: true }),
    ]);
    const acquired = results.filter((result) => result.ok).length;
    for (const result of results) if (result.ok) await result.handle.close();
    assert.equal(acquired, 1);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R3-02 a rewound turn disappears from the history cache", async () => {
  let now = 1_000;
  const turnsRef = { value: [1, 2, 3, 4].map((index) => mirrorTurn(index)) };
  const cache = new MirrorHistoryCache(appserverForTurns(turnsRef), { now: () => now });
  await cache.get(threadId);
  turnsRef.value = [1, 2, 3].map((index) => mirrorTurn(index));
  now += 6_000;
  const refreshed = await cache.get(threadId);
  assert.equal(searchMirrorTurns(refreshed.turns, "answer 4").length, 0);
});

test("R3-02 capture verification rejects text that exists only in a stale cache", async () => {
  const value = await fixture("cn-fix-r3-capture-");
  const sourceItem = { item: { type: "agentMessage", id: "source-item", text: "stale source text" }, turnId: "source-turn" };
  try {
    await setup(value.dataDir, value.project, "default");
    const service = new PanelService({
      dataDir: value.dataDir,
      secret: "a".repeat(64),
      appserver: {
        async listTurns() { return { data: [{ id: "source-turn", items: [sourceItem] }] }; },
        async listItems() { return { data: [] }; },
      },
      threadContext: async () => ({ projectPath: value.project }),
    });
    service.server = { address: () => ({ port: 4321 }) };
    await service.mirrorCache.get(threadId);
    const result = await invoke(service, threadId, `/api/t/${threadId}/lanes/${lane}/sourced-notes`, {
      method: "POST",
      body: { snapshot: "stale source text", source: { threadId, itemId: "source-item" }, comment: "comment" },
    });
    assert.equal(result.status, 409);
    assert.equal(result.value.code, "NOTES_SOURCE_UNVERIFIED");
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R3-03 a prepared attachment is idempotent after a service restart", async () => {
  const value = await fixture("cn-fix-r3-selection-");
  try {
    await setup(value.dataDir, value.project, "default");
    const options = {
      dataDir: value.dataDir,
      secret: "b".repeat(64),
      appserver: { async listTurns() { return { data: [] }; } },
      threadContext: async () => ({ projectPath: value.project }),
    };
    const first = new PanelService(options);
    const note = await createNote({ dataDir: value.dataDir, projectPath: value.project, holder: threadId }, lane, { content: "selected" });
    await first.saveSelection(threadId, { targets: [{ lane, itemKey: note.itemKey }], generation: 1, lastBinding: null });
    const prepared = await first.consumeReference(threadId, "turn-restart", "en");
    assert.equal(prepared.prepared, true);

    const restarted = new PanelService(options);
    const replay = await restarted.consumeReference(threadId, "turn-restart", "en");
    assert.equal(replay.selected, true);
    assert.equal(replay.text, prepared.text);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R3-04 a failed second partial marker write is recoverable without duplicate lanes", async () => {
  const value = await carryFixture();
  try {
    await createNote({ dataDir: value.dataDir, projectPath: value.parentProject, holder: parentThreadId }, lane, { content: "parent one" });
    await createNote({ dataDir: value.dataDir, projectPath: value.parentProject, holder: parentThreadId }, lane2, { content: "parent two" });
    let markerWrites = 0;
    const service = new PanelService({
      dataDir: value.dataDir,
      secret: "c".repeat(64),
      appserver: value.appserver,
      threadContext: value.context,
      writePartialCarryMarker: async (...args) => {
        markerWrites += 1;
        if (markerWrites === 2) throw new Error("injected marker failure");
        const [file, parentId, lanes, choice, selectedLanes] = args;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify({ version: 2, parentThreadId: parentId, status: "partial", lanes, choice, selectedLanes })}\n`);
      },
    });
    service.server = { address: () => ({ port: 4321 }) };
    const body = { choice: "some", lanes: [lane, lane2] };
    const partial = await invoke(service, threadId, `/api/t/${threadId}/carry`, { method: "POST", body });
    assert.equal(partial.value.code, "CARRY_PARTIAL", JSON.stringify(partial.value));
    assert.equal(partial.value.markerFailed, true);
    const marker = JSON.parse(await fs.readFile(path.join(value.project, "notes", ".carry-over", `${threadId}.json`), "utf8"));
    // Write-ahead: lane one was written after its planned keys were recorded,
    // and the update marking it committed is the write that failed.
    assert.equal(marker.lanes[lane].outcome, "writing");
    assert.equal(marker.lanes[lane].plannedKeys.length, 1);
    assert.equal(marker.lanes[lane2], undefined);

    const completed = await invoke(service, threadId, `/api/t/${threadId}/carry`, { method: "POST", body });
    assert.equal(completed.status, 200, JSON.stringify(completed.value));
    for (const key of [lane, lane2]) {
      const notes = await readNotes({ dataDir: value.dataDir, projectPath: value.project, holder: threadId }, key);
      assert.equal(notes.notes.length, 1);
    }
    // The recovered lane reports what was planned, not the write-ahead state.
    assert.equal(completed.value.outcomes[lane].outcome, "copied");
    assert.equal(completed.value.outcomes[lane].carried, 1);
    assert.equal(completed.value.marker.lanes[lane].outcome, "copied");
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R3-05 a partial carry continues through conflict resolution", async () => {
  const panel = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  const renderCarry = panel.slice(panel.indexOf("function renderCarry"), panel.indexOf("async function decideCarry"));
  assert.ok(renderCarry.indexOf("carryConflict?.conflicts") < renderCarry.indexOf('if (carry?.status === "partial")'));
  const value = await carryFixture("cn-fix-r3-conflict-");
  try {
    await createNote({ dataDir: value.dataDir, projectPath: value.parentProject, holder: parentThreadId }, lane, { content: "parent one" });
    await createNote({ dataDir: value.dataDir, projectPath: value.parentProject, holder: parentThreadId }, lane2, { content: "parent two" });
    let failLane2 = true;
    const service = new PanelService({
      dataDir: value.dataDir,
      secret: "d".repeat(64),
      appserver: value.appserver,
      threadContext: value.context,
      carryWriteLane: async (root, key, holder, body, options) => {
        if (key === lane2 && failLane2) { failLane2 = false; return { ok: false, code: "STALE" }; }
        return writeLane(root, key, holder, body, options);
      },
    });
    service.server = { address: () => ({ port: 4321 }) };
    const body = { choice: "some", lanes: [lane, lane2] };
    const partial = await invoke(service, threadId, `/api/t/${threadId}/carry`, { method: "POST", body });
    assert.equal(partial.value.code, "CARRY_PARTIAL", JSON.stringify(partial.value));
    await createNote({ dataDir: value.dataDir, projectPath: value.project, holder: threadId }, lane2, { content: "current two" });

    const conflict = await invoke(service, threadId, `/api/t/${threadId}/carry`, { method: "POST", body });
    assert.equal(conflict.value.code, "CARRY_CONFLICT", JSON.stringify(conflict.value));
    assert.deepEqual(conflict.value.lanes, body.lanes);
    const resolved = await invoke(service, threadId, `/api/t/${threadId}/carry`, {
      method: "POST",
      body: { ...body, resolutions: { [lane2]: "merge" }, observations: conflict.value.observations },
    });
    assert.equal(resolved.status, 200, JSON.stringify(resolved.value));
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R3-06 recent turns include embedded items without building the cache", async () => {
  const panel = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  assert.match(panel, /rememberEmbeddedMirrorTurns/);
  assert.match(panel, /if \(!mirrorTurnData\.has\(turnId\)\)/);
  const value = await fixture("cn-fix-r3-recent-");
  const calls = [];
  try {
    const turns = [mirrorTurn(1)];
    const service = new PanelService({
      dataDir: value.dataDir,
      secret: "e".repeat(64),
      appserver: {
        async listTurns(_threadId, options) { calls.push(options); return { data: turns }; },
      },
      threadContext: async () => ({ projectPath: value.project }),
    });
    service.server = { address: () => ({ port: 4321 }) };
    const recent = await invoke(service, threadId, `/api/t/${threadId}/mirror/recent?limit=10`);
    assert.equal(recent.status, 200);
    assert.deepEqual(recent.value.turns[0].items.map((item) => item.id), ["user-1", "answer-1"]);
    assert.equal(calls.some((options) => options.sortDirection === "asc"), false);
    assert.equal(service.mirrorCache.size, 0);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("R3-01 recheck: many contenders on one stale lock leave exactly one holder", async () => {
  const { acquireLock } = await import("../../plugins/collaborative-notes/server/lib/lane-store.js");
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-lock-many-"));
  try {
    const lockPath = path.join(base, "lane.md.lock");
    for (let round = 0; round < 20; round += 1) {
      await fs.rm(lockPath, { force: true });
      // A dead holder: pid 999999 is not running; old timestamp.
      await fs.writeFile(lockPath, `999999\n${Date.now() - 600_000}\n`);
      const results = await Promise.all(Array.from({ length: 6 }, () => acquireLock(lockPath, { waitMs: 150, retryMs: 5, staleOnlyIfHolderDead: true })));
      const holders = results.filter((result) => result.ok);
      assert.equal(holders.length, 1, `round ${round}`);
      for (const holder of holders) await holder.handle.close();
    }
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("R3-04 recheck: keyless legacy content is not duplicated after a failed marker update", async () => {
  const value = await carryFixture("cn-fix-r3-legacy-");
  try {
    const { ensureRootForWrite } = await import("../../plugins/collaborative-notes/server/lib/binding.js");
    const parentRoot = (await ensureRootForWrite(value.dataDir, value.parentProject)).root;
    await fs.mkdir(path.join(parentRoot, lane), { recursive: true });
    const legacy = "legacy plain text without note blocks\n";
    const wrote = await writeLane(parentRoot, lane, parentThreadId, legacy, { expectedVersion: "0" });
    assert.equal(wrote.ok, true, JSON.stringify(wrote));
    let markerWrites = 0;
    const service = new PanelService({
      dataDir: value.dataDir,
      secret: "c".repeat(64),
      appserver: value.appserver,
      threadContext: value.context,
      writePartialCarryMarker: async (...args) => {
        markerWrites += 1;
        if (markerWrites === 2) throw new Error("injected marker failure");
        const [file, parentId, lanes, choice, selectedLanes] = args;
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, `${JSON.stringify({ version: 2, parentThreadId: parentId, status: "partial", lanes, choice, selectedLanes })}\n`);
      },
    });
    service.server = { address: () => ({ port: 4321 }) };
    const body = { choice: "some", lanes: [lane] };
    const partial = await invoke(service, threadId, `/api/t/${threadId}/carry`, { method: "POST", body });
    assert.equal(partial.value.code, "CARRY_PARTIAL", JSON.stringify(partial.value));
    const completed = await invoke(service, threadId, `/api/t/${threadId}/carry`, { method: "POST", body });
    assert.equal(completed.status, 200, JSON.stringify(completed.value));
    const child = await readLane(path.join(value.project, "notes"), lane, threadId);
    assert.equal(child.body.split("legacy plain text").length - 1, 1);
  } finally { await fs.rm(value.base, { recursive: true, force: true }); }
});

test("copies of attached note text are not kept beyond a day", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-ref-ttl-"));
  try {
    const dataDir = path.join(base, "data");
    await fs.mkdir(path.join(dataDir, "selections"), { recursive: true });
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const fresh = new Date().toISOString();
    await fs.writeFile(path.join(dataDir, "selections", `${threadId}.json`), JSON.stringify({
      targets: [], generation: 3,
      lastBinding: { ok: true, turnId: "turn-old", text: "old note text", at: old },
      consumed: { "turn-old": { text: "old note text", at: old }, "turn-new": { text: "new note text", at: fresh } },
    }));
    const service = new PanelService({ dataDir, secret: "c".repeat(64), threadContext: async () => ({ projectPath: base }) });
    const selection = await service.loadSelection(threadId);
    assert.deepEqual(Object.keys(selection.consumed), ["turn-new"]);
    assert.equal(selection.lastBinding.text, undefined);
    assert.equal(selection.lastBinding.turnId, "turn-old");
    // Expired copies are also removed from disk, not only skipped in memory.
    const onDisk = await fs.readFile(path.join(dataDir, "selections", `${threadId}.json`), "utf8");
    assert.doesNotMatch(onDisk, /old note text/);
    assert.match(onDisk, /new note text/);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
