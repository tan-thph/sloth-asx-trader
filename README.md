# ASX Trading Assistant

A local decision-support tool for Australian equity trading. Runs entirely on your machine — no cloud subscriptions, no SaaS fees. A Flask backend fetches market data via yfinance; a vanilla-JS frontend provides the UI and calls the Anthropic API directly from the browser.

---

## Quick Start

```bash
pip install -r requirements.txt
python asx_server.py
# Then open asx_trading.html in your browser
```

The server starts at `http://localhost:5000`. Open `asx_trading.html` directly from the filesystem — no web server needed.

---

## Project Structure

```
sloth-asx-trader/
│
├── asx_trading.html        # Single-page app entry point
├── asx_trading.css         # All styles
│
├── asx_server.py           # Flask bootstrap — blueprint registration, middleware. No routes itself
├── core.py                 # Shared infra: ttl_cache, fetch_with_retry, HTTP session, constants
├── db.py                   # SQLite schema, get_db(), init_db(), migrations, backup
├── indicators.py           # All technical indicators + analyse_ticker() + _score_ticker()
├── announcement_engine.py  # ASX announcement fetching, PDF parsing, Gemini scoring
├── announcement_routes.py  # Blueprint: /api/announcements/*
├── news_engine.py          # News RSS fetching, dedup, LLM classification
│
├── routes/
│   ├── portfolio.py        # /api/cash, /api/db/*, /api/tax/eofy-pack, splits-check
│   ├── market.py           # /api/analyse, /api/quote, /api/macro, /api/risk, /api/earnings-calendar
│   ├── learning.py         # /api/learning/* — calibration, stats, outcomes
│   ├── debate.py           # /api/debate/* — Ollama bull/bear, postmortem, skill, calib-quality
│   ├── backtest.py         # /api/backtest, /api/backtest/walk-forward, /api/backtest/ai-replay
│   ├── scanner.py          # /api/market/scan*, /api/scanner/factor-stability
│   ├── intraday.py         # /api/intraday/* — 5m intraday day-trade strategy
│   ├── dividends.py        # /api/dividends/*
│   ├── news.py             # /api/news/*, /api/groq/models, /api/google/models
│   ├── alerts.py           # /api/alerts/telegram — Telegram bot integration
│   ├── claude.py           # /api/claude/* — Anthropic proxy (opt-in)
│   └── import_csv.py       # /api/import/csv — CommSec/SelfWealth CSV parser
│
├── requirements.txt
│
└── js/
    ├── config.js               # Global state, API base URL, all defaults
    ├── utils.js                # Shared helpers (fmt, todayStr, toast, parseClaudeJSON)
    ├── api.js                  # Fetch wrappers for every backend endpoint
    ├── portfolio-helpers.js    # mergedPortfolio(), portfolioValue(), position sizer
    ├── scheduler.js            # Auto-refresh timer, SBC mode (20-min interval)
    ├── reconcile.js            # Portfolio reconciliation vs journal
    ├── prices.js               # Live price refresh + price cache
    ├── charts.js               # Canvas chart renderers (candlestick, sparkline, etc.)
    │
    ├── ── AI Infrastructure ──
    ├── claude-client.js        # Centralised callClaude() — retries, caching, agent routing
    ├── quant-engine.js         # Deterministic sizing: Kelly, vol scalar, EV, multi-constraint
    ├── regime-engine.js        # Market regime classifier + strategy gates + size modifiers
    ├── learning-loop.js        # Calibration stats, regime performance, decay detection
    ├── prompt-modules.js       # Optional rule modules + dynamic system prompt assembly
    ├── response-validator.js   # Schema + business rule validation, auto-repair loop
    │
    ├── ── Core Engines ──
    ├── prompts.js              # All AI system prompts (ANALYSIS, MACRO, ANALYST, PM, DT)
    ├── analysis.js             # Portfolio analysis: regime gate → Claude → quant → validate
    ├── strategy.js             # DT pre-filter thresholds (DT_FILTER) + AI params (DT_AI_PARAMS)
    ├── day-trading-analysis.js # Day trade + universe scan orchestration
    ├── asx-universe.js         # ASX 20/50/100/200 ticker lists
    ├── navigation.js           # showPage(), sidebar active state
    ├── init.js                 # App bootstrap, state init, server health check
    │
    └── pages/
        ├── dashboard.js        # Portfolio summary, holdings table, charts
        ├── portfolio.js        # Holdings editor, add/remove positions
        ├── macro.js            # Morning macro brief (ASX200, AUD/USD, commodities)
        ├── signals.js          # Live technical signals table
        ├── recommendations.js  # AI recs (4 tabs: Setups / History / Analysis / Rules)
        ├── day-trading.js      # Day trading UI (2 tabs: Setups / Rules)
        ├── journal.js          # Trade journal — open/close trades, P&L
        ├── cgt.js              # CGT parcels, FIFO/LIFO/Max-gain, 12-month discount
        ├── performance.js      # P&L charts, hit rate, sector attribution
        ├── backtest.js         # Historical strategy backtesting + AI replay
        ├── risk.js             # Beta, Sharpe, VaR/CVaR, correlation heatmap
        ├── assistant.js        # Free-form AI chat with portfolio context
        ├── news.js             # News scanner — RSS + LLM sentiment tagging
        ├── announcements.js    # ASX announcements — price-sensitive filter + Gemini scoring
        ├── scanner.js          # Market scanner — ASX universe scoring, ranked candidates
        └── settings.js         # API keys, brokerage, LLM provider, Gemini model picker
```

