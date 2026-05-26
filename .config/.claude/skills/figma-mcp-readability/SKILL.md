---
name: figma-mcp-readability
description: >
  FigmaデザインがFigma MCPで読み取りやすい構造になっているかをチェックし、
  デザイナーへの改善フィードバックレポート（HTML）を生成してブラウザで開くスキル。
  「FigmaのURLを渡すので構造をチェックして」「MCP-readableか確認して」
  「Figmaのレイヤー構造をレビューして」「デザイナーへのFBを作って」
  「命名規則が守られているかFigmaを見て」「Figmaの構造品質を評価して」
  といったリクエストで必ず使うこと。Figma URLが渡されたら積極的にこのスキルの使用を検討する。
---

# Figma MCP Readability チェックスキル

FigmaデザインがFigma MCPで読み取りやすい構造かをチェックし、デザイナー向けフィードバックレポートを生成する。

**このスキルの目的**: 開発チームがFigma MCPを使って実装を行う際、Figmaの構造が悪いとMCPが正しく解釈できない。デザイナーに「Figmaのどこが・なぜMCPで読み取りにくいのか・どう直すか」を具体的・視覚的に伝えることで、MCPを活用した開発効率を向上させる。

**レポートの方針**:
- **スコアや点数は出力しない** — 何点かではなく「どこの何が問題で、どう直すか」を伝えることが目的
- **指摘は具体的に** — 「○○件のNG」ではなく「このノード（Figma URL付き）が問題」という形式
- **評価スコープは指定ノード配下のみ** — URLのnode-idで指定されたノードとその子孫のみを対象とする
- **スクリーンショットで視覚化** — 問題箇所のスクリーンショットを添付する

---

## アーキテクチャ方針

**全フェーズをサブエージェントに委譲する。**
各フェーズのAPI呼び出しはサブエージェントのコンテキスト内で完結させ、メインセッションには**圧縮された評価結果だけ**を返す。

```
メインセッション
 ├─ フェーズ1エージェント → ページ名 + 軸ごとの代表的な問題（各最大5件）+ 問題ノードIDリスト
 ├─ フェーズ2エージェント → スクリーンショット取得 + 保存先パス一覧
 └─ フェーズ3エージェント → HTMLレポートファイル生成
```

各フェーズは **`Task` ツール** で起動する。フェーズは**順次実行**（前フェーズの返り値を次フェーズに渡すため）。

---

## メインセッションの進行手順

以下の順で `Task` ツールを使いサブエージェントを順次起動する。

---

### フェーズ 1：構造解析エージェント

**起動前にメインセッションで行うこと**

Figma URLを受け取り、以下を抽出してエージェントへの指示に含める:
- `fileKey`: URLの `/design/` 直後のパス部分
- `nodeId`: URLの `?node-id=780-13809` → `-` を `:` に変換 → `780:13809`
- `{{SKILL_PATH}}`: このSKILL.mdが置かれているディレクトリの絶対パス（フェーズ2と同様に埋めて渡すこと）

**返り値フォーマット**

```
【評価スコープ】
- ページ/ノード名: [get_metadataで取得したnode名]
- 評価対象ノードID: [指定されたnodeId]
- 子孫フレーム総数: [N件]

【軸1: 命名規則 — 代表的な問題（最大5件）】
| 問題ノード名 | nodeId | 問題の理由 | 推奨する名前例 |
|------------|--------|----------|--------------|

【軸2: コンポーネント活用 — 代表的な問題（最大5件）】
| 問題フレーム名 | nodeId | 問題の内容（flat layerが多い等） |
|-------------|--------|-------------------------------|

【軸3: 状態網羅性 — 問題のあるコンポーネント（最大5件）】
| コンポーネント名 | 定義済み状態 | 不足している状態 |
|--------------|-----------|--------------|

【軸4: セクション構成 — セクション外フレームの代表例（最大5件）】
| フレーム名 | nodeId | 所属セクション |
|---------|--------|-------------|

【問題ノードIDリスト（フェーズ2に渡す用）】
軸1: nodeId1, nodeId2, ...（最大5件）
軸2: nodeId1, nodeId2, ...（最大5件）
軸3: nodeId1, nodeId2, ...（最大3件）
```

**エージェントへの指示**

