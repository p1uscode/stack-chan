// 掛け合い(スキット): 複数チャンネルのキャラクター同士が対談する台本を LLM で
// 先に作り切り(generateSkit)、各チャンネルの声で TTS 合成して順番に流す
// (playSkit)。生成と再生を分けるのは、UI で台本を確認・手直ししてから再生する
// ため(同じ台本の再演も可)。ロボからの再生完了 ack はプロトコルに無いため、
// 合成済み WAV の実再生秒数(ヘッダから算出)+ セリフ間の間(gap)のタイマーで
// 話者交代のタイミングを取る。合成は再生中に次のセリフを先読み(パイプライン)。

import { discoverMcpTools, stripThinkBlocks } from '#gateway/agent.ts'
import { allClients } from '#gateway/clients.ts'
import { accessHeadersOf, getConfig, getDefaultProfile, resolveProfile } from '#gateway/config.ts'
import { splitSentences, synthesizePiece, ttsParams } from '#gateway/voicevox.ts'

// 日本語の読み上げはおおよそ 320字/分(VOICEVOX speedScale=1.0)。台本の
// 目標文字数(生成プロンプト)と推定時間(UI表示)の換算に使う。実時間は
// 再生時に WAV から正確に出る — これは生成前の目安。
const CHARS_PER_MIN = 320

