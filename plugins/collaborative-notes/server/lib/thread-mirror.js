import { projectMarkdown } from "./render-text.js";
import { stripHostBlocks } from "./host-blocks.js";

// Pagination stops when the host returns no new cursor. This bound only
// guards against a host that never stops; no real conversation reaches it.
const MAX_HISTORY_PAGES = 100_000;

export const SOURCE_ITEM_TYPES = Object.freeze(new Set(["agentMessage", "userMessage"]));

function arrayValue(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.data)) return value.data;
  return [];
}

function itemValue(record) {
  return record?.item && typeof record.item === "object" ? record.item : record;
}

function userText(item) {
  if (!Array.isArray(item?.content)) return undefined;
  const parts = [];
  for (const block of item.content) {
    if (typeof block?.text !== "string") return undefined;
    parts.push(block.text);
  }
  return parts.join("\n");
}

// These are host-owned prefixes, not a general-purpose prompt sanitizer. A wrapper
// is removed only when the complete, known pair is present verbatim.
export function stripHostUserPrefix(value) {
  return stripHostBlocks(value).text;
}

export function normalizeSourceItem(record, fallbackThreadId, fallbackTurnId) {
  const item = itemValue(record);
  const type = item?.type;
  if (!SOURCE_ITEM_TYPES.has(type) || typeof item?.id !== "string" || item.id.length === 0) return undefined;
  const text = type === "agentMessage" ? item.text : userText(item);
  if (typeof text !== "string") return undefined;
  return {
    id: item.id,
    role: type === "agentMessage" ? "assistant" : "user",
    text: type === "userMessage" ? stripHostUserPrefix(text) : text,
    type,
    ...(type === "agentMessage" && typeof item.phase === "string" ? { phase: item.phase } : {}),
    threadId: record?.threadId ?? item.threadId ?? fallbackThreadId,
    turnId: record?.turnId ?? item.turnId ?? fallbackTurnId,
    ...((record?.timestamp ?? record?.time ?? item.timestamp) ? { time: record?.timestamp ?? record?.time ?? item.timestamp } : {}),
  };
}

export function itemRecords(response) {
  return arrayValue(response?.items ?? response?.data ?? response);
}

export function turnRecords(response) {
  return arrayValue(response?.turns ?? response?.data ?? response);
}

export function normalizeItems(response, threadId) {
  return itemRecords(response)
    .map((record) => normalizeSourceItem(record, threadId, record?.turnId))
    .filter(Boolean);
}

/**
 * The host may store a commentary agentMessage whose text is identical to the
 * turn's final answer; the Codex UI shows that text once. Mirror the UI: drop
 * a commentary item when a later final_answer in the same turn has the same
 * text. Distinct texts are always kept.
 */
export function collapseEchoedCommentary(items) {
  return items.filter((item, index) => !(item.phase === "commentary"
    && items.slice(index + 1).some((later) => later.phase === "final_answer" && later.text === item.text)));
}

export function normalizeTurns(response, threadId) {
  return turnRecords(response).map((turn) => ({
    turnId: turn?.id ?? turn?.turnId,
    // The app-server reports startedAt in epoch seconds.
    time: turn?.timestamp ?? turn?.time ?? turn?.createdAt
      ?? (Number.isFinite(turn?.startedAt) ? new Date(turn.startedAt * 1000).toISOString() : undefined),
    // Only a turn still running is unsettled; failed and interrupted turns
    // still hold messages the user saw.
    completed: turn?.status === undefined || ["completed", "failed", "interrupted"].includes(turn?.status),
    statusKnown: turn?.status !== undefined,
    items: collapseEchoedCommentary((turn?.items || [])
      .map((record) => normalizeSourceItem(record, threadId, turn?.id ?? turn?.turnId))
      .filter(Boolean)),
  })).filter((turn) => typeof turn.turnId === "string" || turn.items.length > 0);
}

export function responseCursor(response) {
  return response?.nextCursor ?? response?.data?.nextCursor;
}

