const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");
const { loadStellarConfig } = require("../stellarConfig");
const { HorizonError } = require("../stellarHorizon");
const recon = require("../stellarReconcile");

// Settlement reports (docs/stellar/settlement.md). Admin only: a report covers the
// whole merchant account, so it includes every school's payments.
const router = express.Router();
router.use(authenticate, authorize("admin"));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const listSchema = z.object({
  kind: z.enum(["daily", "weekly"]).optional(),
  asset: z.string().trim().min(1).max(12).optional(),
  from: z.string().regex(DATE, "must be YYYY-MM-DD").optional(),
  to: z.string().regex(DATE, "must be YYYY-MM-DD").optional(),
  limit: z.coerce.number().int().min(1).max(200).default(60),
}).strict();
const runSchema = z.object({
  kind: z.enum(["daily", "weekly"]),
  // daily: the day; weekly: any day of the week (its Monday is used). Default: the last finished one.
  date: z.string().regex(DATE, "must be YYYY-MM-DD").optional(),
}).strict();

router.get("/", (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid filters", parsed.error.flatten());
  const { kind, asset, from, to, limit } = parsed.data;
  const where = [];
  const params = { limit };
  if (kind) { where.push("kind = @kind"); params.kind = kind; }
  if (asset) { where.push("asset = @asset"); params.asset = asset; }
  if (from) { where.push("period_start >= @from"); params.from = `${from}T00:00:00.000Z`; }
  if (to) { where.push("period_start <= @to"); params.to = `${to}T00:00:00.000Z`; }
  const rows = db.prepare(`SELECT * FROM settlement_reports ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY period_start DESC, kind, asset LIMIT @limit`).all(params);
  return sendSuccess(res, rows.map(recon.reportResponse), { total: rows.length, filtersApplied: parsed.data });
});

const findReport = db.prepare("SELECT * FROM settlement_reports WHERE id = ?");
const itemsOf = db.prepare("SELECT * FROM settlement_items WHERE report_id = ? ORDER BY occurred_at, id");

router.get("/:id", (req, res) => {
  const row = findReport.get(req.params.id);
  if (!row) return sendError(res, 404, "SETTLEMENT_NOT_FOUND", "No settlement report has that ID");
  const now = new Date();
  return sendSuccess(res, { ...recon.reportResponse(row), items: itemsOf.all(row.id).map((it) => recon.itemResponse(it, now)) });
});

router.get("/:id/items.csv", (req, res) => {
  const row = findReport.get(req.params.id);
  if (!row) return sendError(res, 404, "SETTLEMENT_NOT_FOUND", "No settlement report has that ID");
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="${row.id}-${row.kind}-${row.asset}-${row.period_start.slice(0, 10)}.csv"`);
  return res.send(recon.itemsCsv(itemsOf.all(row.id)));
});

// Runs a reconciliation by hand (the same as `npm run reconcile`).
router.post("/run", async (req, res, next) => {
  const parsed = runSchema.safeParse(req.body || {});
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid run", parsed.error.flatten());
  const { kind } = parsed.data;
  const date = parsed.data.date || (kind === "daily" ? recon.yesterday() : recon.lastWeekMonday());
  let stellar;
  try {
    stellar = loadStellarConfig();
  } catch (error) {
    return sendError(res, 503, "STELLAR_NOT_CONFIGURED", "Stellar sandbox settings are needed to reconcile");
  }
  try {
    const run = kind === "daily" ? recon.runDaily : recon.runWeekly;
    const ids = await run({ date, stellar, runSource: "dashboard", runBy: req.user.id });
    return sendSuccess(res, ids.map((id) => recon.reportResponse(findReport.get(id))), { kind, date });
  } catch (error) {
    if (error instanceof recon.ReconcileError) return sendError(res, error.status, error.code, error.message);
    if (error instanceof HorizonError) return sendError(res, 502, "HORIZON_UNAVAILABLE", `Horizon could not be read: ${error.message}`);
    return next(error);
  }
});

module.exports = { router };
