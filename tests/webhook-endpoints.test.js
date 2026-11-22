const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { decryptSecret, signingSecretsFor } = require("../src/webhookSecrets");
const { WEBHOOK_EVENTS } = require("../src/routes/webhooks");

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const FAKE_SECRET = "S" + "A".repeat(55);
const SERVER_KEY = "test-only-server-key-for-webhook-secrets";
const STELLAR_VARS = [
  "STELLAR_ENV", "SANDBOX_MERCHANT_PUBLIC_KEY", "SANDBOX_MERCHANT_SECRET_KEY", "SANDBOX_WEBHOOK_SIGNING_SECRET",
  "PRODUCTION_MERCHANT_PUBLIC_KEY", "PRODUCTION_MERCHANT_SECRET_KEY", "PRODUCTION_WEBHOOK_SIGNING_SECRET",
];
const savedEnv = {};
function useSandbox() {
  for (const name of STELLAR_VARS) delete process.env[name];
  Object.assign(process.env, {
    STELLAR_ENV: "sandbox",
    SANDBOX_MERCHANT_PUBLIC_KEY: MERCHANT,
    SANDBOX_MERCHANT_SECRET_KEY: FAKE_SECRET,
    SANDBOX_WEBHOOK_SIGNING_SECRET: SERVER_KEY,
  });
}

const school = db.prepare("SELECT id FROM schools ORDER BY id LIMIT 1").get();
let adminToken;
const created = [];

async function login(email) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" });
  return response.body.data.token;
}
const admin = (method, path) => request(app)[method](`/api/v1/webhooks${path}`).set("Authorization", `Bearer ${adminToken}`);

async function register(fields = {}) {
  const response = await admin("post", "").send({ schoolId: school.id, url: "https://lms.example.edu/webhooks/pluglytics", ...fields });
  expect(response.status).toBe(201);
  created.push(response.body.data.id);
  return response.body.data;
}
const storedRow = (id) => db.prepare("SELECT * FROM webhook_endpoints WHERE id = ?").get(id);

