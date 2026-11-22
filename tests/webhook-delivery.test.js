const http = require("http");
const crypto = require("crypto");
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { deliverDue, RETRY_DELAYS_MS, MAX_ATTEMPTS } = require("../src/webhookDelivery");

// Captured before any test mocks global.fetch for Horizon, so deliveries always
// reach the fake receiver for real.
const realFetch = global.fetch;

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const PAYER = "GCUSTOMERPAYERACCOUNTFORTESTSONLY234567ABCDEFGHIJKLMNOPQ";
const FAKE_SECRET = "S" + "A".repeat(55);
const SERVER_KEY = "test-only-server-key-for-webhook-delivery";
const STELLAR_VARS = ["STELLAR_ENV", "SANDBOX_MERCHANT_PUBLIC_KEY", "SANDBOX_MERCHANT_SECRET_KEY", "SANDBOX_WEBHOOK_SIGNING_SECRET"];
const savedEnv = {};

// The receiver-side check from docs/stellar/webhooks.md ("Verifying the signature").
function isValidSignature(rawBody, timestamp, signatureHeader, secret, nowSeconds) {
  if (!rawBody || !timestamp || !signatureHeader || !secret) return false;
  const age = Math.abs(nowSeconds - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = Buffer.from(crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex"), "hex");
  return signatureHeader.split(",").some((part) => {
    const value = part.trim();
    if (!value.startsWith("v1=")) return false;
    const received = Buffer.from(value.slice(3), "hex");
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  });
}

// A fake receiver: records every request and answers with the next planned status.
const receiver = { requests: [], plan: [], server: null, url: null };
function startReceiver() {
  return new Promise((resolve) => {
    receiver.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        receiver.requests.push({ path: req.url, headers: req.headers, body });
        const status = receiver.plan.length ? receiver.plan.shift() : 200;
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ received: status < 300 }));
      });
    });
    receiver.server.listen(0, () => {
      receiver.url = `http://localhost:${receiver.server.address().port}/hooks`;
      resolve();
    });
  });
}

const school = db.prepare("SELECT id FROM schools ORDER BY id LIMIT 1").get();
const demoStudent = db.prepare(
  "SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
).get();
const anyTerm = db.prepare("SELECT id FROM terms ORDER BY id LIMIT 1").get();
let adminToken;
let studentToken;
const invoiceIds = [];
const endpointIds = [];
const extraSchoolIds = [];

async function login(email) {
  return (await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" })).body.data.token;
}
async function registerEndpoint(fields = {}) {
  const response = await request(app).post("/api/v1/webhooks").set("Authorization", `Bearer ${adminToken}`)
    .send({ schoolId: school.id, url: receiver.url, ...fields });
  expect(response.status).toBe(201);
  endpointIds.push(response.body.data.id);
  return response.body.data;
}
async function createRequest() {
  const invoiceId = Number(db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, issued_at, due_at) VALUES (?, ?, 100, '2026-11-01T09:00:00Z', '2026-11-28T23:59:00Z')"
  ).run(demoStudent.id, anyTerm.id).lastInsertRowid);
  invoiceIds.push(invoiceId);
  const response = await request(app).post("/api/v1/payments").set("Authorization", `Bearer ${studentToken}`).send({ invoiceId });
  expect(response.status).toBe(201);
  return response.body.data;
}
function horizonPage(records) {
  return { ok: true, status: 200, json: async () => ({ _embedded: { records }, _links: {} }) };
}
function horizonPayment(memo, amount, createdAt = new Date().toISOString()) {
  return {
    type: "payment", to: MERCHANT, from: PAYER, amount, asset_type: "native",
    transaction_hash: crypto.randomBytes(32).toString("hex"), transaction_successful: true, created_at: createdAt,
    transaction: { memo, memo_type: "text", successful: true, ledger: 4242, created_at: createdAt },
  };
}
const deliveriesFor = (endpointId) =>
  db.prepare("SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY id").all(endpointId);
const run = (at) => deliverDue({ fetchImpl: realFetch, now: () => (at ? new Date(at) : new Date()) });
const bodyOf = (req) => JSON.parse(req.body);

