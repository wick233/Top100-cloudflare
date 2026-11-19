import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../worker.js";

function fakeEnv() {
  const values = new Map();
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes("SELECT payload")) {
                const item = values.get(args[0]);
                return item && item.expiresAt > args[1] ? { payload: item.payload } : null;
              }
              return null;
            },
            async run() {
              if (sql.includes("INSERT INTO cache")) values.set(args[0], { payload: args[1], expiresAt: args[2] });
              return { success: true };
            },
            async all() { return { results: [] }; },
          };
        },
      };
    },
    async batch() { return []; },
  };
  return { DB: db, ASSETS: { fetch: async () => new Response("asset") } };
}

async function get(path) {
  return worker.fetch(new Request(`https://example.test${path}`), fakeEnv());
}

test("index metadata route returns the three supported indices", async () => {
  const response = await get("/api/indices");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).map((x) => x.id), ["top100", "sp500", "ndx100"]);
});

test("stocks route maps the bundled Top100 and rejects unknown indices", async () => {
  const response = await get("/api/stocks?index=top100");
  const stocks = await response.json();
  assert.equal(response.status, 200);
  assert.equal(stocks.length, 100);
  assert.equal(stocks[0].symbol, "AAPL");
  assert.equal((await get("/api/stocks?index=invalid")).status, 400);
});

test("market API validates request parameters", async () => {
  assert.equal((await get("/api/stock/AAPL?range=nope")).status, 400);
  assert.equal((await get("/api/compare")).status, 400);
  assert.equal((await get("/api/compare?symbols=AAPL,MSFT,NVDA,AMZN,META,AVGO,GOOGL,TSLA,COST,NFLX,AMD,CSCO,QCOM,INTU,ADBE,ISRG")).status, 400);
  assert.equal((await get("/api/rank?index=sp500&range=bad")).status, 400);
});

test("fundamentals returns a displayable fallback when Yahoo rejects the request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ quoteSummary: { error: { description: "HTTP 401" } } }), { status: 401 });
  try {
    const response = await get("/api/fundamentals/AAPL");
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.ticker, "AAPL");
    assert.ok(body.business_summary);
    assert.ok(body.source_error.includes("401"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function withFetch(handler, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => handler(String(input?.url ?? input));
  try { return await run(); } finally { globalThis.fetch = originalFetch; }
}

function yahooChart(closes) {
  const day = 86400, start = 1767277800; // 2026-01-01 14:30 UTC
  return new Response(JSON.stringify({ chart: { result: [{
    meta: {}, timestamp: closes.map((_, i) => start + i * day),
    indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1000) }] },
  }] } }));
}

test("history still answers when D1 is failing and never writes the bars table", async () => {
  let batches = 0;
  const env = {
    DB: { prepare() { throw new Error("D1 unavailable"); }, async batch() { batches += 1; return []; } },
    ASSETS: { fetch: async () => new Response("asset") },
  };
  await withFetch(() => yahooChart([100, 110]), async () => {
    const response = await worker.fetch(new Request("https://example.test/api/stock/AAPL?range=1mo&interval=1d"), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).bars.length, 2);
    assert.equal(batches, 0);
  });
});

test("constituents are scraped once and shared by the stocks, quote and rank routes", async () => {
  const env = fakeEnv();
  const call = (path) => worker.fetch(new Request(`https://example.test${path}`), env);
  const table = "<table><tr><th>#</th><th>Company</th><th>Symbol</th><th>Weight</th></tr>"
    + "<tr><td>1</td><td>Apple Inc.</td><td>AAPL</td><td>7.10%</td></tr>"
    + "<tr><td>2</td><td>Berkshire Hathaway</td><td>BRK.B</td><td>1.70%</td></tr>"
    + "<tr><td>3</td><td>Zebra Technologies</td><td>ZBRA</td><td>0.05%</td></tr></table>";
  let scrapes = 0;
  await withFetch((url) => {
    if (url.includes("slickcharts.com")) { scrapes += 1; return new Response(table); }
    if (url.includes("/v8/finance/chart/")) return yahooChart([100, 110]);
    return new Response("{}", { status: 401 });
  }, async () => {
    const stocks = await (await call("/api/stocks?index=sp500")).json();
    assert.deepEqual(stocks.map((s) => s.symbol), ["AAPL", "BRK-B", "ZBRA"]);
    assert.equal(stocks[0].market_cap_b, 3350);
    assert.ok(stocks[0].sector);
    assert.equal(stocks[2].market_cap_b, null);
    assert.equal(stocks[2].weight_pct, 0.05);

    assert.equal((await call("/api/quote/ZBRA")).status, 200);
    assert.equal((await call("/api/quote/ZBRA")).status, 200);

    const rank = await (await call("/api/rank?index=sp500&range=1d")).json();
    const zebra = rank.find((row) => row.symbol === "ZBRA");
    assert.equal(zebra.name, "Zebra Technologies");
    assert.equal(zebra.chg_pct, 10);
    assert.equal(scrapes, 1);
  });
});

test("non-API requests are delegated to Pages assets", async () => {
  const env = fakeEnv();
  const response = await worker.fetch(new Request("https://example.test/"), env);
  assert.equal(await response.text(), "asset");
});
