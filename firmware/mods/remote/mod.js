// Thin-robot voice MOD (Phase 2a — docs/2026-07-13-mac-gateway-design.md).
//
// The agent loop (ollama + MCP tools) and TTS (VOICEVOX) now run on the Mac
// gateway (server/gateway.mjs). This MOD keeps only I/O on the robot:
//   trigger -> record -> local whisper (STT) -> send utterance_text over ONE
//   persistent WebSocket -> receive synthesized audio chunks -> play them.
//
// Everything reaches the gateway over a single WS connection (opened at boot,
// reconnected on drop), so there is no per-request TLS handshake — the whole
// point of the move. STT still runs on-device in 2a; it moves to the gateway
// in 2b.

import defaultBehavior from 'app-default-behavior'
import { hardwareId, initBase } from 'base'
import { DogFace, ImageFace, SimpleFace } from 'behaviors/face'

import { DOMAIN } from 'consts'
import { Emoticon } from 'effects/emoticon'
import { Emotion, emotionFromName } from 'face-state'

// 表情に連動して顔の左に出す感情マーク(emoticon)。set_emotionで表情+マークを同時に。
// NEUTRAL/DOUBTFUL/COLD はマークなし。host既存のrobot.ui.addEffect(new Emoticon)経路。
const EMOTICON_BY_EMOTION = {
  [Emotion.HAPPY]: 'heart',
  [Emotion.ANGRY]: 'angry',
  [Emotion.SAD]: 'tear',
  [Emotion.HOT]: 'sweat',
  [Emotion.SLEEPY]: 'sleepy',
}

import TCP from 'embedded:io/socket/tcp'
import TLSSocket from 'embedded:io/socket/tcp/tls'
import UDP from 'embedded:io/socket/udp'
import Resolver from 'embedded:network/dns/resolver/udp'
import WebSocketClient from 'embedded:network/websocket/client'
import config from 'mc/config'
import Modules from 'modules'
import Net from 'net'
import Preference from 'preference'
import Timer from 'timer'

// この筐体が描ける顔。**識別子はサーバとの共通語**で、どう描くかは筐体の責務
// (座標や比率は画面の形に依るので、サーバには名前しか置かない)。
// hello で申告すると、サーバは出せない顔の人格を端末の一覧から外せる。
// `simple` は旧称。`line` と同じものを指す(watch と名前を揃えた)。
//
// **顔クラスはモジュール直下で参照しない。**ここで参照するとMODの読み込み時に
// 評価され、解決できないとMODごと落ちる —— 落ちると gateway に繋ぐコードも
// 動かないので、ロボットは黙って繋がらなくなる(しろで実際に起きた)。
// 名前の一覧だけ持ち、クラスへの解決は使うときに行う。
const FACE_IDS = ['line', 'dog', 'image']
function faceClass(id) {
  return { line: SimpleFace, simple: SimpleFace, dog: DogFace, image: ImageFace }[String(id)]
}

// Gateway endpoints per profile. internal = ws:// on the LAN; external = wss:// via the
// Cloudflare Tunnel (ai-gw), protected by a CF-Access service token. The robot
// only ever talks to the gateway — the gateway reaches ollama/voicevox/mcp on
// the LAN either way — so external needs just this ONE hop over Cloudflare.

// Gateway endpoints from host/app/manifest_private.json (config, gitignored). A MOD
// reads the host app's config (not its own manifest). internal = LAN gateway (ws),
// external = internet-facing gateway (wss + CF-Access). Fallbacks keep a clone buildable.
const GW_INTERNAL = { host: config.gwInternalHost ?? '127.0.0.1', port: config.gwInternalPort ?? 8098 }
const GW_EXTERNAL = { host: config.gwExternalHost ?? '127.0.0.1', port: config.gwExternalPort ?? 443 }
const GW_PATH = '/'
const FIRST_DELAY_MS = 3000
const RECONNECT_MS = 5000
const REPLY_TIMEOUT_MS = 90000

// The udp resolver does not short-circuit dotted-quad IPs, so hand the socket
// the LAN address directly. (external uses a hostname + the real resolver.)
class LiteralResolver {
  resolve(options) {
    options.onResolved?.(options.host, options.host)
  }
  close() {}
}

const isIPv4Literal = (host) => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)

