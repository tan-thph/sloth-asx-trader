// ============================================================
// CONFIG
// ============================================================
const API = (location.protocol === 'file:') ? 'http://localhost:5000' : location.origin;

// ── Portfolio-analysis token budget tiers ────────────────────────────────────
// The Claude API cannot pre-estimate its own response length (max_tokens is a
// hard truncation ceiling, not a target), so we ration DETERMINISTICALLY here:
// portfolio-analysis output is structured tool JSON and its size is ~linear in
// the number of recs. `perTicker` is a conservative per-rec output-token cost;
// `reserve` covers the summary/dataGaps/book-snapshot overhead. analysis.js keeps
// ALL holdings, then fills watchlist tickers only up to what the budget allows —
// dropping whole watchlist tickers (never truncating a holding). `maxTokens`
// becomes the callClaude('portfolio') ceiling. See settings.analysisTokenBudget.
const ANALYSIS_BUDGET_TIERS = {
  lean:     { label: 'Lean',     maxTokens: 8000,  perTicker: 550, reserve: 1500, dropWatchlist: true  },
  standard: { label: 'Standard', maxTokens: 12000, perTicker: 550, reserve: 1800, dropWatchlist: false },
  deep:     { label: 'Deep',     maxTokens: 20000, perTicker: 550, reserve: 2500, dropWatchlist: false },
};
// 'custom' isn't a static tier (its maxTokens is user-set via settings.customTokenBudget)
// — analysis.js builds it at run time from the 'standard' tier's perTicker/reserve/
// dropWatchlist plus this maxTokens. No upper bound — the user's own call on what
// they're willing to spend; only a floor of 1 so a zero/negative/garbage value can't
// break the API request.
const CUSTOM_TOKEN_BUDGET_MIN = 1;

// ============================================================
// STATE
// ============================================================
const state = {
  page: 'dashboard',
  portfolio: [],
  cash: 0,
  // Paper-trading firewall (see gotcha "paper/real mode"): a trade is REAL only
  // when its `mode === 'real'`. Anything else — 'paper' or missing — is paper and
  // is excluded from ALL tax (CGT/EOFY), real-performance, and real-cash math via
  // isRealTrade() in utils.js. Paper trades draw from this separate simulated
  // cash pool so the real `cash` figure above stays accurate.
  paperCash: 0,
  _paperBackfillDone: false,  // one-time: existing pre-feature records → mode:'paper'
  _paperCashSeeded: false,    // one-time: seed paperCash from settings.paperStartCash on first paper use
  portfolioViewMode: 'all',   // 'all' | 'real' | 'paper' — display filter (gotcha #88 Phase D); tax/NAV stay real-only
  activeAccount: 'all',   // 'all' | 'personal' | 'super' | 'trading'
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
  criticalAlerts: {},   // ticker -> {type, pct, days, triggeredAt, dismissed} — price-decline critical alerts
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
    serverUrl: (location.protocol === 'file:') ? 'http://localhost:5000' : location.origin,
    scheduleEnabled: false,
    scheduleWindowStart: '10:00',
    scheduleWindowEnd: '15:45',
    scheduleIntervalMins: 60,
    scheduleWeekdaysOnly: true,
    scheduleRunOnOpen: true,
    sbcMode: false,
    stopProximityPct: 3,
    compactMode: false,
    theme: 'terminal',      // 'auto' | 'light' | 'dark' | 'terminal'
    useLocalLLM: false,
    useBackendProxy: false, // route AI calls through /api/claude/proxy (server-side claude-api.txt) instead of this browser's localStorage key — lets every device on a tailnet share one key
    maxRiskBudgetPct: 5,
    autoMacroBrief: true, // auto-run the AI morning macro once per trading day (scheduler.js); when off, it still runs on the first manual Run Analysis
    autoMacroBriefTime: '', // 'HH:MM' AEST — don't auto-run before this time; empty = no restriction (fire ASAP, current behaviour)
    paperStartCash: 100000, // seed for state.paperCash the first time paper mode is used (separate from real cash)
    analysisTokenBudget: 'standard', // 'lean' | 'standard' | 'deep' | 'custom' — see ANALYSIS_BUDGET_TIERS. Caps callClaude('portfolio') max_tokens and deterministically rations watchlist tickers so holdings are always fully analysed first.
    customTokenBudget: 12000, // maxTokens used when analysisTokenBudget === 'custom' — no upper cap, only floored at CUSTOM_TOKEN_BUDGET_MIN; perTicker/reserve/dropWatchlist reuse the 'standard' tier's rationing behaviour.
  },
  deferredWatchlist: [],       // watchlist tickers the token budget skipped on the last run (drives the "Analyse deferred watchlist" button). Session artifact — reset on each analysis run.
  analysisRunning: false,
  analysisLastSummary: null,   // {text, date, recCount} – AI's reasoning when recs=0 or overall summary
  currentRegime: null,         // { regime, confidence, signals[], fetchedAt } — set by regime-engine.js
  lastKnownRegime:   null,     // previous regime string before the most recent transition
  regimeChangedAt:   null,     // Date.now() ms when the last regime transition was detected
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
  digestHistory: [],        // [{date, text}] — saved AI postmortem digests, newest first
  termDeposits: [],         // [{id, label, amount, rate, maturityDate, notes}] — idle cash + TDs
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
      google_api_key: '',
      google_model: 'gemini-2.0-flash',
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
    universeKey: 'portfolio_watchlist', // 'portfolio_watchlist' (default) | 'asx20'|'asx50'|'asx100'|'asx200' — what "Run Day Trade Scan" scans
    scanProgress: null,    // {phase:'fetching'|'analysing', current, total, candidates} | null
    activeTab: 'setups',   // 'setups' | 'intraday' | 'rules'
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
  intraday: {
    recommendations: [],    // [{id, ticker, priceRange, target, stopLoss, qty, score, signals, ...}]
    openPositions:   [],    // [{id, ticker, qty, entryPrice, target, stop, enteredAt}]
    todayPnl:        0,     // realized P&L for the session (AUD)
    lastScan:        null,  // {date, time, total, passed, count}
    scanRunning:     false,
    autoRefresh:     false, // 2-min poller toggle
    allocatedCash:   null,  // null = auto (allocPct% of state.cash)
    params: {
      targetPct:    3.5,      // exit target %
      stopPct:      1.5,      // stop loss %
      maxPositions: 2,        // max concurrent intraday trades
      minScore:     40,       // minimum setup score (0–100)
      allocPct:     20,       // % of state.cash allocated to intraday
      universeKey:  'asx100', // which index universe to scan
    },
  },
};
