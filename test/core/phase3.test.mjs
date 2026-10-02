import assert from "node:assert/strict";
import { test } from "node:test";

import { projectMarkdown } from "../../plugins/collaborative-notes/server/lib/render-text.js";
import { normalizeItems, stripHostUserPrefix } from "../../plugins/collaborative-notes/server/lib/thread-mirror.js";
import "../../plugins/collaborative-notes/server/panel/render.js";

test("Phase 3 text projection preserves CJK, emoji, code, and list content", () => {
  assert.equal(projectMarkdown("# 标题\n你好🙂\n- `代码`\n1. **项目**\n\n```js\nconst x = 1;\n```"), "标题\n你好🙂\n代码\n项目\n\nconst x = 1;");
});

test("Phase 3 mirror admits only user/assistant items and strips only known user wrappers", () => {
  const items = normalizeItems({ data: [
    { item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "## My request:\n请继续" }] }, turnId: "t1" },
    { item: { type: "agentMessage", id: "a1", text: "回复" }, turnId: "t1" },
    { item: { type: "reasoning", id: "r1", text: "不要显示" }, turnId: "t1" },
    { item: { type: "commandExecution", id: "c1", command: "不要显示" }, turnId: "t1" },
  ] }, "thread-abcdefgh");
  assert.deepEqual(items.map(({ id, role, text }) => ({ id, role, text })), [
    { id: "u1", role: "user", text: "请继续" },
    { id: "a1", role: "assistant", text: "回复" },
  ]);
  assert.equal(stripHostUserPrefix("## My request is literal\n保留"), "## My request is literal\n保留");
});

test("R1 mirror DOM text equals the server projection across lists, paragraphs and blocks", () => {
  // Minimal DOM: Range.toString() over the article is the concatenation of its text nodes.
  const node = (tag) => ({ tag, children: [], append(...items) { this.children.push(...items); },
    replaceChildren() { this.children = []; }, set textContent(value) { this.children = [{ text: value }]; } });
  const previous = globalThis.document;
  globalThis.document = { createElement: node, createTextNode: (text) => ({ text }) };
  const textOf = (item) => item.text ?? item.children.map(textOf).join("");
  try {
    const renderer = globalThis.CollaborativeNotesRenderer;
    for (const value of [
      "- alpha\n- beta\n\nfirst line\nsecond line",
      "Intro **bold**\n\n1. one\n2. `two`\n## Head\n```js\na\nb\n```\ntail",
    ]) {
      const article = node("article");
      renderer.renderMarkdown(value, article);
      assert.equal(textOf(article), renderer.projectMarkdown(value));
    }
  } finally { globalThis.document = previous; }
});
