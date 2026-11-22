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

function courseSectionClause(filters) {
  const where = [];
  const params = {};
  if (filters.course) {
    where.push("c.code = @course");
    params.course = filters.course;
  }
  if (filters.section) {
    where.push("sec.name = @section");
    params.section = filters.section;
  }
  return { sql: where.length ? ` AND ${where.join(" AND ")}` : "", params };
}

router.get("/progress", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");

  const termFilter = filterTermClause(req.filters, "t");
  const courseFilter = courseSectionClause(req.filters);
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
      ${courseFilter.sql}
    GROUP BY c.id, c.code, c.title, t.id, t.name, t.code
    ORDER BY t.start_date DESC, c.code
  `).all({ studentId, ...termFilter.params, ...courseFilter.params });

  const page = paged(rows, req.filters);
  return sendSuccess(res, page.rows, {
    filtersApplied: req.filters,
    page: page.page,
    total: page.total,
  });
});

router.get("/calendar", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");
  if (!req.filters.from || !req.filters.to) {
    return sendError(res, 400, "DATE_RANGE_REQUIRED", "Calendar requests require from and to dates");
  }

  const events = db.prepare(`
    SELECT a.id AS id, a.title AS title, a.kind AS kind, a.due_at AS start,
           c.code AS courseCode, c.title AS courseTitle, t.code AS termCode,
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
      AND e.status NOT IN ('dropped','withdrawn','waitlisted')
      AND date(a.due_at) BETWEEN date(@from) AND date(@to)
      AND (@term = '' OR t.code = @term)
      AND (@course = '' OR c.code = @course)
      AND (@section = '' OR sec.name = @section)
    ORDER BY a.due_at, a.id
  `).all({
    studentId,
    from: req.filters.from,
    to: req.filters.to,
    term: req.filters.term || "",
    course: req.filters.course || "",
    section: req.filters.section || "",
  }).map((event) => ({ ...event, type: "deadline" }));

  return sendSuccess(res, events, {
    filtersApplied: { from: req.filters.from, to: req.filters.to },
  });
});

router.get("/curriculum", (req, res) => {
  const student = db.prepare(`
    SELECT s.id, s.program_id AS programId, p.name AS programName, p.code AS programCode
    FROM students s
    JOIN programs p ON p.id = s.program_id
    WHERE s.user_id = ?
  `).get(req.user.id);
  if (!student) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");

  const courses = db.prepare(`
    SELECT c.id AS courseId, c.code AS code, c.title, c.credits AS units,
           CASE
             WHEN EXISTS (
               SELECT 1 FROM enrollments e
               JOIN sections sec ON sec.id = e.section_id
               WHERE e.student_id = @studentId AND sec.course_id = c.id AND e.status = 'completed'
             ) THEN 'completed'
             WHEN EXISTS (
               SELECT 1 FROM enrollments e
               JOIN sections sec ON sec.id = e.section_id
               WHERE e.student_id = @studentId AND sec.course_id = c.id AND e.status = 'active'
             ) THEN 'in_progress'
             ELSE 'remaining'
           END AS status
    FROM courses c
    WHERE c.program_id = @programId
    ORDER BY c.code
  `).all({ studentId: student.id, programId: student.programId });
  const totalUnits = courses.reduce((total, course) => total + course.units, 0);

  const completedUnits = courses.reduce(
    (total, course) => total + (course.status === "completed" ? course.units : 0),
    0
  );
  return sendSuccess(res, {
    programName: student.programName,
    programCode: student.programCode,
    source: "program_catalog",
    completedUnits,
    remainingUnits: Math.max(0, totalUnits - completedUnits),
    completionPercent: totalUnits ? Math.round((completedUnits / totalUnits) * 100) : 0,
    courses,
  });
});

router.get("/grades", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");

  const termFilter = filterTermClause(req.filters, "t");
  const courseFilter = courseSectionClause(req.filters);
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
      ${courseFilter.sql}
    GROUP BY t.id, t.name, t.code
    ORDER BY t.start_date
  `).all({ studentId, ...termFilter.params, ...courseFilter.params });

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
  const courseFilter = courseSectionClause(req.filters);
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
      ${courseFilter.sql}
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
    ...courseFilter.params,
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

