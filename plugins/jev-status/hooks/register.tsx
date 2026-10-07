import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ToolCallInput, ToolCallResult } from 'claude-code'

import type { Answer, Check, Observed, Phase, Question, Ship, Status, Verdict, Verification } from '../types'

// After each turn, asks TypeSafe Jev two independent things: where the user's
// task stands (done, waiting on the user, failed), and the highest safe delivery
// level of the session's current active work, which may come from earlier turns
// (production, development, blocked, n/a). Draws both above the prompt. When Jev
// is unsure of either (or can't answer), asks Claude for a second opinion on that
// one; for ship, the session's own model reviews the session context. A ship
// answer no one could settle shows as "needs review", never as a low-confidence green.
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

type Choices = { status: Status; ship: Ship; verification: Verification }

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
  ship: {
    production:
      'Deliverable work (code, configuration, infrastructure) is active in the session and the ' +
      'verification relevant to it (such as tests or a build) was reported or observed passing, with no ' +
      'known blockers or unresolved risks. Errors fixed later are not blockers. This holds even if the ' +
      "agent still waits for the user's go-ahead to push, merge or deploy; it is the highest level.",
    development:
      'Deliverable work is active and appears usable, but it was not verified (tests not run or only ' +
      'partly, untested paths, open follow-ups the agent mentions); safe to push or merge for development ' +
      'or staging, not production.',
    blocked:
      'The current active work should not be pushed, merged or deployed yet: a known failure, unfinished ' +
      'work, an unresolved risk (data migrations, destructive or irreversible steps, security- or ' +
      'credential-sensitive changes), or a required fix or review.',
    na:
      'There is genuinely no active deliverable work in the session: only questions, research, ' +
      'explanation, planning or conversation. A turn with no new edits is not na when it pushes, merges, ' +
      'releases, approves or otherwise continues work from earlier turns.',
  },
  verification: {
    complete:
      'The verification the current active work evidently calls for was completed successfully, as ' +
      'reported or observed (for a code change, typically its tests and build), and nothing is reported ' +
      'as still pending. Do not require checks the work does not call for and the agent does not mention.',
    incomplete:
      'A relevant verification the work calls for or the agent mentions (a test, manual check, runtime ' +
      'validation, integration, environment or compatibility check) is still pending, unchecked, not run, ' +
      'or described as still manual. Wording such as still manual, unchecked, not tested, not run, pending ' +
      'verification, needs validation, requires manual testing or open checks points here, even when the ' +
      'implementation itself is complete.',
    unknown: 'The available evidence is not enough to tell whether all relevant verification is complete.',
  },
}

const ASKS: Record<Question, string> = {
  status: "Where does the user's task stand now? Judge only the task, not delivery.",
  ship:
    'What is the highest safe delivery level for the current active work represented by this session? ' +
    'Earlier turns of the session count: work created or verified before this turn is still active when ' +
    'this turn pushes, merges, releases, approves or otherwise continues it. Unknown checks are no evidence ' +
    'either way. Judge only technical ' +
    'readiness, not whether the agent waits on the user; production readiness does not replace CI, ' +
    'review, approvals or release policy.',
  verification:
    'Has all the verification that the current active work in this session needs been completed ' +
    'successfully? Implementation complete does not mean verified. Earlier turns count as for ship. ' +
    'Judge only verification, not readiness or the task.',
}

const STATE =
  "`state` is the latest turn of an AI coding agent's session; earlier turns are not included. " +
  '`user_request` is what the user asked and ' +
  "`agent_final_message` is the agent's last message before it stopped; long text is shortened in " +
  'the middle. `tool_errors` are the last few errors from tools the agent ran during the turn and ' +
  '`tool_error_count` how many there were in all; the agent may have resolved them later in the same ' +
  'turn, so weigh them against the final message. `observed_checks` are results the plugin itself saw ' +
  'from commands the agent ran in this latest turn only (unknown: none seen, or the outcome could not be told; unknown ' +
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
  `You judge the latest turn of an AI coding agent's session. ${STATE}${replyForm(qs)}\n\n${rubric(qs)}`

const SHIP_REVIEW =
  'On the ship question: Review the current session context and judge the latest active deliverable work, not ' +
  'just the most recent turn. Work created or verified in earlier turns still counts if the current ' +
  'turn is pushing, merging, releasing, approving, or otherwise continuing that work. Use na only when ' +
  'there is genuinely no active deliverable work in the session. '

const VERIFICATION_REVIEW =
  'On the verification question: judge it across the session the same way, and as strictly as an ' +
  'outside reviewer would, including for work you did yourself. Implementation complete does not mean ' +
  'verified: any relevant check still pending, unchecked, not run or left manual makes it incomplete. '

