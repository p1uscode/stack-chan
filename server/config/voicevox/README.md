# VOICEVOX ユーザー辞書

`user_dict.json` は VOICEVOX エンジンに登録した読みの控え。

## なぜ控えを置くか

VOICEVOX は知らない英字列を1文字ずつ読む(実測: `TODO` → 「ティイオオディイオオ」)。
エンジンのユーザー辞書に登録すれば正しく読むが、**辞書はコンテナの中**
(`/home/user/.local/share/voicevox-engine/user_dict.json`)にあるため、
コンテナを作り直すと消える。ここに控えを置いて再投入できるようにしてある。

恒久化するなら、VOICEVOX を動かしている compose 側でホストにマウントする:

```yaml
services:
  voicevox:
    volumes:
      - ./voicevox-dict:/home/user/.local/share/voicevox-engine
```

※ 現状 VOICEVOX は `care-hub` プロジェクトの compose で動いているので、
そちらを触るかはプロジェクトの持ち主判断。マウントしない場合はこの控えから復元する。

## 使い方

```bash
# エンジンへ投入(コンテナを作り直したあとなど)
./config/voicevox/restore-dict.sh

# いまのエンジンの内容をこのファイルへ書き出す(語を足したあと)
curl -s http://127.0.0.1:50021/user_dict | python3 -m json.tool > config/voicevox/user_dict.json
```

## 表記ゆれに注意

surface は**大文字小文字を区別する**。`TODO` を登録しても `todo` は別語として
1文字ずつ読まれるので、使いそうな表記はすべて登録する。

## gateway 側の置換との関係

`src/gateway/voicevox.ts` にも読み替え表がある(`applyReadings`)。
こちらは**合成の直前にテキストを置き換える**方式で、エンジンに依存せず repo で管理できる。
辞書とは二重になるので、同じ語を両方に入れる必要はない。
アクセントまで作り込みたい語は辞書、手軽に足したい語は gateway 側、という使い分け。
