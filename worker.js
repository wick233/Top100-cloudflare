import { TOP100 } from "./top100.js";
import { INDICES, FALLBACK } from "./indices.js";

const RANGES = new Set(["1mo", "3mo", "6mo", "1y", "2y", "5y", "max"]);
const INTERVALS = new Set(["1d", "1wk", "1mo"]);
const INDEX_HISTORY = {
  sp500: { ticker: "^GSPC", name: "标普500指数" },
  ndx100: { ticker: "^NDX", name: "纳指100指数" },
};
const LOGO_SOURCES = [
  (s) => `https://financialmodelingprep.com/image-stock/${encodeURIComponent(s)}.png`,
  (s) => `https://assets.parqet.com/logos/symbol/${encodeURIComponent(s)}.png`,
  (s) => `https://companiesmarketcap.com/img/company-logos-64/${encodeURIComponent(s)}.png`,
];

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}
function error(message, status = 400) { return json({ detail: message }, status); }
function urlFor(path, query = {}) {
  const url = new URL(path);
  for (const [key, value] of Object.entries(query)) if (value != null) url.searchParams.set(key, value);
  return url;
}
async function cached(env, key) {
  const row = await env.DB.prepare("SELECT payload FROM cache WHERE cache_key=? AND expires_at>? ").bind(key, Date.now()).first();
  if (!row) return null;
  try { return JSON.parse(row.payload); } catch { return null; }
}
async function putCache(env, key, value, ttl = 300) {
  await env.DB.prepare("INSERT INTO cache(cache_key,payload,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at")
    .bind(key, JSON.stringify(value), Date.now() + ttl * 1000).run();
}

async function yahooChart(ticker, range, interval) {
  const endpoint = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}&events=div%2Csplits`;
  const response = await fetch(endpoint, { headers: { "user-agent": "Mozilla/5.0 Top100Dashboard/1.0" } });
  if (!response.ok) throw new Error(`Yahoo Finance HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  if (!result) throw new Error(payload?.chart?.error?.description || "Yahoo Finance returned no chart data");
  const quote = result.indicators?.quote?.[0] || {};
  const bars = (result.timestamp || []).map((ts, i) => {
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    const [open, high, low, close, volume] = [quote.open?.[i], quote.high?.[i], quote.low?.[i], quote.close?.[i], quote.volume?.[i]];
    if ([open, high, low, close].some((n) => !Number.isFinite(n))) return null;
    return { date, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 };
  }).filter(Boolean);
  return { meta: result.meta || {}, bars };
}

async function getBars(env, ticker, interval, range) {
  const cacheKey = `bars:${ticker}:${interval}:${range}`;
  const hit = await cached(env, cacheKey);
  if (hit?.bars?.length) return hit;
  const { meta, bars } = await yahooChart(ticker, range, interval);
  if (!bars.length) return { meta, bars: [] };
  const stmt = env.DB.prepare("INSERT INTO bars(ticker,interval,date,open,high,low,close,volume) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(ticker,interval,date) DO UPDATE SET open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,volume=excluded.volume");
  for (let i = 0; i < bars.length; i += 100) {
    await env.DB.batch(bars.slice(i, i + 100).map((b) => stmt.bind(ticker, interval, b.date, b.open, b.high, b.low, b.close, b.volume)));
  }
  const result = { meta, bars };
  await putCache(env, cacheKey, result, 300);
  return result;
}

async function indexConstituents(id) {
  if (id === "top100") return TOP100.map(([symbol, name, cap, sector], i) => ({ rank: i + 1, symbol, ticker: symbol, name, weight_pct: null, market_cap_b: Number(cap), sector }));
  const fallback = FALLBACK[id] || [];
  const candidates = id === "sp500" ? ["https://www.slickcharts.com/sp500"] : ["https://www.slickcharts.com/nasdaq100"];
  for (const source of candidates) {
    try {
      const response = await fetch(source, { headers: { "user-agent": "Mozilla/5.0 Top100Dashboard/1.0" } });
      if (!response.ok) continue;
      const html = await response.text();
      const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].slice(1).map((match) => {
        const cells = [...match[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1].replace(/<[^>]*>/g, "").replace(/&amp;/g, "&").trim());
        if (cells.length < 4 || !/^[A-Z0-9.-]+$/.test(cells[2])) return null;
        return { rank: Number.parseInt(cells[0], 10) || 0, symbol: cells[2], ticker: cells[2], name: cells[1], weight_pct: Number.parseFloat(cells[3].replace(/[^0-9.-]/g, "")) || null, market_cap_b: null, sector: null };
      }).filter(Boolean);
      if (rows.length) return rows;
    } catch { /* use bundled fallback */ }
  }
  return fallback.map(([rank, symbol, name]) => ({ rank, symbol, ticker: symbol, name, weight_pct: null, market_cap_b: null, sector: null }));
}

function companyName(symbol) {
  const top = TOP100.find(([ticker]) => ticker === symbol);
  if (top) return top[1];
  for (const rows of Object.values(FALLBACK)) {
    const match = rows.find((row) => row[1] === symbol);
    if (match) return match[2];
  }
  return symbol;
}

