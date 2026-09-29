// Tabby tab status for opencode (v2 plugin API).
// - Emits OSC tab-title / progress / iTerm2 tab-color sequences on session status
//   changes (works in Tabby, Ghostty, WezTerm, Windows Terminal, VS Code, iTerm2).
// - Writes tabby-claude-status-compatible spool files to $TMPDIR/tabby-claude-status.d/
//   so the Tabby plugin `tabby-claude-status` (Settings → Plugins) can paint the
//   tab's true color / progress bar / emoji prefix for opencode with zero changes.
//
// Mapping (opencode v2 event -> Claude-compatible event for Tabby matching):
//   session.execution.started / session.step.started -> PreToolUse (working)
//   session.execution.succeeded / .interrupted       -> Stop       (done)
//   session.created                                  -> SessionStart (idle)
//   permission.asked / form.created                  -> PermissionRequest (question)
//   form.replied / form.cancelled                    -> PreToolUse (working)
//   session.execution.failed                         -> PostToolUseFailure (error)
//   session.status / session.idle                    -> handled if they fire
// NB: v2 does not emit session.status for ordinary turns; the execution/step
// lifecycle events above are the reliable status source.
//
// Colors (iTerm2 OSC 6;1 tab-color, honored by iTerm2; harmless elsewhere):
//   working  orange, question yellow, done green, error red, idle reset.
// Tabby true tab color comes from the tabby-claude-status plugin reading the
// spool dir below — install it for the bottom-border color.
//
// v2 ancestry note: the opencode server is a detached daemon (reparented to
// systemd), so the plugin's own process ancestry no longer reaches the Tabby
// pty. The TUI client that owns a session is found by its command line
// (`opencode ... -s <sessionID>`) and its pid + ancestor chain are folded into
// each spool file so the Tabby plugin's pty intersection still matches the tab.
//
// Env overrides:
//   TABBY_STATUS_NO_OSC=1        disable OSC emission
//   TABBY_STATUS_NO_SPOOL=1      disable spool files
//   TABBY_STATUS_NO_TITLE=1      don't touch tab title
//   TABBY_STATUS_BELL=1          bell on done/error
//   TABBY_STATUS_SPOOL_DIR=...   override spool dir (default $TMPDIR/tabby-claude-status.d)

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const SPOOL_DIR =
  process.env.TABBY_STATUS_SPOOL_DIR || path.join(os.tmpdir(), "tabby-claude-status.d")

const BEL = "\x07"
const OSC_TITLE = (s) => `\x1b]0;${s}${BEL}`
const OSC_PROGRESS = (state, pct) =>
  pct === undefined ? `\x1b]9;4;${state}${BEL}` : `\x1b]9;4;${state};${pct}${BEL}`
// iTerm2 tab color: OSC 6;1;bg;red;brightness;N etc. Reset: OSC 6;1;bg;*;default
const TAB_COLOR = ({ r, g, b }) =>
  `\x1b]6;1;bg;red;brightness;${r}${BEL}` +
  `\x1b]6;1;bg;green;brightness;${g}${BEL}` +
  `\x1b]6;1;bg;blue;brightness;${b}${BEL}`
const TAB_COLOR_RESET = `\x1b]6;1;bg;*;default${BEL}`

const COLORS = {
  working: { r: 255, g: 165, b: 0 }, // orange
  question: { r: 255, g: 215, b: 0 }, // gold
  done: { r: 80, g: 200, b: 120 }, // green
  error: { r: 255, g: 80, b: 80 }, // red
}

const EMOJI = { working: "⚡", question: "❓", done: "✅", error: "❌", idle: "🌱" }

function getAncestorPids(startPid, depth) {
  // Linux fast path: /proc/<pid>/stat, zero subprocesses
  if (process.platform === "linux") {
    const pids = []
    let current = startPid
    for (let i = 0; i < depth; i++) {
      try {
        const stat = fs.readFileSync(`/proc/${current}/stat`, "utf8")
        const m = stat.match(/\)\s+\S+\s+(\d+)/)
        const parent = m ? parseInt(m[1], 10) : null
        if (!parent || parent <= 1) break
        pids.push(parent)
        current = parent
      } catch {
        break
      }
    }
    return pids
  }
  // macOS / fallback: ps per level
  try {
    const { execSync } = require("node:child_process")
    const pids = []
    let current = startPid
    for (let i = 0; i < depth; i++) {
      try {
        const out = execSync(`ps -o ppid= -p ${current}`, { encoding: "utf8", timeout: 2000 })
        const parent = parseInt(out.trim(), 10) || null
        if (!parent || parent <= 1) break
        pids.push(parent)
        current = parent
      } catch {
        break
      }
    }
    return pids
  } catch {
    return []
  }
}

