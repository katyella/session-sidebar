/** One background task of this session, as the pane knows it. */
export type BgTask = {
  id: string
  /** The Bash call's description, or '' for a task found only by its file. */
  title: string
  command: string
  startedAt: number
  /** When the task's notification or a TaskStop said it ended. */
  endedAt?: number
  /** 'unknown': found by its output file, started before the pane loaded. */
  status: 'running' | 'completed' | 'failed' | 'killed' | 'unknown'
  /** Last write to its output file, and its size, as of the last poll. */
  lastWriteMs: number
  size: number
  /** Cleared from the list with "c"; kept so its file is not listed again. */
  hidden?: boolean
  /** Test results counted over the whole output file (go test packages, gate lines, Swift tests). */
  ok?: number
  failed?: number
}

/** One subagent of this session, as the pane knows it ($.agent.list plus its tool calls). */
export type BgAgent = {
  id: string
  /** The Agent call's few-word description. */
  description: string
  /** The agent type it was spawned as (general-purpose, Explore, ...). */
  type: string
  name?: string
  status: 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed'
  /** When the pane first saw it, and when it saw it end. */
  startedAt: number
  endedAt?: number
  /** Its transcript's size and last write, as of the last poll. */
  size: number
  lastWriteMs: number
  /** The latest tool it called, e.g. "Bash Run the cli tests". */
  lastAction?: string
  lastActionAt?: number
  /** Cleared from the list with "c". */
  hidden?: boolean
}

/** One line of the road file: a step and where it stands, or a note under one. */
export type RoadItem = {
  state: 'done' | 'now' | 'next' | 'problem' | 'note'
  text: string
  depth: number
}

/** The "road so far" the main loop keeps in <session>/scratchpad/road.md. */
export type Road = {
  title: string
  items: RoadItem[]
  /** The file's last write when it was read; 0 when there is none. */
  mtimeMs: number
}

/** One thing waiting on the person: its `- headline` line, and the indented lines under it (a link, a command). */
export type ForYouItem = {
  text: string
  details: string[]
}

/** What the person should look at, decide or do now, from <session>/scratchpad/for-you.md. */
export type ForYou = {
  items: ForYouItem[]
  /** The file's last write when it was read; 0 when there is none. */
  mtimeMs: number
}

/** One message between the main conversation and an agent (SendMessage), or an agent's finish notice. */
export type AgentMessage = {
  at: number
  from: string
  to: string
  /** The sender's few-word label, when it gave one. */
  summary: string
  text: string
}

/** The tail of the task the pane shows. */
export type Tail = {
  id: string
  lines: string[]
  size: number
  /** The poll's clock, so ages and elapsed times redraw while tasks run. */
  now: number
}

/**
 * Where the fallback last sent the files section as prompt context (used where a plugin above skips this one's
 * prompt.compose hook): the session it went out in, and the context's input tokens at the latest prompt since.
 * An empty sessionId: not sent.
 */
export type FilesNote = {
  sessionId: string
  tokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-sidebar': {
      tasks: Shaped<BgTask[]>
      agents: Shaped<BgAgent[]>
      road: Shaped<Road>
      forYou: Shaped<ForYou>
      /** The headline of the for-you item opened in full; '' when every item shows one line. */
      forYouOpen: Shaped<string>
      /** Session ids this process has used, first one first (a /clear starts a new id). */
      sessions: Shaped<string[]>
      messages: Shaped<AgentMessage[]>
      /** The task chosen with its hotkey; '' follows the newest running task. */
      selected: Shaped<string>
      tail: Shaped<Tail>
      filesNote: Shaped<FilesNote>
    }
  }
}
