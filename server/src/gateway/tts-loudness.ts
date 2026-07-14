// TTS 音声のラウドネス整形。段は ハイパス → (任意で)コンプレッサ → ピーク正規化。
//
// **既定では圧縮しない。ピークを揃えるだけ。** 話者ごとにピークが -5〜-11dBFS とばらつく
// のを targetPeakDb に統一するのが主目的で、これで「この音量なら割れない」が話者に
// 依らず決まる。
//
// 当初は「ピークを抑えて平均を持ち上げれば割れずに大きくできる」と考えて圧縮を既定で
// 効かせたが、**機体によっては逆効果**で取り下げた(2026-08-14)。飽和する場所が違う:
//   stack-chan … AudioOut.Volume の 256 は等倍で素通し。飽和はアンプとスピーカーの
//                 アナログ段なので、ピークを下げれば効く。
//   ハロ(watch)… M5Unified がソフトで増幅してから(magnification × master_volume² ×
//                 ch_volume²)出力段で INT16 クリップする。ピークを抑えても後段で
//                 増幅されるので効かず、**上げた平均の分だけ割れる時間が増えるだけ**。
// 実際 RMS を +6.4dB 上げた結果ハロは悪化した。平均を上げる判断は機体ごとに要るので、
// 既定から外して ratio で選ばせる。
//
// 圧縮を使うなら attack は声の一周期(16kHz で 64〜160サンプル = 4〜10ms)より長くする。
// 1ms まで詰めると波形自体を追ってゲインが周期内で動き、それ自体が歪みになる
// (200Hz 純音で THD 0.90%。attack 15ms なら 0.13%)。release を長くしすぎると逆に
// 山が途切れずエンベロープが張り付き、一様減衰になって正規化で相殺される。
//
// ハイパスは超低域とDCを落とすだけの保険(VOICEVOX の出力に可聴帯域外の低域はほぼ無く、
// 実測の効果はゼロだった)。
//
// 16bit モノラル PCM の WAV のみ整形し、それ以外(ステレオ・非PCM・壊れたヘッダ)は
// 無加工で返す。ロボットに届く VOICEVOX の WAV は常に 16bit モノラル。

export type TtsLoudnessOptions = {
  enabled?: boolean
  /** ハイパスのカットオフ。声の基音より下だけを落とす。0 で無効。 */
  highPassHz?: number
  /** ここを超えた分を圧縮する。VOICEVOX の RMS(-22〜-27dBFS)より上に置く。 */
  thresholdDb?: number
  /** 圧縮比。2.5 なら閾値超過 10dB が 4dB になる。 */
  ratio?: number
  /** ソフトニーの幅。閾値の前後でカーブを滑らかにし、圧縮の入りを目立たせない。 */
  kneeDb?: number
  attackMs?: number
  releaseMs?: number
  /** 整形後のピーク。話者ごとの音量差もここで揃う。 */
  targetPeakDb?: number
}

type ResolvedOptions = Required<TtsLoudnessOptions>

// targetPeakDb は「一番大きい話者(-5.1dBFS)より下」に置く。ここを上げると出力の
// 小さい話者が元より大きくなり、クリップ余裕をこちらから削ることになる。-9dBFS なら
// 話者3で -3.9dB、話者47で +2.0dB となって両者が揃い、余裕は元より増える。
//
// ratio=1 は「圧縮しない」。上げるときは attackMs も一緒に見ること(冒頭の注記)。
export const TTS_LOUDNESS_DEFAULTS: ResolvedOptions = {
  enabled: true,
  highPassHz: 120,
  thresholdDb: -18,
  ratio: 1,
  kneeDb: 6,
  attackMs: 15,
  releaseMs: 120,
  targetPeakDb: -9,
}

const FULL_SCALE = 32768
const INT16_MAX = 32767
const INT16_MIN = -32768
const SILENCE = 1e-9

const positiveNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback

const finiteNumber = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

const resolveOptions = (options: TtsLoudnessOptions | undefined): ResolvedOptions => {
  const o = options ?? {}
  return {
    enabled: o.enabled !== false,
    // 0 は「ハイパス無効」の指定なので、正数チェックではなく非負で受ける。
    highPassHz: Math.max(0, finiteNumber(o.highPassHz, TTS_LOUDNESS_DEFAULTS.highPassHz)),
    thresholdDb: finiteNumber(o.thresholdDb, TTS_LOUDNESS_DEFAULTS.thresholdDb),
    // 1 未満(=伸張)は事故のもとなので下限 1。
    ratio: Math.max(1, positiveNumber(o.ratio, TTS_LOUDNESS_DEFAULTS.ratio)),
    kneeDb: Math.max(0, finiteNumber(o.kneeDb, TTS_LOUDNESS_DEFAULTS.kneeDb)),
    attackMs: positiveNumber(o.attackMs, TTS_LOUDNESS_DEFAULTS.attackMs),
    releaseMs: positiveNumber(o.releaseMs, TTS_LOUDNESS_DEFAULTS.releaseMs),
    // 0dBFS 超えを指定されても正規化で歪むだけなので上限 0。
    targetPeakDb: Math.min(0, finiteNumber(o.targetPeakDb, TTS_LOUDNESS_DEFAULTS.targetPeakDb)),
  }
}

type WavLayout = {
  channels: number
  sampleRate: number
  bitsPerSample: number
  dataOffset: number
  dataLength: number
}

