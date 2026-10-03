import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { createNote } from "../../plugins/collaborative-notes/server/lib/notes-ops.js";
import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";

const parentId = "thread-parent-0001";
const childId = "thread-child-0001";
const otherChildId = "thread-child-0002";
const secret = "b".repeat(64);
const temporary = [];

async function invoke(service, route, { headers = {}, method = "GET" } = {}) {
  const request = Readable.from([]);
  request.method = method;
  request.url = route;
  request.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const result = { status: 200, headers: {}, body: "" };
  const response = {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
    end(value = "") { result.body += value; },
  };
  await service.request(request, response);
  return { ...result, json: () => JSON.parse(result.body) };
}

async function makeFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-s9-"));
  temporary.push(base);
  const dataDir = path.join(base, "data");
  const codexHome = path.join(base, "codex");
  const project = path.join(base, "project");
  await fs.mkdir(project, { recursive: true });
  await setup(dataDir, project, "default");
  await createNote({ dataDir, projectPath: project, holder: parentId }, "conversation_todo", { content: "parent note" });
  const threads = new Map([
    [parentId, { id: parentId, cwd: project, name: "Parent", originator: "desktop", threadSource: "user" }],
    [childId, { id: childId, cwd: project, name: "Child", originator: "desktop", threadSource: "user", forkedFromId: parentId, createdAt: new Date().toISOString() }],
  ]);
  const appserver = {
    async readThread(id) { return threads.get(id) || { id }; },
  };
  const context = async (id) => {
    const thread = threads.get(id);
    return thread ? { holder: id, projectPath: thread.cwd, title: thread.name } : { ok: false, code: "THREAD_UNAVAILABLE" };
  };
  // The watcher reads today's and yesterday's session folders (local date).
  const today = new Date();
  const sessionDir = path.join(codexHome, "sessions", String(today.getFullYear()), String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0"));
  await fs.mkdir(sessionDir, { recursive: true });
  return { base, dataDir, codexHome, project, sessionDir, threads, appserver, context };
}

async function writeSession(sessionDir, id, payload, secondLine = "") {
  await fs.writeFile(path.join(sessionDir, `${id}.jsonl`), `${JSON.stringify({ type: "session_meta", payload })}\n${secondLine}`);
}

test.afterEach(async () => {
  while (temporary.length) await fs.rm(temporary.pop(), { recursive: true, force: true });
});

test("S9 watcher opens an eligible fork once, persists before launch, and reads only metadata", async () => {
  const fixture = await makeFixture();
  const opened = [];
  await writeSession(fixture.sessionDir, childId, { id: childId, forked_from_id: parentId }, "not-json message content that must never be parsed");
  const service = new PanelService({
    dataDir: fixture.dataDir,
    secret,
    appserver: fixture.appserver,
    threadContext: fixture.context,
    env: { CODEX_HOME: fixture.codexHome },
    now: () => Date.now(),
    openPanel: async (url) => { opened.push(url); },
  });
  service.server = { address: () => ({ port: 4321 }) };

  await service.scanForks();
  await service.scanForks();
  assert.equal(opened.length, 1);
  assert.match(opened[0], new RegExp(`/t/${childId}\\?k=`));
  const openedLedger = JSON.parse(await fs.readFile(path.join(fixture.dataDir, "fork-opened.json"), "utf8"));
  assert.equal(typeof openedLedger[childId], "string");

  const restarted = new PanelService({
    dataDir: fixture.dataDir,
    secret,
    appserver: fixture.appserver,
    threadContext: fixture.context,
    env: { CODEX_HOME: fixture.codexHome },
    openPanel: async (url) => { opened.push(url); },
  });
  restarted.server = { address: () => ({ port: 4321 }) };
  await restarted.scanForks();
  assert.equal(opened.length, 1);
});

