// Config — Settings, defaults, and storage helpers
// API keys stored in chrome.storage.local ONLY — never sent to any server

const DEFAULT_CONFIG = {
  // AI provider settings
  ai_provider: 'none', // 'gemini', 'groq', or 'none'
  gemini_api_key: '',
  groq_api_key: '',

  // Scraping settings
  max_listings_per_scan: 50,
  scrape_delay_min: 800,
  scrape_delay_max: 2000,

  // Win Score thresholds
  max_shop_reviews_beatable: 300,
  top_n_listings: 12,
  min_beatable_slots: 3,

  // Product type preference
  product_type_filter: 'any', // 'digital', 'physical', 'pod', 'any'

  // eRank settings (optional)
  erank_enabled: false,
  min_monthly_searches: 500,
  max_competition: 25000,
  delay_between_pages: 3,
  min_qualified_keywords: 5,

  // History
  max_history_runs: 500,
  history_retention_days: 90,

  // Cloudflare Worker - Updated to your live URL
  worker_url: 'https://etsy-research-pro.sonofmarif.workers.dev', 
  community_sharing: false,
  webhook_url: ''
};

// ─── Interest categories with built-in seed keywords ──────────────────────
const INTEREST_CATEGORIES = {
  'Islamic/Spiritual': [
    'crystal prayer beads 99',
    'islamic wall art printable',
    'quran verse print digital',
    'ramadan planner pdf',
    'dua cards printable',
    '99 names of allah print',
    'muslim gift ideas',
    'arabic calligraphy wall art',
    'bismillah print digital',
    'islamic home decor printable',
    'eid mubarak banner printable',
    'tasbih beads crystal',
    'islamic journal planner',
    'quran bookmark digital',
    'hajj gift personalized'
  ],
  'Home Decor': [
    'minimalist wall art set',
    'boho macrame wall hanging',
    'custom family name sign',
    'botanical print set digital',
    'floating shelf bracket',
    'vintage poster printable',
    'abstract line art print',
    'kitchen herb label printable',
    'farmhouse wood sign',
    'modern gallery wall set',
    'geometric wall art digital',
    'personalized coordinates print',
    'watercolor landscape digital',
    'nursery animal prints',
    'retro sunset poster'
  ],
  'Pet Products': [
    'custom pet portrait digital',
    'dog bandana personalized',
    'cat collar charm',
    'pet memorial gift print',
    'dog name tag custom',
    'funny cat svg bundle',
    'pet paw print ornament',
    'dog treat jar personalized',
    'cat window perch shelf',
    'pet birthday party printable',
    'dog svg bundle cricut',
    'cat toy handmade felt',
    'pet loss sympathy gift',
    'dog leash holder wall',
    'cat planner stickers digital'
  ],
  'Baby/Kids': [
    'baby milestone cards printable',
    'nursery wall art digital',
    'kids growth chart printable',
    'baby shower invitation template',
    'toddler busy book printable',
    'children alphabet poster',
    'baby name sign personalized',
    'kids birthday invitation digital',
    'newborn announcement template',
    'montessori flashcards printable',
    'baby footprint art kit',
    'kids reward chart printable',
    'nursery mobile handmade',
    'baby memory book digital',
    'children bedtime story print'
  ],
  'Wedding': [
    'wedding invitation template',
    'bridesmaid proposal card',
    'wedding timeline printable',
    'custom wedding sign svg',
    'bridal shower game printable',
    'wedding seating chart template',
    'save the date digital',
    'wedding vow book personalized',
    'bachelorette party favors',
    'wedding table numbers printable',
    'engagement party invitation',
    'wedding program template',
    'bridal emergency kit list',
    'wedding hashtag sign digital',
    'reception welcome sign template'
  ],
  'Print-on-Demand': [
    'funny t-shirt design svg',
    'motivational mug design png',
    'tote bag design digital',
    'retro vintage t-shirt design',
    'mom life svg bundle',
    'dad joke shirt design',
    'teacher appreciation mug',
    'nurse life t-shirt svg',
    'sarcastic quote design png',
    'dog mom shirt design',
    'coffee lover mug design',
    'gym motivation shirt svg',
    'bookworm tote bag design',
    'cat dad t-shirt design',
    'birthday queen shirt svg'
  ],
  'Digital Planners': [
    'notion template aesthetic',
    'digital planner goodnotes',
    'budget tracker spreadsheet',
    'meal planner printable',
    'habit tracker template',
    'student planner digital',
    'wedding planner printable pdf',
    'social media content calendar',
    'fitness planner template',
    'gratitude journal printable',
    'adhd planner digital',
    'business planner template',
    'cleaning schedule printable',
    'travel planner template',
    'self care journal digital'
  ],
  'Jewelry': [
    'birthstone necklace personalized',
    'dainty gold ring minimalist',
    'friendship bracelet beaded',
    'custom name necklace',
    'ear cuff no piercing',
    'anxiety ring spinner',
    'crystal healing bracelet',
    'zodiac sign pendant',
    'pearl earrings vintage',
    'stackable rings set gold',
    'initial bracelet custom',
    'gemstone ring statement',
    'charm necklace layered',
    'men bracelet leather',
    'anklet chain dainty'
  ],
  'Wall Art Printables': [
    'abstract art print set',
    'vintage botanical poster',
    'motivational quote printable',
    'watercolor art digital',
    'photography print landscape',
    'modern typography poster',
    'gallery wall art set',
    'kids room art printable',
    'mid century modern print',
    'line art drawing digital',
    'sunset photography print',
    'trendy aesthetic poster',
    'bedroom wall art set',
    'affirmation cards printable',
    'office decor print digital'
  ],
  'Seasonal': [
    'christmas ornament svg',
    'halloween decoration printable',
    'thanksgiving table setting',
    'ramadan decoration set',
    'easter egg hunt printable',
    'valentines day card template',
    'mothers day gift printable',
    'fathers day personalized',
    'new year planner template',
    'eid decoration printable',
    'fall wreath decoration',
    'summer bucket list printable',
    'fourth of july svg',
    'back to school printable',
    'diwali decoration digital'
  ]
};