const fetchWithTimeout = (url, options = {}, timeoutMs = 300000) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timeout ${url}`)), timeoutMs)
  return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(timer))
}

// WAV の実再生秒数をヘッダから求める。VOICEVOX は 44 バイト固定ヘッダだが、
// 念のため fmt/data チャンクを走査する(byteRate = rate × block で秒数に換算)。
export const wavDurationSec = (wav) => {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') return 0
  let byteRate = 0
  let off = 12
  while (off + 8 <= wav.length) {
    const id = wav.toString('ascii', off, off + 4)
    const size = wav.readUInt32LE(off + 4)
    if (id === 'fmt ') byteRate = wav.readUInt32LE(off + 16)
    else if (id === 'data') return byteRate > 0 ? size / byteRate : 0
    off += 8 + size + (size % 2) // チャンクは2バイト境界にパディング
  }
  return 0
}

// 参加チャンネルの配役(名前・口調)を config から引く。resolveProfile は共通
// 指示・チャンネル前提まで連結されるので、台本プロンプトには人格
// (character.instructions)だけを使う。
const castOf = (channelKeys) => {
  const cfg = getConfig()
  return channelKeys.map((key) => {
    const channel = cfg.channels?.[key]
    const character = channel?.character ? (cfg.characters?.[channel.character] ?? {}) : {}
    const name = channel?.name ?? character.name
    if (!name) throw new Error(`チャンネル ${key} にキャラクターが割り当てられていません`)
    return { channelKey: key, name, persona: character.instructions ?? '' }
  })
}

// LLM 出力から最初の完結した JSON オブジェクトを取り出す。文字列/エスケープを
// 意識して括弧の対応を数える — 前後の説明文・コードフェンス・JSONオブジェクトの
// 連結({..}{..} を出すモデルがある)に耐える。
const extractJson = (text) => {
  const start = text.indexOf('{')
  if (start < 0) throw new Error('LLMの出力にJSONがありません')
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, i + 1))
    }
  }
  return JSON.parse(text.slice(start)) // 途中で切れた出力 — 最後の手段(大抵 throw)
}

// JSON として壊れた出力から speaker/text の組を正規表現で救済する(セリフ中の
// 生の引用符などで JSON.parse が落ちても、拾える行だけ台本にする)。
const salvageLines = (text) => {
  const lines = []
  const re = /"speaker"\s*:\s*"([^"]*)"\s*,\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(text)) !== null) {
    lines.push({ speaker: m[1], text: m[2].replace(/\\(.)/g, '$1') })
  }
  return lines
}

// 主形式「名前: セリフ」(1行1セリフ)の解釈。小型ローカルモデルは JSON を
// 壊しがちなので、壊しようのない行形式を台本の主形式にする。
const parseScriptText = (content, names) => {
  const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const re = new RegExp(`^[\\s\\-・*]*(${escaped.join('|')})\\s*[::]\\s*(.+)$`)
  const lines = []
  for (const line of content.split('\n')) {
    const m = line.match(re)
    if (m) lines.push({ speaker: m[1], text: m[2].trim() })
  }
  return lines
}

// LLM が文字数指定を無視して長セリフを出しても、文境界で複数セリフに割る。
// 長い1発話はロボのメモリに厳しい(OOM再起動の実績) — 通常会話サイズに揃える。
const LINE_MAX_CHARS = 90
const splitLongLine = (line) => {
  if (line.text.length <= LINE_MAX_CHARS) return [line]
  const out = []
  let current = ''
  for (const s of line.text.split(/(?<=[。．！？])/)) {
    if (current && (current + s).length > LINE_MAX_CHARS) {
      out.push({ ...line, text: current.trim() })
      current = ''
    }
    current += s
  }
  if (current.trim()) out.push({ ...line, text: current.trim() })
  return out
}

// 行形式→JSON→正規表現救済の順で、どれかで台本を取り出す。
const parseScript = (content, names) => {
  const text = parseScriptText(content, names)
  if (text.length >= 2) return text
  try {
    const parsed = extractJson(content)
    const arr = (Array.isArray(parsed.lines) ? parsed.lines : [])
      .map((l) => ({ speaker: String(l?.speaker ?? ''), text: String(l?.text ?? '').trim() }))
      .filter((l) => l.text)
    if (arr.length > text.length) return arr
  } catch {
    const salvaged = salvageLines(content)
    if (salvaged.length > text.length) return salvaged
  }
  return text
}

// 台本生成: {channels: [channelKey...], topic, minutes, research} ->
// {lines: [{channelKey, name, text}], totalChars, estSeconds, researched}
export const generateSkit = async ({ channels, topic, minutes = 1, research = false }, log = (..._a) => {}) => {
  if (!Array.isArray(channels) || channels.length < 2) throw new Error('チャンネルを2つ以上指定してください')
  const theme = String(topic ?? '').trim()
  if (!theme) throw new Error('お題を指定してください')
  const cast = castOf(channels.map(String))
  const profile = resolveProfile(getDefaultProfile(), cast[0].channelKey)
  const headers = accessHeadersOf(profile)

  // research=true なら web_search(MCP)でお題の材料を先に集め、台本の根拠に
  // する(ニュース等、モデルの知識だけでは古い話題向け)。失敗しても生成は続行。
  let notes = ''
  if (research) {
    try {
      const tools = await discoverMcpTools(profile.mcp, headers)
      const search = tools.find((t) => t.name === 'web_search')
      if (search) notes = String(await search.execute({ query: theme })).slice(0, 3000)
    } catch (err) {
      log(`skit research failed: ${err.message}`)
    }
  }

  const targetChars = Math.max(100, Math.round((Number(minutes) || 1) * CHARS_PER_MIN))
  const names = cast.map((c) => c.name)
  const system =
    'あなたはラジオの掛け合いトークの構成作家です。指定のキャラクター2人が、その場で自然に話しているような会話だけを出力します。タイトル・説明文・コードフェンスは出力しません。'
  const user = [
    `お題: ${theme}`,
    '',
    '登場キャラクター(speaker にはこの名前だけを使う):',
    ...cast.map((c) => `- ${c.name}: ${c.persona || '(口調指定なし)'}`),
    '',
    '条件:',
    `- セリフの合計はおよそ${targetChars}文字(音声にすると約${minutes}分)。`,
    '- 1つのセリフは短い話し言葉で1〜2文、60文字以内。記号・絵文字・箇条書きは使わない(音声で読み上げるため)。',
    `- ${names.join('と')}が交互に話し、お題の内容を聞き手に分かりやすく紹介・解説する。`,
    '- 冒頭でお題を軽く紹介し、最後は軽くまとめて締める。',
    '- その場で話しているように書く。台本・原稿・準備など裏方を思わせる言葉はセリフに入れない。',
    ...(notes ? ['', '参考資料(この内容に基づいて話す):', notes] : []),
    '',
    '出力形式: 1行に1セリフ、「名前: セリフ」の形式。それ以外の行は出力しない。例:',
    `${names[0]}: こんにちは、今日は面白い話題があるんです。`,
    `${names[1 % names.length]}: え、なになに、聞かせて。`,
  ].join('\n')

  const body = {
    model: profile.model,
    stream: false,
    think: false,
    keep_alive: '24h',
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  }
  const chatOnce = async () => {
    const response = await fetchWithTimeout(`${profile.ollama}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`ollama ${response.status}`)
    const result: any = await response.json()
    return stripThinkBlocks(result?.message?.content ?? '')
  }

  // 行形式→JSON→救済のどれでも2セリフ以上取れなければ再生成(最大2回)。
  let raw = []
  for (let attempt = 1; attempt <= 2 && raw.length < 2; attempt++) {
    const content = await chatOnce()
    raw = parseScript(content, names)
    if (raw.length < 2) log(`skit parse got ${raw.length} lines (attempt ${attempt}) :: ${content.slice(0, 200)}`)
  }
  if (raw.length === 0) throw new Error('会話の生成に失敗しました(LLMの出力を会話として解釈できません)')

  const byName = new Map(cast.map((c) => [c.name, c]))
  const lines = raw
    .filter((l) => l.text)
    .map((l, i) => {
      // speaker 名が揺れたら(敬称等)名前を含むかで寄せ、それでも駄目なら交互割当。
      const c = byName.get(l.speaker) ?? cast.find((x) => l.speaker.includes(x.name)) ?? cast[i % cast.length]
      return { channelKey: c.channelKey, name: c.name, text: l.text }
    })
    .flatMap(splitLongLine)
  if (lines.length === 0) throw new Error('会話が空でした(LLMの出力を解釈できません)')
  const totalChars = lines.reduce((n, l) => n + l.text.length, 0)
  return { lines, totalChars, estSeconds: Math.round((totalChars / CHARS_PER_MIN) * 60), researched: notes.length > 0 }
}

