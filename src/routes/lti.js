// Canvas LTI 1.3 launch: opens the PlugLytics dashboard inside a Canvas course or account.
//
//   GET|POST /lti/login        Step 1. Canvas starts the launch (OIDC login initiation).
//   POST     /lti/launch       Step 2. Canvas posts a signed id_token; we check it and sign the user in.
//   GET      /lti/jwks         PlugLytics' public key, which Canvas asks for when the key is registered.
//   GET      /lti/config.json  Configuration a Canvas admin pastes into a new LTI developer key.
//
// This covers the dashboard launch only. Grade passback and roster sync (LTI Advantage
// services) are not built. See docs/pilot/canvas-lti-install.md.
const crypto = require("crypto");
const express = require("express");
const jwt = require("jsonwebtoken");
const db = require("../db");
const config = require("../config");
const { getLtiSettings } = require("../lti/settings");
const { getPlatformKey } = require("../lti/platformKeys");

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: "64kb" }));

const CLAIM = "https://purl.imsglobal.org/spec/lti/claim/";
const STATE_TTL_SECONDS = 10 * 60;
const MAX_TOKEN_AGE_SECONDS = 10 * 60;

// ---------------------------------------------------------------------------
// Storage: which Canvas user is which PlugLytics user, and nonces already used.
// Created on first use so older databases (including the committed demo DB) work.
// ---------------------------------------------------------------------------
let tablesReady = false;
function ensureTables() {
  if (tablesReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS lti_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      issuer TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_launch_at TEXT,
      UNIQUE(issuer, subject)
    );
    CREATE TABLE IF NOT EXISTS lti_nonces (
      nonce TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
  tablesReady = true;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// Errors are shown inside the Canvas frame, so they are small HTML pages, not JSON.
function errorPage(res, status, code, message, detail) {
  res.status(status).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>PlugLytics</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 560px; margin: 48px auto; padding: 0 16px; color: #1f2933;">
<h1 style="font-size: 20px;">PlugLytics could not open</h1>
<p>${escapeHtml(message)}</p>
${detail ? `<p style="color: #52606d; font-size: 13px;">${escapeHtml(detail)}</p>` : ""}
<p style="color: #52606d; font-size: 13px;">Error code: ${escapeHtml(code)}</p>
</body></html>`);
}

function toolBaseUrl(req, settings) {
  return settings.toolUrl || `${req.protocol}://${req.get("host")}`;
}

function base64url(buffer) {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// The tool's public key as a JWK, with an RFC 7638 thumbprint as its key id.
function toolPublicJwk(privateKey) {
  const { kty, n, e } = crypto.createPublicKey(privateKey).export({ format: "jwk" });
  const kid = base64url(crypto.createHash("sha256").update(JSON.stringify({ e, kty, n })).digest());
  return { kty, n, e, kid, alg: "RS256", use: "sig" };
}

// Canvas course roles first, then account (institution/system) admin roles.
// The most powerful matching role wins.
function mapRole(roles) {
  const list = Array.isArray(roles) ? roles : [];
  const has = (pattern) => list.some((role) => pattern.test(String(role)));
  if (has(/\/(institution|system)\/person#(Administrator|SysAdmin)$/)) return "admin";
  if (has(/\/membership#Instructor$/) || has(/\/membership\/Instructor#TeachingAssistant$/)) return "instructor";
  if (has(/\/membership#Learner$/)) return "student";
  return null;
}

function rejectReplay(nonce, expiresAt) {
  ensureTables();
  const now = Math.floor(Date.now() / 1000);
  db.prepare("DELETE FROM lti_nonces WHERE expires_at < ?").run(now);
  const inserted = db.prepare("INSERT OR IGNORE INTO lti_nonces (nonce, expires_at) VALUES (?, ?)").run(nonce, expiresAt);
  return inserted.changes === 0;
}

// Finds the PlugLytics user for a Canvas user. A Canvas user is linked once, on the
// first launch, to an existing PlugLytics account with the same email and role
// (only for the roles in LTI_EMAIL_LINK_ROLES; admins are linked by hand).
// Accounts are never created here: students need a program and student number,
// which Canvas does not send.
function findUser(issuer, claims, role, emailLinkRoles) {
  ensureTables();
  const link = db.prepare(
    `SELECT u.id, u.email, u.role, u.name, u.is_active
     FROM lti_accounts a JOIN users u ON u.id = a.user_id
     WHERE a.issuer = ? AND a.subject = ?`
  ).get(issuer, claims.sub);
  if (link) return { user: link, linked: false };

  if (!emailLinkRoles.includes(role)) return { user: null, reason: "NOT_LINKED" };
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) return { user: null, reason: "NOT_LINKED" };
  const user = db.prepare("SELECT id, email, role, name, is_active FROM users WHERE lower(email) = ?").get(email);
  if (!user) return { user: null, reason: "NOT_LINKED" };
  if (user.role !== role) return { user: null, reason: "ROLE_MISMATCH" };
  db.prepare("INSERT OR IGNORE INTO lti_accounts (issuer, subject, user_id) VALUES (?, ?, ?)").run(issuer, claims.sub, user.id);
  return { user, linked: true };
}

// ---------------------------------------------------------------------------
// Step 1: login initiation
// ---------------------------------------------------------------------------
function login(req, res) {
  const settings = getLtiSettings();
  if (!settings.launchReady) {
    return errorPage(res, 404, "LTI_NOT_CONFIGURED", "Canvas has not been connected to this PlugLytics server yet.");
  }
  const params = { ...req.query, ...req.body };
  if (params.iss !== settings.issuer) {
    return errorPage(res, 400, "LTI_UNKNOWN_ISSUER", "This launch did not come from the Canvas that PlugLytics is connected to.");
  }
  if (params.client_id && params.client_id !== settings.clientId) {
    return errorPage(res, 400, "LTI_UNKNOWN_CLIENT", "This Canvas developer key is not the one PlugLytics is connected to.");
  }
  if (params.lti_deployment_id && !settings.deploymentIds.includes(params.lti_deployment_id)) {
    return errorPage(res, 403, "LTI_UNKNOWN_DEPLOYMENT", "This Canvas deployment of PlugLytics is not allowed.");
  }
  if (!params.login_hint) {
    return errorPage(res, 400, "LTI_BAD_LOGIN", "Canvas did not send a login hint.");
  }

  // The state is signed by PlugLytics and carries the nonce, so the launch can be
  // checked without a cookie (browsers often block cookies inside the Canvas frame).
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = jwt.sign({ typ: "lti-state", nonce }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: STATE_TTL_SECONDS,
  });

  const redirect = new URL(settings.authUrl);
  const query = {
    scope: "openid",
    response_type: "id_token",
    response_mode: "form_post",
    prompt: "none",
    client_id: settings.clientId,
    redirect_uri: `${toolBaseUrl(req, settings)}/lti/launch`,
    login_hint: params.login_hint,
    state,
    nonce,
  };
  if (params.lti_message_hint) query.lti_message_hint = params.lti_message_hint;
  for (const [key, value] of Object.entries(query)) redirect.searchParams.set(key, value);
  return res.redirect(302, redirect.toString());
}

router.get("/login", login);
router.post("/login", login);

// ---------------------------------------------------------------------------
// Step 2: launch
// ---------------------------------------------------------------------------
router.post("/launch", async (req, res) => {
  const settings = getLtiSettings();
  if (!settings.launchReady) {
    return errorPage(res, 404, "LTI_NOT_CONFIGURED", "Canvas has not been connected to this PlugLytics server yet.");
  }
  const { id_token: idToken, state } = req.body || {};
  if (!idToken || !state) {
    return errorPage(res, 400, "LTI_BAD_LAUNCH", "Canvas did not send a launch token.");
  }

  let statePayload;
  try {
    statePayload = jwt.verify(state, config.jwtSecret, { algorithms: ["HS256"] });
    if (statePayload.typ !== "lti-state" || !statePayload.nonce) throw new Error("wrong state");
  } catch (error) {
    return errorPage(res, 401, "LTI_BAD_STATE", "This launch has expired or was not started by PlugLytics. Open PlugLytics from Canvas again.");
  }

  let claims;
  try {
    const header = jwt.decode(idToken, { complete: true })?.header;
    if (!header || header.alg !== "RS256" || !header.kid) throw new Error("bad header");
    const key = await getPlatformKey(settings.jwksUrl, header.kid);
    claims = jwt.verify(idToken, key, {
      algorithms: ["RS256"],
      issuer: settings.issuer,
      audience: settings.clientId,
      maxAge: MAX_TOKEN_AGE_SECONDS,
      clockTolerance: 60,
    });
  } catch (error) {
    return errorPage(res, 401, "LTI_BAD_TOKEN", "Canvas's launch token could not be verified.");
  }

  if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== settings.clientId) {
    return errorPage(res, 401, "LTI_BAD_TOKEN", "Canvas's launch token was meant for another tool.");
  }
  if (claims.nonce !== statePayload.nonce) {
    return errorPage(res, 401, "LTI_BAD_NONCE", "This launch does not match the one PlugLytics started.");
  }
  if (rejectReplay(claims.nonce, statePayload.exp)) {
    return errorPage(res, 401, "LTI_REPLAY", "This launch was already used. Open PlugLytics from Canvas again.");
  }
  if (claims[`${CLAIM}version`] !== "1.3.0" || claims[`${CLAIM}message_type`] !== "LtiResourceLinkRequest") {
    return errorPage(res, 400, "LTI_UNSUPPORTED", "PlugLytics only supports LTI 1.3 resource link launches.");
  }
  if (!settings.deploymentIds.includes(claims[`${CLAIM}deployment_id`])) {
    return errorPage(res, 403, "LTI_UNKNOWN_DEPLOYMENT", "This Canvas deployment of PlugLytics is not allowed.");
  }
  if (!claims.sub) {
    return errorPage(res, 403, "LTI_ANONYMOUS", "Canvas launched PlugLytics without identifying the user.");
  }

  const role = mapRole(claims[`${CLAIM}roles`]);
  if (!role) {
    return errorPage(res, 403, "LTI_ROLE_NOT_SUPPORTED", "Your Canvas role cannot open PlugLytics. Students, teachers, TAs and admins can.");
  }

  const found = findUser(settings.issuer, claims, role, settings.emailLinkRoles);
  if (!found.user) {
    const message = found.reason === "ROLE_MISMATCH"
      ? "Your Canvas role does not match your PlugLytics account. Ask your PlugLytics administrator to check it."
      : "Your Canvas account is not linked to a PlugLytics account yet. Ask your PlugLytics administrator to add you.";
    // The Canvas user ID is opaque, and is what an administrator needs to link the account.
    return errorPage(res, 403, `LTI_${found.reason}`, message, `Canvas user ID: ${claims.sub}`);
  }
  if (!found.user.is_active) {
    return errorPage(res, 403, "LTI_ACCOUNT_INACTIVE", "Your PlugLytics account is not active.");
  }
  if (found.user.role !== role) {
    return errorPage(res, 403, "LTI_ROLE_MISMATCH", "Your Canvas role does not match your PlugLytics account. Ask your PlugLytics administrator to check it.");
  }
  db.prepare("UPDATE lti_accounts SET last_launch_at = CURRENT_TIMESTAMP WHERE issuer = ? AND subject = ?").run(settings.issuer, claims.sub);

  // Same token as a normal sign-in, so every existing role check applies unchanged.
  const token = jwt.sign({ sub: found.user.id, role: found.user.role }, config.jwtSecret, {
    algorithm: "HS256",
    expiresIn: config.jwtExpiresIn,
  });
  // The token travels in the URL fragment, which browsers never send to servers or logs.
  // public/lti-handoff.js stores it and removes it from the address bar.
  return res.redirect(302, `/public/dashboard.html#lti_token=${encodeURIComponent(token)}`);
});

// ---------------------------------------------------------------------------
// Tool public key and Canvas configuration
// ---------------------------------------------------------------------------
router.get("/jwks", (req, res) => {
  const settings = getLtiSettings();
  res.set("Cache-Control", "public, max-age=300");
  return res.json({ keys: settings.keyReady ? [toolPublicJwk(settings.privateKey)] : [] });
});

router.get("/config.json", (req, res) => {
  const settings = getLtiSettings();
  if (!settings.keyReady) {
    return res.status(503).json({
      error: settings.privateKeyInvalid
        ? "LTI_PRIVATE_KEY is set but is not a valid PEM private key."
        : "Set LTI_PRIVATE_KEY first (run `npm run lti:keygen`).",
    });
  }
  const base = toolBaseUrl(req, settings);
  const launchUrl = `${base}/lti/launch`;
  const placement = (name, text) => ({
    placement: name,
    message_type: "LtiResourceLinkRequest",
    target_link_uri: launchUrl,
    text,
    icon_url: `${base}/public/pluglytics-logo-mark.png`,
  });
  return res.json({
    title: "PlugLytics",
    description: "Learning analytics dashboard for students, instructors, and administrators.",
    oidc_initiation_url: `${base}/lti/login`,
    target_link_uri: launchUrl,
    public_jwk_url: `${base}/lti/jwks`,
    scopes: [],
    extensions: [
      {
        platform: "canvas.instructure.com",
        domain: new URL(base).host,
        tool_id: "pluglytics",
        privacy_level: "public",
        settings: {
          text: "PlugLytics",
          icon_url: `${base}/public/pluglytics-logo-mark.png`,
          placements: [
            { ...placement("course_navigation", "PlugLytics"), default: "enabled" },
            placement("account_navigation", "PlugLytics"),
          ],
        },
      },
    ],
  });
});

module.exports = { router, mapRole, toolPublicJwk, ensureTables };
