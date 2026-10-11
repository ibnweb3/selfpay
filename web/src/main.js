import { createPublicClient, http, defineChain, formatUnits } from 'viem'
import registryAbi from './abi/DeviceRegistry.json'
import vaultAbi from './abi/RevenueVault.json'
import poolAbi from './abi/LoanPool.json'
import deployments from './deployments.json'
import deviceManifest from './devices.json'
import historyRaw from './history.json'
import { getEventsChunked } from './chunked.mjs'
import './story.js'

const erc20Abi = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }]
const LOAN_FIELDS = ['status', 'start', 'period', 'periods', 'grace', 'repayBps', 'totalOwed0', 'principalOutstanding', 'feeOutstanding', 'installment', 'totalPaid', 'defaultedAt']
const POLL_MS = 8000

const $ = (id) => document.getElementById(id)
const usd = (v) => Number(formatUnits(v, 6)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
const wh = (v) => (Number(v) >= 1000 ? `${(Number(v) / 1000).toLocaleString('en-US', { maximumFractionDigits: 1 })} kWh` : `${v} Wh`)
const clock = (ts) => new Date(Number(ts) * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
const ago = (secs) => (secs < 90 ? `${Math.max(0, Math.round(secs))}s ago` : secs < 5400 ? `${Math.round(secs / 60)}m ago` : `${Math.round(secs / 3600)}h ago`)
const mmss = (secs) => `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`

// Pre-built history (scripts/snapshot.mjs): bigints were stored as "bi:123".
const revive = (v) => {
  if (typeof v === 'string' && v.startsWith('bi:')) return BigInt(v.slice(3))
  if (Array.isArray(v)) return v.map(revive)
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]))
  return v
}
const snapshot = revive(historyRaw)

// One context per network. Every async step carries its own ctx, so a late response from the previous
// network can never touch the current one (this used to mix addresses and clients on a network switch).
let current = null
let pollTimer = null

function makeCtx(dep) {
  const chain = defineChain({
    id: dep.chainId, name: dep.chain, nativeCurrency: { name: 'USD', symbol: 'USD', decimals: 18 },
    rpcUrls: { default: { http: [dep.rpc] } },
  })
  return {
    dep,
    client: createPublicClient({ chain, transport: http(dep.rpc, { retryCount: 5, retryDelay: 600 }) }),
    devices: deviceManifest[dep.chainId] ?? [],
    deviceId: null,
    events: new Map(),
    lastBlock: null,
    blockTimes: new Map(),
    timeOffset: 0,
    refreshing: false,
    lastSuccess: null,
  }
}
const live = (ctx) => ctx === current

function setupSelectors() {
  const net = $('network')
  net.innerHTML = deployments.map((d, i) => `<option value="${i}">${d.short || d.chain}</option>`).join('')
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('network')
  const start = Math.max(0, deployments.findIndex((d) => (d.short || '').toLowerCase() === (fromHash || '').toLowerCase()))
  net.value = String(start)
  net.addEventListener('change', () => {
    window.history.replaceState(null, '', `#network=${(deployments[Number(net.value)].short || '').toLowerCase()}`)
    start_(deployments[Number(net.value)])
  })
  $('device').addEventListener('change', () => {
    start_(current.dep, $('device').value)
  })
  // every [data-copy-vault] control (hero pill + card button) copies the full vault address customers pay
  document.querySelectorAll('[data-copy-vault]').forEach((btn) => btn.addEventListener('click', async () => {
    const full = $('vaultAddr').dataset.full
    if (!full) return
    const isGhost = btn.classList.contains('ghost')
    try { await navigator.clipboard.writeText(full); isGhost ? (btn.textContent = 'Copied ✓') : btn.classList.add('copied') } catch { if (isGhost) btn.textContent = 'Press Ctrl+C' }
    setTimeout(() => { if (isGhost) btn.textContent = 'Copy'; btn.classList.remove('copied') }, 1600)
  }))
  // pause the looping badge ring while it is off-screen
  const ring = document.querySelector('.ring')
  if (ring && 'IntersectionObserver' in window) new IntersectionObserver(([e]) => { ring.style.animationPlayState = e.isIntersecting ? 'running' : 'paused' }).observe(ring)
  return deployments[start]
}

function networkStatus(ctx, text, retry = false) {
  if (!live(ctx)) return
  const loading = $('loading')
  loading.replaceChildren(document.createTextNode(text))
  if (retry) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'ghost'
    button.textContent = 'Retry now'
    button.disabled = ctx.refreshing
    button.addEventListener('click', () => loop(ctx))
    loading.append(button)
  }
  loading.hidden = false
}

