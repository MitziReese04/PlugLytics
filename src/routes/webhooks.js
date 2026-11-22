const crypto = require("crypto");
const express = require("express");
const { z } = require("zod");
const db = require("../db");
const { authenticate, authorize } = require("../middleware/auth");
const { sendSuccess, sendError } = require("../utils/envelope");
const { loadStellarConfig } = require("../stellarConfig");
const {
  PREVIOUS_SECRET_TTL_MS, WebhookSecretError, generateWebhookSecret, encryptSecret,
} = require("../webhookSecrets");

// Admin-only webhook registration, one signing secret per endpoint.
// See "Webhook endpoints" in docs/stellar/payments-api.md.
const router = express.Router();
router.use(authenticate, authorize("admin"));

// The events in docs/stellar/webhooks.md.
const WEBHOOK_EVENTS = [
  "payment.pending", "payment.completed", "payment.failed", "refund.issued", "settlement.completed",
  "subscription.activated", "subscription.past_due", "subscription.cancelled",
];

function isAllowedUrl(value, environment) {
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  // Plain http is only for a local test server in sandbox.
  return environment === "sandbox" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

const registerSchema = z.object({
  schoolId: z.number().int().positive(),
  url: z.string().trim().min(8).max(2048),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1).optional(),
  description: z.string().trim().min(1).max(200).nullable().optional(),
}).strict();
const listSchema = z.object({ schoolId: z.coerce.number().int().positive().optional() }).strict();

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function webhookId() {
  const bytes = crypto.randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i += 1) out += BASE32[bytes[i] % 32];
  return `wh_${out}`;
}

const ENDPOINT_COLUMNS = `
  w.id, w.school_id, s.name AS school_name, w.url, w.events, w.description, w.environment,
  w.previous_secret_expires_at, w.secret_last_rotated_at, w.created_at, w.disabled_at
`;
const findEndpoint = db.prepare(`SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints w JOIN schools s ON s.id = w.school_id WHERE w.id = ?`);

// Never includes a secret, encrypted or not.
function toResponse(row) {
  return {
    id: row.id,
    schoolId: row.school_id,
    schoolName: row.school_name,
    url: row.url,
    events: JSON.parse(row.events),
    description: row.description || null,
    environment: row.environment,
    secretLastRotatedAt: row.secret_last_rotated_at,
    previousSecretExpiresAt: row.previous_secret_expires_at && Date.parse(row.previous_secret_expires_at) > Date.now()
      ? row.previous_secret_expires_at
      : null,
    createdAt: row.created_at,
    status: row.disabled_at ? "disabled" : "active",
    disabledAt: row.disabled_at || null,
  };
}

// The server-only key that encrypts stored secrets. Sandbox only so far.
function serverKeyOrError(res) {
  let stellar;
  try {
    stellar = loadStellarConfig();
  } catch (error) {
    sendError(res, 503, "STELLAR_NOT_CONFIGURED", "Stellar settings (including WEBHOOK_SIGNING_SECRET) are needed to manage webhooks");
    return null;
  }
  if (stellar.env !== "sandbox") {
    sendError(res, 503, "STELLAR_NOT_CONFIGURED", "Only sandbox (testnet) webhooks are enabled so far");
    return null;
  }
  return stellar;
}

function encryptOrError(res, secret, serverKey) {
  try {
    return encryptSecret(secret, serverKey);
  } catch (error) {
    if (error instanceof WebhookSecretError) {
      sendError(res, 503, "STELLAR_NOT_CONFIGURED", error.message);
      return null;
    }
    throw error;
  }
}

// The events an endpoint can subscribe to, for the admin screen.
router.get("/events", (req, res) => sendSuccess(res, WEBHOOK_EVENTS, { total: WEBHOOK_EVENTS.length }));

router.post("/", (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid webhook", parsed.error.flatten());
  const stellar = serverKeyOrError(res);
  if (!stellar) return undefined;
  const { schoolId, url, description } = parsed.data;
  if (!isAllowedUrl(url, stellar.env)) {
    return sendError(res, 400, "VALIDATION_ERROR", "url must start with https:// (plain http:// only for localhost in sandbox)", {
      fieldErrors: { url: ["must start with https:// (plain http:// only for localhost in sandbox)"] },
    });
  }
  if (!db.prepare("SELECT 1 FROM schools WHERE id = ?").get(schoolId)) {
    return sendError(res, 404, "SCHOOL_NOT_FOUND", "No school has that ID");
  }

  const secret = generateWebhookSecret();
  const secretEnc = encryptOrError(res, secret, stellar.webhookSigningSecret);
  if (!secretEnc) return undefined;
  const now = new Date().toISOString();
  const id = webhookId();
  db.prepare(`
    INSERT INTO webhook_endpoints (id, school_id, url, events, description, environment, secret_enc,
      secret_last_rotated_at, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, schoolId, url, JSON.stringify(parsed.data.events ? [...new Set(parsed.data.events)] : WEBHOOK_EVENTS),
    description || null, stellar.env, secretEnc, now, req.user.id, now);
  // The secret is returned only here, once.
  return sendSuccess(res, { ...toResponse(findEndpoint.get(id)), secret }, {}, 201);
});

router.get("/", (req, res) => {
  const parsed = listSchema.safeParse(req.query);
  if (!parsed.success) return sendError(res, 400, "VALIDATION_ERROR", "Invalid filters", parsed.error.flatten());
  const { schoolId } = parsed.data;
  const rows = db.prepare(`
    SELECT ${ENDPOINT_COLUMNS} FROM webhook_endpoints w JOIN schools s ON s.id = w.school_id
    ${schoolId ? "WHERE w.school_id = @schoolId" : ""}
    ORDER BY w.created_at DESC, w.id DESC
  `).all(schoolId ? { schoolId } : {});
  return sendSuccess(res, rows.map(toResponse), { total: rows.length, filtersApplied: schoolId ? { schoolId } : {} });
});

// Removes the endpoint and its secrets.
router.delete("/:id", (req, res) => {
  const row = findEndpoint.get(req.params.id);
  if (!row) return sendError(res, 404, "WEBHOOK_NOT_FOUND", "No registered webhook URL has that ID");
  db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(row.id);
  return sendSuccess(res, { id: row.id, deleted: true });
});

// New secret, shown once. The previous one keeps working for 24 hours.
router.post("/:id/rotate-secret", (req, res) => {
  const row = db.prepare("SELECT * FROM webhook_endpoints WHERE id = ?").get(req.params.id);
  if (!row) return sendError(res, 404, "WEBHOOK_NOT_FOUND", "No registered webhook URL has that ID");
  const stellar = serverKeyOrError(res);
  if (!stellar) return undefined;

  const secret = generateWebhookSecret();
  const secretEnc = encryptOrError(res, secret, stellar.webhookSigningSecret);
  if (!secretEnc) return undefined;
  const now = new Date();
  const previousExpiresAt = new Date(now.getTime() + PREVIOUS_SECRET_TTL_MS).toISOString();
  db.prepare(`
    UPDATE webhook_endpoints
    SET previous_secret_enc = secret_enc, previous_secret_expires_at = ?, secret_enc = ?, secret_last_rotated_at = ?
    WHERE id = ?
  `).run(previousExpiresAt, secretEnc, now.toISOString(), row.id);
  return sendSuccess(res, {
    id: row.id,
    secret,
    previousSecretExpiresAt: previousExpiresAt,
    secretLastRotatedAt: now.toISOString(),
  });
});

module.exports = { router, WEBHOOK_EVENTS };
