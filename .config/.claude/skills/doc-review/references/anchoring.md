# コメント → 元ソースの紐付けルール

ブラウザから送られてくる各コメントは `anchor` を持つ。`anchor` から**元ファイルの該当箇所**を特定し、ユーザーのコメント内容に沿って編集する。行番号は使わない（プレビューはレンダリング後DOMで、ソース行と1:1でないため）。

## inbox のバッチ形式

`inbox.jsonl` は1行1バッチ。各行:

```json
{
  "batch_id": "20260529-112233-001",
  "ts": "2026-05-29T11:22:33",
  "target": "/abs/path/to/file.md",
  "work_dir": "/Users/.../.claude/doc-review/file.md-<hash>",
  "items": [
    { "thread_id": "t1", "anchor": { ... }, "text": "ここの表現を柔らかく", "is_new": true },
    { "thread_id": "t2", "anchor": { ... }, "text": "この見出しは不要",     "is_new": true }
  ]
}
```

- `is_new: true` … 新規コメント。`anchor` を解決して編集する。
- `is_new: false` … 既存スレッドへの**再フィードバック**（`thread_id` で識別）。前回の編集が意図と違った等の追加指示。スレッドの過去のやり取りを踏まえて直し直す。全文脈は `curl -s <SERVE_URL>threads` で取得できる。
- 処理後はバッチ内の全 item をまとめて1回の返信送信にする（下記「返信」）。

## anchor の種類と解決手順

### markdown ファイル

**`type: "block"`**（ブロックをクリックして付けたコメント）
- フィールド: `block_index`, `block_raw`(そのブロックの生md), `tag`, `text`(表示テキスト), 見出しなら `heading_level` / `heading_text`
- 解決: `block_raw` を**元ファイルから検索**してそのブロックを特定 → 該当ブロック全体に対してコメントを反映。
- ファイル**先頭の frontmatter**（`---` で始まり `---` で閉じるメタデータ）はプレビュー上で区切りの `---` 込みの1ブロックとして扱われる。そこへのコメントの `block_raw` は `---` 行を含む全文になる。
- **箇条書きの1項目**へのコメントは、その項目1つ分（先頭の `-`/`1.` などの記号を含む生md。入れ子リストを持つ項目はその入れ子部分も含む）が `block_raw` になる。リスト全体へのコメントも別に成立する（`block_raw` はリスト全体の生md）。

**`type: "cell"`**（表のセルをクリックして付けたコメント）
- フィールド: `block_index`, `block_raw`(そのセルが属する**行の生md1行分**。セル自体の生mdではない), `table_raw`(表全体の生md), `row`(0始まりの行番号。見出し行は`-1`), `col`(0始まりの列番号), `section`(`"header"` または `"body"`), `header_text`(その列の見出しテキスト), `tag`, `text`(表示テキスト)
- 解決手順:
  1. `table_raw` で元ファイル中の対象の表を特定する。
  2. `block_raw` はその表の中で `row`/`section` が指す行の生md1行分（ヘッダ行なら1行目、区切り行を除いたデータ行なら`row`番目）。
  3. その行を `|` で列に分割し（エスケープされた `\|` は区切りとして数えない）、`col` 番目のセルが対象。`header_text` で列を照合して検算する。
- 表全体（帯部分をクリック）へのコメントは `type: "block"`（`tag` が `"div"` になる点に注意）。`block_raw` は表全体の生md。

**`type: "range"`**（テキストをドラッグ選択して付けたコメント）
- フィールド: `selected_text`(選択した可視テキスト), `block_index`, `block_raw`, `prefix`, `suffix`(選択前後の可視テキスト各〜30字), `occurrence`(ブロック内で何番目の一致か, 0始まり)
- 解決手順:
  1. `block_raw` を元ファイルから検索し、対象ブロックの範囲を絞る。
  2. ブロック内で `prefix + selected_text + suffix` の並びを探して正確な位置を確定する（mdの記法文字が間に入る場合は `selected_text` の語句一致を優先）。
  3. 同じ `selected_text` が複数あるときは `occurrence` 番目を選ぶ。
  4. 0件のときは（直前の編集でズレた可能性）`selected_text` 単体で探す。それでも曖昧なら**勝手に決めずユーザーに確認**する。

### HTML ファイル

**`type: "element"`**（要素クリック）
- フィールド: `tag`, `css_path`(例 `body > section > h2:nth-of-type(2)`), `text`, `outer_html_excerpt`
- 解決: `outer_html_excerpt` の特徴的な文字列を元htmlから検索して要素を特定（`css_path` は構造の補助情報）。

**`type: "range"`**（テキスト選択）
- フィールド: `selected_text`, `css_path`, `outer_html_excerpt`, `prefix`, `suffix`, `occurrence`
- 解決: `outer_html_excerpt` で近傍要素を特定 → `prefix + selected_text + suffix` で箇所確定 → 複数一致は `occurrence`。

## 編集の進め方

- 1バッチ内の全 item をまとめて読み、関連するものは整合を取りながら編集する。**item を分割して並列に編集してはならない** — 編集対象は単一ファイル固定で、アンカー解決は編集前の内容一致に依存するため、同時編集は互いの位置特定を壊す。編集後のアンカー申告（下記）も、他の編集が並行していると申告時点で内容が古くなり、コメント枠が本文から消える原因になる。
- 各箇所は Edit ツールで最小変更する。`block_raw` / `outer_html_excerpt` は `old_string` を一意化する手がかりに使える。
- 位置が特定できない item は飛ばさず、何が特定できなかったかを**返信で**伝える。
- 編集で**箇所が動いた/書き換わった/消えた**場合は、返信時にアンカーを更新する（下記「編集後のアンカー更新」）。これを怠ると本文のコメント枠がズレたり消えたりする。
- **再フィードバック**（`is_new: false`）は、そのスレッドの過去メッセージ（自分の前回返信＝前回の編集方針）を踏まえて対応する。前回の編集を取り消す/調整する場合は、現在のファイル内容を Read で確認してから Edit する。

