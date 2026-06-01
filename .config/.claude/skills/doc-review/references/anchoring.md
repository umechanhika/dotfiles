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
- 処理後は item ごとに `thread_id` を使って返信する（下記「返信」）。

## anchor の種類と解決手順

### markdown ファイル

**`type: "block"`**（ブロックをクリックして付けたコメント）
- フィールド: `block_index`, `block_raw`(そのブロックの生md), `tag`, `text`(表示テキスト), 見出しなら `heading_level` / `heading_text`
- 解決: `block_raw` を**元ファイルから検索**してそのブロックを特定 → 該当ブロック全体に対してコメントを反映。

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

- 1バッチ内の全 item をまとめて読み、関連するものは整合を取りながら編集する。
- 各箇所は Edit ツールで最小変更する。`block_raw` / `outer_html_excerpt` は `old_string` を一意化する手がかりに使える。
- 位置が特定できない item は飛ばさず、何が特定できなかったかを**返信で**伝える。
- 編集で**箇所が動いた/書き換わった/消えた**場合は、返信時にアンカーを更新する（下記「編集後のアンカー更新」）。これを怠ると本文のコメント枠がズレたり消えたりする。
- **再フィードバック**（`is_new: false`）は、そのスレッドの過去メッセージ（自分の前回返信＝前回の編集方針）を踏まえて対応する。前回の編集を取り消す/調整する場合は、現在のファイル内容を Read で確認してから Edit する。

## 返信（reply）

処理した **item ごとに** `thread_id` を使って返信する。これがブラウザで該当コメントへの返信として表示される。

```bash
python3 <SKILL_DIR>/scripts/serve.py reply \
  --target <対象ファイルの絶対パス> \
  --thread-id <item の thread_id> \
  --text "<このコメントへの編集方針・実施内容・理由（特定できなければその旨）>"
```

- `reply` は稼働中サーバーへ HTTP POST する（`threads.json` の書き手はサーバーのみ）。`--target` から既定 work-dir を逆算して `server.url` を読むため work-dir 指定は不要。
- 返信により該当スレッドは `answered` になり、`rev` が増えてブラウザが返信表示＋ソース再読込する。

### 編集後のアンカー更新（重要）

ブラウザはコメント枠を**行番号ではなくブロックの生mdの「内容一致」**で本文に再配置する。だから編集で内容がズレると、**誤った箇所を指さないために枠を出さない**（ユーザーがコメントした場所を取り違えるより、指さない方がよい）。そのため各 item を編集したら、**reply 時にその箇所がどう変わったかを必ず申告する**。`reply` に以下の任意オプションを付ける:

| 箇所がどうなったか | 付けるオプション | 効果 |
|---|---|---|
| **変更・移動した**（ブロックを書き換えた／位置が動いた） | `--anchor-block-raw "<編集後の“そのブロック全文”（生md）>"` | ブラウザはこの内容で枠を再配置（＝変更箇所を指す） |
| **変更した（テキスト選択コメント）** | 上記に加え `--anchor-selected-text "<編集後に対応する新しい語句>"` | 選択語句も更新 |
| **削除した**（その箇所ごと無くした） | `--anchor-gone` | 枠を出さず、サイドバーに「削除されました」と表示 |
| **変わっていない**（位置も内容もそのまま） | 何も付けない | 従来どおり |

```bash
# 例: ブロックを書き換えた場合（変更箇所に枠を追従させる）
python3 <SKILL_DIR>/scripts/serve.py reply \
  --target <対象ファイルの絶対パス> \
  --thread-id t3 \
  --text "ご指摘どおり表現を柔らかくしました" \
  --anchor-block-raw "$(printf '%s' '## 概要

本サービスは〜（編集後のこのブロック全文）')"

# 例: コメント箇所を削除した場合
python3 <SKILL_DIR>/scripts/serve.py reply \
  --target <対象ファイルの絶対パス> \
  --thread-id t5 \
  --text "不要との指摘に従いこの段落を削除しました" \
  --anchor-gone
```

- `--anchor-block-raw` は**差分でなくブロック全文**を渡す（ブラウザは内容の完全一致で照合するため。一部だけでは一致しない）。直前に Edit した結果なので内容は分かるはず。必要なら Read で当該ブロックの最終形を確認する。
- 申告を怠ると、内容がズレたコメント枠が本文から消え、ユーザーが文脈を失う。**編集したら必ず申告**すること。

## 注意

- `target` のファイル以外は編集しない。
- スレッドの **resolve（解決）はしない** — 解決はユーザーがブラウザで行う。Claude は編集と `reply` のみ。
