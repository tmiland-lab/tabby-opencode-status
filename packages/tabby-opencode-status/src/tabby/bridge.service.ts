// Bridge between Tabby and the opencode spool files.
// - Discovers terminal tabs (flattening splits) and attaches the decorator.
// - Matches spool events to tabs via PTY child-PID ancestry intersection.
// - Tracks tabs running opencode for session restore after a Tabby restart.
//
// Child PIDs come from the local PTY (`session.pty.getChildProcesses()`),
// feature-detected at runtime: SSH/serial tabs simply never match.
import { Injectable, Injector } from "@angular/core"
import { AppService, BaseTabComponent, ConfigService, SplitTabComponent } from "terminus-core"
import { BaseTerminalTabComponent } from "terminus-terminal"
import fs from "fs"
import os from "os"
import path from "path"
import type { TerminalService } from "tabby-local"
import { StatusFileService, ParsedStatus } from "../services/statusFileService"
import { OpencodeStatusDecorator, TabLike } from "../decorator/opencodeStatusDecorator"
import { DEFAULT_CONFIG, TabbyOpencodeStatusConfig } from "../interfaces/types"
import { OpencodeSessionRecord, SessionTracker } from "./sessionTracker"

const OPENCODE_RE = /(^|[/\\])opencode(\s|$)/

const DEBUG_FILE = path.join(os.tmpdir(), "tabby-opencode-status.debug.json")

interface RouteRecord {
  ts: number
  status: string
  ancestors: number[]
  hits: string[]
}

const ROUTE_LOG: RouteRecord[] = []

// Best-effort diagnostics: after a restart this file shows what the bridge
// discovered, which pids each tab matched, and how spool events routed.
function debugLog(entry: Record<string, unknown>): void {
  try {
    let prev: Record<string, unknown> = {}
    try {
      prev = JSON.parse(fs.readFileSync(DEBUG_FILE, "utf8"))
    } catch {
      // first write
    }
    fs.writeFileSync(DEBUG_FILE, JSON.stringify({ ...prev, ...entry, ts: Date.now() }, null, 2))
  } catch {
    // diagnostics are best-effort
  }
}

interface TrackedTab {
  terminal: BaseTerminalTabComponent
  adapter: TabLike
  disposeAdapter: () => void
  procs: Map<number, string>
}

export interface PluginConfig extends TabbyOpencodeStatusConfig {
  spoolDir: string
  pollMs: number
  autoResume: boolean
  resumeCommand: string
  sessions: OpencodeSessionRecord[]
}

@Injectable()
export class OpencodeStatusBridge {
  private spool: StatusFileService | null = null
  private decorator = new OpencodeStatusDecorator({ ...DEFAULT_CONFIG })
  private tracker = new SessionTracker()
  private tracked = new Map<BaseTabComponent, TrackedTab>()
  private timer: ReturnType<typeof setInterval> | null = null
  private configSub: { unsubscribe(): void } | null = null
  private lastConfigKey = ""
  private tickCount = 0
  private resumed = false
  private trackerDirty = false
  private terminalSvc: unknown = undefined

  constructor(
    private app: AppService,
    private config: ConfigService,
    private injector: Injector,
  ) {}

  start(): void {
    this.stop()
    this.decorator = new OpencodeStatusDecorator(this.pluginConfig())
    const cfg = this.pluginConfig()
    this.spool = new StatusFileService(cfg.spoolDir || undefined, cfg.pollMs)
    this.tracker.load(this.config.store?.opencodeStatus?.sessions ?? null)
    this.timer = setInterval(() => {
      this.tick().catch(() => {})
    }, cfg.pollMs)
    // Settings toggles call config.save() -> changed$; re-apply live instead of
    // requiring a Tabby reload for the new flags to take effect.
    try {
      const changed = (this.config as unknown as { changed$?: { subscribe(cb: () => void): { unsubscribe(): void } } }).changed$
      this.configSub = changed?.subscribe(() => this.onConfigChanged()) ?? null
    } catch {
      this.configSub = null
    }
    debugLog({
      started: true,
      pollMs: cfg.pollMs,
      showTabColor: cfg.showTabColor,
      showTitleEmoji: cfg.showTitleEmoji,
      showProgress: cfg.showProgress,
      showActivityDot: cfg.showActivityDot,
      colors: cfg.colors,
      emoji: cfg.emoji,
    })
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try {
      this.configSub?.unsubscribe()
    } catch {
      // ignore
    }
    this.configSub = null
    for (const tab of [...this.tracked.keys()]) this.detach(tab)
  }

  private onConfigChanged(): void {
    this.syncConfig()
  }

  // Re-read the live config. The plugin starts before ConfigService has
  // finished loading the store, and settings can change later — so sync on
  // every tick (cheap key compare) instead of snapshotting once in start().
  private syncConfig(): void {
    const cfg = this.pluginConfig()
    const key = JSON.stringify([
      cfg.showTabColor,
      cfg.showTitleEmoji,
      cfg.showProgress,
      cfg.showActivityDot,
      cfg.colors,
      cfg.emoji,
    ])
    if (key === this.lastConfigKey) return
    this.lastConfigKey = key
    this.decorator.setConfig(cfg)
    this.decorator.reapply()
    debugLog({
      configSynced: true,
      showTabColor: cfg.showTabColor,
      showTitleEmoji: cfg.showTitleEmoji,
      showProgress: cfg.showProgress,
      showActivityDot: cfg.showActivityDot,
    })
  }

