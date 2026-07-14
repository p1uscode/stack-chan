// StackChan ツール MCP サーバ(Phase 0: 集約アグリゲータ)
//
// 既存の search-server(:8093)/ docs-server(:8095)を標準 MCP(Streamable HTTP)で
// 束ねて公開する薄いアダプタ。ツールの schema と「結果テキストの整形」をここに集約し
// (SSOT)、ロボット MOD / Claude Desktop など複数クライアントが同じツールを共有できる。
//
//   POST /mcp   ← MCP(JSON-RPC / Streamable HTTP、ステートレス)
//   GET  /health
//
// tools:
//   web_search(query) -> 検索結果を "1. title: snippet" 形式のテキストで返す
//   local_docs(query) -> 手元文書の該当箇所を同形式で返す
//   weather(location?) -> 予報 API(Open-Meteo)から今日明日の天気を短文で返す
//   current_time() -> 今の日付・時刻・曜日を返す(LLM 自身は今がいつか知らない)
//   remember(text) -> 教えられた事実を DOCS_DIR に書き足す(= local_docs で引けるようになる)
//   remind / remind_list / remind_cancel -> 時間が来たら gateway の webhook 経由で喋らせる
//   todo_add / todo_list / todo_done -> data/todo.md に Markdown のまま読み書きする
//
// 認証: LAN は素で使う。外部公開は Cloudflare Access(既存サービストークン)を
// エッジで掛ける想定(このプロセス自体は認証を持たない)= ollama/whisper/voicevox と同じ流儀。
//
// 使い方: ./run.sh mcp (= npm run mcp)
// 環境変数: PORT(8097)/ SEARCH_URL / DOCS_URL / MAX_RESULTS(3)
//           WEATHER_LAT / WEATHER_LON / WEATHER_PLACE(天気の既定地点、省略時は東京)
//           TODO_FILE(TODO の保存先、省略時は server/data/todo.md)
//           NOTES_FILE(おぼえたことの保存先、省略時は ~/stackchan-docs/memo.md
//                      = docs サーバが読む場所。ずらすと local_docs で引けなくなる)
//           REMINDER_FILE(省略時は server/data/reminders.json)
//           GATEWAY_EVENT_URL(省略時は http://127.0.0.1:8099/event)
//           GATEWAY_WEBHOOK_TOKEN(gateway 側と同じ値。未設定なら認証なし)
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8097)
const SEARCH_URL = process.env.SEARCH_URL ?? 'http://127.0.0.1:8093/search'
const DOCS_URL = process.env.DOCS_URL ?? 'http://127.0.0.1:8095/docs'
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 3)
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 12000)

// Fetch {query, results:[{title, snippet}]} from an upstream search/docs server and
// format it as the numbered "N. title: snippet" text the LLM consumes. This is the
// single place that owns the result shape (moved out of the robot MOD's execute).
const fetchFormatted = async (baseUrl, query, emptyText) => {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('query required')
  // baseUrl に既にクエリが付いていることがある(local_docs の self=<人格>)。
  // 素直に "?" を足すと "?self=..?q=.." になって q が読めない。
  const sep = baseUrl.includes('?') ? '&' : '?'
  const url = `${baseUrl}${sep}q=${encodeURIComponent(q)}&format=json`
  const response = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`upstream ${response.status}`)
  const json: any = await response.json()
  const results = (json.results ?? []).slice(0, MAX_RESULTS)
  if (results.length === 0) return emptyText
  return results.map((r, i) => `${i + 1}. ${r.title}: ${r.snippet ?? r.content ?? ''}`).join('\n')
}

// --- 天気(Open-Meteo、APIキー不要) ---------------------------------------
// 既定の場所は環境変数で上書きする(WEATHER_LAT / WEATHER_LON / WEATHER_PLACE)。
const WEATHER_LAT = Number(process.env.WEATHER_LAT ?? 35.6895)
const WEATHER_LON = Number(process.env.WEATHER_LON ?? 139.6917)
const WEATHER_PLACE = process.env.WEATHER_PLACE ?? '東京'