async function start_(dep, selectedDevice = null) {
  clearTimeout(pollTimer)
  const ctx = (current = makeCtx(dep))
  $('feed').innerHTML = ''
  $('steps').innerHTML = ''
  $('app').hidden = true; $('empty').hidden = true; $('loading').hidden = false
  networkStatus(ctx, 'Loading live data from the chain…')
  $('contracts').textContent = `registry ${dep.registry} · pool ${dep.pool}`
  const sel = $('device')
  sel.innerHTML = ctx.devices.map((d) => `<option value="${d.deviceId}">${d.name ?? `Device ${short(d.deviceId)}`}</option>`).join('')
  ctx.deviceId = selectedDevice ?? ctx.devices[ctx.devices.length - 1]?.deviceId ?? null // newest registration
  if (ctx.deviceId) sel.value = ctx.deviceId
  $('empty').hidden = !!ctx.deviceId
  if (!ctx.deviceId) { $('loading').hidden = true; return }
  loop(ctx) // the app stays hidden behind the loading line until the first refresh succeeds
}

const call = (ctx, address, abi, functionName, args = []) => ctx.client.readContract({ address, abi, functionName, args })

async function blockTime(ctx, bn) {
  if (!ctx.blockTimes.has(bn)) ctx.blockTimes.set(bn, Number((await ctx.client.getBlock({ blockNumber: bn })).timestamp))
  return ctx.blockTimes.get(bn)
}

function describe(e) {
  const a = e.args
  switch (e.eventName) {
    case 'Settled': return { tag: ['pay', 'Payment'], text: `Customer paid ${usd(a.amount)} → lender ${usd(a.toLender)} · operator ${usd(a.toOwner)}` }
    case 'ReadingReported': return { tag: ['', 'Reading'], text: `Device signed a reading: ${wh(a.units)}` }
    case 'LoanOpened': return { tag: ['loan', 'Loan'], text: `Loan opened: ${usd(a.principal)} + ${usd(a.fee)} fee, ${a.periods} installments of ${mmss(Number(a.period))}` }
    case 'LoanRepaid': return { tag: ['pay', 'Repaid'], text: 'Loan fully repaid. The operator keeps 100% of revenue again.' }
    case 'LoanDefaulted': return { tag: ['bad', 'Default'], text: 'Installment missed past the grace window. All revenue now goes to the lender.' }
    case 'LockStateChanged': return a.locked
      ? { tag: ['bad', 'Lock'], text: 'Lock requested. The unit stops working until arrears are paid.' }
      : { tag: ['pay', 'Unlock'], text: 'Arrears cleared. Unit running again.' }
    case 'LoanWrittenOff': return { tag: ['bad', 'Write-off'], text: `Lenders took a ${usd(a.principalLost)} loss.` }
    default: return null
  }
}

async function pullEvents(ctx, device) {
  // first call: seed from the pre-built snapshot, then only scan the tail live
  if (ctx.lastBlock === null) {
    const snap = snapshot[`${ctx.dep.chainId}:${device.deviceId}`]
    if (snap) {
      for (const e of snap.events) { ctx.events.set(`${e.transactionHash}:${e.logIndex}`, e); ctx.blockTimes.set(e.blockNumber, e.ts) }
      ctx.lastBlock = BigInt(snap.upTo)
    } else ctx.lastBlock = BigInt(device.block) - 1n
  }
  const latest = await ctx.client.getBlockNumber()
  const from = ctx.lastBlock + 1n
  if (from <= latest) {
    const range = ctx.dep.logRange || 50000
    const [v, r] = await Promise.all([
      getEventsChunked(ctx.client, { address: device.vault, abi: vaultAbi }, from, latest, range),
      getEventsChunked(ctx.client, { address: ctx.dep.registry, abi: registryAbi, eventName: 'ReadingReported', args: { deviceId: device.deviceId } }, from, latest, range),
    ])
    for (const e of [...v, ...r]) ctx.events.set(`${e.transactionHash}:${e.logIndex}`, e)
    ctx.lastBlock = latest
  }
  const list = [...ctx.events.values()].sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : Number(b.blockNumber - a.blockNumber)))
  const top = list.filter((e) => describe(e)).slice(0, 30)
  await Promise.all(top.map((e) => blockTime(ctx, e.blockNumber)))
  return { list, top }
}

