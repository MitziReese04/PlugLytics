const crypto = require("crypto");
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { checkManualMatch } = require("../src/stellarHorizon");

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const PAYER = "GCUSTOMERPAYERACCOUNTFORTESTSONLY234567ABCDEFGHIJKLMNOPQ";
const SOMEONE_ELSE = "GOTHERACCOUNTNOTTHEMERCHANT234567ABCDEFGHIJKLMNOPQRSTUVW";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const FAKE_SECRET = "S" + "A".repeat(55);
const STELLAR_VARS = ["STELLAR_ENV", "SANDBOX_MERCHANT_PUBLIC_KEY", "SANDBOX_MERCHANT_SECRET_KEY", "SANDBOX_WEBHOOK_SIGNING_SECRET"];
const savedEnv = {};

const demoStudent = db.prepare(
  "SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
).get();
const anyTerm = db.prepare("SELECT id FROM terms ORDER BY id LIMIT 1").get();
let adminToken;
const invoiceIds = [];
let counter = 0;

async function login(email) {
  return (await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" })).body.data.token;
}

// A payment request for a new invoice, stored directly with the given status.
function addRequest({ status = "failed", reason = "expired" } = {}) {
  counter += 1;
  const invoiceId = Number(db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, issued_at, due_at) VALUES (?, ?, 100, '2026-11-01T09:00:00Z', '2026-11-28T23:59:00Z')"
  ).run(demoStudent.id, anyTerm.id).lastInsertRowid);
  invoiceIds.push(invoiceId);
  const id = `pay_FIXTEST${String(counter).padStart(8, "0")}`;
  const memo = `PL-FIX${String(counter).padStart(5, "0")}`;
  const future = status === "pending";
  db.prepare(`
    INSERT INTO payment_requests (id, invoice_id, amount, asset, memo, destination, status, reason,
      quoted_rate, rate_source, invoice_currency, invoice_amount, created_at, expires_at)
    VALUES (?, ?, '250.0000000', 'XLM', ?, ?, ?, ?, '2.5000000', 'manual', 'USD', '100.00', ?, ?)
  `).run(id, invoiceId, memo, MERCHANT, status, status === "failed" ? reason : null,
    future ? new Date().toISOString() : "2026-11-20T10:00:00.000Z",
    future ? new Date(Date.now() + 30 * 60000).toISOString() : "2026-11-20T10:30:00.000Z");
  return { id, memo, invoiceId };
}

// Horizon answers for one transaction and its payments.
const txs = new Map();
function addTransaction({ memo = null, memoType = memo ? "text" : "none", successful = true, payments }) {
  const hash = crypto.randomBytes(32).toString("hex");
  const createdAt = "2026-11-20T11:15:00.000Z";
  txs.set(hash, {
    transaction: { hash, successful, memo: memo || undefined, memo_type: memoType, ledger: 5150, created_at: createdAt },
    payments: payments.map((p) => ({
      type: "payment", to: MERCHANT, from: PAYER, amount: "250.0000000", asset_type: "native",
      transaction_hash: hash, created_at: createdAt, ...p,
    })),
  });
  return hash;
}
function mockHorizon() {
  return jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    const match = String(url).match(/\/transactions\/([0-9a-f]{64})(\/payments)?/);
    const found = match && txs.get(match[1]);
    if (!found) return { ok: false, status: 404, json: async () => ({ status: 404 }) };
    const body = match[2] ? { _embedded: { records: found.payments }, _links: {} } : found.transaction;
    return { ok: true, status: 200, json: async () => body };
  });
}

const post = (id, action, body, token = adminToken) =>
  request(app).post(`/api/v1/payments/${id}/${action}`).set("Authorization", `Bearer ${token}`).send(body);
const NOTE = "Checked with the school's finance office";
const stored = (id) => db.prepare("SELECT * FROM payment_requests WHERE id = ?").get(id);

