import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// True when this module is the script node was asked to run. Compares real
// paths, case-insensitively on Windows, where argv uses backslashes, drive
// letters may differ in case, and short (8.3) names can appear.
export function isEntryModule(moduleUrl, { argv1 = process.argv[1], platform = process.platform } = {}) {
  if (!argv1) return false;
  const real = (file) => {
    try { return realpathSync.native(file); } catch { return path.resolve(file); }
  };
  const a = real(argv1);
  const b = real(fileURLToPath(moduleUrl));
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
