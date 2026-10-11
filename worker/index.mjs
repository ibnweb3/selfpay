// Selfpay API (Cloudflare Worker + D1). Serves /api/*; everything else falls through to the static site.
//   Register / sign in: POST /api/auth/challenge -> wallet signs the message -> POST /api/auth/verify  (Sign-In With Ethereum)
//   Account:   GET /api/me, POST /api/auth/logout, POST /api/roles, POST /api/session/role
//   Meter:     POST/GET /api/meter, POST /api/meter/outage, POST /api/meter/restore      (borrowers)
//   Borrow:    GET /api/credit, POST/GET /api/loans
//   Lend:      GET /api/pool (public), POST /api/pool/deposit, GET /api/positions, POST /api/positions/:id/withdraw
//   Activity:  GET /api/activity
import { getAddress, isAddress, recoverMessageAddress } from 'viem'
import { simDayAt, SIM } from '../web/src/terms.mjs'
import { HttpError, json, readBody, requireSameOrigin, rateLimit, readCookie, randomHex, sha256 } from './http.mjs'
import { createDomain } from './domain.mjs'

const ROLES = ['lender', 'borrower']
const COOKIE = 'selfpay_session'
const CHALLENGE_SECONDS = 600
const SESSION_SECONDS = 7 * 24 * 3600
const iso = (seconds) => new Date(seconds * 1000).toISOString()

/** EIP-4361 message. Rebuilt from the stored challenge on verify, so the client cannot alter what was signed. */
export function buildMessage({ domain, uri, address, mode, role, chainId, nonce, issuedAt, expiresAt }) {
  const statement = mode === 'signup'
    ? `Create your Selfpay account as a ${role}. This only proves you own this wallet. It cannot move funds or give Selfpay access to them.`
    : 'Sign in to Selfpay. This only proves you own this wallet. It cannot move funds or give Selfpay access to them.'
  return [
    `${domain} wants you to sign in with your Ethereum account:`,
    address,
    '',
    statement,
    '',
    `URI: ${uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${nonce}`,
    `Issued At: ${iso(issuedAt)}`,
    `Expiration Time: ${iso(expiresAt)}`,
  ].join('\n')
}

