// Derived from aprilxuMLC/dsh-collaborative-notes v0.1.1 lib/structured-item.js (MIT).

export const BEGIN_LINE = "--- dsh-note v1 begin";
export const END_LINE = "--- dsh-note v1 end";
export const BODY_LINE = "--- dsh-body";
export const META_PREFIX = "dsh-meta ";
export const REPRESENTATION_VERSION = 1;

export const KIND_SOURCE_AWARE = "source-aware";
export const KIND_SOURCE_INDEPENDENT = "source-independent";
export const ITEM_KEY_META = "item-key";

const SESSION_ID_RE = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/;
const MESSAGE_ID_MAX = 512;
const KNOWN_META = new Set([
  "kind", "origin", "body-length", "snapshot-length", "comment-length",
  "source-payload", "host",
]);
const GENERATED_ITEM_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const codePoints = (value) => [...value].length;
const sliceCodePoints = (value, start, end) => [...value].slice(start, end).join("");

function isValidMessageIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "messageId" || keys[1] !== "sessionId") return false;
  return typeof value.sessionId === "string" && SESSION_ID_RE.test(value.sessionId)
    && typeof value.messageId === "string"
    && value.messageId.length > 0 && value.messageId.length <= MESSAGE_ID_MAX;
}

export function hasSubstantiveAuthoredContent(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function parseItemAt(lines, start) {
  const itemLines = [lines[start]];
  const metaOrder = [];
  let kind;
  let origin;
  let host;
  let bodyLength = null;
  let snapshotLength = null;
  let commentLength = null;
  let sourcePayload;
  let sourcePayloadRaw;
  let i = start + 1;

  while (i < lines.length && lines[i].startsWith(META_PREFIX)) {
    const line = lines[i];
    const rawValue = line.slice(META_PREFIX.length);
    const colon = rawValue.indexOf(":");
    const key = colon > 0 ? rawValue.slice(0, colon).trim() : rawValue.trim();
    const value = colon > 0 ? rawValue.slice(colon + 1).trim() : "";

    if (!KNOWN_META.has(key)) {
      metaOrder.push({ kind: "raw", raw: line });
    } else if (key === "kind") {
      if (kind !== undefined) return null;
      kind = value;
      metaOrder.push({ kind: "known", key, raw: line });
    } else if (key === "origin") {
      if (origin !== undefined) return null;
      origin = value;
      metaOrder.push({ kind: "known", key, raw: line });
    } else if (key === "host") {
      if (host !== undefined) return null;
      host = value;
      metaOrder.push({ kind: "known", key, raw: line });
    } else if (key === "body-length") {
      if (bodyLength !== null) return null;
      bodyLength = value;
      metaOrder.push({ kind: "known", key, raw: line });
    } else if (key === "snapshot-length") {
      if (snapshotLength !== null) return null;
      snapshotLength = value;
      metaOrder.push({ kind: "known", key, raw: line });
    } else if (key === "comment-length") {
      if (commentLength !== null) return null;
      commentLength = value;
      metaOrder.push({ kind: "known", key, raw: line });
    } else if (key === "source-payload") {
      if (sourcePayload !== undefined || sourcePayloadRaw !== undefined) return null;
      let parsed;
      try { parsed = JSON.parse(value); } catch { return null; }
      if (!isValidMessageIdentity(parsed)) return null;
      sourcePayload = parsed;
      sourcePayloadRaw = line;
      metaOrder.push({ kind: "known", key, raw: line });
    }
    itemLines.push(line);
    i += 1;
  }

  if (kind !== KIND_SOURCE_AWARE && kind !== KIND_SOURCE_INDEPENDENT) return null;
  if (typeof origin !== "string" || !SESSION_ID_RE.test(origin)) return null;

  const numberValue = (value) => value !== null && /^\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value) : null;
  let payloadLength;
  if (kind === KIND_SOURCE_INDEPENDENT) {
    const length = numberValue(bodyLength);
    if (length === null || snapshotLength !== null || commentLength !== null) return null;
    payloadLength = length;
  } else {
    const snapshot = numberValue(snapshotLength);
    const comment = commentLength === null ? 0 : numberValue(commentLength);
    if (snapshot === null || comment === null || bodyLength !== null) return null;
    payloadLength = snapshot + comment;
    if (!Number.isSafeInteger(payloadLength)) return null;
  }

  if (lines[i] !== BODY_LINE) return null;
  itemLines.push(lines[i]);
  i += 1;

  const rows = [];
  let accumulated = 0;
  let rowIndex = i;
  while (true) {
    if (accumulated === payloadLength) break;
    if (rowIndex >= lines.length) return null;
    const take = sliceCodePoints(lines[rowIndex], 0, payloadLength - accumulated);
    rows.push(take);
    accumulated = rows.length === 1
      ? codePoints(take)
      : accumulated + 1 + codePoints(take);
    if (accumulated === payloadLength) {
      if (sliceCodePoints(lines[rowIndex], codePoints(take), Infinity).length > 0) return null;
      break;
    }
    if (accumulated > payloadLength) return null;
    rowIndex += 1;
  }

  const payload = rows.join("\n");
  const endIndex = rows.length === 0 ? rowIndex : rowIndex + 1;
  if (lines[endIndex] !== END_LINE) return null;
  itemLines.push(lines[endIndex]);

  const unknownMeta = metaOrder
    .filter((entry) => entry.kind === "raw")
    .map((entry) => ({ raw: entry.raw }));
  const item = kind === KIND_SOURCE_INDEPENDENT
    ? {
      kind,
      captureOrigin: origin,
      comment: payload,
      metaOrder,
      unknownMeta,
    }
    : {
      kind,
      captureOrigin: origin,
      snapshot: sliceCodePoints(payload, 0, Number(snapshotLength)),
      ...(sliceCodePoints(payload, Number(snapshotLength), payloadLength).length > 0
        ? { comment: sliceCodePoints(payload, Number(snapshotLength), payloadLength) }
        : {}),
      metaOrder,
      unknownMeta,
    };
  if (sourcePayload !== undefined) item.sourcePayload = sourcePayload;
  if (host !== undefined) item.host = host;
  return { item, lines: itemLines, nextIndex: endIndex + 1 };
}

