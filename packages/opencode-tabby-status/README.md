# opencode-tabby-status

opencode plugin: terminal tab title, progress, and color follow the session
status. Zero dependencies.

## Install

```sh
opencode plugin add opencode-tabby-status
```

## What it does

On `session.execution.started` / `session.step.started` /
`session.text.started` / `session.reasoning.started` /
`session.inbox.enqueued` (working),
`permission.asked` / `form.created` / the `question` tool (needs input),
`session.execution.succeeded`
/ `.interrupted` (done), `session.execution.failed` (error), and
`session.created` (idle) it emits, best-effort (never breaks a session):

- OSC 0 tab title: `⚡/❓/✅/❌ opencode · <state>` — honored by Tabby,
  Ghostty, WezTerm, Windows Terminal, VS Code, iTerm2
- OSC 9;4 progress: indeterminate while working, clear on done, error state
  on failure
- iTerm2 OSC 6;1 tab color: orange / gold / green / red, reset on idle
- Spool file in `$TMPDIR/tabby-claude-status.d/` for the companion Tabby
  plugin (`tabby-opencode-status`, or the existing `tabby-claude-status`),
  matched to the right tab via PID ancestry. The v2 server is detached, so the
  spool includes the TUI client's pid (found via its `-s <sessionID>` command
  line) and its ancestor chain, not just the server's
- Self-healing: a live session's last state is re-asserted periodically (lost
  spool files, killed clients), and a "working" state with no real events for
  5 min is downgraded to done — a crashed turn no longer leaves a spinner up
  forever. A question is kept for 5s against a racing `step.started` and a
  stale session's late answer can no longer flip its tab back to working

## Env overrides

| Var | Effect |
|---|---|
| `TABBY_STATUS_NO_OSC=1` | disable OSC emission |
| `TABBY_STATUS_NO_SPOOL=1` | disable spool files |
| `TABBY_STATUS_NO_TITLE=1` | don't touch tab title |
| `TABBY_STATUS_BELL=1` | bell on done/error |
| `TABBY_STATUS_SPOOL_DIR=…` | override spool dir |
| `TABBY_STATUS_HEARTBEAT_MS=N` | status re-assert interval, default 60000, 0 = off |
| `TABBY_STATUS_SILENCE_MS=N` | downgrade stale "working" after N ms, default 300000, 0 = off |
| `TABBY_STATUS_QUESTION_HOLD_MS=N` | keep a fresh question from a racing step.started, default 5000 |

## Test

```sh
npm test
```
