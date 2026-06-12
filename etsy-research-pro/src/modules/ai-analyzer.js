// AI Analyzer — Gemini + Groq + Math Fallback
// API keys NEVER leave the browser — direct fetch to provider APIs
// Fallback chain: Gemini → Groq → Math-only scoring

import { loadConfig } from '../utils/config.js';
import { RateLimiter } from '../utils/rate-limiter.js';

const rateLimiter = new RateLimiter({ maxPerMinute: 14, maxPerDay: 1400 });

// ─── Cluster Analysis ─────────────────────────────────────────────────────
export async function analyzeListings(keyword, listings, productType = 'any', beatableSlots = null) {
  const config = await loadConfig();
  const keys = {
    gemini: config.gemini_api_key,
    groq: config.groq_api_key,
    provider: config.ai_provider
  };

  const maxReviewsThreshold = config.max_shop_reviews_beatable !== undefined ? config.max_shop_reviews_beatable : 300;
  const calculatedBeatable = beatableSlots !== null ? beatableSlots : listings.slice(0, 10).filter(l => (l.shop_reviews || 0) < maxReviewsThreshold).length;

  // Format listings for AI prompt
  const listingText = listings.map((l, i) =>
    `${i + 1}. "${l.title}" | $${l.price} | Reviews:${l.shop_reviews} | Bestseller:${l.is_bestseller ? 'Y' : 'N'} | Urgency:${l.urgency_text || 'none'}`
  ).join('\n');

  const prompt = `You are an expert Etsy product researcher specializing in profitable niches.

Keyword: "${keyword}"
Product type: ${productType}
Beatable Slots Count (out of top 10 listings having total shop reviews < ${maxReviewsThreshold}): ${calculatedBeatable} / 10

Analyze these ${listings.length} Etsy listings and group into 3-6 specific micro-niches:

${listingText}

For each micro-niche return this JSON:
{
  "niche": "Specific niche name",
  "product_type": "digital|physical|pod",
  "listings": [1,4,7],
  "demand_score": 75,
  "competition_score": 40,
  "win_score": 85,
  "opportunity": "What specific gap exists",
  "target_buyer": "Who buys this",
  "price_recommendation": "$8-12",
  "image_prompt": "Midjourney/DALL-E optimized prompt",
  "verdict": "WIN|AVERAGE|SKIP — one line reason",
  "keywords_to_target": ["kw1","kw2","kw3"]
}

CRITICAL: Use the Beatable Slots Count (${calculatedBeatable}/10) to accurately calculate a definitive, data-backed Niche Feasibility Score ("win_score") and verdict for each micro-niche. A higher beatable slots count indicates a higher win_score.

CRITICAL: For "digital" or "pod" (print-on-demand) niches, the "image_prompt" must be a highly detailed, descriptive, high-converting prompt designed for Midjourney or DALL-E to generate a premium product/artwork mock-up matching this trend (including style, lighting, camera settings, and aspect ratios like --ar 4:3 or --v 6.0).

Return ONLY valid JSON array. No markdown. No explanation outside JSON.`;

  // Try AI providers in order
  if (keys.gemini || keys.provider === 'gemini') {
    try {
      const result = await callGemini(keys.gemini, prompt);
      if (result) return { clusters: result, source: 'gemini' };
    } catch (e) {
      console.warn('[AI] Gemini failed:', e.message);
    }
  }

  if (keys.groq || keys.provider === 'groq') {
    try {
      const result = await callGroq(keys.groq, prompt);
      if (result) return { clusters: result, source: 'groq' };
    } catch (e) {
      console.warn('[AI] Groq failed:', e.message);
    }
  }

  // Math fallback — always works
  return { clusters: mathClusterAnalysis(keyword, listings, productType), source: 'math' };
}