beforeAll(async () => {
  for (const name of STELLAR_VARS) savedEnv[name] = process.env[name];
  for (const name of STELLAR_VARS) delete process.env[name];
  Object.assign(process.env, {
    STELLAR_ENV: "sandbox", SANDBOX_MERCHANT_PUBLIC_KEY: MERCHANT,
    SANDBOX_MERCHANT_SECRET_KEY: FAKE_SECRET, SANDBOX_WEBHOOK_SIGNING_SECRET: "test-only-server-key-fixes",
  });
  adminToken = await login("admin@pluglytics.local");
});
beforeEach(() => mockHorizon());
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  const marks = invoiceIds.map(() => "?").join(",");
  // Follow-up records first: they point at the originals.
  db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks}) AND related_payment_id IS NOT NULL`).run(...invoiceIds);
  db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks})`).run(...invoiceIds);
  db.prepare(`DELETE FROM invoices WHERE id IN (${marks})`).run(...invoiceIds);
  for (const name of STELLAR_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("POST /api/v1/payments/:id/accept-late-payment", () => {
  test("creates a new completed record linked to the expired request, which stays as it was", async () => {
    const original = addRequest();
    const hash = addTransaction({ memo: original.memo, payments: [{}] });
    const before = stored(original.id);
    const response = await post(original.id, "accept-late-payment", { transactionHash: hash, note: NOTE });

    expect(response.status).toBe(201);
    const data = response.body.data;
    expect(data).toMatchObject({
      status: "completed", amount: "250.0000000", amountReceived: "250.0000000", asset: "XLM", assetIssuer: null,
      transactionHash: hash, ledger: 5150, paidAt: "2026-11-20T11:15:00.000Z", relatedPaymentId: original.id,
      note: NOTE, acceptedBy: "admin@pluglytics.local", invoiceId: original.invoiceId, quotedRate: "2.5000000",
    });
    expect(data.id).not.toBe(original.id);
    expect(data.memo).not.toBe(original.memo);
    expect(stored(data.id).source_account).toBe(PAYER);
    expect(data.sourceAccount).toBe(PAYER);
    expect(stored(original.id)).toEqual(before);
  });

  test("accepts an overpayment, like a normal completion", async () => {
    const original = addRequest();
    const hash = addTransaction({ memo: original.memo, payments: [{ amount: "260.0000000" }] });
    const response = await post(original.id, "accept-late-payment", { transactionHash: hash, note: NOTE });
    expect(response.status).toBe(201);
    expect(response.body.data.amountReceived).toBe("260.0000000");
  });

  test.each([
    ["a different memo", { memo: "PL-SOMEONE", payments: [{}] }, /memo does not match/],
    ["no memo", { payments: [{}] }, /memo does not match/],
    ["too little", { payments: [{ amount: "249.9999999" }] }, /less than the requested/],
    ["a different asset", { payments: [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER }] }, /different asset/],
    ["a payment to another account", { payments: [{ to: SOMEONE_ELSE }] }, /did not pay the merchant/],
    ["a failed transaction", { successful: false, payments: [{}] }, /did not succeed/],
  ])("refuses a transaction with %s", async (_, tx, problem) => {
    const original = addRequest();
    const hash = addTransaction({ memo: tx.memo === undefined && !/no memo/.test(_) ? original.memo : tx.memo, ...tx });
    const response = await post(original.id, "accept-late-payment", { transactionHash: hash, note: NOTE });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("TRANSACTION_MISMATCH");
    expect(response.body.error.message).toMatch(problem);
    expect(db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE related_payment_id = ?").get(original.id).n).toBe(0);
  });

  test("refuses a transaction Horizon does not know", async () => {
    const original = addRequest();
    const response = await post(original.id, "accept-late-payment", { transactionHash: "f".repeat(64), note: NOTE });
    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/not found on Horizon/);
  });

  test("only works on a request that is failed with reason expired", async () => {
    for (const state of [{ status: "pending" }, { status: "failed", reason: "cancelled" }, { status: "failed", reason: "underpaid" }]) {
      const original = addRequest(state);
      const hash = addTransaction({ memo: original.memo, payments: [{}] });
      const response = await post(original.id, "accept-late-payment", { transactionHash: hash, note: NOTE });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("RELATED_PAYMENT_NOT_FAILED");
    }
  });
});

