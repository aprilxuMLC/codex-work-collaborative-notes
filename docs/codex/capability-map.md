# Codex desktop capability map — Collaborative Notes

> **Status:** DRAFT 0.3 · 2026-09-30 · static investigation + desktop runtime
> probes P1–P9 + resume complete; D2 decided by the user.
> **Scope:** ChatGPT desktop app, Codex surface, macOS only. Windows is a
> planned later extension; nothing here is a Windows claim. Work is not
> investigated here.
> **Authority:** this file records host evidence and implementation
> consequences. It does not define product semantics. Product authority is
> `aprilxuMLC/dsh-collab-notes@43ce4fe1:docs/{concept,core,agent}/…`
> (Concept 0.82, Core 0.18, Agent Guide 0.8).

## 0. Evidence labels and observed host

| Label | Meaning |
|---|---|
| **DOC** | Official documentation (learn.chatgpt.com) or bundled plugin-creator reference |
| **SCHEMA** | `codex app-server generate-json-schema` output from the installed CLI |
| **STATIC** | Read-only inspection of the installed app bundle (minified, version-specific; not an API) |
| **LOCAL DATA** | Read-only structural check of the local Codex thread store (ids/shape only, no content) |
| **RUNTIME** | Observed in the running desktop app (probe threads in a dedicated test project; app 26.908.70816) |
| **UNKNOWN** | Not established |

Observed host: ChatGPT.app `26.908.70816` (bundle id `com.openai.codex`),
bundled `codex-cli 0.158.0`, macOS 26.4.

STATIC findings come from bundle internals and may change in any update. They
guide probes; they are not support claims.

## 1. Extension surface

| Fact | Evidence |
|---|---|
| Plugin = directory with `.codex-plugin/plugin.json`; components: `skills/`, `hooks/hooks.json`, MCP servers (`.mcp.json` or inline), `apps` (`.app.json`), `assets/`. Installed via a marketplace (`~/.agents/plugins/marketplace.json` personal default) + `codex plugin add <name>@<marketplace>`; new thread needed to pick up changes. | DOC |
| Hooks (stable feature): `SessionStart` (matcher `source`: `startup`/`resume`/`clear`/`compact`), `UserPromptSubmit`, `PreCompact`/`PostCompact`, `Pre/PostToolUse`, `Stop`, `SessionEnd`, etc. Input includes `session_id`, `transcript_path`, `cwd`, `turn_id`. Output may add `additionalContext` (added as developer context, ~2.5k-token inline budget). Plugin hooks get `PLUGIN_ROOT`, `PLUGIN_DATA`; Windows override `commandWindows`. | DOC |
| Non-managed hooks, including plugin-bundled hooks, run only after the user reviews and trusts the exact hash of the hook definition (CLI `/hooks`; in the desktop app
Settings → Coding → Hooks, with per-hook "Trust" toggles and a banner noting
that hooks run outside the sandbox — RUNTIME). Installing or enabling a plugin does not trust its hooks, and any change to a hook requires re-trust. A CLI `codex exec` smoke test with an untrusted probe plugin fired no hooks. | DOC · CLI observation |
| MCP Apps UI (`enable_mcp_apps`) is *under development* / off. | STATIC (`codex features list`) |
| Inline HTML widgets exist (bundled `visualize` plugin) but are response content, not a persistent surface. | STATIC |
| Thread side panel has tabs incl. **File** (workspace file viewer; `markdownFileEditor` with source/preview modes), Browser, Review, Terminal, side chat. | STATIC (UI strings) · RUNTIME pending |
| Bundled `codex-app-tools` MCP (disabled by default) proxies app tools: `list_threads`, `read_thread`, `create_thread`, `fork_thread`, `send_message_to_thread`, `set_thread_pinned`, sidebar-section tools, … | STATIC |
| `codex://threads/<uuid>` deeplink opens a local thread; no message-level parameter found. | STATIC |

## 2. Requirement → capability → consequence

### R1 Explicit selected-visible-text capture with exact source (Core §§2.4, 6.1, 6.1.1)

