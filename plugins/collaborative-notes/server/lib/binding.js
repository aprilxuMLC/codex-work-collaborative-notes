import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LANE_KEYS } from "./lanes.js";
import { acquireLock, releaseLock, renameWithRetry } from "./lane-store.js";

const STATE_VERSION = 1;
const STATE_FILE = "bindings.json";

const failure = (code, extra = {}) => ({ ok: false, code, ...extra });
const isMissing = (error) => error?.code === "ENOENT";

async function projectRealPath(projectPath) {
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) return null;
  try {
    const stat = await fs.lstat(projectPath);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    return await fs.realpath(projectPath);
  } catch {
    return null;
  }
}

async function checkedDataDir(dataDir) {
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) return failure("DATA_DIR_INVALID");
  try {
    const stat = await fs.lstat(dataDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("DATA_DIR_INVALID");
  } catch (error) {
    if (!isMissing(error)) return failure("DATA_DIR_INVALID");
    try { await fs.mkdir(dataDir, { recursive: true }); } catch { return failure("DATA_DIR_INVALID"); }
  }
  return { ok: true, dataDir: path.resolve(dataDir) };
}

async function readState(dataDir) {
  const checked = await checkedDataDir(dataDir);
  if (!checked.ok) return checked;
  const statePath = path.join(checked.dataDir, STATE_FILE);
  let text;
  try { text = await fs.readFile(statePath, "utf8"); } catch (error) {
    if (isMissing(error)) return { ok: true, dataDir: checked.dataDir, state: { version: STATE_VERSION, bindings: {} } };
    return failure("STATE_UNAVAILABLE");
  }
  let state;
  try { state = JSON.parse(text); } catch { return failure("STATE_INVALID"); }
  if (!state || state.version !== STATE_VERSION || !state.bindings || typeof state.bindings !== "object") {
    return failure("STATE_INVALID");
  }
  return { ok: true, dataDir: checked.dataDir, state };
}

