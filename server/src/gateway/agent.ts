// Agent loop for the Mac gateway — the ollama chat + tool loop moved off the
// robot (docs/2026-07-13-mac-gateway-design.md, Phase 2a). Ported faithfully
// from firmware/mods/local_voice_chat/{dialogue-ollama.js,mod.js}: same request
// shape (stream:false, think:false, keep_alive:24h), same tool-round loop, same
// MCP-over-Streamable-HTTP client, same <think> stripping. Runs on Node's native
// fetch instead of the Moddable fetch/Headers/Timer shims.

const MAX_TOOL_ROUNDS = 3

const fetchWithTimeout = (url, options = {}, timeoutMs = 120000) => {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(new Error(`timeout ${url}`)), timeoutMs)
  return fetch(url, { ...options, signal: ac.signal }).finally(() => clearTimeout(timer))
}

// Thinking-mode models (Qwen3 family) may wrap reasoning in <think> tags.
export const stripThinkBlocks = (text) => {
  let result = text
  let start = result.indexOf('<think>')
  while (start >= 0) {
    const end = result.indexOf('</think>', start)
    if (end < 0) {
      result = result.slice(0, start)
      break
    }
    result = result.slice(0, start) + result.slice(end + '</think>'.length)
    start = result.indexOf('<think>')
  }
  return result.trim()
}

// --- MCP client over Streamable HTTP (JSON-RPC 2.0) -----------------------
// The MCP server (src/mcp) is stateless, so tools/list and tools/call POST directly
// with no initialize handshake. accessHeaders carries CF-Access-* for external.

const parseSseMessage = (text) => {
  let data = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('data:')) data += line.slice(5).trim()
  }
  return JSON.parse(data.length > 0 ? data : text.trim())
}

const mcpRequest = async (url, method, params, accessHeaders = {}, timeoutMs = 20000) => {
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...accessHeaders,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    },
    timeoutMs,
  )
  if (!response.ok) throw new Error(`mcp ${method} ${response.status}`)
  const message = parseSseMessage(await response.text())
  if (message.error) throw new Error(`mcp ${method}: ${message.error?.message ?? 'error'}`)
  return message.result ?? {}
}

// Fetch the MCP server's catalog; wrap each tool as { name, description,
// inputSchema, execute } routing to tools/call. Body tools are added separately.
export const discoverMcpTools = async (mcpUrl, accessHeaders = {}, context: { channel?: string; character?: string } = {}) => {
  if (!mcpUrl) return []
  const result = await mcpRequest(mcpUrl, 'tools/list', {}, accessHeaders, 10000)
  const tools = (result.tools ?? []).map((tool) => {
    // 「どのロボットから呼ばれたか」を要るツール(リマインダーなど)は、
    // inputSchema に channel を宣言しておく。値は**こちらが入れる**: LLM は自分が
    // どのチャネルかを知らないので、埋めさせると嘘の値が来る。
    const wantsChannel = tool.inputSchema?.properties?.channel !== undefined
    // 「どの人格から呼ばれたか」を要るツール(記憶の書き分け)も同じ流儀で。
    // channel(宿り先)とは別物 —— 同じ機体に別の人格を宿すことがあるので、
    // 記憶は character で分ける。
    const wantsCharacter = tool.inputSchema?.properties?.character !== undefined
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      execute: async (args) => {
        let payload = args
        if (wantsChannel && context.channel) payload = { ...payload, channel: context.channel }
        if (wantsCharacter && context.character) payload = { ...payload, character: context.character }
        const r = await mcpRequest(mcpUrl, 'tools/call', { name: tool.name, arguments: payload }, accessHeaders, 20000)
        const text = (r.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
        if (r.isError) throw new Error(text.length > 0 ? text : 'tool error')
        return text.length > 0 ? text : '(結果なし)'
      },
    }
  })
  return tools
}

// --- Ollama dialogue (ported from dialogue-ollama.js) ---------------------

const DEFAULT_INSTRUCTIONS = `あなたは手のひらサイズの超かわいいロボットです。
返事は短い一文の話し言葉だけにしてください。記号や絵文字は使わないでください。`

export class OllamaDialogue {
  #url
  #model
  #instructions
  #history = []
  #summary = ''
  #historyLimit
  #compactKeep
  #headers
  #tools = new Map()
  // Called with (toolName, args) just before a tool executes — lets the gateway
  // speak "調べますね" while the tool runs (Phase 2a-4). Optional.
  #onToolStart

