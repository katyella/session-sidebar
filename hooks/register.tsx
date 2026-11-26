import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement, RenderSurface, ThemeKey } from 'claude-code'

import type { AgentMessage, BgAgent, BgTask, FilesNote, ForYou, ForYouItem, OtherSession, Others, OthersView, Road, RoadItem, Tail } from '../types'
import { FOR_YOU_GUTTER, URL_SPLIT, cutMiddle, forYouView, itemLinks, linkLabel, parseForYou, trimLink, withoutLinks } from './for-you'
import type { ForYouView } from './for-you'
import { LOCAL_SCAN, REMOTE_SCAN, WORKING_MS, othersShown, parseScan } from './others'

// No gray (dimColor or 'inactive'): it is hard to read in this terminal theme.
const PANE = 'session-sidebar'
const TITLE = 'Session'
// Change a tag when that value's fields change: it declines what an earlier
// version stored, which outlives a reload.
const tasks = atom({ plugin: 'session-sidebar', key: 'tasks' } as const, [], { shape: 'tasks-2' })
const selected = atom({ plugin: 'session-sidebar', key: 'selected' } as const, '', { shape: 'selected-1' })
const road = atom({ plugin: 'session-sidebar', key: 'road' } as const, { title: '', items: [], mtimeMs: 0 }, { shape: 'road-1' })
const forYou = atom({ plugin: 'session-sidebar', key: 'forYou' } as const, { items: [], mtimeMs: 0 } as ForYou, { shape: 'foryou-3' })
const forYouOpen = atom({ plugin: 'session-sidebar', key: 'forYouOpen' } as const, '', { shape: 'foryouopen-1' })
const others = atom({ plugin: 'session-sidebar', key: 'others' } as const, { sessions: [], hosts: [], at: 0 } as Others, { shape: 'others-1' })
const othersView = atom({ plugin: 'session-sidebar', key: 'othersView' } as const, { open: [], folded: [] } as OthersView, { shape: 'othersview-1' })
/** Lines Other sessions takes at most, headings of machines included. */
const OTHERS_ROWS = 10
/** This machine's sessions are read this often; another machine's every minute, or five after it failed. */
const LOCAL_SCAN_MS = 10_000
const REMOTE_SCAN_MS = 60_000
const REMOTE_RETRY_MS = 5 * 60_000
/** Kept in session state so a plugin reload after a /clear still knows the first session's scratchpad. */
const sessions = atom({ plugin: 'session-sidebar', key: 'sessions' } as const, [] as string[], { shape: 'sessions-1' })
/** Keys that press a choice's options, in order: letters the pane does not use (c clears, f follows). */
const CHOICE_KEYS = ['a', 'b', 'd', 'e', 'g', 'h']
/** For-you lines shown at most. */
const FOR_YOU_ROWS = 5
const messages = atom({ plugin: 'session-sidebar', key: 'messages' } as const, [], { shape: 'messages-1' })
const agents = atom({ plugin: 'session-sidebar', key: 'agents' } as const, [], { shape: 'agents-1' })
const tail = atom({ plugin: 'session-sidebar', key: 'tail' } as const, { id: '', lines: [], size: 0, now: 0 }, { shape: 'tail-1' })
/** Where the files section went out as prompt context (the fallback); in session state so a reload does not send it again. */
const filesNote = atom({ plugin: 'session-sidebar', key: 'filesNote' } as const, { sessionId: '', tokens: 0 } as FilesNote, { shape: 'filesnote-1' })

const POLL_MS = 1000
const TAIL_LINES = 400
/** A task found only by its file counts as live while it wrote this recently. */
const LIVE_MS = 15_000
/** Files older than this when first seen are earlier, finished work: not listed. */
const STALE_MS = 15 * 60_000
const MAX_TASKS = 30
const MAX_ROWS = 6
const MAX_AGENTS = 20
/** Agent rows shown; with any, task rows give one up so every row keeps a number key (1-9). */
const AGENT_ROWS = 4
/** Messages kept, and body lines drawn per message at most. */
const MAX_MESSAGES = 60
const MESSAGE_LINES = 4
/** Road lines shown at most; earlier finished steps fold into one line. */
const ROAD_ROWS = 9
/** Bytes of a subagent's transcript read for its OUTPUT view. */
const TRANSCRIPT_BYTES = 400_000
/** The harness ends a finished task's output file with this line. */
const EXITED = /\[exited with code (\d+)\]\s*$/

/** 0 completed; a signal (128 + n) was a stop; anything else failed. */
function endedAs(code: number): BgTask['status'] {
  return code === 0 ? 'completed' : code > 128 ? 'killed' : 'failed'
}

/**
 * Test results as common runners print them, one match per result; a "[label] " line prefix is allowed:
 * go test (package ok / FAIL lines), Swift Testing, XCTest, pytest -v, jest and vitest, cargo test.
 */
const OK_PATTERN = [
  '^(\\[[^]]*\\] )?ok[[:space:]]',
  '✔ Test ("|[a-zA-Z_][a-zA-Z0-9_]*\\()',
  "Test Case '[^']*' passed",
  '::[^[:space:]]+ PASSED',
  '^(\\[[^]]*\\] )?[[:space:]]+(✓|√) ',
  '^(\\[[^]]*\\] )?test [^[:space:]]+ \\.\\.\\. ok$',
].join('|')
const FAIL_PATTERN = [
  '^(\\[[^]]*\\] )?FAIL[[:space:]]+[^[:space:]]',
  '✘ Test ("|[a-zA-Z_][a-zA-Z0-9_]*\\()',
  "Test Case '[^']*' failed",
  '::[^[:space:]]+ FAILED',
  '^(\\[[^]]*\\] )?[[:space:]]+(✕|×) ',
  '^(\\[[^]]*\\] )?test [^[:space:]]+ \\.\\.\\. FAILED$',
].join('|')
/** Results are recounted at most this often while a file grows, and once when its run ends. */
const COUNT_MS = 5_000
/** A run that took this long raises a notice when it ends; this long, a native notification too. */
const NOTICE_MS = 30_000
const NATIVE_MS = 5 * 60_000

// The module's own: they start over on a reload, which is fine.
// Paths are looked up per session id: a /clear goes on under a new id in the same process.
let tasksDir: string | undefined
let tasksSession = ''
let tasksMissAt = 0
let transcriptPath: string | null | undefined
let transcriptSession = ''
/**
 * The scratchpad folders this process has used: the one the session reports ($.session.info().scratchpadDir), the
 * one beside the current session's folder, and earlier ones kept across a /clear (after a /clear the scratchpad
 * Claude is told about may keep either id). A file is read from whichever copy is newest.
 */
const scratchDirs = new Set<string>()
/** The for-you file the poll last read: a button press uses it as is (session lookups are for the poll). */
let forYouPath: string | undefined
/** For-you items already announced by a toast and notification. */
const announced = new Set<string>()
let sessionDir: string | undefined
let sessionDirOf = ''
let sessionMissAt = 0
/** When the running poll began: a poll stuck past POLL_STUCK_MS no longer blocks the next one. */
let pollingSince = 0
const POLL_STUCK_MS = 15_000
/** Tasks whose name was looked up in the transcript already (found or not). */
const named = new Set<string>()
let polling = false
const countedAt = new Map<string, number>()

/** Passing and failing results over the whole file, not just the tail shown. */
async function countResults($: EngineInterface, path: string): Promise<{ ok: number; failed: number } | undefined> {
  const out = await $.process
    .run(
      ['/bin/sh', '-c', 'LC_ALL=en_US.UTF-8 grep -cE "$1" "$3"; LC_ALL=en_US.UTF-8 grep -cE "$2" "$3"; true', 'sh', OK_PATTERN, FAIL_PATTERN, path],
      { timeoutMs: 5_000 },
    )
    .catch(() => undefined)
  const [ok, failed] = (out?.stdout ?? '').trim().split('\n').map(Number)
  if (ok === undefined || failed === undefined || Number.isNaN(ok) || Number.isNaN(failed)) return undefined
  return { ok, failed }
}

/** Red for failures, green for passes, yellow for skips and warnings; other lines plain. */
function lineTone(line: string): ThemeKey | undefined {
  const s = line.replace(/^\[[^\]]*\] /, '')
  if (
    /^(FAIL\b|--- FAIL|panic:|fatal error:|error(\[[A-Z0-9]+\])?:|Error:|Traceback |npm ERR!)|\b[A-Z]+(_[A-Z]+)*_FAILED\b|✘|✕|::\S+ FAILED|\.\.\. FAILED$|Test Case '.*' failed|^Test run with .* failed|\b(BUILD|VET|LINT|COMPILE|TESTS?|GATE) FAILED\b|^\s*\d+ failed/.test(s)
  ) {
    return 'error'
  }
  if (/^(ok\s|--- PASS|PASS\b)|✔|^\s+✓ |::\S+ PASSED|\.\.\. ok$|Test Case '.*' passed|^Test run with .* passed|^\s*\d+ passed/.test(s)) return 'success'
  if (/^(--- SKIP|WARN|warning(\[[A-Za-z0-9-]+\])?:)|\bSKIPPED\b|DeprecationWarning/.test(s)) return 'warning'
  if (/^▸ /.test(s)) return 'suggestion'
  if (/^» /.test(s)) return 'claude'
  return undefined
}

