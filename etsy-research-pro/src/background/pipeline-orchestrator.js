// Etsy Research Pro — Pipeline Orchestrator
// Coordinates search page scraping, ERank auditing, and niche scores processing.

import { loadConfig, saveRunState, loadRunState, INTEREST_CATEGORIES } from '../utils/config.js';
import { RateLimiter, sleep } from '../utils/rate-limiter.js';
import { analyzeListings, auditListing, scoreAllListings, calculateWinScore, generateSeedKeywords } from '../modules/ai-analyzer.js';
import { saveRun, getRecentRuns, getKeywordTrend, getHistoryStats, exportHistory, clearHistory, loadAllRuns, filterRuns } from '../modules/history-manager.js';

import { runErankKeywordResearch } from '../worker-modules/erank-keyword-workflow.js';
import { runEtsySearchSnapshots } from '../worker-modules/etsy-snapshot-workflow.js';
import { runErankListingAudit } from '../worker-modules/erank-listing-workflow.js';
import { runNicheScoring } from '../worker-modules/niche-scoring-workflow.js';
import { clusterKeywordsIntoConcepts } from '../worker-modules/concept-clustering.js';

import { sendTelemetryError, flushLogsToServer } from './telemetry.js';
import { triggerWebhook } from './webhook-reporter.js';

export let stopRequested = false;
export let pipelineRunning = false;
export let workTabId = null;

export function isPipelineRunning() {
  return pipelineRunning;
}

export function stopPipeline() {
  stopRequested = true;
  pipelineRunning = false;
}

// ─── State queue ──────────────────────────────────
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
    if (logs.length > 1000) logs.splice(0, logs.length - 1000);
    await saveRunState({ ...state, logs });
  });
}

async function setStepStatus(stepKey, status) {
  return enqueueStateUpdate(async () => {
    const state = await loadRunState();
    const steps = state.steps || {
      find_keyword: 'pending',
      snapshot: 'pending',
      listing_audit: 'pending',
      final_report: 'pending'
    };
    steps[stepKey] = status;
    await saveRunState({ ...state, steps });
  });
}

// ─── LocalStorageClient implementation of sheetsClient ──────────────────
export class LocalStorageClient {
  constructor() {
    this._configCache = null;
  }

  static TABLE_MAP = {
    'etsy_keywords':          'keywords',
    'etsy_listings':          'listings',
    'etsy_stores':            'stores',
    'etsy_search_snapshots':  'search_snapshots',
    'seed_keywords':          'seed_keywords',
    'listing_audit':          'listing_audit',
    'keyword_suggestions':    'keyword_suggestions',
    'niche_scores':           'niche_scores',
    'automation_log':         'automation_log',
    'user_keyword_results':   'user_keyword_results',
    'user_runs':              'user_runs'
  };

  static SHEET_COLUMNS = {
    'seed_keywords': ['seed_id', 'keyword', 'source', 'category', 'product_type', 'times_searched', 'exhaustion_count', 'is_exhausted', 'status', 'locale', 'last_run_at', 'notes'],
    'keywords': ['keyword_id', 'seed_id', 'keyword', 'product_type', 'category', 'avg_searches', 'competition', 'click_rate', 'trend_velocity', '_skip_score', 'status', 'snapshot_count', 'last_snapshot_at', 'peak_month', 'optimal_list_date', 'source', '_skip_country_json', 'created_at'],
    'search_snapshots': ['snapshot_id', 'keyword_id', 'keyword_text', 'page_number', 'search_type', 'snapshot_date', 'listing_count', 'notes'],
    'listings': ['listing_id', 'keyword_id', 'snapshot_id', 'shop_name', 'title', 'price', 'original_price', 'discount_pct', 'rating', 'review_count', 'is_digital', 'is_bestseller', 'is_popular_now', 'search_position', 'run_number', 'snapshot_date', 'etsy_url', 'urgency_text', 'free_delivery'],
    'stores': ['shop_name', 'shop_rating', 'shop_review_count', 'source', 'total_sales', 'shop_location', 'shop_established', 'is_star_seller', 'shop_team_size'],
    'listing_audit': ['listing_id', 'keyword_text', 'title', 'erank_est_sales', 'erank_views', 'erank_daily_views', 'erank_monthly_views', 'erank_hearts', 'erank_conversion_rate', 'erank_title_length', 'erank_tags_count', 'erank_score', 'erank_listing_age', 'erank_qty', 'tags_list', 'in_carts', 'sold_24h', 'views_24h', 'etsy_thumbnail_url', 'favorites_count', 'photo_count', 'has_video', 'created_at'],
    'keyword_suggestions': ['suggestion_id', 'parent_keyword_id', 'keyword', 'avg_searches', 'competition', 'click_rate', 'source', 'promoted', 'created_at'],
    'niche_scores': ['niche_id', 'category', 'seed_keyword', 'product_type', 'total_keywords', 'validated_keywords', 'total_listings', 'total_shops', 'avg_price', 'avg_competition', 'avg_searches', 'weak_competitor_pct', 'readiness_score', 'status', 'report_url', 'scored_at'],
    'automation_log': ['log_id', 'task_name', 'started_at', 'completed_at', 'status', 'items_processed', 'items_success', 'items_failed', 'error_message', 'notes'],
  };

  static GLOBAL_COLUMN_MAP = {
    'last_searched_at':  'last_run_at',
    'search_by_country': 'locale',
    'trend':             'trend_velocity',
    'velocity':          'trend_velocity',
    'parent_kw_id':      'parent_keyword_id',
  };

  static TABLE_COLUMN_MAP = {
    'search_snapshots': {
      'keyword': 'keyword_text',
      'version': 'page_number',
      'type':    'search_type',
    },
    'listing_audit': {
      'keyword': 'keyword_text',
    },
  };

  static _resolveTable(sheetName) {
    return LocalStorageClient.TABLE_MAP[sheetName] || sheetName;
  }

  static _mapColumnForTable(col, table) {
    const tableMap = LocalStorageClient.TABLE_COLUMN_MAP[table];
    if (tableMap && tableMap[col]) return tableMap[col];
    return LocalStorageClient.GLOBAL_COLUMN_MAP[col] || col;
  }

  async readConfig() {
    return await loadConfig();
  }