- **Capability (STATIC + LOCAL DATA):** native *response text annotation*.
  The user selects text inside one assistant response, adds an optional
  comment, and the annotation is attached to the composer. On send, the host
  serializes it into the user message:
  `# Response annotations:` … `<response-annotations>` JSON array
  `[{text, annotation, source:{messageId, startOffset, endOffset}}]`
  `</response-annotations>`.
- **LOCAL DATA:** across 147 recent annotations, `source.messageId` resolved to
  the `item_id` of an `agentMessage` item in the host thread store in every
  case that had a `source`. `text` is the selected *visible* text; offsets are
  renderer-local and do not index the stored markdown. `text` was absent as a
  literal from the stored markdown in 8/123 cases (rendering differs from the
  source). 24 annotations had no `source` (selection outside the content
  container, or an older app version).
- **Selection scope (STATIC):** one annotation cannot span response targets
  ("Response selection is outside its annotation target"). Several
  annotations per prompt are allowed (ordered array). Selecting from *user*
  messages: UNKNOWN (target attribute seen only on assistant responses).
- **Sufficiency:** matches the Core minimum for selected-visible-text:
  authoritative `threadId + messageId` plus exact accepted visible text `S`.
  Offsets are not needed and must not become durable authority.
- **Gap:** the agent receives the annotation as prompt text. If the agent
  copies `messageId`/`S` into a save call, that is agent transcription, not
  adapter-established provenance (Guide §2.5, §13.1).
- **Consequence:** capture must bind the Note to the host-generated annotation
  mechanically. Candidate: a `UserPromptSubmit` hook parses the host block
  deterministically and records it keyed by `session_id + turn_id`. The Notes
  save tool then refers to "annotation #n of the current turn" and never takes
  free-form source fields. A missing `source` means truthful failure of
  anchored capture, not a downgrade to source-independent.
  **RUNTIME P2 confirmed (desktop, plugin hook):** `UserPromptSubmit`
  receives the full host-serialized `prompt` verbatim, including the
  `<response-annotations>` block. `session_id` equals the desktop thread id,
  and `turn_id` equals the rollout turn id. Hook trust takes effect
  immediately in already-open threads. `additionalContext` reached the
  model; the rollout stores it as a `developer` message in the same turn.
  `Stop` receives `last_assistant_message`. `PLUGIN_DATA` =
  `~/.codex/plugins/data/<plugin>-<marketplace>/`. The hook input carries no
  id for the user message itself.

### R2 Source re-entry with visible cue (Core §9.1)

- **Capability (STATIC):** the composer supports "navigate to annotation"
  before sending. Highlighting uses the CSS Custom Highlight API
  (`codex-response-annotation`). Thread-level deeplink `codex://threads/<uuid>`.
- **Agent re-entry:** `thread/read`, `thread/turns/list`, `thread/items/list`
  (SCHEMA) and `read_thread` (app tools) can read the item and surrounding
  turns. This satisfies exact-source-first context reading for the agent.
- **Human re-entry (RUNTIME, 2026-09-29, app 26.908.70816):**
  - Before send, the selection shows a numbered badge. After send, no
    persistent marker or highlight remains on the source response.
  - The sent user message carries an "N annotation" chip. The model's reply
    renders `:codex-annotation{index="N"}` as an "Annotation N" link.
  - Clicking either the chip or the link scrolls to the source response and
    briefly highlights the *whole paragraph block*, not the selected span.
    The highlight fades in about 3 s.
  - Both affordances survive thread switching.
- **Directive resolution (STATIC):** the renderer resolves
  `index` against the annotation array of the turn it belongs to. There is no
  evidence that a later turn can reference an earlier turn's annotation.
  RUNTIME P1b confirmed this: in a turn with no annotation, a model-emitted
  `:codex-annotation{index="1"}` is stored verbatim but renders as nothing,
  with no link. An agent therefore cannot synthesize a re-entry link later.
- **Selection scope (RUNTIME P1b):** selecting text in a *user* message
  offers only "More details | Ask in side chat", with no "Add to chat".
  Native annotations target assistant responses only.
