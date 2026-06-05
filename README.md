# Sloth ASX Trader

A local decision-support tool for Australian equity trading. Runs entirely on your machine — no cloud subscriptions, no SaaS fees. A Flask backend fetches market data via yfinance; a vanilla-JS single-page app provides the UI and calls the Anthropic API directly from the browser.

---

## Quick Start

```bash
pip install -r requirements.txt
python asx_server.py
# Then open asx_trading.html in your browser
```

The server starts at `http://localhost:5000`. Open `asx_trading.html` directly from the filesystem — no web server needed.

**Production (multi-worker):**
```bash
pip install gunicorn
gunicorn -c gunicorn.conf.py 'asx_server:app'
```

**API key:** paste your Anthropic key in Settings → API Key (stored in `localStorage`), or enable proxy mode to store it server-side in SQLite.

---

## Project Structure

```
sloth-asx-trader/
│
├── asx_trading.html        # Single-page app entry point
├── asx_trading.css         # All styles (CSS variables, tab underline, compact mode)
│
├── asx_server.py           # Flask bootstrap — blueprint registration, middleware
├── core.py                 # Shared infra: ttl_cache, fetch_with_retry, Stooq fallback
├── db.py                   # SQLite schema, get_db(), init_db(), WAL migrations, backup
├── indicators.py           # All technical indicators + analyse_ticker() + _score_ticker()
├── announcement_engine.py  # ASX announcement fetching, PDF parsing, Gemini scoring
├── announcement_routes.py  # Blueprint: /api/announcements/*
├── news_engine.py          # RSS fetching, TF-IDF dedup, LLM sentiment classification
├── gunicorn.conf.py        # Production WSGI: 2 workers × 8 threads
│
├── routes/
│   ├── portfolio.py        # /api/cash, /api/db/*, /api/tax/eofy-pack, splits-check, capital-returns
│   ├── market.py           # /api/analyse, /api/quote, /api/macro, /api/risk, /api/earnings-calendar
│   │                       # /api/seasonality, /api/log/ai_calls, /api/market/universe-health
│   ├── learning.py         # /api/learning/* — calibration, stats, outcomes, lessons, sell-outcomes
│   ├── debate.py           # /api/debate/* — Ollama bull/bear, postmortem, skill, calib-quality
│   ├── backtest.py         # /api/backtest, /api/backtest/walk-forward, /api/backtest/ai-replay
│   ├── scanner.py          # /api/market/scan*, /api/scanner/factor-stability
│   ├── intraday.py         # /api/intraday/* — 5-minute intraday day-trade strategy
│   ├── dividends.py        # /api/dividends/*
│   ├── news.py             # /api/news/*, /api/groq/models, /api/google/models, /api/sbc-mode
│   ├── alerts.py           # /api/alerts/telegram — Telegram bot push alerts
│   ├── claude.py           # /api/claude/* — Anthropic API proxy (opt-in)
│   └── import_csv.py       # /api/import/csv — CommSec / SelfWealth CSV parser
│
├── js/
│   ├── config.js               # Global state object, API base URL, defaults
│   ├── utils.js                # Shared helpers: fmt, toast, parseClaudeJSON, _detectExitReason
│   ├── api.js                  # All backend fetch wrappers + scheduleSave() debounce
│   ├── portfolio-helpers.js    # addParcel(), matchSaleAgainstParcels(), mergedPortfolio()
│   ├── scheduler.js            # Auto-refresh timer, SBC mode (20-min interval)
│   ├── reconcile.js            # Portfolio reconciliation vs journal
│   ├── prices.js               # Live price refresh + stale-data badge (>25 min)
│   ├── charts.js               # Canvas chart renderers (candlestick, sparkline, etc.)
│   │
│   ├── ── AI Infrastructure ──
│   ├── claude-client.js        # Centralised callClaude() — retries, caching, agent routing
│   ├── quant-engine.js         # Deterministic sizing: Kelly, vol scalar, VaR1d, multi-constraint
│   ├── regime-engine.js        # Market regime classifier + strategy gates + blended size modifiers
│   ├── learning-loop.js        # Calibration stats, fetchCalibrationBlock(), decay detection
│   ├── prompt-modules.js       # Optional rule modules + dynamic system prompt assembly
│   ├── response-validator.js   # Schema + business rule validation, auto-repair, SELL/TRIM taxonomy
│   │
│   ├── ── Core Engines ──
│   ├── prompts.js              # All AI system prompts (ANALYSIS, MACRO, ANALYST, PM, DT, BRIEFING)
│   ├── analysis.js             # Portfolio analysis: regime gate → Claude → quant → validate
│   ├── strategy.js             # DT pre-filter thresholds (DT_FILTER) + AI params (DT_AI_PARAMS)
│   ├── asx-universe.js         # ASX 20/50/100/200 ticker lists
│   ├── day-trading-analysis.js # Day trade + universe scan orchestration
│   ├── intraday-strategy.js    # Intraday 5m strategy parameters
│   ├── navigation.js           # showPage(), renderPage() with error boundary
│   ├── alerts.js               # fireAlert() — desktop + optional Telegram mirror
│   ├── init.js                 # App bootstrap, auto-save (beforeunload keepalive + 60 s periodic)
│   ├── debate-client.js        # Ollama debate, postmortem, skill, calib-quality wrappers
│   │
│   └── pages/
│       ├── dashboard.js        # Portfolio summary, NAV chart, drawdown monitor, cash tracker
│       ├── portfolio.js        # Holdings editor (multi-account), DRP, parcels, splits/capital-return warnings
│       ├── macro.js            # Morning macro brief + auto-briefing
│       ├── signals.js          # Live technical signals + seasonality + indicator alerts
│       ├── recommendations.js  # AI recs (Setups / History / Analysis / Rules tabs)
│       ├── day-trading.js      # Swing day-trading UI (Setups / Rules tabs)
│       ├── intraday.js         # ⚡ Intraday 5m day-trading (entry-window gate, VWAP, RSI)
│       ├── journal.js          # Trade journal — open/close trades, P&L, DRP entries
│       ├── cgt.js              # CGT parcels, FIFO/LIFO/Max-gain, 12-month discount, DRP badges
│       ├── performance.js      # P&L charts, hit rate, drawdown, sector attribution, sync to learning
│       ├── backtest.js         # Strategy backtesting (flat + liquidity slippage) + walk-forward + AI replay
│       ├── risk.js             # Beta, Sharpe, VaR/CVaR, correlation, target allocations, rebalance
│       ├── assistant.js        # Free-form AI chat with portfolio context
│       ├── news.js             # News scanner — RSS + LLM sentiment tagging
│       ├── announcements.js    # ASX announcements — price-sensitive filter + Gemini scoring
│       ├── scanner.js          # Market scanner (Opportunities / Screener / Compare / Factor Stability tabs)
│       ├── watchlist.js        # Watchlist — live signals, indicator alerts
│       ├── compare.js          # Side-by-side ticker comparison (tab inside Scanner)
│       ├── learning.js         # Learning Loop — calibration, stats, postmortem, sell-outcomes, lessons
│       └── settings.js         # API keys, brokerage, LLM providers, compact mode, Telegram, AI call log
```

