# Collaborative Notes — ChatGPT Desktop Adapter Specification

**English** | [中文](chatgpt-desktop-adapter.zh-CN.md)

> **Version:** 0.8.13 · validated on macOS (ChatGPT 26.908.70816, 26.928.31416) and
> Windows (ChatGPT 26.930.2377.0; the native folder dialog was validated on the
> contributor's Windows machine).
>
> **Scope:** how this plugin realizes the Collaborative Notes
> [Core Contract](core-contract.md) on the ChatGPT desktop app's **Codex** mode
> and on **Work** conversations that run on the user's computer. It is the
> host profile for this release; product semantics come from the Core
> Contract, the [Agent Guide](agent-guide.zh-CN.md) and the
> [Concept](concept.zh-CN.md). Observed host facts are in the
> [Codex](codex/capability-map.md) and [Work](work/capability-map.md)
> capability maps.

## 1. Host surfaces

- **Codex conversations.** Each is a Codex thread with a stable thread id, a
  project folder (`cwd`), and an item history readable through `codex
  app-server`.
- **Work conversations "on your computer".** They are the same kind of Codex
  thread; the thread's `originator` is `codex_work_desktop` instead of
  `Codex Desktop`. One code path serves both.
- **Out of scope:**
  - cloud Work conversations;
  - Work conversations branched from an ordinary Chat;
  - ordinary Chat, web, mobile.

  None of them has a local thread, hooks or plugin tools.
- **Platforms:** macOS and Windows. One code base; Windows-specific behaviour
  includes native first-use folder selection, process launch, executable lookup and the panel deeplink
  (§10).

## 2. Components

| Component | Role |
|---|---|
| **Skill** (`skills/collab-notes`) | Agent operating rules: user-led capture, truthful closure, no deletion, the refresh prompt, source re-entry, locality |
| **Hooks** (`SessionStart`, `UserPromptSubmit`) | Open the Notes panel for desktop sessions; attach ticked notes to the next message; reopen a closed panel on a later message |
| **MCP server** (`collab_notes`) | Agent tools: `notes-read`, `notes-write`, `notes-edit`, `notes-source-reentry`, `notes-open-panel` |
| **Local service** | One per user data directory, bound to `127.0.0.1`. Serves the panel and its API, verifies quotes, holds the per-thread history cache, runs the fork watch, and hands over to the newest install after an upgrade |
| **Panel** | A page in the desktop side panel's browser tab: lanes, composer, quote navigator, return to source, carry, search, help (en / zh-CN) |

Runtime: the Node.js bundled with the desktop app, standard library only.
The bundled `codex` is used for app-server access.

## 3. Identity and storage

- **Holder:** the Codex thread id. It is bound mechanically from the hook
  session id, the MCP call's `_meta.threadId`, and the panel URL path. The
  agent never supplies a holder.
- **Project:** the thread's `cwd`. A one-time setup per project binds a notes
  root, by default `<project>/notes` (Decision 64). A missing configured root
  is reported, never recreated.
- **Changing the location after setup** ("Change location" beside the bound
  path; also offered when the bound root is unavailable). **This differs by
  host platform:**
  - **macOS:** the project is re-pointed to another folder; notes are not
    copied or moved. The folder may already hold notes (for example a notes
    folder the user moved there); a folder one level too high is detected.
  - **Windows:** the user picks an empty folder; the service copies all
    managed notes there, verifies them, and only then switches the binding.
    The old copy is kept, never deleted; on any failure the old binding
    stays. Note writes, carry and the move share a project-wide lock, so no
    write lands in the old copy after the switch. Lane folder names are
    matched case-insensitively and an ambiguous layout refuses the move. When
    the bound root is unavailable there is nothing to copy, and Windows offers
    the macOS-style re-pointing instead.
- **Windows first-use custom location:** the standard folder dialog returns a
  candidate; the panel asks for confirmation. If initialization, loading,
  selection or timeout fails, the existing in-panel picker is offered with
  Windows drive buttons and drive/UNC breadcrumbs. Both paths use the original
  setup checks and storage range. Accessible local, mapped and network folders
  are subject to the original permissions; network access is not guaranteed.
  Folder creation in the system dialog is immediate and cancellation does not
  remove it. macOS keeps its existing picker. The native helper uses Windows PowerShell 5.1 / .NET
  Framework, respects execution policy, owns its dialog window and applies
  per-monitor DPI. Windows 10 version 1703 or later is required for the native
  UI. When native support is unavailable, the panel picker remains available.
  Both choices use the original setup after explicit confirmation.
- **Lane display names** are one setting per install (plugin data
  `config.json`), shared by all projects; setup says so. Notes use lane keys,
  so renaming changes display only.
- **Layout:** `<root>/<lane>/<threadId>.md` for the lanes `conversation_todo`,
  `deferred_work`, `knowledge_candidate` and `lesson_candidate`.
- **Format:** `dsh-note v1` blocks, as in the DSH release, with a
  `dsh-meta host: codex` row.
- **Plugin data:** `~/.codex/plugins/data/<plugin>-<marketplace>/`. It holds
  the bindings, the lane configuration, per-thread selections and
  preferences, the service record and secret, and the fork-watch record.
  - Note content lives only in the notes root, with one exception: the
    rendered text of notes attached to a message, including their quoted
    source text, is kept with that turn's record, so a retry of that turn
    within 24 hours gets the same text. The copies are removed from disk
    after 24 hours, and are not removed earlier when the note itself is
    deleted.
  - Uninstalling the plugin leaves this directory; delete it by hand if
    wanted.

## 4. Source capture (Core §§2, 5; Decision 44)

- **Route.** Quoting happens inside the panel, in a mirror of the current
  thread built from the app-server by exact item id. It never creates a
  conversation turn.
- **Source identity:** `{sessionId: threadId, messageId: itemId}` of a user or
  assistant message. `S` is the visible text selected in the panel's
  renderer, whose text projection equals the server's projection of the item.
- **Verification.**
  - The service reads the item directly (never from a cache) and requires
    `S` to be a literal substring of its visible text.
  - A selection spanning messages fails closed.
  - Reasoning, tool calls and file changes are not quotable.
- **Navigation is not identity.**
  - The quote navigator opens on the latest turns ("load 20 earlier") and
    searches the whole thread through a per-thread cache. Search matching
    ignores whitespace and case.
  - Pasting a passage copied from the transcript jumps to the matching turn.
  - Search and paste only locate; the stored quote is always the user's own
    selection of the original.

## 5. Return to source (Core §§5, 8)

- **Human:** "↪ Return to source" renders the source message with every
  literal match of `S` highlighted, plus earlier and later turns on demand.
  - The source message always comes from a direct read; cached turns supply
    only the context.
  - A readable source without a literal match is labelled non-exact.
  - An unreadable source is reported as unavailable, with the snapshot kept.
  - A source in another conversation needs a per-request confirmation in the
    panel.
- **Agent:** `notes-source-reentry` returns
  `source: resolved | unavailable | unauthorized` and
  `match: exact | not-located`, the source message, and up to 30 turns of
  context on each side, as the agent chooses. When the user explicitly asks
  to read further, `before` / `after` take any number of turns on one side;
  `hasEarlier` / `hasLater` say whether more remains.
  - With `thread`, it re-enters a note held by another conversation the user
    named, read-only.
- Never search for a similar passage or rebind a source.

## 6. References to the agent (Core §8)

- Ticked notes form a per-thread selection held by the service.
- The `UserPromptSubmit` hook attaches them as additional context. They are
  marked as collaboration data, not instructions.
- If they cannot be attached, the message is blocked and the ticks stay.
  Without ticks, a Notes outage never blocks a message.
- Codex has no hook after a turn, so delivery is confirmed when the turn
  appears in the thread. The panel shows "Attaching…" until then, and the
  selection is restored if the turn never appears.
- Consumption is idempotent per turn and survives a service restart.

## 7. Agent operations and locality (Core §§2, 6)

- **Tools.** `notes-read` reads; `notes-write` creates a plain note only;
  `notes-edit` changes the authored text, with an expected version.
- **No delete tool, no source-capture tool.**
- After a change, the agent's reply starts with a refresh prompt.
- **Other conversations:** `notes-read {thread}` and `notes-source-reentry
  {thread}`, only for a conversation the user names in the request. The
  result is read-only and grants no standing access. The authorization is
  behavioural (skill and tool contract), which Core §6 leaves to the
  adapter.

## 8. Concurrency and integrity (Core §4)

- **Supported mutation paths:** the panel, through the local service, and the
  MCP tools. Both use the canonical writer:
  - lane version tokens (SHA-256 compare-and-swap);
  - a cross-process lane lock taken over only from a dead holder, under a
    separate takeover lock;
  - an atomic write, re-checked before rename.
- **Overwrite:** "Overwrite anyway" re-applies the user's edit to the latest
  lane body; it never writes a stale body.
- **Deletion:** in the panel only, with inline confirmation.
- **Unprotected paths:** editing lane files in the Files tab, an editor, a
  shell or another plugin bypasses these protections and is unsupported. So
  is calling the local HTTP API with the service secret.

## 9. Forks and carry (Core §7)

- **Detection.** The local service watches newly created Codex session files
  and reads only their first line (metadata).
  - For a desktop, user-initiated fork whose project is set up, whose parent
    has notes, and whose carry is undecided, it opens the fork's own Notes
    within a few seconds, once per fork.
  - `CN_FORK_WATCH=0` disables the watcher.
- **Host behaviour:** Codex copies the parent's tabs into a fork. The
  parent's panel shows "A branch was just created…" with a button that
  switches the tab to the branch's Notes, and a way back.
- **Decision:** All / Some / None. Occupied lanes ask Merge / Keep / Replace,
  with previews.
- **Eligibility:**
  - a source item in the child's history is kept;
  - a source only in the parent's history (after the fork point) is
    excluded;
  - non-comparable and source-less notes are kept.
- **Carried notes get new keys** and then evolve independently.
- **Durability:** before writing a lane, the carry marker records the
  lane's planned child-local keys and resulting version. A retry treats a
  lane that already holds them as committed, so nothing is duplicated.

## 10. Lifecycle and resilience

- **Panel entry:**
  - auto-opened on startup and resume;
  - hidden or shown with the side-panel toggle;
  - reopened by the next message if no Notes page has checked in for 5
    minutes. If that check itself fails, macOS opens the panel and Windows
    skips this reopening (to avoid a duplicate tab);
  - on Windows, opening (automatic, `notes-open-panel` and fork) goes through
    one coordinator that reuses the page's existing address, so the host
    focuses or reopens the same tab;
  - opened on request (`notes-open-panel`).
- **Panel access:** a per-thread HMAC token, exchanged for a persistent
  `HttpOnly`, `SameSite=Strict` cookie, so a tab restored after a restart
  still works.
- **Upgrades.** When an upgrade removes the old install, the old service
  starts the newest install on the same port and data directory. Child
  processes run from the home directory, because `codex app-server` fails in
  a deleted working directory. An open page reloads itself when the service
  version changes.
- **Runtime lookup:**
  - macOS: MCP launches through `/bin/sh` (`server/launch-mcp`) with the
    bundled Node first; hooks use `CODEX_MCP_NODE_PATH`; app-server access
    uses the bundled `codex`, in either known layout.
  - Windows: Codex resolves the MCP command to `server/launch-mcp.cmd`;
    MCP and hooks run through `server/node-run.cmd`, which finds the Node
    that ChatGPT copies under `%LOCALAPPDATA%\OpenAI\Codex`. Hooks run in the
    session's shell (PowerShell), so the hook command starts with
    `cmd /d /c call`. App-server access uses the newest `codex.exe` under
    `%LOCALAPPDATA%\OpenAI\Codex`; on `PATH`, only a real `codex.exe`.
    Background processes start hidden and outside the plugin folder, so an
    update can replace that folder while ChatGPT runs.
- **Panel deeplink:** `codex://browser?url=…` on macOS;
  `codex://threads/<id>?browserUrl=…` on Windows, where the bare browser
  link does nothing.
- **History cache:** at most 3 threads, evicted after 10 minutes idle,
  topped up incrementally. Rewinds drop stale turns.

## 11. Data access declarations

The plugin reads only these:
- the project's notes root;
- its own plugin data directory and its own install files (the panel
  assets, its manifest);
- during setup, when you browse for a notes location: the folder listing
  of the folders you open, and a new folder you ask it to create;
- on Windows native setup, Windows Shell locations the user navigates in the
  standard dialog; selected-directory metadata and its resolved volume type;
  the helper's launching process identity and handle, only for lifecycle cleanup;
  screen work areas and cursor position, only to place its own dialog;
- Codex thread data through the bundled `codex app-server`, read-only;
- the first line of newly created Codex session files, for fork detection;
- `~/.codex/config.toml`, for the interface language;
- the conversation transcript's first line, to tell desktop sessions from
  CLI ones;
- on Windows, the file listing under `%LOCALAPPDATA%\OpenAI\Codex`, to find
  ChatGPT's Node and `codex.exe`, and, only when an old service does not
  answer, that process's command line, to confirm it is this plugin's.

It writes only:
- the notes root;
- its plugin data directory;
- during setup, a new folder you ask it to create;
- on Windows, a private temporary folder for compiling the folder-dialog
  helper, removed after each use (left in place and logged once if removal
  fails).

It sends nothing off the machine. The service listens on `127.0.0.1` only.

## 12. Known qualifications

- Quoting is one user or assistant message at a time.
- Delivery of ticked notes is confirmed after the fact, because the host has
  no post-turn hook.
- Cross-thread authorization is behavioural, not mechanical.
- On Windows, hook trust covers the Windows command: an update that changes
  it shows the hooks as modified until the user trusts them again. On macOS
  only the macOS command counts.
- Direct file edits are unprotected.
- Copied tabs after a fork are host behaviour; the plugin works around them.
- The plugin relies on observed desktop behaviour that may change between
  app versions: side-panel deeplinks, app-server fields, session-file
  metadata, tab restoration.
  - `node probes/codex/host-contract.mjs <threadId>` checks the app-server
    thread schema, the bundled codex and the `codex://` URL scheme before
    and after an app update.
  - Side-panel opening, fork detection and tab restoration are checked by
    hand on the desktop.
