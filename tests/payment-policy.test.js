const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { loadPaymentPolicy, checkAmountLimits, DEFAULT_MANUAL_RATES, PaymentPolicyError } = require("../src/paymentPolicy");
const { getQuote, RateUnavailableError } = require("../src/stellarQuotes");

const problemsFor = (env) => {
  try {
    loadPaymentPolicy(env);
  } catch (error) {
    expect(error).toBeInstanceOf(PaymentPolicyError);
    return error.problems;
  }
  throw new Error("expected loadPaymentPolicy to fail");
};

describe("loadPaymentPolicy", () => {
  test("defaults: manual rate source, test rates, no limits, nothing decided yet", () => {
    const policy = loadPaymentPolicy({});
    expect(policy).toMatchObject({
      rateSource: "manual",
      usingDefaultRates: true,
      refundWindowDays: null,
      approvedAnchors: [],
    });
    expect(policy.manualRates).toEqual(DEFAULT_MANUAL_RATES);
    expect(policy.limits).toEqual({ XLM: { min: null, max: null }, USDC: { min: null, max: null } });
    expect(policy.refundApprovalThresholds).toEqual({ XLM: null, USDC: null });
    expect(Object.isFrozen(policy)).toBe(true);
  });

  test("the values in .env.example load without errors", () => {
    const example = dotenv.parse(fs.readFileSync(path.resolve(__dirname, "../.env.example")));
    const policy = loadPaymentPolicy(example);
    expect(policy.manualRates).toEqual({ "USD:XLM": "2.5000000", "PHP:XLM": "0.0430000" });
    expect(policy.usingDefaultRates).toBe(false);
    expect(policy.refundIssuingEnabled).toBe(false);
  });

  test("refund issuing is off unless REFUND_ISSUING_ENABLED is true", () => {
    expect(loadPaymentPolicy({}).refundIssuingEnabled).toBe(false);
    expect(loadPaymentPolicy({ REFUND_ISSUING_ENABLED: "false" }).refundIssuingEnabled).toBe(false);
    expect(loadPaymentPolicy({ REFUND_ISSUING_ENABLED: " TRUE " }).refundIssuingEnabled).toBe(true);
  });

  test("the public demo on Render never sends refunds", () => {
    const blueprint = fs.readFileSync(path.resolve(__dirname, "../render.yaml"), "utf8");
    // The value right after the REFUND_ISSUING_ENABLED key must be "false".
    const lines = blueprint.split(/\r?\n/).map((line) => line.trim());
    const key = lines.indexOf("- key: REFUND_ISSUING_ENABLED");
    expect(key).toBeGreaterThan(-1);
    expect(lines[key + 1]).toBe('value: "false"');
  });

  test("reads custom settings and normalises amounts to 7 decimals", () => {
    const policy = loadPaymentPolicy({
      PAYMENT_RATE_SOURCE: "MANUAL",
      PAYMENT_MANUAL_RATE_EUR_XLM: "2.75",
      PAYMENT_MANUAL_RATE_PHP_USDC: "0.0172",
      XLM_MIN_AMOUNT: "1",
      XLM_MAX_AMOUNT: "10000",
      USDC_MAX_AMOUNT: "500.5",
      REFUND_WINDOW_DAYS: "30",
      REFUND_APPROVAL_THRESHOLD_XLM: "1000",
      REFUND_APPROVAL_THRESHOLD_USDC: "100.25",
      APPROVED_ANCHORS: " Anchor.Example.com, pay.example.org ,anchor.example.com",
    });
    expect(policy.manualRates).toEqual({ "EUR:XLM": "2.7500000", "PHP:USDC": "0.0172000" });
    expect(policy.usingDefaultRates).toBe(false);
    expect(policy.limits.XLM).toEqual({ min: "1.0000000", max: "10000.0000000" });
    expect(policy.limits.USDC).toEqual({ min: null, max: "500.5000000" });
    expect(policy.refundWindowDays).toBe(30);
    expect(policy.refundApprovalThresholds).toEqual({ XLM: "1000.0000000", USDC: "100.2500000" });
    expect(policy.approvedAnchors).toEqual(["anchor.example.com", "pay.example.org"]);
  });

  test("empty values mean the default (not decided yet)", () => {
    const policy = loadPaymentPolicy({ XLM_MIN_AMOUNT: "  ", REFUND_WINDOW_DAYS: "", APPROVED_ANCHORS: "" });
    expect(policy.limits.XLM.min).toBeNull();
    expect(policy.refundWindowDays).toBeNull();
    expect(policy.approvedAnchors).toEqual([]);
  });

  test.each([
    ["an unknown rate source", { PAYMENT_RATE_SOURCE: "coingecko" }, "PAYMENT_RATE_SOURCE"],
    ["a badly named manual rate", { PAYMENT_MANUAL_RATE_USDXLM: "2.5" }, "PAYMENT_MANUAL_RATE_USDXLM"],
    ["a manual rate for an unknown asset", { PAYMENT_MANUAL_RATE_USD_BTC: "1" }, "PAYMENT_MANUAL_RATE_USD_BTC"],
    ["a zero manual rate", { PAYMENT_MANUAL_RATE_USD_XLM: "0" }, "PAYMENT_MANUAL_RATE_USD_XLM"],
    ["a manual rate with 8 decimals", { PAYMENT_MANUAL_RATE_USD_XLM: "2.12345678" }, "PAYMENT_MANUAL_RATE_USD_XLM"],
    ["a negative minimum", { XLM_MIN_AMOUNT: "-1" }, "XLM_MIN_AMOUNT"],
    ["a text maximum", { USDC_MAX_AMOUNT: "lots" }, "USDC_MAX_AMOUNT"],
    ["a minimum above the maximum", { XLM_MIN_AMOUNT: "100", XLM_MAX_AMOUNT: "10" }, "XLM_MIN_AMOUNT"],
    ["a zero refund window", { REFUND_WINDOW_DAYS: "0" }, "REFUND_WINDOW_DAYS"],
    ["a fractional refund window", { REFUND_WINDOW_DAYS: "7.5" }, "REFUND_WINDOW_DAYS"],
    ["a very long refund window", { REFUND_WINDOW_DAYS: "5000" }, "REFUND_WINDOW_DAYS"],
    ["a text approval threshold", { REFUND_APPROVAL_THRESHOLD_XLM: "high" }, "REFUND_APPROVAL_THRESHOLD_XLM"],
    ["a refund issuing switch that is not true or false", { REFUND_ISSUING_ENABLED: "yes" }, "REFUND_ISSUING_ENABLED"],
    ["an anchor URL instead of a domain", { APPROVED_ANCHORS: "https://anchor.example.com" }, "APPROVED_ANCHORS"],
    ["an anchor without a dot", { APPROVED_ANCHORS: "localhost" }, "APPROVED_ANCHORS"],
  ])("rejects %s and names the setting", (_, env, name) => {
    const problems = problemsFor(env);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
  });

  test("reports every invalid setting at once", () => {
    const problems = problemsFor({ PAYMENT_RATE_SOURCE: "x", XLM_MIN_AMOUNT: "-1", REFUND_WINDOW_DAYS: "abc" });
    expect(problems).toHaveLength(3);
  });
});

