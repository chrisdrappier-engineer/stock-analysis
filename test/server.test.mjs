import test from "node:test";
import assert from "node:assert/strict";
process.env.NODE_ENV = "test";
const { parseCsv, queryRows, aggregateField, buildDashboard, flattenCompanyFacts } = await import("../server.mjs");

test("parses quoted CSV", () => {
  assert.deepEqual(parseCsv('ticker,company_name\nABC,"Alpha, Inc."\n'), [{ ticker: "ABC", company_name: "Alpha, Inc." }]);
});

test("aggregates categorical and numeric fields", () => {
  const rows = [{ sector:"Tech", market_cap_usd:"10" }, { sector:"Tech", market_cap_usd:"20" }, { sector:"Energy", market_cap_usd:"30" }];
  assert.equal(aggregateField(rows, "sector").groups[0].count, 2);
  assert.equal(aggregateField(rows, "market_cap_usd").summary.median, 20);
});

test("builds the mechanical research funnel", () => {
  const row = { market_cap_usd:"1000000000", total_revenue_usd:"200000000", annual_revenue_growth_pct:"30", daily_dollar_volume_usd:"20000000", net_income_usd:"10", free_cash_flow_usd:"5" };
  const dashboard = buildDashboard([row]);
  assert.equal(dashboard.funnel[2].count, 1);
  assert.equal(dashboard.funnel[4].count, 1);
});

test("selects the latest observation for each SEC fact", () => {
  const input = { cik:1, entityName:"Example", facts:{ "us-gaap":{ Revenue:{ label:"Revenue", description:"Sales", units:{ USD:[{ end:"2024-12-31", val:1 },{ end:"2025-12-31", val:2 }] } } } } };
  assert.equal(flattenCompanyFacts(input, "EX").facts[0].val, 2);
});

test("searches, filters, and sorts", () => {
  const rows = [
    { ticker: "AAA", sector: "Tech", market_cap_usd: "10" },
    { ticker: "BBB", sector: "Energy", market_cap_usd: "20" },
  ];
  const params = new URLSearchParams("q=b&f.market_cap_usd.min=15&sort=ticker&dir=asc");
  assert.deepEqual(queryRows(rows, params).rows.map((r) => r.ticker), ["BBB"]);
});
