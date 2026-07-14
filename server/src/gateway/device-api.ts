// 端末(ロボット)が自分の設定を読み書きするための狭い API。
//
//   GET   /api/device/<hardware_id>   いまの設定 + 選べる候補
//   PATCH /api/device/<hardware_id>   {backend?, model?, speaker?, character?} だけを渡す
//
// なぜ /api/config を直接使わせないか:
//   1) あれは**設定ファイル全体**を送り返す方式で、端末が 7KB の JSON を保持して
//      再構築することになる。しかも UI と同時に編集すると**相手の変更を消す**。
//   2) 候補(声127スタイル)は端末の小さい画面で扱える形に整形して渡したい。
// 読み書きの合成はサーバ側でやり、端末は差分だけ送る。
//
// 対象は hardware_id から引いたチャネルに紐づく**キャラクター**。声やモデルは
// キャラクターの属性なので、同じキャラを複数チャネルに宿していれば両方に効く。

import { allClients } from '#gateway/clients.ts'
import { channelFor, getConfig, resolveProfile, saveConfig } from '#gateway/config.ts'
import { listModels, listSpeakers, usableCodexVoices } from '#gateway/services.ts'

// 端末の UI で使えるバックエンド。ai-ui の選択肢と揃える。
// ollama は**空文字ではなく明示の値**。空文字だと「キーを消す = 既定に落ちる」に
// なり、設定を見ても何で動いているのか分からない(綴りを間違えたときも同じ姿になる)。
const BACKENDS = [
  { value: 'ollama', label: 'ollama' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'codex-realtime', label: 'Codex RT' },
]

// "四国めたん(ノーマル)" を {name, styles:[{id,label}]} にまとめ直す。
// 127スタイルを一列で送ると端末側で送りきれないので、話者名 → スタイルの2段にする。
const groupVoices = (flat: Array<{ id: number; label: string }>) => {
  const groups: Array<{ name: string; styles: Array<{ id: number; label: string }> }> = []
  const index = new Map<string, number>()
  for (const v of flat) {
    const m = /^(.*?)\((.*)\)$/.exec(v.label)
    const name = m ? m[1] : v.label
    const style = m ? m[2] : 'ノーマル'
    let at = index.get(name)
    if (at === undefined) {
      at = groups.length
      index.set(name, at)
      groups.push({ name, styles: [] })
    }
    groups[at].styles.push({ id: v.id, label: style })
  }
  return groups
}

// 端末から人格を指すための引き方。UUID を端末に焼き込むと、設定を作り直した
// だけでファームを焼き直すことになるので、character に持たせた ASCII の `key`
// (例 "haro-pink")で引けるようにする。id / key / name の順に見る。
const findCharacterId = (cfg: any, ref: string): string | null => {
  const characters = cfg.characters ?? {}
  if (characters[ref]) return ref
  for (const [id, c] of Object.entries<any>(characters)) {
    if (c?.key === ref) return id
  }
  for (const [id, c] of Object.entries<any>(characters)) {
    if (c?.name === ref) return id
  }
  return null
}

// その筐体が描ける顔の識別子。ロボットが hello で申告してくる。
// **座標や比率はサーバに持たない** —— 画面の形と大きさに依るので、他の筐体では
// 使えない値になる。サーバが持つのは「どの顔か」という名前だけで、描くのは筐体。
// 申告が無い(古いファーム)なら絞らない —— 絞ると全部消えて何も選べなくなる。
const renderableFaces = (hwid: string): string[] | null => {
  const client = allClients().find((c) => c.hardwareId === hwid)
  const faces = client?.faces
  return Array.isArray(faces) && faces.length > 0 ? faces : null
}

// 端末の一覧に出す人格。**入口で絞る**が、束縛そのものは禁じない
// (顔が描けないことと、その人格として喋れることは別。宿った先で描けなければ
//  既定の顔に落として続ける)。
const characterList = (cfg: any, faces: string[] | null) => {
  return Object.entries<any>(cfg.characters ?? {})
    .map(([id, c]) => ({ id, key: c?.key ?? '', name: c?.name ?? '', face: c?.face ?? '' }))
    .filter((c) => c.key && (!faces || !c.face || faces.includes(c.face)))
}

const resolve = (hwid: string) => {
  const cfg = getConfig()
  const channelKey = `stack-chan:${hwid}`
  const channel = channelFor(channelKey)
  const characterId = channel?.character
  const character = characterId ? cfg.characters?.[characterId] : null
  return { cfg, channelKey, channel, characterId, character }
}

