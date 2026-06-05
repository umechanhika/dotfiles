#!/usr/bin/env python3
"""
context-review-gate.py

SessionEnd フックから呼ばれる「無料の起動ゲート」。
モデル(LLM)を一切呼ばずに、ローカルのトランスクリプト JSONL だけを読んで
- このセッションを分析する価値があるか（起動ゲート）を判定し、
- 価値がある場合のみ、決定論的なデジェスト(JSON)を書き出してから
- ヘッドレスの reviewer (claude -p) をデタッチして起動する。

設計上の前提（会話で合意済み）:
- exit(prompt_input_exit) を主対象。clear/logout は既定でスキップ。
- 起動ゲートは仮置き閾値: peak_context>=40k かつ turns>=4 かつ tool_output>=20KB。
  ただし peak_context>=100k は単独で常に GO。
- reviewer 自身のトークンを節約するため、reviewer には生トランスクリプトではなく
  このデジェストを主入力として渡す（determinism-first）。
- 提案ファイルの保存先は reviewer がスコープ判定して振り分ける（repo-local / global）。
- パスの生値（$HOME 配下など）は識別子に使わない。repo_id は origin URL のハッシュ。

旧 [VERIFY] 箇所は 2026-06-05 に実環境（claude 2.1.163 / 実トランスクリプト）で検証済み:
- トランスクリプト JSONL のキー名は実構造と一致（parse_transcript）。
- --model エイリアス / --permission-mode / --allowedTools / --strict-mcp-config /
  --setting-sources / --append-system-prompt は CLI に存在。
"""

import sys, os, json, time, hashlib, shutil, subprocess
from datetime import datetime
from pathlib import Path

# ---- 仮置き閾値（後で実測して調整）-------------------------------------
TOKENS_MIN = 40_000        # peak context がこれ未満ならスキップ
TURNS_MIN = 4              # assistant ターン数がこれ未満ならスキップ
TOOLOUT_MIN_BYTES = 20_000 # ツール出力(tool_result)累積がこれ未満ならスキップ
TOKENS_ALWAYS = 100_000    # これ以上なら他条件を無視して常に GO
REASONS_ALLOWED = {"prompt_input_exit", "other"}  # 起動を許す終了理由
# ------------------------------------------------------------------------

HOME = Path.home()
SCRIPT_DIR = Path(__file__).resolve().parent
GLOBAL_DIR = HOME / ".claude" / "context-reviews"   # runtime（pending/.digests/log）
REVIEWER_MD = SCRIPT_DIR / "reviewer.md"             # ソースはスクリプト隣に同梱（runtime と分離）
DIGEST_DIR = GLOBAL_DIR / ".digests"
LOG = GLOBAL_DIR / "gate.log"


def log(msg: str) -> None:
    try:
        GLOBAL_DIR.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as f:
            f.write(f"{datetime.now().isoformat()} {msg}\n")
    except Exception:
        pass


def read_hook_input() -> dict:
    try:
        return json.loads(sys.stdin.read() or "{}")
    except Exception:
        return {}


def git(cwd: str, *args: str):
    try:
        out = subprocess.run(
            ["git", "-C", cwd, *args],
            capture_output=True, text=True, timeout=5,
        )
        if out.returncode == 0:
            return out.stdout.strip()
    except Exception:
        pass
    return None


