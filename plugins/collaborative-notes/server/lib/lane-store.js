import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { LANE_KEYS, isLaneKey } from "./lanes.js";
import { isValidSessionId } from "./structured-item.js";

export const MAX_BODY_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 2000;
const LOCK_RETRY_MS = 25;
const STALE_LOCK_MS = 10000;

const failure = (code, extra = {}) => ({ ok: false, code, ...extra });
const isMissing = (error) => error?.code === "ENOENT";
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function checkedRoot(root) {
  if (typeof root !== "string" || !path.isAbsolute(root)) return failure("ROOT_INVALID");
  let stat;
  try { stat = await fs.lstat(root); } catch { return failure("ROOT_INVALID"); }
  if (stat.isSymbolicLink()) return failure("SYMLINK_REFUSED");
  if (!stat.isDirectory()) return failure("ROOT_INVALID");
  let real;
  try { real = await fs.realpath(root); } catch { return failure("ROOT_INVALID"); }
  return { ok: true, root: path.resolve(root), realRoot: real };
}

async function checkedTarget(root, lane, holder, { createLane = false } = {}) {
  if (!isLaneKey(lane)) return failure("INVALID_LANE");
  if (!isValidSessionId(holder)) return failure("INVALID_HOLDER");
  const checked = await checkedRoot(root);
  if (!checked.ok) return checked;
  const laneDir = path.join(checked.root, lane);
  const file = path.join(laneDir, `${holder}.md`);

  let laneStat;
  try { laneStat = await fs.lstat(laneDir); } catch (error) {
    if (!isMissing(error)) return failure("ROOT_INVALID");
    if (!createLane) return { ...checked, laneDir, file, laneExists: false };
  }
  if (laneStat) {
    if (laneStat.isSymbolicLink()) return failure("SYMLINK_REFUSED");
    if (!laneStat.isDirectory()) return failure("PATH_INVALID");
  } else if (createLane) {
    try { await fs.mkdir(laneDir); } catch (error) {
      if (error.code !== "EEXIST") return failure("PATH_INVALID");
    }
    try { laneStat = await fs.lstat(laneDir); } catch { return failure("PATH_INVALID"); }
    if (laneStat.isSymbolicLink()) return failure("SYMLINK_REFUSED");
    if (!laneStat.isDirectory()) return failure("PATH_INVALID");
  }

  let fileStat;
  try { fileStat = await fs.lstat(file); } catch (error) {
    if (!isMissing(error)) return failure("PATH_INVALID");
  }
  if (fileStat?.isSymbolicLink()) return failure("SYMLINK_REFUSED");
  if (fileStat && !fileStat.isFile()) return failure("PATH_INVALID");

  let realLane;
  try { realLane = await fs.realpath(laneDir); } catch { return failure("PATH_INVALID"); }
  if (!inside(checked.realRoot, realLane)) return failure("CONTAINMENT_REFUSED");
  if (fileStat) {
    let realFile;
    try { realFile = await fs.realpath(file); } catch { return failure("PATH_INVALID"); }
    if (!inside(checked.realRoot, realFile)) return failure("CONTAINMENT_REFUSED");
  } else if (!inside(checked.realRoot, path.resolve(realLane, `${holder}.md`))) {
    return failure("CONTAINMENT_REFUSED");
  }
  return { ...checked, laneDir, file, laneExists: true, fileExists: Boolean(fileStat) };
}

export function versionForBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readFileState(target) {
  if (!target.fileExists) return { status: "absent", version: "0", body: "" };
  try {
    const bytes = await fs.readFile(target.file);
    return { status: "present", version: versionForBytes(bytes), body: bytes.toString("utf8") };
  } catch (error) {
    if (isMissing(error)) return { status: "absent", version: "0", body: "" };
    return failure("READ_FAILED");
  }
}

export async function readLane(root, lane, holder) {
  const target = await checkedTarget(root, lane, holder);
  if (!target.ok) return target;
  return readFileState(target);
}

async function lockTimestamp(lockPath) {
  try {
    const text = await fs.readFile(lockPath, "utf8");
    const match = text.match(/(?:^|\n)(\d{10,})\s*$/);
    if (match) return Number(match[1]);
    const stat = await fs.stat(lockPath);
    return stat.mtimeMs;
  } catch {
    return null;
  }
}

function holderAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

