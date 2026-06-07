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
"""

import sys
import os
import re
import json
import argparse
import subprocess
from pathlib import Path
from datetime import datetime, timedelta, timezone

# ---- ヒューリスティックしきい値（候補抽出用。最終判断は LLM）-------------------
LARGE_READ_CHARS = 20000       # 1回の Read/ツール出力が大きいとみなす文字数(~5k tokens)
HIGH_PEAK_CONTEXT = 100000     # サブエージェント委任を検討すべき高コンテキスト
COMPLEX_TURNS = 25             # 「複雑」とみなす assistant ターン数
TRIVIAL_TURNS = 6              # 「軽微」とみなす assistant ターン数
CHARS_PER_TOKEN = 4            # 文字→トークン概算（ツール出力のトークン見積り用）
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
                        s["skill_calls"].append(
                            {"skill": inp_obj.get("skill"), "model": last_model})
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
                # 人間プロンプト（tool_result でない user メッセージ）を収集
                if isinstance(content, str):
                    txt = content.strip()
                    if txt and not txt.startswith("<") and not looks_injected(txt):
                        s["human_prompts"].append(txt)
                has_tool_result = False
                for b in (content or []):
                    if not isinstance(b, dict):
                        continue
                    if b.get("type") == "text":
                        t = human_text([b]).strip()
                        if t and not t.startswith("<") and not looks_injected(t):
                            s["human_prompts"].append(t)
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


# ---- worktree / サブディレクトリを正規 git リポジトリ root へ統合 -------------
_WT_SUFFIX = re.compile(r"-worktree\d+$")


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


# ---- プロンプト類似クラスタリング（観点6: 頻出指示） ------------------------
def normalize_prompt(t):
    t = t.lower()
    t = re.sub(r"https?://\S+", " ", t)           # URL 除去
    t = re.sub(r"[^\w\sぁ-んァ-ン一-龥]", " ", t)   # 記号除去（日本語は残す）
    toks = [w for w in t.split() if len(w) > 1]
    return set(toks[:60])


def cluster_prompts(prompts, min_size=2, jaccard=0.5):
    """近似重複プロンプトを単純グリーディでクラスタリング。
    プロンプト数は数百規模を想定（O(n^2) で十分）。"""
    items = []
    for p in prompts:
        sig = normalize_prompt(p)
        if len(sig) >= 3:
            items.append((p, sig))
    clusters = []  # [{"reps":[text...], "sigs":[set...]}]
    for text, sig in items:
        placed = False
        for c in clusters:
            base = c["sigs"][0]
            inter = len(sig & base)
            union = len(sig | base) or 1
            if inter / union >= jaccard:
                c["reps"].append(text)
                c["sigs"].append(sig)
                placed = True
                break
        if not placed:
            clusters.append({"reps": [text], "sigs": [sig]})
    out = []
    for c in clusters:
        if len(c["reps"]) >= min_size:
            out.append({
                "count": len(c["reps"]),
                "example": c["reps"][0][:200],
            })
    return sorted(out, key=lambda x: -x["count"])[:15]


# ---- 既存メカニズム検出（重複・適用済み再提案を防ぐ）------------------------
def detect_existing_mechanisms(config_dir, skill_dir):
    out = {"hooks": [], "enabled_plugins": [], "skills": [],
           "claude_md_lines": None, "settings_path": None}
    settings = config_dir / "settings.json"
    if settings.exists():
        out["settings_path"] = str(settings)
        try:
            data = json.loads(settings.read_text())
            out["hooks"] = sorted((data.get("hooks") or {}).keys())
            out["enabled_plugins"] = sorted(
                k for k, v in (data.get("enabledPlugins") or {}).items() if v)
        except Exception:
            pass
    cmd = config_dir / "CLAUDE.md"
    if cmd.exists():
        try:
            out["claude_md_lines"] = len(cmd.read_text().splitlines())
        except Exception:
            pass
    skills_root = skill_dir.parent if skill_dir else (config_dir / "skills")
    if skills_root.exists():
        # SKILL.md を持つディレクトリだけを skill とみなす（隠しdir等を除外）。
        out["skills"] = sorted(
            p.name for p in skills_root.iterdir()
            if p.is_dir() and (p / "SKILL.md").exists())
    return out


def apply_log_path():
    # apply_log は端末ローカル状態（git 非追跡）。~/.claude 直下に置く。
    # 履歴は端末ごとに異なるため、縦断検証の基準日も端末ローカルであるべき。
    return Path.home() / ".claude" / "token-reducer" / "apply_log.json"


def load_apply_log():
    f = apply_log_path()
    if f.exists():
        try:
            return json.loads(f.read_text())
        except Exception:
            return []
    return []


# ---- セッション群 -> 監査シグナルへの集約 -----------------------------------
def add_tools(dst, tools):
    for k, v in tools.items():
        d = dst.setdefault(k, {"calls": 0, "out_chars": 0})
        d["calls"] += v["calls"]
        d["out_chars"] += v["out_chars"]


def est_tokens(chars):
    return chars // CHARS_PER_TOKEN


def build_signals(sessions):
    sig = {}

    # 観点1: モデル選択。軽微セッションでの opus 使用候補。
    model_turns = {}
    trivial_opus = []
    for s in sessions:
        for m, c in s["models"].items():
            model_turns[m] = model_turns.get(m, 0) + c
        is_opus = any("opus" in m for m in s["models"])
        if (is_opus and s["assistant_turns"] <= TRIVIAL_TURNS
                and s["agent_calls"] == 0 and not s["used_plan_mode"]
                and s["edit_calls"] == 0):
            trivial_opus.append({"session": s["session_id"],
                                 "turns": s["assistant_turns"],
                                 "models": list(s["models"].keys())})
    sig["model_distribution"] = {
        "by_assistant_turn": model_turns,
        "trivial_sessions_on_opus": trivial_opus,
        "applies": bool(trivial_opus),
    }

    # 観点2: スキル実行時のモデル。
    skill_runs = []
    for s in sessions:
        for sk in s["skill_calls"]:
            skill_runs.append({"session": s["session_id"], **sk})
    sig["skill_invocations"] = {"runs": skill_runs, "applies": bool(skill_runs)}

    # 観点3: MCP 使用（CLI 代替可能性フラグ付き）。
    mcp_total = {}
    for s in sessions:
        for k, v in s["mcp_calls"].items():
            d = mcp_total.setdefault(k, {"calls": 0, "out_chars": 0})
            d["calls"] += v["calls"]
            d["out_chars"] += v["out_chars"]
    mcp_ranked = sorted(
        ({"tool": k, "calls": v["calls"], "out_chars": v["out_chars"],
          "est_tokens": est_tokens(v["out_chars"]),
          "cli_replaceable": any(x in k.lower() for x in CLI_REPLACEABLE_MCP)}
         for k, v in mcp_total.items()),
        key=lambda x: -x["out_chars"])
    sig["mcp_usage"] = {"tools": mcp_ranked[:15], "applies": bool(mcp_ranked)}

    # 観点4: コードインテリジェンス。コードファイル読みが多いセッション(LSP候補)。
    lsp_candidates = [
        {"session": s["session_id"], "code_file_read_calls": s["code_file_read_calls"]}
        for s in sessions if s["code_file_read_calls"] >= 5]
    sig["code_intelligence"] = {
        "candidate_sessions": sorted(
            lsp_candidates, key=lambda x: -x["code_file_read_calls"])[:15],
        "applies": bool(lsp_candidates)}

    # 観点5: hook 前処理。大出力(LARGE_READ_CHARS超)が反復しているツール。
    big_by_tool = {}
    for s in sessions:
        for lo in s["large_outputs"]:
            d = big_by_tool.setdefault(lo["tool"], {"count": 0, "chars": 0})
            d["count"] += 1
            d["chars"] += lo["chars"]
    big_ranked = sorted(
        ({"tool": k, "large_output_count": v["count"], "chars": v["chars"],
          "est_tokens": est_tokens(v["chars"])}
         for k, v in big_by_tool.items() if v["count"] >= 2),
        key=lambda x: -x["chars"])
    sig["hook_preprocessing"] = {"repeated_large_outputs": big_ranked[:15],
                                 "applies": bool(big_ranked)}

    # 観点6: 頻出指示（プロンプトクラスタ）。
    all_prompts = []
    for s in sessions:
        all_prompts.extend(s["human_prompts"])
    sig["repeated_instructions"] = {
        "clusters": cluster_prompts(all_prompts),
        "total_human_prompts": len(all_prompts),
        "applies": True}  # クラスタ有無は LLM が判断

    # 観点9: サブエージェント未委任。高コンテキストかつ Agent 0。
    no_delegate = [
        {"session": s["session_id"], "peak_context": s["peak_context"],
         "assistant_turns": s["assistant_turns"]}
        for s in sessions
        if s["peak_context"] >= HIGH_PEAK_CONTEXT and s["agent_calls"] == 0]
    sig["subagent_delegation"] = {
        "high_context_no_agent": sorted(
            no_delegate, key=lambda x: -x["peak_context"])[:15],
        "applies": bool(no_delegate)}

    # 観点10: ファイル読取最小化。大容量 full 読み・反復読み。
    full_reads, repeat_reads = {}, {}
    for s in sessions:
        for fp, r in s["file_reads"].items():
            if r["full"] and r["chars"] >= LARGE_READ_CHARS:
                d = full_reads.setdefault(fp, {"chars": 0, "full": 0})
                d["chars"] += r["chars"]
                d["full"] += r["full"]
            if r["count"] >= 2:
                repeat_reads[fp] = repeat_reads.get(fp, 0) + r["count"]
    sig["file_read_minimization"] = {
        "large_full_reads": sorted(
            ({"file": k, "chars": v["chars"], "est_tokens": est_tokens(v["chars"]),
              "full_reads": v["full"]} for k, v in full_reads.items()),
            key=lambda x: -x["chars"])[:15],
        "repeated_reads": sorted(
            ({"file": k, "read_count": c} for k, c in repeat_reads.items()),
            key=lambda x: -x["read_count"])[:15],
        "applies": bool(full_reads or repeat_reads)}

    # 観点11: 複雑タスクでプランモード未使用。
    complex_no_plan = [
        {"session": s["session_id"], "assistant_turns": s["assistant_turns"],
         "edit_calls": s["edit_calls"], "peak_context": s["peak_context"]}
        for s in sessions
        if (s["assistant_turns"] >= COMPLEX_TURNS or s["edit_calls"] >= 5)
        and not s["used_plan_mode"]]
    sig["plan_mode"] = {
        "complex_sessions_without_plan": sorted(
            complex_no_plan, key=lambda x: -x["assistant_turns"])[:15],
        "applies": bool(complex_no_plan)}

    # 観点12: 検証可能なゴール（プロンプト判定はLLM。候補は repeated_instructions と共有）。
    sig["verifiable_goals"] = {
        "note": "プロンプト本文の判定が必要。repeated_instructions.clusters と "
                "deep-read 対象セッションのプロンプトを LLM が評価する。",
        "applies": None}

    return sig


def summarize(sessions):
    by_model_turns = {}        # メイン会話の model 別ターン
    sub_by_model = {}          # サブエージェントの model 別ターン
    by_project = {}            # 正規リポ root 単位
    main_out = 0
    sub_out = 0
    for s in sessions:
        main_out += s["output_tokens"]
        sub_out += s["subagent_output_tokens"]
        repo = s["repo"] or s["cwd"] or "unknown"
        p = by_project.setdefault(repo, {
            "sessions": 0, "output_tokens": 0,
            "subagent_output_tokens": 0, "folded_paths": set()})
        p["sessions"] += 1
        p["output_tokens"] += s["output_tokens"]
        p["subagent_output_tokens"] += s["subagent_output_tokens"]
        if s["cwd"]:
            p["folded_paths"].add(s["cwd"])
        for m, c in s["models"].items():
            by_model_turns[m] = by_model_turns.get(m, 0) + c
        for m, c in s["subagent_models"].items():
            sub_by_model[m] = sub_by_model.get(m, 0) + c
    for p in by_project.values():
        p["folded_paths"] = sorted(p["folded_paths"])
    total = main_out + sub_out
    return {
        "total_sessions": len(sessions),
        "total_output_tokens": total,          # main + subagent
        "main_output_tokens": main_out,
        "subagent": {
            "output_tokens": sub_out,
            "share_pct": round(100.0 * sub_out / total, 1) if total else 0.0,
            "by_model": sub_by_model,
            "sessions_with_subagents": sum(1 for s in sessions if s["subagent_count"]),
        },
        "assistant_turns_by_model": by_model_turns,
        "by_project": dict(sorted(
            by_project.items(), key=lambda x: -x[1]["output_tokens"])),
    }


def split_summary(sessions, split_dt):
    """--split-date 用: 適用日前後で1セッションあたりの主要指標平均を比較。"""
    def avg(group):
        n = len(group) or 1
        return {
            "sessions": len(group),
            "avg_output_tokens": sum(s["output_tokens"] for s in group) // n,
            "avg_peak_context": sum(s["peak_context"] for s in group) // n,
            "avg_assistant_turns": round(
                sum(s["assistant_turns"] for s in group) / n, 1),
            "avg_mcp_calls": round(
                sum(sum(v["calls"] for v in s["mcp_calls"].values())
                    for s in group) / n, 1),
        }
    before = [s for s in sessions if s["start"] and s["start"] < split_dt]
    after = [s for s in sessions if s["start"] and s["start"] >= split_dt]
    return {"split_date": split_dt.isoformat(),
            "before": avg(before), "after": avg(after)}


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
        "signals": build_signals(sessions),
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
