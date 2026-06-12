// Etsy Research Pro — Extension Popup Controller
// Sleek, compact UI managing core extension options and launching the dashboard.

(function () {
  'use strict';

  // ─── DOM References ─────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  let dom = {};

  function initDomReferences() {
    dom = {
      inputGeminiKey: $('input-gemini-key'),
      geminiStatus: $('gemini-status'),
      inputMinSearches: $('input-min-searches'),
      inputMaxCompetition: $('input-max-competition'),
      btnOpenDashboard: $('btn-open-dashboard'),
      btnSaveSettings: $('btn-save-settings'),
      settingsSaved: $('settings-saved')
    };
  }

  // ─── Initialization ──────────────────────────────────────────────────────
  async function init() {
    initDomReferences();
    initHandlers();
    await loadSettings();
  }

  // ─── Event Handlers ──────────────────────────────────────────────────────
  function initHandlers() {
    // Open Dashboard Button
    dom.btnOpenDashboard.addEventListener('click', openDashboard);

    // Save Settings Button
    dom.btnSaveSettings.addEventListener('click', saveSettings);
  }

  // ─── Open Dashboard ──────────────────────────────────────────────────────
  function openDashboard() {
    const dashboardUrl = chrome.runtime.getURL('src/dashboard/dashboard.html');
    chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
      if (tabs.length > 0) {
        // Focus existing dashboard tab
        chrome.tabs.update(tabs[0].id, { active: true });
        chrome.windows.update(tabs[0].windowId, { drawAttention: true, focused: true });
      } else {
        // Open new dashboard tab
        chrome.tabs.create({ url: dashboardUrl });
      }
      window.close(); // Close the popup UI
    });
  }

  // ─── Load Settings ───────────────────────────────────────────────────────
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get('config', (result) => {
        const config = result.config || {};

        // Gemini Key
        if (config.gemini_api_key) {
          dom.inputGeminiKey.value = config.gemini_api_key;
          dom.geminiStatus.textContent = '✓ Key saved';
          dom.geminiStatus.className = 'key-status active';
        } else {
          dom.inputGeminiKey.value = '';
          dom.geminiStatus.textContent = 'Not configured';
          dom.geminiStatus.className = 'key-status';
        }

        // Threshold values
        dom.inputMinSearches.value = config.min_monthly_searches !== undefined ? config.min_monthly_searches : 500;
        dom.inputMaxCompetition.value = config.max_competition !== undefined ? config.max_competition : 25000;

        resolve();
      });
    });
  }

  // ─── Save Settings ───────────────────────────────────────────────────────
  function saveSettings() {
    chrome.storage.local.get('config', (result) => {
      const config = result.config || {};

      const geminiKey = dom.inputGeminiKey.value.trim();
      const minSearches = parseInt(dom.inputMinSearches.value);
      const maxComp = parseInt(dom.inputMaxCompetition.value);

      // Store settings
      config.gemini_api_key = geminiKey;
      config.min_monthly_searches = isNaN(minSearches) ? 500 : minSearches;
      config.max_competition = isNaN(maxComp) ? 25000 : maxComp;

      // Update AI provider setting based on entered keys
      if (geminiKey) {
        config.ai_provider = 'gemini';
      } else if (config.groq_api_key) {
        config.ai_provider = 'groq';
      } else {
        config.ai_provider = 'none';
      }

      chrome.storage.local.set({ config }, () => {
        // Update key status indicators
        dom.geminiStatus.textContent = geminiKey ? '✓ Key saved' : 'Not configured';
        dom.geminiStatus.className = geminiKey ? 'key-status active' : 'key-status';

        // Display flash success message
        dom.settingsSaved.style.display = 'inline-block';
        setTimeout(() => {
          dom.settingsSaved.style.display = 'none';
        }, 2500);
      });
    });
  }

  // Start controller
  document.addEventListener('DOMContentLoaded', init);
})();
