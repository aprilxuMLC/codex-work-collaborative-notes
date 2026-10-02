import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { getItemKey, parseLaneBody } from "./lib/structured-item.js";
import { promises as fs } from "node:fs";
import { spawn as defaultSpawn } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveDataDir } from "./lib/datadir.js";
import { createThreadContextResolver, getDefaultAppServer } from "./lib/appserver.js";
import { detectLocale } from "./lib/locale.js";
import { acquireLock, releaseLock, readLane, versionForBytes, writeLane } from "./lib/lane-store.js";
import { LANE_KEYS, isLaneKey, resolveLanes, sanitizeLaneConfig } from "./lib/lanes.js";
import { filterEligibleBody, rekeyCarriedBody, mergeCarryBodies, carryMarker } from "./lib/carry.js";
import { renderReferenceText, resolveReferenceTargets } from "./lib/reference-binding.js";
import { createPanelLauncher } from "./hook.mjs";
import { getSetupState } from "./lib/binding.js";
import {
  createNote,
  createSourcedNote,
  deleteNote,
  editNote,
  readNotes,
} from "./lib/notes-ops.js";
import { isValidItemKey, isValidSessionId } from "./lib/structured-item.js";
import { panelToken, panelUrl, sameSecret } from "./lib/service-client.js";
import {
  compactTurn,
  compactNavigatorTurn,
  listMirrorTurns,
  listSourceItems,
  MirrorHistoryCache,
  searchMirrorTurns,
  visibleSourceText,
} from "./lib/thread-mirror.js";

const PANEL_FILE = fileURLToPath(new URL("./panel/index.html", import.meta.url));
const PANEL_ASSETS = Object.freeze({
  "index.html": { file: PANEL_FILE, type: "text/html; charset=utf-8" },
  "app.js": { file: fileURLToPath(new URL("./panel/app.js", import.meta.url)), type: "application/javascript; charset=utf-8" },
  "i18n.js": { file: fileURLToPath(new URL("./panel/i18n.js", import.meta.url)), type: "application/javascript; charset=utf-8" },
  "render.js": { file: fileURLToPath(new URL("./panel/render.js", import.meta.url)), type: "application/javascript; charset=utf-8" },
  "style.css": { file: fileURLToPath(new URL("./panel/style.css", import.meta.url)), type: "text/css; charset=utf-8" },
});
const MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_IDLE_MS = 12 * 60 * 60 * 1000;
const PLUGIN_VERSION = "0.7.1";
const MAX_REFERENCE_CHARS = 8000;
const REFERENCE_COPY_TTL_MS = 24 * 60 * 60 * 1000;

function expiredCopy(at, now = Date.now()) {
  const time = Date.parse(at);
  return !Number.isFinite(time) || now - time > REFERENCE_COPY_TTL_MS;
}

function freshCopies(consumed) {
  return Object.fromEntries(Object.entries(consumed).filter(([, value]) => !expiredCopy(value?.at)));
}
const ATTACHMENT_TIMEOUT_MS = 10_000;
const FORK_SCAN_INTERVAL_MS = 3_000;
const FORK_LOOKBACK_MS = 2 * 60 * 1000;
const FORK_RECENT_MS = 10 * 60 * 1000;
const MAX_PROCESSED_FORK_FILES = 500;
const MAX_OPENED_FORKS = 200;

const failure = (code, extra = {}) => ({ ok: false, code, ...extra });
const missing = (error) => error?.code === "ENOENT";

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch (error) {
    if (missing(error)) return fallback;
    throw error;
  }
}

async function writeJsonAtomic(file, value, mode = 0o600) {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const existing = await fs.lstat(file).catch((error) => missing(error) ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) throw new Error("SYMLINK_REFUSED");
    await fs.rename(temporary, file);
    await fs.chmod(file, mode);
  } finally {
    try { await handle?.close(); } catch { /* best effort */ }
    try { await fs.unlink(temporary); } catch { /* best effort */ }
  }
}

async function writePartialCarryMarker(file, parentThreadId, lanes, choice, selectedLanes) {
  await writeJsonAtomic(file, carryMarker(parentThreadId, lanes, "partial", { choice, selectedLanes }));
}

async function ensureSecret(dataDir) {
  const file = path.join(dataDir, "secret");
  try {
    const value = (await fs.readFile(file, "utf8")).trim();
    if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("SECRET_INVALID");
    return value;
  } catch (error) {
    if (!missing(error)) throw error;
    const value = randomBytes(32).toString("hex");
    let handle;
    try {
      handle = await fs.open(file, "wx", 0o600);
      await handle.writeFile(`${value}\n`, "utf8");
      await handle.sync();
      return value;
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      const existing = (await fs.readFile(file, "utf8")).trim();
      if (!/^[0-9a-f]{64}$/i.test(existing)) throw new Error("SECRET_INVALID");
      return existing;
    } finally { try { await handle?.close(); } catch { /* best effort */ } }
  }
}

async function bodyJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_REQUEST_BYTES) throw Object.assign(new Error("BODY_TOO_LARGE"), { code: "BODY_TOO_LARGE" });
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw Object.assign(new Error("INVALID_JSON"), { code: "INVALID_JSON" }); }
}

function jsonHeaders() {
  return { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
}

function sendJson(response, status, value) {
  const payload = JSON.stringify(value);
  response.writeHead(status, { ...jsonHeaders(), "content-length": Buffer.byteLength(payload) });
  response.end(payload);
}

function sendError(response, code, status = 400) {
  sendJson(response, status, { ok: false, code });
}

function cookieName(threadId) { return `cn_t_${threadId}`; }

function readCookie(request, name) {
  const raw = request.headers.cookie;
  if (typeof raw !== "string") return undefined;
  for (const part of raw.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) {
      try { return decodeURIComponent(part.slice(separator + 1).trim()); } catch { return undefined; }
    }
  }
  return undefined;
}

function panelCookie(threadId, token) {
  // Persistent: the in-app browser restores the tab without its key after an
  // app restart, and a session cookie would be gone by then.
  return `${cookieName(threadId)}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict`;
}

function hasValidPanelCredential(request, secret) {
  if (sameSecret(secret, String(request.headers.authorization || "").replace(/^Bearer\s+/i, ""))) return true;
  const headerThread = request.headers["x-cn-thread"] || request.headers["x-cn-thread-id"];
  if (validThread(headerThread) && tokenEqual(panelToken(secret, headerThread), request.headers["x-cn-token"])) return true;
  const raw = request.headers.cookie;
  if (typeof raw !== "string") return false;
  return raw.split(";").some((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return false;
    const name = part.slice(0, separator).trim();
    const match = name.match(/^cn_t_(.+)$/);
    if (!match || !validThread(match[1])) return false;
    let value;
    try { value = decodeURIComponent(part.slice(separator + 1).trim()); } catch { return false; }
    return tokenEqual(panelToken(secret, match[1]), value);
  });
}

function sendPanelReopen(response, locale = "en") {
  const text = locale === "zh"
    ? "请从 Codex 重新打开便签：在这个对话里对 agent 说「打开便签」，或重启 ChatGPT 后回到这个对话。新的便签页打开后，可以关掉这个标签。"
    : "Reopen Notes from Codex: ask the agent in this conversation to \"open Notes\", or restart ChatGPT and return to this conversation. Once the new Notes tab opens, you can close this one.";
  response.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(`<!doctype html><meta charset="utf-8"><p style="font: 15px system-ui; margin: 24px">${text}</p>`);
}

function errorStatus(code) {
  if (["FORBIDDEN", "ORIGIN_FORBIDDEN", "TOKEN_INVALID"].includes(code)) return 403;
  if (["THREAD_UNAVAILABLE", "CONFIGURED_ROOT_UNAVAILABLE"].includes(code)) return 404;
  if (["STALE", "SETUP_REQUIRED", "ALREADY_INITIALIZED", "LEGACY_ADOPTION_REQUIRED", "NOTES_SOURCE_UNVERIFIED", "CARRY_CONFLICT", "CARRY_STALE", "CARRY_ALREADY_DECIDED", "CARRY_PARTIAL", "CARRY_LOCKED"].includes(code)) return 409;
  if (["NOTES_SOURCE_CONSENT_REQUIRED"].includes(code)) return 403;
  if (["NOTES_SOURCE_UNAVAILABLE"].includes(code)) return 404;
  if (["NOT_FOUND"].includes(code)) return 404;
  if (["BODY_TOO_LARGE"].includes(code)) return 413;
  return 400;
}

function routeThread(pathname, prefix) {
  if (!pathname.startsWith(prefix)) return undefined;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  const encoded = slash < 0 ? rest : rest.slice(0, slash);
  try { return decodeURIComponent(encoded); } catch { return undefined; }
}

function tokenEqual(expected, actual) {
  if (typeof actual !== "string" || !/^[0-9a-f]{64}$/i.test(actual)) return false;
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function validThread(threadId) {
  return isValidSessionId(threadId);
}

function dateDirectory(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return [year, month, day];
}

async function readSessionMeta(fsModule, file) {
  let handle;
  try {
    handle = await fsModule.open(file, "r");
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(65536), 0, 65536, 0);
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    return JSON.parse(firstLine);
  } finally {
    try { await handle?.close(); } catch { /* best effort */ }
  }
}

function boundedCount(value, fallback = 1) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 100 ? number : fallback;
}

