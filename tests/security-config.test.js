const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../src/app");
const config = require("../src/config");

describe("JWT secret", () => {
  test("production refuses to start without a unique JWT_SECRET", () => {
    for (const JWT_SECRET of [undefined, "", "  ", "pluglytics-development-secret", "change-this-secret-in-production"]) {
      expect(() => config.resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET })).toThrow(/JWT_SECRET/);
    }
  });

  test("production accepts a real secret; development falls back", () => {
    expect(config.resolveJwtSecret({ NODE_ENV: "production", JWT_SECRET: "a-real-unique-secret" })).toBe("a-real-unique-secret");
    expect(config.resolveJwtSecret({ NODE_ENV: "development" })).toBe("pluglytics-development-secret");
  });

  test("tokens signed with another algorithm are rejected", async () => {
    const token = jwt.sign({ sub: 1, role: "admin" }, config.jwtSecret, { algorithm: "HS512" });
    const response = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(401);
  });
});

describe("login rate limit", () => {
  test("blocks an IP after 10 failed sign-ins, and successful sign-ins do not count", async () => {
    const login = (password) =>
      request(app).post("/api/v1/auth/login").send({ email: "student@pluglytics.local", password });

    expect((await login("Demo123!")).status).toBe(200);
    for (let i = 0; i < 10; i += 1) expect((await login("wrong-password")).status).toBe(401);
    const blocked = await login("Demo123!");
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("TOO_MANY_LOGIN_ATTEMPTS");
  });
});
