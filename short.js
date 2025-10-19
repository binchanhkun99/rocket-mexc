import ccxt from "ccxt";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const POLL_INTERVAL = Number(process.env.POLL_INTERVAL || 60);
const MIN_24H_VOL = Number(process.env.MIN_24H_VOLUME_USDT || 500000); // futures có volume cao hơn
const PUMP_THRESHOLD = Number(process.env.PUMP_THRESHOLD || 0.2);

const exchange = new ccxt.mexc({
  enableRateLimit: true,
  options: { defaultType: "swap" }, // <== QUAN TRỌNG
});

// gửi tin nhắn telegram
async function sendTelegram(msg) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: TELEGRAM_CHAT_ID,
      text: msg,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (err) {
    console.error("❌ Telegram:", err.message);
  }
}

// SMA helper
function sma(arr, len) {
  if (arr.length < len) return Array(arr.length).fill(null);
  return arr.map((_, i) => {
    if (i < len - 1) return null;
    const slice = arr.slice(i - len + 1, i + 1);
    return slice.reduce((a, b) => a + b, 0) / len;
  });
}

// kiểm tra 1 symbol futures
async function analyzeFuture(symbol) {
  try {
    const ticker = await exchange.fetchTicker(symbol);
    const volume = ticker.quoteVolume || 0;
    if (!volume || volume < MIN_24H_VOL) return null;

    const ohlcv = await exchange.fetchOHLCV(symbol, "1m", undefined, 300);
    if (!ohlcv?.length) return null;

    const closes = ohlcv.map((c) => c[4]);
    const ma5 = sma(closes, 5);
    const ma30 = sma(closes, 30);

    const lastClose = closes.at(-1);
    const lastMA5 = ma5.at(-1);
    const lastMA30 = ma30.at(-1);

    // pump detection
    const prev = closes.slice(-180, -30);
    const recent = closes.slice(-30);
    if (!prev.length) return null;
    const maxRecent = Math.max(...recent);
    const minPrev = Math.min(...prev);
    const pumpPct = (maxRecent - minPrev) / minPrev;

    const prevMA5 = ma5.at(-2);
    const prevMA30 = ma30.at(-2);
    const bearishCross = prevMA5 >= prevMA30 && lastMA5 < lastMA30;

    const priceBelowPeak = lastClose < maxRecent * 0.96;

    if (pumpPct >= PUMP_THRESHOLD && bearishCross && priceBelowPeak) {
      return { symbol, lastClose, pumpPct, volume };
    }

    return null;
  } catch (e) {
    if (!/Rate limit/i.test(e.message)) console.error("analyze error:", e.message);
    return null;
  }
}

async function mainLoop() {
  console.log("🚀 Bắt đầu quét MEXC Futures...");
  while (true) {
    try {
      const markets = await exchange.loadMarkets();
      const symbols = Object.keys(markets).filter(
        (s) => markets[s].type === "swap" && s.endsWith(":USDT")
      );

      const results = [];
      for (const sym of symbols) {
        const res = await analyzeFuture(sym);
        if (res) {
          console.log(`🐻 ${sym}: pump ${(res.pumpPct * 100).toFixed(1)}%`);
          results.push(res);
        }
        await new Promise((r) => setTimeout(r, 200)); // tránh rate limit
      }

      if (results.length) {
        let msg = "🚨 <b>Bearish setup detected on MEXC Futures</b>\n";
        for (const r of results) {
          msg += `\n<b>${r.symbol}</b>\n💰 Price: ${r.lastClose}\n📊 Vol24h: ${r.volume.toFixed(0)}\n⚡ Pump: ${(r.pumpPct * 100).toFixed(1)}%\n`;
        }
        await sendTelegram(msg);
      } else {
        console.log("✅ Không có đồng futures nào thỏa điều kiện.");
      }
    } catch (e) {
      console.error("Main loop error:", e.message);
    }

    console.log(`⏳ Chờ ${POLL_INTERVAL}s...\n`);
    await new Promise((r) => setTimeout(r, POLL_INTERVAL * 1000));
  }
}

mainLoop();
