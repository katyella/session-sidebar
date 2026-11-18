# session-sidebar

A side pane that opens in every Claude Code session (terminal 144 columns or wider; `/sidebar` opens it at any width).

![The sidebar filling in while Claude builds a small app with three subagents, shown at 6x speed](assets/sidebar.gif)

Sections, top to bottom:

- **For you**: what is waiting on you, from `<session scratchpad>/for-you.md` (one `- item` per line; `- [x]` hides it). Shown in yellow at the top only when something is waiting; a new item raises a toast and a native notification.

- **Road so far**: the checklist Claude keeps at `<session scratchpad>/road.md` (`# Title`, then `- [x] done`, `- [~] now`, `- [ ] next`, `- [!] problem`, indented notes). Hidden when the file does not exist.
- **Tasks**: this session's background shell commands by their real description, with live state, run time and pass/fail counts for go test, Swift Testing, XCTest, pytest -v, jest/vitest and cargo test. Press a number to tail that task's output; the same number or `f` goes back to messages.
- **Agents**: subagents with their latest action.
- **Messages**: what agents sent each other and the lead, and agent finish notices.

Long runs raise a toast when they end (30 s or longer) and a native notification (5 min or longer). No gray text anywhere.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-sidebar --marketplace katyella/session-sidebar
```

Answer `y` to add the marketplace, then pick a scope (the user scope puts it in every session). From a shell instead:

```
claude plugin install session-sidebar --marketplace katyella/session-sidebar
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `katyella/session-sidebar`, then Add plugin.

## Fill the For you and Road sections

Tasks, agents and messages fill in on their own. For you and Road so far show what Claude writes to two files in its scratchpad folder, so tell it to keep them. Add this to `~/.claude/CLAUDE.md` (every project) or a project's `CLAUDE.md`:

```markdown
## Road so far (session sidebar)

For any task with more than a few steps, keep a checklist at `road.md` in your scratchpad directory; the session sidebar shows it live. Format: a `# Title` line, then one line per step: `- [x] done`, `- [~] in progress`, `- [ ] next`, `- [!] problem`, with short indented `  - notes` under a step. Update it as steps start, finish or hit a problem. Skip it for one-off questions.

## For you (session sidebar)

Keep `for-you.md` in your scratchpad directory as the list of things waiting on the user: something to look at, decide, approve, test or run themselves. One `- item` line each, short and specific, with the link or command they need. Write the item in the same turn you start waiting on them, before the reply that asks. Mark it `- [x]` or delete the line once it is done or no longer needed. Leave the file empty when nothing is waiting.
```

## Change it

The whole sidebar is `hooks/register.tsx`. Ask Claude to change it, then run `/reload-plugins`.
