#!/usr/bin/env bash
# user_dict.json の内容を VOICEVOX エンジンへ投入する。
# コンテナを作り直して辞書が消えたときに使う(既にある語は重複登録されるので、
# 事前に消したい場合は --reset を付ける)。
set -euo pipefail
cd "$(dirname "$0")"

BASE="${VOICEVOX_URL:-http://127.0.0.1:50021}"
DICT="user_dict.json"

if [ "${1:-}" = "--reset" ]; then
  echo "既存のユーザー辞書を削除します"
  for id in $(curl -s "$BASE/user_dict" | python3 -c 'import json,sys; print(" ".join(json.load(sys.stdin).keys()))'); do
    curl -s -X DELETE "$BASE/user_dict_word/$id" > /dev/null
  done
fi

python3 - "$BASE" "$DICT" <<'PY'
import json, sys, urllib.parse, urllib.request
base, path = sys.argv[1], sys.argv[2]
for entry in json.load(open(path)).values():
    q = urllib.parse.urlencode({
        "surface": entry["surface"],
        "pronunciation": entry["pronunciation"],
        "accent_type": entry["accent_type"],
    })
    req = urllib.request.Request(f"{base}/user_dict_word?{q}", method="POST")
    try:
        urllib.request.urlopen(req, timeout=20)
        print(f"  登録 {entry['surface']} -> {entry['pronunciation']}")
    except Exception as e:
        print(f"  失敗 {entry['surface']}: {e}")
PY
