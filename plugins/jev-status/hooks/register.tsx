import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Answer, Deploy, Phase, Question, Status, Verdict } from '../types'

// After each turn, asks TypeSafe Jev two separate things: whether the user's
// task is done, waiting on the user, or failed; and whether the turn's work may
// go straight to production, only to a development environment, or not be
// deployed directly at all. Draws both above the prompt. When Jev is unsure of
// either (or can't answer), asks Claude for a second opinion on that one.
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

type Choices = { status: Status; deploy: Deploy }

const CRITERIA: { [Q in Question]: Record<Choices[Q], string> } = {
  status: {
    done: 'The agent finished what was asked and reports the result; nothing is required from the user.',
    needaction:
      'The agent stopped to wait for the user: it asks a question, needs a decision, approval, ' +
      'credentials, or a manual step the user must do before work can continue.',
    failed:
      'The agent could not complete the task: it hit errors it did not resolve, gave up, ' +
      'or reports that the result does not work.',
  },
  deploy: {
    production:
      'The agent changed code or configuration and reports it verified (the tests, build or checks ' +
      'it ran passed), with no unresolved errors or open caveats; it can go straight to production.',
    development:
      'The change looks like it works but is not fully verified (tests not run or only partly, ' +
      'untested paths, follow-ups or caveats the agent mentions); it may go to a development or ' +
      'staging environment, not to production.',
    nodeploy:
      'Direct deployment is not permitted: the work is unfinished or failing, waits on the user, ' +
      'is risky (data migrations, destructive or irreversible steps, security or credential ' +
      'changes), or the agent says not to ship it.',
    nochange:
      'The turn produced nothing to deploy and nothing waits on the user: the agent answered a ' +
      'question, researched, planned, or only read code.',
  },
}

const ASKS: Record<Question, string> = {
  status: "What is the status of the user's task now?",
  deploy: "May the work from this turn be deployed directly, and to which environment?",
}

const STATE =
  '`state` is the end of one turn of an AI coding agent. `user_request` is what the user asked, ' +
  "`agent_final_message` is the agent's last message before it stopped, and `tool_errors` are " +
  'errors from tools it ran during the turn. '

const jevQuestion = (q: Question) => ({ type: 'choice', instructions: STATE + ASKS[q], criteria: CRITERIA[q] })

const rubric = (qs: Question[]) =>
  qs
    .map(q => `${q}: ${ASKS[q]}\n${Object.entries(CRITERIA[q]).map(([c, d]) => `  ${c}: ${d}`).join('\n')}`)
    .join('\n\n')

const replyForm = (qs: Question[]) =>
  `Reply with one line per question and nothing else: ${qs.map(q => `"${q}: <choice>"`).join(', ')}.`

const reviewSystem = (qs: Question[]) =>
  'You judge the end of one turn of an AI coding agent. Answer each question below with one of ' +
  `its choices, or unclear when what you are given is not enough to tell. ${replyForm(qs)}\n\n${rubric(qs)}`

const forkPrompt = (qs: Question[]) =>
  "Step outside the conversation for a moment and judge the user's task as of your last message. " +
  `Answer each question below with one of its choices. ${replyForm(qs)}\n\n${rubric(qs)}`

// `label` is drawn in color above the prompt; `words` is the plain text for a
// toast, which shows no color and already carries the plugin's name.
type Look = { color?: string; label: string; words: string }

const NO_KEY: Look = { label: 'no TypeSafe API key (set it in /plugin)', words: 'no TypeSafe API key' }
const JEV_ERROR: Look = { label: 'Jev error', words: 'Jev error' }

const LOOK: { [Q in Question]: Record<Choices[Q] | 'nokey' | 'error', Look> } = {
  status: {
    done: { color: 'green', label: '✔ done', words: 'done' },
    needaction: { color: 'yellow', label: '● needs action', words: 'needs action' },
    failed: { color: 'red', label: '✘ failed', words: 'failed' },
    nokey: NO_KEY,
    error: JEV_ERROR,
  },
  deploy: {
    production: { color: 'green', label: '▲ production', words: 'production' },
    development: { color: 'cyan', label: '◆ development only', words: 'dev only' },
    nodeploy: { color: 'red', label: '■ not permitted', words: 'not permitted' },
    nochange: { label: '– nothing to deploy', words: 'nothing' },
    nokey: NO_KEY,
    error: JEV_ERROR,
  },
}

