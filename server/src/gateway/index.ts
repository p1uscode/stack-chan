// Mac gateway for the "thin robot" architecture (docs/2026-07-13-mac-gateway-design.md).
//
// Phase 2a: the ollama agent loop + MCP tools run HERE, off the robot. The robot
// sends transcribed text over one persistent WebSocket; the gateway runs the loop
// and (2a-2) streams synthesized audio back. For now it returns the reply text.
//
// Message protocol (JSON control frames; binary frames carry audio in 2a-2):
//   robot -> gw : hello{profile} | utterance_text{text} | utterance_end | pong
//   gw -> robot : status{state} | speak_begin | speak_text{text} | speak_end
//                 | body{tool,args} | error{message} | ping
//
// Runs on the LAN host that serves the robots, as plain ws://. The robot picks
// this gateway when its connected Wi-Fi is flagged internal; Cloudflare Tunnel
// adds wss:// for external access.
//
// This file is bootstrap only: it wires the WebSocket server (delegating each
// connection to createSession) and the HTTP control plane (createHttpServer).
// Config/registry/dialogue/session/http logic live in their own #gateway modules.

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { createHttpServer } from '#gateway/http.ts'
import { createSession } from '#gateway/session.ts'
import { initStore } from '#gateway/store.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
// Layout: this file is src/gateway/. Runtime data (sqlite) in server/data/ —
// two levels up.
const DATA_DIR = join(HERE, '..', '..', 'data')
const PORT = Number(process.env.GATEWAY_PORT ?? 8098)
const HTTP_PORT = Number(process.env.GATEWAY_HTTP_PORT ?? 8099)
// Webhook-only server (POST /event only) for internet exposure via Cloudflare.
// Set to 0 to disable. UI + config API stay on HTTP_PORT (LAN only).
const HOOK_PORT = Number(process.env.GATEWAY_HOOK_PORT ?? 8100)
const HOST = process.env.GATEWAY_HOST ?? '0.0.0.0'
const WEBHOOK_TOKEN = process.env.GATEWAY_WEBHOOK_TOKEN ?? null

const now = () => new Date().toISOString().slice(11, 23)
const log = (...a) => console.log(`[gateway ${now()}]`, ...a)

// --- WebSocket server -----------------------------------------------------
// Persistence layer (task 3). Set by initStore() at startup; null-safe everywhere.
let store = null
try {
  store = initStore(join(DATA_DIR, 'gateway.db'))
  log('store ready (data/gateway.db)')
} catch (err) {
  log(`store init failed: ${err.message}`)
}
const wss = new WebSocketServer({ host: HOST, port: PORT })

wss.on('listening', () => log(`listening on ws://${HOST}:${PORT}`))

// HTTP control plane (webhook + UI + API) on a separate LAN port.
const httpServer = createHttpServer({ store, token: WEBHOOK_TOKEN, log })
httpServer.listen(HTTP_PORT, HOST, () => log(`http (ui/api/webhook) on http://${HOST}:${HTTP_PORT} (LAN)`))

// Webhook-only server for Cloudflare exposure — only POST /event is served here,
// so the UI + config-edit API are never reachable from the internet.
if (HOOK_PORT > 0) {
  const hookServer = createHttpServer({ store, token: WEBHOOK_TOKEN, webhookOnly: true, log })
  hookServer.listen(HOOK_PORT, HOST, () => log(`webhook-only on http://${HOST}:${HOOK_PORT} (expose via Cloudflare)`))
}

wss.on('connection', (ws, req) => createSession(ws, req, { store, log }))

wss.on('error', (err) => {
  log('server error', err.message)
  process.exit(1)
})
process.on('SIGINT', () => wss.close(() => process.exit(0)))
