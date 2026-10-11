// Sets each test-network pool's fee (feeBps) and lender share (repayBps) to the values in web/src/terms.mjs. Owner-only, testnet only.
// Existing loans keep the fee and share they were opened with; only new loans use the new values.
//   node --env-file=.env scripts/align-pools.mjs
import fs from 'node:fs'
import { createPublicClient, createWalletClient, defineChain, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { TERMS } from '../web/src/terms.mjs'

const abi = JSON.parse(fs.readFileSync('out/LoanPool.sol/LoanPool.json', 'utf8')).abi
const owner = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY)
const NAMES = ['advanceBps', 'repayBps', 'feeBps', 'periods', 'period', 'grace', 'minHistory', 'maxReadingAge', 'writeOffDelay']

for (const file of fs.readdirSync('deployments').filter((f) => f.endsWith('.json'))) {
  const dep = JSON.parse(fs.readFileSync(`deployments/${file}`, 'utf8'))
  const chain = defineChain({ id: dep.chainId, name: dep.chain, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [dep.rpc] } } })
  const pub = createPublicClient({ chain, transport: http(dep.rpc) })
  const wallet = createWalletClient({ account: owner, chain, transport: http(dep.rpc) })
  const raw = await pub.readContract({ address: dep.pool, abi, functionName: 'params' })
  const params = Object.fromEntries(NAMES.map((k, i) => [k, raw[i]]))
  const poolOwner = await pub.readContract({ address: dep.pool, abi, functionName: 'owner' })
  if (poolOwner.toLowerCase() !== owner.address.toLowerCase()) { console.log(dep.short, 'skipped: this wallet does not own the pool'); continue }
  if (Number(params.repayBps) === TERMS.repayBps && Number(params.feeBps) === TERMS.feeBps) { console.log(dep.short, `already fee ${TERMS.feeBps}, lender share ${TERMS.repayBps}`); continue }
  const next = { ...params, repayBps: TERMS.repayBps, feeBps: TERMS.feeBps }
  const hash = await wallet.writeContract({ address: dep.pool, abi, functionName: 'setParams', args: [next] })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  const after = await pub.readContract({ address: dep.pool, abi, functionName: 'params' })
  console.log(dep.short, `feeBps ${params.feeBps} -> ${after[2]}, repayBps ${params.repayBps} -> ${after[1]}`, receipt.status, hash)
}
