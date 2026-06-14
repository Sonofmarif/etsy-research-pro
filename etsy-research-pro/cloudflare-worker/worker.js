// Etsy Research Pro — Cloudflare Worker Backend (v1.1.1 Production)
// Endpoints: /health, /seeds, /save-run, /trending, /trending-niches, /check-cache, /report-error

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // ─── CORS ───
    const origin = request.headers.get('Origin') || '';
    const isAllowed = origin.startsWith('chrome-extension://') || origin === '';

    const corsHeaders = {
      'Access-Control-Allow-Origin': isAllowed ? origin : '',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // ─── Routes ───
      if (path === '/health') {
        return json({ status: 'ok', version: '1.1.0' }, corsHeaders);
      }

      if (path === '/seeds' && request.method === 'GET') {
        return handleGetSeeds(url, env, corsHeaders);
      }

      if (path === '/save-run' && request.method === 'POST') {
        return handleSaveRun(request, env, corsHeaders);
      }

      if (path === '/trending' && request.method === 'GET') {
        return handleGetTrending(url, env, corsHeaders);
      }

      if (path === '/trending-niches' && request.method === 'GET') {
        return handleGetTrendingNiches(url, env, corsHeaders);
      }

      if (path === '/check-cache' && request.method === 'GET') {
        return handleCheckCache(url, env, corsHeaders);
      }

      if (path === '/report-error' && request.method === 'POST') {
        return handleReportError(request, env, corsHeaders);
      }

      if (path === '/api/logs/telemetry' && request.method === 'POST') {
        return handleTelemetry(request, env, corsHeaders);
      }

      if (path === '/api/debug/patch' && request.method === 'POST') {
        return handleDebugPatch(request, env, corsHeaders);
      }

      if (path === '/api/telemetry/report' && request.method === 'POST') {
        return handleTelemetryReport(request, env, corsHeaders);
      }

      if (path === '/api/feedback/submit' && request.method === 'POST') {
        return handleFeedbackSubmit(request, env, corsHeaders);
      }

      return json({ error: 'Not found' }, corsHeaders, 404);

    } catch (err) {
      console.error('[Worker Exception] Endpoint error:', err);
      
      // POST telemetry to /api/logs/telemetry
      try {
        const telemetryUrl = new URL('/api/logs/telemetry', request.url).toString();
        await fetch(telemetryUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            error_message: `Server-Side Exception: ${err.message}`,
            stack_trace: err.stack || '',
            url: request.url,
            user_agent: 'Cloudflare Worker Telemetry Sync'
          })
        });
      } catch (postErr) {
        console.error('[Worker Telemetry] Loopback POST failed:', postErr.message);
        try {
          await env.DB.prepare(
            'INSERT INTO error_logs (error_message, stack_trace, url, user_agent) VALUES (?, ?, ?, ?)'
          ).bind(
            `Server-Side Exception (Direct DB fallback): ${err.message}`,
            err.stack || '',
            request.url,
            'Cloudflare Worker Direct Logging'
          ).run();
        } catch (dbErr) {
          console.error('[Worker Telemetry] Direct DB fallback failed:', dbErr.message);
        }
      }

      return json({ error: 'Internal server error', message: err.message }, corsHeaders, 500);
    }
  }
};

// ─── GET /check-cache?keyword=... (SaaS Cache-First Approach) ───────────────
async function handleCheckCache(url, env, cors) {
  const keyword = sanitize(url.searchParams.get('keyword') || '').toLowerCase().trim();
  if (!keyword) {
    return json({ error: 'Keyword required' }, cors, 400);
  }

  const cacheKey = `niche:keyword:${keyword}`;
  if (env.NICHE_CACHE) {
    try {
      const cached = await env.NICHE_CACHE.get(cacheKey);
      if (cached) {
        const payload = JSON.parse(cached);
        const cacheAgeMs = Date.now() - (payload.timestamp || 0);
        const maxAgeMs = 90 * 24 * 60 * 60 * 1000; // 90 days

        if (cacheAgeMs < maxAgeMs) {
          return json({ cached: true, data: payload.data }, cors);
        }
      }
    } catch (e) {
      console.warn('[Worker] KV NICHE_CACHE read failed:', e.message);
    }
  }

  return json({ cached: false }, cors);
}

