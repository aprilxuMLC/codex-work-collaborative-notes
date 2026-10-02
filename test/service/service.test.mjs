import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { acquireLock, releaseLock } from "../../plugins/collaborative-notes/server/lib/lane-store.js";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";

const threadId = "thread-abcdefgh";
const lane = "conversation_todo";
const temporary = [];

afterEach(async () => {
  while (temporary.length) await fs.rm(temporary.pop(), { recursive: true, force: true });
});

async function fixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-service-"));
  temporary.push(base);
  const projectPath = path.join(base, "project");
  const dataDir = path.join(base, "data");
  await fs.mkdir(projectPath);
  const context = async (id) => ({ holder: id, projectPath, title: "Service test thread" });
  const service = new PanelService({ dataDir, secret: "a".repeat(64), threadContext: context, idleMs: 60_000 });
  service.server = { address: () => ({ port: 4321 }) };
  const token = panelToken(service.secret, threadId);
  const request = (route, options = {}) => invoke(service, route, {
    ...options,
    headers: { "X-CN-Token": token, ...(options.headers || {}) },
  });
  return { base, projectPath, dataDir, service, request, token };
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
  return {
    status: result.status,
    headers: result.headers,
    text: async () => result.body,
    json: async () => JSON.parse(result.body),
  };
}

test("service enforces origin/token and exposes context and placeholder panel", async () => {
  const { request, service } = await fixture();
  let response = await invoke(service, `/api/t/${threadId}/context`);
  assert.equal(response.status, 403);
  response = await request(`/api/t/${threadId}/context`, { headers: { Origin: "http://evil.invalid" } });
  assert.equal(response.status, 403);
  response = await request(`/api/t/${threadId}/context`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).title, "Service test thread");
  response = await invoke(service, `/t/${threadId}?k=bad`);
  assert.equal(response.status, 403);
  response = await invoke(service, `/t/${threadId}?k=${encodeURIComponent(service.secret)}`);
  assert.equal(response.status, 403);
  const correct = panelToken(service.secret, threadId);
  response = await invoke(service, `/t/${threadId}?k=${correct}`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Collaborative Notes panel — Phase 2b/);
});

test("service refuses a second instance without removing the first lock", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-service-lock-"));
  temporary.push(base);
  const dataDir = path.join(base, "data");
  await fs.mkdir(dataDir);
  const lockPath = path.join(dataDir, "service.lock");
  const first = await acquireLock(lockPath);
  const service = new PanelService({
    dataDir, secret: "a".repeat(64), threadContext: async () => ({ projectPath: base }),
    lockOptions: { waitMs: 10, retryMs: 1 },
  });
  try {
    await assert.rejects(service.start(), (error) => error.code === "LOCKED");
    assert.equal((await fs.stat(lockPath)).isFile(), true);
  } finally { await releaseLock(lockPath, first.handle); }
});

test("service setup, folder browsing, lane CRUD and prefs share the Phase 1 core", async () => {
  const { base, projectPath, dataDir, request } = await fixture();
  let response = await request(`/api/t/${threadId}/setup`, {
    method: "POST", body: JSON.stringify({ action: "default" }), headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  response = await request(`/api/t/${threadId}/fs?path=${encodeURIComponent(base)}`);
  assert.equal(response.status, 200);
  assert.ok((await response.json()).entries.some((entry) => entry.name === "project"));
  response = await request(`/api/t/${threadId}/fs/mkdir`, {
    method: "POST", body: JSON.stringify({ parent: projectPath, name: "new-notes" }), headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  response = await request(`/api/t/${threadId}/lanes/${lane}/notes`, {
    method: "POST", body: JSON.stringify({ content: "plain note" }), headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  const created = await response.json();
  response = await request(`/api/t/${threadId}/lanes/${lane}`);
  const read = await response.json();
  assert.equal(read.notes[0].authored, "plain note");
  response = await request(`/api/t/${threadId}/lanes/${lane}/notes/${created.itemKey}`, {
    method: "PUT", body: JSON.stringify({ content: "edited", expectedVersion: read.version }), headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  const edited = await response.json();
  response = await request(`/api/t/${threadId}/prefs`, {
    method: "PUT", body: JSON.stringify({ pins: { [lane]: { [created.itemKey]: true } } }), headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).pins[lane][created.itemKey], true);
  response = await request(`/api/t/${threadId}/lanes/${lane}/notes/${created.itemKey}?v=${edited.version}`, { method: "DELETE" });
  assert.equal(response.status, 200);
  assert.equal((await fs.stat(path.join(projectPath, "notes", lane, `${threadId}.md`))).isFile(), true);
  assert.equal((await fs.stat(dataDir)).isDirectory(), true);
});
