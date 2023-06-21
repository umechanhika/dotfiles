# セットアップ手順
## Macのセットアップ
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

### マウス・トラックパッド
- マウスの速度設定
  - `システム環境設定 > マウス > 軌跡の速さ > 初期値→最大`
- トラックパッドの速度設定
  - `システム環境設定 > トラックパッド > ポイントとクリック > 軌跡の速さ > 初期値→最大`

### 文字入力
- Caps Lockを入力ソース切り替えボタンにする(USキー限定)
  - `システム環境設定 > キーボード > テキスト入力の入力ソースの編集 > すべての入力ソース > Caps LockキーでABC入力モードと切り替える > OFF→ON`
- ライブ変換を無効化
  - `システム環境設定 > キーボード > テキスト入力の入力ソースの編集 > 日本語 - ローマ字入力 > ライブ変換 > ON→OFF`
- 数字の入力をデフォルトで半角する
  - `システム環境設定 > キーボード > テキスト入力の入力ソースの編集 > 日本語 - ローマ字入力 > 数字を全角入力 > ON→OFF`

### Dock
- Dockに使ったアプリケーションを表示しないようにする
  - `システム環境設定 > デスクトップとDock > 最近使ったアプリケーションをDockに表示 > ON→OFF`
- Dockをデフォルト非表示にする
  - `システム環境設定 > デスクトップとDock > Dockを自動的に表示/非表示 > OFF→ON`
- Dockから不要なアプリを削除

## zshからbashに変更
Run `chsh -s /bin/bash`

https://support.apple.com/ja-jp/HT208050

## gitのセットアップ
Run `git`

## ツール類のセットアップ
1. Clone this repository.
2. Run `sh ~/dotfiles/.bin/install.sh`

### Better Touch Tool
1. ライセンスファイルのインポート
2. プリセットのインポート

### iTerm2
Preferencesを読み込む

https://qiita.com/reoring/items/a0f3d6186efd11c87f1b
