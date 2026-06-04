# Sloth ASX Trader — Improvement Roadmap (Personal Use)
**Last Updated:** 2026-06-04 (Sprint 45 shipped)

> **Scope:** This is a **private, single-user, local** decision-support tool. It is *not* a public
> product — so multi-user auth, tenant isolation, financial-services licensing, ToS/Privacy, and
> data-**redistribution** licensing are explicitly **out of scope**. Improvements here focus on
> three things that matter for your own trading: **signal accuracy**, **reliability/data quality**,
> and **useful features** that make day-to-day trading decisions faster and more disciplined.

Each item carries an effort (S/M/L/XL) and impact (★–★★★) rating for triage.

---

## 0. Shipped — Sprint 45 (2026-06-04)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Thesis drift detection** | Analytics (M) | `_compute_thesis_drift(conn)` in `routes/learning.py` compares avg `realized_pnl_pct` of manual early exits vs target hits (n≥5 each). Emits `⚠EARLY_EXIT_DRAG` calibration nudge when drag >3pp. `GET /api/learning/thesis-drift` endpoint exposes the raw stats. Learning page gains async `renderThesisDriftCard()` — two stat boxes (manual vs target avg P&L) with a green/amber summary line. Nudge is lowest-priority in calibration block (first dropped by budget truncation). |
| **Stop-loss trailing** | Workflow (S) | "📍 Trail" button added to every pending BUY/TOP_UP/SELL/TRIM rec card in `recommendations.js`. `trailStop(recId)` uses live price + ATR from `state.liveSignals` and `getRegimeModifiers().stopAtrMult` to compute a new stop. Only tightens (never loosens). Confirms via `confirm()` dialog. Marks `rec._stopTrailed = true`, `rec._stopTrailedAt = ISO string`. Re-renders page and calls `scheduleSave()`. `📍 Trailed` badge shown in rec card header when trailed. |
| **Scheduled morning briefing** | Workflow (S) | `state.settings.autoBriefTime` ('HH:MM' AEST, empty = disabled) added to `config.js`. Settings → Display section gains a time input. `checkAutoBriefSchedule()` defined in `scheduler.js` — checks `localStorage.autoBriefFiredDate` (YYYY-MM-DD) to fire at most once per day; compares current AEST time (UTC+10 fixed offset) against configured time; calls `generateMorningBriefing()` if not already fired today. Called from `autoRefreshPrices()` (every 10–20 min) and once at end of `initApp()`. |

---

## 0. Shipped — Sprint 44 (2026-06-04)

| Fix / Feature | Area | Detail |
|---|---|---|
| **§2.6 DRP parcel tracking** | Workflow (M) | Portfolio page gains a "DRP" button per holding row. Clicking opens a modal (shares, price/share, settlement date, optional dividend amount). `applyDrpEvent()` recalculates weighted `avgPrice`, adds a `state.cgtParcels` entry (`action:'DRP'`), and logs to `state.tradeJournal`. CGT page shows an indigo `DRP` badge on DRP parcels. `badge-drp` CSS added. `actionBadge()` in `utils.js` handles DRP. Journal filter includes DRP option. |
| **§1.12 Virtual-outcome speed weighting** | Calibration (S) | `virtual_speed_weight REAL` column added to `ai_learning_events` via `_LE_MIGRATIONS`. `_resolve_virtual_outcomes()` now writes `speed_weight = min(1.0, 7.0 / hold_days)` — trades that hit target in 7d get weight=1.0; 29d → ~0.24. `_weight()` in `_calib_compute()` multiplies the existing 0.75× virtual discount by `virtual_speed_weight`. |
| **§1.11 Regime-change calibration penalty** | Calibration (S) | On regime flip, `fetchAndClassifyRegime()` writes `regime_flipped_at` and `regime_flipped_to` to `localStorage`. `fetchCalibrationBlock()` passes them as query params. Backend `_calib_compute()` halves the half-life (`hl = max(10, hl // 2)`) for the first <10 trades in the new regime when flip was within 30d; emits `⚠REGIME_FLIP(Nd ago, N trades, hl=Nd)` token in the calibration block. |
| **§2.6 Lessons market-breadth scope** | Workflow (M) | `breadth_scope TEXT` column added to `trading_lessons` via `init_db()`. Valid values: `adl_below_0.3`, `adl_above_0.7`, `high_vol`, `low_vol`, `null` (always inject). `GET /api/learning/lessons` accepts `adl` and `asx_vol` params and filters scoped lessons accordingly. `POST /api/learning/lessons` accepts `breadth_scope`. Create Lesson form in `learning.js` gains a breadth-scope dropdown. `analysis.js` passes `adl` + `asx_vol` from `state.macroData` to the lessons fetch. |

---

## 0. Shipped — Sprint 43 (2026-06-03)

| Fix / Feature | Area | Detail |
|---|---|---|
| **§3.8 Hoist `_detectExitReason` to `utils.js`** | Tech debt | Single canonical copy now in `js/utils.js`. Removed duplicate definitions from `recommendations.js` and `performance.js`. `utils.js` loads first — both page files resolve the global at call time. Tests updated: `detect-exit-reason.test.js` extracts from `utils.js`; `test_detect_exit_reason_direction_aware` validates `utils.js` and asserts neither page file redefines it. |
| **§3.10 Stooq rate-limit semaphore** | Reliability | `_stooq_sem = threading.BoundedSemaphore(1)` in `core.py`. Both `stooq_quote()` and `_fetch_stooq_history()` in `indicators.py` acquire the semaphore; a 1-second sleep in the `finally` block paces requests to Stooq's undocumented ~1 req/sec limit. Prevents silent empty-CSV responses under parallel batch scans. |
| **§3.9 `FACTOR_WEIGHTS` normalization guard** | Safety | `indicators.py` emits `warnings.warn` at import time if `sum(FACTOR_WEIGHTS) != 100`. Catches misconfiguration before it silently corrupts scanner scores. |
| **§2.7 "Why this rec?" traceability panel** | UX ★★★ | `analysis.js` attaches `_genRegime`, `_genRegimeConf`, `_calibSnap` (≤350 chars of the calibration block), and `_signalsSnap` (9 signal fields) to every rec at generation time. Each pending rec card in `recommendations.js` now has a collapsed `<details>` section showing: regime + confidence badge, signal chips (RSI/ADX/BB%B/ATR/Score/OBV/MACD/Vol×/RS), calibration nudge monospace block, and cached Ollama debate synthesis if available. Arrow rotates on expand via `details[open] .trace-arrow` CSS. |

