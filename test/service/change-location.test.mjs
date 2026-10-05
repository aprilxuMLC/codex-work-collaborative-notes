import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { getSetupState, relocate, resolveRoot, setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";

const threadId = "thread-relocate";
const lane = "conversation_todo";
const temporary = [];

afterEach(async () => {
  while (temporary.length) await fs.rm(temporary.pop(), { recursive: true, force: true });
});

async function fixture(prefix = "cn-relocate-") {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(base);
  const project = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(project);
  return { base, project, dataDir };
}

async function noteFolder(root, content = "note") {
  const laneDir = path.join(root, lane);
  await fs.mkdir(laneDir, { recursive: true });
  await fs.writeFile(path.join(laneDir, "fixture.md"), content);
}

test("relocate requires an existing binding and accepts existing notes or an empty folder", async () => {
  const { project, dataDir, base } = await fixture();
  const empty = path.join(base, "empty");
  const withNotes = path.join(base, "with-notes");
  await fs.mkdir(empty);
  await noteFolder(withNotes);

  assert.equal((await relocate(dataDir, project, "custom", empty)).code, "SETUP_REQUIRED");
  assert.equal((await setup(dataDir, project, "default")).ok, true);

  const moved = await relocate(dataDir, project, "custom", withNotes);
  assert.deepEqual(moved, { ok: true, root: await fs.realpath(withNotes), state: "INITIALIZED", changed: true });
  const same = await relocate(dataDir, project, "custom", withNotes);
  assert.deepEqual(same, { ok: true, root: await fs.realpath(withNotes), state: "INITIALIZED", changed: false });

  const emptyMove = await relocate(dataDir, project, "custom", empty);
  assert.deepEqual(emptyMove, { ok: true, root: await fs.realpath(empty), state: "INITIALIZED", changed: true });
});

test("relocate rejects invalid or unwritable targets without changing the binding", async () => {
  const { project, dataDir, base } = await fixture();
  const current = path.join(base, "current");
  await fs.mkdir(current);
  assert.equal((await setup(dataDir, project, "custom", current)).ok, true);

  assert.equal((await relocate(dataDir, project, "custom", path.join(base, "missing"))).code, "LOCATION_INVALID");
  const file = path.join(base, "file");
  await fs.writeFile(file, "file");
  assert.equal((await relocate(dataDir, project, "custom", file)).code, "LOCATION_INVALID");
  const linked = path.join(base, "linked");
  await fs.symlink(current, linked, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await relocate(dataDir, project, "custom", linked)).code, "LOCATION_INVALID");

  const unwritable = path.join(base, "unwritable");
  await fs.mkdir(unwritable);
  const originalOpen = fs.open;
  fs.open = async (filePath, ...args) => {
    if (String(filePath).startsWith(path.join(await fs.realpath(unwritable), ".codex-notes-probe-"))) {
      throw Object.assign(new Error("fixture access denied"), { code: "EACCES" });
    }
    return originalOpen(filePath, ...args);
  };
  try {
    assert.equal((await relocate(dataDir, project, "custom", unwritable)).code, "LOCATION_UNUSABLE");
  } finally {
    fs.open = originalOpen;
  }
  assert.equal((await getSetupState(dataDir, project)).root, await fs.realpath(current));
});

test("relocate detects a notes folder one level down and acceptEmpty overrides it", async () => {
  const { project, dataDir, base } = await fixture();
  const current = path.join(base, "current");
  const parent = path.join(base, "moved-project");
  const nested = path.join(parent, "notes");
  await fs.mkdir(current);
  await fs.mkdir(parent);
  await noteFolder(nested);
  await setup(dataDir, project, "custom", current);

  const refused = await relocate(dataDir, project, "custom", parent);
  assert.deepEqual(refused, { ok: false, code: "NOTES_ONE_LEVEL_DOWN", nested: await fs.realpath(nested) });
  assert.equal((await getSetupState(dataDir, project)).root, await fs.realpath(current));

  const accepted = await relocate(dataDir, project, "custom", parent, { acceptEmpty: true });
  assert.deepEqual(accepted, { ok: true, root: await fs.realpath(parent), state: "INITIALIZED", changed: true });
});

