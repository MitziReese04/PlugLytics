const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { computeFinalAmount } = require("../src/pricing");

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const student = db.prepare("SELECT id FROM students ORDER BY id DESC LIMIT 1").get();
const term = db.prepare("SELECT id FROM terms WHERE is_current = 1").get();

let adminToken;
const created = [];

async function login(email) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" });
  return response.body.data.token;
}

const post = (body, token = adminToken) =>
  request(app).post("/api/v1/invoices").set("Authorization", `Bearer ${token}`).send(body);
const patch = (id, body, token = adminToken) =>
  request(app).patch(`/api/v1/invoices/${id}`).set("Authorization", `Bearer ${token}`).send(body);

const base = () => ({ studentId: student.id, termId: term.id, basePrice: 3000, dueAt: "2026-12-15T23:59:00Z" });

async function create(fields = {}) {
  const response = await post({ ...base(), ...fields });
  expect(response.status).toBe(201);
  created.push(response.body.data.id);
  return response.body.data;
}

beforeAll(async () => {
  adminToken = await login("admin@pluglytics.local");
});

afterAll(() => {
  if (!created.length) return;
  const marks = created.map(() => "?").join(",");
  db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks})`).run(...created);
  db.prepare(`DELETE FROM payments WHERE invoice_id IN (${marks})`).run(...created);
  db.prepare(`DELETE FROM invoices WHERE id IN (${marks})`).run(...created);
});

describe("POST /api/v1/invoices", () => {
  test("creates an invoice with pricing fields and the computed final amount", async () => {
    const pricing = {
      basePrice: 3000, currency: "PHP", scholarshipAmount: 500, scholarshipType: "merit",
      scholarshipName: "Academic Merit Scholarship", discountPercent: 10, discountCode: "EARLY10",
      platformFee: 25, transactionFee: 1.5, instructorCost: 800,
    };
    const invoice = await create(pricing);
    expect(invoice).toMatchObject({ studentId: student.id, termId: term.id, ...pricing, finalAmount: 2226.5 });
    expect(invoice.finalAmount).toBe(computeFinalAmount(pricing));
    expect(db.prepare("SELECT final_amount FROM invoices WHERE id = ?").get(invoice.id).final_amount).toBe(2226.5);
    expect(Date.parse(invoice.issuedAt)).not.toBeNaN();
  });

  test("uses the pricing defaults when only a base price is given", async () => {
    const invoice = await create();
    expect(invoice).toMatchObject({
      currency: "USD", scholarshipAmount: 0, scholarshipType: null, scholarshipName: null, discountPercent: 0,
      discountCode: null, platformFee: 0, transactionFee: 0, instructorCost: 0, finalAmount: 3000,
    });
  });

  test("shows up in admin finance straight away", async () => {
    const before = (await request(app).get("/api/v1/admin/finance/overview").set("Authorization", `Bearer ${adminToken}`)).body.data[0];
    await create({ basePrice: 1234 });
    const after = (await request(app).get("/api/v1/admin/finance/overview").set("Authorization", `Bearer ${adminToken}`)).body.data[0];
    expect(Math.round((after.grossBilled - before.grossBilled) * 100) / 100).toBe(1234);
  });

  test.each([
    ["a negative base price", { basePrice: -1 }],
    ["a negative fee", { platformFee: -5 }],
    ["a discount over 100", { discountPercent: 101 }],
    ["a scholarship without a type", { scholarshipAmount: 100 }],
    ["a scholarship name without a scholarship", { scholarshipName: "Merit" }],
    ["a final amount below zero", { scholarshipAmount: 2900, scholarshipType: "merit", discountPercent: 50 }],
    ["a lowercase currency", { currency: "php" }],
    ["an unknown field", { finalAmount: 10 }],
    ["a missing due date", { dueAt: undefined }],
    ["a bad due date", { dueAt: "next week" }],
    ["a due date before the issue date", { issuedAt: "2026-12-20", dueAt: "2026-12-01" }],
    ["a text student ID", { studentId: "1" }],
  ])("rejects %s", async (_, fields) => {
    const response = await post({ ...base(), ...fields });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects an unknown student or term", async () => {
    expect((await post({ ...base(), studentId: 99999999 })).body.error.code).toBe("STUDENT_NOT_FOUND");
    expect((await post({ ...base(), termId: 99999999 })).body.error.code).toBe("TERM_NOT_FOUND");
  });

  test("is admin-only", async () => {
    expect((await request(app).post("/api/v1/invoices").send(base())).status).toBe(401);
    expect((await post(base(), await login("student@pluglytics.local"))).status).toBe(403);
    expect((await post(base(), await login("instructor@pluglytics.local"))).status).toBe(403);
  });
});

describe("PATCH /api/v1/invoices/:id", () => {
  test("changes only the fields sent and recomputes the final amount", async () => {
    const invoice = await create({ discountPercent: 10, discountCode: "EARLY10" });
    const response = await patch(invoice.id, { platformFee: 50, dueAt: "2026-12-31T23:59:00Z" });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      discountPercent: 10, discountCode: "EARLY10", platformFee: 50, dueAt: "2026-12-31T23:59:00Z",
      finalAmount: 3000 - 300 + 50,
    });
    expect(db.prepare("SELECT final_amount FROM invoices WHERE id = ?").get(invoice.id).final_amount).toBe(2750);
  });

  test("checks the merged pricing, not just the change", async () => {
    const invoice = await create({ scholarshipAmount: 2000, scholarshipType: "need_based" });
    const response = await patch(invoice.id, { discountPercent: 50 }); // 3000 - 2000 - 1500 < 0
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("removing a scholarship also clears its type and name", async () => {
    const invoice = await create({ scholarshipAmount: 500, scholarshipType: "merit", scholarshipName: "Academic Merit Scholarship" });
    const response = await patch(invoice.id, { scholarshipAmount: 0 });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ scholarshipAmount: 0, scholarshipType: null, scholarshipName: null, finalAmount: 3000 });
  });

  test.each([
    ["the student", { studentId: 1 }],
    ["the term", { termId: 1 }],
    ["the issue date", { issuedAt: "2026-01-01" }],
    ["the final amount", { finalAmount: 1 }],
  ])("does not allow changing %s", async (_, body) => {
    const invoice = await create();
    const response = await patch(invoice.id, body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects an empty update", async () => {
    const invoice = await create();
    expect((await patch(invoice.id, {})).status).toBe(400);
  });

  test("is blocked once the invoice has a completed Stellar payment", async () => {
    const invoice = await create();
    db.prepare(`
      INSERT INTO payment_requests (id, invoice_id, amount, asset, memo, destination, status, tx_hash, amount_received, ledger,
        quoted_rate, rate_source, invoice_currency, invoice_amount, created_at, expires_at, completed_at)
      VALUES (?, ?, '7500.0000000', 'XLM', ?, ?, 'completed', ?, '7500.0000000', 77, '2.5000000', 'manual', 'USD', '3000.00',
        '2026-11-01T10:00:00.000Z', '2026-11-01T10:30:00.000Z', '2026-11-01T10:05:00.000Z')
    `).run(`pay_INVTEST${invoice.id}`, invoice.id, `PL-INV${invoice.id}`, MERCHANT, invoice.id.toString(16).padStart(64, "f"));

    const response = await patch(invoice.id, { platformFee: 10 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVOICE_HAS_COMPLETED_PAYMENT");
    expect(db.prepare("SELECT platform_fee FROM invoices WHERE id = ?").get(invoice.id).platform_fee).toBe(0);
  });

  test("is blocked once a payment has been recorded for the invoice", async () => {
    const invoice = await create();
    db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 100, 'bank', '2026-11-02T10:00:00Z')").run(invoice.id);
    const response = await patch(invoice.id, { discountPercent: 5 });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVOICE_HAS_COMPLETED_PAYMENT");
  });

  test("is blocked while a payment request is pending (its quote is locked)", async () => {
    const invoice = await create();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    db.prepare(`
      INSERT INTO payment_requests (id, invoice_id, amount, asset, memo, destination, status, quoted_rate, rate_source,
        invoice_currency, invoice_amount, created_at, expires_at)
      VALUES (?, ?, '7500.0000000', 'XLM', ?, ?, 'pending', '2.5000000', 'manual', 'USD', '3000.00', ?, ?)
    `).run(`pay_INVPEND${invoice.id}`, invoice.id, `PL-IP${invoice.id}`, MERCHANT, new Date().toISOString(), expiresAt);
    const response = await patch(invoice.id, { basePrice: 2000 });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: "PAYMENT_ALREADY_PENDING", details: { paymentId: `pay_INVPEND${invoice.id}` } });
  });

  test("returns 404 for an unknown invoice and is admin-only", async () => {
    expect((await patch(99999999, { platformFee: 1 })).body.error.code).toBe("INVOICE_NOT_FOUND");
    const invoice = await create();
    expect((await patch(invoice.id, { platformFee: 1 }, await login("student@pluglytics.local"))).status).toBe(403);
  });
});
