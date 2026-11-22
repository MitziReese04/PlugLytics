const crypto = require("crypto");
const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const recon = require("../src/stellarReconcile");
const { loadStellarConfig } = require("../src/stellarConfig");

const MERCHANT = "GDOW2MNFWMSTEIEWB36Y4WOXPJ4KT7JO2S47JM7TLQCBHYUG7FDLIMK4";
const PAYER = "GCUSTOMERPAYERACCOUNTFORTESTSONLY234567ABCDEFGHIJKLMNOPQ";
const EXCHANGE = "GEXCHANGESHAREDACCOUNTFORREFUNDTESTS234567ABCDEFGHIJKLMN";
const FAKE_ISSUER = "GFAKEUSDCISSUERFORRECONCILIATIONTESTS234567ABCDEFGHIJKLM";
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const FAKE_SECRET = "S" + "A".repeat(55);
const VARS = ["STELLAR_ENV", "SANDBOX_MERCHANT_PUBLIC_KEY", "SANDBOX_MERCHANT_SECRET_KEY", "SANDBOX_WEBHOOK_SIGNING_SECRET",
  "PRODUCTION_MERCHANT_PUBLIC_KEY", "PRODUCTION_MERCHANT_SECRET_KEY", "PRODUCTION_WEBHOOK_SIGNING_SECRET"];
const savedEnv = {};
function useSandbox() {
  for (const name of VARS) delete process.env[name];
  Object.assign(process.env, {
    STELLAR_ENV: "sandbox", SANDBOX_MERCHANT_PUBLIC_KEY: MERCHANT, SANDBOX_MERCHANT_SECRET_KEY: FAKE_SECRET,
    SANDBOX_WEBHOOK_SIGNING_SECRET: "test-only-server-key-reconcile",
  });
}

// The test week: Monday 5 to Sunday 11 October 2026. DAY is the busy day.
const DAY = "2026-10-06";
const at = (time, day = DAY) => `${day}T${time}Z`;
const NOW = new Date("2026-11-01T12:00:00Z");

const demoStudent = db.prepare(
  "SELECT s.id, s.school_id FROM students s JOIN users u ON u.id = s.user_id WHERE u.email = 'student@pluglytics.local'"
).get();
const anyTerm = db.prepare("SELECT id FROM terms ORDER BY id LIMIT 1").get();
const admin = db.prepare("SELECT id FROM users WHERE email = 'admin@pluglytics.local'").get();
let adminToken;
const invoiceIds = [];

// ---- a fake Horizon -------------------------------------------------------------------
const chain = [];
const transactions = new Map();
let account = null;
let seq = 0;
const hash = () => crypto.randomBytes(32).toString("hex");

function addOp({ type = "payment", from = PAYER, to = MERCHANT, amount, asset = "XLM", issuer = null, memo = null,
  time, txHash = hash(), successful = true, fee = "100", feeAccount = from }) {
  seq += 1;
  const native = asset === "XLM" && !issuer;
  const created = time;
  const ledger = Math.floor(Date.parse(created) / 5000) - 350000000;
  const transaction = {
    hash: txHash, successful, ledger, created_at: created, memo_type: memo ? "text" : "none", memo: memo || undefined,
    source_account: from, fee_account: feeAccount, fee_charged: fee,
  };
  const record = {
    id: String(seq), paging_token: `${Date.parse(created)}${String(seq).padStart(4, "0")}`, type,
    transaction_successful: successful, transaction_hash: txHash, created_at: created, transaction,
    ...(type === "create_account"
      ? { funder: from, account: to, starting_balance: amount }
      : { from, to, amount, asset_type: native ? "native" : "credit_alphanum4", asset_code: native ? undefined : asset, asset_issuer: native ? undefined : issuer }),
  };
  chain.push(record);
  transactions.set(txHash, { transaction, payments: [record] });
  return record;
}

