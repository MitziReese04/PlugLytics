const express = require("express");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { readQueryFilters } = require("../middleware/queryFilters");
const { sendSuccess, sendError } = require("../utils/envelope");

const router = express.Router();
router.use(authenticate, authorize("student"), readQueryFilters("student"));

function getStudentId(userId) {
  const student = db.prepare(
    "SELECT id FROM students WHERE user_id = ?"
  ).get(userId);
  return student ? student.id : null;
}

function paged(rows, filters) {
  const offset = (filters.page - 1) * filters.limit;
  return {
    rows: rows.slice(offset, offset + filters.limit),
    page: filters.page,
    total: rows.length,
  };
}

function filterTermClause(filters, termAlias) {
  const where = [];
  const params = {};
  if (filters.term) {
    where.push(`${termAlias}.code = @term`);
    params.term = filters.term;
  }
  if (filters.from) {
    where.push(`${termAlias}.end_date >= date(@from)`);
    params.from = filters.from;
  }
  if (filters.to) {
    where.push(`${termAlias}.start_date <= date(@to)`);
    params.to = filters.to;
  }
  return { sql: where.length ? ` AND ${where.join(" AND ")}` : "", params };
}

router.get("/progress", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");

  const termFilter = filterTermClause(req.filters, "t");
  const rows = db.prepare(`
    SELECT c.id AS courseId, c.code AS courseCode, c.title,
           t.name AS term, t.code AS termCode,
           COUNT(DISTINCT a.id) AS totalItems,
           ROUND(SUM(CASE WHEN s.status IN ('submitted','late') THEN 1 ELSE 0 END) * 100.0 /
             NULLIF(COUNT(DISTINCT a.id), 0), 1) AS progressPercent,
           ROUND(AVG(CASE WHEN s.score IS NOT NULL THEN s.score / a.max_score * 100 END), 1) AS averageScore
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN assignments a ON a.section_id = sec.id
    LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = e.student_id
    WHERE e.student_id = @studentId
      ${termFilter.sql}
    GROUP BY c.id, c.code, c.title, t.id, t.name, t.code
    ORDER BY t.start_date DESC, c.code
  `).all({ studentId, ...termFilter.params });

  const page = paged(rows, req.filters);
  return sendSuccess(res, page.rows, {
    filtersApplied: req.filters,
    page: page.page,
    total: page.total,
  });
});

router.get("/grades", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");

  const termFilter = filterTermClause(req.filters, "t");
  const rows = db.prepare(`
    SELECT t.id AS termId, t.name AS term, t.code AS termCode,
           ROUND(AVG(CASE WHEN s.score IS NOT NULL AND a.kind = 'quiz' THEN s.score / a.max_score * 100 END), 1) AS quizAverage,
           ROUND(AVG(CASE WHEN s.score IS NOT NULL AND a.kind = 'assignment' THEN s.score / a.max_score * 100 END), 1) AS assignmentAverage,
           ROUND(AVG(CASE WHEN s.score IS NOT NULL AND a.kind = 'exam' THEN s.score / a.max_score * 100 END), 1) AS examAverage
    FROM submissions s
    JOIN assignments a ON a.id = s.assignment_id
    JOIN sections sec ON sec.id = a.section_id
    JOIN terms t ON t.id = sec.term_id
    WHERE s.student_id = @studentId
      ${termFilter.sql.replaceAll("t.", "t.")}
    GROUP BY t.id, t.name, t.code
    ORDER BY t.start_date
  `).all({ studentId, ...termFilter.params });

  const withGpa = rows.map((row) => {
    const available = [row.quizAverage, row.assignmentAverage, row.examAverage].filter(Number.isFinite);
    const percent = available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null;
    let gpa = null;
    if (percent !== null) gpa = percent >= 93 ? 4.0 : percent >= 90 ? 3.7 : percent >= 87 ? 3.3 :
      percent >= 83 ? 3.0 : percent >= 80 ? 2.7 : percent >= 77 ? 2.3 :
      percent >= 70 ? 2.0 : percent >= 60 ? 1.0 : 0.0;
    return { ...row, gpa };
  });

  const page = paged(withGpa, req.filters);
  return sendSuccess(res, page.rows, {
    filtersApplied: req.filters,
    page: page.page,
    total: page.total,
  });
});

