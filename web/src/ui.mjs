// Small UI helpers shared by every page: safe templating, formatting, count-up numbers, toasts, modals, scroll reveal.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c])

/** Marks a string as trusted markup so `html` does not escape it again. */
export class Raw { constructor(value) { this.value = value } toString() { return this.value } }
export const raw = (value) => new Raw(value)

/** Tagged template: every interpolated value is HTML-escaped unless it is raw() or a nested html`` result. */
export function html(strings, ...values) {
  let out = strings[0]
  values.forEach((value, i) => {
    const part = Array.isArray(value) ? value.map((v) => (v instanceof Raw ? v.value : esc(v))).join('') : value instanceof Raw ? value.value : esc(value)
    out += part + strings[i + 1]
  })
  return new Raw(out)
}

export const $ = (selector, root = document) => root.querySelector(selector)
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)]

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const money0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
export const usd = (cents) => money.format(cents / 100)
export const usd0 = (cents) => money0.format(cents / 100)
export const pct = (n, digits = 1) => `${Number(n).toLocaleString('en-US', { maximumFractionDigits: digits })}%`
export const kwh = (wh) => `${(wh / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} kWh`
export const num = (n) => Number(n).toLocaleString('en-US')

/** Parse "1,250.50" or "$1250" to a number; NaN when it is not a plain amount. */
export function parseDollars(text) {
  const cleaned = String(text).replace(/[$,\s]/g, '')
  return /^\d+(\.\d{1,2})?$/.test(cleaned) ? Number(cleaned) : NaN
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

/** Counts a number up to its value. Elements need data-count (a number) and optionally data-format="usd|usd0|pct|int". */
export function countUp(el, to, { duration = 900, format = (n) => String(Math.round(n)) } = {}) {
  if (reducedMotion() || !Number.isFinite(to)) { el.textContent = format(to); return }
  const from = Number(el.dataset.last ?? 0)
  el.dataset.last = String(to)
  if (from === to) { el.textContent = format(to); return }
  const start = performance.now()
  const tick = (now) => {
    const t = Math.min(1, (now - start) / duration)
    const eased = 1 - Math.pow(1 - t, 3)
    el.textContent = format(from + (to - from) * eased)
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

export const FORMATS = {
  usd: (cents) => usd(Math.round(cents)),
  usd0: (cents) => usd0(Math.round(cents)),
  pct: (n) => pct(n),
  int: (n) => num(Math.round(n)),
}

/** Animate every [data-count] inside root. */
export function runCounters(root = document) {
  for (const el of $$('[data-count]', root)) countUp(el, Number(el.dataset.count), { format: FORMATS[el.dataset.format || 'int'] })
}

/** Fade/slide elements in as they scroll into view. */
export function revealOnScroll(root = document) {
  const items = $$('.reveal:not(.in)', root)
  if (reducedMotion() || !('IntersectionObserver' in window)) { items.forEach((el) => el.classList.add('in')); return }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target) }
  }, { threshold: 0.12 })
  items.forEach((el, i) => { el.style.setProperty('--d', `${(i % 6) * 70}ms`); io.observe(el) })
  // fallback: anything already on screen (or scrolled past) is revealed even if the observer is slow or unavailable
  const sweep = () => {
    const pending = items.filter((el) => !el.classList.contains('in'))
    for (const el of pending) if (el.getBoundingClientRect().top < window.innerHeight * 0.92) el.classList.add('in')
    return pending.length
  }
  window.addEventListener('scroll', () => requestAnimationFrame(sweep), { passive: true })
  window.addEventListener('resize', sweep)
  const timer = setInterval(() => { if (sweep() === 0) clearInterval(timer) }, 700)
}

let toastTimer
export function toast(text, kind = 'ok') {
  let box = $('#toast')
  if (!box) {
    box = document.createElement('div')
    box.id = 'toast'
    box.setAttribute('role', 'status')
    document.body.append(box)
  }
  box.className = `toast ${kind}`
  box.textContent = text
  box.hidden = false
  requestAnimationFrame(() => box.classList.add('show'))
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { box.classList.remove('show') }, 4200)
}

/** A confirm dialog built on <dialog>. Resolves true when the user confirms. */
export function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel', tone = 'primary' }) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog')
    dialog.className = 'modal'
    dialog.innerHTML = `<form method="dialog" class="modal-body"><h2>${esc(title)}</h2><div class="modal-text">${body instanceof Raw ? body.value : esc(body)}</div>
      <div class="modal-actions"><button class="btn ghost" value="cancel">${esc(cancelText)}</button><button class="btn ${tone}" value="ok" autofocus>${esc(confirmText)}</button></div></form>`
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'ok'); dialog.remove() })
    document.body.append(dialog)
    dialog.showModal()
  })
}

/** Button state while a request runs. */
export async function withBusy(button, label, work) {
  const original = button.innerHTML
  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span>${esc(label)}`
  try { return await work() } finally { button.disabled = false; button.removeAttribute('aria-busy'); button.innerHTML = original }
}

/** A tiny burst of coloured pieces for success moments. */
export function celebrate(origin = document.body) {
  if (reducedMotion()) return
  const box = document.createElement('div')
  box.className = 'burst'
  box.setAttribute('aria-hidden', 'true')
  const colors = ['#c8f169', '#ffb629', '#1f8052', '#2f7fe0', '#ef5d4d']
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement('i')
    piece.style.setProperty('--x', `${(Math.random() - 0.5) * 520}px`)
    piece.style.setProperty('--y', `${-120 - Math.random() * 280}px`)
    piece.style.setProperty('--r', `${Math.random() * 720 - 360}deg`)
    piece.style.background = colors[i % colors.length]
    piece.style.animationDelay = `${Math.random() * 120}ms`
    box.append(piece)
  }
  origin.append(box)
  setTimeout(() => box.remove(), 1800)
}

export const CHAIN_COLORS = { base: '#2f7fe0', arbitrum: '#2b6cb0', tempo: '#7c4dff' }

/** Keeps the dev-only ?mockwallet=label flag when moving between pages (a no-op on the live site). */
export function devCarry(path) {
  const label = new URLSearchParams(location.search).get('mockwallet')
  return label ? `${path}${path.includes('?') ? '&' : '?'}mockwallet=${encodeURIComponent(label)}` : path
}