// --- tab routing (v2) -------------------------------------------------------
// The server is detached, so walk up from the TUI client instead. The client
// carries its session in argv (`opencode -s ses_...`); child (subagent)
// sessions are resolved to their root via session.created parentIDs.
const SESSION_PARENTS = new Map()
const CLIENT_CACHE_TTL = 5000
const clientCache = new Map()

function rootSession(sessionID) {
  let cur = sessionID
  for (let i = 0; i < 20; i++) {
    const parent = SESSION_PARENTS.get(cur)
    if (!parent) return cur
    cur = parent
  }
  return cur
}

function scanClientPids(sessionID) {
  const pids = []
  if (!sessionID || process.platform !== "linux") return pids
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      const pid = parseInt(entry, 10)
      if (pid === process.pid) continue
      try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
        if (raw.includes("opencode") && raw.includes(sessionID)) pids.push(pid)
      } catch {
        // process vanished between readdir and read
      }
    }
  } catch {
    // no /proc
  }
  return pids
}

function findClientPids(sessionID) {
  if (!sessionID) return []
  const now = Date.now()
  const hit = clientCache.get(sessionID)
  if (hit && now - hit.ts < CLIENT_CACHE_TTL) return hit.pids
  let pids = scanClientPids(sessionID)
  if (!pids.length) {
    const root = rootSession(sessionID)
    if (root !== sessionID) pids = scanClientPids(root)
  }
  clientCache.set(sessionID, { ts: now, pids })
  if (clientCache.size > 50) {
    for (const [k, v] of clientCache) if (now - v.ts > CLIENT_CACHE_TTL * 4) clientCache.delete(k)
  }
  return pids
}

// Diagnostics: a filtered ring buffer plus per-event counters, so we can see
// which V2 events actually fire (session.status turned out not to be emitted
// for normal turns) without high-frequency deltas flushing the buffer.
// Written to $TMPDIR/tabby-status.events.json.
const EVENT_LOG = []
const EVENT_COUNTS = new Map()
const EVENT_LOG_FILE = path.join(os.tmpdir(), "tabby-status.events.json")
const NOISY_EVENT = /\.(delta|streamed|progress|updated)$/

let lastDiagWrite = 0

function recordEvent(type, data) {
  try {
    const session = data?.sessionID || data?.form?.sessionID || ""
    const key = `${type}:${session.slice(0, 14)}`
    EVENT_COUNTS.set(key, (EVENT_COUNTS.get(key) || 0) + 1)
    const noisy = NOISY_EVENT.test(type)
    if (!noisy) {
      EVENT_LOG.push(key)
      if (EVENT_LOG.length > 120) EVENT_LOG.shift()
    }
    const now = Date.now()
    // Noisy deltas fire dozens of times per second — throttle those writes.
    if (noisy && now - lastDiagWrite < 2000) return
    lastDiagWrite = now
    const counts = {}
    for (const [k, v] of EVENT_COUNTS) counts[k] = v
    fs.writeFileSync(EVENT_LOG_FILE, JSON.stringify({ ts: now, events: EVENT_LOG, counts }))
  } catch {
    // diagnostics are best-effort
  }
}

function emit(raw) {
  if (process.env.TABBY_STATUS_NO_OSC === "1") return
  try {
    // stderr: stdout may be piped to the TUI renderer; stderr reaches the pty.
    if (process.stderr?.isTTY) process.stderr.write(raw)
    else process.stdout?.write?.(raw)
  } catch {
    // never break a session on terminal output
  }
}

function spool(claudeEvent, sessionID, extra) {
  if (process.env.TABBY_STATUS_NO_SPOOL === "1") return
  try {
    const ancestors = new Set(getAncestorPids(process.pid, 6))
    for (const pid of findClientPids(sessionID)) {
      ancestors.add(pid)
      for (const a of getAncestorPids(pid, 6)) ancestors.add(a)
    }
    const status = {
      ts: Date.now(),
      event: claudeEvent,
      session: sessionID || "",
      ppid: process.ppid,
      ancestors: [...ancestors],
      cwd: process.cwd?.() || extra?.cwd || "",
      ...extra,
    }
    fs.mkdirSync(SPOOL_DIR, { recursive: true })
    const rand = Math.random().toString(36).slice(2, 8)
    const finalFile = path.join(SPOOL_DIR, `${status.ts}-${process.pid}-${rand}.json`)
    fs.writeFileSync(`${finalFile}.tmp`, JSON.stringify(status))
    fs.renameSync(`${finalFile}.tmp`, finalFile)
    pruneSpool()
  } catch {
    // spool is best-effort
  }
}

