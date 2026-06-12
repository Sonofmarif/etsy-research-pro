# ETSY RESEARCH PRO — MASTER PRD v1.0
## Complete Product Requirements Document
**For AI Agents:** Google Antigravity, Claude, Codex, Cursor, or any AI coding assistant
**Owner:** Muhammad Ali | Hyderabad, Pakistan | MashriqTraders Etsy shop
**Date:** 2026-05-29 | **Status:** Phase 1 in progress

---

## QUICK SUMMARY FOR AI AGENTS

You are building a Chrome Extension called "Etsy Research Pro" — a FREE, open-source alternative to Niche Moat ($3000/month). It helps Etsy sellers find profitable low-competition niches by scraping Etsy, running AI analysis, and showing Win Scores — all in the user's browser with their own free API key.

**Key rules — never break these:**
1. NO license server — fully open source, user owns everything
2. AI is OPTIONAL — math scoring works without any API key
3. eRank is OPTIONAL — better with it, works without it
4. Works for ALL types: digital, physical, print-on-demand
5. Manifest V3 — vanilla JavaScript ONLY, no React/Vue/jQuery
6. Cloudflare Workers backend — free tier only
7. API keys NEVER leave user's browser — never sent to server

---

## VISION AND MISSION

### The Problem
- Etsy research tools cost $3000/month — unaffordable for new sellers
- Free tools give generic advice, not data-driven insights
- No tool exists that works for ALL product types
- Pakistani and developing world sellers are especially disadvantaged

### The Solution
A completely free Chrome Extension that:
- Scrapes real Etsy data (not eRank dependent)
- Uses user's own free Gemini/Groq API key
- Gives Win Scores based on real competition + demand analysis
- Stores 90-day history for trend tracking
- Gets smarter as community uses it

### Goals
- Phase 1 (Now): Best free Etsy research tool available
- Phase 2 (Future): Community platform — experienced sellers mentor newcomers
- Long term: Pakistani developer community recognition, sustainable open source

---

## SYSTEM ARCHITECTURE

```
USER'S CHROME BROWSER
├── POPUP UI (4 tabs: Research / Audit / History / Settings)
│   └── communicates with Service Worker via chrome.runtime.sendMessage
│
├── SERVICE WORKER (service-worker.js)
│   ├── Routes all messages
│   ├── Orchestrates research flow
│   ├── Manages run state
│   └── Calls all modules
│
├── CONTENT SCRIPTS
│   ├── etsy-search-extractor.js (scrapes Etsy search results)
│   └── erank-extractor.js (optional: reads eRank data)
│
├── MODULES
│   ├── ai-analyzer.js (Gemini + Groq + math fallback)
│   ├── seo-auditor.js (listing SEO analysis)
│   ├── history-manager.js (90-day storage)
│   ├── exporter.js (CSV + JSON download)
│   └── rate-limiter.js (API rate control)
│
└── DASHBOARD (dashboard.html — opens in new tab)
    ├── 90-day history charts
    ├── Niche trend analysis
    └── Re-run any past keyword

EXTERNAL SERVICES (all optional/free)
├── Etsy.com — scraped directly (no API, no login needed)
├── Gemini API — user's own free key
├── Groq API — user's own free key
├── eRank.com — user logs in browser (no credentials stored)
└── Cloudflare Workers — free backend for seed keywords + community data
```

---

## COMPLETE FILE STRUCTURE

```
etsy-research-pro/
├── manifest.json                    DONE
├── MASTER_PRD.md                    DONE (this file)
├── README.md                        TODO
│
├── icons/
│   ├── icon16.png                   DONE
│   ├── icon48.png                   DONE
│   └── icon128.png                  DONE
│
├── src/
│   ├── background/
│   │   └── service-worker.js        DONE
│   │
│   ├── content-scripts/
│   │   ├── etsy-search-extractor.js DONE (Niche Moat base, production quality)
│   │   └── erank-extractor.js       TODO
│   │
│   ├── popup/
│   │   ├── popup.html               DONE
│   │   ├── popup.js                 DONE
│   │   └── popup.css                DONE
│   │
│   ├── dashboard/
│   │   ├── dashboard.html           TODO
│   │   ├── dashboard.js             TODO
│   │   └── dashboard.css            TODO
│   │
│   ├── utils/
│   │   ├── config.js                DONE
│   │   └── rate-limiter.js          DONE
│   │
│   └── modules/
│       ├── ai-analyzer.js           DONE
│       ├── exporter.js              DONE
│       ├── seo-auditor.js           TODO
│       └── history-manager.js       TODO
│
└── cloudflare-worker/
    ├── worker.js                    TODO
    └── schema.sql                   TODO
```

