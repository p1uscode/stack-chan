// Codex Realtime backend — the無線 version of the USB "Codex(USB)" mode.
//
// The robot stays in its normal gateway mode: it records an utterance with local
// VAD and streams the WAV over the existing WebSocket. Instead of whisper → LLM →
// VOICEVOX, this module pushes that audio into an OpenAI Realtime session owned by
// the local Codex app-server, and streams the response audio straight back. So the
// robot needs no firmware change and never speaks WebRTC itself.
//
// Only detected utterances leave the house — unlike the USB path, which keeps the
// microphone open and streams the room continuously while a session is active.
//
// Requires `codex app-server --listen unix://<socket>` to be running (start-all
// launches it) and a ChatGPT-authenticated codex CLI (0.145+; older builds reject
// realtime with "requires api key auth").

import { Deferred, delay } from '#codex/async.ts'
import { RealtimeWebRtcSession } from '#codex/audio/webrtc.ts'
import { CodexAppServer } from '#codex/codex/app-server.ts'
import { connectCodexDaemon, type CodexDaemonConnection } from '#codex/codex/rpc.ts'
import type { PcmChunk } from '#codex/types.ts'

// Realtime の音声は **48 kHz** で届く(2026-08-06 実測。Opus のネイティブレート。
// 以前 24 kHz と書いてあったが誤り)。M5Unified の Speaker も既定 48 kHz なので、
// そのまま渡せばリサンプルが入らない — レートは下げないこと。
// チャンクは1秒前後。小さいほど再生開始が早いが、境界の数が増える。ロボ側は
// current+next の2段に先読みで積んでいるので、境界で音が切れることはない。
const REPLY_CHUNK_MS = 1000
// WebRTC の受信トラックは**無音でもフレームが流れ続ける**ので「音が来たか」では
// ターンの終わりを判定できない。dock と同じく可聴ピークで判定する(閾値も同じ)。
const MIN_AUDIBLE_PCM_PEAK = 32
// アシスタントの transcript が来た後、音が途切れてから締めるまでの余韻。
const ASSISTANT_TAIL_MS = 1_200
// transcript/done を受けても、そこで閉じてはいけない。モデルは「ちょっと待ってね」で
// 一度返答を完了し、続きを **別のレスポンス** として喋り出すことがある(道具を挟む場合など)。
// 最初の done で閉じると続きが宙に浮き、次にこちらが発話を送った時点で喋っている最中の
// モデルを割り込みで止めてしまう(実測 2026-08-06: 返答が文の途中で切れた)。
// done のあとこの時間だけ次の音を待ち、鳴り出したら同じターンとして流し続ける。
const FOLLOWUP_WINDOW_MS = 4_000
// transcript が来ないまま無音が続いた場合の保険。
const OUTPUT_AUDIO_IDLE_FALLBACK_MS = 2_000
// Hard ceiling for one turn, so a stuck session can never wedge the robot.
const REPLY_TIMEOUT_MS = 120_000
// 応答が始まらないまま待ち続けないための上限。VAD が発話と認識しなかった場合
// (雑音だけ、極端に短い等)は音声が1バイトも来ないので、ここで打ち切ってターンを
// 閉じる。ロボは speak_end を受け取って待受けに戻れる。
const REPLY_START_TIMEOUT_MS = 15_000
// 発話を流し込む刻み。送信キュー(10フレーム=200ms)を溢れさせない範囲で、
// タイマー精度に振り回されない大きさ。
const FEED_SLICE_MS = 100
// Close an idle realtime session (it costs money to keep open) but keep it long
// enough that a normal back-and-forth reuses the same conversation context.
const SESSION_IDLE_MS = 5 * 60_000

export type CodexRealtimeOptions = {
  socketPath?: string
  cwd: string
  voice?: string
  prompt?: string
  /**
   * **realtime では道具は使えない**(2026-08-07 調査)。codex の API 表面
   * (thread/realtime/*)にツール呼び出しに当たるものが無く、dynamicTools は
   * thread/start 側の仕組みで realtime セッションからは参照されない。実測でも
   * item/tool/call は一度も来なかったので、渡す口ごと持たない。
   * 道具が要る用途は backend=ollama / codex(テキスト)を使うこと。
   */
  log?: (message: string) => void
}

export type CodexTurnHandlers = {
  // Called with each ~1 s slice of reply audio, already wrapped as a WAV.
  onAudio: (wav: Buffer) => Promise<void> | void
  // Called once the assistant's transcript is known (for logging / speak_text).
  onText?: (text: string) => void
  // Realtime 側が聞き取ったこちらの発話(ロボの `heard` 相当)。
  onHeard?: (text: string) => void
}

// 無音フレームと発話フレームの区別。dock と同じ閾値。
const hasAudiblePcm16 = (data: Uint8Array): boolean => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  for (let offset = 0; offset + 1 < data.byteLength; offset += 2) {
    if (Math.abs(view.getInt16(offset, true)) >= MIN_AUDIBLE_PCM_PEAK) return true
  }
  return false
}

const wavHeader = (byteLength: number, sampleRate: number): Buffer => {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + byteLength, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(byteLength, 40)
  return header
}

