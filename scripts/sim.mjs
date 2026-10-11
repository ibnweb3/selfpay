// Simulator: plays a whole device-loan story on the live testnet.
//   node scripts/sim.mjs init            create + fund personas, lender deposits, operator registers a device
//   node scripts/sim.mjs pay [usd]       customer pays the device vault, then settle()
//   node scripts/sim.mjs reading         device signs a usage reading, relayed on-chain
//   node scripts/sim.mjs history [secs]  customer payments + readings for a while (builds revenue history)
//   node scripts/sim.mjs borrow [usd]    operator borrows (default: the maximum)
//   node scripts/sim.mjs watch           wait until the loan is behind, then flag the default (lock)
//   node scripts/sim.mjs cure            customer pays the arrears (unlock)
//   node scripts/sim.mjs agent           device agent: sends readings, shows LOCK / UNLOCK
//   node scripts/sim.mjs status          print the current state
//   node scripts/sim.mjs params          show the pool's loan parameters
//   node scripts/sim.mjs setparams k=v   change pool parameters as the pool owner (testnet pacing)
import fs from 'node:fs'
import { createPublicClient, createWalletClient, http, defineChain, formatUnits, parseUnits, keccak256, toBytes } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

// CHAIN=base-sepolia node scripts/sim.mjs ...   (default: tempo-moderato)
const CHAIN = process.env.CHAIN || 'tempo-moderato'
const dep = JSON.parse(fs.readFileSync(`deployments/${CHAIN}.json`, 'utf8'))
const TEMPO = dep.chainId === 42431
// Tempo's faucet is huge; Sepolia faucets give ~20 test USDC, so scale the story down there.
const CFG = TEMPO
  ? { lender: 100000, pay: 20, margin: 1, gasEth: 0n, customerUsd: 0 }
  : { lender: 10, pay: 1, margin: 0.2, gasEth: 3_000_000_000_000_000n /* 0.003 ETH */, customerUsd: 8 }
const abi = (n) => JSON.parse(fs.readFileSync(`out/${n}.sol/${n}.json`, 'utf8')).abi
const ABI = { registry: abi('DeviceRegistry'), vault: abi('RevenueVault'), pool: abi('LoanPool') }
const erc20 = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
]

const chain = defineChain({
  id: dep.chainId, name: dep.chain, nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
  rpcUrls: { default: { http: [dep.rpc] } },
})
const pub = createPublicClient({ chain, transport: http(dep.rpc) })
const STATE_FILE = TEMPO ? '.sim.json' : `.sim.${CHAIN}.json`
const S = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2))
const usd = (v) => Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

const who = (name) => privateKeyToAccount(S[name].pk)
const wallet = (name) => createWalletClient({ account: who(name), chain, transport: http(dep.rpc) })

async function send(name, address, abiName, functionName, args = []) {
  const a = abiName === 'erc20' ? erc20 : ABI[abiName]
  const hash = await wallet(name).writeContract({ address, abi: a, functionName, args })
  const rcpt = await pub.waitForTransactionReceipt({ hash })
  if (rcpt.status !== 'success') throw new Error(`${functionName} reverted (${hash})`)
  return { hash, rcpt }
}
const read = (address, abiName, functionName, args = []) =>
  pub.readContract({ address, abi: abiName === 'erc20' ? erc20 : ABI[abiName], functionName, args })

const LOAN_FIELDS = ['status', 'start', 'period', 'periods', 'grace', 'repayBps', 'totalOwed0', 'principalOutstanding', 'feeOutstanding', 'installment', 'totalPaid', 'defaultedAt']
async function loanOf() {
  const t = await read(S.vault, 'vault', 'loan')
  return Object.fromEntries(LOAN_FIELDS.map((k, i) => [k, t[i]]))
}
const STATUS = ['None', 'Active', 'Defaulted']

function need() {
  if (!S.operator) throw new Error('run `init` first')
}

// Tempo: its faucet RPC. Elsewhere: the deployer wallet sends a little gas (and USDC to those who need it).
async function fund(name) {
  const addr = who(name).address
  if (TEMPO) return pub.request({ method: 'tempo_fundAddress', params: [addr] })
  const deployer = createWalletClient({ account: privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY), chain, transport: http(dep.rpc) })
  if (name !== 'device' && CFG.gasEth > 0n) {
    const h = await deployer.sendTransaction({ to: addr, value: CFG.gasEth })
    await pub.waitForTransactionReceipt({ hash: h })
  }
  const usdc = name === 'lender' ? CFG.lender : name === 'customer' ? CFG.customerUsd : 0
  if (usdc > 0) {
    const h = await deployer.writeContract({ address: dep.asset, abi: erc20, functionName: 'transfer', args: [addr, parseUnits(String(usdc), 6)] })
    await pub.waitForTransactionReceipt({ hash: h })
  }
}