---

## 0. Shipped — Sprint 41 (2026-06-03)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Macro page optimistic stale rendering** | UX (§3.4) | `renderMacroPage(gen)` async wrapper added to `macro.js`. On navigation, renders cached `state.macroData` immediately; if data is >5 min stale, kicks a silent background `GET /api/macro` fetch (no disruptive spinner, no `renderPage()` at start) and shows a small "⟳ Refreshing…" badge in the header. `_macroRefreshing` guard prevents concurrent refreshes. `state.macroLastFetch` timestamp set on both user-initiated `fetchRealMacro()` and background auto-refresh. |
| **Earnings calendar auto-fetch on navigation** | UX (§3.4) | Macro page auto-calls `fetchEarningsCalendar()` if earnings are missing for portfolio tickers. Dashboard case in `navigation.js` also kicks `fetchEarningsCalendar()` if the Upcoming Catalysts card has no data. `fetchEarningsCalendar()` now sets `state.earningsLastFetch` timestamp and re-renders on `dashboard` (previously only `macro`). |

---

## 0. Shipped — Sprint 40 (2026-06-02)

| Fix / Feature | Area | Detail |
|---|---|---|
| **RBA rate 6h in-memory cache** | Performance (§3.4) | Extracted `_rba_rate_cached()` with `@ttl_cache(seconds=21600)` in `routes/market.py`. Previously the route always made a live HTTP scrape to `rba.gov.au` on every call (macro page refresh, Settings load, etc.) before falling back to the DB 7d cache. Now the successful result (live or DB) is held in memory for 6h, cutting the network call to at most once per 6h. `RuntimeError` on total failure is not cached by `ttl_cache` (exception propagates without storing), so the next call retries immediately. User-set rate override and 4.35 fallback remain unchanged in the route. |
| **Signals page optimistic rendering** | UX (§4) | `renderSignalsPage()` now renders stale `state.liveSignals` immediately on navigation; kicks a background `fetchSignals()` that re-renders when done (with a "⟳ Refreshing…" badge in the header). Full spinner shown only on first cold load (no cached data). Module-level `_sigRefreshing` guard prevents duplicate concurrent refreshes. |

---

## 0. Shipped — Sprint 39 (2026-06-02)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Polymarket fetch parallelization** | Performance (§3.4) | `/api/polymarket` now dispatches all 6 Manifold API queries in parallel via `ThreadPoolExecutor` instead of a serial list comprehension. Worst-case latency drops from 6×8s=48s to a single 8s timeout when all succeed. Typical latency improvement: 3–5s → ~1s on cache miss. |
| **Polymarket loading state** | UX (§3.4) | `fetchPolymarket()` sets `window._pmFetching=true` and calls `renderPage()` before the fetch, disabling the button and showing a spinner row inside the Prediction Markets card. `finally` block clears flag. |
| **Earnings-calendar 4h per-ticker cache** | Performance (§3.4) | Extracted `_get_ticker_earnings_cached(ticker)` with `@ttl_cache(seconds=14400)` in `routes/market.py`. Previously, every call made 3 yfinance HTTP round-trips per ticker (`info`, `calendar`, `earnings_history`) — repeated loads of the Dashboard economic calendar or Signals page incurred the full cost each time. ThreadPoolExecutor still provides parallel dispatch on cache misses. |
| **`_preEarningsAdj` forwarded through quant merge** | Bug fix | `computeTradeParams()` correctly set `_preEarningsAdj: true` when pre-earnings stop widening (1.3×) fired, but `analysis.js` only forwarded named fields from the quant result. The flag was silently dropped, so the `📅 Pre-earnings` badge never appeared on rec cards. Fixed by adding `_preEarningsAdj: qt._preEarningsAdj` to the merge. 3 new quant-engine tests + 2 new regime-engine tests for stopAtrMult monotonicity (127 JS tests total). |
| **Survivorship bias disclosures in backtest** | Accuracy (§1.5) | Added an amber warning panel to Technical backtest results (alongside the existing total-return disclosure) and a footer note to the Walk-Forward methodology box. Both explain that current ASX200 constituents are used — delisted/dropped stocks are excluded and returns may be overstated. Treat absolute figures as indicative; use Sharpe/win-rate for cross-strategy comparisons. |
| **Capital-returns-check endpoint** | Data quality (§1.9) | New `GET /api/portfolio/capital-returns-check?tickers=...` in `routes/portfolio.py`. Fetches `stk.dividends` for the last 90 days; flags any single payment ≥5% of current price as a potential special dividend / capital return. Portfolio page calls `checkCapitalReturns()` alongside `checkPortfolioSplits()` on load; shows an orange banner with date, amount, and per-share figure when flagged. `state._capitalReturnWarnings` mirrors `state._splitWarnings`. 5 new tests (3 endpoint, 2 frontend). |
| **Mobile / responsive layout (§4)** | UX | Added `@media (max-width: 768px)` block to `asx_trading.css`: sidebar slides in as an overlay (transforms from `translateX(-100%)` to `translateX(0)`) with a semi-transparent backdrop. Hamburger button (`☰`) appears in the topbar on mobile; hidden on desktop. `toggleMobileSidebar()` / `closeMobileSidebar()` added to `navigation.js`; `showPage()` auto-closes the sidebar on any navigation. Grid layouts collapse to single column at 768px. Tables and content padding already handled by `.table-wrap` and existing grid media queries. |
| **IMPROVEMENTS.md stale ✓ cleanup** | Docs | Marked 8 shipped items as ✓ in §2.1–2.7 tables: Target allocations, Cash/TD tracker, Franking 45-day, Economic calendar, A-VIX, Correlation-aware sizing (exact), Thesis review at exit, Prompt A/B tracking. Removed stale "Remaining:" notes from §5. Added Sprint 37–38 and open items to §5. |

