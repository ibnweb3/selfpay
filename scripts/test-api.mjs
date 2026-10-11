// End-to-end test of the Worker API: real wallet signatures, real SQLite, injected clock. No network.
// Covers registration/login security, meters, the multi-chain pool, collateral limits and the whole loan lifecycle.
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createApp } from '../worker/index.mjs'
import { createD1 } from './lib/d1-shim.mjs'
import { SIM, TERMS } from '../web/src/terms.mjs'

const ORIGIN = 'https://selfpay.test'
let clock = SIM.epoch + 10_000 * SIM.secondsPerDay + 5 // simulated day 10,000
const advanceDays = (n) => { clock += n * SIM.secondsPerDay }
const app = createApp({ now: () => clock })
const DB = createD1()
const env = { DB, ASSETS: { fetch: async () => new Response('<html>asset</html>', { headers: { 'content-type': 'text/html' } }) } }

let checks = 0
const ok = () => { checks++ }
let ipCounter = 0

async function call(method, path, { body, cookie, origin = ORIGIN, ip, raw } = {}) {
  const headers = { 'cf-connecting-ip': ip ?? `10.0.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}` }
  if (origin !== null) headers.origin = origin
  if (cookie) headers.cookie = cookie
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json'
  const res = await app.fetch(new Request(`${ORIGIN}${path}`, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), env)
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, data, headers: res.headers, text }
}

async function register(account, role, name, opts = {}) {
  const ch = await call('POST', '/api/auth/challenge', { body: { address: account.address, mode: 'signup', role, name, chainId: 84532 }, ip: opts.ip })
  if (ch.status !== 200) return { ch, res: ch }
  const signature = await account.signMessage({ message: ch.data.message })
  const res = await call('POST', '/api/auth/verify', { body: { address: account.address, signature }, ip: opts.ip })
  return { ch, signature, res, cookie: res.headers.get('set-cookie')?.split(';')[0] }
}

async function login(account, opts = {}) {
  const ch = await call('POST', '/api/auth/challenge', { body: { address: account.address, mode: 'login', chainId: 8453 }, ip: opts.ip })
  if (ch.status !== 200) return { ch, res: ch }
  const signature = await account.signMessage({ message: ch.data.message })
  const res = await call('POST', '/api/auth/verify', { body: { address: account.address, signature }, ip: opts.ip })
  return { ch, signature, res, cookie: res.headers.get('set-cookie')?.split(';')[0] }
}

const poolRow = () => DB.raw.prepare('SELECT * FROM pool_state WHERE id = 1').get()
function assertPoolBooks(label) {
  const pool = poolRow()
  const shares = DB.raw.prepare("SELECT COALESCE(SUM(shares), 0) AS s FROM positions WHERE status = 'active'").get().s
  assert.equal(shares, pool.shares_total, `${label}: shares in positions match the pool's share count`)
  const open = DB.raw.prepare("SELECT COALESCE(SUM(principal_cents - principal_paid_cents), 0) AS p FROM loans WHERE status IN ('active', 'defaulted')").get().p
  assert.equal(open, pool.lent_cents, `${label}: lent principal matches open loans`)
  assert.ok(pool.cash_cents >= 0 && pool.lent_cents >= 0, `${label}: no negative balances`)
  checks++
}

const amina = privateKeyToAccount(generatePrivateKey()) // borrower
const bola = privateKeyToAccount(generatePrivateKey()) // lender
const chidi = privateKeyToAccount(generatePrivateKey()) // second borrower
const stranger = privateKeyToAccount(generatePrivateKey())

// ================================================================ static + health
assert.equal((await call('GET', '/index.html')).text, '<html>asset</html>'); ok()
assert.deepEqual((await call('GET', '/api/health')).data, { ok: true }); ok()
assert.equal((await call('GET', '/api/nope')).status, 404); ok()
assert.equal((await call('GET', '/api/me')).data.user, null); ok()

