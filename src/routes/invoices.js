const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");
const { pricingSchema, computeFinalAmount, SCHOLARSHIP_TYPES } = require("../pricing");
const { clearFinanceCache } = require("../utils/financeCache");

// Admin-only endpoints to create and update invoices with pricing fields.
// See "Invoice endpoints" in docs/stellar/payments-api.md.
const router = express.Router();
router.use(authenticate, authorize("admin"));

// Pricing fields as the API names them, mapped to invoices table columns.
const PRICING_COLUMNS = {
  basePrice: "amount",
  currency: "currency",
  scholarshipAmount: "scholarship_amount",
  scholarshipType: "scholarship_type",
  scholarshipName: "scholarship_name",
  discountPercent: "discount_percent",
  discountCode: "discount_code",
  platformFee: "platform_fee",
  transactionFee: "transaction_fee",
  instructorCost: "instructor_cost",
};
const PRICING_KEYS = Object.keys(PRICING_COLUMNS);

const isoDate = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value)), {
  message: "must be an ISO 8601 date, for example 2026-12-15 or 2026-12-15T23:59:00Z",
});

// Non-pricing fields. studentId and termId are set on creation and never change.
const createExtraSchema = z.object({
  studentId: z.number().int().positive(),
  termId: z.number().int().positive(),
  issuedAt: isoDate.optional(),
  dueAt: isoDate,
});
const patchExtraSchema = z.object({ dueAt: isoDate.optional() });

// PATCH accepts any pricing field (all optional); pricingSchema then checks the merged result.
const patchPricingSchema = z.object(Object.fromEntries(PRICING_KEYS.map((key) => [key, z.any()]))).partial();

const findInvoice = db.prepare("SELECT * FROM invoices WHERE id = ?");
const studentExists = db.prepare("SELECT 1 FROM students WHERE id = ?");
const termExists = db.prepare("SELECT 1 FROM terms WHERE id = ?");
const hasRecordedPayment = db.prepare("SELECT 1 FROM payments WHERE invoice_id = ? LIMIT 1");
const hasCompletedRequest = db.prepare(
  "SELECT 1 FROM payment_requests WHERE invoice_id = ? AND status = 'completed' LIMIT 1"
);
const findPendingRequest = db.prepare(
  "SELECT id FROM payment_requests WHERE invoice_id = ? AND status = 'pending' AND expires_at > ? LIMIT 1"
);

function toResponse(row) {
  return {
    id: row.id,
    studentId: row.student_id,
    termId: row.term_id,
    currency: row.currency,
    basePrice: row.amount,
    scholarshipAmount: row.scholarship_amount,
    scholarshipType: row.scholarship_type,
    scholarshipName: row.scholarship_name,
    discountPercent: row.discount_percent,
    discountCode: row.discount_code,
    platformFee: row.platform_fee,
    transactionFee: row.transaction_fee,
    instructorCost: row.instructor_cost,
    finalAmount: row.final_amount,
    issuedAt: row.issued_at,
    dueAt: row.due_at,
  };
}

function pricingFromRow(row) {
  return Object.fromEntries(PRICING_KEYS.map((key) => [key, row[PRICING_COLUMNS[key]]]));
}

// Splits a request body into pricing fields and the other fields.
function splitBody(body) {
  const pricing = {};
  const other = {};
  for (const [key, value] of Object.entries(body && typeof body === "object" ? body : {})) {
    if (PRICING_KEYS.includes(key)) pricing[key] = value;
    else other[key] = value;
  }
  return { pricing, other };
}

function validationError(res, message, error) {
  return sendError(res, 400, "VALIDATION_ERROR", message, error.flatten());
}

function checkDates(res, issuedAt, dueAt) {
  if (Date.parse(dueAt) < Date.parse(issuedAt)) {
    sendError(res, 400, "VALIDATION_ERROR", "dueAt cannot be before issuedAt", { fieldErrors: { dueAt: ["must not be before issuedAt"] } });
    return false;
  }
  return true;
}

