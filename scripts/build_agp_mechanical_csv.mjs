import fs from "node:fs";

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  throw new Error("Usage: node build_agp_mechanical_csv.mjs INPUT.json OUTPUT.csv");
}

const payload = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const headers = [
  "ticker",
  "company_name",
  "exchange",
  "security_types",
  "sector",
  "market_cap_usd",
  "total_revenue_usd",
  "annual_revenue_growth_pct",
  "net_income_usd",
  "free_cash_flow_usd",
  "cash_and_short_term_investments_usd",
  "total_debt_usd",
  "daily_dollar_volume_usd",
];

const escapeCsv = (value) => {
  if (value === null || value === undefined) return "";
  const text = Array.isArray(value) ? value.join("|") : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

const rows = payload.data.map(({ d }) => [
  d[0],
  d[1],
  d[2],
  d[12],
  d[11],
  d[3],
  d[4],
  d[5],
  d[6],
  d[7],
  d[8],
  d[9],
  d[10],
]);

const csv = [headers, ...rows]
  .map((row) => row.map(escapeCsv).join(","))
  .join("\n");

fs.writeFileSync(outputPath, `${csv}\n`);
