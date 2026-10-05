import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { acquireLock, releaseLock } from "./lane-store.js";

const failure = (code) => ({ ok: false, code });

export const pathKey = (value, platform = process.platform) => (
  platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)
);

export function pathsOverlap(left, right, platform = process.platform) {
  const relative = path.relative(pathKey(left, platform), pathKey(right, platform));
  const reverse = path.relative(pathKey(right, platform), pathKey(left, platform));
  const inside = (value) => value === ""
    || (!path.isAbsolute(value) && value !== ".." && !value.startsWith(`..${path.sep}`));
  return inside(relative) || inside(reverse);
}

export async function projectRealPath(projectPath) {
  if (typeof projectPath !== "string" || !path.isAbsolute(projectPath)) return null;
  try {
    const stat = await fs.lstat(projectPath);
    return stat.isSymbolicLink() || !stat.isDirectory() ? null : await fs.realpath(projectPath);
  } catch { return null; }
}

// Windows writers share a project-wide lock with location changes. On other
// platforms this remains a transparent compatibility wrapper and creates no
// new files.
export async function withProjectWrite(
  dataDir,
  projectPath,
  action,
  { waitMs = 2000, platform = process.platform } = {},
) {
  // Off Windows the wrapper is transparent: the action keeps its own checks,
  // validation precedence, and error codes exactly as before.
  if (platform !== "win32") return action();
  const project = await projectRealPath(projectPath);
  if (!project) return failure("PROJECT_INVALID");
  if (typeof dataDir !== "string" || !path.isAbsolute(dataDir)) return failure("DATA_DIR_INVALID");

  let directory;
  try {
    await fs.mkdir(dataDir, { recursive: true });
    const stat = await fs.lstat(dataDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("DATA_DIR_INVALID");
    directory = await fs.realpath(dataDir);
  } catch { return failure("DATA_DIR_INVALID"); }

  const locks = path.join(directory, "project-write-locks");
  try {
    await fs.mkdir(locks, { recursive: true });
    const stat = await fs.lstat(locks);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return failure("DATA_DIR_INVALID");
  } catch { return failure("DATA_DIR_INVALID"); }

  const file = path.join(locks, `${createHash("sha256").update(pathKey(project, platform)).digest("hex")}.lock`);
  const lock = await acquireLock(file, { waitMs, staleOnlyIfHolderDead: true });
  if (!lock.ok) return failure(lock.code === "LOCKED" ? "LOCATION_BUSY" : lock.code);
  try {
    return await action(project);
  } finally {
    const released = await releaseLock(file, lock.handle);
    if (!released.ok) console.error("PROJECT_WRITE_LOCK_RELEASE_FAILED");
  }
}
