---
name: pre-code-review
description: Android (Kotlin/Jetpack Compose) のコードレビューを行う。命名・可読性・設計・アーキテクチャ・コード品質・コメントの観点でレビューし、質問形式・背景添え・実装案提示のスタイルで指摘する。自分が作成したPRの未解決コメントへの対応方針も検討し、結果をmdファイルとして出力する。
---

# コードレビュースキル

このスキルが呼ばれたら、以下の実行フローに従ってコードレビューを実施してください。
引数としてPR番号やファイルが渡された場合はその対象をレビューし、なければ現在のブランチの差分をレビューしてください。

---

## モジュールマップ

詳細はオンデマンドで以下の参照ファイルを読む（このスキルの `references/` 配下。絶対パス例: `/Users/hikaru.umetsu/.claude/skills/pre-code-review/references/`）。コアに無い詳細はここから辿る。

| 責務 | ファイル |
|------|---------|
| レビュー観点（言語・フレームワーク非依存） | `references/review-general.md` |
| レビュー観点（Android/Kotlin/Compose 固有） | `references/review-android.md` |
| サブエージェント詳細仕様（STEP 5b の担当割当 b-1・統合 b-2） | `references/review-subagent-spec.md` |
| 文体・言い回しルール（指摘記述ルール b-3・スタイル原則・優先度判断・STEP 5.5 セルフチェック） | `references/review-style.md` |
| 出力mdテンプレート全文（STEP 6 の出力形式） | `references/review-output-format.md` |
| PRコメント投稿手順・API 詳細・投稿前確認ゲート | `references/review-pr-comment.md` |

---

## 実行フロー

### STEP 1: 現在のブランチのPR確認

```bash
gh pr view --json number,title,url,headRefName,author
```

- PRが存在しない場合 → STEP 3へ（差分のみレビュー）
- PRが存在する場合 → STEP 2へ

### STEP 2: PRの作成者確認（自分のPRかどうか）

```bash
gh api user --jq '.login'
```

取得した `login` と STEP 1 の `author.login` を比較する。

- **自分が作成したPR**: STEP 3・4・5a のみ（未解決コメントへの対応方針のみ。新規指摘は行わない）
- **他者が作成したPR**: STEP 3・5b のみ（新規指摘のみ。STEP 4・5a はスキップ）
- **PRなし**: STEP 3・5b のみ（新規指摘のみ）

### STEP 3: コード差分の取得

```bash
# PRがある場合
gh pr diff {pr_number}

# PRがない場合
git diff origin/main...HEAD
```

### STEP 3.5: パターン検索（構文で識別できる観点の事前確認）

差分に含まれる Kotlin ファイルを対象に、LLM の注意が分散しやすいパターンを grep で機械的に抽出する。
STEP 5b の新規指摘生成時に、この検索結果を必ずインプットとして参照すること。

```bash
# 差分に含まれる Kotlin ファイルを取得
gh pr diff {pr_number} --name-only | grep "\.kt$"

# 各ファイルに対して以下を実行
grep -n "@SuppressLint\|@Suppress(" {file}
grep -n "remember {" {file}
grep -n "DialogProperties" {file}
```

各ヒットに対する判断基準:

| パターン | 確認内容 | 指摘候補になる条件 |
|---------|---------|-----------------|
| `@SuppressLint` / `@Suppress(` | 直前行に `//` コメントがあるか | コメントがない場合 → コードの品質「アノテーションのコメント」として指摘 |
| `remember {` | キーなしで外部の引数（ViewModel・コールバック等）を内部に保持しているか | 保持している場合 → Jetpack Compose「rememberキー指定」として指摘 |
| `DialogProperties` | `dismissOnBackPress` / `dismissOnClickOutside` が明示されているか | 明示なし（デフォルト）かつ旧実装（`isCancelable`）から動作が変わる場合 → 確認事項として指摘 |

### STEP 4: 未解決コメントの取得（自分が作成したPRの場合のみ）

GitHub GraphQL API で未解決のレビュースレッドを取得する：

```bash
gh api graphql -f query='
{
  repository(owner: "{owner}", name: "{repo}") {
    pullRequest(number: {pr_number}) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          id
          comments(first: 10) {
            nodes {
              id
              databaseId
              body
              author { login }
              path
              line
              originalLine
              url
            }
          }
        }
      }
    }
  }
}'
```

`isResolved: false` のスレッドのみ対象とする。
owner と repo は `gh repo view --json owner,name` で取得する。

### STEP 5: レビュー実施

**a. 未解決コメントへの対応検討**（自分が作成したPRの場合のみ）
- 各コメントの内容を読み、差分コードと照らし合わせて対応要否を判断する
- 対応方針と返信案を作成する（後述のスタイル原則に従う）

**b. 差分コードへの新規指摘生成**（他者のPR / PRなしの場合のみ）

