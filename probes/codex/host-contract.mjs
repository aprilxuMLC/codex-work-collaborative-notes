// Development-only check of the Codex host behaviour the plugin relies on.
// Run before and after a ChatGPT/Codex update and compare the output:
//   node probes/codex/host-contract.mjs <threadId>
// It only reads: app-server metadata for one thread you name, and the app's
// version files. It prints field names and types, never message text.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { AppServerClient, resolveCodexBinary } from "../../plugins/collaborative-notes/server/lib/appserver.js";

const threadId = process.argv[2];
if (!threadId) {
  console.error("usage: node probes/codex/host-contract.mjs <threadId>");
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => results.push({ name, ok: Boolean(ok), detail });
const shape = (value) => Object.fromEntries(Object.entries(value || {}).map(([key, field]) => [key, Array.isArray(field) ? "array" : field === null ? "null" : typeof field]));

let appVersion = "unknown";
try {
  appVersion = execFileSync("defaults", ["read", "/Applications/ChatGPT.app/Contents/Info", "CFBundleShortVersionString"], { encoding: "utf8" }).trim();
} catch { /* not macOS or not installed */ }
const binary = await resolveCodexBinary();
let cliVersion = "unknown";
try { cliVersion = execFileSync(binary, ["--version"], { encoding: "utf8" }).trim(); } catch { /* keep unknown */ }

const client = new AppServerClient({ requestTimeoutMs: 60_000 });
try {
  const read = await client.request("thread/read", { threadId });
  const thread = read?.thread ?? read;
  check("thread/read returns cwd (absolute path)", typeof thread?.cwd === "string" && thread.cwd.startsWith("/"));
  check("thread/read returns name (string or null)", thread?.name === null || typeof thread?.name === "string" || thread?.name === undefined, typeof thread?.name);
  check("thread/read has forkedFromId field", "forkedFromId" in (thread || {}), typeof thread?.forkedFromId);
  check("thread/read originator names Desktop", /desktop/i.test(String(thread?.originator ?? "")), String(thread?.originator ?? ""));

  const turns = await client.request("thread/turns/list", { threadId, itemsView: "full", sortDirection: "desc", limit: 3 });
  const turn = turns?.data?.[0];
  check("turns/list returns data[] and cursor fields", Array.isArray(turns?.data) && "nextCursor" in (turns || {}), JSON.stringify(Object.keys(turns || {})));
  check("turn has id, status, startedAt (seconds), items[]", typeof turn?.id === "string" && typeof turn?.status === "string" && Number.isFinite(turn?.startedAt) && turn.startedAt < 1e11 && Array.isArray(turn?.items), JSON.stringify(shape(turn)));
  check("turn status vocabulary", ["completed", "failed", "interrupted", "inProgress"].includes(turn?.status), String(turn?.status));
  const items = (turns?.data || []).flatMap((entry) => entry.items || []);
  const agent = items.find((item) => item.type === "agentMessage");
  const user = items.find((item) => item.type === "userMessage");
  check("agentMessage has id, text, phase", typeof agent?.id === "string" && typeof agent?.text === "string" && "phase" in (agent || {}), JSON.stringify(shape(agent)));
  check("userMessage has id and content[].text", typeof user?.id === "string" && Array.isArray(user?.content) && user.content.some((part) => typeof part?.text === "string"), JSON.stringify(shape(user)));

  const listed = await client.request("thread/items/list", { threadId, sortDirection: "asc", limit: 5 });
  check("items/list returns data[] of {item, turnId}", Array.isArray(listed?.data) && (listed.data.length === 0 || ("item" in listed.data[0] && "turnId" in listed.data[0])), JSON.stringify(shape(listed?.data?.[0])));
} catch (error) {
  check("app-server requests", false, String(error?.message || error));
}

let deeplink = false;
try {
  const plist = readFileSync("/Applications/ChatGPT.app/Contents/Info.plist", "utf8");
  deeplink = /<string>codex<\/string>/.test(plist);
} catch { /* binary plist or missing */ }
check("app registers the codex:// URL scheme", deeplink);

console.log(`ChatGPT ${appVersion} · ${cliVersion} · ${binary.replace(process.env.HOME || "~", "~")}`);
for (const result of results) console.log(`${result.ok ? "PASS" : "FAIL"}  ${result.name}${result.detail ? `  [${result.detail}]` : ""}`);
process.exit(results.every((result) => result.ok) ? 0 : 1);
