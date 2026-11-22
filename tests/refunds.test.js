// The signer is the only code that sends money (and loads the Stellar SDK, which
// Jest cannot load). Here it is replaced by a fake; its real behaviour was checked
// against testnet separately.
jest.mock("../src/stellarRefundSigner", () => {
  const actual = jest.requireActual("../src/stellarRefundSigner");
  return { ...actual, sendRefundPayment: jest.fn() };
});

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const signer = require("../src/stellarRefundSigner");
const { canReceiveAsset } = require("../src/stellarHorizon");

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const PAYER = "GCUSTOMERPAYERACCOUNTFORTESTSONLY234567ABCDEFGHIJKLMNOPQ";
const EXCHANGE = "GEXCHANGESHAREDACCOUNTFORREFUNDTESTS234567ABCDEFGHIJKLMN";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const FAKE_SECRET = "S" + "A".repeat(55);
const VARS = [
  "STELLAR_ENV", "SANDBOX_MERCHANT_PUBLIC_KEY", "SANDBOX_MERCHANT_SECRET_KEY", "SANDBOX_WEBHOOK_SIGNING_SECRET",
  "PRODUCTION_MERCHANT_PUBLIC_KEY", "PRODUCTION_MERCHANT_SECRET_KEY", "PRODUCTION_WEBHOOK_SIGNING_SECRET",
  "REFUND_WINDOW_DAYS", "REFUND_APPROVAL_THRESHOLD_XLM", "REFUND_APPROVAL_THRESHOLD_USDC", "REFUND_ISSUING_ENABLED",
];
const savedEnv = {};
function useSandbox(extra = {}) {
  for (const name of VARS) delete process.env[name];
  Object.assign(process.env, {
    STELLAR_ENV: "sandbox", SANDBOX_MERCHANT_PUBLIC_KEY: MERCHANT, SANDBOX_MERCHANT_SECRET_KEY: FAKE_SECRET,
    SANDBOX_WEBHOOK_SIGNING_SECRET: "test-only-server-key-refunds", REFUND_WINDOW_DAYS: "30",
    REFUND_APPROVAL_THRESHOLD_XLM: "100", REFUND_ISSUING_ENABLED: "true", ...extra,
  });
}

const demoStudent = db.prepare(
  "SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
).get();
const anyTerm = db.prepare("SELECT id FROM terms ORDER BY id LIMIT 1").get();
const school = db.prepare("SELECT id FROM schools ORDER BY id LIMIT 1").get();
let adminToken;
let secondAdminToken;
let secondAdminId;
const invoiceIds = [];
let n = 0;

async function login(email) {
  return (await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" })).body.data.token;
}

// A payment request where money arrived (completed by default).
function addPayment({ status = "completed", reason = null, received = "250.0000000", source = PAYER, paidDaysAgo = 1, txHash } = {}) {
  n += 1;
  const invoiceId = Number(db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, issued_at, due_at) VALUES (?, ?, 100, '2026-11-01T09:00:00Z', '2026-11-28T23:59:00Z')"
  ).run(demoStudent.id, anyTerm.id).lastInsertRowid);
  invoiceIds.push(invoiceId);
  const id = `pay_REFTEST${String(n).padStart(8, "0")}`;
  const paidAt = new Date(Date.now() - paidDaysAgo * 86400000).toISOString();
  const hasTx = txHash !== null;
  db.prepare(`
    INSERT INTO payment_requests (id, invoice_id, amount, asset, memo, destination, status, reason, tx_hash, amount_received,
      ledger, source_account, quoted_rate, rate_source, invoice_currency, invoice_amount, created_at, expires_at, completed_at)
    VALUES (?, ?, '250.0000000', 'XLM', ?, ?, ?, ?, ?, ?, ?, ?, '2.5000000', 'manual', 'USD', '100.00', ?, ?, ?)
  `).run(id, invoiceId, `PL-REF${String(n).padStart(5, "0")}`, MERCHANT, status, reason,
    hasTx ? (txHash || crypto.randomBytes(32).toString("hex")) : null, hasTx ? received : null, hasTx ? 777 : null,
    hasTx ? source : null, new Date(Date.parse(paidAt) - 60000).toISOString(), new Date(Date.parse(paidAt) + 1800000).toISOString(),
    status === "completed" ? paidAt : null);
  return id;
}