const fetchCalls = [];
function mockHorizon() {
  return jest.spyOn(global, "fetch").mockImplementation(async (url) => {
    const u = new URL(String(url));
    fetchCalls.push(String(url));
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    const missing = { ok: false, status: 404, json: async () => ({}) };
    if (u.pathname === `/accounts/${MERCHANT}/payments`) {
      const cursor = u.searchParams.get("cursor");
      const records = chain
        .filter((r) => !cursor || BigInt(r.paging_token) > BigInt(cursor))
        .sort((a, b) => (BigInt(a.paging_token) < BigInt(b.paging_token) ? -1 : 1));
      const page = records.slice(0, 200);
      const last = page[page.length - 1];
      return ok({ _embedded: { records: page }, _links: { next: { href: `https://horizon-testnet.stellar.org/accounts/${MERCHANT}/payments?order=asc&limit=200&join=transactions&cursor=${last ? last.paging_token : ""}` } } });
    }
    if (u.pathname === `/accounts/${MERCHANT}`) return account ? ok(account) : missing;
    const tx = u.pathname.match(/^\/transactions\/([0-9a-f]{64})(\/payments)?$/);
    if (tx) {
      const found = transactions.get(tx[1]);
      if (!found) return missing;
      return ok(tx[2] ? { _embedded: { records: found.payments } } : found.transaction);
    }
    return { ok: false, status: 500, json: async () => ({}) };
  });
}

// ---- our records -------------------------------------------------------------------------
let n = 0;
function addRequest({ status = "completed", reason = null, amount = "25.0000000", received = amount, txHash = hash(),
  completedAt = at("10:00:00"), related = null, asset = "XLM" } = {}) {
  n += 1;
  const invoiceId = Number(db.prepare(
    "INSERT INTO invoices (student_id, term_id, amount, issued_at, due_at) VALUES (?, ?, 100, '2026-10-01T09:00:00Z', '2026-10-28T23:59:00Z')"
  ).run(demoStudent.id, anyTerm.id).lastInsertRowid);
  invoiceIds.push(invoiceId);
  const id = `pay_RECON${String(n).padStart(8, "0")}`;
  const memo = `PL-RC${String(n).padStart(5, "0")}`;
  const hasTx = txHash !== null;
  db.prepare(`
    INSERT INTO payment_requests (id, invoice_id, amount, asset, memo, destination, status, reason, tx_hash, amount_received,
      ledger, source_account, related_payment_id, quoted_rate, rate_source, invoice_currency, invoice_amount, created_at, expires_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '2.5000000', 'manual', 'USD', '10.00', ?, ?, ?)
  `).run(id, invoiceId, amount, asset, memo, MERCHANT, status, reason, hasTx ? txHash : null, hasTx ? received : null,
    hasTx ? 1 : null, hasTx ? PAYER : null, related, at("09:00:00"), at("09:30:00"), status === "completed" ? completedAt : null);
  return { id, memo, txHash, invoiceId };
}

function addIssuedRefund({ paymentId, amount, reason, txHash, destination = PAYER, issuedAt = at("15:00:00") }) {
  const id = `ref_RECON${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  db.prepare(`
    INSERT INTO stellar_refunds (id, payment_id, amount, asset, reason, note, status, destination, destination_source, payment_memo,
      needs_second_approval, requested_by, requested_at, approved_by, approved_at, tx_hash, ledger, issued_at)
    VALUES (?, ?, ?, 'XLM', ?, 'test', 'issued', ?, 'original_payer', 'RF-TEST0001', 0, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, paymentId, amount, reason, destination, admin.id, at("14:00:00"), admin.id, at("14:10:00"), txHash, issuedAt);
  return id;
}

const reportsFor = (kind, date) => db.prepare("SELECT * FROM settlement_reports WHERE kind = ? AND period_start = ? ORDER BY asset")
  .all(kind, `${date}T00:00:00.000Z`);
const itemsOf = (id) => db.prepare("SELECT * FROM settlement_items WHERE report_id = ? ORDER BY occurred_at, id").all(id);
const settlementEvents = () => db.prepare("SELECT * FROM webhook_events WHERE type = 'settlement.completed' ORDER BY created_at, rowid").all();
const stellar = () => loadStellarConfig();

