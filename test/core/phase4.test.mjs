import assert from "node:assert/strict";
import { test } from "node:test";

import {
  filterEligibleBody,
  mergeCarryBodies,
  rekeyCarriedBody,
  sourceEligible,
} from "../../plugins/collaborative-notes/server/lib/carry.js";
import { stripHostBlocks } from "../../plugins/collaborative-notes/server/lib/host-blocks.js";
import {
  KIND_SOURCE_AWARE,
  KIND_SOURCE_INDEPENDENT,
  makeItem,
  parseLaneBody,
  serializeItem,
  serializeLaneBody,
  withItemKey,
} from "../../plugins/collaborative-notes/server/lib/structured-item.js";
import {
  renderReferenceText,
  resolveReferenceTargets,
} from "../../plugins/collaborative-notes/server/lib/reference-binding.js";
import { sourceTurns } from "../../plugins/collaborative-notes/server/lib/thread-mirror.js";

const parentThreadId = "thread-parent";
const childThreadId = "thread-child";
const foreignThreadId = "thread-foreign";

function note({
  key,
  content = "content",
  captureOrigin = parentThreadId,
  source,
  snapshot = "source snapshot",
  host = "codex",
} = {}) {
  const item = makeItem({
    kind: source ? KIND_SOURCE_AWARE : KIND_SOURCE_INDEPENDENT,
    captureOrigin,
    ...(source ? { snapshot, sourcePayload: source } : {}),
    comment: content,
    host,
  });
  return withItemKey(item, key || `key-${content}`);
}

function body(...items) {
  return serializeLaneBody({
    nodes: items.map((item) => ({ type: "item", item })),
    trailingNewline: false,
  });
}

test("Phase 4 carry eligibility keeps source-less and inherited notes, excludes parent-after-cut notes, and keeps sources in neither history including a parent-session source", () => {
  const childItemIds = new Set(["inherited-message"]);
  const parentItemIds = new Set(["after-cut-message"]);
  const cases = [
    [note({ key: "plain" }), true],
    [note({ key: "inherited", source: { sessionId: foreignThreadId, messageId: "inherited-message" } }), true],
    [note({ key: "after-cut", source: { sessionId: parentThreadId, messageId: "after-cut-message" } }), false],
    [note({ key: "foreign", source: { sessionId: parentThreadId, messageId: "not-in-either-history" } }), true],
    [note({ key: "other-thread", source: { sessionId: foreignThreadId, messageId: "not-in-either-history-2" } }), true],
  ];

  for (const [item, expected] of cases) {
    assert.equal(sourceEligible(item, parentThreadId, childItemIds, parentItemIds), expected, item.captureOrigin);
  }

  const filtered = filterEligibleBody(body(...cases.map(([item]) => item)), {
    parentThreadId,
    childItemIds,
    parentItemIds,
  });
  const keptKeys = parseLaneBody(filtered).nodes.map((node) => node.item.unknownMeta.at(-1).raw);
  assert.deepEqual(keptKeys, [
    "dsh-meta item-key: plain",
    "dsh-meta item-key: inherited",
    "dsh-meta item-key: foreign",
    "dsh-meta item-key: other-thread",
  ]);
});

test("Phase 4 multi-level A→B→C eligibility excludes a source in A after C's cut when it is in parent history but absent from child history", () => {
  const source = note({
    key: "a-after-c-cut",
    source: { sessionId: "thread-a", messageId: "a-message-after-c-cut" },
  });
  assert.equal(sourceEligible(source, "thread-b", new Set(["b-inherited"]), new Set(["a-message-after-c-cut"])), false);
});

test("Phase 4 rekeyCarriedBody assigns new item keys while preserving captureOrigin, source payload, snapshot, host, and authored bytes", () => {
  const original = note({
    key: "old-key",
    content: "comment 🙂\nsecond line",
    source: { sessionId: foreignThreadId, messageId: "message-1" },
    snapshot: "selected 中文🙂",
    host: "codex-desktop",
  });
  const originalBody = serializeItem(original);
  const copied = rekeyCarriedBody(originalBody);
  const parsed = parseLaneBody(copied.body).nodes[0].item;

  assert.equal(copied.carriedKeys.length, 1);
  assert.notEqual(copied.carriedKeys[0], "old-key");
  assert.equal(parsed.captureOrigin, original.captureOrigin);
  assert.deepEqual(parsed.sourcePayload, original.sourcePayload);
  assert.equal(parsed.snapshot, original.snapshot);
  assert.equal(parsed.comment, original.comment);
  assert.equal(parsed.host, original.host);
  const withoutItemKey = (value) => value.replace(/dsh-meta item-key: [^\n]+/g, "dsh-meta item-key: <new-key>");
  assert.equal(withoutItemKey(copied.body), withoutItemKey(originalBody));
  assert.match(copied.body, /dsh-meta source-payload: \{"sessionId":"thread-foreign","messageId":"message-1"\}/);
  assert.match(copied.body, /selected 中文🙂comment 🙂/);
  assert.doesNotMatch(copied.body, /dsh-meta item-key: old-key/);
});

