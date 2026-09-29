// Framework-free record of tabs running opencode, for session restore.
// Persisted via the Tabby config store (opencodeStatus.sessions), executed by
// the bridge (bridge.service.ts) which reopens tabs after a Tabby restart.

export interface OpencodeSessionRecord {
  cwd: string
  title: string
  lastSeen: number
}

export class SessionTracker {
  private records = new Map<string, OpencodeSessionRecord>()

  note(cwd: string, title: string, now = Date.now()): void {
    if (!cwd) return
    this.records.set(cwd, { cwd, title: title || cwd, lastSeen: now })
  }

  forget(cwd: string): void {
    this.records.delete(cwd)
  }

  list(): OpencodeSessionRecord[] {
    return [...this.records.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  prune(maxAgeMs: number, now = Date.now()): void {
    for (const [key, rec] of this.records) {
      if (now - rec.lastSeen > maxAgeMs) this.records.delete(key)
    }
  }

  serialize(): string {
    return JSON.stringify(this.list())
  }

  load(raw: unknown): void {
    this.records.clear()
    if (typeof raw === "string") {
      try {
        this.loadParsed(JSON.parse(raw))
      } catch {
        // keep empty
      }
      return
    }
    this.loadParsed(raw)
  }

  private loadParsed(raw: unknown): void {
    if (!Array.isArray(raw)) return
    for (const r of raw) {
      if (r && typeof r.cwd === "string" && r.cwd) {
        this.records.set(r.cwd, {
          cwd: r.cwd,
          title: typeof r.title === "string" ? r.title : r.cwd,
          lastSeen: typeof r.lastSeen === "number" ? r.lastSeen : 0,
        })
      }
    }
  }
}
