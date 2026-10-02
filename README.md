# Collaborative Notes for Codex & Work

**English** | [中文](README.zh-CN.md)

**Keep the conversation moving. Keep the important things from getting lost.**

Collaborative Notes sits beside your Codex and Work conversations in the
ChatGPT desktop app. Capture ideas, questions, decisions and loose ends
without pulling the active conversation off course. Then return to them when
they matter, right back to the exact passage they came from.

> **A shared attention workspace for human–agent collaboration: something can leave the main thread without leaving the collaboration.**

Collaborative Notes is a human–agent collaboration plugin for the **Codex** and
**Work** modes of the ChatGPT desktop app. It is not a general notebook, a
task manager, a long-term memory, or a knowledge base. It adds a **shared
transient workspace** beside the current conversation. It helps you and the
agent decide what should keep occupying attention now, what can safely be set
aside, and how to bring it back accurately when it matters again.

**Release 0.7.1** is validated on macOS with ChatGPT 26.908.70816 and
26.928.31416. It works in Codex conversations and in Work conversations that
run on your computer.

It continues the [Collaborative Notes for DeepSeek Harness](https://github.com/aprilxuMLC/dsh-collaborative-notes)
release and shares its product contract. The ChatGPT desktop realization is
described in the [adapter specification](docs/chatgpt-desktop-adapter.md).

---

# I. What it is, and why it matters

### Conversation is linear. Work is not.

Real work constantly produces side paths. Keep everything in the conversation
and the main thread gets heavier. Drop everything into a separate notebook and
it is easy to lose why something mattered in the first place.

Collaborative Notes explores a third option:

> **Let something leave the main thread without leaving the collaboration.**

That is not only a memory problem. It is also an attention problem.

### Attention Dilution

In long-running collaboration, all the history, files, memory and notes may
still exist, yet the agent faces another problem. As more and more items stay
"potentially relevant", it gets harder to decide what deserves attention now.
Nothing is lost, but the collaboration becomes less clear: the constraints
that matter most are diluted by everything that might matter.

Collaborative Notes explores whether **attention itself can be a resource that
humans and agents manage together**. What is needed now stays in the main
thread. Other material, once reliably placed, can leave the agent's continuous
attention, and the user or the current task can bring it forward again later.

This uses a simple human–agent asymmetry. A human does not need to keep every
item inside an active context. A visible shared surface supports low-cost
peripheral attention: glance at an item, pin it, tick it, or say "bring this
one back". The agent then re-reads and reconstructs context through an
explicit entry point when needed.

> **Human peripheral attention + agent on-demand reactivation.**

Whether this reliably reduces cognitive load or improves task quality is a
product hypothesis that still needs validating across users and long tasks.

### Memory ≠ Attention

"Can this still be found later?" and "should this stay in attention now?" are
different questions. Collaborative Notes lets reliably placed material stop
demanding continuous attention. Deferred work, knowledge candidates and lesson
candidates leave the main thread instead of following the conversation forever.

> **Can be retrieved ≠ must stay in attention.**

Setting something aside safely is only half the problem; the other half is
returning to it. For notes that come from specific conversational material,
Collaborative Notes keeps the relationship to the original discussion. Later
work returns to the actual source instead of rediscovering a likely-looking
place through full-text search or model inference.

> **Attention can be released without losing the return path.**

The current agent does not have to predict every future context need at
capture time. A later agent or workflow with read authority can read the
note, follow its preserved source back to the original discussion, and read
as much surrounding context as its own task requires.

> **Future Context Handle, not Future Context Package.**

That is why the core stays small: capture, staging, routing, provenance and
reactivation. Downstream consumers do the real processing:

| Note | Future consumer | Downstream work |
|---|---|---|
| **L2 Deferred work** | backlog / work-planning agent | sorting, merging, scheduling, execution |
| **L3 Knowledge candidate** | knowledge agent / workflow | verification, deduplication, restructuring, formalization |
| **L4 Lesson candidate** | retrospective / agent-improvement workflow | review, validation, acceptance, then possible Rule / Skill / Prompt / Workflow changes |

> **Candidate ≠ formal state.** Capturing something means it is worth processing later, not that processing has happened.

The default is **user-led capture with collaborative maintenance**.
- The agent may help write a note you decided to keep, or propose one, but a
  proposal is not a capture.
- It does not mine ordinary conversation for notes, and it does not
  deduplicate or merge items at capture time.
- Notes are **local by default**: other conversations' notes enter the
  current agent's work only when you name that conversation for the request.

> **Local by default, explicitly retrieved when needed.**

---

# II. What it can do

## Capability overview

- **Silent capture.** Writing or quoting a note never creates a conversation
  turn. The agent is not interrupted and does not even notice.
- **Four lanes:**
  - L1 conversation to-do;
  - L2 deferred work;
  - L3 knowledge candidate;
  - L4 lesson candidate.

  Lanes are destinations, not priorities. L1 stays this conversation's
  responsibility; L2–L4 can truly leave the main thread.
- **Exact sources.** Quote a passage from the conversation into a note. The
  note keeps your authored text, the exact selected text, and the identity of
  the source message, separately.
- **↪ Return to source.** It shows the original turn with exactly that text
  highlighted, with earlier and later turns on demand. Sources are never
  guessed by search: a source that cannot be read is reported as such, not
  rebound to a similar passage.
- **Find anything in the conversation, even from long ago.** The quote view
  opens on the latest turns and searches the **whole** conversation,
  including parts compacted out of the agent's context. You can also copy a
  passage from the Codex transcript and paste it to jump straight there. In
  passing, this fills a gap in the host: Codex itself cannot search a long
  conversation for an exact passage.
- **Bring notes back when you choose.** Tick notes, and your next message
  carries them to the agent as reference data, not as instructions.
- **Notes for any agent, in any conversation or workflow.** The agent can
  read, write and edit notes, and follow a note's source back to the
  original discussion. It can do this:
  - in the current conversation;
  - in another conversation you name, read-only;
  - from any downstream workflow, since notes are plain files with an open
    format.

  Cross-conversation source re-entry is stronger here than in the DSH
  release: a note held by another conversation can be traced to its source
  and read with as much context as the task needs.
- **Branches.** When you fork a conversation, its own Notes opens within
  seconds and asks whether to bring all, some or none of the parent's notes.
  Notes whose source lies after the fork point stay behind, and the two
  sides then evolve independently.
- **Maintain.** Search, sort, pin, edit, and delete with confirmation. Only
  you delete.
- **Bilingual.** The panel follows the app language (English / 简体中文).

---

# III. Installation, first use, and support boundary

## Install (macOS)

Requires the ChatGPT desktop app with Codex or Work, and git. On a Mac without
git, run `xcode-select --install` once in Terminal to install Apple's Command
Line Tools.

In Terminal:

```sh
CODEX=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex
[ -x "$CODEX" ] || CODEX=/Applications/ChatGPT.app/Contents/Resources/codex   # older app layout
"$CODEX" plugin marketplace add aprilxuMLC/codex-work-collaborative-notes
"$CODEX" plugin add collaborative-notes@collaborative-notes
```

This uses the codex that ships with ChatGPT; nothing else needs installing.
Then:

1. Quit ChatGPT (⌘Q) and open it again.
2. **Trust the hooks once:** ChatGPT → Settings → Coding → Hooks →
   Collaborative Notes → trust both hooks. Codex runs plugin hooks only after
   you trust them, and again after any hook change.
3. **Quit ChatGPT (⌘Q) and open it once more.** Trust takes effect at start:
   until then, Notes does not open by itself and the panel shows an
   "Automatic features are off" banner.

Other ways to install:
- **Without git:** download this repository as a ZIP, unzip it, and pass the
  unzipped folder to `marketplace add` instead of the GitHub name.
- **Asking Codex to install it:** ask it to run exactly the commands above,
  to stop and report on any error, and not to install other software or edit
  `~/.codex` by hand. Trusting the hooks stays your step.

**Update:** run `"$CODEX" plugin marketplace upgrade`, then the `plugin add`
command again, then restart ChatGPT. Your notes and settings are kept.

**Uninstall:**
1. Run `"$CODEX" plugin remove collaborative-notes@collaborative-notes`.
2. Run `"$CODEX" plugin marketplace remove collaborative-notes`.
3. Restart ChatGPT.

Your notes stay in your project folders. The plugin's own data (bindings,
selections, settings) stays in
`~/.codex/plugins/data/collaborative-notes-collaborative-notes/`; delete
that folder if you no longer want it.

