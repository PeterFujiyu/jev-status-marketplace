import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase, Status, Verdict } from '../types'

// After each turn, asks TypeSafe Jev whether the user's task is done, waiting
// on the user, or failed, and draws the answer above the prompt. When Jev is
// unsure (or can't answer), asks Claude for a second opinion and shows that.
// Sent to TypeSafe per turn: the user's prompt, Claude's final answer and up to
// three tool errors from that turn. Nothing else.

const verdict = atom({ plugin: 'jev-status', key: 'verdict' } as const, null)
const phase = atom({ plugin: 'jev-status', key: 'phase' } as const, 'idle')

const API_URL = 'https://api.typesafe.ai/v1/systemone'
const GIVE_UP_MS = 120_000
const CLAUDE_TIMEOUT_MS = 45_000
const MAX_PROMPT_CHARS = 2000
const MAX_ANSWER_CHARS = 4000
const MAX_ERRORS = 3
const MAX_ERROR_CHARS = 300

const CRITERIA: Record<Status, string> = {
  done: 'The agent finished what was asked and reports the result; nothing is required from the user.',
  needaction:
    'The agent stopped to wait for the user: it asks a question, needs a decision, approval, ' +
    'credentials, or a manual step the user must do before work can continue.',
  failed:
    'The agent could not complete the task: it hit errors it did not resolve, gave up, ' +
    'or reports that the result does not work.',
}

const QUESTION = {
  type: 'choice',
  instructions:
    '`state` is the end of one turn of an AI coding agent. `user_request` is what the user asked, ' +
    "`agent_final_message` is the agent's last message before it stopped, and `tool_errors` are " +
    "errors from tools it ran during the turn. What is the status of the user's task now?",
  criteria: CRITERIA,
}

const RUBRIC = (Object.keys(CRITERIA) as Status[]).map(s => `${s}: ${CRITERIA[s]}`).join('\n')

const REVIEW_SYSTEM =
  "You judge the status of a user's task at the end of one turn of an AI coding agent. " +
  'Reply with exactly one word: done, needaction or failed, or unclear when what you are ' +
  'given is not enough to tell.\n\n' +
  RUBRIC

const FORK_PROMPT =
  "Step outside the conversation for a moment. Judge the status of the user's task as of your " +
  'last message. Reply with exactly one word: done, needaction or failed.\n\n' +
  RUBRIC

// `label` is drawn in color above the prompt; `words` is the plain text for a
// toast, which shows no color and already carries the plugin's name.
const LOOK: Record<Verdict['status'], { color?: string; label: string; words: string }> = {
  done: { color: 'green', label: '✔ done', words: 'done' },
  needaction: { color: 'yellow', label: '● needs action', words: 'needs action' },
  failed: { color: 'red', label: '✘ failed', words: 'failed' },
  nokey: { label: 'no TypeSafe API key (set it in /plugin)', words: 'no TypeSafe API key' },
  error: { label: 'Jev error', words: 'Jev error' },
}

type Turn = { prompt: string; answer: string; errors: string[] }

type ClaudeView = 'summary' | 'summary-then-conversation' | 'conversation'

type Settings = {
  apiKey: unknown
  claudeBelow: number
  claudeView: ClaudeView
  reviewModel: string
  claudeOnJevFailure: boolean
}

const VIEWS: readonly ClaudeView[] = ['summary', 'summary-then-conversation', 'conversation']

const pct = (n: number) => `${Math.round(n * 100)}%`

/** What the verdict says beyond its status: its confidence, or who answered and why. */
function detail(v: Verdict): string {
  if (v.source === 'claude') {
    const who = v.via === 'conversation' ? 'Claude, full session' : 'Claude'
    return ` · ${who} (${typeof v.confidence === 'number' ? `Jev ${pct(v.confidence)}` : (v.error ?? 'Jev unsure')})`
  }
  if (typeof v.confidence === 'number') return ` ${pct(v.confidence)}`
  return v.status === 'error' && v.error ? ` (${v.error})` : ''
}

/** A one-word judgement: a status, `unclear` when the reviewer could not tell, or undefined. */
function parseStatus(text: string): Status | 'unclear' | undefined {
  const word = text.toLowerCase().replace(/[^a-z ]/g, ' ')
  if (/\bunclear\b/.test(word)) return 'unclear'
  if (/\bneed(s)? ?action\b/.test(word)) return 'needaction'
  if (/\bfailed\b/.test(word)) return 'failed'
  if (/\bdone\b/.test(word)) return 'done'
  return undefined
}

async function apiKey($: EngineInterface, configured: unknown): Promise<string> {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  const fromEnv = await $.env.get('TYPESAFE_API_KEY')
  if (fromEnv?.trim()) return fromEnv.trim()
  const path = `${await $.env.get('HOME')}/.config/typesafe/api_key`
  return (await $.fs.exists(path)) ? (await $.fs.read(path)).trim() : ''
}

async function askJev($: EngineInterface, key: string, turn: Turn): Promise<Verdict> {
  const res = await $.http.fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: { user_request: turn.prompt, agent_final_message: turn.answer, tool_errors: turn.errors },
      questions: { status: QUESTION },
    }),
  })
  if (!res.ok) return { status: 'error', source: 'jev', error: `HTTP ${res.status}` }
  const answer = JSON.parse(res.text)?.answers?.status
  if (!['done', 'needaction', 'failed'].includes(answer?.choice)) {
    return { status: 'error', source: 'jev', error: 'unexpected response' }
  }
  return { status: answer.choice, source: 'jev', confidence: answer.confidence }
}

