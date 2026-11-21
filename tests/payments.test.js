const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { SANDBOX_XLM_RATES } = require("../src/stellarQuotes");

// A valid Stellar public key (generated once with Keypair.random()); public only.
const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
// Shaped like a Stellar secret key so the config check accepts it, but not a real key.
const FAKE_SECRET = "S" + "A".repeat(55);

const STELLAR_VARS = [
  "STELLAR_ENV", "STELLAR_HORIZON_URL", "STELLAR_NETWORK_PASSPHRASE",
  "SANDBOX_MERCHANT_PUBLIC_KEY", "SANDBOX_MERCHANT_SECRET_KEY", "SANDBOX_WEBHOOK_SIGNING_SECRET",
  "PRODUCTION_MERCHANT_PUBLIC_KEY", "PRODUCTION_MERCHANT_SECRET_KEY", "PRODUCTION_WEBHOOK_SIGNING_SECRET",
];
const savedEnv = {};

function useSandbox() {
  Object.assign(process.env, {
    STELLAR_ENV: "sandbox",
    SANDBOX_MERCHANT_PUBLIC_KEY: MERCHANT,
    SANDBOX_MERCHANT_SECRET_KEY: FAKE_SECRET,
    SANDBOX_WEBHOOK_SIGNING_SECRET: "test-webhook-key",
  });
}

async function login(email) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" });
  return response.body.data.token;
}

const demoStudent = db.prepare(
  "SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
).get();
const otherStudent = db.prepare("SELECT id FROM students WHERE id <> ? ORDER BY id LIMIT 1").get(demoStudent.id);
const anyTerm = db.prepare("SELECT id FROM terms ORDER BY id LIMIT 1").get();

const createdInvoices = [];
function addInvoice(studentId, amount, currency = "USD") {
  const id = db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, currency, issued_at, due_at) VALUES (?, ?, ?, ?, '2026-11-01T09:00:00Z', '2026-11-28T23:59:00Z')"
  ).run(studentId, anyTerm.id, amount, currency).lastInsertRowid;
  createdInvoices.push(Number(id));
  return Number(id);
}

let studentToken;
const pay = (body, token = studentToken) =>
  request(app).post("/api/v1/payments").set("Authorization", `Bearer ${token}`).send(body);

beforeAll(async () => {
  for (const name of STELLAR_VARS) savedEnv[name] = process.env[name];
  useSandbox();
  studentToken = await login("student@pluglytics.local");
});

afterEach(() => {
  for (const name of STELLAR_VARS) delete process.env[name];
  useSandbox();
});

