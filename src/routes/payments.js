const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");
const { loadStellarConfig } = require("../stellarConfig");
const { toAssetAmount } = require("../pricing");
const { getQuote, RateUnavailableError } = require("../stellarQuotes");
const { HorizonError, findPaymentsWithMemo, decideOutcome } = require("../stellarHorizon");

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

// Outstanding balance = final amount minus payments already recorded.
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

const insertRequest = db.prepare(`
  INSERT INTO payment_requests
    (id, invoice_id, amount, asset, asset_issuer, memo, destination, status,
     quoted_rate, invoice_currency, invoice_amount, created_at, expires_at)
  VALUES
    (@id, @invoice_id, @amount, @asset, @asset_issuer, @memo, @destination, 'pending',
     @quoted_rate, @invoice_currency, @invoice_amount, @created_at, @expires_at)
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
  SELECT pr.*, i.student_id
  FROM payment_requests pr
  LEFT JOIN invoices i ON i.id = pr.invoice_id
  WHERE pr.id = ?
`);

// Only moves a request out of 'pending'; the schema trigger keeps final statuses final.
const settleRequest = db.prepare(`
  UPDATE payment_requests
  SET status = @status, reason = @reason, tx_hash = @txHash, amount_received = @amountReceived,
      ledger = @ledger, completed_at = @completedAt
  WHERE id = @id AND status = 'pending'
`);


router.post("/", authenticate, authorize("student"), (req, res) => {
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

  // Students can only pay their own invoices. Someone else's invoice looks the
  // same as a missing one, so its existence is not revealed.
  const invoice = findInvoice.get(invoiceId);
  const studentId = studentIdFor(req.user.id);
  if (!invoice || studentId === null || invoice.student_id !== studentId) {
    return sendError(res, 404, "INVOICE_NOT_FOUND", "No invoice with that ID was found for your account");
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
    quote = getQuote({ environment: stellar.env, asset, invoiceCurrency: invoice.currency });
  } catch (error) {
    if (error instanceof RateUnavailableError) {
      return sendError(res, 422, "RATE_UNAVAILABLE", error.message);
    }
    throw error;
  }

  const createdAt = quote.quotedAt;
  const row = {
    invoice_id: invoice.id,
    invoice_amount: invoice.outstanding.toFixed(2),
    amount: toAssetAmount(invoice.outstanding, quote.quotedRate),
    asset,
    asset_issuer: null, // XLM is native and has no issuer
    destination: stellar.merchantPublicKey,
    quoted_rate: quote.quotedRate,
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
      return sendSuccess(res, toResponse(row, stellar.env), {}, 201);
    } catch (error) {
      if (!String(error.message).includes("UNIQUE constraint failed")) throw error;
    }
  }
  return sendError(res, 500, "INTERNAL_ERROR", "Could not create a unique payment request");
});

// Returns a payment request. While it is pending, checks Horizon first and
// marks it completed or failed (see docs/stellar/settlement.md).
router.get("/:id", authenticate, authorize("student", "admin"), async (req, res, next) => {
  try {
    let row = findRequest.get(req.params.id);
    // Students only see requests for their own invoices; others look missing.
    const ownStudentId = req.user.role === "student" ? studentIdFor(req.user.id) : null;
    if (!row || (req.user.role === "student" && (ownStudentId === null || row.student_id !== ownStudentId))) {
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
          return sendError(res, 502, "HORIZON_UNAVAILABLE", "Horizon could not be reached. Try again later.");
        }
        throw error;
      }
      const outcome = decideOutcome(row, payments);
      if (outcome) {
        try {
          settleRequest.run({ id: row.id, ...outcome });
        } catch (error) {
          // The same transaction is already linked to another payment request.
          if (!String(error.message).includes("UNIQUE constraint failed")) throw error;
          return sendError(res, 409, "TRANSACTION_ALREADY_LINKED", "The matching transaction is already linked to another payment record");
        }
        row = findRequest.get(row.id);
      }
    }

    return sendSuccess(res, toResponse(row, stellar ? stellar.env : null));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
