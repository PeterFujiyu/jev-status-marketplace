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

const jevSays = (status: string, confidence: number, deploy: [string, number] = ['production', 0.9]): JevReply => ({
  status: 200,
  body: {
    answers: {
      status: { type: 'choice', choice: status, confidence },
      deploy: { type: 'choice', choice: deploy[0], confidence: deploy[1] },
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
  claude = 'status: failed\ndeploy: nodeploy',
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

async function expectNoBand($: Engine) {
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('JEV')
}

const KEY = { api_key: 'k-test' }
const NO_FALLBACK = { api_key: 'k-test', claude_on_jev_failure: false }

// ——— Jev alone ———

test('a confident Jev answers both questions alone', { options: KEY }, async ($, on) => {
  const { sent, body, completes, forks, toasts, clock } = world(on, jevSays('needaction', 0.9, ['nodeploy', 0.95]))
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
  expect(Object.keys(b.questions)).toEqual(['status', 'deploy'])
  expect(Object.keys(b.questions.status.criteria)).toEqual(['done', 'needaction', 'failed'])
  expect(Object.keys(b.questions.deploy.criteria)).toEqual(['production', 'development', 'nodeploy', 'nothing'])
  expect(b.questions.status.instructions).toContain('may have resolved them later')
  expect(b.questions.deploy.instructions).toContain('not whether the agent waits on the user')

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'JEV task:', 'needs action 90%', 'JEV deploy:', 'not deployable 95%')
  expect(toasts).toEqual(['needs action (90%) · deploy: not deployable (95%)'])
})

test('a greeting is needaction with nothing to deploy', { options: KEY }, async ($, on) => {
  const { toasts, clock } = world(on, jevSays('needaction', 0.97, ['nothing', 0.96]))
  await runTurn($, { prompt: 'Hi', answer: 'Hi! What can I help you with?' })
  await clock.settle()

  await expectBand($, '● needs action 97%', '– nothing to deploy 96%')
  expect(toasts).toEqual(['needs action (97%) · deploy: nothing (96%)'])
})

test('task and deploy combine freely', { options: KEY }, async ($, on) => {
  const { replies, clock } = world(on, jevSays('done', 0.9))
  const combos: [string, string, string, string][] = [
    ['done', 'production', '✔ done 90%', '▲ production 90%'],
    ['done', 'development', '✔ done 90%', '◆ development only 90%'],
    ['done', 'nothing', '✔ done 90%', '– nothing to deploy 90%'],
    ['needaction', 'production', '● needs action 90%', '▲ production 90%'], // ready, waiting for a go-ahead
    ['needaction', 'nothing', '● needs action 90%', '– nothing to deploy 90%'],
    ['failed', 'nodeploy', '✘ failed 90%', '■ not deployable 90%'],
    ['done', 'nodeploy', '✔ done 90%', '■ not deployable 90%'], // finished, but a risky migration
  ]
  for (const [task, deploy, taskText, deployText] of combos) {
    replies.jev = jevSays(task, 0.9, [deploy, 0.9])
    await runTurn($)
    await clock.settle()
    await expectBand($, taskText, deployText)
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
  expect(toasts).toEqual(['needs action · Claude (Jev 55%) · deploy: production (90%)'])
})

test('an unsure deploy answer goes to Claude alone', { options: KEY }, async ($, on) => {
  const { completes, clock } = world(on, jevSays('done', 0.95, ['production', 0.33]), 'deploy: development')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  expect(completes[0]!.system).toContain('deploy: <choice>')
  expect(completes[0]!.system).not.toContain('needaction')
  await expectBand($, 'done 95%', 'development only · Claude (Jev 33%)')
})

test("a deploy answer no review can settle needs review, not Jev's guess", { options: KEY }, async ($, on) => {
  const { completes, forks, toasts, clock } = world(
    on,
    jevSays('done', 0.95, ['production', 0.35]),
    'deploy: unclear',
    'deploy: unclear',
  )
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  expect(forks.length).toBe(1)
  await expectBand($, 'JEV deploy: ', '? needs review', ' · Jev suggested production 35%')
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('▲')
  expect(toasts).toEqual(['done (95%) · deploy: needs review (Jev suggested production 35%)'])
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
  await expectBand($, 'JEV task:   ✔ done 50%')
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
  expect(toasts).toEqual(['failed · Claude, session context (Jev 55%) · deploy: production (90%)'])
})

test('only the questions the summary could not answer go to the session context', { options: KEY }, async ($, on) => {
  const { forks, clock } = world(
    on,
    jevSays('done', 0.5, ['production', 0.3]),
    'status: done\ndeploy: unclear',
    'deploy: nodeploy',
  )
  await runTurn($)
  await clock.settle()

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('deploy: <choice>')
  expect(forks[0]).not.toContain('needaction')
  await expectBand($, 'done · Claude (Jev 50%)', 'not deployable · Claude, session context (Jev 30%)')
})

test(
  'the summary-only view does not go on to the session context',
  { options: { ...KEY, claude_view: 'summary' } },
  async ($, on) => {
    const { completes, forks, clock } = world(
      on,
      jevSays('done', 0.55, ['production', 0.5]),
      'status: unclear\ndeploy: unclear',
    )
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(1)
    expect(forks.length).toBe(0)
    await expectBand($, 'done 55%', '? needs review · Jev suggested production 50%')
  },
)

// ——— Reading Claude's replies ———

test('reviewer replies are read strictly, per line', { options: KEY }, async ($, on) => {
  const { replies, clock } = world(on, jevSays('done', 0.5, ['production', 0.5]), '', 'deploy: unclear\nstatus: unclear')
  const cases: [string, string[]][] = [
    ['**Status:** needs action\n**Deploy:** no-deploy', ['needs action · Claude (Jev 50%)', 'not deployable · Claude (Jev 50%)']],
    ['- status: `done`.\n- deploy: Development', ['✔ done · Claude (Jev 50%)', 'development only · Claude (Jev 50%)']],
    ['Status: needs_action\nDeploy: nothing to deploy', ['needs action · Claude', 'nothing to deploy · Claude']],
    ['status: not done\ndeploy: probably production', ['✔ done 50%', '? needs review · Jev suggested production 50%']],
    ['status: done\ndeploy: production might work', ['✔ done · Claude', '? needs review']],
    ['status: done\ndeploy: production\ndeploy: nothing', ['✔ done · Claude', '? needs review']],
    ['status: done, deploy: production', ['✔ done 50%', '? needs review']],
    ['done\nproduction', ['✔ done 50%', '? needs review']],
    ['status: constructor\ndeploy: hasOwnProperty', ['✔ done 50%', '? needs review']],
  ]
  for (const [text, shown] of cases) {
    replies.claude = text
    await runTurn($)
    await clock.settle()
    await expectBand($, ...shown)
  }
})

test('a bare one-word reply answers a lone question', { options: KEY }, async ($, on) => {
  const { clock } = world(on, jevSays('done', 0.95, ['production', 0.4]), 'Development.')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'development only · Claude (Jev 40%)')
})

// ——— Thresholds ———

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
  'task and deploy thresholds override the generic one',
  { options: { ...KEY, claude_below: 10, task_below: 95, deploy_below: 50 } },
  async ($, on) => {
    const { completes, clock } = world(on, jevSays('done', 0.9, ['development', 0.6]), 'status: failed')
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(1)
    expect(completes[0]!.system).not.toContain('production')
    await expectBand($, 'failed · Claude (Jev 90%)', 'development only 60%')
  },
)

test(
  'a stricter production threshold only applies to production',
  { options: { ...KEY, production_below: 90 } },
  async ($, on) => {
    const { replies, completes, clock } = world(on, jevSays('done', 0.95, ['development', 0.85]), 'deploy: development')
    await runTurn($)
    await clock.settle()
    expect(completes.length).toBe(0)
    await expectBand($, 'development only 85%')

    replies.jev = jevSays('done', 0.95, ['production', 0.85])
    await runTurn($)
    await clock.settle()
    expect(completes.length).toBe(1)
    await expectBand($, 'development only · Claude (Jev 85%)')
  },
)

test('a threshold of 0 never asks Claude', { options: { ...KEY, claude_below: 0 } }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('done', 0.2, ['development', 0.1]))
  await runTurn($)
  await clock.settle()

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'done 20%', 'development only 10%')
})

