import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { Readable } from "node:stream";
import vm from "node:vm";
import { test } from "node:test";

import { panelToken } from "../../plugins/collaborative-notes/server/lib/service-client.js";
import { PanelService } from "../../plugins/collaborative-notes/server/service.mjs";

const threadId = "thread-abcdefgh";

async function invoke(service, route, headers = {}) {
  const request = Readable.from([]);
  request.method = "GET";
  request.url = route;
  request.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  const result = { status: 200, headers: {}, body: "" };
  const response = {
    writeHead(status, responseHeaders) { result.status = status; result.headers = responseHeaders; },
    end(value = "") { result.body += value; },
  };
  await service.request(request, response);
  return result;
}

test("panel locales have complete zh/en key parity", async () => {
  const source = await fs.readFile("plugins/collaborative-notes/server/panel/i18n.js", "utf8");
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.runInNewContext(source, sandbox);
  const dictionary = sandbox.CollaborativeNotesI18n;
  assert.ok(dictionary);
  assert.deepEqual(Object.keys(dictionary.zh).sort(), Object.keys(dictionary.en).sort());
  assert.deepEqual(Array.from(dictionary.keys), Object.keys(dictionary.zh));
  for (const key of dictionary.keys) {
    assert.notEqual(dictionary.zh[key], "");
    assert.notEqual(dictionary.en[key], "");
  }
});

test("panel assets are served with token and correct content types", async () => {
  const service = new PanelService({
    dataDir: "/tmp/collaborative-notes-panel-test",
    secret: "a".repeat(64),
    threadContext: async (id) => ({ holder: id, projectPath: "/tmp", title: "Panel test" }),
  });
  service.server = { address: () => ({ port: 4321 }) };
  const token = panelToken(service.secret, threadId);
  const base = `/t/${threadId}`;

  let response = await invoke(service, `${base}/app.js?k=${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/javascript; charset=utf-8");
  assert.match(response.body, /function \(global\)/);

  response = await invoke(service, `${base}/style.css?k=${token}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/css; charset=utf-8");

  response = await invoke(service, `${base}/i18n.js?k=bad`);
  assert.equal(response.status, 403);
  response = await invoke(service, `${base}/index.html?k=${token}`, { Origin: "http://evil.invalid" });
  assert.equal(response.status, 403);
});