async function historyResponse(env, ticker, range, interval) {
  const { bars } = await getBars(env, ticker, interval, range);
  if (!bars.length) throw new Error(`${ticker} has no history`);
  return { ticker, name: companyName(ticker), range, interval, start: bars[0].date, end: bars.at(-1).date,
    bars: bars.map((b) => [b.date, b.open, b.close, b.low, b.high, b.volume]) };
}

async function stocksRoute(url, env) {
  const index = (url.searchParams.get("index") || "top100").toLowerCase();
  if (!INDICES[index]) return error(`未知指数: ${index}`, 400);
  const key = `stocks:${index}`;
  const hit = await cached(env, key);
  if (hit) return json(hit);
  const rows = await indexConstituents(index);
  const clean = rows.map((s) => ({ rank: s.rank, symbol: s.symbol, name: s.name || s.symbol, weight_pct: s.weight_pct, sector: s.sector, market_cap_b: s.market_cap_b }));
  await putCache(env, key, clean, 6 * 3600);
  return json(clean);
}

async function quoteRoute(symbol, env) {
  const row = TOP100.find(([ticker]) => ticker === symbol);
  if (!row) return error(`未知代码: ${symbol}`, 404);
  const key = `quote:${symbol}`;
  const hit = await cached(env, key);
  if (hit) return json(hit);
  let result = { ticker: symbol, symbol, marketCap: Number(row[2]) };
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price`, { headers: { "user-agent": "Mozilla/5.0 Top100Dashboard/1.0" } });
    if (response.ok) {
      const data = await response.json();
      const cap = data?.quoteSummary?.result?.[0]?.price?.marketCap?.raw;
      if (Number.isFinite(cap)) result.marketCap = cap / 1e9;
    }
  } catch { /* bundled market cap remains a fallback */ }
  await putCache(env, key, result, 900);
  return json(result);
}

async function rankRoute(url, env) {
  const index = (url.searchParams.get("index") || "top100").toLowerCase();
  if (!INDICES[index]) return error(`未知指数: ${index}`, 400);
  const key = `rank:${index}`;
  const hit = await cached(env, key);
  if (hit) return json(hit);
  const constituents = await indexConstituents(index);
  const rows = await Promise.all(constituents.map(async ({ symbol }) => {
    try {
      const { bars } = await getBars(env, symbol, "1d", "5d");
      if (bars.length < 2) throw new Error("missing previous close");
      const last = bars.at(-1), prev = bars.at(-2);
      return { symbol, price: last.close, prev_close: prev.close, chg_pct: Number(((last.close - prev.close) / prev.close * 100).toFixed(2)) };
    } catch { return { symbol, price: null, prev_close: null, chg_pct: null }; }
  }));
  await putCache(env, key, rows, 60);
  return json(rows);
}

async function compareRoute(url, env) {
  const symbols = [...new Set((url.searchParams.get("symbols") || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const range = url.searchParams.get("range") || "1y";
  if (!symbols.length) return error("symbols 不能为空,逗号分隔");
  if (symbols.length > 15) return error("最多同时对比15家公司");
  if (!RANGES.has(range)) return error("无效的时间范围");
  const key = `compare:${symbols.join(",")}:${range}`;
  const hit = await cached(env, key);
  if (hit) return json(hit);
  const series = {};
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const { bars } = await getBars(env, symbol, "1d", range);
      if (bars.length) {
        const first = bars[0].close, last = bars.at(-1).close;
        series[symbol] = { name: companyName(symbol), data: bars.map((b) => [Date.parse(`${b.date}T00:00:00Z`), b.close]), return_pct: Number(((last - first) / first * 100).toFixed(2)) };
      }
    } catch { /* omit symbols with unavailable history */ }
  }));
  if (!Object.keys(series).length) return error("无可用数据", 404);
  const result = { range, series, comparisonReturns: Object.fromEntries(Object.entries(series).map(([s, v]) => [s, v.return_pct])) };
  await putCache(env, key, result);
  return json(result);
}

async function fundamentalsRoute(symbol) {
  // Yahoo's public quoteSummary endpoint is not a supported fundamentals API.
  // Return a clear response until a stable licensed provider is configured.
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,summaryDetail,defaultKeyStatistics,financialData`, { headers: { "user-agent": "Mozilla/5.0 Top100Dashboard/1.0" } });
    const body = await response.json();
    const result = body?.quoteSummary?.result?.[0];
    if (!response.ok || !result) throw new Error(body?.quoteSummary?.error?.description || `HTTP ${response.status}`);
    const value = (obj, key) => Number.isFinite(obj?.[key]?.raw) ? obj[key].raw : null;
    const metrics = {
      market_cap: value(result.price, "marketCap"), trailing_pe: value(result.summaryDetail, "trailingPE"),
      forward_pe: value(result.summaryDetail, "forwardPE"), price_to_book: value(result.defaultKeyStatistics, "priceToBook"),
      trailing_eps: value(result.defaultKeyStatistics, "trailingEps"), forward_eps: value(result.defaultKeyStatistics, "forwardEps"),
      dividend_yield_pct: value(result.summaryDetail, "dividendYield") == null ? null : value(result.summaryDetail, "dividendYield") * 100,
      dividend_rate: value(result.summaryDetail, "dividendRate"),
      payout_ratio_pct: value(result.summaryDetail, "payoutRatio") == null ? null : value(result.summaryDetail, "payoutRatio") * 100,
      beta: value(result.defaultKeyStatistics, "beta"), fifty_two_week_high: value(result.summaryDetail, "fiftyTwoWeekHigh"),
      fifty_two_week_low: value(result.summaryDetail, "fiftyTwoWeekLow"),
    };
    return { ticker: symbol, name: result.price?.longName || result.price?.shortName || symbol, sector: result.summaryProfile?.sector || null, industry: result.summaryProfile?.industry || null, currency: result.price?.currency || "USD", metrics, annual: [], dividends: [], updated_at: Math.floor(Date.now() / 1000) };
  } catch (e) { throw new Error(`基本面数据源不可用：${e.message}`); }
}

