# CLAUDE.md — Sloth ASX Trader

Operator handbook for Claude Code sessions in this repo. Keep this updated when major architecture changes land.

---

## What this app is

A local-only decision-support tool for Australian equity trading. No SaaS, no cloud DB.
- **Backend:** Python Flask (`asx_server.py`) on `localhost:5000`. Fetches market data via `yfinance`. Persists everything in SQLite (`asx_trader.db`, WAL mode).
- **Frontend:** Vanilla JS single-page app (`asx_trading.html`). Talks to backend, calls Anthropic API directly from the browser, renders with `<canvas>` (no chart libraries).
- **AI:** Claude Sonnet 4.6 for analysis, recommendations, day trading; Gemini for ASX announcements; local Ollama for news + internal "debate" pre-analysis.

---

## Run instructions

```bash
pip install -r requirements.txt

# Dev (single-worker, autoreload-free)
python asx_server.py
# Then open asx_trading.html in a browser.

# Production-grade (multi-worker, threaded)
pip install gunicorn
gunicorn -c gunicorn.conf.py 'asx_server:app'
```

API key options (one of these is required for analysis):
1. **Direct mode (default)**: paste Anthropic key in Settings → kept in `localStorage`.
2. **Proxy mode (opt-in)**: `POST /api/claude/settings {api_key}` once; set `state.settings.useBackendProxy = true`. Key lives in SQLite, never touches the browser.

Tests:
```bash
python test_app.py        # all Python tests (backend + frontend syntax/function checks)
npm run test:js           # Vitest suite — 122 JS unit tests for pure engine files
```

---

## Architecture — AI pipeline

Every recommendation flows through four deterministic layers:

```
Signals (indicators.py) ──► Regime gate (regime-engine.js) ──► Claude ──► Quant engine (quant-engine.js) ──► Validator (response-validator.js) ──► UI
                            (deterministic)                   (LLM)      (deterministic)                    (deterministic)
```

| Layer | Job |
|---|---|
| **Regime engine** | Classifies macro (`riskOn/riskOff/panic/highVol/trend/sideways`) from live data; gates which strategies are allowed; applies size modifiers. Panic regime returns `sizeMult=0` → `_regimeBlocked` flag, recs are dropped. Each regime now carries a `stopAtrMult` (2.5–4.0×) and a `_blendedSizeMult` that linearly transitions over 30 min after a flip to prevent cliff-edge sizing. SPI200 futures (`spiChg`) vote in the classifier as a same-session lead indicator. |
| **Claude** | Qualitative conviction only — what to buy/sell and why. Never does arithmetic. User message always includes `TAX_LOSS_HARVEST_ACTIVE` (bool), date, time, and current regime. |
| **Quant engine** | Deterministic sizing: Kelly + vol scalar + multi-constraint (account-risk %, max-position %, liquidity, Kelly). Rejects on `kellyFrac ≤ 0` (negative EV) before applying `minQty` floor. Stop distance = `stopMultiple × earningsAdj × ATR` where `stopMultiple` comes from the current regime's `stopAtrMult` and `earningsAdj = 1.3` when `signals.pre_earnings_risk = true`. Same input → same output. |
| **Validator** | Schema + business rules; auto-repair loop (≤2 retries); HOLD recs use `requiredUnless` to skip target/stop/qty checks. |

Calibration feedback (recent hit rates by confidence band and regime) is fetched from `GET /api/learning/calibration` and injected into every Claude user message.

---

## File map

### Backend (Python)

| File | Lines | Purpose |
|---|--:|---|
| `asx_server.py` | ~205 | Flask app + middleware + blueprint registration + `__main__` bootstrap. **Holds no routes itself.** |
| `core.py` | ~230 | Shared infrastructure: `ttl_cache`, `fetch_with_retry` (exponential backoff + `_last_good` stale-cache), `_HTTP_SESSION`, `log`, `LOG_DIR`, `SECTOR_MAP`, `ASX_UNIVERSE`, `OLLAMA_BASE`. No Flask import. |
| `db.py` | ~270 | SQLite schema, `get_db()`, `init_db()`, migrations, `log_failed_ticker()`, `backup_db(keep=7)`. Single source of truth — never `sqlite3.connect()` directly. `init_db()` runs `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` on every startup (non-blocking; prevents index-stat decay and WAL bloat). |
| `indicators.py` | ~750 | All technical indicators + `analyse_ticker()` + `_score_ticker()`. Pure compute, no Flask. `_drop_forming_bar(hist)` drops the current-day candle before 07:00 UTC to avoid incomplete intraday bars. `_sanity_check(hist, ticker)` drops bars with >25% single-day close move (data errors / unadjusted splits) — called after `_drop_forming_bar` in `analyse_ticker()`. `_fetch_stooq_history(ticker, period)` is a free fallback provider (stooq.com, no API key) used when yfinance returns empty. `FACTOR_WEIGHTS` dict (trend/pullback/volume/momentum/rs) controls `_score_ticker()` weights — update after running `POST /api/scanner/factor-stability` to apply empirical IC values. `analyse_ticker()` now returns `days_to_earnings` (int or None) and `pre_earnings_risk` (bool: true when ≤14 days to next earnings). |
| `announcement_engine.py` + `announcement_routes.py` | — | ASX announcements scraper, PDF parser, Gemini scorer, blueprint `/api/announcements/*`. |
| `news_engine.py` | — | RSS aggregator, TF-IDF dedup, LLM sentiment classifier (Ollama/Groq/Gemini). |
| `gunicorn.conf.py` | — | Production WSGI config. 2 workers × 8 threads. |
| `test_app.py` | ~2300 | 238 unit + integration tests. Patches `get_db` across `db`, `asx_server`, and every `routes/*` module. |

#### `routes/` — one blueprint per concern

