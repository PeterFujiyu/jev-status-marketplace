import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Answer, Check, Deploy, Observed, Phase, Question, Status, Verdict } from '../types'

// After each turn, asks TypeSafe Jev two independent things: where the user's
// task stands (done, waiting on the user, failed), and how ready the turn's
// deployable work is (production, development only, not deployable, nothing to
// deploy). Draws both above the prompt. When Jev is unsure of either (or can't
// answer), asks Claude for a second opinion on that one. A deploy answer no one
// could settle shows as "needs review", never as a low-confidence green.
// Sent to TypeSafe per turn: excerpts of the user's prompt and Claude's final
// answer, the last few tool errors and their count, and pass/fail states of
// checks the plugin saw run. Nothing else.

const verdict = atom({ plugin: 'jev-status', key: 'verdict' } as const, null)
const phase = atom({ plugin: 'jev-status', key: 'phase' } as const, 'idle')

const API_URL = 'https://api.typesafe.ai/v1/systemone'
const GIVE_UP_MS = 120_000
const CLAUDE_TIMEOUT_MS = 45_000
const FORK_TIMEOUT_MS = 90_000
const MAX_PROMPT_CHARS = 2000
const MAX_ANSWER_CHARS = 4000
const MAX_ERRORS = 3
const MAX_ERROR_CHARS = 300
const DEFAULT_BELOW = 70

type Choices = { status: Status; deploy: Deploy }

const CRITERIA: { [Q in Question]: Record<Choices[Q], string> } = {
  status: {
    done:
      'The agent finished what the user asked (answering a question counts) and reports the result; ' +
      'nothing more is needed from the user for this request.',
    needaction:
      'The agent is waiting on the user: it asks a question, invites the next request (as after a ' +
      'greeting), or needs a decision, approval, credentials, or a manual step before work can continue.',
    failed:
      'The agent could not complete the task: it hit errors it did not resolve, gave up, ' +
      'or reports that the result does not work.',
  },
  deploy: {
    production:
      'Deployable work (code, configuration, infrastructure) was produced and the verification relevant ' +
      'to it (such as tests or a build) was reported or observed passing, with no known blockers or ' +
      'unresolved risks. Errors fixed later in the turn are not blockers. This holds even if the agent ' +
      "still waits for the user's go-ahead to deploy.",
    development:
      'Deployable work was produced and appears usable, but it was not verified (tests not run or only ' +
      'partly, untested paths, open follow-ups the agent mentions); suitable for development or staging, ' +
      'not production.',
    nodeploy:
      'Deployable work exists but must not be deployed: a known blocker or failure, an unfinished ' +
      'implementation, a risky or unsafe condition (data migrations, destructive or irreversible steps, ' +
      'security- or credential-sensitive changes), or an explicit warning not to ship it.',
    nothing:
      'No environment-deployable work was produced: research, an explanation, planning, a code review, ' +
      'a greeting or other conversation.',
  },
}

const ASKS: Record<Question, string> = {
  status: "Where does the user's task stand now? Judge only the task, not deployment.",
  deploy:
    "How ready is this turn's deployable work, and for which environment? Judge only technical " +
    'readiness, not whether the agent waits on the user. Production readiness does not replace CI, ' +
    'review, approvals or release policy.',
}

const STATE =
  '`state` is the end of one turn of an AI coding agent. `user_request` is what the user asked and ' +
  "`agent_final_message` is the agent's last message before it stopped; long text is shortened in " +
  'the middle. `tool_errors` are the last few errors from tools the agent ran during the turn and ' +
  '`tool_error_count` how many there were in all; the agent may have resolved them later in the same ' +
  'turn, so weigh them against the final message. `observed_checks` are results the plugin itself saw ' +
  'from commands the agent ran this turn (unknown: none seen, or the outcome could not be told; unknown ' +
  "is no evidence either way, and not every project has every check); unlike the agent's message, they " +
  'are not claims. '

const jevQuestion = (q: Question) => ({ type: 'choice', instructions: STATE + ASKS[q], criteria: CRITERIA[q] })

const rubric = (qs: Question[]) =>
  qs
    .map(q => `${q}: ${ASKS[q]}\n${Object.entries(CRITERIA[q]).map(([c, d]) => `  ${c}: ${d}`).join('\n')}`)
    .join('\n\n')

