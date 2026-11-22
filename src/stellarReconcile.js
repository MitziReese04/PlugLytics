// Daily and weekly reconciliation, and settlement reports.
// Follows "Reconciliation" and "Settlement reports" in docs/stellar/settlement.md.
//
// Reconciliation only READS from Horizon: it never sends money and never changes a
// payment request or refund. It compares what Horizon shows for the merchant
// account with our payment_requests and stellar_refunds, sorts every item into a
// group, and saves one report per asset and period (settlement_reports, with
// settlement_items as the line-by-line list). It is testnet only for now.

const crypto = require("crypto");
const db = require("./db");
const {
  HorizonError, toStroops, fromStroops, PAYMENT_TYPES, REQUEST_TIMEOUT_MS, getAccount, getTransactionWithPayments,
} = require("./stellarHorizon");
const { enqueueSettlementCompleted } = require("./webhookDelivery");

const PAGE_LIMIT = 200;
// 50 pages = 10,000 operations. A testnet merchant account has far fewer; a
// larger history needs a saved cursor (see "paging_token" in settlement.md).
const MAX_PAGES = 50;
const DAY_MS = 24 * 3600 * 1000;
// Exceptions open for longer than this are flagged in the weekly report.
const EXCEPTION_DEADLINE_DAYS = 7;
const RESULTS = ["matched", "amount_mismatch", "asset_mismatch", "unmatched_onchain", "unmatched_record", "duplicate"];

class ReconcileError extends Error {
  constructor(message, code, status = 409) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// ---- periods (UTC) -------------------------------------------------------------

const DATE = /^\d{4}-\d{2}-\d{2}$/;
function parseDate(date) {
  const ms = DATE.test(String(date)) ? Date.parse(`${date}T00:00:00.000Z`) : NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== date) {
    throw new ReconcileError(`"${date}" is not a date (YYYY-MM-DD)`, "VALIDATION_ERROR", 400);
  }
  return ms;
}
const iso = (ms) => new Date(ms).toISOString();
const dayOf = (ms) => iso(ms).slice(0, 10);

function dayPeriod(date) {
  const start = parseDate(date);
  return { start: iso(start), end: iso(start + DAY_MS) };
}
// The Monday-to-Sunday week that contains `date`.
function weekPeriod(date) {
  const ms = parseDate(date);
  const start = ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY_MS;
  return { start: iso(start), end: iso(start + 7 * DAY_MS) };
}
function yesterday(now = new Date()) {
  return dayOf(Date.parse(`${dayOf(now.getTime())}T00:00:00.000Z`) - DAY_MS);
}
function lastWeekMonday(now = new Date()) {
  return dayOf(Date.parse(weekPeriod(dayOf(now.getTime())).start) - 7 * DAY_MS);
}

// ---- Horizon -------------------------------------------------------------------

async function loadPage(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, { headers: { Accept: "application/hal+json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    throw new HorizonError(`Horizon could not be reached: ${error.message}`);
  }
  // A merchant account that was never funded does not exist yet: no payments.
  if (response.status === 404) return { _embedded: { records: [] }, _links: {} };
  if (!response.ok) throw new HorizonError(`Horizon returned HTTP ${response.status}`);
  return response.json();
}

// Every payment to and from the merchant account, oldest first, starting after
// `cursor` (a paging_token) or from the oldest one Horizon keeps.
async function fetchMerchantRecords({ horizonUrl, account, cursor, fetchImpl = fetch }) {
  const base = horizonUrl.replace(/\/+$/, "");
  let url = `${base}/accounts/${encodeURIComponent(account)}/payments?order=asc&limit=${PAGE_LIMIT}&join=transactions`
    + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const records = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = await loadPage(url, fetchImpl);
    const batch = (body._embedded && body._embedded.records) || [];
    records.push(...batch);
    const next = body._links && body._links.next && body._links.next.href;
    if (batch.length < PAGE_LIMIT || !next) return records;
    url = next;
  }
  throw new HorizonError(`The merchant account has more than ${MAX_PAGES * PAGE_LIMIT} payments to read; reconcile day by day to use a saved cursor`);
}

function assetOf(type, code, issuer) {
  return type === "native" ? { asset: "XLM", assetIssuer: null } : { asset: code, assetIssuer: issuer || null };
}

