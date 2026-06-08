---
name: token-reducer
description: >-
  過去全 Claude Code セッションを横断監査し、構造的に繰り返すトークンの無駄を恒久メカニズム
  （hook / settings.json / skill / サブエージェント / CLAUDE.md）に変換した改善案＋実行計画を作り、承認後に適用する。
model: opus
---

# Token Reducer

全セッションを横断監査して構造的な無駄を恒久メカニズムへ変換する。**このスキル自身の消費も抑える**ため、
scout → deep-read（段階2への遅延詳細化）で進める。

## 自己消費を抑える進め方（scout → deep-read）

全セッション（数十ファイル・十数MB）の生ログをこの会話に読み込んではいけない。本末転倒になる。

1. **digest 取得（決定論・LLM不使用）**：
   ```bash
   python3 "${CLAUDE_SKILL_DIR}/scripts/token-audit.py"
   ```
   全セッションを集計した JSON を返す。主な項目：
   - `summary`：総セッション数。`total_output_tokens` は **メイン会話＋サブエージェント**の合算で、`main_output_tokens` と `subagent`（消費トークン・全体比 `share_pct`・モデル別 `by_model`）に内訳される（委任は別モデル＝多くは haiku で動くため、委任提案はこのコストと天秤にかける）。`by_project` は **正規 git リポジトリ root 単位**で集約（worktree もサブディレクトリも本体リポへ畳む。元 cwd は `folded_paths`）。
   - `signals`：14観点に対応した検出値。各シグナルは候補セッションIDと `applies`（該当有無）を持つ。
   - `existing_mechanisms`：既存 hook / 有効プラグイン / skill 一覧 / CLAUDE.md 行数（**重複・適用済みの再提案を防ぐ**）。`skills` は各スキルの `skill_md_lines`・`has_scripts`・`script_files`・`mechanical_markers`・`scriptable_candidate`（機械的手順の記述があるのに scripts/ が無い＝観点13候補）を含む。
   - `apply_log`：過去の適用変更と適用日（縦断検証の基準・端末ローカル保存）。書式・保存先は適用時に `reference.md` 参照。
   - `scanned.effective_cutoff`：`--since-days`/`--since-last-apply` 適用後に実際に使われた集計開始日時（未指定なら null）。
   - オプション：`--since-days N` / `--project 名` / `--split-date YYYY-MM-DD`（適用前後比較）/ `--since-last-apply`（前回適用日以降だけ集計＝新規診断用）。**`--split-date`（効果検証）と `--since-last-apply`（新規診断スコープ）は別用途・併用しない**（併用すると `--since-last-apply` が before 区間を消し検証が壊れる）。2回目以降の運用手順は `reference.md`。
2. **deep-read は段階2（選択後）のみ**：段階1は `signals` だけで全 finding を軽量ランク化し deep-read しない。選ばれた案だけ、候補セッションIDをサブエージェントに渡して該当 `.jsonl` を精読させ、メインスレッドは**要約だけ**受領する。判定が要る観点（4・5・6・12）はランク段階では**確証レベル B（要 deep-read）**とし、確証・精緻化は選択後に行う。

## 評価：データ駆動 ＋ 14観点をレンズに

`signals` と `summary.by_project` を**実測消費の大きい順**に並べ、横断出現回数で構造性を確認する。
そのうえで14観点を一巡し、各観点を**見落とし防止のレンズ**として使う。

**重要**：`applies: false` の観点は**正直に「該当なし」**と書く。問題を捏造しない。
例えばこの環境では CLAUDE.md は十分短く（観点8）、モデルはほぼ Opus 一択（観点1）なので該当しないことが多い。無理に改善案をひねり出すのは害。

| # | 観点 | 主な根拠（digest 内） |
|---|------|----------------------|
| 1 | セッション目的に合わないモデル | `signals.model_distribution`（軽微セッションの opus 使用候補） |
| 2 | スキル目的に合わないモデル | `signals.skill_invocations` |
| 3 | CLI で済むのに MCP 使用 | `signals.mcp_usage`（`cli_replaceable` フラグ） |
| 4 | コードインテリジェンス未使用 | `signals.code_intelligence`（コードファイル多読セッション→LSP候補） |
| 5 | hook 前処理の欠如 | `signals.hook_preprocessing`（反復する大出力） |
| 6 | 頻出指示・再利用 context の skill 未移動 | `signals.repeated_instructions.clusters` |
| 7 | CLAUDE.md の workflow 指示が skill 未移動 | `existing_mechanisms.claude_md_lines` ＋本文を精読判定 |
| 8 | CLAUDE.md > 200行 | `existing_mechanisms.claude_md_lines` |
| 9 | 詳細操作の subagent 未委任 | `signals.subagent_delegation`（高コンテキストかつ Agent 0） |
| 10 | ファイル読取が最小化されていない | `signals.file_read_minimization`（大容量full読み・反復読み） |
| 11 | 複雑タスクでプランモード未使用 | `signals.plan_mode` |
| 12 | 検証可能なゴール未設定 | 候補セッションのプロンプトを精読判定 |
| 13 | スキル/サブエージェントの決定論的手続きが未スクリプト化 | `existing_mechanisms.skills`（`scriptable_candidate: true`。最終判定は SKILL.md 本文を精読） |
| 14 | skill/script ソースが過大（モジュール未分割） | `signals.large_skill_sources`（`threshold_chars` 超の `*.js`/`*.py`/`*.css`。`*.min.js` 除外） |

