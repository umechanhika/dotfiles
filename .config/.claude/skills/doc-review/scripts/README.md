# doc-review/scripts — モジュールマップ

`serve.py` は path 起動（`python3 <skill_dir>/scripts/serve.py ...`）のため、同じ `scripts/`
ディレクトリの兄弟モジュールを直接 import できる（`scripts/` が sys.path 上にある）。
保守時は「責務 → ファイル」で対象を絞って読むこと（全文再読を避ける）。

| 責務 | ファイル |
| --- | --- |
| HTTP サーバ本体（`Handler` の全ルート・`run_server`・`reply` サブコマンド・CLI・watcher・バッチID/lock）。エントリポイント | `serve.py` |
| スレッドストア（`STORE` 辞書・`THREADS_PATH`・`RLock` を保持。`configure()`/`store()`/`LOCK`、`load`/`save`/`find_thread`/`merge_anchor`） | `dr_store.py` |
| 純粋ヘルパー（`_now`/`_kind_for_ext`/`default_work_dir`/`_content_type_for`、状態なし） | `dr_util.py` |

## 共有状態の約束（分割時の整合）
- ストアの可変状態・ファイルパス・ロックは **`dr_store` が単一所有**する。`run_server` が
  `dr_store.configure(<work_dir>/threads.json)` → `dr_store.load()` で初期化する。
- `serve.py` は `_lock = dr_store.LOCK` で同一ロックを共有し、`Handler`・inbox 書き込み・
  バッチID採番がすべて同じロックで直列化される（元の単一ロック意味論を維持）。
- `dr_store.load()` は `STORE` を再束縛するため、参照をキャッシュせず常に `dr_store.store()` 経由で取得する。

## viewer.html が読み込む静的アセット（lib/）
- CSS は `lib/comment/01-base.css 〜 06-media.css` に責務分割し、viewer.html がこの順で `<link>`
  読み込み（連結すると元 `comment.css` とバイト一致＝カスケード不変）。
- `lib/comment.js` は単一 IIFE のまま（責務別分割は別途・ブラウザ検証要のため保留）。
