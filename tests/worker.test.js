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

test("non-API requests are delegated to Pages assets", async () => {
  const env = fakeEnv();
  const response = await worker.fetch(new Request("https://example.test/"), env);
  assert.equal(await response.text(), "asset");
});