let fx;
let endpointId;
beforeAll(async () => {
  for (const name of VARS) savedEnv[name] = process.env[name];
  useSandbox();
  adminToken = (await request(app).post("/api/v1/auth/login").send({ email: "admin@pluglytics.local", password: "Demo123!" })).body.data.token;
  endpointId = (await request(app).post("/api/v1/webhooks").set("Authorization", `Bearer ${adminToken}`)
    .send({ schoolId: demoStudent.school_id, url: "https://lms.example.edu/hooks", events: ["settlement.completed"] })).body.data.id;

  // The busy day, one example of every group.
  const exact = addRequest();
  addOp({ amount: "25.0000000", memo: exact.memo, txHash: exact.txHash, time: at("10:00:00") });
  const under = addRequest({ status: "failed", reason: "underpaid", received: "20.0000000" });
  addOp({ amount: "20.0000000", memo: under.memo, txHash: under.txHash, time: at("10:05:00") });
  const over = addRequest({ received: "30.0000000", completedAt: at("10:10:00") });
  addOp({ amount: "30.0000000", memo: over.memo, txHash: over.txHash, time: at("10:10:00") });
  const wrongAsset = addRequest({ status: "failed", reason: "wrong_asset", received: "25.0000000" });
  addOp({ amount: "25.0000000", asset: "USDC", issuer: FAKE_ISSUER, memo: wrongAsset.memo, txHash: wrongAsset.txHash, time: at("10:15:00") });
  addOp({ amount: "7.0000000", time: at("11:00:00") }); // no memo
  addOp({ amount: "1.0000000", memo: "=HYPERLINK(\"x\")", time: at("11:05:00") }); // unknown memo, formula-like
  addOp({ amount: "25.0000000", memo: exact.memo, time: at("11:10:00") }); // duplicate
  const late = addRequest({ status: "failed", reason: "expired", txHash: null });
  addOp({ amount: "25.0000000", memo: late.memo, time: at("12:00:00") }); // after expiry, not linked
  const refundTx = hash();
  const refundId = addIssuedRefund({ paymentId: over.id, amount: "5.0000000", reason: "overpaid", txHash: refundTx });
  addOp({ from: MERCHANT, to: PAYER, amount: "5.0000000", memo: "RF-TEST0001", txHash: refundTx, time: at("15:00:00") });
  addOp({ from: MERCHANT, to: EXCHANGE, amount: "50.0000000", time: at("16:00:00") }); // withdrawal, no refund record
  addOp({ amount: "9.0000000", asset: "USDC", issuer: USDC_ISSUER, time: at("17:00:00") }); // USDC without memo
  addOp({ amount: "99.0000000", memo: exact.memo, time: at("17:30:00"), successful: false }); // failed: ignored
  addOp({ amount: "3.0000000", time: at("10:00:00", "2026-10-07") }); // another day
  const missingOnChain = addRequest({ completedAt: at("18:00:00") }); // not on Horizon at all
  // Completed on DAY, but its transaction landed the day before: it belongs to that day.
  const earlier = addRequest({ completedAt: at("08:00:00") });
  addOp({ amount: "25.0000000", memo: earlier.memo, txHash: earlier.txHash, time: at("23:59:00", "2026-10-05") });
  fx = { exact, under, over, wrongAsset, late, refundId, missingOnChain, earlier };
});
beforeEach(() => {
  useSandbox();
  mockHorizon();
});
afterEach(() => jest.restoreAllMocks());
afterAll(() => {
  db.prepare("DELETE FROM settlement_items").run();
  db.prepare("DELETE FROM settlement_reports").run();
  db.prepare("DELETE FROM reconciliation_cursors").run();
  db.prepare("DELETE FROM webhook_deliveries WHERE endpoint_id = ?").run(endpointId);
  db.prepare("DELETE FROM webhook_events WHERE type = 'settlement.completed'").run();
  db.prepare("DELETE FROM webhook_endpoints WHERE id = ?").run(endpointId);
  const marks = invoiceIds.map(() => "?").join(",");
  db.prepare(`DELETE FROM stellar_refunds WHERE payment_id IN (SELECT id FROM payment_requests WHERE invoice_id IN (${marks}))`).run(...invoiceIds);
  db.prepare(`DELETE FROM payment_requests WHERE related_payment_id IS NOT NULL AND invoice_id IN (${marks})`).run(...invoiceIds);
  db.prepare(`DELETE FROM payment_requests WHERE invoice_id IN (${marks})`).run(...invoiceIds);
  db.prepare(`DELETE FROM invoices WHERE id IN (${marks})`).run(...invoiceIds);
  for (const name of VARS) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
});

