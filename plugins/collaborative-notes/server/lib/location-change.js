import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { LANE_KEYS } from "./lanes.js";
import { isValidSessionId } from "./structured-item.js";
import { pathsOverlap, pathKey, projectRealPath, withProjectWrite } from "./project-write.js";
import { validateExistingDirectory, withBindingState, writableProbe } from "./binding.js";

const failure = (code, extra = {}) => ({ ok: false, code, ...extra });
const allowedDirectories = new Set([...LANE_KEYS, ".carry-over"]);
const activeLocations = new Set();

function raise(code) { throw Object.assign(new Error(code), { code }); }

function directoryIdentity(stat) {
  return { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
}

function sameIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.birthtimeNs === right?.birthtimeNs;
}

function fileIdentity(stat) {
  return {
    ...directoryIdentity(stat),
    size: String(stat.size),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
    nlink: String(stat.nlink),
  };
}

function sameFileState(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

function managedDirectoryName(name, platform) {
  if (platform !== "win32") return allowedDirectories.has(name) ? name : null;
  const lowered = name.toLowerCase();
  return allowedDirectories.has(lowered) ? lowered : null;
}

function canonicalNoteFileName(name, directory, platform) {
  const extension = directory === ".carry-over" ? ".json" : ".md";
  const candidate = platform === "win32" ? name.toLowerCase() : name;
  if (!candidate.endsWith(extension)) return null;
  const session = candidate.slice(0, -extension.length);
  return isValidSessionId(session) ? `${session}${extension}` : null;
}

async function identityOfDirectory(root, platform = process.platform) {
  let stat;
  try { stat = await fs.lstat(root, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    raise("CONFIGURED_ROOT_UNAVAILABLE");
  }
  if (stat.isSymbolicLink()) raise("SYMLINK_REFUSED");
  if (!stat.isDirectory()) raise("LOCATION_INVALID");
  let real;
  try { real = await fs.realpath(root); } catch { raise("CONFIGURED_ROOT_UNAVAILABLE"); }
  if (pathKey(real, platform) !== pathKey(path.resolve(root), platform)) raise("LOCATION_INVALID");
  return { path: real, identity: directoryIdentity(stat) };
}

async function hashFile(file, expectedIdentity) {
  let handle;
  try { handle = await fs.open(file, "r"); }
  catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) raise("SOURCE_CHANGED");
    raise("LOCATION_INVALID");
  }
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile() || initial.nlink !== 1n || !sameFileState(expectedIdentity, fileIdentity(initial))) raise("SOURCE_CHANGED");
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      digest.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (!sameFileState(fileIdentity(initial), fileIdentity(after)) || offset !== Number(initial.size)) raise("SOURCE_CHANGED");
    return { size: Number(initial.size), hash: digest.digest("hex") };
  } catch (error) {
    if (error.code) throw error;
    raise("SOURCE_CHANGED");
  } finally { await handle.close().catch(() => {}); }
}

function manifestDigest(entries) {
  const content = entries.map(({ path: relative, kind, size, hash }) => ({
    path: relative,
    kind,
    ...(kind === "file" ? { size, hash } : {}),
  })).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

async function contentManifest(root, { strictRoot = false, platform = process.platform } = {}) {
  const rootInfo = await identityOfDirectory(root, platform);
  if (!rootInfo) raise("CONFIGURED_ROOT_UNAVAILABLE");
  const entries = [];
  let children;
  try { children = await fs.readdir(rootInfo.path, { withFileTypes: true }); }
  catch { raise("CONFIGURED_ROOT_UNAVAILABLE"); }

  const managedChildren = new Map();
  for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
    const managedName = managedDirectoryName(child.name, platform);
    if (!managedName) {
      if (strictRoot) raise("TARGET_NOT_EMPTY");
      continue;
    }
    const prior = managedChildren.get(managedName);
    if (prior) raise("AMBIGUOUS_NOTE_LAYOUT");
    managedChildren.set(managedName, child.name);
    const directory = path.join(rootInfo.path, child.name);
    let stat;
    try { stat = await fs.lstat(directory, { bigint: true }); } catch { raise("SOURCE_CHANGED"); }
    if (stat.isSymbolicLink()) raise("SYMLINK_REFUSED");
    if (!stat.isDirectory()) raise("UNKNOWN_NOTE_FILE");
    entries.push({ path: managedName, kind: "directory", identity: directoryIdentity(stat) });

    let files;
    try { files = await fs.readdir(directory, { withFileTypes: true }); } catch { raise("LOCATION_INVALID"); }
    const extension = managedName === ".carry-over" ? ".json" : ".md";
    const managedFiles = new Map();
    for (const fileEntry of files.sort((left, right) => left.name.localeCompare(right.name))) {
      const canonicalName = canonicalNoteFileName(fileEntry.name, managedName, platform);
      if (!canonicalName) raise("UNKNOWN_NOTE_FILE");
      if (managedFiles.has(canonicalName.toLowerCase())) raise("AMBIGUOUS_NOTE_LAYOUT");
      managedFiles.set(canonicalName.toLowerCase(), fileEntry.name);
      const file = path.join(directory, fileEntry.name);
      let fileStat;
      try { fileStat = await fs.lstat(file, { bigint: true }); } catch { raise("SOURCE_CHANGED"); }
      if (fileStat.isSymbolicLink() || fileStat.nlink !== 1n) raise("SYMLINK_REFUSED");
      if (!fileStat.isFile()) raise("UNKNOWN_NOTE_FILE");
      const identity = fileIdentity(fileStat);
      const content = await hashFile(file, identity);
      entries.push({
        path: `${managedName}/${canonicalName}`,
        sourcePath: file,
        kind: "file",
        size: content.size,
        hash: content.hash,
        identity,
      });
    }
  }
  return {
    root: rootInfo,
    entries,
    files: entries.filter((entry) => entry.kind === "file").length,
    digest: manifestDigest(entries),
  };
}