## 返信（reply / reply-batch）

処理した**バッチ内の全スレッド**を、`thread_id` を使ってまとめて返信する。これがブラウザで該当コメントへの返信として表示される。

- **2件以上** … `reply-batch` に返信オブジェクトの配列を JSON ファイルで渡し、**1回のリクエストにまとめる**:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/serve.py" reply-batch \
  --target <対象ファイルの絶対パス> \
  --file <WORK_DIR>/replies-<batch_id>.json
```

`replies-<batch_id>.json`（配列の各要素が1スレッド分の返信。`anchor_update` は任意）:

```json
[
  { "thread_id": "t3", "text": "<編集方針・実施内容・理由>",
    "anchor_update": { "block_raw": "<編集後のそのブロック全文(生md)>" } },
  { "thread_id": "t5", "text": "<削除した旨>",
    "anchor_update": { "gone": true } },
  { "thread_id": "t7", "text": "<箇所が変わっていない場合はこれだけ>" }
]
```

`reply-batch` は**全件を検証してから全件を適用する**（all-or-nothing）。存在しない `thread_id` や空文字列の `text` が1件でもあれば、バッチ全体が失敗し**何も反映されない**（エラーメッセージにどの要素が不正かが出る）。

- **1件のみ** … ファイル作成の往復が無駄なので、`reply` を CLI オプションで使う:

```bash
python3 "${CLAUDE_SKILL_DIR}/scripts/serve.py" reply \
  --target <対象ファイルの絶対パス> \
  --thread-id <item の thread_id> \
  --text "<このコメントへの編集方針・実施内容・理由（特定できなければその旨）>"
```

- どちらも稼働中サーバーへ HTTP POST する（`threads.json` の書き手はサーバーのみ）。`--target` から既定 work-dir を逆算して `server.url` を読むため work-dir 指定は不要。
- 返信により該当スレッドは `answered` になり、`rev` が増えてブラウザが返信表示＋ソース再読込する（`reply-batch` は複数スレッド分をまとめても `rev` の増分は1）。

### 編集後のアンカー更新（重要）

ブラウザはコメント枠を**行番号ではなくブロックの生mdの「内容一致」**で本文に再配置する。だから編集で内容がズレると、**誤った箇所を指さないために枠を出さない**（ユーザーがコメントした場所を取り違えるより、指さない方がよい）。そのため各 item を編集したら、**返信時にその箇所がどう変わったかを必ず申告する**。`anchor_update`（`reply-batch` の各要素、または `reply` の `--anchor-*` オプション）に以下を指定する:

| 箇所がどうなったか | `anchor_update` に入れる内容 | `reply` の対応オプション | 効果 |
|---|---|---|---|
| **変更・移動した**（ブロックを書き換えた／位置が動いた） | `{"block_raw": "<編集後の“そのブロック全文”（生md）>"}` | `--anchor-block-raw` | ブラウザはこの内容で枠を再配置（＝変更箇所を指す） |
| **変更した（テキスト選択コメント）** | 上記に加え `"selected_text": "<編集後に対応する新しい語句>"` | 上記に加え `--anchor-selected-text` | 選択語句も更新 |
| **削除した**（その箇所ごと無くした） | `{"gone": true}` | `--anchor-gone` | 枠を出さず、サイドバーに「削除されました」と表示 |
| **変わっていない**（位置も内容もそのまま） | `anchor_update` を省略 | 何も付けない | 枠はそのままの位置に表示 |

**箇条書きの1項目**を書き換えた場合は、`block_raw` に**その項目1つ分の生md**（先頭の記号込み。入れ子リストがあればそれも含む）を渡す。リスト全体の生mdを渡さない — 項目単位のブロックとリスト全体のブロックは別物として扱われる。

**表のセル**を書き換えた場合は、`block_raw` に**そのセルが属する行（編集後）の生md1行分**を渡す。加えて `table_raw`(表全体の編集後の生md)・`row`・`col`・`section`・`header_text` も渡す（`reply` なら `--anchor-table-raw` / `--anchor-row` / `--anchor-col` / `--anchor-section` / `--anchor-header-text`）。1つのセルを書き換えると**同じ行の他のセル**と**その表全体へのコメント**の `block_raw`/`table_raw` も変わるため、それらのスレッドにも同様に `anchor_update` を送る。列や行を増減した場合は `row`/`col` も編集後の値に更新する。

```json
[
  { "thread_id": "t3", "text": "ご指摘どおり表現を柔らかくしました",
    "anchor_update": { "block_raw": "## 概要\n\n本サービスは〜（編集後のこのブロック全文）" } },
  { "thread_id": "t5", "text": "不要との指摘に従いこの段落を削除しました",
    "anchor_update": { "gone": true } }
]
```

- `block_raw` は**差分でなくブロック全文**を渡す（ブラウザは内容の完全一致で照合するため。一部だけでは一致しない）。直前に Edit した結果なので内容は分かるはず。必要なら Read で当該ブロックの最終形を確認する。

## 注意

- `target` のファイル以外は編集しない。
- スレッドの **resolve（解決）はしない** — 解決はユーザーがブラウザで行う。Claude は編集と `reply` / `reply-batch` のみ。
