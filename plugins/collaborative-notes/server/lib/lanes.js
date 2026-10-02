export const LANE_KEYS = Object.freeze([
  "conversation_todo",
  "deferred_work",
  "knowledge_candidate",
  "lesson_candidate",
]);

const DEFAULT_LABELS_ZH = Object.freeze({
  conversation_todo: "会话待办",
  deferred_work: "延后工作",
  knowledge_candidate: "知识候选",
  lesson_candidate: "复盘素材",
});
const DEFAULT_LABELS_EN = Object.freeze({
  conversation_todo: "Conversation To-do",
  deferred_work: "Deferred Work",
  knowledge_candidate: "Knowledge Candidate",
  lesson_candidate: "Lesson Candidate",
});
const DEFAULT_HINTS = Object.freeze({
  conversation_todo: { target: "", action: "" },
  deferred_work: {
    target: "a formal discussion/todo list (ask the user where)",
    action: "transcribe into structured entries",
  },
  knowledge_candidate: {
    target: "a knowledge-base document (ask the user where)",
    action: "complete and write up",
  },
  lesson_candidate: {
    target: "a lessons-learned document (ask the user where)",
    action: "complete and write up",
  },
});

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const ABSOLUTE_OR_DRIVE_PATH = /^[/\\]|^[A-Za-z]:/;

export function isLaneKey(value) {
  return typeof value === "string" && LANE_KEYS.includes(value);
}

export function defaultLabels(locale = "en") {
  return { ...(String(locale).toLowerCase().startsWith("zh") ? DEFAULT_LABELS_ZH : DEFAULT_LABELS_EN) };
}

function sanitizeText(value) {
  if (typeof value !== "string") return { ok: false };
  const text = value.trim();
  if (text.length === 0) return { ok: true, value: "" };
  if (text.length > 200 || CONTROL_CHARACTERS.test(text)
    || text.includes("..") || ABSOLUTE_OR_DRIVE_PATH.test(text)) {
    return { ok: false };
  }
  return { ok: true, value: text };
}

export function sanitizeLaneConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "INVALID_CONFIG" };
  }
  const displayOrder = input.displayOrder === undefined ? [] : input.displayOrder;
  if (!Array.isArray(displayOrder) || displayOrder.some((value) => typeof value !== "string")) {
    return { ok: false, code: "INVALID_CONFIG" };
  }
  const safeOrder = [];
  for (const value of displayOrder) {
    const result = sanitizeText(value);
    if (!result.ok) return { ok: false, code: "INVALID_CONFIG" };
    safeOrder.push(result.value);
  }
  const sanitized = { displayOrder: safeOrder, laneOverrides: {} };
  const rawOverrides = input.laneOverrides ?? input.layerOverrides ?? {};
  if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) {
    return { ok: false, code: "INVALID_CONFIG" };
  }
  for (const [key, raw] of Object.entries(rawOverrides)) {
    if (!isLaneKey(key)) continue;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, code: "INVALID_CONFIG" };
    }
    const override = {};
    for (const field of ["label", "displayId", "target", "action"]) {
      if (raw[field] === undefined) continue;
      const result = sanitizeText(raw[field]);
      if (!result.ok) return { ok: false, code: "INVALID_CONFIG" };
      override[field] = result.value;
    }
    sanitized.laneOverrides[key] = override;
  }
  return { ok: true, config: sanitized };
}

export function resolveLanes(config = {}, locale = "en") {
  const sanitized = sanitizeLaneConfig(config);
  const safeConfig = sanitized.ok ? sanitized.config : { displayOrder: [], laneOverrides: {} };
  const configured = safeConfig.displayOrder;
  const order = [];
  for (const key of configured) {
    if (isLaneKey(key) && !order.includes(key)) order.push(key);
  }
  for (const key of LANE_KEYS) {
    if (!order.includes(key)) order.push(key);
  }

  const labels = defaultLabels(locale);
  const explicitIds = new Set();
  for (const key of order) {
    const id = safeConfig.laneOverrides[key]?.displayId;
    if (id) explicitIds.add(id);
  }
  const usedIds = new Set();
  const lanes = [];
  for (let index = 0; index < order.length; index += 1) {
    const key = order[index];
    const override = safeConfig.laneOverrides[key] ?? {};
    let displayId = override.displayId || `L${index + 1}`;
    if (usedIds.has(displayId)) {
      let candidateIndex = index + 1;
      while (usedIds.has(`L${candidateIndex}`) || explicitIds.has(`L${candidateIndex}`)) candidateIndex += 1;
      displayId = `L${candidateIndex}`;
    }
    usedIds.add(displayId);
    const descriptive = override.label || labels[key];
    const hints = DEFAULT_HINTS[key];
    lanes.push({
      key,
      displayId,
      label: `${displayId} ${descriptive}`,
      descriptive,
      target: override.target || hints.target,
      action: override.action || hints.action,
    });
  }
  return lanes;
}

/**
 * Map a user- or agent-facing lane reference to its semantic key.
 * Accepts the semantic key, the display id ("L2", "l2", "2"), the full label
 * ("L2 Deferred Work"), or the descriptive label in any locale (case-insensitive).
 * Returns null when the reference is unknown or ambiguous; never guesses.
 */
export function normalizeLaneRef(ref, lanes = resolveLanes()) {
  if (typeof ref !== "string") return null;
  const raw = ref.trim();
  if (isLaneKey(raw)) return raw;
  const lower = raw.toLowerCase();
  const hits = new Set();
  lanes.forEach((lane, index) => {
    const candidates = [lane.displayId, lane.label, lane.descriptive, String(index + 1)];
    for (const locale of ["en", "zh"]) {
      const fallback = defaultLabels(locale)[lane.key];
      if (fallback) candidates.push(fallback);
    }
    if (candidates.some((c) => typeof c === "string" && c.trim().toLowerCase() === lower)) hits.add(lane.key);
  });
  return hits.size === 1 ? [...hits][0] : null;
}
