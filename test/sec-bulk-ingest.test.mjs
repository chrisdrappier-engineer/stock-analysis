import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { normalizeTicker, parseUniverseTickers, utcRunId, writeJsonExclusive } from "../lib/sec-bulk-ingest.mjs";
import { rebuildSecDatabase } from "../lib/sec-sqlite-etl.mjs";

const exec = promisify(execFile);

test("normalizes SEC and market ticker variants", () => {
  assert.equal(normalizeTicker(" brk.b "), "BRK-B");
});

test("reads tickers from the mechanical universe", () => {
  assert.deepEqual(parseUniverseTickers("ticker,company_name\nAAA,Alpha\nBRK.B,Berkshire\n"), ["AAA", "BRK-B"]);
});

test("creates stable UTC run identifiers", () => {
  assert.equal(utcRunId(new Date("2026-08-12T15:30:45.123Z")), "20260812T153045Z");
});

test("immutable JSON writes cannot replace a snapshot", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "agp-sec-test-"));
  const filename = path.join(directory, "snapshot.json");
  await writeJsonExclusive(filename, { version: 1 });
  await assert.rejects(writeJsonExclusive(filename, { version: 2 }), { code: "EEXIST" });
  assert.deepEqual(JSON.parse(await fsp.readFile(filename)), { version: 1 });
});

async function fixtureArchives(directory) {
  const submissions = path.join(directory, "submissions");
  const companyfacts = path.join(directory, "companyfacts");
  await fsp.mkdir(submissions);
  await fsp.mkdir(companyfacts);
  await fsp.writeFile(path.join(submissions, "CIK0000000123.json"), JSON.stringify({
    cik: "123", name: "Example Corp", entityType: "operating", sic: "3571",
    tickers: ["EXM", "EXM.A"], exchanges: ["Nasdaq", "NYSE"],
    filings: {
      recent: {
        accessionNumber: ["0000000123-26-000001"], filingDate: ["2026-08-01"], reportDate: ["2026-06-30"],
        acceptanceDateTime: ["20260801120000"], act: ["34"], form: ["10-Q"], fileNumber: ["001-12345"],
        filmNumber: ["26123456"], items: [""], size: [1234], isXBRL: [1], isInlineXBRL: [1],
        primaryDocument: ["exm-20260630.htm"], primaryDocDescription: ["10-Q"],
      },
      files: [{ name: "CIK0000000123-submissions-001.json", filingCount: 2, filingFrom: "2020-01-01", filingTo: "2021-01-01" }],
    },
  }));
  await fsp.writeFile(path.join(companyfacts, "CIK0000000123.json"), JSON.stringify({
    cik: 123, entityName: "Example Corp", facts: { "us-gaap": { Revenues: {
      label: "Revenue", description: "Revenue from customers", units: { USD: [
        { start: "2026-01-01", end: "2026-06-30", val: 42000000, accn: "0000000123-26-000001", fy: 2026, fp: "Q2", form: "10-Q", filed: "2026-08-01", frame: "CY2026Q2" },
      ] },
    } } },
  }));
  await exec("zip", ["-q", path.join(directory, "submissions.zip"), "CIK0000000123.json"], { cwd: submissions });
  await exec("zip", ["-q", path.join(directory, "companyfacts.zip"), "CIK0000000123.json"], { cwd: companyfacts });
}

async function query(database, statement) {
  const { stdout } = await exec("sqlite3", ["-json", database, statement]);
  return JSON.parse(stdout || "[]");
}

test("rebuilds a complete SEC SQLite cache without a CSV universe", async () => {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "agp-sec-etl-"));
  await fixtureArchives(directory);
  const database = path.join(directory, "sec.sqlite");
  const input = {
    submissionsArchive: path.join(directory, "submissions.zip"),
    companyfactsArchive: path.join(directory, "companyfacts.zip"), database, batchSize: 2,
  };

  await rebuildSecDatabase(input);
  await rebuildSecDatabase(input);

  assert.deepEqual(await query(database, "SELECT cik,entity_name FROM companies"), [{ cik: "0000000123", entity_name: "Example Corp" }]);
  assert.equal((await query(database, "SELECT count(*) AS count FROM company_tickers"))[0].count, 2);
  assert.deepEqual(await query(database, "SELECT accession,form,filing_date FROM filings"), [{ accession: "0000000123-26-000001", form: "10-Q", filing_date: "2026-08-01" }]);
  assert.deepEqual(await query(database, "SELECT namespace,concept,unit,period,form,accession,filed,value,label,description FROM facts"), [{
    namespace: "us-gaap", concept: "Revenues", unit: "USD", period: "2026-01-01/2026-06-30", form: "10-Q",
    accession: "0000000123-26-000001", filed: "2026-08-01", value: "42000000", label: "Revenue", description: "Revenue from customers",
  }]);
  assert.equal((await query(database, "PRAGMA foreign_key_check" )).length, 0);
  assert.equal((await query(database, "SELECT count(*) AS count FROM sources WHERE length(archive_sha256)=64"))[0].count, 2);
});