/** Human-readable note excerpts for carry previews (never raw storage or keys). */
function noteExcerpts(body) {
  return parseLaneBody(String(body ?? "")).nodes
    .filter((node) => node.type === "item")
    .map((node) => ({
      text: String(node.item.comment || node.item.snapshot || "").replace(/\s+/g, " ").trim().slice(0, 120),
      sourced: node.item.kind === "source-aware",
    }));
}

function itemRecordsForCarry(response) {
  if (Array.isArray(response)) return response;
  if (Array.isArray(response?.items)) return response.items;
  if (Array.isArray(response?.data)) return response.data;
  return [];
}

async function verifySourceCapture(appserver, holderThreadId, snapshot, source) {
  if (typeof snapshot !== "string" || snapshot.length === 0 || !source || typeof source !== "object"
    || !validThread(source.threadId) || typeof source.itemId !== "string" || source.itemId.length === 0) {
    return failure("NOTES_SOURCE_UNVERIFIED");
  }
  try {
    const sourceItems = await listSourceItems(appserver, source.threadId);
    const item = sourceItems.find((candidate) => candidate.id === source.itemId);
    if (!item || !snapshot || !visibleSourceText(item).includes(snapshot)) return failure("NOTES_SOURCE_UNVERIFIED");
    if (source.threadId !== holderThreadId) {
      const holderItems = await listSourceItems(appserver, holderThreadId);
      if (!holderItems.some((candidate) => candidate.id === source.itemId)) return failure("NOTES_SOURCE_UNVERIFIED");
    }
    return { ok: true };
  } catch { return failure("NOTES_SOURCE_UNVERIFIED"); }
}

function sanitizePrefs(value) {
  const pins = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return { pins };
  const rawPins = value.pins;
  if (!rawPins || typeof rawPins !== "object" || Array.isArray(rawPins)) return { pins };
  for (const lane of LANE_KEYS) {
    if (!rawPins[lane] || typeof rawPins[lane] !== "object" || Array.isArray(rawPins[lane])) continue;
    const lanePins = {};
    for (const [itemKey, pinned] of Object.entries(rawPins[lane])) {
      if (pinned === true && isValidItemKey(itemKey)) lanePins[itemKey] = true;
    }
    if (Object.keys(lanePins).length > 0) pins[lane] = lanePins;
  }
  return { pins };
}

function validateMkdirName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 255
    && !name.includes("/") && !name.includes("\\") && !name.includes("..")
    && !/[\u0000-\u001f\u007f]/.test(name);
}

