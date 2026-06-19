#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# post-review.sh — Single-mutation poster for pre-code-review skill
#
# Usage: bash post-review.sh <action> <payload.json>
#
#   action:
#     reviews    — 一括投稿 (gh api /pulls/{pr}/reviews POST)
#     comment    — 追加行コメント (gh api /pulls/{pr}/comments POST)
#     reply      — 未解決スレッドへの返信 (gh api /pulls/comments/{id}/replies POST)
#     pr-comment — PR 全体コメント (gh pr comment)
#
#   payload.json スキーマ:
#     {
#       "owner":      "<org>",
#       "repo":       "<repo>",
#       "pr_number":  <number>,
#       "review":     { "commit_id": "...", "body": "", "event": "COMMENT",
#                       "comments": [ { "path": "...", "line": <n>, "side": "RIGHT", "body": "..." } ] },
#       "comment":    { "body": "...", "path": "...", "line": <n>, "side": "RIGHT", "commit_id": "..." },
#       "reply":      { "comment_id": <databaseId>, "body": "..." },
#       "pr_comment": { "body": "..." }
#     }
#     action に対応するキーのみ必須（他は省略可）。
#     reviews の複数行範囲は各 comment に "start_line"/"start_side" を追加。
#
# MUTATION — スキルの必須承認ゲート（md 全文プレビュー＋AskUserQuestion 承認）を
#            通過した後にのみ実行される前提。フォールバック禁止: gh のエラーをそのまま
#            出力して非ゼロ終了する。
#
# 環境変数:
#   POST_REVIEW_DRY_RUN=1  実 POST せず解決後のエンドポイント＋ペイロードを出力（検証用）
# =============================================================================

ACTION="${1:?action required (reviews|comment|reply|pr-comment)}"
PAYLOAD="${2:?payload json path required}"

[[ -f "$PAYLOAD" ]] || { echo "ERROR: payload not found: $PAYLOAD" >&2; exit 1; }

# jq の存在確認（エラーを明示する）
command -v jq >/dev/null 2>&1 || { echo "ERROR: jq is required but not installed." >&2; exit 1; }
command -v gh  >/dev/null 2>&1 || { echo "ERROR: gh is required but not installed." >&2; exit 1; }

OWNER=$(jq -r '.owner' "$PAYLOAD")
REPO=$(jq -r '.repo'   "$PAYLOAD")
PR=$(jq -r '.pr_number' "$PAYLOAD")

[[ "$OWNER" == "null" ]] && { echo "ERROR: .owner is missing in payload" >&2; exit 1; }
[[ "$REPO"  == "null" ]] && { echo "ERROR: .repo is missing in payload"  >&2; exit 1; }
[[ "$PR"    == "null" ]] && { echo "ERROR: .pr_number is missing in payload" >&2; exit 1; }

# -----------------------------------------------------------------------------
# action ごとにエンドポイントと jq フィルタを決定
# action 不一致は即エラー（フォールバックなし）
# -----------------------------------------------------------------------------
ENDPOINT=""
BODY_FILTER=""

case "$ACTION" in
  reviews)
    ENDPOINT="/repos/$OWNER/$REPO/pulls/$PR/reviews"
    BODY_FILTER='.review'
    ;;
  comment)
    ENDPOINT="/repos/$OWNER/$REPO/pulls/$PR/comments"
    BODY_FILTER='.comment'
    ;;
  reply)
    CID=$(jq -r '.reply.comment_id' "$PAYLOAD")
    [[ "$CID" == "null" ]] && { echo "ERROR: .reply.comment_id is missing in payload" >&2; exit 1; }
    ENDPOINT="/repos/$OWNER/$REPO/pulls/comments/$CID/replies"
    BODY_FILTER='{body: .reply.body}'
    ;;
  pr-comment)
    # gh pr comment はエンドポイント方式ではないため特殊処理
    ENDPOINT="(gh pr comment)"
    BODY_FILTER='{body: .pr_comment.body}'
    ;;
  *)
    echo "ERROR: unknown action: $ACTION. Valid actions: reviews|comment|reply|pr-comment" >&2
    exit 1
    ;;
esac

# -----------------------------------------------------------------------------
# DRY_RUN モード: 実 POST なしでエンドポイント＋ペイロードを標準出力（検証用）
# -----------------------------------------------------------------------------
if [[ "${POST_REVIEW_DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN action=$ACTION endpoint=$ENDPOINT"
  echo "--- payload body ---"
  jq "$BODY_FILTER" "$PAYLOAD"
  exit 0
fi

# -----------------------------------------------------------------------------
# 実行: action ごとに「ちょうど 1 回」の書き込みを実行
# -----------------------------------------------------------------------------
if [[ "$ACTION" == "pr-comment" ]]; then
  BODY=$(jq -r '.pr_comment.body' "$PAYLOAD")
  [[ "$BODY" == "null" ]] && { echo "ERROR: .pr_comment.body is missing in payload" >&2; exit 1; }
  gh pr comment "$PR" --repo "$OWNER/$REPO" --body "$BODY"
else
  jq "$BODY_FILTER" "$PAYLOAD" | gh api "$ENDPOINT" --method POST --input -
fi
