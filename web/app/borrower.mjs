// Borrower screens: overview, meter (register + live meter), borrow (valuation + loan form), loan tracker.
import { $, $$, usd, usd0, num, countUp, FORMATS, confirmDialog, withBusy, celebrate, toast, parseDollars, reducedMotion } from '../src/ui.mjs'
import { icon } from '../src/icons.mjs'
import { TERMS, CHAINS } from '../src/terms.mjs'
import { borrowerSchedule, onTrack } from '../src/projections.mjs'
import {
  call, attempt, live, paint, html, raw, tile, badge, ring, bar, empty, pageTitle, pills, chainOptions, tokenOptions, chainName, plural, realTime, simNow, clock,
} from './common.mjs'

const MIN_CENTS = TERMS.minBorrowUsd * 100
const link = (hash, text, cls = 'btn primary') => html`<a class="${cls}" href="${hash}">${text}</a>`
const go = (hash) => { location.hash = hash }

// ===================================================================================== overview
export function overview(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:140px"></div>`)
  live(ctx, 7000, () => Promise.all([call('GET', '/api/meter'), call('GET', '/api/credit'), call('GET', '/api/loans')]), ([meterRes, credit, loansRes]) => {
    const meter = meterRes.meter
    const loans = loansRes.loans
    const open = loans.find((l) => l.status === 'active' || l.status === 'defaulted')
    const ev = credit.evaluation
    const steps = [
      { label: 'Create your account', done: true },
      { label: 'Register your meter', done: Boolean(meter) },
      { label: 'Check your borrowing limit', done: Boolean(meter) },
      { label: 'Take your first loan', done: loans.length > 0 },
      { label: 'Repay it from your sales', done: loans.some((l) => l.status === 'repaid') },
    ]
    const nowIdx = steps.findIndex((s) => !s.done)
    let cta
    if (!meter) cta = link('#/meter', html`Register my meter ${raw(icon('arrow'))}`)
    else if (open) cta = link('#/loan', html`See my loan ${raw(icon('arrow'))}`)
    else if (ev?.eligible) cta = link('#/borrow', html`Borrow now ${raw(icon('arrow'))}`)
    else cta = link('#/meter', html`Open my meter ${raw(icon('arrow'))}`)

    paint(ctx.root, html`
      ${pageTitle(`Hi, ${ctx.user.name}`, 'Here is where your unit and your loan stand today.')}
      ${open?.locked ? lockBanner(open) : ''}
      <div class="grid grid-4">
        ${tile({ label: 'Earned by your unit', count: meter?.earnedCents ?? 0, value: usd(meter?.earnedCents ?? 0), format: 'usd', sub: meter ? 'since you registered' : 'register a meter to start' })}
        ${tile({ label: 'You can borrow', count: ev?.eligible ? credit.available?.[28] ?? 0 : 0, value: usd(0), format: 'usd', tone: 'lime', sub: ev?.eligible ? 'over 28 days' : meter ? 'not yet eligible' : 'needs a meter' })}
        ${tile({ label: 'Loan balance', count: open ? open.remainingCents : 0, value: usd(0), format: 'usd', tone: open ? 'accent' : '', sub: open ? `${Math.round(open.progressPct)}% repaid` : 'no open loan' })}
        ${tile({ label: 'Meter', value: meter ? (meter.online ? 'Online' : 'Power cut') : 'None', sub: meter ? meter.number : 'not registered' })}
      </div>
      <div class="grid grid-2" style="margin-top:20px;align-items:start">
        <section class="card">
          <h3>Your next step</h3>
          <ul class="checklist" style="margin:18px 0 24px">${steps.map((s, i) => html`<li class="${s.done ? 'done' : i === nowIdx ? 'now' : ''}"><span class="dot">${s.done ? raw(icon('check')) : i + 1}</span><span>${s.label}</span></li>`)}</ul>
          ${cta}
        </section>
        ${open ? loanSnapshot(open) : meter && ev ? scoreSnapshot(ev, credit) : empty({ iconName: 'meter', image: 'assets/solar-unit.svg', title: 'No meter yet', text: 'Register your meter number and we will start recording how much power your unit sells.', action: link('#/meter', 'Register my meter') })}
      </div>`)
  })
}

