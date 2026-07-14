// Write-side HTTP control plane: the webhook (POST /event), the UI control action
// (POST /api/control), and config edits (PUT /api/config). Runs control actions
// (say / prompt / body) against the targeted connected robots and persists the
// event log. handleControl returns true when it responded, false otherwise.

import { resolveTargets } from '#gateway/clients.ts'
import { saveConfig } from '#gateway/config.ts'
import { generateSkit, playSkit, stopSkit } from '#gateway/skit.ts'

const readBody = (req) => {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 1_000_000) reject(new Error('body too large'))
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const readJson = async (req) => {
  const body = (await readBody(req)) as string
  return body ? JSON.parse(body) : {}
}

// Run a control action (say / prompt / body) against the target robots.
const runAction = async (action, source, store) => {
  const targets = resolveTargets(action.target)
  if (targets.length === 0) return { ok: false, error: 'no connected robot' }
  const applied = []
  for (const c of targets) {
    const meta = { device: c.hardwareId, character: c.characterId, label: c.label }
    if (typeof action.say === 'string' && action.say) {
      await c.speak(action.say)
      store?.logTurn(c.id, c.profileName, null, action.say, source, meta)
      applied.push({ id: c.id, action: 'say' })
    }
    if (typeof action.prompt === 'string' && action.prompt) {
      c.prompt(action.prompt) // async LLM turn; don't block the HTTP response
      applied.push({ id: c.id, action: 'prompt' })
    }
    if (action.body && action.body.tool) {
      c.body(action.body.tool, action.body.args ?? {})
      applied.push({ id: c.id, action: 'body', tool: action.body.tool, args: action.body.args ?? {} })
    }
  }
  return { ok: true, applied }
}

const authed = (req, token) => !token || req.headers['x-gateway-token'] === token

// Handle a write route. Returns true if it responded, false otherwise.
export const handleControl = async (req, res, url, ctx, json) => {
  const { store, token } = ctx
  const path = url.pathname

  // --- webhook / control (write) ---
  if (req.method === 'POST' && (path === '/event' || path === '/api/control')) {
    if (!authed(req, token)) return (json(res, 401, { error: 'unauthorized' }), true)
    const action = await readJson(req)
    store?.logEvent(path === '/event' ? 'webhook' : 'control', action)
    const result = await runAction(action, path === '/event' ? 'webhook' : 'ui', store)
    json(res, result.ok ? 200 : 409, result)
    return true
  }

  // --- 掛け合い(スキット): 台本生成 / 再生 / 停止 ---
  if (req.method === 'POST' && path === '/api/skit/generate') {
    if (!authed(req, token)) return (json(res, 401, { error: 'unauthorized' }), true)
    const body = await readJson(req)
    store?.logEvent('skit', { generate: { channels: body.channels, topic: body.topic, minutes: body.minutes, research: !!body.research } })
    try {
      json(res, 200, { ok: true, ...(await generateSkit(body, ctx.log)) })
    } catch (err) {
      json(res, 400, { ok: false, error: err.message })
    }
    return true
  }
  if (req.method === 'POST' && path === '/api/skit/play') {
    if (!authed(req, token)) return (json(res, 401, { error: 'unauthorized' }), true)
    const body = await readJson(req)
    try {
      const result = playSkit(body, { store, log: ctx.log })
      store?.logEvent('skit', { play: { lines: result.total } })
      json(res, 200, result)
    } catch (err) {
      json(res, 409, { ok: false, error: err.message })
    }
    return true
  }
  if (req.method === 'POST' && path === '/api/skit/stop') {
    if (!authed(req, token)) return (json(res, 401, { error: 'unauthorized' }), true)
    json(res, 200, { ok: stopSkit() })
    return true
  }

  if (req.method === 'PUT' && path === '/api/config') {
    if (!authed(req, token)) return (json(res, 401, { error: 'unauthorized' }), true)
    const next = await readJson(req)
    const saved = saveConfig(next)
    store?.logEvent('config', {
      characters: Object.keys(saved.characters ?? {}),
      channels: Object.keys(saved.channels ?? {}),
    })
    json(res, 200, { ok: true, config: saved })
    return true
  }

  return false
}
