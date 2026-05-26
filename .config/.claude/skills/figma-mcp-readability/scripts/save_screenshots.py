#!/usr/bin/env python3
"""Phase 2 エージェントが get_screenshot で収集した全データを一括保存するスクリプト。
全画像を1回の実行でまとめて保存することで、Bash実行の許可プロンプトを最小化する。
"""
import argparse
import base64
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(
        description="Figma スクリーンショットを一括保存する"
    )
    parser.add_argument("--output-dir", required=True, help="保存先ディレクトリ")
    parser.add_argument(
        "--data-file",
        required=True,
        help='{"filename": "base64string", ...} 形式のJSONファイルパス',
    )
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)

    with open(args.data_file, "r") as f:
        data = json.load(f)

    if not data:
        print("保存するデータがありません。", file=sys.stderr)
        sys.exit(1)

    saved = []
    errors = []
    for filename, b64data in data.items():
        out_path = os.path.join(args.output_dir, filename)
        try:
            with open(out_path, "wb") as f:
                f.write(base64.b64decode(b64data))
            saved.append(out_path)
            print(f"Saved: {out_path}")
        except Exception as e:
            errors.append((filename, str(e)))
            print(f"Error saving {filename}: {e}", file=sys.stderr)

    print(f"\n{len(saved)} 件保存しました。", end="")
    if errors:
        print(f" ({len(errors)} 件エラー)")
    else:
        print()


if __name__ == "__main__":
    main()
