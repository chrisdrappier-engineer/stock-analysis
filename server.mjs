import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const csvPath = process.env.CSV_PATH || path.join(root, "agp_mechanical_screen.csv");
const publicDir = path.join(root, "public");
const devReload = process.env.DEV_RELOAD === "1";
const reloadClients = new Set();
const numericFields = new Set([
  "market_cap_usd", "total_revenue_usd", "annual_revenue_growth_pct",
  "net_income_usd", "free_cash_flow_usd", "cash_and_short_term_investments_usd",
  "total_debt_usd", "daily_dollar_volume_usd",
]);
const fieldMeta = {
  ticker: ["Ticker", "The short symbol used to identify the stock on an exchange."],
  company_name: ["Company", "The legal or commonly reported name of the business."],
  exchange: ["Exchange", "The stock exchange where these shares primarily trade."],
  security_types: ["Security type", "The classification of the listed security."],
  sector: ["Sector", "The broad area of the economy in which the company operates."],
  market_cap_usd: ["Market cap", "The total market value of all outstanding shares."],
  total_revenue_usd: ["Revenue", "Total sales during the latest reported annual period."],
  annual_revenue_growth_pct: ["Revenue growth", "The annual percentage change in revenue."],
  net_income_usd: ["Net income", "Profit remaining after costs, interest, and taxes."],
  free_cash_flow_usd: ["Free cash flow", "Cash generated after capital investments."],
  cash_and_short_term_investments_usd: ["Cash & STI", "Cash and investments generally convertible to cash within one year."],
  total_debt_usd: ["Debt", "Total short-term and long-term borrowings."],
  daily_dollar_volume_usd: ["Daily dollar volume", "The dollar value of shares traded during the measured day."],
};
const secCompanies = new Map();

export function flattenCompanyFacts(companyFacts, ticker) {
  const facts = [];
  for (const [namespace, concepts] of Object.entries(companyFacts.facts || {})) {
    for (const [concept, detail] of Object.entries(concepts)) {
      for (const [unit, observations] of Object.entries(detail.units || {})) {
        const latest = [...observations].sort((a, b) => String(b.end || "").localeCompare(String(a.end || "")) || String(b.filed || "").localeCompare(String(a.filed || "")))[0];
        if (!latest) continue;
        facts.push({ namespace, concept, label: detail.label || concept, description: detail.description || "No taxonomy description is available.", unit, ...latest });
      }
    }
  }
  facts.sort((a, b) => a.label.localeCompare(b.label) || a.unit.localeCompare(b.unit));
  return { ticker, cik: companyFacts.cik, name: companyFacts.entityName, factCount: facts.length, facts };
}

export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted && c === '"' && text[i + 1] === '"') { field += '"'; i++; }
    else if (c === '"') quoted = !quoted;
    else if (c === "," && !quoted) { row.push(field); field = ""; }
    else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [headers, ...values] = rows;
  return values.map((cells) => Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""])));
}

export function queryRows(rows, params) {
  const search = (params.get("q") || "").trim().toLowerCase();
  const filters = [...params.entries()].filter(([key]) => key.startsWith("f."));
  let result = rows.filter((row) => {
    if (search && !Object.values(row).some((v) => String(v).toLowerCase().includes(search))) return false;
    return filters.every(([key, raw]) => {
      const [, field, op = "eq"] = key.split(".");
      if (!(field in row)) return true;
      const value = row[field];
      if (numericFields.has(field)) {
        const a = Number(value), b = Number(raw);
        if (value === "" || !Number.isFinite(a) || !Number.isFinite(b)) return false;
        return op === "min" ? a >= b : op === "max" ? a <= b : a === b;
      }
      const normalized = String(value).toLowerCase(), target = raw.toLowerCase();
      return op === "starts" ? normalized.startsWith(target) : op === "eq" ? normalized === target : normalized.includes(target);
    });
  });
  const sort = params.get("sort") || "market_cap_usd";
  const direction = params.get("dir") === "asc" ? 1 : -1;
  if (rows[0] && sort in rows[0]) result.sort((a, b) => {
    const av = numericFields.has(sort) ? Number(a[sort] || -Infinity) : a[sort].toLowerCase();
    const bv = numericFields.has(sort) ? Number(b[sort] || -Infinity) : b[sort].toLowerCase();
    return (av < bv ? -1 : av > bv ? 1 : 0) * direction;
  });
  const pageSize = Math.min(200, Math.max(10, Number(params.get("limit")) || 50));
  const page = Math.max(1, Number(params.get("page")) || 1);
  return { total: result.length, page, pageSize, rows: result.slice((page - 1) * pageSize, page * pageSize) };
}