```
以下のFigma URLの構造を解析し、MCPで読み取りにくい箇所の代表例を特定してください。
説明・感想・補足は一切不要です。返り値フォーマット通りに返してください。

Figma URL: {{FIGMA_URL}}
fileKey: {{FILE_KEY}}
nodeId: {{NODE_ID}}
スキルのパス: {{SKILL_PATH}}

## ツール使用制限

- **PythonおよびBashコマンドは一切使わない**（ファイル読み込み・XMLパースを含む）
- XMLは `get_metadata` の返り値をテキストとして直接解析すること
- ファイル読み込みは必ず **Read ツール** を使うこと

## 重要な制約

- 評価スコープは指定 nodeId の配下のみ。ファイル全体を評価してはいけない
- 件数の多さではなく「代表的な問題」を最大5件に絞る
- 実際のノード名とnodeIdを必ず記録する（後でFigma URLを生成するために使う）

## 評価基準の参照

Read ツールで以下のファイルを読み込んでから解析を開始すること:
  {{SKILL_PATH}}/references/naming-patterns.md

## 手順

### Step 1: get_metadata でXML取得

mcp__claude_ai_Figma__get_metadata(fileKey="{{FILE_KEY}}", nodeId="{{NODE_ID}}")

取得したXML最上位ノードの name 属性を記録する（これが「評価対象のページ/ノード名」）。

### Step 2: 軸1 命名規則 — 代表的な問題を5件特定

全 section・frame・group ノードの name 属性を走査し、NGパターンに一致するものを全件特定する。
その中から **最も視覚的にわかりやすい代表例5件** を選ぶ（画面レベルのframeを優先）。

選定基準:
- 画面全体を表すフレーム（セクション直下）を優先
- 数字が大きい・複雑なデフォルト名（"Frame 2134284509"など）を優先
- それぞれ異なる種類（Group系・Frame系・Line系）から選ぶ

### Step 3: 軸2 コンポーネント活用 — flat layerが多いフレームを5件特定

各 frame ノードの直接子要素を確認し、instance タグが少なく flat layer（frame・group・vector）が多いフレームを特定する。
代表的な問題フレームを5件選ぶ（画面レベルのフレームを優先）。

### Step 4: 軸3 状態網羅性 — 状態不足のコンポーネントを5件特定

frame の name 属性に「/」区切りが含まれるものをコンポーネントグループとして識別する。
グループ内の状態一覧を確認し、Default/Error/Loading/Empty/Disabled のいずれかが欠けているグループを特定する。
状態不足のグループを5件選び、不足している状態を記録する。

### Step 5: 軸4 セクション外フレーム — 代表例を5件特定

section タグに属さない frame ノードを特定し、代表例5件を選ぶ。
（コンポーネントや補助要素でなく、画面らしいフレームを優先）

## 返り値フォーマット（このフォーマット以外を返してはいけない）

【評価スコープ】
- ページ/ノード名: [名前]
- 評価対象ノードID: [nodeId]
- 子孫フレーム総数: [N]件

【軸1: 命名規則 — 代表的な問題（最大5件）】
| 問題ノード名 | nodeId | 問題の理由 | 推奨する名前例 |
|------------|--------|----------|--------------|

【軸2: コンポーネント活用 — 代表的な問題（最大5件）】
| 問題フレーム名 | nodeId | 問題の内容 |
|-------------|--------|---------|

【軸3: 状態網羅性 — 問題のあるコンポーネント（最大5件）】
| コンポーネント名 | 定義済み状態 | 不足している状態 |
|--------------|-----------|--------------|

【軸4: セクション構成 — セクション外フレームの代表例（最大5件）】
| フレーム名 | nodeId | 備考 |
|---------|--------|------|

【問題ノードIDリスト（フェーズ2に渡す用）】
軸1: [nodeId1, nodeId2, ...]
軸2: [nodeId1, nodeId2, ...]
軸3: [nodeId1, nodeId2, ...]（状態不足のコンポーネントを含む親ノード）
```

---

### フェーズ 2：スクリーンショット取得エージェント

**前提**: フェーズ1の返り値（問題ノードIDリスト）をプロンプトに含めて渡すこと。
また、`{{SKILL_PATH}}` にはこのスキルのディレクトリの絶対パスを代入すること（例: `/Users/xxx/.claude/skills/figma-mcp-readability`）。

**返り値フォーマット**

```
【スクリーンショット一覧】
| nodeId | 軸 | 保存先パス |
|--------|---|----------|
```

**エージェントへの指示**

