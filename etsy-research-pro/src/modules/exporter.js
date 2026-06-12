// Exporter — CSV + JSON download for research results

// ─── Export as CSV ────────────────────────────────────────────────────────
export function exportCSV(keyword, listings, clusters, stats) {
  const lines = [];

  // Header row
  lines.push('# Etsy Research Pro — Export');
  lines.push(`# Keyword: ${keyword}`);
  lines.push(`# Date: ${new Date().toISOString()}`);
  lines.push(`# Total Listings: ${stats?.total || listings.length}`);
  lines.push(`# Wins: ${stats?.wins || 0}`);
  lines.push(`# Average Win Score: ${stats?.avg_win_score || 0}`);
  lines.push('');

  // Cluster summary
  if (clusters && clusters.length > 0) {
    lines.push('# --- NICHE CLUSTERS ---');
    lines.push('Niche,Product Type,Win Score,Verdict,Opportunity,Target Buyer,Price Range,Image Prompt');
    clusters.forEach(c => {
      lines.push([
        csvEscape(c.niche || ''),
        csvEscape(c.product_type || ''),
        c.win_score || 0,
        csvEscape(c.verdict || ''),
        csvEscape(c.opportunity || ''),
        csvEscape(c.target_buyer || ''),
        csvEscape(c.price_recommendation || ''),
        csvEscape(c.image_prompt || '')
      ].join(','));
    });
    lines.push('');
  }

  // Listings
  lines.push('# --- LISTINGS ---');
  lines.push('Position,Title,Price,Shop Name,Shop Reviews,Bestseller,Popular Now,Urgency,Product Type,Win Score,Verdict,URL');
  listings.forEach(l => {
    const scores = l.scores || {};
    lines.push([
      l.search_position || '',
      csvEscape(l.title || ''),
      l.price || 0,
      csvEscape(l.shop_name || ''),
      l.shop_reviews || 0,
      l.is_bestseller ? 'Yes' : 'No',
      l.is_popular_now ? 'Yes' : 'No',
      csvEscape(l.urgency_text || ''),
      l.product_type || '',
      scores.win_score || 0,
      scores.verdict || '',
      l.etsy_url || ''
    ].join(','));
  });

  return lines.join('\n');
}

// ─── Export as JSON ───────────────────────────────────────────────────────
export function exportJSON(keyword, listings, clusters, stats) {
  return JSON.stringify({
    metadata: {
      tool: 'Etsy Research Pro',
      version: '1.0.0',
      keyword,
      date: new Date().toISOString(),
      ai_mode: stats?.ai_mode || 'unknown',
      source: stats?.source || 'etsy_only'
    },
    stats: {
      total_listings: stats?.total || listings.length,
      wins: stats?.wins || 0,
      avg_win_score: stats?.avg_win_score || 0,
      avg_price: stats?.avg_price || 0,
      beatable_slots: stats?.beatable_slots || 0
    },
    clusters: clusters || [],
    listings: listings.map(l => ({
      listing_id: l.listing_id,
      title: l.title,
      price: l.price,
      original_price: l.original_price,
      discount_pct: l.discount_pct,
      shop_name: l.shop_name,
      shop_reviews: l.shop_reviews,
      shop_rating: l.shop_rating,
      is_bestseller: l.is_bestseller,
      is_popular_now: l.is_popular_now,
      urgency_text: l.urgency_text,
      product_type: l.product_type,
      free_delivery: l.free_delivery,
      etsy_url: l.etsy_url,
      thumbnail_url: l.thumbnail_url,
      search_position: l.search_position,
      scores: l.scores || {},
      scraped_at: l.scraped_at
    }))
  }, null, 2);
}

// ─── Export SEO Audit ─────────────────────────────────────────────────────
export function exportAuditJSON(auditResult) {
  return JSON.stringify({
    metadata: {
      tool: 'Etsy Research Pro — SEO Audit',
      version: '1.0.0',
      date: new Date().toISOString(),
      ai_mode: auditResult.source || 'math'
    },
    listing_url: auditResult.listing_url || '',
    scores: {
      overall: auditResult.overall_score,
      title: auditResult.title_score,
      tags: auditResult.tags_score,
      description: auditResult.description_score
    },
    issues: auditResult.issues || [],
    fixes: auditResult.fixes || [],
    better_title: auditResult.better_title || '',
    better_tags: auditResult.better_tags || [],
    keyword_gaps: auditResult.keyword_gaps || [],
    price_analysis: auditResult.price_analysis || ''
  }, null, 2);
}

// ─── Trigger download ─────────────────────────────────────────────────────
export function downloadFile(content, filename, mimeType = 'text/csv') {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ─── Download research results ────────────────────────────────────────────
export function downloadCSV(keyword, listings, clusters, stats) {
  const csv = exportCSV(keyword, listings, clusters, stats);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = keyword.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
  downloadFile(csv, `etsy-research-${safeName}-${timestamp}.csv`, 'text/csv');
}

export function downloadJSON(keyword, listings, clusters, stats) {
  const json = exportJSON(keyword, listings, clusters, stats);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safeName = keyword.replace(/[^a-zA-Z0-9]/g, '-').substring(0, 30);
  downloadFile(json, `etsy-research-${safeName}-${timestamp}.json`, 'application/json');
}

// ─── CSV escape helper ────────────────────────────────────────────────────
function csvEscape(str) {
  if (!str) return '';
  str = String(str);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}
