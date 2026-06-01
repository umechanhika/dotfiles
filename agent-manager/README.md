# Agent Manager

複数の Claude Code セッションの状態（🟡確認待ち / 🟢応答完了 / 🔵処理中 / ⚪待機）を、**常時最前面・全 Space 表示の小さなフローティングウィンドウ**で一覧するツール。行をクリックすると該当セッションのターミナル（iTerm2 / Android Studio 等）へジャンプする。

dotfiles の一部として `~/dotfiles/agent-manager/` で管理する（ビルド成果物 `.build/` は gitignore）。

## 仕組み

```
Claude Code の各セッション
   │ hooks
   ├─ SessionStart: agent-manager-launch.sh（未起動 or ソースが新しければ build & 起動）
   ▼
hooks/agent-manager-hook.sh ──▶ ~/.claude/agent-manager/sessions/<session_id>.json
                                       │ FSEvents で監視
                                       ▼
                                AgentManager（フローティング窓）
                                       │ クリック → ホスト別フォーカス
                                       ▼
                    iTerm2: 該当ペインを選択 / Android Studio等: 該当ウィンドウを前面化
```

- hook と Swift アプリはファイル経由でのみ連携する疎結合構成。状態ファイル（`~/.claude/agent-manager/sessions/`）はマシンローカルで dotfiles には含めない。
- 各セッションのホストアプリは hook が**プロセスツリーを遡って、ターミナルを内包する最も近い `.app` の bundle id**を解決して判定（iTerm2 / Android Studio 等）。`__CFBundleIdentifier` / `ITERM_SESSION_ID` は当てにしない（Android Studio を iTerm2 から `studio .` で起動すると、AS の統合ターミナル子プロセスがこれらに iTerm2 の値を継承してしまい誤判定するため）。`iterm_session_id` は host が iTerm2 と確定したときだけ記録する。
- 状態検知は Claude Code の hooks。マッピングは `hooks/agent-manager-hook.sh` の `STATE_BY_EVENT` で調整可能（例: `Stop` を `waiting` にすると応答完了を「確認待ち」扱いにできる）。
- アプリの起動は `SessionStart` フックの `agent-manager-launch.sh` が担う。未起動なら（必要に応じて release ビルドして）起動し、起動済みなら何もしない。セッション開始を遅延させないよう重い処理はバックグラウンドに逃がす。
- **pull した新コードの自動反映**: `.build/` は gitignore のため `git pull` ではソースだけ更新され、成果物 `.app` は古いまま残る。`agent-manager-launch.sh` は新規起動時（プロセス未起動時）に **ビルド入力（`Sources/` / `Package.swift` / `scripts/`）が成果物より新しいかを mtime で判定し、新しければ自動でリビルド**してから起動する。起動中の古いプロセスには触らない（全セッション終了で自動 exit するので、次の新規起動で新コードに切り替わる）。pull 直後にすぐ反映したい場合は下記「起動」の手動手順を参照。

## セットアップ

### 新規クローン時の流れ（推奨）

```
1. git clone <dotfiles> ~/dotfiles
2. sh ~/dotfiles/.bin/install.sh
     - settings.json / skills をシンボリックリンク（→ フック有効化）
     - scripts/create-signing-cert.sh で署名証明書を作成して信頼設定
       （信頼設定の認証ダイアログ＋キーチェーンPW入力あり。通常ターミナルで実行）
     - scripts/build-app.sh で署名済み .app をビルド
3. 新規 Claude Code セッションを開始
     - SessionStart フックで launch.sh が署名済み .app を起動
4. 初回フォーカス時のみ権限付与（下記「権限」を参照）
     - iTerm2: 許可ダイアログで「許可」
     - Android Studio: システム設定 > アクセシビリティ で AgentManager を手動ON
```

`install.sh` が上記 2 を全部やる。証明書作成（手順 2 の対話）以外は手動操作不要。
**証明書を作らずに `.app` をビルドしようとすると署名IDが無く失敗する**ので、
クローン時は必ず `install.sh`（または `create-signing-cert.sh`）を先に通すこと。

以降の各手順を手動でやる場合は次の通り。

### 1. hooks（dotfiles 管理済み）

hooks は `~/dotfiles/.config/.claude/settings.json`（`~/.claude/settings.json` へ install.sh が
シンボリックリンク）に登録済みなので、新環境でもそのまま有効。各 hook イベントが
`agent-manager-hook.sh`（状態書き込み）を、`SessionStart` は加えて `agent-manager-launch.sh`
（アプリ起動）を呼ぶ。

依存: `python3`（macOS 標準の `/usr/bin/python3` でOK）。`jq` は不要。

### 2. 署名証明書の作成 → ビルド（初回のみ。以降は launcher が必要時に自動ビルド）

