const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");
const { loadStellarConfig } = require("../stellarConfig");
const { loadPaymentPolicy } = require("../paymentPolicy");
const { HorizonError, toStroops, fromStroops, getAccount, canReceiveAsset, getTransactionWithPayments } = require("../stellarHorizon");
const { enqueueRefundIssued } = require("../webhookDelivery");
const signer = require("../stellarRefundSigner");

// Stellar refunds: request -> approve (a second admin above the threshold) or reject
// -> issue. See docs/stellar/refunds-and-chargebacks.md. A refund is a NEW payment
// from the merchant account, linked to the original by paymentId. Admin only.
const router = express.Router();
router.use(authenticate, authorize("admin"));

const REFUND_REASONS = [
  "customer_request", "service_issue", "overpaid", "duplicate", "wrong_asset", "underpaid", "late_payment", "dispute",
];
// Only these follow REFUND_WINDOW_DAYS. Operational refunds (our mistakes) and
// disputes (anchor deadlines) have no window.
const WINDOWED_REASONS = ["customer_request", "service_issue"];
const STELLAR_ACCOUNT = /^G[A-Z2-7]{55}$/;

const amountString = z.string().trim().regex(/^\d+(\.\d{1,7})?$/, "must be a positive amount with up to 7 decimal places");
const createSchema = z.object({
  paymentId: z.string().trim().min(1),
  amount: amountString,
  reason: z.enum(REFUND_REASONS),
  note: z.string().trim().min(1).max(500),
  destination: z.string().trim().regex(STELLAR_ACCOUNT, "must be a Stellar public key (G...)").optional(),
  destinationMemo: z.string().trim().min(1).max(28).optional(),
}).strict().refine((body) => !body.destinationMemo || body.destination, {
  message: "destinationMemo needs a destination given in writing",
  path: ["destinationMemo"],
});
const approveSchema = z.object({}).strict();
const rejectSchema = z.object({ note: z.string().trim().min(1).max(500) }).strict();
const listSchema = z.object({
  paymentId: z.string().trim().min(1).optional(),
  status: z.enum(["requested", "approved", "rejected", "issued"]).optional(),
}).strict();

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function randomCode(length) {
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += BASE32[bytes[i] % 32];
  return out;
}
const formatStroops = fromStroops;

const findPayment = db.prepare("SELECT * FROM payment_requests WHERE id = ?");
const findRefund = db.prepare("SELECT * FROM stellar_refunds WHERE id = ?");
const reservedFor = db.prepare("SELECT amount FROM stellar_refunds WHERE payment_id = ? AND status <> 'rejected'");
const userEmail = db.prepare("SELECT email FROM users WHERE id = ?");
const email = (id) => (id ? (userEmail.get(id) || {}).email || null : null);

function toResponse(row) {
  const payment = findPayment.get(row.payment_id);
  return {
    id: row.id,
    paymentId: row.payment_id,
    amount: row.amount,
    asset: row.asset,
    assetIssuer: row.asset_issuer || null,
    reason: row.reason,
    note: row.note,
    status: row.status,
    destination: row.destination,
    destinationMemo: row.destination_memo || null,
    destinationSource: row.destination_source,
    paymentMemo: row.payment_memo,
    needsSecondApproval: Boolean(row.needs_second_approval),
    requestedBy: email(row.requested_by),
    requestedAt: row.requested_at,
    approvedBy: email(row.approved_by),
    approvedAt: row.approved_at || null,
    secondApprovedBy: email(row.second_approved_by),
    secondApprovedAt: row.second_approved_at || null,
    rejectedBy: email(row.rejected_by),
    rejectedAt: row.rejected_at || null,
    rejectionNote: row.rejection_note || null,
    transactionHash: row.tx_hash || null,
    ledger: row.ledger || null,
    issuedAt: row.issued_at || null,
    originalTransactionHash: payment ? payment.tx_hash : null,
    sendInProgress: Boolean(row.pending_tx_hash),
    lastError: row.last_error || null,
  };
}

function policyOrError(res) {
  try {
    return loadPaymentPolicy();
  } catch (error) {
    sendError(res, 503, "PAYMENT_POLICY_INVALID", "The payment policy settings on this server are invalid", {
      problems: error.problems || [error.message],
    });
    return null;
  }
}

