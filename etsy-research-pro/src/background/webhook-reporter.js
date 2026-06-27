// Etsy Research Pro — Webhook Reporter
// Dispatches custom user-configured webhooks with report outcomes.

/**
 * Triggers a POST call to a user-configured webhook URL with the final results payload.
 */
export async function triggerWebhook(webhookUrl, payload, logFn) {
  if (!webhookUrl) return;
  try {
    logFn('info', `📡 Triggering webhook export to: ${webhookUrl}`);
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      logFn('success', '✓ Webhook export complete.');
    } else {
      logFn('warn', `Webhook returned status: ${response.status}`);
    }
  } catch (e) {
    logFn('error', `Failed to send webhook: ${e.message}`);
    // Non-blocking error: we throw or log, but we don't crash the pipeline
  }
}