// One Horizon record as a money movement of the merchant account, or null when it
// does not move money in or out of it.
function describe(record, merchant) {
  if (record.transaction_successful !== true) return null;
  const tx = record.transaction || {};
  let movement = null;
  if (PAYMENT_TYPES.has(record.type)) {
    if (record.to === merchant && record.from !== merchant) {
      movement = { direction: "in", amount: record.amount, counterparty: record.from,
        ...assetOf(record.asset_type, record.asset_code, record.asset_issuer) };
    } else if (record.from === merchant && record.to !== merchant) {
      // For a path payment, the merchant spent the source amount and asset.
      const isPath = record.type !== "payment" && record.source_amount;
      movement = { direction: "out", counterparty: record.to,
        amount: isPath ? record.source_amount : record.amount,
        ...(isPath
          ? assetOf(record.source_asset_type, record.source_asset_code, record.source_asset_issuer)
          : assetOf(record.asset_type, record.asset_code, record.asset_issuer)) };
    }
  } else if (record.type === "create_account") {
    if (record.account === merchant) {
      movement = { direction: "in", amount: record.starting_balance, counterparty: record.funder, asset: "XLM", assetIssuer: null };
    } else if (record.funder === merchant) {
      movement = { direction: "out", amount: record.starting_balance, counterparty: record.account, asset: "XLM", assetIssuer: null };
    }
  }
  if (!movement) return null;
  const feePayer = tx.fee_account || tx.source_account;
  return {
    ...movement,
    kind: record.type,
    memo: tx.memo_type === "text" ? tx.memo : null,
    txHash: record.transaction_hash,
    ledger: tx.ledger || null,
    occurredAt: record.created_at,
    pagingToken: record.paging_token,
    // Network fee the merchant paid for this transaction (in stroops of XLM).
    fee: feePayer === merchant && tx.fee_charged ? BigInt(tx.fee_charged) : 0n,
  };
}

const inPeriod = (time, period) => {
  const ms = Date.parse(time);
  return ms >= Date.parse(period.start) && ms < Date.parse(period.end);
};

// ---- our records -----------------------------------------------------------------

const REQUEST_SELECT = `
  SELECT pr.*, st.school_id FROM payment_requests pr
  LEFT JOIN invoices i ON i.id = pr.invoice_id LEFT JOIN students st ON st.id = i.student_id
`;
const requestByTx = db.prepare(`${REQUEST_SELECT} WHERE pr.tx_hash = ? AND pr.destination = ?`);
const requestByMemo = db.prepare(`${REQUEST_SELECT} WHERE pr.memo = ? AND pr.destination = ?`);
const completedAround = db.prepare(`${REQUEST_SELECT}
  WHERE pr.destination = ? AND pr.status = 'completed' AND pr.tx_hash IS NOT NULL AND pr.completed_at >= ? AND pr.completed_at < ?`);
const REFUND_SELECT = `
  SELECT r.*, pr.destination AS merchant, st.school_id FROM stellar_refunds r
  JOIN payment_requests pr ON pr.id = r.payment_id
  LEFT JOIN invoices i ON i.id = pr.invoice_id LEFT JOIN students st ON st.id = i.student_id
`;
const refundByTx = db.prepare(`${REFUND_SELECT} WHERE r.tx_hash = ? AND pr.destination = ?`);
const refundsIssuedAround = db.prepare(`${REFUND_SELECT}
  WHERE pr.destination = ? AND r.status = 'issued' AND r.issued_at >= ? AND r.issued_at < ?`);
const completedFollowUp = db.prepare("SELECT id FROM payment_requests WHERE related_payment_id = ? AND status = 'completed' ORDER BY created_at LIMIT 1");
const issuedRefund = db.prepare("SELECT id FROM stellar_refunds WHERE payment_id = ? AND status = 'issued' AND reason IN (SELECT value FROM json_each(?)) ORDER BY issued_at LIMIT 1");

// How an exception was fixed (a completed follow-up or an issued refund), or null.
function resolutionFor(paymentId, { followUp = false, reasons }) {
  if (!paymentId) return null;
  if (followUp) {
    const next = completedFollowUp.get(paymentId);
    if (next) return `Follow-up payment ${next.id} completed`;
  }
  const refund = issuedRefund.get(paymentId, JSON.stringify(reasons));
  return refund ? `Refund ${refund.id} issued` : null;
}

const sameAssetAs = (m, asset, issuer) => m.asset === asset && (m.assetIssuer || null) === (issuer || null);
const short = (hash) => (hash ? `${hash.slice(0, 8)}…` : "");

function item(fields) {
  return {
    item_type: "unknown", payment_id: null, refund_id: null, school_id: null, memo: null,
    amount_expected: null, amount_received: null, tx_hash: null, ledger: null, counterparty: null,
    fee: 0n, note: null, resolution: null, paymentCompleted: false, ...fields,
  };
}

