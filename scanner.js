/**
 * Rogue Wave Scanner
 * Scans S&P 500, NASDAQ 100, Russell 2000 every 5 minutes during market hours
 * Scores each stock 0-5 against wave conditions
 * Sends SMS via Twilio when score >= MIN_SCORE
 */

const https = require("https");
const twilio = require("twilio");

// ─── CONFIG ────────────────────────────────────────────────────────────────
const POLYGON_API_KEY     = process.env.POLYGON_API_KEY     || "YOUR_POLYGON_KEY";
const TWILIO_ACCOUNT_SID  = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN   = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_FROM         = process.env.TWILIO_FROM;
const ALERT_TO            = process.env.ALERT_TO;
const MIN_SCORE           = parseInt(process.env.MIN_SCORE || "2"); // change to 3 to reduce noise
const SCAN_INTERVAL_MS    = 5 * 60 * 1000; // every 5 minutes
// ───────────────────────────────────────────────────────────────────────────

const sms = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ─── TICKER LISTS ──────────────────────────────────────────────────────────
// S&P 500 + NASDAQ 100 + Russell 2000 representatives
// Full dynamic list pulled from Polygon on startup
let TICKERS = [];

// Sector mapping for common tickers
const SECTOR_MAP = {
  // Tech
  AAPL:"Technology", MSFT:"Technology", NVDA:"Technology", AMD:"Technology",
  GOOGL:"Technology", META:"Technology", TSLA:"Technology", NFLX:"Technology",
  CRM:"Technology", ORCL:"Technology", ADBE:"Technology", INTC:"Technology",
  QCOM:"Technology", TXN:"Technology", AVGO:"Technology", MU:"Technology",
  // Finance
  JPM:"Finance", BAC:"Finance", WFC:"Finance", GS:"Finance", MS:"Finance",
  C:"Finance", BLK:"Finance", AXP:"Finance", V:"Finance", MA:"Finance",
  // Energy
  XOM:"Energy", CVX:"Energy", COP:"Energy", SLB:"Energy", EOG:"Energy",
  // Health
  JNJ:"Healthcare", UNH:"Healthcare", PFE:"Healthcare", ABBV:"Healthcare",
  MRK:"Healthcare", LLY:"Healthcare", BMY:"Healthcare", AMGN:"Healthcare",
  // Consumer
  AMZN:"Consumer", WMT:"Consumer", HD:"Consumer", MCD:"Consumer",
  NKE:"Consumer", SBUX:"Consumer", TGT:"Consumer", COST:"Consumer",
  // Industrial
  BA:"Industrial", CAT:"Industrial", GE:"Industrial", HON:"Industrial",
  // Default
};

function getSector(ticker) {
  return SECTOR_MAP[ticker] || "General";
}

// ─── POLYGON HELPERS ────────────────────────────────────────────────────────

