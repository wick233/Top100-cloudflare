import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("company profiles come from the bundled Chinese text, never a placeholder", async () => {
  const { PROFILES } = await import("../profiles.js");
  const { TOP100 } = await import("../top100.js");
  const { FALLBACK } = await import("../indices.js");
  const bundled = [...TOP100.map((row) => row[0]), ...Object.values(FALLBACK).flat().map((row) => row[1])];
  assert.deepEqual(bundled.filter((symbol) => !PROFILES[symbol]), []);
  for (const [symbol, profile] of Object.entries(PROFILES)) {
    assert.equal(profile.length, 2, symbol);
    assert.ok(profile[0] && profile[1].length > 10 && profile[1].endsWith("。"), symbol);
  }

  const env = fakeEnv();
  const call = async (path) => (await worker.fetch(new Request(`https://example.test${path}`), env)).json();
  await withFetch(() => new Response("{}", { status: 401 }), async () => {
    const apple = await call("/api/fundamentals/AAPL");
    assert.equal(apple.business_summary, PROFILES.AAPL[1]);
    assert.equal(apple.sector, "科技");
    assert.ok(!apple.business_summary.includes("暂未收录"));
    // Not bundled and upstream failed: no summary at all, so the page hides the section.
    assert.equal((await call("/api/fundamentals/ZZZZZZ")).business_summary, null);
  });
  await withFetch(() => new Response(JSON.stringify({ quoteSummary: { result: [{
    price: { longName: "Unlisted Profile Fixture" },
    assetProfile: { longBusinessSummary: "The fixture makes office equipment.", sector: "Industrials", industry: "Office Equipment" },
  }] } })), async () => {
    const unbundled = await call("/api/fundamentals/ZZZZZZ?refresh=true");
    assert.equal(unbundled.business_summary, "The fixture makes office equipment.");
    assert.equal(unbundled.industry, "Office Equipment");
    // The bundled profile still wins when upstream answers, including on a cache hit.
    assert.equal((await call("/api/fundamentals/MSFT")).business_summary, PROFILES.MSFT[1]);
    assert.equal((await call("/api/fundamentals/MSFT")).business_summary, PROFILES.MSFT[1]);
  });
});

test("a newly covered S&P 500 company has a Chinese profile even when Yahoo is down", async () => {
  await withFetch(() => new Response("{}", { status: 401 }), async () => {
    const profile = await (await get("/api/fundamentals/ZBRA")).json();
    assert.match(profile.business_summary || "", /条码/);
  });
});

test("the checked constituent snapshot has a Chinese profile for every security", async () => {
  const readData = (name) => JSON.parse(readFileSync(new URL(`../data/${name}.json`, import.meta.url), "utf8"));
  const snapshot = readData("profile-constituents");
  const provenance = readData("profile-sources");
  const { PROFILES } = await import("../profiles.js");
  assert.match(snapshot.checked_on, /^\d{4}-\d{2}-\d{2}$/);
  const covered = new Set();
  for (const [id, count] of [["sp500", 503], ["ndx100", 101]]) {
    const symbols = Object.keys(snapshot.indices[id].securities);
    assert.equal(symbols.length, count, id);
    assert.deepEqual(symbols.filter((symbol) => !/\p{Script=Han}/u.test(PROFILES[symbol]?.[1] ?? "")), [], id);
    for (const symbol of symbols) covered.add(symbol);
  }
  assert.equal(covered.size, 518);
  assert.equal(Object.keys(provenance.sources).length, 329);
  assert.equal(provenance.checked_on, snapshot.checked_on);
  for (const [symbol, url] of Object.entries(provenance.sources)) {
    assert.ok(covered.has(symbol) && PROFILES[symbol], symbol);
    assert.equal(new URL(url).protocol, "https:", symbol);
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

test("a custom date window slices cached history and measures change from the prior close", async () => {
  // Four daily bars ending today, so the test does not depend on the calendar date.
  const closes = [100, 110, 121, 133.1];
  const noon = Math.floor(Date.now() / 86400000) * 86400 + 43200;
  const stamps = closes.map((_, i) => noon - (closes.length - 1 - i) * 86400);
  const [d0, d1, d2, d3] = stamps.map((ts) => new Date(ts * 1000).toISOString().slice(0, 10));
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const chart = () => new Response(JSON.stringify({ chart: { result: [{ meta: {}, timestamp: stamps,
    indicators: { quote: [{ open: closes, high: closes, low: closes, close: closes, volume: closes.map(() => 1000) }] } }] } }));
  const env = fakeEnv();
  const call = (path) => worker.fetch(new Request(`https://example.test${path}`), env);
  const requested = [];
  await withFetch((url) => { requested.push(url); return chart(); }, async () => {
    const oneDay = await (await call(`/api/stock/AAPL?start=${d2}&end=${d2}`)).json();
    assert.equal(oneDay.range, "custom");
    assert.deepEqual([oneDay.start, oneDay.end, oneDay.bars.length, oneDay.prev_close], [d2, d2, 1, 110]);
    // The window is cut from the smallest preset range that covers it.
    assert.ok(requested[0].includes("range=1mo"));

    const twoDays = await (await call(`/api/stock/AAPL?start=${d1}&end=${d2}`)).json();
    assert.deepEqual([twoDays.bars.length, twoDays.prev_close], [2, 100]);
    // No bar precedes the first one, so there is no baseline close.
    assert.equal((await (await call(`/api/stock/AAPL?start=${d0}&end=${d3}`)).json()).prev_close, null);

    const indexDay = await (await call(`/api/index-history/sp500?start=${d3}`)).json();
    assert.deepEqual([indexDay.bars.length, indexDay.prev_close], [1, 121]);

    const rank = await (await call(`/api/rank?index=top100&start=${d2}&end=${d2}`)).json();
    const apple = rank.find((row) => row.symbol === "AAPL");
    assert.deepEqual([apple.chg_pct, apple.start_date, apple.date, apple.prev_close], [10, d2, d2, 110]);

    assert.equal((await call(`/api/stock/AAPL?start=${daysAgo(20)}&end=${daysAgo(15)}`)).status, 404);
    assert.equal((await call("/api/stock/AAPL?start=2026-13-45")).status, 400);
    assert.equal((await call(`/api/stock/AAPL?start=${d2}&end=${d1}`)).status, 400);
    assert.equal((await call(`/api/stock/AAPL?start=${daysAgo(-30)}`)).status, 400);
    assert.equal((await call(`/api/rank?index=top100&start=${daysAgo(900)}&end=${daysAgo(890)}`)).status, 400);
  });
});

test("non-API requests are delegated to Pages assets", async () => {
  const env = fakeEnv();
  const response = await worker.fetch(new Request("https://example.test/"), env);
  assert.equal(await response.text(), "asset");
});