const api = (method, path, token = adminToken) => request(app)[method](`/api/v1/refunds${path}`).set("Authorization", `Bearer ${token}`);
const requestRefund = (body, token) => api("post", "", token).send({ reason: "overpaid", note: "Paid 10 XLM too much", ...body });
const stored = (id) => db.prepare("SELECT * FROM stellar_refunds WHERE id = ?").get(id);

// Horizon: which accounts exist, and which transactions have landed.
const accounts = new Map();
const landed = new Map();
function mockHorizon() {
  return jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    const u = String(url);
    const acct = u.match(/\/accounts\/(G[A-Z2-7]{55})$/);
    if (acct) {
      const found = accounts.get(acct[1]);
      return found ? { ok: true, status: 200, json: async () => found } : { ok: false, status: 404, json: async () => ({}) };
    }
    const tx = u.match(/\/transactions\/([0-9a-f]{64})(\/payments)?/);
    if (tx) {
      const found = landed.get(tx[1]);
      if (!found) return { ok: false, status: 404, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => (tx[2] ? { _embedded: { records: [] } } : found) };
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
}
function signerSucceeds(hash = crypto.randomBytes(32).toString("hex")) {
  signer.sendRefundPayment.mockImplementation(async ({ onSigned }) => {
    await onSigned({ hash, expiresAt: new Date(Date.now() + 180000).toISOString() });
    return { hash, ledger: 9001 };
  });
  return hash;
}

async function approvedRefund(body = {}) {
  const refund = (await requestRefund({ paymentId: addPayment(), amount: "10.0000000", ...body })).body.data;
  expect((await api("post", `/${refund.id}/approve`).send({})).body.data.status).toBe("approved");
  return refund;
}

beforeAll(async () => {
  for (const name of VARS) savedEnv[name] = process.env[name];
  useSandbox();
  adminToken = await login("admin@pluglytics.local");
  secondAdminId = Number(db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?, ?, 'admin', 'Second Admin')")
    .run("second.admin@pluglytics.local", bcrypt.hashSync("Demo123!", 4)).lastInsertRowid);
  secondAdminToken = await login("second.admin@pluglytics.local");
  accounts.set(PAYER, { id: PAYER, balances: [{ asset_type: "native", balance: "100.0000000" }] });
  accounts.set(EXCHANGE, { id: EXCHANGE, balances: [{ asset_type: "native", balance: "5.0000000" }] });
});
beforeEach(() => {
  useSandbox();
  signer.sendRefundPayment.mockReset();
  mockHorizon();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  const marks = invoiceIds.map(() => "?").join(",");
  const payIds = db.prepare(`SELECT id FROM payment_requests WHERE invoice_id IN (${marks})`).all(...invoiceIds).map((r) => r.id);
  if (payIds.length) {
    const p = payIds.map(() => "?").join(",");
    db.prepare(`DELETE FROM webhook_events WHERE payment_id IN (${p})`).run(...payIds);
    db.prepare(`DELETE FROM stellar_refunds WHERE payment_id IN (${p})`).run(...payIds);
  }
  db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks})`).run(...invoiceIds);
  db.prepare(`DELETE FROM invoices WHERE id IN (${marks})`).run(...invoiceIds);
  db.prepare("DELETE FROM users WHERE id = ?").run(secondAdminId);
  for (const name of VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("requesting a refund", () => {
  test("goes to the original payer by default, with its own RF- memo", async () => {
    const paymentId = addPayment();
    const response = await requestRefund({ paymentId, amount: "10" });
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      paymentId, amount: "10.0000000", asset: "XLM", reason: "overpaid", status: "requested",
      destination: PAYER, destinationMemo: null, destinationSource: "original_payer",
      needsSecondApproval: false, requestedBy: "admin@pluglytics.local", transactionHash: null,
    });
    expect(response.body.data.id).toMatch(/^ref_[0-9A-Z]{16}$/);
    expect(response.body.data.paymentMemo).toMatch(/^RF-[0-9A-Z]{8}$/);
  });

  test("can go to a destination and memo given in writing (exchanges, anchors)", async () => {
    const response = await requestRefund({ paymentId: addPayment(), amount: "5", destination: EXCHANGE, destinationMemo: "EXCH-USER-42" });
    expect(response.body.data).toMatchObject({ destination: EXCHANGE, destinationMemo: "EXCH-USER-42", destinationSource: "written", paymentMemo: "EXCH-USER-42" });
  });

  test("never refunds more than arrived, counting refunds still being approved", async () => {
    const paymentId = addPayment({ received: "250.0000000" });
    expect((await requestRefund({ paymentId, amount: "200" })).status).toBe(201);
    const tooMuch = await requestRefund({ paymentId, amount: "50.0000001" });
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatchObject({ code: "REFUND_AMOUNT_TOO_HIGH", details: { alreadyRefundedOrRequested: "200.0000000" } });
    expect((await requestRefund({ paymentId, amount: "50" })).status).toBe(201);
  });

  test("a rejected refund frees its amount again", async () => {
    const paymentId = addPayment({ received: "20.0000000" });
    const first = (await requestRefund({ paymentId, amount: "20" })).body.data;
    expect((await requestRefund({ paymentId, amount: "1" })).status).toBe(409);
    await api("post", `/${first.id}/reject`).send({ note: "Customer withdrew the request" });
    expect((await requestRefund({ paymentId, amount: "20" })).status).toBe(201);
  });

  test("can refund what arrived for an underpaid request", async () => {
    const paymentId = addPayment({ status: "failed", reason: "underpaid", received: "200.0000000" });
    const response = await requestRefund({ paymentId, amount: "200", reason: "underpaid" });
    expect(response.status).toBe(201);
  });

  test.each([
    ["an expired request with nothing received", { status: "failed", reason: "expired", txHash: null }, /nothing to refund/],
    ["a wrong-asset payment (not supported yet)", { status: "failed", reason: "wrong_asset" }, /not supported yet/],
  ])("refuses %s", async (_, payment, message) => {
    const response = await requestRefund({ paymentId: addPayment(payment), amount: "1" });
    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({ code: "PAYMENT_NOT_REFUNDABLE", message: expect.stringMatching(message) });
  });

  test("enforces the refund window for customer requests", async () => {
    const recent = await requestRefund({ paymentId: addPayment({ paidDaysAgo: 29 }), amount: "1", reason: "customer_request" });
    expect(recent.status).toBe(201);
    const late = await requestRefund({ paymentId: addPayment({ paidDaysAgo: 31 }), amount: "1", reason: "customer_request" });
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe("REFUND_WINDOW_CLOSED");
    // Operational refunds have no window.
    expect((await requestRefund({ paymentId: addPayment({ paidDaysAgo: 400 }), amount: "1", reason: "duplicate" })).status).toBe(201);
  });

  test("refuses customer refunds while REFUND_WINDOW_DAYS is not decided", async () => {
    delete process.env.REFUND_WINDOW_DAYS;
    const response = await requestRefund({ paymentId: addPayment(), amount: "1", reason: "service_issue" });
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("REFUND_WINDOW_NOT_SET");
    expect((await requestRefund({ paymentId: addPayment(), amount: "1", reason: "overpaid" })).status).toBe(201);
  });

  test("needs a destination in writing when the payer is not known", async () => {
    const response = await requestRefund({ paymentId: addPayment({ source: null }), amount: "1" });
    expect(response.status).toBe(400);
    expect(response.body.error.details.fieldErrors.destination).toBeDefined();
  });

  test.each([
    ["8 decimals", { amount: "1.12345678" }],
    ["a zero amount", { amount: "0" }],
    ["an unknown reason", { reason: "changed_mind" }],
    ["a missing note", { note: "" }],
    ["a memo without a destination", { destinationMemo: "X" }],
    ["a bad destination", { destination: "not-a-key" }],
    ["a memo over 28 characters", { destination: EXCHANGE, destinationMemo: "x".repeat(29) }],
    ["an unknown field", { txHash: "a" }],
  ])("rejects %s", async (_, body) => {
    const response = await requestRefund({ paymentId: addPayment(), amount: "1", ...body });
    expect(response.status).toBe(400);
  });

  test("returns 404 for an unknown payment", async () => {
    expect((await requestRefund({ paymentId: "pay_NOPE", amount: "1" })).body.error.code).toBe("PAYMENT_NOT_FOUND");
  });
});

describe("approving and rejecting", () => {
  test("at or below the threshold, one approval is enough", async () => {
    const refund = (await requestRefund({ paymentId: addPayment(), amount: "100" })).body.data;
    expect(refund.needsSecondApproval).toBe(false);
    const approved = (await api("post", `/${refund.id}/approve`).send({})).body.data;
    expect(approved).toMatchObject({ status: "approved", approvedBy: "admin@pluglytics.local" });
  });

  test("above the threshold, a second admin (not the requester or first approver) must approve", async () => {
    const refund = (await requestRefund({ paymentId: addPayment(), amount: "100.0000001" })).body.data;
    expect(refund.needsSecondApproval).toBe(true);

    const first = (await api("post", `/${refund.id}/approve`).send({})).body.data;
    expect(first).toMatchObject({ status: "requested", approvedBy: "admin@pluglytics.local", secondApprovedBy: null });
    const same = await api("post", `/${refund.id}/approve`).send({});
    expect(same.status).toBe(403);
    expect(same.body.error.code).toBe("SECOND_APPROVER_REQUIRED");
    expect((await api("post", `/${refund.id}/issue`)).body.error.message).toMatch(/second admin/);

    const second = (await api("post", `/${refund.id}/approve`, secondAdminToken).send({})).body.data;
    expect(second).toMatchObject({ status: "approved", secondApprovedBy: "second.admin@pluglytics.local" });
  });

  test("the requester cannot be the second approver either", async () => {
    const refund = (await requestRefund({ paymentId: addPayment(), amount: "150" }, secondAdminToken)).body.data;
    await api("post", `/${refund.id}/approve`).send({});
    expect((await api("post", `/${refund.id}/approve`, secondAdminToken).send({})).status).toBe(403);
  });

  test("with no threshold decided yet, every refund needs two admins", async () => {
    delete process.env.REFUND_APPROVAL_THRESHOLD_XLM;
    const refund = (await requestRefund({ paymentId: addPayment(), amount: "0.0000001" })).body.data;
    expect(refund.needsSecondApproval).toBe(true);
  });

  test("a rejected refund needs a reason, and cannot be approved or issued", async () => {
    const refund = (await requestRefund({ paymentId: addPayment(), amount: "1" })).body.data;
    expect((await api("post", `/${refund.id}/reject`).send({})).status).toBe(400);
    const rejected = (await api("post", `/${refund.id}/reject`).send({ note: "Not eligible" })).body.data;
    expect(rejected).toMatchObject({ status: "rejected", rejectedBy: "admin@pluglytics.local", rejectionNote: "Not eligible" });
    expect((await api("post", `/${refund.id}/approve`).send({})).body.error.code).toBe("REFUND_NOT_PENDING_APPROVAL");
    expect((await api("post", `/${refund.id}/issue`)).body.error.code).toBe("REFUND_NOT_APPROVED");
  });
});

describe("issuing a refund (a new testnet payment)", () => {
  test("sends a payment from the merchant to the payer, records it, and fires refund.issued", async () => {
    const endpoint = (await request(app).post("/api/v1/webhooks").set("Authorization", `Bearer ${adminToken}`)
      .send({ schoolId: school.id, url: "https://lms.example.edu/hooks", events: ["refund.issued"] })).body.data;
    try {
      const refund = await approvedRefund();
      const hash = signerSucceeds();
      const response = await api("post", `/${refund.id}/issue`);

      expect(response.status).toBe(200);
      expect(response.body.data).toMatchObject({ status: "issued", transactionHash: hash, ledger: 9001, issuedAt: expect.any(String), sendInProgress: false });
      const call = signer.sendRefundPayment.mock.calls[0][0];
      expect(call).toMatchObject({
        destination: PAYER, asset: "XLM", amount: "10.0000000", memo: refund.paymentMemo,
        merchantPublicKey: MERCHANT, networkPassphrase: signer.TESTNET_PASSPHRASE,
      });

      const event = db.prepare("SELECT * FROM webhook_events WHERE type = 'refund.issued' AND payment_id = ?").get(refund.paymentId);
      expect(JSON.parse(event.body).data).toMatchObject({
        refundId: refund.id, paymentId: refund.paymentId, amount: "10.0000000", destination: PAYER, reason: "overpaid",
        transactionHash: hash, originalTransactionHash: response.body.data.originalTransactionHash,
      });
      expect((await api("post", `/${refund.id}/issue`)).body.error.code).toBe("REFUND_ALREADY_ISSUED");
      expect(signer.sendRefundPayment).toHaveBeenCalledTimes(1);
    } finally {
      db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(endpoint.id);
    }
  });

  test("is refused when STELLAR_ENV is production, without sending anything", async () => {
    const refund = await approvedRefund();
    useSandbox({
      STELLAR_ENV: "production", PRODUCTION_MERCHANT_PUBLIC_KEY: MERCHANT,
      PRODUCTION_MERCHANT_SECRET_KEY: FAKE_SECRET, PRODUCTION_WEBHOOK_SIGNING_SECRET: "test-only-server-key-refunds",
    });
    const response = await api("post", `/${refund.id}/issue`);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("REFUNDS_TESTNET_ONLY");
    expect(signer.sendRefundPayment).not.toHaveBeenCalled();
    expect(stored(refund.id).status).toBe("approved");
  });

  test("checks that the destination exists before sending", async () => {
    const missing = "GNOSUCHACCOUNTONTESTNETFORREFUNDS234567ABCDEFGHIJKLMNOPQ";
    const refund = await approvedRefund({ destination: missing });
    const response = await api("post", `/${refund.id}/issue`);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe("DESTINATION_NOT_FOUND");
    expect(signer.sendRefundPayment).not.toHaveBeenCalled();
  });

  test("a payment Horizon rejected stays approved and can be tried again", async () => {
    const refund = await approvedRefund();
    signer.sendRefundPayment.mockRejectedValue(new signer.RefundSendError("Horizon rejected the refund payment (tx_failed, op_underfunded)", { definite: true, codes: { transaction: "tx_failed", operations: ["op_underfunded"] } }));
    const response = await api("post", `/${refund.id}/issue`);
    expect(response.status).toBe(502);
    expect(response.body.error).toMatchObject({ code: "REFUND_SEND_FAILED", details: { codes: { operations: ["op_underfunded"] } } });
    expect(stored(refund.id)).toMatchObject({ status: "approved", pending_tx_hash: null, last_error: expect.stringMatching(/op_underfunded/) });

    const hash = signerSucceeds();
    expect((await api("post", `/${refund.id}/issue`)).body.data).toMatchObject({ status: "issued", transactionHash: hash });
  });

  test("an unclear result is checked on Horizon before anything is sent again", async () => {
    const refund = await approvedRefund();
    const hash = crypto.randomBytes(32).toString("hex");
    signer.sendRefundPayment.mockImplementation(async ({ onSigned }) => {
      await onSigned({ hash, expiresAt: new Date(Date.now() + 180000).toISOString() });
      throw new signer.RefundSendError("The refund payment's result is unknown: timeout", { definite: false });
    });
    const unclear = await api("post", `/${refund.id}/issue`);
    expect(unclear.status).toBe(502);
    expect(unclear.body.error).toMatchObject({ code: "REFUND_SEND_UNCONFIRMED", details: { transactionHash: hash } });
    expect(stored(refund.id).pending_tx_hash).toBe(hash);

    // Not on Horizon yet, and not expired: wait. Nothing is sent again.
    signer.sendRefundPayment.mockClear();
    const wait = await api("post", `/${refund.id}/issue`);
    expect(wait.body.error.code).toBe("REFUND_SEND_IN_PROGRESS");
    expect(signer.sendRefundPayment).not.toHaveBeenCalled();

    // It landed after all: recorded as issued, still without sending again.
    landed.set(hash, { hash, successful: true, ledger: 9100, created_at: "2026-11-22T05:00:00Z" });
    const done = await api("post", `/${refund.id}/issue`);
    expect(done.body.data).toMatchObject({ status: "issued", transactionHash: hash, ledger: 9100 });
    expect(signer.sendRefundPayment).not.toHaveBeenCalled();
  });

  test("an unclear payment that expired without landing is safe to send again", async () => {
    const refund = await approvedRefund();
    db.prepare("UPDATE stellar_refunds SET pending_tx_hash = ?, pending_tx_expires_at = ? WHERE id = ?")
      .run(crypto.randomBytes(32).toString("hex"), new Date(Date.now() - 1000).toISOString(), refund.id);
    const hash = signerSucceeds();
    expect((await api("post", `/${refund.id}/issue`)).body.data).toMatchObject({ status: "issued", transactionHash: hash });
    expect(signer.sendRefundPayment).toHaveBeenCalledTimes(1);
  });

  test("refunds to a written destination use its memo", async () => {
    const refund = await approvedRefund({ destination: EXCHANGE, destinationMemo: "EXCH-USER-42" });
    signerSucceeds();
    await api("post", `/${refund.id}/issue`);
    expect(signer.sendRefundPayment.mock.calls[0][0]).toMatchObject({ destination: EXCHANGE, memo: "EXCH-USER-42" });
  });
});

describe("the REFUND_ISSUING_ENABLED switch", () => {
  test.each([
    ["not set (the default)", undefined],
    ["false", "false"],
  ])("when it is %s, issuing is refused and nothing is sent", async (_, value) => {
    const refund = await approvedRefund();
    if (value === undefined) delete process.env.REFUND_ISSUING_ENABLED;
    else process.env.REFUND_ISSUING_ENABLED = value;
    signerSucceeds();
    const response = await api("post", `/${refund.id}/issue`);
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({ code: "REFUND_ISSUING_DISABLED", message: expect.stringMatching(/REFUND_ISSUING_ENABLED/) });
    expect(signer.sendRefundPayment).not.toHaveBeenCalled();
    expect(stored(refund.id)).toMatchObject({ status: "approved", tx_hash: null, pending_tx_hash: null });
  });

  test("requesting, approving and rejecting still work while it is off", async () => {
    process.env.REFUND_ISSUING_ENABLED = "false";
    const first = (await requestRefund({ paymentId: addPayment(), amount: "2" })).body.data;
    expect((await api("post", `/${first.id}/approve`).send({})).body.data.status).toBe("approved");
    const second = (await requestRefund({ paymentId: addPayment(), amount: "2" })).body.data;
    expect((await api("post", `/${second.id}/reject`).send({ note: "Not eligible" })).body.data.status).toBe("rejected");
  });

  test("the list tells the dashboard whether issuing is on", async () => {
    expect((await api("get", "")).body.meta.issuingEnabled).toBe(true);
    process.env.REFUND_ISSUING_ENABLED = "false";
    expect((await api("get", "")).body.meta.issuingEnabled).toBe(false);
  });

  test("an invalid value is refused as an invalid setting, not treated as on", async () => {
    const refund = await approvedRefund();
    process.env.REFUND_ISSUING_ENABLED = "yes";
    const response = await api("post", `/${refund.id}/issue`);
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("PAYMENT_POLICY_INVALID");
    expect(signer.sendRefundPayment).not.toHaveBeenCalled();
  });
});

describe("lists and access", () => {
  test("lists refunds for a payment, and gets one", async () => {
    const paymentId = addPayment();
    const created = (await requestRefund({ paymentId, amount: "3" })).body.data;
    const list = (await api("get", `?paymentId=${paymentId}`)).body;
    expect(list.data.map((r) => r.id)).toEqual([created.id]);
    expect((await api("get", `/${created.id}`)).body.data.id).toBe(created.id);
    expect((await api("get", "/ref_NOPE")).body.error.code).toBe("REFUND_NOT_FOUND");
  });

  test("is admin-only, and not available to customer API keys", async () => {
    const studentToken = await login("student@pluglytics.local");
    expect((await api("get", "", studentToken)).status).toBe(403);
    expect((await request(app).get("/api/v1/refunds")).status).toBe(401);
    const key = (await request(app).post("/api/v1/api-keys").set("Authorization", `Bearer ${adminToken}`).send({ schoolId: school.id, name: "Refund test" })).body.data;
    expect((await request(app).get("/api/v1/refunds").set("X-PlugLytics-Api-Key", key.key)).body.error.code).toBe("API_KEY_READ_ONLY");
    db.prepare("DELETE FROM api_keys WHERE id = ?").run(key.id);
  });

  test("checks trustlines for non-native assets", () => {
    expect(canReceiveAsset({ balances: [{ asset_type: "native" }] }, "XLM", null)).toBe(true);
    expect(canReceiveAsset({ balances: [{ asset_type: "native" }] }, "USDC", USDC_ISSUER)).toBe(false);
    expect(canReceiveAsset({ balances: [{ asset_code: "USDC", asset_issuer: USDC_ISSUER }] }, "USDC", USDC_ISSUER)).toBe(true);
    expect(canReceiveAsset({ balances: [{ asset_code: "USDC", asset_issuer: PAYER }] }, "USDC", USDC_ISSUER)).toBe(false);
  });
});
