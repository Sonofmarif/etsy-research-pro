// Etsy Research Pro — Background Telemetry Handler
// Manages remote error reporting and logging, ensuring strict privacy compliance.

import { loadConfig, loadRunState } from '../utils/config.js';

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

/**
 * Dispatches an error report to the telemetry server if telemetry is enabled.
 */
export async function sendTelemetryError(errorMessage, stackTrace, url) {
  try {
    const config = await loadConfig();
    if (!config.share_telemetry) {
      return;
    }
    const baseUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
    const telemetryUrl = `${baseUrl}/api/logs/telemetry`;
    
    const cleanMessage = sanitizeErrorMessage(errorMessage);
    const cleanStack = extractStackTraceLocation(stackTrace);
    const version = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '1.1.0';

    const response = await fetch(telemetryUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error_message: cleanMessage,
        stack_trace: cleanStack,
        url: 'Chrome Extension Background',
        user_agent: 'Etsy Research Pro Extension',
        version: version
      })
    });
    if (!response.ok) {
      console.warn('[ERP Telemetry] Worker telemetry post returned status:', response.status);
    }
  } catch (e) {
    console.error('[ERP Telemetry] Failed to send telemetry error:', e.message);
  }
}

/**
 * Flushes pipeline execution error logs to the remote worker.
 */
export async function flushLogsToServer(seedKeyword, step) {
  try {
    const config = await loadConfig();
    if (!config.share_telemetry) {
      return;
    }
    const state = await loadRunState();
    const logs = state.logs || [];
    if (logs.length === 0) return;

    const errorLogs = logs.filter(l => l.type === 'error');
    if (errorLogs.length > 0) {
      const baseUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
      const sanitizedLogs = errorLogs.map(l => ({
        type: l.type,
        time: l.time,
        msg: sanitizeErrorMessage(l.msg)
      }));
      const version = chrome.runtime.getManifest ? chrome.runtime.getManifest().version : '1.1.0';

      await fetch(`${baseUrl}/report-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error_message: `Pipeline Fail: ${step}`,
          stack_trace: JSON.stringify(sanitizedLogs),
          url: 'Chrome Extension Pipeline',
          user_agent: 'Etsy Research Pro Extension',
          version: version
        })
      });
    }
  } catch (e) {
    console.error('[ERP] flushLogsToServer failed:', e);
  }
}