---

## Architecture — AI Pipeline

Analysis runs through four deterministic layers:

```
Signals → Regime Engine → Claude (Analyst/Portfolio) → Quant Engine → Validator → UI
           (code)          (LLM)                        (code)         (code)
```

| Layer | Responsibility |
|---|---|
| **Regime Engine** | Classifies market (riskOn / riskOff / panic / highVol / trend / sideways) from live macro data. Gates which strategies are allowed. |
| **Claude** | Qualitative conviction — what to buy/sell and why. Never does arithmetic. |
| **Quant Engine** | Deterministic sizing — stop, target, qty (Kelly + vol scalar + multi-constraint), EV. Same input always produces same output. |
| **Validator** | Schema + business rule checks. Auto-repair loop (max 2 attempts) before surfacing to UI. |

### `callClaude(agentType, userMessage, options)`

Central API wrapper in `js/claude-client.js`. All Claude calls go through here.

```js
// All agent types
'portfolio'  // Main portfolio analysis (ANALYSIS_SYSTEM_PROMPT)
'analyst'    // Per-ticker conviction only (ANALYST_SYSTEM_PROMPT)
'pm'         // Portfolio-level approve/reject (PM_SYSTEM_PROMPT)
'macro'      // Morning macro brief
'dayTrade'   // Day trade portfolio scan
'universe'   // Universe scanner
'assistant'  // Free-form chat
```

Features: exponential backoff retry (1s / 2s / 4s on HTTP 429/529), prompt caching, dynamic system prompt assembly.

---

## Key Files to Edit

| What you want to change | File |
|---|---|
| Day trading pre-filter thresholds (BB %B, ADV, SMA200, ADX) | `js/strategy.js` → `DT_FILTER` |
| Day trading AI signal parameters (stop ATR, R:R, confidence) | `js/strategy.js` → `DT_AI_PARAMS` |
| AI system prompts (portfolio, macro, day trading) | `js/prompts.js` |
| Optional prompt modules (harvest window, high-vol rules, etc.) | `js/prompt-modules.js` → `RULE_MODULES` |
| Regime classification thresholds | `js/regime-engine.js` → `REGIME_THRESHOLDS` |
| Quant engine sizing parameters | `js/quant-engine.js` → `QUANT_CONFIG` |
| Indicator formulas (RSI period, BB std dev, ATR period, etc.) | `indicators.py` |
| Market scanner scoring weights | `indicators.py` → `_score_ticker()` |
| Announcement engine scheduling | `announcement_engine.py` |
| News RSS sources and LLM model | `news_engine.py` + Settings page |

All numeric thresholds for analysis rules are also editable at runtime via the **Rules** sub-tab in both the Recommendations and Day Trading pages — no code editing required for day-to-day tuning.

---

## Backend — `asx_server.py`

Flask app (`localhost:5000`). All heavy computation is in `indicators.py`; the server handles routing, database I/O, and orchestration.

