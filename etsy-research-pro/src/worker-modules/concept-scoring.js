/**
 * concept-scoring.js
 * 
 * Reimplemented for Etsy Research Pro.
 * Evaluates grouped keyword concepts based on performance signals
 * to determine market viability (home run, worth testing, or skip).
 * Safe for execution in the MV3 service worker environment.
 */

export const RULES = [
  'min_cluster_searches',
  'max_avg_shop_reviews',
  'min_median_in_carts',
  'min_median_sold_24h',
  'demand_depth',
  'ad_dominance',
  'max_shop_slot_share',
];

/**
 * Safely parses a value to a finite number, returning a fallback if invalid.
 */
function parseNumeric(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Calculates the score and verdict for a single product concept.
 * 
 * @param {Object} conceptData - The aggregated concept metrics.
 * @param {Object} userSettings - Configuration overrides.
 * @returns {Object} Verdict, evaluation reasons, and summary stats.
 */
export function scoreConcept(conceptData, userSettings = {}) {
  // Apply defaults based on validated platform performance benchmarks
  const settings = {
    min_cluster_searches: parseNumeric(userSettings.min_cluster_searches, 2000),
    max_avg_shop_reviews: parseNumeric(userSettings.max_avg_shop_reviews, 400),
    min_median_in_carts: parseNumeric(userSettings.min_median_in_carts, 5),
    min_median_sold_24h: parseNumeric(userSettings.min_median_sold_24h, 1),
    min_median_favorites: parseNumeric(userSettings.min_median_favorites, 10),
    max_ads_in_top_n: parseNumeric(userSettings.max_ads_in_top_n, 6),
    ad_dominance_mode: String(userSettings.ad_dominance_mode || 'skip').toLowerCase(),
    max_shop_slot_share: parseNumeric(userSettings.max_shop_slot_share, 0.25),
    home_run_max_fails: parseNumeric(userSettings.home_run_max_fails, 0),
    worth_test_max_fails: parseNumeric(userSettings.worth_test_max_fails, 2),
  };

  const evaluationLog = [];
  
  const addReason = (ruleName, isPassing, message, isSoftFail = false) => {
    const entry = { rule: ruleName, pass: isPassing, detail: message };
    if (isSoftFail) {
      entry.softFail = true;
    }
    evaluationLog.push(entry);
  };

  // 1. Search Volume Check
  const totalSearches = parseNumeric(conceptData.total_searches, 0);
  const searchVolumePassed = totalSearches >= settings.min_cluster_searches;
  addReason(
    'min_cluster_searches', 
    searchVolumePassed, 
    `${totalSearches.toLocaleString()} searches vs. min ${settings.min_cluster_searches.toLocaleString()}`
  );

  // 2. Competition Strength Check (Reviews)
  const avgReviews = conceptData.avg_shop_reviews;
  if (avgReviews == null) {
    addReason('max_avg_shop_reviews', false, 'no audited shop-review data');
  } else {
    const reviewsPassed = avgReviews <= settings.max_avg_shop_reviews;
    addReason(
      'max_avg_shop_reviews', 
      reviewsPassed, 
      `avg shop reviews ${Math.round(avgReviews)} vs. max ${settings.max_avg_shop_reviews}`
    );
  }

  // 3. Current Cart Activity Check
  const inCarts = conceptData.median_in_carts;
  if (inCarts == null) {
    addReason('min_median_in_carts', false, 'no in-cart data');
  } else {
    const cartsPassed = inCarts >= settings.min_median_in_carts;
    addReason(
      'min_median_in_carts', 
      cartsPassed, 
      `median in-carts ${inCarts} vs. min ${settings.min_median_in_carts}`
    );
  }

  // 4. Daily Sales Velocity Check
  const dailySold = conceptData.median_sold_24h;
  if (dailySold == null) {
    addReason('min_median_sold_24h', false, 'no sold-24h data');
  } else {
    const salesPassed = dailySold >= settings.min_median_sold_24h;
    addReason(
      'min_median_sold_24h', 
      salesPassed, 
      `median sold/24h ${dailySold} vs. min ${settings.min_median_sold_24h}`
    );
  }

  // 5. Aggregate Demand Signal Check
  const favorites = conceptData.median_favorites;
  
  const hasValidFavorites = favorites != null && favorites >= settings.min_median_favorites;
  const hasValidCarts = inCarts != null && inCarts >= settings.min_median_in_carts;
  const hasValidSales = dailySold != null && dailySold >= settings.min_median_sold_24h;
  
  const meetsAnyDemand = hasValidFavorites || hasValidCarts || hasValidSales;
  const missingAllDemandMetrics = favorites == null && inCarts == null && dailySold == null;

  if (missingAllDemandMetrics) {
    addReason('demand_depth', false, 'no demand data (favs, carts, sold all missing)');
  } else {
    const signals = [];
    if (favorites != null) signals.push(`favs ${favorites}${hasValidFavorites ? ' ✓' : ''}`);
    if (inCarts != null) signals.push(`carts ${inCarts}${hasValidCarts ? ' ✓' : ''}`);
    if (dailySold != null) signals.push(`sold/24h ${dailySold}${hasValidSales ? ' ✓' : ''}`);
    
    addReason(
      'demand_depth', 
      meetsAnyDemand, 
      `${signals.join(', ')} — need ≥1 signal (favs≥${settings.min_median_favorites} OR carts≥${settings.min_median_in_carts} OR sold≥${settings.min_median_sold_24h})`
    );
  }

  // 6. Paid Advertising Saturation Check
  const adCount = conceptData.ads_count_avg;
  const currentAdMode = settings.ad_dominance_mode;
  
  if (currentAdMode !== 'ignore') {
    if (adCount == null) {
      addReason('ad_dominance', false, 'no ad-count data');
    } else {
      const adsPassed = adCount <= settings.max_ads_in_top_n;
      const detailStr = `ads_count_avg ${adCount.toFixed(1)} vs. max ${settings.max_ads_in_top_n} (mode=${currentAdMode})`;
      const isSoftFailing = !adsPassed && currentAdMode === 'test';
      
      addReason('ad_dominance', adsPassed, detailStr, isSoftFailing);
    }
  }

  // 7. Monopoly / Market Share Distribution Check
  const maxSlotShare = conceptData.shop_slot_share_max;
  if (maxSlotShare == null) {
    addReason('max_shop_slot_share', false, 'no shop slot-share data');
  } else {
    const sharePassed = maxSlotShare <= settings.max_shop_slot_share;
    const currentPercent = (maxSlotShare * 100).toFixed(0);
    const maxPercent = (settings.max_shop_slot_share * 100).toFixed(0);
    addReason(
      'max_shop_slot_share', 
      sharePassed, 
      `top shop holds ${currentPercent}% of slots vs. max ${maxPercent}%`
    );
  }

  // Tabulate Results
  let totalPasses = 0;
  let totalHardFails = 0;
  let totalSoftFails = 0;

  for (const record of evaluationLog) {
    if (record.pass) {
      totalPasses++;
    } else if (record.softFail) {
      totalSoftFails++;
    } else {
      totalHardFails++;
    }
  }

  const criticalFails = totalHardFails + totalSoftFails;
  const secondaryFails = totalHardFails;

  // Determine Final Verdict
  let finalVerdict = 'skip';
  if (criticalFails <= settings.home_run_max_fails) {
    finalVerdict = 'home_run';
  } else if (secondaryFails <= settings.worth_test_max_fails) {
    finalVerdict = 'worth_test';
  }

  return {
    verdict: finalVerdict,
    reasons: evaluationLog,
    rules: {
      total: evaluationLog.length,
      pass: totalPasses,
      hardFail: totalHardFails,
      softFail: totalSoftFails,
    },
    cfg: settings,
  };
}

/**
 * Processes an array of concepts and assigns verdicts, then sorts them by potential.
 * 
 * @param {Array} conceptList - List of aggregated concept objects.
 * @param {Object} userSettings - Configuration mapping.
 * @returns {Object} Scored concepts and a summary tally.
 */
export function scoreConcepts(conceptList, userSettings = {}) {
  const scoredResults = [];
  const verdictTally = { home_run: 0, worth_test: 0, skip: 0 };
  
  for (const currentConcept of conceptList) {
    const scoreResult = scoreConcept(currentConcept, userSettings);
    verdictTally[scoreResult.verdict] = (verdictTally[scoreResult.verdict] || 0) + 1;
    scoredResults.push({ ...currentConcept, ...scoreResult });
  }
  
  const rankPriority = { home_run: 1, worth_test: 2, skip: 3 };
  
  scoredResults.sort((first, second) => {
    const rankDifference = rankPriority[first.verdict] - rankPriority[second.verdict];
    if (rankDifference !== 0) {
      return rankDifference;
    }
    const firstSearches = first.total_searches || 0;
    const secondSearches = second.total_searches || 0;
    return secondSearches - firstSearches;
  });
  
  return { concepts: scoredResults, counts: verdictTally };
}
