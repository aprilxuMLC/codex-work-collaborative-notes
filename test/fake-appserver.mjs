import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });

function fixture(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

const sourceItems = [
  { item: { type: "userMessage", id: "user-1", content: [{ type: "text", text: "## My request:\nA user request" }] }, turnId: "turn-1" },
  { item: { type: "agentMessage", id: "msg-1", text: "A **visible** assistant reply 🙂" }, turnId: "turn-1" },
  { item: { type: "reasoning", id: "reasoning-1", text: "hidden reasoning" }, turnId: "turn-1" },
  { item: { type: "commandExecution", id: "command-1", command: "hidden command" }, turnId: "turn-1" },
];
const sourceTurns = [{ id: "turn-1", items: sourceItems }];

input.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  let result = {};
  if (message.method === "thread/read") {
    result = {
      id: message.params.threadId,
      cwd: process.env.FAKE_THREAD_CWD,
      name: "Fake thread",
      preview: "Preview",
      ...(process.env.FAKE_FORK_CHILD === "1" ? { forkedFromId: process.env.FAKE_PARENT_THREAD_ID || "thread-parent" } : {}),
    };
  } else if (message.method === "thread/items/list") {
    const forkPrefix = Number(process.env.FAKE_FORK_PREFIX || sourceItems.length);
    const forkItems = process.env.FAKE_FORK_CHILD === "1" ? sourceItems.slice(0, Math.max(0, Math.min(sourceItems.length, forkPrefix))) : sourceItems;
    const fallback = process.env.FAKE_SOURCE_FIXTURE === "1" ? { data: process.env.FAKE_FORK_CHILD === "1" ? forkItems : sourceItems } : { items: [{ id: "item-1" }] };
    result = fixture("FAKE_THREAD_ITEMS_JSON", fixture("FAKE_ITEMS_JSON", fallback));
  } else if (message.method === "thread/turns/list") {
    const fallback = process.env.FAKE_SOURCE_FIXTURE === "1" ? { data: sourceTurns } : { turns: [{ id: "turn-1" }] };
    const configured = fixture("FAKE_THREAD_TURNS_JSON", fixture("FAKE_TURNS_JSON", fallback));
    if (process.env.FAKE_FORK_CHILD === "1" && process.env.FAKE_SOURCE_FIXTURE === "1") {
      const prefix = Number(process.env.FAKE_FORK_PREFIX || sourceItems.length);
      result = { ...configured, data: [{ ...sourceTurns[0], items: sourceTurns[0].items.slice(0, Math.max(0, Math.min(sourceItems.length, prefix))) }] };
    } else result = configured;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`);
});
