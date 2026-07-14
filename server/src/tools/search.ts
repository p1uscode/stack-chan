// StackChan用Web検索プロキシ
// GET /search?q=... → DuckDuckGo(HTML版)を検索し、上位結果をJSONで返す
//
// 使い方: ./run.sh search (= npm run search)
// 環境変数: PORT (default 8093), MAX_RESULTS (default 3)

import { createServer } from 'node:http'

const PORT = Number(process.env.PORT ?? 8093)
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 3)

const decodeEntities = (text) => {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

const stripTags = (html) => {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

const search = async (query) => {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=jp-jp`, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
  })
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`)
  const html = await res.text()

  const results = []
  const blocks = html.split('result__body')
  for (const block of blocks.slice(1)) {
    const title = block.match(/class="result__a"[^>]*>(.*?)<\/a>/s)
    const snippet = block.match(/class="result__snippet"[^>]*>(.*?)<\/a>/s)
    if (title) {
      results.push({
        title: stripTags(title[1]),
        snippet: snippet ? stripTags(snippet[1]) : '',
      })
    }
    if (results.length >= MAX_RESULTS) break
  }
  return results
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method !== 'GET' || url.pathname !== '/search') {
    res.writeHead(404).end()
    return
  }
  const q = url.searchParams.get('q') ?? ''
  try {
    const started = Date.now()
    const results = q ? await search(q) : []
    console.log(`[search] "${q}" -> ${results.length} results (${Date.now() - started}ms)`)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ query: q, results }))
  } catch (error) {
    console.error('[search] error:', error.message)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ query: q, results: [], error: error.message }))
  }
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`search-server listening on :${PORT}`)
})