// ================================================================ registration rules
const challenge = (body, extra = {}) => call('POST', '/api/auth/challenge', { body, ...extra })
assert.equal((await challenge({ address: 'nope', mode: 'signup', role: 'lender', name: 'Ann' })).status, 400); ok()
assert.equal((await challenge({ address: amina.address, mode: 'wat' })).status, 400); ok()
assert.equal((await challenge({ address: amina.address, mode: 'signup', role: 'admin', name: 'Amina' })).status, 400); ok()
assert.equal((await challenge({ address: amina.address, mode: 'signup', role: 'borrower', name: 'A' })).status, 400); ok()
assert.equal((await challenge({ address: amina.address, mode: 'signup', role: 'borrower', name: '<script>' })).status, 400); ok()
assert.equal((await challenge({ address: amina.address, mode: 'signup', role: 'borrower' })).status, 400); ok()
assert.equal((await call('POST', '/api/auth/challenge', { raw: '{bad json' })).status, 400); ok()
assert.equal((await call('POST', '/api/auth/challenge', { raw: JSON.stringify({ pad: 'x'.repeat(5000) }) })).status, 413); ok()
// logging in without registering is refused, with a helpful message
const unknown = await login(stranger)
assert.equal(unknown.res.status, 404); assert.match(unknown.res.data.error, /Register first/); ok()

// ---- Amina registers as a borrower
const first = await register(amina, 'borrower', 'Amina Bello')
assert.equal(first.res.status, 200, JSON.stringify(first.res.data)); ok()
assert.match(first.ch.data.message, /^selfpay\.test wants you to sign in with your Ethereum account:\n0x[0-9a-fA-F]{40}\n\nCreate your Selfpay account as a borrower\./); ok()
assert.deepEqual(first.res.data.user.roles, ['borrower']); assert.equal(first.res.data.user.name, 'Amina Bello'); assert.equal(first.res.data.user.role, 'borrower'); ok()
assert.equal(first.res.data.user.address, amina.address); ok()
for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=604800']) assert.ok(first.res.headers.get('set-cookie').includes(flag), flag)
ok()
const aminaCookie = first.cookie
assert.equal((await call('GET', '/api/me', { cookie: aminaCookie })).data.user.name, 'Amina Bello'); ok()
const stored = DB.raw.prepare('SELECT token_hash FROM sessions').all()
assert.ok(!aminaCookie.includes(stored[0].token_hash)); ok() // only a hash is stored
assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1); ok()

// replay / forged / tampered / expired
assert.equal((await call('POST', '/api/auth/verify', { body: { address: amina.address, signature: first.signature } })).status, 401); ok()
const ch2 = await login(amina) // a fresh login works and a stolen signature from another wallet does not
assert.equal(ch2.res.status, 200); ok()
const ch3 = await call('POST', '/api/auth/challenge', { body: { address: amina.address, mode: 'login' } })
const forged = await bola.signMessage({ message: ch3.data.message })
assert.equal((await call('POST', '/api/auth/verify', { body: { address: amina.address, signature: forged } })).status, 401); ok()
const tampered = await amina.signMessage({ message: ch3.data.message.replace('Sign in to Selfpay', 'Sign in to Evil') })
assert.equal((await call('POST', '/api/auth/verify', { body: { address: amina.address, signature: tampered } })).status, 401); ok()
assert.equal((await call('POST', '/api/auth/verify', { body: { address: amina.address, signature: '0x12' } })).status, 400); ok()
const genuine = await amina.signMessage({ message: ch3.data.message })
assert.equal((await call('POST', '/api/auth/verify', { body: { address: amina.address, signature: genuine } })).status, 200); ok()
const staleCh = await call('POST', '/api/auth/challenge', { body: { address: amina.address, mode: 'login' } })
const staleSig = await amina.signMessage({ message: staleCh.data.message })
clock += 601
assert.equal((await call('POST', '/api/auth/verify', { body: { address: amina.address, signature: staleSig } })).status, 401); ok()

// registering twice is refused
assert.equal((await register(amina, 'lender', 'Amina Again')).res.status, 409); ok()

// cross-site requests
assert.equal((await challenge({ address: amina.address, mode: 'login' }, { origin: 'https://evil.example' })).status, 403); ok()
assert.equal((await challenge({ address: amina.address, mode: 'login' }, { origin: null })).status, 403); ok()
assert.equal((await call('POST', '/api/meter', { body: { meterNumber: 'SP-4821-0937' }, cookie: aminaCookie, origin: 'https://evil.example' })).status, 403); ok()

