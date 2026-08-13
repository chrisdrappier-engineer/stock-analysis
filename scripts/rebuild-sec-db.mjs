import path from "node:path";
import process from "node:process";
import { rebuildSecDatabase } from "../lib/sec-sqlite-etl.mjs";

function options(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) throw new Error(`Unexpected argument: ${argv[i]}`);
    result[argv[i].slice(2)] = argv[++i];
  }
  return result;
}

const args = options(process.argv.slice(2));
const archiveDir = path.resolve(args["archive-dir"] || process.env.SEC_ARCHIVE_DIR || path.join("data", "sec", "bulk"));
const database = path.resolve(args.database || process.env.SEC_DB_PATH || path.join("data", "sec", "sec-cache.sqlite"));
const batchSize = Number(args["batch-size"] || process.env.SEC_ETL_BATCH_SIZE || 5_000);
if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error("batch-size must be a positive integer");

const result = await rebuildSecDatabase({
  submissionsArchive: path.join(archiveDir, "submissions.zip"),
  companyfactsArchive: path.join(archiveDir, "companyfacts.zip"),
  database,
  batchSize,
});
console.log(JSON.stringify(result, null, 2));
