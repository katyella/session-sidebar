import type { OtherSession } from '../types'
import { parseForYou } from './for-you'

// The other sessions' files, read on this machine or, over ssh, on the person's others: pure, so tests read them.

/**
 * The scan both machines run, given `root` (the claude-<uid> tmp folder), `home` (that user's home) and `mt`
 * (a file's mtime). With a session registry (`<home>/.claude/sessions/<pid>.json`, one per running Claude Code),
 * only the interactive sessions whose process is alive are listed, so a closed session leaves at the next scan.
 * Without one (an older Claude Code), sessions that wrote road.md or for-you.md in the last day, or their
 * transcript in the last half hour. Each prints its transcript's last write, then its road and for-you lines.
 */
const SCAN_BODY = `
emit() {
  dir=$1; sid=$(basename "$dir"); project=$(basename "$(dirname "$dir")")
  case "$sid" in *-*-*-*-*) ;; *) return ;; esac
  case "$project" in -private-var-folders-*|-var-folders-*|-tmp-*|-private-tmp-*) return ;; esac
  t="$home/.claude/projects/$project/$sid.jsonl"
  m=0; [ -f "$t" ] && m=$(mt "$t")
  printf 'S\\t%s\\t%s\\t%s\\n' "$sid" "$project" "$m"
  [ -f "$dir/scratchpad/road.md" ] && awk -v s="$sid" '{print "R\\t" s "\\t" $0}' "$dir/scratchpad/road.md"
  [ -f "$dir/scratchpad/for-you.md" ] && awk -v s="$sid" '{print "Y\\t" s "\\t" $0}' "$dir/scratchpad/for-you.md"
}
field() { sed -n "s/.*\\"$1\\" *: *\\"\\\\([^\\"]*\\\\)\\".*/\\\\1/p" "$2" | head -1; }
if [ -d "$home/.claude/sessions" ]; then
  for f in "$home"/.claude/sessions/*.json; do
    [ -f "$f" ] || continue
    kill -0 "$(basename "$f" .json)" 2>/dev/null || continue
    kind=$(field kind "$f"); [ -z "$kind" ] || [ "$kind" = interactive ] || continue
    sid=$(field sessionId "$f"); cwd=$(field cwd "$f")
    [ -n "$sid" ] && [ -n "$cwd" ] || continue
    echo "$root/$(printf %s "$cwd" | sed 's/[^A-Za-z0-9]/-/g')/$sid"
  done
else
  {
    find "$root" -maxdepth 4 -path '*/scratchpad/*' \\( -name road.md -o -name for-you.md \\) -mmin -1440 2>/dev/null | sed 's#/scratchpad/.*##'
    find "$home/.claude/projects" -mindepth 2 -maxdepth 2 -name '*.jsonl' -mmin -30 2>/dev/null | while read -r t; do echo "$root/$(basename "$(dirname "$t")")/$(basename "$t" .jsonl)"; done
  }
fi | sort -u | head -80 | while read -r dir; do emit "$dir"; done
`

/** This machine's other sessions (see SCAN_BODY). `$1` is this session's scratchpad. Read-only. */
export const LOCAL_SCAN = `
root=$(dirname "$(dirname "$(dirname "$1")")")
home=$HOME
mt() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }
echo "NOW $(date +%s)"
${SCAN_BODY}
`

/**
 * The same on another machine, sent over ssh as `sh -s`: Linux or macOS, every user's claude-<uid> folder with
 * that user's home. The machine's clock comes first, so ages read against it.
 */
export const REMOTE_SCAN = `
os=$(uname -s)
echo "NOW $(date +%s)"
mt() { if [ "$os" = Darwin ]; then stat -f %m "$1"; else stat -c %Y "$1"; fi; }
homeof() {
  if [ "$os" = Darwin ]; then n=$(dscl . -search /Users UniqueID "$1" 2>/dev/null | awk 'NR==1{print $1}'); [ -n "$n" ] && echo "/Users/$n"
  else getent passwd "$1" 2>/dev/null | cut -d: -f6; fi
}
if [ "$os" = Darwin ]; then bases=$(ls -d /private/tmp/claude-* 2>/dev/null); else bases=$(ls -d /tmp/claude-* 2>/dev/null); fi
for root in $bases; do
  [ -d "$root" ] || continue
  home=$(homeof "\${root##*claude-}"); [ -z "$home" ] && home=$HOME
  ${SCAN_BODY}
done | head -600
`

/** A project folder as a name: "-Users-me-dev-podcast-search" reads "podcast-search", "-home-kaskade-kaskade" "kaskade". */
export function projectName(dir: string): string {
  return (
    dir
      .replace(/^-(Users|home)-[^-]+-/, '')
      .replace(/^-root-?/, '')
      .replace(/^dev-/, '')
      .replace(/^-claude-mods-/, '') || dir
  )
}

/**
 * A scan's output as sessions, the ones `skip` names left out (this session, and earlier ids of this process).
 * `now` is this machine's clock: a remote machine's times are moved onto it by the NOW line it printed.
 */
export function parseScan(out: string, host: string, skip: ReadonlySet<string>, now: number): OtherSession[] {
  const byId = new Map<string, OtherSession>()
  const road = new Map<string, string[]>()
  const forYou = new Map<string, string[]>()
  const clock = /^NOW (\d+)/m.exec(out)
  const skewMs = clock === null ? 0 : now - Number(clock[1]) * 1000
  for (const line of out.split('\n')) {
    const [kind, sid, ...rest] = line.split('\t')
    if (sid === undefined || (host === '' && skip.has(sid))) continue
    if (kind === 'S') {
      const m = Number(rest[1]) || 0
      byId.set(sid, { id: sid, host, project: projectName(rest[0] ?? ''), activeAt: m > 0 ? m * 1000 + skewMs : 0, title: '', done: 0, total: 0, items: [] })
    } else if (kind === 'R') road.set(sid, [...(road.get(sid) ?? []), rest.join('\t')])
    else if (kind === 'Y') forYou.set(sid, [...(forYou.get(sid) ?? []), rest.join('\t')])
  }
  for (const s of byId.values()) {
    for (const l of road.get(s.id) ?? []) {
      const head = /^#\s+(.*\S)/.exec(l)
      if (head !== null && s.title === '') s.title = head[1] ?? ''
      const step = /^\s*[-*]\s+\[([ xX~>!])\]\s+(.*\S)/.exec(l)
      if (step === null) continue
      s.total += 1
      const mark = step[1] ?? ' '
      if (/[xX]/.test(mark)) s.done += 1
      else if (s.current === undefined && (/[~>]/.test(mark) || mark === '!')) s.current = { state: mark === '!' ? 'problem' : 'now', text: step[2] ?? '' }
    }
    s.items = parseForYou((forYou.get(s.id) ?? []).join('\n'))
  }
  return [...byId.values()]
}

/** Working: its transcript was written this recently. */
export const WORKING_MS = 45_000
/** Idle sessions with nothing waiting are listed while they were active this recently. */
export const RECENT_MS = 30 * 60_000

/** The sessions worth a line: waiting on the person first, then working, then recently active; the rest left out. */
export function othersShown(list: readonly OtherSession[], now: number): OtherSession[] {
  const rank = (s: OtherSession) => (s.items.length > 0 ? 0 : now - s.activeAt < WORKING_MS ? 1 : 2)
  return list
    .filter(s => s.items.length > 0 || now - s.activeAt < RECENT_MS)
    .sort((a, b) => rank(a) - rank(b) || b.activeAt - a.activeAt)
}
