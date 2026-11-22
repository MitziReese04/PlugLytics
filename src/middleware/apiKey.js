const crypto = require("crypto");
const db = require("../db");
const { authenticate, authorize } = require("./auth");
const { sendError } = require("../utils/envelope");

// Customer (school) API keys: read-only, scoped to one school's payments.
// See "Customer API keys" in docs/stellar/payments-api.md.
const API_KEY_HEADER = "X-PlugLytics-Api-Key";
const KEY_PATTERN = /^plk_[A-Za-z0-9_-]{43}$/;

// The only requests a customer API key may make (all read-only).
const KEY_ROUTES = [
  { method: "GET", path: /^\/api\/v1\/payments\/?$/ },
  { method: "GET", path: /^\/api\/v1\/payments\/(?!invoices\/?$)[^/]+\/?$/ },
  { method: "GET", path: /^\/api\/v1\/subscriptions\/[^/]+\/?$/ },
];

function hashKey(key) {
  return crypto.createHash("sha256").update(key, "utf8").digest("hex");
}

// Returns { key, prefix, hash } for a new key. The key is shown once; store only the hash.
function generateApiKey() {
  const key = `plk_${crypto.randomBytes(32).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}

const findActiveKey = db.prepare(`
  SELECT k.id, k.school_id, k.name FROM api_keys k
  JOIN schools s ON s.id = k.school_id
  WHERE k.key_hash = ? AND k.revoked_at IS NULL
`);
const touchKey = db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?");

// App-level gate: if a request carries an API key, check it and make sure it is
// only used on a read-only endpoint. Requests without the header pass through.
function apiKeyGate(req, res, next) {
  const key = req.get(API_KEY_HEADER);
  if (key === undefined) return next();
  const found = typeof key === "string" && KEY_PATTERN.test(key.trim()) ? findActiveKey.get(hashKey(key.trim())) : undefined;
  if (!found) return sendError(res, 401, "AUTH_INVALID", "The API key is invalid or revoked");
  // Full path, because this middleware is mounted at /api/v1 (Express strips that from req.path).
  const fullPath = `${req.baseUrl}${req.path}`;
  const allowed = KEY_ROUTES.some((route) => route.method === req.method && route.path.test(fullPath));
  if (!allowed) {
    return sendError(res, 403, "API_KEY_READ_ONLY", "Customer API keys are read-only and can only read payments");
  }
  touchKey.run(new Date().toISOString(), found.id);
  req.apiKey = { id: found.id, schoolId: found.school_id, name: found.name };
  return next();
}

// For routes that accept either a signed-in user with one of `roles`, or an API key.
function authenticateOrApiKey(...roles) {
  const checkRole = authorize(...roles);
  return (req, res, next) => {
    if (req.apiKey) return next();
    return authenticate(req, res, () => checkRole(req, res, next));
  };
}

module.exports = { API_KEY_HEADER, KEY_PATTERN, hashKey, generateApiKey, apiKeyGate, authenticateOrApiKey };
