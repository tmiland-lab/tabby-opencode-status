// Spool watcher: polls the status dir written by opencode-tabby-status,
// reads each event file (atomic temp+rename on the writer side) and hands
// parsed { status, ancestors } to a callback. A file is consumed only when the
// callback reports it was routed — multiple Tabby windows can share one spool
// dir, and an unrouted file must stay readable for the window that owns the
// tab. Unrouted files are swept once stale so they cannot accumulate.
// Plain TypeScript, no Angular imports — runs under plain node for tests.
import fs from "fs"
import os from "os"
import path from "path"
import { statusForEvent, OpencodeStatus, SpoolEvent } from "../interfaces/types"

/** Unrouted spool files older than this are discarded (no window wanted them). */
const UNROUTED_TTL_MS = 15_000

export interface ParsedStatus {
  status: OpencodeStatus
  session: string
  ancestors: number[]
  cwd: string
}

export function parseSpoolFile(raw: string): ParsedStatus | null {
  try {
    const s = JSON.parse(raw) as SpoolEvent
    if (!s.event || !Array.isArray(s.ancestors)) return null
    return {
      status: statusForEvent(s.event),
      session: s.session || "",
      ancestors: s.ancestors,
      cwd: s.cwd || "",
    }
  } catch {
    return null
  }
}

export class StatusFileService {
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(
    private spoolDir: string = path.join(os.tmpdir(), "tabby-claude-status.d"),
    private pollMs = 500,
  ) {}

  start(onStatus: (s: ParsedStatus) => boolean | void): void {
    this.stop()
    this.timer = setInterval(() => this.drain(onStatus), this.pollMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  drain(onStatus: (s: ParsedStatus) => boolean | void): void {
    let files: string[]
    try {
      files = fs.readdirSync(this.spoolDir)
    } catch {
      return
    }
    for (const f of files) {
      if (!f.endsWith(".json")) continue
      const full = path.join(this.spoolDir, f)
      let raw: string
      try {
        raw = fs.readFileSync(full, "utf8")
      } catch {
        continue
      }
      let routed = false
      const parsed = parseSpoolFile(raw)
      if (parsed) {
        try {
          routed = onStatus(parsed) === true
        } catch {
          routed = false
        }
      }
      // Malformed files can never be routed by anyone — drop immediately.
      let stale = parsed === null
      if (!stale) {
        try {
          stale = Date.now() - fs.statSync(full).mtimeMs > UNROUTED_TTL_MS
        } catch {
          stale = true
        }
      }
      if (routed || stale) {
        try {
          fs.rmSync(full)
        } catch {
          // already gone
        }
      }
    }
  }
}