describe("POST /api/v1/payments/:id/match-transaction", () => {
  test("links a payment without a memo to an expired request", async () => {
    const original = addRequest();
    const hash = addTransaction({ payments: [{}] });
    const response = await post(original.id, "match-transaction", { transactionHash: hash, note: NOTE });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ status: "completed", transactionHash: hash, relatedPaymentId: original.id, note: NOTE });
    expect(stored(original.id)).toMatchObject({ status: "failed", reason: "expired", tx_hash: null });
  });

  test("links a payment to a cancelled request, and accepts a memo that matches no request", async () => {
    const original = addRequest({ status: "failed", reason: "cancelled" });
    const hash = addTransaction({ memo: "INVOICE 42 PLEASE", payments: [{}] });
    const response = await post(original.id, "match-transaction", { transactionHash: hash, note: NOTE });
    expect(response.status).toBe(201);
  });

  test("refuses a transaction whose memo belongs to a payment request", async () => {
    const original = addRequest();
    const other = addRequest();
    const hash = addTransaction({ memo: other.memo, payments: [{}] });
    const response = await post(original.id, "match-transaction", { transactionHash: hash, note: NOTE });
    expect(response.status).toBe(422);
    expect(response.body.error.message).toMatch(/memo that belongs to a payment request/);
  });

  test("refuses a pending request: cancel it first", async () => {
    const original = addRequest({ status: "pending" });
    const hash = addTransaction({ payments: [{}] });
    const response = await post(original.id, "match-transaction", { transactionHash: hash, note: NOTE });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: "RELATED_PAYMENT_NOT_FAILED", message: expect.stringMatching(/cancel it first/) });
  });

  test("refuses too little, or the wrong asset", async () => {
    const original = addRequest();
    const short = addTransaction({ payments: [{ amount: "100.0000000" }] });
    expect((await post(original.id, "match-transaction", { transactionHash: short, note: NOTE })).status).toBe(422);
    const usdc = addTransaction({ payments: [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER }] });
    expect((await post(original.id, "match-transaction", { transactionHash: usdc, note: NOTE })).status).toBe(422);
  });
});

