const express = require("express");
const { authenticate } = require("../middleware/auth");
const { sendSuccess } = require("../utils/envelope");

const router = express.Router();
router.use(authenticate);

const catalogs = {
  student: [
    { id: "student-progress", title: "Course progress", description: "Activity completion and average score by course", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["bar", "doughnut"], default: true },
    { id: "student-grades", title: "Grade trend", description: "Quiz, assignment, and exam averages by term", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["line", "bar"], default: true },
    { id: "student-deadlines", title: "Upcoming deadlines", description: "Upcoming, overdue, late, and submitted work", supportedFilters: ["term", "from", "to", "course", "section", "status"], chartTypes: ["table", "timeline"], default: true },
    { id: "student-attendance", title: "Attendance", description: "Attendance rate and sessions recorded by course", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["bar", "table"], default: true },
    { id: "student-activity", title: "Learning activity", description: "Time spent learning and recent platform activity", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["bar", "table"], default: true },
    { id: "student-risk", title: "Progress check-in", description: "Personal missed-work and attendance signals", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["card"], default: true },
  ],
  instructor: [
    { id: "instructor-sections", title: "My classes and student progress", description: "Open a class folder for attendance, grades, quizzes, submissions, and missed work", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["folders"], default: true },
    { id: "section-performance", title: "Section performance", description: "Compare average grades and submission rates across sections", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["bar", "line", "table"], default: true },
    { id: "assignment-rate", title: "Assignment and quiz submissions", description: "Submitted, late, and missing work by assessment", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["bar", "table"], default: true },
    { id: "instructor-attendance", title: "Attendance by class", description: "Attendance rates for sections you teach", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["bar", "table"], default: true },
    { id: "instructor-at-risk", title: "Students needing follow-up", description: "Section-scoped students with missed work or low attendance", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["table"], default: true },
    { id: "item-analysis", title: "Quiz question analysis", description: "Question difficulty and incorrect-response rates", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["bar", "table"] },
    { id: "engagement", title: "Learning engagement", description: "Activity by weekday and hour in your sections", supportedFilters: ["term", "from", "to", "course", "section"], chartTypes: ["heatmap", "table"] },
  ],
  admin: [
    { id: "enrollment-summary", title: "Enrollment snapshot", description: "Unique enrolled students and waitlisted enrollments", supportedFilters: ["term", "from", "to", "specialization", "program", "course", "section", "yearLevel", "status"], chartTypes: ["metrics"], default: true },
    { id: "enrollment-specialization", title: "Enrollment by specialization", description: "Student counts across academic specializations", supportedFilters: ["term", "from", "to", "specialization", "program", "course", "section", "yearLevel", "status"], chartTypes: ["bar", "table"], default: true },
    { id: "enrollment-year-level", title: "Enrollment by year level", description: "Enrolled students by year of study", supportedFilters: ["term", "from", "to", "specialization", "program", "course", "section", "yearLevel", "status"], chartTypes: ["bar", "table"], default: true },
    { id: "enrollment-retention", title: "Retention and withdrawal", description: "Active, withdrawn, and dropped enrollment rates", supportedFilters: ["term", "from", "to", "specialization", "program", "course", "section", "status"], chartTypes: ["bar", "table"] },
    { id: "seat-utilization", title: "Seat utilization", description: "Section capacity, enrollment, and available seats", supportedFilters: ["term", "from", "to", "specialization", "program", "course", "section"], chartTypes: ["bar", "table"], default: true },
    { id: "finance-overview", title: "Tuition billed and collected", description: "Gross and net billed, scholarships and discounts, collected, and collection rate", supportedFilters: ["term", "from", "to", "specialization", "program"], chartTypes: ["metrics"], default: true },
    { id: "finance-outstanding", title: "Outstanding tuition", description: "Unpaid balances grouped by aging bucket", supportedFilters: ["term", "from", "to", "specialization", "program"], chartTypes: ["bar", "table"], default: true },
    { id: "income-specialization", title: "Payments by specialization", description: "Collected tuition by academic specialization", supportedFilters: ["term", "from", "to", "specialization", "program"], chartTypes: ["bar", "table"] },
    { id: "finance-refunds", title: "Refunds", description: "Refund totals for the selected term and programs", supportedFilters: ["term", "from", "to", "specialization", "program"], chartTypes: ["metrics"] },
    { id: "academic-quality", title: "Academic quality", description: "Average final grade by specialization", supportedFilters: ["term", "from", "to", "specialization", "program"], chartTypes: ["bar", "table"], default: true },
    { id: "pass-rates", title: "Course pass rates", description: "Share of final grades meeting the passing threshold", supportedFilters: ["term", "from", "to", "specialization", "program", "course", "section"], chartTypes: ["bar", "table"] },
    { id: "instructor-ratings", title: "Instructor ratings", description: "Average course ratings with privacy-aware source data", supportedFilters: ["term", "from", "to", "specialization", "program", "course", "section", "instructor"], chartTypes: ["bar", "table"] },
    { id: "course-popularity", title: "Course demand", description: "Unique student enrollments by course", supportedFilters: ["term", "from", "to", "specialization", "program", "course", "section"], chartTypes: ["bar", "table"] },
  ],
};

router.get("/", (req, res) => {
  return sendSuccess(res, catalogs[req.user.role] || []);
});

module.exports = router;
