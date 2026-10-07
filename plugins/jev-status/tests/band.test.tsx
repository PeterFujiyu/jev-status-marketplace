import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpInit, ModelCompleteRequest, ModelCompleteResult, On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
}
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

type Sent = { url: string; init?: HttpInit }
type JevReply = { status: number; body: unknown } | 'network' | { raw: string }
type Check = 'tests' | 'build' | 'typecheck' | 'lint'
type State = {
  user_request: string
  agent_final_message: string
  tool_errors: string[]
  tool_error_count: number
  observed_checks: Record<string, string>
}

const jevSays = (
  status: string,
  confidence: number,
  ship: [string, number] = ['production', 0.9],
  verification: [string, number] = ['complete', 0.95],
): JevReply => ({
  status: 200,
  body: {
    answers: {
      status: { type: 'choice', choice: status, confidence },
      ship: { type: 'choice', choice: ship[0], confidence: ship[1] },
      verification: { type: 'choice', choice: verification[0], confidence: verification[1] },
    },
  },
})

// What the engine beneath the plugin answers. Each can change between turns.
type Replies = {
  /** TypeSafe's answer, or one per request from the state it was sent. */
  jev: JevReply | ((state: State) => JevReply)
  /** The summary review's reply; 'refuse' is an API error. */
  claude: string
  /** The session-context review's reply; 'refuse' is an API error, 'hang' never answers. */
  session: string
}

// The engine beneath the plugin: TypeSafe, both Claude reviews, Bash, toasts,
// the environment (HOME=/h unless given) and pass-through answers.
function world(
  on: On,
  jev: Replies['jev'],
  claude = 'status: failed\nship: blocked',
  session = claude,
  env: Record<string, string> = { HOME: '/h' },
) {
  const replies: Replies = { jev, claude, session }
  const sent: Sent[] = []
  const completes: ModelCompleteRequest[] = []
  const forks: string[] = []
  const toasts: string[] = []
  const looked: string[] = []
  // A Bash command containing SLOW waits until release() is called.
  let release = () => {}
  const gate = new Promise<void>(resolve => (release = resolve))
  const reply = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })
  const refused: ModelCompleteResult = { isAnswered: false, reason: 'api-error', status: 529, error: 'overloaded', usage: USAGE }

  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.env(on, env)
  on('fs.exists', (_$, e) => {
    looked.push(e.path)
    return { value: false }
  })
  on('http.fetch', (_$, e) => {
    sent.push(e)
    const state = JSON.parse(e.init?.body ?? '{}').state as State
    const r = typeof replies.jev === 'function' ? replies.jev(state) : replies.jev
    if (r === 'network') throw new Error('connect ECONNREFUSED')
    if ('raw' in r) return { value: { status: 200, ok: true, headers: {}, text: r.raw } }
    return { value: { status: r.status, ok: r.status < 300, headers: {}, text: JSON.stringify(r.body) } }
  })
  on('model.complete', (_$, e) => {
    completes.push(e)
    if (replies.claude === 'refuse') return { value: refused }
    return { value: reply(replies.claude) }
  })
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    if (replies.session === 'refuse') return { value: refused }
    if (replies.session === 'hang') return new Promise(() => {})
    return { value: reply(replies.session) }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash' && /SLOW/.test(e.command)) await gate
    const fails = e.tool === 'Bash' && /FAIL/.test(e.command)
    // NONZERO: a non-zero exit Claude Code interprets as no error.
    const nonzero = e.tool === 'Bash' && /NONZERO/.test(e.command)
    return fails
      ? { isError: true as const, result: 'Exit code 1', text: `Exit code 1\n${e.tool} failed` }
      : {
          result: { stdout: '', stderr: '', interrupted: false, ...(nonzero ? { returnCodeInterpretation: 'exit 1' } : {}) },
          text: 'ok',
        }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  const body = (i = sent.length - 1) => JSON.parse(sent[i]!.init?.body ?? '{}')
  return { replies, sent, body, completes, forks, toasts, looked, clock, release: () => release() }
}

type TurnSpec = {
  prompt?: string
  answer?: string
  reason?: 'answer' | 'aborted'
  /**
   * Bash commands the agent runs; FAIL in one exits with an error, NONZERO exits
   * non-zero read as no error, SLOW waits for release().
   */
  bash?: string[]
}

async function runTurn($: Engine, t: TurnSpec = {}) {
  await $.prompt.submit({ text: t.prompt ?? 'Deploy the app to staging.', wait: false, origin: { kind: 'composer' } })
  for (const command of t.bash ?? []) await $.tool.call({ tool: 'Bash', command })
  const reason = t.reason ?? 'answer'
  await $.turn.complete({
    answer: t.answer ?? 'Which AWS profile should I use, staging-admin or staging-ci?',
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId: 't1',
    reason,
  })
}

async function bandText($: Engine, surface: (typeof SURFACES)[number]) {
  const band = await $.ui.mount({ plugin: 'jev-status', surface, component: 'AbovePrompt', props: PROPS })
  const texts = (await band.findAll({ type: 'Text' })).map(t => t.text).join('')
  await band.unmount()
  return texts
}

async function expectBand($: Engine, ...texts: string[]) {
  for (const surface of SURFACES) {
    const band = await bandText($, surface)
    for (const text of texts) expect(band).toContain(text)
  }
}

async function retryButton($: Engine, surface: (typeof SURFACES)[number]) {
  const band = await $.ui.mount({ plugin: 'jev-status', surface, component: 'AbovePrompt', props: PROPS })
  const found = await band.find({ key: 'retry' })
  await band.unmount()
  return found
}

async function expectNoBand($: Engine) {
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('JEV')
}

const KEY = { api_key: 'k-test' }
const NO_FALLBACK = { api_key: 'k-test', claude_on_jev_failure: false }

// ——— Jev alone ———

