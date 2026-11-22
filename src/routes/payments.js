const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { authenticateOrApiKey } = require("../middleware/apiKey");
const { sendSuccess, sendError } = require("../utils/envelope");
const { loadStellarConfig } = require("../stellarConfig");
const { toAssetAmount } = require("../pricing");
const { getQuote, RateUnavailableError } = require("../stellarQuotes");
const { loadPaymentPolicy, checkAmountLimits } = require("../paymentPolicy");
const { HorizonError, findPaymentsWithMemo, decideOutcome } = require("../stellarHorizon");
const { enqueuePaymentEvent } = require("../webhookDelivery");

const router = express.Router();

// How long a payment request (and its locked exchange rate) stays valid.
const PAYMENT_REQUEST_TTL_MINUTES = 30;
// Assets students can pay with right now. USDC is added once it is enabled.
const ENABLED_ASSETS = ["XLM"];

const createSchema = z
  .object({
    invoiceId: z.number().int().positive(),
    asset: z.string().default("XLM"),
  })
  .strict();

// Crockford base32: no I, L, O or U, so IDs and memos are easy to read out loud.
const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += BASE32[bytes[i] % 32];
  return out;
}

function studentIdFor(userId) {
  const row = db.prepare("SELECT id FROM students WHERE user_id = ?").get(userId);
  return row ? row.id : null;
}

// Outstanding balance = final amount minus payments already recorded. This is
// what gets converted, so a partly paid invoice is not charged twice.
const findInvoice = db.prepare(`
  SELECT i.id, i.student_id, i.currency, i.final_amount,
         ROUND(i.final_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0), 2) AS outstanding
  FROM invoices i
  WHERE i.id = ?
`);

const findOpenRequest = db.prepare(`
  SELECT id, status FROM payment_requests
  WHERE invoice_id = ?
    AND (status = 'completed' OR (status = 'pending' AND expires_at > ?))
  ORDER BY status = 'completed' DESC
  LIMIT 1
`);

// Pending requests for an invoice that have passed expiresAt but have not been
// checked on Horizon yet. They must be settled before a new quote is made.
const findExpiredPending = db.prepare(`
  SELECT * FROM payment_requests
  WHERE invoice_id = ? AND status = 'pending' AND expires_at <= ?
  ORDER BY created_at
`);

const insertRequest = db.prepare(`
  INSERT INTO payment_requests
    (id, invoice_id, amount, asset, asset_issuer, memo, destination, status,
     quoted_rate, rate_source, invoice_currency, invoice_amount, created_at, expires_at)
  VALUES
    (@id, @invoice_id, @amount, @asset, @asset_issuer, @memo, @destination, 'pending',
     @quoted_rate, @rate_source, @invoice_currency, @invoice_amount, @created_at, @expires_at)
`);

function paymentUri({ destination, amount, memo }) {
  const params = new URLSearchParams({ destination, amount, memo, memo_type: "MEMO_TEXT" });
  return `web+stellar:pay?${params.toString()}`;
}

function toResponse(row, network) {
  return {
    id: row.id,
    type: "invoice",
    status: row.status,
    reason: row.reason || null,
    invoiceId: row.invoice_id,
    invoiceCurrency: row.invoice_currency,
    invoiceAmount: row.invoice_amount,
    quotedRate: row.quoted_rate,
    rateSource: row.rate_source || null,
    rateQuotedAt: row.created_at,
    amount: row.amount,
    asset: row.asset,
    assetIssuer: row.asset_issuer,
    destination: row.destination,
    memo: row.memo,
    memoType: "text",
    paymentUri: paymentUri(row),
    network,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    amountReceived: row.amount_received || null,
    paidAt: row.completed_at || null,
    transactionHash: row.tx_hash || null,
    ledger: row.ledger || null,
    relatedPaymentId: row.related_payment_id || null,
  };
}

const findRequest = db.prepare(`
  SELECT pr.*, i.student_id, st.school_id
  FROM payment_requests pr
  LEFT JOIN invoices i ON i.id = pr.invoice_id
  LEFT JOIN students st ON st.id = i.student_id
  WHERE pr.id = ?
`);

// Only moves a request out of 'pending'; the schema trigger keeps final statuses final.
const settleRequest = db.prepare(`
  UPDATE payment_requests
  SET status = @status, reason = @reason, tx_hash = @txHash, amount_received = @amountReceived,
      ledger = @ledger, source_account = @sourceAccount, completed_at = @completedAt
  WHERE id = @id AND status = 'pending'
`);

