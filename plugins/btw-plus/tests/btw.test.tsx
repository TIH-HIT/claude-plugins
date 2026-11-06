// @ts-nocheck: the test kit's calls are checked at run time; typing every
// engine input here would only restate them.
import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'btw-plus',
  component: 'Pane',
  requestId: 'btw',
  props: {
    title: 'btw',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
}

// Everything beneath the plugin: the session, the panes, the child process.
function world(on, options = {}) {
  const runs = []
  const opens = []
  // The engine keeps the last selection until the person selects again.
  let selection = options.selection
  const select = text => {
    selection = text
  }
  const clock = mock.clock(on, { now: 1000 })
  const session = mock.session(on)
  mock.store(on)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'x' } }))
  on('ui.open', (_, e) => {
    opens.push(e)

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  // The engine's own drawing of a site no plugin claims: nothing.
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('ui.panes', () => ({
    value: [
      { id: 'btw', title: 'btw', isShown: true, isFocused: false, isPlaced: true },
    ],
  }))
  on('ui.scroll', () => ({}))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'main-1' }))
  on('session.model', () => ({ value: 'claude-test-9' }))
  on('session.turns', () => ({ value: options.turns ?? 3 }))
  on('session.cwd', () => ({ value: '/work' }))
  on('ui.selection', () => ({
    value: selection ? { text: selection } : undefined,
  }))
  on('process.run', (_, e) => {
    runs.push({ argv: e.argv, stdin: e.init?.stdin, cwd: e.init?.cwd })

    return {
      value: {
        exitCode: options.exitCode ?? 0,
        stdout: options.stdout ?? '答えです\n',
        stderr: options.exitCode ? 'boom' : '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))

  return { runs, opens, clock, select, session }
}

async function start($) {
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

async function ask($, clock, text) {
  const result = await $.prompt.submit({ text, wait: false })
  await clock.advance(1)
  await clock.settle()

  return result
}

const mount = ($, surface = 'desktop', props = {}) =>
  $.ui.mount({ ...PANE, props: { ...PANE.props, ...props }, surface })

const appendedText = session =>
  session.appended().map(row => row.message.content[0].text)

test('q: asks a fork of the session and keeps the question out of the chat', async ($, on) => {
  const { runs, clock } = world(on)
  await start($)

  const result = await ask($, clock, 'q: これは何?')

  expect(result.drop).toContain('サイドペイン')
  expect(runs).toHaveLength(1)
  const run = runs[0]
  expect(run.argv.slice(0, 5)).toEqual(['claude', '-p', '--resume', 'main-1', '--fork-session'])
  expect(run.argv).toContain('--allowedTools')
  expect(run.argv).toContain('Edit')
  expect(run.stdin).toContain('## Question\nこれは何?')
  expect(run.stdin.startsWith('[btw-fork]')).toBe(true)
  expect(run.cwd).toBe('/work')
})

test('the answer is drawn in the pane on every surface', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await ask($, clock, '？？ 全角でも動く')

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile']) {
    const ui = await mount($, surface)
    expect((await ui.find({ type: 'Text', text: /全角でも動く/ }))?.text).toContain('Q: 全角でも動く')
    expect(await ui.find({ type: 'Markdown', text: /答えです/ })).toBeDefined()
    // The pane draws its field wherever the surface offers one.
    expect(await ui.find({ key: 'ask' })).toBeDefined()
    await ui.unmount()
  }
})

test('Q and A are told apart by colour', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await ask($, clock, 'q: 色を分ける')

  const ui = await mount($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /^Q: 色を分ける/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^A:$/ })).toBeDefined()
  await ui.unmount()
})

test('the next question is told the earlier ones', async ($, on) => {
  const { runs, clock } = world(on, { stdout: '一つ目の答え' })
  await start($)

  await ask($, clock, 'q: 一つ目の質問')
  await ask($, clock, 'q: 二つ目の質問')

  expect(runs[0].stdin).not.toContain('Earlier side Q&A')
  expect(runs[1].stdin).toContain('Earlier side Q&A')
  expect(runs[1].stdin).toContain('Q: 一つ目の質問')
  expect(runs[1].stdin).toContain('A: 一つ目の答え')
})