test("S9 watcher rejects non-forks and every stated ineligible fork", async () => {
  const fixture = await makeFixture();
  const opened = [];
  const cases = [
    ["not-a-fork", { id: "thread-nonfork-1", cwd: fixture.project, originator: "desktop", threadSource: "user" }],
    ["subagent", { id: "thread-subagent-1", cwd: fixture.project, originator: "desktop", threadSource: "user", forkedFromId: parentId, agentRole: "worker" }],
    ["non-user", { id: "thread-nonuser-1", cwd: fixture.project, originator: "desktop", threadSource: "system", forkedFromId: parentId }],
    ["non-desktop", { id: "thread-cli-0001", cwd: fixture.project, originator: "cli", threadSource: "user", forkedFromId: parentId }],
  ];
  for (const [name, thread] of cases) {
    fixture.threads.set(thread.id, thread);
    await writeSession(fixture.sessionDir, thread.id, { id: thread.id, ...(thread.forkedFromId ? { forked_from_id: parentId } : {}) });
  }
  const uninitialized = path.join(fixture.base, "uninitialized");
  await fs.mkdir(uninitialized);
  fixture.threads.set("thread-uninitialized", { id: "thread-uninitialized", cwd: uninitialized, originator: "desktop", threadSource: "user", forkedFromId: parentId });
  await writeSession(fixture.sessionDir, "thread-uninitialized", { id: "thread-uninitialized", forked_from_id: parentId });
  fixture.threads.set("thread-no-notes", { id: "thread-no-notes", cwd: fixture.project, originator: "desktop", threadSource: "user", forkedFromId: "thread-empty-parent" });
  fixture.threads.set("thread-empty-parent", { id: "thread-empty-parent", cwd: uninitialized, originator: "desktop", threadSource: "user" });
  await writeSession(fixture.sessionDir, "thread-no-notes", { id: "thread-no-notes", forked_from_id: "thread-empty-parent" });
  fixture.threads.set("thread-decided", { id: "thread-decided", cwd: fixture.project, originator: "desktop", threadSource: "user", forkedFromId: parentId });
  await fs.mkdir(path.join(fixture.project, "notes", ".carry-over"), { recursive: true });
  await fs.writeFile(path.join(fixture.project, "notes", ".carry-over", "thread-decided.json"), JSON.stringify({ status: "decided" }));
  await writeSession(fixture.sessionDir, "thread-decided", { id: "thread-decided", forked_from_id: parentId });

  const service = new PanelService({
    dataDir: fixture.dataDir,
    secret,
    appserver: fixture.appserver,
    threadContext: fixture.context,
    env: { CODEX_HOME: fixture.codexHome },
    openPanel: async (url) => { opened.push(url); },
  });
  service.server = { address: () => ({ port: 4321 }) };
  await service.scanForks();
  assert.deepEqual(opened, []);
});

test("S9 context exposes unresolved recent forks, then filters decisions and expiry", async () => {
  const fixture = await makeFixture();
  const now = { value: Date.now() };
  await writeSession(fixture.sessionDir, childId, { id: childId, forked_from_id: parentId });
  const service = new PanelService({
    dataDir: fixture.dataDir,
    secret,
    appserver: fixture.appserver,
    threadContext: fixture.context,
    env: { CODEX_HOME: fixture.codexHome },
    now: () => now.value,
    openPanel: async () => {},
  });
  service.server = { address: () => ({ port: 4321 }) };
  await service.scanForks();
  const headers = { "x-cn-token": panelToken(secret, parentId) };
  let response = await invoke(service, `/api/t/${parentId}/context`, { headers });
  assert.deepEqual((response.json()).recentForks, [{ childId, title: "Child" }]);
  await fs.mkdir(path.join(fixture.project, "notes", ".carry-over"), { recursive: true });
  await fs.writeFile(path.join(fixture.project, "notes", ".carry-over", `${childId}.json`), JSON.stringify({ status: "decided" }));
  response = await invoke(service, `/api/t/${parentId}/context`, { headers });
  assert.deepEqual(response.json().recentForks, []);
  await fs.rm(path.join(fixture.project, "notes", ".carry-over", `${childId}.json`));
  now.value += 10 * 60 * 1000 + 1;
  response = await invoke(service, `/api/t/${parentId}/context`, { headers });
  assert.deepEqual(response.json().recentForks, []);
});

test("S9 branch link requires the parent cookie and redirects to the child token", async () => {
  const fixture = await makeFixture();
  const service = new PanelService({ dataDir: fixture.dataDir, secret, appserver: fixture.appserver, threadContext: fixture.context });
  service.server = { address: () => ({ port: 4321 }) };
  const parentToken = panelToken(secret, parentId);
  let response = await invoke(service, `/t/${parentId}/branch/${childId}`);
  assert.equal(response.status, 403);
  response = await invoke(service, `/t/${parentId}/branch/${childId}`, { headers: { cookie: `cn_t_${parentId}=${parentToken}` } });
  assert.equal(response.status, 303);
  assert.equal(response.headers.location, `/t/${childId}?k=${panelToken(secret, childId)}&from=${parentId}`);
  response = await invoke(service, `/t/${parentId}/branch/${otherChildId}`, { headers: { cookie: `cn_t_${parentId}=${parentToken}` } });
  assert.equal(response.status, 404);
});

test("S9 panel and docs wire branch notice text in both locales", async () => {
  const app = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/app.js", import.meta.url), "utf8");
  const html = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/index.html", import.meta.url), "utf8");
  const i18n = await fs.readFile(new URL("../../plugins/collaborative-notes/server/panel/i18n.js", import.meta.url), "utf8");
  const adapter = await fs.readFile(new URL("../../docs/chatgpt-desktop-adapter.md", import.meta.url), "utf8");
  const readme = await fs.readFile(new URL("../../README.md", import.meta.url), "utf8");
  const readmeZh = await fs.readFile(new URL("../../README.zh-CN.md", import.meta.url), "utf8");
  assert.match(html, /id="branch-banner"/);
  assert.match(app, /recentForks/);
  assert.match(app, /sessionStorage/);
  assert.match(app, /location\.href/);
  assert.match(i18n, /刚从这个对话分出了分支/);
  assert.match(i18n, /A branch was just created from this conversation/);
  assert.match(i18n, /help\.branches/);
  assert.match(adapter, /first line/);
  assert.match(adapter, /CN_FORK_WATCH=0/);
  assert.match(readme, /branch's Notes/);
  assert.match(readmeZh, /打开分支的便签/);
});
