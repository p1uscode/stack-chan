// Gateway config state + resolution. This module OWNS the runtime config: the
// mutable `CONFIG` and `configVersion` live here and are only written via
// saveConfig(). Other modules read them through getters (never the raw CONFIG),
// so config mutation stays in one place (a clean boundary for later process
// separation). This module is terminal — it imports no other #gateway module.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

const HERE = dirname(fileURLToPath(import.meta.url))
// Layout: this file is src/gateway/. Editable config lives in server/config/ —
// two levels up.
export const CONFIG_DIR = join(HERE, '..', '..', 'config')
// 設定は **YAML**。中身の大半が人格の instructions —— 長い日本語の複数行文字列で、
// JSON だと 1行に \n が詰まって差分が読めない。YAML のブロックスカラー(|)なら
// 素のテキストとして1行ずつ差分が出る。TOML も複数行文字列は持てるが、
// characters を UUID で引く入れ子のマップとは相性が悪い([characters."<uuid>"] が並ぶ)。
export const CONFIG_PATH = join(CONFIG_DIR, 'gateway.config.yaml')
// 旧 JSON。まだ移していない環境のために読むだけ残す(書き戻しは常に YAML)。
const LEGACY_CONFIG_PATH = join(CONFIG_DIR, 'gateway.config.json')

// --- config ---------------------------------------------------------------
// gateway.config.yaml holds the editable, non-secret config. Secrets (CF-Access
// tokens) live in gateway.secret.yaml and are merged into the RUNTIME config
// only. The UI reads/writes the raw file (never sees secrets); saveConfig then
// reloads the runtime config to re-merge secrets.
//
// YAML は JSON の上位互換なので、parseYaml は .json もそのまま読める。
const readDoc = (path: string) => parseYaml(readFileSync(path, 'utf8'))
const loadRawConfig = () => {
  return readDoc(existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH)
}
const secretPath = () => {
  const y = join(CONFIG_DIR, 'gateway.secret.yaml')
  return existsSync(y) ? y : join(CONFIG_DIR, 'gateway.secret.json')
}
const loadConfig = () => {
  const cfg = loadRawConfig()
  try {
    const secret = readDoc(secretPath())
    // Secrets overlay the shared `common` base (e.g. endpoint tokens). CF-Access
    // for the robot lives robot-side, so this is usually empty/absent on the LAN.
    if (secret.common) cfg.common = { ...(cfg.common ?? {}), ...secret.common }
  } catch {
    // no secrets file — fine on the LAN
  }
  return cfg
}
let CONFIG = loadConfig()
// Bumped whenever the config changes, so connected sessions rebuild their
// dialogue (model/instructions/tools) with the new config on the next turn.
let configVersion = 0

// **ファイルを直接書き換えたぶんも拾う。**以前は saveConfig(= UI や端末からの変更)
// でしか CONFIG を入れ替えていなかったので、エディタやスクリプトで書き換えても
// 会話には効かず、サーバを再起動するまで古い人格のまま喋っていた。しかも
// getConfig() は毎回ファイルを読むので、**設定画面には新しい値が出ているのに
// ロボットは古い値で喋る**という、いちばん分かりにくい食い違いになっていた。
//
// 監視(fs.watch)ではなく更新時刻を見るのは、書き途中の中途半端なファイルを
// 掴まないため。読めなければ前の内容のまま次の呼び出しに持ち越す。
const activePath = () => (existsSync(CONFIG_PATH) ? CONFIG_PATH : LEGACY_CONFIG_PATH)
const mtimeOf = () => {
  try {
    return statSync(activePath()).mtimeMs
  } catch {
    return 0
  }
}
let loadedMtimeMs = mtimeOf()
const current = () => {
  const m = mtimeOf()
  if (m === loadedMtimeMs) return CONFIG
  try {
    CONFIG = loadConfig()
    loadedMtimeMs = m
    configVersion += 1
    console.log('[config] ファイルが更新された — 読み直した')
  } catch (e) {
    // YAML として壊れている(書いている最中など)。次に呼ばれたときに拾う。
    console.log(`[config] 読み直しに失敗、前の内容を使う: ${e}`)
  }
  return CONFIG
}