## First use

1. Open a **Codex** conversation, or a **Work** conversation that runs **on
   your computer** ("Where should this chat run?" → On your computer), in a
   project, and send a message. The **Notes** panel opens in the side panel.
2. In a new project:
   - confirm the four lane names;
   - choose where notes are stored (default `<project>/notes`, or another
     folder).

   If `<project>/notes` already holds Collaborative Notes, for example from
   the DSH plugin, setup offers to keep using it. A different location must not
   already contain notes. To reuse notes kept elsewhere, move that folder
   to `<project>/notes` before setup.
3. Write a note, or click **Quote from conversation**:
   - find the turn: a recent one, by searching, or by pasting a passage you
     copied;
   - select the exact text;
   - **Quote selection into note**.
4. Ask the agent: "put this in L2", "what does my L3 note say", "go back to
   the source of that note", "look at the L1 notes of the conversation about
   X". It answers "Updated — please refresh Notes to see it" after any
   change.

Hide or show the side panel with ⌥⌘B (View → Toggle Review Panel); the Notes
tab stays. If you close the tab, Notes opens again with your next message
after about five minutes, or ask the agent to "open Notes". The **?** in the
panel explains everything above.

| Works without trusted hooks | Needs trusted hooks |
|---|---|
| Panel features, agent note operations, opening the panel on request | Auto-opening the panel, attaching ticked notes to your next message |

