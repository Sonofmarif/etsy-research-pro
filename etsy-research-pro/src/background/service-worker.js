// Service Worker — Main Orchestrator
// Routes all messages, orchestrates research + audit pipelines
// Manages run state, tab control, and keepalive

import { loadConfig, saveRunState, loadRunState, INTEREST_CATEGORIES } from '../utils/config.js';
import { RateLimiter, sleep } from '../utils/rate-limiter.js';
import { analyzeListings, auditListing, scoreAllListings, calculateWinScore, generateSeedKeywords } from '../modules/ai-analyzer.js';
import { saveRun, getRecentRuns, getKeywordTrend, getHistoryStats, exportHistory, clearHistory, loadAllRuns, filterRuns } from '../modules/history-manager.js';

let stopRequested = false;
let pipelineRunning = false;

// ─── MV3 Service Worker Keepalive ─────────────────────────────────────────
const KEEPALIVE_ALARM = 'erp-keepalive';

function startKeepalive() {
  try {
    chrome.alarms.create(KEEPALIVE_ALARM, {
      when: Date.now() + 20000,
      periodInMinutes: 0.35
    });
  } catch (e) {
    console.warn('[ERP] startKeepalive failed:', e.message);
  }
}

function stopKeepalive() {
  try { chrome.alarms.clear(KEEPALIVE_ALARM); } catch (e) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === KEEPALIVE_ALARM) { /* no-op keepalive */ }
});

// ─── State management (serialized queue) ──────────────────────────────────
let stateQueue = Promise.resolve();

function enqueueStateUpdate(fn) {
  stateQueue = stateQueue.then(fn).catch(e => console.error('[ERP] State error:', e));
  return stateQueue;
}

async function updateState(partial) {
  return enqueueStateUpdate(async () => {
    const current = await loadRunState();
    const updated = { ...current, ...partial };
    await saveRunState(updated);
  });
}

async function log(type, msg) {
  console.log(`[ERP] [${type}] ${msg}`);
  return enqueueStateUpdate(async () => {
    const state = await loadRunState();
    const logs = state.logs || [];
    logs.push({ type, msg, time: new Date().toLocaleTimeString() });
    if (logs.length > 500) logs.splice(0, logs.length - 500);
    await saveRunState({ ...state, logs });
  });
}

