PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','instructor','admin')),
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS specializations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specialization_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  FOREIGN KEY (specialization_id) REFERENCES specializations(id)
);

-- Schools (customers). Customer API keys are scoped to one school.
-- The demo data has one placeholder school. TODO: group decision (real school name and code).
CREATE TABLE IF NOT EXISTS schools (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 200),
  code TEXT NOT NULL UNIQUE CHECK(length(code) BETWEEN 2 AND 20 AND code NOT GLOB '*[^A-Z0-9-]*')
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  program_id INTEGER NOT NULL,
  year_level INTEGER NOT NULL CHECK(year_level BETWEEN 1 AND 5),
  student_number TEXT NOT NULL UNIQUE,
  -- The school the student belongs to. Nullable so older databases can add it in place.
  school_id INTEGER REFERENCES schools(id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (program_id) REFERENCES programs(id)
);

CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  department TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 3,
  FOREIGN KEY (program_id) REFERENCES programs(id)
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  term_id INTEGER NOT NULL,
  instructor_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 40,
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (term_id) REFERENCES terms(id),
  FOREIGN KEY (instructor_id) REFERENCES instructors(id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  section_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','dropped','withdrawn','waitlisted')),
  enrolled_at TEXT NOT NULL,
  final_grade REAL,
  UNIQUE(student_id, section_id),
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('quiz','assignment','exam')),
  max_score REAL NOT NULL,
  due_at TEXT NOT NULL,
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  score REAL,
  submitted_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('submitted','late','missing')),
  UNIQUE(assignment_id, student_id),
  FOREIGN KEY (assignment_id) REFERENCES assignments(id),
  FOREIGN KEY (student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'medium',
  FOREIGN KEY (assignment_id) REFERENCES assignments(id)
);