export const pcmToWav = (pcm: Buffer, sampleRate: number): Buffer =>
  Buffer.concat([wavHeader(pcm.length, sampleRate), pcm])

// The robot sends a canonical 44-byte-header PCM16 mono WAV (mic is 16 kHz).
// Read the rate from the header rather than assuming it.
export const wavToPcm = (wav: Buffer): { pcm: Buffer; sampleRate: number } => {
  if (wav.length < 44) throw new Error('WAV too short')
  const sampleRate = wav.readUInt32LE(24)
  const declared = wav.readUInt32LE(40)
  const available = wav.length - 44
  const length = declared > 0 && declared <= available ? declared : available
  return { pcm: wav.subarray(44, 44 + length), sampleRate }
}

export class CodexRealtime {
  #options: CodexRealtimeOptions
  #log: (message: string) => void
  #daemon: CodexDaemonConnection | undefined
  #appServer: CodexAppServer | undefined
  #session: RealtimeWebRtcSession | undefined
  #starting: Promise<void> | undefined
  #idleTimer: ReturnType<typeof setTimeout> | undefined
  #turnActive = false

  constructor(options: CodexRealtimeOptions) {
    this.#options = options
    this.#log = options.log ?? (() => {})
  }

  get active(): boolean {
    return this.#session !== undefined
  }

