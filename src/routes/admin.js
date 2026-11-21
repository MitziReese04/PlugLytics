const express = require("express");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { readQueryFilters } = require("../middleware/queryFilters");
const { sendSuccess } = require("../utils/envelope");
const { sendTableOrCsv } = require("../utils/export");

const router = express.Router();
router.use(authenticate, authorize("admin"), readQueryFilters("admin"));

const financeCache = new Map();
function cachedFinance(key, build) {
  const now = Date.now();
  const cached = financeCache.get(key);
  if (cached && now - cached.time < 60_000) return cached.value;
  const value = build();
  financeCache.set(key, { time: now, value });
  return value;
}

function termParams(req) {
  const params = {};
  let sql = "";
  if (req.filters.term) {
    sql += " AND t.code = @term";
    params.term = req.filters.term;
  }
  if (req.filters.specialization) {
    sql += " AND sp.code = @specialization";
    params.specialization = req.filters.specialization;
  }
  if (req.filters.program) {
    sql += " AND p.code = @program";
    params.program = req.filters.program;
  }
  if (req.filters.from) {
    sql += " AND t.end_date >= date(@from)";
    params.from = req.filters.from;
  }
  if (req.filters.to) {
    sql += " AND t.start_date <= date(@to)";
    params.to = req.filters.to;
  }
  return { sql, params };
}

const enrollment = express.Router();
enrollment.get("/summary", (req, res) => {
  const filter = termParams(req);
  const row = db.prepare(`
    SELECT COUNT(DISTINCT e.student_id) AS enrolledStudents,
           SUM(CASE WHEN e.status = 'waitlisted' THEN 1 ELSE 0 END) AS waitlisted
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN terms t ON t.id = sec.term_id
    JOIN students st ON st.id = e.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
  `).get(filter.params);
  return sendTableOrCsv(req, res, [row], { filtersApplied: req.filters, total: 1 });
});