// ─── GET /seeds?category=... (with KV Cache) ────────────────────────────────
async function handleGetSeeds(url, env, cors) {
  const category = url.searchParams.get('category') || '';
  const cacheKey = category ? `seeds:category:${category}` : 'seeds:categories';

  // Check KV cache first
  if (env.NICHE_CACHE) {
    try {
      const cached = await env.NICHE_CACHE.get(cacheKey);
      if (cached) {
        return json(JSON.parse(cached), cors);
      }
    } catch (e) {
      console.warn('[Worker] KV NICHE_CACHE seeds read failed:', e.message);
    }
  }

  let payload;
  if (!category) {
    const result = await env.DB.prepare(
      'SELECT DISTINCT category FROM seed_keywords WHERE active = 1 ORDER BY category'
    ).all();
    payload = { categories: result.results.map(r => r.category) };
  } else {
    const result = await env.DB.prepare(
      'SELECT keyword, priority FROM seed_keywords WHERE category = ? AND active = 1 ORDER BY priority DESC LIMIT 20'
    ).bind(sanitize(category)).all();
    payload = { category, keywords: result.results };
  }

  // Update KV cache (1 hour expiration)
  if (env.NICHE_CACHE) {
    try {
      await env.NICHE_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 3600 });
    } catch (e) {
      console.warn('[Worker] KV NICHE_CACHE seeds write failed:', e.message);
    }
  }

  return json(payload, cors);
}