### Key API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/analyse/<ticker>` | Full indicator set for one ticker |
| `POST /api/analyse/batch` | Batch indicator fetch (used by day trading scanner) |
| `GET /api/macro` | ASX200, AUD/USD, gold, iron ore + regime detection fields |
| `GET /api/rba-rate` | RBA cash rate (live scrape → DB cache → fallback) |
| `GET /api/quote/<ticker>` | Fast price + sector (no indicators) |
| `GET /api/risk?tickers=A,B,C` | Beta, Sharpe, VaR, CVaR, correlation matrix |
| `POST /api/db/save` | Persist all app state to SQLite |
| `GET /api/db/load` | Load all app state |
| `POST /api/backtest` | Run strategy backtest |
| `POST /api/log/ai_response` | Log raw AI response to `ai_responses/` |

### Extended `/api/macro` — Regime Detection Fields

The macro endpoint returns additional fields used by `regime-engine.js` to classify the current market regime:

| Field | Description |
|---|---|
| `asx200_5d_return` | ASX200 5-day percentage return |
| `asx200_20d_return` | ASX200 20-day percentage return |
| `asx200_atr_pct` | ASX200 14-day ATR as % of price (intraday vol proxy) |
| `asx200_adx` | ASX200 simplified ADX (trend strength) |
| `advance_decline_ratio` | Breadth proxy (^XJOA / ^AXJO ratio) |
| `aud_usd_change_5d` | AUD/USD 5-day change % |
| `iron_ore_change_5d` | Iron ore futures 5-day change % |

---

## `js/prompts.js`

All Claude AI system prompts. Edit here — never need to touch engine files for prompt changes.

| Export | Used by | Cached |
|---|---|---|
| `MACRO_SYSTEM_PROMPT` | Morning macro brief | No |
| `ANALYSIS_SYSTEM_PROMPT` | Portfolio recommendations (PM phase) | Yes — ephemeral |
| `ANALYST_SYSTEM_PROMPT` | Analyst phase (conviction only, no math) | Yes — ephemeral |
| `PM_SYSTEM_PROMPT` | PM phase (approve/reject/rank pre-sized trades) | Yes — ephemeral |
| `getDayTradeSystemPrompt()` | Day trade portfolio scan | Yes — ephemeral |
| `getDayTradeUniverseScanPrompt()` | ASX universe scanner | Yes — ephemeral |

Static prompts use `cache_control: ephemeral` for intraday cache hits. Optional rule modules (tax-loss harvest, reporting season, high-vol regime, etc.) are appended as a second uncached system block so the core cache is preserved.

---

## `js/strategy.js`

Client-side day trading strategy configuration. Split into two objects:

```js
// Pre-filter — applied client-side before any AI call
const DT_FILTER = {
  maxBbPctB:   0.20,     // BB %B ≤ this (price near lower band)
  minAdvAud:   1_500_000, // minimum 20-day average daily value (AUD)
  sma200Floor: 0.985,    // price must be ≥ SMA200 × this
  maxAdx:      35,       // skip stocks already in a strong uptrend
};

// AI-phase parameters — injected into prompt, used by quant engine
const DT_AI_PARAMS = {
  stopAtrMultiple: 2.5,  // stop = entry − stopAtrMultiple × ATR14
  minRrRatio:      2.0,  // minimum reward:risk to output a rec
  minConfidence:   0.50, // minimum AI confidence to accept a rec
  maxPositionPct:  20,   // max % of allocatedCash per position
  rsiThreshold:    35,   // RSI level for signal #2
  volZScore:       1.5,  // volume Z-score for signal #3
  fibReturnMin:   -20,   // 60-day return lower bound for Fib zone
  fibReturnMax:    -5,   // 60-day return upper bound for Fib zone
};
```

Both objects are editable at runtime via the **Day Trading → Rules** tab.

---

## `js/regime-engine.js`

Classifies the current market regime from macro data and gates strategy execution.

**Regimes:** `riskOn` · `riskOff` · `panic` · `highVol` · `trend` · `sideways` · `unknown`

**Strategy gates:**

| Strategy | Allowed regimes |
|---|---|
| `meanReversionSwing` (day trading) | riskOn, sideways, highVol |
| `momentumBreakout` | riskOn, trend |
| `portfolioAnalysis` | riskOn, riskOff, sideways, trend, highVol |
| Any strategy | **panic → always blocked** |

**Size modifiers applied per regime:**

| Regime | Confidence boost | Size multiplier | Max new positions |
|---|---|---|---|
| riskOn | 0 | 1.0× | 5 |
| trend | 0 | 1.1× | 4 |
| sideways | +0.05 | 0.8× | 3 |
| highVol | +0.08 | 0.6× | 2 |
| riskOff | +0.10 | 0.5× | 1 |
| panic | — | 0× | 0 — no new positions |

