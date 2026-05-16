// ============================================================
// CONFIG
// ============================================================
const API = 'http://localhost:5000';

// ============================================================
// STATE
// ============================================================
const state = {
  page: 'dashboard',
  portfolio: [
    { ticker: 'CBA',   shares: 50,  avgPrice: 118.20, currentPrice: 124.50, sector: 'Banking' },
    { ticker: 'BHP',   shares: 80,  avgPrice: 43.10,  currentPrice: 45.80,  sector: 'Mining' },
    { ticker: 'TLS',   shares: 200, avgPrice: 3.92,   currentPrice: 4.18,   sector: 'Telecoms' },
    { ticker: 'GMG',   shares: 30,  avgPrice: 33.50,  currentPrice: 36.20,  sector: 'REITs' },
    { ticker: 'HUB24', shares: 25,  avgPrice: 58.00,  currentPrice: 63.40,  sector: 'Fintech' },
    { ticker: 'JBH',   shares: 15,  avgPrice: 67.30,  currentPrice: 71.90,  sector: 'Retail' },
    { ticker: 'SCG',   shares: 180, avgPrice: 3.42,   currentPrice: 3.58,   sector: 'REITs' },
  ],
  cash: 15000,
  recommendations: [],
  tradeJournal: [],
  recHistory: [],
  portfolioHistory: [],
  cgtParcels: [],
  cgtMethod: 'fifo',
  cgtDisposals: [],
  apiUsageCost: null,
  apiCostFetchedAt: null,
  apiCostFetchError: null,
  macroData: null,       // persisted — cleared/replaced only by a new run
  macroDate: null,       // DD-MM-YYYY of last macro run — prevents duplicate daily runs
  liveSignals: {},      // ticker -> full analysis from backend
  criticalAlerts: {},   // ticker -> {type, pct, days, triggeredAt} — price-decline critical alerts
  dismissedAlerts: {},  // ticker -> timestamp — user-dismissed alerts
  lastSignalFetch: {},  // ticker -> timestamp
  lastPriceRefresh: 0,  // epoch ms of last successful refreshPrices()
  chatHistory: [],
  settings: {
    brokerage: 10,
    minTradeSize: 500,
    maxTradesPerDay: 5,
    maxPositionPct: 15,
    capitalMode: 'partial',
    riskCapitalPct: 30,
    apiCostPerRun: 0.08,
    apiKey: '',
    serverUrl: 'http://localhost:5000',
    scheduleEnabled: false,
    scheduleWindowStart: '10:00',
    scheduleWindowEnd: '15:45',
    scheduleIntervalMins: 60,
    scheduleWeekdaysOnly: true,
    scheduleRunOnOpen: true,
  },
  analysisRunning: false,
  analysisLastSummary: null,   // {text, date, recCount} – AI's reasoning when recs=0 or overall summary
  serverOk: false,
  rbaRate: 4.35,               // auto-fetched from /api/rba-rate on init
  rbaRateSource: 'fallback',   // 'live-rba' | 'cached' | 'fallback'
  rbaRateDate: null,
  dividendData: {},             // ticker -> {dividendYield, annualDivPerShare, exDividendDate, frequencyLabel, nextEstAmount, history[]}
  earningsCalendar: {},         // ticker -> {nextEarningsDate, forwardEps, epsGrowth, revenueGrowth, analystRec, analystTarget}
  journalFilter: {ticker:'',action:'all',status:'all',pnl:'all',dateFrom:'',dateTo:'',sortBy:'date_desc'},
  priceAlerts: [],          // [{id, ticker, type:'above'|'below'|'pct_drop', value, referencePrice, active, createdAt, triggeredAt, lastPrice}]
  analysisConfig: {
    extraTickers: [],
    marketView: '',
    savedViews: [],
  },
  news: {
    items: [],
    status: null,
    lastFetch: 0,
    models: [],
    ollamaAvailable: null,
    filter: { category: 'all', ticker: 'all', sentiment: 'all', search: '', sortBy: 'relevance' },
    settings: {
      llm_model: 'gemma3:4b',
      ollama_url: 'http://localhost:11434',
      scan_interval_hours: 6,
      enabled: true,
      max_age_days: 7,
    },
  },
  announcements: {
    items: [],
    status: null,
    lastSync: null,
    settingsOpen: false,
    filter: { ticker: 'all', type: 'all', sentiment: 'all', search: '' },
    settings: {
      ann_llm_provider: 'ollama',
      ann_llm_model: 'qwen2.5:1.5b',
      ollama_url: 'http://localhost:11434',
      groq_api_key: '',
      gemini_api_key: '',
    },
  },
};