// RIFF のチャンクを走査して fmt と data を拾う。VOICEVOX は fmt/data だけの素直な
// WAV を返すが、LIST など余分なチャンクが挟まっても壊れないように順に辿る。
const parseWav = (wav: Buffer): WavLayout | null => {
  if (wav.length < 12) return null
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null

  let format = 0
  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let dataOffset = -1
  let dataLength = 0

  let position = 12
  while (position + 8 <= wav.length) {
    const id = wav.toString('ascii', position, position + 4)
    const size = wav.readUInt32LE(position + 4)
    const body = position + 8
    if (id === 'fmt ' && size >= 16 && body + 16 <= wav.length) {
      format = wav.readUInt16LE(body)
      channels = wav.readUInt16LE(body + 2)
      sampleRate = wav.readUInt32LE(body + 4)
      bitsPerSample = wav.readUInt16LE(body + 14)
    } else if (id === 'data') {
      dataOffset = body
      // 宣言サイズが実バイト数を超えていても、実際にある分だけを見る。
      dataLength = Math.min(size, wav.length - body)
    }
    // チャンクは偶数バイト境界に整列する。
    position = body + size + (size & 1)
  }

  if (dataOffset < 0 || dataLength <= 0) return null
  if (format !== 1 || bitsPerSample !== 16 || channels !== 1) return null
  if (!(sampleRate > 0)) return null
  return { channels, sampleRate, bitsPerSample, dataOffset, dataLength: dataLength - (dataLength % 2) }
}

// RBJ cookbook の 2次ハイパス(Q=0.707、バターワース特性)。direct form I。
const highPass = (samples: Float64Array, sampleRate: number, cutoffHz: number): void => {
  if (cutoffHz <= 0 || cutoffHz >= sampleRate / 2) return
  const w0 = (2 * Math.PI * cutoffHz) / sampleRate
  const cos0 = Math.cos(w0)
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
  const a0 = 1 + alpha
  const b0 = (1 + cos0) / 2 / a0
  const b1 = -(1 + cos0) / a0
  const b2 = b0
  const a1 = (-2 * cos0) / a0
  const a2 = (1 - alpha) / a0

  let x1 = 0
  let x2 = 0
  let y1 = 0
  let y2 = 0
  for (let i = 0; i < samples.length; i += 1) {
    const x0 = samples[i]
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
    x2 = x1
    x1 = x0
    y2 = y1
    y1 = y0
    samples[i] = y0
  }
}

// エンベロープ(dB)に対する減衰量(dB)。閾値の周りは kneeDb 幅の二次カーブで繋ぐ。
const reductionDb = (envelopeDb: number, o: ResolvedOptions): number => {
  const slope = 1 - 1 / o.ratio
  const over = envelopeDb - o.thresholdDb
  if (o.kneeDb > 0 && over > -o.kneeDb / 2 && over < o.kneeDb / 2) {
    const x = over + o.kneeDb / 2
    return (slope * x * x) / (2 * o.kneeDb)
  }
  return over > 0 ? slope * over : 0
}

// ピーク追従型のコンプレッサ。サンプルごとの静的カーブ(波形整形)は倍音を生んで
// それ自体が「割れ」になるので、attack/release を持つエンベロープでゲインを動かす。
const compress = (samples: Float64Array, sampleRate: number, o: ResolvedOptions): void => {
  const attackCoef = Math.exp(-1 / ((o.attackMs / 1000) * sampleRate))
  const releaseCoef = Math.exp(-1 / ((o.releaseMs / 1000) * sampleRate))
  let envelope = 0
  for (let i = 0; i < samples.length; i += 1) {
    const level = Math.abs(samples[i])
    const coef = level > envelope ? attackCoef : releaseCoef
    envelope = coef * envelope + (1 - coef) * level
    const envelopeDb = 20 * Math.log10(Math.max(envelope, SILENCE))
    samples[i] *= 10 ** (-reductionDb(envelopeDb, o) / 20)
  }
}

const peakOf = (samples: Float64Array): number => {
  let peak = 0
  for (let i = 0; i < samples.length; i += 1) {
    const level = Math.abs(samples[i])
    if (level > peak) peak = level
  }
  return peak
}

/**
 * VOICEVOX の WAV を、割れない範囲で聞こえの大きい形に整える。
 * 整形できない形式・無音はそのまま返す(呼び出し側は常に再生可能な WAV を受け取る)。
 */
export const shapeTtsWav = (wav: Buffer, options?: TtsLoudnessOptions): Buffer => {
  const o = resolveOptions(options)
  if (!o.enabled) return wav
  const layout = parseWav(wav)
  if (!layout) return wav

  const count = layout.dataLength / 2
  if (count === 0) return wav
  const samples = new Float64Array(count)
  for (let i = 0; i < count; i += 1) {
    samples[i] = wav.readInt16LE(layout.dataOffset + i * 2) / FULL_SCALE
  }

  // 無音(あるいはほぼ無音)を正規化すると暗騒音だけが持ち上がる。触らずに返す。
  if (peakOf(samples) < SILENCE) return wav

  highPass(samples, layout.sampleRate, o.highPassHz)
  // ratio=1 は減衰ゼロ。掛ける意味がないので回さない(既定はこちら)。
  if (o.ratio > 1) compress(samples, layout.sampleRate, o)

  const peak = peakOf(samples)
  if (peak < SILENCE) return wav
  const gain = 10 ** (o.targetPeakDb / 20) / peak

  const shaped = Buffer.from(wav)
  for (let i = 0; i < count; i += 1) {
    const value = Math.round(samples[i] * gain * FULL_SCALE)
    shaped.writeInt16LE(value > INT16_MAX ? INT16_MAX : value < INT16_MIN ? INT16_MIN : value, layout.dataOffset + i * 2)
  }
  return shaped
}
