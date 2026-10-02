import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import http from "node:http";
import { runHook } from "../../plugins/collaborative-notes/server/hook.mjs";
import { ensureService } from "../../plugins/collaborative-notes/server/lib/service-client.js";

const threadId = "01a00000-0000-7000-8000-000000000003";

function capture() {
  let text = "";
  return { write: (chunk) => { text += chunk; }, get text() { return text; } };
}

test("UserPromptSubmit fails open when the service is unreachable and nothing is ticked", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cn-failopen-"));
  const out = capture();
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: threadId, turn_id: "t1" }, {
    env: { PLUGIN_DATA: dataDir },
    ensure: async () => { throw new Error("SERVICE_START_TIMEOUT"); },
    output: out,
  });
  assert.equal(out.text, "");
});

test("UserPromptSubmit blocks when the service is unreachable but ticked notes are pending", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cn-failopen-"));
  await fs.mkdir(path.join(dataDir, "selections"), { recursive: true });
  await fs.writeFile(path.join(dataDir, "selections", `${threadId}.json`),
    JSON.stringify({ targets: [{ lane: "deferred_work", itemKey: "ik-abc-def" }], generation: 1 }));
  const out = capture();
  await runHook({ hook_event_name: "UserPromptSubmit", session_id: threadId, turn_id: "t1" }, {
    env: { PLUGIN_DATA: dataDir },
    ensure: async () => { throw new Error("SERVICE_START_TIMEOUT"); },
    output: out,
  });
  assert.equal(JSON.parse(out.text).decision, "block");
});

test("version handover terminates an old instance held open by a keep-alive client", async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cn-handover-"));
  const old = await ensureService(dataDir, { version: "0.0.1-old" });
  // Hold a keep-alive connection open like the in-app browser does.
  const agent = new http.Agent({ keepAlive: true });
  await new Promise((resolve) => http.get({ host: "127.0.0.1", port: old.port, path: "/health", agent }, (res) => { res.resume(); res.on("end", resolve); }));
  const fresh = await ensureService(dataDir, { version: "9.9.9-new" });
  assert.equal(fresh.version, "9.9.9-new");
  let alive = true;
  try { process.kill(old.pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
  agent.destroy();
  process.kill(fresh.pid, "SIGTERM");
});
