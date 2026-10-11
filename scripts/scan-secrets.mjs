// Scans the files git would commit for private keys and for any secret value that lives in .env. Run before publishing the repo.
//   node scripts/scan-secrets.mjs
import fs from 'node:fs'
import cp from 'node:child_process'

const env = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : ''
const secrets = [...env.matchAll(/=\s*"?(0x[0-9a-fA-F]{64}|[A-Za-z0-9_-]{24,})"?/g)].map((m) => m[1])
const files = cp.execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean)
let hits = 0
for (const f of files) {
  let text
  try { text = fs.readFileSync(f, 'utf8') } catch { continue }
  for (const s of secrets) if (text.includes(s)) { console.log('SECRET VALUE FROM .env FOUND IN', f); hits++ }
  for (const m of text.matchAll(/(?:private[_ ]?key|secret|api[_-]?key)["' :=]+(0x[0-9a-fA-F]{64})/gi)) { console.log('key-looking value in', f, m[0].slice(0, 36)); hits++ }
}
console.log(`.env values checked: ${secrets.length}, files scanned: ${files.length}, hits: ${hits}`)
process.exit(hits ? 1 : 0)
