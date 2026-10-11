// Minimal Cloudflare D1 look-alike on Node's built-in SQLite, so the Worker can be tested without wrangler.
import fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

export function createD1(schemaPath = 'schema.sql') {
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync(schemaPath, 'utf8'))

  function prepare(sql) {
    const stmt = db.prepare(sql)
    let args = []
    const api = {
      bind(...a) { args = a; return api },
      async first() { return stmt.get(...args) ?? null },
      async all() { return { results: stmt.all(...args) } },
      async run() {
        const r = stmt.run(...args)
        return { meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
      },
    }
    return api
  }

  return {
    prepare,
    async batch(statements) {
      const out = []
      for (const s of statements) out.push(await s.run())
      return out
    },
    raw: db,
  }
}
