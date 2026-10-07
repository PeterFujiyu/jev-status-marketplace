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
type JevReply = { status: number; body: unknown }

const jevSays = (status: string, confidence: number, deploy: [string, number] = ['production', 0.9]): JevReply => ({
  status: 200,
  body: {
    answers: {
      status: { type: 'choice', choice: status, confidence },
      deploy: { type: 'choice', choice: deploy[0], confidence: deploy[1] },
    },
  },
})

// The engine beneath the plugin: no key in the environment, TypeSafe answering
// with `jev`, the summary review replying `claude`, the whole-session review
// replying `session`, and pass-through answers for the events the plugin hooks.
function world(on: On, jev: JevReply, claude = 'status: failed\ndeploy: nodeploy', session = claude) {
  const sent: Sent[] = []
  const completes: ModelCompleteRequest[] = []
  const forks: string[] = []
  const toasts: string[] = []
  const reply = (text: string): ModelCompleteResult => ({ isAnswered: true, text, usage: USAGE })

  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.env(on, { HOME: '/h' })
  on('fs.exists', () => ({ value: false }))
  on('http.fetch', (_$, e) => {
    sent.push(e)
    return { value: { status: jev.status, ok: jev.status < 300, headers: {}, text: JSON.stringify(jev.body) } }
  })
  on('model.complete', (_$, e) => {
    completes.push(e)
    return { value: reply(claude) }
  })
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: reply(session) }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { sent, completes, forks, toasts, clock }
}

async function runTurn($: Engine, reason: 'answer' | 'aborted' = 'answer') {
  await $.prompt.submit({ text: 'Deploy the app to staging.', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete({
    answer: 'Which AWS profile should I use, staging-admin or staging-ci?',
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

test('a confident Jev answers both questions alone', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { sent, completes, forks, toasts, clock } = world(on, jevSays('needaction', 0.9, ['nodeploy', 0.95]))
  await runTurn($)

  await expectBand($, 'checking')
  await clock.settle()

  expect(sent.length).toBe(1)
  expect(sent[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(sent[0]!.init?.headers?.Authorization).toBe('Bearer k-test')
  const body = JSON.parse(sent[0]!.init?.body ?? '{}')
  expect(body.state).toEqual({
    user_request: 'Deploy the app to staging.',
    agent_final_message: 'Which AWS profile should I use, staging-admin or staging-ci?',
    tool_errors: [],
  })
  expect(Object.keys(body.questions)).toEqual(['status', 'deploy'])
  expect(Object.keys(body.questions.status.criteria)).toEqual(['done', 'needaction', 'failed'])
  expect(Object.keys(body.questions.deploy.criteria)).toEqual(['production', 'development', 'nodeploy', 'nochange'])

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'JEV task:', 'needs action 90%', 'JEV deploy:', 'not permitted 95%')
  expect(toasts).toEqual(['needs action (90%) · deploy: not permitted (95%)'])
})

test('an unsure status goes to Claude with the default model, alone', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { completes, forks, toasts, clock } = world(on, jevSays('done', 0.55), 'status: needaction')
  await runTurn($)
  await clock.settle()

  expect(forks.length).toBe(0)
  expect(completes.length).toBe(1)
  expect(completes[0]!.model).toBe('haiku')
  expect(completes[0]!.system).toContain('needaction')
  expect(completes[0]!.system).not.toContain('deploy')
  expect(JSON.parse(completes[0]!.prompt).user_request).toBe('Deploy the app to staging.')

  await expectBand($, 'needs action · Claude (Jev 55%)', 'production 90%')
  expect(toasts).toEqual(['needs action · Claude (Jev 55%) · deploy: production (90%)'])
})

test('an unsure deploy answer goes to Claude alone', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { completes, clock } = world(on, jevSays('done', 0.95, ['production', 0.33]), 'deploy: development')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  expect(completes[0]!.system).toContain('deploy: <choice>')
  expect(completes[0]!.system).not.toContain('needaction')
  await expectBand($, 'done 95%', 'development only · Claude (Jev 33%)')
})

test(
  'the threshold and the review model are configurable',
  { options: { api_key: 'k-test', claude_below: 95, review_model: 'sonnet' } },
  async ($, on) => {
    const { completes, clock } = world(on, jevSays('done', 0.9, ['production', 0.96]), 'status: failed')
    await runTurn($)
    await clock.settle()

    expect(completes.map(c => c.model)).toEqual(['sonnet'])
    await expectBand($, 'failed · Claude (Jev 90%)', 'production 96%')
  },
)

test('a threshold of 0 never asks Claude', { options: { api_key: 'k-test', claude_below: 0 } }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('done', 0.2, ['development', 0.1]))
  await runTurn($)
  await clock.settle()

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'done 20%', 'development only 10%')
})

