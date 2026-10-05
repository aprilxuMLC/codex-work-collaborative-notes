import test from "node:test";
import assert from "node:assert/strict";
import { parseWindowsDriveRoots, windowsPathBreadcrumbs } from "../../plugins/collaborative-notes/server/service.mjs";

test("fsutil drive output yields mounted drive roots with whitespace boundaries", () => {
  assert.deepEqual(parseWindowsDriveRoots("Drives: C:\\ D:\\ Q:\\"), ["C:\\", "D:\\", "Q:\\"]);
});

test("Windows breadcrumbs preserve drive roots and UNC shares", () => {
  assert.deepEqual(windowsPathBreadcrumbs("D:\\中文\\项目"), [
    { name: "D:\\", path: "D:\\" },
    { name: "中文", path: "D:\\中文" },
    { name: "项目", path: "D:\\中文\\项目" },
  ]);
  assert.deepEqual(windowsPathBreadcrumbs("\\\\server\\share\\folder").map((item) => item.path), [
    "\\\\server\\share\\", "\\\\server\\share\\folder",
  ]);
});
