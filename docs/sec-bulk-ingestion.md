# SEC bulk archives and rebuildable SQLite cache

The SEC ZIP archives are immutable source data. `data/sec/sec-cache.sqlite` is disposable derived state: delete or replace it at any time and rebuild it solely from `submissions.zip` and `companyfacts.zip`. The ETL does not read `agp_mechanical_screen.csv` and does not create permanent per-company extracts.

## Rebuild from local archives

Place both archives in one directory, retaining their SEC filenames:

```text
/path/to/sec-archives/
  submissions.zip
  companyfacts.zip
```

Then run:

```bash
npm run rebuild:sec-db -- --archive-dir /path/to/sec-archives --database data/sec/sec-cache.sqlite
```

`SEC_ARCHIVE_DIR`, `SEC_DB_PATH`, and `SEC_ETL_BATCH_SIZE` are equivalent environment variables. The build streams one ZIP member at a time, commits rows in batches, writes to `<database>.rebuilding`, and atomically replaces the destination only after a successful build. Re-running against identical archives produces the same logical rows.

SQLite's `sqlite3` CLI must be available on `PATH`.

## Download and ingest

To download fresh archives and rebuild the cache:

```bash
SEC_USER_AGENT="Your Name your-email@example.com" npm run ingest:sec:bulk
```

The identifying contact stays in the environment and must not be committed. Downloaded archives are retained under the timestamped bulk run directory.

To use previously downloaded archives through the same command:

```bash
SEC_ARCHIVE_DIR=/path/to/archives npm run ingest:sec:bulk
```

Completed run manifests are stored under `data/sec/bulk/runs/<timestamp>/`.

## Schema and provenance

- `companies`: CIK-keyed SEC identity and issuer metadata.
- `company_tickers`: all ticker/exchange pairs, preserving SEC order.
- `filings`: recent filing metadata embedded in the submissions bulk export.
- `filing_history_files`: references to older submission-history files advertised by SEC.
- `facts`: every Company Facts observation with taxonomy namespace/concept, unit, period, form, accession, filed date, value, label, and description.
- `sources`: archive filename, byte size, and SHA-256 digest.

Every derived row carries `source_id` and `source_entry`. `facts.value_json` preserves the JSON representation and `facts.value` provides a query-friendly textual representation, allowing later normalization without redownloading the archives.