test('a confident Jev answers both questions alone', { options: KEY }, async ($, on) => {
  const { sent, body, completes, forks, toasts, clock } = world(on, jevSays('needaction', 0.9, ['blocked', 0.95]))
  await runTurn($)

  await expectBand($, 'checking')
  await clock.settle()

  expect(sent.length).toBe(1)
  expect(sent[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(sent[0]!.init?.headers?.Authorization).toBe('Bearer k-test')
  const b = body()
  expect(b.state).toEqual({
    user_request: 'Deploy the app to staging.',
    agent_final_message: 'Which AWS profile should I use, staging-admin or staging-ci?',
    tool_errors: [],
    tool_error_count: 0,
    observed_checks: { tests: 'unknown', build: 'unknown', typecheck: 'unknown', lint: 'unknown' },
  })
  expect(Object.keys(b.questions)).toEqual(['status', 'ship', 'verification'])
  expect(Object.keys(b.questions.verification.criteria)).toEqual(['complete', 'incomplete', 'unknown'])
  expect(Object.keys(b.questions.status.criteria)).toEqual(['done', 'needaction', 'failed'])
  expect(Object.keys(b.questions.ship.criteria)).toEqual(['production', 'development', 'blocked', 'na'])
  expect(b.questions.status.instructions).toContain('may have resolved them later')
  expect(b.questions.ship.instructions).toContain('not whether the agent waits on the user')
  expect(b.questions.ship.instructions).toContain('current active work represented by this session')
  expect(b.questions.ship.instructions).toContain('work created or verified before this turn is still active')

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'JEV task:', 'needs action 90%', 'JEV ship:', 'blocked 95%')
  expect(toasts).toEqual(['needs action (90%) · ship: blocked (95%)'])
})

test('a greeting is needaction with n/a', { options: KEY }, async ($, on) => {
  const { toasts, clock } = world(on, jevSays('needaction', 0.97, ['na', 0.96]))
  await runTurn($, { prompt: 'Hi', answer: 'Hi! What can I help you with?' })
  await clock.settle()

  await expectBand($, '● needs action 97%', '– n/a 96%')
  expect(toasts).toEqual(['needs action (97%) · ship: n/a (96%)'])
})

test('task and ship combine freely', { options: KEY }, async ($, on) => {
  // An n/a after a turn with active work is reviewed; here the review agrees.
  const { replies, clock } = world(on, jevSays('done', 0.9), 'unused', 'ship: na')
  const combos: [string, string, string, string][] = [
    ['done', 'production', '✔ done 90%', '▲ production 90%'],
    ['done', 'development', '✔ done 90%', '◆ development 90%'],
    ['done', 'na', '✔ done 90%', '– n/a'],
    ['needaction', 'production', '● needs action 90%', '▲ production 90%'], // ready, waiting for a go-ahead
    ['needaction', 'na', '● needs action 90%', '– n/a'],
    ['failed', 'blocked', '✘ failed 90%', '■ blocked 90%'],
    ['done', 'blocked', '✔ done 90%', '■ blocked 90%'], // finished, but a risky migration
  ]
  for (const [task, ship, taskText, shipText] of combos) {
    replies.jev = jevSays(task, 0.9, [ship, 0.9])
    await runTurn($)
    await clock.settle()
    await expectBand($, taskText, shipText)
  }
})

// ——— Claude's second opinion ———

test('an unsure task goes to Claude with the default model, alone', { options: KEY }, async ($, on) => {
  const { completes, forks, toasts, clock } = world(on, jevSays('done', 0.55), 'status: needaction')
  await runTurn($)
  await clock.settle()

  expect(forks.length).toBe(0)
  expect(completes.length).toBe(1)
  expect(completes[0]!.model).toBe('haiku')
  expect(completes[0]!.system).toContain('needaction')
  expect(completes[0]!.system).not.toContain('production')
  expect(JSON.parse(completes[0]!.prompt).observed_checks.tests).toBe('unknown')

  await expectBand($, 'needs action · Claude (Jev 55%)', 'production 90%')
  expect(toasts).toEqual(['needs action · Claude (Jev 55%) · ship: production (90%)'])
})

test('an unsure ship answer goes straight to the session context', { options: KEY }, async ($, on) => {
  const { completes, forks, toasts, clock } = world(on, jevSays('done', 0.95, ['production', 0.33]), 'unused', 'ship: development')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(0)
  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('ship: <choice>')
  expect(forks[0]).not.toContain('needaction')
  await expectBand($, 'done 95%', 'development · Claude, session context (Jev 33%)')
  expect(toasts).toEqual(['done (95%) · ship: development · Claude, session context (Jev 33%)'])
})

test("a ship answer the session context can't settle needs review, not Jev's guess", { options: KEY }, async ($, on) => {
  const { completes, forks, toasts, clock } = world(on, jevSays('done', 0.95, ['production', 0.35]), 'unused', 'ship: unclear')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(0)
  expect(forks.length).toBe(1)
  await expectBand($, 'JEV ship: ', '? needs review', ' · Jev suggested production 35%')
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('▲')
  expect(toasts).toEqual(['done (95%) · ship: needs review (Jev suggested production 35%)'])
})

test('a deploy review that fails or hangs also needs review', { options: KEY }, async ($, on) => {
  const { replies, forks, clock } = world(on, jevSays('done', 0.95, ['development', 0.4]), 'refuse', 'refuse')
  await runTurn($)
  await clock.settle()
  await expectBand($, '? needs review · Jev suggested development 40%')

  replies.session = 'hang'
  await runTurn($)
  await clock.settle()
  await expectBand($, 'checking')
  await clock.advance(91_000) // past the session-context review's time limit
  expect(forks.length).toBe(2)
  await expectBand($, '? needs review · Jev suggested development 40%')
})

test("an unsettled task keeps Jev's low-confidence answer", { options: KEY }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('done', 0.5), 'I am not sure', 'status: unclear')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  expect(forks.length).toBe(1)
  await expectBand($, 'JEV task: ✔ done 50%')
})

test('both reviews may answer unclear', { options: KEY }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('done', 0.5), 'status: unclear', 'status: unclear')
  await runTurn($)
  await clock.settle()

  expect(completes[0]!.system).toContain('or unclear when you cannot tell')
  expect(forks[0]).toContain('or unclear when you cannot tell')
})

test(
  'the conversation view forks the session instead',
  { options: { ...KEY, claude_view: 'conversation' } },
  async ($, on) => {
    const { completes, forks, clock } = world(on, jevSays('done', 0.4), 'status: failed', 'status: done')
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(0)
    expect(forks.length).toBe(1)
    await expectBand($, 'done · Claude, session context (Jev 40%)')
  },
)

