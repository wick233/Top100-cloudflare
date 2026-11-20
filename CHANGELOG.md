# Changelog

## Unreleased

- Replace the separate chart and movers period buttons with one page-wide time-range bar, and add a custom date range (`start`/`end` on `/api/stock`, `/api/index-history` and `/api/rank`) whose change is measured from the close before the range.
- Add bundled Chinese company profiles (`profiles.js`) and serve them from `/api/fundamentals`; remove the placeholder summary and hide the profile section when no summary exists.
- Move the movers period buttons into a shared header so the gainers and losers lists line up row by row.
- Fix the homepage chart staying blank after one failed load, stale responses overwriting the selected company, the mobile auto-scroll on first load, and the movers period resetting when the index changes.
- Stop requesting a quote for every index constituent on page load; request it only for the selected company and show index weight where no market cap is known.
- Cache index constituents once for the stocks, quote and rank routes, normalise share-class symbols to `BRK-B` form, and return real company names from the rank route.
- Treat the D1 cache as best-effort and stop writing the unused `bars` table, so D1 failures or exhausted write quota no longer fail market-data responses.
- Add an exact copy of the deployed `us.131133.xyz` homepage as `static/deployed-index.html`.
- Expand the dashboard with S&P 500 and Nasdaq 100 history views, technical indicators, company comparisons, and fundamentals reporting.
- Improve historical market-data persistence, caching, and API coverage.
- Add automated tests for API, storage, and frontend contracts.
