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

test("on Windows the bundled codex.exe is found in the app's runtime copy, newest first", async () => {
  const { windowsRuntimeExecutables } = await import("../../plugins/collaborative-notes/server/lib/appserver.js");
  const { mkdtemp, mkdir, writeFile, utimes, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const base = await mkdtemp(path.join(os.tmpdir(), "cn-winrt-"));
  try {
    const runtimes = path.join(base, "OpenAI", "Codex", "runtimes", "codex");
    for (const [hash, age] of [["old111", 100], ["new222", 1]]) {
      await mkdir(path.join(runtimes, hash, "bin"), { recursive: true });
      const file = path.join(runtimes, hash, "bin", "codex.exe");
      await writeFile(file, "");
      const when = new Date(Date.now() - age * 1000);
      await utimes(file, when, when);
    }
    const found = await windowsRuntimeExecutables("codex.exe", { LOCALAPPDATA: base });
    assert.equal(found.length, 2);
    assert.match(found[0], /new222/);
    assert.deepEqual(await windowsRuntimeExecutables("codex.exe", {}), []);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test("on Windows codex.exe in the app's Codex bin directory is found, and PATH yields only real .exe files", async () => {
  const { windowsRuntimeExecutables, findOnPath } = await import("../../plugins/collaborative-notes/server/lib/appserver.js");
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const base = await mkdtemp(path.join(os.tmpdir(), "cn-winbin-"));
  try {
    const bin = path.join(base, "OpenAI", "Codex", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex.exe"), "");
    assert.deepEqual(await windowsRuntimeExecutables("codex.exe", { LOCALAPPDATA: base }), [path.join(bin, "codex.exe")]);
    // npm's extensionless sh shim is not spawnable on Windows.
    const npm = path.join(base, "npm");
    await mkdir(npm);
    await writeFile(path.join(npm, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(await findOnPath("codex", { PATH: npm }, "win32"), undefined);
    await writeFile(path.join(npm, "codex.exe"), "", { mode: 0o755 });
    assert.equal(await findOnPath("codex", { PATH: npm }, "win32"), path.join(npm, "codex.exe"));
    assert.equal(await findOnPath("codex", { PATH: npm }, "darwin"), path.join(npm, "codex"));
  } finally { await rm(base, { recursive: true, force: true }); }
});
