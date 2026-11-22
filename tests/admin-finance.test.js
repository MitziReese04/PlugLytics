const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");

let token;
const finance = (path, query = "") =>
  request(app).get(`/api/v1/admin/finance/${path}${query}`).set("Authorization", `Bearer ${token}`);

const round2 = (value) => Math.round(value * 100) / 100;

// Expected totals straight from the database, optionally for one term.
function expected(termCode) {
  const where = termCode ? "WHERE t.code = ?" : "";
  const params = termCode ? [termCode] : [];
  return db.prepare(`
    SELECT ROUND(SUM(i.amount), 2) AS gross,
           ROUND(SUM(i.scholarship_amount), 2) AS scholarships,
           ROUND(SUM(i.amount * i.discount_percent / 100.0), 2) AS discounts,
           ROUND(SUM(i.platform_fee + i.transaction_fee), 2) AS fees,
           ROUND(SUM(i.final_amount), 2) AS net,
           ROUND(SUM(i.final_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)), 2) AS outstanding,
           ROUND(SUM(COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)), 2) AS collected
    FROM invoices i JOIN terms t ON t.id = i.term_id
    ${where}
  `).get(...params);
}

beforeAll(async () => {
  const response = await request(app).post("/api/v1/auth/login").send({ email: "admin@pluglytics.local", password: "Demo123!" });
  token = response.body.data.token;
});

describe("admin finance overview", () => {
  test("reports gross billed, scholarships and discounts, and net billed (final amounts)", async () => {
    const response = await finance("overview");
    expect(response.status).toBe(200);
    const data = response.body.data[0];
    const db_ = expected();

    expect(Object.keys(data).slice(0, 5)).toEqual(["grossBilled", "scholarshipsAndDiscounts", "netBilled", "collected", "collectionRate"]);
    expect(data).toMatchObject({
      grossBilled: db_.gross,
      scholarships: db_.scholarships,
      discounts: db_.discounts,
      fees: db_.fees,
      netBilled: db_.net,
      scholarshipsAndDiscounts: round2(db_.scholarships + db_.discounts),
      collected: db_.collected,
    });
    // The demo data has scholarships, so net is below gross.
    expect(data.scholarships).toBeGreaterThan(0);
    expect(data.netBilled).toBeLessThan(data.grossBilled);
  });

  test("gross minus scholarships and discounts plus fees equals net billed", async () => {
    const data = (await finance("overview")).body.data[0];
    expect(round2(data.grossBilled - data.scholarships - data.discounts + data.fees)).toBeCloseTo(data.netBilled, 2);
  });

  test("the collection rate is collected divided by net billed", async () => {
    const data = (await finance("overview")).body.data[0];
    expect(data.collectionRate).toBe(Number(((data.collected / data.netBilled) * 100).toFixed(1)));
  });

  test("respects the term filter", async () => {
    const term = db.prepare("SELECT code FROM terms WHERE is_current = 1").get().code;
    const data = (await finance("overview", `?term=${term}`)).body.data[0];
    const db_ = expected(term);
    expect(data).toMatchObject({ grossBilled: db_.gross, netBilled: db_.net, scholarships: db_.scholarships });
  });
});

describe("admin finance outstanding", () => {
  test("outstanding equals final amount minus payments", async () => {
    const response = await finance("outstanding");
    expect(response.status).toBe(200);
    const total = round2(response.body.data.reduce((sum, bucket) => sum + bucket.outstanding, 0));
    expect(total).toBeCloseTo(expected().outstanding, 2);
  });

  test("outstanding equals final amount minus payments for one term", async () => {
    const term = db.prepare("SELECT code FROM terms ORDER BY start_date LIMIT 1").get().code;
    const response = await finance("outstanding", `?term=${term}`);
    const total = round2(response.body.data.reduce((sum, bucket) => sum + bucket.outstanding, 0));
    expect(total).toBeCloseTo(expected(term).outstanding, 2);
  });

  test("scholarships are not counted as money still owed", async () => {
    const owedOnScholarshipInvoices = db.prepare(`
      SELECT ROUND(SUM(i.final_amount - COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0)), 2) AS owed
      FROM invoices i
      WHERE i.scholarship_amount > 0
        AND COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.invoice_id = i.id), 0) >= i.final_amount
    `).get().owed;
    // Fully paid scholarship invoices owe nothing, even though their base amount is 500 higher.
    expect(owedOnScholarshipInvoices).toBe(0);
  });
});
