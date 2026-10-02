import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { runHook } from "../../plugins/collaborative-notes/server/hook.mjs";
import { setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { createNote, deleteNote, readNotes } from "../../plugins/collaborative-notes/server/lib/notes-ops.js";
import { panelToken, ensureService } from "../../plugins/collaborative-notes/server/lib/service-client.js";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";

const threadId = "thread-child";
const parentThreadId = "thread-parent";
const laneKeys = ["conversation_todo", "deferred_work", "knowledge_candidate", "lesson_candidate"];
const temporary = [];

afterEach(async () => {
  while (temporary.length) await fs.rm(temporary.pop(), { recursive: true, force: true });
});

async function invoke(service, route, {
  method = "GET",
  headers = {},
  body,
} = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  request.method = method;
  request.url = route;
  request.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const result = { status: 0, headers: {}, body: "" };
  const response = {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders || {}; },
    end(value = "") { result.body += value; },
  };
  await service.request(request, response);
  return {
    ...result,
    json: () => JSON.parse(result.body),
  };
}

async function selectionFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-phase4-selection-"));
  temporary.push(base);
  const projectPath = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(projectPath);
  await setup(dataDir, projectPath, "default");
  const context = async (id) => ({ holder: id, projectPath, dataDir, title: "Selection fixture" });
  const appserver = { async readThread(id) { return { id, cwd: projectPath, name: "Selection fixture" }; } };
  const service = new PanelService({ dataDir, secret: "a".repeat(64), appserver, threadContext: context });
  service.server = { address: () => ({ port: 4321 }), listen() {} };
  const token = panelToken(service.secret, threadId);
  const request = (route, options = {}) => invoke(service, route, {
    ...options,
    headers: { "x-cn-token": token, ...(options.headers || {}) },
  });
  return { base, projectPath, dataDir, service, request, token, context };
}

async function carryFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-phase4-carry-"));
  temporary.push(base);
  const parentProject = path.join(base, "parent-project");
  const childProject = path.join(base, "child-project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(parentProject);
  await fs.mkdir(childProject);
  await setup(dataDir, parentProject, "default");
  await setup(dataDir, childProject, "default");

  const projects = { [parentThreadId]: parentProject, [threadId]: childProject };
  const calls = [];
  const pages = {
    [parentThreadId]: [
      { data: [{ id: "parent-before-cut" }], nextCursor: "parent-page-2" },
      { data: [{ id: "parent-after-cut" }] },
    ],
    [threadId]: [
      { data: [{ id: "parent-before-cut" }], nextCursor: "child-page-2" },
      { data: [{ id: "child-after-cut" }] },
    ],
  };
  const appserver = {
    async readThread(id) {
      return id === threadId
        ? { id, cwd: childProject, name: "Child", forkedFromId: parentThreadId }
        : { id, cwd: parentProject, name: "Parent" };
    },
    async listItems(id, options = {}) {
      calls.push({ id, options });
      return pages[id][options.cursor ? 1 : 0];
    },
  };
  const threadContext = async (id) => ({ holder: id, projectPath: projects[id], title: id });
  const service = new PanelService({ dataDir, secret: "b".repeat(64), appserver, threadContext });
  service.server = { address: () => ({ port: 4321 }), listen() {} };
  const token = panelToken(service.secret, threadId);
  const request = (route, options = {}) => invoke(service, route, {
    ...options,
    headers: { "x-cn-token": token, ...(options.headers || {}) },
  });
  return { base, parentProject, childProject, dataDir, appserver, service, request, calls, projects };
}

async function add(projectPath, dataDir, holder, lane, content) {
  return createNote({ dataDir, projectPath, holder }, lane, { content });
}

test("Phase 4 token query sets a cookie and redirects without the token; cookie authenticates the API and missing token is 403", async () => {
  const { service, token } = await selectionFixture();
  const redirect = await invoke(service, `/t/${threadId}?k=${token}`);
  assert.equal(redirect.status, 303);
  assert.equal(redirect.headers.location, `/t/${threadId}`);
  assert.doesNotMatch(redirect.headers.location, /k=/);
  const cookie = redirect.headers["set-cookie"]?.[0];
  assert.match(cookie, new RegExp(`^cn_t_${threadId}=`));
  // Persistent, so a tab restored after an app restart still authenticates.
  assert.match(cookie, /Max-Age=\d+/);

  const panel = await invoke(service, `/t/${threadId}`, { headers: { cookie } });
  assert.equal(panel.status, 200);
  const api = await invoke(service, `/api/t/${threadId}/context`, { headers: { cookie } });
  assert.equal(api.status, 200);
  const missing = await invoke(service, `/t/${threadId}`);
  assert.equal(missing.status, 403);
  assert.match(missing.body, /Reopen Notes from Codex/);
});