async function allItemRecords(appserver, threadId) {
  const records = [];
  let cursor;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const response = await appserver.listItems(threadId, { cursor, sortDirection: "asc" });
    records.push(...itemRecords(response));
    const next = responseCursor(response);
    if (!next || next === cursor) break;
    cursor = next;
  }
  return records;
}

function groupItems(items, statuses = new Map()) {
  const groups = new Map();
  for (const item of items) {
    const key = item.turnId || "unknown-turn";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups].map(([turnId, grouped]) => {
    const state = statuses.get(turnId);
    return {
      turnId,
      time: grouped.find((item) => item.time)?.time,
      completed: state?.completed !== false,
      statusKnown: state?.statusKnown !== false,
      items: grouped,
    };
  });
}

export async function listMirrorTurns(appserver, threadId, opts = {}) {
  const response = await appserver.listTurns(threadId, { itemsView: "full", ...opts });
  let turns = normalizeTurns(response, threadId);
  if (turns.some((turn) => turn.items.length > 0)) return { turns, nextCursor: responseCursor(response) };
  const statuses = new Map(turns.map((turn) => [turn.turnId, { completed: turn.completed, statusKnown: turn.statusKnown }]));
  const items = (await allItemRecords(appserver, threadId))
    .map((record) => normalizeSourceItem(record, threadId, record?.turnId)).filter(Boolean);
  turns = groupItems(items, statuses).filter((turn) => turn.completed !== false);
  return { turns, nextCursor: responseCursor(response) };
}

export async function listSourceItems(appserver, threadId) {
  return (await allItemRecords(appserver, threadId))
    .map((record) => normalizeSourceItem(record, threadId, record?.turnId)).filter(Boolean);
}

export async function listAllMirrorTurns(appserver, threadId) {
  const turns = [];
  let cursor;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const listed = await listMirrorTurns(appserver, threadId, {
      cursor,
      sortDirection: "asc",
      itemsView: "full",
    });
    turns.push(...listed.turns);
    if (!listed.nextCursor || listed.nextCursor === cursor) break;
    cursor = listed.nextCursor;
  }
  const unique = new Map();
  for (const turn of turns) unique.set(turn.turnId, turn);
  return [...unique.values()];
}

function collapseWhitespace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function head(value, length) {
  return collapseWhitespace(visibleSourceText({ text: value })).slice(0, length);
}

export function buildMirrorOutline(turns, notedItemIds = new Set()) {
  return turns.map((turn, index) => {
    const user = turn.items.find((item) => item.role === "user");
    const assistants = turn.items.filter((item) => item.role === "assistant");
    const final = assistants.find((item) => item.phase === "final_answer") || assistants.at(-1);
    return {
      turnId: turn.turnId,
      index: index + 1,
      time: turn.time ?? turn.items.find((item) => item.time)?.time ?? null,
      userHead: head(user?.text, 20),
      answerHead: head(final?.text, 30),
      noted: turn.items.some((item) => notedItemIds.has(item.id)),
    };
  }).reverse();
}

export function compactNavigatorTurn(turn, { index, noted } = {}) {
  const user = turn.items?.find((item) => item.role === "user");
  const assistants = (turn.items || []).filter((item) => item.role === "assistant");
  const final = assistants.find((item) => item.phase === "final_answer") || assistants.at(-1);
  return {
    turnId: turn.turnId,
    time: turn.time ?? turn.items?.find((item) => item.time)?.time ?? null,
    userHead: head(user?.text, 20),
    answerHead: head(final?.text, 30),
    items: compactTurn(turn).items,
    ...(noted === undefined ? {} : { noted: noted === true }),
    ...(index === undefined ? {} : { index }),
  };
}