async function init() {
  if (!S.operator) {
    for (const n of ['lender', 'operator', 'customer', 'device']) S[n] = { pk: generatePrivateKey() }
    S.deviceName = `solar-unit-${Date.now().toString(36)}`
    S.deviceId = keccak256(toBytes(S.deviceName))
    save()
  }
  for (const n of ['lender', 'operator', 'customer', 'device']) {
    log('funding', n, who(n).address)
    await fund(n)
  }
  await sleep(2500)

  const lenderBal = await read(dep.asset, 'erc20', 'balanceOf', [who('lender').address])
  log('lender balance', usd(lenderBal))
  const dep$ = parseUnits(String(CFG.lender), 6)
  await send('lender', dep.asset, 'erc20', 'approve', [dep.pool, dep$])
  await send('lender', dep.pool, 'pool', 'deposit', [dep$, who('lender').address])
  log(`lender deposited ${CFG.lender.toLocaleString('en-US')} into the pool`)

  const { hash, rcpt } = await send('operator', dep.registry, 'registry', 'registerDevice', [S.deviceId, who('device').address])
  S.vault = await read(dep.registry, 'registry', 'predictVault', [S.deviceId])
  save()
  // public manifest the dashboard reads (no secrets): lets it start event scans at the registration block
  fs.mkdirSync('devices', { recursive: true })
  const mf = `devices/${CHAIN}.json`
  const list = fs.existsSync(mf) ? JSON.parse(fs.readFileSync(mf, 'utf8')) : []
  list.push({ deviceId: S.deviceId, vault: S.vault, owner: who('operator').address, block: Number(rcpt.blockNumber), name: S.deviceName })
  fs.writeFileSync(mf, JSON.stringify(list, null, 2))
  log('device registered:', S.deviceName)
  log('customers pay THIS vault address:', S.vault, hash)
}

async function reading() {
  need()
  const dev = await read(dep.registry, 'registry', 'getDevice', [S.deviceId])
  const nonce = BigInt(dev.lastNonce) + 1n
  const block = await pub.getBlock()
  const timestamp = block.timestamp - 1n
  const units = BigInt(1000 + Math.floor(Math.random() * 4000)) // Wh since last reading
  const signature = await who('device').signTypedData({
    domain: { name: 'DeviceRegistry', version: '1', chainId: dep.chainId, verifyingContract: dep.registry },
    types: { Reading: [{ name: 'deviceId', type: 'bytes32' }, { name: 'units', type: 'uint256' }, { name: 'timestamp', type: 'uint64' }, { name: 'nonce', type: 'uint64' }] },
    primaryType: 'Reading',
    message: { deviceId: S.deviceId, units, timestamp, nonce },
  })
  await send('operator', dep.registry, 'registry', 'reportReading', [S.deviceId, units, timestamp, nonce, signature])
  log(`device reading #${nonce}: ${units} Wh (signed by the device key)`)
}

async function pay(amountUsd = 20) {
  need()
  const amt = parseUnits(String(amountUsd), 6)
  await send('customer', dep.asset, 'erc20', 'transfer', [S.vault, amt])
  const before = await loanOf()
  const { rcpt } = await send('customer', S.vault, 'vault', 'settle')
  const after = await loanOf()
  const toLender = before.totalPaid === undefined ? 0n : after.totalPaid - before.totalPaid
  // owner share = amount - lender share (loan may have just closed, so recompute from the Settled event)
  const ev = rcpt.logs.find((l) => l.address.toLowerCase() === S.vault.toLowerCase() && l.topics[0] === keccak256(toBytes('Settled(uint256,uint256,uint256)')))
  let toL = toLender, toO = amt - toLender
  if (ev) {
    const d = ev.data.slice(2)
    toL = BigInt('0x' + d.slice(64, 128)); toO = BigInt('0x' + d.slice(128, 192))
  }
  log(`customer paid ${usd(amt)} -> lender ${usd(toL)} | operator ${usd(toO)}  (loan: ${STATUS[after.status]}, owed ${usd(after.principalOutstanding + after.feeOutstanding)})`)
}

async function history(secs = 70) {
  need()
  const end = Date.now() + secs * 1000
  log(`building revenue history for ~${secs}s (customers paying the vault)`)
  let i = 0
  while (Date.now() < end) {
    await pay(CFG.pay)
    if (i++ % 2 === 0) await reading()
    await sleep(12000)
  }
  await reading() // fresh reading so the device qualifies right away
}

async function borrow(arg) {
  need()
  await reading() // a fresh signed reading is required, and it takes time - so do it before sizing the loan
  const max = await read(dep.pool, 'pool', 'maxPrincipal', [S.deviceId])
  // the cap shrinks as time passes without new revenue, so default to 90% to survive block time
  const cash = await read(dep.asset, 'erc20', 'balanceOf', [dep.pool])
  let amt = !arg ? (max * 9n) / 10n : arg === 'max' ? max : parseUnits(String(arg), 6)
  if (!arg && amt > cash) amt = cash // the pool can only lend what it holds
  log(`max the device may borrow now: ${usd(max)} (pool cash ${usd(cash)}, borrowing ${usd(amt)})`)
  if (amt > max) throw new Error('requested more than the maximum')
  await send('operator', dep.pool, 'pool', 'borrow', [S.deviceId, amt])
  const l = await loanOf()
  log(`operator borrowed ${usd(amt)} - owes ${usd(l.principalOutstanding + l.feeOutstanding)} (fee included), ${l.periods} installments of ${usd(l.installment)} every ${l.period}s`)
}