// --- 相方の声の拾い込み(エコー)対策 -----------------------------------------
// スキット終了直後、ロボのマイクが相方の最終セリフの尻尾を拾って「ユーザー発話」と
// 誤認する(実測: 台本最終行の一部がSTTされ、同じ掛け合い依頼がもう一度走った)。
// 再生した台本行をしばらく覚えておき、聞き取りがどれかに酷似していたら捨てる。

const ECHO_WINDOW_MS = 60000
const recentLines = []
const normalizeEcho = (t) =>
  String(t)
    .toLowerCase()
    .replace(/[\s。、．，！!？?「」『』()（)・…〜ｰー－\-]/g, '')
const rememberSkitLine = (text) => {
  recentLines.push({ text: normalizeEcho(text), until: Date.now() + ECHO_WINDOW_MS })
  while (recentLines.length > 80) recentLines.shift()
}
const bigramsOf = (t) => {
  const set = new Set()
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}
// 聞き取りテキストが最近の台本行のエコーか。短文は完全包含のみ、10文字以上は
// bigram の 65% 以上が台本行に含まれるかで判定(STTの表記ゆれ 皆さん/みなさん に耐える)。
export const isSkitEcho = (heard) => {
  const now = Date.now()
  const h = normalizeEcho(heard)
  if (h.length < 4) return false
  const hb = h.length >= 10 ? bigramsOf(h) : null
  for (const line of recentLines) {
    if (line.until < now || line.text.length < 4) continue
    if (line.text.includes(h) || h.includes(line.text)) return true
    if (hb) {
      const lb = bigramsOf(line.text)
      let hit = 0
      for (const b of hb) if (lb.has(b)) hit++
      if (hit / hb.size >= 0.65) return true
    }
  }
  return false
}

// --- 再生 -------------------------------------------------------------------

// 実行中スキット(同時に1本だけ)。line は進行表示用(1-origin、再生中のセリフ)。
let current = null

// ロボ側のピース毎のデコード/バッファ余裕。実再生は見込みより僅かに長引くため、
// これが小さいと後半にかけてセリフの頭が前の音に食い込む。
const PIECE_MARGIN_MS = 150

export const skitStatus = () => {
  return current ? { playing: true, line: current.line, total: current.total } : { playing: false }
}

