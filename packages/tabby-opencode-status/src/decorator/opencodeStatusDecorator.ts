// Tab decorator: applies an opencode status to a Tabby tab.
// Depends only on the structural TabLike surface (a subset of Tabby's
// BaseTabComponent), so the status logic is testable without Tabby.
// Wiring to real Tabby services (tab registry, per-tab PTY pids) happens in
// opencodeStatusModule.ts — see the TODOs there.
import { OpencodeStatus, TabbyOpencodeStatusConfig } from "../interfaces/types"

// Subset of Tabby's BaseTabComponent used here:
//   color <-> string|null, setProgress(n: number|null), setTitle(t),
//   displayActivity(), clearActivity(), titleChange$ observable.
export interface TabLike {
  color: string | null
  title: string
  setProgress(p: number | null): void
  setTitle(t: string): void
  displayActivity(): void
  clearActivity(): void
  onTitleFromTerminal(cb: (title: string) => void): void
}

export class OpencodeStatusDecorator {
  // ptyPid per tab, supplied by the Tabby wiring (tabby-local session pid).
  private tabs = new Map<TabLike, { ptyPid: number; baseTitle: string; emoji: string; status: OpencodeStatus | null }>()
  // pid -> tabs whose ancestry contains it, rebuilt on attach.
  private pidIndex = new Map<number, Set<TabLike>>()

  constructor(private config: TabbyOpencodeStatusConfig) {}

  // Swap in a fresh config snapshot (settings toggles) and re-apply the last
  // status so changes take effect without reloading Tabby.
  setConfig(config: TabbyOpencodeStatusConfig): void {
    this.config = config
  }

  reapply(): void {
    for (const [tab, rec] of this.tabs) {
      if (rec.status) this.apply(tab, rec.status)
    }
  }

  attachTab(tab: TabLike, ptyPid: number): void {
    this.tabs.set(tab, { ptyPid, baseTitle: this.stripEmoji(tab.title), emoji: "", status: null })
    // NB: Tabby's titleChange$ also fires for OUR setTitle calls, so the
    // callback must be a no-op when the title already has the wanted prefix —
    // otherwise setTitle -> emit -> setTitle loops forever.
    tab.onTitleFromTerminal((title) => {
      const rec = this.tabs.get(tab)
      if (!rec) return
      const base = this.stripEmoji(title)
      const want = rec.emoji ? `${rec.emoji} ${rec.baseTitle}` : rec.baseTitle
      if (base !== rec.baseTitle) {
        rec.baseTitle = base
        if (rec.emoji) tab.setTitle(`${rec.emoji} ${base}`)
      } else if (rec.emoji && title !== want) {
        tab.setTitle(want)
      }
    })
  }

  detachTab(tab: TabLike): void {
    this.clear(tab)
    this.tabs.delete(tab)
    this.rebuildIndex()
  }

  registerPid(pid: number, tab: TabLike): void {
    let set = this.pidIndex.get(pid)
    if (!set) this.pidIndex.set(pid, (set = new Set()))
    set.add(tab)
  }

  rebuildIndex(): void {
    this.pidIndex.clear()
  }

  // Route one parsed spool event to every tab whose ancestry intersects.
  // ancestorsOf resolves the full parent chain for a pid on this platform.
  route(
    status: OpencodeStatus,
    ancestors: number[],
    ancestorsOf: (pid: number) => number[],
  ): void {
    for (const [tab, rec] of this.tabs) {
      const chain = new Set([rec.ptyPid, ...ancestorsOf(rec.ptyPid)])
      if (ancestors.some((a) => chain.has(a))) this.apply(tab, status)
    }
  }

  apply(tab: TabLike, status: OpencodeStatus): void {
    const rec = this.tabs.get(tab)
    if (!rec) return
    rec.status = status
    const c = this.config
    tab.color = c.showTabColor && status !== "idle" ? c.colors[status] : null
    tab.setProgress(c.showProgress && status === "working" ? 0.5 : null)
    if (c.showActivityDot && (status === "question" || status === "error")) tab.displayActivity()
    else tab.clearActivity()
    rec.emoji = c.showTitleEmoji ? c.emoji[status] : ""
    tab.setTitle(rec.emoji ? `${rec.emoji} ${rec.baseTitle}` : rec.baseTitle)
  }

  clear(tab: TabLike): void {
    const rec = this.tabs.get(tab)
    tab.color = null
    tab.setProgress(null)
    tab.clearActivity()
    if (rec) {
      rec.emoji = ""
      tab.setTitle(rec.baseTitle)
    }
  }

  // Strip a known status-emoji prefix. Matched against the configured values
  // (not a char-class regex: astral emoji like 🌱 need the `u` flag to match
  // as whole code points, and config-driven matching stays correct if the
  // emoji set ever changes). Only strips when followed by a separator.
  private stripEmoji(title: string): string {
    for (const e of Object.values(this.config.emoji)) {
      if (!e) continue
      if (title === e) return ""
      if (title.startsWith(e)) {
        const rest = title.slice(e.length)
        const sep = /^[\uFE0F\s]+/u.exec(rest)
        if (sep) return rest.slice(sep[0].length)
      }
    }
    return title
  }
}
