---
name: spec-gap-review
description: 事業側・デザイナーから渡された仕様書・要件書・Figmaデザインを、開発観点でパターン網羅性と仕様漏れの観点から構造的にレビューし、発見した漏れをPdM観点で顧客体験向上の提案に変換する。「この仕様書のパターン網羅性を確認して」「仕様の抜け漏れを洗い出して」「Figmaのデザインで定義されていない状態を探して」「開発前に確認しておくべき漏れを出して」「この資料でCX観点の提案を作って」といったリクエストで必ず使うこと。仕様書・要件書・FigmaのURLが渡されたら積極的にこのスキルの使用を検討する。
---

# 仕様カバレッジレビュースキル

渡された資料を読み込み、4つの網羅性軸で仕様の漏れを洗い出す。その後、発見した漏れをPdM視点でCX改善提案に変換して出力する。

「問題の列挙」ではなく「見落としを機会に変える」ことがこのスキルの目的だ。

---

## 実行フロー

### STEP 1: 資料の読み込み

渡された資料を種類に応じて読み込む。

| 資料の種類 | 使用するツール |
|-----------|-------------|
| Figma URL | `mcp__claude_ai_Figma__get_design_context` → `mcp__claude_ai_Figma__get_screenshot` |
| Notion URL | `mcp__claude_ai_Notion__notion-fetch` |
| JIRA チケット | `mcp__claude_ai_Atlassian__getJiraIssue` |
| Confluence ページ | `mcp__claude_ai_Atlassian__getConfluencePage` |
| ローカルファイル | `Read` ツール |

資料内のリンク（関連チケット・別Figmaページ等）も積極的にたどる。

### STEP 2: 機能・スコープの把握

まず「何を実現しようとしているか」を1〜2文で整理する。これが後の網羅性チェックの軸になる。

- 対象機能の目的・ユーザーゴール
- 主な操作フロー（ハッピーパス）
- 対象プラットフォーム（iOS/Android/Web）

### STEP 3: 4軸での漏れ検出（開発観点）

以下の4軸を順番にチェックし、**資料に定義されていない項目**を洗い出す。明示的に「対象外」と記載されているものは除外する。

#### 軸1: 画面・状態の網羅性

各画面・コンポーネントについて、以下の状態が全てデザイン・仕様として定義されているかを確認する。

| チェック項目 | 確認ポイント |
|------------|------------|
| ローディング状態 | データ取得中の表示（スケルトン/スピナー等）が定義されているか |
| 成功状態 | データあり・データなし（空状態）の両方が定義されているか |
| エラー状態 | APIエラー・ネットワーク切断・タイムアウト時の表示が定義されているか |
| モーダル・ダイアログ | 開いた状態・閉じた状態・背景タップ時の挙動が定義されているか |
| 入力フォーム | フォーカス中・入力済み・バリデーションエラー時の状態が定義されているか |
| ボタン | 活性・非活性・タップ中（押下中）の状態が定義されているか |

#### 軸2: 入力パターンの網羅性

ユーザーが入力する値・選択する値について、境界値とエッジケースが定義されているかを確認する。

| チェック項目 | 確認ポイント |
|------------|------------|
| 数値・金額 | 0・最小値・最大値・小数点・負の値の挙動が定義されているか |
| テキスト | 0文字・最大文字数・全角/半角・改行・特殊文字の挙動が定義されているか |
| 日付・時刻 | 過去日・未来日・同日・時間帯（深夜・早朝）の挙動が定義されているか |
| 選択肢 | 未選択・全選択・単一選択のみ/複数選択の制限が定義されているか |

#### 軸3: ユーザー属性によるパターン

ユーザーの状態・属性によって挙動が変わるケースが全て定義されているかを確認する。

| チェック項目 | 確認ポイント |
|------------|------------|
| 新規/既存 | 初回利用と再利用でUIや文言が変わる場合、両方が定義されているか |
| プラン・サービス種別 | 種別によって機能の可否・表示が変わる場合、全パターンが定義されているか |
| データ有無 | 件数0・データなし・履歴なし等、データが存在しないユーザーの挙動が定義されているか |
| 権限・制限状態 | 利用停止中・手続き中・審査中など特殊な状態のユーザーへの対応が定義されているか |

#### 軸4: フロー分岐の網羅性

ユーザーがどんな操作をしても迷子にならないよう、全ての分岐先が定義されているかを確認する。

| チェック項目 | 確認ポイント |
|------------|------------|
| キャンセル・中断 | 操作の途中でキャンセルした場合の遷移先が定義されているか |
| 戻る操作 | 各画面でバック操作（アプリ: ナビゲーション、Web: ブラウザバック）した際の挙動が定義されているか |
| 二重送信・多重操作 | ボタン連打・二重送信防止の仕様が定義されているか |
| バックグラウンド復帰 | アプリを離れて戻った場合（認証切れ含む）の挙動が定義されているか |
| 外部連携後の復帰 | 外部アプリ・ブラウザ・通知からの復帰フローが定義されているか |

### STEP 4: 仕様方向性の提案（PdM観点）

STEP 3で発見した**全ての**漏れについて、1件ずつ「どう仕様を決めるか」の方向性を提案する。

開発チームは漏れを発見するだけでなく、事業側・デザイナーへ方向性を示す責務がある。仕様漏れを放置したまま開発に入ると手戻りが発生するため、このレビューの段階で全件に対して「Aにする / Bにする / 要議論」の軸を示すことが目的だ。

