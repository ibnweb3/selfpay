// Small HTTP helpers shared by the Worker modules.
const encoder = new TextEncoder()
const MAX_BODY_BYTES = 4096

export class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

export const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
export const randomHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)))
export const sha256 = async (text) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text))))

export const baseHeaders = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
}
export const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), { status, headers: { ...baseHeaders, ...extra } })

export async function readBody(request) {
  const type = request.headers.get('content-type') || ''
  if (!type.includes('application/json')) throw new HttpError(415, 'Send JSON.')
  const text = await request.text()
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.')
  try {
    const body = JSON.parse(text)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    return body
  } catch {
    throw new HttpError(400, 'Invalid JSON.')
  }
}

/** State-changing requests must come from our own pages (blocks cross-site posts even when cookies are sent). */
export function requireSameOrigin(request, url) {
  if (request.headers.get('origin') !== url.origin) throw new HttpError(403, 'Cross-origin request blocked.')
}

export async function rateLimit(env, request, route, max, nowSec) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown'
  const bucket = await sha256(`${route}|${ip}`)
  const row = await env.DB.prepare(
    `INSERT INTO hits (bucket, n, reset_at) VALUES (?1, 1, ?2)
     ON CONFLICT(bucket) DO UPDATE SET
       n = CASE WHEN reset_at <= ?3 THEN 1 ELSE n + 1 END,
       reset_at = CASE WHEN reset_at <= ?3 THEN ?2 ELSE reset_at END
     RETURNING n`,
  ).bind(bucket, nowSec + 60, nowSec).first()
  if (row.n > max) throw new HttpError(429, 'Too many requests. Wait a minute and try again.')
}

export function readCookie(request, name) {
  const header = request.headers.get('cookie') || ''
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=')
  }
  return null
}

/** "1250.50" -> 125050 cents; rejects more than two decimals, NaN, negatives. */
export function parseUsd(value, label = 'Amount') {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new HttpError(400, `${label}: enter an amount in dollars.`)
  const cents = Math.round(value * 100)
  if (Math.abs(value * 100 - cents) > 1e-6) throw new HttpError(400, `${label}: use at most two decimal places.`)
  return cents
}