// ================================================================ roles
assert.equal((await call('POST', '/api/session/role', { body: { role: 'lender' }, cookie: aminaCookie })).status, 403); ok() // not joined yet
const both = await call('POST', '/api/roles', { body: { role: 'lender' }, cookie: aminaCookie })
assert.equal(both.status, 200); assert.deepEqual(both.data.user.roles, ['borrower', 'lender']); assert.equal(both.data.user.role, 'lender'); ok()
assert.equal((await call('GET', '/api/me', { cookie: aminaCookie })).data.user.role, 'lender'); ok()
assert.equal((await call('POST', '/api/session/role', { body: { role: 'borrower' }, cookie: aminaCookie })).data.user.role, 'borrower'); ok()
assert.equal((await call('POST', '/api/roles', { body: { role: 'admin' }, cookie: aminaCookie })).status, 400); ok()

// ================================================================ meter
assert.equal((await call('GET', '/api/meter')).status, 401); ok()
assert.equal((await call('GET', '/api/credit', { cookie: aminaCookie })).data.meter, null); ok()
for (const bad of ['', 'abc', 'bad_meter!', 'x'.repeat(30)]) assert.equal((await call('POST', '/api/meter', { body: { meterNumber: bad }, cookie: aminaCookie })).status, 400)
ok()
const registered = await call('POST', '/api/meter', { body: { meterNumber: 'sp-4821-0937', label: "Amina's solar unit" }, cookie: aminaCookie })
assert.equal(registered.status, 201, JSON.stringify(registered.data)); ok()
assert.equal(registered.data.meter.number, 'SP-4821-0937'); assert.equal(registered.data.meter.label, "Amina's solar unit"); assert.equal(registered.data.meter.online, true); ok()
assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM meter_readings').get().n, 30); ok() // 30 days of history already available
assert.equal((await call('POST', '/api/meter', { body: { meterNumber: 'SP-9999-0001' }, cookie: aminaCookie })).status, 409); ok() // one meter per account

// another account cannot take the same meter number; lenders cannot register meters
const chidiReg = await register(chidi, 'borrower', 'Chidi Okafor')
assert.equal(chidiReg.res.status, 200); ok()
const dup = await call('POST', '/api/meter', { body: { meterNumber: 'SP-4821-0937' }, cookie: chidiReg.cookie })
assert.equal(dup.status, 409); assert.match(dup.data.error, /already registered/); ok()
const bolaReg = await register(bola, 'lender', 'Bola Adeyemi')
assert.equal(bolaReg.res.status, 200); ok()
assert.equal((await call('POST', '/api/meter', { body: { meterNumber: 'SP-1111-2222' }, cookie: bolaReg.cookie })).status, 403); ok()

// the meter page: usage, live reading, history, stats
const meterPage = await call('GET', '/api/meter', { cookie: aminaCookie })
assert.equal(meterPage.status, 200); ok()
assert.equal(meterPage.data.readings.length, 14); assert.ok(meterPage.data.readings.every((r) => r.kwhWh > 0 && r.revenueCents > 0 && r.online)); ok()
assert.ok(meterPage.data.live.avgKw > 0 && meterPage.data.live.online); assert.equal(meterPage.data.stats.uptimePct, 100); ok()
assert.equal(meterPage.data.secondsPerDay, 60); ok()

// ================================================================ the pool (public view first)
const pool0 = await call('GET', '/api/pool')
assert.equal(pool0.status, 200); assert.equal(pool0.data.assetsCents, 500_000); assert.equal(pool0.data.cashCents, 500_000); assert.equal(pool0.data.lentCents, 0); ok()
assert.deepEqual(Object.keys(pool0.data.chains).sort(), ['arbitrum', 'base', 'tempo']); assert.equal(pool0.data.chains.base.depositedCents, 200_000); ok()
assert.equal(pool0.data.you, undefined); ok()
assertPoolBooks('start')

