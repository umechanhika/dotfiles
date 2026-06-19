#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# gather-context.sh — Read-only context collector for pre-code-review skill
#
# Usage: bash /path/to/gather-context.sh [PR_NUMBER]
#
# Outputs a structured manifest to stdout. Side-effects (reads only — no mutations):
#   - $PWD/tmp/review/.ctx/diff.patch       (always)
#   - $PWD/tmp/review/.ctx/threads.json     (self mode only)
#   - $PWD/tmp/review/                      (dir created for skill STEP 6 output)
# =============================================================================

PR_ARG="${1:-}"
CTX_DIR="$PWD/tmp/review/.ctx"

# -----------------------------------------------------------------------------
# 1. Verify gh authentication
#    Distinguishes auth/network errors from the legitimate "no PR on branch" state.
# -----------------------------------------------------------------------------
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: gh is not authenticated. Run 'gh auth login' first." >&2
  exit 1
fi

# -----------------------------------------------------------------------------
# 2. Resolve repository info
# -----------------------------------------------------------------------------
REPO_JSON=$(gh repo view --json owner,name)
REPO_OWNER=$(echo "$REPO_JSON" | jq -r '.owner.login')
REPO_NAME=$(echo "$REPO_JSON"  | jq -r '.name')

# -----------------------------------------------------------------------------
# 3. Resolve current GitHub user (read-only: gh api user)
# -----------------------------------------------------------------------------
CURRENT_USER=$(gh api user --jq '.login')

# -----------------------------------------------------------------------------
# 4. Resolve PR metadata
#    - Explicit PR_ARG: fail loudly if not found (no fallback).
#    - No arg: try current branch; "no PR" is a legitimate branch state.
# -----------------------------------------------------------------------------
PR_JSON=""
PR_NUMBER=""
PR_TITLE=""
PR_URL=""
PR_HEAD=""
PR_AUTHOR=""

if [[ -n "$PR_ARG" ]]; then
  # Explicit PR number: non-zero exit = hard error
  if ! PR_JSON=$(gh pr view "$PR_ARG" --json number,title,url,headRefName,author 2>&1); then
    echo "ERROR: Could not fetch PR #${PR_ARG}:" >&2
    echo "$PR_JSON" >&2
    exit 1
  fi
else
  # Auto-detect from current branch; suppress error if no PR exists
  PR_JSON=$(gh pr view --json number,title,url,headRefName,author 2>/dev/null) || true
fi

if [[ -n "$PR_JSON" ]]; then
  PR_NUMBER=$(echo "$PR_JSON" | jq -r '.number')
  PR_TITLE=$(echo "$PR_JSON"  | jq -r '.title')
  PR_URL=$(echo "$PR_JSON"    | jq -r '.url')
  PR_HEAD=$(echo "$PR_JSON"   | jq -r '.headRefName')
  PR_AUTHOR=$(echo "$PR_JSON" | jq -r '.author.login')
fi

# -----------------------------------------------------------------------------
# 5. Determine MODE: self | other | no-pr
# -----------------------------------------------------------------------------
if [[ -z "$PR_NUMBER" ]]; then
  MODE="no-pr"
elif [[ "$CURRENT_USER" == "$PR_AUTHOR" ]]; then
  MODE="self"
else
  MODE="other"
fi

# -----------------------------------------------------------------------------
# 6. Prepare context directories (also provisions STEP 6 output dir)
# -----------------------------------------------------------------------------
mkdir -p "$CTX_DIR"

# -----------------------------------------------------------------------------
# 7. Fetch diff → write to file (keeps stdout clean; avoids context bloat)
# -----------------------------------------------------------------------------
DIFF_PATH="$CTX_DIR/diff.patch"
if [[ "$MODE" == "no-pr" ]]; then
  git diff origin/main...HEAD > "$DIFF_PATH"
else
  gh pr diff "$PR_NUMBER" > "$DIFF_PATH"
fi

# -----------------------------------------------------------------------------
# 8. Extract changed Kotlin files from the diff (no extra network call)
# -----------------------------------------------------------------------------
CHANGED_KT=()
while IFS= read -r f; do
  [[ -n "$f" ]] && CHANGED_KT+=("$f")
done < <(grep '^+++ b/.*\.kt$' "$DIFF_PATH" | sed 's|^+++ b/||' || true)

# -----------------------------------------------------------------------------
# 9. Pattern search on local checkout (STEP 3.5 internalized — read-only grep)
#    Patterns: @SuppressLint/@Suppress(  remember {  DialogProperties
# -----------------------------------------------------------------------------
PATTERN_HITS=()
for kt_file in "${CHANGED_KT[@]+"${CHANGED_KT[@]}"}"; do
  if [[ ! -f "$kt_file" ]]; then
    PATTERN_HITS+=("NOTE:$kt_file:not present locally — skipping pattern scan")
    continue
  fi
  while IFS= read -r hit; do
    [[ -n "$hit" ]] && PATTERN_HITS+=("$kt_file:$hit")
  done < <(grep -nE '@SuppressLint|@Suppress\(|remember \{|DialogProperties' "$kt_file" 2>/dev/null || true)
done

# -----------------------------------------------------------------------------
# 10. Fetch unresolved review threads (self mode only — GraphQL read query)
#     → write to file; count isResolved:false
# -----------------------------------------------------------------------------
THREADS_PATH=""
UNRESOLVED_COUNT=0
if [[ "$MODE" == "self" ]]; then
  THREADS_PATH="$CTX_DIR/threads.json"
  THREADS_RAW=$(gh api graphql -f query="
{
  repository(owner: \"$REPO_OWNER\", name: \"$REPO_NAME\") {
    pullRequest(number: $PR_NUMBER) {
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
}")
  echo "$THREADS_RAW" > "$THREADS_PATH"
  UNRESOLVED_COUNT=$(echo "$THREADS_RAW" \
    | jq '[.data.repository.pullRequest.reviewThreads.nodes[] | select(.isResolved == false)] | length')
fi

# -----------------------------------------------------------------------------
# 11. Output structured manifest to stdout
# -----------------------------------------------------------------------------
echo "=== MODE ==="
echo "$MODE"

echo ""
echo "=== PR ==="
if [[ -n "$PR_NUMBER" ]]; then
  printf "number=%s\ntitle=%s\nurl=%s\nheadRefName=%s\nauthor=%s\n" \
    "$PR_NUMBER" "$PR_TITLE" "$PR_URL" "$PR_HEAD" "$PR_AUTHOR"
else
  echo "(no PR)"
fi

echo ""
echo "=== CURRENT_USER ==="
echo "$CURRENT_USER"

echo ""
echo "=== REPO ==="
printf "owner=%s\nname=%s\n" "$REPO_OWNER" "$REPO_NAME"

echo ""
echo "=== CHANGED_KT_FILES ==="
if [[ ${#CHANGED_KT[@]} -gt 0 ]]; then
  printf '%s\n' "${CHANGED_KT[@]}"
else
  echo "(none)"
fi

echo ""
echo "=== PATTERN_HITS ==="
if [[ ${#PATTERN_HITS[@]} -gt 0 ]]; then
  printf '%s\n' "${PATTERN_HITS[@]}"
else
  echo "(none)"
fi

echo ""
echo "=== CONTEXT_FILES ==="
echo "diff=$DIFF_PATH"
[[ -n "$THREADS_PATH" ]] && echo "threads=$THREADS_PATH"

echo ""
echo "=== UNRESOLVED_THREAD_COUNT ==="
echo "$UNRESOLVED_COUNT"
