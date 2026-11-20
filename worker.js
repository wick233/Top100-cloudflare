import { TOP100 } from "./top100.js";
import { INDICES, FALLBACK } from "./indices.js";
import { PROFILES } from "./profiles.js";

const RANGES = new Set(["1wk", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"]);
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
// The D1 cache is best-effort in both directions: a failed read is a cache miss and a
// failed write (outage, exhausted write quota, missing migration) must not fail a
// response whose data was already fetched upstream.
async function cached(env, key) {
  try {
    const row = await env.DB.prepare("SELECT payload FROM cache WHERE cache_key=? AND expires_at>? ").bind(key, Date.now()).first();
    return row ? JSON.parse(row.payload) : null;
  } catch (e) {
    console.warn(`cache read failed for ${key}: ${e?.message}`);
    return null;
  }
}
async function putCache(env, key, value, ttl = 300) {
  try {
    await env.DB.prepare("INSERT INTO cache(cache_key,payload,expires_at) VALUES(?,?,?) ON CONFLICT(cache_key) DO UPDATE SET payload=excluded.payload,expires_at=excluded.expires_at")
      .bind(key, JSON.stringify(value), Date.now() + ttl * 1000).run();
  } catch (e) {
    console.warn(`cache write failed for ${key}: ${e?.message}`);
  }
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
  const upstreamRange = range === "1wk" ? "5d" : range;
  const cacheKey = `bars:${ticker}:${interval}:${range}`;
  const hit = await cached(env, cacheKey);
  if (hit?.bars?.length) return hit;
  const { meta, bars } = await yahooChart(ticker, upstreamRange, interval);
  if (!bars.length) return { meta, bars: [] };
  const result = { meta, bars };
  await putCache(env, cacheKey, result, 300);
  return result;
}

const TOP100_BY_SYMBOL = new Map(TOP100.map((row) => [row[0], row]));

// Index members that are also in the bundled Top100 reuse its market cap and sector,
// so the list has something to show without a per-company quote request.
function constituentRow(rank, symbol, name, weightPct) {
  const top = TOP100_BY_SYMBOL.get(symbol);
  return { rank, symbol, name, weight_pct: weightPct, market_cap_b: top ? Number(top[2]) : null, sector: top ? top[3] : PROFILES[symbol]?.[0] ?? null };
}

// Returns { rows, live }; live is false when the bundled fallback list was used.
async function indexConstituents(id) {
  if (id === "top100") return { live: true, rows: TOP100.map(([symbol, name, cap, sector], i) => ({ rank: i + 1, symbol, name, weight_pct: null, market_cap_b: Number(cap), sector })) };
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
        // Yahoo and the bundled lists write share classes with a dash (BRK-B), not a dot.
        const symbol = cells[2].replace(/\./g, "-");
        return constituentRow(Number.parseInt(cells[0], 10) || 0, symbol, cells[1], Number.parseFloat(cells[3].replace(/[^0-9.-]/g, "")) || null);
      }).filter(Boolean);
      if (rows.length) return { live: true, rows };
    } catch { /* use bundled fallback */ }
  }
  return { live: false, rows: fallback.map(([rank, symbol, name]) => constituentRow(rank, symbol, name, null)) };
}

// Cached constituent list shared by the stocks, quote and rank routes. A scraped list
// is kept for 6 hours; the short bundled fallback only for 10 minutes, so a transient
// scrape failure does not pin the fallback list for hours.
async function constituents(env, id) {
  if (id === "top100") return (await indexConstituents(id)).rows;
  const key = `constituents:${id}`;
  const hit = await cached(env, key);
  if (hit?.length) return hit;
  const { rows, live } = await indexConstituents(id);
  await putCache(env, key, rows, live ? 6 * 3600 : 600);
  return rows;
}