test("Phase 4 selection generation rejects stale writes; consume success renders reference text without item keys and clears selection, while failure keeps it", async () => {
  const { service, request, dataDir, projectPath, context } = await selectionFixture();
  const note = await add(projectPath, dataDir, threadId, "conversation_todo", "selected note");
  let response = await request(`/api/t/${threadId}/selection`, {
    method: "PUT",
    body: { targets: [{ lane: "conversation_todo", itemKey: note.itemKey }], generation: 1 },
  });
  assert.equal(response.status, 200);
  response = await request(`/api/t/${threadId}/selection`, {
    method: "PUT",
    body: { targets: [], generation: 1 },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json().stale, true);

  response = await invoke(service, "/internal/reference/consume", {
    method: "POST",
    headers: { Authorization: `Bearer ${service.secret}` },
    body: { threadId, turnId: "turn-send-1", locale: "en-US" },
  });
  assert.equal(response.status, 200);
  const consumed = response.json();
  assert.equal(consumed.ok, true);
  assert.equal(consumed.count, 1);
  assert.match(consumed.text, /Referenced Notes \(1\)/);
  assert.match(consumed.text, /Note content: selected note/);
  assert.doesNotMatch(consumed.text, new RegExp(note.itemKey));
  assert.equal((await request(`/api/t/${threadId}/selection`)).json().targets.length, 0);
  assert.equal((await request(`/api/t/${threadId}/selection`)).json().lastBinding.turnId, "turn-send-1");

  const read = await readNotes(await context(threadId), "conversation_todo");
  const deleted = await deleteNote(await context(threadId), "conversation_todo", note.itemKey, read.version);
  assert.equal(deleted.ok, true, JSON.stringify(deleted));
  response = await request(`/api/t/${threadId}/selection`, {
    method: "PUT",
    body: { targets: [{ lane: "conversation_todo", itemKey: note.itemKey }], generation: 2 },
  });
  assert.equal(response.status, 200);
  response = await invoke(service, "/internal/reference/consume", {
    method: "POST",
    headers: { Authorization: `Bearer ${service.secret}` },
    body: { threadId, turnId: "turn-send-2", locale: "en-US" },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json().selected, true);
  const afterFailure = (await request(`/api/t/${threadId}/selection`)).json();
  assert.deepEqual(afterFailure.targets, [{ lane: "conversation_todo", itemKey: note.itemKey }]);
});

test("Phase 4 hook prints additionalContext on consume success, blocks on failure, and prints nothing with no selection", async () => {
  const outputs = [];
  const common = (value) => ({
    env: { PLUGIN_DATA: "/tmp/collaborative-notes-phase4-hook", LANG: "en-US" },
    ensure: async () => ({ port: 4321, instanceId: "instance", dataDir: "/tmp/collaborative-notes-phase4-hook" }),
    secretReader: async () => "c".repeat(64),
    request: async (_info, route) => route === "/internal/reference/consume"
      ? value
      : { status: 200 },
    output: { write(text) { outputs.push(text); } },
  });

  await runHook({ hook_event_name: "UserPromptSubmit", session_id: threadId, turn_id: "turn-1" }, common({
    status: 200,
    value: { ok: true, selected: true, count: 1, text: "Referenced Notes (1)\nNote content: selected" },
  }));
  assert.deepEqual(JSON.parse(outputs.pop()), {
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "Referenced Notes (1)\nNote content: selected" },
  });

  await runHook({ hook_event_name: "UserPromptSubmit", session_id: threadId, turn_id: "turn-2" }, common({
    status: 409,
    value: { ok: false, selected: true, reason: "selection kept" },
  }));
  assert.deepEqual(JSON.parse(outputs.pop()), { decision: "block", reason: "selection kept" });

  const count = outputs.length;
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: threadId, turn_id: "turn-3" }, common({
    status: 200,
    value: { ok: true, selected: false },
  }));
  assert.equal(outputs.length, count);
});

