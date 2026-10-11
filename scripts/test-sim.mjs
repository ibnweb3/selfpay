// Tests the simulation engine: meters, valuation, loan lifecycle, pool shares. Pure; no database.
import assert from 'node:assert/strict'
import { TERMS, SIM, VALUATION } from '../web/src/terms.mjs'
import {
  SimInputError, normalizeMeterNumber, meterProfile, dayUsageWh, revenueFor, isOnline, readingFor, liveReading,
  evaluateCollateral, requiredPaid, scheduleFor, stepLoanDay, poolAssets, sharesForDeposit, valueOfShares,
} from '../worker/sim.mjs'

let checks = 0
const ok = () => { checks++ }
const throwsSim = (fn) => { assert.throws(fn, SimInputError); ok() }

const meterFor = (number, extra = {}) => {
  const n = normalizeMeterNumber(number)
  const p = meterProfile(n)
  return { seed: p.seed, capacity_dkw: p.capacityDkw, tariff_cents: p.tariffCents, outage_from: null, outage_until: null, ...extra }
}

// ---- meter numbers
assert.equal(normalizeMeterNumber('  sp-4821-0937 '), 'SP-4821-0937'); ok()
assert.equal(normalizeMeterNumber('sp 4821 0937'), 'SP48210937'); ok()
for (const bad of ['', 'abc', 'x'.repeat(21), 'SP_4821', '-ABC123', null]) throwsSim(() => normalizeMeterNumber(bad))

// ---- profiles are deterministic and within range, and differ between meters
const a = meterProfile('SP-4821-0937')
assert.deepEqual(meterProfile('SP-4821-0937'), a); ok()
assert.notDeepEqual(meterProfile('SP-0000-0001'), a); ok()
const sizes = new Set()
for (let i = 0; i < 300; i++) {
  const p = meterProfile(`SP-${1000 + i}-${7000 + i * 3}`)
  assert.ok(p.capacityDkw >= 30 && p.capacityDkw <= 150, 'capacity 3 to 15 kW')
  assert.ok(p.tariffCents >= 38 && p.tariffCents <= 62, 'tariff 38 to 62 cents')
  sizes.add(p.capacityDkw)
}
assert.ok(sizes.size > 40, 'meters vary in size'); ok()

// ---- daily usage: deterministic, plausible, with weather variety
const m = meterFor('SP-4821-0937')
assert.equal(dayUsageWh(m.seed, m.capacity_dkw, 10_041), dayUsageWh(m.seed, m.capacity_dkw, 10_041)); ok()
let min = Infinity, max = 0, total = 0, storms = 0
for (let day = 10_000; day < 10_400; day++) {
  const wh = dayUsageWh(m.seed, m.capacity_dkw, day)
  min = Math.min(min, wh); max = Math.max(max, wh); total += wh
  if (wh < (m.capacity_dkw / 10) * 4200 * 0.5) storms++
}
const avgWh = total / 400
assert.ok(avgWh > (m.capacity_dkw / 10) * 4200 * 0.85 && avgWh < (m.capacity_dkw / 10) * 4200 * 1.15, 'long-run average near the unit rating'); ok()
assert.ok(max > min * 1.8, 'sunny days beat stormy days'); ok()
assert.ok(storms > 5 && storms < 60, `some storm days (${storms})`); ok()
assert.equal(revenueFor(10_000, 50), 500); ok() // 10 kWh x 50 cents = $5.00

// ---- outages
const out = { ...m, outage_from: 100, outage_until: 105 }
assert.equal(isOnline(out, 99), true); assert.equal(isOnline(out, 100), false); assert.equal(isOnline(out, 104), false); assert.equal(isOnline(out, 105), true); ok()
assert.deepEqual(readingFor(out, 102), { day: 102, kwhWh: 0, revenueCents: 0, online: false }); ok()
assert.ok(readingFor(out, 105).kwhWh > 0); ok()
const live = liveReading(m, 10_041, 0.5)
assert.equal(live.whSoFar, Math.round(live.expectedWh * 0.5)); assert.ok(live.avgKw > 0); ok()
assert.equal(liveReading(out, 102, 0.5).whSoFar, 0); ok()

