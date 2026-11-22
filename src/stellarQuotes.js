// Exchange-rate quotes for converting an invoice amount into a Stellar asset.
// See "From invoice to payment request" in docs/stellar/payments-api.md.
//
// Only sandbox (testnet) quotes exist so far, from the "manual" rate source:
// fixed rates set in the payment policy (src/paymentPolicy.js). If none are set,
// made-up testnet rates are used. TODO: group decision on the real rate source.

class RateUnavailableError extends Error {}

function getQuote({ environment, asset, invoiceCurrency, policy }) {
  if (environment !== "sandbox") {
    throw new RateUnavailableError("Exchange-rate quotes are only available in sandbox so far");
  }
  if (policy.rateSource !== "manual") {
    throw new RateUnavailableError(`The ${policy.rateSource} rate source is not available`);
  }
  const rate = policy.manualRates[`${invoiceCurrency}:${asset}`];
  if (!rate) {
    throw new RateUnavailableError(`No manual rate is set for ${invoiceCurrency} to ${asset}`);
  }
  return {
    quotedRate: rate,
    source: policy.usingDefaultRates ? "manual-default-testnet" : "manual",
    quotedAt: new Date().toISOString(),
  };
}

module.exports = { RateUnavailableError, getQuote };
