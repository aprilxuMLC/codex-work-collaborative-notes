import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildMirrorOutline,
  searchMirrorTurns,
} from "../../plugins/collaborative-notes/server/lib/thread-mirror.js";

function turn(turnId, index) {
  return {
    turnId,
    time: `2026-10-01T00:0${index}:00.000Z`,
    items: [
      { id: `u-${index}`, role: "user", text: `User ${index}` },
      { id: `a-${index}`, role: "assistant", text: `Answer ${index}`, phase: "commentary" },
    ],
  };
}

test("S7 outline is newest first with compact heads and noted item ids", () => {
  const turns = [
    {
      turnId: "turn-1",
      time: "2026-10-01T00:01:00.000Z",
      items: [
        { id: "u-1", role: "user", text: "  first\nrequest  " },
        { id: "a-1", role: "assistant", text: "fallback answer" },
      ],
    },
    {
      turnId: "turn-2",
      time: "2026-10-01T00:02:00.000Z",
      items: [
        { id: "u-2", role: "user", text: "second request" },
        { id: "a-2c", role: "assistant", phase: "commentary", text: "commentary answer" },
        { id: "a-2f", role: "assistant", phase: "final_answer", text: "final answer" },
      ],
    },
  ];

  assert.deepEqual(buildMirrorOutline(turns, new Set(["a-2f"])), [
    { turnId: "turn-2", index: 2, time: "2026-10-01T00:02:00.000Z", userHead: "second request", answerHead: "final answer", noted: true },
    { turnId: "turn-1", index: 1, time: "2026-10-01T00:01:00.000Z", userHead: "first request", answerHead: "fallback answer", noted: false },
  ]);
});

test("S7 search collapses whitespace, ignores case, and caps results at 50", () => {
  const turns = Array.from({ length: 60 }, (_value, index) => ({
    ...turn("turn-" + index, index % 10),
    items: [{ id: `item-${index}`, role: "assistant", text: `Alpha\nBeta ${index}` }],
  }));
  const results = searchMirrorTurns(turns, "aLpHa\nBeTa");
  assert.equal(results.length, 50);
  assert.equal(results[0].turnId, "turn-59");
  assert.equal(results[0].role, "assistant");
  assert.equal(results[0].matches, 1);
  assert.match(results[0].snippet, /Alpha Beta 59/);
});
