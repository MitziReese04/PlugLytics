const crypto = require("crypto");
const db = require("./db");
const { loadStellarConfig } = require("./stellarConfig");
const { signingSecretsFor, WebhookSecretError } = require("./webhookSecrets");

// Sends webhooks as described in docs/stellar/webhooks.md:
// - every event is stored once in an outbox (webhook_events) with its exact body;
// - each endpoint gets its own delivery (webhook_deliveries);
// - each attempt is signed with the endpoint's own secret: HMAC-SHA256 of
//   "<timestamp>.<raw body>", sent as "v1=<hex>" (both secrets during a rotation);
// - failures are retried on the documented schedule; 410 Gone stops sending to
//   that URL; after the last attempt a delivery is marked delivery_failed.

// Wait before attempt 1..8 (attempt 1 is sent right away).
const RETRY_DELAYS_MS = [0, 60e3, 5 * 60e3, 30 * 60e3, 2 * 3600e3, 6 * 3600e3, 12 * 3600e3, 24 * 3600e3];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;
const REQUEST_TIMEOUT_MS = 10000;
const BATCH_SIZE = 50;

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function eventId() {
  const bytes = crypto.randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i += 1) out += BASE32[bytes[i] % 32];
  return `evt_${out}`;
}

// Signature header value. During a rotation it carries both signatures.
function signatureHeader(timestamp, body, secrets) {
  return secrets
    .map((secret) => `v1=${crypto.createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`)
    .join(",");
}

const schoolOfRequest = db.prepare(`
  SELECT st.school_id FROM invoices i JOIN students st ON st.id = i.student_id WHERE i.id = ?
`);
const endpointsForSchool = db.prepare(`
  SELECT id, events FROM webhook_endpoints
  WHERE school_id = ? AND environment = ? AND disabled_at IS NULL
`);
const insertEvent = db.prepare(`
  INSERT INTO webhook_events (id, type, school_id, environment, payment_id, body, created_at)
  VALUES (@id, @type, @schoolId, @environment, @paymentId, @body, @createdAt)
`);
const insertDelivery = db.prepare(`
  INSERT INTO webhook_deliveries (event_id, endpoint_id, status, attempts, next_attempt_at)
  VALUES (?, ?, 'pending', 0, ?)
`);

// The `data` of payment.pending, payment.completed and payment.failed (webhooks.md).
function paymentEventData(type, row) {
  const base = {
    paymentId: row.id,
    type: "invoice",
    invoiceId: row.invoice_id,
    status: row.status,
    amount: row.amount,
    asset: row.asset,
    assetIssuer: row.asset_issuer || null,
    memo: row.memo,
    relatedPaymentId: row.related_payment_id || null,
  };
  if (type === "payment.pending") {
    return { ...base, destination: row.destination, expiresAt: row.expires_at };
  }
  if (type === "payment.completed") {
    return {
      ...base,
      amountReceived: row.amount_received,
      sourceAccount: row.source_account || null,
      transactionHash: row.tx_hash,
      ledger: row.ledger,
      paidAt: row.completed_at,
    };
  }
  return {
    ...base,
    reason: row.reason,
    amountReceived: row.amount_received || "0",
    transactionHash: row.tx_hash || null,
  };
}

let worker = null;

// Saves an event for a payment request and queues one delivery per endpoint of
// that request's school that subscribed to the event. Returns the event ID, or
// null when nobody is subscribed (then nothing is stored).
function enqueuePaymentEvent(type, row, environment) {
  const school = row.invoice_id ? schoolOfRequest.get(row.invoice_id) : null;
  if (!school || school.school_id === null) return null;
  const endpoints = endpointsForSchool.all(school.school_id, environment)
    .filter((endpoint) => JSON.parse(endpoint.events).includes(type));
  if (!endpoints.length) return null;
  const createdAt = new Date().toISOString();
  const id = eventId();
  const body = JSON.stringify({ id, type, createdAt, environment, data: paymentEventData(type, row) });
  db.transaction(() => {
    insertEvent.run({ id, type, schoolId: school.school_id, environment, paymentId: row.id, body, createdAt });
    for (const endpoint of endpoints) insertDelivery.run(id, endpoint.id, createdAt);
  })();
  if (worker) setImmediate(() => deliverDue().catch(() => {}));
  return id;
}