// ─── POST /save-run (with Analytics Engine & Prompt Generator) ────────────────
async function handleSaveRun(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, cors, 400);
  }

  const keyword = sanitize(body.keyword || '').substring(0, 200);
  const productType = sanitize(body.product_type || 'any').substring(0, 20);
  const winScore = Math.max(0, Math.min(100, parseInt(body.win_score) || 0));
  const total = Math.max(0, Math.min(1000, parseInt(body.total) || 0));
  const wins = Math.max(0, Math.min(1000, parseInt(body.wins) || 0));
  const beatable = Math.max(0, Math.min(12, parseInt(body.beatable) || 0));
  const avgPrice = Math.max(0, Math.min(99999, parseFloat(body.avg_price) || 0));
  const aiMode = sanitize(body.ai_mode || 'math').substring(0, 20);

  if (!keyword) {
    return json({ error: 'Keyword required' }, cors, 400);
  }

  // 1. Save anonymous run to D1
  await env.DB.prepare(
    'INSERT INTO research_runs (keyword, product_type, win_score, total, wins, beatable, avg_price, ai_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(keyword, productType, winScore, total, wins, beatable, avgPrice, aiMode).run();

  // 1b. Save snapshot payload to D1
  const avgReviews = Math.max(0, parseInt(body.average_reviews || body.avg_reviews) || 0);
  const snapshotPayload = JSON.stringify({
    total_listings: total,
    average_reviews: avgReviews,
    beatable_slots_found: beatable,
    searched_keyword: keyword,
    timestamp: new Date().toISOString()
  });

  try {
    await env.DB.prepare(
      'INSERT INTO research_snapshots (keyword, payload) VALUES (?, ?)'
    ).bind(keyword, snapshotPayload).run();
  } catch (snapshotErr) {
    console.warn('[Worker] D1 snapshot save failed:', snapshotErr.message);
  }

  // 2. Update trending table in D1
  const existing = await env.DB.prepare(
    'SELECT * FROM trending_niches WHERE keyword = ?'
  ).bind(keyword).first();

  if (existing) {
    const newCount = existing.run_count + 1;
    const newAvg = ((existing.avg_score * existing.run_count) + winScore) / newCount;
    const trend = winScore > existing.last_score + 5 ? 'up' :
                  winScore < existing.last_score - 5 ? 'down' : 'stable';

    await env.DB.prepare(
      'UPDATE trending_niches SET run_count = ?, avg_score = ?, last_score = ?, trend = ?, last_updated = datetime("now") WHERE keyword = ?'
    ).bind(newCount, Math.round(newAvg * 10) / 10, winScore, trend, keyword).run();
  } else {
    await env.DB.prepare(
      'INSERT INTO trending_niches (keyword, run_count, avg_score, last_score, trend) VALUES (?, 1, ?, ?, "stable")'
    ).bind(keyword, winScore, winScore).run();
  }

  // 3. Save clusters to shared_niches table in D1
  if (body.clusters && Array.isArray(body.clusters)) {
    for (const c of body.clusters) {
      const nicheKeyword = sanitize(c.niche || '').substring(0, 200);
      const nicheScore = Math.max(0, Math.min(100, parseInt(c.win_score) || 0));
      const demandScore = Math.max(0, Math.min(100, parseInt(c.demand_score) || 0));
      const compScore = Math.max(0, Math.min(100, parseInt(c.competition_score) || 0));
      const imagePrompt = sanitize(c.image_prompt || '');

      if (nicheKeyword) {
        try {
          await env.DB.prepare(
            `INSERT INTO shared_niches (keyword, category, niche_score, demand_score, competition_score, image_prompt) 
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(keyword) DO UPDATE SET 
               niche_score = excluded.niche_score,
               demand_score = excluded.demand_score,
               competition_score = excluded.competition_score,
               image_prompt = excluded.image_prompt,
               created_at = datetime('now')`
          ).bind(nicheKeyword, productType, nicheScore, demandScore, compScore, imagePrompt).run();
        } catch (e) {
          console.warn('[Worker] D1 shared_niches save failed:', e.message);
        }
      }
    }
  }

  // 4. Log query to Cloudflare Analytics Engine (No D1 database hits)
  if (env.ANALYTICS) {
    try {
      env.ANALYTICS.writeDataPoint({
        blobs: [keyword, productType, aiMode],
        doubles: [winScore, total, wins],
        indexes: [keyword]
      });
    } catch (err) {
      console.error('[Worker] Analytics Engine logging failed:', err.message);
    }
  }

  // 5. Invalidate KV caches for trending endpoints and this keyword
  if (env.NICHE_CACHE) {
    try {
      await env.NICHE_CACHE.delete('trending:limit:10').catch(() => {});
      await env.NICHE_CACHE.delete('trending:limit:20').catch(() => {});
      await env.NICHE_CACHE.delete('trending:limit:50').catch(() => {});
      await env.NICHE_CACHE.delete('trending_niches:limit:10').catch(() => {});
      await env.NICHE_CACHE.delete('trending_niches:limit:20').catch(() => {});
      await env.NICHE_CACHE.delete('trending_niches:limit:50').catch(() => {});
      await env.NICHE_CACHE.delete(`niche:keyword:${keyword.toLowerCase().trim()}`).catch(() => {});
    } catch (e) {
      console.warn('[Worker] KV cache invalidation failed:', e.message);
    }
  }

  // 6. Cache search results in NICHE_CACHE (90-day expiration TTL = 7776000 seconds)
  if (env.NICHE_CACHE) {
    try {
      const cacheKey = `niche:keyword:${keyword.toLowerCase().trim()}`;
      const cachePayload = {
        timestamp: Date.now(),
        data: {
          keyword,
          product_type: productType,
          stats: {
            total,
            wins,
            avg_win_score: winScore,
            beatable_slots: beatable,
            avg_price: avgPrice,
            ai_mode: aiMode
          },
          clusters: body.clusters || []
        }
      };
      await env.NICHE_CACHE.put(cacheKey, JSON.stringify(cachePayload), { expirationTtl: 90 * 24 * 60 * 60 });
    } catch (e) {
      console.warn('[Worker] KV NICHE_CACHE write failed:', e.message);
    }
  }

  // 7. Generate high-converting AI Image Prompt (Prompt Generation Engine Fallback)
  const imagePrompt = generateAiImagePrompt(keyword, winScore);

  return json({ success: true, image_prompt: imagePrompt }, cors);
}

