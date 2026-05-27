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
  polymarketData: null,  // {markets:[...], fetched_at:'...'} — Polymarket prediction markets
  includePolymarket: false, // when true, Polymarket probs are appended to the AI Macro Brief prompt
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
    sbcMode: false,
  },
  analysisRunning: false,
  analysisLastSummary: null,   // {text, date, recCount} – AI's reasoning when recs=0 or overall summary
  currentRegime: null,         // { regime, confidence, signals[], fetchedAt } — set by regime-engine.js
  serverOk: false,
  rbaRate: 4.35,               // auto-fetched from /api/rba-rate on init
  rbaRateSource: 'fallback',   // 'live-rba' | 'cached' | 'fallback'
  rbaRateDate: null,
  dividendData: {},             // ticker -> {dividendYield, annualDivPerShare, exDividendDate, frequencyLabel, nextEstAmount, history[]}
  earningsCalendar: {},         // ticker -> {nextEarningsDate, forwardEps, epsGrowth, revenueGrowth, analystRec, analystTarget}
  journalFilter: {ticker:'',action:'all',status:'all',pnl:'all',dateFrom:'',dateTo:'',sortBy:'date_desc'},
  priceAlerts: [],          // [{id, ticker, type:'above'|'below'|'pct_drop'|'rsi_below'|'rsi_above'|'bb_breakout'|'bb_breakdown'|'volume_spike', value, referencePrice, active, createdAt, triggeredAt, lastPrice}]
  watchlist: [],            // [{ticker, addedAt, notes}] — tickers monitored but not held
  savedScreeners: [],       // [{name, savedAt, config:{universe, min_adv_aud, excludeHoldings}}]
  targetAllocations: {},    // ticker → target weight % (e.g. {CBA:15,BHP:10}) — persisted in blob_store
  analysisConfig: {
    extraTickers: [],
    marketView: '',
    savedViews: [],
    rules: {
      // Confidence & conviction
      minConfidence:          0.62,
      minIndepFactors:        3,
      bearCaseThreshold:      0.70,
      highRiskMinConf:        0.75,
      veryHighRiskMinConf:    0.80,
      // Risk / reward
      minRrRatio:             2.0,
      stopAtrMultiple:        1.5,
      // Position sizing
      maxPositionPct:         15,
      maxSectorPct:           30,
      // Anti-churn
      sameTickerWindowDays:   7,
      minHoldingDays:         1,
      minChurnProfitAud:      100,
      minChurnProfitPct:      2,
      // Dividend / income
      dividendYieldPremium:   1.5,
      highConvYieldPremium:   2.5,
      // Portfolio risk thresholds
      highVarThreshold1:      -3.5,
      highVarThreshold2:      -5.0,
      highDdThreshold:        25,
      compositeRiskHighScore: 67,
      compositeRiskVeryHighScore: 80,
      // Ex-dividend
      exDivProtectDays:       5,
      exDivFlagDays:          10,
      // CGT
      cgtHoldMonthsMin:       11,
      cgtHoldMonthsMax:       12,
      // Free-text custom rules (appended to every analysis run)
      customRules:            '',
    },
  },
  news: {
    items: [],
    status: null,
    lastFetch: 0,
    models: [],
    ollamaAvailable: null,
    gpuInfo: null,
    filter: { category: 'all', ticker: 'all', sentiment: 'all', search: '', sortBy: 'relevance' },
    settings: {
      llm_provider: 'ollama',
      llm_model: '',
      ollama_url: 'http://localhost:11434',
      groq_api_key: '',
      groq_model: 'llama-3.1-8b-instant',
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
      ann_groq_model: 'llama-3.1-8b-instant',
      gemini_api_key: '',
      gemini_model: 'gemini-3.5-flash',
    },
  },
  debate: {
    aggression: 'light',   // 'none' | 'light' | 'full'
    model: '',             // '' = auto (preferred by pulled model priority); set by user
  },
  dayTrading: {
    recommendations: [],   // active day-trade setups from AI
    analysisRunning: false,
    lastSummary: null,     // {text, date, recCount}
    allocatedCash: null,   // null = auto (20% of state.cash); user can override
    riskPct: 1.5,          // max risk per trade as % of allocatedCash
    extraTickers: [],      // watchlist tickers for day-trade scans only
    universeKey: 'asx200', // selected universe for universe scan
    scanProgress: null,    // {phase:'fetching'|'analysing', current, total, candidates} | null
    activeTab: 'setups',   // 'setups' | 'rules'
    filterParams: {        // pre-filter thresholds (applied client-side)
      maxBbPctB:   0.20,
      minAdvAud:   1500000,
      sma200Floor: 0.985,
      maxAdx:      35,
    },
    aiParams: {            // signal thresholds (injected into AI prompt)
      stopAtrMultiple: 2.5,
      minRrRatio:      2.0,
      minConfidence:   0.50,
      maxPositionPct:  20,
      rsiThreshold:    35,
      volZScore:       1.5,
      fibReturnMin:    -20,
      fibReturnMax:    -5,
    },
  },
};
