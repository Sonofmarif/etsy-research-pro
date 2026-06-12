// SEO Auditor — Listing SEO analysis
// Opens listing URL in background tab, scrapes data, runs AI audit

import { auditListing } from './ai-analyzer.js';

// ─── Run SEO Audit ────────────────────────────────────────────────────────
export async function runSeoAudit(listingUrl, onProgress) {
  const log = onProgress || (() => {});

  log('Opening listing page...');

  // Request scrape from content script via service worker
  const listingData = await new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { action: 'scrapeListing', url: listingUrl },
      response => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (response && response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response?.error || 'Failed to scrape listing'));
        }
      }
    );
  });

  log('Analyzing SEO...');

  // Run math-based checks first (always available)
  const mathAudit = performMathAudit(listingData);

  // Try AI-enhanced audit
  log('Running AI analysis...');
  const aiResult = await auditListing(listingData);

  if (aiResult.source !== 'math') {
    // Merge AI insights with math checks
    return {
      ...aiResult.audit,
      source: aiResult.source,
      math_checks: mathAudit,
      listing_url: listingUrl,
      listing_data: listingData,
      audited_at: new Date().toISOString()
    };
  }

  return {
    ...mathAudit,
    source: 'math',
    listing_url: listingUrl,
    listing_data: listingData,
    audited_at: new Date().toISOString()
  };
}

// ─── Math-Based SEO Audit (always works, no AI needed) ────────────────────
function performMathAudit(data) {
  const issues = [];
  const fixes = [];
  const title = data.title || '';
  const tags = data.tags || [];
  const description = data.description || '';
  const price = data.price || 0;

  // ── Title Analysis ──
  let titleScore = 100;

  // Length check (130-140 chars optimal)
  if (title.length < 80) {
    titleScore -= 30;
    issues.push(`Title too short: ${title.length} characters (optimal: 130-140)`);
    fixes.push('Expand title to use 130-140 characters with relevant keywords');
  } else if (title.length < 130) {
    titleScore -= 15;
    issues.push(`Title could be longer: ${title.length}/140 characters used`);
    fixes.push('Add more keywords to fill the 140-character limit');
  } else if (title.length > 140) {
    titleScore -= 10;
    issues.push('Title exceeds 140-character limit — Etsy will truncate it');
    fixes.push('Trim title to exactly 140 characters, keeping keywords at the start');
  }

  // Keyword placement (should be at start)
  const titleWords = title.split(/\s+/);
  if (titleWords.length < 3) {
    titleScore -= 20;
    issues.push('Title lacks specificity — use descriptive, keyword-rich phrasing');
    fixes.push('Start title with the main keyword, then add descriptive details');
  }

  // Special characters check
  if (/[!@#$%^&*()]/.test(title)) {
    titleScore -= 5;
    issues.push('Title contains special characters that may hurt searchability');
    fixes.push('Use commas and dashes instead of special characters in title');
  }

  // ── Tags Analysis ──
  let tagsScore = 100;

  // Count check (should be exactly 13)
  if (tags.length === 0) {
    tagsScore = 0;
    issues.push('No tags found — this severely hurts discoverability');
    fixes.push('Add exactly 13 tags using multi-word phrases');
  } else if (tags.length < 13) {
    tagsScore -= (13 - tags.length) * 7;
    issues.push(`Only ${tags.length}/13 tag slots used — missing ${13 - tags.length} tags`);
    fixes.push(`Add ${13 - tags.length} more tags with long-tail keyword phrases`);
  }

  // Single-word tags
  const singleWordTags = tags.filter(t => !t.includes(' '));
  if (singleWordTags.length > 2) {
    tagsScore -= singleWordTags.length * 3;
    issues.push(`${singleWordTags.length} single-word tags: "${singleWordTags.slice(0, 3).join('", "')}"...`);
    fixes.push('Replace single-word tags with 2-3 word phrases for better matching');
  }

  // Duplicate words between title and tags
  const titleWordsLower = title.toLowerCase().split(/\s+/);
  const duplicateTagWords = tags.filter(t =>
    t.toLowerCase().split(/\s+/).every(w => titleWordsLower.includes(w))
  );
  if (duplicateTagWords.length > 2) {
    tagsScore -= 10;
    issues.push(`${duplicateTagWords.length} tags exactly duplicate title words`);
    fixes.push('Use tags for synonyms and related terms, not exact title repeats');
  }

  // ── Description Analysis ──
  let descScore = 100;

  if (!description || description.length < 20) {
    descScore = 20;
    issues.push('Description appears missing or very short');
    fixes.push('Write a compelling 250+ word description with keywords in first 160 characters');
  } else if (description.length < 100) {
    descScore -= 30;
    issues.push('Description is too brief for good SEO');
    fixes.push('Expand description — first 160 characters should contain main keywords');
  }

  // ── Price Analysis ──
  let priceNote = '';
  if (price > 0) {
    if (price < 3) priceNote = 'Price is very low — consider if margins support this';
    else if (price > 100) priceNote = 'High price point — ensure perceived value justifies cost';
    else priceNote = `Price of $${price} is within a reasonable range`;
  }

  // ── Overall Score ──
  titleScore = Math.max(0, Math.min(100, titleScore));
  tagsScore = Math.max(0, Math.min(100, tagsScore));
  descScore = Math.max(0, Math.min(100, descScore));
  const overallScore = Math.round((titleScore * 0.35) + (tagsScore * 0.40) + (descScore * 0.25));

  // Generate improved title suggestion
  let betterTitle = title;
  if (title.length < 130) {
    betterTitle = title + ' — [add more keywords here to reach 140 chars]';
  }

  // Generate improved tags
  let betterTags = [...tags];
  while (betterTags.length < 13) {
    betterTags.push('[add multi-word keyword phrase]');
  }

  return {
    overall_score: overallScore,
    title_score: titleScore,
    tags_score: tagsScore,
    description_score: descScore,
    issues,
    fixes,
    better_title: betterTitle,
    better_tags: betterTags.slice(0, 13),
    keyword_gaps: [
      'Consider adding seasonal/trending keywords',
      'Add long-tail variations of main keywords',
      'Include buyer-intent phrases (gift for, personalized, custom)'
    ],
    price_analysis: priceNote
  };
}
