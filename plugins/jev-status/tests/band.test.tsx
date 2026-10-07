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

const jevSays = (choice: string, confidence: number): JevReply => ({
  status: 200,
  body: { answers: { status: { type: 'choice', choice, confidence } } },
})

// The engine beneath the plugin: no key in the environment, TypeSafe answering
// with `jev`, Claude answering with `claude`, and pass-through answers for the
// events the plugin hooks.
function world(on: On, jev: JevReply, claude = 'failed') {
  const sent: Sent[] = []
  const completes: ModelCompleteRequest[] = []
  const forks: string[] = []
  const toasts: string[] = []
  const answer = (): ModelCompleteResult => ({ isAnswered: true, text: claude, usage: USAGE })

  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  mock.env(on, { HOME: '/h' })
  on('fs.exists', () => ({ value: false }))
  on('http.fetch', (_$, e) => {
    sent.push(e)
    return { value: { status: jev.status, ok: jev.status < 300, headers: {}, text: JSON.stringify(jev.body) } }
  })
  on('model.complete', (_$, e) => {
    completes.push(e)
    return { value: answer() }
  })
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: answer() }
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

async function expectBand($: Engine, text: string) {
  for (const surface of SURFACES) expect(await bandText($, surface)).toContain(text)
}

test('a confident Jev answers alone', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { sent, completes, forks, toasts, clock } = world(on, jevSays('needaction', 0.9))
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
  expect(Object.keys(body.questions.status.criteria)).toEqual(['done', 'needaction', 'failed'])

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'needs action 90%')
  expect(toasts).toEqual(['needs action (90%)'])
})

test('an unsure Jev hands over to Claude with the default model', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { completes, forks, toasts, clock } = world(on, jevSays('done', 0.55), 'needaction')
  await runTurn($)
  await clock.settle()

  expect(forks.length).toBe(0)
  expect(completes.length).toBe(1)
  expect(completes[0]!.model).toBe('haiku')
  expect(JSON.parse(completes[0]!.prompt).user_request).toBe('Deploy the app to staging.')

  await expectBand($, 'needs action · Claude (Jev 55%)')
  expect(toasts).toEqual(['needs action · Claude (Jev 55%)'])
})

test(
  'the threshold and the review model are configurable',
  { options: { api_key: 'k-test', claude_below: 95, review_model: 'sonnet' } },
  async ($, on) => {
    const { completes, clock } = world(on, jevSays('done', 0.9), 'failed')
    await runTurn($)
    await clock.settle()

    expect(completes.map(c => c.model)).toEqual(['sonnet'])
    await expectBand($, 'failed · Claude (Jev 90%)')
  },
)

test('a threshold of 0 never asks Claude', { options: { api_key: 'k-test', claude_below: 0 } }, async ($, on) => {
  const { completes, forks, clock } = world(on, jevSays('done', 0.2))
  await runTurn($)
  await clock.settle()

  expect(completes.length + forks.length).toBe(0)
  await expectBand($, 'done 20%')
})

test(
  'the conversation view forks the session instead',
  { options: { api_key: 'k-test', claude_view: 'conversation' } },
  async ($, on) => {
    const { completes, forks, clock } = world(on, jevSays('done', 0.4), 'done')
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(0)
    expect(forks.length).toBe(1)
    await expectBand($, 'done · Claude (Jev 40%)')
  },
)

test('with no key Claude stands in, and nothing goes to TypeSafe', async ($, on) => {
  const { sent, completes, clock } = world(on, jevSays('done', 1), 'needaction')
  await runTurn($)
  await clock.settle()

  expect(sent.length).toBe(0)
  expect(completes.length).toBe(1)
  await expectBand($, 'needs action · Claude (no Jev key)')
})

test('a Jev error hands over to Claude', { options: { api_key: 'bad' } }, async ($, on) => {
  const { clock } = world(on, { status: 401, body: { error: 'unauthorized' } }, 'done')
  await runTurn($)
  await clock.settle()

  await expectBand($, 'done · Claude (Jev HTTP 401)')
})

test(
  'with the fallback off, Jev failures show as they are',
  { options: { api_key: 'bad', claude_on_jev_failure: false } },
  async ($, on) => {
    const { completes, clock } = world(on, { status: 401, body: { error: 'unauthorized' } })
    await runTurn($)
    await clock.settle()

    expect(completes.length).toBe(0)
    await expectBand($, 'Jev error (HTTP 401)')
  },
)

test('if Claude gives no usable answer, Jev\'s stands', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { completes, clock } = world(on, jevSays('done', 0.5), 'I am not sure')
  await runTurn($)
  await clock.settle()

  expect(completes.length).toBe(1)
  await expectBand($, 'done 50%')
})

test('an interrupted turn is not sent and shows nothing', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { sent, completes, clock } = world(on, jevSays('done', 1))
  await runTurn($, 'aborted')
  await clock.settle()

  expect(sent.length + completes.length).toBe(0)
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('JEV')
})