  async getConfig() {
    return await loadConfig();
  }

  invalidateConfig() {
    // no-op
  }

  async _getTable(table) {
    const key = `table_${table}`;
    const data = await chrome.storage.local.get(key);
    let list = data[key] || [];
    if (table === 'seed_keywords' && list.length === 0) {
      list = [];
      let seedId = 1;
      for (const [category, keywords] of Object.entries(INTEREST_CATEGORIES)) {
        for (const kw of keywords) {
          list.push({
            seed_id: seedId,
            keyword: kw,
            source: 'built-in',
            category: category,
            product_type: 'any',
            times_searched: 0,
            exhaustion_count: 0,
            is_exhausted: 0,
            status: 'pending',
            locale: 'US',
            last_run_at: '',
            notes: ''
          });
          seedId++;
        }
      }
      await chrome.storage.local.set({ [key]: list });
    }
    return list;
  }

  async _saveTable(table, list) {
    const key = `table_${table}`;
    await chrome.storage.local.set({ [key]: list });
  }

  async readSheet(sheetName, filters = {}, options = {}) {
    const table = LocalStorageClient._resolveTable(sheetName);
    let rows = await this._getTable(table);

    let filtersCopy = { ...filters };
    if (filtersCopy.hasOwnProperty('seed_id')) {
      const targetSeedId = String(filtersCopy.seed_id);
      delete filtersCopy.seed_id;
      
      if (table === 'listings' || table === 'listing_audit') {
        const keywordsTable = await this._getTable('keywords');
        const seedKeywords = keywordsTable.filter(k => String(k.seed_id) === targetSeedId);
        
        if (table === 'listings') {
          const allowedKwIds = new Set(seedKeywords.map(k => String(k.keyword_id)));
          rows = rows.filter(row => allowedKwIds.has(String(row.keyword_id)));
        } else if (table === 'listing_audit') {
          const allowedKwTexts = new Set(seedKeywords.map(k => String(k.keyword || '').toLowerCase().trim()));
          rows = rows.filter(row => allowedKwTexts.has(String(row.keyword_text || '').toLowerCase().trim()));
        }
      }
    }

    for (const [k, v] of Object.entries(filtersCopy)) {
      const mappedK = LocalStorageClient._mapColumnForTable(k, table);
      rows = rows.filter(row => {
        const val = row[mappedK];
        return String(val ?? '').toLowerCase().trim() === String(v ?? '').toLowerCase().trim();
      });
    }

    if (options.sinceHours && options.sinceColumn) {
      const sinceCol = LocalStorageClient._mapColumnForTable(options.sinceColumn, table);
      const cutoff = Date.now() - (options.sinceHours * 60 * 60 * 1000);
      rows = rows.filter(row => {
        let dateStr = row[sinceCol];
        if (!dateStr && (sinceCol === 'updated_at' || sinceCol === 'audited_at')) {
          dateStr = row['created_at'] || row['snapshot_date'];
        }
        if (!dateStr) return false;
        const time = new Date(dateStr).getTime();
        return isFinite(time) && time >= cutoff;
      });
    }

    if (options.orderBy) {
      const sortCol = LocalStorageClient._mapColumnForTable(options.orderBy, table);
      const order = (options.order || 'ASC').toUpperCase();
      rows.sort((a, b) => {
        const valA = a[sortCol];
        const valB = b[sortCol];
        if (valA === valB) return 0;
        if (valA === undefined || valA === null) return 1;
        if (valB === undefined || valB === null) return -1;
        if (typeof valA === 'number' && typeof valB === 'number') {
          return order === 'ASC' ? valA - valB : valB - valA;
        }
        return order === 'ASC' 
          ? String(valA).localeCompare(String(valB)) 
          : String(valB).localeCompare(String(valA));
      });
    }

    const REVERSE_MAP = {};
    for (const [sheetCol, mysqlCol] of Object.entries(LocalStorageClient.GLOBAL_COLUMN_MAP)) {
      if (!REVERSE_MAP[mysqlCol]) REVERSE_MAP[mysqlCol] = [];
      REVERSE_MAP[mysqlCol].push(sheetCol);
    }
    const tableColMap = LocalStorageClient.TABLE_COLUMN_MAP[table];
    if (tableColMap) {
      for (const [sheetCol, mysqlCol] of Object.entries(tableColMap)) {
        if (!REVERSE_MAP[mysqlCol]) REVERSE_MAP[mysqlCol] = [];
        REVERSE_MAP[mysqlCol].push(sheetCol);
      }
    }

    const aliasedRows = rows.map(row => {
      const newRow = { ...row };
      for (const key of Object.keys(row)) {
        const aliases = REVERSE_MAP[key];
        if (aliases) {
          for (const alias of aliases) {
            if (!newRow.hasOwnProperty(alias)) {
              newRow[alias] = row[key];
            }
          }
        }
        const normalized = key.trim().toLowerCase().replace(/[\s\-]+/g, '_');
        if (normalized !== key && !newRow.hasOwnProperty(normalized)) {
          newRow[normalized] = row[key];
        }
      }
      return newRow;
    });

    const headers = aliasedRows.length > 0 ? Object.keys(aliasedRows[0]) : [];
    return { headers, rows: aliasedRows };
  }

  async appendRows(sheetName, rows) {
    if (!rows || rows.length === 0) return;
    const table = LocalStorageClient._resolveTable(sheetName);
    const list = await this._getTable(table);
    const columns = LocalStorageClient.SHEET_COLUMNS[table] || [];

    const newObjects = rows.map(row => {
      if (Array.isArray(row)) {
        const obj = {};
        for (let i = 0; i < Math.min(row.length, columns.length); i++) {
          if (columns[i].startsWith('_skip_')) continue;
          obj[columns[i]] = row[i];
        }
        return obj;
      }
      const obj = {};
      for (const [k, v] of Object.entries(row)) {
        const mappedK = LocalStorageClient._mapColumnForTable(k, table);
        obj[mappedK] = v;
      }
      return obj;
    });

    list.push(...newObjects);
    await this._saveTable(table, list);
    return { success: true, affected: newObjects.length };
  }

  async appendRowsByName(sheetName, rowObjects) {
    return this.appendRows(sheetName, rowObjects);
  }