async function status() {
  need()
  const [assets, outstanding, cash, l, rev, lockNonce, behind] = await Promise.all([
    read(dep.pool, 'pool', 'totalAssets'),
    read(dep.pool, 'pool', 'totalPrincipalOutstanding'),
    read(dep.asset, 'erc20', 'balanceOf', [dep.pool]),
    loanOf(),
    read(S.vault, 'vault', 'cumRevenue'),
    read(S.vault, 'vault', 'lockNonce'),
    read(S.vault, 'vault', 'isBehind'),
  ])
  const opBal = await read(dep.asset, 'erc20', 'balanceOf', [who('operator').address])
  const locked = l.status === 2
  console.log({
    pool: { totalAssets: usd(assets), cash: usd(cash), lentOut: usd(outstanding) },
    device: S.deviceName,
    vault: S.vault,
    revenueCollected: usd(rev),
    loan: STATUS[l.status],
    owed: usd(l.principalOutstanding + l.feeOutstanding),
    paid: usd(l.totalPaid),
    behindSchedule: behind,
    unit: locked ? 'LOCKED' : 'RUNNING',
    lockNonce: String(lockNonce),
    operatorBalance: usd(opBal),
  })
}

async function watch() {
  need()
  log('watching the loan - if no installment is paid it will be flagged as a default')
  for (;;) {
    const l = await loanOf()
    if (STATUS[l.status] === 'None') return log('no active loan')
    if (STATUS[l.status] === 'Defaulted') return log('already defaulted')
    if (await read(S.vault, 'vault', 'isBehind')) {
      await send('customer', S.vault, 'vault', 'markDefault')
      return log('DEFAULT flagged -> all revenue now goes to the lender, LOCK requested for the unit')
    }
    const next = Number(l.start) + Number(l.period) + Number(l.grace)
    log(`still on schedule (installment due, grace window runs until ~${new Date(next * 1000).toISOString().slice(11, 19)})`)
    await sleep(10000)
  }
}

async function cure() {
  need()
  const l = await loanOf()
  const block = await pub.getBlock()
  const required = await read(S.vault, 'vault', 'requiredPaid', [block.timestamp + 5n])
  const arrears = required > l.totalPaid ? required - l.totalPaid : 0n
  log(`arrears to clear: ${usd(arrears)}`)
  await pay(Number(formatUnits(arrears + parseUnits(String(CFG.margin), 6), 6))) // small margin for the next few seconds
}

async function agent() {
  need()
  let last = null
  let n = 0
  log(`device agent online for ${S.deviceName}`)
  for (;;) {
    const l = await loanOf()
    const locked = STATUS[l.status] === 'Defaulted'
    if (locked !== last) {
      log(locked ? 'LOCK request received - unit disabled until arrears are paid' : 'UNIT RUNNING - power on')
      last = locked
    }
    if (!locked && n++ % 6 === 0) await reading().catch((e) => log('reading skipped:', e.shortMessage || e.message))
    await sleep(5000)
  }
}

async function params() {
  const p = await read(dep.pool, 'pool', 'params')
  const names = ['advanceBps', 'repayBps', 'feeBps', 'periods', 'period', 'grace', 'minHistory', 'maxReadingAge', 'writeOffDelay']
  console.log(Object.fromEntries(names.map((k, i) => [k, String(p[i])])))
}

async function setparams(kvs) {
  const p = await read(dep.pool, 'pool', 'params')
  const names = ['advanceBps', 'repayBps', 'feeBps', 'periods', 'period', 'grace', 'minHistory', 'maxReadingAge', 'writeOffDelay']
  const cur = Object.fromEntries(names.map((k, i) => [k, p[i]]))
  for (const kv of kvs) { const [k, v] = kv.split('='); if (!(k in cur)) throw new Error('unknown param ' + k); cur[k] = BigInt(v) }
  const owner = privateKeyToAccount(process.env.DEPLOYER_PRIVATE_KEY)
  const hash = await createWalletClient({ account: owner, chain, transport: http(dep.rpc) }).writeContract({ address: dep.pool, abi: ABI.pool, functionName: 'setParams', args: [cur] })
  await pub.waitForTransactionReceipt({ hash })
  log('params updated', Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, String(v)])))
}

const [cmd, ...rest] = process.argv.slice(2)
const table = { init, reading, pay: () => pay(rest[0] ? Number(rest[0]) : CFG.pay), history: () => history(rest[0] ? Number(rest[0]) : 70), borrow: () => borrow(rest[0]), status, watch, cure, agent, params, setparams: () => setparams(rest) }
if (!table[cmd]) { console.log('commands:', Object.keys(table).join(', ')); process.exit(1) }
table[cmd]().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.shortMessage || e.message); process.exit(1) })