// How a reviewer's words map to a choice, first match wins: the negatives
// before the words they contain.
const WORDS: { [Q in Question]: [RegExp, Choices[Q] | 'unclear'][] } = {
  status: [
    [/\bunclear\b/, 'unclear'],
    [/\bneeds? ?action\b/, 'needaction'],
    [/\bfailed\b/, 'failed'],
    [/\bdone\b/, 'done'],
  ],
  deploy: [
    [/\bunclear\b/, 'unclear'],
    [/\bno ?deploy\b|\bnot permitted\b/, 'nodeploy'],
    [/\bno ?change\b|\bnothing\b/, 'nochange'],
    [/\bprod(uction)?\b/, 'production'],
    [/\bdev(elopment)?\b/, 'development'],
  ],
}

type Turn = { prompt: string; answer: string; errors: string[] }

type ClaudeView = 'summary' | 'summary-then-conversation' | 'conversation'

type Settings = {
  apiKey: unknown
  questions: Question[]
  claudeBelow: number
  claudeView: ClaudeView
  reviewModel: string
  claudeOnJevFailure: boolean
}

type Answers = Partial<Record<Question, Answer>>
type Picks = Partial<Record<Question, string>>

const VIEWS: readonly ClaudeView[] = ['summary', 'summary-then-conversation', 'conversation']

const pct = (n: number) => `${Math.round(n * 100)}%`

const failedAnswer = (a: Answer) => a.choice === 'nokey' || a.choice === 'error'

const allAre = (qs: Question[], a: Answer): Answers => Object.fromEntries(qs.map(q => [q, a]))

/** What an answer says beyond its choice: its confidence, or who answered and why. */
function detail(a: Answer): string {
  if (a.source === 'claude') {
    const who = a.via === 'conversation' ? 'Claude, full session' : 'Claude'
    return ` · ${who} (${typeof a.confidence === 'number' ? `Jev ${pct(a.confidence)}` : (a.error ?? 'Jev unsure')})`
  }
  if (typeof a.confidence === 'number') return ` ${pct(a.confidence)}`
  return a.choice === 'error' && a.error ? ` (${a.error})` : ''
}

/** A reviewer's choice for `q` in `text`, `unclear`, or undefined. */
function readChoice(q: Question, text: string): string | undefined {
  const words = text.toLowerCase().replace(/[^a-z ]/g, ' ')
  return WORDS[q].find(([re]) => re.test(words))?.[1]
}

/** A reviewer's definite answers, one line per question as `question: choice`. */
function readReply(qs: Question[], text: string): Picks {
  const lines = text.split('\n')
  const picks: Picks = {}
  for (const q of qs) {
    const line = lines.find(l => new RegExp(`^\\W*${q}\\W*:`, 'i').test(l)) ?? (qs.length === 1 ? text : undefined)
    const choice = line === undefined ? undefined : readChoice(q, line.slice(line.indexOf(':') + 1))
    if (choice !== undefined && choice !== 'unclear') picks[q] = choice
  }
  return picks
}

async function apiKey($: EngineInterface, configured: unknown): Promise<string> {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  const fromEnv = await $.env.get('TYPESAFE_API_KEY')
  if (fromEnv?.trim()) return fromEnv.trim()
  const path = `${await $.env.get('HOME')}/.config/typesafe/api_key`
  return (await $.fs.exists(path)) ? (await $.fs.read(path)).trim() : ''
}

/** Jev's answers to `qs`, all from one request. */
async function askJev($: EngineInterface, key: string, turn: Turn, qs: Question[]): Promise<Answers> {
  const res = await $.http.fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: { user_request: turn.prompt, agent_final_message: turn.answer, tool_errors: turn.errors },
      questions: Object.fromEntries(qs.map(q => [q, jevQuestion(q)])),
    }),
  })
  if (!res.ok) return allAre(qs, { choice: 'error', source: 'jev', error: `HTTP ${res.status}` })
  const answers = JSON.parse(res.text)?.answers ?? {}
  return Object.fromEntries(
    qs.map((q): [Question, Answer] => {
      const a = answers[q]
      return typeof a?.choice === 'string' && a.choice in CRITERIA[q]
        ? [q, { choice: a.choice, source: 'jev', confidence: a.confidence }]
        : [q, { choice: 'error', source: 'jev', error: 'unexpected response' }]
    }),
  )
}

/** The review model's answers from what Jev read. */
async function reviewSummary($: EngineInterface, s: Settings, turn: Turn, qs: Question[]): Promise<Picks> {
  const reply = await $.model.complete({
    model: s.reviewModel,
    system: reviewSystem(qs),
    prompt: JSON.stringify({ user_request: turn.prompt, agent_final_message: turn.answer, tool_errors: turn.errors }),
    maxTokens: 32,
    timeoutMs: CLAUDE_TIMEOUT_MS,
  })
  return reply.isAnswered ? readReply(qs, reply.text) : {}
}

