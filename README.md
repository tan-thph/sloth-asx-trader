# Sloth ASX Trader

A local, AI-powered decision-support tool for Australian equity trading. Runs entirely on your own machine — no subscriptions, no cloud database, no data leaving your network.

---

## Overview

Sloth ASX Trader combines live market data, technical analysis, and large language models to help you research trades, manage your portfolio, and review your decision-making over time. Everything is stored locally in SQLite. The AI analysis layer uses Anthropic Claude for recommendations, with optional local LLM support via Ollama for zero-API-cost operation.

---

## Getting Started

**Requirements:** Python 3.9+, pip, a modern browser.

```bash
pip install -r requirements.txt
python asx_server.py
```

Open `asx_trading.html` in your browser. No web server needed — the file opens directly from disk.

**Production mode** (multi-worker, recommended for daily use):
```bash
pip install gunicorn
gunicorn -c gunicorn.conf.py 'asx_server:app'
```

**API key:** paste your Anthropic key in Settings → API Key. It is stored in browser `localStorage` and never sent anywhere except the Anthropic API. An optional server-side proxy mode stores the key in SQLite instead.

---

## Features

### Portfolio Management
Track your holdings across multiple accounts — personal, super, and trading. Each account maintains its own CGT parcel pool so a ticker held in two accounts is never mixed.

- Holdings with live prices, unrealised P&L, and sector attribution
- Multi-account isolation (personal / super / trading)
- CGT parcel tracking — FIFO, LIFO, or Max-gain disposal methods
- 12-month CGT discount flag and DRP (Dividend Reinvestment Plan) parcel support
- Capital gains/loss summary with EOFY tax pack download (CSV)
- Trade journal with full open/close history and brokerage deduction
- Stock split detection and capital return warnings
- Broker CSV import — CommSec and SelfWealth formats auto-detected

### AI Analysis (Claude Sonnet)
Every recommendation flows through a deterministic pipeline: live signals → regime classification → Claude → position sizing → schema validation. Claude handles qualitative judgement; all arithmetic is done by code.

- **Portfolio recommendations** — BUY, TOP_UP, SELL, TRIM, and HOLD with confidence scores, rationale, stop-loss, target, and sized quantity
- **Regime-aware analysis** — the market regime (risk-on, risk-off, high-vol, trend, sideways, panic) gates which strategies are active, adjusts position sizes, and widens stops in volatile conditions
- **Anti-churn rules** — a 7-day hold gate prevents reflexive reversals; overrideable for genuine risk events
- **Pre-earnings protection** — stop distance widens automatically when earnings are within 14 days
- **CGT and franking awareness** — recommendations account for the 12-month discount window, tax-loss harvesting season, and franking credit capture
- **SELL/TRIM decision tagging** — every exit recommendation includes a structured primary driver (9-driver taxonomy), supporting factors, and urgency level for learning-loop feedback
- **Morning briefing** — macro sentiment summary with ASX200, AUD/USD, commodities, and a bullish/bearish score; auto-schedulable at a fixed AEST time
- **Free-form assistant** — conversational AI with full portfolio context for research questions

### Local LLM Mode
Enable "Use local LLM for analysis" in Settings to route portfolio analysis through a locally running Ollama model at zero API cost. Recommendations are labelled with a 🔒 Local badge. Full Claude analysis remains available on demand.

### Day Trading

**Swing trades (5–15 day holds)**
A dedicated scanner pre-filters the ASX 20/50/100/200 universe using Bollinger Band position, average daily volume, SMA200 proximity, and trend strength. The top candidates are sent to Claude for conviction scoring.

**Intraday (same-day, 5-minute bars)**
A separate intraday scanner monitors VWAP, intraday RSI, and volume acceleration. Entry signals are only marked actionable during the 10:45–15:00 AEST window; a time-stop alert fires at 15:00 for any open position.

Both modes use fully deterministic position sizing (Kelly fraction, volatility scalar, account-risk %, liquidity cap) applied after the AI produces its conviction score — the model never sees or computes quantities.

### Live Signals
Real-time technical indicator data per ticker:

- Momentum: RSI (9 + 14), MACD, Stochastic, Williams %R, CCI
- Volatility: Bollinger Bands (%B, bandwidth), ATR, Keltner channel, Donchian channel
- Volume: OBV, MFI, VWAP, volume Z-score, 20-day average daily value
- Trend: ADX, ±DI, SMA crossovers, composite signal score
- Seasonality: 12-month average return pattern from 10 years of monthly data
- Custom alerts: RSI thresholds, Bollinger breakout/breakdown, volume spikes