// ─── SEO Audit via AI ─────────────────────────────────────────────────────
export async function auditListing(listingData) {
  const config = await loadConfig();
  const keys = {
    gemini: config.gemini_api_key,
    groq: config.groq_api_key,
    provider: config.ai_provider
  };

  const prompt = `You are an Etsy SEO expert. Audit this listing.

Title: "${listingData.title}"
Tags: ${JSON.stringify(listingData.tags || [])}
Description start: "${(listingData.description || '').substring(0, 200)}"
Price: $${listingData.price} | Category: ${listingData.category || 'Unknown'} | Reviews: ${listingData.reviews || 0}

Return this JSON only:
{
  "overall_score": 67,
  "title_score": 55,
  "tags_score": 70,
  "description_score": 60,
  "issues": ["issue 1", "issue 2"],
  "fixes": ["specific fix with example", "specific fix 2"],
  "better_title": "Full optimized title here",
  "better_tags": ["tag1","tag2","tag3","tag4","tag5","tag6","tag7","tag8","tag9","tag10","tag11","tag12","tag13"],
  "keyword_gaps": ["missing kw 1","missing kw 2"],
  "price_analysis": "Your price vs niche average"
}`;

  if (keys.gemini || keys.provider === 'gemini') {
    try {
      const result = await callGemini(keys.gemini, prompt);
      if (result) return { audit: result, source: 'gemini' };
    } catch (e) {
      console.warn('[AI] Gemini audit failed:', e.message);
    }
  }

  if (keys.groq || keys.provider === 'groq') {
    try {
      const result = await callGroq(keys.groq, prompt);
      if (result) return { audit: result, source: 'groq' };
    } catch (e) {
      console.warn('[AI] Groq audit failed:', e.message);
    }
  }

  return { audit: mathSeoAudit(listingData), source: 'math' };
}

// ─── Seed Keyword Generation via AI ───────────────────────────────────────
export async function generateSeedKeywords(interest) {
  const config = await loadConfig();
  const keys = {
    gemini: config.gemini_api_key,
    groq: config.groq_api_key,
    provider: config.ai_provider
  };

  const prompt = `Etsy seller interested in: "${interest}"
Generate 15 specific long-tail Etsy search keywords.
Focus on: good search potential, lower competition, mix of product types.

Return JSON:
{
  "keywords": ["specific keyword 1",...15 total],
  "niche_ideas": ["niche idea 1","niche idea 2"],
  "hot_right_now": ["trending keyword"],
  "low_competition_picks": ["low comp keyword"]
}`;

  if (keys.gemini || keys.provider === 'gemini') {
    try {
      const result = await callGemini(keys.gemini, prompt);
      if (result) return { data: result, source: 'gemini' };
    } catch (e) {
      console.warn('[AI] Gemini seed gen failed:', e.message);
    }
  }

  if (keys.groq || keys.provider === 'groq') {
    try {
      const result = await callGroq(keys.groq, prompt);
      if (result) return { data: result, source: 'groq' };
    } catch (e) {
      console.warn('[AI] Groq seed gen failed:', e.message);
    }
  }

  return { data: null, source: 'none' };
}

// ─── Gemini API ───────────────────────────────────────────────────────────
async function callGemini(apiKey, prompt) {
  if (!apiKey) throw new Error('No Gemini API key');

  await rateLimiter.waitForSlot();

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json'
        }
      })
    }
  );

  rateLimiter.recordRequest();

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Gemini ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini returned empty response');

  return parseJsonResponse(text);
}

