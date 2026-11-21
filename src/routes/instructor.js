const express = require("express");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { readQueryFilters } = require("../middleware/queryFilters");
const { sendSuccess, sendError } = require("../utils/envelope");
const { sendTableOrCsv } = require("../utils/export");

const router = express.Router();
router.use(authenticate, authorize("instructor"), readQueryFilters("instructor"));

function instructorId(userId) {
  return db.prepare("SELECT id FROM instructors WHERE user_id = ?").get(userId)?.id;
}

function sectionFilter(req, alias = "sec") {
  const parts = [];
  const params = { instructorId: req.instructorId };
  parts.push(`${alias}.instructor_id = @instructorId`);
  if (req.filters.term) {
    parts.push(`t.code = @term`);
    params.term = req.filters.term;
  }
  if (req.filters.course) {
    parts.push(`c.code = @course`);
    params.course = req.filters.course;
  }
  if (req.filters.section) {
    parts.push(`${alias}.name = @section`);
    params.section = req.filters.section;
  }
  return { sql: parts.join(" AND "), params };
}

router.use((req, res, next) => {
  req.instructorId = instructorId(req.user.id);
  if (!req.instructorId) return sendError(res, 404, "INSTRUCTOR_NOT_FOUND", "Instructor profile was not found");
  next();
});

router.get("/sections", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    SELECT sec.id, sec.name, c.code AS courseCode, c.title, t.name AS term,
           COUNT(DISTINCT e.student_id) AS activeStudents, sec.capacity,
           CASE WHEN COUNT(DISTINCT e.student_id) < 5 THEN 'unavailable'
                ELSE ROUND(COUNT(DISTINCT e.student_id) * 100.0 / sec.capacity, 1) END AS utilizationPercent
    FROM sections sec
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN enrollments e ON e.section_id = sec.id AND e.status IN ('active','completed')
    WHERE ${filter.sql}
    GROUP BY sec.id, sec.name, c.code, c.title, t.name, sec.capacity
    ORDER BY t.start_date DESC, c.code, sec.name
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/distribution", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, sec.name AS section,
           CASE WHEN sub.score / a.max_score * 100 >= 90 THEN 'A'
                WHEN sub.score / a.max_score * 100 >= 80 THEN 'B'
                WHEN sub.score / a.max_score * 100 >= 70 THEN 'C'
                WHEN sub.score / a.max_score * 100 >= 60 THEN 'D'
                ELSE 'F' END AS gradeBand,
           COUNT(*) AS students
    FROM submissions sub
    JOIN assignments a ON a.id = sub.assignment_id
    JOIN sections sec ON sec.id = a.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    WHERE sub.score IS NOT NULL AND ${filter.sql}
    GROUP BY c.code, sec.name, gradeBand
    HAVING COUNT(*) >= 5
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/assignments", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, sec.name AS section, a.id AS assignmentId,
           a.title, a.kind,
           ROUND(COUNT(sub.id) * 100.0 / NULLIF(COUNT(e.id), 0), 1) AS submissionRate,
           ROUND(AVG(sub.score / a.max_score * 100), 1) AS averageScore
    FROM assignments a
    JOIN sections sec ON sec.id = a.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN submissions sub ON sub.assignment_id = a.id
    LEFT JOIN enrollments e ON e.section_id = sec.id AND e.status != 'dropped'
    WHERE ${filter.sql}
    GROUP BY c.code, sec.name, a.id, a.title, a.kind
    HAVING COUNT(e.id) >= 5
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/item-analysis", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, sec.name AS section, qq.id AS questionId,
           qq.prompt, ROUND(AVG(qr.is_correct) * 100, 1) AS percentCorrect,
           ROUND((1 - AVG(qr.is_correct)) * 100, 1) AS percentIncorrect
    FROM quiz_questions qq
    JOIN assignments a ON a.id = qq.assignment_id
    JOIN sections sec ON sec.id = a.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN quiz_responses qr ON qr.question_id = qq.id
    WHERE ${filter.sql}
    GROUP BY c.code, sec.name, qq.id, qq.prompt
    HAVING COUNT(qr.id) >= 5
    ORDER BY percentIncorrect DESC
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/engagement", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    SELECT strftime('%w', al.occurred_at) AS weekdayIndex,
           strftime('%H', al.occurred_at) AS hour,
           SUM(al.minutes) AS minutes
    FROM activity_logs al
    JOIN sections sec ON sec.id = al.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    WHERE ${filter.sql}
    GROUP BY weekdayIndex, hour
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/at-risk", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    SELECT u.id AS studentId,
           COUNT(CASE WHEN sub.status = 'missing' THEN 1 END) AS missedSubmissions,
           ROUND(AVG(att.present) * 100, 1) AS attendancePercent
    FROM sections sec
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    JOIN enrollments e ON e.section_id = sec.id
    JOIN students st ON st.id = e.student_id
    JOIN users u ON u.id = st.user_id
    LEFT JOIN submissions sub ON sub.student_id = st.id
    LEFT JOIN attendance_logs att ON att.student_id = st.id AND att.section_id = sec.id
    WHERE ${filter.sql} AND e.status != 'dropped'
    GROUP BY u.id
    HAVING COUNT(DISTINCT st.id) >= 1
  `).all(filter.params).map((row, index) => {
    const reasons = [];
    if (row.missedSubmissions >= 2) reasons.push(`${row.missedSubmissions} missed submissions`);
    if (row.attendancePercent !== null && row.attendancePercent < 75) reasons.push(`Attendance is ${row.attendancePercent}%`);
    return {
      studentLabel: `Student ${index + 1}`,
      missedSubmissions: row.missedSubmissions,
      attendancePercent: row.attendancePercent,
      atRisk: reasons.length > 0,
      reasons,
    };
  }).filter((row) => row.atRisk);

  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/compare", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    SELECT t.name AS term, sec.name AS section,
           ROUND(AVG(CASE WHEN sub.score IS NOT NULL THEN sub.score / a.max_score * 100 END), 1) AS averageScore,
           ROUND(SUM(CASE WHEN sub.status IN ('submitted','late') THEN 1 ELSE 0 END) * 100.0 /
             NULLIF(COUNT(sub.id), 0), 1) AS submissionRate
    FROM sections sec
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN assignments a ON a.section_id = sec.id
    LEFT JOIN submissions sub ON sub.assignment_id = a.id
    WHERE ${filter.sql}
    GROUP BY t.name, sec.name
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

module.exports = router;
