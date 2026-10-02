# Work surface — capability map

> **Status:** VALIDATED 1.0 · 2026-10-02 (ChatGPT 26.928.31416, macOS, plugin 0.7.0). Local Work conversations are supported; cloud Work and Chat-branched Work are not.
>
> **Evidence labels:**
> - STATIC = read from the app bundle (strings, code);
> - RUNTIME = observed on the desktop app;
> - UNKNOWN = not established.
>
> Support is claimed only for what was observed on the Work surface itself
> (sections 3–5), not inferred from Codex.

## 1. What Work is (STATIC)

- **A product mode of the desktop app, beside Codex.** The sidebar switches
  `sidebarProductMode` between `work` and `codex`. The persisted-mode default
  in code is `work`.
- **Availability is gated.**
  - `workModeSurfaceAvailable` requires an `allowed` status; otherwise the
    app shows "You don't have access to Work yet. Contact your admin to
    request access."
  - The pricing copy lists "Work mode for multi-step tasks" under Business.
  - A `workOnlyModeEnabled` flag also exists.
- **Positioning:**
  - "Research across your tools, create documents and presentations, and
    take action with ChatGPT";
  - "Switch to Work for tasks that involve multiple steps or files."
- **Branching:** chat messages offer "Branch into Work mode" and "Branch in
  new Chat".

## 2. Shared machinery with Codex (STATIC, to be verified)

- **Local projects and source folders are shared.** The same picker reads
  "Add folders ChatGPT can read and edit" in Work and "Add folders Codex can
  read and edit" in Codex.
- **Local and cloud chats.**
  - Work has "local chats" ("New local chat in {project}") and "cloud" chats
    ("This chat was started in the cloud, so ChatGPT won't be able to access
    files on your computer…").
  - A local chat's resume error names `config.toml`, Codex's config, which
    suggests local Work chats are Codex threads.
  - There is a `localThreadCatalog`; sidebar rows carry a "Work" hover label.
- **Plugins:**
  - The Work composer has a Plugins picker ("Browse all plugins", "Connect
    plugins", installing/loading states, `workRecommendationsHostId`).
  - RUNTIME: it lists Codex plugins installed from marketplaces, including
    Collaborative Notes (section 3).
- **Files:**
  - a "Files" picker over the ChatGPT Library and Space files;
  - local tasks have a size limit for attached files.

## 3. Runtime probe 1 (2026-10-01, user on this Mac)

Setup: the Chat/Work toggle shows **Work** (W1: access yes). In the Work
home, "Where should this chat run?" was set to **On your computer** in the
a test project. The Plugins picker lists Collaborative
Notes (W3).

- **W2 — a local Work chat is a Codex thread.** RUNTIME.
  - The rollout is in `~/.codex/sessions`, codex 0.159.2, `source: vscode`,
    `thread_source: user`, cwd = the project folder.
  - `originator` is **`codex_work_desktop`** (Codex: `Codex Desktop`).
  - The plugin's desktop check (`/desktop/i`) matches it unchanged.
- **W3 — hooks run.** RUNTIME. SessionStart and UserPromptSubmit were recorded
  for the Work thread.
- **W4 — MCP tools work.** RUNTIME. "把"Work 测试"记到 L1" was saved, and the
  reply began with the refresh prompt.
- **W5 — side panel.** RUNTIME.
  - The Notes panel opened by itself in Work's side panel. Its browser
    toolbar also shows the host "Annotate" button.
  - Quote from conversation and source capture work: the user quoted the
    first answer.

## 4. Runtime probe 2 (2026-10-01/02, user)

- **K1 — ticked notes reach a Work message.** "Notes attached to the last
  message: 2".
- **K2 / W6 — forks.** Work calls it "Fork chat from here → Fork in this
  workspace".
  - The fork (`forked_from_id` set, originator `codex_work_desktop`) was
    picked up by the fork watch within 3 s.
  - Its Notes opened, and the carry was decided.
- **K3 — cross-conversation read between Work and Codex threads in one
  project works.** Re-entry to those notes' sources failed: the agent could
  not open a note held by another conversation, and Work's agent has no
  separate thread-reading tool. Fixed in 0.6.1
  (`notes-source-reentry {thread}`, read-only; context up to 30 turns each
  side).
- **W8 — item types.** A Work thread has the same types as Codex
  (userMessage, reasoning, agentMessage commentary/final_answer,
  commandExecution, mcpToolCall).
- **K6 / W7 / W9 — out of scope.**
  - "Branch into Work mode" from an ordinary Chat produced a conversation
    without Notes tools: a ChatGPT cloud conversation, not a local Codex
    thread.
  - Separately, switching an existing Chat-only project to Work so that new
    chats could not be sent was reproduced by other users. Host issue.
- **Earlier misreading, retracted.** `hooks-seen.json` keeps the last time
  per event, not per thread, so it cannot show that a thread's hooks did not
  run. A second Work chat checked this way works normally.

## 5. Runtime probe 3 (2026-10-02, user)

- **K4:** quote-navigator search works in a Work thread.
- **K3b:** with 0.6.1, re-entry to another conversation's note source works
  from both Work and Codex conversations.

## 6. Conclusion

- A local Work conversation is a Codex thread (`originator:
  codex_work_desktop`), with the same hooks, MCP tools, side panel, item
  types and fork semantics.
- The Codex plugin serves Work without a Work-specific code path.
- Not supported: cloud Work conversations and Work conversations branched
  from an ordinary Chat. No local thread exists there, so there are no hooks
  and no tools.
