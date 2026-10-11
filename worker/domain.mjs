// Selfpay's domain endpoints: meters, collateral valuation, the shared pool, positions and loans.
// Every handler gets { env, request, url, session, nowSec } and returns a Response (see index.mjs for routing and auth).
import { TERMS, CHAINS, TOKENS, SIM, VALUATION, simDayAt } from '../web/src/terms.mjs'
import { lenderProjection, InputError } from '../web/src/projections.mjs'
import { HttpError, json, readBody, parseUsd, requireSameOrigin, rateLimit } from './http.mjs'
import { accrue } from './accrual.mjs'
import {
  SimInputError, normalizeMeterNumber, meterProfile, readingFor, liveReading, isOnline, evaluateCollateral,
  scheduleFor, poolAssets, sharesForDeposit, valueOfShares,
} from './sim.mjs'

const ROLES = ['lender', 'borrower']
const MAX_ACTIVITY = 30

const requireRole = (session, role) => {
  if (!session) throw new HttpError(401, 'Sign in first.')
  if (session.role !== role) throw new HttpError(403, `This is for ${role === 'lender' ? 'lenders' : 'borrowers'}. Switch your role first.`)
}
const clock = (nowSec) => ({ simDay: simDayAt(nowSec), secondsPerDay: SIM.secondsPerDay, secondsIntoDay: Math.max(0, nowSec - SIM.epoch) % SIM.secondsPerDay })
const logStmt = (DB, address, kind, text, amountCents, nowSec) =>
  DB.prepare('INSERT INTO activity (address, kind, text, amount_cents, day, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(address, kind, text, amountCents ?? null, simDayAt(nowSec), nowSec)

const usd = (cents) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

async function loadPool(DB) {
  return DB.prepare('SELECT * FROM pool_state WHERE id = 1').first()
}

async function loadMeter(DB, address) {
  return DB.prepare('SELECT * FROM meters WHERE address = ?1').bind(address).first()
}

async function lastReadings(DB, meterId, count) {
  const rows = (await DB.prepare('SELECT day, kwh_wh, revenue_cents, online FROM meter_readings WHERE meter_id = ?1 ORDER BY day DESC LIMIT ?2').bind(meterId, count).all()).results
  return rows.reverse().map((r) => ({ day: r.day, kwhWh: r.kwh_wh, revenueCents: r.revenue_cents, online: Boolean(r.online) }))
}

function meterView(meter, nowSec) {
  const today = simDayAt(nowSec)
  return {
    number: meter.meter_number,
    label: meter.label,
    capacityKw: meter.capacity_dkw / 10,
    tariffCents: meter.tariff_cents,
    registeredDay: meter.registered_day,
    online: isOnline(meter, today),
    outageUntil: meter.outage_until != null && meter.outage_until > today ? meter.outage_until : null,
    earnedCents: meter.earned_cents,
  }
}

function installmentStates(loan, schedule, today) {
  let cumulative = 0
  return schedule.installments.map((i) => {
    cumulative += i.amountCents
    const dueDay = loan.opened_day + i.dueDay
    let state = 'upcoming'
    if (loan.paid_cents >= cumulative) state = 'paid'
    else if (today > dueDay + TERMS.graceDays) state = 'overdue'
    else if (today >= dueDay) state = 'due'
    return { number: i.number, dueDay, amountCents: i.amountCents, state }
  })
}

async function loanView(DB, loan, today) {
  const schedule = scheduleFor(loan.principal_cents, loan.days)
  const installments = installmentStates(loan, schedule, today)
  const payments = (await DB.prepare('SELECT day, revenue_cents, to_pool_cents, to_borrower_cents FROM loan_payments WHERE loan_id = ?1 ORDER BY day DESC LIMIT 12').bind(loan.id).all()).results
  const next = installments.find((i) => i.state !== 'paid') || null
  return {
    id: loan.id,
    status: loan.status,
    locked: Boolean(loan.locked),
    principalCents: loan.principal_cents,
    feeCents: loan.fee_cents,
    totalCents: loan.total_cents,
    paidCents: loan.paid_cents,
    remainingCents: loan.total_cents - loan.paid_cents,
    progressPct: Math.round((loan.paid_cents / loan.total_cents) * 1000) / 10,
    days: loan.days,
    openedDay: loan.opened_day,
    closedDay: loan.closed_day,
    payoutChain: loan.payout_chain,
    payoutToken: loan.payout_token,
    installments,
    nextDue: next && { number: next.number, dueDay: next.dueDay, amountCents: next.amountCents, inDays: next.dueDay - today },
    payments: payments.map((p) => ({ day: p.day, revenueCents: p.revenue_cents, toPoolCents: p.to_pool_cents, toBorrowerCents: p.to_borrower_cents })),
  }
}

function positionView(p, pool, today) {
  const valueCents = p.status === 'active' ? valueOfShares(pool, p.shares) : p.withdrawn_cents
  const locked = p.status === 'active' && today < p.locked_until_day
  return {
    id: p.id,
    chain: p.chain,
    token: p.token,
    amountCents: p.amount_cents,
    lockDays: p.lock_days,
    createdDay: p.created_day,
    lockedUntilDay: p.locked_until_day,
    status: p.status,
    valueCents,
    earnedCents: valueCents - p.amount_cents,
    locked,
    daysLeft: locked ? p.locked_until_day - today : 0,
    canWithdraw: p.status === 'active' && !locked && pool.cash_cents >= valueCents,
  }
}

export function createDomain() {
  // ---------------------------------------------------------------- meter
  async function registerMeter({ env, request, url, session, nowSec }) {
    requireSameOrigin(request, url)
    requireRole(session, 'borrower')
    await rateLimit(env, request, 'write', 60, nowSec)
    const body = await readBody(request)
    let number
    try { number = normalizeMeterNumber(body.meterNumber) } catch (e) { if (e instanceof SimInputError) throw new HttpError(400, e.message); throw e }
    const label = typeof body.label === 'string' && /^[\p{L}\p{N} .,'’&+-]{1,40}$/u.test(body.label.trim()) ? body.label.trim() : 'My solar + battery unit'
    if (await loadMeter(env.DB, session.address)) throw new HttpError(409, 'You have already registered a meter.')

    const today = simDayAt(nowSec)
    const profile = meterProfile(number)
    let inserted
    try {
      inserted = await env.DB.prepare(
        `INSERT INTO meters (address, meter_number, label, capacity_dkw, tariff_cents, seed, registered_day, last_day, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(session.address, number, label, profile.capacityDkw, profile.tariffCents, profile.seed, today, today - 1, nowSec).run()
    } catch (error) {
      if (/UNIQUE/i.test(String(error?.message))) throw new HttpError(409, 'That meter number is already registered to another account.')
      throw error
    }
    const meterId = inserted.meta.last_row_id
    // the meter was already connected to the unit, so its recent history is available straight away
    const meter = { id: meterId, seed: profile.seed, capacity_dkw: profile.capacityDkw, tariff_cents: profile.tariffCents, outage_from: null, outage_until: null }
    const statements = []
    for (let day = today - VALUATION.meterBackfillDays; day <= today - 1; day++) {
      const r = readingFor(meter, day)
      statements.push(env.DB.prepare('INSERT OR IGNORE INTO meter_readings (meter_id, day, kwh_wh, revenue_cents, online) VALUES (?1, ?2, ?3, ?4, ?5)').bind(meterId, day, r.kwhWh, r.revenueCents, 1))
    }
    statements.push(logStmt(env.DB, session.address, 'meter', `Registered meter ${number} (${profile.capacityDkw / 10} kW unit).`, null, nowSec))
    await env.DB.batch(statements)
    return json({ meter: meterView(await loadMeter(env.DB, session.address), nowSec) }, 201)
  }

  async function getMeter({ env, session, nowSec }) {
    if (!session) throw new HttpError(401, 'Sign in first.')
    await accrue(env, nowSec)
    const meter = await loadMeter(env.DB, session.address)
    if (!meter) return json({ meter: null, ...clock(nowSec) })
    const readings = await lastReadings(env.DB, meter.id, VALUATION.historyWindowDays)
    const recent = readings.slice(-14)
    const t = clock(nowSec)
    const avg = (rows, key) => (rows.length ? Math.round(rows.reduce((s, r) => s + r[key], 0) / rows.length) : 0)
    return json({
      meter: meterView(meter, nowSec),
      ...t,
      live: liveReading(meter, t.simDay, t.secondsIntoDay / t.secondsPerDay),
      readings: recent,
      stats: {
        avgDailyRevenueCents: avg(recent, 'revenueCents'),
        avgDailyWh: avg(recent, 'kwhWh'),
        uptimePct: recent.length ? Math.round((recent.filter((r) => r.online).length / recent.length) * 1000) / 10 : 0,
        totalWh: recent.reduce((s, r) => s + r.kwhWh, 0),
        totalRevenueCents: recent.reduce((s, r) => s + r.revenueCents, 0),
      },
    })
  }

  async function setOutage({ env, request, url, session, nowSec }) {
    requireSameOrigin(request, url)
    requireRole(session, 'borrower')
    await rateLimit(env, request, 'write', 60, nowSec)
    const body = await readBody(request)
    if (!Number.isInteger(body.days) || body.days < 1 || body.days > 14) throw new HttpError(400, 'Choose an outage of 1 to 14 days.')
    const meter = await loadMeter(env.DB, session.address)
    if (!meter) throw new HttpError(404, 'Register your meter first.')
    const today = simDayAt(nowSec)
    await env.DB.batch([
      env.DB.prepare('UPDATE meters SET outage_from = ?2, outage_until = ?3 WHERE id = ?1').bind(meter.id, today, today + body.days),
      logStmt(env.DB, session.address, 'outage', `Power cut on your meter for ${body.days} days.`, null, nowSec),
    ])
    return json({ ok: true, outageUntil: today + body.days })
  }

  async function restoreMeter({ env, request, url, session, nowSec }) {
    requireSameOrigin(request, url)
    requireRole(session, 'borrower')
    const meter = await loadMeter(env.DB, session.address)
    if (!meter) throw new HttpError(404, 'Register your meter first.')
    await env.DB.batch([
      env.DB.prepare('UPDATE meters SET outage_from = NULL, outage_until = NULL WHERE id = ?1').bind(meter.id),
      logStmt(env.DB, session.address, 'restore', 'Power restored on your meter.', null, nowSec),
    ])
    return json({ ok: true })
  }

  // ---------------------------------------------------------------- collateral valuation
  async function credit({ env, session, nowSec }) {
    requireRole(session, 'borrower')
    await accrue(env, nowSec)
    const meter = await loadMeter(env.DB, session.address)
    if (!meter) return json({ meter: null, ...clock(nowSec) })
    const readings = await lastReadings(env.DB, meter.id, VALUATION.historyWindowDays)
    const evaluation = evaluateCollateral(readings)
    const pool = await loadPool(env.DB)
    const open = await env.DB.prepare("SELECT id FROM loans WHERE address = ?1 AND status IN ('active', 'defaulted') LIMIT 1").bind(session.address).first()
    const available = {}
    for (const [days, limit] of Object.entries(evaluation.limits)) available[days] = Math.min(limit, pool.cash_cents)
    return json({
      meter: meterView(meter, nowSec),
      ...clock(nowSec),
      evaluation,
      poolCashCents: pool.cash_cents,
      available,
      hasOpenLoan: Boolean(open),
      terms: { feeBps: TERMS.feeBps, repayBps: TERMS.repayBps, advanceBps: TERMS.advanceBps, graceDays: TERMS.graceDays },
    })
  }

  // ---------------------------------------------------------------- loans
  async function createLoan({ env, request, url, session, nowSec }) {
    requireSameOrigin(request, url)
    requireRole(session, 'borrower')
    await rateLimit(env, request, 'write', 60, nowSec)
    const body = await readBody(request)
    const principalCents = parseUsd(body.amountUsd)
    if (!TERMS.borrowerDurations.includes(body.days)) throw new HttpError(400, `Choose a duration of ${TERMS.borrowerDurations.join(', ')} days.`)
    if (!CHAINS[body.payoutChain]) throw new HttpError(400, 'Choose where to receive the funds: Base, Arbitrum or Tempo.')
    if (!TOKENS.includes(body.payoutToken)) throw new HttpError(400, 'Choose USDC, USDT or USD.')
    if (principalCents < TERMS.minBorrowUsd * 100 || principalCents > TERMS.maxBorrowUsd * 100) {
      throw new HttpError(400, `Amount must be between $${TERMS.minBorrowUsd} and $${TERMS.maxBorrowUsd.toLocaleString('en-US')}.`)
    }
    await accrue(env, nowSec)
    const meter = await loadMeter(env.DB, session.address)
    if (!meter) throw new HttpError(409, 'Register your meter before borrowing.')
    const open = await env.DB.prepare("SELECT id FROM loans WHERE address = ?1 AND status IN ('active', 'defaulted') LIMIT 1").bind(session.address).first()
    if (open) throw new HttpError(409, 'You already have an open loan. Repay it before borrowing again.')
    const evaluation = evaluateCollateral(await lastReadings(env.DB, meter.id, VALUATION.historyWindowDays))
    if (!evaluation.eligible) throw new HttpError(409, evaluation.reasons[0] || 'Your meter does not qualify yet.')
    const limit = evaluation.limits[body.days] || 0
    if (principalCents > limit) throw new HttpError(409, `Your meter supports up to ${usd(limit)} over ${body.days} days.`)

    const schedule = scheduleFor(principalCents, body.days)
    const today = simDayAt(nowSec)
    // take the money from the pool first; the guard makes it impossible to lend cash the pool does not have
    const taken = await env.DB.prepare('UPDATE pool_state SET cash_cents = cash_cents - ?1, lent_cents = lent_cents + ?1 WHERE id = 1 AND cash_cents >= ?1').bind(principalCents).run()
    if (taken.meta.changes !== 1) throw new HttpError(409, 'The pool does not have that much available right now. Try a smaller amount or a shorter wait.')
    try {
      const res = await env.DB.prepare(
        `INSERT INTO loans (address, meter_id, principal_cents, fee_cents, total_cents, days, opened_day, last_day, payout_chain, payout_token, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7, ?8, ?9, ?10)`,
      ).bind(session.address, meter.id, principalCents, schedule.feeCents, schedule.totalCents, body.days, today, body.payoutChain, body.payoutToken, nowSec).run()
      await logStmt(env.DB, session.address, 'loan', `Borrowed ${usd(principalCents)} for ${body.days} days. Received on ${CHAINS[body.payoutChain].name} as ${body.payoutToken}.`, principalCents, nowSec).run()
      const loan = await env.DB.prepare('SELECT * FROM loans WHERE id = ?1').bind(res.meta.last_row_id).first()
      return json({ loan: await loanView(env.DB, loan, today) }, 201)
    } catch (error) {
      await env.DB.prepare('UPDATE pool_state SET cash_cents = cash_cents + ?1, lent_cents = lent_cents - ?1 WHERE id = 1').bind(principalCents).run()
      throw error
    }
  }

  async function listLoans({ env, session, nowSec }) {
    if (!session) throw new HttpError(401, 'Sign in first.')
    await accrue(env, nowSec)
    const today = simDayAt(nowSec)
    const rows = (await env.DB.prepare('SELECT * FROM loans WHERE address = ?1 ORDER BY id DESC LIMIT 10').bind(session.address).all()).results
    const loans = []
    for (const row of rows) loans.push(await loanView(env.DB, row, today))
    return json({ loans, ...clock(nowSec) })
  }

  // ---------------------------------------------------------------- the shared pool
  async function poolStats(env, nowSec, session) {
    await accrue(env, nowSec)
    const pool = await loadPool(env.DB)
    const today = simDayAt(nowSec)
    const byChain = (await env.DB.prepare("SELECT chain, token, SUM(amount_cents) AS cents, COUNT(*) AS n FROM positions WHERE status = 'active' GROUP BY chain, token").all()).results
    const counts = await env.DB.prepare(
      `SELECT (SELECT COUNT(DISTINCT address) FROM positions WHERE status = 'active' AND is_seed = 0) AS lenders,
              (SELECT COUNT(*) FROM loans WHERE status IN ('active', 'defaulted')) AS activeLoans,
              (SELECT COUNT(*) FROM loans WHERE status = 'repaid') AS repaidLoans,
              (SELECT COUNT(*) FROM loans WHERE status = 'defaulted') AS defaultedLoans`,
    ).first()
    const assets = poolAssets(pool)
    const chains = {}
    for (const id of Object.keys(CHAINS)) chains[id] = { depositedCents: 0, tokens: {} }
    for (const row of byChain) {
      chains[row.chain].depositedCents += row.cents
      chains[row.chain].tokens[row.token] = row.cents
    }
    const out = {
      ...clock(nowSec),
      assetsCents: assets,
      cashCents: pool.cash_cents,
      lentCents: pool.lent_cents,
      utilisationPct: assets ? Math.round((pool.lent_cents / assets) * 1000) / 10 : 0,
      feesEarnedCents: pool.fees_cents,
      writtenOffCents: pool.written_off_cents,
      sharePriceMicro: pool.shares_total ? Math.round((assets / pool.shares_total) * 1_000_000) : 1_000_000,
      chains,
      lenders: counts.lenders,
      activeLoans: counts.activeLoans,
      repaidLoans: counts.repaidLoans,
      defaultedLoans: counts.defaultedLoans,
      starterLiquidityCents: 500_000,
      note: 'One shared dollar pool. Deposits arrive on Base, Arbitrum or Tempo in USDC, USDT or USD. Test funds on test networks.',
    }
    if (session) {
      const mine = (await env.DB.prepare("SELECT * FROM positions WHERE address = ?1 AND status = 'active'").bind(session.address).all()).results
      out.you = { valueCents: mine.reduce((s, p) => s + valueOfShares(pool, p.shares), 0), depositedCents: mine.reduce((s, p) => s + p.amount_cents, 0), positions: mine.length, today }
    }
    return out
  }

  async function getPool({ env, request, session, nowSec }) {
    await rateLimit(env, request, 'read', 240, nowSec)
    return json(await poolStats(env, nowSec, session))
  }

  async function deposit({ env, request, url, session, nowSec }) {
    requireSameOrigin(request, url)
    requireRole(session, 'lender')
    await rateLimit(env, request, 'write', 60, nowSec)
    const body = await readBody(request)
    if (!CHAINS[body.chain]) throw new HttpError(400, 'Choose Base, Arbitrum or Tempo.')
    if (!TOKENS.includes(body.token)) throw new HttpError(400, 'Choose USDC, USDT or USD.')
    const amountCents = parseUsd(body.amountUsd)
    let projection
    try { projection = lenderProjection(amountCents, body.lockDays) } catch (e) { if (e instanceof InputError) throw new HttpError(400, e.message); throw e }
    await accrue(env, nowSec)
    const pool = await loadPool(env.DB)
    const shares = sharesForDeposit(pool, amountCents)
    const today = simDayAt(nowSec)
    const res = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO positions (address, chain, token, amount_cents, shares, lock_days, created_day, locked_until_day, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(session.address, body.chain, body.token, amountCents, shares, body.lockDays, today, today + body.lockDays, nowSec),
      env.DB.prepare('UPDATE pool_state SET cash_cents = cash_cents + ?1, shares_total = shares_total + ?2 WHERE id = 1').bind(amountCents, shares),
      logStmt(env.DB, session.address, 'deposit', `Deposited ${usd(amountCents)} ${body.token} on ${CHAINS[body.chain].name}, locked for ${body.lockDays} days.`, amountCents, nowSec),
    ])
    const row = await env.DB.prepare('SELECT * FROM positions WHERE id = ?1').bind(res[0].meta.last_row_id).first()
    return json({ position: positionView(row, await loadPool(env.DB), today), projection }, 201)
  }

  async function listPositions({ env, session, nowSec }) {
    requireRole(session, 'lender')
    await accrue(env, nowSec)
    const pool = await loadPool(env.DB)
    const today = simDayAt(nowSec)
    const rows = (await env.DB.prepare('SELECT * FROM positions WHERE address = ?1 ORDER BY id DESC LIMIT 50').bind(session.address).all()).results
    const positions = rows.map((p) => positionView(p, pool, today))
    const active = positions.filter((p) => p.status === 'active')
    return json({
      positions,
      totals: {
        depositedCents: active.reduce((s, p) => s + p.amountCents, 0),
        valueCents: active.reduce((s, p) => s + p.valueCents, 0),
        earnedCents: active.reduce((s, p) => s + p.earnedCents, 0),
      },
      ...clock(nowSec),
    })
  }

  async function withdraw({ env, request, url, session, nowSec, id }) {
    requireSameOrigin(request, url)
    requireRole(session, 'lender')
    await rateLimit(env, request, 'write', 60, nowSec)
    await accrue(env, nowSec)
    const position = await env.DB.prepare('SELECT * FROM positions WHERE id = ?1 AND address = ?2').bind(id, session.address).first()
    if (!position) throw new HttpError(404, 'Position not found.')
    if (position.status !== 'active') throw new HttpError(409, 'This position was already withdrawn.')
    const today = simDayAt(nowSec)
    if (today < position.locked_until_day) throw new HttpError(409, `Locked for ${position.locked_until_day - today} more days.`)
    const pool = await loadPool(env.DB)
    const valueCents = valueOfShares(pool, position.shares)
    const took = await env.DB.prepare('UPDATE pool_state SET cash_cents = cash_cents - ?1, shares_total = shares_total - ?2 WHERE id = 1 AND cash_cents >= ?1').bind(valueCents, position.shares).run()
    if (took.meta.changes !== 1) throw new HttpError(409, 'Most of the pool is lent out right now. Try again once borrowers have repaid some of it.')
    const closed = await env.DB.prepare("UPDATE positions SET status = 'withdrawn', withdrawn_cents = ?2 WHERE id = ?1 AND status = 'active'").bind(id, valueCents).run()
    if (closed.meta.changes !== 1) {
      await env.DB.prepare('UPDATE pool_state SET cash_cents = cash_cents + ?1, shares_total = shares_total + ?2 WHERE id = 1').bind(valueCents, position.shares).run()
      throw new HttpError(409, 'This position was already withdrawn.')
    }
    await logStmt(env.DB, session.address, 'withdraw', `Withdrew ${usd(valueCents)} (${usd(valueCents - position.amount_cents)} earned) to ${CHAINS[position.chain].name}.`, valueCents, nowSec).run()
    return json({ ok: true, valueCents, earnedCents: valueCents - position.amount_cents })
  }

  // ---------------------------------------------------------------- activity
  async function activity({ env, session }) {
    if (!session) throw new HttpError(401, 'Sign in first.')
    const rows = (await env.DB.prepare('SELECT id, kind, text, amount_cents, day, created_at FROM activity WHERE address = ?1 ORDER BY id DESC LIMIT ?2').bind(session.address, MAX_ACTIVITY).all()).results
    return json({ activity: rows.map((r) => ({ id: r.id, kind: r.kind, text: r.text, amountCents: r.amount_cents, day: r.day, at: r.created_at })) })
  }

  return { registerMeter, getMeter, setOutage, restoreMeter, credit, createLoan, listLoans, getPool, deposit, listPositions, withdraw, activity, poolStats }
}

export { ROLES }