- **Deeplink (RUNTIME P6):** `codex://threads/<uuid>` links in a model reply
  (Markdown or autolink) and in the side-panel Markdown preview open the
  thread with one click and no confirmation. The thread lands at its
  *remembered scroll position*. There is no message targeting and no
  highlight.
- **Assessment:** the host has a truthful message-level cue: the recorded
  message with a visible, broader-than-span emphasis. Core §9.1 accepts this
  as a minimum cue. However, it is reachable only from the capture turn's own
  chip or link. No path was found that goes from an arbitrary later Note
  reference to the source message.
- **Consequence:** likely the largest host gap. The Core minimum is to open
  the recorded message with a visible cue. Candidates to probe: persisted
  annotation markers; deeplink + in-thread scroll; attaching the Note's source
  as a new response annotation. If none can open the source message and show
  a cue, it is a **Decision-Design** item.

### R3 Shared visible Notes surface; delegated-operation equivalence (Core §4.1.1)

- **Capability:** no plugin-owned persistent panel (MCP Apps off).
  **RUNTIME P4 (desktop):**
  - Side panel → Files (⌘P) shows a workspace-rooted tree. A Markdown file
    opens in a live-preview editor with a "View source" toggle.
  - Edits autosave to disk with no explicit save.
  - An external write to the open file appears within about 3 s, with no
    prompt and no conflict UI.
  - A true concurrent race was not tested; it is presumably last-writer-wins.
  - Paths outside the thread workspace were not tested.
- **RUNTIME (2026-10-01, app 26.908.70816): project environment actions.**
  - `<project>/.codex/environments/environment.toml` may declare
    `[[actions]]` with `name`, `icon` (`tool|run|debug|test` only), and
    `command`.
  - Action 1 is bound to ⌘⇧D. It runs the command in a bottom-panel
    terminal tab, in the project directory.
  - `CODEX_THREAD_ID` is **unset** for actions. A button therefore cannot
    target the conversation on screen. Not adopted as the Notes entry point.
- **RUNTIME (2026-10-01): app upgrade 26.908.70816 → 26.928.31416** (bundled
  codex 0.154.0-alpha.6.2 → 0.159.2).
  - The bundled codex **moved** from `Contents/Resources/codex` to
    `Contents/Resources/codex-cli/bin/codex`. Plugin 0.5.12 silently fell
    back to a codex on PATH; 0.5.13 looks next to the app's own Node.js and
    tries both layouts.
  - `probes/codex/host-contract.mjs`: all 11 checks pass before and after. The
    only change is additive: `thread/items/list` entries gain
    `startedAtMs` / `completedAtMs`.
  - Plugin hook trust survived the upgrade. The panel, the agent tools and
    the running service kept working without a restart of the plugin.
- **RUNTIME (2026-10-01): fresh-Mac install** (second Mac, from GitHub as a
  collaborator).
  - A clean Mac has no git until Command Line Tools are installed
    (`xcode-select --install`, run in Terminal; Codex cannot trigger the
    installer from its sandbox).
  - Codex runs git with prompts disabled, so a private repository needs
    stored credentials first.
  - The desktop app sets `CODEX_MCP_NODE_PATH` for hooks but **not** for
    plugin MCP servers. A bare `node` command fails on a Mac without Node;
    0.5.14 launches via `/bin/sh` with the bundled `cua_node` first.
  - Update path: `codex plugin marketplace upgrade` + `plugin add` took the
    second Mac from 0.5.13 to 0.5.14. Hooks stayed trusted (hooks.json
    unchanged), notes data survived, and the agent tools worked after a
    restart.
- **RUNTIME (2026-10-01): archiving via app-server.** `thread/archive`
  through a separate `codex app-server` sets `archived=1` in
  `state_5.sqlite` and moves the rollout into `archived_sessions`, but the
  ChatGPT desktop sidebar keeps its own list and still shows the threads
  after a restart. Archive in the UI instead.
