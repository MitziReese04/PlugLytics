// Canvas LTI 1.3 launch, tested against a fake Canvas: a local key set server and
// launch tokens signed with a test key. No real Canvas is contacted.
const http = require("http");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { mapRole, ensureTables } = require("../src/routes/lti");
const { resolveFrameAncestors } = require("../src/config");
const { clearPlatformKeyCache } = require("../src/lti/platformKeys");

const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const ROLE = {
  learner: "http://purl.imsglobal.org/vocab/lis/v2/membership#Learner",
  instructor: "http://purl.imsglobal.org/vocab/lis/v2/membership#Instructor",
  ta: "http://purl.imsglobal.org/vocab/lis/v2/membership/Instructor#TeachingAssistant",
  admin: "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Administrator",
  institutionStudent: "http://purl.imsglobal.org/vocab/lis/v2/institution/person#Student",
};
const ISSUER = "https://canvas.instructure.com";
const CLIENT_ID = "10000000000042";
const DEPLOYMENT_ID = "17:2b8f0c4a";
const TOOL_URL = "https://pluglytics.test";

const platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformJwk = { ...platform.publicKey.export({ format: "jwk" }), kid: "canvas-test-kid", alg: "RS256", use: "sig" };
const tool = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const toolPem = tool.privateKey.export({ type: "pkcs8", format: "pem" });

const LTI_ENV = ["LTI_ISSUER", "LTI_CLIENT_ID", "LTI_DEPLOYMENT_IDS", "LTI_JWKS_URL", "LTI_AUTH_URL", "LTI_TOOL_URL", "LTI_PRIVATE_KEY"];
const subjects = [];
let server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ keys: [platformJwk] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  Object.assign(process.env, {
    LTI_CLIENT_ID: CLIENT_ID,
    LTI_DEPLOYMENT_IDS: DEPLOYMENT_ID,
    LTI_JWKS_URL: `http://127.0.0.1:${server.address().port}/jwks`,
    LTI_TOOL_URL: TOOL_URL,
    // Stored with literal "\n", the way it is pasted into an env var.
    LTI_PRIVATE_KEY: toolPem.replace(/\n/g, "\\n"),
  });
  clearPlatformKeyCache();
});

afterAll(async () => {
  for (const name of LTI_ENV) delete process.env[name];
  if (subjects.length) {
    db.prepare(`DELETE FROM lti_accounts WHERE subject IN (${subjects.map(() => "?").join(",")})`).run(...subjects);
  }
  await new Promise((resolve) => server.close(resolve));
});

function newSubject() {
  const sub = `canvas-user-${crypto.randomUUID()}`;
  subjects.push(sub);
  return sub;
}

async function startLaunch(extra = {}) {
  const response = await request(app)
    .post("/lti/login")
    .type("form")
    .send({ iss: ISSUER, login_hint: "42", client_id: CLIENT_ID, lti_deployment_id: DEPLOYMENT_ID, target_link_uri: `${TOOL_URL}/lti/launch`, ...extra });
  expect(response.status).toBe(302);
  const url = new URL(response.headers.location);
  return { url, state: url.searchParams.get("state"), nonce: url.searchParams.get("nonce") };
}

function launchToken({ nonce, sub, email, roles = [ROLE.instructor], claims = {}, key = platform.privateKey, kid = "canvas-test-kid" }) {
  return jwt.sign(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      sub,
      nonce,
      email,
      name: "Test User",
      [`${CLAIM}version`]: "1.3.0",
      [`${CLAIM}message_type`]: "LtiResourceLinkRequest",
      [`${CLAIM}deployment_id`]: DEPLOYMENT_ID,
      [`${CLAIM}roles`]: roles,
      [`${CLAIM}resource_link`]: { id: "resource-link-1" },
      [`${CLAIM}context`]: { id: "course-1", title: "Data Analytics 101" },
      ...claims,
    },
    key,
    { algorithm: "RS256", keyid: kid, expiresIn: 300 }
  );
}

function launch(state, idToken) {
  return request(app).post("/lti/launch").type("form").send({ state, id_token: idToken });
}

function tokenFrom(response) {
  const match = /#lti_token=([^&]+)$/.exec(response.headers.location || "");
  return match ? decodeURIComponent(match[1]) : null;
}

describe("Canvas LTI 1.3: configuration endpoints", () => {
  test("/lti/jwks publishes only the public half of the tool key", async () => {
    const response = await request(app).get("/lti/jwks");
    expect(response.status).toBe(200);
    expect(response.body.keys).toHaveLength(1);
    const [key] = response.body.keys;
    expect(key).toMatchObject({ kty: "RSA", alg: "RS256", use: "sig" });
    expect(key.kid).toBeTruthy();
    for (const secret of ["d", "p", "q", "dp", "dq", "qi"]) expect(key).not.toHaveProperty(secret);
  });

  test("/lti/config.json gives Canvas the login, launch and key URLs and a course tab", async () => {
    const response = await request(app).get("/lti/config.json");
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      title: "PlugLytics",
      oidc_initiation_url: `${TOOL_URL}/lti/login`,
      target_link_uri: `${TOOL_URL}/lti/launch`,
      public_jwk_url: `${TOOL_URL}/lti/jwks`,
    });
    const placements = response.body.extensions[0].settings.placements.map((p) => p.placement);
    expect(placements).toEqual(expect.arrayContaining(["course_navigation", "account_navigation"]));
  });
});

