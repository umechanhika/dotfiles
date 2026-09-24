# lib/comment — 分割済みアセット

`viewer.html` が読み込むフロントエンド資産を、責務ごとの小さなファイルに分割したもの。
CSS（`NN-*.css`）と JS（`comment.NN-*.js`）の両方を、ファイル名の番号順にロードする。

`frame-overlay.css` だけはこの番号順カスケードの対象外: `viewer.html` からは読み込まれず、HTML 対象のプレビュー中に `comment.02-render.js` の `injectFrameOverlay()` が `<link>` として **iframe 側の `<head>`** に読み込む（親ページの CSS は iframe 内に届かないため）。中身は `01-base.css`/`02-markers.css`/`07-diff.css` の一部と視覚的に対応するので、マーカー・差分の見た目を変えるときは両方を確認する。

## JS セグメント（責務 → ファイル）

元は単一の IIFE だった `lib/comment.js` を「アンラップして順序付きのクラシック `<script>` として配信」する形に分割した。トップレベルの `function`/`var` はグローバルオブジェクトのプロパティに、`let`/`const` は共有のグローバル字句スコープに入るため、宣言は全セグメント間で相互に参照可能。分割直後はロード順に連結すると元 IIFE の本体とバイト単位で一致していたが、その後の機能追加（frontmatter 分離・箇条書きの項目単位分割・タブタイトル設定など）で各ファイルへ直接手を入れているため、**現在はバイト一致ではない**。保たれているのはグローバルスコープ共有の前提のみで、内部呼び出しの命名規則やロジックの骨格は変えていない。各ファイル先頭の `"use strict";` は変更後も維持している。

| ファイル | 責務（1 行） |
| --- | --- |
| `comment.00-core.js` | 先頭ブロックコメント＋共有 state（`editingPid` 含む）・docEnv・DOM 参照と小ヘルパ（isHtml/rdDoc/rdRoot/rdFrame/frameOffset/toParentRect/noop/h/commentMarked）。HTML iframe 用のオーバーレイスタイルは `frame-overlay.css`（`comment.02-render.js` の `injectFrameOverlay()` が `<link>` で読み込む）に分離済み |
| `comment.01-bootstrap.js` | 起動（start/init/onGlobalKey/setStatus/announce） |
| `comment.02-render.js` | ソース取得と描画、frontmatter の切り出し、タブタイトル設定、箇条書きの項目単位分割、トークン1個→DOM要素の副作用なし変換（fetchSource/applySource/showFrame/render/loadFrame/onFrameLoad/injectFrameOverlay/buildBlockEls/renderMarkdown/setDocTitle/renderListBlock/isolateOwnContent） |
| `comment.03-selection.js` | ホバー・選択・ポップオーバー・返信下書き（onHover/blockOf/onMouseUp/openRangeComment/openBlockComment/fillContext/describeAnchor/showPopover/closePopover/onPopoverAdd/addReply/autoGrowReply） |
| `comment.04-sidebar.js` | 並び順・採番・サイドバー・カード・吹き出し・送信前コメントの編集（computeOrder/refreshView/renderSidebar/draftCard/threadCard/bubble/startEditPending/commitEditPending/cancelEditPending/clamp 系） |
| `comment.05-markers.js` | 本文マーカーとカード↔本文のジャンプ・サイドバー開閉（markBlock/clearMarkers/anchorToBlock/markdownBlock/htmlElement/reattachAll/focusBlock/focusThreadCard/flash/toggleSidebar） |
| `comment.06-server.js` | サーバ IPC・ポーリング・ライブ反映（sendAll/resolveThread/reopenThread/postThreadAction/refreshThreads/startPolling/stopPolling/checkRev/onRevBumped） |
| `comment.07-utils.js` | ユーティリティとサイドバー幅リサイズ（cssPath/normRaw/excerpt/escapeHtml/toast/initSidebarResize ほか）＋公開エクスポート `var ReviewDoc = { start: start };` |
| `comment.08-diff.js` | 差分モードの計算（純関数。DOM/state への副作用なし）。ブロック・表の行・箇条書きの項目を LCS とDice係数の対応づけで整列し、語単位/行単位の diff を返す（lcsOpcodes/greedyPair/diffTopLevelBlocks/blockDiffStrategy/diffTableRows/diffListItems/wordDiffForBlockPair/wordDiffForCellPair/diffLines） |
| `comment.09-diffview.js` | 差分モードの描画とモード切替。`/baseline` 取得、色分けDOM構築、上部バーの切替ボタン配線、HTML/マークダウン共通の切替ロジック（fetchBaseline/toggleDiffMode/enterDiffMode/maybeAutoEnterDiff/renderDiffView/appendReplaceDiffBlock/appendTableRowDiffBlock/appendListItemDiffBlock/updateDiffToggleUI） |
| `comment.10-htmldiff.js` | HTML 対象の差分モード。`comment.08-diff.js` はマークダウンのトークン木前提のため、HTML 側は DOM 要素を直接再帰的に比較する専用実装（要素の追加・削除・変更を判定し語単位の変更範囲を出す計算部分と、既存プレビューの上に直接色を重ねて描画する適用部分の両方を持つ。表のセルだけは内容の類似度でなく列位置で対応付ける）（diffHtmlDom/diffElementChildren/buildReplaceOp/wordDiffForElementPair/applyDiffOps/renderHtmlDiff） |

> 注: この分割はアンラップした IIFE を順序付きのクラシックスクリプトとして配信するもの。ロード順は元のカスケード/実行順を再現するが、連結のバイト一致は機能追加後は成立しない（上記）。コメント追加 → Claude 返信反映までのフル機能検証はブラウザでの動作確認が必要。