function lockBanner(loan) {
  return html`<div class="lockbanner" role="alert">${raw(icon('lock'))}<div><b>Your unit is locked.</b>An instalment is overdue, so all of your sales now go to repay the loan. Pay what is late and the lock lifts. Remaining: ${usd(loan.remainingCents)}.</div></div>`
}

function loanSnapshot(open) {
  return html`<section class="card" style="display:grid;gap:18px;justify-items:center;text-align:center">
    ${ring({ pct: open.progressPct, label: `${Math.round(open.progressPct)}%`, sub: 'repaid', size: 170 })}
    <div><h3>${usd(open.totalCents)} loan</h3><p class="muted">${open.nextDue ? `Next payment ${usd(open.nextDue.amountCents)} in ${plural(Math.max(0, open.nextDue.inDays), 'day')}` : 'All payments made'}</p></div>
    ${link('#/loan', 'Open loan details', 'btn ghost sm')}
  </section>`
}

function scoreSnapshot(ev, credit) {
  return html`<section class="card" style="display:grid;gap:14px;justify-items:center;text-align:center">
    ${ring({ pct: ev.score, label: ev.eligible ? ev.grade : '—', sub: `score ${ev.score}`, size: 170 })}
    <div><h3>${ev.eligible ? `Up to ${usd0(credit.available?.[28] ?? 0)} for 28 days` : 'Not eligible yet'}</h3>
    <p class="muted">${ev.eligible ? 'Based on your meter history.' : ev.reasons[0] || 'Keep your meter online and check back.'}</p></div>
    ${link(ev.eligible ? '#/borrow' : '#/meter', ev.eligible ? 'See my options' : 'Open my meter', 'btn ghost sm')}
  </section>`
}

// ===================================================================================== meter
export function meter(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:240px"></div>`)
  let stopTick = null
  ctx.onCleanup(() => stopTick?.())
  // the live reading is interpolated locally every 250 ms, so only stable fields decide whether the view must be redrawn
  const stable = (r) => ({ ...r, simDay: undefined, live: r.live && { day: r.live.day, online: r.live.online, expectedWh: r.live.expectedWh, whSoFar: r.live.online ? 0 : r.live.whSoFar } })
  live(ctx, 5000, async () => stable(await call('GET', '/api/meter')), (res) => {
    stopTick?.()
    if (!res.meter) { renderRegister(ctx); return }
    stopTick = renderMeter(ctx, res)
  })
}

