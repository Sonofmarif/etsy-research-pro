// Etsy Research Pro — Dynamic Selectors Registry

window.SELECTORS = {
  etsySearch: {
    resultsRoot1: 'ol[data-search-results-list]',
    resultsRoot2: 'div[data-search-results-list]',
    resultsRoot3: 'div[data-search-results]',
    listingCard: 'div.v2-listing-card[data-listing-id]',
    listingCardFallback: '[data-listing-id]',
    adInput: 'input[name="listing_source"][value="ads"]',
    adTitle: '[id^="ad-listing-title-"]',
    mainLink: 'a[href*="/listing/"]',
    priceContainer: '.n-listing-card__price',
    ratingImg: '[role="img"][aria-label*="star rating"]',
    ratingArea: '.shop-name-with-rating, .streamline-spacing-shop-rating',
    ratingSpan: 'span.wt-text-title-small',
    reviewP: 'p.wt-text-body-smaller',
  },
  etsyListing: {
    ldJson: 'script[type="application/ld+json"]',
    ratingMeta: 'meta[itemprop="ratingValue"], meta[property="og:rating"]',
    countMeta: 'meta[itemprop="reviewCount"], meta[itemprop="ratingCount"]',
    ratingEls: '[data-rating], [class*="stars-svg"] [class*="screen-reader"], [aria-label*="star"], [class*="review"] [class*="rating"]',
    urgencySelectors: '[data-appears-component-name*="UrgencySignal"], [data-appears-component-name*="urgency"], [data-appears-component-name*="Urgency"]',
    criticalEls: 'p.wt-sem-text-critical, div.wt-sem-text-critical, span.wt-sem-text-critical',
    ogImage: 'meta[property="og:image"]',
    mainImg: '[class*="listing-image"] img, [data-listing-image] img, .image-carousel img',
    metaDesc: 'meta[name="description"]',
    ogDesc: 'meta[property="og:description"]',
    imageIds: '[data-carousel-pane][data-image-id]',
    videoPane: 'video[id^="listing-video"], [data-video-pane]',
    tagsContainer: '[data-appears-component-name="Listzilla_ApiSpecs_Tags_MultiChannelLanding"]',
  },
  erankKeyword: {
    loginForm: 'form[action*="login"], input[name="email"], .login-form, #login-form',
    keywordTool: '.keyword-tool, #keyword-tool, .search-bar, input[name="keyword"], [class*="KeywordTool"]',
    statCards: '.stat-card, .metric-card, .summary-card, [class*="stat"], [class*="metric"]',
    countryRows: '[class*="country"], [class*="Country"]',
    chartLabels: 'svg text, .chart-label, [class*="chart"] text',
    tables: 'table',
    headerRow: 'thead tr:first-child, tr:first-child',
    bodyRows: 'tbody tr',
    keywordTableFallback: '[class*="keyword-table"], [class*="suggestions"], .table, [class*="DataTable"]',
    cells: 'th, td',
    keywordLink: 'a',
    keywordBold: 'b, strong, span[class*="keyword"], span[class*="Keyword"]'
  },
  erankAudit: {
    gaugeSelectors: [
      '.listing-score-value', '.score-value', '.gauge-value',
      '.score-circle .value', '.listing-audit-score',
      '[class*="gauge"] [class*="value"]',
      '[class*="score-num"]', '[class*="scoreNum"]',
      '.overall-score', '[class*="overall"] [class*="score"]',
      '[class*="listing-score"]',
      '.progress-circle .value', '.circular-chart .value',
      '[class*="CircularProgress"] [class*="label"]',
      '[class*="donut"] [class*="value"]',
    ].join(', '),
    allEls: 'h1, h2, h3, h4, h5, .display-1, .display-2, .display-3, .display-4, [class*="score"], [class*="Score"], [class*="grade"], [class*="Grade"], [class*="rating"], span, div, p, strong, b',
    tagElements: '[class*="tag"], .badge, .label, [class*="Tag"]'
  }
};

window.loadLiveSelectors = async function() {
  try {
    // Use an abort controller to ensure we don't stall scraping if the endpoint is down
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 2000);
    
    const res = await fetch('https://YOUR_STORAGE_URL/selectors.json', { signal: controller.signal });
    clearTimeout(timeoutId);
    
    if (res.ok) {
      const data = await res.json();
      // Deep merge into global SELECTORS
      for (const domain in data) {
        if (window.SELECTORS[domain]) {
          window.SELECTORS[domain] = { ...window.SELECTORS[domain], ...data[domain] };
        } else {
          window.SELECTORS[domain] = data[domain];
        }
      }
      console.log('[Selectors] Live registry loaded successfully.');
    } else {
      console.log('[Selectors] Registry: Using built-in local fallback selectors');
    }
  } catch (e) {
    // Silently swallow — the pipeline must proceed with hardcoded defaults
    console.log('[Selectors] Registry: Using built-in local fallback selectors');
  }
};
