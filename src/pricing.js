const { z } = require("zod");

const SCHOLARSHIP_TYPES = ["merit", "need_based", "sponsored", "other"];

const nonNegativeAmount = z.number().finite().nonnegative();
const currencyCode = z.string().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO 4217 code, such as USD or PHP");

// Stellar amounts (and quoted rates) are strings with up to 7 decimal places.
const STELLAR_DECIMALS = 7;
const DECIMAL_STRING = /^\d+(\.\d{1,7})?$/;

// API-side validation for invoice pricing. The database enforces the same
// rules with CHECK constraints on the invoices table (see src/schema.sql).
const pricingSchema = z
  .object({
    basePrice: nonNegativeAmount,
    currency: currencyCode.default("USD"),
    scholarshipAmount: nonNegativeAmount.default(0),
    scholarshipType: z.enum(SCHOLARSHIP_TYPES).nullable().default(null),
    discountPercent: z.number().finite().min(0).max(100).default(0),
    discountCode: z.string().trim().min(1).max(50).nullable().default(null),
    platformFee: nonNegativeAmount.default(0),
    // PlugLytics's own processing fee. Not the Stellar network fee (paid by the
    // sender of each transaction) and not anchor fees (paid by the payer to the
    // anchor); neither of those is ever added to the final amount.
    transactionFee: nonNegativeAmount.default(0),
    instructorCost: nonNegativeAmount.default(0),
  })
  .strict()
  .superRefine((pricing, ctx) => {
    if (pricing.scholarshipAmount > 0 && pricing.scholarshipType === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scholarshipType"],
        message: "scholarshipType is required when scholarshipAmount is greater than 0",
      });
    }
    if (computeFinalAmount(pricing) < 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finalAmount"],
        message: "scholarship and discount cannot exceed the base price plus fees",
      });
    }
  });

// final = base - scholarship - (base * discount% / 100) + platform fee + transaction fee.
// instructorCost is the school's cost, not part of what the student pays.
// Must match the final_amount generated column in src/schema.sql.
function computeFinalAmount({
  basePrice,
  scholarshipAmount = 0,
  discountPercent = 0,
  platformFee = 0,
  transactionFee = 0,
}) {
  const discountAmount = (basePrice * discountPercent) / 100;
  const total = basePrice - scholarshipAmount - discountAmount + platformFee + transactionFee;
  return Math.round(total * 100) / 100;
}

function toScaledInteger(value, decimals) {
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole + fraction.padEnd(decimals, "0"));
}

function formatScaled(scaled, decimals) {
  const digits = scaled.toString().padStart(decimals + 1, "0");
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

// Converts an invoice finalAmount (2 decimals, in the invoice currency) into an
// amount of the Stellar asset. quotedRate = asset units per 1 unit of the invoice
// currency, as a decimal string. Uses integer math (no floating-point errors),
// rounds half up to 7 decimals, and returns a string such as "38.0731500".
function toAssetAmount(finalAmount, quotedRate) {
  if (!Number.isFinite(finalAmount) || finalAmount < 0) {
    throw new RangeError("finalAmount must be a non-negative number");
  }
  if (
    typeof quotedRate !== "string" ||
    !DECIMAL_STRING.test(quotedRate) ||
    toScaledInteger(quotedRate, STELLAR_DECIMALS) === 0n
  ) {
    throw new RangeError("quotedRate must be a positive decimal string with up to 7 decimal places");
  }
  const cents = BigInt(Math.round(finalAmount * 100));
  const product = cents * toScaledInteger(quotedRate, STELLAR_DECIMALS); // scaled by 10^9
  const rounded = (product + 50n) / 100n; // scaled by 10^7, rounded half up
  return formatScaled(rounded, STELLAR_DECIMALS);
}

module.exports = { SCHOLARSHIP_TYPES, STELLAR_DECIMALS, pricingSchema, computeFinalAmount, toAssetAmount };