function companyName(symbol) {
  const top = TOP100_BY_SYMBOL.get(symbol);
  if (top) return top[1];
  for (const rows of Object.values(FALLBACK)) {
    const match = rows.find((row) => row[1] === symbol);
    if (match) return match[2];
  }
  return symbol;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Preset ranges that can serve a custom date window, shortest first, with the number of
// calendar days back from today each one reliably covers.
const COVERING = [["1mo", 28], ["3mo", 88], ["6mo", 178], ["1y", 360], ["2y", 725], ["5y", 1820]];

// Reads the optional start/end (YYYY-MM-DD) query params. Returns null when no custom
// window was requested, { error } when it is invalid, otherwise { start, end, covering }.
// A custom window is served by slicing the smallest preset range that contains it, so
// it shares the per-ticker cache with the preset buttons instead of adding upstream calls.
function customWindow(url) {
  const start = url.searchParams.get("start");
  if (!start) return null;
  const today = new Date().toISOString().slice(0, 10);
  const end = url.searchParams.get("end") || today;
  const valid = (d) => DATE_RE.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`));
  if (!valid(start) || !valid(end)) return { error: "日期格式需为 YYYY-MM-DD" };
  if (start > end) return { error: "开始日期不能晚于结束日期" };
  // The page sends dates in the viewer's time zone, which can be a day ahead of UTC.
  if (start > new Date(Date.now() + 86400000).toISOString().slice(0, 10)) return { error: "开始日期不能晚于今天" };
  // 10 extra days so the bar before `start` (the baseline close) is covered across holidays.
  const age = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000 + 10;
  return { start, end, covering: COVERING.find(([, days]) => age <= days)?.[0] || "max" };
}

// Bars inside the window, plus the close of the last bar before it. That earlier close
// is the baseline for the window's change, so a one-day window yields that day's move.
async function windowBars(env, ticker, interval, win) {
  const { bars } = await getBars(env, ticker, interval, win.covering);
  const before = bars.filter((b) => b.date < win.start).at(-1);
  return { bars: bars.filter((b) => b.date >= win.start && b.date <= win.end), prevClose: before ? before.close : null };
}

async function historyResponse(env, ticker, range, interval, displayName = companyName(ticker), win = null) {
  const { bars, prevClose } = win ? await windowBars(env, ticker, interval, win) : { bars: (await getBars(env, ticker, interval, range)).bars, prevClose: null };
  if (!bars.length) throw Object.assign(new Error(win ? "所选日期内没有交易数据" : `${ticker} has no history`), { status: win ? 404 : 502 });
  return { ticker, name: displayName, range: win ? "custom" : range, interval, start: bars[0].date, end: bars.at(-1).date, prev_close: prevClose,
    bars: bars.map((b) => [b.date, b.open, b.close, b.low, b.high, b.volume]) };
}

// An empty custom window is the caller's choice of dates (404), not an upstream failure (502).
function historyError(prefix, e) {
  return e?.status === 404 ? error(e.message, 404) : error(`${prefix}: ${e.message}`, 502);
}

async function stocksRoute(url, env) {
  const index = (url.searchParams.get("index") || "top100").toLowerCase();
  if (!INDICES[index]) return error(`未知指数: ${index}`, 400);
  return json(await constituents(env, index));
}

async function quoteRoute(symbol, env) {
  const key = `quote:${symbol}`;
  const hit = await cached(env, key);
  if (hit) return json(hit);
  const top = TOP100_BY_SYMBOL.get(symbol);
  const known = top || (await constituents(env, "sp500")).some((item) => item.symbol === symbol)
    || (await constituents(env, "ndx100")).some((item) => item.symbol === symbol);
  if (!known) return error(`未知代码: ${symbol}`, 404);
  let result = { ticker: symbol, symbol, marketCap: top ? Number(top[2]) : 0 };
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
  const win = customWindow(url);
  if (win?.error) return error(win.error);
  // Ranking loads history for every constituent, so it is limited to the last year.
  if (win && !["1mo", "3mo", "6mo", "1y"].includes(win.covering)) return error("涨跌榜仅支持最近一年内的日期");
  const range = url.searchParams.get("range") || "1d";
  if (!win && !["1d", "1wk", "1mo", "3mo", "6mo", "1y"].includes(range)) return error("range 需为 1d、1wk、1mo、3mo、6mo 或 1y");
  const key = win ? `rank:${index}:${win.start}:${win.end}` : `rank:${index}:${range}`;
  const hit = await cached(env, key);
  if (hit) return json(hit);
  const members = await constituents(env, index);
  const rows = await Promise.all(members.map(async ({ symbol, name: listedName }) => {
    // The constituent list carries the real company name; companyName() only knows bundled symbols.
    const name = listedName || companyName(symbol);
    try {
      const { bars, prevClose } = win ? await windowBars(env, symbol, "1d", win)
        : { bars: (await getBars(env, symbol, "1d", range === "1d" ? "1mo" : range)).bars, prevClose: null };
      if (!bars.length || (!win && bars.length < 2)) throw new Error("not enough bars");
      const last = bars.at(-1);
      // Baseline: the close before a custom window, the previous bar for 1d, else the first bar.
      const base = win ? { close: prevClose ?? bars[0].close, date: bars[0].date } : range === "1d" ? bars.at(-2) : bars[0];
      const change = Number(((last.close - base.close) / base.close * 100).toFixed(2));
      return { symbol, name, price: last.close, prev_close: base.close, chg_pct: change, date: last.date, start_date: base.date };
    } catch { return { symbol, name, price: null, prev_close: null, chg_pct: null, date: null, start_date: null }; }
  }));
  // A finished custom window does not change, so it can be kept longer than a live ranking.
  await putCache(env, key, rows, win && rows.some((row) => row.chg_pct != null) ? 300 : 60);
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

// The bundled Chinese profile is applied when the response is built, not when it is
// cached, so editing profiles.js takes effect on the next deploy instead of a day later.
// It wins over the upstream (English) summary and sector; companies without a bundled
// profile keep whatever upstream returned, which may be nothing.
function withProfile(data) {
  const profile = PROFILES[data.ticker];
  if (!profile) return data;
  return { ...data, sector: profile[0], business_summary: profile[1] };
}

async function fundamentalsRoute(symbol) {
  // Yahoo's public quoteSummary endpoint is not a supported fundamentals API.
  // Return a clear response until a stable licensed provider is configured.
  try {
    const response = await fetch(`https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=price,summaryDetail,defaultKeyStatistics,financialData,assetProfile`, { headers: { "user-agent": "Mozilla/5.0 Top100Dashboard/1.0" } });
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
    return { ticker: symbol, name: result.price?.longName || result.price?.shortName || symbol, business_summary: result.assetProfile?.longBusinessSummary || null, sector: result.assetProfile?.sector || null, industry: result.assetProfile?.industry || null, currency: result.price?.currency || "USD", metrics, annual: [], dividends: [], updated_at: Math.floor(Date.now() / 1000) };
  } catch (e) {
    // No placeholder text: a null summary lets the page hide the section instead of
    // showing a sentence that says nothing.
    return { ticker: symbol, name: companyName(symbol), business_summary: null, sector: null, industry: null, currency: "USD", metrics: {}, annual: [], dividends: [], source_error: `基本面数据源不可用：${e.message}` };
  }
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
      // v2: entries cached under the old key carry a placeholder business_summary.
      const key = `fundamentals:v2:${symbol}`;
      const force = url.searchParams.get("refresh") === "true";
      const hit = force ? null : await cached(env, key);
      if (hit) return json(withProfile(hit));
      // A failed upstream lookup is retried after 30 minutes rather than pinned for a day.
      try { const result = await fundamentalsRoute(symbol); await putCache(env, key, result, result.source_error ? 1800 : 86400); return json(withProfile(result)); }
      catch (e) { return error(e.message, 502); }
    }
    if (kind === "stock") {
      const win = customWindow(url);
      if (win?.error) return error(win.error);
      const range = url.searchParams.get("range") || "1mo", interval = url.searchParams.get("interval") || "1d";
      if ((!win && !RANGES.has(range)) || !INTERVALS.has(interval)) return error("无效的 range 或 interval");
      try { return json(await historyResponse(env, symbol, range, interval, undefined, win)); }
      catch (e) { return historyError("拉取数据失败", e); }
    }
  }
  if (path === "/api/rank") return rankRoute(url, env);
  if (path === "/api/compare") return compareRoute(url, env);
  if (path === "/api/index-history/" || path.startsWith("/api/index-history/")) {
    const id = path.split("/").at(-1).toLowerCase();
    if (!INDEX_HISTORY[id]) return error("index_id 需为 sp500 或 ndx100");
    const win = customWindow(url);
    if (win?.error) return error(win.error);
    const range = url.searchParams.get("range") || "1y", interval = url.searchParams.get("interval") || "1d";
    if ((!win && !RANGES.has(range)) || !INTERVALS.has(interval)) return error("无效的时间范围或周期");
    try { return json(await historyResponse(env, INDEX_HISTORY[id].ticker, range, interval, INDEX_HISTORY[id].name, win)); }
    catch (e) { return historyError("拉取指数数据失败", e); }
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