test('memory can be switched off and cleared', async ($, on) => {
  const { runs, clock } = world(on)
  await start($)

  await ask($, clock, 'q: 一つ目')
  const off = await $.command.run({ command: 'btw-memory', args: 'off' })
  expect(off.text).toContain('OFF')
  await ask($, clock, 'q: 二つ目')
  expect(runs[1].stdin).not.toContain('Earlier side Q&A')

  await $.command.run({ command: 'btw-memory', args: 'on' })
  await $.command.run({ command: 'btw-clear', args: '' })
  await ask($, clock, 'q: 三つ目')
  expect(runs[2].stdin).not.toContain('Earlier side Q&A')
})

test('a pinned answer is remembered after the history is cleared', async ($, on) => {
  const { runs, clock } = world(on, { stdout: '覚えておく答え' })
  await start($)
  await ask($, clock, 'q: 覚えさせる')

  const ui = await mount($)
  const pin = await ui.find({ type: 'Button', text: /ピン留め/ })
  await ui.press({ key: pin.key })
  await ui.unmount()

  await $.command.run({ command: 'btw-clear', args: '' })
  await ask($, clock, 'q: 次の質問')
  expect(runs[1].stdin).toContain('A: 覚えておく答え')
})

test('a selection alone is never taken as a quote', async ($, on) => {
  const { runs, clock } = world(on, { selection: 'S1' })
  await start($)

  await ask($, clock, 'q: 一つ目')

  expect(runs[0].stdin).not.toContain('S1')
  expect(runs[0].stdin).not.toContain('Text the user selected')
})

test('the quote button fills the slot; the next question carries it once', async ($, on) => {
  const { runs, clock } = world(on, { selection: 'retry with backoff' })
  await start($)

  const ui = await mount($)
  await ui.press({ key: 'grab' })
  expect(await ui.find({ type: 'Text', text: /引用中/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /retry with backoff/ })).toBeDefined()
  await ui.unmount()

  // The slot serves a question typed in the main prompt too.
  await ask($, clock, 'q: これの意味は?')
  await ask($, clock, 'q: もう一度')

  expect(runs[0].stdin).toContain('## Text the user selected on screen\n> retry with backoff')
  expect(runs[1].stdin).not.toContain('## Text the user selected')

  const after = await mount($)
  expect(await after.find({ type: 'Text', text: /引用中/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /引用: retry with backoff/ })).toBeDefined()
  await after.unmount()
})

test('removing the quote empties the slot, and the selection stays out', async ($, on) => {
  const { runs, clock } = world(on, { selection: 'S1' })
  await start($)

  const ui = await mount($)
  await ui.press({ key: 'grab' })
  expect(await ui.find({ type: 'Text', text: /S1/ })).toBeDefined()
  await ui.press({ key: 'unquote' })
  expect(await ui.find({ type: 'Text', text: /S1/ })).toBeUndefined()
  await ui.input({ key: 'ask', text: '引用なしで', kind: 'submit' })
  await clock.advance(1)
  await clock.settle()
  await ui.unmount()

  expect(runs).toHaveLength(1)
  expect(runs[0].stdin).not.toContain('S1')
})

test('the pane asks too, with the quote taken by its button', async ($, on) => {
  const { runs, clock } = world(on, { selection: 'SELECTED' })
  await start($)

  const ui = await mount($)
  await ui.press({ key: 'grab' })
  await ui.input({ key: 'ask', text: '説明して', kind: 'submit' })
  await clock.advance(1)
  await clock.settle()
  await ui.unmount()

  expect(runs).toHaveLength(1)
  expect(runs[0].stdin).toContain('> SELECTED')
  expect(runs[0].stdin).toContain('## Question\n説明して')
})

test('pressing the quote button with nothing selected says so and quotes nothing', async ($, on) => {
  const { clock } = world(on)
  await start($)

  const ui = await mount($)
  await ui.press({ key: 'grab' })
  expect(await ui.find({ type: 'Text', text: /引用中/ })).toBeUndefined()
  await ui.unmount()
  await clock.settle()
})

