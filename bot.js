// bot-mexc-candle-streak.js
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import https from 'https';

dotenv.config();

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const pollInterval = parseInt(process.env.POLL_INTERVAL) || 30000; // 30s
const alertCooldown = 6000; // 6s cooldown per symbol
const axiosTimeout = 8000; // 8s timeout
const klineLimit = 10;
const maxConcurrentKlineRequests = 6;
const maxRequestsPerSecond = 5; // tránh 429
const messageLifetime = 2 * 60 * 60 * 1000; // 2 tiếng

if (!token || !chatId) {
  console.error('Thiếu TELEGRAM_BOT_TOKEN hoặc TELEGRAM_CHAT_ID trong .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });

const basePrices = new Map();
const lastAlertTimes = new Map();
const sentMessages = []; // Lưu tin nhắn đã gửi để xoá sau
let binanceSymbols = new Set();

const axiosInstance = axios.create({
  timeout: axiosTimeout,
  httpsAgent: new https.Agent({ keepAlive: true }),
});

/**
 * Fetch Binance symbols
 */
async function fetchBinanceSymbols() {
  try {
    const resp = await axiosInstance.get('https://api.binance.com/api/v3/exchangeInfo');
    if (resp.data && Array.isArray(resp.data.symbols)) {
      const usdt = resp.data.symbols
        .filter(s => s.symbol.endsWith('USDT') && s.status === 'TRADING')
        .map(s => s.symbol);
      binanceSymbols = new Set(usdt);
      console.log(`Loaded ${binanceSymbols.size} Binance symbols.`);
    }
  } catch (err) {
    console.warn('Không thể load Binance symbols:', err.message);
  }
}

/**
 * Fetch all MEXC futures tickers
 */
async function fetchAllTickers() {
  try {
    const response = await axiosInstance.get('https://contract.mexc.com/api/v1/contract/ticker');
    if (response.data?.success && Array.isArray(response.data.data)) {
      return response.data.data.filter(t => t.symbol && t.symbol.endsWith('_USDT'));
    }
  } catch (err) {
    console.error('Lỗi fetch tickers:', err.message);
  }
  return [];
}

/**
 * Fetch Klines futures (Min1)
 */
async function fetchKlinesWithRetry(symbol, retries = 3) {
  const now = Math.floor(Date.now() / 1000);
  const start = now - klineLimit * 60;

  for (let i = 0; i < retries; i++) {
    try {
      const res = await axiosInstance.get(`https://contract.mexc.com/api/v1/contract/kline/${symbol}`, {
        params: { interval: 'Min1', start, end: now },
      });

      if (res.data?.success && res.data.data) {
        const { time, open, close } = res.data.data;
        const klines = time.map((t, i) => {
          const o = parseFloat(open[i]);
          const c = parseFloat(close[i]);
          const pct = ((c - o) / o) * 100;
          const candleStart = t * 1000;
          const candleEnd = candleStart + 60000;
          const isComplete = Date.now() >= candleEnd;
          return { time: candleStart, pct: isComplete ? pct : NaN };
        }).filter(k => !isNaN(k.pct));
        return klines.sort((a, b) => a.time - b.time);
      }

      return [];
    } catch (err) {
      const status = err.response?.status;
      if (status === 429) {
        const wait = 300 + Math.random() * 400;
        console.warn(`429 for ${symbol}, waiting ${wait.toFixed(0)}ms before retry (attempt ${i + 1})`);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (status === 400) return [];
      console.error(`Lỗi fetchKlines ${symbol}:`, err.message);
      return [];
    }
  }
  return [];
}

/**
 * Giới hạn tốc độ thực thi
 */
async function mapWithRateLimit(items, fn, concurrency = 8, rps = 6) {
  const results = [];
  let active = 0;
  let queue = 0;
  let lastTime = 0;
  const interval = 1000 / rps;

  async function runNext() {
    if (queue >= items.length) return;
    const i = queue++;
    active++;

    const now = Date.now();
    const diff = now - lastTime;
    if (diff < interval) await new Promise(r => setTimeout(r, interval - diff));
    lastTime = Date.now();

    const result = await fn(items[i]);
    results[i] = result;

    active--;
    if (queue < items.length) await runNext();
  }

  const initial = Math.min(concurrency, items.length);
  const runners = Array.from({ length: initial }, runNext);
  await Promise.all(runners);
  return results;
}

/**
 * Gửi tin nhắn và lưu ID để xoá sau 2 tiếng
 */
async function sendMessageWithAutoDelete(message, options) {
  try {
    const sent = await bot.sendMessage(chatId, message, options);
    sentMessages.push({ id: sent.message_id, time: Date.now() });
  } catch (err) {
    console.error('Lỗi gửi tin nhắn:', err.message);
  }
}

/**
 * Hàm xoá tin nhắn cũ hơn 2 tiếng
 */
async function cleanupOldMessages() {
  const now = Date.now();
  const oldMessages = sentMessages.filter(m => now - m.time > messageLifetime);
  if (!oldMessages.length) return;

  for (const msg of oldMessages) {
    try {
      await bot.deleteMessage(chatId, msg.id);
      console.log(`🗑️ Đã xoá tin nhắn cũ ID ${msg.id}`);
    } catch (err) {
      // ignore message already deleted
    }
  }

  // Cập nhật danh sách (chỉ giữ tin nhắn chưa hết hạn)
  sentMessages.splice(0, sentMessages.length, ...sentMessages.filter(m => now - m.time <= messageLifetime));
}

/**
 * Check candle streak (3 nến > 2%)
 */
async function checkCandleStreak(symbol) {
  try {
    const klines = await fetchKlinesWithRetry(symbol, 3);
    if (!klines || klines.length < 3) return;

    const recent = klines.slice(-10);
    let streak = [];
    let direction = null;

    for (let i = recent.length - 1; i >= 0; i--) {
      const pct = recent[i].pct;
      const isUp = pct > 1;
      const isDown = pct < -1;


      if (!direction) {
        if (isUp) {
          direction = 'up';
          streak.unshift(pct);
        } else if (isDown) {
          direction = 'down';
          streak.unshift(pct);
        } else break;
      } else {
        if ((direction === 'up' && isUp) || (direction === 'down' && isDown)) {
          streak.unshift(pct);
        } else break;
      }
    }

    if (streak.length >= 3) {
      const last = lastAlertTimes.get(symbol);
      if (last && Date.now() - last < alertCooldown) return;

      const count = streak.length;
      const isIncrease = direction === 'up';
      const emoji = isIncrease ? '🟢' : '🔴';
      const verb = isIncrease ? 'tăng' : 'giảm';
      const pcts = streak.map(p => p.toFixed(2) + '%').join(', ');
      const header = `${count} nến Min1 liên tiếp ${verb} trên 1%`;
      const link = `https://mexc.com/futures/${symbol}?type=swap`;

      const escapeMdV2 = (text) => text.replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
      const message = `${escapeMdV2(header)}\n\n[${escapeMdV2(symbol)}](${link}) ${emoji} \\(${escapeMdV2(pcts)}\\)`;

      await sendMessageWithAutoDelete(message, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: true,
      });

      lastAlertTimes.set(symbol, Date.now());
      console.log(`✅ Candle streak alert ${symbol}: ${count} ${direction} (${pcts})`);
    }
  } catch (err) {
    console.error(`Lỗi checkCandleStreak ${symbol}:`, err.message);
  }
}

/**
 * Check cumulative change >3%
 */
async function processCumulativeAlerts(tickers) {
  for (const ticker of tickers) {
    const symbol = ticker.symbol;
    const currentPrice = parseFloat(ticker.lastPrice);
    if (isNaN(currentPrice)) continue;

    const basePrice = basePrices.get(symbol);
    if (basePrice === undefined) {
      basePrices.set(symbol, currentPrice);
      continue;
    }

    const changePercent = Math.abs((currentPrice - basePrice) / basePrice * 100);
    if (changePercent > 3) {
      const lastAlertTime = lastAlertTimes.get(symbol);
      if (lastAlertTime && Date.now() - lastAlertTime < alertCooldown) continue;

      const isIncrease = currentPrice > basePrice;
      const dot = isIncrease ? '🟢' : '🔴';
      const rockets = changePercent > 50 ? '🚀🚀🚀' :
        changePercent > 25 ? '🚀🚀' :
        changePercent > 10 ? '🚀' : '';

      const binanceSymbol = symbol.replace('_USDT', 'USDT');
      const isMexcExclusive = !binanceSymbols.has(binanceSymbol);
      const prefix = isMexcExclusive ? '🅼 ' : '';

      const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
      const link = `https://mexc.com/futures/${symbol}?type=swap`;
      const message = `${prefix}${rockets} [${symbol}](${link}) ⚡ ${changePercent.toFixed(2)}% ${dot}\n\`${basePrice.toFixed(6)} → ${currentPrice.toFixed(6)}\`\n${time}`;

      await sendMessageWithAutoDelete(message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      });

      lastAlertTimes.set(symbol, Date.now());
      basePrices.set(symbol, currentPrice);
      console.log(`Cumulative alert sent for ${symbol}: ${changePercent.toFixed(2)}%`);
    }
  }
}

/**
 * Main loop
 */
async function checkAndAlert() {
  const tickers = await fetchAllTickers();
  if (!tickers?.length) {
    console.log('Không fetch được tickers.');
    return;
  }

  console.log(`Checking ${tickers.length} futures symbols...`);
  await processCumulativeAlerts(tickers);

  const symbols = tickers.map(t => t.symbol);
  await mapWithRateLimit(symbols, checkCandleStreak, maxConcurrentKlineRequests, maxRequestsPerSecond);

  await cleanupOldMessages(); // 🧹 xoá tin nhắn cũ
}

(async () => {
  console.log('Khởi động bot...');
  await fetchBinanceSymbols();
  await checkAndAlert();
  setInterval(checkAndAlert, pollInterval);
  console.log(`Bot đang chạy. Poll interval: ${pollInterval / 1000}s`);
})();
