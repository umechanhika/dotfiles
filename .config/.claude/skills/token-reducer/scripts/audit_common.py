"""audit_common — token-audit の共有基盤。

ヒューリスティックしきい値・定数・純粋ヘルパーのみを持ち、兄弟モジュールには
一切依存しない。token-audit.py は path 起動のため scripts/ が import 可能。

Python 3.9 互換(PEP 604 の X | Y 表記は使わない)。
"""

import re
import json
from pathlib import Path
from datetime import datetime, timedelta, timezone

# ---- ヒューリスティックしきい値（候補抽出用。最終判断は LLM）-------------------
LARGE_READ_CHARS = 20000       # 1回の Read/ツール出力が大きいとみなす文字数(~5k tokens)
HIGH_PEAK_CONTEXT = 100000     # サブエージェント委任を検討すべき高コンテキスト
COMPLEX_TURNS = 25             # 「複雑」とみなす assistant ターン数
TRIVIAL_TURNS = 6              # 「軽微」とみなす assistant ターン数
CHARS_PER_TOKEN = 4            # 文字→トークン概算（ツール出力のトークン見積り用）
LARGE_SOURCE_CHARS = 15000     # skill/script ソースが「過大」とみなす文字数(~3.7k tokens)
SOURCE_EXT = (".js", ".py", ".css")  # large_skill_sources の走査対象拡張子
CODE_EXT = (".kt", ".kts", ".swift", ".ts", ".tsx", ".java", ".py",
            ".js", ".jsx", ".go", ".rs", ".c", ".cc", ".cpp", ".h", ".m")
# CLI 代替が現実的に存在する MCP サーバ名の断片（観点3の補助フラグ）
CLI_REPLACEABLE_MCP = ("github", "gh")


def block_len(content):
    """content（str / list[dict|str]）の文字数を防御的に数える。
    tool_result.content は str / list の両方がありうる。"""
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        n = 0
        for b in content:
            if isinstance(b, dict):
                n += len(b.get("text", "") or "")
                if isinstance(b.get("content"), (str, list)):
                    n += block_len(b["content"])
            elif isinstance(b, str):
                n += len(b)
        return n
    return 0


def human_text(content):
    """user メッセージのうち「人間が書いた」テキストを返す。
    tool_result やシステム注入(<system-reminder>等)は除外する。"""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("text", "") or "")
        return "\n".join(parts)
    return ""


# slash コマンド/スキル本文/フック注入など「人間が打っていない」user メッセージの目印。
# これらは観点6(頻出指示→skill化)では除外する（既にスキル化済み or 自動注入のため）。
_INJECTED_PREFIXES = (
    "base directory for this skill:",
    "caveat: the messages below",
    "stop hook feedback:",
)
_INJECTED_SUBSTR = (
    "<command-name>", "<command-message>", "<command-args>",
    "<local-command-stdout>", "hook feedback:", "<system-reminder>",
)


def looks_injected(txt):
    low = txt.lower().lstrip()
    if low.startswith(_INJECTED_PREFIXES):
        return True
    return any(m in low for m in _INJECTED_SUBSTR)


def parse_ts(s):
    """ISO8601(末尾Z含む)を timezone-aware datetime に。失敗時 None。"""
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except Exception:
        return None


def est_tokens(chars):
    return chars // CHARS_PER_TOKEN


# SKILL.md 本文に「決定論的な機械的手順」を示唆するキーワード（簡易ヒューリスティック）。
# ここはあくまで候補サーフェスで、スクリプト化すべきかの最終判定は LLM が行う。
MECHANICAL_MARKERS = (
    "集計", "カウント", "件数", "数える", "パース", "整形", "走査", "スキャン",
    "一覧化", "列挙", "抽出", "変換", "集約", "ソート", "grep", "find", "rg",
)


# ---- worktree / サブディレクトリを正規 git リポジトリ root へ統合 -------------
_WT_SUFFIX = re.compile(r"-worktree\d+$")
