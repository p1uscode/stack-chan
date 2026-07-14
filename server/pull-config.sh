#!/bin/sh
# 本番機(red)の**実設定**を開発機へ取ってくる。
#
#   ./server/pull-config.sh          取ってくる(差分があれば見せる)
#   ./server/pull-config.sh -n       取ってこない。差分だけ見る
#
# 向きは **red → 手元の一方通行**。red が正で、手元は「その時点の写し」を置いておく
# だけの場所。逆向き(手元 → red)は用意しない —— UI やロボットからの変更が red の
# ファイルに直接書かれるので、手元から押し戻すと**それを黙って消す**ことになる。
#
# 取ってくるのは gitignore 済みのファイルなので、コミットには入らない:
#   config/gateway.config.yaml   設定の正(人格・チャネル・エンドポイント)
#   config/gateway.secret.yaml   秘密(あれば)
set -e

REMOTE="${STACKCHAN_REMOTE:-red}"
REMOTE_ROOT="${STACKCHAN_REMOTE_ROOT:-/Users/p1us2er0/scm/p1uscode/stack-chan}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEST="$ROOT/server/config"

DRY=0
[ "$1" = "-n" ] && DRY=1

for f in gateway.config.yaml gateway.secret.yaml; do
  if ! ssh "$REMOTE" "test -f $REMOTE_ROOT/server/config/$f" 2>/dev/null; then
    continue
  fi
  tmp=$(mktemp)
  scp -q "$REMOTE:$REMOTE_ROOT/server/config/$f" "$tmp"
  if [ -f "$DEST/$f" ] && diff -q "$DEST/$f" "$tmp" >/dev/null 2>&1; then
    echo "[pull] $f  変更なし"
    rm -f "$tmp"
    continue
  fi
  if [ -f "$DEST/$f" ]; then
    echo "[pull] $f  差分:"
    diff -u "$DEST/$f" "$tmp" | sed 's/^/  /' || true
  else
    echo "[pull] $f  新規"
  fi
  if [ "$DRY" -eq 1 ]; then
    rm -f "$tmp"
    continue
  fi
  # 上書き前に1世代だけ残す。手元で試しに書き換えていたぶんを黙って消さないため。
  [ -f "$DEST/$f" ] && cp "$DEST/$f" "$DEST/$f.prev"
  mv "$tmp" "$DEST/$f"
  chmod 600 "$DEST/$f"
  echo "[pull] $f  取り込んだ -> server/config/$f"
done
