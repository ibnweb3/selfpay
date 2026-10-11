// Shared pieces for the signed-in app: the demo clock, API wrapper with error toasts, and small components.
import { api, ApiError } from '../src/wallet.mjs'
import { html, raw, usd, usd0, toast, runCounters } from '../src/ui.mjs'
import { icon } from '../src/icons.mjs'
import { CHAINS, TOKENS, SIM } from '../src/terms.mjs'

// ------------------------------------------------------------------ demo clock (1 day = secondsPerDay real seconds)
export const clock = { day: 0, secondsPerDay: SIM.secondsPerDay, anchorSeconds: 0, anchorAt: performance.now(), ready: false }

/** Any API response that carries simDay (and secondsIntoDay) re-syncs the clock. */
export function syncClock(data) {
  if (!data || typeof data.simDay !== 'number') return
  clock.secondsPerDay = data.secondsPerDay || clock.secondsPerDay
  if (typeof data.secondsIntoDay === 'number') {
    clock.day = data.simDay
    clock.anchorSeconds = data.secondsIntoDay
    clock.anchorAt = performance.now()
    clock.ready = true
  } else if (!clock.ready) {
    clock.day = data.simDay
    clock.anchorSeconds = 0
    clock.anchorAt = performance.now()
  }
}

export function simNow() {
  const total = clock.anchorSeconds + (performance.now() - clock.anchorAt) / 1000
  const days = Math.floor(total / clock.secondsPerDay)
  return { day: clock.day + days, second: total - days * clock.secondsPerDay, fraction: (total - days * clock.secondsPerDay) / clock.secondsPerDay }
}

export async function call(method, path, body) {
  const data = await api(method, path, body)
  syncClock(data)
  return data
}

/** Run an API call; on failure show the server's message in a toast and return null. */
export async function attempt(work) {
  try { return await work() } catch (error) {
    if (error instanceof ApiError && error.status === 401) { location.href = 'login.html'; return null }
    if (!(error instanceof ApiError)) console.error(error)
    toast(error?.message || 'Something went wrong. Please try again.', 'err')
    return null
  }
}

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
/** "12 days (about 12 min)" - what a number of demo days means on the demo clock. */
export function realTime(simDays) {
  const seconds = simDays * clock.secondsPerDay
  if (seconds < 90) return `${Math.round(seconds)} sec`
  return `${Math.round(seconds / 60)} min`
}

// ------------------------------------------------------------------ components (all return trusted markup via html``)
export const chainName = (id) => CHAINS[id]?.name || id
export const CHAIN_COLOR = { base: '#2f7fe0', arbitrum: '#2b6cb0', tempo: '#7c4dff' }

export function pageTitle(title, text) {
  return html`<div class="page-title"><h1>${title}</h1>${text ? html`<p>${text}</p>` : ''}</div>`
}

export function tile({ label, value, sub, tone = '', count, format = 'usd' }) {
  const val = count === undefined ? html`<strong>${value}</strong>` : html`<strong class="num" data-count="${count}" data-format="${format}">${value ?? ''}</strong>`
  return html`<div class="tile ${tone}"><small>${label}</small>${val}${sub ? html`<span>${sub}</span>` : ''}</div>`
}

const BADGES = {
  active: ['ok', 'Active'], repaid: ['ok', 'Repaid'], defaulted: ['bad', 'Locked'], written_off: ['muted', 'Written off'],
  paid: ['ok', 'Paid'], due: ['warn', 'Due now'], overdue: ['bad', 'Overdue'], upcoming: ['muted', 'Upcoming'],
  online: ['ok live', 'Online'], offline: ['bad', 'Power cut'], withdrawn: ['muted', 'Withdrawn'], locked: ['warn', 'Locked'], open: ['info', 'Unlocked'],
}
export function badge(key, labelOverride) {
  const [tone, label] = BADGES[key] || ['muted', key]
  return html`<span class="badge ${tone}"><i></i>${labelOverride || label}</span>`
}

export function ring({ pct, label, sub, size = 150, color }) {
  const r = 44
  const c = 2 * Math.PI * r
  const clamped = Math.max(0, Math.min(100, pct))
  return html`<div class="ring" style="--size:${size}px"><svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="${r}" fill="none" stroke-width="10"/><circle class="value" cx="50" cy="50" r="${r}" fill="none" stroke-width="10" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-target="${c * (1 - clamped / 100)}" ${color ? raw(`style="stroke:${color}"`) : ''}/></svg><div class="center"><strong>${label}</strong>${sub ? html`<small>${sub}</small>` : ''}</div></div>`
}