// ——— Jev failures ———

test('with no key Claude stands in for both, and nothing goes to TypeSafe', async ($, on) => {
  const { sent, completes, clock } = world(on, jevSays('done', 1), 'status: needaction\ndeploy: nothing')
  await runTurn($)
  await clock.settle()

  expect(sent.length).toBe(0)
  expect(completes.length).toBe(1)
  await expectBand($, 'needs action · Claude (no Jev key)', 'nothing to deploy · Claude (no Jev key)')
})

test('without HOME no key file is looked for', async ($, on) => {
  const { sent, looked, clock } = world(on, jevSays('done', 1), 'status: done\ndeploy: nothing', undefined, {})
  await runTurn($)
  await clock.settle()

  expect(looked).toEqual([])
  expect(sent.length).toBe(0)
  await expectBand($, 'done · Claude (no Jev key)')
})

test('an HTTP error hands both over to Claude', { options: { api_key: 'bad' } }, async ($, on) => {
  const { clock } = world(on, { status: 401, body: { error: 'unauthorized' } }, 'status: done\ndeploy: development')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'done · Claude (Jev HTTP 401)', 'development only · Claude (Jev HTTP 401)')
})

test('a network error hands both over to Claude', { options: KEY }, async ($, on) => {
  const { clock } = world(on, 'network', 'status: done\ndeploy: nothing')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'done · Claude (Jev network error)', 'nothing to deploy · Claude (Jev network error)')
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
    body: { answers: { status: answer, deploy: { type: 'choice', choice: 'nothing', confidence: 0.9 } } },
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
    await expectBand($, `JEV task:   Jev error (${why})`, 'nothing to deploy 90%')
  }
})