test("relocate default can restore a missing notes folder as a pending default", async () => {
  const { project, dataDir, base } = await fixture();
  const current = path.join(base, "current");
  await fs.mkdir(current);
  await setup(dataDir, project, "custom", current);
  const result = await relocate(dataDir, project, "default");
  const root = path.join(await fs.realpath(project), "notes");
  assert.deepEqual(result, { ok: true, root, state: "INITIALIZED", changed: true });
  assert.equal((await resolveRoot(dataDir, project)).pendingDefault, true);
  assert.equal(await fs.access(root).then(() => true, () => false), false);
});

test("first-use setup still refuses an occupied custom location", async () => {
  const { project, dataDir, base } = await fixture();
  const occupied = path.join(base, "occupied");
  await noteFolder(occupied);
  assert.equal((await setup(dataDir, project, "custom", occupied)).code, "LOCATION_OCCUPIED");
});

async function serviceFixture() {
  const value = await fixture("cn-relocate-service-");
  const service = new PanelService({
    dataDir: value.dataDir,
    secret: "a".repeat(64),
    threadContext: async (id) => ({ holder: id, projectPath: value.project, title: "Relocate test" }),
    // A stub, so no real codex app-server child keeps the test process alive.
    appserver: {
      readThread: async (id) => ({ id, cwd: value.project, name: "Relocate test" }),
      listItems: async () => ({ data: [] }),
      listTurns: async () => ({ data: [] }),
      request: async () => ({ data: [] }),
      close() {},
    },
    idleMs: 60_000,
  });
  service.server = { address: () => ({ port: 4321 }) };
  const token = panelToken(service.secret, threadId);
  const request = (route, options = {}) => invoke(service, route, {
    ...options,
    headers: { "X-CN-Token": token, ...(options.headers || {}) },
  });
  return { ...value, service, request };
}

async function invoke(service, route, { method = "GET", headers = {}, body } = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  request.method = method;
  request.url = route;
  request.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const result = { status: 200, headers: {}, body: "" };
  const response = {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
    end(value = "") { result.body += value; },
  };
  await service.request(request, response);
  return { status: result.status, headers: result.headers, json: async () => JSON.parse(result.body) };
}

test("location route requires auth and same origin, rejects unknown fields, and returns nested path", async () => {
  const { service, request, project, dataDir, base } = await serviceFixture();
  const body = JSON.stringify({ action: "default" });
  assert.equal((await invoke(service, `/api/t/${threadId}/location`, { method: "POST", body })).status, 403);
  assert.equal((await request(`/api/t/${threadId}/location`, {
    method: "POST", body, headers: { Origin: "https://fixture.invalid", "content-type": "application/json" },
  })).status, 403);

  await request(`/api/t/${threadId}/setup`, { method: "POST", body, headers: { "content-type": "application/json" } });
  const parent = path.join(base, "parent");
  const nested = path.join(parent, "notes");
  await fs.mkdir(parent);
  await noteFolder(nested);
  const unknown = await request(`/api/t/${threadId}/location`, {
    method: "POST", body: JSON.stringify({ action: "custom", customPath: parent, extra: true }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(unknown.status, 400);
  const refused = await request(`/api/t/${threadId}/location`, {
    method: "POST", body: JSON.stringify({ action: "custom", customPath: parent }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { ok: false, code: "NOTES_ONE_LEVEL_DOWN", nested: await fs.realpath(nested) });
  assert.equal((await getSetupState(dataDir, project)).root, path.join(await fs.realpath(project), "notes"));
});

test("location route succeeds and context reports the new root", async () => {
  const { request, project, base } = await serviceFixture();
  const current = path.join(base, "current");
  const target = path.join(base, "target");
  await fs.mkdir(current);
  await fs.mkdir(target);
  await request(`/api/t/${threadId}/setup`, {
    method: "POST", body: JSON.stringify({ action: "custom", customPath: current }),
    headers: { "content-type": "application/json" },
  });
  const response = await request(`/api/t/${threadId}/location`, {
    method: "POST", body: JSON.stringify({ action: "custom", customPath: target }),
    headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).root, await fs.realpath(target));
  const context = await request(`/api/t/${threadId}/context`);
  assert.equal((await context.json()).setup.root, await fs.realpath(target));
});
