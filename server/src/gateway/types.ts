import type { TtsLoudnessOptions } from '#gateway/tts-loudness.ts'

// Shared gateway types. Kept intentionally loose (many fields optional / any) —
// the config is user-edited JSON and dialogues come from external SDKs, so this
// documents shape without over-constraining. Types are erased at runtime (tsx).

// A dialogue backend (OllamaDialogue / ClaudeDialogue) — only `post` is used here.
export interface Dialogue {
  post(text: string): Promise<{ success: boolean; value: string; reason?: string }>
}

// One resolved profile (base profile + per-device override). Extra keys allowed.
export interface Profile {
  name?: string
  model?: string
  instructions?: string
  ollama?: string
  voicevox?: string
  whisper?: string
  mcp?: string
  speaker?: number
  ttsRate?: number
  /** 合成音のラウドネス整形(ピークを抑えて平均を上げる)。既定は tts-loudness.ts。 */
  ttsLoudness?: TtsLoudnessOptions
  tools?: string[]
  // 'ollama'(既定) | 'claude' | 'codex'(テキスト往復) | 'codex-realtime'。codex-realtime は STT/LLM/TTS を
  // まとめて OpenAI Realtime に置き換えるので whisper/voicevox/dialogue を経由しない。
  backend?: string
  claudeModel?: string
  /** 使う Claude Code 実行ファイル。未指定/存在しなければ SDK 同梱版へ落ちる。 */
  claudePath?: string
  /** 道具を使う間の繋ぎ言葉。キーは道具名(mcp__*__ は落とした形)、`*` が既定。 */
  fillers?: Record<string, string>
  /** 定型の一言。unheard = 聞き取れなかったとき。空文字なら黙って閉じる。 */
  notices?: { unheard?: string }
  // codex / codex-realtime 用。cwd = Codex が作業するディレクトリ(承認や参照の基点)、
  // sandbox = codex のサンドボックス(codex backend の既定は read-only)。
  // voice = OpenAI 側の声(spruce 等)、socket = app-server の unix socket。
  // 読み上げ用の言い換え(音声だけに効く)。{ "TODO": "トゥードゥー" }
  readings?: Record<string, string>
  // path = codex 実行ファイル(省略時は PATH の `codex`)。socket = 既に走っている
  // app-server に相乗りしたいときだけ書く。省略すると backend='codex' は自分で起こす。
  codex?: { cwd?: string; voice?: string; socket?: string; path?: string; prompt?: string; sandbox?: string }
  historyLimit?: number
  compactKeep?: number
  access?: { clientId?: string; clientSecret?: string }
  [key: string]: any
}

// A body tool the LLM can call (set_emotion / move_head / set_led).
export interface BodyTool {
  name: string
  description: string
  parameters?: any
  execute: (args: any) => string | Promise<string>
}

export interface BuildOpts {
  extraTools?: BodyTool[]
  /** 道具を使う直前の通知。preamble はモデルが直前に書いた文(あれば読み上げに使う)。 */
  onToolStart?: (name: string, args: any, preamble?: string) => void | Promise<void>
  /**
   * この接続のロボット(hardware_id)。あとで喋り返す道具(リマインダー)が
   * 「誰に返すか」を知るために要る。inputSchema に channel を持つ MCP ツールへ
   * 実行直前に注入される。
   */
  channel?: string
  /** この接続の人格(キャラクター名)。記憶を人格ごとに分けるために要る。 */
  character?: string
}

// Per-connection state. Handlers (speak/prompt/body) and transient flags are
// attached after construction, hence the optional members.
export interface Session {
  id: number
  tag: string
  profileName: string
  hardwareId: string | null
  channelKey: string | null // "device:<hwid>" — selects the channel → character
  characterId: string | null // bound character id (for logging/timeline)
  label: string | null // human label for the channel (for logging/timeline)
  dialogue: any // OllamaDialogue | ClaudeDialogue (structural match not enforced)
  builtVersion: number
  busy: boolean
  // 実再生の見込み終了時刻(epoch ms)。busy解除=WS送出完了は再生完了より早いので、
  // skit が発話かぶりを避けるために送出時に WAV 実秒数を積算する。
  speakingUntil?: number
  fw?: string
  device?: string
  expectingAudio?: boolean
  speak?: (text: string) => Promise<void>
  speakWavs?: (pieces: { wav: Buffer; text: string }[]) => Promise<void> // 掛け合い(skit)の合成済み再生
  prompt?: (text: string) => void
  body?: (tool: string, args: any) => void
  [key: string]: any
}
