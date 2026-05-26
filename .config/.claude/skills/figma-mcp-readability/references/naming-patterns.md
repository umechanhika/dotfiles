# 命名パターン辞書

フェーズ1エージェントが命名規則チェック（軸1）で参照する辞書。

---

## NGパターン（Figmaのデフォルト名）

以下のパターンに一致する `name` 属性を持つ `section`・`frame`・`group` ノードをNG判定する。

```
Frame \d+           → 例: "Frame 1", "Frame 123"
Frame               → 例: "Frame"（数字なし）
Group \d*           → 例: "Group", "Group 1"
Rectangle \d*       → 例: "Rectangle", "Rectangle 2"
Vector \d*          → 例: "Vector", "Vector 5"
Ellipse \d*         → 例: "Ellipse", "Ellipse 3"
Line \d*            → 例: "Line"
Polygon \d*         → 例: "Polygon"
Component \d+       → 例: "Component 1"
Layer \d+           → 例: "Layer 1"
Clip group          → Figmaの自動生成クリップグループ名
Auto layout \d*     → 例: "Auto layout", "Auto layout 1"
ページ \d+          → 例: "ページ 1"（日本語デフォルトページ名）
Page \d+            → 例: "Page 1", "Page 2"
```

**判定の考え方**: 数字・数字なしのバリエーションを両方カウントする。大文字小文字は区別しない（"frame 1" もNG）。

---

## OKパターン（MCPが読み取りやすい命名）

### 画面・フレームの命名

`画面名 / 状態` 形式（スラッシュ区切り）が最も読み取りやすい。

```
HomeScreen / Default
HomeScreen / Error
HomeScreen / Loading
LoginForm / Empty
LoginForm / Filled
LoginForm / ValidationError
ConfirmDialog / Open
ConfirmDialog / Closed
Button / Primary / Active
Button / Primary / Disabled
```

日本語も可：
```
ホーム / デフォルト
ホーム / エラー
ログインフォーム / 入力中
ログインフォーム / バリデーションエラー
```

### コンポーネント命名

```
Button/Primary
Button/Secondary
Card/Article
Card/Product
Input/Text
Input/Password
Icon/Arrow
Icon/Close
Navigation/Bottom
Modal/Confirm
```

### セクション・ページ命名

```
【セクション例】
認証フロー
購入フロー
マイページ
Before
After
通知設定

【ページ例】
Design
Prototype
Components
Archive
```

---

## 状態キーワード辞書

軸5（状態網羅性）チェックで `frame.name` に含まれる状態キーワードを検出するために使う。

| 状態 | 英語キーワード | 日本語キーワード |
|------|--------------|----------------|
| デフォルト | Default, Normal | デフォルト, 通常 |
| エラー | Error, Invalid | エラー, エラー状態 |
| ローディング | Loading, Skeleton | ローディング, 読み込み中, スケルトン |
| 空状態 | Empty | 空, 空状態, データなし |
| 無効 | Disabled | 無効, 非活性 |
| アクティブ | Active, Selected, Focused | アクティブ, 選択中, フォーカス中 |
| 成功 | Success | 成功 |
| 確認 | Confirm | 確認 |
| 入力中 | Filled, Typing | 入力中, 入力済み |

**1画面グループ = スラッシュ前の画面名が同じ frame の集合**  
例: "HomeScreen / Default" と "HomeScreen / Error" は同一グループ。グループあたり2種類以上の状態があると良好。

---

## 評価の目安

スコアや点数ではなく、以下の目安で問題の深刻度を判断する。

| 軸 | 要対応（badge-critical） | 改善推奨（badge-warn） | 参考（badge-info） |
|----|----------------------|---------------------|-------------------|
| 命名規則 | NG率 16%以上 | NG率 6-15% | NG率 0-5% |
| コンポーネント活用 | instance率 29%以下 | instance率 30-59% | instance率 60%以上 |
| 状態網羅性 | 1状態グループ率 60%以上 | 1状態グループ率 30-59% | 1状態グループ率 29%以下 |
| セクション構成 | セクション外フレーム多数 | セクション外フレームあり | セクション外フレームなし |
