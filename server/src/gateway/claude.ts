// Claude Agent SDK backend (task 6). A switchable alternative to the ollama
// loop: set a profile's `backend` to "claude" in gateway.config.yaml. Same
// interface as OllamaDialogue (post(text) -> {success, value}, clear()), so the
// gateway can swap backends transparently.
//
// The SDK runs Claude with its own agentic loop, authenticated via the local
// `claude` CLI. Knowledge tools (web_search/local_docs) are wired by pointing
// the SDK at the existing MCP server over HTTP; body tools (custom SDK tools)
// are a follow-up. Note: SDK turns are much slower than ollama (~10s+ vs ~1-2s)
// — it spawns a full agent — so this is opt-in per profile.

import { existsSync } from 'node:fs'
import { query } from '@anthropic-ai/claude-agent-sdk'

// どの Claude Code を動かすか。既定では SDK が自前で抱えている実行ファイル
// (manifest.json に版が固定されている)を一時ディレクトリへ展開して使う。SDK と
// セットで検証された組み合わせなので、普段はそれで良い。
//
// common.claudePath を書くと、そちらを起動する。インストール済みの CLI を指せば
// 実体が1つに揃い、`claude --version` で見える版とロボットの中身が一致する。
// 引き換えに、CLI が自動更新で先へ行って SDK と噛み合わなくなる危険を引き受ける。
//
// 指定が無い/ファイルが無い場合は既定へ落とす。パスの打ち間違いで会話ごと死ぬより、
// 黙って動くほうがましなので、警告だけ出して続行する(警告は一度きり)。
let executableWarned = false
const resolveExecutable = (configured) => {
  if (!configured) return undefined
  if (existsSync(configured)) return configured
  if (!executableWarned) {
    executableWarned = true
    console.warn(`[claude] claudePath が見つからない: ${configured} — SDK 同梱の実行ファイルを使う`)
  }
  return undefined
}

// Claude tends to add emoji even when told not to; the robot's TTS shouldn't
// read them aloud. Strip common emoji ranges from the spoken reply.
const stripEmoji = (text) => {
  return text
    .replace(
      /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu,
      '',
    )
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

export class ClaudeDialogue {
  #systemPrompt
  #model
  #mcpUrl
  #maxTurns
  #executable
  #onToolStart
  #sessionId = null

  constructor({ instructions, model, mcpUrl, maxTurns = 8, executable, onToolStart }) {
    this.#systemPrompt = instructions
    this.#model = model
    this.#mcpUrl = mcpUrl
    this.#maxTurns = maxTurns
    this.#executable = executable
    this.#onToolStart = onToolStart
  }

  clear() {
    this.#sessionId = null
  }

  // 「これから道具を使う」メッセージだけを拾って呼び出し側に知らせる。
  // 前置きの文(「調べますね」等)は tool_use と同じメッセージに入るので、
  // **道具呼び出しを伴うときだけ**喋らせる。道具を伴わない最後の返答は
  // post() の戻り値として喋られるため、ここで拾うと二重になる。
  async #reportProgress(message) {
    if (!this.#onToolStart) return
    const blocks = message?.message?.content
    if (!Array.isArray(blocks)) return
    const tools = blocks.filter((b) => b?.type === 'tool_use')
    if (tools.length === 0) return
    const preamble = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => stripEmoji(b.text))
      .join(' ')
      .trim()
    for (const tool of tools) {
      try {
        await this.#onToolStart(tool.name, tool.input ?? {}, preamble)
      } catch {
        // 途中経過の読み上げに失敗しても本編は続ける
      }
    }
  }

  async post(text) {
    const options: any = {
      systemPrompt: this.#systemPrompt,
      maxTurns: this.#maxTurns,
      permissionMode: 'bypassPermissions', // headless: run tools without prompts
      includePartialMessages: false,
    }
    if (this.#model) options.model = this.#model
    const executable = resolveExecutable(this.#executable)
    if (executable) options.pathToClaudeCodeExecutable = executable
    if (this.#mcpUrl) options.mcpServers = { tools: { type: 'http', url: this.#mcpUrl } }
    if (this.#sessionId) options.resume = this.#sessionId

    let result = null
    let isError = false
    let sid = this.#sessionId
    try {
      for await (const m of query({ prompt: text, options })) {
        if (m.type === 'system' && m.subtype === 'init') sid = m.session_id ?? sid
        // 道具を使う間ロボットが黙らないよう、途中経過を呼び出し側へ渡す。
        // SDK は自前のエージェントループを回すので、これを見ないと最終結果まで
        // 数十秒無音になる(ollama 経路は onToolStart で既に同じことをしている)。
        if (m.type === 'assistant') await this.#reportProgress(m)
        if (m.type === 'result') {
          result = (m as any).result ?? ''
          isError = Boolean(m.is_error)
          sid = m.session_id ?? sid
        }
      }
    } catch (err) {
      return { success: false, reason: `${err}` }
    }
    this.#sessionId = sid
    if (isError || result == null) return { success: false, reason: result || 'claude error' }
    const value = stripEmoji(result)
    if (!value) return { success: false, reason: 'empty' }
    return { success: true, value }
  }
}
