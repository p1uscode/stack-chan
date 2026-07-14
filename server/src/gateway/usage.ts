// Claude / Codex の利用枠(5時間・週)の残りを取る。
//
// なぜ要るか: どちらも枠に当たると**黙って止まる**。ロボットが急に答えなくなった
// とき、原因が枠なのか他の障害なのかを切り分けたい。ロボットの画面から見えれば
// PC を開かずに分かる。
//
// 取り方はどちらも「そのCLIに聞く」で揃っている:
//   Codex  … app-server の JSON-RPC `account/rateLimits/read`
//   Claude … `claude -p "/usage" --output-format json`
//
// **どちらも red の中で完結する。**外から数字を送ってもらう必要は無い。
// /usage はヘッドレスでも動き、モデルを呼ばない(num_turns:0 / 課金0 / 約1.2秒)
// ので、画面を開くたびに叩いてよい。返るのは人向けのテキストなので行を読む。
//
// 出るのは **red のアカウントの枠** = ロボット自身が消費している枠。手元の Mac は
// 別アカウントなので、その数字はここには出ない(出すには Mac からの送信が要る)。

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type CodexAppServerHandle, startCodexAppServer } from '#gateway/codex-app-server.ts'

const exec = promisify(execFile)

export type UsageWindow = {
  /** 「5時間」「週」など。windowDurationMins から作る */
  label: string
  /** 使用率 0-100。取れなければ null */
  usedPercent: number | null
  /** 次にリセットされる時刻(epoch ms)。取れなければ null */
  resetsAt: number | null
  /** epoch に直せなかったときの生の文字列。**読めない形なら捨てずにそのまま出す** */
  resetsText?: string
  windowMins: number | null
}

export type UsageReport = {
  source: string
  ok: boolean
  /** 取れなかった理由。ok=false のときだけ */
  reason?: string
  plan?: string
  /** **位置ではなく窓の長さで並べる。**アカウントによって5時間枠が無かったり
   *  週枠だけだったりする(実測: codex plus は週枠のみで secondary は null)。
   *  primary/secondary という位置で「5時間/週」と決め打つと嘘になる。 */
  windows: UsageWindow[]
  /** 補足(Claude のようにトークン実測しか出せないとき) */
  note?: string
}

// 窓の長さを短い記号にする。**画面が狭いので日本語は使わない** ——「5時間」「週」は
// 全角で場所を食い、1行に収めたいリセット時刻が入らなくなる。
const windowLabel = (mins: number | null): string => {
  if (!mins) return '?'
  if (mins % 10080 === 0) return mins === 10080 ? 'W' : `${mins / 10080}W`
  if (mins % 1440 === 0) return `${mins / 1440}D`
  if (mins % 60 === 0) return `${mins / 60}H`
  return `${mins}M`
}

const asWindow = (w: any): UsageWindow | undefined => {
  if (!w || typeof w !== 'object') return undefined
  const pct = typeof w.usedPercent === 'number' ? w.usedPercent : null
  // resetsAt は秒か ms かが版で揺れる。10桁までなら秒とみなして ms へ直す。
  let resets: number | null = typeof w.resetsAt === 'number' ? w.resetsAt : null
  if (resets !== null && resets > 0 && resets < 1e11) resets *= 1000
  const mins = typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null
  return { label: windowLabel(mins), usedPercent: pct, resetsAt: resets, windowMins: mins }
}

// --- Codex -----------------------------------------------------------------

export const codexUsage = async (socketPath?: string, codexPath?: string): Promise<UsageReport> => {
  let handle: CodexAppServerHandle | null = null
  try {
    // socketPath 未指定なら app-server をその場で起こして聞く(常駐は要らない)。
    handle = await startCodexAppServer({ socketPath, codexPath })
    const res: any = await handle.server.rpc.request('account/rateLimits/read', {})
    const snap = res?.rateLimits ?? {}
    const windows = [asWindow(snap.primary), asWindow(snap.secondary)]
      .filter((w): w is UsageWindow => !!w)
      .sort((a, b) => (a.windowMins ?? 0) - (b.windowMins ?? 0))
    return { source: 'codex', ok: true, plan: snap.planType ? String(snap.planType) : undefined, windows }
  } catch (error: any) {
    return { source: 'codex', ok: false, windows: [], reason: error?.message ?? String(error) }
  } finally {
    try {
      await handle?.close()
    } catch {}
  }
}