export function aggregateField(rows, field) {
  if (!(field in fieldMeta)) return null;
  const present = rows.filter((row) => row[field] !== "");
  const missing = rows.length - present.length;
  if (!numericFields.has(field)) {
    const byValue = new Map();
    for (const row of present) {
      const value = field === "ticker" || field === "company_name" ? row[field][0].toUpperCase() : row[field];
      byValue.set(value, (byValue.get(value) || 0) + 1);
    }
    const groups = [...byValue].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label, count]) => ({
      label, count, filter: field === "ticker" || field === "company_name" ? { key: `f.${field}.starts`, value: label } : { key: `f.${field}.eq`, value: label },
    }));
    return { field, label: fieldMeta[field][0], description: fieldMeta[field][1], type: "categorical", total: rows.length, present: present.length, missing, groups };
  }
  const values = present.map((row) => Number(row[field])).filter(Number.isFinite).sort((a, b) => a - b);
  const quantile = (p) => values.length ? values[Math.min(values.length - 1, Math.floor((values.length - 1) * p))] : null;
  const cuts = [...new Set([values[0], quantile(.2), quantile(.4), quantile(.6), quantile(.8), values.at(-1)])].filter(Number.isFinite);
  const groups = cuts.slice(0, -1).map((min, i) => {
    const max = cuts[i + 1];
    const last = i === cuts.length - 2;
    const count = values.filter((v) => v >= min && (last ? v <= max : v < max)).length;
    return { min, max, count, includeMax: last };
  });
  return { field, label: fieldMeta[field][0], description: fieldMeta[field][1], type: "numeric", total: rows.length, present: values.length, missing, summary: { min: values[0] ?? null, p25: quantile(.25), median: quantile(.5), p75: quantile(.75), max: values.at(-1) ?? null }, groups };
}

export function buildDashboard(rows) {
  const value = (row, field) => row[field] === "" ? null : Number(row[field]);
  const growthData = rows.filter((row) => value(row, "annual_revenue_growth_pct") !== null);
  const candidates = growthData.filter((row) => value(row, "market_cap_usd") >= 5e8 && value(row, "market_cap_usd") <= 5e10 && value(row, "total_revenue_usd") >= 1e8 && value(row, "annual_revenue_growth_pct") >= 20 && value(row, "daily_dollar_volume_usd") >= 1e7);
  const profitable = candidates.filter((row) => value(row, "net_income_usd") > 0);
  const cashGenerating = profitable.filter((row) => value(row, "free_cash_flow_usd") > 0);
  return {
    universe: rows.length,
    funnel: [
      { label: "Liquid common equities", count: rows.length, note: "Primary U.S. listings with ≥$5M daily dollar volume" },
      { label: "Growth data available", count: growthData.length, note: "Annual revenue growth is reported" },
      { label: "Mechanical candidates", count: candidates.length, note: "$500M–$50B cap, ≥$100M revenue, ≥20% growth, ≥$10M volume" },
      { label: "Currently profitable", count: profitable.length, note: "Positive reported net income" },
      { label: "Cash-generating", count: cashGenerating.length, note: "Positive net income and free cash flow" },
    ],
    candidates: [...candidates].sort((a, b) => Number(b.annual_revenue_growth_pct) - Number(a.annual_revenue_growth_pct)).slice(0, 12),
    coverage: Object.entries(fieldMeta).map(([field, [label]]) => ({ field, label, present: rows.filter((row) => row[field] !== "").length, total: rows.length })),
  };
}

const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
const himsFactsPath = path.join(root, "data", "sec", "HIMS-companyfacts.json");
if (fs.existsSync(himsFactsPath)) secCompanies.set("HIMS", flattenCompanyFacts(JSON.parse(fs.readFileSync(himsFactsPath, "utf8")), "HIMS"));
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (devReload && url.pathname === "/__dev/reload") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    res.write("event: ready\ndata: connected\n\n");
    reloadClients.add(res);
    req.on("close", () => reloadClients.delete(res));
    return;
  }
  if (url.pathname === "/api/stocks") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(queryRows(rows, url.searchParams)));
  }
  if (url.pathname === "/api/fields") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(Object.entries(fieldMeta).map(([field, [label, description]]) => ({ field, label, description, type: numericFields.has(field) ? "numeric" : "categorical" }))));
  }
  if (url.pathname === "/api/dashboard") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(buildDashboard(rows)));
  }
  if (url.pathname.startsWith("/api/companies/") && url.pathname.endsWith("/facts")) {
    const ticker = decodeURIComponent(url.pathname.split("/")[3]).toUpperCase();
    const company = secCompanies.get(ticker);
    res.writeHead(company ? 200 : 404, { "content-type": "application/json", "cache-control": "no-store" });
    return res.end(JSON.stringify(company || { error: "SEC facts are not available for this company." }));
  }
  if (url.pathname.startsWith("/api/aggregates/")) {
    const result = aggregateField(rows, decodeURIComponent(url.pathname.slice(16)));
    res.writeHead(result ? 200 : 404, { "content-type": "application/json" });
    return res.end(JSON.stringify(result || { error: "Unknown field" }));
  }
  const requested = url.pathname === "/" || url.pathname === "/fields" || url.pathname === "/stocks" || url.pathname.startsWith("/fields/") || url.pathname.startsWith("/companies/") ? "index.html" : url.pathname.slice(1);
  const file = path.resolve(publicDir, requested);
  if (!file.startsWith(publicDir) || !fs.existsSync(file)) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
  if (devReload && requested === "index.html") {
    const client = `<script>(()=>{let opened=false,disconnected=false;const source=new EventSource('/__dev/reload');source.onopen=()=>{if(opened&&disconnected)location.reload();opened=true;disconnected=false};source.onerror=()=>{disconnected=true};source.addEventListener('reload',()=>location.reload())})()</script>`;
    return res.end(fs.readFileSync(file, "utf8").replace("</body>", `${client}</body>`));
  }
  fs.createReadStream(file).pipe(res);
});

if (devReload) {
  let timer;
  fs.watch(publicDir, { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      for (const client of reloadClients) client.write("event: reload\ndata: changed\n\n");
    }, 80);
  });
}

if (process.env.NODE_ENV !== "test") {
  server.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () => console.log("AGP Screener listening on port 3000"));
}
