export type Status = 'done' | 'needaction' | 'failed'

/** The verdict on the last turn, who gave it, or why there is none. */
export type Verdict = {
  status: Status | 'nokey' | 'error'
  /** Who gave `status`: Jev, or Claude when Jev was unsure or could not answer. */
  source: 'jev' | 'claude'
  /** Jev's confidence in its own answer, 0–1. */
  confidence?: number
  /** Why Jev gave no answer (`HTTP 401`, `no key`), when Claude stood in or none did. */
  error?: string
}

/** running: a turn is in progress; checking: it ended and no verdict is in yet. */
export type Phase = 'idle' | 'running' | 'checking'

declare module 'claude-code' {
  interface PluginState {
    'jev-status': { verdict: Verdict | null; phase: Phase }
  }
}
