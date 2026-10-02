const IN_APP_BROWSER_OPEN = '<in-app-browser-context source="ambient-ui-state">';
const IN_APP_BROWSER_CLOSE = "</in-app-browser-context>";
const RESPONSE_ANNOTATIONS_HEADING = "# Response annotations:";
const RESPONSE_ANNOTATIONS_OPEN = "<response-annotations>";
const RESPONSE_ANNOTATIONS_CLOSE = "</response-annotations>";
const MY_REQUEST_HEADER = "## My request:";
const AMBIENT_OPEN_RE = /^<([A-Za-z][A-Za-z0-9:_-]*)\b[^>]*\bsource="ambient-ui-state"[^>]*>/;
const AMBIENT_KINDS = new Map([
  ["in-app-browser-context", "ambient-ui-state"],
]);

function consumeLine(text, marker) {
  if (!text.startsWith(marker)) return null;
  if (text.length === marker.length) return "";
  if (text.startsWith(`${marker}\n`)) return text.slice(marker.length + 1);
  return null;
}

function consumeAmbient(text) {
  if (text.startsWith(IN_APP_BROWSER_OPEN)) {
    const end = text.indexOf(IN_APP_BROWSER_CLOSE, IN_APP_BROWSER_OPEN.length);
    if (end < 0) return null;
    let rest = text.slice(end + IN_APP_BROWSER_CLOSE.length);
    if (rest.startsWith("\n")) rest = rest.slice(1);
    return { rest, kind: "ambient-ui-state" };
  }
  const match = text.match(AMBIENT_OPEN_RE);
  if (!match) return null;
  const tag = match[1];
  const close = `</${tag}>`;
  const end = text.indexOf(close, match[0].length);
  if (end < 0) return null;
  let rest = text.slice(end + close.length);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  return { rest, kind: AMBIENT_KINDS.get(tag) || "ambient-ui-state" };
}

function consumeAnnotations(text) {
  const heading = RESPONSE_ANNOTATIONS_HEADING;
  if (!text.startsWith(heading)) return null;
  const open = RESPONSE_ANNOTATIONS_OPEN;
  // The host writes "# Response annotations:", its own instruction paragraph,
  // then the <response-annotations> JSON block. The block must start before
  // any "## My request:" header to belong to this wrapper.
  const openOffset = text.indexOf(`\n${open}\n`, heading.length);
  const requestOffset = text.indexOf(`\n${MY_REQUEST_HEADER}`, heading.length);
  if (openOffset < 0 || (requestOffset >= 0 && requestOffset < openOffset)) return null;
  const close = RESPONSE_ANNOTATIONS_CLOSE;
  const end = text.indexOf(close, openOffset + open.length);
  if (end < 0) return null;
  let rest = text.slice(end + close.length);
  if (rest.startsWith("\n")) rest = rest.slice(1);
  return { rest, kind: "response-annotations" };
}

/**
 * Remove only the complete, host-owned wrappers that Codex places at the
 * beginning of a user message. Unknown text and incomplete wrappers remain
 * untouched. The returned text is the shared source projection input used by
 * both the panel and server-side verification.
 */
export function stripHostBlocks(value) {
  let text = String(value ?? "");
  const stripped = [];
  let changed = true;
  while (changed) {
    changed = false;
    // Host wrappers are serialized as "\n<block>\n…"; tolerate the leading
    // blank lines only when a known wrapper follows.
    const trimmed = text.replace(/^\n+/, "");
    if (trimmed !== text && (consumeAmbient(trimmed) || consumeAnnotations(trimmed) || consumeLine(trimmed, MY_REQUEST_HEADER) !== null)) {
      text = trimmed;
    }
    const ambient = consumeAmbient(text);
    if (ambient) {
      text = ambient.rest;
      stripped.push(ambient.kind);
      changed = true;
      continue;
    }
    const annotations = consumeAnnotations(text);
    if (annotations) {
      text = annotations.rest;
      stripped.push(annotations.kind);
      changed = true;
      continue;
    }
    const request = consumeLine(text, MY_REQUEST_HEADER);
    if (request !== null) {
      text = request;
      stripped.push("my-request");
      changed = true;
    }
  }
  // Drop the single trailing newline the host appends after the request.
  if (stripped.length > 0) text = text.replace(/\n$/, "");
  return { text, stripped };
}
