// Canvas signs each launch with one of its public keys (a JWKS). We download the key
// set, cache it, and refresh it when Canvas starts using a key we have not seen yet
// (Canvas rotates its keys).
const crypto = require("crypto");

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // jwksUrl -> { keys, fetchedAt }

async function download(jwksUrl) {
  const response = await fetch(jwksUrl, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Canvas key set returned HTTP ${response.status}`);
  const body = await response.json();
  if (!body || !Array.isArray(body.keys)) throw new Error("Canvas key set has no keys");
  const entry = { keys: body.keys, fetchedAt: Date.now() };
  cache.set(jwksUrl, entry);
  return entry;
}

// Returns a Node KeyObject for the key id (kid) in the launch token's header.
async function getPlatformKey(jwksUrl, kid) {
  let entry = cache.get(jwksUrl);
  if (!entry || Date.now() - entry.fetchedAt > CACHE_MS) entry = await download(jwksUrl);

  let jwk = entry.keys.find((key) => key.kid === kid);
  // An unknown kid usually means Canvas rotated its keys: fetch once more.
  if (!jwk) {
    entry = await download(jwksUrl);
    jwk = entry.keys.find((key) => key.kid === kid);
  }
  if (!jwk) throw new Error("No Canvas key matches this launch");
  if (jwk.kty !== "RSA") throw new Error("Canvas key is not an RSA key");
  return crypto.createPublicKey({ key: jwk, format: "jwk" });
}

function clearPlatformKeyCache() {
  cache.clear();
}

module.exports = { getPlatformKey, clearPlatformKeyCache };
