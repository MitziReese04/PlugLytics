const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { toStroops, findPaymentsWithMemo, decideOutcome } = require("../src/stellarHorizon");

// Valid Stellar public keys (generated once with Keypair.random()); public only.
const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const PAYER = "GCUSTOMERPAYERACCOUNTFORTESTSONLY234567ABCDEFGHIJKLMNOPQ";
const OTHER_ACCOUNT = "GOTHERACCOUNTNOTTHEMERCHANT234567ABCDEFGHIJKLMNOPQRSTUVW";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const FAKE_SECRET = "S" + "A".repeat(55);
const HORIZON = "https://horizon-testnet.stellar.org";

const STELLAR_VARS = [
  "STELLAR_ENV", "STELLAR_HORIZON_URL", "STELLAR_NETWORK_PASSPHRASE",
  "SANDBOX_MERCHANT_PUBLIC_KEY", "SANDBOX_MERCHANT_SECRET_KEY", "SANDBOX_WEBHOOK_SIGNING_SECRET",
  "PAYMENT_MANUAL_RATE_USD_XLM", "XLM_MIN_AMOUNT", "XLM_MAX_AMOUNT",
];
const savedEnv = {};
function useSandbox() {
  for (const name of STELLAR_VARS) delete process.env[name];
  Object.assign(process.env, {
    STELLAR_ENV: "sandbox",
    SANDBOX_MERCHANT_PUBLIC_KEY: MERCHANT,
    SANDBOX_MERCHANT_SECRET_KEY: FAKE_SECRET,
    SANDBOX_WEBHOOK_SIGNING_SECRET: "test-webhook-key",
  });
}

let txCounter = 0;
function horizonPayment({
  memo, amount = "250.0000000", to = MERCHANT, asset = "XLM", assetIssuer = USDC_ISSUER,
  createdAt = new Date().toISOString(), successful = true, type = "payment", memoType = "text",
}) {
  txCounter += 1;
  const hash = txCounter.toString(16).padStart(64, "c");
  const assetFields = asset === "XLM"
    ? { asset_type: "native" }
    : { asset_type: "credit_alphanum4", asset_code: asset, asset_issuer: assetIssuer };
  return {
    type, to, from: PAYER, amount, ...assetFields,
    transaction_hash: hash,
    transaction_successful: successful,
    created_at: createdAt,
    transaction: { hash, memo, memo_type: memoType, successful, ledger: 2000000 + txCounter, created_at: createdAt },
  };
}

function horizonPage(records, nextHref = null) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ _embedded: { records }, _links: { next: nextHref ? { href: nextHref } : undefined } }),
  };
}

async function login(email) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" });
  return response.body.data.token;
}

const demoStudent = db.prepare(
  "SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
).get();
const otherStudent = db.prepare("SELECT s.id, u.email FROM students s JOIN users u ON u.id = s.user_id WHERE s.id <> ? ORDER BY s.id LIMIT 1").get(demoStudent.id);
const anyTerm = db.prepare("SELECT id FROM terms ORDER BY id LIMIT 1").get();

const createdInvoices = [];
function addInvoice(amount = 100) {
  const id = Number(db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, currency, issued_at, due_at) VALUES (?, ?, ?, 'USD', '2026-11-01T09:00:00Z', '2026-11-28T23:59:00Z')"
  ).run(demoStudent.id, anyTerm.id, amount).lastInsertRowid);
  createdInvoices.push(id);
  return id;
}

let studentToken;
let fetchSpy;

const postPayment = (invoiceId) => request(app)
  .post("/api/v1/payments")
  .set("Authorization", `Bearer ${studentToken}`)
  .send({ invoiceId });

// Creates a pending 100 USD (= 250 XLM) request through the API.
async function createPending(invoiceId = addInvoice(100)) {
  const response = await postPayment(invoiceId);
  expect(response.status).toBe(201);
  return response.body.data;
}

