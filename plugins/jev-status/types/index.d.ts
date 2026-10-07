/** Jev's verdict on the last turn, or why there is none. */
export type Verdict = {
  status: 'done' | 'needaction' | 'failed' | 'nokey' | 'error'
  confidence?: number
  error?: string
}

/** running: a turn is in progress; checking: it ended and Jev has not answered yet. */
export type Phase = 'idle' | 'running' | 'checking'

declare module 'claude-code' {
  interface PluginState {
    'jev-status': { verdict: Verdict | null; phase: Phase }
  }
}
