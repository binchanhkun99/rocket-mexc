import axios from "axios";

/**
 * Lấy multiplier (contractSize) và tính volume vào lệnh
 * @param {string} symbol - Cặp futures, ví dụ "BTC_USDT"
 * @param {number} balance - Số USDT muốn dùng
 * @param {number} leverage - Đòn bẩy
 * @param {number} price - Giá vào lệnh
 * @returns {Promise<{multiplier: number, volume: number}>}
 */
async function getVolume(symbol, balance, leverage, price) {
  try {
    const url = `https://contract.mexc.com/api/v1/contract/detail?symbol=${symbol}`;
    const response = await axios.get(url);

    if (!response.data?.data) {
      throw new Error("Không lấy được thông tin hợp đồng!");
    }

    // Trường mới là contractSize (không phải contractValue)
    const multiplier = response.data.data.contractSize;
console.log("response.data.data", response.data.data);

    if (!multiplier) {
      throw new Error("Không tìm thấy contractSize trong dữ liệu trả về!");
    }

    // Tính volume
    const volume = (balance * leverage) / (price * multiplier);

    return {
      multiplier,
      volume: Number(volume.toFixed(4)),
    };
  } catch (err) {
    console.error("Lỗi khi lấy multiplier:", err.message);
    return null;
  }
}

// 🧪 Test
(async () => {
  const symbol = "PING_USDT";
  const balance = 1;  // USDT
  const leverage = 20; // đòn bẩy
  const price = 0.02871; // giá PING_USDT hiện tại

  const result = await getVolume(symbol, balance, leverage, price);
  if (result) {
    console.log(`Multiplier (${symbol}):`, result.multiplier);
    console.log(`Volume cần đặt:`, result.volume);
  }
})();

// Multiplier (PING_USDT): 10
// Volume cần đặt: 69.6621
