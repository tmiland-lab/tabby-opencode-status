# tabby-opencode-status

Native [Tabby](https://tabby.sh) plugin: tab color, progress bar, title emoji,
and activity dot follow the [opencode](https://opencode.ai) session status.
Includes **session restore**: tabs running opencode are recorded and can be
reopened with `opencode --continue` after a Tabby restart.

Companion: [`opencode-tabby-status`](../opencode-tabby-status) (the opencode
side, writes `$TMPDIR/tabby-claude-status.d/*.json`).

## Status mapping

| opencode | tab | default color |
|---|---|---|
| working ⚡ | color + indeterminate progress | orange `#ffa500` |
| needs input ❓ | color + activity dot + bell | gold `#ffd700` |
| done ✅ | color flash | green `#50c878` |
| error ❌ | color + activity dot | red `#ff5050` |
| idle 🌱 | default | — |

## Install

```sh
npm run install-plugin   # build + copy into Tabby's plugin dir
```

Restart Tabby. Configure under Settings → Opencode Status (surfaces, colors,
auto-resume, resume command).

## Session restore

While running, the bridge records every tab whose PTY process tree contains
`opencode` (cwd + title) into `opencodeStatus.sessions` in the Tabby config.
Settings → Opencode Status lists them with per-row Resume / Forget, plus
"Resume all now". With auto-resume on, all saved sessions reopen ~on boot at
their recorded cwd with the resume command (default `opencode --continue`).

## Develop

```sh
npm test      # typecheck + framework-free logic tests
npm run build # UMD bundle in dist/ (Tabby/Angular externals)
```

`src/interfaces`, `src/services`, `src/decorator`, `src/tabby/sessionTracker.ts`
are framework-free and covered by `test/run.ts`. `src/tabby/*.service|module|component`
integrate with Tabby APIs (`terminus-core`, `terminus-terminal`,
`terminus-settings`, `tabby-local`); `src/tabby/ambient.d.ts` pins the exact
consumed surface against Tabby 1.0.231 typings — re-check it when retargeting.