beforeAll(async () => {
  for (const name of STELLAR_VARS) savedEnv[name] = process.env[name];
  for (const name of STELLAR_VARS) delete process.env[name];
  Object.assign(process.env, {
    STELLAR_ENV: "sandbox",
    SANDBOX_MERCHANT_PUBLIC_KEY: MERCHANT,
    SANDBOX_MERCHANT_SECRET_KEY: FAKE_SECRET,
    SANDBOX_WEBHOOK_SIGNING_SECRET: SERVER_KEY,
  });
  await startReceiver();
  adminToken = await login("admin@pluglytics.local");
  studentToken = await login("student@pluglytics.local");
});

beforeEach(() => {
  receiver.requests = [];
  receiver.plan = [];
  // Each test starts with no other endpoints, so only its own receive events.
  if (endpointIds.length) db.prepare(`DELETE FROM webhook_endpoints WHERE id IN (${endpointIds.map(() => "?").join(",")})`).run(...endpointIds);
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  if (endpointIds.length) db.prepare(`DELETE FROM webhook_endpoints WHERE id IN (${endpointIds.map(() => "?").join(",")})`).run(...endpointIds);
  if (invoiceIds.length) {
    const marks = invoiceIds.map(() => "?").join(",");
    const payIds = db.prepare(`SELECT id FROM payment_requests WHERE invoice_id IN (${marks})`).all(...invoiceIds).map((r) => r.id);
    if (payIds.length) db.prepare(`DELETE FROM webhook_events WHERE payment_id IN (${payIds.map(() => "?").join(",")})`).run(...payIds);
    db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks})`).run(...invoiceIds);
    db.prepare(`DELETE FROM invoices WHERE id IN (${marks})`).run(...invoiceIds);
  }
  for (const id of extraSchoolIds) db.prepare("DELETE FROM schools WHERE id = ?").run(id);
  await new Promise((resolve) => receiver.server.close(resolve));
  for (const name of STELLAR_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("sending signed webhooks", () => {
  test("payment.pending is stored in the outbox and delivered, signed with the endpoint's own secret", async () => {
    const endpoint = await registerEndpoint();
    const payment = await createRequest();

    // Nothing is sent until the sender runs (the server runs it every 15 seconds).
    expect(receiver.requests).toHaveLength(0);
    expect(deliveriesFor(endpoint.id)).toMatchObject([{ status: "pending", attempts: 0 }]);

    expect(await run()).toMatchObject({ sent: 1, delivered: 1 });
    expect(receiver.requests).toHaveLength(1);
    const req = receiver.requests[0];
    const body = bodyOf(req);
    expect(req.headers["content-type"]).toContain("application/json");
    expect(req.headers["x-pluglytics-event"]).toBe("payment.pending");
    expect(req.headers["x-pluglytics-event-id"]).toBe(body.id);
    expect(req.headers["x-pluglytics-webhook-id"]).toBe(endpoint.id);
    expect(isValidSignature(req.body, req.headers["x-pluglytics-timestamp"], req.headers["x-pluglytics-signature"],
      endpoint.secret, Math.floor(Date.now() / 1000))).toBe(true);
    expect(body).toMatchObject({
      type: "payment.pending",
      environment: "sandbox",
      data: {
        paymentId: payment.id, status: "pending", amount: payment.amount, asset: "XLM", assetIssuer: null,
        memo: payment.memo, destination: MERCHANT, expiresAt: payment.expiresAt,
      },
    });
    expect(body.id).toMatch(/^evt_[0-9A-Z]{16}$/);
    expect(deliveriesFor(endpoint.id)).toMatchObject([{ status: "delivered", attempts: 1, last_status_code: 200 }]);
    // The stored body is exactly what was sent.
    expect(db.prepare("SELECT body FROM webhook_events WHERE id = ?").get(body.id).body).toBe(req.body);
  });

  test("another endpoint's secret does not verify the delivery", async () => {
    const endpoint = await registerEndpoint();
    const other = await registerEndpoint({ events: ["refund.issued"] });
    await createRequest();
    await run();
    const req = receiver.requests.find((r) => r.headers["x-pluglytics-webhook-id"] === endpoint.id);
    expect(isValidSignature(req.body, req.headers["x-pluglytics-timestamp"], req.headers["x-pluglytics-signature"],
      other.secret, Math.floor(Date.now() / 1000))).toBe(false);
  });

  test("payment.completed carries the transaction, payer and ledger", async () => {
    const endpoint = await registerEndpoint({ events: ["payment.completed"] });
    const payment = await createRequest();
    const paid = horizonPayment(payment.memo, payment.amount);
    jest.spyOn(global, "fetch").mockResolvedValue(horizonPage([paid]));
    expect((await request(app).get(`/api/v1/payments/${payment.id}`).set("Authorization", `Bearer ${studentToken}`)).body.data.status)
      .toBe("completed");

    await run();
    expect(receiver.requests).toHaveLength(1); // payment.pending was not subscribed
    expect(bodyOf(receiver.requests[0])).toMatchObject({
      type: "payment.completed",
      data: {
        paymentId: payment.id, status: "completed", amountReceived: payment.amount, sourceAccount: PAYER,
        transactionHash: paid.transaction_hash, ledger: 4242, paidAt: paid.created_at,
      },
    });
    expect(deliveriesFor(endpoint.id)[0].status).toBe("delivered");
  });

  test("payment.failed is sent when a request expires, and when it is cancelled (reason cancelled)", async () => {
    await registerEndpoint({ events: ["payment.failed"] });
    const expired = await createRequest();
    db.prepare("UPDATE payment_requests SET created_at = '2026-01-01T10:00:00.000Z', expires_at = '2026-01-01T10:30:00.000Z' WHERE id = ?").run(expired.id);
    const cancelled = await createRequest();
    jest.spyOn(global, "fetch").mockResolvedValue(horizonPage([]));
    await request(app).get(`/api/v1/payments/${expired.id}`).set("Authorization", `Bearer ${studentToken}`);
    expect((await request(app).post(`/api/v1/payments/${cancelled.id}/cancel`).set("Authorization", `Bearer ${studentToken}`)).status).toBe(200);

    await run();
    const events = receiver.requests.map(bodyOf);
    expect(events.map((e) => [e.data.paymentId, e.type, e.data.status, e.data.reason])).toEqual([
      [expired.id, "payment.failed", "failed", "expired"],
      [cancelled.id, "payment.failed", "failed", "cancelled"],
    ]);
  });

  test("only endpoints of the payment's school that subscribed to the event receive it", async () => {
    const subscribed = await registerEndpoint({ events: ["payment.pending"] });
    const notSubscribed = await registerEndpoint({ events: ["payment.completed"] });
    const otherSchoolId = Number(db.prepare("INSERT INTO schools (name, code) VALUES ('Delivery Test School', 'DELTEST')").run().lastInsertRowid);
    extraSchoolIds.push(otherSchoolId);
    const otherSchool = await registerEndpoint({ schoolId: otherSchoolId });
    await createRequest();

    expect(deliveriesFor(subscribed.id)).toHaveLength(1);
    expect(deliveriesFor(notSubscribed.id)).toHaveLength(0);
    expect(deliveriesFor(otherSchool.id)).toHaveLength(0);
  });

  test("nothing is stored when no endpoint is subscribed", async () => {
    const before = db.prepare("SELECT COUNT(*) n FROM webhook_events").get().n;
    await createRequest();
    expect(db.prepare("SELECT COUNT(*) n FROM webhook_events").get().n).toBe(before);
  });
});

describe("retries", () => {
  test("follows the documented schedule, resending the same body with a new timestamp and signature", async () => {
    const endpoint = await registerEndpoint({ events: ["payment.pending"] });
    await createRequest();
    receiver.plan = Array(MAX_ATTEMPTS).fill(500);
    const start = Date.parse("2030-01-01T00:00:00.000Z");

    let at = start;
    await run(at);
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const wait = RETRY_DELAYS_MS[attempt - 1];
      const row = deliveriesFor(endpoint.id)[0];
      expect(row).toMatchObject({ status: "pending", attempts: attempt - 1, last_status_code: 500 });
      expect(Date.parse(row.next_attempt_at)).toBe(at + wait);
      // Not sent a moment too early.
      expect((await run(at + wait - 1000)).sent).toBe(0);
      at += wait;
      expect((await run(at)).sent).toBe(1);
    }

    expect(RETRY_DELAYS_MS).toEqual([0, 60e3, 300e3, 1800e3, 7200e3, 21600e3, 43200e3, 86400e3]);
    const row = deliveriesFor(endpoint.id)[0];
    expect(row).toMatchObject({ status: "delivery_failed", attempts: 8, next_attempt_at: null });
    expect(receiver.requests).toHaveLength(8);
    const bodies = new Set(receiver.requests.map((r) => r.body));
    const eventIds = new Set(receiver.requests.map((r) => r.headers["x-pluglytics-event-id"]));
    const timestamps = new Set(receiver.requests.map((r) => r.headers["x-pluglytics-timestamp"]));
    expect(bodies.size).toBe(1);
    expect(eventIds.size).toBe(1);
    expect(timestamps.size).toBe(8);
    for (const req of receiver.requests) {
      expect(isValidSignature(req.body, req.headers["x-pluglytics-timestamp"], req.headers["x-pluglytics-signature"],
        endpoint.secret, Number(req.headers["x-pluglytics-timestamp"]))).toBe(true);
    }
    expect((await run(at + 365 * 86400e3)).sent).toBe(0);
  });

  test("a 4xx reply is retried, and a later success is delivered", async () => {
    const endpoint = await registerEndpoint({ events: ["payment.pending"] });
    await createRequest();
    receiver.plan = [400, 200];
    const start = Date.parse("2030-02-01T00:00:00.000Z");
    await run(start);
    expect(deliveriesFor(endpoint.id)[0]).toMatchObject({ status: "pending", attempts: 1, last_status_code: 400 });
    await run(start + RETRY_DELAYS_MS[1]);
    expect(deliveriesFor(endpoint.id)[0]).toMatchObject({ status: "delivered", attempts: 2, last_status_code: 200 });
  });

  test("410 Gone stops sending to that URL at once and disables the endpoint", async () => {
    const endpoint = await registerEndpoint();
    await createRequest();
    await createRequest();
    receiver.plan = [410];
    await run();

    expect(receiver.requests).toHaveLength(1);
    expect(deliveriesFor(endpoint.id).map((d) => d.status)).toEqual(["delivery_failed", "delivery_failed"]);
    expect(deliveriesFor(endpoint.id)[0]).toMatchObject({ attempts: 1, last_status_code: 410 });
    const listed = (await request(app).get("/api/v1/webhooks").set("Authorization", `Bearer ${adminToken}`)).body.data
      .find((w) => w.id === endpoint.id);
    expect(listed).toMatchObject({ status: "disabled", disabledAt: expect.any(String) });

    // New events are no longer queued for it.
    await createRequest();
    expect(deliveriesFor(endpoint.id)).toHaveLength(2);
  });

  test("a timeout or connection error counts as a failed attempt", async () => {
    const endpoint = await registerEndpoint({ events: ["payment.pending"] });
    await createRequest();
    const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
    await deliverDue({ fetchImpl: async () => { throw timeout; } });
    expect(deliveriesFor(endpoint.id)[0]).toMatchObject({ status: "pending", attempts: 1, last_status_code: null, last_error: "Timed out after 10 seconds" });
    await deliverDue({ fetchImpl: async () => { throw new Error("ECONNREFUSED"); }, now: () => new Date(Date.now() + RETRY_DELAYS_MS[1]) });
    expect(deliveriesFor(endpoint.id)[0]).toMatchObject({ attempts: 2, last_error: "Could not connect: ECONNREFUSED" });
  });
});

describe("secret rotation", () => {
  test("for 24 hours after a rotation, deliveries carry both signatures", async () => {
    const endpoint = await registerEndpoint({ events: ["payment.pending"] });
    const rotated = (await request(app).post(`/api/v1/webhooks/${endpoint.id}/rotate-secret`).set("Authorization", `Bearer ${adminToken}`)).body.data;
    await createRequest();
    await run();
    const req = receiver.requests[0];
    const now = Math.floor(Date.now() / 1000);
    expect(req.headers["x-pluglytics-signature"].split(",")).toHaveLength(2);
    expect(isValidSignature(req.body, req.headers["x-pluglytics-timestamp"], req.headers["x-pluglytics-signature"], rotated.secret, now)).toBe(true);
    expect(isValidSignature(req.body, req.headers["x-pluglytics-timestamp"], req.headers["x-pluglytics-signature"], endpoint.secret, now)).toBe(true);
  });
});