// Checks a pending request on Horizon and settles it if Horizon shows an outcome
// (see docs/stellar/settlement.md). Returns { row } with the latest stored row,
// or { error } with the HTTP error to send. Used by GET /:id and before a new
// quote is made for an invoice.
async function checkPendingRequest(row, stellar) {
  let payments;
  try {
    payments = await findPaymentsWithMemo({
      horizonUrl: stellar.horizonUrl,
      account: row.destination,
      memo: row.memo,
      since: row.created_at,
    });
  } catch (error) {
    if (error instanceof HorizonError) {
      return { error: [502, "HORIZON_UNAVAILABLE", "Horizon could not be reached. Try again later."] };
    }
    throw error;
  }
  const outcome = decideOutcome(row, payments);
  if (outcome) {
    let changed;
    try {
      changed = settleRequest.run({ id: row.id, ...outcome }).changes > 0;
    } catch (error) {
      // The same transaction is already linked to another payment request.
      if (!String(error.message).includes("UNIQUE constraint failed")) throw error;
      return { error: [409, "TRANSACTION_ALREADY_LINKED", "The matching transaction is already linked to another payment record"] };
    }
    if (changed) {
      const settled = findRequest.get(row.id);
      enqueuePaymentEvent(settled.status === "completed" ? "payment.completed" : "payment.failed", settled, stellar.env);
      return { row: settled };
    }
  }
  return { row: findRequest.get(row.id) };
}


router.post("/", authenticate, authorize("student"), async (req, res, next) => {
  try {
    return await createPaymentRequest(req, res);
  } catch (error) {
    return next(error);
  }
});

async function createPaymentRequest(req, res) {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid payment request", parsed.error.flatten());
  }
  const { invoiceId, asset } = parsed.data;
  if (!ENABLED_ASSETS.includes(asset)) {
    return sendError(res, 400, "UNSUPPORTED_ASSET", `Supported assets: ${ENABLED_ASSETS.join(", ")}`);
  }

  let stellar;
  try {
    stellar = loadStellarConfig();
  } catch (error) {
    return sendError(res, 503, "STELLAR_NOT_CONFIGURED", "Stellar payments are not configured on this server");
  }
  if (stellar.env !== "sandbox") {
    return sendError(res, 503, "STELLAR_NOT_CONFIGURED", "Only sandbox (testnet) payment requests are enabled so far");
  }

  let policy;
  try {
    policy = loadPaymentPolicy();
  } catch (error) {
    // Lists the invalid setting names only; policy settings never hold secrets.
    return sendError(res, 503, "PAYMENT_POLICY_INVALID", "The payment policy settings on this server are invalid", {
      problems: error.problems || [error.message],
    });
  }

  // Students can only pay their own invoices. Someone else's invoice looks the
  // same as a missing one, so its existence is not revealed.
  const invoice = findInvoice.get(invoiceId);
  const studentId = studentIdFor(req.user.id);
  if (!invoice || studentId === null || invoice.student_id !== studentId) {
    return sendError(res, 404, "INVOICE_NOT_FOUND", "No invoice with that ID was found for your account");
  }

  // A quote stays locked until its request expires. Before quoting again, settle
  // any expired request that nobody has checked yet: the student may have paid it
  // just before it expired, and must not be asked to pay twice.
  for (const expired of findExpiredPending.all(invoice.id, new Date().toISOString())) {
    const checked = await checkPendingRequest(expired, stellar);
    if (checked.error) return sendError(res, ...checked.error);
  }

  const now = new Date();
  const open = findOpenRequest.get(invoice.id, now.toISOString());
  if (open && open.status === "completed") {
    return sendError(res, 409, "INVOICE_NOTHING_DUE", "This invoice has already been paid through Stellar");
  }
  if (invoice.outstanding <= 0) {
    return sendError(res, 409, "INVOICE_NOTHING_DUE", "This invoice has nothing left to pay");
  }
  if (open) {
    return sendError(res, 409, "PAYMENT_ALREADY_PENDING", "A payment request for this invoice is still pending", {
      paymentId: open.id,
    });
  }

  let quote;
  try {
    quote = getQuote({ environment: stellar.env, asset, invoiceCurrency: invoice.currency, policy });
  } catch (error) {
    if (error instanceof RateUnavailableError) {
      return sendError(res, 422, "RATE_UNAVAILABLE", error.message);
    }
    throw error;
  }

  const amount = toAssetAmount(invoice.outstanding, quote.quotedRate);
  const outOfRange = checkAmountLimits(policy, asset, amount);
  if (outOfRange) {
    return sendError(res, 400, "VALIDATION_ERROR", outOfRange, {
      amount, asset, min: policy.limits[asset].min, max: policy.limits[asset].max,
    });
  }

  const createdAt = quote.quotedAt;
  const row = {
    invoice_id: invoice.id,
    invoice_amount: invoice.outstanding.toFixed(2),
    amount,
    asset,
    asset_issuer: null, // XLM is native and has no issuer
    destination: stellar.merchantPublicKey,
    quoted_rate: quote.quotedRate,
    rate_source: quote.source,
    invoice_currency: invoice.currency,
    created_at: createdAt,
    expires_at: new Date(Date.parse(createdAt) + PAYMENT_REQUEST_TTL_MINUTES * 60 * 1000).toISOString(),
    related_payment_id: null,
    status: "pending",
  };

  // Retry with a new ID and memo in the unlikely case of a collision.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    row.id = `pay_${randomCode(16)}`;
    row.memo = `PL-${randomCode(8)}`;
    try {
      insertRequest.run(row);
      enqueuePaymentEvent("payment.pending", findRequest.get(row.id), stellar.env);
      return sendSuccess(res, toResponse(row, stellar.env), {}, 201);
    } catch (error) {
      if (!String(error.message).includes("UNIQUE constraint failed")) throw error;
    }
  }
  return sendError(res, 500, "INTERNAL_ERROR", "Could not create a unique payment request");
}

