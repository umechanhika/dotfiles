# フェーズ2：スクリーンショット取得エージェントの詳細手順

フェーズ2エージェントへの指示に含める「## 手順」以降の全文。SKILL.md のフェーズ2セクションから参照される。

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
