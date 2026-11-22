const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { KEY_PATTERN } = require("../src/middleware/apiKey");

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const demoSchool = db.prepare("SELECT id FROM schools ORDER BY id LIMIT 1").get();
const demoStudent = db.prepare(
  "SELECT s.id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
).get();
const anyTerm = db.prepare("SELECT id FROM terms ORDER BY id LIMIT 1").get();
const anyProgram = db.prepare("SELECT id FROM programs ORDER BY id LIMIT 1").get();

let adminToken;
let otherSchoolId;
let otherUserId;
let otherStudentId;
const invoiceIds = [];
const requestIds = { own: "pay_KEYTESTOWN00001", other: "pay_KEYTESTOTHER001" };

async function login(email) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" });
  return response.body.data.token;
}

function addInvoice(studentId) {
  const id = Number(db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, issued_at, due_at) VALUES (?, ?, 100, '2026-11-01T09:00:00Z', '2026-11-28T23:59:00Z')"
  ).run(studentId, anyTerm.id).lastInsertRowid);
  invoiceIds.push(id);
  return id;
}

function addCompletedRequest(id, invoiceId, memo, n) {
  db.prepare(`
    INSERT INTO payment_requests (id, invoice_id, amount, asset, memo, destination, status, tx_hash, amount_received, ledger,
      quoted_rate, rate_source, invoice_currency, invoice_amount, created_at, expires_at, completed_at)
    VALUES (?, ?, '250.0000000', 'XLM', ?, ?, 'completed', ?, '250.0000000', 88, '2.5000000', 'manual', 'USD', '100.00',
      '2026-11-01T10:00:00.000Z', '2026-11-01T10:30:00.000Z', '2026-11-01T10:05:00.000Z')
  `).run(id, invoiceId, memo, MERCHANT, n.toString(16).padStart(64, "a"));
}

const createKey = async (body, token = adminToken) =>
  request(app).post("/api/v1/api-keys").set("Authorization", `Bearer ${token}`).send(body);
const withKey = (method, path, key) => request(app)[method](path).set("X-PlugLytics-Api-Key", key);

beforeAll(async () => {
  adminToken = await login("admin@pluglytics.local");
  // A second school with one student, invoice and completed request, to test scoping.
  otherSchoolId = Number(db.prepare("INSERT INTO schools (name, code) VALUES ('Key Test School', 'KEYTEST')").run().lastInsertRowid);
  otherUserId = Number(db.prepare("INSERT INTO users (email, password_hash, role, name) VALUES (?, ?, 'student', 'Key Test Student')")
    .run("keytest.student@pluglytics.local", bcrypt.hashSync("Demo123!", 4)).lastInsertRowid);
  otherStudentId = otherUserId;
  db.prepare("INSERT INTO students (id, user_id, program_id, year_level, student_number, school_id) VALUES (?, ?, ?, 1, 'STU-KEYTEST', ?)")
    .run(otherStudentId, otherUserId, anyProgram.id, otherSchoolId);
  addCompletedRequest(requestIds.own, addInvoice(demoStudent.id), "PL-KEYOWN1", 1);
  addCompletedRequest(requestIds.other, addInvoice(otherStudentId), "PL-KEYOTH1", 2);
});

