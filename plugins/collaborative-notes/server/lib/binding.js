import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LANE_KEYS } from "./lanes.js";
import { acquireLock, releaseLock, renameWithRetry } from "./lane-store.js";
import { pathKey, pathsOverlap, projectRealPath, withProjectWrite } from "./project-write.js";

const STATE_VERSION = 1;
const STATE_FILE = "bindings.json";

const failure = (code, extra = {}) => ({ ok: false, code, ...extra });
const isMissing = (error) => error?.code === "ENOENT";

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

export async function validateExistingDirectory(directory) {
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    await fs.realpath(directory);
    return true;
  } catch { return false; }
}

export async function writableProbe(directory) {
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

export async function withBindingState(dataDir, action, { platform = process.platform } = {}) {
  const checked = await checkedDataDir(dataDir);
  if (!checked.ok) return checked;
  const lockPath = path.join(checked.dataDir, `${STATE_FILE}.lock`);
  const locked = await acquireLock(lockPath, platform === "win32" ? { staleOnlyIfHolderDead: true } : undefined);
  if (!locked.ok) return locked;
  try {
    const current = await readState(checked.dataDir);
    if (!current.ok) return current;
    return await action(current.state, (next) => writeState(checked.dataDir, next));
  } finally { await releaseLock(lockPath, locked.handle); }
}

async function updateBinding(dataDir, projectKey, binding, { rejectExisting = false, platform = process.platform } = {}) {
  return withBindingState(dataDir, async (state, persist) => {
    if (rejectExisting && state.bindings[projectKey]) return failure("ALREADY_INITIALIZED");
    return persist({
      version: STATE_VERSION,
      bindings: { ...state.bindings, [projectKey]: binding },
    });
  }, { platform });
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

async function setupWindows(dataDir, projectPath, action, customPath, { platform = "win32" } = {}) {
  return withProjectWrite(dataDir, projectPath, async (project) => {
  if (!project) return failure("PROJECT_INVALID");
  return withBindingState(dataDir, async (state, persist) => {
  if (state.bindings[project]) return failure("ALREADY_INITIALIZED");

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

  if (platform === "win32" && Object.entries(state.bindings).some(([other, value]) => (
    other !== project && typeof value?.path === "string" && pathsOverlap(root, value.path, platform)
  ))) return failure("LOCATION_OCCUPIED");
  const binding = { path: root, confirmedAt: pendingDefault ? null : new Date().toISOString() };
  const written = await persist({ ...state, bindings: { ...state.bindings, [project]: binding } });
  if (!written.ok) return written;
  return { ok: true, root, state: "INITIALIZED" };
  }, { platform });
  }, { platform });
}

async function setupDefault(dataDir, projectPath, action, customPath) {
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

export async function setup(dataDir, projectPath, action, customPath, { platform = process.platform } = {}) {
  return platform === "win32"
    ? setupWindows(dataDir, projectPath, action, customPath, { platform })
    : setupDefault(dataDir, projectPath, action, customPath);
}

async function relocateDefault(dataDir, projectPath, action, customPath, { acceptEmpty = false } = {}) {
  const project = await projectRealPath(projectPath);
  if (!project) return failure("PROJECT_INVALID");
  const state = await readState(dataDir);
  if (!state.ok) return state;
  const current = state.state.bindings[project];
  if (!current || typeof current.path !== "string") return failure("SETUP_REQUIRED");
  if (action !== "default" && action !== "custom") return failure("BAD_ACTION");
  if (current.confirmedAt === null && current.path === path.join(project, "notes")) {
    const observed = await resolveRoot(dataDir, projectPath);
    if (!observed.ok) return observed;
  }

  let root;
  let pendingDefault = false;
  if (action === "default") {
    root = path.join(project, "notes");
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
    const rootHasNotes = await hasLaneData(root);
    if (rootHasNotes === null) return failure("LOCATION_INVALID");
    if (!rootHasNotes && !acceptEmpty) {
      const nested = path.join(root, "notes");
      if (await hasLaneData(nested) === true) return failure("NOTES_ONE_LEVEL_DOWN", { nested });
    }
  }
  if (!pendingDefault && !(await writableProbe(root))) return failure("LOCATION_UNUSABLE");
  if (root === current.path) return { ok: true, root, state: "INITIALIZED", changed: false };

  const binding = { path: root, confirmedAt: pendingDefault ? null : new Date().toISOString() };
  const written = await updateBinding(dataDir, project, binding);
  if (!written.ok) return written;
  return { ok: true, root, state: "INITIALIZED", changed: true };
}

async function currentRootAvailable(root, platform) {
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    const real = await fs.realpath(root);
    return pathKey(real, platform) === pathKey(path.resolve(root), platform);
  } catch { return false; }
}

async function relocateWindows(dataDir, projectPath, action, customPath, {
  acceptEmpty = false,
  expectedRoot,
} = {}) {
  if (typeof expectedRoot !== "string" || !path.isAbsolute(expectedRoot)) return failure("INVALID_ARGUMENT");
  return withProjectWrite(dataDir, projectPath, async (project) => withBindingState(dataDir, async (state, persist) => {
    const current = state.bindings[project];
    if (!current || typeof current.path !== "string") return failure("SETUP_REQUIRED");
    if (pathKey(current.path, "win32") !== pathKey(path.resolve(expectedRoot), "win32")) {
      return failure("LOCATION_CHANGED", { root: current.path });
    }
    const pendingCurrentDefault = current.confirmedAt === null
      && pathKey(current.path, "win32") === pathKey(path.join(project, "notes"), "win32");
    if (await currentRootAvailable(current.path, "win32")) {
      if (pendingCurrentDefault) {
        const confirmed = await persist({
          ...state,
          bindings: { ...state.bindings, [project]: { ...current, confirmedAt: new Date().toISOString() } },
        });
        if (!confirmed.ok) return confirmed;
      }
      return failure("LOCATION_REBIND_UNAVAILABLE", { root: current.path });
    }
    if (action !== "default" && action !== "custom") return failure("BAD_ACTION");

    let root;
    let pendingDefault = false;
    if (action === "default") {
      root = path.join(project, "notes");
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
      const rootHasNotes = await hasLaneData(root);
      if (rootHasNotes === null) return failure("LOCATION_INVALID");
      if (!rootHasNotes && !acceptEmpty) {
        const nested = path.join(root, "notes");
        if (await hasLaneData(nested) === true) return failure("NOTES_ONE_LEVEL_DOWN", { nested });
      }
    }
    if (!pendingDefault && !(await writableProbe(root))) return failure("LOCATION_UNUSABLE");
    if (pathKey(root, "win32") === pathKey(current.path, "win32")) {
      return { ok: true, root, state: "INITIALIZED", changed: false };
    }
    for (const [otherProject, otherBinding] of Object.entries(state.bindings)) {
      if (otherProject === project) continue;
      if (typeof otherBinding?.path !== "string" || !path.isAbsolute(otherBinding.path)) {
        return failure("STATE_INVALID", { root: current.path });
      }
      if (pathsOverlap(root, otherBinding.path, "win32")) return failure("LOCATION_OCCUPIED", { root: current.path });
    }
    const binding = { path: root, confirmedAt: pendingDefault ? null : new Date().toISOString() };
    const written = await persist({
      version: STATE_VERSION,
      bindings: { ...state.bindings, [project]: binding },
    });
    if (!written.ok) return written;
    return { ok: true, root, state: "INITIALIZED", changed: true };
  }, { platform: "win32" }), { platform: "win32" });
}

export async function relocate(dataDir, projectPath, action, customPath, {
  acceptEmpty = false,
  expectedRoot,
  platform = process.platform,
} = {}) {
  return platform === "win32"
    ? relocateWindows(dataDir, projectPath, action, customPath, { acceptEmpty, expectedRoot })
    : relocateDefault(dataDir, projectPath, action, customPath, { acceptEmpty });
}

// A pending default (<project>/notes chosen before it existed) is confirmed
// as soon as the folder is seen to exist. Reads stay lock-free; only that
// one-time confirmation takes the bindings lock and re-checks under it.
async function confirmPendingDefault(dataDir, project, root, platform) {
  return withBindingState(dataDir, async (state, persist) => {
    const binding = state.bindings[project];
    if (!binding || binding.path !== root || binding.confirmedAt !== null) return { ok: true };
    return persist({
      ...state,
      bindings: { ...state.bindings, [project]: { ...binding, confirmedAt: new Date().toISOString() } },
    });
  }, { platform });
}

export async function resolveRoot(dataDir, projectPath, { platform = process.platform } = {}) {
  const project = await projectRealPath(projectPath);
  if (!project) return failure("SETUP_REQUIRED");
  const state = await readState(dataDir);
  if (!state.ok) return state;
  const binding = state.state.bindings[project];
  if (!binding || typeof binding.path !== "string") return failure("SETUP_REQUIRED");
  const root = binding.path;
  const pendingDefault = binding.confirmedAt === null && root === path.join(project, "notes");
  let stat;
  try { stat = await fs.lstat(root); } catch (error) {
    if (isMissing(error) && pendingDefault) return { ok: true, root, pendingDefault: true };
    return failure("CONFIGURED_ROOT_UNAVAILABLE");
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("CONFIGURED_ROOT_UNAVAILABLE");
  try {
    const real = await fs.realpath(root);
    if (real !== root) return failure("CONFIGURED_ROOT_UNAVAILABLE");
  } catch { return failure("CONFIGURED_ROOT_UNAVAILABLE"); }
  if (pendingDefault) {
    // Best effort: if the lock is busy, the next read confirms it.
    await confirmPendingDefault(dataDir, project, root, platform).catch(() => null);
  }
  return { ok: true, root };
}

export async function ensureRootForWrite(dataDir, projectPath, { platform = process.platform } = {}) {
  const resolved = await resolveRoot(dataDir, projectPath, { platform });
  if (!resolved.ok) return resolved;
  if (!resolved.pendingDefault) return resolved;
  // Only a default folder that has never existed is created on first write.
  try {
    await fs.mkdir(resolved.root);
  } catch (error) {
    if (error.code !== "EEXIST") return failure("CONFIGURED_ROOT_UNAVAILABLE");
  }
  const stat = await fs.lstat(resolved.root).catch(() => null);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) return failure("CONFIGURED_ROOT_UNAVAILABLE");
  const project = await projectRealPath(projectPath);
  if (!project) return failure("CONFIGURED_ROOT_UNAVAILABLE");
  const confirmed = await confirmPendingDefault(dataDir, project, resolved.root, platform);
  return confirmed.ok ? { ok: true, root: resolved.root } : confirmed;
}