describe("Canvas LTI 1.3: login initiation", () => {
  test("redirects to Canvas's authorization endpoint with state and nonce", async () => {
    const { url, state, nonce } = await startLaunch();
    expect(`${url.origin}${url.pathname}`).toBe("https://sso.canvaslms.com/api/lti/authorize_redirect");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("redirect_uri")).toBe(`${TOOL_URL}/lti/launch`);
    expect(url.searchParams.get("login_hint")).toBe("42");
    expect(url.searchParams.get("response_mode")).toBe("form_post");
    expect(state).toBeTruthy();
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
  });

  test("rejects a launch from another issuer", async () => {
    const response = await request(app).get("/lti/login").query({ iss: "https://evil.example", login_hint: "1" });
    expect(response.status).toBe(400);
    expect(response.text).toContain("LTI_UNKNOWN_ISSUER");
  });

  test("rejects an unknown client id", async () => {
    const response = await request(app).get("/lti/login").query({ iss: ISSUER, login_hint: "1", client_id: "999" });
    expect(response.status).toBe(400);
    expect(response.text).toContain("LTI_UNKNOWN_CLIENT");
  });
});

describe("Canvas LTI 1.3: launch", () => {
  test("an instructor is linked by email on first launch and gets a working PlugLytics token", async () => {
    const sub = newSubject();
    const { state, nonce } = await startLaunch();
    const response = await launch(state, launchToken({ nonce, sub, email: "instructor@pluglytics.local" }));
    expect(response.status).toBe(302);
    expect(response.headers.location).toMatch(/^\/public\/dashboard\.html#lti_token=/);

    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${tokenFrom(response)}`);
    expect(me.status).toBe(200);
    expect(me.body.data).toMatchObject({ email: "instructor@pluglytics.local", role: "instructor" });
  });

  test("later launches use the saved link, even without an email", async () => {
    const sub = newSubject();
    const first = await startLaunch();
    expect((await launch(first.state, launchToken({ nonce: first.nonce, sub, email: "student@pluglytics.local", roles: [ROLE.learner] }))).status).toBe(302);

    const second = await startLaunch();
    const response = await launch(second.state, launchToken({ nonce: second.nonce, sub, email: undefined, roles: [ROLE.learner] }));
    expect(response.status).toBe(302);
    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${tokenFrom(response)}`);
    expect(me.body.data.role).toBe("student");
  });

  test("a launch cannot be replayed", async () => {
    const sub = newSubject();
    const { state, nonce } = await startLaunch();
    const idToken = launchToken({ nonce, sub, email: "instructor@pluglytics.local" });
    expect((await launch(state, idToken)).status).toBe(302);
    const replay = await launch(state, idToken);
    expect(replay.status).toBe(401);
    expect(replay.text).toContain("LTI_REPLAY");
  });

  test("a token signed by someone other than Canvas is rejected", async () => {
    const attacker = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const { state, nonce } = await startLaunch();
    const response = await launch(state, launchToken({ nonce, sub: newSubject(), email: "admin@pluglytics.local", roles: [ROLE.admin], key: attacker.privateKey }));
    expect(response.status).toBe(401);
    expect(response.text).toContain("LTI_BAD_TOKEN");
  });

  test("a token for another tool (wrong audience) is rejected", async () => {
    const { state, nonce } = await startLaunch();
    const response = await launch(state, launchToken({ nonce, sub: newSubject(), email: "instructor@pluglytics.local", claims: { aud: "some-other-tool" } }));
    expect(response.status).toBe(401);
    expect(response.text).toContain("LTI_BAD_TOKEN");
  });

  test("a state that PlugLytics did not sign is rejected", async () => {
    const { nonce } = await startLaunch();
    const forged = jwt.sign({ typ: "lti-state", nonce }, "not-the-server-secret");
    const response = await launch(forged, launchToken({ nonce, sub: newSubject(), email: "instructor@pluglytics.local" }));
    expect(response.status).toBe(401);
    expect(response.text).toContain("LTI_BAD_STATE");
  });

  test("a nonce that does not match the state is rejected", async () => {
    const { state } = await startLaunch();
    const response = await launch(state, launchToken({ nonce: "0".repeat(32), sub: newSubject(), email: "instructor@pluglytics.local" }));
    expect(response.status).toBe(401);
    expect(response.text).toContain("LTI_BAD_NONCE");
  });

  test("an unknown deployment is rejected", async () => {
    const { state, nonce } = await startLaunch();
    const response = await launch(state, launchToken({ nonce, sub: newSubject(), email: "instructor@pluglytics.local", claims: { [`${CLAIM}deployment_id`]: "other" } }));
    expect(response.status).toBe(403);
    expect(response.text).toContain("LTI_UNKNOWN_DEPLOYMENT");
  });

  test("a Canvas student cannot sign in to a PlugLytics instructor account", async () => {
    const { state, nonce } = await startLaunch();
    const response = await launch(state, launchToken({ nonce, sub: newSubject(), email: "instructor@pluglytics.local", roles: [ROLE.learner] }));
    expect(response.status).toBe(403);
    expect(response.text).toContain("LTI_ROLE_MISMATCH");
  });

  test("a Canvas admin is never linked by email automatically", async () => {
    const { state, nonce } = await startLaunch();
    const response = await launch(state, launchToken({ nonce, sub: newSubject(), email: "admin@pluglytics.local", roles: [ROLE.admin] }));
    expect(response.status).toBe(403);
    expect(response.text).toContain("LTI_NOT_LINKED");
  });

  test("a Canvas admin linked by hand can launch as admin", async () => {
    const sub = newSubject();
    ensureTables();
    const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@pluglytics.local'").get();
    db.prepare("INSERT INTO lti_accounts (issuer, subject, user_id) VALUES (?, ?, ?)").run(ISSUER, sub, admin.id);
    const { state, nonce } = await startLaunch();
    const response = await launch(state, launchToken({ nonce, sub, roles: [ROLE.admin] }));
    expect(response.status).toBe(302);
    const me = await request(app).get("/api/v1/auth/me").set("Authorization", `Bearer ${tokenFrom(response)}`);
    expect(me.body.data.role).toBe("admin");
  });

  test("a Canvas user with no PlugLytics account is not let in, and sees their Canvas user ID", async () => {
    const sub = newSubject();
    const { state, nonce } = await startLaunch();
    const response = await launch(state, launchToken({ nonce, sub, email: "nobody@school.example", roles: [ROLE.learner] }));
    expect(response.status).toBe(403);
    expect(response.text).toContain("LTI_NOT_LINKED");
    expect(response.text).toContain(`Canvas user ID: ${sub}`);
  });
});

