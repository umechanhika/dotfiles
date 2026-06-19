# PRへのコメント投稿

ユーザーから「投稿して」「コメントして」「返信して」などの指示があった場合のみ実施する（PR がない Mode C は投稿先がないため対象外）。

投稿は必ず下記「投稿前の確認と承認（必須ゲート）」を通してから行う。**承認を得るまで投稿 API は実行しない。** これがこの投稿フローの中核となる不変条件である。

## 投稿前の確認と承認（必須ゲート）

「投稿して」の指示を受けても、いきなり API を呼ばない。次の手順で投稿予定の内容を提示し、`AskUserQuestion` で承認を得てから投稿する。`pre-commit-leak-check` の承認ゲートと同じ考え方で、版ズレ（ユーザー編集の取りこぼし）・誤投稿・重複投稿を投稿前に止めるための関門である。

### 手順

1. **md をディスクから読み直す（必須・直前。`cat` を使う）**
   コンテキストに残っている版を信用せず、対象の md ファイル（STEP 6 で出力したもの）の**ディスク実体を `cat` で読み直す**。以降の表・本文・API ペイロードは、この `cat` で得た内容からのみ組み立てる。パスに `[ ] ( )` などシェルのグロブ文字が含まれることがあるため、必ずダブルクォートで囲む。

   ```bash
   cat -n "{mdの絶対パス}"
   ```

   **なぜ Read ではなく `cat` を使うのか（このゲートの肝）:**
   Read ツールは「同一セッションで既に読んだファイルは変わっていない」と判断すると `Wasted call — file unchanged since your last Read` を返し、**ディスクの最新バイトではなくコンテキスト上の古い版に居座らせる**ことがある。md は生成後にユーザーが IDE で編集（指摘の削除・文面修正）するのが想定運用で、その編集を Read が取りこぼすと、まさにこのゲートが防ごうとしている版ズレ（削除したはずの指摘を投稿してしまう等）がそのまま起きる。`cat` はキャッシュ判定を介さずディスクのバイトをそのまま返すため、外部編集を確実に拾える。**ここは「専用ツール（Read）では目的を達成できない」ことが分かっている場面なので、`cat` の使用が正当化される**（通常 `cat` より専用ツールを優先する原則の例外）。

   - レビュー生成後にユーザーが編集している前提で読む。特に system-reminder に「opened/編集中/modified」が出ている場合は省略せず `cat` で実体を確認する。
   - `cat` の内容がコンテキスト上の記憶と食い違ったら、**必ず `cat` の内容を正**として扱い、表・全文プレビュー・ペイロードを作り直す。記憶側を優先しない。

2. **本文は md から逐語で組み立てる**
   投稿する本文は再 Read した md のテキストを**そのまま使う（要約・言い換え・再生成をしない）**。以前に書いた JSON などの中間生成物は再利用しない（古い版の混入を防ぐ）。必要なら現在の md から作り直す。

3. **投稿方式を判定する**
   最新のコミットSHAと差分ハンクを取得し、各指摘の行が差分内かを確認する。

   ```bash
   gh pr view {pr_number} --json headRefOid --jq '.headRefOid'
   gh pr diff {pr_number} | grep "^@@"
   ```

   GitHub REST API の行コメントは差分ハンクに含まれる行（変更行＋前後のコンテキスト行）にしか投稿できない。
   - 行が差分内 → `インライン`
   - 行が差分外、または行を特定できない → `PRコメント(行特定不可)`（承認時に PR 全体コメントとして投稿する）

   `suggestion` を含む指摘は、suggestion の行数とコメント紐付け行範囲を一致させる（1行の修正は `line` のみ、連続複数行は `start_line`〜`line`）。一致していなければこの時点で直す。

4. **表を提示する**（投稿対象の索引。再 Read した md から生成する）

   新規指摘（他者PR・Mode B）の場合:

   ```
   ## 投稿内容の確認（新規指摘 N 件）

   | # | ファイル | 行 | 投稿方式 | 指摘内容（冒頭） |
   |---|---------|----|---------|----------------|
   | 1 | path/to/A.kt | 42 | インライン | 共通関数に切り出す形はいかがでしょうか？… |
   | 2 | path/to/B.kt | - | PRコメント(行特定不可) | … |
   ```

   未解決コメントへの返信（自PR・Mode A）の場合:

   ```
   ## 投稿内容の確認（返信 N 件）

   | # | ファイル:行 | 元コメント(@author) | 対応要否 | 返信内容（冒頭） |
   |---|------------|--------------------|---------|----------------|
   | 1 | A.kt:42 | @reviewer: … | 対応必要 | …という対応をしようと思いますが… |
   ```

   - 行は単一行または `start-line`、特定できない場合は `-`。投稿方式は `インライン` か `PRコメント(行特定不可)` のいずれか。
   - 「冒頭」列は一覧用の要約（1文程度、長ければ `…`）。**正確な内容は必ず次の全文プレビューで確認する**（要約だけで承認させない）。

5. **投稿プレビュー（全文）を提示する**
   表の直後に、各指摘について**実際に投稿する本文の全文**を提示する。suggestion ブロックがあればそれも含める。これが版ズレに気づくための関門で、表＝索引、プレビュー＝全文確認の役割分担になる。

   ```
   ### 投稿プレビュー（全文）

   #### 1. path/to/A.kt:42 [インライン]
   {md の該当本文そのまま}

   #### 2. path/to/B.kt [PRコメント(行特定不可)]
   {md の該当本文そのまま}
   ```

6. **確認文を添える**

   ```
   👆 上記の全文で投稿します。最新の md（再読込済み）と一致しているか、特にご自身で編集した箇所を確認してください。
   ```

