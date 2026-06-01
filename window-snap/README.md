# WindowSnap

ウィンドウをマウスで画面端へドラッグして離すと、その端に応じてサイズ/位置にスナップする
軽量な常駐ユーティリティ。BetterTouchTool の「ビルトイン・ウィンドウスナッピング」機能だけを
置き換えることを目的にした最小実装。

## できること

タイトルバーを掴んでドラッグし、カーソルが画面端ゾーンに入った状態でマウスを離すとスナップする
（**修飾キー不要**）:

| ドラッグ先 | 結果 |
|-----------|------|
| 上端（隅以外の全幅） | 画面いっぱい（最大化。menubar/Dock は侵食しない） |
| 左端 / 右端 | 左半分 / 右半分 |
| 四隅（各辺の端寄り） | 左上 / 右上 / 左下 / 右下 の 1/4 |

- ドラッグ中、スナップ先を半透明の白いハイライトで予告表示する（プレビュー）。
- `visibleFrame` ベースなので menubar / Dock を避ける。
- マルチディスプレイ対応（カーソルがある画面にスナップ）。
- 端付近で「少しだけ」動かして離した場合はスナップしない（誤爆防止 / `MOVE_THRESHOLD`）。
- イベントは `listenOnly` で観測するだけなので、他アプリの操作を一切邪魔しない。

## 仕組み

```
CGEventTap(listenOnly でマウスを観測)
  ├─ leftMouseDown    → 対象ウィンドウを確定（カーソル直下→失敗時 最前面focused）+ タイトルバー掴み判定
  ├─ leftMouseDragged → 現在ゾーンのスナップ先プレビューを表示（AX 呼び出しなし・差分更新）
  ├─ leftMouseUp      → 端ゾーン & 移動量>しきい値 のとき Accessibility API でスナップ
  └─ tapDisabled / スペース切替 → ドラッグ中断とみなしプレビューを片付ける
```

ファイル構成（`Sources/WindowSnap/`）:

| ファイル | 責務 |
|---------|------|
| `main.swift` | NSApplication(.accessory) 起動・権限確認ループ・SIGTERM 対応 |
| `event_tap.swift` | CGEventTap の生成・runloop 組み込み・無効化時の自動再有効化＋通知 |
| `window_dragger.swift` | ドラッグ状態機械（down/drag/up）。対象確定→ゾーン判定→プレビュー→snap |
| `ax_window.swift` | Accessibility ラッパ（対象取得 / position・size set / タイトルバー判定） |
| `snap_zone.swift` | ゾーン定義とカーソル座標→ゾーン判定（しきい値・隅と辺） |
| `geometry.swift` | 座標変換の単一集約点（CG global ↔ Cocoa）+ ゾーン矩形算出 |
| `screen_util.swift` | カーソル下の NSScreen 特定 / frame・visibleFrame 取得 |
| `overlay_window.swift` | スナップ先プレビューの半透明オーバーレイ（.transient で Mission Control 中は自動退避） |
| `status_item.swift` | メニューバー常駐（終了 / アクセシビリティ設定を開く） |

### 座標系について（最重要）

3 つの座標系が登場する:

| 系 | 原点 | Y方向 |
|----|------|-------|
| CGEvent / Accessibility | 画面左上 | 下向き |
| Cocoa(NSScreen) | メイン画面左下 | 上向き |

CGEvent と Accessibility は同じ系なので、**カーソル座標→ウィンドウ取得→位置/サイズ設定までは
すべて「CG global(左上原点)」で通し、Cocoa を経由するのは NSScreen の frame/visibleFrame を取る
一瞬だけ**にしている。反転計算は `geometry.swift` に 1 か所だけ集約している。

## セットアップ

`~/dotfiles/.bin/install.sh` 経由で自動セットアップされる（証明書作成→ビルド→LaunchAgent 登録）。
個別に行う場合:

### 1. コード署名証明書の作成（初回のみ・対話あり）

```sh
bash ~/dotfiles/window-snap/scripts/create-signing-cert.sh
```

- 安定した名前付き自己署名証明書 `WindowSnap Code Signing` を login キーチェーンに作る。
- **ad-hoc 署名を避ける理由**: ad-hoc は cdhash ベースの署名要件のため、リビルドのたびに macOS が
  「別アプリ」とみなし、付与済みのアクセシビリティ権限が無効化される。名前付き ID なら署名要件が
  固定され権限が維持される。
- コード署名信頼の追加で macOS の認証ダイアログ（Touch ID / パスワード）が一度出る。
  通常のターミナルで実行すること（非対話セッションでは認証できない）。

