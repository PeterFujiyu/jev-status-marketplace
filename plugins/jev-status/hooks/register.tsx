import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Phase, Verdict } from '../types'

// After each turn, asks TypeSafe Jev whether the user's task is done, waiting
// on the user, or failed, and draws the answer above the prompt.
// Sent per turn: the user's prompt, Claude's final answer and up to three tool
// errors from that turn. Nothing else.

const verdict = atom({ plugin: 'jev-status', key: 'verdict' } as const, null)
const phase = atom({ plugin: 'jev-status', key: 'phase' } as const, 'idle')

const API_URL = 'https://api.typesafe.ai/v1/systemone'
const GIVE_UP_MS = 60_000
const MAX_PROMPT_CHARS = 2000
const MAX_ANSWER_CHARS = 4000
const MAX_ERRORS = 3
const MAX_ERROR_CHARS = 300

const QUESTION = {
  type: 'choice',
  instructions:
    '`state` is the end of one turn of an AI coding agent. `user_request` is what the user asked, ' +
    "`agent_final_message` is the agent's last message before it stopped, and `tool_errors` are " +
    "errors from tools it ran during the turn. What is the status of the user's task now?",
  criteria: {
    done: 'The agent finished what was asked and reports the result; nothing is required from the user.',
    needaction:
      'The agent stopped to wait for the user: it asks a question, needs a decision, approval, ' +
      'credentials, or a manual step the user must do before work can continue.',
    failed:
      'The agent could not complete the task: it hit errors it did not resolve, gave up, ' +
      'or reports that the result does not work.',
  },
}

const LOOK: Record<Verdict['status'], { color?: string; label: string }> = {
  done: { color: 'green', label: '✔ done' },
  needaction: { color: 'yellow', label: '● needs action' },
  failed: { color: 'red', label: '✘ failed' },
  nokey: { label: 'no TypeSafe API key (set it in /plugin)' },
  error: { label: 'Jev error' },
}

type Turn = { prompt: string; answer: string; errors: string[] }

async function apiKey($: EngineInterface, configured: unknown): Promise<string> {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  const fromEnv = await $.env.get('TYPESAFE_API_KEY')
  if (fromEnv?.trim()) return fromEnv.trim()
  const path = `${await $.env.get('HOME')}/.config/typesafe/api_key`
  return (await $.fs.exists(path)) ? (await $.fs.read(path)).trim() : ''
}

async function askJev($: EngineInterface, key: string, turn: Turn): Promise<Verdict> {
  const res = await $.http.fetch(API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'jev-latest',
      state: { user_request: turn.prompt, agent_final_message: turn.answer, tool_errors: turn.errors },
      questions: { status: QUESTION },
    }),
  })
  if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` }
  const answer = JSON.parse(res.text)?.answers?.status
  if (!['done', 'needaction', 'failed'].includes(answer?.choice)) {
    return { status: 'error', error: 'unexpected response' }
  }
  return { status: answer.choice, confidence: answer.confidence }
}

export const register: Register = (on, options) => {
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
      if (options.toast !== false && v.status !== 'nokey') {
        const conf = typeof v.confidence === 'number' ? ` (${Math.round(v.confidence * 100)}%)` : ''
        $.ui.toast(`JEV: ${LOOK[v.status].label}${conf}`)
      }
    }

    // Judge after the turn has settled, off this dispatch.
    $.clock.after(0, () => {
      apiKey($, options.api_key)
        .then(key => (key ? askJev($, key, turn) : ({ status: 'nokey' } as Verdict)))
        .catch(
          (err: unknown): Verdict => ({
            status: 'error',
            error: err instanceof Error ? err.message.slice(0, 60) : 'request failed',
          }),
        )
        .then(settle)
        .catch(() => {})
    })
    $.clock.after(GIVE_UP_MS, () => {
      settle({ status: 'error', error: 'no answer in 60 s' }).catch(() => {})
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