test('when the summary is not enough, the session context is read', { options: KEY }, async ($, on) => {
  const { completes, forks, toasts, clock } = world(on, jevSays('done', 0.55), 'status: unclear', 'status: failed')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  expect(forks.length).toBe(1)
  await expectBand($, 'failed · Claude, session context (Jev 55%)')
  expect(toasts).toEqual(['failed · Claude, session context (Jev 55%) · ship: production (90%)'])
})

test('only the questions the summary could not answer go to the session context', { options: KEY }, async ($, on) => {
  const { forks, clock } = world(
    on,
    jevSays('done', 0.5, ['production', 0.3]),
    'status: done\nship: unclear',
    'ship: blocked',
  )
  await runTurn($)
  await clock.settle()

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('ship: <choice>')
  expect(forks[0]).not.toContain('needaction')
  await expectBand($, 'done · Claude (Jev 50%)', 'blocked · Claude, session context (Jev 30%)')
})

test(
  'the summary-only view keeps the task on the summary; ship still reads the session context',
  { options: { ...KEY, claude_view: 'summary' } },
  async ($, on) => {
    const { completes, forks, clock } = world(on, jevSays('done', 0.55, ['production', 0.5]), 'status: unclear', 'ship: unclear')
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(1)
    expect(forks.length).toBe(1)
    expect(forks[0]).not.toContain('needaction')
    await expectBand($, 'done 55%', '? needs review · Jev suggested production 50%')
  },
)

// ——— Active work across turns ———

test('"yes, push it" after earlier work is judged as that work, not n/a', { options: KEY }, async ($, on) => {
  const { replies, body, forks, clock } = world(on, jevSays('done', 0.95, ['production', 0.92]))
  // Earlier turn: the change is made and verified.
  await runTurn($, { prompt: 'Fix the login bug.', bash: ['npm test', 'npm run build'], answer: 'Fixed it; tests and build pass.' })
  await clock.settle()
  await expectBand($, '▲ production 92%')

  // This turn has no edits of its own; Jev, seeing only it, leans n/a without confidence.
  replies.jev = jevSays('done', 0.97, ['na', 0.4])
  const outcomes: [string, string][] = [
    ['ship: production\nverification: complete', '▲ production · Claude, session context (Jev 40%)'],
    ['ship: development\nverification: incomplete', '◆ development · Claude, session context (Jev 40%)'],
    ['ship: blocked\nverification: incomplete', '■ blocked · Claude, session context (Jev 40%)'],
    ['ship: unclear\nverification: complete', '? needs review · Jev suggested na 40%'],
  ]
  for (const [reply, shown] of outcomes) {
    replies.session = reply
    await runTurn($, { prompt: 'yes, push it', bash: ['git push origin main'], answer: 'Pushed 3 commits to origin/main.' })
    await clock.settle()
    await expectBand($, shown)
    for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('– n/a')
  }

  // The Jev question and the session-context review both say earlier turns count.
  const { questions } = body()
  expect(questions.ship.instructions).toContain('current active work represented by this session')
  expect(questions.ship.criteria.na).toContain('not na when it pushes, merges, releases, approves or otherwise continues')
  const prompt = forks.at(-1)!
  expect(prompt).toContain(
    'Review the current session context and judge the latest active deliverable work, not just the most recent turn.',
  )
  expect(prompt).toContain(
    'Work created or verified in earlier turns still counts if the current turn is pushing, merging, releasing, approving, or otherwise continuing that work.',
  )
  expect(prompt).toContain('Use na only when there is genuinely no active deliverable work in the session.')
})

test('a turn that delivers work sends ship to the session context even when Jev is sure', { options: KEY }, async ($, on) => {
  const { replies, forks, clock } = world(on, jevSays('done', 0.98, ['development', 0.99]), 'unused', 'ship: production\nverification: complete')
  const turn = (bash: string[]) => runTurn($, { prompt: 'push it', bash, answer: 'Done, pushed.' })

  // Jev sees only this turn, so it is sure of development; the session context shows the earlier verification.
  await turn(['git push origin main'])
  await clock.settle()
  expect(forks.length).toBe(1)
  expect(forks[0]).not.toContain('needaction')
  await expectBand($, '▲ production · Claude, session context (Jev 99%)')

  // When the review can't tell, or fails, Jev's confidence counts for nothing here: needs review.
  for (const reply of ['ship: unclear', 'refuse']) {
    replies.session = reply
    await turn(['git push'])
    await clock.settle()
    await expectBand($, '? needs review · Jev suggested development 99%')
  }
  replies.jev = jevSays('done', 0.98, ['na', 0.97])
  await turn(['git push'])
  await clock.settle()
  await expectBand($, '? needs review · Jev suggested na 97%')
  replies.jev = jevSays('done', 0.98, ['development', 0.99])
  replies.session = 'ship: production\nverification: complete'
  for (const command of ['git -C /repo push', 'git -c http.extraHeader=x --no-pager push origin main', 'git --git-dir .git --work-tree . merge feat', 'gh pr merge 42 --squash', 'cd app && git push -u origin feat', 'npm publish', 'GIT_TRACE=1 git push 2>&1 | tail -3', 'terraform apply -auto-approve', 'git merge feat FAIL']) {
    const before = forks.length
    await turn([command])
    await clock.settle()
    expect(forks.length).toBe(before + 1)
  }
  for (const command of ['git status', 'git -C /repo status', 'git log --oneline | head', 'echo git push', 'git commit -m "wip; git push later"']) {
    const before = forks.length
    await turn([command])
    await clock.settle()
    expect(forks.length).toBe(before)
  }
})

