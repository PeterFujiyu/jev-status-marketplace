/** Where the user's task stands at the end of the turn. Says nothing about delivery. */
export type Status = 'done' | 'needaction' | 'failed'

/**
 * The highest safe delivery level for the session's current active work, which
 * may come from earlier turns. Says nothing about whether the user is needed.
 */
export type Ship = 'production' | 'development' | 'blocked' | 'na'

/**
 * Whether the verification the session's active work needs is all done. An
 * internal gate on ship's production answer; never drawn as a row of its own.
 */
export type Verification = 'complete' | 'incomplete' | 'unknown'

/** The evaluations made after each turn (`status` is the task row; `verification` gates ship). */
export type Question = 'status' | 'ship' | 'verification'

/** A verification the plugin can see the agent run. */
export type Check = 'tests' | 'build' | 'typecheck' | 'lint'

/** What the plugin itself saw of a check this turn; never taken from the agent's own words. */
export type Observed = 'passed' | 'failed' | 'unknown'

/** One evaluation's answer, who gave it, or why there is none. */
export type Answer<C extends string = string> = {
  /**
   * The choice; `nokey` and `error` when Jev gave none, and for ship only,
   * `review`: the plugin's own fail-closed state when no one could settle it.
   */
  choice: C | 'nokey' | 'error'
  /** Who gave `choice`: Jev, or Claude when Jev was unsure or could not answer. */
  source: 'jev' | 'claude'
  /** What Claude read: the summary Jev read, or the session context (as Claude Code holds it, possibly compacted). */
  via?: 'summary' | 'conversation'
  /** Jev's confidence in its own answer, 0–1. */
  confidence?: number
  /** Why Jev gave no answer (`HTTP 401`, `no key`), when Claude stood in or none did. */
  error?: string
  /** For `review`: the answer that was not trusted, and by whom. */
  suggested?: { choice: string; by: 'jev' | 'claude'; confidence?: number }
  /**
   * Why the answer is not what was suggested: for `review`, why it was not trusted, when not low
   * confidence; for a ship answer the verification gate lowered, why (`production gated: …`).
   */
  note?: string
}

/** The verdict on the last turn; `ship` and `verification` are absent when that check is off. */
export type Verdict = {
  status: Answer<Status>
  ship?: Answer<Ship | 'review'>
  verification?: Answer<Verification | 'review'>
}

/** running: a turn is in progress; checking: it ended and no verdict is in yet. */
export type Phase = 'idle' | 'running' | 'checking'

declare module 'claude-code' {
  interface PluginState {
    'jev-status': { verdict: Verdict | null; phase: Phase }
  }
}