// 停止指示: 今のセリフを送り終えたところで打ち切る(ロボの再生中音声は止め
// られない — サーバ→ロボの cancel フレームが無いため)。
export const stopSkit = () => {
  if (!current) return false
  current.cancelled = true
  return true
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// スキット用の細切り分割: 句読点ごとに切る(splitSentences の3句読点まとめより細かい)。
// ニュース台本の長セリフはピースが大きくなり、ロボ側の WS 受信結合(一時的に2倍の
// メモリ)で OOM 再起動した実績があるため、通常会話の返事より細かく刻む。
// 短すぎる断片(不自然な間になる)は次に繰り越して6文字以上にまとめる。
const splitFine = (text) => {
  const MARKS = '。．、！？\n'
  const pieces = []
  let current = ''
  for (const ch of text) {
    current += ch
    if (MARKS.includes(ch) && current.trim().length >= 6) {
      pieces.push(current.trim())
      current = ''
    }
  }
  if (current.trim().length > 0) pieces.push(current.trim())
  return pieces
}

// 1セリフ分を合成: そのチャンネルの声で細切れ WAV 列と合計再生秒数を返す。
const synthLine = async (line) => {
  const profile = resolveProfile(getDefaultProfile(), line.channelKey)
  const { base, speaker, rate, loudness } = ttsParams(profile)
  const headers = accessHeadersOf(profile)
  const pieces = []
  let seconds = 0
  for (const text of splitFine(line.text)) {
    const wav = await synthesizePiece(base, speaker, text, headers, rate, profile.readings ?? {}, loudness)
    seconds += wavDurationSec(wav)
    pieces.push({ wav, text })
  }
  return { pieces, seconds }
}

// 中断・失敗で先読み分を待たずに抜けても unhandled rejection にしない prefetch。
// (.catch を付けるだけ — await 側には元のまま throw する)
const prefetch = (line) => {
  const p = synthLine(line)
  p.catch(() => {})
  return p
}

// --- 音声からの起動(LLMツール) ---------------------------------------------

// 「くろと〇〇について掛け合いして」のような依頼で LLM が呼ぶチャンネルツール。
// 出演 = 自分 + 接続中の他チャンネル全員。ツール実行中は自分のターンが busy の
// ため、その場では再生できない — 台本を生成し、全員の手が空いたら自動開始する。
export const startSkitFromTool = (session, { topic, minutes, research }, deps) => {
  const { store, log = (..._a) => {} } = deps ?? {}
  const self = session.channelKey
  if (!self) throw new Error('このチャンネルでは掛け合いを始められません')
  const partners = allClients().filter((c) => c.channelKey && c.channelKey !== self)
  if (partners.length === 0) throw new Error('相方のロボットが接続していません')
  const channels = [self, ...partners.map((c) => c.channelKey)]
  ;(async () => {
    try {
      // 依頼ターンの返事が済むまで台本生成を待つ。同じ Ollama に生成を先に投げると
      // 返事の推論が生成の後ろに並び、「待っててね」まで長時間黙ってしまう。
      for (let waited = 0; session.busy && waited < 30000; waited += 500) await sleep(500)
      const skit = await generateSkit({ channels, topic, minutes, research }, log)
      store?.logEvent('skit', { viaTool: { topic, minutes, research, lines: skit.lines.length, chars: skit.totalChars } })
      // 自分の返事をまだ喋っている間などは busy — 全員空くまで1秒おきに再試行(最大90秒)。
      for (let waited = 0; ; waited += 1000) {
        try {
          playSkit({ lines: skit.lines }, deps)
          log(`skit via tool: started (${skit.lines.length} lines, topic=${topic})`)
          return
        } catch (err) {
          if (waited >= 90000) throw err
          await sleep(1000)
        }
      }
    } catch (err) {
      log(`skit via tool failed: ${err.message}`)
      store?.logEvent('skit', { error: err.message, topic })
    }
  })()
  return { cast: channels.length }
}

// start_skit ツール定義(セッションごとに生成 — 自分のチャンネルが出演に入るため)。
export const makeSkitTool = (session, deps) => ({
  name: 'start_skit',
  description:
    '相方のロボットと2人でお題について掛け合い(対談・解説トーク)を始める。「くろと話して」「2人で解説して」のような依頼で使う。考えをまとめるのに1分ほどかかり、まとまったら自動で始まる',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', description: '掛け合いのお題(例: 今日のAIニュース、TypeScript入門)' },
      minutes: { type: 'number', description: 'おおよその長さ(分)。0.5〜5。省略時は1' },
      research: { type: 'boolean', description: 'Webで下調べしてから話す。ニュース・時事のお題はtrue' },
    },
    required: ['topic'],
  },
  execute: (args) => {
    const topic = String(args?.topic ?? '').trim()
    // ニュース系のお題は、モデルが research を付け忘れても下調べを有効化する。
    const research = args?.research === true || /ニュース|最新|今日|今週|時事/.test(topic)
    const r = startSkitFromTool(session, { topic, minutes: Number(args?.minutes) || 1, research }, deps)
    return `掛け合いの準備を始めた(出演${r.cast}人)。考えがまとまったら自動で話し始める。相手には「ちょっと考えるね」「相方と相談してみるね」のような短い一言だけを返すこと。台本・準備・生成など裏方を思わせる言葉は使わないこと`
  },
})