test('an n/a right after a turn with active work is reviewed, even when Jev is sure', { options: KEY }, async ($, on) => {
  const { replies, forks, clock } = world(on, jevSays('done', 0.95, ['production', 0.92]), 'unused', 'ship: production\nverification: complete')
  await runTurn($, { prompt: 'Fix the login bug.', bash: ['npm test'], answer: 'Fixed; tests pass.' })
  await clock.settle()
  expect(forks.length).toBe(0)

  // The next turn only approves the work: no command, and Jev, seeing only it, is sure of n/a.
  replies.jev = jevSays('done', 0.97, ['na', 0.96])
  await runTurn($, { prompt: 'Approved, ship it.', answer: 'Great, it is approved and ready.' })
  await clock.settle()
  expect(forks.length).toBe(1)
  await expectBand($, '▲ production · Claude, session context (Jev 96%)')

  // The review finds the session really has nothing active: n/a, and the next confident n/a stands.
  replies.session = 'ship: na'
  await runTurn($, { prompt: 'Thanks! Unrelated: what is a monad?', answer: 'A monad is …' })
  await clock.settle()
  expect(forks.length).toBe(2)
  await expectBand($, '– n/a · Claude, session context (Jev 96%)')
  await runTurn($, { prompt: 'And a functor?', answer: 'A functor is …' })
  await clock.settle()
  expect(forks.length).toBe(2)
  await expectBand($, '– n/a 96%')
})

test('a threshold of 0 opts delivery turns out of the review too', { options: { ...KEY, claude_below: 0 } }, async ($, on) => {
  const { forks, clock } = world(on, jevSays('done', 0.98, ['development', 0.99]), 'unused', 'ship: production')
  await runTurn($, { prompt: 'push it', bash: ['git push'], answer: 'Pushed.' })
  await clock.settle()

  expect(forks.length).toBe(0)
  await expectBand($, '◆ development 99%')
})

test('a confident n/a stands without a review', { options: KEY }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('needaction', 0.97, ['na', 0.96]))
  await runTurn($, { prompt: 'Hi', answer: 'Hi! What can I help you with?' })
  await clock.settle()

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'JEV ship: – n/a 96%')
})

test('an unsure task and ship share one session-context review', { options: KEY }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('done', 0.5, ['na', 0.3]), 'status: unclear', 'status: failed\nship: blocked')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('status: <choice>')
  expect(forks[0]).toContain('ship: <choice>')
  await expectBand($, 'failed · Claude, session context (Jev 50%)', 'blocked · Claude, session context (Jev 30%)')
})

// ——— Verification gate ———

test('production needs verification complete', { options: KEY }, async ($, on) => {
  const { replies, completes, forks, toasts, clock } = world(on, jevSays('done', 0.95, ['production', 0.92], ['complete', 0.9]))
  const turn = async (answer: string) => {
    await runTurn($, { prompt: 'Add the export button.', answer })
    await clock.settle()
  }

  // 1. Implementation complete, all relevant checks passed: production stands.
  await turn('Added the export button; unit and e2e tests pass and the build is green.')
  await expectBand($, 'JEV ship: ▲ production 92%')

  // 2. One manual runtime check remains: development, not production.
  replies.jev = jevSays('done', 0.95, ['production', 0.92], ['incomplete', 0.88])
  await turn('Added the export button; tests pass. Still manual: checking the download in Safari.')
  await expectBand($, 'JEV ship: ◆ development 92% · production gated: verification incomplete')
  expect(toasts.at(-1)).toBe('done (95%) · ship: development (92%) · production gated: verification incomplete')

  // 3. Integration/runtime verification unchecked: development.
  replies.jev = jevSays('done', 0.95, ['production', 0.9], ['incomplete', 0.93])
  await turn('Implemented the S3 upload. Unit tests pass; integration against the real bucket is unchecked.')
  await expectBand($, '◆ development 90% · production gated: verification incomplete')
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('▲')
  expect(completes.length + forks.length).toBe(0)
})

test('the session context may confirm production, but not past incomplete verification', { options: KEY }, async ($, on) => {
  // 4. Jev: production, unsure. The session context says production, but verification incomplete.
  const { forks, clock } = world(
    on,
    jevSays('done', 0.95, ['production', 0.45], ['incomplete', 0.5]),
    'unused',
    'ship: production\nverification: incomplete',
  )
  await runTurn($, { answer: 'Done. Requires manual testing on a real device before release.' })
  await clock.settle()

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('verification: <choice>')
  expect(forks[0]).toContain('including for work you did yourself')
  await expectBand($, '◆ development · Claude, session context (Jev 45%) · production gated: verification incomplete')
})

test('verification still unknown after the review is never green production', { options: KEY }, async ($, on) => {
  // 5. Jev unsure of verification; the session context can't tell either.
  const { replies, forks, clock } = world(
    on,
    jevSays('done', 0.95, ['production', 0.95], ['unknown', 0.4]),
    'unused',
    'verification: unclear',
  )
  await runTurn($)
  await clock.settle()
  expect(forks.length).toBe(1)
  expect(forks[0]).not.toContain('ship: <choice>') // ship was confident; only verification is reviewed
  await expectBand($, '? needs review · Jev suggested production 95%, but verification not settled')

  // A confident unknown needs no review, and still isn't production.
  replies.jev = jevSays('done', 0.95, ['production', 0.95], ['unknown', 0.9])
  await runTurn($)
  await clock.settle()
  expect(forks.length).toBe(1)
  await expectBand($, '? needs review · Jev suggested production 95%, but verification unknown')

  // Nor is a failed review.
  replies.jev = jevSays('done', 0.95, ['production', 0.95], ['unknown', 0.4])
  replies.session = 'refuse'
  await runTurn($)
  await clock.settle()
  await expectBand($, '? needs review · Jev suggested production 95%, but verification not settled')
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('▲')
})

test('the gate only touches production', { options: KEY }, async ($, on) => {
  const { replies, clock } = world(on, jevSays('done', 0.95))
  const cases: [[string, number], [string, number], string][] = [
    // 6. Pure research: n/a whatever verification says.
    [['na', 0.97], ['unknown', 0.9], '– n/a 97%'],
    [['blocked', 0.9], ['complete', 0.9], '■ blocked 90%'],
    [['blocked', 0.9], ['incomplete', 0.9], '■ blocked 90%'],
    [['development', 0.9], ['unknown', 0.9], '◆ development 90%'],
    [['development', 0.9], ['complete', 0.9], '◆ development 90%'],
  ]
  for (const [ship, verification, shown] of cases) {
    replies.jev = jevSays('done', 0.95, ship, verification)
    await runTurn($, { prompt: 'What is a monad?', answer: 'A monad is …' })
    await clock.settle()
    await expectBand($, `JEV ship: ${shown}`)
    for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('gated')
  }
})

