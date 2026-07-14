// Per-connection WebSocket session: the whole robot<->gateway turn loop. One
// createSession() runs per `wss.on('connection')`, owning the control-frame
// protocol (hello / utterance_text / utterance_audio / pong), STT, the LLM turn,
// sentence-by-sentence TTS streaming, body frames, and the webhook/UI control
// surface (session.speak/prompt/body registered in the clients registry).

import { addClient, deleteClient, nextClientId } from '#gateway/clients.ts'
import { accessHeadersOf, channelFor, getConfig, getConfigVersion, getDefaultProfile, hwidOf, resolveProfile } from '#gateway/config.ts'
import { CodexRealtime } from '#gateway/codex-realtime.ts'
import { buildDialogue } from '#gateway/dialogue.ts'
import { isSkitEcho, makeSkitTool, wavDurationSec } from '#gateway/skit.ts'
import { splitSentences, synthesizePiece, ttsParams } from '#gateway/voicevox.ts'
import { transcribe } from '#gateway/whisper.ts'
import { ACTION_STEPS, makeBodyTools, runSequence } from '#gateway/body-tools.ts'
import type { Session } from '#gateway/types.ts'

const now = () => new Date().toISOString().slice(11, 23)

// Behind Traefik (agent.home.arpa) or cloudflared, remoteAddress is the proxy's
// address, so every robot logs as the same IP and you can't tell them apart.
// Prefer X-Forwarded-For, but only when the immediate peer is on a private
// network — otherwise anyone could dictate what we log. This is a debug label,
// never an authorization input, so a spoofed value costs nothing but confusion.
// The proxy is kept in the string ("<robot> via <proxy>") so the hop stays visible.
const PRIVATE_PEER = /^(?:::1|::ffff:)?(?:127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)|^::1$/
const peerOf = (req) => {
  const direct = req.socket.remoteAddress ?? '?'
  const forwarded = String(req.headers['x-forwarded-for'] ?? '')
    .split(',')[0]
    .trim()
  if (!forwarded || !PRIVATE_PEER.test(direct)) return direct
  return `${forwarded} via ${direct}`
}

