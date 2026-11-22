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
  if (req.filters.from) {
    parts.push("t.end_date >= date(@from)");
    params.from = req.filters.from;
  }
  if (req.filters.to) {
    parts.push("t.start_date <= date(@to)");
    params.to = req.filters.to;
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
           t.code AS termCode,
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

router.get("/sections/:sectionId/roster", (req, res) => {
  const sectionId = Number(req.params.sectionId);
  if (!Number.isSafeInteger(sectionId) || sectionId < 1) {
    return sendError(res, 400, "VALIDATION_ERROR", "Section ID must be a positive integer");
  }
  const filter = sectionFilter(req);
  const section = db.prepare(`
    SELECT sec.id, sec.name, c.code AS courseCode, c.title, t.name AS term
    FROM sections sec
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    WHERE sec.id = @sectionId AND ${filter.sql}
  `).get({ ...filter.params, sectionId });
  if (!section) return sendError(res, 404, "SECTION_NOT_FOUND", "Section was not found");

  const rows = db.prepare(`
    SELECT u.name AS studentName, e.status AS enrollmentStatus,
           COUNT(DISTINCT a.id) AS assessments,
           COUNT(DISTINCT CASE WHEN sub.status IN ('submitted','late') THEN a.id END) AS submitted,
           COUNT(DISTINCT CASE WHEN sub.status = 'late' THEN a.id END) AS late,
           COUNT(DISTINCT CASE WHEN sub.status = 'missing' THEN a.id END) AS missed,
           COUNT(DISTINCT CASE WHEN a.kind = 'assignment' THEN a.id END) AS assignmentCount,
           COUNT(DISTINCT CASE WHEN a.kind = 'quiz' AND sub.status IN ('submitted','late') THEN a.id END) AS quizzesSubmitted,
           COUNT(DISTINCT CASE WHEN a.kind = 'quiz' AND sub.status = 'missing' THEN a.id END) AS quizzesMissed,
           COUNT(DISTINCT CASE WHEN a.kind = 'assignment' AND sub.status IN ('submitted','late') THEN a.id END) AS assignmentsSubmitted,
           COUNT(DISTINCT CASE WHEN a.kind = 'assignment' AND sub.status = 'late' THEN a.id END) AS assignmentsLate,
           COUNT(DISTINCT CASE WHEN a.kind = 'assignment' AND sub.status = 'missing' THEN a.id END) AS assignmentsMissed,
           ROUND(AVG(CASE WHEN a.kind = 'quiz' AND sub.score IS NOT NULL
                          THEN sub.score * 100.0 / a.max_score END), 1) AS quizAverage,
           ROUND(AVG(CASE WHEN sub.score IS NOT NULL
                          THEN sub.score * 100.0 / a.max_score END), 1) AS currentGrade,
           COALESCE(att.sessions, 0) AS attendanceSessions,
           CASE WHEN att.sessions IS NULL THEN NULL
                ELSE ROUND(att.present * 100.0 / att.sessions, 1) END AS attendanceRate
    FROM enrollments e
    JOIN students st ON st.id = e.student_id
    JOIN users u ON u.id = st.user_id
    LEFT JOIN assignments a ON a.section_id = e.section_id
      AND (@fromDate = '' OR date(a.due_at) >= date(@fromDate))
      AND (@toDate = '' OR date(a.due_at) <= date(@toDate))
    LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.student_id = e.student_id
    LEFT JOIN (
      SELECT student_id, section_id, COUNT(*) AS sessions, SUM(present) AS present
      FROM attendance_logs
      WHERE (@fromDate = '' OR date(attended_at) >= date(@fromDate))
        AND (@toDate = '' OR date(attended_at) <= date(@toDate))
      GROUP BY student_id, section_id
    ) att ON att.student_id = e.student_id AND att.section_id = e.section_id
    WHERE e.section_id = @sectionId AND e.status IN ('active','completed')
    GROUP BY e.student_id, u.name, e.status, att.sessions, att.present
    ORDER BY u.name
  `).all({
    sectionId,
    fromDate: req.filters.from || "",
    toDate: req.filters.to || "",
  });

  return sendSuccess(res, { section, students: rows }, {
    filtersApplied: req.filters,
    total: rows.length,
  });
});

router.get("/attendance", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, c.title, sec.name AS section, t.name AS term,
           COUNT(DISTINCT e.student_id) AS students,
           COUNT(att.id) AS recordedAttendanceEntries,
           ROUND(AVG(att.present) * 100, 1) AS attendanceRate
    FROM sections sec
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    JOIN enrollments e ON e.section_id = sec.id AND e.status IN ('active','completed')
    LEFT JOIN attendance_logs att ON att.section_id = sec.id AND att.student_id = e.student_id
      AND (@fromDate = '' OR date(att.attended_at) >= date(@fromDate))
      AND (@toDate = '' OR date(att.attended_at) <= date(@toDate))
    WHERE ${filter.sql}
    GROUP BY sec.id, c.code, c.title, sec.name, t.name
    ORDER BY t.start_date DESC, c.code, sec.name
  `).all({ ...filter.params, fromDate: req.filters.from || "", toDate: req.filters.to || "" });
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
           a.title, a.kind, COUNT(DISTINCT e.student_id) AS enrolledStudents,
           COUNT(DISTINCT CASE WHEN sub.status IN ('submitted','late') THEN e.student_id END) AS submitted,
           COUNT(DISTINCT CASE WHEN sub.status = 'late' THEN e.student_id END) AS late,
           COUNT(DISTINCT CASE WHEN sub.status = 'missing' THEN e.student_id END) AS missing,
           ROUND(COUNT(DISTINCT CASE WHEN sub.status IN ('submitted','late') THEN e.student_id END) * 100.0 /
             NULLIF(COUNT(DISTINCT e.student_id), 0), 1) AS submissionRate,
           ROUND(AVG(sub.score / a.max_score * 100), 1) AS averageScore
    FROM assignments a
    JOIN sections sec ON sec.id = a.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN enrollments e ON e.section_id = sec.id AND e.status IN ('active','completed')
    LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.student_id = e.student_id
    WHERE ${filter.sql}
      AND (@fromDate = '' OR date(a.due_at) >= date(@fromDate))
      AND (@toDate = '' OR date(a.due_at) <= date(@toDate))
    GROUP BY c.code, sec.name, a.id, a.title, a.kind
  `).all({ ...filter.params, fromDate: req.filters.from || "", toDate: req.filters.to || "" });
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
      AND (@fromDate = '' OR date(al.occurred_at) >= date(@fromDate))
      AND (@toDate = '' OR date(al.occurred_at) <= date(@toDate))
    GROUP BY weekdayIndex, hour
  `).all({ ...filter.params, fromDate: req.filters.from || "", toDate: req.filters.to || "" });
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/at-risk", (req, res) => {
  const filter = sectionFilter(req);
  const rows = db.prepare(`
    WITH matching_sections AS (
      SELECT sec.id, c.code AS courseCode, sec.name AS section
      FROM sections sec
      JOIN courses c ON c.id = sec.course_id
      JOIN terms t ON t.id = sec.term_id
      WHERE ${filter.sql}
    ),
    work AS (
      SELECT e.student_id, sec.id AS sectionId,
             COUNT(DISTINCT CASE WHEN sub.status = 'missing' THEN a.id END) AS missedSubmissions,
             ROUND(AVG(CASE WHEN sub.score IS NOT NULL THEN sub.score * 100.0 / a.max_score END), 1) AS currentGrade
      FROM enrollments e
      JOIN matching_sections sec ON sec.id = e.section_id
      LEFT JOIN assignments a ON a.section_id = sec.id
      LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.student_id = e.student_id
      WHERE e.status IN ('active','completed')
      GROUP BY e.student_id, sec.id
    ),
    attendance AS (
      SELECT student_id, section_id, COUNT(*) AS sessions, SUM(present) AS present
      FROM attendance_logs
      GROUP BY student_id, section_id
    )
    SELECT u.name AS studentName, ms.courseCode, ms.section,
           COALESCE(w.missedSubmissions, 0) AS missedSubmissions,
           w.currentGrade,
           CASE WHEN att.sessions IS NULL THEN NULL
                ELSE ROUND(att.present * 100.0 / att.sessions, 1) END AS attendancePercent
    FROM work w
    JOIN students st ON st.id = w.student_id
    JOIN users u ON u.id = st.user_id
    JOIN matching_sections ms ON ms.id = w.sectionId
    LEFT JOIN attendance att ON att.student_id = w.student_id AND att.section_id = w.sectionId
    WHERE COALESCE(w.missedSubmissions, 0) >= 2
       OR (att.sessions > 0 AND att.present * 100.0 / att.sessions < 75)
    ORDER BY ms.courseCode, ms.section, u.name
  `).all(filter.params).map((row) => {
    const reasons = [];
    if (row.missedSubmissions >= 2) reasons.push(`${row.missedSubmissions} missed submissions`);
    if (row.attendancePercent !== null && row.attendancePercent < 75) reasons.push(`Attendance is ${row.attendancePercent}%`);
    return {
      studentName: row.studentName,
      courseCode: row.courseCode,
      section: row.section,
      missedSubmissions: row.missedSubmissions,
      attendancePercent: row.attendancePercent,
      currentGrade: row.currentGrade,
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
             NULLIF(COUNT(DISTINCT a.id) * COUNT(DISTINCT e.student_id), 0), 1) AS submissionRate
    FROM sections sec
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN enrollments e ON e.section_id = sec.id AND e.status IN ('active','completed')
    LEFT JOIN assignments a ON a.section_id = sec.id
    LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.student_id = e.student_id
    WHERE ${filter.sql}
    GROUP BY t.name, sec.name
  `).all(filter.params);
  return sendTableOrCsv(req, res, rows, { filtersApplied: req.filters, total: rows.length });
});

module.exports = router;
