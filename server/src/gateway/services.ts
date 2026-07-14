// UI support services: read-only helpers backing the settings UI's pickers —
// VOICEVOX speakers, ollama models, a TTS voice sample, and the tool catalog.
// All use the default profile's endpoints (the same regardless of which robot is
// selected). Consumed by the HTTP read API.

import { CodexAppServer } from '#codex/codex/app-server.ts'
import { connectCodexDaemon } from '#codex/codex/rpc.ts'
import { discoverMcpTools } from '#gateway/agent.ts'
import { CHANNEL_TOOL_NAMES } from '#gateway/body-tools.ts'
import { accessHeadersOf, getDefaultProfile, profileFor } from '#gateway/config.ts'
import { synthesizePiece } from '#gateway/voicevox.ts'

// VOICEVOX helpers for the UI's voice picker (task: per-device voice dropdown +
// sample playback). Both use the default profile's VOICEVOX endpoint/headers —
// the voice list and samples are the same regardless of which robot is selected.
export const listSpeakers = async () => {
  const p = profileFor(getDefaultProfile())
  const r = await fetch(`${p.voicevox}/speakers`, { headers: accessHeadersOf(p) })
  if (!r.ok) throw new Error(`speakers ${r.status}`)
  const speakers: any = await r.json()
  // Flatten to [{ id, label }] — one entry per style (the id used as `speaker`).
  return speakers.flatMap((sp) => (sp.styles ?? []).map((st) => ({ id: st.id, label: `${sp.name}(${st.name})` })))
}
// Available LLM model names from ollama (/api/tags), for the character model dropdown.
export const listModels = async () => {
  const p = profileFor(getDefaultProfile())
  const r = await fetch(`${p.ollama}/api/tags`, { headers: accessHeadersOf(p) })
  if (!r.ok) throw new Error(`models ${r.status}`)
  const data: any = await r.json()
  return (data.models ?? []).map((m) => m.name).sort()
}
export const synthesizeSample = async (speaker, text) => {
  const p = profileFor(getDefaultProfile())
  // rate 0 = VOICEVOX's 24000 default (browser playback, so the AW88298 limit
  // that safeTtsRate guards against on the robot doesn't apply here).
  // ラウドネス整形は通す。声を選ぶための試聴なので、実機で鳴る音と揃っている方がいい。
  return await synthesizePiece(
    p.voicevox,
    speaker,
    text || 'こんにちは、スタックちゃんです。',
    accessHeadersOf(p),
    0,
    {},
    p.ttsLoudness,
  )
}

// codex-realtime の声。VOICEVOX を通らないぶん声は OpenAI 側で決まるので、
// 一覧は app-server に聞く(こちらで持つと codex の更新に追随できない)。
// 返ってくる v1 / v2 は声のセットの版で、**両方が使えるとは限らない**
// (下の usableCodexVoices を見ること)。
//
// app-server は launchd 起動だと不安定で、落ちていると当然引けない。呼び出し側は
// 失敗を許容して「手入力に落とす」こと —— 声が選べないだけで設定画面全体を
// 落とすほどの話ではない。
// daemon 接続して引くので安くない。声が増えるのは codex の更新時だけなので、
// 一度引けたら持っておく(gateway を再起動すれば取り直す)。
let codexVoiceCache: { v1: string[]; v2: string[]; defaultV1?: string; defaultV2?: string } | null = null

export const listCodexVoices = async () => {
  if (codexVoiceCache) return codexVoiceCache
  const p = profileFor(getDefaultProfile())
  const daemon = await connectCodexDaemon(p.codex?.socket)
  try {
    const appServer = new CodexAppServer(daemon.connection)
    await appServer.initialize()
    codexVoiceCache = await appServer.listRealtimeVoices()
    return codexVoiceCache
  } finally {
    await daemon.close().catch(() => {})
  }
}

// **実際に使えるのは v1 の並びだけ**(2026-08-07 実測)。app-server は v1 と v2 を
// 両方返してくるが、v2 の名前を渡すと realtime の起動が落ちる:
//   realtime voice `marin` is not supported for v3;
//   supported voices: juniper, maple, spruce, ember, vale, breeze, arbor, sol, cove
//
// これは**起動の版が古いから**ではない。thread/realtime/start の version を総当たり
// した結果(有効な値は v1 / v2 / v3):
//   v2 → 「AVAS realtime calls require realtime v1 or v3」で門前払い
//   v1 / v3 → どちらも受け付ける声は上の9種(= voices.v1)だけ
// つまり ChatGPT アカウント経由の realtime(AVAS)では v1/v3 しか選べず、
// voices.v2(alloy / marin / cedar …)は **API キー経由の realtime 専用**。
// 認証方式を変えない限り出しても選べないので、選ばせる側はこの関数を通す。
// 一覧(listCodexVoices)は app-server の生の返事のまま置いておく。
export const usableCodexVoices = async (): Promise<string[]> => (await listCodexVoices()).v1 ?? []

// Tool catalog for the UI, split by scope:
//   channelTools  = channel-scoped (body ops) — chosen on the CHANNEL
//   characterTools = channel-independent (MCP: web_search / local_docs …) — chosen on the CHARACTER
export const listTools = async () => {
  const p = profileFor(getDefaultProfile())
  let mcp = []
  try {
    mcp = (await discoverMcpTools(p.mcp, accessHeadersOf(p))).map((t) => ({ name: t.name, description: t.description ?? '' }))
  } catch {
    // MCP unreachable — still return the channel tools so the UI works
  }
  return {
    // start_skit は身体系ではないがチャンネル依存(自分+接続中の相方で掛け合い)。
    channelTools: [...CHANNEL_TOOL_NAMES, 'start_skit'].map((name) => ({ name })),
    characterTools: mcp,
  }
}