beforeAll(async () => {
  for (const name of STELLAR_VARS) savedEnv[name] = process.env[name];
  useSandbox();
  adminToken = await login("admin@pluglytics.local");
});
afterEach(useSandbox);
afterAll(() => {
  if (created.length) db.prepare(`DELETE FROM webhook_endpoints WHERE id IN (${created.map(() => "?").join(",")})`).run(...created);
  for (const name of STELLAR_VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("POST /api/v1/webhooks", () => {
  test("registers a URL with its own secret, shown once and stored encrypted", async () => {
    const data = await register({ events: ["payment.completed", "payment.failed"], description: "Main LMS server" });
    expect(data).toMatchObject({
      schoolId: school.id, url: "https://lms.example.edu/webhooks/pluglytics", events: ["payment.completed", "payment.failed"],
      description: "Main LMS server", environment: "sandbox", previousSecretExpiresAt: null,
    });
    expect(data.id).toMatch(/^wh_[0-9A-Z]{16}$/);
    expect(data.secret).toMatch(/^whsec_[0-9a-f]{64}$/);

    const row = storedRow(data.id);
    expect(row.secret_enc).toMatch(/^v1:/);
    expect(Object.values(row).join(" ")).not.toContain(data.secret);
    expect(decryptSecret(row.secret_enc, SERVER_KEY)).toBe(data.secret);
  });

  test("every endpoint gets a different secret", async () => {
    const a = await register();
    const b = await register();
    expect(a.secret).not.toBe(b.secret);
    expect(storedRow(a.id).secret_enc).not.toBe(storedRow(b.id).secret_enc);
  });

  test("sends every event when none are chosen", async () => {
    expect((await register()).events).toEqual(WEBHOOK_EVENTS);
  });

  test("allows plain http only for localhost in sandbox", async () => {
    expect((await register({ url: "http://localhost:4000/hooks" })).url).toBe("http://localhost:4000/hooks");
    const response = await admin("post", "").send({ schoolId: school.id, url: "http://lms.example.edu/hooks" });
    expect(response.status).toBe(400);
  });

  test.each([
    ["a missing school", { url: "https://a.example.com/h" }],
    ["a URL that is not a URL", { schoolId: 1, url: "not a url at all" }],
    ["an ftp URL", { schoolId: 1, url: "ftp://files.example.com/h" }],
    ["a URL with a password in it", { schoolId: 1, url: "https://user:pass@a.example.com/h" }],
    ["an unknown event", { schoolId: 1, url: "https://a.example.com/h", events: ["payment.paid"] }],
    ["an empty events list", { schoolId: 1, url: "https://a.example.com/h", events: [] }],
    ["a description over 200 characters", { schoolId: 1, url: "https://a.example.com/h", description: "x".repeat(201) }],
    ["a secret sent by the client", { schoolId: 1, url: "https://a.example.com/h", secret: "whsec_mine" }],
  ])("rejects %s", async (_, body) => {
    const response = await admin("post", "").send(body);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects an unknown school", async () => {
    const response = await admin("post", "").send({ schoolId: 99999999, url: "https://a.example.com/h" });
    expect(response.body.error.code).toBe("SCHOOL_NOT_FOUND");
  });

  test("needs the sandbox settings (the server key that encrypts secrets)", async () => {
    delete process.env.SANDBOX_WEBHOOK_SIGNING_SECRET;
    const response = await admin("post", "").send({ schoolId: school.id, url: "https://a.example.com/h" });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe("STELLAR_NOT_CONFIGURED");
  });

  test("refuses when configured for production (testnet only so far)", async () => {
    Object.assign(process.env, {
      STELLAR_ENV: "production",
      PRODUCTION_MERCHANT_PUBLIC_KEY: MERCHANT,
      PRODUCTION_MERCHANT_SECRET_KEY: FAKE_SECRET,
      PRODUCTION_WEBHOOK_SIGNING_SECRET: SERVER_KEY,
    });
    const response = await admin("post", "").send({ schoolId: school.id, url: "https://a.example.com/h" });
    expect(response.status).toBe(503);
  });
});

describe("GET /api/v1/webhooks", () => {
  test("lists endpoints without any secret", async () => {
    const data = await register({ description: "List test" });
    const response = await admin("get", `?schoolId=${school.id}`);
    expect(response.status).toBe(200);
    const listed = response.body.data.find((w) => w.id === data.id);
    expect(listed).toMatchObject({ url: data.url, description: "List test", secretLastRotatedAt: expect.any(String) });
    expect(listed).not.toHaveProperty("secret");
    const body = JSON.stringify(response.body);
    expect(body).not.toContain(data.secret);
    expect(body).not.toContain(storedRow(data.id).secret_enc);
    expect(body).not.toContain("whsec_");
  });
});

describe("POST /api/v1/webhooks/:id/rotate-secret", () => {
  test("replaces the secret; the previous one stays valid for 24 hours", async () => {
    const data = await register();
    const response = await admin("post", `/${data.id}/rotate-secret`);
    expect(response.status).toBe(200);
    const rotated = response.body.data;
    expect(rotated.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(rotated.secret).not.toBe(data.secret);
    const hours = (Date.parse(rotated.previousSecretExpiresAt) - Date.parse(rotated.secretLastRotatedAt)) / 3600000;
    expect(hours).toBe(24);

    const row = storedRow(data.id);
    expect(decryptSecret(row.secret_enc, SERVER_KEY)).toBe(rotated.secret);
    expect(signingSecretsFor(row, SERVER_KEY)).toEqual([rotated.secret, data.secret]);
    // After 24 hours, only the new secret signs deliveries.
    expect(signingSecretsFor(row, SERVER_KEY, new Date(Date.now() + 25 * 3600000))).toEqual([rotated.secret]);

    const listed = (await admin("get", "")).body.data.find((w) => w.id === data.id);
    expect(listed.previousSecretExpiresAt).toBe(rotated.previousSecretExpiresAt);
  });

  test("returns 404 for an unknown endpoint", async () => {
    expect((await admin("post", "/wh_NOPE/rotate-secret")).body.error.code).toBe("WEBHOOK_NOT_FOUND");
  });
});

describe("DELETE /api/v1/webhooks/:id", () => {
  test("removes the endpoint and its secrets", async () => {
    const data = await register();
    const response = await admin("delete", `/${data.id}`);
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ id: data.id, deleted: true });
    expect(storedRow(data.id)).toBeUndefined();
    expect((await admin("get", "")).body.data.some((w) => w.id === data.id)).toBe(false);
    expect((await admin("delete", `/${data.id}`)).body.error.code).toBe("WEBHOOK_NOT_FOUND");
  });
});

describe("GET /api/v1/webhooks/events", () => {
  test("lists the events from docs/stellar/webhooks.md", async () => {
    const response = await admin("get", "/events");
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual(WEBHOOK_EVENTS);
    expect(WEBHOOK_EVENTS).toHaveLength(8);
  });
});

describe("access", () => {
  test("is admin-only and not available to customer API keys", async () => {
    expect((await request(app).get("/api/v1/webhooks")).status).toBe(401);
    const studentToken = await login("student@pluglytics.local");
    expect((await request(app).get("/api/v1/webhooks").set("Authorization", `Bearer ${studentToken}`)).status).toBe(403);
    const key = (await request(app).post("/api/v1/api-keys").set("Authorization", `Bearer ${adminToken}`)
      .send({ schoolId: school.id, name: "Webhook test" })).body.data;
    const response = await request(app).get("/api/v1/webhooks").set("X-PlugLytics-Api-Key", key.key);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("API_KEY_READ_ONLY");
    db.prepare("DELETE FROM api_keys WHERE id = ?").run(key.id);
  });
});