## 改善案は必ず「仕組み」に変換する

行動アドバイス（「プランモードを使うよう心がける」）で終わらせない。記憶に依存し再現しないため。
各 finding を以下のいずれかの**恒久メカニズム**に落とす。`existing_mechanisms` と照合し、既存・適用済みは除外する。

- **hook**（`settings.json`）：大出力の前処理フィルタ（PreToolUse/PostToolUse）、起動時の注意喚起（SessionStart）など。
- **settings.json**：不要 MCP/プラグインの無効化、効率の良い既定の固定。
- **skill**：頻出する手順・再利用コンテキストを skill 本体やスクリプトへ昇格（その場限りの抽出を常設化）。
- **サブエージェント**：verbose な操作（ログ取得・doc fetch・広域調査）の委譲で詳細出力をメイン会話から隔離。
- **CLAUDE.md**：スリム化・skill 移譲・コンパクション保持指示など。
- **LSP プラグイン**：typed 言語で grep+複数読み → go-to-definition に置換。
- **スクリプト（観点13）**：決定論的手続き（＝同入力で出力一意：集計/パース/整形/カウント/機械変換）を LLM から切り出す。非決定（判断/評価/設計/NL生成）は LLM が担う。**反復・常設のものだけ対象**（単発はスクリプト化しない）。既存実例は `token-audit.py`。
- **モジュール分割（観点14）**：過大な skill/script ソースを責務別に分割し、各 skill に**モジュールマップ（責務→ファイル）を併設**（マップが無いと全モジュール読みに戻り削減が消える＝分割とマップは常にセット）。Read 横取り hook（再読抑制）は edit 後の stale/正当な再読を誤爆し correctness を損なうため**採らない**。

行動でしか直せない観点（モデル選択・プランモード）も、可能な限り SessionStart hook での注意喚起や
statusline 表示で**仕組みに寄せる**。寄せられないものは「**仕組み化不可・行動依存**」と明示して区別する。

## 品質ゲート（全て満たすものだけ提案）

- **構造的必然性**：複数セッションで反復している（単一セッションでは構造的か偶発的か判定できない）。横断出現回数が根拠。単一トピック限定の偶発消費、母数が小さく判定が弱いものは見送る。
- **継続的削減**：毎ターン再課金される変動コンテキスト、または恒久的に効く設定変更。単発で数百トークンは対象外。
- **具体的に実行可能**：対象ファイル/行/フック/コマンドまで落とし、適用できるコード片・設定スニペットを含める。

## 出力フォーマット（2段階・遅延詳細化）

固定費（digest 読込＋14観点一巡）は1回だけ払って全案を軽量提示し、高コストな deep-read／ドラフト生成は
**ユーザーが選んだ案だけ**に限定する（適用しない案に詳細生成を払わない）。
段階2に進む際は先に `${CLAUDE_SKILL_DIR}/reference.md`（2回目以降の運用・効果検証手順・apply_log 書式）を読む。

```
## 段階1: 横断診断＋改善案ランクリスト（一括・固定費1回）
digest の数値を引用し、全 finding を実測消費の大きい順にランク。各行は:
順位 / 観点# / signal / N セッションで発生・概算 X トークン / 一行メカニズム案 /
確証レベル（A=digest 確定, B=要 deep-read）。
14観点を一巡し、該当なしの観点は「該当なし」と明記。価値ある提案が一つも無ければ「特になし」。
※ ここでは deep-read もドラフトコード片生成もしない。

（ユーザーがどの案を詳細化・適用するか選択 → 段階2へ）

## 段階2: 選択された案の詳細化＋適用
選ばれた finding だけ、以下を提示する:
- 原因（必要時のみ候補セッションを deep-read して確認）→ 変換先メカニズム
  （hook/settings/skill/サブエージェント/CLAUDE.md）→ 適用ファイル/設定のドラフト（コード片）→ 静的削減見積り。
- 実行計画: 適用先（repo / dotfiles global）・適用順序・破壊的変更の有無・依存関係・トークンインパクト順。
- 検証方法: (a) 提案時の静的見積り、(b) 適用後 --split-date による縦断比較（手順は reference.md）。
```

## 承認後の適用と記録

- 段階1のランクリスト提示後、**どの案を詳細化・適用するかをユーザーに確認**する（AskUserQuestion 等）。選ばれた案だけ段階2へ進める。
- ユーザー承認を得てから hook / settings.json / skill / CLAUDE.md を実際に編集する。**破壊的変更は個別に確認**し、分割等は1ファイルずつ適用して都度動作確認する。
- 適用後、変更内容と適用日を apply_log に追記する（書式・保存先は `reference.md`）。効果は**後日**新セッションが溜まってから `--split-date <適用日>` で縦断比較する（過去履歴は不変＝即時再実行では before/after 同値。詳細手順は `reference.md`）。
- **履歴は削除しない**（横断監査の自滅＝次回データ枯渇・縦断検証不能、`--resume` 不可、監査証跡の不可逆喪失を招く）。古い既出パターンの除外は `--since-last-apply` のスコープで行い、保持期間は `settings.json` の `cleanupPeriodDays` に委ねる。