describe("checkAmountLimits", () => {
  const policy = loadPaymentPolicy({ XLM_MIN_AMOUNT: "1", XLM_MAX_AMOUNT: "1000" });

  test("allows amounts within the limits, including the limits themselves", () => {
    expect(checkAmountLimits(policy, "XLM", "1.0000000")).toBeNull();
    expect(checkAmountLimits(policy, "XLM", "1000.0000000")).toBeNull();
    expect(checkAmountLimits(policy, "USDC", "999999.0000000")).toBeNull();
  });

  test("explains amounts outside the limits", () => {
    expect(checkAmountLimits(policy, "XLM", "0.9999999")).toMatch(/below the minimum of 1.0000000 XLM/);
    expect(checkAmountLimits(policy, "XLM", "1000.0000001")).toMatch(/above the maximum of 1000.0000000 XLM/);
  });
});

describe("getQuote with the payment policy", () => {
  test("valid PAYMENT_RATE_SOURCE values are the rate sources registered in stellarQuotes", () => {
    const { RATE_SOURCES: registry, RATE_SOURCE_NAMES } = require("../src/stellarQuotes");
    const { RATE_SOURCES } = require("../src/paymentPolicy");
    expect(RATE_SOURCES).toEqual(RATE_SOURCE_NAMES);
    expect(Object.keys(registry)).toEqual(["manual"]);
  });

  test("uses the configured manual rate", () => {
    const policy = loadPaymentPolicy({ PAYMENT_MANUAL_RATE_USD_XLM: "3" });
    expect(getQuote({ environment: "sandbox", asset: "XLM", invoiceCurrency: "USD", policy }))
      .toMatchObject({ quotedRate: "3.0000000", source: "manual" });
  });

  test("labels the built-in test rates when none are configured", () => {
    expect(getQuote({ environment: "sandbox", asset: "XLM", invoiceCurrency: "USD", policy: loadPaymentPolicy({}) }))
      .toMatchObject({ quotedRate: "2.5000000", source: "manual-default-testnet" });
  });

  test("configured rates replace the built-in ones instead of adding to them", () => {
    const policy = loadPaymentPolicy({ PAYMENT_MANUAL_RATE_EUR_XLM: "2.7" });
    expect(() => getQuote({ environment: "sandbox", asset: "XLM", invoiceCurrency: "USD", policy }))
      .toThrow(RateUnavailableError);
  });

  test("refuses outside sandbox", () => {
    expect(() => getQuote({ environment: "production", asset: "XLM", invoiceCurrency: "USD", policy: loadPaymentPolicy({}) }))
      .toThrow(RateUnavailableError);
  });
});
