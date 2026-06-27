// Etsy Research Pro — Etsy Search Snapshots Workflow
// Built from scratch to capture SERP listing positions, extract shop review stats,
// and evaluate niche viability while avoiding verbatim third-party code.

const PERSISTENCE_DEPTH_LIMIT = 64;

/**
 * Validates search query text to filter out eRank/Etsy UI artifacts and scrap fragments.
 */
function isJunkKeyword(text) {
  if (!text) return true;
  const rawText = text.trim();
  const lowerText = rawText.toLowerCase();

  // Filter extremely short items (under 4 characters)
  if (lowerText.length < 4) return true;

  // Filter numeric values
  if (/^\d+$/.test(lowerText)) return true;

  // Filter strings beginning with a slash
  if (/^[\/\\]/.test(rawText)) return true;

  // Filter patterns starting with a slash and trailing numbers
  const cleanedSlash = rawText.replace(/^[\/\\\s]+/, '').trim();
  if (/^\d+$/.test(cleanedSlash)) return true;

  // Filter numeric fragments (e.g., "3 items") but allow full search terms (e.g., "100 days of school shirt")
  if (/^\d+\s/.test(rawText) && rawText.split(/\s+/).length <= 2) return true;

  const words = lowerText.split(/\s+/).filter(Boolean);

  // Filter single character abbreviations/junk in short terms
  if (words.length <= 2) {
    const hasSingleCharJunk = words.some(w => w.length === 1 && w !== 'i' && w !== 'a');
    if (hasSingleCharJunk) return true;
  }

  // Filter terms composed entirely of tiny words
  if (words.length >= 2 && words.every(w => w.length <= 2)) return true;

  // Common UI words and headers that bleed into tags
  const uiChromeTerms = [
    'copy tags', 'copy tag', 'copy to clipboard', 'copy all',
    'search trends', 'search trend', 'search trending',
    'show filters', 'hide filters', 'clear filters',
    'categories', 'sort by', 'filter by',
    'bestseller', 'top seller', 'new seller',
    'menu', 'dashboard', 'settings', 'account',
    'log in', 'log out', 'sign in', 'sign out', 'sign up',
    'home favourites', 'home favorites', 'top gifts', 'trending now',
    'star seller', 'free shipping',
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
    'loading', 'please wait', 'error', 'success'
  ];
  if (uiChromeTerms.includes(lowerText)) return true;

  // Navigational terms
  const navigationTerms = new Set([
    'categories', 'shop', 'sell', 'cart', 'wishlist', 'help', 'about',
    'blog', 'faq', 'terms', 'privacy', 'policy', 'contact', 'support',
    'trending', 'popular', 'featured', 'explore', 'discover'
  ]);
  if (navigationTerms.has(lowerText)) return true;

  // Common system descriptions or diagnostics
  const systemWarnings = [
    'keyword stuffing', 'possible typo', 'repeated word', 'repeated words',
    'repeated tag', 'repeated tags', 'misspelling', 'misspelled',
    'duplicate tag', 'duplicate tags', 'too long', 'too short',
    'single word', 'not relevant', 'low quality', 'quality issue',
    'character limit', 'special character', 'routine quotidienne', 'ma routine',
    'start of title', 'start of tag', 'end of title',
    'in description', 'in the description', 'in title', 'in the title',
    'in tags', 'in the tags', 'tag recommendation', 'tag recommendations',
    'recommended tag', 'recommended tags',
    'found in', 'not found in'
  ];
  for (const pattern of systemWarnings) {
    if (lowerText.includes(pattern)) return true;
  }

  // Key-value representations, parentheses, and duplicates
  if (/^[A-Za-z\s]+:\s+/i.test(rawText) && !rawText.includes('http')) return true;
  if (/^["'\u201c\u201d]/.test(rawText) && /["'\u201c\u201d]/.test(rawText)) return true;
  if (/appears\s+\d+\s+times?/i.test(lowerText)) return true;
  if (/\(\d+\)\s*$/.test(rawText) && rawText.split(/\s+/).length <= 2) return true;
  if (/:/.test(rawText) && rawText.split(':').length === 2 && rawText.split(/\s+/).length <= 4) return true;
  if (/^(possible|repeated|duplicate|misspelled|misspelling)\b/i.test(rawText)) return true;

  return false;
}

export { isJunkKeyword };

/**
 * Navigates a target tab to a specified URL and waits for load completion.
 */
function updateTabUrlAndWait(tabId, targetUrl) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, { url: targetUrl }, () => {
      const completionListener = (updatedTabId, changeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(completionListener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(completionListener);
      // Fallback timeout at 30 seconds
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(completionListener);
        resolve();
      }, 30000);
    });
  });
}