// 台本を順番に再生する(非同期に走り、開始の可否だけ返す)。gapMs = 話者交代の間。
export const playSkit = ({ lines, gapMs = 700 }, deps = {}) => {
  const { store, log = (..._a) => {} } = deps as any
  if (current) throw new Error('別の掛け合いを再生中です')
  const script = (Array.isArray(lines) ? lines : [])
    .map((l) => ({ channelKey: String(l?.channelKey ?? ''), text: String(l?.text ?? '').trim() }))
    .filter((l) => l.text)
  if (script.length === 0) throw new Error('会話が空です')

  // 全セリフの再生先(接続中セッション)を先に解決 — 1体でも欠けたら開始しない。
  const clients = allClients()
  const sessions = new Map()
  for (const l of script) {
    if (sessions.has(l.channelKey)) continue
    const c = clients.find((s) => s.channelKey === l.channelKey)
    if (!c) throw new Error(`未接続のチャンネルがあります: ${l.channelKey}`)
    if (c.busy) throw new Error(`話し中のチャンネルがあります: ${c.label ?? l.channelKey}`)
    sessions.set(l.channelKey, c)
  }
  const cast = [...sessions.values()]
  for (const c of cast) c.busy = true // 再生中は通常の発話ターンを受け付けない
  const state = { cancelled: false, line: 0, total: script.length, error: null as string | null }
  current = state

  const run = async () => {
    try {
      // パイプライン: セリフ i を再生している間に i+1 を合成しておく。
      let next = prefetch(script[0])
      for (let i = 0; i < script.length; i++) {
        const { pieces } = await next
        if (i + 1 < script.length) next = prefetch(script[i + 1])
        if (state.cancelled) break
        state.line = i + 1
        const session = sessions.get(script[i].channelKey)
        // この話者が直前の発話(依頼への返事など)をまだ再生中なら終わるまで待つ。
        // busy 解除(WS送出完了)は実再生完了より早いので、これが無いと台本の頭が
        // 返事の尻尾にかぶり、その話者だけ以後ずっとズレ続ける。
        const tail = (session.speakingUntil ?? 0) - Date.now()
        if (tail > 0) await sleep(tail + 200)
        await session.speakWavs?.(pieces) // WS への送出 flush まで(再生はロボ側で継続)
        rememberSkitLine(script[i].text) // 相方のマイクが拾った時に捨てるため
        store?.logTurn(session.id, session.profileName, null, script[i].text, 'skit', {
          device: session.hardwareId,
          character: session.characterId,
          label: session.label,
        })
        // speakingUntil(ピース毎の送出完了+実再生秒数の積算)まで待ってから次の話者へ。
        // ピース数ぶんの余裕を足す — ロボ側の受信/デコードで実再生は僅かに後ろへ延びる。
        const waitMs = (session.speakingUntil ?? Date.now()) + pieces.length * PIECE_MARGIN_MS + gapMs - Date.now()
        if (waitMs > 0) await sleep(waitMs)
      }
      // 最終セリフの再生終了後もひと呼吸 busy を維持 — 解除が早いと、直後にロボの
      // マイクが相方の声の残りを拾って通常ターンとして走ってしまう。
      const lastUntil = Math.max(0, ...cast.map((c) => c.speakingUntil ?? 0))
      const cooldown = lastUntil + 1500 - Date.now()
      if (!state.cancelled && cooldown > 0) await sleep(cooldown)
    } catch (err) {
      // 途中中断の典型はロボの切断(再起動・電源断)による送出エラー。理由を残す。
      state.error = err.message
      log(`skit error: ${err.message}`)
    } finally {
      for (const c of cast) c.busy = false
      store?.logEvent('skit', { lines: script.length, played: state.line, cancelled: state.cancelled, ...(state.error ? { error: state.error } : {}) })
      current = null
    }
  }
  run()
  return { ok: true, total: script.length }
}
