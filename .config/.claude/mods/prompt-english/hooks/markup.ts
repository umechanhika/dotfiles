// The model marks each stressed syllable as **SYL**. This splits a line of
// that markup into plain and bold runs for the band to draw.

export type Run = { text: string; isStressed: boolean }

export type ParseResult =
  | { isValid: true; runs: Run[] }
  | { isValid: false; reason: string }

const MARK = '**'

export function parseStress(source: string): ParseResult {
  const parts = source.split(MARK)
  // An even number of parts means an opening ** without its closing one.
  // Drawing it anyway would show the wrong syllables as stressed, so the
  // caller reports it instead.
  if (parts.length % 2 === 0) {
    return { isValid: false, reason: '強勢記号 ** の対応が取れていない' }
  }

  const runs: Run[] = []
  parts.forEach((text, i) => {
    const isStressed = i % 2 === 1
    if (isStressed && text.trim() === '') {
      return
    }
    if (text !== '') {
      runs.push({ text, isStressed })
    }
  })

  return { isValid: true, runs }
}