// Why an invoice cannot be edited right now, or null when it can.
function lockReason(invoiceId) {
  if (hasCompletedRequest.get(invoiceId) || hasRecordedPayment.get(invoiceId)) return "completed_payment";
  if (findPendingRequest.get(invoiceId, new Date().toISOString())) return "pending_payment_request";
  return null;
}

function withEditable(row) {
  const reason = lockReason(row.id);
  return {
    ...toResponse(row),
    studentNumber: row.student_number,
    studentName: row.student_name,
    termName: row.term_name,
    editable: reason === null,
    lockReason: reason,
  };
}

const INVOICE_LIST_SQL = `
  SELECT i.*, s.student_number, u.name AS student_name, t.name AS term_name
  FROM invoices i
  JOIN students s ON s.id = i.student_id
  JOIN users u ON u.id = s.user_id
  JOIN terms t ON t.id = i.term_id
`;
const LIST_PAGE_SIZE = 25;
const listSchema = z.object({
  student: z.string().trim().min(1).max(40).optional(),
  termId: z.coerce.number().int().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
}).strict();

// Terms (with IDs) and scholarship types for the dashboard's invoice form.
router.get("/options", (req, res) => {
  const terms = db.prepare("SELECT id, name, code, is_current AS isCurrent FROM terms ORDER BY start_date DESC").all()
    .map((term) => ({ ...term, isCurrent: Boolean(term.isCurrent) }));
  return sendSuccess(res, { terms, scholarshipTypes: SCHOLARSHIP_TYPES });
});

// Finds a student by student number (for example STU-0001), so the form can use it.
router.get("/students", (req, res) => {
  const number = typeof req.query.number === "string" ? req.query.number.trim() : "";
  if (!number) return sendError(res, 400, "VALIDATION_ERROR", "Send a student number, for example ?number=STU-0001");
  const student = db.prepare(`
    SELECT s.id, s.student_number AS studentNumber, u.name
    FROM students s JOIN users u ON u.id = s.user_id
    WHERE s.student_number = ? COLLATE NOCASE
  `).get(number);
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "No student has that student number");
  return sendSuccess(res, student);
});

