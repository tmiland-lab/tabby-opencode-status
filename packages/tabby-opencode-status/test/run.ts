// Framework-free tests: status mapping, spool drain, decorator behavior
// (including the Tabby title-loop guard), session tracker. No deps.
import assert from "node:assert"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { DEFAULT_CONFIG, statusForEvent } from "../src/interfaces/types"
import { StatusFileService, parseSpoolFile } from "../src/services/statusFileService"
import { OpencodeStatusDecorator, TabLike } from "../src/decorator/opencodeStatusDecorator"
import { SessionTracker } from "../src/tabby/sessionTracker"

// Fake tab that re-emits title changes synchronously, exactly like Tabby's
// titleChange$ (which also fires for OUR setTitle calls).
class FakeTab implements TabLike {
  color: string | null = null
  title = "shell"
  progress: number | null = null
  activity = false
  private cb: ((t: string) => void) | null = null
  setProgress(p: number | null): void {
    this.progress = p
  }
  setTitle(t: string): void {
    this.title = t
    this.cb?.(t)
  }
  displayActivity(): void {
    this.activity = true
  }
  clearActivity(): void {
    this.activity = false
  }
  onTitleFromTerminal(cb: (t: string) => void): void {
    this.cb = cb
  }
  terminalRenamesTo(t: string): void {
    this.title = t
    this.cb?.(t)
  }
}

const fullOn = { ...DEFAULT_CONFIG, showTabColor: true, showTitleEmoji: true, showProgress: true, showActivityDot: true }

// 1. mapping
assert.equal(statusForEvent("PreToolUse"), "working")
assert.equal(statusForEvent("PostToolUse"), "working")
assert.equal(statusForEvent("UserPromptSubmit"), "working")
assert.equal(statusForEvent("PermissionRequest"), "question")
assert.equal(statusForEvent("Notification"), "question")
assert.equal(statusForEvent("Stop"), "done")
assert.equal(statusForEvent("PostToolUseFailure"), "error")
assert.equal(statusForEvent("SessionStart"), "idle")
assert.equal(statusForEvent("Whatever"), "idle")
console.log("OK mapping")

// 2. spool drain
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabby-os-test-"))
fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify({ event: "PreToolUse", session: "s", ppid: 1, ancestors: [11, 22] }))
fs.writeFileSync(path.join(dir, "bad.json"), "{nope")
fs.writeFileSync(path.join(dir, "ignore.txt"), "x")
const got: string[] = []
new StatusFileService(dir, 500).drain((s) => {
  got.push(`${s.status}/${s.session}/${s.ancestors.join(",")}`)
  return true // routed here -> file may be consumed
})
assert.deepEqual(got, ["working/s/11,22"])
assert.deepEqual(fs.readdirSync(dir), ["ignore.txt"])

// an unrouted file must stay for other Tabby windows to pick up
const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "tabby-os-test-"))
fs.writeFileSync(path.join(dir2, "a.json"), JSON.stringify({ event: "PreToolUse", session: "s", ppid: 1, ancestors: [11] }))
new StatusFileService(dir2, 500).drain(() => false)
assert.deepEqual(fs.readdirSync(dir2), ["a.json"])
fs.rmSync(dir2, { recursive: true, force: true })
assert.equal(parseSpoolFile("junk"), null)
console.log("OK spool")
fs.rmSync(dir, { recursive: true, force: true })

// 3. decorator incl. title-loop guard (would stack-overflow without the guard)
const d = new OpencodeStatusDecorator(fullOn)
const tab = new FakeTab()
d.attachTab(tab, 1234)
d.apply(tab, "working") // internally setTitle -> cb -> must terminate
assert.equal(tab.title, "⚡ shell")
assert.equal(tab.color, fullOn.colors.working)
assert.equal(tab.progress, 0.5)
tab.terminalRenamesTo("vim") // terminal sets a new title underneath us
assert.equal(tab.title, "⚡ vim")
d.apply(tab, "question")
assert.equal(tab.title, "❓ vim")
assert.equal(tab.activity, true)
d.apply(tab, "idle")
assert.equal(tab.title, "🌱 vim") // idle keeps its 🌱 prefix while emoji is on
assert.equal(tab.color, null)
assert.equal(tab.progress, null)
d.clear(tab)
assert.equal(tab.title, "vim")
console.log("OK decorator")

// 4. session tracker
const t = new SessionTracker()
t.note("/a", "opencode · a")
t.note("/b", "opencode · b")
t.note("", "ignored")
assert.equal(t.list().length, 2)
t.forget("/a")
assert.deepEqual(t.list().map((r) => r.cwd), ["/b"])
const rt = new SessionTracker()
rt.load(t.serialize())
assert.deepEqual(rt.list().map((r) => r.cwd), ["/b"])
rt.load("junk{{")
assert.equal(rt.list().length, 0)
rt.load([{ cwd: "/c" }, { nope: 1 }])
assert.deepEqual(rt.list().map((r) => r.cwd), ["/c"])
const old = new SessionTracker()
old.note("/old", "x", 1)
old.prune(10, 100)
assert.equal(old.list().length, 0)
console.log("OK tracker")

console.log("ALL TABBY PLUGIN CORE TESTS PASSED")