  async findRow(sheetName, matchCol, matchVal) {
    const table = LocalStorageClient._resolveTable(sheetName);
    const list = await this._getTable(table);
    const mappedCol = LocalStorageClient._mapColumnForTable(matchCol, table);
    const row = list.find(r => String(r[mappedCol] ?? '').toLowerCase().trim() === String(matchVal ?? '').toLowerCase().trim());
    return row || null;
  }

  async rowExists(sheetName, matchCol, matchVal) {
    const row = await this.findRow(sheetName, matchCol, matchVal);
    return row !== null;
  }

  async updateRowByMatch(sheetName, matchCol, matchVal, updates) {
    const table = LocalStorageClient._resolveTable(sheetName);
    const list = await this._getTable(table);
    const mappedCol = LocalStorageClient._mapColumnForTable(matchCol, table);
    let affected = 0;

    const mappedUpdates = {};
    for (const [k, v] of Object.entries(updates)) {
      const mappedK = LocalStorageClient._mapColumnForTable(k, table);
      mappedUpdates[mappedK] = v;
    }

    const updatedList = list.map(row => {
      if (String(row[mappedCol] ?? '').toLowerCase().trim() === String(matchVal ?? '').toLowerCase().trim()) {
        affected++;
        return { ...row, ...mappedUpdates };
      }
      return row;
    });

    if (affected > 0) {
      await this._saveTable(table, updatedList);
    }
    return affected > 0;
  }

  async upsertRow(sheetName, matchCol, matchVal, rowData) {
    const table = LocalStorageClient._resolveTable(sheetName);
    const list = await this._getTable(table);
    const mappedCol = LocalStorageClient._mapColumnForTable(matchCol, table);
    
    const mappedUpdates = {};
    for (const [k, v] of Object.entries(rowData)) {
      const mappedK = LocalStorageClient._mapColumnForTable(k, table);
      mappedUpdates[mappedK] = v;
    }
    mappedUpdates[mappedCol] = matchVal;

    const idx = list.findIndex(row => String(row[mappedCol] ?? '').toLowerCase().trim() === String(matchVal ?? '').toLowerCase().trim());
    if (idx !== -1) {
      list[idx] = { ...list[idx], ...mappedUpdates };
    } else {
      list.push(mappedUpdates);
    }
    await this._saveTable(table, list);
    return { success: true };
  }

  async upsertRowsBatch(sheetName, rowObjects) {
    if (!rowObjects || rowObjects.length === 0) return { success: true, affected: 0 };
    const table = LocalStorageClient._resolveTable(sheetName);
    const list = await this._getTable(table);
    const keyName = table === 'stores' ? 'shop_name' : (table === 'listings' ? 'listing_id' : (table === 'search_snapshots' ? 'snapshot_id' : 'id'));

    for (const row of rowObjects) {
      const mappedRow = {};
      for (const [k, v] of Object.entries(row)) {
        const mappedK = LocalStorageClient._mapColumnForTable(k, table);
        mappedRow[mappedK] = v;
      }
      const matchVal = mappedRow[keyName];
      if (!matchVal) {
        list.push(mappedRow);
        continue;
      }

      const idx = list.findIndex(r => String(r[keyName] ?? '').toLowerCase().trim() === String(matchVal).toLowerCase().trim());
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...mappedRow };
      } else {
        list.push(mappedRow);
      }
    }

    await this._saveTable(table, list);
    return { success: true, affected: rowObjects.length };
  }

  async getNextId(sheetName, idCol) {
    const table = LocalStorageClient._resolveTable(sheetName);
    const list = await this._getTable(table);
    const mappedCol = LocalStorageClient._mapColumnForTable(idCol, table);
    let maxId = 0;
    for (const row of list) {
      const idVal = parseInt(row[mappedCol]);
      if (isFinite(idVal) && idVal > maxId) {
        maxId = idVal;
      }
    }
    return maxId + 1;
  }

  async getListingAuditFreshness(listingIds) {
    const table = 'listing_audit';
    const list = await this._getTable(table);
    const freshnessHours = 48;
    const cutoff = Date.now() - (freshnessHours * 60 * 60 * 1000);
    const out = {};
    for (const id of listingIds) {
      const audits = list.filter(row => String(row.listing_id) === String(id));
      if (audits.length > 0) {
        audits.sort((a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime());
        const audit = audits[0];
        const time = new Date(audit.created_at).getTime();
        const ageHours = isFinite(time) ? (Date.now() - time) / (1000 * 60 * 60) : 999;
        out[id] = {
          is_fresh: ageHours <= freshnessHours,
          last_audited_at: audit.created_at || '',
          age_hours: ageHours
        };
      }
    }
    return { freshnessHours, listings: out };
  }

  async createRun(seedKeyword, configSnapshot = null) {
    const table = 'user_runs';
    const list = await this._getTable(table);
    const runId = await this.getNextId('user_runs', 'run_id');
    const run = {
      run_id: runId,
      seed_keyword: seedKeyword,
      config_snapshot: configSnapshot,
      started_at: new Date().toISOString(),
      status: 'running'
    };
    list.push(run);
    await this._saveTable(table, list);
    return { run_id: runId };
  }

  async updateRun(runId, status, stepsCompleted = null) {
    const table = 'user_runs';
    const list = await this._getTable(table);
    const idx = list.findIndex(r => Number(r.run_id) === Number(runId));
    if (idx !== -1) {
      list[idx].status = status;
      if (stepsCompleted) list[idx].steps_completed = stepsCompleted;
      await this._saveTable(table, list);
    }
    return { success: true };
  }

  async logRun(taskName, status, itemsProcessed = 0, itemsSuccess = 0, itemsFailed = 0, errorMessage = '', notes = '') {
    const table = 'automation_log';
    const list = await this._getTable(table);
    const logId = await this.getNextId('automation_log', 'log_id');
    list.push({
      log_id: logId,
      task_name: taskName,
      status,
      items_processed: itemsProcessed,
      items_success: itemsSuccess,
      items_failed: itemsFailed,
      error_message: errorMessage,
      notes,
      created_at: new Date().toISOString()
    });
    await this._saveTable(table, list);
    return { success: true };
  }
}