// --- Claude ----------------------------------------------------------------

// PATH に無いことがある(launchd から起動すると素の PATH になる)ので実体も見る。
const claudeBin = (): string => {
  const fromEnv = process.env.CLAUDE_BIN
  if (fromEnv) return fromEnv
  const local = join(homedir(), '.local', 'bin', 'claude')
  return existsSync(local) ? local : 'claude'
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// "Aug 10 at 2:40am (Asia/Tokyo)" → epoch ms。年が書かれていないので、**過ぎている
// なら翌年**とみなす(週枠でも先の日付にしかならない)。
const parseResets = (text: string, now: number): number | null => {
  const m = /^([A-Za-z]{3})\s+(\d{1,2})\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text.trim())
  if (!m) return null
  const mon = MONTHS.indexOf(m[1].toLowerCase())
  if (mon < 0) return null
  let hour = Number(m[3]) % 12
  if (m[5].toLowerCase() === 'pm') hour += 12
  const d = new Date(now)
  let t = new Date(d.getFullYear(), mon, Number(m[2]), hour, Number(m[4] ?? 0)).getTime()
  if (t < now - 86400_000) t = new Date(d.getFullYear() + 1, mon, Number(m[2]), hour, Number(m[4] ?? 0)).getTime()
  return t
}

// 枠の呼び名 → 表示名と窓の長さ。**知らない名前が増えても落とさない**(Fable 枠は
// アカウントによって出たり出なかったりする)。
const CLAUDE_WINDOWS: Record<string, { label: string; mins: number }> = {
  session: { label: '5H', mins: 300 },
  'week (all models)': { label: 'W', mins: 10080 },
  'week (fable)': { label: 'W(F)', mins: 10080 },
}

// 知らない `week (xxx)` も W(x) に畳む。増えても1行に収まるように。
const shortWindow = (raw: string): { label: string; mins: number | null } => {
  const known = CLAUDE_WINDOWS[raw.toLowerCase()]
  if (known) return known
  const m = /^week\s*\((.+)\)$/i.exec(raw)
  if (m) return { label: `W(${m[1].trim()[0].toUpperCase()})`, mins: 10080 }
  return { label: raw, mins: null }
}

// `--output-format json` の形が版で違う。2.1.226 は結果オブジェクト1個、2.1.225 は
// メッセージの配列で最後が結果。**どちらでも読めるようにする**(片方に決め打つと、
// 手元と red で版がずれた瞬間に黙って取れなくなる)。JSON でなければ素のテキスト。
const resultText = (stdout: string): string => {
  let parsed: any
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return stdout
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  for (let i = entries.length - 1; i >= 0; i--) {
    if (typeof entries[i]?.result === 'string') return entries[i].result
  }
  return ''
}

