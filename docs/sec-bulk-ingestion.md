# SEC nightly bulk ingestion

The worker downloads the SEC submissions and company-facts bulk archives, maps the repository's ticker universe to CIKs, and saves only matching company records. Every run and company snapshot is timestamped and immutable.

```bash
SEC_USER_AGENT="Your Name your-email@example.com" npm run ingest:sec:bulk
```

For tests or previously downloaded archives:

```bash
SEC_ARCHIVE_DIR=/path/to/archives npm run ingest:sec:bulk
```

The directory must contain `submissions.zip` and `companyfacts.zip`. Completed run manifests are stored under `data/sec/bulk/runs/<timestamp>/`; snapshots are stored under `data/sec/companies/<ticker>/<collection>/`.