/**
 * Sends a message to a Chrome tab and returns the response as a promise.
 */
function sendMessageToTabPromise(tabId, payload) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response || {});
      }
    });
  });
}

/**
 * Helper to pause execution.
 */
function delayExecution(milliseconds) {
  return new Promise(res => setTimeout(res, milliseconds));
}

/**
 * Gathers details about the extension runtime environment for logging metadata.
 */
function gatherBrowserEnvironment() {
  let agentString = '';
  try {
    if (typeof navigator !== 'undefined' && navigator.userAgent) {
      agentString = String(navigator.userAgent);
    }
  } catch {}

  let resolution = '';
  try {
    if (typeof self !== 'undefined' && self.screen && self.screen.width) {
      resolution = `${self.screen.width}x${self.screen.height}`;
    }
  } catch {}

  let offsetHours = 0;
  try {
    offsetHours = -(new Date().getTimezoneOffset()) / 60;
  } catch {}

  let localHour = 0;
  try {
    localHour = new Date().getHours();
  } catch {}

  return {
    user_agent: agentString.slice(0, 500),
    screen_resolution: resolution.slice(0, 20),
    timezone_offset: Number.isFinite(offsetHours) ? offsetHours : 0,
    hour_local: localHour,
    is_logged_in: 0
  };
}

/**
 * Calculates SHA-1 Hex signature of an input string for indexing snapshots.
 */
async function computeSha1Signature(inputString) {
  try {
    const dataBuffer = new TextEncoder().encode(String(inputString || ''));
    const hashBuffer = await crypto.subtle.digest('SHA-1', dataBuffer);
    const hashArray = new Uint8Array(hashBuffer);
    let hexResult = '';
    for (let i = 0; i < hashArray.length; i++) {
      hexResult += hashArray[i].toString(16).padStart(2, '0');
    }
    return hexResult;
  } catch {
    return '';
  }
}

/**
 * Workflow runner that processes keywords, grabs search layouts, and checks niche viability.
 */
