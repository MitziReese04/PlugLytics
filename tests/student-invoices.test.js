const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";

async function login(email) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" });
  return response.body.data.token;
}

const demoStudent = db.prepare(
  "SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
).get();
const latestTerm = db.prepare("SELECT id, name, code FROM terms ORDER BY start_date DESC LIMIT 1").get();

const createdInvoices = [];
function addInvoice(amount, currency = "USD") {
  const id = Number(db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, currency, issued_at, due_at) VALUES (?, ?, ?, ?, '2026-11-01T09:00:00Z', '2026-11-28T23:59:00Z')"
  ).run(demoStudent.id, latestTerm.id, amount, currency).lastInsertRowid);
  createdInvoices.push(id);
  return id;
}

let token;
const list = (t = token) => request(app).get("/api/v1/payments/invoices").set("Authorization", `Bearer ${t}`);

beforeAll(async () => {
  token = await login("student@pluglytics.local");
});

afterAll(() => {
  if (!createdInvoices.length) return;
  const marks = createdInvoices.map(() => "?").join(",");
  db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks})`).run(...createdInvoices);
  db.prepare(`DELETE FROM payments WHERE invoice_id IN (${marks})`).run(...createdInvoices);
  db.prepare(`DELETE FROM invoices WHERE id IN (${marks})`).run(...createdInvoices);
});

describe("GET /api/v1/payments/invoices", () => {
  test("lists only the student's own invoices with amounts and status", async () => {
    const due = addInvoice(100);
    const partial = addInvoice(1000, "PHP");
    db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 400, 'bank', '2026-11-02T10:00:00Z')").run(partial);

    const response = await list();
    expect(response.status).toBe(200);
    const rows = response.body.data;
    const own = db.prepare("SELECT COUNT(*) n FROM invoices WHERE student_id = ?").get(demoStudent.id).n;
    expect(rows).toHaveLength(own);
    expect(response.body.meta.total).toBe(own);

    expect(rows.find((r) => r.id === due)).toMatchObject({
      term: latestTerm.name, termCode: latestTerm.code, currency: "USD",
      finalAmount: "100.00", recordedPayments: "0.00", outstanding: "100.00", status: "due", latestPaymentRequest: null,
    });
    expect(rows.find((r) => r.id === partial)).toMatchObject({
      currency: "PHP", finalAmount: "1000.00", recordedPayments: "400.00", outstanding: "600.00", status: "partial",
    });
    // The seeded invoices for the demo student are fully paid.
    expect(rows.filter((r) => !createdInvoices.includes(r.id)).every((r) => r.status === "settled" && r.outstanding === "0.00")).toBe(true);
  });

  test("shows the latest Stellar request and treats a completed one as settled", async () => {
    const invoiceId = addInvoice(75);
    db.prepare(`
      INSERT INTO payment_requests (id, invoice_id, amount, asset, memo, destination, status, tx_hash, amount_received, ledger,
        quoted_rate, invoice_currency, invoice_amount, created_at, expires_at, completed_at)
      VALUES ('pay_LISTCOMPLETED01', ?, '187.5000000', 'XLM', 'PL-LISTDONE', ?, 'completed', ?, '187.5000000', 99,
        '2.5000000', 'USD', '75.00', '2026-11-01T10:00:00.000Z', '2026-11-01T10:30:00.000Z', '2026-11-01T10:05:00.000Z')
    `).run(invoiceId, MERCHANT, "b".repeat(64));

    const row = (await list()).body.data.find((r) => r.id === invoiceId);
    expect(row).toMatchObject({
      status: "settled",
      outstanding: "0.00",
      latestPaymentRequest: {
        id: "pay_LISTCOMPLETED01", status: "completed", reason: null, amount: "187.5000000", asset: "XLM",
        paidAt: "2026-11-01T10:05:00.000Z",
      },
    });
  });

  test("is only for students", async () => {
    expect((await request(app).get("/api/v1/payments/invoices")).status).toBe(401);
    expect((await list(await login("admin@pluglytics.local"))).status).toBe(403);
    expect((await list(await login("instructor@pluglytics.local"))).status).toBe(403);
  });
});