export function searchMirrorTurns(turns, query) {
  const needle = collapseWhitespace(query).toLocaleLowerCase();
  if (!needle) return [];
  const results = [];
  for (let index = turns.length - 1; index >= 0 && results.length < 50; index -= 1) {
    const turn = turns[index];
    for (const item of turn.items) {
      if (item.role !== "user" && item.role !== "assistant") continue;
      const projection = collapseWhitespace(visibleSourceText(item));
      const haystack = projection.toLocaleLowerCase();
      const first = haystack.indexOf(needle);
      if (first < 0) continue;
      let matches = 0;
      for (let at = first; at >= 0; at = haystack.indexOf(needle, at + 1)) matches += 1;
      const start = Math.max(0, Math.min(first - 40, projection.length - 80));
      const snippet = projection.slice(start, start + 80);
      results.push({
        turnId: turn.turnId,
        index: turn.index ?? index + 1,
        itemId: item.id,
        role: item.role,
        snippet,
        matches,
        turn: compactTurn(turn),
      });
      if (results.length >= 50) break;
    }
  }
  return results;
}

export function visibleSourceText(item) {
  return projectMarkdown(item?.text ?? "");
}

export function findItem(items, itemId) {
  return items.find((item) => item.id === itemId);
}

function cacheTurn(turn, index) {
  return {
    turnId: turn.turnId,
    index,
    time: turn.time ?? turn.items.find((item) => item.time)?.time ?? null,
    items: turn.items.map(({ id, role, text }) => ({ id, role, text })),
  };
}

function cachedTurnsFromEntry(entry, { excludeTurnId } = {}) {
  return entry.turns.filter((turn) => turn.turnId !== excludeTurnId);
}

export class MirrorHistoryCache {
  constructor(appserver, {
    now = Date.now,
    maxThreads = 3,
    idleMs = 10 * 60 * 1000,
    refreshMs = 5_000,
    pageSize = 50,
    topUpSize = 10,
  } = {}) {
    this.appserver = appserver;
    this.now = now;
    this.maxThreads = maxThreads;
    this.idleMs = idleMs;
    this.refreshMs = refreshMs;
    this.pageSize = pageSize;
    this.topUpSize = topUpSize;
    this.entries = new Map();
    this.builds = new Map();
    this.refreshes = new Map();
    this.accessCounter = 0;
  }

  get size() { return this.entries.size; }

  peek(threadId) {
    return this.entries.get(threadId);
  }

  evict(at = this.now()) {
    for (const [threadId, entry] of this.entries) {
      if (at - entry.lastUsed >= this.idleMs) this.entries.delete(threadId);
    }
    while (this.entries.size > this.maxThreads) {
      const oldest = [...this.entries.entries()].sort((left, right) => (
        left[1].lastUsed - right[1].lastUsed || left[1].lastUsedOrder - right[1].lastUsedOrder
      ))[0];
      if (!oldest) break;
      this.entries.delete(oldest[0]);
    }
  }

  async get(threadId) {
    this.evict();
    let entry = this.entries.get(threadId);
    if (!entry) {
      let build = this.builds.get(threadId);
      if (!build) {
        build = this.build(threadId);
        this.builds.set(threadId, build);
        build.finally(() => this.builds.delete(threadId)).catch(() => {});
      }
      entry = await build;
    }
    entry.lastUsed = this.now();
    entry.lastUsedOrder = ++this.accessCounter;
    if (entry.refreshedAt === undefined || this.now() - entry.refreshedAt > this.refreshMs) {
      entry = await this.refresh(entry);
    }
    entry.lastUsed = this.now();
    this.evict();
    return entry;
  }

