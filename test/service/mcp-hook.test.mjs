import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { setup } from "../../plugins/collaborative-notes/server/lib/binding.js";
import { createMcpServer } from "../../plugins/collaborative-notes/server/mcp.mjs";
import { runHook } from "../../plugins/collaborative-notes/server/hook.mjs";

const threadId = "thread-abcdefgh";

test("MCP lists tools and rejects missing holder metadata", async () => {
  const server = createMcpServer({
    resolveDataDirectory: async () => "/tmp/not-used-by-this-test",
    contextResolver: async () => ({ projectPath: "/tmp" }),
  });
  const listed = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(listed.result.tools.length, 5);
  const missing = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
    name: "notes-read", arguments: { lane: "conversation_todo" }, _meta: {},
  } });
  assert.equal(missing.result.isError, true);
  assert.deepEqual(JSON.parse(missing.result.content[0].text), { code: "NOTES_HOLDER_UNAVAILABLE" });
});

test("MCP tools use injected holder context and the Phase 1 writer", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "cn-mcp-"));
  try {
    const project = path.join(base, "project");
    const dataDir = path.join(base, "data");
    await fs.mkdir(project);
    await setup(dataDir, project, "default");
    const server = createMcpServer({
      resolveDataDirectory: async () => dataDir,
      contextResolver: async () => ({ projectPath: project }),
    });
    const written = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {
      name: "notes-write", arguments: { lane: "conversation_todo", content: "from mcp" },
      _meta: { threadId, plugin_id: "collaborative-notes@collaborative-notes" },
    } });
    assert.equal(written.result.isError, undefined);
    const read = await server.handle({ jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "notes-read", arguments: { lane: "conversation_todo" },
      _meta: { threadId, plugin_id: "collaborative-notes@collaborative-notes" },
    } });
    assert.equal(JSON.parse(read.result.content[0].text).notes[0].authored, "from mcp");
    // Bounded read-only cross-conversation read: another thread reads it via "thread".
    const other = "01a00000-0000-7000-8000-000000000002";
    const cross = await server.handle({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "notes-read", arguments: { lane: "L1", thread: threadId },
      _meta: { threadId: other, plugin_id: "collaborative-notes@collaborative-notes" },
    } });
    const crossValue = JSON.parse(cross.result.content[0].text);
    assert.equal(crossValue.crossThread, true);
    assert.equal(crossValue.readOnly, true);
    assert.equal(crossValue.notes[0].authored, "from mcp");
    // Writes never take a thread argument.
    const crossWrite = await server.handle({ jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      name: "notes-write", arguments: { lane: "L1", content: "x", thread: threadId },
      _meta: { threadId: other, plugin_id: "collaborative-notes@collaborative-notes" },
    } });
    assert.equal(crossWrite.result.isError, true);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("hooks record both supported events and open only startup/resume", async () => {
  const calls = [];
  const common = {
    env: { PLUGIN_DATA: "/tmp/collaborative-notes-hook-test", CN_OPENER: "echo" },
    ensure: async () => ({ port: 4321, instanceId: "instance", dataDir: "/tmp/collaborative-notes-hook-test" }),
    secretReader: async () => "a".repeat(64),
    request: async (_info, route, options) => { calls.push({ route, options }); return { status: 200 }; },
    open: (url) => calls.push({ open: url }),
  };
  const os = await import("node:os");
  const fsp = await import("node:fs/promises");
  const pathMod = await import("node:path");
  const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "cn-transcript-"));
  const desktop = pathMod.join(dir, "desktop.jsonl");
  const exec = pathMod.join(dir, "exec.jsonl");
  await fsp.writeFile(desktop, JSON.stringify({ type: "session_meta", payload: { originator: "Codex Desktop" } }) + "\n");
  await fsp.writeFile(exec, JSON.stringify({ type: "session_meta", payload: { originator: "codex_exec" } }) + "\n");
  // CLI/exec sessions must not open a panel in the desktop app.
  await runHook({ hook_event_name: "SessionStart", source: "startup", session_id: threadId, transcript_path: exec }, common);
  assert.ok(!calls.some((call) => call.open));
  await runHook({ hook_event_name: "SessionStart", source: "startup", session_id: threadId, transcript_path: desktop }, common);
  assert.ok(calls.some((call) => call.open));
  const count = calls.length;
  await runHook({ hook_event_name: "SessionStart", source: "compact", session_id: threadId }, common);
  assert.equal(calls.length, count + 1);
  assert.equal(calls.at(-1).open, undefined);
  assert.equal(calls.filter((call) => call.route === "/internal/hook-seen").length, 3);
});

