const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const db = require("../src/db");

const schemaPath = path.resolve(__dirname, "../src/schema.sql");

// Older databases have finance tables that CREATE TABLE IF NOT EXISTS will not
// update: tables missing newer columns, or `payments` still allowing the
// 'scholarship' method. The seed replaces all data anyway, so rebuild the
// finance tables from schema.sql.
const requiredColumns = {
  invoices: ["final_amount", "currency", "scholarship_name"],
  payment_requests: ["invoice_amount", "amount_received", "ledger", "rate_source", "source_account", "note", "accepted_by"],
  webhook_endpoints: ["disabled_at"],
};
const isOutdated = (table, columns) => {
  const existing = db.prepare(`PRAGMA table_xinfo(${table})`).all().map((c) => c.name);
  return existing.length > 0 && !columns.every((c) => existing.includes(c));
};
const paymentsTable = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payments'").get();
const outdatedPayments = Boolean(paymentsTable && paymentsTable.sql.includes("'scholarship'"));
if (outdatedPayments || Object.entries(requiredColumns).some(([table, columns]) => isOutdated(table, columns))) {
  db.pragma("foreign_keys = OFF");
  db.exec(`
    DROP TABLE IF EXISTS settlement_items;
    DROP TABLE IF EXISTS settlement_reports;
    DROP TABLE IF EXISTS reconciliation_cursors;
    DROP TABLE IF EXISTS stellar_refunds;
    DROP TABLE IF EXISTS webhook_deliveries;
    DROP TABLE IF EXISTS webhook_events;
    DROP TABLE IF EXISTS webhook_endpoints;
    DROP TRIGGER IF EXISTS payment_requests_quote_locked;
    DROP TRIGGER IF EXISTS payment_requests_final_status;
    DROP TRIGGER IF EXISTS payment_requests_related_must_be_failed;
    DROP TABLE IF EXISTS payment_requests;
    DROP TABLE IF EXISTS refunds;
    DROP TABLE IF EXISTS payments;
    DROP TABLE IF EXISTS invoices;
  `);
  db.pragma("foreign_keys = ON");
}

// Scholarships now live on each invoice; drop the old separate table.
db.exec("DROP TABLE IF EXISTS scholarships;");

db.exec(fs.readFileSync(schemaPath, "utf8"));

// Older databases have a students table without school_id; add it in place.
if (!db.prepare("PRAGMA table_info(students)").all().some((c) => c.name === "school_id")) {
  db.exec("ALTER TABLE students ADD COLUMN school_id INTEGER REFERENCES schools(id)");
}
db.exec("CREATE INDEX IF NOT EXISTS idx_students_school ON students(school_id)");

const deleteOrder = [
  "settlement_items", "settlement_reports", "reconciliation_cursors",
  "webhook_deliveries", "webhook_events", "webhook_endpoints", "stellar_refunds", "api_keys", "payment_requests", "dashboard_preferences", "instructor_ratings", "refunds", "payments",
  "invoices", "activity_logs", "attendance_logs", "quiz_responses", "quiz_questions",
  "submissions", "assignments", "enrollments", "sections", "courses", "terms",
  "students", "schools", "instructors", "programs", "specializations", "users",
];
db.pragma("foreign_keys = OFF");
for (const table of deleteOrder) {
  db.prepare(`DELETE FROM ${table}`).run();
}
db.prepare("DELETE FROM sqlite_sequence").run();

