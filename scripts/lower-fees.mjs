// Lowers the loan fee from 10% to 3% per 28 days everywhere it is hard-coded, and makes the demo simulation read the
// fee from web/src/terms.mjs so nothing can drift again. Idempotent. Then run: npm test
import fs from 'node:fs'

const NEW_FEE_BPS = 300

// ---- terms: the single source of truth
let terms = fs.readFileSync('web/src/terms.mjs', 'utf8')
terms = terms.replace(/feeBps: \d+,/, `feeBps: ${NEW_FEE_BPS},`)
terms = terms.replace(
  /scenarios: \{[\s\S]*?\n  \},\n/,
  `scenarios: {
    cautious: { label: 'Cautious', utilisation: 0.35, defaultRate: 0.02, recovery: 0.3 },
    expected: { label: 'Expected', utilisation: 0.55, defaultRate: 0.01, recovery: 0.4 },
    strong: { label: 'Strong', utilisation: 0.75, defaultRate: 0.005, recovery: 0.5 },
  },
`,
)
terms = terms.replace('   *  defaultRate  - share of lent principal that defaults per 28-day loan cycle', '   *  defaultRate  - share of lent principal that defaults per 28-day loan cycle (a fee this small cannot absorb much more)')
fs.writeFileSync('web/src/terms.mjs', terms)

// ---- projections: comment only
let proj = fs.readFileSync('web/src/projections.mjs', 'utf8')
proj = proj.replace('Fee = principal x 10% x (days / 28)', 'Fee = principal x fee rate x (days / 28)')
fs.writeFileSync('web/src/projections.mjs', proj)

// ---- demo simulation reads the fee from terms
let sim = fs.readFileSync('web/src/simulation.mjs', 'utf8')
if (!sim.includes("from './terms.mjs'")) {
  sim = "import { TERMS } from './terms.mjs';\n" + sim
  sim = sim.replace('const FEE = 10_000;', 'const FEE = Math.round(PRINCIPAL * TERMS.feeBps / 10_000); // from terms.mjs');
  sim = sim.replace('const INSTALLMENT = 11_000;', 'const INSTALLMENT = TOTAL_OWED / 10; // the demo spreads repayment over ten steps');
  sim = sim.replaceAll("'Solar unit SOL-001 · $1,000 principal + $100 fixed fee'", '`Solar unit SOL-001 · $1,000 principal + ${money(FEE)} fixed fee`');
}
fs.writeFileSync('web/src/simulation.mjs', sim)

// ---- on-chain deploy script
let deploy = fs.readFileSync('script/Deploy.s.sol', 'utf8')
deploy = deploy.replace(/feeBps: \d+,/, `feeBps: ${NEW_FEE_BPS},`)
fs.writeFileSync('script/Deploy.s.sol', deploy)

console.log({ terms: terms.includes(`feeBps: ${NEW_FEE_BPS}`), sim: sim.includes('TERMS.feeBps'), deploy: deploy.includes(`feeBps: ${NEW_FEE_BPS}`) })