// ─── content-script try/catch & local Gemini Triage Override ───────────
const originalSendMessage = chrome.tabs.sendMessage;
chrome.tabs.sendMessage = function(tabId, message, options, callback) {
  let cb = callback;
  let opt = options;
  if (typeof options === 'function') {
    cb = options;
    opt = {};
  }

  const wrappedCallback = (response) => {
    const lastError = chrome.runtime.lastError;
    if (lastError) {
      console.warn('[ERP Override] sendMessage error detected:', lastError.message);
      runGeminiTriage(lastError.message, new Error().stack, message);
    } else if (response && response.error) {
      console.warn('[ERP Override] sendMessage response error:', response.error);
      runGeminiTriage(response.error, response.stack || '', message);
    }
    if (cb) cb(response);
  };

  try {
    return originalSendMessage.call(chrome.tabs, tabId, message, opt, wrappedCallback);
  } catch (err) {
    console.error('[ERP Override] sendMessage exception:', err);
    runGeminiTriage(err.message, err.stack, message);
    throw err;
  }
};

async function runGeminiTriage(errorMessage, stack, message) {
  try {
    const config = await loadConfig();
    const apiKey = config.gemini_api_key;
    if (!apiKey) {
      console.warn('[ERP] Gemini key not configured for triage');
      await updateState({
        layoutFixNotification: `Scraper error: ${errorMessage}. (Configure Gemini API Key to get automated layout fixes)`
      });
      return;
    }

    const actionName = message && message.action ? message.action : 'unknown';
    const prompt = `You are a Principal Software Engineer and AI Diagnostics Assistant.
A Chrome Extension content script failed during an e-commerce scraping task.

Scraping Action: "${actionName}"
Error Message: "${errorMessage}"
Stack Trace:
${stack || 'No stack trace available'}

Provide a 1-sentence plain English layout fix notification explaining to the user/developer what went wrong with the webpage layout and how to fix it (e.g., "The class selector for the keyword table has changed, update it in erank-keyword-extractor.js").
Do NOT include any greetings, markdown formatting, or prefix text. Return ONLY the 1-sentence explanation.`;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 150
          }
        })
      }
    );

    if (response.ok) {
      const result = await response.json();
      const text = result.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || '';
      if (text) {
        await log('error', `🔧 Layout fix recommendation: ${text}`);
        await updateState({ layoutFixNotification: text });
        return;
      }
    }
    
    await updateState({
      layoutFixNotification: `Layout fix: Scraping action "${actionName}" failed due to a page layout shift. Check class selectors.`
    });
  } catch (e) {
    console.error('[ERP] runGeminiTriage failed:', e);
  }
}

