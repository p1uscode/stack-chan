// Persistence for the gateway (task 3) using Node's built-in SQLite (node:sqlite,
// stable in Node 22+). Stores conversation turns, events (connect/disconnect,
// webhooks, manual control), so the UI (task 5) can show history and live state.
// One file DB next to the gateway; WAL for concurrent read while writing.

import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

export const initStore = (dbPath: string = join(HERE, '..', '..', 'data', 'gateway.db')) => {
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS turns (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        TEXT NOT NULL,
      client    INTEGER,
      profile   TEXT,
      role      TEXT NOT NULL,   -- 'user' | 'assistant' (speaker type — NOT the character)
      text      TEXT NOT NULL,
      source    TEXT,            -- 'voice' | 'webhook' | 'ui'
      device    TEXT,            -- hardware_id (which channel/unit)
      character      TEXT,            -- character id (which persona)
      label     TEXT             -- human label for the channel (e.g. "1号機")
    );
    CREATE TABLE IF NOT EXISTS events (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       TEXT NOT NULL,
      kind     TEXT NOT NULL,   -- 'connect' | 'disconnect' | 'webhook' | 'control' | 'tool'
      data     TEXT             -- JSON
    );
    CREATE INDEX IF NOT EXISTS idx_turns_ts ON turns(ts);
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  `)
  // Migrate older DBs toward the current `character` column. The naming evolved
  // assistant → soul → character, so rename whichever legacy column exists, then
  // add any missing columns (device/character/label).
  const cols = () => db.prepare('PRAGMA table_info(turns)').all().map((c: any) => c.name)
  if (cols().includes('assistant') && !cols().includes('soul') && !cols().includes('character')) {
    db.exec('ALTER TABLE turns RENAME COLUMN assistant TO character')
  }
  if (cols().includes('soul') && !cols().includes('character')) {
    db.exec('ALTER TABLE turns RENAME COLUMN soul TO character')
  }
  for (const col of ['device', 'character', 'label']) {
    if (!cols().includes(col)) db.exec(`ALTER TABLE turns ADD COLUMN ${col} TEXT`)
  }

  const insTurn = db.prepare(
    'INSERT INTO turns (ts, client, profile, role, text, source, device, character, label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  )
  const insEvent = db.prepare('INSERT INTO events (ts, kind, data) VALUES (?, ?, ?)')
  const now = () => new Date().toISOString()

  return {
    db,
    // Record a completed conversation exchange (user text + assistant reply).
    // meta = { device, character, label } identifies which channel/character it was.
    logTurn(client, profile, userText, assistantText, source = 'voice', meta: { device?: any; character?: any; label?: any } = {}) {
      const ts = now()
      const { device = null, character = null, label = null } = meta
      try {
        if (userText) insTurn.run(ts, client ?? null, profile ?? null, 'user', userText, source, device, character, label)
        if (assistantText)
          insTurn.run(ts, client ?? null, profile ?? null, 'assistant', assistantText, source, device, character, label)
      } catch (err) {
        console.error('[store] logTurn failed', err.message)
      }
    },
    logEvent(kind, data) {
      try {
        insEvent.run(now(), kind, data ? JSON.stringify(data) : null)
      } catch (err) {
        console.error('[store] logEvent failed', err.message)
      }
    },
    recentTurns(limit = 200) {
      return db.prepare('SELECT * FROM turns ORDER BY id DESC LIMIT ?').all(limit).reverse()
    },
    recentEvents(limit = 200) {
      return db
        .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
        .all(limit)
        .map((e) => ({ ...e, data: e.data ? JSON.parse(e.data as string) : null }))
    },
    // Unified, filtered, server-side paged timeline over turns + events.
    // opts: { limit, offset, from, to, category('conv'|'event'), kind, who
    //         ('human'|'system'|<characterId>), device(hardware_id) }
    // Returns { items, total, limit, offset }. Newest first.
    timeline(opts: any = {}) {
      const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 500)
      const offset = Math.max(Number(opts.offset) || 0, 0)
      // Merge both tables into one shape. Events keep their JSON in `data`;
      // device/character/label are pulled out of it so filters/columns work. Old event
      // rows used the key `assistant` — COALESCE keeps them working as `character`.
      const base = `
        SELECT id, ts, 'conv' AS category, role AS kind, text, source, device, character, label, NULL AS data FROM turns
        UNION ALL
        SELECT id, ts, 'event' AS category, kind, NULL AS text, NULL AS source,
               COALESCE(json_extract(data,'$.device'), json_extract(data,'$.hardwareId')) AS device,
               COALESCE(json_extract(data,'$.character'), json_extract(data,'$.soul'), json_extract(data,'$.assistant')) AS character,
               json_extract(data,'$.label')     AS label,
               data FROM events`
      const where: string[] = []
      const params: any[] = []
      if (opts.from) { where.push('ts >= ?'); params.push(opts.from) }
      if (opts.to) { where.push('ts <= ?'); params.push(opts.to) }
      if (opts.category === 'conv' || opts.category === 'event') { where.push('category = ?'); params.push(opts.category) }
      if (opts.kind) { where.push('kind = ?'); params.push(opts.kind) }
      if (opts.device) { where.push('device = ?'); params.push(opts.device) }
      if (opts.who === 'human') where.push("category = 'conv' AND kind = 'user'")
      else if (opts.who === 'system') where.push("character IS NULL AND category = 'event'")
      else if (opts.who) { where.push('character = ?'); params.push(opts.who) }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = (db.prepare(`SELECT COUNT(*) AS n FROM (${base}) ${clause}`).get(...params) as any).n
      const items = db
        .prepare(`SELECT * FROM (${base}) ${clause} ORDER BY ts DESC, category DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset)
        .map((r: any) => ({ ...r, data: r.data ? JSON.parse(r.data) : null }))
      return { items, total, limit, offset }
    },
    close() {
      db.close()
    },
  }
}
