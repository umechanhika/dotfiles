---
name: doc-review
description: >
  マークダウン/HTMLファイルをブラウザでプレビュー表示し、Figmaのように
  見た目の上で直接コメントを付けて、複数まとめてClaudeに送ると、その場で
  ファイルを編集してブラウザに自動反映するスキル。コメントはスレッド化され、
  Claudeの編集方針が各コメントへの返信として表示され、意図と違えば再フィード
  バックでき、解決するまで残る。完全にローカルで完結する（外部送信なし）。
  「/doc-review @ファイル」で起動。
  「このドキュメントにコメントしながら直したい」「mdをプレビューで見て指摘したい」
  「FigmaみたいにHTML/mdにコメントを置いてまとめて直して」といったリクエストや、
  /doc-review が呼ばれたときに使うこと。
---

# doc-review

マークダウン/HTML ファイルをローカルのブラウザでプレビュー表示し、テキスト選択やブロック単位で**Figmaのようにコメント**を付けられる。コメントは**スレッド**（コメント＋やり取り＋解決状態）として扱う:

- 複数コメントを溜めて一括送信 → Claude が該当箇所を編集し、**各コメントに「編集方針」を返信**する。
- 編集が意図と違えば、**同じコメントに再フィードバック**して直し直せる。
- コメントは**ユーザーが「解決」するまで残る**（解決後は折りたたんで保持）。
- スレッドはサーバー側 `threads.json` に永続化され、ページを完全リロードしても消えない。

**完全ローカル**: サーバーは `127.0.0.1` のみにバインドし、レンダラ(marked.js)も同梱。外部通信は一切しない。

## アーキテクチャ

```
ブラウザ(viewer.html + comment.js)
   │  ① /source 取得 → md=marked描画 / html=そのまま表示
   │  ② コメント蓄積(⌘Enter追加) → ⌘⇧Enterで一括送信 → POST /threads/submit
   ▼
serve.py (127.0.0.1, threads.json の唯一の書き手)
   │  threads.json 更新 + inbox.jsonl に1行追記(Monitorトリガ)
   ▼
Claude(メインセッション)
   │  ③ Monitor で inbox.jsonl の新バッチを待受
   │  ④ 各 item の anchor を解決して対象ファイルを Edit
   │  ⑤ serve.py reply で各スレッドに編集方針を返信(HTTP→サーバー)
   ▼
ブラウザが /threads(rev) をポーリング → 返信表示＋ソース再読込（②へ戻る）
```

## 進行手順

### STEP 0: 引数の解釈
- `/doc-review @path` のファイルパスを**絶対パス**に解決（`<SKILL_DIR>` はこの SKILL.md があるディレクトリ）。
- 拡張子が `md` / `markdown` / `html` / `htm` でなければ中断。
- **作業ディレクトリは指定しない**（既定で `~/.claude/doc-review/<対象パスのハッシュ>` を使う。リポジトリ内を汚さず、同じファイルを再度開くと過去スレッドを復元する）。

### STEP 1: サーバーをバックグラウンド起動
Bash を `run_in_background: true` で実行する（`--work-dir` は付けない）:

```bash
python3 <SKILL_DIR>/scripts/serve.py \
  --target <対象ファイルの絶対パス> \
  --skill-dir <SKILL_DIR> \
  --port 5050 \
  --idle-timeout 1800
```

### STEP 2: 起動情報を取得してブラウザを開く
サーバーは起動時に stdout へ `SERVE_URL=...` と `WORK_DIR=...` を出力し、`<WORK_DIR>/server.url` にもURLを書く。URL と WORK_DIR を取得してから:

```bash
open "<SERVE_URL>"
```

ユーザーに「ブラウザでプレビューを開きました。本文を選択/クリックして ⌘Enter でコメント追加、⌘⇧Enter で一括送信してください」と伝える。

### STEP 3: 送信を待受（Monitor）
`references/anchoring.md` を Read で読み込む（anchor 解決ルール）。
**Monitor ツール**（`persistent: true`）で `inbox.jsonl` への新規バッチ追記を待つ:

```bash
mkdir -p <WORK_DIR> && touch <WORK_DIR>/inbox.jsonl && tail -f -n 0 <WORK_DIR>/inbox.jsonl
```

- 1イベント = 1バッチ。`items` に各コメント（`thread_id` / `anchor` / `text` / `is_new`）が入る。

### STEP 4: バッチを処理（編集 → 各スレッドに返信）
新バッチのイベントが届いたら:
1. そのバッチ（最新行）を読む（イベント本文、または `<WORK_DIR>/inbox.jsonl` の末尾行を Read）。
2. 各 item を処理する:
   - `is_new: true` … 新規コメント。`anchor` を `references/anchoring.md` の手順で対象ファイルの該当箇所に解決し、`text` の指示に沿って **Edit** で最小変更する。
   - `is_new: false`（`thread_id` のみ）… **再フィードバック**。そのスレッドの**過去のやり取り（自分の前回返信と前回の編集）を踏まえて**、必要なら前回の編集を調整/取り消し、`text` の指示に沿って直し直す。全文脈が必要なら `curl -s <SERVE_URL>threads` でスレッド一覧を取得。
   - 位置が特定できない item は飛ばさず、何が特定できなかったかを返信で伝える。
3. 処理した**各スレッドについて**、編集方針（何を・なぜそう直したか／特定できなかった旨）をそのコメントへの返信として記録する:

```bash
python3 <SKILL_DIR>/scripts/serve.py reply \
  --target <対象ファイルの絶対パス> \
  --thread-id <item の thread_id> \
  --text "<このコメントへの編集方針・実施内容・理由>"
```

（`reply` は稼働中サーバーへ HTTP POST する。`--target` から既定 work-dir を逆算して `server.url` を読むので、work-dir 指定は不要。）

4. ユーザーに反映の要点を簡潔に伝える。**Monitor は止めず**、次のバッチを待ち続ける（ライブ編集ループ）。

**重要**: スレッドの **resolve（解決）はしない** — 解決はユーザーがブラウザで行う。Claude は編集と `reply` のみ。

### STEP 5: 終了
ユーザーが「終了」等と言ったら、Monitor を **TaskStop** で止め、サーバーを停止する:

```bash
kill "$(cat <WORK_DIR>/server.pid 2>/dev/null)" 2>/dev/null || true
```

（明示終了しなくても、サーバーは 30 分アイドルで自動停止する。`threads.json` は残るので次回起動時に復元される。）

## 注意
- 編集対象は起動時に指定した**単一ファイルのみ**。他のファイルは触らない。
- サーバーは `127.0.0.1` バインド・外部通信なし。viewer の読み込みも `/lib/*` 相対のみ（CDN不使用）。
- 行番号でなく `block_raw` / 選択テキスト＋前後文脈で箇所を特定する（`references/anchoring.md` 参照）。
- 作業ファイル（threads.json/inbox.jsonl/server.*）は `~/.claude/doc-review/` 配下に作られ、対象リポジトリは汚さない。
- ポートが埋まっていれば 5050 から空きポートへ自動フォールバックする（URLは stdout / `server.url` 参照）。
