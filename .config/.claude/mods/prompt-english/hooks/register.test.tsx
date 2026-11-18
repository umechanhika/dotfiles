import type { ModelCompleteResult, PromptOrigin } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { parseStress } from './markup'
import { extractEnglish, MAX_PROMPT_CHARS } from './register'

const BAND = {
  plugin: 'prompt-english',
  component: 'AbovePrompt',
  surface: 'terminal',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 100,
    scroll: { offset: 0, bodyRows: 6 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 1,
  output_tokens: 1,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

// A reply as the model writes it: the English in one block.
const block = (english: string) => `<english>\n${english}\n</english>`

// A prompt as the engine hands it over when the person presses Enter.
function typed(text: string, origin: PromptOrigin = { kind: 'composer' }) {
  return { text, wait: false, origin }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

// Lets the background translation settle after its reply is released.
async function settle() {
  for (let i = 0; i < 500; i += 1) {
    await Promise.resolve()
  }
}

test('parseStress splits stressed syllables into bold runs', () => {
  const parsed = parseStress('the **ENG**lish trans**LA**tion')
  expect(parsed).toEqual({
    isValid: true,
    runs: [
      { text: 'the ', isStressed: false },
      { text: 'ENG', isStressed: true },
      { text: 'lish trans', isStressed: false },
      { text: 'LA', isStressed: true },
      { text: 'tion', isStressed: false },
    ],
  })
})

test('parseStress rejects an unclosed mark', () => {
  expect(parseStress('the **ENGlish').isValid).toBe(false)
})

test('a submitted prompt shows its translation with stressed syllables in bold', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: true, text: block('show the **ENG**lish'), usage: USAGE } }))

  await $.prompt.submit(typed('英語を表示して'))
  await settle()

  const ui = await $.ui.mount(BAND)
  const stressed = await ui.find({ type: 'Text', text: /^ENG$/ })
  expect(stressed?.props.bold).toBe(true)
  await ui.unmount()
})

test('the prompt is passed on unchanged and does not wait for the translation', async ($, on) => {
  const reply = deferred<ModelCompleteResult>()
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => reply.promise.then(value => ({ value })))

  const result = await $.prompt.submit(typed('そのまま送る'))
  expect(result.text).toBe('そのまま送る')

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /英訳中/ }))?.text).toBe('英訳中…')
  await ui.unmount()
})

test('a slow translation of an older prompt does not replace the newer one', async ($, on) => {
  const replies = [deferred<ModelCompleteResult>(), deferred<ModelCompleteResult>()]
  let call = 0
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => replies[call++]!.promise.then(value => ({ value })))

  await $.prompt.submit(typed('一つ目'))
  await $.prompt.submit(typed('二つ目'))
  replies[1]!.resolve({ isAnswered: true, text: block('**SEC**ond'), usage: USAGE })
  await settle()
  replies[0]!.resolve({ isAnswered: true, text: block('**FIRST**'), usage: USAGE })
  await settle()

  const ui = await $.ui.mount(BAND)
  expect(await ui.find({ type: 'Text', text: /^SEC$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^FIRST$/ })).toBeUndefined()
  await ui.unmount()
})

test('a failed call is shown with its reason, not hidden', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: false, reason: 'empty-reply', usage: USAGE } }))

  await $.prompt.submit(typed('失敗させる'))
  await settle()

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /英訳に失敗/ }))?.text).toContain('empty-reply')
  await ui.unmount()
})

test('slash commands are not translated', async ($, on) => {
  let calls = 0
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: 'x', usage: USAGE } }
  })

  await $.prompt.submit({ ...typed('/vim-cheat'), command: { name: 'vim-cheat' } } as never)
  await settle()

  expect(calls).toBe(0)
})

test('prompts the person did not type are not translated', async ($, on) => {
  let calls = 0
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: 'x', usage: USAGE } }
  })

  await $.prompt.submit(typed('task done', { kind: 'task-notification' }))
  await $.prompt.submit(typed('loop prompt', { kind: 'scheduled-trigger' }))
  await settle()

  expect(calls).toBe(0)
})

test('a prompt sent from a phone through Remote Control is translated', async ($, on) => {
  let calls = 0
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: 'x', usage: USAGE } }
  })

  await $.prompt.submit(typed('スマホから', { kind: 'bridge' }))
  await settle()

  expect(calls).toBe(1)
})

test('a reply cut before its closing tag is reported as cut, not shown as a translation', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: true, text: '<english>\nshow the **ENG**lish', usage: USAGE } }))

  await $.prompt.submit(typed('途中で切れる'))
  await settle()

  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /英訳に失敗/ }))?.text).toContain('途中で切れました')
  expect(await ui.find({ type: 'Text', text: /^ENG$/ })).toBeUndefined()
  await ui.unmount()
})

test('a prompt over the length limit is not sent and the band says why', async ($, on) => {
  let calls = 0
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: block('x'), usage: USAGE } }
  })

  await $.prompt.submit(typed('あ'.repeat(MAX_PROMPT_CHARS + 1)))
  await settle()

  expect(calls).toBe(0)
  const ui = await $.ui.mount(BAND)
  expect((await ui.find({ type: 'Text', text: /長文のため/ }))?.text).toContain('4,001')
  await ui.unmount()
})

test('a prompt at the length limit is still translated', async ($, on) => {
  let calls = 0
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => {
    calls += 1
    return { value: { isAnswered: true, text: block('x'), usage: USAGE } }
  })

  await $.prompt.submit(typed('あ'.repeat(MAX_PROMPT_CHARS)))
  await settle()

  expect(calls).toBe(1)
})

test('extractEnglish takes the one block and ignores text around it', () => {
  expect(extractEnglish('note\n<english>\n**HI** there\n</english>\n')).toEqual({ isValid: true, english: '**HI** there' })
})

test('extractEnglish rejects a reply that corrects itself with a second block', () => {
  const reply = `${block('**FIRST** try')}\n\nWait, let me fix that.\n\n${block('**SEC**ond try')}`
  expect(extractEnglish(reply)).toEqual({ isValid: false, reason: '返答に英訳のブロックが複数あります' })
})

test('extractEnglish rejects a reply with no block', () => {
  expect(extractEnglish('**HI** there').isValid).toBe(false)
})

test('while a turn runs the text hangs from a ⎿ like the Tip line; idle it keeps the indent only', async ($, on) => {
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('model.complete', () => ({ value: { isAnswered: true, text: block('**HI**'), usage: USAGE } }))

  await $.prompt.submit(typed('こんにちは'))
  await settle()

  const working = await $.ui.mount({ ...BAND, props: { ...BAND.props, isWorking: true } })
  expect((await working.find({ type: 'Text', text: /⎿/ }))?.text).toBe('   ⎿ ')
  await working.unmount()

  const idle = await $.ui.mount(BAND)
  expect(await idle.find({ type: 'Text', text: /⎿/ })).toBeUndefined()
  expect(await idle.find({ type: 'Text', text: /^HI$/ })).toBeDefined()
  await idle.unmount()
})