// The LAN gateway may be named rather than numbered (a reverse proxy in front of
// it), which lets the server move hosts without reflashing every robot. A name
// needs a real lookup, and it must go to the DHCP-supplied resolver: internal
// zones like .home.arpa exist only there, so a public DNS would never find them.
// Falls back to the literal path when no resolver is advertised.
function internalDns(host) {
  if (isIPv4Literal(host)) return { io: LiteralResolver }
  const server = Net.get('DNS')
  if (!server) {
    trace('[remote] no DHCP DNS — cannot resolve gateway by name\n')
    return { io: LiteralResolver }
  }
  return { io: Resolver, servers: [server], socket: { io: UDP } }
}

// 別ネットワークに切り替えたら再起動して繋ぎ直す(Preference に焼いた ssid で起動時接続
// からやり直すのが確実なため)。'system' は importNow で必要時のみ読む。
function restartDevice() {
  try {
    Modules.importNow('system')
    globalThis.System.restart()
  } catch (error) {
    trace(`[remote] restart unavailable (${error})\n`)
  }
}

function concatBuffers(chunks) {
  if (chunks.length === 1) return chunks[0]
  let total = 0
  for (const c of chunks) total += c.byteLength
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(new Uint8Array(c), off)
    off += c.byteLength
  }
  return out.buffer
}

// Drive the mouth from a WAV's per-window loudness while playAudio runs
// (Speaker.play emits no onPlayed callbacks).
function animateMouth(robot, wav) {
  const view = new DataView(wav)
  const sampleRate = view.getUint32(24, true)
  const dataLength = view.getUint32(40, true)
  const windowMs = 60
  const samplesPerWindow = Math.floor((sampleRate * windowMs) / 1000)
  const totalSamples = Math.floor(dataLength / 2)
  const stride = 8
  const levels = []
  for (let start = 0; start < totalSamples; start += samplesPerWindow) {
    const end = Math.min(start + samplesPerWindow, totalSamples)
    let sum = 0
    let count = 0
    for (let i = start; i < end; i += stride) {
      sum += Math.abs(view.getInt16(44 + i * 2, true))
      count += 1
    }
    levels.push(count > 0 ? Math.min(sum / count / 6000, 1) : 0)
  }
  let index = 0
  const timer = Timer.repeat(() => {
    if (index < levels.length) {
      robot.face.setMouthOpen(levels[index])
      index += 1
    }
  }, windowMs)
  return () => {
    Timer.clear(timer)
    robot.face.setMouthOpen(0)
  }
}

// Pick internal vs external from the connected Wi-Fi. A network flagged
// `internal: true` -> internal (ws, LAN gateway). Anything else — mobile or an
// unknown SSID -> external (wss, Cloudflare gateway + CF-Access). So any
// non-internal connection goes out through the external gateway.
// いま繋がっている SSID。**保存値より実態を優先する。**
// host の起動処理は、保存値が空のとき manifest の1本目で繋ぐが**保存しない**
// (保存するのはフォールバック経路だけ)。保存値だけを見ていると、実際には
// 宅内の AP に繋がっているのに「知らない SSID」= 外部と判定して、LAN にいるのに
// Cloudflare 経由で出ていく(くろで実際に起きた。毎回そうなる)。
function currentSsid() {
  try {
    const live = Net.get('SSID')
    if (live) return live
  } catch {}
  try {
    return Preference.get(DOMAIN.wifi, 'ssid') ?? ''
  } catch {}
  return ''
}

function computeProfile(cfg) {
  let net = null
  try {
    const ssid = currentSsid()
    net = ssid ? (cfg.networks ?? []).find((n) => n.ssid === ssid) : null
  } catch {}
  if (net?.internal === true) {
    return { name: 'internal', network: net.name, transport: 'ws', gw: GW_INTERNAL, accessHeaders: [] }
  }
  const access = cfg.access
  const accessHeaders = access?.clientId
    ? [
        ['CF-Access-Client-Id', access.clientId],
        ['CF-Access-Client-Secret', access.clientSecret ?? ''],
      ]
    : []
  return {
    name: 'external',
    network: net?.name ?? '(unknown)',
    transport: 'wss',
    gw: GW_EXTERNAL,
    accessHeaders,
    dns: net?.dns ?? ['1.1.1.1'],
  }
}