const check = (id, token = studentToken) =>
  request(app).get(`/api/v1/payments/${id}`).set("Authorization", `Bearer ${token}`);

// Moves a request into the past so it is already expired.
function expire(id) {
  db.prepare(
    "UPDATE payment_requests SET created_at = '2026-01-01T10:00:00.000Z', expires_at = '2026-01-01T10:30:00.000Z' WHERE id = ?"
  ).run(id);
}

beforeAll(async () => {
  for (const name of STELLAR_VARS) savedEnv[name] = process.env[name];
  useSandbox();
  studentToken = await login("student@pluglytics.local");
});

beforeEach(() => {
  useSandbox();
  fetchSpy = jest.spyOn(global, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
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

describe("toStroops", () => {
  test("converts 7-decimal strings without floating-point errors", () => {
    expect(toStroops("25.0000000")).toBe(250000000n);
    expect(toStroops("0.0000001")).toBe(1n);
    expect(toStroops("0.1")).toBe(1000000n);
    expect(toStroops("100")).toBe(1000000000n);
  });
});

describe("findPaymentsWithMemo", () => {
  const since = "2026-11-22T09:00:00.000Z";

  test("keeps only successful payments to the account with the exact text memo", async () => {
    const at = "2026-11-22T09:10:00.000Z";
    const keep = horizonPayment({ memo: "PL-AAAA1111", createdAt: at });
    const records = [
      keep,
      horizonPayment({ memo: "PL-AAAA1111", to: OTHER_ACCOUNT, createdAt: at }),
      horizonPayment({ memo: "PL-BBBB2222", createdAt: at }),
      horizonPayment({ memo: "PL-AAAA1111", successful: false, createdAt: at }),
      horizonPayment({ memo: "PL-AAAA1111", memoType: "id", createdAt: at }),
      horizonPayment({ memo: "PL-AAAA1111", type: "create_account", createdAt: at }),
    ];
    const fetchImpl = jest.fn().mockResolvedValue(horizonPage(records));
    const found = await findPaymentsWithMemo({ horizonUrl: HORIZON, account: MERCHANT, memo: "PL-AAAA1111", since, fetchImpl });

    expect(found).toEqual([keep]);
    const url = fetchImpl.mock.calls[0][0];
    expect(url).toBe(`${HORIZON}/accounts/${MERCHANT}/payments?order=desc&limit=200&join=transactions`);
  });

  test("stops at payments older than the request (allowing 5 minutes of clock skew)", async () => {
    const records = [
      horizonPayment({ memo: "PL-SKEW0001", createdAt: "2026-11-22T08:57:00.000Z" }), // within skew
      horizonPayment({ memo: "PL-SKEW0001", createdAt: "2026-11-22T08:50:00.000Z" }), // too old
    ];
    const fetchImpl = jest.fn().mockResolvedValue(horizonPage(records, `${HORIZON}/next`));
    const found = await findPaymentsWithMemo({ horizonUrl: HORIZON, account: MERCHANT, memo: "PL-SKEW0001", since, fetchImpl });
    expect(found).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test("treats a merchant account Horizon does not know yet (404) as no payments", async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({ status: 404 }) });
    const found = await findPaymentsWithMemo({ horizonUrl: HORIZON, account: MERCHANT, memo: "PL-NEWACCT1", since, fetchImpl });
    expect(found).toEqual([]);
  });

  test("follows Horizon's next link when a page is full", async () => {
    const filler = Array.from({ length: 200 }, () => horizonPayment({ memo: "PL-OTHER000", createdAt: "2026-11-22T09:30:00.000Z" }));
    const target = horizonPayment({ memo: "PL-PAGE0002", createdAt: "2026-11-22T09:05:00.000Z" });
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(horizonPage(filler, `${HORIZON}/accounts/${MERCHANT}/payments?cursor=abc`))
      .mockResolvedValueOnce(horizonPage([target]));
    const found = await findPaymentsWithMemo({ horizonUrl: HORIZON, account: MERCHANT, memo: "PL-PAGE0002", since, fetchImpl });
    expect(found).toEqual([target]);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${HORIZON}/accounts/${MERCHANT}/payments?cursor=abc`);
  });
});

describe("decideOutcome", () => {
  const pending = {
    amount: "250.0000000", asset: "XLM", asset_issuer: null,
    created_at: "2026-11-22T09:00:00.000Z", expires_at: "2026-11-22T09:30:00.000Z",
  };
  const during = "2026-11-22T09:10:00.000Z";
  const beforeExpiry = new Date("2026-11-22T09:20:00.000Z");

  test("uses the earliest full payment when there is more than one", () => {
    const first = horizonPayment({ memo: "m", createdAt: "2026-11-22T09:05:00.000Z" });
    const second = horizonPayment({ memo: "m", createdAt: "2026-11-22T09:06:00.000Z" });
    expect(decideOutcome(pending, [second, first], beforeExpiry).txHash).toBe(first.transaction_hash);
  });

  test("a full payment wins over an earlier partial one", () => {
    const partial = horizonPayment({ memo: "m", amount: "100.0000000", createdAt: "2026-11-22T09:05:00.000Z" });
    const full = horizonPayment({ memo: "m", amount: "250.0000000", createdAt: "2026-11-22T09:06:00.000Z" });
    expect(decideOutcome(pending, [full, partial], beforeExpiry)).toMatchObject({ status: "completed", txHash: full.transaction_hash });
  });

  test("stays pending (null) when nothing has arrived and it has not expired", () => {
    expect(decideOutcome(pending, [], beforeExpiry)).toBeNull();
  });

  test("a USDC request is only completed by USDC from the same issuer", () => {
    const usdc = { ...pending, asset: "USDC", asset_issuer: USDC_ISSUER };
    const fake = horizonPayment({ memo: "m", asset: "USDC", assetIssuer: OTHER_ACCOUNT, createdAt: during });
    expect(decideOutcome(usdc, [fake], beforeExpiry)).toMatchObject({ status: "failed", reason: "wrong_asset" });
    const real = horizonPayment({ memo: "m", asset: "USDC", createdAt: during });
    expect(decideOutcome(usdc, [real], beforeExpiry)).toMatchObject({ status: "completed" });
  });
});

describe("quote locking when creating payment requests", () => {
  test("the quoted rate stays locked while the request is pending, even if the rate changes", async () => {
    const invoiceId = addInvoice(100);
    const first = await createPending(invoiceId);
    expect(first).toMatchObject({ quotedRate: "2.5000000", amount: "250.0000000" });

    process.env.PAYMENT_MANUAL_RATE_USD_XLM = "4";
    const again = await postPayment(invoiceId);
    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({ code: "PAYMENT_ALREADY_PENDING", details: { paymentId: first.id } });

    fetchSpy.mockResolvedValue(horizonPage([]));
    const stored = await check(first.id);
    expect(stored.body.data).toMatchObject({ status: "pending", quotedRate: "2.5000000", amount: "250.0000000" });
    expect(fetchSpy).toHaveBeenCalled();
  });

  test("after expiry, an unchecked request is settled first and a new request gets a new quote", async () => {
    const invoiceId = addInvoice(100);
    const old = await createPending(invoiceId);
    expire(old.id);
    process.env.PAYMENT_MANUAL_RATE_USD_XLM = "4";
    fetchSpy.mockResolvedValue(horizonPage([]));

    const response = await postPayment(invoiceId);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ quotedRate: "4.0000000", rateSource: "manual", amount: "400.0000000" });
    expect(response.body.data.id).not.toBe(old.id);
    expect(fetchSpy.mock.calls[0][0]).toContain(`/accounts/${MERCHANT}/payments`);

    const oldRow = db.prepare("SELECT status, reason, quoted_rate, amount FROM payment_requests WHERE id = ?").get(old.id);
    expect(oldRow).toEqual({ status: "failed", reason: "expired", quoted_rate: "2.5000000", amount: "250.0000000" });
  });

  test("an expired request that was actually paid on time is completed instead of being quoted again", async () => {
    const invoiceId = addInvoice(100);
    const old = await createPending(invoiceId);
    expire(old.id);
    fetchSpy.mockResolvedValue(horizonPage([
      horizonPayment({ memo: old.memo, amount: old.amount, createdAt: "2026-01-01T10:20:00.000Z" }),
    ]));

    const response = await postPayment(invoiceId);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("INVOICE_NOTHING_DUE");
    expect(db.prepare("SELECT status FROM payment_requests WHERE id = ?").get(old.id).status).toBe("completed");
    expect(db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE invoice_id = ?").get(invoiceId).n).toBe(1);
  });

  test("does not create a new quote when the expired request cannot be checked", async () => {
    const invoiceId = addInvoice(100);
    const old = await createPending(invoiceId);
    expire(old.id);
    fetchSpy.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) });

    const response = await postPayment(invoiceId);
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("HORIZON_UNAVAILABLE");
    expect(db.prepare("SELECT COUNT(*) n FROM payment_requests WHERE invoice_id = ?").get(invoiceId).n).toBe(1);
    expect(db.prepare("SELECT status FROM payment_requests WHERE id = ?").get(old.id).status).toBe("pending");
  });

  test("the minimum and maximum are checked on the converted amount", async () => {
    process.env.XLM_MAX_AMOUNT = "249.9999999";
    const response = await postPayment(addInvoice(100)); // 250 XLM
    expect(response.status).toBe(400);
    expect(response.body.error.details).toMatchObject({ amount: "250.0000000", max: "249.9999999" });
  });
});

const cancel = (id, token = studentToken) =>
  request(app).post(`/api/v1/payments/${id}/cancel`).set("Authorization", `Bearer ${token}`);

describe("POST /api/v1/payments/:id/cancel", () => {
  test("cancels a pending request: it becomes failed with reason cancelled", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([]));
    const response = await cancel(created.id);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: created.id, status: "failed", reason: "cancelled", paidAt: null, transactionHash: null });
    expect(db.prepare("SELECT status, reason FROM payment_requests WHERE id = ?").get(created.id))
      .toEqual({ status: "failed", reason: "cancelled" });
    // Horizon was checked first, in case a payment had already arrived.
    expect(fetchSpy.mock.calls[0][0]).toContain(`/accounts/${MERCHANT}/payments`);
  });

  test("does not cancel a request the payer has already paid: it is completed instead", async () => {
    const created = await createPending();
    const paid = horizonPayment({ memo: created.memo, amount: created.amount });
    fetchSpy.mockResolvedValue(horizonPage([paid]));
    const response = await cancel(created.id);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: "PAYMENT_ALREADY_COMPLETED", details: { paymentId: created.id, transactionHash: paid.transaction_hash },
    });
    expect(db.prepare("SELECT status FROM payment_requests WHERE id = ?").get(created.id).status).toBe("completed");
  });

  test("only pending requests can be cancelled", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([]));
    expect((await cancel(created.id)).status).toBe(200);

    const again = await cancel(created.id);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("PAYMENT_NOT_PENDING");

    const completed = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([horizonPayment({ memo: completed.memo, amount: completed.amount })]));
    await check(completed.id);
    const done = await cancel(completed.id);
    expect(done.status).toBe(409);
    expect(done.body.error.code).toBe("PAYMENT_ALREADY_COMPLETED");
  });

  test("an expired request is settled as expired, not cancelled", async () => {
    const created = await createPending();
    expire(created.id);
    fetchSpy.mockResolvedValue(horizonPage([]));
    const response = await cancel(created.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("PAYMENT_NOT_PENDING");
    expect(db.prepare("SELECT status, reason FROM payment_requests WHERE id = ?").get(created.id))
      .toEqual({ status: "failed", reason: "expired" });
  });

  test("is not cancelled when Horizon cannot be checked", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const response = await cancel(created.id);
    expect(response.status).toBe(502);
    expect(response.body.error.code).toBe("HORIZON_UNAVAILABLE");
    expect(db.prepare("SELECT status FROM payment_requests WHERE id = ?").get(created.id).status).toBe("pending");
  });

  test("a payment sent after cancelling does not complete the request", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([]));
    await cancel(created.id);
    fetchSpy.mockResolvedValue(horizonPage([horizonPayment({ memo: created.memo, amount: created.amount })]));
    fetchSpy.mockClear();
    const response = await check(created.id);
    expect(response.body.data).toMatchObject({ status: "failed", reason: "cancelled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("after cancelling, the student can create a new request for the invoice", async () => {
    const invoiceId = addInvoice(100);
    const first = await createPending(invoiceId);
    fetchSpy.mockResolvedValue(horizonPage([]));
    await cancel(first.id);
    const second = await postPayment(invoiceId);
    expect(second.status).toBe(201);
    expect(second.body.data.id).not.toBe(first.id);
  });

  test("students can only cancel their own requests; admins can cancel any; instructors cannot", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([]));
    const other = await cancel(created.id, await login(otherStudent.email));
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe("PAYMENT_NOT_FOUND");
    expect((await cancel(created.id, await login("instructor@pluglytics.local"))).status).toBe(403);
    expect((await request(app).post(`/api/v1/payments/${created.id}/cancel`)).status).toBe(401);

    const admin = await cancel(created.id, await login("admin@pluglytics.local"));
    expect(admin.status).toBe(200);
    expect(admin.body.data.reason).toBe("cancelled");
    expect((await cancel("pay_DOESNOTEXIST00")).status).toBe(404);
  });

  test("needs the sandbox settings to check Horizon before cancelling", async () => {
    const created = await createPending();
    delete process.env.SANDBOX_MERCHANT_PUBLIC_KEY;
    const response = await cancel(created.id);
    expect(response.status).toBe(503);
    expect(db.prepare("SELECT status FROM payment_requests WHERE id = ?").get(created.id).status).toBe("pending");
  });
});

describe("GET /api/v1/payments/:id", () => {
  test("stays pending while no payment has arrived", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([]));
    const response = await check(created.id);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: created.id, status: "pending", reason: null, transactionHash: null, invoiceAmount: "100.00" });
    expect(fetchSpy.mock.calls[0][0]).toContain(`/accounts/${MERCHANT}/payments`);
  });

  test("marks the request completed with the transaction hash when the exact amount arrives", async () => {
    const created = await createPending();
    const paid = horizonPayment({ memo: created.memo, amount: created.amount });
    fetchSpy.mockResolvedValue(horizonPage([paid]));
    const response = await check(created.id);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      status: "completed",
      reason: null,
      transactionHash: paid.transaction_hash,
      amountReceived: "250.0000000",
      paidAt: paid.created_at,
      ledger: paid.transaction.ledger,
    });
    const row = db.prepare("SELECT status, tx_hash, completed_at FROM payment_requests WHERE id = ?").get(created.id);
    expect(row).toEqual({ status: "completed", tx_hash: paid.transaction_hash, completed_at: paid.created_at });
  });

  test("an overpayment still completes the request", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([horizonPayment({ memo: created.memo, amount: "300.0000000" })]));
    const response = await check(created.id);
    expect(response.body.data).toMatchObject({ status: "completed", amountReceived: "300.0000000" });
  });

  test("an underpayment fails the request with reason underpaid and keeps the transaction", async () => {
    const created = await createPending();
    const partial = horizonPayment({ memo: created.memo, amount: "249.9999999" });
    fetchSpy.mockResolvedValue(horizonPage([partial]));
    const response = await check(created.id);
    expect(response.body.data).toMatchObject({
      status: "failed", reason: "underpaid", amountReceived: "249.9999999", transactionHash: partial.transaction_hash, paidAt: null,
    });
  });

  test("a different asset fails the request with reason wrong_asset", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([horizonPayment({ memo: created.memo, asset: "USDC" })]));
    const response = await check(created.id);
    expect(response.body.data).toMatchObject({ status: "failed", reason: "wrong_asset" });
  });

  test("ignores payments with the wrong destination, memo, or a failed transaction", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([
      horizonPayment({ memo: created.memo, to: OTHER_ACCOUNT }),
      horizonPayment({ memo: "PL-SOMEONE1" }),
      horizonPayment({ memo: created.memo, successful: false }),
    ]));
    const response = await check(created.id);
    expect(response.body.data.status).toBe("pending");
  });

  test("an expired request with no payment fails with reason expired", async () => {
    const created = await createPending();
    expire(created.id);
    fetchSpy.mockResolvedValue(horizonPage([]));
    const response = await check(created.id);
    expect(response.body.data).toMatchObject({ status: "failed", reason: "expired", transactionHash: null });
  });

  test("a payment that arrives after expiry does not complete the request", async () => {
    const created = await createPending();
    expire(created.id);
    fetchSpy.mockResolvedValue(horizonPage([
      horizonPayment({ memo: created.memo, amount: created.amount, createdAt: "2026-01-01T10:45:00.000Z" }),
    ]));
    const response = await check(created.id);
    expect(response.body.data).toMatchObject({ status: "failed", reason: "expired", transactionHash: null });
  });

  test("a payment made before expiry still counts when checked after expiry", async () => {
    const created = await createPending();
    expire(created.id);
    const onTime = horizonPayment({ memo: created.memo, amount: created.amount, createdAt: "2026-01-01T10:20:00.000Z" });
    fetchSpy.mockResolvedValue(horizonPage([onTime]));
    const response = await check(created.id);
    expect(response.body.data).toMatchObject({ status: "completed", transactionHash: onTime.transaction_hash });
  });

  test("final requests are returned without asking Horizon again", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([horizonPayment({ memo: created.memo, amount: created.amount })]));
    await check(created.id);
    fetchSpy.mockClear();
    const again = await check(created.id);
    expect(again.body.data.status).toBe("completed");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("returns 502 and stays pending when Horizon fails", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    const failed = await check(created.id);
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("HORIZON_UNAVAILABLE");

    fetchSpy.mockRejectedValue(new Error("network down"));
    const down = await check(created.id);
    expect(down.status).toBe(502);
    expect(db.prepare("SELECT status FROM payment_requests WHERE id = ?").get(created.id).status).toBe("pending");
  });

  test("returns 409 when the matching transaction is already linked to another request", async () => {
    const first = await createPending();
    const paid = horizonPayment({ memo: first.memo, amount: first.amount });
    fetchSpy.mockResolvedValue(horizonPage([paid]));
    expect((await check(first.id)).body.data.status).toBe("completed");

    const second = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([{ ...paid, transaction: { ...paid.transaction, memo: second.memo } }]));
    const response = await check(second.id);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("TRANSACTION_ALREADY_LINKED");
  });

  test("returns 503 when the sandbox settings are missing for a pending request", async () => {
    const created = await createPending();
    delete process.env.SANDBOX_MERCHANT_PUBLIC_KEY;
    const response = await check(created.id);
    expect(response.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("students only see their own requests; admins can see any; instructors cannot", async () => {
    const created = await createPending();
    fetchSpy.mockResolvedValue(horizonPage([]));

    const other = await check(created.id, await login(otherStudent.email));
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe("PAYMENT_NOT_FOUND");

    const admin = await check(created.id, await login("admin@pluglytics.local"));
    expect(admin.status).toBe(200);

    const instructor = await check(created.id, await login("instructor@pluglytics.local"));
    expect(instructor.status).toBe(403);

    expect((await check("pay_DOESNOTEXIST00")).status).toBe(404);
    expect((await request(app).get(`/api/v1/payments/${created.id}`)).status).toBe(401);
  });
});