// Lists the signed-in student's invoices, newest first, with what is still due
// and the latest Stellar payment request for each (so the dashboard can resume
// a pending one). Invoice status: due (nothing paid), partial, or settled.
const listStudentInvoices = db.prepare(`
  SELECT i.id, t.code AS term_code, t.name AS term_name, i.currency, i.final_amount, i.due_at,
         ROUND(COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0), 2) AS recorded
  FROM invoices i
  JOIN terms t ON t.id = i.term_id
  WHERE i.student_id = ?
  ORDER BY t.start_date DESC, i.id DESC
`);
const latestRequestFor = db.prepare(`
  SELECT id, status, reason, amount, asset, expires_at, completed_at
  FROM payment_requests
  WHERE invoice_id = ?
  ORDER BY created_at DESC
  LIMIT 1
`);
const hasCompletedRequest = db.prepare(
  "SELECT 1 FROM payment_requests WHERE invoice_id = ? AND status = 'completed' LIMIT 1"
);

// Admin list of payment requests, newest first, with an optional status filter.
// Returns statuses as stored: it does not ask Horizon (open a request with
// GET /:id to check a pending one).
const LIST_PAGE_SIZE = 25;
const listSchema = z
  .object({
    status: z.enum(["pending", "completed", "failed"]).optional(),
    reason: z.enum(["expired", "cancelled", "underpaid", "wrong_asset"]).optional(),
    page: z.coerce.number().int().min(1).default(1),
  })
  .strict()
  .refine((query) => !query.reason || !query.status || query.status === "failed", {
    message: "reason can only be used with status=failed",
    path: ["reason"],
  });