function renderRegister(ctx) {
  paint(ctx.root, html`
    ${pageTitle('Register your meter', 'Your meter is your proof of income. Once it is connected we record how much power your unit sells, and that history sets how much you can borrow.')}
    <div class="grid grid-2" style="align-items:start">
      <form class="card" id="meterForm" novalidate>
        <h3>Meter details</h3>
        <div class="field">
          <label for="meterNumber">Meter number</label>
          <input class="input" id="meterNumber" name="meterNumber" autocomplete="off" autocapitalize="characters" maxlength="24" placeholder="e.g. SP-100234" required>
          <span class="hint">6 to 20 letters, numbers or dashes. It is printed on your meter or on your power bill.</span>
        </div>
        <div class="field">
          <label for="meterLabel">Name for this unit <span class="muted" style="font-weight:600">(optional)</span></label>
          <input class="input" id="meterLabel" name="label" maxlength="40" placeholder="e.g. Rooftop solar and battery">
        </div>
        <div id="meterError" class="error-note" role="alert" hidden style="margin-top:18px"></div>
        <div class="row" style="margin-top:24px">
          <button class="btn primary" type="submit">Register meter ${raw(icon('arrow'))}</button>
          <button class="btn ghost" type="button" id="sampleMeter">Use a sample number</button>
        </div>
      </form>
      <aside class="card lime">
        <h3>What happens next</h3>
        <ul class="checklist" style="margin-top:16px">
          <li><span class="dot">${raw(icon('meter'))}</span><span>Your meter starts reporting your daily usage and sales.</span></li>
          <li><span class="dot">${raw(icon('chart'))}</span><span>We score your uptime, steadiness and history.</span></li>
          <li><span class="dot">${raw(icon('cash'))}</span><span>You see exactly how much you can borrow, and for how long.</span></li>
        </ul>
        <p class="hint muted" style="margin-top:18px;font-weight:600">The same meter number always gives the same unit, so you can come back to it any time.</p>
      </aside>
    </div>`)
  const form = $('#meterForm', ctx.root)
  const input = $('#meterNumber', ctx.root)
  const errorBox = $('#meterError', ctx.root)
  $('#sampleMeter', ctx.root).addEventListener('click', () => { input.value = `SP-${Math.floor(100000 + Math.random() * 900000)}`; input.focus() })
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    errorBox.hidden = true
    const value = input.value.trim()
    if (!/^[A-Za-z0-9-]{6,20}$/.test(value)) {
      input.setAttribute('aria-invalid', 'true')
      errorBox.textContent = 'Enter 6 to 20 letters, numbers or dashes.'
      errorBox.hidden = false
      return
    }
    input.removeAttribute('aria-invalid')
    const button = $('button[type="submit"]', form)
    try {
      await withBusy(button, 'Connecting…', () => call('POST', '/api/meter', { meterNumber: value, label: $('#meterLabel', ctx.root).value.trim() || undefined }))
      celebrate()
      toast('Meter connected. Your history is ready.')
      ctx.refresh()
    } catch (error) {
      errorBox.textContent = error.message
      errorBox.hidden = false
    }
  })
}