観点を3つに分担した**サブエージェントを3つ並行起動**して洗い出し、その結果を親（あなた）が統合する。サブエージェントの担当割当・起動時に渡すプロンプト要件・親による統合手順（b-1/b-2）の詳細は `references/review-subagent-spec.md` を参照。

各指摘の記述ルール（トーン判定、既存コードを引用しない、suggestion は変更行のみ、トーン別の言い回し表、提案→理由の順など）（b-3）の詳細は `references/review-style.md` を参照。サブエージェント・親ともこのルールに従って指摘を整形する。

### STEP 5.5: 出力前セルフチェック

mdファイルを書く前に、生成した各指摘を文体・言い回しのチェックリストで確認する。詳細は `references/review-style.md`（末尾「STEP 5.5: 出力前セルフチェック」）を参照。

### STEP 6: mdファイルの生成・配置

```bash
mkdir -p {カレントディレクトリ}/tmp/review
```

ファイル名: `review_{pr_number}_{title}.md`（PRなしの場合は `review_branch_{YYYYMMDD_HHMMSS}.md`）

`{title}` は `gh pr view --json title --jq '.title'` で取得したPRタイトル文字列をそのまま使う。
ファイル名に使えない文字（`/`・macOS で問題になる `:` など）は `_` に置換する。

後述の出力フォーマットに従いmdファイルを作成し配置する。

### STEP 7: 結果の報告

- 作成したmdファイルのパスをユーザーに伝える
- 未解決コメントがあった場合は件数と対応要否の内訳を簡潔に伝える
- 「コメントを投稿する場合は指示してください」と添える（投稿時は後述の必須ゲートで、最新 md を再読込し全文を表でプレビューしてから承認を得て投稿する）
- PR がない場合（Mode C）は投稿先がないため、md 出力までで完了する

---

## レビュースタイルの原則

このスタイルは **新規指摘コメント** と **未解決コメントへの返信案** の両方に適用する。文体・言い回しルール（優先度に応じた言い回し、提案→理由の順、実装案提示、謙遜の添え方、可能性の提示など12項目の原則）の詳細は `references/review-style.md` を参照。

---

## 未解決コメントへの対応方針の判断基準

| 判断 | 内容 |
|------|------|
| **対応必要** | コメントの指摘が妥当で、差分コードに修正の余地がある |
| **対応不要** | すでに修正済み、仕様上意図的な実装、またはコメントの前提が誤っている |
| **要確認** | コメントの意図が不明確、または判断が難しい |

---

## レビュー観点チェックリスト

レビュー観点は肥大化を避けるため参照ファイルに集約してある。各サブエージェント（b-1）は担当に応じて以下を読むこと。

- **`references/review-general.md`** — 言語・フレームワーク非依存の普遍的観点（命名、可読性、設計原則、コメント、品質、エラーハンドリング、テスト、パフォーマンス、後方互換性、国際化、競合状態、リソース管理、依存ライブラリ、ロギング、エラーメッセージ）
- **`references/review-android.md`** — Android/Kotlin/Compose 固有の観点（Kotlin イディオム、コルーチン・Flow、Jetpack Compose、MVVM/UseCase、リソース/Room、ライフサイクル、メモリリーク、R8、パーミッション、ナビゲーション、アクセシビリティ、テーマ/画面サイズ、Compose 安定性、動作確認エビデンス）

各ファイルの先頭に目次があり、b-1 の担当割当（例: Agent A は general の 3・8・9・11）はこの目次番号に対応する。

---

## レビュー時の優先度判断（内部分類）

指摘を並べる順序と言い回しを決めるための内部判断軸（高＝必須修正／中＝推奨修正／低＝任意／確認のみ）であり、出力にラベルとして書かない。対応する言い回しの一覧は `references/review-style.md`（「レビュー時の優先度判断（内部分類）」）を参照。

---

## 出力形式（mdファイル）

`{カレントディレクトリ}/tmp/review/review_{pr_number}_{title}.md` に所定のテンプレート（PR概要／未解決コメントへの対応方針／新規指摘事項）で出力する。テンプレート全文は `references/review-output-format.md` を参照。

---

## PRへのコメント投稿

ユーザーから「投稿して」「コメントして」「返信して」などの指示があった場合のみ実施する（PR がない Mode C は投稿先がないため対象外）。

投稿は必ず「投稿前の確認と承認（必須ゲート）」を通してから行う。**承認を得るまで投稿 API は実行しない。** 必須ゲートの手順（md を `cat` で読み直す → 投稿方式判定 → 表・全文プレビュー提示 → `AskUserQuestion` で承認）、コメント本文のルール、投稿コマンド（一括投稿 reviews API・追加行コメント・返信・PR全体コメント）の詳細は `references/review-pr-comment.md` を参照。
