"""audit_repo — cwd を正規 git リポジトリ root へ解決する。

worktree もサブディレクトリも同一リポへ畳む。git 解決不可なら文字列推定に
フォールバックする(削除済み worktree 対応)。
"""

import subprocess
from pathlib import Path

from audit_common import _WT_SUFFIX


def _heuristic_repo(cwd):
    """cwd（実体が消えている削除済み worktree 等）の文字列から本体リポを推定。"""
    if "-worktrees/" in cwd:           # <base>-worktrees/<branch> -> <base>
        return cwd.split("-worktrees/")[0]
    m = _WT_SUFFIX.search(cwd)          # 末尾 -worktreeN -> <base>
    if m:
        return cwd[:m.start()]
    return cwd


def canonical_repo(cwd, cache):
    """cwd を正規 git リポジトリ root へ解決。worktree もサブディレクトリも
    同一リポへ畳む。cwd 単位でキャッシュ。git 解決不可なら fallback。"""
    if not cwd:
        return "unknown"
    if cwd in cache:
        return cache[cwd]
    repo = cwd
    if Path(cwd).exists():
        try:
            out = subprocess.run(
                ["git", "-C", cwd, "rev-parse", "--path-format=absolute",
                 "--git-common-dir"],
                capture_output=True, text=True, timeout=5)
            common = out.stdout.strip()
            if out.returncode == 0 and common:
                gp = Path(common)
                repo = str(gp.parent if gp.name == ".git" else gp)
        except Exception:
            pass
    else:
        repo = _heuristic_repo(cwd)     # 実体が消えている -> 文字列推定
    cache[cwd] = repo
    return repo
