// Exchange-rate quotes for converting an invoice amount into a Stellar asset.
// See "From invoice to payment request" in docs/stellar/payments-api.md.
//
// To add a rate source later (TODO: group decision), add one function to
// RATE_SOURCES below. Its name becomes a valid PAYMENT_RATE_SOURCE value.
// Each source receives { asset, invoiceCurrency, policy } and returns
// { quotedRate, source } with quotedRate as a decimal string (up to 7 decimals),
// or throws RateUnavailableError.

class RateUnavailableError extends Error {}

// "manual": fixed rates from the payment policy (PAYMENT_MANUAL_RATE_<CURRENCY>_<ASSET>).
// If none are configured, the policy supplies made-up testnet rates.
function manualRate({ asset, invoiceCurrency, policy }) {
  const rate = policy.manualRates[`${invoiceCurrency}:${asset}`];
  if (!rate) {
    throw new RateUnavailableError(`No manual rate is set for ${invoiceCurrency} to ${asset}`);
  }
  return { quotedRate: rate, source: policy.usingDefaultRates ? "manual-default-testnet" : "manual" };
}

const RATE_SOURCES = Object.freeze({
  manual: manualRate,
});

const RATE_SOURCE_NAMES = Object.freeze(Object.keys(RATE_SOURCES));

// The one entry point for quotes. Testnet only: refuses outside sandbox.
function getQuote({ environment, asset, invoiceCurrency, policy }) {
  if (environment !== "sandbox") {
    throw new RateUnavailableError("Exchange-rate quotes are only available in sandbox so far");
  }
  const source = RATE_SOURCES[policy.rateSource];
  if (!source) {
    throw new RateUnavailableError(`The ${policy.rateSource} rate source is not available`);
  }
  const { quotedRate, source: label } = source({ asset, invoiceCurrency, policy });
  return { quotedRate, source: label, quotedAt: new Date().toISOString() };
}

module.exports = { RATE_SOURCES, RATE_SOURCE_NAMES, RateUnavailableError, getQuote };
