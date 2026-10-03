import { constants, promises as fs } from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { isValidSessionId } from "./structured-item.js";

const DEFAULT_TIMEOUT_MS = 15_000;
// Where ChatGPT ships its codex, by app version (newest layout first).
const BUNDLED_RELATIVE = ["codex-cli/bin/codex", "codex"];
const DEFAULT_RESOURCES = "/Applications/ChatGPT.app/Contents/Resources";

// The plugin runs on the Node.js shipped inside ChatGPT.app
// (Resources/cua_node/bin/node), so that app's Resources directory is the
// first place to look; /Applications is the fallback.
function bundledCandidates(execPath = process.execPath) {
  const roots = [];
  const marker = `${path.sep}Contents${path.sep}Resources${path.sep}`;
  const at = execPath.indexOf(marker);
  if (at >= 0) roots.push(execPath.slice(0, at + marker.length - 1));
  roots.push(DEFAULT_RESOURCES);
  return [...new Set(roots)].flatMap((root) => BUNDLED_RELATIVE.map((relative) => path.join(root, relative)));
}

async function executable(file) {
  try {
    await fs.access(file, constants.X_OK);
    return true;
  } catch { return false; }
}

async function findOnPath(command, env = process.env, platform = process.platform) {
  const parts = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  // On Windows only a real .exe can be spawned without a shell; npm puts an
  // extensionless sh shim named `codex` on PATH that must not be picked.
  const names = platform === "win32" ? [`${command}.exe`] : [command];
  for (const directory of parts) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (await executable(candidate)) return candidate;
    }
  }
  return undefined;
}

// On Windows the desktop app copies its runtime (codex.exe, node.exe) under
// %LOCALAPPDATA%\OpenAI\Codex (bin\, runtimes\<component>\<hash>\…); the
// hash changes with app versions, so search it (newest first, shallow).
export async function windowsRuntimeExecutables(name, env = process.env) {
  const root = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "OpenAI", "Codex") : null;
  if (!root) return [];
  const found = [];
  async function walk(directory, depth) {
    let entries;
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === name) {
        try { found.push({ full, mtime: (await fs.stat(full)).mtimeMs }); } catch { /* vanished */ }
      } else if (entry.isDirectory() && depth < 5) await walk(full, depth + 1);
    }
  }
  await walk(root, 0);
  return found.sort((left, right) => right.mtime - left.mtime).map((entry) => entry.full);
}

export { bundledCandidates, findOnPath };

export async function resolveCodexBinary({ env = process.env } = {}) {
  if (env.CN_CODEX_BIN) return env.CN_CODEX_BIN;
  if (env.CODEX_CLI_PATH && await executable(env.CODEX_CLI_PATH)) return env.CODEX_CLI_PATH;
  // Prefer the codex bundled with the desktop app: it matches the app that
  // writes the threads, while a codex on PATH may be older or newer.
  if (process.platform === "darwin") {
    for (const candidate of bundledCandidates()) if (await executable(candidate)) return candidate;
  }
  if (process.platform === "win32") {
    const [runtime] = await windowsRuntimeExecutables("codex.exe", env);
    if (runtime) return runtime;
  }
  const onPath = await findOnPath("codex", env);
  if (onPath) return onPath;
  throw new Error("CODEX_BINARY_UNAVAILABLE");
}

function normalizeThread(thread, fallbackId) {
  const value = thread?.thread ?? thread ?? {};
  return {
    id: value.id ?? value.threadId ?? fallbackId,
    cwd: value.cwd,
    name: value.name,
    preview: value.preview,
    originator: value.originator,
    forkedFromId: value.forkedFromId ?? value.forked_from_id ?? value.parentThreadId,
    ...((value.createdAt ?? value.created_at) === undefined ? {} : { createdAt: value.createdAt ?? value.created_at }),
    ...((value.threadSource ?? value.thread_source) === undefined ? {} : { threadSource: value.threadSource ?? value.thread_source }),
    ...((value.agentRole ?? value.agent_role) === undefined ? {} : { agentRole: value.agentRole ?? value.agent_role }),
  };
}

