import { spawn as defaultSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

const OSASCRIPT = "/usr/bin/osascript";
const DEFAULT_SELECTION_MS = 5 * 60 * 1000;
const failure = code => Object.assign(new Error(code), { code });

// Keep all user-controlled values out of the script source. osascript passes
// the title and optional initial directory through on run argv instead.
export const MAC_FOLDER_PICKER_SCRIPT = `on run argv
  set pickerTitle to item 1 of argv
  set initialPath to item 2 of argv
  tell me to activate
  if initialPath is "" then
    POSIX path of (choose folder with prompt pickerTitle)
  else
    POSIX path of (choose folder with prompt pickerTitle default location (POSIX file initialPath))
  end if
end run`;

function validText(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function trimSelectedPath(value) {
  const trimmed = String(value).replace(/[\r\n]+$/, "");
  return trimmed.length > 1 ? trimmed.replace(/\/+$/, "") : trimmed;
}

function isCancelDiagnostic(stderr) {
  return /(?:\(-128\)|\b-128\b|user\s+cancell?ed)/i.test(stderr);
}

export class MacFolderPicker {
  constructor({
    platform = process.platform,
    spawn = defaultSpawn,
    lstat = fs.lstat,
    homeDir = os.homedir,
    selectMs = DEFAULT_SELECTION_MS,
  } = {}) {
    this.platform = platform;
    this.spawn = spawn;
    this.lstat = lstat;
    this.homeDir = homeDir;
    this.selectMs = selectMs;
    this.job = null;
    this.closed = false;
  }

  get active() {
    return this.job !== null;
  }

  async initialArgument(initialPath) {
    if (typeof initialPath !== "string" || !path.isAbsolute(initialPath)
      || /[\u0000-\u001f\u007f]/.test(initialPath)) return "";
    try {
      const stat = await this.lstat(initialPath);
      return stat.isDirectory() && !stat.isSymbolicLink() ? initialPath : "";
    } catch {
      return "";
    }
  }

  async select({ initialPath, title, signal } = {}) {
    if (this.closed) throw failure("SERVICE_CLOSING");
    if (this.platform !== "darwin") throw failure("PICKER_UNAVAILABLE");
    if (this.job) throw failure("PICKER_BUSY");
    if (signal?.aborted) return { status: "cancelled" };
    if (!validText(title, 200)) throw failure("PICKER_FAILED");

    const reservation = {};
    this.job = reservation;
    try {
      const initial = await this.initialArgument(initialPath);
      if (this.closed) throw failure("SERVICE_CLOSING");
      if (signal?.aborted) return { status: "cancelled" };

      let child;
      try {
        child = this.spawn(OSASCRIPT, ["-e", MAC_FOLDER_PICKER_SCRIPT, "--", title, initial], {
          cwd: this.homeDir(),
          shell: false,
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        throw failure("PICKER_UNAVAILABLE");
      }
      const jobPromise = new Promise((resolve, reject) => {
        const job = { child, cancelled: false, killed: false, settled: false };
        this.job = job;
        let stdout = "";
        let stderr = "";
        let timer;

        const clear = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        const kill = () => {
          if (job.killed) return;
          job.killed = true;
          try { child.kill(); } catch { /* the close event still decides the result */ }
        };
        const cancel = (error = null) => {
          if (job.cancelled || job.settled) return;
          job.cancelled = true;
          job.error = error;
          kill();
        };
        const abort = () => cancel();
        const finish = (value, error) => {
          if (job.settled) return;
          job.settled = true;
          clear();
          if (error) reject(error);
          else resolve(value);
        };

        this.job = job;
        signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() => cancel(failure("PICKER_TIMEOUT")), this.selectMs);

        child.stdout?.on("data", chunk => { stdout += Buffer.from(chunk).toString("utf8"); });
        child.stderr?.on("data", chunk => { stderr += Buffer.from(chunk).toString("utf8"); });
        child.stdout?.on("error", () => cancel(failure("PICKER_FAILED")));
        child.stderr?.on("error", () => cancel(failure("PICKER_FAILED")));
        child.on("error", error => cancel(failure(error?.code === "ENOENT" ? "PICKER_UNAVAILABLE" : "PICKER_FAILED")));
        child.once("close", (code, signalCode) => {
          if (job.error) {
            finish(null, job.error);
            return;
          }
          if (job.cancelled) {
            finish({ status: "cancelled" });
            return;
          }
          if (code !== 0 || signalCode) {
            if (isCancelDiagnostic(stderr)) finish({ status: "cancelled" });
            else finish(null, failure("PICKER_FAILED"));
            return;
          }
          const selectedPath = trimSelectedPath(stdout);
          if (!selectedPath) {
            finish(null, failure("PICKER_FAILED"));
            return;
          }
          if (!path.isAbsolute(selectedPath) || /[\u0000-\u001f\u007f]/.test(selectedPath)) {
            finish(null, failure("LOCATION_INVALID"));
            return;
          }
          Promise.resolve(this.lstat(selectedPath)).then(stat => {
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
              finish(null, failure("LOCATION_INVALID"));
              return;
            }
            finish({ status: "selected", path: trimSelectedPath(selectedPath) });
          }, () => finish(null, failure("LOCATION_INVALID")));
        });
        if (signal?.aborted) abort();
      });
      const activeJob = this.job;
      if (activeJob?.child === child) activeJob.done = jobPromise;
      return await jobPromise;
    } finally {
      if (this.job === reservation) this.job = null;
      else if (this.job?.child) this.job = null;
    }
  }

  async close() {
    this.closed = true;
    const job = this.job;
    if (!job) return;
    if (job.child) {
      if (!job.cancelled) {
        job.cancelled = true;
        job.error = null;
      }
      try { job.child.kill(); } catch { /* best effort */ }
    }
    if (job.done) await job.done;
  }
}
