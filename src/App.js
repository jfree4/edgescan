import { useState, useEffect, useCallback } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";
const ODDS_BASE   = "https://api.the-odds-api.com/v4";

const SPORTS_KEYWORDS = [
  "nfl","nba","mlb","nhl","nascar","mls","ufc","pga","ncaa","super bowl",
  "world series","stanley cup","championship","playoff","mvp","draft",
  "win","game","match","tournament","season","title","cup","coach","player",
  "football","basketball","baseball","hockey","soccer","golf","tennis",
  "boxing","wrestling","racing","olympics","world cup","league","division"
];

const ODDS_SPORT_KEYS = [
  "americanfootball_nfl","basketball_nba","baseball_mlb","icehockey_nhl",
  "soccer_usa_mls","mma_mixed_martial_arts","golf_pga_tour","basketball_ncaab",
  "americanfootball_ncaaf"
];

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const isSportsMarket = m => {
  const t = `${m.title||""} ${m.subtitle||""} ${m.ticker||""} ${m.event_ticker||""}`.toLowerCase();
  return SPORTS_KEYWORDS.some(k => t.includes(k));
};

const americanToProb = odds => {
  if (!odds) return null;
  return odds > 0 ? 100/(odds+100) : Math.abs(odds)/(Math.abs(odds)+100);
};

const calcEdgeScore = (market, vegaProb) => {
  const yesBid   = market.yes_bid  || 0;
  const yesAsk   = market.yes_ask  || 0;
  const last     = market.last_price || 50;
  const vol24    = market.volume_24h || 0;
  const oi       = market.open_interest || 0;

  const spread    = yesAsk - yesBid;
  const spreadPct = yesAsk > 0 ? (spread/yesAsk)*100 : 100;
  const mid       = (yesBid+yesAsk)/2;
  const drift     = Math.abs(last - mid);
  const liq       = Math.min(100, Math.log10(vol24+1)*20 + Math.log10(oi+1)*10);

  let vegaEdge = 0;
  if (vegaProb !== null && vegaProb !== undefined) {
    const kalshiProb = last / 100;
    vegaEdge = Math.abs(vegaProb - kalshiProb) * 100;
  }

  const base = spreadPct*0.35 + drift*0.35 + (100-liq)*0.15 + vegaEdge*0.15;
  return Math.min(100, Math.round(base));
};

const edgeMeta = score => {
  if (score >= 70) return { label:"HIGH EDGE",  color:"#00ff9d", bg:"#00ff9d14" };
  if (score >= 40) return { label:"MOD EDGE",   color:"#f5c542", bg:"#f5c54214" };
                   return { label:"LOW EDGE",   color:"#4a6a8a", bg:"#4a6a8a14" };
};

const fmtCents  = v => (v==null||v===undefined) ? "—" : `${v}¢`;
const fmtVol    = v => { if(!v)return"0"; if(v>=1e6)return`${(v/1e6).toFixed(1)}M`; if(v>=1e3)return`${(v/1e3).toFixed(1)}K`; return`${v}`; };
const timeUntil = d => { if(!d)return"—"; const ms=new Date(d)-Date.now(); if(ms<=0)return"Closed"; const dy=Math.floor(ms/864e5),hr=Math.floor(ms%864e5/36e5); return dy>0?`${dy}d ${hr}h`:`${hr}h ${Math.floor(ms%36e5/6e4)}m`; };
const pctFmt    = v => v!=null ? `${Math.round(v*100)}%` : "—";

// fuzzy team match: does Kalshi title mention any word from a sportsbook team name?
const fuzzyMatch = (kalshiTitle, team1, team2) => {
  const t = kalshiTitle.toLowerCase();
  const words = w => w.toLowerCase().split(/\s+/).filter(x=>x.length>3);
  return words(team1).some(w=>t.includes(w)) || words(team2).some(w=>t.includes(w));
};

// ── Known Kalshi multi-leg/bundle ticker prefixes (from console analysis) ──
const MULTI_SERIES_PREFIXES = [
  "KXMVESPORTSMULTIGAMEEXTENDED",
  "KXMVECROSSCATEGORY",
  "KXMVECBCHAMPIONSHIP",
  "KXMVESPORTS",
  "KXMVE",   // catch-all for any other KXMVE* bundle variants
];

