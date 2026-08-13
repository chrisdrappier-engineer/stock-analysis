import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ARCHIVES, downloadArchive, ingestCompanyFacts, ingestSubmissions, parseUniverseTickers, utcRunId, writeJsonExclusive } from "../lib/sec-bulk-ingest.mjs";

const root = process.cwd();
const runId = utcRunId();
const dataRoot = path.resolve(process.env.SEC_DATA_ROOT || path.join(root, "data", "sec"));
const runRoot = path.join(dataRoot, "bulk", "runs", runId);
const archiveRoot = path.join(runRoot, "archives");
const outputRoot = path.join(dataRoot, "companies");
const suppliedArchiveRoot = process.env.SEC_ARCHIVE_DIR && path.resolve(process.env.SEC_ARCHIVE_DIR);
const userAgent = process.env.SEC_USER_AGENT;

async function archive(name) {
  if (suppliedArchiveRoot) return { path: path.join(suppliedArchiveRoot, `${name}.zip`), metadata: { source: "local", filename: `${name}.zip` } };
  const destination = path.join(archiveRoot, `${name}.zip`);
  return { path: destination, metadata: await downloadArchive(ARCHIVES[name], destination, userAgent) };
}

const startedAt = new Date().toISOString();
try {
  const tickers = parseUniverseTickers(await fsp.readFile(path.join(root, "agp_mechanical_screen.csv"), "utf8"));
  const submissionsArchive = await archive("submissions");
  const companies = await ingestSubmissions({ archive: submissionsArchive.path, tickers, outputRoot, runId });
  const factsArchive = await archive("companyfacts");
  const facts = await ingestCompanyFacts({ archive: factsArchive.path, companies, outputRoot, runId });
  const manifest = { runId, status: "complete", startedAt, completedAt: new Date().toISOString(), universeCount: tickers.length, matchedCompanies: companies.size, companyFactsSaved: facts.length, archives: { submissions: submissionsArchive.metadata, companyfacts: factsArchive.metadata }, companies: facts };
  await writeJsonExclusive(path.join(runRoot, `manifest-${runId}.json`), manifest);
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  await fsp.mkdir(runRoot, { recursive: true });
  await writeJsonExclusive(path.join(runRoot, `failure-${runId}.json`), { runId, status: "failed", startedAt, failedAt: new Date().toISOString(), error: error.message });
  throw error;
}
