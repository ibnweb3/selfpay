// Local dev server for the site (web/): same files Cloudflare serves, caching OFF, plus the real /api Worker running
// against an in-memory SQLite (fresh on every restart).   npm run dev   ->  http://localhost:4180
// Dev-only extras (never deployed): /__dev/mock-wallet.js and /__dev/sign let a page pretend to have a wallet,
// signing with a throwaway test key. Open any page with ?mockwallet=1 to enable it.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createApp } from '../worker/index.mjs'
import { createD1 } from './lib/d1-shim.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', 'web') // independent of the current directory
const PORT = Number(process.env.PORT || 4180)
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg',
}

const db = createD1(path.resolve(here, '..', 'schema.sql'))
const env = { DB: db, ASSETS: { fetch: async () => new Response('not used in dev', { status: 404 }) } }
const app = createApp()
const testAccounts = new Map() // label -> account, so ?mockwallet=lender and ?mockwallet=borrower can differ
const testAccount = (label) => {
  if (!testAccounts.has(label)) testAccounts.set(label, privateKeyToAccount(generatePrivateKey()))
  return testAccounts.get(label)
}

const MOCK_WALLET = `(() => {
  const label = new URLSearchParams(location.search).get('mockwallet') || (document.cookie.match(/(?:^|; )mw=([^;]+)/) || [])[1] || 'default';
  const state = { address: null };
  const provider = {
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        if (!state.address) state.address = (await (await fetch('/__dev/account?label=' + label)).json()).address;
        return [state.address];
      }
      if (method === 'eth_chainId') return '0x14a34';
      if (method === 'personal_sign') {
        const res = await fetch('/__dev/sign?label=' + label, { method: 'POST', body: JSON.stringify({ hex: params[0] }) });
        return (await res.json()).signature;
      }
      throw new Error('unsupported ' + method);
    },
  };
  const info = { uuid: 'mock-wallet', name: 'Test wallet', icon: '', rdns: 'dev.mock' };
  window.addEventListener('eip6963:requestProvider', () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: { info, provider } })));
})();`

async function bodyOf(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks)
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)

  // ---- real API (Worker code) on SQLite
  if (url.pathname.startsWith('/api/')) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await bodyOf(req)
    const response = await app.fetch(new Request(url, { method: req.method, headers: req.headers, body }), env)
    const headers = Object.fromEntries(response.headers)
    res.writeHead(response.status, headers)
    res.end(Buffer.from(await response.arrayBuffer()))
    return
  }

  // ---- dev-only mock wallet
  if (url.pathname === '/__dev/mock-wallet.js') { res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' }).end(MOCK_WALLET); return }
  if (url.pathname === '/__dev/account') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ address: testAccount(url.searchParams.get('label') || 'default').address }))
    return
  }
  if (url.pathname === '/__dev/sign' && req.method === 'POST') {
    const { hex } = JSON.parse((await bodyOf(req)).toString())
    const message = Buffer.from(hex.slice(2), 'hex').toString('utf8')
    const signature = await testAccount(url.searchParams.get('label') || 'default').signMessage({ message })
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ signature }))
    return
  }

  // ---- static files
  let file = path.join(ROOT, decodeURIComponent(url.pathname))
  if (!file.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found'); return }
    if (path.extname(file) === '.html' && (url.searchParams.has('mockwallet') || /(?:^|; )mw=/.test(req.headers.cookie || ''))) { // dev only: ?mockwallet=label, or an mw=label cookie (used when recording the demo)
      data = Buffer.from(data.toString().replace('</head>', '<script src="/__dev/mock-wallet.js"></script></head>'))
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(data)
  })
}).listen(PORT, () => console.log(`site + API on http://localhost:${PORT} (no-cache, in-memory DB)  ·  add ?mockwallet=lender|borrower to any page to use a test wallet`))