function sameSourceManifest(before, after) {
  if (before.digest !== after.digest || !sameIdentity(before.root.identity, after.root.identity)) return false;
  const beforeEntries = new Map(before.entries.map((entry) => [entry.path, entry]));
  if (beforeEntries.size !== after.entries.length) return false;
  return after.entries.every((entry) => {
    const original = beforeEntries.get(entry.path);
    if (!original || original.kind !== entry.kind) return false;
    if (entry.kind === "directory") return sameIdentity(original.identity, entry.identity);
    return original.size === entry.size && original.hash === entry.hash
      && sameFileState(original.identity, entry.identity);
  });
}

async function copyManifest(source, targetRoot) {
  for (const entry of source.entries) {
    const destination = path.join(targetRoot, ...entry.path.split("/"));
    if (entry.kind === "directory") await fs.mkdir(destination, { mode: 0o700 });
    else await fs.copyFile(entry.sourcePath || path.join(source.root.path, ...entry.path.split("/")), destination, fs.constants.COPYFILE_EXCL);
  }
}

async function activeKey(dataDir, projectPath, platform = process.platform) {
  const project = await projectRealPath(projectPath);
  if (!project) return null;
  const data = await fs.realpath(dataDir).catch(() => path.resolve(dataDir));
  return `${pathKey(data, platform)}\0${pathKey(project, platform)}`;
}

export async function isLocationChanging(dataDir, projectPath, { platform = process.platform } = {}) {
  if (platform !== "win32") return false;
  const key = await activeKey(dataDir, projectPath, platform);
  return Boolean(key && activeLocations.has(key));
}

