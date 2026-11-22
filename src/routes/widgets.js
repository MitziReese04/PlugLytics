const express = require("express");
const { authenticate } = require("../middleware/auth");
const { sendSuccess } = require("../utils/envelope");

const router = express.Router();
router.use(authenticate);

const catalogs = {
  student: [
    { id: "student-progress", title: "Course progress", description: "Progress and average score per course", supportedFilters: ["term","course","section","granularity"], chartTypes: ["bar","doughnut"] },
    { id: "student-grades", title: "Grade trend", description: "Quiz, assignment, and exam averages", supportedFilters: ["term","compare","granularity"], chartTypes: ["line","bar"] },
    { id: "student-deadlines", title: "Upcoming deadlines", description: "Upcoming and overdue items", supportedFilters: ["term","course","status"], chartTypes: ["table","timeline"] },
    { id: "student-standing", title: "Anonymous standing", description: "Anonymous percentile band", supportedFilters: ["term"], chartTypes: ["bar"] },
    { id: "student-risk", title: "At-risk indicator", description: "Plain-language risk reasons", supportedFilters: ["term"], chartTypes: ["card"] },
  ],
  instructor: [
    { id: "section-performance", title: "Section performance", description: "Grade and submission comparisons", supportedFilters: ["term","course","section","compare"], chartTypes: ["bar","line","table"] },
    { id: "assignment-rate", title: "Assignment submission", description: "Submission rate and average score", supportedFilters: ["term","course","section"], chartTypes: ["bar","table"] },
    { id: "item-analysis", title: "Item analysis", description: "Hardest quiz questions", supportedFilters: ["term","course","section"], chartTypes: ["bar","table"] },
    { id: "engagement", title: "Engagement heatmap", description: "Activity by weekday and hour", supportedFilters: ["term","course","section","granularity"], chartTypes: ["heatmap","table"] },
  ],
  admin: [
    { id: "enrollment-summary", title: "Enrollment", description: "Enrollment, retention, and seat utilization", supportedFilters: ["term","specialization","program","yearLevel","status","granularity"], chartTypes: ["bar","line","table"] },
    { id: "finance-overview", title: "Finance overview", description: "Gross and net billed, scholarships and discounts, collected, and collection rate", supportedFilters: ["term","specialization","program","granularity","compare"], chartTypes: ["bar","line","table"] },
    { id: "academic-quality", title: "Academic quality", description: "GPA, pass rates, and ratings", supportedFilters: ["term","specialization","program","course","granularity"], chartTypes: ["bar","table"] },
  ],
};

router.get("/", (req, res) => {
  return sendSuccess(res, catalogs[req.user.role] || []);
});

module.exports = router;
