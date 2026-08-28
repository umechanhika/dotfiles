# Android Studio 設定（版管理分のみ）

Android Studio の `File > Manage IDE Settings > Export Settings` で書き出した設定一式のうち、
機密情報・端末固有情報を含まないファイルだけを抜粋して置いている。

対象は以下。

- キーマップ（`macOS copy 1` が有効。ポインタは `options/mac/keymap.xml`）
- ツールウィンドウ配置（`options/window.layouts.xml` の名前付きレイアウト `Custom`）
- エディタの見た目（配色スキーム・フォント設定・インレイヒント等）

## 書き出し手順（設定を変えたとき）

1. Android Studio で設定を変更する。ツールウィンドウ配置を変えた場合は
   `Window > Layouts > Custom > Save Changes` で `Custom` に焼き直す
   （`Custom` が選択中でない場合は先に `Apply` してから配置し直す）。
2. `File > Manage IDE Settings > Export Settings` で任意の場所へエクスポートし、zip を展開する。
3. 下記「対象ファイル」の一覧だけをこのディレクトリへ上書きコピーする。
4. `git diff` で意図した変更以外が混ざっていないか確認してからコミットする
   （pre-commit-leak-check スキル経由で承認を取る）。

## 取り込み手順（このリポジトリの設定を Android Studio に反映するとき）

1. このディレクトリの中身をそのまま zip に固める（`IntelliJ IDEA Global Settings` の
   空マーカーファイルを zip 直下に含めること。これが無いと Android Studio が
   設定 zip として認識しない）。
2. `File > Manage IDE Settings > Import Settings…` でその zip を選択する。
3. 反映先の設定ディレクトリは `~/Library/Application Support/Google/AndroidStudio*` のうち
   最新バージョンのもの。

## 対象ファイルと選定理由

| ファイル | 内容 |
|---|---|
| `IntelliJ IDEA Global Settings` | 空。zip を設定アーカイブとして認識させるためのマーカー |
| `keymaps/macOS copy 1.xml` | 有効キーマップの本体（独自ショートカット） |
| `options/mac/keymap.xml` | 有効キーマップ名へのポインタ |
| `options/keymapFlags.xml` | キーマップ一覧のメタ情報 |
| `options/window.layouts.xml` | ツールウィンドウ配置（名前付きレイアウト `Custom`） |
| `options/colors.scheme.xml` | 配色スキームの選択 |
| `options/editor-font.xml` | エディタフォント設定 |
| `options/editor.xml` | インレイヒント・ソフトラップ等のエディタ挙動 |
| `options/terminal-font.xml` | ターミナルフォント設定 |
| `options/terminal.xml` | ターミナル設定（シェルパス等）。利用回数カウンタを含むため再エクスポートのたびに差分が出るが想定内 |
| `options/terminal-local.xml` | ターミナルのシェルパス（ローカル設定） |
| `options/ui.lnf.xml` | UI 設定（プレビュータブ等） |
| `options/experimentalUI.xml` | 実験的 UI の有効化フラグ |

## 意図的に含めていないファイル

エクスポートには機密情報・端末固有情報・今回の管理範囲外の情報を含むファイルが
多数含まれる。以下は含めない。

| ファイル | 除外理由 |
|---|---|
| `options/trusted-paths.xml` | 業務リポジトリのパス一覧 |
| `options/jdk.table.xml` | 端末固有の絶対パス |
| `options/github.xml` / `options/github-copilot.xml` | アカウント情報 |
| `options/googleLoginApplicationSettings.xml` | ログイン情報 |
| `options/androidLogcatFilterHistory.xml` | 業務ログの検索履歴 |
| `options/find.xml` / `options/findUsages.xml` / `options/abbrevs.xml` | 検索・入力履歴 |
| `options/settingsSync.xml` / `options/androidStudioFirstRun.xml` / `options/updates.xml` | 環境固有・管理する意味がない |
| `options/window.state.xml` | ウィンドウの物理位置・サイズ。画面構成に依存する |
| `keymaps/macOS copy.xml` | 空定義（未使用のキーマップ） |
| `codestyles/` / `inspection/` | 今回の管理範囲外 |
| `installed.txt` | 今回の管理範囲外 |

## 既知の制約

- 新規に開くプロジェクト（新規ワークツリーを含む）は、初回起動時に `options/window.layouts.xml`
  の名前付きレイアウト `Custom` の配置を**自動で**引き継ぐ。実機検証済み（新規ワークツリーの
  IDE 側プロジェクト状態ファイルに `Custom` 由来の `weight` / `sideWeight` / `content_ui` が
  そのまま反映されることを確認）。手動で `Apply` / `Restore` する必要はない。
  この挙動は非公式（`Default` レイアウトは工場出荷値で上書き不可、というドキュメント上の
  制約とは別の経路）なので、Android Studio のバージョンが上がった際は再確認すること。
- `options/window.layouts.xml` の `Custom` レイアウトには、位置・順序・幅だけでなく
  そのときの開閉状態・最大化・フローティング位置なども含まれる。これらは
  エクスポートするたびに変わりうる（想定内の差分）。
