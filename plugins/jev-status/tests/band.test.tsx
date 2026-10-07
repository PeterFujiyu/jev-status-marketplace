import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SURFACES = ['terminal', 'desktop'] as const
const STATUS_FILE = '/h/.claude/jev-status/sid.json'
const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 3,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 3 },
  view: {},
}

// The engine beneath the plugin: a session id, a file system in memory, and
// pass-through answers for the events the mod hooks.
function world(on: On, files: Record<string, string>) {
  mock.env(on, { HOME: '/h' })
  on('session.id', () => ({ value: 'sid' }))
  on('fs.exists', (_$, e) => ({ value: e.path in files }))
  on('fs.read', (_$, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`no such file: ${e.path}`)
    return { value: text }
  })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const turn = (reason: 'answer' | 'aborted') => ({
  answer: 'ok',
  durationMs: 1,
  isAborted: reason === 'aborted',
  turnId: 't1',
  reason,
})

test('shows checking, then the verdict Jev wrote for this session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_800_000_000_000 })
  const files: Record<string, string> = {}
  world(on, files)

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'deploy it', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete(turn('answer'))

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'jev-status', surface, component: 'AbovePrompt', props: PROPS })
    expect(await band.find({ text: 'checking' })).toBeTruthy()
    await band.unmount()
  }

  files[STATUS_FILE] = JSON.stringify({ time: clock.now() / 1000, status: 'needaction', confidence: 0.9 })
  await clock.advance(2000)

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'jev-status', surface, component: 'AbovePrompt', props: PROPS })
    expect(await band.find({ text: 'needs action' })).toBeTruthy()
    expect(await band.find({ text: '90%' })).toBeTruthy()
    expect(await band.find({ text: 'checking' })).toBeUndefined()
    await band.unmount()
  }
})

test('an interrupted turn does not wait for a verdict', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  world(on, {})

  await $.session.start({ cwd: '/w', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'deploy it', wait: false, origin: { kind: 'composer' } })
  await $.turn.complete(turn('aborted'))

  for (const surface of SURFACES) {
    const band = await $.ui.mount({ plugin: 'jev-status', surface, component: 'AbovePrompt', props: PROPS })
    expect(await band.find({ text: /JEV/ })).toBeUndefined()
    await band.unmount()
  }
})
