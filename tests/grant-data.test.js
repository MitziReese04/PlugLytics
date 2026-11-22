const plan = require("../docs/stellar/pilot-budget-and-grant.json");

const DATE = /^(TODO-YYYY-MM-DD|\d{4}-\d{2}-\d{2})$/;
const sum = (values) => Math.round(values.reduce((a, b) => a + b, 0) * 100) / 100;
const isRealDate = (value) =>
  value === "TODO-YYYY-MM-DD" || new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

describe("pilot budget and grant data", () => {
  test("money values are non-negative numbers", () => {
    const amounts = [plan.grant.amount, plan.otherFunding.amount, ...plan.budgetCategories.map((c) => c.amount)];
    for (const amount of amounts) {
      expect(typeof amount).toBe("number");
      expect(amount).toBeGreaterThanOrEqual(0);
    }
  });

  test("category amounts add up to the grant plus other funding", () => {
    expect(sum(plan.budgetCategories.map((c) => c.amount))).toBe(
      sum([plan.grant.amount, plan.otherFunding.amount])
    );
  });

  test("suggested category shares add up to 100%", () => {
    expect(sum(plan.budgetCategories.map((c) => c.suggestedSharePercent))).toBe(100);
  });

  test("milestone budget shares add up to 100%", () => {
    expect(sum(plan.milestones.map((m) => m.budgetSharePercent))).toBe(100);
  });

  test("milestones have a known status and unique IDs", () => {
    const ids = plan.milestones.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const milestone of plan.milestones) {
      expect(plan.milestoneStatuses).toContain(milestone.status);
      expect(milestone.name).toBeTruthy();
      expect(milestone.deliverable).toBeTruthy();
    }
  });

  test("every date is a valid YYYY-MM-DD or a TODO placeholder", () => {
    const dates = [
      plan.grant.awardDate,
      plan.grant.grantStartDate,
      plan.grant.grantEndDate,
      ...plan.milestones.map((m) => m.targetDate),
      ...plan.reports.map((r) => r.dueDate),
    ];
    for (const date of dates) {
      expect(date).toMatch(DATE);
      expect(isRealDate(date)).toBe(true);
    }
  });

  test("reports refer to existing milestones and say what they cover", () => {
    const ids = new Set(plan.milestones.map((m) => m.id));
    for (const report of plan.reports) {
      expect(report.covers.length).toBeGreaterThan(0);
      for (const milestoneId of report.milestones) {
        expect(ids.has(milestoneId)).toBe(true);
      }
    }
  });
});
