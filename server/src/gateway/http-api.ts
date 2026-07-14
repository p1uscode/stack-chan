// Read-side HTTP API (GET /api/*) for the settings UI: connected clients, the
// turn/timeline/event log, the config, and the tool/speaker/model pickers +
// TTS sample. Each handler responds and returns true; handleReadApi returns
// false when no read route matched (so the router can fall through).

import { allClients } from '#gateway/clients.ts'
import { getConfig } from '#gateway/config.ts'
import { usageReport } from '#gateway/usage.ts'
import { listModels, listSpeakers, listTools, synthesizeSample, usableCodexVoices } from '#gateway/services.ts'
import { skitStatus } from '#gateway/skit.ts'

// Handle a GET read route. Returns true if it responded, false otherwise.
export const handleReadApi = async (req, res, url, ctx, json) => {
  const { store } = ctx
  const path = url.pathname

  if (req.method === 'GET' && path === '/api/clients') {
    const cfg = getConfig()
    const channels = cfg.channels ?? {}
    const characters = cfg.characters ?? {}
    const list = allClients().map((c) => {
      const channel = channels[c.channelKey] ?? {}
      const character = characters[channel.character] ?? {}
      return {
        id: c.id,
        hardwareId: c.hardwareId, // stable per-unit id (SHA256 of the MAC)
        channelKey: c.channelKey, // "device:<hwid>"
        character: channel.character ?? null, // bound character id
        name: channel.name ?? character.name ?? null, // effective persona name
        label: channel.label ?? null, // human label for the UI
        profile: c.profileName,
        fw: c.fw,
        busy: c.busy,
      }
    })
    // channelsTotal = registered channels; active = currently connected.
    json(res, 200, { clients: list, channelsTotal: Object.keys(channels).length })
    return true
  }
  // 掛け合い(スキット)の進行状況(UIが再生中1秒ごとにポーリング)。
  if (req.method === 'GET' && path === '/api/skit/status') {
    json(res, 200, skitStatus())
    return true
  }
  if (req.method === 'GET' && path === '/api/turns') {
    json(res, 200, { turns: store?.recentTurns(Number(url.searchParams.get('limit')) || 200) ?? [] })
    return true
  }
  // Unified, filtered, server-side paged timeline (turns + events).
  if (req.method === 'GET' && path === '/api/timeline') {
    const q = url.searchParams
    const result = store?.timeline({
      limit: Number(q.get('limit')) || 50,
      offset: Number(q.get('offset')) || 0,
      from: q.get('from') || undefined,
      to: q.get('to') || undefined,
      category: q.get('category') || undefined,
      kind: q.get('kind') || undefined,
      who: q.get('who') || undefined,
      device: q.get('device') || undefined,
    }) ?? { items: [], total: 0, limit: 50, offset: 0 }
    json(res, 200, result)
    return true
  }
  if (req.method === 'GET' && path === '/api/events') {
    json(res, 200, { events: store?.recentEvents(Number(url.searchParams.get('limit')) || 200) ?? [] })
    return true
  }
  if (req.method === 'GET' && path === '/api/config') {
    json(res, 200, getConfig())
    return true
  }
  // Claude / Codex の利用枠。枠に当たると**黙って止まる**ので、原因の切り分けに要る。
  // 取りに行くのが重い(app-server と往復する)ので、開いたときだけ呼ぶ前提。
  if (req.method === 'GET' && path === '/api/usage') {
    json(res, 200, await usageReport())
    return true
  }
  // Tool catalog (channel-scoped vs character-scoped) for the settings UI.
  if (req.method === 'GET' && path === '/api/tools') {
    if (!listTools) return (json(res, 200, { channelTools: [], characterTools: [] }), true)
    try {
      json(res, 200, await listTools())
    } catch (err) {
      json(res, 502, { error: `tools: ${err.message}` })
    }
    return true
  }
  // Voice picker: list VOICEVOX speaker styles for the per-device dropdown.
  if (req.method === 'GET' && path === '/api/speakers') {
    if (!listSpeakers) return (json(res, 200, { speakers: [] }), true)
    try {
      json(res, 200, { speakers: await listSpeakers() })
    } catch (err) {
      json(res, 502, { error: `speakers: ${err.message}` })
    }
    return true
  }
  // codex-realtime の声。実際に通る並びだけ返す(v2 の名前は今のモデルでは弾かれる)。
  // app-server が落ちていると引けないので、その場合は空で返して UI 側を手入力に
  // 落とす(設定画面そのものは開けるように)。
  if (req.method === 'GET' && path === '/api/codex-voices') {
    if (!usableCodexVoices) return (json(res, 200, { voices: [] }), true)
    try {
      json(res, 200, { voices: await usableCodexVoices() })
    } catch (err) {
      json(res, 200, { voices: [], error: err.message })
    }
    return true
  }
  // LLM model list (ollama) for the character model dropdown.
  if (req.method === 'GET' && path === '/api/models') {
    if (!listModels) return (json(res, 200, { models: [] }), true)
    try {
      json(res, 200, { models: await listModels() })
    } catch (err) {
      json(res, 502, { error: `models: ${err.message}` })
    }
    return true
  }
  // Voice sample: synthesize a short line in the given speaker, return WAV.
  if (req.method === 'GET' && path === '/api/tts-sample') {
    if (!synthesizeSample) return (json(res, 404, { error: 'no tts' }), true)
    const speaker = Number(url.searchParams.get('speaker'))
    if (!Number.isFinite(speaker)) return (json(res, 400, { error: 'speaker required' }), true)
    const text = url.searchParams.get('text') ?? ''
    try {
      const wav = await synthesizeSample(speaker, text.slice(0, 100))
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length })
      res.end(wav)
    } catch (err) {
      json(res, 502, { error: `tts: ${err.message}` })
    }
    return true
  }

  return false
}