### Market Scanner
Batch-scan the ASX universe and rank tickers by a composite technical score. Results are filterable by sector, minimum liquidity, and whether a ticker is already held.

- **Opportunities** — ranked candidates with score, signals, and sector
- **Technical Screener** — parametric filter across the full indicator set
- **Compare** — side-by-side indicator comparison for any two or more tickers
- **Factor Stability** — empirical information coefficient analysis to tune scoring weights
- Save named screener presets for quick reuse

### Risk Dashboard
- Per-holding: beta (vs VAS.AX), annualised volatility, Sharpe ratio, VaR 95%, CVaR 95%, max drawdown
- Portfolio-level correlation heatmap
- Sector concentration warnings (>25% amber, >40% red)
- Target allocation tracking with one-click rebalance suggestions — deterministic BUY/TRIM recommendations with CGT discount-at-risk warnings
- Heat budget gate: caps total capital at risk to stops as a percentage of portfolio value

### Performance & Backtesting
- Realised P&L by trade, win rate, average win/loss, sector attribution
- Portfolio NAV history and drawdown monitoring
- Strategy backtesting with flat or liquidity-adjusted slippage
- Walk-forward validation for out-of-sample parameter testing
- AI replay — Claude evaluates historical signals in hindsight

### Learning Loop
Every recommendation is logged and tracked to outcome. The system feeds calibration data back into every subsequent analysis call.

- Confidence-band accuracy tracking with decay-weighted win rates
- Regime-adaptive calibration (shorter half-life in volatile markets)
- Virtual outcome resolution for unexecuted recommendations
- Sell-tag accuracy monitoring — validates whether exits were subsequently justified by price action
- Persistent trading lessons scoped by ticker, sector, regime, or breadth condition
- Local Ollama debate engine for trade postmortems, skill scoring, and adversarial two-model argument
- Phase 8 statistical gate (Mann-Whitney U) before skill-weighting activates

### News & Announcements
- RSS aggregator with TF-IDF deduplication across multiple feeds
- LLM sentiment classification — bullish / bearish / neutral per article
- ASX company announcements with PDF text extraction and price-sensitive filter
- Google Gemini scoring for announcement materiality

### Alerts & Notifications
- **Notification centre** — bell button captures every toast, alert, and error; full history stored in a dedicated `notifications.db`; paginated scrollable log
- **Desktop notifications** — stop-loss proximity, target hit, drawdown threshold, high-conviction recommendations, scan results
- **Telegram integration** — optional off-device push alerts; credentials stored server-side and never logged
- Drawdown monitor with configurable alert threshold

### Watchlist
Monitor tickers outside your portfolio with live signals, indicator alerts, and notes. Alert conditions fire the same notification pipeline as held positions.

---

## LLM Providers

| Provider | Used for |
|---|---|
| **Anthropic Claude Sonnet 4.6** | Portfolio analysis, recommendations, day trading, macro brief, assistant |
| **Google Gemini** | ASX announcement scoring, debate adjudication |
| **Groq** | News classification (fast inference), debate adjudication fallback |
| **Ollama (local)** | News classification, trade debate, postmortem analysis, local portfolio analysis (no API cost) |

Only the providers you configure are used. Anthropic is the only required key for core analysis functionality.

---

## Data & Privacy

- **All data is local.** Portfolio, trades, recommendations, and settings are stored in SQLite (`asx_trader.db`). Notifications have their own separate database (`notifications.db`).
- **Market data** is fetched from yfinance (free, no key required), with Stooq as a fallback provider.
- **No telemetry, no cloud sync.** The app makes no outbound connections except to configured LLM APIs and market data providers.
- The database uses WAL mode with daily rotating backups (last 7 retained).
- Auto-save runs every 60 seconds and on page unload.

---

## Settings

All configuration is accessible from the Settings page with no code editing required:

- Anthropic API key (browser-local or server-side proxy)
- Brokerage per trade, maximum trades per day, minimum trade size
- LLM provider for news and debate (Ollama model, Groq, Gemini)
- Compact mode for smaller screens
- Morning briefing schedule (AEST time)
- Telegram bot credentials for off-device alerts
- SBC mode — 20-minute refresh interval and disabled auto-scan for low-power devices (Raspberry Pi, Jetson Orin)
- Recent AI call log — full prompt and response audit trail

---

## Running Tests

```bash
python test_app.py   # 555 backend + integration tests
npm run test:js      # 110 JS unit tests (quant engine, regime classifier, validator)
```
