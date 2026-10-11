// Smoke test against a deployed site, with a throwaway wallet: register, meter, deposit, borrow, switch roles, sign out.
//   node scripts/smoke-live.mjs https://selfpay.ibnweb3lab.workers.dev
// It writes real rows (a user, a meter, a position, a loan). On a database with no real users, wipe them afterwards by
// re-applying schema.sql:  wrangler d1 execute selfpay --remote --file=schema.sql --yes
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const base = (process.argv[2] || 'https://selfpay.ibnweb3lab.workers.dev').replace(/\/$/, '')
const origin = new URL(base).origin
const account = privateKeyToAccount(generatePrivateKey())
const meterNumber = `SMOKE-${Date.now().toString(36).toUpperCase()}`
let cookie = ''
let steps = 0
const ok = (name) => { steps++; console.log('  ok', name) }

async function call(method, path, body, extra = {}) {
  const headers = { origin, ...extra }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (cookie) headers.cookie = cookie
  const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]
  let data = null
  try { data = await res.json() } catch { /* not json */ }
  return { status: res.status, data, headers: res.headers }
}

console.log(`Smoke test: ${base}\n  wallet ${account.address}\n  meter  ${meterNumber}`)

// ---- static site + headers
const signup = await fetch(base + '/signup.html')
assert.equal(signup.status, 200); ok('signup page served')
if (base.startsWith('https://')) { // the local dev server does not apply web/_headers
  assert.equal(signup.headers.get('x-frame-options'), 'SAMEORIGIN'); ok('X-Frame-Options: SAMEORIGIN (the cartoon is framed by our own pages only)')
  assert.equal(signup.headers.get('x-content-type-options'), 'nosniff'); ok('X-Content-Type-Options: nosniff')
}
for (const p of ['/', '/login.html', '/app.html', '/story.html', '/testnet.html', '/home.js', '/join.js', '/site.css', '/app/main.mjs', '/app/borrower.mjs', '/app/lender.mjs', '/src/projections.mjs', '/src/story.js']) {
  assert.equal((await fetch(base + p)).status, 200, p)
}
ok('every page and module is served')

// ---- API basics and security
assert.deepEqual((await call('GET', '/api/health')).data, { ok: true }); ok('health')
assert.equal((await call('GET', '/api/me')).data.user, null); ok('signed out by default')
const pool0 = (await call('GET', '/api/pool')).data
assert.ok(pool0.assetsCents > 0 && pool0.chains.base && pool0.chains.arbitrum && pool0.chains.tempo); ok(`public pool readable (${(pool0.assetsCents / 100).toFixed(2)} USD, 3 chains)`)
assert.equal((await call('POST', '/api/auth/challenge', { address: account.address, mode: 'signup', role: 'lender', name: 'Smoke Test' }, { origin: 'https://evil.example' })).status, 403); ok('cross-origin blocked')
assert.equal((await call('GET', '/api/credit')).status, 401); ok('private routes need a session')

// logging in before registering is refused
const early = await call('POST', '/api/auth/challenge', { address: account.address, mode: 'login', chainId: 84532 })
assert.equal(early.status, 404); ok('login before registering is refused')

// ---- register as a lender
const challenge = await call('POST', '/api/auth/challenge', { address: account.address, mode: 'signup', role: 'lender', name: 'Smoke Test', chainId: 84532 })
assert.equal(challenge.status, 200, JSON.stringify(challenge.data))
assert.ok(challenge.data.message.startsWith(`${new URL(base).host} wants you to sign in`)); ok('challenge issued for this domain')
const signature = await account.signMessage({ message: challenge.data.message })
const verified = await call('POST', '/api/auth/verify', { address: account.address, signature })
assert.equal(verified.status, 200, JSON.stringify(verified.data))
const setCookie = verified.headers.get('set-cookie')
for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax']) assert.ok(setCookie.includes(flag), flag)
ok('registered; cookie is HttpOnly + Secure + SameSite=Lax')
assert.equal((await call('POST', '/api/auth/verify', { address: account.address, signature })).status, 401); ok('signature replay rejected')
const me = (await call('GET', '/api/me')).data
assert.equal(me.user.role, 'lender'); assert.equal(me.user.name, 'Smoke Test'); ok('session recognised as a lender')