// ---- valuation
const history = (meter, from, count) => Array.from({ length: count }, (_, i) => readingFor(meter, from + i))
const good = evaluateCollateral(history(m, 9_990, 28))
assert.equal(good.days, 28); assert.equal(good.eligible, true); assert.deepEqual(good.reasons, []); ok()
assert.ok(good.score >= 70, `a healthy meter scores well (${good.score})`); ok()
assert.ok(good.uptimePct === 100); ok()
assert.ok(good.expectedDailyCents < good.avgDailyCents && good.expectedDailyCents > good.avgDailyCents * 0.7, 'a haircut, not a cliff'); ok()
for (const d of TERMS.borrowerDurations) assert.ok(good.limits[d] > 0)
ok()
assert.ok(good.limits[84] > good.limits[56] && good.limits[56] > good.limits[28] && good.limits[28] > good.limits[14], 'longer terms allow more'); ok()
// limit mirrors the contract rule: total owed <= advance share of expected revenue over the term
for (const d of TERMS.borrowerDurations) {
  const s = scheduleFor(good.limits[d], d)
  assert.ok(s.totalCents <= good.expectedDailyCents * d * (TERMS.advanceBps / 10_000) + 1, `limit for ${d} days is fundable`)
}
ok()
// too little history
const short = evaluateCollateral(history(m, 10_030, 5))
assert.equal(short.eligible, false); assert.match(short.reasons[0], /14 days/); assert.equal(short.limits[28], 0); ok()
assert.equal(evaluateCollateral([]).eligible, false); assert.equal(evaluateCollateral([]).avgDailyCents, 0); ok()
// outages hurt the score and the limit
const flaky = { ...m, outage_from: 9_995, outage_until: 10_005 }
const hurt = evaluateCollateral(history(flaky, 9_990, 28).map((r) => r))
assert.ok(hurt.score < good.score && hurt.uptimePct < 100); ok()
assert.ok(hurt.limits[28] < good.limits[28]); ok()
// mostly offline: not eligible
const dead = { ...m, outage_from: 9_990, outage_until: 10_015 }
const deadEval = evaluateCollateral(history(dead, 9_990, 28))
assert.equal(deadEval.eligible, false); assert.ok(deadEval.reasons.some((r) => /online/.test(r))); ok()
// a bigger unit earns a bigger limit
const big = { ...m, capacity_dkw: 150, tariff_cents: 60 }
const small = { ...m, capacity_dkw: 30, tariff_cents: 40 }
assert.ok(evaluateCollateral(history(big, 9_990, 28)).limits[28] > evaluateCollateral(history(small, 9_990, 28)).limits[28] * 3); ok()

// ---- installment due dates
const sched = scheduleFor(100_000, 28)
assert.equal(requiredPaid(sched.installments, 500, 500), 0); ok()
assert.equal(requiredPaid(sched.installments, 500, 507), sched.installments[0].amountCents); ok()
assert.equal(requiredPaid(sched.installments, 500, 520), sched.installments[1].amountCents + sched.installments[0].amountCents); ok()
assert.equal(requiredPaid(sched.installments, 500, 528), sched.totalCents); ok()

// ---- a single loan day
const freshLoan = (principal = 100_000, days = 28, opened = 500) => {
  const s = scheduleFor(principal, days)
  return { loan: { status: 'active', locked: 0, paid_cents: 0, principal_paid_cents: 0, principal_cents: principal, total_cents: s.totalCents, opened_day: opened, defaulted_day: null, last_day: opened }, installments: s.installments }
}
{
  const { loan, installments } = freshLoan()
  const r = stepLoanDay(loan, installments, 501, 10_000) // $100 revenue
  assert.equal(r.toPool, 7_000); assert.equal(r.toBorrower, 3_000); assert.equal(r.principalPart, 7_000); assert.equal(r.feePart, 0); ok()
  assert.equal(r.loan.paid_cents, 7_000); assert.equal(r.loan.status, 'active'); assert.equal(r.loan.last_day, 501); ok()
  // principal is repaid before the fee, like the vault
  let state = loan
  let fee = 0
  for (let d = 501; d < 560 && state.status === 'active'; d++) { const s = stepLoanDay(state, installments, d, 10_000); state = s.loan; fee += s.feePart }
  assert.equal(state.status, 'repaid'); assert.equal(state.paid_cents, state.total_cents); assert.equal(fee, 3_000); ok()
  // the final payment is capped at what is owed, the rest goes to the borrower
  const last = stepLoanDay({ ...loan, paid_cents: loan.total_cents - 500, principal_paid_cents: loan.principal_cents }, installments, 520, 10_000)
  assert.equal(last.toPool, 500); assert.equal(last.toBorrower, 9_500); assert.equal(last.loan.status, 'repaid'); ok()
  // conservation: every cent of revenue goes to the pool or the borrower
  for (const rev of [0, 1, 99, 10_000, 123_457]) { const x = stepLoanDay(loan, installments, 501, rev); assert.equal(x.toPool + x.toBorrower, rev) }
  ok()
}