// deps = { store, log }: the persistence layer + the gateway logger. Everything
// else the session needs it imports directly (config/dialogue/clients registry).
export const createSession = (ws, req, deps) => {
  const { store, log } = deps
  const id = nextClientId()
  const peer = peerOf(req)
  // Replaced with the channel label once hello identifies the robot — see below.
  let tag = `#${id} ${peer}`
  log(`connect ${tag}`)

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj))
  }
  // Await the socket flush so we don't outrun a slow robot with big WAV frames.
  const sendBinary = (buf) =>
    new Promise<void>((resolve, reject) => {
      if (ws.readyState !== ws.OPEN) return resolve()
      ws.send(buf, { binary: true }, (err) => (err ? reject(err) : resolve()))
    })

  const sendBody = (tool: string, args) => {
    // `action` runs a named compound motion (nod/shake/dance) gateway-side as a
    // sequence of primitives, each re-entering this sendBody so per-channel
    // handling still applies.
    if (tool === 'action') {
      const steps = ACTION_STEPS[String(args?.type ?? '')]
      return steps ? runSequence(sendBody, steps) : undefined
    }
    return send({ type: 'body', tool, args })
  }
  const session: Session = { id, tag, profileName: getDefaultProfile(), hardwareId: null, channelKey: null, characterId: null, label: null, dialogue: null, builtVersion: -1, busy: false }
  // Which channel/character this connection is — attached to logged turns/events so the
  // timeline can show "どのソウルのどの宿り先か".
  const chanMeta = () => ({ device: session.hardwareId, character: session.characterId, label: session.label })
  // 人格の**名前**(「しろ」「ハロ」)。記憶ファイルの名前に使うので、UUID ではなく
  // 人が読める方を渡す。
  const characterName = () => {
    if (!session.characterId) return null
    return getConfig().characters?.[session.characterId]?.name ?? null
  }
  // Always resolve the profile FRESH from the current CONFIG, so edits (speaker,
  // ttsRate, endpoints, …) via the UI/API — including this unit's per-device
  // override (name/voice) keyed by hardwareId — take effect on the next turn
  // without a reconnect. The dialogue (model/instructions/tools) is rebuilt when
  // the config version bumps (see ensureDialogue).
  const prof = () => resolveProfile(session.profileName, session.channelKey)

  // Synthesize `text` sentence-by-sentence and stream each WAV to the robot as
  // audio{seq,bytes,text} + <binary WAV>. NO speak_begin/end here — the caller
  // brackets a whole turn (filler + reply) in one speak_begin/speak_end so the
  // robot treats it as a single utterance. Pipeline: synth i+1 while sending i.
  let audioSeq = 0
  // Set true by a `cancel` control frame (robot-side barge-in via head touch while
  // thinking/speaking). streamSentences stops sending and the in-flight turn drops
  // its reply. The robot silences playback locally, so the LLM may finish in the
  // background but nothing is heard.
  let cancelled = false
  // Each turn gets a generation number; a cancel bumps it so a superseded turn's
  // late finally block (speak_end/idle/busy reset) is skipped instead of clobbering
  // a newer turn the user may have already started.
  let turn = 0
  // ロボの受信バッファを溢れさせない送信スロットル。合成済みWAVを一気に流すと
  // 1セリフ分が丸ごとロボのRAMに積まれて落ちる(実測: ニュース台本の長セリフで
  // くろが再起動)。先行送信を約2.5秒分の音声までに抑える。
  const throttleAudio = async () => {
    const ahead = (session.speakingUntil ?? 0) - Date.now()
    if (ahead > 2500) await new Promise((resolve) => setTimeout(resolve, ahead - 2500))
  }
  const streamSentences = async (text) => {
    const { base, speaker, rate, loudness } = ttsParams(prof())
    const headers = accessHeadersOf(prof())
    const pieces = splitSentences(text)
    if (pieces.length === 0) return
    const readings = prof().readings ?? {}
    let nextWav = synthesizePiece(base, speaker, pieces[0], headers, rate, readings, loudness)
    for (let i = 0; i < pieces.length; i++) {
      if (cancelled) return
      const wav = await nextWav
      if (i + 1 < pieces.length) nextWav = synthesizePiece(base, speaker, pieces[i + 1], headers, rate, readings, loudness)
      if (cancelled) return
      await throttleAudio()
      if (cancelled) return
      send({ type: 'audio', seq: audioSeq++, bytes: wav.length, text: pieces[i] })
      await sendBinary(wav)
      // ロボは受信しながら順に再生する — 実再生の見込み終了時刻を積算(skitが参照)。
      session.speakingUntil = Math.max(Date.now(), session.speakingUntil ?? 0) + wavDurationSec(wav) * 1000
    }
  }

  const pinger = setInterval(() => send({ type: 'ping', t: now() }), 20000)

  // Speak a short filler while a slow knowledge tool runs, so the robot talks
  // during tool execution instead of going silent. Body tools are instant → skip.
  // キャラクターの `fillers`(道具名→台詞、`*` が既定)が最優先。人格ごとに口調が
  // 違うので、ここを固定文にすると素のままの言い回しが混ざる。
  const TOOL_FILLERS = { web_search: 'ちょっと調べますね。', local_docs: '資料を見てみるね。' }
  // 道具名が分からないとき用。claude/codex は自前の道具(検索・ファイル読み等)も
  // 使うので、名前で引けないぶんはこれで繋ぐ。
  const GENERIC_FILLER = 'ちょっと調べるね。'
  // 同じ道具でもバックエンドで名前が変わる(ollama は `weather`、claude は
  // `mcp__tools__weather`)。設定を1つのキーで書けるよう前置きを落とす。
  const toolKey = (name) => String(name ?? '').replace(/^mcp__[^_]+__/, '')
  // 喋りすぎ防止。claude はひとつの返答で道具を何度も呼ぶので、名前ごとの固定文を
  // 毎回流すと同じ台詞が連続する。間隔を空け、同じ道具は繰り返さない。
  const FILLER_MIN_GAP_MS = 12_000
  let lastFillerAt = 0
  const filledTools = new Set()
  // preamble = モデルが道具を呼ぶ直前に書いた文(「調べますね」等)。あるならそれを
  // 喋るほうが自然なので、固定文より優先する。長い解説は読み上げに向かないので切る。
  const onToolStart = async (name, args, preamble) => {
    store?.logEvent('tool', { client: id, profile: prof().name, name, args, ...chanMeta() })
    const now = Date.now()
    if (now - lastFillerAt < FILLER_MIN_GAP_MS) return
    const key = toolKey(name)
    const configured = prof().fillers ?? {}
    // 設定 > モデルが書いた前置き > 組み込みの既定 > 汎用。設定は明示的な意思なので
    // 推測(前置き)より優先する。
    const spoken =
      configured[key] ?? (preamble && preamble.length <= 60 ? preamble : undefined) ?? configured['*'] ?? TOOL_FILLERS[key]
    const filler = spoken ?? (filledTools.has(key) ? null : GENERIC_FILLER)
    if (!filler) return
    filledTools.add(key)
    lastFillerAt = now
    log(`${tag} filler (${key}): ${filler}`)
    try {
      await streamSentences(filler)
    } catch (err) {
      log(`${tag} filler tts failed: ${err.message}`)
    }
  }

  // Realtime セッションは接続(=ロボ1台)ごとに1つ持ち、ターンをまたいで会話文脈を
  // 保つ。無操作が続けば codex-realtime 側のタイマーが自分で閉じる。
  let codexRealtime = null
  const ensureCodexRealtime = (profile) => {
    if (!codexRealtime) {
      // **realtime では道具が使えない。**codex の API 表面(thread/realtime/*)には
      // ツール呼び出しに当たるものが無く、dynamicTools は thread/start(テキストの
      // スレッド)側の仕組みで realtime セッションからは参照されない。実測でも
      // item/tool/call は一度も来なかった。
      // そのため「調べるね」と言ったきり黙る、古い知識を今日の話として喋る、が起きる。
      // 道具を渡すのはやめ、**できないことをできないと言わせる**ほうに倒す。
      // 調べ物をさせたいときは backend を ollama か codex(テキスト)にすること。
      const toolHint = [
        'あなたは今、検索や天気などの道具を持っていません。',
        '調べたふりをして「ちょっと待ってね」で終わらせないこと。待たせたまま黙るのが一番よくない。',
        '最新のニュース・天気・時刻など、確かめないと分からないことは、正直に「今は調べられない」と短く言うこと。',
        '知っている範囲で話すときは、いつの情報か分からない旨を添えること。',
      ].join('\n')
      codexRealtime = new CodexRealtime({
        socketPath: profile.codex?.socket,
        cwd: profile.codex?.cwd ?? process.cwd(),
        voice: profile.codex?.voice,
        prompt: [profile.codex?.prompt ?? profile.instructions, toolHint].filter(Boolean).join('\n\n'),
        log: (message) => log(`${tag} ${message}`),
      })
    }
    return codexRealtime
  }

  // 見た目を送る。face/faceColor は resolveProfile のマージ結果から取るので、
  // **キャラクターにもチャネルにも書ける**(後ろのチャネルが勝つ)。ハロのように
  // 見た目が個体そのものなら人格側に、機体固有の事情ならチャネル側に置く。
  // 接続時だけでなく**人格が差し替わったときにも呼ぶ** —— でないと、色を変えたのに
  // 顔が前の人格のまま、という食い違いが残る。
  const sendAppearance = () => {
    const p = prof()
    if (p.faceColor) sendBody('set_face_color', p.faceColor)
    if (p.face) sendBody('set_face', { face: p.face })
  }

  const ensureDialogue = async () => {
    // Rebuild when there's no dialogue yet OR the config changed since it was built
    // (so edited model/instructions/tools take effect without a reconnect).
    if (!session.dialogue || session.builtVersion !== getConfigVersion()) {
      // **宿している人格を引き直す。**hello のときに一度だけ拾っていたので、
      // 動いている間にチャネルの character を差し替えても(ハロの色替えがこれ)
      // 記憶の宛先とログだけ古い人格のまま残っていた。prof() は毎回引き直して
      // いるので、モデルや指示だけ新しくなって食い違う。
      const chan = channelFor(session.channelKey)
      if (chan?.character && chan.character !== session.characterId) {
        log(`${tag} character ${session.characterId ?? '(none)'} -> ${chan.character}`)
        session.characterId = chan.character
        session.label = chan.label ?? session.label
        // 見た目も付いてくる。差し替えの瞬間には device-api が直接送っているが、
        // 設定ファイルを直接書き換えた場合はここが唯一の機会になる。
        sendAppearance()
      }
      // channel は hardwareId を渡す。webhook の target がこれで引けるので、
      // あとで喋り返す道具(リマインダー)が「頼んできた本人」に戻せる。
      session.dialogue = await buildDialogue(
        prof(),
        {
          extraTools: [...makeBodyTools(sendBody), makeSkitTool(session, { store, log })],
          onToolStart,
          channel: session.hardwareId ?? undefined,
          character: characterName() ?? undefined,
        },
        log,
      )
      session.builtVersion = getConfigVersion()
    }
    return session.dialogue
  }

  const handleUtterance = async (text) => {
    if (session.busy) {
      log(`${tag} drop utterance (busy): ${text}`)
      return
    }
    const myTurn = ++turn
    session.busy = true
    cancelled = false
    audioSeq = 0
    send({ type: 'status', state: 'thinking' })
    send({ type: 'speak_begin', format: 'wav' })
    try {
      const dialogue = await ensureDialogue()
      const t0 = Date.now()
      const result = await dialogue.post(text) // onToolStart streams fillers during tools
      const ms = Date.now() - t0
      if (cancelled) {
        log(`${tag} cancelled — dropping reply (${ms}ms)`)
      } else if (result.success) {
        log(`${tag} reply (${ms}ms): ${result.value}`)
        send({ type: 'speak_text', text: result.value }) // subtitle / debug
        await streamSentences(result.value)
        store?.logTurn(session.id, prof().name, text, result.value, 'voice', chanMeta())
      } else {
        log(`${tag} agent error: ${result.reason}`)
        send({ type: 'error', message: 'エラーが発生しました' })
      }
    } catch (err) {
      log(`${tag} handler error: ${err.message}`)
      send({ type: 'error', message: 'エラーが発生しました' })
    } finally {
      // Skip if a cancel (or a newer turn) superseded this one — otherwise this
      // late finally would reset busy/idle on top of the turn that replaced it.
      if (myTurn === turn) {
        send({ type: 'speak_end' })
        session.busy = false
        send({ type: 'status', state: 'idle' })
      }
    }
  }

  // Phase 2b: the robot streams its mic WAV; transcribe here, then run the turn.
  // Always finish with a speak_begin/speak_end bracket (even on empty/failed STT)
  // so the robot's "wait for reply" resolves and it resumes listening.
  // backend=codex-realtime: 録音WAVをそのまま OpenAI Realtime に渡し、返ってきた音声を
  // 流し返す。whisper/voicevox/dialogue は通らない(STT/LLM/TTS が向こうで一体のため)。
  // ロボ側は普段どおり utterance_audio を送って音声を受け取るだけで、変更は要らない。
  const handleAudioRealtime = async (wav) => {
    const p = prof()
    const rt = ensureCodexRealtime(p)
    session.busy = true
    cancelled = false
    audioSeq = 0
    send({ type: 'status', state: 'thinking' })
    send({ type: 'speak_begin', format: 'wav' })
    let replyText = ''
    // realtime は STT もあちら側なので、こちらが何と聞き取られたかは transcript の
    // role=user で返ってくる。受け取らないと「何を言ったか」がどこにも残らない
    // (以前は heard に '(codex realtime)' という固定文字列を書いていた)。
    let heardText = ''
    try {
      let spoke = false
      await rt.converse(wav, {
        onHeard: (text) => {
          heardText = text
          log(`${tag} heard (realtime): ${text}`)
          // 通常経路と同じように端末へも返す。画面に出るし、ログの並びも揃う。
          send({ type: 'heard', text })
        },
        onText: (text) => {
          replyText = text
          send({ type: 'speak_text', text })
        },
        onAudio: async (chunk) => {
          if (cancelled) return
          if (!spoke) {
            spoke = true
            send({ type: 'status', state: 'speaking' })
          }
          await throttleAudio()
          if (cancelled) return
          send({ type: 'audio', seq: audioSeq++, bytes: chunk.length, text: '' })
          await sendBinary(chunk)
          session.speakingUntil = Math.max(Date.now(), session.speakingUntil ?? 0) + wavDurationSec(chunk) * 1000
        },
      })
      log(`${tag} codex realtime reply: ${replyText || '(音声のみ)'}`)
      // logTurn は**位置引数**(client, profile, userText, assistantText, source, meta)。
      // ここだけオブジェクトを1つ渡していて、userText/assistantText が undefined に
      // なり、realtime のターンが1件も記録されていなかった。
      store?.logTurn(session.id, p.name, heardText, replyText, 'voice', chanMeta())
    } catch (err) {
      log(`${tag} codex realtime failed: ${err.message}`)
      send({ type: 'error', message: `${err.message}` })
    } finally {
      send({ type: 'speak_end' })
      send({ type: 'status', state: 'idle' })
      session.busy = false
    }
  }

  // 届いた WAV の振幅を見る。**ロボットに USB を挿さなくても入力段の質が分かる**
  // ようにするため —— 飽和(天井に張り付く)は端末のシリアルでしか見えず、電池で
  // 動かしているときは確かめようがなかった。
  // 16bit LE モノラル前提。peak が 32700 付近で clip の比率が高ければ飽和、
  // peak が数百なら小さすぎ。目安は peak 3000〜15000。
  const wavLevel = (wav: Buffer) => {
    let peak = 0
    let clipped = 0
    let count = 0
    for (let i = 44; i + 1 < wav.length; i += 2 * 8) {   // 8サンプルおき(全部見るには長い)
      const v = Math.abs(wav.readInt16LE(i))
      if (v > peak) peak = v
      if (v > 32000) clipped++
      count++
    }
    return { peak, clip: count > 0 ? Math.round((clipped / count) * 1000) / 10 : 0 }
  }

  const handleAudio = async (wav) => {
    if (session.busy) {
      log(`${tag} drop audio (busy)`)
      return
    }
    if (prof().backend === 'codex-realtime') return handleAudioRealtime(wav)
    send({ type: 'status', state: 'thinking' })
    let text = ''
    try {
      text = await transcribe(prof().whisper, wav, accessHeadersOf(prof()))
    } catch (err) {
      log(`${tag} whisper failed: ${err.message}`)
    }
    // Whisper hallucinates these stock phrases from silence/noise — treat as empty.
    const HALLUCINATIONS = ['ご視聴ありがとう', 'チャンネル登録', 'ご清聴ありがとう']
    if (text && HALLUCINATIONS.some((p) => text.includes(p))) text = ''
    // 掛け合い(skit)の相方のセリフをマイクで拾った「エコー」は捨てる(空扱いで
    // ターンを閉じる)。放置すると台本の尻尾が新しい依頼として走ってしまう。
    if (text && isSkitEcho(text)) {
      log(`${tag} drop (skit echo): ${text}`)
      text = ''
    }
    const lvl = wavLevel(wav)
    log(`${tag} heard (${wav.length}B peak=${lvl.peak} clip=${lvl.clip}%): ${text || '(empty)'}`)
    send({ type: 'heard', text })
    if (text) {
      handleUtterance(text) // sends speak_begin … speak_end
    } else {
      // 聞き取れなかったとき。黙って終わると「壊れたのか聞こえていないのか」が
      // 分からないので一言返す。文面はキャラクターの `notices.unheard`(口調が
      // 人格ごとに違うため)。空文字にすれば従来どおり無言で閉じる。
      const notice = prof().notices?.unheard ?? 'うまく聞き取れませんでした。もう一度お願いします。'
      send({ type: 'speak_begin', format: 'wav' })
      if (notice) {
        send({ type: 'speak_text', text: notice })
        try {
          await streamSentences(notice)
        } catch (err) {
          log(`${tag} unheard notice tts failed: ${err.message}`)
        }
      }
      send({ type: 'speak_end' })
      send({ type: 'status', state: 'idle' })
    }
  }

  // Expose a control surface for webhooks / UI (task 4/5): make this robot speak
  // arbitrary text, run an LLM turn, or do a body action.
  session.speak = async (text) => {
    cancelled = false
    audioSeq = 0
    send({ type: 'status', state: 'speaking' })
    send({ type: 'speak_begin', format: 'wav' })
    try {
      await streamSentences(text)
    } finally {
      send({ type: 'speak_end' })
      send({ type: 'status', state: 'idle' })
    }
  }
  // 掛け合い(スキット)用: 合成済み WAV 列をそのまま流す。speak と同じ枠組みで
  // status/speak_begin/speak_end を括る。合成は skit 側が先に済ませる(WAV から
  // 実再生秒数を測って話者交代のタイミングを取るため)。
  session.speakWavs = async (pieces) => {
    cancelled = false
    audioSeq = 0
    send({ type: 'status', state: 'speaking' })
    send({ type: 'speak_begin', format: 'wav' })
    try {
      for (const piece of pieces) {
        if (cancelled) return
        await throttleAudio() // 合成済みバーストをロボの再生速度に合わせて絞る
        if (cancelled) return
        send({ type: 'audio', seq: audioSeq++, bytes: piece.wav.length, text: piece.text })
        await sendBinary(piece.wav)
        session.speakingUntil = Math.max(Date.now(), session.speakingUntil ?? 0) + wavDurationSec(piece.wav) * 1000
      }
    } finally {
      send({ type: 'speak_end' })
      send({ type: 'status', state: 'idle' })
    }
  }
  session.prompt = (text) => handleUtterance(text)
  session.body = (tool, args) => sendBody(tool, args)
  addClient(session)

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // Phase 2b: mic WAV upstream. The ws lib reassembles the (fragmented) WS
      // message, so `data` is the whole WAV.
      if (session.expectingAudio) {
        session.expectingAudio = false
        handleAudio(data)
      }
      return
    }
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    switch (msg.type) {
      case 'utterance_audio':
        session.expectingAudio = true // next binary message is the mic WAV
        break
      case 'hello':
        session.profileName = msg.profile
        session.fw = msg.fw
        // この筐体が描ける顔の識別子。**どう描くかは筐体の責務**なので、サーバは
        // 名前しか持たない。端末の人格一覧をこれで絞る(device-api)。
        session.faces = Array.isArray(msg.faces) ? msg.faces.map(String) : null
        // Per-unit identity. New firmware sends hardware_id (SHA256 of the MAC,
        // computed on-device); older firmware sends the raw MAC as `device` — we
        // derive the same id from it so both work. The channel key is
        // "<type>:<id>" — physical robots are the "stack-chan" type (future: slack).
        session.hardwareId = msg.hardware_id ?? hwidOf(msg.device)
        session.channelKey = session.hardwareId ? `stack-chan:${session.hardwareId}` : null
        const channel = channelFor(session.channelKey)
        session.characterId = channel?.character ?? null
        session.label = channel?.label ?? null
        session.dialogue = null // rebuilt lazily for the selected profile
        // From here on, log by label rather than address. Behind a reverse proxy
        // the peer is the proxy — and on Docker Desktop for Mac even the forwarded
        // address is the VM's gateway — so every robot would look alike otherwise.
        if (session.label) tag = `#${id} ${session.label}`
        // faces は**この筐体が描ける顔**。出ていなければ古いファームで、端末の
        // 人格一覧を絞れない(絞らずに全部出す)。切り分けに要るのでログに残す。
        log(`${tag} hello profile=${msg.profile} peer=${peer} channel=${session.channelKey} character=${session.characterId ?? '(none)'} faces=${session.faces?.join(',') ?? '(申告なし)'} -> ${prof().model}`)
        store?.logEvent('connect', { id, profile: msg.profile, fw: msg.fw, hardwareId: session.hardwareId, channelKey: session.channelKey, character: session.characterId, label: session.label, peer })
        send({ type: 'status', state: 'idle', hello: true })
        sendAppearance()
        break
      case 'utterance_text':
        handleUtterance(String(msg.text ?? ''))
        break
      case 'cancel':
        // Robot-side barge-in (head touch during thinking/speaking). Stop streaming
        // this turn's audio and free the session immediately so the user can speak
        // again; the LLM may finish in the background but its reply is dropped
        // (streamSentences bails on `cancelled`, handleUtterance skips the reply).
        // Bumping `turn` invalidates the in-flight turn's finally. The robot
        // silences playback locally.
        cancelled = true
        turn += 1
        session.busy = false
        session.speakingUntil = 0 // ロボ側は即座に無音になる — 見込み残時間を破棄
        send({ type: 'speak_end' })
        send({ type: 'status', state: 'idle' })
        log(`${tag} cancel`)
        break
      case 'utterance_end':
      case 'pong':
        break
      // Battery/power samples from the robot. Only useful off-USB — and off-USB
      // the serial console is gone — so the measurement has to leave the device
      // over the link it already has. Logged verbatim; no state is kept here.
      case 'telemetry':
        log(`${tag} telemetry ${JSON.stringify(msg.data ?? {})}`)
        break
      default:
        log(`${tag} unknown type: ${msg.type}`)
    }
  })

  ws.on('close', (code) => {
    clearInterval(pinger)
    deleteClient(id)
    // Realtime セッションは接続ごとに持っているので一緒に畳む。放置すると WebRTC と
    // app-server の thread が残って課金され続ける。
    if (codexRealtime) {
      const rt = codexRealtime
      codexRealtime = null
      void rt.close().catch((err) => log(`${tag} codex realtime close failed: ${err.message}`))
    }
    store?.logEvent('disconnect', { id, code, ...chanMeta() })
    log(`close ${tag} code=${code}`)
  })
  ws.on('error', (err) => log(`error ${tag} ${err.message}`))

  send({ type: 'status', state: 'idle', welcome: true })
}
