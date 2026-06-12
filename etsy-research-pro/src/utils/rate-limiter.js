// Rate Limiter — Enforces Gemini/Groq free tier rate limits
// Gemini free: 15 RPM, 1500 RPD — we use 14/1400 with buffer

export class RateLimiter {
  constructor({ maxPerMinute = 14, maxPerDay = 1400, batchSize = 5 } = {}) {
    this.maxPerMinute = maxPerMinute;
    this.maxPerDay = maxPerDay;
    this.batchSize = batchSize;
    this.minuteTimestamps = [];
    this.dayCount = 0;
    this.dayStart = Date.now();
    this.onProgress = null; // callback: (current, total) => void
  }

  setProgressCallback(fn) {
    this.onProgress = fn;
  }

  _cleanMinuteWindow() {
    const oneMinuteAgo = Date.now() - 60000;
    this.minuteTimestamps = this.minuteTimestamps.filter(t => t > oneMinuteAgo);
  }

  _checkDayReset() {
    const now = Date.now();
    if (now - this.dayStart > 86400000) { // 24 hours
      this.dayCount = 0;
      this.dayStart = now;
    }
  }

  canMakeRequest() {
    this._cleanMinuteWindow();
    this._checkDayReset();
    return this.minuteTimestamps.length < this.maxPerMinute && this.dayCount < this.maxPerDay;
  }

  async waitForSlot() {
    while (!this.canMakeRequest()) {
      const waitTime = this._getWaitTime();
      if (this.onProgress) {
        this.onProgress(`Rate limit — waiting ${Math.ceil(waitTime / 1000)}s...`);
      }
      await new Promise(r => setTimeout(r, waitTime));
    }
  }

  _getWaitTime() {
    this._cleanMinuteWindow();
    if (this.minuteTimestamps.length >= this.maxPerMinute) {
      const oldestInWindow = this.minuteTimestamps[0];
      return 60000 - (Date.now() - oldestInWindow) + 100;
    }
    return 1000;
  }

  recordRequest() {
    this.minuteTimestamps.push(Date.now());
    this.dayCount++;
  }

  getStats() {
    this._cleanMinuteWindow();
    this._checkDayReset();
    return {
      minuteUsed: this.minuteTimestamps.length,
      minuteMax: this.maxPerMinute,
      dayUsed: this.dayCount,
      dayMax: this.maxPerDay,
      canRequest: this.canMakeRequest()
    };
  }
}

// Simple delay helper for scraping throttling
export function randomDelay(min = 800, max = 2000) {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(r => setTimeout(r, delay));
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
