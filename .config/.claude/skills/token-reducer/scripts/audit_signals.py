"""audit_signals — セッション群を観点別の監査シグナルへ集約する。

プロンプト類似クラスタリング・過大ソース走査・各観点(モデル選択/MCP/LSP/hook/
頻出指示/委任/読取最小化/プランモード等)の候補抽出。最終判断は digest を読む LLM。
"""

import re
from collections import defaultdict
from pathlib import Path

from audit_common import (
    est_tokens,
    LARGE_READ_CHARS, HIGH_PEAK_CONTEXT, COMPLEX_TURNS, TRIVIAL_TURNS,
    LARGE_SOURCE_CHARS, SOURCE_EXT, CLI_REPLACEABLE_MCP,
)


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


def scan_large_skill_sources(skills_root):
    """観点5/10（継続的開発前提）: 過大な skill/script ソースを決定論的に列挙する。

    skill・script 開発は継続的に発生する作業のため、大きな単一ソースの full-read は
    保守のたびに恒久的に再課金される構造的無駄になる。LARGE_SOURCE_CHARS 超の
    *.js/*.py/*.css を surface する（ベンダ minified=*.min.js は分割不可なので除外）。
    対策はモジュール分割＋モジュールマップ（行動依存でなく構造で削減）。
    """
    if not skills_root or not skills_root.exists():
        return {"files": [], "threshold_chars": LARGE_SOURCE_CHARS, "applies": False}
    found = []
    for p in skills_root.rglob("*"):
        if not p.is_file() or p.suffix not in SOURCE_EXT:
            continue
        if p.name.endswith(".min.js"):
            continue
        try:
            chars = len(p.read_text(errors="replace"))
            lines = p.read_text(errors="replace").count("\n") + 1
        except Exception:
            continue
        if chars >= LARGE_SOURCE_CHARS:
            found.append({"file": str(p), "chars": chars,
                          "est_tokens": est_tokens(chars), "lines": lines})
    found.sort(key=lambda x: -x["chars"])
    return {"files": found, "threshold_chars": LARGE_SOURCE_CHARS,
            "applies": bool(found)}


def build_signals(sessions, skills_root=None):
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

    # 観点16: 全呼び出しが名前指定（/skill-name） → description の自然言語トリガー文が不要。
    DESCRIPTION_CHARS_THRESHOLD = 80
    desc_chars: dict = {}
    if skills_root:
        for skill_dir in Path(skills_root).iterdir():
            md = skill_dir / "SKILL.md"
            if not md.exists():
                continue
            try:
                text = md.read_text(encoding="utf-8")
            except Exception:
                continue
            fm_match = re.match(r'^---\n(.*?)\n---', text, re.DOTALL)
            if not fm_match:
                continue
            desc_lines = []
            in_desc = False
            for line in fm_match.group(1).splitlines():
                if re.match(r'^description\s*:', line):
                    in_desc = True
                    rest = re.sub(r'^description\s*:\s*', '', line).strip().lstrip('>-').strip()
                    if rest:
                        desc_lines.append(rest)
                elif in_desc and (line.startswith(' ') or line.startswith('\t')):
                    desc_lines.append(line.strip())
                else:
                    in_desc = False
            desc_chars[skill_dir.name] = sum(len(l) for l in desc_lines)

    runs_by_skill: dict = defaultdict(list)
    for r in skill_runs:
        if r.get("skill"):
            runs_by_skill[r["skill"]].append(r)

    name_only_candidates = []
    for skill_name, runs in runs_by_skill.items():
        if len(runs) < 2:
            continue
        by_name_count = sum(1 for r in runs if r.get("triggered_by_name"))
        total = len(runs)
        if by_name_count * 2 > total and desc_chars.get(skill_name, 0) > DESCRIPTION_CHARS_THRESHOLD:
            name_only_candidates.append({
                "skill": skill_name,
                "invocations": total,
                "by_name_count": by_name_count,
                "by_name_pct": round(by_name_count / total * 100),
                "description_chars": desc_chars.get(skill_name, 0),
            })
    sig["name_only_invocations"] = {
        "note": "名前指定率が高いスキルは description のトリガー文が冗長な可能性。"
                "ただし削除すると Claude の自律提案も失われるため、削除前に自律提案が不要かを確認する（確証レベル B）。",
        "candidates": sorted(name_only_candidates, key=lambda x: -x["by_name_pct"]),
        "applies": bool(name_only_candidates),
    }

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

    # 観点5/10（継続的開発前提）: 過大な skill/script ソース。決定論的に毎回 surface。
    sig["large_skill_sources"] = scan_large_skill_sources(skills_root)

    return sig
