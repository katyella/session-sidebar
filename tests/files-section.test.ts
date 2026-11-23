import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, PromptOrigin, Register } from 'claude-code'

const SCRATCHPAD = '/tmp/session/scratchpad'
const HEADING = '# Session sidebar: Road so far and For you'

/** Stands in for the built-in cc-plugin-sec-default: it sends prompt.compose on past every user-tier plugin. */
const secDefault: Register = on => {
  on('prompt.compose', ($, e, next) => next.to(e, 'append'))
}
const SEC_DEFAULT = { plugins: [{ name: 'sec-default-stand-in', tier: 'prepend' as const, register: secDefault }] }

/** The engine beneath the plugins: a session with a terminal, its state in memory, and the context fill `tokens()` says. */
function engine(on: On, tokens: () => number, sessionId: () => string = () => 'S1'): { sent: string[][] } {
  const state = new Map<string, { value: unknown; version: number }>()
  const sent: string[][] = []
  on('state.get', (_, e) => ({ value: state.get(e.key) ?? { value: undefined, version: 0 } }))
  on('state.set', (_, e) => {
    const version = (state.get(e.key)?.version ?? 0) + 1
    state.set(e.key, { value: e.value, version })
    return { value: { isSet: true as const, version } }
  })
  on('session.id', () => ({ value: sessionId() }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.surfaces', () => ({ value: ['terminal' as const] }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: tokens(), window: 200_000 }, rateLimits: [] } }))
  on('session.info', () => ({ value: { transcriptPath: '', scratchpadDir: `${SCRATCHPAD}/`, sysname: 'Darwin', release: '', machine: '', packageManagers: [], runtimes: [] } }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'You are Claude Code.', scope: 'shared' as const }] }))
  on('prompt.submit', (_, e) => {
    sent.push([...(e.context ?? [])])
    return { text: e.text, context: e.context }
  })
  return { sent }
}

const COMPOSER: PromptOrigin = { kind: 'composer' }
/** A render of the main session's prompt, as the engine raises it. */
const RENDER = { model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: ['terminal' as const], tools: [], outputStyle: null, traits: [] }

function submit($: Engine, text: string, origin: PromptOrigin = COMPOSER) {
  return $.prompt.submit({ text, origin, wait: false })
}

describe('the files section', () => {
  test('goes in the system prompt, and not on the prompt, where the compose hook runs', async ($, on) => {
    const { sent } = engine(on, () => 1_000)

    const composed = await $.prompt.compose(RENDER)
    const files = composed.sections.find(s => s.id === 'session-sidebar:files')
    expect(files?.text).toContain(HEADING)
    expect(files?.text).toContain(SCRATCHPAD)

    await submit($, 'build the app')
    expect(sent).toEqual([[]])
  })

  test('stays off the first prompt when the probe reaches the compose hook before any render', async ($, on) => {
    const { sent } = engine(on, () => 1_000)

    await submit($, 'build the app')
    await submit($, 'and add tests')
    expect(sent).toEqual([[], []])
  })

  test('rides on the first prompt where a plugin above skips the compose hook', SEC_DEFAULT, async ($, on) => {
    const { sent } = engine(on, () => 1_000)

    const composed = await $.prompt.compose(RENDER)
    expect(composed.sections.some(s => s.id === 'session-sidebar:files')).toBe(false)

    await submit($, 'build the app')
    await submit($, 'and add tests')
    expect(sent.length).toBe(2)
    expect(sent[0]?.length).toBe(1)
    expect(sent[0]?.[0]).toContain(HEADING)
    expect(sent[0]?.[0]).toContain(SCRATCHPAD)
    expect(sent[1]).toEqual([])
  })

  test('goes out again after a compaction or a /clear', SEC_DEFAULT, async ($, on) => {
    let tokens = 1_000
    let id = 'S1'
    const { sent } = engine(on, () => tokens, () => id)

    await submit($, 'one')
    tokens = 150_000
    await submit($, 'two')
    // An automatic compaction: the context shrinks to under half.
    tokens = 40_000
    await submit($, 'three')
    tokens = 60_000
    await submit($, 'four')
    // A /clear goes on under a new session id.
    id = 'S2'
    tokens = 0
    await submit($, 'five')
    expect(sent.map(c => c.length)).toEqual([1, 0, 1, 0, 1])
  })

  test('goes out again after a /compact', SEC_DEFAULT, async ($, on) => {
    const { sent } = engine(on, () => 1_000)

    await submit($, 'one')
    await $.prompt.submit({ text: '/compact', command: { name: 'compact', args: '' }, origin: COMPOSER, wait: false })
    await submit($, 'two')
    await submit($, 'three')
    expect(sent.map(c => c.length)).toEqual([1, 0, 1, 0])
  })

  test('is left off prompts the person did not send', SEC_DEFAULT, async ($, on) => {
    const { sent } = engine(on, () => 1_000)

    await submit($, '<task-notification>…</task-notification>', { kind: 'task-notification' })
    await submit($, 'hi')
    expect(sent.map(c => c.length)).toEqual([0, 1])
  })
})
