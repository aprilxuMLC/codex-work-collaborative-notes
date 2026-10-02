import { promises as fs } from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "./lib/datadir.js";
import { ensureService, panelUrl, readSecret, serviceRequest } from "./lib/service-client.js";
import { isValidSessionId } from "./lib/structured-item.js";
import { isEntryModule } from "./lib/entry.js";

const PANEL_REOPEN_AFTER_MS = 5 * 60 * 1000;

// Hooks normally receive PLUGIN_DATA. Without it, derive the plugin id from
// the install path (<codex>/plugins/cache/<marketplace>/<name>/<version>/…),
// so the development and public marketplaces keep separate data.
export function pluginIdFromInstall(file = fileURLToPath(import.meta.url)) {
  const parts = file.split(path.sep);
  const cache = parts.lastIndexOf("cache");
  if (cache >= 0 && parts[cache - 1] === "plugins" && parts[cache + 2]) return `${parts[cache + 2]}@${parts[cache + 1]}`;
  return "collaborative-notes@collaborative-notes";
}
const REOPEN_BUDGET_MS = 1500;

// Resolve after `promise` or `ms`, whichever comes first; never rejects.
function withinMs(ms, promise) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise((resolve) => { timer = setTimeout(resolve, ms); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
}

// How to hand a codex:// link to the OS. Windows' `start` is a cmd built-in
// (and cmd would expand the link's % escapes), so use the protocol handler.
export function linkOpener(platform = process.platform, override = process.env.CN_OPENER) {
  if (override) return { command: override, args: [] };
  if (platform === "darwin") return { command: "open", args: [] };
  if (platform === "win32") return { command: "rundll32.exe", args: ["url.dll,FileProtocolHandler"] };
  return { command: "xdg-open", args: [] };
}

// The desktop link that shows a Notes page in the side panel. On Windows the
// bare codex://browser?url= link does nothing, while a thread link carrying
// browserUrl opens that conversation with the page in a browser tab.
export function panelDeepLink(url, platform = process.platform) {
  if (platform === "win32") {
    let threadId = null;
    try { threadId = decodeURIComponent(new URL(url).pathname.match(/^\/t\/([^/]+)$/)?.[1] ?? ""); } catch { /* not a panel URL */ }
    if (isValidSessionId(threadId)) {
      return `codex://threads/${encodeURIComponent(threadId)}?browserUrl=${encodeURIComponent(url)}`;
    }
  }
  return `codex://browser?url=${encodeURIComponent(url)}`;
}

export function createPanelLauncher({ spawn = defaultSpawn, opener, platform = process.platform } = {}) {
  const { command, args } = typeof opener === "string" ? { command: opener, args: [] } : linkOpener(platform);
  return (url) => new Promise((resolve) => {
    const deepLink = panelDeepLink(url, platform);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try { child = spawn(command, [...args, deepLink], { detached: true, stdio: "ignore", windowsHide: true }); }
    catch { finish(false); return; }
    child.once?.("error", () => finish(false));
    child.once?.("spawn", () => finish(true));
    child.unref?.();
    setTimeout(() => finish(false), 3000).unref?.();
  });
}

export const launchPanel = createPanelLauncher();

async function writeHookError(dataDir, error) {
  if (!dataDir) return;
  try {
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
    await fs.appendFile(path.join(dataDir, "hook-errors.log"), `${new Date().toISOString()} ${error?.code || error?.message || "HOOK_FAILED"}\n`);
  } catch { /* hook errors must not escape */ }
}

/**
 * Only desktop-app threads get an auto-opened panel. CLI/exec sessions also
 * run plugin hooks, and the codex://browser deeplink would land in whatever
 * desktop thread is on screen. The host records the session originator in
 * the first line of the transcript (session_meta).
 */
export async function isDesktopSession(input, env = process.env) {
  if (env.CN_ASSUME_DESKTOP === "1") return true;
  const transcript = input?.transcript_path;
  if (typeof transcript !== "string" || transcript.length === 0) return false;
  try {
    const handle = await fs.open(transcript, "r");
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
      const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
      const meta = JSON.parse(firstLine);
      const originator = String(meta?.payload?.originator ?? "");
      return /desktop/i.test(originator);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

async function hasPendingSelection(dataDir, threadId) {
  if (!dataDir || !isValidSessionId(threadId)) return false;
  try {
    const stored = JSON.parse(await fs.readFile(path.join(dataDir, "selections", `${threadId}.json`), "utf8"));
    return Array.isArray(stored?.targets) && stored.targets.length > 0;
  } catch {
    return false;
  }
}

export async function runHook(input, {
  env = process.env,
  ensure = ensureService,
  request = serviceRequest,
  secretReader = readSecret,
  urlBuilder = panelUrl,
  open = createPanelLauncher({ opener: env.CN_OPENER }),
  output,
} = {}) {
  const dataDir = env.PLUGIN_DATA || env.CN_DATA_DIR;
  // CN_HOOK_DEBUG=1 prints each step to stderr, for diagnosing a host.
  const trace = env.CN_HOOK_DEBUG === "1" ? (message) => process.stderr.write(`[collaborative-notes hook] ${message}\n`) : () => {};
  try {
    const event = input?.hook_event_name || input?.event || process.argv[2];
    const threadId = input?.session_id;
    trace(`event=${event} thread=${threadId} dataDir=${dataDir || "(derived)"} transcript=${input?.transcript_path ? "yes" : "no"}`);
    if (!isValidSessionId(threadId)) throw Object.assign(new Error("THREAD_UNAVAILABLE"), { code: "THREAD_UNAVAILABLE" });
    if (event !== "SessionStart" && event !== "UserPromptSubmit") return;
    const info = await ensure(dataDir || { pluginId: pluginIdFromInstall(), env });
    trace(`service port=${info?.port} dataDir=${info?.dataDir}`);
    const secret = await secretReader(info.dataDir || dataDir);
    const recorded = await request(info, "/internal/hook-seen", {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      body: { threadId, event },
    });
    trace(`hook-seen status=${recorded?.status}`);
    const source = input?.source;
    // Open the panel unless a page for this thread checked in recently. A
    // panel hidden with the side-panel toggle keeps polling; a closed one
    // does not, so the next message after a while brings it back.
    const openUnlessSeen = async (withinMs) => {
      const seen = await request(info, `/internal/panel-seen?threadId=${encodeURIComponent(threadId)}&withinMs=${withinMs}`, {
        method: "GET", headers: { Authorization: `Bearer ${secret}` }, timeoutMs: 1000,
      }).catch(() => null);
      trace(`panel recently seen=${Boolean(seen?.value?.recent)}`);
      if (!seen?.value?.recent) trace(`open=${await open(urlBuilder(info, threadId, secret))}`);
    };
    const startDesktop = event === "SessionStart" && (source === "startup" || source === "resume")
      && await withinMs(REOPEN_BUDGET_MS, isDesktopSession(input, env));
    trace(`source=${source} desktop=${Boolean(startDesktop)}`);
    if (startDesktop) {
      // A host-restored panel tab for this thread may already be polling;
      // opening again would duplicate it (seen after an app restart).
      await withinMs(REOPEN_BUDGET_MS, openUnlessSeen(10_000));
    }
    if (event === "UserPromptSubmit") {
      try { await respondToPrompt(); } finally {
        // After the reference is settled, never before: reopening a closed
        // panel must not delay or affect the user's message.
        await withinMs(REOPEN_BUDGET_MS, (async () => {
          if (await isDesktopSession(input, env)) await openUnlessSeen(PANEL_REOPEN_AFTER_MS);
        })());
      }
    }
    async function respondToPrompt() {
      const turnId = input?.turn_id || input?.turnId;
      const consumed = await request(info, "/internal/reference/consume", {
        method: "POST",
        timeoutMs: 3000,
        headers: { Authorization: `Bearer ${secret}` },
        body: { threadId, turnId, locale: input?.locale || env.LC_ALL || env.LANG },
      });
      const value = consumed?.value || {};
      if (consumed?.status === 200 && value.ok === true && value.selected === false) return;
      // Block only when the service confirms the user ticked notes that could
      // not be attached. Any other failure falls through to the fail-open check.
      if (!(value.selected === true || (consumed?.status === 200 && typeof value.text === "string"))) {
        throw Object.assign(new Error("REFERENCE_UNCONFIRMED"), { code: "REFERENCE_UNCONFIRMED" });
      }
      if (consumed?.status === 200 && value.ok === true && typeof value.text === "string") {
        output?.write?.(`${JSON.stringify({ hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: value.text,
        } })}\n`);
        return;
      }
      const reason = value.reason || (input?.locale === "zh" ? "便签引用失败；选择已保留" : "Notes reference failed; the selection was kept");
      output?.write?.(`${JSON.stringify({ decision: "block", reason: String(reason) })}\n`);
    }
  } catch (error) {
    trace(`error=${error?.code || error?.message}`);
    // Fail open: a Notes outage must never stop the user from talking to
    // Codex. Block only if the user actually has ticked notes pending.
    if (input?.hook_event_name === "UserPromptSubmit" && await hasPendingSelection(dataDir, input?.session_id)) {
      const zh = String(input?.locale || env.LC_ALL || env.LANG || "").toLowerCase().startsWith("zh");
      const reason = zh
        ? "便签服务暂时不可用，你勾选的便签未能附加，选择已保留。请稍后重试，或在面板中取消勾选后再发送。"
        : "The Notes service is temporarily unavailable, so your ticked notes could not be attached; they stay selected. Retry shortly, or untick them in the panel and send again.";
      output?.write?.(`${JSON.stringify({ decision: "block", reason })}\n`);
    }
    await writeHookError(dataDir, error);
  }
}

async function main() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  let input = {};
  try { input = text ? JSON.parse(text) : {}; } catch (error) { await writeHookError(process.env.PLUGIN_DATA, error); return; }
  let timer;
  const finished = await Promise.race([
    runHook(input, { output: process.stdout }).then(() => true),
    new Promise((resolve) => { timer = setTimeout(() => resolve(false), 5000); }),
  ]);
  clearTimeout(timer);
  if (!finished) await writeHookError(process.env.PLUGIN_DATA, { code: "HOOK_TIMEOUT" });
}

if (isEntryModule(import.meta.url)) {
  main().catch(() => {}).finally(() => { process.exitCode = 0; });
}