test(
  'the conversation view forks the session instead',
  { options: { api_key: 'k-test', claude_view: 'conversation' } },
  async ($, on) => {
    const { completes, forks, clock } = world(on, jevSays('done', 0.4), 'status: failed', 'status: done')
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(0)
    expect(forks.length).toBe(1)
    await expectBand($, 'done · Claude, full session (Jev 40%)')
  },
)

test(
  'when the summary is not enough, the whole session is read',
  { options: { api_key: 'k-test' } },
  async ($, on) => {
    const { completes, forks, toasts, clock } = world(on, jevSays('done', 0.55), 'status: unclear', 'status: failed')
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(1)
    expect(forks.length).toBe(1)
    await expectBand($, 'failed · Claude, full session (Jev 55%)')
    expect(toasts).toEqual(['failed · Claude, full session (Jev 55%) · deploy: production (90%)'])
  },
)

test(
  'only the questions the summary could not answer go to the whole session',
  { options: { api_key: 'k-test' } },
  async ($, on) => {
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
    await expectBand($, 'done · Claude (Jev 50%)', 'not permitted · Claude, full session (Jev 30%)')
  },
)

test('reviewer replies are read loosely, per line', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { clock } = world(on, jevSays('done', 0.5, ['production', 0.5]), '**Status:** needs action\n**Deploy:** no-deploy')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'needs action · Claude (Jev 50%)', 'not permitted · Claude (Jev 50%)')
})

test(
  'the summary-only view does not go on to the whole session',
  { options: { api_key: 'k-test', claude_view: 'summary' } },
  async ($, on) => {
    const { completes, forks, clock } = world(on, jevSays('done', 0.55), 'status: unclear', 'status: failed')
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(1)
    expect(forks.length).toBe(0)
    await expectBand($, 'done 55%')
  },
)

test('with no key Claude stands in for both, and nothing goes to TypeSafe', async ($, on) => {
  const { sent, completes, clock } = world(on, jevSays('done', 1), 'status: needaction\ndeploy: nodeploy')
  await runTurn($)
  await clock.settle()

  expect(sent.length).toBe(0)
  expect(completes.length).toBe(1)
  await expectBand($, 'needs action · Claude (no Jev key)', 'not permitted · Claude (no Jev key)')
})

test('a Jev error hands both over to Claude', { options: { api_key: 'bad' } }, async ($, on) => {
  const { clock } = world(on, { status: 401, body: { error: 'unauthorized' } }, 'status: done\ndeploy: development')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'done · Claude (Jev HTTP 401)', 'development only · Claude (Jev HTTP 401)')
})

test(
  'with the fallback off, Jev failures show as they are',
  { options: { api_key: 'bad', claude_on_jev_failure: false } },
  async ($, on) => {
    const { completes, clock } = world(on, { status: 401, body: { error: 'unauthorized' } })
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(0)
    await expectBand($, 'JEV: ', 'Jev error (HTTP 401)')
    expect((await bandText($, 'terminal')).match(/Jev error/g)?.length).toBe(1)
  },
)

test('if neither review can tell, Jev\'s answer stands', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('done', 0.5), 'I am not sure', 'status: unclear')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  expect(forks.length).toBe(1)
  await expectBand($, 'done 50%')
})

test('a turn with nothing to deploy says so', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { toasts, clock } = world(on, jevSays('done', 0.98, ['nochange', 0.97]))
  await runTurn($)
  await clock.settle()

  await expectBand($, 'nothing to deploy 97%')
  expect(toasts).toEqual(['done (98%) · deploy: nothing (97%)'])
})

test('with the deploy check off, only the status is asked and shown', { options: { api_key: 'k-test', deploy_check: false } }, async ($, on) => {
  const { sent, toasts, clock } = world(on, jevSays('done', 0.9))
  await runTurn($)
  await clock.settle()

  expect(Object.keys(JSON.parse(sent[0]!.init?.body ?? '{}').questions)).toEqual(['status'])
  for (const surface of SURFACES) {
    const band = await bandText($, surface)
    expect(band).toContain('JEV: ✔ done 90%')
    expect(band).not.toContain('deploy')
  }
  expect(toasts).toEqual(['done (90%)'])
})

test('a verdict kept from 0.4.0 is ignored, not drawn', { options: { api_key: 'k-test' } }, async ($, on) => {
  world(on, jevSays('done', 1))
  // 0.4.0 kept { status: 'done', source: 'jev', confidence } under the same key.
  const old = { status: 'done', source: 'jev', confidence: 0.9 }
  on('state.get', (_$, e, next) => (e.key === 'verdict' ? { value: { value: old, version: 1 } } : next(e)) as never)

  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('JEV')
})

test('an interrupted turn is not sent and shows nothing', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { sent, completes, clock } = world(on, jevSays('done', 1))
  await runTurn($, 'aborted')
  await clock.settle()

  expect(sent.length + completes.length).toBe(0)
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('JEV')
})
