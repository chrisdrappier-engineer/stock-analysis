import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeTicker, parseUniverseTickers, utcRunId, writeJsonExclusive } from "../lib/sec-bulk-ingest.mjs";

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