export async function changeLocation(
  dataDir,
  projectPath,
  { expectedRoot, targetPath } = {},
  { platform = process.platform } = {},
) {
  if (typeof expectedRoot !== "string" || !path.isAbsolute(expectedRoot)
    || typeof targetPath !== "string" || !path.isAbsolute(targetPath)) return failure("INVALID_ARGUMENT");
  return withProjectWrite(dataDir, projectPath, async (project) => {
    const key = await activeKey(dataDir, project, platform);
    if (!key) return failure("PROJECT_INVALID");
    activeLocations.add(key);
    try {
      const result = await withBindingState(dataDir, async (state, persist) => {
        const binding = state.bindings[project];
        if (!binding || typeof binding.path !== "string") return failure("SETUP_REQUIRED");
        if (pathKey(binding.path, platform) !== pathKey(path.resolve(expectedRoot), platform)) {
          return failure("LOCATION_CHANGED", { root: binding.path });
        }

        const sourcePath = binding.path;
        if (pathKey(sourcePath, platform) === pathKey(path.resolve(targetPath), platform)) {
          return failure("LOCATION_UNCHANGED", { root: sourcePath });
        }
        const pendingDefault = binding.confirmedAt === null
          && pathKey(sourcePath, platform) === pathKey(path.join(project, "notes"), platform);
        const sourceRoot = await identityOfDirectory(sourcePath, platform);
        if (!sourceRoot && !pendingDefault) return failure("CONFIGURED_ROOT_UNAVAILABLE", { root: sourcePath });

        if (!(await validateExistingDirectory(targetPath))) return failure("LOCATION_INVALID", { root: sourcePath });
        const targetRoot = await fs.realpath(targetPath);
        if (pathsOverlap(sourcePath, targetRoot, platform)) return failure("LOCATION_OVERLAP", { root: sourcePath });
        for (const [otherProject, otherBinding] of Object.entries(state.bindings)) {
          if (otherProject === project) continue;
          if (typeof otherBinding?.path !== "string" || !path.isAbsolute(otherBinding.path)) {
            return failure("STATE_INVALID", { root: sourcePath });
          }
          if (pathsOverlap(targetRoot, otherBinding.path, platform)) return failure("LOCATION_OCCUPIED", { root: sourcePath });
        }
        if (!(await writableProbe(targetRoot))) return failure("LOCATION_UNUSABLE", { root: sourcePath });
        let targetChildren;
        try { targetChildren = await fs.readdir(targetRoot); } catch { return failure("LOCATION_UNUSABLE", { root: sourcePath }); }
        if (targetChildren.length) return failure("TARGET_NOT_EMPTY", { root: sourcePath });

        const targetInfo = await identityOfDirectory(targetRoot, platform);
        if (!targetInfo) return failure("LOCATION_INVALID", { root: sourcePath });
        const sourceManifest = sourceRoot ? await contentManifest(sourceRoot.path, { platform }) : {
          root: { path: sourcePath, identity: null }, entries: [], files: 0, digest: manifestDigest([]),
        };
        let copyingStarted = false;
        try {
          copyingStarted = sourceManifest.entries.length > 0;
          await copyManifest(sourceManifest, targetRoot);
          const afterTarget = await contentManifest(targetRoot, { strictRoot: true, platform });
          const targetStill = await identityOfDirectory(targetRoot, platform);
          if (!targetStill || !sameIdentity(targetInfo.identity, targetStill.identity)) raise("TARGET_CHANGED");
          const afterSource = sourceRoot
            ? await contentManifest(sourceRoot.path, { platform })
            : (await identityOfDirectory(sourcePath, platform) ? raise("SOURCE_CHANGED") : sourceManifest);
          if (!sameSourceManifest(sourceManifest, afterSource)) raise("SOURCE_CHANGED");
          if (sourceManifest.digest !== afterTarget.digest) raise("COPY_VERIFY_FAILED");

          const nextBinding = { path: targetRoot, confirmedAt: new Date().toISOString() };
          const written = await persist({ ...state, bindings: { ...state.bindings, [project]: nextBinding } });
          if (!written.ok) return failure(written.code || "STATE_WRITE_FAILED", {
            root: sourcePath, partialPath: targetRoot, copiedFiles: sourceManifest.files,
          });
          return { ok: true, oldRoot: sourcePath, root: targetRoot, copiedFiles: sourceManifest.files };
        } catch (error) {
          const known = ["SYMLINK_REFUSED", "UNKNOWN_NOTE_FILE", "AMBIGUOUS_NOTE_LAYOUT", "SOURCE_CHANGED", "TARGET_CHANGED", "COPY_VERIFY_FAILED", "TARGET_NOT_EMPTY", "LOCATION_UNUSABLE", "LOCATION_INVALID", "CONFIGURED_ROOT_UNAVAILABLE"];
          const code = known.includes(error.code) ? error.code : "COPY_FAILED";
          return failure(code, {
            root: sourcePath,
            ...(copyingStarted || (await fs.readdir(targetRoot).catch(() => [])).length ? { partialPath: targetRoot } : {}),
          });
        }
      }, { platform });
      return result?.code === "LOCKED" ? failure("LOCATION_BUSY") : result;
    } catch (error) {
      if (error.code === "LOCKED" || error.code === "LOCATION_BUSY") return failure("LOCATION_BUSY");
      const known = ["PROJECT_INVALID", "DATA_DIR_INVALID", "STATE_INVALID", "STATE_UNAVAILABLE", "STATE_WRITE_FAILED", "CONFIGURED_ROOT_UNAVAILABLE", "LOCATION_INVALID", "SYMLINK_REFUSED", "UNKNOWN_NOTE_FILE", "AMBIGUOUS_NOTE_LAYOUT", "SOURCE_CHANGED", "TARGET_CHANGED", "COPY_VERIFY_FAILED", "TARGET_NOT_EMPTY", "LOCATION_UNUSABLE"];
      return failure(known.includes(error.code) ? error.code : "LOCATION_INVALID");
    } finally { activeLocations.delete(key); }
  }, { platform });
}
