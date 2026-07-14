// STT for the gateway (Phase 2b). The robot streams its mic WAV over the
// WebSocket; the gateway transcribes it here via the LAN whisper server
// (whisper.cpp /inference, OpenAI-ish multipart), so the robot no longer needs
// its own whisper HTTP call (and external drops the ai-whisper dependency).
// Mirrors firmware/mods/.../stt-whisper.ts: multipart with model/language/file.

export const transcribe = async (whisperUrl, wav, accessHeaders = {}, timeoutMs = 30000) => {
  const form = new FormData()
  form.append('model', 'whisper-1')
  form.append('language', 'ja')
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speak.wav')

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error('whisper timeout')), timeoutMs)
  try {
    const r = await fetch(whisperUrl, { method: 'POST', body: form, headers: accessHeaders, signal: ac.signal })
    if (!r.ok) throw new Error(`whisper ${r.status}`)
    const j: any = await r.json()
    return (j.text ?? '').trim()
  } finally {
    clearTimeout(timer)
  }
}