---

## Architecture — AI Pipeline

Every recommendation flows through four deterministic layers:

```
Signals (indicators.py)
  → Regime Engine (regime-engine.js)   — classifies market, gates strategy, sizes position
  → Claude (claude-client.js)          — qualitative conviction, never does arithmetic
  → Quant Engine (quant-engine.js)     — deterministic stop/target/qty/EV from Kelly + constraints
  → Validator (response-validator.js)  — schema + business rules, auto-repair (≤2 retries)
  → UI
```

| Layer | Responsibility |
|---|---|
| **Regime Engine** | Classifies market (`riskOn/riskOff/panic/highVol/trend/sideways`) from live macro data + SPI200 futures. Panic regime returns `sizeMult=0` — no new positions. `_blendedSizeMult` linearly transitions over 30 min after a regime flip to prevent cliff-edge sizing changes. |
| **Claude** | Qualitative conviction — what to buy/sell and why. Never does arithmetic. Injected with calibration block, active regime, lessons, and regime-aware stop ATR multiple. |
| **Quant Engine** | Deterministic sizing: Kelly × vol scalar × multi-constraint (account-risk %, max-position %, liquidity, VaR1d). Stop = `stopAtrMult × earningsAdj × ATR14`. Rejects when `kellyFrac ≤ 0` (negative EV). |
| **Validator** | Schema + SELL/TRIM tagging checks. Auto-repair loop (≤2 retries). HOLD recs skip target/stop/qty fields. |

