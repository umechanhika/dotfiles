# フェーズ3：レポート生成エージェントの詳細（Figmaリンク生成ルール・スクショ参照・HTMLテンプレート全量）

フェーズ3エージェントへの指示に含める「## Figmaノードへの直接リンク生成ルール」以降の全文。SKILL.md のフェーズ3セクションから参照される。

## Figmaノードへの直接リンク生成ルール

各問題ノードへのリンクは以下の形式で生成する:
  https://www.figma.com/design/{fileKey}?node-id={nodeId（コロンをハイフンに変換）}

例: nodeId が "123:456" の場合
  https://www.figma.com/design/XXXXXXXXXXXXXXXXXXXXXXXX?node-id=123-456

## スクリーンショットの参照方法

スクリーンショットファイルは screenshots/ ディレクトリに保存されている。
HTMLからは相対パス `screenshots/axis1_1.png` のように参照する。

## 出力先

出力ディレクトリ: {カレントディレクトリ}/tmp/figma-mcp-readability/
ファイル名: figma-mcp-readability_{YYYYMMDD_HHMMSS}.html

HTMLファイルは **Write ツール**で直接保存すること（mkdir/Bashは一切使わない）。
絶対パス例: /Users/xxx/labo/tmp/figma-mcp-readability/figma-mcp-readability_20260526_120000.html

## HTMLレポートの要件

- **スコア・点数は一切出力しない**
- 各問題に対して「問題ノード名 + Figmaリンク + スクリーンショット + 問題の説明 + 修正方法」を表示する
- 最初にサマリー（評価対象ページ名・チェック日時・問題カテゴリ数）を表示する
- デザイナーが傷つかない、前向きで建設的なトーン（「改善するとMCPの精度が上がります」スタイル）

## HTMLテンプレート