  // -- session restore API (used by the settings tab) --

  getSessions(): OpencodeSessionRecord[] {
    return this.tracker.list()
  }

  forgetSession(cwd: string): void {
    this.tracker.forget(cwd)
    this.saveTracker()
  }

  async resumeSession(rec: OpencodeSessionRecord): Promise<void> {
    await this.openRecord(rec, this.pluginConfig().resumeCommand)
  }

  async resumeAllSessions(): Promise<void> {
    const cmd = this.pluginConfig().resumeCommand
    for (const rec of this.tracker.list()) await this.openRecord(rec, cmd)
  }

  // -- internals --

  private pluginConfig(): PluginConfig {
    const store = (this.config.store?.opencodeStatus ?? {}) as Partial<PluginConfig>
    return {
      ...DEFAULT_CONFIG,
      spoolDir: "",
      pollMs: 3000,
      autoResume: false,
      resumeCommand: "opencode --continue",
      sessions: [],
      ...store,
      // Nested maps merge over the defaults: an empty/partial `colors` or
      // `emoji` object in the user config must not blank out the defaults
      // (a shallow spread would leave `colors[status]` undefined).
      colors: { ...DEFAULT_CONFIG.colors, ...(store.colors ?? {}) },
      emoji: { ...DEFAULT_CONFIG.emoji, ...(store.emoji ?? {}) },
    }
  }

  private async tick(): Promise<void> {
    this.tickCount++
    this.syncConfig()
    this.discover()
    debugLog({ tick: this.tickCount, tabs: this.allTabs().length, trackedCount: this.tracked.size })
    if (this.tickCount % 10 === 1) await this.refreshProcs()
    this.spool?.drain((s) => this.route(s))
    if (!this.resumed) {
      this.resumed = true
      if (this.pluginConfig().autoResume) await this.resumeAllSessions()
    }
    if (this.trackerDirty && this.tickCount % 10 === 0) this.saveTracker()
  }

  private allTabs(): BaseTabComponent[] {
    const out: BaseTabComponent[] = []
    for (const t of this.app.tabs ?? []) {
      if (t instanceof SplitTabComponent) out.push(...t.getAllTabs())
      else out.push(t)
    }
    return out
  }

  private discover(): void {
    const seen = new Set<BaseTabComponent>()
    for (const tab of this.allTabs()) {
      seen.add(tab)
      if (this.tracked.has(tab) || !(tab instanceof BaseTerminalTabComponent)) continue
      const { like, dispose } = this.adapt(tab)
      this.decorator.attachTab(like, 0)
      this.tracked.set(tab, { terminal: tab, adapter: like, disposeAdapter: dispose, procs: new Map() })
      tab.destroyed$.subscribe(() => this.detach(tab))
      ;(tab as unknown as { sessionChanged$?: { subscribe(cb: () => void): unknown } }).sessionChanged$?.subscribe(() => {
        this.refreshTab(tab).catch(() => {})
      })
    }
    for (const tab of [...this.tracked.keys()]) {
      if (!seen.has(tab)) this.detach(tab)
    }
  }

  private detach(tab: BaseTabComponent): void {
    const t = this.tracked.get(tab)
    if (!t) return
    this.decorator.clear(t.adapter)
    t.disposeAdapter()
    this.tracked.delete(tab)
  }

  private adapt(tab: BaseTabComponent): { like: TabLike; dispose: () => void } {
    const sub = tab.titleChange$.subscribe((title) => cb?.(title))
    let cb: ((title: string) => void) | null = null
    const like: TabLike = {
      get color() {
        return tab.color
      },
      set color(v) {
        tab.color = v
      },
      get title() {
        return tab.title
      },
      setProgress: (p) => tab.setProgress(p),
      setTitle: (t) => tab.setTitle(t),
      displayActivity: () => tab.displayActivity(),
      clearActivity: () => tab.clearActivity(),
      onTitleFromTerminal: (fn) => {
        cb = fn
      },
    }
    return { like, dispose: () => sub.unsubscribe() }
  }

  private async childProcs(tab: BaseTerminalTabComponent): Promise<Map<number, string>> {
    const out = new Map<number, string>()
    try {
      const pty = (tab as unknown as {
        session?: {
          pty?: {
            getChildProcesses?: () => Promise<Array<{ pid: number; command: string }>>
            getTruePID?: () => Promise<number>
          }
        }
      }).session?.pty
      const kids = await pty?.getChildProcesses?.()
      for (const k of kids ?? []) {
        // ps-node returns pids as strings on Linux — coerce so Map lookups by
        // number (spool ancestors) actually match.
        const pid = typeof k?.pid === "number" ? k.pid : parseInt(String(k?.pid ?? ""), 10)
        if (Number.isFinite(pid)) out.set(pid, k.command || "")
      }
      // The pty's "true PID" resolves through single-child chains, so it can
      // land on the running command (e.g. opencode) instead of the shell — in
      // that case getChildProcesses() is empty and no spool ancestor matches.
      // Include the true PID itself so ancestry intersection still works.
      const rawTruePid = await pty?.getTruePID?.()
      const truePid = typeof rawTruePid === "number" ? rawTruePid : parseInt(String(rawTruePid ?? ""), 10)
      if (Number.isFinite(truePid) && !out.has(truePid)) {
        out.set(truePid, await this.commandOf(truePid))
      }
    } catch {
      // SSH/serial/starting tabs: no match, no crash
    }
    return out
  }

