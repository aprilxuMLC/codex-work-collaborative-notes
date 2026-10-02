// Fixture produced by aprilxuMLC/dsh-collaborative-notes v0.1.1 lib/structured-item.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLaneBody, serializeLaneBody, getItemKey } from "../../plugins/collaborative-notes/server/lib/structured-item.js";

const DSH_FIXTURE = "intro\n--- dsh-note v1 begin\ndsh-meta kind: source-aware\ndsh-meta origin: 01a00000-0000-7000-8000-000000000001\ndsh-meta snapshot-length: 7\ndsh-meta source-payload: {\"sessionId\":\"01a00000-0000-7000-8000-000000000001\",\"messageId\":\"m1\"}\ndsh-meta item-key: ik-fixture-0001\n--- dsh-body\nx 中文🙂\ny\n--- dsh-note v1 end\n--- dsh-note v1 begin\ndsh-meta kind: source-independent\ndsh-meta origin: 01a00000-0000-7000-8000-000000000001\ndsh-meta body-length: 6\ndsh-meta item-key: ik-fixture-0002\n--- dsh-body\nplain\n\n--- dsh-note v1 end\n";

test("parses a DSH v0.1.1 lane body and round-trips it byte-identically", () => {
  const parsed = parseLaneBody(DSH_FIXTURE);
  const items = parsed.nodes.filter((n) => n.type === "item");
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((n) => getItemKey(n.item)), ["ik-fixture-0001", "ik-fixture-0002"]);
  assert.equal(items[0].item.snapshot, "x 中文🙂\ny");
  assert.equal(serializeLaneBody(parsed), DSH_FIXTURE);
});
