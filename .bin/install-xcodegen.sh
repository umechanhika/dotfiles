#!/usr/bin/env bash
# Claude Code のリモート環境（Ubuntu 24.04 の VM、root 実行）に XcodeGen を入れる。
# 環境設定の setup script から呼び出す。何度実行しても結果は同じ（冪等）。
#
# 使うリポジトリ: kids-camera（ios/project.yml から Xcode プロジェクトを生成し、定義の妥当性を確かめる。
#                 アプリのビルドは Xcode が要るので、この環境ではできない）
#
# Linux 向けの公式配布物が無いため、このリポジトリの GitHub Actions
# （.github/workflows/build-xcodegen.yml）でビルドした Release を取得する。
# Swift の標準ライブラリは静的リンク済みで、実行時に Swift ツールチェーンは不要。
#
# 版を上げるときは、先にワークフローを実行して Release を作り、
# そのサマリーに出る値で下の 2 行を書き換える。
set -euo pipefail

XCODEGEN_VERSION=2.44.1
# Release のビルド結果から転記する。未記入なら取得を拒否して止める
XCODEGEN_SHA256=

RELEASE_REPO="${DOTFILES_REPO:-https://github.com/umechanhika/dotfiles}"
XCODEGEN_DIR="/opt/xcodegen-$XCODEGEN_VERSION"
ASSET="xcodegen-$XCODEGEN_VERSION-linux-x86_64.tar.gz"
ASSET_URL="$RELEASE_REPO/releases/download/xcodegen-v$XCODEGEN_VERSION/$ASSET"

# 一時的なネットワーク失敗はリトライし、最終的に失敗したら止める
CURL=(curl -fsSL --compressed --retry 5 --retry-delay 2 --retry-all-errors --connect-timeout 30)

if [ -z "$XCODEGEN_SHA256" ]; then
  echo "install-xcodegen: XCODEGEN_SHA256 が未記入。ワークフロー Build XcodeGen for Linux を実行し、サマリーの値を転記すること" >&2
  exit 1
fi

# 実行ファイルは隣の XcodeGen_XcodeGenKit.resources（設定のプリセット）を読むので、
# 2 つが揃って初めて「入っている」とみなす
if [ ! -x "$XCODEGEN_DIR/xcodegen" ] || [ ! -d "$XCODEGEN_DIR/XcodeGen_XcodeGenKit.resources" ]; then
  WORK=$(mktemp -d)
  # 途中で止まっても作業ディレクトリを残さない
  trap 'rm -rf "$WORK"' EXIT
  "${CURL[@]}" -o "$WORK/$ASSET" "$ASSET_URL"
  # 取得物が Release のビルド結果と一致することを確かめてから展開する。不一致なら止まる
  echo "$XCODEGEN_SHA256  $WORK/$ASSET" | sha256sum --check --status || {
    echo "install-xcodegen: $ASSET の sha256 が期待値と一致しない。取得元: $ASSET_URL" >&2
    echo "install-xcodegen: 受け取った値: $(sha256sum "$WORK/$ASSET" | cut -d' ' -f1)" >&2
    exit 1
  }
  # 展開途中で失敗しても、次回「入っている」と誤判定しないよう、一時先に展開してから移す
  mkdir "$WORK/extract"
  tar -xzf "$WORK/$ASSET" -C "$WORK/extract" --strip-components=1
  rm -rf "$XCODEGEN_DIR"
  mv "$WORK/extract" "$XCODEGEN_DIR"
  rm -rf "$WORK"
  trap - EXIT
fi

# シンボリックリンク経由だと隣のリソースを見失って落ちるため、exec するだけの薄いスクリプトを置く。
# XcodeGen は利用者名（USER）が無いと落ちる。この環境には無いので補う
cat > /usr/local/bin/xcodegen <<WRAPPER
#!/bin/sh
: "\${USER:=\$(id -un)}"
export USER
exec "$XCODEGEN_DIR/xcodegen" "\$@"
WRAPPER
chmod 755 /usr/local/bin/xcodegen
echo "install-xcodegen: $(xcodegen --version)"