test('one answer is added to the main conversation, once', async ($, on) => {
  const { clock, session } = world(on, { stdout: '本線に入れる答え' })
  await start($)
  await ask($, clock, 'q: メインに入れたい')

  const ui = await mount($)
  const inject = await ui.find({ type: 'Button', text: /^メインへ$/ })
  await ui.press({ key: inject.key })

  expect(appendedText(session)).toHaveLength(1)
  expect(appendedText(session)[0]).toContain('Q: メインに入れたい')
  expect(appendedText(session)[0]).toContain('A: 本線に入れる答え')
  expect(await ui.find({ type: 'Button', text: /メイン済/ })).toBeDefined()

  // Pressed again, nothing more is added.
  const done = await ui.find({ type: 'Button', text: /メイン済/ })
  await ui.press({ key: done.key })
  expect(appendedText(session)).toHaveLength(1)
  await ui.unmount()
})

test('the header button adds every answer of this session in one row', async ($, on) => {
  const { clock, session } = world(on)
  await start($)
  await ask($, clock, 'q: 一つ目')
  await ask($, clock, 'q: 二つ目')

  const ui = await mount($)
  await ui.press({ key: 'inject-all' })
  await ui.unmount()

  expect(appendedText(session)).toHaveLength(1)
  expect(appendedText(session)[0]).toContain('Q: 一つ目')
  expect(appendedText(session)[0]).toContain('Q: 二つ目')
})

test('/btw-inject adds the latest answer, or all of them', async ($, on) => {
  const { clock, session } = world(on)
  await start($)
  await ask($, clock, 'q: 一つ目')
  await ask($, clock, 'q: 二つ目')

  await $.command.run({ command: 'btw-inject', args: '' })
  expect(appendedText(session)).toHaveLength(1)
  expect(appendedText(session)[0]).toContain('Q: 二つ目')
  expect(appendedText(session)[0]).not.toContain('Q: 一つ目')

  await $.command.run({ command: 'btw-inject', args: 'all' })
  expect(appendedText(session)).toHaveLength(2)
  expect(appendedText(session)[1]).toContain('Q: 一つ目')
  expect(appendedText(session)[1]).not.toContain('Q: 二つ目')
})

test('answers go to the main conversation by themselves when asked to', { options: { autoInject: true } }, async ($, on) => {
  const { clock, session } = world(on, { stdout: '自動で入る' })
  await start($)
  await ask($, clock, 'q: 自動で')

  expect(appendedText(session)).toHaveLength(1)
  expect(appendedText(session)[0]).toContain('A: 自動で入る')
})

test('a failed fork is not added to the main conversation', { options: { autoInject: true } }, async ($, on) => {
  const { clock, session } = world(on, { exitCode: 2, stdout: '' })
  await start($)
  await ask($, clock, 'q: 失敗する')

  expect(appendedText(session)).toHaveLength(0)
})

test('the fixed layout shows the newest answers, and the arrows page back', async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (let n = 1; n <= 8; n += 1) await ask($, clock, `q: 質問${n}`)

  const ui = await mount($)
  // The controls are in the tree whatever the history holds.
  for (const key of ['memory', 'keep', 'clear', 'inject-all', 'older', 'newer', 'grab', 'ask']) {
    expect(await ui.find({ key })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /質問8/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /質問1/ })).toBeUndefined()

  await ui.press({ key: 'older' })
  expect(await ui.find({ type: 'Text', text: /質問8/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /質問[4-7]/ })).toBeDefined()

  await ui.press({ key: 'newer' })
  expect(await ui.find({ type: 'Text', text: /質問8/ })).toBeDefined()
  await ui.unmount()
})

test('a new question brings the window back to the newest', async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (let n = 1; n <= 8; n += 1) await ask($, clock, `q: 質問${n}`)

  const ui = await mount($)
  await ui.press({ key: 'older' })
  expect(await ui.find({ type: 'Text', text: /質問8/ })).toBeUndefined()
  await ui.input({ key: 'ask', text: '最新', kind: 'submit' })
  await clock.advance(1)
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /Q: 最新/ })).toBeDefined()
  await ui.unmount()
})

test('with the fixed layout off, every answer is drawn and there are no arrows', { options: { fixedLayout: false } }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (let n = 1; n <= 8; n += 1) await ask($, clock, `q: 質問${n}`)

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /質問1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /質問8/ })).toBeDefined()
  expect(await ui.find({ key: 'older' })).toBeUndefined()
  await ui.unmount()
})