// WMO weather code -> 日本語。音声で読み上げるので短い語にする。
const WMO_TEXT = {
  0: '快晴', 1: '晴れ', 2: '薄曇り', 3: '曇り',
  45: '霧', 48: '霧',
  51: '霧雨', 53: '霧雨', 55: '強い霧雨',
  56: '凍える霧雨', 57: '凍える霧雨',
  61: '弱い雨', 63: '雨', 65: '強い雨',
  66: '凍える雨', 67: '凍える雨',
  71: '弱い雪', 73: '雪', 75: '大雪', 77: '霧雪',
  80: 'にわか雨', 81: 'にわか雨', 82: '激しいにわか雨',
  85: 'にわか雪', 86: '強いにわか雪',
  95: '雷雨', 96: '雹まじりの雷雨', 99: '雹まじりの雷雨',
}
const wmoText = (code) => WMO_TEXT[code] ?? '不明'

// 地名 -> 緯度経度。日本語の地名は取りこぼす(「東京」はヒットせず、「横浜」は
// 青森県横浜町に化ける)ので、引けなかったら既定の場所にフォールバックする。
const geocode = async (name) => {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=ja&format=json`
  const r = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (!r.ok) return null
  const json: any = await r.json()
  const hit = json.results?.[0]
  return hit ? { lat: hit.latitude, lon: hit.longitude, place: hit.name } : null
}

const fetchWeather = async (location) => {
  const asked = String(location ?? '').trim()
  const spot = (asked ? await geocode(asked) : null) ?? { lat: WEATHER_LAT, lon: WEATHER_LON, place: WEATHER_PLACE }
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${spot.lat}&longitude=${spot.lon}` +
    '&current=temperature_2m,weather_code' +
    '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
    '&timezone=auto&forecast_days=2'
  const r = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  if (!r.ok) throw new Error(`open-meteo ${r.status}`)
  const w: any = await r.json()
  const d = w.daily
  const today = `今日は${wmoText(d.weather_code[0])}、最高${Math.round(d.temperature_2m_max[0])}度、最低${Math.round(d.temperature_2m_min[0])}度、降水確率${d.precipitation_probability_max[0]}パーセント`
  const tomorrow = `明日は${wmoText(d.weather_code[1])}、最高${Math.round(d.temperature_2m_max[1])}度、降水確率${d.precipitation_probability_max[1]}パーセント`
  return `${spot.place}の天気。今は${wmoText(w.current.weather_code)}で${Math.round(w.current.temperature_2m)}度。${today}。${tomorrow}。`
}


// --- 現在時刻 ----------------------------------------------------------------
// LLM は自分が今いつなのかを知らない(学習時点で止まっている)ので、聞かれても
// 答えられないか、もっともらしい嘘を言う。プロセスの時計をそのまま返す。
// タイムゾーンはサーバに従う(TZ 環境変数、既定は Asia/Tokyo)。
const TIME_ZONE = process.env.TZ ?? 'Asia/Tokyo'
const WEEKDAY = ['日', '月', '火', '水', '木', '金', '土']

// 読み上げるので数字は素直に。「2026年8月7日(金)の14時5分です。」の形。
const formatNow = (now: Date): string => {
  const parts = new Intl.DateTimeFormat('ja-JP', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', weekday: 'short', hour12: false,
  }).formatToParts(now)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  // weekday は「金」のように出るが、ロケール差で「金曜日」になることがあるので頭1文字に揃える。
  const wd = get('weekday').replace('曜日', '') || WEEKDAY[now.getDay()]
  return `${get('year')}年${get('month')}月${get('day')}日(${wd})の${get('hour')}時${get('minute')}分です。`
}

// --- おぼえたこと(local_docs と同じ場所に書く) ------------------------------
// docs サーバ(:8095)は DOCS_DIR の .md/.txt をリクエストのたびに読み直すので、
// ここに追記すればすぐ local_docs で引ける。「ハロって何者?」に web_search で
// 答えようとして他人(ガンダムのハロ)の記事を拾う、という事故がこれで減る。
const DOCS_DIR = process.env.DOCS_DIR ?? join(homedir(), 'stackchan-docs')
const SHARED_NOTES = process.env.NOTES_FILE ?? join(DOCS_DIR, 'memo.md')

