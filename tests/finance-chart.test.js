const request = require("supertest");
const app = require("../src/app");
const db = require("../src/db");
const { financeOverviewChart, chartLabels, FINANCE_BARS } = require("../public/financeChart");

// Chart.js skips a bar whose category label is null or undefined
// (CategoryScale.parse returns null), so every label must be real text.
const isRealLabel = (label) => typeof label === "string" && label.trim().length > 0;

let token;
const overview = async (query = "") =>
  (await request(app).get(`/api/v1/admin/finance/overview${query}`).set("Authorization", `Bearer ${token}`)).body.data[0];

beforeAll(async () => {
  const response = await request(app).post("/api/v1/auth/login").send({ email: "admin@pluglytics.local", password: "Demo123!" });
  token = response.body.data.token;
});

describe("finance overview chart", () => {
  test("turns the real finance overview into four labelled bars and a collection rate", async () => {
    const row = await overview();
    const chart = financeOverviewChart(row);

    expect(chart.labels).toEqual(["Gross billed", "Scholarships & discounts", "Net billed", "Collected"]);
    expect(chart.labels.every(isRealLabel)).toBe(true);
    expect(chart.values).toEqual([row.grossBilled, row.scholarshipsAndDiscounts, row.netBilled, row.collected]);
    expect(chart.values.every((value) => Number.isFinite(value))).toBe(true);
    expect(chart.collectionRate).toBe(row.collectionRate);
  });

  test("works for a single term too", async () => {
    const term = db.prepare("SELECT code FROM terms WHERE is_current = 1").get().code;
    const chart = financeOverviewChart(await overview(`?term=${term}`));
    expect(chart.labels.every(isRealLabel)).toBe(true);
    expect(chart.values.every((value) => value >= 0)).toBe(true);
    expect(chart.values[0]).toBeGreaterThan(0);
  });

  test("uses every bar field the endpoint returns", async () => {
    const row = await overview();
    for (const bar of FINANCE_BARS) expect(typeof row[bar.key]).toBe("number");
  });

  test("returns null when there is nothing to chart", () => {
    expect(financeOverviewChart(undefined)).toBeNull();
    expect(financeOverviewChart({ collectionRate: 50 })).toBeNull();
  });
});

describe("chartLabels", () => {
  test("keeps real labels", () => {
    expect(chartLabels([{ name: "A" }, { name: "B" }], "name", "value")).toEqual(["A", "B"]);
  });

  test("never returns an undefined label, so Chart.js does not drop the bar", () => {
    // This is the shape that made the finance widget show an axis with no bars.
    expect(chartLabels([{ billed: 100, collected: 80 }], "label", "billed")).toEqual(["billed"]);
    expect(chartLabels([{ value: 1 }, { value: 2 }], "label", "value")).toEqual(["1", "2"]);
    expect(chartLabels([{ label: null }, { label: "" }], "label", "x").every(isRealLabel)).toBe(true);
  });
});