async function writeState(dataDir, state) {
  const statePath = path.join(dataDir, STATE_FILE);
  const temporary = path.join(dataDir, `.${STATE_FILE}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    const existing = await fs.lstat(statePath).catch((error) => isMissing(error) ? null : Promise.reject(error));
    if (existing?.isSymbolicLink()) return failure("SYMLINK_REFUSED");
    await renameWithRetry(temporary, statePath);
    return { ok: true };
  } catch {
    try { await handle?.close(); } catch { /* best effort */ }
    try { await fs.unlink(temporary); } catch { /* best effort */ }
    return failure("STATE_WRITE_FAILED");
  }
}

async function hasLaneData(root) {
  let rootStat;
  try { rootStat = await fs.lstat(root); } catch (error) {
    if (isMissing(error)) return false;
    return null;
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
  for (const lane of LANE_KEYS) {
    const laneDir = path.join(root, lane);
    let laneStat;
    try { laneStat = await fs.lstat(laneDir); } catch (error) {
      if (isMissing(error)) continue;
      return null;
    }
    if (laneStat.isSymbolicLink()) return null;
    if (!laneStat.isDirectory()) continue;
    let entries;
    try { entries = await fs.readdir(laneDir, { withFileTypes: true }); } catch { return null; }
    if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".md"))) return true;
  }
  return false;
}

async function legacyForProject(projectRoot) {
  return hasLaneData(path.join(projectRoot, "notes"));
}

async function validateExistingDirectory(directory) {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    await fs.realpath(directory);
    return true;
  } catch { return false; }
}

async function writableProbe(directory) {
  const probe = path.join(directory, `.codex-notes-probe-${process.pid}-${randomBytes(8).toString("hex")}`);
  let handle;
  try {
    handle = await fs.open(probe, "wx", 0o600);
    await handle.close();
    handle = undefined;
    await fs.unlink(probe);
    return true;
  } catch {
    try { await handle?.close(); } catch { /* best effort */ }
    try { await fs.unlink(probe); } catch { /* best effort */ }
    return false;
  }
}

async function updateBinding(dataDir, projectKey, binding, { rejectExisting = false } = {}) {
  const checked = await checkedDataDir(dataDir);
  if (!checked.ok) return checked;
  const lockPath = path.join(checked.dataDir, `${STATE_FILE}.lock`);
  const locked = await acquireLock(lockPath);
  if (!locked.ok) return locked;
  try {
    const current = await readState(checked.dataDir);
    if (!current.ok) return current;
    if (rejectExisting && current.state.bindings[projectKey]) return failure("ALREADY_INITIALIZED");
    const next = {
      version: STATE_VERSION,
      bindings: { ...current.state.bindings, [projectKey]: binding },
    };
    return await writeState(checked.dataDir, next);
  } finally {
    await releaseLock(lockPath, locked.handle);
  }
}

export async function getSetupState(dataDir, projectPath) {
  const project = await projectRealPath(projectPath);
  const proposedPath = typeof projectPath === "string" && path.isAbsolute(projectPath)
    ? path.join(path.resolve(projectPath), "notes") : undefined;
  if (!project) return { state: "UNINITIALIZED", ...(proposedPath ? { proposedPath } : {}), legacy: false };
  const state = await readState(dataDir);
  if (!state.ok) return state;
  const binding = state.state.bindings[project];
  if (binding && typeof binding.path === "string") return { state: "INITIALIZED", root: binding.path };
  const legacy = await legacyForProject(project);
  return { state: "UNINITIALIZED", proposedPath: path.join(project, "notes"), legacy: legacy === true };
}

export async function setup(dataDir, projectPath, action, customPath) {
  const project = await projectRealPath(projectPath);
  if (!project) return failure("PROJECT_INVALID");
  const state = await readState(dataDir);
  if (!state.ok) return state;
  if (state.state.bindings[project]) return failure("ALREADY_INITIALIZED");

  const defaultRoot = path.join(project, "notes");
  const legacy = await legacyForProject(project);
  if (legacy === null) return failure("LOCATION_INVALID");
  if (legacy && action !== "adopt") return failure("LEGACY_ADOPTION_REQUIRED");
  if (action !== "default" && action !== "custom" && action !== "adopt") return failure("BAD_ACTION");
  if (action === "adopt" && !legacy) return failure("BAD_ACTION");

  let root;
  let pendingDefault = false;
  if (action === "adopt" || action === "default") {
    root = defaultRoot;
    let stat;
    try { stat = await fs.lstat(root); } catch (error) {
      if (!isMissing(error)) return failure("LOCATION_INVALID");
    }
    if (stat?.isSymbolicLink() || (stat && !stat.isDirectory())) return failure("LOCATION_INVALID");
    pendingDefault = !stat;
    if (stat && !(await validateExistingDirectory(root))) return failure("LOCATION_INVALID");
  } else {
    if (typeof customPath !== "string" || !path.isAbsolute(customPath)
      || !(await validateExistingDirectory(customPath))) return failure("LOCATION_INVALID");
    root = await fs.realpath(customPath);
    if ((await hasLaneData(root)) === true && root !== defaultRoot) return failure("LOCATION_OCCUPIED");
  }
  if (!pendingDefault && !(await writableProbe(root))) return failure("LOCATION_UNUSABLE");

  const binding = { path: root, confirmedAt: pendingDefault ? null : new Date().toISOString() };
  const written = await updateBinding(dataDir, project, binding, { rejectExisting: true });
  if (!written.ok) return written;
  return { ok: true, root, state: "INITIALIZED" };
}

export async function resolveRoot(dataDir, projectPath) {
  const project = await projectRealPath(projectPath);
  if (!project) return failure("SETUP_REQUIRED");
  const state = await readState(dataDir);
  if (!state.ok) return state;
  const binding = state.state.bindings[project];
  if (!binding || typeof binding.path !== "string") return failure("SETUP_REQUIRED");
  const root = binding.path;
  let stat;
  try { stat = await fs.lstat(root); } catch (error) {
    if (isMissing(error) && binding.confirmedAt === null && root === path.join(project, "notes")) {
      return { ok: true, root, pendingDefault: true };
    }
    return failure("CONFIGURED_ROOT_UNAVAILABLE");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("CONFIGURED_ROOT_UNAVAILABLE");
  try {
    const real = await fs.realpath(root);
    if (real !== root) return failure("CONFIGURED_ROOT_UNAVAILABLE");
  } catch { return failure("CONFIGURED_ROOT_UNAVAILABLE"); }
  return binding.confirmedAt === null && root === path.join(project, "notes")
    ? { ok: true, root, pendingDefault: true }
    : { ok: true, root };
}

export async function ensureRootForWrite(dataDir, projectPath) {
  const resolved = await resolveRoot(dataDir, projectPath);
  if (!resolved.ok) return resolved;
  if (!resolved.pendingDefault) return resolved;
  try {
    await fs.mkdir(resolved.root);
  } catch (error) {
    if (error.code !== "EEXIST") return failure("CONFIGURED_ROOT_UNAVAILABLE");
  }
  const stat = await fs.lstat(resolved.root).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return failure("CONFIGURED_ROOT_UNAVAILABLE");
  const project = await projectRealPath(projectPath);
  if (!project) return failure("CONFIGURED_ROOT_UNAVAILABLE");
  const state = await readState(dataDir);
  if (!state.ok) return state;
  const binding = state.state.bindings[project];
  if (!binding || binding.confirmedAt !== null) return { ok: true, root: resolved.root };
  const updated = await updateBinding(dataDir, project, { ...binding, confirmedAt: new Date().toISOString() });
  return updated.ok ? { ok: true, root: resolved.root } : updated;
}
