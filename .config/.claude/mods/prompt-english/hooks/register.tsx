import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Practice } from '../types'
import { parseStress } from './markup'

const practice = atom({ plugin: 'prompt-english', key: 'practice' } as const, null as Practice | null)

const MODEL = 'sonnet'
const TIMEOUT_MS = 60_000
// The model thinks before it writes (EFFORT), and that thinking counts toward
// this cap: a 420-character prompt measured about 6,100 output tokens.
const MAX_TOKENS = 16_000
// Without thinking, Sonnet marked the wrong syllables and corrected itself
// after the block; thinking first removed both on the 10-prompt check.
const EFFORT = 'high'
// Prompts longer than this are not sent: a prompt typed by hand rarely gets
// here, so the rest is pasted material that is not worth paying to translate.
export const MAX_PROMPT_CHARS = 4000
// Columns before the text: the spinner's Tip line starts its text at column 5.
const GUTTER_WIDTH = 5
export const SYSTEM = `You turn a prompt the user wrote (usually Japanese) into the English they would say out loud to a colleague, for speaking practice.

Meaning:
- Keep the exact intent, requests, conditions and nuance of the original. Do not add, drop or soften anything, and do not add alternatives or questions the original does not ask.
- Use natural spoken English, not a word-for-word translation.
- Pasted material (logs, stack traces, code blocks, long URLs) is not something the user says out loud. Replace each piece with a short bracketed reference in plain English, such as [the error log] or [this code], and translate only the user's own words around it. Notes or instructions the user wrote and pasted are their own words: translate them.

Rhythm:
- Split the English into thought groups (the chunks a speaker says in one breath, usually 2 to 7 words) and put " / " between them.
- Every thought group has exactly 1 or 2 marked words: never 0, never 3 or more. Mark the words that carry the sentence stress (the new or contrasting information).
- In a marked word, wrap only its primary-stressed syllable in ** and write that syllable in UPPERCASE; the rest of the word stays lowercase. Examples: **ENG**lish, trans**LA**tion, de**VEL**op, pho**TOG**raphy, e**CON**omy, **SHOWS**.
- Take the stressed syllable from the dictionary pronunciation, not from the spelling. Many words are not stressed on their first syllable. A word that is both a noun and a verb can move its stress: a **RE**cord (noun) / to re**CORD** (verb), the **PRO**gress (noun) / to pro**GRESS** (verb).
- Never mark proper nouns, product names, file names, commands or code; choose another word in that thought group.

Output:
- Before you write the block, check every marked syllable against its dictionary pronunciation and count the marked words in every thought group. The block is final: never follow it with corrections.
- Write the English inside one <english></english> block, once. Nothing else is shown to the user, and two blocks are an error.
- Inside the block, use no markdown other than the ** marks.`

// The reply has no sign of being cut at the token cap; a block without its
// closing tag is how a cut reply is told apart.
export function extractEnglish(reply: string): { isValid: true; english: string } | { isValid: false; reason: string } {
  const opens = reply.split('<english>').length - 1
  const closes = reply.split('</english>').length - 1
  if (opens === 0) {
    return { isValid: false, reason: '返答に英訳のブロックがありません' }
  }
  if (opens > 1 || closes > 1) {
    return { isValid: false, reason: '返答に英訳のブロックが複数あります' }
  }
  if (closes === 0) {
    return { isValid: false, reason: '返答が途中で切れました（閉じタグがありません）' }
  }
  const english = reply.slice(reply.indexOf('<english>') + '<english>'.length, reply.indexOf('</english>')).trim()
  return { isValid: true, english }
}

async function translate($: EngineInterface, seq: number, prompt: string): Promise<void> {
  const settle = (next: Practice) =>
    // A newer prompt may have been sent while this one was translating;
    // its state wins.
    update($, practice, current => (current?.seq === seq ? next : current))

  try {
    const result = await $.model.complete({
      model: MODEL,
      system: SYSTEM,
      prompt,
      maxTokens: MAX_TOKENS,
      effort: EFFORT,
      timeoutMs: TIMEOUT_MS,
    })
    if (!result.isAnswered) {
      const detail =
        result.reason === 'api-error' ? `api-error ${result.status ?? '-'} ${result.error}` : result.reason
      await settle({ kind: 'failed', seq, reason: detail })
      return
    }
    const extracted = extractEnglish(result.text)
    if (!extracted.isValid) {
      await settle({ kind: 'failed', seq, reason: extracted.reason })
      return
    }
    await settle({ kind: 'done', seq, english: extracted.english })
  } catch (error) {
    // Only a request the engine refuses to send rejects; show why.
    await settle({ kind: 'failed', seq, reason: String(error) })
  }
}

export const register: Register = on => {
  on('prompt.submit', async ($, e, next) => {
    // Only what the person typed is practice material: at the terminal
    // (composer) or from a phone (bridge). Task notifications, /loop firings,
    // other sessions' messages and slash commands are left alone.
    const isTypedByPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (!isTypedByPerson || e.command || e.isMeta) {
      return next(e)
    }

    const seq = ((await read($, practice))?.seq ?? 0) + 1
    if (e.text.length > MAX_PROMPT_CHARS) {
      await update($, practice, (): Practice => ({ kind: 'skipped', seq, length: e.text.length }))
      return next(e)
    }
    await update($, practice, () => ({ kind: 'translating', seq }))
    // Not awaited: the prompt must not wait for the translation.
    void translate($, seq, e.text)

    // The prompt goes on unchanged: this mod only reads it.
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, practice)
    if (e.props.hasSurvey || current === null) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)

    // Drawn like the spinner's Tip line ("   ⎿ Tip: ..."), so the band reads as
    // part of that block. Idle, there is no spinner to hang from: the glyph
    // goes and the indent stays, so the text does not jump sideways.
    const gutter = e.props.isWorking ? `${' '.repeat(GUTTER_WIDTH - 2)}⎿ ` : ' '.repeat(GUTTER_WIDTH)
    const withGutter = (body: JSX.Element) => (
      // Separate boxes so a wrapped line returns to the text column, not under the glyph.
      <Box flexDirection="row">
        <Box width={GUTTER_WIDTH} flexShrink={0}>
          <Text dimColor>{gutter}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          {body}
        </Box>
      </Box>
    )

    if (current.kind === 'translating') {
      return withGutter(<Text dimColor>英訳中…</Text>)
    }
    if (current.kind === 'skipped') {
      return withGutter(
        <Text dimColor>
          長文のため英訳しませんでした（{current.length.toLocaleString()} 文字）
        </Text>,
      )
    }
    if (current.kind === 'failed') {
      return withGutter(<Text color="red">英訳に失敗しました: {current.reason}</Text>)
    }

    const parsed = parseStress(current.english)
    if (!parsed.isValid) {
      return withGutter(
        <Text color="red">
          英訳の記法が崩れています（{parsed.reason}）: {current.english}
        </Text>,
      )
    }

    return withGutter(
      <Text>
        {parsed.runs.map(run =>
          run.isStressed ? (
            <Text bold color="yellow">
              {run.text}
            </Text>
          ) : (
            run.text
          ),
        )}
      </Text>,
    )
  })
}