describe("daily reconciliation", () => {
  let xlm;
  let items;
  beforeAll(async () => {
    useSandbox();
    const spy = mockHorizon();
    await recon.runDaily({ date: DAY, stellar: stellar(), now: NOW });
    spy.mockRestore();
    [, xlm] = [null, reportsFor("daily", DAY).find((r) => r.asset === "XLM" && !r.asset_issuer)];
    items = itemsOf(xlm.id);
  });
  const find = (pred) => items.filter(pred);

  test("sorts every payment and refund into its group", () => {
    const result = (paymentId, direction = "in") => find((it) => it.payment_id === paymentId && it.direction === direction).map((it) => it.result);
    expect(result(fx.exact.id)).toEqual(["matched", "duplicate"]);
    expect(result(fx.under.id)).toEqual(["amount_mismatch"]);
    expect(result(fx.over.id)).toEqual(["amount_mismatch"]);
    expect(result(fx.wrongAsset.id)).toEqual(["asset_mismatch"]);
    expect(result(fx.late.id)).toEqual(["unmatched_onchain"]);
    expect(result(fx.missingOnChain.id)).toEqual(["unmatched_record"]);
    expect(find((it) => it.refund_id === fx.refundId).map((it) => it.result)).toEqual(["matched"]);
    expect(find((it) => it.direction === "out" && !it.refund_id)).toEqual([expect.objectContaining({ result: "unmatched_onchain", counterparty: EXCHANGE })]);
    expect(find((it) => it.direction === "in" && !it.payment_id).map((it) => it.amount_received)).toEqual(["7.0000000", "1.0000000"]);
  });

  test("explains each exception", () => {
    const note = (pred) => find(pred)[0].note;
    expect(note((it) => it.payment_id === fx.under.id)).toMatch(/Underpaid: 20\.0000000 of 25\.0000000/);
    expect(note((it) => it.payment_id === fx.over.id && it.direction === "in")).toMatch(/Overpaid by 5\.0000000/);
    expect(note((it) => it.result === "duplicate")).toMatch(/keep the first payment and refund this one/);
    expect(note((it) => it.payment_id === fx.late.id)).toMatch(/failed, expired.*accept it as a late payment, or refund it/);
    expect(note((it) => it.result === "unmatched_record")).toMatch(/not on Horizon/);
  });

  test("ignores failed transactions, other days, and records whose transaction landed on another day", () => {
    expect(find((it) => it.amount_received === "99.0000000" || it.amount_received === "3.0000000")).toEqual([]);
    expect(find((it) => it.payment_id === fx.earlier.id)).toEqual([]);
  });

  test("the XLM report has the documented totals", () => {
    expect(recon.reportResponse(xlm)).toMatchObject({
      kind: "daily", environment: "sandbox", asset: "XLM", assetIssuer: null,
      periodStart: `${DAY}T00:00:00.000Z`, periodEnd: "2026-10-07T00:00:00.000Z",
      paymentCount: 2, grossAmount: "55.0000000", refundCount: 1, refundedAmount: "5.0000000",
      feesPaid: "0.0000200", netAmount: "50.0000000", matchedCount: 2, exceptionCount: 9, openExceptionCount: 8,
      paymentIds: [fx.exact.id, fx.over.id],
    });
    // The overpaid payment is open until the extra is refunded; here it was.
    expect(find((it) => it.payment_id === fx.over.id && it.direction === "in")[0].resolution).toBe(`Refund ${fx.refundId} issued`);
  });

  test("a payment in another asset gets its own report, per asset and issuer", () => {
    const usdc = reportsFor("daily", DAY).filter((r) => r.asset === "USDC");
    expect(usdc.map((r) => r.asset_issuer)).toEqual([USDC_ISSUER]);
    expect(recon.reportResponse(usdc[0])).toMatchObject({ paymentCount: 0, matchedCount: 0, exceptionCount: 1, feesPaid: "0.0000000" });
  });

  test("sends settlement.completed with only the school's own payments", () => {
    const events = settlementEvents().filter((e) => JSON.parse(e.body).data.periodStart === `${DAY}T00:00:00.000Z`);
    expect(events).toHaveLength(1);
    const body = JSON.parse(events[0].body);
    expect(events[0].school_id).toBe(demoStudent.school_id);
    expect(body).toMatchObject({ type: "settlement.completed", environment: "sandbox" });
    expect(body.data).toEqual({
      settlementId: xlm.id, periodStart: `${DAY}T00:00:00.000Z`, periodEnd: "2026-10-07T00:00:00.000Z",
      asset: "XLM", assetIssuer: null, paymentCount: 2, grossAmount: "55.0000000", refundCount: 1,
      refundedAmount: "5.0000000", feesPaid: "0.0000100", netAmount: "50.0000000",
      matchedCount: 2, exceptionCount: 6, paymentIds: [fx.exact.id, fx.over.id],
    });
  });

  test("a re-run keeps the report ID, and only sends again when something changed", async () => {
    const before = settlementEvents().length;
    await recon.runDaily({ date: DAY, stellar: stellar(), now: NOW });
    expect(reportsFor("daily", DAY).find((r) => r.asset === "XLM").id).toBe(xlm.id);
    expect(settlementEvents()).toHaveLength(before);

    // The underpaid request gets a completed follow-up: that exception is now resolved.
    const follow = addRequest({ related: fx.under.id, completedAt: at("10:00:00", "2026-10-08") });
    addOp({ amount: "25.0000000", memo: follow.memo, txHash: follow.txHash, time: at("10:00:00", "2026-10-08") });
    await recon.runDaily({ date: DAY, stellar: stellar(), now: NOW });
    const report = reportsFor("daily", DAY).find((r) => r.asset === "XLM");
    expect(itemsOf(report.id).find((it) => it.payment_id === fx.under.id).resolution).toBe(`Follow-up payment ${follow.id} completed`);
    expect(report.open_exception_count).toBe(7);
    expect(settlementEvents()).toHaveLength(before + 1);
  });

  test("saves where it stopped, and the next day starts from there", async () => {
    const cursor = db.prepare("SELECT * FROM reconciliation_cursors WHERE account = ?").get(MERCHANT);
    expect(cursor.record_time).toBe(at("17:30:00"));
    fetchCalls.length = 0;
    await recon.runDaily({ date: "2026-10-07", stellar: stellar(), now: NOW });
    expect(fetchCalls[0]).toContain(`cursor=${cursor.paging_token}`);
    const report = reportsFor("daily", "2026-10-07").find((r) => r.asset === "XLM");
    expect(itemsOf(report.id).map((it) => it.amount_received)).toEqual(["3.0000000"]);
  });

  test("exports the line-by-line list as CSV, safe for spreadsheets", () => {
    const csv = recon.itemsCsv(itemsOf(xlm.id)).split("\n");
    expect(csv[0]).toBe("date,paymentId,type,memo,asset,assetIssuer,amountExpected,amountReceived,transactionHash,ledger,result,direction,note,resolution");
    expect(csv[1]).toMatch(new RegExp(`^${DAY},${fx.exact.id},invoice,${fx.exact.memo},XLM,,25\\.0000000,25\\.0000000,${fx.exact.txHash},\\d+,matched,in,,$`));
    expect(csv.find((line) => line.includes("HYPERLINK"))).toContain("\"'=HYPERLINK(\"\"x\"\")\"");
  });
});

