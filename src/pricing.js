const { z } = require("zod");

const SCHOLARSHIP_TYPES = ["merit", "need_based", "sponsored", "other"];

const nonNegativeAmount = z.number().finite().nonnegative();

// API-side validation for invoice pricing. The database enforces the same
// rules with CHECK constraints on the invoices table (see src/schema.sql).
const pricingSchema = z
  .object({
    basePrice: nonNegativeAmount,
    scholarshipAmount: nonNegativeAmount.default(0),
    scholarshipType: z.enum(SCHOLARSHIP_TYPES).nullable().default(null),
    discountPercent: z.number().finite().min(0).max(100).default(0),
    discountCode: z.string().trim().min(1).max(50).nullable().default(null),
    platformFee: nonNegativeAmount.default(0),
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

module.exports = { SCHOLARSHIP_TYPES, pricingSchema, computeFinalAmount };