// ─── Research Pipeline (Orchestrator Run) ──────────────────────────────────
export async function runFullPipeline(seedKeyword, options = {}) {
  pipelineRunning = true;
  stopRequested = false;

  let _archived = false;
  let pipelineRunId = null;
  const apiClient = new LocalStorageClient();
  const pipelineStartedAt = new Date().toISOString();

  // Load config ONCE at pipeline start (Permanent Priority 1 Resolution)
  const config = await loadConfig();
  // Ensure parameters are parsed as numbers and merged with trigger options
  config.min_qualified_keywords = parseInt(config.min_qualified_keywords) || 5;
  config.delay_between_pages = parseInt(config.delay_between_pages) || 3;
  Object.assign(config, options);

  console.log("[ERP] Pipeline starting with resolved configuration:", JSON.stringify(config));
  await log('info', "[ERP] Pipeline starting with resolved configuration: " + JSON.stringify(config));

  // MV3 Keepalive hook
  const KEEPALIVE_INTERVAL = setInterval(() => {
    try {
      chrome.runtime.sendMessage({ action: 'keepAlive' }).catch(() => {});
    } catch (e) {}
  }, 15000);

  const _archive = async (status) => {
    clearInterval(KEEPALIVE_INTERVAL);
    if (_archived) return;
    _archived = true;
    if (pipelineRunId) {
      try {
        const dbStatus = status === 'success' ? 'completed' : 'failed';
        await apiClient.updateRun(pipelineRunId, dbStatus);
      } catch (e) {
        console.warn('[ERP] updateRun failed:', e.message);
      }
    }
    await flushLogsToServer(seedKeyword, 'full_pipeline');
    return archiveCurrentRun({ seedKeyword, mode: 'full', status });
  };

  try {
    await log('info', `=== Starting Full Pipeline for: "${seedKeyword}" ===`);
    await updateState({
      steps: {
        find_keyword: 'pending',
        snapshot: 'pending',
        listing_audit: 'pending',
        final_report: 'pending'
      }
    });

    const tabId = await getOrCreateWorkTab();

    // Create run record
    try {
      const runRes = await apiClient.createRun(seedKeyword, config);
      pipelineRunId = runRes?.run_id ? Number(runRes.run_id) : null;
    } catch (e) {
      await log('warn', `createRun failed: ${e.message}`);
    }

    // Step 1: eRank Keyword Research
    if (stopRequested) {
      await log('warn', '🛑 Pipeline stopped before Step 1');
      await updateState({ running: false, lastStatus: 'stopped' });
      await _archive('stopped');
      return;
    }
    await setStepStatus('find_keyword', 'running');
    await updateState({ currentStep: `Step 1: eRank Keywords` });

    const loggedIn = await checkErankLogin(tabId);
    if (!loggedIn) {
      await setStepStatus('find_keyword', 'failed');
      await updateState({ running: false, lastStatus: 'error', progress: 'eRank not logged in' });
      await _archive('error');
      return;
    }

    const checkStop = () => stopRequested;

    const step1 = await runErankKeywordResearch(apiClient, tabId, config, (type, msg) => {
      log(type, `[Step 1] ${msg}`);
      updateState({ progress: msg });
    }, seedKeyword, checkStop);
    await setStepStatus('find_keyword', 'success');
    await log('success', `Step 1 done: ${step1.newKeywordsFound} new keywords`);

    // Pre-Step 2 Gate
    const step1Usable = (step1.newKeywordsFound || 0) + (step1.refreshedCount || 0);
    let availableForSeed = step1Usable;
    if (step1Usable < config.min_qualified_keywords) {
      availableForSeed = await countAvailableKeywordsForSeed(apiClient, seedKeyword, config);
    }

    if (availableForSeed < config.min_qualified_keywords) {
      await log('warn', `Surfaced only ${availableForSeed} keywords (minimum ${config.min_qualified_keywords}). Skipping Steps 2 & 3.`);
      await setStepStatus('snapshot', 'skipped');
      await setStepStatus('listing_audit', 'skipped');
      await setStepStatus('final_report', 'running');
      await updateState({ currentStep: `Step 4: Verdict & Report` });

      const step4 = await runNicheScoring(apiClient, config, (type, msg) => {
        log(type, `[Step 4] ${msg}`);
        updateState({ progress: msg });
      }, seedKeyword, {
        insufficientKeywords: true,
        availableCount: availableForSeed,
        minRequired: config.min_qualified_keywords,
        pipelineRunId,
        pipelineStartedAt,
        capturedKeywords: step1.qualifyingKeywords || []
      });
      await setStepStatus('final_report', 'success');

      await saveFinalResults(seedKeyword, step4, config);

      await updateState({
        running: false,
        currentStep: `Pipeline Complete: "${seedKeyword}" — NO-GO`,
        lastStatus: 'success',
        progress: `Keywords: ${availableForSeed}/${config.min_qualified_keywords} — insufficient`
      });
      await _archive('success');
      return;
    }

    // Step 2: Etsy Search Snapshots
    if (stopRequested) {
      await log('warn', '🛑 Pipeline stopped before Step 2');
      await updateState({ running: false, lastStatus: 'stopped' });
      await _archive('stopped');
      return;
    }
    await setStepStatus('snapshot', 'running');
    await updateState({ currentStep: `Step 2: Etsy Snapshots` });

    const step2 = await runEtsySearchSnapshots(apiClient, tabId, config, (type, msg) => {
      log(type, `[Step 2] ${msg}`);
      updateState({ progress: msg });
    }, seedKeyword, checkStop, { pipelineRunId });
    await setStepStatus('snapshot', 'success');

    // Step 3: Etsy Listing Audit (only if niche qualified)
    let step3 = { audited: 0 };
    if (step2.nicheQualified) {
      if (stopRequested) {
        await log('warn', '🛑 Pipeline stopped before Step 3');
        await updateState({ running: false, lastStatus: 'stopped' });
        await _archive('stopped');
        return;
      }
      await setStepStatus('listing_audit', 'running');
      await updateState({ currentStep: `Step 3: Listing Audit` });

      step3 = await runErankListingAudit(apiClient, tabId, config, (type, msg) => {
        log(type, `[Step 3] ${msg}`);
        updateState({ progress: msg });
      }, seedKeyword, checkStop);
      await setStepStatus('listing_audit', 'success');
    } else {
      await setStepStatus('listing_audit', 'skipped');
      await log('warn', `⏭️ Skipping Step 3 — niche did not qualify`);
    }

    // Step 4: Final Niche scoring & report
    if (stopRequested) {
      await log('warn', '🛑 Pipeline stopped before Step 4');
      await updateState({ running: false, lastStatus: 'stopped' });
      await _archive('stopped');
      return;
    }
    await setStepStatus('final_report', 'running');
    await updateState({ currentStep: `Step 4: Verdict & Report` });

    const step4 = await runNicheScoring(apiClient, config, (type, msg) => {
      log(type, `[Step 4] ${msg}`);
      updateState({ progress: msg });
    }, seedKeyword, { pipelineRunId, pipelineStartedAt });
    await setStepStatus('final_report', 'success');

    await saveFinalResults(seedKeyword, step4, config);

    const verdict = step2.nicheQualified ? 'GO' : 'NO-GO';
    await updateState({
      running: false,
      currentStep: `Pipeline Complete: "${seedKeyword}" — ${verdict}`,
      lastStatus: 'success',
      progress: `Keywords: ${availableForSeed}, Listings: ${step2.listingsFound}, Verdict: ${verdict}`
    });
    await _archive('success');

  } catch (err) {
    await log('error', `Pipeline error: ${err.message}`);
    await sendTelemetryError(`Pipeline error: ${err.message}`, err.stack, `runFullPipeline:${seedKeyword}`);
    const state = await loadRunState();
    const steps = state.steps || {};
    for (const [k, v] of Object.entries(steps)) {
      if (v === 'running') steps[k] = 'failed';
    }
    await updateState({ running: false, lastStatus: 'error', progress: err.message, steps });
    await _archive('error');
  } finally {
    clearInterval(KEEPALIVE_INTERVAL);
    pipelineRunning = false;
    if (workTabId) {
      try { chrome.tabs.remove(workTabId); } catch(e) {}
      workTabId = null;
    }
  }
}

