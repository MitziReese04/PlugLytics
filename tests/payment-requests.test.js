const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
// A valid Stellar public key, generated once with @stellar/stellar-sdk (Keypair.random()).
// The SDK itself is not loaded here: Jest 29 cannot load its ESM-only dependency
// (uint8array-extras), although plain Node can.
const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const HASH = (n) => n.toString(16).padStart(64, "0");

let db;
let counter = 0;

function insert(fields = {}) {
  counter += 1;
  const row = {
    id: `pay_test${counter}`,
    amount: "25.0000000",
    asset: "XLM",
    asset_issuer: null,
    memo: `PL-T${counter}`,
    destination: MERCHANT,
    expires_at: "2999-01-01T00:00:00.000Z",
    ...fields,
  };
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO payment_requests (${cols.join(",")}) VALUES (${cols.map((c) => "@" + c).join(",")})`
  ).run(row);
  return row.id;
}

const get = (id) => db.prepare("SELECT * FROM payment_requests WHERE id = ?").get(id);

beforeAll(() => {
  db = new Database(":memory:");
  db.exec(fs.readFileSync(path.resolve(__dirname, "../src/schema.sql"), "utf8"));
  db.pragma("foreign_keys = OFF");
});

afterAll(() => db.close());

describe("payment_requests table", () => {
  test("a new XLM request defaults to pending with created_at set", () => {
    const row = get(insert());
    expect(row.status).toBe("pending");
    expect(row.reason).toBeNull();
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("accepts a USDC request created from an invoice", () => {
    const row = get(insert({
      invoice_id: 1,
      amount: "38.0731500",
      asset: "USDC",
      asset_issuer: USDC_TESTNET_ISSUER,
      quoted_rate: "0.0171000",
      rate_source: "manual",
      invoice_currency: "PHP",
      invoice_amount: "2226.50",
    }));
    expect(row).toMatchObject({ amount: "38.0731500", invoice_currency: "PHP", quoted_rate: "0.0171000", invoice_amount: "2226.50" });
  });

  test.each([
    ["amount without 7 decimals", { amount: "25.00" }],
    ["amount as a plain number", { amount: "25" }],
    ["zero amount", { amount: "0.0000000" }],
    ["negative amount", { amount: "-1.0000000" }],
    ["amount with letters", { amount: "2a.0000000" }],
    ["unsupported asset", { asset: "BTC", asset_issuer: USDC_TESTNET_ISSUER }],
    ["XLM with an issuer", { asset_issuer: USDC_TESTNET_ISSUER }],
    ["USDC without an issuer", { asset: "USDC" }],
    ["memo longer than 28 characters", { memo: "M".repeat(29) }],
    ["bad destination", { destination: "not-a-stellar-key" }],
    ["unknown status", { status: "paid" }],
    ["failed without a reason", { status: "failed" }],
    ["pending with a reason", { reason: "expired" }],
    ["unknown reason", { status: "failed", reason: "dispute" }],
    ["completed without a tx hash", { status: "completed", completed_at: "2026-11-21T12:05:00.000Z" }],
    ["tx hash without amount received", { status: "completed", tx_hash: HASH(90), ledger: 5, completed_at: "2026-11-21T12:05:00.000Z" }],
    ["tx hash without ledger", { status: "completed", tx_hash: HASH(91), amount_received: "25.0000000", completed_at: "2026-11-21T12:05:00.000Z" }],
    ["amount received without 7 decimals", { status: "failed", reason: "underpaid", tx_hash: HASH(92), amount_received: "20", ledger: 5 }],
    ["invoice amount without 2 decimals", { invoice_id: 1, quoted_rate: "1", rate_source: "manual", invoice_currency: "USD", invoice_amount: "10" }],
    ["invoice without an invoice amount", { invoice_id: 1, quoted_rate: "1", rate_source: "manual", invoice_currency: "USD" }],
    ["invoice quote without a rate source", { invoice_id: 1, quoted_rate: "1", invoice_currency: "USD", invoice_amount: "10.00" }],
    ["rate source without an invoice", { rate_source: "manual" }],
    ["completed without completed_at", { status: "completed", tx_hash: HASH(1), amount_received: "25.0000000", ledger: 5 }],
    ["completed_at on a pending request", { completed_at: "2026-11-21T12:05:00.000Z" }],
    ["tx hash in the wrong format", { tx_hash: "XYZ", amount_received: "1.0000000", ledger: 5 }],
    ["invoice without a quoted rate", { invoice_id: 1, invoice_currency: "PHP", invoice_amount: "10.00" }],
    ["quoted rate without an invoice", { quoted_rate: "1.0000000", invoice_currency: "USD" }],
    ["lowercase invoice currency", { invoice_id: 1, quoted_rate: "1", rate_source: "manual", invoice_currency: "php", invoice_amount: "10.00" }],
    ["zero quoted rate", { invoice_id: 1, quoted_rate: "0", rate_source: "manual", invoice_currency: "USD", invoice_amount: "10.00" }],
    ["expiry before creation", { created_at: "2026-11-21T12:00:00.000Z", expires_at: "2026-11-21T11:00:00.000Z" }],
    ["id without the pay_ prefix", { id: "abc123" }],
  ])("rejects %s", (_, fields) => {
    expect(() => insert(fields)).toThrow(/CHECK constraint failed/);
  });

  test("memo and tx hash must be unique", () => {
    const first = get(insert({ status: "completed", tx_hash: HASH(2), amount_received: "25.0000000", ledger: 5, completed_at: "2026-11-21T12:05:00.000Z" }));
    expect(() => insert({ memo: first.memo })).toThrow(/UNIQUE constraint failed/);
    expect(() =>
      insert({ status: "completed", tx_hash: HASH(2), amount_received: "25.0000000", ledger: 6, completed_at: "2026-11-21T12:06:00.000Z" })
    ).toThrow(/UNIQUE constraint failed/);
  });

  test("a pending request can become completed or failed", () => {
    const a = insert();
    db.prepare("UPDATE payment_requests SET status = 'completed', tx_hash = ?, amount_received = '25.0000000', ledger = 7, completed_at = ? WHERE id = ?")
      .run(HASH(3), "2026-11-21T12:05:00.000Z", a);
    expect(get(a).status).toBe("completed");

    const b = insert();
    db.prepare("UPDATE payment_requests SET status = 'failed', reason = 'expired' WHERE id = ?").run(b);
    expect(get(b)).toMatchObject({ status: "failed", reason: "expired" });
  });

  test("failed and completed are final", () => {
    const failed = insert({ status: "failed", reason: "underpaid" });
    expect(() =>
      db.prepare("UPDATE payment_requests SET status = 'pending', reason = NULL WHERE id = ?").run(failed)
    ).toThrow(/status is final/);

    const completed = insert({ status: "completed", tx_hash: HASH(4), amount_received: "25.0000000", ledger: 8, completed_at: "2026-11-21T12:05:00.000Z" });
    expect(() =>
      db.prepare("UPDATE payment_requests SET status = 'failed', reason = 'cancelled' WHERE id = ?").run(completed)
    ).toThrow(/status is final/);
  });

  test("the quote is locked: amount, asset, rate, memo and destination cannot change", () => {
    const id = insert({
      invoice_id: 1, quoted_rate: "2.5000000", rate_source: "manual", invoice_currency: "USD", invoice_amount: "10.00",
    });
    for (const [column, value] of [
      ["amount", "30.0000000"],
      ["asset", "USDC"],
      ["asset_issuer", USDC_TESTNET_ISSUER],
      ["memo", "PL-CHANGED"],
      ["destination", "GAZ7EXAMPLEDESTINATIONACCOUNTFORTESTSONLY234567ABCDEFG"],
      ["quoted_rate", "3.0000000"],
      ["rate_source", "other"],
      ["invoice_id", 2],
      ["invoice_currency", "PHP"],
      ["invoice_amount", "12.00"],
    ]) {
      expect(() => db.prepare(`UPDATE payment_requests SET ${column} = ? WHERE id = ?`).run(value, id))
        .toThrow(/quote is locked/);
    }
    expect(get(id)).toMatchObject({ amount: "25.0000000", quoted_rate: "2.5000000", memo: expect.stringMatching(/^PL-T/) });

    // Settling the request is still allowed.
    db.prepare("UPDATE payment_requests SET status = 'failed', reason = 'expired' WHERE id = ?").run(id);
    expect(get(id).status).toBe("failed");
  });

  test("a follow-up payment must point to a failed request", () => {
    const failed = insert({ status: "failed", reason: "underpaid" });
    const followUp = get(insert({ amount: "5.0000000", related_payment_id: failed }));
    expect(followUp.related_payment_id).toBe(failed);

    const pending = insert();
    expect(() => insert({ related_payment_id: pending })).toThrow(/must point to a failed payment request/);
    expect(() => insert({ related_payment_id: "pay_missing" })).toThrow(/must point to a failed payment request/);
  });
});
