#!/usr/bin/env python3
"""token-audit.py — 過去全ての Claude Code セッションのトランスクリプト(JSONL)を
決定論的に横断解析し、トークン消費の監査ダイジェスト(JSON)を標準出力へ書く。

token-reducer スキルの主入力。モデル(LLM)は一切呼ばない。

設計方針:
- 生テキストは出力しない。集計値・上位ランキング・観点別シグナル(候補セッションID)のみ。
- スキル本体は digest を読み、上位/判定が必要な対象セッションだけをサブエージェントに
  生トランスクリプト精読させる(scout -> deep-read)。
- 過去履歴は不変なので、効果検証は「適用前後の縦断比較」(--split-date)で行う。

しきい値はすべてヒューリスティック。最終判断は digest を読む LLM が行う前提。

Python 3.9 互換(PEP 604 の X | Y 表記は使わない)。

path 起動(`python3 .../scripts/token-audit.py`)のため sys.path[0]=scripts/ となり、
兄弟モジュール(audit_*.py)を直接 import できる。モジュール構成は scripts/README.md 参照。
"""

import sys
import os
import json
import argparse
from pathlib import Path
from datetime import datetime, timedelta, timezone

from audit_common import (
    parse_ts,
    LARGE_READ_CHARS, HIGH_PEAK_CONTEXT, COMPLEX_TURNS, TRIVIAL_TURNS,
)
from audit_parse import parse_session, rollup_subagents
from audit_repo import canonical_repo
from audit_signals import build_signals
from audit_summary import summarize, split_summary
from audit_mechanisms import detect_existing_mechanisms, load_apply_log


def iter_session_files(projects_dir, project_filter):
    for proj in sorted(projects_dir.glob("*")):
        if not proj.is_dir():
            continue
        if project_filter and project_filter not in proj.name:
            continue
        for f in sorted(proj.glob("*.jsonl")):
            yield f


def main():
    ap = argparse.ArgumentParser(description="全セッションのトークン消費を横断監査する")
    ap.add_argument("--projects-dir",
                    default=str(Path.home() / ".claude" / "projects"),
                    help="セッション JSONL のルート")
    ap.add_argument("--config-dir", default=None,
                    help="settings.json/CLAUDE.md のあるディレクトリ(既定: skill から推定)")
    ap.add_argument("--since-days", type=int, default=None,
                    help="直近N日のセッションのみ対象")
    ap.add_argument("--project", default=None,
                    help="プロジェクトディレクトリ名の部分一致で絞り込み")
    ap.add_argument("--split-date", default=None,
                    help="YYYY-MM-DD。適用前後の縦断比較を出力")
    ap.add_argument("--since-last-apply", action="store_true",
                    help="ローカル apply_log の最終適用日以降のセッションだけを集計（新規診断用）")
    args = ap.parse_args()

    projects_dir = Path(args.projects_dir)
    if not projects_dir.exists():
        sys.exit("projects ディレクトリが見つかりません: {}".format(projects_dir))

    # CLAUDE_SKILL_DIR があればそれを、無ければスクリプト位置から skill ルートを推定。
    # symlink(~/.claude/skills -> dotfiles)を解決して実体パスに正規化する。
    env_sd = os.environ.get("CLAUDE_SKILL_DIR")
    if env_sd:
        skill_dir = Path(env_sd).resolve()
    else:
        skill_dir = Path(__file__).resolve().parent.parent  # scripts -> skill ルート

    if args.config_dir:
        config_dir = Path(args.config_dir).resolve()
    else:
        config_dir = skill_dir.parent.parent  # skills/<name> -> .claude

    cutoff = None
    if args.since_days is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(days=args.since_days)
    if args.since_last_apply:
        dates = [parse_ts(e["date"] + "T00:00:00Z") for e in load_apply_log() if e.get("date")]
        dates = [d for d in dates if d]
        if dates:
            la = max(dates)
            cutoff = max(cutoff, la) if cutoff else la

    sessions = []
    parse_errors = 0
    repo_cache = {}
    for f in iter_session_files(projects_dir, args.project):
        try:
            s = parse_session(f)
        except Exception:
            parse_errors += 1
            continue
        if cutoff and s["start"] and s["start"] < cutoff:
            continue
        if s["assistant_turns"] == 0:
            continue
        rollup_subagents(s, f)                      # #1 サブエージェント消費を加算
        s["repo"] = canonical_repo(s["cwd"], repo_cache)  # #2 正規リポへ統合
        sessions.append(s)

    digest = {
        "generated_for": "token-reducer",
        "thresholds": {
            "LARGE_READ_CHARS": LARGE_READ_CHARS,
            "HIGH_PEAK_CONTEXT": HIGH_PEAK_CONTEXT,
            "COMPLEX_TURNS": COMPLEX_TURNS,
            "TRIVIAL_TURNS": TRIVIAL_TURNS,
            "note": "しきい値はヒューリスティック。候補抽出用で最終判断はLLM。",
        },
        "scanned": {
            "projects_dir": str(projects_dir),
            "sessions_analyzed": len(sessions),
            "parse_errors": parse_errors,
            "effective_cutoff": cutoff.isoformat() if cutoff else None,
        },
        "summary": summarize(sessions),
        "signals": build_signals(sessions, skills_root=skill_dir.parent if skill_dir else None),
        "existing_mechanisms": detect_existing_mechanisms(config_dir, skill_dir),
        "apply_log": load_apply_log(),
    }

    if args.split_date:
        dt = parse_ts(args.split_date + "T00:00:00Z")
        if dt:
            digest["longitudinal"] = split_summary(sessions, dt)
        else:
            digest["longitudinal"] = {"error": "split-date 解析失敗: " + args.split_date}

    print(json.dumps(digest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