// ─── GET /trending?limit=... (with KV Cache) ────────────────────────────────
async function handleGetTrending(url, env, cors) {
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit')) || 20));
  const cacheKey = `trending:limit:${limit}`;

  // Check KV cache first
  if (env.NICHE_CACHE) {
    try {
      const cached = await env.NICHE_CACHE.get(cacheKey);
      if (cached) {
        return json(JSON.parse(cached), cors);
      }
    } catch (e) {
      console.warn('[Worker] KV NICHE_CACHE trending read failed:', e.message);
    }
  }

  const result = await env.DB.prepare(
    'SELECT keyword, run_count, avg_score, last_score, trend, last_updated FROM trending_niches ORDER BY run_count DESC, avg_score DESC LIMIT ?'
  ).bind(limit).all();

  const payload = { trending: result.results };

  // Update KV cache (5 minutes expiration)
  if (env.NICHE_CACHE) {
    try {
      await env.NICHE_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
    } catch (e) {
      console.warn('[Worker] KV NICHE_CACHE trending write failed:', e.message);
    }
  }

  return json(payload, cors);
}

// ─── GET /trending-niches?limit=... (From D1 shared_niches) ──────────────────
async function handleGetTrendingNiches(url, env, cors) {
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit')) || 20));
  const cacheKey = `trending_niches:limit:${limit}`;

  // Check KV cache first
  if (env.NICHE_CACHE) {
    try {
      const cached = await env.NICHE_CACHE.get(cacheKey);
      if (cached) {
        return json(JSON.parse(cached), cors);
      }
    } catch (e) {
      console.warn('[Worker] KV NICHE_CACHE trending_niches read failed:', e.message);
    }
  }

  const result = await env.DB.prepare(
    'SELECT keyword, category, niche_score, demand_score, competition_score, image_prompt, created_at FROM shared_niches ORDER BY niche_score DESC LIMIT ?'
  ).bind(limit).all();

  const payload = { niches: result.results };

  // Update KV cache (5 minutes expiration)
  if (env.NICHE_CACHE) {
    try {
      await env.NICHE_CACHE.put(cacheKey, JSON.stringify(payload), { expirationTtl: 300 });
    } catch (e) {
      console.warn('[Worker] KV NICHE_CACHE trending_niches write failed:', e.message);
    }
  }

  return json(payload, cors);
}

// ─── POST /report-error ──────────────────────────────────────────────────────
async function handleReportError(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, cors, 400);
  }

  const errorMessage = sanitize(body.error_message || '').substring(0, 1000);
  const stackTrace = sanitize(body.stack_trace || '').substring(0, 4000);
  const pageUrl = sanitize(body.url || '').substring(0, 500);
  const userAgent = sanitize(body.user_agent || '').substring(0, 500);

  if (!errorMessage) {
    return json({ error: 'Error message required' }, cors, 400);
  }

  await env.DB.prepare(
    'INSERT INTO error_logs (error_message, stack_trace, url, user_agent) VALUES (?, ?, ?, ?)'
  ).bind(errorMessage, stackTrace, pageUrl, userAgent).run();

  return json({ success: true }, cors);
}

// ─── POST /api/logs/telemetry ────────────────────────────────────────────────
async function handleTelemetry(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, cors, 400);
  }

  const errorMessage = sanitize(body.error_message || '').substring(0, 1000);
  const stackTrace = sanitize(body.stack_trace || '').substring(0, 4000);
  const pageUrl = sanitize(body.url || '').substring(0, 500);
  const userAgent = sanitize(body.user_agent || '').substring(0, 500);

  if (!errorMessage) {
    return json({ error: 'Error message required' }, cors, 400);
  }

  try {
    await env.DB.prepare(
      'INSERT INTO error_logs (error_message, stack_trace, url, user_agent) VALUES (?, ?, ?, ?)'
    ).bind(errorMessage, stackTrace, pageUrl, userAgent).run();
  } catch (err) {
    console.error('[Worker Telemetry] DB sync fail:', err.message);
    return json({ error: 'Database sync failed', message: err.message }, cors, 500);
  }

  return json({ success: true }, cors);
}

