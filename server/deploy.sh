#!/bin/sh
# 本番機(サーバを常駐させているホスト)で走らせる更新スクリプト。
#
#   ./server/deploy.sh        変更があれば取り込んで再起動、無ければ何もしない
#   ./server/deploy.sh -f     変更が無くても再起動する
#
# なぜ git pull ではないか:
#   このフォークの幹は「upstream + スカッシュ1コミット」を amend して force push する
#   運用で、コミットIDが毎回変わる。fast-forward できないので pull はマージを試みて
#   壊れる。本番機は配られる側に徹して reset --hard で追従する。
#   → 本番機でソースを直接編集しても、次回ここで消える。編集は開発機で行うこと。
#
# 実データは git に入っていないので、この操作では触れない(gitignore 済み):
#   server/config/gateway.config.json  … 設定の正。UI からの変更はここに書かれる
#   server/data/                        … 会話履歴(sqlite)と TODO
set -e

FORCE=0
[ "$1" = "-f" ] && FORCE=1

ROOT=$(cd "$(dirname "$0")/.." && pwd)
BRANCH="${STACKCHAN_BRANCH:-work}"
LABEL="${STACKCHAN_LAUNCH_LABEL:-com.p1uscode.stackchan-servers}"
cd "$ROOT"

lockhash() { shasum server/package-lock.json 2>/dev/null | cut -d' ' -f1; }

before=$(git rev-parse HEAD)
lock_before=$(lockhash)

# ローカル変更は捨てる。捨てるものがあるなら黙って消さずに見せる。
dirty=$(git status --porcelain --untracked-files=no | head -5)
if [ -n "$dirty" ]; then
  echo "[deploy] 追跡ファイルにローカル変更がある。reset で破棄する:"
  echo "$dirty" | sed 's/^/  /'
fi

git fetch --quiet origin "$BRANCH"
git reset --quiet --hard "origin/$BRANCH"
after=$(git rev-parse HEAD)

if [ "$before" = "$after" ] && [ "$FORCE" -eq 0 ]; then
  echo "[deploy] 変更なし ($(git log --oneline -1)) — 再起動しない"
  exit 0
fi

if [ "$before" != "$after" ]; then
  echo "[deploy] $(echo "$before" | cut -c1-7) -> $(echo "$after" | cut -c1-7)  $(git log --format=%s -1)"
fi

# 依存は package-lock が変わったときだけ入れ直す(npm ci は node_modules を消すので毎回は重い)。
if [ "$lock_before" != "$(lockhash)" ]; then
  echo "[deploy] package-lock が変わった — npm ci"
  (cd server && mise exec -- npm ci --silent)
else
  echo "[deploy] 依存は据え置き"
fi

echo "[deploy] $LABEL を再起動"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

# 上がりきるまで待つ。ポートが開かないまま成功扱いにすると、ロボットが
# 黙ったことに誰も気づかない。
i=0
while [ $i -lt 30 ]; do
  if nc -z 127.0.0.1 8098 2>/dev/null && nc -z 127.0.0.1 8097 2>/dev/null; then
    echo "[deploy] 完了 (gateway:8098 / mcp:8097 応答)"
    exit 0
  fi
  i=$((i + 1))
  sleep 1
done

echo "[deploy] ★ 30秒待っても gateway が上がらない。ログを見ること:"
echo "         tail -40 $ROOT/server/logs/launchd.log"
exit 1
