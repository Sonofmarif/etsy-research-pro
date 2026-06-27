// Etsy Search Results Extractor — Content Script
// Runs on: https://www.etsy.com/search*
// Extracts listing data from Etsy search result cards
//
// IMPORTANT: Rating & review count shown on search cards are SHOP-LEVEL metrics,
// not listing-specific. The aria-label "4.9 star rating with 31.4k reviews" refers
// to the shop's overall rating and total review count across all their listings.
// Fields are named shop_rating / shop_reviews to reflect this.

(function() {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'extractEtsySearchResults') {
      // Load live selectors before executing the extraction
      (async () => {
        if (typeof window.loadLiveSelectors === 'function') {
          await window.loadLiveSelectors();
        }
        handleExtractSearchResults(sendResponse);
      })();
      return true;
    }
  });

  // Parse a review count string like "31.4k", "1,234", "38" into an integer
  function parseReviewCount(str) {
    if (!str) return 0;
    const cleaned = str.replace(/,/g, '').trim();
    if (cleaned.toLowerCase().endsWith('k')) {
      return Math.round(parseFloat(cleaned) * 1000);
    }
    return parseInt(cleaned) || 0;
  }

  function handleExtractSearchResults(sendResponse) {
    try {
      const listings = [];
      const seenIds = new Set();

      // ─── Find listing cards ───
      // 2026-05-01: Scope card extraction to the main search-results container.
      // Etsy renders a "Recently viewed" carousel at the bottom of search
      // pages whose cards share the same `v2-listing-card` class and
      // `data-listing-id` attribute as the main results. A page-wide
      // querySelector therefore picked them up too, and they bled into the
      // captured set at high search_position numbers — producing the
      // cross-niche contamination we saw (same 2 listings appearing under
      // many unrelated keywords).
      //
      // Fix: query inside the canonical results-list container only. As a
      // belt-and-suspenders second pass, drop any card that resolves to be
      // inside a "Recently viewed" subtree even if the scoping somehow misses.
      const resultsRoot = safeQuery(document, 'etsySearch.resultsRoot1', false) || 
                          safeQuery(document, 'etsySearch.resultsRoot2', false) || 
                          safeQuery(document, 'etsySearch.resultsRoot3', false) || null;

      // Identify the "Recently viewed" subtree by its heading and exclude any
      // cards descending from it. We don't rely on a stable data-* attribute
      // because Etsy doesn't currently expose one for this module.
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
      let cards = safeQueryAll(queryRoot, 'etsySearch.listingCard');
      if (cards.length === 0) {
        cards = safeQueryAll(queryRoot, 'etsySearch.listingCardFallback');
      }
      const rawCount = cards.length;

      // Deduplicate cards by listing ID — keep the outermost (largest) card per ID
      const cardMap = new Map();
      let droppedRecentlyViewed = 0;
      cards.forEach(card => {
        const id = card.getAttribute('data-listing-id');
        if (!id || !/^\d+$/.test(id)) return;
        if (isInRecentlyViewed(card)) { droppedRecentlyViewed++; return; }
        // Prefer larger cards (outer wrappers) — they contain all the data
        const existing = cardMap.get(id);
        if (!existing || card.contains(existing)) {
          cardMap.set(id, card);
        }
      });

      // Diagnostic: surface scoping outcome so future Etsy markup drift is
      // visible from the popup log without re-instrumenting the page.
      try {
        console.log(
          `[Etsy Search Extractor] resultsRoot=${resultsRoot ? resultsRoot.tagName : 'document'}, raw=${rawCount}, dropped_recently_viewed=${droppedRecentlyViewed}, kept=${cardMap.size}`
        );
      } catch (_) { /* console may be sandboxed */ }

      let position = 0;
      for (const [listingId, card] of cardMap) {
        try {
          // ─── Ad filtering ───
          // IMPORTANT: Etsy's DOM includes "Ad from shop X" in wt-screen-reader-only spans
          // for BOTH ad and organic listings (CSS classes toggle visibility).
          // Similarly, innerText may include "Ad・By" for all listings depending on
          // computed styles. These text-based checks are UNRELIABLE and must NOT be used.
          //
          // RELIABLE ad indicators:
          // 1. Ad listings have h3 with id="ad-listing-title-XXXX" (organic: id="listing-title-XXXX")
          // 2. Ad listings may have input[name="listing_source"][value="ads"] in their form

          // Strategy 1: Check for hidden input listing_source="ads" inside the card
          const adSourceInput = safeQuery(card, 'etsySearch.adInput', false);
          if (adSourceInput) continue;

          // Strategy 2: Card has ad-listing-title ID prefix on the h3 heading
          if (safeQuery(card, 'etsySearch.adTitle', false)) continue;

          // Skip duplicates
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
          const mainLink = safeQuery(card, 'etsySearch.mainLink', false);
          listing.etsy_url = mainLink ? mainLink.href.split('?')[0] : '';

          // ─── Thumbnail URL ───
          // Etsy search cards lazy-load images. The actual src may be in
          // `src`, `data-src`, or `srcset` (responsive). Try in priority order.
          listing.thumbnail_url = '';
          const imgEl = card.querySelector('img');
          if (imgEl) {
            // Prefer the resolved src (post-lazy-load)
            let src = imgEl.getAttribute('src') || '';
            if (!src || src.startsWith('data:')) {
              src = imgEl.getAttribute('data-src') || imgEl.getAttribute('data-srcset') || '';
            }
            if (!src) {
              // Pick first URL from srcset if present
              const srcset = imgEl.getAttribute('srcset') || '';
              if (srcset) {
                const firstUrl = srcset.split(',')[0].trim().split(/\s+/)[0];
                if (firstUrl) src = firstUrl;
              }
            }
            // Only accept Etsy CDN URLs to avoid 1x1 trackers / placeholders
            if (src && /i\.etsystatic\.com/.test(src)) {
              listing.thumbnail_url = src.split('?')[0];
            }
          }

          // ─── Title ───
          listing.title = '';
          // Strategy 1: h2/h3 heading (Etsy's standard title location)
          const heading = card.querySelector('h3, h2');
          if (heading) listing.title = heading.textContent.trim();
          // Strategy 2: title attribute on heading or link
          if (!listing.title) {
            const titleAttr = card.querySelector('[title]');
            if (titleAttr) listing.title = titleAttr.getAttribute('title') || '';
          }
          // Strategy 3: aria-label on image link
          if (!listing.title && mainLink) {
            listing.title = mainLink.getAttribute('aria-label') || '';
          }

          // ─── Price extraction ───
          // Etsy 2026 DOM structure:
          //   .n-listing-card__price contains:
          //     <span class='currency-symbol'>USD </span><span class='currency-value'>20.73</span>
          //   For sale items, there's also:
          //     <span class="wt-text-strikethrough ..."><span class='currency-value'>41.47</span></span>
          //     <span class="wt-screen-reader-only">Sale Price USD 20.73</span>
          //     <span class="wt-screen-reader-only">Original Price USD 41.47</span>
          //     (50% off)
          listing.price = 0;
          listing.original_price = null;
          listing.discount_pct = null;

          const priceContainer = safeQuery(card, 'etsySearch.priceContainer', false);
          if (priceContainer) {
            // Method A: Parse screen-reader-only text (most reliable for sale items)
            const srTexts = safeQueryAll(priceContainer, 'etsySearch.screenReaderText');
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

            // Method B: If no sale text, get price from currency-value spans
            if (!listing.price) {
              const currencyValues = safeQueryAll(priceContainer, 'etsySearch.currencyValue');
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

            // Method C: Parse "(X% off)" text for discount
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

          // Fallback: extract from full card text if price container not found
          if (!listing.price) {
            const usdMatches = cardText.match(/USD\s*([\d,.]+)/g);
            if (usdMatches) {
              for (const m of usdMatches) {
                const val = parseFloat(m.replace(/USD\s*/, '').replace(/,/g, ''));
                if (val > 0) { listing.price = val; break; }
              }
            }
          }

          // ─── Shop rating & shop review count ───
          // These are SHOP-LEVEL metrics from the search card, not listing-specific.
          // Etsy 2026 DOM: div[role="img"][aria-label="4.9 star rating with 31.4k reviews"]
          // Also: <span class="wt-text-title-small">4.9</span> for the rating number
          //        <p class="wt-text-body-smaller">(31.4k)</p> for the review count display
          listing.shop_rating = null;
          listing.shop_reviews = null;

          // Strategy 1 (PRIMARY): aria-label on role="img" element
          const ratingImgEl = safeQuery(card, 'etsySearch.ratingImg', false);
          if (ratingImgEl) {
            const label = ratingImgEl.getAttribute('aria-label') || '';
            const combined = label.match(/([0-9]+(?:\.[0-9]+)?)\s*star\s*rating\s*with\s*([0-9,.]+[kK]?)\s*reviews?/i);
            if (combined) {
              listing.shop_rating = parseFloat(combined[1]);
              listing.shop_reviews = parseReviewCount(combined[2]);
            }
          }

          // Strategy 2: If aria-label not found, try the visible text elements
          if (!listing.shop_rating) {
            // Rating from span.wt-text-title-small inside the rating area
            const ratingArea = safeQuery(card, 'etsySearch.ratingArea', false);
            if (ratingArea) {
              const ratingSpan = safeQuery(ratingArea, 'etsySearch.ratingSpan', false);
              if (ratingSpan) {
                const val = parseFloat(ratingSpan.textContent.trim());
                if (val > 0 && val <= 5) listing.shop_rating = val;
              }
              // Review count from "(Xk)" or "(X,XXX)" pattern
              const reviewP = safeQuery(ratingArea, 'etsySearch.reviewP', false);
              if (reviewP) {
                const inner = reviewP.textContent.replace(/[()]/g, '').trim();
                listing.shop_reviews = parseReviewCount(inner);
              }
            }
          }

          // Strategy 3: General aria-label scan as last resort
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

          // Strategy 1 (PRIMARY): data-seller-name-link or clickable-shop-name
          // Etsy 2026 DOM: <span class='wt-text-link clickable-shop-name' data-seller-name-link>ShopName</span>
          const sellerNameEl = card.querySelector('[data-seller-name-link], .clickable-shop-name');
          if (sellerNameEl) {
            listing.shop_name = sellerNameEl.textContent.trim();
          }

          // Strategy 2: Screen-reader "From shop X" text
          if (!listing.shop_name) {
            const srShopSpans = card.querySelectorAll('.wt-screen-reader-only');
            for (const sr of srShopSpans) {
              const txt = sr.textContent.trim();
              // Match "From shop X" but NOT "Ad from shop X"
              const fromMatch = txt.match(/^From\s+shop\s+(\S+)/i);
              if (fromMatch) {
                listing.shop_name = fromMatch[1].trim();
                break;
              }
            }
          }

          // Strategy 3: data-shop-url attribute on clickable shop name
          if (!listing.shop_name) {
            const shopUrlEl = card.querySelector('[data-shop-url]');
            if (shopUrlEl) {
              const shopUrl = shopUrlEl.getAttribute('data-shop-url') || '';
              const shopMatch = shopUrl.match(/\/shop\/([^/?]+)/);
              if (shopMatch) listing.shop_name = shopMatch[1];
            }
          }

          // Strategy 4: shop link in tooltip
          if (!listing.shop_name) {
            const tooltipShop = card.querySelector('.listing-card-tooltip strong');
            if (tooltipShop) {
              const name = tooltipShop.textContent.trim();
              if (name.length > 1 && name.length < 50) listing.shop_name = name;
            }
          }

          // Clean up shop name
          listing.shop_name = listing.shop_name
            .replace(/^Ad\s*[·•\-|]\s*By\s*/i, '')
            .replace(/^From\s+shop\s*/i, '')
            .replace(/^By\s+/i, '')
            .trim();

          // ─── Badges ───
          listing.is_digital = cardTextLower.includes('digital download');
          listing.is_bestseller = false;
          listing.is_popular_now = false;

          // Check clg-signal elements (Etsy's custom badge components)
          // These are web components with Shadow DOM — textContent alone won't work,
          // we need to also check shadowRoot for the actual rendered text.
          const signalEls = card.querySelectorAll('clg-signal');
          for (const sig of signalEls) {
            let sigText = sig.textContent.trim().toLowerCase();
            // Penetrate Shadow DOM if textContent is empty
            if (!sigText && sig.shadowRoot) {
              sigText = (sig.shadowRoot.textContent || '').trim().toLowerCase();
            }
            if (sigText.includes('bestseller') || sigText.includes('best seller')) listing.is_bestseller = true;
            if (sigText.includes('popular now')) listing.is_popular_now = true;
          }
          // Also check text in case clg-signal content isn't accessible
          if (!listing.is_bestseller && (cardTextLower.includes('bestseller') || cardTextLower.includes('best seller'))) {
            listing.is_bestseller = true;
          }
          if (!listing.is_popular_now && cardTextLower.includes('popular now')) {
            listing.is_popular_now = true;
          }

          // ─── Urgency signals ───
          // Etsy shows urgency on search cards via:
          //   1. Text in the card body ("Only 3 left", "In 20+ people's carts", etc.)
          //   2. Custom <clg-signal> web components (badges like "Bestseller", "Popular now")
          //   3. Spans/divs with aria-labels or data attributes for demand signals
          //   4. Screen-reader-only spans with demand text
          // NOTE: "In demand. X people bought this in the last 24 hours" is on DETAIL pages only.
          //       On search cards, Etsy typically shows "In X people's carts" or "Only X left".
          listing.urgency_text = '';

          // Collect all text from the card including custom elements and aria-labels
          let allCardText = cardText;

          // Also grab text from clg-signal elements and other signal components.
          // These may use Shadow DOM, so check shadowRoot when textContent is empty.
          const signals = card.querySelectorAll('clg-signal, [data-signal], [data-urgency]');
          for (const sig of signals) {
            let sigText = sig.textContent || '';
            // Penetrate Shadow DOM
            if (!sigText.trim() && sig.shadowRoot) {
              sigText = sig.shadowRoot.textContent || '';
            }
            sigText = sigText || sig.getAttribute('aria-label') || '';
            if (sigText) allCardText += ' ' + sigText;
          }

          // Also check all shadow roots in the card for any hidden urgency text
          const allCustomEls = card.querySelectorAll('*');
          for (const el of allCustomEls) {
            if (el.shadowRoot) {
              const shadowText = el.shadowRoot.textContent || '';
              if (/cart|demand|sold|left|stock|selling|gone|bestseller|popular/i.test(shadowText)) {
                allCardText += ' ' + shadowText;
              }
            }
          }

          // Check aria-labels on all elements (Etsy sometimes puts urgency in aria-label)
          const ariaEls = card.querySelectorAll('[aria-label]');
          for (const el of ariaEls) {
            const label = el.getAttribute('aria-label') || '';
            if (/cart|demand|sold|left|stock|selling|gone/i.test(label)) {
              allCardText += ' ' + label;
            }
          }

          // Check screen-reader-only spans for urgency text
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
            /in\s+(\d+\+?)\s+people[''\u2019]?s?\s+carts?/i,
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
              // Deduplicate (same signal might appear in multiple text sources)
              const key = found.toLowerCase();
              if (!seenPatterns.has(key)) {
                seenPatterns.add(key);
                urgencyParts.push(found);
              }
            }
          }
          listing.urgency_text = urgencyParts.join('; ');

          // ─── Free delivery signal ───
          listing.free_delivery = cardTextLower.includes('free delivery') || cardTextLower.includes('free shipping');

          listings.push(listing);
        } catch (err) {
          console.error('[Etsy Search Extractor] Selector or parsing failure on card:', err);
          sendTelemetryReport(err, card);
        }
      }

      sendResponse({ success: true, listings, totalFound: listings.length });
    } catch (err) {
      if (typeof catchError === 'function') {
        catchError(err, 'etsy-search-extractor');
      } else {
        console.error('[Etsy Search Extractor] Failure:', err);
      }
      sendResponse({ success: false, error: err.message, listings: [] });
    }
  }

  async function sendTelemetryReport(err, card) {
    try {
      const storageRes = await chrome.storage.local.get('config');
      const config = storageRes.config || {};
      if (!config.share_telemetry) return;
      const baseUrl = config.worker_url || 'https://etsy-research-pro.sonofmarif.workers.dev';
      const reportUrl = `${baseUrl}/api/telemetry/report`;
      
      let cleanUrl = 'etsy-search';
      try {
        const u = new URL(window.location.href);
        cleanUrl = u.origin + u.pathname;
      } catch (e) {}
      
      await fetch(reportUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error_message: `Selector/Parsing failure: ${err.message || String(err)}`,
          stack_trace: `Location: etsy-search-extractor.js`,
          url: cleanUrl,
          user_agent: 'Etsy Research Pro Extension'
        })
      });
    } catch (e) {
      console.warn('[Etsy Search Extractor] sendTelemetryReport failed:', e.message);
    }
  }
})();
