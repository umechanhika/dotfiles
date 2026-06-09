# 出力HTMLテンプレート（STEP5 でのみ読む）

SKILL.md の STEP5（HTMLファイルの生成・報告）に到達したときだけ参照する。STEP1〜4の漏れ検出推論中は読み込まない。

## 記述ルール

- 出力はHTMLとして記述する。チェックボックスは `<input type="checkbox" disabled>`、表は `<table>` タグを使う。
- markdownのパイプ記法（`| ... |`）やチェックボックス記法（`- [ ]`）はHTMLファイル内では使わない。

## 雛形

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