const replyForm = (qs: Question[]) =>
  'Answer each question below with exactly one of its choices, or unclear when you cannot tell; do ' +
  'not guess. Reply with one line per question and nothing else: ' +
  `${qs.map(q => `"${q}: <choice>"`).join(', ')}.`

const reviewSystem = (qs: Question[]) =>
  `You judge the end of one turn of an AI coding agent. ${STATE}${replyForm(qs)}\n\n${rubric(qs)}`

const forkPrompt = (qs: Question[]) =>
  "Step outside the conversation for a moment and judge the user's task as of your last message. " +
  `${replyForm(qs)}\n\n${rubric(qs)}`

// `label` is drawn in color above the prompt; `words` is the plain text for a
// toast, which shows no color and already carries the plugin's name.
type Look = { color?: string; label: string; words: string }

const NO_KEY: Look = { label: 'no TypeSafe API key (set it in /plugin)', words: 'no TypeSafe API key' }
const JEV_ERROR: Look = { label: 'Jev error', words: 'Jev error' }

const LOOK: { status: Record<Status | 'nokey' | 'error', Look>; deploy: Record<Deploy | 'review' | 'nokey' | 'error', Look> } = {
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
    nodeploy: { color: 'red', label: '■ not deployable', words: 'not deployable' },
    nothing: { label: '– nothing to deploy', words: 'nothing' },
    review: { color: 'yellow', label: '? needs review', words: 'needs review' },
    nokey: NO_KEY,
    error: JEV_ERROR,
  },
}

// Reviewer spellings of a choice, compared with spaces, hyphens and underscores removed.
const ALIASES: Record<string, string> = { needsaction: 'needaction', nothingtodeploy: 'nothing' }

// ——— Observed checks ———
// The plugin sees each Bash command and whether it ended in an error (a
// non-zero exit). It counts a command as a check only when that exit status
// speaks for it: no pipes, `;` lists or background jobs, only `&&` chains.

const CHECKS: readonly Check[] = ['tests', 'build', 'typecheck', 'lint']

const SCRIPT = String.raw`^(npm|pnpm|yarn|bun) (run )?`

const RULES: [Check, RegExp][] = [
  ['tests', /^(jest|vitest|mocha|ava|pytest|py\.test|tox|nox|rspec|phpunit|ctest)\b/],
  ['tests', /^(playwright test|cypress run)\b/],
  ['tests', new RegExp(`${SCRIPT}test(:\\S+)?\\b`)],
  ['tests', /^(go|cargo|deno|bun|dotnet|swift|mix|zig) test\b/],
  ['tests', /^python[0-9.]* -m (pytest|unittest)\b/],
  ['tests', /^(mvn|mvnw|gradle|gradlew)\b.*\b(test|check|verify)\b/],
  ['tests', /^(xcodebuild\b.*\btest|make (test|check)|claude plugin test)\b/],
  ['lint', /^(eslint|ruff|flake8|pylint|golangci-lint|rubocop|stylelint|biome|shellcheck|swiftlint|ktlint|oxlint)\b/],
  ['lint', /^(prettier\b.*--check|cargo clippy|make lint)\b/],
  ['lint', new RegExp(`${SCRIPT}lint(:\\S+)?\\b`)],
  ['typecheck', /^(tsc|vue-tsc|mypy|pyright|basedpyright|flow)\b/],
  ['typecheck', /^cargo check\b/],
  ['typecheck', new RegExp(`${SCRIPT}(typecheck|type-check|check-types|tsc)\\b`)],
  ['build', new RegExp(`${SCRIPT}build(:\\S+)?\\b`)],
  ['build', /^(cargo|go|dotnet|swift|zig) build\b/],
  ['build', /^(mvn|mvnw)\b.*\b(package|install|compile)\b/],
  ['build', /^(gradle|gradlew)\b.*\b(build|assemble)\b/],
  ['build', /^(xcodebuild|webpack|tsup|rollup)\b/],
  ['build', /^(vite|next|nuxt|astro|remix) build\b/],
  ['build', /^make( (all|build))?$/],
]