async function logoRoute(symbol) {
  for (const buildUrl of LOGO_SOURCES) {
    try {
      const response = await fetch(buildUrl(symbol), { headers: { "user-agent": "Mozilla/5.0 Top100Dashboard/1.0" } });
      const contentType = response.headers.get("content-type") || "";
      if (response.ok && contentType.startsWith("image/")) return new Response(response.body, { headers: { "content-type": contentType, "cache-control": "public, max-age=86400" } });
    } catch { /* try next provider */ }
  }
  const letter = symbol[0] || "?";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#efece6" rx="10"/><text x="24" y="32" font-size="24" text-anchor="middle" fill="#d97757" font-family="Arial" font-weight="bold">${letter}</text></svg>`;
  return new Response(svg, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } });
}

async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method !== "GET") return error("Method not allowed", 405);
  if (path === "/api/indices") return json(Object.entries(INDICES).map(([id, meta]) => ({ id, ...meta })));
  if (path === "/api/stocks") return stocksRoute(url, env);
  const m = path.match(/^\/api\/(quote|fundamentals|stock|logo)\/([^/]+)$/);
  if (m) {
    const [, kind, raw] = m, symbol = decodeURIComponent(raw).toUpperCase();
    if (!/^[A-Z0-9.^=-]+$/.test(symbol)) return error("Invalid symbol");
    if (kind === "quote") return quoteRoute(symbol, env);
    if (kind === "logo") return logoRoute(symbol);
    if (kind === "fundamentals") {
      const key = `fundamentals:${symbol}`;
      const force = url.searchParams.get("refresh") === "true";
      const hit = force ? null : await cached(env, key);
      if (hit) return json(hit);
      try { const result = await fundamentalsRoute(symbol); await putCache(env, key, result, 86400); return json(result); }
      catch (e) { return error(e.message, 502); }
    }
    if (kind === "stock") {
      const range = url.searchParams.get("range") || "1mo", interval = url.searchParams.get("interval") || "1d";
      if (!RANGES.has(range) || !INTERVALS.has(interval)) return error("无效的 range 或 interval");
      try { return json(await historyResponse(env, symbol, range, interval)); }
      catch (e) { return error(`拉取数据失败: ${e.message}`, 502); }
    }
  }
  if (path === "/api/rank") return rankRoute(url, env);
  if (path === "/api/compare") return compareRoute(url, env);
  if (path === "/api/index-history/" || path.startsWith("/api/index-history/")) {
    const id = path.split("/").at(-1).toLowerCase();
    if (!INDEX_HISTORY[id]) return error("index_id 需为 sp500 或 ndx100");
    const range = url.searchParams.get("range") || "1y", interval = url.searchParams.get("interval") || "1d";
    if (!RANGES.has(range) || !INTERVALS.has(interval)) return error("无效的时间范围或周期");
    try { return json(await historyResponse(env, INDEX_HISTORY[id].ticker, range, interval)); }
    catch (e) { return error(`拉取指数数据失败: ${e.message}`, 502); }
  }
  if (path === "/api/export/" || path.startsWith("/api/export/")) {
    const symbol = decodeURIComponent(path.split("/").at(-1)).toUpperCase();
    const range = url.searchParams.get("range") || "1y", format = url.searchParams.get("fmt") || "csv";
    if (!RANGES.has(range) || !["csv", "json"].includes(format)) return error("无效的 range 或 fmt");
    try {
      const { bars } = await getBars(env, symbol, "1d", range);
      if (!bars.length) return error(`${symbol} 无数据`, 404);
      if (format === "json") return new Response(JSON.stringify(bars), { headers: { "content-type": "application/json", "content-disposition": `attachment; filename="${symbol}.json"` } });
      const lines = ["date,open,high,low,close,volume", ...bars.map((b) => [b.date, b.open, b.high, b.low, b.close, b.volume].join(","))];
      return new Response(`${lines.join("\n")}\n`, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${symbol}.csv"` } });
    } catch (e) { return error(`导出失败: ${e.message}`, 502); }
  }
  return error("Not found", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    try { return await api(request, env); }
    catch (e) { return error(e?.message || "Internal error", 500); }
  },
};
