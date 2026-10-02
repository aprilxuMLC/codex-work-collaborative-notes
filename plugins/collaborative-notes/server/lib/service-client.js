import { execFileSync } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "./datadir.js";
import { isValidSessionId } from "./structured-item.js";

function secretBytes(secret) {
  if (Buffer.isBuffer(secret)) return secret;
  if (typeof secret === "string" && /^[0-9a-f]{64}$/i.test(secret)) return Buffer.from(secret, "hex");
  return Buffer.from(String(secret ?? ""), "utf8");
}

export function panelToken(secret, threadId) {
  return createHmac("sha256", secretBytes(secret)).update(`panel:${threadId}`).digest("hex");
}

export function panelUrl(info, threadId, secret) {
  if (!info || !Number.isInteger(info.port) || !isValidSessionId(threadId)) {
    throw new Error("PANEL_URL_INVALID");
  }
  const token = panelToken(secret, threadId);
  return `http://127.0.0.1:${info.port}/t/${encodeURIComponent(threadId)}?k=${token}`;
}

async function requestRaw(url, {
  method = "GET",
  headers = {},
  body,
  timeoutMs = 1000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let value;
    try { value = text ? JSON.parse(text) : null; } catch { value = { code: "INVALID_RESPONSE" }; }
    return { status: response.status, ok: response.ok, value };
  } finally { clearTimeout(timer); }
}

export async function serviceRequest(info, route, options = {}) {
  if (!info || !Number.isInteger(info.port)) throw new Error("SERVICE_UNAVAILABLE");
  return requestRaw(`http://127.0.0.1:${info.port}${route}`, options);
}

async function readServiceJson(dataDir) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, "service.json"), "utf8"));
    if (!value || !Number.isInteger(value.port) || typeof value.instanceId !== "string") return undefined;
    return value;
  } catch { return undefined; }
}

async function healthy(info, request) {
  if (!info) return false;
  try {
    const response = await request(info, "/health", { timeoutMs: 500 });
    return response.status === 200 && response.value?.instanceId === info.instanceId;
  } catch { return false; }
}

async function pluginVersion() {
  try {
    const file = fileURLToPath(new URL("../../.codex-plugin/plugin.json", import.meta.url));
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return typeof value.version === "string" ? value.version : undefined;
  } catch { return undefined; }
}

/** The command line of a running process, or "" when it cannot be read. */
export function processCommandLine(pid, { platform = process.platform, exec = execFileSync } = {}) {
  try {
    if (platform === "win32") {
      // No `ps` on Windows: ask WMI for the command line (rare path only).
      return String(exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: "utf8", timeout: 5000, windowsHide: true }) || "");
    }
    return String(exec("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2000 }) || "");
  } catch {
    return "";
  }
}

/** True only if pid is alive and its command line is this plugin's service. */
export function isOurServiceProcess(pid, options) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  const command = processCommandLine(pid, options);
  // Cannot verify → never signal it.
  return /server[\\/]service\.mjs/.test(command);
}

async function retireUnresponsive(info) {
  if (!isOurServiceProcess(info?.pid)) return;
  try { process.kill(info.pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + 2000;
  while (Date.now() <= deadline) {
    try { process.kill(info.pid, 0); } catch { return; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  try { process.kill(info.pid, "SIGKILL"); } catch { /* gone */ }
}

export async function ensureService(dataDirOrOptions, maybeOptions = {}) {
  const options = typeof dataDirOrOptions === "string"
    ? { ...maybeOptions, dataDir: dataDirOrOptions }
    : { ...(dataDirOrOptions || {}) };
  const dataDir = options.dataDir || await resolveDataDir({ pluginId: options.pluginId, env: options.env });
  const request = options.request || serviceRequest;
  const expectedVersion = options.version || await pluginVersion();
  let info = await readServiceJson(dataDir);
  if (await healthy(info, request)) {
    if (!expectedVersion || info.version === expectedVersion) return { ok: true, ...info, dataDir };
    try {
      const secret = await readSecret(dataDir);
      await request(info, "/internal/shutdown", {
        method: "POST", headers: { Authorization: `Bearer ${secret}` }, timeoutMs: 1000,
      });
      const deadline = Date.now() + (options.shutdownTimeoutMs ?? 3000);
      while (Date.now() <= deadline && await healthy(info, request)) {
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
      }
    } catch { /* fall through to signalling the old instance */ }
    // Older instances may lack /internal/shutdown. The pid comes from
    // service.json and was just confirmed by /health to be our service.
    if (await healthy(info, request) && Number.isSafeInteger(info?.pid)) {
      try { process.kill(info.pid, "SIGTERM"); } catch { /* already gone */ }
      const deadline = Date.now() + (options.shutdownTimeoutMs ?? 3000);
      while (Date.now() <= deadline && await healthy(info, request)) {
        await new Promise((resolve) => setTimeout(resolve, options.pollMs ?? 50));
      }
      if (await healthy(info, request)) { try { process.kill(info.pid, "SIGKILL"); } catch { /* gone */ } }
    }
    info = undefined;
  } else if (info?.pid) {
    // service.json names a process that no longer serves (e.g. stuck after
    // closing its listener): it would keep the service lock. Retire it.
    await retireUnresponsive(info);
  }

  const nodePath = options.nodePath || options.env?.CODEX_MCP_NODE_PATH || process.execPath;
  const servicePath = options.servicePath || fileURLToPath(new URL("../service.mjs", import.meta.url));
  const spawn = options.spawn || defaultSpawn;
  const child = spawn(nodePath, [servicePath], {
    windowsHide: true,
    cwd: os.homedir(),
    detached: true,
    stdio: "ignore",
    env: { ...process.env, ...(options.env || {}), CN_DATA_DIR: dataDir, ...(expectedVersion ? { CN_SERVICE_VERSION: expectedVersion } : {}) },
  });
  child.unref?.();

  const timeoutMs = options.pollTimeoutMs ?? 3000;
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    info = await readServiceJson(dataDir);
    if ((!expectedVersion || info?.version === expectedVersion) && await healthy(info, request)) return { ok: true, ...info, dataDir };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error("SERVICE_START_TIMEOUT");
}

export async function readSecret(dataDir) {
  const value = (await fs.readFile(path.join(dataDir, "secret"), "utf8")).trim();
  if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("SECRET_INVALID");
  return value;
}

export function sameSecret(left, right) {
  const a = secretBytes(left);
  const b = secretBytes(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function postHookSeen(info, secret, threadId, event) {
  return serviceRequest(info, "/internal/hook-seen", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    body: { threadId, event },
  });
}