test("Phase 4 mergeCarryBodies places structured parent notes before current notes", () => {
  const parent = body(note({ key: "parent", content: "parent first" }));
  const current = body(note({ key: "current", content: "current second" }));
  const merged = mergeCarryBodies(parent, current);
  const items = parseLaneBody(merged).nodes.map((node) => node.item.comment);
  assert.deepEqual(items, ["parent first", "current second"]);
});

test("Phase 4 stripHostBlocks removes complete real host wrappers and ## My request while preserving unknown or incomplete content", () => {
  const ambient = stripHostBlocks(
    '<in-app-browser-context source="ambient-ui-state">\nhttp://127.0.0.1:4321/t/thread-child\n</in-app-browser-context>\n## My request:\nDo the work',
  );
  assert.deepEqual(ambient, { text: "Do the work", stripped: ["ambient-ui-state", "my-request"] });

  const annotations = stripHostBlocks(
    "# Response annotations:\n<response-annotations>\nsource metadata\n</response-annotations>\n## My request:\n继续",
  );
  assert.deepEqual(annotations, { text: "继续", stripped: ["response-annotations", "my-request"] });

  const otherAmbient = stripHostBlocks('<browser-state source="ambient-ui-state">state</browser-state>\n## My request:\n请求');
  assert.deepEqual(otherAmbient, { text: "请求", stripped: ["ambient-ui-state", "my-request"] });
  assert.deepEqual(stripHostBlocks("## My request is literal\nkeep"), { text: "## My request is literal\nkeep", stripped: [] });
  assert.deepEqual(stripHostBlocks("<in-app-browser-context source=\"ambient-ui-state\">incomplete"), {
    text: '<in-app-browser-context source="ambient-ui-state">incomplete',
    stripped: [],
  });
  assert.deepEqual(stripHostBlocks("unknown prefix\n## My request:\nkeep"), {
    text: "unknown prefix\n## My request:\nkeep",
    stripped: [],
  });
});

test("Phase 4 reference rendering has no item keys or pin state", () => {
  const resolved = resolveReferenceTargets({ conversation_todo: [
    {
      addressable: true,
      itemKey: "ik-secret",
      kind: KIND_SOURCE_AWARE,
      authored: "follow up",
      sourceSnapshot: "quoted text",
      source: { threadId: parentThreadId, itemId: "message-1" },
    },
  ] }, [{ lane: "conversation_todo", itemKey: "ik-secret" }]);
  assert.equal(resolved.ok, true);
  const rendered = renderReferenceText(resolved.notes, { conversation_todo: "Conversation To-do" });
  assert.equal(rendered.ok, true);
  assert.match(rendered.text, /Referenced Notes \(1\)/);
  assert.match(rendered.text, /Note content: follow up/);
  assert.match(rendered.text, /Source selection: quoted text/);
  assert.match(rendered.text, /Source: thread thread-parent, message message-1/);
  assert.doesNotMatch(rendered.text, /ik-secret|pin/i);
});

test("Phase 4 source re-entry excludes the calling turn and incomplete turns", async () => {
  const targetItem = { type: "agentMessage", id: "target-message", text: "target" };
  const currentItem = { type: "agentMessage", id: "current-message", text: "current" };
  const openItem = { type: "agentMessage", id: "open-message", text: "open" };
  const appserver = {
    async listTurns(_threadId, options = {}) {
      if (!options.cursor) {
        return {
          data: [
            { id: "turn-target", status: "completed", items: [{ item: targetItem }] },
            { id: "turn-calling", status: "completed", items: [{ item: currentItem }] },
          ],
          nextCursor: "page-2",
        };
      }
      return { data: [{ id: "turn-open", status: "in_progress", items: [{ item: openItem }] }] };
    },
  };
  const result = await sourceTurns(appserver, childThreadId, "target-message", 2, 2, { excludeTurnId: "turn-calling" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turns.map((turn) => turn.turnId), ["turn-target"]);
  assert.equal(result.turns.some((turn) => turn.turnId === "turn-calling"), false);
  assert.equal(result.turns.some((turn) => turn.turnId === "turn-open"), false);
});

test("stripHostBlocks handles the real host serialization (leading newline, instruction paragraph)", async () => {
  const { stripHostBlocks } = await import("../../plugins/collaborative-notes/server/lib/host-blocks.js");
  const ambient = "\n<in-app-browser-context source=\"ambient-ui-state\">\nThis block is automatically supplied ambient UI state, not part of the user's request.\n# In app browser:\n- Current URL: http://127.0.0.1:47350/t/x\n</in-app-browser-context>\n\n## My request:\n根据我附上的便签\n";
  const annotations = "\n# Response annotations:\nEach item contains text selected from an earlier Codex response.\n<response-annotations>\n[{\"text\":\"x\"}]\n</response-annotations>\n\n## My request:\n请看这段\n";
  assert.equal(stripHostBlocks(ambient).text, "根据我附上的便签");
  assert.equal(stripHostBlocks(annotations).text, "请看这段");
  assert.equal(stripHostBlocks("\n普通消息\n").text, "\n普通消息\n");
});
