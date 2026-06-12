// Dashboard Controller — Full-tab premium dashboard
// Custom Canvas charts (CSP compliant — no external CDN)
// Animated counters, glassmorphism, and sortable data table

(function () {
  'use strict';

  const $ = id => document.getElementById(id);

  let allRuns = [];
  let filteredRuns = [];
  let sortField = 'date';
  let sortDir = 'desc';
  let currentPage = 1;
  const ROWS_PER_PAGE = 25;
  let searchQuery = '';

  // Added state variables
  let lastResults = null;
  let lastAudit = null;
  let pollTimer = null;
  let logEntries = [];

  // Color palette
  const COLORS = {
    win: '#4ade80',
    good: '#F1641E',
    average: '#fbbf24',
    skip: '#f87171',
    accent: '#F1641E',
    accentLight: '#ff8a4c',
    text: '#eaeaf4',
    textMuted: '#5a5a86',
    textSecondary: '#9494c0',
    border: 'rgba(50, 50, 100, 0.35)',
    grid: 'rgba(50, 50, 100, 0.2)',
    bgCard: 'rgba(18, 18, 42, 0.65)',
  };

  // ─── Init ───────────────────────────────────────────────────────────────
  async function init() {
    await loadStats();
    await loadAllHistory();

    // Event listeners
    $('btn-apply-filter').addEventListener('click', applyFilters);
    $('btn-export-all').addEventListener('click', exportAll);
    $('btn-clear-all').addEventListener('click', clearAll);
    $('btn-prev-page').addEventListener('click', () => changePage(-1));
    $('btn-next-page').addEventListener('click', () => changePage(1));

    // Initialize SaaS workspace features
    initInterestSelector();
    initAiSeedsHandler();
    initSearchHandlers();
    initAuditHandlers();
    initLogHandlers();
    initExportHandlers();

    // Table search
    $('table-search-input').addEventListener('input', (e) => {
      searchQuery = e.target.value.toLowerCase().trim();
      currentPage = 1;
      applySearchFilter();
    });

    // Sortable headers
    document.querySelectorAll('th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const field = th.getAttribute('data-sort');
        // Remove active from all
        document.querySelectorAll('th.sortable').forEach(t => t.classList.remove('active'));
        if (sortField === field) sortDir = sortDir === 'asc' ? 'desc' : 'asc';
        else { sortField = field; sortDir = 'desc'; }
        th.classList.add('active');
        renderTable();
      });
    });

    // Load active state if any
    await loadState();

    // Start polling state and tools
    startPolling();

    // Check backend health
    checkBackendHealth();
    setInterval(checkBackendHealth, 15000); // 15s health check
  }

  // ─── Health Checks ──────────────────────────────────────────────────────
  async function checkBackendHealth() {
    try {
      const result = await chrome.storage.local.get('config');
      const config = result.config || {};
      const workerUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
      
      const response = await fetch(`${workerUrl}/health`);
      if (response.ok) {
        const data = await response.json();
        if (data.status === 'ok') {
          updateBadgeStatus('status-kv', 'KV Cache: On', 'green');
          updateBadgeStatus('status-db', 'D1 DB: On', 'green');
          return;
        }
      }
    } catch (e) {
      console.warn('[ERP] Backend health check failed:', e.message);
    }
    updateBadgeStatus('status-kv', 'KV Cache: Off', 'red');
    updateBadgeStatus('status-db', 'D1 DB: Off', 'red');
  }

  function updateBadgeStatus(id, text, state) {
    const el = $(id);
    if (!el) return;
    el.textContent = text;
    if (state === 'green') {
      el.className = 'status-badge green';
    } else {
      el.className = 'status-badge red';
    }
  }

  function updateStatus(state, stepText) {
    console.log(`[ERP] Pipeline state: ${state} - ${stepText}`);
  }

  // ─── Interest Category → Seed Keywords ──────────────────────────────────
  function initInterestSelector() {
    const interestSelect = $('interest-select');
    if (!interestSelect) return;

    interestSelect.addEventListener('change', () => {
      const category = interestSelect.value;
      if (!category) {
        $('chips-section').style.display = 'none';
        $('btn-ai-seeds').style.display = 'none';
        return;
      }

      chrome.runtime.sendMessage({ action: 'getSeedKeywords', category }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[ERP] Error fetching seed keywords:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.keywords && response.keywords.length > 0) {
          renderChips(response.keywords);
          $('chips-section').style.display = 'block';
        }
      });

      // Show AI seeds button if user has an API key configured
      chrome.storage.local.get('config', (result) => {
        const config = result.config || {};
        if (config && (config.gemini_api_key || config.groq_api_key)) {
          $('btn-ai-seeds').style.display = 'block';
        } else {
          $('btn-ai-seeds').style.display = 'none';
        }
      });
    });
  }

  // ─── AI Seed Keywords Handler ───────────────────────────────────────────
  function initAiSeedsHandler() {
    const btnAiSeeds = $('btn-ai-seeds');
    if (!btnAiSeeds) return;

    btnAiSeeds.addEventListener('click', () => {
      const category = $('interest-select').value;
      if (!category) return;

      btnAiSeeds.disabled = true;
      const originalText = btnAiSeeds.innerHTML;
      btnAiSeeds.innerHTML = '⏳ Generating...';
      addLog('info', `Requesting AI seed keywords for: "${category}"`);

      chrome.runtime.sendMessage({ action: 'generateAiSeeds', interest: category }, (response) => {
        btnAiSeeds.disabled = false;
        btnAiSeeds.innerHTML = originalText;

        if (chrome.runtime.lastError) {
          addLog('error', `AI keyword generation failed: ${chrome.runtime.lastError.message}`);
          return;
        }

        if (response && response.data && response.data.keywords) {
          renderChips(response.data.keywords);
          addLog('success', `Generated ${response.data.keywords.length} AI keywords for: "${category}"`);
        } else {
          const errorMsg = response?.error || 'No keywords returned';
          addLog('error', `AI keyword generation failed: ${errorMsg}`);
        }
      });
    });
  }

  function renderChips(keywords) {
    const container = $('keyword-chips');
    if (!container) return;
    container.innerHTML = '';
    keywords.forEach(kw => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = kw;
      chip.addEventListener('click', () => {
        $('search-input').value = kw;
        $('search-input').focus();
      });
      container.appendChild(chip);
    });
  }

  // ─── Research Flow ──────────────────────────────────────────────────────
  function initSearchHandlers() {
    $('btn-research').addEventListener('click', startResearch);
    $('btn-stop').addEventListener('click', stopResearch);

    $('search-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startResearch();
    });
  }

  function startResearch() {
    const keyword = $('search-input').value.trim();
    if (!keyword) {
      $('search-error').textContent = 'Enter a keyword to search';
      $('search-error').style.display = 'block';
      return;
    }
    $('search-error').style.display = 'none';

    const productType = $('product-type-select').value;

    $('btn-research').disabled = true;
    $('btn-stop').disabled = false;
    $('status-section').style.display = 'block';
    $('snapshot-empty').style.display = 'none';
    $('results-section').style.display = 'none';
    $('snapshot-skeleton').style.display = 'block';

    updateStatus('running', 'Starting research...');
    addLog('info', `Starting research for: "${keyword}"`);

    chrome.runtime.sendMessage({
      action: 'startResearch',
      keyword,
      productType
    }, (response) => {
      if (chrome.runtime.lastError) {
        addLog('error', `Failed to start: ${chrome.runtime.lastError.message}`);
        $('btn-research').disabled = false;
        $('btn-stop').disabled = true;
        $('snapshot-skeleton').style.display = 'none';
        $('snapshot-empty').style.display = 'block';
        updateStatus('error', 'Failed to start');
        return;
      }
      if (response && response.started) {
        addLog('info', 'Pipeline started');
      } else {
        addLog('error', `Failed to start: ${response?.reason || 'Unknown'}`);
        $('btn-research').disabled = false;
        $('btn-stop').disabled = true;
        $('snapshot-skeleton').style.display = 'none';
        $('snapshot-empty').style.display = 'block';
        updateStatus('error', 'Failed to start');
      }
    });
  }

  function stopResearch() {
    chrome.runtime.sendMessage({ action: 'stopResearch' }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[ERP] stopResearch error:', chrome.runtime.lastError.message);
      }
      $('btn-research').disabled = false;
      $('btn-stop').disabled = true;
      $('snapshot-skeleton').style.display = 'none';
      $('snapshot-empty').style.display = 'block';
      updateStatus('idle', 'Stopped');
      addLog('warn', 'Research stopped by user');
    });
  }

  // ─── State Polling ──────────────────────────────────────────────────────
  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(pollState, 1000);
  }

  function pollState() {
    chrome.runtime.sendMessage({ action: 'getState' }, async (state) => {
      if (chrome.runtime.lastError) {
        return;
      }
      if (!state) return;

      if (state.running) {
        $('btn-research').disabled = true;
        $('btn-stop').disabled = false;
        $('status-section').style.display = 'block';
        $('current-step').textContent = state.currentStep || 'Working...';
        $('current-progress').textContent = state.progress || '';
        updateStatus('running', state.currentStep || 'Running...');

        // Show skeleton
        $('snapshot-empty').style.display = 'none';
        $('results-section').style.display = 'none';
        $('snapshot-skeleton').style.display = 'block';

        // Animate progress bar
        const steps = ['Searching Etsy', 'Scraping listings', 'Scoring listings', 'AI Analysis', 'Saving results'];
        const currentIdx = steps.findIndex(s => (state.currentStep || '').includes(s));
        const pct = currentIdx >= 0 ? ((currentIdx + 1) / steps.length * 100) : 50;
        $('progress-fill').style.width = pct + '%';

      } else {
        $('btn-research').disabled = false;
        $('btn-stop').disabled = true;

        if (state.lastStatus === 'success') {
          updateStatus('success', state.currentStep || 'Done');
          $('status-section').style.display = 'block';
          $('current-step').textContent = state.currentStep || 'Complete';
          $('current-progress').textContent = state.progress || '';

          // Load results
          const stored = await chrome.storage.local.get('lastResearchResults');
          if (stored.lastResearchResults) {
            if (!lastResults || lastResults.completed_at !== stored.lastResearchResults.completed_at) {
              lastResults = stored.lastResearchResults;
              renderResults(lastResults);
              await loadStats();
              await loadAllHistory();
            }
          }
        } else if (state.lastStatus === 'error') {
          updateStatus('error', state.progress || 'Error');
          $('snapshot-skeleton').style.display = 'none';
          $('snapshot-empty').style.display = 'block';
        } else if (state.lastStatus === 'stopped') {
          updateStatus('idle', 'Stopped');
          $('snapshot-skeleton').style.display = 'none';
          $('snapshot-empty').style.display = 'block';
        }
      }

      // Sync log entries
      if (state.logs && state.logs.length > logEntries.length) {
        const newLogs = state.logs.slice(logEntries.length);
        newLogs.forEach(l => addLogEntry(l.type, l.msg, l.time));
        logEntries = state.logs;
      }
    });

    // Active tool sessions check
    chrome.runtime.sendMessage({ action: 'checkToolSessions' }, (response) => {
      if (chrome.runtime.lastError) return;
      if (!response) return;

      const erankConnected = !!response.erankConnected;
      const aluraConnected = !!response.aluraConnected;

      const badgeErank = $('badge-erank');
      const badgeAlura = $('badge-alura');

      if (badgeErank) {
        if (erankConnected) {
          badgeErank.textContent = 'eRank: Live';
          badgeErank.className = 'tool-badge connected';
        } else {
          badgeErank.textContent = 'eRank: Out';
          badgeErank.className = 'tool-badge disconnected';
        }
      }

      if (badgeAlura) {
        if (aluraConnected) {
          badgeAlura.textContent = 'Alura: Live';
          badgeAlura.className = 'tool-badge connected';
        } else {
          badgeAlura.textContent = 'Alura: Out';
          badgeAlura.className = 'tool-badge disconnected';
        }
      }

      const recBar = $('recommendation-bar');
      if (recBar) {
        if (!erankConnected && !aluraConnected) {
          recBar.style.display = 'block';
        } else {
          recBar.style.display = 'none';
        }
      }
    });
  }

  async function loadState() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'getState' }, async (state) => {
        if (chrome.runtime.lastError) {
          resolve();
          return;
        }
        if (state && state.lastStatus === 'success') {
          const stored = await chrome.storage.local.get('lastResearchResults');
          if (stored.lastResearchResults) {
            lastResults = stored.lastResearchResults;
            renderResults(lastResults);
          }
        }
        if (state && state.logs) {
          state.logs.forEach(l => addLogEntry(l.type, l.msg, l.time));
          logEntries = state.logs;
        }
        resolve();
      });
    });
  }

  // ─── Results Rendering ──────────────────────────────────────────────────
  function renderResults(results) {
    if (!results) return;

    $('snapshot-skeleton').style.display = 'none';
    $('snapshot-empty').style.display = 'none';
    $('results-section').style.display = 'block';

    const badge = $('snapshot-status');
    if (badge) {
      badge.style.display = 'inline-block';
      badge.textContent = results.completed_at ? 'Fresh' : 'Loaded';
    }

    $('stat-total').textContent = results.stats?.total || 0;
    $('stat-wins').textContent = results.stats?.wins || 0;
    $('stat-score').textContent = results.stats?.avg_win_score || 0;
    $('stat-beatable').textContent = `${results.stats?.beatable_slots || 0}/12`;

    const score = results.stats?.avg_win_score || 0;
    $('stat-score').className = 'stat-value ' + scoreColorClass(score);

    const clustersList = $('clusters-list');
    if (clustersList) {
      clustersList.innerHTML = '';
      const clusters = results.clusters || [];
      if (clusters.length === 0) {
        clustersList.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">No opportunity clusters found.</div>';
      } else {
        clusters.forEach(cluster => {
          clustersList.appendChild(createClusterCard(cluster));
        });
      }
    }

    const listingsList = $('listings-list');
    if (listingsList) {
      listingsList.innerHTML = '';
      const listings = results.listings || [];
      if (listings.length === 0) {
        listingsList.innerHTML = '<div style="font-size:12px; color:var(--text-muted);">No listings scored.</div>';
      } else {
        listings.slice(0, 10).forEach((listing, i) => {
          listingsList.appendChild(createListingCard(listing, i));
        });
      }
    }
  }

  function createClusterCard(cluster) {
    const verdictRaw = (cluster.verdict || '').toLowerCase();
    let verdictClass = 'verdict-average';
    let badgeClass = 'verdict-badge-average';
    if (verdictRaw.includes('win')) { verdictClass = 'verdict-win'; badgeClass = 'verdict-badge-win'; }
    else if (verdictRaw.includes('good')) { verdictClass = 'verdict-good'; badgeClass = 'verdict-badge-good'; }
    else if (verdictRaw.includes('skip')) { verdictClass = 'verdict-skip'; badgeClass = 'verdict-badge-skip'; }

    const card = document.createElement('div');
    card.className = `cluster-card ${verdictClass}`;

    const winScore = cluster.win_score || 0;

    card.innerHTML = `
      <div class="cluster-header">
        <div>
          <div class="cluster-name">${escHtml(cluster.niche || 'Unnamed')}</div>
          <span class="cluster-verdict ${badgeClass}">${escHtml(cluster.verdict || 'N/A')}</span>
        </div>
        <div class="cluster-score ${scoreColorClass(winScore)}">${winScore}</div>
      </div>
      <div class="cluster-detail"><strong>💡 Opportunity:</strong> ${escHtml(cluster.opportunity || '')}</div>
      <div class="cluster-detail"><strong>🎯 Target:</strong> ${escHtml(cluster.target_buyer || '')}</div>
      <div class="cluster-detail"><strong>💰 Price:</strong> ${escHtml(cluster.price_recommendation || '')}</div>
      ${cluster.image_prompt ? `<div class="cluster-detail" style="margin-top: 4px; background: rgba(255, 255, 255, 0.03); padding: 8px; border-radius: 4px; border: 1px solid var(--border);"><strong>🎨 Midjourney Prompt:</strong> <span style="font-family: monospace; font-size: 11px;">${escHtml(cluster.image_prompt)}</span></div>` : ''}
    `;
    return card;
  }

  function createListingCard(listing, index) {
    const scores = listing.scores || {};
    const card = document.createElement('a');
    card.className = 'listing-card';
    card.href = listing.etsy_url || '#';
    card.target = '_blank';
    card.rel = 'noopener';

    let badges = '';
    if (listing.is_bestseller) badges += '<span class="tag">Bestseller</span>';
    if (listing.is_popular_now) badges += '<span class="tag">Popular</span>';
    if (listing.is_digital) badges += '<span class="tag">Digital</span>';

    card.innerHTML = `
      <div class="listing-rank">#${listing.search_position || index + 1}</div>
      <div class="listing-info">
        <div class="listing-title">${escHtml(listing.title || '')}</div>
        <div class="listing-meta">
          $${listing.price || 0} · ${listing.shop_name || 'Unknown'} · ${listing.shop_reviews || 0} reviews ${badges}
        </div>
      </div>
      <div class="listing-score-badge ${scoreColorClass(scores.win_score || 0)}">${scores.win_score || '-'}</div>
    `;
    return card;
  }

  // ─── Activity Log ───────────────────────────────────────────────────────
  function initLogHandlers() {
    $('btn-copy-log').addEventListener('click', () => {
      const text = $('log-area').innerText;
      copyText(text);
    });
    $('btn-clear-log').addEventListener('click', () => {
      $('log-area').innerHTML = '';
      logEntries = [];
    });
  }

  function addLog(type, msg) {
    addLogEntry(type, msg, new Date().toLocaleTimeString());
  }

  function addLogEntry(type, msg, time) {
    const area = $('log-area');
    if (!area) return;
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.innerHTML = `<span class="log-time">[${time}]</span> ${escHtml(msg)}`;
    area.appendChild(entry);
    area.scrollTop = area.scrollHeight;
  }

  // ─── SEO Audit ──────────────────────────────────────────────────────────
  function initAuditHandlers() {
    $('btn-audit').addEventListener('click', runAudit);
    $('btn-copy-title').addEventListener('click', () => {
      if (lastAudit?.better_title) copyText(lastAudit.better_title);
    });
    $('btn-copy-tags').addEventListener('click', () => {
      if (lastAudit?.better_tags) copyText(lastAudit.better_tags.join(', '));
    });
    $('btn-export-audit').addEventListener('click', () => {
      if (lastAudit) {
        const json = JSON.stringify(lastAudit, null, 2);
        downloadBlob(json, 'etsy-seo-audit.json', 'application/json');
      }
    });
  }

  async function runAudit() {
    const url = $('audit-url').value.trim();
    if (!url || !url.includes('etsy.com/listing/')) {
      $('audit-url').style.borderColor = '#f87171';
      return;
    }
    $('audit-url').style.borderColor = '';

    $('btn-audit').disabled = true;
    $('btn-audit').innerHTML = '⏳ Auditing...';
    $('audit-results').style.display = 'none';
    addLog('info', `Starting SEO audit: ${url}`);

    chrome.runtime.sendMessage({ action: 'runFullAudit', url }, async (response) => {
      $('btn-audit').disabled = false;
      $('btn-audit').innerHTML = '🔍 Audit SEO';

      if (chrome.runtime.lastError) {
        addLog('error', `Audit failed: ${chrome.runtime.lastError.message}`);
        return;
      }
      if (!response || !response.success) {
        addLog('error', `Audit failed: ${response?.error || 'Unknown'}`);
        return;
      }

      let audit;
      if (response.audit) {
        audit = response.audit;
        addLog('success', `AI SEO audit complete (${response.audit.source}) — Score: ${audit.overall_score}`);
      } else {
        audit = performLocalAudit(response.data);
        addLog('success', `Math SEO audit complete — Score: ${audit.overall_score}`);
      }

      lastAudit = audit;
      renderAuditResults(audit);
    });
  }

  function performLocalAudit(data) {
    const title = data.title || '';
    const tags = data.tags || [];
    const description = data.description || '';
    const issues = [];
    const fixes = [];
    let titleScore = 100, tagsScore = 100, descScore = 100;

    if (title.length < 80) { titleScore -= 30; issues.push(`Title too short: ${title.length} chars (optimal: 130-140)`); fixes.push('Expand title with more keywords'); }
    else if (title.length < 130) { titleScore -= 15; issues.push(`Title could be longer: ${title.length}/140 chars`); }
    if (title.length > 140) { titleScore -= 10; issues.push('Title exceeds 140 char limit'); }

    if (tags.length === 0) { tagsScore = 0; issues.push('No tags found'); fixes.push('Add exactly 13 tags with multi-word phrases'); }
    else if (tags.length < 13) { tagsScore -= (13 - tags.length) * 7; issues.push(`Only ${tags.length}/13 tags used`); fixes.push(`Add ${13 - tags.length} more tags`); }
    const singleWord = tags.filter(t => !t.includes(' '));
    if (singleWord.length > 2) { tagsScore -= singleWord.length * 3; issues.push(`${singleWord.length} single-word tags`); fixes.push('Use 2-3 word phrases instead'); }

    if (!description || description.length < 20) { descScore = 20; issues.push('Description appears missing'); fixes.push('Write 250+ words with keywords in first 160 chars'); }
    else if (description.length < 100) { descScore -= 30; issues.push('Description is too brief'); }

    titleScore = Math.max(0, Math.min(100, titleScore));
    tagsScore = Math.max(0, Math.min(100, tagsScore));
    descScore = Math.max(0, Math.min(100, descScore));

    let betterTags = [...tags];
    while (betterTags.length < 13) betterTags.push('[add keyword phrase]');

    return {
      overall_score: Math.round(titleScore * 0.35 + tagsScore * 0.40 + descScore * 0.25),
      title_score: titleScore,
      tags_score: tagsScore,
      description_score: descScore,
      issues,
      fixes,
      better_title: title.length < 130 ? title + ' — [add more keywords]' : title,
      better_tags: betterTags.slice(0, 13),
      keyword_gaps: ['Add seasonal keywords', 'Add long-tail variations', 'Add buyer-intent phrases'],
      price_analysis: `Current price: $${data.price || 0}`,
      source: 'math'
    };
  }

  function renderAuditResults(audit) {
    $('audit-results').style.display = 'block';

    const score = audit.overall_score || 0;
    $('audit-overall-score').textContent = score;
    $('audit-score-circle').style.borderColor = scoreColor(score);
    $('audit-overall-score').style.color = scoreColor(score);

    animateBar($('audit-title-bar'), audit.title_score, scoreColor(audit.title_score));
    animateBar($('audit-tags-bar'), audit.tags_score, scoreColor(audit.tags_score));
    animateBar($('audit-desc-bar'), audit.description_score, scoreColor(audit.description_score));
    $('audit-title-score').textContent = audit.title_score;
    $('audit-tags-score').textContent = audit.tags_score;
    $('audit-desc-score').textContent = audit.description_score;

    let detailsHtml = '';
    if (audit.issues && audit.issues.length > 0) {
      detailsHtml += '<h4>⚠ Issues Found</h4><ul>';
      audit.issues.forEach(i => detailsHtml += `<li>${escHtml(i)}</li>`);
      detailsHtml += '</ul>';
    }
    if (audit.fixes && audit.fixes.length > 0) {
      detailsHtml += '<h4 style="margin-top:10px">✅ Recommended Fixes</h4><ul>';
      audit.fixes.forEach(f => detailsHtml += `<li>${escHtml(f)}</li>`);
      detailsHtml += '</ul>';
    }
    if (audit.keyword_gaps && audit.keyword_gaps.length > 0) {
      detailsHtml += '<h4 style="margin-top:10px">🔑 Keyword Gaps</h4><ul>';
      audit.keyword_gaps.forEach(k => detailsHtml += `<li>${escHtml(k)}</li>`);
      detailsHtml += '</ul>';
    }
    $('audit-details').innerHTML = detailsHtml;

    if (audit.better_title) {
      $('audit-better-title-section').style.display = 'block';
      $('audit-better-title').textContent = audit.better_title;
    } else {
      $('audit-better-title-section').style.display = 'none';
    }

    if (audit.better_tags && audit.better_tags.length > 0) {
      $('audit-better-tags-section').style.display = 'block';
      $('audit-better-tags').textContent = audit.better_tags.join(', ');
    } else {
      $('audit-better-tags-section').style.display = 'none';
    }
  }

  function animateBar(el, value, color) {
    if (!el) return;
    el.style.width = '0%';
    el.style.background = color;
    setTimeout(() => { el.style.width = value + '%'; }, 100);
  }

  // ─── Export ─────────────────────────────────────────────────────────────
  function initExportHandlers() {
    $('btn-export-csv').addEventListener('click', () => {
      if (!lastResults) return;
      const csv = buildCSV(lastResults);
      const safeName = lastResults.keyword.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
      downloadBlob(csv, `etsy-research-${safeName}.csv`, 'text/csv');
      addLog('success', 'CSV exported');
    });

    $('btn-export-json').addEventListener('click', () => {
      if (!lastResults) return;
      const json = JSON.stringify(lastResults, null, 2);
      const safeName = lastResults.keyword.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
      downloadBlob(json, `etsy-research-${safeName}.json`, 'application/json');
      addLog('success', 'JSON exported');
    });
  }

  function buildCSV(results) {
    const headers = ['Rank', 'Title', 'Price', 'Shop Name', 'Reviews', 'Bestseller', 'Popular', 'Digital', 'Win Score', 'Verdict'];
    const rows = [headers.join(',')];

    const listings = results.listings || [];
    listings.forEach((l, i) => {
      const scores = l.scores || {};
      const row = [
        l.search_position || i + 1,
        `"${(l.title || '').replace(/"/g, '""')}"`,
        l.price || 0,
        `"${(l.shop_name || '').replace(/"/g, '""')}"`,
        l.shop_reviews || 0,
        l.is_bestseller ? 'Yes' : 'No',
        l.is_popular_now ? 'Yes' : 'No',
        l.is_digital ? 'Yes' : 'No',
        scores.win_score || 0,
        scores.verdict || ''
      ];
      rows.push(row.join(','));
    });

    return rows.join('\n');
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).then(() => {
      addLog('success', 'Copied to clipboard!');
    }).catch(err => {
      console.error('[ERP] Copy failed:', err);
    });
  }

  // ─── Load Stats ─────────────────────────────────────────────────────────
  async function loadStats() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'getHistoryStats' }, (stats) => {
        if (chrome.runtime.lastError) {
          console.warn('[ERP] Error getting stats:', chrome.runtime.lastError.message);
          resolve();
          return;
        }
        if (stats) {
          animateCounter('total-runs', stats.totalRuns || 0);
          animateCounter('total-niches', stats.totalNiches || 0);
          animateCounter('avg-score', stats.avgScore || 0);
          // Total wins will be computed from runs
        }
        resolve();
      });
    });
  }

  // ─── Animated Counter ───────────────────────────────────────────────────
  function animateCounter(elementId, target) {
    const el = $(elementId);
    if (!el) return;
    el.setAttribute('data-target', target);
    const duration = 1200;
    const start = performance.now();
    const from = 0;

    function tick(now) {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = Math.round(from + (target - from) * eased);
      if (progress < 1) requestAnimationFrame(tick);
      else el.textContent = target;
    }
    requestAnimationFrame(tick);
  }

  // ─── Load All History ───────────────────────────────────────────────────
  async function loadAllHistory() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'getAllHistory' }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[ERP] Error loading history:', chrome.runtime.lastError.message);
          resolve();
          return;
        }
        allRuns = response?.runs || [];
        filteredRuns = [...allRuns];

        // Compute total wins
        let totalWins = 0;
        allRuns.forEach(r => { totalWins += r.stats?.wins || 0; });
        animateCounter('total-wins', totalWins);

        renderAll();
        resolve();
      });
    });
  }

  function renderAll() {
    renderTable();
    renderDonutChart();
    renderLineChart();
    renderBarChart();
    renderNicheSpotlights();
    $('table-count').textContent = `${filteredRuns.length} runs`;
    $('dist-total').textContent = `${filteredRuns.length} runs`;
  }

  // ─── Apply Filters ──────────────────────────────────────────────────────
  function applyFilters() {
    const filters = {
      dateFrom: $('date-from').value || undefined,
      dateTo: $('date-to').value || undefined,
      productType: $('filter-type').value,
      minScore: parseInt($('filter-min-score').value) || 0
    };

    chrome.runtime.sendMessage({ action: 'filterHistory', filters }, (response) => {
      if (chrome.runtime.lastError) {
        console.warn('[ERP] Error filtering history:', chrome.runtime.lastError.message);
        return;
      }
      filteredRuns = response?.runs || [];
      currentPage = 1;
      searchQuery = '';
      $('table-search-input').value = '';
      renderAll();
    });
  }

  function applySearchFilter() {
    if (!searchQuery) {
      renderTable();
      return;
    }
    renderTable();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CUSTOM CANVAS CHARTS (CSP Compliant — no external libs)
  // ═══════════════════════════════════════════════════════════════════════

  // ─── Donut Chart ────────────────────────────────────────────────────────
  function renderDonutChart() {
    const canvas = $('chart-donut');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = 200 * dpr;
    canvas.height = 200 * dpr;
    canvas.style.width = '200px';
    canvas.style.height = '200px';
    ctx.scale(dpr, dpr);

    // Count scores in each band
    let wins = 0, goods = 0, averages = 0, skips = 0;
    filteredRuns.forEach(r => {
      const s = r.stats?.avg_win_score || 0;
      if (s >= 70) wins++;
      else if (s >= 50) goods++;
      else if (s >= 30) averages++;
      else skips++;
    });

    const total = filteredRuns.length || 1;
    const segments = [
      { value: wins, color: COLORS.win, label: 'WIN' },
      { value: goods, color: COLORS.good, label: 'GOOD' },
      { value: averages, color: COLORS.average, label: 'AVG' },
      { value: skips, color: COLORS.skip, label: 'SKIP' },
    ].filter(s => s.value > 0);

    const cx = 100, cy = 100, r = 75, innerR = 52;

    // Clear
    ctx.clearRect(0, 0, 200, 200);

    if (segments.length === 0) {
      // Empty state ring
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.arc(cx, cy, innerR, 0, Math.PI * 2, true);
      ctx.fillStyle = 'rgba(50, 50, 100, 0.2)';
      ctx.fill();
      $('donut-center-value').textContent = '—';
      return;
    }

    // Animate drawing
    const animDuration = 1000;
    const startTime = performance.now();

    function drawFrame(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / animDuration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const drawAngle = eased * Math.PI * 2;

      ctx.clearRect(0, 0, 200, 200);

      let startAngle = -Math.PI / 2;
      segments.forEach(seg => {
        const segAngle = (seg.value / total) * Math.PI * 2;
        const actualAngle = Math.min(segAngle, Math.max(0, drawAngle - (startAngle + Math.PI / 2)));

        if (actualAngle > 0) {
          ctx.beginPath();
          ctx.arc(cx, cy, r, startAngle, startAngle + actualAngle);
          ctx.arc(cx, cy, innerR, startAngle + actualAngle, startAngle, true);
          ctx.closePath();

          // Gradient fill for richness
          const grad = ctx.createRadialGradient(cx, cy, innerR, cx, cy, r);
          grad.addColorStop(0, seg.color + '99');
          grad.addColorStop(1, seg.color);
          ctx.fillStyle = grad;
          ctx.fill();

          // Subtle shadow
          ctx.shadowColor = seg.color;
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        startAngle += segAngle;
      });

      // Gap lines between segments
      startAngle = -Math.PI / 2;
      ctx.strokeStyle = '#06060f';
      ctx.lineWidth = 2;
      segments.forEach(seg => {
        const segAngle = (seg.value / total) * Math.PI * 2;
        startAngle += segAngle;
        const x1 = cx + innerR * Math.cos(startAngle);
        const y1 = cy + innerR * Math.sin(startAngle);
        const x2 = cx + r * Math.cos(startAngle);
        const y2 = cy + r * Math.sin(startAngle);
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      });

      if (progress < 1) requestAnimationFrame(drawFrame);
    }
    requestAnimationFrame(drawFrame);

    // Center value
    const avgScore = Math.round(filteredRuns.reduce((s, r) => s + (r.stats?.avg_win_score || 0), 0) / total);
    $('donut-center-value').textContent = avgScore;
    $('donut-center-value').style.color = scoreColor(avgScore);
  }

  // ─── Line Chart — Win Scores Over Time ──────────────────────────────────
  function renderLineChart() {
    const canvas = $('chart-scores-over-time');
    if (!canvas) return;

    const rect = canvas.parentElement.getBoundingClientRect();
    const W = Math.max(rect.width - 48, 400);
    const H = 260;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Group by date
    const byDate = {};
    filteredRuns.forEach(r => {
      const date = new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      if (!byDate[date]) byDate[date] = [];
      byDate[date].push(r.stats?.avg_win_score || 0);
    });

    const labels = Object.keys(byDate).reverse().slice(-30);
    const data = labels.map(d => {
      const scores = byDate[d];
      return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    });

    if (data.length === 0) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = '14px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data yet — run some research!', W / 2, H / 2);
      return;
    }

    $('chart-period').textContent = `Last ${labels.length} days`;

    const padL = 48, padR = 20, padT = 20, padB = 40;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;

    ctx.clearRect(0, 0, W, H);

    // Grid lines
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    for (let i = 0; i <= 4; i++) {
      const y = padT + (chartH / 4) * i;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + chartW, y);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Y-axis labels
    ctx.fillStyle = COLORS.textMuted;
    ctx.font = '10px "Segoe UI", sans-serif';
    ctx.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const y = padT + (chartH / 4) * i;
      ctx.fillText(100 - i * 25, padL - 8, y + 3);
    }

    // X-axis labels (show every Nth)
    ctx.textAlign = 'center';
    const step = Math.max(1, Math.floor(labels.length / 8));
    labels.forEach((label, i) => {
      if (i % step === 0 || i === labels.length - 1) {
        const x = padL + (i / (labels.length - 1 || 1)) * chartW;
        ctx.fillText(label, x, H - 8);
      }
    });

    // Animate line drawing
    const animDuration = 1200;
    const startTime = performance.now();

    function drawFrame(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / animDuration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const drawCount = Math.ceil(data.length * eased);

      // Clear chart area only
      ctx.clearRect(padL - 1, padT - 1, chartW + 2, chartH + 2);

      // Re-draw grid
      ctx.strokeStyle = COLORS.grid;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      for (let i = 0; i <= 4; i++) {
        const y = padT + (chartH / 4) * i;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + chartW, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      if (drawCount < 2) {
        if (progress < 1) requestAnimationFrame(drawFrame);
        return;
      }

      // Build points
      const points = [];
      for (let i = 0; i < drawCount; i++) {
        const x = padL + (i / (data.length - 1 || 1)) * chartW;
        const y = padT + chartH - (data[i] / 100) * chartH;
        points.push({ x, y });
      }

      // Gradient fill under line
      const grad = ctx.createLinearGradient(0, padT, 0, padT + chartH);
      grad.addColorStop(0, 'rgba(241, 100, 30, 0.25)');
      grad.addColorStop(1, 'rgba(241, 100, 30, 0.02)');

      ctx.beginPath();
      ctx.moveTo(points[0].x, padT + chartH);
      points.forEach(p => ctx.lineTo(p.x, p.y));
      ctx.lineTo(points[points.length - 1].x, padT + chartH);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Line
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        // Smooth curve
        const prev = points[i - 1];
        const curr = points[i];
        const cpx = (prev.x + curr.x) / 2;
        ctx.quadraticCurveTo(prev.x + (cpx - prev.x) * 0.8, prev.y, cpx, (prev.y + curr.y) / 2);
        ctx.quadraticCurveTo(curr.x - (curr.x - cpx) * 0.8, curr.y, curr.x, curr.y);
      }

      const lineGrad = ctx.createLinearGradient(padL, 0, padL + chartW, 0);
      lineGrad.addColorStop(0, COLORS.accent);
      lineGrad.addColorStop(1, COLORS.accentLight);
      ctx.strokeStyle = lineGrad;
      ctx.lineWidth = 3;
      ctx.stroke();

      // Dots
      points.forEach((p, i) => {
        if (data.length <= 15 || i % Math.ceil(data.length / 15) === 0 || i === points.length - 1) {
          ctx.beginPath();
          ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
          ctx.fillStyle = '#06060f';
          ctx.fill();
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fillStyle = scoreColor(data[i]);
          ctx.fill();

          // Glow
          ctx.shadowColor = scoreColor(data[i]);
          ctx.shadowBlur = 6;
          ctx.fill();
          ctx.shadowBlur = 0;
        }
      });

      if (progress < 1) requestAnimationFrame(drawFrame);
    }
    requestAnimationFrame(drawFrame);
  }

  // ─── Bar Chart — Top Keywords ───────────────────────────────────────────
  function renderBarChart() {
    const canvas = $('chart-top-keywords');
    if (!canvas) return;

    const rect = canvas.parentElement.getBoundingClientRect();
    const W = Math.max(rect.width - 48, 400);
    const H = 260;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Count keywords
    const counts = {};
    filteredRuns.forEach(r => {
      counts[r.keyword] = (counts[r.keyword] || 0) + 1;
    });

    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 10);

    if (sorted.length === 0) {
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = COLORS.textMuted;
      ctx.font = '14px "Segoe UI", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No keywords researched yet', W / 2, H / 2);
      return;
    }

    $('chart-kw-count').textContent = `Top ${sorted.length}`;

    const labels = sorted.map(([kw]) => kw.length > 22 ? kw.substring(0, 22) + '…' : kw);
    const data = sorted.map(([, count]) => count);
    const maxVal = Math.max(...data, 1);

    const padL = 160, padR = 40, padT = 10, padB = 10;
    const chartW = W - padL - padR;
    const barH = Math.min(22, (H - padT - padB) / data.length - 6);
    const gap = (H - padT - padB - barH * data.length) / (data.length + 1);

    ctx.clearRect(0, 0, W, H);

    // Bar colors
    const barColors = [
      '#F1641E', '#ff7a3d', '#ff9a5c', '#fbb87c',
      '#4ade80', '#60d6a0', '#fbbf24', '#60a5fa',
      '#a78bfa', '#f87171'
    ];

    // Animate bars
    const animDuration = 900;
    const startTime = performance.now();

    function drawFrame(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / animDuration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);

      ctx.clearRect(0, 0, W, H);

      data.forEach((val, i) => {
        const y = padT + gap + i * (barH + gap);
        const barWidth = (val / maxVal) * chartW * eased;

        // Label
        ctx.fillStyle = COLORS.textSecondary;
        ctx.font = '12px "Segoe UI", sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(labels[i], padL - 12, y + barH / 2 + 4);

        // Bar background
        ctx.fillStyle = 'rgba(50, 50, 100, 0.15)';
        ctx.beginPath();
        ctx.roundRect(padL, y, chartW, barH, 4);
        ctx.fill();

        // Bar fill
        if (barWidth > 0) {
          const grad = ctx.createLinearGradient(padL, 0, padL + barWidth, 0);
          grad.addColorStop(0, barColors[i % barColors.length]);
          grad.addColorStop(1, barColors[i % barColors.length] + '99');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.roundRect(padL, y, barWidth, barH, 4);
          ctx.fill();

          // Glow
          ctx.shadowColor = barColors[i % barColors.length];
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // Value label
        if (eased > 0.5) {
          ctx.fillStyle = COLORS.text;
          ctx.font = 'bold 11px "Segoe UI", sans-serif';
          ctx.textAlign = 'left';
          ctx.fillText(val + 'x', padL + barWidth + 8, y + barH / 2 + 4);
        }
      });

      if (progress < 1) requestAnimationFrame(drawFrame);
    }
    requestAnimationFrame(drawFrame);
  }

  // ─── Niche Spotlights ──────────────────────────────────────────────────
  function renderNicheSpotlights() {
    const container = $('niche-spotlights');
    if (!container) return;

    // Collect all top niches across all runs
    const allNiches = [];
    filteredRuns.forEach(run => {
      (run.top_niches || []).forEach(n => {
        allNiches.push({
          name: n.name,
          score: n.win_score || 0,
          verdict: n.verdict || '',
          keyword: run.keyword,
          date: run.date
        });
      });
    });

    // Sort by score, take top 5
    const topNiches = allNiches.sort((a, b) => b.score - a.score).slice(0, 5);

    if (topNiches.length === 0) {
      container.innerHTML = `
        <div class="empty-spotlight">
          <span class="empty-icon">🔍</span>
          <span>Run your first research to see top niches here</span>
        </div>`;
      return;
    }

    container.innerHTML = topNiches.map((niche, i) => {
      const scoreClass = scoreColorClass(niche.score);
      const rankClass = niche.score >= 70 ? 'rank-win' : niche.score >= 50 ? 'rank-good' : 'rank-average';
      const verdictClass = niche.score >= 70 ? 'verdict-win' : niche.score >= 50 ? 'verdict-good' : niche.score >= 30 ? 'verdict-average' : 'verdict-average';
      const verdictText = niche.score >= 70 ? 'WIN' : niche.score >= 50 ? 'GOOD' : niche.score >= 30 ? 'AVG' : 'SKIP';

      return `
        <div class="niche-card ${rankClass}" style="animation-delay: ${0.1 + i * 0.1}s">
          <div class="niche-info">
            <div class="niche-name">${escHtml(niche.name)}</div>
            <div class="niche-keyword">from "${escHtml(niche.keyword)}"</div>
          </div>
          <div class="niche-score-group">
            <span class="niche-score ${scoreClass}">${niche.score}</span>
            <span class="niche-verdict ${verdictClass}">${verdictText}</span>
          </div>
        </div>`;
    }).join('');
  }

  // ─── Render Table ───────────────────────────────────────────────────────
  function renderTable() {
    const tbody = $('table-body');

    // Apply search filter
    let displayRuns = searchQuery
      ? filteredRuns.filter(r => r.keyword.toLowerCase().includes(searchQuery))
      : filteredRuns;

    if (displayRuns.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10"><div class="empty-state"><span class="big-icon">📭</span>No research runs found.</div></td></tr>';
      $('table-count').textContent = '0 runs';
      $('table-pagination').style.display = 'none';
      return;
    }

    // Sort
    const sorted = [...displayRuns].sort((a, b) => {
      let aVal, bVal;
      if (sortField === 'date') {
        aVal = new Date(a.date).getTime();
        bVal = new Date(b.date).getTime();
      } else if (sortField === 'keyword') {
        aVal = a.keyword.toLowerCase();
        bVal = b.keyword.toLowerCase();
      } else if (sortField === 'score') {
        aVal = a.stats?.avg_win_score || 0;
        bVal = b.stats?.avg_win_score || 0;
      }
      if (sortDir === 'asc') return aVal > bVal ? 1 : -1;
      return aVal < bVal ? 1 : -1;
    });

    // Pagination
    const totalPages = Math.ceil(sorted.length / ROWS_PER_PAGE);
    currentPage = Math.min(currentPage, totalPages);
    const startIdx = (currentPage - 1) * ROWS_PER_PAGE;
    const pageRuns = sorted.slice(startIdx, startIdx + ROWS_PER_PAGE);

    // Update pagination UI
    $('page-info').textContent = `Page ${currentPage} of ${totalPages}`;
    $('btn-prev-page').disabled = currentPage <= 1;
    $('btn-next-page').disabled = currentPage >= totalPages;
    $('table-pagination').style.display = totalPages > 1 ? 'flex' : 'none';
    $('table-count').textContent = `${displayRuns.length} runs`;

    tbody.innerHTML = pageRuns.map((run, idx) => {
      const score = run.stats?.avg_win_score || 0;
      const date = new Date(run.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
      const colorClass = scoreColorClass(score);
      const type = run.product_type || 'any';
      const typeClass = `type-${type}`;

      // Trend indicator
      let trendIcon = '<span class="trend-stable">—</span>';
      const runIdx = allRuns.findIndex(r => r.keyword === run.keyword && r.date !== run.date);
      if (runIdx >= 0) {
        const prevScore = allRuns[runIdx].stats?.avg_win_score || 0;
        const diff = score - prevScore;
        if (diff > 5) trendIcon = '<span class="trend-up">▲</span>';
        else if (diff < -5) trendIcon = '<span class="trend-down">▼</span>';
      }

      return `<tr>
        <td>${date}</td>
        <td class="td-keyword" title="${escHtml(run.keyword)}">${escHtml(run.keyword)}</td>
        <td><span class="td-type ${typeClass}">${type}</span></td>
        <td class="td-score ${colorClass}">${score}</td>
        <td>${run.stats?.total || 0}</td>
        <td>${run.stats?.wins || 0}</td>
        <td>${run.stats?.beatable_slots || 0}/12</td>
        <td>${run.ai_mode || run.source || 'math'}</td>
        <td class="td-trend">${trendIcon}</td>
        <td><button class="btn-rerun" data-keyword="${escHtml(run.keyword)}" data-type="${type}">Re-run</button></td>
      </tr>`;
    }).join('');

    // Re-run handlers
    tbody.querySelectorAll('.btn-rerun').forEach(btn => {
      btn.addEventListener('click', () => {
        const keyword = btn.getAttribute('data-keyword');
        const type = btn.getAttribute('data-type');
        chrome.runtime.sendMessage({ action: 'startResearch', keyword, productType: type }, (resp) => {
          if (chrome.runtime.lastError) {
            console.warn('[ERP] Error starting research:', chrome.runtime.lastError.message);
          }
        });
        btn.textContent = 'Started!';
        btn.disabled = true;
        setTimeout(() => {
          btn.textContent = 'Re-run';
          btn.disabled = false;
        }, 3000);
      });
    });
  }

  function changePage(delta) {
    currentPage += delta;
    renderTable();
    // Scroll to table
    $('table-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ─── Export All ──────────────────────────────────────────────────────────
  function exportAll() {
    chrome.runtime.sendMessage({ action: 'exportHistory' }, (data) => {
      if (chrome.runtime.lastError) {
        console.warn('[ERP] Error exporting history:', chrome.runtime.lastError.message);
        return;
      }
      const json = JSON.stringify(data, null, 2);
      downloadBlob(json, `etsy-research-history-${new Date().toISOString().slice(0, 10)}.json`, 'application/json');
    });
  }

  // ─── Clear All ──────────────────────────────────────────────────────────
  function clearAll() {
    if (!confirm('⚠️ Clear ALL research history? This cannot be undone.')) return;
    chrome.runtime.sendMessage({ action: 'clearHistory' }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[ERP] Error clearing history:', chrome.runtime.lastError.message);
        return;
      }
      allRuns = [];
      filteredRuns = [];
      renderAll();
      animateCounter('total-runs', 0);
      animateCounter('total-niches', 0);
      animateCounter('avg-score', 0);
      animateCounter('total-wins', 0);
    });
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  function scoreColor(score) {
    if (score >= 70) return COLORS.win;
    if (score >= 50) return COLORS.good;
    if (score >= 30) return COLORS.average;
    return COLORS.skip;
  }

  function scoreColorClass(score) {
    if (score >= 70) return 'score-win';
    if (score >= 50) return 'score-good';
    if (score >= 30) return 'score-average';
    return 'score-skip';
  }

  function escHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ─── Window resize redraw charts ────────────────────────────────────────
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderLineChart();
      renderBarChart();
    }, 300);
  });

  // ─── Start ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
