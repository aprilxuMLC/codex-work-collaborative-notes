# DSH v0.1.1 → Codex feature parity

> **Status:** IMPLEMENTATION CHECK 0.5 · 2026-10-02 (plugin 0.7.0; also validated in local Work conversations; user desktop tests passed in English and Chinese, fresh-Mac install and update verified).
> Codex column now records the realized status: ✅ desktop = verified on the desktop app by the probe executor (S1–S3b); ✅ tests/browser = unit/service tests or built-in-browser check, desktop pending; ✅ adapted = realized via a Codex-specific design; ◐ partial; — n/a; ✗ not done; ⏳ = in the running S4 check.
>
> **Baseline:** `aprilxuMLC/dsh-collaborative-notes@v0.1.1`. The item list
> comes from a code inventory of `src/`, `lib/`, `skill/` and `test/`.
>
> **Purpose:** keep an item-by-item record of how each DSH user-visible
> feature is realized on Codex. It is updated during implementation and
> checked before acceptance.
>
> **Codex column:**
> - **PLAN** — planned equivalent.
> - **ADAPT** — realized differently because of a host difference; the note
>   says how.
> - **N/A** — DSH-internal mechanics with no Codex counterpart needed.
> - **TBD** — needs evidence or a decision.
> - **GAP** — cannot be realized on current Codex.
>
> Product semantics come from Concept / Core / Agent Guide, not from this
> table.

## Codex surface decisions this table relies on

- **Notes panel.** A plugin-served localhost page, shown in the side-panel
  browser tab. Tabs are thread-owned, and state survives thread switches
  (P11). The panel is opened by the hooks (startup/resume, and the next
  message after it was closed), by the fork watch, or on request through
  the `notes-open-panel` tool.
- **Capture is silent.** Quoting happens *inside the panel*, from a mirror of
  the current thread rendered from the host store by exact item id
  ("route B"). The native "Add to chat" annotation route is not the primary
  path, because it creates a chat turn.
- **Agent binding.** Agent tools bind mechanically to the current thread.
  Selected-note references are injected by the `UserPromptSubmit` hook.

## Parity table

