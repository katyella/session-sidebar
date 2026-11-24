import type { ForYouItem } from '../types'

// The for-you file's items and how a row draws them: pure, so the tests read them directly.

/**
 * The for-you file: one "- headline" (or "- [ ] headline") per thing waiting on the person, with the indented lines
 * under it (a link, a command) as its details; "- [x] headline" is done and hidden with its details. Other lines at
 * the left edge (a title) are not items.
 */
export function parseForYou(text: string): ForYouItem[] {
  const items: ForYouItem[] = []
  // What indented lines below belong to: an open item, a done one (hidden with it), or nothing yet.
  let under: ForYouItem | 'done' | undefined
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    const m = /^(\s*)([-*]\s+)?(?:\[([ xX])\]\s+)?(.*\S)\s*$/.exec(line)
    if (m === null) continue
    const isIndented = (m[1] ?? '') !== ''
    const isListed = m[2] !== undefined
    const isDone = m[3] === 'x' || m[3] === 'X'
    const said = m[4] ?? ''
    if (isIndented && under !== undefined) {
      if (under !== 'done' && !isDone) under.details.push(said)
      continue
    }
    // An item at the left edge; an indented one with nothing above it is an item too.
    if (!isListed) {
      under = undefined
      continue
    }
    if (isDone) {
      under = 'done'
      continue
    }
    under = { text: said, details: [] }
    items.push(under)
  }
  return items
}

export const URL_PATTERN = /https?:\/\/[^\s<>()`'"[\]]+/g
/** The same, to split a line into words (even parts) and links (odd parts). */
export const URL_SPLIT = /(https?:\/\/[^\s<>()`'"[\]]+)/

/** The links an item names, in order and once each: the headline's, then its details'. */
export function itemLinks(item: ForYouItem): string[] {
  const found = [item.text, ...item.details].flatMap(line => [...line.matchAll(URL_PATTERN)].map(m => trimLink(m[0])))
  return [...new Set(found)]
}

/** A link without the sentence punctuation that followed it. */
export function trimLink(url: string): string {
  return url.replace(/[.,;:!?]+$/, '')
}

/** A link's short label: its host; with room, the path too, cut in the middle. */
export function linkLabel(url: string, max = 0): string {
  const bare = url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '')
  const host = bare.split('/')[0] ?? bare
  return `↗ ${max > host.length ? cutMiddle(bare, max) : host}`
}

/** The words of a line with its links taken out (they are drawn as links of their own), and what they left dangling. */
export function withoutLinks(text: string): string {
  return text
    .replace(URL_PATTERN, ' ')
    .replace(/\(\s*\)|<\s*>/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[\s:,;—–→-]+$/, '')
    .trim()
}

/** Columns a for-you row spends before its words ("✓ done" and the marker), with a margin; and links kept on a row. */
export const FOR_YOU_GUTTER = 12
export const FOR_YOU_LINKS = 2

/** How one for-you item is drawn at this width: one line, its words cut in the middle and its links last, or in full. */
export type ForYouView = {
  item: ForYouItem
  /** The headline's words, cut to the room the row leaves them. */
  said: string
  /** The links drawn on the row. */
  links: string[]
  /** Whether opening it shows more: words cut, details, or links the row had no room for. */
  hasMore: boolean
  isOpen: boolean
  /** Rows it takes, about (wrapped lines are estimated). */
  rows: number
}

export function forYouView(item: ForYouItem, width: number, opened: string): ForYouView {
  const links = itemLinks(item)
  const rowLinks = links.slice(0, FOR_YOU_LINKS)
  const words = withoutLinks(item.text)
  const full = words === '' && links.length === 0 ? item.text.replace(/\s+/g, ' ').trim() : words
  const room = Math.max(12, width - FOR_YOU_GUTTER - rowLinks.reduce((n, url) => n + linkLabel(url).length + 1, 0))
  const said = cutMiddle(full, room)
  const hasMore = said !== full || item.details.length > 0 || links.length > rowLinks.length
  const isOpen = hasMore && opened === item.text
  const textRoom = Math.max(12, width - FOR_YOU_GUTTER)
  const rows = isOpen ? [item.text, ...item.details].reduce((n, line) => n + Math.ceil(Math.max(1, line.length) / textRoom), 0) : 1
  return { item, said, links: rowLinks, hasMore, isOpen, rows }
}

/** A line cut to `max` characters in the middle, keeping its start and its end (often the command or the ask). */
export function cutMiddle(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  if (line.length <= max) return line
  const head = Math.ceil((max - 1) * 0.6)
  const tail = max - 1 - head
  return `${line.slice(0, head).trimEnd()}…${tail > 0 ? line.slice(line.length - tail).trimStart() : ''}`
}
