require("dotenv").config();

const DEVELOPMENT_JWT_SECRET = "pluglytics-development-secret";

// The development fallback is public (it is in this file), so anyone could forge
// tokens with it. Refuse to start in production without a real secret.
function resolveJwtSecret(env = process.env) {
  const secret = typeof env.JWT_SECRET === "string" ? env.JWT_SECRET.trim() : "";
  if (env.NODE_ENV === "production" && (!secret || secret === DEVELOPMENT_JWT_SECRET || secret === "change-this-secret-in-production")) {
    throw new Error("JWT_SECRET must be set to a unique value when NODE_ENV=production");
  }
  return secret || DEVELOPMENT_JWT_SECRET;
}

// Sites allowed to show PlugLytics inside a frame, for example Canvas:
// FRAME_ANCESTORS="https://*.instructure.com https://school.instructure.com".
// Only https origins (optionally with a leading "*." wildcard) are accepted.
function resolveFrameAncestors(env = process.env) {
  return String(env.FRAME_ANCESTORS || "")
    .split(/[\s,]+/)
    .map((origin) => origin.trim().replace(/\/+$/, ""))
    .filter((origin) => /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/i.test(origin));
}

module.exports = {
  resolveJwtSecret,
  resolveFrameAncestors,
  port: Number(process.env.PORT || 3000),
  jwtSecret: resolveJwtSecret(),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || "8h",
  databasePath: process.env.DATABASE_PATH || "./data/pluglytics.db",
  // Number of reverse proxies in front of the app (Render uses 1). 0 = trust none.
  // Needed so rate limiting sees each visitor's IP instead of the proxy's.
  trustProxy: Number(process.env.TRUST_PROXY || 0),
  frameAncestors: resolveFrameAncestors(),
};
