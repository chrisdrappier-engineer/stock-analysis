import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { scanZip } from "./sec-bulk-ingest.mjs";

const SCHEMA_VERSION = "1";

const sql = (value) => value === undefined || value === null
  ? "NULL"
  : `'${String(value).replaceAll("'", "''")}'`;
const bool = (value) => value === undefined || value === null ? "NULL" : value ? "1" : "0";
const json = (value) => value === undefined ? null : JSON.stringify(value);
const cik = (value) => String(value ?? "").replace(/^0+/, "").padStart(10, "0");

function aligned(rows, index, key) {
  const values = rows?.[key];
  return Array.isArray(values) ? values[index] : null;
}

async function sha256File(filename) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => fs.createReadStream(filename)
    .on("data", (chunk) => hash.update(chunk))
    .on("error", reject)
    .on("end", resolve));
  return hash.digest("hex");
}

class SqliteWriter {
  constructor(filename, batchSize) {
    this.batchSize = batchSize;
    this.pending = 0;
    this.stderr = "";
    this.child = spawn("sqlite3", ["-batch", "-bail", filename], { stdio: ["pipe", "ignore", "pipe"] });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.exited = new Promise((resolve) => this.child.on("close", resolve));
  }

  async write(statement) {
    if (!this.child.stdin.write(`${statement}\n`)) await new Promise((resolve) => this.child.stdin.once("drain", resolve));
  }

  async row(statement) {
    await this.write(statement);
    this.pending++;
    if (this.pending >= this.batchSize) {
      await this.write("COMMIT; BEGIN IMMEDIATE;");
      this.pending = 0;
    }
  }

  async close() {
    await this.write("COMMIT;");
    this.child.stdin.end();
    const code = await this.exited;
    if (code !== 0) throw new Error(`sqlite3 failed (${code}): ${this.stderr.trim()}`);
  }
}

const schema = `
.bail on
PRAGMA foreign_keys=ON;
PRAGMA journal_mode=OFF;
PRAGMA synchronous=OFF;
CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  collection TEXT NOT NULL UNIQUE,
  archive_filename TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  archive_bytes INTEGER NOT NULL
);
CREATE TABLE companies (
  cik TEXT PRIMARY KEY,
  entity_name TEXT,
  entity_type TEXT,
  sic TEXT,
  sic_description TEXT,
  owner_org TEXT,
  fiscal_year_end TEXT,
  state_of_incorporation TEXT,
  state_of_incorporation_description TEXT,
  insider_transaction_for_owner_exists INTEGER,
  insider_transaction_for_issuer_exists INTEGER,
  ein TEXT,
  phone TEXT,
  flags TEXT,
  former_names_json TEXT,
  addresses_json TEXT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_entry TEXT NOT NULL
);
CREATE TABLE company_tickers (
  cik TEXT NOT NULL REFERENCES companies(cik) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  ticker TEXT NOT NULL,
  exchange TEXT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_entry TEXT NOT NULL,
  PRIMARY KEY (cik, ordinal),
  UNIQUE (cik, ticker, exchange)
);
CREATE TABLE filings (
  cik TEXT NOT NULL REFERENCES companies(cik) ON DELETE CASCADE,
  accession TEXT NOT NULL,
  filing_date TEXT,
  report_date TEXT,
  acceptance_datetime TEXT,
  act TEXT,
  form TEXT,
  file_number TEXT,
  film_number TEXT,
  items TEXT,
  size INTEGER,
  is_xbrl INTEGER,
  is_inline_xbrl INTEGER,
  primary_document TEXT,
  primary_doc_description TEXT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_entry TEXT NOT NULL,
  PRIMARY KEY (cik, accession)
);
CREATE TABLE filing_history_files (
  cik TEXT NOT NULL REFERENCES companies(cik) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  filing_count INTEGER,
  filing_from TEXT,
  filing_to TEXT,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_entry TEXT NOT NULL,
  PRIMARY KEY (cik, filename)
);
CREATE TABLE facts (
  observation_key TEXT PRIMARY KEY,
  cik TEXT NOT NULL REFERENCES companies(cik) ON DELETE CASCADE,
  namespace TEXT NOT NULL,
  concept TEXT NOT NULL,
  label TEXT,
  description TEXT,
  unit TEXT NOT NULL,
  period TEXT,
  period_start TEXT,
  period_end TEXT,
  fiscal_year INTEGER,
  fiscal_period TEXT,
  form TEXT,
  accession TEXT,
  filed TEXT,
  frame TEXT,
  value TEXT,
  value_json TEXT NOT NULL,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  source_entry TEXT NOT NULL
);
CREATE INDEX company_tickers_ticker_idx ON company_tickers(ticker);
CREATE INDEX filings_form_date_idx ON filings(form, filing_date);
CREATE INDEX facts_cik_concept_idx ON facts(cik, namespace, concept);
CREATE INDEX facts_concept_period_idx ON facts(namespace, concept, period_end);
BEGIN IMMEDIATE;`;

async function addSource(writer, id, collection, archive) {
  const stat = await fsp.stat(archive);
  const digest = await sha256File(archive);
  await writer.row(`INSERT INTO sources VALUES (${id},${sql(collection)},${sql(path.basename(archive))},${sql(digest)},${stat.size});`);
  return { collection, filename: path.basename(archive), sha256: digest, bytes: stat.size };
}

