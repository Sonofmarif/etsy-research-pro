# Etsy Research Pro 📊

> **Free, open-source alternative to Niche Moat** — Find profitable Etsy niches with Win Scores, AI-powered analysis, and 90-day trend tracking. All running in your browser.

---

## ✨ Features

### 🔍 Research Pipeline
- **Automated Etsy Scraping** — Extracts 50+ listing data points (price, reviews, badges, urgency signals, shop ratings)
- **Win Score Algorithm** — Proprietary 100-point scoring: `(Demand × 0.40) + (Beatability × 0.35) + (Trend × 0.15) + (Price × 0.10)`
- **Smart Clustering** — Groups listings into micro-niches with AI or math-based fallback
- **Product Type Detection** — Digital, Physical, Print-on-Demand auto-detection

### 🤖 AI Analysis (Optional — works without it too!)
- **Gemini 1.5 Flash** integration (free tier, bring your own key)
- **Groq (Llama 3.1)** integration (free tier, bring your own key)
- **Math-only fallback** — Always works, no API key needed
- **Fallback chain**: Gemini → Groq → Math

### 📊 Premium Dashboard
- **90-day history** with up to 500 research runs
- **Score Distribution** donut chart (WIN/GOOD/AVG/SKIP breakdown)
- **Win Scores Over Time** animated line chart
- **Most Researched Keywords** horizontal bar chart
- **Top Niche Spotlight** — Best niches across all runs
- **Sortable data table** with search, filters, pagination
- Custom Canvas charts (no external CDN — CSP compliant)

### 📝 SEO Auditor
- Title optimization analysis (length, keyword density)
- Tag usage audit (13-tag slot utilization)
- Description analysis
- AI-powered suggestions with optimized title/tags

### 📦 Export
- CSV export with full listing data
- JSON export for history/analytics
- One-click dashboard export

---

## 🚀 Installation

1. **Download** this repository (or clone it)
2. Open Chrome → Navigate to `chrome://extensions`
3. Enable **Developer Mode** (toggle in top right)
4. Click **Load unpacked** → Select the `etsy-research-pro` folder
5. Done! Click the extension icon in your toolbar

---

## ⚙️ API Key Setup (Optional)

> **The extension works without any API keys** using math-based analysis. API keys unlock AI-powered niche clustering and SEO suggestions.

### Gemini (Recommended — Free)
1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click **Create API Key**
3. Paste into Extension → Settings → Gemini API Key

### Groq (Alternative — Free)
1. Go to [Groq Console](https://console.groq.com/keys)
2. Create a new API key
3. Paste into Extension → Settings → Groq API Key

> ⚠️ **API keys never leave your browser.** They're stored in `chrome.storage.local` and sent directly to provider APIs.

---

## 📖 How to Use

### Basic Research Flow
1. **Select an interest category** (Home Decor, Jewelry, Digital Planners, etc.)
2. **Click a seed keyword** chip or type your own
3. **Click "Start Research"** — the extension will:
   - Open Etsy search in a new tab
   - Extract all listing data
   - Score each listing
   - Cluster into micro-niches
   - Generate Win Scores
4. **Review results** in the Results tab
5. **Check the Dashboard** for historical trends

### SEO Audit
1. Go to any **Etsy listing page**
2. Click the extension → **Audit tab**
3. Click **"Audit This Listing"**
4. Get instant title, tag, and description analysis

### Dashboard
- Click **"📊 Dashboard"** in the popup footer
- View 90-day trends, top niches, and score distributions
- Filter by date, product type, or minimum score
- Export all data as JSON

---

## 🏗 Architecture

```
etsy-research-pro/
├── manifest.json              # MV3 manifest
├── icons/                     # Extension icons
├── src/
│   ├── background/
│   │   └── service-worker.js  # Main orchestrator (ES modules)
│   ├── content-scripts/
│   │   ├── etsy-search-extractor.js  # Etsy listing scraper
│   │   └── erank-extractor.js        # Optional eRank data
│   ├── popup/
│   │   ├── popup.html         # 4-tab popup UI
│   │   ├── popup.js           # Popup controller
│   │   └── popup.css          # Dark premium theme
│   ├── dashboard/
│   │   ├── dashboard.html     # Full-tab analytics dashboard
│   │   ├── dashboard.js       # Custom Canvas charts + table
│   │   └── dashboard.css      # Glassmorphism theme
│   ├── modules/
│   │   ├── ai-analyzer.js     # Gemini + Groq + Math analysis
│   │   ├── seo-auditor.js     # Listing SEO audit engine
│   │   ├── history-manager.js # 90-day storage manager
│   │   └── exporter.js        # CSV + JSON export
│   └── utils/
│       ├── config.js          # Settings, categories, storage
│       └── rate-limiter.js    # API rate limiting
└── cloudflare-worker/
    ├── worker.js              # Optional community backend
    └── schema.sql             # D1 database schema
```

### Key Design Decisions
- **Manifest V3** — Modern Chrome extension standard
- **ES Modules** — Service worker uses `"type": "module"` for clean imports
- **CSP Compliant** — `script-src 'self'` — no CDN dependencies, all charts drawn with native Canvas
- **No Frameworks** — Pure vanilla JS for maximum performance
- **State Queue** — Serialized state updates prevent storage race conditions
- **Keepalive** — Chrome alarms API keeps the service worker alive during research

---

## 🎨 Design

- **Dark premium theme** with Etsy orange (#F1641E) accent
- **Glassmorphism** — Frosted glass cards with `backdrop-filter: blur()`
- **Animated gradients** — Subtle glowing orbs and gradient bars
- **Micro-animations** — Score pop-in, staggered card entries, smooth transitions
- **Responsive** — Dashboard works on all screen sizes

---

## 🤝 Contributing

Contributions welcome! This is an open-source project.

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

---

## 📄 License

This project is licensed under the **MIT License** — free for personal and commercial use.

---

## 👤 Author

**Muhammad Ali** — Hyderabad, Pakistan  
Built as a free alternative to paid Etsy research tools.

---

*Made with ❤️ for the Etsy seller community*