/** A notice for a run that ended after a while: a toast, and past NATIVE_MS a native notification. */
async function announce($: EngineInterface, t: BgTask): Promise<void> {
  const took = (t.endedAt ?? t.lastWriteMs) - t.startedAt
  if (took < NOTICE_MS) return
  const full = label(t)
  const name = full.length > 60 ? `${full.slice(0, 59)}…` : full
  const verb = t.status === 'completed' ? 'finished' : t.status === 'failed' ? 'failed' : 'stopped'
  const results = [t.ok ? `${t.ok} ok` : '', t.failed ? `${t.failed} FAIL` : ''].filter(part => part !== '').join(', ')
  const text = `${glyph(t, 0)} ${name} ${verb} after ${clock(took)}${results !== '' ? ` · ${results}` : ''}`
  $.ui.toast(text, { timeoutMs: 10_000 })
  if (took >= NATIVE_MS) await $.ui.notify(text, { title: 'Background task' }).catch(() => undefined)
}

/** Where this session's background tasks write: <tmp>/claude-<uid>/<project>/<session>/tasks. */
async function findTasksDir($: EngineInterface): Promise<string | undefined> {
  const session = await $.session.id()
  if (tasksDir !== undefined && tasksSession === session) return tasksDir
  // No folder yet (nothing ran in the background): look again every few seconds, not every poll.
  const now = await $.clock.now()
  if (tasksSession === session && now - tasksMissAt < 5_000) return undefined
  tasksSession = session
  tasksDir = undefined
  for (const root of ['/private/tmp', '/tmp']) {
    const found = await $.process
      .run(['find', root, '-maxdepth', '4', '-type', 'd', '-path', `*/${session}/tasks`], { timeoutMs: 10_000 })
      .catch(() => undefined)
    const dir = found?.stdout.split('\n').find(line => line.trim() !== '')
    if (dir !== undefined) {
      tasksDir = dir.trim()
      return tasksDir
    }
  }
  tasksMissAt = now
  return undefined
}

/**
 * This process's scratchpad folders: the one the session reports (the folder Claude is told to write to), the
 * current session's (beside its folder on disk) and earlier sessions' ids. After a /clear the reported scratchpad
 * can sit under either the old or the new id, so it is read from the session rather than derived from an id.
 */
async function scratchCandidates($: EngineInterface): Promise<string[]> {
  const reported = await $.session.info().then(i => i.scratchpadDir, () => undefined)
  if (reported) scratchDirs.add(reported.replace(/\/+$/, ''))
  const folder = await findSessionDir($)
  if (folder !== undefined) {
    scratchDirs.add(`${folder}/scratchpad`)
    const project = folder.replace(/\/[^/]+$/, '')
    for (const id of await read($, sessions)) scratchDirs.add(`${project}/${id}/scratchpad`)
  }
  return [...scratchDirs]
}

/** <tmp>/claude-<uid>/<project>/<session>: made when the session starts, before any background task. */
async function findSessionDir($: EngineInterface): Promise<string | undefined> {
  const session = await $.session.id()
  if (sessionDir !== undefined && sessionDirOf === session) return sessionDir
  const now = await $.clock.now()
  if (sessionDirOf === session && now - sessionMissAt < 5_000) return undefined
  sessionDirOf = session
  sessionDir = undefined
  for (const root of ['/private/tmp', '/tmp']) {
    const found = await $.process
      .run(['find', root, '-maxdepth', '3', '-type', 'd', '-name', session], { timeoutMs: 5_000 })
      .catch(() => undefined)
    const dir = found?.stdout.split('\n').find(line => line.trim() !== '')
    if (dir !== undefined) {
      sessionDir = dir.trim()
      return sessionDir
    }
  }
  sessionMissAt = now
  return undefined
}

/** The newest copy of a scratchpad file (road.md, for-you.md) among this process's scratchpad folders. */
async function scratchFile($: EngineInterface, name: string): Promise<{ path: string; mtimeMs: number } | undefined> {
  let best: { path: string; mtimeMs: number } | undefined
  for (const folder of await scratchCandidates($)) {
    const path = `${folder}/${name}`
    const file = await $.fs.stat(path).catch(() => undefined)
    if (file === undefined || file.kind !== 'file') continue
    if (best === undefined || file.mtimeMs > best.mtimeMs) best = { path, mtimeMs: file.mtimeMs }
  }
  return best
}

/** This session's main transcript: ~/.claude/projects/<project>/<session>.jsonl. */
async function findTranscript($: EngineInterface): Promise<string | null> {
  const session = await $.session.id()
  if (transcriptPath !== undefined && transcriptSession === session) return transcriptPath
  transcriptSession = session
  const found = await $.process
    .run(['/bin/sh', '-c', 'find "$HOME/.claude/projects" -maxdepth 2 -name "$1.jsonl" -print -quit', 'sh', session], { timeoutMs: 10_000 })
    .catch(() => undefined)
  const path = found?.stdout.trim() ?? ''
  transcriptPath = path === '' ? null : path
  return transcriptPath
}

type ToolLine = { message?: { content?: unknown } }
type ToolBlock = { type?: string; id?: string; name?: string; tool_use_id?: string; input?: Record<string, unknown> }

/** Tools whose background runs are shell output worth tailing; a subagent's file is a transcript, shown as an agent. */
const SHELL_TOOLS = new Set(['Bash', 'Monitor'])

function blocksOf(line: string): ToolBlock[] {
  try {
    const content = (JSON.parse(line) as ToolLine).message?.content
    return Array.isArray(content) ? (content as ToolBlock[]) : []
  } catch {
    return []
  }
}

/**
 * The Bash call that started a background task, from the transcript: its result says "with ID: <id>",
 * and the call with that result's tool_use_id carries the description and command.
 */
async function taskName($: EngineInterface, id: string): Promise<{ title: string; command: string } | undefined> {
  const path = await findTranscript($)
  if (path === null) return undefined
  const grep = (pattern: string) =>
    $.process.run(['grep', '-m1', '-F', pattern, path], { timeoutMs: 10_000 }).then(
      out => out.stdout.split('\n')[0] ?? '',
      () => '',
    )
  const resultLine = await grep(`with ID: ${id}`)
  const useId = blocksOf(resultLine).find(b => b.type === 'tool_result' && typeof b.tool_use_id === 'string')?.tool_use_id
  if (useId === undefined) return undefined
  const call = blocksOf(await grep(`"id":"${useId}"`)).find(b => b.type === 'tool_use' && b.id === useId)
  if (call?.input === undefined || !SHELL_TOOLS.has(call.name ?? '')) return undefined
  const title = typeof call.input['description'] === 'string' ? call.input['description'] : ''
  const command = typeof call.input['command'] === 'string' ? call.input['command'] : ''
  return title === '' && command === '' ? undefined : { title, command }
}

function isLive(t: BgTask, now: number): boolean {
  return t.status === 'running' || (t.status === 'unknown' && now - t.lastWriteMs < LIVE_MS)
}

/** Live tasks first, newest first within each group; cleared and still-unnamed ones left out. */
function ordered(list: readonly BgTask[], now: number): BgTask[] {
  return list.filter(t => t.hidden !== true && (t.title !== '' || t.command !== '')).sort((a, b) => {
    const live = Number(isLive(b, now)) - Number(isLive(a, now))
    return live !== 0 ? live : Math.max(b.startedAt, b.lastWriteMs) - Math.max(a.startedAt, a.lastWriteMs)
  })
}

/** Terminal escapes out; a carriage-return progress line keeps its last state. */
function clean(text: string): string[] {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split('\n')
    .map(line => {
      const parts = line.split('\r').filter(part => part !== '')
      return (parts[parts.length - 1] ?? '').replace(/\t/g, '    ')
    })
}