afterAll(() => {
  if (createdInvoices.length) {
    const marks = createdInvoices.map(() => "?").join(",");
    db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks})`).run(...createdInvoices);
    db.prepare(`DELETE FROM invoices WHERE id IN (${marks})`).run(...createdInvoices);
  }
  for (const name of STELLAR_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("POST /api/v1/payments", () => {
  test("creates a pending XLM testnet request for the student's own unpaid invoice", async () => {
    const invoiceId = addInvoice(demoStudent.id, 100);
    const before = Date.now();
    const response = await pay({ invoiceId });

    expect(response.status).toBe(201);
    const data = response.body.data;
    expect(data).toMatchObject({
      type: "invoice",
      status: "pending",
      invoiceId,
      invoiceCurrency: "USD",
      invoiceAmount: "100.00",
      quotedRate: SANDBOX_XLM_RATES.USD,
      amount: "250.0000000", // 100 USD x 2.5 XLM
      asset: "XLM",
      assetIssuer: null,
      destination: MERCHANT,
      memoType: "text",
      network: "sandbox",
      paidAt: null,
      transactionHash: null,
      relatedPaymentId: null,
    });
    expect(data.id).toMatch(/^pay_[0-9A-Z]{16}$/);
    expect(data.memo).toMatch(/^PL-[0-9A-Z]{8}$/);
    expect(data.paymentUri).toBe(
      `web+stellar:pay?destination=${MERCHANT}&amount=250.0000000&memo=${data.memo}&memo_type=MEMO_TEXT`
    );
    const lifetime = Date.parse(data.expiresAt) - Date.parse(data.createdAt);
    expect(lifetime).toBe(30 * 60 * 1000);
    expect(Date.parse(data.createdAt)).toBeGreaterThanOrEqual(before - 1000);

    const row = db.prepare("SELECT * FROM payment_requests WHERE id = ?").get(data.id);
    expect(row).toMatchObject({ status: "pending", amount: "250.0000000", memo: data.memo, invoice_id: invoiceId });
  });

  test("charges only the outstanding balance and converts PHP with the PHP rate", async () => {
    const invoiceId = addInvoice(demoStudent.id, 1000, "PHP");
    db.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (?, 400, 'bank', '2026-11-02T10:00:00Z')").run(invoiceId);
    const response = await pay({ invoiceId });
    db.prepare("DELETE FROM payments WHERE invoice_id = ?").run(invoiceId);

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      invoiceAmount: "600.00",
      invoiceCurrency: "PHP",
      quotedRate: SANDBOX_XLM_RATES.PHP,
      amount: "25.8000000", // 600 PHP x 0.043 XLM
    });
  });

  test("refuses a second request while one is pending, then allows a new one after it fails", async () => {
    const invoiceId = addInvoice(demoStudent.id, 50);
    const first = await pay({ invoiceId });
    expect(first.status).toBe(201);

    const second = await pay({ invoiceId });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatchObject({ code: "PAYMENT_ALREADY_PENDING", details: { paymentId: first.body.data.id } });

    db.prepare("UPDATE payment_requests SET status = 'failed', reason = 'expired' WHERE id = ?").run(first.body.data.id);
    const third = await pay({ invoiceId });
    expect(third.status).toBe(201);
    expect(third.body.data.id).not.toBe(first.body.data.id);
    expect(third.body.data.memo).not.toBe(first.body.data.memo);
  });

  test("returns 409 when the invoice is fully paid", async () => {
    const paid = db.prepare(`
      SELECT i.id FROM invoices i
      WHERE i.student_id = ? AND i.final_amount <= COALESCE((SELECT SUM(amount) FROM payments WHERE invoice_id = i.id), 0)
      LIMIT 1`).get(demoStudent.id);
    const response = await pay({ invoiceId: paid.id });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVOICE_NOTHING_DUE");
  });

  test("returns 409 when the invoice already has a completed Stellar payment", async () => {
    const invoiceId = addInvoice(demoStudent.id, 75);
    db.prepare(`
      INSERT INTO payment_requests (id, invoice_id, amount, asset, memo, destination, status, tx_hash,
        quoted_rate, invoice_currency, created_at, expires_at, completed_at)
      VALUES ('pay_TESTCOMPLETED01', ?, '187.5000000', 'XLM', 'PL-TESTDONE', ?, 'completed', ?,
        '2.5000000', 'USD', '2026-11-01T10:00:00.000Z', '2026-11-01T10:30:00.000Z', '2026-11-01T10:05:00.000Z')
    `).run(invoiceId, MERCHANT, "a".repeat(64));
    const response = await pay({ invoiceId });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVOICE_NOTHING_DUE");
  });

  test("students cannot pay another student's invoice, and it looks the same as a missing one", async () => {
    const theirs = addInvoice(otherStudent.id, 100);
    const response = await pay({ invoiceId: theirs });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("INVOICE_NOT_FOUND");

    const missing = await pay({ invoiceId: 99999999 });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("INVOICE_NOT_FOUND");
    expect(db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE invoice_id = ?").get(theirs).n).toBe(0);
  });

  test("requires a signed-in student", async () => {
    const invoiceId = addInvoice(demoStudent.id, 10);
    expect((await request(app).post("/api/v1/payments").send({ invoiceId })).status).toBe(401);
    for (const email of ["admin@pluglytics.local", "instructor@pluglytics.local"]) {
      const response = await pay({ invoiceId }, await login(email));
      expect(response.status).toBe(403);
    }
  });

  test.each([
    ["missing invoiceId", {}],
    ["invoiceId as text", { invoiceId: "12" }],
    ["unknown field", { invoiceId: 1, amount: "1.0000000" }],
  ])("rejects %s", async (_, body) => {
    const response = await pay(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("only XLM is enabled so far", async () => {
    const invoiceId = addInvoice(demoStudent.id, 10);
    const response = await pay({ invoiceId, asset: "USDC" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("UNSUPPORTED_ASSET");
  });

  test("returns 422 when there is no sandbox rate for the invoice currency", async () => {
    const invoiceId = addInvoice(demoStudent.id, 10, "EUR");
    const response = await pay({ invoiceId });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("RATE_UNAVAILABLE");
  });

  test("returns 503 when Stellar is not configured", async () => {
    const invoiceId = addInvoice(demoStudent.id, 10);
    delete process.env.SANDBOX_MERCHANT_PUBLIC_KEY;
    const response = await pay({ invoiceId });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("STELLAR_NOT_CONFIGURED");
  });

  test("refuses to create requests when configured for production", async () => {
    const invoiceId = addInvoice(demoStudent.id, 10);
    Object.assign(process.env, {
      STELLAR_ENV: "production",
      PRODUCTION_MERCHANT_PUBLIC_KEY: MERCHANT,
      PRODUCTION_MERCHANT_SECRET_KEY: FAKE_SECRET,
      PRODUCTION_WEBHOOK_SIGNING_SECRET: "test-webhook-key",
    });
    const response = await pay({ invoiceId });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("STELLAR_NOT_CONFIGURED");
    expect(db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE invoice_id = ?").get(invoiceId).n).toBe(0);
  });
});
