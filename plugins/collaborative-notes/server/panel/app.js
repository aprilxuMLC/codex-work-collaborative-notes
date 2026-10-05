(function (global) {
  "use strict";

  const I18N = global.CollaborativeNotesI18n;
  const LANE_KEYS = ["conversation_todo", "deferred_work", "knowledge_candidate", "lesson_candidate"];
  const nodes = Object.fromEntries([
    "thread-title", "project-name", "help-button", "search-button", "refresh-button",
    "hooks-banner", "branch-banner", "carry-banner", "status-banner", "conflict-banner", "help-panel", "setup-gate", "notes-main", "mirror-panel", "source-view",
    "confirm-banner", "selection-tray", "composer-lane-label", "composer-lane",
    "mirror-heading", "mirror-close", "mirror-hint", "mirror-filter-label", "mirror-filter", "mirror-list", "mirror-quote-selection",
    "lane-tabs", "search-panel", "search-label", "search-input", "search-close", "composer-heading",
    "new-note-button", "composer", "quoted-source", "quote-button", "save-note-button", "saved-heading", "newest-button", "oldest-button",
    "notes-list", "footer",
  ].map((id) => [id, document.getElementById(id)]));

  const threadMatch = location.pathname.match(/^\/t\/([^/]+)/);
  const threadId = threadMatch ? decodeURIComponent(threadMatch[1]) : "";
  let panelInstance = document.documentElement?.dataset?.cnPanel || null;
  let panelActivation = 0, panelActive = true, panelRenewal = null;
  let locale = "en";
  let context = null;
  let lanes = [];
  let laneConfig = { displayOrder: [], laneOverrides: {} };
  let namingNeeded = true;
  let setupLabels = {};
  let activeLane = "conversation_todo";
  let composerLane = activeLane;
  let laneData = new Map();
  let prefs = { pins: {} };
  let sortOrder = "newest";
  let composerDraft = "";
  let composerTouched = false;
  let editor = null;
  let deleteConfirm = null;
  let searchOpen = false;
  let searchQuery = "";
  let searchResults = null;
  let helpOpen = false;
  let picker = null;
  let pickerSequence = 0;
  let pickerBusy = false;
  let nativeFallback = false;
  let nativeCandidate = null;
  let nativeBusy = false;
  let nativeSequence = 0;
  let nativeAbort = null;
  let nativeRenderKey = null;
  let setupBusy = false;
  let setupUncertain = false;
  let setupContinuation = false;
  let locationChangeMode = false;
  let locationTarget = null;
  let locationChangeBusy = false;
  let locationPendingResult = null;
  let relocating = false;
  let relocationBusy = false;
  let relocationNested = null;
  let relocationAttempt = null;
  let status = null;
  let conflict = null;
  let loadSequence = 0;
  let searchSequence = 0;
  let pollTimer = null;
  let searchTimer = null;
  let mirrorRecent = [];
  let mirrorNextCursor = null;
  let mirrorLoadingEarlier = false;
  let mirrorTurnData = new Map();
  let mirrorExpanded = new Set();
  let mirrorHighlights = new Map();
  let mirrorFilter = "";
  let mirrorSearchResults = null;
  let mirrorSearching = false;
  let mirrorSearchSequence = 0;
  let mirrorOpen = false;
  let quoted = null;
  let composing = false;
  let renderPending = false;
  let pageServiceVersion = null;
  let expandedSources = new Set();
  let sourceView = null;
  let confirmRequest = null;
  let selection = { targets: [], generation: 0, lastBinding: null };
  let selectionPollTimer = null;
  let selectionReceipt = null;
  let carryConflict = null;
  let carrySomeLanes = new Set(LANE_KEYS);
  let carryResult = null;

  class ApiError extends Error {
    constructor(code, response, data) {
      super(code || "REQUEST_FAILED");
      this.code = code || "REQUEST_FAILED";
      this.status = response?.status || 0;
      this.data = data;
    }
  }

  const t = (key, values) => I18N.translate(locale, key, values);
  const apiPath = (suffix) => `/api/t/${encodeURIComponent(threadId)}${suffix}`;

  async function parseResponse(response) {
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { code: "INVALID_RESPONSE" }; }
    if (!response.ok) throw new ApiError(data.code, response, data);
    return data;
  }

  async function api(suffix, options = {}) {
    const headers = { ...(options.headers || {}), ...(panelInstance ? { "x-cn-panel-instance": panelInstance } : {}) };
    const init = { ...options, headers };
    if (Object.prototype.hasOwnProperty.call(options, "body") && typeof options.body !== "string") {
      init.body = JSON.stringify(options.body);
      init.headers = { ...headers, "content-type": "application/json" };
    }
    const sentInstance = panelInstance;
    const response = await fetch(apiPath(suffix), init);
    if (sentInstance && panelActive && sentInstance === panelInstance && response.headers?.get?.("x-cn-panel-refresh") === "1")
      renewPanelInstance().catch(() => {});
    return parseResponse(response);
  }

  async function globalApi(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    const init = { ...options, headers };
    if (Object.prototype.hasOwnProperty.call(options, "body") && typeof options.body !== "string") {
      init.body = JSON.stringify(options.body);
      init.headers = { ...headers, "content-type": "application/json" };
    }
    return parseResponse(await fetch(pathname, init));
  }

  function errorText(error) {
    const code = error?.code || "default";
    return t(`error.${code}`) === `error.${code}` ? t("error.default") : t(`error.${code}`);
  }

  function locationErrorText(error) {
    const key = `location.error.${error?.code || "default"}`;
    return t(key) === key ? errorText(error) : t(key);
  }

  function isLocationError(error) {
    return ["LOCATION_BUSY", "LOCATION_CHANGED", "LOCATION_UNCHANGED", "LOCATION_OVERLAP",
      "LOCATION_OCCUPIED", "LOCATION_UNUSABLE", "LOCATION_INVALID", "TARGET_NOT_EMPTY",
      "SOURCE_CHANGED", "TARGET_CHANGED", "COPY_VERIFY_FAILED", "COPY_FAILED",
      "UNKNOWN_NOTE_FILE", "AMBIGUOUS_NOTE_LAYOUT", "SYMLINK_REFUSED", "CONFIGURED_ROOT_UNAVAILABLE",
      "LOCATION_REBIND_UNAVAILABLE",
      "STATE_WRITE_FAILED"].includes(error?.code);
  }

  function locationBusy() {
    return Boolean(locationChangeBusy || locationPendingResult || context?.locationChange?.active);
  }

  function showStatus(key, values, kind = "") {
    status = { key, text: t(key, values), kind };
    renderStatus();
  }

  function clearStatus() {
    status = null;
    renderStatus();
  }

  function requestConfirm(message, action, { input = false } = {}) {
    confirmRequest = { message, action, input, value: "" };
    renderConfirm();
  }

  function renderConfirm() {
    const banner = nodes["confirm-banner"];
    banner.replaceChildren();
    banner.hidden = !confirmRequest;
    if (!confirmRequest) return;
    banner.append(makeElement("span", "confirm-message", confirmRequest.message));
    if (confirmRequest.input) {
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = t("label.newFolderName");
      input.setAttribute("aria-label", t("label.newFolderName"));
      input.addEventListener("input", () => { confirmRequest.value = input.value; });
      banner.append(input);
    }
    banner.append(
      button(t("label.confirm"), "primary-button", async () => {
        const pending = confirmRequest;
        confirmRequest = null;
        renderConfirm();
        await pending.action(pending.value);
      }),
      button(t("label.cancel"), "text-button", () => { confirmRequest = null; renderConfirm(); }),
    );
  }

  function projectName() {
    const projectPath = context?.projectPath || "";
    return projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath;
  }

  function defaultNotesPath() {
    const projectPath = String(context?.projectPath || "");
    const separator = projectPath.includes("\\") ? "\\" : "/";
    return projectPath.replace(/[\\/]+$/, "") + separator + "notes";
  }

  function laneFor(key) {
    return lanes.find((lane) => lane.key === key) || { key, displayId: "", descriptive: key, label: key };
  }

  function laneLabel(key) {
    return laneFor(key).label || laneFor(key).descriptive || key;
  }

  function pinMap(key) {
    return prefs.pins?.[key] || {};
  }

  function isPinned(key, itemKey) {
    return Boolean(itemKey && pinMap(key)[itemKey] === true);
  }

  function hasDraft() {
    return composerTouched || Boolean(editor?.touched) || Boolean(quoted);
  }

  function clearDrafts() {
    composerDraft = "";
    composerTouched = false;
    quoted = null;
    editor = null;
    deleteConfirm = null;
  }

  function makeElement(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function button(text, className, onClick) {
    const element = makeElement("button", className || "text-button", text);
    element.type = "button";
    element.addEventListener("click", onClick);
    return element;
  }

  function renderStatus() {
    if (!status) {
      nodes["status-banner"].hidden = true;
      nodes["status-banner"].replaceChildren();
      return;
    }
    nodes["status-banner"].hidden = false;
    nodes["status-banner"].className = `banner ${status.kind || ""}`;
    nodes["status-banner"].textContent = status.text;
  }

  function renderMessageArticle(item) {
    const article = makeElement("article", `mirror-message ${item.role === "user" ? "user-message" : "assistant-message"}`);
    article.dataset.itemId = item.id;
    article.dataset.role = item.role;
    if (item.time) article.dataset.time = item.time;
    article.setAttribute("aria-label", t(item.role === "user" ? "label.userMessage" : "label.assistantMessage"));
    global.CollaborativeNotesRenderer.renderMarkdown(item.text, article);
    return article;
  }

  function visibleArticleText(article) {
    return global.CollaborativeNotesRenderer.articleText(article);
  }

  function collapseWhitespace(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function mirrorTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return String(value);
    const pad = (number) => String(number).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function appendHighlightedText(parent, text, query) {
    const value = String(text ?? "");
    const needle = collapseWhitespace(query).toLocaleLowerCase();
    if (!needle) {
      parent.append(document.createTextNode(value));
      return;
    }
    const haystack = collapseWhitespace(value).toLocaleLowerCase();
    const at = haystack.indexOf(needle);
    if (at < 0) {
      parent.append(document.createTextNode(value));
      return;
    }
    const mark = document.createElement("mark");
    mark.textContent = value.slice(Math.max(0, at), Math.min(value.length, at + needle.length));
    parent.append(document.createTextNode(value.slice(0, Math.max(0, at))), mark, document.createTextNode(value.slice(Math.max(0, at) + needle.length)));
  }

  function renderExpandedTurn(turn, query = "") {
    const body = makeElement("div", "mirror-turn-messages");
    for (const item of turn.items || []) {
      const article = renderMessageArticle(item);
      if (query) {
        const match = collapseWhitespace(query);
        global.CollaborativeNotesRenderer.highlightLiteral(article, match, { whitespaceInsensitive: true, caseInsensitive: true });
        article.dataset.searchMatch = match;
      }
      body.append(article);
    }
    return body;
  }

  function recentRow(turn) {
    const section = makeElement("section", "mirror-turn");
    const row = makeElement("button", "mirror-outline-row");
    row.type = "button";
    row.setAttribute("aria-expanded", mirrorExpanded.has(turn.turnId) ? "true" : "false");
    // Three short lines, so the row reads well in a narrow side panel.
    const meta = makeElement("span", "mirror-outline-meta", [
      turn.index === undefined ? "" : `#${turn.index}`,
      mirrorTime(turn.time),
      turn.noted ? "📌" : "",
    ].filter(Boolean).join(" · "));
    row.append(
      meta,
      makeElement("span", "mirror-outline-user", `${t("label.you")}: ${turn.userHead}${turn.userHead.length >= 20 ? "…" : ""}`),
      makeElement("span", "mirror-outline-answer", `→ ${turn.answerHead}${turn.answerHead.length >= 30 ? "…" : ""}`),
    );
    row.addEventListener("click", () => toggleMirrorTurn(turn.turnId));
    section.append(row);
    if (mirrorExpanded.has(turn.turnId)) {
      const turnData = mirrorTurnData.get(turn.turnId);
      section.append(turnData
        ? renderExpandedTurn(turnData, mirrorHighlights.get(turn.turnId) || "")
        : makeElement("div", "empty-state", t("status.loading")));
    }
    return section;
  }

  function renderSearchResult(result) {
    const row = makeElement("button", "mirror-search-result");
    row.type = "button";
    row.append(
      makeElement("span", "mirror-search-meta", `#${result.index} · ${t(result.role === "user" ? "label.userMessage" : "label.assistantMessage") } · `),
    );
    const snippet = makeElement("span", "mirror-search-snippet");
    appendHighlightedText(snippet, result.snippet, mirrorFilter);
    row.append(snippet);
    row.addEventListener("click", () => openMirrorSearchResult(result));
    return row;
  }

  function renderMirror() {
    const panel = nodes["mirror-panel"];
    panel.hidden = !mirrorOpen;
    if (!mirrorOpen) return;
    nodes["mirror-heading"].textContent = t("label.mirror");
    nodes["mirror-close"].textContent = t("label.mirrorClose");
    nodes["mirror-hint"].textContent = t("label.mirrorHint");
    nodes["mirror-filter-label"].textContent = t("label.mirrorFilter");
    nodes["mirror-filter"].placeholder = t("label.mirrorSearchPlaceholder");
    nodes["mirror-filter"].setAttribute("aria-label", t("label.mirrorFilter"));
    nodes["mirror-quote-selection"].textContent = t("label.quoteSelection");
    nodes["mirror-list"].replaceChildren();
    if (mirrorSearching) {
      nodes["mirror-list"].append(makeElement("div", "empty-state", t("status.mirrorSearching")));
    } else if (mirrorSearchResults) {
      const renderedTurns = new Set();
      for (const result of mirrorSearchResults) {
        const resultSection = makeElement("section", "mirror-turn");
        resultSection.append(renderSearchResult(result));
        if (mirrorExpanded.has(result.turnId) && !renderedTurns.has(result.turnId)) {
          const turnData = mirrorTurnData.get(result.turnId);
          resultSection.append(turnData
            ? renderExpandedTurn(turnData, mirrorHighlights.get(result.turnId) || mirrorFilter)
            : makeElement("div", "empty-state", t("status.loading")));
          renderedTurns.add(result.turnId);
        }
        nodes["mirror-list"].append(resultSection);
      }
      if (!mirrorSearchResults.length) nodes["mirror-list"].append(makeElement("div", "empty-state", t("label.mirrorNotFound")));
    } else {
      for (const turn of mirrorRecent) nodes["mirror-list"].append(recentRow(turn));
      if (mirrorNextCursor) {
        const earlier = button(t("label.mirrorLoadEarlier"), "text-button mirror-load-earlier", async () => {
          if (mirrorLoadingEarlier) return;
          mirrorLoadingEarlier = true;
          renderMirror();
          try {
            const result = await api(`/mirror/recent?limit=20&cursor=${encodeURIComponent(mirrorNextCursor)}`);
            const turns = result.turns || [];
            mirrorRecent.push(...turns);
            rememberEmbeddedMirrorTurns(turns);
            mirrorNextCursor = result.nextCursor || null;
          } catch (error) {
            showStatus("status.loadFailed", { error: errorText(error) }, "error");
          } finally {
            mirrorLoadingEarlier = false;
            renderMirror();
          }
        });
        earlier.disabled = mirrorLoadingEarlier;
        nodes["mirror-list"].append(earlier);
      }
    }
  }

  async function loadMirrorRecent() {
    const result = await api("/mirror/recent?limit=10");
    mirrorRecent = result.turns || [];
    rememberEmbeddedMirrorTurns(mirrorRecent);
    mirrorNextCursor = result.nextCursor || null;
    renderMirror();
  }

  function rememberEmbeddedMirrorTurns(turns) {
    for (const turn of turns || []) {
      if (Array.isArray(turn.items)) mirrorTurnData.set(turn.turnId, turn);
    }
  }

  async function openMirror() {
    mirrorOpen = true;
    mirrorRecent = [];
    mirrorNextCursor = null;
    mirrorLoadingEarlier = false;
    mirrorTurnData = new Map();
    mirrorExpanded = new Set();
    mirrorHighlights = new Map();
    mirrorSearchResults = null;
    mirrorFilter = "";
    mirrorSearching = false;
    renderAll();
    try {
      await loadMirrorRecent();
      const newest = mirrorRecent[0];
      if (newest) await expandMirrorTurn(newest.turnId);
    } catch (error) { showStatus("status.loadFailed", { error: errorText(error) }, "error"); }
  }

  function closeMirror() {
    mirrorOpen = false;
    clearStatus();
    renderMirror();
  }

  async function expandMirrorTurn(turnId, query = "") {
    mirrorExpanded.add(turnId);
    if (query) mirrorHighlights.set(turnId, collapseWhitespace(query));
    if (!mirrorTurnData.has(turnId)) {
      try {
        mirrorTurnData.set(turnId, await api(`/mirror/turn?turnId=${encodeURIComponent(turnId)}`));
      } catch (error) {
        mirrorExpanded.delete(turnId);
        showStatus("status.loadFailed", { error: errorText(error) }, "error");
        return;
      }
    }
    renderMirror();
    if (query) requestAnimationFrame(() => nodes["mirror-list"].querySelector("mark")?.scrollIntoView?.({ block: "center" }));
  }

  async function toggleMirrorTurn(turnId) {
    if (mirrorExpanded.has(turnId)) {
      mirrorExpanded.delete(turnId);
      mirrorHighlights.delete(turnId);
      renderMirror();
      return;
    }
    await expandMirrorTurn(turnId);
  }

  async function openMirrorSearchResult(result) {
    if (result.turn) mirrorTurnData.set(result.turnId, result.turn);
    await expandMirrorTurn(result.turnId, mirrorFilter);
  }

  async function searchMirror() {
    const query = mirrorFilter;
    if (query.length < 2) {
      mirrorSearching = false;
      mirrorSearchResults = null;
      renderMirror();
      return;
    }
    const sequence = ++mirrorSearchSequence;
    mirrorSearching = true;
    renderMirror();
    try {
      const result = await api(`/mirror/search?q=${encodeURIComponent(query)}`);
      if (sequence !== mirrorSearchSequence || query !== mirrorFilter) return;
      mirrorSearchResults = result.results || [];
      mirrorSearching = false;
      renderMirror();
      const turnIds = [...new Set(mirrorSearchResults.map((entry) => entry.turnId))];
      if (query.length >= 20 && turnIds.length === 1) await expandMirrorTurn(turnIds[0], query);
    } catch (error) {
      mirrorSearching = false;
      showStatus("status.loadFailed", { error: errorText(error) }, "error");
      renderMirror();
    }
  }

  function articleForSelection(node) {
    const element = node?.nodeType === 1 ? node : node?.parentElement;
    return element?.closest?.("article[data-item-id]") || null;
  }

  function quoteSelection() {
    const selection = global.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      showStatus("label.noSelection", undefined, "warning");
      return;
    }
    const range = selection.getRangeAt(0);
    const startArticle = articleForSelection(range.startContainer);
    const endArticle = articleForSelection(range.endContainer);
    if (!startArticle || startArticle !== endArticle) {
      showStatus("label.selectWithinMessage", undefined, "warning");
      return;
    }
    const snapshot = range.toString();
    if (!snapshot.trim()) {
      showStatus("label.noSelection", undefined, "warning");
      return;
    }
    quoted = {
      snapshot,
      source: { threadId, itemId: startArticle.dataset.itemId },
      role: startArticle.dataset.role,
      time: startArticle.dataset.time,
    };
    mirrorOpen = false;
    clearStatus();
    renderAll();
    nodes["composer"].focus();
  }

  function renderQuotedSource() {
    const box = nodes["quoted-source"];
    box.replaceChildren();
    box.hidden = !quoted;
    if (!quoted) return;
    box.append(makeElement("strong", "quoted-source-label", t("label.quotedSource")));
    const roleLabel = quoted.role ? t(quoted.role === "user" ? "label.userMessage" : "label.assistantMessage") : "";
    if (roleLabel || quoted.time) box.append(makeElement("span", "quoted-source-meta", ` · ${roleLabel}${quoted.time ? ` · ${mirrorTime(quoted.time)}` : ""}`));
    box.append(makeElement("div", "quoted-source-text", quoted.snapshot));
    box.append(button(`✕ ${t("label.removeQuote")}`, "text-button", () => {
      quoted = null;
      clearStatus();
      renderAll();
    }));
  }

  function renderSourceView() {
    const panel = nodes["source-view"];
    panel.replaceChildren();
    panel.hidden = !sourceView;
    if (!sourceView) return;
    if (sourceView.error) {
      panel.append(makeElement("h2", "source-heading", t("label.sourceUnavailable")), makeElement("div", "banner error", t("label.sourceUnavailable")), makeElement("div", "quoted-source-text", sourceView.snapshot || ""));
      panel.append(button(t("label.backToNotes"), "text-button", () => { sourceView = null; renderAll(); }));
      return;
    }
    const data = sourceView.data;
    if (!data) {
      panel.append(makeElement("div", "empty-state", t("status.loading")));
      return;
    }
    const header = makeElement("div", "source-header");
    header.append(makeElement("h2", "source-heading", `${data.thread?.title || String(data.thread?.id || "").slice(0, 12)} · ${laneLabel(sourceView.laneKey)}`));
    header.append(button(t("label.backToNotes"), "text-button", () => { sourceView = null; renderAll(); }));
    panel.append(header);
    // What the user wrote first, then the sentence it quotes, then the turns.
    const noteBox = makeElement("section", "source-note");
    noteBox.append(makeElement("div", "source-block-label", t("label.yourNote")));
    noteBox.append(makeElement("div", sourceView.noteText ? "source-note-text" : "source-note-text faint", sourceView.noteText || t("label.emptyNote")));
    panel.append(noteBox);
    const quoteBox = makeElement("section", "source-quote");
    quoteBox.append(makeElement("div", "source-block-label", t("label.quotedSource")));
    quoteBox.append(makeElement("div", "quoted-source-text", data.snapshot));
    panel.append(quoteBox);
    const earlier = button(data.hasEarlier === false ? t("label.noEarlier") : `↑ ${t("label.showEarlier")}`, "text-button source-more", () => loadSourceView(sourceView.before + 1, sourceView.after));
    earlier.disabled = data.hasEarlier === false;
    panel.append(earlier);
    const body = makeElement("div", "source-turns");
    const turns = data.turns || [];
    const targetIndex = turns.findIndex((turn) => (turn.items || []).some((item) => item.id === data.targetItemId));
    let targetArticle;
    turns.forEach((turn, index) => {
      const offset = targetIndex < 0 ? null : index - targetIndex;
      const section = makeElement("section", offset === 0 ? "source-turn source-turn-target" : "source-turn");
      const distance = Math.abs(offset ?? 0);
      const label = offset === null ? "" : offset === 0 ? t("label.turnQuoted")
        : t(`${offset < 0 ? "label.turnBefore" : "label.turnAfter"}${distance === 1 ? "One" : ""}`, { n: distance });
      const time = (turn.items || []).find((item) => item.time)?.time;
      section.append(makeElement("div", "source-turn-label", [label, time ? mirrorTime(time) : ""].filter(Boolean).join(" · ")));
      let previousRole = null;
      for (const item of turn.items || []) {
        const article = renderMessageArticle(item);
        if (item.id === data.targetItemId) targetArticle = article;
        // The role tag sits outside the message so it never joins its text,
        // and appears only when the speaker changes.
        if (item.role !== previousRole) section.append(makeElement("div", "source-role", t(item.role === "user" ? "label.roleYou" : "label.roleAgent")));
        previousRole = item.role;
        section.append(article);
      }
      body.append(section);
    });
    panel.append(body);
    const count = targetArticle ? global.CollaborativeNotesRenderer.highlightLiteral(targetArticle, data.snapshot) : 0;
    if (!targetArticle || count === 0) {
      targetArticle?.classList.add("not-exact-source");
      panel.append(makeElement("div", "banner warning", t("label.sourceNotExact")));
    } else {
      targetArticle.querySelector("mark")?.scrollIntoView?.({ block: "center" });
    }
    const actions = makeElement("div", "source-actions");
    const later = button(data.hasLater === false ? t("label.noLater") : `↓ ${t("label.showLater")}`, "text-button source-more", () => loadSourceView(sourceView.before, sourceView.after + 1));
    later.disabled = data.hasLater === false;
    actions.append(later);
    const link = makeElement("a", "text-button", t("label.openOriginalThread"));
    link.href = `codex://threads/${encodeURIComponent(data.thread?.id || "")}`;
    link.target = "_blank";
    actions.append(link);
    panel.append(actions);
  }

  async function loadSourceView(before, after) {
    if (!sourceView) return;
    const current = sourceView;
    try {
      const consent = current.crossThread ? "&consent=per-request" : "";
      const data = await api(`/source?lane=${encodeURIComponent(current.laneKey)}&itemKey=${encodeURIComponent(current.itemKey)}&before=${before}&after=${after}${consent}`);
      sourceView = { ...current, data, before, after, error: false };
      renderSourceView();
    } catch (error) {
      sourceView = { ...current, error: true, snapshot: current.snapshot };
      renderSourceView();
      showStatus("status.loadFailed", { error: errorText(error) }, "error");
    }
  }

  async function openSource(laneKey, note) {
    if (!note.source || !note.sourceSnapshot) return;
    const crossThread = note.source.threadId !== threadId;
    const open = async () => {
      clearStatus();
      sourceView = { laneKey, itemKey: note.itemKey, snapshot: note.sourceSnapshot, noteText: note.authored || "", crossThread, before: 0, after: 0, data: null };
      renderAll();
      // Open on the quoted turn alone; earlier and later turns load on request.
      await loadSourceView(0, 0);
    };
    if (crossThread) {
      requestConfirm(t("label.crossThreadConfirm", { title: note.source.threadId }), open);
      return;
    }
    await open();
  }

  function renderHeader() {
    nodes["thread-title"].textContent = context?.title || t("label.newThread");
    nodes["project-name"].textContent = context ? t("header.project", { name: projectName() }) : "";
    nodes["help-button"].title = t("header.help");
    nodes["help-button"].setAttribute("aria-label", t("header.help"));
    nodes["search-button"].title = t("header.search");
    nodes["search-button"].setAttribute("aria-label", t("header.search"));
    nodes["refresh-button"].title = t("header.refresh");
    nodes["refresh-button"].setAttribute("aria-label", t("header.refresh"));
    document.title = context?.carry?.status === "unresolved" ? t("app.pendingTitle") : t("app.title");
  }

  function renderHooks() {
    const banner = nodes["hooks-banner"];
    banner.replaceChildren();
    if (context?.hooks?.trusted !== null) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    banner.append(makeElement("strong", "", t("hooks.warning")));
    const list = makeElement("ul", "compact-list");
    for (const key of ["hooks.feature1", "hooks.feature2", "hooks.feature3"]) {
      list.append(makeElement("li", "", t(key)));
    }
    banner.append(list);
  }

  function branchDismissed(childId) {
    try { return global.sessionStorage.getItem(`collaborative-notes:branch:${childId}`) === "1"; } catch { return false; }
  }

  function dismissBranch(childId) {
    try { global.sessionStorage.setItem(`collaborative-notes:branch:${childId}`, "1"); } catch { /* best effort */ }
    renderBranches();
  }

  // Opened from another conversation's panel ("Open the branch's Notes"): say
  // whose notes these are and offer the way back.
  function renderBranchOrigin(banner) {
    const from = new URLSearchParams(global.location.search).get("from");
    if (!from || from === threadId) return false;
    const parentTitle = context?.forkedFrom?.id === from && context.forkedFrom.title ? context.forkedFrom.title : t("label.parentConversation");
    const row = makeElement("div", "banner-row");
    row.append(makeElement("span", "", t("label.branchOrigin", { title: context?.title || threadId.slice(0, 8), parent: parentTitle })));
    row.append(button(t("label.backToParent", { parent: parentTitle }), "text-button", () => {
      global.location.href = `/t/${encodeURIComponent(from)}`;
    }));
    banner.append(row);
    return true;
  }

  function renderBranches() {
    const banner = nodes["branch-banner"];
    banner.replaceChildren();
    if (renderBranchOrigin(banner)) { banner.hidden = false; return; }
    const forks = (context?.recentForks || []).filter((fork) => fork?.childId && !branchDismissed(fork.childId)).slice(0, 3);
    banner.hidden = forks.length === 0;
    for (const fork of forks) {
      const title = fork.title || String(fork.childId).slice(0, 12);
      const row = makeElement("div", "branch-row");
      row.append(makeElement("span", "branch-message", t("branch.notice", { title })));
      row.append(button(t("branch.open"), "text-button", () => {
        global.location.href = `/t/${encodeURIComponent(threadId)}/branch/${encodeURIComponent(fork.childId)}`;
      }));
      row.append(button(t("label.dismiss"), "text-button branch-dismiss", () => dismissBranch(fork.childId)));
      banner.append(row);
    }
  }

  function renderCarry() {
    const banner = nodes["carry-banner"];
    banner.replaceChildren();
    const carry = context?.carry;
    const pending = carry?.status === "unresolved" || carry?.status === "partial";
    if (carryResult) {
      banner.hidden = false;
      banner.append(makeElement("strong", "", t("label.carryDone")));
      banner.append(makeElement("p", "hint", t("label.forkTabHint", { title: context?.title || t("label.newThread") })));
      banner.append(makeElement("div", "", carryResult));
      banner.append(button(t("label.gotIt"), "text-button", () => { carryResult = null; renderCarry(); }));
      return;
    }
    if (!pending) { banner.hidden = true; return; }
    banner.hidden = false;
    if (carryConflict?.conflicts) {
      banner.append(makeElement("strong", "", t("label.carryConflict")));
      for (const item of carryConflict.conflicts || []) {
        const row = makeElement("div", "carry-conflict-row");
        row.append(makeElement("div", "", laneLabel(item.lane)));
        const preview = makeElement("div", "carry-preview");
        for (const [labelKey, notes] of [["label.carryParentSide", item.parentNotes || []], ["label.carryCurrentSide", item.currentNotes || []]]) {
          preview.append(makeElement("div", "carry-side-label", t(labelKey, { n: notes.length })));
          const list = makeElement("ul", "carry-side-list");
          for (const note of notes) list.append(makeElement("li", "", `${note.sourced ? "❝ " : ""}${note.text || t("label.emptyNote")}`));
          preview.append(list);
        }
        row.append(preview);
        const select = document.createElement("select");
        for (const choice of ["merge", "keep", "replace"]) {
          const option = document.createElement("option");
          option.value = choice;
          option.textContent = t(`label.carry${choice[0].toUpperCase()}${choice.slice(1)}`);
          option.selected = carryConflict.resolutions?.[item.lane] === choice;
          select.append(option);
        }
        select.addEventListener("change", () => { carryConflict.resolutions[item.lane] = select.value; });
        row.append(select);
        banner.append(row);
      }
      banner.append(button(t("label.confirmCarry"), "primary-button", () => decideCarry(
        carryConflict.choice || "all",
        carryConflict.lanes || LANE_KEYS,
        carryConflict.resolutions,
        carryConflict.observations,
      )));
      return;
    }
    if (carry?.status === "partial") {
      banner.append(makeElement("strong", "", t("label.carryPartial")));
      for (const [key, entry] of Object.entries(carry.lanes || {})) {
        banner.append(makeElement("div", "carry-progress", `${laneLabel(key)}: ${entry.outcome || "pending"}`));
      }
      const selected = carry.selectedLanes || LANE_KEYS.filter((key) => carry.lanes?.[key]?.outcome !== "skipped");
      banner.append(button(t("label.carryContinue"), "primary-button", () => decideCarry(carry.choice, selected)));
      return;
    }
    banner.append(makeElement("strong", "", t("label.carryQuestion")));
    banner.append(makeElement("p", "hint", t("label.forkTabHint", { title: context?.title || t("label.newThread") })));
    const actions = makeElement("div", "banner-actions");
    actions.append(
      button(t("label.all"), "primary-button", () => decideCarry("all")),
      button(t("label.some"), "text-button", () => { carrySomeLanes = new Set(LANE_KEYS); carryConflict = { selecting: true }; renderCarry(); }),
      button(t("label.none"), "text-button", () => decideCarry("none")),
    );
    banner.append(actions);
    if (carryConflict?.selecting) {
      const list = makeElement("div", "carry-lane-list");
      for (const lane of lanes) {
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = carrySomeLanes.has(lane.key);
        checkbox.addEventListener("change", () => checkbox.checked ? carrySomeLanes.add(lane.key) : carrySomeLanes.delete(lane.key));
        label.append(checkbox, makeElement("span", "", lane.label));
        list.append(label);
      }
      banner.append(list, button(t("label.confirmSelected"), "primary-button", () => decideCarry("some", [...carrySomeLanes])));
    }
  }

  async function decideCarry(choice, selected = LANE_KEYS, resolutions, observations) {
    if (choice === "some" && selected.length === 0) { showStatus("status.selectLane", undefined, "warning"); return; }
    try {
      const result = await api("/carry", { method: "POST", body: { choice, lanes: selected, resolutions, observations } });
      carryConflict = null;
      carryResult = Object.entries(result.outcomes || {})
        .map(([lane, entry]) => t(`label.carryOutcome.${entry.outcome}`, { lane: laneLabel(lane), n: entry.carried ?? 0 })
          + (entry.skipped ? t("label.carrySkipped", { n: entry.skipped }) : ""))
        .join(" · ");
      await loadContext({ skipLane: true });
      renderAll();
    } catch (error) {
      if (error.code === "CARRY_STALE") {
        // Something changed since the preview: ask again with fresh content.
        showStatus("status.carryStale", undefined, "warning");
        return decideCarry(choice, selected);
      }
      if (error.code === "CARRY_ALREADY_DECIDED") {
        carryConflict = null;
        await loadContext({ skipLane: true });
        await loadLane(activeLane);
        renderAll();
        showStatus("status.carryDecidedElsewhere", undefined, "success");
        return;
      }
      if (error.code === "CARRY_CONFLICT" || error.data?.conflicts) {
        // Default every conflicting lane to the option the select shows (merge).
        carryConflict = {
          ...error.data,
          choice: error.data?.choice || context?.carry?.choice || choice,
          lanes: error.data?.lanes || context?.carry?.selectedLanes || selected,
          resolutions: Object.fromEntries((error.data?.conflicts || []).map((item) => [item.lane, "merge"])),
        };
        renderCarry();
      } else showStatus("status.carryFailed", { error: errorText(error) }, "error");
    }
  }

  function renderHelp() {
    const panel = nodes["help-panel"];
    panel.replaceChildren();
    panel.hidden = !helpOpen;
    if (!helpOpen) return;
    const heading = makeElement("div", "help-heading");
    heading.append(makeElement("h2", "", t("label.helpTitle")));
    heading.append(button(t("label.helpClose"), "text-button", () => { helpOpen = false; renderHelp(); }));
    panel.append(heading, makeElement("p", "", t("help.body")));
    const list = makeElement("ul", "help-list");
    for (const key of ["help.lane1", "help.lane2", "help.lane3", "help.lane4"]) {
      list.append(makeElement("li", "", t(key)));
    }
    panel.append(list, makeElement("p", "", t("help.edit")));
    for (const key of ["help.quote", "help.findFarBack", "help.source", "help.reference", "help.branches", "help.crossThread", "help.agent", "help.panel"]) {
      // Bold the lead-in ("Return to source:") so each paragraph is easy to find.
      const text = t(key);
      const match = text.match(/^([^：:]{1,40}[：:])\s*/);
      const paragraph = makeElement("p", "", "");
      if (match) paragraph.append(makeElement("strong", "", match[1]), document.createTextNode(` ${text.slice(match[0].length)}`));
      else paragraph.textContent = text;
      panel.append(paragraph);
    }
  }

  function renderConflict() {
    const panel = nodes["conflict-banner"];
    panel.replaceChildren();
    panel.hidden = !conflict;
    if (!conflict) return;
    panel.append(makeElement("strong", "", conflict.poll ? t("status.conflictPoll") : t("status.conflict")));
    const actions = makeElement("div", "banner-actions");
    actions.append(
      button(t("status.conflictLoad"), "text-button", () => resolveConflict("load")),
      button(t("status.conflictOverwrite"), "text-button", () => resolveConflict("overwrite")),
      button(t("status.conflictCancel"), "text-button", () => resolveConflict("cancel")),
    );
    panel.append(actions);
  }

  function selected(laneKey, itemKey) {
    return selection.targets.some((target) => target.lane === laneKey && target.itemKey === itemKey);
  }

  async function saveSelection(targets) {
    const generation = selection.generation + 1;
    selectionReceipt = null;
    try {
      const result = await api("/selection", { method: "PUT", body: { targets, generation } });
      selection = { targets: result.targets || targets, generation: result.generation || generation, lastBinding: null };
      // A corrected selection makes an earlier send-failure banner stale.
      clearStatus();
      renderMain();
      startSelectionPolling();
    } catch (error) {
      if (error.status === 409 && error.data?.currentGeneration !== undefined) selection.generation = error.data.currentGeneration;
      showStatus("status.selectionSaved", { reason: errorText(error) }, "error");
    }
  }

  function toggleSelection(laneKey, itemKey) {
    const next = selection.targets.filter((target) => !(target.lane === laneKey && target.itemKey === itemKey));
    if (next.length === selection.targets.length) next.push({ lane: laneKey, itemKey });
    void saveSelection(next);
  }

  function removeSelection(laneKey, itemKey) {
    void saveSelection(selection.targets.filter((target) => !(target.lane === laneKey && target.itemKey === itemKey)));
  }

  function renderSelectionTray() {
    const tray = nodes["selection-tray"];
    tray.replaceChildren();
    const attaching = selection.lastBinding?.prepared && !selection.lastBinding.attached;
    if (!selection.targets.length && !selectionReceipt && !attaching) { tray.hidden = true; return; }
    tray.hidden = false;
    if (selectionReceipt) {
      tray.append(makeElement("div", "selection-receipt", selectionReceipt.faint
        ? t("status.selectionAttachedFaint", { n: selectionReceipt.count })
        : `✓ ${t("status.selectionAttached", { n: selectionReceipt.count })}`));
    }
    if (!selectionReceipt && attaching) {
      tray.append(makeElement("div", "selection-receipt", t("status.selectionAttaching")));
    }
    if (!selection.targets.length) return;
    tray.append(makeElement("strong", "", t("label.selectionTray", { n: selection.targets.length })));
    const list = makeElement("div", "selection-list");
    for (const target of selection.targets) {
      // Show a short excerpt, never the internal item key.
      const lane = laneData.get(target.lane);
      const note = lane?.notes?.find((entry) => entry.addressable && entry.itemKey === target.itemKey);
      const excerptSource = note ? (note.authored || note.sourceSnapshot || "") : null;
      const excerpt = excerptSource === null
        ? (lane ? t("label.selectionMissing") : "…")
        : (excerptSource.replace(/\s+/g, " ").trim().slice(0, 40) || t("label.emptyNote"));
      const row = makeElement("div", note || !lane ? "selection-row" : "selection-row missing", `${laneLabel(target.lane)} · ${excerpt}`);
      row.append(button(t("label.remove"), "text-button", () => removeSelection(target.lane, target.itemKey)));
      list.append(row);
    }
    tray.append(list, button(t("label.removeAll"), "text-button", () => void saveSelection([])));
  }

  function startSelectionPolling() {
    if (selectionPollTimer) clearInterval(selectionPollTimer);
    if (!selection.targets.length && !(selection.lastBinding?.prepared && !selection.lastBinding.attached)) return;
    selectionPollTimer = setInterval(async () => {
      try {
        const latest = await api("/selection");
        if (latest.lastBinding && latest.lastBinding.generation === selection.generation) {
          const binding = latest.lastBinding;
          if (binding.ok === true && binding.attached === true && binding.count !== undefined) {
            selectionReceipt = { count: binding.count, faint: false };
            selection = { targets: [], generation: latest.generation, lastBinding: binding };
            clearInterval(selectionPollTimer);
            selectionPollTimer = null;
            renderAll();
            setTimeout(() => { selectionReceipt = selectionReceipt ? { ...selectionReceipt, faint: true } : null; renderSelectionTray(); }, 4000);
          } else if (binding.ok === false) {
            selection = { targets: latest.targets || selection.targets, generation: latest.generation, lastBinding: binding };
            showStatus("status.selectionFailure", { reason: binding.reason || errorText(binding), code: binding.failures?.[0]?.code || "FAILED" }, "error");
            renderMain();
          } else if (binding.prepared) {
            selectionReceipt = null;
            selection = { targets: [], generation: latest.generation, lastBinding: binding };
            renderSelectionTray();
          }
        }
      } catch { /* keep pending selection */ }
    }, 1000);
  }

  function renderLaneTabs() {
    nodes["lane-tabs"].replaceChildren();
    for (const lane of lanes) {
      const tab = button(lane.label, "lane-tab", () => selectLane(lane.key));
      tab.dataset.lane = lane.key;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(lane.key === activeLane));
      if (lane.key === activeLane) tab.classList.add("selected");
      nodes["lane-tabs"].append(tab);
    }
  }

  function renderSearch() {
    nodes["search-panel"].hidden = !searchOpen;
    nodes["search-label"].textContent = t("header.search");
    nodes["search-input"].placeholder = t("label.searchPlaceholder");
    nodes["search-input"].setAttribute("aria-label", t("header.search"));
    nodes["search-close"].textContent = t("label.searchClose");
    nodes["search-close"].title = t("label.searchClose");
    if (searchOpen && nodes["search-input"].value !== searchQuery) nodes["search-input"].value = searchQuery;
  }

  function renderComposer() {
    nodes["composer-heading"].textContent = t("label.composer");
    nodes["new-note-button"].textContent = t("label.newNote");
    nodes["composer"].placeholder = t("label.composerPlaceholder");
    nodes["composer"].setAttribute("aria-label", t("label.noteBody"));
    nodes["composer-lane-label"].textContent = t("label.composerLane");
    nodes["composer-lane"].replaceChildren();
    for (const lane of lanes) {
      const option = document.createElement("option");
      option.value = lane.key;
      option.textContent = lane.label;
      option.selected = lane.key === composerLane;
      nodes["composer-lane"].append(option);
    }
    nodes["quote-button"].textContent = t("label.quoteFromConversation");
    if (nodes["composer"].value !== composerDraft) nodes["composer"].value = composerDraft;
    nodes["save-note-button"].textContent = t("label.saveNote");
    nodes["save-note-button"].disabled = locationBusy();
    renderQuotedSource();
  }

  function sortedNotes(key) {
    const notes = [...(laneData.get(key)?.notes || [])];
    const ordered = sortOrder === "newest" ? notes.reverse() : notes;
    const pins = pinMap(key);
    return ordered.sort((a, b) => Number(isPinned(key, b.itemKey)) - Number(isPinned(key, a.itemKey)));
  }

  function noteBody(note) {
    if (note.kind === "legacy") return note.text || "";
    if (note.kind === "opaque") return t("label.unreadable");
    return note.authored || t("label.emptyNote");
  }

  function renderNoteCard(note, laneKey, options = {}) {
    const card = makeElement("article", "note-card");
    if (isPinned(laneKey, note.itemKey)) card.classList.add("pinned");
    const head = makeElement("div", "note-card-head");
    head.append(makeElement("span", "note-kind", note.kind === "legacy" ? t("label.legacy") : t("label.note")));
    if (options.search) head.append(makeElement("span", "note-lane", laneLabel(laneKey)));
    if (note.addressable && note.itemKey) {
      const label = document.createElement("label");
      label.className = "note-selection";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selected(laneKey, note.itemKey);
      checkbox.setAttribute("aria-label", t("label.quoteAria"));
      checkbox.addEventListener("change", () => toggleSelection(laneKey, note.itemKey));
      label.append(checkbox, makeElement("span", "", t("label.quote")));
      head.append(label);
    }
    card.append(head);

    const editing = editor && editor.laneKey === laneKey && editor.itemKey === note.itemKey;
    if (editing) {
      const area = document.createElement("textarea");
      area.className = "edit-area";
      area.rows = 5;
      area.value = editor.content;
      area.setAttribute("aria-label", t("label.noteBody"));
      area.addEventListener("input", () => { editor.content = area.value; editor.touched = true; });
      area.addEventListener("compositionstart", () => { composing = true; });
      area.addEventListener("compositionend", () => {
        composing = false;
        editor.content = area.value;
        if (renderPending) { renderPending = false; renderNotes(); }
      });
      card.append(area);
      const editActions = makeElement("div", "card-actions");
      editActions.append(
        button(t("label.saveEdit"), "primary-button", () => saveEdit()),
        button(t("label.cancel"), "text-button", () => { editor = null; renderNotes(); }),
      );
      card.append(editActions);
      return card;
    }

    const body = makeElement("div", "note-body");
    appendHighlighted(body, noteBody(note), searchQuery.trim());
    body.setAttribute("dir", "auto");
    card.append(body);
    if (note.sourceSnapshot) {
      const sourceBox = makeElement("div", "note-source");
      const sourceButton = button(`${t("label.source")} ${expandedSources.has(`${laneKey}:${note.itemKey}`) ? "▾" : "▸"}`, "text-button", () => {
        const key = `${laneKey}:${note.itemKey}`;
        if (expandedSources.has(key)) expandedSources.delete(key); else expandedSources.add(key);
        renderNotes();
      });
      sourceBox.append(sourceButton);
      if (expandedSources.has(`${laneKey}:${note.itemKey}`)) sourceBox.append(makeElement("div", "note-source-text", note.sourceSnapshot));
      else {
        // A short preview, so a sourced note with an empty body still says what it quotes.
        const preview = note.sourceSnapshot.replace(/\s+/g, " ").trim();
        sourceBox.append(makeElement("span", "note-source-preview", `“${preview.length > 40 ? `${preview.slice(0, 40)}…` : preview}”`));
      }
      card.append(sourceBox);
    }
    const actions = makeElement("div", "card-actions");
    if (note.addressable && note.itemKey) {
      actions.append(button(isPinned(laneKey, note.itemKey) ? t("label.unpin") : t("label.pin"), "text-button", () => togglePin(laneKey, note.itemKey)));
      actions.append(button(t("label.edit"), "text-button", () => beginEdit(laneKey, note)));
      if (deleteConfirm?.laneKey === laneKey && deleteConfirm.itemKey === note.itemKey) {
        actions.append(makeElement("span", "confirm-text", t("label.deleteConfirm")));
        actions.append(button(t("label.deleteConfirm"), "danger-button", () => deleteNote(laneKey, note.itemKey)));
        actions.append(button(t("label.cancel"), "text-button", () => { deleteConfirm = null; renderNotes(); }));
      } else {
        actions.append(button(t("label.delete"), "text-button danger-text", () => {
          deleteConfirm = { laneKey, itemKey: note.itemKey };
          renderNotes();
        }));
      }
      if (note.source && note.sourceSnapshot) {
        actions.append(button(t("label.returnToSource"), "text-button", () => openSource(laneKey, note)));
      }
    }
    card.append(actions);
    return card;
  }

  /** Append text, wrapping case-insensitive literal matches of query in <mark>. */
  function appendHighlighted(parent, text, query) {
    const value = String(text ?? "");
    if (!query) { parent.textContent = value; return; }
    const lower = value.toLowerCase();
    const needle = query.toLowerCase();
    let from = 0;
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, from)) {
      if (at > from) parent.append(document.createTextNode(value.slice(from, at)));
      parent.append(makeElement("mark", "", value.slice(at, at + needle.length)));
      from = at + needle.length;
    }
    if (from < value.length) parent.append(document.createTextNode(value.slice(from)));
  }

  function renderSearchResults() {
    nodes["saved-heading"].textContent = searchResults
      ? t("label.searchResults", { n: searchResults.total })
      : t("label.savedCount", { n: 0 });
    nodes["notes-list"].replaceChildren();
    if (!searchResults || searchResults.total === 0) {
      nodes["notes-list"].append(makeElement("div", "empty-state", t("label.emptySearch")));
      return;
    }
    for (const group of searchResults.groups) {
      if (group.notes.length === 0) continue;
      nodes["notes-list"].append(makeElement("h3", "search-group-heading", group.label));
      for (const note of group.notes) nodes["notes-list"].append(renderNoteCard(note, group.key, { search: true }));
    }
  }

  function renderNotes() {
    if (composing) { renderPending = true; return; }
    const active = document.activeElement;
    const keepEdit = active?.classList?.contains("edit-area")
      ? { start: active.selectionStart, end: active.selectionEnd, scroll: active.scrollTop }
      : null;
    renderNotesNow();
    if (keepEdit) {
      const area = nodes["notes-list"]?.querySelector?.(".edit-area") || document.querySelector(".edit-area");
      if (area) {
        area.focus();
        area.setSelectionRange(keepEdit.start, keepEdit.end);
        area.scrollTop = keepEdit.scroll;
      }
    }
  }

  function renderNotesNow() {
    if (searchQuery.trim()) {
      renderSearchResults();
      return;
    }
    const current = laneData.get(activeLane) || { notes: [] };
    nodes["saved-heading"].textContent = t("label.savedCount", { n: current.notes.length });
    nodes["notes-list"].replaceChildren();
    const notes = sortedNotes(activeLane);
    if (notes.length === 0) {
      nodes["notes-list"].append(makeElement("div", "empty-state", t("label.empty")));
      return;
    }
    for (const note of notes) nodes["notes-list"].append(renderNoteCard(note, activeLane));
  }

  function renderFooter() {
    const root = context?.setup?.root;
    const footer = nodes["footer"];
    footer.replaceChildren();
    if (!root) {
      footer.textContent = t("label.notConfigured");
      return;
    }
    const row = makeElement("div", "footer-location");
    row.append(makeElement("span", "footer-bound", t("label.boundPath", { path: root })));
    if (context?.setup?.state === "INITIALIZED") row.append(button(t("relocate.change"), "text-button", openRelocation));
    footer.append(row);
  }

  function openRelocation() {
    if (relocating || context?.setup?.state !== "INITIALIZED" || setupBusy) return;
    relocating = true;
    locationChangeMode = Boolean(context?.nativeFolderPicker && context?.setup?.code !== "CONFIGURED_ROOT_UNAVAILABLE");
    locationTarget = null;
    locationChangeBusy = false;
    locationPendingResult = null;
    relocationNested = null;
    relocationAttempt = null;
    nativeCandidate = null;
    nativeFallback = false;
    nativeSequence += 1;
    nativeAbort?.abort();
    nativeAbort = null;
    pickerSequence += 1;
    pickerBusy = false;
    picker = null;
    clearStatus();
    renderAll();
  }

  function cancelRelocation() {
    if (relocationBusy) return;
    locationChangeMode = false;
    locationTarget = null;
    locationChangeBusy = false;
    locationPendingResult = null;
    relocating = false;
    relocationNested = null;
    relocationAttempt = null;
    nativeCandidate = null;
    nativeFallback = false;
    pickerSequence += 1;
    pickerBusy = false;
    picker = null;
    clearStatus();
    renderAll();
  }

  function clearLocationSelection() {
    locationTarget = null;
    nativeCandidate = null;
    nativeFallback = false;
    pickerSequence += 1;
    pickerBusy = false;
    picker = null;
  }

  function beginLocationChange() {
    openRelocation();
  }

  function selectLocationTarget(targetPath) {
    if (!locationChangeMode || locationBusy() || typeof targetPath !== "string" || !targetPath) return;
    locationTarget = targetPath;
    nativeCandidate = null;
    nativeFallback = false;
    pickerSequence += 1;
    pickerBusy = false;
    picker = null;
    clearStatus();
    renderSetup();
  }

  function cancelLocationSelection() {
    if (locationChangeBusy || locationPendingResult) return;
    nativeSequence += 1;
    nativeAbort?.abort();
    nativeAbort = null;
    nativeBusy = false;
    cancelRelocation();
  }

  async function showLocationCompleted(root, copiedFiles, confirmedAfterReconnect = false, confirmedStatusKey = null) {
    locationPendingResult = null;
    locationChangeBusy = false;
    clearLocationSelection();
    locationChangeMode = false;
    relocating = false;
    context.setup = { ...context.setup, state: "INITIALIZED", root, code: undefined };
    context.locationChange = { active: false };
    renderAll();
    const loaded = await loadLane(activeLane, { poll: true });
    if (confirmedAfterReconnect) {
      showStatus(confirmedStatusKey || (loaded ? "location.doneAfterReconnect" : "location.doneRefreshFailed"), { path: root }, loaded ? "success" : "warning");
    } else {
      showStatus(loaded ? "location.done" : "location.doneRefreshFailed", { path: root, n: copiedFiles }, loaded ? "success" : "warning");
    }
  }

  function renderMoveRelocation(gate) {
    const currentRoot = context?.setup?.root || "";
    const active = Boolean(locationChangeBusy || context?.locationChange?.active);
    gate.append(makeElement("h2", "", t("relocate.title")));
    if (active || locationPendingResult) {
      gate.append(makeElement("p", "location-current", t("location.current", { path: currentRoot })));
      gate.append(makeElement("p", "location-running", t(active ? "location.running" : "location.responseChecking", {
        path: currentRoot, current: currentRoot, target: locationPendingResult?.targetPath || "",
      })));
      return;
    }
    gate.append(makeElement("p", "", t("location.explain")));
    gate.append(makeElement("p", "setup-path", t("relocate.current", { path: currentRoot })));
    if (locationTarget) {
      gate.append(makeElement("p", "setup-path", t("location.target", { path: locationTarget })));
      gate.append(makeElement("p", "hint", t("location.retainedCopy")));
      const actions = makeElement("div", "setup-actions");
      const confirm = button(t("location.confirm"), "primary-button", confirmLocationChange);
      confirm.disabled = locationBusy();
      const cancel = button(t("location.cancel"), "text-button", cancelLocationSelection);
      cancel.disabled = locationChangeBusy || Boolean(locationPendingResult);
      actions.append(confirm, cancel);
      gate.append(actions);
    } else {
      if (nativeBusy) gate.append(makeElement("p", "hint", t("setup.nativeWaiting")));
      if (!nativeBusy && !picker) {
        const actions = makeElement("div", "setup-actions");
        actions.append(button(t("location.choose"), "primary-button", openPicker), button(t("location.cancel"), "text-button", cancelLocationSelection));
        gate.append(actions);
      }
      if (picker && (!context.nativeFolderPicker || nativeFallback)) renderPicker(gate);
    }
  }

  async function confirmLocationChange() {
    if (!locationChangeMode || !locationTarget || locationBusy() || context?.setup?.state !== "INITIALIZED") return;
    const expectedRoot = context.setup.root;
    const targetPath = locationTarget;
    locationChangeBusy = true;
    clearStatus();
    renderSetup();
    renderMain();
    try {
      const result = await api("/location/move", { method: "POST", body: { expectedRoot, targetPath } });
      if (result?.ok !== true || typeof result.root !== "string") throw new ApiError("INVALID_RESPONSE", { status: 200 }, result);
      await showLocationCompleted(result.root, result.copiedFiles);
    } catch (error) {
      const responseWasLost = !(error?.status > 0);
      const responseWasUncertain = responseWasLost || error?.code === "INVALID_RESPONSE";
      let latest = null;
      if (responseWasUncertain) {
        try { latest = await api("/context"); } catch { /* leave the binding outcome unresolved */ }
      }
      if (latest?.setup) context.setup = latest.setup;
      if (latest?.locationChange) context.locationChange = latest.locationChange;
      const currentRoot = latest?.setup?.root;
      const active = Boolean(latest?.locationChange?.active);
      if (responseWasUncertain && typeof currentRoot === "string" && currentRoot !== expectedRoot) {
        await showLocationCompleted(currentRoot, undefined, true, "location.reconciled");
      } else if (responseWasUncertain && active) {
        locationPendingResult = { expectedRoot, targetPath };
        locationChangeBusy = false;
        clearLocationSelection();
        showStatus("location.responsePending", { path: currentRoot || expectedRoot }, "warning");
        renderSetup();
        renderMain();
      } else if (responseWasUncertain) {
        locationPendingResult = { expectedRoot, targetPath };
        locationChangeBusy = false;
        clearLocationSelection();
        showStatus("location.responseUnconfirmed", { current: currentRoot || expectedRoot, target: targetPath }, "warning");
        renderSetup();
        renderMain();
      } else {
        locationPendingResult = null;
        locationChangeBusy = false;
        clearLocationSelection();
        showStatus(responseWasLost ? "location.responseUnconfirmed" : "location.failed", {
          current: currentRoot || expectedRoot, target: targetPath, error: locationErrorText(error),
          partial: error?.data?.partialPath ? t("location.partial", { path: error.data.partialPath }) : "",
        }, responseWasLost ? "warning" : "error");
        renderSetup();
        renderMain();
      }
    } finally {
      locationChangeBusy = false;
      renderSetup();
      renderMain();
    }
  }

  function renderRelocation(gate) {
    if (locationChangeMode) return renderMoveRelocation(gate);
    gate.append(
      makeElement("h2", "", t("relocate.title")),
      makeElement("p", "", t("relocate.explanation")),
      makeElement("p", "setup-path", t("relocate.current", { path: context?.setup?.root || "" })),
    );
    if (relocationNested) {
      gate.append(makeElement("p", "banner warning", t("relocate.nested", { path: relocationNested })));
      const nestedActions = makeElement("div", "setup-actions");
      nestedActions.append(
        button(t("relocate.useNested"), "primary-button", () => completeRelocation("custom", relocationNested)),
        button(t("relocate.useFolderAnyway"), "text-button", () => completeRelocation("custom", relocationAttempt, { acceptEmpty: true })),
        button(t("relocate.cancel"), "text-button", cancelRelocation),
      );
      gate.append(nestedActions);
      return;
    }
    const actions = makeElement("div", "setup-actions");
    const defaultButton = button(t("relocate.default", { path: defaultNotesPath() }), "primary-button", () => completeRelocation("default"));
    const other = button(t("relocate.chooseOther"), "text-button", openPicker);
    const cancel = button(t("relocate.cancel"), "text-button", cancelRelocation);
    defaultButton.disabled = relocationBusy || nativeBusy || pickerBusy;
    other.disabled = relocationBusy || nativeBusy || pickerBusy;
    cancel.disabled = relocationBusy;
    actions.append(defaultButton, other, cancel);
    gate.append(actions);
    if (nativeBusy) gate.append(makeElement("p", "hint", t("setup.nativeWaiting")));
    if (nativeCandidate) {
      gate.append(makeElement("p", "setup-path", t("setup.nativeCandidate", { path: nativeCandidate })));
      const confirm = button(t("setup.nativeConfirm"), "primary-button", () => completeRelocation("custom", nativeCandidate, { native: true }));
      confirm.disabled = nativeBusy || relocationBusy;
      gate.append(confirm);
      const cancelSelection = button(t("setup.nativeCancel"), "text-button", cancelRelocation);
      cancelSelection.disabled = relocationBusy;
      gate.append(cancelSelection);
    }
    if (picker && (!context.nativeFolderPicker || nativeFallback)) renderPicker(gate);
  }

  function renderSortButtons() {
    nodes["newest-button"].textContent = t("label.newest");
    nodes["oldest-button"].textContent = t("label.oldest");
    nodes["newest-button"].classList.toggle("selected", sortOrder === "newest");
    nodes["oldest-button"].classList.toggle("selected", sortOrder === "oldest");
  }

  function renderSetup() {
    const gate = nodes["setup-gate"];
    if (context?.nativeFolderPicker) {
      const key = JSON.stringify([context.projectPath,context.setup?.state,context.setup?.root,context.setup?.code,context.setup?.legacy,context.setup?.proposedPath,context.locationChange?.active,locale,namingNeeded,nativeCandidate,nativeBusy,nativeFallback,pickerBusy,picker?.path,picker?.parent,picker?.loading,picker?.drives,picker?.drivesError,(picker?.entries || []).map((entry) => entry.path),setupBusy,setupUncertain,setupContinuation,relocating,relocationBusy,relocationNested,relocationAttempt,locationChangeMode,locationTarget,locationChangeBusy,locationPendingResult?.targetPath]);
      if (key === nativeRenderKey) return;
      nativeRenderKey = key;
    }
    gate.replaceChildren();
    const uninitialized = context?.setup?.state === "UNINITIALIZED";
    const changing = relocating && context?.setup?.state === "INITIALIZED";
    gate.hidden = !uninitialized && !changing;
    if (changing) return renderRelocation(gate);
    if (!uninitialized) return;
    gate.append(makeElement("h2", "", t("setup.title")), makeElement("p", "", t("setup.firstUse")));
    if (context.setup.legacy) gate.append(makeElement("p", "setup-legacy", t("setup.legacy")));
    if (context.setup.proposedPath) gate.append(makeElement("p", "setup-path", t("setup.proposed", { path: context.setup.proposedPath })));

    const names = makeElement("div", "setup-names");
    names.append(makeElement("h3", "", t("setup.names")), makeElement("p", "setup-global", t("setup.namesGlobal")), makeElement("p", "hint", t("setup.nameHint")));
    for (const key of LANE_KEYS) {
      const row = makeElement("label", "setup-name-row");
      row.append(makeElement("span", "", laneFor(key).displayId || key));
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 200;
      input.value = setupLabels[key] || "";
      if (context.nativeFolderPicker) input.disabled = nativeBusy || setupBusy || setupUncertain;
      input.addEventListener("input", () => { setupLabels[key] = input.value; });
      row.append(input);
      names.append(row);
    }
    gate.append(names);

    const actions = makeElement("div", "setup-actions");
    const defaultButton = button(context.setup.legacy ? t("setup.adopt") : t("setup.default"), "primary-button", () => completeSetup(context.setup.legacy ? "adopt" : "default"));
    if (context.nativeFolderPicker) defaultButton.disabled = nativeBusy || setupBusy || setupUncertain;
    actions.append(defaultButton);
    if (!context.setup.legacy) {
      const other = button(context.nativeFolderPicker && nativeCandidate ? t("setup.nativeAgain") : t("setup.other"), "text-button", openPicker);
      if (context.nativeFolderPicker) other.disabled = nativeBusy || setupBusy || setupUncertain;
      actions.append(other);
    }
    gate.append(actions);
    if (context.nativeFolderPicker && !context.setup.legacy) {
      if (nativeBusy) gate.append(makeElement("p", "hint", t("setup.nativeWaiting")));
      if (nativeCandidate) {
        gate.append(makeElement("p", "setup-path", t("setup.nativeCandidate", { path: nativeCandidate })));
        const confirm = button(t("setup.nativeConfirm"), "primary-button", () => completeSetup("custom", nativeCandidate, { native: true }));
        confirm.disabled = nativeBusy || setupBusy || setupUncertain;
        gate.append(confirm);
      }
      if (nativeCandidate || nativeBusy) {
        const cancel = button(t("setup.nativeCancel"), "text-button", () => {
          nativeSequence += 1;
          nativeAbort?.abort();
          nativeAbort = null;
          nativeCandidate = null;
          nativeBusy = false;
          nativeFallback = false;
          pickerSequence += 1;
          pickerBusy = false;
          picker = null;
          showStatus("setup.nativeCancelled");
          renderSetup();
        });
        cancel.disabled = setupBusy || setupUncertain;
        gate.append(cancel);
      }
    }
    if (setupContinuation) gate.append(makeElement("p", "setup-continue", t("setup.continue")));
    if (picker && (!context.nativeFolderPicker || nativeFallback)) renderPicker(gate);
  }

  function renderPicker(gate) {
    const box = makeElement("div", "picker");
    if (nativeFallback) box.append(makeElement("p", "picker-warning", t(locationChangeMode ? "location.fallbackHint" : relocating ? "relocate.nativeFallbackHint" : "setup.nativeFallbackHint")));
    box.append(makeElement("div", "picker-path", t("setup.current", { path: picker.path || "" })));
    if (context?.nativeFolderPicker) {
      const drives = makeElement("div", "drive-list");
      for (const drive of picker.drives || []) {
        const item = button(drive, "drive-button", () => browseFolder(drive));
        item.disabled = nativeBusy || pickerBusy || setupBusy || setupUncertain || relocationBusy || locationBusy();
        drives.append(item);
      }
      if (picker.drivesError) drives.append(makeElement("p", "hint", t("setup.drivesUnavailable")));
      if ((picker.drives || []).length || picker.drivesError) box.append(drives);
    }
    const crumbs = makeElement("div", "breadcrumbs");
    for (const crumb of picker.breadcrumbs || [])
      crumbs.append(button(crumb.name || t("setup.root"), "breadcrumb-button", () => browseFolder(crumb.path)));
    box.append(crumbs);
    const parent = typeof picker.parent === "string" ? picker.parent : "";
    const currentPath = String(picker.path || "");
    const samePath = context?.nativeFolderPicker
      ? parent.toLowerCase() === currentPath.toLowerCase()
      : parent === currentPath;
    if (parent && !samePath) {
      const up = button("↑ " + t("setup.parent"), "breadcrumb-button", () => browseFolder(parent));
      up.disabled = nativeBusy || pickerBusy || setupBusy || setupUncertain || relocationBusy || locationBusy();
      box.append(up);
    }
    const entries = makeElement("div", "folder-list");
    if (picker.loading) entries.append(makeElement("div", "hint", t("setup.folderLoading")));
    else {
      for (const entry of picker.entries || []) {
        const item = button("📁 " + entry.name, "folder-button", () => browseFolder(entry.path));
        item.disabled = nativeBusy || pickerBusy || setupBusy || setupUncertain || relocationBusy || locationBusy();
        entries.append(item);
      }
      if ((picker.entries || []).length === 0) entries.append(makeElement("div", "hint", t("label.noSubfolders")));
    }
    box.append(entries);
    const actions = makeElement("div", "setup-actions");
    const choose = button(locationChangeMode ? t("location.selectTarget") : t("setup.choose"), "primary-button", () => locationChangeMode ? selectLocationTarget(picker.path) : relocating ? completeRelocation("custom", picker.path) : completeSetup("custom", picker.path));
    choose.disabled = nativeBusy || pickerBusy || setupBusy || setupUncertain || relocationBusy || locationBusy() || !picker.path;
    const newFolder = button(t("setup.newFolder"), "text-button", createPickerFolder);
    newFolder.disabled = nativeBusy || pickerBusy || setupBusy || setupUncertain || relocationBusy || locationBusy() || !picker.path;
    const cancel = button(locationChangeMode ? t("location.cancel") : t("setup.cancelPicker"), "text-button", () => {
      if (locationChangeMode) return cancelLocationSelection();
      pickerSequence += 1;
      pickerBusy = false;
      picker = null;
      nativeFallback = false;
      clearStatus();
      renderSetup();
    });
    cancel.disabled = setupBusy || setupUncertain || relocationBusy || locationChangeBusy || Boolean(locationPendingResult);
    actions.append(choose, newFolder, cancel);
    box.append(actions);
    gate.append(box);
  }
  function renderMain() {
    nodes["notes-main"].hidden = !context || Boolean(sourceView) || relocating;
    if (!context) return;
    renderLaneTabs();
    renderSearch();
    renderComposer();
    renderSortButtons();
    renderNotes();
    renderFooter();
    renderSelectionTray();
  }

  function renderAll() {
    renderHeader();
    renderHooks();
    renderBranches();
    renderCarry();
    renderHelp();
    renderSetup();
    renderMain();
    renderMirror();
    renderSourceView();
    renderStatus();
    renderConflict();
    renderConfirm();
    renderSelectionTray();
  }

  function normalizeConfig(value) {
    const safe = value && typeof value === "object" ? value : {};
    const overrides = safe.laneOverrides && typeof safe.laneOverrides === "object" ? safe.laneOverrides : {};
    return { displayOrder: Array.isArray(safe.displayOrder) ? safe.displayOrder : [], laneOverrides: overrides };
  }

  function initializeSetupLabels() {
    const overrides = laneConfig.laneOverrides || {};
    setupLabels = Object.fromEntries(LANE_KEYS.map((key) => [key, overrides[key]?.label || laneFor(key).descriptive || ""]));
    namingNeeded = !LANE_KEYS.every((key) => typeof overrides[key]?.label === "string" && overrides[key].label.trim());
  }

  async function loadContext({ skipLane = false } = {}) {
    try {
      const [nextContext, config] = await Promise.all([
        api("/context"),
        globalApi("/api/lane-config").catch(() => ({ displayOrder: [], laneOverrides: {} })),
      ]);
      context = nextContext;
      locale = nextContext.locale === "zh" ? "zh" : "en";
      lanes = Array.isArray(nextContext.lanes) ? nextContext.lanes : [];
      laneConfig = normalizeConfig(config);
      if (!lanes.length) lanes = LANE_KEYS.map((key, index) => ({ key, displayId: `L${index + 1}`, label: key, descriptive: key }));
      if (!lanes.some((lane) => lane.key === activeLane)) activeLane = lanes[0].key;
      if (!lanes.some((lane) => lane.key === composerLane)) composerLane = activeLane;
      initializeSetupLabels();
      prefs = await api("/prefs").catch(() => ({ pins: {} }));
      selection = await api("/selection").catch(() => ({ targets: [], generation: 0, lastBinding: null }));
      startSelectionPolling();
      renderAll();
      if (!skipLane && context.setup?.state === "INITIALIZED") await loadLane(activeLane);
    } catch (error) {
      context = null;
      nodes["thread-title"].textContent = t("label.threadUnavailable");
      nodes["notes-main"].hidden = true;
      nodes["setup-gate"].hidden = true;
      showStatus("status.loadFailed", { error: errorText(error) }, "error");
    }
  }

  async function loadLane(key, { poll = false, preserveConflict = false } = {}) {
    if (context?.setup?.state !== "INITIALIZED") return;
    const sequence = ++loadSequence;
    try {
      const result = await api(`/lanes/${encodeURIComponent(key)}`);
      if (sequence !== loadSequence) return;
      const old = laneData.get(key);
      // An unchanged lane must not rebuild the list: that would drop the
      // editor's focus and any in-progress IME composition.
      if (poll && old && old.version === result.version) {
        if (status?.key === "status.loadFailed") clearStatus();
        return result;
      }
      if (poll && old && old.version !== result.version && hasDraft()) {
        conflict = { laneKey: key, latest: result, poll: true, operation: null };
        renderConflict();
        return;
      }
      laneData.set(key, result);
      // The service is reachable again: drop a stale load-failure banner.
      if (status?.key === "status.loadFailed") clearStatus();
      if (!preserveConflict && conflict?.laneKey === key) conflict = null;
      if (key === activeLane) {
        if (searchQuery.trim()) void performSearch(searchQuery);
        else renderMain();
      } else if (searchQuery.trim()) {
        void performSearch(searchQuery);
      }
      return result;
    } catch (error) {
      if (error.status === 409 && context?.setup?.state !== "INITIALIZED") return;
      if (!poll) showStatus("status.loadFailed", { error: errorText(error) }, "error");
      return null;
    }
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => loadLane(activeLane, { poll: true }), 3000);
    // The host names a new thread only after its first turn; refresh the header title.
    if (!titleTimer) titleTimer = setInterval(refreshTitle, 15000);
  }

  async function selectLane(key) {
    if (key === activeLane) return;
    const apply = async () => {
      if (editor?.touched) editor = null;
      searchQuery = "";
      searchResults = null;
      activeLane = key;
      // The composer lane follows the viewed tab; the draft and quote are kept.
      composerLane = key;
      conflict = null;
      clearStatus();
      renderAll();
      await loadLane(key);
    };
    if (editor?.touched) {
      requestConfirm(t("status.unsavedSwitch"), apply);
      return;
    }
    await apply();
  }

  async function beginEdit(laneKey, note) {
    const apply = async () => {
      composerDraft = "";
      composerTouched = false;
      quoted = null;
      activeLane = laneKey;
      composerLane = laneKey;
      await loadLane(laneKey);
      const fresh = laneData.get(laneKey);
      const freshNote = fresh?.notes?.find((entry) => entry.addressable && entry.itemKey === note.itemKey);
      if (!freshNote) {
        editor = null;
        showStatus("error.ITEM_UNRESOLVED", undefined, "error");
        renderMain();
        return;
      }
      editor = { laneKey, itemKey: freshNote.itemKey, content: freshNote.authored || "", original: freshNote.authored || "", version: fresh.version || note.laneVersion || "0", sourced: freshNote.kind === "source-aware", touched: false };
      clearStatus();
      renderMain();
      const area = nodes["notes-list"].querySelector(".edit-area");
      if (area) {
        area.focus();
        area.setSelectionRange(area.value.length, area.value.length);
      }
    };
    if (hasDraft() && !(editor?.itemKey === note.itemKey && editor?.laneKey === laneKey)) {
      requestConfirm(t("status.unsavedSwitch"), apply);
      return false;
    }
    await apply();
  }

  async function saveComposer({ overwrite = false } = {}) {
    if (locationBusy()) { showStatus("location.running", { path: context?.setup?.root || "" }, "warning"); return false; }
    if (context?.setup?.state !== "INITIALIZED") {
      setupContinuation = true;
      showStatus("setup.continue", undefined, "warning");
      renderSetup();
      return false;
    }
    const content = composerDraft;
    if (!quoted && !content.trim()) {
      showStatus("status.emptyBody", undefined, "error");
      return;
    }
    try {
      showStatus("status.saving");
      const result = quoted
        ? await api(`/lanes/${encodeURIComponent(composerLane)}/sourced-notes`, {
          method: "POST", body: { snapshot: quoted.snapshot, source: quoted.source, comment: content },
        })
        : await api(`/lanes/${encodeURIComponent(composerLane)}/notes`, { method: "POST", body: { content, ...(overwrite ? { overwrite: true } : {}) } });
      composerDraft = "";
      composerTouched = false;
      quoted = null;
      showStatus("status.savedNote", undefined, "success");
      await loadLane(composerLane);
      return true;
    } catch (error) {
      clearStatus();
      if (error.code === "NOTES_SOURCE_UNVERIFIED") {
        showStatus("error.NOTES_SOURCE_UNVERIFIED", undefined, "error");
      } else if (error.status === 409 && !isLocationError(error)) {
        conflict = { laneKey: activeLane, latest: null, poll: false, operation: () => saveComposer({ overwrite: true }) };
        renderConflict();
      } else showStatus("status.saveFailed", { error: errorText(error) }, "error");
      return false;
    }
  }

  async function saveEdit({ overwrite = false } = {}) {
    if (!editor) return false;
    if (locationBusy()) { showStatus("location.running", { path: context?.setup?.root || "" }, "warning"); return false; }
    // A pending conflict must be resolved first (Load latest / Overwrite / Cancel).
    if (conflict) { renderConflict(); return false; }
    if (!editor.sourced && !editor.content.trim()) {
      showStatus("status.emptyBody", undefined, "error");
      return false;
    }
    const current = { ...editor };
    try {
      showStatus("status.saving");
      await api(`/lanes/${encodeURIComponent(current.laneKey)}/notes/${encodeURIComponent(current.itemKey)}`, {
        method: "PUT", body: { content: current.content, expectedVersion: current.version, ...(overwrite ? { overwrite: true } : {}) },
      });
      editor = null;
      showStatus("status.savedEdit", undefined, "success");
      await loadLane(current.laneKey);
      return true;
    } catch (error) {
      if (error.status === 409 && !isLocationError(error)) {
        clearStatus();
        conflict = { laneKey: current.laneKey, latest: null, poll: false, operation: () => saveEdit({ overwrite: true }) };
        renderConflict();
      } else showStatus("status.saveFailed", { error: errorText(error) }, "error");
      return false;
    }
  }

  async function deleteNote(laneKey, itemKey) {
    if (locationBusy()) { showStatus("location.running", { path: context?.setup?.root || "" }, "warning"); return; }
    if (!laneData.has(laneKey)) await loadLane(laneKey);
    const version = laneData.get(laneKey)?.version;
    try {
      showStatus("status.saving");
      await api(`/lanes/${encodeURIComponent(laneKey)}/notes/${encodeURIComponent(itemKey)}?v=${encodeURIComponent(version || "0")}`, { method: "DELETE" });
      deleteConfirm = null;
      showStatus("status.deleted", undefined, "success");
      await loadLane(laneKey);
    } catch (error) {
      if (error.status === 409 && !isLocationError(error)) {
        conflict = { laneKey, latest: null, poll: false, operation: () => deleteNote(laneKey, itemKey) };
        renderConflict();
      } else showStatus("status.saveFailed", { error: errorText(error) }, "error");
    }
  }

  let titleTimer = null;
  async function refreshTitle() {
    try {
      const latest = await api("/context");
      if (latest?.serviceVersion) {
        if (!pageServiceVersion) pageServiceVersion = latest.serviceVersion;
        else if (latest.serviceVersion !== pageServiceVersion) {
          // The service was upgraded under this open page; load the new panel.
          if (!hasDraft()) { global.location.reload(); return; }
          showStatus("status.panelUpdated", undefined, "warning");
        }
      }
      if (latest?.title && context && latest.title !== context.title) {
        context.title = latest.title;
        nodes["thread-title"].textContent = latest.title;
      }
      if (context && latest?.setup && context.nativeFolderPicker) {
        const previousRoot = context.setup?.root;
        const wasLocationActive = Boolean(context.locationChange?.active);
        const isLocationActive = Boolean(latest.locationChange?.active);
        const nextRoot = latest.setup.root;
        context.setup = latest.setup;
        context.locationChange = latest.locationChange || { active: false };
        const rootChanged = typeof previousRoot === "string" && typeof nextRoot === "string" && previousRoot !== nextRoot;
        if (locationPendingResult && !isLocationActive) {
          const pending = locationPendingResult;
          locationPendingResult = null;
          if (typeof nextRoot === "string" && nextRoot !== pending.expectedRoot) await showLocationCompleted(nextRoot, undefined, true, "location.reconciled");
          else showStatus("location.responseUnconfirmed", { current: nextRoot || pending.expectedRoot, target: pending.targetPath }, "warning");
        } else if (wasLocationActive && !isLocationActive && status?.key === "location.running") {
          clearStatus();
        }
        if (rootChanged) {
          if (locationChangeMode && !locationChangeBusy) {
            clearLocationSelection();
            showStatus("location.changedElsewhere", { current: nextRoot || t("setup.unknownRoot") }, "warning");
          }
          renderSetup();
          await loadLane(activeLane, { poll: true });
          renderMain();
        } else if (wasLocationActive !== isLocationActive) {
          renderSetup();
          renderMain();
        }
      }
      if (context && Object.prototype.hasOwnProperty.call(latest || {}, "carry")) {
        // Another Notes page may have decided this branch's carry: drop a
        // stale question and show the result.
        const wasPending = ["unresolved", "partial"].includes(context.carry?.status);
        context.carry = latest.carry;
        if (latest?.forkedFrom !== undefined) context.forkedFrom = latest.forkedFrom;
        if (wasPending && latest.carry?.status === "decided") {
          carryConflict = null;
          renderCarry();
          await loadLane(activeLane);
          showStatus("status.carryDecidedElsewhere", undefined, "success");
        }
      }
      if (context && Array.isArray(latest?.recentForks)) context.recentForks = latest.recentForks;
      renderBranches();
      renderHeader();
    } catch { /* keep the current header */ }
  }

  async function togglePin(laneKey, itemKey) {
    const next = { pins: {} };
    for (const key of LANE_KEYS) next.pins[key] = { ...(prefs.pins?.[key] || {}) };
    if (next.pins[laneKey][itemKey]) delete next.pins[laneKey][itemKey];
    else next.pins[laneKey][itemKey] = true;
    try {
      const nowPinned = Boolean(next.pins[laneKey][itemKey]);
      prefs = await api("/prefs", { method: "PUT", body: next });
      renderMain();
      showStatus(nowPinned ? "status.pinned" : "status.unpinned", undefined, "success");
    } catch (error) {
      showStatus("status.saveFailed", { error: errorText(error) }, "error");
    }
  }

  async function resolveConflict(action) {
    if (!conflict) return;
    const pending = conflict;
    if (action === "cancel") {
      conflict = null;
      clearStatus();
      renderAll();
      return;
    }
    try {
      const latest = pending.latest || await api(`/lanes/${encodeURIComponent(pending.laneKey)}`);
      laneData.set(pending.laneKey, latest);
      if (action === "load") {
        clearDrafts();
        conflict = null;
        showStatus("status.loadedLatest", undefined, "success");
        renderAll();
        return;
      }
      if (editor && editor.laneKey === pending.laneKey) editor.version = latest.version;
      conflict = null;
      renderAll();
      const overwritten = pending.operation
        ? await pending.operation()
        : editor?.laneKey === pending.laneKey
          ? await saveEdit({ overwrite: true })
          : composerTouched || quoted
            ? await saveComposer({ overwrite: true })
            : false;
      if (overwritten) showStatus("status.overwritten", undefined, "success");
    } catch (error) {
      showStatus("status.loadFailed", { error: errorText(error) }, "error");
      renderConflict();
    }
  }

  async function performSearch(query) {
    const value = query.trim();
    searchQuery = value;
    if (!value) {
      searchResults = null;
      renderNotes();
      return;
    }
    const sequence = ++searchSequence;
    showStatus("status.searching");
    try {
      const results = await Promise.all(LANE_KEYS.map(async (key) => {
        const data = await api(`/lanes/${encodeURIComponent(key)}`);
        const needle = value.toLocaleLowerCase();
        const notes = (data.notes || []).filter((note) => [note.authored, note.text, note.sourceSnapshot]
          .filter((part) => typeof part === "string")
          .some((part) => part.toLocaleLowerCase().includes(needle)));
        return { key, label: laneLabel(key), notes: notes.map((note) => ({ ...note, laneVersion: data.version })) };
      }));
      if (sequence !== searchSequence) return;
      searchResults = { groups: results, total: results.reduce((sum, group) => sum + group.notes.length, 0) };
      clearStatus();
      renderNotes();
    } catch (error) {
      if (sequence !== searchSequence) return;
      showStatus("status.loadFailed", { error: errorText(error) }, "error");
    }
  }

  async function openNativePicker() {
    const canPick = context?.setup?.state === "UNINITIALIZED" || relocating;
    if (nativeBusy || setupBusy || setupUncertain || !canPick || !context?.nativeFolderPicker || locationBusy()) return;
    const sequence = ++nativeSequence;
    const abort = new AbortController();nativeAbort = abort;nativeBusy = true;clearStatus();renderSetup();
    try {
      const result = await api("/fs/native-picker", { method: "POST", body: {
        title: t(relocating ? "relocate.nativeTitle" : "setup.nativeTitle"),
        initialPath: locationChangeMode ? context.setup?.root : (nativeCandidate || picker?.path || (relocating ? context.setup?.root : null) || context.projectPath)
      }, signal: abort.signal });
      if (sequence !== nativeSequence || abort.signal.aborted) return;
      if (result.status === "selected") {
        if (locationChangeMode) {
          locationTarget = result.path;
          nativeCandidate = null;
          showStatus("location.selected", undefined, "success");
        } else {
          nativeCandidate = result.path;
          showStatus("setup.nativeSelected", undefined, "success");
        }
        nativeFallback = false;
        pickerSequence += 1;
        pickerBusy = false;
        picker = null;
      } else if (result.status === "cancelled") showStatus(locationChangeMode ? "location.cancelled" : "setup.nativeCancelled");
    } catch (error) {
      if (sequence !== nativeSequence || abort.signal.aborted) return;
      if (["PICKER_BUSY", "PICKER_UNAVAILABLE", "PICKER_TIMEOUT", "PICKER_FAILED", "LOCATION_INVALID"].includes(error?.code)) {
        nativeFallback = true;
        const start = locationChangeMode ? context?.setup?.root : (nativeCandidate || picker?.path || context?.projectPath || context?.setup?.proposedPath);
        const opened = start ? await browseFolder(start) : false;
        if (sequence !== nativeSequence || abort.signal.aborted) return;
        if (opened) showStatus(locationChangeMode ? "location.fallbackHint" : relocating ? "relocate.nativeFallback" : "setup.nativeFallback", { error: errorText(error) }, "warning");
      } else showStatus("status.folderFailed", { error: errorText(error) }, "error");
    } finally {
      if (sequence === nativeSequence) { nativeBusy = false;nativeAbort = null;renderSetup(); }
    }
  }
  function closePanelInstance(id) {
    const body = JSON.stringify({ panelId: id });
    if (!global.navigator?.sendBeacon?.(apiPath("/panel/closed"), body))
      fetch(apiPath("/panel/closed"), { method: "POST", body, keepalive: true }).catch(() => {});
  }
  function renewPanelInstance() {
    const generation = panelActivation, previousId = panelInstance;
    if (panelRenewal?.generation === generation) return panelRenewal.task;
    const job = { generation, id: global.crypto.randomUUID().replace(/-/g, "") };
    job.task = (async () => {
      const value = await parseResponse(await fetch(apiPath("/panel/present"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ previousId, panelId: job.id }) }));
      if (value.panelId !== job.id || value.closed === true) { closePanelInstance(job.id);return; }
      if (!panelActive || panelActivation !== generation || panelInstance !== previousId) { closePanelInstance(value.panelId);return; }
      panelInstance = value.panelId;
    })().catch((error) => { closePanelInstance(job.id);throw error; }).finally(() => { if (panelRenewal === job) panelRenewal = null; });
    panelRenewal = job;return job.task;
  }
  window.addEventListener("pagehide", () => {
    nativeSequence += 1;nativeAbort?.abort();nativeAbort = null;
    panelActive = false;panelActivation += 1;
    if (panelInstance) closePanelInstance(panelInstance);
    if (panelRenewal) closePanelInstance(panelRenewal.id);
  });

  window.addEventListener("pageshow", (event) => {
    panelActive = true;panelActivation += 1;
    if (!panelInstance) return;
    if (event?.persisted) return renewPanelInstance().catch(() => {});
    return api("/context").catch(() => {});
  });

  async function openPicker() {
    if (context?.nativeFolderPicker) return openNativePicker();
    if (setupBusy || locationBusy()) return;
    const start = (relocating ? context?.setup?.root : null) || context?.projectPath || context?.setup?.proposedPath;
    return start ? browseFolder(start) : undefined;
  }

  function makeBreadcrumbs(folderPath) {
    const parts = String(folderPath || "").split("/").filter(Boolean);
    const crumbs = [{ name: t("setup.root"), path: "/" }];
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      crumbs.push({ name: part, path: current });
    }
    return crumbs;
  }

  async function browseFolder(folderPath) {
    if (typeof folderPath !== "string" || !folderPath || setupBusy || setupUncertain || locationBusy()) return false;
    const sequence = ++pickerSequence;
    pickerBusy = true;
    picker = { ...(picker || {}), path: folderPath, loading: true };
    clearStatus();
    renderSetup();
    try {
      const result = await api("/fs?path=" + encodeURIComponent(folderPath));
      if (sequence !== pickerSequence) return false;
      picker = {
        ...result,
        breadcrumbs: Array.isArray(result.breadcrumbs) && result.breadcrumbs.length
          ? result.breadcrumbs : makeBreadcrumbs(result.path),
        loading: false,
      };
      return true;
    } catch (error) {
      if (sequence !== pickerSequence) return false;
      picker = {
        ...(picker || {}), path: folderPath, parent: picker?.parent || "",
        entries: [], breadcrumbs: picker?.breadcrumbs || [],
        ...(Array.isArray(error?.data?.drives) ? { drives: error.data.drives } : {}),
        ...(error?.data?.drivesError ? { drivesError: error.data.drivesError } : {}),
        loading: false,
      };
      showStatus("status.folderFailed", { error: errorText(error) }, "error");
      return false;
    } finally {
      if (sequence === pickerSequence) {
        pickerBusy = false;
        renderSetup();
      }
    }
  }
  async function createPickerFolder() {
    if (!picker || locationBusy()) return;
    requestConfirm(t("setup.newFolderPrompt"), async (name) => {
      if (!name) return;
      try {
        const result = await api("/fs/mkdir", { method: "POST", body: { parent: picker.path, name } });
        showStatus("status.folderCreated", { name }, "success");
        await browseFolder(result.path);
      } catch (error) {
        showStatus("status.folderFailed", { error: errorText(error) }, "error");
      }
    }, { input: true });
  }

  // Windows needs truthful outcomes across the original naming/binding/save steps.
  // A lost setup response is never permission to retry or save into a recovered root.
  async function completeWindowsSetup(action, customPath, { native = false } = {}) {
    if (setupBusy || nativeBusy || setupUncertain || context?.setup?.state !== "UNINITIALIZED") return;
    const labels = Object.fromEntries(LANE_KEYS.map((key) => [key, String(setupLabels[key] || "").trim()]));
    if (namingNeeded && Object.values(labels).some((value) => !value)) {
      showStatus("setup.failed", { error: t("setup.names") }, "error");
      return;
    }
    let phase = "names";
    let namesSaved = false;
    let boundRoot = null;
    pickerSequence += 1;
    pickerBusy = false;
    setupBusy = true;
    renderSetup();
    try {
      if (namingNeeded) {
        const overrides = { ...(laneConfig.laneOverrides || {}) };
        for (const key of LANE_KEYS) overrides[key] = { ...(overrides[key] || {}), label: labels[key] };
        laneConfig = await globalApi("/api/lane-config", {
          method: "PUT", body: { displayOrder: LANE_KEYS, laneOverrides: overrides },
        });
        namesSaved = true;
      }
      phase = "binding";
      const result = await api(native ? "/setup/native" : "/setup", {
        method: "POST", body: { action, ...(customPath ? { customPath } : {}) },
      });
      if (result.ok !== true || typeof result.root !== "string") throw new ApiError("INVALID_RESPONSE");
      boundRoot = result.root;
      context.setup = { ...context.setup, ...result, state: "INITIALIZED", root: boundRoot };
      nativeCandidate = null;
      nativeRenderKey = null;
      picker = null;
      setupContinuation = false;
      phase = "save";
      await loadContext({ skipLane: true });
      if (context?.setup?.state !== "INITIALIZED" || context.setup.root !== boundRoot) {
        showStatus("setup.boundRefreshFailed", { path: boundRoot }, "warning");
        return;
      }
      if (composerDraft.trim() || quoted) {
        const saved = await saveComposer();
        if (!saved) showStatus("setup.draftPending", { path: boundRoot }, "warning");
      } else showStatus("setup.done", undefined, "success");
      await loadLane(activeLane);
    } catch (error) {
      if (phase === "names") {
        showStatus("setup.namesFailed", { error: errorText(error) }, "error");
      } else if (phase === "save") {
        showStatus("setup.draftPending", { path: boundRoot }, "warning");
      } else {
        const elsewhere = error.code === "ALREADY_INITIALIZED";
        const knownRefusal = error.status >= 400 && error.status < 500 && !elsewhere
          || /^PICKER_/.test(error.code || "") || error.code === "SERVICE_CLOSING";
        if (elsewhere || !knownRefusal) {
          setupUncertain = true;
          // This query displays the actual binding only; it cannot prove the
          // naming/binding/save sequence succeeded and cannot trigger continuation.
          let latest;
          try { latest = await api("/context"); } catch { /* leave the draft and outcome unresolved */ }
          if (latest?.setup) context = latest;
          showStatus(elsewhere ? "setup.configuredElsewhere" : "setup.resultUnknown", {
            path: latest?.setup?.root || t("setup.unknownRoot"),
          }, "warning");
        } else {
          showStatus(namesSaved ? "setup.namesOnly" : "setup.failed", { error: errorText(error) }, "error");
        }
      }
    } finally {
      setupBusy = false;
      renderSetup();
      renderComposer();
    }
  }

  async function completeRelocation(action, customPath, { acceptEmpty = false } = {}) {
    if (relocationBusy || !relocating || context?.setup?.state !== "INITIALIZED") return;
    if (action === "custom") relocationAttempt = customPath;
    relocationNested = null;
    relocationBusy = true;
    clearStatus();
    renderSetup();
    try {
      const result = await api("/location", {
        method: "POST",
        body: {
          action,
          ...(customPath ? { customPath } : {}),
          ...(acceptEmpty ? { acceptEmpty: true } : {}),
          ...(context?.nativeFolderPicker ? { expectedRoot: context.setup.root } : {}),
        },
      });
      if (result.ok !== true || typeof result.root !== "string") throw new ApiError("INVALID_RESPONSE");
      relocating = false;
      relocationBusy = false;
      relocationNested = null;
      relocationAttempt = null;
      nativeCandidate = null;
      nativeFallback = false;
      picker = null;
      await loadContext({ skipLane: true });
      await loadLane(activeLane);
      showStatus("status.locationChanged", undefined, "success");
    } catch (error) {
      relocationBusy = false;
      if (error.code === "NOTES_ONE_LEVEL_DOWN" && typeof error.data?.nested === "string") {
        relocationNested = error.data.nested;
        nativeCandidate = null;
        nativeFallback = false;
        picker = null;
        renderSetup();
      } else {
        showStatus("status.locationFailed", { error: errorText(error) }, "error");
        renderSetup();
      }
    }
  }

  async function completeSetup(action, customPath, options = {}) {
    if (context?.nativeFolderPicker) return completeWindowsSetup(action, customPath, options);
    if (setupBusy) return;
    const labels = Object.fromEntries(LANE_KEYS.map((key) => [key, String(setupLabels[key] || "").trim()]));
    if (namingNeeded && Object.values(labels).some((value) => !value)) {
      showStatus("setup.failed", { error: t("setup.names") }, "error");
      return;
    }
    setupBusy = true;
    try {
      if (namingNeeded) {
        const overrides = { ...(laneConfig.laneOverrides || {}) };
        for (const key of LANE_KEYS) overrides[key] = { ...(overrides[key] || {}), label: labels[key] };
        laneConfig = await globalApi("/api/lane-config", {
          method: "PUT", body: { displayOrder: LANE_KEYS, laneOverrides: overrides },
        });
      }
      const result = await api("/setup", { method: "POST", body: { action, ...(customPath ? { customPath } : {}) } });
      context.setup = { ...context.setup, ...result, state: "INITIALIZED", root: result.root };
      picker = null;
      setupContinuation = false;
      setupBusy = false;
      showStatus("setup.done", undefined, "success");
      await loadContext({ skipLane: true });
      if (setupContinuation || composerDraft.trim() || quoted) await saveComposer();
      await loadLane(activeLane);
    } catch (error) {
      setupBusy = false;
      showStatus("setup.failed", { error: errorText(error) }, "error");
      renderSetup();
    }
  }

  nodes["help-button"].addEventListener("click", () => { helpOpen = !helpOpen; renderHelp(); });
  nodes["search-button"].addEventListener("click", () => {
    searchOpen = !searchOpen;
    if (!searchOpen) { searchQuery = ""; searchResults = null; }
    renderSearch();
    if (searchOpen) nodes["search-input"].focus();
    renderNotes();
  });
  nodes["search-close"].addEventListener("click", () => {
    searchOpen = false;
    searchQuery = "";
    searchResults = null;
    renderSearch();
    renderNotes();
  });
  nodes["search-input"].addEventListener("input", () => {
    searchQuery = nodes["search-input"].value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => performSearch(searchQuery), 180);
  });
  nodes["refresh-button"].addEventListener("click", async () => {
    const apply = async () => {
      clearDrafts();
      conflict = null;
      clearStatus();
      // A full reload also picks up a newer panel after a service upgrade.
      global.location.reload();
    };
    if (hasDraft()) { requestConfirm(t("status.unsavedRefresh"), apply); return; }
    await apply();
  });
  nodes["composer-lane"].addEventListener("change", () => { composerLane = nodes["composer-lane"].value; });
  nodes["composer"].addEventListener("input", () => {
    composerDraft = nodes["composer"].value;
    composerTouched = true;
  });
  nodes["quote-button"].addEventListener("click", openMirror);
  nodes["mirror-close"].addEventListener("click", closeMirror);
  nodes["mirror-filter"].addEventListener("input", () => {
    mirrorFilter = nodes["mirror-filter"].value;
    mirrorSearchResults = null;
    mirrorSearchSequence += 1;
    clearTimeout(searchTimer);
    if (!mirrorFilter) {
      mirrorSearching = false;
      renderMirror();
      return;
    }
    renderMirror();
    searchTimer = setTimeout(() => searchMirror(), 300);
  });
  nodes["mirror-quote-selection"].addEventListener("click", quoteSelection);
  nodes["save-note-button"].addEventListener("click", saveComposer);
  nodes["new-note-button"].addEventListener("click", () => {
    const apply = () => { clearDrafts(); clearStatus(); renderMain(); nodes["composer"].focus(); };
    if (hasDraft()) { requestConfirm(t("status.unsavedSwitch"), apply); return; }
    apply();
  });
  nodes["newest-button"].addEventListener("click", () => { sortOrder = "newest"; renderNotes(); renderSortButtons(); });
  nodes["oldest-button"].addEventListener("click", () => { sortOrder = "oldest"; renderNotes(); renderSortButtons(); });
  window.addEventListener("focus", refreshTitle);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refreshTitle(); });

  renderHeader();
  nodes["thread-title"].textContent = t("label.loading");
  loadContext().then(startPolling);
})(globalThis);
