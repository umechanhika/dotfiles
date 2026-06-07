"""audit_summary — 全体サマリと縦断比較(--split-date)の集計。

正規リポ root 単位の集計、main/subagent の出力トークン按分、適用日前後の
1セッションあたり主要指標平均を算出する。
"""


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
