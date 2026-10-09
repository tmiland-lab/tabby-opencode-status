// Smoke test for opencode-tabby-status. No test framework, no deps:
// drives the plugin's v2 setup() + event subscription through every mapped
// event and asserts on the OSC bytes emitted + spool files written.
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const spoolDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tabby-status-test-"))
process.env.TABBY_STATUS_SPOOL_DIR = spoolDir

// Controllable async iterable standing in for ctx.event.subscribe().
function createEventSource() {
  const pending = []
  let waiter = null
  let closed = false
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (closed) return { done: true }
          if (pending.length) return { value: pending.shift(), done: false }
          return new Promise((resolve) => {
            waiter = resolve
          })
        },
        async return() {
          closed = true
          if (waiter) {
            const w = waiter
            waiter = null
            w({ done: true })
          }
          return { done: true }
        },
      }
    },
  }
  return {
    iterable,
    push(ev) {
      if (waiter) {
        const w = waiter
        waiter = null
        w({ value: ev, done: false })
      } else {
        pending.push(ev)
      }
    },
  }
}

const { default: plugin, handle } = await import("../tabby-status.js")
// silence the init-time "idle" emission before we start capturing
for (const f of await fs.promises.readdir(spoolDir)) {
  await fs.promises.rm(path.join(spoolDir, f))
}

const writes = []
const origErr = process.stderr.write.bind(process.stderr)
const origOut = process.stdout.write.bind(process.stdout)
process.stderr.write = (s) => (writes.push(String(s)), true)
process.stdout.write = (s) => (writes.push(String(s)), true)

const src = createEventSource()
const ctx = { event: { subscribe: () => src.iterable } }
const cleanup = await plugin.setup(ctx)

const events = [
  { type: "session.created", data: { sessionID: "ses_smoke", title: "Smoke title" } },
  { type: "session.renamed", data: { sessionID: "ses_smoke", title: "Smoke renamed" } },
  { type: "session.status", data: { sessionID: "ses_smoke", status: { type: "busy" } } },
  { type: "session.status", data: { sessionID: "ses_smoke", status: { type: "retry" } } },
  { type: "permission.asked", data: { sessionID: "ses_smoke" } },
  { type: "form.created", data: { form: { sessionID: "ses_smoke" } } },
  { type: "form.replied", data: { sessionID: "ses_smoke" } },
  { type: "form.cancelled", data: { sessionID: "ses_smoke" } },
  { type: "session.status", data: { sessionID: "ses_smoke", status: { type: "idle" } } },
  { type: "session.idle", data: { sessionID: "ses_smoke" } },
  { type: "session.execution.failed", data: { sessionID: "ses_smoke" } },
]
for (const event of events) {
  src.push(event)
  await new Promise((r) => setTimeout(r, 0))
}

process.stderr.write = origErr
process.stdout.write = origOut

const out = writes.join("")
const fail = (msg) => (console.error(`FAIL: ${msg}`), process.exit(1))
for (const needle of ["opencode · working", "opencode · question", "opencode · done", "opencode · error"]) {
  if (!out.includes(needle)) fail(`missing title ${needle}`)
}
if (!out.includes("]9;4;3")) fail("missing indeterminate progress")
if (!out.includes("]9;4;0")) fail("missing progress clear")
if (!out.includes("]6;1;bg;")) fail("missing iTerm2 tab color")

const files = await fs.promises.readdir(spoolDir)
if (!files.length) fail("no spool files written")
const got = new Set()
const titles = new Set()
for (const f of files) {
  const s = JSON.parse(await fs.promises.readFile(path.join(spoolDir, f), "utf8"))
  if (!s.event || !s.session || !Array.isArray(s.ancestors)) fail(`bad spool shape in ${f}`)
  // The smoke session has no TUI client, so no ancestry may be emitted at all:
  // with none, the bridge can never misroute the file to an unrelated tab.
  if (s.ancestors.length) fail(`ancestry leaked into clientless ${f}: ${JSON.stringify(s.ancestors)}`)
  got.add(s.event)
  titles.add(s.title || "")
}
if (!titles.has("Smoke title") || !titles.has("Smoke renamed")) {
  fail(`spool title missing or not updated: ${[...titles].join(", ")}`)
}
for (const want of ["SessionStart", "PreToolUse", "PermissionRequest", "Stop", "PostToolUseFailure"]) {
  if (!got.has(want)) fail(`missing spool event ${want}`)
}