describe("weekly reconciliation", () => {
  const WEEK = "2026-10-05";
  const NEXT = "2026-10-12";
  let first;

  test("adds up the week's daily reports and sets the balance baseline", async () => {
    account = { id: MERCHANT, last_modified_ledger: 999999999, balances: [{ asset_type: "native", balance: "1000.0000000" }] };
    await recon.runWeekly({ date: "2026-10-08", stellar: stellar(), now: NOW });
    first = reportsFor("weekly", WEEK).find((r) => r.asset === "XLM");
    const dailies = db.prepare("SELECT * FROM settlement_reports WHERE kind = 'daily' AND asset = 'XLM' AND asset_issuer IS NULL AND period_start >= ? AND period_start < ?")
      .all(`${WEEK}T00:00:00.000Z`, `${NEXT}T00:00:00.000Z`);
    expect(dailies).toHaveLength(7);
    const response = recon.reportResponse(first);
    expect(response).toMatchObject({
      kind: "weekly", periodStart: `${WEEK}T00:00:00.000Z`, periodEnd: `${NEXT}T00:00:00.000Z`,
      paymentCount: dailies.reduce((a, r) => a + r.payment_count, 0),
      exceptionCount: dailies.reduce((a, r) => a + r.exception_count, 0),
      balance: { status: "baseline", actualClosingBalance: "1000.0000000", expectedClosingBalance: "1000.0000000" },
    });
    // The week's open exceptions are listed on the weekly report.
    expect(itemsOf(first.id).length).toBe(first.open_exception_count);
    expect(itemsOf(first.id).every((it) => it.result !== "matched" && !it.resolution)).toBe(true);
  });

  test("checks the next week's closing balance against the movements", async () => {
    addOp({ amount: "10.0000000", time: at("09:00:00", "2026-10-13") });
    // A refund we sent: the merchant also pays its 0.0000100 XLM fee.
    addOp({ from: MERCHANT, to: PAYER, amount: "2.0000000", time: at("09:30:00", "2026-10-13") });
    account.balances[0].balance = "1007.9999900";
    await recon.runWeekly({ date: NEXT, stellar: stellar(), now: NOW });
    const report = recon.reportResponse(reportsFor("weekly", NEXT).find((r) => r.asset === "XLM"));
    expect(report.balance).toEqual({ status: "ok", openingBalance: "1000.0000000",
      expectedClosingBalance: "1007.9999900", actualClosingBalance: "1007.9999900" });

    // Money moved that the payments list does not explain (a missing fee, say).
    account.balances[0].balance = "1007.9999800";
    await recon.runWeekly({ date: NEXT, stellar: stellar(), now: NOW });
    expect(recon.reportResponse(reportsFor("weekly", NEXT).find((r) => r.asset === "XLM")).balance)
      .toMatchObject({ status: "mismatch", expectedClosingBalance: "1007.9999900", actualClosingBalance: "1007.9999800" });
  });

  test("movements after the week (up to the balance's ledger) are taken off the current balance", async () => {
    const later = addOp({ amount: "4.0000000", time: at("09:00:00", "2026-10-20") });
    account.balances[0].balance = "1011.9999900";
    account.last_modified_ledger = later.transaction.ledger;
    await recon.runWeekly({ date: NEXT, stellar: stellar(), now: NOW });
    expect(recon.reportResponse(reportsFor("weekly", NEXT).find((r) => r.asset === "XLM")).balance)
      .toMatchObject({ status: "ok", actualClosingBalance: "1007.9999900" });
  });
});

