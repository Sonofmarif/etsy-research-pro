// History Manager — 90-day research history with chrome.storage.local
// Stores up to 500 runs with automatic cleanup

const MAX_RUNS = 500;
const RETENTION_DAYS = 90;
const STORAGE_KEY = 'researchHistory';

// ─── Save a research run ──────────────────────────────────────────────────
export async function saveRun(runData) {
  const run = {
    run_id: generateRunId(),
    seed_id: runData.seed_id || '',
    keyword: runData.keyword || '',
    date: new Date().toISOString(),
    product_type: runData.product_type || 'any',
    source: runData.source || 'etsy_only',
    ai_mode: runData.ai_mode || 'none',
    stats: {
      total: runData.total || 0,
      wins: runData.wins || 0,
      avg_win_score: runData.avg_win_score || 0,
      avg_price: runData.avg_price || 0,
      beatable_slots: runData.beatable_slots || 0
    },
    top_niches: (runData.top_niches || []).slice(0, 5),
    listings_summary: (runData.listings_summary || []).slice(0, 10)
  };

  const history = await loadAllRuns();
  history.unshift(run); // newest first

  // Enforce max runs
  if (history.length > MAX_RUNS) {
    history.length = MAX_RUNS;
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: history });
  return run;
}

// ─── Load all runs ────────────────────────────────────────────────────────
export async function loadAllRuns() {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const history = result[STORAGE_KEY] || [];

  // Clean up old entries beyond retention period
  const cutoff = Date.now() - (RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const filtered = history.filter(run => {
    const runDate = new Date(run.date).getTime();
    return runDate > cutoff;
  });

  // Save cleaned data if any were removed
  if (filtered.length < history.length) {
    await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
  }

  return filtered;
}

// ─── Search history ───────────────────────────────────────────────────────
export async function searchRuns(query) {
  const history = await loadAllRuns();
  const lower = query.toLowerCase();
  return history.filter(run =>
    run.keyword.toLowerCase().includes(lower) ||
    (run.top_niches || []).some(n => n.name.toLowerCase().includes(lower))
  );
}

// ─── Filter by criteria ──────────────────────────────────────────────────
export async function filterRuns({ dateFrom, dateTo, productType, minScore } = {}) {
  let history = await loadAllRuns();

  if (dateFrom) {
    const from = new Date(dateFrom).getTime();
    history = history.filter(r => new Date(r.date).getTime() >= from);
  }

  if (dateTo) {
    const to = new Date(dateTo).getTime() + 86400000; // include end day
    history = history.filter(r => new Date(r.date).getTime() <= to);
  }

  if (productType && productType !== 'all') {
    history = history.filter(r => r.product_type === productType);
  }

  if (minScore && minScore > 0) {
    history = history.filter(r => r.stats.avg_win_score >= minScore);
  }

  return history;
}

// ─── Get recent runs (for popup History tab) ──────────────────────────────
export async function getRecentRuns(limit = 20) {
  const history = await loadAllRuns();
  return history.slice(0, limit);
}

// ─── Get history for a specific keyword ───────────────────────────────────
export async function getKeywordHistory(keyword) {
  const history = await loadAllRuns();
  return history.filter(r => r.keyword.toLowerCase() === keyword.toLowerCase());
}

// ─── Get trend data (score change over time) ──────────────────────────────
export async function getKeywordTrend(keyword) {
  const runs = await getKeywordHistory(keyword);
  if (runs.length < 2) return null;

  // Sort oldest first
  const sorted = [...runs].sort((a, b) => new Date(a.date) - new Date(b.date));

  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  const scoreDiff = newest.stats.avg_win_score - oldest.stats.avg_win_score;
  const daysDiff = Math.round((new Date(newest.date) - new Date(oldest.date)) / 86400000);

  return {
    keyword,
    oldest_score: oldest.stats.avg_win_score,
    newest_score: newest.stats.avg_win_score,
    score_change: scoreDiff,
    direction: scoreDiff > 5 ? 'up' : scoreDiff < -5 ? 'down' : 'stable',
    days_tracked: daysDiff,
    total_runs: sorted.length,
    history: sorted.map(r => ({
      date: r.date,
      score: r.stats.avg_win_score,
      wins: r.stats.wins,
      total: r.stats.total
    }))
  };
}

// ─── Get stats summary ────────────────────────────────────────────────────
export async function getHistoryStats() {
  const history = await loadAllRuns();

  if (history.length === 0) {
    return { totalRuns: 0, totalNiches: 0, avgScore: 0, topKeywords: [], recentActivity: [] };
  }

  // Unique keywords
  const keywordCounts = {};
  let totalScore = 0;
  let totalNiches = 0;

  history.forEach(run => {
    keywordCounts[run.keyword] = (keywordCounts[run.keyword] || 0) + 1;
    totalScore += run.stats.avg_win_score || 0;
    totalNiches += (run.top_niches || []).length;
  });

  // Top 10 most researched keywords
  const topKeywords = Object.entries(keywordCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([keyword, count]) => ({ keyword, count }));

  // Last 7 days activity
  const weekAgo = Date.now() - 7 * 86400000;
  const recentActivity = history.filter(r => new Date(r.date).getTime() > weekAgo);

  return {
    totalRuns: history.length,
    totalNiches,
    avgScore: Math.round(totalScore / history.length),
    topKeywords,
    recentActivity: recentActivity.length
  };
}

// ─── Delete a specific run ────────────────────────────────────────────────
export async function deleteRun(runId) {
  const history = await loadAllRuns();
  const filtered = history.filter(r => r.run_id !== runId);
  await chrome.storage.local.set({ [STORAGE_KEY]: filtered });
}

// ─── Clear all history ────────────────────────────────────────────────────
export async function clearHistory() {
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
}

// ─── Export all history as object ─────────────────────────────────────────
export async function exportHistory() {
  const history = await loadAllRuns();
  const stats = await getHistoryStats();
  return {
    exported_at: new Date().toISOString(),
    total_runs: history.length,
    stats,
    runs: history
  };
}

// ─── Generate unique run ID ──────────────────────────────────────────────
function generateRunId() {
  return 'run_' + Date.now().toString(36) + '_' + Math.random().toString(36).substring(2, 8);
}