### Regime stop ATR multiples

| Regime | `stopAtrMult` |
|---|---|
| riskOn / trend / sideways | 2.5× |
| highVol | 3.0× |
| riskOff | 3.5× |
| panic | 4.0× |

---

## Features

### Portfolio Management
- Holdings with shares, average cost, current price, sector, unrealised P&L
- **Multi-account isolation** — separate `personal`, `super`, and `trading` accounts; same ticker held in different accounts appears as distinct rows with separate CGT parcel pools
- **DRP parcel tracking** — Dividend Reinvestment Plan events update cost-basis and create CGT parcels with `action: 'DRP'`
- CGT parcel tracking (FIFO / LIFO / Max-gain) with 12-month discount flag and DRP badge
- Trade journal with open/close tracking, fee deduction, and DRP entries
- **Stock split warnings** — checks yfinance splits data on Portfolio page load, shows amber banner
- **Capital return warnings** — large distributions ≥5% of price flagged for CGT review
- **EOFY tax pack** — download ZIP with CGT disposals CSV + trade fees CSV from CGT page
- **Broker CSV import** — CommSec / SelfWealth / generic auto-detection; BUY rows added to portfolio, SELL rows matched via FIFO/LIFO against open parcels
- Portfolio reconciliation — detects journal vs holdings mismatches

### AI Analysis (Claude Sonnet 4.6)
- **Morning Macro Brief** — sentiment, key drivers, bullish/bearish score from live market data; auto-scheduled at configurable AEST time
- **Recommendations** — BUY / TOP_UP / SELL / TRIM / HOLD with confidence, rationale, CGT and franking awareness, anti-churn rules (7-day block with CATASTROPHE overrides including brokerage-exceeds-profit)
- **Regime gate** — classifies market before every analysis run; blocks new positions in panic; applies regime-specific stop ATR multiple and size multiplier
- **Pre-earnings adjustment** — `earningsAdj = 1.3×` on stop when `signals.pre_earnings_risk = true` (≤14 days to earnings); `📅 Pre-earnings` badge on rec card
- **VaR1d sizing** — quant engine applies 0.75×/0.5× multiplier when portfolio VaR1d > 3.5%/5%; `📉 VaR adj` badge on rec card
- **SELL/TRIM structured tagging** — every exit rec must include `primary_driver` (9-driver taxonomy), optional `secondary_factors` (12 tags, max 3), and `urgency` (`immediate/routine/monitor`). Auto-repair demotes `better_opportunity` without `alternativeTicker` to `risk_management`
- **Learning Loop** — every recommendation logged; calibration feedback (decay-weighted win rates, regime-adaptive half-life, Phase 8 Mann-Whitney z-score gate) injected into every user message
- **Local LLM fast-path** — Settings → "Use local LLM for analysis" routes portfolio analysis to Ollama (`POST /api/debate/quick-analysis`); BUY/TOP_UP/HOLD/SELL/TRIM supported; `🔒 Local` badge on recs; no API spend
- Dynamic prompt assembly — core rules cached with `cache_control: ephemeral`; optional modules (tax-loss harvest, reporting season, high-vol, REIT/mining) appended as uncached second block
- Exponential backoff retry (1 s / 2 s / 4 s) on HTTP 429/529
- AI call log — full prompt + response stored in `ai_call_log` DB table; browsable via Settings → Recent AI Calls; test API key calls excluded from log