  constructor({
    url,
    model,
    instructions = DEFAULT_INSTRUCTIONS,
    tools = [],
    historyLimit = 12,
    compactKeep = 4,
    headers = {},
    onToolStart,
  }) {
    this.#url = url
    this.#model = model
    this.#instructions = instructions
    this.#historyLimit = historyLimit
    this.#compactKeep = Math.min(compactKeep, historyLimit)
    this.#headers = headers
    this.#onToolStart = onToolStart
    for (const tool of tools) this.#tools.set(tool.name, tool)
  }

  clear() {
    this.#history.length = 0
    this.#summary = ''
  }

  async post(message) {
    this.#history.push({ role: 'user', content: message })
    try {
      const response = await this.#converse()
      this.#history.push({ role: 'assistant', content: response })
      if (this.#history.length > this.#historyLimit) await this.#compact()
      return { success: true, value: response }
    } catch (error) {
      this.#history.pop()
      return { success: false, reason: `${error}` }
    }
  }

  #systemContent() {
    return this.#summary ? `${this.#instructions}\n\nこれまでの会話の要約: ${this.#summary}` : this.#instructions
  }

  async #compact() {
    const keep = this.#compactKeep
    const old = this.#history.slice(0, this.#history.length - keep)
    const recent = this.#history.slice(this.#history.length - keep)
    try {
      const transcript = old.map((m) => `${m.role === 'user' ? '相手' : '自分'}: ${m.content}`).join('\n')
      const prelude = this.#summary ? `これまでの要約: ${this.#summary}\n\n続きの会話:\n` : ''
      const body = {
        model: this.#model,
        stream: false,
        think: false,
        keep_alive: '24h',
        messages: [
          {
            role: 'system',
            content: '会話の要約者。話題・事実・名前・約束事を落とさず、日本語で3行以内に要約する。要約だけを出力。',
          },
          { role: 'user', content: `${prelude}${transcript}` },
        ],
      }
      const response = await fetchWithTimeout(
        `${this.#url}/api/chat`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.#headers }, body: JSON.stringify(body) },
        120000,
      )
      if (!response.ok) throw new Error(`compact error: ${response.status}`)
      const result: any = await response.json()
      const summary = stripThinkBlocks(result?.message?.content ?? '')
      if (summary.length === 0) throw new Error('empty summary')
      this.#summary = summary
      this.#history = recent
    } catch {
      this.#history = recent
    }
  }

  async #converse() {
    const messages = [{ role: 'system', content: this.#systemContent() }, ...this.#history]
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await this.#sendMessage(messages)
      const toolCalls = result.message?.tool_calls
      if (!toolCalls || toolCalls.length === 0 || round === MAX_TOOL_ROUNDS) {
        const content = result.message?.content
        if (typeof content !== 'string') throw new Error('unexpected response shape')
        return stripThinkBlocks(content)
      }
      messages.push(result.message)
      for (const call of toolCalls) {
        const name = call.function?.name
        const tool = this.#tools.get(name)
        const args = call.function?.arguments ?? {}
        let outcome
        try {
          await this.#onToolStart?.(name, args, tool)
          outcome = tool ? String(await tool.execute(args)) : `unknown tool: ${name}`
        } catch (error) {
          outcome = `tool error: ${error}`
        }
        console.log(`[agent] tool ${name}(${JSON.stringify(args)}) -> ${outcome.slice(0, 120)}`)
        messages.push({ role: 'tool', tool_name: name, content: outcome })
      }
    }
    throw new Error('unreachable')
  }

  async #sendMessage(messages) {
    const body: any = { model: this.#model, stream: false, think: false, keep_alive: '24h', messages }
    if (this.#tools.size > 0) {
      body.tools = [...this.#tools.values()].map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
      }))
    }
    const response = await fetchWithTimeout(
      `${this.#url}/api/chat`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', ...this.#headers }, body: JSON.stringify(body) },
      120000,
    )
    if (!response.ok) throw new Error(`request error: ${response.status}`)
    const result: any = await response.json()
    const totalMs = Math.round((result.total_duration ?? 0) / 1e6)
    const toolCount = result.message?.tool_calls?.length ?? 0
    console.log(
      `[agent] response (${totalMs}ms, ${result.eval_count ?? '?'} tokens, ${toolCount} tool calls): ${(result.message?.content ?? '').slice(0, 120)}`,
    )
    return result
  }
}