// A customer API key sees only its own school's requests (through invoice -> student -> school).
router.get("/", authenticateOrApiKey("admin"), (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) {
    return sendError(res, 400, "VALIDATION_ERROR", "Invalid filters", parsed.error.flatten());
  }
  const { status, reason, page } = parsed.data;
  const where = [];
  const params = { limit: LIST_PAGE_SIZE, offset: (page - 1) * LIST_PAGE_SIZE };
  if (req.apiKey) {
    where.push(`invoice_id IN (
      SELECT i.id FROM invoices i JOIN students st ON st.id = i.student_id WHERE st.school_id = @schoolId
    )`);
    params.schoolId = req.apiKey.schoolId;
  }
  if (status) { where.push("status = @status"); params.status = status; }
  if (reason) { where.push("status = 'failed' AND reason = @reason"); params.reason = reason; }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db.prepare(`SELECT COUNT(*) AS n FROM payment_requests ${whereSql}`).get(params).n;
  const rows = db.prepare(`
    SELECT * FROM payment_requests ${whereSql}
    ORDER BY created_at DESC, id DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  let network = null;
  try {
    network = loadStellarConfig().env;
  } catch (error) {
    network = null;
  }
  const filtersApplied = {};
  if (status) filtersApplied.status = status;
  if (reason) filtersApplied.reason = reason;
  return sendSuccess(res, rows.map((row) => toResponse(row, network)), {
    page, total, filtersApplied, pageSize: LIST_PAGE_SIZE,
  });
});

router.get("/invoices", authenticate, authorize("student"), (req, res) => {
  const studentId = studentIdFor(req.user.id);
  if (studentId === null) return sendSuccess(res, [], { total: 0 });

  const invoices = listStudentInvoices.all(studentId).map((invoice) => {
    const paidThroughStellar = Boolean(hasCompletedRequest.get(invoice.id));
    const outstanding = paidThroughStellar ? 0 : Math.max(0, Math.round((invoice.final_amount - invoice.recorded) * 100) / 100);
    let status = "partial";
    if (outstanding <= 0) status = "settled";
    else if (invoice.recorded <= 0) status = "due";
    const latest = latestRequestFor.get(invoice.id);
    return {
      id: invoice.id,
      term: invoice.term_name || invoice.term_code,
      termCode: invoice.term_code,
      currency: invoice.currency,
      finalAmount: invoice.final_amount.toFixed(2),
      recordedPayments: invoice.recorded.toFixed(2),
      outstanding: outstanding.toFixed(2),
      dueAt: invoice.due_at,
      status,
      latestPaymentRequest: latest
        ? {
          id: latest.id,
          status: latest.status,
          reason: latest.reason || null,
          amount: latest.amount,
          asset: latest.asset,
          expiresAt: latest.expires_at,
          paidAt: latest.completed_at || null,
        }
        : null,
    };
  });
  return sendSuccess(res, invoices, { total: invoices.length });
});

// Returns a payment request. While it is pending, checks Horizon first and
// marks it completed or failed (see docs/stellar/settlement.md).
router.get("/:id", authenticateOrApiKey("student", "admin"), async (req, res, next) => {
  try {
    let row = findRequest.get(req.params.id);
    // Students only see requests for their own invoices, and API keys only their
    // own school's; anything else looks missing.
    const ownStudentId = req.user && req.user.role === "student" ? studentIdFor(req.user.id) : null;
    const hidden = req.apiKey
      ? !row || row.school_id !== req.apiKey.schoolId
      : !row || (req.user.role === "student" && (ownStudentId === null || row.student_id !== ownStudentId));
    if (hidden) {
      return sendError(res, 404, "PAYMENT_NOT_FOUND", "No payment request has that ID");
    }

    let stellar = null;
    try {
      stellar = loadStellarConfig();
    } catch (error) {
      stellar = null;
    }

    if (row.status === "pending") {
      if (!stellar || stellar.env !== "sandbox") {
        return sendError(res, 503, "STELLAR_NOT_CONFIGURED", "Stellar sandbox settings are needed to check this payment");
      }
      const checked = await checkPendingRequest(row, stellar);
      if (checked.error) return sendError(res, ...checked.error);
      row = checked.row;
    }

    return sendSuccess(res, toResponse(row, stellar ? stellar.env : null));
  } catch (error) {
    return next(error);
  }
});

const cancelRequest = db.prepare(`
  UPDATE payment_requests SET status = 'failed', reason = 'cancelled'
  WHERE id = ? AND status = 'pending'
`);

// Cancels a pending payment request: it becomes failed with reason cancelled.
// Students can cancel requests for their own invoices; admins can cancel any.
// Horizon is checked first, so a request the payer has already paid is
// completed instead of cancelled (see docs/stellar/payments-api.md).
router.post("/:id/cancel", authenticate, authorize("student", "admin"), async (req, res, next) => {
  try {
    const row = findRequest.get(req.params.id);
    const ownStudentId = req.user.role === "student" ? studentIdFor(req.user.id) : null;
    if (!row || (req.user.role === "student" && (ownStudentId === null || row.student_id !== ownStudentId))) {
      return sendError(res, 404, "PAYMENT_NOT_FOUND", "No payment request has that ID");
    }
    if (row.status === "completed") {
      return sendError(res, 409, "PAYMENT_ALREADY_COMPLETED", "This payment request is already completed and cannot be cancelled");
    }
    if (row.status !== "pending") {
      return sendError(res, 409, "PAYMENT_NOT_PENDING", `This payment request is already failed (${row.reason}) and cannot be cancelled`);
    }

    let stellar;
    try {
      stellar = loadStellarConfig();
    } catch (error) {
      stellar = null;
    }
    if (!stellar || stellar.env !== "sandbox") {
      return sendError(res, 503, "STELLAR_NOT_CONFIGURED", "Stellar sandbox settings are needed to check this payment before cancelling");
    }

    // Settle it first if Horizon already shows a payment (or it has expired).
    const checked = await checkPendingRequest(row, stellar);
    if (checked.error) return sendError(res, ...checked.error);
    if (checked.row.status === "completed") {
      return sendError(res, 409, "PAYMENT_ALREADY_COMPLETED", "A payment for this request has already arrived, so it cannot be cancelled", {
        paymentId: row.id, transactionHash: checked.row.tx_hash,
      });
    }
    if (checked.row.status !== "pending") {
      return sendError(res, 409, "PAYMENT_NOT_PENDING", `This payment request is already failed (${checked.row.reason}) and cannot be cancelled`);
    }

    const result = cancelRequest.run(row.id);
    const updated = findRequest.get(row.id);
    if (result.changes === 0) {
      return sendError(res, 409, "PAYMENT_NOT_PENDING", "This payment request is no longer pending");
    }
    // A cancellation is sent as payment.failed with reason cancelled (webhooks.md).
    enqueuePaymentEvent("payment.failed", updated, stellar.env);
    return sendSuccess(res, toResponse(updated, stellar.env));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