test('an unsure verification is only reviewed when it could gate production', { options: KEY }, async ($, on) => {
  const { replies, completes, forks, clock } = world(on, jevSays('done', 0.95, ['na', 0.97], ['unknown', 0.4]), 'unused', 'verification: complete')
  for (const ship of [['na', 0.97], ['development', 0.9], ['blocked', 0.9]] as [string, number][]) {
    replies.jev = jevSays('done', 0.95, ship, ['unknown', 0.4])
    await runTurn($, { prompt: 'How does the cache work?', answer: 'It keys on the request hash.' })
    await clock.settle()
  }
  expect(completes.length + forks.length).toBe(0)

  replies.jev = jevSays('done', 0.95, ['production', 0.95], ['unknown', 0.4])
  await runTurn($)
  await clock.settle()
  expect(forks.length).toBe(1)
  await expectBand($, '▲ production 95%')
})

test('verification goes to the session context with ship', { options: KEY }, async ($, on) => {
  // Ship unsure, verification confident: both are reviewed, so the gate weighs like with like.
  const { forks, clock } = world(
    on,
    jevSays('done', 0.95, ['production', 0.5], ['complete', 0.95]),
    'unused',
    'ship: production\nverification: incomplete',
  )
  await runTurn($)
  await clock.settle()

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('ship: <choice>')
  expect(forks[0]).toContain('verification: <choice>')
  await expectBand($, '◆ development · Claude, session context (Jev 50%) · production gated: verification incomplete')
})

test('the verification rubric names pending checks, for Jev and the session context', { options: KEY }, async ($, on) => {
  const { body, completes, forks, clock } = world(
    on,
    jevSays('done', 0.5, ['production', 0.5], ['unknown', 0.5]),
    'status: unclear',
    'status: done\nship: production\nverification: complete',
  )
  await runTurn($)
  await clock.settle()

  const phrases = ['still manual', 'unchecked', 'not tested', 'not run', 'pending verification', 'needs validation', 'requires manual testing', 'open checks']
  const criteria = body().questions.verification.criteria.incomplete as string
  for (const phrase of phrases) {
    expect(criteria).toContain(phrase)
    expect(forks[0]).toContain(phrase)
  }
  expect(body().questions.verification.instructions).toContain('Implementation complete does not mean verified.')
  expect(completes[0]!.system).not.toContain('verification: <choice>') // the summary review only takes the task
  await expectBand($, '▲ production · Claude, session context (Jev 50%)')
})

// ——— Reading Claude's replies ———

test('reviewer replies are read strictly, per line', { options: KEY }, async ($, on) => {
  const { replies, clock } = world(on, jevSays('done', 0.5, ['production', 0.5]))
  // The task goes to the summary review first, ship to the session context; both read the same reply here.
  const cases: [string, string[]][] = [
    ['**Status:** needs action\n**Ship:** Blocked', ['needs action · Claude (Jev 50%)', 'blocked · Claude, session context (Jev 50%)']],
    ['- status: `done`.\n- ship: Development', ['✔ done · Claude (Jev 50%)', 'development · Claude, session context (Jev 50%)']],
    ['Status: needs_action\nShip: N/A', ['needs action · Claude', '– n/a · Claude, session context']],
    ['status: not done\nship: probably production', ['✔ done 50%', '? needs review · Jev suggested production 50%']],
    ['status: done\nship: production might work', ['✔ done · Claude', '? needs review']],
    ['status: done\nship: production\nship: na', ['✔ done · Claude', '? needs review']],
    ['status: done, ship: production', ['✔ done 50%', '? needs review']],
    ['done\nproduction', ['✔ done 50%', '? needs review']],
    ['status: constructor\nship: hasOwnProperty', ['✔ done 50%', '? needs review']],
  ]
  for (const [text, shown] of cases) {
    replies.claude = text
    replies.session = text
    await runTurn($)
    await clock.settle()
    await expectBand($, ...shown)
  }
})

test('a bare one-word reply answers a lone question', { options: KEY }, async ($, on) => {
  const { clock } = world(on, jevSays('done', 0.4, ['production', 0.95]), 'Failed.')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'failed · Claude (Jev 40%)')
})

test(
  'the generic threshold and the review model are configurable',
  { options: { ...KEY, claude_below: 95, review_model: 'sonnet' } },
  async ($, on) => {
    const { completes, clock } = world(on, jevSays('done', 0.9, ['production', 0.96]), 'status: failed')
    await runTurn($)
    await clock.settle()

    expect(completes.map(c => c.model)).toEqual(['sonnet'])
    await expectBand($, 'failed · Claude (Jev 90%)', 'production 96%')
  },
)

test(
  'task and ship thresholds override the generic one',
  { options: { ...KEY, claude_below: 10, task_below: 95, ship_below: 50 } },
  async ($, on) => {
    const { completes, clock } = world(on, jevSays('done', 0.9, ['development', 0.6]), 'status: failed')
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(1)
    expect(completes[0]!.system).not.toContain('production')
    await expectBand($, 'failed · Claude (Jev 90%)', 'development 60%')
  },
)

test(
  'a stricter production threshold only applies to production',
  { options: { ...KEY, production_below: 90 } },
  async ($, on) => {
    const { replies, forks, clock } = world(on, jevSays('done', 0.95, ['development', 0.85]), 'unused', 'ship: development')
    await runTurn($)
    await clock.settle()
    expect(forks.length).toBe(0)
    await expectBand($, 'development 85%')

    replies.jev = jevSays('done', 0.95, ['production', 0.85])
    await runTurn($)
    await clock.settle()
    expect(forks.length).toBe(1)
    await expectBand($, 'development · Claude, session context (Jev 85%)')
  },
)

test('a threshold of 0 never asks Claude', { options: { ...KEY, claude_below: 0 } }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('done', 0.2, ['development', 0.1]))
  await runTurn($)
  await clock.settle()

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'done 20%', 'development 10%')
})

// ——— Jev failures ———

test('with no key Claude stands in for both, and nothing goes to TypeSafe', async ($, on) => {
  const { sent, completes, forks, clock } = world(on, jevSays('done', 1), 'status: needaction', 'ship: na')
  await runTurn($)
  await clock.settle()

  expect(sent.length).toBe(0)
  expect(completes.length).toBe(1)
  expect(forks.length).toBe(1)
  await expectBand($, 'needs action · Claude (no Jev key)', 'n/a · Claude, session context (no Jev key)')
})