async function poll($: EngineInterface): Promise<void> {
  // The road and for-you files do not depend on a tasks folder existing.
  await pollRoad($).catch(() => undefined)
  await pollForYou($).catch(() => undefined)
  const dir = await findTasksDir($)
  if (dir === undefined) return
  const now = await $.clock.now()
  const entries = await $.fs.list(dir).catch(() => [])
  const files = new Map<string, { size: number; mtimeMs: number }>()
  for (const entry of entries) {
    if (entry.kind === 'file' && entry.name.endsWith('.output')) {
      files.set(entry.name.slice(0, -'.output'.length), { size: entry.size, mtimeMs: entry.mtimeMs })
    }
  }

  const before = await read($, tasks)
  const known = new Set(before.map(t => t.id))
  const beforeById = new Map(before.map(t => [t.id, t] as const))
  let isChanged = false
  const next: BgTask[] = before.map(t => {
    const file = files.get(t.id)
    if (file === undefined || (file.size === t.size && file.mtimeMs === t.lastWriteMs)) return t
    isChanged = true
    return { ...t, size: file.size, lastWriteMs: file.mtimeMs }
  })
  const fresh = new Set<string>()
  const finished: BgTask[] = []
  for (const [id, file] of files) {
    if (known.has(id) || now - file.mtimeMs > STALE_MS) continue
    isChanged = true
    fresh.add(id)
    next.push({ id, title: '', command: '', startedAt: file.mtimeMs, status: 'unknown', lastWriteMs: file.mtimeMs, size: file.size })
  }

  // A notification that arrives mid-turn never reaches prompt.submit, so the file's own
  // exit line is what ends a run. Running tasks are checked every period; a task found
  // by its file when it is new or has just been written.
  for (const [i, t] of next.entries()) {
    if (t.status !== 'running' && t.status !== 'unknown') continue
    const file = files.get(t.id)
    if (file === undefined) {
      // Its file is gone: whatever it was, it no longer runs.
      if (t.status === 'running' && now - t.startedAt > LIVE_MS) {
        next[i] = { ...t, status: 'unknown' }
        isChanged = true
      }
      continue
    }
    const prev = beforeById.get(t.id)
    const isWritten = prev === undefined || prev.size !== file.size || prev.lastWriteMs !== file.mtimeMs
    if (t.status === 'unknown' && !fresh.has(t.id) && !isWritten) continue
    const end = await $.process
      .run(['tail', '-c', '64', `${dir}/${t.id}.output`], { timeoutMs: 5_000 })
      .catch(() => undefined)
    const exit = end === undefined ? null : EXITED.exec(end.stdout)
    if (exit === null) continue
    next[i] = { ...t, status: endedAs(Number(exit[1])), endedAt: file.mtimeMs }
    if (t.status === 'running') finished.push(next[i])
    isChanged = true
  }

  // Results for every file that grew (at most every COUNT_MS), and a last count for a run that just ended.
  const ending = new Set(finished.map(t => t.id))
  for (const [i, t] of next.entries()) {
    const file = files.get(t.id)
    if (file === undefined) continue
    const prev = beforeById.get(t.id)
    const isGrown = fresh.has(t.id) || prev === undefined || prev.size !== file.size
    if (!isGrown && !ending.has(t.id)) continue
    if (!ending.has(t.id) && now - (countedAt.get(t.id) ?? 0) < COUNT_MS) continue
    countedAt.set(t.id, now)
    const results = await countResults($, `${dir}/${t.id}.output`)
    if (results === undefined || (results.ok === (t.ok ?? 0) && results.failed === (t.failed ?? 0))) continue
    next[i] = { ...t, ok: results.ok, failed: results.failed }
    isChanged = true
  }
  // Tasks found only by their file get the name their Bash call gave them (looked up once each).
  // No background call names it: it is a foreground command's scratch file, which is not a task.
  for (const [i, t] of next.entries()) {
    if (t.title !== '' || t.command !== '' || t.hidden === true || named.has(t.id)) continue
    named.add(t.id)
    const found = await taskName($, t.id)
    next[i] = found === undefined ? { ...t, hidden: true } : { ...t, title: found.title, command: found.command }
    isChanged = true
  }
  if (isChanged) await update($, tasks, () => next.slice(-MAX_TASKS))
  for (const t of next) if (ending.has(t.id)) void announce($, t)

  const agentList = await pollAgents($, dir, now)

  const chosen = await read($, selected)
  const view = await read($, tail)
  const anyLive = next.some(t => isLive(t, now)) || agentList.some(agentIsLive)
  // Nothing picked: the pane shows the message feed, so no output is read.
  if (chosen === '') {
    if (anyLive) await update($, tail, current => ({ ...current, now }))
    return
  }
  const shown = pick(next, agentList, chosen, now)
  if (shown === undefined) return
  if (shown.id !== view.id || shown.size !== view.size) {
    let lines: string[]
    if (shown.kind === 'agent') {
      lines = await agentLines($, `${dir}/${shown.id}.output`)
    } else {
      const out = await $.process
        .run(['tail', '-n', String(TAIL_LINES), `${dir}/${shown.id}.output`], { timeoutMs: 5_000 })
        .catch(() => undefined)
      // A transcript (one JSON object per line) is an agent's work: summarized, never dumped raw.
      const isTranscript = out !== undefined && /^\{"(type|parentUuid|isSidechain|uuid)"/.test(out.stdout.split('\n').find(l => l.trim() !== '')?.trim() ?? '')
      lines = out === undefined ? [] : isTranscript ? await agentLines($, `${dir}/${shown.id}.output`) : clean(out.stdout)
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    await update($, tail, () => ({ id: shown.id, lines, size: shown.size, now }))
  } else if (anyLive) {
    // Ages and elapsed times move on while anything runs.
    await update($, tail, current => ({ ...current, now }))
  }
}

// ---------- Road so far ----------

/**
 * The road file: "# Title", then "- [x] done", "- [~] now" (or "[>]"), "- [ ] next", "- [!] problem";
 * a plain "- note" (indented or not) is a note under the step above it.
 */
function parseRoad(text: string): Pick<Road, 'title' | 'items'> {
  let title = ''
  const items: RoadItem[] = []
  for (const line of text.split('\n')) {
    const heading = /^#\s+(.*\S)\s*$/.exec(line)
    if (heading !== null && title === '') {
      title = heading[1] ?? ''
      continue
    }
    const step = /^(\s*)[-*]\s+\[([ xX~>!])\]\s+(.*\S)\s*$/.exec(line)
    if (step !== null) {
      const mark = step[2] ?? ' '
      const state: RoadItem['state'] =
        mark === 'x' || mark === 'X' ? 'done' : mark === '~' || mark === '>' ? 'now' : mark === '!' ? 'problem' : 'next'
      items.push({ state, text: step[3] ?? '', depth: Math.floor((step[1] ?? '').length / 2) })
      continue
    }
    const note = /^(\s*)[-*]\s+(.*\S)\s*$/.exec(line)
    if (note !== null) items.push({ state: 'note', text: note[2] ?? '', depth: Math.max(1, Math.floor((note[1] ?? '').length / 2)) })
  }
  return { title, items }
}

/** Re-reads the road file when it changed; clears the road when the file is gone. */
async function pollRoad($: EngineInterface): Promise<void> {
  const current = await read($, road)
  const file = await scratchFile($, 'road.md')
  if (file === undefined) {
    if (current.mtimeMs !== 0) await update($, road, () => ({ title: '', items: [], mtimeMs: 0 }))
    return
  }
  if (file.mtimeMs === current.mtimeMs) return
  const text = await $.fs.read(file.path).catch(() => undefined)
  if (text === undefined) return
  await update($, road, () => ({ ...parseRoad(text), mtimeMs: file.mtimeMs }))
}

// ---------- For you ----------

/** Re-reads the for-you file when it changed; a new item raises a toast and a native notification. */
async function pollForYou($: EngineInterface): Promise<void> {
  const current = await read($, forYou)
  const file = await scratchFile($, 'for-you.md')
  forYouPath = file?.path
  if (file === undefined) {
    if (current.mtimeMs !== 0) await update($, forYou, () => ({ items: [], mtimeMs: 0 }))
    return
  }
  if (file.mtimeMs === current.mtimeMs) return
  const text = await $.fs.read(file.path).catch(() => undefined)
  if (text === undefined) return
  const items = parseForYou(text)
  // Announced once per process: a re-read or a reload never repeats a toast or a notification.
  const known = new Set(current.items.map(item => item.text))
  const added = items.filter(item => !known.has(item.text) && !announced.has(item.text))
  for (const item of items) announced.add(item.text)
  await update($, forYou, () => ({ items, mtimeMs: file.mtimeMs }))
  for (const item of added.slice(0, 2)) {
    const said = withoutLinks(item.text) || item.text
    $.ui.toast(`For you: ${said}`, { timeoutMs: 15_000 })
    await $.ui.notify(said, { title: 'For you' }).catch(() => undefined)
  }
}

/** Marks one for-you item done in the file ("- [x] item") and drops it from the list at once. */
async function markForYouDone($: EngineInterface, item: string): Promise<void> {
  try {
    await markDone($, item)
  } catch (error) {
    $.ui.toast(`Could not mark done: ${error instanceof Error ? error.message : String(error)}`, { timeoutMs: 8_000 })
  }
}

async function markDone($: EngineInterface, item: string): Promise<void> {
  const path = forYouPath
  if (path === undefined) {
    $.ui.toast('No for-you.md found yet', { timeoutMs: 5_000 })
    return
  }
  const text = await $.fs.read(path).catch(() => undefined)
  if (text === undefined) {
    $.ui.toast('Could not read for-you.md', { timeoutMs: 6_000 })
    return
  }
  let marked = false
  const lines = text.split('\n').map(line => {
    if (marked) return line
    const m = /^(\s*[-*]\s+)(?:\[([ xX])\]\s+)?(.*\S)\s*$/.exec(line)
    if (m === null || m[2] === 'x' || m[2] === 'X' || m[3] !== item) return line
    marked = true
    return `${m[1] ?? '- '}[x] ${m[3] ?? ''}`
  })
  if (!marked) {
    $.ui.toast('That item is no longer open in for-you.md', { timeoutMs: 5_000 })
    return
  }
  const wrote = await $.fs.write(path, lines.join('\n')).then(() => true, () => false)
  if (!wrote) {
    $.ui.toast('Could not update for-you.md', { timeoutMs: 6_000 })
    return
  }
  const file = await $.fs.stat(path).catch(() => undefined)
  await update($, forYou, cur => ({ items: cur.items.filter(i => i.text !== item), mtimeMs: file?.mtimeMs ?? cur.mtimeMs }))
  await update($, forYouOpen, cur => (cur === item ? '' : cur))
  $.ui.toast(`Done: ${withoutLinks(item) || item}`, { timeoutMs: 5_000 })
}

/**
 * A choice answered from the sidebar: the item is marked done in the file, and the pick goes to Claude as the
 * person's next message (queued if a turn is running).
 */
async function answerForYou($: EngineInterface, item: ForYouItem, choice: string): Promise<void> {
  const ask = withoutLinks(item.text) || item.text
  await markForYouDone($, item.text)
  await $.prompt.submit({ text: `Answer to "${ask}": ${choice}`, asUser: true })
}

/**
 * The lines to draw: earlier finished steps folded into a count, the last two finished, then the
 * current step (with its notes), problems and what comes next, up to ROAD_ROWS lines.
 */
function roadLines(items: readonly RoadItem[]): { folded: number; lines: RoadItem[] } {
  const steps = items.map((item, index) => ({ item, index }))
  const frontier = steps.find(({ item }) => item.state === 'now' || item.state === 'next' || item.state === 'problem')?.index ?? items.length
  const doneBefore = steps.filter(({ item, index }) => index < frontier && item.state === 'done')
  const keptDone = doneBefore.slice(-2)
  const folded = doneBefore.length - keptDone.length
  const lines: RoadItem[] = keptDone.map(({ item }) => item)
  let previous: RoadItem['state'] | undefined
  for (const item of items.slice(frontier)) {
    if (lines.length >= ROAD_ROWS - (folded > 0 ? 1 : 0)) break
    // Notes only under the step in progress or a problem, so the list stays short.
    if (item.state === 'note') {
      if (previous === 'now' || previous === 'problem') lines.push(item)
      continue
    }
    previous = item.state
    lines.push(item)
  }
  return { folded, lines }
}

function roadGlyph(item: RoadItem): string {
  switch (item.state) {
    case 'done':
      return '✓'
    case 'now':
      return '▶'
    case 'problem':
      return '✗'
    case 'note':
      return '·'
    default:
      return '○'
  }
}

function roadTone(item: RoadItem): ThemeKey {
  switch (item.state) {
    case 'done':
      return 'success'
    case 'now':
      return 'claude'
    case 'problem':
      return 'error'
    case 'note':
      return 'suggestion'
    default:
      return 'text'
  }
}

// ---------- Messages ----------

/** The main conversation's name in the feed. */
const LEAD = 'Claude'

async function noteMessage($: EngineInterface, message: Omit<AgentMessage, 'at'>): Promise<void> {
  const at = await $.clock.now()
  await update($, messages, list => [...list, { ...message, at }].slice(-MAX_MESSAGES))
}

/** What a SendMessage carries, as text: the message, or a structured request named by its type. */
function messageText(message: unknown): string {
  if (typeof message === 'string') return message
  if (message !== null && typeof message === 'object') {
    const typed = message as { type?: unknown; reason?: unknown; feedback?: unknown }
    const kind = typeof typed.type === 'string' ? typed.type.replace(/_/g, ' ') : 'message'
    const why = typeof typed.reason === 'string' ? typed.reason : typeof typed.feedback === 'string' ? typed.feedback : ''
    return why === '' ? kind : `${kind}: ${why}`
  }
  return ''
}

/** Local HH:MM. */
function hhmm(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Hard-wraps one paragraph to `width` columns, at spaces where it can. */
function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split('\n')) {
    let rest = paragraph.replace(/\s+$/, '')
    if (rest.trim() === '') continue
    while (rest.length > width) {
      const cut = rest.lastIndexOf(' ', width)
      const at = cut > width / 3 ? cut : width
      out.push(rest.slice(0, at))
      rest = rest.slice(at).replace(/^ /, '')
    }
    out.push(rest)
  }
  return out
}

type FeedLine = { kind: 'head'; from: string; to: string; text: string } | { kind: 'body'; text: string }

/** The newest messages that fit `room` lines, oldest first: a header line, then up to MESSAGE_LINES of body. */
function feed(list: readonly AgentMessage[], room: number, width: number): FeedLine[] {
  const blocks: FeedLine[][] = []
  let used = 0
  for (const m of [...list].reverse()) {
    const body = wrap(m.text, Math.max(20, width - 4))
    const shown = body.slice(0, MESSAGE_LINES)
    if (body.length > MESSAGE_LINES) shown[MESSAGE_LINES - 1] = `${(shown[MESSAGE_LINES - 1] ?? '').slice(0, Math.max(0, width - 6))} …`
    const block: FeedLine[] = [
      { kind: 'head', from: m.from, to: m.to, text: `${hhmm(m.at)}${m.summary !== '' ? ` · ${m.summary}` : ''}` },
      ...shown.map(text => ({ kind: 'body' as const, text })),
    ]
    if (used + block.length > room && blocks.length > 0) break
    blocks.push(block.slice(0, Math.max(1, room - used)))
    used += block.length
    if (used >= room) break
  }
  return blocks.reverse().flat()
}

// ---------- Subagents ----------

const ACTIVE = new Set<BgAgent['status']>(['pending', 'running', 'waiting'])

function agentIsLive(a: BgAgent): boolean {
  return ACTIVE.has(a.status)
}

/** Ended: completed, failed or killed (a message may still resume it, under the same id). */
function agentHasEnded(a: Pick<BgAgent, 'status'>): boolean {
  return a.status === 'completed' || a.status === 'failed' || a.status === 'killed'
}

/** Working ones first, newest first within each group; cleared ones left out. */
function orderedAgents(list: readonly BgAgent[]): BgAgent[] {
  return list.filter(a => a.hidden !== true).sort((a, b) => {
    const live = Number(agentIsLive(b)) - Number(agentIsLive(a))
    return live !== 0 ? live : Math.max(b.startedAt, b.lastWriteMs) - Math.max(a.startedAt, a.lastWriteMs)
  })
}

function agentGlyph(a: BgAgent): string {
  switch (a.status) {
    // A teammate that finished its task stays alive as idle (a message can resume it): done, not stalled.
    case 'completed':
    case 'idle':
      return '✓'
    case 'failed':
      return '✗'
    case 'killed':
      return '■'
    case 'waiting':
      return '◐'
    default:
      return '◆'
  }
}

function agentTone(a: BgAgent): ThemeKey {
  switch (a.status) {
    case 'completed':
    case 'idle':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
    case 'waiting':
      return 'warning'
    default:
      return 'claude'
  }
}

function agentLabel(a: BgAgent): string {
  return a.description !== '' ? a.description : a.name !== undefined && a.name !== '' ? a.name : `agent ${a.id}`
}

function agentAge(a: BgAgent, now: number): string {
  if (!agentHasEnded(a)) return a.status === 'idle' ? `done, ${clock(now - a.lastWriteMs)} ago` : clock(now - a.startedAt)
  const ended = a.endedAt ?? a.lastWriteMs
  return `took ${clock(ended - a.startedAt)}, ${clock(now - ended)} ago`
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** A tool call in a few words: its description, command, path, pattern or prompt. */
function summarize(input: Readonly<Record<string, unknown>> | undefined, max = 100): string {
  if (input === undefined) return ''
  for (const key of ['description', 'command', 'file_path', 'pattern', 'path', 'url', 'query', 'prompt', 'skill', 'task_id']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return oneLine(value, max)
  }
  return ''
}

type TranscriptBlock = { type?: string; text?: string; name?: string; input?: Record<string, unknown>; is_error?: boolean; content?: unknown }
type TranscriptLine = { type?: string; message?: { content?: unknown } }

function firstText(content: unknown): string {
  if (typeof content === 'string') return content.split('\n').find(line => line.trim() !== '') ?? ''
  if (Array.isArray(content)) {
    for (const block of content as TranscriptBlock[]) if (typeof block.text === 'string') return firstText(block.text)
  }
  return ''
}

/** Lines kept from one agent message: prose only, at most MESSAGE_KEEP of them; code blocks fold to a count. */
const MESSAGE_KEEP = 6
function proseLines(text: string): string[] {
  const out: string[] = []
  let inCode = false
  let codeLines = 0
  let dropped = 0
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (inCode) {
        out.push(`  ‹code, ${codeLines} line${codeLines === 1 ? '' : 's'}›`)
        codeLines = 0
      }
      inCode = !inCode
      continue
    }
    if (inCode) {
      codeLines += 1
      continue
    }
    if (line.trim() === '') continue
    if (out.length >= MESSAGE_KEEP) {
      dropped += 1
      continue
    }
    out.push(oneLine(line, 200))
  }
  if (inCode && codeLines > 0) out.push(`  ‹code, ${codeLines} line${codeLines === 1 ? '' : 's'}›`)
  if (dropped > 0) out.push(`  … ${dropped} more line${dropped === 1 ? '' : 's'}`)
  return out
}

