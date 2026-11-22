// LTI 1.3 settings for Canvas, read from environment variables.
// Read on every call (not cached) so tests and admins can change them without a code change.
// See docs/pilot/canvas-lti-install.md.
const crypto = require("crypto");

// Instructure-hosted (cloud) Canvas uses these for every school.
const CANVAS_CLOUD = {
  issuer: "https://canvas.instructure.com",
  authUrl: "https://sso.canvaslms.com/api/lti/authorize_redirect",
  jwksUrl: "https://sso.canvaslms.com/api/lti/security/jwks",
};

function list(value) {
  return String(value || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// The tool's private key, as PEM. Env vars often store newlines as "\n".
function privateKey(env) {
  const pem = String(env.LTI_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
  if (!pem) return null;
  try {
    return crypto.createPrivateKey(pem);
  } catch (error) {
    return null;
  }
}

function getLtiSettings(env = process.env) {
  const clientId = String(env.LTI_CLIENT_ID || "").trim();
  const deploymentIds = list(env.LTI_DEPLOYMENT_IDS);
  const key = privateKey(env);
  return {
    issuer: String(env.LTI_ISSUER || CANVAS_CLOUD.issuer).trim(),
    authUrl: String(env.LTI_AUTH_URL || CANVAS_CLOUD.authUrl).trim(),
    jwksUrl: String(env.LTI_JWKS_URL || CANVAS_CLOUD.jwksUrl).trim(),
    clientId,
    deploymentIds,
    // Public address of this PlugLytics server, for example https://pluglytics.xyz.
    toolUrl: String(env.LTI_TOOL_URL || "").trim().replace(/\/+$/, ""),
    privateKey: key,
    // Launches are accepted only when Canvas has been registered.
    launchReady: Boolean(clientId && deploymentIds.length > 0),
    // The tool's public key can be published as soon as a private key exists.
    keyReady: Boolean(key),
    privateKeyInvalid: Boolean(String(env.LTI_PRIVATE_KEY || "").trim()) && !key,
    // Roles that may be linked to a PlugLytics account by email on their first launch.
    // Admins are left out by default: an email address in Canvas is not proof enough
    // for access to finance data. Link admins by hand (docs/pilot/canvas-lti-install.md).
    emailLinkRoles: env.LTI_EMAIL_LINK_ROLES === undefined
      ? ["student", "instructor"]
      : list(env.LTI_EMAIL_LINK_ROLES).filter((role) => ["student", "instructor", "admin"].includes(role)),
  };
}

module.exports = { getLtiSettings, CANVAS_CLOUD };