  async #ensureSession(): Promise<RealtimeWebRtcSession> {
    if (this.#session) return this.#session
    if (this.#starting) {
      await this.#starting
      if (this.#session) return this.#session
    }
    const startup = (async () => {
      const daemon = await connectCodexDaemon(this.#options.socketPath)
      const appServer = new CodexAppServer(daemon.connection)
      await appServer.initialize()
      await appServer.openThread({ cwd: this.#options.cwd })
      const session = new RealtimeWebRtcSession(appServer, {
        voice: this.#options.voice,
        prompt: this.#options.prompt,
      })
      await session.start()
      this.#daemon = daemon
      this.#appServer = appServer
      this.#session = session
      this.#log(`codex realtime started (thread=${appServer.threadId})`)
      void session.closed.then((error) => {
        if (this.#session === session) {
          this.#log(`codex realtime closed${error ? `: ${error.message}` : ''}`)
          this.#session = undefined
          this.#appServer = undefined
          void this.#daemon?.close().catch(() => {})
          this.#daemon = undefined
        }
      })
    })()
    this.#starting = startup
    try {
      await startup
    } finally {
      this.#starting = undefined
    }
    if (!this.#session) throw new Error('codex realtime session failed to start')
    return this.#session
  }

  #touchIdle(): void {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = setTimeout(() => {
      if (this.#turnActive) return
      this.#log('codex realtime idle — closing session')
      void this.close()
    }, SESSION_IDLE_MS)
  }

  // Feed one recorded utterance and stream the reply back through `handlers`.
  // Resolves once the reply has been fully handed to the caller.
  async converse(wav: Buffer, handlers: CodexTurnHandlers): Promise<void> {
    const session = await this.#ensureSession()
    const { pcm, sampleRate } = wavToPcm(wav)
    this.#turnActive = true

    let replyRate = 24_000
    let pending: Buffer[] = []
    let pendingBytes = 0
    // 可聴フレームを最後に受けた時刻。無音フレームでは更新しない。
    let lastAudibleAt = 0
    let speaking = false
    let transcriptDone = false
    // transcript/done を受けたら「この時刻で締める」を入れる。無音判定だけに頼らない
    // ための保険(下の onNotification 参照)。
    let transcriptDoneAt = 0
    let responses = 0
    let done = false
    const finished = new Deferred<void>()
    const finish = () => {
      done = true
      finished.resolve()
    }
    // 送信は**直列**にする。onAudio は「audio 制御フレーム → バイナリ」の順で送るので、
    // 並行に走らせると2チャンク分が交錯してロボ側の対応が崩れる。
    let sendChain: Promise<void> = Promise.resolve()
    let sentChunks = 0

    const bytesPerChunk = () => Math.max(2, Math.floor((replyRate * 2 * REPLY_CHUNK_MS) / 1000) & ~1)
    const flush = () => {
      if (pendingBytes === 0) return
      const wavOut = pcmToWav(Buffer.concat(pending, pendingBytes), replyRate)
      pending = []
      pendingBytes = 0
      sentChunks += 1
      sendChain = sendChain.then(() => handlers.onAudio(wavOut)).catch(() => {})
    }

    const onAudio = (chunk: PcmChunk) => {
      replyRate = chunk.sampleRate
      const audible = hasAudiblePcm16(chunk.data)
      // 発話が始まる前の無音は捨てる(ロボに送っても待たされるだけ)。始まった後の
      // 無音は語間なので保持する — 切り落とすと再生が詰まって不自然になる。
      if (!audible && !speaking) return
      if (audible) {
        if (!speaking) this.#log(`codex realtime: 応答の音声が開始 (rate=${chunk.sampleRate})`)
        speaking = true
        lastAudibleAt = Date.now()
      }
      pending.push(Buffer.from(chunk.data))
      pendingBytes += chunk.data.byteLength
      if (pendingBytes >= bytesPerChunk()) flush()
    }
    // ターンの終わりは app-server の RPC 通知で分かる(realtime のデータチャネル側
    // ではない)。role=assistant の transcript/done が「言い終わった」の合図。
    const onNotification = (notification: { method?: string; params?: unknown }) => {
      const params = notification.params
      if (!params || typeof params !== 'object') return
      const record = params as Record<string, unknown>
      if (record.threadId !== this.#appServer?.threadId) return
      // **こちらが何と聞き取られたか**も transcript/done に role=user で来る(実測)。
      // 受け取り口(onHeard)を繋いでいないと、どこにも残らない。
      if (notification.method !== 'thread/realtime/transcript/done') return
      const role = typeof record.role === 'string' ? record.role : ''
      const text = typeof record.text === 'string' ? record.text : typeof record.transcript === 'string' ? record.transcript : ''
      if (role === 'user') {
        if (text) handlers.onHeard?.(text)
        return
      }
      if (role !== 'assistant') return
      transcriptDone = true
      transcriptDoneAt = Date.now()
      responses += 1
      // 「1つの返答を言い終わった」合図。ターンの終わりとは限らない(上の
      // FOLLOWUP_WINDOW_MS を参照)。無音判定に頼らないのは、Opus をデコードした
      // 無音区間のノイズ床が可聴閾値を超えることがあるため(実測: セッション開始
      // 0.2 秒で「音声開始」と誤検出)。可聴ピークの最終時刻だけを見る。
      if (text) handlers.onText?.(text)
    }
    session.on('audio', onAudio)
    this.#appServer?.on('notification', onNotification)

    // 録音済みの発話を「ライブのマイク入力」として流し込む。
    // **一括では渡せない**: 送信側のキューは 10 フレーム(200ms)しか持たず、超えた分は
    // 古い方から捨てられる(ライブ用の設計)。実測でも3秒の発話が末尾200msに削れて
    // 発話として認識されなかった。RTP は実時間で送られるので、こちらも実時間ペースで
    // 小分けに渡す。結果としてターンの遅延は「発話の長さ」だけ増える — ロボが録音を
    // まとめて送る今のプロトコルの帰結で、連続ストリーミング化すれば解消する。
    session.resetMicrophoneAudio()
    const sliceBytes = Math.max(2, Math.floor((sampleRate * 2 * FEED_SLICE_MS) / 1000) & ~1)
    for (let offset = 0; offset < pcm.length; offset += sliceBytes) {
      const slice = pcm.subarray(offset, Math.min(offset + sliceBytes, pcm.length))
      session.sendMicrophoneAudio({ data: new Uint8Array(slice), sampleRate, channels: 1, format: 's16le' })
      await delay(FEED_SLICE_MS)
    }

    const started = Date.now()
    const poll = (async () => {
      while (!done) {
        await delay(100)
        if (Date.now() - started > REPLY_TIMEOUT_MS) {
          this.#log('codex realtime turn timed out')
          break
        }
        if (!speaking && Date.now() - started > REPLY_START_TIMEOUT_MS) {
          this.#log('codex realtime: no reply started (発話として認識されず)')
          break
        }
        // 言い終わったあと、(1)音が途切れて余韻ぶん経ち、かつ(2)続きが始まらない
        // 猶予も過ぎたときに締める。続きが鳴り出せば lastAudibleAt が進み、その
        // レスポンスの done で transcriptDoneAt も進むので、自然に延長される。
        if (transcriptDone) {
          const quietFor = Date.now() - lastAudibleAt
          const sinceDone = Date.now() - transcriptDoneAt
          if (quietFor >= ASSISTANT_TAIL_MS && sinceDone >= FOLLOWUP_WINDOW_MS) break
        }
        if (!speaking) continue
        // transcript が来ない場合の保険は無音の長さで見る。
        if (!transcriptDone && Date.now() - lastAudibleAt > OUTPUT_AUDIO_IDLE_FALLBACK_MS) break
      }
      finish()
    })()

    try {
      await Promise.race([finished.promise, session.closed.then(() => undefined)])
    } finally {
      session.off('audio', onAudio)
      this.#appServer?.off('notification', onNotification)
      finish()
      await poll.catch(() => {})
      flush()
      this.#log(
        `codex realtime turn done (${((Date.now() - started) / 1000).toFixed(1)}s, ${sentChunks} chunks, responses=${responses})`,
      )
      // 送り切るまで待つ(スロットルでロボの再生ペースに合わせているため、ここは
      // 実際の再生時間に近い長さブロックする)。
      await sendChain
      this.#turnActive = false
      this.#touchIdle()
    }
  }

  async close(): Promise<void> {
    if (this.#idleTimer) clearTimeout(this.#idleTimer)
    this.#idleTimer = undefined
    const session = this.#session
    this.#session = undefined
    try {
      await session?.close()
    } catch {}
    try {
      await this.#appServer?.stopRealtime()
    } catch {}
    this.#appServer = undefined
    try {
      await this.#daemon?.close()
    } catch {}
    this.#daemon = undefined
  }
}
