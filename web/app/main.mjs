// The signed-in app: auth gate, hash router, role switch, demo clock, and the "how it works" ad dialog.
import { api, signOut, shortAddress } from '../src/wallet.mjs'
import { $, $$, html, devCarry, confirmDialog, toast, esc } from '../src/ui.mjs'
import { hydrateIcons, icon, BRAND_MARK } from '../src/icons.mjs'
import { call, syncClock, simNow, clock, attempt } from './common.mjs'
import * as borrower from './borrower.mjs'
import * as lender from './lender.mjs'
import { activity } from './activity.mjs'

const ROUTES = {
  borrower: [
    { id: 'overview', label: 'Overview', icon: 'home', view: borrower.overview },
    { id: 'meter', label: 'My meter', icon: 'meter', view: borrower.meter },
    { id: 'borrow', label: 'Borrow', icon: 'cash', view: borrower.borrow },
    { id: 'loan', label: 'My loan', icon: 'list', view: borrower.loan },
    { id: 'activity', label: 'Activity', icon: 'clock', view: activity },
  ],
  lender: [
    { id: 'overview', label: 'Overview', icon: 'home', view: lender.overview },
    { id: 'pool', label: 'Pool', icon: 'pool', view: lender.pool },
    { id: 'deposit', label: 'Deposit', icon: 'cash', view: lender.deposit },
    { id: 'positions', label: 'Positions', icon: 'lock', view: lender.positions },
    { id: 'activity', label: 'Activity', icon: 'clock', view: activity },
  ],
}
const ROLE_LABEL = { borrower: 'Borrower', lender: 'Lender' }

const view = $('#view')
let user = null
let cleanups = []
let current = null
let routeToken = 0

for (const el of $$('[data-brand]')) el.innerHTML = BRAND_MARK
hydrateIcons()

// ------------------------------------------------------------------ boot: must be signed in
const me = await api('GET', '/api/me').catch(() => ({ user: null }))
if (!me.user) { location.replace(devCarry('login.html')); throw new Error('not signed in') }
user = me.user
syncClock(me)
await call('GET', '/api/pool').catch(() => {}) // exact position inside the demo day

// ------------------------------------------------------------------ chrome
function renderChrome() {
  const routes = ROUTES[user.role]
  $('#roleBadge').innerHTML = `<i></i>${ROLE_LABEL[user.role]}`
  $('#sideNav').innerHTML = routes.map((r) => `<a href="#/${r.id}" data-route="${r.id}">${icon(r.icon)}${esc(r.label)}</a>`).join('')
  $('#bottomNav').innerHTML = routes.map((r) => `<a href="#/${r.id}" data-route="${r.id}">${icon(r.icon)}${esc(r.label.replace('My ', ''))}</a>`).join('')
  $('#userCard').innerHTML = `<strong>${esc(user.name)}</strong><span>${esc(shortAddress(user.address))}</span>`
  const switcher = ['borrower', 'lender'].map((role) => `<button type="button" data-role="${role}" aria-pressed="${role === user.role}">${ROLE_LABEL[role]}</button>`).join('')
  $('#roleSwitch').innerHTML = switcher
  $('#roleSwitchMobile').innerHTML = switcher
}

async function switchRole(role) {
  if (role === user.role) return
  if (!user.roles.includes(role)) {
    const ok = await confirmDialog({ title: `Join as a ${role} too?`, body: `You can use the same wallet as both. This adds a ${role} profile to your account. No new signature needed.`, confirmText: `Add ${role} role` })
    if (!ok) return
  }
  const res = await attempt(() => call('POST', user.roles.includes(role) ? '/api/session/role' : '/api/roles', { role }))
  if (!res) return
  user = res.user
  renderChrome()
  location.hash = '#/overview'
  route()
  toast(`You are now using Selfpay as a ${role}.`)
}
document.addEventListener('click', (event) => {
  const button = event.target.closest('[data-role]')
  if (button) switchRole(button.dataset.role)
})

async function logout() {
  await signOut()
  location.href = 'index.html'
}
$('#signOut').addEventListener('click', logout)

// ------------------------------------------------------------------ router
function route() {
  cleanups.forEach((fn) => { try { fn() } catch { /* view already gone */ } })
  cleanups = []
  const routes = ROUTES[user.role]
  const id = location.hash.replace(/^#\/?/, '') || 'overview'
  const entry = routes.find((r) => r.id === id) || routes[0]
  if (entry.id !== id) { history.replaceState(null, '', `#/${entry.id}`) }
  current = entry
  for (const a of $$('[data-route]')) {
    if (a.dataset.route === entry.id) a.setAttribute('aria-current', 'page')
    else a.removeAttribute('aria-current')
  }
  document.title = `${entry.label} · Selfpay`
  window.scrollTo(0, 0)
  const token = ++routeToken
  const ctx = {
    root: view,
    alive: () => token === routeToken,
    user,
    every(ms, fn) { const t = setInterval(() => { if (!document.hidden) fn() }, ms); cleanups.push(() => clearInterval(t)) },
    onCleanup(fn) { cleanups.push(fn) },
    refresh: route,
  }
  entry.view(ctx)
}
window.addEventListener('hashchange', route)

// ------------------------------------------------------------------ demo clock chip
const arc = $('#clockArc')
const dayLabel = $('#clockDay')
function tickClock() {
  const t = simNow()
  dayLabel.textContent = `Day ${t.day}`
  arc.style.strokeDashoffset = String(88 * (1 - t.fraction))
}
tickClock()
setInterval(tickClock, 500)
setInterval(() => { if (!document.hidden) call('GET', '/api/me').catch(() => {}) }, 30_000) // keeps the clock honest

// ------------------------------------------------------------------ the "how it works" ad
function openStory() {
  const dialog = document.createElement('dialog')
  dialog.className = 'modal wide'
  dialog.innerHTML = `<button class="modal-close" type="button" aria-label="Close">${icon('close')}</button><iframe class="story-modal" src="story.html" title="Amina's story: how Selfpay works"></iframe>`
  dialog.addEventListener('close', () => dialog.remove())
  dialog.querySelector('.modal-close').addEventListener('click', () => dialog.close())
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close() })
  document.body.append(dialog)
  dialog.showModal()
}
$('#adOpen').addEventListener('click', openStory)

// ------------------------------------------------------------------ mobile menu
$('#menuOpen').addEventListener('click', () => {
  const dialog = document.createElement('dialog')
  dialog.className = 'modal'
  dialog.innerHTML = `<div class="modal-body"><h2>${esc(user.name)}</h2><p class="mono muted">${esc(shortAddress(user.address))}</p>
    <button class="btn lime block" type="button" data-act="story">${icon('play')} Watch how it works</button>
    <a class="btn ghost block" href="index.html">Home page</a>
    <button class="btn ghost block" type="button" data-act="out">${icon('out')} Log out</button>
    <button class="btn light block" type="button" data-act="close">Close</button></div>`
  dialog.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act
    if (act === 'close' || e.target === dialog) dialog.close()
    if (act === 'story') { dialog.close(); openStory() }
    if (act === 'out') logout()
  })
  dialog.addEventListener('close', () => dialog.remove())
  document.body.append(dialog)
  dialog.showModal()
})

renderChrome()
route()
