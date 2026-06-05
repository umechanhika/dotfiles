---
name: context-review-apply
description: >-
  保留中のトークン削減提案（context-cost reviewer が生成）を確認し、人の承認のもとで
  適用する。トリガー例: 「コンテキストレビューを適用」「トークン削減の提案を見せて」
  「context review の保留を確認」「溜まった改善案を処理したい」。提案の提示・採否の確認・
  該当リポジトリへの適用・却下指紋の追記を行う。提案の自動適用は決して行わない。
---

# Context Review 適用スキル

reviewer が `pending/` に溜めた提案を、人の承認を得て適用する。**自動適用は禁止**。

## 1. 現在地の解決

- `git rev-parse --show-toplevel` で現在のリポジトリルートを得る（無ければグローバルのみ対象）。
- `git remote get-url origin` を sha1 で12桁にした値が `repo_id`（gate と同じ規則）。

## 2. 保留提案の収集

次の2か所の `pending/*.md` を読む:
- グローバル: `~/.claude/context-reviews/pending/`
- 現在リポジトリ: `<repo_root>/.claude/context-reviews/pending/`

各提案の frontmatter（scope, repo_id, mechanism, est_reduction_tokens）と「何が無駄か」の
要約を、**推定削減量の大きい順**に簡潔な一覧で提示する（1件1〜2行）。

## 3. スコープ整合チェック

- `scope: repo` の提案は、その提案が置かれているリポジトリ内でのみ適用可能。
- グローバル提案で `repo_id` が現在地と異なる場合は、
  「これは別リポジトリ(repo_name)向けです。適用するにはそのリポジトリで実行してください」と案内し、
  ここでは適用しない。
- 適用先が現在地と一致する提案だけを「今すぐ適用可能」として示す。

## 4. 採否の確認（1件ずつ）

ユーザーが選んだ提案について、本文（診断・改善案ドラフト・検証方法）を全文表示し、
**採用 / 不採用** を尋ねる（質問は1つ）。承認なしに次へ進まない。

## 5a. 採用された場合

- 提案本文のドラフトに従い、**正しいプロジェクト内で**変更を適用する
  （CLAUDE.md の編集、`.claude/settings.json` への hook 追加、前処理スクリプトの設置、
  不要 MCP の無効化 など）。
- 注意: 「CLAUDE.md をスリム化」系の提案を適用する時は、**実際に行数を減らす**こと
  （追記して肥大させない。削減が目的）。
- 適用後、何をどう変えたかを簡潔に報告し、検証方法（/context, /usage 等）を添える。
- 当該提案ファイルを削除する（処理済み）。

## 5b. 不採用の場合

- **却下指紋を1行追記**する。形式: `<YYYY-MM-DD> | <mechanism> | <対象の短い記述>`。
  - `scope: repo` なら `<repo_root>/.claude/context-reviews/rejected-fingerprints.txt`
  - `scope: global` なら `~/.claude/context-reviews/rejected-fingerprints.txt`
- これにより reviewer が同種の案を再提案しなくなる。
- 当該提案ファイルを削除する。

## 厳守

- ユーザーの明示的な承認なしに、いかなる変更も適用しない。
- 提案のリポジトリと現在地が一致しない限り適用しない。
- 不採用時は必ず却下指紋を残してから削除する（再提案の抑制のため）。