def parse_transcript(path: str) -> dict:
    """JSONL を1行ずつ防御的にパースして集計する。
    2026-06-05 に実トランスクリプトでキー名を検証済み。
    各行 {"type","message":{"role","content":[...],"usage":{...}}, ...}。
    tool_result.content は str/list 両方ありうる（block_len が両対応）。
    """
    peak_context = 0
    out_tokens_sum = 0
    assistant_turns = 0
    tool_output_bytes = 0
    tools = {}                 # name -> {"calls": int, "out_chars": int}
    file_reads = {}            # file_path -> chars
    tooluse_id_to_name = {}    # tool_use_id -> tool name
    tooluse_id_to_path = {}    # tool_use_id -> file_path (Read 用)

    def block_len(content) -> int:
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

    try:
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
    except FileNotFoundError:
        log(f"transcript not found: {path}")

    mcp_tools = {k: v for k, v in tools.items() if k.startswith("mcp__")}
    return {
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


def should_run(cwd: str, d: dict) -> bool:
    # 手動オーバーライド
    if (Path(cwd) / ".claude" / "force-review").exists():
        log("force-review present -> GO")
        return True
    if (Path(cwd) / ".claude" / "skip-review").exists() or (GLOBAL_DIR / "skip-all").exists():
        log("skip override present -> SKIP")
        return False
    if d["peak_context_tokens"] >= TOKENS_ALWAYS:
        return True
    return (
        d["peak_context_tokens"] >= TOKENS_MIN
        and d["assistant_turns"] >= TURNS_MIN
        and d["tool_output_bytes"] >= TOOLOUT_MIN_BYTES
    )


def repo_info(cwd: str) -> dict:
    root = git(cwd, "rev-parse", "--show-toplevel")
    if not root:
        return {"is_repo": False, "repo_root": None, "repo_name": None, "repo_id": None}
    origin = git(cwd, "remote", "get-url", "origin") or root  # origin が無ければ root を種に
    repo_id = hashlib.sha1(origin.encode("utf-8")).hexdigest()[:12]
    return {
        "is_repo": True,
        "repo_root": root,
        "repo_name": os.path.basename(root),
        "repo_id": repo_id,
    }


def launch_reviewer(ctx: dict) -> None:
    claude = shutil.which("claude")
    if not claude:
        log("claude not on PATH; cannot launch reviewer")
        return
    if not REVIEWER_MD.exists():
        log(f"reviewer.md missing at {REVIEWER_MD}")
        return

    system = REVIEWER_MD.read_text()
    user_prompt = (
        "あなたはこのセッション終了後に起動された context-cost reviewer です。\n"
        "以下のパスとメタ情報を使い、reviewer.md の規約に厳密に従って作業してください。\n\n"
        f"```json\n{json.dumps(ctx, ensure_ascii=False, indent=2)}\n```\n"
        "主入力は digest_path の JSON です。生のトランスクリプトは必要時のみ部分的に参照。"
    )

    # 再帰防止: 子(reviewer)セッションでは gate を無効化するマーカーを渡す
    child_env = os.environ.copy()
    child_env["CONTEXT_REVIEW_CHILD"] = "1"

    logf = open(GLOBAL_DIR / "reviewer.log", "a")
    cmd = [
        claude,
        "-p", user_prompt,
        "--append-system-prompt", system,    # reviewer.md は system プロンプトとして渡す
        "--model", "haiku",                  # エイリアス受理を確認済み
        "--permission-mode", "acceptEdits",
        # headless では Read/Glob/Grep もブロックされうるため明示許可（reviewer は Bash 不使用）
        "--allowedTools", "Read", "Write", "Glob", "Grep",
        "--strict-mcp-config",               # MCP を一切ロードしない（コスト削減）
        "--setting-sources", "project",      # user 設定(agent-manager hook 等)をロードしない
    ]
    try:
        subprocess.Popen(
            cmd,
            stdin=subprocess.DEVNULL,
            stdout=logf,
            stderr=logf,
            start_new_session=True,  # setsid 相当: 親(claude)終了後も生存
            env=child_env,
            cwd=ctx.get("repo_root") or str(HOME),
        )
        log("reviewer launched (detached)")
    except Exception as e:
        log(f"launch failed: {e}")


def main() -> int:
    # 再帰防止: reviewer 自身のセッション終了で再び gate が走らないようにする
    if os.environ.get("CONTEXT_REVIEW_CHILD"):
        log("CONTEXT_REVIEW_CHILD set -> SKIP (child reviewer session, no recursion)")
        return 0
    hook = read_hook_input()
    reason = hook.get("reason", "other")
    cwd = hook.get("cwd") or os.getcwd()
    transcript_path = hook.get("transcript_path", "")
    session_id = hook.get("session_id", "unknown")

    if reason not in REASONS_ALLOWED and not (Path(cwd) / ".claude" / "force-review").exists():
        log(f"reason={reason} -> SKIP")
        return 0
    if not transcript_path:
        log("no transcript_path -> SKIP")
        return 0

    d = parse_transcript(transcript_path)
    if not should_run(cwd, d):
        log(f"gate FAIL peak={d['peak_context_tokens']} turns={d['assistant_turns']} toolbytes={d['tool_output_bytes']} -> SKIP")
        return 0

    info = repo_info(cwd)

    # 出力先ディレクトリと却下指紋リストを用意（reviewer は Write のみで済むよう先に作る）
    GLOBAL_DIR.joinpath("pending").mkdir(parents=True, exist_ok=True)
    DIGEST_DIR.mkdir(parents=True, exist_ok=True)
    global_rej = GLOBAL_DIR / "rejected-fingerprints.txt"
    global_rej.touch(exist_ok=True)

    repo_pending = repo_rej = None
    if info["is_repo"]:
        rp = Path(info["repo_root"]) / ".claude" / "context-reviews"
        (rp / "pending").mkdir(parents=True, exist_ok=True)
        repo_pending = str(rp / "pending")
        repo_rej = rp / "rejected-fingerprints.txt"
        repo_rej.touch(exist_ok=True)
        repo_rej = str(repo_rej)

    digest_path = DIGEST_DIR / f"{session_id}.json"
    digest_path.write_text(json.dumps(d, ensure_ascii=False, indent=2))

    ctx = {
        "session_id": session_id,
        "date": datetime.now().strftime("%Y-%m-%d"),
        "digest_path": str(digest_path),
        "transcript_path": transcript_path,
        "is_repo": info["is_repo"],
        "repo_root": info["repo_root"],
        "repo_name": info["repo_name"],
        "repo_id": info["repo_id"],
        "out_global_pending": str(GLOBAL_DIR / "pending"),
        "out_repo_pending": repo_pending,
        "rejected_global": str(global_rej),
        "rejected_repo": repo_rej,
    }
    launch_reviewer(ctx)
    return 0


if __name__ == "__main__":
    sys.exit(main())
