const request = require("supertest");
const app = require("../src/app");

async function login(email) {
  const response = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password: "Demo123!" });
  return response.body.data.token;
}

describe("PlugLytics API", () => {
  test("demo student login returns a token", async () => {
    const response = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "student@pluglytics.local", password: "Demo123!" });

    expect(response.status).toBe(200);
    expect(response.body.data.token).toBeTruthy();
  });

  test("dashboard CSP allows the Chart.js CDN configured by the page", async () => {
    const response = await request(app).get("/public/dashboard.html");

    expect(response.status).toBe(200);
    expect(response.headers["content-security-policy"]).toContain("https://cdn.jsdelivr.net");
  });

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

  test("student dashboard widget catalog omits class standing", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/widgets")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.map((widget) => widget.id)).not.toContain("student-standing");
  });

  test("class standing is not exposed as a student API endpoint", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/student/standing")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(404);
  });

  test("student dashboard exposes the curriculum checklist without placing its sample in the API", async () => {
    const page = await request(app).get("/public/dashboard.html");
    const token = await login("student@pluglytics.local");
    const curriculum = await request(app)
      .get("/api/v1/student/curriculum")
      .set("Authorization", `Bearer ${token}`);
    const sample = await request(app).get("/public/demo-curriculum.json");

    expect(page.text).toContain('id="curriculumDashboard"');
    expect(curriculum.body.data.source).toBe("program_catalog");
    expect(curriculum.body.data.courses.some((course) => course.code === "MO-IT102")).toBe(false);
    const apiCourses = curriculum.body.data.courses;
    const apiTotalUnits = apiCourses.reduce((total, course) => total + course.units, 0);
    expect(curriculum.body.data.completedUnits + curriculum.body.data.remainingUnits).toBe(apiTotalUnits);
    expect(curriculum.body.data.completionPercent).toBe(
      Math.round((curriculum.body.data.completedUnits / apiTotalUnits) * 100)
    );
    expect(sample.status).toBe(200);
    expect(sample.body.curriculumVersion).toBe("February 2025");
    expect(sample.body.courses).toHaveLength(53);
  });

  test("illustrative demo calendar events never enter API calendar results", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/student/calendar?from=2026-11-01&to=2026-12-31")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([]);
    expect(response.body.data.some((event) => event.isDemo)).toBe(false);
  });

  test("role widget catalogs expose detailed features without class standing", async () => {
    const instructorToken = await login("instructor@pluglytics.local");
    const instructorWidgets = await request(app)
      .get("/api/v1/widgets")
      .set("Authorization", `Bearer ${instructorToken}`);
    expect(instructorWidgets.body.data.map((widget) => widget.id)).toEqual(expect.arrayContaining([
      "instructor-sections", "assignment-rate", "instructor-attendance", "instructor-at-risk",
    ]));
    expect(instructorWidgets.body.data.map((widget) => widget.id)).not.toContain("student-standing");

    const adminToken = await login("admin@pluglytics.local");
    const adminWidgets = await request(app)
      .get("/api/v1/widgets")
      .set("Authorization", `Bearer ${adminToken}`);
    expect(adminWidgets.body.data.map((widget) => widget.id)).toEqual(expect.arrayContaining([
      "enrollment-summary", "finance-overview", "finance-outstanding", "seat-utilization",
    ]));
  });

  test("instructor can open only their own section roster with progress measures", async () => {
    const token = await login("instructor@pluglytics.local");
    const sections = await request(app)
      .get("/api/v1/instructor/sections")
      .set("Authorization", `Bearer ${token}`);
    expect(sections.status).toBe(200);
    expect(sections.body.data.length).toBeGreaterThan(0);

    const section = sections.body.data[0];
    const roster = await request(app)
      .get(`/api/v1/instructor/sections/${section.id}/roster`)
      .set("Authorization", `Bearer ${token}`);
    expect(roster.status).toBe(200);
    expect(roster.body.data.students.length).toBeGreaterThan(0);
    expect(roster.body.data.students[0]).toEqual(expect.objectContaining({
      studentName: expect.any(String),
      attendanceRate: expect.any(Number),
      currentGrade: expect.any(Number),
      assignmentsMissed: expect.any(Number),
      quizzesMissed: expect.any(Number),
    }));

    const otherInstructorToken = await login("instructor2@pluglytics.local");
    const denied = await request(app)
      .get(`/api/v1/instructor/sections/${section.id}/roster`)
      .set("Authorization", `Bearer ${otherInstructorToken}`);
    expect(denied.status).toBe(404);
  });

  test("admin term and specialization filters apply to enrollment analytics", async () => {
    const token = await login("admin@pluglytics.local");
    const options = await request(app)
      .get("/api/v1/me/filter-options")
      .set("Authorization", `Bearer ${token}`);
    expect(options.body.data.specializations.length).toBeGreaterThan(0);
    expect(options.body.data.programs.length).toBeGreaterThan(0);
    expect(options.body.data.courses.length).toBeGreaterThan(0);

    const response = await request(app)
      .get("/api/v1/admin/enrollment/summary?specialization=CS&course=COURSE-001&section=Section%20A&yearLevel=2&status=active")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toHaveProperty("enrolledStudents");
  });

  test("student calendar returns only deadlines within the requested date range", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/student/calendar?from=2023-01-01&to=2025-12-31")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.data.every((event) => event.type === "deadline")).toBe(true);
    expect(response.body.data.every((event) => event.start >= "2023-01-01" && event.start < "2026-01-01")).toBe(true);
  });

  test("student calendar requires a bounded date range", async () => {
    const token = await login("student@pluglytics.local");
    const response = await request(app)
      .get("/api/v1/student/calendar")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("DATE_RANGE_REQUIRED");
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