// The Tabby watcher deletes files as it consumes them, but if no watcher is
// installed they would pile up — drop anything older than 10 min. Fresh files
// are never touched, so a running watcher always wins the race.
function pruneSpool() {
  try {
    const now = Date.now()
    for (const f of fs.readdirSync(SPOOL_DIR)) {
      if (!f.endsWith(".json") && !f.endsWith(".json.tmp")) continue
      const ts = parseInt(f.split("-")[0], 10)
      if (!Number.isFinite(ts) || now - ts > 10 * 60 * 1000) {
        try {
          fs.rmSync(path.join(SPOOL_DIR, f))
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
}

function show(kind, sessionID) {
  const emoji = EMOJI[kind] || ""
  if (process.env.TABBY_STATUS_NO_TITLE !== "1") {
    emit(OSC_TITLE(`${emoji} opencode · ${kind}`))
  }
  if (kind === "working") {
    emit(OSC_PROGRESS(3)) // indeterminate spinner (ConEmu OSC 9;4)
    emit(TAB_COLOR(COLORS.working))
  } else if (kind === "question") {
    emit(OSC_PROGRESS(4)) // paused/warning
    emit(TAB_COLOR(COLORS.question))
    emit("\x07") // bell: needs input
  } else if (kind === "error") {
    emit(OSC_PROGRESS(2))
    emit(TAB_COLOR(COLORS.error))
    if (process.env.TABBY_STATUS_BELL === "1") emit("\x07")
  } else if (kind === "done") {
    emit(OSC_PROGRESS(1, 100))
    emit(TAB_COLOR(COLORS.done))
    if (process.env.TABBY_STATUS_BELL === "1") emit("\x07")
    // clear progress shortly after so the bar doesn't stick
    setTimeout(() => emit(OSC_PROGRESS(0)), 1500).unref?.()
  } else {
    emit(OSC_PROGRESS(0))
    emit(TAB_COLOR_RESET)
  }
}

// Map a single opencode v2 event to the terminal/spool side effects.
// Exported for the smoke test; the runtime only needs the default export.
export function handle(ev) {
  const t = ev?.type
  const d = ev?.data || {}
  recordEvent(t, d)
  // Agent-run lifecycle: the reliable V2 status source. `session.status` is
  // not emitted for ordinary turns, so map the execution/step events instead.
  if (t === "session.execution.started") {
    show("working", d.sessionID)
    spool("PreToolUse", d.sessionID)
    return
  }
  if (t === "session.execution.succeeded" || t === "session.execution.interrupted") {
    show("done", d.sessionID)
    spool("Stop", d.sessionID)
    return
  }
  if (t === "session.step.started") {
    show("working", d.sessionID)
    spool("PreToolUse", d.sessionID)
    return
  }
  if (t === "session.retry.scheduled") {
    show("working", d.sessionID)
    spool("PreToolUse", d.sessionID)
    return
  }
  if (t === "session.status") {
    const s = d.status?.type
    if (s === "busy") {
      show("working", d.sessionID)
      spool("PreToolUse", d.sessionID)
    } else if (s === "retry") {
      show("working", d.sessionID)
      spool("PreToolUse", d.sessionID)
    } else if (s === "idle") {
      show("done", d.sessionID)
      spool("Stop", d.sessionID)
    }
    return
  }
  if (t === "session.idle") {
    show("done", d.sessionID)
    spool("Stop", d.sessionID)
    return
  }
  if (t === "session.created") {
    if (d.parentID) SESSION_PARENTS.set(d.sessionID, d.parentID)
    show("idle", d.sessionID)
    spool("SessionStart", d.sessionID)
    return
  }
  if (t === "permission.asked") {
    const id = d.sessionID || ""
    show("question", id)
    spool("PermissionRequest", id)
    return
  }
  if (t === "permission.replied") {
    // Without this the tab stays stuck on "question" after you answer.
    const id = d.sessionID || ""
    show("working", id)
    spool("PreToolUse", id)
    return
  }
  if (t === "form.created") {
    const id = d.form?.sessionID || d.sessionID || ""
    show("question", id)
    spool("PermissionRequest", id)
    return
  }
  if (t === "form.replied") {
    const id = d.sessionID || ""
    show("working", id)
    spool("PreToolUse", id)
    return
  }
  if (t === "form.cancelled") {
    const id = d.sessionID || ""
    show("working", id)
    spool("PreToolUse", id)
    return
  }
  if (t === "session.execution.failed") {
    const id = d.sessionID || ""
    show("error", id)
    spool("PostToolUseFailure", id)
    return
  }
}

export default {
  id: "opencode-tabby-status",
  async setup(ctx) {
    // Fresh process looks idle until first event.
    show("idle", "")

    let stopped = false
    const events = ctx.event.subscribe()
    const loop = (async () => {
      try {
        for await (const ev of events) {
          if (stopped) break
          try {
            handle(ev)
          } catch {
            // never break a session on a bad event
          }
        }
      } catch {
        // subscription closed / errored — best-effort plugin
      }
    })()

    return async () => {
      stopped = true
      try {
        const closer = events?.return
        if (typeof closer === "function") await closer.call(events)
      } catch {
        // ignore
      }
      void loop.catch(() => {})
    }
  },
}
