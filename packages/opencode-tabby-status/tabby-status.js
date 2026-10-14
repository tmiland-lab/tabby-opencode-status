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
// v2 ancestry note: the opencode server is a detached daemon, so the TUI client
// that owns a session is found instead by its command line (`opencode ... -s
// <sessionID>`); only when no such client exists does the cwd fallback for bare
// TUIs (started without `-s`, matched via event `location.directory`) run —
// otherwise every bare `opencode` in the same directory (e.g. an `--auto`
// monitor tab) would receive every session's status. The client's pid +
// ancestor chain are folded into each spool file so the Tabby plugin's pty
// intersection still matches the tab. The daemon's own ancestry is deliberately
// NOT emitted: the detached server cannot identify a session's tab, and a
// server spawned from a TUI would broadcast every session to that tab.
//
// Env overrides:
//   TABBY_STATUS_NO_OSC=1        disable OSC emission
//   TABBY_STATUS_NO_SPOOL=1      disable spool files
//   TABBY_STATUS_NO_TITLE=1      don't touch tab title
//   TABBY_STATUS_BELL=1          bell on done/error
//   TABBY_STATUS_SPOOL_DIR=...   override spool dir (default $TMPDIR/tabby-claude-status.d)
//   TABBY_STATUS_HEARTBEAT_MS=N  status re-assert interval (default 60000, 0 = off)

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
//
// State lives on globalThis: opencode re-runs setup() on reload without
// disposing the old subscription, so each reload used to leak an instance with
// cold maps that spooled title-less files. Shared state + self-dispose in
// setup() keep one live instance that already knows every session.
const STORE = (globalThis[Symbol.for("opencode-tabby-status.store")] ??= {
  SESSION_PARENTS: new Map(),
  SESSION_DIR: new Map(),
  SESSION_TITLE: new Map(),
  clientCache: new Map(),
  SPOOL_MEMORY: new Map(),
  WAITING_EXIT: new Map(),
  doneTimers: new Map(),
  infoLookedUp: new Set(),
  lastSpool: new Map(),
  ctx: null,
  booted: false,
  dispose: null,
})
// A process that loaded an older version of this plugin already holds this
// store (the globalThis symbol survives reloads), so its shape can predate the
// fields below. Backfill them or handle() throws before spooling anything.
STORE.doneTimers ??= new Map()
STORE.infoLookedUp ??= new Set()
STORE.lastSpool ??= new Map()
STORE.ctx ??= null
STORE.booted ??= false
const SESSION_PARENTS = STORE.SESSION_PARENTS
// Session -> project directory, captured from every event's `location`.
// Needed to find TUI clients started without an explicit `-s <sessionID>`.
const SESSION_DIR = STORE.SESSION_DIR
const SESSION_TITLE = STORE.SESSION_TITLE
const CLIENT_CACHE_TTL = 5000
const clientCache = STORE.clientCache
// Last-known routing info per root session, captured while its TUI client is
// alive (ancestors only resolve then). Used to reset the tab after the client
// exits, and to know whether a client was ever found for the session.
const SPOOL_MEMORY = STORE.SPOOL_MEMORY
// Root sessions sitting in a finished state whose TUI client we still expect to
// exit; watched by watchClientExit().
const WAITING_EXIT = STORE.WAITING_EXIT
// Last non-terminal spooled event per root session; heartbeat() re-asserts it.
const LAST_SPOOL = STORE.lastSpool

