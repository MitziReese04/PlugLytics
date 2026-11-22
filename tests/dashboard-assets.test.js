const request = require("supertest");
const app = require("../src/app");

// Chart.js is pinned to an exact version with Subresource Integrity, so a CDN
// update can never change the dashboard charts without a code change.
const CHART_JS_URL = "https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.min.js";
const CHART_JS_SRI = "sha384-Emf5ZVIUiarAdhkgtqK+5/Z5qIvM6QoVrS+qAVtfyZVuD5lIHrac0me485+Antp0";

describe("dashboard assets", () => {
  let html;
  let csp;

  beforeAll(async () => {
    const response = await request(app).get("/public/dashboard.html");
    expect(response.status).toBe(200);
    html = response.text;
    csp = response.headers["content-security-policy"];
  });

  test("loads Chart.js from an exact, pinned version with an integrity hash", () => {
    const tags = html.match(/<script[^>]*\/npm\/chart\.js[^>]*><\/script>/gi) || [];
    expect(tags).toHaveLength(1);
    const tag = tags[0];
    expect(tag).toContain(`src="${CHART_JS_URL}"`);
    expect(tag).toContain(`integrity="${CHART_JS_SRI}"`);
    expect(tag).toContain('crossorigin="anonymous"');
  });

  test("no script is loaded from an unpinned CDN address", () => {
    const external = [...html.matchAll(/<script[^>]*src="(https?:\/\/[^"]+)"/gi)].map((m) => m[1]);
    expect(external.length).toBeGreaterThan(0);
    for (const src of external) expect(src).toMatch(/@\d+\.\d+\.\d+\//);
  });

  test("the security policy allows the pinned Chart.js origin", () => {
    const scriptSrc = csp.split(";").map((part) => part.trim()).find((part) => part.startsWith("script-src"));
    expect(scriptSrc.split(/\s+/)).toContain(new URL(CHART_JS_URL).origin);
  });

  test("the pricing preview loads before the dashboard script", () => {
    expect(html.indexOf("pricingPreview.js")).toBeGreaterThan(-1);
    expect(html.indexOf("pricingPreview.js")).toBeLessThan(html.indexOf("app.js"));
  });

  test("the admin Stellar Payments view has the late-payment / match form", () => {
    for (const id of ["paymentFixPanel", "paymentFixForm", "submitPaymentFix"]) expect(html).toContain(`id="${id}"`);
  });

  test("the student payment panel has a Cancel button", () => {
    expect(html).toContain('id="cancelPaymentRequest"');
  });

  test("the admin webhook screen is on the page, with a one-time secret panel", () => {
    for (const id of ["adminWebhooksSection", "webhookForm", "webhookSecretPanel", "adminWebhookRows"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("the admin invoice screen is on the page", () => {
    for (const id of ["adminInvoicesSection", "invoiceForm", "invoicePreview", "newInvoiceButton"]) {
      expect(html).toContain(`id="${id}"`);
    }
  });

  test("the chart helper loads before the dashboard script", () => {
    expect(html.indexOf("financeChart.js")).toBeGreaterThan(html.indexOf(CHART_JS_URL));
    expect(html.indexOf("financeChart.js")).toBeLessThan(html.indexOf("app.js"));
  });
});