| File | Lines | URL prefix(es) | Notes |
|---|--:|---|---|
| `routes/portfolio.py`  | ~410 | `/api/cash`, `/api/db/*`, `/api/tax/eofy-pack`, `/api/portfolio/splits-check` | Bulk state save/load, cash balance, EOFY tax pack ZIP download. `GET /api/portfolio/splits-check?tickers=...` — uses `yf.Ticker.splits` to detect splits in the last 90 days; returns `{TICKER:[{date,ratio}]}`. |
| `routes/dividends.py`  | ~395 | `/api/dividends/*`                              | yfinance + ASX scrape, 12 h cache, `_FRANKING_MAP` fallback. |
| `routes/market.py`     | ~750 | `/health` (+ version/uptime/last_backup), `/api/{analyse,quote,macro,rba-rate,polymarket,risk,portfolio/nav-history,earnings-calendar,log/ai_response,log/ai_calls,log/ai_call/<id>}` | All yfinance read-only data + full prompt+response logging. ETFs skipped in `/api/earnings-calendar` via quoteType check. Uses `@ttl_cache`. |
| `routes/backtest.py`   | ~610 | `/api/backtest`, `/api/backtest/ai-replay`     | Historical strategy backtest + replay scoring of executed AI recs. Supports `slippage_mode: 'flat'|'liquidity'`; liquidity mode applies ADV-tiered rates via `_adv_slippage(adv_aud)`. |
| `routes/scanner.py`    | ~210 | `/api/market/scan*`                              | Background thread + `_scan_state` dict, sector diversification. Computes `breadth_ratio` (% of universe above 20-day SMA) after each scan; consumed by `/api/macro` via lazy import. |
| `routes/learning.py`   | ~780 | `/api/learning/*`                                | Log → outcome → stats/calibration analytics. Decay-weighted win rates with volatility-adaptive half-life (`_HL_MAP`, 20–60d). `_calib_compute()` is a pure function, 5-min TTL cache protected by `_calib_lock` (threading.Lock — guards concurrent gunicorn threads). Calls `_resolve_virtual_outcomes(conn)` (price-checks unexecuted recs ≥30d old → `virtual_win`/`virtual_loss`) and `_resolve_sell_outcomes(conn)` (validates SELL tags ≥25d old → `sell_verify_verdict`). Phase 8 gate uses `_mann_whitney_z(wins, losses)` (Mann-Whitney U, no normality assumption) instead of raw means. Step 6b: dominant success tag nudge. Stats response includes `success_patterns`, `phase8_meta.mann_whitney_z`. `GET /api/learning/sell-outcomes` — executed SELL/TRIM events with driver verdicts. `GET /api/learning/lessons` / `POST /api/learning/lessons` / `DELETE /api/learning/lesson/<id>` — scoped persistent trading lessons (ticker/sector/regime) injected into Claude user messages. `GET /api/learning/tag-reviews` / `POST /api/learning/tag-review` / `GET /api/learning/tag-accuracy` — Gap 6 tag spot-check: `tag_reviews` table, 5-event weekly batch, agree/disagree/retag UI, `agree_rate` gates the `top_err` calibration nudge. When `agree_rate < 0.60`, auto-tagged events excluded from error pattern section; `⚠AUTO_TAGS_UNRELIABLE` token emitted instead. `GET /api/market/universe-health` — universe staleness check (Settings App Info card). |
| `routes/debate.py`     | ~1100 | `/api/debate/*`                                  | Local Ollama bull/bear + postmortem + skill scoring + calibration quality debate. Direction-aware prompts (BUY vs SELL/TRIM). Uses `current_app.logger`. Sprint 26 added `GET /api/debate/calib-quality` (Phase 6) with `_norm_cdf`, `_calib_bands_raw`, `_calib_quality_prompt`, `_SCHEMA_CALIB_QUALITY`. |
| `routes/news.py`       | ~690 | `/api/news/*`, `/api/groq/models`, `/api/google/models`, `/api/sbc-mode`, `/api/system/gpu`, `/api/ollama/start` | RSS scanner + LLM provider management + SBC toggle. Owns `_NE_OK`. |
| `routes/claude.py`     | ~85  | `/api/claude/*`                                  | Backend proxy for the Anthropic API (opt-in). |
| `routes/alerts.py`     | ~100 | `/api/alerts/*`                                  | Telegram off-device alerts. `POST /api/alerts/telegram` (send), `POST /api/alerts/telegram/save` (persist creds to settings table), `GET /api/alerts/config` (has_telegram?). Credentials stored in `settings` table as `tg_token`/`tg_chat_id` — never logged. |
| `routes/import_csv.py` | ~200 | `/api/import/csv`                                | Broker CSV parser. Auto-detects CommSec / SelfWealth / generic format; normalises to `{action, ticker, shares, price, date, brokerage}`. Returns BUY rows only; SELL rows reported as skipped (require manual entry). |
| `routes/intraday.py`   | ~270 | `/api/intraday/<ticker>`, `/api/intraday/scan`  | ASX100 intraday day-trade strategy. `GET /api/intraday/<ticker>` — single ticker 5m analysis (2-min TTL). `POST /api/intraday/scan` — batch scan up to 100 tickers with 8-thread pool. Returns VWAP, intraday RSI, volume acceleration, setup score 0–100, `passes` bool (entry window + VWAP + RSI + score gates). |

Total: **12 blueprints, ~95 routes** (including announcements blueprint). Sprint 38 added sell-outcomes, lessons, untagged, SPI200. Sprint 39 added `GET|POST /api/learning/tag-review(s)`, `GET /api/learning/tag-accuracy`, `GET /api/market/universe-health`.

### Frontend (JS) — load order matters

Scripts in `asx_trading.html` load in this order. Anything that uses globals from a later file will be `undefined` at parse time but works at call time (functions hoist; lookups are runtime).

```
config.js → utils.js → regime-engine.js → learning-loop.js → quant-engine.js
→ api.js → portfolio-helpers.js → scheduler.js → reconcile.js → prices.js → charts.js
→ pages/dashboard.js → pages/portfolio.js → pages/macro.js → pages/signals.js
→ pages/recommendations.js → pages/journal.js → pages/cgt.js → pages/performance.js
→ pages/backtest.js → pages/risk.js → pages/assistant.js
→ prompts.js → prompt-modules.js → claude-client.js → debate-client.js
→ response-validator.js → analysis.js
→ asx-universe.js → strategy.js → intraday-strategy.js → day-trading-analysis.js → pages/day-trading.js
→ pages/news.js → pages/announcements.js → pages/scanner.js → pages/watchlist.js → pages/compare.js → pages/learning.js
→ pages/settings.js → alerts.js → navigation.js → init.js
```