---

## FEATURE SPECIFICATIONS

### FEATURE 1: Interest-Based Seed Keywords

**Purpose:** Help new sellers start with good keyword ideas based on what they like

**Flow:**
1. On first install, popup shows: "What do you want to sell?"
2. User picks from dropdown OR types custom interest
3. System returns 12-15 seed keywords from two sources:
   - Cloudflare D1 database (pre-researched by owner)
   - Built-in local list per category
4. Keywords shown as clickable chips in popup
5. User clicks chip → keyword fills search box

**Interest Categories:**
- Islamic/Spiritual
- Home Decor
- Pet Products
- Baby/Kids
- Wedding
- Print-on-Demand (t-shirts, mugs, tote bags)
- Digital Planners (notion templates, PDF planners)
- Jewelry
- Wall Art Printables
- Seasonal (Christmas, Ramadan, Halloween)

**Built-in Keywords per Category (example — Islamic/Spiritual):**
- crystal prayer beads 99
- islamic wall art printable
- quran verse print digital
- ramadan planner pdf
- dua cards printable
- 99 names of allah print
- muslim gift ideas
- arabic calligraphy wall art
- bismillah print digital
- islamic home decor printable

---

### FEATURE 2: Etsy Scraper

**Purpose:** Extract real Etsy listing data without needing Etsy API

**Important:** Works best WITHOUT Etsy login. Extension detects login and warns user.

**Login Detection:**
```javascript
function detectEtsyLogin() {
  return !!(
    document.querySelector('[data-user-id]') ||
    document.querySelector('.signed-in-user') ||
    document.querySelector('[data-analytics-region="user-menu"]') ||
    document.cookie.includes('user_prefs')
  );
}
```

**If login detected:** Show warning banner — recommend separate Chrome profile (Guest mode)

**Data extracted per listing:**
```
listing_id        string    Etsy listing ID from URL
title             string    Full listing title (max 140 chars)
price             number    Numeric price in USD
shop_name         string    Seller shop name
shop_reviews      number    Total shop review count
is_bestseller     boolean   Has bestseller badge
is_popular_now    boolean   Has "popular right now" badge
urgency_text      string    "15 people have this in cart"
tags              array     All listing tags
listing_age_days  number    Days since first published (if available)
product_type      string    digital | physical | pod | unknown
etsy_url          string    Full listing URL
scraped_at        string    ISO timestamp
```

**CSS Selectors (multi-fallback — Etsy changes classes often):**
```javascript
SELECTORS = {
  card: [
    '[data-listing-id]',
    '[data-search-results-item]',
    'div[data-appears-component-name="search_organic_listing"]',
    'div[class*="v2-listing-card"]',
    'li[class*="search-listing-card"]'
  ],
  title: ['h3', 'h2', '[class*="listing-title"]', '[data-testid="listing-title"]'],
  price: ['[class*="currency-value"]', '[class*="lc-price"]', '[class*="price-"]'],
  reviews: ['[class*="rating-count"]', '[aria-label*="review"]'],
  bestseller: ['[class*="bestseller"]', '[class*="Bestseller"]'],
  urgency: ['[class*="urgency"]', '[class*="in-cart"]', '[class*="demand"]']
}
```

**Anti-detection:**
- Random delay between listing reads: 800ms to 2000ms
- Scroll page naturally before reading
- Limit: max 50 listings per scan

**Product type detection:**
```javascript
function detectProductType(listing) {
  const title = listing.title.toLowerCase();
  const url = listing.etsy_url;
  if (url.includes('digital_download') || 
      title.includes('printable') || 
      title.includes('digital') ||
      title.includes('pdf') ||
      title.includes('svg')) return 'digital';
  if (title.includes('t-shirt') || 
      title.includes('mug') || 
      title.includes('tote') ||
      title.includes('print on demand')) return 'pod';
  return 'physical';
}
```

---

### FEATURE 3: eRank Optional Integration

**Purpose:** Enhance data with eRank's monthly searches and competition levels

**How it works:**
1. User logs into eRank.com in their browser (no credentials stored by extension)
2. When research starts, extension checks if eRank tab is open
3. If open: fires erank-extractor.js on eRank keyword page
4. Reads enhanced data silently in background
5. Merges with Etsy scrape data

