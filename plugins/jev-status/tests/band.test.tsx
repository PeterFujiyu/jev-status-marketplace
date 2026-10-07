import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { HttpInit, On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
}

type Sent = { url: string; init?: HttpInit }

// The engine beneath the plugin: no key in the environment, TypeSafe answering
// with `reply`, and pass-through answers for the events the plugin hooks.
function world(on: On, reply: { status: number; body: unknown }) {
  const sent: Sent[] = []
  const toasts: string[] = []
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  mock.env(on, { HOME: '/h' })
  on('fs.exists', () => ({ value: false }))
  on('http.fetch', (_$, e) => {
    sent.push(e)
    return {
      value: { status: reply.status, ok: reply.status < 300, headers: {}, text: JSON.stringify(reply.body) },
    }
  })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return { sent, toasts, clock }
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

const NEEDACTION = {
  status: 200,
  body: { answers: { status: { type: 'choice', choice: 'needaction', confidence: 0.9 } } },
}

test('asks Jev with the configured key and shows its verdict', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { sent, toasts, clock } = world(on, NEEDACTION)
  await runTurn($)

  for (const surface of SURFACES) expect(await bandText($, surface)).toContain('checking')

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

  for (const surface of SURFACES) {
    const text = await bandText($, surface)
    expect(text).toContain('needs action')
    expect(text).toContain('90%')
  }
  // The toast already carries the plugin's name and shows no color: words only.
  expect(toasts).toEqual(['needs action (90%)'])
})

test('without a key it says so and sends nothing', async ($, on) => {
  const { sent, clock } = world(on, NEEDACTION)
  await runTurn($)
  await clock.settle()

  expect(sent.length).toBe(0)
  for (const surface of SURFACES) expect(await bandText($, surface)).toContain('no TypeSafe API key')
})

test('an HTTP error shows as a Jev error', { options: { api_key: 'bad' } }, async ($, on) => {
  const { clock } = world(on, { status: 401, body: { error: 'unauthorized' } })
  await runTurn($)
  await clock.settle()

  for (const surface of SURFACES) expect(await bandText($, surface)).toContain('HTTP 401')
})

test('an interrupted turn is not sent and shows nothing', { options: { api_key: 'k-test' } }, async ($, on) => {
  const { sent, clock } = world(on, NEEDACTION)
  await runTurn($, 'aborted')
  await clock.settle()

  expect(sent.length).toBe(0)
  for (const surface of SURFACES) expect(await bandText($, surface)).not.toContain('JEV')
})
