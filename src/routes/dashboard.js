const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");

const router = express.Router();
router.use(authenticate);

router.get("/filter-options", (req, res) => {
  let terms;
  let dates;

  if (req.user.role === "student") {
    const student = db.prepare("SELECT id FROM students WHERE user_id = ?").get(req.user.id);
    if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");
    terms = db.prepare(`
      SELECT DISTINCT t.code, t.name, t.start_date AS startDate, t.end_date AS endDate
      FROM terms t
      JOIN sections sec ON sec.term_id = t.id
      JOIN enrollments e ON e.section_id = sec.id
      WHERE e.student_id = ?
      ORDER BY t.start_date DESC
    `).all(student.id);
    dates = db.prepare(`
      SELECT date(value) AS date FROM (
        SELECT a.due_at AS value
        FROM assignments a
        JOIN sections sec ON sec.id = a.section_id
        JOIN enrollments e ON e.section_id = sec.id
        WHERE e.student_id = ?
        UNION ALL
        SELECT s.submitted_at
        FROM submissions s WHERE s.student_id = ?
        UNION ALL
        SELECT attended_at FROM attendance_logs WHERE student_id = ?
        UNION ALL
        SELECT occurred_at FROM activity_logs WHERE student_id = ?
      ) WHERE value IS NOT NULL
      GROUP BY date(value)
      ORDER BY date
    `).all(student.id, student.id, student.id, student.id).map((row) => row.date);
  } else if (req.user.role === "instructor") {
    const instructor = db.prepare("SELECT id FROM instructors WHERE user_id = ?").get(req.user.id);
    if (!instructor) return sendError(res, 404, "INSTRUCTOR_NOT_FOUND", "Instructor profile was not found");
    terms = db.prepare(`
      SELECT DISTINCT t.code, t.name, t.start_date AS startDate, t.end_date AS endDate
      FROM terms t JOIN sections sec ON sec.term_id = t.id
      WHERE sec.instructor_id = ?
      ORDER BY t.start_date DESC
    `).all(instructor.id);
    dates = db.prepare(`
      SELECT date(value) AS date FROM (
        SELECT a.due_at AS value FROM assignments a
        JOIN sections sec ON sec.id = a.section_id WHERE sec.instructor_id = ?
        UNION ALL
        SELECT s.submitted_at FROM submissions s
        JOIN assignments a ON a.id = s.assignment_id
        JOIN sections sec ON sec.id = a.section_id WHERE sec.instructor_id = ?
        UNION ALL
        SELECT al.attended_at FROM attendance_logs al
        JOIN sections sec ON sec.id = al.section_id WHERE sec.instructor_id = ?
        UNION ALL
        SELECT al.occurred_at FROM activity_logs al
        JOIN sections sec ON sec.id = al.section_id WHERE sec.instructor_id = ?
      ) WHERE value IS NOT NULL
      GROUP BY date(value)
      ORDER BY date
    `).all(instructor.id, instructor.id, instructor.id, instructor.id).map((row) => row.date);
  } else {
    terms = db.prepare(`
      SELECT code, name, start_date AS startDate, end_date AS endDate
      FROM terms ORDER BY start_date DESC
    `).all();
    dates = db.prepare(`
      SELECT date(value) AS date FROM (
        SELECT due_at AS value FROM assignments
        UNION ALL SELECT submitted_at FROM submissions
        UNION ALL SELECT attended_at FROM attendance_logs
        UNION ALL SELECT occurred_at FROM activity_logs
        UNION ALL SELECT issued_at FROM invoices
        UNION ALL SELECT paid_at FROM payments
        UNION ALL SELECT refunded_at FROM refunds
      ) WHERE value IS NOT NULL
      GROUP BY date(value)
      ORDER BY date
    `).all().map((row) => row.date);
  }

  return sendSuccess(res, {
    terms,
    dates,
    dateRange: {
      from: dates[0] || null,
      to: dates[dates.length - 1] || null,
    },
  });
});

const layoutSchema = z.object({
  widgets: z.array(z.object({
    id: z.string().min(1),
    chartType: z.string().min(1).optional(),
  })).default([]),
  filters: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  theme: z.enum(["light", "dark"]).default("light"),
});

router.get("/dashboard", (req, res) => {
  const row = db.prepare(
    "SELECT layout_json FROM dashboard_preferences WHERE user_id = ? AND is_default = 1"
  ).get(req.user.id);
  const layout = row ? JSON.parse(row.layout_json) : { widgets: [], filters: {}, theme: "light" };
  return sendSuccess(res, layout);
});

router.put("/dashboard", (req, res) => {
  const parsed = layoutSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid dashboard layout", parsed.error.flatten());
  db.prepare(`
    INSERT INTO dashboard_preferences (user_id, name, layout_json, is_default)
    VALUES (?, 'default', ?, 1)
    ON CONFLICT(user_id, name) DO UPDATE SET layout_json = excluded.layout_json, updated_at = CURRENT_TIMESTAMP
  `).run(req.user.id, JSON.stringify(parsed.data));
  return sendSuccess(res, parsed.data);
});

router.post("/dashboard/presets", (req, res) => {
  const parsed = z.object({
    name: z.string().trim().min(1).max(50),
    layout: layoutSchema,
  }).safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid preset", parsed.error.flatten());
  try {
    db.prepare(`
      INSERT INTO dashboard_preferences (user_id, name, layout_json, is_default)
      VALUES (?, ?, ?, 0)
    `).run(req.user.id, parsed.data.name, JSON.stringify(parsed.data.layout));
  } catch (error) {
    return sendError(res, 409, "PRESET_EXISTS", "A preset with this name already exists");
  }
  return sendSuccess(res, parsed.data, {}, 201);
});

router.get("/dashboard/render", async (req, res) => {
  const row = db.prepare(
    "SELECT layout_json FROM dashboard_preferences WHERE user_id = ? AND is_default = 1"
  ).get(req.user.id);
  const layout = row ? JSON.parse(row.layout_json) : { widgets: [], filters: {} };
  return sendSuccess(res, {
    layout,
    widgets: layout.widgets.map((widget) => ({ id: widget.id, chartType: widget.chartType || "bar", data: [] })),
  });
});

module.exports = router;
