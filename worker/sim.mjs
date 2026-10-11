// The simulation engine: simulated meters, collateral valuation and the loan lifecycle. Pure functions, no I/O,
// so the exact same rules run in tests and in production. Money is integer cents. Days are simulated days.
// Loan rules mirror contracts/RevenueVault: principal repaid first, installments weekly, grace period, lock on default.
import { TERMS, VALUATION, SIM } from '../web/src/terms.mjs'
import { borrowerSchedule, maxLoanForRevenue } from '../web/src/projections.mjs'

export class SimInputError extends Error {}

// ---------------------------------------------------------------- deterministic randomness
export function fnv1a(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

function mix(a, b, c) {
  let x = (a ^ Math.imul(b, 0x9e3779b1) ^ Math.imul(c, 0x85ebca6b)) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}
const rand01 = (seed, day, salt) => mix(seed, day, salt) / 4294967296
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

// ---------------------------------------------------------------- meters
export function normalizeMeterNumber(input) {
  const number = String(input ?? '').trim().toUpperCase().replace(/\s+/g, '')
  if (!/^[A-Z0-9][A-Z0-9-]{5,19}$/.test(number)) throw new SimInputError('Enter a meter number of 6 to 20 letters, digits or dashes, like SP-4821-0937.')
  return number
}

/** Everything about a simulated meter that follows from its number: size of the unit and what customers are billed. */
export function meterProfile(meterNumber) {
  const seed = fnv1a(meterNumber)
  return {
    seed,
    capacityDkw: 30 + (seed % 121), // 3.0 to 15.0 kW, in deci-kilowatts
    tariffCents: 38 + ((seed >>> 8) % 25), // 38 to 62 cents per kWh
  }
}

/** Energy that passed through the meter on a day (watt-hours): sun, weekends and the odd storm. */
export function dayUsageWh(seed, capacityDkw, day) {
  const base = (capacityDkw / 10) * 4200 // 4.2 full-power hours a day
  const weekend = day % 7 >= 5 ? 1.12 : 1
  const weather = 0.7 + 0.6 * rand01(seed, day, 1)
  const storm = rand01(seed, day, 2) < 0.06 ? 0.35 : 1
  return Math.round(base * weekend * weather * storm)
}

export const revenueFor = (wh, tariffCents) => Math.round((wh * tariffCents) / 1000)

export function isOnline(meter, day) {
  return !(meter.outage_from != null && meter.outage_until != null && day >= meter.outage_from && day < meter.outage_until)
}

/** The stored reading for a finished day. */
export function readingFor(meter, day) {
  const online = isOnline(meter, day)
  const kwhWh = online ? dayUsageWh(meter.seed, meter.capacity_dkw, day) : 0
  return { day, kwhWh, revenueCents: revenueFor(kwhWh, meter.tariff_cents), online }
}

/** A live view of the current, unfinished day, for the gauge on the meter page. */
export function liveReading(meter, day, fractionOfDay) {
  const online = isOnline(meter, day)
  const fullWh = online ? dayUsageWh(meter.seed, meter.capacity_dkw, day) : 0
  return {
    day,
    online,
    avgKw: Math.round((fullWh / 24 / 1000) * 100) / 100,
    whSoFar: Math.round(fullWh * fractionOfDay),
    revenueSoFarCents: revenueFor(Math.round(fullWh * fractionOfDay), meter.tariff_cents),
    expectedWh: fullWh,
  }
}

// ---------------------------------------------------------------- collateral valuation
/**
 * How the meter's history becomes a borrowing limit. `readings` are the last days, oldest first.
 *   uptime       share of days the meter was online
 *   consistency  1 - coefficient of variation of revenue on online days (steady earners score higher)
 *   history      how much of the 28-day window we can see
 *   score        0-100 = 45% uptime + 35% consistency + 20% history
 *   reliability  haircut on average revenue, 0.5 to 1.0, rising with the score
 * Limit for a term = expected daily revenue x days x advance share / (1 + fee), exactly as LoanPool.maxPrincipal.
 */
export function evaluateCollateral(readings) {
  const n = readings.length
  const revenues = readings.map((r) => r.revenueCents)
  const avgDailyCents = n ? Math.round(revenues.reduce((a, b) => a + b, 0) / n) : 0
  const onlineRevenues = readings.filter((r) => r.online).map((r) => r.revenueCents)
  const uptime = n ? onlineRevenues.length / n : 0
  const meanOnline = onlineRevenues.length ? onlineRevenues.reduce((a, b) => a + b, 0) / onlineRevenues.length : 0
  const variance = onlineRevenues.length ? onlineRevenues.reduce((s, r) => s + (r - meanOnline) ** 2, 0) / onlineRevenues.length : 0
  const cv = meanOnline > 0 ? Math.sqrt(variance) / meanOnline : 1
  const consistency = clamp(1 - cv, 0, 1)
  const history = Math.min(1, n / VALUATION.historyWindowDays)
  const score = Math.round(100 * (0.45 * uptime + 0.35 * consistency + 0.2 * history))
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D'
  const reliability = Math.round(clamp(0.5 + (0.5 * score) / 100, 0.5, 1) * 1000) / 1000
  const expectedDailyCents = Math.round(avgDailyCents * reliability)

  const reasons = []
  if (n < VALUATION.minHistoryDays) reasons.push(`We need ${VALUATION.minHistoryDays} days of meter history and can see ${n}.`)
  if (n && uptime < VALUATION.minUptime) reasons.push(`The meter was online only ${Math.round(uptime * 100)}% of the time; we need ${Math.round(VALUATION.minUptime * 100)}%.`)
  if (n && score < VALUATION.minScore) reasons.push(`The collateral score is ${score}; we need ${VALUATION.minScore}.`)
  const eligible = reasons.length === 0

  const ceiling = TERMS.maxBorrowUsd * 100
  const limits = {}
  for (const days of TERMS.borrowerDurations) {
    const raw = eligible ? Math.min(ceiling, maxLoanForRevenue(expectedDailyCents, days)) : 0
    limits[days] = raw >= TERMS.minBorrowUsd * 100 ? raw : 0
  }
  return {
    days: n,
    avgDailyCents,
    expectedDailyCents,
    uptimePct: Math.round(uptime * 1000) / 10,
    consistencyPct: Math.round(consistency * 1000) / 10,
    historyPct: Math.round(history * 1000) / 10,
    score,
    grade,
    reliability,
    eligible,
    reasons,
    limits,
  }
}

// ---------------------------------------------------------------- the loan lifecycle
/** What a borrower must have repaid by `atDay`: the installments whose due day has arrived. */
export function requiredPaid(installments, openedDay, atDay) {
  let total = 0
  for (const i of installments) if (openedDay + i.dueDay <= atDay) total += i.amountCents
  return total
}

export const scheduleFor = (principalCents, days) => borrowerSchedule(principalCents, days)

/**
 * One finished day of a loan. `revenueCents` is what the meter billed that day.
 * Returns the updated loan fields, how the money moved, and the events to log. Does not touch the database.
 */
export function stepLoanDay(loan, installments, day, revenueCents) {
  const share = loan.status === 'defaulted' ? 10_000 : TERMS.repayBps
  const remaining = loan.total_cents - loan.paid_cents
  const routed = Math.floor((revenueCents * share) / 10_000)
  const toPool = Math.min(routed, remaining)
  const principalLeft = loan.principal_cents - loan.principal_paid_cents
  const principalPart = Math.min(toPool, principalLeft)
  const feePart = toPool - principalPart

  const next = {
    ...loan,
    paid_cents: loan.paid_cents + toPool,
    principal_paid_cents: loan.principal_paid_cents + principalPart,
    last_day: day,
  }
  const events = []
  let loss = 0

  if (next.paid_cents >= next.total_cents) {
    if (loan.locked) events.push({ kind: 'unlock', text: 'Loan repaid in full. Your unit is unlocked.' })
    next.status = 'repaid'
    next.locked = 0
    next.closed_day = day
    events.push({ kind: 'repaid', text: 'Loan repaid in full. You keep 100% of your revenue again.' })
  } else if (loan.status === 'active') {
    const dueByNow = requiredPaid(installments, loan.opened_day, day - TERMS.graceDays)
    if (day - loan.opened_day > TERMS.graceDays && next.paid_cents < dueByNow) {
      next.status = 'defaulted'
      next.locked = 1
      next.defaulted_day = day
      events.push({ kind: 'default', text: 'An installment is overdue. All revenue now goes to repay the loan.' })
      events.push({ kind: 'lock', text: 'Your unit has received a lock request until you catch up.' })
    }
  } else if (loan.status === 'defaulted') {
    if (next.paid_cents >= requiredPaid(installments, loan.opened_day, day)) {
      next.status = 'active'
      next.locked = 0
      next.defaulted_day = null
      events.push({ kind: 'cure', text: 'You are back on schedule.' })
      events.push({ kind: 'unlock', text: 'Your unit is unlocked.' })
    } else if (day - loan.defaulted_day >= SIM.writeOffDelayDays) {
      next.status = 'written_off'
      next.closed_day = day
      loss = next.principal_cents - next.principal_paid_cents
      events.push({ kind: 'write_off', text: 'The loan was written off after a long default. Lenders absorbed the loss.' })
    }
  }
  return { loan: next, toPool, toBorrower: revenueCents - toPool, principalPart, feePart, loss, events }
}

// ---------------------------------------------------------------- pool shares (BigInt: cents x shares can exceed 2^53)
export const poolAssets = (pool) => pool.cash_cents + pool.lent_cents

const mulDiv = (a, b, c) => Number((BigInt(a) * BigInt(b)) / BigInt(c))

export function sharesForDeposit(pool, amountCents) {
  const assets = poolAssets(pool)
  if (pool.shares_total === 0 || assets === 0) return amountCents
  return Math.max(1, mulDiv(amountCents, pool.shares_total, assets))
}

export function valueOfShares(pool, shares) {
  if (pool.shares_total === 0) return 0
  return mulDiv(shares, poolAssets(pool), pool.shares_total)
}