const base = (word: string) => word.replace(/^.*\//, '')

/** Which check one simple command runs, if any. */
function checkOf(command: string): Check | undefined {
  let words = command.split(/\s+/).filter(Boolean)
  // Variable assignments, and launchers that only start the real tool.
  for (;;) {
    const [first = '', second = ''] = [base(words[0] ?? ''), words[1]]
    const runs2 = (first === 'pnpm' && second === 'exec') || (/^(uv|poetry|pipenv|bundle)$/.test(first) && /^(exec|run)$/.test(second))
    if (words.length > 1 && (/^\w+=/.test(words[0]!) || /^(npx|bunx|node|time|env|exec)$/.test(first))) words = words.slice(1)
    else if (words.length > 2 && runs2) words = words.slice(2)
    else break
  }
  if (words.length === 0) return undefined
  const line = [base(words[0]!), ...words.slice(1)].join(' ')
  return RULES.find(([, re]) => re.test(line))?.[0]
}

const TRIVIAL = /^(cd|pushd|popd|export|source|\.|set|unset|true)\b|^\w+=\S*$/

/** What a Bash command's exit status says about the checks it ran. */
function observe(command: string, failed: boolean): [Check, Observed][] {
  const flat = command
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'Q') // quoted text cannot split commands
    .replace(/\d*>&\d*|&>|<&\d*/g, ' ') // redirections, not operators
  if (/[|;&\n]/.test(flat.replace(/&&/g, ''))) return []
  const parts = flat.split('&&').map(s => s.trim()).filter(Boolean)
  const kinds = parts.map(checkOf)
  const found = [...new Set(kinds.filter((k): k is Check => k !== undefined))]
  // Success: every part of an && chain ran and passed.
  if (!failed) return found.map((c): [Check, Observed] => [c, 'passed'])
  // Failure: only when one check could have failed it.
  const others = parts.filter((_, i) => kinds[i] === undefined)
  return found.length === 1 && kinds.filter(k => k !== undefined).length === 1 && others.every(p => TRIVIAL.test(p))
    ? [[found[0]!, 'failed']]
    : []
}

// ——— Judging ———

type Checks = Record<Check, Observed>
type Turn = { prompt: string; answer: string; errors: string[]; errorCount: number; checks: Checks }

type ClaudeView = 'summary' | 'summary-then-conversation' | 'conversation'

