// Live "final amount" preview for the admin invoice form. Uses the same formula
// as computeFinalAmount() in src/pricing.js (and the final_amount column in
// src/schema.sql); tests/pricing-preview.test.js checks that they always agree.
// The server is still the one that validates and saves.
(function (root) {
  function toNumber(value) {
    const number = typeof value === "number" ? value : Number(String(value ?? "").trim() || 0);
    return Number.isFinite(number) ? number : NaN;
  }

  // final = base - scholarship - (base * discount% / 100) + platform fee + transaction fee
  function previewFinalAmount(fields) {
    const basePrice = toNumber(fields.basePrice);
    const scholarshipAmount = toNumber(fields.scholarshipAmount);
    const discountPercent = toNumber(fields.discountPercent);
    const platformFee = toNumber(fields.platformFee);
    const transactionFee = toNumber(fields.transactionFee);
    const values = [basePrice, scholarshipAmount, discountPercent, platformFee, transactionFee];
    if (values.some((value) => Number.isNaN(value))) return null;

    const discountAmount = (basePrice * discountPercent) / 100;
    const total = basePrice - scholarshipAmount - discountAmount + platformFee + transactionFee;
    return {
      basePrice,
      scholarshipAmount,
      discountAmount: Math.round(discountAmount * 100) / 100,
      fees: Math.round((platformFee + transactionFee) * 100) / 100,
      finalAmount: Math.round(total * 100) / 100,
    };
  }

  const api = { previewFinalAmount };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlugLyticsPricing = api;
})(typeof window !== "undefined" ? window : globalThis);
