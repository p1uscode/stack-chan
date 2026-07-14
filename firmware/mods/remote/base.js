// base — 会話に依存しない土台の挙動。remote(会話MOD)から import して使う。
// 担当: (1)首サーボの可動範囲と個体差補正(pitchZeroCal) (2)無操作の自動電源off。
// MODは host+1つしか載らない(app-behavior-resolver は 'mod' のみ)ので、別MODでは
// なく同一MOD内のファイル分割にしている(manifest の modules に "base" を足し、
// 1つの remote.xsa に mod.js と base.js を束ねて import する方式)。

import { getAxp2101Power } from 'axp2101-power-capture'
import { Digest } from 'crypt'
import config from 'mc/config'
import Net from 'net'
import Timer from 'timer'

// hardwareId = SHA256(Wi-Fi MAC) の先頭16hex。個体識別(pitchZeroCal / hello の両方で使う)。
export function hardwareId() {
  let mac = ''
  try {
    mac = Net.get('MAC') ?? ''
  } catch {}
  if (!mac) return ''
  const d = new Digest('SHA256')
  d.write(ArrayBuffer.fromString(mac))
  const bytes = new Uint8Array(d.close())
  let hex = ''
  for (let i = 0; i < 8; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

// 個体差(サーボホーン取付位相)の補正: hardwareId → tilt zeroPosition(生値)。
// host/app/manifest_private.json の config.pitchZeroCal。生値の正面基準をずらすので
// 正面/頷き/見上げ全域が他機と揃う。default=620。3台目以降は json に追記。
const PITCH_ZERO_CAL = config.pitchZeroCal ?? {}

// 首の可動範囲(0.1度単位)。host の既定は min:0 で、下向き(負)が全部 0=正面に
// clamp されて頷けない。うちの筐体は下15度・上90度あたりで body に当たるので、
// 手前で止まる 下13度/上80度 にする。raw は 620+trunc(角度*0.32) で 578〜876、
// rawPositionLimit(0〜1000)とサーボEEPROM(20〜1003)の内側。
// host を上流のまま保つため、値は MOD 側(=ここ)に置いて起動時に driver へ渡す。
const PITCH_ANGLE_LIMIT = { min: -130, max: 800 }

// Soft power-off. Reversible with the side power button (long press).
//
// 以前は SDK パッチが Power に生やした powerOff() を呼んでいたが、上流の
// axp2101-power-capture(起動時に作られた AXP2101 インスタンスを prototype 経由で
// 捕まえて共有する)が入ったので、**同じ I2C を二重に開かずに**レジスタを直接叩ける。
// M5Unified の AXP2101_Class::powerOff() と同じ「0x10 の bit0 を立てる」だけ。
// (AXP2101 ドライバ自身の powerOff() は sleep+wakeup 手順を足すので使わない)
// これで patches/moddable-cores3-battery.patch への依存は無くなる。
// 外部給電されているか(AXP2101 STATUS1 = レジスタ 0x00 の bit5 = VBUS good)。
//
// 以前は SDK ドライバと同じ「0x01 の bit6 = 充電中」を見ていたが、**実機で誤りを確認**
// (2026-08-06、USB 接続・満充電で `0x00=00101000 0x01=00010100`)。bit6 は 0 のままで、
// 充電中でも無操作offが発火していた。同ドライバは電圧 LSB にも別チップ(AXP192)の値を
// 使っていた前科があり、レジスタ定義を信用しない。
//
// そもそも見るべきは「充電中か」ではなく「外部給電か」。満充電で USB を挿していれば
// 充電は止まるが、そのときも落としてはいけない(復帰に物理の電源ボタンが要る)。
// bit3 が電池の有無なのは上流の battery-level.ts(0x00 & 0x08)と一致しており、
// 同じレジスタの bit5 を VBUS good と読む根拠になっている。
//
// 読めないときは true = 落とさない側へ倒す。判定を誤るなら切らない方が害が小さい。
function onExternalPower() {
  try {
    const power = getAxp2101Power()
    if (!power) return true
    return Boolean(power.readByte(0x00) & 0b0010_0000)
  } catch {
    return true
  }
}

function softPowerOff() {
  try {
    const power = getAxp2101Power()
    if (!power) {
      trace('[base] AXP2101 unavailable; power off skipped\n')
      return
    }
    trace('[base] idle -> soft power off\n')
    power.writeByte(0x10, power.readByte(0x10) | 0x01)
  } catch (e) {
    trace(`[base] power off failed: ${e}\n`)
  }
}

// 起動時に一度呼ぶ。サーボ個体差補正を適用し、無操作電源offのタイマーを開始する。
// 会話MOD側は返り値の markActivity() を会話・録音・操作のたびに呼ぶ(活動リセット)。
// cfg = デバイス config(option.raw)。idleOffMinutes=無操作分(既定30、0で無効)。
export function initBase(robot, cfg) {
  // 電源offの経路が生きているかを起動時に一度だけ出す。無操作offは30分後に効く仕組みで
  // 壊れていても気づけないため(SDKパッチ廃止で経路を変えた 2026-08-01)。
  trace(`[base] axp2101 capture: ${getAxp2101Power() ? 'ok' : 'unavailable'}\n`)
  // PMU の生ステータスを起動時に一度出す。充電判定(0x01)はチップ世代で意味が違い、
  // 誤ると「充電中なのに無操作offが効く」になるが、30分後の事象なので後から追えない。
  try {
    const p = getAxp2101Power()
    if (p) {
      const s0 = p.readByte(0x00)
      const s1 = p.readByte(0x01)
      trace(
        `[base] pmu status 0x00=${s0.toString(2).padStart(8, '0')} 0x01=${s1.toString(2).padStart(8, '0')} external=${onExternalPower() ? 1 : 0}\n`,
      )
    }
  } catch (e) {
    trace(`[base] pmu status read failed: ${e}\n`)
  }
  // (1) 首の可動範囲 + サーボ個体差補正。setPitchConfig は m5stackchan driver のみ。
  const calZero = PITCH_ZERO_CAL[hardwareId()]
  if (robot.driver?.setPitchConfig) {
    robot.driver.setPitchConfig({
      angleLimit: PITCH_ANGLE_LIMIT,
      ...(calZero !== undefined ? { zeroPosition: calZero } : {}),
    })
    trace(`[base] pitch angleLimit -> ${PITCH_ANGLE_LIMIT.min}..${PITCH_ANGLE_LIMIT.max}`)
    trace(calZero !== undefined ? `, zeroPosition -> ${calZero}\n` : '\n')
  }

  // (2) 無操作の自動電源off
  let lastActivityAt = Date.now()
  const markActivity = () => {
    lastActivityAt = Date.now()
  }
  const idleOffMs = (Number(cfg?.idleOffMinutes) || 30) * 60000
  if (idleOffMs > 0) {
    Timer.repeat(() => {
      if (Date.now() - lastActivityAt < idleOffMs) return
      // 充電中(USB/ドック給電)は落とさない。据え置きで使っているのに勝手に切れると、
      // 復帰に物理の電源ボタンが要る(2026-08-01: くろが USB 接続のまま無操作30分で
      // 落ちて「反応しない」状態になった)。持ち歩き中はバッテリー保護のため従来どおり。
      if (onExternalPower()) {
        markActivity() // 給電が外れた時点から測り直す
        return
      }
      softPowerOff()
    }, 30000)
  }

  return { markActivity }
}