// ================================================================ lender deposits
const dep = (body, cookie = bolaReg.cookie) => call('POST', '/api/pool/deposit', { body, cookie })
assert.equal((await dep({ chain: 'ethereum', token: 'USDC', amountUsd: 100, lockDays: 30 })).status, 400); ok()
assert.equal((await dep({ chain: 'base', token: 'DAI', amountUsd: 100, lockDays: 30 })).status, 400); ok()
assert.equal((await dep({ chain: 'base', token: 'USDC', amountUsd: 5, lockDays: 30 })).status, 400); ok() // below $10
assert.equal((await dep({ chain: 'base', token: 'USDC', amountUsd: 100, lockDays: 45 })).status, 400); ok() // not an offered lock
assert.equal((await dep({ chain: 'base', token: 'USDC', amountUsd: 10.123, lockDays: 30 })).status, 400); ok()
assert.equal((await dep({ chain: 'base', token: 'USDC', amountUsd: '100', lockDays: 30 })).status, 400); ok()
assert.equal((await dep({ chain: 'base', token: 'USDC', amountUsd: 100, lockDays: 30 }, aminaCookie)).status, 403); ok() // borrowers cannot deposit
assert.equal((await dep({ chain: 'base', token: 'USDC', amountUsd: 100, lockDays: 30 }, '')).status, 401); ok()

const d1 = await dep({ chain: 'base', token: 'USDC', amountUsd: 1000, lockDays: 30 })
assert.equal(d1.status, 201, JSON.stringify(d1.data)); ok()
assert.equal(d1.data.position.valueCents, 100_000); assert.equal(d1.data.position.locked, true); assert.equal(d1.data.position.daysLeft, 30); ok()
assert.ok(d1.data.projection.scenarios.expected.earnedCents > 0); ok()
const d2 = await dep({ chain: 'tempo', token: 'USD', amountUsd: 250.5, lockDays: 7 })
assert.equal(d2.status, 201); ok()
const d3 = await dep({ chain: 'arbitrum', token: 'USDT', amountUsd: 400, lockDays: 90 })
assert.equal(d3.status, 201); ok()
const pool1 = (await call('GET', '/api/pool', { cookie: bolaReg.cookie })).data
assert.equal(pool1.assetsCents, 500_000 + 100_000 + 25_050 + 40_000); assert.equal(pool1.cashCents, pool1.assetsCents); ok()
assert.equal(pool1.chains.tempo.depositedCents, 150_000 + 25_050); assert.equal(pool1.chains.arbitrum.tokens.USDT, 40_000); assert.equal(pool1.lenders, 1); ok()
assert.equal(pool1.you.positions, 3); assert.equal(pool1.you.valueCents, 165_050); ok()
assertPoolBooks('after deposits')

// early withdrawal is refused while locked
const early = await call('POST', `/api/positions/${d1.data.position.id}/withdraw`, { body: {}, cookie: bolaReg.cookie })
assert.equal(early.status, 409); assert.match(early.data.error, /Locked for 30 more days/); ok()
assert.equal((await call('POST', `/api/positions/${d1.data.position.id}/withdraw`, { body: {}, cookie: aminaCookie })).status, 403); ok()
const listed = await call('GET', '/api/positions', { cookie: bolaReg.cookie })
assert.equal(listed.data.positions.length, 3); assert.equal(listed.data.totals.depositedCents, 165_050); ok()

// ================================================================ collateral valuation and borrowing
const cr = await call('GET', '/api/credit', { cookie: aminaCookie })
assert.equal(cr.status, 200); assert.equal(cr.data.evaluation.eligible, true); assert.equal(cr.data.evaluation.days, 28); ok()
assert.ok(cr.data.evaluation.score >= 60); assert.ok(cr.data.evaluation.limits[28] >= 5_000); assert.ok(cr.data.evaluation.limits[84] > cr.data.evaluation.limits[28]); ok()
assert.equal((await call('GET', '/api/credit', { cookie: bolaReg.cookie })).status, 403); ok() // lenders do not borrow
const limit28 = cr.data.evaluation.limits[28]
const borrow = (body, cookie = aminaCookie) => call('POST', '/api/loans', { body: { payoutChain: 'base', payoutToken: 'USDC', ...body }, cookie })
assert.equal((await borrow({ amountUsd: (limit28 + 100) / 100, days: 28 })).status, 409); ok() // over the limit
assert.equal((await borrow({ amountUsd: 10, days: 28 })).status, 400); ok() // below $50
assert.equal((await borrow({ amountUsd: 100, days: 30 })).status, 400); ok()
assert.equal((await borrow({ amountUsd: 100, days: 28, payoutChain: 'solana' })).status, 400); ok()
assert.equal((await borrow({ amountUsd: 100, days: 28, payoutToken: 'DAI' })).status, 400); ok()
assert.equal((await borrow({ amountUsd: 100, days: 28 }, bolaReg.cookie)).status, 403); ok()
assert.equal((await borrow({ amountUsd: 100, days: 28 }, chidiReg.cookie)).status, 409); ok() // no meter yet
assertPoolBooks('after refused loans')

