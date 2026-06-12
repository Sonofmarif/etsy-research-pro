// Popup Controller — Redirects immediately to full-page dashboard workspace
chrome.tabs.query({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') }, (tabs) => {
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { active: true });
    chrome.windows.update(tabs[0].windowId, { drawAttention: true, focused: true });
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
  }
  window.close();
});

(function () {
  'use strict';

  // ─── DOM References ─────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  let dom = {};

  function initDomReferences() {
    dom = {
      // Header
      statusPill: $('status-pill'),
      statusDot: $('status-dot'),
      statusText: $('status-text'),
      headerProgress: $('header-progress'),
      progressFill: $('progress-fill'),
      progressText: $('progress-text'),
      btnHeaderDashboard: $('btn-header-dashboard'),

      // Tabs
      tabBtns: document.querySelectorAll('.tab-btn'),
      tabContents: document.querySelectorAll('.tab-content'),

      // Research tab
      interestSelect: $('interest-select'),
      interestSection: $('interest-section'),
      chipsSection: $('chips-section'),
      keywordChips: $('keyword-chips'),
      searchInput: $('search-input'),
      productTypeSelect: $('product-type-select'),
      searchError: $('search-error'),
      btnResearch: $('btn-research'),
      btnStop: $('btn-stop'),
      btnAiSeeds: $('btn-ai-seeds'),
      statusSection: $('status-section'),
      currentStep: $('current-step'),
      currentProgress: $('current-progress'),
      resultsSection: $('results-section'),
      statsGrid: $('stats-grid'),
      statTotal: $('stat-total'),
      statWins: $('stat-wins'),
      statScore: $('stat-score'),
      statBeatable: $('stat-beatable'),
      clustersList: $('clusters-list'),
      listingsList: $('listings-list'),
      logArea: $('log-area'),

      // Export
      btnExportCsv: $('btn-export-csv'),
      btnExportJson: $('btn-export-json'),
      btnCopyLog: $('btn-copy-log'),
      btnClearLog: $('btn-clear-log'),

      // Audit tab
      auditUrl: $('audit-url'),
      btnAudit: $('btn-audit'),
      auditResults: $('audit-results'),
      auditScoreCircle: $('audit-score-circle'),
      auditOverallScore: $('audit-overall-score'),
      auditTitleBar: $('audit-title-bar'),
      auditTagsBar: $('audit-tags-bar'),
      auditDescBar: $('audit-desc-bar'),
      auditTitleScore: $('audit-title-score'),
      auditTagsScore: $('audit-tags-score'),
      auditDescScore: $('audit-desc-score'),
      auditDetails: $('audit-details'),
      auditBetterTitleSection: $('audit-better-title-section'),
      auditBetterTitle: $('audit-better-title'),
      auditBetterTagsSection: $('audit-better-tags-section'),
      auditBetterTags: $('audit-better-tags'),
      btnCopyTitle: $('btn-copy-title'),
      btnCopyTags: $('btn-copy-tags'),
      btnExportAudit: $('btn-export-audit'),

      // History tab
      historyList: $('history-list'),
      btnOpenDashboard: $('btn-open-dashboard'),

      // Settings tab
      inputGeminiKey: $('input-gemini-key'),
      inputGroqKey: $('input-groq-key'),
      geminiStatus: $('gemini-status'),
      groqStatus: $('groq-status'),
      inputMaxReviews: $('input-max-reviews'),
      inputTopListings: $('input-top-listings'),
      chkErank: $('chk-erank'),
      chkCommunity: $('chk-community'),
      btnSaveSettings: $('btn-save-settings'),
      settingsSaved: $('settings-saved'),

      // Footer
      lastRunTime: $('last-run-time')
    };
  }

  let lastResults = null;
  let lastAudit = null;
  let pollTimer = null;
  let logEntries = [];

  // ─── Init ───────────────────────────────────────────────────────────────
  async function init() {
    initDomReferences();
    initTabs();
    initInterestSelector();
    initAiSeedsHandler();
    initDashboardLink();
    initSearchHandlers();
    initAuditHandlers();
    initHistoryHandlers();
    initSettingsHandlers();
    initLogHandlers();
    initExportHandlers();

    await loadSettings();
    await loadState();
    await loadHistory();
    startPolling();
  }

  // ─── Tab Switching ──────────────────────────────────────────────────────
  function initTabs() {
    dom.tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.getAttribute('data-tab');
        dom.tabBtns.forEach(b => b.classList.remove('active'));
        dom.tabContents.forEach(c => c.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${tabId}`).classList.add('active');

        if (tabId === 'history') loadHistory();
      });
    });
  }

  // ─── Interest Category → Seed Keywords ──────────────────────────────────
  function initInterestSelector() {
    dom.interestSelect.addEventListener('change', () => {
      const category = dom.interestSelect.value;
      if (!category) {
        dom.chipsSection.style.display = 'none';
        if (dom.btnAiSeeds) dom.btnAiSeeds.style.display = 'none';
        return;
      }

      chrome.runtime.sendMessage({ action: 'getSeedKeywords', category }, (response) => {
        if (chrome.runtime.lastError) {
          console.warn('[ERP] Error fetching seed keywords:', chrome.runtime.lastError.message);
          return;
        }
        if (response && response.keywords && response.keywords.length > 0) {
          renderChips(response.keywords);
          dom.chipsSection.style.display = '';
        }
      });

      // Show AI seeds button if user has an API key (read directly from storage)
      if (dom.btnAiSeeds) {
        chrome.storage.local.get('config', (result) => {
          const config = result.config || {};
          if (config && (config.gemini_api_key || config.groq_api_key)) {
            dom.btnAiSeeds.style.display = '';
          } else {
            dom.btnAiSeeds.style.display = 'none';
          }
        });
      }
    });
  }

  // ─── AI Seed Keywords Handler ───────────────────────────────────────────
  function initAiSeedsHandler() {
    if (!dom.btnAiSeeds) return;
    dom.btnAiSeeds.addEventListener('click', () => {
      const category = dom.interestSelect.value;
      if (!category) return;

      dom.btnAiSeeds.disabled = true;
      const originalText = dom.btnAiSeeds.innerHTML;
      dom.btnAiSeeds.innerHTML = '<span class="btn-icon">⏳</span> Generating...';
      addLog('info', `Requesting AI seed keywords for: "${category}"`);

      chrome.runtime.sendMessage({ action: 'generateAiSeeds', interest: category }, (response) => {
        dom.btnAiSeeds.disabled = false;
        dom.btnAiSeeds.innerHTML = originalText;

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

  // ─── Dashboard Link Handler ─────────────────────────────────────────────
  function initDashboardLink() {
    if (dom.btnHeaderDashboard) {
      dom.btnHeaderDashboard.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
      });
    }
  }

  function renderChips(keywords) {
    dom.keywordChips.innerHTML = '';
    keywords.forEach(kw => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = kw;
      chip.addEventListener('click', () => {
        dom.searchInput.value = kw;
        dom.searchInput.focus();
      });
      dom.keywordChips.appendChild(chip);
    });
  }

  // ─── Research Flow ──────────────────────────────────────────────────────
  function initSearchHandlers() {
    dom.btnResearch.addEventListener('click', startResearch);
    dom.btnStop.addEventListener('click', stopResearch);

    dom.searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') startResearch();
    });
  }

  function startResearch() {
    const keyword = dom.searchInput.value.trim();
    if (!keyword) {
      dom.searchError.textContent = 'Enter a keyword to search';
      dom.searchError.style.display = '';
      return;
    }
    dom.searchError.style.display = 'none';

    const productType = dom.productTypeSelect.value;

    dom.btnResearch.disabled = true;
    dom.btnStop.disabled = false;
    dom.statusSection.style.display = '';
    dom.resultsSection.style.display = 'none';

    updateStatus('running', 'Starting research...');
    addLog('info', `Starting research for: "${keyword}"`);

    chrome.runtime.sendMessage({
      action: 'startResearch',
      keyword,
      productType
    }, (response) => {
      if (chrome.runtime.lastError) {
        addLog('error', `Failed to start: ${chrome.runtime.lastError.message}`);
        dom.btnResearch.disabled = false;
        dom.btnStop.disabled = true;
        updateStatus('error', 'Failed to start');
        return;
      }
      if (response && response.started) {
        addLog('info', 'Pipeline started');
      } else {
        addLog('error', `Failed to start: ${response?.reason || 'Unknown'}`);
        dom.btnResearch.disabled = false;
        dom.btnStop.disabled = true;
        updateStatus('error', 'Failed to start');
      }
    });
  }

  function stopResearch() {
    chrome.runtime.sendMessage({ action: 'stopResearch' }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[ERP] stopResearch error:', chrome.runtime.lastError.message);
      }
      dom.btnResearch.disabled = false;
      dom.btnStop.disabled = true;
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
        // Silent block to prevent uncaught runtime errors during polling
        return;
      }
      if (!state) return;

      if (state.running) {
        dom.btnResearch.disabled = true;
        dom.btnStop.disabled = false;
        dom.statusSection.style.display = '';
        dom.headerProgress.style.display = '';
        dom.currentStep.textContent = state.currentStep || 'Working...';
        dom.currentProgress.textContent = state.progress || '';
        updateStatus('running', state.currentStep || 'Running...');

        // Animate progress bar
        const steps = ['Searching Etsy', 'Scraping listings', 'Scoring listings', 'AI Analysis', 'Saving results'];
        const currentIdx = steps.findIndex(s => (state.currentStep || '').includes(s));
        const pct = currentIdx >= 0 ? ((currentIdx + 1) / steps.length * 100) : 50;
        dom.progressFill.style.width = pct + '%';
        dom.progressText.textContent = state.progress || '';

      } else {
        dom.btnResearch.disabled = false;
        dom.btnStop.disabled = true;
        dom.headerProgress.style.display = 'none';

        if (state.lastStatus === 'success') {
          updateStatus('success', state.currentStep || 'Done');
          dom.statusSection.style.display = '';
          dom.currentStep.textContent = state.currentStep || 'Complete';
          dom.currentProgress.textContent = state.progress || '';

          // Load results
          const stored = await chrome.storage.local.get('lastResearchResults');
          if (stored.lastResearchResults) {
            lastResults = stored.lastResearchResults;
            renderResults(lastResults);
          }
        } else if (state.lastStatus === 'error') {
          updateStatus('error', state.progress || 'Error');
        } else if (state.lastStatus === 'stopped') {
          updateStatus('idle', 'Stopped');
        }
      }

      // Sync log entries
      if (state.logs && state.logs.length > logEntries.length) {
        const newLogs = state.logs.slice(logEntries.length);
        newLogs.forEach(l => addLogEntry(l.type, l.msg, l.time));
        logEntries = state.logs;
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

    dom.resultsSection.style.display = '';

    // Stats
    dom.statTotal.textContent = results.stats?.total || 0;
    dom.statWins.textContent = results.stats?.wins || 0;
    dom.statScore.textContent = results.stats?.avg_win_score || 0;
    dom.statBeatable.textContent = `${results.stats?.beatable_slots || 0}/12`;

    // Color the score
    const score = results.stats?.avg_win_score || 0;
    dom.statScore.className = 'stat-value ' + scoreColorClass(score);

    // Clusters
    dom.clustersList.innerHTML = '';
    (results.clusters || []).forEach(cluster => {
      dom.clustersList.appendChild(createClusterCard(cluster));
    });

    // Top listings
    dom.listingsList.innerHTML = '';
    (results.listings || []).slice(0, 10).forEach((listing, i) => {
      dom.listingsList.appendChild(createListingCard(listing, i));
    });
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
      ${cluster.image_prompt ? `<div class="cluster-detail"><strong>🎨 Image:</strong> ${escHtml(cluster.image_prompt.substring(0, 80))}...</div>` : ''}
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

  // ─── SEO Audit ──────────────────────────────────────────────────────────
  function initAuditHandlers() {
    dom.btnAudit.addEventListener('click', runAudit);
    dom.btnCopyTitle.addEventListener('click', () => {
      if (lastAudit?.better_title) copyText(lastAudit.better_title);
    });
    dom.btnCopyTags.addEventListener('click', () => {
      if (lastAudit?.better_tags) copyText(lastAudit.better_tags.join(', '));
    });
    dom.btnExportAudit.addEventListener('click', () => {
      if (lastAudit) {
        const json = JSON.stringify(lastAudit, null, 2);
        downloadBlob(json, 'etsy-seo-audit.json', 'application/json');
      }
    });
  }

  async function runAudit() {
    const url = dom.auditUrl.value.trim();
    if (!url || !url.includes('etsy.com/listing/')) {
      dom.auditUrl.style.borderColor = '#f87171';
      return;
    }
    dom.auditUrl.style.borderColor = '';

    dom.btnAudit.disabled = true;
    dom.btnAudit.innerHTML = '<span class="btn-icon">⏳</span> Auditing...';
    dom.auditResults.style.display = 'none';
    addLog('info', `Starting SEO audit: ${url}`);

    // Try AI-enhanced audit first via service worker
    chrome.runtime.sendMessage({ action: 'runFullAudit', url }, async (response) => {
      if (chrome.runtime.lastError) {
        addLog('error', `Audit failed: ${chrome.runtime.lastError.message}`);
        dom.btnAudit.disabled = false;
        dom.btnAudit.innerHTML = '<span class="btn-icon">🔍</span> Audit SEO';
        return;
      }
      if (!response || !response.success) {
        addLog('error', `Audit failed: ${response?.error || 'Unknown'}`);
        dom.btnAudit.disabled = false;
        dom.btnAudit.innerHTML = '<span class="btn-icon">🔍</span> Audit SEO';
        return;
      }

      let audit;
      if (response.audit) {
        // AI-enhanced audit returned
        audit = response.audit;
        addLog('success', `AI SEO audit complete (${response.audit.source}) — Score: ${audit.overall_score}`);
      } else {
        // Fallback to local math audit
        audit = performLocalAudit(response.data);
        addLog('success', `Math SEO audit complete — Score: ${audit.overall_score}`);
      }

      lastAudit = audit;
      renderAuditResults(audit);

      dom.btnAudit.disabled = false;
      dom.btnAudit.innerHTML = '<span class="btn-icon">🔍</span> Audit SEO';
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
    dom.auditResults.style.display = '';

    // Overall score circle
    const score = audit.overall_score || 0;
    dom.auditOverallScore.textContent = score;
    dom.auditScoreCircle.style.borderColor = scoreColor(score);
    dom.auditOverallScore.style.color = scoreColor(score);

    // Sub-scores
    animateBar(dom.auditTitleBar, audit.title_score, scoreColor(audit.title_score));
    animateBar(dom.auditTagsBar, audit.tags_score, scoreColor(audit.tags_score));
    animateBar(dom.auditDescBar, audit.description_score, scoreColor(audit.description_score));
    dom.auditTitleScore.textContent = audit.title_score;
    dom.auditTagsScore.textContent = audit.tags_score;
    dom.auditDescScore.textContent = audit.description_score;

    // Issues & Fixes
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
    dom.auditDetails.innerHTML = detailsHtml;

    // Better title
    if (audit.better_title) {
      dom.auditBetterTitleSection.style.display = '';
      dom.auditBetterTitle.textContent = audit.better_title;
    }

    // Better tags
    if (audit.better_tags && audit.better_tags.length > 0) {
      dom.auditBetterTagsSection.style.display = '';
      dom.auditBetterTags.textContent = audit.better_tags.join(', ');
    }
  }

  function animateBar(el, value, color) {
    el.style.width = '0%';
    el.style.background = color;
    setTimeout(() => { el.style.width = value + '%'; }, 100);
  }

  // ─── History ────────────────────────────────────────────────────────────
  function initHistoryHandlers() {
    dom.btnOpenDashboard.addEventListener('click', () => {
      chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') });
    });
  }

  async function loadHistory() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ action: 'getRecentRuns', limit: 20 }, (response) => {
        if (chrome.runtime.lastError) {
          dom.historyList.innerHTML = '<div class="empty-state">Failed to load history.</div>';
          resolve();
          return;
        }
        if (response && response.runs && response.runs.length > 0) {
          renderHistory(response.runs);
        } else {
          dom.historyList.innerHTML = '<div class="empty-state">No research runs yet. Start your first search!</div>';
        }
        resolve();
      });
    });
  }

  function renderHistory(runs) {
    dom.historyList.innerHTML = '';
    runs.forEach(run => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const score = run.stats?.avg_win_score || 0;
      const date = new Date(run.date).toLocaleDateString();

      item.innerHTML = `
        <div>
          <div class="history-keyword">${escHtml(run.keyword)}</div>
          <div class="history-meta">${date} · ${run.stats?.total || 0} listings · ${run.product_type || 'any'} · ${run.ai_mode || 'math'}</div>
        </div>
        <div>
          <div class="history-score ${scoreColorClass(score)}">${score}</div>
          <span class="history-trend">${run.stats?.wins || 0} wins</span>
        </div>
      `;

      item.addEventListener('click', () => {
        dom.searchInput.value = run.keyword;
        dom.productTypeSelect.value = run.product_type || 'any';
        // Switch to research tab
        dom.tabBtns.forEach(b => b.classList.remove('active'));
        dom.tabContents.forEach(c => c.classList.remove('active'));
        document.querySelector('[data-tab="research"]').classList.add('active');
        document.getElementById('tab-research').classList.add('active');
      });

      dom.historyList.appendChild(item);
    });
  }

  // ─── Settings ───────────────────────────────────────────────────────────
  function initSettingsHandlers() {
    dom.btnSaveSettings.addEventListener('click', saveSettings);
  }

  async function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.local.get('config', (result) => {
        const config = result.config || {};

        if (config.gemini_api_key) {
          dom.inputGeminiKey.value = config.gemini_api_key;
          dom.geminiStatus.textContent = '✓ Key saved';
          dom.geminiStatus.className = 'key-status active';
        }
        if (config.groq_api_key) {
          dom.inputGroqKey.value = config.groq_api_key;
          dom.groqStatus.textContent = '✓ Key saved';
          dom.groqStatus.className = 'key-status active';
        }
        if (config.max_shop_reviews_beatable) {
          dom.inputMaxReviews.value = config.max_shop_reviews_beatable;
        }
        if (config.top_n_listings) {
          dom.inputTopListings.value = config.top_n_listings;
        }
        dom.chkErank.checked = !!config.erank_enabled;
        dom.chkCommunity.checked = !!config.community_sharing;
        resolve();
      });
    });
  }

  function saveSettings() {
    chrome.storage.local.get('config', (result) => {
      const config = result.config || {};

      const geminiKey = dom.inputGeminiKey.value.trim();
      const groqKey = dom.inputGroqKey.value.trim();

      config.gemini_api_key = geminiKey;
      config.groq_api_key = groqKey;

      if (geminiKey) config.ai_provider = 'gemini';
      else if (groqKey) config.ai_provider = 'groq';
      else config.ai_provider = 'none';

      config.max_shop_reviews_beatable = parseInt(dom.inputMaxReviews.value) || 300;
      config.top_n_listings = parseInt(dom.inputTopListings.value) || 12;
      config.erank_enabled = dom.chkErank.checked;
      config.community_sharing = dom.chkCommunity.checked;

      chrome.storage.local.set({ config }, () => {
        // Update status labels
        dom.geminiStatus.textContent = geminiKey ? '✓ Key saved' : 'Not configured';
        dom.geminiStatus.className = geminiKey ? 'key-status active' : 'key-status';
        dom.groqStatus.textContent = groqKey ? '✓ Key saved' : 'Not configured';
        dom.groqStatus.className = groqKey ? 'key-status active' : 'key-status';

        dom.settingsSaved.style.display = 'inline';
        setTimeout(() => { dom.settingsSaved.style.display = 'none'; }, 2000);

        addLog('success', 'Settings saved');
      });
    });
  }

  // ─── Activity Log ───────────────────────────────────────────────────────
  function initLogHandlers() {
    dom.btnCopyLog.addEventListener('click', () => {
      const text = dom.logArea.innerText;
      copyText(text);
    });
    dom.btnClearLog.addEventListener('click', () => {
      dom.logArea.innerHTML = '';
      logEntries = [];
    });
  }

  function addLog(type, msg) {
    addLogEntry(type, msg, new Date().toLocaleTimeString());
  }

  function addLogEntry(type, msg, time) {
    const entry = document.createElement('div');
    entry.className = `log-entry log-${type}`;
    entry.innerHTML = `<span class="log-time">[${time}]</span> ${escHtml(msg)}`;
    dom.logArea.appendChild(entry);
    dom.logArea.scrollTop = dom.logArea.scrollHeight;
  }

  // ─── Export ─────────────────────────────────────────────────────────────
  function initExportHandlers() {
    dom.btnExportCsv.addEventListener('click', () => {
      if (!lastResults) return;
      const csv = buildCSV(lastResults);
      const safeName = lastResults.keyword.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
      downloadBlob(csv, `etsy-research-${safeName}.csv`, 'text/csv');
      addLog('success', 'CSV exported');
    });

    dom.btnExportJson.addEventListener('click', () => {
      if (!lastResults) return;
      const json = JSON.stringify(lastResults, null, 2);
      const safeName = lastResults.keyword.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
      downloadBlob(json, `etsy-research-${safeName}.json`, 'application/json');
      addLog('success', 'JSON exported');
    });
  }

  function buildCSV(results) {
    const lines = [];
    lines.push(`# Etsy Research Pro — ${results.keyword}`);
    lines.push(`# Date: ${new Date().toISOString()}`);
    lines.push('');
    lines.push('Position,Title,Price,Shop,Reviews,Bestseller,Win Score,Verdict,URL');
    (results.listings || []).forEach(l => {
      const s = l.scores || {};
      lines.push([
        l.search_position, csvEscape(l.title), l.price, csvEscape(l.shop_name),
        l.shop_reviews, l.is_bestseller ? 'Y' : 'N', s.win_score || 0, s.verdict || '', l.etsy_url
      ].join(','));
    });
    return lines.join('\n');
  }

  // ─── Utility Functions ──────────────────────────────────────────────────
  function updateStatus(status, text) {
    dom.statusDot.className = `status-dot ${status}`;
    dom.statusText.textContent = text ? text.substring(0, 40) : '';
  }

  function scoreColor(score) {
    if (score >= 70) return '#4ade80';
    if (score >= 50) return '#F1641E';
    if (score >= 30) return '#fbbf24';
    return '#f87171';
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

  function csvEscape(str) {
    if (!str) return '';
    str = String(str);
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
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

  // ─── Start ──────────────────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', init);
})();