/** Animate rings and bars from empty to their value (call after inserting markup). */
export function animateIn(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.ring .value[data-target]').forEach((el) => { el.style.strokeDashoffset = el.dataset.target })
    root.querySelectorAll('.bar > i[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%` })
    root.querySelectorAll('.chart .col i[data-h]').forEach((el) => { el.style.height = `${el.dataset.h}%` })
    root.querySelectorAll('.needle[data-deg]').forEach((el) => { el.style.transform = `rotate(${el.dataset.deg}deg)` })
  }))
}

export function bar(pct, cls = '') {
  return html`<div class="bar ${cls}"><i data-w="${Math.max(0, Math.min(100, pct))}"></i></div>`
}

export function empty({ iconName = 'spark', image, title, text, action }) {
  return html`<div class="empty">${image ? html`<img class="empty-img" src="${image}" alt="">` : raw(icon(iconName))}<h3>${title}</h3><p>${text}</p>${action || ''}</div>`
}

/** Radio pills. name: form name, options: [{value,label,sub?,disabled?}] */
export function pills(name, options, selected) {
  return html`<div class="choices" role="radiogroup">${options.map((o) => html`<label class="choice"><input type="radio" name="${name}" value="${o.value}" ${o.value === selected ? raw('checked') : ''} ${o.disabled ? raw('disabled') : ''}><span>${o.label}${o.sub ? html`<small>${o.sub}</small>` : ''}</span></label>`)}</div>`
}
export const chainOptions = () => Object.values(CHAINS).map((c) => ({ value: c.id, label: c.name, sub: c.testnet }))
export const tokenOptions = () => TOKENS.map((t) => ({ value: t, label: t }))

export const ICON_FOR_KIND = {
  welcome: ['user', ''], role: ['user', 'info'], meter: ['meter', ''], deposit: ['pool', ''], withdraw: ['wallet', 'info'], loan: ['cash', ''],
  outage: ['plug', 'warn'], restore: ['bolt', ''], default: ['alert', 'bad'], lock: ['lock', 'bad'], unlock: ['unlock', ''], cure: ['check', ''], repaid: ['check', ''], write_off: ['alert', 'warn'],
}

export function timeline(items) {
  return html`<ol class="timeline">${items.map((a) => {
    const [name, tone] = ICON_FOR_KIND[a.kind] || ['spark', '']
    return html`<li><span class="t-icon ${tone}">${raw(icon(name))}</span><div><b>${a.text}</b><small>Day ${a.day}</small></div>${a.amountCents ? html`<b class="num">${usd(a.amountCents)}</b>` : html`<span></span>`}</li>`
  })}</ol>`
}

export { html, raw, usd, usd0 }

/**
 * Fetch, render, and keep refreshing. The view is only re-rendered when the data actually changed,
 * so rings and bars do not replay their animation on every poll. `render(data, first)` returns nothing.
 */
export function live(ctx, ms, fetcher, render) {
  let last = null
  let busy = false
  const tick = async (first) => {
    if (busy) return
    busy = true
    try {
      const data = await fetcher()
      if (ctx.alive && !ctx.alive()) return // the user already moved to another screen
      const key = JSON.stringify(data, (k, v) => (k === 'secondsIntoDay' ? undefined : v))
      if (key !== last) { last = key; render(data, first) }
    } catch (error) {
      if (first) ctx.root.innerHTML = String(html`<div class="empty">${raw(icon('alert'))}<h3>We could not load this page</h3><p>${error?.message || 'Please check your connection and try again.'}</p><button class="btn primary" type="button" id="retry">Try again</button></div>`)
      ctx.root.querySelector('#retry')?.addEventListener('click', () => tick(true))
      if (error?.status === 401) location.href = 'login.html'
    } finally { busy = false }
  }
  tick(true)
  if (ms) ctx.every(ms, () => tick(false))
}

/** Put markup in the view, then start rings/bars/counters. */
export function paint(root, markup) {
  root.innerHTML = String(markup)
  root.classList.remove('view-enter')
  void root.offsetWidth
  root.classList.add('view-enter')
  animateIn(root)
  runCounters(root)
}