const forkPrompt = (qs: Question[]) =>
  "Step outside the conversation for a moment and judge the user's task as of your last message. " +
  `${qs.includes('ship') ? SHIP_REVIEW : ''}${qs.includes('verification') ? VERIFICATION_REVIEW : ''}` +
  `${replyForm(qs)}\n\n${rubric(qs)}`

// `label` is drawn in color above the prompt; `words` is the plain text for a
// toast, which shows no color and already carries the plugin's name.
type Look = { color?: string; label: string; words: string }

const NO_KEY: Look = { label: 'no TypeSafe API key (set it in /plugin)', words: 'no TypeSafe API key' }
const JEV_ERROR: Look = { label: 'Jev error', words: 'Jev error' }

const LOOK: { status: Record<Status | 'nokey' | 'error', Look>; ship: Record<Ship | 'review' | 'nokey' | 'error', Look> } = {
  status: {
    done: { color: 'green', label: '✔ done', words: 'done' },
    needaction: { color: 'yellow', label: '● needs action', words: 'needs action' },
    failed: { color: 'red', label: '✘ failed', words: 'failed' },
    nokey: NO_KEY,
    error: JEV_ERROR,
  },
  ship: {
    production: { color: 'green', label: '▲ production', words: 'production' },
    development: { color: 'cyan', label: '◆ development', words: 'development' },
    blocked: { color: 'red', label: '■ blocked', words: 'blocked' },
    na: { label: '– n/a', words: 'n/a' },
    review: { color: 'yellow', label: '? needs review', words: 'needs review' },
    nokey: NO_KEY,
    error: JEV_ERROR,
  },
}

// Reviewer spellings of a choice, compared with spaces, hyphens and underscores removed.
const ALIASES: Record<string, string> = { needsaction: 'needaction', 'n/a': 'na', notapplicable: 'na' }

// ——— Observed checks ———
// The plugin sees each Bash command and whether it ended in an error (a
// non-zero exit). A check passes only when the exit status speaks for an actual
// run of it: a plain command or an `&&` chain, not a version, help, listing or
// dry run. A run whose outcome can't be told (piped, `;`, background, a failed
// chain) resets that check to unknown, so an older pass never stands for it.

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

// Arguments that make a check command report on itself instead of verifying anything.
const NOT_A_RUN =
  /\s(--version|-V|--help|-h|--dry-run|--dryrun|--list|-list|--list-tests|--listTests|--collect-only|--co|--no-run|--showConfig|--show-config|--print-config|--init|--watch|--just-print)(?=[\s=]|$)/

/** Whether a check command, as `line` spells it, really verifies. */
const verifies = (line: string) =>
  !NOT_A_RUN.test(line) &&
  !/^(tsc|vue-tsc) (.* )?-v( |$)/.test(line) && // tsc -v is its version
  !/^(vitest|jest) (list|watch)\b/.test(line) &&
  !/^make (.* )?-n( |$)/.test(line)

/** One simple command as `tool args`, with assignments and launchers (npx, uv run, …) dropped. */
function normalize(command: string): string | undefined {
  let words = command.split(/\s+/).filter(Boolean)
  // Variable assignments, and launchers that only start the real tool.
  for (;;) {
    const [first = '', second = ''] = [base(words[0] ?? ''), words[1]]
    const runs2 = (first === 'pnpm' && second === 'exec') || (/^(uv|poetry|pipenv|bundle)$/.test(first) && /^(exec|run)$/.test(second))
    if (words.length > 1 && (/^\w+=/.test(words[0]!) || /^(npx|bunx|node|time|env|exec)$/.test(first))) words = words.slice(1)
    else if (words.length > 2 && runs2) words = words.slice(2)
    else break
  }
  // git's own options come before its subcommand: `git -C /repo push` is a push.
  if (base(words[0] ?? '') === 'git') {
    let i = 1
    while (i < words.length && words[i]!.startsWith('-')) i += /^(-C|-c|--git-dir|--work-tree|--namespace)$/.test(words[i]!) ? 2 : 1
    words = [words[0]!, ...words.slice(i)]
  }
  return words.length === 0 ? undefined : [base(words[0]!), ...words.slice(1)].join(' ')
}

/** Which check one simple command runs, if any, and whether it really verifies. */
function checkOf(command: string): { check: Check; verifies: boolean } | undefined {
  const line = normalize(command)
  if (line === undefined) return undefined
  const check = RULES.find(([, re]) => re.test(line))?.[0]
  return check === undefined ? undefined : { check, verifies: verifies(line) }
}