// ─── Single step standalone run ───────────────────────────────────────
export async function runSingleStep(stepNum, seedKeyword, options = {}) {
  pipelineRunning = true;
  stopRequested = false;

  const stepNames = { 1: 'eRank Keywords', 2: 'Etsy Snapshots', 3: 'Listing Audit', 4: 'Verdict & Report' };
  let _archived = false;
  let standaloneRunId = null;
  const apiClient = new LocalStorageClient();

  // Load config ONCE at step start (Permanent Priority 1 Resolution)
  const config = await loadConfig();
  config.min_qualified_keywords = parseInt(config.min_qualified_keywords) || 5;
  config.delay_between_pages = parseInt(config.delay_between_pages) || 3;
  Object.assign(config, options);

  console.log("[ERP] Pipeline step starting with resolved configuration:", JSON.stringify(config));
  await log('info', "[ERP] Pipeline step starting with resolved configuration: " + JSON.stringify(config));

  const KEEPALIVE_INTERVAL = setInterval(() => {
    try {
      chrome.runtime.sendMessage({ action: 'keepAlive' }).catch(() => {});
    } catch (e) {}
  }, 15000);

  const _archive = async (status) => {
    clearInterval(KEEPALIVE_INTERVAL);
    if (_archived) return;
    _archived = true;
    if (standaloneRunId) {
      try {
        const dbStatus = status === 'success' ? 'completed' : 'failed';
        await apiClient.updateRun(standaloneRunId, dbStatus);
      } catch (e) {
        console.warn('[ERP] standalone updateRun failed:', e.message);
      }
    }
    await flushLogsToServer(seedKeyword, `step${stepNum}`);
    return archiveCurrentRun({ seedKeyword, mode: 'step', step: stepNum, status });
  };

  try {
    await log('info', `=== Running Step ${stepNum}: ${stepNames[stepNum]} for "${seedKeyword}" ===`);
    const logFn = (type, msg) => {
      log(type, `[Step ${stepNum}] ${msg}`);
      updateState({ progress: msg });
    };

    const checkStop = () => stopRequested;
    let result;

    if (stepNum <= 3) {
      const tabId = await getOrCreateWorkTab();
      if (stepNum === 1) {
        const loggedIn = await checkErankLogin(tabId);
        if (!loggedIn) {
          await updateState({ running: false, lastStatus: 'error', progress: 'eRank not logged in' });
          await _archive('error');
          return;
        }
        result = await runErankKeywordResearch(apiClient, tabId, config, logFn, seedKeyword, checkStop);
      }
      else if (stepNum === 2) {
        try {
          const runRes = await apiClient.createRun(seedKeyword, config);
          standaloneRunId = runRes?.run_id ? Number(runRes.run_id) : null;
        } catch (e) {}
        result = await runEtsySearchSnapshots(apiClient, tabId, config, logFn, seedKeyword, checkStop, { pipelineRunId: standaloneRunId });
      }
      else if (stepNum === 3) {
        result = await runErankListingAudit(apiClient, tabId, config, logFn, seedKeyword, checkStop);
      }
    } else {
      const { rows: runs } = await apiClient.readSheet('user_runs');
      if (runs && runs.length > 0) {
        runs.sort((a, b) => (b.started_at || '').localeCompare(a.started_at || ''));
        standaloneRunId = runs[0].run_id;
      }
      result = await runNicheScoring(apiClient, config, logFn, seedKeyword, { pipelineRunId: standaloneRunId });
      await saveFinalResults(seedKeyword, result, config);
    }

    await updateState({ running: false, lastStatus: 'success', progress: JSON.stringify(result) });
    await _archive('success');

  } catch (err) {
    await log('error', `Step ${stepNum} failed: ${err.message}`);
    await sendTelemetryError(`Step ${stepNum} failed: ${err.message}`, err.stack, `runSingleStep:${stepNum}:${seedKeyword}`);
    await updateState({ running: false, lastStatus: 'error', progress: err.message });
    await _archive('error');
  } finally {
    clearInterval(KEEPALIVE_INTERVAL);
    pipelineRunning = false;
    if (workTabId) {
      try { chrome.tabs.remove(workTabId); } catch(e) {}
      workTabId = null;
    }
  }
}