function classifyIncoming(m, merchant) {
  const base = {
    direction: "in", memo: m.memo, amount_received: m.amount, tx_hash: m.txHash, ledger: m.ledger,
    counterparty: m.counterparty, occurred_at: m.occurredAt, asset: m.asset, asset_issuer: m.assetIssuer,
  };
  const linked = requestByTx.get(m.txHash, merchant);
  if (linked) {
    const record = {
      ...base, item_type: "payment", payment_id: linked.id, school_id: linked.school_id,
      amount_expected: linked.amount, asset: linked.asset, asset_issuer: linked.asset_issuer,
      paymentCompleted: linked.status === "completed",
    };
    if (!sameAssetAs(m, linked.asset, linked.asset_issuer)) {
      return item({ ...record, result: "asset_mismatch",
        note: `Paid in ${m.asset}${m.assetIssuer ? ` (issuer ${short(m.assetIssuer)})` : ""} instead of ${linked.asset}: refund it in the asset it arrived in`,
        resolution: resolutionFor(linked.id, { reasons: ["wrong_asset"] }) });
    }
    const got = toStroops(m.amount);
    const wanted = toStroops(linked.amount);
    if (got < wanted) {
      return item({ ...record, result: "amount_mismatch",
        note: `Underpaid: ${m.amount} of ${linked.amount} ${linked.asset} arrived. Create a linked follow-up request, or refund it`,
        resolution: resolutionFor(linked.id, { followUp: true, reasons: ["underpaid"] }) });
    }
    if (got > wanted) {
      return item({ ...record, result: "amount_mismatch",
        note: `Overpaid by ${fromStroops(got - wanted)} ${linked.asset}: the payment counts; refund the extra or record a credit`,
        resolution: resolutionFor(linked.id, { reasons: ["overpaid"] }) });
    }
    return item({ ...record, result: "matched" });
  }

  const owner = m.memo ? requestByMemo.get(m.memo, merchant) : null;
  if (owner && owner.tx_hash) {
    return item({ ...base, result: "duplicate", item_type: "payment", payment_id: owner.id, school_id: owner.school_id,
      amount_expected: owner.amount,
      note: `${owner.id} was already paid by transaction ${short(owner.tx_hash)}: keep the first payment and refund this one`,
      resolution: resolutionFor(owner.id, { reasons: ["duplicate"] }) });
  }
  if (owner) {
    const state = `${owner.status}${owner.reason ? `, ${owner.reason}` : ""}`;
    return item({ ...base, result: "unmatched_onchain", item_type: "payment", payment_id: owner.id, school_id: owner.school_id,
      amount_expected: owner.amount,
      note: `The memo belongs to ${owner.id} (${state}), but this payment is not linked to it: `
        + (owner.status === "pending" ? "open the payment request to check it" : "accept it as a late payment, or refund it"),
      resolution: resolutionFor(owner.id, { reasons: ["late_payment"] }) });
  }
  if (m.kind === "create_account") {
    return item({ ...base, result: "unmatched_onchain",
      note: "Account funding (create_account), not a customer payment: check who funded the merchant account" });
  }
  return item({ ...base, result: "unmatched_onchain",
    note: `${m.memo ? `Unknown memo "${m.memo}"` : "No memo"}. Find the payer and use Match transaction, or refund it` });
}

function classifyOutgoing(m, merchant) {
  const base = {
    direction: "out", memo: m.memo, amount_received: m.amount, tx_hash: m.txHash, ledger: m.ledger,
    counterparty: m.counterparty, occurred_at: m.occurredAt, asset: m.asset, asset_issuer: m.assetIssuer,
  };
  const refund = refundByTx.get(m.txHash, merchant);
  if (!refund) {
    return item({ ...base, result: "unmatched_onchain",
      note: "Outgoing payment with no refund record (a withdrawal, or a payment PlugLytics did not send)" });
  }
  const record = {
    ...base, item_type: "refund", refund_id: refund.id, payment_id: refund.payment_id, school_id: refund.school_id,
    amount_expected: refund.amount, asset: refund.asset, asset_issuer: refund.asset_issuer,
  };
  if (m.counterparty !== refund.destination) {
    return item({ ...record, result: "unmatched_onchain", note: `Sent to ${m.counterparty}, but the refund is for ${refund.destination}` });
  }
  if (!sameAssetAs(m, refund.asset, refund.asset_issuer)) {
    return item({ ...record, result: "asset_mismatch", note: `Sent in ${m.asset} instead of ${refund.asset}` });
  }
  if (toStroops(m.amount) !== toStroops(refund.amount)) {
    return item({ ...record, result: "amount_mismatch", note: `Sent ${m.amount}, but the refund is for ${refund.amount} ${refund.asset}` });
  }
  return item({ ...record, result: "matched" });
}

// A record we hold whose transaction did not appear in the period. It is fine if
// Horizon has it (it belongs to the day it landed); otherwise it is unmatched_record.
async function checkRecordOnHorizon({ hash, merchant, direction, horizonUrl, fetchImpl }) {
  const found = await getTransactionWithPayments({ horizonUrl, hash, fetchImpl });
  if (!found) return "The transaction is not on Horizon (wrong network, a testnet reset, or a changed record): escalate";
  if (found.transaction.successful !== true) return "The transaction did not succeed on Horizon: escalate";
  const moves = found.payments.some((p) => PAYMENT_TYPES.has(p.type)
    && (direction === "in" ? p.to === merchant : p.from === merchant));
  return moves ? null : `The transaction did not ${direction === "in" ? "pay" : "come from"} the merchant account: escalate`;
}

// ---- daily ----------------------------------------------------------------------

