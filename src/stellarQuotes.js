// Exchange-rate quotes for converting an invoice amount into a Stellar asset.
// See "From invoice to payment request" in docs/stellar/payments-api.md.
//
// Only sandbox (testnet) quotes exist so far. Testnet XLM has no real value, so
// these are FIXED, MADE-UP rates for testing, not market prices.
// TODO: choose a real rate source before production and record it with each quote.

// XLM per 1 unit of the invoice currency, as 7-decimal strings.
const SANDBOX_XLM_RATES = Object.freeze({
  USD: "2.5000000",
  PHP: "0.0430000",
});

class RateUnavailableError extends Error {}

function getQuote({ environment, asset, invoiceCurrency }) {
  if (environment !== "sandbox") {
    throw new RateUnavailableError("Exchange-rate quotes are only available in sandbox so far");
  }
  const rate = asset === "XLM" ? SANDBOX_XLM_RATES[invoiceCurrency] : undefined;
  if (!rate) {
    throw new RateUnavailableError(`No sandbox rate for ${invoiceCurrency} to ${asset}`);
  }
  return { quotedRate: rate, source: "sandbox-fixed", quotedAt: new Date().toISOString() };
}

module.exports = { SANDBOX_XLM_RATES, RateUnavailableError, getQuote };