test('without HOME no key file is looked for', async ($, on) => {
  const { sent, looked, clock } = world(on, jevSays('done', 1), 'status: done\nship: na', undefined, {})
  await runTurn($)
  await clock.settle()

  expect(looked).toEqual([])
  expect(sent.length).toBe(0)
  await expectBand($, 'done · Claude (no Jev key)')
})

test('an HTTP error hands both over to Claude', { options: { api_key: 'bad' } }, async ($, on) => {
  const { clock } = world(on, { status: 401, body: { error: 'unauthorized' } }, 'status: done', 'ship: development')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'done · Claude (Jev HTTP 401)', 'development · Claude, session context (Jev HTTP 401)')
})

test('a network error hands both over to Claude', { options: KEY }, async ($, on) => {
  const { clock } = world(on, 'network', 'status: done', 'ship: na')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'done · Claude (Jev network error)', 'n/a · Claude, session context (Jev network error)')
})

test('with the fallback off, Jev failures show once, as they are', { options: NO_FALLBACK }, async ($, on) => {
  const { replies, completes, clock } = world(on, { status: 500, body: {} })
  const cases: [JevReply, string][] = [
    [{ status: 500, body: {} }, 'Jev error (HTTP 500)'],
    [{ raw: '<html>gateway</html>' }, 'Jev error (invalid JSON)'],
    [{ status: 200, body: { answers: null } }, 'Jev error (no answers)'],
  ]
  for (const [reply, text] of cases) {
    replies.jev = reply
    await runTurn($)
    await clock.settle()
    await expectBand($, 'JEV: ', text)
    expect((await bandText($, 'terminal')).match(/Jev error/g)?.length).toBe(1)
  }
  expect(completes.length).toBe(0)
})

test('malformed answers are errors, never confident', { options: NO_FALLBACK }, async ($, on) => {
  const { replies, clock } = world(on, jevSays('done', 1))
  const status = (answer: unknown): JevReply => ({
    status: 200,
    body: { answers: { status: answer, ship: { type: 'choice', choice: 'na', confidence: 0.9 } } },
  })
  const cases: [unknown, string][] = [
    [{ type: 'choice', choice: 'done' }, 'bad confidence'],
    [{ type: 'choice', choice: 'done', confidence: '0.9' }, 'bad confidence'],
    [{ type: 'choice', choice: 'done', confidence: 1.5 }, 'bad confidence'],
    [{ type: 'choice', choice: 'done', confidence: -0.1 }, 'bad confidence'],
    [{ type: 'choice', choice: 'done', confidence: null }, 'bad confidence'],
    [{ type: 'number', choice: 'done', confidence: 0.9 }, 'malformed answer'],
    [{ type: 'choice', choice: 'maybe', confidence: 0.9 }, 'malformed answer'],
    [{ type: 'choice', choice: 'toString', confidence: 0.9 }, 'malformed answer'],
    [{ type: 'choice', choice: '__proto__', confidence: 0.9 }, 'malformed answer'],
    [{ type: 'choice', choice: 'constructor', confidence: 0.9 }, 'malformed answer'],
    ['done', 'no answer'],
  ]
  for (const [answer, why] of cases) {
    replies.jev = status(answer)
    await runTurn($)
    await clock.settle()
    await expectBand($, `JEV task: Jev error (${why})`, 'n/a 90%')
  }
})

test('a question missing from the answers fails alone', { options: NO_FALLBACK }, async ($, on) => {
  const { clock } = world(on, { raw: '{"answers":{"ship":{"type":"choice","choice":"na","confidence":0.9}}}' })
  await runTurn($)
  await clock.settle()

  await expectBand($, 'Jev error (no answer)', 'n/a 90%')
})

test('a partly valid response sends only the broken question to Claude', { options: KEY }, async ($, on) => {
  const { completes, forks, clock } = world(
    on,
    { status: 200, body: { answers: { status: { type: 'choice', choice: 'done', confidence: 0.95 } } } },
    'unused',
    'ship: development',
  )
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(0)
  expect(forks.length).toBe(1)
  expect(forks[0]).not.toContain('needaction')
  await expectBand($, '✔ done 95%', 'development · Claude, session context (Jev no answer)')
})

// ——— Turns ———

test('a new turn clears the last verdict, and an interrupted one brings nothing back', { options: KEY }, async ($, on) => {
  const { clock } = world(on, jevSays('done', 0.95))
  await runTurn($)
  await clock.settle()
  await expectBand($, 'done 95%')

  await runTurn($, { reason: 'aborted' })
  await clock.settle()
  await expectNoBand($)
})

test('an older judgement never overwrites a newer turn', { options: KEY }, async ($, on) => {
  const { sent, clock } = world(on, state =>
    state.user_request === 'first' ? jevSays('failed', 0.99, ['blocked', 0.99]) : jevSays('done', 0.98, ['na', 0.97]),
  )
  // The first turn's judgement is still pending when the second turn ends.
  await runTurn($, { prompt: 'first' })
  await runTurn($, { prompt: 'second' })
  await clock.settle()

  await expectBand($, 'done 98%', 'n/a 97%')
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('failed')
  expect(sent.length).toBeGreaterThan(0)
})

test('a judgement pending when the next turn is interrupted is dropped', { options: KEY }, async ($, on) => {
  const { clock } = world(on, jevSays('done', 0.95))
  await runTurn($)
  await runTurn($, { reason: 'aborted' })
  await clock.settle()

  await expectNoBand($)
})

test('an interrupted turn is not sent and shows nothing', { options: KEY }, async ($, on) => {
  const { sent, completes, clock } = world(on, jevSays('done', 1))
  await runTurn($, { reason: 'aborted' })
  await clock.settle()

  expect(sent.length + completes.length).toBe(0)
  await expectNoBand($)
})

test('tool errors are counted in all and flagged as possibly resolved', { options: KEY }, async ($, on) => {
  const { body, clock } = world(on, jevSays('done', 0.95))
  await runTurn($, {
    bash: ['echo FAIL 1', 'echo FAIL 2', 'echo FAIL 3', 'echo FAIL 4', 'echo FAIL 5', 'echo fixed'],
    answer: 'The first attempts failed; fixed it and it now works.',
  })
  await clock.settle()

  const b = body()
  expect(b.state.tool_error_count).toBe(5)
  expect(b.state.tool_errors.length).toBe(3)
  expect(b.questions.status.instructions).toContain('the agent may have resolved them later in the same turn')
})