async function dailyItems({ movements, period, merchant, horizonUrl, fetchImpl }) {
  const items = [];
  const seen = new Set();
  const feeCharged = new Set();
  for (const m of movements) {
    if (!inPeriod(m.occurredAt, period)) continue;
    seen.add(m.txHash);
    const it = m.direction === "in" ? classifyIncoming(m, merchant) : classifyOutgoing(m, merchant);
    // Each transaction's fee is counted once.
    if (m.fee && !feeCharged.has(m.txHash)) {
      feeCharged.add(m.txHash);
      it.fee = m.fee;
    }
    items.push(it);
  }

  // Our side: records from this period whose transaction was not seen. Times are
  // compared as dates (Horizon and our records format them differently).
  const wideStart = iso(Date.parse(period.start) - DAY_MS);
  const wideEnd = iso(Date.parse(period.end) + DAY_MS);
  for (const request of completedAround.all(merchant, wideStart, wideEnd)) {
    if (!inPeriod(request.completed_at, period) || seen.has(request.tx_hash)) continue;
    const problem = await checkRecordOnHorizon({ hash: request.tx_hash, merchant, direction: "in", horizonUrl, fetchImpl });
    if (!problem) continue;
    items.push(item({
      result: "unmatched_record", direction: "in", item_type: "payment", payment_id: request.id, school_id: request.school_id,
      memo: request.memo, asset: request.asset, asset_issuer: request.asset_issuer, amount_expected: request.amount,
      tx_hash: request.tx_hash, ledger: request.ledger, counterparty: request.source_account, occurred_at: request.completed_at,
      note: `Our record is completed, but: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`,
    }));
  }
  for (const refund of refundsIssuedAround.all(merchant, wideStart, wideEnd)) {
    if (!inPeriod(refund.issued_at, period) || seen.has(refund.tx_hash)) continue;
    const problem = await checkRecordOnHorizon({ hash: refund.tx_hash, merchant, direction: "out", horizonUrl, fetchImpl });
    if (!problem) continue;
    items.push(item({
      result: "unmatched_record", direction: "out", item_type: "refund", refund_id: refund.id, payment_id: refund.payment_id,
      school_id: refund.school_id, memo: refund.payment_memo, asset: refund.asset, asset_issuer: refund.asset_issuer,
      amount_expected: refund.amount, tx_hash: refund.tx_hash, ledger: refund.ledger, counterparty: refund.destination,
      occurred_at: refund.issued_at, note: `Our refund is issued, but: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`,
    }));
  }
  return items.sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at));
}

const assetKey = (asset, issuer) => `${asset}|${issuer || ""}`;

// The documented report figures for a set of items. Fees (always XLM) are counted
// from `feeItems`, which is empty for non-XLM reports.
function summarize(items, feeItems) {
  const paid = new Map();
  for (const it of items) {
    if (it.item_type === "payment" && it.direction === "in" && it.paymentCompleted
      && (it.result === "matched" || it.result === "amount_mismatch") && !paid.has(it.payment_id)) {
      paid.set(it.payment_id, toStroops(it.amount_received));
    }
  }
  const refunds = items.filter((it) => it.item_type === "refund" && it.direction === "out" && it.amount_received
    && it.result !== "unmatched_onchain");
  const gross = [...paid.values()].reduce((a, b) => a + b, 0n);
  const refunded = refunds.reduce((sum, it) => sum + toStroops(it.amount_received), 0n);
  const fees = feeItems.reduce((sum, it) => sum + (it.fee || 0n), 0n);
  const exceptions = items.filter((it) => it.result !== "matched");
  return {
    paymentCount: paid.size,
    grossAmount: fromStroops(gross),
    refundCount: refunds.length,
    refundedAmount: fromStroops(refunded),
    feesPaid: fromStroops(fees),
    netAmount: fromStroops(gross - refunded),
    matchedCount: items.length - exceptions.length,
    exceptionCount: exceptions.length,
    openExceptionCount: exceptions.filter((it) => !it.resolution).length,
    paymentIds: [...paid.keys()],
  };
}

// ---- saving ----------------------------------------------------------------------

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function reportId() {
  const bytes = crypto.randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i += 1) out += BASE32[bytes[i] % 32];
  return `set_${out}`;
}

const findReport = db.prepare(`SELECT * FROM settlement_reports
  WHERE kind = ? AND environment = ? AND asset = ? AND COALESCE(asset_issuer, '') = ? AND period_start = ?`);