// Spool files can be lost (TTL sweep in the Tabby plugin, a paused Tabby
// window) and a killed TUI client never sends SessionEnd, so every live
// session re-spools its last state periodically. 0 disables the heartbeat.
const HEARTBEAT_MS = (() => {
  const raw = Number(process.env.TABBY_STATUS_HEARTBEAT_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 60_000
})()
// Stop re-asserting sessions whose last event is older than this.
const HEARTBEAT_MAX_AGE_MS = 12 * 60 * 60 * 1000

function rootSession(sessionID) {
  let cur = sessionID
  for (let i = 0; i < 20; i++) {
    const parent = SESSION_PARENTS.get(cur)
    if (!parent) return cur
    cur = parent
  }
  return cur
}

// A turn is done when execution.succeeded lands — but that event is not
// guaranteed (a daemon restart kills the tail of a turn, and some turns only
// emit step.ended). Treat the last step of a turn as a fallback "done" after a
// short grace window; real activity in the window cancels it (steps run
// back-to-back within a turn, so a mid-turn step.ended is always followed by
// another step.started before the timer fires).
function cancelDone(sessionID) {
  const t = STORE.doneTimers.get(sessionID)
  if (!t) return
  clearTimeout(t)
  STORE.doneTimers.delete(sessionID)
}

function scheduleDone(sessionID) {
  if (!sessionID) return
  cancelDone(sessionID)
  const t = setTimeout(() => {
    STORE.doneTimers.delete(sessionID)
    show("done", sessionID)
    spool("Stop", sessionID)
  }, 4000)
  t.unref?.()
  STORE.doneTimers.set(sessionID, t)
}

// Sessions created before this plugin instance (the daemon can outlive a
// reload) never fired session.created here, so their title/parent are unknown
// and their spools would route without a title. Look them up once per id.
function ensureSessionInfo(sessionID) {
  if (!sessionID || STORE.infoLookedUp.has(sessionID)) return
  const ctx = STORE.ctx
  if (!ctx?.session?.get) return
  STORE.infoLookedUp.add(sessionID)
  Promise.resolve()
    .then(() => ctx.session.get({ sessionID }))
    .then((info) => {
      if (!info?.id) {
        // Retry next time: a transient failure must not hide the title (and
        // with it the tab routing) for the rest of the process lifetime.
        STORE.infoLookedUp.delete(sessionID)
        return
      }
      if (info.parentID) SESSION_PARENTS.set(info.id, info.parentID)
      if (info.title) SESSION_TITLE.set(info.id, info.title)
    })
    .catch(() => {
      STORE.infoLookedUp.delete(sessionID)
    })
}

// Every live TUI bound to a session (`opencode ... -s <id>`) owns one tab.
function scanBoundSessions() {
  const out = new Set()
  if (process.platform !== "linux") return out
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const raw = fs.readFileSync(`/proc/${entry}/cmdline`, "utf8")
        if (!raw.includes("opencode")) continue
        const m = raw.match(/(?:-s|--session)[\0=](ses_[A-Za-z0-9]+)/)
        if (m) out.add(m[1])
      } catch {
        // process vanished between readdir and read
      }
    }
  } catch {
    // no /proc
  }
  return out
}

// On a cold start the store is empty: sessions that predate this plugin
// instance (every TUI that survived a daemon restart) have no title/parent
// here and their tabs still show the status of the daemon that died. Rebuild
// what the session service knows and reset each live client tab to idle.
async function bootstrap(ctx) {
  const sids = scanBoundSessions()
  for (const sid of sids) {
    try {
      const info = await ctx.session.get({ sessionID: sid })
      if (!info?.id) continue
      STORE.infoLookedUp.add(info.id)
      if (info.parentID) SESSION_PARENTS.set(info.id, info.parentID)
      if (info.title) SESSION_TITLE.set(info.id, info.title)
    } catch {
      // session unknown to this daemon: keep the pid-based route only
    }
  }
  for (const sid of sids) {
    try {
      spool("SessionStart", sid)
    } catch {
      // best-effort
    }
  }
}

function sessionDir(sessionID) {
  if (!sessionID) return ""
  return SESSION_DIR.get(sessionID) || SESSION_DIR.get(rootSession(sessionID)) || ""
}

function sessionTitle(sessionID) {
  if (!sessionID) return ""
  return SESSION_TITLE.get(rootSession(sessionID)) || SESSION_TITLE.get(sessionID) || ""
}

// A TUI client is an `opencode` process that is not a server (`serve` /
// `--standalone`) and not already bound to a session via `-s ses_...`.
function isBareClient(raw) {
  const args = raw.split("\0").filter(Boolean)
  if (!args.length || path.basename(args[0]) !== "opencode") return false
  if (args.includes("serve") || args.includes("--standalone")) return false
  return !args.some((a) => a.startsWith("ses_"))
}

function scanClientPids(sessionID, dir) {
  const pids = []
  if (process.platform !== "linux") return pids
  if (!sessionID && !dir) return pids
  try {
    for (const entry of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      const pid = parseInt(entry, 10)
      if (pid === process.pid) continue
      try {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8")
        if (!raw.includes("opencode")) continue
        if (sessionID && raw.includes(sessionID)) {
          pids.push(pid)
          continue
        }
        // Bare TUIs carry no session in argv; fall back to matching the
        // client's working directory against the session's project directory.
        if (!dir || !isBareClient(raw)) continue
        if (fs.readlinkSync(`/proc/${pid}/cwd`) === dir) pids.push(pid)
      } catch {
        // process vanished between readdir and read
      }
    }
  } catch {
    // no /proc
  }
  return pids
}