<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Figma MCP Readability チェック</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; max-width: 1000px; margin: 40px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.7; }
    h1 { font-size: 1.6rem; border-bottom: 2px solid #333; padding-bottom: 8px; }
    h2 { font-size: 1.15rem; margin-top: 2.5rem; border-left: 4px solid #4a90d9; padding-left: 10px; }
    h3 { font-size: 1rem; color: #333; margin-top: 1.5rem; }
    .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
    .summary-box { background: #f5f9ff; border: 1px solid #b0ccee; border-radius: 8px; padding: 20px 24px; margin: 1.5rem 0; }
    .summary-box p { margin: 4px 0; }
    .category-chips { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 12px; }
    .chip { display: inline-block; border-radius: 20px; padding: 2px 14px; font-size: 0.85rem; font-weight: bold; }
    .chip-critical { background: #fde8e8; color: #c62828; border: 1px solid #f5a5a5; }
    .chip-warn { background: #fff3e0; color: #e65100; border: 1px solid #ffcc80; }
    .chip-info { background: #e8f4fd; color: #1565c0; border: 1px solid #90caf9; }
    .issue-card { border: 1px solid #e0e0e0; border-radius: 8px; margin: 16px 0; overflow: hidden; }
    .issue-card-header { background: #f9f9f9; padding: 12px 16px; border-bottom: 1px solid #e0e0e0; display: flex; align-items: center; gap: 10px; }
    .issue-card-header .node-name { font-weight: bold; font-size: 0.95rem; }
    .issue-card-body { padding: 16px; display: grid; grid-template-columns: auto 1fr; gap: 16px; align-items: start; }
    .issue-screenshot { width: 180px; border: 1px solid #ddd; border-radius: 4px; flex-shrink: 0; }
    .issue-screenshot img { width: 100%; display: block; border-radius: 4px; }
    .issue-screenshot .no-image { width: 100%; height: 120px; background: #f0f0f0; display: flex; align-items: center; justify-content: center; color: #999; font-size: 0.8rem; border-radius: 4px; }
    .issue-detail {}
    .issue-problem { color: #555; font-size: 0.9rem; margin-bottom: 8px; }
    .issue-fix { background: #f0f7f0; border-left: 3px solid #43a047; padding: 8px 12px; border-radius: 0 4px 4px 0; font-size: 0.9rem; }
    .issue-fix strong { color: #2e7d32; }
    .figma-link { display: inline-flex; align-items: center; gap: 4px; font-size: 0.8rem; color: #4a90d9; text-decoration: none; margin-top: 8px; }
    .figma-link:hover { text-decoration: underline; }
    .overview-img { width: 100%; max-height: 300px; object-fit: contain; border: 1px solid #ddd; border-radius: 4px; margin: 8px 0; }
    .badge-critical { display: inline-block; background: #c62828; color: white; border-radius: 4px; padding: 1px 8px; font-size: 0.75rem; }
    .badge-warn { display: inline-block; background: #e65100; color: white; border-radius: 4px; padding: 1px 8px; font-size: 0.75rem; }
    .badge-info { display: inline-block; background: #1565c0; color: white; border-radius: 4px; padding: 1px 8px; font-size: 0.75rem; }
    hr { border: none; border-top: 1px solid #e0e0e0; margin: 2rem 0; }
    a { color: #4a90d9; }
    code { background: #f0f4f8; padding: 1px 5px; border-radius: 3px; font-size: 0.85em; }
    .tip-box { background: #fffde7; border: 1px solid #ffe082; border-radius: 6px; padding: 12px 16px; margin: 12px 0; font-size: 0.9rem; }
  </style>
</head>
<body>

<h1>Figma MCP Readability チェック</h1>

<div class="meta">
  <strong>評価対象</strong>: [ページ/ノード名]（<a href="[FIGMA_URL]" target="_blank">Figmaで開く ↗</a>）<br>
  <strong>チェック日時</strong>: [YYYY-MM-DD HH:MM]
</div>

<!-- 概要スクリーンショット -->
<img class="overview-img" src="screenshots/overview.png" alt="評価対象の概要" onerror="this.style.display='none'">

<div class="summary-box">
  <p><strong>評価スコープ</strong>: 指定されたノード（[ノード名]）配下のフレーム [N]件</p>
  <p>Figma MCPがこのデザインを読み取る際に、以下のカテゴリで改善の余地が見つかりました。</p>
  <div class="category-chips">
    <!-- 問題があるカテゴリのchipを表示 -->
    <span class="chip chip-critical">命名規則</span>
    <span class="chip chip-warn">コンポーネント活用</span>
    <span class="chip chip-warn">状態網羅性</span>
    <span class="chip chip-info">セクション構成</span>
  </div>
</div>

<hr>

<!-- ===================== 軸1: 命名規則 ===================== -->
<h2>命名規則 <span class="badge-critical">要対応</span></h2>

<p>Figma MCPは <code>get_metadata</code> でレイヤー名を読み取り、画面の構造を理解します。「Frame 123」「Group」のようなデフォルト名のままだと、MCPがそのノードの役割を判断できず、実装精度が下がります。</p>

<div class="tip-box">
  💡 <strong>推奨命名形式</strong>: <code>画面名 / 状態</code>（例: <code>LoginForm / Default</code>、<code>LoginForm / Error</code>）またはコンポーネントの役割を表す名前（例: <code>IdentityDocumentList</code>）
</div>

<!-- 問題ノードカードを軸1の件数分繰り返す -->
<div class="issue-card">
  <div class="issue-card-header">
    <span class="badge-critical">命名</span>
    <span class="node-name">[問題ノード名]</span>
  </div>
  <div class="issue-card-body">
    <div class="issue-screenshot">
      <img src="screenshots/axis1_1.png" alt="[問題ノード名]" onerror="this.parentElement.innerHTML='<div class=\'no-image\'>画像なし</div>'">
    </div>
    <div class="issue-detail">
      <div class="issue-problem">「[問題ノード名]」はFigmaのデフォルト名のため、MCPがこのフレームの役割を判別できません。</div>
      <div class="issue-fix"><strong>修正方法</strong>: [推奨する名前例] に変更してください。</div>
      <a class="figma-link" href="[Figmaノードへの直接リンク]" target="_blank">↗ Figmaで開く（[ノード名]）</a>
    </div>
  </div>
</div>
<!-- 以降、軸1の残り件数分繰り返す -->

<hr>

<!-- ===================== 軸2: コンポーネント活用 ===================== -->
<h2>コンポーネント活用 <span class="badge-warn">改善推奨</span></h2>

<p>同じUIパーツが各画面に直接描かれている（インスタンスではなくフレームやグループで複製されている）と、MCPが「これは同じコンポーネントだ」と認識できません。コンポーネントのインスタンスを使うと、MCPが構造を正確に把握できます。</p>

<!-- 問題フレームカードを軸2の件数分繰り返す -->
<div class="issue-card">
  <div class="issue-card-header">
    <span class="badge-warn">コンポーネント</span>
    <span class="node-name">[問題フレーム名]</span>
  </div>
  <div class="issue-card-body">
    <div class="issue-screenshot">
      <img src="screenshots/axis2_1.png" alt="[問題フレーム名]" onerror="this.parentElement.innerHTML='<div class=\'no-image\'>画像なし</div>'">
    </div>
    <div class="issue-detail">
      <div class="issue-problem">[問題の内容：flat layerが多い理由など]</div>
      <div class="issue-fix"><strong>修正方法</strong>: 繰り返し使われているUIパーツをFigmaコンポーネントとして定義し、このフレームではインスタンスを使用してください。</div>
      <a class="figma-link" href="[Figmaノードへの直接リンク]" target="_blank">↗ Figmaで開く（[ノード名]）</a>
    </div>
  </div>
</div>

<hr>

<!-- ===================== 軸3: 状態網羅性 ===================== -->
<h2>状態網羅性 <span class="badge-warn">改善推奨</span></h2>

<p>インタラクティブなコンポーネント（テキストフィールド・ボタン・アラート等）に複数の状態（Default / Error / Disabled / Loading）が定義されていると、MCPが「このコンポーネントはどんな条件で表示が変わるか」を把握でき、実装の漏れを防げます。</p>

<!-- 状態不足コンポーネントカードを軸3の件数分繰り返す -->
<div class="issue-card">
  <div class="issue-card-header">
    <span class="badge-warn">状態</span>
    <span class="node-name">[コンポーネント名]</span>
  </div>
  <div class="issue-card-body">
    <div class="issue-screenshot">
      <img src="screenshots/axis3_1.png" alt="[コンポーネント名]" onerror="this.parentElement.innerHTML='<div class=\'no-image\'>画像なし</div>'">
    </div>
    <div class="issue-detail">
      <div class="issue-problem">現在 [定義済み状態] のみ定義されています。[不足している状態] が未定義のため、実装時に見落とす可能性があります。</div>
      <div class="issue-fix"><strong>修正方法</strong>: [不足している状態] を追加し、命名は <code>[コンポーネント名] / [状態名]</code> の形式にしてください。</div>
      <a class="figma-link" href="[Figmaノードへの直接リンク]" target="_blank">↗ Figmaで開く（[コンポーネント名]）</a>
    </div>
  </div>
</div>

<hr>

<!-- ===================== 軸4: セクション構成 ===================== -->
<!-- セクション外フレームがある場合のみ表示 -->
<h2>セクション構成 <span class="badge-info">参考</span></h2>

<p>フレームがセクションに整理されていると、MCPがファイルのどこに何があるかを把握しやすくなります。現在セクションに属していないフレームがあります。</p>

<!-- セクション外フレームのリスト（カードなし・シンプルなリスト） -->
<ul>
  <!-- セクション外フレームの代表例を列挙 -->
  <li><a href="[Figmaリンク]" target="_blank">[フレーム名]</a> — セクションに属していません</li>
</ul>

<div class="tip-box">
  💡 コンポーネントや補助素材は「Components」「Archive」などの専用セクションに整理すると、画面フレームと区別しやすくなります。
</div>

</body>
</html>

## タスク

上記テンプレートの各プレースホルダーを評価結果で埋め、スクリーンショットを参照したHTMLファイルを生成し、ファイルパスを返してください。
問題がないカテゴリのセクションはHTMLから省略してよい。