function cleanName(value) {
  const name = String(value ?? '').trim().replace(/\s+/g, ' ')
  if (name.length < 2 || name.length > 60 || !/^[\p{L}\p{N} .,'’-]+$/u.test(name)) throw new HttpError(400, 'Enter your name, 2 to 60 letters or digits.')
  return name
}

export function createApp({ now = () => Math.floor(Date.now() / 1000) } = {}) {
  const domain = createDomain()
  const sessionCookie = (token, maxAge) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`

  async function getSession(env, request, nowSec) {
    const token = readCookie(request, COOKIE)
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return null
    const tokenHash = await sha256(token)
    const row = await env.DB.prepare('SELECT address, role FROM sessions WHERE token_hash = ?1 AND expires_at > ?2').bind(tokenHash, nowSec).first()
    return row ? { address: row.address, role: row.role, tokenHash } : null
  }

  async function userView(env, session, nowSec) {
    const user = await env.DB.prepare('SELECT name, created_at FROM users WHERE address = ?1').bind(session.address).first()
    const roles = (await env.DB.prepare('SELECT role FROM profiles WHERE address = ?1 ORDER BY role').bind(session.address).all()).results.map((r) => r.role)
    const meter = await env.DB.prepare('SELECT meter_number FROM meters WHERE address = ?1').bind(session.address).first()
    return {
      address: getAddress(session.address),
      name: user?.name ?? 'Member',
      role: session.role,
      roles,
      meterNumber: meter?.meter_number ?? null,
      memberSinceDay: user ? simDayAt(user.created_at) : null,
    }
  }

  // ---------------------------------------------------------------- registration and sign-in
  async function challenge(env, request, url, nowSec) {
    requireSameOrigin(request, url)
    await rateLimit(env, request, 'challenge', 20, nowSec)
    const body = await readBody(request)
    if (typeof body.address !== 'string' || !isAddress(body.address, { strict: false })) throw new HttpError(400, 'Send a valid wallet address.')
    if (!['signup', 'login'].includes(body.mode)) throw new HttpError(400, 'Choose register or log in.')
    const address = getAddress(body.address)
    const lower = address.toLowerCase()
    const exists = await env.DB.prepare('SELECT 1 AS x FROM users WHERE address = ?1').bind(lower).first()
    let role = null
    let name = null
    if (body.mode === 'signup') {
      if (!ROLES.includes(body.role)) throw new HttpError(400, 'Choose lender or borrower.')
      role = body.role
      name = cleanName(body.name)
      if (exists) throw new HttpError(409, 'This wallet is already registered. Log in instead.')
    } else if (!exists) {
      throw new HttpError(404, 'No Selfpay account for this wallet yet. Register first.')
    }
    const chainId = Number.isInteger(body.chainId) && body.chainId > 0 && body.chainId < 1e9 ? body.chainId : 1
    const nonce = randomHex(16)
    await env.DB.batch([
      env.DB.prepare('DELETE FROM challenges WHERE expires_at < ?1').bind(nowSec - 3600),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?1').bind(nowSec),
      env.DB.prepare('INSERT INTO challenges (nonce, address, mode, role, name, chain_id, issued_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(nonce, lower, body.mode, role, name, chainId, nowSec, nowSec + CHALLENGE_SECONDS),
    ])
    const message = buildMessage({ domain: url.host, uri: url.origin, address, mode: body.mode, role, chainId, nonce, issuedAt: nowSec, expiresAt: nowSec + CHALLENGE_SECONDS })
    return json({ message, expiresAt: nowSec + CHALLENGE_SECONDS })
  }

  async function verify(env, request, url, nowSec) {
    requireSameOrigin(request, url)
    await rateLimit(env, request, 'verify', 20, nowSec)
    const body = await readBody(request)
    if (typeof body.address !== 'string' || !isAddress(body.address, { strict: false })) throw new HttpError(400, 'Send a valid wallet address.')
    if (typeof body.signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(body.signature)) throw new HttpError(400, 'Send the signature from your wallet.')
    const address = getAddress(body.address)
    const lower = address.toLowerCase()
    const ch = await env.DB.prepare('SELECT * FROM challenges WHERE address = ?1 AND used = 0 AND expires_at > ?2 ORDER BY issued_at DESC LIMIT 1').bind(lower, nowSec).first()
    if (!ch) throw new HttpError(401, 'That sign-in request expired. Start again.')
    const message = buildMessage({ domain: url.host, uri: url.origin, address, mode: ch.mode, role: ch.role, chainId: ch.chain_id, nonce: ch.nonce, issuedAt: ch.issued_at, expiresAt: ch.expires_at })
    let recovered
    try { recovered = await recoverMessageAddress({ message, signature: body.signature }) } catch { throw new HttpError(401, 'That signature is not valid.') }
    if (recovered.toLowerCase() !== lower) throw new HttpError(401, 'That signature does not match this wallet.')
    const used = await env.DB.prepare('UPDATE challenges SET used = 1 WHERE nonce = ?1 AND used = 0').bind(ch.nonce).run()
    if (used.meta.changes !== 1) throw new HttpError(401, 'That sign-in request was already used.')

    const token = randomHex(32)
    let role = ch.role
    const statements = []
    if (ch.mode === 'signup') {
      statements.push(
        env.DB.prepare('INSERT INTO users (address, name, created_at) VALUES (?1, ?2, ?3)').bind(lower, ch.name, nowSec),
        env.DB.prepare('INSERT INTO profiles (address, role, created_at, last_login_at) VALUES (?1, ?2, ?3, ?3)').bind(lower, role, nowSec),
        env.DB.prepare('INSERT INTO activity (address, kind, text, amount_cents, day, created_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5)')
          .bind(lower, 'welcome', `Welcome to Selfpay, ${ch.name}. You joined as a ${role}.`, simDayAt(nowSec), nowSec),
      )
    } else {
      const last = await env.DB.prepare('SELECT role FROM profiles WHERE address = ?1 ORDER BY last_login_at DESC LIMIT 1').bind(lower).first()
      if (!last) throw new HttpError(403, 'This account has no role yet. Register again to choose one.')
      role = last.role
      statements.push(env.DB.prepare('UPDATE profiles SET last_login_at = ?3 WHERE address = ?1 AND role = ?2').bind(lower, role, nowSec))
    }
    statements.push(env.DB.prepare('INSERT INTO sessions (token_hash, address, role, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(await sha256(token), lower, role, nowSec, nowSec + SESSION_SECONDS))
    try {
      await env.DB.batch(statements)
    } catch (error) {
      if (/UNIQUE/i.test(String(error?.message))) throw new HttpError(409, 'This wallet is already registered. Log in instead.')
      throw error
    }
    const user = await userView(env, { address: lower, role }, nowSec)
    return json({ user }, 200, { 'set-cookie': sessionCookie(token, SESSION_SECONDS) })
  }

  async function me(env, session, nowSec) {
    return json({ user: session ? await userView(env, session, nowSec) : null, simDay: simDayAt(nowSec), secondsPerDay: SIM.secondsPerDay })
  }

  async function logout(env, request, url) {
    requireSameOrigin(request, url)
    const token = readCookie(request, COOKIE)
    if (token && /^[0-9a-f]{64}$/.test(token)) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(await sha256(token)).run()
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) })
  }

  /** Add the other role to this account (if needed) and switch to it without signing again. */
  async function switchRole(env, request, url, session, nowSec, { create }) {
    requireSameOrigin(request, url)
    if (!session) throw new HttpError(401, 'Sign in first.')
    await rateLimit(env, request, 'write', 60, nowSec)
    const body = await readBody(request)
    if (!ROLES.includes(body.role)) throw new HttpError(400, 'Choose lender or borrower.')
    const has = await env.DB.prepare('SELECT 1 AS x FROM profiles WHERE address = ?1 AND role = ?2').bind(session.address, body.role).first()
    if (!has) {
      if (!create) throw new HttpError(403, `You have not joined as a ${body.role} yet.`)
      await env.DB.batch([
        env.DB.prepare('INSERT INTO profiles (address, role, created_at, last_login_at) VALUES (?1, ?2, ?3, ?3)').bind(session.address, body.role, nowSec),
        env.DB.prepare('INSERT INTO activity (address, kind, text, amount_cents, day, created_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5)')
          .bind(session.address, 'role', `You also joined as a ${body.role}.`, simDayAt(nowSec), nowSec),
      ])
    }
    await env.DB.batch([
      env.DB.prepare('UPDATE sessions SET role = ?2 WHERE token_hash = ?1').bind(session.tokenHash, body.role),
      env.DB.prepare('UPDATE profiles SET last_login_at = ?3 WHERE address = ?1 AND role = ?2').bind(session.address, body.role, nowSec),
    ])
    return json({ user: await userView(env, { ...session, role: body.role }, nowSec) })
  }

  // ---------------------------------------------------------------- routing
  async function route(request, env) {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method
    const nowSec = now()
    const session = await getSession(env, request, nowSec)
    const ctx = { env, request, url, session, nowSec }

    if (pathname === '/api/health' && method === 'GET') return json({ ok: true })
    if (pathname === '/api/auth/challenge' && method === 'POST') return challenge(env, request, url, nowSec)
    if (pathname === '/api/auth/verify' && method === 'POST') return verify(env, request, url, nowSec)
    if (pathname === '/api/auth/logout' && method === 'POST') return logout(env, request, url)
    if (pathname === '/api/me' && method === 'GET') return me(env, session, nowSec)
    if (pathname === '/api/roles' && method === 'POST') return switchRole(env, request, url, session, nowSec, { create: true })
    if (pathname === '/api/session/role' && method === 'POST') return switchRole(env, request, url, session, nowSec, { create: false })

    if (pathname === '/api/meter' && method === 'POST') return domain.registerMeter(ctx)
    if (pathname === '/api/meter' && method === 'GET') return domain.getMeter(ctx)
    if (pathname === '/api/meter/outage' && method === 'POST') return domain.setOutage(ctx)
    if (pathname === '/api/meter/restore' && method === 'POST') return domain.restoreMeter(ctx)

    if (pathname === '/api/credit' && method === 'GET') return domain.credit(ctx)
    if (pathname === '/api/loans' && method === 'POST') return domain.createLoan(ctx)
    if (pathname === '/api/loans' && method === 'GET') return domain.listLoans(ctx)

    if (pathname === '/api/pool' && method === 'GET') return domain.getPool(ctx)
    if (pathname === '/api/pool/deposit' && method === 'POST') return domain.deposit(ctx)
    if (pathname === '/api/positions' && method === 'GET') return domain.listPositions(ctx)
    const match = pathname.match(/^\/api\/positions\/(\d{1,12})\/withdraw$/)
    if (match && method === 'POST') return domain.withdraw({ ...ctx, id: Number(match[1]) })

    if (pathname === '/api/activity' && method === 'GET') return domain.activity(ctx)
    throw new HttpError(404, 'Not found.')
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url)
      if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request)
      try {
        return await route(request, env)
      } catch (error) {
        if (error instanceof HttpError) return json({ error: error.message }, error.status)
        console.error('api error', error)
        return json({ error: 'Something went wrong. Please try again.' }, 500)
      }
    },
  }
}

export default createApp()
