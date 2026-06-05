#!/usr/bin/env python3
"""token-digest.py — 現在(または指定)の Claude Code セッションのトランスクリプト JSONL を
決定論的に解析し、トークン消費のダイジェスト(JSON)を標準出力へ書く。

token-reduction-review スキルの主入力。モデル(LLM)は一切呼ばない。

トランスクリプトの特定:
- 引数 <transcript_path> が与えられればそれを使う。
- 無ければ環境変数 CLAUDE_CODE_SESSION_ID と cwd から
  ~/.claude/projects/<cwd の / と . を - に置換>/<session_id>.jsonl を構成する。
- 見つからなければエラー終了する（フォールバックで別物を掴まない）。

Python 3.9 互換（PEP 604 の X | Y 表記は使わない）。
"""

import sys
import os
import re
import json
from pathlib import Path


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


def parse_transcript(path):
    """JSONL を1行ずつ防御的にパースして集計する。
    各行 {"type","message":{"role","content":[...],"usage":{...}}, ...} を想定。"""
    peak_context = 0
    out_tokens_sum = 0
    assistant_turns = 0
    tool_output_bytes = 0
    tools = {}                  # name -> {"calls": int, "out_chars": int}
    file_reads = {}             # file_path -> chars
    tooluse_id_to_name = {}     # tool_use_id -> tool name
    tooluse_id_to_path = {}     # tool_use_id -> file_path (Read 用)

    with open(path, "r", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue
            msg = obj.get("message") or {}
            role = msg.get("role") or obj.get("type")

            if role == "assistant":
                assistant_turns += 1
                usage = msg.get("usage") or {}
                inp = int(usage.get("input_tokens", 0) or 0)
                cr = int(usage.get("cache_read_input_tokens", 0) or 0)
                cc = int(usage.get("cache_creation_input_tokens", 0) or 0)
                out = int(usage.get("output_tokens", 0) or 0)
                peak_context = max(peak_context, inp + cr + cc)
                out_tokens_sum += out
                for b in (msg.get("content") or []):
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        name = b.get("name", "unknown")
                        tid = b.get("id")
                        tools.setdefault(name, {"calls": 0, "out_chars": 0})
                        tools[name]["calls"] += 1
                        if tid:
                            tooluse_id_to_name[tid] = name
                            fp = (b.get("input") or {}).get("file_path")
                            if name == "Read" and fp:
                                tooluse_id_to_path[tid] = fp

            elif role == "user":
                for b in (msg.get("content") or []):
                    if isinstance(b, dict) and b.get("type") == "tool_result":
                        size = block_len(b.get("content"))
                        tool_output_bytes += size
                        tid = b.get("tool_use_id")
                        name = tooluse_id_to_name.get(tid, "unknown")
                        tools.setdefault(name, {"calls": 0, "out_chars": 0})
                        tools[name]["out_chars"] += size
                        fp = tooluse_id_to_path.get(tid)
                        if fp:
                            file_reads[fp] = file_reads.get(fp, 0) + size

    mcp_tools = {k: v for k, v in tools.items() if k.startswith("mcp__")}
    return {
        "transcript": path,
        "peak_context_tokens": peak_context,
        "output_tokens_sum": out_tokens_sum,
        "assistant_turns": assistant_turns,
        "tool_output_bytes": tool_output_bytes,
        "tools": tools,
        "mcp_tools": mcp_tools,
        "top_file_reads": dict(sorted(file_reads.items(), key=lambda x: -x[1])[:15]),
        "top_tool_output": dict(
            sorted(
                ((k, v["out_chars"]) for k, v in tools.items()),
                key=lambda x: -x[1],
            )[:15]
        ),
    }


def resolve_transcript():
    if len(sys.argv) > 1:
        return Path(sys.argv[1])
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not sid:
        sys.exit(
            "CLAUDE_CODE_SESSION_ID 未設定。トランスクリプトのパスを引数で渡してください。"
        )
    encoded = re.sub(r"[/.]", "-", os.getcwd())
    return Path.home() / ".claude" / "projects" / encoded / (sid + ".jsonl")


def main():
    path = resolve_transcript()
    if not path.exists():
        sys.exit("トランスクリプトが見つかりません: {}".format(path))
    digest = parse_transcript(str(path))
    print(json.dumps(digest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
