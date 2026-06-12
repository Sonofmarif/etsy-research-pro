// Step 2: Etsy Search Snapshots Workflow
// Takes validated keywords, searches Etsy, extracts top N listings per keyword
// Evaluates each keyword for "beatable slots" (shops with low review counts)
// Returns qualification result — determines whether Steps 3 & 4 should run
//
// Capture vs audit split:
//   SNAPSHOT_CAPTURE_DEPTH  — ALL cards we persist from the Etsy search page
//                             (structural signal for concept clustering and
//                              admin-level aggregation; silent to the user).
//   maxListingsPerKw        — user-controlled audit depth (default 12, recommended
//                             ≤16). Drives beatable-slots, the kw "qualified" flag,
//                             and eRank credit consumption in Step 3. Changing this
//                             does NOT change how many rows we persist per keyword.
const SNAPSHOT_CAPTURE_DEPTH = 64;

// Detects junk keywords that should never be used as Etsy search queries.
//
// There are two layers of defense here:
//   (1) Step 1's eRank extractor has its own filter that runs at scrape time.
//   (2) This filter runs at Step 2 read time, so even if old garbage rows are
//       already sitting in pro_etsy_res_etsy_keywords from a previous broken
//       extractor version, we will refuse to snapshot them on Etsy.
// Updated 2026-04-08 after bad rows like "/ 13", "Copy Tags", "Search Trend"
// leaked past the older filter and burned eRank credit on bogus snapshots.
function isJunkKeyword(text) {
  if (!text) return true;
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower.length < 4) return true;  // "s", "39", "hi" — too short to be a real keyword
  // Pure numbers: "13", "2024"
  if (/^\d+$/.test(lower)) return true;
  // Leading slash — eRank UI strings often start with "/" (e.g. "/ 13")
  if (/^[\/\\]/.test(trimmed)) return true;
  // Strip leading "/" and spaces, then re-check pure digits: catches "/ 13"
  const stripped = trimmed.replace(/^[\/\\\s]+/, '').trim();
  if (/^\d+$/.test(stripped)) return true;
  // Starts with a number — "39 s", "2 pack", "1 piece" are fragments, not real keywords.
  // BUT allow 3+ word phrases like "67 days of school", "100 days of school shirt"
  // which are legitimate Etsy search keywords with high volume.
  if (/^\d+\s/.test(trimmed) && trimmed.split(/\s+/).length <= 2) return true;
  // Split into words for further checks
  const words = lower.split(/\s+/).filter(Boolean);
  // Short keywords (≤2 words) with a single-character word are fragments — "39 s", "s day"
  // Allow "i" and "a" (e.g. "a gift"). Don't flag 3+ word keywords like "mom t shirt".
  if (words.length <= 2) {
    const hasSingleCharJunk = words.some(w => w.length === 1 && w !== 'i' && w !== 'a');
    if (hasSingleCharJunk) return true;
  }
  // All words are ≤ 2 chars — "s t", "to do" — not meaningful keywords
  if (words.length >= 2 && words.every(w => w.length <= 2)) return true;
  // Known eRank / Etsy UI chrome strings that look like keywords
  const uiJunk = [
    'copy tags', 'copy tag', 'copy to clipboard', 'copy all',
    'search trends', 'search trend', 'search trending',
    'show filters', 'hide filters', 'clear filters',
    'categories', 'sort by', 'filter by',
    'bestseller', 'top seller', 'new seller',
    'menu', 'dashboard', 'settings', 'account',
    'log in', 'log out', 'sign in', 'sign out', 'sign up',
    'home favourites', 'home favorites', 'top gifts', 'trending now',
    'star seller', 'free shipping',
    // 2026-04-08: eRank listing-audit page field labels that leaked into
    // tag-derived keywords and concept cards ("Start Of Title", "In Description", etc.)
    'start of title', 'in title', 'in description', 'in tags',
    'title length', 'description length', 'tags count',
    'listing age', 'listing score', 'listing quality',
    'views', 'hearts', 'sales', 'conversion rate', 'conversion',
    'daily views', 'monthly views', 'estimated sales', 'est sales',
    'overview', 'details', 'recommendations', 'suggestions',
    'edit listing', 'view listing', 'open listing',
    'learn more', 'read more', 'show more', 'show less',
    'save changes', 'cancel', 'close', 'ok', 'next', 'back',
    'yes', 'no', 'on', 'off',
    'loading', 'please wait', 'error', 'success',
  ];
  if (uiJunk.includes(lower)) return true;
  // Catches short strings that are ONLY single navigation words (≤2 words,
  // no digits, and in a common-english verb/noun stop list). Cheap guard.
  const navOnly = new Set([
    'categories', 'shop', 'sell', 'cart', 'wishlist', 'help', 'about',
    'blog', 'faq', 'terms', 'privacy', 'policy', 'contact', 'support',
    'trending', 'popular', 'featured', 'explore', 'discover'
  ]);
  if (navOnly.has(lower)) return true;
  // eRank quality/warning labels — match both singular and plural forms
  const junkPatterns = [
    'keyword stuffing', 'possible typo', 'repeated word', 'repeated words',
    'repeated tag', 'repeated tags', 'misspelling', 'misspelled',
    'duplicate tag', 'duplicate tags', 'too long', 'too short',
    'single word', 'not relevant', 'low quality', 'quality issue',
    'character limit', 'special character', 'routine quotidienne', 'ma routine',
    // 2026-04-08: phrases from eRank warning cards and listing-audit sections
    'start of title', 'start of tag', 'end of title',
    'in description', 'in the description', 'in title', 'in the title',
    'in tags', 'in the tags', 'tag recommendation', 'tag recommendations',
    'recommended tag', 'recommended tags',
    'found in', 'not found in',
  ];
  for (const pat of junkPatterns) { if (lower.includes(pat)) return true; }
  if (/^[A-Za-z\s]+:\s+/i.test(trimmed) && !trimmed.includes('http')) return true;
  if (/^["'\u201c\u201d]/.test(trimmed) && /["'\u201c\u201d]/.test(trimmed)) return true;
  if (/appears\s+\d+\s+times?/i.test(lower)) return true;
  if (/\(\d+\)\s*$/.test(trimmed) && trimmed.split(/\s+/).length <= 2) return true;
  // Anything with a colon that looks like "Label: value" from a label-value UI
  if (/:/.test(trimmed) && trimmed.split(':').length === 2 && trimmed.split(/\s+/).length <= 4) return true;
  // Anything containing typical warning-card phrasing
  if (/^(possible|repeated|duplicate|misspelled|misspelling)\b/i.test(trimmed)) return true;
  return false;
}

// Exported so Step 3 + Step 4 can share the exact same filter
export { isJunkKeyword };

export async function runEtsySearchSnapshots(sheetsClient, tabId, config, log, seedKeyword, shouldStop, opts = {}) {
  if (!shouldStop) shouldStop = () => false;
  // pipelineRunId is required for writing per-user verdicts to user_keyword_results.
  // If the caller didn't pass one (standalone Step 2 run), we fall back to in-memory
  // only — no per-user DB write — and Step 4's fallback read will treat the run
  // as having no verdict snapshot.
  const pipelineRunId = (opts && (opts.pipelineRunId || opts.runId)) || null;
  const started = new Date().toISOString();
  let keywordsProcessed = 0, listingsFound = 0, snapshotsTaken = 0;

  // Track keyword qualification for niche verdict
  const keywordResults = []; // { keyword, qualified, beatableSlots, totalListings }

  try {
    let sheetConfig;
    try { sheetConfig = await sheetsClient.readConfig(); } catch(e) { sheetConfig = {}; }

    // Config priority: popup settings (config) > sheet config > hardcoded defaults
    // The user sets values in the popup UI — those must take precedence.
    // Use nullish coalescing so explicit 0 / "" from popup don't fall through.
    const cfg = (key, fallback) => {
      const popup = config != null ? config[key] : undefined;
      if (popup !== undefined && popup !== null && popup !== '') return popup;
      const db = sheetConfig != null ? sheetConfig[key] : undefined;
      if (db !== undefined && db !== null && db !== '') return db;
      return fallback;
    };

    const maxKeywords = cfg('max_keywords_per_run', 20);
    const delay = (cfg('delay_between_pages_sec', 5)) * 1000;
    // Issue 5: per-seed listing cap removed. The per-keyword cap (max_listings_per_keyword,
    // default 12) is the only operative limit now — no need to also cap the category total.
    // Setting to Infinity preserves all the existing log-line math without the cap ever firing.
    const maxListingsPerCat = Infinity;

    // Niche qualification settings
    const maxListingsPerKw = cfg('max_listings_per_keyword', 12);
    const minQualifiedKw = cfg('min_qualified_keywords', 5);
    const maxShopReviewsBeatable = cfg('max_shop_reviews_beatable', 300);
    const minBeatableSlots = cfg('min_beatable_slots', 3);

    // Product type filter — controls Etsy search URL parameter
    // 'digital'  → &instant_download=true   (only digital/instant-download listings)
    // 'physical' → &instant_download=false   (only physical items — Etsy's new default)
    // 'any'      → no parameter appended     (no filter, show everything)
    const productTypeFilter = cfg('product_type_filter', 'any');
    const productTypeParam = productTypeFilter === 'digital' ? '&instant_download=true'
                           : productTypeFilter === 'physical' ? '&instant_download=false'
                           : '';

    log('info', `⚙️ Qualification criteria: top ${maxListingsPerKw} listings/kw, need ${minBeatableSlots}+ shops under ${maxShopReviewsBeatable} reviews, need ${minQualifiedKw}+ qualified keywords`);
    log('info', `🏷️ Product type filter: ${productTypeFilter}${productTypeParam ? ' (' + productTypeParam.substring(1) + ')' : ' (no filter)'}`);

    // ─── Per-run device context ───
    // Collected ONCE per run and stamped on every snapshot row so we can
    // correlate SERP rank observations to the device that captured them.
    // IP / country / region / city / asn / as_organization are stamped
    // server-side by the Worker from Cloudflare's request headers — we
    // never send those from the client.
    const deviceContext = collectDeviceContext();
    log('info', `🖥️ Device context: ${deviceContext.user_agent ? deviceContext.user_agent.split(') ')[0] + ')' : 'n/a'} • ${deviceContext.screen_resolution} • UTC${deviceContext.timezone_offset >= 0 ? '+' : ''}${deviceContext.timezone_offset} • local hour ${deviceContext.hour_local}`);

    // Data freshness window. Popup config wins; falls back to DB config, then 48h.
    // 2026-04-18: priority inverted — user's popup setting now takes precedence.
    const FRESH_HOURS = parseInt(
      cfg('data_staleness_hours', null)
      ?? cfg('keyword_freshness_hours', null)
      ?? 48
    ) || 48;
    // Post-m2m migration: seed_keywords is read first so we can scope the
    // keywords read by seed_id. The Worker transparently rewrites
    // `?seed_id=X` on the keywords table into a JOIN through
    // pro_etsy_res_seed_keyword_map and aliases _skm.seed_id AS seed_id in
    // the response, so downstream code reading k.seed_id keeps working.
    const { rows: seeds } = await sheetsClient.readSheet('seed_keywords');

    // Find the seed for this run
    const seed = seeds.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!seed) {
      log('error', `Seed keyword "${seedKeyword}" not found in seed_keywords sheet`);
      await sheetsClient.logRun('etsy_search_snapshots', 'FAILED', 0, 0, 0, `Seed "${seedKeyword}" not found`, '');
      return { keywordsProcessed: 0, listingsFound: 0, nicheQualified: false, keywordResults: [] };
    }

    const seedId = String(seed.seed_id);
    log('info', `🎯 Locked onto seed "${seedKeyword}" (ID #${seedId})`);

    // 2026-04-17: Keywords read no longer uses the `updated_at` freshness
    // filter. The snapshot-always model below re-snapshots every selected
    // keyword every run, so the age of the keyword metadata row is irrelevant
    // — what matters is Etsy-side data, which we still filter via FRESH_HOURS
    // on the listings read (next line). The previous filter was producing
    // false-negative runs when a seed was rerun beyond 48h.
    const { rows: keywords } = await sheetsClient.readSheet('etsy_keywords', { seed_id: seedId });
    // 2026-04-22: seed-scoped (Worker JOINs through seed_keyword_map). Avoids
    // pulling every user's 48h listings just to count this seed's.
    const { rows: existingListings } = await sheetsClient.readSheet('etsy_listings', { seed_id: seedId }, { sinceHours: FRESH_HOURS, sinceColumn: 'updated_at' });

    // Count existing listings for this seed only
    const seedKwIds = new Set(keywords.filter(k => String(k.seed_id) === seedId).map(k => String(k.keyword_id)));
    let seedListingCount = existingListings.filter(l => seedKwIds.has(String(l.keyword_id))).length;
    log('info', `📊 Current state: ${seedKwIds.size} keywords linked to this seed, ${seedListingCount} listings collected`);

    // Find keywords to process — snapshot-always model: we re-snapshot every
    // non-junk keyword for the seed every run, regardless of snapshot_count or
    // prior status. Etsy shuffles rankings by IP/time/personalization, so
    // multiple snapshots per keyword give us richer data over time.
    //
    // The `snapshot_count = 0` gate that used to live here was causing reruns
    // to silently drop to 0-3 keywords and produce false-negative NO-GO
    // verdicts (see nursery seed, 2026-04-07). We now re-evaluate every
    // keyword every run and rely on the per-run cap (max_keywords_per_run) to
    // bound Etsy traffic.
    //
    // Keywords are ordered by oldest-last-snapshot-first (or never-snapshotted
    // first), so if the cap hits, the keywords most in need of a fresh
    // snapshot get priority.
    const available = keywords.filter(k => {
      if (String(k.seed_id) !== seedId) return false;
      const status = (k.status || '').toLowerCase();
      // Accept any keyword the pipeline has ever considered:
      //   pending      — never snapshotted
      //   validated    — Step 1 accepted it but Step 2 hasn't run
      //   qualified    — previous Step 2 run marked it as having beatable slots
      //   unqualified  — previous Step 2 run marked it as crowded
      // We re-snapshot all of them because Etsy rankings drift.
      if (status && status !== 'pending' && status !== 'validated'
          && status !== 'qualified' && status !== 'unqualified') {
        return false;
      }
      const kwText = (k.keyword || '').trim();
      if (isJunkKeyword(kwText)) {
        log('warn', `🗑️ Skipping junk keyword from sheet: "${kwText}"`);
        return false;
      }
      return true;
    });

    // Order: never-snapshotted first (oldest last_snapshot_at = ""), then
    // by oldest last_snapshot_at. This ensures stale/new keywords beat
    // recently-snapshotted ones when the per-run cap bites.
    available.sort((a, b) => {
      const aLast = a.last_snapshot_at || '';
      const bLast = b.last_snapshot_at || '';
      if (aLast === bLast) {
        // Tiebreak on created_at (older seeds first) for stability
        return (a.created_at || '').localeCompare(b.created_at || '');
      }
      return aLast.localeCompare(bLast);
    });

    const selected = available.slice(0, maxKeywords);
    if (selected.length === 0) {
      log('warn', `😴 No keywords found for "${seedKeyword}" — run Step 1 first to discover keywords.`);
      await sheetsClient.logRun('etsy_search_snapshots', 'SKIPPED', 0, 0, 0, '', `No keywords for "${seedKeyword}"`);
      return { keywordsProcessed: 0, listingsFound: 0, nicheQualified: false, keywordResults: [] };
    }

    const neverSnapshotted = selected.filter(k => !k.last_snapshot_at).length;
    const reSnapshotted = selected.length - neverSnapshotted;
    log('info', `🔎 Selected ${selected.length} keywords to snapshot on Etsy (${neverSnapshotted} new, ${reSnapshotted} re-snapshot)`);

    const existingListingIds = new Set(existingListings.map(l => String(l.listing_id)));

    for (const kw of selected) {
      if (shouldStop()) { log('warn', `🛑 Stop requested — halting Etsy snapshots`); break; }

      try {
        const keyword = (kw.keyword || '').trim();
        const kwIndex = selected.indexOf(kw) + 1;
        log('info', `🛒 [${kwIndex}/${selected.length}] Searching Etsy for: "${keyword}"`);

        // Navigate to Etsy search
        const url = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}${productTypeParam}`;
        await navigateTab(tabId, url);
        log('info', `⏳ Etsy is thinking... loading search results`);
        await sleep(delay);

        // Extract listings
        const result = await sendToTab(tabId, { action: 'extractEtsySearchResults' });

        if (!result.success) {
          log('warn', `⚠️ Extraction failed for "${keyword}": ${result.error}`);
          keywordResults.push({ keyword, qualified: false, beatableSlots: 0, totalListings: 0, reason: 'extraction_failed' });
          continue;
        }

        // Capture vs audit split:
        //   captured = ALL cards we persist (up to SNAPSHOT_CAPTURE_DEPTH = 64).
        //              Drives snapshot_hash, ads_count_top_n, listing_count, and
        //              the rows written to etsy_listings. This is structural
        //              signal for concept clustering and admin aggregation.
        //   auditSet = top maxListingsPerKw (user-controlled, default 12).
        //              Drives beatable-slots, the per-keyword "qualified" flag,
        //              and eRank audit credit consumption in Step 3.
        const allListings = result.listings || [];
        const captured = allListings.slice(0, SNAPSHOT_CAPTURE_DEPTH);
        const auditSet = captured.slice(0, maxListingsPerKw);

        // Debug: log a sample listing's key fields to verify extraction data arrives intact
        if (auditSet.length > 0) {
          const sample = auditSet[0];
          log('info', `🔍 Sample listing #${sample.listing_id}: shop_rating=${sample.shop_rating}, shop_reviews=${sample.shop_reviews}, shop=${sample.shop_name}`);
        }
        log('info', `🏪 Etsy returned ${allListings.length} cards for "${keyword}" — persisting ${captured.length}, auditing top ${auditSet.length}`);

        // ─── Keyword qualification: count beatable slots in the AUDIT set ───
        // A "beatable slot" is a listing in the top maxListingsPerKw where the
        // shop has fewer than maxShopReviewsBeatable reviews (default 300).
        // Qualification is always computed on the audit set, not the full
        // captured set — otherwise raising capture depth would silently change
        // the qualification math.
        let beatableSlots = 0;
        for (const l of auditSet) {
          const shopRevs = parseInt(l.shop_reviews) || 0;
          if (shopRevs < maxShopReviewsBeatable) beatableSlots++;
        }

        const kwQualified = beatableSlots >= minBeatableSlots;
        const qualEmoji = kwQualified ? '✅' : '❌';
        log('info', `${qualEmoji} "${keyword}" → ${beatableSlots}/${auditSet.length} beatable slots (need ${minBeatableSlots}) → ${kwQualified ? 'QUALIFIED' : 'NOT QUALIFIED'}`);

        keywordResults.push({
          keyword,
          keyword_id: kw.keyword_id,
          qualified: kwQualified,
          beatableSlots,
          totalListings: auditSet.length,
          reason: kwQualified ? 'passed' : `only ${beatableSlots} beatable slots`
        });

        // Create snapshot — let MySQL AUTO_INCREMENT assign the snapshot_id.
        // Hash + ads count + listing_count are computed over the full captured
        // set so snapshot fingerprinting stays stable regardless of audit depth.
        const now = new Date().toISOString();
        const orderedCapturedIds = captured
          .map(l => l && l.listing_id)
          .filter(id => id != null)
          .map(String);
        const snapshotHash = await sha1Hex(orderedCapturedIds.join('|'));
        const adsCount = captured.reduce((acc, l) => acc + (l && (l.is_ad || l.promoted) ? 1 : 0), 0);

        const snapshotResult = await sheetsClient.appendRowsByName('etsy_search_snapshots', [{
          keyword_id: kw.keyword_id,
          keyword_text: keyword,
          page_number: 1,
          search_type: 'regular',
          snapshot_date: now,
          listing_count: captured.length,
          notes: '',
          // Device context (server stamps the network/geo half from CF)
          user_agent: deviceContext.user_agent,
          screen_resolution: deviceContext.screen_resolution,
          timezone_offset: deviceContext.timezone_offset,
          hour_local: deviceContext.hour_local,
          is_logged_in: deviceContext.is_logged_in,
          // Snapshot fingerprint (detects reshuffles run-over-run)
          snapshot_hash: snapshotHash,
          ads_count_top_n: adsCount
        }]);
        const snapshotId = snapshotResult && snapshotResult.first_insert_id ? snapshotResult.first_insert_id : 0;
        snapshotsTaken++;

        // Write listings — enforce per-seed cap mid-extraction
        // Uses appendRowsByName to map by column name, NOT position.
        // This prevents column-shift bugs when sheet headers differ from code assumptions.
        const listingRowObjects = [];
        const newStores = new Map(); // shop_name → { shop_rating, shop_reviews }
        // Helper: convert value to string, preserving 0 as "0" (|| '' would lose it)
        const v = (val) => (val !== undefined && val !== null && val !== '') ? String(val) : '';

        for (const l of captured) {
          if (!l.listing_id) continue;

          // etsy_listings columns match the Google Sheet headers exactly.
          // NOTE: rating & review_count are LISTING-level metrics — populated in Step 3 (audit).
          // shop_rating & shop_reviews are SHOP-level and go to etsy_stores instead.
          // urgency_text is NOT available on Etsy search snapshot cards — only on
          // individual listing pages — so we always write it blank from Step 2.
          // Bestseller / popular_now tags ARE visible on search cards, so those
          // are kept.
          listingRowObjects.push({
            listing_id: l.listing_id,
            keyword_id: kw.keyword_id,
            snapshot_id: snapshotId,
            shop_name: v(l.shop_name),
            title: v(l.title),
            price: v(l.price),
            original_price: v(l.original_price),
            discount_pct: v(l.discount_pct),
            rating: '',         // Listing-level — filled by Step 3 audit
            review_count: '',   // Listing-level — filled by Step 3 audit
            is_digital: l.is_digital ? 'TRUE' : 'FALSE',
            is_bestseller: l.is_bestseller ? 'TRUE' : 'FALSE',
            is_popular_now: l.is_popular_now ? 'TRUE' : 'FALSE',
            search_position: v(l.search_position),
            run_number: '1',
            snapshot_date: now,
            etsy_url: v(l.etsy_url),
            thumbnail_url: v(l.thumbnail_url),
            urgency_text: '',   // Not available on search snapshot cards
            free_delivery: l.free_delivery ? 'TRUE' : 'FALSE'
          });

          // Collect shop-level data (rating & reviews from search cards are SHOP metrics)
          if (l.shop_name) {
            newStores.set(l.shop_name, {
              shop_rating: l.shop_rating || null,
              shop_reviews: l.shop_reviews || 0
            });
          }
          seedListingCount++;
        }

        // Batch write listings by column name
        if (listingRowObjects.length > 0) {
          for (let i = 0; i < listingRowObjects.length; i += 50) {
            await sheetsClient.appendRowsByName('etsy_listings', listingRowObjects.slice(i, i + 50));
          }
          listingsFound += listingRowObjects.length;
        }

        // Upsert stores — refresh shop_rating + shop_review_count for every shop
        // we saw in today's search cards, not just newly-discovered ones.
        // 2026-04-17: previously we only INSERTed shops not already in the DB,
        // which meant shops discovered in prior runs kept whatever (often null)
        // rating Step 2 captured the first time. Result: report's non-audited
        // listing cards rendered "★ 0.0 · N reviews" even when Etsy's search
        // cards clearly show the shop's rating — because the stores row never
        // got updated. Now we always upsert, and the Worker's
        // INSERT ... ON DUPLICATE KEY UPDATE refreshes those fields on every
        // run.
        //
        // Payload is built conditionally — we only include shop_rating /
        // shop_review_count when today's card actually had them. This avoids
        // the case where an Etsy card omits the rating (shop has zero reviews,
        // or the card layout varied) and we'd otherwise overwrite a previously-
        // good value with null/empty. Columns not in the payload aren't in the
        // ON DUPLICATE KEY UPDATE clause, so MariaDB leaves them alone.
        const storeRowObjects = [];
        for (const [shopName, shopData] of newStores) {
          const row = { shop_name: shopName, source: 'search_snapshot' };
          // Only include rating if we actually got a non-empty numeric value
          const ratingVal = shopData.shop_rating;
          if (ratingVal !== null && ratingVal !== undefined && ratingVal !== '' && !Number.isNaN(parseFloat(ratingVal))) {
            row.shop_rating = String(ratingVal);
          }
          const reviewsVal = shopData.shop_reviews;
          if (reviewsVal !== null && reviewsVal !== undefined && reviewsVal !== '' && !Number.isNaN(parseInt(reviewsVal))) {
            row.shop_review_count = String(reviewsVal);
          }
          storeRowObjects.push(row);
        }
        if (storeRowObjects.length > 0) {
          // Batch-upsert all stores for this keyword in a single HTTP call.
          // The Worker's handleUpsert accepts { rows: [...] } and runs
          // INSERT ... ON DUPLICATE KEY UPDATE per row server-side, all
          // over one DB connection.
          try {
            await sheetsClient.upsertRowsBatch('etsy_stores', storeRowObjects);
            log('info', `🏬 Upserted ${storeRowObjects.length} shop(s) with today's ratings — refreshes existing rows, inserts new ones`);
          } catch (storeErr) {
            // Fall back to the old per-row path so a single bad shop row
            // can't block the whole keyword.
            log('warn', `⚠️ Batch store upsert failed (${storeErr.message}) — falling back to per-row`);
            let perRowOk = 0;
            for (const store of storeRowObjects) {
              try {
                await sheetsClient.upsertRow('etsy_stores', 'shop_name', store.shop_name, store);
                perRowOk++;
              } catch (_) { /* skip bad row */ }
            }
            log('info', `🏬 Upserted ${perRowOk}/${storeRowObjects.length} shop(s) via per-row fallback`);
          }
        }

        // Update keyword snapshot metadata only. snapshot_count now increments
        // on every run (snapshot-always model) rather than being a 0/1 flag.
        // 2026-04-17: We no longer write status='qualified'|'unqualified' here.
        // Qualification is per-user (different users have different thresholds)
        // and lives in pro_etsy_res_user_keyword_results, scoped by run_id.
        // Writing the verdict to the shared keywords row used to cause User A's
        // "unqualified" to silently overwrite User B's "qualified" on the same
        // seed. status now only carries data-freshness state ('pending' for
        // newly-discovered, 'validated' once Step 1 populates metrics), which
        // is what the gate actually needs.
        const priorCount = parseInt(kw.snapshot_count) || 0;
        await sheetsClient.updateRowByMatch('etsy_keywords', 'keyword_id', kw.keyword_id, {
          snapshot_count: priorCount + 1,
          last_snapshot_at: now,
          status: 'validated'
        });

        keywordsProcessed++;
        const qualSoFar = keywordResults.filter(r => r.qualified).length;
        log('success', `📸 Snapshot done for "${keyword}": ${listingRowObjects.length} listings captured (${seedListingCount} total for this seed) | ${qualSoFar} qualified so far`);

        // Post-mortem marker: write the last-completed keyword to storage so
        // if the service worker dies mid-loop anyway, we can see exactly
        // where it stopped on next reload instead of staring at a frozen log.
        try {
          await chrome.storage.local.set({
            step2LastProgress: {
              seedKeyword,
              lastCompletedKeyword: keyword,
              lastCompletedIndex: kwIndex,
              totalKeywords: selected.length,
              completedAt: new Date().toISOString()
            }
          });
        } catch (_) { /* storage failures should not block the loop */ }

        // Extra delay between keywords
        log('info', `💤 Brief cooldown before next keyword...`);
        await sleep(5000);

      } catch (err) {
        log('error', `Error with "${kw.keyword}": ${err.message}`);
      }
    }

    // ─── Niche qualification verdict ───
    const qualifiedCount = keywordResults.filter(r => r.qualified).length;
    const totalProcessed = keywordResults.length;
    const nicheQualified = qualifiedCount >= minQualifiedKw;

    const verdictEmoji = nicheQualified ? '🟢' : '🔴';
    log('info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    log(nicheQualified ? 'success' : 'warn',
      `${verdictEmoji} NICHE VERDICT: ${qualifiedCount}/${totalProcessed} keywords qualified (need ${minQualifiedKw}) → ${nicheQualified ? 'GO — proceed to audit' : 'NO-GO — not enough entry points'}`);
    log('info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // ─── Persist per-user verdicts to user_keyword_results ───
    // 2026-04-17: each user's qualified/unqualified verdict now lives here,
    // scoped by run_id. user_runs carries user_id, so two users researching
    // the same seed keep independent verdicts.
    // Unique key is (run_id, keyword_id) — upsert is idempotent on re-run.
    if (pipelineRunId && keywordResults.length > 0) {
      const userKwRows = keywordResults
        .filter(r => r.keyword_id)
        .map(r => ({
          run_id: pipelineRunId,
          keyword_id: r.keyword_id,
          beatable_slots: r.beatableSlots || 0,
          total_listings: r.totalListings || 0,
          qualified: r.qualified ? 1 : 0,
          reason: (r.reason || '').slice(0, 250),
        }));
      if (userKwRows.length > 0) {
        try {
          await sheetsClient.upsertRowsBatch('user_keyword_results', userKwRows);
          log('info', `💾 Persisted ${userKwRows.length} per-user verdict(s) to user_keyword_results (run_id=${pipelineRunId})`);
        } catch (e) {
          log('warn', `⚠️ Failed to write user_keyword_results (${e.message}) — Step 4 will fall back to in-memory verdict`);
        }
      }
    } else if (!pipelineRunId) {
      log('info', `ℹ️ No pipelineRunId — skipping user_keyword_results persistence (Step 4 will use in-memory verdict only)`);
    }

    if (!nicheQualified) {
      log('warn', `⏭️ Skipping Steps 3 & 4 — niche does not meet qualification criteria`);
      log('info', `💡 Only ${qualifiedCount} keywords had ${minBeatableSlots}+ shops with under ${maxShopReviewsBeatable} reviews in the top ${maxListingsPerKw}. The top spots are dominated by established shops.`);
    }

    // ─── Pre-audit ranking ───
    // 2026-04-18: audit_keyword_pct removed. Originally throttled Step 3 to a
    // fraction of qualified keywords because each audit consumed an eRank
    // credit. Step 3 is now Etsy-only (no eRank credits) so the only constraint
    // is total audit count — capped by `audit_keyword_max` (default 40).
    // Audit ALL qualified keywords up to that cap, ranked by opportunity.
    // Popup setting wins over DB sheetConfig (user wants in-extension control).
    const auditMax = Math.max(1, parseInt(
      (config && (config.audit_keyword_max != null) ? config.audit_keyword_max : null)
      ?? sheetConfig.audit_keyword_max
      ?? 40
    ) || 40);

    const rankedResults = [...keywordResults]
      .filter(kr => kr.qualified || kr.beatableSlots > 0)
      .map(kr => {
        const kw = selected.find(k => String(k.keyword_id) === String(kr.keyword_id));
        const searches = kw ? (parseFloat(kw.avg_searches) || 0) : 0;
        const ratio = kr.totalListings > 0 ? kr.beatableSlots / kr.totalListings : 0;
        return { ...kr, searches, prelimScore: searches * ratio };
      })
      .sort((a, b) => b.prelimScore - a.prelimScore);

    const topKeywordIds = rankedResults.slice(0, auditMax).map(kr => String(kr.keyword_id));
    log('info', `📊 Pre-audit ranking: ${rankedResults.length} qualified candidates → top ${topKeywordIds.length} selected for Step 3 audit (cap=${auditMax})`);

    // Store qualification result for the pipeline to read.
    // snapshotCaptureDepth is included so Step 4 knows how many listings per
    // keyword were persisted (the structural signal) vs how many were audited.
    await chrome.storage.local.set({
      nicheQualification: {
        seedKeyword,
        nicheQualified,
        qualifiedCount,
        totalProcessed,
        minQualifiedKw,
        maxShopReviewsBeatable,
        minBeatableSlots,
        maxListingsPerKw,
        snapshotCaptureDepth: SNAPSHOT_CAPTURE_DEPTH,
        keywordResults,
        topKeywordIds,
        auditCount: topKeywordIds.length,
        evaluatedAt: new Date().toISOString()
      }
    });

    await sheetsClient.logRun('etsy_search_snapshots', keywordsProcessed > 0 ? 'SUCCESS' : 'FAILED',
      keywordsProcessed, listingsFound, 0, '',
      `Keywords: ${keywordsProcessed}, Listings: ${listingsFound}, Qualified: ${qualifiedCount}/${totalProcessed}, Niche: ${nicheQualified ? 'GO' : 'NO-GO'}`);

    log('success', `🏁 Step 2 DONE! ${keywordsProcessed} keywords searched → ${listingsFound} listings captured → ${qualifiedCount}/${totalProcessed} keywords qualified`);
    return { keywordsProcessed, listingsFound, snapshotsTaken, nicheQualified, qualifiedCount, totalProcessed, keywordResults };

  } catch (err) {
    log('error', `Step 2 failed: ${err.message}`);
    await sheetsClient.logRun('etsy_search_snapshots', 'FAILED', keywordsProcessed, listingsFound, 0, err.message, '');
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

// ─── Device context (per-snapshot fingerprint) ───
// Collected from the service worker context. screen / navigator may not exist
// in the SW global scope on all Chrome versions, so each lookup is guarded.
// IP / country / city / asn / as_organization are NOT collected here — those
// are stamped server-side by the Worker from Cloudflare's request headers,
// which the client can't spoof.
function collectDeviceContext() {
  let userAgent = '';
  try { if (typeof navigator !== 'undefined' && navigator.userAgent) userAgent = String(navigator.userAgent); } catch {}

  let screenRes = '';
  try {
    if (typeof self !== 'undefined' && self.screen && self.screen.width) {
      screenRes = `${self.screen.width}x${self.screen.height}`;
    }
  } catch {}

  // getTimezoneOffset returns minutes WEST of UTC, so flip the sign so that
  // e.g. UTC+5 becomes 5.0 not -5.0.
  let tzOffset = 0;
  try { tzOffset = -(new Date().getTimezoneOffset()) / 60; } catch {}

  let hourLocal = 0;
  try { hourLocal = new Date().getHours(); } catch {}

  return {
    user_agent: userAgent.slice(0, 500),
    screen_resolution: screenRes.slice(0, 20),
    timezone_offset: Number.isFinite(tzOffset) ? tzOffset : 0,
    hour_local: hourLocal,
    is_logged_in: 0  // Placeholder — extension does not currently track Etsy login state
  };
}

// SHA-1 hex of an arbitrary string. Used for snapshot_hash so we can detect
// when Etsy returns the same ordered top-N for a keyword across runs.
async function sha1Hex(input) {
  try {
    const data = new TextEncoder().encode(String(input || ''));
    const buf = await crypto.subtle.digest('SHA-1', data);
    const bytes = new Uint8Array(buf);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  } catch {
    return '';
  }
}
