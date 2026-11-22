const { previewFinalAmount } = require("../public/pricingPreview");
const { computeFinalAmount } = require("../src/pricing");

// The dashboard preview must always show the same final amount the server saves.
describe("dashboard final amount preview", () => {
  test("matches computeFinalAmount for the documented example", () => {
    const fields = { basePrice: 3000, scholarshipAmount: 500, discountPercent: 10, platformFee: 25, transactionFee: 1.5 };
    expect(previewFinalAmount(fields)).toEqual({
      basePrice: 3000, scholarshipAmount: 500, discountAmount: 300, fees: 26.5, finalAmount: 2226.5,
    });
    expect(previewFinalAmount(fields).finalAmount).toBe(computeFinalAmount(fields));
  });

  test("matches computeFinalAmount across many combinations", () => {
    // Deterministic pseudo-random values, so the test is repeatable.
    let seed = 12345;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const money = (max) => Math.round(next() * max * 100) / 100;
    for (let i = 0; i < 2000; i += 1) {
      const fields = {
        basePrice: money(10000),
        scholarshipAmount: money(3000),
        discountPercent: Math.round(next() * 10000) / 100,
        platformFee: money(200),
        transactionFee: money(50),
      };
      expect(previewFinalAmount(fields).finalAmount).toBe(computeFinalAmount(fields));
    }
  });

  test("reads form values given as text, and treats empty optional fields as 0", () => {
    expect(previewFinalAmount({ basePrice: "100", scholarshipAmount: "", discountPercent: "10", platformFee: " 5 ", transactionFee: "" }).finalAmount)
      .toBe(computeFinalAmount({ basePrice: 100, discountPercent: 10, platformFee: 5 }));
  });

  test("shows negative results so the form can warn before saving", () => {
    expect(previewFinalAmount({ basePrice: 1000, scholarshipAmount: 900, discountPercent: 20 }).finalAmount).toBe(-100);
  });

  test("returns null when a field is not a number", () => {
    expect(previewFinalAmount({ basePrice: "abc" })).toBeNull();
    expect(previewFinalAmount({ basePrice: 100, platformFee: "1,5" })).toBeNull();
  });
});