// ─── POST /api/debug/patch ───────────────────────────────────────────────────
async function handleDebugPatch(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, cors, 400);
  }

  const errorType = sanitize(body.error_type || 'UnknownError').substring(0, 255);
  const errorMessage = sanitize(body.error_message || '').substring(0, 1000);
  const domSnippet = sanitize(body.dom_snippet || '').substring(0, 4000);
  const pageUrl = sanitize(body.url || '').substring(0, 500);

  const fullErrorMessage = `[Selector Failure] ${errorType}: ${errorMessage}`;
  try {
    await env.DB.prepare(
      'INSERT INTO error_logs (error_message, stack_trace, url, user_agent) VALUES (?, ?, ?, ?)'
    ).bind(fullErrorMessage, domSnippet, pageUrl, 'Self-Healing Selector Patch Engine').run();
  } catch (err) {
    console.error('[Worker DebugPatch] DB sync fail:', err.message);
    return json({ error: 'Database sync failed', message: err.message }, cors, 500);
  }

  return json({ success: true, patch_applied: false }, cors);
}

// ─── Prompt Generation Engine helper function (Fallback) ───────────────────
function generateAiImagePrompt(keyword, winScore) {
  const cleanKeyword = sanitize(keyword);
  let prompt = '';
  if (winScore >= 70) {
    prompt = `Professional commercial product photography of ${cleanKeyword}, high-end design, perfect studio lighting, soft shadows, sharp focus, hyperrealistic textures, clean white background, trending on Etsy, award-winning Etsy design --ar 4:3 --v 6.0`;
  } else if (winScore >= 50) {
    prompt = `Clean minimalist style product view of ${cleanKeyword}, cozy modern background, warm volumetric lighting, realistic details, high resolution, aesthetic Etsy store display --ar 1:1`;
  } else {
    prompt = `Simple product display of ${cleanKeyword}, neutral aesthetic background, bright even lighting, commercial layout --ar 1:1`;
  }
  return prompt;
}

async function handleTelemetryReport(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, cors, 400);
  }

  const errorMessage = sanitize(body.error_message || '').substring(0, 1000);
  const stackTrace = sanitize(body.stack_trace || '').substring(0, 4000);
  const pageUrl = sanitize(body.url || '').substring(0, 500);
  const userAgent = sanitize(body.user_agent || '').substring(0, 500);

  if (!errorMessage) {
    return json({ error: 'Error message required' }, cors, 400);
  }

  const formattedMsg = `[Client Telemetry] ${errorMessage}`;
  try {
    await env.DB.prepare(
      'INSERT INTO error_logs (error_message, stack_trace, url, user_agent) VALUES (?, ?, ?, ?)'
    ).bind(formattedMsg, stackTrace, pageUrl, userAgent).run();
  } catch (err) {
    console.error('[Worker TelemetryReport] DB sync fail:', err.message);
    return json({ error: 'Database sync failed', message: err.message }, cors, 500);
  }

  return json({ success: true }, cors);
}

async function handleFeedbackSubmit(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, cors, 400);
  }

  const seedId = sanitize(body.seed_id || 'None').substring(0, 255);
  const feedback = sanitize(body.feedback || '').substring(0, 4000);
  const pageUrl = sanitize(body.url || '').substring(0, 500);
  const userAgent = sanitize(body.user_agent || '').substring(0, 500);

  if (!feedback) {
    return json({ error: 'Feedback message required' }, cors, 400);
  }

  const msg = `[User Feedback] Seed ID: ${seedId}`;
  try {
    await env.DB.prepare(
      'INSERT INTO error_logs (error_message, stack_trace, url, user_agent) VALUES (?, ?, ?, ?)'
    ).bind(msg, feedback, pageUrl, userAgent).run();
  } catch (err) {
    console.error('[Worker Feedback] DB sync fail:', err.message);
    return json({ error: 'Database sync failed', message: err.message }, cors, 500);
  }

  return json({ success: true }, cors);
}

// ─── Helpers ──────────────────────────────────────────────────────────────
function json(data, corsHeaders, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

function sanitize(str) {
  if (!str) return '';
  return String(str).replace(/[<>'"`;]/g, '').trim();
}