const seed = db.transaction(() => {
  const passwordHash = bcrypt.hashSync("Demo123!", 10);

  const specializationNames = [
    ["Computer Science", "CS"],
    ["Business Administration", "BA"],
    ["Engineering", "ENG"],
    ["Health Sciences", "HS"],
    ["Education", "EDU"],
    ["Arts and Humanities", "AH"],
  ];
  const addSpecialization = db.prepare("INSERT INTO specializations (name, code) VALUES (?, ?)");
  specializationNames.forEach((spec) => addSpecialization.run(spec[0], spec[1]));

  const specs = db.prepare("SELECT * FROM specializations").all();
  const addProgram = db.prepare(
    "INSERT INTO programs (specialization_id, name, code) VALUES (?, ?, ?)"
  );
  for (const spec of specs) {
    addProgram.run(spec.id, `${spec.name} Degree`, `${spec.code}-DEG`);
  }
  const programRows = db.prepare("SELECT * FROM programs").all();

  const terms = [
    ["Fall 2023", "2023-1", "2023-08-15", "2023-12-15", 0],
    ["Spring 2024", "2024-1", "2024-01-15", "2024-05-15", 0],
    ["Fall 2024", "2024-2", "2024-08-15", "2024-12-15", 0],
    ["Spring 2025", "2025-1", "2025-01-15", "2025-05-15", 1],
  ];
  const addTerm = db.prepare(
    "INSERT INTO terms (name, code, start_date, end_date, is_current) VALUES (?, ?, ?, ?, ?)"
  );
  terms.forEach((term) => addTerm.run(...term));

  const addUser = db.prepare(
    "INSERT INTO users (email, password_hash, role, name) VALUES (?, ?, ?, ?)"
  );
  // One placeholder school for the demo. TODO: group decision (real school name and code).
  const demoSchoolId = db.prepare("INSERT INTO schools (name, code) VALUES (?, ?)")
    .run("Demo School (placeholder)", "DEMO").lastInsertRowid;
  const addStudentRow = db.prepare(
    "INSERT INTO students (id, user_id, program_id, year_level, student_number, school_id) VALUES (?, ?, ?, ?, ?, ?)"
  );
  const addStudent = { run: (...values) => addStudentRow.run(...values, demoSchoolId) };
  const addInstructor = db.prepare(
    "INSERT INTO instructors (id, user_id, department) VALUES (?, ?, ?)"
  );

  const demoAdmin = addUser.run("admin@pluglytics.local", passwordHash, "admin", "Alex Admin").lastInsertRowid;
  const demoInstructorUser = addUser.run(
    "instructor@pluglytics.local",
    passwordHash,
    "instructor",
    "Ivy Instructor"
  ).lastInsertRowid;
  addInstructor.run(demoInstructorUser, demoInstructorUser, "Computer Science");

  const demoStudentUser = addUser.run(
    "student@pluglytics.local",
    passwordHash,
    "student",
    "Sam Student"
  ).lastInsertRowid;
  addStudent.run(demoStudentUser, demoStudentUser, programRows[0].id, 2, "STU-0001");

  // Demo accounts plus 500 realistic fake students.
  for (let i = 2; i <= 500; i++) {
    const programId = programRows[(i - 2) % programRows.length].id;
    const userId = addUser.run(
      `student${i}@pluglytics.local`,
      passwordHash,
      "student",
      `Student ${i}`
    ).lastInsertRowid;
    addStudent.run(userId, userId, programId, ((i - 2) % 4) + 1, `STU-${String(i).padStart(4, "0")}`);
  }

  for (let i = 1; i <= 24; i++) {
    const department = specializationNames[(i - 1) % specializationNames.length][0];
    const userId = addUser.run(
      `instructor${i}@pluglytics.local`,
      passwordHash,
      "instructor",
      `Instructor ${i}`
    ).lastInsertRowid;
    addInstructor.run(userId, userId, department);
  }

  const addCourse = db.prepare(
    "INSERT INTO courses (program_id, code, title, credits) VALUES (?, ?, ?, ?)"
  );
  for (let i = 1; i <= 60; i++) {
    const programId = programRows[(i - 1) % programRows.length].id;
    addCourse.run(programId, `COURSE-${String(i).padStart(3, "0")}`, `Analytics Course ${i}`, 3);
  }

  const termRows = db.prepare("SELECT * FROM terms").all();
  const courseRows = db.prepare("SELECT * FROM courses").all();
  const instructorRows = db.prepare("SELECT * FROM instructors").all();
  const addSection = db.prepare(
    "INSERT INTO sections (course_id, term_id, instructor_id, name, capacity) VALUES (?, ?, ?, ?, ?)"
  );
  let sectionId = 1;
  for (const term of termRows) {
    for (let i = 0; i < courseRows.length; i++) {
      const course = courseRows[i];
      const instructor = instructorRows[(i + termRows.indexOf(term)) % instructorRows.length];
      addSection.run(course.id, term.id, instructor.id, `Section ${String.fromCharCode(65 + (i % 3))}`, 40);
      sectionId++;
    }
  }

  const studentRows = db.prepare("SELECT * FROM students").all();
  const sectionRows = db.prepare("SELECT * FROM sections").all();
  const addEnrollment = db.prepare(
    "INSERT INTO enrollments (student_id, section_id, status, enrolled_at, final_grade) VALUES (?, ?, ?, ?, ?)"
  );

  for (const student of studentRows) {
    const start = (student.id % sectionRows.length);
    for (let i = 0; i < 5; i++) {
      const section = sectionRows[(start + i) % sectionRows.length];
      const term = termRows.find((row) => row.id === section.term_id);
      const statusRoll = (student.id + i) % 20;
      const status = statusRoll === 0 ? "dropped" : statusRoll === 19 ? "waitlisted" : term.is_current ? "active" : "completed";
      const grade = status === "completed" ? Math.round((65 + ((student.id * 7 + i * 11) % 35)) * 10) / 10 : null;
      addEnrollment.run(
        student.id,
        section.id,
        status,
        `${term.start_date}T08:00:00Z`,
        grade
      );
    }
  }

  const addAssignment = db.prepare(
    "INSERT INTO assignments (section_id, title, kind, max_score, due_at) VALUES (?, ?, ?, ?, ?)"
  );
  const addSubmission = db.prepare(
    "INSERT INTO submissions (assignment_id, student_id, score, submitted_at, status) VALUES (?, ?, ?, ?, ?)"
  );
  const addQuestion = db.prepare(
    "INSERT INTO quiz_questions (assignment_id, prompt, difficulty) VALUES (?, ?, ?)"
  );
  const addResponse = db.prepare(
    "INSERT INTO quiz_responses (question_id, student_id, is_correct, answered_at) VALUES (?, ?, ?, ?)"
  );
  const addAttendance = db.prepare(
    "INSERT INTO attendance_logs (student_id, section_id, attended_at, present) VALUES (?, ?, ?, ?)"
  );
  const addActivity = db.prepare(
    "INSERT INTO activity_logs (student_id, section_id, action, minutes, occurred_at) VALUES (?, ?, ?, ?, ?)"
  );

  for (const section of sectionRows.slice(0, 240)) {
    const term = termRows.find((row) => row.id === section.term_id);
    for (let j = 1; j <= 4; j++) {
      const kind = j === 4 ? "exam" : j === 1 ? "quiz" : "assignment";
      const assignmentId = addAssignment.run(
        section.id,
        `${kind[0].toUpperCase()}${kind.slice(1)} ${j}`,
        kind,
        kind === "exam" ? 100 : 50,
        `${term.end_date.slice(0, 8)}${String(5 + j).padStart(2, "0")}T23:59:00Z`
      ).lastInsertRowid;

      if (kind === "quiz") {
        for (let q = 1; q <= 3; q++) {
          const questionId = addQuestion.run(
            assignmentId,
            `Quiz ${j} question ${q}`,
            q === 3 ? "hard" : "medium"
          ).lastInsertRowid;
          const enrolled = db.prepare(
            "SELECT student_id FROM enrollments WHERE section_id = ? AND status != 'dropped' LIMIT 35"
          ).all(section.id);
          for (const row of enrolled) {
            const correct = (row.student_id + q + section.id) % 4 !== 0 ? 1 : 0;
            addResponse.run(questionId, row.student_id, correct, `${term.end_date.slice(0, 10)}T12:00:00Z`);
          }
        }
      }

      const enrolled = db.prepare(
        "SELECT student_id FROM enrollments WHERE section_id = ? AND status != 'dropped'"
      ).all(section.id);
      for (const row of enrolled) {
        const roll = (row.student_id + j + section.id) % 12;
        const submitted = roll !== 0;
        const score = submitted ? 20 + ((row.student_id * 5 + j * 7 + section.id) % 31) : null;
        addSubmission.run(
          assignmentId,
          row.student_id,
          score,
          submitted ? `${term.end_date.slice(0, 10)}T18:00:00Z` : null,
          submitted ? (roll === 1 ? "late" : "submitted") : "missing"
        );
        addAttendance.run(
          row.student_id,
          section.id,
          `${term.end_date.slice(0, 10)}T10:00:00Z`,
          roll !== 2 ? 1 : 0
        );
        addActivity.run(
          row.student_id,
          section.id,
          "lesson_view",
          15 + ((row.student_id + section.id + j) % 75),
          `${term.end_date.slice(0, 10)}T${String(8 + ((row.student_id + j) % 12)).padStart(2, "0")}:00:00Z`
        );
      }
    }
  }

  const addInvoice = db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, issued_at, due_at) VALUES (?, ?, ?, ?, ?)"
  );
  const addScholarshipInvoice = db.prepare(`
    INSERT INTO invoices (student_id, term_id, amount, scholarship_amount, scholarship_type, scholarship_name, issued_at, due_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const finalAmountOf = db.prepare("SELECT final_amount FROM invoices WHERE id = ?");
  const addPayment = db.prepare(
    "INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, ?, ?, ?)"
  );
  const addRefund = db.prepare(
    "INSERT INTO refunds (payment_id, amount, reason, refunded_at) VALUES (?, ?, ?, ?)"
  );
  // Scholarships are stored on the invoice. Each name maps to a scholarship type.
  const SCHOLARSHIP_NAME_TYPES = { "Academic Merit Scholarship": "merit" };
  const DEMO_SCHOLARSHIP = { name: "Academic Merit Scholarship", amount: 500 };

  for (const term of termRows) {
    for (const student of studentRows.slice(0, 500)) {
      const amount = 2500 + ((student.id * 137) % 1500);
      const issuedAt = `${term.start_date}T09:00:00Z`;
      const dueAt = `${term.start_date.slice(0, 8)}28T23:59:00Z`;
      // Students whose ID is divisible by 13 have a 500 merit scholarship each term.
      const invoiceId = student.id % 13 === 0
        ? addScholarshipInvoice.run(
          student.id, term.id, amount, DEMO_SCHOLARSHIP.amount,
          SCHOLARSHIP_NAME_TYPES[DEMO_SCHOLARSHIP.name], DEMO_SCHOLARSHIP.name, issuedAt, dueAt
        ).lastInsertRowid
        : addInvoice.run(student.id, term.id, amount, issuedAt, dueAt).lastInsertRowid;
      // Payments are based on the final amount (after any scholarship), so nobody is overpaid.
      const finalAmount = finalAmountOf.get(invoiceId).final_amount;

      if (student.id % 8 !== 0) {
        const paid = student.id % 10 === 0 ? finalAmount * 0.5 : finalAmount;
        const method = ["cash", "card", "bank"][student.id % 3];
        const paymentId = addPayment.run(
          invoiceId,
          paid,
          method,
          `${term.start_date.slice(0, 10)}T11:00:00Z`
        ).lastInsertRowid;
        if (student.id % 37 === 0) {
          addRefund.run(paymentId, 100, "Course withdrawal", `${term.end_date.slice(0, 10)}T10:00:00Z`);
        }
      }
    }
  }

  // One small unpaid invoice for the demo student in the current term, so the
  // dashboard shows "Pay with Stellar (Testnet)". At the sandbox rate
  // (1 USD = 2.5 XLM) it asks for 125 XLM. Added after the loop above so every
  // other invoice keeps the same ID.
  const demoStudent = db.prepare(
    "SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
  ).get();
  const currentTerm = termRows.find((term) => term.is_current);
  addInvoice.run(
    demoStudent.id,
    currentTerm.id,
    50,
    `${currentTerm.start_date}T09:00:00Z`,
    `${currentTerm.end_date}T23:59:00Z`
  );

  const addRating = db.prepare(
    "INSERT INTO instructor_ratings (instructor_id, section_id, rating, rated_at) VALUES (?, ?, ?, ?)"
  );
  for (const section of sectionRows) {
    for (let i = 0; i < 8; i++) {
      const rating = Math.round((30 + ((section.id * 3 + i * 5) % 20)) / 10 * 10) / 10;
      addRating.run(section.instructor_id, section.id, rating, "2025-03-01T12:00:00Z");
    }
  }

  const addDashboardPreference = db.prepare(
    "INSERT INTO dashboard_preferences (user_id, name, layout_json, is_default) VALUES (?, 'default', ?, 1)"
  );
  const defaultLayouts = [
    [demoStudentUser, ["student-grades", "student-deadlines", "student-attendance", "student-activity", "student-risk"]],
    [demoInstructorUser, ["instructor-sections", "section-performance", "assignment-rate", "instructor-attendance", "instructor-at-risk"]],
    [demoAdmin, ["enrollment-summary", "enrollment-specialization", "enrollment-year-level", "seat-utilization", "finance-overview", "finance-outstanding", "academic-quality"]],
  ];
  for (const [userId, widgetIds] of defaultLayouts) {
    const widgets = widgetIds.map((id) => ({ id, chartType: "bar" }));
    addDashboardPreference.run(userId, JSON.stringify({ widgets, filters: {}, theme: "light" }));
  }
});

seed();
db.pragma("foreign_keys = ON");

console.log("Seed complete:");
console.log("- 500+ students");
console.log("- 25 instructors");
console.log("- 60 courses");
console.log("- 6 specializations");
console.log("- 4 terms");
console.log("Demo logins:");
console.log("  student@pluglytics.local / Demo123!");
console.log("  instructor@pluglytics.local / Demo123!");
console.log("  admin@pluglytics.local / Demo123!");
