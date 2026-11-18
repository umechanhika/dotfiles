// What the band shows for the latest submitted prompt.
// `seq` numbers each submission so a slow, older translation never
// overwrites the result for a newer prompt.
export type Practice =
  | { kind: 'translating'; seq: number }
  | { kind: 'done'; seq: number; english: string }
  | { kind: 'failed'; seq: number; reason: string }
  // Too long to send for translation; the band says so instead of staying silent.
  | { kind: 'skipped'; seq: number; length: number }

declare module 'claude-code' {
  interface PluginState {
    'prompt-english': { practice: Practice | null }
  }
}
