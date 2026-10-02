import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function normalizeLocale(value) {
  return typeof value === "string" && value.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export async function readLocaleOverride({
  homeDir = os.homedir(),
  configPath = path.join(homeDir, ".codex", "config.toml"),
} = {}) {
  let text;
  try { text = await fs.readFile(configPath, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return undefined;
    return undefined;
  }
  let section = "";
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section) continue;
    const match = line.match(/^\s*localeOverride\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/);
    if (match) return match[1] ?? match[2] ?? match[3];
  }
  return undefined;
}

export async function detectLocale({
  acceptLanguage,
  homeDir,
  configPath,
} = {}) {
  const override = await readLocaleOverride({ homeDir, configPath });
  return normalizeLocale(override ?? acceptLanguage ?? "en");
}