test('long prompts and answers keep their head and tail', { options: KEY }, async ($, on) => {
  const { body, clock } = world(on, jevSays('done', 0.95))
  const prompt = `PROMPT-HEAD ${'p'.repeat(6000)} PROMPT-TAIL`
  const answer = `ANSWER-HEAD ${'a'.repeat(9000)} ANSWER-TAIL`
  await runTurn($, { prompt, answer })
  await clock.settle()

  const { user_request, agent_final_message } = body().state
  expect(user_request.length).toBeLessThanOrEqual(2000)
  expect(agent_final_message.length).toBeLessThanOrEqual(4000)
  for (const text of [user_request, agent_final_message]) expect(text).toContain('characters omitted')
  expect(user_request.startsWith('PROMPT-HEAD')).toBe(true)
  expect(user_request.endsWith('PROMPT-TAIL')).toBe(true)
  expect(agent_final_message.startsWith('ANSWER-HEAD')).toBe(true)
  expect(agent_final_message.endsWith('ANSWER-TAIL')).toBe(true)
})

// ——— Observed checks ———

test('checks are observed from commands, not from the final message', { options: KEY }, async ($, on) => {
  const { body, clock } = world(on, jevSays('done', 0.95))
  const observed = async (bash: string[]) => {
    await runTurn($, { bash, answer: 'All tests pass and the build is green.' })
    await clock.settle()
    return body().state.observed_checks
  }

  expect(await observed([])).toEqual({ tests: 'unknown', build: 'unknown', typecheck: 'unknown', lint: 'unknown' })
  expect(await observed(['npm test'])).toMatchObject({ tests: 'passed' })
  expect(await observed(['npx tsc --noEmit FAIL'])).toMatchObject({ typecheck: 'failed' })
  expect(await observed(['npm run build FAIL'])).toMatchObject({ build: 'failed' })
  expect(await observed(['cd app && npm run build'])).toMatchObject({ build: 'passed' })
  expect(await observed(['npm test && npm run lint'])).toMatchObject({ tests: 'passed', lint: 'passed' })
  expect(await observed(['npm test && npm run lint FAIL'])).toMatchObject({ tests: 'unknown', lint: 'unknown' })
  expect(await observed(['npm test 2>&1 | tail -20'])).toMatchObject({ tests: 'unknown' })
  expect(await observed(['npm test; echo done'])).toMatchObject({ tests: 'unknown' })
  expect(await observed(['npm test &'])).toMatchObject({ tests: 'unknown' })
  expect(await observed(['npm test NONZERO'])).toMatchObject({ tests: 'unknown' })
  expect(await observed(['git commit -m "npm test; fix"'])).toMatchObject({ tests: 'unknown' })
  expect(await observed(['CI=1 pnpm exec vitest run', 'uv run pytest -q FAIL', 'cargo clippy'])).toEqual({
    tests: 'failed',
    build: 'unknown',
    typecheck: 'unknown',
    lint: 'passed',
  })
  // The latest run of a check wins: a fix after a failure counts as passed.
  expect(await observed(['pytest FAIL', 'pytest'])).toMatchObject({ tests: 'passed' })
  expect(await observed(['node /x/bin/tsc -p tsconfig.json', 'go build ./...'])).toMatchObject({
    typecheck: 'passed',
    build: 'passed',
  })
})

test('versions, help, listings and dry runs are not runs', { options: KEY }, async ($, on) => {
  const { body, clock } = world(on, jevSays('done', 0.95))
  const after = async (bash: string[]) => {
    await runTurn($, { bash })
    await clock.settle()
    return body().state.observed_checks
  }

  // Each: the command, its check, and a real run of that check.
  const notRuns: [string, Check, string][] = [
    ['pytest --version', 'tests', 'pytest'],
    ['pytest -V', 'tests', 'pytest'],
    ['npm test -- --help', 'tests', 'npm test'],
    ['jest --listTests', 'tests', 'jest'],
    ['vitest list', 'tests', 'vitest run'],
    ['pytest --collect-only -q', 'tests', 'pytest'],
    ['go test -list .', 'tests', 'go test ./...'],
    ['cargo test --no-run', 'tests', 'cargo test'],
    ['npx playwright test --list', 'tests', 'npx playwright test'],
    ['tsc --version', 'typecheck', 'tsc'],
    ['npx tsc -v', 'typecheck', 'npx tsc'],
    ['tsc --showConfig', 'typecheck', 'tsc'],
    ['eslint --print-config a.js', 'lint', 'eslint .'],
    ['npm run build -- --dry-run', 'build', 'npm run build'],
  ]
  for (const [command, check, realRun] of notRuns) {
    // Alone, and after a real run that failed: neither makes the check pass.
    expect((await after([command]))[check]).toBe('unknown')
    expect((await after([`${realRun} FAIL`, command]))[check]).toBe('unknown')
  }
  // Ordinary flags are still runs.
  expect((await after(['pytest -v -x'])).tests).toBe('passed')
  expect((await after(['npx tsc --noEmit -p .'])).typecheck).toBe('passed')
})

test('a run that can\'t be told resets an older pass to unknown', { options: KEY }, async ($, on) => {
  const { body, clock } = world(on, jevSays('done', 0.95))
  const after = async (bash: string[]) => {
    await runTurn($, { bash })
    await clock.settle()
    return body().state.observed_checks
  }

  expect(await after(['npm test', 'npm test && npm run lint FAIL'])).toMatchObject({ tests: 'unknown', lint: 'unknown' })
  expect(await after(['npm test', 'npm test 2>&1 | tail -5'])).toMatchObject({ tests: 'unknown' })
  expect(await after(['npm test', 'npm test; echo done'])).toMatchObject({ tests: 'unknown' })
  expect(await after(['npm test', 'npm test || true'])).toMatchObject({ tests: 'unknown' })
  expect(await after(['npm test', 'npm test NONZERO'])).toMatchObject({ tests: 'unknown' })
  expect(await after(['npm test', 'npm test --version'])).toMatchObject({ tests: 'unknown' })
  // Commands that touch no check leave it as it was.
  expect(await after(['npm test', 'git status', 'ls | wc -l', 'echo FAIL'])).toMatchObject({ tests: 'passed' })
})