// **人格ごとに書き分ける。**同じ家にいる以上「家の事実」は全員が知っているほうが
// 便利だが、人格が違うのに何もかも共有だと別人格である意味が薄れる。
// 共有は memo.md、その人格だけのものは memo-<名前>.md。読む側(local_docs)も
// 他人の memo-* は見ないようにしてある(docs サーバの self パラメータ)。
//
// 名前はそのままファイル名になるので、経路を作れる文字は落とす。
const noteFileFor = (character?: string): string => {
  const name = String(character ?? '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 24)
  return name ? join(DOCS_DIR, `memo-${name}.md`) : SHARED_NOTES
}

const remember = (text: string, scope?: string, character?: string): string => {
  const body = text.trim()
  if (!body) throw new Error('text required')
  const mine = scope === 'mine' && !!character
  const file = mine ? noteFileFor(character) : SHARED_NOTES
  mkdirSync(dirname(file), { recursive: true })
  let head = ''
  try {
    readFileSync(file, 'utf8')
  } catch {
    head = mine ? `# ${character} がおぼえたこと\n\n` : '# おぼえたこと(みんな)\n\n'
  }
  const stamp = new Date().toISOString().slice(0, 10)
  appendFileSync(file, `${head}- ${body}  <!-- ${stamp} -->\n`)
  return mine ? `「${body}」を覚えました(${character}だけの記憶)。` : `「${body}」を覚えました。`
}

// --- リマインダー ------------------------------------------------------------
// 時間が来たら gateway の webhook を叩いて、頼んできたロボットに喋らせる。
// 予定はファイルに持つ(プロセスが落ちても消えないように)。
const REMINDER_FILE = process.env.REMINDER_FILE ?? join(HERE, '..', '..', 'data', 'reminders.json')
const GATEWAY_EVENT_URL = process.env.GATEWAY_EVENT_URL ?? 'http://127.0.0.1:8099/event'
const GATEWAY_TOKEN = process.env.GATEWAY_WEBHOOK_TOKEN ?? ''
const REMINDER_TICK_MS = 15000
// 止まっている間に過ぎたぶんは、遅れてでも伝える。ただし何日も前のものを
// 起動時にまとめて喋られても困るので、これより古いものは捨てる。
const REMINDER_STALE_MS = 24 * 60 * 60 * 1000

type Reminder = { id: string; at: number; text: string; channel?: string }

const readReminders = (): Reminder[] => {
  try {
    const parsed = JSON.parse(readFileSync(REMINDER_FILE, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

const writeReminders = (items: Reminder[]) => {
  mkdirSync(dirname(REMINDER_FILE), { recursive: true })
  writeFileSync(REMINDER_FILE, `${JSON.stringify(items, null, 2)}\n`)
}

const timeText = (at: number): string =>
  new Intl.DateTimeFormat('ja-JP', { timeZone: TIME_ZONE, hour: 'numeric', minute: '2-digit', hour12: false }).format(
    new Date(at),
  )

// 「7時に」= 次に来るその時刻。もう過ぎていれば翌日にする。
const nextTimeAt = (hhmm: string): number => {
  const m = /^(\d{1,2})[:時]?(\d{1,2})?$/.exec(hhmm.trim())
  if (!m) throw new Error('at_time は "7:30" や "19:00" の形で指定する')
  const hour = Number(m[1])
  const minute = Number(m[2] ?? 0)
  if (hour > 23 || minute > 59) throw new Error('at_time の時刻が範囲外')
  // ローカル時刻で組み立てる(サーバの TZ = ロボットのいる場所)。
  const now = new Date()
  const at = new Date(now)
  at.setHours(hour, minute, 0, 0)
  if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1)
  return at.getTime()
}

const addReminder = (text: string, inMinutes?: number, atTime?: string, channel?: string): string => {
  const body = String(text ?? '').trim()
  if (!body) throw new Error('text required')
  if (inMinutes == null && !atTime) throw new Error('in_minutes か at_time のどちらかが要る')
  const at = atTime ? nextTimeAt(atTime) : Date.now() + Math.max(1, Number(inMinutes)) * 60_000
  const items = readReminders()
  // id は時刻ベース。乱数にしなくても、同時に2件入ることは実運用で起きない。
  items.push({ id: `r${at.toString(36)}${items.length}`, at, text: body, channel })
  items.sort((a, b) => a.at - b.at)
  writeReminders(items)
  return `${timeText(at)}に「${body}」と伝えます。`
}

const listReminders = (): string => {
  const items = readReminders().filter((r) => r.at > Date.now())
  if (items.length === 0) return '予定しているお知らせはありません。'
  return items.map((r, i) => `${i + 1}. ${timeText(r.at)} ${r.text}`).join('\n')
}

const cancelReminder = (query: string): string => {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('query required')
  const items = readReminders()
  const pending = items.filter((r) => r.at > Date.now())
  if (pending.length === 0) return '予定しているお知らせはありません。'
  const asNumber = Number(q)
  const hit =
    Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= pending.length
      ? pending[asNumber - 1]
      : pending.find((r) => r.text.includes(q))
  if (!hit) return `「${q}」に当てはまるお知らせが見つかりません。`
  writeReminders(items.filter((r) => r.id !== hit.id))
  return `「${hit.text}」のお知らせをやめました。`
}

// 時間が来たものを喋らせる。webhook の say は**そのまま読み上げられる**ので、
// LLM を通さない = 時間になって黙っている、が起きない。
const fireReminder = async (item: Reminder) => {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (GATEWAY_TOKEN) headers['x-gateway-token'] = GATEWAY_TOKEN
  const response = await fetch(GATEWAY_EVENT_URL, {
    method: 'POST',
    headers,
    // target 省略 = 繋がっている全機体。頼んだ本人が分かっていればそこだけに送る。
    body: JSON.stringify({ target: item.channel, say: item.text }),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`gateway ${response.status}`)
}

const tickReminders = async () => {
  const items = readReminders()
  const now = Date.now()
  const due = items.filter((r) => r.at <= now)
  if (due.length === 0) return
  // 先に消してから鳴らす。鳴らす側が失敗しても、同じものを延々と再送しない。
  writeReminders(items.filter((r) => r.at > now))
  for (const item of due) {
    if (now - item.at > REMINDER_STALE_MS) {
      console.log(`[mcp] リマインダー「${item.text}」は古すぎるので捨てる`)
      continue
    }
    try {
      await fireReminder(item)
      console.log(`[mcp] リマインダー送信: ${item.text}`)
    } catch (error) {
      console.error(`[mcp] リマインダー送信に失敗: ${error.message}`)
    }
  }
}

// --- TODO(Markdown 直書き) --------------------------------------------------
// 保存形式はそのまま人が読み書きできる Markdown。DB を持ち出すほどの構造ではないし、
// エディタで直せることのほうが価値が高い。行の形は "- [ ] 用件" / "- [x] 用件"。
const TODO_FILE = process.env.TODO_FILE ?? join(HERE, '..', '..', 'data', 'todo.md')

type TodoItem = { line: number; done: boolean; text: string }

const readTodoLines = (): string[] => {
  try {
    return readFileSync(TODO_FILE, 'utf8').split('\n')
  } catch {
    return []
  }
}

// "- [ ] 用件" の行だけを拾う。それ以外(見出しやメモ)は素通しで保持する。
const parseTodos = (lines: string[]): TodoItem[] => {
  const items: TodoItem[] = []
  lines.forEach((raw, line) => {
    const m = /^\s*-\s*\[([ xX])\]\s*(.*)$/.exec(raw)
    // 行末の日付コメントは保存用のメタなので、読み上げに混ざらないよう落とす。
    if (m) items.push({ line, done: m[1] !== ' ', text: m[2].replace(/<!--.*?-->/g, '').trim() })
  })
  return items
}

const formatTodos = (items: TodoItem[], emptyText: string): string => {
  if (items.length === 0) return emptyText
  return items.map((t, i) => `${i + 1}. ${t.done ? '(済) ' : ''}${t.text}`).join('\n')
}

const addTodo = (text: string): string => {
  const body = text.trim()
  if (!body) throw new Error('text required')
  mkdirSync(dirname(TODO_FILE), { recursive: true })
  const lines = readTodoLines()
  // 見出しが無ければ先に作る(人が開いたときに何のファイルか分かるように)。
  if (lines.length === 0 || !lines.some((l) => l.startsWith('#'))) {
    writeFileSync(TODO_FILE, '# TODO\n\n')
  }
  const stamp = new Date().toISOString().slice(0, 10)
  appendFileSync(TODO_FILE, `- [ ] ${body}  <!-- ${stamp} -->\n`)
  const open = parseTodos(readTodoLines()).filter((t) => !t.done)
  return `「${body}」を追加しました。残り${open.length}件です。`
}

// 番号(いま開いている一覧の順番)でも、文言の一部でも消せるようにする。音声だと
// 番号を言うほうが速いが、「牛乳のやつ」のような言い方もされるため。
const completeTodo = (query: string): string => {
  const q = String(query ?? '').trim()
  if (!q) throw new Error('query required')
  const lines = readTodoLines()
  const open = parseTodos(lines).filter((t) => !t.done)
  if (open.length === 0) return '未完了のTODOはありません。'

  const asNumber = Number(q)
  const hit = Number.isInteger(asNumber) && asNumber >= 1 && asNumber <= open.length
    ? open[asNumber - 1]
    : open.find((t) => t.text.includes(q)) ?? open.find((t) => q.includes(t.text))
  if (!hit) return `「${q}」に当てはまるTODOが見つかりません。`

  lines[hit.line] = lines[hit.line].replace(/\[ \]/, '[x]')
  writeFileSync(TODO_FILE, lines.join('\n'))
  const left = parseTodos(lines).filter((t) => !t.done).length
  return `「${hit.text}」を完了にしました。残り${left}件です。`
}

// A fresh McpServer per request (stateless Streamable HTTP): avoids JSON-RPC id
// collisions across concurrent clients, and needs no session store.
const buildServer = () => {
  const server = new McpServer({ name: 'stackchan-tools', version: '0.1.0' })

  server.registerTool(
    'web_search',
    {
      title: 'Web 検索',
      description: '知らないことや最新の情報を聞かれたとき、Web を検索して調べる',
      inputSchema: { query: z.string().describe('検索キーワード') },
    },
    async ({ query }) => {
      try {
        const text = await fetchFormatted(SEARCH_URL, query, '検索結果なし')
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `検索に失敗しました: ${error.message}` }], isError: true }
      }
    },
  )

  server.registerTool(
    'local_docs',
    {
      title: 'ローカル文書検索',
      description:
        '手元の資料フォルダに書かれていること(あなた自身のこと・予定・メモなど)を聞かれたとき、ローカル文書を調べる',
      inputSchema: {
        query: z.string().describe('調べたいキーワード'),
        character: z.string().optional().describe('gateway が入れる。指定しないこと'),
      },
    },
    async ({ query, character }) => {
      try {
        // 他の人格の memo-*.md は読まない(docs 側で弾く)。共有ぶんは全員が読める。
        const url = character ? `${DOCS_URL}?self=${encodeURIComponent(character)}` : DOCS_URL
        const text = await fetchFormatted(url, query, '資料に該当なし')
        return { content: [{ type: 'text', text }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `資料検索に失敗しました: ${error.message}` }], isError: true }
      }
    },
  )

  // 天気だけは web_search では答えられない。DuckDuckGo の HTML 検索が返すのは
  // 各サイトの説明文(「ピンポイントな天気予報を提供します」等)で、予報そのものは
  // 含まれないため、LLM が「調べた」と言いながら中身を答えられない状態になる。
  // → 予報 API を直接引く専用ツールを持たせる。Open-Meteo は APIキー不要。
  server.registerTool(
    'weather',
    {
      title: '天気予報',
      description:
        '天気・気温・降水確率を聞かれたときに使う。web_search では予報の中身は分からないので、天気の話は必ずこれを使う。' +
        '場所を言われなかったら location を省略してそのまま呼ぶこと。場所を聞き返してはいけない',
      inputSchema: {
        location: z
          .string()
          .optional()
          .describe(`地名。ユーザーが場所を言わなかったら省略する(既定は${WEATHER_PLACE})。指定するときは英語表記(例: Tokyo, Sapporo)のほうが正確に引ける`),
      },
    },
    async ({ location }) => {
      try {
        return { content: [{ type: 'text', text: await fetchWeather(location) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `天気の取得に失敗しました: ${error.message}` }], isError: true }
      }
    },
  )

  // 時刻も web_search では答えられない(検索結果に「今」は載っていない)し、
  // LLM 自身は学習時点で止まっているので、聞かれたら必ずこれを使わせる。
  server.registerTool(
    'current_time',
    {
      title: '現在時刻',
      description:
        '今の日付・時刻・曜日を聞かれたときに使う。「今何時?」「今日は何日?」「今日は何曜日?」など。' +
        'あなた自身は今がいつか分からないので、時刻の話は必ずこれを使うこと。推測で答えてはいけない',
      inputSchema: {},
    },
    async () => {
      try {
        return { content: [{ type: 'text', text: formatNow(new Date()) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `時刻の取得に失敗しました: ${error.message}` }], isError: true }
      }
    },
  )

  server.registerTool(
    'remember',
    {
      title: 'おぼえる',
      description:
        '「覚えておいて」「これは〜だよ」と教えられた**事実や知識**を書き留める。自分自身のこと・家族の名前・好み・決まりごとなど。' +
        'あとで local_docs で引けるようになる。やること(用件)は todo_add のほうを使う',
      inputSchema: {
        text: z.string().describe('覚える内容。あとで読んで分かるように、主語を省かずに書く'),
        scope: z
          .enum(['shared', 'mine'])
          .optional()
          .describe(
            '既定は shared(みんなで共有。家のことや人の名前など、他の子も知っておくべきこと)。' +
              '「あなただけ覚えて」「これは内緒」と言われたときだけ mine',
          ),
        character: z.string().optional().describe('gateway が入れる。指定しないこと'),
      },
    },
    async ({ text, scope, character }) => {
      try {
        return { content: [{ type: 'text', text: remember(text, scope, character) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `覚えられませんでした: ${error.message}` }], isError: true }
      }
    },
  )

  // channel は LLM に埋めさせない(自分がどのチャネルかを知らない)。gateway が
  // ツール実行の直前に上書きする —— inputSchema に channel を持つツールが対象。
  server.registerTool(
    'remind',
    {
      title: 'あとで知らせる',
      description:
        '「〜分後に教えて」「〜時に起こして」と頼まれたら、その時刻に喋る予約をする。' +
        'in_minutes(何分後)か at_time(何時何分)のどちらかを必ず指定する。' +
        'text には**時間になったとき読み上げる言葉をそのまま**入れる(例:「そろそろ薬の時間だよ」)',
      inputSchema: {
        text: z.string().describe('時間になったら読み上げる言葉'),
        in_minutes: z.number().optional().describe('何分後か。「10分後に」なら 10'),
        at_time: z.string().optional().describe('時刻。「7時に」なら "7:00"、「19時半」なら "19:30"'),
        channel: z.string().optional().describe('gateway が入れる。指定しないこと'),
      },
    },
    async ({ text, in_minutes, at_time, channel }) => {
      try {
        return { content: [{ type: 'text', text: addReminder(text, in_minutes, at_time, channel) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `予約できませんでした: ${error.message}` }], isError: true }
      }
    },
  )

  server.registerTool(
    'remind_list',
    {
      title: '予約しているお知らせ',
      description: '「何か知らせてくれる予定ある?」「アラームは?」と聞かれたら、これから喋る予定を読み上げる',
      inputSchema: {},
    },
    async () => ({ content: [{ type: 'text', text: listReminders() }] }),
  )

  server.registerTool(
    'remind_cancel',
    {
      title: 'お知らせをやめる',
      description: '「さっきの知らせはいらない」「アラーム消して」と言われたら、予約を取り消す',
      inputSchema: { query: z.string().describe('remind_list の番号、または内容の一部') },
    },
    async ({ query }) => {
      try {
        return { content: [{ type: 'text', text: cancelReminder(query) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `取り消せませんでした: ${error.message}` }], isError: true }
      }
    },
  )

  server.registerTool(
    'todo_add',
    {
      title: 'TODO を追加',
      description: '「〜しておいて」「〜を覚えておいて」「TODOに入れて」と頼まれたら、用件を保存する',
      inputSchema: { text: z.string().describe('保存する用件。話し言葉のままでよい') },
    },
    async ({ text }) => {
      try {
        return { content: [{ type: 'text', text: addTodo(text) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `TODOの追加に失敗しました: ${error.message}` }], isError: true }
      }
    },
  )

  server.registerTool(
    'todo_list',
    {
      title: 'TODO を読む',
      description: '「TODOは?」「やることある?」と聞かれたら、保存してある用件を読み上げる',
      inputSchema: { include_done: z.boolean().optional().describe('完了済みも含めるか。既定は未完了だけ') },
    },
    async ({ include_done }) => {
      const items = parseTodos(readTodoLines())
      const shown = include_done ? items : items.filter((t) => !t.done)
      return { content: [{ type: 'text', text: formatTodos(shown, 'TODOはありません') }] }
    },
  )

  server.registerTool(
    'todo_done',
    {
      title: 'TODO を完了にする',
      description: '「〜終わった」「〜done」と言われたら、その用件を完了にする',
      inputSchema: { query: z.string().describe('todo_list の番号、または用件の一部') },
    },
    async ({ query }) => {
      try {
        return { content: [{ type: 'text', text: completeTodo(query) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `TODOの更新に失敗しました: ${error.message}` }], isError: true }
      }
    },
  )

  return server
}

const httpServer = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0]

  if (req.method === 'GET' && path === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        tools: [
          'web_search', 'local_docs', 'weather', 'current_time', 'remember',
          'remind', 'remind_list', 'remind_cancel', 'todo_add', 'todo_list', 'todo_done',
        ],
        reminders: readReminders().filter((r) => r.at > Date.now()).length,
      }),
    )
    return
  }

  if (path === '/mcp') {
    // Stateless mode: only POST carries JSON-RPC; GET/DELETE (server-push, session
    // teardown) are unused, so reject them per the Streamable HTTP spec.
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method Not Allowed' }, id: null }))
      return
    }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }))
      return
    }
    const server = buildServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    res.on('close', () => {
      transport.close()
      server.close()
    })
    try {
      await server.connect(transport)
      await transport.handleRequest(req, res, body)
    } catch (error) {
      console.error('[mcp] request failed:', error)
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }))
      }
    }
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[mcp-server] listening on :${PORT} /mcp (search=${SEARCH_URL}, docs=${DOCS_URL})`)
  const pending = readReminders().filter((r) => r.at > Date.now()).length
  console.log(`[mcp-server] リマインダー ${pending}件 待機中 (${REMINDER_FILE})`)
})

// 時間の来たリマインダーを拾って gateway に投げる。MCP のリクエスト処理は
// ステートレスだが、プロセス自体は常駐しているのでここに置ける。
// unref はしない —— これが動いている限りプロセスを終わらせない、で正しい。
setInterval(() => {
  tickReminders().catch((error) => console.error('[mcp] リマインダーの処理に失敗:', error))
}, REMINDER_TICK_MS)