// ---- request ----------------------------------------------------------------

router.post("/", (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid refund request", parsed.error.flatten());
  const body = parsed.data;
  const policy = policyOrError(res);
  if (!policy) return undefined;

  const payment = findPayment.get(body.paymentId);
  if (!payment) return sendError(res, 404, "PAYMENT_NOT_FOUND", "No payment request has that ID");
  // Only payments where money arrived in the request's own asset can be refunded.
  const refundable = payment.tx_hash && payment.amount_received
    && (payment.status === "completed" || (payment.status === "failed" && payment.reason === "underpaid"));
  if (!refundable) {
    const why = payment.status === "failed" && payment.reason === "wrong_asset"
      ? "Refunds of wrong-asset payments are not supported yet (the asset that arrived is not stored)"
      : "Nothing arrived for this payment request, so there is nothing to refund";
    return sendError(res, 409, "PAYMENT_NOT_REFUNDABLE", why);
  }

  const amount = toStroops(body.amount);
  if (amount <= 0n) return sendError(res, 400, "VALIDATION_ERROR", "amount must be greater than 0");
  // The total refunded (including refunds still being approved) never exceeds what arrived.
  const reserved = reservedFor.all(payment.id).reduce((sum, r) => sum + toStroops(r.amount), 0n);
  const available = toStroops(payment.amount_received) - reserved;
  if (amount > available) {
    return sendError(res, 409, "REFUND_AMOUNT_TOO_HIGH",
      `At most ${formatStroops(available > 0n ? available : 0n)} ${payment.asset} can still be refunded for this payment`, {
        amountReceived: payment.amount_received, alreadyRefundedOrRequested: formatStroops(reserved),
      });
  }

  if (WINDOWED_REASONS.includes(body.reason)) {
    if (policy.refundWindowDays === null) {
      return sendError(res, 409, "REFUND_WINDOW_NOT_SET",
        "REFUND_WINDOW_DAYS is not set yet (TODO: group decision), so customer refunds cannot be requested");
    }
    const paidAt = Date.parse(payment.completed_at || payment.created_at);
    if (Date.now() > paidAt + policy.refundWindowDays * 24 * 3600 * 1000) {
      return sendError(res, 409, "REFUND_WINDOW_CLOSED",
        `The ${policy.refundWindowDays}-day refund window for this payment has closed`);
    }
  }

  // Default destination: the account that paid. Otherwise a destination given in writing.
  const written = Boolean(body.destination);
  const destination = body.destination || payment.source_account;
  if (!destination) {
    return sendError(res, 400, "VALIDATION_ERROR",
      "The payer's account is not known for this payment; give the destination in writing", {
        fieldErrors: { destination: ["required, because the original payer is not known"] },
      });
  }

  const threshold = policy.refundApprovalThresholds[payment.asset];
  // No threshold decided yet means every refund needs a second admin (the safe default).
  const needsSecond = threshold === null || amount > toStroops(threshold);
  const id = `ref_${randomCode(16)}`;
  db.prepare(`
    INSERT INTO stellar_refunds (id, payment_id, amount, asset, asset_issuer, reason, note, status, destination,
      destination_memo, destination_source, payment_memo, needs_second_approval, requested_by, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, payment.id, formatStroops(amount), payment.asset, payment.asset_issuer, body.reason, body.note,
    destination, body.destinationMemo || null, written ? "written" : "original_payer",
    body.destinationMemo || `RF-${randomCode(8)}`, needsSecond ? 1 : 0, req.user.id, new Date().toISOString());
  return sendSuccess(res, toResponse(findRefund.get(id)), {}, 201);
});

// ---- read -------------------------------------------------------------------

router.get("/", (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid filters", parsed.error.flatten());
  const where = [];
  const params = {};
  if (parsed.data.paymentId) { where.push("payment_id = @paymentId"); params.paymentId = parsed.data.paymentId; }
  if (parsed.data.status) { where.push("status = @status"); params.status = parsed.data.status; }
  const rows = db.prepare(`SELECT * FROM stellar_refunds ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY requested_at DESC, id DESC`).all(params);
  return sendSuccess(res, rows.map(toResponse), { total: rows.length, filtersApplied: parsed.data });
});

router.get("/:id", (req, res) => {
  const row = findRefund.get(req.params.id);
  if (!row) return sendError(res, 404, "REFUND_NOT_FOUND", "No refund has that ID");
  return sendSuccess(res, toResponse(row));
});

// ---- approve / reject ---------------------------------------------------------

router.post("/:id/approve", (req, res) => {
  if (!approveSchema.safeParse(req.body || {}).success) return sendError(res, 400, "VALIDATION_ERROR", "Send no body");
  const row = findRefund.get(req.params.id);
  if (!row) return sendError(res, 404, "REFUND_NOT_FOUND", "No refund has that ID");
  if (row.status !== "requested") return sendError(res, 409, "REFUND_NOT_PENDING_APPROVAL", `This refund is already ${row.status}`);
  const now = new Date().toISOString();

  if (!row.approved_by) {
    const done = !row.needs_second_approval;
    db.prepare(`UPDATE stellar_refunds SET approved_by = ?, approved_at = ?, status = ? WHERE id = ? AND status = 'requested'`)
      .run(req.user.id, now, done ? "approved" : "requested", row.id);
  } else {
    // Two-person rule: the second approver is neither the requester nor the first approver.
    if (req.user.id === row.requested_by || req.user.id === row.approved_by) {
      return sendError(res, 403, "SECOND_APPROVER_REQUIRED",
        "This refund is above the approval threshold: a second admin, who did not request it or approve it first, must approve it");
    }
    db.prepare(`UPDATE stellar_refunds SET second_approved_by = ?, second_approved_at = ?, status = 'approved' WHERE id = ? AND status = 'requested'`)
      .run(req.user.id, now, row.id);
  }
  return sendSuccess(res, toResponse(findRefund.get(row.id)));
});

router.post("/:id/reject", (req, res) => {
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Say why the refund is rejected", parsed.error.flatten());
  const row = findRefund.get(req.params.id);
  if (!row) return sendError(res, 404, "REFUND_NOT_FOUND", "No refund has that ID");
  if (!["requested", "approved"].includes(row.status)) return sendError(res, 409, "REFUND_NOT_PENDING_APPROVAL", `This refund is already ${row.status}`);
  if (row.pending_tx_hash) return sendError(res, 409, "REFUND_SEND_IN_PROGRESS", "A refund payment was already sent; check it before rejecting");
  db.prepare(`UPDATE stellar_refunds SET status = 'rejected', rejected_by = ?, rejected_at = ?, rejection_note = ? WHERE id = ?`)
    .run(req.user.id, new Date().toISOString(), parsed.data.note, row.id);
  return sendSuccess(res, toResponse(findRefund.get(row.id)));
});

// ---- issue (sends money: testnet only) ------------------------------------------

const markIssued = db.prepare(`
  UPDATE stellar_refunds SET status = 'issued', tx_hash = @hash, ledger = @ledger, issued_at = @issuedAt,
    pending_tx_hash = NULL, pending_tx_expires_at = NULL, last_error = NULL
  WHERE id = @id AND status = 'approved'
`);
const setPending = db.prepare("UPDATE stellar_refunds SET pending_tx_hash = ?, pending_tx_expires_at = ? WHERE id = ?");
const clearPending = db.prepare("UPDATE stellar_refunds SET pending_tx_hash = NULL, pending_tx_expires_at = NULL, last_error = ? WHERE id = ?");
const setError = db.prepare("UPDATE stellar_refunds SET last_error = ? WHERE id = ?");
const issuing = new Set();

function finishIssued(res, refundId, { hash, ledger, issuedAt }, stellar) {
  markIssued.run({ id: refundId, hash, ledger, issuedAt });
  const refund = findRefund.get(refundId);
  enqueueRefundIssued(refund, findPayment.get(refund.payment_id), stellar.env);
  return sendSuccess(res, toResponse(refund));
}

async function issueRefund(req, res) {
  const row = findRefund.get(req.params.id);
  if (!row) return sendError(res, 404, "REFUND_NOT_FOUND", "No refund has that ID");
  if (row.status === "issued") return sendError(res, 409, "REFUND_ALREADY_ISSUED", "This refund has already been issued");
  if (row.status !== "approved") {
    return sendError(res, 409, "REFUND_NOT_APPROVED",
      row.needs_second_approval && row.approved_by ? "This refund still needs a second admin's approval" : `This refund is ${row.status}, not approved`);
  }

  let stellar;
  try {
    stellar = loadStellarConfig();
  } catch (error) {
    return sendError(res, 503, "STELLAR_NOT_CONFIGURED", "Stellar sandbox settings are needed to send a refund");
  }
  // Refunds send real money on the public network, so they are refused outside testnet.
  if (stellar.env !== "sandbox" || stellar.networkPassphrase !== signer.TESTNET_PASSPHRASE) {
    return sendError(res, 503, "REFUNDS_TESTNET_ONLY", "Refund payments are only enabled on testnet (STELLAR_ENV=sandbox)");
  }

  try {
    // An earlier attempt was submitted but its result was unclear: find out first.
    if (row.pending_tx_hash) {
      const found = await getTransactionWithPayments({ horizonUrl: stellar.horizonUrl, hash: row.pending_tx_hash });
      if (found && found.transaction.successful === true) {
        return finishIssued(res, row.id, {
          hash: row.pending_tx_hash, ledger: found.transaction.ledger || null, issuedAt: found.transaction.created_at || new Date().toISOString(),
        }, stellar);
      }
      if (!found && Date.now() <= Date.parse(row.pending_tx_expires_at)) {
        return sendError(res, 409, "REFUND_SEND_IN_PROGRESS",
          "The last refund payment may still be processed; try again after it expires", { expiresAt: row.pending_tx_expires_at });
      }
      // It failed, or expired without landing: it can never be applied, so send a new one.
      clearPending.run("The previous refund payment did not go through", row.id);
    }

    // The destination must exist and be able to hold the asset, or the payment fails.
    const account = await getAccount({ horizonUrl: stellar.horizonUrl, accountId: row.destination });
    if (!account) {
      setError.run("The destination account does not exist on the network", row.id);
      return sendError(res, 422, "DESTINATION_NOT_FOUND", "The refund destination account does not exist on the network");
    }
    if (!canReceiveAsset(account, row.asset, row.asset_issuer)) {
      setError.run(`The destination has no ${row.asset} trustline`, row.id);
      return sendError(res, 422, "DESTINATION_NO_TRUSTLINE", `The refund destination cannot receive ${row.asset} (no trustline)`);
    }
  } catch (error) {
    if (error instanceof HorizonError) return sendError(res, 502, "HORIZON_UNAVAILABLE", "Horizon could not be reached. Try again later.");
    throw error;
  }

  try {
    const result = await signer.sendRefundPayment({
      horizonUrl: stellar.horizonUrl,
      networkPassphrase: stellar.networkPassphrase,
      merchantPublicKey: stellar.merchantPublicKey,
      merchantSecretKey: stellar.merchantSecretKey,
      destination: row.destination,
      asset: row.asset,
      assetIssuer: row.asset_issuer,
      amount: row.amount,
      memo: row.payment_memo,
      onSigned: ({ hash, expiresAt }) => setPending.run(hash, expiresAt, row.id),
    });
    return finishIssued(res, row.id, { hash: result.hash, ledger: result.ledger, issuedAt: new Date().toISOString() }, stellar);
  } catch (error) {
    if (!(error instanceof signer.RefundSendError)) throw error;
    if (error.definite) {
      clearPending.run(error.message, row.id);
      return sendError(res, 502, "REFUND_SEND_FAILED", error.message, { codes: error.codes });
    }
    // Unknown outcome: keep the pending hash, so the next attempt checks it first.
    setError.run(error.message, row.id);
    return sendError(res, 502, "REFUND_SEND_UNCONFIRMED",
      "The refund payment was sent but not confirmed yet; issue it again shortly to check", { transactionHash: findRefund.get(row.id).pending_tx_hash });
  }
}

router.post("/:id/issue", async (req, res, next) => {
  if (issuing.has(req.params.id)) return sendError(res, 409, "REFUND_SEND_IN_PROGRESS", "This refund is being issued right now");
  issuing.add(req.params.id);
  try {
    return await issueRefund(req, res);
  } catch (error) {
    return next(error);
  } finally {
    issuing.delete(req.params.id);
  }
});

module.exports = { router, REFUND_REASONS };
