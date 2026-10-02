import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLaneRef, resolveLanes } from "../../plugins/collaborative-notes/server/lib/lanes.js";

test("maps display ids, labels and keys to lane keys; rejects unknown refs", () => {
  const lanes = resolveLanes({ laneOverrides: { deferred_work: { label: "转BACKLOG" } } });
  for (const ref of ["L2", "l2", "2", "deferred_work", "转BACKLOG", "L2 转BACKLOG", "Deferred Work", "延后工作"]) {
    assert.equal(normalizeLaneRef(ref, lanes), "deferred_work", ref);
  }
  assert.equal(normalizeLaneRef("L1", lanes), "conversation_todo");
  assert.equal(normalizeLaneRef("L9", lanes), null);
  assert.equal(normalizeLaneRef("", lanes), null);
});
