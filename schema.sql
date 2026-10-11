-- Selfpay D1 schema, version 2.
-- This RESETS the database: it drops every earlier table and recreates them. Only run it on a database you are happy to empty.
--   wrangler d1 execute selfpay --remote --file=schema.sql
-- Money is integer cents. Days are SIMULATED days (1 simulated day = 1 real minute; see worker/sim.mjs).
-- Wallet address is the only identity: no emails, no passwords.

DROP TABLE IF EXISTS loan_payments;
DROP TABLE IF EXISTS loans;
DROP TABLE IF EXISTS positions;
DROP TABLE IF EXISTS pool_state;
DROP TABLE IF EXISTS meter_readings;
DROP TABLE IF EXISTS meters;
DROP TABLE IF EXISTS activity;
DROP TABLE IF EXISTS plans;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS challenges;
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS locks;
DROP TABLE IF EXISTS hits;

-- ---------------------------------------------------------------- accounts
CREATE TABLE users (
  address    TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- A wallet can be a lender, a borrower, or both.
CREATE TABLE profiles (
  address       TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('lender', 'borrower')),
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL,
  PRIMARY KEY (address, role)
);

-- One-time Sign-In With Ethereum challenges. mode 'signup' registers a new user; 'login' signs one in.
CREATE TABLE challenges (
  nonce      TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  mode       TEXT NOT NULL CHECK (mode IN ('signup', 'login')),
  role       TEXT CHECK (role IN ('lender', 'borrower')),
  name       TEXT,
  chain_id   INTEGER NOT NULL,
  issued_at  INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_challenges_lookup ON challenges (address, used, expires_at);

-- Only a SHA-256 of the session token is stored; the token itself lives in an HttpOnly cookie.
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  address    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('lender', 'borrower')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_address ON sessions (address);
CREATE INDEX idx_sessions_expiry ON sessions (expires_at);

-- ---------------------------------------------------------------- meters (simulated)
-- One meter per borrower. The usage is simulated from the meter number; in production this would be a signed IoT feed.
CREATE TABLE meters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  address        TEXT NOT NULL UNIQUE,
  meter_number   TEXT NOT NULL UNIQUE,
  label          TEXT NOT NULL,
  capacity_dkw   INTEGER NOT NULL,        -- deci-kilowatts (35 = 3.5 kW)
  tariff_cents   INTEGER NOT NULL,        -- what customers pay per kWh, in cents
  seed           INTEGER NOT NULL,
  registered_day INTEGER NOT NULL,
  last_day       INTEGER NOT NULL,        -- last simulated day with a stored reading
  outage_from    INTEGER,
  outage_until   INTEGER,
  earned_cents   INTEGER NOT NULL DEFAULT 0,  -- revenue that reached the owner after loan repayments
  created_at     INTEGER NOT NULL
);

CREATE TABLE meter_readings (
  meter_id      INTEGER NOT NULL,
  day           INTEGER NOT NULL,
  kwh_wh        INTEGER NOT NULL,         -- watt-hours delivered that day
  revenue_cents INTEGER NOT NULL,
  online        INTEGER NOT NULL,
  PRIMARY KEY (meter_id, day)
);

-- ---------------------------------------------------------------- the shared multi-chain pool
-- One pool in US dollars. Deposits arrive on Base, Arbitrum or Tempo as USDC, USDT or USD; liquidity is pooled.
-- total assets = cash + lent principal (fees raise cash, so they raise every lender's share value, like the contracts).
CREATE TABLE pool_state (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  cash_cents        INTEGER NOT NULL,
  lent_cents        INTEGER NOT NULL,
  shares_total      INTEGER NOT NULL,
  fees_cents        INTEGER NOT NULL DEFAULT 0,
  written_off_cents INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE positions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  address          TEXT NOT NULL,
  chain            TEXT NOT NULL CHECK (chain IN ('base', 'arbitrum', 'tempo')),
  token            TEXT NOT NULL CHECK (token IN ('USDC', 'USDT', 'USD')),
  amount_cents     INTEGER NOT NULL CHECK (amount_cents > 0),
  shares           INTEGER NOT NULL CHECK (shares > 0),
  lock_days        INTEGER NOT NULL,
  created_day      INTEGER NOT NULL,
  locked_until_day INTEGER NOT NULL,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
  withdrawn_cents  INTEGER NOT NULL DEFAULT 0,
  is_seed          INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_positions_owner ON positions (address, status);

-- ---------------------------------------------------------------- loans
CREATE TABLE loans (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  address              TEXT NOT NULL,
  meter_id             INTEGER NOT NULL,
  principal_cents      INTEGER NOT NULL,
  fee_cents            INTEGER NOT NULL,
  total_cents          INTEGER NOT NULL,
  days                 INTEGER NOT NULL,
  opened_day           INTEGER NOT NULL,
  paid_cents           INTEGER NOT NULL DEFAULT 0,
  principal_paid_cents INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'defaulted', 'repaid', 'written_off')),
  locked               INTEGER NOT NULL DEFAULT 0,
  last_day             INTEGER NOT NULL,
  defaulted_day        INTEGER,
  closed_day           INTEGER,
  payout_chain         TEXT NOT NULL CHECK (payout_chain IN ('base', 'arbitrum', 'tempo')),
  payout_token         TEXT NOT NULL CHECK (payout_token IN ('USDC', 'USDT', 'USD')),
  created_at           INTEGER NOT NULL
);
CREATE INDEX idx_loans_owner ON loans (address, status);
CREATE INDEX idx_loans_open ON loans (meter_id, status);

CREATE TABLE loan_payments (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  loan_id          INTEGER NOT NULL,
  day              INTEGER NOT NULL,
  revenue_cents    INTEGER NOT NULL,
  to_pool_cents    INTEGER NOT NULL,
  to_borrower_cents INTEGER NOT NULL
);
CREATE INDEX idx_loan_payments_loan ON loan_payments (loan_id, day);

CREATE TABLE activity (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  address      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  text         TEXT NOT NULL,
  amount_cents INTEGER,
  day          INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_activity_owner ON activity (address, id DESC);

-- ---------------------------------------------------------------- housekeeping
-- Serialises the simulation catch-up so two requests can never apply the same day twice.
CREATE TABLE locks (
  name  TEXT PRIMARY KEY,
  until INTEGER NOT NULL
);

-- Fixed-window rate limiting. Keys are hashes, never raw IP addresses.
CREATE TABLE hits (
  bucket   TEXT PRIMARY KEY,
  n        INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- ---------------------------------------------------------------- starter liquidity (simulated, clearly labelled in the app)
INSERT INTO pool_state (id, cash_cents, lent_cents, shares_total) VALUES (1, 500000, 0, 500000);
INSERT INTO positions (address, chain, token, amount_cents, shares, lock_days, created_day, locked_until_day, is_seed, created_at) VALUES
  ('0x0000000000000000000000000000000000005eed', 'base',     'USDC', 200000, 200000, 0, 0, 0, 1, 0),
  ('0x0000000000000000000000000000000000005eed', 'arbitrum', 'USDC', 150000, 150000, 0, 0, 0, 1, 0),
  ('0x0000000000000000000000000000000000005eed', 'tempo',    'USD',  150000, 150000, 0, 0, 0, 1, 0);