const principalUsd = Math.floor(limit28 / 100) // whole dollars at the limit
const loan1 = await borrow({ amountUsd: principalUsd, days: 28, payoutChain: 'arbitrum', payoutToken: 'USDT' })
assert.equal(loan1.status, 201, JSON.stringify(loan1.data)); ok()
assert.equal(loan1.data.loan.principalCents, principalUsd * 100); assert.equal(loan1.data.loan.feeCents, Math.round(principalUsd * 100 * 0.03)); ok()
assert.equal(loan1.data.loan.installments.length, 4); assert.equal(loan1.data.loan.status, 'active'); assert.equal(loan1.data.loan.payoutChain, 'arbitrum'); ok()
const pool2 = poolRow()
assert.equal(pool2.lent_cents, principalUsd * 100); assert.equal(pool2.cash_cents + pool2.lent_cents, 665_050); ok() // assets unchanged by lending
assert.equal((await borrow({ amountUsd: 50, days: 14 })).status, 409); ok() // one open loan at a time
assertPoolBooks('after loan opened')

// ================================================================ repayments flow from meter revenue
const lenderBefore = (await call('GET', '/api/positions', { cookie: bolaReg.cookie })).data.totals
advanceDays(3)
let loans = (await call('GET', '/api/loans', { cookie: aminaCookie })).data.loans
assert.ok(loans[0].paidCents > 0, 'revenue is repaying the loan'); assert.equal(loans[0].status, 'active'); ok()
assert.equal(loans[0].payments.length, 2, 'two finished days since opening'); ok() // opened at the start of day N; days N+1, N+2 are finished
const p1 = loans[0].payments[0]
assert.equal(p1.toPoolCents, Math.floor(p1.revenueCents * 0.7)); assert.equal(p1.toPoolCents + p1.toBorrowerCents, p1.revenueCents); ok()
assertPoolBooks('after 3 days')
advanceDays(40)
loans = (await call('GET', '/api/loans', { cookie: aminaCookie })).data.loans
assert.equal(loans[0].status, 'repaid', JSON.stringify(loans[0])); assert.equal(loans[0].paidCents, loans[0].totalCents); assert.equal(loans[0].locked, false); ok()
assertPoolBooks('after repayment')
const pool3 = poolRow()
assert.equal(pool3.fees_cents, loans[0].feeCents); assert.equal(pool3.lent_cents, 0); assert.equal(pool3.cash_cents, 665_050 + loans[0].feeCents); ok()
// the lender earned a pro-rata share of the fee (their shares / all shares), and nothing was lost
const lenderAfter = (await call('GET', '/api/positions', { cookie: bolaReg.cookie })).data.totals
const expectedGain = (loans[0].feeCents * 165_050) / 665_050
assert.ok(lenderAfter.earnedCents > lenderBefore.earnedCents); assert.ok(Math.abs(lenderAfter.earnedCents - expectedGain) <= 2, `gain ${lenderAfter.earnedCents} vs ${expectedGain}`); ok()
// the borrower kept the rest of the revenue
const meterAfter = await call('GET', '/api/meter', { cookie: aminaCookie })
assert.ok(meterAfter.data.meter.earnedCents > 0); ok()
// activity records the loan story
const act = (await call('GET', '/api/activity', { cookie: aminaCookie })).data.activity
assert.ok(act.some((a) => a.kind === 'loan') && act.some((a) => a.kind === 'repaid') && act.some((a) => a.kind === 'meter') && act.some((a) => a.kind === 'welcome')); ok()

