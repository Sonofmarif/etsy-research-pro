// eRank Extractor — Content Script (Optional Integration)
// Runs on: https://members.erank.com/*
// Reads keyword data when user has eRank tab open

(function () {
  'use strict';

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    try {
      if (msg.action === 'checkErankLogin') {
        handleCheckLogin(sendResponse);
        return true;
      }
      if (msg.action === 'extractErankKeywordData') {
        handleExtractKeywordData(sendResponse);
        return true;
      }
      if (msg.action === 'extractErankSuggestions') {
        handleExtractSuggestions(sendResponse);
        return true;
      }
      return false;
    } catch (e) {
      console.error('[ERP] eRank extractor onMessage error:', e);
      sendResponse({ success: false, error: e.message });
      return false;
    }
  });

  // ─── Login check ────────────────────────────────────────────────────────
  function handleCheckLogin(sendResponse) {
    const loginForm = document.querySelector('form[action*="login"], input[name="email"], .login-form, #login-form');
    const keywordTool = document.querySelector('.keyword-tool, #keyword-tool, .search-bar, input[name="keyword"]');
    const bodyText = document.body.innerText.toLowerCase();
    const hasLoginIndicators = bodyText.includes('sign in') && bodyText.includes('password') && !bodyText.includes('keyword explorer');
    const hasToolIndicators = bodyText.includes('avg searches') || bodyText.includes('keyword explorer') || bodyText.includes('etsy competition');

    if (loginForm && !keywordTool) {
      sendResponse({ loggedIn: false });
    } else if (hasLoginIndicators && !hasToolIndicators) {
      sendResponse({ loggedIn: false });
    } else {
      sendResponse({ loggedIn: true });
    }
  }

  // ─── Extract main keyword metrics ───────────────────────────────────────
  function handleExtractKeywordData(sendResponse) {
    try {
      const data = {
        monthly_searches: 0,
        competition_level: 'Unknown',
        trend_direction: 'stable',
        ctr: 0,
        related_keywords: []
      };

      const pageText = document.body.innerText;

      // Avg searches
      const searchMatch = pageText.match(/Avg[\s.]*Searches[:\s]*([0-9,]+)/i);
      if (searchMatch) data.monthly_searches = parseInt(searchMatch[1].replace(/,/g, ''));

      // Competition
      const compMatch = pageText.match(/(?:Etsy\s+)?Competition[:\s]*([0-9,]+)/i);
      if (compMatch) {
        const comp = parseInt(compMatch[1].replace(/,/g, ''));
        if (comp < 5000) data.competition_level = 'Low';
        else if (comp < 15000) data.competition_level = 'Medium';
        else if (comp < 30000) data.competition_level = 'High';
        else data.competition_level = 'Very High';
      }

      // CTR
      const clickMatch = pageText.match(/Click\s*Rate[:\s]*([0-9.]+)%?/i);
      if (clickMatch) data.ctr = parseFloat(clickMatch[1]);

      // Trend direction
      const trendEls = document.querySelectorAll('.trend-indicator, [data-trend], .kw-trend');
      for (const el of trendEls) {
        const text = (el.textContent || el.getAttribute('data-trend') || '').toLowerCase();
        if (text.includes('up') || text.includes('rising')) data.trend_direction = 'up';
        else if (text.includes('down') || text.includes('falling')) data.trend_direction = 'down';
        else data.trend_direction = 'stable';
      }

      // Related keywords
      const relatedEls = document.querySelectorAll('.related-keywords li, .similar-keywords li, [class*="related"] a');
      relatedEls.forEach(el => {
        const text = el.textContent.trim();
        if (text && text.length > 2 && text.length < 60 && data.related_keywords.length < 5) {
          data.related_keywords.push(text);
        }
      });

      sendResponse({ success: true, data });
    } catch (err) {
      sendResponse({ success: false, error: err.message, data: null });
    }
  }

  // ─── Extract keyword suggestion table ───────────────────────────────────
  function handleExtractSuggestions(sendResponse) {
    try {
      const suggestions = [];

      const tables = document.querySelectorAll('table');
      let targetTable = null;
      let bestScore = 0;

      for (const table of tables) {
        const headerRow = table.querySelector('thead tr:first-child, tr:first-child');
        if (!headerRow) continue;
        const headerText = headerRow.innerText.toLowerCase();

        let score = 0;
        if (headerText.includes('keyword')) score += 3;
        if (headerText.includes('searches') || (headerText.includes('avg') && headerText.includes('search'))) score += 2;
        if (headerText.includes('competition') || headerText.includes('compet')) score += 2;
        if (headerText.includes('ctr')) score += 1;
        if (headerText.includes('click')) score += 1;
        const bodyRows = table.querySelectorAll('tbody tr');
        const visibleRows = Array.from(bodyRows).filter(r => r.offsetParent !== null || r.offsetHeight > 0);
        score += Math.min(visibleRows.length, 5);
        const headerCells = headerRow.querySelectorAll('th, td');
        if (headerCells.length >= 6) score += 2;

        if (score > bestScore) {
          bestScore = score;
          targetTable = table;
        }
      }

      if (!targetTable) {
        targetTable = document.querySelector('[class*="keyword-table"], [class*="suggestions"], .table');
      }

      if (targetTable) {
        const rows = targetTable.querySelectorAll('tbody tr');
        const headerRow = targetTable.querySelector('thead tr:first-child');

        let colMap = {};
        if (headerRow) {
          const headers = Array.from(headerRow.querySelectorAll('th, td'))
            .map(h => (h.innerText || '').trim().toLowerCase()
              .replace(/[↑↓⇅↕]/g, '').replace(/\s+/g, ' ').trim());

          // Exact match pass
          const exactMap = {
            keyword: ['keywords', 'keyword'],
            avg_searches: ['avg. searches', 'avg searches', 'average searches'],
            avg_clicks: ['avg. clicks', 'avg clicks', 'average clicks'],
            click_rate: ['avg. ctr', 'avg ctr', 'ctr', 'average ctr'],
            competition: ['etsy competition', 'competition']
          };
          for (const [slot, labels] of Object.entries(exactMap)) {
            for (let i = 0; i < headers.length; i++) {
              if (labels.includes(headers[i])) { colMap[slot] = i; break; }
            }
          }

          // Substring fallback
          const claimed = new Set(Object.values(colMap));
          headers.forEach((h, i) => {
            if (claimed.has(i)) return;
            if (colMap.keyword === undefined && h.includes('keyword')) { colMap.keyword = i; claimed.add(i); }
            if (colMap.avg_searches === undefined && /searches/.test(h) && !h.includes('trend') && !h.includes('google')) { colMap.avg_searches = i; claimed.add(i); }
            if (colMap.competition === undefined && h.includes('compet')) { colMap.competition = i; claimed.add(i); }
            if (colMap.click_rate === undefined && h.includes('ctr')) { colMap.click_rate = i; claimed.add(i); }
          });
        }

        rows.forEach(row => {
          if (row.offsetParent === null && row.offsetHeight === 0) return;
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 3) return;

          const suggestion = {};

          if (colMap.keyword !== undefined) {
            const kwCell = cells[colMap.keyword];
            const link = kwCell?.querySelector('a');
            if (link) suggestion.keyword = link.innerText.trim();
            else {
              const bold = kwCell?.querySelector('b, strong');
              if (bold) suggestion.keyword = bold.innerText.trim();
              else suggestion.keyword = (kwCell?.innerText || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
            }
          }

          if (!suggestion.keyword || suggestion.keyword.length < 2) return;
          if (isJunkKeyword(suggestion.keyword)) return;

          if (colMap.avg_searches !== undefined)
            suggestion.avg_searches = parseNum(cells[colMap.avg_searches]?.innerText);
          if (colMap.competition !== undefined)
            suggestion.competition = parseNum(cells[colMap.competition]?.innerText);
          if (colMap.click_rate !== undefined) {
            let ctr = parseFloat(cells[colMap.click_rate]?.innerText?.replace('%', '')) || 0;
            if (ctr > 999) ctr /= 100;
            suggestion.click_rate = ctr;
          }
          if (colMap.avg_clicks !== undefined)
            suggestion.avg_clicks = parseNum(cells[colMap.avg_clicks]?.innerText);

          if (suggestion.keyword && ((suggestion.avg_searches || 0) > 0 || (suggestion.competition || 0) > 0)) {
            suggestions.push(suggestion);
          }
        });
      }

      sendResponse({ success: true, suggestions, totalFound: suggestions.length });
    } catch (err) {
      sendResponse({ success: false, error: err.message, suggestions: [] });
    }
  }

  // ─── Junk keyword filter ────────────────────────────────────────────────
  function isJunkKeyword(text) {
    if (!text) return true;
    const lower = text.trim().toLowerCase();
    if (lower.length < 3) return true;
    if (/^\d+$/.test(lower)) return true;
    if (/^[\/\\]/.test(text.trim())) return true;

    const uiJunk = new Set([
      'copy tags', 'copy tag', 'search trends', 'show filters',
      'categories', 'sort by', 'filter by', 'bestseller',
      'menu', 'dashboard', 'settings', 'account',
      'log in', 'log out', 'sign in', 'sign out', 'sign up',
      'star seller', 'free shipping'
    ]);
    if (uiJunk.has(lower)) return true;

    const junkPatterns = [
      'keyword stuffing', 'possible typo', 'repeated word',
      'misspelling', 'duplicate tag', 'too long', 'too short',
      'not relevant', 'low quality', 'character limit'
    ];
    for (const pat of junkPatterns) {
      if (lower.includes(pat)) return true;
    }

    if (/^["'\u201c\u201d]/.test(text.trim()) && /["'\u201c\u201d]/.test(text.trim())) return true;
    if (/appears\s+\d+\s+times?/i.test(lower)) return true;

    return false;
  }

  function parseNum(text) {
    if (!text) return 0;
    text = text.trim().replace(/,/g, '');
    const multiplierMatch = text.match(/([0-9.]+)\s*([kKmM])/);
    if (multiplierMatch) {
      const num = parseFloat(multiplierMatch[1]);
      const mult = multiplierMatch[2].toLowerCase() === 'k' ? 1000 : 1000000;
      return Math.round(num * mult);
    }
    return parseInt(text.replace(/[^0-9.-]/g, '')) || 0;
  }
})();