### 2. ビルド & 署名

```sh
bash ~/dotfiles/window-snap/scripts/build-app.sh
```

`.build/WindowSnap.app` を生成して名前付き ID で署名する。署名IDが無ければ ad-hoc に
フォールバックせず明確に失敗する（権限が消える問題に気付けるように）。

### 3. LaunchAgent 登録（ログイン常駐）

```sh
mkdir -p ~/Library/LaunchAgents ~/.local/state/window-snap
sed -e "s#__LAUNCHER__#$HOME/dotfiles/window-snap/scripts/windowsnap-launch.sh#" \
    -e "s#__LOG__#$HOME/.local/state/window-snap/stderr.log#" \
    ~/dotfiles/window-snap/launchd/com.umechanhika.windowsnap.plist \
    > ~/Library/LaunchAgents/com.umechanhika.windowsnap.plist
launchctl bootout gui/$(id -u)/com.umechanhika.windowsnap 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.umechanhika.windowsnap.plist
```

- 起動はランチャー `windowsnap-launch.sh` 経由。ソースが新しければ再ビルドしてから `exec` で
  本体に置き換えるので、`git pull` 後は再ログイン or `launchctl kickstart` で自動反映される（後述）。
- `exec` 後は launchd が本体プロセスを直接監視し、`KeepAlive` で落ちても自動再起動する。
- `.app` バンドル内の署名済みバイナリを起動するので、`LSUIElement`(Dock 非表示) と
  アクセシビリティ権限は正しく効く。

### 4. アクセシビリティ権限の付与（初回のみ）

初回起動時にプロンプトが出る。**システム設定 → プライバシーとセキュリティ → アクセシビリティ**
で `WindowSnap` を ON にする。権限が付くまでは 2 秒間隔で待機し、付与され次第スナップが有効になる。

## 運用

| 操作 | コマンド |
|------|---------|
| 状態確認 | `launchctl print gui/$(id -u)/com.umechanhika.windowsnap` |
| 手動再起動 | `launchctl kickstart -k gui/$(id -u)/com.umechanhika.windowsnap` |
| 停止 | `launchctl bootout gui/$(id -u)/com.umechanhika.windowsnap` |
| ログ | `~/.local/state/window-snap/stderr.log` |
| 終了 | メニューバーアイコン → 「WindowSnap を終了」 |

コード更新の反映（自動再ビルド）:

ランチャー `windowsnap-launch.sh` が起動時にソース（`Sources` / `Package.swift` / `scripts`）の
更新を検知して再ビルドする。`git pull` 等で更新したあとは、次のどちらかで反映される:

```sh
# 再ログイン、または手動で再起動（＝起動時に stale 判定 → 必要なら自動再ビルド）
launchctl kickstart -k gui/$(id -u)/com.umechanhika.windowsnap
```

- ファイル保存の瞬間ではなく「次回起動時（ログイン / kickstart）」に反映される。
- ビルドに失敗しても直前の動作バイナリで起動を続ける（`build-app.sh` は成功時のみ差し替え）。
- 手動で先にビルドしておくことも可能: `bash ~/dotfiles/window-snap/scripts/build-app.sh`

## 調整できる定数

| 定数 | ファイル | 既定 | 意味 |
|------|---------|------|------|
| `EDGE_THRESHOLD` | `snap_zone.swift` | 6pt | 端到達と判定する帯の太さ |
| `CORNER_BAND` | `snap_zone.swift` | 120pt | 隅(1/4)に倒す角からの距離（上端はこれを除く全幅が最大化） |
| `MOVE_THRESHOLD` | `window_dragger.swift` | 8pt | これ未満の移動では snap しない（誤爆防止） |
| `TITLEBAR_HEIGHT` | `ax_window.swift` | 32pt | タイトルバー掴み判定の帯 |

## 既知の注意点

- **上端ドラッグと Mission Control**: 本ツールはイベントを消費しない（listenOnly）ため、上端へドラッグ
  すると macOS のスペースバー（Mission Control）が出ることがある。プレビューは `.transient` 指定で
  Mission Control 起動時に前面から自動退避するが、Mission Control がスペースのサムネイルを撮る瞬間に
  写り込み、ウィンドウ一覧が薄く白むことがある（ウィンドウサーバー側の合成のため抑止不可。OS の制約）。
- **サイズ制約のあるウィンドウ**（最小サイズを持つアプリ等）は、要求サイズにクランプされることがある。
- プレビュー（スナップ先の半透明ハイライト）は未実装（必要なら今後追加）。
