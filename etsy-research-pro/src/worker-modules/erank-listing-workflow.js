// Step 3: Etsy Listing Audit Workflow
// Single-pass Etsy-only audit — no eRank credits consumed.
// Visits each listing's Etsy detail page to capture social proof signals:
//   in_carts, sold_24h, views_24h, rating, review_count, thumbnail_url,
//   favorites_count, photo_count, has_video, related_search_queries
// Also enriches shop data: total_sales, shop_location, shop_established,
//   is_star_seller, shop_team_size
//
// Scoped to the top N keywords ranked by Step 2's pre-audit ranking
// (topKeywordIds stored in chrome.storage.local.nicheQualification).
// Within each keyword, audits up to `max_listings_per_keyword` beatable
// listings (shops with fewer reviews than the beatable threshold).
//
// 2026-04-17: per-keyword audit cap is now config-driven. Was hardcoded to 5
// which ignored the user's popup setting (default 12). Now sourced from the
// same `max_listings_per_keyword` config key Step 2 + Step 4 use, so the
// user's single setting consistently drives audit depth AND report display.

export async function runErankListingAudit(sheetsClient, tabId, config, log, seedKeyword, shouldStop) {
  if (!shouldStop) shouldStop = () => false;
  const started = new Date().toISOString();
  let audited = 0;

  try {
    // ─── Niche qualification gate ───
    // Step 3 only runs if Step 2 found enough qualified keywords.
    const { nicheQualification } = await chrome.storage.local.get('nicheQualification');
    if (nicheQualification && nicheQualification.seedKeyword === seedKeyword) {
      if (!nicheQualification.nicheQualified) {
        log('warn', `🚫 SKIPPING Step 3 — niche "${seedKeyword}" did not qualify in Step 2`);
        log('info', `💡 Only ${nicheQualification.qualifiedCount}/${nicheQualification.totalProcessed} keywords qualified (need ${nicheQualification.minQualifiedKw}). No point auditing listings for a non-viable niche.`);
        await sheetsClient.logRun('erank_listing_audit', 'SKIPPED', 0, 0, 0, '',
          `Niche not qualified: ${nicheQualification.qualifiedCount}/${nicheQualification.totalProcessed} keywords`);
        return { audited: 0, skippedReason: 'niche_not_qualified' };
      }
      log('info', `✅ Niche qualified — ${nicheQualification.qualifiedCount} keywords passed, proceeding with audit`);
    }

    let sheetConfig;
    try { sheetConfig = await sheetsClient.readConfig(); } catch(e) { sheetConfig = {}; }

    // 2026-04-18: config priority inverted — popup (config) wins over DB
    // (sheetConfig). User changes in popup must take effect immediately
    // without needing a DB row purge.
    const cfg = (key, fallback) => {
      const popup = config != null ? config[key] : undefined;
      if (popup !== undefined && popup !== null && popup !== '') return popup;
      const db = sheetConfig != null ? sheetConfig[key] : undefined;
      if (db !== undefined && db !== null && db !== '') return db;
      return fallback;
    };

    const delay = parseInt(cfg('delay_between_pages_sec', 5)) * 1000;

    // Per-keyword audit cap — matches what Step 2 uses for beatable-slots
    // evaluation and what Step 4 shows in the report listing card.
    const maxBeatablePerKw = Math.max(1, parseInt(cfg('max_listings_per_keyword', 12)) || 12);

    // Audit freshness window
    const FRESH_HOURS = parseInt(
      cfg('audit_freshness_hours', null)
      ?? cfg('data_staleness_hours', null)
      ?? cfg('listing_freshness_hours', null)
      ?? 48
    ) || 48;
    log('info', `🕒 Audit freshness window: ${FRESH_HOURS}h, max ${maxBeatablePerKw} listings/keyword`);

    // Load seed first so we can seed-scope all downstream reads.
    const { rows: seeds } = await sheetsClient.readSheet('seed_keywords');
    const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!seed) {
      log('error', `Seed keyword "${seedKeyword}" not found`);
      await sheetsClient.logRun('erank_listing_audit', 'FAILED', 0, 0, 0, `Seed "${seedKeyword}" not found`, '');
      return { audited: 0 };
    }

    const seedId = String(seed.seed_id);
    // 2026-04-22: seed-scoped listings read (Worker JOINs through seed_keyword_map).
    // Previously unscoped → Worker OOM once listings table grew past ~5000 rows.
    const { rows: listings } = await sheetsClient.readSheet('etsy_listings', { seed_id: seedId }, { sinceHours: FRESH_HOURS, sinceColumn: 'updated_at' });
    const { rows: keywords } = await sheetsClient.readSheet('etsy_keywords', { seed_id: seedId }, { sinceHours: FRESH_HOURS, sinceColumn: 'updated_at' });
    const seedKwIds = new Set(keywords.filter(k => String(k.seed_id) === seedId).map(k => String(k.keyword_id)));

    // ─── Scope to top keywords from pre-audit ranking ───
    // Step 2 ranked keywords by preliminary opportunity and stored the top N
    // IDs in nicheQualification.topKeywordIds. If available, only audit
    // listings from those keywords. Falls back to all seed keywords if the
    // pre-audit ranking is not available (e.g. Step 3 run standalone).
    const topKeywordIds = (nicheQualification && nicheQualification.topKeywordIds) || [];
    let effectiveKwIds;
    if (topKeywordIds.length > 0) {
      effectiveKwIds = new Set(topKeywordIds.filter(id => seedKwIds.has(id)));
      log('info', `🎯 Pre-audit ranking: scoping to ${effectiveKwIds.size} top keywords (of ${seedKwIds.size} total)`);
    } else {
      effectiveKwIds = seedKwIds;
      log('info', `🎯 No pre-audit ranking available — auditing all ${seedKwIds.size} keywords`);
    }
    log('info', `🎯 Seed "${seedKeyword}" has ${effectiveKwIds.size} keywords in scope — scanning listings`);

    // Beatable threshold
    const maxShopReviewsBeatable = parseInt(config.max_shop_reviews_beatable || 300);

    // Load stores for beatable check — cap to 30-day freshness window so we
    // don't slurp the entire shared stores table (grows unbounded across all
    // users/seeds). 30 days is generous for shop review_count churn.
    // Order by last_updated DESC so the 5-page cap (5000 rows) hits the
    // freshest shops first — the ones most likely referenced by this run.
    const { rows: stores } = await sheetsClient.readSheet(
      'etsy_stores',
      {},
      { sinceHours: 24 * 7, sinceColumn: 'last_updated', orderBy: 'last_updated', order: 'DESC' }
    );
    const shopLookup = {};
    for (const s of stores) {
      const name = (s.shop_name || '').toLowerCase();
      if (name) shopLookup[name] = s;
    }

    // Build candidate pool scoped to effective keywords, dedup by listing_id
    const seenIds = new Set();
    const candidates = listings.filter(l => {
      if (!l.listing_id) return false;
      const id = String(l.listing_id);
      if (seenIds.has(id)) return false;
      if (!effectiveKwIds.has(String(l.keyword_id))) return false;
      seenIds.add(id);
      return true;
    });

    // Server-side keyword-agnostic freshness lookup
    let freshnessMap = {};
    if (candidates.length > 0) {
      try {
        const candidateIds = candidates.map(c => c.listing_id);
        const freshnessResp = await sheetsClient.getListingAuditFreshness(candidateIds);
        freshnessMap = freshnessResp.listings || {};
        const freshCount = Object.values(freshnessMap).filter(f => f && f.is_fresh).length;
        log('info', `♻️ Cross-keyword reuse check: ${freshCount}/${candidates.length} candidates already have a fresh audit (within ${freshnessResp.freshnessHours}h) — skipping those`);
      } catch (e) {
        log('warn', `⚠️ Audit-freshness lookup failed (${e.message}) — auditing every candidate`);
        freshnessMap = {};
      }
    }

    // Drop listings with fresh audits
    const unaudited = candidates.filter(l => {
      const f = freshnessMap[String(l.listing_id)];
      return !(f && f.is_fresh);
    });

    // ─── Group by keyword, pick top beatable listings per keyword ───
    // Within each keyword, prioritize beatable shops (low review count),
    // then bestsellers, then by search position.
    const byKeyword = new Map();
    for (const l of unaudited) {
      const kid = String(l.keyword_id);
      if (!byKeyword.has(kid)) byKeyword.set(kid, []);
      byKeyword.get(kid).push(l);
    }

    // Sort each bucket: beatable first, then bestseller/popular, then position
    for (const bucket of byKeyword.values()) {
      bucket.sort((a, b) => {
        const aShop = shopLookup[(a.shop_name || '').toLowerCase()] || {};
        const bShop = shopLookup[(b.shop_name || '').toLowerCase()] || {};
        const aRevs = (aShop.shop_review_count != null && !isNaN(parseInt(aShop.shop_review_count))) ? parseInt(aShop.shop_review_count) : 0;
        const bRevs = (bShop.shop_review_count != null && !isNaN(parseInt(bShop.shop_review_count))) ? parseInt(bShop.shop_review_count) : 0;
        const aBeatable = aRevs < maxShopReviewsBeatable ? 1 : 0;
        const bBeatable = bRevs < maxShopReviewsBeatable ? 1 : 0;
        if (aBeatable !== bBeatable) return bBeatable - aBeatable;
        const aScore = (a.is_bestseller === 'TRUE' ? 100 : 0) + (a.is_popular_now === 'TRUE' ? 50 : 0);
        const bScore = (b.is_bestseller === 'TRUE' ? 100 : 0) + (b.is_popular_now === 'TRUE' ? 50 : 0);
        if (aScore !== bScore) return bScore - aScore;
        return (parseInt(a.search_position) || 999) - (parseInt(b.search_position) || 999);
      });
    }

    // Build final audit batch: max `maxBeatablePerKw` per keyword (config-driven)
    const auditBatch = [];
    for (const [kid, bucket] of byKeyword) {
      auditBatch.push(...bucket.slice(0, maxBeatablePerKw));
    }

    if (auditBatch.length === 0) {
      log('warn', `😴 No unaudited listings left for "${seedKeyword}" — all caught up!`);
      await sheetsClient.logRun('erank_listing_audit', 'SKIPPED', 0, 0, 0, '', 'No unaudited listings');
      return { audited: 0 };
    }

    log('info', `🛍️ Auditing ${auditBatch.length} listings across ${byKeyword.size} keywords (max ${maxBeatablePerKw} per keyword, Etsy-only — no eRank credits used)`);

    // ─── Single-pass Etsy-only audit ───
    for (let i = 0; i < auditBatch.length; i++) {
      if (shouldStop()) { log('warn', `🛑 Stop requested — halting listing audit`); break; }
      const listing = auditBatch[i];
      try {
        // Find parent keyword info
        const parentKw = keywords.find(k => String(k.keyword_id) === String(listing.keyword_id));
        const kwText = parentKw ? parentKw.keyword : '';

        log('info', `🛍️ [${i + 1}/${auditBatch.length}] Auditing listing #${listing.listing_id} under keyword "${kwText}": "${(listing.title || '').substring(0, 45)}..."`);

        const etsyUrl = `https://www.etsy.com/listing/${listing.listing_id}`;
        await navigateTab(tabId, etsyUrl);
        await sleep(delay);

        let socialData = {};
        try {
          const result = await sendToTab(tabId, { 
            action: 'extractEtsyListingDetail',
            keyword: kwText,
            url: etsyUrl
          });
          if (result.success) {
            socialData = result.data;
            const signals = [];
            if (socialData.in_carts) signals.push(`${socialData.in_carts} in carts`);
            if (socialData.sold_24h) signals.push(`${socialData.sold_24h} sold/24h`);
            if (socialData.views_24h) signals.push(`${socialData.views_24h} views/24h`);
            if (socialData.listing_rating) signals.push(`rating: ${socialData.listing_rating}`);
            if (socialData.listing_review_count) signals.push(`reviews: ${socialData.listing_review_count}`);
            if (socialData.urgency_text) signals.push(`urgency: "${socialData.urgency_text}"`);
            if (socialData.favorites_count) signals.push(`♥ ${socialData.favorites_count} favs`);
            if (socialData.photo_count) signals.push(`📷 ${socialData.photo_count} photos`);
            if (socialData.has_video) signals.push(`🎥 video`);
            log('info', `   👀 Social proof: ${signals.length > 0 ? signals.join(', ') : 'no hot signals detected'}`);
            if (socialData.related_search_queries && socialData.related_search_queries.length > 0) {
              log('info', `   🔗 Related queries: ${socialData.related_search_queries.join(', ')}`);
            }

            // Persist listing-level fields back to etsy_listings
            const updateFields = {};
            if (socialData.listing_rating) updateFields.rating = String(socialData.listing_rating);
            if (socialData.listing_review_count) updateFields.review_count = String(socialData.listing_review_count);
            if (socialData.urgency_text) updateFields.urgency_text = String(socialData.urgency_text);
            if (socialData.etsy_thumbnail_url) updateFields.thumbnail_url = String(socialData.etsy_thumbnail_url);

            if (Object.keys(updateFields).length > 0) {
              try {
                await sheetsClient.updateRowByMatch('etsy_listings', 'listing_id', listing.listing_id, updateFields);
                log('info', `   📝 Updated etsy_listings: rating=${updateFields.rating || '—'}, reviews=${updateFields.review_count || '—'}, thumb=${updateFields.thumbnail_url ? 'yes' : 'no'}`);
              } catch (ue) {
                log('warn', `   ⚠️ Could not update etsy_listings for #${listing.listing_id}: ${ue.message}`);
              }
            }
          }
        } catch (e) {
          log('warn', `   ⚠️ Etsy page hiccup for listing #${listing.listing_id}: ${e.message}`);
        }

        // Write to listing_audit — Etsy fields only, eRank fields left empty
        const now = new Date().toISOString();
        await sheetsClient.appendRowsByName('listing_audit', [{
          listing_id: listing.listing_id,
          keyword_text: kwText,
          title: listing.title || '',
          erank_est_sales: '',
          erank_views: '',
          erank_daily_views: '',
          erank_monthly_views: '',
          erank_hearts: '',
          erank_conversion_rate: '',
          erank_title_length: '',
          erank_tags_count: '',
          erank_score: '',
          erank_listing_age: '',
          erank_qty: '',
          tags_list: '',
          in_carts: socialData.in_carts || '',
          sold_24h: socialData.sold_24h || '',
          views_24h: socialData.views_24h || '',
          etsy_thumbnail_url: socialData.etsy_thumbnail_url || '',
          favorites_count: socialData.favorites_count || '',
          photo_count: socialData.photo_count || '',
          has_video: socialData.has_video ? 1 : 0,
          audited_at: now
        }]);

        // Update shop-level data from listing detail page (if available)
        // 2026-04-19: extractor now captures real shop_rating + shop_review_count
        // from the seller-cred area (.rating-and-reviews-count__avg-rating /
        // .rating-and-reviews-count__reviews-count). Use those instead of
        // listing_rating which was a wrong-but-close proxy. Falls back to
        // listing_rating if shop_rating wasn't extractable on this page.
        const shopName = listing.shop_name;
        const hasAnyShopField = socialData.shop_rating || socialData.shop_review_count
          || socialData.listing_rating || socialData.shop_total_sales || socialData.shop_location
          || socialData.shop_established || socialData.is_star_seller || socialData.shop_team_size;
        if (shopName && hasAnyShopField) {
          const shopUpdate = {};
          // Prefer real shop_rating from seller cred. Fall back to listing rating only if absent.
          if (socialData.shop_rating) shopUpdate.shop_rating = String(socialData.shop_rating);
          else if (socialData.listing_rating) shopUpdate.shop_rating = String(socialData.listing_rating);
          if (socialData.shop_review_count) shopUpdate.shop_review_count = String(socialData.shop_review_count);
          if (socialData.shop_total_sales) shopUpdate.total_sales = String(socialData.shop_total_sales);
          if (socialData.shop_location) shopUpdate.shop_location = String(socialData.shop_location);
          if (socialData.shop_established) shopUpdate.shop_established = String(socialData.shop_established);
          if (socialData.is_star_seller) shopUpdate.is_star_seller = 1;
          if (socialData.shop_team_size) shopUpdate.shop_team_size = String(socialData.shop_team_size);
          try {
            await sheetsClient.updateRowByMatch('etsy_stores', 'shop_name', shopName, shopUpdate);
            const shopSignals = [];
            if (shopUpdate.shop_rating) shopSignals.push(`★ ${shopUpdate.shop_rating}`);
            if (shopUpdate.shop_review_count) shopSignals.push(`${shopUpdate.shop_review_count} reviews`);
            if (shopUpdate.total_sales) shopSignals.push(`sales: ${shopUpdate.total_sales}`);
            if (shopUpdate.shop_location) shopSignals.push(`from: ${shopUpdate.shop_location}`);
            if (shopUpdate.shop_established) shopSignals.push(`since: ${shopUpdate.shop_established}`);
            if (shopUpdate.is_star_seller) shopSignals.push('⭐ Star Seller');
            if (shopUpdate.shop_team_size) shopSignals.push(`team: ${shopUpdate.shop_team_size}`);
            log('info', `   🏬 Shop "${shopName}": ${shopSignals.join(', ')}`);
          } catch (shopErr) {
            log('warn', `   ⚠️ Could not update shop data for "${shopName}": ${shopErr.message}`);
          }
        }

        audited++;
        log('success', `   ✅ Listing #${listing.listing_id} audited — Etsy social proof captured`);

      } catch (err) {
        log('error', `Error auditing ${listing.listing_id}: ${err.message}`);
      }
    }

    await sheetsClient.logRun('erank_listing_audit', audited > 0 ? 'SUCCESS' : 'FAILED',
      audited, audited, 0, '',
      `Etsy-only audit: ${audited} listings across ${byKeyword.size} keywords (no eRank credits used)`);

    log('success', `🏁 Step 3 DONE! ${audited} Etsy-only audits across ${byKeyword.size} keywords — zero eRank credits used`);
    return { audited };

  } catch (err) {
    log('error', `Step 3 failed: ${err.message}`);
    await sheetsClient.logRun('erank_listing_audit', 'FAILED', audited, audited, 0, err.message, '');
    throw err;
  }
}

function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url }, () => {
      const listener = (tId, changeInfo) => {
        if (tId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
    });
  });
}

function sendToTab(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response || {});
    });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
