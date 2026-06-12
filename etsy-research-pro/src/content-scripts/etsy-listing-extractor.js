// Etsy Listing Detail Extractor — Content Script
// Runs on: https://www.etsy.com/listing/*

(function() {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'extractEtsyListingDetail') {
      handleExtractDetail(sendResponse);
      return true;
    }
  });

  function handleExtractDetail(sendResponse) {
    try {
      const data = {};
      const pageText = document.body.innerText;

      // ─── Listing-level rating ───
      // Etsy listing pages show rating as stars + number, e.g. "4.9 out of 5 stars"
      // or in structured data (JSON-LD)
      let rating = null, reviewCount = null;

      // Method 1: JSON-LD structured data (most reliable)
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const script of ldScripts) {
        try {
          const ld = JSON.parse(script.textContent);
          const product = ld['@type'] === 'Product' ? ld : (ld['@graph'] || []).find(g => g['@type'] === 'Product');
          if (product && product.aggregateRating) {
            rating = parseFloat(product.aggregateRating.ratingValue);
            reviewCount = parseInt(product.aggregateRating.reviewCount || product.aggregateRating.ratingCount);
          }
        } catch(e) {}
      }

      // Method 2: Meta tags
      if (!rating) {
        const ratingMeta = document.querySelector('meta[itemprop="ratingValue"], meta[property="og:rating"]');
        if (ratingMeta) rating = parseFloat(ratingMeta.getAttribute('content'));
        const countMeta = document.querySelector('meta[itemprop="reviewCount"], meta[itemprop="ratingCount"]');
        if (countMeta) reviewCount = parseInt(countMeta.getAttribute('content'));
      }

      // Method 3: DOM elements — look for star rating display
      if (!rating) {
        const ratingEls = document.querySelectorAll('[data-rating], [class*="stars-svg"] [class*="screen-reader"], [aria-label*="star"], [class*="review"] [class*="rating"]');
        for (const el of ratingEls) {
          const ariaLabel = el.getAttribute('aria-label') || '';
          const dataRating = el.getAttribute('data-rating');
          if (dataRating) { rating = parseFloat(dataRating); break; }
          const starMatch = ariaLabel.match(/([\d.]+)\s*(?:out\s*of\s*5\s*)?star/i);
          if (starMatch) { rating = parseFloat(starMatch[1]); break; }
        }
      }

      // Method 4: Text pattern — "X out of 5 stars" or "(X,XXX)"
      if (!rating) {
        const ratingTextMatch = pageText.match(/([\d.]+)\s*out\s*of\s*5\s*stars?/i);
        if (ratingTextMatch) rating = parseFloat(ratingTextMatch[1]);
      }
      if (!reviewCount) {
        // Look for review count near rating — e.g. "(1,234)" or "1,234 reviews"
        const reviewTextMatch = pageText.match(/([\d,]+)\s+reviews?/i);
        if (reviewTextMatch) reviewCount = parseInt(reviewTextMatch[1].replace(/,/g, ''));
      }

      data.listing_rating = (rating && !isNaN(rating) && rating > 0) ? rating : null;
      data.listing_review_count = (reviewCount && !isNaN(reviewCount) && reviewCount > 0) ? reviewCount : null;

      // ─── Urgency signal (full text) ───
      // Etsy renders urgency inside a specific component near the price.
      // Real examples from live pages:
      //   "In demand. 4 people bought this in the last 24 hours."
      //   "20+ views in the last 24 hours"
      //   "Only 3 left and in 4 baskets"
      //   "In 10 baskets"
      //   "8 views in the last 24 hours"
      //   "Selling fast! 12 people have this in their carts."

      data.urgency_text = '';

      // Method 1: DOM — find the UrgencySignal component (most reliable)
      const urgencySelectors = [
        '[data-appears-component-name*="UrgencySignal"]',
        '[data-appears-component-name*="urgency"]',
        '[data-appears-component-name*="Urgency"]',
      ];
      for (const sel of urgencySelectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const text = el.textContent.trim();
            if (text.length > 2 && text.length < 200) {
              data.urgency_text = text;
              break;
            }
          }
        } catch(e) {}
      }

      // Method 2: Look for wt-sem-text-critical paragraphs near price (Etsy's urgency styling)
      if (!data.urgency_text) {
        const criticalEls = document.querySelectorAll('p.wt-sem-text-critical, div.wt-sem-text-critical, span.wt-sem-text-critical');
        for (const el of criticalEls) {
          const text = el.textContent.trim();
          // Filter to actual urgency signals (not prices or other critical text)
          if (text.length > 5 && text.length < 200 &&
              /basket|cart|bought|sold|view|demand|left|selling|hurry|popular|trending/i.test(text)) {
            data.urgency_text = text;
            break;
          }
        }
      }

      // Method 3: Text patterns on full page (fallback)
      if (!data.urgency_text) {
        const urgencyPatterns = [
          /In\s+demand\.?\s+\d+\s+people\s+bought\s+this[^.]*\./i,
          /Selling\s+fast[!.]?\s*\d+\s+people[^.]*\./i,
          /Only\s+\d+\s+left\s+and\s+in\s+\d+\s+(?:basket|cart)s?/i,
          /Only\s+\d+\s+left/i,
          /In\s+\d+\s+(?:basket|cart)s?/i,
          /\d+\+?\s+views?\s+in\s+the\s+last\s+24\s+hours?/i,
          /\d+\s+people?\s+bought\s+this\s+in\s+the\s+last\s+24\s+hours?/i,
          /Sold\s+\d+\s+times?\s+in\s+the\s+last\s+24\s+hours?/i,
        ];
        for (const pat of urgencyPatterns) {
          const m = pageText.match(pat);
          if (m) { data.urgency_text = m[0].trim(); break; }
        }
      }

      // ─── Social proof numbers (parsed from urgency text or page text) ───
      // In X carts/baskets
      const cartMatch = pageText.match(/In\s+(\d+)\s+(?:people(?:'s)?\s+)?(?:cart|basket)s?/i)
        || pageText.match(/in\s+(\d+)\s+(?:cart|basket)s?/i);
      data.in_carts = cartMatch ? parseInt(cartMatch[1]) : null;

      // X people bought this in last 24 hours
      const boughtMatch = pageText.match(/(\d+)\s+people\s+bought\s+this\s+in\s+the\s+last\s+24\s+hours?/i);
      // Sold X times in last 24 hours
      const soldMatch = pageText.match(/Sold\s+(\d+)\s+times?\s+in\s+the\s+last\s+24\s+hours?/i);
      data.sold_24h = boughtMatch ? parseInt(boughtMatch[1]) : (soldMatch ? parseInt(soldMatch[1]) : null);

      // X views in last 24 hours
      const viewsMatch = pageText.match(/(\d+)\+?\s+views?\s+in\s+the\s+last\s+24\s+hours?/i);
      data.views_24h = viewsMatch ? parseInt(viewsMatch[1]) : null;

      // Thumbnail URL (og:image meta tag)
      const ogImage = document.querySelector('meta[property="og:image"]');
      data.etsy_thumbnail_url = ogImage ? ogImage.getAttribute('content') : '';

      // Also try to get the main listing image
      if (!data.etsy_thumbnail_url) {
        const mainImg = document.querySelector('[class*="listing-image"] img, [data-listing-image] img, .image-carousel img');
        data.etsy_thumbnail_url = mainImg ? mainImg.src : '';
      }

      // ─── Favorites / Hearts count ───
      // Source 1: meta description — "has X favourites/favorites from Etsy shoppers"
      data.favorites_count = null;
      const metaDesc = document.querySelector('meta[name="description"]');
      if (metaDesc) {
        const descContent = metaDesc.getAttribute('content') || '';
        const favMetaMatch = descContent.match(/has\s+([\d,]+)\s+favou?rites?\s+from/i);
        if (favMetaMatch) data.favorites_count = parseInt(favMetaMatch[1].replace(/,/g, ''));
      }
      // Source 2: og:description (same pattern)
      if (!data.favorites_count) {
        const ogDesc = document.querySelector('meta[property="og:description"]');
        if (ogDesc) {
          const ogContent = ogDesc.getAttribute('content') || '';
          const favOgMatch = ogContent.match(/has\s+([\d,]+)\s+favou?rites?\s+from/i);
          if (favOgMatch) data.favorites_count = parseInt(favOgMatch[1].replace(/,/g, ''));
        }
      }
      // Source 3: visible text — "X favourites" link near bottom
      if (!data.favorites_count) {
        const favMatch = pageText.match(/([\d,]+)\s+favou?rites?/i);
        if (favMatch) data.favorites_count = parseInt(favMatch[1].replace(/,/g, ''));
      }

      // ─── Photo count ───
      // Count carousel panes with data-image-id (excludes video panes)
      const imageIds = document.querySelectorAll('[data-carousel-pane][data-image-id]');
      data.photo_count = imageIds.length;
      // Fallback: JSON-LD Product image array
      if (data.photo_count === 0) {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const ld = JSON.parse(script.textContent);
            const product = ld['@type'] === 'Product' ? ld : null;
            if (product && Array.isArray(product.image)) {
              data.photo_count = product.image.length;
              break;
            }
          } catch(e) {}
        }
      }

      // ─── Has video ───
      data.has_video = !!document.querySelector('video[id^="listing-video"], [data-video-pane]');
      // Fallback: JSON-LD VideoObject
      if (!data.has_video) {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const ld = JSON.parse(script.textContent);
            if (ld['@type'] === 'VideoObject') { data.has_video = true; break; }
          } catch(e) {}
        }
      }

      // ─── Related search queries (Etsy's own suggestions) ───
      data.related_search_queries = [];
      try {
        const tagsContainer = document.querySelector('[data-appears-component-name="Listzilla_ApiSpecs_Tags_MultiChannelLanding"]');
        if (tagsContainer) {
          const eventData = tagsContainer.getAttribute('data-appears-event-data');
          if (eventData) {
            const parsed = JSON.parse(eventData);
            if (Array.isArray(parsed.queries)) {
              data.related_search_queries = parsed.queries;
            }
          }
        }
      } catch(e) {}
      // Fallback: scrape the visual tag cards text
      if (data.related_search_queries.length === 0) {
        const tagCards = document.querySelectorAll('.tag-cards-section-container-with-images .wt-card');
        for (const card of tagCards) {
          const link = card.querySelector('a[href*="/market/"]');
          if (link) {
            const text = link.textContent.trim();
            if (text && text.length > 1 && text.length < 100) {
              data.related_search_queries.push(text);
            }
          }
        }
      }

      // ─── Shop data from listing detail page ───
      // 2026-04-19: extractor rewritten to match Etsy's current "Meet your seller"
      // section DOM. Verified against live listing HTML. Captures rating + review
      // count + sales (with k/m suffix) + tenure (computed → year) + star seller +
      // team size + location.
      data.shop_total_sales = null;
      data.shop_location = null;
      data.shop_established = null;
      data.is_star_seller = false;
      data.shop_team_size = null;
      data.shop_rating = null;
      data.shop_review_count = null;

      // Helper: parse "26.3k" / "9.7k" / "1.2m" / "1,234" → integer
      const parseHumanNumber = (s) => {
        if (!s) return null;
        const cleaned = String(s).trim().replace(/[(),]/g, '').toLowerCase();
        const m = cleaned.match(/^([\d.]+)\s*([km]?)$/);
        if (!m) return null;
        let n = parseFloat(m[1]);
        if (isNaN(n)) return null;
        if (m[2] === 'k') n *= 1000;
        else if (m[2] === 'm') n *= 1000000;
        return Math.round(n);
      };

      // ─── Shop rating + review count (seller cred area) ───
      // DOM: <span class="rating-and-reviews-count__avg-rating">5.0</span>
      //      <span class="rating-and-reviews-count__reviews-count">(9.7k)</span>
      try {
        const ratingEl = document.querySelector('.rating-and-reviews-count__avg-rating');
        if (ratingEl) {
          const r = parseFloat(ratingEl.textContent.trim());
          if (!isNaN(r) && r > 0) data.shop_rating = r;
        }
        const reviewsEl = document.querySelector('.rating-and-reviews-count__reviews-count');
        if (reviewsEl) {
          const n = parseHumanNumber(reviewsEl.textContent);
          if (n != null && n > 0) data.shop_review_count = n;
        }
      } catch(e) {}

      // ─── Shop total sales ───
      // DOM has e.g. "26.3k sales" inside .wt-text-title in seller cred row.
      // Old regex `([\d,]+)\s+sales` missed "26.3k sales" — handle k/m suffix.
      const salesMatch = pageText.match(/([\d,.]+)\s*([kKmM]?)\s+sales\b/);
      if (salesMatch) {
        const salesNum = parseHumanNumber(salesMatch[1] + salesMatch[2]);
        if (salesNum && salesNum > 0) data.shop_total_sales = salesNum;
      }

      // ─── Shop location ───
      // Meta description: "Dispatched from United States" or "Ships from ..."
      // Also seller cred has "<p>Atlanta, Georgia</p>" near shop name.
      if (metaDesc) {
        const descContent = metaDesc.getAttribute('content') || '';
        const locMatch = descContent.match(/(?:Dispatched|Ships?)\s+from\s+([^.,"]+)/i);
        if (locMatch) data.shop_location = locMatch[1].trim();
      }
      // Fallback: JSON-LD shipping origin
      if (!data.shop_location) {
        for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
          try {
            const ld = JSON.parse(script.textContent);
            const product = ld['@type'] === 'Product' ? ld : null;
            if (product && product.offers && product.offers.shippingDetails) {
              const origin = product.offers.shippingDetails.shippingOrigin;
              if (origin && origin.addressCountry) {
                data.shop_location = origin.addressCountry;
              }
            }
          } catch(e) {}
        }
      }

      // ─── Shop established / tenure → derived year ───
      // 2026-04-19: Etsy moved away from "On Etsy since YYYY". Now shows
      // "X years on Etsy" via component data-appears-component-name="lp_seller_cred_tenure"
      // with data-appears-event-data='{"tenure":"4 years"}'. Compute year as
      // currentYear - tenureYears so we keep storing a year string for display.
      try {
        const tenureEl = document.querySelector('[data-appears-component-name="lp_seller_cred_tenure"]');
        if (tenureEl) {
          const eventData = tenureEl.getAttribute('data-appears-event-data');
          if (eventData) {
            const parsed = JSON.parse(eventData);
            const tenureStr = String(parsed.tenure || '');
            const yearMatch = tenureStr.match(/(\d+)\s*year/i);
            const monthMatch = tenureStr.match(/(\d+)\s*month/i);
            const currentYear = new Date().getFullYear();
            if (yearMatch) {
              data.shop_established = String(currentYear - parseInt(yearMatch[1]));
            } else if (monthMatch) {
              data.shop_established = String(currentYear);
            }
          }
        }
      } catch(e) {}
      // Fallback 1: visible text "X years on Etsy"
      if (!data.shop_established) {
        const m = pageText.match(/(\d+)\s+years?\s+on\s+Etsy\b/i);
        if (m) {
          data.shop_established = String(new Date().getFullYear() - parseInt(m[1]));
        }
      }
      // Fallback 2: legacy "On Etsy since YYYY" (older shops may still show this)
      if (!data.shop_established) {
        const sinceMatch = pageText.match(/On\s+Etsy\s+since\s+(\d{4})/i);
        if (sinceMatch) data.shop_established = sinceMatch[1];
      }

      // ─── Star Seller badge ───
      data.is_star_seller = !!document.querySelector('[data-appears-component-name*="star_seller"], [class*="star-seller"], [aria-label*="Star Seller"], clg-icon[name="starseller"]');
      if (!data.is_star_seller) {
        data.is_star_seller = /Star\s+Seller/i.test(pageText);
      }

      // ─── Shop team size ───
      try {
        const membersEl = document.querySelector('[data-appears-component-name="lp_seller_cred_shop_members"]');
        if (membersEl) {
          const eventData = membersEl.getAttribute('data-appears-event-data');
          if (eventData) {
            const parsed = JSON.parse(eventData);
            if (parsed.total_members) data.shop_team_size = parsed.total_members;
          }
        }
      } catch(e) {}

      sendResponse({ success: true, data });
    } catch (err) {
      sendResponse({ success: false, error: err.message, data: {} });
    }
  }
})();
