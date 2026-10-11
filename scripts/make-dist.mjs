// Builds dist/ (exactly what gets deployed): every file reachable from the five pages, nothing else.
// Refuses to continue if a referenced file is missing or if any real private key is inside the output.
//   node scripts/make-dist.mjs      then deploy with wrangler (see memory / README)
import fs from 'node:fs'
import path from 'node:path'
import { crawl } from './check-site.mjs'

const { files, missing } = crawl()
if (missing.length) { console.error('Missing referenced files:', missing.join(', ')); process.exit(1) }

fs.rmSync('dist', { recursive: true, force: true })
for (const f of files) {
  const target = path.join('dist', path.relative('web', f))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(f, target)
}

// static headers file (not referenced by any page, so the crawler does not see it)
if (fs.existsSync('web/_headers')) fs.copyFileSync('web/_headers', 'dist/_headers')

// secret scan: the deployer key from .env and every persona key from the .sim*.json files
const keys = []
const env = fs.readFileSync('.env', 'utf8').match(/DEPLOYER_PRIVATE_KEY=(0x[0-9a-fA-F]{64})/)
if (env) keys.push(env[1].toLowerCase())
for (const f of fs.readdirSync('.').filter((x) => x.startsWith('.sim') && x.endsWith('.json'))) {
  const s = JSON.parse(fs.readFileSync(f, 'utf8'))
  for (const n of ['lender', 'operator', 'customer', 'device']) if (s[n]?.pk) keys.push(s[n].pk.toLowerCase())
}
let leaks = 0
for (const f of fs.readdirSync('dist', { recursive: true }).filter((x) => fs.statSync(path.join('dist', x)).isFile())) {
  const text = fs.readFileSync(path.join('dist', f), 'latin1').toLowerCase()
  for (const k of keys) if (text.includes(k.slice(2))) { leaks++; console.error('PRIVATE KEY FOUND in', f) }
}
if (leaks) { fs.rmSync('dist', { recursive: true, force: true }); console.error('dist removed. Not safe to deploy.'); process.exit(1) }
console.log(`dist ready: ${files.length + 1} files, ${keys.length} private keys scanned, 0 found`)
