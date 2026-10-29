import type { Register } from 'claude-code'

const PANE = 'vim-cheatsheet'
const TITLE = 'Vim チートシート'
const KEY_WIDTH = 12
const COLUMN_WIDTH = 50
// Tall enough for the two-column layout; the inline pane defaults to a third
// of the screen, which cuts off the later sections.
const PANE_ROWS = 14

// [key, meaning] pairs per section, kept short to fit a narrow pane.
// Meanings are Japanese: each character takes two cells.
const SECTIONS: { title: string; rows: [string, string][] }[] = [
  {
    title: 'モード切替',
    rows: [
      ['Esc', 'ノーマルモードに戻る'],
      ['i / a', 'カーソルの前 / 後ろから入力'],
      ['I / A', '行頭 / 行末から入力'],
      ['o / O', '下 / 上に新しい行を作って入力'],
    ],
  },
  {
    title: '移動（ノーマル）',
    rows: [
      ['h j k l', '左 / 下 / 上 / 右'],
      ['w / b / e', '次の単語 / 前の単語 / 単語の末尾'],
      ['0 / ^ / $', '行頭 / 最初の文字 / 行末'],
      ['gg / G', '先頭の行 / 最後の行'],
      ['f{文字}', '行内のその文字まで飛ぶ'],
    ],
  },
  {
    title: '編集（ノーマル）',
    rows: [
      ['x', '1 文字消す'],
      ['dw / dd / D', '単語 / 行 / 行末まで消す'],
      ['cw / cc / C', '単語 / 行 / 行末まで消して入力'],
      ['ciw', 'カーソル上の単語を丸ごと書き換え'],
      ['yy / p / P', '行をコピー / 後ろ / 前に貼る'],
      ['u', '取り消し'],
      ['.', '直前の変更をくり返す'],
    ],
  },
  {
    // The rule lives in the title so every row fits on one line.
    title: '回数指定（数字を前に付けると回数分くり返す）',
    rows: [['2dw', '2 単語消す']],
  },
]

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'vim-cheat',
      description: 'Vim チートシートのペインを開く / 閉じる',
    })

    return next(e)
  })

  on('command.run', { command: 'vim-cheat' }, async $ => {
    const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Vim チートシートを閉じました。' }
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE, rows: PANE_ROWS })
    if (!opened.isPlaced) {
      return { text: `Vim チートシートを表示できませんでした: ${opened.reason}` }
    }

    return { text: 'Vim チートシートを開きました。もう一度 /vim-cheat で閉じます。' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const width = e.viewport?.columns ?? COLUMN_WIDTH
    const columnCount = Math.max(1, Math.min(2, Math.floor(width / COLUMN_WIDTH)))
    // Split sections into columns in order, keeping each section whole.
    const perColumn = Math.ceil(SECTIONS.length / columnCount)
    const columns = Array.from({ length: columnCount }, (_, i) =>
      SECTIONS.slice(i * perColumn, (i + 1) * perColumn),
    )

    return (
      <Box flexDirection="row">
        {columns.map(sections => (
          <Box flexDirection="column" width={COLUMN_WIDTH}>
            {sections.map(section => (
              <Box flexDirection="column" marginBottom={1}>
                <Text bold>{section.title}</Text>
                {section.rows.map(([key, meaning]) => (
                  // Separate boxes instead of padEnd: padEnd counts a
                  // full-width character as one cell, and a wrapped meaning
                  // would otherwise return to the key column.
                  <Box flexDirection="row">
                    <Box width={KEY_WIDTH} flexShrink={0}>
                      <Text color="cyan">{key}</Text>
                    </Box>
                    <Box width={COLUMN_WIDTH - KEY_WIDTH}>
                      <Text>{meaning}</Text>
                    </Box>
                  </Box>
                ))}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })
}
