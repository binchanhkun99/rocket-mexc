// bot-mexc-short-scan.js
// Simple scanner for MEXC futures that notifies Telegram when a symbol matches "pump->dump / short-worthy" pattern.
//
// Env required:
//  - TELEGRAM_BOT_TOKEN
//  - TELEGRAM_CHAT_ID
//  - SCAN_INTERVAL_MS (optional, default 60000)
//  - TOP_SYMBOLS_TO_SCAN (optional, default 100)

import dotenv from 'dotenv';
import axios from 'axios';
import pLimit from 'p-limit'; // optional concurrency limiter
dotenv.config();

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const INTERVAL = parseInt(process.env.SCAN_INTERVAL_MS || '60000', 10);
const TOP_N = parseInt(process.env.TOP_SYMBOLS_TO_SCAN || '100', 10);

// MEXC futures endpoints (public)
const FUTURE_BASE = 'https://contract.mexc.com/api/v1';

// safety: require env
if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

function sma(arr, period) {
  if (arr.length < period) return null;
  const slice = arr.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function percent(a, b) { return (a - b) / b * 100; }

async function fetchSymbols() {
  // returns array of symbol names like "BTC_USDT"
  try {
    const r = await axios.get(`${FUTURE_BASE}/contract/pair/list`);
    // endpoint returns { success/data ... } on some versions:
    const data = r.data?.data || r.data;
    if (!Array.isArray(data)) return [];
    return data.map(s => s.symbol).filter(Boolean);
  } catch (e) {
    console.warn('fetchSymbols error', e.message);
    return [];
  }
}

async function fetchKlines(symbol, size = 60, period = '1m') {
  // some mexc kline endpoint variations: /contract/kline/{symbol}?period=1m&size=60
  try {
    const r = await axios.get(`${FUTURE_BASE}/contract/kline/${symbol}`, {
      params: { period, size },
      timeout: 15000,
    });
    // response typically in r.data.data (array of [timestamp,open,high,low,close,vol] or objects)
    const d = r.data?.data || r.data;
    // normalize to objects: some APIs return arrays, some return objects with keys
    if (!d) return [];
    // if array of arrays: convert
    if (Array.isArray(d) && Array.isArray(d[0])) {
      return d.map(item => ({
        ts: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4]),
        vol: parseFloat(item[5]),
      }));
    }
    // if array of objects already
    return d.map(k => ({
      ts: k.timestamp || k.id || k[0],
      open: parseFloat(k.open ?? k[1]),
      high: parseFloat(k.high ?? k[2]),
      low: parseFloat(k.low ?? k[3]),
      close: parseFloat(k.close ?? k[4]),
      vol: parseFloat(k.vol ?? k[5] ?? k.volume ?? 0),
    }));
  } catch (e) {
    // console.warn('fetchKlines error', symbol, e.message);
    return [];
  }
}

async function fetchFundingRate(symbol) {
  // public funding rate endpoint may vary; try an available endpoint
  try {
    const r = await axios.get(`${FUTURE_BASE}/public/mark/${symbol}`);
    // fallback: no funding in many public endpoints; handle gracefully
    const data = r.data?.data || r.data;
    // example: data.fundingRate or data.fundingRate24h
    return parseFloat(data?.fundingRate ?? data?.fundingRate24h ?? 0);
  } catch (e) {
    return 0;
  }
}

async function sendTelegram(text) {
  try {
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.warn('Telegram send failed', e.response?.data || e.message);
  }
}

function analyzeKlines(klines) {
  if (!klines || klines.length < 20) return null;
  const closes = klines.map(k => k.close);
  const vols = klines.map(k => k.vol || 0);

  const lastClose = closes.at(-1);
  const firstClose = closes[0];
  const change5 = percent(lastClose, closes.slice(-6, -1)[0] ?? firstClose); // approx 5-min change
  const change60 = percent(lastClose, firstClose);

  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma30 = sma(closes, 30);
  const avgVol = vols.slice(0, -5).reduce((a,b)=>a+b,0) / Math.max(vols.length-5,1);
  const lastVol = vols.at(-1) || 0;
  const volSpike = avgVol > 0 ? lastVol / avgVol : 0;

  // detect pump then dump pattern: a big positive spike in recent past then current dropping
  // we'll see if within last 15 bars had a peak then now below
  let hadRecentSpike = false;
  const lookback = Math.min(15, klines.length);
  const window = klines.slice(-lookback);
  const peak = Math.max(...window.map(k => k.high));
  const peakIdx = window.findIndex(k => k.high === peak);
  const peakToNowPct = percent(lastClose, peak);
  if (peakIdx >= 0 && peakIdx < (lookback - 1) && peakToNowPct < -5) hadRecentSpike = true;

  // MA cross: short-term MA below longer MA => bearish
  const maBearish = ma5 && ma30 ? ma5 < ma30 : false;

  return {
    lastClose,
    change5,
    change60,
    ma5, ma10, ma30,
    avgVol, lastVol, volSpike,
    hadRecentSpike,
    peakToNowPct,
    maBearish,
  };
}

async function scanOnce(symbols) {
  const found = [];
  // limit concurrency to avoid hammering API
  const limit = pLimit(6);
  const tasks = symbols.slice(0, TOP_N).map(sym => limit(async () => {
    const klines = await fetchKlines(sym, 60, '1m');
    if (!klines || klines.length === 0) return;
    const analysis = analyzeKlines(klines);
    if (!analysis) return;

    // fetch funding optionally (cheap)
    const funding = await fetchFundingRate(sym).catch(()=>0);
    // Rules to flag:
    // - had recent spike then dropped >5%
    // - lastVol spike > 3x average
    // - MA bearish (ma5 < ma30)
    // - optional: funding <= 0.02
    if (
      analysis.hadRecentSpike &&
      analysis.peakToNowPct < -5 &&
      analysis.volSpike > 3 &&
      analysis.maBearish &&
      (funding <= 0.02)
    ) {
      found.push({ sym, analysis, funding });
    }
  }));

  await Promise.all(tasks);
  return found;
}

async function mainLoop() {
  console.log('Starting MEXC short scanner. Interval (ms):', INTERVAL);
  while (true) {
    try {
      const symbols = await fetchSymbols();
      if (!symbols || symbols.length === 0) {
        console.warn('No symbols, skipping this round');
      } else {
        const hits = await scanOnce(symbols);
        if (hits.length > 0) {
          for (const h of hits) {
            const a = h.analysis;
            const text = [
              `⚠️ SHORT CANDIDATE: ${h.sym}`,
              `Price: ${a.lastClose}`,
              `Peak->Now: ${a.peakToNowPct.toFixed(2)}%`,
              `Vol spike: ${a.volSpike.toFixed(2)}x (last ${a.lastVol})`,
              `MA5: ${a.ma5?.toFixed(6)} MA30: ${a.ma30?.toFixed(6)}`,
              `Funding est: ${h.funding}`,
              `Link (MEXC futures): https://www.mexc.com/exchange/${h.sym}`, // adjust if needed
            ].join('\n');
            await sendTelegram(text);
            console.log('Notified', h.sym);
          }
        } else {
          console.log(new Date().toISOString(), 'No hits this round');
        }
      }
    } catch (e) {
      console.error('Main loop error', e.message || e);
    }

    // wait INTERVAL
    await new Promise(resolve => setTimeout(resolve, INTERVAL));
  }
}

mainLoop();