export class AppServerClient {
  constructor({
    env = process.env,
    spawn = defaultSpawn,
    binary,
    requestTimeoutMs = DEFAULT_TIMEOUT_MS,
    clientInfo = { name: "collaborative-notes", version: "0.8.8" },
  } = {}) {
    this.env = env;
    this.spawn = spawn;
    this.binary = binary;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientInfo = clientInfo;
    this.child = null;
    this.startPromise = null;
    this.nextId = 1;
    this.pending = new Map();
  }

  async start() {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const binary = this.binary ?? await resolveCodexBinary({ env: this.env });
      // A plugin upgrade deletes the install directory this process may have
      // started in; codex app-server exits at once in a deleted cwd.
      const child = this.spawn(binary, ["app-server"], {
        windowsHide: true,
        cwd: os.homedir(),
        env: this.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      const fail = (error) => {
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        if (this.child === child) this.child = null;
      };
      child.on("error", fail);
      child.on("exit", (code, signal) => fail(new Error(`APP_SERVER_EXITED:${code ?? signal ?? "unknown"}`)));
      const input = readline.createInterface({ input: child.stdout });
      input.on("line", (line) => this.#handleLine(line));
      await this.request("initialize", { clientInfo: this.clientInfo }, { skipStart: true });
      this.#send({ jsonrpc: "2.0", method: "initialized", params: {} });
    })();
    try { await this.startPromise; } finally { this.startPromise = null; }
  }

  #send(message) {
    if (!this.child?.stdin?.writable) throw new Error("APP_SERVER_UNAVAILABLE");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined || message.id === null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || "APP_SERVER_ERROR");
      error.code = message.error.code || "APP_SERVER_ERROR";
      error.data = message.error.data;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  async request(method, params = {}, { skipStart = false } = {}) {
    if (!skipStart) await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error("APP_SERVER_TIMEOUT");
        error.code = "APP_SERVER_TIMEOUT";
        reject(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.#send({ jsonrpc: "2.0", id, method, params }); } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async readThread(id) {
    if (!isValidSessionId(id)) throw new Error("THREAD_UNAVAILABLE");
    return normalizeThread(await this.request("thread/read", { threadId: id }), id);
  }

  async listItems(threadId, opts = {}) {
    return this.request("thread/items/list", { threadId, ...opts });
  }

  async listTurns(threadId, opts = {}) {
    return this.request("thread/turns/list", { threadId, ...opts });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("APP_SERVER_CLOSED"));
    }
    this.pending.clear();
    this.child?.kill();
    this.child = null;
  }
}

const defaultClient = new AppServerClient();
const contextCaches = new WeakMap();

export function createThreadContextResolver(appserver = defaultClient, { ttlMs = 15_000 } = {}) {
  const cache = new Map();
  return async function resolveThreadContext(threadId) {
    if (!isValidSessionId(threadId)) return { ok: false, code: "THREAD_UNAVAILABLE" };
    const cached = cache.get(threadId);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
      const thread = await appserver.readThread(threadId);
      if (typeof thread?.cwd !== "string" || !path.isAbsolute(thread.cwd)) {
        return { ok: false, code: "THREAD_UNAVAILABLE" };
      }
      const projectPath = await fs.realpath(thread.cwd);
      const value = {
        holder: threadId,
        projectPath,
        title: thread.name || null,
      };
      // The host names a thread only after its first turn: keep an unnamed
      // context briefly so the panel header picks up the title soon.
      cache.set(threadId, { expiresAt: Date.now() + (value?.title ? ttlMs : Math.min(ttlMs, 5_000)), value });
      return value;
    } catch {
      return { ok: false, code: "THREAD_UNAVAILABLE" };
    }
  };
}

export const threadContext = createThreadContextResolver(defaultClient);
export const getDefaultAppServer = () => defaultClient;
export const createAppServer = (options) => new AppServerClient(options);