/**
 * A subagent's recent work from its transcript's tail: messages to it ("» ..."), what it says, each tool call
 * ("▸ Bash Run the cli tests") and each failed one ("  ✘ ..."). Thinking and tool output are left out.
 */
async function agentLines($: EngineInterface, path: string): Promise<string[]> {
  const out = await $.process.run(['tail', '-c', String(TRANSCRIPT_BYTES), path], { timeoutMs: 5_000 }).catch(() => undefined)
  if (out === undefined) return []
  const raw = out.stdout.split('\n')
  // The read starts mid-file: its first line is a fragment unless the file is short.
  if (out.stdout.length >= TRANSCRIPT_BYTES) raw.shift()
  const lines: string[] = []
  for (const text of raw) {
    if (text.trim() === '') continue
    let entry: TranscriptLine
    try {
      entry = JSON.parse(text) as TranscriptLine
    } catch {
      continue
    }
    const content = entry.message?.content
    if (entry.type === 'user' && typeof content === 'string') {
      lines.push(`» ${oneLine(content, 160)}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const block of content as TranscriptBlock[]) {
      if (block.type === 'text' && entry.type === 'assistant' && typeof block.text === 'string') {
        lines.push(...proseLines(block.text))
      } else if (block.type === 'tool_use') {
        lines.push(`▸ ${block.name ?? 'tool'} ${summarize(block.input, 160)}`)
      } else if (block.type === 'tool_result' && block.is_error === true) {
        lines.push(`  ✘ ${oneLine(firstText(block.content), 160)}`)
      }
    }
  }
  return lines.slice(-TAIL_LINES)
}

/** The roster ($.agent.list) merged into the pane's own record, with transcript growth; ends are announced. */
async function pollAgents($: EngineInterface, dir: string, now: number): Promise<BgAgent[]> {
  const roster = await $.agent.list().catch(() => [])
  const before = await read($, agents)
  const byId = new Map(before.map(a => [a.id, a] as const))
  const changes = new Map<string, Partial<BgAgent>>()
  const added: BgAgent[] = []
  const finished = new Set<string>()
  const seen = new Set<string>()
  for (const info of roster) {
    seen.add(info.id)
    const had = byId.get(info.id)
    if (had === undefined) {
      // One that ended before the pane saw it is earlier work: not listed.
      if (agentHasEnded(info)) continue
      added.push({
        id: info.id,
        description: info.description,
        type: info.type,
        ...(info.name !== undefined ? { name: info.name } : {}),
        status: info.status,
        startedAt: now,
        size: 0,
        lastWriteMs: now,
      })
      continue
    }
    if (had.status !== info.status || had.description !== info.description || had.type !== info.type) {
      const isEnding = agentHasEnded(info) && !agentHasEnded(had)
      changes.set(info.id, {
        status: info.status,
        description: info.description,
        type: info.type,
        ...(isEnding ? { endedAt: now } : {}),
      })
      if (isEnding) finished.add(info.id)
    }
  }
  for (const a of before) {
    // Gone from the roster while still working: the engine dropped it as it ended.
    if (!seen.has(a.id) && agentIsLive(a)) {
      changes.set(a.id, { status: 'completed', endedAt: now })
      finished.add(a.id)
    }
  }
  for (const a of [...before, ...added]) {
    if (agentHasEnded({ status: changes.get(a.id)?.status ?? a.status }) && !finished.has(a.id)) continue
    const file = await $.fs.stat(`${dir}/${a.id}.output`).catch(() => undefined)
    if (file === undefined || file.kind !== 'file' || (file.size === a.size && file.mtimeMs === a.lastWriteMs)) continue
    changes.set(a.id, { ...changes.get(a.id), size: file.size, lastWriteMs: file.mtimeMs })
  }
  if (changes.size === 0 && added.length === 0) return before
  const list = await update($, agents, current => {
    const merged = current.map(a => {
      const change = changes.get(a.id)
      return change === undefined ? a : { ...a, ...change }
    })
    const fresh = added.filter(a => !merged.some(m => m.id === a.id))
    return [...merged, ...fresh].slice(-MAX_AGENTS)
  })
  for (const a of list) {
    if (!finished.has(a.id)) continue
    void announce($, {
      id: a.id,
      title: `${agentLabel(a)} (${a.type})`,
      command: '',
      startedAt: a.startedAt,
      lastWriteMs: a.lastWriteMs,
      size: a.size,
      status: a.status === 'failed' ? 'failed' : a.status === 'killed' ? 'killed' : 'completed',
      ...(a.endedAt !== undefined ? { endedAt: a.endedAt } : {}),
    })
  }
  return list
}

/** Records a subagent's latest tool call for its row. */
async function noteAction($: EngineInterface, agentId: string, action: string): Promise<void> {
  const now = await $.clock.now()
  await update($, agents, list =>
    list.some(a => a.id === agentId)
      ? list.map(a => (a.id === agentId ? { ...a, lastAction: action, lastActionAt: now } : a))
      : list,
  )
}

type Shown = { kind: 'task'; id: string; size: number } | { kind: 'agent'; id: string; size: number }

/** The picked task or agent; else the newest running task, the newest working agent, the newest task, the newest agent. */
function pick(taskList: readonly BgTask[], agentList: readonly BgAgent[], chosen: string, now: number): Shown | undefined {
  const asTask = (t: BgTask | undefined): Shown | undefined => (t === undefined ? undefined : { kind: 'task', id: t.id, size: t.size })
  const asAgent = (a: BgAgent | undefined): Shown | undefined => (a === undefined ? undefined : { kind: 'agent', id: a.id, size: a.size })
  const tasksInOrder = ordered(taskList, now)
  const agentsInOrder = orderedAgents(agentList)
  return (
    asTask(taskList.find(t => t.id === chosen)) ??
    asAgent(agentList.find(a => a.id === chosen)) ??
    asTask(tasksInOrder.find(t => isLive(t, now))) ??
    asAgent(agentsInOrder.find(agentIsLive)) ??
    asTask(tasksInOrder[0]) ??
    asAgent(agentsInOrder[0])
  )
}

/** "c": finished runs leave the list (their files stay); a picked one goes back to following. */
async function clearFinished($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  const list = await update($, tasks, all => all.map(t => (isLive(t, now) ? t : { ...t, hidden: true })))
  const agentList = await update($, agents, all => all.map(a => (agentHasEnded(a) || a.status === 'idle' ? { ...a, hidden: true } : a)))
  await update($, selected, chosen =>
    list.some(t => t.id === chosen && t.hidden === true) || agentList.some(a => a.id === chosen && a.hidden === true) ? '' : chosen,
  )
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`
  return `${sec}s`
}

function glyph(t: BgTask, now: number): string {
  switch (t.status) {
    case 'running':
      return '●'
    case 'completed':
      return '✓'
    case 'failed':
      return '✗'
    case 'killed':
      return '■'
    default:
      return isLive(t, now) ? '●' : '·'
  }
}

function tone(t: BgTask, now: number): ThemeKey {
  switch (t.status) {
    case 'completed':
      return 'success'
    case 'failed':
      return 'error'
    case 'killed':
      return 'warning'
    default:
      return isLive(t, now) ? 'claude' : 'text'
  }
}

function label(t: BgTask): string {
  return t.title !== '' ? t.title : t.command !== '' ? t.command : `task ${t.id}`
}

function age(t: BgTask, now: number): string {
  if (t.status === 'running') return clock(now - t.startedAt)
  if (t.status === 'unknown') return `wrote ${clock(now - t.lastWriteMs)} ago`
  const ended = t.endedAt ?? t.lastWriteMs
  return `took ${clock(ended - t.startedAt)}, ${clock(now - ended)} ago`
}

// ---------- Other sessions ----------

/** The other machines setting: ssh targets, each read as the person's own login there would. */
let machines: string[] = []
let isScanningLocal = false
const remote = new Map<string, { isBusy: boolean; nextAt: number }>()

/** This machine's other sessions: the scratchpads beside this session's, read-only. */
async function scanLocal($: EngineInterface): Promise<void> {
  if (isScanningLocal) return
  isScanningLocal = true
  try {
    const scratch = (await $.session.info().catch(() => undefined))?.scratchpadDir?.replace(/\/+$/, '')
    if (scratch === undefined || scratch === '') return
    // This session, and the ids it had before a /clear, show in For you and Road already.
    const skip = new Set([await $.session.id(), ...(await read($, sessions))])
    const out = await $.process.run(['/bin/sh', '-c', LOCAL_SCAN, 'sh', scratch], { timeoutMs: 15_000 }).catch(() => undefined)
    if (out === undefined) return
    const now = await $.clock.now()
    const local = parseScan(out.stdout, '', skip, now)
    await update($, others, cur => {
      const next = [...local, ...cur.sessions.filter(s => s.host !== '')]
      return JSON.stringify(next) === JSON.stringify(cur.sessions) ? cur : { ...cur, sessions: next, at: now }
    })
  } finally {
    isScanningLocal = false
  }
}

/**
 * One of the person's other machines, over ssh with the script on stdin: BatchMode, so a host that would ask
 * for a password or an unknown host key fails rather than waits. A machine that fails is tried again in five
 * minutes; its sessions leave the list meanwhile.
 */
async function scanRemote($: EngineInterface, target: string): Promise<void> {
  const st = remote.get(target) ?? { isBusy: false, nextAt: 0 }
  remote.set(target, st)
  const now = await $.clock.now()
  if (st.isBusy || now < st.nextAt) return
  st.isBusy = true
  try {
    const out = await $.process
      .run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', target, 'sh -s'], { stdin: REMOTE_SCAN, timeoutMs: 20_000 })
      .catch((error: unknown) => ({ exitCode: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }))
    const at = await $.clock.now()
    const isUp = out.exitCode === 0 && /^NOW \d+/m.test(out.stdout)
    st.nextAt = at + (isUp ? REMOTE_SCAN_MS : REMOTE_RETRY_MS)
    const found = isUp ? parseScan(out.stdout, target, new Set(), at) : []
    const why = isUp ? undefined : (out.stderr.trim().split('\n').pop() ?? `exit ${out.exitCode}`).slice(0, 120)
    await update($, others, cur => ({
      ...cur,
      sessions: [...cur.sessions.filter(s => s.host !== target), ...found],
      hosts: [...cur.hosts.filter(h => h.target !== target), { target, isUp, at, ...(why !== undefined ? { error: why } : {}) }],
      at,
    }))
  } finally {
    st.isBusy = false
  }
}

async function scanOthers($: EngineInterface, tick: number): Promise<void> {
  if (tick % Math.round(LOCAL_SCAN_MS / POLL_MS) === 0) await scanLocal($).catch(() => undefined)
  for (const target of machines) void scanRemote($, target).catch(() => undefined)
}

const NOTIFICATION = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>(?:[\s\S]*?<summary>([^<]*)<\/summary>)?/g

/** Prompts with no sidebar to fill, or whose writer is not the lead: no section. */
const NO_SECTION: readonly string[] = ['bare', 'print', 'sdk-preset', 'teammate']

/**
 * The system prompt section that has Claude keep road.md and for-you.md, so the Road so far and For you sections
 * fill in once the plugin is installed, with nothing to add to CLAUDE.md. Names the folder the poll reads.
 */
function filesSection(scratchpad: string | undefined): string {
  const where = scratchpad ? `your scratchpad directory (${scratchpad})` : 'your scratchpad directory'
  return [
    '# Session sidebar: Road so far and For you',
    '',
    `The person has a sidebar beside this conversation. Two of its sections show files you keep in ${where}:`,
    '',
    '- `road.md`: for any task with more than a few steps, a checklist of the work. A `# Title` line, then one line per step: `- [x] done`, `- [~] in progress`, `- [ ] next`, `- [!] problem`, with short indented `  - notes` under a step. Update it as steps start, finish or hit a problem. Skip it for one-off questions.',
    '- `for-you.md`: what is waiting on the person: something to look at, decide, approve, test or run themselves. One `- item` each: a short headline (about 50 characters) saying what they need to do, then the link or command they need on an indented `  - ` line under it, one per line. Write the item in the same turn you start waiting on them, before the reply that asks; saying it only in the reply is not enough. Mark the headline `- [x]` or delete the item once it is done or no longer needed. Leave the file empty when nothing is waiting.',
    '- A choice in `for-you.md`: when the person must pick one of a few options, put each on its own indented line as `  - ( ) option` under the headline, and write `(*)` for the one you recommend. The sidebar draws them as buttons; a press marks the item done and sends their pick as their next message, `Answer to "<headline>": <option>`.',
    '',
    'Only the main session writes these two files. A subagent or teammate never creates, edits or deletes them; one that wants a checklist uses its own file, such as `road-<agent>.md`.',
  ].join('\n')
}

/** Prompts the person sent: the ones the files section rides on when the system prompt can't carry it. */
const PERSON_ORIGINS: readonly string[] = ['composer', 'bridge']
/** How often this module's prompt.compose hook has run; it stays 0 where a plugin above skips the hook. */
let composeRuns = 0
/** Whether a plugin above skips the prompt.compose hook, once the probe has said; it holds for the process. */
let composeSkipped: boolean | undefined

/**
 * Whether a plugin seated above this one skips its prompt.compose hook, so the files section never reaches the
 * system prompt. The built-in cc-plugin-sec-default does that on a Team or Enterprise plan or wherever managed
 * settings exist: it sends prompt.compose on past every user-tier plugin, but lets prompt.submit through. A hook
 * that has run answers at once; otherwise a composition no one sends tells whether the hook is reached.
 */
async function isComposeSkipped($: EngineInterface, surfaces: readonly RenderSurface[]): Promise<boolean> {
  if (composeRuns > 0) return false
  if (composeSkipped === undefined) {
    // Every fact named, so no hook above fails on a missing one and lets the probe reach this module's hook by
    // accident; `analysis` is a render that is measured, never sent (as /context makes).
    const model = await $.session.model()
    await $.prompt.compose({ model, promptModel: model, surfaces, tools: [], outputStyle: null, traits: ['analysis'] })
    composeSkipped = composeRuns === 0
  }
  return composeSkipped
}

/**
 * The files section as context for the person's prompt, where the system prompt can't carry it and the
 * conversation does not hold it already: it goes out once per session id (a /clear starts a new one), and again
 * after a /compact or once the context has shrunk to under half since the last prompt (an automatic compaction).
 */
async function filesContext($: EngineInterface): Promise<string | undefined> {
  // No surface draws the sidebar (-p, the SDK): nothing to fill.
  const surfaces = await $.session.surfaces()
  if (surfaces.length === 0 || !(await isComposeSkipped($, surfaces))) return undefined
  const id = await $.session.id()
  const tokens = (await $.session.usage()).context.tokens ?? 0
  const sent = await read($, filesNote)
  const isHeld = sent.sessionId === id && tokens >= sent.tokens / 2
  await update($, filesNote, () => ({ sessionId: id, tokens }))
  if (isHeld) return undefined
  const scratchpad = await $.session.info().then(i => i.scratchpadDir?.replace(/\/+$/, ''), () => undefined)
  return filesSection(scratchpad)
}

export const register: Register = (on, options) => {
  const listed = options['otherMachines']
  machines = (Array.isArray(listed) ? listed : typeof listed === 'string' ? listed.split(',') : [])
    .map(t => String(t).trim())
    .filter(t => t !== '' && !/\s/.test(t))
  on('session.start', async ($, e, next) => {
    // A refused command must not stop the polling below.
    await $.command.register({ name: 'sidebar', description: 'Open the session sidebar: road, tasks, agents and messages' }).catch(() => undefined)
    void $.session.id().then(
      id => update($, sessions, ids => (ids.includes(id) ? ids : [...ids, id].slice(-8))),
      () => undefined,
    )
    let tick = 0
    $.clock.every(POLL_MS, () => {
      tick += 1
      void scanOthers($, tick).catch(() => undefined)
    })
    $.clock.every(POLL_MS, async () => {
      const now = await $.clock.now()
      if (polling && now - pollingSince < POLL_STUCK_MS) return
      polling = true
      pollingSince = now
      const mine = now
      try {
        await poll($)
      } catch {
        // The next period tries again.
      } finally {
        // A poll that was given up on must not clear the flag of the one that replaced it.
        if (pollingSince === mine) polling = false
      }
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // A /clear goes on under a new id; both ids' scratchpads stay candidates.
    await update($, sessions, ids => (ids.includes(e.sessionId) ? ids : [...ids, e.sessionId].slice(-8))).catch(() => undefined)
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    composeRuns += 1
    const composed = await next(e)
    if (e.surfaces.length === 0 || e.traits.some(t => NO_SECTION.includes(t))) return composed
    const scratchpad = await $.session.info().then(i => i.scratchpadDir?.replace(/\/+$/, ''), () => undefined)
    return {
      sections: [...composed.sections, { id: 'session-sidebar:files', text: filesSection(scratchpad), scope: 'session' as const }],
    }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'sidebar' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Background output pane opened. Number keys pick a task; the same number again follows the newest.' }
  }).catch(() => ({ text: 'The background output pane could not be opened.' }))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const id = ran.deny === undefined && ran.isError !== true ? ran.result?.backgroundTaskId : undefined
    if (id !== undefined) {
      const now = await $.clock.now()
      const task: BgTask = {
        id,
        title: e.description ?? '',
        command: e.command,
        startedAt: now,
        status: 'running',
        lastWriteMs: now,
        size: 0,
      }
      await update($, tasks, list => [...list.filter(t => t.id !== id), task].slice(-MAX_TASKS))
      // A new run takes the pane unless a task was picked by hand.
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'SendMessage') {
      const input = e as unknown as { to?: unknown; summary?: unknown; message?: unknown }
      const agentId = e.agentId
      const sender =
        agentId === undefined
          ? LEAD
          : await read($, agents).then(list => {
              const a = list.find(x => x.id === agentId)
              return a === undefined ? 'agent' : a.name !== undefined && a.name !== '' ? a.name : agentLabel(a)
            })
      const to = typeof input.to === 'string' ? (input.to === 'team-lead' || input.to === 'main' ? LEAD : input.to) : 'agent'
      void noteMessage($, {
        from: sender,
        to,
        summary: typeof input.summary === 'string' ? oneLine(input.summary, 60) : '',
        text: messageText(input.message),
      }).catch(() => undefined)
    }
    if (e.agentId !== undefined) {
      const input = e as unknown as Readonly<Record<string, unknown>>
      const said = summarize(input, 80)
      void noteAction($, e.agentId, said === '' ? e.tool : `${e.tool} ${said}`).catch(() => undefined)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'TaskStop' }, async ($, e, next) => {
    const ran = await next(e)
    const id = e.task_id ?? e.shell_id
    if (id !== undefined && ran.deny === undefined && ran.isError !== true) {
      const now = await $.clock.now()
      await update($, tasks, list => list.map(t => (t.id === id ? { ...t, status: 'killed' as const, endedAt: now } : t)))
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // The files section's fallback, where a plugin above skips the prompt.compose hook: context on the person's prompt.
    if (PERSON_ORIGINS.includes(e.origin.kind)) {
      // After a /compact the conversation no longer holds the section; a /clear starts a new session id.
      if (e.command?.name === 'compact') await update($, filesNote, () => ({ sessionId: '', tokens: 0 })).catch(() => undefined)
      const files = e.command === undefined ? await filesContext($).catch(() => undefined) : undefined
      return files === undefined ? next(e) : next({ ...e, context: [...(e.context ?? []), files] })
    }
    if (e.origin.kind === 'task-notification') {
      const ended = [...e.text.matchAll(NOTIFICATION)]
      if (ended.length > 0) {
        const now = await $.clock.now()
        // A run the file's exit line already ended keeps that ending (and its notice is not raised twice).
        const finished = new Map<string, BgTask>()
        await update($, tasks, list =>
          list.map(t => {
            const hit = ended.find(m => m[1] === t.id)
            if (hit === undefined || (t.status !== 'running' && t.status !== 'unknown')) return t
            const exit = /exit code (\d+)/.exec(hit[3] ?? '')
            const status: BgTask['status'] =
              hit[2] === 'killed' || hit[2] === 'stopped'
                ? 'killed'
                : hit[2] === 'failed' || (exit !== null && exit[1] !== '0')
                  ? 'failed'
                  : 'completed'
            const done = { ...t, status, endedAt: now }
            if (t.status === 'running') finished.set(t.id, done)
            return done
          }),
        )
        for (const t of finished.values()) void announce($, t)
        // An agent's finish notice goes in the message feed (a shell task's does not).
        const agentList = await read($, agents)
        for (const hit of ended) {
          const a = agentList.find(x => x.id === hit[1])
          if (a === undefined) continue
          const name = a.name !== undefined && a.name !== '' ? a.name : agentLabel(a)
          void noteMessage($, { from: name, to: LEAD, summary: `${hit[2] ?? 'ended'}`, text: hit[3] ?? '' }).catch(() => undefined)
        }
      }
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const list = await read($, tasks)
    const chosen = await read($, selected)
    const view = await read($, tail)
    const now = view.now !== 0 ? view.now : await $.clock.now()
    const rows = Math.max(14, e.viewport?.rows ?? 30)
    const cols = Math.max(20, e.viewport?.columns ?? 80)
    const roadNow = await read($, road)
    const roadView = roadLines(roadNow.items)
    const roadRows = roadView.lines.length + (roadView.folded > 0 ? 1 : 0)
    const width = Math.min(cols - 2, 72)
    const forYouNow = await read($, forYou)
    const opened = await read($, forYouOpen)
    const forYouShown = forYouNow.items.slice(0, FOR_YOU_ROWS).map(item => forYouView(item, width, opened))
    // Always shown: an empty list reads "nothing now" (one row).
    const forYouRows = Math.max(1, forYouShown.reduce((n, v) => n + v.rows, 0) + (forYouNow.items.length > FOR_YOU_ROWS ? 1 : 0))
    // Other sessions: by machine when there are other machines, each session one line until opened.
    const othersNow = await read($, others)
    const othersOpened = await read($, othersView)
    const groups = ['', ...machines].map(host => ({
      host,
      list: othersShown(othersNow.sessions.filter(s => s.host === host), now),
      state: othersNow.hosts.find(h => h.target === host),
    }))
    const isGrouped = machines.length > 0
    const sessionKey = (s: OtherSession) => `${s.host}/${s.id}`
    const otherLines: RenderElement[] = []
    let othersHidden = 0
    const pushOther = (line: RenderElement) => {
      if (otherLines.length < OTHERS_ROWS) otherLines.push(line)
      else othersHidden += 1
    }
    for (const g of groups) {
      const isFolded = othersOpened.folded.includes(g.host)
      if (isGrouped) {
        const waiting = g.list.filter(s => s.items.length > 0).length
        const isDown = g.state !== undefined && !g.state.isUp
        const said =
          g.host === ''
            ? ''
            : g.state === undefined
              ? 'checking…'
              : g.state.isUp
                ? `read ${clock(now - g.state.at)} ago`
                : `unreachable: ${g.state.error ?? ''}`
        pushOther(
          <Button
            key={`others-machine-${g.host === '' ? 'here' : g.host}`}
            plain
            onPress={() => update($, othersView, v => ({ ...v, folded: v.folded.includes(g.host) ? v.folded.filter(h => h !== g.host) : [...v.folded, g.host] }))}
          >
            <Text color={isDown ? 'error' : 'claude'} bold>
              {isFolded ? '▸ ' : '▾ '}
              {g.host === '' ? 'this machine' : g.host}
            </Text>
            <Text color="suggestion" wrap="truncate-end">
              {' '}
              {g.list.length} session{g.list.length === 1 ? '' : 's'}
              {waiting > 0 ? ` · ${waiting} waiting on you` : ''}
              {said !== '' ? ` · ${said}` : ''}
            </Text>
          </Button>,
        )
        if (isFolded) continue
      }
      const indent = isGrouped ? '  ' : ''
      for (const s of g.list) {
        const isOpen = othersOpened.open.includes(sessionKey(s))
        const isWorking = now - s.activeAt < WORKING_MS
        const tone: ThemeKey = s.items.length > 0 ? 'warning' : isWorking ? 'claude' : 'success'
        const first = s.items[0]
        const summary =
          first !== undefined
            ? `${withoutLinks(first.text) || first.text}${s.items.length > 1 ? ` +${s.items.length - 1}` : ''}`
            : isWorking
              ? `working${s.current !== undefined ? ` · ${s.current.text}` : ''}`
              : s.title !== ''
                ? `${s.title} · ${s.done}/${s.total}`
                : s.activeAt > 0
                  ? `idle · ${clock(now - s.activeAt)} ago`
                  : 'idle'
        const roomFor = Math.max(10, width - indent.length - s.project.length - 7)
        pushOther(
          <Button
            key={`others-${s.host === '' ? 'here' : s.host}-${s.id}`}
            plain
            onPress={() => update($, othersView, v => ({ ...v, open: v.open.includes(sessionKey(s)) ? v.open.filter(k => k !== sessionKey(s)) : [...v.open, sessionKey(s)] }))}
          >
            <Text color={tone} bold>
              {indent}
              {isOpen ? '▾ ' : '▸ '}
              {s.items.length > 0 ? '⚑ ' : isWorking ? '◆ ' : '● '}
            </Text>
            <Text bold>{s.project}</Text>
            <Text> {cutMiddle(summary, roomFor)}</Text>
          </Button>,
        )
        if (!isOpen) continue
        const pad = `${indent}    `
        const room = Math.max(10, width - pad.length - 4)
        if (s.title !== '') {
          const filled = s.total > 0 ? Math.round((s.done / s.total) * 6) : 0
          pushOther(
            <Text key={`others-${s.id}-road`} wrap="truncate-end">
              {pad}
              <Text color="success">{'▰'.repeat(filled) + '▱'.repeat(6 - filled)}</Text> {cutMiddle(s.title, room - 14)}{' '}
              <Text color="suggestion">
                {s.done}/{s.total}
              </Text>
            </Text>,
          )
        }
        if (s.current !== undefined) {
          pushOther(
            <Text key={`others-${s.id}-now`} wrap="truncate-end">
              {pad}
              <Text color={s.current.state === 'problem' ? 'error' : 'claude'} bold>
                {s.current.state === 'problem' ? '✗ ' : '▶ '}
              </Text>
              {cutMiddle(s.current.text, room)}
            </Text>,
          )
        }
        s.items.forEach((item, j) => {
          const links = itemLinks(item).slice(0, 2)
          pushOther(
            <Box key={`others-${s.id}-item-${j}`} flexDirection="row">
              <Text color="warning" bold>
                {pad}
                {'⚑ '}
              </Text>
              <Text bold wrap="truncate-end">
                {cutMiddle(withoutLinks(item.text) || item.text, room - links.length * 14)}
              </Text>
              {links.map(url => (
                <Text key={url}>
                  {' '}
                  <Link href={url} label={linkLabel(url)} />
                </Text>
              ))}
            </Box>,
          )
          for (const c of item.choices ?? []) {
            pushOther(
              <Text key={`others-${s.id}-item-${j}-${c.label}`} wrap="truncate-end">
                {pad}
                {'    '}
                {c.isRecommended ? '(*) ' : '( ) '}
                {cutMiddle(c.label, room - 6)}
              </Text>,
            )
          }
        })
        if (s.items.some(item => (item.choices?.length ?? 0) > 0)) {
          pushOther(
            <Text key={`others-${s.id}-there`} color="suggestion">
              {pad}answer its choices in that session
            </Text>,
          )
        }
      }
    }
    if (othersHidden > 0) otherLines.push(<Text key="others-more" color="warning">{`+${othersHidden} more lines: fold a machine or a session`}</Text>)
    const othersWaiting = othersNow.sessions.filter(s => s.items.length > 0 && groups.some(g => g.host === s.host)).length
    const othersWorking = othersNow.sessions.filter(s => now - s.activeAt < WORKING_MS).length
    const othersRows = otherLines.length > 0 ? otherLines.length + 2 : 0
    const agentList = await read($, agents)
    const agentsInOrder = orderedAgents(agentList)
    const shown = ordered(list, now).slice(0, agentsInOrder.length > 0 ? MAX_ROWS - 1 : MAX_ROWS)
    const shownAgents = agentsInOrder.slice(0, Math.min(AGENT_ROWS, 9 - shown.length))
    const currentTask = list.find(t => t.id === view.id && t.hidden !== true)
    const currentAgent = agentList.find(a => a.id === view.id && a.hidden !== true)
    const currentLabel = currentTask !== undefined ? label(currentTask) : currentAgent !== undefined ? `${agentLabel(currentAgent)} (${currentAgent.type})` : undefined
    // Rows left for output: the headings and spacer lines, both lists, the keys (three), the frame.
    const room = Math.max(4, rows - shown.length - shownAgents.length - 13 - (shownAgents.length > 0 ? 2 : 0) - (roadRows > 0 ? roadRows + 2 : 0) - (forYouRows + 2) - othersRows)
    const keys = shown.length + shownAgents.length
    const picks = keys > 1 ? `1–${keys}` : '1'
    const working = agentList.filter(a => a.hidden !== true && agentIsLive(a)).length
    const messageList = await read($, messages)
    const showOutput = chosen !== '' && currentLabel !== undefined
    const feedLines = showOutput ? [] : feed(messageList, room, width)
    const running = ordered(list, now).filter(t => isLive(t, now)).length
    /** A section heading: a heavy colored rule with the section's name and a short detail. */
    const heading = (name: string, detail: string, tone: ThemeKey = 'claude') => {
      const space = Math.max(0, width - name.length - 6)
      const said = detail.length > space ? `${detail.slice(0, Math.max(0, space - 1))}…` : detail
      const fill = Math.max(2, width - name.length - said.length - 6)
      return (
        <Box flexDirection="row">
          <Text color={tone} bold>
            {'━━ '}
            {name}
          </Text>
          <Text color="suggestion">{said === '' ? ' ' : ` ${said} `}</Text>
          <Text color={tone}>{'━'.repeat(fill)}</Text>
        </Box>
      )
    }
    /** A line's words with each link drawn as a link, labeled by its host and path cut to `max`. */
    const inline = (line: string, max: number) =>
      line.split(URL_SPLIT).flatMap((part, k) => {
        if (k % 2 === 0) return part === '' ? [] : [part]
        const url = trimLink(part)
        const rest = part.slice(url.length)
        return [<Link href={url} label={linkLabel(url, max)} />, ...(rest === '' ? [] : [rest])]
      })
    const forYouHead = (v: ForYouView, i: number) => {
      const done = <Button plain key={`you-done-${i}`} label="✓ done" onPress={() => void markForYouDone($, v.item.text)} />
      // The promise returned, so the press waits for the write.
      const toggle = () => update($, forYouOpen, cur => (cur === v.item.text ? '' : v.item.text))
      if (v.isOpen) {
        return (
          <Box key={`you-${i}`} flexDirection="column">
            <Box flexDirection="row">
              {done}
              <Button plain key={`you-open-${i}`} onPress={toggle}>
                <Text color="warning" bold>
                  {' ▾ '}
                </Text>
              </Button>
              <Text bold wrap="wrap">
                {inline(v.item.text, width - FOR_YOU_GUTTER)}
              </Text>
            </Box>
            {v.item.details.map((line, j) => (
              <Box key={`you-${i}-${j}`} flexDirection="row">
                <Text>{' '.repeat(9)}</Text>
                <Text wrap="wrap">{inline(line, width - FOR_YOU_GUTTER)}</Text>
              </Box>
            ))}
          </Box>
        )
      }
      // One line: the button first so it never wraps away, the words cut in the middle, the links last.
      const words = [
        <Text key="mark" color="warning" bold>
          {v.hasMore ? ' ▸ ' : ' • '}
        </Text>,
        <Text key="said" bold>
          {v.said}
        </Text>,
      ]
      return (
        <Box key={`you-${i}`} flexDirection="row">
          {done}
          {v.hasMore ? (
            <Button plain key={`you-open-${i}`} onPress={toggle}>
              {words}
            </Button>
          ) : (
            <Text>{words}</Text>
          )}
          {v.links.map(url => (
            <Text key={url}>
              {' '}
              <Link href={url} label={linkLabel(url)} />
            </Text>
          ))}
        </Box>
      )
    }
    /** The first choice on screen answers to letter keys too (c and f are the pane's own). */
    const firstChoice = forYouShown.findIndex(v => (v.item.choices?.length ?? 0) > 0)
    /**
     * A for-you item: its row (or its open view), then a choice's options as a stack of filled chips, one button
     * each, the same width, Claude's pick in the accent color and named beside it; the pointer over one lights it up.
     */
    const forYouRow = (v: ForYouView, i: number) => {
      const choices = v.item.choices ?? []
      if (choices.length === 0) return forYouHead(v, i)
      const chip = Math.min(Math.max(...choices.map(c => c.label.length)), Math.max(12, width - 34))
      return (
        <Box key={`you-choice-${i}`} flexDirection="column">
          {forYouHead(v, i)}
          {choices.map((c, j) => {
            const key = i === firstChoice ? CHOICE_KEYS[j] : undefined
            const said = c.label.length > chip ? `${c.label.slice(0, chip - 1)}…` : c.label.padEnd(chip)
            return (
              <Box key={`you-${i}-opt-${j}`} flexDirection="row">
                <Text>{key === undefined ? '            ' : '         '}</Text>
                <Button key={`you-${i}-pick-${j}`} plain {...(key !== undefined ? { hotkey: key } : {})} onPress={() => answerForYou($, v.item, c.label)}>
                  <Text
                    color="inverseText"
                    backgroundColor={c.isRecommended ? 'claude' : 'suggestion'}
                    bold
                    hover={{ backgroundColor: 'text' }}
                  >
                    {` ${said} `}
                  </Text>
                  {c.isRecommended && (
                    <Text color="claude" bold>
                      {" ★ Claude's pick"}
                    </Text>
                  )}
                </Button>
              </Box>
            )
          })}
        </Box>
      )
    }
    const forYouDetail = [
      forYouNow.items.length > 0 ? `${forYouNow.items.length} waiting on you` : '',
      forYouShown.some(v => v.hasMore && !v.isOpen) ? '▸ opens one' : '',
    ]
      .filter(part => part !== '')
      .join(' · ')

    return (
      <Box flexDirection="column">
        {heading('FOR YOU', forYouDetail, forYouNow.items.length > 0 ? 'warning' : 'success')}
        {forYouNow.items.length === 0 && <Text color="success">✓ nothing now</Text>}
        {forYouShown.map(forYouRow)}
        {forYouNow.items.length > FOR_YOU_ROWS && <Text color="warning">+{forYouNow.items.length - FOR_YOU_ROWS} more in for-you.md</Text>}
        <Text> </Text>
        {otherLines.length > 0 &&
          heading(
            'OTHER SESSIONS',
            [othersWaiting > 0 ? `${othersWaiting} waiting on you` : '', othersWorking > 0 ? `${othersWorking} working` : ''].filter(p => p !== '').join(' · '),
            othersWaiting > 0 ? 'warning' : 'claude',
          )}
        {otherLines}
        {otherLines.length > 0 && <Text> </Text>}
        {roadRows > 0 && heading('ROAD SO FAR', roadNow.title)}
        {roadView.folded > 0 && <Text color="success">✓ {roadView.folded} earlier steps done</Text>}
        {roadView.lines.map((item, i) => (
          <Box key={`road-${i}`} flexDirection="row">
            <Text color={roadTone(item)} bold={item.state === 'now'}>
              {'  '.repeat(item.state === 'note' ? 1 : Math.min(item.depth, 2))}
              {roadGlyph(item)}{' '}
            </Text>
            <Text bold={item.state === 'now'} wrap="truncate-end">
              {item.text}
            </Text>
          </Box>
        ))}
        {roadRows > 0 && <Text> </Text>}
        {heading('TASKS', running > 0 ? `${running} running` : 'none running')}
        {shown.length === 0 && <Text>No background tasks yet. Long runs started in the background show here.</Text>}
        {shown.map((t, i) => (
          <Button
            key={t.id}
            plain
            hotkey={String(i + 1)}
            onPress={() => void update($, selected, pick => (pick === t.id ? '' : t.id))}
          >
            <Text color={tone(t, now)}>{glyph(t, now)}</Text>{' '}
            <Text bold={t.id === view.id} wrap="truncate-end">
              {label(t)}
            </Text>
            {t.ok !== undefined && t.ok > 0 && <Text color="success"> {t.ok} ok</Text>}
            {t.failed !== undefined && t.failed > 0 && (
              <Text color="error" bold>
                {' '}
                {t.failed} FAIL
              </Text>
            )}{' '}
            <Text color="suggestion">{age(t, now)}</Text>
          </Button>
        ))}
        {shownAgents.length > 0 && <Text> </Text>}
        {shownAgents.length > 0 && heading('AGENTS', working > 0 ? `${working} working` : 'none working')}
        {shownAgents.map((a, i) => (
          <Button
            key={a.id}
            plain
            hotkey={String(shown.length + i + 1)}
            onPress={() => void update($, selected, chosenId => (chosenId === a.id ? '' : a.id))}
          >
            <Text color={agentTone(a)}>{agentGlyph(a)}</Text>{' '}
            <Text bold={a.id === view.id} wrap="truncate-end">
              {agentLabel(a)}
            </Text>
            <Text color="suggestion">
              {' '}
              {a.type} · {agentAge(a, now)}
            </Text>
            {agentIsLive(a) && a.lastAction !== undefined && <Text> · {oneLine(a.lastAction, 50)}</Text>}
          </Button>
        ))}
        <Text> </Text>
        {!showOutput && heading('MESSAGES', messageList.length > 0 ? `${messageList.length} so far, newest last` : 'none yet')}
        {!showOutput && messageList.length === 0 && <Text>Messages between Claude and its agents show here.</Text>}
        {!showOutput &&
          feedLines.map((line, i) =>
            line.kind === 'head' ? (
              <Box key={`msg-${i}`} flexDirection="row">
                <Text color={line.from === LEAD ? 'suggestion' : 'claude'} bold>
                  {line.from}
                </Text>
                <Text> → </Text>
                <Text color={line.to === LEAD ? 'suggestion' : 'claude'} bold>
                  {line.to}
                </Text>
                <Text wrap="truncate-end"> {line.text}</Text>
              </Box>
            ) : (
              <Text key={`msg-${i}`} wrap="truncate-end">
                {'  '}
                {line.text}
              </Text>
            ),
          )}
        {showOutput && heading('OUTPUT', `${currentLabel ?? ''} · its number again or f: messages`)}
        {showOutput && view.lines.length === 0 && <Text>No output yet.</Text>}
        {showOutput &&
          view.lines.slice(-room).map(line => {
            const lineColor = lineTone(line)
            const text = line === '' ? ' ' : line
            return lineColor === undefined ? (
              <Text wrap="truncate-end">{text}</Text>
            ) : (
              <Text color={lineColor} wrap="truncate-end">
                {text}
              </Text>
            )
          })}
        <Text> </Text>
        {heading('KEYS', '')}
        <Box flexDirection="row">
          <Button plain hotkey="f" label="messages" onPress={() => void update($, selected, () => '')} />
          <Text> </Text>
          <Button plain hotkey="c" label="clear finished" onPress={() => void clearFinished($)} />
        </Box>
        <Text wrap="wrap">
          ctrl+x tab focus here · {picks} show a run's output · tab ↑↓ move · enter press · esc back to prompt · ctrl+x x close · /sidebar reopen
        </Text>
      </Box>
    )
  })
}
