# Sloth ASX Trader

A local, AI-powered decision-support tool for Australian equity trading. It runs entirely on your own machine — no subscriptions, no cloud database, no data leaving your network except calls to the market-data and AI providers you choose to configure.

> **What it is:** a research and discipline tool. It helps you find trades, size them sanely, manage tax and risk, and — most importantly — learn from how your decisions actually played out.
> **What it is not:** an auto-trader. It never places orders or moves money. Every action is yours.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [How It Works](#how-it-works) — the analysis pipeline and key concepts
3. [A Typical Day](#a-typical-day) — the recommended workflow
4. [Feature Guide](#feature-guide) — every page, and how to use it well
5. [LLM Providers](#llm-providers)
6. [Data & Privacy](#data--privacy)
7. [Settings](#settings)
8. [Tips & Troubleshooting](#tips--troubleshooting)
9. [Running Tests](#running-tests)

---

## Quick Start

**Requirements:** Python 3.9+, pip, and a modern browser.

```bash
pip install -r requirements.txt
python asx_server.py
```

Then open the app one of two ways:
- **Served by Flask (recommended):** browse to **http://localhost:5000** — the whole app is served from the backend on a single origin.
- **From disk:** open `asx_trading.html` directly in your browser. It will talk to the backend on `localhost:5000`.

**Production mode** (multi-worker, recommended for daily use):
```bash
pip install gunicorn
gunicorn -c gunicorn.conf.py 'asx_server:app'
```

**Set your API key:** go to **Settings → API Key** and paste your Anthropic key. It is stored in your browser's `localStorage` and is only ever sent to the Anthropic API. (Prefer it server-side? Enable proxy mode and the key lives in SQLite instead, never touching the browser.)

That's the minimum. Everything else — local LLM, news feeds, Telegram, day trading — is optional and configured from the Settings page.

### First-time checklist
1. **Settings → API Key** — paste your Anthropic key.
2. **Settings → Account** — set your brokerage per trade, max trades/day, and minimum trade size. These feed directly into position sizing and the cash test.
3. **Portfolio page** — add your holdings (or import a CommSec / SelfWealth CSV via **Import**). Tag each holding's account (personal / super / trading) if you run more than one.
4. **Settings → Cash** — set your available cash balance so sizing respects what you can actually deploy.
5. (Optional) **Settings → Display → Use local LLM** to run analysis through a local Ollama model at zero API cost.

---

## How It Works

Every recommendation flows through a **four-layer deterministic pipeline**. The AI only ever supplies qualitative conviction — *what* to do and *why*. All arithmetic (sizing, stops, validation) is done by code, so the same inputs always produce the same numbers.

```
Live signals  →  Regime gate  →  Claude  →  Quant engine  →  Validator  →  UI
(indicators)    (deterministic)   (LLM)     (deterministic)  (deterministic)
```

| Layer | What it does |
|---|---|
| **Signals** | Computes the full technical indicator pack per ticker (RSI, MACD, Bollinger, ADX, ATR, volume, etc.). |
| **Regime gate** | Classifies the market (risk-on / risk-off / high-vol / trend / sideways / panic) from live data, decides which strategies are allowed, scales position sizes, and widens stops in volatile conditions. In a panic regime, new buys are blocked entirely. |
| **Claude** | Provides conviction only — direction, confidence, rationale, and a price target/stop level. It never computes share quantities. |
| **Quant engine** | Sizes the trade deterministically: Kelly fraction × volatility scalar, constrained by account-risk %, max-position %, and liquidity. Rejects negative-expectancy trades before sizing. |
| **Validator** | Checks every recommendation against the schema and business rules, auto-repairing where it safely can. |

**Why this matters:** the AI can be wrong about a thesis, but it can never blow up your sizing, ignore your risk limits, or hand you an unverifiable number. The discipline is enforced in code.

### Key concepts worth understanding

- **The Learning Loop.** Every recommendation is logged and tracked to its outcome. Win rates by confidence band and regime are decay-weighted (recent trades count more, and faster in volatile markets) and fed back into *every* future analysis as compact calibration. Over time the system tells Claude where it has been over- or under-confident.
- **Thesis Tracking.** Each BUY is tagged with *why* you entered (mean-reversion, momentum breakout, trend pullback, fundamental value, or macro tailwind) plus a technical snapshot. When you later sell, the app compares the original thesis against current conditions and records whether it was **validated, invalidated, or irrelevant** — then aggregates this into a Thesis Accuracy Matrix so you can see which entry styles actually pay off for you.
- **Virtual outcomes.** Recommendations you *didn't* execute are still price-checked weeks later, so the calibration isn't biased toward only the trades you happened to take.
- **Regime-aware everything.** Stops, sizing, heat limits, and calibration half-lives all shift with the detected market regime.

---

## A Typical Day

A suggested rhythm for using the app during a trading day:

**1. Morning — get oriented.**
Open the **Dashboard**. The **Morning Briefing** summarises overnight US/global moves, key commodities, AUD/USD, and an ASX outlook with a bullish/bearish score. (You can auto-schedule it for a fixed AEST time in Settings.) Check the current **regime** badge — it tells you what kind of market you're trading into.

**2. Refresh and analyse.**
On the **Recommendations** page, run analysis. The app pulls live signals for your holdings and watchlist, classifies the regime, and asks Claude for BUY / TOP_UP / SELL / TRIM calls — each with confidence, rationale, a sized quantity, stop, and target. SELL/TRIM cards show a **Thesis Check** box: what you bought it for vs. whether that reason still holds.

**3. Act — and record honestly.**
For each recommendation, **Execute** (records the fill, updates your portfolio, CGT parcels, and journal) or **Skip**. Skipping is fine and useful — skipped recs become virtual outcomes that still teach the system.

**4. Manual trades count too.**
Log any trade you made outside the app via the **Journal → Log Trade**. You'll be prompted for an optional thesis, and the app snapshots the live technicals at that moment — so manual trades get reviewed the same way AI trades do.

**5. Monitor.**
Leave it open. Desktop (and optional Telegram) alerts fire for stop-loss proximity, targets hit, drawdown breaches, and high-conviction setups. For day trading, an intraday time-stop alert fires at 15:00 AEST.

**6. Review — close the loop.**
On the **Learning** page, periodically tag closed losses (or run the local debate engine on them), check your calibration accuracy, and read the **Thesis Accuracy Matrix**. This is where the edge compounds: you're not just trading, you're measuring whether your reasons were right.

---

## Feature Guide

### Portfolio
Your holdings across **multiple accounts** (personal / super / trading), each with its own CGT parcel pool so the same ticker in two accounts is never mixed.

- Live prices, unrealised P&L, weight, and sector per holding
- **CGT parcels** with FIFO / LIFO / Max-gain disposal methods, the 12-month discount flag, and **DRP** (dividend reinvestment) parcel support
- **EOFY tax pack** — download CGT disposals and trade fees as CSV for your accountant
- **Stock split** and large **capital return** detection with warnings
- **Broker CSV import** — CommSec and SelfWealth formats auto-detected; buys and sells matched against your parcels

*Use it well:* set the right account on each holding before analysing — sector concentration and CGT logic depend on it.

### Recommendations (AI Analysis)
The core decision surface. Claude (Sonnet 4.6) produces actionable trades only — no filler HOLDs.

- BUY / TOP_UP / SELL / TRIM with confidence, rationale, stop, target, and a deterministically sized quantity
- **Regime-aware** sizing and stops; **anti-churn** 7-day hold gate; **pre-earnings** stop widening within 14 days
- **CGT & franking aware** — respects the discount window, tax-loss season, and franking capture
- **Entry/exit thesis tagging** for the learning loop
- **Rules tab** — edit the active analysis rules (risk %, min confidence, etc.) with no code changes

*Use it well:* read the rationale and risks, not just the confidence number. Execute or Skip every card — both outcomes feed learning.

### Local LLM Mode
Flip **Settings → Display → Use local LLM** to route portfolio analysis through a local Ollama model at **zero API cost**. Recommendations carry a 🔒 Local badge. Full Claude analysis stays available whenever you want it.

### Day Trading
- **Swing (5–15 day holds):** scans the ASX 20/50/100/200 universe by Bollinger position, liquidity, SMA200 proximity, and trend strength, then sends top candidates to Claude for conviction.
- **Intraday (same-day, 5-min bars):** monitors VWAP, intraday RSI, and volume acceleration; setups are only actionable in the 10:45–15:00 AEST window, with a 15:00 time-stop alert.

Both use the same deterministic sizing (Kelly, vol scalar, account-risk %, liquidity cap). Thresholds are editable at runtime in each page's **Rules** tab.

### Live Signals & Watchlist
Full per-ticker technicals: momentum (RSI 9/14, MACD, Stochastic, Williams %R, CCI), volatility (Bollinger, ATR, Keltner, Donchian), volume (OBV, MFI, VWAP, volume Z-score, 20-day ADV), trend (ADX, ±DI, SMA crossovers, composite score), plus a 10-year **seasonality** pattern. The **Watchlist** monitors tickers you don't hold, with the same indicator alerts (RSI thresholds, BB breakout/breakdown, volume spikes).

### Market Scanner
Batch-rank the ASX universe by composite technical score.
- **Opportunities** — ranked candidates with signals and sector
- **Technical Screener** — parametric filter across the indicator set
- **Compare** — side-by-side indicators for two or more tickers
- **Factor Stability** — empirical information-coefficient analysis to tune scoring weights
- Save named screener presets for reuse

### Risk Dashboard
- Per-holding beta (vs VAS.AX), annualised vol, Sharpe, VaR/CVaR 95%, max drawdown
- Portfolio correlation heatmap and sector-concentration warnings (>25% amber, >40% red)
- **Target allocations** with one-click rebalance suggestions (deterministic BUY/TRIM, with CGT-discount-at-risk warnings)
- **Heat budget** — caps total capital at risk to stops as a % of the portfolio; tightens automatically by regime

### Performance & Backtesting
- Realised P&L, win rate, average win/loss, sector attribution
- NAV history and drawdown monitor
- Strategy backtesting with flat or liquidity-adjusted slippage
- Walk-forward validation for out-of-sample testing
- **AI replay** — score how the AI's historical signals would have played out

### Learning Loop
The system's memory. Every rec is tracked to outcome and fed back as calibration.
- Confidence-band accuracy with decay-weighted win rates and Wilson confidence intervals
- Regime-adaptive calibration (shorter memory in volatile markets)
- Virtual-outcome resolution for unexecuted recs
- Sell-tag accuracy — did exits actually turn out justified?
- **Thesis Accuracy Matrix** — entry driver × outcome verdict × average P&L
- Persistent **trading lessons** scoped by ticker, sector, regime, or breadth
- Local **Ollama debate engine** — trade postmortems, skill scoring, and adversarial two-model argument, with an optional cloud adjudicator
- **Trade Review drawer** — on the Journal page, expand any transaction (AI *or* manual) to see the entry technicals, thesis, drivers, verdict, and outcome side by side

*Use it well:* tag your losses honestly and read the matrix monthly. The calibration is only as good as the outcome data you give it.

### News & Announcements
- RSS aggregator with TF-IDF deduplication across feeds, and LLM sentiment classification per article
- ASX company announcements with PDF text extraction, a price-sensitive filter, and a **Key Figures** panel that pulls out the headline numbers
- Materiality scoring via Gemini or a local model

### Alerts & Notifications
- **Notification centre** (bell button) captures every toast, alert, and error in a dedicated `notifications.db` with a paginated log
- **Desktop notifications** for stop proximity, targets, drawdown, and high-conviction setups
- **Telegram** off-device push (credentials stored server-side, never logged)

---

## LLM Providers

| Provider | Used for | Required? |
|---|---|---|
| **Anthropic Claude Sonnet 4.6** | Portfolio analysis, recommendations, day trading, macro brief, assistant | **Yes** (for core analysis) |
| **Google Gemini** | Announcement scoring, debate adjudication | Optional |
| **Groq** | Fast news classification, debate adjudication fallback | Optional |
| **Ollama (local)** | News classification, trade debate, postmortems, local portfolio analysis (no API cost) | Optional |

Only the providers you configure are used. Anthropic is the only key required for core functionality; everything else degrades gracefully when absent.

---

## Data & Privacy

- **All data is local.** Portfolio, trades, recommendations, and settings live in SQLite (`asx_trader.db`). Notifications have their own `notifications.db`; day-trade ML history lives in `day_trade_history.db`.
- **Market data** comes from yfinance (free, no key), with Stooq as a fallback.
- **No telemetry, no cloud sync.** The only outbound connections are to the LLM and market-data providers you configure.
- The database uses **WAL mode** with daily rotating backups (last 7 retained). Auto-save runs every 60 seconds and on page unload.
- Your API key is never written to logs or the save payload. Telegram credentials are stored server-side only.

---

## Settings

Everything is configurable from the Settings page — no code editing:

- Anthropic API key (browser-local or server-side proxy)
- Brokerage per trade, max trades/day, minimum trade size
- Cash balance and term-deposit tracking
- LLM provider for news/debate (Ollama model, Groq, Gemini)
- **Theme** (Auto / Light / Dark) and **Compact mode** for smaller screens
- Morning briefing schedule (AEST)
- Telegram bot credentials
- Heat budget and drawdown alert thresholds
- **SBC mode** — 20-minute refresh and disabled auto-scan for low-power devices (Raspberry Pi, Jetson Orin)
- Recent AI call log — a full prompt + response audit trail

---

## Tips & Troubleshooting

- **Save on API cost:** turn on local LLM mode for routine portfolio analysis and reserve Claude for high-stakes decisions.
- **Mobile / remote read-only:** the app is served on a single origin, so it works behind an ngrok tunnel without config changes — handy for checking positions from your phone during the day.
- **Low-power box:** enable SBC mode to slow refreshes and avoid background scans.
- **"Page crashed" card:** a render error was caught by the error boundary; the stack is in the browser console. Reload the page.
- **Stale prices / missing data:** the app falls back from yfinance to Stooq automatically; a `_source: stooq` flag and a stale-data badge (>25 min) tell you when live data is degraded.
- **Don't see a recommendation you expected?** In a panic regime, new buys are blocked by design; and any trade with non-positive expected value is rejected before sizing.
- **Numbers feel conservative:** check the heat budget (Risk page) and the regime — both can be deliberately throttling new exposure.

---

## Running Tests

```bash
python test_app.py   # 682 backend + integration tests
npm run test:js      # 154 JS unit tests (quant engine, regime classifier, validator, thesis drift)
```

The Python suite covers every backend route, the learning-loop logic, and source-level invariants for the frontend. The Vitest suite exercises the pure deterministic engines (sizing, regime classification, schema validation, thesis-drift) in isolation.
