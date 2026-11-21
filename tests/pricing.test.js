const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { pricingSchema, computeFinalAmount } = require("../src/pricing");

const valid = {
  basePrice: 3000,
  scholarshipAmount: 500,
  scholarshipType: "merit",
  discountPercent: 10,
  discountCode: "EARLY10",
  platformFee: 25,
  transactionFee: 1.5,
  instructorCost: 800,
};

describe("computeFinalAmount", () => {
  test("subtracts scholarship and discount, then adds fees", () => {
    // 3000 - 500 - 300 + 25 + 1.5
    expect(computeFinalAmount(valid)).toBe(2226.5);
  });

  test("ignores instructorCost", () => {
    expect(computeFinalAmount({ ...valid, instructorCost: 99999 })).toBe(2226.5);
  });

  test("defaults to the base price when no pricing fields are set", () => {
    expect(computeFinalAmount({ basePrice: 2500 })).toBe(2500);
  });
});

describe("pricingSchema", () => {
  test("accepts valid pricing and fills defaults", () => {
    const parsed = pricingSchema.parse({ basePrice: 2500 });
    expect(parsed).toMatchObject({
      scholarshipAmount: 0,
      scholarshipType: null,
      discountPercent: 0,
      platformFee: 0,
      transactionFee: 0,
      instructorCost: 0,
    });
    expect(pricingSchema.safeParse(valid).success).toBe(true);
  });

  test.each([
    "basePrice", "scholarshipAmount", "platformFee", "transactionFee", "instructorCost",
  ])("rejects a negative %s", (field) => {
    expect(pricingSchema.safeParse({ ...valid, [field]: -1 }).success).toBe(false);
  });

  test.each([-1, 100.5, 150])("rejects discountPercent %p", (discountPercent) => {
    expect(pricingSchema.safeParse({ ...valid, discountPercent }).success).toBe(false);
  });

  test.each([0, 100])("accepts discountPercent %p", (discountPercent) => {
    expect(
      pricingSchema.safeParse({ ...valid, scholarshipAmount: 0, discountPercent }).success
    ).toBe(true);
  });

  test("requires scholarshipType when there is a scholarship", () => {
    const result = pricingSchema.safeParse({ ...valid, scholarshipType: null });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(["scholarshipType"]);
  });

  test("rejects a scholarship and discount larger than the price plus fees", () => {
    const result = pricingSchema.safeParse({
      basePrice: 1000, scholarshipAmount: 900, scholarshipType: "need_based", discountPercent: 20,
    });
    expect(result.success).toBe(false);
    expect(result.error.issues[0].path).toEqual(["finalAmount"]);
  });

  test("rejects unknown fields and scholarship types", () => {
    expect(pricingSchema.safeParse({ ...valid, finalAmount: 1 }).success).toBe(false);
    expect(pricingSchema.safeParse({ ...valid, scholarshipType: "lottery" }).success).toBe(false);
  });
});

describe("invoices table pricing columns", () => {
  let db;
  const insert = (fields) => {
    const row = {
      student_id: 1, term_id: 1, amount: 3000, issued_at: "2026-01-01", due_at: "2026-01-28", ...fields,
    };
    const cols = Object.keys(row);
    return db
      .prepare(`INSERT INTO invoices (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`)
      .run(row).lastInsertRowid;
  };

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec(fs.readFileSync(path.resolve(__dirname, "../src/schema.sql"), "utf8"));
    db.pragma("foreign_keys = OFF");
  });

  afterAll(() => db.close());

  test("final_amount matches computeFinalAmount", () => {
    const id = insert({
      scholarship_amount: 500, scholarship_type: "merit", discount_percent: 10,
      discount_code: "EARLY10", platform_fee: 25, transaction_fee: 1.5, instructor_cost: 800,
    });
    const row = db.prepare("SELECT final_amount FROM invoices WHERE id = ?").get(id);
    expect(row.final_amount).toBe(computeFinalAmount(valid));
  });

  test.each([
    ["negative amount", { amount: -1 }],
    ["negative scholarship", { scholarship_amount: -1, scholarship_type: "merit" }],
    ["negative platform fee", { platform_fee: -1 }],
    ["negative transaction fee", { transaction_fee: -1 }],
    ["negative instructor cost", { instructor_cost: -1 }],
    ["discount over 100", { discount_percent: 101 }],
    ["negative discount", { discount_percent: -5 }],
    ["scholarship without a type", { scholarship_amount: 100 }],
    ["unknown scholarship type", { scholarship_amount: 100, scholarship_type: "lottery" }],
    ["negative final amount", { scholarship_amount: 2900, scholarship_type: "merit", discount_percent: 50 }],
  ])("rejects %s", (_, fields) => {
    expect(() => insert(fields)).toThrow(/CHECK constraint failed/);
  });
});

