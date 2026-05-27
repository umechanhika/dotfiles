# Android(Kotlin/Compose) 固有レビュー観点

このファイルは Android・Kotlin・Jetpack Compose に固有のレビュー観点をまとめたもの。
言語非依存の普遍的観点は `review-general.md` を参照すること。

各観点は「何を見るか」を簡潔に示す。指摘を書く際の言い回し・トーンは SKILL.md の言い回しルールに従う。

## 目次
1. Kotlin イディオム
2. コルーチン・Flow 設計
3. Jetpack Compose
4. アーキテクチャ（MVVM / UseCase）
5. リソース・文字列・Room
6. ライフサイクル安全性・構成変更
7. メモリリーク
8. ProGuard / R8
9. パーミッション
10. ナビゲーション
11. アクセシビリティ
12. テーマ・画面サイズ
13. Compose 安定性・最適化
14. 動作確認エビデンス

---

## 1. Kotlin イディオム

- `!!`（non-null assertion）を使っていないか。`?.let { … }` や `?: return` で簡潔に null チェックする（例: `val userId = userIdUseCase.get().first() ?: return`）
- `null` を引数に渡して実質「何もしない」処理になっていないか
- スコープ関数（`let/also/apply/run/with`）を目的に合わせて使い分けているか。null チェックは `?.let` で書き換えるとシンプルになる場合がある
- 再代入しない変数は `val` で宣言する。`val` 化で `get()` を省略できないか
- 関数引数・コレクション要素の末尾に trailing comma を付ける（Kotlin コーディング規約）
- `init` でしか使われない `private val` は引数への変更を検討する

## 2. コルーチン・Flow 設計

- 画面 UI 状態は `StateFlow`、画面遷移・ダイアログ等の一度だけのイベントは `SharedFlow`（または consume するイベントリスト）で管理しているか
- `StateFlow` の初期値は適切か（不要な `null` を避ける）
- UiEvent は画面ごとの sealed interface/class に集約されているか。消費（consume）は処理を実行してから行う。複数箇所で消費タイミングが揃っているか
- `runBlocking` をメインスレッドで使っていないか（ANR リスク）。DB・ネットワークは適切な Dispatcher（IO 等）で行っているか
- `viewModelScope.launch` でエラーハンドリングができているか
- `combine` / `flatMapLatest` ブロック内でエラーハンドリングが漏れていないか（片方が常に Success だとエラーが伝播しないリスク）
- 画面ログは ViewModel の `init` で送信する方針に準拠しているか
- ViewModel のプロパティ（Logger 等）が不必要に公開（非 private）になっていないか。`_uiState`/`uiState` パターンを守っているか
- UseCase 命名に HTTP メソッド名（`Get`/`Post`）が含まれていないか（ドメイン観点の命名）

## 3. Jetpack Compose

- 状態収集は `collectAsStateWithLifecycle` を使っているか（`collectAsState` ではなく）
- UiEvent のコレクトは `repeatOnLifecycle(STARTED)`（または `LaunchedEffect` + `repeatOnLifecycle`）で行っているか
- Composable 本体（コンポーズフェーズ）で副作用を直接実行していないか。副作用は Effect API で行う
- `forEach` ブロック内の `return` は非ローカルリターンになり後続処理がスキップされる。`return@forEach` が必要か確認する
- `LaunchedEffect` のキーは適切か（`Unit` で良いケース vs 可変値が必要なケース）
- `Modifier.fillMaxWidth()` 等でタップ領域を適切に広げているか（テキストリンク等）
- `DialogProperties` の `dismissOnBackPress` / `dismissOnClickOutside` をデフォルトのまま使い、旧実装（`isCancelable` 等）から動作が変わっていないか
- Preview が追加・更新され、他の Composable と一貫しているか（`showBackground` 等）。Fake 実装は Preview メソッド内に定義する方が分かりやすい

## 4. アーキテクチャ（MVVM / UseCase）

- 画面の条件分岐ロジックが Composable に含まれていないか（ViewModel 側へ）
- ViewModel から Repository を直接呼ばず UseCase を経由しているか
- ScreenState はデータのみを持ち、メソッド・ビジネスロジックを持たないか
- バリデーション結果（Valid/Invalid）は ViewModel または UseCase 側に持たせ、画面側に持たせていないか
- Widget のパディングは利用側で付ける設計が推奨。パーツ側が上下左右で不揃いなパディングを持っていないか

## 5. リソース・文字列・Room

- 既存の文字列定義（`strings.xml`）と同じ文言を直書きしていないか
- Room のスキーマ変更時、Migration とスキーマファイル（`schemas/*.json`）が更新されているか

## 6. ライフサイクル安全性・構成変更

- 画面回転・構成変更・プロセス death で状態が失われないか（`rememberSaveable` / SavedStateHandle の検討）
- 非同期コールバックが破棄済みの画面・View を参照していないか（`isAdded` 相当のガード、ライフサイクルスコープの利用）

## 7. メモリリーク

- Context / Activity / View への長命な参照を保持していないか（静的参照・シングルトン・コールバック）
- `LocalContext.current` を `remember` キーなしの安定クラス内で保持し、Activity 再生成後に古い Context を参照するリスクがないか
- `remember { … }` にキーが必要なのに省略され、引数が変わっても再生成されない状態になっていないか

## 8. ProGuard / R8

- リフレクション・シリアライズ・JSON マッピング対象のクラスに難読化・削除の影響がないか（Keep ルールの要否）
- リリースビルド（R8 適用）での動作確認が必要なケースを事前に促す

## 9. パーミッション

- 実行時パーミッションの要求・拒否時のハンドリングがあるか
- マニフェストへのパーミッション宣言が過不足ないか

## 10. ナビゲーション

- バックスタックの整合（多重 push、戻り先の妥当性）
- ディープリンクの扱いが正しいか
- 連打・再表示による二重遷移・ダイアログ二重表示を防止できているか

## 11. アクセシビリティ

- 画像・アイコンに `contentDescription`（装飾なら null 明示）が設定されているか
- タップ領域が最小 48dp を満たすか
- 動的フォントスケール（大きい文字設定）でレイアウトが破綻しないか

## 12. テーマ・画面サイズ

- ダークテーマ / テーマ切替で配色が破綻しないか（色のハードコードを避ける）
- 多様な画面サイズ・タブレット・フォルダブルで表示が崩れないか

## 13. Compose 安定性・最適化

- state ホイスティングが適切か（状態の持ち主が正しい階層にあるか）
- `LazyColumn` / `LazyRow` の item に安定した `key` が指定されているか
- 頻繁に変わる計算は `derivedStateOf` で再コンポーズを抑えられないか
- ViewModel やコールバックを `remember` のキーなしで保持し、想定外の再生成・古い参照が起きないか
- `Modifier` のチェイン順序が意図通りか（padding と背景・クリックの順序等）

## 14. 動作確認エビデンス

- UI 変更があるなら動作確認のスクリーンショット（または GIF）が PR 説明に添付されているか
- Before/After の確認が必要な変更は両方を用意しているか