describe("Canvas LTI 1.3: role mapping", () => {
  test("maps Canvas roles to PlugLytics roles, most powerful first", () => {
    expect(mapRole([ROLE.learner])).toBe("student");
    expect(mapRole([ROLE.instructor])).toBe("instructor");
    expect(mapRole([ROLE.ta])).toBe("instructor");
    expect(mapRole([ROLE.learner, ROLE.admin])).toBe("admin");
    expect(mapRole([ROLE.institutionStudent])).toBeNull();
    expect(mapRole(undefined)).toBeNull();
  });
});

describe("Canvas LTI 1.3: not configured", () => {
  test("launches are refused until Canvas is registered", async () => {
    const saved = process.env.LTI_CLIENT_ID;
    delete process.env.LTI_CLIENT_ID;
    try {
      const response = await request(app).get("/lti/login").query({ iss: ISSUER, login_hint: "1" });
      expect(response.status).toBe(404);
      expect(response.text).toContain("LTI_NOT_CONFIGURED");
    } finally {
      process.env.LTI_CLIENT_ID = saved;
    }
  });
});

describe("framing the dashboard inside Canvas", () => {
  test("by default only PlugLytics itself may frame its pages", async () => {
    const response = await request(app).get("/public/dashboard.html");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
  });

  test("FRAME_ANCESTORS lets Canvas frame the dashboard", async () => {
    let framedApp;
    process.env.FRAME_ANCESTORS = "https://*.instructure.com";
    try {
      jest.isolateModules(() => {
        framedApp = require("../src/app");
      });
    } finally {
      delete process.env.FRAME_ANCESTORS;
    }
    const response = await request(framedApp).get("/public/dashboard.html");
    expect(response.headers["content-security-policy"]).toContain("frame-ancestors 'self' https://*.instructure.com");
    expect(response.headers["x-frame-options"]).toBeUndefined();
  });

  test("only https origins are accepted in FRAME_ANCESTORS", () => {
    expect(resolveFrameAncestors({ FRAME_ANCESTORS: "https://*.instructure.com, http://insecure.example javascript:alert(1) https://school.instructure.com/" }))
      .toEqual(["https://*.instructure.com", "https://school.instructure.com"]);
  });

  test("the dashboard loads the LTI token handoff before app.js", async () => {
    const response = await request(app).get("/public/dashboard.html");
    expect(response.text.indexOf("lti-handoff.js")).toBeGreaterThan(-1);
    expect(response.text.indexOf("lti-handoff.js")).toBeLessThan(response.text.indexOf("app.js"));
  });
});