function findClientPids(sessionID, dir) {
  if (!sessionID && !dir) return []
  const key = `${sessionID || ""}|${dir || ""}`
  const now = Date.now()
  const hit = clientCache.get(key)
  if (hit && now - hit.ts < CLIENT_CACHE_TTL) return hit.pids
  // Exact match first (`opencode ... -s <sessionID>`, or the root session for
  // subagent sessions). Only when no exact client exists may the cwd fallback
  // for bare TUIs run: otherwise every bare `opencode` in the same directory
  // (e.g. an `--auto` monitor tab) would receive every session's status.
  let pids = sessionID ? scanClientPids(sessionID, null) : []
  if (!pids.length && sessionID) {
    const root = rootSession(sessionID)
    if (root !== sessionID) pids = scanClientPids(root, null)
  }
  if (!pids.length && dir) pids = scanClientPids(null, dir)
  clientCache.set(key, { ts: now, pids })
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
  ensureSessionInfo(sessionID)
  try {
    const dir = extra?.cwd || sessionDir(sessionID)
    // Only the TUI client chain belongs here. The daemon's own ancestry is
    // deliberately excluded: the detached server cannot identify a session's
    // tab, and a server spawned from a TUI would broadcast every session to it.
    const ancestors = new Set()
    const clientPids = findClientPids(sessionID, dir)
    for (const pid of clientPids) {
      ancestors.add(pid)
      for (const a of getAncestorPids(pid, 6)) ancestors.add(a)
    }
    const status = {
      ts: Date.now(),
      event: claudeEvent,
      session: sessionID || "",
      ppid: process.ppid,
      ancestors: [...ancestors],
      cwd: dir || process.cwd?.() || "",
      title: extra?.title ?? sessionTitle(sessionID),
      ...extra,
    }
    // Remember how to reach this tab once the client is gone, and arm/disarm
    // the exit watcher: a finished turn (Stop/error) waits for the client to
    // exit; any new activity cancels that wait.
    const key = rootSession(sessionID) || sessionID || ""
    SPOOL_MEMORY.set(key, {
      ancestors: status.ancestors,
      cwd: status.cwd,
      clientSeen: clientPids.length > 0,
      clientPids,
    })
    if (claudeEvent === "Stop" || claudeEvent === "PostToolUseFailure") {
      WAITING_EXIT.set(key, SPOOL_MEMORY.get(key))
    } else if (claudeEvent !== "SessionEnd") {
      WAITING_EXIT.delete(key)
    }
    // Remember the last non-terminal state so heartbeat() can re-assert it;
    // SessionEnd clears it so an exited session is not resurrected.
    if (claudeEvent === "SessionEnd") {
      LAST_SPOOL.delete(key)
    } else {
      LAST_SPOOL.set(key, {
        event: claudeEvent,
        ts: status.ts,
        clientPids,
        ancestors: status.ancestors,
        cwd: status.cwd,
      })
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

// The detached server never learns that the TUI client exited, so a finished
// tab would otherwise stay green after you return to the shell. Poll the
// client pids remembered at spool time (a rescan cannot tell this session's
// dead client from a live bare TUI in the same directory) and spool a
// SessionEnd once they are gone: the Tabby plugin maps any unknown event to
// "idle", which clears the tab color. Cached ancestors are reused so the reset
// still routes to the tab (the shell/pty outlive the client).
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === "EPERM"
  }
}

function watchClientExit() {
  for (const [key, mem] of [...WAITING_EXIT]) {
    if (!mem || !mem.clientSeen) {
      WAITING_EXIT.delete(key)
      continue
    }
    if ((mem.clientPids || []).some(pidAlive)) continue
    WAITING_EXIT.delete(key)
    spool("SessionEnd", key, { ancestors: mem.ancestors, cwd: mem.cwd })
    show("idle", key)
  }
}

// Self-heal for updates Tabby never saw (TTL sweep, paused window) and for
// TUI clients killed without a SessionEnd: re-spool each live session's last
// state and clear the tab once its client is gone. Pids and ancestors are
// reused from spool time — a rescan cannot tell a dead client from a live
// bare TUI in the same directory.
function heartbeat() {
  const now = Date.now()
  for (const [key, entry] of [...LAST_SPOOL]) {
    if (!entry) {
      LAST_SPOOL.delete(key)
      continue
    }
    if (entry.clientPids?.length && !entry.clientPids.some(pidAlive)) {
      LAST_SPOOL.delete(key)
      WAITING_EXIT.delete(key)
      spool("SessionEnd", key, { ancestors: entry.ancestors, cwd: entry.cwd })
      continue
    }
    if (now - entry.ts > HEARTBEAT_MAX_AGE_MS) {
      LAST_SPOOL.delete(key)
      continue
    }
    spool(entry.event, key, { ancestors: entry.ancestors, cwd: entry.cwd })
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
  const dir = ev?.location?.directory
  if (dir && d.sessionID) SESSION_DIR.set(d.sessionID, dir)
  recordEvent(t, d)
  // Agent-run lifecycle: the reliable V2 status source. `session.status` is
  // not emitted for ordinary turns, so map the execution/step events instead.
  if (t === "session.execution.started") {
    cancelDone(d.sessionID)
    show("working", d.sessionID)
    spool("PreToolUse", d.sessionID)
    return
  }
  if (t === "session.execution.succeeded" || t === "session.execution.interrupted") {
    cancelDone(d.sessionID)
    show("done", d.sessionID)
    spool("Stop", d.sessionID)
    return
  }
  if (t === "session.step.started") {
    cancelDone(d.sessionID)
    show("working", d.sessionID)
    spool("PreToolUse", d.sessionID)
    return
  }
  if (t === "session.step.ended") {
    // Fallback done: execution.succeeded does not always arrive.
    scheduleDone(d.sessionID)
    return
  }
  if (t === "session.retry.scheduled") {
    cancelDone(d.sessionID)
    show("working", d.sessionID)
    spool("PreToolUse", d.sessionID)
    return
  }
  if (t === "session.status") {
    cancelDone(d.sessionID)
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
    cancelDone(d.sessionID)
    show("done", d.sessionID)
    spool("Stop", d.sessionID)
    return
  }
  if (t === "session.created") {
    if (d.parentID) SESSION_PARENTS.set(d.sessionID, d.parentID)
    if (d.title) SESSION_TITLE.set(d.sessionID, d.title)
    show("idle", d.sessionID)
    spool("SessionStart", d.sessionID)
    return
  }
  if (t === "session.renamed") {
    // Auto-generated and manual renames both land here: keep the title the
    // TUI shows so events route to the right tab.
    if (d.sessionID && d.title) SESSION_TITLE.set(d.sessionID, d.title)
    return
  }
  if (t === "session.deleted") {
    // Closing a session should also clear its tab.
    const id = d.sessionID || ""
    const key = rootSession(id) || id
    const mem = SPOOL_MEMORY.get(key)
    spool("SessionEnd", id, mem ? { ancestors: mem.ancestors, cwd: mem.cwd } : undefined)
    show("idle", id)
    WAITING_EXIT.delete(key)
    SESSION_PARENTS.delete(id)
    SESSION_TITLE.delete(id)
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
  if (t === "session.tool.input.started" && d.name === "question") {
    // V2 emits no form.created for the question tool (the event exists in the
    // schema but has zero emissions), so drive the question status from the
    // tool call itself. Without this the tab keeps showing the previous status
    // (e.g. "working") while the question waits for an answer.
    const id = d.sessionID || ""
    show("question", id)
    spool("PermissionRequest", id)
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
    cancelDone(id)
    show("error", id)
    spool("PostToolUseFailure", id)
    return
  }
}

export default {
  id: "opencode-tabby-status",
  async setup(ctx) {
    // opencode re-runs setup() on plugin reload without disposing the old
    // instance; stop it so events are not spooled twice from now on.
    try {
      await STORE.dispose?.()
    } catch {
      // ignore
    }
    // The daemon can restart under live TUIs: rebuild session info and reset
    // the tabs that still show the dead daemon's last status.
    STORE.ctx = ctx
    if (!STORE.booted) {
      STORE.booted = true
      void bootstrap(ctx).catch(() => {})
    }
    // Fresh process looks idle until first event.
    show("idle", "")

    // Reset finished tabs once their TUI client exits (see watchClientExit).
    const exitTimer = setInterval(() => {
      try {
        watchClientExit()
      } catch {
        // best-effort
      }
    }, 3000)
    exitTimer.unref?.()

    // Re-assert live sessions (see heartbeat): a lost or swept spool file would
    // otherwise leave the tab stuck on its last status forever.
    let heartbeatTimer = null
    if (HEARTBEAT_MS > 0) {
      heartbeatTimer = setInterval(() => {
        try {
          heartbeat()
        } catch {
          // best-effort
        }
      }, HEARTBEAT_MS)
      heartbeatTimer.unref?.()
    }

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

    const dispose = async () => {
      stopped = true
      clearInterval(exitTimer)
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      try {
        const closer = events?.return
        if (typeof closer === "function") await closer.call(events)
      } catch {
        // ignore
      }
      void loop.catch(() => {})
    }
    STORE.dispose = dispose
    return dispose
  },
}
