// Runs a reconciliation by hand (see docs/stellar/settlement.md). Read-only: it
// never sends money. Testnet only (STELLAR_ENV=sandbox).
//
//   npm run reconcile                         daily, for yesterday (UTC)
//   npm run reconcile -- daily 2026-11-21     daily, for that day
//   npm run reconcile -- weekly 2026-11-16    weekly, for the week that contains that day
//   npm run reconcile -- weekly               weekly, for last week
const { loadStellarConfig } = require("../src/stellarConfig");
const recon = require("../src/stellarReconcile");
const db = require("../src/db");

async function main() {
  const [kind = "daily", date] = process.argv.slice(2);
  if (!["daily", "weekly"].includes(kind)) throw new Error('Usage: npm run reconcile -- [daily|weekly] [YYYY-MM-DD]');
  // Fails with a message that names missing settings, never their values.
  const stellar = loadStellarConfig();
  const day = date || (kind === "daily" ? recon.yesterday() : recon.lastWeekMonday());
  const run = kind === "daily" ? recon.runDaily : recon.runWeekly;
  const ids = await run({ date: day, stellar, runSource: "command" });

  console.log(`${kind} reconciliation (${stellar.env}) for ${day}:`);
  for (const id of ids) {
    const r = recon.reportResponse(db.prepare("SELECT * FROM settlement_reports WHERE id = ?").get(id));
    console.log(`  ${r.settlementId}  ${r.asset}${r.assetIssuer ? ` (${r.assetIssuer.slice(0, 6)}…)` : ""}`
      + `  payments ${r.paymentCount}, gross ${r.grossAmount}, refunds ${r.refundCount} (${r.refundedAmount}),`
      + ` fees ${r.feesPaid}, net ${r.netAmount}; matched ${r.matchedCount}, exceptions ${r.exceptionCount}`
      + ` (${r.openExceptionCount} open)${r.balance ? `; balance ${r.balance.status}` : ""}`);
  }
  const open = ids.map((id) => db.prepare("SELECT open_exception_count n FROM settlement_reports WHERE id = ?").get(id).n)
    .reduce((a, b) => a + b, 0);
  if (open) console.log(`${open} open exception(s): review them in the dashboard (Settlement reports).`);
}

main().then(() => {
  // Exit even if a webhook delivery is still scheduled; the server's worker sends it.
  process.exit(0);
}).catch((error) => {
  console.error(`Reconciliation failed: ${error.message}`);
  process.exit(1);
});
