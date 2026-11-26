import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { cutMiddle, forYouView, itemLinks, linkLabel, parseForYou, withoutLinks } from '../hooks/for-you'
import type { ForYou } from '../types'

const ARTIFACT = 'https://claude.ai/artifact/0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'

describe('the for-you file', () => {
  test('reads a headline with the indented lines under it as its details', () => {
    const items = parseForYou(
      [
        '# For you',
        '- Pick a design per screen',
        `  - ${ARTIFACT}`,
        '  - Two of the five are close calls',
        '- [x] Approve the schema',
        '  - https://example.com/hidden',
        '- [ ] Run the login yourself',
        '  `! gh auth login`',
        '',
      ].join('\n'),
    )
    expect(items).toEqual([
      { text: 'Pick a design per screen', details: [ARTIFACT, 'Two of the five are close calls'] },
      { text: 'Run the login yourself', details: ['`! gh auth login`'] },
    ])
  })

  test('reads "( )" lines under a headline as its choices, "(*)" as Claude\'s pick', () => {
    const items = parseForYou(
      ['- Which demo should I build next?', '  - ( ) Welcome back catch-up', '  - (*) CI arrivals board', '  - (  ) Weather window', '  - one line of context', ''].join('\n'),
    )
    expect(items).toEqual([
      {
        text: 'Which demo should I build next?',
        details: ['one line of context'],
        choices: [
          { label: 'Welcome back catch-up', isRecommended: false },
          { label: 'CI arrivals board', isRecommended: true },
          { label: 'Weather window', isRecommended: false },
        ],
      },
    ])
    expect(forYouView(items[0]!, 60, '').rows).toBe(4)
  })

  test('keeps one-line items as they were', () => {
    expect(parseForYou('- one\n- two: https://x.dev/a\n')).toEqual([
      { text: 'one', details: [] },
      { text: 'two: https://x.dev/a', details: [] },
    ])
  })
})

describe('a for-you row', () => {
  test('takes links out of the words and labels them by host', () => {
    const item = { text: `Pick a design per screen on the board: ${ARTIFACT}.`, details: [] }
    expect(withoutLinks(item.text)).toBe('Pick a design per screen on the board')
    expect(itemLinks(item)).toEqual([ARTIFACT])
    expect(linkLabel(ARTIFACT)).toBe('↗ claude.ai')
    expect(linkLabel('https://www.github.com/katyella/session-sidebar/pull/2', 60)).toBe('↗ github.com/katyella/session-sidebar/pull/2')
    expect(linkLabel('https://www.github.com/katyella/session-sidebar/pull/2', 30)).toBe('↗ github.com/katyell…ebar/pull/2')
  })

  test('cuts the middle and keeps the end', () => {
    const cut = cutMiddle('Run the migration on staging first, then paste what `npm run check` prints', 40)
    expect(cut.length).toBe(40)
    expect(cut).toContain('…')
    expect(cut.endsWith('prints')).toBe(true)
    expect(cutMiddle('short', 40)).toBe('short')
  })

  test('opens only when there is more to see', () => {
    const short = forYouView({ text: 'Approve the plan', details: [] }, 60, 'Approve the plan')
    expect(short.hasMore).toBe(false)
    expect(short.isOpen).toBe(false)
    const withDetails = forYouView({ text: 'Approve the plan', details: ['see section 3'] }, 60, 'Approve the plan')
    expect(withDetails.hasMore).toBe(true)
    expect(withDetails.isOpen).toBe(true)
    expect(withDetails.rows).toBe(2)
  })
})

/** The session's state as the kit keeps it, but for-you.md's items read as these (stored under the atom's shape tag). */
function seedForYou(on: On, items: ForYou['items']): void {
  on('state.get', (_, e, next) => (e.key === 'forYou' ? { value: { value: { shape: 'foryou-3', value: { items, mtimeMs: 1 } }, version: 1 } } : next(e)))
}

const PANE = {
  plugin: 'session-sidebar',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'session-sidebar',
  props: { title: 'Session', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  viewport: { columns: 62, rows: 50 },
} as const

describe('the For you section', () => {
  test('draws a long item on one line, its link last, and opens it in full on a press', async ($, on) => {
    const text = 'Pick a design for each of the five onboarding screens on the board and say which two are close calls'
    seedForYou(on, [{ text, details: [ARTIFACT, 'Two of the five are close calls'] }])
    mock.clock(on, { now: 1_000 })

    const ui = await $.ui.mount(PANE)
    const link = await ui.find({ type: 'Link' })
    expect(link?.props.href).toBe(ARTIFACT)
    expect(link?.props.label).toBe('↗ claude.ai')
    const row = await ui.find({ key: 'you-open-0' })
    expect(row?.text).toContain('…')
    expect(row?.text).toContain('close calls')
    expect(await ui.find({ type: 'Text', text: /Two of the five/ })).toBeUndefined()

    await ui.press({ key: 'you-open-0' })
    expect(await ui.find({ type: 'Text', text: text })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Two of the five/ })).toBeDefined()

    await ui.press({ key: 'you-open-0' })
    expect(await ui.find({ type: 'Text', text: /Two of the five/ })).toBeUndefined()
    await ui.unmount()
  })

  test('draws on the desktop too', async ($, on) => {
    seedForYou(on, [{ text: `Pick a design per screen: ${ARTIFACT}`, details: ['Two of the five are close calls'] }])
    mock.clock(on, { now: 1_000 })

    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe(ARTIFACT)
    await ui.press({ key: 'you-open-0' })
    expect(await ui.find({ type: 'Text', text: /Two of the five/ })).toBeDefined()
    await ui.unmount()
  })

  test('draws a short item with nothing to open as plain text', async ($, on) => {
    seedForYou(on, [{ text: 'Approve the plan', details: [] }])
    mock.clock(on, { now: 1_000 })

    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ key: 'you-open-0' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Approve the plan/ })).toBeDefined()
    expect(await ui.find({ key: 'you-done-0' })).toBeDefined()
    await ui.unmount()
  })

  test('draws a choice\'s options as buttons, and a press sends the pick to Claude', async ($, on) => {
    seedForYou(on, [
      {
        text: 'Which demo should I build next?',
        details: [],
        choices: [
          { label: 'Welcome back catch-up', isRecommended: true },
          { label: 'CI arrivals board', isRecommended: false },
        ],
      },
    ])
    mock.clock(on, { now: 1_000 })
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    on('ui.toast', () => ({ value: undefined }))

    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ key: 'you-0-pick-0' }))?.text).toMatch(/Welcome back catch-up +★ Claude's pick/)
    expect((await ui.find({ key: 'you-0-pick-0' }))?.props.hotkey).toBe('a')
    expect((await ui.find({ key: 'you-0-pick-1' }))?.text).toContain('CI arrivals board')
    await ui.press({ key: 'you-0-pick-1' })
    expect(sent).toEqual(['Answer to "Which demo should I build next?": CI arrivals board'])
    await ui.unmount()
  })
})
