// Smoke test for opencode-tabby-status. No test framework, no deps:
// drives the plugin's v2 setup() + event subscription through every mapped
// event and asserts on the OSC bytes emitted + spool files written.
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

const { default: plugin } = await import("../tabby-status.js")
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
  { type: "session.created", data: { sessionID: "ses_smoke" } },
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
await cleanup()

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
for (const f of files) {
  const s = JSON.parse(await fs.promises.readFile(path.join(spoolDir, f), "utf8"))
  if (!s.event || !s.session || !Array.isArray(s.ancestors)) fail(`bad spool shape in ${f}`)
  got.add(s.event)
}
for (const want of ["SessionStart", "PreToolUse", "PermissionRequest", "Stop", "PostToolUseFailure"]) {
  if (!got.has(want)) fail(`missing spool event ${want}`)
}

await fs.promises.rm(spoolDir, { recursive: true, force: true })
console.log(`OK: ${events.length} events, ${files.length} spool files, OSC title/progress/color all present`)