function renderFeed(ctx, top) {
  $('feed').innerHTML = top.map((e) => {
    const d = describe(e)
    return `<li><time>${clock(ctx.blockTimes.get(e.blockNumber))}</time><span><span class="tag ${d.tag[0]}">${d.tag[1]}</span>${d.text}</span><a href="${ctx.dep.explorer}/tx/${e.transactionHash}" target="_blank" rel="noopener noreferrer">${short(e.transactionHash)}</a></li>`
  }).join('')
}

function renderSteps(state) {
  const defs = ['Lender funds the pool', 'Device earns revenue', 'Operator borrows', state.defaulted ? 'Payments stop → locked' : 'Revenue repays the loan']
  const idx = state.defaulted ? 3 : state.hasLoan ? 3 : state.revenue > 0n ? 2 : state.poolFunded ? 1 : 0
  $('steps').innerHTML = defs.map((t, i) => {
    const cls = i === 3 && state.defaulted ? 'bad' : i < idx ? 'done' : i === idx ? 'now' : ''
    return `<li class="${cls}">${t}</li>`
  }).join('')
}

async function refresh(ctx) {
  const { dep, deviceId } = ctx
  if (!deviceId) return
  const device = ctx.devices.find((d) => d.deviceId === deviceId)
  const d = await call(ctx, dep.registry, registryAbi, 'getDevice', [deviceId])
  const vault = d.vault
  const [assets, out, cash, loanTuple, rev, behind, block] = await Promise.all([
    call(ctx, dep.pool, poolAbi, 'totalAssets'),
    call(ctx, dep.pool, poolAbi, 'totalPrincipalOutstanding'),
    call(ctx, dep.asset, erc20Abi, 'balanceOf', [dep.pool]),
    call(ctx, vault, vaultAbi, 'loan'),
    call(ctx, vault, vaultAbi, 'cumRevenue'),
    call(ctx, vault, vaultAbi, 'isBehind'),
    ctx.client.getBlock(),
  ])
  let maxLoan = 0n
  try { maxLoan = await call(ctx, dep.pool, poolAbi, 'maxPrincipal', [deviceId]) } catch { /* no history yet */ }
  const { list, top } = await pullEvents(ctx, device)
  if (!live(ctx) || ctx.deviceId !== deviceId) return // the user switched network/device while we were fetching

  ctx.timeOffset = Number(block.timestamp) - Date.now() / 1000
  const nowChain = () => Date.now() / 1000 + ctx.timeOffset
  const loan = Object.fromEntries(LOAN_FIELDS.map((k, i) => [k, loanTuple[i]]))
  const defaulted = loan.status === 2
  const hasLoan = loan.status !== 0
  const owed = loan.principalOutstanding + loan.feeOutstanding

  // unit card
  $('unitCard').classList.toggle('locked', defaulted)
  $('unitDot').className = `dot ${defaulted ? 'bad' : 'ok'}`
  $('unitState').textContent = defaulted ? 'LOCKED' : 'Running'
  $('unitNote').textContent = defaulted
    ? 'A payment was missed past the grace window. The device agent has been asked to disable the unit.'
    : hasLoan ? 'Earning. Each payment is split automatically between lender and operator.' : 'Earning. No loan: the operator keeps everything.'
  $('vaultAddr').textContent = short(vault); $('vaultAddr').dataset.full = vault
  $('revenue').textContent = usd(rev)
  $('reading').textContent = d.lastReadingAt ? ago(nowChain() - Number(d.lastReadingAt)) : 'none yet'
  $('units').textContent = d.cumulativeUnits ? wh(d.cumulativeUnits) : '—'

  // loan card
  $('loanState').textContent = hasLoan ? (defaulted ? 'In default' : 'Repaying') : 'No open loan'
  const total = Number(loan.totalOwed0)
  const paidPct = hasLoan && total ? Math.min(100, (Number(loan.totalPaid) / total) * 100) : 0
  $('loanBar').style.width = `${paidPct}%`
  $('loanBarWrap').classList.toggle('bad', defaulted)
  $('loanBarWrap').setAttribute('aria-label', hasLoan ? `Repaid ${paidPct.toFixed(0)} percent` : 'No open loan')
  $('ticks').innerHTML = hasLoan ? Array.from({ length: Number(loan.periods) - 1 }, (_, i) => `<i style="left:${((i + 1) / Number(loan.periods)) * 100}%"></i>`).join('') : ''
  $('owed').textContent = hasLoan ? usd(owed) : '—'
  $('paid').textContent = hasLoan ? usd(loan.totalPaid) : '—'
  if (hasLoan && !defaulted) {
    const since = nowChain() - Number(loan.start)
    const n = Math.min(Math.floor(since / Number(loan.period)) + 1, Number(loan.periods))
    const due = Number(loan.start) + n * Number(loan.period)
    $('next').textContent = `#${n} of ${loan.periods} · ${behind ? 'late' : `in ${mmss(Math.max(0, due - nowChain()))}`}`
  } else $('next').textContent = defaulted ? 'Pay arrears to unlock' : '—'
  $('maxloan').textContent = hasLoan ? '—' : usd(maxLoan)

  // pool card
  $('poolAssets').textContent = usd(assets)
  $('poolCash').textContent = usd(cash)
  $('poolOut').textContent = usd(out)
  $('poolUtil').textContent = assets > 0n ? `${((Number(out) / Number(assets)) * 100).toFixed(1)}%` : '—'
  $('poolAsset').textContent = dep.assetName

  // events + flow
  renderFeed(ctx, top)
  let toL = 0n, toO = 0n
  for (const e of list) if (e.eventName === 'Settled') { toL += e.args.toLender; toO += e.args.toOwner }
  const all = toL + toO
  $('toLender').textContent = usd(toL); $('toOwner').textContent = usd(toO)
  $('splitL').style.width = all > 0n ? `${(Number(toL) / Number(all)) * 100}%` : '0%'
  $('splitWrap').setAttribute('aria-label', `Lender received ${usd(toL)}, operator received ${usd(toO)}`)

  // hero: house lights, badge icon and thumbnail dot follow the lock state
  document.body.dataset.state = defaulted ? 'locked' : hasLoan || rev > 0n ? 'running' : 'idle'
  $('heroVault').textContent = short(vault)
  $('heroLabel').textContent = hasLoan ? 'Loan repaid' : 'Revenue collected'
  $('heroPct').textContent = hasLoan ? `${Math.round(paidPct)}%` : usd(rev)
  $('heroCaption').textContent = hasLoan ? `${usd(loan.totalPaid)} of ${usd(loan.totalOwed0)} repaid` : 'No open loan'
  const pays = list.filter((e) => e.eventName === 'Settled').reverse().slice(-28) // oldest -> newest
  const maxPay = pays.reduce((m, e) => (e.args.amount > m ? e.args.amount : m), 1n)
  $('heroBars').innerHTML = pays.map((e) => `<i class="${e.args.toLender > 0n ? '' : 'lo'}" style="height:${Math.max(10, Math.round((Number(e.args.amount) / Number(maxPay)) * 100))}%"></i>`).join('')
  $('heroBars').setAttribute('aria-label', `${pays.length} recent customer payments; bold green bars include a share sent to the lender`)
  $('heroCount').textContent = `${pays.length} payments`
  $('stripPool').textContent = usd(assets)
  $('stripRevenue').textContent = usd(rev)
  $('stripRepaid').textContent = hasLoan ? usd(loan.totalPaid) : '—'

  renderSteps({ defaulted, hasLoan, revenue: rev, poolFunded: assets > 0n })
  ctx.lastSuccess = Date.now()
  $('loading').hidden = true
  $('app').hidden = false
}

async function loop(ctx) {
  if (!live(ctx) || ctx.refreshing) return
  clearTimeout(pollTimer)
  pollTimer = null
  ctx.refreshing = true
  const retry = $('loading').querySelector('button')
  if (retry) retry.disabled = true
  try {
    await refresh(ctx)
  } catch (e) {
    console.warn('refresh failed', e)
    const text = ctx.lastSuccess
      ? `Connection lost. Displayed data is from ${new Date(ctx.lastSuccess).toLocaleTimeString()}. Retrying automatically…`
      : 'Could not reach the test network. Retrying automatically…'
    networkStatus(ctx, text, true)
  } finally {
    ctx.refreshing = false
    if (live(ctx)) {
      const button = $('loading').querySelector('button')
      if (button) button.disabled = false
      pollTimer = setTimeout(() => loop(ctx), POLL_MS)
    }
  }
}

const initial = setupSelectors()
start_(initial).catch((e) => {
  console.error(e)
  networkStatus(current, 'Could not load the test network. Try again.', true)
})
