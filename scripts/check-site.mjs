// Crawls the site from its entry pages and reports (a) local files that are referenced but missing and
// (b) which files the deploy folder must contain. Used by make-dist.mjs and runnable on its own.
//   node scripts/check-site.mjs
import fs from 'node:fs'
import path from 'node:path'

export const ENTRIES = ['web/index.html', 'web/login.html', 'web/signup.html', 'web/app.html', 'web/story.html', 'web/testnet.html']

function refsOf(file) {
  const text = fs.readFileSync(file, 'utf8')
  const dir = path.dirname(file)
  const out = []
  if (file.endsWith('.html')) for (const m of text.matchAll(/(?:href|src)="([^"#?]+)/g)) out.push(m[1])
  if (file.endsWith('.css')) for (const m of text.matchAll(/url\(['"]?([^)'"#?]+)/g)) out.push(m[1])
  // bundled output (app.js) has no relative imports worth following
  if (/\.(m?js)$/.test(file) && path.basename(file) !== 'app.js') for (const m of text.matchAll(/(?:import|from)\s*['"](\.[^'"]+)['"]/g)) out.push(m[1])
  return out
    .filter((r) => !/^(https?:|data:|mailto:|\/\/)/.test(r) && r !== '/' && r !== '')
    .map((r) => path.normalize(path.join(dir, r)).replaceAll('\\', '/'))
}

export function crawl(entries = ENTRIES) {
  const seen = new Set()
  const missing = []
  const queue = [...entries]
  while (queue.length) {
    const f = queue.pop()
    if (seen.has(f)) continue
    seen.add(f)
    if (!fs.existsSync(f)) { missing.push(f); continue }
    if (/\.(html|css|m?js)$/.test(f)) for (const r of refsOf(f)) queue.push(r)
  }
  return { files: [...seen].filter((f) => fs.existsSync(f)).sort(), missing }
}

if (import.meta.url === `file:///${process.argv[1].replaceAll('\\', '/')}`) {
  const { files, missing } = crawl()
  console.log(`${files.length} files reachable from ${ENTRIES.length} pages`)
  console.log(missing.length ? `MISSING: ${missing.join(', ')}` : 'no missing references')
  for (const f of files) console.log('  ', f)
  process.exit(missing.length ? 1 : 0)
}
