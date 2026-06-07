# token-audit モジュールマップ

`token-audit.py` を責務ごとに分割したモジュール群。保守時は該当する小さな
ファイルだけを読めば済むようにしてある。

実行/import のエントリポイントは **`token-audit.py`**。path 起動
（`python3 .../scripts/token-audit.py`）のため `sys.path[0]` が `scripts/` になり、
兄弟モジュール（`audit_*.py`）を `from audit_xxx import ...` で直接 import できる。

## 責務 → ファイル

| 責務 | ファイル |
| --- | --- |
| エントリポイント。引数解析・セッション走査(`iter_session_files`)・`main()`・digest 組み立て | `token-audit.py` |
| 共有基盤。しきい値/定数(`LARGE_READ_CHARS` 等)・純粋ヘルパー(`block_len`/`human_text`/`looks_injected`/`parse_ts`/`est_tokens`)・`MECHANICAL_MARKERS`/`_WT_SUFFIX`。兄弟非依存 | `audit_common.py` |
| cwd を正規 git リポジトリ root へ解決（worktree/サブディレクトリの統合、削除済みは文字列推定） | `audit_repo.py` |
| セッション/サブエージェント JSONL の防御的パースと集計(`parse_session`/`rollup_subagents`/`add_tools`) | `audit_parse.py` |
| 既存メカニズム検出(hook/plugin/skill/CLAUDE.md)とローカル `apply_log` の読み込み | `audit_mechanisms.py` |
| セッション群 → 観点別の監査シグナル集約・プロンプトクラスタリング・過大ソース走査 | `audit_signals.py` |
| 全体サマリ(`summarize`)と縦断比較(`split_summary`, `--split-date`) | `audit_summary.py` |

## 依存関係

```
token-audit.py
 ├─ audit_common      (依存なし)
 ├─ audit_parse       → audit_common
 ├─ audit_repo        → audit_common
 ├─ audit_signals     → audit_common
 ├─ audit_summary     (依存なし)
 └─ audit_mechanisms  → audit_common
```
