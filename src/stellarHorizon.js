// Checks Horizon for the payment that matches a pending payment request.
// Follows "Reconciliation" and "When amounts don't match" in docs/stellar/settlement.md.
//
// Uses Horizon's REST API through fetch rather than @stellar/stellar-sdk, because
// Jest 29 cannot load the SDK's ESM-only dependency (uint8array-extras).

const PAGE_LIMIT = 200;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 10000;
// Start scanning a little before the request was created, to allow for clock
// differences between this server and the Stellar network. Memos are unique,
// so an earlier start cannot match the wrong request.
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// Operation types that deliver an asset to an account. `to` and `amount` are
// what the receiver got (for path payments, after conversion).
const PAYMENT_TYPES = new Set(["payment", "path_payment_strict_receive", "path_payment_strict_send"]);

class HorizonError extends Error {}

// "25.0000000" -> 250000000n. Never compare Stellar amounts as floats.
function toStroops(amount) {
  const [whole, fraction = ""] = String(amount).split(".");
  return BigInt(whole + fraction.padEnd(7, "0").slice(0, 7));
}

// 250000000n -> "25.0000000" (negative amounts keep their sign).
function fromStroops(stroops) {
  const negative = stroops < 0n;
  const digits = (negative ? -stroops : stroops).toString().padStart(8, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -7)}.${digits.slice(-7)}`;
}

function sameAsset(record, request) {
  if (request.asset === "XLM") return record.asset_type === "native";
  return record.asset_type !== "native"
    && record.asset_code === request.asset
    && record.asset_issuer === request.asset_issuer;
}

async function getJson(url, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: "application/hal+json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HorizonError(`Horizon could not be reached: ${error.message}`);
  }
  // A merchant account that has never been funded does not exist on the network
  // yet, so Horizon answers 404: that simply means no payments have arrived.
  if (response.status === 404) {
    return { _embedded: { records: [] }, _links: {} };
  }
  if (!response.ok) {
    throw new HorizonError(`Horizon returned HTTP ${response.status}`);
  }
  return response.json();
}

// Returns the payments to `account` that carry `memo`, newest first.
async function findPaymentsWithMemo({ horizonUrl, account, memo, since, fetchImpl = fetch }) {
  const sinceMs = Date.parse(since) - CLOCK_SKEW_MS;
  const base = horizonUrl.replace(/\/+$/, "");
  let url = `${base}/accounts/${encodeURIComponent(account)}/payments?order=desc&limit=${PAGE_LIMIT}&join=transactions`;
  const matches = [];

  for (let page = 0; page < MAX_PAGES && url; page += 1) {
    const body = await getJson(url, fetchImpl);
    const records = (body._embedded && body._embedded.records) || [];
    for (const record of records) {
      if (Date.parse(record.created_at) < sinceMs) return matches;
      const tx = record.transaction || {};
      if (
        PAYMENT_TYPES.has(record.type)
        && record.to === account
        && record.transaction_successful === true
        && tx.memo_type === "text"
        && tx.memo === memo
      ) {
        matches.push(record);
      }
    }
    if (records.length < PAGE_LIMIT) return matches;
    url = body._links && body._links.next && body._links.next.href;
  }
  return matches;
}

// Decides what a pending request should become, given the payments that carry
// its memo. Returns null while it should stay pending.
//   completed:              right asset, at least the amount, before expiry
//   failed / underpaid:     right asset, less than the amount, before expiry
//   failed / wrong_asset:   different asset or issuer, before expiry
//   failed / expired:       nothing usable arrived before expiresAt
// A payment that arrives after expiry does not complete the request; an admin
// can accept it later with POST /api/v1/payments/:id/accept-late-payment.
function decideOutcome(request, payments, now = new Date()) {
  const expiresMs = Date.parse(request.expires_at);
  const inTime = payments
    .filter((p) => Date.parse(p.created_at) <= expiresMs)
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const wanted = toStroops(request.amount);

  const pick = (record, status, reason = null) => ({
    status,
    reason,
    txHash: record.transaction_hash,
    amountReceived: record.amount,
    ledger: (record.transaction && record.transaction.ledger) || null,
    // Only a valid-looking Stellar account is stored; anything else becomes null.
    sourceAccount: typeof record.from === "string" && /^G[A-Z2-7]{55}$/.test(record.from) ? record.from : null,
    completedAt: status === "completed" ? record.created_at : null,
  });

  const rightAsset = inTime.filter((p) => sameAsset(p, request));
  const full = rightAsset.find((p) => toStroops(p.amount) >= wanted);
  if (full) return pick(full, "completed");
  if (rightAsset.length) return pick(rightAsset[0], "failed", "underpaid");
  if (inTime.length) return pick(inTime[0], "failed", "wrong_asset");
  if (now.getTime() > expiresMs) {
    return { status: "failed", reason: "expired", txHash: null, amountReceived: null, ledger: null, sourceAccount: null, completedAt: null };
  }
  return null;
}

// One transaction and its payment operations, for an admin who matches a payment
// by hand. Returns null when Horizon does not know the transaction (404).
async function getTransactionWithPayments({ horizonUrl, hash, fetchImpl = fetch }) {
  const base = horizonUrl.replace(/\/+$/, "");
  const load = async (url) => {
    let response;
    try {
      response = await fetchImpl(url, { headers: { Accept: "application/hal+json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new HorizonError(`Horizon could not be reached: ${error.message}`);
    }
    if (response.status === 404) return null;
    if (!response.ok) throw new HorizonError(`Horizon returned HTTP ${response.status}`);
    return response.json();
  };
  const transaction = await load(`${base}/transactions/${encodeURIComponent(hash)}`);
  if (!transaction) return null;
  const page = await load(`${base}/transactions/${encodeURIComponent(hash)}/payments?limit=200`);
  return { transaction, payments: (page && page._embedded && page._embedded.records) || [] };
}

// Checks a transaction an admin wants to link to a failed request by hand.
//   mode "late":    the memo must be the request's memo (accept-late-payment)
//   mode "no_memo": no memo, or a memo no payment request uses (match-transaction)
// Returns { ok: true, payment, transaction } or { ok: false, problem }.
function checkManualMatch(request, found, { mode, memoBelongsToARequest }) {
  if (!found) return { ok: false, problem: "The transaction was not found on Horizon" };
  const { transaction, payments } = found;
  if (transaction.successful !== true) return { ok: false, problem: "The transaction did not succeed" };

  const memo = transaction.memo_type === "text" ? transaction.memo : null;
  if (mode === "late" && memo !== request.memo) {
    return { ok: false, problem: "The transaction's memo does not match the payment request" };
  }
  if (mode === "no_memo" && memo !== null && memoBelongsToARequest(memo)) {
    return { ok: false, problem: "The transaction has a memo that belongs to a payment request; it is not a payment without a memo" };
  }

  const toMerchant = payments.filter((p) => PAYMENT_TYPES.has(p.type) && p.to === request.destination);
  if (!toMerchant.length) return { ok: false, problem: "The transaction did not pay the merchant account" };
  const rightAsset = toMerchant.filter((p) => sameAsset(p, request));
  if (!rightAsset.length) return { ok: false, problem: "The transaction paid a different asset or issuer" };
  const payment = rightAsset.reduce((best, p) => (toStroops(p.amount) > toStroops(best.amount) ? p : best));
  if (toStroops(payment.amount) < toStroops(request.amount)) {
    return { ok: false, problem: `The transaction paid ${payment.amount} ${request.asset}, less than the requested ${request.amount}` };
  }
  return { ok: true, payment, transaction };
}

// A Stellar account as Horizon sees it, or null when it does not exist (404).
// Used to check a refund destination before sending.
async function getAccount({ horizonUrl, accountId, fetchImpl = fetch }) {
  const base = horizonUrl.replace(/\/+$/, "");
  let response;
  try {
    response = await fetchImpl(`${base}/accounts/${encodeURIComponent(accountId)}`, {
      headers: { Accept: "application/hal+json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HorizonError(`Horizon could not be reached: ${error.message}`);
  }
  if (response.status === 404) return null;
  if (!response.ok) throw new HorizonError(`Horizon returned HTTP ${response.status}`);
  return response.json();
}

// Whether an account can receive the asset: XLM always; any other asset needs a trustline.
function canReceiveAsset(account, asset, assetIssuer) {
  if (asset === "XLM") return true;
  return (account.balances || []).some((b) => b.asset_code === asset && b.asset_issuer === assetIssuer);
}

module.exports = {
  HorizonError, toStroops, fromStroops, sameAsset, PAYMENT_TYPES, REQUEST_TIMEOUT_MS, findPaymentsWithMemo, decideOutcome, getTransactionWithPayments, checkManualMatch,
  getAccount, canReceiveAsset,
};
