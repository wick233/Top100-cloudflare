# Top100 Cloudflare edition

This is an isolated Cloudflare Pages + Workers + D1 migration of the original Top100 application. The source directory `/root/project/Top100` is not used at runtime and is not modified by this copy.

## Architecture

- `public/` is the Pages static output and contains the dashboard HTML/JS.
- `functions/_middleware.js` routes `/api/*` requests to `worker.js`.
- `worker.js` implements the API using the Workers Fetch API and D1 prepared statements.
- `migrations/0001_init.sql` creates `bars` and expiring `cache` tables.
- Yahoo Finance chart JSON is used instead of Python `yfinance`; quote summary and Slickcharts are attempted with bundled fallbacks.

## Local checks

```sh
npm install
npx wrangler d1 execute top100-market --local --file=migrations/0001_init.sql
npm run dev
```

Configure the D1 database ID in `wrangler.toml` before deployment. To create and bind a database:

```sh
npx wrangler d1 create top100-market
```

Copy the returned database ID to `wrangler.toml`, then apply migrations remotely:

```sh
npx wrangler d1 migrations apply top100-market --remote
```

Deploy with Cloudflare Pages connected to Git, or run `npx wrangler pages deploy public` after configuring the project.

## Known gaps and operational risks

- Yahoo Finance endpoints are unofficial and may rate-limit, block Workers egress, or change response formats. This must be load-tested before production cutover.
- Quote summary data may be unavailable; quote endpoints fall back to the bundled Top100 market-cap values.
- `/api/fundamentals` currently maps valuation and profile fields from Yahoo quoteSummary, but annual statements and dividend history are empty because the public endpoint is not a reliable supported source. A licensed provider is needed for production parity.
- Ranking fetches each constituent's five-day chart in parallel and may be throttled for large indices.
- Index constituent scraping uses a small HTML parser and a 30-row bundled fallback, not a complete authoritative constituent snapshot.
- No production domain, D1 database, or Cloudflare account has been configured from this workspace.