```
以下のノードIDのスクリーンショットを取得し、ファイルに保存してください。
説明・感想・補足は一切不要です。返り値フォーマット通りに返してください。

fileKey: {{FILE_KEY}}
スキルのパス: {{SKILL_PATH}}  ← メインセッションがこのスキルのディレクトリパスを埋めて渡すこと

## 対象ノードIDリスト

軸1（命名規則の問題ノード）: {{軸1のIDリスト}}
軸2（コンポーネント活用の問題フレーム）: {{軸2のIDリスト}}
軸3（状態不足コンポーネント）: {{軸3のIDリスト}}
概要スクリーンショット用（指定ノード全体）: {{フェーズ1の評価対象ノードID}}

## 手順

### Step 1: 全 nodeId の get_screenshot を並列で呼び出してデータを収集する（保存はまだしない）

全nodeIdのget_screenshotを**1ターンで同時に**呼び出すこと（並列実行）。
逐次で1件ずつ呼び出すのではなく、全tool callを同一レスポンス内に含めること。

以下の命名規則で各ノードのスクリーンショットを取得し、返却された画像データ（base64文字列）を記録する:
  "overview.png"  → 評価対象ノード全体（{{フェーズ1の評価対象ノードID}}）
  "axis1_1.png"   → 軸1の1件目
  "axis1_2.png"   → 軸1の2件目
  ...
  "axis2_1.png"   → 軸2の1件目
  "axis3_1.png"   → 軸3の1件目
  ...

呼び出し方:
  mcp__claude_ai_Figma__get_screenshot(fileKey="{{FILE_KEY}}", nodeId="[各ID]")

エラーになったノードはスキップし、そのキーをデータから除外する。

### Step 2: 収集した全データを1つのJSONファイルに書き出す（Write ツール使用）

以下のパスに、Step 1 で収集した全データをまとめてJSONファイルとして保存する:
  /tmp/figma-mcp-readability-screenshots.json

形式: { "overview.png": "<base64文字列>", "axis1_1.png": "<base64文字列>", ... }

### Step 3: 保存スクリプトを1回だけ実行して全画像を一括保存する

python3 {{SKILL_PATH}}/scripts/save_screenshots.py \
  --output-dir {カレントディレクトリ}/tmp/figma-mcp-readability/screenshots \
  --data-file /tmp/figma-mcp-readability-screenshots.json

## 返り値フォーマット（このフォーマット以外を返してはいけない）

【スクリーンショット一覧】
| nodeId | 軸 | ファイル名 |
|--------|---|---------|
```

---

### フェーズ 3：レポート生成エージェント

**前提**: フェーズ1・フェーズ2の全返り値をプロンプトに含めて渡すこと。

**エージェントへの指示**

```
以下の評価結果をもとにHTMLレポートを生成してください。
説明・感想・補足は一切不要です。

## 入力データ

Figma URL: {{FIGMA_URL}}
fileKey: {{FILE_KEY}}

{{フェーズ1の返り値をここに挿入}}

{{フェーズ2の返り値をここに挿入}}

## Figmaノードへの直接リンク生成ルール

各問題ノードへのリンクは以下の形式で生成する:
  https://www.figma.com/design/{fileKey}?node-id={nodeId（コロンをハイフンに変換）}

例: nodeId が "123:456" の場合
  https://www.figma.com/design/XXXXXXXXXXXXXXXXXXXXXXXX?node-id=123-456

## スクリーンショットの参照方法

スクリーンショットファイルは screenshots/ ディレクトリに保存されている。
HTMLからは相対パス `screenshots/axis1_1.png` のように参照する。

## 出力先

mkdir -p {カレントディレクトリ}/tmp/figma-mcp-readability

ファイル名: figma-mcp-readability_{YYYYMMDD_HHMMSS}.html

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
```

**返り値フォーマット**

```
【生成ファイル】
パス: [絶対パス]
```

---

## メインセッションの最終出力

フェーズ3が完了したら、以下を実行する:

1. `open [ファイルパス]` でHTMLレポートをブラウザで開く
2. `HTMLレポートを生成しました: [ファイルパス]` とユーザーに伝える

---

## 注意事項

- `get_metadata` を nodeId なしで呼び出すのは、URLに `node-id` パラメータがない場合のみ
- 問題が見つからない軸のセクションはHTMLから省略してよい
- デザイナー向けのトーンは「否定」ではなく「こうするとMCPの精度が上がる」という前向きな表現を使う
- スクリーンショット取得でエラーが出たノードはスキップしてよい（`onerror` でフォールバックされる）