test('a pane too short for the fixed layout is drawn in its natural flow', async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (let n = 1; n <= 4; n += 1) await ask($, clock, `q: 質問${n}`)

  const ui = await mount($, 'desktop', { scroll: { offset: 0, bodyRows: 8 } })
  expect(await ui.find({ type: 'Text', text: /質問1/ })).toBeDefined()
  expect(await ui.find({ key: 'older' })).toBeUndefined()
  await ui.unmount()
})

test('the pane is opened at the width the settings ask for', { options: { paneColumns: 70, paneRows: 12 } }, async ($, on) => {
  const { opens, clock } = world(on)
  await start($)
  await ask($, clock, 'q: 幅')

  const open = opens[opens.length - 1]
  expect(open.id).toBe('btw')
  expect(open.columns).toBe(70)
  expect(open.rows).toBe(12)
})

test('without settings the pane asks for no size', async ($, on) => {
  const { opens, clock } = world(on)
  await start($)
  await ask($, clock, 'q: 標準')

  const open = opens[opens.length - 1]
  expect(open.columns).toBeUndefined()
  expect(open.rows).toBeUndefined()
})

test('a failed fork shows its error, and a fork prompt is not asked again', async ($, on) => {
  const { runs, clock } = world(on, { exitCode: 2, stdout: '' })
  await start($)
  await ask($, clock, 'q: 失敗する')

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /フォークが失敗しました/ })).toBeDefined()
  await ui.unmount()

  const passed = await $.prompt.submit({ text: '[btw-fork] q: 再帰しない', wait: false })
  expect(passed.text).toBe('[btw-fork] q: 再帰しない')
  expect(runs).toHaveLength(1)
})

test('a session with no turns is asked fresh', async ($, on) => {
  const { runs, clock } = world(on, { turns: 0 })
  await start($)
  await ask($, clock, 'q: はじめまして')

  expect(runs[0].argv).not.toContain('--resume')
})

test('the hard-to-type ?? is not a prefix by default', async ($, on) => {
  const { runs, clock } = world(on)
  await start($)
  const result = await ask($, clock, '?? ふつうのプロンプト')

  expect(result.text).toBe('?? ふつうのプロンプト')
  expect(runs).toHaveLength(0)
})

test('model and effort picked in the pane reach the fork', async ($, on) => {
  const { runs, clock } = world(on)
  await start($)

  const ui = await mount($)
  await ui.press({ key: 'settings' })
  await ui.press({ key: 'model:haiku' })
  await ui.press({ key: 'effort:low' })
  await ui.unmount()
  await ask($, clock, 'q: 軽く')

  const argv = runs[0].argv
  expect(argv[argv.indexOf('--model') + 1]).toBe('haiku')
  expect(argv[argv.indexOf('--effort') + 1]).toBe('low')
})

test('model and effort are rows of buttons, the chosen one marked', async ($, on) => {
  world(on)
  await start($)

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile']) {
    const ui = await mount($, surface)
    // The settings stay open from one surface to the next.
    if (!(await ui.find({ key: 'model:opus' }))) await ui.press({ key: 'settings' })
    await ui.press({ key: 'model:opus' })
    expect(await ui.find({ type: 'Button', text: /\[opus\(最新\)\]/ })).toBeDefined()
    await ui.press({ key: 'effort:high' })
    expect(await ui.find({ type: 'Button', text: /\[high\]/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a very long answer is never cut: the controls stay and the history scrolls', async ($, on) => {
  const long = Array.from({ length: 80 }, (_, n) => `行${n + 1}の説明です`).join('\n')
  const { clock } = world(on, { stdout: long })
  await start($)
  await ask($, clock, 'q: 長い答え')

  const ui = await mount($)
  // The newest lines show, the controls and the field are all there.
  expect(await ui.find({ type: 'Markdown', text: /行80の説明/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /行1の説明/ })).toBeUndefined()
  for (const key of ['memory', 'keep', 'clear', 'inject-all', 'grab', 'ask']) {
    expect(await ui.find({ key })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: /以下省略/ })).toBeUndefined()

  // Paging up reaches the first line; the controls never moved.
  for (let n = 0; n < 12; n += 1) await ui.press({ key: 'older' })
  expect(await ui.find({ type: 'Markdown', text: /行1の説明/ })).toBeDefined()
  expect(await ui.find({ key: 'ask' })).toBeDefined()

  for (let n = 0; n < 12; n += 1) await ui.press({ key: 'newer' })
  expect(await ui.find({ type: 'Markdown', text: /行80の説明/ })).toBeDefined()
  await ui.unmount()
})

test('short answers keep the fixed layout', async ($, on) => {
  const { clock } = world(on)
  await start($)
  await ask($, clock, 'q: 短い')

  const ui = await mount($)
  expect(await ui.find({ key: 'older' })).toBeDefined()
  await ui.unmount()
})

const BAND = {
  plugin: 'btw-plus',
  component: 'AbovePrompt',
  requestId: 'band',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 20,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 19 },
    view: {},
  },
}
const mountBand = ($, surface = 'terminal', props = {}) =>
  $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface })

