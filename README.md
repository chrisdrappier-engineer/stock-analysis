# Asymmetric Growth Portfolio Research

This project is a research application for screening publicly traded companies against the **Asymmetric Growth Portfolio (AGP)** mandate. The AGP is a high-risk portfolio segment seeking unusually large returns from secular growth over a 5–10 year horizon.

The application is a research aid, not investment advice or an automated trading system.

## Goals

- Begin with a broad universe of liquid, U.S.-listed common equities.
- Filter candidates cheaply before performing expensive qualitative research.
- Favor understandable businesses with a plausible path to approximately 5× shareholder returns under management's stated operating plan.
- Evaluate value creation per share, including margins, capital requirements, leverage, financial runway, and dilution.
- Preserve raw source data and provenance so research conclusions can be reproduced and revised.
- Use public SEC and company disclosures wherever possible.

The complete methodology is documented in [AGP_INVESTMENT_RULES.md](AGP_INVESTMENT_RULES.md).

## Current Features

- Strategy dashboard and mechanical research funnel.
- Searchable, sortable, and filterable stock universe.
- Aggregate views for every collected field.
- Company SEC-facts pages with definitions and filing metadata.
- Immutable, timestamped SEC bulk-archive ingestion.
- Live-reloading development environment and production Docker image.

## Requirements

- Docker Desktop, or Node.js 20 or newer.
- An identifying SEC user agent for SEC downloads, such as `Your Name your-email@example.com`.

## Start the Application

### Development with live reload

```bash
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000). Changes to the server, UI, or local data automatically restart or reload the application.

Stop the application with `Ctrl+C`, then run:

```bash
docker compose down
```

### Production-style container

```bash
docker build -t agp-stock-screener .
docker run --rm -p 3000:3000 agp-stock-screener
```

### Run directly with Node

```bash
npm install
npm test
npm run dev
```

Use `npm start` instead of `npm run dev` to run without file watching.

## SEC Bulk Ingestion

The worker downloads the SEC's nightly submissions and Company Facts archives, maps the stock universe to CIKs, and stores immutable timestamped snapshots.

```bash
SEC_USER_AGENT="Your Name your-email@example.com" npm run ingest:sec:bulk
```

For previously downloaded archives:

```bash
SEC_ARCHIVE_DIR=/path/to/archives npm run ingest:sec:bulk
```

That directory must contain `submissions.zip` and `companyfacts.zip`. See [docs/sec-bulk-ingestion.md](docs/sec-bulk-ingestion.md) for storage details.

## Data and Privacy

The `data/` directory is intentionally ignored by Git. SEC snapshots, ingestion manifests, portfolio holdings, position sizes, research notes, and other local information must remain there or in another ignored location.

Do not commit:

- personal SEC user-agent contact details;
- credentials, API keys, or `.env` files;
- private portfolio or watchlist information;
- generated logs, exports, or downloaded filings containing private annotations.

`.gitignore` does not protect files already tracked or secrets previously committed. Review staged changes before every commit.

## Repository Structure

```text
public/                         Browser application
server.mjs                     Node HTTP and data API server
lib/sec-bulk-ingest.mjs        SEC archive ingestion library
scripts/ingest-sec-bulk.mjs    Nightly bulk-ingestion command
scripts/build_agp_mechanical_csv.mjs
test/                           Automated tests
docs/                           Supporting documentation
data/                           Ignored local snapshots and research data
```

## Validation

```bash
npm test
docker build -t agp-stock-screener .
```

## Data Sources

- [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)
- [SEC developer resources and access limits](https://www.sec.gov/about/developer-resources)
- Current mechanical-screen source data is described by the repository's ingestion and CSV-generation code.