test('a question missing from the answers fails alone', { options: NO_FALLBACK }, async ($, on) => {
  const { clock } = world(on, { raw: '{"answers":{"deploy":{"type":"choice","choice":"nothing","confidence":0.9}}}' })
  await runTurn($)
  await clock.settle()

  await expectBand($, 'Jev error (no answer)', 'nothing to deploy 90%')
})

test('a partly valid response sends only the broken question to Claude', { options: KEY }, async ($, on) => {
  const { completes, clock } = world(
    on,
    { status: 200, body: { answers: { status: { type: 'choice', choice: 'done', confidence: 0.95 } } } },
    'deploy: development',
  )
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  expect(completes[0]!.system).not.toContain('needaction')
  await expectBand($, '✔ done 95%', 'development only · Claude (Jev no answer)')
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
    state.user_request === 'first' ? jevSays('failed', 0.99, ['nodeploy', 0.99]) : jevSays('done', 0.98, ['nothing', 0.97]),
  )
  // The first turn's judgement is still pending when the second turn ends.
  await runTurn($, { prompt: 'first' })
  await runTurn($, { prompt: 'second' })
  await clock.settle()

  await expectBand($, 'done 98%', 'nothing to deploy 97%')
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

test('production cannot stand against a check seen failing', { options: KEY }, async ($, on) => {
  const { toasts, clock } = world(on, jevSays('done', 0.95, ['production', 0.95]))
  await runTurn($, { bash: ['npm test FAIL'], answer: 'Done; ready to ship.' })
  await clock.settle()

  await expectBand($, '? needs review · Jev suggested production 95%, but observed tests failed')
  expect(toasts).toEqual([
    'done (95%) · deploy: needs review (Jev suggested production 95%, but observed tests failed)',
  ])
})

// ——— Options and state ———

test(
  'with the deploy check off, only the task is asked and shown',
  { options: { ...KEY, deploy_check: false } },
  async ($, on) => {
    const { body, toasts, clock } = world(on, jevSays('done', 0.9))
    await runTurn($)
    await clock.settle()

    expect(Object.keys(body().questions)).toEqual(['status'])
    for (const surface of SURFACES) {
      const band = await bandText($, surface)
      expect(band).toContain('JEV: ✔ done 90%')
      expect(band).not.toContain('deploy')
    }
    expect(toasts).toEqual(['done (90%)'])
  },
)

test('a verdict kept from 0.4.0 is ignored, not drawn', { options: KEY }, async ($, on) => {
  world(on, jevSays('done', 1))
  // 0.4.0 kept { status: 'done', source: 'jev', confidence } under the same key.
  const old = { status: 'done', source: 'jev', confidence: 0.9 }
  on('state.get', (_$, e, next) => (e.key === 'verdict' ? { value: { value: old, version: 1 } } : next(e)) as never)

  await expectNoBand($)
})
