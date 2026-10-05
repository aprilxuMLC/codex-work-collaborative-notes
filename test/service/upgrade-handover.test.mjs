import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { PanelService, successorRoot } from "../../plugins/collaborative-notes/server/service.mjs";
import { AppServerClient } from "../../plugins/collaborative-notes/server/lib/appserver.js";

async function install(parent, version) {
  const root = path.join(parent, version);
  await fs.mkdir(path.join(root, "server"), { recursive: true });
  await fs.writeFile(path.join(root, "server", "service.mjs"), "");
  return root;
}

test("an upgraded-away service starts the newest installed version on its data directory", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-upgrade-"));
  try {
    const parent = path.join(base, "collaborative-notes");
    const removed = path.join(parent, "0.5.1");
    await install(parent, "0.5.2");
    const newest = await install(parent, "0.10.0");
    await fs.mkdir(path.join(parent, "not-an-install"), { recursive: true });
    assert.equal(await successorRoot(removed), newest);

    const spawned = [];
    const dataDir = path.join(base, "data");
    const service = new PanelService({
      dataDir, secret: "c".repeat(64), threadContext: async () => ({ projectPath: base }), appserver: { close() {} },
      pluginRoot: removed,
      spawn: (command, args, options) => { spawned.push({ command, args, options }); return { unref() {}, on() {} }; },
    });
    await service.handOverToSuccessor();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].args[0], path.join(newest, "server", "service.mjs"));
    assert.equal(spawned[0].options.env.CN_DATA_DIR, dataDir);
    assert.equal(spawned[0].options.detached, true);
    assert.equal(spawned[0].options.cwd, os.homedir());
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("no successor means no spawn", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-upgrade-"));
  try {
    assert.equal(await successorRoot(path.join(base, "plugin", "0.5.1")), null);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("codex app-server is started from the home directory, not a possibly deleted install", async () => {
  const calls = [];
  const client = new AppServerClient({
    binary: "/bin/false",
    spawn: (command, args, options) => {
      calls.push(options);
      throw Object.assign(new Error("stop"), { code: "STOP" });
    },
  });
  await assert.rejects(client.request("thread/read", { threadId: "x" }));
  assert.equal(calls[0].cwd, os.homedir());
});