// ---- lender: deposit into the shared pool
assert.equal((await call('POST', '/api/meter', { meterNumber })).status, 403); ok('a lender cannot register a meter')
const dep = await call('POST', '/api/pool/deposit', { chain: 'arbitrum', token: 'USDT', amountUsd: 25, lockDays: 7 })
assert.equal(dep.status, 201, JSON.stringify(dep.data))
assert.equal(dep.data.position.locked, true); assert.ok(dep.data.projection.scenarios.expected.earnedCents >= 0); ok('deposited $25 USDT from Arbitrum, locked 7 days')
assert.equal((await call('POST', `/api/positions/${dep.data.position.id}/withdraw`, {})).status, 409); ok('early withdrawal refused (the lock is enforced)')
const positions = (await call('GET', '/api/positions')).data
assert.equal(positions.positions.length, 1); assert.equal(positions.totals.depositedCents, 2500); ok('position listed')

// ---- same wallet adds the borrower role and registers a simulated meter
const added = await call('POST', '/api/roles', { role: 'borrower' })
assert.equal(added.status, 200); assert.deepEqual(added.data.user.roles.sort(), ['borrower', 'lender']); ok('borrower role added to the same wallet')
const reg = await call('POST', '/api/meter', { meterNumber, label: 'Smoke unit' })
assert.equal(reg.status, 201, JSON.stringify(reg.data)); ok('meter registered')
assert.equal((await call('POST', '/api/meter', { meterNumber })).status, 409); ok('second meter refused')
const meter = (await call('GET', '/api/meter')).data
assert.equal(meter.readings.length, 14); assert.ok(meter.stats.avgDailyRevenueCents > 0); ok('simulated meter reports usage')
const credit = (await call('GET', '/api/credit')).data
assert.ok(credit.evaluation.score > 0); assert.ok(credit.evaluation.eligible, JSON.stringify(credit.evaluation.reasons)); ok(`meter valued: score ${credit.evaluation.score} (${credit.evaluation.grade}), 14-day limit ${(credit.available['14'] / 100).toFixed(2)} USD`)

// ---- borrow within the limit; refuse above it
const limit14 = Math.floor(credit.available['14'] / 100)
assert.equal((await call('POST', '/api/loans', { amountUsd: limit14 + 500, days: 14, payoutChain: 'base', payoutToken: 'USDC' })).status, 409); ok('borrowing above the meter limit is refused')
const amount = Math.max(50, Math.min(limit14, 60))
const loan = await call('POST', '/api/loans', { amountUsd: amount, days: 14, payoutChain: 'tempo', payoutToken: 'USD' })
assert.equal(loan.status, 201, JSON.stringify(loan.data))
assert.equal(loan.data.loan.status, 'active'); assert.equal(loan.data.loan.installments.length, 2); ok(`borrowed $${amount} for 14 days, paid out on Tempo`)
assert.equal((await call('POST', '/api/loans', { amountUsd: 50, days: 14, payoutChain: 'base', payoutToken: 'USDC' })).status, 409); ok('only one open loan at a time')
assert.equal((await call('GET', '/api/loans')).data.loans.length, 1); ok('loan listed')
const out = await call('POST', '/api/meter/outage', { days: 2 })
assert.equal(out.status, 200); assert.equal((await call('POST', '/api/meter/restore', {})).status, 200); ok('power cut and restore work')

// ---- role switching and sign-out
assert.equal((await call('POST', '/api/session/role', { role: 'lender' })).data.user.role, 'lender'); ok('switched back to lender without signing again')
const activity = (await call('GET', '/api/activity')).data.activity
assert.ok(activity.length >= 4); ok('activity feed recorded the steps')
assert.equal((await call('POST', '/api/auth/logout', {})).status, 200)
cookie = ''
assert.equal((await call('GET', '/api/credit')).status, 401); ok('signed out')

// ---- logging back in with the same wallet
const again = await call('POST', '/api/auth/challenge', { address: account.address, mode: 'login', chainId: 84532 })
assert.equal(again.status, 200)
const sig2 = await account.signMessage({ message: again.data.message })
assert.equal((await call('POST', '/api/auth/verify', { address: account.address, signature: sig2 })).status, 200); ok('logged back in with the same wallet')
assert.equal((await call('GET', '/api/me')).data.user.name, 'Smoke Test'); ok('account remembered')

console.log(`Live smoke test passed (${steps} steps). Throwaway wallet ${account.address.toLowerCase()}, meter ${meterNumber}.`)
console.log('Wipe the test rows by re-applying schema.sql if the database holds no real users.')
