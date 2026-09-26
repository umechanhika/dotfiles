# セットアップ手順
## 💻Macのセットアップ
以下の環境に準拠。
| 項目 | 値 |
| --- | --- |
| 本体 | MacBookPro 14インチ、2021 |
| OS | macOS Ventura 13.4 |
| チップ | Apple M1 Pro |

### 外観
- ダークモードの設定
  - `システム環境設定 > 外観 > 外観モード > ダーク`

### 操作
- ホットコーナーの設定
  - `システム環境設定 > デスクトップとDock > ホットコーナー`
    - `左上:Mission Control`
    - `左下:Mission Control`
    - `右上:Mission Control`
    - `右下:デスクトップ`

### マウス
- カーソル速度
  - `システム環境設定 > マウス > 軌跡の速さ > 初期値→最大`
- スクロール速度
  - `システム環境設定 > マウス > スクロールの速さ > 初期値→最大`

### トラックパッド
- カーソル速度
  - `システム環境設定 > トラックパッド > ポイントとクリック > 軌跡の速さ > 初期値→最大`
- クリック強弱
  - `システム環境設定 > トラックパッド > ポイントとクリック > クリック > 初期値→弱い`

### 文字入力
- Caps Lockを入力ソース切り替えボタンにする(USキー限定)
  - `システム環境設定 > キーボード > テキスト入力の入力ソースの編集 > すべての入力ソース > Caps LockキーでABC入力モードと切り替える > OFF→ON`
- 自動ピリオド入力を無効化
  - `システム環境設定 > キーボード > テキスト入力の入力ソースの編集 > すべての入力ソース > スペースバーを2回押してピリオドを入力 > ON→OFF`
- ライブ変換を無効化
  - `システム環境設定 > キーボード > テキスト入力の入力ソースの編集 > 日本語 - ローマ字入力 > ライブ変換 > ON→OFF`
- 数字の入力をデフォルトで半角する
  - `システム環境設定 > キーボード > テキスト入力の入力ソースの編集 > 日本語 - ローマ字入力 > 数字を全角入力 > ON→OFF`
- ユーザ辞書をインポートする
  - [ユーザ辞書ファイル](https://github.com/umechanhika/dotfiles/blob/main/.config/text-substitutions-mac.plist)をダウンロード
  - `システム環境設定 > キーボード > テキスト入力のユーザ辞書 > ユーザ辞書ファイルをドラッグ&ドロップ`

### Dock
- Dockに使ったアプリケーションを表示しないようにする
  - `システム環境設定 > デスクトップとDock > 最近使ったアプリケーションをDockに表示 > ON→OFF`
- Dockをデフォルト非表示にする
  - `システム環境設定 > デスクトップとDock > Dockを自動的に表示/非表示 > OFF→ON`
- Dockから不要なアプリを削除

### メニューバー
- 表示要素の設定
  - `システム環境設定 > コントロールセンター > コントロールセンターモジュール`
    - `Wi-Fi:メニューバーに非表示` 
    - `Bluetooth:メニューバーに非表示`
    - `AirDrop:メニューバーに非表示`
    - `集中モード:メニューバーに非表示`
    - `ステージマネージャ:メニューバーに非表示`
    - `画面ミラーリング:メニューバーに非表示`
    - `ディスプレイ:メニューバーに非表示`
    - `サウンド:メニューバーに非表示`
    - `再生中:メニューバーに非表示`
- バッテリー割合を表示する
  - `システム環境設定 > コントロールセンター > その他のモジュール > バッテリー > 割合(%)を表示 > OFF→ON`
- 時計に日付・曜日・秒数を表示する
  - `システム環境設定 > コントロールセンター > メニューバーのみ > 時計のオプション`
    - `日付 > 日付を表示 > 常に表示`
    - `日付 > 曜日を表示 > OFF→ON`
    - `時刻 > 24時間表示にする > OFF→ON`
    - `時刻 > 秒を表示 > OFF→ON`
- 入力ソースを非表示にする
  - `システム環境設定 > キーボード > テキスト入力の入力ソースの編集 > すべての入力ソース > メニューバーに入力ソースを表示 > ON→OFF`

### Touch ID
- 指紋登録
  - `システム環境設定 > Touch IDとパスコード > Touch IDを使ってMacのロックを解除 > OFF→ON > 指紋を追加`

## ⚙️システムのセットアップ
### git
- Run `git`

### インストールスクリプトの実行
- Clone this repository.
- Run `sh ~/dotfiles/.bin/install.sh`

install.sh は以下のツールを自動でクローン・ビルドする:
- [agent-manager](https://github.com/umechanhika/agent-manager) → `~/agent-manager`
- [window-snap](https://github.com/umechanhika/window-snap) → `~/window-snap`

## ☁️リモート環境のセットアップ
Claude Code on the web のコンテナでも、グローバル設定・スキル・アウトプットスタイルを揃える。

環境設定の setup script には次だけを書く。残りはリポジトリ側のスクリプトが持つ。

```sh
#!/bin/bash
set -euo pipefail
[ -d ~/.dotfiles ] || git clone --depth=1 https://github.com/umechanhika/dotfiles ~/.dotfiles
bash ~/.dotfiles/.bin/claude-remote-setup.sh --update
```

このリポジトリは public である必要がある。setup script の実行時点では
セッションの GitHub 認証が使えず、GitHub への通信はプロキシが認証情報を
差し替えるため、トークンを渡しても private リポジトリは clone できない。

claude-remote-setup.sh がやること:
- dotfiles のクローン取得（`--update` を付けると既存のクローンを最新化する）
- CLAUDE.md・skills・output-styles を `~/.claude` へリンク
- アウトプットスタイルの指定を、リモート側の設定へマージ
- セッション開始時にクローンを最新化する hook の登録

補足:
- settings.json は macOS 専用の hook・statusLine を含むため、丸ごとは持ち込まない。
- スキルはコピーではなくリンクにして、クローンの更新に追従させる。
- クローン元・クローン先は `DOTFILES_REPO`・`DOTFILES_DIR` で差し替えられる。

## 🪛ツール類のセットアップ
### BetterTouchTool
- ライセンスファイルのインポート
- プリセットのインポート

### iTerm2
- Preferencesを読み込む:[参考記事](https://qiita.com/reoring/items/a0f3d6186efd11c87f1b)

### Karabiner-Elements
USキーでもHHKBライクに`control + space`で入力モードを切り替えられるように`caps lock`を`control`に置き換える。

- `Simple Modifications`で`caps lock`を`left_control`に変更
