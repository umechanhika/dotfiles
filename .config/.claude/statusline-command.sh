#!/bin/sh
input=$(cat)
branch=$(git -C "$(echo "$input" | jq -r '.workspace.current_dir // .cwd // empty')" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
export GIT_BRANCH="$branch"
echo "$input" | python3 -c "
import sys, json, os, subprocess

# ANSI color codes (bright/bold variants for readability)
RESET  = '\033[0m'
BOLD   = '\033[1m'
CYAN   = '\033[96m'   # bright cyan  -> directory name
GREEN  = '\033[92m'   # bright green -> model name
YELLOW = '\033[93m'   # bright yellow -> context info
RED    = '\033[91m'   # bright red   -> high usage warning (>= 80%)
MAGENTA= '\033[95m'   # bright magenta -> git branch
SEP    = '\033[37m'   # normal white -> separators

try:
    data = json.load(sys.stdin)
except Exception:
    data = {}

model = data.get('model', {}).get('display_name', 'unknown')
cwd = data.get('workspace', {}).get('current_dir') or data.get('cwd', os.getcwd())
dir_name = os.path.basename(cwd) if cwd else ''

branch = os.environ.get('GIT_BRANCH', '').strip()

ctx = data.get('context_window', {})
used_pct = ctx.get('used_percentage')

if used_pct is not None:
    used_int = round(used_pct)
    ctx_color = RED if used_int >= 80 else YELLOW
    token_info = f'{ctx_color}ctx: {used_int}%{RESET}'
else:
    token_info = f'{YELLOW}ctx: ready{RESET}'

rate_limits = data.get('rate_limits', {})

def rate_limit_segment(label, window):
    pct = window.get('used_percentage')
    if pct is None:
        return None
    pct_int = round(pct)
    color = RED if pct_int >= 80 else YELLOW
    return f'{color}{label}: {pct_int}%{RESET}'

rate_segments = [
    seg for seg in (
        rate_limit_segment('5h', rate_limits.get('five_hour', {})),
        rate_limit_segment('7d', rate_limits.get('seven_day', {})),
    )
    if seg is not None
]

if branch:
    dir_branch = f'{CYAN}{BOLD}{dir_name}{RESET}{SEP}({RESET}{MAGENTA}{branch}{RESET}{SEP}){RESET}'
else:
    dir_branch = f'{CYAN}{BOLD}{dir_name}{RESET}'

segments = [dir_branch, f'{GREEN}{model}{RESET}', token_info] + rate_segments
line = f' {SEP}|{RESET} '.join(segments)
print(line, end='')
"