変換の視点：
- **全件カバーする**: CX上の影響が大きいものだけでなく、技術的・内部的な仕様漏れも含め、STEP 3で列挙した全ての項目に提案を書く
- **ユーザーの感情から考える**: その漏れを放置するとユーザーはどんな不安・混乱・失望を感じるか。逆に丁寧に対応するとどんな安心・信頼・喜びを生むか
- **解決策を前向きに描く**: 「〜が未定義」ではなく「〜することでユーザーの〜を改善できる」という形で提案する
- **難易度を添える**: 「要議論」と書くだけでなく、なぜ議論が必要か（コスト・ポリシー・優先度）を一言添える

### STEP 5: HTMLファイルの生成・報告

```bash
mkdir -p {カレントディレクトリ}/tmp/spec-gap-review
```

ファイル名: `spec-gap-review_{YYYYMMDD_HHMMSS}.html`

後述の出力フォーマットに従い **HTMLファイル** を生成し、ファイルパスをユーザーに伝える。

出力はHTMLとして記述すること。チェックボックスは `<input type="checkbox" disabled>` 、表は `<table>` タグを使用する。markdownのパイプ記法（`| ... |`）やチェックボックス記法（`- [ ]`）はHTMLファイル内では使わない。

---

## 出力フォーマット

```html
<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>仕様カバレッジレビュー - [機能名]</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", sans-serif; max-width: 960px; margin: 40px auto; padding: 0 24px; color: #1a1a1a; line-height: 1.7; }
    h1 { font-size: 1.6rem; border-bottom: 2px solid #333; padding-bottom: 8px; }
    h2 { font-size: 1.2rem; margin-top: 2rem; border-left: 4px solid #4a90d9; padding-left: 10px; }
    h3 { font-size: 1rem; color: #444; }
    .meta { color: #666; font-size: 0.9rem; margin-bottom: 1.5rem; }
    ul.gaps { list-style: none; padding: 0; }
    ul.gaps li { display: flex; align-items: flex-start; gap: 8px; margin: 6px 0; }
    ul.gaps li input { margin-top: 4px; flex-shrink: 0; }
    table { width: 100%; border-collapse: collapse; margin-top: 1rem; font-size: 0.9rem; }
    th { background: #f0f4f8; text-align: left; padding: 10px 12px; border: 1px solid #ccc; }
    td { padding: 10px 12px; border: 1px solid #ddd; vertical-align: top; }
    tr:nth-child(even) td { background: #fafafa; }
    .summary-box { background: #f5f9ff; border: 1px solid #b0ccee; border-radius: 6px; padding: 16px 20px; margin-top: 1.5rem; }
    .badge { display: inline-block; background: #4a90d9; color: white; border-radius: 4px; padding: 1px 8px; font-size: 0.8rem; margin-left: 6px; }
    .note-discuss { color: #b35c00; font-weight: bold; }
    hr { border: none; border-top: 1px solid #ddd; margin: 2rem 0; }
  </style>
</head>
<body>

<h1>仕様カバレッジレビュー</h1>
<div class="meta">
  <strong>対象資料</strong>: [資料名・URL]<br>
  <strong>機能名</strong>: [自動判定した機能名]<br>
  <strong>レビュー日時</strong>: [YYYY-MM-DD HH:MM]
</div>

<hr>

<h2>機能概要</h2>
<p>（対象機能の目的・ユーザーゴール・主要フローを2〜3文で整理）</p>

<hr>

<h2>仕様の漏れ・未定義項目</h2>
<p>発見した漏れを軸ごとに列挙する。明示的に「対象外」と記載されている項目はここに含めない。</p>

<h3>軸1: 画面・状態の網羅性</h3>
<ul class="gaps">
  <li><input type="checkbox" disabled> [未定義の状態の説明]</li>
</ul>
<!-- 発見がない場合は <p>特に漏れなし</p> -->

<h3>軸2: 入力パターンの網羅性</h3>
<ul class="gaps">
  <li><input type="checkbox" disabled> ...</li>
</ul>

<h3>軸3: ユーザー属性によるパターン</h3>
<ul class="gaps">
  <li><input type="checkbox" disabled> ...</li>
</ul>

<h3>軸4: フロー分岐の網羅性</h3>
<ul class="gaps">
  <li><input type="checkbox" disabled> ...</li>
</ul>

<hr>

<h2>仕様方向性の提案</h2>
<p>発見した漏れの<strong>全件</strong>について、開発・事業・デザイン間で方向性を合意するための提案。<br>
「要議論」と表示されている項目は事業側・関係部署との確認が必要な事項を示す。</p>

<table>
  <thead>
    <tr>
      <th>#</th>
      <th>関連する漏れ</th>
      <th>推奨する仕様方向性</th>
      <th>ユーザーへの価値・理由</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>1</td>
      <td>[関連する漏れ]</td>
      <td>[具体的な提案] または <span class="note-discuss">要議論: [理由]</span></td>
      <td>[ユーザーが得る安心・利便性・信頼、または技術的な理由]</td>
    </tr>
    <!-- 繰り返し -->
  </tbody>
</table>

<hr>

<div class="summary-box">
  <h2 style="border:none;padding:0;margin-top:0;">サマリー</h2>
  <p>
    発見した漏れ: 計X件
    <span class="badge">画面・状態 X件</span>
    <span class="badge">入力パターン X件</span>
    <span class="badge">ユーザー属性 X件</span>
    <span class="badge">フロー分岐 X件</span>
  </p>
  <p>仕様方向性の提案: 計X件（全漏れをカバー）</p>
</div>

</body>
</html>
```