test('with location band, answers are drawn above the prompt and no pane opens', { options: { location: 'band' } }, async ($, on) => {
  const { opens, clock } = world(on)
  await start($)

  const before = await mountBand($)
  expect(await before.find({ type: 'Markdown', text: /答えです/ })).toBeUndefined()
  await before.unmount()

  await ask($, clock, 'q: 下に出す')
  expect(opens).toHaveLength(0)

  const ui = await mountBand($)
  expect(await ui.find({ type: 'Text', text: /Q: 下に出す/ })).toBeDefined()
  expect(await ui.find({ type: 'Markdown', text: /答えです/ })).toBeDefined()
  expect(await ui.find({ key: 'ask' })).toBeDefined()

  await ui.press({ key: 'band-close' })
  expect(await ui.find({ type: 'Markdown', text: /答えです/ })).toBeUndefined()
  await ui.unmount()
})

test('a survey holds the band: the history stays out of its way', { options: { location: 'band' } }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  await ask($, clock, 'q: 調査中')

  const ui = await mountBand($, 'terminal', { hasSurvey: true })
  expect(await ui.find({ type: 'Markdown', text: /答えです/ })).toBeUndefined()
  await ui.unmount()
})

test('the pane button moves the history to the band and back', async ($, on) => {
  const { opens, clock } = world(on)
  await start($)
  await ask($, clock, 'q: 移動する')
  const first = opens.length

  const pane = await mount($)
  await pane.press({ key: 'where' })
  await pane.unmount()
  const band = await mountBand($)
  expect(await band.find({ type: 'Markdown', text: /答えです/ })).toBeDefined()
  await band.press({ key: 'where' })
  await band.unmount()
  expect(opens.length).toBe(first + 1)
})

test('the band is framed, and keeps the fixed layout at its short height', { options: { location: 'band', background: '#1e1e2e' } }, async ($, on) => {
  const { clock } = world(on)
  await start($)
  for (let n = 1; n <= 6; n += 1) await ask($, clock, `q: 質問${n}`)

  const ui = await mountBand($, 'terminal', { maxRows: 16, scroll: { offset: 0, bodyRows: 15 } })
  for (const key of ['memory', 'settings', 'ask']) {
    expect([key, Boolean(await ui.find({ key }))]).toEqual([key, true])
  }
  // The newest answer shows; the oldest question is a scroll away.
  expect(await ui.find({ type: 'Markdown', text: /答えです/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Q: 質問1$/ })).toBeUndefined()
  await ui.unmount()
})

test('a window never begins in the middle of a table', async ($, on) => {
  const filler = Array.from({ length: 30 }, (_, n) => `行${n + 1}`).join('\n')
  const table = '| 名前 | 値 |\n|---|---|\n| あ | 1 |\n| い | 2 |\n| う | 3 |\n| え | 4 |'
  const { clock } = world(on, { stdout: `${filler}\n\n${table}\n\n末尾` })
  await start($)
  await ask($, clock, 'q: 表')

  const ui = await mount($)
  const blocks = await ui.findAll({ type: 'Markdown' })
  const text = blocks.map(block => block.text).join('\n')
  // Whichever rows show, the header and its rule come with them.
  if (text.includes('| う | 3 |')) {
    expect(text).toContain('| 名前 | 値 |')
    expect(text).toContain('|---|---|')
  }
  await ui.unmount()
})
