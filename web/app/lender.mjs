// Lender screens: overview, the shared pool, deposit (with projected earnings), and positions (lock countdown + withdraw).
import { $, usd, usd0, confirmDialog, withBusy, celebrate, toast, parseDollars } from '../src/ui.mjs'
import { icon } from '../src/icons.mjs'
import { TERMS, CHAINS } from '../src/terms.mjs'
import { lenderProjection } from '../src/projections.mjs'
import {
  call, attempt, live, paint, html, raw, tile, badge, ring, bar, empty, pageTitle, pills, chainOptions, tokenOptions, chainName, plural, realTime, CHAIN_COLOR,
} from './common.mjs'

const link = (hash, text, cls = 'btn primary') => html`<a class="${cls}" href="${hash}">${text}</a>`
const go = (hash) => { location.hash = hash }

function chainBars(pool) {
  const total = Math.max(1, Object.values(pool.chains).reduce((s, c) => s + c.depositedCents, 0))
  return html`<div class="stack" style="--gap:18px">${Object.keys(CHAINS).map((id) => {
    const c = pool.chains[id] || { depositedCents: 0, tokens: {} }
    const tokens = Object.entries(c.tokens).map(([t, v]) => `${t} ${usd0(v)}`).join(' · ') || 'No deposits yet'
    return html`<div class="chainbar" style="--c:${CHAIN_COLOR[id]}"><div class="row"><b><i></i>${CHAINS[id].name}</b><b class="num">${usd0(c.depositedCents)}</b></div>${bar(Math.round((c.depositedCents / total) * 100))}<small class="muted" style="font-weight:600">${tokens}</small></div>`
  })}</div>`
}

// ===================================================================================== overview
export function overview(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:140px"></div>`)
  live(ctx, 7000, () => Promise.all([call('GET', '/api/positions'), call('GET', '/api/pool')]), ([pos, pool]) => {
    const active = pos.positions.filter((p) => p.status === 'active')
    const nextUnlock = active.filter((p) => p.locked).sort((a, b) => a.daysLeft - b.daysLeft)[0]
    paint(ctx.root, html`
      ${pageTitle(`Hi, ${ctx.user.name}`, 'Your money is working in the shared pool. Here is how it is doing.')}
      <div class="grid grid-4">
        ${tile({ label: 'Your pool value', count: pos.totals.valueCents, value: usd(pos.totals.valueCents), format: 'usd', tone: 'accent', sub: `${plural(active.length, 'position')}` })}
        ${tile({ label: 'You deposited', count: pos.totals.depositedCents, value: usd(pos.totals.depositedCents), format: 'usd' })}
        ${tile({ label: 'Earned so far', count: pos.totals.earnedCents, value: usd(pos.totals.earnedCents), format: 'usd', tone: 'lime', sub: 'fees paid by borrowers' })}
        ${tile({ label: 'Pool lent out', value: `${pool.utilisationPct}%`, sub: `${usd0(pool.lentCents)} working` })}
      </div>
      <div class="grid grid-2" style="margin-top:20px;align-items:start">
        <section class="card">
          ${active.length ? html`
            <h3>Your positions</h3>
            <div class="stack" style="--gap:12px;margin-top:16px">${active.slice(0, 3).map((p) => html`<div class="row between" style="padding:14px 18px;border-radius:14px;background:var(--lime-soft)"><div><b>${usd(p.amountCents)}</b> <span class="muted" style="font-weight:600">· ${p.token} on ${chainName(p.chain)}</span></div>${p.locked ? badge('locked', `${plural(p.daysLeft, 'day')} left`) : badge('open', 'Ready to withdraw')}</div>`)}</div>
            ${nextUnlock ? html`<p class="hint muted" style="margin-top:14px;font-weight:600">Next unlock in ${plural(nextUnlock.daysLeft, 'demo day')} (about ${realTime(nextUnlock.daysLeft)}).</p>` : ''}
            <div class="row" style="margin-top:20px">${link('#/deposit', html`Add more ${raw(icon('plus'))}`)}${link('#/positions', 'Manage positions', 'btn ghost')}</div>`
          : empty({ iconName: 'pool', title: 'Nothing deposited yet', text: 'Put dollars into the pool, choose a lock, and see what you could earn before you confirm.', action: link('#/deposit', html`Make my first deposit ${raw(icon('arrow'))}`) })}
        </section>
        <section class="card">
          <div class="row between" style="margin-bottom:16px"><h3>Where the pool's money came from</h3>${link('#/pool', 'Pool details', 'btn ghost sm')}</div>
          ${chainBars(pool)}
        </section>
      </div>`)
  })
}

