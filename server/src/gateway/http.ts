// HTTP control surface for the gateway (tasks 4 + 5): webhook /event, a small
// JSON API for the UI, and static file serving. Runs on a SEPARATE LAN port
// (default 8099) — the robot WebSocket (8098, exposed via Cloudflare) stays
// isolated from this control plane. Expose /event externally later via its own
// Cloudflare route + token if desired.
//
// This module is a thin routing layer: it delegates writes to http-control,
// reads to http-api, and static files to http-ui.

import { createServer } from 'node:http'
import { clientCount } from '#gateway/clients.ts'
import { handleDeviceApi } from '#gateway/device-api.ts'
import { handleReadApi } from '#gateway/http-api.ts'
import { handleControl } from '#gateway/http-control.ts'
import { serveStatic } from '#gateway/http-ui.ts'

// ctx = { store, token, log, webhookOnly }
// webhookOnly: when true, ONLY `POST /event` is served (everything else 404).
// Used for the internet-exposed instance so the UI + config-edit API stay LAN-only.
export const createHttpServer = (ctx) => {
  const { log, webhookOnly } = ctx

  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const path = url.pathname
    try {
      // Internet-exposed instance: only the webhook, nothing else.
      if (webhookOnly && !(req.method === 'POST' && path === '/event')) {
        return json(res, 404, { error: 'not found' })
      }

      // --- 端末が自分の設定を読み書きする狭い口(GET/PATCH /api/device/<hwid>) ---
      if (await handleDeviceApi(req, res, url, ctx, json)) return

      // --- webhook / control (write) ---
      if (await handleControl(req, res, url, ctx, json)) return

      // --- read API ---
      if (await handleReadApi(req, res, url, ctx, json)) return

      if (req.method === 'GET' && path === '/healthz') {
        return json(res, 200, { ok: true, clients: clientCount() })
      }

      // --- static UI ---
      if (req.method === 'GET') return await serveStatic(res, path, json)

      json(res, 404, { error: 'not found' })
    } catch (err) {
      log?.(`http error ${req.method} ${path}: ${err.message}`)
      json(res, 500, { error: err.message })
    }
  })

  return server
}
