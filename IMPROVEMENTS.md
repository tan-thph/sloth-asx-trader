# Sloth ASX Trader — Improvement Roadmap (Personal Use)
**Last Updated:** 2026-05-27 (sprints 3–6 shipped)

> **Scope:** This is a **private, single-user, local** decision-support tool. It is *not* a public
> product — so multi-user auth, tenant isolation, financial-services licensing, ToS/Privacy, and
> data-**redistribution** licensing are explicitly **out of scope**. Improvements here focus on
> three things that matter for your own trading: **signal accuracy**, **reliability/data quality**,
> and **useful features** that make day-to-day trading decisions faster and more disciplined.

Each item carries an effort (S/M/L/XL) and impact (★–★★★) rating for triage.

---

## 0. Shipped — 2026-05 sprints

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

---

## 1. Accuracy & model quality

Make the signal itself trustworthy. These guard against the classic ways a backtest or a
self-tuning loop quietly flatters itself — which for a personal tool means *not fooling yourself*.

### 1.1 Eliminate look-ahead bias — `M` · ★★★
yfinance `auto_adjust=True` returns split/dividend-**adjusted** history; adjusted closes embed future
dividend info into past bars — a subtle look-ahead in indicators and backtests. Pick an adjustment
policy and apply it identically to live vs historical paths. Verify indicators never read the
*forming* (incomplete) intraday bar as a closed one.

### 1.2 Transaction-cost & slippage modelling — `M` · ★★★
Backtest/quant sizing uses a flat brokerage. Real ASX fills incur **spread + slippage + market
impact**, worst for the small/mid-caps the scanner favours (low `adv_20`). Add liquidity-scaled
slippage so a backtested edge isn't just an artefact of frictionless fills.

### ✓ 1.3 Statistical rigour on the Learning Loop — `M` · ★★★ **SHIPPED**
Wilson 95% CI now appears on all win-rate cells; calibration gated at n<30. See §0.

### ✓ 1.4 Confidence-calibration validation — `M` · ★★★ **SHIPPED**
Brier score + reliability diagram in `GET /api/learning/calibration-stats`. Learning page shows the
Brier score metric card and a CSS bar diagram (actual win rate vs predicted confidence, per bin). See §0.

### 1.5 Survivorship bias in the universe — `L` · ★★
`ASX_UNIVERSE` is *today's* constituents; backtests over it silently exclude delisted/relegated names
and overstate returns. Use point-in-time membership for honest historical tests.

### 1.6 Overfitting guard on `_score_ticker` weights — `L` · ★★
Weights tuned on history curve-fit easily. Validate with **walk-forward / k-fold** and report
out-of-sample degradation; prefer fewer robust factors over many fragile ones.

### 1.7 Walk-forward backtesting engine — `XL` · ★★★
Vectorised OHLCV replay with rolling train/test split + parameter grid. The honest way to know a
strategy works, and the foundation for §1.6. (Carried over from deferred.)

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
| **Side-by-side ticker compare** | M | ★★ | Compare 2–4 tickers' signals/valuation/RS in one view before choosing. |
| ✓ **Saved screeners** | S | ★★ | **SHIPPED** — `state.savedScreeners`, ⊕ Save/Load/Delete in scanner config bar. See §0. |
| **Economic calendar** | M | ★★ | RBA meetings, US Fed, CPI, jobs, ASX reporting season — overlaid on the dashboard so you trade around known catalysts. |
| **Seasonality view** | M | ★ | ASX/ticker monthly seasonality (e.g. "Santa rally", May weakness) as context, clearly labelled as low-confidence. |
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

### 3.5 Light security hygiene (personal) — `S` · ★
Low-stakes on a trusted machine, but: if the app is reachable on your home Wi-Fi (`0.0.0.0`), anyone
on the LAN can hit it. Consider binding `127.0.0.1` unless you specifically use it from a phone. The
API-key-in-`localStorage` model is acceptable for personal use; backend-proxy mode is the safer option
if you ever expose it.

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
4. ✓ **Deepen the edge:** §2.5 stress test / trailing stops / breadth signal — **done**. Remaining: §2.5 correlation-aware sizing, §1.7 walk-forward backtest.
5. ✓ **Sprint 6 shipped:** §2.7 portfolio-aware Q&A, §2.1 performance attribution, §2.5 sector-concentration warning, §2.6 thesis capture, §2.2 dividend forecast + franking credits — **all done**. Remaining: exact correlation sizing, thesis-review-at-exit prompt, §1.1 look-ahead bias, §1.5 survivorship bias.
6. **Polish:** §3.3 Vitest tests, §4 UX (keyboard shortcuts, compact mode, PWA), §3.7 types/modules.

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
