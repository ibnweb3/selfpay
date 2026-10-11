// Landing page: live pool numbers, the "how much could I borrow / earn" calculator, menu, and the cartoon ad box.
import { api, currentUser } from './src/wallet.mjs'
import { $, $$, html, usd, usd0, parseDollars, countUp, FORMATS, revealOnScroll } from './src/ui.mjs'
import { hydrateIcons, icon, BRAND_MARK } from './src/icons.mjs'
import { TERMS, CHAINS } from './src/terms.mjs'
import { maxLoanForRevenue, borrowerSchedule, lenderProjection } from './src/projections.mjs'

for (const el of $$('[data-brand]')) el.innerHTML = BRAND_MARK
hydrateIcons()
revealOnScroll()

// ---- header: shadow on scroll, mobile menu
const header = $('#siteHeader')
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8)
onScroll()
window.addEventListener('scroll', onScroll, { passive: true })

const menuBtn = $('#menuBtn')
const mobileNav = $('#mobileNav')
function setMenu(open) {
  mobileNav.hidden = !open
  menuBtn.setAttribute('aria-expanded', String(open))
  menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu')
  menuBtn.innerHTML = icon(open ? 'close' : 'menu')
}
menuBtn.addEventListener('click', () => setMenu(mobileNav.hidden))
mobileNav.addEventListener('click', (e) => { if (e.target.closest('a')) setMenu(false) })
window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mobileNav.hidden) setMenu(false) })

// ---- if you are already signed in, the header should take you into the app
currentUser().then((user) => {
  if (!user) return
  const login = $('#navLogin')
  const signup = $('#navSignup')
  login.textContent = user.name
  login.href = 'app.html'
  signup.textContent = 'Open my account'
  signup.href = 'app.html'
}).catch(() => {})

// ---- live pool numbers
async function loadPool() {
  try {
    const pool = await api('GET', '/api/pool')
    for (const el of $$('[data-stat]')) {
      const key = el.dataset.stat
      countUp(el, Number(pool[key]), { format: FORMATS[el.dataset.format || 'int'] })
    }
    countUp($('#heroPool'), pool.assetsCents, { format: FORMATS.usd0 })
    renderChains(pool)
  } catch {
    for (const el of $$('[data-stat]')) el.textContent = '—'
    $('#heroPool').textContent = '—'
    $('#chainBars').innerHTML = '<p class="muted">Live numbers are not available right now. Please try again in a moment.</p>'
  }
}

const CHAIN_COLOR = { base: '#2f7fe0', arbitrum: '#2b6cb0', tempo: '#7c4dff' }
function renderChains(pool) {
  const total = Math.max(1, Object.values(pool.chains).reduce((s, c) => s + c.depositedCents, 0))
  $('#chainBars').innerHTML = html`${Object.keys(CHAINS).map((id) => {
    const c = pool.chains[id] || { depositedCents: 0, tokens: {} }
    const share = Math.round((c.depositedCents / total) * 100)
    const tokens = Object.entries(c.tokens).map(([t, v]) => `${t} ${usd0(v)}`).join(' · ') || 'No deposits yet'
    return html`<div class="chainbar" style="--c:${CHAIN_COLOR[id]}">
      <div class="row"><b><i></i>${CHAINS[id].name}</b><b class="num">${usd0(c.depositedCents)}</b></div>
      <div class="bar"><i data-w="${share}"></i></div>
      <small class="muted" style="font-weight:600">${tokens}</small>
    </div>`
  })}`.toString()
  requestAnimationFrame(() => requestAnimationFrame(() => $$('#chainBars .bar > i').forEach((bar) => { bar.style.width = `${bar.dataset.w}%` })))
}
loadPool()

// ---- calculator
const tabs = $$('input[name="calcTab"]')
function showTab() {
  const lender = tabs.find((t) => t.checked)?.value === 'lender'
  $('#calcBorrower').hidden = lender
  $('#calcLender').hidden = !lender
}
tabs.forEach((t) => t.addEventListener('change', showTab))

const range = $('#dailyRange')
function renderBorrower() {
  const daily = Number(range.value)
  $('#dailyOut').textContent = `$${daily}`
  $('#limitList').innerHTML = html`${TERMS.borrowerDurations.map((days) => {
    const limit = maxLoanForRevenue(daily * 100, days)
    const ok = limit >= TERMS.minBorrowUsd * 100
    const weekly = ok ? borrowerSchedule(limit, days).installments[0].amountCents : 0
    return html`<div class="limit-row"><span>${days} days<br><small class="muted">${ok ? `about ${usd0(weekly)} a week` : `below the $${TERMS.minBorrowUsd} minimum`}</small></span><b>${ok ? usd0(limit) : '—'}</b></div>`
  })}`.toString()
  $('#limitNote').textContent = 'Your real limit also depends on your meter score: uptime, steadiness and history.'
}
range.addEventListener('input', renderBorrower)
renderBorrower()

const amountInput = $('#lendAmount')
let lendDays = 30
$('#lendDays').innerHTML = html`${TERMS.lenderHorizons.map((d) => html`<label class="choice"><input type="radio" name="lendDays" value="${d}" ><span>${d}<small>days</small></span></label>`)}`.toString()
$$('input[name="lendDays"]').forEach((input) => { input.checked = Number(input.value) === lendDays })
function renderLender() {
  const dollars = parseDollars(amountInput.value)
  const list = $('#earnList')
  if (!Number.isFinite(dollars) || dollars < TERMS.minLendUsd || dollars > TERMS.maxLendUsd) {
    list.innerHTML = `<div class="warn-note">Enter an amount between $${TERMS.minLendUsd} and $${TERMS.maxLendUsd.toLocaleString('en-US')}.</div>`
    return
  }
  const projection = lenderProjection(Math.round(dollars * 100), lendDays)
  list.innerHTML = html`${Object.values(projection.scenarios).map((s) => html`<div class="limit-row"><span>${s.label}<br><small class="muted">${s.aprPct}% a year</small></span><b>+${usd(s.earnedCents)}</b></div>`)}`.toString()
}
amountInput.addEventListener('input', renderLender)
$('#lendDays').addEventListener('change', (e) => { lendDays = Number(e.target.value); renderLender() })
renderLender()
showTab()

// ---- cartoon: plays only while it is on screen. Geometry is checked on scroll, resize and a slow timer so it never depends on one browser API
const frame = $('#storyFrame')
let lastTold = null
const tell = (msg) => { try { frame.contentWindow.postMessage({ selfpayStory: msg }, location.origin); lastTold = msg } catch { /* frame not ready */ } }
function checkFrame() {
  const r = frame.getBoundingClientRect()
  const visible = !document.hidden && r.height > 0 && r.top < innerHeight * 0.8 && r.bottom > innerHeight * 0.2
  const msg = visible ? 'resume' : 'pause'
  if (msg !== lastTold) tell(msg)
}
window.addEventListener('scroll', () => requestAnimationFrame(checkFrame), { passive: true })
window.addEventListener('resize', checkFrame)
document.addEventListener('visibilitychange', checkFrame)
frame.addEventListener('load', () => { lastTold = null; checkFrame() })
setInterval(checkFrame, 1000)
checkFrame()
