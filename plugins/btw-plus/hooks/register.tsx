import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  PaneOpenArgs,
  PluginOptions,
  Register,
} from 'claude-code'

import type { Item, Memory } from '../types'

const PANE = 'btw'
// Every fork's prompt starts with this, so a fork that loads this same mod
// never treats its own prompt as a side question.
const SENTINEL = '[btw-fork]'
const ITEMS_KEY = 'items-v1'
const MEMORY_KEY = 'memory-v1'
const MAX_ITEMS = 100
const MEMORY_BUDGET = 6000
const ANSWER_IN_MEMORY = 1200
const ANSWER_IN_MAIN = 8000
const KEEP_STEPS = [0, 3, 5, 10, 20]
// Aliases are resolved by Claude Code itself, so they follow its newest models
// with no list kept here.
const MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku']
const modelOptions = (extra: string) => {
  const rows = [{ value: '', label: '既定' }]
  for (const alias of MODEL_ALIASES) {
    rows.push({ value: alias, label: `${alias}(最新)` })
  }
  if (extra && !rows.some(row => row.value === extra)) {
    rows.push({ value: extra, label: extra })
  }

  return rows
}
const EFFORT_OPTIONS = ['', 'low', 'medium', 'high', 'xhigh', 'max'].map(value => ({
  value,
  label: value || '既定',
}))
const DEFAULT_TOOLS = 'Read,Grep,Glob,WebSearch,WebFetch'
const DEFAULT_PREFIXES = 'q:,btw:,？？'
// A pane shorter than this is drawn in its natural flow, not the fixed layout.
const MIN_FIXED_ROWS = 14

// Change a tag when the fields of its value change: an older value is then
// read as the initial one instead of being misread.
const items = atom({ plugin: 'btw-plus', key: 'items' } as const, [], {
  shape: 'items-1',
})
const memory = atom(
  { plugin: 'btw-plus', key: 'memory' } as const,
  { isOn: true, keep: 5 },
  { shape: 'memory-1' },
)
const draft = atom({ plugin: 'btw-plus', key: 'draft' } as const, '', {
  shape: 'draft-1',
})
// The text the person put in the quote slot by pressing the quote button.
const quote = atom({ plugin: 'btw-plus', key: 'quote' } as const, '', {
  shape: 'quote-1',
})
// How many of the newest items the fixed layout's window is moved back from.
// Model and effort chosen in the pane for side questions only; '' means the
// plugin setting (and then the session's default).
const pick = atom(
  { plugin: 'btw-plus', key: 'pick' } as const,
  { model: '', effort: '' },
  { shape: 'pick-1' },
)
// Where the history is drawn: '' follows the setting, then 'pane' or 'band'
// (the strip right above the prompt, as wide as the conversation).
const whereAtom = atom({ plugin: 'btw-plus', key: 'where' } as const, '', {
  shape: 'where-1',
})
const bandAtom = atom({ plugin: 'btw-plus', key: 'band' } as const, false, {
  shape: 'band-1',
})
const pageAtom = atom({ plugin: 'btw-plus', key: 'page' } as const, 0, {
  shape: 'page-1',
})