// Commands that deliver work: pushing, merging, publishing, releasing, deploying.
const DELIVERY =
  /^(git (push|merge)|gh (pr merge|release create)|(npm|pnpm|yarn|cargo|gem|twine) (publish|upload)|docker push|kubectl (apply|rollout)|terraform apply|helm (upgrade|install)|(fly|vercel|netlify|firebase|serverless|sls|wrangler) deploy)\b/

/** Whether a Bash command delivers work in any of its parts, whatever its outcome. */
function delivers(command: string): boolean {
  const flat = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'Q').replace(/\d*>&\d*|&>|<&\d*/g, ' ')
  return flat.split(/&&|\|\||[|;&\n]/).some(part => DELIVERY.test(normalize(part.trim()) ?? ''))
}

/** How a Bash call ended: exit 0, an error exit, or an end that says nothing (interrupted, backgrounded). */
type Outcome = 'ok' | 'failed' | 'unclear'

/**
 * What a Bash command's outcome says about the checks it touched: passed or
 * failed when it speaks for them, unknown when a check ran but its result
 * can't be told; nothing for commands that touch no check.
 */
function observe(command: string, outcome: Outcome): [Check, Observed][] {
  const flat = command
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, 'Q') // quoted text cannot split commands
    .replace(/\d*>&\d*|&>|<&\d*/g, ' ') // redirections, not operators
  const parts = flat.split(/&&|\|\||[|;&\n]/).map(s => s.trim()).filter(Boolean)
  const seen = parts.map(checkOf)
  const touched = [...new Set(seen.flatMap(s => (s ? [s.check] : [])))]
  const unknown = () => touched.map((c): [Check, Observed] => [c, 'unknown'])
  if (touched.length === 0) return []
  // Pipes, ; lists, || and background jobs: the exit status may belong to another command.
  if (outcome === 'unclear' || /[|;&\n]/.test(flat.replace(/&&/g, ''))) return unknown()
  // Success: every part of the && chain ran and exited 0; a check passed if a real run of it did.
  if (outcome === 'ok') {
    return touched.map((c): [Check, Observed] => [c, seen.some(s => s?.check === c && s.verifies) ? 'passed' : 'unknown'])
  }
  // Failure: only a lone real run is to blame; in a chain, any step (a cd, a source) may have failed.
  return parts.length === 1 && seen[0]!.verifies ? [[seen[0]!.check, 'failed']] : unknown()
}

// ——— Judging ———

type Checks = Record<Check, Observed>
type Turn = {
  prompt: string
  answer: string
  errors: string[]
  errorCount: number
  checks: Checks
  /** The turn ran a delivery command (push, merge, publish, deploy). */
  delivered: boolean
  /** The last turn judged had active work: a ship answer other than n/a. */
  activeBefore: boolean
}

type ClaudeView = 'summary' | 'summary-then-conversation' | 'conversation'