// ---- withdrawal after the lock ends
const wd = await call('POST', `/api/positions/${d1.data.position.id}/withdraw`, { body: {}, cookie: bolaReg.cookie })
assert.equal(wd.status, 200, JSON.stringify(wd.data)); assert.ok(wd.data.valueCents > 100_000); assert.equal(wd.data.earnedCents, wd.data.valueCents - 100_000); ok()
assert.equal((await call('POST', `/api/positions/${d1.data.position.id}/withdraw`, { body: {}, cookie: bolaReg.cookie })).status, 409); ok()
assertPoolBooks('after withdrawal')
// the 90-day position is still locked
assert.equal((await call('POST', `/api/positions/${d3.data.position.id}/withdraw`, { body: {}, cookie: bolaReg.cookie })).status, 409); ok()
// the starter liquidity belongs to nobody who can withdraw it
assert.equal(DB.raw.prepare('SELECT COUNT(*) AS n FROM positions WHERE is_seed = 1').get().n, 3); ok()

// ================================================================ an outage causes a default and a lock; restoring cures it
const credit2 = (await call('GET', '/api/credit', { cookie: aminaCookie })).data
const second = await borrow({ amountUsd: Math.floor(credit2.evaluation.limits[56] / 100), days: 56 })
assert.equal(second.status, 201, JSON.stringify(second.data)); ok()
assert.equal((await call('POST', '/api/meter/outage', { body: { days: 0 }, cookie: aminaCookie })).status, 400); ok()
assert.equal((await call('POST', '/api/meter/outage', { body: { days: 20 }, cookie: aminaCookie })).status, 400); ok()
assert.equal((await call('POST', '/api/meter/outage', { body: { days: 12 }, cookie: bolaReg.cookie })).status, 403); ok()
assert.equal((await call('POST', '/api/meter/outage', { body: { days: 12 }, cookie: aminaCookie })).status, 200); ok()
assert.equal((await call('GET', '/api/meter', { cookie: aminaCookie })).data.meter.online, false); ok()
advanceDays(11)
loans = (await call('GET', '/api/loans', { cookie: aminaCookie })).data.loans
assert.equal(loans[0].status, 'defaulted'); assert.equal(loans[0].locked, true); assert.ok(loans[0].installments.some((i) => i.state === 'overdue')); ok()
let act2 = (await call('GET', '/api/activity', { cookie: aminaCookie })).data.activity
assert.ok(act2.some((a) => a.kind === 'default') && act2.some((a) => a.kind === 'lock')); ok()
assertPoolBooks('in default')
// the outage ends by itself; in default all revenue goes to the pool until the arrears are cleared
advanceDays(2)
assert.equal((await call('GET', '/api/meter', { cookie: aminaCookie })).data.meter.online, true); ok()
const paidDuringDefault = DB.raw.prepare('SELECT * FROM loan_payments WHERE loan_id = ? ORDER BY day DESC LIMIT 1').get(second.data.loan.id)
assert.equal(paidDuringDefault.to_borrower_cents, 0); assert.equal(paidDuringDefault.to_pool_cents, paidDuringDefault.revenue_cents); ok()
advanceDays(45)
loans = (await call('GET', '/api/loans', { cookie: aminaCookie })).data.loans
assert.equal(loans[0].status, 'repaid'); assert.equal(loans[0].locked, false); ok()
act2 = (await call('GET', '/api/activity', { cookie: aminaCookie })).data.activity
assert.ok(act2.some((a) => a.kind === 'cure' || a.kind === 'repaid') && act2.some((a) => a.kind === 'unlock')); ok()
assertPoolBooks('after cure')