### Learning Loop
- Every rec logged to `ai_learning_events` on generation; patched with outcome on close
- **Calibration block** — `GET /api/learning/calibration` returns a compact ~30–100 token block injected into every Claude user message: confidence-band win rates, dominant error nudge, success-tag nudge, per-ticker stats, regime warning
- **Decay-weighted win rates** with volatility-adaptive half-life (panic=20d → calm=60d)
- **Phase 8 Mann-Whitney z-score gate** — skill-weighting only active when z > 1.28; z-score and threshold shown in Learning UI
- **Virtual outcomes** — unexecuted recs ≥30 days old price-checked against actual market; prevents calibration bias from executed-only sample
- **Thesis drift nudge** — `⚠EARLY_EXIT_DRAG` emitted when manual exits lag target-hit exits by >3pp (n≥5)
- **Sell tag spot-check** — weekly 5-event batch review (agree/disagree/retag); `agree_rate < 0.60` restricts calibration to manually-reviewed events
- **Sell-outcome validation** — SELL/TRIM events ≥25d old price-checked; `validated/invalidated/inconclusive` verdict shown on Learning page
- **Scoped lessons** — persistent trading lessons filtered by ticker / sector / regime / breadth; up to 4 injected per analysis call
- **Debate engine** — local Ollama bull/bear debate, adversarial postmortem (two-model), skill scoring, calibration quality (Z-score per band, traffic-light verdicts); all manual-only via 🤖/⚔️/🔬/⚖️ buttons

### Day Trading (Swing, 5–15 days)
- **Portfolio scan** — analyses holdings + custom tickers with full indicator stack
- **Universe scanner** — scans ASX 20/50/100/200; client-side pre-filter (BB + ADV + SMA200 + ADX); top-15 sent to AI
- Strategy signals: BB lower-band reclaim + RSI < 35 + Volume Z-Score + Fibonacci 50–61.8% zone + OBV divergence
- **`DT_FILTER` / `DT_AI_PARAMS`** editable at runtime via Day Trading → Rules tab

### ⚡ Intraday Day Trading (same-day, 5-minute bars)
- ASX 20/50/100/200 universe scanner with 8-thread pool
- VWAP, intraday RSI, volume acceleration, setup score 0–100
- Entry window gate: 10:45–15:00 AEST only; time-stop alert at 15:00 AEST
- `passes` flag gates actionable setups; data shown outside window for monitoring

### Market Scanner
- Background ASX universe scan (configurable universe, min ADV, exclude holdings)
- **Opportunities tab** — ranked candidates with composite score
- **Technical Screener tab** — parametric filter
- **Compare tab** — side-by-side indicator comparison for up to N tickers (`compareFromOutside()` API for other pages)
- **Factor Stability tab** — post-scan IC analysis for `FACTOR_WEIGHTS` tuning (`POST /api/scanner/factor-stability`)
- Saved screener presets persisted to DB

### Live Signals
- RSI (9 + 14), MACD + histogram, Stochastic %K/%D, Williams %R, CCI
- Bollinger Bands (%B + bandwidth), ATR, Keltner channel, Donchian channel
- OBV trend, MFI, VWAP (20-day), Volume Z-Score, ADV
- ADX + ±DI, trend score, composite signal, 60-day high/low (Fibonacci zone)
- Seasonality — 12-month average return pattern (10yr monthly history)
- Indicator alerts — RSI above/below, BB breakout/breakdown, volume spike

### Risk Dashboard
- Per-holding: annualised volatility, Sharpe ratio, beta (vs VAS.AX), VaR 95%, CVaR 95%, max drawdown
- Portfolio correlation heatmap (canvas)
- **Target allocations + rebalance** — set target weight per ticker; drift card shows over/under; one-click "Suggest Rebalance" generates deterministic BUY/TRIM list with CGT discount-at-risk warnings
- Heat budget gate — max total $ at risk to stops as % of portfolio (default 5%; configurable on Risk page)

### News Scanner
- RSS feeds aggregated and deduplicated (TF-IDF cosine similarity)
- LLM classification via Ollama (local), Groq, or Google Gemini
- Sentiment tags: bullish / bearish / neutral per article
- Repetition guard — URL stripping, `repeat_penalty: 1.2`, regex post-processor
- Scheduled 4×/day or manual trigger

### Announcements
- ASX company announcements scraped from ASX website
- PDF text extraction (pdfplumber primary, PyMuPDF fallback)
- Price-sensitive filter — only actionable announcements surfaced
- Google Gemini scoring with live model picker

