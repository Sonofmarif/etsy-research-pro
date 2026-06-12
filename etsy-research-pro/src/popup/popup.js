// Etsy Research Pro — Extension Popup Controller
// Sleek, compact UI managing core extension options, pipeline actions, and status tracking.

(function () {
  'use strict';

  // ─── DOM References ─────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  let dom = {};
  let pollInterval = null;

  function initDomReferences() {
    dom = {
      inputKeyword: $('input-keyword'),
      btnStartPipeline: $('btn-start-pipeline'),
      btnStopPipeline: $('btn-stop-pipeline'),
      btnOpenDashboard: $('btn-open-dashboard'),
      
      // Settings
      inputGeminiKey: $('input-gemini-key'),
      geminiStatus: $('gemini-status'),
      inputMinSearches: $('input-min-searches'),
      inputMaxCompetition: $('input-max-competition'),
      inputDelayBetweenPages: $('input-delay-between-pages'),
      inputMaxShopReviews: $('input-max-shop-reviews'),
      inputMinBeatableSlots: $('input-min-beatable-slots'),
      inputWebhookUrl: $('input-webhook-url'),
      btnSaveSettings: $('btn-save-settings'),
      settingsSaved: $('settings-saved'),

      // Triage alert
      triageAlert: $('triage-alert'),
      triageAlertDesc: $('triage-alert-desc'),

      // Pipeline UI
      stepFindKeyword: $('step-find-keyword'),
      stepSnapshot: $('step-snapshot'),
      stepListingAudit: $('step-listing-audit'),
      stepFinalReport: $('step-final-report'),
      
      connFindKeyword: $('conn-find-keyword'),
      connSnapshot: $('conn-snapshot'),
      connListingAudit: $('conn-listing-audit'),
      
      progressStepName: $('progress-step-name'),
      progressDetails: $('progress-details')
    };
  }

  // ─── Initialization ──────────────────────────────────────────────────────
  async function init() {
    initDomReferences();
    initHandlers();
    await loadSettings();
    startPollingState();
  }

  // ─── Event Handlers ──────────────────────────────────────────────────────
  function initHandlers() {
    dom.btnOpenDashboard.addEventListener('click', openDashboard);
    dom.btnSaveSettings.addEventListener('click', saveSettings);
    dom.btnStartPipeline.addEventListener('click', startPipeline);
    dom.btnStopPipeline.addEventListener('click', stopPipeline);
  }

  // ─── Open Dashboard ──────────────────────────────────────────────────────
  function openDashboard() {
    const dashboardUrl = chrome.runtime.getURL('src/dashboard/dashboard.html');
    chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
      if (tabs.length > 0) {
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { drawAttention: true, focused: true });
      } else {
        chrome.tabs.create({ url: dashboardUrl });
      }
      window.close();
    });
  }

  // ─── Load Settings ───────────────────────────────────────────────────────
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get('config', (result) => {
        const config = result.config || {};

        if (config.gemini_api_key) {
          dom.inputGeminiKey.value = config.gemini_api_key;
          dom.geminiStatus.textContent = '✓ Key saved';
          dom.geminiStatus.className = 'key-status active';
        } else {
          dom.inputGeminiKey.value = '';
          dom.geminiStatus.textContent = 'Not configured';
          dom.geminiStatus.className = 'key-status';
        }

        dom.inputMinSearches.value = config.min_monthly_searches !== undefined ? config.min_monthly_searches : 500;
        dom.inputMaxCompetition.value = config.max_competition !== undefined ? config.max_competition : 25000;
        dom.inputDelayBetweenPages.value = config.delay_between_pages !== undefined ? config.delay_between_pages : 5;
        dom.inputMaxShopReviews.value = config.max_shop_reviews_beatable !== undefined ? config.max_shop_reviews_beatable : 300;
        dom.inputMinBeatableSlots.value = config.min_beatable_slots !== undefined ? config.min_beatable_slots : 3;
        dom.inputWebhookUrl.value = config.webhook_url || '';

        resolve();
      });
    });
  }

  // ─── Save Settings ───────────────────────────────────────────────────────
  function saveSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get('config', (result) => {
        const config = result.config || {};

        const geminiKey = dom.inputGeminiKey.value.trim();
        const minSearches = parseInt(dom.inputMinSearches.value);
        const maxComp = parseInt(dom.inputMaxCompetition.value);
        const delayPages = parseInt(dom.inputDelayBetweenPages.value);
        const maxReviews = parseInt(dom.inputMaxShopReviews.value);
        const minSlots = parseInt(dom.inputMinBeatableSlots.value);
        const webhookUrl = dom.inputWebhookUrl.value.trim();

        config.gemini_api_key = geminiKey;
        config.min_monthly_searches = isNaN(minSearches) ? 500 : minSearches;
        config.max_competition = isNaN(maxComp) ? 25000 : maxComp;
        config.delay_between_pages = isNaN(delayPages) ? 5 : delayPages;
        config.max_shop_reviews_beatable = isNaN(maxReviews) ? 300 : maxReviews;
        config.min_beatable_slots = isNaN(minSlots) ? 3 : minSlots;
        config.webhook_url = webhookUrl;

        if (geminiKey) {
          config.ai_provider = 'gemini';
        } else {
          config.ai_provider = 'none';
        }

        chrome.storage.local.set({ config }, () => {
          dom.geminiStatus.textContent = geminiKey ? '✓ Key saved' : 'Not configured';
          dom.geminiStatus.className = geminiKey ? 'key-status active' : 'key-status';

          dom.settingsSaved.style.display = 'inline-block';
          setTimeout(() => {
            dom.settingsSaved.style.display = 'none';
          }, 2500);
          resolve();
        });
      });
    });
  }

  // ─── Start Pipeline ──────────────────────────────────────────────────────
  async function startPipeline() {
    const keyword = dom.inputKeyword.value.trim();
    if (!keyword) {
      dom.inputKeyword.focus();
      return;
    }

    // Save settings first to ensure background script reads fresh options
    await saveSettings();

    const options = {
      gemini_api_key: dom.inputGeminiKey.value.trim(),
      min_monthly_searches: parseInt(dom.inputMinSearches.value) || 500,
      max_competition: parseInt(dom.inputMaxCompetition.value) || 25000,
      delay_between_pages: parseInt(dom.inputDelayBetweenPages.value) || 5,
      max_shop_reviews_beatable: parseInt(dom.inputMaxShopReviews.value) || 300,
      min_beatable_slots: parseInt(dom.inputMinBeatableSlots.value) || 3,
      webhook_url: dom.inputWebhookUrl.value.trim()
    };

    chrome.runtime.sendMessage({
      action: 'startPipeline',
      seedKeyword: keyword,
      mode: 'full',
      options: options
    }, (response) => {
      if (chrome.runtime.lastError) {
        console.error('[ERP] Failed to start pipeline:', chrome.runtime.lastError.message);
        return;
      }
      if (response && response.started) {
        console.log('[ERP] Pipeline started successfully');
        dom.btnStartPipeline.disabled = true;
        dom.btnStopPipeline.disabled = false;
        dom.inputKeyword.disabled = true;
      } else {
        console.warn('[ERP] Pipeline start rejected:', response?.reason);
      }
    });
  }

  // ─── Stop Pipeline ───────────────────────────────────────────────────────
  function stopPipeline() {
    dom.btnStopPipeline.disabled = true;
    chrome.runtime.sendMessage({ action: 'stopPipeline' }, (response) => {
      if (response && response.stopped) {
        console.log('[ERP] Pipeline stopped successfully');
        dom.btnStartPipeline.disabled = false;
        dom.inputKeyword.disabled = false;
      }
    });
  }

  // ─── State Polling ────────────────────────────────────────────────────────
  function startPollingState() {
    pollState();
    pollInterval = setInterval(pollState, 1000);
  }

  function pollState() {
    chrome.runtime.sendMessage({ action: 'getState' }, (state) => {
      if (chrome.runtime.lastError) {
        console.warn('[ERP] Failed to fetch state:', chrome.runtime.lastError.message);
        return;
      }

      if (!state) return;

      // Update keyword input if running
      if (state.running) {
        dom.btnStartPipeline.disabled = true;
        dom.btnStopPipeline.disabled = false;
        dom.inputKeyword.disabled = true;
        if (state.keyword && !dom.inputKeyword.value) {
          dom.inputKeyword.value = state.keyword;
        }
      } else {
        dom.btnStartPipeline.disabled = false;
        dom.btnStopPipeline.disabled = true;
        dom.inputKeyword.disabled = false;
      }

      // Update text progress logs
      dom.progressStepName.textContent = state.currentStep || (state.running ? 'Running...' : 'Idle');
      dom.progressDetails.textContent = state.progress || (state.running ? '' : 'Enter seed keyword and click Start Research');

      // Update layout triage warning box
      if (state.layoutFixNotification) {
        dom.triageAlertDesc.textContent = state.layoutFixNotification;
        dom.triageAlert.style.display = 'block';
      } else {
        dom.triageAlert.style.display = 'none';
      }

      // Update step visual elements
      const steps = state.steps || {
        find_keyword: 'pending',
        snapshot: 'pending',
        listing_audit: 'pending',
        final_report: 'pending'
      };

      updateStepUI(dom.stepFindKeyword, steps.find_keyword, '1');
      updateStepUI(dom.stepSnapshot, steps.snapshot, '2');
      updateStepUI(dom.stepListingAudit, steps.listing_audit, '3');
      updateStepUI(dom.stepFinalReport, steps.final_report, '4');

      // Connectors
      updateConnectorUI(dom.connFindKeyword, steps.find_keyword, steps.snapshot);
      updateConnectorUI(dom.connSnapshot, steps.snapshot, steps.listing_audit);
      updateConnectorUI(dom.connListingAudit, steps.listing_audit, steps.final_report);
    });
  }

  function updateStepUI(element, status, defaultText) {
    if (!element) return;
    element.className = `pipeline-step ${status || 'pending'}`;
    const indicator = element.querySelector('.step-indicator');
    if (indicator) {
      if (status === 'success') {
        indicator.textContent = '✓';
      } else if (status === 'failed') {
        indicator.textContent = '✗';
      } else if (status === 'skipped') {
        indicator.textContent = '—';
      } else if (status === 'running') {
        indicator.textContent = '●';
      } else {
        indicator.textContent = defaultText;
      }
    }
  }

  function updateConnectorUI(connector, prevStepStatus, nextStepStatus) {
    if (!connector) return;
    connector.className = 'pipeline-connector';
    if (prevStepStatus === 'success' || prevStepStatus === 'skipped') {
      if (nextStepStatus === 'running' || nextStepStatus === 'success' || nextStepStatus === 'skipped') {
        connector.classList.add('success');
      } else {
        connector.classList.add('active');
      }
    } else if (prevStepStatus === 'running') {
      connector.classList.add('active');
    }
  }

  // Cleanup on unload
  window.addEventListener('unload', () => {
    if (pollInterval) clearInterval(pollInterval);
  });

  // Start controller
  document.addEventListener('DOMContentLoaded', init);
})();
