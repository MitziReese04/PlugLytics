const request = require("supertest");
const app = require("../src/app");

async function login(email) {
  const response = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "Demo123!" });
  return response.body.data.token;
}

describe("PlugLytics API", () => {
  test("health responds through the standard envelope", async () => {
    const response = await request(app).get("/api/v1/health");
    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("data.status", "ok");
    expect(response.body.error).toBeNull();
  });

  test("student progress rejects an admin-only filter", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/student/progress?specialization=CS")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("FILTER_FORBIDDEN");
  });

  test("student cannot access instructor endpoints", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/instructor/sections")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(403);
  });

  test("instructor is isolated from the admin role", async () => {
    const token = await login("instructor@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/admin/finance/overview")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(403);
  });

  test("admin finance collection rate is calculated from collected divided by billed", async () => {
    const token = await login("admin@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/admin/finance/overview")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    const finance = response.body.data[0];
    const expected = finance.billed
      ? Number(((finance.collected / finance.billed) * 100).toFixed(1))
      : 0;
    expect(finance.collectionRate).toBe(expected);
  });

  test("dashboard layout persists for the signed-in user", async () => {
    const token = await login("student@pluglytics.local");
    const layout = {
      widgets: [{ id: "student-progress", chartType: "bar" }],
      filters: { term: "2025-1" },
      theme: "dark",
    };
    const put = await request(app)
      .put("/api/v1/me/dashboard")
      .set("Authorization", `Bearer ${token}`)
      .send(layout);
    expect(put.status).toBe(200);

    const get = await request(app)
      .get("/api/v1/me/dashboard")
      .set("Authorization", `Bearer ${token}`);
    expect(get.body.data).toEqual(layout);
  });

  test("standing response remains available through the privacy-safe endpoint", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/student/standing?term=not-a-real-term")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
  });

  test("date filter options are available to the signed-in role", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/me/filter-options")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data.terms.length).toBeGreaterThan(0);
    expect(response.body.data.dates.length).toBeGreaterThan(0);
    expect(response.body.data.dateRange.from).toBeTruthy();
  });

  test("date filters reject an inverted range", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/student/deadlines?from=2025-05-01&to=2025-01-01")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });
});
