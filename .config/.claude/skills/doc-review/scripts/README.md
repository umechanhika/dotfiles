# doc-review/scripts — モジュールマップ

`serve.py` は path 起動（`python3 <skill_dir>/scripts/serve.py ...`）のため、同じ `scripts/`
ディレクトリの兄弟モジュールを直接 import できる（`scripts/` が sys.path 上にある）。
保守時は「責務 → ファイル」で対象を絞って読むこと（全文再読を避ける）。

| 責務 | ファイル |
| --- | --- |
| エントリポイント。`Handler`（応答ヘルパ `_send_json`/`_send_bytes`/`_read_body` 等のみ）・`run_server`・`_watcher`・`reply`/`reply-batch`/`stop` サブコマンド・URL/work-dir 解決共通化（`_resolve_base_url`/`_resolve_work_dir`）・ブラウザタブ制御（`_close_browser_tabs`/`_default_browser_bundle_id`）・CLI(`build_parser`/`main`) | `serve.py` |
| GET ルート mixin（`do_GET`・`_serve_lib_file`/`_serve_raw`/`_serve_source`/`_serve_threads`/`_serve_rev`/`_serve_baseline`）。`class GetRoutes` | `dr_routes_get.py` |
| POST ルート mixin（`do_POST`・`_submit`/`_reply`/`_reply_batch`/`_resolve`）。`class PostRoutes` | `dr_routes_post.py` |
| ランタイム設定＋活動状態（`TARGET_PATH`/`LIB_DIR`/`WORK_DIR`/`INBOX_PATH`/`BASELINE_PATH` 等・`configure()`・`touch()`/`last_activity()`） | `dr_config.py` |
| スレッドストア（`STORE`・`RLock`=`LOCK`・`configure()`/`store()`/`load`/`save`/`find_thread`/`merge_anchor`・`next_batch_id()`・`append_jsonl()`） | `dr_store.py` |
| 純粋ヘルパー（`_now`/`_kind_for_ext`/`default_work_dir`/`_content_type_for`/`atomic_write_json`、状態なし） | `dr_util.py` |

`Handler` は `class Handler(GetRoutes, PostRoutes, BaseHTTPRequestHandler)`。ルート mixin の
メソッドは `self._send_json(...)` 等を実行時 MRO 経由で解決するため、mixin 側に応答ヘルパの
import は不要。

## 共有状態の約束（分割時の整合）
- ランタイム設定（対象ファイル/lib/work パス等）と活動状態は **`dr_config` が単一所有**する。
  `run_server` が `dr_config.configure(...)` で公開し、ルート mixin と `_watcher` がそれを読む
  （module global を serve.py に置くと mixin から循環 import になるため dr_config に逃がす）。
- ストアの可変状態・ファイルパス・ロックは **`dr_store` が単一所有**する。`run_server` が
  `dr_store.configure(<work_dir>/threads.json)` → `dr_store.load()` で初期化する。
- `Handler`・inbox 書き込み（`dr_store.append_jsonl`）・バッチID採番（`dr_store.next_batch_id`）は
  すべて `dr_store.LOCK`（単一 RLock）で直列化される（元の単一ロック意味論を維持）。
- `dr_store.load()` は `STORE` を再束縛するため、参照をキャッシュせず常に `dr_store.store()` 経由で取得する。
- `/threads/reply-batch` は **all-or-nothing**（`_reply_batch`）: リクエスト内の全 item を検証してから
  全件を適用する。1件でも不正なら `dr_store.LOCK` 内で何も変更せず失敗を返す。適用時も
  `rev` の加算・`dr_store.save()` はバッチ全体でそれぞれ1回だけ（item 数に比例しない）。

## viewer.html が読み込む静的アセット（lib/）
- CSS は `lib/comment/01-base.css 〜 06-media.css` に責務分割し、viewer.html がこの順で `<link>`
  読み込み。分割時点ではロード順の連結が元 `comment.css` とバイト一致していたが、機能追加
  （frontmatter/箇条書き項目/タブアイコン等のスタイル）で各ファイルに直接手を入れているため、
  現在はバイト一致ではない。カスケードの意味（この順序で当たる）だけが保たれる制約。
- JS は `lib/comment/comment.00-core.js 〜 07-utils.js` に分割（単一 IIFE を un-wrap した順序付き
  classic script）。viewer.html がこの順で読み込む。分割時点ではロード順の連結が元 `comment.js`
  とバイト一致していたが、同様に機能追加で各ファイルへ直接手を入れているため、現在はバイト一致
  ではない。トップレベル宣言が全セグメント間で相互参照可能という前提（グローバルスコープ共有）
  だけが保たれる制約。最終セグメントが `window.ReviewDoc = { start: start }` を公開する。
