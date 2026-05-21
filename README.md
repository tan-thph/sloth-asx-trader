# ASX Trading Assistant

A local decision-support tool for Australian equity trading. Runs entirely on your machine — no cloud subscriptions, no SaaS fees. A Flask backend fetches market data via yfinance; a vanilla-JS frontend provides the UI.

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
├── asx_server.py           # Flask backend — routes only (44 API endpoints)
├── indicators.py           # All technical indicator functions + analyse_ticker()
├── announcement_engine.py  # ASX announcement fetching, PDF parsing, Gemini scoring
├── announcement_routes.py  # Blueprint: /api/announcements/*
├── news_engine.py          # News RSS fetching, dedup, LLM classification
│
├── requirements.txt
│
└── js/
    ├── config.js               # API base URL, constants
    ├── utils.js                # Shared helpers (fmt, todayStr, toast, etc.)
    ├── api.js                  # Fetch wrappers for every backend endpoint
    ├── portfolio-helpers.js    # mergedPortfolio(), portfolioValue(), position sizer
    ├── scheduler.js            # Auto-refresh timer, SBC mode (20-min interval)
    ├── reconcile.js            # Portfolio reconciliation vs journal
    ├── prices.js               # Live price refresh + price cache
    ├── charts.js               # Canvas chart renderers (candlestick, sparkline, etc.)
    ├── analysis.js             # AI analysis engine — calls Claude API, parses recs
    ├── prompts.js              # All AI system prompts (edit here, not in engine files)
    ├── strategy.js             # Day trading pre-filter thresholds + _dtPreFilter()
    ├── day-trading-analysis.js # Day trade + universe scan orchestration
    ├── asx-universe.js         # ASX 20/50/100/200 ticker lists
    ├── navigation.js           # showPage(), sidebar active state
    ├── init.js                 # App bootstrap, state init, server health check
    │
    └── pages/
        ├── dashboard.js        # Portfolio summary, holdings table, charts
        ├── portfolio.js        # Holdings editor, add/remove positions
        ├── macro.js            # Morning macro brief (ASX200, AUD/USD, commodities)
        ├── signals.js          # Live technical signals table (RSI, BB, MACD, OBV, MFI, VWAP)
        ├── recommendations.js  # AI BUY/TOP_UP/SELL/TRIM recommendations
        ├── day-trading.js      # Day trading UI — portfolio scan + universe scanner
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

## Key Files to Edit

| What you want to change | File |
|---|---|
| Indicator formulas (RSI period, BB std dev, ATR period, etc.) | `indicators.py` |
| Buy/sell signal rules and composite score logic | `indicators.py` → `analyse_ticker()` |
| Day trading pre-filter thresholds (BB %B, ADV, SMA200, ADX) | `js/strategy.js` → `DT_FILTER` |
| AI system prompts (analysis, macro, day trading) | `js/prompts.js` |
| Market scanner scoring weights | `indicators.py` → `_score_ticker()` |
| ASX sector mapping | `indicators.py` → `ASX_SECTOR_MAP` |
| Announcement engine scheduling | `announcement_engine.py` |
| News RSS sources and LLM model | `news_engine.py` + Settings page |

---

## Backend — `asx_server.py`

Flask app (`localhost:5000`). All heavy computation is in `indicators.py`; the server handles routing, database I/O, and orchestration.

### API Endpoints

| Endpoint | Description |
|---|---|
| `GET /health` | Server health check |
| `GET /api/analyse/<ticker>` | Full indicator set for one ticker |
| `POST /api/analyse/batch` | Batch indicator fetch (used by day trading scanner) |
| `GET /api/macro` | ASX200, AUD/USD, gold, iron ore, copper, Dow |
| `GET /api/rba-rate` | RBA cash rate |
| `GET /api/quote/<ticker>` | Fast price + sector (no indicators) |
| `GET /api/risk?tickers=A,B,C` | Beta, Sharpe, VaR, CVaR, correlation matrix |
| `POST /api/portfolio/nav-history` | Reconstruct NAV over time |
| `GET /api/dividends/<ticker>` | Dividend history + yield |
| `POST /api/dividends/batch` | Batch dividend fetch |
| `GET/POST /api/cash` | Cash balance |
| `POST /api/market/scan` | Start background market scanner |
| `GET /api/market/scan/status` | Scanner progress |
| `POST /api/db/save` | Persist all app state to SQLite |
| `GET /api/db/load` | Load all app state |
| `GET /api/db/status` | DB row counts |
| `POST /api/backtest` | Run strategy backtest |
| `POST /api/backtest/ai-replay` | AI-assisted backtest replay |
| `GET /api/earnings-calendar` | Upcoming earnings dates |
| `GET /api/news` | Cached news items |
| `GET /api/news/brief` | News signals for specific tickers (used by day trading) |
| `POST /api/news/scan` | Trigger manual news scan |
| `GET/POST /api/news/settings` | News scanner configuration |
| `GET /api/news/models` | Available Ollama models |
| `GET /api/groq/models` | Available Groq models |
| `GET /api/google/models` | Available Google Gemini models |
| `GET /api/ann/gemini/models` | Announcement engine Gemini model list |
| `GET /api/announcements/*` | ASX announcement routes (see announcement_routes.py) |
| `POST /api/log/ai_response` | Log raw AI response to `ai_responses/` |