test("a message reopens a closed panel, but not one that checked in recently", async () => {
  const fsp = await import("node:fs/promises");
  const os = await import("node:os");
  const pathMod = await import("node:path");
  const dir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), "cn-reopen-"));
  try {
    const desktop = pathMod.join(dir, "desktop.jsonl");
    await fsp.writeFile(desktop, JSON.stringify({ type: "session_meta", payload: { originator: "Codex Desktop" } }) + "\n");
    for (const recent of [false, true]) {
      const calls = [];
      await runHook({ hook_event_name: "UserPromptSubmit", session_id: threadId, turn_id: "turn-1", transcript_path: desktop }, {
        env: { PLUGIN_DATA: dir },
        ensure: async () => ({ port: 4321, dataDir: dir }),
        secretReader: async () => "a".repeat(64),
        request: async (_info, route) => {
          calls.push(route);
          if (route.startsWith("/internal/panel-seen")) return { status: 200, value: { recent } };
          if (route === "/internal/reference/consume") return { status: 200, value: { ok: true, selected: false } };
          return { status: 200, value: {} };
        },
        open: async (url) => { calls.push({ open: url }); return true; },
      });
      const seenRoute = calls.find((call) => typeof call === "string" && call.startsWith("/internal/panel-seen"));
      assert.match(seenRoute, /withinMs=300000/);
      assert.equal(calls.some((call) => call.open), !recent);
      // The reopen check runs only after the reference was settled.
      assert.ok(calls.indexOf("/internal/reference/consume") < calls.indexOf(seenRoute));
    }
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
});

test("a stalled transcript read cannot hold the prompt beyond the reopen budget", async () => {
  const started = Date.now();
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: threadId, turn_id: "turn-2", transcript_path: "/dev/null" }, {
    env: { PLUGIN_DATA: "/tmp/not-used", CN_ASSUME_DESKTOP: "1" },
    ensure: async () => ({ port: 4321, dataDir: "/tmp/not-used" }),
    secretReader: async () => "a".repeat(64),
    request: async (_info, route) => (route.startsWith("/internal/panel-seen")
      ? new Promise(() => {})
      : { status: 200, value: { ok: true, selected: false } }),
    open: async () => true,
  });
  assert.ok(Date.now() - started < 2500);
});

test("the MCP server does not depend on a node on PATH (fresh Macs have none)", async () => {
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(new URL("../../plugins/collaborative-notes/.mcp.json", import.meta.url), "utf8"));
  const server = config.mcpServers.collab_notes;
  assert.equal(server.command, "/bin/sh");
  const script = server.args.join(" ");
  assert.match(script, /CODEX_MCP_NODE_PATH/);
  assert.match(script, /ChatGPT\.app\/Contents\/Resources\/cua_node\/bin\/node/);
  assert.ok(script.indexOf("cua_node") < script.indexOf("command -v node"), "the bundled Node comes before PATH");
});

test("the hook derives its plugin id from the install path, so dev and public data stay apart", async () => {
  const { pluginIdFromInstall } = await import("../../plugins/collaborative-notes/server/hook.mjs");
  assert.equal(pluginIdFromInstall("/Users/x/.codex/plugins/cache/collaborative-notes/collaborative-notes/0.7.0/server/hook.mjs"), "collaborative-notes@collaborative-notes");
  assert.equal(pluginIdFromInstall("/Users/x/.codex/plugins/cache/collaborative-notes-dev/collaborative-notes/0.7.0/server/hook.mjs"), "collaborative-notes@collaborative-notes-dev");
  assert.equal(pluginIdFromInstall("/repo/plugins/collaborative-notes/server/hook.mjs"), "collaborative-notes@collaborative-notes");
});
