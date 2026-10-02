import { parseLaneBody, serializeLaneBody, withItemKey, newItemKey } from "./structured-item.js";

/**
 * Fork-cut eligibility (Core §8.1.1), decided by host history membership:
 * - no source → eligible;
 * - source message inherited by the child → before the cut → eligible;
 * - source message in the parent's history (incl. ancestors) but not in the
 *   child → after the cut → excluded;
 * - source in neither history → not comparable → eligible (never silently
 *   excluded).
 */
export function sourceEligible(item, parentThreadId, childItemIds, parentItemIds = new Set()) {
  const source = item?.sourcePayload;
  if (!source || typeof source.messageId !== "string") return true;
  if (childItemIds.has(source.messageId)) return true;
  if (parentItemIds.has(source.messageId)) return false;
  return true;
}

export function filterEligibleBody(body, { parentThreadId, childItemIds, parentItemIds }) {
  const parsed = parseLaneBody(String(body ?? ""));
  const kept = parsed.nodes.filter((node) => node.type !== "item" || sourceEligible(node.item, parentThreadId, childItemIds, parentItemIds));
  return kept.length === parsed.nodes.length
    ? String(body ?? "")
    : kept.length === 0 ? "" : serializeLaneBody({ nodes: kept, trailingNewline: parsed.trailingNewline });
}

export function rekeyCarriedBody(body) {
  const parsed = parseLaneBody(String(body ?? ""));
  const carriedKeys = [];
  const nodes = parsed.nodes.map((node) => {
    if (node.type !== "item") return node;
    const key = newItemKey();
    carriedKeys.push(key);
    return { ...node, item: withItemKey(node.item, key) };
  });
  return { body: nodes.length ? serializeLaneBody({ nodes, trailingNewline: parsed.trailingNewline }) : "", carriedKeys };
}

function structuredOnly(body) {
  return parseLaneBody(String(body ?? "")).nodes.every((node) => node.type === "item");
}

export function mergeCarryBodies(parentBody, childBody) {
  const parent = String(parentBody ?? "");
  const child = String(childBody ?? "");
  if (!parent.trim()) return child;
  if (!child.trim()) return parent;
  if (structuredOnly(parent) && structuredOnly(child)) {
    const p = parseLaneBody(parent);
    const c = parseLaneBody(child);
    return serializeLaneBody({
      nodes: [...p.nodes, ...c.nodes],
      trailingNewline: p.trailingNewline || c.trailingNewline,
    });
  }
  return `## Parent branch\n\n${parent}\n\n---\n\n## Current branch\n\n${child}`;
}

export function carryMarker(parentThreadId, lanes, status = "decided", { choice, selectedLanes } = {}) {
  return {
    version: 2,
    parentThreadId,
    status,
    decidedAt: status === "decided" ? new Date().toISOString() : null,
    lanes,
    ...(choice ? { choice } : {}),
    ...(Array.isArray(selectedLanes) ? { selectedLanes } : {}),
  };
}