export const getConfig = () => loadRawConfig()
export const saveConfig = (next) => {
  // lineWidth:0 = 折り返さない。既定(80桁)だと日本語の1行が勝手に畳まれて、
  // 意味は変わらないのに差分が全面書き換えになる。
  // blockQuote:'literal' で複数行文字列を | のブロックにする(instructions がこれ)。
  writeFileSync(CONFIG_PATH, stringifyYaml(next, { lineWidth: 0, blockQuote: 'literal' }))
  CONFIG = loadConfig()
  // 自分で書いたぶんは current() に二度目の読み直しをさせない。
  loadedMtimeMs = mtimeOf()
  configVersion += 1
  return next
}

// Read accessors so other modules never touch the raw CONFIG directly.
export const getConfigVersion = () => {
  current()
  return configVersion
}
// The initial profile label a session shows before the robot's hello sets the real
// one ("internal"/"external"). `profiles` was removed; this is just a display label.
export const getDefaultProfile = () => current().defaultProfile ?? 'internal'

export const profileFor = (name) => {
  // The connection "profile" (internal/external) is now only a label — there are no
  // per-profile config deltas anymore (endpoints are one LAN; CF-Access is robot-
  // side). Every connection resolves to the shared `common` base. `name` is kept
  // for the call sites but no longer selects anything.
  void name
  return { ...(current().common ?? {}) }
}

// Stable per-unit id: SHA256 of the robot's eFuse-derived Wi-Fi MAC, first 16
// hex chars. The robot computes this on-device and sends it as hello.hardware_id
// so the raw MAC never crosses the (Cloudflare-exposed) wire. As a fallback for
// older firmware that still sends the raw MAC, we derive the same id here.
export const hwidOf = (seed) => {
  return seed ? createHash('sha256').update(String(seed)).digest('hex').slice(0, 16) : null
}

// The channel (宿り先) for a channel key (e.g. "stack-chan:<hwid>" or "slack:<id>"), or null.
export const channelFor = (channelKey) => {
  return channelKey ? (current().channels?.[channelKey] ?? null) : null
}

// Resolve the effective settings for a connection via a 3-way merge:
//   profile (connection base: endpoints / model / tools / neutral common prompt)
//   + character (the persona/魂 bound here: name / instructions / voice)
//   + channel (per-宿り先 overrides: e.g. a different `speaker` for one unit).
// Non-instruction fields: later layers win (shallow merge). Instructions are
// LAYERED, not overwritten: the profile holds only a neutral, name/character-free
// common prompt (tool usage, formatting); the character's prompt is its persona,
// concatenated on top; then the name is injected. So the persona comes from the
// character, and there is no hard-coded character in the base.
export const resolveProfile = (name, channelKey) => {
  const base = profileFor(name)
  const channel = channelFor(channelKey)
  const character = channel?.character ? (current().characters?.[channel.character] ?? null) : null
  if (!channel && !character) return base
  // channel carries {character, label, ...overrides}; character/label are metadata
  // (harmless if they land on the merged object — the pipeline ignores them).
  const merged = { ...base, ...(character ?? {}), ...(channel ?? {}) }
  const persona = merged.name
  // Instructions are LAYERED (all concatenated): profile common → character
  // persona → channel-specific addendum (e.g. reply length, which depends on the
  // channel: short for voice, longer for text) → name injection.
  const parts = []
  if (base.instructions) parts.push(base.instructions) // profile common (tools/format)
  if (character?.instructions) parts.push(character.instructions) // the character's persona
  if (channel?.instructions) parts.push(channel.instructions) // channel-specific addendum
  if (persona) parts.push(`あなたの名前は「${persona}」です。そう呼ばれたら自分のことだと分かります。`)
  merged.instructions = parts.join('\n')
  // Tools are the UNION (not overwrite): the character carries channel-independent
  // tools (web_search / local_docs …); the channel carries channel-scoped ones
  // (body tools: set_emotion / move_head / set_led — physical robot only).
  merged.tools = [...new Set([...(base.tools ?? []), ...(character?.tools ?? []), ...(channel?.tools ?? [])])]
  return merged
}

export const accessHeadersOf = (profile) => {
  return profile.access?.clientId
    ? {
        'CF-Access-Client-Id': profile.access.clientId,
        'CF-Access-Client-Secret': profile.access.clientSecret ?? '',
      }
    : {}
}