```sh
bash ~/dotfiles/agent-manager/scripts/create-signing-cert.sh   # 署名IDを作成（初回のみ・冪等）
bash ~/dotfiles/agent-manager/scripts/build-app.sh             # 署名済み .app を生成
```

`build-app.sh` は安定した名前付き ID（`AgentManager Code Signing`）で署名する。
署名IDが無いとビルドは失敗し `~/.claude/agent-manager/build.log` にエラーを残す
（詳細は下記「権限 > コード署名証明書の作成」）。

### 3. 起動

新規 Claude Code セッションを開始すると `agent-manager-launch.sh` が自動で起動する。
ソースが成果物より新しければ（pull 直後など）起動前に自動でリビルドされる。
手動起動する場合:

```sh
~/dotfiles/agent-manager/hooks/agent-manager-launch.sh      # 未起動 or 古ければ build して起動（冪等）
# または直接 .app を:
/usr/bin/open ~/dotfiles/agent-manager/.build/AgentManager.app
```

#### pull した新コードを即時反映したいとき

新コードを pull した時点でアプリが起動中だと、その古いプロセスはそのまま動き続ける
（自動リビルドは新規起動時のみ）。すぐ差し替えたい場合は、起動中プロセスを終了して
から作り直す:

```sh
pkill -f "AgentManager.app/Contents/MacOS/AgentManager"   # 起動中の古いアプリを終了
bash ~/dotfiles/agent-manager/scripts/build-app.sh         # 最新ソースから .app を作り直す
/usr/bin/open -g ~/dotfiles/agent-manager/.build/AgentManager.app   # 起動
```

Dock には出ず（`.accessory`）、画面右上に小窓が常駐する。ウィンドウは背景ドラッグで移動可能。

## 状態の対応

| 表示 | 色 | state | 発火 hook | 意味 |
|------|----|-------|-----------|------|
| 確認待ち | 🟡 黄 | `waiting` | `Notification`（`permission_prompt`） | ツール許可 / プラン承認 / 選択肢回答など、**ユーザーの確認・操作が必要でブロック中** |
| 応答完了 | 🟢 緑 | `done` | `Stop` / `Notification`（`idle_prompt`） | Claudeのターンが終わり、**次の指示待ち**（完了後に放置されても緑のまま） |
| 処理中 | 🔵 青 | `processing` | `UserPromptSubmit` / `PreToolUse` / `PostToolUse` | 稼働中 |
| 待機 | ⚪ 灰 | `idle` | `SessionStart` | 開始直後でまだ何もしていない |

`Notification` は `notification_type` で扱いを分ける。`permission_prompt`（許可・プラン承認・選択肢回答の待ち）は確認待ち、`idle_prompt`（完了後の放置によるアイドル）は応答完了を維持する。`ExitPlanMode` / `AskUserQuestion` は `PreToolUse`（処理中）の後に `permission_prompt` が来るため、自然に確認待ちへ遷移する。

- 並び順は 確認待ち → 応答完了 → 処理中 → 待機（対応が必要なものが上）。
- セッション終了（`SessionEnd`）で一覧から消える。
- 30 分以上更新の無いエントリは薄く表示（hook 取りこぼし時の名残対策）。

## クリックでジャンプ（ホスト別）

クリックされたセッションの `host_bundle_id` に応じて挙動を変える。

| ホスト | 挙動 | 必要な権限 |
|--------|------|-----------|
| iTerm2 (`com.googlecode.iterm2`) | `ITERM_SESSION_ID` の GUID で該当ペインを AppleScript 選択＋前面化 | Automation（iTerm2 制御） |
| その他 (Android Studio `com.google.android.studio` 等) | System Events で全ウィンドウタイトルを列挙し、**該当プロジェクトのウィンドウを一意に特定できたときだけ** AXRaise（特定不能なら誤前面化しない） | Automation（System Events）＋ アクセシビリティ |

#### ウィンドウ特定ロジック（同一チケットの別ブランチ対策）

ワークツリーは同一チケットの別ブランチでプロジェクト名が前方一致しやすく、単純な部分一致
（title contains）だと別ウィンドウへ誤って飛ぶ。これを避けるため `ITermFocus.swift` は次の順で
**厳密に1件だけ**特定する（一意に決まらなければ前面化を見送る）:

1. **フルパス優先**: タイトルに `cwd`（一意なワークツリー絶対パス）を含むウィンドウが1件あれば採用。
   Android Studio の `Settings > Appearance & Behavior > Appearance > Show full path in window header`
   を ON にすると、この最も確実な方法でマッチする（推奨）。
2. **境界考慮のプロジェクト名一致**: フルパスで決まらなければ、タイトルが `label`（ワークツリー名）で
   始まり、直後が境界文字（空白・en-dash `–` 等。ASCII ハイフン `-` は branch 名の一部なので**境界に含めない**）の
   ウィンドウだけを候補にする。これで `feature-MBDEV-82` が `feature-MBDEV-82-...` に誤マッチしない。