// Market type detection: uses ticker prefix as the primary signal (most reliable).
// Any ticker not matching a known multi-leg prefix is treated as single-game.
const detectMarketType = (market) => {
  const ticker = (market.ticker || "").toUpperCase();
  if (MULTI_SERIES_PREFIXES.some(p => ticker.startsWith(p))) return "multi";
  const tl = (market.title || "").toLowerCase();
  if (/\bparlay\b|\bmulti-leg\b|\bmultileg\b/.test(tl)) return "multi";
  return "single";
};

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [tab,         setTab]        = useState("scanner"); // scanner | watchlist
  const [markets,     setMarkets]    = useState([]);
  const [oddsEvents,  setOddsEvents] = useState([]);
  const [loading,     setLoading]    = useState(false);
  const [oddsLoading, setOddsLoading]= useState(false);
  const [error,       setError]      = useState(null);
  const [oddsError,   setOddsError]  = useState(null);
  const [lastFetch,   setLastFetch]  = useState(null);
  const [sortBy,      setSortBy]     = useState("edge");
  const [filterMin,   setFilterMin]  = useState(0);
  const [selected,    setSelected]   = useState(null);
  const [page,        setPage]       = useState(1);
  const [oddsKey,     setOddsKey]    = useState("");
  const [keyInput,    setKeyInput]   = useState("");
  const [watchlist,   setWatchlist]  = useState(new Set());
  const [wlLoaded,    setWlLoaded]   = useState(false);
  const [typeFilter,  setTypeFilter] = useState("all"); // all | single | multi
  const [timeWindow,  setTimeWindow] = useState("all"); // all | today | 48h | week
  const PER_PAGE = 12;

  // ── Time window cutoff helper ──
  const getWindowCutoff = (window) => {
    const now = Date.now();
    if (window === "today") return now + 24 * 60 * 60 * 1000;
    if (window === "48h")   return now + 48 * 60 * 60 * 1000;
    if (window === "week")  return now + 7  * 24 * 60 * 60 * 1000;
    return null;
  };

  // ── Persistent watchlist via storage API ──
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("edgescan-watchlist");
        if (r) setWatchlist(new Set(JSON.parse(r.value)));
      } catch(_) {}
      setWlLoaded(true);
    })();
  }, []);

  const saveWatchlist = useCallback(async (next) => {
    try { await window.storage.set("edgescan-watchlist", JSON.stringify([...next])); } catch(_){}
  }, []);

  const toggleWatch = useCallback((ticker) => {
    setWatchlist(prev => {
      const next = new Set(prev);
      next.has(ticker) ? next.delete(ticker) : next.add(ticker);
      saveWatchlist(next);
      return next;
    });
  }, [saveWatchlist]);

  // ── Fetch all markets via our Vercel proxy (/api/markets) ──
  // The proxy handles Kalshi + Polymarket server-side, bypassing CORS restrictions.
  const fetchKalshi = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await fetch("/api/markets");
      if (!res.ok) throw new Error(`Proxy API ${res.status}`);
      const data = await res.json();
      const allMarkets = (data.markets || [])
        .filter(isSportsMarket)
        .map(m => ({ ...m, _source: m.source || m._source || "kalshi" }));

      const meta = data.meta || {};
      console.log(`[EdgeScan] Proxy response — Kalshi: ${meta.kalshi} | Polymarket: ${meta.polymarket} | Total: ${meta.total}`);

      const singles = allMarkets.filter(m => detectMarketType(m) === "single");
      const multis  = allMarkets.filter(m => detectMarketType(m) === "multi");
      console.log(`[EdgeScan] After sports filter — Total: ${allMarkets.length} | Single: ${singles.length} | Multi: ${multis.length}`);
      console.log("[EdgeScan] SINGLE samples:", singles.slice(0,8).map(m => `[${m._source}] ${m.title} | closes: ${m.close_time}`));

      setMarkets(allMarkets);
      setLastFetch(new Date());
      setPage(1);
    } catch(e) {
      // Fallback: try Kalshi directly if proxy not available (local dev without proxy)
      console.warn("[EdgeScan] Proxy unavailable, falling back to Kalshi direct:", e.message);
      try {
        const res  = await fetch(`${KALSHI_BASE}/markets?status=open&limit=1000`);
        if (!res.ok) throw new Error(`Kalshi API ${res.status}`);
        const data = await res.json();
        const markets = (data.markets || []).filter(isSportsMarket).map(m => ({...m, _source:"kalshi"}));
        setMarkets(markets);
        setLastFetch(new Date());
        setPage(1);
        setError("⚠ Running in fallback mode — Kalshi only. Deploy to Vercel to enable Polymarket data.");
      } catch(e2) { setError(e2.message); }
    }
    finally { setLoading(false); }
  }, []);

  // ── Fetch sportsbook odds ──
  const fetchOdds = useCallback(async (key) => {
    if (!key) return;
    setOddsLoading(true); setOddsError(null);
    try {
      const results = await Promise.allSettled(
        ODDS_SPORT_KEYS.map(sk =>
          fetch(`${ODDS_BASE}/sports/${sk}/odds?apiKey=${key}&regions=us&markets=h2h&oddsFormat=american`)
            .then(r => r.ok ? r.json() : [])
        )
      );
      const all = results.flatMap(r => r.status==="fulfilled" ? (r.value||[]) : []);
      setOddsEvents(all);
    } catch(e) { setOddsError(e.message); }
    finally    { setOddsLoading(false); }
  }, []);

  useEffect(() => { fetchKalshi(); }, [fetchKalshi]);

  // ── Match Kalshi market to a sportsbook event ──
  const getVegaProb = useCallback((market) => {
    if (!oddsEvents.length) return null;
    const match = oddsEvents.find(ev =>
      fuzzyMatch(market.title||"", ev.home_team||"", ev.away_team||"")
    );
    if (!match) return null;
    const book = match.bookmakers?.[0];
    if (!book) return null;
    const h2h = book.markets?.find(m => m.key==="h2h");
    if (!h2h) return null;
    // average the two sides' implied probabilities (removes vig for rough estimate)
    const probs = h2h.outcomes?.map(o => americanToProb(o.price)).filter(Boolean) || [];
    if (!probs.length) return null;
    const sum = probs.reduce((a,b)=>a+b,0);
    // normalize: find the "yes" side prob
    // return the home team implied prob as a rough proxy
    return probs[0] / sum;
  }, [oddsEvents]);

  // ── Enrich markets with edge score + vegas prob + market type ──
  const enriched = markets.map(m => {
    const vegaProb   = getVegaProb(m);
    const marketType = detectMarketType(m);
    return { ...m, vegaProb, marketType, edgeScore: calcEdgeScore(m, vegaProb) };
  });

  const sorted = [...enriched]
    .filter(m => m.edgeScore >= filterMin)
    .filter(m => typeFilter === "all" || m.marketType === typeFilter)
    .filter(m => {
      const cutoff = getWindowCutoff(timeWindow);
      if (!cutoff) return true;
      const closes = m.close_time ? new Date(m.close_time).getTime() : Infinity;
      return closes <= cutoff;
    })
    .sort((a,b) => {
      if (sortBy==="edge")    return b.edgeScore - a.edgeScore;
      if (sortBy==="volume")  return (b.volume_24h||0) - (a.volume_24h||0);
      if (sortBy==="closes")  return new Date(a.close_time) - new Date(b.close_time);
      if (sortBy==="spread")  return ((b.yes_ask||0)-(b.yes_bid||0)) - ((a.yes_ask||0)-(a.yes_bid||0));
      if (sortBy==="vega")    return (b.vegaProb!=null?1:0) - (a.vegaProb!=null?1:0);
      return 0;
    });

  const watchlistMarkets = enriched.filter(m => watchlist.has(m.ticker));
  const totalPages = Math.ceil(sorted.length / PER_PAGE);
  const visible    = sorted.slice((page-1)*PER_PAGE, page*PER_PAGE);
  const highEdge   = enriched.filter(m=>m.edgeScore>=70).length;
  const withVegas  = enriched.filter(m=>m.vegaProb!=null).length;
  const singleCount = enriched.filter(m=>m.marketType==="single").length;
  const multiCount  = enriched.filter(m=>m.marketType==="multi").length;

  return (
    <div style={{ minHeight:"100vh", background:"#06090d", color:"#b8cfe0", fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Barlow+Condensed:wght@400;600;700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:3px;height:3px}
        ::-webkit-scrollbar-thumb{background:#1e3048;border-radius:2px}
        .card{background:#0a1220;border:1px solid #122030;border-radius:5px;padding:16px;cursor:pointer;transition:border-color .15s,background .15s,transform .15s;position:relative;overflow:hidden}
        .card:hover{border-color:#1e4060;background:#0d1828;transform:translateY(-2px)}
        .card-accent{position:absolute;top:0;left:0;right:0;height:2px;background:var(--ac,#1e3048)}
        .pill{display:inline-block;padding:2px 7px;border-radius:2px;font-size:9px;font-weight:700;letter-spacing:.1em}
        .btn{padding:6px 13px;border-radius:3px;border:1px solid #122030;background:#0a1220;color:#6a90b0;font-family:inherit;font-size:11px;cursor:pointer;transition:all .15s;letter-spacing:.05em}
        .btn:hover{background:#0d1828;border-color:#1e4060;color:#a8c8e0}
        .btn:disabled{opacity:.4;cursor:default}
        .btn.act{background:#071828;border-color:#1a5080;color:#40a8e0}
        .sbtn{padding:4px 10px;border-radius:2px;border:1px solid #122030;background:transparent;color:#4a6a88;font-family:inherit;font-size:10px;cursor:pointer;transition:all .12s;letter-spacing:.06em;text-transform:uppercase}
        .sbtn:hover{color:#8ab0cc;border-color:#1e4060}
        .sbtn.act{color:#40a8e0;border-color:#1a5080;background:#06141e}
        .tab{padding:8px 18px;border-bottom:2px solid transparent;background:transparent;border-top:none;border-left:none;border-right:none;color:#4a6a88;font-family:inherit;font-size:11px;cursor:pointer;transition:all .15s;letter-spacing:.08em;text-transform:uppercase}
        .tab:hover{color:#8ab0cc}
        .tab.act{color:#40a8e0;border-bottom-color:#40a8e0}
        .input{background:#06111a;border:1px solid #122030;border-radius:3px;color:#8ab0cc;font-family:inherit;font-size:11px;padding:7px 10px;outline:none;transition:border-color .15s}
        .input:focus{border-color:#1a5080}
        .input::placeholder{color:#2a4060}
        .star{background:transparent;border:none;cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;transition:transform .15s}
        .star:hover{transform:scale(1.3)}
        .shimmer{background:linear-gradient(90deg,#0a1220 25%,#0e1c2e 50%,#0a1220 75%);background-size:200% 100%;animation:sh 1.4s infinite;border-radius:5px;height:148px}
        @keyframes sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
        .blink{animation:bk 1.5s step-end infinite}
        @keyframes bk{0%,100%{opacity:1}50%{opacity:0}}
        .delta-pos{color:#00cc66}
        .delta-neg{color:#e05050}
        .modal-bg{position:fixed;inset:0;background:rgba(0,0,0,.8);z-index:200;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px)}
        .modal{background:#08111c;border:1px solid #1a3050;border-radius:7px;width:100%;max-width:580px;max-height:92vh;overflow-y:auto;padding:28px}
        .row{display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-bottom:1px solid #0a1828}
        .row:last-child{border-bottom:none}
        input[type=range]{-webkit-appearance:none;width:100%;height:3px;background:#122030;border-radius:2px;outline:none}
        input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:13px;height:13px;border-radius:50%;background:#1a6090;cursor:pointer}
        .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:11px}
        .vega-bar-wrap{height:5px;background:#0a1828;border-radius:3px;overflow:hidden;margin-top:4px;position:relative}
        .vega-bar{height:100%;border-radius:3px;transition:width .4s ease}
        .section-head{font-size:9px;letter-spacing:.12em;color:#2a4a68;text-transform:uppercase;margin-bottom:10px;padding-bottom:6px;border-bottom:1px solid #0a1828}
      `}</style>

      {/* ── TOP BAR ── */}
      <div style={{borderBottom:"1px solid #0c1828",background:"#06090d",padding:"14px 24px",display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:"10px"}}>
        <div style={{display:"flex",alignItems:"center",gap:"14px"}}>
          <div>
            <div style={{fontSize:"17px",fontWeight:"700",color:"#e0f0ff",letterSpacing:".04em",fontFamily:"'Barlow Condensed',sans-serif"}}>
              EDGE<span style={{color:"#1a90d0"}}>SCAN</span>
              <span style={{fontSize:"11px",color:"#2a5070",marginLeft:"8px",fontFamily:"'JetBrains Mono',monospace",fontWeight:"400"}}>PRO</span>
            </div>
            <div style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".1em",marginTop:"1px"}}>SPORTS PREDICTION MARKET INTELLIGENCE</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:"10px",flexWrap:"wrap"}}>
          {lastFetch && <span style={{fontSize:"10px",color:"#2a4a68",letterSpacing:".06em"}}><span className="blink" style={{color:"#00aa55",marginRight:"4px"}}>●</span>LIVE · {lastFetch.toLocaleTimeString()}</span>}
          <button className="btn" onClick={() => { fetchKalshi(); if(oddsKey) fetchOdds(oddsKey); }} disabled={loading}>
            {loading ? "SCANNING…" : "↺ REFRESH"}
          </button>
        </div>
      </div>

      {/* ── TABS ── */}
      <div style={{borderBottom:"1px solid #0c1828",padding:"0 24px",display:"flex",gap:"0",background:"#06090d"}}>
        {[["scanner","⬡ SCANNER"],["watchlist",`★ WATCHLIST (${watchlist.size})`]].map(([key,label])=>(
          <button key={key} className={`tab ${tab===key?"act":""}`} onClick={()=>setTab(key)}>{label}</button>
        ))}
      </div>

      <div style={{padding:"20px 24px",maxWidth:"1400px",margin:"0 auto"}}>

        {/* ── STATS BAR ── */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:"10px",marginBottom:"20px"}}>
          {[
            {label:"MARKETS",      val:enriched.length,           color:"#40a8e0"},
            {label:"HIGH EDGE",    val:highEdge,                  color:"#00ff9d"},
            {label:"SINGLE-GAME",  val:singleCount,               color:"#a0d8a0"},
            {label:"MULTI-LEG",    val:multiCount,                color:"#c888ff"},
          ].map(s=>(
            <div key={s.label} style={{background:"#0a1220",border:"1px solid #122030",borderRadius:"5px",padding:"12px 16px"}}>
              <div style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".1em",marginBottom:"5px"}}>{s.label}</div>
              <div style={{fontSize:"22px",fontWeight:"700",color:loading?"#1a2a3a":s.color,fontFamily:"'Barlow Condensed',sans-serif"}}>{loading?"—":s.val}</div>
            </div>
          ))}
        </div>

        {/* ── ODDS API KEY PANEL ── */}
        <div style={{background:"#08111c",border:"1px solid #0e2030",borderRadius:"5px",padding:"14px 18px",marginBottom:"16px"}}>
          <div className="section-head">SPORTSBOOK ODDS COMPARISON · The Odds API</div>
          <div style={{display:"flex",gap:"10px",alignItems:"center",flexWrap:"wrap"}}>
            <input className="input" style={{flex:"1",minWidth:"220px"}} type="password"
              placeholder="Paste your free Odds API key → the-odds-api.com"
              value={keyInput} onChange={e=>setKeyInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"){setOddsKey(keyInput);fetchOdds(keyInput);}}}
            />
            <button className="btn act" onClick={()=>{setOddsKey(keyInput);fetchOdds(keyInput);}} disabled={!keyInput||oddsLoading}>
              {oddsLoading ? "LOADING…" : "LOAD ODDS"}
            </button>
            {oddsKey && <span style={{fontSize:"10px",color:"#00aa55",letterSpacing:".06em"}}>✓ KEY ACTIVE · {withVegas} matched</span>}
          </div>
          {oddsError && <div style={{fontSize:"11px",color:"#e05050",marginTop:"8px"}}>⚠ {oddsError} — check your API key or usage quota</div>}
          {!oddsKey && <div style={{fontSize:"10px",color:"#2a4a68",marginTop:"8px",lineHeight:"1.6"}}>
            Get a free key at <strong style={{color:"#1a6090"}}>the-odds-api.com</strong> (500 requests/month free). 
            When active, markets matched to sportsbook events will show a Vegas implied probability vs Kalshi price, surfacing potential mispricings.
          </div>}
        </div>

        {/* ── SCANNER TAB ── */}
        {tab==="scanner" && <>
          {/* Controls */}
          <div style={{display:"flex",alignItems:"center",gap:"12px",marginBottom:"16px",background:"#08111c",border:"1px solid #0e2030",borderRadius:"5px",padding:"12px 16px",flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:"5px",alignItems:"center"}}>
              <span style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".1em",marginRight:"4px"}}>SORT:</span>
              {[["edge","EDGE"],["volume","VOLUME"],["closes","CLOSING"],["spread","SPREAD"],["vega","VEGAS MATCH"]].map(([k,l])=>(
                <button key={k} className={`sbtn ${sortBy===k?"act":""}`} onClick={()=>{setSortBy(k);setPage(1);}}>{l}</button>
              ))}
            </div>
            <div style={{display:"flex",gap:"5px",alignItems:"center"}}>
              <span style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".1em",marginRight:"4px"}}>TYPE:</span>
              {[
                ["all",    "ALL",        "#40a8e0"],
                ["single", "SINGLE-GAME","#a0d8a0"],
                ["multi",  "MULTI-LEG",  "#c888ff"],
              ].map(([k,l,c])=>(
                <button key={k}
                  className={`sbtn ${typeFilter===k?"act":""}`}
                  style={typeFilter===k ? {color:c, borderColor:c+"60", background:"#060d18"} : {}}
                  onClick={()=>{setTypeFilter(k);setPage(1);}}>
                  {l}
                </button>
              ))}
            </div>
            <div style={{display:"flex",gap:"5px",alignItems:"center"}}>
              <span style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".1em",marginRight:"4px"}}>TIME:</span>
              {[
                ["all",   "ALL TIME", "#40a8e0"],
                ["today", "TODAY",    "#00ff9d"],
                ["48h",   "48 HRS",   "#f5c542"],
                ["week",  "THIS WEEK","#ff9a40"],
              ].map(([k,l,c])=>(
                <button key={k}
                  className={`sbtn ${timeWindow===k?"act":""}`}
                  style={timeWindow===k ? {color:c, borderColor:c+"60", background:"#060d18"} : {}}
                  onClick={()=>{setTimeWindow(k);setSortBy("closes");setPage(1);}}>
                  {l}
                </button>
              ))}
            </div>
            <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:"10px",minWidth:"200px"}}>
              <span style={{fontSize:"10px",color:"#2a4a68",whiteSpace:"nowrap"}}>MIN: <strong style={{color:"#6a90b0"}}>{filterMin}</strong></span>
              <input type="range" min="0" max="80" step="5" value={filterMin} onChange={e=>{setFilterMin(+e.target.value);setPage(1);}} />
            </div>
          </div>

          {error && <div style={{background:"#160606",border:"1px solid #401010",borderRadius:"5px",padding:"14px",marginBottom:"16px",color:"#e05050",fontSize:"12px"}}>⚠ {error} — Kalshi API may have CORS limits in sandbox. Try refreshing.</div>}

          {/* Grid */}
          {loading ? (
            <div className="grid">{Array.from({length:8}).map((_,i)=><div key={i} className="shimmer"/>)}</div>
          ) : visible.length===0 ? (
            <div style={{textAlign:"center",padding:"60px 20px",color:"#2a4a68"}}>
              <div style={{fontSize:"30px",marginBottom:"12px"}}>🏆</div>
              <div style={{fontSize:"13px",letterSpacing:".06em"}}>NO MARKETS MATCH YOUR FILTERS</div>
            </div>
          ) : (
            <div className="grid">
              {visible.map(m => <MarketCard key={m.ticker} market={m} watched={watchlist.has(m.ticker)} onToggleWatch={()=>toggleWatch(m.ticker)} onSelect={()=>setSelected(m)} />)}
            </div>
          )}

          {/* Pagination */}
          {totalPages>1 && (
            <div style={{display:"flex",justifyContent:"center",alignItems:"center",gap:"8px",marginTop:"20px"}}>
              <button className="btn" onClick={()=>setPage(p=>Math.max(1,p-1))} disabled={page===1}>← PREV</button>
              <span style={{fontSize:"10px",color:"#2a4a68",letterSpacing:".06em"}}>PAGE {page}/{totalPages} · {sorted.length} MARKETS</span>
              <button className="btn" onClick={()=>setPage(p=>Math.min(totalPages,p+1))} disabled={page===totalPages}>NEXT →</button>
            </div>
          )}
        </>}

        {/* ── WATCHLIST TAB ── */}
        {tab==="watchlist" && <>
          {!wlLoaded ? (
            <div style={{color:"#2a4a68",fontSize:"12px",textAlign:"center",padding:"40px"}}>Loading watchlist…</div>
          ) : watchlistMarkets.length===0 ? (
            <div style={{textAlign:"center",padding:"60px 20px",color:"#2a4a68"}}>
              <div style={{fontSize:"28px",marginBottom:"12px"}}>☆</div>
              <div style={{fontSize:"13px",letterSpacing:".06em"}}>YOUR WATCHLIST IS EMPTY</div>
              <div style={{fontSize:"11px",marginTop:"8px",color:"#1a3048"}}>Click the ☆ on any market card to track it here</div>
            </div>
          ) : (
            <>
              <div style={{marginBottom:"14px",fontSize:"11px",color:"#2a4a68",letterSpacing:".06em"}}>
                TRACKING {watchlistMarkets.length} MARKET{watchlistMarkets.length!==1?"S":""} · DATA REFRESHES ON EACH SCAN
              </div>
              <div className="grid">
                {watchlistMarkets.map(m=><MarketCard key={m.ticker} market={m} watched={true} onToggleWatch={()=>toggleWatch(m.ticker)} onSelect={()=>setSelected(m)} />)}
              </div>
            </>
          )}
        </>}

        {/* ── LEGEND ── */}
        <div style={{marginTop:"28px",background:"#08111c",border:"1px solid #0e2030",borderRadius:"5px",padding:"16px 20px"}}>
          <div className="section-head">EDGE SCORE METHODOLOGY</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:"14px"}}>
            {[
              {ic:"⟷",lbl:"BID/ASK SPREAD (35%)",desc:"Wide spread = room for inefficiency. Market makers haven't locked in tight pricing."},
              {ic:"⇲",lbl:"PRICE DRIFT (35%)",   desc:"Gap between last trade and midpoint. Sudden divergence can signal stale orders or new information."},
              {ic:"◎",lbl:"LIQUIDITY INV. (15%)", desc:"Thin markets price less efficiently. More edge opportunity but harder to size into."},
              {ic:"⚡",lbl:"VEGAS DELTA (15%)",   desc:"When Kalshi's implied probability diverges from sportsbook consensus, that gap is potential edge."},
            ].map(x=>(
              <div key={x.lbl} style={{display:"flex",gap:"10px"}}>
                <span style={{fontSize:"16px",color:"#1a6090",flexShrink:0}}>{x.ic}</span>
                <div>
                  <div style={{fontSize:"9px",color:"#40a8e0",letterSpacing:".06em",marginBottom:"3px"}}>{x.lbl}</div>
                  <div style={{fontSize:"10px",color:"#2a4a68",lineHeight:"1.5"}}>{x.desc}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{marginTop:"12px",paddingTop:"12px",borderTop:"1px solid #0a1828",fontSize:"10px",color:"#1a3048",lineHeight:"1.7"}}>
            ⚠ DISCLAIMER: Edge scores are quantitative signals only — not financial advice. Always verify resolution criteria directly on Kalshi before trading. Prediction markets carry real financial risk.
          </div>
        </div>
      </div>

      {/* ── DETAIL MODAL ── */}
      {selected && (
        <div className="modal-bg" onClick={()=>setSelected(null)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <MarketDetail market={selected} watched={watchlist.has(selected.ticker)} onToggleWatch={()=>toggleWatch(selected.ticker)} onClose={()=>setSelected(null)} />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── MARKET CARD ──────────────────────────────────────────────────────────────
function MarketCard({ market: m, watched, onToggleWatch, onSelect }) {
  const edge   = edgeMeta(m.edgeScore);
  const spread = (m.yes_ask||0)-(m.yes_bid||0);
  const kalshiPct = m.last_price != null ? m.last_price/100 : null;
  const delta  = (m.vegaProb!=null && kalshiPct!=null) ? m.vegaProb - kalshiPct : null;
  const msLeft = m.close_time ? new Date(m.close_time) - Date.now() : Infinity;
  const isToday   = msLeft > 0 && msLeft <= 24*60*60*1000;
  const is48h     = msLeft > 0 && msLeft <= 48*60*60*1000;
  const urgency   = isToday ? { label:"CLOSES TODAY", color:"#ff4a4a", bg:"#ff4a4a14" }
                  : is48h   ? { label:"NEXT 48H",     color:"#ff9a40", bg:"#ff9a4014" }
                  : null;

  return (
    <div className="card" style={{"--ac":edge.color}} onClick={onSelect}>
      <div className="card-accent"/>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"9px"}}>
        <div style={{display:"flex",gap:"5px",alignItems:"center",flexWrap:"wrap"}}>
          <span style={{
            fontSize:"8px",color: m._source==="polymarket"?"#9a70ff":"#2a4a68",
            letterSpacing:".1em",border:`1px solid ${m._source==="polymarket"?"#9a70ff40":"#0e2030"}`,
            padding:"2px 6px",borderRadius:"2px",textTransform:"uppercase"
          }}>{m._source==="polymarket"?"⬡ POLY":"⬡ KALSHI"}</span>
          {m.marketType === "multi" ? (
            <span className="pill" style={{background:"#c888ff14",color:"#c888ff",border:"1px solid #c888ff30",fontSize:"8px"}}>⛓ MULTI-LEG</span>
          ) : (
            <span className="pill" style={{background:"#a0d8a014",color:"#a0d8a0",border:"1px solid #a0d8a030",fontSize:"8px"}}>◈ SINGLE-GAME</span>
          )}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:"6px"}}>
          <span className="pill" style={{background:edge.bg,color:edge.color,border:`1px solid ${edge.color}30`}}>{edge.label}</span>
          <button className="star" style={{color:watched?"#f5c542":"#2a4a68"}} onClick={e=>{e.stopPropagation();onToggleWatch();}}>
            {watched?"★":"☆"}
          </button>
        </div>
      </div>

      <div style={{fontSize:"14px",color:"#c8e0f0",lineHeight:"1.4",marginBottom:"10px",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:"600"}}>
        {m.title||"Untitled"}
      </div>

      {/* Price bar */}
      <div style={{marginBottom:"10px"}}>
        <div style={{height:"5px",background:"#06111a",borderRadius:"3px",overflow:"hidden",marginBottom:"4px"}}>
          <div style={{height:"100%",width:`${m.last_price||50}%`,background:"linear-gradient(90deg,#0a6a35,#1a70a0)",borderRadius:"3px",transition:"width .3s"}}/>
        </div>
        <div style={{display:"flex",justifyContent:"space-between"}}>
          <span style={{fontSize:"10px",color:"#0a9955"}}>{fmtCents(m.yes_bid)} bid</span>
          <span style={{fontSize:"10px",color:"#5a9ad0"}}>last: <strong>{fmtCents(m.last_price)}</strong></span>
          <span style={{fontSize:"10px",color:"#4a80a0"}}>{fmtCents(m.yes_ask)} ask</span>
        </div>
      </div>

      {/* Vegas comparison */}
      {m.vegaProb != null && (
        <div style={{background:"#06111a",border:"1px solid #0e2030",borderRadius:"3px",padding:"7px 10px",marginBottom:"10px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:"5px"}}>
            <span style={{fontSize:"9px",color:"#1a5070",letterSpacing:".08em"}}>KALSHI</span>
            <span style={{fontSize:"9px",color:"#2a6080",letterSpacing:".08em"}}>VEGAS IMPLIED</span>
          </div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontSize:"14px",color:"#40a8e0",fontWeight:"700",fontFamily:"'Barlow Condensed',sans-serif"}}>{pctFmt(kalshiPct)}</span>
            <span style={{fontSize:"11px",fontWeight:"600",className:delta>0?"delta-pos":"delta-neg",color:delta==null?"#2a4a68":Math.abs(delta)>0.05?delta>0?"#00cc66":"#e05050":"#6a90b0"}}>
              {delta!=null ? `${delta>0?"+":""}${Math.round(delta*100)}pp` : "—"}
            </span>
            <span style={{fontSize:"14px",color:"#f5c542",fontWeight:"700",fontFamily:"'Barlow Condensed',sans-serif"}}>{pctFmt(m.vegaProb)}</span>
          </div>
          <div className="vega-bar-wrap">
            <div className="vega-bar" style={{width:`${(m.vegaProb||0)*100}%`,background:"linear-gradient(90deg,#8a6000,#f5c542)"}}/>
          </div>
        </div>
      )}

      {/* Stats row */}
      <div style={{display:"flex",gap:"14px",paddingTop:"9px",borderTop:"1px solid #0a1828",alignItems:"flex-end",flexWrap:"wrap"}}>
        <Stat label="SPREAD" val={fmtCents(spread)} hi={spread>=10}/>
        <Stat label="VOL 24H" val={fmtVol(m.volume_24h)}/>
        <div>
          <div style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".08em"}}>CLOSES</div>
          <div style={{display:"flex",alignItems:"center",gap:"5px"}}>
            <span style={{fontSize:"12px",color: urgency ? urgency.color : "#8ab0c8",fontWeight:"600"}}>{timeUntil(m.close_time)}</span>
            {urgency && <span className="pill" style={{background:urgency.bg,color:urgency.color,border:`1px solid ${urgency.color}40`,fontSize:"8px",padding:"1px 5px"}}>{urgency.label}</span>}
          </div>
        </div>
        <div style={{marginLeft:"auto",textAlign:"right"}}>
          <div style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".08em"}}>EDGE</div>
          <div style={{fontSize:"20px",fontWeight:"800",color:edge.color,fontFamily:"'Barlow Condensed',sans-serif"}}>{m.edgeScore}</div>
        </div>
      </div>
    </div>
  );
}

function Stat({ label, val, hi }) {
  return (
    <div>
      <div style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".08em"}}>{label}</div>
      <div style={{fontSize:"12px",color:hi?"#f5c542":"#8ab0c8",fontWeight:"600"}}>{val}</div>
    </div>
  );
}

// ─── MARKET DETAIL MODAL ──────────────────────────────────────────────────────
function MarketDetail({ market: m, watched, onToggleWatch, onClose }) {
  const edge = edgeMeta(m.edgeScore);
  const kalshiPct = m.last_price!=null ? m.last_price/100 : null;
  const delta = (m.vegaProb!=null && kalshiPct!=null) ? m.vegaProb - kalshiPct : null;

  return (
    <>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:"18px"}}>
        <div>
          <div style={{fontSize:"9px",color:"#2a4a68",letterSpacing:".1em",marginBottom:"5px"}}>MARKET DETAIL</div>
          <div style={{fontSize:"17px",color:"#d8f0ff",fontFamily:"'Barlow Condensed',sans-serif",fontWeight:"700",lineHeight:"1.3",maxWidth:"440px"}}>{m.title}</div>
        </div>
        <div style={{display:"flex",gap:"6px",flexShrink:0}}>
          <button className="star" style={{color:watched?"#f5c542":"#2a4a68",fontSize:"18px"}} onClick={onToggleWatch}>{watched?"★":"☆"}</button>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
      </div>

      {m.subtitle && <div style={{fontSize:"11px",color:"#2a5070",marginBottom:"16px",padding:"9px 12px",background:"#04090f",borderRadius:"4px",lineHeight:"1.5"}}>{m.subtitle}</div>}

      <div style={{display:"flex",gap:"8px",marginBottom:"18px",flexWrap:"wrap"}}>
        <span className="pill" style={{background:edge.bg,color:edge.color,border:`1px solid ${edge.color}30`,fontSize:"11px",padding:"4px 10px"}}>{edge.label}: {m.edgeScore}/100</span>
        {m.marketType === "multi" ? (
          <span className="pill" style={{background:"#c888ff14",color:"#c888ff",border:"1px solid #c888ff30",fontSize:"11px",padding:"4px 10px"}}>⛓ MULTI-LEG PARLAY</span>
        ) : (
          <span className="pill" style={{background:"#a0d8a014",color:"#a0d8a0",border:"1px solid #a0d8a030",fontSize:"11px",padding:"4px 10px"}}>◈ SINGLE-GAME</span>
        )}
        <span style={{fontSize:"9px",color:"#2a4a68",border:"1px solid #0e2030",padding:"3px 8px",borderRadius:"2px",letterSpacing:".1em"}}>{m.ticker}</span>
      </div>

      {m.marketType === "multi" && (
        <div style={{background:"#0d0818",border:"1px solid #3a1a5a",borderRadius:"4px",padding:"9px 12px",marginBottom:"14px",fontSize:"11px",color:"#9060b8",lineHeight:"1.6"}}>
          ⛓ This is a <strong style={{color:"#c888ff"}}>multi-leg market</strong> — all bundled outcomes must resolve YES for the contract to pay out. 
          Higher risk than single-game markets. Vegas comparison is not available for parlays.
        </div>
      )}

      {/* Vegas panel */}
      {m.vegaProb != null ? (
        <div style={{background:"#04090f",border:"1px solid #0e2030",borderRadius:"5px",padding:"14px 16px",marginBottom:"16px"}}>
          <div style={{fontSize:"9px",color:"#1a5070",letterSpacing:".1em",marginBottom:"10px"}}>⚡ SPORTSBOOK COMPARISON</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr auto 1fr",gap:"8px",alignItems:"center",textAlign:"center"}}>
            <div>
              <div style={{fontSize:"9px",color:"#2a5070",letterSpacing:".08em",marginBottom:"4px"}}>KALSHI LAST</div>
              <div style={{fontSize:"28px",color:"#40a8e0",fontWeight:"800",fontFamily:"'Barlow Condensed',sans-serif"}}>{pctFmt(kalshiPct)}</div>
            </div>
            <div style={{fontSize:"20px",color:delta==null?"#2a4a68":Math.abs(delta)>0.05?delta>0?"#00cc66":"#e05050":"#4a6a88",fontWeight:"700",fontFamily:"'Barlow Condensed',sans-serif"}}>
              {delta!=null ? `${delta>0?"+":""}${Math.round(delta*100)}pp` : "≈"}
            </div>
            <div>
              <div style={{fontSize:"9px",color:"#3a5a20",letterSpacing:".08em",marginBottom:"4px"}}>VEGAS IMPLIED</div>
              <div style={{fontSize:"28px",color:"#f5c542",fontWeight:"800",fontFamily:"'Barlow Condensed',sans-serif"}}>{pctFmt(m.vegaProb)}</div>
            </div>
          </div>
          {delta!=null && Math.abs(delta)>0.05 && (
            <div style={{marginTop:"10px",fontSize:"11px",color:delta>0?"#00aa55":"#d04040",padding:"7px 10px",background:delta>0?"#001a0a":"#1a0a0a",borderRadius:"3px",lineHeight:"1.5"}}>
              {delta>0
                ? `▲ Vegas implies ${Math.round(delta*100)}pp HIGHER probability than Kalshi. If you trust sportsbooks as sharper, YES is potentially underpriced.`
                : `▼ Vegas implies ${Math.round(Math.abs(delta)*100)}pp LOWER probability than Kalshi. If you trust sportsbooks as sharper, NO may be the value side.`}
            </div>
          )}
        </div>
      ) : (
        <div style={{background:"#04090f",border:"1px dashed #0e2030",borderRadius:"5px",padding:"12px 16px",marginBottom:"16px",fontSize:"11px",color:"#1a3848"}}>
          ⚡ No sportsbook match found for this market. Activate your Odds API key or try a market with a clearer team name.
        </div>
      )}

      {/* Stats */}
      <div>
        {[
          ["YES BID",       fmtCents(m.yes_bid),                    "#00aa55"],
          ["YES ASK",       fmtCents(m.yes_ask),                    "#4a90d0"],
          ["LAST TRADED",   fmtCents(m.last_price),                 "#c8e0f0"],
          ["SPREAD",        fmtCents((m.yes_ask||0)-(m.yes_bid||0)),"#f5c542"],
          ["24H VOLUME",    fmtVol(m.volume_24h),                   "#c8e0f0"],
          ["OPEN INTEREST", fmtVol(m.open_interest),                "#c8e0f0"],
          ["CLOSES IN",     timeUntil(m.close_time),                "#c8e0f0"],
          ["STATUS",        (m.status||"—").toUpperCase(),          "#40a8e0"],
        ].map(([l,v,c])=>(
          <div className="row" key={l}>
            <span style={{fontSize:"10px",color:"#2a4a68",letterSpacing:".08em"}}>{l}</span>
            <span style={{fontSize:"14px",color:c,fontWeight:"700",fontFamily:"'Barlow Condensed',sans-serif"}}>{v}</span>
          </div>
        ))}
      </div>

      <div style={{marginTop:"16px",textAlign:"center"}}>
        <a href={m._url || `https://kalshi.com/markets/${m.event_ticker}`} target="_blank" rel="noopener noreferrer"
          style={{display:"inline-block",padding:"9px 22px",background:"#061828",border:`1px solid ${m._source==="polymarket"?"#5a40a0":"#1a5080"}`,borderRadius:"4px",color:m._source==="polymarket"?"#9a70ff":"#40a8e0",fontSize:"11px",letterSpacing:".08em",textDecoration:"none",fontFamily:"inherit"}}>
          {m._source==="polymarket" ? "OPEN ON POLYMARKET →" : "OPEN ON KALSHI →"}
        </a>
      </div>
    </>
  );
}