// ─── Scraper Core integration / helper functions ──────────────────────
async function saveFinalResults(seedKeyword, step4Result, config) {
  const apiClient = new LocalStorageClient();
  
  const { rows: seeds } = await apiClient.readSheet('seed_keywords');
  const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
  if (!seed) return;
  const seedId = String(seed.seed_id);

  const { rows: keywords } = await apiClient.readSheet('etsy_keywords', { seed_id: seedId });
  const { rows: listings } = await apiClient.readSheet('etsy_listings', { seed_id: seedId });
  const { rows: audits } = await apiClient.readSheet('listing_audit');
  const { rows: stores } = await apiClient.readSheet('etsy_stores');

  const auditsMap = new Map();
  for (const a of audits) {
    auditsMap.set(String(a.listing_id), a);
  }

  const shopLookup = {};
  for (const s of stores) {
    const name = (s.shop_name || '').toLowerCase();
    if (name) shopLookup[name] = s;
  }

  const scoredListings = listings.map(l => {
    const audit = auditsMap.get(String(l.listing_id));
    const price = parseFloat(l.price) || 0;
    const shopReviews = (l.shop_reviews != null) ? parseInt(l.shop_reviews) : (l.review_count != null ? parseInt(l.review_count) : null);
    const inCarts = audit ? parseInt(audit.in_carts || 0) : 0;
    const sold24h = audit ? parseInt(audit.sold_24h || 0) : 0;
    
    let score = 50; 
    if (shopReviews !== null && !isNaN(shopReviews) && shopReviews < (config.max_shop_reviews_beatable || 300)) score += 20;
    if (inCarts > 10) score += 15;
    if (sold24h > 0) score += 15;
    if (l.is_bestseller) score += 10;
    score = Math.min(100, Math.max(0, score));

    return {
      ...l,
      shop_reviews: shopReviews,
      price: price,
      scores: {
        win_score: score,
        verdict: score >= 70 ? 'WIN' : score >= 50 ? 'GOOD' : score >= 30 ? 'AVERAGE' : 'SKIP'
      }
    };
  });

  const maxReviewsThreshold = config.max_shop_reviews_beatable !== undefined ? config.max_shop_reviews_beatable : 300;
  const beatableSlots = scoredListings.slice(0, 10).filter(l => l.shop_reviews !== null && !isNaN(l.shop_reviews) && l.shop_reviews < maxReviewsThreshold).length;
  const wins = scoredListings.filter(l => l.scores.verdict === 'WIN');
  const avgScore = scoredListings.length > 0
    ? Math.round(scoredListings.reduce((sum, l) => sum + l.scores.win_score, 0) / scoredListings.length)
    : 0;
  
  let medianPrice = 0;
  if (scoredListings.length > 0) {
    const prices = scoredListings.map(l => parseFloat(l.price) || 0).sort((a, b) => a - b);
    const mid = Math.floor(prices.length / 2);
    medianPrice = prices.length % 2 !== 0 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2;
    medianPrice = Math.round(medianPrice * 100) / 100;
  }
  const validReviews = scoredListings.filter(l => l.shop_reviews !== null && !isNaN(l.shop_reviews)).map(l => l.shop_reviews);
  const avgReviews = validReviews.length > 0
    ? Math.round(validReviews.reduce((sum, val) => sum + val, 0) / validReviews.length)
    : 0;

  const keywordsForClustering = keywords.map(k => {
    const kwListings = scoredListings.filter(l => String(l.keyword_id) === String(k.keyword_id));
    const tags = [];
    for (const l of kwListings) {
      const audit = auditsMap.get(String(l.listing_id));
      if (audit && audit.tags_list) {
        try {
          const parsed = JSON.parse(audit.tags_list);
          if (Array.isArray(parsed)) tags.push(...parsed);
        } catch(e) {}
      }
    }
    return {
      keyword_id: String(k.keyword_id),
      keyword: k.keyword,
      searches: parseInt(k.avg_searches) || 0,
      tags: [...new Set(tags)]
    };
  });

  let clusters = [];
  try {
    const clusteredConcepts = clusterKeywordsIntoConcepts(keywordsForClustering, {
      cluster_min_shared_tokens: 2,
      cluster_jaccard_threshold: 0.5,
      cluster_use_tag_graph: 1,
      cluster_max_size: 8,
      cluster_stopword_langs: 'en,es'
    });

    clusters = clusteredConcepts.map(c => {
      const conceptKeywordIds = new Set(c.keyword_ids.map(String));
      const conceptListings = scoredListings.filter(l => conceptKeywordIds.has(String(l.keyword_id)));
      const cAvgScore = conceptListings.length > 0
        ? Math.round(conceptListings.reduce((sum, l) => sum + l.scores.win_score, 0) / conceptListings.length)
        : avgScore;

      const verdict = cAvgScore >= 70 ? 'WIN' : cAvgScore >= 50 ? 'GOOD' : cAvgScore >= 30 ? 'AVERAGE' : 'SKIP';
      const conceptKeywords = keywords.filter(k => conceptKeywordIds.has(String(k.keyword_id)));
      const keywordsToTarget = conceptKeywords.map(k => k.keyword);

      return {
        niche: c.concept_label,
        product_type: config.product_type_filter || 'any',
        listings: conceptListings.map(l => l.listing_id),
        demand_score: Math.min(100, Math.max(10, Math.round(c.total_searches / 100))),
        competition_score: Math.min(100, Math.max(10, Math.round(conceptKeywords.reduce((sum, k) => sum + (parseInt(k.competition) || 0), 0) / conceptKeywords.length / 500))),
        win_score: cAvgScore,
        opportunity: `Low-competition segment for ${c.concept_label} products with high demand opportunity.`,
        target_buyer: `Etsy shoppers searching for custom ${c.concept_label} items.`,
        price_recommendation: `$${Math.max(5, Math.round(medianPrice - 5))}-${Math.round(medianPrice + 5)}`,
        image_prompt: `Commercial product display of ${c.concept_label}, clean aesthetic background, studio lighting --ar 4:3`,
        verdict: `${verdict} — Strong opportunities in ${c.concept_label}`,
        keywords_to_target: keywordsToTarget
      };
    });
  } catch (clusterErr) {
    console.error('[ERP] Concept clustering failed:', clusterErr);
  }

  const stats = {
    total: scoredListings.length,
    wins: wins.length,
    avg_win_score: avgScore,
    avg_price: medianPrice,
    beatable_slots: beatableSlots,
    avg_reviews: avgReviews,
    ai_mode: config.ai_provider || 'none',
    source: keywords.some(k => k.source === 'erank') ? 'etsy+erank' : 'etsy_only'
  };

  await saveRun({
    seed_id: seedId,
    keyword: seedKeyword,
    product_type: config.product_type_filter || 'any',
    source: stats.source,
    ai_mode: stats.ai_mode,
    total: stats.total,
    wins: stats.wins,
    avg_win_score: stats.avg_win_score,
    avg_price: stats.avg_price,
    beatable_slots: stats.beatable_slots,
    top_niches: clusters.map(c => ({
      name: c.niche,
      win_score: c.win_score,
      verdict: c.verdict
    })),
    listings_summary: scoredListings.slice(0, 10).map(l => ({
      title: l.title,
      price: l.price,
      win_score: l.scores?.win_score || 0,
      verdict: l.scores?.verdict || ''
    }))
  });

  const lastResearchResults = {
    seed_id: seedId,
    keyword: seedKeyword,
    product_type: config.product_type_filter || 'any',
    stats,
    clusters,
    listings: scoredListings,
    completed_at: new Date().toISOString()
  };
  await chrome.storage.local.set({ lastResearchResults });

  if (config.webhook_url) {
    await triggerWebhook(config.webhook_url, lastResearchResults, log);
  }

  if (config.community_sharing && config.share_telemetry) {
    try {
      await fetch(`${config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev'}/save-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyword: seedKeyword,
          product_type: config.product_type_filter || 'any',
          win_score: stats.avg_win_score,
          total: stats.total,
          wins: stats.wins,
          beatable: stats.beatable_slots,
          avg_price: stats.avg_price,
          average_reviews: stats.avg_reviews,
          avg_reviews: stats.avg_reviews,
          ai_mode: stats.ai_mode,
          clusters: clusters.map(c => ({
            niche: c.niche,
            demand_score: c.demand_score,
            competition_score: c.competition_score,
            win_score: c.win_score,
            image_prompt: c.image_prompt
          }))
        })
      });
      await log('info', 'Anonymous run details shared with community.');
    } catch(e) {
      console.warn('[ERP] Failed to sync run to D1 worker:', e.message);
      await sendTelemetryError(`Failed to sync run to D1 worker: ${e.message}`, e.stack, `${config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev'}/save-run`);
    }
  }
}

export async function checkErankLogin(tabId) {
  await log('info', 'Checking eRank login...');
  await navigateTab(tabId, 'https://members.erank.com/keyword-tool');
  await sleep(5000);

  // URL-level pre-check: eRank redirects unauthenticated users away from
  // /keyword-tool (to /login or /). If the tab URL still contains
  // members.erank.com/keyword-tool, the session is valid.
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url && tab.url.includes('members.erank.com/keyword-tool')) {
      await log('success', 'eRank is logged in (URL confirmed on members.erank.com/keyword-tool)');
      return true;
    }
  } catch (urlErr) {
    // Non-fatal — fall through to content-script check
  }

  try {
    const response = await sendToTab(tabId, { action: 'checkErankLogin' });
    if (response && response.loggedIn) {
      await log('success', 'eRank is logged in');
      return true;
    } else {
      await log('error', 'eRank is NOT logged in — please log in and retry');
      return false;
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    if (/receiving end does not exist|could not establish connection/i.test(msg)) {
      // Content script not loaded — check URL as last resort
      try {
        const tab = await chrome.tabs.get(tabId);
        if (tab && tab.url && tab.url.includes('members.erank.com')) {
          await log('success', 'eRank is logged in (URL fallback — content script unavailable)');
          return true;
        }
      } catch (_) {}
      await log('error', 'eRank is NOT logged in — please log in and retry');
      return false;
    }
    await log('error', `Could not check eRank login: ${msg}`);
    return false;
  }
}

async function countAvailableKeywordsForSeed(apiClient, seedKeyword, config) {
  try {
    const { rows: seeds } = await apiClient.readSheet('seed_keywords');
    const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!seed) return 0;
    const seedId = String(seed.seed_id);

    const { rows: keywords } = await apiClient.readSheet('etsy_keywords', { seed_id: seedId });
    let count = 0;
    for (const k of keywords) {
      if (String(k.seed_id) !== seedId) continue;
      const status = (k.status || '').toLowerCase();
      if (status && status !== 'pending' && status !== 'validated'
          && status !== 'qualified' && status !== 'unqualified') continue;
      const kwText = (k.keyword || '').trim();
      if (!kwText || isJunkKeywordGate(kwText)) continue;
      count++;
    }
    return count;
  } catch (e) {
    console.warn('[ERP] countAvailableKeywordsForSeed failed:', e.message);
    return Number.POSITIVE_INFINITY;
  }
}