- **Consequence (superseded 2026-09-30 by the plugin-served Notes panel; kept as
  provenance):** the minimal native surface is a per-thread Notes file shown
  in the side panel File tab. The user edits it there; the agent mutates it
  through the Notes MCP tool. Equivalence then follows from one canonical file
  representation. Notes location is user-visible and durable: see §3 D1.

### R4 Stale-write protection (Core §4.2)

- **Capability:** none native for plain files. An MCP tool can enforce a
  version token (mtime/hash CAS) for agent writes. Direct user edits in the
  side-panel editor, and the agent's generic `apply_patch`/shell, bypass the
  tool.
- **Consequence:** the Notes MCP tool can enforce CAS for agent writes. The
  user's side-panel editor autosaves with no conflict detection (P4), so an
  agent write racing an unsaved user keystroke can be lost. This must be
  disclosed as a known coverage limit, or narrowed by design; for example,
  the tool re-reads immediately before writing and writes minimal appends. Generic file tools are
  disclosed as unprotected, per Core §4.3/§12.

### R5 Re-entry after compaction / resume (Core §9.3)

- **Capability (DOC):** `SessionStart` with `source=compact|resume` plus
  `additionalContext`, a skill in the plugin, and MCP tool discovery.
- **Consequence:** sufficient in principle. Inject only a stable pointer
  (the Notes path/tool exists), not Note bodies (Core §9.4). *Superseded:
  no SessionStart pointer is injected; the skill and tool discovery are
  enough, and a pointer would distract the agent (user decision).*
  **RUNTIME P3 (desktop):**
  - `SessionStart` fires with `source=startup` lazily, on the first prompt,
    not when the empty chat opens.
  - Manual `/compact` fires `PreCompact` and then `PostCompact`
    (`trigger=manual`). The next prompt fires `SessionStart source=compact`.
  - After compaction, earlier hook-injected developer context is gone from
    the model's view, and the `compact` injection restores it. This is
    sufficient for the stable-pointer approach.
  - After a full app restart (version unchanged, 26.908.70816), the first
    prompt fires `SessionStart source=resume`, and its injection reaches the
    model.
  - Unlike compact, earlier injected context survives resume, so a pointer
    injection should be idempotent.
  - Annotation chips and links, and their jump-and-flash, persist across the
    restart.
  - The desktop `/` menu also exposes Compact and Fork chat.

### R6 Conversation locality and cross-session access (Core §7)

- **Capability:** thread ids are host UUIDs (`session_id` in hooks — RUNTIME
  confirm). Notes keyed by thread id give default locality. Cross-session
  reads go through explicit tool arguments and remain authority-governed by
  the Skill.
- **Consequence:** ordinary, no gap expected.

### R7 Fork / carry-over (Core §8)

- **Capability (SCHEMA/STATIC):** `thread/fork` by `threadId`, optional
  `lastTurnId` (inclusive) for mid-history forks. The UI has "fork from here"
  on assistant messages. Thread metadata records `parent_thread_id`.
- **RUNTIME P5 (desktop, "Branch in new chat" → "Fork in this workspace"
  on a mid-history response):**
  - The child history is inherited *by reference*. The child rollout
    `session_meta` records `forked_from_id`, `forked_from_ordinal_exclusive`,
    and `history_base {thread_id, end_ordinal_exclusive}` (verified). It
    records no `parent_thread_id` key.
  - Inherited items keep the parent `item_id`s. An annotation made in the
    child on inherited content serializes `source.messageId` = the parent's
    item id, and the jump-and-flash re-entry works in the child.
  - Child-own items continue the parent ordinal numbering.
  - A fork is not a distinct hook event. The child fires `SessionStart
    source=startup` with no parent field. The parent is discoverable from
    `transcript_path`'s `session_meta`, or via the app-server.
  - Consequence: fork eligibility (Core §8.1.1) is mechanically decidable.
    A Note's source `messageId` is eligible iff it is a parent item with
    ordinal `< forked_from_ordinal_exclusive`. Carry-over must be offered by
    the plugin on the child's first prompt, or on user request.
### R8 Deletion authority (Core §10.2)