function polygonGet(path) {
  return new Promise((resolve, reject) => {
    const url = `https://api.polygon.io${path}&apiKey=${POLYGON_API_KEY}`;
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

// Get list of all tickers in an index
async function getIndexTickers(index) {
  try {
    // Polygon index constituents endpoint
    const data = await polygonGet(`/v3/reference/tickers?market=stocks&exchange=XNAS,XNYS&active=true&limit=1000&`);
    if (data.results) return data.results.map(t => t.ticker);
    return [];
  } catch (e) {
    console.error("Error fetching tickers:", e.message);
    return [];
  }
}

// Get recent daily candles for a ticker (last 30 bars for indicator calculation)
async function getDailyBars(ticker, days = 30) {
  try {
    const to   = new Date().toISOString().split("T")[0];
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const data = await polygonGet(`/v2/aggs/ticker/${ticker}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=50&`);
    if (data.results && data.results.length >= 10) return data.results;
    return null;
  } catch (e) {
    return null;
  }
}

// Get intraday 5-min bars for today (for real-time volume check)
async function getIntradayBars(ticker) {
  try {
    const today = new Date().toISOString().split("T")[0];
    const data  = await polygonGet(`/v2/aggs/ticker/${ticker}/range/5/minute/${today}/${today}?adjusted=true&sort=asc&limit=100&`);
    if (data.results && data.results.length > 0) return data.results;
    return null;
  } catch (e) {
    return null;
  }
}

// Get VIX current value
async function getVIX() {
  try {
    const data = await polygonGet(`/v2/aggs/ticker/VXX/range/1/day/2024-01-01/${new Date().toISOString().split("T")[0]}?adjusted=true&sort=asc&limit=30&`);
    if (data.results && data.results.length >= 20) return data.results;
    return null;
  } catch (e) {
    return null;
  }
}

// ─── INDICATOR MATH ─────────────────────────────────────────────────────────

function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function stdev(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  return Math.sqrt(variance);
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const slice = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < slice.length; i++) {
    const diff = slice[i] - slice[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function trueRange(bars) {
  return bars.map((bar, i) => {
    if (i === 0) return bar.h - bar.l;
    const prev = bars[i - 1];
    return Math.max(bar.h - bar.l, Math.abs(bar.h - prev.c), Math.abs(bar.l - prev.c));
  });
}

// ─── WAVE SCORING ───────────────────────────────────────────────────────────

function scoreStock(ticker, dailyBars, intradayBars, vixBars) {
  const score  = { total: 0, conditions: [], details: {} };

  const closes  = dailyBars.map(b => b.c);
  const volumes = dailyBars.map(b => b.v);
  const highs   = dailyBars.map(b => b.h);
  const lows    = dailyBars.map(b => b.l);

  // ── 1. ADAPTIVE WIND (Volume) ──────────────────────────────────────────
  const volMean = sma(volumes, 20);
  const volStd  = stdev(volumes, 20);
  const lastVol = intradayBars
    ? intradayBars.reduce((sum, b) => sum + b.v, 0)  // today's total intraday volume
    : volumes[volumes.length - 1];
  const volZScore = volMean && volStd ? (lastVol - volMean) / volStd : 0;
  const rvol      = volMean ? lastVol / volMean : 0;
  const windHit   = volZScore >= 1.5; // ~1.5 sigma above mean (slightly relaxed from 2.0 for intraday)

  score.details.rvol     = rvol.toFixed(2);
  score.details.volZScore = volZScore.toFixed(2);
  if (windHit) {
    score.total++;
    score.conditions.push(`✓ Vol ${rvol.toFixed(1)}x avg`);
  } else {
    score.conditions.push(`✗ Vol ${rvol.toFixed(1)}x avg`);
  }

  // ── 2. RSI DURATION ────────────────────────────────────────────────────
  const rsiVal     = rsi(closes, 14);
  const rsiPrev    = rsi(closes.slice(0, -1), 14);
  const rsiHit     = rsiVal !== null && rsiVal > 60 && rsiPrev !== null && rsiPrev > 60;
  score.details.rsi = rsiVal ? rsiVal.toFixed(1) : "N/A";
  if (rsiHit) {
    score.total++;
    score.conditions.push(`✓ RSI ${rsiVal.toFixed(0)} (sustained)`);
  } else {
    score.conditions.push(`✗ RSI ${rsiVal ? rsiVal.toFixed(0) : "N/A"}`);
  }

  // ── 3. BOLLINGER SQUEEZE ───────────────────────────────────────────────
  const bbMid   = sma(closes, 20);
  const bbStd   = stdev(closes, 20);
  const bbUpper = bbMid + 2 * bbStd;
  const bbLower = bbMid - 2 * bbStd;

  const trs     = trueRange(dailyBars);
  const kcRange = sma(trs, 20);
  const kcUpper = bbMid + kcRange * 1.5;
  const kcLower = bbMid - kcRange * 1.5;

  // Check last 15 bars for a recent squeeze
  let recentSqueeze = false;
  for (let i = Math.max(0, dailyBars.length - 15); i < dailyBars.length; i++) {
    const c  = dailyBars.slice(0, i + 1).map(b => b.c);
    const bm = sma(c, 20);
    const bs = stdev(c, 20);
    if (!bm || !bs) continue;
    const bu = bm + 2 * bs;
    const bl = bm - 2 * bs;
    const tr = trueRange(dailyBars.slice(0, i + 1));
    const kr = sma(tr, 20);
    if (!kr) continue;
    const ku = bm + kr * 1.5;
    const kl = bm - kr * 1.5;
    if (bl > kl && bu < ku) { recentSqueeze = true; break; }
  }

  if (recentSqueeze) {
    score.total++;
    score.conditions.push(`✓ BB squeeze fired`);
  } else {
    score.conditions.push(`✗ No squeeze`);
  }

  // ── 4. FETCH (VIX) ─────────────────────────────────────────────────────
  let fetchHit = false;
  if (vixBars && vixBars.length >= 20) {
    const vixCloses = vixBars.map(b => b.c);
    const vixNow    = vixCloses[vixCloses.length - 1];
    const vixAvg    = sma(vixCloses, 20);
    fetchHit        = vixNow < vixAvg;
    score.details.vix = vixNow.toFixed(2);
    if (fetchHit) {
      score.total++;
      score.conditions.push(`✓ VIX ${vixNow.toFixed(1)} < avg (low fear)`);
    } else {
      score.conditions.push(`✗ VIX ${vixNow.toFixed(1)} elevated`);
    }
  } else {
    score.conditions.push(`✗ VIX data unavailable`);
  }

  // ── 5. HARBOR (Sector) ─────────────────────────────────────────────────
  // Approximate using price vs its own 50 SMA as a proxy
  // (Polygon free tier doesn't have ETF sector data easily)
  const priceSma50  = sma(closes, Math.min(50, closes.length));
  const lastClose   = closes[closes.length - 1];
  const harborHit   = priceSma50 && lastClose > priceSma50;
  score.details.price = lastClose.toFixed(2);
  if (harborHit) {
    score.total++;
    score.conditions.push(`✓ Price above 50 SMA`);
  } else {
    score.conditions.push(`✗ Price below 50 SMA`);
  }

  return score;
}

// ─── SMS FORMATTING ─────────────────────────────────────────────────────────

function scoreEmoji(score) {
  if (score >= 5) return "🚨";
  if (score >= 4) return "⚡";
  if (score >= 3) return "🌊";
  return "👀";
}

function scoreLabel(score) {
  if (score >= 5) return "ROGUE WAVE";
  if (score >= 4) return "STRONG SIGNAL";
  if (score >= 3) return "SETTING UP";
  return "WATCH LIST";
}

function formatSMS(ticker, score, details, sector) {
  const emoji = scoreEmoji(score.total);
  const label = scoreLabel(score.total);
  return [
    `${emoji} ${score.total}/5 ${label}: $${ticker}`,
    `Price: $${details.price} | RVOL: ${details.rvol}x | RSI: ${details.rsi}`,
    `Sector: ${sector}`,
    ``,
    score.conditions.join("\n"),
    ``,
    `Review chart before acting.`,
  ].join("\n");
}

// ─── ALERT TRACKING (prevent duplicate alerts) ───────────────────────────────
const alertedToday = new Map(); // ticker -> score -> timestamp

function wasAlertedRecently(ticker, score) {
  const key = `${ticker}-${score}`;
  const last = alertedToday.get(key);
  if (!last) return false;
  // Don't re-alert for same ticker+score within 2 hours
  return Date.now() - last < 2 * 60 * 60 * 1000;
}

function markAlerted(ticker, score) {
  alertedToday.set(`${ticker}-${score}`, Date.now());
}

// Clear alerts at midnight
function scheduleMidnightReset() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  setTimeout(() => {
    alertedToday.clear();
    console.log("Alert history cleared for new day");
    scheduleMidnightReset();
  }, next - now);
}

// ─── MARKET HOURS CHECK ─────────────────────────────────────────────────────

function isMarketHours() {
  const now = new Date();
  const est = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const day = est.getDay();
  const h   = est.getHours();
  const m   = est.getMinutes();
  const min = h * 60 + m;
  // Mon-Fri, 9:30 AM - 4:00 PM EST
  return day >= 1 && day <= 5 && min >= 570 && min <= 960;
}

// ─── MAIN SCAN LOOP ─────────────────────────────────────────────────────────

// Use a hardcoded starter list of high-volume stocks across all three indices
// In production you'd pull this dynamically from Polygon
const STARTER_TICKERS = [
  // S&P 500 large caps
  "AAPL","MSFT","NVDA","AMZN","GOOGL","META","TSLA","BRK.B","JPM","V",
  "UNH","XOM","LLY","JNJ","MA","PG","MRK","HD","ABBV","CVX",
  "COST","PEP","KO","WMT","BAC","CRM","MCD","ACN","CSCO","PFE",
  "TMO","ABT","AVGO","NFLX","ADBE","TXN","NKE","LIN","DHR","PM",
  "UPS","HON","AMGN","QCOM","IBM","GS","RTX","CAT","SPGI","AXP",
  // NASDAQ 100 extras
  "AMD","INTC","AMAT","MU","LRCX","KLAC","MRVL","PANW","SNPS","CDNS",
  "ASML","TT","DXCM","REGN","GILD","VRTX","ISRG","IDXX","ALGN","BIIB",
  "MRNA","BIDU","JD","PDD","ABNB","CRWD","ZS","OKTA","DDOG","NET",
  // Russell 2000 small caps (high vol names)
  "GME","AMC","BBBY","PLUG","FUBO","SNDL","NKLA","RIDE","WKHS","CLOV",
  "WISH","EXPR","KOSS","NAKD","ATER","IRNT","OPAD","ILUS","MULN","FFIE",
  "LCID","RIVN","JOBY","ARCHER","LILM","ACHR","EVTOL","BLNK","CHPT","NEVI",
  // More mid caps
  "COIN","HOOD","SOFI","AFRM","UPST","OPEN","LMND","ROOT","PTON","BYND",
  "DASH","RBLX","SNAP","PINS","TWTR","SPOT","SQ","PYPL","SHOP","SE",
];

async function runScan() {
  if (!isMarketHours()) {
    console.log("Outside market hours, skipping scan");
    return;
  }

  console.log(`\n🌊 Starting scan of ${STARTER_TICKERS.length} tickers at ${new Date().toISOString()}`);

  // Fetch VIX once for all stocks
  const vixBars = await getVIX();

  let alertCount = 0;

  // Process in batches to respect API rate limits
  const BATCH_SIZE = 5;
  for (let i = 0; i < STARTER_TICKERS.length; i += BATCH_SIZE) {
    const batch = STARTER_TICKERS.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (ticker) => {
      try {
        const [dailyBars, intradayBars] = await Promise.all([
          getDailyBars(ticker, 60),
          getIntradayBars(ticker),
        ]);

        if (!dailyBars) return;

        const score  = scoreStock(ticker, dailyBars, intradayBars, vixBars);
        const sector = getSector(ticker);

        console.log(`${ticker}: ${score.total}/5`);

        if (score.total >= MIN_SCORE && !wasAlertedRecently(ticker, score.total)) {
          const message = formatSMS(ticker, score, score.details, sector);
          await sms.messages.create({ body: message, from: TWILIO_FROM, to: ALERT_TO });
          markAlerted(ticker, score.total);
          alertCount++;
          console.log(`✅ Alert sent for ${ticker} (${score.total}/5)`);

          // Small delay between SMS to avoid Twilio rate limits
          await new Promise(r => setTimeout(r, 500));
        }
      } catch (err) {
        console.error(`Error scanning ${ticker}:`, err.message);
      }
    }));

    // Respect Polygon rate limits (5 req/min on free tier, unlimited on paid)
    await new Promise(r => setTimeout(r, 1200));
  }

  console.log(`✅ Scan complete. ${alertCount} alerts sent.`);
}

// ─── START ──────────────────────────────────────────────────────────────────

console.log(`🌊 Rogue Wave Scanner starting...`);
console.log(`Min score to alert: ${MIN_SCORE}/5`);
console.log(`Scan interval: every 5 minutes during market hours`);

scheduleMidnightReset();

// Run immediately on start, then every 5 minutes
runScan();
setInterval(runScan, SCAN_INTERVAL_MS);
