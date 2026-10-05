import {
  BEGIN_LINE,
  KIND_SOURCE_AWARE,
  KIND_SOURCE_INDEPENDENT,
  getItemKey,
  inspectItemKey,
  makeItem,
  newItemKey,
  parseLaneBody,
  serializeItem,
  serializeLaneBody,
  withItemKey,
} from "./structured-item.js";
import { ensureRootForWrite, resolveRoot } from "./binding.js";
import { readLane, writeLane } from "./lane-store.js";
import { isLaneKey } from "./lanes.js";
import { withProjectWrite } from "./project-write.js";

const failure = (code, extra = {}) => ({ ok: false, code, ...extra });

function validContext(ctx) {
  return ctx && typeof ctx === "object"
    && typeof ctx.dataDir === "string"
    && typeof ctx.projectPath === "string"
    && typeof ctx.holder === "string";
}

async function resolveOperationRoot(ctx, forWrite = false) {
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  const resolved = forWrite
    ? await ensureRootForWrite(ctx.dataDir, ctx.projectPath, { platform: ctx.platform })
    : await resolveRoot(ctx.dataDir, ctx.projectPath, { platform: ctx.platform });
  return resolved.ok ? resolved : resolved;
}

async function loadLane(ctx, lane, forWrite = false) {
  if (!isLaneKey(lane)) return failure("INVALID_LANE");
  const root = await resolveOperationRoot(ctx, forWrite);
  if (!root.ok) return root;
  if (root.pendingDefault) return {
    root: root.root,
    lane: { status: "absent", version: "0", body: "" },
  };
  const laneState = await readLane(root.root, lane, ctx.holder);
  if (laneState.ok === false) return laneState;
  return { root: root.root, lane: laneState };
}

function noteView(item) {
  const itemKey = getItemKey(item);
  const view = {
    ...(itemKey ? { addressable: true, itemKey } : { addressable: false, reason: "NO_ITEM_KEY" }),
    kind: item.kind,
    authored: item.comment ?? "",
    captureOrigin: item.captureOrigin,
  };
  if (item.kind === KIND_SOURCE_AWARE) view.sourceSnapshot = item.snapshot;
  if (item.sourcePayload) {
    view.source = {
      threadId: item.sourcePayload.sessionId,
      itemId: item.sourcePayload.messageId,
    };
  }
  if (item.host !== undefined) view.host = item.host;
  return view;
}

function isOpaqueLegacy(text) {
  return text.includes(BEGIN_LINE);
}

function readResult(lane, parsed) {
  const notes = [];
  for (const node of parsed.nodes) {
    if (node.type === "item") {
      notes.push(noteView(node.item));
    } else if (isOpaqueLegacy(node.text)) {
      notes.push({ kind: "opaque", addressable: false });
    } else {
      notes.push({ kind: "legacy", addressable: false, text: node.text });
    }
  }
  return { status: lane.status, version: lane.version, notes };
}

export async function readNotes(ctx, lane) {
  const loaded = await loadLane(ctx, lane);
  if (loaded.ok === false) return loaded;
  const parsed = parseLaneBody(loaded.lane.body);
  return { ...readResult(loaded.lane, parsed), lane };
}

function appendBody(body, item) {
  const block = serializeItem(item);
  if (body.length === 0) return block;
  return body.endsWith("\n") ? body + block : `${body}\n${block}`;
}

async function appendItem(ctx, lane, item, { overwrite = false } = {}) {
  for (let attempt = 0; attempt < (overwrite ? 3 : 1); attempt += 1) {
    const loaded = await loadLane(ctx, lane, true);
    if (loaded.ok === false) return loaded;
    const body = appendBody(loaded.lane.body, item);
    const written = await writeLane(loaded.root, lane, ctx.holder, body, {
      expectedVersion: loaded.lane.version,
    });
    if (written.ok) {
      const note = noteView(item);
      return { ok: true, version: written.version, itemKey: note.itemKey, note };
    }
    if (!overwrite || written.code !== "STALE") return written;
  }
  return failure("STALE");
}

async function createNoteUnlocked(ctx, lane, { content, overwrite = false } = {}) {
  if (typeof content !== "string" || content.trim().length === 0) return failure("EMPTY_CONTENT");
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  try {
    const item = withItemKey(makeItem({
      kind: KIND_SOURCE_INDEPENDENT,
      captureOrigin: ctx.holder,
      comment: content,
      host: "codex",
    }), newItemKey());
    return await appendItem(ctx, lane, item, { overwrite });
  } catch { return failure("INVALID_ARGUMENT"); }
}

