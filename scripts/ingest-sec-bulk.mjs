import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { ARCHIVES, downloadArchive, utcRunId, writeJsonExclusive } from "../lib/sec-bulk-ingest.mjs";
import { rebuildSecDatabase } from "../lib/sec-sqlite-etl.mjs";

const root = process.cwd();
const runId = utcRunId();
const dataRoot = path.resolve(process.env.SEC_DATA_ROOT || path.join(root, "data", "sec"));
const runRoot = path.join(dataRoot, "bulk", "runs", runId);
const archiveRoot = path.join(runRoot, "archives");
const suppliedArchiveRoot = process.env.SEC_ARCHIVE_DIR && path.resolve(process.env.SEC_ARCHIVE_DIR);
const database = path.resolve(process.env.SEC_DB_PATH || path.join(dataRoot, "sec-cache.sqlite"));

async function archive(name) {
  if (suppliedArchiveRoot) return path.join(suppliedArchiveRoot, `${name}.zip`);
  const destination = path.join(archiveRoot, `${name}.zip`);
  await downloadArchive(ARCHIVES[name], destination, process.env.SEC_USER_AGENT);
  return destination;
}

const startedAt = new Date().toISOString();
try {
  const submissionsArchive = await archive("submissions");
  const companyfactsArchive = await archive("companyfacts");
  const result = await rebuildSecDatabase({ submissionsArchive, companyfactsArchive, database });
  const manifest = { runId, status: "complete", startedAt, completedAt: new Date().toISOString(), ...result };
  await writeJsonExclusive(path.join(runRoot, `manifest-${runId}.json`), manifest);
  console.log(JSON.stringify(manifest, null, 2));
} catch (error) {
  await fsp.mkdir(runRoot, { recursive: true });
  await writeJsonExclusive(path.join(runRoot, `failure-${runId}.json`), {
    runId, status: "failed", startedAt, failedAt: new Date().toISOString(), error: error.message,
  });
  throw error;
}
