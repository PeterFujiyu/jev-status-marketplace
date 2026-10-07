/** Where the user's task stands at the end of the turn. */
export type Status = 'done' | 'needaction' | 'failed'

/** Whether the turn's work may go straight to an environment. */
export type Deploy = 'production' | 'development' | 'nodeploy' | 'nochange'

/** The two evaluations made after each turn. */
export type Question = 'status' | 'deploy'

/** One evaluation's answer, who gave it, or why there is none. */
export type Answer<C extends string = string> = {
  choice: C | 'nokey' | 'error'
  /** Who gave `choice`: Jev, or Claude when Jev was unsure or could not answer. */
  source: 'jev' | 'claude'
  /** What Claude read: the summary Jev read, or the whole session. */
  via?: 'summary' | 'conversation'
  /** Jev's confidence in its own answer, 0–1. */
  confidence?: number
  /** Why Jev gave no answer (`HTTP 401`, `no key`), when Claude stood in or none did. */
  error?: string
}

/** The verdict on the last turn; `deploy` is absent when that check is off. */
export type Verdict = { status: Answer<Status>; deploy?: Answer<Deploy> }

/** running: a turn is in progress; checking: it ended and no verdict is in yet. */
export type Phase = 'idle' | 'running' | 'checking'

declare module 'claude-code' {
  interface PluginState {
    'jev-status': { verdict: Verdict | null; phase: Phase }
  }
}