3. 上記で候補が 0 件 / 複数のときは AXRaise せず、`focus.log` に理由を残す（勝手に新規プロジェクトを開かない）。

### 権限（重要）

iTerm2 や System Events を制御するには macOS の権限が必要。このため本アプリは
**`.app` バンドル**（`scripts/build-app.sh` が `.build/AgentManager.app` を生成、
安定したバンドルID＋名前付きコード署名）として `open` 起動する（TCC が許可を安定記憶できるように）。

- **iTerm2 セッション**: 初回クリックで「"AgentManager" が "iTerm2" を制御…」を **許可**。
- **Android Studio 等**: ウィンドウの列挙・選択に **アクセシビリティ権限** が必要。
  `システム設定 > プライバシーとセキュリティ > アクセシビリティ` で **AgentManager を ON**。
  未許可だとウィンドウを列挙できないため前面化は行われず、`focus.log` に権限付与を促すメッセージを残す。

#### コード署名証明書の作成（初回のみ・推奨）

ad-hoc 署名（`codesign --sign -`）は cdhash ベースの署名要件になるため、`.app` を
リビルドするたびに macOS が「別アプリ」とみなし、付与済みのアクセシビリティ／
Automation 権限が無効化される。これを防ぐため、安定した自己署名のコード署名証明書を
1 つ作っておく（`build-app.sh` が `AgentManager Code Signing` という名前の ID で署名する）。

```sh
bash scripts/create-signing-cert.sh
```

**通常のターミナル（Terminal.app / iTerm2）で実行すること**（Claude セッションの `!`
実行は対話入力ができないため不可）。このスクリプトは openssl で自己署名のコード署名
証明書を生成して login キーチェーンへ取り込み、コード署名用に信頼設定する
（冪等：既に有効な ID があれば何もしない。過去の失敗で残った重複証明書も掃除する）。
途中で次の認証が出る:

- **信頼設定の追加**: macOS の認証ダイアログ（Touch ID / ログインパスワード）。
- **鍵アクセス許可**: login キーチェーンのパスワードを尋ねる。空 Enter でスキップ可
  （その場合は初回 `codesign` 時に GUI で「常に許可」を押す）。`KEYCHAIN_PASSWORD=xxx`
  を付けて実行すれば対話入力なしで設定できる。

- 作成後 `bash scripts/build-app.sh` がこの ID で署名する。
- 署名 ID を切り替えた直後は一度だけアクセシビリティ権限の再付与が必要
  （`システム設定 > アクセシビリティ` で AgentManager を一旦削除して再追加）。
- GUI で作りたい場合は キーチェーンアクセス >
  `証明書アシスタント > 証明書を作成…` で 名前=`AgentManager Code Signing`・
  証明書のタイプ=`コード署名` を選んでも同じ。

> **ad-hoc 署名へのフォールバックはしない。** 黙って ad-hoc に落ちると「リビルドで
> 権限が消える」問題に気付けないため、署名IDが無ければビルドは**失敗**し、
> `~/.claude/agent-manager/build.log` にエラーを残す。ランチャー経由（`launch.sh`）の
> 自動ビルドで失敗したときは、この `build.log` を見れば原因が分かる。
- フォーカスの成否は `~/.claude/agent-manager/focus.log` に記録
  （マッチ方式 `via=fullpath`/`via=label`・採用 `title`・`raised` / `no unique window match` / `status`/`err`）。

## ファイル構成

```
hooks/agent-manager-hook.sh     状態ファイルの upsert（python3 利用、全hookから呼ばれる）
hooks/agent-manager-launch.sh   SessionStart用: 未起動なら .app をbuild & open起動（冪等）
scripts/build-app.sh            release build → 最小 .app バンドル生成（Info.plist+名前付き署名。IDが無ければ失敗）
scripts/create-signing-cert.sh  署名用の自己署名コード署名証明書を作成（初回のみ・冪等）
Package.swift
Sources/AgentManager/
  main.swift                    NSApplication / フローティング NSPanel
  ContentView.swift             セッション一覧 UI（SwiftUI）
  SessionStore.swift            sessions/ の FSEvents 監視 + JSON 読込
  ITermFocus.swift              クリック → ホスト別フォーカス（iTerm2ペイン / 他アプリのウィンドウ）+ focus.log
.build/                         ビルド成果物・AgentManager.app（gitignore）
```

## 将来の拡張

- **ログイン項目での常駐**: 現状は `SessionStart` ランチャーが起動を担保。`.build/AgentManager.app` を
  ログイン項目に追加すれば Claude Code 起動前から常駐させられる。
