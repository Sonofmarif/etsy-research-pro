// Etsy Search Results Extractor — Content Script
// Runs on: https://www.etsy.com/*
// Adapted from Niche Moat's production scraper with multi-fallback selectors
//
// Extracts listing data from Etsy search result cards.
// Rating & review count on search cards are SHOP-LEVEL metrics.

(function () {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg.action === 'extractEtsySearchResults') {
        handleExtractSearchResults(sendResponse);
        return true;
      }
      if (msg.action === 'detectEtsyLogin') {
        handleDetectLogin(sendResponse);
        return true;
      }
      if (msg.action === 'extractSingleListing') {
        handleExtractSingleListing(sendResponse);
        return true;
      }
      return false;
    } catch (e) {
      console.error('[ERP] Etsy search extractor onMessage error:', e);
      sendResponse({ success: false, error: e.message });
      return false;
    }
  });

  // ─── Login detection (warn user to use guest profile) ───────────────────
  function handleDetectLogin(sendResponse) {
    const isLoggedIn = !!(
      document.querySelector('[data-user-id]') ||
      document.querySelector('.signed-in-user') ||
      document.querySelector('[data-analytics-region="user-menu"]') ||
      document.cookie.includes('user_prefs')
    );
    sendResponse({ loggedIn: isLoggedIn });
  }

  // ─── Parse review count: "31.4k", "1,234", "38" → integer ──────────────
  function parseReviewCount(str) {
    if (!str) return 0;
    const cleaned = str.replace(/,/g, '').trim();
    if (cleaned.toLowerCase().endsWith('k')) {
      return Math.round(parseFloat(cleaned) * 1000);
    }
    return parseInt(cleaned) || 0;
  }

  // ─── Product type detection ─────────────────────────────────────────────
  function detectProductType(listing) {
    const title = (listing.title || '').toLowerCase();
    const url = listing.etsy_url || '';
    if (url.includes('digital_download') ||
        title.includes('printable') ||
        title.includes('digital') ||
        title.includes('pdf') ||
        title.includes('svg') ||
        title.includes('template') ||
        title.includes('canva')) return 'digital';
    if (title.includes('t-shirt') ||
        title.includes('tshirt') ||
        title.includes('mug') ||
        title.includes('tote') ||
        title.includes('print on demand') ||
        title.includes('hoodie') ||
        title.includes('sweatshirt')) return 'pod';
    return 'physical';
  }

  // Helper to scroll page naturally to trigger lazy loads and simulate human behavior
  function scrollPageNaturally() {
    return new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 400;
      const interval = 150;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        // Scroll up to 3500px or end of document
        if (totalHeight >= Math.min(document.body.scrollHeight, 3500)) {
          clearInterval(timer);
          window.scrollTo({ top: 0, behavior: 'smooth' }); // Scroll back to top smoothly
          setTimeout(resolve, 800); // Wait for smooth scroll to finish
        }
      }, interval);
    });
  }

  // ─── Extract search results ─────────────────────────────────────────────
  async function handleExtractSearchResults(sendResponse) {
    try {
      // Scroll naturally before reading listings to load lazy-loaded elements
      await scrollPageNaturally();

      const listings = [];
      const seenIds = new Set();

      // Scope to main search results container (exclude "Recently viewed")
      const resultsRoot = document.querySelector(
        'ol[data-search-results-list]'
      ) || document.querySelector(
        'div[data-search-results-list]'
      ) || document.querySelector(
        'div[data-search-results]'
      ) || null;

      // Identify "Recently viewed" subtree
      const RECENTLY_VIEWED_RE = /^\s*recently\s+viewed\s*$/i;
      const recentlyViewedRoots = [];
      document.querySelectorAll('h1, h2, h3, h4').forEach(h => {
        if (RECENTLY_VIEWED_RE.test(h.textContent || '')) {
          const container = h.closest('section, aside, [role="region"]')
            || (h.parentElement && h.parentElement.parentElement)
            || h.parentElement;
          if (container) recentlyViewedRoots.push(container);
        }
      });

      const isInRecentlyViewed = (card) => {
        for (const root of recentlyViewedRoots) {
          if (root.contains(card)) return true;
        }
        return false;
      };

      const queryRoot = resultsRoot || document;
      let cards = queryRoot.querySelectorAll('div.v2-listing-card[data-listing-id]');
      if (cards.length === 0) {
        cards = queryRoot.querySelectorAll('[data-listing-id]');
      }

      // Deduplicate cards by listing ID
      const cardMap = new Map();
      cards.forEach(card => {
        const id = card.getAttribute('data-listing-id');
        if (!id || !/^\d+$/.test(id)) return;
        if (isInRecentlyViewed(card)) return;
        const existing = cardMap.get(id);
        if (!existing || card.contains(existing)) {
          cardMap.set(id, card);
        }
      });

      let position = 0;
      for (const [listingId, card] of cardMap) {
        // ─── Ad filtering ───
        const adSourceInput = card.querySelector('input[name="listing_source"][value="ads"]');
        if (adSourceInput) continue;
        if (card.querySelector('[id^="ad-listing-title-"]')) continue;

        if (seenIds.has(listingId)) continue;
        seenIds.add(listingId);

        position++;
        const listing = {
          listing_id: listingId,
          search_position: position
        };

        const cardText = card.innerText || '';
        const cardTextLower = cardText.toLowerCase();

        // ─── URL ───
        const mainLink = card.querySelector('a[href*="/listing/"]');
        listing.etsy_url = mainLink ? mainLink.href.split('?')[0] : '';

        // ─── Thumbnail URL ───
        listing.thumbnail_url = '';
        const imgEl = card.querySelector('img');
        if (imgEl) {
          let src = imgEl.getAttribute('src') || '';
          if (!src || src.startsWith('data:')) {
            src = imgEl.getAttribute('data-src') || imgEl.getAttribute('data-srcset') || '';
          }
          if (!src) {
            const srcset = imgEl.getAttribute('srcset') || '';
            if (srcset) {
              const firstUrl = srcset.split(',')[0].trim().split(/\s+/)[0];
              if (firstUrl) src = firstUrl;
            }
          }
          if (src && /i\.etsystatic\.com/.test(src)) {
            listing.thumbnail_url = src.split('?')[0];
          }
        }

        // ─── Title ───
        listing.title = '';
        const heading = card.querySelector('h3, h2');
        if (heading) listing.title = heading.textContent.trim();
        if (!listing.title) {
          const titleAttr = card.querySelector('[title]');
          if (titleAttr) listing.title = titleAttr.getAttribute('title') || '';
        }
        if (!listing.title && mainLink) {
          listing.title = mainLink.getAttribute('aria-label') || '';
        }

        // ─── Price extraction ───
        listing.price = 0;
        listing.original_price = null;
        listing.discount_pct = null;

        const priceContainer = card.querySelector('.n-listing-card__price');
        if (priceContainer) {
          // Method A: Screen-reader-only text
          const srTexts = priceContainer.querySelectorAll('.wt-screen-reader-only');
          let salePrice = null, origPrice = null;
          for (const sr of srTexts) {
            const txt = sr.textContent.trim();
            const salePriceMatch = txt.match(/Sale\s+Price\s+(?:USD\s+)?([\d,.]+)/i);
            if (salePriceMatch) salePrice = parseFloat(salePriceMatch[1].replace(/,/g, ''));
            const origPriceMatch = txt.match(/Original\s+Price\s+(?:USD\s+)?([\d,.]+)/i);
            if (origPriceMatch) origPrice = parseFloat(origPriceMatch[1].replace(/,/g, ''));
          }

          if (salePrice && salePrice > 0) {
            listing.price = salePrice;
            if (origPrice && origPrice > salePrice) {
              listing.original_price = origPrice;
              listing.discount_pct = Math.round((1 - salePrice / origPrice) * 100);
            }
          }

          // Method B: Currency-value spans
          if (!listing.price) {
            const currencyValues = priceContainer.querySelectorAll('span.currency-value');
            const prices = [];
            for (const cv of currencyValues) {
              const val = parseFloat(cv.textContent.replace(/[^0-9.]/g, ''));
              if (val > 0) prices.push(val);
            }
            const uniquePrices = [...new Set(prices)].sort((a, b) => a - b);
            if (uniquePrices.length >= 2) {
              listing.price = uniquePrices[0];
              listing.original_price = uniquePrices[uniquePrices.length - 1];
              listing.discount_pct = Math.round((1 - listing.price / listing.original_price) * 100);
            } else if (uniquePrices.length === 1) {
              listing.price = uniquePrices[0];
            }
          }

          // Method C: "(X% off)" text
          if (!listing.discount_pct) {
            const offMatch = priceContainer.textContent.match(/\((\d+)\s*%\s*off\)/i);
            if (offMatch) {
              listing.discount_pct = parseInt(offMatch[1]);
              if (!listing.original_price && listing.price && listing.discount_pct > 0) {
                listing.original_price = Math.round(listing.price / (1 - listing.discount_pct / 100) * 100) / 100;
              }
            }
          }
        }

        // Fallback: USD in card text
        if (!listing.price) {
          const usdMatches = cardText.match(/USD\s*([\d,.]+)/g);
          if (usdMatches) {
            for (const m of usdMatches) {
              const val = parseFloat(m.replace(/USD\s*/, '').replace(/,/g, ''));
              if (val > 0) { listing.price = val; break; }
            }
          }
        }

        // ─── Shop rating & review count (SHOP-LEVEL) ───
        listing.shop_rating = null;
        listing.shop_reviews = 0;

        // Strategy 1: aria-label with "star rating with X reviews"
        const ratingImgEl = card.querySelector('[role="img"][aria-label*="star rating"]');
        if (ratingImgEl) {
          const label = ratingImgEl.getAttribute('aria-label') || '';
          const combined = label.match(/([0-9]+(?:\.[0-9]+)?)\s*star\s*rating\s*with\s*([0-9,.]+[kK]?)\s*reviews?/i);
          if (combined) {
            listing.shop_rating = parseFloat(combined[1]);
            listing.shop_reviews = parseReviewCount(combined[2]);
          }
        }

        // Strategy 2: Visible text elements
        if (!listing.shop_rating) {
          const ratingArea = card.querySelector('.shop-name-with-rating, .streamline-spacing-shop-rating');
          if (ratingArea) {
            const ratingSpan = ratingArea.querySelector('span.wt-text-title-small');
            if (ratingSpan) {
              const val = parseFloat(ratingSpan.textContent.trim());
              if (val > 0 && val <= 5) listing.shop_rating = val;
            }
            const reviewP = ratingArea.querySelector('p.wt-text-body-smaller');
            if (reviewP) {
              const inner = reviewP.textContent.replace(/[()]/g, '').trim();
              listing.shop_reviews = parseReviewCount(inner);
            }
          }
        }

        // Strategy 3: General aria-label scan
        if (!listing.shop_rating) {
          const allAriaEls = card.querySelectorAll('[aria-label]');
          for (const el of allAriaEls) {
            const label = el.getAttribute('aria-label') || '';
            const combined = label.match(/([0-9]+(?:\.[0-9]+)?)\s*star\s*rating\s*with\s*([0-9,.]+[kK]?)\s*reviews?/i);
            if (combined) {
              listing.shop_rating = parseFloat(combined[1]);
              listing.shop_reviews = parseReviewCount(combined[2]);
              break;
            }
          }
        }

        // ─── Shop name ───
        listing.shop_name = '';

        const sellerNameEl = card.querySelector('[data-seller-name-link], .clickable-shop-name');
        if (sellerNameEl) listing.shop_name = sellerNameEl.textContent.trim();

        if (!listing.shop_name) {
          const srShopSpans = card.querySelectorAll('.wt-screen-reader-only');
          for (const sr of srShopSpans) {
            const txt = sr.textContent.trim();
            const fromMatch = txt.match(/^From\s+shop\s+(\S+)/i);
            if (fromMatch) { listing.shop_name = fromMatch[1].trim(); break; }
          }
        }

        if (!listing.shop_name) {
          const shopUrlEl = card.querySelector('[data-shop-url]');
          if (shopUrlEl) {
            const shopUrl = shopUrlEl.getAttribute('data-shop-url') || '';
            const shopMatch = shopUrl.match(/\/shop\/([^/?]+)/);
            if (shopMatch) listing.shop_name = shopMatch[1];
          }
        }

        listing.shop_name = listing.shop_name
          .replace(/^Ad\s*[·•\-|]\s*By\s*/i, '')
          .replace(/^From\s+shop\s*/i, '')
          .replace(/^By\s+/i, '')
          .trim();

        // ─── Badges ───
        listing.is_digital = cardTextLower.includes('digital download');
        listing.is_bestseller = false;
        listing.is_popular_now = false;

        // Check clg-signal elements (Shadow DOM web components)
        const signalEls = card.querySelectorAll('clg-signal');
        for (const sig of signalEls) {
          let sigText = sig.textContent.trim().toLowerCase();
          if (!sigText && sig.shadowRoot) {
            sigText = (sig.shadowRoot.textContent || '').trim().toLowerCase();
          }
          if (sigText.includes('bestseller') || sigText.includes('best seller')) listing.is_bestseller = true;
          if (sigText.includes('popular now')) listing.is_popular_now = true;
        }
        if (!listing.is_bestseller && (cardTextLower.includes('bestseller') || cardTextLower.includes('best seller'))) {
          listing.is_bestseller = true;
        }
        if (!listing.is_popular_now && cardTextLower.includes('popular now')) {
          listing.is_popular_now = true;
        }

        // ─── Urgency signals ───
        listing.urgency_text = '';
        let allCardText = cardText;

        const signals = card.querySelectorAll('clg-signal, [data-signal], [data-urgency]');
        for (const sig of signals) {
          let sigText = sig.textContent || '';
          if (!sigText.trim() && sig.shadowRoot) sigText = sig.shadowRoot.textContent || '';
          sigText = sigText || sig.getAttribute('aria-label') || '';
          if (sigText) allCardText += ' ' + sigText;
        }

        // Shadow DOM scan for urgency
        const allCustomEls = card.querySelectorAll('*');
        for (const el of allCustomEls) {
          if (el.shadowRoot) {
            const shadowText = el.shadowRoot.textContent || '';
            if (/cart|demand|sold|left|stock|selling|gone|bestseller|popular/i.test(shadowText)) {
              allCardText += ' ' + shadowText;
            }
          }
        }

        // Aria-labels with urgency
        const ariaEls = card.querySelectorAll('[aria-label]');
        for (const el of ariaEls) {
          const label = el.getAttribute('aria-label') || '';
          if (/cart|demand|sold|left|stock|selling|gone/i.test(label)) {
            allCardText += ' ' + label;
          }
        }

        // Screen-reader spans
        const srSpans = card.querySelectorAll('.wt-screen-reader-only, [class*="screen-reader"]');
        for (const sr of srSpans) {
          const txt = sr.textContent || '';
          if (/cart|demand|sold|left|stock|selling|gone/i.test(txt)) {
            allCardText += ' ' + txt;
          }
        }

        const urgencyPatterns = [
          /in\s+demand/i,
          /\d+\s+people?\s+bought\s+this/i,
          /in\s+(\d+\+?)\s+people[''']?s?\s+carts?/i,
          /in\s+(\d+\+?)\s+carts?/i,
          /only\s+(\d+)\s+left/i,
          /sold\s+(\d+)/i,
          /almost\s+gone/i,
          /selling\s+fast/i,
          /low\s+in\s+stock/i,
          /popular\s+now/i,
          /trending\s+now/i,
          /last\s+one/i
        ];
        const urgencyParts = [];
        const seenPatterns = new Set();
        for (const pattern of urgencyPatterns) {
          const match = allCardText.match(pattern);
          if (match) {
            const found = match[0].trim();
            const key = found.toLowerCase();
            if (!seenPatterns.has(key)) {
              seenPatterns.add(key);
              urgencyParts.push(found);
            }
          }
        }
        listing.urgency_text = urgencyParts.join('; ');

        // ─── Free delivery ───
        listing.free_delivery = cardTextLower.includes('free delivery') || cardTextLower.includes('free shipping');

        // ─── Product type ───
        listing.product_type = detectProductType(listing);

        // ─── Listing age estimation (from tags/metadata if available) ───
        listing.listing_age_days = null;
        listing.scraped_at = new Date().toISOString();

        // ─── Tags ───
        listing.tags = [];

        listings.push(listing);
      }

      sendResponse({ success: true, listings, totalFound: listings.length });
    } catch (err) {
      sendResponse({ success: false, error: err.message, listings: [] });
    }
  }

  // ─── Extract single listing detail (for SEO audit) ──────────────────────
  function handleExtractSingleListing(sendResponse) {
    try {
      const data = {};
      const pageText = document.body.innerText;

      // Title — multiple fallbacks
      data.title = '';
      const titleSelectors = [
        'h1[data-buy-box-listing-title]',
        'h1[data-listing-title]',
        '[data-testid="listing-title"] h1',
        'h1.wt-text-body-01',
        'h1'
      ];
      for (const sel of titleSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          data.title = el.textContent.trim();
          break;
        }
      }
      // Meta tag fallback for title
      if (!data.title) {
        const ogTitle = document.querySelector('meta[property="og:title"]');
        if (ogTitle) data.title = ogTitle.getAttribute('content') || '';
      }

      // Tags from listing page — multi-strategy
      data.tags = [];
      const tagSelectors = [
        '#wt-content-toggle-tags-read-more a',
        '[data-tag-query] a',
        'a[href*="/search?q="][class*="tag"]',
        '[class*="tag-card"] a',
        '.listing-tags a',
        '.wt-action-group a[href*="/search"]'
      ];
      for (const sel of tagSelectors) {
        const tagEls = document.querySelectorAll(sel);
        tagEls.forEach(el => {
          const text = el.textContent.trim().toLowerCase();
          if (text && text.length > 1 && text.length < 60 && !data.tags.includes(text)) {
            data.tags.push(text);
          }
        });
        if (data.tags.length > 0) break;
      }

      // Description — multiple fallbacks
      data.description = '';
      const descSelectors = [
        '[data-product-details-description-text-content]',
        '#wt-content-toggle-product-details-read-more',
        '[class*="listing-description"]',
        '[data-id="description-text"]',
        '[class*="ProductDescription"]'
      ];
      for (const sel of descSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim().length > 10) {
          data.description = el.textContent.trim().substring(0, 500);
          break;
        }
      }
      // Meta description fallback
      if (!data.description || data.description.length < 20) {
        const metaDesc = document.querySelector('meta[name="description"], meta[property="og:description"]');
        if (metaDesc) {
          const content = metaDesc.getAttribute('content') || '';
          if (content.length > data.description.length) data.description = content;
        }
      }

      // Price — multiple fallbacks
      data.price = 0;
      const priceSelectors = [
        '[data-buy-box-region="price"] .currency-value',
        '.wt-text-title-03 .currency-value',
        'p[class*="price"] .currency-value',
        'span.currency-value',
        '[data-appears-component-name="price"] .currency-value'
      ];
      for (const sel of priceSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const val = parseFloat(el.textContent.replace(/[^0-9.]/g, ''));
          if (val > 0) { data.price = val; break; }
        }
      }
      // JSON-LD price fallback
      if (!data.price) {
        const ldScriptsPrice = document.querySelectorAll('script[type="application/ld+json"]');
        for (const script of ldScriptsPrice) {
          try {
            const ld = JSON.parse(script.textContent);
            if (ld['@type'] === 'Product' && ld.offers) {
              const offers = Array.isArray(ld.offers) ? ld.offers[0] : ld.offers;
              if (offers.price) { data.price = parseFloat(offers.price) || 0; break; }
            }
          } catch (e) {}
        }
      }

      // Reviews & Rating — from JSON-LD
      data.reviews = 0;
      data.rating = null;
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of ldScripts) {
        try {
          const ld = JSON.parse(script.textContent);
          const product = ld['@type'] === 'Product' ? ld : null;
          if (product && product.aggregateRating) {
            data.rating = parseFloat(product.aggregateRating.ratingValue) || null;
            data.reviews = parseInt(product.aggregateRating.reviewCount || product.aggregateRating.ratingCount) || 0;
          }
        } catch (e) {}
      }

      // Category — from breadcrumbs
      data.category = '';
      const breadcrumbs = document.querySelectorAll(
        '[class*="breadcrumb"] a, nav[aria-label="breadcrumb"] a, [data-appears-component-name="breadcrumbs"] a'
      );
      if (breadcrumbs.length > 0) {
        data.category = breadcrumbs[breadcrumbs.length - 1].textContent.trim();
      }

      // Shop info
      data.shop_name = '';
      const shopSelectors = [
        '[data-shop-name]',
        'a[href*="/shop/"][class*="shop-name"]',
        '[class*="shop-name"] a',
        'a[aria-label*="shop"]'
      ];
      for (const sel of shopSelectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) {
          data.shop_name = el.textContent.trim();
          break;
        }
      }

      data.shop_reviews = 0;
      const shopReviewsEl = document.querySelector(
        '.rating-and-reviews-count__reviews-count, [class*="shop-rating"] span, [aria-label*="shop review"]'
      );
      if (shopReviewsEl) {
        data.shop_reviews = parseReviewCount(shopReviewsEl.textContent.replace(/[()]/g, ''));
      }

      // Photo count
      const imageIds = document.querySelectorAll('[data-carousel-pane][data-image-id], [data-carousel-image]');
      data.photo_count = imageIds.length || document.querySelectorAll('.listing-page-image-carousel img').length;

      // Has video
      data.has_video = !!document.querySelector('video[id^="listing-video"], [data-video-pane], video');

      sendResponse({ success: true, data });
    } catch (err) {
      sendResponse({ success: false, error: err.message, data: {} });
    }
  }
})();
