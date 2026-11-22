// Builds the admin "Finance overview" chart from one /admin/finance/overview row.
// Every bar gets a text label: Chart.js drops bars whose category label is
// undefined (CategoryScale.parse returns null), which is why the widget used to
// show an axis with no bars. Loaded by dashboard.html and required by the tests.
(function (root) {
  const FINANCE_BARS = [
    { key: "grossBilled", label: "Gross billed" },
    { key: "scholarshipsAndDiscounts", label: "Scholarships & discounts" },
    { key: "netBilled", label: "Net billed" },
    { key: "collected", label: "Collected" },
  ];

  function financeOverviewChart(row) {
    if (!row || typeof row !== "object") return null;
    const bars = FINANCE_BARS.filter((bar) => typeof row[bar.key] === "number" && Number.isFinite(row[bar.key]));
    if (!bars.length) return null;
    return {
      labels: bars.map((bar) => bar.label),
      values: bars.map((bar) => row[bar.key]),
      keys: bars.map((bar) => bar.key),
      collectionRate: typeof row.collectionRate === "number" ? row.collectionRate : null,
    };
  }

  // A label for every row, so no bar is ever dropped for having no label.
  function chartLabels(rows, labelKey, fallback) {
    return rows.map((row, index) => {
      const value = row[labelKey];
      if (value !== undefined && value !== null && value !== "") return String(value);
      return rows.length === 1 ? String(fallback) : String(index + 1);
    });
  }

  const api = { FINANCE_BARS, financeOverviewChart, chartLabels };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlugLyticsCharts = api;
})(typeof window !== "undefined" ? window : globalThis);