// ─── Message handler ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    // ── Start Research ──
    if (msg.action === 'startResearch') {
      (async () => {
        try {
          if (pipelineRunning) {
            sendResponse({ started: false, reason: 'Already running' });
            return;
          }
          pipelineRunning = true;
          stopRequested = false;
          await updateState({ running: true, currentStep: 'Starting research...', progress: '', lastStatus: null, logs: [] });
          sendResponse({ started: true });
          runResearchPipeline(msg.keyword, msg.productType).finally(() => { pipelineRunning = false; });
        } catch (e) {
          pipelineRunning = false;
          sendResponse({ started: false, reason: e.message });
        }
      })();
      return true;
    }

    // ── Stop Research ──
    if (msg.action === 'stopResearch') {
      (async () => {
        try {
          stopRequested = true;
          await log('warn', '🛑 Stop requested');
          await updateState({ running: false, lastStatus: 'stopped', progress: 'Stopped by user' });
          pipelineRunning = false;
          sendResponse({ stopped: true });
        } catch (e) {
          pipelineRunning = false;
          sendResponse({ stopped: false, error: e.message });
        }
      })();
      return true;
    }

    // ── Get State ──
    if (msg.action === 'getState') {
      loadRunState()
        .then(state => sendResponse(state))
        .catch(e => sendResponse(null));
      return true;
    }

    // ── Scrape Listing (for SEO audit — raw data only) ──
    if (msg.action === 'scrapeListing') {
      (async () => {
        try {
          const data = await scrapeListingUrl(msg.url);
          sendResponse({ success: true, data });
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // ── Full SEO Audit (scrape + AI analysis) ──
    if (msg.action === 'runFullAudit') {
      (async () => {
        try {
          const listingData = await scrapeListingUrl(msg.url);
          // Try AI-enhanced audit first
          const aiResult = await auditListing(listingData);
          if (aiResult.source !== 'math') {
            sendResponse({
              success: true,
              audit: {
                ...aiResult.audit,
                source: aiResult.source,
                listing_url: msg.url,
                listing_data: listingData,
                audited_at: new Date().toISOString()
              }
            });
          } else {
            // Return raw data for popup's math audit
            sendResponse({ success: true, audit: null, data: listingData, source: 'math' });
          }
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // ── Get Seed Keywords ──
    if (msg.action === 'getSeedKeywords') {
      (async () => {
        const category = msg.category;
        const config = await loadConfig();
        const localKeywords = INTEREST_CATEGORIES[category] || [];
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 3000); // 3-second timeout
          const baseUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
          const url = `${baseUrl}/seeds?category=${encodeURIComponent(category)}`;
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (response.ok) {
            const data = await response.json();
            if (data && data.keywords && data.keywords.length > 0) {
              // worker returns array of {keyword, priority} or strings
              const parsedKeywords = data.keywords.map(k => typeof k === 'object' ? k.keyword : k);
              const combined = [...new Set([...parsedKeywords, ...localKeywords])];
              sendResponse({ keywords: combined, source: 'cloudflare+built-in' });
              return;
            }
          }
        } catch (e) {
          console.warn('[ERP] Cloudflare D1 seeds fetch failed:', e.message);
        }
        sendResponse({ keywords: localKeywords, source: 'built-in' });
      })();
      return true; // Keep channel open for async response
    }

    // ── Generate AI Seed Keywords ──
    if (msg.action === 'generateAiSeeds') {
      (async () => {
        try {
          const result = await generateSeedKeywords(msg.interest);
          sendResponse(result);
        } catch (e) {
          sendResponse({ data: null, source: 'error', error: e.message });
        }
      })();
      return true;
    }

    // ── History ──
    if (msg.action === 'getRecentRuns') {
      getRecentRuns(msg.limit || 20)
        .then(runs => sendResponse({ runs }))
        .catch(e => sendResponse({ runs: [], error: e.message }));
      return true;
    }

    if (msg.action === 'getHistoryStats') {
      getHistoryStats()
        .then(stats => sendResponse(stats))
        .catch(e => sendResponse(null));
      return true;
    }

    if (msg.action === 'getKeywordTrend') {
      getKeywordTrend(msg.keyword)
        .then(trend => sendResponse({ trend }))
        .catch(e => sendResponse({ trend: null, error: e.message }));
      return true;
    }

    if (msg.action === 'getAllHistory') {
      loadAllRuns()
        .then(runs => sendResponse({ runs }))
        .catch(e => sendResponse({ runs: [], error: e.message }));
      return true;
    }

    if (msg.action === 'filterHistory') {
      filterRuns(msg.filters)
        .then(runs => sendResponse({ runs }))
        .catch(e => sendResponse({ runs: [], error: e.message }));
      return true;
    }

    if (msg.action === 'exportHistory') {
      exportHistory()
        .then(data => sendResponse(data))
        .catch(e => sendResponse(null));
      return true;
    }

    if (msg.action === 'clearHistory') {
      clearHistory()
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    // ── Check eRank ──
    if (msg.action === 'checkErank') {
      (async () => {
        try {
          const data = await checkErankForKeyword(msg.keyword);
          sendResponse(data);
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // ── Check Tool Sessions ──
    if (msg.action === 'checkToolSessions') {
      (async () => {
        try {
          const erankTabs = await chrome.tabs.query({ url: '*://*.erank.com/*' });
          const aluraTabs = await chrome.tabs.query({ url: '*://*.alura.io/*' });
          sendResponse({
            erankConnected: erankTabs.length > 0,
            aluraConnected: aluraTabs.length > 0
          });
        } catch (e) {
          sendResponse({ erankConnected: false, aluraConnected: false });
        }
      })();
      return true;
    }

    return false;
  } catch (err) {
    console.error('[ERP] service worker message listener error:', err);
    sendResponse({ success: false, error: err.message });
    return false;
  }
});

// ─── Research Pipeline ────────────────────────────────────────────────────
async function runResearchPipeline(keyword, productType = 'any') {
  startKeepalive();

  try {
    await log('info', `=== Starting research for: "${keyword}" ===`);

    // Step 0: Check cache first (Cache-First Approach)
    const config = await loadConfig();
    try {
      await updateState({ currentStep: 'Checking server cache...', progress: 'Looking up cached trends...' });
      const baseUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
      const cacheUrl = `${baseUrl}/check-cache?keyword=${encodeURIComponent(keyword)}`;
      const response = await fetch(cacheUrl);
      if (response.ok) {
        const cacheRes = await response.json();
        if (cacheRes.cached && cacheRes.data) {
          await log('success', `⚡ Cache Hit! Loaded fresh data under 90 days old from NICHE_CACHE.`);
          
          const cachedData = cacheRes.data;
          const results = {
            keyword: cachedData.keyword,
            product_type: cachedData.product_type,
            stats: cachedData.stats,
            clusters: cachedData.clusters || [],
            listings: [],
            completed_at: new Date().toISOString()
          };

          await saveRun({
            keyword: results.keyword,
            product_type: results.product_type,
            source: 'cached_server',
            ai_mode: results.stats.ai_mode,
            total: results.stats.total,
            wins: results.stats.wins,
            avg_win_score: results.stats.avg_win_score,
            avg_price: results.stats.avg_price,
            beatable_slots: results.stats.beatable_slots,
            top_niches: (results.clusters || []).map(c => ({
              name: c.niche || 'Unnamed',
              win_score: c.win_score || 0,
              verdict: c.verdict || ''
            })),
            listings_summary: []
          });

          await chrome.storage.local.set({ lastResearchResults: results });

          const overallVerdict = results.stats.avg_win_score >= 70 ? 'WIN 🏆' : results.stats.avg_win_score >= 50 ? 'GOOD 👍' : results.stats.avg_win_score >= 30 ? 'AVERAGE ⚠️' : 'SKIP ❌';
          await updateState({
            running: false,
            lastStatus: 'success',
            currentStep: `Complete (Cached): "${keyword}" — ${overallVerdict}`,
            progress: `${results.stats.total} listings | ${results.stats.wins} wins | Avg score: ${results.stats.avg_win_score}`
          });
          
          await log('success', `=== Research Complete (from Cache) for "${keyword}" — ${overallVerdict} ===`);
          return;
        }
      }
    } catch (cacheErr) {
      await log('info', `Cache check skipped: ${cacheErr.message}. Proceeding with live scrape.`);
    }

    // Step 1: Navigate to Etsy search
    if (stopRequested) return;
    await updateState({ currentStep: 'Searching Etsy...', progress: `Searching: ${keyword}` });

    const searchUrl = buildEtsySearchUrl(keyword, productType);
    await log('info', `Opening Etsy search: ${searchUrl}`);

    // Open Etsy search in a tab and extract listings
    const tabId = await openTab(searchUrl);
    const delayMs = (config.delay_between_pages !== undefined ? config.delay_between_pages : 5) * 1000;
    await sleep(delayMs); // Wait for page load using configured delay

    // Step 2: Scrape listings
    if (stopRequested) return;
    await updateState({ currentStep: 'Scraping listings...', progress: 'Extracting listing data...' });

    let listings = [];
    try {
      const response = await sendToTab(tabId, { action: 'extractEtsySearchResults' });
      if (response && response.success) {
        listings = response.listings || [];
        await log('success', `Scraped ${listings.length} listings from Etsy`);
      } else {
        await log('warn', 'Scraping returned no results — try different keyword');
      }
    } catch (e) {
      await log('error', `Scrape failed: ${e.message}`);
    }

    // Check for login warning
    try {
      const loginCheck = await sendToTab(tabId, { action: 'detectEtsyLogin' });
      if (loginCheck && loginCheck.loggedIn) {
        await log('warn', '⚠ Etsy login detected — results may be personalized. Consider using a Guest Chrome profile.');
      }
    } catch (e) {}

    // Close the tab
    try { chrome.tabs.remove(tabId); } catch (e) {}

    if (listings.length === 0) {
      await updateState({
        running: false,
        lastStatus: 'error',
        currentStep: 'No listings found',
        progress: `No results for "${keyword}" — try a different search term`
      });
      await log('error', 'No listings found — pipeline ending');
      return;
    }

    // Step 3: Score all listings
    if (stopRequested) return;
    await updateState({ currentStep: 'Scoring listings...', progress: `Calculating Win Scores for ${listings.length} listings...` });

    const detectedType = detectDominantProductType(listings) || productType;
    const scoredListings = scoreAllListings(listings, detectedType);
    await log('info', `Scored ${scoredListings.length} listings (product type: ${detectedType})`);

    // Step 4: Try eRank enhancement (optional)
    let erankData = null;
    if (config.erank_enabled) {
      try {
        await updateState({ progress: 'Checking eRank...' });
        erankData = await checkErankForKeyword(keyword);
        if (erankData && erankData.success) {
          await log('info', `eRank data: ${erankData.data.monthly_searches} monthly searches, ${erankData.data.competition_level} competition`);
        }
      } catch (e) {
        await log('info', 'eRank unavailable — using Etsy-only data');
      }
    }

    // Step 5: AI Analysis (if available)
    if (stopRequested) return;
    await updateState({ currentStep: 'AI Analysis...', progress: 'Analyzing niches...' });

    // Step 6: Calculate summary stats
    const maxReviewsThreshold = config.max_shop_reviews_beatable !== undefined ? config.max_shop_reviews_beatable : 300;
    const beatableSlots = scoredListings.slice(0, 10).filter(l => (l.shop_reviews || 0) < maxReviewsThreshold).length;

    const wins = scoredListings.filter(l => l.scores && l.scores.verdict === 'WIN');
    const avgScore = scoredListings.length > 0
      ? Math.round(scoredListings.reduce((sum, l) => sum + (l.scores?.win_score || 0), 0) / scoredListings.length)
      : 0;
    const avgPrice = scoredListings.length > 0
      ? Math.round(scoredListings.reduce((sum, l) => sum + (l.price || 0), 0) / scoredListings.length * 100) / 100
      : 0;
    const avgReviews = scoredListings.length > 0
      ? Math.round(scoredListings.reduce((sum, l) => sum + (l.shop_reviews || 0), 0) / scoredListings.length)
      : 0;

    // Step 5: AI Analysis (if available)
    if (stopRequested) return;
    await updateState({ currentStep: 'AI Analysis...', progress: 'Analyzing niches...' });

    let analysisResult;
    try {
      analysisResult = await analyzeListings(keyword, scoredListings, detectedType, beatableSlots);
      await log('success', `Analysis complete (source: ${analysisResult.source}) — found ${analysisResult.clusters.length} clusters`);
    } catch (e) {
      await log('warn', `AI analysis failed: ${e.message} — using math scoring`);
      analysisResult = { clusters: [], source: 'math' };
    }

    const stats = {
      total: scoredListings.length,
      wins: wins.length,
      avg_win_score: avgScore,
      avg_price: avgPrice,
      beatable_slots: beatableSlots,
      avg_reviews: avgReviews,
      ai_mode: analysisResult.source,
      source: erankData?.success ? 'etsy+erank' : 'etsy_only'
    };

    // Step 7: Save to history
    if (stopRequested) return;
    await updateState({ currentStep: 'Saving results...', progress: 'Storing in history...' });

    await saveRun({
      keyword,
      product_type: detectedType,
      source: stats.source,
      ai_mode: stats.ai_mode,
      total: stats.total,
      wins: stats.wins,
      avg_win_score: stats.avg_win_score,
      avg_price: stats.avg_price,
      beatable_slots: stats.beatable_slots,
      top_niches: (analysisResult.clusters || []).slice(0, 5).map(c => ({
        name: c.niche || 'Unnamed',
        win_score: c.win_score || 0,
        verdict: c.verdict || ''
      })),
      listings_summary: scoredListings.slice(0, 10).map(l => ({
        title: l.title,
        price: l.price,
        win_score: l.scores?.win_score || 0,
        verdict: l.scores?.verdict || ''
      }))
    });

    await log('success', `Run saved to history`);

    // Step 7b: Community sharing (if enabled)
    if (config.community_sharing) {
      try {
        await fetch(`${config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev'}/save-run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            keyword,
            product_type: detectedType,
            win_score: stats.avg_win_score,
            total: stats.total,
            wins: stats.wins,
            beatable: stats.beatable_slots,
            avg_price: stats.avg_price,
            average_reviews: stats.avg_reviews,
            avg_reviews: stats.avg_reviews,
            ai_mode: stats.ai_mode,
            clusters: (analysisResult.clusters || []).map(c => ({
              niche: c.niche,
              demand_score: c.demand_score || 0,
              competition_score: c.competition_score || 0,
              win_score: c.win_score || 0,
              image_prompt: c.image_prompt || ''
            }))
          })
        });
        await log('info', 'Anonymous data shared with community');
      } catch (e) {
        // Silent fail — community sharing is optional
        console.warn('[ERP] Community share failed:', e.message);
      }
    }

    // Step 8: Store results for popup to read
    const results = {
      keyword,
      product_type: detectedType,
      stats,
      clusters: analysisResult.clusters || [],
      listings: scoredListings,
      erank: erankData?.success ? erankData.data : null,
      completed_at: new Date().toISOString()
    };

    await chrome.storage.local.set({ lastResearchResults: results });

    // Done!
    const overallVerdict = avgScore >= 70 ? 'WIN 🏆' : avgScore >= 50 ? 'GOOD 👍' : avgScore >= 30 ? 'AVERAGE ⚠️' : 'SKIP ❌';
    await updateState({
      running: false,
      lastStatus: 'success',
      currentStep: `Complete: "${keyword}" — ${overallVerdict}`,
      progress: `${stats.total} listings | ${stats.wins} wins | Avg score: ${stats.avg_win_score} | ${stats.beatable_slots}/12 beatable`
    });

    await log('success', `=== Research Complete for "${keyword}" — ${overallVerdict} ===`);

  } catch (err) {
    await log('error', `Pipeline error: ${err.message}`);
    await updateState({ running: false, lastStatus: 'error', progress: err.message });
  } finally {
    stopKeepalive();
  }
}

// ─── Build Etsy search URL ────────────────────────────────────────────────
function buildEtsySearchUrl(keyword, productType) {
  const params = new URLSearchParams({
    q: keyword,
    ref: 'search_bar'
  });

  if (productType === 'digital') {
    params.set('is_digital', 'true');
  } else if (productType === 'physical') {
    // Etsy defaults to physical
  }

  return `https://www.etsy.com/search?${params.toString()}`;
}

// ─── Tab management ───────────────────────────────────────────────────────
function openTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url, active: false }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const tabId = tab.id;
      const listener = (tId, changeInfo) => {
        if (tId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve(tabId);
        }
      };
      chrome.tabs.onUpdated.addListener(listener);

      // Timeout after 30 seconds
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(tabId);
      }, 30000);
    });
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

// ─── Scrape single listing URL (for SEO audit) ───────────────────────────
async function scrapeListingUrl(url) {
  const config = await loadConfig();
  const delayMs = (config.delay_between_pages !== undefined ? config.delay_between_pages : 5) * 1000;

  const tabId = await openTab(url);
  await sleep(delayMs);

  try {
    const response = await sendToTab(tabId, { action: 'extractSingleListing' });
    if (response && response.success) {
      return response.data;
    }
    throw new Error(response?.error || 'Failed to extract listing data');
  } finally {
    try { chrome.tabs.remove(tabId); } catch (e) {}
  }
}

// ─── Check eRank for keyword data ─────────────────────────────────────────
async function checkErankForKeyword(keyword) {
  // Find an open eRank tab
  const tabs = await chrome.tabs.query({ url: 'https://members.erank.com/*' });
  if (tabs.length === 0) {
    return { success: false, error: 'No eRank tab open' };
  }

  try {
    const response = await sendToTab(tabs[0].id, { action: 'extractErankKeywordData' });
    return response;
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ─── Detect dominant product type ─────────────────────────────────────────
function detectDominantProductType(listings) {
  const counts = { digital: 0, physical: 0, pod: 0 };
  listings.forEach(l => {
    const type = l.product_type || 'physical';
    counts[type] = (counts[type] || 0) + 1;
  });

  const total = listings.length;
  if (counts.digital / total > 0.6) return 'digital';
  if (counts.pod / total > 0.6) return 'pod';
  if (counts.physical / total > 0.6) return 'physical';
  return 'any';
}