/**
 * The session's own model answering from the whole conversation: a fork of the
 * main thread's last request, so the API serves the conversation from its cache.
 */
async function reviewConversation($: EngineInterface, qs: Question[]): Promise<Picks> {
  const reply = await $.model.fork({ prompt: forkPrompt(qs) })
  return reply.isAnswered ? readReply(qs, reply.text) : {}
}

/** Claude's answers to `qs` and which view gave each; questions it could not tell are left out. */
async function askClaude($: EngineInterface, s: Settings, turn: Turn, qs: Question[]) {
  const picked: Partial<Record<Question, { choice: string; via: 'summary' | 'conversation' }>> = {}
  let left = qs
  if (s.claudeView !== 'conversation') {
    const summary = await reviewSummary($, s, turn, left).catch((): Picks => ({}))
    for (const q of left) if (summary[q] !== undefined) picked[q] = { choice: summary[q]!, via: 'summary' }
    left = left.filter(q => picked[q] === undefined)
    if (s.claudeView === 'summary' || left.length === 0) return picked
  }
  // The summary was not enough (or the person always wants the whole session).
  const whole = await reviewConversation($, left).catch((): Picks => ({}))
  for (const q of left) if (whole[q] !== undefined) picked[q] = { choice: whole[q]!, via: 'conversation' }
  return picked
}

async function judge($: EngineInterface, s: Settings, turn: Turn): Promise<Verdict> {
  const qs = s.questions
  const key = await apiKey($, s.apiKey)
  const jev = key ? await askJev($, key, turn, qs) : allAre(qs, { choice: 'nokey', source: 'jev' })

  const unsure = (a: Answer) => !failedAnswer(a) && typeof a.confidence === 'number' && a.confidence * 100 < s.claudeBelow
  const toClaude = qs.filter(q => unsure(jev[q]!) || (failedAnswer(jev[q]!) && s.claudeOnJevFailure))
  const claude = toClaude.length > 0 ? await askClaude($, s, turn, toClaude) : {}

  const answers: Answers = {}
  for (const q of qs) {
    const j = jev[q]!
    const c = claude[q]
    // Claude could not tell either: Jev's answer stands.
    answers[q] =
      c === undefined
        ? j
        : {
            choice: c.choice,
            source: 'claude',
            via: c.via,
            confidence: unsure(j) ? j.confidence : undefined,
            error: failedAnswer(j) ? (j.choice === 'nokey' ? 'no Jev key' : `Jev ${j.error ?? 'error'}`) : undefined,
          }
  }
  return answers as Verdict
}

/** One evaluation as toast words: its choice, and its confidence or who answered. */
function said(look: Look, a: Answer) {
  return `${look.words}${a.source === 'jev' && typeof a.confidence === 'number' ? ` (${pct(a.confidence)})` : detail(a)}`
}

export const register: Register = (on, options) => {
  const settings: Settings = {
    apiKey: options.api_key,
    questions: options.deploy_check === false ? ['status'] : ['status', 'deploy'],
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
      if (options.toast !== false && v.status.choice !== 'nokey') {
        const deploy = v.deploy ? ` · deploy: ${said(LOOK.deploy[v.deploy.choice], v.deploy)}` : ''
        $.ui.toast(`${said(LOOK.status[v.status.choice], v.status)}${deploy}`)
      }
    }

    const failAll = (error: string) =>
      allAre(settings.questions, { choice: 'error', source: 'jev', error }) as Verdict

    // Judge after the turn has settled, off this dispatch.
    $.clock.after(0, () => {
      judge($, settings, turn)
        .catch((err: unknown) => failAll(err instanceof Error ? err.message.slice(0, 60) : 'request failed'))
        .then(settle)
        .catch(() => {})
    })
    $.clock.after(GIVE_UP_MS, () => {
      settle(failAll('no answer in 2 min')).catch(() => {})
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

    const row = (title: string, look: Look, a: Answer) => (
      <Box>
        <Text dimColor>{title}</Text>
        <Text bold color={look.color} dimColor={look.color === undefined}>
          {look.label}
        </Text>
        <Text dimColor>{detail(a)}</Text>
      </Box>
    )
    const { status, deploy } = v!
    // Without a key, or when Jev failed for both, the deploy row would only repeat the status row.
    const showDeploy =
      deploy !== undefined &&
      deploy.choice !== 'nokey' &&
      !(deploy.choice === 'error' && status.choice === 'error' && deploy.error === status.error)

    return (
      <Box flexDirection="column">
        {row(showDeploy ? 'JEV task:   ' : 'JEV: ', LOOK.status[status.choice], status)}
        {showDeploy ? row('JEV deploy: ', LOOK.deploy[deploy.choice], deploy) : null}
      </Box>
    )
  })
}