router.get("/attendance", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");
  const termFilter = filterTermClause(req.filters, "t");
  const courseFilter = courseSectionClause(req.filters);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, c.title, sec.name AS section, t.name AS term,
           COUNT(att.id) AS sessionsRecorded,
           SUM(CASE WHEN att.present = 1 THEN 1 ELSE 0 END) AS sessionsAttended,
           ROUND(AVG(att.present) * 100, 1) AS attendancePercent
    FROM enrollments e
    JOIN sections sec ON sec.id = e.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    LEFT JOIN attendance_logs att ON att.student_id = e.student_id AND att.section_id = sec.id
      AND (@fromDate = '' OR date(att.attended_at) >= date(@fromDate))
      AND (@toDate = '' OR date(att.attended_at) <= date(@toDate))
    WHERE e.student_id = @studentId AND e.status NOT IN ('dropped','withdrawn','waitlisted')
      ${termFilter.sql}
      ${courseFilter.sql}
    GROUP BY c.code, c.title, sec.name, t.name, t.start_date
    ORDER BY t.start_date DESC, c.code
  `).all({
    studentId,
    fromDate: req.filters.from || "",
    toDate: req.filters.to || "",
    ...termFilter.params,
    ...courseFilter.params,
  });
  return sendSuccess(res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/activity-summary", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");
  const termFilter = filterTermClause(req.filters, "t");
  const courseFilter = courseSectionClause(req.filters);
  const rows = db.prepare(`
    SELECT c.code AS courseCode, c.title, sec.name AS section, t.name AS term,
           SUM(al.minutes) AS minutesLearning,
           COUNT(al.id) AS activityEvents,
           COUNT(DISTINCT date(al.occurred_at)) AS activeDays
    FROM activity_logs al
    JOIN sections sec ON sec.id = al.section_id
    JOIN courses c ON c.id = sec.course_id
    JOIN terms t ON t.id = sec.term_id
    WHERE al.student_id = @studentId
      ${termFilter.sql}
      ${courseFilter.sql}
      AND (@fromDate = '' OR date(al.occurred_at) >= date(@fromDate))
      AND (@toDate = '' OR date(al.occurred_at) <= date(@toDate))
    GROUP BY c.code, c.title, sec.name, t.name, t.start_date
    ORDER BY t.start_date DESC, c.code
  `).all({
    studentId,
    fromDate: req.filters.from || "",
    toDate: req.filters.to || "",
    ...termFilter.params,
    ...courseFilter.params,
  });
  return sendSuccess(res, rows, { filtersApplied: req.filters, total: rows.length });
});

router.get("/risk", (req, res) => {
  const studentId = getStudentId(req.user.id);
  if (!studentId) return sendError(res, 404, "STUDENT_NOT_FOUND", "Student profile was not found");
  const termFilter = filterTermClause(req.filters, "t");
  const courseFilter = courseSectionClause(req.filters);
  const metrics = db.prepare(`
    WITH matching_sections AS (
      SELECT DISTINCT sec.id
      FROM enrollments e
      JOIN sections sec ON sec.id = e.section_id
      JOIN courses c ON c.id = sec.course_id
      JOIN terms t ON t.id = sec.term_id
      WHERE e.student_id = @studentId ${termFilter.sql} ${courseFilter.sql}
    )
    SELECT
      (SELECT COUNT(*)
       FROM submissions sub
       JOIN assignments a ON a.id = sub.assignment_id
       JOIN matching_sections ms ON ms.id = a.section_id
       WHERE sub.student_id = @studentId AND sub.status = 'missing'
         AND (@fromDate = '' OR date(a.due_at) >= date(@fromDate))
         AND (@toDate = '' OR date(a.due_at) <= date(@toDate))) AS missed,
      (SELECT ROUND(AVG(att.present) * 100, 1)
       FROM attendance_logs att
       JOIN matching_sections ms ON ms.id = att.section_id
       WHERE att.student_id = @studentId
         AND (@fromDate = '' OR date(att.attended_at) >= date(@fromDate))
         AND (@toDate = '' OR date(att.attended_at) <= date(@toDate))) AS attendance
  `).get({
    studentId,
    fromDate: req.filters.from || "",
    toDate: req.filters.to || "",
    ...termFilter.params,
    ...courseFilter.params,
  });
  const missed = metrics.missed;
  const attendance = metrics.attendance;
  const reasons = [];
  if (missed >= 2) reasons.push(`${missed} missed submissions`);
  if (attendance !== null && attendance < 75) reasons.push(`Attendance is ${attendance}%`);

  return sendSuccess(res, {
    atRisk: reasons.length > 0,
    reasons,
    missedSubmissions: missed,
    attendancePercent: attendance,
  });
});

module.exports = router;