describe("rules", () => {
  test("is refused unless STELLAR_ENV is sandbox", async () => {
    await expect(recon.runDaily({ date: DAY, stellar: { ...stellar(), env: "production" }, now: NOW }))
      .rejects.toMatchObject({ code: "RECONCILIATION_TESTNET_ONLY" });
  });

  test("a period that is not over yet is refused", async () => {
    await expect(recon.runDaily({ date: "2026-11-01", stellar: stellar(), now: NOW })).rejects.toMatchObject({ code: "PERIOD_NOT_OVER" });
    await expect(recon.runWeekly({ date: "2026-10-28", stellar: stellar(), now: NOW })).rejects.toMatchObject({ code: "PERIOD_NOT_OVER" });
  });

  test("periods are UTC days and Monday-to-Sunday weeks", () => {
    expect(recon.dayPeriod("2026-10-06")).toEqual({ start: "2026-10-06T00:00:00.000Z", end: "2026-10-07T00:00:00.000Z" });
    expect(recon.weekPeriod("2026-10-11")).toEqual({ start: "2026-10-05T00:00:00.000Z", end: "2026-10-12T00:00:00.000Z" });
    expect(recon.yesterday(new Date("2026-11-22T00:05:00Z"))).toBe("2026-11-21");
    expect(recon.lastWeekMonday(new Date("2026-11-23T00:05:00Z"))).toBe("2026-11-16");
    expect(() => recon.dayPeriod("2026-02-30")).toThrow(/not a date/);
  });
});