- **Capability:** the Notes MCP tool can refuse deletion without an explicit
  user-authority flag. File-level deletion through generic tools cannot be
  mechanically blocked. Disclose, as DSH did.

## 3. Decisions

### D1 Notes location — follows Decision 64 (no new product decision)

The portable semantics are already decided by
`dsh-collab-notes@43ce4fe1:docs/planning/cross-host-transition/64-notes-storage-addressing-and-binding-decision.md`:
one location binding per workspace/project scope; a host-appropriate default
with an explicit first-write choice; no Agent path guessing; and a mechanical
current-holder binding.

Codex realization:
- The scope is the Codex project (thread `cwd`).
- The holder is the hook `session_id` / thread id (P2).
- The default location sits inside the project, so the workspace-rooted
  side-panel Files tree can show it (P4).

Two items are left to implementation, and are raised with the user if they
turn product-significant: projectless chats, and a custom location outside
the project.

### D2 Source re-entry — USER DECIDED 2026-09-30

User clarification of the invariant: the product exists so that low-cost
peripheral human attention can find a Note, then return to the original
context to remember why it mattered. Without a return to the original
context, a Note is an ordinary note.

**Agent re-entry.** The agent resolves the Note's `threadId + messageId`
through the public app-server (`thread/items/list`; verified on the P1 thread
and on the fork child). It then reads as much surrounding context as the task
needs. This holds for in-thread discussion and for downstream workflows alike.

> **Superseded (2026-09-30).** The design below is kept as provenance and
> runtime evidence for app 26.908.70816 only; it is not an adapter capability
> claim. The supported human surface is the in-panel **↪ Return to source**
> view, rendered by the Notes panel (user-approved surface redesign). No
> agent-opened page is required; `notes-open-panel` opens the Notes panel
> itself only when the user asks.

**Human re-entry, Codex realization (revised after P10).** A
plugin-generated *source view*, created **on demand** (the user has to ask
the agent to look at the source in any case) and **opened automatically in
the side panel**.

Opening (RUNTIME P10):
- The bundled `codex-app-tools` tool `open_in_codex` is available to the
  model. Its parameters are `placement: right|bottom`, `threadId?`, and a
  `target` of type `file{path,line?}`, `browser{url?,tabId?}`, `terminal`, or
  `review`.
- A call with `target.type=browser` and a `file://` URL opened a local HTML
  page in a new side-panel browser tab with no click and no confirmation.
  `<mark>` highlighting and local JS expand buttons worked.
- `target.type=file` opened a workspace Markdown file the same way.
- The tool is undocumented in public docs. Its behaviour is recorded here as
  RUNTIME fact for app 26.908.70816 only.

Flow:
1. The Notes MCP tool mechanically fetches the source turn through the
   app-server. It writes a local HTML view outside the project, for example
   under `PLUGIN_DATA`, and returns its `file://` URL.
2. The agent calls `open_in_codex` to show the view in the side panel.
3. If opening fails, the agent reply links the view instead; P9 showed that
   chat file links open in the side panel.

View content:
- Header: thread title + thread id + Note lane/label.
- The source turn in full, with every occurrence of `S` inside that message
  `<mark>`-highlighted.
- Adjacent turns pre-embedded behind local "expand" buttons (load more).
- An "open in original thread" `codex://threads/<id>` link.

Beyond the embedded range, the user asks the agent. The tool regenerates the
view, and the agent reopens or reloads the tab.

The in-chat visualize card (P8/P9) remains an optional secondary surface for
discussion. The side-panel Markdown view with bold `⟦ ⟧` marking (P8) is kept
only as a fallback.

Truthfulness:
- If `S` cannot be matched literally in the message's visible text, the whole
  message is marked and `S` is shown separately, labelled "not precisely
  located". This is never presented as exact.
- An unreadable source is reported as an availability failure.

Views are derived, regenerable presentation, not Notes state. They live
outside the Notes files and are overwritten on regeneration. Clearing them
is not Note deletion.

Rejected:
- the private desktop IPC "re-annotate" route (private protocol, pollutes
  the source thread, coarser cue);
