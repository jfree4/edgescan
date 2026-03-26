// api/markets.js
// Place this file at: YOUR_PROJECT/api/markets.js
// (same level as src/, NOT inside src/)
//
// This is a Vercel Serverless Function. It runs on Vercel's servers,
// so it can freely call Kalshi and Polymarket without CORS restrictions.
// Your React app calls /api/markets instead of those APIs directly.

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const POLY_BASE   = "https://gamma-api.polymarket.com";

const SPORTS_KEYWORDS = [
  "nfl","nba","mlb","nhl","nascar","mls","ufc","pga","ncaa","super bowl",
  "world series","stanley cup","championship","playoff","win","game","match",
  "tournament","season","title","cup","football","basketball","baseball",
  "hockey","soccer","golf","tennis","boxing","wrestling","racing","league"
];

const isSports = m => {
  const t = `${m.title||""} ${m.subtitle||""} ${m.ticker||""}`.toLowerCase();
  return SPORTS_KEYWORDS.some(k => t.includes(k));
};

const MULTI_PREFIXES = [
  "KXMVESPORTSMULTIGAMEEXTENDED",
  "KXMVECROSSCATEGORY",
  "KXMVECBCHAMPIONSHIP",
  "KXMVE",
];

const marketType = m => {
  const ticker = (m.ticker || "").toUpperCase();
  if (MULTI_PREFIXES.some(p => ticker.startsWith(p))) return "multi";
  const tl = (m.title || "").toLowerCase();
  if (/\bparlay\b|\bmulti-leg\b|\bmultileg\b/.test(tl)) return "multi";
  return "single";
};

async function fetchKalshi() {
  try {
    const res  = await fetch(`${KALSHI_BASE}/markets?status=open&limit=1000`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.markets || [])
      .filter(isSports)
      .map(m => ({
        id:            m.ticker,
        ticker:        m.ticker,
        title:         m.title || "Untitled",
        subtitle:      m.subtitle || "",
        yes_bid:       m.yes_bid,
        yes_ask:       m.yes_ask,
        last_price:    m.last_price,
        volume_24h:    m.volume_24h,
        open_interest: m.open_interest,
        close_time:    m.close_time,
        event_ticker:  m.event_ticker,
        status:        m.status,
        marketType:    marketType(m),
        source:        "kalshi",
        url:           `https://kalshi.com/markets/${m.event_ticker}`,
      }));
  } catch(e) {
    console.error("Kalshi fetch error:", e.message);
    return [];
  }
}

async function fetchPolymarket() {
  try {
    const sportsRes  = await fetch(`${POLY_BASE}/sports`);
    if (!sportsRes.ok) return [];
    const leagues    = await sportsRes.json();
    const leagueList = Array.isArray(leagues) ? leagues : [];

    const leagueResults = await Promise.allSettled(
      leagueList.slice(0, 20).map(league => {
        const sid = league.series_id || league.id;
        if (!sid) return Promise.resolve([]);
        return fetch(
          `${POLY_BASE}/events?series_id=${sid}&active=true&closed=false` +
          `&tag_id=100639&limit=50&order=startTime&ascending=true`
        )
          .then(r => r.ok ? r.json() : [])
          .then(d => Array.isArray(d) ? d : (d.events || []));
      })
    );

    const fallbackRes  = await fetch(
      `${POLY_BASE}/events?active=true&closed=false&tag_slug=sports&limit=100&order=startTime&ascending=true`
    );
    const fallbackData = fallbackRes.ok ? await fallbackRes.json() : [];
    const fallbackEvs  = Array.isArray(fallbackData) ? fallbackData : (fallbackData.events || []);

    const allEvents = [
      ...leagueResults.flatMap(r => r.status === "fulfilled" ? r.value : []),
      ...fallbackEvs,
    ];

    const seen = new Set();
    const markets = [];
    for (const ev of allEvents) {
      for (const m of (ev.markets || [ev])) {
        const id = m.conditionId || m.id;
        if (!id || seen.has(id)) continue;
        seen.add(id);

        let outcomePrices = [];
        try { outcomePrices = JSON.parse(m.outcomePrices || "[]"); } catch(_) {}
        // outcomePrices[0] = YES price, outcomePrices[1] = NO price (always sums to ~1.0)
        // NEVER use the NO price as the YES ask — that's what caused the 86¢ spread bug
        const yesLastPrice = outcomePrices[0] != null
          ? Math.round(parseFloat(outcomePrices[0]) * 100)
          : null;

        // Use real order book bid/ask if available, otherwise estimate from last price
        // bestBid and bestAsk are decimal (0-1), multiply by 100 to get cents
        const yesBid = m.bestBid != null
          ? Math.round(parseFloat(m.bestBid) * 100)
          : (yesLastPrice != null ? Math.max(yesLastPrice - 2, 1) : null);
        const yesAsk = m.bestAsk != null
          ? Math.round(parseFloat(m.bestAsk) * 100)
          : (yesLastPrice != null ? Math.min(yesLastPrice + 2, 99) : null);
        const yesPrice = yesLastPrice;

        markets.push({
          id,
          ticker:        id,
          title:         m.question || ev.title || "Untitled",
          subtitle:      (ev.title && ev.title !== m.question) ? ev.title : "",
          yes_bid:       yesBid,
          yes_ask:       yesAsk,
          last_price:    m.lastTradePrice != null ? Math.round(parseFloat(m.lastTradePrice) * 100) : yesPrice,
          volume_24h:    m.volume24hr     ? Math.round(parseFloat(m.volume24hr))    : 0,
          open_interest: m.openInterest   ? Math.round(parseFloat(m.openInterest))  : 0,
          close_time:    m.endDate || m.endDateIso || ev.endDate || null,
          event_ticker:  ev.slug || id,
          status:        "open",
          marketType:    "single",
          source:        "polymarket",
          url:           `https://polymarket.com/event/${ev.slug || id}`,
        });
      }
    }
    return markets;
  } catch(e) {
    console.error("Polymarket fetch error:", e.message);
    return [];
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=30");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const [kalshiMarkets, polyMarkets] = await Promise.all([
      fetchKalshi(),
      fetchPolymarket(),
    ]);

    const seen = new Set();
    const allMarkets = [...kalshiMarkets, ...polyMarkets].filter(m => {
      if (!m.id || seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    res.status(200).json({
      markets: allMarkets,
      meta: {
        kalshi:     kalshiMarkets.length,
        polymarket: polyMarkets.length,
        total:      allMarkets.length,
        fetchedAt:  new Date().toISOString(),
      }
    });
  } catch(e) {
    res.status(500).json({ error: e.message, markets: [], meta: {} });
  }
}