const insertReport = db.prepare(`
  INSERT INTO settlement_reports (id, kind, environment, asset, asset_issuer, period_start, period_end, payment_count,
    gross_amount, refund_count, refunded_amount, fees_paid, net_amount, matched_count, exception_count, open_exception_count,
    payment_ids, opening_balance, expected_closing_balance, actual_closing_balance, balance_status, summary_hash,
    run_source, run_by, created_at, updated_at)
  VALUES (@id, @kind, @environment, @asset, @assetIssuer, @periodStart, @periodEnd, @paymentCount,
    @grossAmount, @refundCount, @refundedAmount, @feesPaid, @netAmount, @matchedCount, @exceptionCount, @openExceptionCount,
    @paymentIds, @openingBalance, @expectedClosingBalance, @actualClosingBalance, @balanceStatus, @summaryHash,
    @runSource, @runBy, @now, @now)
`);
const updateReport = db.prepare(`
  UPDATE settlement_reports SET payment_count = @paymentCount, gross_amount = @grossAmount, refund_count = @refundCount,
    refunded_amount = @refundedAmount, fees_paid = @feesPaid, net_amount = @netAmount, matched_count = @matchedCount,
    exception_count = @exceptionCount, open_exception_count = @openExceptionCount, payment_ids = @paymentIds,
    opening_balance = @openingBalance, expected_closing_balance = @expectedClosingBalance,
    actual_closing_balance = @actualClosingBalance, balance_status = @balanceStatus, summary_hash = @summaryHash,
    run_source = @runSource, run_by = @runBy, updated_at = @now
  WHERE id = @id
`);
const deleteItems = db.prepare("DELETE FROM settlement_items WHERE report_id = ?");
const insertItem = db.prepare(`
  INSERT INTO settlement_items (report_id, result, direction, item_type, payment_id, refund_id, school_id, memo, asset,
    asset_issuer, amount_expected, amount_received, tx_hash, ledger, counterparty, occurred_at, fee_paid, note, resolution)
  VALUES (@report_id, @result, @direction, @item_type, @payment_id, @refund_id, @school_id, @memo, @asset,
    @asset_issuer, @amount_expected, @amount_received, @tx_hash, @ledger, @counterparty, @occurred_at, @fee_paid, @note, @resolution)
`);

function hashOf(summary, items, balance) {
  const lines = items.map((it) => [it.result, it.direction, it.tx_hash, it.payment_id, it.refund_id, it.amount_received, it.resolution].join("|"));
  return crypto.createHash("sha256").update(JSON.stringify({ summary, lines, balance })).digest("hex");
}

// Saves (or replaces) one report and its items. Returns { id, created, changed }.
function saveReport({ kind, environment, asset, assetIssuer, period, summary, items, balance = {}, runSource, runBy }) {
  const summaryHash = hashOf(summary, items, balance);
  const existing = findReport.get(kind, environment, asset, assetIssuer || "", period.start);
  const id = existing ? existing.id : reportId();
  const row = {
    id, kind, environment, asset, assetIssuer: assetIssuer || null, periodStart: period.start, periodEnd: period.end,
    ...summary, paymentIds: JSON.stringify(summary.paymentIds),
    openingBalance: balance.openingBalance ?? null, expectedClosingBalance: balance.expectedClosingBalance ?? null,
    actualClosingBalance: balance.actualClosingBalance ?? null, balanceStatus: balance.balanceStatus ?? null,
    summaryHash, runSource, runBy: runBy || null, now: new Date().toISOString(),
  };
  db.transaction(() => {
    if (existing) {
      updateReport.run(row);
      deleteItems.run(id);
    } else {
      insertReport.run(row);
    }
    for (const it of items) {
      insertItem.run({
        report_id: id, result: it.result, direction: it.direction, item_type: it.item_type, payment_id: it.payment_id,
        refund_id: it.refund_id, school_id: it.school_id, memo: it.memo, asset: it.asset, asset_issuer: it.asset_issuer,
        amount_expected: it.amount_expected, amount_received: it.amount_received, tx_hash: it.tx_hash, ledger: it.ledger,
        counterparty: it.counterparty, occurred_at: it.occurred_at,
        fee_paid: typeof it.fee === "bigint" ? fromStroops(it.fee) : (it.fee_paid || "0.0000000"),
        note: it.note, resolution: it.resolution,
      });
    }
  })();
  return { id, created: !existing, changed: !existing || existing.summary_hash !== summaryHash };
}

const findCursor = db.prepare("SELECT * FROM reconciliation_cursors WHERE environment = ? AND account = ?");
const saveCursor = db.prepare(`
  INSERT INTO reconciliation_cursors (environment, account, paging_token, record_time, updated_at) VALUES (?, ?, ?, ?, ?)
  ON CONFLICT(environment, account) DO UPDATE SET paging_token = excluded.paging_token, record_time = excluded.record_time,
    updated_at = excluded.updated_at
`);

// Start after the saved cursor only if it is before the period; otherwise (a
// re-run of an older period) read from the oldest record Horizon keeps.
function cursorFor(environment, account, periodStart) {
  const saved = findCursor.get(environment, account);
  return saved && Date.parse(saved.record_time) < Date.parse(periodStart) ? saved.paging_token : null;
}
// Remember the last record before `periodEnd`, so the next day starts there.
function advanceCursor(environment, account, records, periodEnd) {
  const before = records.filter((r) => Date.parse(r.created_at) < Date.parse(periodEnd));
  const last = before[before.length - 1];
  if (!last || !last.paging_token) return;
  const saved = findCursor.get(environment, account);
  if (saved && Date.parse(saved.record_time) >= Date.parse(last.created_at)) return;
  saveCursor.run(environment, account, last.paging_token, last.created_at, new Date().toISOString());
}

