require("dotenv").config();

// Payment policy settings (see "Payment policy settings" in docs/stellar/payments-api.md).
// Every value here is a placeholder until the group decides it: TODO: group decision.
// Like loadStellarConfig(), this reads the environment each time it is called and
// fails with a clear list of every invalid setting.

const ASSETS = ["XLM", "USDC"];
const RATE_SOURCES = ["manual"];

// Used only when no PAYMENT_MANUAL_RATE_* variable is set. These are FIXED,
// MADE-UP testnet rates (testnet XLM has no value), not market prices.
// TODO: group decision.
const DEFAULT_MANUAL_RATES = Object.freeze({
  "USD:XLM": "2.5000000",
  "PHP:XLM": "0.0430000",
});

const MANUAL_RATE_VAR = /^PAYMENT_MANUAL_RATE_([A-Z]{3})_([A-Z0-9]{1,12})$/;
const DECIMAL_7 = /^\d+(\.\d{1,7})?$/;
const WHOLE_NUMBER = /^\d+$/;
// A home domain such as "anchor.example.com" (the domain that serves the anchor's stellar.toml).
const DOMAIN = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const MAX_REFUND_WINDOW_DAYS = 3650;

class PaymentPolicyError extends Error {
  constructor(problems) {
    super(`Payment policy: ${problems.join(" ")}`);
    this.problems = problems;
  }
}

function read(env, name) {
  const value = env[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

// "25.5" -> 255000000n (stroops). Callers validate the format first.
function toStroops(amount) {
  const [whole, fraction = ""] = amount.split(".");
  return BigInt(whole + fraction.padEnd(7, "0"));
}

function formatAmount(value) {
  const [whole, fraction = ""] = value.split(".");
  return `${BigInt(whole).toString()}.${fraction.padEnd(7, "0")}`;
}

function loadPaymentPolicy(env = process.env) {
  const problems = [];

  const rateSource = (read(env, "PAYMENT_RATE_SOURCE") || "manual").toLowerCase();
  if (!RATE_SOURCES.includes(rateSource)) {
    problems.push(`PAYMENT_RATE_SOURCE must be one of: ${RATE_SOURCES.join(", ")} (got "${env.PAYMENT_RATE_SOURCE}").`);
  }

  // Manual rates: PAYMENT_MANUAL_RATE_<CURRENCY>_<ASSET> = asset units per 1 unit of currency.
  const manualRates = {};
  for (const name of Object.keys(env).sort()) {
    if (!name.startsWith("PAYMENT_MANUAL_RATE_")) continue;
    const value = read(env, name);
    if (value === undefined) continue;
    const match = MANUAL_RATE_VAR.exec(name);
    if (!match || !ASSETS.includes(match[2])) {
      problems.push(`${name} must be named PAYMENT_MANUAL_RATE_<CURRENCY>_<ASSET>, with a 3-letter currency and an asset of ${ASSETS.join(" or ")}.`);
      continue;
    }
    if (!DECIMAL_7.test(value) || toStroops(value) === 0n) {
      problems.push(`${name} must be a positive number with up to 7 decimal places (got "${value}").`);
      continue;
    }
    manualRates[`${match[1]}:${match[2]}`] = formatAmount(value);
  }
  const usingDefaultRates = Object.keys(manualRates).length === 0;

  // Amount limits per asset: <ASSET>_MIN_AMOUNT and <ASSET>_MAX_AMOUNT. Empty = no limit.
  const limits = {};
  for (const asset of ASSETS) {
    const limit = { min: null, max: null };
    for (const [key, name] of [["min", `${asset}_MIN_AMOUNT`], ["max", `${asset}_MAX_AMOUNT`]]) {
      const value = read(env, name);
      if (value === undefined) continue;
      if (!DECIMAL_7.test(value) || toStroops(value) === 0n) {
        problems.push(`${name} must be a positive number with up to 7 decimal places (got "${value}").`);
      } else {
        limit[key] = formatAmount(value);
      }
    }
    if (limit.min && limit.max && toStroops(limit.min) > toStroops(limit.max)) {
      problems.push(`${asset}_MIN_AMOUNT (${limit.min}) must not be more than ${asset}_MAX_AMOUNT (${limit.max}).`);
    }
    limits[asset] = Object.freeze(limit);
  }

  // Refund window in days. Empty = not decided yet (refunds must refuse to run).
  let refundWindowDays = null;
  const windowValue = read(env, "REFUND_WINDOW_DAYS");
  if (windowValue !== undefined) {
    if (!WHOLE_NUMBER.test(windowValue) || Number(windowValue) < 1 || Number(windowValue) > MAX_REFUND_WINDOW_DAYS) {
      problems.push(`REFUND_WINDOW_DAYS must be a whole number from 1 to ${MAX_REFUND_WINDOW_DAYS} (got "${windowValue}").`);
    } else {
      refundWindowDays = Number(windowValue);
    }
  }

  // Refunds above this amount (per asset) need a second admin. Empty = not decided yet.
  const refundApprovalThresholds = {};
  for (const asset of ASSETS) {
    const name = `REFUND_APPROVAL_THRESHOLD_${asset}`;
    const value = read(env, name);
    refundApprovalThresholds[asset] = null;
    if (value === undefined) continue;
    if (!DECIMAL_7.test(value) || toStroops(value) === 0n) {
      problems.push(`${name} must be a positive number with up to 7 decimal places (got "${value}").`);
    } else {
      refundApprovalThresholds[asset] = formatAmount(value);
    }
  }

  // Approved anchors: comma-separated home domains. Empty = no anchors approved.
  const approvedAnchors = [];
  const anchorsValue = read(env, "APPROVED_ANCHORS");
  if (anchorsValue !== undefined) {
    for (const entry of anchorsValue.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean)) {
      if (!DOMAIN.test(entry)) {
        problems.push(`APPROVED_ANCHORS entries must be home domains such as anchor.example.com (got "${entry}").`);
      } else if (!approvedAnchors.includes(entry)) {
        approvedAnchors.push(entry);
      }
    }
  }

  if (problems.length > 0) {
    throw new PaymentPolicyError(problems);
  }

  return Object.freeze({
    rateSource,
    manualRates: Object.freeze(usingDefaultRates ? { ...DEFAULT_MANUAL_RATES } : manualRates),
    usingDefaultRates,
    limits: Object.freeze(limits),
    refundWindowDays,
    refundApprovalThresholds: Object.freeze(refundApprovalThresholds),
    approvedAnchors: Object.freeze(approvedAnchors),
  });
}

// Returns null when `amount` (a 7-decimal string) is within the asset's limits,
// or a short explanation when it is not.
function checkAmountLimits(policy, asset, amount) {
  const limit = policy.limits[asset] || { min: null, max: null };
  const value = toStroops(amount);
  if (limit.min && value < toStroops(limit.min)) {
    return `The amount ${amount} ${asset} is below the minimum of ${limit.min} ${asset}.`;
  }
  if (limit.max && value > toStroops(limit.max)) {
    return `The amount ${amount} ${asset} is above the maximum of ${limit.max} ${asset}.`;
  }
  return null;
}

module.exports = {
  ASSETS,
  RATE_SOURCES,
  DEFAULT_MANUAL_RATES,
  PaymentPolicyError,
  loadPaymentPolicy,
  checkAmountLimits,
};
