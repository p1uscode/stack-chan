// VOICEVOX synthesis for the Mac gateway (Phase 2a-2). Ported from
// firmware/mods/local_voice_chat/mod.js (synthesizePiece / splitSentences /
// safeTtsRate): same audio_query -> outputSamplingRate override -> synthesis
// flow, same sentence chunking. Runs on Node's native fetch; the gateway streams
// each sentence's WAV to the robot over the WebSocket.

import { shapeTtsWav } from '#gateway/tts-loudness.ts'

const fetchWithTimeout = (url, options = {}, timeoutMs = 45000) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timeout ${url}`)), timeoutMs)
  return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(timer))
}

// The CoreS3's AW88298 amp can't clock 11025 Hz or its multiples (ESP32-S3 PLL
// gap) — those play as SILENCE. Drop an unsupported rate to VOICEVOX's 24000
// default so a bad ttsRate can never mute the robot.
export const safeTtsRate = (rate) => {
  const r = Number(rate) || 0
  if (r > 0 && r % 11025 === 0) return 0 // 0 = leave VOICEVOX at its 24000 default
  return r
}

// Split a reply into pieces synthesized one at a time. FIRST piece breaks at the
// first sentence end so speech starts quickly; later pieces group up to
// CHUNK_MARKS punctuation marks each (fewer, bigger requests). Newlines break.
export const splitSentences = (text) => {
  const SENTENCE_END = '。．！？\n'
  const MARKS = '。．、！？'
  const CHUNK_MARKS = 3
  const pieces = []
  let current = ''
  let marks = 0
  const flush = () => {
    const piece = current.trim()
    if (piece.length > 0) pieces.push(piece)
    current = ''
    marks = 0
  }
  for (const ch of text) {
    current += ch
    if (MARKS.includes(ch)) marks += 1
    const isFirst = pieces.length === 0
    const boundary = ch === '\n' || (isFirst ? SENTENCE_END.includes(ch) : marks >= CHUNK_MARKS && MARKS.includes(ch))
    if (boundary) flush()
  }
  flush()
  return pieces
}

// Synthesize one short piece of text to a WAV (Buffer) via VOICEVOX.
// accessHeaders carries CF-Access-* for the Cloudflare public URL (external).
// 読み上げ用の言い換え。VOICEVOX は知らない英字列を1文字ずつ読む
// (実測: "TODO" → 「ティイオオディイオオ」)。"StopWatch" や "AI" は正しく読めるので、
// 落ちるものだけをカナに置き換える。表示や履歴には触らず、音声の直前でだけ効かせる。
//
// 既定に加えて config の common.readings で足せる: { "TODO": "トゥードゥー", ... }
// TODO 系は VOICEVOX のユーザー辞書側に入れた(config/voicevox/)。アクセントまで
// 指定できるうえ、掛け合いや試聴など全経路に効くのでそちらが本筋。ここは辞書を
// 触らずに足したいときの逃げ道として残す。
const DEFAULT_READINGS = {
  URL: 'ユーアールエル',
  MCP: 'エムシーピー',
  LLM: 'エルエルエム',
  API: 'エーピーアイ',
}

// 長い語から先に当てる(短い語が長い語の一部を食わないように)。
export const applyReadings = (text, extra = {}) => {
  const table = { ...DEFAULT_READINGS, ...(extra ?? {}) }
  let out = String(text ?? '')
  for (const key of Object.keys(table).sort((a, b) => b.length - a.length)) {
    if (!key) continue
    // 英数字の語境界で区切る。日本語に挟まれていても置換したいので \b は使わない。
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'g'), table[key])
  }
  return out
}

export const synthesizePiece = async (base, speaker, text, accessHeaders = {}, rate = 0, readings = {}, loudness) => {
  text = applyReadings(text, readings)
  const queryResponse = await fetchWithTimeout(
    `${base}/audio_query?text=${encodeURIComponent(text)}&speaker=${speaker}`,
    { method: 'POST', headers: { ...accessHeaders } },
    30000,
  )
  if (!queryResponse.ok) throw new Error(`audio_query ${queryResponse.status}`)
  let query = await queryResponse.text()
  // Lower VOICEVOX's output sample rate to shrink the WAV (~proportional to rate).
  // The WAV header carries the rate, so playback follows. (rate pre-validated by
  // safeTtsRate — the AW88298 can't clock 11025 & multiples.)
  if (rate > 0) query = query.replace(/"outputSamplingRate"\s*:\s*\d+/, `"outputSamplingRate":${rate}`)
  const synth = await fetchWithTimeout(
    `${base}/synthesis?speaker=${speaker}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...accessHeaders }, body: query },
    45000,
  )
  if (!synth.ok) throw new Error(`synthesis ${synth.status}`)
  // 鳴らす直前にラウドネスを整える。VOICEVOX の生出力はピークだけが突出していて、
  // ロボット側の音量を上げると小型スピーカーが飽和する(→ tts-loudness.ts)。
  return shapeTtsWav(Buffer.from(await synth.arrayBuffer()), loudness)
}

// Derive the VOICEVOX base URL / speaker / rate from a gateway profile.
export const ttsParams = (profile) => {
  return {
    base: profile.voicevox,
    speaker: profile.speaker ?? 1,
    rate: safeTtsRate(profile.ttsRate),
    loudness: profile.ttsLoudness,
  }
}
