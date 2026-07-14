// 焼く前に「その相手で合っているか」を確かめる。
//
// stack-chan(CoreS3)と watch(ハロ)は**どちらも ESP32-S3 の USB-JTAG** で、VID:PID も
// ポート名の付き方も同じ。挿し口を変えると名前も動くので、名前を固定しても別の機体を
// 指すことがある。実際に watch のファームを stack-chan に書き込んで向こうの Moddable を
// 消したことがあり(2026-08-08)、逆向き —— stack-chan を焼くつもりで watch を掴む ——
// も 2026-08-14 に起きかけた。watch 側には対になる判定がある
// (stopwatch/tools/check_upload_port.py)。
//
// **「stack-chan であること」ではなく「watch でないこと」を見る。** まっさらな CoreS3 は
// 何も喋らないので、Moddable の痕跡を要求すると初回書き込みができなくなる。相手が
// 黙っているときは通す。害があるのは「相手が watch だと分かっているのに焼く」場合だけ。

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'

// watch のファームが起動時から出し続けている行(stopwatch/src/main.cpp)。
// Moddable 側はこれを出さない。
const WATCH_MARKERS = ['[power] style=', '[gw] ']

export function looksLikeWatch(serialOutput) {
  if (typeof serialOutput !== 'string' || serialOutput.length === 0) return false
  return WATCH_MARKERS.some((marker) => serialOutput.includes(marker))
}

export function listCandidatePorts(readDirectory = readdirSync) {
  let entries
  try {
    entries = readDirectory('/dev')
  } catch {
    return []
  }
  return entries
    .filter((name) => name.startsWith('cu.usbmodem'))
    .sort()
    .map((name) => `/dev/${name}`)
}

// シリアルを少しだけ読む。ボーレートを設定しないのは USB CDC では無視されるため。
// 相手が黙っていてもタイムアウトで抜ける(そのときは空文字列)。
//
// **`head -c N` を使ってはいけない。** watch は数秒に1行しか出さないので N バイト
// 溜まる前にタイムアウトし、head は出力をバッファに抱えたまま kill されて stdout が
// 空になる —— つまり watch を「watch ではない」と判定して素通しする。実際そうなった。
// cat は読んだそばから書くので、途中で打ち切られてもそこまでの分が残る。
function readSerial(port, timeoutMs) {
  const result = spawnSync('cat', [port], { timeout: timeoutMs, encoding: 'utf8' })
  return typeof result.stdout === 'string' ? result.stdout : ''
}

/**
 * 焼き先が watch なら止める。戻り値は実際に見たポート(判定できなければ undefined)。
 * @param {{uploadPort?: string, timeoutMs?: number, readPort?: (port: string, timeoutMs: number) => string, listPorts?: () => string[], log?: (message: string) => void}} options
 */
export function assertNotWatchTarget(options = {}) {
  const {
    uploadPort,
    timeoutMs = 3000,
    readPort = readSerial,
    listPorts = listCandidatePorts,
    log = () => {},
  } = options

  const candidates = listPorts()
  let port = uploadPort
  if (!port) {
    if (candidates.length === 0) {
      // 0件なら判定しようがない。mcconfig 側のエラーに任せる(ここで止めると
      // ポートを見ないビルド専用の使い方まで巻き添えになる)。
      log('[stack-chan] USB に候補が見つからない — 焼き先の確認は省略する')
      return undefined
    }
    if (candidates.length > 1) {
      log('[stack-chan] ★ USB の候補が複数ある。どれを焼くか分からないので止める:')
      for (const candidate of candidates) log(`[stack-chan]   ${candidate}`)
      log('[stack-chan] stack-chan だけを挿すか、UPLOAD_PORT で明示すること')
      throw new Error('複数のシリアルポートが見つかった')
    }
    port = candidates[0]
  }

  const output = readPort(port, timeoutMs)
  if (looksLikeWatch(output)) {
    log(`[stack-chan] ★ ${port} は watch(ハロ)が動いている。stack-chan ではない。`)
    log('[stack-chan] このまま焼くと向こうのファームを消す。中止する。')
    throw new Error('焼き先が watch だった')
  }
  log(`[stack-chan] 焼き先 ${port} — watch ではないことを確認した`)
  return port
}