**Don't reorder these without checking dependencies.** A future ES-modules migration would make this safer (see "Deferred work" below).

### Infrastructure modules (the non-page JS)

| File | Owns |
|---|---|
| `js/config.js` | Global `state` object, `API` base URL, defaults |
| `js/api.js` | All backend fetch wrappers + `saveStateToDb()` / `loadStateFromDb()` with input validators |
| `js/claude-client.js` | `callClaude(agentType, msg, opts)` — central wrapper; supports direct + proxy mode. Agent types: `portfolio`, `analyst`, `pm`, `dayTrade`, `universe`, `macro`, `assistant`, `briefing`. |
| `js/regime-engine.js` | `classifyRegime()`, `applyRegimeModifiers()`; panic regime hard-blocks via `_regimeBlocked`. `getRegimeModifiers()` now returns `stopAtrMult` (2.5 riskOn/trend/sideways · 3.0 highVol · 3.5 riskOff · 4.0 panic). `_blendedSizeMult` linearly interpolates the old→new `sizeMult` over 30 min on regime flip to prevent cliff-edge sizing. SPI200 futures (`macroData.spi200_futures_chg`) cast a vote in `classifyRegime()`. |
| `js/quant-engine.js` | `computeTradeParams()` — deterministic sizing. Rejects when `kellyFrac ≤ 0` (negative EV) before `minQty` floor applies. Stop distance = `regimeMod.stopAtrMult × earningsAdj × ATR`; `earningsAdj = 1.3` when `signals.pre_earnings_risk`. Reads `signals.adv_20` (AUD) and `signals.volume_avg_20` (shares); liquidity cap is in shares. Returns `_preEarningsAdj: true` flag on the rec when earnings adjustment fires. |
| `js/response-validator.js` | `validateRec()`, `getValidatedAnalysisWithRepair()`. Ticker pattern accepts `[A-Z0-9]{2,5}`. Fields use `requiredUnless: 'HOLD'`. |
| `js/learning-loop.js` | Client-side calibration analytics + `fetchCalibrationBlock()` from backend. |
| `js/prompts.js` | All Claude system prompts (`ANALYSIS_SYSTEM_PROMPT`, `MACRO_SYSTEM_PROMPT`, `MORNING_BRIEFING_SYSTEM_PROMPT`, day-trade prompts, analyst/PM prompts) |
| `js/prompt-modules.js` | `RULE_MODULES` (tax-loss, CGT, reporting season, regime-specific) + dynamic system-prompt assembly |
| `js/strategy.js` | `DT_FILTER` (pre-filter thresholds) + `DT_AI_PARAMS` (AI-phase params). Both editable at runtime via Day Trading → Rules. |
| `js/analysis.js` | Portfolio analysis orchestration — fetches signals, builds prompt, calls Claude, post-processes through quant engine + validator + regime modifiers. |
| `js/day-trading-analysis.js` | Day-trade portfolio scan + universe scan orchestration. |
| `js/navigation.js` | `showPage()` + `renderPage()` with error boundary (any page crash falls back to a graceful error card). |
| `js/alerts.js` | `fireAlert(title, body, tag)` — desktop notification + optional Telegram mirror when `state.settings.telegramEnabled`. `checkRecStopTargetAlerts` tracks `_stopAlertedAt`/`_targetAlertedAt` to prevent spam. |
| `js/prices.js` | `refreshPrices()` — fetches live quotes, stores `fetched_at` timestamps per ticker in `state.priceTimestamps`. |

### Pages

`js/pages/*.js` — each is a render function `renderX()` plus event handlers. Most are pure HTML-string builders. `pages/scanner.js`, `pages/day-trading.js`, `pages/learning.js`, `pages/news.js`, `pages/announcements.js` have async pollers — `navigation.js` stops them on page change. `pages/watchlist.js` renders the Watchlist page (⭐ nav item); fetches live signals async per ticker and hosts the indicator-alert creation UI. `pages/compare.js` renders the side-by-side compare tab (g+x shortcut, or Scanner → ↔ Compare tab); calls `POST /api/analyse/batch`; `compareFromOutside(tickerList)` lets other pages pre-load tickers into it. The Compare tab lives inside Market Scanner as the third tab (`_scannerTab = 'compare'`); `showPage('compare')` in `navigation.js` transparently redirects to the Scanner page — no standalone sidebar nav item.

---

## Key data shapes

```js
state.portfolio:          [{ ticker, shares, avgPrice, currentPrice, sector }]
state.tradeJournal:       [{ id, date, ticker, action, qty, entryPrice, exitPrice, fees, pnl, status, recId, recExecuted, closeDate }]
state.recHistory:         [{ id, date, ticker, action, confidence, ensembleConfidence, priceRange, target, stopLoss, qty, executed, outcome, actualProfit, regime, _learningId, _thesis?, _stopAlertedAt?, _targetAlertedAt? }]
state.recommendations:    pending recs (same shape as recHistory entries with status='pending')
state.liveSignals:        { TICKER: { current_price, rsi_14, bb_*, atr_14, adv_20 (AUD), volume_avg_20 (shares), score, ... } }
state.currentRegime:      { regime, confidence, signals: [...], _blendedSizeMult?: number, _prevSizeMult?: number }
state.priceTimestamps:    { TICKER: ISO-string }  — fetched_at from last quote call; used for stale-data badge (>25 min)
state.portfolioHistory:   [{ date, netWorth, portfolioValue, cash }]  — daily snapshots; used for drawdown monitor
state.watchlist:          [{ ticker, addedAt, notes }]  — tickers monitored but not held; persisted in blob_store
state.savedScreeners:     [{ name, savedAt, config: { universe, min_adv_aud, excludeHoldings } }]  — named scanner presets; persisted in blob_store
state.priceAlerts:        [{ id, ticker, type, value, ... }]  — types include 'rsi_below'|'rsi_above'|'bb_breakout'|'bb_breakdown'|'volume_spike' (indicator alerts) in addition to 'above'|'below'|'pct_drop'
state.settings.telegramEnabled:   bool — mirrors alerts to Telegram when true
state.settings.tgToken / tgChatId: stored locally in state but credentials saved server-side via POST /api/alerts/telegram/save
state.settings.drawdownAlertPct:  number — alert threshold for drawdown monitor (default 10)
state.settings.compactMode:       bool — applies `.compact` CSS body class on startup; reduces card padding, row heights, button sizes (default false)
state._splitWarnings:             undefined | {} | { TICKER: [{date, ratio}] } — undefined = not yet checked, {} = checked (no splits), populated = splits found; cached per Portfolio page load
state._capitalReturnWarnings:     undefined | {} | { TICKER: [{date, amount, amount_pct, label}] } — undefined = not yet checked, {} = checked (none), populated = large distributions ≥5% of price; cached per Portfolio page load
state.targetAllocations:  { TICKER: number }  — ticker → target weight %; persisted in blob_store; used by Risk page drift card
state.termDeposits:       [{ id, label, amount, rate, maturityDate, notes }]  — idle cash + TDs; persisted in blob_store; Dashboard cash tracker
window._morningBrief:     { text, date } | undefined — last generated morning briefing note; lives on window so it survives renderPage() calls but clears on full page reload
```