/** The meter dashboard. Returns a function that stops the live ticking. */
function renderMeter(ctx, res) {
  const m = res.meter
  const readings = res.readings
  const maxWh = Math.max(1, ...readings.map((r) => r.kwhWh))
  const stats = res.stats
  const pad = (n) => n.toFixed(2).padStart(6, '0')
  paint(ctx.root, html`
    ${pageTitle(m.label, `Meter ${m.number} · ${m.capacityKw} kW unit · customers pay ${m.tariffCents}¢ per kWh`)}
    ${!m.online ? html`<div class="warn-note" style="margin-bottom:18px"><b>Power cut in progress.</b> Your unit sells nothing until day ${m.outageUntil}. Use this to see what a default looks like. <button class="link-btn" id="restoreTop" type="button">Restore power now</button></div>` : ''}
    <div class="grid" style="grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:20px;align-items:stretch" id="meterTop">
      <section class="meterface" aria-label="Live meter reading">
        <div class="mf-head"><span>${badge(m.online ? 'online' : 'offline')}</span><span class="mono">${m.number}</span></div>
        <div class="mf-label">Power sold today</div>
        <div class="mf-digits"><span id="mfKwh">000.00</span><small>kWh</small></div>
        <div class="mf-row"><div><div class="mf-label">Sales today</div><div class="mf-sub" id="mfRev">$0.00</div></div><div><div class="mf-label">Day on the demo clock</div><div class="mf-sub" id="mfDay">Day ${simNow().day}</div></div></div>
        <div class="mf-track" aria-hidden="true"><i id="mfDayBar"></i></div>
      </section>
      <section class="card">
        <img class="unit-img" src="assets/solar-unit.svg" alt="Your solar and battery unit">
        <h3>Your numbers</h3>
        <div class="grid" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;margin-top:16px">
          ${tile({ label: 'Average day', value: usd(stats.avgDailyRevenueCents), sub: `${(stats.avgDailyWh / 1000).toFixed(1)} kWh` })}
          ${tile({ label: 'Uptime', value: `${stats.uptimePct}%`, sub: 'last 14 days' })}
          ${tile({ label: 'Total sold', value: usd(stats.totalRevenueCents), sub: 'last 14 days' })}
          ${tile({ label: 'Earned since joining', count: m.earnedCents, value: usd(m.earnedCents), format: 'usd', sub: `since day ${m.registeredDay}` })}
        </div>
      </section>
    </div>

    <section class="card" style="margin-top:20px">
      <div class="row between"><h3>Last 14 days</h3><span class="muted" style="font-weight:600">Power sold each day (kWh). Hover a bar for sales.</span></div>
      <div class="chart" role="img" aria-label="Bar chart of the last 14 days of power sold">
        ${readings.map((r) => html`<div class="col ${r.online ? '' : 'off'}" tabindex="0"><em>${(r.kwhWh / 1000).toFixed(1)} kWh · ${usd(r.revenueCents)}${r.online ? '' : ' · power cut'}</em><i data-h="${Math.max(r.online ? 4 : 3, Math.round((r.kwhWh / maxWh) * 100))}"></i><small>${r.day % 100}</small></div>`)}
      </div>
    </section>

    <section class="card" style="margin-top:20px">
      <div class="row between"><div><h3>Test a power cut</h3><p class="muted" style="margin-top:4px;max-width:60ch">Cut the power for a few days to see what happens to a loan: missed sales, a late instalment, then the lock.</p></div></div>
      <form id="outageForm" class="row" style="margin-top:16px;gap:16px">
        ${pills('outageDays', [{ value: '2', label: '2', sub: 'days' }, { value: '5', label: '5', sub: 'days' }, { value: '10', label: '10', sub: 'days' }], '5')}
        <button class="btn danger" type="submit" ${m.online ? '' : raw('disabled')}>${raw(icon('plug'))} Cut the power</button>
        <button class="btn ghost" type="button" id="restoreBtn" ${m.online ? raw('disabled') : ''}>${raw(icon('bolt'))} Restore power</button>
      </form>
    </section>`)

  // ---- live ticking: the reading grows through the demo day without waiting for the next poll
  const kwhEl = $('#mfKwh', ctx.root)
  const revEl = $('#mfRev', ctx.root)
  const dayEl = $('#mfDay', ctx.root)
  const dayBar = $('#mfDayBar', ctx.root)
  const baseWh = res.live.online ? 0 : res.live.whSoFar
  const tick = () => {
    const t = simNow()
    const wh = m.online && res.live.online ? res.live.expectedWh * t.fraction : baseWh
    kwhEl.textContent = pad(wh / 1000)
    revEl.textContent = usd(Math.round((wh / 1000) * m.tariffCents))
    dayEl.textContent = `Day ${t.day}`
    dayBar.style.width = `${(t.fraction * 100).toFixed(1)}%`
  }
  tick()
  const timer = setInterval(tick, reducedMotion() ? 2000 : 250)

  const restore = async (button) => {
    await attempt(() => withBusy(button, 'Restoring…', () => call('POST', '/api/meter/restore', {})))
    toast('Power restored.')
    ctx.refresh()
  }
  $('#restoreBtn', ctx.root)?.addEventListener('click', (e) => restore(e.currentTarget))
  $('#restoreTop', ctx.root)?.addEventListener('click', (e) => restore(e.currentTarget))
  $('#outageForm', ctx.root).addEventListener('submit', async (event) => {
    event.preventDefault()
    const days = Number(new FormData(event.currentTarget).get('outageDays'))
    const ok = await confirmDialog({ title: `Cut the power for ${days} days?`, body: html`Your unit will sell nothing for <b>${days} demo days</b> (about ${realTime(days)}). If you have an open loan, instalments may become late and the unit can lock.`, confirmText: 'Cut the power', tone: 'danger' })
    if (!ok) return
    const done = await attempt(() => call('POST', '/api/meter/outage', { days }))
    if (done) { toast(`Power is out until day ${done.outageUntil}.`); ctx.refresh() }
  })
  return () => clearInterval(timer)
}