7. **`AskUserQuestion` で承認を得る（必須）**
   次の3択を提示する（または同等の選択肢提示）。**承認を得るまで投稿 API は実行しない。**

   1. **承認して投稿**（推奨）: 表・全文プレビューのとおり投稿する。
   2. **一部修正して投稿**: 修正対象の番号と修正内容（文面の修正／行の修正／指摘の削除）を指定してもらう。適用後、**md ファイルも同じ内容に更新**し、手順1（md を `cat` でディスクから読み直す）からやり直して表・全文プレビューを再提示し、再度この承認を取る（承認が出るまでループ）。行を直した場合は投稿方式を再判定する。
   3. **非承認（投稿しない）**: 投稿せずに終了する。md ファイルは残す。

8. **投稿を実行する（承認後のみ）**
   `post-review.sh` を使って投稿する。インライン＝`reviews`、追加行コメント＝`comment`、返信＝`reply`、`PRコメント(行特定不可)`＝`pr-comment`。

   **a. ペイロード JSON を組み立て Write ツールで書き出す**

   `tmp/review/.ctx/post-payload.json` に承認済み内容を Write する（`Write(**/tmp/review/**)` で許可済み）。スキーマ:
   ```json
   {
     "owner": "{owner}",
     "repo": "{repo}",
     "pr_number": {pr_number},
     "review": {
       "commit_id": "{コミットSHA}",
       "body": "",
       "event": "COMMENT",
       "comments": [
         { "path": "{ファイルパス}", "line": {行番号}, "side": "RIGHT", "body": "{コメント本文}" }
       ]
     },
     "comment":    { "body": "...", "path": "...", "line": {n}, "side": "RIGHT", "commit_id": "..." },
     "reply":      { "comment_id": {databaseId}, "body": "..." },
     "pr_comment": { "body": "..." }
   }
   ```
   action に対応するキーのみ必須（他は省略可）。複数行範囲は各 comment に `"start_line"`/`"start_side": "RIGHT"` を追加。

   **b. スクリプトを 1 回だけ実行する**
   ```bash
   bash ~/.claude/skills/pre-code-review/scripts/post-review.sh <action> tmp/review/.ctx/post-payload.json
   ```
   スクリプトは 1 コマンド = 1 回の POST のみ実行する。複数コメントは一括投稿（`reviews` action）に束ねることで 1 呼び出しにまとめる。フォールバックなしで、失敗時は非ゼロ終了してエラーを出力する。

   **c. 二重投稿の回避**
   投稿が失敗したように見えても、**再実行する前に `gh pr view {pr_number} --comments` 等で既に投稿されていないかを確認**してから再試行する。

## コメント本文のルール

md・GitHub とも**重要度ラベル（`【推奨修正】` 等）は付けない**。指摘の内容と言い回しだけでトーンは伝わるため、記号や太字ラベルはノイズになる。
md ファイルの本文をそのまま GitHub コメントとして投稿してよい。

## 新規指摘の一括投稿（主フロー）

GitHub Web UI の「レビュー開始→複数コメント→まとめて送信」と同等の投稿を行う。
最新のコミットSHAを取得してから投稿する（手順 3 で実施済みの場合は再利用してよい）：

```bash
# コミットSHAの取得（読み取り・allow 済み）
gh pr view {pr_number} --json headRefOid --jq '.headRefOid'
```

（投稿方式の判定〔差分ハンク内かどうか〕と suggestion 紐付け範囲の確認は、上記「投稿前の確認と承認（必須ゲート）」の手順3で実施済み。以下は承認後に実行する投稿手順。）

**一括投稿のペイロード例:**
```json
{
  "owner": "{owner}", "repo": "{repo}", "pr_number": {pr_number},
  "review": {
    "commit_id": "{コミットSHA}",
    "body": "",
    "event": "COMMENT",
    "comments": [
      { "path": "{ファイルパス}", "line": {行番号}, "side": "RIGHT", "body": "{コメント本文（ラベルなし）}" }
    ]
  }
}
```

複数行範囲は各 comment に `"start_line": {開始行番号}`, `"start_side": "RIGHT"` を追加（`line` は終了行）。
`body`（レビュー全体コメント）はデフォルト空文字列。ユーザーが明示した場合のみ指定テキストを使用。

```bash
bash ~/.claude/skills/pre-code-review/scripts/post-review.sh reviews tmp/review/.ctx/post-payload.json
```

## 追加の行コメント（一括投稿後の個別追加）

**ペイロード例:**
```json
{
  "owner": "{owner}", "repo": "{repo}", "pr_number": {pr_number},
  "comment": {
    "body": "{コメント内容}",
    "path": "{ファイルパス}",
    "line": {行番号},
    "side": "RIGHT",
    "commit_id": "{コミットSHA}"
  }
}
```

```bash
bash ~/.claude/skills/pre-code-review/scripts/post-review.sh comment tmp/review/.ctx/post-payload.json
```

## 未解決コメントへの返信

**ペイロード例:**
```json
{
  "owner": "{owner}", "repo": "{repo}", "pr_number": {pr_number},
  "reply": { "comment_id": {comment_database_id}, "body": "{返信内容}" }
}
```

```bash
bash ~/.claude/skills/pre-code-review/scripts/post-review.sh reply tmp/review/.ctx/post-payload.json
```

## PR全体へのコメント

**ペイロード例:**
```json
{
  "owner": "{owner}", "repo": "{repo}", "pr_number": {pr_number},
  "pr_comment": { "body": "{コメント}" }
}
```

```bash
bash ~/.claude/skills/pre-code-review/scripts/post-review.sh pr-comment tmp/review/.ctx/post-payload.json
```

投稿後は投稿結果のURLをユーザーに伝える。