// Regression: an exact `-s <sessionID>` client must win over the bare-TUI cwd
// fallback, otherwise every bare `opencode` in the same directory (e.g. an
// `--auto` monitor tab) receives every session's status. The fallback itself
// must keep working for sessions whose TUI has no `-s` in its command line.
if (process.platform === "linux") {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "tabby-status-clients-"))
  const link = path.join(dir, "opencode")
  await fs.promises.symlink(process.execPath, link)
  const hold = ["-e", "setInterval(() => {}, 1000)"]
  const exact = spawn(process.execPath, [...hold, "opencode", "-s", "ses_smokefake"], { cwd: dir, stdio: "ignore" })
  // The sentinel arg matters: a bare `--auto` directly after `-e` is parsed as
  // a node option and the child exits immediately.
  const bare = spawn(link, [...hold, "opencode", "--auto"], { cwd: dir, stdio: "ignore" })
  process.on("exit", () => {
    try { exact.kill() } catch {}
    try { bare.kill() } catch {}
  })
  const ready = async (pid, needle) => {
    for (let i = 0; i < 40; i++) {
      try {
        if ((await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8")).includes(needle)) return true
      } catch {}
      await new Promise((r) => setTimeout(r, 50))
    }
    return false
  }
  if (!(await ready(exact.pid, "ses_smokefake")) || !(await ready(bare.pid, "--auto"))) {
    fail("fake clients did not start")
  }
  const read = async (session, event) => {
    let found = null
    for (const f of await fs.promises.readdir(spoolDir)) {
      if (!f.endsWith(".json")) continue
      const s = JSON.parse(await fs.promises.readFile(path.join(spoolDir, f), "utf8"))
      if (s.session === session && (!event || s.event === event)) found = s
    }
    return found
  }
  handle({ type: "session.step.started", data: { sessionID: "ses_smokefake" }, location: { directory: dir } })
  handle({ type: "session.step.started", data: { sessionID: "ses_smokebare" }, location: { directory: dir } })
  const exactFile = await read("ses_smokefake", "PreToolUse")
  const bareFile = await read("ses_smokebare", "PreToolUse")
  if (!exactFile || !bareFile) fail("fake client events were not spooled")
  if (!exactFile.ancestors.includes(exact.pid)) fail("exact -s client pid missing from ancestry")
  if (exactFile.ancestors.includes(bare.pid)) fail("bare same-dir TUI leaked into an exact client's file")
  if (!bareFile.ancestors.includes(bare.pid)) fail("cwd fallback no longer matches a clientless session")
  // Exit watcher: arming happens on Stop; once the exact client is gone the
  // SessionEnd reset must still carry the remembered (now dead) client chain.
  handle({ type: "session.execution.succeeded", data: { sessionID: "ses_smokefake" } })
  exact.kill()
  // Poll instead of a fixed sleep: the watcher only notices on its 3s tick, and
  // a tick racing the SIGTERM delivery just shifts the reset to the next one.
  let endFile = null
  for (let i = 0; i < 140 && !endFile; i++) {
    await new Promise((r) => setTimeout(r, 50))
    endFile = await read("ses_smokefake", "SessionEnd")
  }
  if (!endFile) fail("exit watcher did not spool SessionEnd")
  if (!endFile.ancestors.includes(exact.pid)) fail("SessionEnd lost the remembered client ancestry")
  if (endFile.ancestors.includes(bare.pid)) fail("SessionEnd leaked the bare same-dir TUI")
  bare.kill()
  await fs.promises.rm(dir, { recursive: true, force: true })
}

// Stop the plugin only now: dispose() clears the 3s exit-watch timer, which the
// fake-client section above needs alive to spool its SessionEnd.
await cleanup()
await fs.promises.rm(spoolDir, { recursive: true, force: true })
console.log(`OK: ${events.length} events, ${files.length} spool files, OSC title/progress/color all present`)