// ================================================================ a long default is written off and lenders absorb the loss
const chidiMeter = await call('POST', '/api/meter', { body: { meterNumber: 'SP-7777-3141' }, cookie: chidiReg.cookie })
assert.equal(chidiMeter.status, 201); ok()
const chidiCredit = (await call('GET', '/api/credit', { cookie: chidiReg.cookie })).data
const chidiLoan = await borrow({ amountUsd: Math.floor(chidiCredit.evaluation.limits[84] / 100), days: 84 }, chidiReg.cookie)
assert.equal(chidiLoan.status, 201); ok()
const assetsBefore = poolRow().cash_cents + poolRow().lent_cents
const principalAtRisk = chidiLoan.data.loan.principalCents
for (let i = 0; i < 6; i++) {
  await call('POST', '/api/meter/outage', { body: { days: 14 }, cookie: chidiReg.cookie })
  advanceDays(14)
  await call('GET', '/api/loans', { cookie: chidiReg.cookie })
}
const written = (await call('GET', '/api/loans', { cookie: chidiReg.cookie })).data.loans[0]
assert.equal(written.status, 'written_off', JSON.stringify(written)); ok()
const poolEnd = poolRow()
assert.equal(poolEnd.written_off_cents, principalAtRisk - 0); assert.equal(poolEnd.lent_cents, 0); ok()
assert.equal(poolEnd.cash_cents + poolEnd.lent_cents, assetsBefore - principalAtRisk); ok()
assertPoolBooks('after write-off')
// after a write-off the borrower can ask again once the meter works (new loan allowed)
await call('POST', '/api/meter/restore', { body: {}, cookie: chidiReg.cookie })

// ================================================================ concurrency: a held lock makes accrual skip, nothing is applied twice
{
  const { accrue } = await import('../worker/accrual.mjs')
  advanceDays(5)
  DB.raw.prepare("INSERT INTO locks (name, until) VALUES ('sim', ?) ON CONFLICT(name) DO UPDATE SET until = excluded.until").run(clock + 10)
  const skipped = await accrue(env, clock)
  assert.equal(skipped.skipped, true); ok()
  DB.raw.prepare("UPDATE locks SET until = 0 WHERE name = 'sim'").run()
  const ran = await accrue(env, clock)
  assert.equal(ran.skipped, false); const again = await accrue(env, clock)
  assert.equal(again.steps, 0, 'a second run finds nothing left to apply'); ok()
  const dupes = DB.raw.prepare('SELECT COUNT(*) AS n FROM (SELECT meter_id, day FROM meter_readings GROUP BY meter_id, day HAVING COUNT(*) > 1)').get().n
  assert.equal(dupes, 0); ok()
}

// ================================================================ sessions end; sign out; rate limits
assert.equal((await call('POST', '/api/auth/logout', { cookie: aminaCookie, origin: 'https://evil.example' })).status, 403); ok()
const out = await call('POST', '/api/auth/logout', { cookie: aminaCookie })
assert.equal(out.status, 200); assert.ok(out.headers.get('set-cookie').includes('Max-Age=0')); ok()
assert.equal((await call('GET', '/api/me', { cookie: aminaCookie })).data.user, null); ok()
assert.equal((await call('GET', '/api/me', { cookie: 'selfpay_session=' + 'a'.repeat(64) })).data.user, null); ok()
assert.equal((await call('GET', '/api/me', { cookie: "selfpay_session=' OR 1=1 --" })).data.user, null); ok()
const relog = await login(amina)
assert.equal(relog.res.status, 200); assert.equal(relog.res.data.user.role, 'borrower', 'login resumes the role used last'); ok()
clock += 8 * 24 * 3600
assert.equal((await call('GET', '/api/me', { cookie: relog.cookie })).data.user, null); ok() // sessions expire after 7 days

for (let i = 0; i < 20; i++) await call('POST', '/api/auth/challenge', { body: { address: bola.address, mode: 'login' }, ip: '192.0.2.200' })
assert.equal((await call('POST', '/api/auth/challenge', { body: { address: bola.address, mode: 'login' }, ip: '192.0.2.200' })).status, 429); ok()
assert.equal((await call('POST', '/api/auth/challenge', { body: { address: bola.address, mode: 'login' }, ip: '192.0.2.201' })).status, 200); ok()
clock += 61
assert.equal((await call('POST', '/api/auth/challenge', { body: { address: bola.address, mode: 'login' }, ip: '192.0.2.200' })).status, 200); ok()

console.log(`API passed: ${checks} checks.`)
