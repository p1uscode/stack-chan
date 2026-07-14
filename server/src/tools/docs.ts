// StackChan用ローカル文書検索プロキシ
// GET /docs?q=... → 文書フォルダ内の .txt/.md を検索し、関連箇所をJSONで返す
//
// 検索サーバ(search.ts)と同じ返却形式({query, results:[{title, snippet}]})なので
// 会話MODは検索サーバと同じ経路で結果をLLMに食わせられる。
//
// 使い方: ./run.sh docs (= npm run docs)
// 環境変数: PORT (default 8095), MAX_RESULTS (default 3),
//           DOCS_DIR (default ~/stackchan-docs), MAX_SNIPPET (default 400)

import { createServer } from 'node:http'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, extname, relative } from 'node:path'
import { homedir } from 'node:os'

const PORT = Number(process.env.PORT ?? 8095)
const MAX_RESULTS = Number(process.env.MAX_RESULTS ?? 3)
const MAX_SNIPPET = Number(process.env.MAX_SNIPPET ?? 400)
const DOCS_DIR = process.env.DOCS_DIR ?? join(homedir(), 'stackchan-docs')
const EXTS = new Set(['.txt', '.md', '.markdown', '.text'])

// フォルダ内の .txt/.md を再帰的に集める
const listDocs = async (dir) => {
  const files = []
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return files // フォルダが無ければ空
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // 隠しファイルは無視
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listDocs(full)))
    } else if (EXTS.has(extname(entry.name).toLowerCase())) {
      files.push(full)
    }
  }
  return files
}

// 日本語は分かち書きが無いので、クエリを「空白区切りの語」と「2文字ずつのbigram」に
// 分解して照合する。ASCII語はそのまま、和文はbigramで部分一致を稼ぐ素朴な方式。
const queryTerms = (query) => {
  const terms = new Set()
  for (const word of query.toLowerCase().split(/\s+/)) {
    if (!word) continue
    if (/^[\x00-\x7f]+$/.test(word)) {
      if (word.length >= 2) terms.add(word) // 英数字はそのまま
    } else {
      const chars = [...word]
      if (chars.length === 1) terms.add(chars[0])
      for (let i = 0; i < chars.length - 1; i++) terms.add(chars[i] + chars[i + 1])
    }
  }
  return [...terms]
}

// 文書を段落(空行区切り)に割り、長すぎる段落は分割する
const chunk = (text) => {
  const chunks = []
  for (const block of text.split(/\n\s*\n/)) {
    const trimmed = block.replace(/\s+/g, ' ').trim()
    if (!trimmed) continue
    if (trimmed.length <= MAX_SNIPPET) {
      chunks.push(trimmed)
    } else {
      for (let i = 0; i < trimmed.length; i += MAX_SNIPPET) {
        chunks.push(trimmed.slice(i, i + MAX_SNIPPET))
      }
    }
  }
  return chunks
}

const scoreChunk = (lowerChunk, terms) => {
  let score = 0
  for (const term of terms) {
    let from = 0
    while (true) {
      const at = lowerChunk.indexOf(term, from)
      if (at === -1) break
      score += 1
      from = at + term.length
    }
  }
  return score
}

// `memo-<名前>.md` は**その人格だけの記憶**。self に自分の名前が来たら、他人のぶんは
// 検索対象から外す(self が無ければ従来どおり全部見る = 単独利用や人手の検索用)。
// 共有の memo.md はいつでも全員が読める。
const isOthersNote = (file, self) => {
  const base = relative(DOCS_DIR, file)
  const m = /^memo-(.+)\.md$/.exec(base)
  if (!m) return false            // 共有ぶんや普通の資料
  return !self || m[1] !== self   // self 未指定なら個人ぶんは伏せる
}

const searchDocs = async (query, self) => {
  const terms = queryTerms(query)
  if (!terms.length) return []
  const files = (await listDocs(DOCS_DIR)).filter((f) => !isOthersNote(f, self))
  const scored = []
  for (const file of files) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    const title = relative(DOCS_DIR, file)
    for (const passage of chunk(text)) {
      const score = scoreChunk(passage.toLowerCase(), terms)
      if (score > 0) scored.push({ title, snippet: passage, score })
    }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, MAX_RESULTS).map(({ title, snippet }) => ({ title, snippet }))
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method !== 'GET' || url.pathname !== '/docs') {
    res.writeHead(404).end()
    return
  }
  const q = url.searchParams.get('q') ?? ''
  const self = url.searchParams.get('self') ?? ''
  try {
    const started = Date.now()
    const results = q ? await searchDocs(q, self) : []
    console.log(`[docs] "${q}"${self ? ` (self=${self})` : ''} -> ${results.length} results (${Date.now() - started}ms)`)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ query: q, results }))
  } catch (error) {
    console.error('[docs] error:', error.message)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ query: q, results: [], error: error.message }))
  }
})

server.listen(PORT, '0.0.0.0', async () => {
  let count = 0
  try {
    count = (await listDocs(DOCS_DIR)).length
  } catch {}
  console.log(`docs-server listening on :${PORT} (dir=${DOCS_DIR}, ${count} files)`)
})
