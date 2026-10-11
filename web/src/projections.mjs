// Pure projection maths shared by the browser and the Worker. Money is integer cents; rates are plain numbers.
// Nothing here moves money: these are illustrations built from the stated assumptions in terms.mjs.
import { TERMS, feeRateFor } from './terms.mjs'

const usdToCents = (usd) => Math.round(usd * 100)

export class InputError extends Error {}

function cents(value, { min, max, label }) {
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new InputError(`${label} must be a whole number of cents.`)
  if (value < min || value > max) throw new InputError(`${label} must be between $${(min / 100).toLocaleString('en-US')} and $${(max / 100).toLocaleString('en-US')}.`)
  return value
}

// ---------------------------------------------------------------- lender

/**
 * Net result per $1 lent over one 28-day cycle:
 *   income = fee x (1 - default)         fees are only earned on loans that do not default
 *   loss   = default x (1 - recovery)    unrecovered share of defaulted principal
 * Earnings over `days` = amount x utilisation x net x (days / 28). Simple (not compounded).
 */
export function lenderScenario(amountCents, days, scenario) {
  const fee = TERMS.feeBps / 10_000
  const { utilisation, defaultRate, recovery } = scenario
  const netPerCycle = fee * (1 - defaultRate) - defaultRate * (1 - recovery)
  const cycles = days / TERMS.baseTermDays
  const earnedCents = Math.round(amountCents * utilisation * netPerCycle * cycles)
  return {
    earnedCents,
    totalCents: amountCents + earnedCents,
    returnPct: round2((earnedCents / amountCents) * 100),
    aprPct: round2(utilisation * netPerCycle * (365 / TERMS.baseTermDays) * 100),
    netPerCyclePct: round2(netPerCycle * 100),
  }
}

/** Default rate at which a scenario stops earning anything (all else equal). */
export function breakEvenDefaultRate(recovery) {
  const fee = TERMS.feeBps / 10_000
  return round2((fee / (fee + 1 - recovery)) * 100)
}

export function lenderProjection(amountCents, days) {
  cents(amountCents, { min: TERMS.minLendUsd * 100, max: TERMS.maxLendUsd * 100, label: 'Amount' })
  if (!TERMS.lenderHorizons.includes(days)) throw new InputError(`Lock period must be one of ${TERMS.lenderHorizons.join(', ')} days.`)
  const scenarios = {}
  for (const [key, scenario] of Object.entries(TERMS.scenarios)) scenarios[key] = { ...lenderScenario(amountCents, days, scenario), label: scenario.label }
  return { amountCents, days, scenarios }
}

/** Every lock period side by side, for the comparison table. */
export function lenderTable(amountCents) {
  return TERMS.lenderHorizons.map((days) => lenderProjection(amountCents, days))
}

// ---------------------------------------------------------------- borrower

/**
 * Repayment schedule. Fee = principal x fee rate x (days / 28), so a 28-day loan matches the contracts exactly.
 * Installments are equal, with any leftover cents on the last one. The vault sends `repayBps` of each customer
 * payment to the lender, so the device must collect total / (days x repayShare) per day to stay on schedule.
 */
export function borrowerSchedule(principalCents, days) {
  cents(principalCents, { min: TERMS.minBorrowUsd * 100, max: TERMS.maxBorrowUsd * 100, label: 'Amount' })
  if (!TERMS.borrowerDurations.includes(days)) throw new InputError(`Duration must be one of ${TERMS.borrowerDurations.join(', ')} days.`)
  const periods = days / TERMS.periodDays
  const feeCents = Math.round(principalCents * feeRateFor(days))
  const totalCents = principalCents + feeCents
  const base = Math.floor(totalCents / periods)
  const installments = Array.from({ length: periods }, (_, i) => ({
    number: i + 1,
    dueDay: (i + 1) * TERMS.periodDays,
    amountCents: i === periods - 1 ? totalCents - base * (periods - 1) : base,
  }))
  const repayShare = TERMS.repayBps / 10_000
  return {
    principalCents,
    days,
    periods,
    feeCents,
    totalCents,
    installments,
    effectiveAprPct: round2((feeCents / principalCents) * (365 / days) * 100),
    dailyRevenueNeededCents: Math.ceil(totalCents / days / repayShare),
  }
}

export function borrowerTable(principalCents) {
  return TERMS.borrowerDurations.map((days) => borrowerSchedule(principalCents, days))
}

/** The most a device could borrow for `days`, given what it collects per day (same rule as LoanPool.maxPrincipal). */
export function maxLoanForRevenue(dailyRevenueCents, days) {
  const expectedTermRevenue = dailyRevenueCents * days
  const maxOwed = (expectedTermRevenue * TERMS.advanceBps) / 10_000
  return Math.floor(maxOwed / (1 + feeRateFor(days)))
}

/** Will this daily revenue clear the loan inside the term? */
export function onTrack(principalCents, days, dailyRevenueCents) {
  const { totalCents } = borrowerSchedule(principalCents, days)
  const perDayToLender = (dailyRevenueCents * TERMS.repayBps) / 10_000
  const daysToRepay = perDayToLender > 0 ? totalCents / perDayToLender : Infinity
  return { daysToRepay: Number.isFinite(daysToRepay) ? Math.ceil(daysToRepay) : null, onTrack: daysToRepay <= days }
}

// ---------------------------------------------------------------- helpers

function round2(n) {
  return Math.round(n * 100) / 100
}

export { usdToCents }
