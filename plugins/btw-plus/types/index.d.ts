export type Item = {
  /** Unique id of the side question. */
  id: string
  /** The main session the question was asked in. */
  sid: string
  /** The question as typed. */
  q: string
  /** Text the person had put in the quote slot (by pressing the quote button). */
  quote?: string
  /** The answer, or the error text when status is "error". */
  a: string
  status: 'pending' | 'done' | 'error'
  /** Pinned items are remembered in every session. */
  isPinned?: boolean
  /** Whether the pair was added to the main conversation as context. */
  isInjected?: boolean
  /** Milliseconds since the epoch when the question was asked. */
  ts: number
}

export type Memory = {
  /** Whether earlier side Q&A is given to the next question. */
  isOn: boolean
  /** How many of this session's latest answers are given (pinned ones come on top). */
  keep: number
}

declare module 'claude-code' {
  interface PluginState {
    'btw-plus': {
      items: Shaped<Item[]>
      memory: Shaped<Memory>
      draft: Shaped<string>
      quote: Shaped<string>
      page: Shaped<number>
      where: Shaped<string>
      band: Shaped<boolean>
      settings: Shaped<boolean>
      pick: Shaped<{ model: string; effort: string }>
    }
  }
}
