// Codex backend(テキスト往復)。character の `backend` に "codex" を設定すると使う。
//
// codex-realtime.ts との違い:
//   realtime … 録音WAVをそのまま OpenAI Realtime へ流し、音声で返る。速いが
//              **こちらのツールも VOICEVOX も通らない**(声は OpenAI 側)。
//   codex    … ここ。テキストを渡してテキストで受ける。whisper(STT)と VOICEVOX(TTS)は
//              いつもどおり通るので、**声はキャラクターの設定のまま**。
//
// ClaudeDialogue と同じインターフェース(post(text) -> {success, value} / clear())なので、
// gateway からは差し替えるだけで使える。
//
// プロトコル(codex app-server generate-json-schema で確認):
//   thread/start  {cwd, baseInstructions, approvalPolicy, sandbox} -> {thread:{id}}
//   turn/start    {threadId, input}                                -> 応答は turn/completed 通知
//   turn/completed {threadId, turn:{items,status}}                 -> items から assistant の本文を拾う
//
// app-server は自分で起こす(codex-app-server.ts)。外でデーモンを常駐させておく必要は
// なく、gateway のプロセスだけで完結する。codex.socket を書いたときだけ既存のものに繋ぐ。
//
// 承認とサンドボックス: 音声で動かすので**誰も承認できない**。承認要求で止まると無反応に
// 見えるだけなので approvalPolicy は "never"、そのうえで巻き添え事故を避けるため
// sandbox は "read-only" にしてある(読む・調べるはできるが書き換えはしない)。
// 書き込みまで許すなら呼び出し側で sandbox を上書きすること。

import type { CodexAppServer } from '#codex/codex/app-server.ts'
import { type CodexAppServerHandle, startCodexAppServer } from '#gateway/codex-app-server.ts'

const TURN_TIMEOUT_MS = 120_000

const isRecord = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null

// 応答本文は item/completed 通知で1件ずつ届く({item:{type:"agentMessage", text}})。
// turn/completed は終了の合図で、本文は載っていない(items は notLoaded のことがある)。
const agentTextOf = (params: unknown): string | null => {
  if (!isRecord(params) || !isRecord(params.item)) return null
  const item = params.item
  return item.type === 'agentMessage' && typeof item.text === 'string' ? item.text : null
}

export class CodexDialogue {
  #instructions
  #cwd
  #socketPath
  #codexPath
  #sandbox
  #tools
  #log
  #handle: CodexAppServerHandle | null = null
  #appServer: CodexAppServer | null = null
  #threadId: string | null = null

  constructor({
    instructions,
    cwd,
    socketPath,
    codexPath,
    sandbox = 'read-only',
    tools = [],
    log = (..._a) => {},
  }) {
    this.#tools = new Map(tools.map((t) => [t.name, t]))
    this.#log = log
    this.#instructions = instructions
    this.#cwd = cwd ?? process.cwd()
    this.#socketPath = socketPath
    this.#codexPath = codexPath
    this.#sandbox = sandbox
  }

  clear() {
    // スレッドを捨てるだけ。接続は使い回す(app-server の起動は重い)。
    this.#threadId = null
  }

  async close() {
    const handle = this.#handle
    this.#handle = null
    this.#appServer = null
    this.#threadId = null
    try {
      await handle?.close()
    } catch {}
  }

  async #ensureThread() {
    if (!this.#appServer) {
      const handle = await startCodexAppServer({
        socketPath: this.#socketPath,
        codexPath: this.#codexPath,
        log: this.#log,
        // 落ちた接続を掴んだままだと以後ずっと失敗する。捨てて次のターンで起こし直す。
        onClosed: () => {
          if (this.#handle !== handle) return
          this.#handle = null
          this.#appServer = null
          this.#threadId = null
        },
      })
      this.#handle = handle
      this.#appServer = handle.server
      handle.server.on('serverRequest', (req: any) => void this.#handleServerRequest(req))
    }
    if (this.#threadId) return this.#threadId
    // 私たちの MCP ツール(weather / todo_* / web_search)を codex に見せる。
    // codex 側が使うと決めたら item/tool/call でこちらへ実行を依頼してくる。
    const dynamicTools = [...this.#tools.values()].map((t) => ({
      type: 'function' as const,
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }))
    const res: any = await this.#appServer.rpc.request('thread/start', {
      cwd: this.#cwd,
      ...(dynamicTools.length > 0 ? { dynamicTools } : {}),
      // 人格はここで渡す。毎ターン先頭に積まなくて済む。
      baseInstructions: this.#instructions,
      approvalPolicy: 'never',
      sandbox: this.#sandbox,
    })
    const id = res?.thread?.id
    if (typeof id !== 'string') throw new Error('thread/start returned no thread id')
    this.#threadId = id
    return id
  }

  // codex からのツール実行依頼。MCP を実際に叩いて結果を返す。
  // 応答形は DynamicToolCallResponse {success, contentItems:[{type:'inputText', text}]}。
  async #handleServerRequest(req: any) {
    const server = this.#appServer
    if (!server || req?.method !== 'item/tool/call') return
    const params = req.params ?? {}
    const tool = this.#tools.get(params.tool)
    const reply = (success: boolean, text: string) =>
      server.rpc.respond(req.id, { success, contentItems: [{ type: 'inputText', text }] })
    if (!tool) {
      await reply(false, `unknown tool: ${params.tool}`)
      return
    }
    try {
      const out = await tool.execute(params.arguments ?? {})
      this.#log(`codex tool ${params.tool}(${JSON.stringify(params.arguments ?? {})}) -> ${String(out).slice(0, 80)}`)
      await reply(true, String(out))
    } catch (error: any) {
      this.#log(`codex tool ${params.tool} failed: ${error?.message ?? error}`)
      await reply(false, `tool failed: ${error?.message ?? error}`)
    }
  }

  async post(text) {
    try {
      const threadId = await this.#ensureThread()
      const server = this.#appServer
      if (!server) throw new Error('app-server not connected')

      // 応答は turn/completed 通知で返る。turn/start の戻りだけでは本文が来ない。
      const done = new Promise<string>((resolve, reject) => {
        const parts: string[] = []
        const timer = setTimeout(() => {
          server.off('notification', onNotification)
          reject(new Error('codex turn timeout'))
        }, TURN_TIMEOUT_MS)
        const finish = (fn: () => void) => {
          clearTimeout(timer)
          server.off('notification', onNotification)
          fn()
        }
        const onNotification = (n: any) => {
          if (!isRecord(n?.params) || n.params.threadId !== threadId) return
          if (n.method === 'item/completed') {
            const text = agentTextOf(n.params)
            if (text) parts.push(text)
            return
          }
          if (n.method !== 'turn/completed') return
          const turn = n.params.turn
          if (isRecord(turn) && turn.status === 'failed') {
            const message = isRecord(turn.error) ? String(turn.error.message ?? 'turn failed') : 'turn failed'
            finish(() => reject(new Error(message)))
            return
          }
          finish(() => resolve(parts.join('\n').trim()))
        }
        server.on('notification', onNotification)
      })

      await server.rpc.request('turn/start', {
        threadId,
        // UserInput の型は 'text'(ContentItem の 'input_text' とは別物)。
        input: [{ type: 'text', text }],
      })
      const value = await done
      return { success: true, value }
    } catch (error: any) {
      // スレッドが壊れている可能性があるので次ターンで張り直す。
      this.#threadId = null
      // rpc のエラーは message を持たないことがあるので、中身が見える形にする。
      const detail = error?.message || error?.error?.message || JSON.stringify(error) || String(error)
      return { success: false, value: detail }
    }
  }
}