type Settings = {
  apiKey: unknown
  questions: Question[]
  taskBelow: number
  deployBelow: number
  productionBelow: number
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

const unknownChecks = (): Checks => ({ tests: 'unknown', build: 'unknown', typecheck: 'unknown', lint: 'unknown' })

/** `text` within `max` characters, its head and tail kept around a marker. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text
  const marker = `\n[… ${text.length - max} characters omitted …]\n`
  const head = Math.floor((max - marker.length) * 0.4)
  return text.slice(0, head) + marker + text.slice(text.length - (max - marker.length - head))
}

const stateOf = (turn: Turn) => ({
  user_request: turn.prompt,
  agent_final_message: turn.answer,
  tool_errors: turn.errors,
  tool_error_count: turn.errorCount,
  observed_checks: turn.checks,
})

/** What an answer says beyond its choice: its confidence, or who answered and why. */
function detail(a: Answer): string {
  if (a.choice === 'review') {
    const s = a.suggested
    const said = s ? `${s.by === 'jev' ? 'Jev' : 'Claude'} suggested ${s.choice}${typeof s.confidence === 'number' ? ` ${pct(s.confidence)}` : ''}` : ''
    return ` · ${[said, a.note].filter(Boolean).join(', but ')}`
  }
  if (a.source === 'claude') {
    const who = a.via === 'conversation' ? 'Claude, session context' : 'Claude'
    return ` · ${who} (${typeof a.confidence === 'number' ? `Jev ${pct(a.confidence)}` : (a.error ?? 'Jev unsure')})`
  }
  if (typeof a.confidence === 'number') return ` ${pct(a.confidence)}`
  return a.choice === 'error' && a.error ? ` (${a.error})` : ''
}

/** A reviewer's value for `q`: one of its choices exactly, `unclear`, or undefined. */
function readValue(q: Question, raw: string): string | undefined {
  const value = raw.toLowerCase().replace(/[*_`"']/g, '').trim().replace(/[.!]+$/, '')
  const word = value.replace(/[\s-]/g, '')
  const choice = Object.hasOwn(ALIASES, word) ? ALIASES[word]! : word
  if (choice === 'unclear') return 'unclear'
  return Object.hasOwn(CRITERIA[q], choice) ? choice : undefined
}

/** A reviewer's definite answers, one line per question as `question: choice`. */
function readReply(qs: Question[], text: string): Picks {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  const picks: Picks = {}
  for (const q of qs) {
    const label = new RegExp(`^[\\W_]*${q}[\\W_]*?:(.*)$`, 'i')
    const values = lines.flatMap(l => l.match(label)?.[1] ?? [])
    // A bare one-word reply answers a lone question; a question answered twice is not answered.
    const raw = values.length === 1 ? values[0] : values.length === 0 && qs.length === 1 && lines.length === 1 ? lines[0] : undefined
    const choice = raw === undefined ? undefined : readValue(q, raw)
    if (choice !== undefined && choice !== 'unclear') picks[q] = choice
  }
  return picks
}

async function apiKey($: EngineInterface, configured: unknown): Promise<string> {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  const fromEnv = await $.env.get('TYPESAFE_API_KEY')
  if (fromEnv?.trim()) return fromEnv.trim()
  const home = (await $.env.get('HOME'))?.trim()
  if (!home) return ''
  const path = `${home.replace(/\/+$/, '')}/.config/typesafe/api_key`
  return (await $.fs.exists(path)) ? (await $.fs.read(path)).trim() : ''
}

/** One of Jev's answers, checked whole: a choice question, a known choice, a confidence in 0..1. */
function jevAnswer(q: Question, a: unknown): Answer {
  const bad = (why: string): Answer => ({ choice: 'error', source: 'jev', error: why })
  if (typeof a !== 'object' || a === null) return bad('no answer')
  const { type, choice, confidence } = a as Record<string, unknown>
  if (type !== 'choice' || typeof choice !== 'string' || !Object.hasOwn(CRITERIA[q], choice)) return bad('malformed answer')
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return bad('bad confidence')
  }
  return { choice, source: 'jev', confidence }
}

/** Jev's answers to `qs`, all from one request; each question fails on its own. */
async function askJev($: EngineInterface, key: string, turn: Turn, qs: Question[]): Promise<Answers> {
  const fail = (error: string) => allAre(qs, { choice: 'error', source: 'jev', error })
  let res
  try {
    res = await $.http.fetch(API_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-latest',
        state: stateOf(turn),
        questions: Object.fromEntries(qs.map(q => [q, jevQuestion(q)])),
      }),
    })
  } catch {
    return fail('network error')
  }
  if (!res.ok) return fail(`HTTP ${res.status}`)
  let body: unknown
  try {
    body = JSON.parse(res.text)
  } catch {
    return fail('invalid JSON')
  }
  const answers = (body as { answers?: unknown } | null)?.answers
  if (typeof answers !== 'object' || answers === null) return fail('no answers')
  return Object.fromEntries(
    qs.map(q => [q, jevAnswer(q, Object.hasOwn(answers, q) ? (answers as Record<string, unknown>)[q] : undefined)]),
  )
}

/** `work`'s value, or undefined when it fails or `ms` pass first. */
function within<T>($: EngineInterface, ms: number, work: Promise<T>): Promise<T | undefined> {
  return new Promise(resolve => {
    $.clock.after(ms, () => resolve(undefined))
    work.then(resolve, () => resolve(undefined))
  })
}

/** The review model's answers from what Jev read. */
async function reviewSummary($: EngineInterface, s: Settings, turn: Turn, qs: Question[]): Promise<Picks> {
  const reply = await $.model.complete({
    model: s.reviewModel,
    system: reviewSystem(qs),
    prompt: JSON.stringify(stateOf(turn)),
    maxTokens: 32,
    timeoutMs: CLAUDE_TIMEOUT_MS,
  })
  return reply.isAnswered ? readReply(qs, reply.text) : {}
}

/**
 * The session's own model answering from the session context: a fork of the
 * main thread's last request. It reads the conversation as Claude Code holds it
 * now, which may already be compacted, so it can miss what compaction dropped;
 * the shared prefix usually comes from the prompt cache.
 */
async function reviewConversation($: EngineInterface, qs: Question[]): Promise<Picks> {
  const reply = await within($, FORK_TIMEOUT_MS, $.model.fork({ prompt: forkPrompt(qs) }))
  return reply?.isAnswered ? readReply(qs, reply.text) : {}
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
  // The summary was not enough (or the person always wants the session context).
  const whole = await reviewConversation($, left).catch((): Picks => ({}))
  for (const q of left) if (whole[q] !== undefined) picked[q] = { choice: whole[q]!, via: 'conversation' }
  return picked
}

async function judge($: EngineInterface, s: Settings, turn: Turn): Promise<Verdict> {
  const qs = s.questions
  const key = await apiKey($, s.apiKey)
  const jev = key ? await askJev($, key, turn, qs) : allAre(qs, { choice: 'nokey', source: 'jev' })

  const below = (q: Question, a: Answer) =>
    q === 'status' ? s.taskBelow : a.choice === 'production' ? Math.max(s.deployBelow, s.productionBelow) : s.deployBelow
  const unsure = (q: Question, a: Answer) =>
    !failedAnswer(a) && typeof a.confidence === 'number' && a.confidence * 100 < below(q, a)
  const toClaude = qs.filter(q => unsure(q, jev[q]!) || (failedAnswer(jev[q]!) && s.claudeOnJevFailure))
  const claude = toClaude.length > 0 ? await askClaude($, s, turn, toClaude) : {}

  const answers: Answers = {}
  for (const q of qs) {
    const j = jev[q]!
    const c = claude[q]
    if (c !== undefined) {
      answers[q] = {
        choice: c.choice,
        source: 'claude',
        via: c.via,
        confidence: unsure(q, j) ? j.confidence : undefined,
        error: failedAnswer(j) ? (j.choice === 'nokey' ? 'no Jev key' : `Jev ${j.error ?? 'error'}`) : undefined,
      }
    } else if (q === 'deploy' && unsure(q, j)) {
      // Fail closed: an unsure deploy answer Claude could not settle is not shown as Jev's.
      answers[q] = { choice: 'review', source: 'jev', suggested: { choice: j.choice, by: 'jev', confidence: j.confidence } }
    } else {
      answers[q] = j // the task row keeps Jev's answer; a failed deploy row stays an error
    }
  }

  // Production cannot stand against a check the plugin saw fail.
  const d = answers.deploy
  const broken = CHECKS.filter(c => turn.checks[c] === 'failed')
  if (d?.choice === 'production' && broken.length > 0) {
    answers.deploy = {
      choice: 'review',
      source: d.source,
      suggested: { choice: 'production', by: d.source, confidence: d.source === 'jev' ? d.confidence : undefined },
      note: `observed ${broken.join(', ')} failed`,
    }
  }
  return answers as Verdict
}

/** One evaluation as toast words: its choice, and its confidence or who answered. */
function said(look: Look, a: Answer) {
  if (a.choice === 'review') return `${look.words} (${detail(a).slice(3)})`
  return `${look.words}${a.source === 'jev' && typeof a.confidence === 'number' ? ` (${pct(a.confidence)})` : detail(a)}`
}

/** A number option, or undefined when unset or not a number. */
function numberOption(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export const register: Register = (on, options) => {
  const below = numberOption(options.claude_below) ?? DEFAULT_BELOW
  const deployBelow = numberOption(options.deploy_below) ?? below
  const settings: Settings = {
    apiKey: options.api_key,
    questions: options.deploy_check === false ? ['status'] : ['status', 'deploy'],
    taskBelow: numberOption(options.task_below) ?? below,
    deployBelow,
    productionBelow: numberOption(options.production_below) ?? deployBelow,
    claudeView: VIEWS.find(v => v === options.claude_view) ?? 'summary-then-conversation',
    reviewModel:
      typeof options.review_model === 'string' && options.review_model.trim() ? options.review_model.trim() : 'haiku',
    claudeOnJevFailure: options.claude_on_jev_failure !== false,
  }

  let prompt = ''
  let errors: string[] = []
  let errorCount = 0
  let checks = unknownChecks()
  // Bumped by every new turn and every judgement started: an older one can't settle.
  let epoch = 0

  on('prompt.submit', async ($, e, next) => {
    epoch += 1
    // A background task's notification starts a turn too, but the request stays the user's last.
    if (e.origin.kind !== 'task-notification') prompt = clip(e.text, MAX_PROMPT_CHARS)
    errors = []
    errorCount = 0
    checks = unknownChecks()
    // Bookkeeping only: a failure here must never hold up the prompt.
    await Promise.all([update($, verdict, () => null), update($, phase, (): Phase => 'running')]).catch(() => {})

    return next(e)
  })
    // A failure in this hook passes the prompt through as if the plugin were absent.
    .catch(() => undefined)

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    try {
      record(e, ran)
    } catch {
      // Bookkeeping only: the tool's result goes back unchanged whatever happens here.
    }

    return ran
  })
    .catch(() => undefined)

  function record(e: ToolCallInput, ran: ToolCallResult) {
    if (ran.isError === true) {
      errorCount += 1
      errors = [...errors, clip(ran.text ?? '', MAX_ERROR_CHARS)].slice(-MAX_ERRORS)
    }
    if (e.tool === 'Bash' && typeof e.command === 'string' && ran.deny === undefined) {
      const out = (ran.isError === true ? {} : (ran.result ?? {})) as {
        interrupted?: boolean
        backgroundTaskId?: string
        timedOutAfterMs?: number
        returnCodeInterpretation?: string
      }
      // A non-zero exit Claude Code read as no error (returnCodeInterpretation) is no pass either.
      const settled =
        !out.interrupted && out.backgroundTaskId === undefined && out.timedOutAfterMs === undefined &&
        out.returnCodeInterpretation === undefined &&
        !(ran.isError === true && /interrupt|timed out|background/i.test(ran.text ?? ''))
      if (settled) for (const [c, o] of observe(e.command, ran.isError === true)) checks[c] = o
    }
  }

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId !== undefined) return done

    // Interrupted or errored turns have no answer worth judging; the last verdict was cleared.
    if (e.reason !== 'answer' || !e.answer.trim()) {
      epoch += 1
      await update($, phase, (): Phase => 'idle')
      return done
    }

    const mine = ++epoch
    const turn: Turn = { prompt, answer: clip(e.answer, MAX_ANSWER_CHARS), errors, errorCount, checks: { ...checks } }
    await update($, phase, (): Phase => 'checking')

    let settled = false
    const settle = async (v: Verdict) => {
      // A newer turn started, or this one already settled.
      if (mine !== epoch || settled) return
      settled = true
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
    // A verdict kept from an earlier version of the plugin has another shape: ignore it.
    const kept = await read($, verdict)
    const v = typeof kept?.status === 'object' && kept.status !== null ? kept : null
    if (e.props.hasSurvey || e.props.isWorking || p === 'running' || (p === 'idle' && v === null)) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    if (p === 'checking' || v === null) {
      return (
        <Box>
          <Text dimColor>JEV: checking…</Text>
        </Box>
      )
    }

    const row = (title: string, looks: Record<string, Look>, a: Answer) => {
      const look = looks[a.choice] ?? { label: String(a.choice) }
      return (
        <Box>
          <Text dimColor>{title}</Text>
          <Text bold color={look.color} dimColor={look.color === undefined}>
            {look.label}
          </Text>
          <Text dimColor>{detail(a)}</Text>
        </Box>
      )
    }
    const { status, deploy } = v
    // Without a key, or when Jev failed for both, the deploy row would only repeat the status row.
    const showDeploy =
      deploy !== undefined &&
      deploy.choice !== 'nokey' &&
      !(deploy.choice === 'error' && status.choice === 'error' && deploy.error === status.error)

    return (
      <Box flexDirection="column">
        {row(showDeploy ? 'JEV task:   ' : 'JEV: ', LOOK.status, status)}
        {showDeploy ? row('JEV deploy: ', LOOK.deploy, deploy) : null}
      </Box>
    )
  })
}