// ---- default, lock, cure
{
  const { loan, installments } = freshLoan()
  let state = loan
  const events = []
  // no revenue at all: not in default until installment 1 (day 7) plus the grace period (2 days) has passed
  for (let d = 501; d <= 508; d++) { const r = stepLoanDay(state, installments, d, 0); state = r.loan; events.push(...r.events.map((e) => e.kind)) }
  assert.equal(state.status, 'active'); ok()
  const r9 = stepLoanDay(state, installments, 510, 0) // day 10 after opening: > 7 + 2 grace
  assert.equal(r9.loan.status, 'defaulted'); assert.equal(r9.loan.locked, 1); assert.deepEqual(r9.events.map((e) => e.kind), ['default', 'lock']); ok()
  state = r9.loan
  // in default 100% of revenue goes to the pool
  const pay = stepLoanDay(state, installments, 511, 10_000)
  assert.equal(pay.toPool, 10_000); assert.equal(pay.toBorrower, 0); ok()
  // catching up the arrears cures the default and unlocks
  const arrears = requiredPaid(installments, 500, 511) - state.paid_cents
  const cure = stepLoanDay(state, installments, 511, arrears)
  assert.equal(cure.loan.status, 'active'); assert.equal(cure.loan.locked, 0); assert.deepEqual(cure.events.map((e) => e.kind), ['cure', 'unlock']); ok()
  // a long default is written off, with the loss measured
  let wo = state
  let loss = 0
  for (let d = 511; d < 560 && wo.status === 'defaulted'; d++) { const x = stepLoanDay(wo, installments, d, 0); wo = x.loan; loss += x.loss }
  assert.equal(wo.status, 'written_off'); assert.equal(loss, 100_000); assert.equal(wo.closed_day - state.defaulted_day, SIM.writeOffDelayDays); ok()
}

// ---- a loan sized by the valuation repays on schedule, across many meters (the point of the valuation)
let repaidCount = 0
for (let i = 0; i < 120; i++) {
  const meter = meterFor(`SP-${2000 + i * 7}-${9000 + i * 13}`)
  const evaluation = evaluateCollateral(history(meter, 9_990, 28))
  if (!evaluation.eligible) continue
  for (const days of TERMS.borrowerDurations) {
    const principal = evaluation.limits[days]
    if (!principal) continue
    const s = scheduleFor(principal, days)
    let state = { status: 'active', locked: 0, paid_cents: 0, principal_paid_cents: 0, principal_cents: principal, total_cents: s.totalCents, opened_day: 10_018, defaulted_day: null, last_day: 10_018 }
    let defaulted = false
    for (let d = 10_019; d <= 10_018 + days && state.status !== 'repaid'; d++) {
      const r = stepLoanDay(state, s.installments, d, readingFor(meter, d).revenueCents)
      state = r.loan
      if (state.status === 'defaulted') defaulted = true
    }
    assert.equal(defaulted, false, `meter ${i}, ${days} days: a loan at the limit should never default`)
    assert.equal(state.status, 'repaid', `meter ${i}, ${days} days: should be repaid within the term`)
    repaidCount++
  }
}
assert.ok(repaidCount > 300, `many meters/terms simulated (${repaidCount})`); ok()

// ---- an outage during a loan locks the unit, and restoring the meter cures it
{
  const meter = meterFor('SP-3333-4444', { outage_from: 10_025, outage_until: 10_040 })
  const evaluation = evaluateCollateral(history(meterFor('SP-3333-4444'), 9_990, 28))
  const principal = evaluation.limits[56]
  const s = scheduleFor(principal, 56)
  let state = { status: 'active', locked: 0, paid_cents: 0, principal_paid_cents: 0, principal_cents: principal, total_cents: s.totalCents, opened_day: 10_018, defaulted_day: null, last_day: 10_018 }
  const seen = new Set()
  for (let d = 10_019; d <= 10_018 + 56 + 20; d++) {
    const r = stepLoanDay(state, s.installments, d, readingFor(meter, d).revenueCents)
    state = r.loan
    r.events.forEach((e) => seen.add(e.kind))
    if (state.status === 'repaid' || state.status === 'written_off') break
  }
  assert.ok(seen.has('default') && seen.has('lock'), 'a long outage causes a default and a lock'); ok()
  assert.ok(seen.has('cure') || seen.has('repaid'), 'service resuming recovers the loan'); ok()
  assert.equal(state.status, 'repaid'); ok()
}

// ---- pool shares
const pool = { cash_cents: 500_000, lent_cents: 0, shares_total: 500_000 }
assert.equal(poolAssets(pool), 500_000); ok()
assert.equal(sharesForDeposit(pool, 100_000), 100_000); ok() // 1 share = 1 cent at the start
// fees raise assets without minting shares, so existing shares are worth more and new depositors get fewer
const earned = { ...pool, cash_cents: 505_000 }
assert.equal(valueOfShares(earned, 100_000), 101_000); ok()
assert.equal(sharesForDeposit(earned, 101_000), 100_000); ok()
assert.ok(sharesForDeposit(earned, 100_000) < 100_000); ok()
// lent principal still counts as assets
assert.equal(poolAssets({ cash_cents: 300_000, lent_cents: 200_000, shares_total: 500_000 }), 500_000); ok()
// large values do not lose precision
const huge = { cash_cents: 9_000_000_000_000, lent_cents: 1_000_000_000_000, shares_total: 7_000_000_000_000 }
assert.equal(valueOfShares(huge, 7_000_000_000_000), 10_000_000_000_000); ok()
assert.equal(sharesForDeposit({ cash_cents: 0, lent_cents: 0, shares_total: 0 }, 12_345), 12_345); ok()
assert.equal(VALUATION.seedAddress.length, 42); ok()

console.log(`Simulation engine passed: ${checks} checks (${repaidCount} full loans simulated).`)