afterAll(() => {
  db.prepare("DELETE FROM api_keys WHERE school_id IN (?, ?)").run(demoSchool.id, otherSchoolId);
  const marks = invoiceIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks})`).run(...invoiceIds);
  db.prepare(`DELETE FROM invoices WHERE id IN (${marks})`).run(...invoiceIds);
  db.prepare("DELETE FROM students WHERE id = ?").run(otherStudentId);
  db.prepare("DELETE FROM users WHERE id = ?").run(otherUserId);
  db.prepare("DELETE FROM schools WHERE id = ?").run(otherSchoolId);
});

describe("managing customer API keys (admin)", () => {
  test("creates a key, shows it once, and stores only its hash", async () => {
    const response = await createKey({ schoolId: demoSchool.id, name: "Finance office" });
    expect(response.status).toBe(201);
    const data = response.body.data;
    expect(data.key).toMatch(KEY_PATTERN);
    expect(data).toMatchObject({
      schoolId: demoSchool.id, name: "Finance office", keyPrefix: data.key.slice(0, 12), status: "active", lastUsedAt: null,
    });
    expect(data.id).toMatch(/^key_[0-9A-Z]{16}$/);

    const row = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(data.id);
    expect(row.key_hash).toBe(sha256(data.key));
    expect(Object.values(row)).not.toContain(data.key);
  });

  test("lists keys without the key or its hash", async () => {
    const created = (await createKey({ schoolId: demoSchool.id, name: "List test" })).body.data;
    const response = await request(app).get(`/api/v1/api-keys?schoolId=${demoSchool.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(response.status).toBe(200);
    const listed = response.body.data.find((k) => k.id === created.id);
    expect(listed).toMatchObject({ keyPrefix: created.keyPrefix, status: "active" });
    expect(listed).not.toHaveProperty("key");
    expect(JSON.stringify(response.body)).not.toContain(created.key);
    expect(JSON.stringify(response.body)).not.toContain(sha256(created.key));
  });

  test("lists schools so a key can be created for one", async () => {
    const response = await request(app).get("/api/v1/api-keys/schools").set("Authorization", `Bearer ${adminToken}`);
    expect(response.body.data.map((s) => s.id)).toEqual(expect.arrayContaining([demoSchool.id, otherSchoolId]));
  });

  test.each([
    ["a missing name", { schoolId: 1 }],
    ["a blank name", { schoolId: 1, name: "  " }],
    ["a text school ID", { schoolId: "1", name: "x" }],
    ["an unknown field", { schoolId: 1, name: "x", key: "plk_mine" }],
  ])("rejects %s", async (_, body) => {
    const response = await createKey(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects an unknown school", async () => {
    expect((await createKey({ schoolId: 99999999, name: "x" })).body.error.code).toBe("SCHOOL_NOT_FOUND");
  });

  test("revokes a key: it stops working at once", async () => {
    const created = (await createKey({ schoolId: demoSchool.id, name: "Revoke test" })).body.data;
    expect((await withKey("get", "/api/v1/payments", created.key)).status).toBe(200);

    const revoked = await request(app).delete(`/api/v1/api-keys/${created.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(revoked.status).toBe(200);
    expect(revoked.body.data).toMatchObject({ status: "revoked", revokedAt: expect.any(String) });

    const after = await withKey("get", "/api/v1/payments", created.key);
    expect(after.status).toBe(401);
    expect(after.body.error.code).toBe("AUTH_INVALID");

    const again = await request(app).delete(`/api/v1/api-keys/${created.id}`).set("Authorization", `Bearer ${adminToken}`);
    expect(again.body.error.code).toBe("API_KEY_ALREADY_REVOKED");
    expect((await request(app).delete("/api/v1/api-keys/key_NOPE").set("Authorization", `Bearer ${adminToken}`)).status).toBe(404);
  });

  test("is admin-only", async () => {
    expect((await request(app).get("/api/v1/api-keys")).status).toBe(401);
    const studentToken = await login("student@pluglytics.local");
    expect((await createKey({ schoolId: demoSchool.id, name: "x" }, studentToken)).status).toBe(403);
    expect((await request(app).get("/api/v1/api-keys").set("Authorization", `Bearer ${studentToken}`)).status).toBe(403);
  });
});

describe("using a customer API key", () => {
  let key;
  let keyId;

  beforeAll(async () => {
    const created = (await createKey({ schoolId: demoSchool.id, name: "Usage test" })).body.data;
    key = created.key;
    keyId = created.id;
  });

  test("lists only its own school's payment requests", async () => {
    const response = await withKey("get", "/api/v1/payments", key);
    expect(response.status).toBe(200);
    const ids = response.body.data.map((r) => r.id);
    expect(ids).toContain(requestIds.own);
    expect(ids).not.toContain(requestIds.other);
    const ownSchoolTotal = db.prepare(`
      SELECT COUNT(*) n FROM payment_requests pr JOIN invoices i ON i.id = pr.invoice_id
      JOIN students s ON s.id = i.student_id WHERE s.school_id = ?`).get(demoSchool.id).n;
    expect(response.body.meta.total).toBe(ownSchoolTotal);
  });

  test("reads its own school's request; another school's looks missing", async () => {
    const own = await withKey("get", `/api/v1/payments/${requestIds.own}`, key);
    expect(own.status).toBe(200);
    expect(own.body.data).toMatchObject({ id: requestIds.own, status: "completed" });

    const other = await withKey("get", `/api/v1/payments/${requestIds.other}`, key);
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe("PAYMENT_NOT_FOUND");
  });

  test("a key for the other school sees only that school", async () => {
    const otherKey = (await createKey({ schoolId: otherSchoolId, name: "Other school" })).body.data.key;
    const ids = (await withKey("get", "/api/v1/payments", otherKey)).body.data.map((r) => r.id);
    expect(ids).toEqual([requestIds.other]);
    expect((await withKey("get", `/api/v1/payments/${requestIds.own}`, otherKey)).status).toBe(404);
  });

  test("records when the key was last used", async () => {
    await withKey("get", "/api/v1/payments", key);
    expect(db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?").get(keyId).last_used_at).toEqual(expect.any(String));
  });

  test.each([
    ["creating a payment request", "post", "/api/v1/payments"],
    ["cancelling a payment request", "post", `/api/v1/payments/${requestIds.own}/cancel`],
    ["the student invoice list", "get", "/api/v1/payments/invoices"],
    ["listing invoices", "get", "/api/v1/invoices"],
    ["creating an invoice", "post", "/api/v1/invoices"],
    ["admin finance", "get", "/api/v1/admin/finance/overview"],
    ["managing API keys", "get", "/api/v1/api-keys"],
    ["the signed-in user", "get", "/api/v1/auth/me"],
  ])("is read-only: refused for %s", async (_, method, path) => {
    const response = await withKey(method, path, key);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("API_KEY_READ_ONLY");
  });

  test.each([
    ["a made-up key", `plk_${"A".repeat(43)}`],
    ["a key in the wrong format", "plk_short"],
    ["an empty key", ""],
  ])("rejects %s", async (_, badKey) => {
    const response = await withKey("get", "/api/v1/payments", badKey);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTH_INVALID");
  });

  test("requests without a key are unchanged", async () => {
    expect((await request(app).get("/api/v1/payments")).body.error.code).toBe("AUTH_REQUIRED");
    expect((await request(app).get("/api/v1/payments").set("Authorization", `Bearer ${adminToken}`)).status).toBe(200);
  });
});