---

## `indicators.py`

All technical computations are here — edit without touching the server.

**Indicator functions:**
- `compute_rsi(series, period)` — Wilder smoothed RSI
- `compute_macd(series, fast, slow, signal)` — MACD line, signal, histogram
- `compute_bollinger(series, period, std_dev)` — Upper, mid, lower bands
- `compute_atr(high, low, close, period)` — Average True Range
- `compute_stochastic(high, low, close, k_period, d_period)`
- `compute_adx(high, low, close, period)` — ADX + ±DI
- `compute_obv(close, volume)` — On-Balance Volume
- `compute_vwap(high, low, close, volume)` — Rolling VWAP
- `compute_williams_r(high, low, close, period)`
- `compute_cci(high, low, close, period)` — Commodity Channel Index
- `compute_mfi(high, low, close, volume, period)` — Money Flow Index
- `compute_donchian(high, low, period)` — Donchian channel
- `compute_keltner(high, low, close, ema_period, atr_period, multiplier)` — Keltner channel
- `compute_support_resistance(high, low, close, lookback)` — Pivot-based S/R levels

**Analysis:**
- `analyse_ticker(ticker, period)` — Runs all indicators, computes composite signal (BUY/HOLD/SELL), confidence, price targets, stop-loss, and returns the full dict used by all pages

**Market scanner scoring:**
- `_simple_rsi(closes)` — Fast numpy RSI for scanner
- `_score_ticker(closes, volumes)` — 0–100 composite score (trend + pullback + volume + momentum)

---

## `js/prompts.js`

All Claude AI system prompts. Edit here — never need to touch `analysis.js` or `day-trading-analysis.js` for prompt changes.

| Export | Used by |
|---|---|
| `MACRO_SYSTEM_PROMPT` | Morning macro brief |
| `ANALYSIS_SYSTEM_PROMPT` | Portfolio recommendation analysis |
| `getDayTradeSystemPrompt()` | Day trade portfolio scan |
| `getDayTradeUniverseScanPrompt()` | ASX universe scanner |

The two `const` prompts are fully static (no dynamic interpolations) to enable Anthropic prompt cache hits across intraday runs.

---

## `js/strategy.js`

Client-side day trading strategy configuration.

```js
const DT_FILTER = {
  maxBbPctB:       0.20,   // BB %B <= this (price near lower band)
  minAdvAud:   1_500_000,  // minimum 20-day average daily value (AUD)
  sma200Floor:     0.985,  // price must be >= SMA200 x this
  maxAdx:           35,    // skip stocks already in a strong rip
  minRrRatio:       2.0,   // minimum reward:risk (enforced in AI prompt)
  minConfidence:   0.50,   // minimum AI confidence to accept a rec
  stopAtrMultiple: 2.5,    // stop = entry - stopAtrMultiple x ATR14
};
```

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
- **Confidence calibration** — hit rate by confidence band computed client-side, injected as instructions so the AI adjusts scores based on past accuracy
- Prompt caching (`anthropic-beta: prompt-caching-2024-07-31`) for intraday cache hits on static system prompts
- AI response logging to `ai_responses/` directory for debugging

### Day Trading (Swing Trade 5–15 days)
- **Portfolio scan** — analyses your holdings + custom extra tickers with full indicator stack
- **Universe scanner** — scans ASX 20/50/100/200, client-side pre-filter (BB + ADV + SMA200 + ADX), top-15 candidates sent to AI
- Strategy: BB lower band reclaim (primary) + RSI < 35 + Volume Z-Score + Fibonacci 50–61.8% zone + OBV divergence
- Position sizing: `qty = floor(riskPerTrade / (2.5 x ATR14))`
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
- `/api/news/brief` used by day trading engine for signal context

### Announcements
- ASX company announcements scraped from ASX website
- PDF text extraction (pdfplumber primary, PyMuPDF fallback)
- Price-sensitive filter — only actionable announcements surfaced
- Google Gemini scoring with live model picker (gemini-2.0-flash-lite default)
- Retry with exponential backoff on Gemini 429 rate-limit errors
- Scheduled at 10:30 AM and 3:00 PM AEST on weekdays

### Risk Dashboard
- Per-holding: annualised volatility, Sharpe ratio, beta (vs VAS.AX), 30/90-day return, VaR 95%, CVaR 95%, max drawdown
- Portfolio correlation heatmap (canvas)
- Sector concentration warning (>40% in one sector)

### Backtesting
- Replay historical signals against price data
- AI-assisted replay — Claude evaluates each signal in hindsight

### Performance
- Realised P&L by trade, win rate, average win/loss
- Sector-level attribution
- Value history chart

### Settings
- Anthropic API key (Claude)
- Brokerage per trade
- Max trades per day, min trade size
- LLM provider for news scanner (Ollama / Groq / Gemini)
- Gemini model picker for announcements (live list from API)
- SBC mode toggle (Raspberry Pi / Jetson Orin): switches to 20-min refresh, disables auto-scan

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
| Anthropic Claude | Analysis, recommendations, day trading | API key required |
| Google Gemini | Announcements | API key required; model selectable in Settings |
| Groq | News scanner | API key required |
| Ollama (local) | News scanner | No API key; pull a model first |