// ===================================================================================== pool
export function pool(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:240px"></div>`)
  live(ctx, 7000, () => call('GET', '/api/pool'), (p) => {
    const share = p.you && p.assetsCents ? (p.you.valueCents / p.assetsCents) * 100 : 0
    paint(ctx.root, html`
      ${pageTitle('The shared pool', 'One pool holds every lender\'s dollars, whichever chain or token they arrived on. Borrowers draw from the whole thing.')}
      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.4fr);gap:20px;align-items:stretch">
        <section class="card" style="display:grid;place-items:center;gap:14px;text-align:center">
          ${ring({ pct: p.utilisationPct, label: `${p.utilisationPct}%`, sub: 'lent out', size: 190 })}
          <p class="muted" style="max-width:30ch;font-weight:600">Only money that is lent out earns fees. The rest waits for borrowers.</p>
        </section>
        <div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-content:start">
          ${tile({ label: 'Pool size', count: p.assetsCents, value: usd(p.assetsCents), format: 'usd0', tone: 'accent', sub: `${plural(p.lenders, 'lender')} · share price $${(p.sharePriceMicro / 1e6).toFixed(4)}` })}
          ${tile({ label: 'Ready to lend', count: p.cashCents, value: usd(p.cashCents), format: 'usd0' })}
          ${tile({ label: 'Lent out', count: p.lentCents, value: usd(p.lentCents), format: 'usd0', tone: 'lime', sub: `${plural(p.activeLoans, 'active loan')}` })}
          ${tile({ label: 'Fees earned', count: p.feesEarnedCents, value: usd(p.feesEarnedCents), format: 'usd', sub: p.writtenOffCents ? `${usd(p.writtenOffCents)} written off` : 'no losses so far' })}
        </div>
      </div>
      <div class="grid grid-2" style="margin-top:20px;align-items:start">
        <section class="card"><h3 style="margin-bottom:16px">Liquidity by chain</h3>${chainBars(p)}</section>
        <section class="card">
          <h3>How the numbers work</h3>
          <ul class="checklist" style="margin-top:16px">
            <li><span class="dot">1</span><span>Borrowers pay a fee on each loan. It is added to the pool.</span></li>
            <li><span class="dot">2</span><span>Everyone owns a share of the pool, so the fee raises the value of every share.</span></li>
            <li><span class="dot">3</span><span>If a loan is never repaid, the pool takes that loss and every share drops a little.</span></li>
          </ul>
          ${p.you ? html`<div class="ok-note" style="margin-top:18px">You own about <b>${share.toFixed(share < 10 ? 2 : 1)}%</b> of the pool, worth <b>${usd(p.you.valueCents)}</b>.</div>` : ''}
          <p class="hint muted" style="margin-top:14px;font-weight:600">${p.note}</p>
        </section>
      </div>
      <div class="row" style="margin-top:22px">${link('#/deposit', html`Deposit into the pool ${raw(icon('arrow'))}`)}</div>`)
  })
}

// ===================================================================================== deposit
export function deposit(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:240px"></div>`)
  live(ctx, 0, () => call('GET', '/api/pool'), (p) => renderDeposit(ctx, p))
}