---

## `js/quant-engine.js`

`computeTradeParams(ticker, signals, portfolioCtx, analystOutput)` — deterministic trade math.

**Sizing constraints (all applied; most restrictive wins):**

| Constraint | Formula |
|---|---|
| Account risk | `maxRiskAUD = capital × 1%` → `qty = floor(maxRiskAUD / stopDist)` |
| Max position | `floor(allocatedCash × 20% / price)` |
| Liquidity | `floor(ADV20 × 5%)` |
| Fractional Kelly | `f* = (p·b − q) / b × 0.25 (quarter Kelly)` |

**Volatility scalar:** positions are scaled down for high-ATR stocks to normalise dollar risk.

**Returns:** `{ ok, qty, stopLoss, target, rrRatio, riskAUD, rewardAUD, evNet, kellyFraction, volScalar, constraintBinding, scenarios }`

---

## `js/learning-loop.js`

Client-side calibration wrapper. Calls `GET /api/learning/calibration` for a server-computed, decay-weighted calibration block and injects it into every Claude user message.

- **`fetchCalibrationBlock(regime, sectors, tickers)`** — pulls compact calibration string (30–60 tokens) from backend. Block includes: confidence-band win rates with ESS-gated adjustments, dominant error-type warning, dominant success-tag nudge (Sprint 27), per-ticker stats for portfolio holdings, date range and regime label.
- Backend (`routes/learning.py`) uses exponential time-decay with volatility-adaptive half-life (panic=20d → calm=60d), Kish ESS≥2.5 gates, and hierarchical regime fallbacks.

## `js/debate-client.js`

Ollama debate, postmortem, skill scoring, and calibration quality wrappers.

- All Ollama calls go through `_oqEnqueue(fn, priority)` — single-concurrency drain with HIGH/LOW priority lanes
- `triggerCalibQualityIfStale(regime)` — fires `GET /api/debate/calib-quality` once per day (localStorage date guard); LOW priority

---

## `js/prompt-modules.js`

Optional rule modules injected based on date, portfolio, and regime. The core system prompt stays cached; modules are appended as a second uncached block.

| Module | Activation condition |
|---|---|
| `TAX_LOSS_HARVEST` | May–June (financial year-end window) |
| `REPORTING_SEASON` | February or August |
| `CGT_DISCOUNT_WINDOW` | Any holding in 11–12 month bracket |
| `MINING_SECTOR` | Portfolio contains Mining/Resources |
| `REIT_SECTOR` | Portfolio contains REITs |
| `HIGH_VOL_REGIME` | Current regime = highVol |
| `RISK_OFF_REGIME` | Current regime = riskOff |

---

## `js/response-validator.js`

Schema + business rule validation on every Claude response. Runs after `parseClaudeJSON()`.

**Schema checks:** required fields, type enforcement, enum validation, pattern matching.

**Business rules:**
- BUY/TOP_UP: target must exceed entry high
- Stop must be below entry low
- qty must be a positive integer
- confidence must be in [0, 1]
- R:R must be ≥ 2.0 for BUY/TOP_UP

`getValidatedAnalysisWithRepair()` runs up to 2 attempts — on failure it appends a repair instruction to the user message and calls Claude again. Partial success (some valid recs) is accepted on the final attempt.

---

## Features

### Portfolio Management
- Holdings with shares, average cost, current price, unrealised P&L
- Sector allocation pie chart
- CGT parcel tracking (FIFO / LIFO / Max-gain) with 12-month discount flag
- Trade journal with open/close tracking and fee deduction
- Portfolio reconciliation — detects journal vs holdings mismatches

