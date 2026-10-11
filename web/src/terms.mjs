// Single source of truth for protocol terms used by projections, the API and the UI.
// The numbers mirror the LoanPool parameters on the test networks (see script/Deploy.s.sol and
// scripts/test-projections.mjs, which checks they still agree). Change them in ONE place.
export const TERMS = {
  /** Flat fee on principal for a loan over `baseTermDays`. Other durations are priced pro rata. */
  feeBps: 300,
  baseTermDays: 28,
  /** One installment every `periodDays`. */
  periodDays: 7,
  /** Share of every customer payment sent to the lender while a loan is open. */
  repayBps: 7000,
  /** A loan's total owed may be at most this share of the revenue the device is expected to collect over the term. */
  advanceBps: 5000,
  graceDays: 2,

  /**
   * Lender scenarios. These are ASSUMPTIONS, not predictions:
   *  utilisation  - average share of pool money that is lent out (idle money earns nothing)
   *  defaultRate  - share of lent principal that defaults per 28-day loan cycle (a fee this small cannot absorb much more)
   *  recovery     - share of a defaulted loan's principal recovered from redirected device revenue
   */
  scenarios: {
    cautious: { label: 'Cautious', utilisation: 0.35, defaultRate: 0.02, recovery: 0.3 },
    expected: { label: 'Expected', utilisation: 0.55, defaultRate: 0.01, recovery: 0.4 },
    strong: { label: 'Strong', utilisation: 0.75, defaultRate: 0.005, recovery: 0.5 },
  },

  lenderHorizons: [7, 14, 30, 60, 90],
  borrowerDurations: [14, 28, 56, 84],

  // input limits (US dollars)
  minLendUsd: 10,
  maxLendUsd: 1_000_000,
  minBorrowUsd: 50,
  maxBorrowUsd: 100_000,
  maxDailyRevenueUsd: 100_000,
}

export const feeRateFor = (days) => (TERMS.feeBps / 10_000) * (days / TERMS.baseTermDays)

// ---- the shared multi-chain pool: liquidity arrives on any of these chains in any of these dollar stablecoins
export const CHAINS = {
  base: { id: 'base', name: 'Base', short: 'Base', testnet: 'Base Sepolia' },
  arbitrum: { id: 'arbitrum', name: 'Arbitrum', short: 'Arbitrum', testnet: 'Arbitrum Sepolia' },
  tempo: { id: 'tempo', name: 'Tempo', short: 'Tempo', testnet: 'Tempo Moderato' },
}
export const TOKENS = ['USDC', 'USDT', 'USD']

// ---- demo clock: one simulated day passes every `secondsPerDay` real seconds, so a 28-day loan completes in 28 minutes
export const SIM = {
  secondsPerDay: 60,
  epoch: 1_791_000_000,
  writeOffDelayDays: 30,
}
export const simDayAt = (nowSeconds) => Math.max(0, Math.floor((nowSeconds - SIM.epoch) / SIM.secondsPerDay))

// ---- how a meter's history becomes a borrowing limit
export const VALUATION = {
  historyWindowDays: 28,
  minHistoryDays: 14,
  minUptime: 0.6,
  minScore: 40,
  meterBackfillDays: 30,
  /** Seed liquidity owner: the Selfpay demo treasury (simulated). */
  seedAddress: '0x0000000000000000000000000000000000005eed',
}
