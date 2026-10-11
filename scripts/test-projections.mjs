// Checks the projection maths against hand-computed values and against the deployed contract parameters.
// Hand-computed values below are for the current terms: fee 3% per 28 days, 70% lender share, 50% advance.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { TERMS } from '../web/src/terms.mjs'
import { lenderProjection, lenderTable, borrowerSchedule, borrowerTable, maxLoanForRevenue, onTrack, breakEvenDefaultRate, InputError } from '../web/src/projections.mjs'

let checks = 0
const ok = () => { checks++ }
const throwsInput = (fn) => { assert.throws(fn, InputError); ok() }
const closeTo = (actual, expected, tolerance = 0.011) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`)
const fee = TERMS.feeBps / 10_000

// ---- the terms themselves are sane
assert.equal(TERMS.feeBps, 300); ok()
assert.equal(TERMS.repayBps, 7000); ok()
for (const s of Object.values(TERMS.scenarios)) {
  const net = fee * (1 - s.defaultRate) - s.defaultRate * (1 - s.recovery)
  assert.ok(net > 0, `${s.label} must be profitable at its own assumptions`)
}
ok()

// ---- lender: $1,000 for 30 days.
// expected: net = 0.03*0.99 - 0.01*0.60 = 0.0237 per 28 days ; x 0.55 lent out ; x (30/28) => 1.3966% => $13.97
const p30 = lenderProjection(100_000, 30)
assert.equal(p30.scenarios.expected.earnedCents, 1397); ok()
closeTo(p30.scenarios.cautious.netPerCyclePct, 1.54); ok() // 0.03*0.98 - 0.02*0.70
closeTo(p30.scenarios.expected.netPerCyclePct, 2.37); ok()
closeTo(p30.scenarios.strong.netPerCyclePct, 2.735); ok() // 0.03*0.995 - 0.005*0.50
// yearly rate in the expected case: 0.55 * 0.0237 * (365/28) = 16.99%
closeTo(p30.scenarios.expected.aprPct, 16.99); ok()
closeTo(p30.scenarios.cautious.aprPct, 7.03); ok()
closeTo(p30.scenarios.strong.aprPct, 26.74); ok()
// ordering: strong > expected > cautious, and longer periods earn more
const t = lenderTable(100_000)
assert.equal(t.length, 5); ok()
for (const row of t) assert.ok(row.scenarios.strong.earnedCents > row.scenarios.expected.earnedCents && row.scenarios.expected.earnedCents > row.scenarios.cautious.earnedCents)
ok()
for (let i = 1; i < t.length; i++) assert.ok(t[i].scenarios.expected.earnedCents > t[i - 1].scenarios.expected.earnedCents)
ok()
// the longest lock (90 days) in the expected case: 0.55 lent x 2.37% per 28 days x 90/28
closeTo(t[4].scenarios.expected.returnPct, (90 / 28) * 0.55 * 0.0237 * 100, 0.02); ok()
// scales linearly with amount
assert.ok(Math.abs(lenderProjection(200_000, 90).scenarios.expected.earnedCents - 2 * lenderProjection(100_000, 90).scenarios.expected.earnedCents) <= 1); ok()
// total = principal + earned, never negative earnings in these scenarios
for (const s of Object.values(p30.scenarios)) { assert.equal(s.totalCents, 100_000 + s.earnedCents); assert.ok(s.earnedCents > 0) }
ok()
// break-even default rate: fee/(fee+1-recovery) = 0.03/(0.03+0.6) = 4.76%
assert.equal(breakEvenDefaultRate(0.4), 4.76); ok()
// every scenario's default assumption sits well below its own break-even
for (const s of Object.values(TERMS.scenarios)) assert.ok(s.defaultRate * 100 < breakEvenDefaultRate(s.recovery))
ok()

// ---- lender input validation
throwsInput(() => lenderProjection(999, 30)) // below $10
throwsInput(() => lenderProjection(100_000_001, 30))
throwsInput(() => lenderProjection(100_000, 45)) // not an offered lock period
throwsInput(() => lenderProjection(10.5, 30)) // fractional cents
throwsInput(() => lenderProjection(NaN, 30))

// ---- borrower: $1,000 over 28 days matches the contracts: $1,030 owed, 4 x $257.50
const b28 = borrowerSchedule(100_000, 28)
assert.equal(b28.feeCents, 3_000); ok()
assert.equal(b28.totalCents, 103_000); ok()
assert.equal(b28.periods, 4); ok()
assert.deepEqual(b28.installments.map((i) => i.amountCents), [25_750, 25_750, 25_750, 25_750]); ok()
assert.deepEqual(b28.installments.map((i) => i.dueDay), [7, 14, 21, 28]); ok()
assert.equal(b28.effectiveAprPct, 39.11); ok() // 3% per 28 days, simple annualised
// daily revenue needed: 1030 / 28 / 0.70 = 52.55 -> 5,256 cents (rounded up)
assert.equal(b28.dailyRevenueNeededCents, 5_256); ok()
// installments always add up exactly, for awkward amounts too
for (const principal of [5_001, 12_345, 99_999, 1_000_007]) for (const days of TERMS.borrowerDurations) {
  const s = borrowerSchedule(principal, days)
  assert.equal(s.installments.reduce((sum, i) => sum + i.amountCents, 0), s.totalCents)
  assert.equal(s.totalCents, principal + s.feeCents)
}
ok()
// longer duration -> higher fee (pro rata), more installments, smaller installments
const bt = borrowerTable(100_000)
assert.deepEqual(bt.map((r) => r.feeCents), [1_500, 3_000, 6_000, 9_000]); ok()
assert.deepEqual(bt.map((r) => r.periods), [2, 4, 8, 12]); ok()
assert.ok(bt[3].installments[0].amountCents < bt[0].installments[0].amountCents); ok()

// ---- max loan from revenue mirrors LoanPool.maxPrincipal: $60/day over 28d -> owed <= 50% x 1680 = 840 -> principal 840/1.03
assert.equal(maxLoanForRevenue(6_000, 28), Math.floor((6_000 * 28 * 0.5) / (1 + fee))); ok()
assert.equal(maxLoanForRevenue(6_000, 28), 81_553); ok()
// and a loan at that ceiling must be fundable: its total owed <= advance share of expected revenue
{
  const max = maxLoanForRevenue(6_000, 28)
  assert.ok(max * (1 + fee) <= 6_000 * 28 * 0.5 + 1); ok()
}

// ---- on track / not on track ($60/day x 70% = $42/day -> 1030/42 = 24.5 days)
assert.equal(onTrack(100_000, 28, 6_000).onTrack, true); ok()
assert.equal(onTrack(100_000, 28, 6_000).daysToRepay, 25); ok()
assert.equal(onTrack(100_000, 28, 3_000).onTrack, false); ok()
assert.equal(onTrack(100_000, 28, 0).daysToRepay, null); ok()

// ---- borrower input validation
throwsInput(() => borrowerSchedule(4_999, 28)) // below $50
throwsInput(() => borrowerSchedule(100_000, 30)) // not an offered duration
throwsInput(() => borrowerSchedule(1.5, 28))

// ---- the terms must match the contracts deployed on the test networks, and the page copy must not hard-code them
const deploy = fs.readFileSync('script/Deploy.s.sol', 'utf8')
assert.match(deploy, new RegExp(`feeBps:\\s*${TERMS.feeBps}\\b`)); ok()
assert.match(deploy, new RegExp(`advanceBps:\\s*${TERMS.advanceBps}\\b`)); ok()
assert.match(deploy, new RegExp(`repayBps:\\s*${TERMS.repayBps}\\b`)); ok()
assert.match(deploy, /periods:\s*4\b/); ok()
// the landing page quotes the fee, the APR and the advance rate in words: they must match the terms
const landing = fs.readFileSync('web/index.html', 'utf8')
assert.ok(landing.includes(`${TERMS.feeBps / 100}% fee on a ${TERMS.baseTermDays}-day loan`), 'landing quotes the fee'); ok()
assert.ok(landing.includes(`about ${Math.round(borrowerSchedule(10_000, TERMS.baseTermDays).effectiveAprPct)}% a year`), 'landing quotes the APR'); ok()
assert.ok(landing.includes(`${TERMS.repayBps / 100}%`) || !/70%/.test(landing), 'landing repay share matches'); ok()
assert.ok(!/10% (fee|of the loan)/.test(landing), 'landing has no stale 10% fee'); ok()


console.log(`Projections passed: ${checks} checks.`)