type Settings = {
  apiKey: unknown
  questions: Question[]
  taskBelow: number
  shipBelow: number
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
  const why = a.note ? ` · ${a.note}` : ''
  if (a.source === 'claude') {
    const who = a.via === 'conversation' ? 'Claude, session context' : 'Claude'
    return ` · ${who} (${typeof a.confidence === 'number' ? `Jev ${pct(a.confidence)}` : (a.error ?? 'Jev unsure')})${why}`
  }
  if (typeof a.confidence === 'number') return ` ${pct(a.confidence)}${why}`
  return a.choice === 'error' && a.error ? ` (${a.error})` : why
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

/**
 * Claude's answers to `qs` and which view gave each; questions it could not tell
 * are left out. The task question goes through `claude_view`; ship and verification
 * are about the session's active work, which only the session context shows, so they
 * go there.
 */
async function askClaude($: EngineInterface, s: Settings, turn: Turn, qs: Question[]) {
  const picked: Partial<Record<Question, { choice: string; via: 'summary' | 'conversation' }>> = {}
  const sessionWide = (q: Question) => q === 'ship' || q === 'verification'
  let task = qs.filter(q => !sessionWide(q))
  if (task.length > 0 && s.claudeView !== 'conversation') {
    const summary = await reviewSummary($, s, turn, task).catch((): Picks => ({}))
    for (const q of task) if (summary[q] !== undefined) picked[q] = { choice: summary[q]!, via: 'summary' }
    // The summary was not enough (unless the person wants the summary alone).
    task = s.claudeView === 'summary' ? [] : task.filter(q => picked[q] === undefined)
  }
  const forked = [...task, ...qs.filter(sessionWide)]
  if (forked.length === 0) return picked
  const whole = await reviewConversation($, forked).catch((): Picks => ({}))
  for (const q of forked) if (whole[q] !== undefined) picked[q] = { choice: whole[q]!, via: 'conversation' }
  return picked
}

async function judge($: EngineInterface, s: Settings, turn: Turn): Promise<Verdict> {
  const qs = s.questions
  const key = await apiKey($, s.apiKey)
  const jev = key ? await askJev($, key, turn, qs) : allAre(qs, { choice: 'nokey', source: 'jev' })

  // Verification shares ship's threshold; production also has its own, stricter one.
  const below = (q: Question, a: Answer) =>
    q === 'status' ? s.taskBelow : a.choice === 'production' ? Math.max(s.shipBelow, s.productionBelow) : s.shipBelow
  const unsure = (q: Question, a: Answer) =>
    !failedAnswer(a) && typeof a.confidence === 'number' && a.confidence * 100 < below(q, a)
  // Jev sees only this turn. A turn that pushes, merges or deploys delivers work from earlier
  // turns, and an n/a right after a turn with active work may only be approving it: in both,
  // Jev's confidence says nothing about that work, so ship is reviewed from the session context.
  const continues = (q: Question, a: Answer) =>
    !failedAnswer(a) &&
    s.shipBelow > 0 &&
    ((q === 'ship' && (turn.delivered || (turn.activeBefore && a.choice === 'na'))) ||
      (q === 'verification' && turn.delivered))
  const asked = (q: Question) =>
    unsure(q, jev[q]!) || continues(q, jev[q]!) || (failedAnswer(jev[q]!) && s.claudeOnJevFailure)
  // Verification only gates a production answer. It is reviewed with ship, so the gate never weighs
  // a session-wide ship against a turn-local check, or on its own when Jev's ship is production.
  const shipReviewed = qs.includes('ship') && asked('ship')
  const toClaude = qs.filter(q =>
    q === 'verification' ? shipReviewed || (asked(q) && jev.ship?.choice === 'production') : asked(q),
  )
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
        confidence: failedAnswer(j) ? undefined : j.confidence,
        error: failedAnswer(j) ? (j.choice === 'nokey' ? 'no Jev key' : `Jev ${j.error ?? 'error'}`) : undefined,
      }
    } else if (q !== 'status' && toClaude.includes(q) && (unsure(q, j) || continues(q, j))) {
      // Fail closed: a ship or verification answer Jev couldn't be trusted on, and Claude couldn't settle, is not Jev's.
      answers[q] = { choice: 'review', source: 'jev', suggested: { choice: j.choice, by: 'jev', confidence: j.confidence } }
    } else {
      answers[q] = j // the task row keeps Jev's answer; a failed ship row stays an error
    }
  }

  if (answers.ship !== undefined) answers.ship = gate(answers.ship, answers.verification, turn.checks)
  return answers as Verdict
}

/**
 * The ship answer shown: production only with verification complete and no check
 * seen failing. Incomplete verification (or a failed check) lowers it to
 * development; verification unknown or unsettled turns it into needs review.
 * Every other answer passes unchanged.
 */
function gate(ship: Answer, verification: Answer | undefined, checks: Checks): Answer {
  if (ship.choice !== 'production') return ship
  const broken = CHECKS.filter(c => checks[c] === 'failed')
  const lowered = (why: string): Answer => ({ ...ship, choice: 'development', note: `production gated: ${why}` })
  if (broken.length > 0) return lowered(`observed ${broken.join(', ')} failed`)
  const v = verification?.choice
  if (v === 'complete') return ship
  if (v === 'incomplete') return lowered('verification incomplete')
  return {
    choice: 'review',
    source: ship.source,
    suggested: { choice: 'production', by: ship.source, confidence: ship.source === 'jev' ? ship.confidence : undefined },
    note: v === 'unknown' ? 'verification unknown' : 'verification not settled',
  }
}

/** One evaluation as toast words: its choice, and its confidence or who answered. */
function said(look: Look, a: Answer) {
  if (a.choice === 'review') return `${look.words} (${detail(a).slice(3)})`
  const why = a.note ? ` · ${a.note}` : ''
  return a.source === 'jev' && typeof a.confidence === 'number' ? `${look.words} (${pct(a.confidence)})${why}` : `${look.words}${detail(a)}`
}

/** A boolean option, or undefined when unset (an unset field arrives as an empty string). */
const booleanOption = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)

