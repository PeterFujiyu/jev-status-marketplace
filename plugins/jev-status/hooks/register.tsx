import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Phase, Verdict } from '../types'

// ~/.claude/hooks/jev-stop.py (an async Stop hook) asks Jev about each finished
// turn and writes the answer to ~/.claude/jev-status/<session_id>.json. This mod
// polls that file and draws the verdict above the prompt.

const verdict = atom({ plugin: 'jev-status', key: 'verdict' } as const, null)
const phase = atom({ plugin: 'jev-status', key: 'phase' } as const, 'idle')

const POLL_MS = 2000
const GIVE_UP_S = 60 // the Stop hook's own timeout is 45 s

const LOOK: Record<Verdict['status'], { color?: string; label: string }> = {
  done: { color: 'green', label: '✔ done' },
  needaction: { color: 'yellow', label: '● needs action' },
  failed: { color: 'red', label: '✘ failed' },
  nokey: { label: 'no TypeSafe API key' },
  error: { label: 'Jev error' },
}

export const register: Register = on => {
  let lastSeen = 0
  let endedAt = 0

  on('session.start', async ($, e, next) => {
    const home = await $.env.get('HOME')

    const poll = async () => {
      if ((await read($, phase)) === 'checking' && (await $.clock.now()) / 1000 - endedAt > GIVE_UP_S) {
        await update($, phase, (): Phase => 'idle')
      }
      const path = `${home}/.claude/jev-status/${await $.session.id()}.json`
      if (!(await $.fs.exists(path))) return
      const v = JSON.parse(await $.fs.read(path)) as Verdict
      if (v.time === lastSeen) return
      lastSeen = v.time
      await update($, verdict, () => v)
      if (v.time >= endedAt) {
        await update($, phase, p => (p === 'checking' ? 'idle' : p))
      }
    }

    $.clock.every(POLL_MS, () => {
      poll().catch(() => {})
    })

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, phase, (): Phase => 'running')

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      endedAt = Math.floor((await $.clock.now()) / 1000) - 1
      // The Stop hook runs only after a turn that answered; an interrupt or an
      // API error never gets a verdict, so don't wait for one.
      await update($, phase, (): Phase => (e.reason === 'answer' ? 'checking' : 'idle'))
    }

    return next(e)
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
    const conf = typeof v!.confidence === 'number' ? ` ${Math.round(v!.confidence * 100)}%` : ''
    const detail = v!.status === 'error' && v!.error ? ` (${v!.error})` : ''

    return (
      <Box>
        <Text dimColor>JEV: </Text>
        <Text bold color={look.color} dimColor={look.color === undefined}>
          {look.label}
        </Text>
        <Text dimColor>
          {conf}
          {detail}
        </Text>
      </Box>
    )
  })
}
