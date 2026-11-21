PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('student','instructor','admin')),
  name TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS specializations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS programs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  specialization_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  FOREIGN KEY (specialization_id) REFERENCES specializations(id)
);

CREATE TABLE IF NOT EXISTS students (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  program_id INTEGER NOT NULL,
  year_level INTEGER NOT NULL CHECK(year_level BETWEEN 1 AND 5),
  student_number TEXT NOT NULL UNIQUE,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (program_id) REFERENCES programs(id)
);

CREATE TABLE IF NOT EXISTS instructors (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL UNIQUE,
  department TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id INTEGER,
  code TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  credits INTEGER NOT NULL DEFAULT 3,
  FOREIGN KEY (program_id) REFERENCES programs(id)
);

CREATE TABLE IF NOT EXISTS sections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id INTEGER NOT NULL,
  term_id INTEGER NOT NULL,
  instructor_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 40,
  FOREIGN KEY (course_id) REFERENCES courses(id),
  FOREIGN KEY (term_id) REFERENCES terms(id),
  FOREIGN KEY (instructor_id) REFERENCES instructors(id)
);

CREATE TABLE IF NOT EXISTS enrollments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  section_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','completed','dropped','withdrawn','waitlisted')),
  enrolled_at TEXT NOT NULL,
  final_grade REAL,
  UNIQUE(student_id, section_id),
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  section_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('quiz','assignment','exam')),
  max_score REAL NOT NULL,
  due_at TEXT NOT NULL,
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  score REAL,
  submitted_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('submitted','late','missing')),
  UNIQUE(assignment_id, student_id),
  FOREIGN KEY (assignment_id) REFERENCES assignments(id),
  FOREIGN KEY (student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  difficulty TEXT NOT NULL DEFAULT 'medium',
  FOREIGN KEY (assignment_id) REFERENCES assignments(id)
);

CREATE TABLE IF NOT EXISTS quiz_responses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  student_id INTEGER NOT NULL,
  is_correct INTEGER NOT NULL CHECK(is_correct IN (0,1)),
  answered_at TEXT NOT NULL,
  UNIQUE(question_id, student_id),
  FOREIGN KEY (question_id) REFERENCES quiz_questions(id),
  FOREIGN KEY (student_id) REFERENCES students(id)
);

CREATE TABLE IF NOT EXISTS attendance_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  section_id INTEGER NOT NULL,
  attended_at TEXT NOT NULL,
  present INTEGER NOT NULL CHECK(present IN (0,1)),
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  section_id INTEGER,
  action TEXT NOT NULL,
  minutes INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

-- Pricing: `amount` is the base price. final_amount = amount - scholarship_amount
-- - (amount * discount_percent / 100) + platform_fee + transaction_fee.
-- instructor_cost is the school's cost and is NOT charged to the student.
-- Keep this formula in sync with computeFinalAmount() in src/pricing.js.
CREATE TABLE IF NOT EXISTS invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  term_id INTEGER NOT NULL,
  amount REAL NOT NULL CHECK(amount >= 0),
  scholarship_amount REAL NOT NULL DEFAULT 0 CHECK(scholarship_amount >= 0),
  scholarship_type TEXT CHECK(scholarship_type IN ('merit','need_based','sponsored','other')),
  discount_percent REAL NOT NULL DEFAULT 0 CHECK(discount_percent BETWEEN 0 AND 100),
  discount_code TEXT,
  platform_fee REAL NOT NULL DEFAULT 0 CHECK(platform_fee >= 0),
  transaction_fee REAL NOT NULL DEFAULT 0 CHECK(transaction_fee >= 0),
  instructor_cost REAL NOT NULL DEFAULT 0 CHECK(instructor_cost >= 0),
  final_amount REAL GENERATED ALWAYS AS (
    ROUND(amount - scholarship_amount - (amount * discount_percent / 100.0) + platform_fee + transaction_fee, 2)
  ) VIRTUAL CHECK(final_amount >= 0),
  issued_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  CHECK(scholarship_amount = 0 OR scholarship_type IS NOT NULL),
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (term_id) REFERENCES terms(id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('cash','card','bank','scholarship')),
  paid_at TEXT NOT NULL,
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);

CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  reason TEXT,
  refunded_at TEXT NOT NULL,
  FOREIGN KEY (payment_id) REFERENCES payments(id)
);

CREATE TABLE IF NOT EXISTS scholarships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id INTEGER NOT NULL,
  term_id INTEGER NOT NULL,
  amount REAL NOT NULL,
  name TEXT NOT NULL,
  FOREIGN KEY (student_id) REFERENCES students(id),
  FOREIGN KEY (term_id) REFERENCES terms(id)
);

CREATE TABLE IF NOT EXISTS instructor_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instructor_id INTEGER NOT NULL,
  section_id INTEGER,
  rating REAL NOT NULL CHECK(rating BETWEEN 1 AND 5),
  rated_at TEXT NOT NULL,
  FOREIGN KEY (instructor_id) REFERENCES instructors(id),
  FOREIGN KEY (section_id) REFERENCES sections(id)
);

CREATE TABLE IF NOT EXISTS dashboard_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT 'default',
  layout_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_enrollments_student ON enrollments(student_id);
CREATE INDEX IF NOT EXISTS idx_enrollments_section ON enrollments(section_id);
CREATE INDEX IF NOT EXISTS idx_sections_instructor ON sections(instructor_id);
CREATE INDEX IF NOT EXISTS idx_sections_term ON sections(term_id);
CREATE INDEX IF NOT EXISTS idx_submissions_student ON submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_activity_student_date ON activity_logs(student_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance_logs(student_id, attended_at);
CREATE INDEX IF NOT EXISTS idx_payments_invoice_date ON payments(invoice_id, paid_at);
CREATE INDEX IF NOT EXISTS idx_invoices_term ON invoices(term_id);

CREATE VIEW IF NOT EXISTS student_course_progress AS
SELECT e.student_id,
       c.id AS course_id,
       c.code AS course_code,
       t.id AS term_id,
       t.code AS term_code,
       COUNT(DISTINCT a.id) AS total_items,
       SUM(CASE WHEN s.status IN ('submitted','late') THEN 1 ELSE 0 END) AS submitted_items,
       ROUND(100.0 * SUM(CASE WHEN s.status IN ('submitted','late') THEN 1 ELSE 0 END) /
         NULLIF(COUNT(DISTINCT a.id), 0), 1) AS progress_percent,
       AVG(CASE WHEN s.score IS NOT NULL THEN s.score / a.max_score * 100 END) AS average_score
FROM enrollments e
JOIN sections sec ON sec.id = e.section_id
JOIN courses c ON c.id = sec.course_id
JOIN terms t ON t.id = sec.term_id
LEFT JOIN assignments a ON a.section_id = sec.id
LEFT JOIN submissions s ON s.assignment_id = a.id AND s.student_id = e.student_id
GROUP BY e.student_id, c.id, c.code, t.id, t.code;
