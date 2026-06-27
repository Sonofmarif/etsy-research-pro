// Etsy Research Pro — Main Background Service Worker
// Acts as a message router and keep-alive coordinator.

import { loadConfig, saveRunState, loadRunState, INTEREST_CATEGORIES } from '../utils/config.js';
import { generateSeedKeywords, auditListing } from '../modules/ai-analyzer.js';
import { getRecentRuns, getKeywordTrend, getHistoryStats, exportHistory, clearHistory, loadAllRuns, filterRuns } from '../modules/history-manager.js';

import {
  runFullPipeline,
  runSingleStep,
  stopPipeline,
  scrapeListingUrl,
  checkErankForKeyword,
  isPipelineRunning
} from './pipeline-orchestrator.js';

import { sendTelemetryError } from './telemetry.js';

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
  try {
    chrome.alarms.clear(KEEPALIVE_ALARM);
  } catch (e) {}
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === KEEPALIVE_ALARM) {
    // Keep-alive trigger
  }
});

// ─── Message handler ──────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  try {
    // Feedback report transmission
    if (msg.action === 'sendFeedback') {
      (async () => {
        try {
          const config = await loadConfig();
          const baseUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
          const telemetryUrl = `${baseUrl}/api/logs/telemetry`;
          
          if (!config.share_telemetry) {
            sendResponse({ success: false, error: 'Telemetry sharing is disabled.' });
            return;
          }
          
          const response = await fetch(telemetryUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              error_message: `[User Feedback] ${msg.notes}`,
              stack_trace: 'User feedback note',
              url: 'Popup Feedback Form',
              user_agent: 'Etsy Research Pro Extension'
            })
          });
          if (response.ok) {
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: `Worker returned ${response.status}` });
          }
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;
    }

    // ── Start Research / Start Pipeline ──
    if (msg.action === 'startResearch' || msg.action === 'startPipeline') {
      (async () => {
        try {
          if (isPipelineRunning()) {
            sendResponse({ started: false, reason: 'Already running' });
            return;
          }
          
          const seedKeyword = msg.seedKeyword || msg.keyword || '';
          
          // Retrieve config values
          const config = await loadConfig();
          config.min_qualified_keywords = parseInt(config.min_qualified_keywords) || 5;
          config.delay_between_pages = parseInt(config.delay_between_pages) || 3;
          
          const mergedOptions = { ...config, ...(msg.options || {}) };
          
          await saveRunState({
            running: true,
            currentStep: 'Starting research...',
            progress: '',
            lastStatus: null,
            logs: [],
            layoutFixNotification: null,
            steps: {
              find_keyword: 'pending',
              snapshot: 'pending',
              listing_audit: 'pending',
              final_report: 'pending'
            }
          });
          
          sendResponse({ started: true });
          startKeepalive();

          const runner = (msg.action === 'startResearch' || msg.mode === 'full')
            ? runFullPipeline(seedKeyword, mergedOptions)
            : runSingleStep(msg.step, seedKeyword, mergedOptions);
            
          runner.finally(() => {
            stopKeepalive();
          });
        } catch (e) {
          sendResponse({ started: false, reason: e.message });
        }
      })();
      return true;
    }

    // ── Stop Research / Stop Pipeline ──
    if (msg.action === 'stopResearch' || msg.action === 'stopPipeline') {
      (async () => {
        try {
          stopPipeline();
          stopKeepalive();
          
          const currentState = await loadRunState();
          const logs = currentState.logs || [];
          logs.push({ type: 'warn', msg: '🛑 Stop requested by user', time: new Date().toLocaleTimeString() });
          
          await saveRunState({
            ...currentState,
            running: false,
            lastStatus: 'stopped',
            progress: 'Stopped by user',
            logs
          });
          
          sendResponse({ stopped: true });
        } catch (e) {
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
          const timeoutId = setTimeout(() => controller.abort(), 3000);
          const baseUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
          const url = `${baseUrl}/seeds?category=${encodeURIComponent(category)}`;
          const response = await fetch(url, { signal: controller.signal });
          clearTimeout(timeoutId);
          if (response.ok) {
            const data = await response.json();
            if (data && data.keywords && data.keywords.length > 0) {
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
      return true;
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

    // ── keepAlive from orchestrator ──
    if (msg.action === 'keepAlive') {
      sendResponse({ status: 'ok' });
      return false;
    }

  } catch (err) {
    console.error('[ERP] service worker message listener error:', err);
    sendTelemetryError(`onMessage error: ${err.message}`, err.stack, `onMessage:${msg?.action}`);
    sendResponse({ success: false, error: err.message });
    return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('[ERP] Etsy Research Pro extension installed');
  saveRunState({
    running: false,
    currentStep: null,
    progress: '',
    logs: [],
    lastStatus: null,
    layoutFixNotification: null,
    steps: {
      find_keyword: 'pending',
      snapshot: 'pending',
      listing_audit: 'pending',
      final_report: 'pending'
    }
  });
});