/** A number option, or undefined when unset or not a number. */
function numberOption(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

export const register: Register = (on, options) => {
  const below = numberOption(options.claude_below) ?? DEFAULT_BELOW
  // ship_check and ship_below replaced 0.6's deploy_check and deploy_below, which stay declared so
  // a value set under the old name still arrives here and applies while the new one is unset.
  const shipBelow = numberOption(options.ship_below) ?? numberOption(options.deploy_below) ?? below
  const shipCheck = booleanOption(options.ship_check) ?? booleanOption(options.deploy_check)
  const settings: Settings = {
    apiKey: options.api_key,
    questions: shipCheck === false ? ['status'] : ['status', 'ship', 'verification'],
    taskBelow: numberOption(options.task_below) ?? below,
    shipBelow,
    productionBelow: numberOption(options.production_below) ?? shipBelow,
    claudeView: VIEWS.find(v => v === options.claude_view) ?? 'summary-then-conversation',
    reviewModel:
      typeof options.review_model === 'string' && options.review_model.trim() ? options.review_model.trim() : 'haiku',
    claudeOnJevFailure: options.claude_on_jev_failure !== false,
  }

  let prompt = ''
  let errors: string[] = []
  let errorCount = 0
  let checks = unknownChecks()
  let delivered = false
  // Whether the last ship answer shown had active work (anything but n/a); Jev errors leave it as it was.
  let activeBefore = false
  // Bumped by every new turn and every judgement started: an older one can't settle.
  let epoch = 0
  // Bumped by every new turn only: tool results are kept for the turn they started in.
  let turnNo = 0
  // The turn each subagent was first seen in: a background one may outlive it.
  const agentTurn = new Map<string, number>()

  on('prompt.submit', async ($, e, next) => {
    epoch += 1
    turnNo += 1
    // A background task's notification starts a turn too, but the request stays the user's last.
    if (e.origin.kind !== 'task-notification') prompt = clip(e.text, MAX_PROMPT_CHARS)
    errors = []
    errorCount = 0
    checks = unknownChecks()
    delivered = false
    // Bookkeeping only: a failure here must never hold up the prompt.
    await Promise.all([update($, verdict, () => null), update($, phase, (): Phase => 'running')]).catch(() => {})

    return next(e)
  })
    // A failure in this hook passes the prompt through as if the plugin were absent.
    .catch(() => undefined)

  on('tool.call', async ($, e, next) => {
    const started = turnNo
    if (e.agentId !== undefined && !agentTurn.has(e.agentId)) agentTurn.set(e.agentId, started)
    const ran = await next(e)
    try {
      // Only this turn's own work: not a call that outlived its turn, nor an earlier turn's background subagent.
      const owner = e.agentId === undefined ? started : agentTurn.get(e.agentId)
      if (started === turnNo && owner === turnNo) record(e, ran)
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
      const unclear =
        out.interrupted === true || out.backgroundTaskId !== undefined || out.timedOutAfterMs !== undefined ||
        out.returnCodeInterpretation !== undefined ||
        (ran.isError === true && /interrupt|timed out|background/i.test(ran.text ?? ''))
      const outcome: Outcome = unclear ? 'unclear' : ran.isError === true ? 'failed' : 'ok'
      for (const [c, o] of observe(e.command, outcome)) checks[c] = o
      if (delivers(e.command)) delivered = true
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
    const turn: Turn = { prompt, answer: clip(e.answer, MAX_ANSWER_CHARS), errors, errorCount, checks: { ...checks }, delivered, activeBefore }
    await update($, phase, (): Phase => 'checking')

    let settled = false
    const settle = async (v: Verdict) => {
      // A newer turn started, or this one already settled.
      if (mine !== epoch || settled) return
      settled = true
      await update($, verdict, () => v)
      await update($, phase, (): Phase => 'idle')
      const shipped = v.ship?.choice
      if (shipped !== undefined && shipped !== 'nokey' && shipped !== 'error') activeBefore = shipped !== 'na'
      if (options.toast !== false && v.status.choice !== 'nokey') {
        const ship = v.ship ? ` · ship: ${said(LOOK.ship[v.ship.choice], v.ship)}` : ''
        $.ui.toast(`${said(LOOK.status[v.status.choice], v.status)}${ship}`)
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
    const { status, ship } = v
    // Without a key, or when Jev failed for both, the ship row would only repeat the status row.
    const showShip =
      ship !== undefined &&
      ship.choice !== 'nokey' &&
      !(ship.choice === 'error' && status.choice === 'error' && ship.error === status.error)

    return (
      <Box flexDirection="column">
        {row(showShip ? 'JEV task: ' : 'JEV: ', LOOK.status, status)}
        {showShip ? row('JEV ship: ', LOOK.ship, ship) : null}
      </Box>
    )
  })
}
