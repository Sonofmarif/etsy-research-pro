# Etsy Research Pro — Project Context
# Paste this at the start of every new Claude session

## PROJECT STATUS
Building: Open-source Etsy niche research Chrome Extension
Base code: Niche Moat extension (ZIP analyzed, scraper code extracted)
Owner: Muhammad Ali — MashriqTraders Etsy shop (Pakistan)

## COMPLETED
- [x] Etsy API approved (key: 8znfc0idv0afr6a717gl1x5b)
- [x] MashriqTraders shop live with 1 listing
- [x] Extension folder: etsy-research-pro/ (partial)
- [x] Files done: manifest.json, config.js, rate-limiter.js, ai-analyzer.js, exporter.js
- [x] Niche Moat scraper copied (etsy-search-extractor.js) — production quality

## ARCHITECTURE DECIDED
Stack: Chrome Extension + Hostinger PHP API + MySQL
- Extension: Manifest V3, vanilla JS, no framework
- Backend: Hostinger (already paid) — PHP or Node.js
- Database: MySQL (included in Hostinger plan)
- AI: Gemini 1.5 Flash (free, user's own key) + math fallback
- Export: CSV download + Google Sheets

## FILE STRUCTURE
etsy-research-pro/
├── manifest.json ✅
├── icons/ ✅ (copied from Niche Moat)
└── src/
    ├── background/service-worker.js ⏳
    ├── content-scripts/
    │   └── etsy-search-extractor.js ✅ (Niche Moat's production scraper)
    ├── popup/
    │   ├── popup.html ⏳
    │   ├── popup.js ⏳
    │   └── popup.css ⏳
    ├── utils/
    │   ├── config.js ✅
    │   └── rate-limiter.js ✅
    └── modules/
        ├── ai-analyzer.js ✅ (Gemini + Groq + math fallback)
        └── exporter.js ✅ (CSV + JSON)

## PENDING
- [x] service-worker.js (main orchestrator — completed and verified)
- [x] popup.html + popup.js + popup.css (4-tab UI: Research/History/Settings/Audit — completed)
- [x] Dashboard page (completed with custom Canvas charts)
- [x] 90-day history system (completed using chrome.storage.local)
- [ ] Deploy Cloudflare Worker & D1 Database (wrangler setup)
- [ ] Hostinger backend (optional PHP API + MySQL alternative if preferred)

## KEY DECISIONS
- NO license server (open source, user owns everything)
- AI is optional (math scoring works without API key)
- Etsy login detection (warn if logged in on search profile)
- Multi-profile scraping support
- Central seed keywords from Hostinger backend

## TECH NOTES
- Niche Moat scraper: handles Shadow DOM, ad filtering, Recently Viewed exclusion
- Rate limiter: 14 RPM, 1400 RPD (Gemini free tier safe)
- AI fallback: pure math scoring if no API key
- Storage: chrome.storage.local for 90-day history

## NEXT SESSION PROMPT
"Continue building Etsy Research Pro extension. 
Context file above has full status. 
Next task: Build service-worker.js and popup UI"