// ---- runs -----------------------------------------------------------------------

let running = false;
async function exclusive(work) {
  if (running) throw new ReconcileError("A reconciliation is already running; try again in a minute", "RECONCILIATION_RUNNING");
  running = true;
  try {
    return await work();
  } finally {
    running = false;
  }
}

function checkStellar(stellar, period, now) {
  // Reconciliation only reads, but like the rest of Stellar Payments it is testnet only for now.
  if (!stellar || stellar.env !== "sandbox") {
    throw new ReconcileError("Reconciliation is only enabled on testnet (STELLAR_ENV=sandbox)", "RECONCILIATION_TESTNET_ONLY", 503);
  }
  if (Date.parse(period.end) > now.getTime()) {
    throw new ReconcileError(`The period ending ${period.end} is not over yet`, "PERIOD_NOT_OVER");
  }
}

// One day: classify, save one report per asset (XLM always), and send
// settlement.completed to each school with items when a report is new or changed.
async function reconcileDay({ date, records, stellar, fetchImpl, runSource, runBy }) {
  const period = dayPeriod(date);
  const merchant = stellar.merchantPublicKey;
  const movements = records.map((r) => describe(r, merchant)).filter(Boolean);
  const items = await dailyItems({ movements, period, merchant, horizonUrl: stellar.horizonUrl, fetchImpl });

  const groups = new Map([[assetKey("XLM", null), { asset: "XLM", assetIssuer: null, items: [] }]]);
  for (const it of items) {
    const key = assetKey(it.asset, it.asset_issuer);
    if (!groups.has(key)) groups.set(key, { asset: it.asset, assetIssuer: it.asset_issuer, items: [] });
    groups.get(key).items.push(it);
  }

  const reports = [];
  for (const group of groups.values()) {
    const isXlm = group.asset === "XLM" && !group.assetIssuer;
    const summary = summarize(group.items, isXlm ? items : []);
    const saved = saveReport({ kind: "daily", environment: stellar.env, asset: group.asset, assetIssuer: group.assetIssuer,
      period, summary, items: group.items, runSource, runBy });
    if (saved.changed) {
      const schools = [...new Set(group.items.map((it) => it.school_id).filter((id) => id !== null && id !== undefined))];
      for (const schoolId of schools) {
        const own = (list) => list.filter((it) => it.school_id === schoolId);
        enqueueSettlementCompleted(schoolId, {
          settlementId: saved.id, periodStart: period.start, periodEnd: period.end,
          asset: group.asset, assetIssuer: group.assetIssuer,
          ...withoutOpenCount(summarize(own(group.items), isXlm ? own(items) : [])),
        }, stellar.env);
      }
    }
    reports.push(saved.id);
  }
  return reports;
}

function withoutOpenCount(summary) {
  const { openExceptionCount, ...documented } = summary;
  return documented;
}

async function runDaily({ date, stellar, fetchImpl = fetch, now = new Date(), runSource = "command", runBy = null }) {
  const period = dayPeriod(date);
  checkStellar(stellar, period, now);
  return exclusive(async () => {
    const account = stellar.merchantPublicKey;
    const records = await fetchMerchantRecords({ horizonUrl: stellar.horizonUrl, account,
      cursor: cursorFor(stellar.env, account, period.start), fetchImpl });
    const ids = await reconcileDay({ date, records, stellar, fetchImpl, runSource, runBy });
    advanceCursor(stellar.env, account, records, period.end);
    return ids;
  });
}

const dailyReportsBetween = db.prepare(`SELECT * FROM settlement_reports
  WHERE kind = 'daily' AND environment = ? AND period_start >= ? AND period_start < ? ORDER BY period_start`);
const itemsOf = db.prepare("SELECT * FROM settlement_items WHERE report_id = ? ORDER BY occurred_at, id");
const previousWeekly = db.prepare(`SELECT * FROM settlement_reports
  WHERE kind = 'weekly' AND environment = ? AND asset = ? AND COALESCE(asset_issuer, '') = ? AND period_end = ?`);

// The merchant's balance in one asset, from GET /accounts (0 without a trustline).
function balanceIn(account, asset, assetIssuer) {
  if (!account) return 0n;
  const line = (account.balances || []).find((b) => (asset === "XLM" && !assetIssuer
    ? b.asset_type === "native"
    : b.asset_code === asset && b.asset_issuer === assetIssuer));
  return line ? toStroops(line.balance) : 0n;
}
// How much one movement changed the balance of one asset (fees are XLM).
function change(m, asset, assetIssuer) {
  if (!sameAssetAs(m, asset, assetIssuer)) return 0n;
  return m.direction === "in" ? toStroops(m.amount) : -toStroops(m.amount);
}

