// Etsy Research Pro — Error Handler & Self-Healing Boundary

function catchError(error, context) {
  const errorMessage = error.message || String(error);
  const stackTrace = error.stack || '';
  console.error(`[Error Boundary] Critical failure in ${context}:`, error);

  // 1. Send error to central server telemetry endpoint
  sendTelemetryReportDirect(error, context);

  // 2. Trigger NotifyUser to notify dashboard
  NotifyUser(error, context);
}

function NotifyUser(error, context) {
  try {
    chrome.runtime.sendMessage({
      action: 'scraperError',
      error: error.message || String(error),
      context: context
    });
  } catch (e) {
    console.warn('[Error Boundary] Failed to send message to extension:', e.message);
  }
}

function sanitizeErrorMessage(msg) {
  if (!msg) return '';
  let sanitized = msg.replace(/https?:\/\/[^\s]+/g, (url) => {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch {
      return '[url]';
    }
  });
  sanitized = sanitized.replace(/\b\d{8,12}\b/g, '[id]');
  return sanitized;
}

function extractStackTraceLocation(stack) {
  if (!stack) return 'unknown';
  const lines = stack.split('\n');
  for (const line of lines) {
    if (line.includes('chrome-extension://') || line.includes('/src/')) {
      const match = line.match(/(\w+\-?\w*\.js:\d+:\d+)/);
      if (match) {
        return match[1];
      }
    }
  }
  return lines[0] || 'unknown';
}

async function sendTelemetryReportDirect(err, context) {
  try {
    const storageRes = await chrome.storage.local.get('config');
    const config = storageRes.config || {};
    if (!config.share_telemetry) {
      return;
    }
    const baseUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
    const reportUrl = `${baseUrl}/api/telemetry/report`;
    
    const cleanMessage = sanitizeErrorMessage(err.message || String(err));
    const cleanStack = extractStackTraceLocation(err.stack || '');
    let cleanUrl = 'background';
    if (typeof window !== 'undefined' && window.location) {
      try {
        const u = new URL(window.location.href);
        cleanUrl = u.origin + u.pathname;
      } catch (urlErr) {
        cleanUrl = 'window-location';
      }
    }

    await fetch(reportUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error_message: `[Error Boundary] ${context}: ${cleanMessage}`,
        stack_trace: `Context: ${context}\nLocation: ${cleanStack}`,
        url: cleanUrl,
        user_agent: 'Etsy Research Pro Extension'
      })
    });
  } catch (e) {
    console.warn('[Error Boundary] Telemetry direct report failed:', e.message);
  }
}

async function reportSelectorFailure(brokenSelector, parentNode, errorMessage = 'Element not found') {
  try {
    const storageRes = await chrome.storage.local.get('config');
    const config = storageRes.config || {};
    if (!config.share_telemetry) return;

    let targetUrl = 'unknown';
    try {
      targetUrl = window.location.href;
    } catch (e) {}

    let htmlHTML = '';
    try {
      htmlHTML = parentNode ? parentNode.outerHTML : (document.body ? document.body.outerHTML : '');
      if (htmlHTML.length > 5000) {
        htmlHTML = htmlHTML.substring(0, 5000) + '... [truncated]';
      }
    } catch (e) {}

    const payload = {
      brokenSelector: brokenSelector,
      targetUrl: targetUrl,
      htmlHTML: htmlHTML,
      error: errorMessage,
      timestamp: new Date().toISOString()
    };

    console.warn(`[Selectors] Selector failure captured: ${brokenSelector}`, payload);

    await fetch('https://YOUR_N8N_WEBHOOK_URL/error-receiver', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    console.warn('[Selectors] Failed to post telemetry for selector failure:', err.message);
  }
}

function resolveSelector(selectorPath) {
  if (!window.SELECTORS) return selectorPath;
  const keys = selectorPath.split('.');
  let current = window.SELECTORS;
  for (const k of keys) {
    if (current && current[k]) current = current[k];
    else return selectorPath; // fallback to string if not in registry
  }
  return current;
}

function safeQuery(parent, selectorPath, isRequired = true) {
  const actualSelector = resolveSelector(selectorPath);
  try {
    const el = parent.querySelector(actualSelector);
    if (!el && isRequired) {
      reportSelectorFailure(actualSelector, parent, `querySelector returned null for ${selectorPath}`);
    }
    return el;
  } catch (err) {
    if (isRequired) {
      reportSelectorFailure(actualSelector, parent, `querySelector threw error: ${err.message}`);
    }
    return null;
  }
}

function safeQueryAll(parent, selectorPath) {
  const actualSelector = resolveSelector(selectorPath);
  try {
    return parent.querySelectorAll(actualSelector);
  } catch (err) {
    reportSelectorFailure(actualSelector, parent, `querySelectorAll threw error: ${err.message}`);
    return [];
  }
}

// Support global scope for content scripts (non-module) and ESM export for background
if (typeof window !== 'undefined') {
  window.catchError = catchError;
  window.NotifyUser = NotifyUser;
  window.reportSelectorFailure = reportSelectorFailure;
  window.safeQuery = safeQuery;
  window.safeQueryAll = safeQueryAll;
}
if (typeof exports !== 'undefined') {
  exports.catchError = catchError;
  exports.NotifyUser = NotifyUser;
  exports.reportSelectorFailure = reportSelectorFailure;
  exports.safeQuery = safeQuery;
  exports.safeQueryAll = safeQueryAll;
}