### Alerts
- Desktop notifications via browser Notifications API
- **Telegram mirror** — optional off-device push alerts; credentials stored server-side in SQLite (never in browser)
- Stop-proximity alert (configurable %, direction-aware for SELL/TRIM), target-hit alert — each fires once, re-arms after 2× threshold retreat
- Drawdown monitor — alert when portfolio drawdown exceeds configurable threshold (default 10%)

### Backtesting
- Historical strategy replay against price data
- Slippage modes: `flat` (fixed per trade) or `liquidity` (ADV-tiered rates)
- **Walk-forward backtesting** — out-of-sample parameter validation
- **AI replay** — Claude evaluates each historical signal in hindsight

### Settings
- Anthropic API key (direct browser mode or server-side proxy mode)
- Brokerage per trade, max trades/day, min trade size
- LLM provider for news scanner (Ollama / Groq / Gemini)
- SBC mode toggle (20-min refresh, auto-scan disabled)
- Compact mode — reduced padding/row heights for small screens
- Auto-briefing time (AEST HH:MM, fires on first page load)
- Recent AI Calls browser — full prompt + response audit trail
- Universe health check — verify all ASX200 tickers reachable; manage exclusion list
- Telegram credentials — test, save, enable/disable

---

## AI Pipeline — Key Files

| What to change | File | Where |
|---|---|---|
| Analysis rules (no code edit) | Recommendations → Rules tab | runtime |
| Day trade thresholds (no code edit) | Day Trading → Rules tab | runtime |
| SELL/TRIM tagging taxonomy | `js/response-validator.js` | `SELL_PRIMARY_DRIVERS`, `SELL_SECONDARY_FACTORS` |
| All AI system prompts | `js/prompts.js` | `ANALYSIS_SYSTEM_PROMPT`, etc. |
| Optional prompt modules | `js/prompt-modules.js` | `RULE_MODULES`, `assembleOptionalModules()` |
| Regime classification thresholds | `js/regime-engine.js` | `REGIME_THRESHOLDS` |
| Quant engine sizing | `js/quant-engine.js` | `QUANT_CONFIG` |
| Indicator formulas | `indicators.py` | `analyse_ticker()` |
| Scanner scoring weights | `indicators.py` | `FACTOR_WEIGHTS` |
| Announcement engine | `announcement_engine.py` | — |
| News RSS sources | `news_engine.py` + Settings | — |

---

## Data & Persistence

- **yfinance** — price, fundamentals, splits, dividends (no API key required)
- **Stooq** — third-line fallback for prices when yfinance + stale cache are both empty; rate-limited to ~1 req/sec via `BoundedSemaphore`
- **ASX sector indices** — `^AXMJ`, `^AXFJ`, `^AXHJ`, `^AXEJ`, `^AXRJ` (yfinance canonical `^AX*` prefix)
- **SQLite** (`asx_trader.db`, WAL + `synchronous=NORMAL`) — all state: portfolio, journal, recs, settings, nav history, CGT parcels, announcements, learning events, AI call log. WAL checkpoint + `PRAGMA optimize` run on every startup.
- Auto-save: 500 ms debounce on state changes, 60 s periodic, `fetch({ keepalive: true })` on page unload
- DB backup: daily rotating backup (last 7 kept), path in `GET /health`
- No external database, no cloud sync

---

## LLM Providers

| Provider | Used for | Notes |
|---|---|---|
| Anthropic Claude Sonnet 4.6 | Portfolio analysis, recommendations, day trading, macro brief, assistant | API key required |
| Google Gemini | Announcements, debate adjudicator | API key required; model selectable in Settings |
| Groq | News scanner, debate adjudicator fallback | API key required |
| Ollama (local) | News scanner, bull/bear debate, postmortem, skill scoring, calib quality, local LLM portfolio analysis | No API key; pull a model first |

---

## Running Tests

```bash
# All Python tests (536 tests — backend routes, indicators, JS syntax/function checks)
python test_app.py

# Vitest JS unit tests (110 tests — quant-engine, regime-engine, response-validator, _detectExitReason)
npm run test:js
```

---

## SBC / Low-Power Mode

Toggle via the **PC** button in the top bar. In SBC mode:
- Price refresh interval: 20 minutes (vs 5 minutes in PC mode)
- Auto-scan disabled to reduce CPU load
- Designed for Raspberry Pi 5 or Jetson Orin running headlessly
