// Checks the seeded demo data after scholarships moved onto invoices.
// Runs against the seeded database (npm run seed).
const db = require("../src/db");

const SCHOLARSHIP = { amount: 500, type: "merit", name: "Academic Merit Scholarship" };
const termCount = db.prepare("SELECT COUNT(*) n FROM terms").get().n;
// The seed's main loop gives every one of the first 500 students one invoice per term.
const seededStudentIds = db.prepare("SELECT id FROM students ORDER BY id LIMIT 500").all().map((r) => r.id);
const scholarshipStudentIds = seededStudentIds.filter((id) => id % 13 === 0);

describe("seeded scholarships", () => {
  test("the old scholarships table no longer exists", () => {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'scholarships'").get();
    expect(table).toBeUndefined();
  });

  test("38 students (ID divisible by 13) have the 500 merit scholarship on every invoice", () => {
    expect(scholarshipStudentIds).toHaveLength(38);
    const rows = db.prepare(`
      SELECT student_id, COUNT(*) AS invoices,
             SUM(scholarship_amount = ? AND scholarship_type = ? AND scholarship_name = ?) AS with_scholarship
      FROM invoices
      WHERE student_id IN (${scholarshipStudentIds.map(() => "?").join(",")})
      GROUP BY student_id
    `).all(SCHOLARSHIP.amount, SCHOLARSHIP.type, SCHOLARSHIP.name, ...scholarshipStudentIds);

    expect(rows).toHaveLength(38);
    for (const row of rows) {
      expect(row.invoices).toBe(termCount);
      expect(row.with_scholarship).toBe(termCount);
    }
  });

  test("no other invoice has a scholarship", () => {
    const others = db.prepare(`
      SELECT COUNT(*) n FROM invoices
      WHERE (scholarship_amount > 0 OR scholarship_type IS NOT NULL OR scholarship_name IS NOT NULL)
        AND student_id NOT IN (${scholarshipStudentIds.map(() => "?").join(",")})
    `).get(...scholarshipStudentIds).n;
    expect(others).toBe(0);
  });

  test("the scholarship reduces the final amount by 500", () => {
    const wrong = db.prepare(`
      SELECT COUNT(*) n FROM invoices
      WHERE scholarship_amount > 0 AND ABS(final_amount - (amount - scholarship_amount)) > 0.001
    `).get().n;
    expect(wrong).toBe(0);
  });

  test("no invoice is overpaid", () => {
    const overpaid = db.prepare(`
      SELECT i.id, i.final_amount, SUM(p.amount) AS paid
      FROM invoices i JOIN payments p ON p.invoice_id = i.id
      GROUP BY i.id
      HAVING SUM(p.amount) > i.final_amount + 0.001
    `).all();
    expect(overpaid).toEqual([]);
  });

  test("full payers of scholarship invoices paid exactly the final amount", () => {
    const fullPayers = db.prepare(`
      SELECT i.final_amount, SUM(p.amount) AS paid
      FROM invoices i JOIN payments p ON p.invoice_id = i.id
      WHERE i.scholarship_amount > 0 AND i.student_id % 10 <> 0
      GROUP BY i.id
    `).all();
    expect(fullPayers.length).toBeGreaterThan(0);
    for (const row of fullPayers) expect(row.paid).toBeCloseTo(row.final_amount, 2);
  });
});