export async function runEtsySearchSnapshots(sheetsClient, tabId, config, logCallback, seedKeyword, checkStopSignal, options = {}) {
  if (!checkStopSignal) checkStopSignal = () => false;
  const pipelineRunId = (options && (options.pipelineRunId || options.runId)) || null;
  const startTimestamp = new Date().toISOString();
  
  let processedKeywordsCount = 0;
  let accumulatedListingsCount = 0;
  let snapshotsCreatedCount = 0;

  const keywordAssessmentResults = [];

  try {
    let databaseConfig;
    try {
      databaseConfig = await sheetsClient.readConfig();
    } catch (e) {
      databaseConfig = {};
    }

    // Settings Resolution: popup configuration takes priority
    const getSetting = (settingKey, defaultVal) => {
      const popupVal = config != null ? config[settingKey] : undefined;
      if (popupVal !== undefined && popupVal !== null && popupVal !== '') return popupVal;
      const dbVal = databaseConfig != null ? databaseConfig[settingKey] : undefined;
      if (dbVal !== undefined && dbVal !== null && dbVal !== '') return dbVal;
      return defaultVal;
    };

    const maxKeywordsCount = getSetting('max_keywords_per_run', 20);
    const queryDelay = getSetting('delay_between_pages_sec', 5) * 1000;
    
    // Niche parameters
    const auditLimitPerKeyword = getSetting('max_listings_per_keyword', 12);
    const requiredQualifiedKeywords = getSetting('min_qualified_keywords', 5);
    const reviewsUpperBoundary = getSetting('max_shop_reviews_beatable', 300);
    const requiredBeatableSlots = getSetting('min_beatable_slots', 3);

    // Product filtration parameters
    const productTypeFilter = getSetting('product_type_filter', 'any');
    const productUrlParam = productTypeFilter === 'digital' ? '&instant_download=true'
                          : productTypeFilter === 'physical' ? '&instant_download=false'
                          : '';

    logCallback('info', `⚙️ Criteria: audit top ${auditLimitPerKeyword} listings, require ${requiredBeatableSlots}+ shops with reviews < ${reviewsUpperBoundary}, need ${requiredQualifiedKeywords}+ qualified keywords`);
    logCallback('info', `🏷️ Product type setting: ${productTypeFilter}`);

    const runtimeEnv = gatherBrowserEnvironment();
    logCallback('info', `🖥️ Environment initialized: ${runtimeEnv.user_agent ? runtimeEnv.user_agent.split(') ')[0] + ')' : 'n/a'} • ${runtimeEnv.screen_resolution}`);

    const dataStalenessWindow = parseInt(
      getSetting('data_staleness_hours', null)
      ?? getSetting('keyword_freshness_hours', null)
      ?? 48
    ) || 48;

    // Retrieve active seeds
    const { rows: seedsList } = await sheetsClient.readSheet('seed_keywords');
    const activeSeed = seedsList.find(s => (s.keyword || '').toLowerCase().trim() === seedKeyword.toLowerCase().trim());
    if (!activeSeed) {
      logCallback('error', `Seed keyword "${seedKeyword}" not found in seed_keywords`);
      await sheetsClient.logRun('etsy_search_snapshots', 'FAILED', 0, 0, 0, `Seed "${seedKeyword}" not found`, '');
      return { keywordsProcessed: 0, listingsFound: 0, nicheQualified: false, keywordResults: [] };
    }

    const currentSeedId = String(activeSeed.seed_id);
    logCallback('info', `🎯 Seed verified: "${seedKeyword}" (ID: ${currentSeedId})`);

    // Pull keywords and existing listings
    const { rows: keywordsList } = await sheetsClient.readSheet('etsy_keywords', { seed_id: currentSeedId });
    const { rows: savedListings } = await sheetsClient.readSheet('etsy_listings', { seed_id: currentSeedId }, { sinceHours: dataStalenessWindow, sinceColumn: 'updated_at' });

    const seedKeywordIds = new Set(keywordsList.filter(k => String(k.seed_id) === currentSeedId).map(k => String(k.keyword_id)));
    let matchingListingsCount = savedListings.filter(l => seedKeywordIds.has(String(l.keyword_id))).length;
    logCallback('info', `📊 Current state: ${seedKeywordIds.size} keywords in seed, ${matchingListingsCount} listings cached`);

    // Filter candidate keywords
    const candidateKeywords = keywordsList.filter(k => {
      if (String(k.seed_id) !== currentSeedId) return false;
      const currentStatus = (k.status || '').toLowerCase();
      
      // Process pending, validated, and previously-classified keywords to allow updating rankings
      if (currentStatus && currentStatus !== 'pending' && currentStatus !== 'validated'
          && currentStatus !== 'qualified' && currentStatus !== 'unqualified') {
        return false;
      }
      
      const queryTerm = (k.keyword || '').trim();
      if (isJunkKeyword(queryTerm)) {
        logCallback('warn', `🗑️ Skipping invalid UI term: "${queryTerm}"`);
        return false;
      }
      return true;
    });

    // Sort to prioritize fresh keywords and older snapshots
    candidateKeywords.sort((a, b) => {
      const lastSnapA = a.last_snapshot_at || '';
      const lastSnapB = b.last_snapshot_at || '';
      if (lastSnapA === lastSnapB) {
        return (a.created_at || '').localeCompare(b.created_at || '');
      }
      return lastSnapA.localeCompare(lastSnapB);
    });

    const targetKeywords = candidateKeywords.slice(0, maxKeywordsCount);
    if (targetKeywords.length === 0) {
      logCallback('warn', `😴 No keywords ready to process. Run Step 1 keyword lookup first.`);
      await sheetsClient.logRun('etsy_search_snapshots', 'SKIPPED', 0, 0, 0, '', `No keywords ready for "${seedKeyword}"`);
      return { keywordsProcessed: 0, listingsFound: 0, nicheQualified: false, keywordResults: [] };
    }

    logCallback('info', `🔎 Selected ${targetKeywords.length} keywords for snapshot runs (${targetKeywords.filter(k => !k.last_snapshot_at).length} brand new)`);

    for (const kwItem of targetKeywords) {
      if (checkStopSignal()) {
        logCallback('warn', `🛑 Cancellation triggered — stopping snapshot routine`);
        break;
      }

      try {
        const query = (kwItem.keyword || '').trim();
        const currentIndex = targetKeywords.indexOf(kwItem) + 1;
        logCallback('info', `🛒 [${currentIndex}/${targetKeywords.length}] Searching Etsy: "${query}"`);

        const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(query)}${productUrlParam}`;
        await updateTabUrlAndWait(tabId, searchUrl);
        logCallback('info', `⏳ Awaiting Etsy search layout loading...`);
        await delayExecution(queryDelay);

        const scrapeResponse = await sendMessageToTabPromise(tabId, { action: 'extractEtsySearchResults' });
        if (!scrapeResponse.success) {
          logCallback('warn', `⚠️ Extraction failed for "${query}": ${scrapeResponse.error}`);
          keywordAssessmentResults.push({ keyword: query, qualified: false, beatableSlots: 0, totalListings: 0, reason: 'extraction_failed' });
          continue;
        }

        const foundCards = scrapeResponse.listings || [];
        const captureSlice = foundCards.slice(0, PERSISTENCE_DEPTH_LIMIT);
        const auditSlice = captureSlice.slice(0, auditLimitPerKeyword);

        if (auditSlice.length > 0) {
          const sampleCard = auditSlice[0];
          logCallback('info', `🔍 Sample output -> Shop: ${sampleCard.shop_name} | Rating: ${sampleCard.shop_rating} | Reviews: ${sampleCard.shop_reviews}`);
        }
        logCallback('info', `🏪 Found ${foundCards.length} cards. Persisting ${captureSlice.length}, auditing top ${auditSlice.length}`);

        // Analyze beatable slots
        let vulnerableSpots = 0;
        for (const listing of auditSlice) {
          if (listing.shop_reviews !== null && listing.shop_reviews !== undefined) {
            const reviews = parseInt(listing.shop_reviews);
            if (!Number.isNaN(reviews) && reviews < reviewsUpperBoundary) {
              vulnerableSpots++;
            }
          }
        }

        const isViable = vulnerableSpots >= requiredBeatableSlots;
        logCallback('info', `${isViable ? '✅' : '❌'} "${query}" -> ${vulnerableSpots}/${auditSlice.length} beatable slots (need ${requiredBeatableSlots}) -> ${isViable ? 'QUALIFIED' : 'NOT QUALIFIED'}`);

        keywordAssessmentResults.push({
          keyword: query,
          keyword_id: kwItem.keyword_id,
          qualified: isViable,
          beatableSlots: vulnerableSpots,
          totalListings: auditSlice.length,
          reason: isViable ? 'passed' : `only ${vulnerableSpots} beatable slots`
        });

        // Compute fingerprint hash for snapshot tracking
        const timestamp = new Date().toISOString();
        const idFingerprint = captureSlice
          .map(l => l && l.listing_id)
          .filter(id => id != null)
          .map(String);
        const layoutHash = await computeSha1Signature(idFingerprint.join('|'));
        const adsCount = captureSlice.reduce((sum, l) => sum + (l && (l.is_ad || l.promoted) ? 1 : 0), 0);

        const snapshotWriteResult = await sheetsClient.appendRowsByName('etsy_search_snapshots', [{
          keyword_id: kwItem.keyword_id,
          keyword_text: query,
          page_number: 1,
          search_type: 'regular',
          snapshot_date: timestamp,
          listing_count: captureSlice.length,
          notes: '',
          user_agent: runtimeEnv.user_agent,
          screen_resolution: runtimeEnv.screen_resolution,
          timezone_offset: runtimeEnv.timezone_offset,
          hour_local: runtimeEnv.hour_local,
          is_logged_in: runtimeEnv.is_logged_in,
          snapshot_hash: layoutHash,
          ads_count_top_n: adsCount
        }]);

        const assignedSnapshotId = snapshotWriteResult && snapshotWriteResult.first_insert_id ? snapshotWriteResult.first_insert_id : 0;
        snapshotsCreatedCount++;

        const listingRows = [];
        const shopMappings = new Map();
        const cleanString = (val) => (val !== undefined && val !== null && val !== '') ? String(val) : '';

        for (const item of captureSlice) {
          if (!item.listing_id) continue;

          listingRows.push({
            listing_id: item.listing_id,
            keyword_id: kwItem.keyword_id,
            snapshot_id: assignedSnapshotId,
            shop_name: cleanString(item.shop_name),
            title: cleanString(item.title),
            price: cleanString(item.price),
            original_price: cleanString(item.original_price),
            discount_pct: cleanString(item.discount_pct),
            rating: '',
            review_count: '',
            is_digital: item.is_digital ? 'TRUE' : 'FALSE',
            is_bestseller: item.is_bestseller ? 'TRUE' : 'FALSE',
            is_popular_now: item.is_popular_now ? 'TRUE' : 'FALSE',
            search_position: cleanString(item.search_position),
            run_number: '1',
            snapshot_date: timestamp,
            etsy_url: cleanString(item.etsy_url),
            thumbnail_url: cleanString(item.thumbnail_url),
            urgency_text: '',
            free_delivery: item.free_delivery ? 'TRUE' : 'FALSE'
          });

          if (item.shop_name) {
            shopMappings.set(item.shop_name, {
              shop_rating: item.shop_rating !== undefined ? item.shop_rating : null,
              shop_reviews: item.shop_reviews !== undefined ? item.shop_reviews : null
            });
          }
          matchingListingsCount++;
        }

        // Commit listings in batches
        if (listingRows.length > 0) {
          for (let startIdx = 0; startIdx < listingRows.length; startIdx += 50) {
            await sheetsClient.appendRowsByName('etsy_listings', listingRows.slice(startIdx, startIdx + 50));
          }
          accumulatedListingsCount += listingRows.length;
        }

        // Upsert stores
        const storeRows = [];
        for (const [shop, details] of shopMappings) {
          const rowData = { shop_name: shop, source: 'search_snapshot' };
          const rating = details.shop_rating;
          if (rating !== null && rating !== undefined && rating !== '' && !Number.isNaN(parseFloat(rating))) {
            rowData.shop_rating = String(rating);
          }
          const reviewsCount = details.shop_reviews;
          if (reviewsCount !== null && reviewsCount !== undefined && reviewsCount !== '' && !Number.isNaN(parseInt(reviewsCount))) {
            rowData.shop_review_count = String(reviewsCount);
          }
          storeRows.push(rowData);
        }

        if (storeRows.length > 0) {
          try {
            await sheetsClient.upsertRowsBatch('etsy_stores', storeRows);
            logCallback('info', `🏬 Synced ratings for ${storeRows.length} shop(s)`);
          } catch (upsertError) {
            logCallback('warn', `⚠️ Batch store sync failed (${upsertError.message}) — running fallback individual syncs`);
            let successCount = 0;
            for (const storeRow of storeRows) {
              try {
                await sheetsClient.upsertRow('etsy_stores', 'shop_name', storeRow.shop_name, storeRow);
                successCount++;
              } catch (_) {}
            }
            logCallback('info', `🏬 Synced ${successCount}/${storeRows.length} shop(s) individually`);
          }
        }

        // Update keyword run indicators
        const previousRunsCount = parseInt(kwItem.snapshot_count) || 0;
        await sheetsClient.updateRowByMatch('etsy_keywords', 'keyword_id', kwItem.keyword_id, {
          snapshot_count: previousRunsCount + 1,
          last_snapshot_at: timestamp,
          status: 'validated'
        });

        processedKeywordsCount++;
        const currentQualifiedTotal = keywordAssessmentResults.filter(r => r.qualified).length;
        logCallback('success', `📸 Snapshotted "${query}": ${listingRows.length} listings saved (${matchingListingsCount} total seed listings) | ${currentQualifiedTotal} qualified so far`);

        // Record progress watermark for recovery
        try {
          await chrome.storage.local.set({
            step2LastProgress: {
              seedKeyword,
              lastCompletedKeyword: query,
              lastCompletedIndex: currentIndex,
              totalKeywords: targetKeywords.length,
              completedAt: new Date().toISOString()
            }
          });
        } catch (_) {}

        logCallback('info', `💤 Brief cooldown...`);
        await delayExecution(5000);

      } catch (err) {
        logCallback('error', `Error handling keyword "${kwItem.keyword}": ${err.message}`);
      }
    }

    // Evaluate structural niche results
    const finalQualifiedTotal = keywordAssessmentResults.filter(r => r.qualified).length;
    const finalProcessedTotal = keywordAssessmentResults.length;
    const isNicheQualified = finalQualifiedTotal >= requiredQualifiedKeywords;

    logCallback('info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logCallback(isNicheQualified ? 'success' : 'warn',
      `${isNicheQualified ? '🟢' : '🔴'} NICHE VERDICT: ${finalQualifiedTotal}/${finalProcessedTotal} qualified keywords (require ${requiredQualifiedKeywords}) -> ${isNicheQualified ? 'GO' : 'NO-GO'}`);
    logCallback('info', `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    // Log to user_keyword_results if valid run ID is present
    if (pipelineRunId && keywordAssessmentResults.length > 0) {
      const userKwLogs = keywordAssessmentResults
        .filter(r => r.keyword_id)
        .map(r => ({
          run_id: pipelineRunId,
          keyword_id: r.keyword_id,
          beatable_slots: r.beatableSlots || 0,
          total_listings: r.totalListings || 0,
          qualified: r.qualified ? 1 : 0,
          reason: (r.reason || '').slice(0, 250)
        }));

      if (userKwLogs.length > 0) {
        try {
          await sheetsClient.upsertRowsBatch('user_keyword_results', userKwLogs);
          logCallback('info', `💾 Saved ${userKwLogs.length} keyword outcome(s) for run ID ${pipelineRunId}`);
        } catch (e) {
          logCallback('warn', `⚠️ Could not save keyword outcomes (${e.message})`);
        }
      }
    }

    if (!isNicheQualified) {
      logCallback('warn', `⏭️ Skipping listing audits (Steps 3 & 4) — criteria not met.`);
    }

    // Set audit candidates limit and score sorting
    const auditMaxLimit = Math.max(1, parseInt(
      (config && (config.audit_keyword_max != null) ? config.audit_keyword_max : null)
      ?? databaseConfig.audit_keyword_max
      ?? 40
    ) || 40);

    const orderedResults = [...keywordAssessmentResults]
      .filter(kr => kr.qualified || kr.beatableSlots > 0)
      .map(kr => {
        const kwDetails = targetKeywords.find(k => String(k.keyword_id) === String(kr.keyword_id));
        const searches = kwDetails ? (parseFloat(kwDetails.avg_searches) || 0) : 0;
        const ratio = kr.totalListings > 0 ? kr.beatableSlots / kr.totalListings : 0;
        return { ...kr, searches, prelimScore: searches * ratio };
      })
      .sort((a, b) => b.prelimScore - a.prelimScore);

    const selectedAuditKeywordIds = orderedResults.slice(0, auditMaxLimit).map(kr => String(kr.keyword_id));
    logCallback('info', `📊 Audits scheduled: ${selectedAuditKeywordIds.length} candidate keywords (cap: ${auditMaxLimit})`);

    // Sync validation metadata state
    await chrome.storage.local.set({
      nicheQualification: {
        seedKeyword,
        nicheQualified: isNicheQualified,
        qualifiedCount: finalQualifiedTotal,
        totalProcessed: finalProcessedTotal,
        minQualifiedKw: requiredQualifiedKeywords,
        maxShopReviewsBeatable: reviewsUpperBoundary,
        minBeatableSlots: requiredBeatableSlots,
        maxListingsPerKw: auditLimitPerKeyword,
        snapshotCaptureDepth: PERSISTENCE_DEPTH_LIMIT,
        keywordResults: keywordAssessmentResults,
        topKeywordIds: selectedAuditKeywordIds,
        auditCount: selectedAuditKeywordIds.length,
        evaluatedAt: new Date().toISOString()
      }
    });

    await sheetsClient.logRun('etsy_search_snapshots', processedKeywordsCount > 0 ? 'SUCCESS' : 'FAILED',
      processedKeywordsCount, accumulatedListingsCount, 0, '',
      `Processed: ${processedKeywordsCount}, Saved Listings: ${accumulatedListingsCount}, Viable: ${finalQualifiedTotal}/${finalProcessedTotal}`);

    logCallback('success', `🏁 Step 2 Complete: processed ${processedKeywordsCount} keywords`);
    return { keywordsProcessed: processedKeywordsCount, listingsFound: accumulatedListingsCount, snapshotsTaken: snapshotsCreatedCount, nicheQualified: isNicheQualified, qualifiedCount: finalQualifiedTotal, totalProcessed: finalProcessedTotal, keywordResults: keywordAssessmentResults };

  } catch (err) {
    logCallback('error', `Step 2 process error: ${err.message}`);
    await sheetsClient.logRun('etsy_search_snapshots', 'FAILED', processedKeywordsCount, accumulatedListingsCount, 0, err.message, '');
    throw err;
  }
}
