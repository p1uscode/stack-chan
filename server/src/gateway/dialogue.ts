// Dialogue construction: builds a dialogue backend (OllamaDialogue / ClaudeDialogue)
// for a resolved profile — discovering MCP tools, wiring body tools, and selecting
// the backend. Called per connection (session.ensureDialogue) and rebuilt when the
// config version bumps.

import { OllamaDialogue, discoverMcpTools } from '#gateway/agent.ts'
import { ClaudeDialogue } from '#gateway/claude.ts'
import { CodexDialogue } from '#gateway/codex.ts'
import { accessHeadersOf } from '#gateway/config.ts'
import type { BuildOpts, Profile } from '#gateway/types.ts'

// Body tools the LLM can call: emotion / head / LED. execute() pushes a `body`
// frame to THIS robot (the gateway can't move the robot itself) and returns a
// short confirmation for the tool result. Registered per connection.
// Body tools (set_emotion / move_head / set_led + nod / dance compound motions)
// live in #gateway/body-tools.ts.

// Build a dialogue for a connection's profile: discover MCP tools, add the body
// tools, wire the loop. extraTools = body tools (per connection); onToolStart is
// called just before each tool runs (used to speak a filler while it works).
export const buildDialogue = async (profile: Profile, { extraTools = [], onToolStart, channel, character }: BuildOpts = {}, log = (..._a) => {}) => {
  // Backend selection (task 6). 'claude' = Claude Agent SDK (own agentic loop,
  // knowledge tools via the MCP server); 'ollama' = the in-gateway loop with body
  // tools + speaking-during-tools. Body tools are ollama-only for now.
  //
  // **知らない値は警告を出す。**以前は「claude でも codex でもなければ ollama」と
  // いう素通しだったので、綴りを間違えても黙って ollama で動いてしまい、
  // 「設定したのに効かない」の原因がログに残らなかった。
  // codex-realtime がここに来るのは**音声以外のターン**(UI の prompt、リマインダーの
  // 喋り返し、掛け合い)。音声は session.ts が横取りするのでここには来ない。
  const backend = profile.backend ?? 'ollama'
  if (backend === 'codex-realtime') {
    log('backend=codex-realtime だがテキストのターン。realtime は音声だけなので ollama で処理する')
  } else if (!['ollama', 'claude', 'codex'].includes(backend)) {
    log(`★ backend="${backend}" は知らない値。ollama として扱う(綴りを確認すること)`)
  }
  if (backend === 'claude') {
    log(`backend=claude model=${profile.claudeModel ?? '(default)'} exe=${profile.claudePath ?? '(SDK 同梱)'}`)
    return new ClaudeDialogue({
      instructions: profile.instructions,
      model: profile.claudeModel,
      mcpUrl: profile.mcp,
      executable: profile.claudePath,
      onToolStart,
    })
  }
  // backend=codex: codex app-server とテキストで往復する。STT/TTS はいつもどおり通るので
  // 声はキャラクターの設定のまま(realtime は声が OpenAI 側になる点が違う)。
  if (backend === 'codex') {
    // codex 自身の組み込みツール(シェル・ファイル)に加えて、こちらの MCP ツールも
    // dynamicTools として渡す。body ツール(表情)は ollama 経路専用なので渡さない。
    let codexTools = []
    try {
      codexTools = await discoverMcpTools(profile.mcp, accessHeadersOf(profile), { channel, character })
    } catch (err) {
      log(`mcp discovery failed: ${err.message}`)
    }
    const allow = Array.isArray(profile.tools) ? profile.tools : null
    const passed = allow ? codexTools.filter((t) => allow.includes(t.name)) : codexTools
    log(`backend=codex cwd=${profile.codex?.cwd ?? process.cwd()} tools: ${passed.map((t) => t.name).join(',') || '(none)'}`)
    return new CodexDialogue({
      instructions: profile.instructions,
      cwd: profile.codex?.cwd,
      socketPath: profile.codex?.socket,
      codexPath: profile.codex?.path,
      sandbox: profile.codex?.sandbox,
      tools: passed,
      log,
    })
  }

  const headers = accessHeadersOf(profile)
  let mcpTools = []
  try {
    mcpTools = await discoverMcpTools(profile.mcp, headers, { channel, character })
    log(`mcp tools: ${mcpTools.map((t) => t.name).join(',') || '(none)'}`)
  } catch (err) {
    log(`mcp discovery failed: ${err.message}`)
  }
  const catalog = [...extraTools, ...mcpTools]
  const allow = Array.isArray(profile.tools) ? profile.tools : null
  const tools = allow ? catalog.filter((t) => allow.includes(t.name)) : catalog
  // 実際に LLM へ渡すツール。allow(character+channel の和集合)に載っていない名前は
  // ここで落ちるので、「呼んでくれない」ときは catalog と allow の差を最初に見る。
  log(`tools enabled: ${tools.map((t) => t.name).join(',') || '(none)'}`)
  return new OllamaDialogue({
    url: profile.ollama,
    model: profile.model,
    instructions: profile.instructions,
    headers,
    tools,
    historyLimit: profile.historyLimit,
    compactKeep: profile.compactKeep,
    onToolStart,
  })
}