describe("rules for both", () => {
  test("a transaction already matched can never be used again", async () => {
    const first = addRequest();
    const hash = addTransaction({ payments: [{}] });
    expect((await post(first.id, "match-transaction", { transactionHash: hash, note: NOTE })).status).toBe(201);

    const second = addRequest();
    const again = await post(second.id, "match-transaction", { transactionHash: hash, note: NOTE });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("TRANSACTION_ALREADY_LINKED");
    // The same hash in capital letters is the same transaction.
    expect((await post(second.id, "match-transaction", { transactionHash: hash.toUpperCase(), note: NOTE })).status).toBe(409);
  });

  test("never pays the same invoice twice", async () => {
    const original = addRequest();
    const first = addTransaction({ payments: [{}] });
    expect((await post(original.id, "match-transaction", { transactionHash: first, note: NOTE })).status).toBe(201);
    const second = addTransaction({ memo: original.memo, payments: [{}] });
    const response = await post(original.id, "accept-late-payment", { transactionHash: second, note: NOTE });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVOICE_NOTHING_DUE");
  });

  test("sends payment.completed for the new record, with relatedPaymentId", async () => {
    const school = db.prepare("SELECT id FROM schools ORDER BY id LIMIT 1").get();
    const endpoint = (await request(app).post("/api/v1/webhooks").set("Authorization", `Bearer ${adminToken}`)
      .send({ schoolId: school.id, url: "https://lms.example.edu/hooks", events: ["payment.completed"] })).body.data;
    try {
      const original = addRequest();
      const hash = addTransaction({ memo: original.memo, payments: [{}] });
      const created = (await post(original.id, "accept-late-payment", { transactionHash: hash, note: NOTE })).body.data;
      const event = db.prepare("SELECT * FROM webhook_events WHERE payment_id = ?").get(created.id);
      expect(event.type).toBe("payment.completed");
      expect(JSON.parse(event.body).data).toMatchObject({
        paymentId: created.id, status: "completed", relatedPaymentId: original.id, transactionHash: hash, sourceAccount: PAYER,
      });
      expect(db.prepare("SELECT COUNT(*) n FROM webhook_deliveries WHERE event_id = ?").get(event.id).n).toBe(1);
      db.prepare("DELETE FROM webhook_events WHERE id = ?").run(event.id);
    } finally {
      db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(endpoint.id);
    }
  });

  test("the invoice then shows as paid to the student", async () => {
    const original = addRequest();
    const hash = addTransaction({ payments: [{}] });
    await post(original.id, "match-transaction", { transactionHash: hash, note: NOTE });
    const studentToken = await login("student@pluglytics.local");
    const invoices = (await request(app).get("/api/v1/payments/invoices").set("Authorization", `Bearer ${studentToken}`)).body.data;
    expect(invoices.find((i) => i.id === original.invoiceId)).toMatchObject({ status: "settled", outstanding: "0.00" });
  });

  test.each([
    ["a missing note", { transactionHash: "a".repeat(64) }],
    ["a blank note", { transactionHash: "a".repeat(64), note: "  " }],
    ["a short hash", { transactionHash: "abc", note: NOTE }],
    ["an unknown field", { transactionHash: "a".repeat(64), note: NOTE, amount: "1" }],
  ])("rejects %s", async (_, body) => {
    const original = addRequest();
    for (const action of ["accept-late-payment", "match-transaction"]) {
      const response = await post(original.id, action, body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    }
  });

  test("returns 502 and creates nothing when Horizon cannot be reached", async () => {
    jest.restoreAllMocks();
    jest.spyOn(global, "fetch").mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const original = addRequest();
    const response = await post(original.id, "match-transaction", { transactionHash: "b".repeat(64), note: NOTE });
    expect(response.status).toBe(502);
    expect(db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE related_payment_id = ?").get(original.id).n).toBe(0);
  });

  test("is admin-only, and unknown requests return 404", async () => {
    const original = addRequest();
    const hash = addTransaction({ payments: [{}] });
    const studentToken = await login("student@pluglytics.local");
    for (const action of ["accept-late-payment", "match-transaction"]) {
      expect((await post(original.id, action, { transactionHash: hash, note: NOTE }, studentToken)).status).toBe(403);
      expect((await request(app).post(`/api/v1/payments/${original.id}/${action}`).send({})).status).toBe(401);
      expect((await post("pay_DOESNOTEXIST00", action, { transactionHash: hash, note: NOTE })).status).toBe(404);
    }
  });
});

describe("checkManualMatch", () => {
  const requestRow = { amount: "250.0000000", asset: "XLM", asset_issuer: null, memo: "PL-ABC", destination: MERCHANT };
  const tx = (memo, payments) => ({ transaction: { successful: true, memo, memo_type: memo ? "text" : "none" }, payments });
  const pay = (p = {}) => ({ type: "payment", to: MERCHANT, from: PAYER, amount: "250.0000000", asset_type: "native", ...p });

  test("uses the largest payment to the merchant in the right asset", () => {
    const result = checkManualMatch(requestRow, tx(null, [pay({ amount: "10.0000000" }), pay({ amount: "300.0000000" }), pay({ to: SOMEONE_ELSE, amount: "999.0000000" })]),
      { mode: "no_memo", memoBelongsToARequest: () => false });
    expect(result).toMatchObject({ ok: true, payment: { amount: "300.0000000" } });
  });

  test("ignores operations that are not payments", () => {
    const result = checkManualMatch(requestRow, tx(null, [pay({ type: "create_account" })]), { mode: "no_memo", memoBelongsToARequest: () => false });
    expect(result).toMatchObject({ ok: false, problem: expect.stringMatching(/did not pay the merchant/) });
  });
});
