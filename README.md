# Selfpay

A loan your solar unit pays back itself. Selfpay lends to small energy businesses against the income their equipment earns. Customers pay a per-device vault, the vault pays the lender first, and if payments stop the unit receives a lock request.

Live on testnet: https://selfpay.ibnweb3lab.workers.dev
Demo video: see the Colosseum submission. Script: [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md).

Everything here runs on test networks and is unaudited.

## How it works

1. A borrower signs up with a wallet (Sign-In With Ethereum, one signature, no password) and registers a meter number.
2. The meter's last 28 days are scored on uptime (45%), steadiness of income (35%) and history (20%). The score sets a loan limit for 14, 28, 56 or 84 days: half of the revenue expected over the term, less the fee.
3. The borrower picks a chain and token, and borrows. The fee is 3% per 28 days, shown with every weekly instalment before confirming.
4. 70% of every customer payment goes to the pool until the loan is repaid. If an instalment is more than two days late the unit locks and all revenue goes to the lender until the borrower catches up. A loan unpaid for 30 days is written off.
5. Lenders deposit USDC, USDT or USD from Base, Arbitrum or Tempo into one shared pool, choose a lock of 7 to 90 days (enforced), and see cautious, expected and strong outcomes before depositing. Loan fees raise the value of every pool share.

## What is real and what is test data

- **Real, on three testnets:** the Solidity contracts (`src/`: `DeviceRegistry`, `RevenueVault`, `LoanPool` as an ERC-4626 pool), deployed on Tempo Moderato, Base Sepolia and Arbitrum Sepolia (`deployments/`). `testnet.html` reads loans, repayments, defaults and lock requests straight from them.
- **Web app (`web/`, `worker/`):** accounts, meters, valuation, the shared pool and loans are stored in a Cloudflare D1 database. Meter readings are generated test data (deterministic from the meter number) and one demo day passes every real minute. The web app does not yet send on-chain deposits or loans.
- **Lock:** today the lock is an on-chain request that a device agent reads. Physical pay-as-you-go lock hardware is on the roadmap.

## Run it

```sh
npm install
npm run dev          # site + the real API on an in-memory database, http://localhost:4180
npm test             # valuation and loan engine, projections, and the whole API with real wallet signatures
```

`npm run dev` has a dev-only test wallet: add `?mockwallet=lender` or `?mockwallet=borrower` to any page.

Contracts need Foundry and forge-std (`forge install foundry-rs/forge-std`), then `forge test`.

Deploy to Cloudflare: create a D1 database, set its id in `wrangler.jsonc`, apply `schema.sql`, then `node scripts/build-web.mjs && node scripts/make-dist.mjs && npx wrangler deploy`. `scripts/smoke-live.mjs <url>` runs a 33-step end-to-end check against a deployment.

## Layout

| Path | What |
| --- | --- |
| `src/`, `test/`, `script/` | Solidity contracts, Foundry tests and deploy script |
| `worker/` | Cloudflare Worker API: sign-in, meters, valuation, pool, loans |
| `web/` | The site: landing, sign-up, app, the cartoon, the on-chain monitor |
| `scripts/` | Tests, dev server, build, on-chain simulator and demo tooling |
| `schema.sql` | D1 schema (re-applying it wipes all data) |

## Honest limits

Unaudited testnet code. An operator could inflate their own revenue by paying themselves; distinct-payer checks and haircuts are on the roadmap. The lending licence position is unverified. APR figures are assumptions, not predictions.