**Data added from eRank:**
```
monthly_searches    number    Estimated monthly Etsy searches
competition_level   string    Low | Medium | High | Very High
trend_direction     string    up | down | stable
ctr                 number    Average click-through rate
related_keywords    array     Top 5 related keywords
```

**eRank selectors:**
```javascript
ERANK_SELECTORS = {
  searches:    '[data-search-volume], .searches-count, .kw-searches',
  competition: '.competition-level span, [data-competition], .kw-competition',
  trend:       '.trend-indicator, [data-trend], .kw-trend',
  ctr:         '.click-through-rate, .kw-ctr',
  related:     '.related-keywords li, .similar-keywords li'
}
```

**If eRank unavailable:** System works normally with Etsy-only data. User sees no error.

---

### FEATURE 4: Win Score Algorithm

**Formula:**
```
Win Score = (Demand × 0.40) + (Beatability × 0.35) + (Trend × 0.15) + (Price × 0.10)
Range: 0-100
```

**Demand Score (0-100):**
```
Base:                    20
+ is_bestseller:         +25
+ urgency "in cart":     +20
+ urgency "in demand":   +15
+ shop_reviews > 100:    +10  (proven market exists)
+ listing age < 30 days: +10  (fresh content ranks)
Maximum:                 100
```

**Beatability Score (0-100):**
```
Count listings in top 12 results where shop_reviews < 300
beatability = (beatable_count / 12) × 100
Example: 9 shops with <300 reviews → score = 75
```

**Trend Score (0-100):**
```
WITH eRank:
  Use eRank trend directly (up=80, stable=60, down=30)
  
WITHOUT eRank (estimated):
  Base: 50
  Most listings < 6 months old: +20
  Seasonal keyword match: +30 (Ramadan, Christmas, etc.)
  High review count shops: -10 (saturated = declining)
```

**Price Sweet Spot (0-100):**
```
Digital:      $4-15=100,  $15-25=70,  $1-4=50,   $25+=30
Physical:     $15-60=100, $8-15=70,   $60-100=60, $100+=30
POD:          $20-45=100, $15-20=70,  $45-60=60,  $60+=30
```

**Verdicts:**
```
70-100: WIN    Low competition, good demand — go for it
50-69:  GOOD   Worth considering
30-49:  AVERAGE High competition or weak demand — proceed carefully
0-29:   SKIP   Too competitive or no real demand
```

---

### FEATURE 5: AI Analysis (Optional)

**Providers supported:**
1. Google Gemini 1.5 Flash — recommended (free tier: 15 RPM, 1500 RPD)
2. Groq llama-3.1-8b-instant — alternative (very fast, free tier)
3. None — falls back to math scoring (always works)

**Rate Limiter (Gemini free tier safe):**
- Max 14 requests per minute (1 buffer below limit)
- Max 1400 requests per day (100 buffer)
- Batch: 5 listings per AI call (reduces total calls)
- Auto-waits if approaching limit
- Shows progress: "Analyzing 20/50..."

**AI adds on top of math scoring:**
- Groups listings into named micro-niches
- Identifies specific market opportunity
- Names the target buyer persona
- Recommends price range
- Generates Midjourney/DALL-E image prompt
- Gives specific verdict with reasoning

**Fallback chain:**
```
Try Gemini → if fails try Groq → if fails use math scoring
Never shows error to user for AI failure — silently falls back
```

---

### FEATURE 6: Listing SEO Audit

**Purpose:** User pastes any Etsy listing URL and gets actionable SEO improvements