---

## 0. Shipped — Sprint 38 (2026-06-02)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Sell tag calibration injection** | Learning Loop | `_calib_compute()` in `routes/learning.py` now queries `sell_verify_verdict` per `sell_primary_driver` (n≥3, verifiable drivers only). Adds part 9 to the calibration block: `⚠SELL_TAG:time_stop(n=11,val=27%)→CUTTING WINNERS:extend hold` when `inval_rate≥50%`; `✓SELL_TAG:thesis_brk(n=12,val=67%)→reliable` when `val_rate≥65%`. Excluded: `position_sizing`, `risk_management`, `tax_optimisation`, `regime_change` (unverifiable by price). Capped at 3 drivers; subject to Gap 8 token-budget truncation. |
| **Section 6 sell tag interpretation** | Prompts | `ANALYSIS_SYSTEM_PROMPT` Section 6 now tells Claude how to act on `⚠SELL_TAG` / `✓SELL_TAG` lines. `⚠` → require one additional confirming signal, prefer `urgency='monitor'`; CUTTING WINNERS means `time_stop` only valid at ≥3× expected hold with flat price; alt rarely better means `better_opportunity` requires a clearly superior entry. `✓` → standard evidence threshold applies. |
| **Calibration cache thread lock (Fix #8)** | Backend | `threading.Lock()` added to `routes/learning.py`. Guards `_calib_cache` reads and writes; expensive `_calib_compute()` runs outside the lock. Prevents partial cache-write corruption under concurrent gunicorn threads. |
| **Phase 8 Mann-Whitney gate (Fix #10)** | Learning Loop | `_mann_whitney_z(wins, losses)` replaces mean comparison in `_compute_phase8_meta()`. Uses U-statistic normalised to Z-score; `active = z > 1.28` (one-sided p<0.10). Single high-skill outlier no longer flips Phase 8 on/off. |

---

## 0. Shipped — Sprint 37 (2026-06-02)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Sell tag outcome tracking (Gap 3)** | Learning Loop | `_resolve_sell_outcomes(conn)` in `routes/learning.py` — lazy-evaluated inside `_calib_compute()`. Finds executed SELL/TRIM events with `sell_primary_driver` set, 25+ days old, and unverified. Fetches yfinance price at sell date and now; computes `sell_verify_sold_chg`. Verdicts: `validated`/`invalidated`/`inconclusive` per driver. `target_reached`: validated if sold ≤+5%; `thesis_broken`/`stop_triggered`: validated if < −5%; `position_sizing`/`risk_management`/`portfolio_rebalance`: always inconclusive. Capped at 5 resolutions per calibration call — shares the 5-min TTL. |
| **`better_opportunity` cross-check (Gap 7)** | Learning Loop | `alternative_ticker` column added to `ai_learning_events`. Logged at SELL/TRIM generation time from `analysis.js` (`r.alternativeTicker`). `_resolve_sell_outcomes()` fetches alt ticker price history from sell date → now; computes `sell_verify_alt_chg`. Validated if alt outperformed sold by >3pp, invalidated if < −3pp. |
| **Sell Decision Tracker UI card** | Learning Page | `renderSellOutcomesCard()` async card on Learning page. Shows ticker, driver, P&L, and 30d verdict per executed SELL. Colour-coded badges (🟢 validated / 🔴 invalidated / — inconclusive). "↺ Check Now" button triggers `?force=1` re-resolve. Pending events shown with "Pending (≥25d)" label. |
| **`GET /api/learning/sell-outcomes`** | Backend | New endpoint. Returns executed SELL/TRIM events with `sell_primary_driver IS NOT NULL`, ordered by timestamp DESC. `?force=1` param triggers an immediate resolve before returning. |

**Already shipped (confirmed in Sprint 37 audit):**
- Thesis review at exit — `_showThesisReview()` fires in `markExecuted()` on full position close
- ATR-based debate cache invalidation — `atr_pct` is in the signal hash; cache auto-invalidates on ATR spikes
- Economic calendar on Dashboard — `_buildEconomicCalendarCard()` live, shows RBA + ex-div + earnings in 45d window
- Exact correlation-aware sizing — `analysis.js` lines 819–857: fetches `/api/risk` correlation matrix post-analysis; reduces BUY qty by 30% (|corr|>0.7) or 50% (|corr|>0.85)

---

## 0. Shipped — 2026-05 sprints (through Sprint 27)

| Fix / Feature | Area | Detail |
|---|---|---|
| **Ollama structured outputs (format_schema)** | AI Quality (Sprint 23) | All 6 JSON-producing Ollama endpoints now pass `format_schema` via Ollama's native `format` parameter. Engine constrains token generation at grammar level — valid JSON guaranteed without regex fallback. Schemas: `_SCHEMA_POSTMORTEM`, `_SCHEMA_WIN_TAG`, `_SCHEMA_SYNTHESIS`, `_SCHEMA_EXIT_SYNTHESIS`, `_SCHEMA_PM_SYNTHESIS`, `_SCHEMA_SKILL`. |
| **ESS calibration gates** | Accuracy (Sprint 23) | All `n≥3` raw count guards replaced with Kish ESS≥2.5. `_ess(subset) = (Σwi)²/Σwi²`. Low-ESS subsets emit warning tokens instead of confidence nudges. Prevents a 4-trade sample dominated by 3 stale 90-day-old entries from appearing statistically reliable. |
| **Signal flattening for postmortem/skill** | AI Quality (Sprint 23) | `_flatten_entry_signals()` helper — 12 key diagnostic fields in compact pipe-separated format. Reduces postmortem prompt overhead ~200 tokens vs raw JSON dump; improves small-model extraction accuracy. |
| **Cloud adjudicator provider picker** | UX (Sprint 22) | User can select Gemini, Groq, or Claude API explicitly for adjudication. Provider picker modal when multiple keys configured. Auto-detect still available (Gemini → Groq → Claude). |
| **Blind adjudication** | AI Quality (Sprint 24) | Random alias swap ("Analyst Alpha"/"Analyst Beta") before building cloud adjudicator prompt. Prevents halo-effect bias where cloud models prefer certain model families by name. `score_alpha`/`score_beta` fields; winner un-swapped via `blind_map`; `blind_swap`/`alias_a`/`alias_b` stored in `phase_4` for audit. |
| **JS Ollama priority queue** | Reliability (Sprint 24) | `_oqEnqueue(fn, priority)` in `debate-client.js`. HIGH lane for user-initiated calls; LOW lane for auto-triggers. Prevents background auto-postmortems from blocking user's next manual debate call for minutes. |
| **Skill-weight centering at 5** | Accuracy (Sprint 24) | `_weight()` formula: `max(0.2, min(1.8, sk/5.0))`. Old formula centered at 10 — a skill=8 trade was penalised vs unscored. Now unscored=1.0, neutral skill=1.0, high skill amplified up to 1.8×. |
| **Hierarchical regime fallbacks** | Accuracy (Sprint 24) | Calibration falls through: specific regime → macro group (bearish/bullish/neutral) → all trades when ESS<2.5. Prevents freshly-transitioned regimes from getting no calibration signal at all. |
| **Volatility-adaptive half-life** | Accuracy (Sprint 25) | `_HL_MAP` in `_calib_compute()`: panic=20d, bearVolatile=25d, riskOff=30d, sideways=60d, default=45d. Non-default hl shown in calibration block header (`hl=Nd`). |
| **SQLite startup maintenance** | Reliability (Sprint 25) | `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` in `init_db()`. Non-blocking; prevents index-stat decay and WAL file growth under heavy JSON blob accumulation. |
| **Phase 6: Calibration quality debate card** | AI Quality (Sprint 26) | `GET /api/debate/calib-quality`. Backend pre-computes binomial SE + Z-scores (`_norm_cdf` via `math.erfc`, no scipy). Prompt presents statistical verdict as immutable fact — model constrained to qualitative failure-tag analysis only. Traffic-light badges (🟢/🟡/🔴) on Learning page. Auto-triggered once daily via `triggerCalibQualityIfStale()` (LOW priority queue). |
| **Success Patterns UI card** | Analytics (Sprint 27) | Learning page card showing dominant win tags with count, win rate bars, and calibration nudge explanation. Backed by step 6b in `_calib_compute()` and `success_patterns` field in `/api/learning/stats`. 5 supported tags: `confluence_entry`, `trend_aligned`, `catalyst_driven`, `tight_stop_well_placed`, `momentum_entry`. |
| **Success tag calibration nudge** | Accuracy (Sprint 27) | Step 6b in `_calib_compute()` mirrors L2 dominant error check for wins. Emits `✓tag(N/Mwins,ESS=X.X)→lean into this` when ≥33% of tagged wins share a tag and ESS≥2.5. |
| **Walk-forward backtesting engine** | Accuracy (Sprint 20) | Rolling train/test split + per-fold parameter grid-search. `POST /api/backtest/walk-forward`. Walk-Forward tab in Backtest page. Fold-by-fold table + stitched OOS equity curve + B&H benchmark. |
| **Factor stability / overfitting guard** | Accuracy (Sprint 21) | K-fold cross-validation of 8 `_score_ticker` signal factors. Information Coefficient (Spearman) in-sample vs OOS. `POST /api/scanner/factor-stability`. Factor Stability tab in Market Scanner. |
| **Security hygiene** | Reliability (Sprint 21) | gunicorn binds `127.0.0.1:5000` (was `0.0.0.0`). CORS restricted to localhost origins. Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` added to every response. |
| **Vitest JS test suite** | Reliability (Sprint 19) | 122 JS unit tests for pure engine files (`quant-engine`, `regime-engine`, `response-validator`, `_detectExitReason`). `npm run test:js`. |

---

## 0a. Shipped — 2026-05 sprints (through Sprint 18)

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

### ✓ 1.5 Survivorship bias in the universe — `L` · ★★ **(disclosure shipped Sprint 39)**
`ASX_UNIVERSE` is *today's* constituents; backtests silently exclude delisted/relegated names.
Amber disclosure panel added to Technical backtest results and Walk-Forward methodology note (Sprint 39).
True point-in-time constituents require paid data or historical tracking — this remains an open data gap,
but the disclosure prevents the bias from misleading without warning.

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

### ✓ 1.9 Corporate-actions correctness — `M` · ★★ **(split + large-dividend detection shipped)**
Splits: detection + one-click auto-adjust shipped (Sprints 13/17). Large special dividends / capital
returns: `GET /api/portfolio/capital-returns-check` (Sprint 39) flags payments ≥5% of current price
in the last 90 days; Portfolio page shows orange warning. Remaining open: mergers/takeovers (stock →
cash at premium) and capital returns affecting CGT cost base require manual entry; yfinance does not
tag these as distinct corporate-action types.

### ✓ 1.10 Data-staleness guards — `S` · ★★ **SHIPPED**
`fetched_at` stamped on quote responses. `⚠ stale` badge in portfolio table when >25 min. See §0.

### 1.11 Regime-change calibration penalty — `S` · ★★
When `classifyRegime()` detects a regime flip, the current calibration still heavily weights data from the outgoing regime (e.g. 60d half-life in sideways means old `riskOn` trades still dominate for weeks). Add a transient decay multiplier: on flip, divide the effective half-life by 2 for the first 5–10 trades in the new regime until ESS recovers above 2.5. Wire into `_calib_compute()` using a `regime_flipped_at` timestamp stored in `blob_store` by `fetchAndClassifyRegime()` whenever the regime changes.
*Source: critics.md §2D*

### 1.12 Virtual-outcome time-decay weighting — `S` · ★
`_resolve_virtual_outcomes()` currently marks all virtual outcomes equally regardless of how long the price took to reach target. A virtual win resolved in 2 days is a stronger signal than one that drifted there over 29 days. Add `virtual_speed_weight = min(1.0, 7.0 / max(1, hold_days))` computed at resolution time, stored as a new `virtual_speed_weight` column on `ai_learning_events`, and applied as an additional multiplier in `_calib_compute()` alongside the existing time-decay weight.
*Source: critics.md §3.2*

---

## 2. New features & usefulness  ← the main ask

Concrete, ASX-and-personal-trading-specific features. Grouped by theme. Most build on engines that
already exist (quant, regime, learning, dividends, CGT).

### 2.1 Portfolio management

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Watchlist** (separate from holdings) | S | ★★★ | **SHIPPED** — `js/pages/watchlist.js`, `state.watchlist`, scanner ⭐ integration. See §0. |
| ✓ **Target allocations + drift alerts** | M | ★★ | **SHIPPED** — `state.targetAllocations`, `_buildTargetAllocCard()` on Risk page; amber/red when |drift| ≥5%/10%. See §0. |
| ✓ **Multiple portfolios / accounts (account tagging)** | M | ★★ | **SHIPPED Sprint 42** — `account` field on holdings (`personal`\|`super`\|`trading`), `state.activeAccount` filter. Portfolio page: account filter tabs, account badge per row (click to cycle), account prompt in Add Holding dialog. `mergedPortfolio()` filters by `state.activeAccount`. Analysis prompt includes `Account: SUPER` header when not 'all'. Cash stays single for now (full per-account cash in a future pass). |
| ✓ **Cash & term-deposit tracker** | S | ★★ | **SHIPPED** — `state.termDeposits`, `_buildCashTrackerCard()` on Dashboard; idle cash + TD maturities + deployable ≤30d total. See §0. |
| ✓ **Performance attribution** | M | ★★ | **SHIPPED** — `_buildAttributionCard()` in `performance.js`: P&L by sector and by regime at entry. See §0. |
| ✓ **Benchmark comparison** | S | ★★ | **SHIPPED** — ^AXJO overlay on Value History canvas; normalized to portfolio start value. See §0. |

### 2.2 Tax & income (ASX-specific)

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **CGT-discount countdown** | S | ★★★ | **SHIPPED** — urgency banner in CGT page + sell warning in checklist. See §0. |
| ✓ **Tax-loss-harvest planner** | M | ★★★ | **SHIPPED** — card on CGT page; ranks losers by unrealised loss; EOFY countdown; wash-sale flag. See §0. |
| ✓ **Dividend income forecast + franking credits** | M | ★★ | **SHIPPED** — `_buildDivForecastCard()` in `performance.js`: per-stock income, grossed-up at 30% corp tax, franking credits, frequency, yield on cost. See §0. |
| ✓ **Franking-credit optimiser (45-day rule)** | M | ★★ | **SHIPPED** — `_buildFranking45DayCard()` on CGT page; iterates open parcels, warns when 45-day continuous-holding rule is at risk. See §0. |
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
| ✓ **Economic calendar** | M | ★★ | **SHIPPED** — `_buildEconomicCalendarCard()` on Dashboard; 45-day window with RBA dates, ex-div, earnings. See §0. |
| ✓ **Seasonality view** | M | ★ | **SHIPPED** — `GET /api/seasonality/<ticker>` + 12-bar card on Signals detail view. See §0. |
| ✓ **A-VIX / volatility gauge** | S | ★★ | **SHIPPED** — `asx_vol_20d` (20d realized vol of ^AXJO) in `/api/macro`; "A-VIX (ASX 20d)" card on Macro page; feeds two regime votes. See §0. |
| ✓ **Regime overlay on trade history** | S | ★★ | **SHIPPED** — coloured regime badge per journal row. See §0. |

### 2.5 Risk management

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Scenario / stress test** | M | ★★★ | **SHIPPED** — card on Risk page; shock presets + custom; per-holding beta × shock table. See §0. |
| ✓ **Trailing & ATR-based stops** | M | ★★★ | **SHIPPED** — 2×ATR14 stops card on Risk page; one-click "Set Alert". See §0. |
| ✓ **Correlation-aware sizing (sector)** | S | ★★ | **SHIPPED** — `_sectorConcentrationWarning(rec)` shows amber/red badge on BUY recs when the rec's sector already exceeds threshold. See §0. |
| ✓ **Correlation-aware sizing (exact)** | M | ★★ | **SHIPPED** — `analysis.js` fetches `/api/risk` post-analysis; reduces BUY qty 30% (|corr|>0.7) or 50% (|corr|>0.85); ⚡ Corr badge on rec cards. See §0. |
| ✓ **Risk-budget dashboard** | S | ★★ | **SHIPPED** — heat gauge at top of Risk page, configurable % budget. See §0. |
| ✓ **Drawdown monitor + alert** | S | ★★ | **SHIPPED** — current + max drawdown from portfolio history; alert banner + configurable threshold. See §0. |

### 2.6 Workflow & discipline

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Pre-trade checklist** | S | ★★★ | **SHIPPED** — 6-item modal gate (Sprint 42 added profit-harvest/risk-management item), requires ≥4 ticks. See §0. |
| ✓ **Thesis capture** | M | ★★★ | **SHIPPED** — textarea on rec cards, captured at execution, passed to learning loop as `trade_thesis`, shown in journal tooltip. See §0. |
| ✓ **Thesis review at exit** | S | ★★★ | **SHIPPED** — `_showThesisReview()` in `recommendations.js` fires `<dialog>` on full position close; 3-verdict buttons post to `/api/learning/outcome`. See §0. |
| ✓ **Broker CSV import** | M | ★★★ | **SHIPPED** — CommSec/SelfWealth/generic detection; backend parses, normalises, returns rows. See §0. |
| ✓ **Trade tags & notes** | S | ★★ | **SHIPPED** — `tags`/`trade_thesis` DB columns + inline input on rec cards + stored in learning events. See §0. |
| ✓ **Morning briefing auto-generate** | M | ★★ | **SHIPPED** — `'briefing'` agent type; Dashboard "Generate Brief" button chains macro + regime + holdings. See §0. |
| **Lessons: market-breadth scope** | M | ★★ | Add `breadth_scope` field to `ai_learning_lessons` table (e.g. `adl_below_0.3`, `high_vol`). `GET /api/learning/lessons` filters by current `advance_decline_ratio` and `asx_vol_20d` alongside existing ticker/sector/regime scopes. Example: "When ADL<0.3, ignore bullish RSI divergences." *Source: critics.md §3.1* |
| **Lessons: auto-generate from calib-quality** | M | ★ | After `triggerCalibQualityIfStale()` completes, if the Ollama output identifies a recurring failure mode (e.g. "chasing breakouts in low volume"), surface a toast prompt: *"Create a lesson from this? [pre-filled rule]"*. Requires extracting a `suggested_lesson` field from the `/api/debate/calib-quality` structured response. *Source: critics.md §3.1* |

### 2.7 AI assistant enhancements

| Feature | Effort | Impact | Idea |
|---|---|---|---|
| ✓ **Portfolio-aware Q&A** | M | ★★ | **SHIPPED** — `sendChat()` now injects regime + macro context (VIX, ASX200, sentiment, AUD/USD) into system prompt. See §0. |
| ✓ **Postmortem digest** | S | ★★ | **SHIPPED** — `GET /api/learning/digest-data` + "Generate Digest" on Learning page. See §0. |
| ✓ **Local-LLM fallback** | M | ★ | **SHIPPED Sprint 41** — `POST /api/debate/quick-analysis` in `routes/debate.py`; `_callLocalAnalysis()` in `claude-client.js`; toggled via Settings → "Use local LLM for analysis"; BUY/TOP_UP/HOLD only; `🔒 Local` badge on rec cards; now also writes to `ai_call_log` with `agent_type='portfolio:local'` (Sprint 42). |
| ✓ **Prompt A/B tracking** | M | ★★ | **SHIPPED** — Prompt Version History table on Learning page; Δ vs prev column (pp delta + ↑/↓/↔); "current" badge; realised P&L column. See §0. |
| **Local LLM SELL/TRIM support** | L | ★★★ | Extend `_LOCAL_ANALYSIS_SYSTEM` and `_SCHEMA_QUICK_ANALYSIS` in `routes/debate.py` to allow SELL/TRIM with a simplified tag set (primary_driver only; no secondary_factors initially). Use a larger pulled model (e.g. `qwen3:14b`) for exits. Critical gap: in a correction, `useLocalLLM=true` produces no exit signals — user must manually disable the toggle for any SELL. *Source: critics.md §2A; also prompts.md §9 "Future enhancements"* |
| ✓ **"Why this rec?" traceability panel** | M | ★★★ | **SHIPPED Sprint 43** — collapsed `<details>` on each pending rec card. Shows regime + conf at generation time, 9 signal chips (RSI/ADX/BB%B/ATR/Score/OBV/MACD/Vol×/RS), calibration nudge block (≤350 chars), and cached Ollama debate synthesis. Context attached to rec in `analysis.js` via `_genRegime`, `_calibSnap`, `_signalsSnap` fields. |

---

## 3. Reliability & engineering (personal-grade)

You don't need multi-user infra, but you *do* want it to not lose your data or break mid-session.

### ✓ 3.1 Data-source resilience — `M` · ★★★ **COMPLETE Sprint 42**
Three lines of defence: (1) `fetch_with_retry()` in `core.py` — exponential backoff (3×, 2s/4s/8s);
(2) `_last_good` stale-cache per key — serves the last successful result on full retry exhaustion;
(3) `stooq_quote()` in `core.py` — Stooq CSV price fallback when `_last_good` is also empty (fresh
server start with yfinance down). Wired into `_quote_cached()` and `_macro_payload._fetch_symbol()`.
OHLCV history fallback via `_fetch_stooq_history()` in `indicators.py` was already live.
Coverage: all ASX equities (`.AX` → `.au`), `^AXJO`, S&P500, NASDAQ, VIX, US10Y, AUD/USD, gold,
oil, copper, sector ETFs. Not covered: iron ore (`TIO=F`) and SPI200 futures (`YAP=F`) — not on Stooq.

### ✓ 3.2 Automated local backups — `S` · ★★★ **SHIPPED**
Daily backup on startup + daemon thread. Keeps last 7. See §0.

### ✓ 3.3 Real frontend tests — `M` · ★★ **SHIPPED Sprint 19**
122 Vitest unit tests for pure engine files (`quant-engine`, `regime-engine`, `response-validator`,
`_detectExitReason` in both `recommendations.js` and `performance.js`). `npm run test:js`. See §0.

### ✓ 3.4 Performance / responsiveness — `S` · ★★ **COMPLETE Sprint 41**
Macro endpoint fully parallelised (Sprint 8). Polymarket parallelised + loading state (Sprint 39).
Earnings calendar parallel with 4h per-ticker TTL (Sprint 39). RBA rate wrapped in `@ttl_cache(seconds=21600)` (Sprint 40). Signals page optimistic rendering (Sprint 40).
Macro page optimistic rendering: `renderMacroPage(gen)` renders cached state immediately; if `state.macroData` is >5 min stale, a silent background `GET /api/macro` fires and re-renders on completion with a "⟳ Refreshing…" badge (Sprint 41). Dashboard and Macro page auto-kick `fetchEarningsCalendar()` when the calendar is unpopulated (Sprint 41).

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

### ✓ 3.8 Hoist `_detectExitReason` to `utils.js` — `S` · ★★★ **SHIPPED Sprint 43**
Single canonical copy now in `js/utils.js`. Both page files reference it via the shared global. Tests updated.

### ✓ 3.9 `FACTOR_WEIGHTS` normalization guard — `S` · ★ **SHIPPED Sprint 43**
`indicators.py` emits `warnings.warn` at import if `sum(FACTOR_WEIGHTS) != 100`.

### ✓ 3.10 Stooq rate-limit semaphore — `S` · ★★ **SHIPPED Sprint 43**
`_stooq_sem = threading.BoundedSemaphore(1)` in `core.py`; both `stooq_quote()` and `_fetch_stooq_history()` acquire it with a 1-second `finally` sleep.

---

## 4. UX & quality of life

| Item | Effort | Impact | Notes |
|---|---|---|---|
| ✓ **Mobile responsive layout** | L | ★★ | **SHIPPED Sprint 39** — sidebar overlay + hamburger, grid single-column at 768px, auto-close on nav. |
| Onboarding & empty states | S | ★ | First-run setup (key, cash, import) and friendly empty cards. Portfolio first-run state shipped (Sprint 18); full wizard out of scope for personal tool. |
| ✓ **Keyboard shortcuts** | S | ★ | **SHIPPED** — `g`+letter page navigation + `?` shortcut help `<dialog>`. See §0. |
| ✓ **Dark/light + density toggle** | S | ★ | **SHIPPED** — compact mode (`.compact` body class, Settings → Display). See §0. |
| ✓ **In-app changelog / version banner** | S | ★ | **SHIPPED** — Settings → "What's New" collapsible sprint history + App Info card (version/uptime/last backup). See §0. |
| ✓ **Consistent loading/error states** | S | ★ | **SHIPPED Sprint 40** — signals page now renders stale data immediately + background refresh with "⟳ Refreshing…" badge; only shows spinner on first cold load. Risk page (Sprint 18) + performance page already had error+retry pattern. |

---

## 5. Suggested sequencing

1. ✓ **Trust the numbers first:** §1.3 Wilson CI, §1.4 Brier score, §1.2 slippage — **done**. Remaining: §1.1 look-ahead bias, §1.5 survivorship bias.
2. ✓ **Don't lose data:** §3.2 backups, §3.1 retry + stale-cache + Stooq fallback — **done Sprint 42**.
3. ✓ **Highest daily payoff:** pre-trade checklist, CGT countdown, trade tags, heat gauge, drawdown monitor, Telegram, broker CSV, indicator alerts, tax-loss planner, EOFY pack, watchlist, morning briefing, regime journal, stale nudge — **all done**.
4. ✓ **Deepen the edge:** §2.5 stress test / trailing stops / breadth signal — **done**. ✓ §1.7 walk-forward backtest — **done Sprint 20**. ✓ §2.5 correlation-aware sizing — **done Sprint 8**.
5. ✓ **Sprint 6 shipped:** §2.7 portfolio-aware Q&A, §2.1 performance attribution, §2.5 sector-concentration warning, §2.6 thesis capture, §2.2 dividend forecast + franking credits — **all done**.
6. ✓ **Sprint 7 shipped:** thesis review at exit, prompt-version P&L, target allocations + drift alerts, economic calendar (RBA dates + ex-div + earnings), franking 45-day rule warnings — **all done**.
7. ✓ **Sprint 8 shipped:** A-VIX (ASX realized vol), cash/TD tracker, exact correlation-aware sizing, macro endpoint perf (3 serial fetches eliminated), keyboard shortcuts (`g`+letter + `?`) — **all done**.
8. ✓ **Sprint 9 shipped:** Prompt+response logging (ai_call_log, full prompt in every call), side-by-side compare page, prompt version A/B delta, ETF earnings filter, App Info card — **all done**.
9. ✓ **Sprint 12 shipped:** §1.1 look-ahead bias (AI Replay fixed to nominal prices; strategy backtest disclosed as total-return), TRIM/SELL ATR stop floor, intraday Extreme Mode, intraday dynamic UI updates, Groq/Gemini key consolidation, neutral debate synthesis — **all done**.
10. ✓ **Sprint 13 shipped:** compact/density mode, in-app changelog, macro loading state, corporate-actions split detection, liquidity-scaled slippage — **all done**.
11. ✓ **Sprint 14 shipped:** signals page candlestick chart, journal monthly P&L bar chart, portfolio sector sidebar (replaced canvas donut), numpy.bool_ JSON serialization fix, Learning Loop table alignment + dark-theme button colors — **all done**.
12. ✓ **Sprint 17 shipped:** monthly seasonality card (Signals page detail), CGT split auto-adjust with one-click Apply button (Portfolio) — **all done**.
13. ✓ **Sprint 18 shipped:** `_retryBtn`/`_emptyCard` utils helpers, risk.js error banner + retry, performance.js equity-curve error card, portfolio first-run empty state — **all done**.
14. ✓ **Sprint 19 shipped:** Vitest JS test suite (122 tests, `npm run test:js`), `_detectExitReason` cross-file test coverage — **all done**.
15. ✓ **Sprint 20 shipped:** Walk-forward backtesting engine (`POST /api/backtest/walk-forward`, Walk-Forward tab, fold-by-fold table + OOS equity curve) — **all done**.
16. ✓ **Sprint 21 shipped:** Factor stability / overfitting guard (`POST /api/scanner/factor-stability`, Factor Stability tab), security hygiene (localhost bind, CORS, security headers) — **all done**.
17. ✓ **Sprint 22 shipped:** Cloud adjudicator provider picker (Gemini/Groq/Claude, picker modal) — **all done**.
18. ✓ **Sprint 23 shipped:** Ollama structured outputs (`format_schema`), ESS calibration gates, signal flattening, SQLite timeout 10→30s, Phase 3 docs corrected — **all done**.
19. ✓ **Sprint 24 shipped:** Blind adjudication, JS Ollama priority queue, skill-weight centering at 5, hierarchical regime fallbacks — **all done**.
20. ✓ **Sprint 25 shipped:** Volatility-adaptive half-life, SQLite startup maintenance, Phase 6 design spec — **all done**.
21. ✓ **Sprint 26 shipped:** Phase 6 calibration quality debate card (`GET /api/debate/calib-quality`, traffic-light UI, `triggerCalibQualityIfStale`) — **all done**.
22. ✓ **Sprint 27 shipped:** Success tag calibration nudge (step 6b in `_calib_compute`), `success_patterns` in stats, Success Patterns UI card — **all done**.
23. ✓ **Sprint 37–38 shipped:** Sell tag outcome tracking (Gap 3), `better_opportunity` cross-check (Gap 7), sell tag calibration injection (Part 9), Section 6 SELL_TAG prompt rules, calibration cache thread lock, Phase 8 Mann-Whitney gate, Kelly rejection, regime-aware stopAtrMult, 30-min blend on regime flip, SPI200 futures vote, `_sanity_check()` in indicators, `pre_earnings_risk` flag — **all done**.
24. ✓ **Sprint 39 shipped:** `_preEarningsAdj` badge fix, earnings-calendar 4h TTL cache, survivorship-bias disclosures (§1.5), capital-returns-check endpoint (§1.9 partial), mobile responsive layout (§4).
25. ✓ **Sprint 40 shipped:** RBA rate 6h in-memory `ttl_cache` wrapper (`_rba_rate_cached`); signals page optimistic stale rendering + background refresh; §4 table docs cleanup (keyboard shortcuts, density mode, in-app changelog marked ✓).
26. ✓ **Sprint 41 shipped:** Macro page optimistic stale rendering (`renderMacroPage(gen)`, silent background fetch, `_macroRefreshing` badge); earnings calendar auto-fetch on Dashboard + Macro navigation; `state.earningsLastFetch` + dashboard re-render in `fetchEarningsCalendar()`; §3.4 fully complete.
27. ✓ **Sprint 42 shipped:** `high_60d`/`low_60d` forwarded to Claude in `analysis.js` (`Range60d` line); `_dtBuildRecs()` Signal #4 updated to actual Fibonacci zone (with `return_60d` fallback); Stooq price fallback (`stooq_quote` in `core.py`) wired into `_quote_cached()` and `_macro_payload()` — third line of defence when yfinance fails and `_last_good` is empty; doc fixes in `learning_loop.md` and `prompts.md` (Phase 8 live, day-trade Claude prompts marked dormant, Phase 3 neutral synthesis terminology).
28. ✓ **Sprint 42 shipped:** `high_60d`/`low_60d` forwarded to Claude in `analysis.js` (`Range60d` line); `_dtBuildRecs()` Signal #4 updated to actual Fibonacci zone (with `return_60d` fallback); Stooq price fallback (`stooq_quote` in `core.py`) wired into `_quote_cached()` and `_macro_payload()` — third line of defence when yfinance fails and `_last_good` is empty; doc fixes in `learning_loop.md` and `prompts.md` (Phase 8 live, day-trade Claude prompts marked dormant, Phase 3 neutral synthesis terminology); pre-trade checklist 6th item (profit harvest / risk management); executed-rec button immediate feedback; `max_tokens` raised to 8,000; `unrealised_loss_large` enforcement line + SELL exit semantics in `ANALYSIS_SYSTEM_PROMPT`.
29. ✓ **Sprint 43 shipped:** §3.8 `_detectExitReason` hoisted to `utils.js`; §3.10 Stooq rate-limit semaphore; §3.9 `FACTOR_WEIGHTS` guard; §2.7 "Why this rec?" traceability panel.
30. ✓ **Sprint 44 shipped:** §1.11 regime-change calibration penalty; §1.12 virtual-outcome speed weighting; §2.6 lessons breadth scope; §2.6 DRP parcel tracking.
31. **Open:** §2.7 local LLM SELL/TRIM (L, ★★★), §2.6 lessons auto-generate (M, ★), §1.9 mergers/takeover CGT (no yfinance tag), §3.7 ES-modules (deferred).

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