describe("settlement API", () => {
  const api = (method, path, token = adminToken) => request(app)[method](`/api/v1/settlements${path}`).set("Authorization", `Bearer ${token}`);

  test("lists reports and shows one with its items", async () => {
    const list = (await api("get", "?kind=daily&asset=XLM&from=2026-10-06&to=2026-10-06")).body;
    expect(list.data).toHaveLength(1);
    expect(list.data[0]).toMatchObject({ kind: "daily", asset: "XLM", periodStart: `${DAY}T00:00:00.000Z` });
    const one = (await api("get", `/${list.data[0].settlementId}`)).body.data;
    expect(one.items.length).toBe(one.matchedCount + one.exceptionCount);
    expect(one.items.find((it) => it.result === "unmatched_record")).toMatchObject({ open: true, overdue: true, ageDays: expect.any(Number) });
    expect((await api("get", "/set_NOPE")).body.error.code).toBe("SETTLEMENT_NOT_FOUND");
  });

  test("downloads a report's items as CSV", async () => {
    const id = (await api("get", "?kind=daily&asset=XLM&from=2026-10-06&to=2026-10-06")).body.data[0].settlementId;
    const response = await api("get", `/${id}/items.csv`);
    expect(response.headers["content-type"]).toMatch(/text\/csv/);
    expect(response.headers["content-disposition"]).toContain(`${id}-daily-XLM-${DAY}.csv`);
    expect(response.text.split("\n")[0]).toMatch(/^date,paymentId,type,memo/);
  });

  test("runs a reconciliation by hand", async () => {
    const response = await api("post", "/run").send({ kind: "daily", date: "2026-10-09" });
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ kind: "daily", asset: "XLM", runSource: "dashboard", periodStart: "2026-10-09T00:00:00.000Z" });
    expect(response.body.meta).toMatchObject({ kind: "daily", date: "2026-10-09" });
    expect((await api("post", "/run").send({ kind: "monthly" })).status).toBe(400);
    expect((await api("post", "/run").send({ kind: "daily", date: "2999-01-01" })).body.error.code).toBe("PERIOD_NOT_OVER");
  });

  test("is admin only, and not available to customer API keys", async () => {
    const student = (await request(app).post("/api/v1/auth/login").send({ email: "student@pluglytics.local", password: "Demo123!" })).body.data.token;
    expect((await api("get", "", student)).status).toBe(403);
    expect((await request(app).get("/api/v1/settlements")).status).toBe(401);
    const key = (await request(app).post("/api/v1/api-keys").set("Authorization", `Bearer ${adminToken}`)
      .send({ schoolId: demoStudent.school_id, name: "Settlement test" })).body.data;
    expect((await request(app).get("/api/v1/settlements").set("X-PlugLytics-Api-Key", key.key)).body.error.code).toBe("API_KEY_READ_ONLY");
    db.prepare("DELETE FROM api_keys WHERE id = ?").run(key.id);
  });
});