test('a failed chain is not blamed on the check in it', { options: KEY }, async ($, on) => {
  const { body, clock } = world(on, jevSays('done', 0.95, ['production', 0.95]))
  for (const command of ['cd /missing && npm test FAIL', 'source broken.sh && npm test FAIL', 'export X=1 && pytest FAIL']) {
    await runTurn($, { bash: [command] })
    await clock.settle()
    expect(body().state.observed_checks.tests).toBe('unknown')
    // So it doesn't block production either.
    await expectBand($, '▲ production 95%')
  }
})

test('tool results that outlive their turn are not counted in the next', { options: KEY }, async ($, on) => {
  const { body, clock, release } = world(on, jevSays('done', 0.95))
  await $.prompt.submit({ text: 'first', wait: false, origin: { kind: 'composer' } })
  const lateTests = $.tool.call({ tool: 'Bash', command: 'npm test SLOW' })
  const lateError = $.tool.call({ tool: 'Bash', command: 'npm run lint SLOW FAIL' })

  await $.prompt.submit({ text: 'second', wait: false, origin: { kind: 'composer' } })
  release()
  await Promise.all([lateTests, lateError])
  await $.turn.complete({ answer: 'Done.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  await clock.settle()

  const { state } = body()
  expect(state.user_request).toBe('second')
  expect(state.observed_checks).toEqual({ tests: 'unknown', build: 'unknown', typecheck: 'unknown', lint: 'unknown' })
  expect(state.tool_error_count).toBe(0)
  expect(state.tool_errors).toEqual([])
})

test('a check seen failing lowers production to development', { options: KEY }, async ($, on) => {
  const { toasts, clock } = world(on, jevSays('done', 0.95, ['production', 0.95]))
  await runTurn($, { bash: ['npm test FAIL'], answer: 'Done; ready to ship.' })
  await clock.settle()

  await expectBand($, '◆ development 95% · production gated: observed tests failed')
  expect(toasts).toEqual(['done (95%) · ship: development (95%) · production gated: observed tests failed'])
})

// ——— Options and state ———

test(
  'with the ship check off, only the task is asked and shown',
  { options: { ...KEY, ship_check: false } },
  async ($, on) => {
    const { body, toasts, clock } = world(on, jevSays('done', 0.9))
    await runTurn($)
    await clock.settle()

    expect(Object.keys(body().questions)).toEqual(['status'])
    for (const surface of SURFACES) {
      const band = await bandText($, surface)
      expect(band).toContain('JEV: ✔ done 90%')
      expect(band).not.toContain('ship')
    }
    expect(toasts).toEqual(['done (90%)'])
  },
)

test('deploy_check off from 0.6 keeps the ship question off', { options: { ...KEY, deploy_check: false } }, async ($, on) => {
  const { body, clock } = world(on, jevSays('done', 0.95))
  await runTurn($)
  await clock.settle()
  expect(Object.keys(body().questions)).toEqual(['status'])
})

test('ship_check set wins over 0.6\'s deploy_check', { options: { ...KEY, deploy_check: false, ship_check: true } }, async ($, on) => {
  const { body, clock } = world(on, jevSays('done', 0.95))
  await runTurn($)
  await clock.settle()
  expect(Object.keys(body().questions)).toEqual(['status', 'ship', 'verification'])
})

test('deploy_below from 0.6 applies while ship_below is unset', { options: { ...KEY, deploy_below: 50 } }, async ($, on) => {
  const { forks, clock } = world(on, jevSays('done', 0.95, ['development', 0.6]), 'unused', 'ship: production')
  await runTurn($)
  await clock.settle()
  expect(forks.length).toBe(0)
  await expectBand($, '◆ development 60%')
})

test('ship_below set wins over 0.6\'s deploy_below', { options: { ...KEY, deploy_below: 50, ship_below: 70 } }, async ($, on) => {
  const { forks, clock } = world(on, jevSays('done', 0.95, ['development', 0.6]), 'unused', 'ship: production')
  await runTurn($)
  await clock.settle()
  expect(forks.length).toBe(1)
})

test('the retry button judges the last turn again', { options: KEY }, async ($, on) => {
  const { replies, sent, clock } = world(on, jevSays('done', 0.95, ['production', 0.91]))
  for (const surface of SURFACES) {
    await runTurn($)
    await clock.settle()
    await expectBand($, '▲ production 91%')
    expect(await retryButton($, surface)).toBeDefined()
    const before = sent.length

    // Jev answers differently this time; the press re-sends the same turn.
    replies.jev = jevSays('done', 0.95, ['development', 0.88])
    const band = await $.ui.mount({ plugin: 'jev-status', surface, component: 'AbovePrompt', props: PROPS })
    await band.press({ key: 'retry' })
    await band.unmount()
    await expectBand($, 'checking')
    await clock.settle()

    expect(sent.length).toBe(before + 1)
    expect(JSON.parse(sent.at(-1)!.init?.body ?? '{}').state.agent_final_message).toBe(
      'Which AWS profile should I use, staging-admin or staging-ci?',
    )
    await expectBand($, '◆ development 88%')
    replies.jev = jevSays('done', 0.95, ['production', 0.91])
  }
})

test('no retry button before a turn is judged, or with the option off', { options: { ...KEY, retry_button: false } }, async ($, on) => {
  const { clock } = world(on, jevSays('done', 0.95))
  await runTurn($)
  await clock.settle()
  await expectBand($, 'done 95%')
  for (const surface of SURFACES) expect(await retryButton($, surface)).toBeUndefined()
})

test('a verdict kept from 0.4.0 is ignored, not drawn', { options: KEY }, async ($, on) => {
  world(on, jevSays('done', 1))
  // 0.4.0 kept { status: 'done', source: 'jev', confidence } under the same key.
  const old = { status: 'done', source: 'jev', confidence: 0.9 }
  on('state.get', (_$, e, next) => (e.key === 'verdict' ? { value: { value: old, version: 1 } } : next(e)) as never)

  await expectNoBand($)
})
