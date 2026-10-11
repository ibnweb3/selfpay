// Adds the multi-chain pool, simulated clock and valuation constants to web/src/terms.mjs. Idempotent.
import fs from 'node:fs'

let t = fs.readFileSync('web/src/terms.mjs', 'utf8')
if (!t.includes('export const CHAINS')) {
  t = t.replace('lenderHorizons: [30, 60, 90, 180, 365],', 'lenderHorizons: [7, 14, 30, 60, 90],')
  t += `
// ---- the shared multi-chain pool: liquidity arrives on any of these chains in any of these dollar stablecoins
export const CHAINS = {
  base: { id: 'base', name: 'Base', short: 'Base', testnet: 'Base Sepolia' },
  arbitrum: { id: 'arbitrum', name: 'Arbitrum', short: 'Arbitrum', testnet: 'Arbitrum Sepolia' },
  tempo: { id: 'tempo', name: 'Tempo', short: 'Tempo', testnet: 'Tempo Moderato' },
}
export const TOKENS = ['USDC', 'USDT', 'USD']

// ---- demo clock: one simulated day passes every \`secondsPerDay\` real seconds, so a 28-day loan completes in 28 minutes
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
`
  fs.writeFileSync('web/src/terms.mjs', t)
}
console.log({ chains: t.includes('export const CHAINS'), horizons: t.includes('[7, 14, 30, 60, 90]') })