  private async commandOf(pid: number): Promise<string> {
    try {
      const raw = await fs.promises.readFile(`/proc/${pid}/cmdline`, "utf8")
      return raw.split("\u0000")[0] || ""
    } catch {
      return ""
    }
  }

  private async refreshProcs(): Promise<void> {
    for (const [tab, t] of this.tracked) {
      t.procs = await this.childProcs(t.terminal)
      await this.trackTab(tab, t)
    }
    debugLog({
      tracked: [...this.tracked.values()].map((t) => ({
        title: (t.terminal as unknown as { title?: string }).title ?? "",
        procs: [...t.procs.entries()].map(([pid, cmd]) => `${pid}:${cmd}`),
      })),
    })
  }

  private async refreshTab(tab: BaseTabComponent): Promise<void> {
    const t = this.tracked.get(tab)
    if (!t) return
    t.procs = await this.childProcs(t.terminal)
    await this.trackTab(tab, t)
  }

  private async trackTab(tab: BaseTabComponent, t: TrackedTab): Promise<void> {
    if (![...t.procs.values()].some((cmd) => OPENCODE_RE.test(cmd))) return
    let cwd = ""
    try {
      cwd = (await (t.terminal as unknown as { session?: { getWorkingDirectory?: () => Promise<string | null> } }).session?.getWorkingDirectory?.()) || ""
    } catch {
      // ignore
    }
    if (!cwd) return
    this.tracker.note(cwd, tab.title)
    this.trackerDirty = true
  }

  // Returns true when the event was applied to at least one tab in THIS window
  // (the spool file may then be consumed; unrouted files stay for other windows).
  private route(s: ParsedStatus): boolean {
    // Compare as strings: spool ancestors are JSON numbers while pids coming
    // from ps-node/Tabby may be strings (or vice versa).
    const ancestors = new Set(s.ancestors.map((a) => String(a)))
    const hits: string[] = []
    for (const t of this.tracked.values()) {
      if ([...t.procs.keys()].some((pid) => ancestors.has(String(pid)))) {
        hits.push((t.terminal as unknown as { title?: string }).title ?? "")
        this.decorator.apply(t.adapter, s.status)
      }
    }
    ROUTE_LOG.push({ ts: Date.now(), status: s.status, ancestors: s.ancestors, hits })
    if (ROUTE_LOG.length > 20) ROUTE_LOG.shift()
    debugLog({ lastRoute: { status: s.status, ancestors: s.ancestors, hits }, routes: ROUTE_LOG })
    return hits.length > 0
  }

  private saveTracker(): void {
    this.trackerDirty = false
    this.config.store ??= {}
    if (!this.config.store.opencodeStatus) this.config.store.opencodeStatus = {}
    this.config.store.opencodeStatus.sessions = this.tracker.list()
    this.config.save()
  }

  // Resolve tabby-local's TerminalService lazily and defensively: community
  // plugins are only guaranteed terminus-*/@angular externals, so a static
  // import could kill the whole bundle at load time. Property access keeps
  // webpack from treating this as a build-time dependency.
  private getTerminalService(): unknown {
    if (this.terminalSvc !== undefined) return this.terminalSvc
    this.terminalSvc = null
    try {
      const nodeRequire = (globalThis as unknown as { require?: (id: string) => unknown }).require
      const mod = nodeRequire?.("tabby-local") as { TerminalService?: unknown } | undefined
      const Cls = mod?.TerminalService
      if (Cls) {
        try {
          this.terminalSvc = (this.injector as unknown as { get(t: unknown, notFound: unknown): unknown }).get(Cls, null)
        } catch {
          // no provider: resume stays disabled
        }
      }
    } catch {
      // unresolvable: resume stays disabled
    }
    return this.terminalSvc
  }

  private async openRecord(rec: OpencodeSessionRecord, command: string): Promise<void> {
    const terminal = this.getTerminalService() as Pick<TerminalService, "openTab"> | null
    if (!terminal) return // tabby-local not resolvable here: resume unavailable, colors unaffected
    let tab: unknown = null
    try {
      tab = await terminal.openTab(undefined, rec.cwd)
    } catch {
      return
    }
    for (let i = 0; i < 40; i++) {
      const session = (tab as { session?: unknown } | null)?.session
      if (session) break
      await new Promise((r) => setTimeout(r, 250))
    }
    try {
      await (tab as { sendInput?: (data: string) => unknown }).sendInput?.(`${command}\n`)
    } catch {
      // tab may have been closed already
    }
  }
}