export const handleDeviceApi = async (req, res, url, _ctx, json) => {
  const match = /^\/api\/device\/([0-9a-f]{4,32})$/.exec(url.pathname)
  if (!match) return false
  const hwid = match[1]
  const { cfg, channelKey, channel, characterId, character } = resolve(hwid)

  if (!channel || !character) {
    json(res, 404, { error: `no character bound to ${channelKey}` })
    return true
  }

  if (req.method === 'GET') {
    // 候補の取得は外部(ollama / VOICEVOX)に触るので、落ちても設定は返す。
    let models: string[] = []
    let voices: ReturnType<typeof groupVoices> = []
    try {
      models = await listModels()
    } catch {}
    try {
      voices = groupVoices(await listSpeakers())
    } catch {}
    // codex-realtime の声。VOICEVOX とは別枠(realtime のときだけ効く)なので
    // 分けて渡す。app-server が落ちていれば空 = 端末側は項目を出さない。
    // **使える並びだけ**渡す —— 端末の小さい画面で選んだものが弾かれると、
    // 「声を変えたら喋らなくなった」という分かりにくい壊れ方をする。
    let codexVoices: string[] = []
    try {
      codexVoices = await usableCodexVoices()
    } catch {}
    json(res, 200, {
      hwid,
      label: channel.label ?? '',
      character: { id: characterId, name: character.name ?? '', key: character.key ?? '' },
      current: {
        backend: character.backend ?? 'ollama',
        model: character.model ?? '',
        speaker: character.speaker ?? null,
        codexVoice: character.codex?.voice ?? '',
      },
      backends: BACKENDS,
      models,
      voices,
      codexVoices,
      characters: characterList(cfg, renderableFaces(hwid)),
    })
    return true
  }

  if (req.method === 'PATCH') {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let patch: any = {}
    try {
      patch = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    } catch {
      json(res, 400, { error: 'invalid json' })
      return true
    }

    // **人格の差し替えだけは宿り先(channel)側の変更**で、他のキーとは層が違う。
    // 他と混ぜると「差し替えた先の人格」ではなく「差し替える前の人格」に声や
    // モデルを書いてしまうので、ここで打ち切る。
    if ('character' in patch) {
      const id = findCharacterId(cfg, String(patch.character ?? ''))
      if (!id) {
        json(res, 400, { error: `unknown character: ${patch.character}` })
        return true
      }
      if (id !== characterId) {
        saveConfig({ ...cfg, channels: { ...cfg.channels, [channelKey]: { ...channel, character: id } } })
        // **その場で見た目を送る。**会話のたびに組み直す経路(ensureDialogue)に
        // 任せると、次に話しかけるまで顔が前の人格のままになる。選んだ瞬間に
        // 変わらないと、切り替わったのかどうか本人に分からない。
        const client = allClients().find((c) => c.hardwareId === hwid)
        if (client?.body) {
          const p = resolveProfile(client.profileName, channelKey)
          if (p.faceColor) client.body('set_face_color', p.faceColor)
          if (p.face) client.body('set_face', { face: p.face })
        }
      }
      json(res, 200, { ok: true, character: { id, name: cfg.characters?.[id]?.name ?? '' } })
      return true
    }

    const next = { ...character }
    // 空文字は「既定に戻す」= キーごと消す、という扱い(ai-ui と同じ流儀)。
    // backend だけは**必ず書く**(消さない)。他のキーは「空 = 既定に戻す」でよいが、
    // backend は既定に落ちた姿と綴りを間違えた姿が区別できなくなる。
    if ('backend' in patch) {
      next.backend = String(patch.backend || 'ollama')
    }
    if ('model' in patch) {
      if (patch.model) next.model = String(patch.model)
      else delete next.model
    }
    if ('speaker' in patch) {
      const n = Number(patch.speaker)
      if (Number.isInteger(n) && n >= 0) next.speaker = n
      else delete next.speaker
    }
    // codex.voice は入れ子なので、その1キーだけ差し替える(cwd 等を巻き添えにしない)。
    if ('codexVoice' in patch) {
      const codex = { ...(next.codex ?? {}) }
      if (patch.codexVoice) codex.voice = String(patch.codexVoice)
      else delete codex.voice
      if (Object.keys(codex).length > 0) next.codex = codex
      else delete next.codex
    }

    // 保存は差分を当てた1キャラだけ。他は触らないので UI と競合しない。
    saveConfig({ ...cfg, characters: { ...cfg.characters, [characterId]: next } })
    json(res, 200, {
      ok: true,
      current: {
        backend: next.backend ?? 'ollama',
        model: next.model ?? '',
        speaker: next.speaker ?? null,
        codexVoice: next.codex?.voice ?? '',
      },
    })
    return true
  }

  json(res, 405, { error: 'method not allowed' })
  return true
}
