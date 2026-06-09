"""audit_parse — セッション/サブエージェント JSONL の防御的パースと集計。

生テキストは持たず、1セッションを集計 dict に畳む。signals にはサブエージェントの
タスク指示を流さない(混入防止)。
"""

import json
from pathlib import Path

from audit_common import (
    block_len, human_text, looks_injected, parse_ts,
    LARGE_READ_CHARS, CODE_EXT,
)


def parse_session(path):
    """1セッションの JSONL を防御的に集計し dict を返す。"""
    s = {
        "session_id": Path(path).stem,
        "path": str(path),
        "cwd": None,
        "start": None,
        "end": None,
        "models": {},              # model -> assistant turn 数
        "assistant_turns": 0,
        "peak_context": 0,
        "output_tokens": 0,
        "tools": {},               # name -> {"calls","out_chars"}
        "file_reads": {},          # path -> {"chars","count","full","ranged"}
        "agent_calls": 0,
        "skill_calls": [],         # [{"skill","model"}]
        "edit_calls": 0,
        "used_plan_mode": False,
        "code_file_read_calls": 0,
        "human_prompts": [],       # 人間プロンプト本文（クラスタリング用、後で長さ制限）
        "large_outputs": [],       # [{"tool","chars"}] LARGE_READ_CHARS 超
        "subagent_count": 0,       # このセッションが生成したサブエージェント数
        "subagent_output_tokens": 0,
        "subagent_models": {},     # model -> turn 数（サブエージェントは別モデルのことがある）
        "repo": None,              # 正規 git リポジトリ root（main で解決）
    }
    id_to_name = {}                # tool_use_id -> tool 名
    id_to_path = {}                # tool_use_id -> file_path (Read)
    id_to_ranged = {}              # tool_use_id -> bool (offset/limit 指定あり)
    last_model = None
    last_user_had_command = False  # 直前 user メッセージが <command-name> タグを持つ（名前指定）

    with open(path, "r", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except Exception:
                continue

            ts = parse_ts(obj.get("timestamp"))
            if ts:
                if s["start"] is None or ts < s["start"]:
                    s["start"] = ts
                if s["end"] is None or ts > s["end"]:
                    s["end"] = ts
            if s["cwd"] is None and obj.get("cwd"):
                s["cwd"] = obj.get("cwd")

            otype = obj.get("type")
            if otype == "mode" and obj.get("mode") == "plan":
                s["used_plan_mode"] = True
            if otype == "agent-name":
                # サブエージェント生成の痕跡（Agent tool でも別途カウントする）
                pass

            msg = obj.get("message") or {}
            role = msg.get("role") or otype

            if role == "assistant":
                s["assistant_turns"] += 1
                model = msg.get("model")
                if model and not model.startswith("<"):  # "<synthetic>" 等を除外
                    last_model = model
                    s["models"][model] = s["models"].get(model, 0) + 1
                usage = msg.get("usage") or {}
                inp = int(usage.get("input_tokens", 0) or 0)
                cr = int(usage.get("cache_read_input_tokens", 0) or 0)
                cc = int(usage.get("cache_creation_input_tokens", 0) or 0)
                s["peak_context"] = max(s["peak_context"], inp + cr + cc)
                s["output_tokens"] += int(usage.get("output_tokens", 0) or 0)
                for b in (msg.get("content") or []):
                    if not (isinstance(b, dict) and b.get("type") == "tool_use"):
                        continue
                    name = b.get("name", "unknown")
                    tid = b.get("id")
                    inp_obj = b.get("input") or {}
                    s["tools"].setdefault(name, {"calls": 0, "out_chars": 0})
                    s["tools"][name]["calls"] += 1
                    if name == "Agent":
                        s["agent_calls"] += 1
                    elif name in ("Edit", "Write", "NotebookEdit"):
                        s["edit_calls"] += 1
                    elif name == "Skill":
                        s["skill_calls"].append({
                            "skill": inp_obj.get("skill"),
                            "model": last_model,
                            "triggered_by_name": last_user_had_command,
                        })
                    if tid:
                        id_to_name[tid] = name
                        if name == "Read":
                            fp = inp_obj.get("file_path")
                            if fp:
                                id_to_path[tid] = fp
                                id_to_ranged[tid] = bool(
                                    inp_obj.get("offset") or inp_obj.get("limit"))

            elif role == "user":
                content = msg.get("content")
                # 名前指定（スラッシュコマンド UI）の検出: <command-name> タグの存在を確認
                raw = content if isinstance(content, str) else human_text(content)
                if "<command-name>" in (raw or ""):
                    last_user_had_command = True
                # 人間プロンプト（tool_result でない user メッセージ）を収集
                if isinstance(content, str):
                    txt = content.strip()
                    if txt and not txt.startswith("<") and not looks_injected(txt):
                        s["human_prompts"].append(txt)
                        last_user_had_command = False  # 通常テキストは名前指定ではない
                has_tool_result = False
                for b in (content or []):
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text":
                        t = human_text([b]).strip()
                        if t and not t.startswith("<") and not looks_injected(t):
                            s["human_prompts"].append(t)
                            last_user_had_command = False  # 通常テキストは名前指定ではない
                    if b.get("type") == "tool_result":
                        has_tool_result = True
                        size = block_len(b.get("content"))
                        tid = b.get("tool_use_id")
                        name = id_to_name.get(tid, "unknown")
                        s["tools"].setdefault(name, {"calls": 0, "out_chars": 0})
                        s["tools"][name]["out_chars"] += size
                        if size >= LARGE_READ_CHARS:
                            s["large_outputs"].append({"tool": name, "chars": size})
                        fp = id_to_path.get(tid)
                        if fp:
                            rec = s["file_reads"].setdefault(
                                fp, {"chars": 0, "count": 0, "full": 0, "ranged": 0})
                            rec["chars"] += size
                            rec["count"] += 1
                            if id_to_ranged.get(tid):
                                rec["ranged"] += 1
                            else:
                                rec["full"] += 1
                            if fp.endswith(CODE_EXT):
                                s["code_file_read_calls"] += 1
                _ = has_tool_result

    s["mcp_calls"] = {k: v for k, v in s["tools"].items() if k.startswith("mcp__")}
    return s


def parse_subagent_usage(path):
    """サブエージェント JSONL から usage と model 別ターンのみを集計する。
    親セッションの消費にロールアップするのが目的。**signals には流さない**
    （サブエージェントのタスク指示が頻出指示クラスタ等に混入するのを防ぐ）。"""
    out = {"output_tokens": 0, "turns": 0, "models": {}}
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
            if (msg.get("role") or obj.get("type")) != "assistant":
                continue
            out["turns"] += 1
            usage = msg.get("usage") or {}
            out["output_tokens"] += int(usage.get("output_tokens", 0) or 0)
            model = msg.get("model")
            if model and not model.startswith("<"):
                out["models"][model] = out["models"].get(model, 0) + 1
    return out


def rollup_subagents(session, session_file):
    """<dir>/<uuid>/subagents/*.jsonl を集計し session に加算する。"""
    sub_dir = Path(session_file).parent / Path(session_file).stem / "subagents"
    if not sub_dir.is_dir():
        return
    for sf in sorted(sub_dir.glob("*.jsonl")):
        try:
            u = parse_subagent_usage(sf)
        except Exception:
            continue
        session["subagent_count"] += 1
        session["subagent_output_tokens"] += u["output_tokens"]
        for m, c in u["models"].items():
            session["subagent_models"][m] = session["subagent_models"].get(m, 0) + c


def add_tools(dst, tools):
    for k, v in tools.items():
        d = dst.setdefault(k, {"calls": 0, "out_chars": 0})
        d["calls"] += v["calls"]
        d["out_chars"] += v["out_chars"]
