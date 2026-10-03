# Changelog

## 0.8.8

- When you explicitly ask the agent to read further around a note's source,
  it can now read any number of turns before or after it (`before` /
  `after`). The default reach stays small (up to 30 turns each side).
- Panel help (Chinese) names the quote button correctly.

## 0.8.7 — Windows

- **Windows support** for Codex conversations and Work conversations that
  run on your computer, validated with ChatGPT 26.930.2377.0. Install with
  PowerShell (see the README).
- The Windows hook command runs under both PowerShell and cmd. After an
  update that changes a hook, trust the hooks again; on Windows this also
  applies to the Windows-only command.
- Panel help and agent instructions name the Windows shortcuts
  (Ctrl+Alt+B for the side panel, Ctrl+C / Ctrl+V).
- Diagnostics: `CN_HOOK_DEBUG=1` prints each hook step to stderr; a hook
  that runs out of time is now recorded in `hook-errors.log`.
- macOS: behaviour unchanged. The MCP launcher moved from an inline
  `/bin/sh -c` script to `server/launch-mcp`, which does the same.

## 0.7.2

- A renamed conversation's title appears in the Notes header within about
  15 seconds (was up to about 75).
- Install instructions: restart ChatGPT once more after trusting the hooks;
  hook trust takes effect only at start.

## 0.7.1 — first ChatGPT desktop release

Collaborative Notes for the ChatGPT desktop app (macOS). It shares its
product contract (Concept, Core Contract, Agent Guide) with the
[DeepSeek Harness release](https://github.com/aprilxuMLC/dsh-collaborative-notes) 0.1.1.

- **Surfaces:**
  - Codex conversations;
  - Work conversations that run on your computer.

  Validated with ChatGPT 26.908.70816 and 26.928.31416.
- **Notes panel** in the desktop side panel:
  - four lanes, write, edit, pin, sort, search, delete with confirmation;
  - first-use setup per project (lane names, notes location; existing DSH
    notes folders can be adopted);
  - English and Chinese interface, following the app language.
- **Silent capture with exact sources:**
  - quote from the conversation inside the panel, without creating a turn;
  - every quote is verified against the source message;
  - a quote view opens on the latest turns, searches the whole conversation
    (including compacted history) and jumps to a passage pasted from the
    transcript.
- **Return to source** in the panel, with literal highlighting and
  surrounding turns. A source in another conversation needs confirmation.
- **References:** ticked notes go with your next message as reference data.
  - Delivery is confirmed after the turn appears.
  - If the notes cannot be attached, the message is held and the ticks
    stay.
- **Agent tools:** read, write (plain notes), edit, source re-entry with up
  to 30 turns of context, and open the panel.
  - Another conversation's notes and sources are readable when you name that
    conversation, read-only.
- **Forks:**
  - a fork's own Notes opens within seconds and asks All / Some / None;
  - occupied lanes offer Merge / Keep / Replace;
  - notes whose source lies after the fork point stay behind;
  - carry is durable across interrupted writes.
- **Resilience:**
  - a closed panel reopens with a later message;
  - the panel survives app restarts;
  - plugin upgrades hand over without a restart of the service;
  - the plugin uses the Node.js and codex bundled with ChatGPT.
- **Known boundaries:**
  - macOS only (Windows planned);
  - cloud Work and ordinary Chat are not supported;
  - quoting covers one user or assistant message at a time.

See the [adapter specification](docs/chatgpt-desktop-adapter.md) for the
full contract realization.