// One week (Monday to Sunday): re-run its days (which re-checks open items), add
// up the daily reports, check the balance per asset, and list open exceptions.
async function runWeekly({ date, stellar, fetchImpl = fetch, now = new Date(), runSource = "command", runBy = null }) {
  const period = weekPeriod(date);
  checkStellar(stellar, period, now);
  return exclusive(async () => {
    const merchant = stellar.merchantPublicKey;
    // Read the balance first: movements in later ledgers are not part of it.
    const account = await getAccount({ horizonUrl: stellar.horizonUrl, accountId: merchant, fetchImpl });
    const balanceLedger = account ? Number(account.last_modified_ledger || 0) : 0;
    const records = await fetchMerchantRecords({ horizonUrl: stellar.horizonUrl, account: merchant,
      cursor: cursorFor(stellar.env, merchant, period.start), fetchImpl });

    for (let day = 0; day < 7; day += 1) {
      const date = dayOf(Date.parse(period.start) + day * DAY_MS);
      await reconcileDay({ date, records, stellar, fetchImpl, runSource, runBy });
    }
    advanceCursor(stellar.env, merchant, records, period.end);

    const dailies = dailyReportsBetween.all(stellar.env, period.start, period.end);
    const movements = records.map((r) => describe(r, merchant)).filter(Boolean);
    const assets = new Map([[assetKey("XLM", null), { asset: "XLM", assetIssuer: null }]]);
    for (const r of dailies) assets.set(assetKey(r.asset, r.asset_issuer), { asset: r.asset, assetIssuer: r.asset_issuer });
    for (const b of (account && account.balances) || []) {
      if (b.asset_type !== "native") assets.set(assetKey(b.asset_code, b.asset_issuer), { asset: b.asset_code, assetIssuer: b.asset_issuer });
    }

    const ids = [];
    for (const { asset, assetIssuer } of assets.values()) {
      const isXlm = asset === "XLM" && !assetIssuer;
      const days = dailies.filter((r) => r.asset === asset && (r.asset_issuer || null) === (assetIssuer || null));
      const sum = (field) => days.reduce((total, r) => total + toStroops(r[field]), 0n);
      const count = (field) => days.reduce((total, r) => total + r[field], 0);
      const openItems = days.flatMap((r) => itemsOf.all(r.id)).filter((it) => it.result !== "matched" && !it.resolution);
      const gross = sum("gross_amount");
      const refunded = sum("refunded_amount");
      const summary = {
        paymentCount: count("payment_count"), grossAmount: fromStroops(gross), refundCount: count("refund_count"),
        refundedAmount: fromStroops(refunded), feesPaid: fromStroops(sum("fees_paid")), netAmount: fromStroops(gross - refunded),
        matchedCount: count("matched_count"), exceptionCount: count("exception_count"),
        openExceptionCount: openItems.length,
        paymentIds: [...new Set(days.flatMap((r) => JSON.parse(r.payment_ids)))],
      };

      // opening + movements in the week = expected closing; actual closing is the
      // balance now minus what moved after the week (up to the balance's ledger).
      const feeOnce = new Set();
      const net = (list) => list.reduce((total, m) => {
        const fee = isXlm && m.fee && !feeOnce.has(m.txHash) ? m.fee : 0n;
        if (fee) feeOnce.add(m.txHash);
        return total + change(m, asset, assetIssuer) - fee;
      }, 0n);
      const inWeek = net(movements.filter((m) => inPeriod(m.occurredAt, period)));
      const after = net(movements.filter((m) => Date.parse(m.occurredAt) >= Date.parse(period.end)
        && (!m.ledger || m.ledger <= balanceLedger)));
      const actual = balanceIn(account, asset, assetIssuer) - after;
      const previous = previousWeekly.get(stellar.env, asset, assetIssuer || "", period.start);
      let balance;
      if (previous && previous.actual_closing_balance !== null) {
        const opening = toStroops(previous.actual_closing_balance);
        const expected = opening + inWeek;
        balance = { openingBalance: fromStroops(opening), expectedClosingBalance: fromStroops(expected),
          actualClosingBalance: fromStroops(actual), balanceStatus: expected === actual ? "ok" : "mismatch" };
      } else {
        // The first week has nothing to compare with: it sets the starting point.
        balance = { openingBalance: fromStroops(actual - inWeek), expectedClosingBalance: fromStroops(actual),
          actualClosingBalance: fromStroops(actual), balanceStatus: "baseline" };
      }
      const saved = saveReport({ kind: "weekly", environment: stellar.env, asset, assetIssuer, period, summary,
        items: openItems, balance, runSource, runBy });
      ids.push(saved.id);
    }
    return ids;
  });
}

// ---- reading reports ----------------------------------------------------------------

function ageDays(time, now = new Date()) {
  return Math.floor((now.getTime() - Date.parse(time)) / DAY_MS);
}

