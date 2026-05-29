# Sloth ASX Trader — Improvement Roadmap (Personal Use)
**Last Updated:** 2026-05-29 (Sprints 17–18 shipped)

> **Scope:** This is a **private, single-user, local** decision-support tool. It is *not* a public
> product — so multi-user auth, tenant isolation, financial-services licensing, ToS/Privacy, and
> data-**redistribution** licensing are explicitly **out of scope**. Improvements here focus on
> three things that matter for your own trading: **signal accuracy**, **reliability/data quality**,
> and **useful features** that make day-to-day trading decisions faster and more disciplined.

Each item carries an effort (S/M/L/XL) and impact (★–★★★) rating for triage.

---

## 0. Shipped — 2026-05 sprints (through Sprint 18)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Monthly seasonality card** | Research (§2.4) | `GET /api/seasonality/<ticker>` (24 h TTL). Fetches 10yr monthly price history, computes avg/min/max return and win-rate per calendar month. Signals page detail view shows a 12-bar horizontal chart with current month highlighted and per-bar tooltips. `window._seasonalityCache` stores results for the session. |
| **Error recovery + retry buttons** | UX (§3.4) | `_retryBtn(label, onclick)` and `_emptyCard(icon, title, body, actions)` helpers added to `utils.js`. `risk.js` now shows an amber error banner + retry button when yfinance is rate-limited instead of silently showing blank metrics. `performance.js` equity curve section shows an error card + retry on `nav-history` failure instead of silently hiding the chart. `portfolio.js` no-holdings state upgraded to an actionable first-run card with "Import Broker CSV" and "Add Trade Manually" CTAs. |
| **Split CGT auto-adjust** | Workflow (§1.9) | When the existing split-warning banner appears on Portfolio page, each split now has an "Apply split" button. `applySplitAdjustment(ticker, ratio, date)` multiplies `holding.shares` and all open CGT parcel `qty`/`remainingQty` by the ratio, divides `avgPrice` and `costPerShare`, then dismisses the warning and saves state. One-confirm guard prevents accidental double application. |

---