// ===================================================================================== borrow
export function borrow(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:240px"></div>`)
  live(ctx, 0, () => call('GET', '/api/credit'), (credit) => renderBorrow(ctx, credit))
}

function renderBorrow(ctx, credit) {
  const title = pageTitle('Borrow', 'Your meter history sets your limit. Choose how much, for how long, and where you want the money.')
  if (!credit.meter) {
    paint(ctx.root, html`${title}${empty({ iconName: 'meter', title: 'Register your meter first', text: 'We need your meter to see how much your unit earns before we can offer a loan.', action: link('#/meter', 'Register my meter') })}`)
    return
  }
  const ev = credit.evaluation
  const scoreCard = html`<section class="card">
    <div class="row between" style="align-items:flex-start;gap:20px">
      <div style="flex:1;min-width:240px"><h3>How we value your meter</h3><p class="muted" style="margin-top:6px">We look at the last ${ev.days} days of power sold. A steadier, longer, always-on record means a higher limit.</p></div>
      ${ring({ pct: ev.score, label: ev.grade, sub: `score ${ev.score}`, size: 130 })}
    </div>
    <div class="stack" style="--gap:16px;margin-top:20px">
      ${factor('Uptime', ev.uptimePct, '45% of the score', 'Days your meter was online')}
      ${factor('Steady income', ev.consistencyPct, '35% of the score', 'How little your daily sales swing')}
      ${factor('History', ev.historyPct, '20% of the score', 'How many days we have seen')}
    </div>
    <p class="hint muted" style="margin-top:18px;font-weight:600">Expected sales: <b>${usd(ev.expectedDailyCents)}</b> a day after a ${Math.round((1 - ev.reliability) * 100)}% reliability haircut. Limit = half of the sales expected over the term, less the fee.</p>
  </section>`

  if (credit.hasOpenLoan) {
    paint(ctx.root, html`${title}<div class="info-note" style="margin-bottom:20px">You already have an open loan. Repay it to borrow again. ${link('#/loan', 'Open my loan', 'link-btn')}</div>${scoreCard}`)
    return
  }
  const durations = TERMS.borrowerDurations.filter((d) => (credit.available?.[d] ?? 0) >= MIN_CENTS)
  if (!ev.eligible || !durations.length) {
    const reason = ev.reasons?.[0] || (credit.poolCashCents < MIN_CENTS ? 'The pool is almost fully lent out right now. Check back soon.' : 'Your limit is below the minimum loan.')
    paint(ctx.root, html`${title}<div class="warn-note" style="margin-bottom:20px"><b>Not available yet.</b> ${reason}</div>${scoreCard}`)
    return
  }

  const state = { days: durations.includes(28) ? 28 : durations[0], amount: 0, chain: 'tempo', token: 'USD' }
  const maxFor = (d) => Math.floor((credit.available[d] ?? 0) / 100)
  const defaultAmount = (d) => Math.max(TERMS.minBorrowUsd, Math.floor((maxFor(d) * 0.6) / 5) * 5)
  state.amount = defaultAmount(state.days)

  paint(ctx.root, html`
    ${title}
    <div class="grid" style="grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:20px;align-items:start" id="borrowGrid">
      <div class="stack" style="--gap:20px">
        ${scoreCard}
        <form class="card" id="loanForm" novalidate>
          <h3>Choose your loan</h3>
          <div class="field"><span class="label">How long</span>
            ${pills('days', TERMS.borrowerDurations.map((d) => ({ value: String(d), label: String(d), sub: durations.includes(d) ? `up to ${usd0((credit.available[d] ?? 0))}` : 'not available', disabled: !durations.includes(d) })), String(state.days))}
          </div>
          <div class="field">
            <label for="amount">How much</label>
            <div class="money"><span>$</span><input id="amount" inputmode="decimal" autocomplete="off" aria-describedby="amountHint"><small id="amountMax"></small></div>
            <input class="range" id="amountRange" type="range" step="5" aria-label="Loan amount">
            <div class="quick" id="quick"></div>
            <span class="hint" id="amountHint"></span>
          </div>
          <div class="field"><span class="label">Receive on</span>${pills('chain', chainOptions(), state.chain)}</div>
          <div class="field"><span class="label">As</span>${pills('token', tokenOptions(), state.token)}</div>
        </form>
      </div>
      <aside class="card dark" id="preview" style="position:sticky;top:20px" aria-live="polite"></aside>
    </div>`)

  const root = ctx.root
  const amountInput = $('#amount', root)
  const range = $('#amountRange', root)
  const hint = $('#amountHint', root)
  const preview = $('#preview', root)

  const setAmount = (value, source) => {
    const max = maxFor(state.days)
    const clamped = Math.max(TERMS.minBorrowUsd, Math.min(max, Math.round(value)))
    state.amount = Number.isFinite(clamped) ? clamped : TERMS.minBorrowUsd
    if (source !== 'input') amountInput.value = String(state.amount)
    if (source !== 'range') range.value = String(state.amount)
    renderPreview()
  }
  const configureRange = () => {
    const max = maxFor(state.days)
    range.min = String(TERMS.minBorrowUsd)
    range.max = String(Math.max(TERMS.minBorrowUsd, max))
    $('#amountMax', root).textContent = `max ${usd0(max * 100)}`
    $('#quick', root).innerHTML = [25, 50, 75, 100].map((p) => `<button type="button" data-pct="${p}">${p === 100 ? 'Max' : `${p}%`}</button>`).join('')
    hint.textContent = `Between $${TERMS.minBorrowUsd} and ${usd0(max * 100)} for ${state.days} days${credit.available[state.days] < (credit.evaluation.limits[state.days] ?? 0) ? ' (limited by the cash in the pool right now)' : ''}.`
  }
  function renderPreview() {
    const cents = state.amount * 100
    const sched = borrowerSchedule(cents, state.days)
    const track = onTrack(cents, state.days, ev.expectedDailyCents)
    const weekly = sched.installments[0].amountCents
    preview.innerHTML = String(html`
      <h3>What you will pay</h3>
      <div style="margin:14px 0 6px;font:700 clamp(2rem,4vw,2.8rem)/1 var(--display);letter-spacing:-.03em">${usd(cents)}</div>
      <p style="color:#b9d8c5;font-weight:600">arrives on ${chainName(state.chain)} as ${state.token}</p>
      <dl class="kv">
        <div><dt>Fee (${(TERMS.feeBps / 100 * state.days / TERMS.baseTermDays).toFixed(2).replace(/\.?0+$/, '')}%)</dt><dd>${usd(sched.feeCents)}</dd></div>
        <div><dt>You repay in total</dt><dd>${usd(sched.totalCents)}</dd></div>
        <div><dt>${plural(sched.periods, 'weekly instalment')}</dt><dd>${usd(weekly)}</dd></div>
        <div><dt>Daily sales needed</dt><dd>${usd(sched.dailyRevenueNeededCents)}</dd></div>
        <div><dt>Your unit usually sells</dt><dd>${usd(ev.expectedDailyCents)}</dd></div>
      </dl>
      <div class="${track.onTrack ? 'ok-note' : 'warn-note'}" style="margin:16px 0">${track.onTrack ? `On track: at your usual sales this loan clears in about ${track.daysToRepay} days.` : 'Tight: at your usual sales this may run late. Consider a smaller amount or a longer term.'}</div>
      <button class="btn lime block" type="button" id="submitLoan">Review and borrow</button>
      <p style="color:#b9d8c5;font-size:.9375rem;margin-top:12px;font-weight:600">70% of every customer payment goes to the pool until the loan is repaid. You keep the rest.</p>`)
    $('#submitLoan', root).addEventListener('click', submit)
  }
  async function submit(event) {
    const button = event.currentTarget // read before the first await: the event clears currentTarget afterwards
    const cents = state.amount * 100
    const sched = borrowerSchedule(cents, state.days)
    const ok = await confirmDialog({
      title: `Borrow ${usd(cents)}?`,
      body: html`<p>You will receive <b>${usd(cents)}</b> on <b>${chainName(state.chain)}</b> as <b>${state.token}</b> and repay <b>${usd(sched.totalCents)}</b> over <b>${state.days} days</b>.</p><p style="margin-top:10px">If an instalment is more than ${TERMS.graceDays} days late, your unit locks and all sales go to the lender until you catch up.</p>`,
      confirmText: `Borrow ${usd0(cents)}`,
    })
    if (!ok) return
    const done = await attempt(() => withBusy(button, 'Sending…', () => call('POST', '/api/loans', { amountUsd: state.amount, days: state.days, payoutChain: state.chain, payoutToken: state.token })))
    if (done) { celebrate(); toast(`${usd(cents)} is on its way to your ${chainName(state.chain)} wallet.`); go('#/loan') }
  }

  configureRange()
  setAmount(state.amount)
  amountInput.addEventListener('input', () => {
    const v = parseDollars(amountInput.value)
    if (Number.isFinite(v)) { state.amount = Math.max(TERMS.minBorrowUsd, Math.min(maxFor(state.days), Math.round(v))); range.value = String(state.amount); renderPreview() }
  })
  amountInput.addEventListener('blur', () => setAmount(state.amount))
  range.addEventListener('input', () => setAmount(Number(range.value), 'range'))
  $('#quick', root).addEventListener('click', (e) => {
    const p = e.target.closest('button')?.dataset.pct
    if (p) setAmount((maxFor(state.days) * Number(p)) / 100)
  })
  $('#loanForm', root).addEventListener('change', (e) => {
    const { name, value } = e.target
    if (name === 'days') { state.days = Number(value); configureRange(); setAmount(Math.min(state.amount, maxFor(state.days))) }
    if (name === 'chain') { state.chain = value; renderPreview() }
    if (name === 'token') { state.token = value; renderPreview() }
  })
  $('#loanForm', root).addEventListener('submit', (e) => e.preventDefault())
}