test("Phase 4 carry handler detects pending state, copies empty lanes, reports conflicts, re-asks after a version change, and applies merge/keep/replace with a marker", async () => {
  const { service, request, dataDir, parentProject, childProject, calls } = await carryFixture();
  const parentValues = {};
  for (const [index, lane] of laneKeys.entries()) {
    parentValues[lane] = await add(parentProject, dataDir, parentThreadId, lane, `parent-${index}`);
  }
  for (const lane of laneKeys.slice(0, 3)) {
    await add(childProject, dataDir, threadId, lane, `current-${lane}`);
  }

  let response = await request(`/api/t/${threadId}/carry`);
  assert.equal(response.status, 200);
  assert.equal(response.json().carry.status, "unresolved");
  assert.equal(response.json().carry.parentThreadId, parentThreadId);

  response = await request(`/api/t/${threadId}/carry`, { method: "POST", body: { choice: "all" } });
  assert.equal(response.status, 409);
  const conflict = response.json();
  assert.equal(conflict.code, "CARRY_CONFLICT");
  assert.deepEqual(conflict.conflicts.map((entry) => entry.lane), laneKeys.slice(0, 3));
  assert.ok(calls.some(({ id, options }) => id === threadId && options.cursor === "child-page-2"));
  assert.ok(calls.some(({ id, options }) => id === parentThreadId && options.cursor === "parent-page-2"));

  await add(childProject, dataDir, threadId, laneKeys[0], "changed while deciding");
  response = await request(`/api/t/${threadId}/carry`, {
    method: "POST",
    body: {
      choice: "all",
      resolutions: {
        [laneKeys[0]]: "merge",
        [laneKeys[1]]: "keep",
        [laneKeys[2]]: "replace",
      },
      observations: conflict.observations,
    },
  });
  assert.equal(response.status, 409);
  assert.equal(response.json().code, "CARRY_STALE");

  response = await request(`/api/t/${threadId}/carry`, {
    method: "POST",
    body: {
      choice: "all",
      resolutions: {
        [laneKeys[0]]: "merge",
        [laneKeys[1]]: "keep",
        [laneKeys[2]]: "replace",
      },
    },
  });
  assert.equal(response.status, 200);
  const result = response.json();
  assert.deepEqual(Object.fromEntries(laneKeys.map((lane) => [lane, result.outcomes[lane].outcome])), {
    [laneKeys[0]]: "merged",
    [laneKeys[1]]: "kept",
    [laneKeys[2]]: "replaced",
    [laneKeys[3]]: "copied",
  });
  assert.equal(result.marker.status, "decided");
  assert.ok(result.marker.decidedAt);
  assert.equal(result.marker.lanes[laneKeys[0]].carriedKeys.length, 1);
  assert.equal(result.marker.lanes[laneKeys[3]].carriedKeys.length, 1);
  assert.notEqual(result.marker.lanes[laneKeys[0]].carriedKeys[0], parentValues[laneKeys[0]].itemKey);
  assert.notEqual(result.marker.lanes[laneKeys[3]].carriedKeys[0], parentValues[laneKeys[3]].itemKey);

  const merged = await readNotes({ dataDir, projectPath: childProject, holder: threadId }, laneKeys[0]);
  assert.deepEqual(merged.notes.map((entry) => entry.authored), ["parent-0", "current-" + laneKeys[0], "changed while deciding"]);
  const kept = await readNotes({ dataDir, projectPath: childProject, holder: threadId }, laneKeys[1]);
  assert.deepEqual(kept.notes.map((entry) => entry.authored), ["current-" + laneKeys[1]]);
  const replaced = await readNotes({ dataDir, projectPath: childProject, holder: threadId }, laneKeys[2]);
  assert.deepEqual(replaced.notes.map((entry) => entry.authored), ["parent-2"]);
  const copied = await readNotes({ dataDir, projectPath: childProject, holder: threadId }, laneKeys[3]);
  assert.deepEqual(copied.notes.map((entry) => entry.authored), ["parent-3"]);

  response = await request(`/api/t/${threadId}/carry`);
  assert.equal(response.json().carry.status, "decided");
});

test("Phase 4 ensureService restarts a healthy service whose version is stale", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-phase4-handshake-"));
  temporary.push(base);
  await fs.mkdir(base, { recursive: true });
  const secret = "d".repeat(64);
  await fs.writeFile(path.join(base, "secret"), `${secret}\n`);
  await fs.writeFile(path.join(base, "service.json"), JSON.stringify({ port: 4321, instanceId: "old", version: "old", pluginRoot: "/old" }));
  const calls = [];
  let healthy = true;
  const request = async (info, route, options = {}) => {
    calls.push({ info, route, options });
    if (route === "/health") return healthy
      ? { status: 200, value: { instanceId: "old", version: "old" } }
      : { status: 503, value: {} };
    if (route === "/internal/shutdown") { healthy = false; return { status: 200, value: { ok: true } }; }
    return { status: 200, value: {} };
  };
  let spawned = false;
  const result = await ensureService({
    dataDir: base,
    version: "new",
    request,
    spawn() {
      spawned = true;
      return { unref() {} };
    },
    pollTimeoutMs: 1,
    pollMs: 0,
  }).catch((error) => error);
  assert.equal(spawned, true);
  assert.equal(calls.some((call) => call.route === "/internal/shutdown"), true);
  assert.equal(result.message, "SERVICE_START_TIMEOUT");
});