function renderDeposit(ctx, p) {
  const state = { chain: 'base', token: 'USDC', amount: 500, days: 30 }
  paint(ctx.root, html`
    ${pageTitle('Deposit', 'Choose a chain and token, an amount and a lock. You will see what you could earn before you confirm.')}
    <div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:20px;align-items:start">
      <form class="card" id="depForm" novalidate>
        <div class="field" style="margin-top:0"><span class="label">Chain</span>${pills('chain', chainOptions(), state.chain)}</div>
        <div class="field"><span class="label">Token</span>${pills('token', tokenOptions(), state.token)}</div>
        <div class="field">
          <label for="amount">Amount</label>
          <div class="money"><span>$</span><input id="amount" inputmode="decimal" autocomplete="off" value="${state.amount}"><small>${state.token}</small></div>
          <div class="quick" id="quick">${[50, 100, 500, 1000, 5000].map((v) => html`<button type="button" data-v="${v}">$${v.toLocaleString('en-US')}</button>`)}</div>
          <span class="hint" id="amountHint">From $${TERMS.minLendUsd} to $${TERMS.maxLendUsd.toLocaleString('en-US')}. Test funds, so nothing real is spent.</span>
        </div>
        <div class="field"><span class="label">Lock for</span>${pills('days', TERMS.lenderHorizons.map((d) => ({ value: String(d), label: String(d), sub: 'days' })), String(state.days))}
          <span class="hint">The lock is enforced: you cannot withdraw before it ends.</span></div>
      </form>
      <aside class="card dark" id="depPreview" style="position:sticky;top:20px" aria-live="polite"></aside>
    </div>`)

  const root = ctx.root
  const input = $('#amount', root)
  const hint = $('#amountHint', root)
  const preview = $('#depPreview', root)
  const valid = () => Number.isFinite(state.amount) && state.amount >= TERMS.minLendUsd && state.amount <= TERMS.maxLendUsd

  function render() {
    if (!valid()) {
      preview.innerHTML = String(html`<h3>What you could earn</h3><div class="warn-note" style="margin-top:16px">Enter an amount between $${TERMS.minLendUsd} and $${TERMS.maxLendUsd.toLocaleString('en-US')}.</div>`)
      return
    }
    const cents = Math.round(state.amount * 100)
    const proj = lenderProjection(cents, state.days)
    preview.innerHTML = String(html`
      <h3>What you could earn</h3>
      <p style="color:#b9d8c5;font-weight:600;margin-top:4px">${usd0(cents)} locked for ${state.days} days. Three possible outcomes:</p>
      <div class="stack" style="--gap:12px;margin-top:16px">
        ${Object.entries(proj.scenarios).map(([key, s]) => {
          const sc = TERMS.scenarios[key]
          return html`<div class="scenario ${key}"><div class="row between"><b>${s.label}</b><b class="num">+${usd(s.earnedCents)}</b></div><div class="row between"><small>${Math.round(sc.utilisation * 100)}% lent out · ${sc.defaultRate * 100}% of loans default</small><small>${s.aprPct}% a year</small></div></div>`
        })}
      </div>
      <p style="color:#b9d8c5;font-size:.9375rem;margin-top:14px;font-weight:600">Assumptions, not promises. If more loans default than the cautious case, you could earn less or lose some of your deposit.</p>
      <button class="btn lime block" type="button" id="depSubmit" style="margin-top:16px">Review and deposit</button>`)
    $('#depSubmit', root).addEventListener('click', submit)
  }

  async function submit(event) {
    const button = event.currentTarget // read before the first await: the event clears currentTarget afterwards
    const cents = Math.round(state.amount * 100)
    const ok = await confirmDialog({
      title: `Deposit ${usd(cents)}?`,
      body: html`<p><b>${usd(cents)} ${state.token}</b> from <b>${chainName(state.chain)}</b> goes into the shared pool.</p><p style="margin-top:10px">It is locked for <b>${state.days} demo days</b> (about ${realTime(state.days)}) and cannot be withdrawn earlier. Your return depends on how borrowers repay.</p>`,
      confirmText: `Deposit ${usd0(cents)}`,
    })
    if (!ok) return
    const done = await attempt(() => withBusy(button, 'Depositing…', () => call('POST', '/api/pool/deposit', { chain: state.chain, token: state.token, amountUsd: state.amount, lockDays: state.days })))
    if (done) { celebrate(); toast(`${usd(cents)} is in the pool and earning.`); go('#/positions') }
  }

  input.addEventListener('input', () => {
    const v = parseDollars(input.value)
    state.amount = Number.isFinite(v) ? v : NaN
    input.parentElement.classList.toggle('bad', !valid())
    hint.textContent = valid() ? `From $${TERMS.minLendUsd} to $${TERMS.maxLendUsd.toLocaleString('en-US')}. Test funds, so nothing real is spent.` : `Enter an amount from $${TERMS.minLendUsd} to $${TERMS.maxLendUsd.toLocaleString('en-US')}.`
    render()
  })
  $('#quick', root).addEventListener('click', (e) => {
    const v = e.target.closest('button')?.dataset.v
    if (v) { state.amount = Number(v); input.value = v; hint.textContent = `From $${TERMS.minLendUsd} to $${TERMS.maxLendUsd.toLocaleString('en-US')}. Test funds, so nothing real is spent.`; render() }
  })
  $('#depForm', root).addEventListener('change', (e) => {
    const { name, value } = e.target
    if (name === 'chain') state.chain = value
    if (name === 'token') { state.token = value; $('.money small', root).textContent = value }
    if (name === 'days') state.days = Number(value)
    render()
  })
  $('#depForm', root).addEventListener('submit', (e) => e.preventDefault())
  render()
}

