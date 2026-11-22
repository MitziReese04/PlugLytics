const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const PREFIX = "pay_ADMINLIST";

async function login(email) {
  const response = await request(app).post("/api/v1/auth/login").send({ email, password: "Demo123!" });
  return response.body.data.token;
}

let n = 0;
function addRequest({ status = "pending", reason = null, createdAt }) {
  n += 1;
  const id = `${PREFIX}${String(n).padStart(4, "0")}`;
  const done = status === "completed" || (status === "failed" && ["underpaid", "wrong_asset"].includes(reason));
  db.prepare(`
    INSERT INTO payment_requests (id, amount, asset, memo, destination, status, reason, tx_hash, amount_received, ledger,
      created_at, expires_at, completed_at)
    VALUES (@id, '25.0000000', 'XLM', @memo, @destination, @status, @reason, @tx, @received, @ledger,
      @createdAt, @expiresAt, @completedAt)
  `).run({
    id,
    memo: `PL-AL${String(n).padStart(4, "0")}`,
    destination: MERCHANT,
    status,
    reason,
    tx: done ? n.toString(16).padStart(64, "d") : null,
    received: done ? (reason === "underpaid" ? "20.0000000" : "25.0000000") : null,
    ledger: done ? 3000000 + n : null,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 30 * 60 * 1000).toISOString(),
    completedAt: status === "completed" ? new Date(Date.parse(createdAt) + 60 * 1000).toISOString() : null,
  });
  return id;
}

let adminToken;
const list = (query = "", token = adminToken) =>
  request(app).get(`/api/v1/payments${query}`).set("Authorization", `Bearer ${token}`);
const countWhere = (sql = "", ...params) =>
  db.prepare(`SELECT COUNT(*) n FROM payment_requests ${sql}`).get(...params).n;

beforeAll(async () => {
  adminToken = await login("admin@pluglytics.local");
  addRequest({ status: "pending", createdAt: "2026-11-20T08:00:00.000Z" });
  addRequest({ status: "completed", createdAt: "2026-11-20T09:00:00.000Z" });
  addRequest({ status: "failed", reason: "expired", createdAt: "2026-11-20T10:00:00.000Z" });
  addRequest({ status: "failed", reason: "underpaid", createdAt: "2026-11-20T11:00:00.000Z" });
  for (let i = 0; i < 26; i += 1) {
    addRequest({ status: "pending", createdAt: `2026-11-19T${String(i % 24).padStart(2, "0")}:${String(i).padStart(2, "0")}:00.000Z` });
  }
});

afterAll(() => {
  db.prepare("DELETE FROM payment_requests WHERE id LIKE ?").run(`${PREFIX}%`);
});

describe("GET /api/v1/payments (admin list)", () => {
  test("lists requests newest first with the fields the dashboard shows", async () => {
    const response = await list();
    expect(response.status).toBe(200);
    expect(response.body.meta).toMatchObject({ page: 1, pageSize: 25, total: countWhere() });
    const rows = response.body.data;
    expect(rows).toHaveLength(Math.min(25, countWhere()));
    const created = rows.map((r) => r.createdAt);
    expect([...created].sort().reverse()).toEqual(created);

    const completed = rows.find((r) => r.id === `${PREFIX}0002`);
    expect(completed).toMatchObject({
      status: "completed", amount: "25.0000000", asset: "XLM", memo: "PL-AL0002",
      transactionHash: (2).toString(16).padStart(64, "d"), createdAt: "2026-11-20T09:00:00.000Z",
    });
  });

  test("filters by status", async () => {
    for (const status of ["pending", "completed", "failed"]) {
      const response = await list(`?status=${status}`);
      expect(response.status).toBe(200);
      expect(response.body.meta.total).toBe(countWhere("WHERE status = ?", status));
      expect(response.body.meta.filtersApplied).toEqual({ status });
      expect(response.body.data.every((r) => r.status === status)).toBe(true);
    }
  });

  test("filters failed requests by reason", async () => {
    const response = await list("?status=failed&reason=underpaid");
    expect(response.status).toBe(200);
    expect(response.body.data.map((r) => r.id)).toContain(`${PREFIX}0004`);
    expect(response.body.data.every((r) => r.reason === "underpaid")).toBe(true);
  });

  test("pages through results 25 at a time", async () => {
    const total = countWhere();
    const second = await list("?page=2");
    expect(second.status).toBe(200);
    expect(second.body.meta.page).toBe(2);
    expect(second.body.data).toHaveLength(Math.min(25, Math.max(0, total - 25)));
    const first = await list("?page=1");
    const firstIds = new Set(first.body.data.map((r) => r.id));
    expect(second.body.data.some((r) => firstIds.has(r.id))).toBe(false);
  });

  test.each([
    ["an unknown status", "?status=paid"],
    ["a reason with a non-failed status", "?status=pending&reason=expired"],
    ["an invalid page", "?page=0"],
    ["an unknown filter", "?asset=XLM"],
  ])("rejects %s", async (_, query) => {
    const response = await list(query);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("is only for admins", async () => {
    expect((await request(app).get("/api/v1/payments")).status).toBe(401);
    expect((await list("", await login("student@pluglytics.local"))).status).toBe(403);
    expect((await list("", await login("instructor@pluglytics.local"))).status).toBe(403);
  });
});