**Critical:**
- `signals.adv_20` is **dollar turnover** (close × volume average).
- `signals.volume_avg_20` is **share count**.
- The quant engine's liquidity cap is in shares — it derives shares from `adv_20 / price` if `volume_avg_20` is unavailable.

---

## Learning Loop internals (the trade-outcome feedback path)

This is the most subtle subsystem. A recommendation's life-cycle spans three files and the backend `ai_learning_events` table.

### Life-cycle of a learning event

```
analysis.js logRecsToLearningLoop()        → POST /api/learning/log   (event created, was_executed=0)
   │  (rec gains rec._learningId)
recommendations.js markExecuted()           → POST /api/learning/outcome (was_executed=1, + outcome if it closed)
   │  on full-position close, reconciles parent BUY/TOP_UP events too
performance.js syncClosedTradesToLearningLoop()  → batch backfill for legacy recs lacking a _learningId; writes _learningId back to original state.recHistory entry after each successful log so scheduleSave() persists it (prevents re-logging on next Sync)
   │
routes/learning.py  _calib_compute() / stats   → decay-weighted win rates fed back into the next prompt
```

### Key functions

| Function | File | Contract |
|---|---|---|
| `markExecuted(id, price, fee, qty)` | `recommendations.js` | Records a fill: updates portfolio/CGT/journal, pushes a `recHistory` entry, then patches the learning event. For SELL/TRIM that **fully closes** a position, it loops the still-open parent BUY/TOP_UP events and stamps each a **per-entry** outcome (`tradePrice` vs that parcel's own `executedPrice`) — never the SELL's blanket outcome. |
| `_detectExitReason(exitPrice, stopLoss, target, action)` | `recommendations.js` **and** `performance.js` (identical copies) | Classifies the exit as `stop_hit` / `target_hit` / `manual`. **Direction-aware:** BUY/TOP_UP use a long frame (stop below, target above); SELL/TRIM use the inverse (stop above, target below). Pass the rec's `action`; absent that, it infers direction from `stop > target` geometry. |
| `triggerPostmortem(learningId)` | `debate-client.js` | Fired automatically on `loss`/`breakeven`. Runs the local Ollama bull/bear postmortem. Queued LOW priority via `_oqEnqueue`. |
| `fetchSkillScore(learningId)` | `debate-client.js` | Scores the closed trade's process quality 0-10. Queued LOW priority. |
| `triggerCalibQualityIfStale(regime)` | `debate-client.js` | Fires `GET /api/debate/calib-quality` once per calendar day (localStorage date guard). Called from `analysis.js` after `logRecsToLearningLoop()`. Queued LOW priority. *(Sprint 26)* |
| `fetchCalibrationBlock(regime, sectors, tickers)` | `learning-loop.js` | Pulls the compact calibration string from `GET /api/learning/calibration`; injected into every Claude user message. |
| `_calib_compute()` | `routes/learning.py` | Pure function, 5-min TTL cache (thread-safe: `_calib_lock`). Calls `_resolve_virtual_outcomes()` and `_resolve_sell_outcomes()` lazily. Decay-weighted win rate per confidence band; returns the `adj` nudge the prompt applies to confidence. Token-budget-ordered assembly: header → conf bands → regime warning → skill insight → conservatism warning → sell tags → success nudge → per-ticker. |
| `_resolve_virtual_outcomes(conn)` | `routes/learning.py` | Fetches price history for unexecuted recs ≥30d old; writes `virtual_outcome = 'virtual_win'/'virtual_loss'/'virtual_open'`. Prevents calibration from being censored to executed-only outcomes. |
| `_resolve_sell_outcomes(conn)` | `routes/learning.py` | For SELL/TRIM events ≥25d old with `sell_primary_driver` set, fetches post-sell price change (and alt ticker if `better_opportunity`). Writes `sell_verify_verdict` (`validated`/`invalidated`/`inconclusive`). Capped at 5 per calibration call. |
| `_mann_whitney_z(wins, losses)` | `routes/learning.py` | Phase 8 gate statistic. Replaces raw mean comparison — computes U statistic and z-score (no scipy needed). Phase 8 active when z > 1.28 (one-sided p < 0.10). |

### Gotchas specific to the Learning Loop

- **Per-entry outcome, not blanket.** When a position built from several BUY/TOP_UP parcels is closed by one SELL, each parcel's win/loss is judged against **its own** entry price. A TOP_UP bought above the eventual exit is a `loss` even if the overall position was green.
- **`exit_reason` is direction-aware** (see table). A profitable TRIM must not read as `stop_hit` just because the exit sits numerically below the (above-entry) stop. Backfill historical rows with the corrected logic if you change this function — `asx_trader.db` rows written before the fix are stale.
- **The helper is duplicated** in `recommendations.js` (loaded first) and `performance.js` (loaded second, so its copy wins at runtime). Keep both byte-identical, or a stale copy silently takes over. `test_detect_exit_reason_direction_aware` evaluates the real function from **both** files against fixed cases.

---

## Backend endpoint reference

### Portfolio + persistence
- `POST /api/db/save` — bulk save of frontend state. Persists `priceAlerts`, `watchlist`, `savedScreeners` (all survive reload).
- `GET /api/db/load` — bulk restore; returns all blob_store keys including `watchlist` and `savedScreeners`.
- `GET /api/cash` / `POST /api/cash`
- `POST /api/db/refresh-sectors`
- `GET /api/tax/eofy-pack?year=N` — downloads a ZIP with `cgt_disposals_FY{N}-{N+1}.csv` and `trade_fees_FY{N}-{N+1}.csv`. Reads `cgtDisposals` from blob_store + trade fees from `trade_journal`. `year` defaults to current FY (Jul–Jun). Button on CGT page.
- `GET /api/portfolio/splits-check?tickers=BHP.AX,CBA.AX` — returns any stock splits in the last 90 days for the given tickers. Response: `{TICKER:[{date,ratio}]}`. Capped at 50 tickers. Portfolio page calls this once per load (cached in `state._splitWarnings`); shows amber warning card if splits found.

### Market data (all cached via `ttl_cache`)
- `GET /api/seasonality/<ticker>` — 12-month avg return pattern from 10yr monthly history. Returns `{ok, ticker, years, months:[{month, avg, positive, count, min, max}]}`. avg/min/max in %. **24 h cache.** Displayed on Signals page detail card; cached in `window._seasonalityCache` per session.
- `GET /api/macro` — ASX200, AUD/USD, gold, iron ore + regime fields. **5 min cache.** `advance_decline_ratio` populated from last scanner run (% universe above 20-day SMA). `spi200_futures_chg` is `(SPI200 futures / ASX200 spot − 1) × 100`; fetched from `YAP=F` in the parallel yfinance block — `null` if futures data unavailable. `asx_vol_20d` is 20-day realised ASX vol (A-VIX proxy).
- `GET /api/quote/<ticker>` — fast price + sector + **`fetched_at` (UTC ISO)**. **45 s cache.** Both `_quote_cached` and `_fetch_symbol` (macro) use `fetch_with_retry` with stale-cache fallback.
- `GET /api/analyse/<ticker>` / `POST /api/analyse/batch` — full indicator pack. **5 min cache.**
- `GET /api/risk?tickers=A,B,C&rf=4.35` — beta, Sharpe, VaR, CVaR, correlation matrix.
- `GET /api/rba-rate` — live scrape → DB cache → fallback.
- `GET /api/polymarket` — Manifold market probabilities. **30 min cache.**

### Scanner
- `POST /api/market/scan` — start background scan. Returns 409 if already running.
- `GET /api/market/scan/status` — poll for progress.
- `POST /api/market/scan/stop`

### Learning loop
- `POST /api/learning/log` — log a recommendation event.
- `POST /api/learning/outcome` — partial-patch an event's outcome.
- `DELETE /api/learning/event/<id>`
- `GET /api/learning/stats` — confidence-band win rates + **Wilson 95% CI**, regime stats, prompt-version history, R:R stats, failure patterns, debate insights. Includes `calibration_active` (bool: n≥30), `overall_ci_lo/hi`, `success_patterns`, and `phase8_meta` (with `mann_whitney_z` and `mann_whitney_threshold`).
- `GET /api/learning/calibration?regime=X&sectors=A,B&tickers=BHP.AX,CBA.AX` — compact calibration block (~30–100 tokens, priority-ordered) for prompt injection. Includes per-ticker stats, sell-tag verdicts, conservatism warning when virtual-outcome `would_have_won` rate is high. 5-min TTL cache via `_calib_compute()` (thread-safe). Gated at n<30 — returns `{available:false}` when sample too small.
- `GET /api/learning/calibration-stats` — Brier score + reliability-diagram bins. Returns `{brier_score, n, bins:[{range,lo,hi,n,mean_confidence,actual_win_rate}]}`. Displayed on Learning page.
- `GET /api/learning/digest-data` — structured failure data for the postmortem digest: `{recent_failures, regime_stats, overall_wins, overall_total, error_dist, exit_dist}`. Frontend builds a Claude prompt from this and calls `callClaude('assistant', …)`.
- `GET /api/learning/sell-outcomes` — executed SELL/TRIM events with `sell_primary_driver` set, with per-event `sell_verify_verdict` badges. `?force=1` triggers immediate re-resolve before returning.
- `GET /api/learning/lessons?ticker=X&sector=Y&regime=Z` — scoped trading lessons matching the current context; injected into Claude user messages (cap: 3–4 lessons, ~15–25 tokens each).
- `POST /api/learning/lessons` — create a lesson `{lesson_text, ticker?, sector?, regime?, source}`.
- `DELETE /api/learning/lesson/<id>` — hard-delete one lesson.
- `GET /api/learning/untagged` — loss/breakeven events with no `error_type` set; used by the batch-classify button.
- `GET /api/learning/tag-reviews?limit=5` — up to 5 random unreviewed auto-tagged events; weekly spot-check queue on the Learning page.
- `POST /api/learning/tag-review` — submit `{event_id, verdict:'agree'|'disagree', corrected_tag?}`; disagree updates `error_type` → `manual` and clears `_calib_cache`.
- `GET /api/learning/tag-accuracy` — `{n, n_agree, agree_rate, label, pending_review}`. When `agree_rate < 0.60`, `_calib_compute()` restricts the `top_err` nudge to manually-reviewed events and emits `⚠AUTO_TAGS_UNRELIABLE` instead.
- `GET /api/market/universe-health` — checks all `ASX_UNIVERSE["asx200"]` tickers via yfinance `quoteType`; returns `{stale:[...], ok_count, checked_at}`; persists `universe_verified_at` to `blob_store`. Shown in Settings → App Info with "Check Now" button.

### Alerts (Telegram)
- `GET /api/alerts/config` — `{has_telegram: bool}` — whether credentials are stored.
- `POST /api/alerts/telegram` — send message. Body: `{message, token?, chat_id?}`. Explicit creds override stored. Used by the Test button.
- `POST /api/alerts/telegram/save` — persist `{token, chat_id}` to the `settings` table (keys `tg_token`, `tg_chat_id`). Pass empty strings to clear.

### Broker CSV import
- `POST /api/import/csv` — multipart upload; field `file` = CSV, optional `broker` hint (`commsec`|`selfwealth`|`auto`). Returns `{ok, broker, rows:[{action,ticker,shares,price,date,brokerage}], skipped:[{row,reason}], total}`.

### AI Call Log (prompt + response audit trail)
- `POST /api/log/ai_response` — updated: accepts `{text, system_prompt, user_message, agent_type, model, usage, duration_ms}`. Writes to `ai_call_log` table + enriched file. Keeps `blob_store.last_ai_raw_response` for backward compat. Now called automatically from `callClaude()` — no manual call needed at call sites.
- `GET /api/log/ai_calls?limit=20&offset=0&agent_type=X` — browse recent calls (metadata + snippets). No full text in list.
- `GET /api/log/ai_call/<id>` — full content for one logged call.
- `GET /health` — now returns `{status, time, version, uptime_s, last_backup}`.

### Claude proxy (opt-in)
- `GET /api/claude/settings` → `{has_key: bool}`
- `POST /api/claude/settings {api_key: 'sk-ant-...'}` — store / clear server-side key.
- `POST /api/claude/proxy` — forward request to api.anthropic.com using stored key.

### Debate engine (local Ollama)
- `GET /api/debate/status` — Ollama reachable? models available?
- `POST /api/debate` — generate bull/bear debate for a ticker.
- `POST /api/debate/postmortem` — postmortem on a closed trade.
- `GET /api/debate/calib-quality` — Phase 6 calibration quality card. Pre-computes binomial SE + Z-scores per calibration band, builds a constrained Ollama prompt (statistical verdict as immutable fact), returns per-band verdicts (`signal`/`uncertain`/`noise`) + qualitative analysis. Cached in `blob_store.calib_quality_latest`; `?force=1` bypasses cache; `?regime=X` scopes bands to that regime. *(Sprint 26)*

### Dividends, earnings, news, announcements
See `asx_server.py` route table — too many to list. Search `@app.route`.

---

## How prompt caching works

`callClaude()` sends the system prompt with `cache_control: { type: 'ephemeral' }` so subsequent intraday calls hit Anthropic's prompt cache. The static `ANALYSIS_SYSTEM_PROMPT` is cached as the first block; optional modules (tax-loss harvest, regime-specific rules) are appended as a second **uncached** block so they don't bust the cache when they change per-call.

`prompt-modules.js → buildSystemArray(context)` assembles the `[{type, text, cache_control?}]` array.

---

## Common tasks

### Change AI analysis rules (no code edit)
Recommendations page → **Rules** tab. Edits `state.analysisConfig.rules`, persists to DB, injected into next user message as "ACTIVE RULE OVERRIDES".

### Change day-trade thresholds (no code edit)
Day Trading page → **Rules** tab. Edits `state.dayTrading.filterParams` (pre-filter) and `state.dayTrading.aiParams` (AI-phase). Quant engine reads `state.dayTrading.aiParams` at compute time.

### Add a new system prompt
Edit `js/prompts.js`. If it's reused, add the agent type to `_AGENT_MAX_TOKENS` and `_resolveSystemPrompt()` in `js/claude-client.js`.

### Add a new optional rule module
1. Define the block in `RULE_MODULES` in `js/prompt-modules.js`.
2. Add activation logic in `assembleOptionalModules()`.

### Tune regime classification
`js/regime-engine.js` → `REGIME_THRESHOLDS`. Test with `classifyRegime(macroData)` from console.

### Tune indicator weights
`indicators.py` → `FACTOR_WEIGHTS` dict. Run `POST /api/scanner/factor-stability` to get per-factor OOS IC values, then update `FACTOR_WEIGHTS` with those values (or use the "suggested weights" row in the Factor Stability UI table). `_score_ticker()` reads `FACTOR_WEIGHTS` at runtime — no restart needed after editing the dict.

### Tune Kelly fraction / risk %
`js/quant-engine.js` → `QUANT_CONFIG`.

### Add a new route blueprint
1. Create `routes/my_feature.py` with `bp = Blueprint("my_feature", __name__)`.
2. Import and `register_blueprint` in `asx_server.py`.
3. Add `"routes.my_feature"` to `_EXTRA_MODULES` in `test_app.py → _install_in_memory_db()` so tests patch its `get_db` binding.

### Configure Telegram alerts
Settings page → Telegram section. Enter bot token (from `@BotFather`) and chat ID, click Save, then Test. Enable the toggle. `fireAlert()` will mirror all desktop alerts to Telegram when enabled.

### Run tests
```bash
python test_app.py   # all Python tests
npm run test:js      # Vitest JS tests (quant-engine, regime-engine, response-validator, _detectExitReason)
```
The Python suite covers: all learning-loop routes, Claude proxy endpoints, polymarket shape, JS syntax for every modified file, function presence (catches accidental deletion), regression tests for every fixed bug, infra invariants (db.py contract, ttl_cache memoisation, gunicorn config).

The Vitest suite (`tests/`) uses `vm.runInThisContext` to load browser-global scripts into Node context (mirrors the browser `<script>` tag loading order). `extractFunction()` in `tests/setup.js` uses brace-counting to extract individual functions from page files — used for `_detectExitReason` which is duplicated in `recommendations.js` and `performance.js`.

---

## Gotchas / contracts to honor

1. **Ticker tickers can include digits.** `A2M`, `S32`, `MP1`, `360` are all valid ASX codes. Validator regex is `[A-Z0-9]{2,5}(\.AX)?`.

2. **`adv_20` ≠ share count.** It's `close × volume` (AUD). Use `volume_avg_20` for share counts; derive shares from `adv_20 / price` if necessary.

3. **Panic regime drops recs, doesn't just shrink them.** `applyRegimeModifiers()` sets `qty=0, _regimeBlocked='panic'`. `analysis.js` filters these out — don't surface them.

4. **HOLD recs don't need target/stop/qty.** The validator schema uses `requiredUnless: 'HOLD'`. New action types should follow this convention.

5. **`state.priceAlerts`, `state.watchlist`, and `state.savedScreeners` ARE persisted.** All three are in the save payload (`api.js`) and in `BLOB_KEYS` in `routes/portfolio.py`, and returned by `db_load`. Don't drop any from either side — this was a Sprint 5 bug where `watchlist`/`savedScreeners` were sent but silently discarded.

6. **Stop/target alerts fire once.** `_stopAlertedAt` / `_targetAlertedAt` on the rec acts as a one-shot. Re-arms only after price retreats >2% from the trigger.

7. **The HTML script order is fragile.** If you add a new module, append it after its dependencies. There's no ES-modules safety net yet.

8. **SQLite uses `synchronous=NORMAL` + WAL.** Fast and crash-safe (loses only uncommitted last-txn, never corrupts). Don't downgrade to `synchronous=FULL` without measuring.

9. **`db.get_db` is the single source of truth.** Don't open `sqlite3.connect()` directly. Every `routes/*.py` does `from db import get_db` at import time — meaning each module has its **own binding** of `get_db`. Tests patch ALL of them via `_install_in_memory_db()` in `test_app.py`. **When adding a new route blueprint, add its module name (`routes.alerts`, `routes.import_csv`, etc.) to that helper or tests will hit the real DB.**

10. **Render functions must be pure.** `renderPerformance()` previously mutated `state.recHistory` inside render; now reconciliation happens in `reconcileRecOutcomes()` called from `renderPerformancePage()` BEFORE the HTML build. Follow this pattern for new pages.

11. **The error boundary catches render exceptions.** `navigation.js → renderPage()` wraps the actual render in try/catch. If you see "Page crashed" in the UI, the previous page render threw — the stack is in `console.error`.

12. **API key never logged.** `saveStateToDb` explicitly skips `settings.apiKey` (`asx_server.py:1657-ish`). If you add another secret field, do the same. Telegram `tg_token`/`tg_chat_id` are stored **server-side** in the `settings` table (not in the browser save payload) — don't move them client-side.

13. **`_detectExitReason` is direction-aware.** SELL/TRIM recs frame the stop *above* and target *below* entry (a bearish/exit thesis) — the inverse of BUY/TOP_UP. The comparisons flip on `action`. Always pass the rec's `action`. Forgetting this mislabels profitable trims as `stop_hit` and pollutes `failure_patterns`/`exit_reason_dist`.

14. **Two scripts redefine `_detectExitReason`.** Because plain `<script>` tags share one global scope, `performance.js` (loaded after `recommendations.js`) wins at runtime. Edit **both** copies identically.

15. **`fetch_with_retry` is not the `ttl_cache`.** They're orthogonal: `ttl_cache` serves the cached result within TTL; `fetch_with_retry` retries the live call and falls back to `_last_good` only when the call keeps failing. Both can coexist on the same function — the cache returns early before a retry is needed.

16. **Broker CSV import only imports BUY rows.** SELL rows are returned in `skipped` with a human-readable reason. Matching a SELL to existing CGT parcels requires knowing lot selection (FIFO/LIFO/specific), so SELL fills must be entered via `markExecuted` as usual.

17. **Drawdown monitor needs portfolio history.** `renderPerformance()` computes drawdown from `state.portfolioHistory`. If `portfolioHistory` has <2 entries (e.g. fresh install), no drawdown cards are shown — this is intentional, not a bug.

18. **Forming-bar guard drops today's ASX candle before 07:00 UTC.** `_drop_forming_bar(hist)` in `indicators.py` removes the last daily bar when `now_utc.hour < 7` AND the bar date matches today (UTC or AEST = UTC+10). This prevents incomplete intraday candles from inflating RSI/MACD during market hours. Called unconditionally in `analyse_ticker()` after every yfinance/Stooq fetch. Safe for historical dates (bar from yesterday or earlier is never dropped).

19. **Stooq fallback ticker format.** `_fetch_stooq_history` converts `BHP.AX` → `bhp.au` (strip `.AX`, lowercase, add `.au`). Do not pass the full Yahoo `.AX` symbol to Stooq — it will return an empty CSV silently. The function imports `_HTTP_SESSION` lazily from `core` to avoid circular-import issues at module load time.

20. **Stop-proximity alert is direction-aware.** `checkStopProximityAlerts()` checks `(price − stop) / price` for BUY/TOP_UP recs (stop below entry), and `(stop − price) / price` for SELL/TRIM recs (stop above entry). Threshold is `state.settings.stopProximityPct` (default 3 %). Set to 0 to disable. One-shot via `r._proximityAlertedAt`; re-arms when price retreats to 2× the threshold.

21. **`trend_signals` values must be cast to Python `bool`.** Pandas comparisons (`cp > sma_20.iloc[-1]`) return `numpy.bool_`, which Flask's JSON encoder rejects with `TypeError: Object of type bool is not JSON serializable`. The fix is in `indicators.py`: `"trend_signals": {k: (bool(v) if v is not None else None) for k, v in trend_signals.items()}`. Any new dict returned by `analyse_ticker()` that contains numpy scalars must go through `safe_float()`, `int()`, `bool()`, or a similar cast — never raw numpy.

22. **`syncClosedTradesToLearningLoop()` must write `_learningId` back to the original `state.recHistory` entry.** The function builds a `reconciled` array via `history.map(r => ({ ...r, ... }))` — each entry is a new spread object. If you set `r._learningId = res.id` only on the spread copy, `scheduleSave()` will persist the unchanged original (still lacking `_learningId`), and every subsequent Sync will re-log the same trade as a new event, inflating calibration stats. Always find the matching original: `const orig = state.recHistory.find(x => x.id === r.id); if (orig) orig._learningId = res.id;`

23. **`stk.quarterly_earnings` and `stk.earnings` are deprecated in yfinance ≥0.2.x.** Use `stk.earnings_history` instead (columns: `epsActual`, `epsEstimate`). The earnings calendar endpoint in `routes/market.py` was updated to use this API. Any new code consuming per-quarter EPS data should use `earnings_history`, not `quarterly_earnings`.

24. **`_calib_cache` is protected by `_calib_lock` (threading.Lock).** Any code that reads or writes `_calib_cache` in `routes/learning.py` must hold the lock. Compute expensive DB work outside the lock — only the dict read and the final write need to be inside `with _calib_lock:`.

25. **Kelly `minQty` floor applies only to positive-Kelly trades.** `computeTradeParams()` returns `{ok:false}` when `kellyFrac ≤ 0` before reaching the `Math.max(QUANT_CONFIG.minQty, …)` line. Do not move the Kelly guard below the `minQty` floor — that was the original bug.

26. **`_sanity_check` runs after `_drop_forming_bar` in `analyse_ticker()`.** It drops bars with >25% single-day close move. Penny stocks (close < $0.50) are exempt. If a legitimate corporate event causes a large move, the bar will be dropped and the following bar's ATR/RSI will look unusual — this is intentional and preferable to letting a data error corrupt all downstream signals.

27. **`FACTOR_WEIGHTS` must sum to 100.** `_score_ticker()` normalises each component's raw max against its weight (e.g., trend raw max 30 → `trend * w["trend"] / 30`). If you change `FACTOR_WEIGHTS`, verify the normalised total still caps at 100. The `_WEIGHT_TOTAL` variable is informational only — it's not used in the scoring formula.

28. **`pre_earnings_risk` is set in `analyse_ticker()` output, not in the quant engine.** The quant engine reads `signals.pre_earnings_risk` — if that field is absent (e.g., from a cached `analyse_ticker()` call before the field was added), `earningsAdj` defaults to 1.0. Recs flagged with `_preEarningsAdj: true` show a `📅 Pre-earnings` badge on the rec card.

29. **Regime `_blendedSizeMult` is set by `fetchAndClassifyRegime()` not `getRegimeModifiers()`.** The blend is computed in the async fetch function and stored on `_regimeCache._blendedSizeMult`. `applyRegimeModifiers()` reads `state.currentRegime?._blendedSizeMult` as an override over `mod.sizeMult`. If `state.currentRegime` is stale (e.g., regime was just refreshed in a different tab), the blend fraction may be wrong — this is acceptable given the 15-min regime cache TTL.

30. **Intraday strategy is same-day only — no overnight hold.** `routes/intraday.py` fetches 5m bars (`period="2d", interval="5m"`). Entry window gate (`_in_entry_window()`) ensures `passes=False` outside 10:45–15:00 AEST — scanner still shows data but won't mark setups as actionable outside that window. `checkIntradayCloseouts()` fires a time-stop alert at 15:00 AEST for any open intraday position. yfinance 5m data has ~5–15 min latency; prices are indicative only. `state.intraday.openPositions` and `todayPnl` are stored in state (persisted to DB); the allocatedCash draws from `state.cash` and is tracked separately from `state.dayTrading.allocatedCash`. The ⚡ Intraday tab has a universe selector (asx20/asx50/asx100/asx200) stored in `state.intraday.params.universeKey`. The scan endpoint uses `as_completed` with 8s per-ticker timeout and 15 workers to avoid slow/delisted tickers blocking the batch. `IPL.AX` was removed from all universe lists (delisted 2025).

---

## Deferred work (not done yet, noted for the next pass)

| Item | Why deferred | What it would unlock |
|---|---|---|
| **Full ES-modules migration** | Touching 27 JS files with no dev-server verification = high regression risk. Better to do under a feature branch + visual smoke test. | Safe dependency order, dead-code elimination, single bundled HTTP request. |
| **FastAPI migration** | Half-day refactor of every route. Current Flask + gthread is fast enough. | Native async, auto-generated OpenAPI docs, faster I/O concurrency. |
| **Walk-forward backtesting** | ~~Requires vectorised OHLCV replay engine + parameter grid.~~ **Shipped Sprint 20.** `POST /api/backtest/walk-forward`; Walk-Forward tab in Backtest page. | Robust strategy parameter tuning. |
| **Mobile / responsive layout** | Needs CSS breakpoint pass on every card/table — compact mode toggle (shipped Sprint 13) helps on small screens but doesn't reflow columns. | Phone-friendly read-only mode during market hours. |
| **DRP parcel tracking** | Dividend income forecast assumes no DRP (dividend reinvestment); DRP parcels need their own CGT lot management. | Accurate CGT cost-base for DRP investors. |
| **Vitest frontend tests** | ~~JS test infrastructure needs setting up (jsdom, mocking globals).~~ **Shipped Sprint 19.** `npm run test:js` — 122 tests. | Catch logic regressions in quant-engine, regime-engine, _detectExitReason. |
| **Hoist `_detectExitReason` into `utils.js`** | Currently duplicated in two page files; dedup risks the fragile script order. | Single source of truth for exit classification. |
| **`pip install feedparser`** | Optional dep; RSS falls back to a built-in XML parser when absent (logs a warning each scan). | More robust news-feed parsing. |
| **Stooq rate-limiting** | Stooq.com has undocumented rate limits (typically 1 req/sec). Under parallel batch requests the fallback may 429 silently (returns empty CSV). A per-domain semaphore or retry delay would prevent silent fallback failures. | Reliable Stooq fallback under load. |

---

## Logging

Console: human-readable.
File: `ai_responses/server.log`, 2 MB × 5 rotation.

Per-request timing middleware logs handlers >500 ms (INFO) and >2 s (WARN). The Anthropic prompt cache hits show in console as `[agentType] cache read=X written=Y`.

---

## Quick smoke after pulling main

```bash
# 1. Tests still green?
python test_app.py
npm run test:js

# 2. Server starts?
python asx_server.py &
sleep 2
curl -s localhost:5000/health
kill %1

# 3. Frontend parses?
for f in js/*.js js/pages/*.js; do node --check "$f" || break; done
```

If any of those fail, something landed broken — diff against the last known-good commit.