## Support boundary

**Supported:** macOS; Codex conversations; Work conversations that run on your
computer.

**Not supported:**
- Work conversations in the cloud, and Work conversations branched from an
  ordinary Chat (also cloud). Notes needs your computer.
- Ordinary Chat, ChatGPT web, ChatGPT mobile.
- Windows: a planned extension.

**Things to know:**
- **Quoting** covers user and assistant messages, one message at a time.
  Reasoning, tool calls and file changes cannot be quoted.
- **Forks:** Codex copies the parent's tabs into a fork. Use the Notes tab
  whose header shows the fork's title; the parent's copy offers a button
  that opens the branch's Notes.
- **Ticked notes:** if they cannot be attached, that message is held back
  and the ticks stay. A Notes outage otherwise never blocks your
  conversation.
- **After updating the plugin**, restart ChatGPT. Conversations that were
  already open keep the previous version's agent tools until then.
- **Editing lane files directly** in the Files tab, an editor or a shell
  bypasses Notes protections and is unsupported.
- **Deleting** is permanent, with no trash. Notes are plain files in your
  project, not encrypted and not synced.
- **Host dependencies:** the plugin relies on observed desktop behaviour,
  which may change between app versions:
  - side-panel deeplinks;
  - app-server fields;
  - session-file metadata for fork detection;
  - tab restoration.

  See the capability maps.

---

# IV. For downstream agents and workflows

Notes are plain Markdown files, one per lane and conversation:

```text
<notes-root>/<lane>/<threadId>.md
lane ∈ conversation_todo | deferred_work | knowledge_candidate | lesson_candidate
```

Each note is a self-contained `dsh-note v1` block, the same format as the DSH
plugin. It has:
- `dsh-meta kind` (`source-independent` | `source-aware`);
- `origin` (the capture conversation);
- `host: codex`;
- an internal `item-key`;
- for quoted notes, a `source-payload` `{"sessionId": <threadId>,
  "messageId": <Codex item id>}` plus the exact selected text;
- the authored body.

To recover a note's context, resolve `threadId + messageId` through the Codex
app-server (`codex app-server`: `thread/items/list`, `thread/turns/list`),
then read as much of the surrounding conversation as your task needs. L3 and
L4 notes are candidates; promote them only through your own explicit review.

---

# V. Design documents and development

| Document | Read it when… |
|---|---|
| [Concept](docs/concept.zh-CN.md) *(Chinese)* | you want the reasoning: memory vs attention, attention dilution, staging, provenance, downstream workflows |
| [Core Contract](docs/core-contract.md) | you want the stable product semantics any host must preserve |
| [Agent Guide](docs/agent-guide.zh-CN.md) *(Chinese)* | you want to know how an agent should use Notes, and what it must not do |
| [ChatGPT Desktop Adapter Specification](docs/chatgpt-desktop-adapter.md) ([中文](docs/chatgpt-desktop-adapter.zh-CN.md)) | you want to know how this plugin realizes the contract on Codex and Work, its declarations, and its boundaries |
| [Codex capability map](docs/codex/capability-map.md), [Work capability map](docs/work/capability-map.md) | you want the observed host facts behind the design |
| [DSH parity](docs/codex/dsh-parity.md) | you want a feature-by-feature comparison with the DSH release |
| [CHANGELOG](CHANGELOG.md) | you want to know what changed |

Concept, Core Contract and Agent Guide are shared with the DSH release.
Statements in them about the DSH host profile describe that host; this
plugin's profile is the adapter specification.

**Development:**
- Runtime: the Node.js bundled with the ChatGPT desktop app, standard
  library only, with no npm dependencies.
- Tests: `node --test test/core/*.test.mjs test/service/*.test.mjs`.
- Install from a local clone: pass the clone's path to
  `"$CODEX" plugin marketplace add`.

```text
plugins/collaborative-notes/   the plugin (manifest, skill, hooks, MCP server, local service, panel)
.agents/plugins/               marketplace definition
test/                          node:test suites
docs/                          product documents, adapter specification, capability maps
```

## License

MIT, see [LICENSE](LICENSE).
