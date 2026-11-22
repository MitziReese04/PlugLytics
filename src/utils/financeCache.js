// Short-lived cache for admin finance totals. Cleared whenever invoices change,
// so new or edited invoices show up in admin finance straight away.
const CACHE_MS = 60_000;
const financeCache = new Map();

function cachedFinance(key, build) {
  const now = Date.now();
  const cached = financeCache.get(key);
  if (cached && now - cached.time < CACHE_MS) return cached.value;
  const value = build();
  financeCache.set(key, { time: now, value });
  return value;
}

function clearFinanceCache() {
  financeCache.clear();
}

module.exports = { cachedFinance, clearFinanceCache };