function isJunkKeywordGate(text) {
  if (!text) return true;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower.length < 4) return true;
  if (/^\d+$/.test(lower)) return true;
  if (/^[\/\\]/.test(trimmed)) return true;
  const stripped = trimmed.replace(/^[\/\\\s]+/, '').trim();
  if (/^\d+$/.test(stripped)) return true;
  if (/^\d+\s/.test(trimmed)) return true;
  const words = lower.split(/\s+/).filter(Boolean);
  if (words.length <= 2 && words.some(w => w.length === 1 && w !== 'i' && w !== 'a')) return true;
  if (words.length >= 2 && words.every(w => w.length <= 2)) return true;
  const uiJunk = [
    'copy tags', 'copy tag', 'copy to clipboard', 'copy all',
    'search trends', 'search trend', 'search trending',
    'show filters', 'hide filters', 'clear filters',
    'categories', 'sort by', 'filter by',
    'bestseller', 'top seller', 'new seller',
    'menu', 'dashboard', 'settings', 'account',
    'log in', 'log out', 'sign in', 'sign out', 'sign up',
    'home favourites', 'home favorites', 'top gifts', 'trending now',
    'star seller', 'free shipping',
  ];
  if (uiJunk.includes(lower)) return true;
  const navOnly = new Set([
    'categories', 'shop', 'sell', 'cart', 'wishlist', 'help', 'about',
    'blog', 'faq', 'terms', 'privacy', 'policy', 'contact', 'support',
    'trending', 'popular', 'featured', 'explore', 'discover'
  ]);
  if (navOnly.has(lower)) return true;
  const junkPatterns = [
    'keyword stuffing', 'possible typo', 'repeated word', 'repeated words',
    'repeated tag', 'repeated tags', 'misspelling', 'misspelled',
    'duplicate tag', 'duplicate tags', 'too long', 'too short',
    'single word', 'not relevant', 'low quality', 'quality issue',
    'character limit', 'special character'
  ];
  for (const pat of junkPatterns) { if (lower.includes(pat)) return true; }
  return false;
}

async function archiveCurrentRun(extra = {}) {
  try {
    const state = await loadRunState();
    if (!state || !state.logs || state.logs.length === 0) return;
    let configSnapshot = null;
    try {
      const cfgData = await chrome.storage.local.get('config');
      configSnapshot = cfgData.config || null;
    } catch {}
    const entry = {
      archived_at: new Date().toISOString(),
      seed_keyword: extra.seedKeyword || null,
      mode: extra.mode || null,
      step: extra.step || null,
      status: state.lastStatus || extra.status || null,
      current_step: state.currentStep || null,
      progress: state.progress || null,
      configSnapshot,
      logs: state.logs.slice(),
    };
    const data = await chrome.storage.local.get('runHistory');
    const history = Array.isArray(data.runHistory) ? data.runHistory : [];
    history.unshift(entry);
    if (history.length > 10) history.length = 10;
    await chrome.storage.local.set({ runHistory: history });
  } catch (e) {
    console.error('[ERP] archiveCurrentRun failed:', e);
  }
}

// ─── Tab management ──────────────────────────────────────────────────
export async function getOrCreateWorkTab() {
  if (workTabId) {
    try {
      const tab = await chrome.tabs.get(workTabId);
      if (tab) return workTabId;
    } catch (e) {
      workTabId = null;
    }
  }
  return new Promise((resolve) => {
    chrome.tabs.create({ url: 'about:blank', active: false }, (tab) => {
      workTabId = tab.id;
      resolve(workTabId);
    });
  });
}

export function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url }, () => {
      if (chrome.runtime.lastError) {
        workTabId = null;
        return reject(new Error('Tab no longer exists: ' + chrome.runtime.lastError.message));
      }
      const listener = (tId, changeInfo) => {
        if (tId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
    });
  });
}

export function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response || {});
    });
  });
}

export async function scrapeListingUrl(url) {
  const config = await loadConfig();
  const delayMs = (config.delay_between_pages !== undefined ? config.delay_between_pages : 5) * 1000;
  const tabId = await getOrCreateWorkTab();
  await navigateTab(tabId, url);
  await sleep(delayMs);

  try {
    const response = await sendToTab(tabId, { action: 'extractEtsyListingDetail' });
    if (response && response.listing_rating !== undefined) {
      return response;
    }
    throw new Error(response?.error || 'Failed to extract listing detail');
  } finally {
    try { chrome.tabs.remove(tabId); } catch (e) {}
    if (workTabId === tabId) workTabId = null;
  }
}

export async function checkErankForKeyword(keyword) {
  const tabs = await chrome.tabs.query({ url: 'https://members.erank.com/*' });
  if (tabs.length === 0) {
    return { success: false, error: 'No eRank tab open' };
  }
  try {
    const response = await sendToTab(tabs[0].id, { action: 'extractKeywordData' });
    return response;
  } catch (e) {
    return { success: false, error: e.message };
  }
}
