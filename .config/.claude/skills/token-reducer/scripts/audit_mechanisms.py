"""audit_mechanisms — 既存メカニズム(hook/plugin/skill/CLAUDE.md)と
ローカル apply_log の検出。重複・適用済み再提案を防ぐための静的サーフェス。
"""

import json
from pathlib import Path

from audit_common import MECHANICAL_MARKERS


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
        skill_dirs = sorted(
            (p for p in skills_root.iterdir()
             if p.is_dir() and (p / "SKILL.md").exists()),
            key=lambda p: p.name)
        out["skills"] = [skill_scriptability(p) for p in skill_dirs]
    return out


def skill_scriptability(skill_dir):
    """スキルの決定論的手続きがスクリプト化されているかの静的判定材料（観点13）。

    決定論的処理（集計・パース・整形等）を毎回 LLM に再実行させると起動のたびに
    トークンを再課金する。SKILL.md にその種の機械的手順を示すキーワードがあり、かつ
    scripts/ が無いものを「未スクリプト化の候補」として surface する。
    """
    name = skill_dir.name
    md = skill_dir / "SKILL.md"
    try:
        text = md.read_text()
        md_lines = len(text.splitlines())
    except Exception:
        text = ""
        md_lines = None
    scripts_dir = skill_dir / "scripts"
    script_files = []
    if scripts_dir.is_dir():
        script_files = sorted(p.name for p in scripts_dir.iterdir() if p.is_file())
    markers = [m for m in MECHANICAL_MARKERS if m in text]
    return {
        "name": name,
        "skill_md_lines": md_lines,
        "has_scripts": bool(script_files),
        "script_files": script_files,
        "mechanical_markers": markers,
        # 機械的手順を述べているのにスクリプトが無い＝スクリプト化候補（要 LLM 判定）
        "scriptable_candidate": bool(markers) and not script_files,
    }


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