export function onContextCreated(robot, option) {
  // 会話は gateway(Wi-Fi 越しの WS)のみ。以前は Mode メニューで Codex(USB)
  // — PC の stack-chan-dock と USB CDC で話す経路 — に切り替えられたが、その運用を
  // やめたので経路ごと削除した。Preference('remote'/'mode')に古い値が残っていても
  // 読まないので無害。
  defaultBehavior.onContextCreated?.(robot, option)
  // 現在表示中の感情マーク(emoticon)。set_emotionのたびに付け替える。
  let emoticonEffect = null

  // 焼き込み config そのもの。host の option.config は domain 別(wifi/driver/ui/...)に
  // 整形済みで networks/gw*/record などの平坦キーが落ちるので、MOD からは mc/config を直接読む。
  const cfg = config
  const profile = computeProfile(cfg)
  const recordMs = cfg.record?.maxMs ?? 15000
  const silenceMs = cfg.record?.silenceMs ?? 2000
  const noSpeechMs = cfg.record?.noSpeechMs ?? 6000
  const vadThreshold = cfg.record?.vadThreshold ?? 300
  // Phase 2b: STT moved to the gateway. The robot streams its mic WAV over the
  // WebSocket; the gateway transcribes. No local whisper here anymore.
  // Log which Wi-Fi we actually connected to at boot (the persisted SSID that
  // boot-services used) — handy for spotting which Wi-Fi at a glance.
  trace(`[remote] wifi connected: ${currentSsid() || '(none)'}\n`)
  trace(
    `[remote] profile=${profile.name} transport=${profile.transport} gw=${profile.gw.host}:${profile.gw.port} access=${profile.accessHeaders.length > 0}\n`,
  )

  const LED = 'head'
  const setLed = {
    listening: () => robot.lighting.lightOn(LED, 0, 32, 0),
    thinking: () => robot.lighting.lightBlink(LED, 0, 0, 32, 300),
    speaking: () => robot.lighting.lightOn(LED, 32, 0, 16),
    error: () => robot.lighting.lightOn(LED, 32, 0, 0),
    off: () => robot.lighting.lightOff(LED),
  }

  // Amp click suppression: mute while the mic bus is open, restore before speech.
  // ampVolume は AW88298 のゲイン(256=減衰なし、1下げるごとに 0.5dB)。音量を上げると
  // 声が割れるのはアンプとスピーカーのアナログ段が飽和するからで、ソフト側の音量では
  // 直らない。割れない上限は機体ごとに違うので manifest_private.json で決める。
  const AMP_DEFAULT_VOLUME = cfg.ampVolume ?? 250
  // ミュートに 0 を渡してはいけない。**0 は最大ゲインになる。**
  // ドライバは `writeUint16(0x0c, ((256 - vdata) << 8) | 0x64)` を書くので、vdata=0 だと
  // 0x10064 になり、smbus の `buffer[1] = word >> 8` が 8bit に丸めて VOL バイトが 0x00
  // (= 減衰ゼロ)に化ける。1 なら 0xFF64 になり、-127.5dB でほぼ無音。
  // つまり録音中ずっとアンプが全開だった(2026-08-14 修正)。
  const AMP_MUTE_VOLUME = 1
  let ampMuted = false
  const muteAmp = () => {
    try {
      if (globalThis.amp && !ampMuted) {
        globalThis.amp.volume = AMP_MUTE_VOLUME
        ampMuted = true
      }
    } catch {}
  }
  const unmuteAmp = () => {
    try {
      if (globalThis.amp && ampMuted) {
        globalThis.amp.volume = AMP_DEFAULT_VOLUME
        ampMuted = false
      }
    } catch {}
  }

  // --- WebSocket connection to the gateway --------------------------------
  let ws = null
  let wsReady = false
  let rx = null // { binary, chunks: [] } — accumulates one WS message
  let expectAudio = null // set by an `audio` control frame; next binary is its WAV

  // Reply playback: audio chunks arrive asynchronously and play sequentially.
  const audioQueue = []
  let playing = false
  let replyEnded = true
  let replyResolve = null
  // True only while the mic rally loop (talk()) is active. finishReplyIfDone uses
  // it to decide whether it owns the idle LED after a reply (declared here so it's
  // initialized before any network handler can call finishReplyIfDone).
  let talking = false
  // 録音(I2S RX)と再生(I2S TX)は同時に使えない — 衝突するとネイティブクラッシュ
  // する(実測: "i2s controller 1 has been occupied" → InstrFetchProhibited でリブート)。
  // recording = record() が実際にマイクを掴んでいる間 true。
  // rallyInterrupted = gateway起点の再生(掛け合い等)がラリー中に届いたのでラリーを畳む指示。
  let recording = false
  let rallyInterrupted = false

  // 会話に依存しない土台(首サーボの個体差補正 + 無操作の自動電源off)を初期化。
  // 会話(gateway受信)・録音・操作のたびに markActivity() を呼んでタイマーをリセット。
  const { markActivity } = initBase(robot, cfg)
  // Flow control for mic-audio upstream (Phase 2b): resolved by onWritable when
  // the socket send buffer drains. lastHeard = the gateway's transcription.
  let writableWaiter = null
  let lastHeard

  const sendJson = (obj) => {
    if (ws && wsReady) {
      try {
        ws.write(new Uint8Array(ArrayBuffer.fromString(JSON.stringify(obj))), { binary: false })
      } catch (error) {
        trace(`[remote] send failed: ${error}\n`)
      }
    }
  }

  // Stream the recorded mic WAV to the gateway (Phase 2b). The Moddable WS write
  // throws when the socket send buffer can't hold the chunk, so send in small
  // fragmented frames and wait for onWritable (drain) between throws.
  const sendAudio = async (wav) => {
    const bytes = new Uint8Array(wav)
    const total = bytes.length
    sendJson({ type: 'utterance_audio', bytes: total })
    const CHUNK = 1024
    const deadline = Date.now() + 25000
    let off = 0
    while (off < total) {
      if (Date.now() > deadline) throw new Error('audio upstream timeout')
      const size = Math.min(CHUNK, total - off)
      const isLast = off + size >= total
      try {
        ws.write(bytes.subarray(off, off + size), { binary: true, more: !isLast })
        off += size
      } catch {
        // send buffer full — wait for drain (onWritable) or a short timeout, retry.
        await Promise.race([
          new Promise((resolve) => {
            writableWaiter = resolve
          }),
          new Promise((resolve) => Timer.set(resolve, 3000)),
        ])
      }
    }
  }

  const finishReplyIfDone = () => {
    if (!(replyEnded && !playing && audioQueue.length === 0)) return
    // A server-initiated reply (UI say/prompt, webhook) plays outside the talk()
    // rally loop, so nothing else restores the idle LED after speak_end — the
    // `speaking` red would stay lit. Turn it off here when no rally is active.
    // During a rally, talk() owns the LED (back to listening, then off in its
    // finally), so leave it alone.
    if (!talking) {
      setLed.off()
      robot.face.setMouthOpen(0)
    }
    if (replyResolve) {
      const r = replyResolve
      replyResolve = null
      r()
    }
  }

  const pumpAudio = async () => {
    if (playing) return
    playing = true
    // マイクが閉じるまで再生を始めない(I2S取り合い対策)。ラリー録音中に届いた
    // 再生は speak_begin 側で停止を要求済みなので、ここは短い待ちで抜ける。
    while (recording) await sleep(50)
    unmuteAmp()
    while (audioQueue.length > 0) {
      if (cancelRequested) {
        audioQueue.length = 0
        break
      }
      const wav = audioQueue.shift()
      const stopMouth = animateMouth(robot, wav)
      try {
        await robot.audio.playAudio(wav)
      } catch (error) {
        trace(`[remote] playAudio failed: ${error}\n`)
      } finally {
        stopMouth()
      }
    }
    playing = false
    finishReplyIfDone()
  }

  // Execute a body command pushed by the gateway (from an LLM tool call or a
  // webhook): emotion / head pose / LED.
  const executeBody = async (tool, args) => {
    try {
      if (tool === 'set_emotion') {
        const e = emotionFromName(String(args.emotion ?? ''))
        if (e !== undefined) {
          robot.face.setEmotion(e)
          // 表情に連動して顔の感情マーク(emoticon)を付け替える。
          if (emoticonEffect) {
            robot.ui.removeEffect(emoticonEffect)
            emoticonEffect = null
          }
          const emoKey = EMOTICON_BY_EMOTION[e]
          if (emoKey) {
            emoticonEffect = new Emoticon({ key: emoKey, name: 'emotion' })
            robot.ui.addEffect(emoticonEffect)
          }
        }
      } else if (tool === 'move_head') {
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0))
        const yaw = (-clamp(args.yaw, -90, 90) * Math.PI) / 180
        // pitch is mirrored like yaw: the driver's tilt convention is inverted vs
        // the tool convention (+pitch = 上), so negate to make 上 actually go up.
        // Range widened (down 45 / up 60) so a per-channel tiltOffset can level an
        // up-mounted unit. Driver caps tilt at 45 down / 60 up.
        const pitch = (-clamp(args.pitch, -45, 75) * Math.PI) / 180
        // Use the top-level robot.setPose/setTorque (the API the default petting
        // reaction uses — verified to move the head), with a FULL pose (position +
        // rotation) like poseForRotation. The robot.motion.* capability did not
        // actuate the servos here.
        await robot.setTorque(true)
        await robot.setPose({ position: { ...robot.pose.body.position }, rotation: { y: yaw, p: pitch, r: 0 } }, 0.6)
      } else if (tool === 'set_led') {
        const clamp = (v) => Math.max(0, Math.min(64, Math.round(Number(v) || 0)))
        const r = clamp(args.r)
        const g = clamp(args.g)
        const b = clamp(args.b)
        if (r === 0 && g === 0 && b === 0) robot.lighting.lightOff('head')
        else robot.lighting.lightOn('head', r, g, b)
      } else if (tool === 'set_face_color') {
        // 顔テーマの2色(前景primary/背景secondary)を変える。channelごとの配色。即時反映。
        const c = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0)))
        robot.face.setColor('primary', c(args.pr), c(args.pg), c(args.pb))
        robot.face.setColor('secondary', c(args.sr), c(args.sg), c(args.sb))
      } else if (tool === 'set_face') {
        // 顔の種類を差し替える(dog/simple/image)。ライブ差し替え。
        // 顔の識別子はサーバとの共通語で、**描けるかどうかは筐体ごとに違う**
        // (watch は haro-* を描けるが、こちらは描けない)。描けないときは
        // いまの顔のまま続ける —— 顔が出せないことと、その人格として喋れることは
        // 別なので、ここで止めない。ただし**黙って落ちない**: 理由が分からないと
        // 「人格を変えたのに顔が変わらない」が原因不明のバグに見える。
        const F = faceClass(args.face)
        if (F) robot.ui.setFace(new F({}))
        else trace(`[remote] face "${args.face}" はこの筐体では描けない。いまの顔のまま続ける\n`)
      }
      trace(`[remote] body ${tool} ${JSON.stringify(args)}\n`)
    } catch (error) {
      trace(`[remote] body ${tool} failed: ${error}\n`)
    }
  }

  const onText = (text) => {
    let m
    try {
      m = JSON.parse(text)
    } catch {
      return
    }
    if (m.type !== 'ping') markActivity() // 会話・操作は活動(pingは定期keepaliveなので除く)
    switch (m.type) {
      case 'ping':
        sendJson({ type: 'pong' })
        break
      case 'status':
        if (m.state === 'thinking') {
          robot.face.setEmotion(Emotion.DOUBTFUL)
          setLed.thinking()
        } else if (m.state === 'speaking') {
          setLed.speaking()
        }
        break
      case 'speak_begin':
        // A fresh reply is starting — clear any prior barge-in cancel so this
        // turn's audio plays.
        cancelRequested = false
        replyEnded = false
        // gateway起点の再生(掛け合い等)が「録音を掴んでいる最中」に届いたときだけ
        // ラリーを畳む(record が reject して静かに終わる)。注意: 自分の返事でも
        // speak_begin は毎回来る — そちらは record 完了後(converseAudio 待機中)で
        // recording=false なので、ここでラリーを殺してはいけない(緑に戻らなくなる)。
        if (talking && recording) {
          rallyInterrupted = true
          try {
            robot.audio.stopRecording()
          } catch {}
        }
        setLed.speaking()
        break
      case 'audio':
        expectAudio = m // the next binary message is this sentence's WAV
        break
      case 'heard':
        // Gateway's transcription of the mic audio (Phase 2b). Drives rally end.
        lastHeard = m.text ?? ''
        trace(`[remote] heard: ${lastHeard || '(empty)'}\n`)
        break
      case 'speak_text':
        trace(`[remote] reply: ${m.text}\n`)
        break
      case 'speak_end':
        replyEnded = true
        finishReplyIfDone()
        break
      case 'error':
        trace(`[remote] gateway error: ${m.message}\n`)
        replyEnded = true
        robot.audio.say?.('err-fail')
        finishReplyIfDone()
        break
      case 'body':
        executeBody(m.tool, m.args ?? {})
        break
      default:
        break
    }
  }

  const onBinary = (buf) => {
    if (expectAudio) {
      expectAudio = null
      // Dropped mid-cancel: the gateway may still send a frame or two before it
      // sees our cancel — don't queue or play them.
      if (cancelRequested) return
      audioQueue.push(buf)
      pumpAudio()
    }
  }

  // Transport config for the WebSocketClient, per profile. external = TLS socket +
  // real udp resolver (hostname) + CF-Access headers on the Upgrade. internal = plain
  // TCP + pass-through resolver (LAN IP).
  const transportConfig = () => {
    if (profile.transport === 'wss') {
      return {
        dns: { io: Resolver, servers: profile.dns ?? ['1.1.1.1'], socket: { io: UDP } },
        socket: {
          io: TLSSocket,
          TCP: { io: TCP },
          // step-0: skip cert verification to prove the path first (matches
          // network-device-config's https). Replace with a bundled CF root later.
          secure: { verify: false, applicationLayerProtocolNegotiation: 'http/1.1' },
        },
        headers: profile.accessHeaders,
      }
    }
    return { dns: internalDns(profile.gw.host), socket: { io: TCP }, headers: [] }
  }

  const connect = () => {
    const scheme = profile.transport === 'wss' ? 'wss' : 'ws'
    trace(`[remote] connecting ${scheme}://${profile.gw.host}:${profile.gw.port}${GW_PATH}\n`)
    wsReady = false
    let reconnected = false
    const reconnect = () => {
      if (reconnected) return
      reconnected = true
      wsReady = false
      ws = null
      Timer.set(connect, RECONNECT_MS)
    }
    const tc = transportConfig()
    ws = new WebSocketClient({
      dns: tc.dns,
      socket: tc.socket,
      host: profile.gw.host,
      port: profile.gw.port,
      path: GW_PATH,
      headers: tc.headers,
      onWritable(count) {
        if (!wsReady) {
          wsReady = true
          // Stable per-unit identity so the gateway/UI can tell the robots apart
          // (both run the same firmware). Send the hashed id only — not the MAC.
          const hwid = hardwareId()
          trace(`[remote] connected (writable=${count}) hwid=${hwid}\n`)
          sendJson({ type: 'hello', profile: profile.name, fw: 'remote', hardware_id: hwid, faces: FACE_IDS })
        }
        // Wake any audio-upstream send that is waiting for socket send buffer space.
        if (writableWaiter) {
          const w = writableWaiter
          writableWaiter = null
          w()
        }
      },
      onReadable(_count, options) {
        const piece = this.read()
        if (!rx) rx = { binary: options.binary, chunks: [] }
        rx.chunks.push(piece)
        if (options.more) return
        const buf = concatBuffers(rx.chunks)
        const wasBinary = rx.binary
        rx = null
        if (wasBinary) onBinary(buf)
        else onText(String.fromArrayBuffer(buf))
      },
      onControl() {},
      onClose() {
        trace('[remote] ws closed\n')
        reconnect()
      },
      onError() {
        trace('[remote] ws error\n')
        reconnect()
      },
    })
  }
  Timer.set(connect, FIRST_DELAY_MS)

  // --- conversation turn (rally) -----------------------------------------
  let cancelRequested = false
  const rallyEndMs = cfg.record?.rallyMs ?? 30000
  const sleep = (ms) => new Promise((resolve) => Timer.set(resolve, ms))

  // Stream the mic WAV to the gateway (it transcribes + replies) and resolve once
  // the whole reply has been spoken. The gateway sends a `heard` frame with the
  // transcription and always closes the turn with speak_end (even on empty STT).
  // Returns false on upstream/reply failure or timeout.
  const converseAudio = async (buffer) => {
    markActivity() // 録音(ユーザー発話)は活動
    replyEnded = false
    lastHeard = undefined
    const replyDone = new Promise((resolve) => {
      replyResolve = resolve
    })
    try {
      await sendAudio(buffer)
    } catch (error) {
      trace(`[remote] audio upstream failed: ${error}\n`)
      replyResolve = null
      return false
    }
    let timedOut = false
    await Promise.race([
      replyDone,
      new Promise((resolve) =>
        Timer.set(() => {
          timedOut = true
          resolve()
        }, REPLY_TIMEOUT_MS),
      ),
    ])
    if (timedOut) {
      trace('[remote] reply timeout\n')
      replyResolve = null
      return false
    }
    return true
  }

  async function talk() {
    if (talking) return
    if (!wsReady) {
      trace('[remote] gateway not connected\n')
      robot.audio.say?.('err-fail')
      return
    }
    talking = true
    cancelRequested = false
    rallyInterrupted = false
    let quietMs = 0
    try {
      // Rally: keep listening for follow-ups after each reply. Ends when the user
      // stays quiet for rallyEndMs, says nothing intelligible, or cancels (touch).
      while (true) {
        if (cancelRequested || rallyInterrupted) break
        // 録音の合間に gateway起点の再生が始まっていたら、録音を再開せずラリーを
        // 畳む(録音を開くと I2S 衝突でクラッシュする)。自分の返事は converseAudio
        // が再生完了まで待ち切ってから戻るので、ここで誤爆はしない。
        if (playing || audioQueue.length > 0) break
        robot.face.setEmotion(Emotion.HAPPY)
        setLed.listening()
        // record() opens the mic bus; mute the amp so it doesn't click while listening.
        muteAmp()
        let buffer
        for (let attempt = 0; ; attempt++) {
          try {
            recording = true
            buffer = await robot.audio.record(recordMs, { silenceMs, threshold: vadThreshold, noSpeechMs })
            break
          } catch (error) {
            // A user cancel (long-press) or an incoming gateway playback
            // (rallyInterrupted, e.g. 掛け合い) calls stopRecording(), which rejects
            // the pending record() — that's a deliberate end, not a failure, so
            // exit quietly without the error clip.
            if (cancelRequested || rallyInterrupted) {
              trace('[remote] record stopped (cancel/playback)\n')
              unmuteAmp()
              return
            }
            if (`${error.message}`.includes('already recording') && attempt < 4) {
              await sleep(400)
              continue
            }
            trace(`[remote] record failed: ${error.message}\n`)
            unmuteAmp()
            robot.audio.say?.('err-fail')
            return
          } finally {
            recording = false
          }
        }
        if (cancelRequested || rallyInterrupted) break
        if (buffer.speechDetected === false) {
          quietMs += noSpeechMs
          if (quietMs >= rallyEndMs) {
            trace(`[remote] quiet ${quietMs}ms, ending rally\n`)
            break
          }
          continue
        }
        setLed.thinking()
        robot.face.setEmotion(Emotion.DOUBTFUL)
        // Stream the mic WAV to the gateway; it does STT + reply (playback streams
        // back as audio chunks). lastHeard holds the transcription for rally logic.
        const ok = await converseAudio(buffer)
        if (!ok) {
          unmuteAmp()
          robot.audio.say?.('err-fail')
          return
        }
        const heard = (lastHeard ?? '').trim()
        if (heard.length === 0) {
          // Nothing intelligible (empty/hallucination handled gateway-side): count
          // toward the quiet timeout so the rally still ends on prolonged silence.
          quietMs += noSpeechMs
          if (quietMs >= rallyEndMs) {
            trace('[remote] empty for a while, ending rally\n')
            break
          }
          continue
        }
        quietMs = 0
        // loop: listen for the user's follow-up
      }
    } finally {
      talking = false
      unmuteAmp() // leave the amp audible when idle
      setLed.off()
      robot.face.setMouthOpen(0)
      robot.face.setEmotion(Emotion.NEUTRAL)
    }
  }

  const triggerTalk = () => {
    talk().catch((error) => trace(`[remote] talk failed: ${error}\n`))
  }

  // Network switch: persist the target SSID/password and reboot. On boot,
  // boot-services connects to the persisted SSID and network-device-config bakes
  // its DNS; computeProfile then re-selects the profile (internal ws / external wss).
  // Rebooting straight away (rather than a runtime scanAndConnect, which didn't
  // fire its callbacks reliably here) is the robust path — boot-services already
  // has a fallback to config.networks if the target AP isn't reachable.
  const switchNetwork = (target) => {
    if (!target?.ssid) {
      trace('[remote] switch: target has no ssid\n')
      return
    }
    try {
      Preference.set(DOMAIN.wifi, 'ssid', target.ssid)
      Preference.set(DOMAIN.wifi, 'password', target.password ?? '')
      trace(`[remote] persisted ssid=${target.ssid}; rebooting in 800ms\n`)
    } catch (error) {
      trace(`[remote] persist failed: ${error}\n`)
    }
    Timer.set(() => {
      trace('[remote] restarting now\n')
      restartDevice()
    }, 800)
  }

  // Drawer button to hop between the configured networks (internal LAN / mobile).
  // default が足したドロワー項目(顔/表情/LED/配色…)を全消しして、network切り替えだけ残す。
  robot.drawer?.clearDrawerButtons?.()
  // 電池残量はドロワーに自前で出さない。上流の AppBar(画面上部・左に電池、中央に時計。
  // 顔画面ではタップで4秒表示)が担当するようになったため。2026-08-01 に実機で確認済み。
  if (robot.drawer?.addDrawerButton && (cfg.networks ?? []).length > 1) {
    const networks = cfg.networks
    robot.drawer.addDrawerButton({
      key: 'networkPick',
      label: 'Network',
      kind: 'choice',
      value: profile.network,
      options: networks.map((n) => ({ value: n.name, label: n.name })),
      callback: (_ctx, value) => {
        const target = networks.find((n) => n.name === value)
        trace(`[remote] network switch ${profile.network} -> ${value} (ssid=${target?.ssid})\n`)
        switchNetwork(target)
      },
    })
  }

  // Trigger: deliberate hold on the head touch panel (chained after petting).
  if (robot.input.touchPanel) {
    const holdMs = cfg.touchHoldMs ?? 400
    const previousHandler = robot.input.touchPanel.onEvent
    let pressedAt = -1
    let sawSwipe = false
    robot.input.touchPanel.onEvent = (event) => {
      previousHandler?.(event)
      if (event.gesture === 'press') {
        pressedAt = event.ticks
        sawSwipe = false
      } else if (event.gesture === 'forwardSwipe' || event.gesture === 'backwardSwipe') {
        sawSwipe = true
      } else if (event.gesture === 'release' && pressedAt >= 0) {
        const heldMs = event.ticks - pressedAt
        pressedAt = -1
        const deliberate = heldMs >= holdMs && (!sawSwipe || heldMs >= 1200)
        if (deliberate) {
          if (talking || playing) {
            // Barge-in: cancel the current turn whether we're recording, waiting on
            // the gateway (thinking), or speaking. Silence playback locally, drop any
            // queued sentences, and tell the gateway to stop this turn (its LLM may
            // finish in the background but no more audio is sent).
            cancelRequested = true
            robot.audio.stopRecording()
            audioQueue.length = 0
            try {
              robot.audio.stopPlayback?.()
            } catch {}
            sendJson({ type: 'cancel' })
          } else {
            triggerTalk()
          }
        }
      }
    }
  }

  // Trigger: physical button A, on models that have one.
  const buttonA = robot.input.button?.a
  if (buttonA) {
    buttonA.onEvent = (event) => {
      if (event.pressed) triggerTalk()
    }
  }

  // 再起動。Network/Mode の切り替えに巻き込まれずに再起動だけしたい場面
  // (gateway に繋がらない・USB が死んだ等)の逃げ道。起動画面の再起動ボタン
  // (host/app/main.ts)と対になる、通常起動後の入口。
  robot.drawer?.addDrawerButton?.({
    key: 'restart',
    label: 'Restart',
    kind: 'action',
    icon: 'restart',
    callback: () => {
      trace('[remote] restart from drawer; rebooting in 300ms\n')
      Timer.set(restartDevice, 300)
    },
  })

  trace('[remote] ready\n')
}