// Lists invoices, newest first, optionally for one student (number) and/or term.
router.get("/", (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return validationError(res, "Invalid filters", parsed.error);
  const { student, termId, page } = parsed.data;
  const where = [];
  const params = { limit: LIST_PAGE_SIZE, offset: (page - 1) * LIST_PAGE_SIZE };
  if (student) { where.push("s.student_number = @student COLLATE NOCASE"); params.student = student; }
  if (termId) { where.push("i.term_id = @termId"); params.termId = termId; }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM (${INVOICE_LIST_SQL} ${whereSql})`).get(params).n;
  const rows = db.prepare(`${INVOICE_LIST_SQL} ${whereSql} ORDER BY i.id DESC LIMIT @limit OFFSET @offset`).all(params);
  const filtersApplied = {};
  if (student) filtersApplied.student = student;
  if (termId) filtersApplied.termId = termId;
  return sendSuccess(res, rows.map(withEditable), { page, total, filtersApplied, pageSize: LIST_PAGE_SIZE });
});

router.get("/:id", (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) && id > 0 ? db.prepare(`${INVOICE_LIST_SQL} WHERE i.id = ?`).get(id) : undefined;
  if (!row) return sendError(res, 404, "INVOICE_NOT_FOUND", "No invoice has that ID");
  return sendSuccess(res, withEditable(row));
});

router.post("/", (req, res) => {
  const { pricing, other } = splitBody(req.body);
  const extra = createExtraSchema.strict().safeParse(other);
  if (!extra.success) return validationError(res, "Invalid invoice", extra.error);
  const parsed = pricingSchema.safeParse(pricing);
  if (!parsed.success) return validationError(res, "Invalid invoice pricing", parsed.error);

  const { studentId, termId, dueAt } = extra.data;
  const issuedAt = extra.data.issuedAt || new Date().toISOString();
  if (!checkDates(res, issuedAt, dueAt)) return undefined;
  if (!studentExists.get(studentId)) return sendError(res, 404, "STUDENT_NOT_FOUND", "No student has that ID");
  if (!termExists.get(termId)) return sendError(res, 404, "TERM_NOT_FOUND", "No term has that ID");

  const p = parsed.data;
  const id = db.prepare(`
    INSERT INTO invoices (student_id, term_id, amount, currency, scholarship_amount, scholarship_type, scholarship_name,
      discount_percent, discount_code, platform_fee, transaction_fee, instructor_cost, issued_at, due_at)
    VALUES (@studentId, @termId, @basePrice, @currency, @scholarshipAmount, @scholarshipType, @scholarshipName,
      @discountPercent, @discountCode, @platformFee, @transactionFee, @instructorCost, @issuedAt, @dueAt)
  `).run({ ...p, studentId, termId, issuedAt, dueAt }).lastInsertRowid;
  clearFinanceCache();

  const row = findInvoice.get(id);
  return sendSuccess(res, { ...toResponse(row), finalAmount: computeFinalAmount(p) }, {}, 201);
});

router.patch("/:id", (req, res) => {
  const id = Number(req.params.id);
  const invoice = Number.isInteger(id) && id > 0 ? findInvoice.get(id) : undefined;
  if (!invoice) return sendError(res, 404, "INVOICE_NOT_FOUND", "No invoice has that ID");

  const { pricing, other } = splitBody(req.body);
  const extra = patchExtraSchema.strict().safeParse(other);
  if (!extra.success) {
    return validationError(res, "Invalid invoice update (studentId, termId and issuedAt cannot be changed)", extra.error);
  }
  const patch = patchPricingSchema.strict().safeParse(pricing);
  if (!patch.success) return validationError(res, "Invalid invoice update", patch.error);
  if (Object.keys(pricing).length === 0 && !extra.data.dueAt) {
    return sendError(res, 400, "VALIDATION_ERROR", "Send at least one field to change");
  }

  // Money has already been received for this invoice, so its price is final.
  if (hasCompletedRequest.get(invoice.id) || hasRecordedPayment.get(invoice.id)) {
    return sendError(res, 409, "INVOICE_HAS_COMPLETED_PAYMENT",
      "This invoice already has a completed payment, so it cannot be changed");
  }
  // A pending request has a locked quote for the current price.
  const pending = findPendingRequest.get(invoice.id, new Date().toISOString());
  if (pending) {
    return sendError(res, 409, "PAYMENT_ALREADY_PENDING",
      "This invoice has a pending payment request; change it after the request expires or fails", { paymentId: pending.id });
  }

  // Removing the scholarship also clears its type and name, unless they are sent too.
  const changes = { ...pricing };
  if (changes.scholarshipAmount === 0) {
    if (!("scholarshipType" in changes)) changes.scholarshipType = null;
    if (!("scholarshipName" in changes)) changes.scholarshipName = null;
  }
  const merged = pricingSchema.safeParse({ ...pricingFromRow(invoice), ...changes });
  if (!merged.success) return validationError(res, "Invalid invoice pricing", merged.error);

  const dueAt = extra.data.dueAt || invoice.due_at;
  if (!checkDates(res, invoice.issued_at, dueAt)) return undefined;

  const p = merged.data;
  db.prepare(`
    UPDATE invoices SET amount = @basePrice, currency = @currency, scholarship_amount = @scholarshipAmount,
      scholarship_type = @scholarshipType, scholarship_name = @scholarshipName, discount_percent = @discountPercent,
      discount_code = @discountCode, platform_fee = @platformFee, transaction_fee = @transactionFee,
      instructor_cost = @instructorCost, due_at = @dueAt
    WHERE id = @id
  `).run({ ...p, dueAt, id: invoice.id });
  clearFinanceCache();

  return sendSuccess(res, { ...toResponse(findInvoice.get(invoice.id)), finalAmount: computeFinalAmount(p) });
});

module.exports = router;