enrollment.get("/by-specialization", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT sp.name AS specialization, COUNT(DISTINCT e.student_id) AS enrolledStudents
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN terms t ON t.id = sec.term_id
    JOIN students st ON st.id = e.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
    GROUP BY sp.id, sp.name
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

enrollment.get("/year-level", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT st.year_level AS yearLevel, COUNT(DISTINCT e.student_id) AS enrolledStudents
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN terms t ON t.id = sec.term_id
    JOIN students st ON st.id = e.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
    GROUP BY st.year_level
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

enrollment.get("/retention", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT t.name AS term,
           ROUND(SUM(CASE WHEN e.status = 'active' THEN 1 ELSE 0 END) * 100.0 /
             NULLIF(COUNT(e.id), 0), 1) AS retentionPercent,
           ROUND(SUM(CASE WHEN e.status IN ('dropped','withdrawn') THEN 1 ELSE 0 END) * 100.0 /
             NULLIF(COUNT(e.id), 0), 1) AS dropoutPercent
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN terms t ON t.id = sec.term_id
    JOIN students st ON st.id = e.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
    GROUP BY t.id, t.name
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

enrollment.get("/seat-utilization", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, c.title, sec.name AS section,
           sec.capacity,
           COUNT(DISTINCT e.student_id) AS enrolled,
           ROUND(COUNT(DISTINCT e.student_id) * 100.0 / sec.capacity, 1) AS utilizationPercent
    FROM sections sec
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    JOIN students st ON st.id IN (SELECT student_id FROM enrollments WHERE section_id = sec.id)
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    LEFT JOIN enrollments e ON e.section_id = sec.id AND e.status != 'dropped'
    WHERE 1=1 ${filter.sql}
    GROUP BY c.code, c.title, sec.id, sec.name, sec.capacity
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.use("/enrollment", enrollment);

const finance = express.Router();
finance.get("/overview", (req, res) => {
  const filter = termParams(req);
  const key = JSON.stringify(req.filters);
  const data = cachedFinance(key, () => db.prepare(`
    SELECT ROUND(SUM(i.amount), 2) AS billed,
           ROUND((SELECT COALESCE(SUM(p.amount), 0)
                  FROM payments p JOIN invoices pi ON pi.id = p.invoice_id
                  JOIN terms pt ON pt.id = pi.term_id
                  JOIN students ps ON ps.id = pi.student_id
                  JOIN programs pp ON pp.id = ps.program_id
                  JOIN specializations psp ON psp.id = pp.specialization_id
                  WHERE 1=1 ${filter.sql.replaceAll("t.", "pt.")}), 2) AS collected
    FROM invoices i
    JOIN terms t ON t.id = i.term_id
    JOIN students st ON st.id = i.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
  `).get(filter.params));
  data.collectionRate = data.billed ? Number(((data.collected / data.billed) * 100).toFixed(1)) : 0;
  return sendTableOrCsv(req, res, [data], { filtersApplied: req.filters, total: 1 });
});

finance.get("/income-by-specialization", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT sp.name AS specialization, ROUND(SUM(pay.amount), 2) AS income
    FROM payments pay
    JOIN invoices i ON i.id = pay.invoice_id
    JOIN terms t ON t.id = i.term_id
    JOIN students st ON st.id = i.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
    GROUP BY sp.id, sp.name
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

finance.get("/outstanding", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT CASE WHEN CAST(julianday('now') - julianday(i.due_at) AS INTEGER) <= 30 THEN '0-30'
                WHEN CAST(julianday('now') - julianday(i.due_at) AS INTEGER) <= 60 THEN '31-60'
                ELSE '60+' END AS agingBucket,
           ROUND(SUM(i.amount - COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0)), 2) AS outstanding
    FROM invoices i
    JOIN terms t ON t.id = i.term_id
    JOIN students st ON st.id = i.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
    GROUP BY agingBucket
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

finance.get("/refunds", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT ROUND(SUM(r.amount), 2) AS refunds
    FROM refunds r
    JOIN payments pay ON pay.id = r.payment_id
    JOIN invoices i ON i.id = pay.invoice_id
    JOIN terms t ON t.id = i.term_id
    JOIN students st ON st.id = i.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.use("/finance", finance);

const academics = express.Router();
academics.get("/gpa-by-specialization", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT sp.name AS specialization, ROUND(AVG(e.final_grade), 1) AS averageFinalGrade
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN terms t ON t.id = sec.term_id
    JOIN students st ON st.id = e.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE e.final_grade IS NOT NULL ${filter.sql}
    GROUP BY sp.id, sp.name
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

academics.get("/pass-rates", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, c.title,
           ROUND(SUM(CASE WHEN e.final_grade >= 60 THEN 1 ELSE 0 END) * 100.0 /
             NULLIF(COUNT(e.id), 0), 1) AS passRate
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    JOIN students st ON st.id = e.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE e.final_grade IS NOT NULL ${filter.sql}
    GROUP BY c.id, c.code, c.title
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

academics.get("/ratings", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT u.name AS instructor, ROUND(AVG(ir.rating), 2) AS averageRating
    FROM instructor_ratings ir
    JOIN instructors i ON i.id = ir.instructor_id
    JOIN users u ON u.id = i.user_id
    JOIN sections sec ON sec.id = ir.section_id
    JOIN terms t ON t.id = sec.term_id
    JOIN courses c ON c.id = sec.course_id
    JOIN students st ON st.id IN (SELECT student_id FROM enrollments WHERE section_id = sec.id)
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
    GROUP BY i.id, u.name
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.use("/academics", academics);

const operations = express.Router();
operations.get("/course-popularity", (req, res) => {
  const filter = termParams(req);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, c.title, COUNT(DISTINCT e.student_id) AS enrolledStudents
    FROM courses c
    JOIN sections sec ON sec.course_id = c.id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN enrollments e ON e.section_id = sec.id
    JOIN students st ON st.id = e.student_id
    JOIN programs p ON p.id = st.program_id
    JOIN specializations sp ON sp.id = p.specialization_id
    WHERE 1=1 ${filter.sql}
    GROUP BY c.id, c.code, c.title
    ORDER BY enrolledStudents DESC
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});
router.use("/operations", operations);

module.exports = router;