export const claudeUsage = async (now = Date.now()): Promise<UsageReport> => {
  let text: string
  try {
    // cwd を tmp にする —— プロジェクト直下だとその CLAUDE.md 等を読みに行く。
    const { stdout } = await exec(claudeBin(), ['-p', '/usage', '--output-format', 'json'], {
      cwd: tmpdir(),
      timeout: 20_000,
      maxBuffer: 4 << 20,
    })
    text = resultText(stdout)
  } catch (error: any) {
    return { source: 'claude', ok: false, windows: [], reason: error?.message ?? String(error) }
  }

  const windows: UsageWindow[] = []
  for (const line of text.split('\n')) {
    const m = /^Current\s+([^:]+):\s*(\d+)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$/.exec(line.trim())
    if (!m) continue
    const known = shortWindow(m[1].trim())
    const resets = m[3] ? parseResets(m[3], now) : null
    windows.push({
      label: known.label,
      usedPercent: Number(m[2]),
      resetsAt: resets,
      // 読めなかったときだけ生を残す。捨てると「リセット時刻が無い」に見えてしまう。
      resetsText: m[3] && resets === null ? m[3].replace(/\s*\([^)]*\)\s*$/, '') : undefined,
      windowMins: known.mins,
    })
  }
  if (windows.length === 0) {
    return { source: 'claude', ok: false, windows: [], reason: '/usage の出力を読めない' }
  }
  windows.sort((a, b) => (a.windowMins ?? 1e9) - (b.windowMins ?? 1e9))
  return { source: 'claude', ok: true, windows }
}

// 端末に出す行。**時刻の整形はサーバでやる** —— epoch から現地時刻へ直すには
// タイムゾーンが要り、ロボットは持っていない。
//
// **`|` は列の区切り。**端末はこれで割って列ごとに左揃えで描く。空白で詰めても
// フォントが等幅でないので揃わない。区切りの無い行は見出し(Claude / Codex)。
export const usageLines = (r: { codex: UsageReport; claude: UsageReport }): string[] => {
  const out: string[] = []
  // 月日も0埋めする。桁数が揃っていないと2行並べたとき縦がずれて読みにくい。
  const p2 = (n: number) => String(n).padStart(2, '0')
  const when = (ms: number | null) => {
    if (!ms) return ''
    const d = new Date(ms)
    return `${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
  }
  // 数字と単位を分けて渡す。**端末は数字だけ右詰めにする** —— 桁が違うと左詰めでは
  // 一の位が揃わず、並べたとき大小が読み取りにくい。0埋めは桁が嘘に見えるので使わない。
  const num = (w: UsageWindow) => String(w.usedPercent ?? '?')
  // Claude が先。ロボットの既定のバックエンドで、見たいのはこちらが多い。
  for (const [name, rep] of [
    ['Claude', r.claude],
    ['Codex', r.codex],
  ] as const) {
    out.push(name) // 見出しに1行使う。以降の行は列に揃うので名前を繰り返さない
    if (!rep.ok) {
      out.push('取得できない')
      continue
    }
    if (rep.windows.length === 0) out.push('枠は非公開')

    // 週の派生枠(W(F) など)は**週の行に畳む**。別行にすると、同じ長さの窓が
    // 並んで見えて紛らわしいうえ、行数だけ増える。
    const extras = rep.windows.filter((w) => /^W\(/.test(w.label))
    const base = rep.windows.filter((w) => !/^W\(/.test(w.label))
    let extrasUsed = false
    const row = (w: UsageWindow, suffix: string) => {
      const t = when(w.resetsAt) || w.resetsText
      out.push(`${w.label}|${num(w)}|%${suffix}|${t ? `- ${t}` : ''}`)
    }
    for (const w of base) {
      let suffix = ''
      if (w.label === 'W' && extras.length > 0) {
        extrasUsed = true
        suffix = `(${extras.map((e) => `${e.label.slice(2, -1)} ${num(e)}%`).join(' ')})`
      }
      row(w, suffix)
    }
    // 畳む先の週枠が無ければ単独で出す(消してしまわない)。
    if (!extrasUsed) for (const e of extras) row(e, '')
    if (rep.note) out.push(rep.note)
  }
  return out
}

export const usageReport = async (socketPath?: string) => {
  const [codex, claude] = await Promise.all([codexUsage(socketPath), claudeUsage()])
  // **取得時刻を添える。**端末は時計を持っていないので、いつの値かを自分では言えない。
  // 取り直しに失敗したときは前の値を出し続けるので、この時刻が古さの手がかりになる。
  const now = new Date()
  const at = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return { codex, claude, at, lines: usageLines({ codex, claude }) }
}
