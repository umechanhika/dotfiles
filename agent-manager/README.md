# Agent Manager

iTerm2 で同時に走らせている複数の Claude Code セッションの状態（🟡確認待ち / 🟢処理中 / ⚪待機）を、**常時最前面・全 Space 表示の小さなフローティングウィンドウ**で一覧するツール。行をクリックすると該当の iTerm2 ペインへジャンプする。

dotfiles の一部として `~/dotfiles/agent-manager/` で管理する（ビルド成果物 `.build/` は gitignore）。

## 仕組み

```
Claude Code の各セッション
   │ hooks
   ├─ SessionStart: agent-manager-launch.sh（未起動なら build & 起動）
   ▼
hooks/agent-manager-hook.sh ──▶ ~/.claude/agent-manager/sessions/<session_id>.json
                                       │ FSEvents で監視
                                       ▼
                                AgentManager（フローティング窓）
                                       │ クリック → osascript
                                       ▼
                                iTerm2 の該当ペインを前面化
```

- hook と Swift アプリはファイル経由でのみ連携する疎結合構成。状態ファイル（`~/.claude/agent-manager/sessions/`）はマシンローカルで dotfiles には含めない。
- 状態検知は Claude Code の hooks。マッピングは `hooks/agent-manager-hook.sh` の `STATE_BY_EVENT` で調整可能（例: `Stop` を `waiting` にすると応答完了を「確認待ち」扱いにできる）。
- アプリの起動は `SessionStart` フックの `agent-manager-launch.sh` が担う。未起動なら（必要に応じて release ビルドして）起動し、起動済みなら何もしない。セッション開始を遅延させないよう重い処理はバックグラウンドに逃がす。

## セットアップ

`~/dotfiles/.bin/install.sh` が以下をまとめて行う（hooks は `.config/.claude/settings.json` に登録済み、初回 release ビルドも実行）。手動でやる場合は次の通り。

### 1. hooks を登録（dotfiles 管理）

`settings-hooks.snippet.json` の `hooks` ブロックを `~/.claude/settings.json`
（dotfiles 実体: `.config/.claude/settings.json`）にマージする。

依存: `python3`（macOS 標準の `/usr/bin/python3` でOK）。`jq` は不要。

### 2. ビルド（初回のみ。以降は launcher が必要時に自動ビルド）

```sh
swift build --package-path ~/dotfiles/agent-manager -c release
```

### 3. 起動

新規 Claude Code セッションを開始すると `agent-manager-launch.sh` が自動で起動する。
手動起動する場合:

```sh
~/dotfiles/agent-manager/hooks/agent-manager-launch.sh      # 未起動なら起動（冪等）
# または直接:
~/dotfiles/agent-manager/.build/release/AgentManager &
```

Dock には出ず（`.accessory`）、画面右上に小窓が常駐する。ウィンドウは背景ドラッグで移動可能。

## 状態の対応

| 表示 | state | 発火 hook |
|------|-------|-----------|
| 🟡 確認待ち | `waiting` | `Notification`（権限プロンプト等） |
| 🟢 処理中 | `processing` | `UserPromptSubmit` / `PreToolUse` / `PostToolUse` |
| ⚪ 待機 | `idle` | `SessionStart` / `Stop` |

- セッション終了（`SessionEnd`）で一覧から消える。
- 30 分以上更新の無いエントリは薄く表示（hook 取りこぼし時の名残対策）。

## クリックでジャンプ

`SessionStart` 時に環境変数 `ITERM_SESSION_ID`（`wNtMpK:GUID`）の GUID 部分を記録し、
クリック時に AppleScript（`osascript`）で該当セッションを検索して前面化する。
初回クリック時に macOS が「自動化」の許可を求めることがあるので許可する。

## ファイル構成

```
hooks/agent-manager-hook.sh     状態ファイルの upsert（python3 利用、全hookから呼ばれる）
hooks/agent-manager-launch.sh   SessionStart用: 未起動なら build & 起動（冪等）
Package.swift
Sources/AgentManager/
  main.swift                    NSApplication / フローティング NSPanel
  ContentView.swift             セッション一覧 UI（SwiftUI）
  SessionStore.swift            sessions/ の FSEvents 監視 + JSON 読込
  ITermFocus.swift              クリック → iTerm2 前面化（AppleScript）
settings-hooks.snippet.json     settings.json にマージする hooks 設定
.build/                         ビルド成果物（gitignore）
```

## 将来の拡張

- **.app 化**: `swift build -c release` の成果物を `AgentManager.app` に包んで `~/Applications/` へ配置し、ログイン項目で自動起動する方向。現状は `SessionStart` ランチャー方式を採用。
