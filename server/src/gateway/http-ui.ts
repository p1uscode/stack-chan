// Static UI file serving for the gateway's HTTP control plane. Serves the built
// UI from src/gateway/ui/ with a small MIME map and a directory-escape guard.

import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const UI_DIR = join(HERE, 'ui')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
}

export const serveStatic = async (res, urlPath, json) => {
  const rel = urlPath === '/' ? '/index.html' : urlPath
  const filePath = normalize(join(UI_DIR, rel))
  if (!filePath.startsWith(UI_DIR)) return json(res, 403, { error: 'forbidden' })
  try {
    const buf = await readFile(filePath)
    // キャッシュさせない。Cache-Control が無いとブラウザは Last-Modified から
    // 独自に有効期限を決めてしまい、**デプロイしたのに古い画面が出る**
    // (声のプルダウンを入れたのに入力欄のまま、という形で踏んだ)。
    // UI は数十KBしかないので、毎回取り直して構わない。
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache, must-revalidate',
    })
    res.end(buf)
  } catch {
    json(res, 404, { error: 'not found' })
  }
}
