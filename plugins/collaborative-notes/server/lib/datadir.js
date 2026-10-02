import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const SAFE_PART = /^[A-Za-z0-9_.-]+$/;

export function parsePluginId(pluginId) {
  if (typeof pluginId !== "string") throw new Error("PLUGIN_ID_INVALID");
  const separator = pluginId.indexOf("@");
  if (separator <= 0 || separator !== pluginId.lastIndexOf("@")) {
    throw new Error("PLUGIN_ID_INVALID");
  }
  const name = pluginId.slice(0, separator);
  const marketplace = pluginId.slice(separator + 1);
  if (!SAFE_PART.test(name) || !SAFE_PART.test(marketplace)) {
    throw new Error("PLUGIN_ID_INVALID");
  }
  return { name, marketplace };
}

async function ensureDirectory(directory) {
  if (typeof directory !== "string" || !path.isAbsolute(directory)) {
    throw new Error("DATA_DIR_INVALID");
  }
  try {
    const stat = await fs.lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("DATA_DIR_INVALID");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await fs.chmod(directory, 0o700);
  return path.resolve(directory);
}

export function dataDirectoryPath(pluginId, {
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const { name, marketplace } = parsePluginId(pluginId);
  const codexHome = env.CODEX_HOME || path.join(homeDir, ".codex");
  return path.join(codexHome, "plugins", "data", `${name}-${marketplace}`);
}

export async function resolveDataDir({
  pluginId,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const direct = env.PLUGIN_DATA || env.CN_DATA_DIR;
  if (direct) return ensureDirectory(direct);
  return ensureDirectory(dataDirectoryPath(pluginId, { env, homeDir }));
}