async function ingestSubmissions(writer, archive) {
  let companies = 0, tickers = 0, filings = 0;
  await scanZip(archive, async ({ entry, read }) => {
    const submission = JSON.parse(await read());
    if (!submission.cik) return;
    const companyCik = cik(submission.cik);
    await writer.row(`INSERT OR REPLACE INTO companies VALUES (${[
      companyCik, submission.name, submission.entityType, submission.sic, submission.sicDescription,
      submission.ownerOrg, submission.fiscalYearEnd, submission.stateOfIncorporation,
      submission.stateOfIncorporationDescription,
    ].map(sql).join(",")},${bool(submission.insiderTransactionForOwnerExists)},${bool(submission.insiderTransactionForIssuerExists)},${[
      submission.ein, submission.phone, submission.flags, json(submission.formerNames), json(submission.addresses),
    ].map(sql).join(",")},1,${sql(entry.fileName)});`);
    companies++;

    for (let i = 0; i < (submission.tickers || []).length; i++) {
      await writer.row(`INSERT OR REPLACE INTO company_tickers VALUES (${sql(companyCik)},${i},${sql(submission.tickers[i])},${sql(submission.exchanges?.[i])},1,${sql(entry.fileName)});`);
      tickers++;
    }

    const recent = submission.filings?.recent || {};
    for (let i = 0; i < (recent.accessionNumber || []).length; i++) {
      await writer.row(`INSERT OR REPLACE INTO filings VALUES (${[
        companyCik, aligned(recent, i, "accessionNumber"), aligned(recent, i, "filingDate"),
        aligned(recent, i, "reportDate"), aligned(recent, i, "acceptanceDateTime"), aligned(recent, i, "act"),
        aligned(recent, i, "form"), aligned(recent, i, "fileNumber"), aligned(recent, i, "filmNumber"),
        aligned(recent, i, "items"),
      ].map(sql).join(",")},${Number(aligned(recent, i, "size")) || "NULL"},${bool(aligned(recent, i, "isXBRL"))},${bool(aligned(recent, i, "isInlineXBRL"))},${[
        aligned(recent, i, "primaryDocument"), aligned(recent, i, "primaryDocDescription"),
      ].map(sql).join(",")},1,${sql(entry.fileName)});`);
      filings++;
    }

    for (const file of submission.filings?.files || []) {
      await writer.row(`INSERT OR REPLACE INTO filing_history_files VALUES (${sql(companyCik)},${sql(file.name)},${Number(file.filingCount) || "NULL"},${sql(file.filingFrom)},${sql(file.filingTo)},1,${sql(entry.fileName)});`);
    }
  });
  return { companies, tickers, filings };
}

async function ingestFacts(writer, archive) {
  let companiesAdded = 0, facts = 0;
  await scanZip(archive, async ({ entry, read }) => {
    const document = JSON.parse(await read());
    if (!document.cik) return;
    const companyCik = cik(document.cik);
    await writer.row(`INSERT OR IGNORE INTO companies (cik,entity_name,source_id,source_entry) VALUES (${sql(companyCik)},${sql(document.entityName)},2,${sql(entry.fileName)});`);
    companiesAdded++;
    for (const [namespace, concepts] of Object.entries(document.facts || {})) {
      for (const [concept, detail] of Object.entries(concepts || {})) {
        for (const [unit, observations] of Object.entries(detail.units || {})) {
          for (const observation of observations || []) {
            const period = observation.start ? `${observation.start}/${observation.end || ""}` : observation.end || null;
            const valueJson = json(observation.val);
            const key = crypto.createHash("sha256").update(JSON.stringify([
              companyCik, namespace, concept, unit, observation.start ?? null, observation.end ?? null,
              observation.fy ?? null, observation.fp ?? null, observation.form ?? null,
              observation.accn ?? null, observation.filed ?? null, observation.frame ?? null, valueJson,
            ])).digest("hex");
            await writer.row(`INSERT OR IGNORE INTO facts VALUES (${[
              key, companyCik, namespace, concept, detail.label, detail.description, unit, period,
              observation.start, observation.end,
            ].map(sql).join(",")},${Number.isInteger(observation.fy) ? observation.fy : "NULL"},${[
              observation.fp, observation.form, observation.accn, observation.filed, observation.frame,
              observation.val === undefined || observation.val === null ? null : String(observation.val), valueJson,
            ].map(sql).join(",")},2,${sql(entry.fileName)});`);
            facts++;
          }
        }
      }
    }
  });
  return { companiesSeen: companiesAdded, facts };
}

export async function rebuildSecDatabase({ submissionsArchive, companyfactsArchive, database, batchSize = 5_000 }) {
  if (!submissionsArchive || !companyfactsArchive || !database) throw new Error("submissionsArchive, companyfactsArchive, and database are required");
  await Promise.all([fsp.access(submissionsArchive), fsp.access(companyfactsArchive)]);
  await fsp.mkdir(path.dirname(database), { recursive: true });
  const temporary = `${database}.rebuilding`;
  await fsp.rm(temporary, { force: true });
  const writer = new SqliteWriter(temporary, batchSize);
  try {
    await writer.write(schema);
    await writer.row(`INSERT INTO metadata VALUES ('schema_version',${sql(SCHEMA_VERSION)});`);
    const sources = [
      await addSource(writer, 1, "submissions", submissionsArchive),
      await addSource(writer, 2, "companyfacts", companyfactsArchive),
    ];
    const submissions = await ingestSubmissions(writer, submissionsArchive);
    const companyfacts = await ingestFacts(writer, companyfactsArchive);
    await writer.close();
    await fsp.rename(temporary, database);
    return { database, sources, submissions, companyfacts };
  } catch (error) {
    writer.child.stdin.destroy();
    writer.child.kill();
    await fsp.rm(temporary, { force: true });
    throw error;
  }
}
