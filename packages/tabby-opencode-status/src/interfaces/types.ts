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