function reportResponse(row) {
  const out = {
    settlementId: row.id,
    kind: row.kind,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    environment: row.environment,
    asset: row.asset,
    assetIssuer: row.asset_issuer || null,
    paymentCount: row.payment_count,
    grossAmount: row.gross_amount,
    refundCount: row.refund_count,
    refundedAmount: row.refunded_amount,
    feesPaid: row.fees_paid,
    netAmount: row.net_amount,
    matchedCount: row.matched_count,
    exceptionCount: row.exception_count,
    openExceptionCount: row.open_exception_count,
    paymentIds: JSON.parse(row.payment_ids),
    runSource: row.run_source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.kind === "weekly") {
    out.balance = {
      status: row.balance_status,
      openingBalance: row.opening_balance,
      expectedClosingBalance: row.expected_closing_balance,
      actualClosingBalance: row.actual_closing_balance,
    };
  }
  return out;
}

function itemResponse(row, now = new Date()) {
  const open = row.result !== "matched" && !row.resolution;
  return {
    result: row.result,
    direction: row.direction,
    type: row.item_type,
    paymentId: row.payment_id,
    refundId: row.refund_id,
    memo: row.memo,
    asset: row.asset,
    assetIssuer: row.asset_issuer || null,
    amountExpected: row.amount_expected,
    amountReceived: row.amount_received,
    transactionHash: row.tx_hash,
    ledger: row.ledger,
    counterparty: row.counterparty,
    occurredAt: row.occurred_at,
    feePaid: row.fee_paid,
    note: row.note,
    resolution: row.resolution,
    open,
    ageDays: open ? ageDays(row.occurred_at, now) : null,
    overdue: open && ageDays(row.occurred_at, now) > EXCEPTION_DEADLINE_DAYS,
  };
}

// CSV as in settlement.md, plus direction, note and resolution at the end. Text
// that came from the network (memos) cannot start a spreadsheet formula.
function itemsCsv(rows) {
  const cell = (value) => {
    let text = value === null || value === undefined ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = "date,paymentId,type,memo,asset,assetIssuer,amountExpected,amountReceived,transactionHash,ledger,result,direction,note,resolution";
  const lines = rows.map((r) => [
    r.occurred_at.slice(0, 10), r.payment_id, r.item_type === "payment" ? "invoice" : r.item_type, r.memo, r.asset, r.asset_issuer,
    r.amount_expected, r.amount_received, r.tx_hash, r.ledger, r.result, r.direction, r.note, r.resolution,
  ].map(cell).join(","));
  return `${[header, ...lines].join("\n")}\n`;
}

// ---- schedule ----------------------------------------------------------------------

let worker = null;
// Checks every 15 minutes: yesterday's daily run (shortly after midnight UTC) and
// last week's weekly run (on Monday), each only if its report does not exist yet.
function startReconciliationWorker({ intervalMs = 15 * 60 * 1000, loadConfig, log = console } = {}) {
  if (worker) return worker;
  const tick = async () => {
    let stellar;
    try {
      stellar = (loadConfig || require("./stellarConfig").loadStellarConfig)();
    } catch (error) {
      return; // Stellar is not configured: nothing to reconcile.
    }
    if (stellar.env !== "sandbox") return;
    const now = new Date();
    try {
      const day = yesterday(now);
      if (!findReport.get("daily", stellar.env, "XLM", "", dayPeriod(day).start)) {
        await runDaily({ date: day, stellar, now, runSource: "schedule" });
        warnAboutExceptions(log, "daily", day, stellar.env);
      }
      const week = lastWeekMonday(now);
      if (!findReport.get("weekly", stellar.env, "XLM", "", weekPeriod(week).start)) {
        await runWeekly({ date: week, stellar, now, runSource: "schedule" });
        warnAboutExceptions(log, "weekly", week, stellar.env);
      }
    } catch (error) {
      if (!(error instanceof ReconcileError && error.code === "RECONCILIATION_RUNNING")) {
        log.error(`Reconciliation failed: ${error.message}`);
      }
    }
  };
  worker = setInterval(() => { tick(); }, intervalMs);
  if (worker.unref) worker.unref();
  setImmediate(tick);
  return worker;
}

const reportsForPeriod = db.prepare("SELECT * FROM settlement_reports WHERE kind = ? AND environment = ? AND period_start = ?");
// The "alert an admin" step: a warning in the server log; the dashboard shows the
// exceptions on the report.
function warnAboutExceptions(log, kind, date, environment) {
  const period = kind === "daily" ? dayPeriod(date) : weekPeriod(date);
  for (const row of reportsForPeriod.all(kind, environment, period.start)) {
    if (row.open_exception_count > 0) {
      log.warn(`Settlement ${row.id} (${kind} ${row.asset}, ${period.start.slice(0, 10)}): ${row.open_exception_count} open exception(s) to review`);
    }
  }
}

module.exports = {
  RESULTS, EXCEPTION_DEADLINE_DAYS, ReconcileError,
  dayPeriod, weekPeriod, yesterday, lastWeekMonday,
  fetchMerchantRecords, describe, summarize,
  runDaily, runWeekly, reportResponse, itemResponse, itemsCsv, startReconciliationWorker,
};