- the thread link plus manual ⌘F as the *primary* path. It remains available
  as a fallback.

Optional, not scheduled: ask OpenAI for a message-level deep link. The app
already has internal jump-to-annotation.

## 4. Runtime probe list (desktop, macOS)

1. Annotation lifecycle after send: do markers persist and highlight; can the
   user navigate back from history?
2. Plugin hook `UserPromptSubmit`: `prompt` contains the annotation block
   verbatim; `session_id` == thread id; `turn_id` present.
3. `SessionStart` `compact`/`resume` fire for plugin hooks in desktop;
   `additionalContext` visible to the model.
4. Side panel File tab: open/edit a Markdown file; external-change refresh
   behaviour.
5. Fork from message: child item ids versus parent; parent id discoverable
   from the child.
6. `codex://threads/<id>` link clicked from a response or Notes file opens the
   thread.
7. ⌘F / sidebar search behaviour (P7).
8. Side-panel Markdown rendering and relative links; in-chat visualize card
   (P8).
9. File links in replies, card local JS, and live refresh of a regenerated
   view (P9).
10. Agent-driven side-panel opening via `open_in_codex` (file and `file://`
    browser page) (P10).
11. Localhost interactive panel in the side-panel browser tab (P11):
    - opens automatically when the agent calls `open_in_codex`, with no
      prompt;
    - reads and writes through the local service;
    - tabs are thread-owned and keep their state across thread switches;
    - the user can open it by URL by hand;
    - the in-app browser sends no thread-identifying header;
    - **after a full app restart, browser tabs are NOT restored** (file tabs
      only partially). The panel must be reopened by the `resume` hook.
12. MCP `tools/call` params carry `_meta.threadId` and `sessionId`,
    `x-codex-turn-metadata.{thread_id,turn_id,workspaces}`, and `plugin_id`.
    - CLI `codex exec` 0.158 and **desktop P14 both confirm** `threadId` ==
      the calling thread.
    - The desktop spawns **one MCP server process per thread**, all under
      the same parent.
    - The MCP process has no `PLUGIN_DATA` or `CODEX*` env.
    - `workspaces` is the git root, not the thread `cwd`.
14. Clipboard after ⌘C from a response contains plain text plus an HTML
    flavor with no message id (P12). Paste-based capture cannot establish
    source identity, so it is not used.
15. The `codex://browser?url=<encoded>` deeplink, run with `open` outside the
    app (P13):
    - opens a browser tab in the **currently displayed** thread's side panel;
    - auto-expands a collapsed panel, with no prompt;
    - reuses an existing tab with the identical URL and does not reload it.

    The tab strip shows the page `<title>` and follows `document.title`
    live, for the active tab and for **background** tabs, across
    collapse/expand and thread switches (P13b).
16. Phase-0/S4 behaviour checks (plugin 0.4.0, app 26.908.70816):
    - After `/compact` and after a full app restart, the agent finds and uses
      the Notes tools through skill discovery alone, with **no injected
      context** (2 and 1 calls).
    - On restart the host restores the first side-panel tab, so the resume
      hook must not open a duplicate.
    - The panel locale follows the app UI language on reload (Settings →
      General → Language).
    - Pins persist across reload and restart.
    - The panel service outlives an app quit and is reused.
17. A fork copies the parent's side-panel tabs into the child, including
    an open Notes tab. That copied tab shows the *parent's* notes, and the
    page cannot know which thread's side panel hosts it, so this cannot be
    prevented. Mitigation: the header shows the owning conversation's title,
    and a fork hint names the child's own panel. This is recorded as a host
    limitation (S3/S5).
18. Without a cross-thread tool, the desktop agent fell back to
    `navigate_to_codex_page` plus in-app-browser automation of the Notes
    panel (S5 E1). This motivates the read-only `notes-read {thread}`
    parameter and the skill rule that forbids operating the panel.
13. `UserPromptSubmit` can block a prompt with `{"decision":"block",
    "reason"}` or exit 2 (DOC).

All probes ran on app 26.908.70816, macOS. Resume was tested after a full
app restart with no version change.