async function lockHolderPid(lockPath) {
  try {
    const text = await fs.readFile(lockPath, "utf8");
    const pid = Number(text.split("\n", 1)[0]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

const TAKEOVER_STALE_MS = 30_000;


// Windows refuses to replace a file another process holds open (antivirus,
// indexers, editors) with EPERM/EACCES/EBUSY for a moment; retry briefly.
export async function renameWithRetry(from, to, { attempts = 8, delayMs = 25, rename = fs.rename } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await rename(from, to); } catch (error) {
      if (attempt >= attempts || !["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

async function takeOverStaleLock(lockPath, staleContent) {
  const takeoverPath = `${lockPath}.takeover`;
  let handle;
  try {
    handle = await fs.open(takeoverPath, "wx");
  } catch (error) {
    if (error.code !== "EEXIST") return "busy";
    // A takeover lock is held for milliseconds; one left by a crashed
    // contender is cleared once its holder is gone and it is old.
    try {
      const stat = await fs.lstat(takeoverPath);
      const holder = await lockHolderPid(takeoverPath);
      if (Date.now() - stat.mtimeMs > TAKEOVER_STALE_MS && (holder === null || !holderAlive(holder))) {
        await fs.unlink(takeoverPath);
      }
    } catch { /* gone or unreadable: retry later */ }
    return "busy";
  }
  try {
    await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
    const stat = await fs.lstat(lockPath).catch((error) => (error.code === "ENOENT" ? null : Promise.reject(error)));
    if (!stat) return "gone";
    if (stat.isSymbolicLink()) return "refused";
    const current = await fs.readFile(lockPath, "utf8");
    if (current !== staleContent) return "changed";
    await fs.unlink(lockPath);
    return "removed";
  } catch {
    return "busy";
  } finally {
    try { await handle.close(); } catch { /* best effort */ }
    try { await fs.unlink(takeoverPath); } catch { /* best effort */ }
  }
}

export async function acquireLock(lockPath, {
  waitMs = LOCK_WAIT_MS,
  retryMs = LOCK_RETRY_MS,
  staleMs = STALE_LOCK_MS,
  // Long-lived holders (the panel service) keep their lock for hours: only a
  // dead holder makes such a lock stale, never its age.
  staleOnlyIfHolderDead = false,
} = {}) {
  const deadline = Date.now() + waitMs;
  let staleRemoved = false;
  while (Date.now() <= deadline) {
    try {
      const handle = await fs.open(lockPath, "wx");
      await handle.writeFile(`${process.pid}\n${Date.now()}\n`, "utf8");
      await handle.sync();
      return { ok: true, handle };
    } catch (error) {
      if (error.code !== "EEXIST") return failure("LOCKED");
      let stale = false;
      let staleContent;
      try {
        const stat = await fs.lstat(lockPath);
        if (stat.isSymbolicLink()) return failure("SYMLINK_REFUSED");
        staleContent = await fs.readFile(lockPath, "utf8");
        if (staleOnlyIfHolderDead) {
          const pid = await lockHolderPid(lockPath);
          if (pid !== null) stale = !holderAlive(pid);
          else stale = Date.now() - stat.mtimeMs > staleMs;
        } else {
          const timestamp = await lockTimestamp(lockPath);
          stale = timestamp !== null && Date.now() - timestamp > staleMs;
        }
      } catch (statError) {
        if (statError.code !== "ENOENT") return failure("LOCKED");
      }
      if (stale && !staleRemoved) {
        // Take over a stale lock only while holding its takeover lock, and only
        // if it still holds the content judged stale. A live lock file is never
        // renamed or removed, so two contenders cannot both end up holding it.
        const takeover = await takeOverStaleLock(lockPath, staleContent);
        if (takeover === "refused") return failure("SYMLINK_REFUSED");
        if (takeover !== "busy") { staleRemoved = true; continue; }
      }
      if (Date.now() + retryMs > deadline) break;
      await sleep(retryMs);
    }
  }
  return failure("LOCKED");
}

export async function releaseLock(lockPath, lock) {
  try { await lock?.close(); } catch { /* best effort */ }
  try {
    const text = await fs.readFile(lockPath, "utf8");
    const holderPid = Number(text.split("\n", 1)[0]);
    if (holderPid !== process.pid) return { ok: true, preserved: true };
    await fs.unlink(lockPath);
  } catch (error) {
    if (error.code !== "ENOENT") return failure("LOCK_RELEASE_FAILED");
  }
  return { ok: true };
}

export async function writeLane(root, lane, holder, body, {
  expectedVersion,
  overwrite = false,
  lockHandle,
} = {}) {
  if (typeof body !== "string") return failure("INVALID_BODY");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) return failure("TOO_LARGE");
  const initialTarget = await checkedTarget(root, lane, holder, { createLane: false });
  if (!initialTarget.ok) return initialTarget;
  if (expectedVersion === undefined && !overwrite) return failure("PRECONDITION_REQUIRED");
  const target = await checkedTarget(root, lane, holder, { createLane: true });
  if (!target.ok) return target;

  const lockPath = `${target.file}.lock`;
  const ownsLock = !lockHandle;
  const locked = lockHandle ? { ok: true, handle: lockHandle } : await acquireLock(lockPath, { staleOnlyIfHolderDead: true });
  if (!locked.ok) return locked;
  try {
    const currentTarget = await checkedTarget(root, lane, holder, { createLane: false });
    if (!currentTarget.ok) return currentTarget;
    const current = await readFileState(currentTarget);
    if (!overwrite && current.version !== expectedVersion) {
      return failure("STALE", { version: current.version, body: current.body });
    }

    const temporary = path.join(target.laneDir, `.${holder}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
    let tempHandle;
    try {
      tempHandle = await fs.open(temporary, "wx", 0o600);
      await tempHandle.writeFile(body, "utf8");
      await tempHandle.sync();
      await tempHandle.close();
      tempHandle = undefined;
      const finalStat = await fs.lstat(target.file).catch((error) => isMissing(error) ? null : Promise.reject(error));
      if (finalStat?.isSymbolicLink()) return failure("SYMLINK_REFUSED");
      const latestTarget = await checkedTarget(root, lane, holder, { createLane: false });
      if (!latestTarget.ok) return latestTarget;
      const latest = await readFileState(latestTarget);
      if (latest.ok === false) return latest;
      if (!overwrite && latest.version !== expectedVersion) {
        return failure("STALE", { version: latest.version, body: latest.body });
      }
      await renameWithRetry(temporary, target.file);
      const bytes = Buffer.from(body, "utf8");
      return { ok: true, version: versionForBytes(bytes) };
    } catch (error) {
      try { await tempHandle?.close(); } catch { /* best effort */ }
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      if (error.code === "ELOOP") return failure("SYMLINK_REFUSED");
      return failure("WRITE_FAILED");
    }
  } finally {
    if (ownsLock) await releaseLock(lockPath, locked.handle);
  }
}

export function isLaneStorePath(root, lane, holder) {
  return typeof root === "string" && path.isAbsolute(root)
    && isLaneKey(lane) && isValidSessionId(holder) && LANE_KEYS.includes(lane);
}