async function createSourcedNoteUnlocked(ctx, lane, {
  snapshot,
  source,
  comment = "",
} = {}) {
  if (typeof snapshot !== "string" || snapshot.length === 0) return failure("EMPTY_SNAPSHOT");
  if (!source || typeof source !== "object") return failure("INVALID_SOURCE");
  if (typeof comment !== "string") return failure("INVALID_CONTENT");
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  try {
    const item = withItemKey(makeItem({
      kind: KIND_SOURCE_AWARE,
      captureOrigin: ctx.holder,
      snapshot,
      comment,
      sourcePayload: { sessionId: source.threadId, messageId: source.itemId },
      host: "codex",
    }), newItemKey());
    return await appendItem(ctx, lane, item);
  } catch { return failure("INVALID_SOURCE"); }
}

function matchingNodes(parsed, itemKey) {
  return parsed.nodes.filter((node) => node.type === "item" && getItemKey(node.item) === itemKey);
}

function staleResult(lane) {
  return failure("STALE", { version: lane.version, body: lane.body });
}

async function loadForMutation(ctx, lane, expectedVersion) {
  const loaded = await loadLane(ctx, lane, false);
  if (loaded.ok === false) return loaded;
  if (loaded.lane.version !== expectedVersion) return staleResult(loaded.lane);
  return loaded;
}

async function editNoteUnlocked(ctx, lane, itemKey, content, expectedVersion, { overwrite = false } = {}) {
  if (typeof content !== "string") return failure("INVALID_CONTENT");
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  const attempts = overwrite ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const loaded = overwrite
      ? await loadLane(ctx, lane, false)
      : await loadForMutation(ctx, lane, expectedVersion);
    if (loaded.ok === false) return loaded;
    const parsed = parseLaneBody(loaded.lane.body);
    const matches = matchingNodes(parsed, itemKey);
    if (matches.length === 0) return failure("ITEM_UNRESOLVED");
    if (matches.length > 1) return failure("ITEM_AMBIGUOUS");
    const node = matches[0];
    if (node.item.kind === KIND_SOURCE_INDEPENDENT && content.trim().length === 0) {
      return failure("EMPTY_CONTENT");
    }
    node.item.comment = content;
    const body = serializeLaneBody(parsed);
    const written = await writeLane(loaded.root, lane, ctx.holder, body, { expectedVersion: loaded.lane.version });
    if (written.ok) {
      const note = noteView(node.item);
      return { ok: true, version: written.version, itemKey: note.itemKey, note };
    }
    if (!overwrite || written.code !== "STALE") return written;
  }
  return failure("STALE");
}

function tidyDeleted(parsed, deletedIndex) {
  const remaining = parsed.nodes.filter((_node, index) => index !== deletedIndex);
  if (remaining.length === 0) return { nodes: [], trailingNewline: false };
  const previous = remaining[deletedIndex - 1];
  const next = remaining[deletedIndex];
  if (previous?.type === "legacy") previous.text = previous.text.replace(/\n+$/g, "");
  if (next?.type === "legacy") next.text = next.text.replace(/^\n+/g, "");
  return { nodes: remaining, trailingNewline: parsed.trailingNewline };
}

async function deleteNoteUnlocked(ctx, lane, itemKey, expectedVersion) {
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  const loaded = await loadForMutation(ctx, lane, expectedVersion);
  if (loaded.ok === false) return loaded;
  const parsed = parseLaneBody(loaded.lane.body);
  const matches = matchingNodes(parsed, itemKey);
  if (matches.length === 0) return failure("ITEM_UNRESOLVED");
  if (matches.length > 1) return failure("ITEM_AMBIGUOUS");
  const index = parsed.nodes.indexOf(matches[0]);
  const body = serializeLaneBody(tidyDeleted(parsed, index));
  const written = await writeLane(loaded.root, lane, ctx.holder, body, { expectedVersion });
  return written.ok ? { ok: true, version: written.version } : written;
}

export async function createNote(ctx, ...args) {
  const platform = ctx?.platform ?? process.platform;
  if (platform !== "win32") return createNoteUnlocked(ctx, ...args);
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  return withProjectWrite(ctx.dataDir, ctx.projectPath, () => createNoteUnlocked(ctx, ...args), { platform });
}

export async function createSourcedNote(ctx, ...args) {
  const platform = ctx?.platform ?? process.platform;
  if (platform !== "win32") return createSourcedNoteUnlocked(ctx, ...args);
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  return withProjectWrite(ctx.dataDir, ctx.projectPath, () => createSourcedNoteUnlocked(ctx, ...args), { platform });
}

export async function editNote(ctx, ...args) {
  const platform = ctx?.platform ?? process.platform;
  if (platform !== "win32") return editNoteUnlocked(ctx, ...args);
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  return withProjectWrite(ctx.dataDir, ctx.projectPath, () => editNoteUnlocked(ctx, ...args), { platform });
}

export async function deleteNote(ctx, ...args) {
  const platform = ctx?.platform ?? process.platform;
  if (platform !== "win32") return deleteNoteUnlocked(ctx, ...args);
  if (!validContext(ctx)) return failure("INVALID_CONTEXT");
  return withProjectWrite(ctx.dataDir, ctx.projectPath, () => deleteNoteUnlocked(ctx, ...args), { platform });
}
