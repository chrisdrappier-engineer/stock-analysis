import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

export const ARCHIVES = {
  submissions: "https://www.sec.gov/Archives/edgar/daily-index/bulkdata/submissions.zip",
  companyfacts: "https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip",
};

export const utcRunId = (date = new Date()) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
export const normalizeTicker = (ticker) => String(ticker).trim().toUpperCase().replaceAll(".", "-");

export async function writeJsonExclusive(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true });
  await fsp.writeFile(filename, `${JSON.stringify(value)}\n`, { flag: "wx" });
}

export async function downloadArchive(url, destination, userAgent, fetchImpl = fetch) {
  if (!userAgent) throw new Error("SEC_USER_AGENT is required (for example: Name email@example.com)");
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.partial`;
  const response = await fetchImpl(url, { headers: { "user-agent": userAgent, "accept-encoding": "gzip, deflate" } });
  if (!response.ok || !response.body) throw new Error(`SEC download failed: ${response.status} ${response.statusText}`);
  const hash = crypto.createHash("sha256");
  let bytes = 0;
  const meter = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(partial, { flags: "wx" }));
    await fsp.rename(partial, destination);
  } catch (error) {
    await fsp.rm(partial, { force: true });
    throw error;
  }
  return { url, filename: path.basename(destination), bytes, sha256: hash.digest("hex") };
}

function openZip(filename) {
  return new Promise((resolve, reject) => yauzl.open(filename, { lazyEntries: true, autoClose: true }, (error, zip) => error ? reject(error) : resolve(zip)));
}

function readEntry(zip, entry) {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error) return reject(error);
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  }));
}

export async function scanZip(filename, onJsonEntry) {
  const zip = await openZip(filename);
  return new Promise((resolve, reject) => {
    let visited = 0;
    zip.on("error", reject);
    zip.on("end", () => resolve(visited));
    zip.on("entry", async (entry) => {
      try {
        if (!entry.fileName.endsWith(".json")) return zip.readEntry();
        visited++;
        await onJsonEntry({ entry, read: () => readEntry(zip, entry) });
        zip.readEntry();
      } catch (error) { reject(error); }
    });
    zip.readEntry();
  });
}

export async function ingestSubmissions({ archive, tickers, outputRoot, runId }) {
  const wanted = new Set(tickers.map(normalizeTicker));
  const matches = new Map();
  await scanZip(archive, async ({ entry, read }) => {
    const buffer = await read();
    const submission = JSON.parse(buffer);
    const matched = (submission.tickers || []).map(normalizeTicker).filter((ticker) => wanted.has(ticker));
    for (const ticker of matched) {
      const destination = path.join(outputRoot, ticker, "submissions", `submissions-${runId}.json`);
      await writeJsonExclusive(destination, submission);
      matches.set(ticker, { ticker, cik: String(submission.cik).padStart(10, "0"), file: path.relative(outputRoot, destination) });
    }
    return true;
  });
  return matches;
}

export async function ingestCompanyFacts({ archive, companies, outputRoot, runId }) {
  const byCik = new Map([...companies.values()].map((company) => [company.cik, company]));
  const saved = [];
  await scanZip(archive, async ({ entry, read }) => {
    const match = entry.fileName.match(/CIK(\d{10})\.json$/i);
    const company = match && byCik.get(match[1]);
    if (!company) return false;
    const facts = JSON.parse(await read());
    const destination = path.join(outputRoot, company.ticker, "companyfacts", `companyfacts-${runId}.json`);
    await writeJsonExclusive(destination, facts);
    saved.push({ ticker: company.ticker, cik: company.cik, file: path.relative(outputRoot, destination) });
    return true;
  });
  return saved.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function parseUniverseTickers(csvText) {
  const [header, ...lines] = csvText.trim().split(/\r?\n/);
  if (header.split(",")[0] !== "ticker") throw new Error("Universe CSV must begin with a ticker column");
  return lines.map((line) => normalizeTicker(line.slice(0, line.indexOf(",")))).filter(Boolean);
}
