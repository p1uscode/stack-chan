#!/usr/bin/env bash
# node は mise で管理(.mise.toml: node = 24.18.0)。
#   ./run.sh gateway   # = npm run gateway を mise の node24 で
# mise exec が .mise.toml のツール版を解決して実行する(グローバルの node は不変)。
# launchd 化のときは ExecStart を `mise exec -- npm run <script>`(WorkingDirectory=このdir)
# か、node の実体パスを直指し。
set -euo pipefail
cd "$(dirname "$0")"

# 出力は画面に流しつつ logs/<script>.log にも吐く(tee)。前回セッションは
# <script>.prev.log に1世代だけ残す(肥大防止のため追記はしない)。
mkdir -p logs
name="${1:-run}"
log="logs/${name}.log"
[ -f "$log" ] && mv -f "$log" "logs/${name}.prev.log"
echo "=== $(date '+%F %T') ./run.sh $* ===" > "$log"
mise exec -- npm run "$@" 2>&1 | tee -a "$log"