**Process:**
1. Extension opens URL in background tab (user doesn't see it)
2. Scrapes: title, tags, description, price, category, reviews
3. Sends to AI for audit analysis
4. Closes background tab
5. Shows audit report in popup

**Audit checks:**
- Title: keyword at start, length (130-140 chars optimal), specificity
- Tags: count (should be 13), long-tail phrases, no duplicate title words
- Description: first 160 chars keyword density, readability
- Price: comparison to niche average
- Missing keywords that top competitors use

**Output:**
- Overall SEO score (0-100)
- Title score with issues
- Tags score with missing keywords
- Specific fix suggestions with examples
- Better title (ready to copy)
- Better tags list of 13 (ready to copy)
- Keyword gap analysis

---

### FEATURE 7: 90-Day History Dashboard

**Storage:**
- Primary: chrome.storage.local (up to 500 runs, ~50MB)
- Backup: Cloudflare D1 (anonymized, for community insights)

**Dashboard page (opens in full Chrome tab):**
- Header: extension name + total runs + total niches found
- Filters: date range, product type, min win score
- Chart 1: Line chart — win scores over time per keyword
- Chart 2: Bar chart — top 10 most researched keywords
- Table: All runs — sortable by date, score, keyword
- Re-run button: re-runs same keyword to compare
- Trend indicator: "This niche was score 45 thirty days ago, now 72"
- Export all history as CSV

**History item stored per run:**
```json
{
  "run_id": "uuid",
  "keyword": "crystal prayer beads",
  "date": "2026-05-29T10:00:00Z",
  "product_type": "physical",
  "source": "etsy_only",
  "ai_mode": "gemini",
  "stats": {
    "total": 48,
    "wins": 5,
    "avg_win_score": 62,
    "avg_price": 18.99,
    "beatable_slots": 8
  },
  "top_niches": [
    { "name": "Multicolor Crystal Sets", "win_score": 82, "verdict": "WIN" }
  ]
}
```

---

### FEATURE 8: Export System

**CSV Export includes:**
- All listings with scores
- Cluster/niche groupings
- AI-generated image prompts
- Summary stats
- Date and keyword header

**JSON Export includes:**
- Complete run data
- All raw listings
- All clusters
- Stats object
- Metadata (date, AI mode, source)

---

## AI PROMPTS — EXACT TEXT

### Cluster Analysis Prompt
```
You are an expert Etsy product researcher specializing in profitable niches.

Keyword: "[KEYWORD]"
Product type: [PRODUCT_TYPE]

Analyze these [N] Etsy listings and group into 3-6 specific micro-niches:

[LISTINGS - format: N. "title" | $price | Reviews:N | Bestseller:Y/N | Urgency:TEXT]

For each micro-niche return this JSON:
{
  "niche": "Specific niche name",
  "product_type": "digital|physical|pod",
  "listings": [1,4,7],
  "demand_score": 75,
  "competition_score": 40,
  "win_score": 85,
  "opportunity": "What specific gap exists",
  "target_buyer": "Who buys this",
  "price_recommendation": "$8-12",
  "image_prompt": "Midjourney/DALL-E optimized prompt",
  "verdict": "WIN|AVERAGE|SKIP — one line reason",
  "keywords_to_target": ["kw1","kw2","kw3"]
}

Return ONLY valid JSON array. No markdown. No explanation outside JSON.
```

### SEO Audit Prompt
```
You are an Etsy SEO expert. Audit this listing.

Title: "[TITLE]"
Tags: [TAGS]
Description start: "[FIRST 200 CHARS]"
Price: $[PRICE] | Category: [CATEGORY] | Reviews: [N]

Return this JSON only:
{
  "overall_score": 67,
  "title_score": 55,
  "tags_score": 70,
  "description_score": 60,
  "issues": ["issue 1", "issue 2"],
  "fixes": ["specific fix with example", "specific fix 2"],
  "better_title": "Full optimized title here",
  "better_tags": ["tag1","tag2",...13 total],
  "keyword_gaps": ["missing kw 1","missing kw 2"],
  "price_analysis": "Your price vs niche average"
}
```

### Seed Keywords Prompt
```
Etsy seller interested in: "[INTEREST]"
Generate 15 specific long-tail Etsy search keywords.
Focus on: good search potential, lower competition, mix of product types.

Return JSON:
{
  "keywords": ["specific keyword 1",...15 total],
  "niche_ideas": ["niche idea 1","niche idea 2"],
  "hot_right_now": ["trending keyword"],
  "low_competition_picks": ["low comp keyword"]
}
```

---

## CLOUDFLARE WORKER API

**Base URL:** https://api.etsy-research-pro.workers.dev

**Endpoints:**

GET /health
- Returns: { status: "ok", timestamp: "..." }

GET /seeds?category=Islamic
- Returns: { keywords: [...], source: "database" }
- Falls back to empty if DB unavailable

POST /save-run
- Body: { keyword, stats, top_niches, date, product_type }
- Saves anonymized data only — NO personal info, NO API keys
- Returns: { saved: true }

GET /trending?limit=10
- Returns top niches by win score this week
- Returns: { niches: [{ name, avg_score, count }] }

GET /niche-history?q=prayer+beads
- Returns historical win scores for a keyword
- Returns: { history: [{ date, avg_score }] }

**Security:**
- CORS: only from chrome-extension:// origins
- Rate limiting: 100 requests per IP per hour
- Input validation on all parameters
- Parameterized SQL queries only
- No user data stored — only anonymous aggregate data

---

## DATABASE SCHEMA (Cloudflare D1 — SQLite)

```sql
CREATE TABLE research_runs (
  id TEXT PRIMARY KEY,
  keyword TEXT NOT NULL,
  run_date TEXT NOT NULL,
  product_type TEXT DEFAULT 'any',
  listings_count INTEGER DEFAULT 0,
  wins_count INTEGER DEFAULT 0,
  avg_win_score REAL DEFAULT 0,
  avg_price REAL DEFAULT 0,
  source TEXT DEFAULT 'etsy_only',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE niche_performance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  niche_name TEXT NOT NULL,
  keyword TEXT NOT NULL,
  win_score INTEGER,
  product_type TEXT,
  run_date TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE seed_keywords (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  category TEXT NOT NULL,
  avg_win_score REAL DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE trending_niches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  niche_name TEXT NOT NULL,
  keyword TEXT NOT NULL,
  avg_score REAL DEFAULT 0,
  run_count INTEGER DEFAULT 1,
  week_start TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_runs_keyword ON research_runs(keyword);
CREATE INDEX idx_runs_date ON research_runs(run_date);
CREATE INDEX idx_niches_keyword ON niche_performance(keyword);
CREATE INDEX idx_seeds_category ON seed_keywords(category);
```

---

## SECURITY REQUIREMENTS

1. All API keys stored in chrome.storage.local ONLY (encrypted by Chrome)
2. API keys NEVER sent to any server, ever
3. Cloudflare worker receives ONLY: keyword, scores, dates — no user identity
4. No user accounts, no tracking, no analytics
5. CSP in manifest: script-src 'self' only
6. D1 queries: parameterized only, no string concatenation
7. Worker rate limit: 100 req/IP/hour
8. CORS: extension origin only
9. All input sanitized before storage or display

---

## UI SPECIFICATIONS

**Popup:**
- Width: 380px fixed
- Background: #0f0f1a (very dark navy)
- Accent: #F1641E (Etsy orange)
- Success: #4ade80 (green)
- Error: #f87171 (red)
- Font: system font stack

**4 Tabs:** Research | Audit | History | Settings

**Color coding for scores:**
- 70+: green (#4ade80)
- 50-69: orange (#F1641E)
- 30-49: yellow (#fbbf24)
- 0-29: red (#f87171), card opacity 0.6

**Dashboard page:**
- Full width Chrome tab
- Same dark color scheme
- Charts using Chart.js (CDN, no install)
- Responsive layout

---

## BUILD ORDER FOR AI AGENTS

### Session 1 — COMPLETED
- manifest.json
- service-worker.js
- popup.html + popup.js + popup.css
- ai-analyzer.js
- rate-limiter.js
- config.js
- exporter.js
- etsy-search-extractor.js

### Session 2 — NEXT
- seo-auditor.js
- history-manager.js
- erank-extractor.js

### Session 3
- dashboard.html + dashboard.js + dashboard.css
- cloudflare-worker/worker.js
- cloudflare-worker/schema.sql

### Session 4
- README.md
- Testing all flows
- Bug fixes
- ZIP package

---

## PHASE 2 — COMMUNITY PLATFORM (Future Concept Only)

After 100+ active users:

**New Seller Onboarding:**
- Interest quiz → personalized niche roadmap
- 30-day action plan: research → design → list → optimize
- Step-by-step Etsy setup guidance

**Mentor System:**
- Sellers with 100+ Etsy sales can apply as mentors
- Help newcomers via community forum
- Earn mentor points for each person helped

**Rating Unlock System:**
- Help a seller → they rate you → you earn points
- 100 points → unlock Community Niche Database
- Database contains: most profitable niches found by ALL users
- Creates flywheel: help others → get better data → sell more → help others

**Community Niche Database:**
- Stored server-side (Cloudflare D1)
- Populated by aggregated anonymous scan data
- Locked behind mentor points system
- New users get preview (top 3 niches) as incentive to join

---

## RESUME TEMPLATE FOR NEW SESSIONS

Copy this exactly at start of new Claude/AI session:

```
I am building "Etsy Research Pro" Chrome Extension.
[UPLOAD MASTER_PRD.md]

Session status: Session [N] complete.
Files done: [LIST DONE FILES]
Next task: Build [SPECIFIC FILE].

Follow all specifications in the PRD exactly.
Use vanilla JavaScript only.
No external libraries except for dashboard charts (Chart.js CDN).
```

---

*MASTER PRD v1.0 | 2026-05-29 | Muhammad Ali | Hyderabad Pakistan*
*Next session: seo-auditor.js + history-manager.js + erank-extractor.js*
