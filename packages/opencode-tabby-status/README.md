# opencode-tabby-status

opencode plugin: terminal tab title, progress, and color follow the session
status. Zero dependencies.

## Install

From npm — add it to your opencode config (`~/.config/opencode/opencode.jsonc`):

```jsonc
{ "plugin": ["opencode-tabby-status"] }
```

opencode installs the package itself; restart it once.

From a clone (local file mode — auto-discovered and hot-reloaded):

```sh
cp tabby-status.js ~/.config/opencode/plugins/
```

## What it does

On `session.status` / `permission.asked` / `form.created` /
`session.execution.failed` / `session.created` it emits, best-effort (never
breaks a session):

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

## Env overrides

| Var | Effect |
|---|---|
| `TABBY_STATUS_NO_OSC=1` | disable OSC emission |
| `TABBY_STATUS_NO_SPOOL=1` | disable spool files |
| `TABBY_STATUS_NO_TITLE=1` | don't touch tab title |
| `TABBY_STATUS_BELL=1` | bell on done/error |
| `TABBY_STATUS_SPOOL_DIR=…` | override spool dir |

## Test

```sh
npm test
```