## 0a. Shipped — 2026-05 sprints (through Sprint 14)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Direction-aware `_detectExitReason`** | Learning Loop | SELL/TRIM recs frame the stop *above* and target *below* entry (the inverse of BUY/TOP_UP). The classifier assumed a long frame for everything, mislabeling profitable trims as `stop_hit`. **51% (37/72) of closed events were contradictory.** Now flips comparisons on `action`; fixed in both `recommendations.js` and `performance.js`; covered by `test_detect_exit_reason_direction_aware`. |
| **Per-entry parent reconciliation** | Learning Loop | On a full-position close, each parent BUY/TOP_UP event is judged against *its own* entry and stop/target, not the closing SELL's blanket outcome. |
| **Removed invalid `^XJOA` macro fetch** | Data layer | Not a real Yahoo symbol → 404 every 5-min refresh, and `advance_decline_ratio` was permanently `null`, so the regime breadth vote never fired. Removed; documented as dormant until a real breadth source is wired. |
| **Historical data backfill** | Data | Recomputed `exit_reason` for 72 closed events with corrected logic (66 updated; contradictions 37 → 9). DB backed up first. |
| **Automated daily DB backups** | Reliability (§3.2) | `db.py::backup_db()` copies DB to timestamped file on startup and every 24 h; keeps last 7 copies. Background daemon thread in `asx_server.py`. |
| **HTML-escape external text** | Security (§3.6) | Added `escapeHTML()` to `utils.js`; applied to `item.title`, `item.summary`, `item.content` (news), `headline`, `summary` (announcements), `r.reasoning`, `r.risks` (recommendations). Prevents layout breakage from hostile RSS/AI text. |
| **Wilson 95% CI on Learning Loop stats** | Accuracy (§1.3) | `_wilson_ci()` in `routes/learning.py`; `ci_lo`/`ci_hi` now returned on all win-rate fields. Calibration engine gated at n<30 (returns `available:False`). Learning page shows CI columns and calibration status. |
| **Calibration sample-size gate** | Accuracy (§1.3) | `_calib_compute` returns early if fewer than 30 closed events — prevents calibration from chasing noise in early-stage data. |
| **CGT discount urgency banner** | Tax (§2.2) | CGT page shows a yellow banner listing any profitable parcel within 45 days of the 12-month mark. Recommendations page `_showPreTradeChecklist` includes a CGT warning when selling with days-to-discount < 45. |
| **Pre-trade checklist modal** | Workflow (§2.6) | Five-item discipline gate fires before `markExecuted`. Requires ≥ 4 ticks to enable "Execute", with override available. No DB change — ephemeral. |
| **Trade tags field** | Workflow (§2.6) | `tags` and `trade_thesis` columns added to `ai_learning_events` via `_LE_MIGRATIONS`; accepted by `/api/learning/log` and `/api/learning/outcome`; inline tags input added to each rec card. |
| **Portfolio heat gauge** | Risk (§2.5) | Risk page now shows total $ at risk to stop vs a user-configurable budget (default 5% of portfolio). Colour-coded bar: green < 60%, orange < 85%, red ≥ 85%. Budget editable inline. |
| **Slippage modelling in backtest** | Accuracy (§1.2) | `routes/backtest.py` now applies entry fill = `price × (1 + slippage_pct)` and exit fill = `price × (1 - slippage_pct)`. Equity curve updated. Response includes `slippagePct`, `totalBrokerageCost`, `totalSlippageCost`. UI: slippage % input + friction cost breakdown panel in `js/pages/backtest.js`. |
| **yfinance retry + stale-cache fallback** | Reliability (§3.1) | `fetch_with_retry()` in `core.py` with exponential backoff and `_last_good` stale-cache per key. Quote and macro endpoints now use it. |
| **Data-staleness badge** | UX (§1.10) | Quote endpoint stamps `fetched_at` (UTC ISO). `prices.js` stores timestamps per ticker in `state.priceTimestamps`. Portfolio table shows `⚠ stale` badge when data is >25 min old. |
| **Brier score + reliability diagram** | Accuracy (§1.4) | `GET /api/learning/calibration-stats` returns `brier_score` (MSE of confidence vs outcome) and per-band calibration bins. Learning page shows a Brier score metric card + CSS bar reliability diagram. |
| **Telegram off-device alerts** | Alerts (§2.3) | `routes/alerts.py` with `POST /api/alerts/telegram` (send), `POST /api/alerts/telegram/save` (persist creds), `GET /api/alerts/config`. Settings page has a Telegram section (bot token + chat ID + Test button). `fireAlert()` in `alerts.js` mirrors to Telegram when `state.settings.telegramEnabled`. |
| **Drawdown monitor** | Risk (§2.5) | `renderPerformance()` now computes current and max drawdown from `state.portfolioHistory`. Two new metric cards + a red alert banner when drawdown exceeds the configurable threshold (default 10%). Threshold editable inline. |
| **Broker CSV import (CommSec + SelfWealth)** | Workflow (§2.6) | `routes/import_csv.py` with `POST /api/import/csv` — detects CommSec/SelfWealth/generic format, normalises to `{action, ticker, shares, price, date, brokerage}`. Portfolio page has a "Broker CSV" upload button; `handleBrokerCSV()` applies returned rows to portfolio, CGT parcels, and journal. |
| **Watchlist page** | Features (§2.1) | `js/pages/watchlist.js` — separate from holdings. `state.watchlist = [{ticker, addedAt, notes}]`. Signal table (RSI, score, BB%B, trend), indicator-alert creation UI, scanner ⭐ button writes to both watchlist and `extraTickers`. Persisted in `blob_store`. |
| **Benchmark overlay (^AXJO)** | Analytics (§2.1) | `GET /api/benchmark?period=` in `routes/market.py`. `drawHistoryChart()` now async with cached `_benchmarkCache`. ^AXJO normalized to portfolio start value; grey dashed 4th series + legend entry. |
| **Custom indicator alerts** | Alerts (§2.3) | `checkIndicatorAlerts()` in `alerts.js`; types: `rsi_below`, `rsi_above`, `bb_breakout`, `bb_breakdown`, `volume_spike`; called after `fetchSignals()`. Watchlist page has an indicator-alert creation UI. |
| **Ex-div & earnings reminders** | Alerts (§2.3) | `checkExDivReminders()` / `checkEarningsReminders()` in `prices.js`; one-shot per event per day. 5-day ex-div window, 3-day earnings window. |
| **Macro / regime-change alert** | Alerts (§2.3) | `fetchAndClassifyRegime()` fires `fireAlert()` when regime flips to `panic` or `riskOff`. |
| **Tax-loss harvest planner** | Tax (§2.2) | Card on CGT page: ranks open parcels by unrealised loss, shows max harvestable, net CGT after harvest, EOFY countdown, wash-sale warning (same ticker bought in last 30 days). |
| **Scenario stress test** | Risk (§2.5) | Card on Risk page: -5/-10/-20/-30% shock presets + custom input. Per-holding impact = `value × beta × shock`. Shocked portfolio summary. `window._stressScenario` persists across renders. |
| **ATR trailing stops** | Risk (§2.5) | Card on Risk page below stress test: 2×ATR14 stop per holding; one-click "Set Alert" wires into price-alert system. |
| **Saved screener presets** | Research (§2.4) | `state.savedScreeners = [{name, savedAt, config}]`; ⊕ Save/Load/Delete in scanner config bar. Persisted in `blob_store`. |
| **Market breadth revival** | Accuracy (§1.8) | Scanner computes `breadth_ratio` (% universe > 20-day SMA) after each scan; `/api/macro` reads it via lazy import as `advance_decline_ratio`; regime breadth vote now fires. |
| **Postmortem digest** | AI (§2.7) | `GET /api/learning/digest-data` returns structured failure stats. "Generate Digest" button on Learning page calls `callClaude('assistant', …)` with failure patterns to produce actionable lessons. |
| **Morning briefing auto-generate** | AI (§2.6) | `MORNING_BRIEFING_SYSTEM_PROMPT` + `'briefing'` agent type (600 tokens, no-cache). Dashboard "Generate Brief" button chains macro + regime + holdings into a plain-text session note cached in `window._morningBrief`. |
| **EOFY tax pack** | Tax (§2.2) | `GET /api/tax/eofy-pack?year=N` returns ZIP: `cgt_disposals_FY{N}.csv` + `trade_fees_FY{N}.csv`. "↓ EOFY Pack" button on CGT page. |
| **Regime overlay on journal** | Analytics (§2.4) | `_journalRegimeBadge()` helper + `Regime` column per row in Trade Journal; matches via `state.recHistory.find(r => r.id === t.recId)?.regime`. |
| **Stale-position nudge** | Workflow (§2.3) | `_buildStaleNudgeCard()` on Dashboard: amber card listing holdings with no rec in 14+ days with day counts. |
| **Persistence bug fix (watchlist/savedScreeners)** | Reliability | `watchlist` and `savedScreeners` were in the save payload but missing from `BLOB_KEYS` in `routes/portfolio.py` and the `db_load` response — silently discarded on every restart. Fixed. |
| **Portfolio-aware Q&A** | AI (§2.7) | `sendChat()` in `assistant.js` now injects `state.currentRegime` (regime + confidence + signals) and `state.macroData` (ASX200, VIX, AUD/USD, sentiment, bullish%) into the system prompt's `MARKET REGIME` + `MACRO DATA` sections. |
| **Performance attribution** | Analytics (§2.4) | `_buildAttributionCard(closedTrades)` added to `performance.js`: two side-by-side tables — P&L by sector (from holding.sector) and P&L by regime at entry (matched via recId → recHistory.regime). |
| **Sector concentration warning** | Risk (§2.5) | `_sectorConcentrationWarning(rec)` in `recommendations.js`: amber/red badge on BUY rec cards when the rec's sector already > 70% of the sector concentration limit in the portfolio. Uses `state.portfolio[i].sector` — no backend call. |
| **Thesis capture** | Workflow (§2.6) | Thesis textarea added to each rec card; captured at `markExecuted` and stored as `rec._thesis`; passed to learning loop as `trade_thesis`; persisted in `histEntry._thesis`; shown as tooltip (📋) on journal "Rec: Yes" badge. |
| **Dividend income forecast + franking credits** | Tax / Analytics (§2.2) | `_buildDivForecastCard()` in `performance.js`: per-stock 12-month income, grossed-up income (100% franked at 30% corp tax), franking credits, frequency, yield on cost. Portfolio totals: cash income + grossed-up + franking credit estimate. |
| **Thesis review at exit** | Workflow (§2.6) | `_showThesisReview()` in `recommendations.js`: `<dialog>` modal fires when a position fully closes; shows the original entry thesis; three verdict buttons (Held / Partial / Broken) post to `/api/learning/outcome` with a `[THESIS: …]` notes tag for postmortem analysis. |
| **Prompt version P&L** | Analytics (§2.1) | `routes/learning.py` stats query now sums `realized_pnl_aud` per prompt version; Learning page Prompt Version History table gains a "Realised P&L" column (green/red). |
| **Target allocations + drift alerts** | Risk (§2.5) | `state.targetAllocations = {}` (ticker → target weight %); `_buildTargetAllocCard()` on Risk page shows Actual% vs Target% with inline edit inputs; amber when |drift| ≥5%, red when ≥10%. Persisted in `blob_store` via `targetAllocations` in `BLOB_KEYS`. |
| **Economic calendar** | Workflow (§2.6) | `_buildEconomicCalendarCard()` on Dashboard: 45-day forward window with hard-coded RBA meeting dates (2026–2027), ex-div dates from `state.dividendData`, and earnings dates from `state.earningsCalendar`. |
| **Franking 45-day rule** | Tax (§2.2) | `_buildFranking45DayCard()` on CGT page: iterates open parcels, checks each against its ex-div date; warns when the 45-day continuous-holding requirement around the ex-div date is at risk of not being met. |
| **A-VIX proxy** | Analytics (§2.4) | `asx_vol_20d` (20-day realized annualized vol of ^AXJO) added to `/api/macro` payload; displayed as "A-VIX (ASX 20d)" in the Macro page Market Risk card; feeds two new votes into `regime-engine.js` (>25% → highVol, <12% → riskOn). |
| **Cash & term-deposit tracker** | Workflow (§2.6) | `state.termDeposits = []` persisted in `blob_store`; `_buildCashTrackerCard()` on Dashboard shows idle cash + each TD with maturity countdown; computes "Deployable ≤30d" total; `addTD()` / `removeTD()` helpers. |
| **Exact correlation-aware sizing** | Risk (§2.5) | After Claude generates BUY recs, `analysis.js` fetches `/api/risk` with portfolio + rec tickers; reduces `qty`/`riskAUD` by 30% when |corr| > 0.7 or 50% when > 0.85 with any existing holding; annotates rec with `_corrNote`; shown as ⚡ Corr badge on rec cards. |
| **Macro endpoint perf** | Reliability (§3.4) | `_macro_payload()` refactored: `^AXJO` fetched once at `period="3mo"` in the parallel block (previously fetched separately at 5d + 3mo = 2 serial calls); `AUDUSD=X` and `TIO=F` fetched at `period="1mo"` so 5d-change is computed from cached history (eliminates 2 more serial calls). Net: 3 serial yfinance fetches removed. |
| **Keyboard shortcuts** | UX (§4) | `g`+letter page navigation added to `navigation.js` (IIFE); covers 14 pages. `?` toggles a `<dialog>` shortcut help panel. Shortcuts are suppressed when focus is in an input/textarea. |
| **Prompt + response logging** | Debug/Audit | `ai_call_log` DB table. Every `callClaude()` call auto-logs: agent_type, model, system_prompt (8k cap), user_message (30k cap), response, tokens (in/out/cache_read/written), duration_ms. File output enriched with prompt header. New `GET /api/log/ai_calls` + `GET /api/log/ai_call/<id>` browse endpoints. Settings page "Recent AI Calls" card with agent filter + modal viewer. |
| **Side-by-side ticker compare** | Research (§2.4) | New `js/pages/compare.js`. Up to 4 ASX tickers. Score bar chart + full indicator table (RSI, MACD, BB%B, ATR, Stoch, CCI, ADX, MFI, OBV, SMA20/50, 1w/1m/3m returns, buy/sell signals). Color-coded cells. Navigate: g+x, ↔ Compare nav button. Watchlist ↔ button pre-loads watchlist into compare inputs. |
| **Prompt version A/B delta** | AI (§2.7) | Learning Loop prompt version table now has Δ vs prev column: shows win-rate delta (pp) with ↑/↓/↔ arrow; greyed out when either version has <3 closed events. Current version highlighted with indigo "current" badge. |
| **ETF filter for earnings calendar** | Reliability | `_fetch_earnings` checks `quoteType` from yfinance info; returns `{skipped:'ETF'}` for ETF/MUTUALFUND/MONEYMARKET — eliminates 404 log noise without a fragile static ticker list. |
| **App Info card in Settings** | UX (§4) | Shows `PROMPT_VERSION`, `CLAUDE_MODEL`, server version/uptime, last DB backup date. `GET /health` now returns `version`, `uptime_s`, `last_backup`. |
| **Forming-bar guard** | Data quality (§1.1) | `_drop_forming_bar(hist)` in `indicators.py` drops the current-day daily candle before 07:00 UTC (ASX close + 45-min settlement). Prevents incomplete intraday bar from inflating RSI/MACD/vol during market hours. Called in `analyse_ticker()` after every yfinance/Stooq fetch. |
| **Stooq fallback data provider** | Reliability (§3.1) | `_fetch_stooq_history(ticker, period)` in `indicators.py`. When yfinance returns empty or < 30 bars, retries via `https://stooq.com/q/d/l/?s=bhp.au&i=d` (free, no key). Ticker conversion: `BHP.AX` → `bhp.au`. Returns same OHLCV schema. Uses `_HTTP_SESSION` from `core.py`. |
| **Stop-proximity pre-warning** | Alerts (§2.3) | `checkStopProximityAlerts()` in `alerts.js` fires a `fireAlert()` + `toast()` when price is within `state.settings.stopProximityPct` % (default 3 %) of a stop, BEFORE the stop is breached. Direction-aware: BUY checks `(price − stop) / price`; SELL/TRIM inverts. One-shot via `_proximityAlertedAt`; re-arms when price retreats to 2× threshold. Called from `prices.js` after every price refresh. Configurable in Settings (0 = disable). |
| **Position age + unrealised P&L enrichment** | AI accuracy | `_daysHeld(ticker)` helper in `analysis.js` queries `state.tradeJournal` for the earliest open BUY/TOP_UP. Both `daysHeld` and `unrealisedPnlPct` now included in `portfolioJson` sent to Claude — enabling time-aware recommendations ("held 60 days at −8%"). |
| **ASX100 intraday same-day strategy** | Features | New `routes/intraday.py` + `js/intraday-strategy.js`. Scans ASX100 5m intraday bars for VWAP-discounted, RSI-oversold setups; composite score 0–100; hard gate 10:45–15:00 AEST only. New ⚡ Intraday tab in Day Trading page with configurable target % (default 3.5%), stop % (1.5%), max 2 positions. Open positions tracker with live P&L. `checkIntradayCloseouts()` fires time-stop alert at 15:00 AEST. `POST /api/intraday/scan` (batch, 8 threads, 2-min TTL); `GET /api/intraday/<ticker>` (single). |
| **Intraday universe selector + scan hardening** | Features / Reliability | Intraday tab now has universe switcher buttons (ASX20 / ASX50 / ASX100 / ASX200) stored as `state.intraday.params.universeKey`. Removed delisted `IPL.AX` from all universe lists; replaced with `WGX.AX`. Scan switched from `pool.map` to `as_completed` with 8s per-ticker timeout and 15 workers — stale/slow tickers no longer block the entire batch. |
| **Compare tab moved into Market Scanner** | UX | ↔ Compare is now the third tab inside Market Scanner (alongside Opportunities and Screener) rather than a standalone sidebar page. `showPage('compare')` in `navigation.js` transparently redirects to the Scanner and sets `_scannerTab='compare'`; keyboard shortcut g+x unchanged. `compareFromOutside()` still works from Watchlist and other pages. |
| **Groq/Gemini API keys consolidated to Settings** | UX | Moved Groq and Google Gemini API key inputs from News Scanner LLM card and Announcements LLM Settings panel into Settings → API Keys section. News/Announcements show status badge + "Manage key in Settings" link. `_saveNewsSettings()` used cross-page (script load order safe). |
| **Debate Phase 3: neutral synthesis** | AI Quality | Replaced one-sided challenge round (Model A defending its own tags against Model B's critique) with a neutral synthesis pass: a single call presenting both models' tags and reasons equally, asking for the best reconciliation. `source` label changed to `debated-synthesis`. Root-cause tag guidance added to `_pm_build_prompt()`. Learning page Phase 3 display updated. |
| **TRIM/SELL ATR stop floor** | Accuracy | `analysis.js` post-processes SELL/TRIM recs after the quant engine: if `stopLoss − entry < 1.5 × ATR_14`, auto-repairs to `entry + 2.5 × ATR`. Prevents near-zero stop distances (e.g. +0.2% = 60:1 R:R) from the AI. Rec flagged with `_stopRepaired: true`. |
| **Intraday Extreme Mode** | Features | New toggle in ⚡ Intraday config card bypasses entry-window (10:45–15:00 AEST), VWAP and RSI gates for testing outside market hours. Only `minScore` threshold still applied (configurable). Stored as `state.intraday.params.extremeMode`. |
| **Intraday universe buttons + params render dynamically** | UX | `updateIntradayParam()` now calls `renderPage()` after saving, so clicking universe buttons (ASX20/50/100/200), changing config inputs, and toggling Auto-refresh visually update immediately without a full page reload. |
| **§1.1 Look-ahead bias: AI Replay fixed, backtest documented** | Accuracy (§1.1) | **AI Replay** (`/api/backtest/ai-replay`): switched from `auto_adjust=True` to `auto_adjust=False` — forward exit prices are now nominal (unadjusted), matching the basis of actual executed entry prices. Previously, dividend-adjusted exit prices vs nominal entry prices understated BUY returns by ~div_yield per period and overstated SELL/TRIM returns. **Strategy Backtest**: signal timing (RSI, MACD, BB, ADX) is NOT affected (all are scale-invariant); P&L reflects total return (capital gains + notional dividend reinvestment). Both endpoints now emit `priceBasis` + `priceBasisNote` metadata. Backtest UI shows a disclosure banner explaining total-return basis; trade log price columns labelled "(adj.)". `indicators.py` `analyse_ticker` and `_fetch_stooq_history` document why `auto_adjust=True` is correct for live signal generation. |
| **Compact/density mode** | UX | `.compact` CSS body class reduces card padding, table row heights, and button sizes. Toggle in Settings → Display. Applied on startup from `state.settings.compactMode`. |
| **In-app changelog** | UX | Settings → "What's New" panel shows collapsible sprint history (Sprints 9–13, most recent open by default) without leaving the app. |
| **Macro page loading state** | UX | `fetchRealMacro()` sets `window._macroFetching=true` and calls `renderPage()` before the fetch — button goes disabled + "fetching…" and a spinning skeleton card appears. `finally` block clears flag and re-renders. |
| **Corporate-actions split detection** | Data quality | New `GET /api/portfolio/splits-check?tickers=...` endpoint in `routes/portfolio.py` — uses `yf.Ticker.splits` to find any split in the last 90 days. Portfolio page shows an amber warning card listing affected tickers when splits are found. `checkPortfolioSplits()` fires once per page load (cached in `state._splitWarnings`). |
| **Liquidity-scaled slippage** | Accuracy (§1.2) | Backtest now supports `slippage_mode: 'liquidity'` in addition to `'flat'`. ADV-tiered rates: >$10M ADV→0.05%, $2–10M→0.10%, $0.5–2M→0.20%, <$0.5M→0.35%. Per-ticker `effectiveSlippagePct` returned in `ticker_results`. UI: radio buttons "Flat / Auto (ADV-tiered)"; hides flat slider when auto selected; per-ticker slip% column in results table. |
| **Signals page: full candlestick chart** | UX | Upgraded per-ticker sparkline → full OHLCV candlestick chart reusing `drawCandleChart` from `charts.js`. Candle/Line mode toggle + BB and SMA50 overlays, stored per-ticker in `_sigChartOpts`. Canvas height 180→280px for volume strip and labels. |
| **Journal: monthly P&L bar chart** | Analytics | `_buildMonthlyPnlCard()` draws a canvas bar chart of monthly realised P&L (last 18 months). Green/red bars on a zero baseline with Y-axis grid. Summary stats: winning/losing months, best/worst month. Shown above the filter bar when ≥2 months of data exist. |
| **Portfolio: sector sidebar** | Analytics | Replaced canvas donut with `_buildSectorSidebar()` — CSS grid (`1fr 220px`) places a sector + per-holding sidebar to the right of the Holdings table. Sector bars width-scaled to the largest sector; per-holding bars show weight %. Pure CSS, no canvas. |
| **Learning Loop table alignment** | UX | Fixed actions column misalignment: `_slot(w, html)` helper creates fixed-width `inline-flex` containers for every button position (skill badge 28px, skill btn 26px, PM/vs/Tr/AI each 26px, delete 20px). All rows identical width regardless of which buttons are conditionally absent. `🔬 Sk` header given phantom 28px spacer to align over button slot. `_iconBtn` sub-labels use `color:var(--text-secondary)` — were invisible (black) in dark theme. |

---

## 1. Accuracy & model quality

Make the signal itself trustworthy. These guard against the classic ways a backtest or a
self-tuning loop quietly flatters itself — which for a personal tool means *not fooling yourself*.

### ✓ 1.1 Eliminate look-ahead bias — `M` · ★★★ **SHIPPED**
AI Replay now uses `auto_adjust=False` (nominal prices, matching actual executed prices).
Strategy Backtest keeps `auto_adjust=True` (total-return basis; scale-invariant indicators unaffected)
with a UI disclosure banner and "(adj.)" column labels. `indicators.py` documents why
`auto_adjust=True` is correct for live analysis. See §0.

### ✓ 1.2 Transaction-cost & slippage modelling — `M` · ★★★ **SHIPPED**
Backtest supports `slippage_mode: 'liquidity'` with ADV-tiered rates (>$10M→0.05%, $2-10M→0.10%,
$0.5-2M→0.20%, <$0.5M→0.35%). Per-ticker `effectiveSlippagePct` in results. UI has Flat / Auto radio
buttons with conditional flat slider. See §0.

### ✓ 1.3 Statistical rigour on the Learning Loop — `M` · ★★★ **SHIPPED**
Wilson 95% CI now appears on all win-rate cells; calibration gated at n<30. See §0.

### ✓ 1.4 Confidence-calibration validation — `M` · ★★★ **SHIPPED**
Brier score + reliability diagram in `GET /api/learning/calibration-stats`. Learning page shows the
Brier score metric card and a CSS bar diagram (actual win rate vs predicted confidence, per bin). See §0.

### 1.5 Survivorship bias in the universe — `L` · ★★
`ASX_UNIVERSE` is *today's* constituents; backtests over it silently exclude delisted/relegated names
and overstate returns. Use point-in-time membership for honest historical tests.

### ✓ 1.6 Overfitting guard on `_score_ticker` weights — `L` · ★★ **SHIPPED Sprint 21**
K-fold cross-validation of the eight `_score_ticker` signal factors. Each factor's Information
Coefficient (Spearman rank correlation with N-bar forward return) is measured in-sample and
out-of-sample. Stability ratio = OOS IC / train IC — < 30% or sign-flip flagged as overfitted.
New `POST /api/scanner/factor-stability` endpoint; **Factor Stability** tab in Market Scanner.
Weighted OOS IC summary + per-factor verdict (stable/marginal/weak/overfitted/noise).

### ✓ 1.7 Walk-forward backtesting engine — `XL` · ★★★ **SHIPPED Sprint 20**
Rolling train/test split + per-fold parameter grid-search (Sharpe-optimised in-sample, applied
out-of-sample). New `POST /api/backtest/walk-forward` endpoint; new **Walk-Forward** tab in the
Backtest page. Supports rsi_trend, macd, bb_reversion, momentum strategies. Fold-by-fold table
(best params, train Sharpe, test return) + stitched OOS equity curve + B&H benchmark comparison.
`_run_strategy_slice` helper refactors strategy logic into a single parameterised function used by
both the grid-search and the final OOS evaluation.

### ✓ 1.8 Revive market-breadth signal — `M` · ★★ **SHIPPED**
Scanner computes `breadth_ratio` (% of universe above 20-day SMA) after each scan; `/api/macro` reads
it via lazy import as `advance_decline_ratio`; regime engine breadth vote now fires. See §0.

### 1.9 Corporate-actions correctness — `M` · ★★
Splits, special dividends, capital returns, mergers affect holdings, average price, and **CGT
parcels**. A missed 1:5 split silently corrupts P&L and tax output — verify these reconcile.

### ✓ 1.10 Data-staleness guards — `S` · ★★ **SHIPPED**
`fetched_at` stamped on quote responses. `⚠ stale` badge in portfolio table when >25 min. See §0.

---

## 2. New features & usefulness  ← the main ask

Concrete, ASX-and-personal-trading-specific features. Grouped by theme. Most build on engines that
already exist (quant, regime, learning, dividends, CGT).

### 2.1 Portfolio management

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Watchlist** (separate from holdings) | S | ★★★ | **SHIPPED** — `js/pages/watchlist.js`, `state.watchlist`, scanner ⭐ integration. See §0. |
| **Target allocations + drift alerts** | M | ★★ | Set a target weight per holding/sector; flag when drift exceeds a band and suggest a rebalance trade list. |
| **Multiple portfolios / accounts** | M | ★★ | Separate super vs personal vs trading accounts (still single-user) with combined and per-account views — affects CGT and sizing. |
| **Cash & term-deposit tracker** | S | ★★ | Track idle cash + TD maturities so the dashboard shows true investable cash and prompts deployment. |
| ✓ **Performance attribution** | M | ★★ | **SHIPPED** — `_buildAttributionCard()` in `performance.js`: P&L by sector and by regime at entry. See §0. |
| ✓ **Benchmark comparison** | S | ★★ | **SHIPPED** — ^AXJO overlay on Value History canvas; normalized to portfolio start value. See §0. |

### 2.2 Tax & income (ASX-specific)

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **CGT-discount countdown** | S | ★★★ | **SHIPPED** — urgency banner in CGT page + sell warning in checklist. See §0. |
| ✓ **Tax-loss-harvest planner** | M | ★★★ | **SHIPPED** — card on CGT page; ranks losers by unrealised loss; EOFY countdown; wash-sale flag. See §0. |
| ✓ **Dividend income forecast + franking credits** | M | ★★ | **SHIPPED** — `_buildDivForecastCard()` in `performance.js`: per-stock income, grossed-up at 30% corp tax, franking credits, frequency, yield on cost. See §0. |
| **Franking-credit optimiser (45-day rule)** | M | ★★ | Flag the 45-day holding rule for franking eligibility; identify parcels approaching or failing the threshold. |
| ✓ **EOFY tax pack** | S | ★★ | **SHIPPED** — `GET /api/tax/eofy-pack?year=N` ZIP download: CGT disposals CSV + trade fees CSV. See §0. |

### 2.3 Alerts & monitoring

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Custom indicator alerts** | M | ★★★ | **SHIPPED** — `checkIndicatorAlerts()` in `alerts.js`; RSI, BB, volume-spike types. Watchlist UI. See §0. |
| ✓ **Off-device alert channels (Telegram)** | M | ★★★ | **SHIPPED** — Telegram bot integration. `routes/alerts.py`, Settings UI, `fireAlert()` hook. See §0. |
| ✓ **Ex-dividend & earnings reminders** | S | ★★ | **SHIPPED** — `checkExDivReminders()` / `checkEarningsReminders()` in `prices.js`. See §0. |
| ✓ **Macro / regime-change alert** | S | ★★ | **SHIPPED** — `fireAlert()` when regime flips to `panic` or `riskOff`. See §0. |
| ✓ **Stale-position nudge** | S | ★ | **SHIPPED** — amber card on Dashboard listing holdings with no rec in 14+ days. See §0. |

### 2.4 Research & analysis

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Side-by-side ticker compare** | M | ★★ | **SHIPPED** — `js/pages/compare.js`, g+x shortcut, ↔ nav button, Watchlist ↔ button. See §0. |
| ✓ **Saved screeners** | S | ★★ | **SHIPPED** — `state.savedScreeners`, ⊕ Save/Load/Delete in scanner config bar. See §0. |
| **Economic calendar** | M | ★★ | RBA meetings, US Fed, CPI, jobs, ASX reporting season — overlaid on the dashboard so you trade around known catalysts. |
| ✓ **Seasonality view** | M | ★ | **SHIPPED** — `GET /api/seasonality/<ticker>` + 12-bar card on Signals detail view. See §0. |
| **A-VIX / volatility gauge** | S | ★★ | Surface an ASX volatility proxy alongside the US VIX already in macro, for a local fear/greed read. |
| ✓ **Regime overlay on trade history** | S | ★★ | **SHIPPED** — coloured regime badge per journal row. See §0. |

### 2.5 Risk management

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Scenario / stress test** | M | ★★★ | **SHIPPED** — card on Risk page; shock presets + custom; per-holding beta × shock table. See §0. |
| ✓ **Trailing & ATR-based stops** | M | ★★★ | **SHIPPED** — 2×ATR14 stops card on Risk page; one-click "Set Alert". See §0. |
| ✓ **Correlation-aware sizing (sector)** | S | ★★ | **SHIPPED** — `_sectorConcentrationWarning(rec)` shows amber/red badge on BUY recs when the rec's sector already exceeds threshold. See §0. |
| **Correlation-aware sizing (exact)** | M | ★★ | Use the `/api/risk` correlation matrix to quantify exact |corr| with each holding; auto-reduce sizing when |corr| > 0.7. |
| ✓ **Risk-budget dashboard** | S | ★★ | **SHIPPED** — heat gauge at top of Risk page, configurable % budget. See §0. |
| ✓ **Drawdown monitor + alert** | S | ★★ | **SHIPPED** — current + max drawdown from portfolio history; alert banner + configurable threshold. See §0. |

### 2.6 Workflow & discipline

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Pre-trade checklist** | S | ★★★ | **SHIPPED** — 5-item modal gate, requires ≥4 ticks. See §0. |
| ✓ **Thesis capture** | M | ★★★ | **SHIPPED** — textarea on rec cards, captured at execution, passed to learning loop as `trade_thesis`, shown in journal tooltip. See §0. |
| **Thesis review at exit** | S | ★★★ | Surface `_thesis` when a position closes — "Was your thesis correct?" prompt before the postmortem fires. |
| ✓ **Broker CSV import** | M | ★★★ | **SHIPPED** — CommSec/SelfWealth/generic detection; backend parses, normalises, returns rows. See §0. |
| ✓ **Trade tags & notes** | S | ★★ | **SHIPPED** — `tags`/`trade_thesis` DB columns + inline input on rec cards + stored in learning events. See §0. |
| ✓ **Morning briefing auto-generate** | M | ★★ | **SHIPPED** — `'briefing'` agent type; Dashboard "Generate Brief" button chains macro + regime + holdings. See §0. |

### 2.7 AI assistant enhancements

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Portfolio-aware Q&A** | M | ★★ | **SHIPPED** — `sendChat()` now injects regime + macro context (VIX, ASX200, sentiment, AUD/USD) into system prompt. See §0. |
| ✓ **Postmortem digest** | S | ★★ | **SHIPPED** — `GET /api/learning/digest-data` + "Generate Digest" on Learning page. See §0. |
| **Local-LLM fallback** | M | ★ | Use the existing Ollama setup for cheap/offline analysis when you don't want to spend on Claude calls (debate engine already uses it). |
| **Prompt A/B tracking** | M | ★★ | Compare win-rate by `PROMPT_VERSION` so you know whether a prompt change actually helped (table exists; surface it). |

---

## 3. Reliability & engineering (personal-grade)

You don't need multi-user infra, but you *do* want it to not lose your data or break mid-session.

### ✓ 3.1 Data-source resilience — `M` · ★★★ **SHIPPED**
`fetch_with_retry()` in `core.py` with exponential backoff and stale-cache fallback. Quote and macro
endpoints use it. Remaining: secondary provider (Alpha Vantage / Stooq) behind a `DataProvider`
interface for when yfinance is completely down.

### ✓ 3.2 Automated local backups — `S` · ★★★ **SHIPPED**
Daily backup on startup + daemon thread. Keeps last 7. See §0.

### 3.3 Real frontend tests — `M` · ★★
The suite only `node --check`s syntax — it can't catch a logic regression like the exit-reason bug.
Add **Vitest** unit tests for the pure engines (`quant-engine`, `regime-engine`, `response-validator`,
`learning-loop`, `_detectExitReason`).

### 3.4 Performance / responsiveness — `S` · ★★
Several endpoints are slow (macro/polymarket/earnings 3–5 s — see `SLOW` log lines). Parallelise
remaining serial yfinance calls, widen caches for slow-moving data, and show optimistic loading states.

### ✓ 3.5 Light security hygiene (personal) — `S` · ★ **SHIPPED Sprint 21**
- gunicorn now binds `127.0.0.1:5000` (was `0.0.0.0`) — LAN devices can no longer reach the API
- CORS restricted to `null` (file://), localhost:5000/8080, 127.0.0.1:5000 origins
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy` headers added
  to every Flask response via `_req_end()`

### ✓ 3.6 Escape external text in the render layer — `S` · ★★ **SHIPPED**
`escapeHTML()` added to `utils.js`; applied to all external text injection points. See §0.

### 3.7 Type safety / ES-modules — `L` · ★★
TypeScript (or JSDoc + `tsc --checkJs`) on the core engines, and the ES-modules migration noted in
CLAUDE.md, would remove the fragile global load-order contract. Quality-of-life, not urgent.

---

## 4. UX & quality of life

| Item | Effort | Impact | Notes |
|---|---|---|---|
| Mobile / PWA | L | ★★ | Check positions + alerts on the phone during market hours; installable PWA is enough for personal use. |
| Onboarding & empty states | S | ★ | First-run setup (key, cash, import) and friendly empty cards. |
| Keyboard shortcuts | S | ★ | Fast page switching + "log trade" hotkey for a power user. |
| Dark/light + density toggle | S | ★ | Already dark; a compact density mode helps on the Pi/small screens. |
| In-app changelog / version banner | S | ★ | Surface app version + `PROMPT_VERSION` so you know when logic/models changed. |
| Consistent loading/error states | S | ★ | Skeletons + retry; the error boundary catches crashes but happy-path spinners are uneven. |

---

## 5. Suggested sequencing

1. ✓ **Trust the numbers first:** §1.3 Wilson CI, §1.4 Brier score, §1.2 slippage — **done**. Remaining: §1.1 look-ahead bias, §1.5 survivorship bias.
2. ✓ **Don't lose data:** §3.2 backups, §3.1 retry + stale-cache — **done**. Remaining: secondary data provider fallback.
3. ✓ **Highest daily payoff:** pre-trade checklist, CGT countdown, trade tags, heat gauge, drawdown monitor, Telegram, broker CSV, indicator alerts, tax-loss planner, EOFY pack, watchlist, morning briefing, regime journal, stale nudge — **all done**.
4. ✓ **Deepen the edge:** §2.5 stress test / trailing stops / breadth signal — **done**. ✓ §1.7 walk-forward backtest — **done Sprint 20**. Remaining: §2.5 correlation-aware sizing.
5. ✓ **Sprint 6 shipped:** §2.7 portfolio-aware Q&A, §2.1 performance attribution, §2.5 sector-concentration warning, §2.6 thesis capture, §2.2 dividend forecast + franking credits — **all done**.
6. ✓ **Sprint 7 shipped:** thesis review at exit, prompt-version P&L, target allocations + drift alerts, economic calendar (RBA dates + ex-div + earnings), franking 45-day rule warnings — **all done**.
7. ✓ **Sprint 8 shipped:** A-VIX (ASX realized vol), cash/TD tracker, exact correlation-aware sizing, macro endpoint perf (3 serial fetches eliminated), keyboard shortcuts (`g`+letter + `?`) — **all done**.
8. ✓ **Sprint 9 shipped:** Prompt+response logging (ai_call_log, full prompt in every call), side-by-side compare page, prompt version A/B delta, ETF earnings filter, App Info card — **all done**. Remaining: §1.1 look-ahead bias, §1.5 survivorship bias, §3.3 Vitest tests.
9. ✓ **Sprint 12 shipped:** §1.1 look-ahead bias (AI Replay fixed to nominal prices; strategy backtest disclosed as total-return), TRIM/SELL ATR stop floor, intraday Extreme Mode, intraday dynamic UI updates, Groq/Gemini key consolidation, neutral debate synthesis — **all done**.
10. ✓ **Sprint 13 shipped:** compact/density mode, in-app changelog, macro loading state, corporate-actions split detection, liquidity-scaled slippage — **all done**.
11. ✓ **Sprint 14 shipped:** signals page candlestick chart, journal monthly P&L bar chart, portfolio sector sidebar (replaced canvas donut), numpy.bool_ JSON serialization fix, Learning Loop table alignment + dark-theme button colors — **all done**.
12. ✓ **Sprint 17 shipped:** monthly seasonality card (Signals page detail), CGT split auto-adjust with one-click Apply button (Portfolio) — **all done**.
13. ✓ **Sprint 18 shipped:** `_retryBtn`/`_emptyCard` utils helpers, risk.js error banner + retry, performance.js equity-curve error card, portfolio first-run empty state — **all done**.
14. **Polish:** §3.3 Vitest tests, §4 UX (mobile/PWA), §3.7 types/modules.

---

## Appendix A — Shipped (original build sprint)

The original roadmap's nine items have all landed and are retained for history:

1. **Relative Strength vs ^AXJO** — `rs_score` in `_score_ticker`; RS columns in scanner.
2. **Learning Loop system** — `ai_learning_events` + `prompt_versions` tables, `/api/learning/*`, Learning Loop page, calibration injection.
3. **Performance metrics** — Sortino, profit factor, win/loss streaks, avg hold.
4. **Prompt versioning & hardening** — `PROMPT_VERSION` (now v5), hard-rules delimiter, JSON schema example.
5. **Error resilience** — try/except around yfinance, `failed_tickers` table, graceful scan skips.
6. **Sector-map robustness + caching** — expanded map, `ticker_metadata` cache, fallback chain.
7. **Ensemble confidence** — `0.5·AI + 0.5·(score/100)`, used for the gate.
8. **Desktop alerts** — `js/alerts.js`, one-shot stop/target alerts.
9. **Trade journal + ATO CGT export** — CSV with CGT-discount eligibility.

Later passes added the **debate engine** (Ollama bull/bear + postmortem + skill scoring + cloud
adjudicator) and **Learning Loop Stages 1–4** (data capture → auto-classification → prompt
instructions → active feedback).

---

## Appendix B — Learning Loop DB schema

```sql
CREATE TABLE IF NOT EXISTS ai_learning_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    event_type TEXT NOT NULL,           -- 'recommendation', 'day_trade', 'macro'
    ticker TEXT,
    regime TEXT,                        -- from regime-engine.js
    prompt_version TEXT,
    agent_type TEXT,                    -- 'analyst', 'pm', 'portfolio', 'dayTrade'

    -- AI Output
    ai_confidence REAL,
    recommendation TEXT,                -- BUY / TOP_UP / SELL / TRIM / HOLD
    rationale_summary TEXT,
    suggested_stop REAL,
    suggested_target REAL,
    rr_ratio REAL,

    -- Outcome (updated later)
    outcome_status TEXT,                -- 'win', 'loss', 'breakeven', 'open', 'invalidated'
    realized_pnl_pct REAL,
    realized_pnl_aud REAL,
    holding_period_days INTEGER,
    exit_reason TEXT,                   -- 'target_hit', 'stop_hit', 'manual', 'time_exit', 'catalyst'

    was_executed BOOLEAN DEFAULT 0,
    follow_through_days INTEGER,
    market_context TEXT,                -- JSON string
    error_type TEXT,                    -- 'overconfident', 'regime_mismatch', 'poor_rr', etc.
    notes TEXT
);

CREATE TABLE IF NOT EXISTS prompt_versions (
    version TEXT PRIMARY KEY,
    created_at TEXT,
    description TEXT,
    total_calls INTEGER DEFAULT 0,
    win_rate REAL DEFAULT 0,
    high_conf_win_rate REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS failed_tickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
    ticker TEXT,
    error TEXT
);

CREATE INDEX idx_learning_ticker    ON ai_learning_events(ticker);
CREATE INDEX idx_learning_timestamp ON ai_learning_events(timestamp DESC);
CREATE INDEX idx_learning_regime    ON ai_learning_events(regime);
CREATE INDEX idx_learning_event_type ON ai_learning_events(event_type);
CREATE INDEX idx_learning_confidence ON ai_learning_events(ai_confidence);
```