// ─── Seasonal keywords for trend scoring ──────────────────────────────────
const SEASONAL_KEYWORDS = [
  'christmas', 'xmas', 'holiday season', 'santa',
  'halloween', 'spooky', 'trick or treat',
  'thanksgiving', 'fall', 'autumn',
  'ramadan', 'eid', 'islamic holiday',
  'easter', 'spring', 'bunny',
  'valentine', 'love', 'heart',
  'mother day', 'mom', 'mama',
  'father day', 'dad', 'papa',
  'new year', 'nye',
  'diwali', 'hanukkah',
  'back to school', 'graduation',
  'summer', 'beach',
  'winter', 'snow'
];

// ─── Config storage helpers ───────────────────────────────────────────────
export async function loadConfig() {
  const result = await chrome.storage.local.get('config');
  return { ...DEFAULT_CONFIG, ...(result.config || {}) };
}

export async function saveConfig(config) {
  await chrome.storage.local.set({ config });
}

export async function loadApiKeys() {
  const config = await loadConfig();
  return {
    gemini: config.gemini_api_key || '',
    groq: config.groq_api_key || '',
    provider: config.ai_provider || 'none'
  };
}

export async function saveApiKey(provider, key) {
  const config = await loadConfig();
  if (provider === 'gemini') config.gemini_api_key = key;
  if (provider === 'groq') config.groq_api_key = key;
  if (key) config.ai_provider = provider;
  await saveConfig(config);
}

// ─── Run state ────────────────────────────────────────────────────────────
export async function loadRunState() {
  const result = await chrome.storage.local.get('runState');
  return result.runState || {
    running: false,
    currentStep: null,
    progress: '',
    logs: [],
    lastStatus: null
  };
}

export async function saveRunState(state) {
  await chrome.storage.local.set({ runState: state });
}

// ─── First-run detection ──────────────────────────────────────────────────
export async function isFirstRun() {
  const result = await chrome.storage.local.get('hasRunBefore');
  return !result.hasRunBefore;
}

export async function markFirstRunComplete() {
  await chrome.storage.local.set({ hasRunBefore: true });
}

export { DEFAULT_CONFIG, INTEREST_CATEGORIES, SEASONAL_KEYWORDS };