describe("invoice currency", () => {
  const { pricingSchema: schema } = require("../src/pricing");

  test("defaults to USD and accepts 3-letter codes", () => {
    expect(schema.parse({ basePrice: 100 }).currency).toBe("USD");
    expect(schema.parse({ basePrice: 100, currency: "PHP" }).currency).toBe("PHP");
  });

  test.each(["php", "PH", "PESO", "", "US1"])("rejects currency %p", (currency) => {
    expect(schema.safeParse({ basePrice: 100, currency }).success).toBe(false);
  });

  test("the invoices table rejects a bad currency and defaults to USD", () => {
    const memory = new Database(":memory:");
    memory.exec(fs.readFileSync(path.resolve(__dirname, "../src/schema.sql"), "utf8"));
    memory.pragma("foreign_keys = OFF");
    const insert = memory.prepare(
      "INSERT INTO invoices (student_id, term_id, amount, currency, issued_at, due_at) VALUES (1, 1, 100, ?, '2026-01-01', '2026-01-28')"
    );
    expect(() => insert.run("php")).toThrow(/CHECK constraint failed/);
    expect(() => insert.run("PESO")).toThrow(/CHECK constraint failed/);
    expect(() => insert.run("U1D")).toThrow(/CHECK constraint failed/);
    insert.run("PHP");
    memory.prepare(
      "INSERT INTO invoices (student_id, term_id, amount, issued_at, due_at) VALUES (1, 1, 100, '2026-01-01', '2026-01-28')"
    ).run();
    expect(memory.prepare("SELECT currency FROM invoices ORDER BY id").all().map((r) => r.currency)).toEqual(["PHP", "USD"]);
    memory.close();
  });
});

describe("toAssetAmount", () => {
  const { toAssetAmount } = require("../src/pricing");

  test.each([
    [2226.5, "0.0171000", "38.0731500"],
    [10, "2.5", "25.0000000"],
    [25, "1.0000000", "25.0000000"],
    [0.1, "3", "0.3000000"],
    [0, "1", "0.0000000"],
    [1, "0.0000001", "0.0000001"],
    [0.01, "0.000005", "0.0000001"], // 0.00000005 rounds half up
    [0.01, "0.000004", "0.0000000"], // 0.00000004 rounds down
  ])("converts %p at rate %p to %p", (finalAmount, rate, expected) => {
    expect(toAssetAmount(finalAmount, rate)).toBe(expected);
  });

  test.each([
    [10, "0"],
    [10, "-1"],
    [10, "1.12345678"],
    [10, "abc"],
    [10, 2.5],
    [-1, "1"],
    [Number.NaN, "1"],
  ])("rejects finalAmount %p with rate %p", (finalAmount, rate) => {
    expect(() => toAssetAmount(finalAmount, rate)).toThrow(RangeError);
  });
});

describe("payments table", () => {
  test("does not accept scholarships as a payment method", () => {
    const memory = new Database(":memory:");
    memory.exec(fs.readFileSync(path.resolve(__dirname, "../src/schema.sql"), "utf8"));
    memory.pragma("foreign_keys = OFF");
    const insert = memory.prepare("INSERT INTO payments (invoice_id, amount, method, paid_at) VALUES (1, 100, ?, '2026-01-01')");
    expect(() => insert.run("scholarship")).toThrow(/CHECK constraint failed/);
    for (const method of ["cash", "card", "bank"]) {
      expect(() => insert.run(method)).not.toThrow();
    }
    memory.close();
  });
});
