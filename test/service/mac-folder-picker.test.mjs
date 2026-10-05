import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";

import { MacFolderPicker, MAC_FOLDER_PICKER_SCRIPT } from "../../plugins/collaborative-notes/server/lib/mac-folder-picker.js";

function fixture({ selectMs = 300_000, lstat } = {}) {
  const children = [];
  const spawn = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.killCalls = 0;
    child.kill = () => {
      child.killCalls += 1;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    };
    children.push({ child, file, args, options });
    return child;
  };
  const picker = new MacFolderPicker({
    platform: "darwin",
    spawn,
    homeDir: () => "/Users/tester",
    lstat: lstat || (async () => ({ isDirectory: () => true, isSymbolicLink: () => false })),
    selectMs,
  });
  return { picker, children };
}

function closeWith(child, code, stderr = "") {
  if (stderr) child.stderr.end(stderr);
  child.exitCode = code;
  child.emit("close", code, null);
}

test("macOS picker passes title and initial path as argv and returns a normalized path", async () => {
  const f = fixture();
  const title = 'Notes "quoted" folder';
  const pending = f.picker.select({ title, initialPath: "/tmp/start" });
  await new Promise(resolve => setImmediate(resolve));
  const invocation = f.children[0];
  assert.equal(invocation.file, "/usr/bin/osascript");
  assert.equal(invocation.options.cwd, "/Users/tester");
  assert.equal(invocation.options.shell, false);
  assert.deepEqual(invocation.options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(invocation.args.at(-2), title);
  assert.equal(invocation.args.at(-1), "/tmp/start");
  assert.doesNotMatch(invocation.args[1], /quoted|\/tmp\/start/);
  assert.match(MAC_FOLDER_PICKER_SCRIPT, /on run argv/);
  invocation.child.stdout.end("/tmp/chosen/\n");
  closeWith(invocation.child, 0);
  assert.deepEqual(await pending, { status: "selected", path: "/tmp/chosen" });
});

test("missing initial path omits the default location argument", async () => {
  const f = fixture({ lstat: async value => {
    if (value === "/tmp/missing") throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return { isDirectory: () => true, isSymbolicLink: () => false };
  } });
  const pending = f.picker.select({ title: "Notes", initialPath: "/tmp/missing" });
  await new Promise(resolve => setImmediate(resolve));
  const invocation = f.children[0];
  assert.equal(invocation.args.at(-1), "");
  invocation.child.stdout.end("/tmp/chosen\n");
  closeWith(invocation.child, 0);
  assert.deepEqual(await pending, { status: "selected", path: "/tmp/chosen" });
});

test("AppleScript user cancellation returns cancelled", async () => {
  const f = fixture();
  const pending = f.picker.select({ title: "Notes" });
  await new Promise(resolve => setImmediate(resolve));
  closeWith(f.children[0].child, 1, "execution error: User canceled. (-128)\n");
  assert.deepEqual(await pending, { status: "cancelled" });
});

test("other osascript failures and invalid selected paths fail truthfully", async () => {
  const failed = fixture();
  const failure = failed.picker.select({ title: "Notes" });
  await new Promise(resolve => setImmediate(resolve));
  closeWith(failed.children[0].child, 1, "execution error: permission denied\n");
  await assert.rejects(failure, error => error.code === "PICKER_FAILED");

  const invalid = fixture({ lstat: async () => ({ isDirectory: () => false, isSymbolicLink: () => false }) });
  const invalidResult = invalid.picker.select({ title: "Notes" });
  await new Promise(resolve => setImmediate(resolve));
  invalid.children[0].child.stdout.end("/tmp/file\n");
  closeWith(invalid.children[0].child, 0);
  await assert.rejects(invalidResult, error => error.code === "LOCATION_INVALID");
});

test("timeout and abort kill the owned child", async () => {
  const timeout = fixture({ selectMs: 5 });
  const timed = timeout.picker.select({ title: "Notes" });
  await assert.rejects(timed, error => error.code === "PICKER_TIMEOUT");
  assert.equal(timeout.children[0].child.killCalls, 1);

  const aborted = fixture();
  const controller = new AbortController();
  const pending = aborted.picker.select({ title: "Notes", signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  assert.deepEqual(await pending, { status: "cancelled" });
  assert.equal(aborted.children[0].child.killCalls, 1);
});

test("only one macOS dialog can be active per picker", async () => {
  const f = fixture();
  const first = f.picker.select({ title: "Notes" });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.picker.select({ title: "Notes" }), error => error.code === "PICKER_BUSY");
  closeWith(f.children[0].child, 1, "User canceled (-128)");
  assert.deepEqual(await first, { status: "cancelled" });
});
