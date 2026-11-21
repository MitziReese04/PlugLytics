require("dotenv").config();

const NETWORKS = {
  sandbox: {
    prefix: "SANDBOX_",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  production: {
    prefix: "PRODUCTION_",
    horizonUrl: "https://horizon.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
};

const STELLAR_KEY_PATTERN = /^[A-Z2-7]{56}$/;

function read(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function loadStellarConfig(env = process.env) {
  const stellarEnv = (read(env, "STELLAR_ENV") || "").toLowerCase();
  const network = NETWORKS[stellarEnv];
  if (!network) {
    throw new Error(
      `Stellar config: STELLAR_ENV must be "sandbox" or "production" (got "${env.STELLAR_ENV || ""}").`
    );
  }

  const { prefix } = network;
  const missing = [];
  const required = (name) => {
    const value = read(env, prefix + name);
    if (!value || value.includes("PLACEHOLDER")) missing.push(prefix + name);
    return value;
  };

  const merchantPublicKey = required("MERCHANT_PUBLIC_KEY");
  const merchantSecretKey = required("MERCHANT_SECRET_KEY");
  const webhookSigningSecret = required("WEBHOOK_SIGNING_SECRET");

  if (missing.length > 0) {
    throw new Error(
      `Stellar config (${stellarEnv}): missing or placeholder value for ${missing.join(", ")}. ` +
        "Set them in your .env file."
    );
  }

  if (!merchantPublicKey.startsWith("G") || !STELLAR_KEY_PATTERN.test(merchantPublicKey)) {
    throw new Error(`Stellar config (${stellarEnv}): ${prefix}MERCHANT_PUBLIC_KEY is not a valid Stellar public key (G...).`);
  }
  if (!merchantSecretKey.startsWith("S") || !STELLAR_KEY_PATTERN.test(merchantSecretKey)) {
    // Never include the secret itself in the error message.
    throw new Error(`Stellar config (${stellarEnv}): ${prefix}MERCHANT_SECRET_KEY is not a valid Stellar secret key (S...).`);
  }

  return Object.freeze({
    env: stellarEnv,
    horizonUrl:
      read(env, "STELLAR_HORIZON_URL") || read(env, prefix + "STELLAR_HORIZON_URL") || network.horizonUrl,
    networkPassphrase:
      read(env, "STELLAR_NETWORK_PASSPHRASE") ||
      read(env, prefix + "STELLAR_NETWORK_PASSPHRASE") ||
      network.networkPassphrase,
    merchantPublicKey,
    merchantSecretKey,
    webhookSigningSecret,
  });
}

module.exports = { loadStellarConfig, NETWORKS };