/** The review model's judgement from what Jev read. */
async function reviewSummary($: EngineInterface, s: Settings, turn: Turn) {
  const reply = await $.model.complete({
    model: s.reviewModel,
    system: REVIEW_SYSTEM,
    prompt: JSON.stringify({ user_request: turn.prompt, agent_final_message: turn.answer, tool_errors: turn.errors }),
    maxTokens: 16,
    timeoutMs: CLAUDE_TIMEOUT_MS,
  })
  return reply.isAnswered ? parseStatus(reply.text) : undefined
}

/**
 * The session's own model judging from the whole conversation: a fork of the
 * main thread's last request, so the API serves the conversation from its cache.
 */
async function reviewConversation($: EngineInterface) {
  const reply = await $.model.fork({ prompt: FORK_PROMPT })
  const status = reply.isAnswered ? parseStatus(reply.text) : undefined
  return status === 'unclear' ? undefined : status
}

const isStatus = (s: Status | 'unclear' | undefined): s is Status => s !== undefined && s !== 'unclear'

/** Claude's judgement and which view gave it, or undefined when Claude could not tell. */
async function askClaude($: EngineInterface, s: Settings, turn: Turn) {
  if (s.claudeView !== 'conversation') {
    const summary = await reviewSummary($, s, turn).catch(() => undefined)
    if (isStatus(summary)) return { status: summary, via: 'summary' as const }
    if (s.claudeView === 'summary') return undefined
  }
  // The summary was not enough (or the person always wants the whole session).
  const whole = await reviewConversation($).catch(() => undefined)
  return isStatus(whole) ? { status: whole, via: 'conversation' as const } : undefined
}

async function judge($: EngineInterface, s: Settings, turn: Turn): Promise<Verdict> {
  const key = await apiKey($, s.apiKey)
  const jev: Verdict = key ? await askJev($, key, turn) : { status: 'nokey', source: 'jev' }

  const jevFailed = jev.status === 'nokey' || jev.status === 'error'
  const jevUnsure = !jevFailed && typeof jev.confidence === 'number' && jev.confidence * 100 < s.claudeBelow
  if (!(jevUnsure || (jevFailed && s.claudeOnJevFailure))) return jev

  const claude = await askClaude($, s, turn)
  if (claude === undefined) return jev // Claude could not tell either: Jev's answer stands

  return {
    status: claude.status,
    source: 'claude',
    via: claude.via,
    confidence: jevUnsure ? jev.confidence : undefined,
    error: jevFailed ? (jev.status === 'nokey' ? 'no Jev key' : `Jev ${jev.error ?? 'error'}`) : undefined,
  }
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    apiKey: options.api_key,
    claudeBelow: typeof options.claude_below === 'number' ? options.claude_below : 70,
    claudeView: VIEWS.find(v => v === options.claude_view) ?? 'summary-then-conversation',
    reviewModel:
      typeof options.review_model === 'string' && options.review_model.trim() ? options.review_model.trim() : 'haiku',
    claudeOnJevFailure: options.claude_on_jev_failure !== false,
  }

  let prompt = ''
  let errors: string[] = []
  let turnSeq = 0

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind !== 'task-notification') {
      prompt = e.text.slice(0, MAX_PROMPT_CHARS)
      errors = []
      turnSeq += 1
      await update($, phase, (): Phase => 'running')
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.isError === true) {
      errors = [...errors, (ran.text ?? '').slice(0, MAX_ERROR_CHARS)].slice(-MAX_ERRORS)
    }

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    // Interrupted or errored turns have no answer worth judging.
    if (e.reason !== 'answer' || !e.answer.trim()) {
      await update($, phase, (): Phase => 'idle')
      return done
    }

    const seq = turnSeq
    const turn: Turn = { prompt, answer: e.answer.slice(-MAX_ANSWER_CHARS), errors }
    await update($, phase, (): Phase => 'checking')

    const settle = async (v: Verdict) => {
      // A newer turn started, or this one already settled.
      if (seq !== turnSeq || (await read($, phase)) !== 'checking') return
      await update($, verdict, () => v)
      await update($, phase, (): Phase => 'idle')
      if (options.toast !== false && v.status !== 'nokey') {
        const more = v.source === 'jev' && typeof v.confidence === 'number' ? ` (${pct(v.confidence)})` : detail(v)
        $.ui.toast(`${LOOK[v.status].words}${more}`)
      }
    }

    // Judge after the turn has settled, off this dispatch.
    $.clock.after(0, () => {
      judge($, settings, turn)
        .catch(
          (err: unknown): Verdict => ({
            status: 'error',
            source: 'jev',
            error: err instanceof Error ? err.message.slice(0, 60) : 'request failed',
          }),
        )
        .then(settle)
        .catch(() => {})
    })
    $.clock.after(GIVE_UP_MS, () => {
      settle({ status: 'error', source: 'jev', error: 'no answer in 2 min' }).catch(() => {})
    })

    return done
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const p = await read($, phase)
    const v = await read($, verdict)
    if (e.props.hasSurvey || e.props.isWorking || p === 'running' || (p === 'idle' && v === null)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    if (p === 'checking') {
      return (
        <Box>
          <Text dimColor>JEV: checking…</Text>
        </Box>
      )
    }

    const look = LOOK[v!.status] ?? { label: v!.status }

    return (
      <Box>
        <Text dimColor>JEV: </Text>
        <Text bold color={look.color} dimColor={look.color === undefined}>
          {look.label}
        </Text>
        <Text dimColor>{detail(v!)}</Text>
      </Box>
    )
  })
}