| # | DSH feature | Codex | Note |
|---|---|---|---|
| 1 | Install/update/remove; data kept on uninstall | ✅ tests/browser | Codex plugin + marketplace; one hook-trust step (Settings → Hooks) |
| 2 | UI language follows host locale | ✅ desktop | Signals: `~/.codex/config.toml` `localeOverride`, in-app browser `Accept-Language`. Chinese UI checked in the browser (no untranslated UI strings); desktop check with ChatGPT set to 简体中文 pending |
| 3 | zh/en string parity | ✅ tests/browser | Dictionary ported with a parity test; README has an English and a Chinese version |
| 4 | Non-localized leftovers | ◐ partial | Fix: localize default labels and merge headings; map host error codes to localized text — **now:** merge-wrapper headings for legacy/opaque lanes are English-only; host error reasons mostly mapped |
| 5 | Lane names frozen at setup | ✅ tests/browser | |
| 6 | Setup gate + proposed `<ws>/notes` | ✅ desktop | Workspace = Codex project (thread `cwd`); Decision 64 |
| 7 | Use default location | ✅ desktop | |
| 8 | Choose another location (in-panel browser, new subfolder) | ✅ tests/browser | Implement in panel over the plugin server's fs listing. A location outside the project is still readable by the panel (it is our server) |
| 9 | Legacy adoption prompt | ✅ desktop | Applies if a `notes/` tree already exists |
| 10 | Lane naming step (L1–L4, locale suggestions) | ✅ desktop | Stored in plugin config/data, not host profile settings |
| 11 | Save waits for setup, then continues | ✅ tests/browser | |
| 12 | Setup failure codes | ✅ tests/browser | |
| 13 | Durable one-per-workspace binding | ✅ desktop | Stored in `PLUGIN_DATA`, keyed by project path |
| 14 | 428 uninitialized / 409 root gone, never recreated | ✅ tests/browser | |
| 15 | Four fixed semantic lanes | ✅ desktop | |
| 16 | displayOrder/displayId/label/target/action config | ◐ partial | Plugin config file; the live-settings equivalent is TBD — **now:** stored in plugin config.json; no displayOrder/displayId UI |
| 17 | Lane meta endpoint | ✅ tests/browser | |
| 18 | Skill placeholders (display/action/target) | ✅ adapted | A Codex skill is a static file, so render it on config change, or have the skill read `/meta` via a tool. TBD — **now:** skill text is static; lane names via tool schema |
| 19 | Live Skill re-render | — n/a | Depends on #18 |
| 20 | 📝 header entry | ✅ adapted | Codex has no header slot for plugins, and project environment actions do not know the current thread (capability map R3). Entry = side-panel browser tab, auto-opened by the hook on startup/resume, hidden/shown with ⌥⌘B, reopened by `notes-open-panel` ("open Notes"). Panel cookie persists across restarts |
| 21 | Amber dot for pending carry | ✅ desktop | No header badge. The banner inside the panel, plus a one-line hook hint on the child's first prompt |
| 22 | Right panel drag-resize | — n/a | The Codex side panel handles its own sizing |
| 23 | Header ? / 🔍 / 🔄 / Save / × ; Esc | ✅ desktop | × maps to closing the tab (host) |
| 24 | Lane tabs | ✅ desktop | |
| 25 | Footer status/path | ✅ desktop | Fix the DSH discrepancy: show the actual bound path |
| 26 | Help panel | ✅ desktop | Codex content in zh/en, lead-ins bold; covers quoting from far back and showing/hiding the panel |
| 27 | Composer (empty body allowed for sourced notes) | ✅ desktop | |
| 28 | Quote selection into note | ✅ desktop | Select inside the panel's thread mirror (route B). Identity = host item id; `S` = selected visible text in our renderer. S7: whole-conversation outline, search and paste-to-locate for finding early passages (navigation only) |
| 29 | Auto-quote on panel open | ✗ not done | Applies to a selection existing in the panel mirror — **now:** no auto-quote on panel open (low value with in-panel mirror) |
| 30 | Host-validated capture, single message, multi-message fails closed | ✅ desktop | Mirror renders per-item containers; a selection across items fails closed (or becomes ordered loci; decide at implementation) |
| 31 | Quoted-source preview in composer | ✅ desktop | |
| 32 | No-source / quote-failure hints | ✅ tests/browser | |
| 33 | Unresolved-selection disclosure (missing in DSH) | — n/a | Our renderer controls the projection; disclose non-source chrome if any is selected — **now:** own renderer: no unresolved chrome to disclose |
| 34 | Plain note needs body; sourced may be empty | ✅ desktop | |
| 35 | Item key per note; versioned write | ✅ desktop | |
| 36 | Count + Newest/Oldest | ✅ desktop | |
| 37 | Card types / empty placeholder | ✅ desktop | |
| 38 | Source ▾ / snapshot / ↪ Return to source | ✅ desktop | Return happens *in the panel*: the source message with every `S` match highlighted (per text node), expandable adjacent turns, and an "open original thread" link (D2). A collapsed Source shows a 40-character preview |
| 39 | Legacy text read-only | ✅ tests/browser | Only if legacy data is adopted |
| 40 | In-place edit, body only, drift check | ✅ desktop | |
| 41 | Delete with inline confirm | ✅ desktop | |
| 42 | Pin (browser-local) | ✅ desktop | Pins are per-thread UI preferences stored in the plugin data directory, not note content |
| 43 | Pin/sort hidden on merge-wrapper lanes | ✅ tests/browser | |
| 44 | Search four lanes | ✅ tests/browser | |
| 45 | Search result actions | ✅ tests/browser | |
| 46 | Raw editor (advanced) | ✗ unsupported | Editing lane files directly in the Codex Files tab or another editor bypasses Notes CAS and is unsupported. |
| 47 | Same-conversation highlight in the real transcript | ✅ desktop | The Codex transcript is host-rendered, so highlight happens in the panel's source view. Plus a thread link |
| 48 | Broader whole-message cue labelled non-exact | ✅ tests/browser | In the panel's source view |
| 49 | Return outcome messages | ◐ partial | — **now:** core outcomes covered; not every DSH message variant |
| 50 | Cross-conversation return with per-request confirm | ✅ tests/browser | |
| 51 | Per-request consent; no search/rebind | ✅ tests/browser | |
| 52 | Quote checkbox for next message | ✅ desktop | |
| 53 | Host-held selection with generation | ✅ desktop | Plugin server holds it, per thread |
| 54 | Selection tray | ✅ desktop | |
| 55 | Reference injection before the user message, all-or-nothing | ✅ desktop | The `UserPromptSubmit` hook injects `additionalContext` (developer role, P2) rather than a user message. When ticked notes cannot be attached, it blocks the message with a reason and the selection stays |
| 56 | Clear selection only after durable append | ◐ partial | No hook `Stop` in Codex: the hook returns prepared reference text; the service confirms the turn via `thread/turns/list`, shows "Attaching…", and restores the selection on timeout. Consume is idempotent per turn (R2) |
| 57 | Success receipt | ✅ desktop | Fix the DSH discrepancy: don't show internal keys |
| 58 | Failure receipt, selection kept | ✅ desktop | See #55 |
| 59 | Versioned lane saves | ✅ tests/browser | |
| 60 | 409 banner: Load latest / Overwrite / Cancel | ✅ desktop | Load latest / Overwrite / Cancel; Overwrite reapplies the edit to the latest lane (R2); Cancel returns to editing with the draft kept (user-tested) |
| 61 | Unsaved-change confirms | ✅ desktop | Thread switch: the tab stays alive per thread (P11), so less loss |
| 62 | Drafts dropped on lane switch (DSH gap) | ✅ desktop | Fix: confirm or preserve drafts |
| 63 | Fork marker at session creation | ✅ desktop | No fork event. Detect on the child's first prompt/panel open via rollout `session_meta.forked_from_id` (P5) |
| 64 | Carry banner All/Some/None | ✅ desktop | |
| 65 | Save-before-inherit gate | ✅ tests/browser | |
| 66 | Occupied-lane Merge/Keep/Replace | ✅ desktop | |
| 67 | Carry result banner | ✅ desktop | |
| 68 | Fork-cut exclusion, new keys, parent-first merge, `carriedFromSession` | ✅ desktop | Eligibility by history membership: a source item in the child's history is kept; one only in the parent's history (after the fork point) is excluded; non-comparable and source-less notes are kept. Carry provenance is in the carry marker (planned child-local keys), as in DSH |
| 69 | Runtime-registered skill | ✅ adapted | Plugin `skills/` |
| 70 | `notes-read` | ✅ desktop | MCP tool, bound to the current thread through the call's `_meta.threadId`; optional read-only `thread` for another conversation the user names |
| 71 | `notes-write` (plain only) | ✅ desktop | |
| 72 | `notes-edit` | ✅ tests/browser | |
| 73 | `notes-source-reentry` | ✅ desktop | Via app-server `thread/items/list` |
| 74 | Error codes, path redaction | ✅ tests/browser | |
| 75 | "已经更新，请刷新查看" | ✅ tests/browser | Skill restores the DSH rule: after a delegated write/edit the first sentence is the localized refresh prompt; the panel polls only the active lane, so it never claims the panel refreshed |
| 76 | Setup-required agent behaviour | ✅ tests/browser | |
| 77 | Agent rules (user-led capture, ✅, deletion consent) | ✅ tests/browser | |
| 78 | Cross-conversation Notes read on explicit request | ✅ tests/browser | |
| 79 | Unused fork-preflight route | — n/a | |
| 80 | Plain-text rendering | ✅ tests/browser | Keep plain text for bodies; the source view renders Markdown to match what the user saw |
| 81 | Limits | ✅ tests/browser | |
| 82 | Origin check, path containment | ✅ desktop | Plus: bind 127.0.0.1, per-thread token (the in-app browser sends no thread identity) |
| 83 | Storage layout and block format | ✅ desktop | Reuse `dsh-note v1` blocks (compatibility, downstream agents) or define a new format; a durable-schema decision |

## Codex-only additions

- Quote navigator: latest 10 turns, "Load 20 earlier", whole-conversation
  search and paste-to-locate over a per-thread history cache (S7/S8).
- Service hand-over to the newest install after a plugin upgrade.
- Fork watch: a fork's own Notes opens with the carry question within
  seconds (S9).
- Cross-conversation source re-entry with up to 30 turns of context.