// ===================================================================================== positions
export function positions(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:240px"></div>`)
  live(ctx, 6000, () => call('GET', '/api/positions'), (res) => {
    const title = pageTitle('My positions', 'Each deposit has its own lock. When it ends you can withdraw its current value.')
    if (!res.positions.length) {
      paint(ctx.root, html`${title}${empty({ iconName: 'pool', title: 'No deposits yet', text: 'Your deposits and their lock countdowns appear here.', action: link('#/deposit', 'Make a deposit') })}`)
      return
    }
    paint(ctx.root, html`
      ${title}
      <div class="grid grid-3" style="margin-bottom:20px">
        ${tile({ label: 'Current value', count: res.totals.valueCents, value: usd(res.totals.valueCents), format: 'usd', tone: 'accent' })}
        ${tile({ label: 'Deposited', count: res.totals.depositedCents, value: usd(res.totals.depositedCents), format: 'usd' })}
        ${tile({ label: 'Earned', count: res.totals.earnedCents, value: usd(res.totals.earnedCents), format: 'usd', tone: 'lime' })}
      </div>
      <div class="stack" style="--gap:16px">
        ${res.positions.map((p) => {
          const pct = p.status === 'active' ? ((p.lockDays - p.daysLeft) / p.lockDays) * 100 : 100
          return html`<article class="card position ${p.status}" data-id="${p.id}">
            <div class="row between" style="gap:16px">
              <div><div class="row" style="gap:10px"><h3 style="font-size:1.5rem">${usd(p.amountCents)}</h3><span class="chain-chip" style="--c:${CHAIN_COLOR[p.chain]};padding:6px 14px 6px 10px;font-size:.9375rem"><i></i>${chainName(p.chain)} · ${p.token}</span></div>
              <p class="muted" style="margin-top:6px;font-weight:600">Locked for ${p.lockDays} days from day ${p.createdDay}</p></div>
              <div style="text-align:right"><div class="muted" style="font-weight:600">${p.status === 'active' ? 'Worth now' : 'Withdrawn'}</div><b class="num" style="font:700 1.6rem/1.1 var(--display)">${usd(p.valueCents)}</b><div class="${p.earnedCents >= 0 ? '' : 'neg'}" style="font-weight:700;color:${p.earnedCents >= 0 ? 'var(--green-700)' : 'var(--coral)'}">${p.earnedCents >= 0 ? '+' : ''}${usd(p.earnedCents)}</div></div>
            </div>
            ${p.status === 'active' ? html`
              ${bar(pct, 'thin')}
              <div class="row between"><span style="font-weight:600">${p.locked ? html`${raw(icon('lock'))} Unlocks in ${plural(p.daysLeft, 'day')} · about ${realTime(p.daysLeft)}` : html`${raw(icon('unlock'))} Lock ended`}</span>
              <button class="btn ${p.canWithdraw ? 'primary' : 'ghost'} sm withdraw" type="button" data-id="${p.id}" ${p.canWithdraw ? '' : raw('disabled')}>${p.canWithdraw ? 'Withdraw' : 'Locked'}</button></div>`
            : html`<div class="row">${badge('withdrawn')}</div>`}
          </article>`
        })}
      </div>`)
    ctx.root.querySelectorAll('.withdraw').forEach((button) => button.addEventListener('click', async () => {
      const position = res.positions.find((p) => p.id === Number(button.dataset.id))
      const ok = await confirmDialog({ title: `Withdraw ${usd(position.valueCents)}?`, body: html`Your <b>${position.token}</b> position on <b>${chainName(position.chain)}</b> is worth <b>${usd(position.valueCents)}</b> (${position.earnedCents >= 0 ? '+' : ''}${usd(position.earnedCents)}). It is paid out to your ${chainName(position.chain)} wallet.`, confirmText: 'Withdraw' })
      if (!ok) return
      const done = await attempt(() => withBusy(button, 'Withdrawing…', () => call('POST', `/api/positions/${position.id}/withdraw`, {})))
      if (done) { celebrate(); toast(`Withdrew ${usd(done.valueCents)}.`); ctx.refresh() }
    }))
  })
}
