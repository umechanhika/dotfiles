# lib/comment — 分割済みアセット

`viewer.html` が読み込むフロントエンド資産を、責務ごとの小さなファイルに分割したもの。
CSS（`NN-*.css`）と JS（`comment.NN-*.js`）の両方を、ファイル名の番号順にロードする。

## JS セグメント（責務 → ファイル）

元は単一の IIFE だった `lib/comment.js` を「アンラップして順序付きのクラシック `<script>` として配信」する形に分割した。トップレベルの `function`/`var` はグローバルオブジェクトのプロパティに、`let`/`const` は共有のグローバル字句スコープに入るため、102 個の宣言は全セグメント間で相互に参照可能。よって内部呼び出しは一切書き換えていない（`ReviewDoc.*` への変換なし・リネームなし・ロジック変更なし）。各ファイル先頭に `"use strict";` を付与し、元の strict モードを保持している。**ロード順に連結すると、元 IIFE の本体とバイト単位で一致する**（連結同値性をテストで確認済み）。

| ファイル | 責務（1 行） |
| --- | --- |
| `comment.00-core.js` | 先頭ブロックコメント＋共有 state・docEnv・DOM 参照・FRAME_OVERLAY_CSS と小ヘルパ（isHtml/rdDoc/rdRoot/rdFrame/frameOffset/toParentRect/noop/h/commentMarked） |
| `comment.01-bootstrap.js` | 起動（start/init/onGlobalKey/setStatus/announce） |
| `comment.02-render.js` | ソース取得と描画（fetchSource/applySource/showFrame/render/loadFrame/onFrameLoad/injectFrameOverlay/renderMarkdown） |
| `comment.03-selection.js` | ホバー・選択・ポップオーバー・返信下書き（onHover/blockOf/onMouseUp/openRangeComment/openBlockComment/fillContext/describeAnchor/showPopover/closePopover/onPopoverAdd/addReply/autoGrowReply） |
| `comment.04-sidebar.js` | 並び順・採番・サイドバー・カード・吹き出し（computeOrder/refreshView/renderSidebar/draftCard/threadCard/bubble/clamp 系） |
| `comment.05-markers.js` | 本文マーカーとカード↔本文のジャンプ・サイドバー開閉（markBlock/clearMarkers/anchorToBlock/markdownBlock/htmlElement/reattachAll/focusBlock/focusThreadCard/flash/toggleSidebar） |
| `comment.06-server.js` | サーバ IPC・ポーリング・ライブ反映（sendAll/resolveThread/reopenThread/postThreadAction/refreshThreads/startPolling/stopPolling/checkRev/onRevBumped） |
| `comment.07-utils.js` | ユーティリティとサイドバー幅リサイズ（cssPath/normRaw/excerpt/escapeHtml/toast/initSidebarResize ほか）＋公開エクスポート `var ReviewDoc = { start: start };` |

> 注: この分割はアンラップした IIFE を順序付きのクラシックスクリプトとして配信するもの。ロード順の連結は元の本体を再現する。コメント追加 → Claude 返信反映までのフル機能検証はブラウザでの動作確認が必要。