const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}...` : text

const list = (value: unknown, fallback: string): string[] =>
  String(value ?? fallback)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)

// Terminal cells a text takes: wide (CJK, full-width) characters take two.
const cells = (text: string): number =>
  Array.from(text).reduce(
    (sum, char) => sum + ((char.codePointAt(0) ?? 0) > 0x2e7f ? 2 : 1),
    0,
  )

function paneArgs(options: PluginOptions): PaneOpenArgs {
  const columns = Math.floor(Number(options.paneColumns) || 0)
  const rows = Math.floor(Number(options.paneRows) || 0)

  return {
    id: PANE,
    title: 'btw',
    // A request: a size the person dragged the pane to wins.
    ...(columns >= 24 ? { columns } : {}),
    ...(rows >= 1 ? { rows } : {}),
  }
}

// ---- the history: written to the session's state and to the store ----------

function capItems(all: Item[]): Item[] {
  let over = all.length - MAX_ITEMS
  if (over <= 0) return all

  return all.filter(item => {
    if (over > 0 && !item.isPinned && item.status !== 'pending') {
      over -= 1
      return false
    }

    return true
  })
}

async function mutate($: EngineInterface, fn: (all: Item[]) => Item[]) {
  // `read` after `update` would see the moment the dispatch began, so what is
  // stored is what the update itself computed.
  let next: Item[] = []
  await update($, items, all => (next = capItems(fn(all))))
  await $.store.set(ITEMS_KEY, next)
}

async function setMemory($: EngineInterface, fn: (m: Memory) => Memory) {
  let next: Memory = { isOn: true, keep: 5 }
  await update($, memory, m => (next = fn(m)))
  await $.store.set(MEMORY_KEY, next)

  return next
}

// What the next fork is told of the earlier side questions: the pinned ones,
// then this session's latest, newest first until the budget is spent.
function buildMemory(all: Item[], sid: string, m: Memory): string {
  if (!m.isOn) return ''
  const done = all.filter(item => item.status === 'done')
  const pinned = done.filter(item => item.isPinned)
  const recent =
    m.keep > 0
      ? done.filter(item => !item.isPinned && item.sid === sid).slice(-m.keep)
      : []
  const picked = [...pinned, ...recent]
  const lines: string[] = []
  let used = 0

  for (let i = picked.length - 1; i >= 0; i -= 1) {
    const item = picked[i]
    if (!item) continue
    const note = item.quote
      ? ` (selected text: ${clip(item.quote.replace(/\s+/g, ' '), 200)})`
      : ''
    const block = `Q: ${item.q}${note}\nA: ${clip(item.a, ANSWER_IN_MEMORY)}`
    if (used + block.length > MEMORY_BUDGET && lines.length > 0) break
    used += block.length
    lines.unshift(block)
  }

  return lines.join('\n\n')
}

function buildPrompt(q: string, selected: string, remembered: string): string {
  const parts = [
    SENTINEL,
    'This is a one-shot side question, asked in a separate side window while the main task goes on. Rules:',
    '- Answer directly and concisely, in the language of the question (Japanese unless the question is in another language).',
    '- You may use read-only tools to look things up. Do NOT modify files or run state-changing commands.',
    '- The user cannot reply, so do not ask clarifying questions; state your assumption instead.',
  ]

  if (remembered) {
    parts.push(
      '',
      '## Earlier side Q&A (this side window only, not part of the main conversation)',
      remembered,
    )
  }

  if (selected) {
    parts.push(
      '',
      '## Text the user selected on screen',
      selected
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n'),
    )
  }

  parts.push('', '## Question', q)

  return parts.join('\n')
}

// ---- putting side answers into the main conversation ----------------------

function threadText(pairs: Item[]): string {
  const body = pairs
    .map(item => {
      const note = item.quote
        ? `\n(selected text: ${clip(item.quote.replace(/\s+/g, ' '), 300)})`
        : ''

      return `Q: ${item.q}${note}\nA: ${clip(item.a, ANSWER_IN_MAIN)}`
    })
    .join('\n\n')

  return `[Side Q&A from the btw side window, added by the user as context for the main conversation]\n\n${body}`
}

async function inject($: EngineInterface, targets: Item[]) {
  const ready = targets.filter(item => item.status === 'done' && !item.isInjected)
  if (ready.length === 0) {
    $.ui.toast('メインに入れられる回答がありません(入れ済み、または回答待ちです)')

    return
  }

  let refused = ''
  try {
    const stored = await $.session.append({
      message: {
        type: 'user',
        content: [{ type: 'text', text: threadText(ready) }],
      },
    })
    if (stored.deny) refused = stored.deny
  } catch (error) {
    refused = error instanceof Error ? error.message : String(error)
  }

  if (refused) {
    $.ui.toast(`メインに入れられませんでした: ${clip(refused, 80)}`)

    return
  }

  const ids = new Set(ready.map(item => item.id))
  await mutate($, all =>
    all.map(item => (ids.has(item.id) ? { ...item, isInjected: true } : item)),
  )
  $.ui.toast(`メインの会話に入れました(${ready.length}件)`)
}

// ---- asking -----------------------------------------------------------------

type Fork = {
  id: string
  q: string
  quote: string
  prompt: string
  sid: string
  ts: number
  turns: number
  cwd: string
}

async function runFork($: EngineInterface, options: PluginOptions, fork: Fork) {
  const argv = ['claude', '-p']
  // A session with no turns has nothing to fork: ask it fresh.
  if (fork.turns > 0) argv.push('--resume', fork.sid, '--fork-session')
  argv.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit')
  const tools = list(options.allowedTools, DEFAULT_TOOLS)
  if (tools.length > 0) argv.push('--allowedTools', ...tools)
  const chosen = await read($, pick)
  const model = (chosen.model || String(options.model ?? '')).trim()
  if (model) argv.push('--model', model)
  const effort = (chosen.effort || String(options.effort ?? '')).trim()
  if (effort) argv.push('--effort', effort)
  const seconds = Math.min(600, Math.max(10, Number(options.timeoutSec) || 270))

  let answer = ''
  let status: Item['status'] = 'done'

  try {
    const ran = await $.process.run(argv, {
      cwd: fork.cwd,
      stdin: fork.prompt,
      timeoutMs: seconds * 1000,
    })
    answer = ran.stdout.trim()

    if (ran.exitCode !== 0 || !answer) {
      status = 'error'
      answer = `フォークが失敗しました (exit ${ran.exitCode})\n${clip(ran.stderr.trim().slice(-600), 600)}`
    }
  } catch (error) {
    status = 'error'
    answer = `フォークを実行できませんでした: ${error instanceof Error ? error.message : String(error)}`
  }

  await mutate($, all =>
    all.map(item => (item.id === fork.id ? { ...item, a: answer, status } : item)),
  )

  const panes = await $.ui.panes()
  const isBandOpen =
    (await whereNow($, options)) === 'band' && (await read($, bandAtom))
  if (isBandOpen || panes.some(pane => pane.id === PANE && pane.isPlaced)) {
    $.ui.toast(status === 'done' ? 'btw: 回答が届きました' : 'btw: 失敗しました')
  } else {
    // No surface draws the pane: the answer goes to the transcript instead.
    $.ui.log(`💬 ${fork.q}\n\n${answer}`)
  }

  if (status === 'done' && options.autoInject === true) {
    await inject($, [
      {
        id: fork.id,
        sid: fork.sid,
        q: fork.q,
        ...(fork.quote ? { quote: fork.quote } : {}),
        a: answer,
        status,
        ts: fork.ts,
      },
    ])
  }
}

// The question goes with whatever is in the quote slot, and only that: a
// selection the person never put there is not taken.
const whereNow = async ($: EngineInterface, options: PluginOptions) =>
  (await read($, whereAtom)) || (options.location === 'band' ? 'band' : 'pane')

// Draws the history where the person wants it: in the band, or in the pane.
async function show($: EngineInterface, options: PluginOptions, focus = false) {
  if ((await whereNow($, options)) === 'band') {
    await update($, bandAtom, () => true)
  } else {
    await $.ui.open({ ...paneArgs(options), ...(focus ? { focus: true as const } : {}) })
  }
}

async function ask($: EngineInterface, options: PluginOptions, q: string) {
  const sid = await $.session.id()
  const now = await $.clock.now()
  const selected = clip((await read($, quote)).trim(), 8000)
  const m = await read($, memory)
  const prior = await read($, items)
  const id = `${now}-${Math.random().toString(36).slice(2, 7)}`
  const item: Item = {
    id,
    sid,
    q,
    ...(selected ? { quote: selected } : {}),
    a: '',
    status: 'pending',
    ts: now,
  }
  const fork: Fork = {
    id,
    q,
    quote: selected,
    prompt: buildPrompt(q, selected, buildMemory(prior, sid, m)),
    sid,
    ts: now,
    turns: await $.session.turns(),
    cwd: await $.session.cwd(),
  }

  await mutate($, all => [...all, item])
  await update($, quote, () => '')
  await show($, options)
  // The fork outlives this dispatch, so it runs from a timer of its own.
  $.clock.after(0, () => {
    void runFork($, options, fork)
  })
}

async function currentSelection($: EngineInterface): Promise<string> {
  try {
    return (await $.ui.selection())?.text ?? ''
  } catch {
    return ''
  }
}

// ---- the pane's window over the history ---------------------------------------

// A guess at the rows an item takes drawn `columns` wide, a little over so
// that a fitted window is not cut.
// Markdown spends more rows than its text (gaps, bullets, code), so an answer
// is given fewer lines than the room it is cut to.
const MARKDOWN_SLACK = 1.35

// The part of `text` that fits `cap` rows of `width` cells, and whether it was cut.
function clipAnswer(text: string, width: number, cap: number) {
  const budget = Math.max(2, Math.floor(cap / MARKDOWN_SLACK))
  const out: string[] = []
  let used = 0

  for (const line of text.split('\n')) {
    const need = Math.max(1, Math.ceil(cells(line) / width))
    if (used + need > budget) {
      if (out.length === 0) {
        // One line longer than the whole allowance: cut it by cells.
        let kept = ''
        let taken = 0
        for (const char of Array.from(line)) {
          const w = cells(char)
          if (taken + w > width * budget) break
          kept += char
          taken += w
        }
        out.push(kept)
      }

      return { text: out.join('\n'), isCut: true }
    }
    out.push(line)
    used += need
  }

  return { text, isCut: false }
}

// Rows an item takes at most, its answer cut to `cap` rows when `cap` is given.
function itemRows(item: Item, columns: number, cap?: number): number {
  const width = Math.max(12, columns - 2)
  const lines = (text: string) =>
    text
      .split('\n')
      .reduce((sum, line) => sum + Math.max(1, Math.ceil(cells(line) / width)), 0)
  // The "A:" label, the buttons and a gap, then the question, quote and answer.
  let rows = lines(`Q: ${item.q}`) + 3
  if (item.quote) rows += 1
  if (item.status === 'pending') {
    rows += 1
  } else if (cap === undefined) {
    rows += Math.ceil(lines(item.a || ' ') * MARKDOWN_SLACK)
  } else {
    const shown = clipAnswer(item.a || ' ', width, cap)
    rows += Math.ceil(lines(shown.text || ' ') * MARKDOWN_SLACK) + (shown.isCut ? 1 : 0)
  }

  return Math.ceil(rows * 1.1)
}

// The newest items that fit `room` rows, ending `skipped` items before the
// newest; always at least one.
function windowOf(
  all: Item[],
  skipped: number,
  room: number,
  columns: number,
  cap: number,
) {
  const end = Math.max(0, all.length - skipped)
  let start = end
  let used = 0

  while (start > 0) {
    const item = all[start - 1]
    if (!item) break
    const need = itemRows(item, columns, cap)
    if (used + need > room && start < end) break
    used += need
    start -= 1
  }

  return { start, end, shown: all.slice(start, end) }
}

// ---- the module -------------------------------------------------------------

// ---- the history, drawn in the pane or in the band --------------------------

async function draw(
  $: EngineInterface,
  options: PluginOptions,
  table: ReturnType<EngineInterface['ui']['resolve']>,
  site: { rows: number; columns: number; id: string; isBand: boolean },
) {
  const sid = await $.session.id()
  const all = await read($, items)
  const m = await read($, memory)
  const staged = await read($, quote)
  const chosen = await read($, pick)
  const modelRows = modelOptions(
    chosen.model || String(options.model ?? '').trim(),
  )
  const modelNow = chosen.model || String(options.model ?? '').trim()
  const effortNow = chosen.effort || String(options.effort ?? '').trim()

  const typed = await read($, draft)
  const skippedBy = await read($, pageAtom)
  const mine = all.filter(item => item.sid === sid || item.isPinned)
  const running = mine.filter(item => item.status === 'pending').length

  // The fixed layout: the controls on top, the newest items in the middle
  // (older ones by the arrows), the composer at the bottom, all inside the
  // rows the pane has, so nothing needs scrolling to be pressed.
  const { rows, columns } = site
  const where = await whereNow($, options)
  const isFixed = options.fixedLayout !== false && rows >= MIN_FIXED_ROWS
  // Rows the header takes once its buttons wrap: each label's cells plus the
  // button's padding and the gap, over the width of the pane.
  const wrapped = (labels: string[]) =>
    Math.max(
      1,
      Math.ceil(
        labels.reduce((sum, text) => sum + cells(text) + 4, 0) /
          Math.max(10, columns),
      ),
    )
  const headerRows =
    wrapped(['btw', '待機中', '1-1 / 1', '^', 'v']) +
    wrapped(['記憶 OFF', '直近 20 件', '履歴を消す', 'メインに反映']) +
    wrapped(['モデル', ...modelRows.map(row => `[${row.label}]`)]) +
    wrapped(['エフォート', ...EFFORT_OPTIONS.map(row => `[${row.label}]`)])
  const composerRows = (staged ? 6 : 0) + 4
  const room = Math.max(3, rows - headerRows - composerRows - 1)
  // No answer is given more than the room left by the rest of an item.
  const cap = Math.max(3, room - 9)
  const skipped = Math.min(skippedBy, Math.max(0, mine.length - 1))
  const view = isFixed
    ? windowOf(mine, skipped, room, columns, cap)
    : { start: 0, end: mine.length, shown: mine }

  const { Box, Text, Button, Markdown } = table
  const Input = 'Input' in table ? table.Input : undefined

  // A press leaves the focus ring on the button, so the next click on the
  // field would not take the keyboard: hand the ring to the field again.
  const back = () => {
    if (Input) void $.ui.focus({ requestId: site.id, key: 'ask' }).catch(() => undefined)
  }
  const then = (work: unknown) => {
    void Promise.resolve(work).then(back, back)
  }

  // Moves the history between the pane (beside) and the band (below).
  const move = async () => {
    if (where === 'band') {
      await update($, whereAtom, () => 'pane')
      await update($, bandAtom, () => false)
      await $.ui.open(paneArgs(options))
    } else {
      await update($, whereAtom, () => 'band')
      await update($, bandAtom, () => true)
      await $.ui.close({ id: PANE })
    }
  }

  const submit = async (value: string) => {
    const q = value.trim()
    if (!q) return
    await update($, draft, () => '')
    await update($, pageAtom, () => 0)
    await ask($, options, q)
  }

  // The quote is taken only here, by this press: a selection alone is not.
  const grab = async () => {
    const selected = (await currentSelection($)).trim()
    if (!selected) {
      $.ui.toast('選択範囲がありません。画面の文章をドラッグ選択してから押してください')

      return
    }
    await update($, quote, () => clip(selected, 8000))
  }

  const cycleKeep = () =>
    setMemory($, one => {
      const at = KEEP_STEPS.indexOf(one.keep)

      return { ...one, keep: KEEP_STEPS[(at + 1) % KEEP_STEPS.length] ?? 5 }
    })

  const step = Math.max(1, view.shown.length)
  const older = () =>
    update($, pageAtom, n => Math.min(Math.max(0, mine.length - 1), n + step))
  const newer = () => update($, pageAtom, n => Math.max(0, n - step))

  const history = view.shown.map(item => {
    const shown = isFixed
      ? clipAnswer(item.a, Math.max(12, columns - 2), cap)
      : { text: item.a, isCut: false }

    return (
    <Box key={`item:${item.id}`} flexDirection="column" marginBottom={1}>
      <Text bold color="suggestion">
        {item.isPinned ? '[ピン] ' : ''}Q: {item.q}
      </Text>
      {item.quote ? (
        <Text dimColor>引用: {clip(item.quote.replace(/\s+/g, ' '), 120)}</Text>
      ) : null}
      <Text bold color="claude">
        A:
      </Text>
      {item.status === 'pending' ? (
        <Text dimColor>考え中...</Text>
      ) : item.status === 'error' ? (
        <Text color="error">{shown.text}</Text>
      ) : (
        <Markdown text={shown.text} />
      )}
      {shown.isCut ? (
        <Text dimColor>(以下省略。全文は「回答をコピー」で)</Text>
      ) : null}
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Button
          key={`inj:${item.id}`}
          plain
          label={item.isInjected ? 'メイン済' : 'メインへ'}
          onPress={() => {
            void inject($, [item])
          }}
        />
        <Button
          key={`pin:${item.id}`}
          plain
          label={item.isPinned ? 'ピン解除' : 'ピン留め'}
          onPress={() => {
            void mutate($, every =>
              every.map(one =>
                one.id === item.id ? { ...one, isPinned: !one.isPinned } : one,
              ),
            )
          }}
        />
        <Button
          key={`copy:${item.id}`}
          plain
          label="回答をコピー"
          onPress={press => {
            void $.ui.copy({ text: item.a, surface: press.surface })
          }}
        />
        <Button
          key={`del:${item.id}`}
          plain
          label="削除"
          onPress={() => {
            void mutate($, every => every.filter(one => one.id !== item.id))
          }}
        />
      </Box>
    </Box>
    )
  })

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" flexShrink={0}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Text bold color="claude">
            btw
          </Text>
          <Text dimColor>{running > 0 ? `実行中 ${running}` : '待機中'}</Text>
          {isFixed && mine.length > 0 ? (
            <Text dimColor>{`${view.start + 1}-${view.end} / ${mine.length}`}</Text>
          ) : null}
          <Button
            key="where"
            plain
            label={where === 'band' ? '表示: 下' : '表示: 横'}
            onPress={() => then(move())}
          />
          {site.isBand ? (
            <Button
              key="band-close"
              plain
              label="閉じる"
              onPress={() => update($, bandAtom, () => false)}
            />
          ) : null}
          {isFixed ? (
            <Button
              key="older"
              plain
              label="^"
              onPress={() => then(older())}
            />
          ) : null}
          {isFixed ? (
            <Button
              key="newer"
              plain
              label="v"
              onPress={() => then(newer())}
            />
          ) : null}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Button
            key="memory"
            label={m.isOn ? '記憶 ON' : '記憶 OFF'}
            onPress={() => then(setMemory($, one => ({ ...one, isOn: !one.isOn })))}
          />
          <Button key="keep" label={`直近 ${m.keep} 件`} onPress={() => then(cycleKeep())} />
          <Button
            key="clear"
            label="履歴を消す"
            onPress={() =>
              then(
                mutate($, every =>
                  every.filter(item => item.sid !== sid || item.isPinned),
                ),
              )
            }
          />
          <Button
            key="inject-all"
            label="メインに反映"
            onPress={() =>
              then(
                inject(
                  $,
                  mine.filter(item => item.sid === sid),
                ),
              )
            }
          />
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Text dimColor>モデル</Text>
          {modelRows.map(row => (
            <Button
              key={`model:${row.value}`}
              plain
              label={row.value === modelNow ? `[${row.label}]` : row.label}
              onPress={() =>
                then(update($, pick, one => ({ ...one, model: row.value })))
              }
            />
          ))}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          <Text dimColor>エフォート</Text>
          {EFFORT_OPTIONS.map(row => (
            <Button
              key={`effort:${row.value}`}
              plain
              label={row.value === effortNow ? `[${row.label}]` : row.label}
              onPress={() =>
                then(update($, pick, one => ({ ...one, effort: row.value })))
              }
            />
          ))}
        </Box>
      </Box>

      {isFixed ? (
        <Box
          flexDirection="column"
          justifyContent="flex-end"
          height={room}
          overflow="hidden"
        >
          {history}
        </Box>
      ) : (
        <Box flexDirection="column">
          {mine.length === 0 ? null : history}
        </Box>
      )}

      {mine.length === 0 ? (
        <Text dimColor>
          まだ質問がありません。下の欄、またはプロンプトの「q: 質問」で聞けます。
        </Text>
      ) : null}

      <Box flexDirection="column" flexShrink={0}>
        {staged ? (
          <Box flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
            <Box flexDirection="row" gap={1}>
              <Text bold color="claude">
                引用中
              </Text>
              <Button
                key="unquote"
                plain
                label="外す"
                onPress={() => then(update($, quote, () => ''))}
              />
            </Box>
            <Text dimColor>{clip(staged.replace(/\s+/g, ' '), 120)}</Text>
          </Box>
        ) : null}

        {Input ? (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button
                key="grab"
                variant="primary"
                label="選択を引用"
                onPress={() => then(grab())}
              />
              <Text dimColor>(先に画面の文章を選択)</Text>
            </Box>
            <Box borderStyle="round" borderColor="promptBorder" paddingX={1}>
              <Input
                key="ask"
                autoFocus
                placeholder="ここに入力"
                value={typed}
                onInput={value => {
                  void update($, draft, () => value)
                }}
                onSubmit={value => {
                  void submit(value)
                }}
              />
            </Box>
          </Box>
        ) : (
          <Text dimColor>
            この画面には入力欄がありません。プロンプトで「q: 質問」と送ってください。
          </Text>
        )}
      </Box>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const prefixes = list(options.prefixes, DEFAULT_PREFIXES)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'btw-pane',
      description: 'btw のサイドペインを開く',
    })
    await $.command.register({
      name: 'btw-clear',
      description: 'btw の履歴を消す(all を付けるとピン留めも消す)',
      argumentHint: '[all]',
    })
    await $.command.register({
      name: 'btw-memory',
      description: 'btw の記憶を設定する: on / off / 件数 / status',
      argumentHint: '[on|off|N|status]',
    })
    await $.command.register({
      name: 'btw-inject',
      description: 'btw の回答をメインの会話に入れる(既定は最新の1件、all で全部)',
      argumentHint: '[all]',
    })

    const saved = await $.store.get(ITEMS_KEY)
    if (Array.isArray(saved)) {
      const restored = (saved as Item[]).map(item =>
        item.status === 'pending'
          ? { ...item, status: 'error' as const, a: '中断されました(セッションの開始・再読み込み)' }
          : item,
      )
      await update($, items, () => restored)
    }
    const savedMemory = await $.store.get(MEMORY_KEY)
    if (savedMemory && typeof savedMemory === 'object') {
      const m = savedMemory as Partial<Memory>
      await update($, memory, () => ({
        isOn: m.isOn !== false,
        keep: Number.isFinite(Number(m.keep)) ? Number(m.keep) : 5,
      }))
    }

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta) return next(e)
    const text = e.text.trim()
    if (text.startsWith(SENTINEL)) return next(e)

    const prefix = prefixes.find(one =>
      text.toLowerCase().startsWith(one.toLowerCase()),
    )
    if (prefix === undefined) return next(e)

    const q = text.slice(prefix.length).trim()
    if (!q) return { drop: `使い方: ${prefix} <質問>` }

    await ask($, options, q)

    return { drop: `💬 btw → サイドペインで回答します: ${clip(q, 60)}` }
  })

  on('command.run', { command: 'btw-pane' }, async $ => {
    await show($, options, true)

    return { text: 'btw を開きました。' }
  })

  on('command.run', { command: 'btw-clear' }, async ($, e) => {
    const isAll = e.args.trim() === 'all'
    const sid = await $.session.id()
    await mutate($, all =>
      all.filter(item => (isAll ? false : item.sid !== sid || item.isPinned)),
    )

    return {
      text: isAll
        ? 'btw の履歴をすべて消しました。'
        : 'このセッションの btw 履歴を消しました(ピン留めは残しています)。',
    }
  })

  on('command.run', { command: 'btw-memory' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    let m = await read($, memory)

    if (arg === 'on' || arg === 'off') {
      m = await setMemory($, one => ({ ...one, isOn: arg === 'on' }))
    } else if (/^\d+$/.test(arg)) {
      m = await setMemory($, () => ({ isOn: true, keep: Math.min(50, Number(arg)) }))
    }

    return {
      text: m.isOn
        ? `btw の記憶: ON(直近 ${m.keep} 件+ピン留め)`
        : 'btw の記憶: OFF',
    }
  })

  on('command.run', { command: 'btw-inject' }, async ($, e) => {
    const sid = await $.session.id()
    const mine = (await read($, items)).filter(
      item => item.sid === sid && item.status === 'done',
    )
    const targets = e.args.trim() === 'all' ? mine : mine.slice(-1)
    await inject($, targets)

    return { text: `メインに入れる対象: ${targets.length}件` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    draw($, options, $.ui.resolve(e), {
      rows: e.props.scroll.bodyRows,
      columns: e.props.bodyColumns,
      id: e.requestId,
      isBand: false,
    }),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const isOpen =
      (await whereNow($, options)) === 'band' && (await read($, bandAtom))
    if (e.props.hasSurvey || !isOpen) return next(e)

    return draw($, options, $.ui.resolve(e), {
      rows: e.props.scroll.bodyRows,
      columns: e.props.bodyColumns,
      id: e.requestId,
      isBand: true,
    })
  })
}