export function parseLaneBody(text) {
  const lines = String(text).split("\n");
  const nodes = [];
  let legacy = [];
  const flushLegacy = () => {
    if (legacy.length > 0) {
      const value = legacy.join("\n");
      if (value.length > 0) nodes.push({ type: "legacy", text: value });
      legacy = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    if (lines[i] === BEGIN_LINE) {
      const parsed = parseItemAt(lines, i);
      if (parsed) {
        flushLegacy();
        nodes.push({ type: "item", item: parsed.item, raw: parsed.lines.join("\n") });
        i = parsed.nextIndex;
        continue;
      }
    }
    legacy.push(lines[i]);
    i += 1;
  }
  flushLegacy();
  return { nodes, trailingNewline: String(text).endsWith("\n") };
}

function rawValueFor(item, key) {
  if (key === "kind") return item.kind;
  if (key === "origin") return item.captureOrigin;
  if (key === "host") return item.host;
  if (key === "snapshot-length") return String(codePoints(item.snapshot ?? ""));
  if (key === "comment-length") return String(codePoints(item.comment ?? ""));
  if (key === "body-length") return String(codePoints(item.comment ?? ""));
  if (key === "source-payload") return item.sourcePayload === undefined
    ? undefined : JSON.stringify(item.sourcePayload);
  return undefined;
}

function buildMetaLines(item) {
  const order = item.metaOrder;
  if (!order || order.length === 0) {
    const lines = [
      `${META_PREFIX}kind: ${item.kind}`,
      `${META_PREFIX}origin: ${item.captureOrigin}`,
    ];
    if (item.kind === KIND_SOURCE_AWARE) {
      lines.push(`${META_PREFIX}snapshot-length: ${codePoints(item.snapshot ?? "")}`);
      if ((item.comment ?? "").length > 0) {
        lines.push(`${META_PREFIX}comment-length: ${codePoints(item.comment)}`);
      }
    } else {
      lines.push(`${META_PREFIX}body-length: ${codePoints(item.comment ?? "")}`);
    }
    if (item.sourcePayload !== undefined) {
      lines.push(`${META_PREFIX}source-payload: ${JSON.stringify(item.sourcePayload)}`);
    }
    if (item.host !== undefined) lines.push(`${META_PREFIX}host: ${item.host}`);
    for (const entry of item.unknownMeta ?? []) {
      const raw = typeof entry === "string" ? entry : entry?.raw;
      if (typeof raw === "string") lines.push(raw);
    }
    return lines;
  }

  return order.flatMap((entry) => {
    if (entry.kind === "raw") return [entry.raw];
    const value = rawValueFor(item, entry.key);
    if (value === undefined) return [];
    if ((entry.key === "host" || entry.key === "source-payload") && typeof entry.raw === "string") {
      return [entry.raw];
    }
    return [`${META_PREFIX}${entry.key}: ${value}`];
  });
}

function normalizedMetaOrder(item) {
  const order = Array.isArray(item.metaOrder) ? item.metaOrder.map((entry) => ({ ...entry })) : null;
  if (!order || item.kind !== KIND_SOURCE_AWARE) return order;
  const hasComment = (item.comment ?? "").length > 0;
  const index = (key) => order.findIndex((entry) => entry.kind === "known" && entry.key === key);
  const commentIndex = index("comment-length");
  if (hasComment && commentIndex === -1) {
    const snapshotIndex = index("snapshot-length");
    order.splice(snapshotIndex >= 0 ? snapshotIndex + 1 : order.length, 0, {
      kind: "known", key: "comment-length",
    });
  } else if (!hasComment && commentIndex >= 0) {
    order.splice(commentIndex, 1);
  }
  return order;
}

export function serializeItem(item) {
  const meta = { ...item, metaOrder: normalizedMetaOrder(item) };
  const payload = item.kind === KIND_SOURCE_AWARE
    ? (item.snapshot ?? "") + (item.comment ?? "")
    : (item.comment ?? "");
  const lines = [BEGIN_LINE, ...buildMetaLines(meta), BODY_LINE];
  if (payload.length > 0) lines.push(...payload.split("\n"));
  lines.push(END_LINE);
  return lines.join("\n");
}

export function serializeLaneBody(parsed) {
  const parts = [];
  for (const node of parsed.nodes) {
    if (node.type === "item") parts.push(serializeItem(node.item));
    else if (typeof node.text === "string") parts.push(node.text);
    else if (typeof node.raw === "string") parts.push(node.raw);
  }
  let output = parts.join("\n");
  if (parsed.trailingNewline && !output.endsWith("\n")) output += "\n";
  return output;
}

export function makeItem({
  kind,
  captureOrigin,
  snapshot,
  comment,
  sourcePayload,
  host,
  unknownMeta = [],
}) {
  if (kind !== KIND_SOURCE_AWARE && kind !== KIND_SOURCE_INDEPENDENT) {
    throw new Error(`makeItem: invalid kind "${kind}"`);
  }
  if (typeof captureOrigin !== "string" || !SESSION_ID_RE.test(captureOrigin)) {
    throw new Error(`makeItem: invalid captureOrigin "${captureOrigin}"`);
  }
  if (host !== undefined && (typeof host !== "string" || host.length === 0)) {
    throw new Error("makeItem: host must be a non-empty string");
  }
  const item = { kind, captureOrigin, unknownMeta: [...unknownMeta] };
  if (host !== undefined) item.host = host;
  if (kind === KIND_SOURCE_AWARE) {
    if (snapshot === undefined) throw new Error("makeItem: source-aware requires snapshot");
    if (typeof snapshot !== "string") throw new Error("makeItem: snapshot must be a string");
    item.snapshot = snapshot;
    if (comment !== undefined) {
      if (typeof comment !== "string") throw new Error("makeItem: comment must be a string");
      item.comment = comment;
    }
    if (sourcePayload !== undefined) {
      if (!isValidMessageIdentity(sourcePayload)) {
        throw new Error("makeItem: sourcePayload must be a message identity");
      }
      item.sourcePayload = sourcePayload;
    }
  } else {
    if (snapshot !== undefined) throw new Error("makeItem: source-independent cannot carry snapshot");
    if (sourcePayload !== undefined) throw new Error("makeItem: source-independent cannot carry sourcePayload");
    if (comment !== undefined) {
      if (typeof comment !== "string") throw new Error("makeItem: comment must be a string");
      item.comment = comment;
    }
  }
  return item;
}

export const unknownMeta = (raw) => ({ raw });

export function isValidItemKey(value) {
  return typeof value === "string" && value.length > 0;
}

export function isValidGeneratedItemKey(value) {
  return typeof value === "string" && GENERATED_ITEM_KEY_RE.test(value);
}

export function inspectItemKey(item) {
  const prefix = `${META_PREFIX}${ITEM_KEY_META}:`;
  const rows = (item?.unknownMeta ?? [])
    .map((entry) => typeof entry === "string" ? entry : entry?.raw)
    .filter((raw) => typeof raw === "string" && raw.startsWith(prefix))
    .map((raw) => raw.slice(prefix.length).trim());
  if (rows.length === 0) return { status: "missing" };
  if (rows.length > 1) return { status: "duplicate", values: rows };
  if (!isValidItemKey(rows[0])) return { status: "malformed", value: rows[0] };
  return { status: "valid", key: rows[0] };
}

export function newItemKey() {
  const random = () => Math.random().toString(36).slice(2, 10);
  return `ik-${Date.now().toString(36)}-${random()}${random()}`;
}

export function getItemKey(item) {
  const inspected = inspectItemKey(item);
  return inspected.status === "valid" ? inspected.key : undefined;
}

export function withItemKey(item, key) {
  const prefix = `${META_PREFIX}${ITEM_KEY_META}: `;
  const row = prefix + key;
  const isKeyRow = (entry) => {
    const raw = typeof entry === "string" ? entry : entry?.raw;
    return typeof raw === "string" && raw.startsWith(prefix);
  };
  const next = { ...item };
  const unknownMeta = item?.unknownMeta ?? [];
  next.unknownMeta = unknownMeta.some(isKeyRow)
    ? unknownMeta.map((entry) => isKeyRow(entry) ? { raw: row } : entry)
    : [...unknownMeta, { raw: row }];
  if (Array.isArray(item?.metaOrder)) {
    const has = item.metaOrder.some((entry) => entry?.kind === "raw" && isKeyRow(entry.raw));
    next.metaOrder = has
      ? item.metaOrder.map((entry) => entry?.kind === "raw" && isKeyRow(entry.raw)
        ? { kind: "raw", raw: row } : entry)
      : [...item.metaOrder, { kind: "raw", raw: row }];
  }
  return next;
}

export function isValidSessionId(value) {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}