const dueDeliveries = db.prepare(`
  SELECT d.id, d.attempts, d.event_id, e.type, e.body, w.id AS endpoint_id, w.url, w.secret_enc,
         w.previous_secret_enc, w.previous_secret_expires_at, w.environment
  FROM webhook_deliveries d
  JOIN webhook_events e ON e.id = d.event_id
  JOIN webhook_endpoints w ON w.id = d.endpoint_id
  WHERE d.status = 'pending' AND d.next_attempt_at <= ? AND w.disabled_at IS NULL
  ORDER BY d.next_attempt_at, d.id
  LIMIT ?
`);
const markDelivered = db.prepare(`
  UPDATE webhook_deliveries SET status = 'delivered', attempts = @attempts, last_attempt_at = @now,
    last_status_code = @code, last_error = NULL, delivered_at = @now, next_attempt_at = NULL
  WHERE id = @id
`);
const markRetry = db.prepare(`
  UPDATE webhook_deliveries SET attempts = @attempts, last_attempt_at = @now, last_status_code = @code,
    last_error = @error, next_attempt_at = @next
  WHERE id = @id
`);
const markFailed = db.prepare(`
  UPDATE webhook_deliveries SET status = 'delivery_failed', attempts = @attempts, last_attempt_at = @now,
    last_status_code = @code, last_error = @error, next_attempt_at = NULL
  WHERE id = @id
`);
const disableEndpoint = db.prepare("UPDATE webhook_endpoints SET disabled_at = ? WHERE id = ? AND disabled_at IS NULL");
const failPendingForEndpoint = db.prepare(`
  UPDATE webhook_deliveries SET status = 'delivery_failed', next_attempt_at = NULL,
    last_error = COALESCE(last_error, 'Endpoint disabled after 410 Gone')
  WHERE endpoint_id = ? AND status = 'pending'
`);

async function sendOnce(delivery, serverKey, now, fetchImpl) {
  const timestamp = Math.floor(now.getTime() / 1000);
  const secrets = signingSecretsFor(delivery, serverKey, now);
  try {
    const response = await fetchImpl(delivery.url, {
      method: "POST",
      redirect: "manual",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PlugLytics-Webhooks/1",
        "X-PlugLytics-Event": delivery.type,
        "X-PlugLytics-Event-Id": delivery.event_id,
        "X-PlugLytics-Timestamp": String(timestamp),
        "X-PlugLytics-Webhook-Id": delivery.endpoint_id,
        "X-PlugLytics-Signature": signatureHeader(timestamp, delivery.body, secrets),
      },
      body: delivery.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return { code: response.status, ok: response.status >= 200 && response.status < 300, error: null };
  } catch (error) {
    const timedOut = error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { code: null, ok: false, error: timedOut ? "Timed out after 10 seconds" : `Could not connect: ${error.message}` };
  }
}

let running = false;

// Sends every delivery that is due. Safe to call often; only one run at a time.
// Returns { sent, delivered, retrying, failed } for this run.
async function deliverDue({ now = () => new Date(), fetchImpl = fetch } = {}) {
  const summary = { sent: 0, delivered: 0, retrying: 0, failed: 0 };
  if (running) return summary;
  running = true;
  try {
    let stellar;
    try {
      stellar = loadStellarConfig();
    } catch (error) {
      return summary; // No server key yet: deliveries wait.
    }
    const batch = dueDeliveries.all(now().toISOString(), BATCH_SIZE)
      .filter((delivery) => delivery.environment === stellar.env);
    // Endpoints that answered 410 Gone during this run: send nothing more to them.
    const goneEndpoints = new Set();
    for (const delivery of batch) {
      if (goneEndpoints.has(delivery.endpoint_id)) continue;
      const attemptAt = now();
      let result;
      try {
        result = await sendOnce(delivery, stellar.webhookSigningSecret, attemptAt, fetchImpl);
      } catch (error) {
        if (!(error instanceof WebhookSecretError)) throw error;
        result = { code: null, ok: false, error: error.message };
      }
      const attempts = delivery.attempts + 1;
      const fields = { id: delivery.id, attempts, now: attemptAt.toISOString(), code: result.code, error: result.error };
      summary.sent += 1;
      if (result.ok) {
        markDelivered.run(fields);
        summary.delivered += 1;
      } else if (result.code === 410) {
        // 410 Gone: stop sending to this URL at all.
        goneEndpoints.add(delivery.endpoint_id);
        db.transaction(() => {
          markFailed.run({ ...fields, error: "Receiver answered 410 Gone; endpoint disabled" });
          disableEndpoint.run(attemptAt.toISOString(), delivery.endpoint_id);
          failPendingForEndpoint.run(delivery.endpoint_id);
        })();
        summary.failed += 1;
      } else if (attempts >= MAX_ATTEMPTS) {
        markFailed.run({ ...fields, error: fields.error || `Receiver answered HTTP ${result.code}` });
        summary.failed += 1;
      } else {
        const next = new Date(attemptAt.getTime() + RETRY_DELAYS_MS[attempts]).toISOString();
        markRetry.run({ ...fields, error: fields.error || `Receiver answered HTTP ${result.code}`, next });
        summary.retrying += 1;
      }
    }
    return summary;
  } finally {
    running = false;
  }
}

// Runs deliverDue() every `intervalMs`, and right after new events. Started by
// src/server.js (not by the app itself, so tests control delivery directly).
function startWebhookWorker({ intervalMs = 15000 } = {}) {
  if (worker) return worker;
  const timer = setInterval(() => deliverDue().catch(() => {}), intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  worker = { stop: () => { clearInterval(timer); worker = null; } };
  return worker;
}

module.exports = {
  RETRY_DELAYS_MS,
  MAX_ATTEMPTS,
  signatureHeader,
  paymentEventData,
  enqueuePaymentEvent,
  deliverDue,
  startWebhookWorker,
};
