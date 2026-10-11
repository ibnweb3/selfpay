// Register (signup.html) and log in (login.html) with a wallet signature.
import { discoverWallets, authWithWallet, describeError, currentUser, signOut, ApiError } from './src/wallet.mjs'
import { $, $$, html, devCarry, withBusy } from './src/ui.mjs'
import { hydrateIcons, BRAND_MARK } from './src/icons.mjs'

const mode = document.documentElement.dataset.mode // 'signup' | 'login'
for (const el of $$('[data-brand]')) el.innerHTML = BRAND_MARK
hydrateIcons()

const form = $('#joinForm')
const errorBox = $('#formError')
const showError = (content) => { errorBox.innerHTML = content; errorBox.hidden = false; errorBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }
const clearError = () => { errorBox.hidden = true }

// ?role=lender|borrower from the landing page pre-selects the role
const wantedRole = new URLSearchParams(location.search).get('role')
if (mode === 'signup' && (wantedRole === 'lender' || wantedRole === 'borrower')) {
  const radio = $(`input[name="role"][value="${wantedRole}"]`)
  if (radio) radio.checked = true
}

// already signed in -> offer to continue instead of registering again
currentUser().then((user) => {
  if (!user) return
  $('#alreadyText').innerHTML = html`You are signed in as <b>${user.name}</b> (${user.role}).`.toString()
  $('#alreadyLink').href = devCarry('app.html')
  $('#already').hidden = false
  const other = document.createElement('button')
  other.type = 'button'
  other.className = 'link-btn'
  other.textContent = 'Use a different account'
  other.addEventListener('click', async () => { await signOut(); location.reload() })
  $('#already').append(other)
}).catch(() => {})

const iconSrc = (icon) => (typeof icon === 'string' && icon.startsWith('data:image/') ? icon : '')

async function start(provider, button) {
  clearError()
  let role
  let name
  if (mode === 'signup') {
    name = $('#name').value.trim().replace(/\s+/g, ' ')
    role = form.elements.role.value
    $('#name').removeAttribute('aria-invalid')
    if (name.length < 2 || name.length > 60 || !/^[\p{L}\p{N} .,'’-]+$/u.test(name)) {
      $('#name').setAttribute('aria-invalid', 'true')
      $('#name').focus()
      showError('Enter your name: 2 to 60 letters or numbers.')
      return
    }
    if (role !== 'lender' && role !== 'borrower') {
      showError('Choose whether you want to borrow or lend.')
      return
    }
  }
  try {
    await withBusy(button, 'Check your wallet…', async () => {
      await authWithWallet(provider, { mode, role, name })
    })
    button.disabled = true
    button.innerHTML = '<span class="spinner" aria-hidden="true"></span>Opening your account…'
    location.href = devCarry('app.html')
  } catch (error) {
    const message = describeError(error)
    if (error instanceof ApiError && error.status === 404 && mode === 'login') showError(`${html`${message}`} <a href="${devCarry('signup.html')}" class="link-btn">Create an account</a>`)
    else if (error instanceof ApiError && error.status === 409 && mode === 'signup') showError(`${html`${message}`} <a href="${devCarry('login.html')}" class="link-btn">Log in instead</a>`)
    else showError(String(html`${message}`))
  }
}

const wallets = await discoverWallets()
const list = $('#wallets')
if (!wallets.length) {
  list.innerHTML = '<div class="info-note"><b>No browser wallet found.</b> Install a wallet such as MetaMask or Rabby, then reload this page. Then you can sign in with one tap.</div>'
} else {
  list.innerHTML = String(html`${wallets.map((w) => html`<button type="button" class="wallet-btn" data-id="${w.id}">${iconSrc(w.icon) ? html`<img src="${iconSrc(w.icon)}" alt="" width="30" height="30">` : html`<i class="ic" data-icon="wallet"></i>`}${mode === 'signup' ? 'Sign up with' : 'Log in with'} ${w.name}</button>`)}`)
  hydrateIcons(list)
  list.addEventListener('click', (event) => {
    const button = event.target.closest('.wallet-btn')
    if (!button) return
    const wallet = wallets.find((w) => w.id === button.dataset.id)
    if (wallet) start(wallet.provider, button)
  })
}
form.addEventListener('submit', (e) => e.preventDefault())
