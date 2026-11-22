const crypto = require("crypto");

// Per-endpoint webhook signing secrets (see "Webhook endpoints" in
// docs/stellar/payments-api.md). Each secret is shown once and stored encrypted
// with AES-256-GCM. It cannot be a one-way hash, because PlugLytics needs the
// original secret to sign each delivery.
//
// The encryption key is derived from the server-only WEBHOOK_SIGNING_SECRET
// (SANDBOX_ or PRODUCTION_ in .env). If that value changes, stored secrets can
// no longer be read, and every endpoint must rotate its secret.

const FORMAT = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const PREVIOUS_SECRET_TTL_MS = 24 * 60 * 60 * 1000;

class WebhookSecretError extends Error {}

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(32).toString("hex")}`;
}

function encryptionKey(serverKey) {
  if (typeof serverKey !== "string" || serverKey.length < 16) {
    throw new WebhookSecretError("WEBHOOK_SIGNING_SECRET must be at least 16 characters to encrypt webhook secrets");
  }
  return Buffer.from(crypto.hkdfSync("sha256", serverKey, "pluglytics-webhook-secrets", "aes-256-gcm v1", 32));
}

// Returns "v1:<base64 of iv + tag + ciphertext>".
function encryptSecret(secret, serverKey) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(serverKey), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

function decryptSecret(stored, serverKey) {
  const [format, payload] = String(stored).split(":");
  if (format !== FORMAT || !payload) throw new WebhookSecretError("Unknown webhook secret format");
  const data = Buffer.from(payload, "base64");
  const iv = data.subarray(0, IV_BYTES);
  const tag = data.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = data.subarray(IV_BYTES + TAG_BYTES);
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(serverKey), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (error) {
    throw new WebhookSecretError("The webhook secret could not be decrypted (was WEBHOOK_SIGNING_SECRET changed?)");
  }
}

// The secrets a delivery is signed with: the current one, plus the previous one
// for 24 hours after a rotation. Used when webhook deliveries are built.
function signingSecretsFor(endpoint, serverKey, now = new Date()) {
  const secrets = [decryptSecret(endpoint.secret_enc, serverKey)];
  if (endpoint.previous_secret_enc && Date.parse(endpoint.previous_secret_expires_at) > now.getTime()) {
    secrets.push(decryptSecret(endpoint.previous_secret_enc, serverKey));
  }
  return secrets;
}

module.exports = {
  PREVIOUS_SECRET_TTL_MS,
  WebhookSecretError,
  generateWebhookSecret,
  encryptSecret,
  decryptSecret,
  signingSecretsFor,
};
