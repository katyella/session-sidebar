import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { othersShown, parseScan, projectName } from '../hooks/others'
import type { Others } from '../types'

const SCAN = [
  'NOW 1000',
  'S\tsess-a\t-Users-me-dev-chief-of-staff\t990',
  'R\tsess-a\t# Keep the VPN up',
  'R\tsess-a\t- [x] Find why it drops',
  'R\tsess-a\t- [~] Watch it for an hour',
  'R\tsess-a\t- [ ] Merge',
  'Y\tsess-a\t- Approve the watchdog PR',
  'Y\tsess-a\t  - https://github.com/x/y/pull/1',
  'Y\tsess-a\t- Which window for the restart?',
  'Y\tsess-a\t  - (*) Tonight',
  'Y\tsess-a\t  - ( ) Sunday',
  'S\tsess-b\t-Users-me--claude-mods-session-sidebar\t0',
  'S\tthis-one\t-Users-me-dev-katyella\t999',
].join('\n')

describe('the other sessions', () => {
  test('read from a scan: road, current step, waiting items and their choices; this session left out', () => {
    const list = parseScan(SCAN, '', new Set(['this-one']), 1_000_000)
    expect(list.map(s => s.project)).toEqual(['chief-of-staff', 'session-sidebar'])
    const a = list[0]!
    expect(a.activeAt).toBe(990_000)
    expect([a.title, a.done, a.total]).toEqual(['Keep the VPN up', 1, 3])
    expect(a.current).toEqual({ state: 'now', text: 'Watch it for an hour' })
    expect(a.items.map(i => i.text)).toEqual(['Approve the watchdog PR', 'Which window for the restart?'])
    expect(a.items[1]?.choices?.map(c => c.label)).toEqual(['Tonight', 'Sunday'])
  })

  test("a remote machine's times are moved onto this clock", () => {
    const list = parseScan(SCAN, 'root@cos', new Set(['this-one']), 1_500_000)
    // Its clock read 1000 s when this one read 1500 s: 500 s behind.
    expect(list.find(s => s.id === 'sess-a')?.activeAt).toBe(1_490_000)
    // Another machine's sessions are never this one.
    expect(list.some(s => s.id === 'this-one')).toBe(true)
  })

  test('name a project folder by its last part', () => {
    expect(projectName('-Users-me-dev-podcast-search')).toBe('podcast-search')
    expect(projectName('-home-kaskade-kaskade')).toBe('kaskade')
    expect(projectName('-Users-me--claude-mods-session-sidebar')).toBe('session-sidebar')
  })

  test('list waiting ones first, then working, then recently active; old idle ones left out', () => {
    const now = 10_000_000
    const base = { host: '', title: '', done: 0, total: 0, items: [] }
    const list = othersShown(
      [
        { ...base, id: 'idle-old', project: 'old', activeAt: now - 3_600_000 },
        { ...base, id: 'working', project: 'busy', activeAt: now - 5_000 },
        { ...base, id: 'recent', project: 'recent', activeAt: now - 600_000 },
        { ...base, id: 'waiting', project: 'waits', activeAt: now - 3_600_000, items: [{ text: 'Approve it', details: [] }] },
      ],
      now,
    )
    expect(list.map(s => s.id)).toEqual(['waiting', 'working', 'recent'])
  })
})

const NOW = 10_000_000

const OTHERS: Others = {
  sessions: [
    {
      id: 'sess-a',
      host: '',
      project: 'chief-of-staff',
      activeAt: NOW - 600_000,
      title: 'Keep the VPN up',
      done: 1,
      total: 3,
      current: { state: 'now', text: 'Watch it for an hour' },
      items: [{ text: 'Approve the watchdog PR https://github.com/x/y/pull/1', details: [] }],
    },
    { id: 'sess-k', host: 'root@cos', project: 'kaskade', activeAt: NOW - 5_000, title: '', done: 0, total: 0, items: [] },
  ],
  hosts: [{ target: 'root@cos', isUp: true, at: NOW - 20_000 }],
  at: NOW,
}

function seedOthers(on: On): void {
  on('state.get', (_, e, next) => (e.key === 'others' ? { value: { value: { shape: 'others-1', value: OTHERS }, version: 1 } } : next(e)))
}

const PANE = {
  plugin: 'session-sidebar',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'session-sidebar',
  props: { title: 'Session', isFocused: false, bodyColumns: 64, placement: 'dock', scroll: { offset: 0, bodyRows: 50 }, view: {} },
  viewport: { columns: 66, rows: 60 },
} as const

describe('the Other sessions section', () => {
  test('groups sessions by machine, each session one line until opened, a machine folds', { options: { otherMachines: ['root@cos'] } }, async ($, on) => {
    seedOthers(on)
    mock.clock(on, { now: NOW })

    const ui = await $.ui.mount(PANE)
    expect((await ui.find({ key: 'others-machine-here' }))?.text).toContain('this machine')
    expect((await ui.find({ key: 'others-machine-root@cos' }))?.text).toContain('read 20s ago')
    const row = await ui.find({ key: 'others-here-sess-a' })
    expect(row?.text).toContain('chief-of-staff')
    expect(row?.text).toContain('Approve the watchdog PR')
    expect((await ui.find({ key: 'others-root@cos-sess-k' }))?.text).toContain('working')
    // Folded: the road is not shown until the session is opened.
    expect(await ui.find({ type: 'Text', text: /Watch it for an hour/ })).toBeUndefined()

    await ui.press({ key: 'others-here-sess-a' })
    expect(await ui.find({ type: 'Text', text: /Watch it for an hour/ })).toBeDefined()
    expect((await ui.find({ type: 'Link' }))?.props.href).toBe('https://github.com/x/y/pull/1')

    await ui.press({ key: 'others-machine-root@cos' })
    expect(await ui.find({ key: 'others-root@cos-sess-k' })).toBeUndefined()
    await ui.unmount()
  })

  test('with no other machines, a flat list with no machine headings', async ($, on) => {
    seedOthers(on)
    mock.clock(on, { now: NOW })

    const ui = await $.ui.mount(PANE)
    expect(await ui.find({ key: 'others-machine-here' })).toBeUndefined()
    expect((await ui.find({ key: 'others-here-sess-a' }))?.text).toContain('chief-of-staff')
    // A remote session with no remote machine set is not drawn.
    expect(await ui.find({ key: 'others-root@cos-sess-k' })).toBeUndefined()
    await ui.unmount()
  })

  test('reads working and idle against the clock, not the task clock that stands still with no task running', async ($, on) => {
    const quiet: Others = { ...OTHERS, sessions: [{ ...OTHERS.sessions[0]!, items: [], activeAt: NOW - 120_000 }] }
    on('state.get', (_, e, next) => {
      if (e.key === 'others') return { value: { value: { shape: 'others-1', value: quiet }, version: 1 } }
      // The task clock last moved an hour ago, when a background task ran.
      if (e.key === 'tail') return { value: { value: { shape: 'tail-1', value: { id: '', lines: [], size: 0, now: NOW - 3_600_000 } }, version: 1 } }
      return next(e)
    })
    mock.clock(on, { now: NOW })

    const ui = await $.ui.mount(PANE)
    const row = await ui.find({ key: 'others-here-sess-a' })
    expect(row?.text).not.toContain('working')
    expect(row?.text).toContain('Keep the VPN up')
    await ui.unmount()
  })
})