async function listFolders(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) return failure("PATH_INVALID");
  let stat;
  try { stat = await fs.lstat(directory); } catch { return failure("PATH_UNAVAILABLE"); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("PATH_INVALID");
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return {
    ok: true,
    path: path.resolve(directory),
    parent: path.dirname(path.resolve(directory)),
    entries: entries.filter((entry) => !entry.name.startsWith(".") && entry.isDirectory())
      .map((entry) => ({ name: entry.name, path: path.join(path.resolve(directory), entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

async function mkdirFolder(parent, name) {
  if (!validateMkdirName(name) || typeof parent !== "string" || !path.isAbsolute(parent)) {
    return failure("INVALID_NAME");
  }
  let parentStat;
  try { parentStat = await fs.lstat(parent); } catch { return failure("PATH_UNAVAILABLE"); }
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory()) return failure("PATH_INVALID");
  const target = path.join(parent, name);
  try {
    await fs.mkdir(target, { mode: 0o700 });
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("PATH_INVALID");
    return { ok: true, path: target };
  } catch (error) {
    return failure(error.code === "EEXIST" ? "ALREADY_EXISTS" : "MKDIR_FAILED");
  }
}

async function readHooksSeen(dataDir) {
  const value = await readJson(path.join(dataDir, "hooks-seen.json"), {});
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function hooksTrusted(dataDir) {
  const seen = await readHooksSeen(dataDir);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return Object.values(seen).some((value) => {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  }) ? true : null;
}

async function recordHook(dataDir, threadId, event) {
  if (!validThread(threadId) || !["SessionStart", "UserPromptSubmit"].includes(event)) {
    return failure("INVALID_HOOK");
  }
  const file = path.join(dataDir, "hooks-seen.json");
  const lockPath = `${file}.lock`;
  const locked = await acquireLock(lockPath);
  if (!locked.ok) return locked;
  try {
    const seen = await readHooksSeen(dataDir);
    seen[event] = new Date().toISOString();
    await writeJsonAtomic(file, seen);
    return { ok: true };
  } finally { await releaseLock(lockPath, locked.handle); }
}

export class PanelService {
  constructor({
    dataDir,
    secret,
    appserver,
    threadContext,
    version = PLUGIN_VERSION,
    pluginRoot,
    idleMs = DEFAULT_IDLE_MS,
    locale,
    fsModule = fs,
    lockOptions,
    exitOnClose = false,
    preferredPort,
    carryWriteLane = writeLane,
    writePartialCarryMarker: writePartialCarryMarkerFn = writePartialCarryMarker,
    spawn = defaultSpawn,
    now = Date.now,
    env = process.env,
    opener = env.CN_OPENER || (process.platform === "darwin" ? "open" : "start"),
    openPanel,
  }) {
    this.dataDir = dataDir;
    this.secret = secret;
    this.appserver = appserver || getDefaultAppServer();
    this.threadContext = threadContext || createThreadContextResolver(this.appserver);
    this.version = version;
    this.pluginRoot = pluginRoot || path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    this.idleMs = idleMs;
    this.locale = locale;
    this.fs = fsModule;
    this.lockOptions = lockOptions;
    this.exitOnClose = exitOnClose;
    this.preferredPort = preferredPort;
    this.carryWriteLane = carryWriteLane;
    this.writePartialCarryMarker = writePartialCarryMarkerFn;
    this.spawn = spawn;
    this.now = now;
    this.env = env;
    this.openPanel = openPanel || createPanelLauncher({ spawn, opener });
    this.lastRequestAt = this.now();
    this.server = null;
    this.lock = null;
    this.lockPath = path.join(dataDir, "service.lock");
    this.instanceId = randomBytes(16).toString("hex");
    this.idleTimer = null;
    this.selections = new Map();
    this.consumed = new Map();
    this.panelSeen = new Map();
    this.selectionDir = path.join(this.dataDir, "selections");
    this.selectionLocks = new Map();
    this.mirrorCache = new MirrorHistoryCache(this.appserver, { now: this.now });
    this.forkWatchTimer = null;
    this.forkScanInitialized = false;
    this.forkScanAt = this.now() - FORK_LOOKBACK_MS;
    this.forkScanBusy = false;
    this.processedForkFiles = new Map();
    this.recentForks = new Map();
    this.forkSessionRoot = path.join(this.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
  }

  async context(threadId) {
    if (!validThread(threadId)) return failure("THREAD_UNAVAILABLE");
    const result = await this.threadContext(threadId);
    if (!result || result.ok === false || typeof result.projectPath !== "string") {
      return failure(result?.code || "THREAD_UNAVAILABLE");
    }
    return { ...result, holder: threadId };
  }

  async ctx(threadId) {
    const context = await this.context(threadId);
    return context.ok === false ? context : { dataDir: this.dataDir, holder: threadId, projectPath: context.projectPath };
  }

  async notedItemIds(threadId, context) {
    const notedItemIds = new Set();
    const noteContext = { dataDir: this.dataDir, projectPath: context.projectPath, holder: threadId };
    for (const lane of LANE_KEYS) {
      try {
        const notes = await readNotes(noteContext, lane);
        for (const note of notes.notes || []) {
          if (note.source?.threadId === threadId && typeof note.source.itemId === "string") notedItemIds.add(note.source.itemId);
        }
      } catch { /* An unavailable Notes location does not hide the conversation. */ }
    }
    return notedItemIds;
  }

  async mirrorRecent(threadId, context, limit, cursor) {
    const listed = await listMirrorTurns(this.appserver, threadId, {
      cursor: cursor || undefined,
      limit,
      sortDirection: "desc",
      itemsView: "full",
    });
    const notedItemIds = await this.notedItemIds(threadId, context);
    const cached = this.mirrorCache.peek(threadId);
    return {
      turns: listed.turns.map((turn) => {
        const known = cached?.turns.find((entry) => entry.turnId === turn.turnId);
        return compactNavigatorTurn(turn, {
          ...(known ? { index: known.index } : {}),
          noted: turn.items.some((item) => notedItemIds.has(item.id)),
        });
      }),
      ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
    };
  }

  async carryStatus(threadId, context) {
    const setup = await import("./lib/binding.js").then(({ resolveRoot }) => resolveRoot(this.dataDir, context.projectPath));
    if (!setup.ok) return setup.code === "SETUP_REQUIRED" ? null : setup;
    if (typeof setup.root !== "string") return null;
    let child;
    try { child = await this.appserver.readThread(threadId); } catch { return null; }
    if (!child?.forkedFromId || !validThread(child.forkedFromId)) return null;
    const markerFile = path.join(setup.root, ".carry-over", `${threadId}.json`);
    const existing = await readJson(markerFile, undefined);
    if (existing?.status === "decided") return { ...existing, parentThreadId: existing.parentThreadId || child.forkedFromId };
    const pending = existing && ["unresolved", "partial"].includes(existing.status)
      ? existing
      : { ...carryMarker(child.forkedFromId, Object.fromEntries(LANE_KEYS.map((lane) => [lane, { outcome: "pending", carriedKeys: [] }])), "unresolved"), decidedAt: null };
    return { ...pending, parentThreadId: child.forkedFromId };
  }

  async readOpenedForks() {
    const value = await readJson(path.join(this.dataDir, "fork-opened.json"), {});
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const entries = Object.entries(value).filter(([id, at]) => validThread(id) && typeof at === "string");
    const bounded = entries.sort(([, left], [, right]) => Date.parse(left) - Date.parse(right)).slice(-MAX_OPENED_FORKS);
    const result = Object.fromEntries(bounded);
    if (bounded.length !== entries.length) await this.writeOpenedForks(result);
    return result;
  }

  async writeOpenedForks(opened) {
    const entries = Object.entries(opened)
      .sort(([, left], [, right]) => Date.parse(left) - Date.parse(right))
      .slice(-MAX_OPENED_FORKS);
    await writeJsonAtomic(path.join(this.dataDir, "fork-opened.json"), Object.fromEntries(entries));
  }

  async sessionFiles() {
    const today = new Date(this.now());
    const dates = [today, new Date(today.getTime() - 24 * 60 * 60 * 1000)];
    const files = [];
    for (const date of dates) {
      const directory = path.join(this.forkSessionRoot, ...dateDirectory(date));
      let entries;
      try { entries = await this.fs.readdir(directory, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
        files.push(path.join(directory, entry.name));
      }
    }
    return files;
  }

  rememberProcessedForkFile(file, timestamp) {
    this.processedForkFiles.delete(file);
    this.processedForkFiles.set(file, timestamp);
    while (this.processedForkFiles.size > MAX_PROCESSED_FORK_FILES) {
      this.processedForkFiles.delete(this.processedForkFiles.keys().next().value);
    }
  }

  rememberRecentFork(parentId, child, seenAt) {
    const current = this.recentForks.get(parentId) || [];
    const next = current.filter((entry) => entry.childId !== child.id);
    next.push({
      childId: child.id,
      title: typeof child.name === "string" && child.name ? child.name : null,
      createdAt: child.createdAt || new Date(seenAt).toISOString(),
      seenAt,
    });
    this.recentForks.set(parentId, next);
  }

  pruneRecentForks(now = this.now()) {
    const cutoff = now - FORK_RECENT_MS;
    for (const [parentId, entries] of this.recentForks) {
      const current = entries.filter((entry) => entry.seenAt >= cutoff);
      if (current.length) this.recentForks.set(parentId, current);
      else this.recentForks.delete(parentId);
    }
  }

  async recentForksFor(parentId) {
    this.pruneRecentForks();
    const result = [];
    for (const entry of this.recentForks.get(parentId) || []) {
      try {
        const childContext = await this.threadContext(entry.childId);
        if (!childContext || childContext.ok === false) continue;
        const carry = await this.carryStatus(entry.childId, childContext);
        if (carry?.status !== "unresolved") continue;
        result.push({ childId: entry.childId, title: entry.title });
      } catch { /* fork discovery is advisory */ }
    }
    return result;
  }

  async inspectFork(file, fileTimestamp, opened) {
    const metadata = await readSessionMeta(this.fs, file);
    const payload = metadata?.payload;
    const parentId = payload?.forked_from_id;
    if (!validThread(parentId)) return false;
    const fallbackChildId = path.basename(file, ".jsonl");
    const childId = payload?.id || payload?.session_id || fallbackChildId;
    if (!validThread(childId)) return false;
    const child = await this.appserver.readThread(childId);
    if (child?.forkedFromId !== parentId) return false;
    if (!/desktop/i.test(String(child.originator || ""))) return false;
    if (child.threadSource !== undefined && child.threadSource !== "user") return false;
    if (child.agentRole) return false;
    const childContext = await this.threadContext(childId);
    if (!childContext || childContext.ok === false || typeof childContext.projectPath !== "string") return false;
    const setupState = await getSetupState(this.dataDir, childContext.projectPath);
    if (setupState.state !== "INITIALIZED") return false;
    const carry = await this.carryStatus(childId, childContext);
    if (carry?.status !== "unresolved") return false;
    this.rememberRecentFork(parentId, child, this.now());

    const parentContext = await this.threadContext(parentId);
    if (!parentContext || parentContext.ok === false || typeof parentContext.projectPath !== "string") return false;
    let hasParentNotes = false;
    for (const lane of LANE_KEYS) {
      try {
        const notes = await readNotes({ dataDir: this.dataDir, projectPath: parentContext.projectPath, holder: parentId }, lane);
        if (notes.ok !== false && (notes.notes || []).length > 0) {
          hasParentNotes = true;
          break;
        }
      } catch { /* an unavailable lane has no evidence of a note */ }
    }
    if (!hasParentNotes || opened[childId] || this.openedForkThisScan) return false;
    opened[childId] = new Date(this.now()).toISOString();
    await this.writeOpenedForks(opened);
    this.openedForkThisScan = true;
    await this.openPanel(panelUrl({ port: this.server.address().port }, childId, this.secret));
    return true;
  }

  async scanForks() {
    if (this.env.CN_FORK_WATCH === "0" || this.forkScanBusy) return;
    this.forkScanBusy = true;
    const scanAt = this.now();
    const since = this.forkScanInitialized ? this.forkScanAt : scanAt - FORK_LOOKBACK_MS;
    this.forkScanInitialized = true;
    this.forkScanAt = scanAt;
    this.openedForkThisScan = false;
    try {
      const opened = await this.readOpenedForks();
      for (const file of await this.sessionFiles()) {
        let stat;
        try { stat = await this.fs.stat(file); } catch { continue; }
        // A fork is a newly created session file: use its creation time, so an
        // active conversation's appends never cause it to be re-read.
        const fileTimestamp = Number(stat.birthtimeMs) > 0 ? Number(stat.birthtimeMs) : Number(stat.mtimeMs) || 0;
        if (fileTimestamp < since || this.processedForkFiles.has(file)) continue;
        this.rememberProcessedForkFile(file, fileTimestamp);
        try { await this.inspectFork(file, fileTimestamp, opened); } catch { /* watcher errors never affect the service */ }
      }
      this.pruneRecentForks(scanAt);
    } catch { /* watcher errors never affect the service */ }
    finally {
      this.openedForkThisScan = false;
      this.forkScanBusy = false;
    }
  }

  /** Page through every item of a thread (fork eligibility must see the whole history). */
  async listAllItems(threadId) {
    const all = [];
    let cursor;
    for (let page = 0; page < 100_000; page += 1) {
      const response = await this.appserver.listItems(threadId, { sortDirection: "asc", limit: 200, ...(cursor ? { cursor } : {}) });
      all.push(...itemRecordsForCarry(response));
      cursor = response?.nextCursor;
      if (!cursor) return all;
    }
    throw Object.assign(new Error("HISTORY_TOO_LONG"), { code: "CARRY_SOURCE_UNAVAILABLE" });
  }

  async carryPlan(threadId, context, choice, selectedLanes, resolutions = {}, observations = {}) {
    const carry = await this.carryStatus(threadId, context);
    if (carry?.ok === false) return carry;
    if (!carry || !["unresolved", "partial"].includes(carry.status)) return failure("CARRY_ALREADY_DECIDED");
    const parentThreadId = carry.parentThreadId;
    let childItems;
    try { childItems = await this.listAllItems(threadId); }
    catch { return failure("CARRY_SOURCE_UNAVAILABLE"); }
    const childIds = new Set(itemRecordsForCarry(childItems).map((record) => record?.item?.id ?? record?.id).filter((id) => typeof id === "string"));
    let parentItems = [];
    try { parentItems = await this.listAllItems(parentThreadId); } catch { return failure("CARRY_SOURCE_UNAVAILABLE"); }
    const parentIds = new Set(itemRecordsForCarry(parentItems).map((record) => record?.item?.id ?? record?.id).filter((id) => typeof id === "string"));
    const parentContext = await this.threadContext(parentThreadId);
    if (!parentContext || parentContext.ok === false) return failure("CARRY_SOURCE_UNAVAILABLE");
    const parentCtx = { dataDir: this.dataDir, projectPath: parentContext.projectPath, holder: parentThreadId };
    const childCtx = { dataDir: this.dataDir, projectPath: context.projectPath, holder: threadId };
    const parentRoot = await import("./lib/binding.js").then(({ resolveRoot }) => resolveRoot(this.dataDir, parentContext.projectPath));
    const childRoot = await import("./lib/binding.js").then(({ resolveRoot }) => resolveRoot(this.dataDir, context.projectPath));
    if (!parentRoot.ok || !childRoot.ok) return failure("SETUP_REQUIRED");
    const lanes = Array.isArray(selectedLanes) ? selectedLanes.filter(isLaneKey) : LANE_KEYS;
    const plan = [];
    for (const lane of lanes) {
      const parent = await readNotes(parentCtx, lane);
      const child = await readNotes(childCtx, lane);
      if (parent.ok === false || child.ok === false) return failure("CARRY_SOURCE_UNAVAILABLE");
      const parentLaneResult = await import("./lib/lane-store.js").then(({ readLane }) => readLane(parentRoot.root, lane, parentThreadId));
      const childLaneResult = await import("./lib/lane-store.js").then(({ readLane }) => readLane(childRoot.root, lane, threadId));
      const parentLane = parentLaneResult.ok === false && parentRoot.pendingDefault
        ? { ok: true, status: "absent", version: "0", body: "" }
        : parentLaneResult;
      const childLane = childLaneResult.ok === false && childRoot.pendingDefault
        ? { ok: true, status: "absent", version: "0", body: "" }
        : childLaneResult;
      if (parentLane.ok === false || childLane.ok === false) return failure("CARRY_SOURCE_UNAVAILABLE");
      const eligible = filterEligibleBody(parentLane.body, { parentThreadId, childItemIds: childIds, parentItemIds: parentIds });
      // Committed is derived from data as in DSH: the marker records each lane's
      // planned child-local keys before the lane is written, so a lane already
      // holding any of them was written even if the later marker update failed.
      const plannedKeys = Array.isArray(carry.lanes?.[lane]?.plannedKeys) ? carry.lanes[lane].plannedKeys : [];
      const childKeys = new Set(parseLaneBody(childLane.body).nodes
        .filter((node) => node.type === "item" && node.item)
        .map((node) => getItemKey(node.item))
        .filter(Boolean));
      // Content without item keys (older formats) is recognised by the planned
      // lane version instead.
      const plannedVersion = carry.lanes?.[lane]?.plannedVersion;
      const writtenBefore = (plannedKeys.length > 0 && plannedKeys.some((key) => childKeys.has(key)))
        || (typeof plannedVersion === "string" && childLane.version === plannedVersion);
      const previouslyCommitted = carry.lanes?.[lane]?.committed === true || writtenBefore;
      const choiceForLane = previouslyCommitted ? "committed" : choice === "none" ? "keep" : (resolutions[lane] || (childLane.body.trim() ? undefined : "copy"));
      const skipped = noteExcerpts(parentLane.body).length - noteExcerpts(eligible).length;
      if (childLane.body.trim() && !choiceForLane) {
        plan.push({ lane, parent: eligible, current: childLane.body, parentVersion: parentLane.version, currentVersion: childLane.version, conflict: true, skipped, committed: previouslyCommitted });
      } else {
        plan.push({ lane, parent: eligible, current: childLane.body, parentVersion: parentLane.version, currentVersion: childLane.version, choice: choiceForLane, skipped, committed: previouslyCommitted });
      }
    }
    if (plan.some((entry) => entry.conflict)) {
      return { ok: false, code: "CARRY_CONFLICT", choice, lanes, conflicts: plan.filter((entry) => entry.conflict).map(({ lane, parent, current }) => ({ lane, parentNotes: noteExcerpts(parent), currentNotes: noteExcerpts(current) })), observations: Object.fromEntries(plan.map((entry) => [entry.lane, { parentVersion: entry.parentVersion, currentVersion: entry.currentVersion }])) };
    }
    for (const entry of plan) {
      const observed = observations?.[entry.lane];
      if (observed && (observed.parentVersion !== entry.parentVersion || observed.currentVersion !== entry.currentVersion)) {
        return failure("CARRY_STALE", { observations: Object.fromEntries(plan.map((item) => [item.lane, { parentVersion: item.parentVersion, currentVersion: item.currentVersion }])) });
      }
    }
    return { ok: true, plan, parentThreadId, childRoot: childRoot.root };
  }

  /** Selections persist on disk so a service restart or an unreachable
   * service never silently drops what the user ticked (the hook reads the
   * same file when the service cannot be reached). */
  async loadSelection(threadId) {
    if (this.selections.has(threadId)) return this.selections.get(threadId);
    const stored = await readJson(path.join(this.selectionDir, `${threadId}.json`), undefined);
    const consumed = {};
    if (stored?.consumed && typeof stored.consumed === "object" && !Array.isArray(stored.consumed)) {
      for (const [turnId, value] of Object.entries(stored.consumed).slice(-20)) {
        // Copies of attached note text exist only to answer a retry of the
        // same turn; they are not kept beyond a day.
        if (typeof turnId === "string" && typeof value?.text === "string" && !expiredCopy(value.at)) {
          consumed[turnId] = { text: value.text, count: value.count, generation: value.generation, at: value.at };
        }
      }
    }
    let lastBinding = stored?.lastBinding || null;
    if (lastBinding && typeof lastBinding.text === "string" && expiredCopy(lastBinding.at)) {
      const { text: _expired, ...rest } = lastBinding;
      lastBinding = rest;
    }
    const value = stored && Array.isArray(stored.targets)
      ? { targets: stored.targets, generation: Number(stored.generation) || 0, lastBinding, consumed }
      : { targets: [], generation: 0, lastBinding: null, consumed };
    this.selections.set(threadId, value);
    const pruned = stored && ((stored.lastBinding?.text !== undefined && value.lastBinding?.text === undefined)
      || Object.keys(stored.consumed || {}).length !== Object.keys(consumed).length);
    if (pruned) await this.saveSelection(threadId, value).catch(() => {});
    return value;
  }

  async saveSelection(threadId, value) {
    const previous = this.selections.get(threadId);
    const next = {
      ...value,
      consumed: freshCopies(value?.consumed || previous?.consumed || {}),
    };
    if (next.lastBinding && typeof next.lastBinding.text === "string" && expiredCopy(next.lastBinding.at)) {
      const { text: _expired, ...rest } = next.lastBinding;
      next.lastBinding = rest;
    }
    this.selections.set(threadId, next);
    await fs.mkdir(this.selectionDir, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path.join(this.selectionDir, `${threadId}.json`), next);
  }

  async withSelectionLock(threadId, operation) {
    const previous = this.selectionLocks.get(threadId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const chain = previous.then(() => current);
    this.selectionLocks.set(threadId, chain);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.selectionLocks.get(threadId) === chain) this.selectionLocks.delete(threadId);
    }
  }

  async turnExists(threadId, turnId) {
    if (!turnId || typeof this.appserver?.listTurns !== "function") return false;
    try {
      const listed = await this.appserver.listTurns(threadId, { itemsView: "notLoaded", sortDirection: "desc", limit: 20 });
      const turns = Array.isArray(listed) ? listed : listed?.turns || listed?.data || [];
      return turns.some((turn) => (turn?.id || turn?.turnId) === turnId);
    } catch { return false; }
  }

  async refreshAttachment(threadId, selection) {
    const binding = selection.lastBinding;
    if (!binding?.prepared || binding.attached || !binding.turnId) return selection;
    if (await this.turnExists(threadId, binding.turnId)) {
      const attached = { ...binding, attached: true, prepared: false, attachedAt: new Date().toISOString() };
      await this.saveSelection(threadId, { ...selection, lastBinding: attached });
      return { ...selection, lastBinding: attached };
    }
    if (Date.now() - Date.parse(binding.at || 0) < ATTACHMENT_TIMEOUT_MS) return selection;
    const restored = {
      targets: binding.preparedTargets || [],
      generation: selection.generation,
      lastBinding: { ok: false, selected: true, generation: selection.generation, turnId: binding.turnId, failures: [{ code: "REFERENCE_UNCONFIRMED" }], reason: binding.locale === "zh" ? "上一条消息未出现；选择已恢复" : "The last message did not appear; the selection was restored" },
    };
    await this.saveSelection(threadId, restored);
    return restored;
  }

  rememberConsumed(threadId, turnId, value) {
    if (!turnId || typeof value?.text !== "string") return;
    let entries = this.consumed.get(threadId);
    if (!entries) {
      entries = new Map();
      this.consumed.set(threadId, entries);
    }
    entries.set(turnId, { text: value.text, count: value.count, generation: value.generation, at: value.at });
    while (entries.size > 20) entries.delete(entries.keys().next().value);
  }

  consumedResult(threadId, turnId, selection) {
    if (!turnId) return undefined;
    const value = this.consumed.get(threadId)?.get(turnId) || selection?.consumed?.[turnId]
      || (selection?.lastBinding?.turnId === turnId && typeof selection.lastBinding.text === "string" ? selection.lastBinding : undefined);
    return value ? { ok: true, selected: true, prepared: false, attached: true, ...value } : undefined;
  }

  async consumeReference(threadId, turnId, requestedLocale) {
    if (!validThread(threadId)) return failure("THREAD_UNAVAILABLE");
    return this.withSelectionLock(threadId, async () => {
      const selection = await this.loadSelection(threadId);
      const replay = this.consumedResult(threadId, turnId, selection);
      if (replay) return replay;
      const pending = selection.lastBinding;
      if (pending?.prepared && pending.turnId && pending.turnId !== turnId) {
        if (await this.turnExists(threadId, pending.turnId)) {
          const attached = { ...pending, attached: true, prepared: false, attachedAt: new Date().toISOString() };
          await this.saveSelection(threadId, { ...selection, lastBinding: attached });
        } else {
          const restored = [...selection.targets, ...(pending.preparedTargets || [])]
            .filter((target) => isLaneKey(target?.lane) && isValidItemKey(target?.itemKey))
            .filter((target, index, all) => all.findIndex((candidate) => candidate.lane === target.lane && candidate.itemKey === target.itemKey) === index);
          selection.targets = restored;
          selection.lastBinding = null;
          await this.saveSelection(threadId, selection);
        }
      }
    if (!selection || selection.targets.length === 0) return { ok: true, selected: false };
    const zh = String(requestedLocale || "").toLowerCase().startsWith("zh");
    if (!turnId) return { ok: false, selected: true, generation: selection.generation, failures: [{ code: "REFERENCE_UNCONFIRMED" }], reason: zh ? "无法确认发送轮次；选择已保留" : "The message turn could not be identified; the selection was kept" };
    const context = await this.context(threadId);
    if (context.ok === false) return failure("REFERENCE_UNAVAILABLE", { selected: true, reason: zh ? "便签选择仍保留，但当前对话不可用" : "The selected notes were kept because the thread is unavailable" });
    const ctx = { dataDir: this.dataDir, projectPath: context.projectPath, holder: threadId };
    const laneBodies = {};
    for (const lane of new Set(selection.targets.map((target) => target.lane))) {
      const data = await readNotes(ctx, lane);
      if (data.ok === false) {
        const failureRecord = { ok: false, selected: true, generation: selection.generation, failures: [{ lane, code: data.code }], reason: zh ? "无法读取所选便签；选择已保留" : "The selected notes could not be read; the selection was kept" };
        selection.lastBinding = { ...failureRecord, turnId, at: new Date().toISOString() };
        await this.saveSelection(threadId, selection);
        return failureRecord;
      }
      laneBodies[lane] = data.notes || [];
    }
    const resolved = resolveReferenceTargets(laneBodies, selection.targets);
    if (!resolved.ok) {
      const failureRecord = { ok: false, selected: true, generation: selection.generation, failures: resolved.failures, reason: zh ? "所选便签已变化；选择已保留" : "A selected note is missing or no longer addressable; the selection was kept" };
      selection.lastBinding = { ...failureRecord, turnId, at: new Date().toISOString() };
      await this.saveSelection(threadId, selection);
      return failureRecord;
    }
    const config = await readJson(path.join(this.dataDir, "config.json"), { displayOrder: [], laneOverrides: {} });
    const locale = zh ? "zh" : "en";
    const labels = Object.fromEntries(resolveLanes(config, locale).map((lane) => [lane.key, lane.label]));
    const rendered = renderReferenceText(resolved.notes, labels);
    if (!rendered.ok) return failure("REFERENCE_FAILED");
    if (rendered.text.length > MAX_REFERENCE_CHARS) {
      return { ok: false, selected: true, generation: selection.generation, failures: [{ code: "REFERENCE_TOO_LARGE" }], reason: zh ? "所选便签引用过长；选择已保留" : "The selected notes are too large to attach; the selection was kept" };
    }
    const current = await this.loadSelection(threadId);
    if (current.generation !== selection.generation || JSON.stringify(current.targets) !== JSON.stringify(selection.targets)) {
      return { ok: false, selected: true, generation: current.generation, failures: [{ code: "REFERENCE_SELECTION_CHANGED" }], reason: zh ? "选择已变化；选择已保留" : "The selection changed while it was being prepared; it was kept" };
    }
    const attached = await this.turnExists(threadId, turnId);
    const binding = { ok: true, selected: true, prepared: !attached, attached, generation: selection.generation, turnId: turnId || null, count: resolved.notes.length, at: new Date().toISOString(), locale, text: rendered.text, ...(attached ? {} : { preparedTargets: selection.targets }) };
    selection.lastBinding = binding;
    selection.targets = [];
    selection.consumed = { ...(selection.consumed || {}), [turnId]: { text: binding.text, count: binding.count, generation: binding.generation, at: binding.at } };
    while (Object.keys(selection.consumed).length > 20) delete selection.consumed[Object.keys(selection.consumed)[0]];
    await this.saveSelection(threadId, selection);
    this.rememberConsumed(threadId, turnId, binding);
    return { ...binding, text: rendered.text };
    });
  }

  async request(req, res) {
    this.lastRequestAt = this.now();
    const url = new URL(req.url, `http://127.0.0.1:${this.server.address().port}`);
    const origin = req.headers.origin;
    const expectedOrigin = `http://127.0.0.1:${this.server.address().port}`;
    if (origin !== undefined && origin !== expectedOrigin) return sendError(res, "ORIGIN_FORBIDDEN", 403);

    if (url.pathname === "/health" && req.method === "GET") {
      return sendJson(res, 200, { instanceId: this.instanceId, version: this.version, pluginRoot: this.pluginRoot });
    }

    if (url.pathname.startsWith("/internal/")) {
      if (!sameSecret(this.secret, String(req.headers.authorization || "").replace(/^Bearer\s+/, ""))) {
        return sendError(res, "FORBIDDEN", 403);
      }
      if (url.pathname === "/internal/panel-seen" && req.method === "GET") {
        const thread = url.searchParams.get("threadId") || "";
        const at = this.panelSeen.get(thread) || 0;
        const requested = Number(url.searchParams.get("withinMs"));
        const withinMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 600_000) : 10_000;
        return sendJson(res, 200, { recent: Date.now() - at < withinMs });
      }
      if (url.pathname === "/internal/hook-seen" && req.method === "POST") {
        try {
          const body = await bodyJson(req);
          const result = await recordHook(this.dataDir, body.threadId, body.event);
          return result.ok ? sendJson(res, 200, result) : sendError(res, result.code, errorStatus(result.code));
        } catch (error) { return sendError(res, error.code || "REQUEST_FAILED", errorStatus(error.code)); }
      }
      if (url.pathname === "/internal/reference/consume" && req.method === "POST") {
        try {
          const body = await bodyJson(req);
          const result = await this.consumeReference(body.threadId, body.turnId, body.locale);
          return sendJson(res, result.ok ? 200 : 409, result);
        } catch (error) { return sendError(res, error.code || "REFERENCE_FAILED", errorStatus(error.code)); }
      }
      if (url.pathname === "/internal/shutdown" && req.method === "POST") {
        sendJson(res, 200, { ok: true });
        setImmediate(() => this.close().catch(() => {}));
        return;
      }
      return sendError(res, "NOT_FOUND", 404);
    }

    const panelThread = routeThread(url.pathname, "/t/");
    if (panelThread !== undefined && validThread(panelThread)) {
      const panelPrefix = `/t/${encodeURIComponent(panelThread)}`;
      const branchPrefix = `${panelPrefix}/branch/`;
      const branchChild = url.pathname.startsWith(branchPrefix) ? routeThread(url.pathname, branchPrefix) : undefined;
      if (req.method === "GET" && branchChild !== undefined && validThread(branchChild)
        && url.pathname === `${branchPrefix}${encodeURIComponent(branchChild)}`) {
        const parentToken = readCookie(req, cookieName(panelThread));
        if (!tokenEqual(panelToken(this.secret, panelThread), parentToken)) return sendError(res, "TOKEN_INVALID", 403);
        try {
          const child = await this.appserver.readThread(branchChild);
          if (child?.forkedFromId !== panelThread) return sendError(res, "NOT_FOUND", 404);
          res.writeHead(303, {
            location: `/t/${encodeURIComponent(branchChild)}?k=${panelToken(this.secret, branchChild)}&from=${encodeURIComponent(panelThread)}`,
            "cache-control": "no-store",
          });
          return res.end();
        } catch { return sendError(res, "NOT_FOUND", 404); }
      }
      const assetName = url.pathname.startsWith(`${panelPrefix}/`)
        ? url.pathname.slice(panelPrefix.length + 1)
        : url.pathname === panelPrefix ? "index.html" : undefined;
      if (assetName !== undefined && req.method === "GET") {
        const expected = panelToken(this.secret, panelThread);
        const queryToken = url.searchParams.get("k");
        const cookieToken = readCookie(req, cookieName(panelThread));
        const supplied = queryToken || cookieToken;
        if (!tokenEqual(expected, supplied)) return sendPanelReopen(res, (req.headers["accept-language"] || "").startsWith("zh") ? "zh" : "en");
        if (queryToken && assetName === "index.html" && typeof this.server?.listen === "function") {
          // Keep "from" (set by the branch link) so the panel can offer a way back.
          const from = url.searchParams.get("from");
          const keep = validThread(from) ? `?from=${encodeURIComponent(from)}` : "";
          res.writeHead(303, { location: `/t/${encodeURIComponent(panelThread)}${keep}`, "cache-control": "no-store", "set-cookie": [panelCookie(panelThread, expected)] });
          return res.end();
        }
        const asset = PANEL_ASSETS[assetName];
        if (!asset) return sendError(res, "NOT_FOUND", 404);
        const content = await this.fs.readFile(asset.file);
        res.writeHead(200, {
          "content-type": asset.type,
          "cache-control": "no-store",
          "content-length": content.byteLength,
          ...(queryToken ? { "set-cookie": [panelCookie(panelThread, expected)] } : {}),
        });
        return res.end(content);
      }
    }

    if (url.pathname === "/api/lane-config") {
      if (!hasValidPanelCredential(req, this.secret)) return sendError(res, "TOKEN_INVALID", 403);
      if (req.method === "GET") {
        const current = await readJson(path.join(this.dataDir, "config.json"), { displayOrder: [], laneOverrides: {} });
        const sanitized = sanitizeLaneConfig(current);
        return sendJson(res, 200, sanitized.ok ? sanitized.config : { displayOrder: [], laneOverrides: {} });
      }
      if (req.method === "PUT") {
        try {
          const value = await bodyJson(req);
          const sanitized = sanitizeLaneConfig(value?.config ?? value);
          if (!sanitized.ok) return sendError(res, sanitized.code);
          await writeJsonAtomic(path.join(this.dataDir, "config.json"), sanitized.config);
          return sendJson(res, 200, sanitized.config);
        } catch (error) { return sendError(res, error.code || "CONFIG_WRITE_FAILED", errorStatus(error.code)); }
      }
      return sendError(res, "METHOD_NOT_ALLOWED", 405);
    }

    const apiThread = routeThread(url.pathname, "/api/t/");
    if (apiThread === undefined || !validThread(apiThread)) return sendError(res, "NOT_FOUND", 404);
    const expectedToken = panelToken(this.secret, apiThread);
    const cookieToken = readCookie(req, cookieName(apiThread));
    if (!tokenEqual(expectedToken, req.headers["x-cn-token"] || cookieToken)) return sendError(res, "TOKEN_INVALID", 403);
    // An authenticated panel page for this thread is alive (it polls every 3 s).
    this.panelSeen.set(apiThread, Date.now());
    const context = await this.context(apiThread);
    if (context.ok === false) return sendError(res, context.code, errorStatus(context.code));

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/selection`) {
      if (req.method === "GET") {
        const current = await this.withSelectionLock(apiThread, async () => this.refreshAttachment(apiThread, await this.loadSelection(apiThread)));
        return sendJson(res, 200, { targets: current.targets, generation: current.generation, lastBinding: current.lastBinding });
      }
      if (req.method === "PUT") {
        return this.withSelectionLock(apiThread, async () => {
          try {
            const current = await this.loadSelection(apiThread);
            const body = await bodyJson(req);
            if (!Array.isArray(body.targets) || !Number.isSafeInteger(body.generation)) return sendError(res, "INVALID_SELECTION");
            if (body.generation <= current.generation) {
              return sendJson(res, 409, { ok: false, stale: true, currentGeneration: current.generation });
            }
            const targets = body.targets.filter((target) => isLaneKey(target?.lane ?? target?.laneKey) && isValidItemKey(target?.itemKey))
              .map((target) => ({ lane: target.lane ?? target.laneKey, itemKey: target.itemKey }));
            if (targets.length !== body.targets.length) return sendError(res, "INVALID_SELECTION");
            const next = { targets, generation: body.generation, lastBinding: null };
            await this.saveSelection(apiThread, next);
            return sendJson(res, 200, { ok: true, targets, generation: next.generation, lastBinding: null });
          } catch (error) { return sendError(res, error.code || "INVALID_SELECTION", errorStatus(error.code)); }
        });
      }
      return sendError(res, "METHOD_NOT_ALLOWED", 405);
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/carry`) {
      if (req.method === "GET") {
        const carry = await this.carryStatus(apiThread, context);
        return carry?.ok === false ? sendError(res, carry.code, errorStatus(carry.code)) : sendJson(res, 200, { carry });
      }
      if (req.method === "POST") {
        try {
          const body = await bodyJson(req);
          const choice = body.choice;
          if (!["all", "some", "none"].includes(choice)) return sendError(res, "INVALID_CHOICE");
          if (choice === "some" && (!Array.isArray(body.lanes) || body.lanes.length === 0)) return sendError(res, "INVALID_LANES");
          const selected = choice === "all" ? LANE_KEYS : choice === "some" ? body.lanes.filter(isLaneKey) : [];
          if (choice === "some" && (selected.length !== body.lanes.length || new Set(selected).size !== selected.length)) return sendError(res, "INVALID_LANES");
          const plan = await this.carryPlan(apiThread, context, choice, selected, body.resolutions || {}, body.observations || {});
          if (!plan.ok) return sendJson(res, plan.code === "CARRY_CONFLICT" ? 409 : errorStatus(plan.code), plan);
          const { readLane } = await import("./lib/lane-store.js");
          const outcomes = {};
          const markerLanes = {};
          const selectedSet = new Set(plan.plan.map((entry) => entry.lane));
          const lockEntries = [...plan.plan].filter((entry) => !entry.committed).sort((a, b) => LANE_KEYS.indexOf(a.lane) - LANE_KEYS.indexOf(b.lane));
          const writableRoot = await import("./lib/binding.js").then(({ ensureRootForWrite }) => ensureRootForWrite(this.dataDir, context.projectPath));
          if (!writableRoot.ok) return sendError(res, writableRoot.code, errorStatus(writableRoot.code));
          plan.childRoot = writableRoot.root;
          const laneLocks = new Map();
          try {
            const parentContext = await this.threadContext(plan.parentThreadId);
            const parentRoot = await (await import("./lib/binding.js")).resolveRoot(this.dataDir, parentContext.projectPath);
            if (!parentRoot.ok) return sendJson(res, 409, failure("CARRY_SOURCE_UNAVAILABLE"));
            for (const entry of lockEntries) {
              const laneDir = path.join(plan.childRoot, entry.lane);
              await fs.mkdir(laneDir, { recursive: false, mode: 0o700 }).catch((error) => {
                if (error.code !== "EEXIST") throw error;
              });
              const lockPath = path.join(laneDir, `${apiThread}.md.lock`);
              const locked = await acquireLock(lockPath, { staleOnlyIfHolderDead: true });
              if (!locked.ok) return sendJson(res, 409, failure("CARRY_LOCKED", { lane: entry.lane }));
              laneLocks.set(entry.lane, { lockPath, handle: locked.handle });
            }
            for (const entry of lockEntries) {
              const current = await readLane(plan.childRoot, entry.lane, apiThread);
              const parent = await readLane(parentRoot.root, entry.lane, plan.parentThreadId);
              if (current.version !== entry.currentVersion || parent.version !== entry.parentVersion) {
                return sendJson(res, 409, failure("CARRY_STALE", { lane: entry.lane }));
              }
            }
            for (const entry of plan.plan) {
              if (entry.committed) {
                const previous = (await this.carryStatus(apiThread, context))?.lanes?.[entry.lane];
                // A lane recovered from a write-ahead record reports what was planned.
                const recovered = previous?.outcome === "writing";
                const outcome = recovered ? (previous.plannedOutcome || "copied") : (previous?.outcome || "kept");
                const keys = recovered ? (previous.plannedKeys || []) : (previous?.carriedKeys || []);
                outcomes[entry.lane] = { outcome, carried: keys.length, skipped: entry.skipped || 0 };
                markerLanes[entry.lane] = { ...(previous || {}), outcome, committed: true, carriedKeys: keys };
                continue;
              }
            let bodyText = entry.current;
            let carriedKeys = [];
            const decision = entry.choice;
            if (decision === "copy") {
              const copied = rekeyCarriedBody(entry.parent);
              bodyText = mergeCarryBodies(copied.body, entry.current);
              carriedKeys = copied.carriedKeys;
            } else if (decision === "merge") {
              const copied = rekeyCarriedBody(entry.parent);
              bodyText = mergeCarryBodies(copied.body, entry.current);
              carriedKeys = copied.carriedKeys;
            } else if (decision === "replace") {
              const copied = rekeyCarriedBody(entry.parent);
              bodyText = copied.body;
              carriedKeys = copied.carriedKeys;
            }
            if (bodyText !== entry.current) {
              // Write-ahead: record the planned keys before the lane changes.
              const plannedOutcome = decision === "merge" ? "merged" : decision === "replace" ? "replaced" : decision === "copy" ? "copied" : "kept";
              markerLanes[entry.lane] = {
                outcome: "writing", committed: false, carriedKeys: [],
                plannedKeys: carriedKeys, plannedVersion: versionForBytes(Buffer.from(bodyText, "utf8")), plannedOutcome,
              };
              const aheadRoot = await import("./lib/binding.js").then(({ ensureRootForWrite }) => ensureRootForWrite(this.dataDir, context.projectPath));
              try {
                if (!aheadRoot.ok) throw new Error(aheadRoot.code);
                await this.writePartialCarryMarker(path.join(aheadRoot.root, ".carry-over", `${apiThread}.json`), plan.parentThreadId, markerLanes, choice, selected);
              } catch {
                delete markerLanes[entry.lane];
                return sendJson(res, 409, failure("CARRY_PARTIAL", { lane: entry.lane, outcomes, markerLanes, markerFailed: true }));
              }
              const written = await this.carryWriteLane(plan.childRoot, entry.lane, apiThread, bodyText, { expectedVersion: entry.currentVersion, lockHandle: laneLocks.get(entry.lane)?.handle });
              if (!written.ok) {
                markerLanes[entry.lane] = { outcome: "failed", committed: false, carriedKeys: [] };
                for (const remaining of plan.plan) if (!markerLanes[remaining.lane]) markerLanes[remaining.lane] = { outcome: "pending", committed: false, carriedKeys: [] };
                for (const skipped of LANE_KEYS) if (!markerLanes[skipped]) markerLanes[skipped] = { outcome: "skipped", committed: false, carriedKeys: [] };
                const root = await import("./lib/binding.js").then(({ ensureRootForWrite }) => ensureRootForWrite(this.dataDir, context.projectPath));
                let markerFailed = false;
                if (root.ok) {
                  try {
                    await this.writePartialCarryMarker(path.join(root.root, ".carry-over", `${apiThread}.json`), plan.parentThreadId, markerLanes, choice, selected);
                  } catch { markerFailed = true; }
                } else markerFailed = true;
                return sendJson(res, 409, failure("CARRY_PARTIAL", { lane: entry.lane, outcomes, markerLanes, ...(markerFailed ? { markerFailed: true } : {}) }));
              }
            }
            const outcome = decision === "merge" ? "merged" : decision === "replace" ? "replaced" : decision === "copy" ? "copied" : "kept";
            outcomes[entry.lane] = { outcome, carried: carriedKeys.length, skipped: entry.skipped || 0 };
            markerLanes[entry.lane] = { outcome, committed: true, carriedKeys, plannedKeys: carriedKeys };
            const partialRoot = await import("./lib/binding.js").then(({ ensureRootForWrite }) => ensureRootForWrite(this.dataDir, context.projectPath));
            if (!partialRoot.ok) return sendJson(res, 409, failure("CARRY_PARTIAL", { lane: entry.lane, outcomes, markerLanes, markerFailed: true }));
            try {
              await this.writePartialCarryMarker(path.join(partialRoot.root, ".carry-over", `${apiThread}.json`), plan.parentThreadId, markerLanes, choice, selected);
            } catch {
              return sendJson(res, 409, failure("CARRY_PARTIAL", { lane: entry.lane, outcomes, markerLanes, markerFailed: true }));
            }
            }
          } finally {
            for (const locked of laneLocks.values()) await releaseLock(locked.lockPath, locked.handle);
          }
          for (const lane of LANE_KEYS) {
            if (!selectedSet.has(lane)) markerLanes[lane] = { outcome: "skipped", carriedKeys: [] };
          }
          const setup = await import("./lib/binding.js").then(({ ensureRootForWrite }) => ensureRootForWrite(this.dataDir, context.projectPath));
          if (!setup.ok) return sendError(res, setup.code, errorStatus(setup.code));
          const marker = carryMarker(plan.parentThreadId, markerLanes, "decided", { choice, selectedLanes: selected });
          await writeJsonAtomic(path.join(setup.root, ".carry-over", `${apiThread}.json`), marker);
          return sendJson(res, 200, { ok: true, outcomes, marker });
        } catch (error) { return sendError(res, error.code || "CARRY_FAILED", errorStatus(error.code)); }
      }
      return sendError(res, "METHOD_NOT_ALLOWED", 405);
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/context` && req.method === "GET") {
      const setupState = await import("./lib/binding.js").then(({ getSetupState }) => getSetupState(this.dataDir, context.projectPath));
      const config = await readJson(path.join(this.dataDir, "config.json"), { displayOrder: [], laneOverrides: {} });
      const locale = this.locale || await detectLocale({ acceptLanguage: req.headers["accept-language"] });
      const carry = setupState.state === "INITIALIZED" ? await this.carryStatus(apiThread, context) : null;
      return sendJson(res, 200, {
        serviceVersion: PLUGIN_VERSION,
        title: context.title || null,
        projectPath: context.projectPath,
        locale,
        setup: setupState,
        lanes: resolveLanes(config, locale),
        hooks: { trusted: await hooksTrusted(this.dataDir) },
        carry,
        forkedFrom: carry?.parentThreadId ? {
          id: carry.parentThreadId,
          title: await this.threadContext(carry.parentThreadId).then((parent) => parent?.title || null).catch(() => null),
        } : null,
        recentForks: await this.recentForksFor(apiThread),
      });
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/mirror/recent` && req.method === "GET") {
      try {
        const requestedLimit = Number(url.searchParams.get("limit") || 10);
        const limit = Number.isInteger(requestedLimit) ? Math.min(20, Math.max(1, requestedLimit)) : 10;
        return sendJson(res, 200, await this.mirrorRecent(apiThread, context, limit, url.searchParams.get("cursor")));
      } catch (error) { return sendError(res, error.code || "NOTES_SOURCE_UNAVAILABLE", errorStatus(error.code || "NOTES_SOURCE_UNAVAILABLE")); }
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/mirror` && req.method === "GET") {
      try {
        const requestedLimit = Number(url.searchParams.get("limit") || 5);
        const limit = Number.isInteger(requestedLimit) ? Math.min(5, Math.max(1, requestedLimit)) : 5;
        const listed = await listMirrorTurns(this.appserver, apiThread, {
          cursor: url.searchParams.get("cursor") || undefined,
          limit,
          sortDirection: "desc",
          itemsView: "full",
        });
        return sendJson(res, 200, {
          turns: listed.turns.map(compactTurn),
          ...(listed.nextCursor ? { nextCursor: listed.nextCursor } : {}),
        });
      } catch (error) { return sendError(res, error.code || "NOTES_SOURCE_UNAVAILABLE", errorStatus(error.code || "NOTES_SOURCE_UNAVAILABLE")); }
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/mirror/turn` && req.method === "GET") {
      try {
        const turnId = url.searchParams.get("turnId");
        const turn = await this.mirrorCache.turn(apiThread, turnId);
        return turn ? sendJson(res, 200, compactTurn(turn)) : sendError(res, "NOT_FOUND", 404);
      } catch (error) { return sendError(res, error.code || "NOTES_SOURCE_UNAVAILABLE", errorStatus(error.code || "NOTES_SOURCE_UNAVAILABLE")); }
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/mirror/search` && req.method === "GET") {
      const query = url.searchParams.get("q");
      if (typeof query !== "string" || query.length < 1 || query.length > 2_000) return sendError(res, "INVALID_QUERY");
      try {
        const cache = await this.mirrorCache.get(apiThread);
        return sendJson(res, 200, { results: searchMirrorTurns(cache.turns, query) });
      } catch (error) { return sendError(res, error.code || "NOTES_SOURCE_UNAVAILABLE", errorStatus(error.code || "NOTES_SOURCE_UNAVAILABLE")); }
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/source` && req.method === "GET") {
      const lane = url.searchParams.get("lane");
      const itemKey = url.searchParams.get("itemKey");
      if (!isLaneKey(lane) || !isValidItemKey(itemKey)) return sendError(res, "NOTES_SOURCE_UNAVAILABLE", 404);
      const ctx = { dataDir: this.dataDir, projectPath: context.projectPath, holder: apiThread };
      try {
        const notes = await readNotes(ctx, lane);
        const note = notes.notes?.find((entry) => entry.addressable && entry.itemKey === itemKey);
        if (!note?.source || typeof note.sourceSnapshot !== "string") return sendError(res, "NOTES_SOURCE_UNAVAILABLE", 404);
        const crossThread = note.source.threadId !== apiThread;
        if (crossThread && url.searchParams.get("consent") !== "per-request") {
          return sendError(res, "NOTES_SOURCE_CONSENT_REQUIRED", 403);
        }
        const resolved = await this.mirrorCache.resolveSourceItem(apiThread, note.source.threadId, note.source.itemId);
        if (!resolved.ok) return sendError(res, "NOTES_SOURCE_UNAVAILABLE", 404);
        const before = boundedCount(url.searchParams.get("before"), 1);
        const after = boundedCount(url.searchParams.get("after"), 1);
        const window = await this.mirrorCache.sourceTurns(note.source.threadId, note.source.itemId, before, after);
        if (!window.ok) return sendError(res, "NOTES_SOURCE_UNAVAILABLE", 404);
        let thread;
        try { thread = await this.appserver.readThread(note.source.threadId); } catch { thread = { id: note.source.threadId }; }
        // The source message itself always comes from the direct read, so the
        // exact/not-located highlight is never decided against cached text.
        const turns = window.turns.map((turn) => ({
          ...turn,
          items: turn.items.map((item) => (item.id === resolved.item.id ? { ...item, role: resolved.item.role, text: resolved.item.text } : item)),
        }));
        return sendJson(res, 200, {
          thread: { id: note.source.threadId, title: thread.name || null },
          turns: turns.map(compactTurn),
          hasEarlier: window.hasEarlier,
          hasLater: window.hasLater,
          targetItemId: note.source.itemId,
          snapshot: note.sourceSnapshot,
        });
      } catch (error) { return sendError(res, error.code || "NOTES_SOURCE_UNAVAILABLE", errorStatus(error.code || "NOTES_SOURCE_UNAVAILABLE")); }
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/setup` && req.method === "POST") {
      try {
        const { setup } = await import("./lib/binding.js");
        const body = await bodyJson(req);
        const result = await setup(this.dataDir, context.projectPath, body.action, body.customPath);
        return result.ok ? sendJson(res, 200, result) : sendError(res, result.code, errorStatus(result.code));
      } catch (error) { return sendError(res, error.code || "SETUP_FAILED", errorStatus(error.code)); }
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/fs` && req.method === "GET") {
      const result = await listFolders(url.searchParams.get("path"));
      return result.ok ? sendJson(res, 200, result) : sendError(res, result.code, errorStatus(result.code));
    }
    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/fs/mkdir` && req.method === "POST") {
      try {
        const body = await bodyJson(req);
        const result = await mkdirFolder(body.parent, body.name);
        return result.ok ? sendJson(res, 200, result) : sendError(res, result.code, errorStatus(result.code));
      } catch (error) { return sendError(res, error.code || "MKDIR_FAILED", errorStatus(error.code)); }
    }

    const laneMatch = url.pathname.match(new RegExp(`^/api/t/${encodeURIComponent(apiThread)}/lanes/([^/]+)(?:/notes(?:/([^/]+))?)?$`));
    if (laneMatch) {
      const lane = decodeURIComponent(laneMatch[1]);
      if (!isLaneKey(lane)) return sendError(res, "INVALID_LANE");
      const ctx = { dataDir: this.dataDir, projectPath: context.projectPath, holder: apiThread };
      try {
        if (laneMatch[2] === undefined && req.method === "GET") {
          const result = await readNotes(ctx, lane);
          return result.ok === false ? sendError(res, result.code, errorStatus(result.code)) : sendJson(res, 200, result);
        }
        if (laneMatch[2] === undefined && req.method === "POST") {
          const body = await bodyJson(req);
          const result = await createNote(ctx, lane, body);
          return result.ok ? sendJson(res, 200, result) : sendError(res, result.code, errorStatus(result.code));
        }
        const itemKey = decodeURIComponent(laneMatch[2]);
        if (!isValidItemKey(itemKey)) return sendError(res, "INVALID_ITEM_KEY");
        if (req.method === "PUT") {
          const body = await bodyJson(req);
          const result = await editNote(ctx, lane, itemKey, body.content, body.expectedVersion, { overwrite: body.overwrite === true });
          return result.ok ? sendJson(res, 200, result) : sendError(res, result.code, errorStatus(result.code));
        }
        if (req.method === "DELETE") {
          const result = await deleteNote(ctx, lane, itemKey, url.searchParams.get("v"));
          return result.ok ? sendJson(res, 200, result) : sendError(res, result.code, errorStatus(result.code));
        }
      } catch (error) { return sendError(res, error.code || "REQUEST_FAILED", errorStatus(error.code)); }
      return sendError(res, "METHOD_NOT_ALLOWED", 405);
    }

    const sourcedLaneMatch = url.pathname.match(new RegExp(`^/api/t/${encodeURIComponent(apiThread)}/lanes/([^/]+)/sourced-notes$`));
    if (sourcedLaneMatch) {
      const lane = decodeURIComponent(sourcedLaneMatch[1]);
      if (!isLaneKey(lane)) return sendError(res, "INVALID_LANE");
      if (req.method !== "POST") return sendError(res, "METHOD_NOT_ALLOWED", 405);
      const ctx = { dataDir: this.dataDir, projectPath: context.projectPath, holder: apiThread };
      try {
        const body = await bodyJson(req);
        const verified = await verifySourceCapture(this.appserver, apiThread, body.snapshot, body.source);
        if (!verified.ok) return sendError(res, verified.code, errorStatus(verified.code));
        const result = await createSourcedNote(ctx, lane, body);
        return result.ok ? sendJson(res, 200, result) : sendError(res, result.code, errorStatus(result.code));
      } catch (error) { return sendError(res, error.code || "NOTES_SOURCE_UNVERIFIED", errorStatus(error.code || "NOTES_SOURCE_UNVERIFIED")); }
    }

    if (url.pathname === `/api/t/${encodeURIComponent(apiThread)}/prefs`) {
      const file = path.join(this.dataDir, "prefs", `${apiThread}.json`);
      if (req.method === "GET") return sendJson(res, 200, sanitizePrefs(await readJson(file, { pins: {} })));
      if (req.method === "PUT") {
        try {
          const prefs = sanitizePrefs(await bodyJson(req));
          await writeJsonAtomic(file, prefs);
          return sendJson(res, 200, prefs);
        } catch (error) { return sendError(res, error.code || "PREFS_WRITE_FAILED", errorStatus(error.code)); }
      }
      return sendError(res, "METHOD_NOT_ALLOWED", 405);
    }
    return sendError(res, "NOT_FOUND", 404);
  }

  async start() {
    this.lock = await acquireLock(this.lockPath, { staleOnlyIfHolderDead: true, ...(this.lockOptions || {}) });
    if (!this.lock.ok) throw Object.assign(new Error(this.lock.code), { code: this.lock.code });
    this.server = http.createServer((req, res) => {
      this.request(req, res).catch((error) => {
        // A panel page load during a transient failure gets a self-retrying
        // page instead of raw JSON, so the side-panel tab recovers by itself.
        if (req.method === "GET" && /^\/t\//.test(req.url || "") && !res.headersSent) {
          res.writeHead(503, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "3" });
          res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Notes</title>'
            + '<body style="font:14px -apple-system,system-ui,sans-serif;margin:16px;color:#555">Notes is restarting… retrying in a few seconds. / 便签服务正在重启，几秒后自动重试。</body>');
          return;
        }
        sendError(res, error.code || "REQUEST_FAILED", errorStatus(error.code));
      });
    });
    // Prefer a stable per-data-dir port so open panel tabs reconnect after a
    // service restart; fall back to an ephemeral port if it is taken.
    const listen = (port) => new Promise((resolve, reject) => {
      const onError = (error) => { this.server.off("listening", onListening); reject(error); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(port, "127.0.0.1");
    });
    const preferred = this.preferredPort ?? stablePort(this.dataDir);
    try { await listen(preferred); } catch { await listen(0); }
    const info = {
      pid: process.pid,
      port: this.server.address().port,
      instanceId: this.instanceId,
      startedAt: new Date().toISOString(),
      version: this.version,
      pluginRoot: this.pluginRoot,
    };
    await writeJsonAtomic(path.join(this.dataDir, "service.json"), info);
    this.idleTimer = setInterval(() => {
      this.mirrorCache.evict(this.now());
      if (this.now() - this.lastRequestAt >= this.idleMs) this.close();
      // A plugin upgrade removes the old install directory; retire this instance.
      else if (this.pluginRoot) fs.access(this.pluginRoot).catch(() => this.handOverToSuccessor());
    }, Math.min(this.idleMs, 60_000));
    this.idleTimer.unref?.();
    if (this.env.CN_FORK_WATCH !== "0") {
      void this.scanForks();
      this.forkWatchTimer = setInterval(() => { void this.scanForks(); }, FORK_SCAN_INTERVAL_MS);
      this.forkWatchTimer.unref?.();
    }
    return { ...info, close: () => this.close(), server: this.server, secret: this.secret, dataDir: this.dataDir };
  }

  // After an upgrade removed this install, start the newest installed version
  // on the same data directory, so an open panel can reload without waiting
  // for the next hook.
  async handOverToSuccessor() {
    const successor = await successorRoot(this.pluginRoot);
    await this.close();
    if (!successor) return;
    try {
      const child = this.spawn(process.execPath, [path.join(successor, "server", "service.mjs")], {
        cwd: os.homedir(),
        detached: true,
        stdio: "ignore",
        env: { ...process.env, CN_DATA_DIR: this.dataDir, CN_SERVICE_VERSION: "" },
      });
      child.on?.("error", () => {});
      child.unref?.();
    } catch { /* the next hook starts the service */ }
  }

  async close() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
    if (this.forkWatchTimer) clearInterval(this.forkWatchTimer);
    this.forkWatchTimer = null;
    if (this.server) {
      const closing = new Promise((resolve) => this.server.close(() => resolve()));
      // Keep-alive connections from the in-app browser would hold close() open.
      this.server.closeAllConnections?.();
      await closing;
    }
    this.server = null;
    try {
      const current = await readJson(path.join(this.dataDir, "service.json"), undefined);
      if (current?.instanceId === this.instanceId) await fs.unlink(path.join(this.dataDir, "service.json"));
    } catch { /* best effort */ }
    if (this.lock?.ok) await releaseLock(this.lockPath, this.lock.handle);
    this.lock = null;
    if (this.exitOnClose) setImmediate(() => process.exit(0));
  }
}

/** Deterministic port in 47100–48099 derived from the data dir path. */
export function stablePort(dataDir) {
  const digest = createHash("sha256").update(String(dataDir)).digest();
  return 47100 + (digest.readUInt16BE(0) % 1000);
}

function versionKey(name) {
  return String(name).split(/[.-]/).map((part) => (/^\d+$/.test(part) ? part.padStart(8, "0") : part)).join(".");
}

export async function successorRoot(pluginRoot) {
  if (!pluginRoot) return null;
  const parent = path.dirname(pluginRoot);
  let entries;
  try { entries = await fs.readdir(parent, { withFileTypes: true }); } catch { return null; }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = path.join(parent, entry.name);
    if (root === pluginRoot) continue;
    try { await fs.access(path.join(root, "server", "service.mjs")); candidates.push(entry.name); } catch { /* not an install */ }
  }
  candidates.sort((a, b) => versionKey(a).localeCompare(versionKey(b)));
  return candidates.length ? path.join(parent, candidates.at(-1)) : null;
}

export async function startService(options = {}) {
  const dataDir = options.dataDir || await resolveDataDir({ pluginId: options.pluginId, env: options.env });
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const secret = options.secret || await ensureSecret(dataDir);
  let pluginInfo = { version: PLUGIN_VERSION };
  try { pluginInfo = JSON.parse(await fs.readFile(path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), ".codex-plugin", "plugin.json"), "utf8")); } catch { /* packaged default */ }
  const service = new PanelService({ ...options, dataDir, secret, version: options.version || options.env?.CN_SERVICE_VERSION || pluginInfo.version || PLUGIN_VERSION });
  try { return await service.start(); } catch (error) { await service.close(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  startService({
    dataDir: process.env.CN_DATA_DIR || process.env.PLUGIN_DATA,
    env: process.env,
    exitOnClose: true,
  }).then((running) => {
    const stop = () => { Promise.resolve(running.close()).finally(() => process.exit(0)); };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }).catch(() => process.exitCode = 1);
}