  async build(threadId) {
    const turns = [];
    let cursor;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const listed = await listMirrorTurns(this.appserver, threadId, {
        cursor,
        limit: this.pageSize,
        sortDirection: "asc",
        itemsView: "full",
      });
      turns.push(...listed.turns.filter((turn) => turn.completed !== false));
      if (!listed.nextCursor || listed.nextCursor === cursor) break;
      cursor = listed.nextCursor;
    }
    const unique = new Map();
    for (const turn of turns) unique.set(turn.turnId, turn);
    const entry = {
      turns: [...unique.values()].map((turn, index) => cacheTurn(turn, index + 1)),
      newestTurnId: undefined,
      lastUsed: this.now(),
      lastUsedOrder: ++this.accessCounter,
      refreshedAt: this.now(),
    };
    entry.newestTurnId = entry.turns.at(-1)?.turnId;
    this.entries.set(threadId, entry);
    this.evict();
    return entry;
  }

  async refresh(entry, { force = false } = {}) {
    const threadId = [...this.entries.entries()].find(([, value]) => value === entry)?.[0];
    if (!threadId) return entry;
    if (!force && entry.refreshedAt !== undefined && this.now() - entry.refreshedAt <= this.refreshMs) return entry;
    let refresh = this.refreshes.get(threadId);
    if (!refresh) {
      refresh = this.topUp(threadId, entry);
      this.refreshes.set(threadId, refresh);
      refresh.finally(() => this.refreshes.delete(threadId)).catch(() => {});
    }
    return refresh;
  }

  async topUp(threadId, entry) {
    const fetched = [];
    let cursor;
    const existingIds = new Set(entry.turns.map((turn) => turn.turnId));
    let anchorId;
    for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
      const listed = await listMirrorTurns(this.appserver, threadId, {
        cursor,
        limit: this.topUpSize,
        sortDirection: "desc",
        itemsView: "full",
      });
      for (const turn of listed.turns) {
        if (turn.completed === false) continue;
        fetched.push(turn);
        if (existingIds.has(turn.turnId)) {
          anchorId = turn.turnId;
          break;
        }
      }
      if (anchorId || !listed.nextCursor || listed.nextCursor === cursor) break;
      cursor = listed.nextCursor;
    }
    if (!anchorId) return this.build(threadId);
    const freshById = new Map(fetched.map((turn) => [turn.turnId, turn]));
    const anchorIndex = entry.turns.findIndex((turn) => turn.turnId === anchorId);
    const refreshed = entry.turns.slice(0, anchorIndex + 1)
      .map((turn) => freshById.has(turn.turnId) ? cacheTurn(freshById.get(turn.turnId), turn.index) : turn);
    const additions = fetched.filter((turn) => !existingIds.has(turn.turnId)).reverse();
    for (const turn of additions) refreshed.push(cacheTurn(turn, refreshed.length + 1));
    entry.turns = refreshed;
    entry.newestTurnId = entry.turns.at(-1)?.turnId;
    entry.refreshedAt = this.now();
    entry.lastUsed = this.now();
    entry.lastUsedOrder = ++this.accessCounter;
    return entry;
  }

  async turn(threadId, turnId) {
    const entry = await this.get(threadId);
    return entry.turns.find((turn) => turn.turnId === turnId);
  }

  async resolveSourceItem(holderThreadId, sourceThreadId, itemId) {
    let entry;
    try { entry = await this.get(sourceThreadId); } catch {
      const items = await listSourceItems(this.appserver, sourceThreadId);
      const item = findItem(items, itemId);
      return item ? { ok: true, item, items } : { ok: false, code: "NOTES_SOURCE_UNAVAILABLE" };
    }
    let items = entry.turns.flatMap((turn) => turn.items);
    let item = findItem(items, itemId);
    if (!item) {
      await this.refresh(entry, { force: true });
      items = entry.turns.flatMap((turn) => turn.items);
      item = findItem(items, itemId);
    }
    if (item) {
      const directItems = await listSourceItems(this.appserver, sourceThreadId);
      const directItem = findItem(directItems, itemId);
      if (!directItem) {
        await this.build(sourceThreadId);
        return { ok: false, code: "NOTES_SOURCE_UNAVAILABLE" };
      }
      if (directItem.text !== item.text || directItem.role !== item.role) await this.build(sourceThreadId);
      return { ok: true, item: directItem, items: directItems };
    }
    items = await listSourceItems(this.appserver, sourceThreadId);
    item = findItem(items, itemId);
    if (!item) return { ok: false, code: "NOTES_SOURCE_UNAVAILABLE" };
    return { ok: true, item, items };
  }

  async resolveSourceItemForCapture(holderThreadId, sourceThreadId, itemId) {
    const sourceItems = await listSourceItems(this.appserver, sourceThreadId);
    const item = findItem(sourceItems, itemId);
    if (!item) return { ok: false, code: "NOTES_SOURCE_UNAVAILABLE" };
    if (sourceThreadId !== holderThreadId) {
      const holderItems = await listSourceItems(this.appserver, holderThreadId);
      if (!findItem(holderItems, itemId)) return { ok: false, code: "NOTES_SOURCE_UNVERIFIED" };
    }
    return { ok: true, item, items: sourceItems };
  }

  async sourceTurns(threadId, targetItemId, before = 1, after = 1, { excludeTurnId } = {}) {
    let entry;
    try { entry = await this.get(threadId); } catch {
      return sourceTurns(this.appserver, threadId, targetItemId, before, after, { excludeTurnId });
    }
    let listed = cachedTurnsFromEntry(entry, { excludeTurnId });
    let targetIndex = listed.findIndex((turn) => turn.items.some((item) => item.id === targetItemId));
    if (targetIndex < 0) {
      await this.refresh(entry, { force: true });
      listed = cachedTurnsFromEntry(entry, { excludeTurnId });
      targetIndex = listed.findIndex((turn) => turn.items.some((item) => item.id === targetItemId));
    }
    if (targetIndex < 0) {
      return sourceTurns(this.appserver, threadId, targetItemId, before, after, { excludeTurnId });
    }
    const start = Math.max(0, targetIndex - before);
    const end = Math.min(listed.length, targetIndex + after + 1);
    return {
      ok: true,
      targetIndex,
      turns: listed.slice(start, end),
      hasEarlier: start > 0,
      hasLater: end < listed.length,
    };
  }
}