### AI Analysis (Claude Sonnet 4.6)
- **Morning Macro** — sentiment, key drivers, bullish/bearish score from live market data
- **Recommendations** — BUY / TOP_UP / SELL / TRIM with confidence, rationale, CGT and franking awareness, anti-churn rules
- **Regime gate** — classifies market regime before every analysis run; blocks new positions in panic markets
- **Quant engine post-processing** — AI confidence drives Kelly sizing; deterministic code computes final qty/stop/EV
- **Learning Loop** — every recommendation logged to `ai_learning_events`; calibration feedback (decay-weighted win rates, ESS-gated, regime-adaptive half-life) injected into every user message; success pattern nudge reinforces winning trade setups
- **Calibration Quality debate** — `GET /api/debate/calib-quality` pre-computes Z-scores per confidence band and sends a statistically-constrained prompt to Ollama; result shown on Learning page with traffic-light verdicts
- **Dynamic prompt assembly** — core rules cached; optional modules (harvest window, reporting season, high-vol) added per call
- Prompt caching for intraday cache hits on static system prompts
- Exponential backoff retry (1 s / 2 s / 4 s) on HTTP 429 / 529 from Anthropic
- AI call logging to `ai_call_log` DB table — full prompt + response browsable via Settings → Recent AI Calls

### Rules UI (no code editing required)
- **Recommendations → Rules tab** — all analysis thresholds editable at runtime: confidence floors, R:R ratio, position limits, anti-churn window, CGT months, VaR thresholds, and more
- **Day Trading → Rules tab** — pre-filter params (BB %B, ADV, SMA200, ADX) and AI signal params (stop ATR, confidence, RSI, Fib zone) all editable and persisted to DB

### Day Trading (Swing Trade 5–15 days)
- **Portfolio scan** — analyses your holdings + custom extra tickers with full indicator stack
- **Universe scanner** — scans ASX 20/50/100/200, client-side pre-filter (BB + ADV + SMA200 + ADX), top-15 candidates sent to AI
- Strategy: BB lower band reclaim (primary) + RSI < 35 + Volume Z-Score + Fibonacci 50–61.8% zone + OBV divergence
- Deterministic quant engine overrides AI-computed qty with Kelly-fractional sizing
- Regime modifiers reduce position size in highVol/riskOff markets
- Execute — auto-adds to trade journal, deducts cash
- Earnings calendar overlay for catalyst risk

### Live Signals
- RSI (9 + 14), MACD + histogram, Stochastic %K/%D, Williams %R, CCI
- Bollinger Bands (%B + bandwidth), ATR, Keltner channel, Donchian channel
- OBV trend, MFI, VWAP (20-day), Volume Z-Score, ADV
- ADX + ±DI, trend score, composite signal

### News Scanner
- RSS feeds aggregated and deduplicated (TF-IDF cosine similarity)
- LLM classification via Ollama (local), Groq, or Google Gemini
- Sentiment tags: bullish / bearish / neutral per article
- Scheduled 4x/day or manual trigger

### Announcements
- ASX company announcements scraped from ASX website
- PDF text extraction (pdfplumber primary, PyMuPDF fallback)
- Price-sensitive filter — only actionable announcements surfaced
- Google Gemini scoring with live model picker
- Retry with exponential backoff on Gemini 429 rate-limit errors

### Risk Dashboard
- Per-holding: annualised volatility, Sharpe ratio, beta (vs VAS.AX), VaR 95%, CVaR 95%, max drawdown
- Portfolio correlation heatmap (canvas)
- Sector concentration warning

### Backtesting
- Replay historical signals against price data
- AI-assisted replay — Claude evaluates each signal in hindsight

### Performance
- Realised P&L by trade, win rate, average win/loss
- Sector-level attribution
- Value history chart

### Settings
- Anthropic API key (Claude)
- Brokerage per trade, max trades/day, min trade size
- LLM provider for news scanner (Ollama / Groq / Gemini)
- SBC mode toggle (Raspberry Pi / Jetson Orin): 20-min refresh, disables auto-scan

---

## SBC / Low-Power Mode

Toggle via the **PC** button in the top bar. In SBC mode:
- Price refresh interval: 20 minutes (vs 5 minutes in PC mode)
- Auto-scan disabled to reduce CPU load
- Designed for Raspberry Pi 5 or Jetson Orin running headlessly

---

## Data & Persistence

- **yfinance** — all price and fundamental data (no API key required)
- **SQLite** (`asx_trader.db`, WAL mode) — all app state: portfolio, journal, recommendations, settings, nav history, CGT parcels, announcements
- No external database, no cloud sync

---

## LLM Providers

| Provider | Used for | Notes |
|---|---|---|
| Anthropic Claude Sonnet 4.6 | Analysis, recommendations, day trading | API key required |
| Google Gemini | Announcements | API key required; model selectable in Settings |
| Groq | News scanner | API key required |
| Ollama (local) | News scanner | No API key; pull a model first |
