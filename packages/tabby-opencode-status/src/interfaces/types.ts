// Shared shapes for tabby-opencode-status. Framework-free so the mapping
// logic stays unit-testable outside Tabby.

export type OpencodeStatus = "working" | "question" | "done" | "error" | "idle"

// One spool file written by the opencode plugin (opencode-tabby-status),
// compatible with the tabby-claude-status spool format.
export interface SpoolEvent {
  ts: number
  event: string
  session: string
  ppid: number
  ancestors: number[]
  cwd?: string
  title?: string
}

export interface TabbyOpencodeStatusConfig {
  colors: Record<Exclude<OpencodeStatus, "idle">, string>
  emoji: Record<OpencodeStatus, string>
  showTabColor: boolean
  showTitleEmoji: boolean
  showProgress: boolean
  showActivityDot: boolean
  spoolDir: string
  pollMs: number
}

export const DEFAULT_CONFIG: TabbyOpencodeStatusConfig = {
  colors: {
    working: "#ffa500",
    question: "#ffd700",
    done: "#50c878",
    error: "#ff5050",
  },
  emoji: {
    working: "⚡",
    question: "❓",
    done: "✅",
    error: "❌",
    idle: "🌱",
  },
  showTabColor: true,
  showTitleEmoji: false,
  showProgress: false,
  showActivityDot: false,
  spoolDir: "",
  pollMs: 3000,
}

// Matches the opencode CLI itself (not a command it happens to run, e.g.
// `git`), so child-process ancestry can be checked without spawning `ps`.
export const OPENCODE_CMD_RE = /(^|[/\\])opencode(\s|$)/

// True when any of the given process commands is the opencode CLI.
export function hasOpencodeProcess(procs: Iterable<string>): boolean {
  for (const cmd of procs) if (OPENCODE_CMD_RE.test(cmd)) return true
  return false
}

// The opencode TUI sets its terminal title to `OC | <session title>`
// (truncated to 40 chars with a trailing ellipsis); Tabby tabs carry that
// title plus an optional status-emoji prefix. Used to route events to the
// right tab when several TUIs share one cwd / process ancestry.
export function titleMatchesSession(tabTitle: string, sessionTitle: string): boolean {
  if (!sessionTitle) return false
  const prefix = "OC | "
  if (!tabTitle.startsWith(prefix)) return false
  const shown = tabTitle.slice(prefix.length)
  if (shown === sessionTitle) return true
  return shown.endsWith("…") && sessionTitle.startsWith(shown.slice(0, -1))
}

// Picks which tabs a spooled status belongs to. A title match among the
// ancestry candidates wins; a unique title-only match (e.g. a session whose
// directory moved) beats the ancestry candidates. Ambiguous events — no
// title, no match, or several tabs sharing the title — fall back to the
// ancestry candidates only when exactly one is involved; otherwise they are
// dropped rather than broadcast, so one session's status can never paint
// unrelated tabs that merely share a directory.
export function chooseTabs<T>(
  all: T[],
  candidates: T[],
  sessionTitle: string,
  baseTitleOf: (t: T) => string,
): T[] {
  const onlyCandidate = () => (candidates.length === 1 ? candidates : [])
  if (!sessionTitle) return onlyCandidate()
  const byTitle = all.filter((t) => titleMatchesSession(baseTitleOf(t), sessionTitle))
  if (!byTitle.length) return onlyCandidate()
  const both = byTitle.filter((t) => candidates.includes(t))
  if (both.length) return both
  if (byTitle.length === 1) return byTitle
  return onlyCandidate()
}

// chooseTabs plus a session -> tab memory. Titled events are routed as usual
// and (when unambiguous) remembered; title-less events — spool files written
// by cold or duplicate plugin instances — reuse the remembered tab instead of
// broadcasting to every ancestry candidate sharing the directory. Ambiguous
// events also fall back to the remembered tab when one is known. `all` must be
// the currently tracked tabs so stale entries are ignored.
export function chooseTabsForSession<T>(
  all: T[],
  candidates: T[],
  session: string,
  sessionTitle: string,
  baseTitleOf: (t: T) => string,
  memory: Map<string, T>,
): T[] {
  const remembered = session ? memory.get(session) : undefined
  const canRemember =
    remembered !== undefined &&
    all.includes(remembered) &&
    (candidates.length === 0 || candidates.includes(remembered))
  if (sessionTitle) {
    const chosen = chooseTabs(all, candidates, sessionTitle, baseTitleOf)
    if (session && chosen.length === 1) {
      memory.set(session, chosen[0])
      return chosen
    }
    // Ambiguous titled event (e.g. the tab title is momentarily stale after a
    // rename): prefer the tab this session was routed to before.
    if (chosen.length === 0 && canRemember) return [remembered as T]
    return chosen
  }
  if (canRemember) return [remembered as T]
  return candidates.length === 1 ? candidates : []
}

// Claude-hook names (also emitted by opencode-tabby-status) -> tab state.
export function statusForEvent(event: string): OpencodeStatus {
  switch (event) {
    case "PreToolUse":
    case "PostToolUse":
    case "UserPromptSubmit":
      return "working"
    case "Notification":
    case "PermissionRequest":
      return "question"
    case "Stop":
      return "done"
    case "PostToolUseFailure":
      return "error"
    default:
      return "idle"
  }
}