router.get("/deadlines", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");

  const termFilter = filterTermClause(req.filters, "t");
  const rows = db.prepare(`
    SELECT c.code AS courseCode, c.title, a.id AS assignmentId, a.title AS assignment,
           a.kind, a.due_at AS dueAt,
           CASE WHEN s.submitted_at IS NULL AND a.due_at < datetime('now') THEN 'overdue'
                WHEN s.submitted_at IS NULL THEN 'upcoming'
                ELSE 'submitted' END AS status
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    JOIN assignments a ON a.section_id = sec.id
    LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = e.student_id
    WHERE e.student_id = @studentId
      ${termFilter.sql}
      AND (@fromDate = '' OR date(a.due_at) >= date(@fromDate))
      AND (@toDate = '' OR date(a.due_at) <= date(@toDate))
      AND (@status = '' OR CASE WHEN s.submitted_at IS NULL AND a.due_at < datetime('now') THEN 'overdue'
                                WHEN s.submitted_at IS NULL THEN 'upcoming'
                                ELSE 'submitted' END = @status)
    ORDER BY a.due_at
  `).all({
    studentId,
    status: req.filters.status || "",
    fromDate: req.filters.from || "",
    toDate: req.filters.to || "",
    ...termFilter.params,
  }).map((row) => ({
    ...row,
    dueAt: row.dueAt,
  }));

  const page = paged(rows, req.filters);
  return sendSuccess(res, page.rows, {
    filtersApplied: req.filters,
    page: page.page,
    total: page.total,
  });
});

router.get("/standing", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");

  const termFilter = filterTermClause(req.filters, "t");
  const cohort = db.prepare(`
    SELECT e.student_id,
           AVG(CASE WHEN s.score IS NOT NULL THEN s.score / a.max_score * 100 END) AS average
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN assignments a ON a.section_id = sec.id
    LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = e.student_id
    WHERE 1 = 1 ${termFilter.sql}
    GROUP BY e.student_id
  `).all(termFilter.params);

  if (cohort.length < 5) {
    return sendSuccess(res, { percentileBand: "unavailable", reason: "Minimum cohort size of 5 was not met" });
  }

  const own = cohort.find((row) => row.student_id === studentId);
  if (!own || own.average === null) {
    return sendSuccess(res, { percentileBand: "unavailable", reason: "No grades are available yet" });
  }

  const below = cohort.filter((row) => row.average !== null && row.average < own.average).length;
  const percentile = Math.round((below / cohort.length) * 100);
  const percentileBand = percentile >= 80 ? "Top 20%" : percentile >= 60 ? "61st-80th percentile"
    : percentile >= 40 ? "41st-60th percentile" : percentile >= 20 ? "21st-40th percentile"
    : "Bottom 20%";

  return sendSuccess(res, { percentileBand, cohortSize: cohort.length });
});

router.get("/risk", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");

  const missed = db.prepare(`
    SELECT COUNT(*) AS count
    FROM submissions sub
    WHERE sub.student_id = @studentId AND sub.status = 'missing'
  `).get({ studentId }).count;

  const attendance = db.prepare(`
    SELECT ROUND(AVG(present) * 100, 1) AS percent
    FROM attendance_logs
    WHERE student_id = @studentId
  `).get({ studentId }).percent;

  const reasons = [];
  if (missed >= 2) reasons.push(`${missed} missed submissions`);
  if (attendance !== null && attendance < 75) reasons.push(`Attendance is ${attendance}%`);

  return sendSuccess(res, {
    atRisk: reasons.length > 0,
    reasons,
  });
});

module.exports = router;
