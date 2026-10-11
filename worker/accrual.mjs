// Applies finished simulated days to the database: stores each meter's reading and moves loan repayments into the pool.
// Runs lazily on requests (there is no scheduler). A lock row serialises it so a day can never be applied twice.
import { simDayAt } from '../web/src/terms.mjs'
import { readingFor, scheduleFor, stepLoanDay } from './sim.mjs'

const LOCK_SECONDS = 15
const MAX_DAYS_PER_METER = 90 // catch-up bound after long idle periods
const MAX_STEPS_PER_RUN = 240

async function acquire(DB, nowSec) {
  const res = await DB.prepare(
    `INSERT INTO locks (name, until) VALUES ('sim', ?1)
     ON CONFLICT(name) DO UPDATE SET until = ?1 WHERE locks.until <= ?2`,
  ).bind(nowSec + LOCK_SECONDS, nowSec).run()
  return res.meta.changes === 1
}

const release = (DB) => DB.prepare("UPDATE locks SET until = 0 WHERE name = 'sim'").run()

/** Brings every meter and open loan up to the last finished simulated day. Returns what it did. */
export async function accrue(env, nowSec) {
  const DB = env.DB
  const today = simDayAt(nowSec)
  if (!(await acquire(DB, nowSec))) return { skipped: true, today }
  let steps = 0
  try {
    const meters = (await DB.prepare('SELECT * FROM meters WHERE last_day < ?1 - 1 ORDER BY id').bind(today).all()).results
    for (const meter of meters) {
      let loan = await DB.prepare("SELECT * FROM loans WHERE meter_id = ?1 AND status IN ('active', 'defaulted') ORDER BY id DESC LIMIT 1").bind(meter.id).first()
      let installments = loan ? scheduleFor(loan.principal_cents, loan.days).installments : null
      const from = Math.max(meter.last_day + 1, today - 1 - MAX_DAYS_PER_METER + 1)
      for (let day = from; day <= today - 1 && steps < MAX_STEPS_PER_RUN; day++) {
        steps++
        const reading = readingFor(meter, day)
        const statements = [
          DB.prepare('INSERT OR IGNORE INTO meter_readings (meter_id, day, kwh_wh, revenue_cents, online) VALUES (?1, ?2, ?3, ?4, ?5)')
            .bind(meter.id, day, reading.kwhWh, reading.revenueCents, reading.online ? 1 : 0),
        ]
        let toBorrower = reading.revenueCents
        if (loan && loan.opened_day < day && loan.last_day < day && (loan.status === 'active' || loan.status === 'defaulted')) {
          const step = stepLoanDay(loan, installments, day, reading.revenueCents)
          toBorrower = step.toBorrower
          statements.push(
            DB.prepare(
              `UPDATE loans SET status = ?2, locked = ?3, paid_cents = ?4, principal_paid_cents = ?5, last_day = ?6,
                 defaulted_day = ?7, closed_day = ?8 WHERE id = ?1`,
            ).bind(loan.id, step.loan.status, step.loan.locked, step.loan.paid_cents, step.loan.principal_paid_cents, day, step.loan.defaulted_day ?? null, step.loan.closed_day ?? null),
            DB.prepare('INSERT INTO loan_payments (loan_id, day, revenue_cents, to_pool_cents, to_borrower_cents) VALUES (?1, ?2, ?3, ?4, ?5)')
              .bind(loan.id, day, reading.revenueCents, step.toPool, step.toBorrower),
            DB.prepare(
              `UPDATE pool_state SET cash_cents = cash_cents + ?1, lent_cents = lent_cents - ?2 - ?3,
                 fees_cents = fees_cents + ?4, written_off_cents = written_off_cents + ?3 WHERE id = 1`,
            ).bind(step.toPool, step.principalPart, step.loss, step.feePart),
          )
          for (const e of step.events) {
            statements.push(
              DB.prepare('INSERT INTO activity (address, kind, text, amount_cents, day, created_at) VALUES (?1, ?2, ?3, NULL, ?4, ?5)')
                .bind(loan.address, e.kind, e.text, day, nowSec),
            )
          }
          loan = { ...step.loan, id: loan.id, address: loan.address, days: loan.days }
          if (loan.status === 'repaid' || loan.status === 'written_off') loan = null
        }
        statements.push(DB.prepare('UPDATE meters SET last_day = ?2, earned_cents = earned_cents + ?3 WHERE id = ?1').bind(meter.id, day, toBorrower))
        await DB.batch(statements)
        meter.last_day = day
      }
      if (steps >= MAX_STEPS_PER_RUN) break
    }
  } finally {
    await release(DB)
  }
  return { skipped: false, today, steps }
}
