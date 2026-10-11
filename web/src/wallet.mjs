// Browser wallet registration / sign-in (Sign-In With Ethereum) and the small API client used by every page.
// No library needed: any EIP-1193 wallet works, and EIP-6963 lets us list several installed wallets.

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(data.error || 'Something went wrong. Please try again.', res.status)
  return data
}

/** Installed wallets. Waits briefly for EIP-6963 announcements, then falls back to window.ethereum. */
export function discoverWallets(waitMs = 350) {
  return new Promise((resolve) => {
    const found = new Map()
    const onAnnounce = (event) => {
      const { info, provider } = event.detail || {}
      if (info && provider) found.set(info.uuid, { id: info.uuid, name: info.name, icon: info.icon, provider })
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      const list = [...found.values()]
      if (!list.length && window.ethereum) list.push({ id: 'injected', name: 'Browser wallet', icon: null, provider: window.ethereum })
      resolve(list)
    }, waitMs)
  })
}

const toHex = (text) => '0x' + [...new TextEncoder().encode(text)].map((b) => b.toString(16).padStart(2, '0')).join('')

/** Friendly text for the errors wallets throw. */
export function describeError(error) {
  if (error?.code === 4001 || /user rejected|denied|cancel/i.test(error?.message || '')) return 'You cancelled in your wallet. Nothing was signed.'
  if (error?.code === -32002) return 'Your wallet already has a request open. Open it and approve or cancel.'
  if (error instanceof ApiError) return error.message
  return error?.message || 'Something went wrong. Please try again.'
}

/**
 * Register ({ mode: 'signup', role, name }) or log in ({ mode: 'login' }) with a wallet signature.
 * The signature proves ownership of the address; it cannot move funds. Resolves with the signed-in user.
 */
export async function authWithWallet(provider, { mode, role, name }) {
  const accounts = await provider.request({ method: 'eth_requestAccounts' })
  const address = accounts?.[0]
  if (!address) throw new Error('Your wallet did not share an account.')
  let chainId = 1
  try { chainId = parseInt(await provider.request({ method: 'eth_chainId' }), 16) || 1 } catch { /* signing does not need a chain */ }
  const request = mode === 'signup' ? { address, mode, role, name, chainId } : { address, mode, chainId }
  const { message } = await api('POST', '/api/auth/challenge', request)
  const signature = await provider.request({ method: 'personal_sign', params: [toHex(message), address] })
  return (await api('POST', '/api/auth/verify', { address, signature })).user
}

export const shortAddress = (address) => `${address.slice(0, 6)}…${address.slice(-4)}`

export async function getMe() {
  try { return await api('GET', '/api/me') } catch { return { user: null } }
}

export async function currentUser() {
  return (await getMe()).user
}

export async function signOut() {
  try { await api('POST', '/api/auth/logout', {}) } catch { /* already signed out */ }
}