CREATE TABLE IF NOT EXISTS quiz_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  is_correct INTEGER NOT NULL CHECK(is_correct IN (0,1)),
  answered_at TEXT NOT NULL,
  UNIQUE(question_id, student_id),
  FOREIGN KEY (question_id) REFERENCES quiz_questions(id),
  FOREIGN KEY (student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS attendance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  section_id INTEGER NOT NULL,
  attended_at TEXT NOT NULL,
  present INTEGER NOT NULL CHECK(present IN (0,1)),
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  section_id INTEGER,
  action TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

-- Pricing: `amount` is the base price, in `currency` (ISO 4217 code such as USD or PHP). final_amount = amount - scholarship_amount
-- - (amount * discount_percent / 100) + platform_fee + transaction_fee.
-- instructor_cost is the school's cost and is NOT charged to the student.
-- Keep this formula in sync with computeFinalAmount() in src/pricing.js.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  term_id INTEGER NOT NULL,
  amount REAL NOT NULL CHECK(amount >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
  scholarship_amount REAL NOT NULL DEFAULT 0 CHECK(scholarship_amount >= 0),
  scholarship_type TEXT CHECK(scholarship_type IN ('merit','need_based','sponsored','other')),
  -- The scholarship's own name, for example "Academic Merit Scholarship".
  scholarship_name TEXT CHECK(scholarship_name IS NULL OR length(trim(scholarship_name)) BETWEEN 1 AND 100),
  discount_percent REAL NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100),
  discount_code TEXT,
  platform_fee REAL NOT NULL DEFAULT 0 CHECK(platform_fee >= 0),
  transaction_fee REAL NOT NULL DEFAULT 0 CHECK(transaction_fee >= 0),
  instructor_cost REAL NOT NULL DEFAULT 0 CHECK(instructor_cost >= 0),
  final_amount REAL GENERATED ALWAYS AS (
    ROUND(amount - scholarship_amount - (amount * discount_percent / 100.0) + platform_fee + transaction_fee, 2)
  ) VIRTUAL CHECK(final_amount >= 0),
  issued_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  CHECK(scholarship_amount = 0 OR scholarship_type IS NOT NULL),
  -- A scholarship name is only allowed when there is a scholarship.
  CHECK(scholarship_name IS NULL OR scholarship_amount > 0),
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (term_id) REFERENCES terms(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  -- Scholarships are not payments: they reduce the price through invoices.scholarship_amount.
  method TEXT NOT NULL CHECK(method IN ('cash','card','bank')),
  paid_at TEXT NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  refunded_at TEXT NOT NULL,
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

-- Stellar payment requests (see docs/stellar/payments-api.md).
-- Column names are snake_case versions of the API fields (invoiceId -> invoice_id).
-- Amounts and rates are strings, because Stellar amounts have exactly 7 decimals.
CREATE TABLE IF NOT EXISTS payment_requests (
  id TEXT PRIMARY KEY CHECK(id GLOB 'pay_?*'),
  invoice_id INTEGER,
  amount TEXT NOT NULL CHECK(
    amount GLOB '[0-9]*.[0-9][0-9][0-9][0-9][0-9][0-9][0-9]'
    AND amount NOT GLOB '*[^0-9.]*'
    AND length(amount) - length(replace(amount, '.', '')) = 1
    AND CAST(amount AS REAL) > 0
  ),
  asset TEXT NOT NULL CHECK(asset IN ('XLM','USDC')),
  asset_issuer TEXT CHECK(asset_issuer IS NULL OR (length(asset_issuer) = 56 AND asset_issuer GLOB 'G*')),
  memo TEXT NOT NULL UNIQUE CHECK(length(memo) BETWEEN 1 AND 28),
  destination TEXT NOT NULL CHECK(length(destination) = 56 AND destination GLOB 'G*'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','failed')),
  reason TEXT CHECK(reason IN ('expired','cancelled','underpaid','wrong_asset')),
  tx_hash TEXT UNIQUE CHECK(tx_hash IS NULL OR (length(tx_hash) = 64 AND tx_hash NOT GLOB '*[^0-9a-f]*')),
  related_payment_id TEXT,
  -- Where the quoted rate came from, recorded for audits (see src/stellarQuotes.js).
  rate_source TEXT CHECK(rate_source IS NULL OR length(rate_source) BETWEEN 1 AND 40),
  quoted_rate TEXT CHECK(
    quoted_rate IS NULL OR (
      quoted_rate NOT GLOB '*[^0-9.]*'
      AND length(quoted_rate) - length(replace(quoted_rate, '.', '')) <= 1
      AND CAST(quoted_rate AS REAL) > 0
    )
  ),
  invoice_currency TEXT CHECK(invoice_currency IS NULL OR (length(invoice_currency) = 3 AND invoice_currency GLOB '[A-Z][A-Z][A-Z]')),
  -- The invoice balance that was converted, as a 2-decimal string in invoice_currency.
  invoice_amount TEXT CHECK(invoice_amount IS NULL OR (
    invoice_amount GLOB '[0-9]*.[0-9][0-9]' AND invoice_amount NOT GLOB '*[^0-9.]*'
  )),
  -- What actually arrived on Stellar (7-decimal string), and the ledger it closed in.
  amount_received TEXT CHECK(amount_received IS NULL OR (
    amount_received GLOB '[0-9]*.[0-9][0-9][0-9][0-9][0-9][0-9][0-9]' AND amount_received NOT GLOB '*[^0-9.]*'
  )),
  ledger INTEGER CHECK(ledger IS NULL OR ledger > 0),
  -- For records an admin created by hand (accept-late-payment, match-transaction):
  -- why, and who did it. Saved for audits.
  note TEXT CHECK(note IS NULL OR length(trim(note)) BETWEEN 1 AND 500),
  accepted_by INTEGER REFERENCES users(id),
  -- The Stellar account the matched payment came from (for webhooks and refunds).
  source_account TEXT CHECK(source_account IS NULL OR (length(source_account) = 56 AND source_account GLOB 'G*')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  completed_at TEXT,
  -- XLM is native and has no issuer; every other asset needs one.
  CHECK((asset = 'XLM' AND asset_issuer IS NULL) OR (asset <> 'XLM' AND asset_issuer IS NOT NULL)),
  -- A reason is given only for failed requests, and every failed request has one.
  CHECK((status = 'failed') = (reason IS NOT NULL)),
  -- Completed requests have the transaction hash and completion time.
  CHECK(status <> 'completed' OR (tx_hash IS NOT NULL AND completed_at IS NOT NULL)),
  CHECK(status = 'completed' OR completed_at IS NULL),
  -- Requests created from an invoice store the quoted rate and invoice currency; others store neither.
  CHECK(
    (invoice_id IS NULL AND quoted_rate IS NULL AND rate_source IS NULL AND invoice_currency IS NULL AND invoice_amount IS NULL)
    OR (invoice_id IS NOT NULL AND quoted_rate IS NOT NULL AND rate_source IS NOT NULL AND invoice_currency IS NOT NULL AND invoice_amount IS NOT NULL)
  ),
  -- A transaction is recorded together with what it delivered and its ledger.
  CHECK((tx_hash IS NULL) = (amount_received IS NULL) AND (tx_hash IS NULL) = (ledger IS NULL)),
  CHECK(expires_at > created_at),
  CHECK(related_payment_id IS NULL OR related_payment_id <> id),
  FOREIGN KEY (invoice_id) REFERENCES invoices(id),
  FOREIGN KEY (related_payment_id) REFERENCES payment_requests(id)
);

CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON payment_requests(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_payment_requests_invoice ON payment_requests(invoice_id);

-- completed and failed are final: once a request leaves pending, its status never changes.
-- The quote is locked: once a request exists, what the payer was asked for
-- (amount, asset, rate, memo, destination and the invoice it converts) never
-- changes. A new quote means a new payment request.
CREATE TRIGGER IF NOT EXISTS payment_requests_quote_locked
BEFORE UPDATE ON payment_requests
WHEN NEW.amount IS NOT OLD.amount
  OR NEW.asset IS NOT OLD.asset
  OR NEW.asset_issuer IS NOT OLD.asset_issuer
  OR NEW.memo IS NOT OLD.memo
  OR NEW.destination IS NOT OLD.destination
  OR NEW.quoted_rate IS NOT OLD.quoted_rate
  OR NEW.rate_source IS NOT OLD.rate_source
  OR NEW.invoice_id IS NOT OLD.invoice_id
  OR NEW.invoice_currency IS NOT OLD.invoice_currency
  OR NEW.invoice_amount IS NOT OLD.invoice_amount
BEGIN
  SELECT RAISE(ABORT, 'payment request quote is locked; create a new payment request instead');
END;

CREATE TRIGGER IF NOT EXISTS payment_requests_final_status
BEFORE UPDATE OF status ON payment_requests
WHEN OLD.status IN ('completed','failed') AND NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'payment request status is final once completed or failed');
END;

-- A follow-up payment (relatedPaymentId) must point to a failed request.
CREATE TRIGGER IF NOT EXISTS payment_requests_related_must_be_failed
BEFORE INSERT ON payment_requests
WHEN NEW.related_payment_id IS NOT NULL
  AND (SELECT status FROM payment_requests WHERE id = NEW.related_payment_id) IS NOT 'failed'
BEGIN
  SELECT RAISE(ABORT, 'related_payment_id must point to a failed payment request');
END;

-- Customer (school) API keys: read-only, scoped to one school's payments
-- (see "Customer API keys" in docs/stellar/payments-api.md). Only a SHA-256 hash
-- of each key is stored; the key itself is shown once, when it is created.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY CHECK(id GLOB 'key_?*'),
  school_id INTEGER NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 100),
  key_prefix TEXT NOT NULL CHECK(key_prefix GLOB 'plk_*' AND length(key_prefix) = 12),
  key_hash TEXT NOT NULL UNIQUE CHECK(length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT,
  FOREIGN KEY (school_id) REFERENCES schools(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Registered webhook URLs, one per customer endpoint (see "Webhook endpoints" in
-- docs/stellar/payments-api.md). Each has its own signing secret, stored encrypted
-- (AES-256-GCM, see src/webhookSecrets.js). The previous secret stays valid for
-- 24 hours after a rotation.
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY CHECK(id GLOB 'wh_?*'),
  school_id INTEGER NOT NULL,
  url TEXT NOT NULL CHECK(length(url) BETWEEN 8 AND 2048),
  events TEXT NOT NULL CHECK(json_valid(events) AND json_type(events) = 'array'),
  description TEXT CHECK(description IS NULL OR length(description) <= 200),
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  secret_enc TEXT NOT NULL CHECK(secret_enc GLOB 'v1:?*'),
  previous_secret_enc TEXT CHECK(previous_secret_enc IS NULL OR previous_secret_enc GLOB 'v1:?*'),
  previous_secret_expires_at TEXT,
  secret_last_rotated_at TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  -- Set when the receiver answered 410 Gone: PlugLytics stops sending to this URL.
  disabled_at TEXT,
  CHECK((previous_secret_enc IS NULL) = (previous_secret_expires_at IS NULL)),
  FOREIGN KEY (school_id) REFERENCES schools(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
);

-- Webhook outbox (see docs/stellar/webhooks.md). Each event is stored once with
-- its exact JSON body, so every retry sends the same body and event ID.
CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY CHECK(id GLOB 'evt_?*'),
  type TEXT NOT NULL,
  school_id INTEGER,
  environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
  payment_id TEXT,
  body TEXT NOT NULL CHECK(json_valid(body)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (school_id) REFERENCES schools(id)
);

-- One delivery per event per endpoint. Delivery states describe whether the
-- webhook reached the receiver, not the payment.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  endpoint_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','delivery_failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 8),
  next_attempt_at TEXT,
  last_attempt_at TEXT,
  last_status_code INTEGER,
  last_error TEXT,
  delivered_at TEXT,
  UNIQUE(event_id, endpoint_id),
  CHECK(status <> 'pending' OR next_attempt_at IS NOT NULL),
  CHECK(status <> 'delivered' OR delivered_at IS NOT NULL),
  FOREIGN KEY (event_id) REFERENCES webhook_events(id) ON DELETE CASCADE,
  FOREIGN KEY (endpoint_id) REFERENCES webhook_endpoints(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);

-- The index on students(school_id) is created by scripts/seed.js, after it makes
-- sure older databases have that column.

-- Scholarships are stored on each invoice (scholarship_amount, scholarship_type,
-- scholarship_name). The old separate scholarships table was removed.

CREATE TABLE IF NOT EXISTS instructor_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instructor_id INTEGER NOT NULL,
  section_id INTEGER,
  rating REAL NOT NULL CHECK(rating BETWEEN 1 AND 5),
  rated_at TEXT NOT NULL,
  FOREIGN KEY (instructor_id) REFERENCES instructors(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS dashboard_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  layout_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_section ON enrollments(section_id);
CREATE INDEX IF NOT EXISTS idx_sections_instructor ON sections(instructor_id);
CREATE INDEX IF NOT EXISTS idx_sections_term ON sections(term_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_activity_student_date ON activity_logs(student_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance_logs(student_id, attended_at);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_date ON payments(invoice_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_invoices_term ON invoices(term_id);

CREATE VIEW IF NOT EXISTS student_course_progress AS
SELECT e.student_id,
       c.id AS course_id,
       c.code AS course_code,
       t.id AS term_id,
       t.code AS term_code,
       COUNT(DISTINCT a.id) AS total_items,
       SUM(CASE WHEN s.status IN ('submitted','late') THEN 1 ELSE 0 END) AS submitted_items,
       ROUND(100.0 * SUM(CASE WHEN s.status IN ('submitted','late') THEN 1 ELSE 0 END) /
         NULLIF(COUNT(DISTINCT a.id), 0), 1) AS progress_percent,
       AVG(CASE WHEN s.score IS NOT NULL THEN s.score / a.max_score * 100 END) AS average_score
FROM enrollments e
JOIN sections sec ON sec.id = e.section_id
JOIN courses c ON c.id = sec.course_id
JOIN terms t ON t.id = sec.term_id
LEFT JOIN assignments a ON a.section_id = sec.id
LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = e.student_id
GROUP BY e.student_id, c.id, c.code, t.id, t.code;