export async function resolveSourceItem(appserver, holderThreadId, sourceThreadId, itemId) {
  const sourceItems = await listSourceItems(appserver, sourceThreadId);
  const sourceItem = findItem(sourceItems, itemId);
  if (!sourceItem) return { ok: false, code: "NOTES_SOURCE_UNAVAILABLE" };
  return { ok: true, item: sourceItem, items: sourceItems };
}

export async function resolveSourceItemForCapture(appserver, holderThreadId, sourceThreadId, itemId) {
  const resolved = await resolveSourceItem(appserver, holderThreadId, sourceThreadId, itemId);
  if (!resolved.ok) return resolved;
  if (sourceThreadId !== holderThreadId) {
    const holderItems = await listSourceItems(appserver, holderThreadId);
    if (!findItem(holderItems, itemId)) return { ok: false, code: "NOTES_SOURCE_UNVERIFIED" };
  }
  return resolved;
}

export async function sourceTurns(appserver, threadId, targetItemId, before = 1, after = 1, { excludeTurnId } = {}) {
  const allTurns = [];
  let cursor;
  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    const listedPage = await listMirrorTurns(appserver, threadId, { cursor, sortDirection: "asc" });
    allTurns.push(...listedPage.turns);
    if (!listedPage.nextCursor || listedPage.nextCursor === cursor) break;
    cursor = listedPage.nextCursor;
  }
  const listed = { turns: allTurns.filter((turn) => turn.completed !== false && turn.turnId !== excludeTurnId && (!excludeTurnId || turn.statusKnown !== false)) };
  const targetIndex = listed.turns.findIndex((turn) => turn.items.some((item) => item.id === targetItemId));
  if (targetIndex < 0) return { ok: false, code: "NOTES_SOURCE_UNAVAILABLE" };
  const start = Math.max(0, targetIndex - before);
  const end = Math.min(listed.turns.length, targetIndex + after + 1);
  return {
    ok: true,
    targetIndex,
    turns: listed.turns.slice(start, end),
    hasEarlier: start > 0,
    hasLater: end < listed.turns.length,
  };
}

export function compactTurn(turn) {
  return {
    turnId: turn.turnId,
    items: turn.items.map(({ id, role, text, time }) => ({ id, role, text, ...(time ? { time } : {}) })),
  };
}