// ─── Groq API ─────────────────────────────────────────────────────────────
async function callGroq(apiKey, prompt) {
  if (!apiKey) throw new Error('No Groq API key');

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      max_tokens: 4096,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Groq ${response.status}: ${err.substring(0, 200)}`);
  }

  const data = await response.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Groq returned empty response');

  return parseJsonResponse(text);
}

// ─── JSON parser (handles markdown wrapping) ──────────────────────────────
function parseJsonResponse(text) {
  let cleaned = text.trim();
  // Remove markdown code blocks
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
  cleaned = cleaned.trim();

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Try to find JSON in the response
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) return JSON.parse(arrayMatch[0]);
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
    throw new Error('Could not parse AI response as JSON');
  }
}

// ─── Math-based cluster analysis (no AI needed) ───────────────────────────
function mathClusterAnalysis(keyword, listings, productType) {
  const clusters = {};

  // Group by price range
  listings.forEach((l, i) => {
    let clusterName;
    if (l.price <= 5) clusterName = 'Budget Options';
    else if (l.price <= 15) clusterName = 'Mid-Range';
    else if (l.price <= 40) clusterName = 'Premium';
    else clusterName = 'High-End';

    if (!clusters[clusterName]) {
      clusters[clusterName] = { listings: [], prices: [], reviews: [], bestsellers: 0, urgency: 0 };
    }
    clusters[clusterName].listings.push(i + 1);
    clusters[clusterName].prices.push(l.price);
    clusters[clusterName].reviews.push(l.shop_reviews || 0);
    if (l.is_bestseller) clusters[clusterName].bestsellers++;
    if (l.urgency_text) clusters[clusterName].urgency++;
  });

  return Object.entries(clusters).map(([name, data]) => {
    const avgPrice = data.prices.reduce((a, b) => a + b, 0) / data.prices.length;
    const maxReviewsThreshold = config.max_shop_reviews_beatable !== undefined ? config.max_shop_reviews_beatable : 300;
    const beatableCount = data.reviews.filter(r => r < maxReviewsThreshold).length;

    const demandScore = calculateDemandScore(data);
    const beatability = (beatableCount / data.listings.length) * 100;
    const winScore = Math.round(
      (demandScore * 0.40) + (beatability * 0.35) + (50 * 0.15) + (priceSweetSpot(avgPrice, productType) * 0.10)
    );

    return {
      niche: name,
      product_type: productType,
      listings: data.listings,
      demand_score: Math.round(demandScore),
      competition_score: Math.round(100 - beatability),
      win_score: winScore,
      opportunity: beatability > 60 ? 'Many beatable shops in this price range' : 'Established competition',
      target_buyer: `Buyers looking for ${keyword} in ${name.toLowerCase()} range`,
      price_recommendation: `$${Math.round(avgPrice * 0.8)}-$${Math.round(avgPrice * 1.2)}`,
      image_prompt: `Professional product photo: ${keyword}, ${name.toLowerCase()}, Etsy listing style, white background, studio lighting`,
      verdict: winScore >= 70 ? 'WIN — Good opportunity' : winScore >= 50 ? 'GOOD — Worth considering' : winScore >= 30 ? 'AVERAGE — Proceed carefully' : 'SKIP — Too competitive',
      keywords_to_target: [keyword]
    };
  });
}

// ─── Win Score Sub-Calculations ───────────────────────────────────────────
function calculateDemandScore(clusterData) {
  let score = 20; // base
  if (clusterData.bestsellers > 0) score += 25;
  if (clusterData.urgency > 0) score += 20;
  const avgReviews = clusterData.reviews.reduce((a, b) => a + b, 0) / clusterData.reviews.length;
  if (avgReviews > 100) score += 10;
  return Math.min(score, 100);
}

function priceSweetSpot(price, productType) {
  if (productType === 'digital') {
    if (price >= 4 && price <= 15) return 100;
    if (price > 15 && price <= 25) return 70;
    if (price >= 1 && price < 4) return 50;
    return 30;
  }
  if (productType === 'pod') {
    if (price >= 20 && price <= 45) return 100;
    if (price >= 15 && price < 20) return 70;
    if (price > 45 && price <= 60) return 60;
    return 30;
  }
  // physical
  if (price >= 15 && price <= 60) return 100;
  if (price >= 8 && price < 15) return 70;
  if (price > 60 && price <= 100) return 60;
  return 30;
}

// ─── Math-based SEO audit (no AI needed) ──────────────────────────────────
function mathSeoAudit(listingData) {
  const issues = [];
  const fixes = [];
  let titleScore = 70;
  let tagsScore = 70;
  let descScore = 60;

  // Title analysis
  const title = listingData.title || '';
  if (title.length < 100) {
    issues.push(`Title too short (${title.length} chars) — should be 130-140`);
    fixes.push('Expand title to use all 140 characters with relevant keywords');
    titleScore -= 20;
  }
  if (title.length > 140) {
    issues.push(`Title exceeds 140 character limit`);
    titleScore -= 10;
  }

  // Tags analysis
  const tags = listingData.tags || [];
  if (tags.length < 13) {
    issues.push(`Only ${tags.length}/13 tags used`);
    fixes.push('Use all 13 tag slots with unique long-tail phrases');
    tagsScore -= (13 - tags.length) * 5;
  }

  // Check for single-word tags
  const singleWordTags = tags.filter(t => !t.includes(' '));
  if (singleWordTags.length > 3) {
    issues.push(`${singleWordTags.length} single-word tags — use multi-word phrases instead`);
    fixes.push('Replace single-word tags with 2-3 word phrases for better matching');
    tagsScore -= 10;
  }

  // Description
  const desc = listingData.description || '';
  if (desc.length < 50) {
    issues.push('Description appears very short');
    fixes.push('Write at least 250+ words with keywords in first 160 characters');
    descScore -= 30;
  }

  const overallScore = Math.round((titleScore + tagsScore + descScore) / 3);

  return {
    overall_score: Math.max(0, Math.min(100, overallScore)),
    title_score: Math.max(0, Math.min(100, titleScore)),
    tags_score: Math.max(0, Math.min(100, tagsScore)),
    description_score: Math.max(0, Math.min(100, descScore)),
    issues,
    fixes,
    better_title: title.length < 130 ? `${title} — add more keywords here` : title,
    better_tags: tags.length < 13 ? [...tags, ...Array(13 - tags.length).fill('add keyword phrase')] : tags,
    keyword_gaps: ['Consider adding seasonal keywords', 'Add long-tail variations'],
    price_analysis: `Current price: $${listingData.price || 0}`
  };
}

// ─── Calculate Win Score for a single listing ─────────────────────────────
export function calculateWinScore(listing, allListings, productType = 'any') {
  // Demand Score (0-100)
  let demand = 20;
  if (listing.is_bestseller) demand += 25;
  if (listing.urgency_text && listing.urgency_text.includes('cart')) demand += 20;
  else if (listing.urgency_text && listing.urgency_text.includes('demand')) demand += 15;
  if (listing.is_popular_now) demand += 15;
  if (listing.shop_reviews > 100) demand += 10;
  if (listing.listing_age_days && listing.listing_age_days < 30) demand += 10;
  demand = Math.min(demand, 100);

  // Beatability Score (0-100)
  const top12 = allListings.slice(0, 12);
  const beatableCount = top12.filter(l => (l.shop_reviews || 0) < 300).length;
  const beatability = (beatableCount / Math.max(top12.length, 1)) * 100;

  // Trend Score (0-100) — estimated without eRank
  let trend = 50;

  // Price Sweet Spot (0-100)
  const priceScore = priceSweetSpot(listing.price || 0, productType);

  // Win Score formula
  const winScore = Math.round(
    (demand * 0.40) + (beatability * 0.35) + (trend * 0.15) + (priceScore * 0.10)
  );

  // Verdict
  let verdict;
  if (winScore >= 70) verdict = 'WIN';
  else if (winScore >= 50) verdict = 'GOOD';
  else if (winScore >= 30) verdict = 'AVERAGE';
  else verdict = 'SKIP';

  return {
    win_score: winScore,
    demand_score: demand,
    beatability_score: Math.round(beatability),
    trend_score: trend,
    price_score: priceScore,
    verdict
  };
}

// ─── Batch scoring for all listings ───────────────────────────────────────
export function scoreAllListings(listings, productType = 'any') {
  return listings.map(listing => ({
    ...listing,
    scores: calculateWinScore(listing, listings, productType)
  }));
}
