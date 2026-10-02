import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { dataDirectoryPath, parsePluginId, resolveDataDir } from "../../plugins/collaborative-notes/server/lib/datadir.js";

test("datadir derives the plugin data directory and validates plugin ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "cn-datadir-"));
  try {
    assert.deepEqual(parsePluginId("collaborative-notes@collaborative-notes"), {
      name: "collaborative-notes", marketplace: "collaborative-notes",
    });
    assert.equal(dataDirectoryPath("collaborative-notes@collaborative-notes", { homeDir: home }),
      path.join(home, ".codex", "plugins", "data", "collaborative-notes-collaborative-notes"));
    const directory = await resolveDataDir({ pluginId: "collaborative-notes@collaborative-notes", homeDir: home });
    assert.equal(directory, dataDirectoryPath("collaborative-notes@collaborative-notes", { homeDir: home }));
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
    assert.throws(() => parsePluginId("bad/name@marketplace"), /PLUGIN_ID_INVALID/);
  } finally { await fs.rm(home, { recursive: true, force: true }); }
});