function factor(label, pct, weight, hint) {
  return html`<div class="factor"><div class="row"><b>${label}</b><span class="num" style="font-weight:700">${Math.round(pct)}%</span></div>${bar(pct, pct < 60 ? 'bad' : '')}<small class="muted" style="font-weight:600">${hint} · ${weight}</small></div>`
}

// ===================================================================================== loan
export function loan(ctx) {
  paint(ctx.root, html`<div class="skeleton" style="height:240px"></div>`)
  live(ctx, 6000, () => call('GET', '/api/loans'), (res) => {
    const loans = res.loans
    const title = pageTitle('My loan', 'Every customer payment repays the pool first. Watch it happen on the demo clock.')
    if (!loans.length) {
      paint(ctx.root, html`${title}${empty({ iconName: 'cash', title: 'No loans yet', text: 'When you borrow, your loan and its repayments show up here.', action: link('#/borrow', 'See what I can borrow') })}`)
      return
    }
    const current = loans.find((l) => l.status === 'active' || l.status === 'defaulted') || loans[0]
    const past = loans.filter((l) => l.id !== current.id)
    const closed = current.status === 'repaid' || current.status === 'written_off'
    paint(ctx.root, html`
      ${title}
      ${current.locked ? lockBanner(current) : ''}
      ${closed ? html`<div class="${current.status === 'repaid' ? 'ok-note' : 'warn-note'}" style="margin-bottom:18px">${current.status === 'repaid' ? 'This loan is fully repaid. You keep 100% of your sales again.' : 'This loan was written off after a long default.'} ${current.status === 'repaid' ? link('#/borrow', 'Borrow again', 'link-btn') : ''}</div>` : ''}
      <section class="card">
        <div class="row" style="gap:clamp(18px,4vw,40px);align-items:center">
          ${ring({ pct: current.progressPct, label: `${Math.round(current.progressPct)}%`, sub: 'repaid', size: 190 })}
          <div style="flex:1;min-width:260px">
            <div class="row" style="gap:12px;margin-bottom:6px"><h3 style="font-size:1.6rem">${usd(current.principalCents)} for ${current.days} days</h3>${badge(current.status)}</div>
            <p class="muted">Received on ${chainName(current.payoutChain)} as ${current.payoutToken} · opened on day ${current.openedDay}</p>
            <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;margin-top:18px">
              ${tile({ label: 'Total to repay', value: usd(current.totalCents), sub: `fee ${usd(current.feeCents)}` })}
              ${tile({ label: 'Paid so far', count: current.paidCents, value: usd(current.paidCents), format: 'usd', tone: 'lime' })}
              ${tile({ label: 'Remaining', count: current.remainingCents, value: usd(current.remainingCents), format: 'usd', tone: closed ? '' : 'accent' })}
            </div>
            ${current.nextDue && !closed ? html`<p style="margin-top:16px;font-weight:600">Next: instalment ${current.nextDue.number}, <b>${usd(current.nextDue.amountCents)}</b>, due day ${current.nextDue.dueDay} (${current.nextDue.inDays <= 0 ? 'now' : `in ${plural(current.nextDue.inDays, 'day')}`}).</p>` : ''}
          </div>
        </div>
      </section>

      <section class="card" style="margin-top:20px">
        <h3>Instalments</h3>
        <div class="installments" style="margin-top:16px">
          ${current.installments.map((i) => html`<div class="inst ${i.state}"><small>#${i.number} · day ${i.dueDay}</small><strong>${usd(i.amountCents)}</strong>${badge(i.state)}</div>`)}
        </div>
        <p class="hint muted" style="margin-top:14px;font-weight:600">Pay on time and nothing changes. More than ${TERMS.graceDays} days late and the unit locks.</p>
      </section>

      <section class="card" style="margin-top:20px">
        <h3>Where your customers' money went</h3>
        ${current.payments.length ? html`<div class="table-wrap" style="margin-top:12px"><table><thead><tr><th>Day</th><th>Customer sales</th><th>To the pool</th><th>To you</th></tr></thead><tbody>
          ${current.payments.map((p) => html`<tr><td>Day ${p.day}</td><td>${usd(p.revenueCents)}</td><td>${usd(p.toPoolCents)}</td><td>${usd(p.toBorrowerCents)}</td></tr>`)}
        </tbody></table></div>` : html`<p class="muted" style="margin-top:8px">Payments appear here as each demo day finishes (about one a minute).</p>`}
      </section>

      ${past.length ? html`<section class="card" style="margin-top:20px"><h3>Earlier loans</h3><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Loan</th><th>Amount</th><th>Repaid</th><th>Status</th></tr></thead><tbody>
        ${past.map((l) => html`<tr><td>#${l.id} · ${l.days} days</td><td>${usd(l.principalCents)}</td><td>${usd(l.paidCents)}</td><td>${badge(l.status)}</td></tr>`)}</tbody></table></div></section>` : ''}
      <p class="hint muted" style="margin-top:18px;font-weight:600">Want to see a lock? Cut the power on <a href="#/meter" style="font-weight:700;text-decoration:underline">your meter</a> and watch the instalments.</p>`)
  })
}
