import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { AppServerClient, createThreadContextResolver } from "../../plugins/collaborative-notes/server/lib/appserver.js";

const fake = path.resolve("test/fake-appserver.mjs");

test("appserver uses the fake JSON-RPC child and resolves thread context", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "cn-appserver-"));
  const client = new AppServerClient({
    binary: process.execPath,
    env: { ...process.env, FAKE_THREAD_CWD: cwd },
    spawn: (binary, args, options) => spawn(binary, [fake, ...args], options),
  });
  try {
    const thread = await client.readThread("thread-abcdefgh");
    assert.deepEqual(thread, {
      id: "thread-abcdefgh", cwd, name: "Fake thread", preview: "Preview", originator: undefined, forkedFromId: undefined,
    });
    assert.deepEqual(await client.listItems("thread-abcdefgh"), { items: [{ id: "item-1" }] });
    const context = await createThreadContextResolver(client)("thread-abcdefgh");
    assert.deepEqual(context, { holder: "thread-abcdefgh", projectPath: await fs.realpath(cwd), title: "Fake thread" });
  } finally { client.close(); await fs.rm(cwd, { recursive: true, force: true }); }
});

test("the bundled codex is looked up next to the app's own Node.js, newest layout first", async () => {
  const { bundledCandidates } = await import("../../plugins/collaborative-notes/server/lib/appserver.js");
  const list = bundledCandidates("/Users/x/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node");
  assert.deepEqual(list.slice(0, 2), [
    "/Users/x/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Users/x/Applications/ChatGPT.app/Contents/Resources/codex",
  ]);
  assert.ok(list.includes("/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"));
});
