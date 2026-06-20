# CLAUDE.md — Sloth ASX Trader

Operator handbook for Claude Code sessions in this repo. Keep this updated when major architecture changes land.

---

## What this app is

A local-only decision-support tool for Australian equity trading. No SaaS, no cloud DB.
- **Backend:** Python Flask (`asx_server.py`) on `localhost:5000`. Fetches market data via `yfinance`. Persists everything in SQLite (`asx_trader.db`, WAL mode).
- **Frontend:** Vanilla JS single-page app (`asx_trading.html`). Talks to backend, calls Anthropic API directly from the browser, renders with `<canvas>` (no chart libraries).
- **AI:** Claude Sonnet 4.6 for analysis, recommendations, day trading; Gemini for ASX announcements; local Ollama for news + internal "debate" pre-analysis + optional local portfolio analysis via `POST /api/debate/quick-analysis` (opt-in via Settings).

---

## Run instructions

```bash
pip install -r requirements.txt

# Dev (single-worker, autoreload-free)
python asx_server.py
# Then open asx_trading.html in a browser.

# Production-grade (multi-threaded) — Windows
python waitress_server.py

# Production-grade (multi-worker) — Linux / macOS only
# gunicorn uses fcntl which is POSIX-only and does NOT work on Windows
pip install gunicorn
gunicorn -c gunicorn.conf.py 'asx_server:app'
```

API key options (one of these is required for analysis):
1. **Direct mode (default)**: paste Anthropic key in Settings → kept in `localStorage`.
2. **Proxy mode (opt-in)**: `POST /api/claude/settings {api_key}` once; set `state.settings.useBackendProxy = true`. Key lives in SQLite, never touches the browser.

Tests:
```bash
python test_app.py        # all Python tests (backend + frontend syntax/function checks)
npm run test:js           # Vitest suite — 127 JS unit tests for pure engine files
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
| `core.py` | ~230 | Shared infrastructure: `ttl_cache`, `fetch_with_retry` (exponential backoff + `_last_good` stale-cache; `_http_status()` helper detects HTTP status from `requests.HTTPError`/`urllib.error.HTTPError`; 4xx errors except 429 break the retry loop immediately; 429 gets a minimum 5s sleep), `stooq_quote(yf_symbol)` + `_to_stooq_sym()` (Stooq price fallback — third line of defence when `_last_good` is also empty; covers all `.AX` equities + major global symbols; `TIO=F`/`YAP=F` unsupported), `_stooq_sem` (BoundedSemaphore(1) exported to `indicators.py`; paces Stooq requests to ~1 req/sec), `_HTTP_SESSION`, `log`, `LOG_DIR`, `SECTOR_MAP`, `ASX_UNIVERSE`, `OLLAMA_BASE`. No Flask import. |
| `db.py` | ~270 | SQLite schema, `get_db()`, `init_db()`, migrations, `log_failed_ticker()`, `backup_db(keep=7)`. Single source of truth — never `sqlite3.connect()` directly. `init_db()` runs `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` on every startup (non-blocking; prevents index-stat decay and WAL bloat). |
| `indicators.py` | ~820 | All technical indicators + `analyse_ticker()` + `_score_ticker()`. Pure compute, no Flask. `_drop_forming_bar(hist)` drops the current-day candle before 07:00 UTC to avoid incomplete intraday bars. `_sanity_check(hist, ticker)` drops bars with >25% single-day close move (data errors / unadjusted splits) — called after `_drop_forming_bar` in `analyse_ticker()`. `_fetch_stooq_history(ticker, period)` is a free fallback provider (stooq.com, no API key) used when yfinance returns empty; imports `_stooq_sem` from `core` and acquires it before each Stooq HTTP call (1-second `finally` sleep paces requests to ~1 req/sec, preventing silent empty-CSV responses under parallel batch scans). `FACTOR_WEIGHTS` dict (trend/pullback/volume/momentum/rs) controls `_score_ticker()` weights — update after running `POST /api/scanner/factor-stability` to apply empirical IC values; emits `warnings.warn` at import if `sum(FACTOR_WEIGHTS) != 100`. `analyse_ticker()` returns `days_to_earnings` (int or None), `pre_earnings_risk` (bool: true when ≤14 days), `high_60d` (60-bar high, None when <60 bars), and `low_60d` (60-bar low) — used by the Fibonacci day-trade signal. |
| `announcement_engine.py` + `announcement_routes.py` | — | ASX announcements scraper, PDF parser, Gemini scorer, blueprint `/api/announcements/*`. |
| `news_engine.py` | — | RSS aggregator, TF-IDF dedup, LLM sentiment classifier (Ollama/Groq/Gemini). |
| `gunicorn.conf.py` | — | Production WSGI config. 2 workers × 8 threads. |
| `test_app.py` | ~4620 | 448 unit + integration tests. Patches `get_db` across `db`, `asx_server`, and every `routes/*` module. |

#### `routes/` — one blueprint per concern

| File | Lines | URL prefix(es) | Notes |
|---|--:|---|---|
| `routes/portfolio.py`  | ~490 | `/api/cash`, `/api/db/*`, `/api/tax/eofy-pack`, `/api/portfolio/splits-check` | Bulk state save/load, cash balance, EOFY tax pack ZIP download. `GET /api/portfolio/splits-check?tickers=...` — uses `yf.Ticker.splits` to detect splits in the last 90 days; returns `{TICKER:[{date,ratio}]}`. |
| `routes/dividends.py`  | ~395 | `/api/dividends/*`                              | yfinance + ASX scrape, 12 h cache, `_FRANKING_MAP` fallback. |
| `routes/market.py`     | ~1110 | `/health` (+ version/uptime/last_backup), `/api/{analyse,quote,macro,rba-rate,polymarket,risk,portfolio/nav-history,earnings-calendar,log/ai_response,log/ai_calls,log/ai_call/<id>}` | All yfinance read-only data + full prompt+response logging. ETFs skipped in `/api/earnings-calendar` via quoteType check. Uses `@ttl_cache`. `GET /api/market/universe-health` — checks all ASX200 tickers (20-worker pool, 8s per-ticker timeout via `as_completed`) and persists `universe_verified_at` to blob_store. |
| `routes/backtest.py`   | ~1150 | `/api/backtest`, `/api/backtest/ai-replay`     | Historical strategy backtest + replay scoring of executed AI recs. Supports `slippage_mode: 'flat'|'liquidity'`; liquidity mode applies ADV-tiered rates via `_adv_slippage(adv_aud)`. |
| `routes/scanner.py`    | ~500 | `/api/market/scan*`                              | Background thread + `_scan_state` dict, sector diversification. Computes `breadth_ratio` (% of universe above 20-day SMA) after each scan; consumed by `/api/macro` via lazy import. |
| `routes/learning.py`   | ~1800 | `/api/learning/*`                                | Log → outcome → stats/calibration analytics. Decay-weighted win rates with volatility-adaptive half-life (`_HL_MAP`: panic=20d, riskOff=30d, highVol=35d, trend=45d, riskOn=50d, sideways=60d, default=45d). `_calib_compute()` is a pure function, 5-min TTL cache protected by `_calib_lock` (threading.Lock — guards concurrent gunicorn threads). Calls `_resolve_virtual_outcomes(conn)` (price-checks unexecuted recs ≥30d old → `virtual_win`/`virtual_loss`; writes `virtual_speed_weight = min(1.0, 7.0/hold_days)` for speed-weighted calibration) and `_resolve_sell_outcomes(conn)` (validates SELL tags ≥25d old → `sell_verify_verdict`) and `_resolve_deterministic_tags(conn)` *(Sprint 70)* — fills `error_type` (source `'deterministic'`) + `skill_score` on closed executed events from the entry/exit capture, replacing the blind local-LLM postmortem/skill scorer. `classify_error_type_deterministic(row)` derives tags from real data and *(Sprint 71 Phase 2A)* returns a COMMA-SEPARATED set of ALL applicable tags (most→least specific): `thesis_broken`(`thesis_verdict=='invalidated'`) → `stop_too_tight`(empirical: MAE pierced the stop yet MFE recovered ≥50% toward target; falls back to the legacy stop<1.5×ATR heuristic when MAE/MFE null) → `missed_catalyst`(*now partly deterministic*: entry `days_to_earnings` inside `holding_period_days`) → `early_exit`(manual non-win where MFE reached target OR `exec_mech_pnl_pct` beats `realized_pnl_pct` by ≥2pp) → `oversized`/`undersized`(sizing token in `checklist_bypasses` only — sizing not otherwise captured) → `overconfident`/`poor_rr`/`poor_entry`/`regime_mismatch`; never emits `external_shock` (world-knowledge → manual LLM only). `compute_skill_score_deterministic(row)` is the `thesis_verdict × outcome` skill-vs-luck quadrant (validated+win=8, validated+loss=6, invalidated+win=3, invalidated+loss=2, +discipline/calibration modifiers) plus *(Sprint 71 Phase 2C)* an MAE/MFE path-quality modifier (deep-MAE thin-MFE win −0.5 luck; clean shallow-MAE high-MFE win +0.5); returns `None` when no verdict (legacy rows keep neutral weight). `compute_skill_score_fallback(row)` is a documented LOWER-TRUST estimate (outcome × R-multiple × exit-discipline) for legacy rows with no verdict — exposed/tested but NOT wired into the resolver (verdict-backed and estimate scores must not mix in calibration). *(Sprint 71 Phase 2D)* `_resolve_stop_tag_counterfactual(conn)` + `_wider_stop_would_have_saved()` + `_compute_stop_tag_precision()` validate the `stop_too_tight` tag via OHLC (would a regime `stopAtrMult`×ATR stop have reached target?), writing `stop_cf_saved` (1/0); when precision <0.5 (n≥5) the top_err widen-stops nudge self-suppresses and emits `⚠STOP_TAG_UNRELIABLE`. Stats exposes `stop_tag_precision`; `GET /api/learning/stop-tag-precision` is the dedicated endpoint. The LLM postmortem/skill endpoints remain as optional **manual** overrides (deterministic only fills NULLs — manual/auto tags win). `_ESS_MIN=6.0` (was 2.5), nudge floors `_MIN_NUDGE_N=12` (was 3), and confidence-band nudges pass a Wilson-CI significance gate (`_ci_excludes()`) so small-n flukes are withheld. Brier score excludes breakevens (binary win/loss only). Phase 8 gate uses `_mann_whitney_z(wins, losses) > 1.28` (Mann-Whitney U, z-score, no normality assumption) in both `_compute_phase8_meta()` (stats endpoint) and `_calib_compute()` (calibration block). Regime-flip penalty: when `regime_flipped_at` within 30d and <10 trades in new regime, halves HL and emits `⚠REGIME_FLIP` token. `_compute_thesis_drift(conn)` emits `⚠EARLY_EXIT_DRAG` when manual exit avg P&L lags target-hit avg by >3pp (n≥5). `_REGIME_GROUPS`: bearish={riskOff,panic}, bullish={riskOn,trend}, neutral={highVol,sideways}. Step 6b: dominant success tag nudge. Stats response includes `success_patterns`, `phase8_meta.mann_whitney_z`. `GET /api/learning/sell-outcomes` — executed SELL/TRIM events with driver verdicts. `GET /api/learning/lessons` / `POST /api/learning/lessons` / `DELETE /api/learning/lesson/<id>` — scoped persistent trading lessons; `GET /api/learning/execution-alpha` — actual vs simulated mechanical exits (stop/target/15-bar time-stop) for executed BUY/TOP_UP; lazily resolves ≤5 events/call *(Sprint 63)*. `GET /api/learning/lessons` accepts `adl` + `asx_vol` params to filter by `breadth_scope` column on `trading_lessons` (values: `adl_below_0.3`, `adl_above_0.7`, `high_vol`, `low_vol`, null=always inject). `GET /api/learning/tag-reviews` / `POST /api/learning/tag-review` / `GET /api/learning/tag-accuracy` — Gap 6 tag spot-check: `tag_reviews` table (with `UNIQUE(event_id)` constraint), 5-event weekly batch, agree/disagree/retag UI, `agree_rate` gates the `top_err` calibration nudge. When `agree_rate < 0.60`, auto-tagged events excluded from error pattern section; `⚠AUTO_TAGS_UNRELIABLE` token emitted instead. *(Sprint 71 Phase 3 — feed enrichment)* `_calib_compute(..., deep=False)`: `deep=True` (the full portfolio-analysis path passes `?deep=1`) appends low-priority conditional blocks and computes few-shot exemplars. `_compute_exemplars(conn)` returns 2–3 recent closed losses + 1–2 best wins as `ACTION TICKER @ <_entry_signature(sig)> → <pnl%> in <Nd>, <tag(s)>` (returned on a separate `exemplars` field, never char-budget-truncated). `_compute_driver_playbook(conn, drivers, _ci_excludes)` emits per-driver conditional WR lines (RSI/BB%B buckets, CI-gated). `_compute_setup_bucket_xtab` (low/mid/high setup_score), `_compute_driver_regime_xtab` (current vs other regimes per driver), and `_compute_sell_negative_confirmation` (`⚠SELL→ROSE` from `sell_verify_verdict='invalidated'` or `sell_verify_sold_chg≥8`) — all appended last so they drop first under truncation; deep raises the char budget to 900/1100. `deep` is part of the calibration TTL cache key. *(Sprint 71 sector analysis)* `_resolve_missing_sectors(conn, cap=50)` (lazy, beside the other `_resolve_*` calls inside the `with get_db()` block) backfills null/empty `sector` on executed rows from `core.SECTOR_MAP` (no network; strips `.AX`; unknown tickers skipped) so the sector lens isn't silently censored. Calibration **sector lines (section 3)** are now framed as a DELTA vs the whole-market baseline (overall WR): `SECTOR:NN%WR vs mkt MM% (±Xpp,n=…)` — the ✓strong/⚠underperform flag fires only when ESS≥6.0 AND the sector's Wilson 95% CI excludes the market WR; deep mode emits the full per-sector breakdown, light mode collapses to a single `sector:<most-divergent>` summary. The **sector×regime** block (section 8) is likewise framed `… vs mkt …` and CI-gated. `_compute_exemplars(conn, sector=…)` prefers same-sector exemplars (dominant sector derived from the requested tickers via `SECTOR_MAP`, else first requested sector), falling back to whole-market when same-sector trades are too few. |
| `routes/debate.py`     | ~2560 | `/api/debate/*`                                  | Local Ollama bull/bear + postmortem + adversarial debate + skill scoring + calibration quality + local portfolio analysis. Direction-aware prompts (BUY vs SELL/TRIM). Uses `current_app.logger`. Sprint 26 added `GET /api/debate/calib-quality` (Phase 6). Sprint 41 added `POST /api/debate/quick-analysis` (local LLM portfolio analysis for `useLocalLLM` opt-in). Full endpoint list: `status`, `debate`, `tag-win`, `postmortem`, `postmortem-debate`, `adjudicate`, `adjudicator-status`, `staleness`, `skill`, `calib-quality`, `quick-analysis`. |
| `routes/news.py`       | ~690 | `/api/news/*`, `/api/groq/models`, `/api/google/models`, `/api/sbc-mode`, `/api/system/gpu`, `/api/ollama/start` | RSS scanner + LLM provider management + SBC toggle. Owns `_NE_OK`. |
| `routes/claude.py`     | ~85  | `/api/claude/*`                                  | Backend proxy for the Anthropic API (opt-in). |
| `routes/alerts.py`     | ~100 | `/api/alerts/*`                                  | Telegram off-device alerts. `POST /api/alerts/telegram` (send), `POST /api/alerts/telegram/save` (persist creds to settings table), `GET /api/alerts/config` (has_telegram?). Credentials stored in `settings` table as `tg_token`/`tg_chat_id` — never logged. |
| `routes/import_csv.py` | ~200 | `/api/import/csv`                                | Broker CSV parser. Auto-detects CommSec / SelfWealth / generic format; normalises to `{action, ticker, shares, price, date, brokerage}`. Returns BUY rows in `rows`; SELL rows in `sells` array (no longer in `skipped`) for frontend FIFO matching. *(Sprint 46)* |
| `routes/intraday.py`   | ~270 | `/api/intraday/<ticker>`, `/api/intraday/scan`  | ASX100 intraday day-trade strategy. `GET /api/intraday/<ticker>` — single ticker 5m analysis (2-min TTL). `POST /api/intraday/scan` — batch scan up to 100 tickers with 8-thread pool. Returns VWAP, intraday RSI, volume acceleration, setup score 0–100, `passes` bool (entry window + VWAP + RSI + score gates). |

Total: **12 blueprints, ~100 routes** (including announcements blueprint). Sprint 38 added sell-outcomes, lessons, untagged, SPI200. Sprint 39 added `GET|POST /api/learning/tag-review(s)`, `GET /api/learning/tag-accuracy`, `GET /api/market/universe-health`. Sprint 41 added `POST /api/debate/quick-analysis` (local LLM analysis) + 3 static PWA routes in `asx_server.py` (`/manifest.json`, `/sw.js`, `/static/<path>`). Sprint 46 added `POST|DELETE /api/market/universe-exclude` (blob_store exclusion list for scanner/intraday); SELL rows in import_csv now returned in `sells` array. Sprint 55 added `GET /`, `GET /asx_trading.css`, `GET /js/<path>` so the app is fully served from Flask (required for the ngrok single-origin tunnel).

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
| `js/utils.js` | `escapeHTML()`, `fmt()`, `fmtp()`, portfolio math helpers, `mergedPortfolio()`, `_detectExitReason()` (canonical copy — do not redefine in page files), `_applyTheme(theme)` — sets/clears `document.documentElement.dataset.theme` (`'auto'` clears it; `'light'`/`'dark'` sets it) and updates the `<meta name="theme-color">` for PWA chrome. *(Sprint 60: `_applyTheme` added)* |
| `js/api.js` | All backend fetch wrappers + `saveStateToDb()` / `loadStateFromDb()` with input validators |
| `js/claude-client.js` | `callClaude(agentType, msg, opts)` — central wrapper; supports direct + proxy mode. Portfolio agent uses forced tool use on the static `_PORTFOLIO_TOOL` (`emit_recommendations`) for grammar-level JSON enforcement. §9.5: local-LLM SELL/TRIM on a >10%-weight holding escalates to Claude (`_localExitOnLargePosition`) — `tool_use.input` is stringified back into the returned `text` so downstream parsing is unchanged; `options.noTool` opts out. *(Sprint 62)* Agent types: `portfolio`, `analyst`, `pm`, `dayTrade`, `universe`, `macro`, `assistant`, `briefing`. Sprint 41: `_callLocalAnalysis(userMessage)` fast-path fires when `agentType === 'portfolio' && state.settings.useLocalLLM` — POSTs to `POST /api/debate/quick-analysis` and returns identical `{ text, usage }` shape so `analysis.js` is transparent to routing. Returns same shape so the validator, quant engine, and regime modifiers all run identically. |
| `js/regime-engine.js` | `classifyRegime()`, `applyRegimeModifiers()`; panic regime hard-blocks via `_regimeBlocked`. `getRegimeModifiers()` now returns `stopAtrMult` (2.5 riskOn/trend/sideways · 3.0 highVol · 3.5 riskOff · 4.0 panic). `_blendedSizeMult` linearly interpolates the old→new `sizeMult` over 30 min on regime flip to prevent cliff-edge sizing. SPI200 futures (`macroData.spi200_futures_chg`) cast a vote in `classifyRegime()`. On regime flip, `fetchAndClassifyRegime()` writes `regime_flipped_at` (ISO timestamp) and `regime_flipped_to` (regime name) to `localStorage`; `fetchCalibrationBlock()` passes these as query params so `_calib_compute()` applies the flip penalty. |
| `js/quant-engine.js` | `computeTradeParams()` — deterministic sizing. Rejects when `kellyFrac ≤ 0` (negative EV) before `minQty` floor applies. Stop distance = `regimeMod.stopAtrMult × earningsAdj × ATR`; `earningsAdj = 1.3` when `signals.pre_earnings_risk`. Reads `signals.adv_20` (AUD) and `signals.volume_avg_20` (shares); liquidity cap is in shares. Returns `_preEarningsAdj: true` flag on the rec when earnings adjustment fires. |
| `js/response-validator.js` | `validateRec()`, `getValidatedAnalysisWithRepair()`. Ticker pattern accepts `[A-Z0-9]{2,5}`. Fields use `requiredUnless: 'HOLD'`. |
| `js/learning-loop.js` | Client-side calibration analytics + `fetchCalibrationBlock()` from backend. Sprint 68: `computeThesisDrift(entryDriver, entrySignals, liveSnapshot)` — deterministic exit verdict (`validated`/`invalidated`/`irrelevant`) comparing entry vs current technicals per driver; `fetchEntryContexts(tickers)` pulls original entry context from `GET /api/learning/entry-context`. |
| `js/prompts.js` | All Claude system prompts (`ANALYSIS_SYSTEM_PROMPT`, `MACRO_SYSTEM_PROMPT`, `MORNING_BRIEFING_SYSTEM_PROMPT`, day-trade prompts, analyst/PM prompts). Rule 3 references `stopAtrMultiple` from ACTIVE RULE OVERRIDES (regime-aware, injected by `analysis.js`). Rule 4 sets qty=0 (quant engine sizes post-response: `computeTradeParams()` for BUY/TOP_UP; the SELL/TRIM block in `analysis.js` sizes exits — SELL = full holding, TRIM = `weightGuidance` Reduce-range midpoint, default 35%). Section 7 cash test is qty-free (min-trade-size notional); Section 6 calibration is context-only — numeric adjustments applied engine-side in `analysis.js` from the calibration `adjustments` payload. `scenarios` field is optional. Section 3 CorrToHoldings rule is context-only (engine sizes for correlation). Section 1C (Sprint 67) requires `primary_entry_driver` on every BUY/TOP_UP (one of: mean_reversion · momentum_breakout · trend_pullback · fundamental_value · macro_tailwind). Section 2B (Sprint 68) is context-only: when a `HOLDING_CONTEXT` block is present, Claude must narrate whether the original entry driver still holds — the verdict itself is computed engine-side by `computeThesisDrift()`. `PROMPT_VERSION = '2026-06-v13'`. |
| `js/prompt-modules.js` | `RULE_MODULES` (tax-loss, CGT, reporting season, regime-specific) + dynamic system-prompt assembly |
| `js/strategy.js` | `DT_FILTER` (pre-filter thresholds) + `DT_AI_PARAMS` (AI-phase params). Both editable at runtime via Day Trading → Rules. |
| `js/analysis.js` | Portfolio analysis orchestration — fetches signals, builds prompt, calls Claude, post-processes through quant engine + validator + regime modifiers. `portfolioJson` uses `livePrice = state.liveSignals[ticker]?.current_price ?? h.currentPrice` for all price-derived fields. Sprint 47: `ACTIVE_REGIME:` injected at line 3 of user message (before Holdings) via `__REGIME_PLACEHOLDER__`. Indicator block uses `_isCandidate(s, t)` tiering — Tier 1 (full 12-line block) for tickers with active setups; Tier 2 (1-line compact) for stable holds. `rulesCtx` (ACTIVE RULE OVERRIDES) precedes `indicatorCtx`. Regime-aware `__STOP_MULT_PLACEHOLDER__` injects `getRegimeModifiers().stopAtrMult` into the rules block. Lessons fetch sends top 2 sectors by portfolio weight as comma-separated `sector` param. **Sprint 71 Phase 3:** the `__CALIBRATION_PLACEHOLDER__` substitution now expands to `_calibrationNote + _exemplarsBlock + _lessonsBlock` — the full portfolio path calls `fetchCalibrationBlock(..., {deep:true})` to request the deep feed and renders the few-shot `EXEMPLARS:` block (from `window._calibExemplars` via `buildExemplarsBlock()`) between the calibration and lessons blocks. |
| `js/day-trading-analysis.js` | Day-trade portfolio scan + universe scan orchestration. |
| `js/charts.js` | Canvas helpers. `_fitCanvas(canvas)` — sets `width`/`height` at `devicePixelRatio` for crisp rendering on all screens; used by every draw function. `chartColor(token, fallback)` — reads a CSS custom property via `getComputedStyle(document.documentElement)` so every canvas draw follows the active theme (light/dark/auto). Debounced `resize`/`orientationchange` handler redraws open charts when viewport *width* changes (ignores height-only shifts from mobile toolbars). |
| `js/navigation.js` | `showPage()` + `renderPage()` with error boundary (any page crash falls back to a graceful error card). |
| `js/alerts.js` | `fireAlert(title, body, tag)` — desktop notification + optional Telegram mirror when `state.settings.telegramEnabled`. `checkRecStopTargetAlerts` tracks `_stopAlertedAt`/`_targetAlertedAt` to prevent spam. |
| `js/prices.js` | `refreshPrices()` — fetches live quotes, stores `fetched_at` timestamps per ticker in `state.priceTimestamps`. |

### Pages

`js/pages/*.js` — each is a render function `renderX()` plus event handlers. Most are pure HTML-string builders. Tables that need mobile-friendly stacking use `class="tbl-stack"` + `data-label="…"` on every `<td>` — the CSS transforms them to labelled cards at ≤640px. The portfolio `toggleLots()` now sets `display:''` (not `'table-row'`) so the mobile stacked style overrides correctly. `pages/scanner.js`, `pages/day-trading.js`, `pages/learning.js`, `pages/news.js`, `pages/announcements.js` have async pollers — `navigation.js` stops them on page change. `pages/watchlist.js` renders the Watchlist page (⭐ nav item); fetches live signals async per ticker and hosts the indicator-alert creation UI. `pages/compare.js` renders the side-by-side compare tab (g+x shortcut, or Scanner → ↔ Compare tab); calls `POST /api/analyse/batch`; `compareFromOutside(tickerList)` lets other pages pre-load tickers into it. The Compare tab lives inside Market Scanner as the third tab (`_scannerTab = 'compare'`); `showPage('compare')` in `navigation.js` transparently redirects to the Scanner page — no standalone sidebar nav item.

---

## Key data shapes

```js
state.portfolio:          [{ ticker, shares, avgPrice, currentPrice, sector }]
state.tradeJournal:       [{ id, date, ticker, action, qty, entryPrice, exitPrice, fees, pnl, status, recId, recExecuted, closeDate, entrySignals?: {rsi_14,bb_pct_b,adx_14,atr_pct,return_5d,return_20d,price}, thesis?: string }]  — entrySignals/thesis captured for MANUAL trades at log time (Sprint 69); AI trades pull the same data from the learning event via GET /api/learning/trade-detail. Surfaced in the Journal page's expandable detail drawer (toggleJournalDetail)
  -- action values: BUY | SELL | TOP_UP | TRIM | HOLD | DRP
  -- DRP entries have fees:0, pnl:0, status:'open', recId:null, recExecuted:false, and parcelId set
state.recHistory:         [{ id, date, ticker, action, confidence, ensembleConfidence, priceRange, target, stopLoss, qty, executed, outcome, actualProfit, regime, _learningId, _thesis?, _stopAlertedAt?, _targetAlertedAt?, _stopTrailed?: bool, _stopTrailedAt?: ISO string, _stopWidened?: bool, _stopWidenedFrom?: number, _stopWidenedRegime?: string, primary_entry_driver?: string (BUY/TOP_UP, Sprint 67), _thesisCheck?: {verdict,reason,deltas}, _entryDriver?: string, thesis_verdict?: 'validated'|'invalidated'|'irrelevant' (SELL/TRIM, Sprint 68) }]  — _stopWidened* set by checkRegimeStopWidening() (alerts.js, Sprint 66): regime-degradation hard-stop widening, widen-only, trail wins. _thesisCheck/thesis_verdict set by computeThesisDrift() on SELL/TRIM recs; thesis_verdict is patched onto the parent BUY learning event at position close (matrix data source)
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
state.settings.theme:             'auto'|'light'|'dark' — colour scheme override. 'auto' follows OS prefers-color-scheme; 'light'/'dark' force via `document.documentElement.dataset.theme`. Applied at startup by `_applyTheme()` in `utils.js`. Segmented control in Settings → Display. *(Sprint 60)*
state.settings.useLocalLLM:       bool — routes portfolio analysis to local Ollama via quick-analysis endpoint (BUY/TOP_UP/HOLD/SELL/TRIM with simplified 5-driver taxonomy). Default false. *(Sprint 41; SELL/TRIM extended Sprint 48)*
state.settings.maxRiskBudgetPct:  number — heat budget gate: max total $ at risk to stops as % of portfolio (default 5). Set in Risk page budget input. Used by `analysis.js` to scale/block new BUY recs. *(Sprint 38)*
state.settings.autoBriefTime:     string — 'HH:MM' AEST time to auto-fire morning briefing on first page load (empty = disabled). Stored in settings, persisted to DB. *(Sprint 45)*
state.settings.autoMacroBrief:    bool — auto-run the AI morning macro once per trading day via `checkMacroBriefSchedule()` (default true; ≤3 attempts/day; weekdays only). When off, the brief still auto-runs on the first manual Run Analysis. NEVER assign `state.macroData` wholesale from a live `/api/macro` payload — use `mergeLiveMacro(data)` in `utils.js`, or the day's AI brief fields get wiped (the 2026-06-11 disappearing-macro bug). *(Sprint 65)*
state.debate.oppositionModel:     str — opposition model for adversarial postmortem debate (⚔️ button). Auto-picks a different pulled model when empty. Set in Learning → Debate Engine card.
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
| `triggerPostmortem(learningId)` | `debate-client.js` | Runs the local Ollama bull/bear postmortem. **Manual-only** — must be triggered via 🤖 button on Learning page; auto-trigger removed (hotfix a888eec). Queued LOW priority via `_oqEnqueue`. |
| `fetchSkillScore(learningId)` | `debate-client.js` | Scores the closed trade's process quality 0-10. **Manual-only** — 🔬 button; auto-trigger removed (hotfix a888eec). Queued LOW priority. |
| `triggerCalibQualityIfStale(regime)` | `debate-client.js` | Fires `GET /api/debate/calib-quality` (localStorage date guard). **No longer called from `analysis.js`** — auto-trigger removed (hotfix a888eec). Must be triggered via "▶ Run debate" button on Learning page calib-quality card; `?force=1` refreshes. Queued LOW priority when triggered. *(Sprint 26)* |
| `fetchCalibrationBlock(regime, sectors, tickers, opts={})` | `learning-loop.js` | Pulls the compact calibration string from `GET /api/learning/calibration`; passes `regime_flipped_at`/`regime_flipped_to` from localStorage as query params for regime-flip penalty; injected into every Claude user message. **Sprint 71 Phase 3D:** `opts.deep` adds `&deep=1` to request the heavy exemplar/playbook/cross-tab feed and stashes the returned `exemplars` array on `window._calibExemplars` (rendered by `buildExemplarsBlock()` as the `EXEMPLARS:` block). Full portfolio analysis passes `{deep:true}`; light is the default. |
| `_calib_compute()` | `routes/learning.py` | Pure function, 5-min TTL cache (thread-safe: `_calib_lock`). Calls `_resolve_virtual_outcomes()` (writes `virtual_speed_weight`; applied as `0.75 × speed_weight` multiplier on virtual rows) and `_resolve_sell_outcomes()` lazily. Phase 8 gate: `_mann_whitney_z(wins, losses) > 1.28` (bug-fixed hotfix 16bba99 — was raw mean comparison). Regime-flip penalty: halves HL for first <10 trades in new regime when flip within 30d; emits `⚠REGIME_FLIP` token. `_HL_MAP`: panic=20d, riskOff=30d, highVol=35d, trend=45d, riskOn=50d, sideways=60d, default=45d. `_REGIME_GROUPS`: bearish={riskOff,panic}, bullish={riskOn,trend}, neutral={highVol,sideways}. Decay-weighted win rate per confidence band; returns the `adj` nudge the prompt applies to confidence. Token-budget-ordered assembly: header → conf bands → regime warning → skill insight → conservatism warning → sell tags → success nudge → per-ticker → thesis drift nudge → **(deep only) per-driver playbook → driver×regime + setup cross-tabs → SELL→ROSE negative line** (lowest priority, first to drop). **Sprint 71 Phase 3:** signature `_calib_compute(..., deep=False)`; deep mode raises the char budget (900/1100 vs 400/600), appends the conditional blocks, and computes `exemplars` (returned on a separate field, never truncated). Phase 3 helpers: `_entry_signature`, `_compute_exemplars`, `_compute_driver_playbook`, `_compute_setup_bucket_xtab`, `_compute_driver_regime_xtab`, `_compute_sell_negative_confirmation` — all CI-gated via `_ci_excludes`. |
| `_compute_thesis_drift(conn)` | `routes/learning.py` | Compares avg `realized_pnl_pct` of `manual` exits vs `target_hit` exits. Requires n≥5 in each bucket. Emits `⚠EARLY_EXIT_DRAG` nudge when drag > 3pp. Called inside `_calib_compute()` within the `with get_db() as conn:` block. Also exposed via `GET /api/learning/thesis-drift`. *(Sprint 45)* |
| `_resolve_virtual_outcomes(conn)` | `routes/learning.py` | Fetches price history for unexecuted recs ≥30d old; writes `virtual_outcome = 'virtual_win'/'virtual_loss'/'virtual_open'`. Prevents calibration from being censored to executed-only outcomes. |
| `_resolve_sell_outcomes(conn)` | `routes/learning.py` | For SELL/TRIM events ≥25d old with `sell_primary_driver` set, fetches post-sell price change (and alt ticker if `better_opportunity`). Writes `sell_verify_verdict` (`validated`/`invalidated`/`inconclusive`). Capped at 5 per calibration call. |
| `_resolve_mae_mfe(conn, cap=5)` | `routes/learning.py` | *(Sprint 71 Phase 1B)* For executed, closed BUY/TOP_UP with `actual_entry_price` set and `mae_mfe_resolved_at IS NULL`, walks daily OHLC entry→exit (window bounded by `holding_period_days`) and records `mae_pct` (worst drawdown, ≤0) + `mfe_pct` (best unrealised gain, ≥0) via the pure helper `_mae_mfe_from_ohlc(hist, entry)` — stop-first intrabar convention (gotcha #42). Idempotent, capped at 5/call, skips rows on fetch failure. Wired into `_calib_compute()` beside `_resolve_deterministic_tags`. Columns: `mae_pct REAL`, `mfe_pct REAL`, `mae_mfe_resolved_at TEXT`. |
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
- `GET /api/quote/<ticker>` — fast price + sector + **`fetched_at` (UTC ISO)**. **45 s cache.** `_quote_cached` and `_fetch_symbol` (macro) use `fetch_with_retry` with stale-cache fallback; if `_last_good` is also empty, `stooq_quote()` provides a last-resort price. Response includes `_source: 'stooq'` when the fallback fires.
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
- `GET /api/learning/stats` — confidence-band win rates + **Wilson 95% CI**, regime stats, prompt-version history, R:R stats, failure patterns, debate insights. Includes `calibration_active` (bool: n≥30), `overall_ci_lo/hi`, `success_patterns`, and `phase8_meta` (with `mann_whitney_z` and `mann_whitney_threshold`). **Sprint 71 sector analysis:** also returns `by_sector` — per-sector `{sector, n, win_rate, avg_pnl_pct, wr_vs_market_pp, dominant_error_tag}`, sorted by `n` desc. `wr_vs_market_pp` is the signed delta vs `overall_win_rate` (the whole-market baseline already in this response — an absolute sector WR is only actionable as a delta). `dominant_error_tag` splits multi-tag `error_type` on `,` (gotcha #45), excluding `none`/`external_shock`.
- `GET /api/learning/calibration?regime=X&sectors=A,B&tickers=BHP.AX,CBA.AX[&deep=1]` — compact calibration block (~30–100 tokens light / ~225 tokens deep, priority-ordered) for prompt injection. Includes per-ticker stats, sell-tag verdicts, conservatism warning when virtual-outcome `would_have_won` rate is high. **Sprint 71 Phase 3:** `deep=1` adds the token-heavy feed blocks — per-driver playbook (`mean_reversion: 61%WR when RSI<30 vs 38% when RSI>45`), `driver×regime` + `setup_score_bucket` cross-tabs, a `⚠SELL→ROSE` negative-confirmation line, and an `exemplars` array (2–3 recent closed losses + 1–2 best wins as `ACTION TICKER @ <entry-signature> → <pnl%> in <Nd>, <tag(s)>` strings; signature = RSI/BB%B/px_vs_sma200/setup_score/MACD-hist sign). Deep is requested by the full portfolio-analysis path; light (default) is stats-only for high-frequency refreshes. `deep` is part of the TTL cache key; exemplars ride a separate field (never char-budget-truncated). 5-min TTL cache via `_calib_compute()` (thread-safe). Gated at n<30 — returns base-rate prior with `exemplars:[]` when sample too small.
- `GET /api/learning/calibration-stats` — Brier score + reliability-diagram bins. Returns `{brier_score, n, bins:[{range,lo,hi,n,mean_confidence,actual_win_rate}]}`. Displayed on Learning page.
- `GET /api/learning/digest-data` — structured failure data for the postmortem digest: `{recent_failures, regime_stats, overall_wins, overall_total, error_dist, exit_dist}`. Frontend builds a Claude prompt from this and calls `callClaude('assistant', …)`.
- `GET /api/learning/sell-outcomes` — executed SELL/TRIM events with `sell_primary_driver` set, with per-event `sell_verify_verdict` badges. `?force=1` triggers immediate re-resolve before returning.
- `GET /api/learning/lessons?ticker=X&sector=Y&regime=Z&adl=<float>&asx_vol=<float>` — scoped trading lessons matching the current context; filtered by `breadth_scope` column when `adl`/`asx_vol` params provided; injected into Claude user messages (cap: 3–4 lessons, ~15–25 tokens each). *(Sprint 44: added breadth-scope filtering)*
- `POST /api/learning/lessons` — create a lesson `{lesson_text, ticker?, sector?, regime?, source, breadth_scope?}`.
- `DELETE /api/learning/lesson/<id>` — hard-delete one lesson.
- `GET /api/learning/untagged` — loss/breakeven events with no `error_type` set; used by the batch-classify button.
- `GET /api/learning/tag-reviews?limit=5` — up to 5 random unreviewed auto-tagged events; weekly spot-check queue on the Learning page.
- `POST /api/learning/tag-review` — submit `{event_id, verdict:'agree'|'disagree', corrected_tag?}`; disagree updates `error_type` → `manual` and clears `_calib_cache`.
- `GET /api/learning/tag-accuracy` — `{n, n_agree, agree_rate, label, pending_review}`. When `agree_rate < 0.60`, `_calib_compute()` restricts the `top_err` nudge to manually-reviewed events and emits `⚠AUTO_TAGS_UNRELIABLE` instead.
- `GET /api/learning/thesis-drift` — returns `{n_manual, n_target, avg_manual_pct, avg_target_pct, nudge}`; requires n≥5 in each bucket; backed by `_compute_thesis_drift(conn)`. *(Sprint 45)*
- `POST /api/learning/backfill-entry-drivers` — Thesis Tracking Phase 1. Fills `primary_entry_driver` for historical BUY/TOP_UP rows that have an `entry_signals_json` snapshot but no driver, using the deterministic `classify_entry_driver(sig)` (no Claude spend). Rows classified `unknown` stay NULL. Returns `{ok, updated, skipped, candidates}`. *(Sprint 67)*
- `GET /api/learning/entry-context?tickers=BHP.AX,CBA.AX` — Thesis Tracking Phase 2. Returns the most recent BUY/TOP_UP per ticker (prefers `was_executed=1`) as `{ok, contexts:{TICKER:{entry_date, primary_entry_driver, entry_signals:{...}, trade_thesis}}}`. Consumed by `analysis.js` (`fetchEntryContexts`) to inject `HOLDING_CONTEXT` into the sell-aware prompt and to compute the exit verdict. Cap 50 tickers; tickers with no BUY history are omitted. *(Sprint 68)*
- `GET /api/learning/trade-detail?ids=12,15` — rich per-trade detail by learning-event id (`entry_signals` parsed, `trade_thesis`, `primary_entry_driver`, `thesis_verdict`, `sell_primary_driver`, outcome, P&L, regime). Powers the Journal page's expandable detail drawer for AI-linked trades. Cap 50 ids. *(Sprint 69)*
- `GET /api/learning/thesis-matrix` — Thesis Tracking Phase 3. Cross-tab of entry driver × `thesis_verdict` with `{n, avg_pnl_pct, win_rate}` per cell, built by `_compute_thesis_matrix(conn)` from closed BUY/TOP_UP events that carry both `primary_entry_driver` and `thesis_verdict`. Returns `{ok, n_total, drivers, verdicts, matrix, insight}`. Rendered as the "Thesis Accuracy Matrix" card on the Learning page. A qualifying insight (validated vs invalidated win-rate gap ≥25pp, both n≥5) is also appended to the calibration block as a low-priority `THESIS:<driver>` token. *(Sprint 68)*
- `GET /api/learning/stop-tag-precision` — Sprint 71 Phase 2D. `% of stop_too_tight-tagged trades a wider (regime stopAtrMult × ATR) stop would have rescued to target`. Lazily resolves ≤5 counterfactuals/call via `_resolve_stop_tag_counterfactual()`; returns `{ok, n, n_saved, precision}`. Also surfaced in `/api/learning/stats` as `stop_tag_precision`. Low precision self-suppresses the calibration widen-stops nudge (`⚠STOP_TAG_UNRELIABLE`).
- `GET /api/market/universe-health` — checks all `ASX_UNIVERSE["asx200"]` tickers via yfinance `quoteType`; returns `{stale:[...], ok_count, checked_at, excluded:[...] }`; persists `universe_verified_at` to `blob_store`. Shown in Settings → App Info with "Check Now" button. *(Sprint 46: now returns `excluded` list)*
- `POST /api/market/universe-exclude` — Body: `{tickers: [...]}`. Adds tickers to `blob_store` key `universe_excluded`. Returns `{ok, excluded: [...]}`. *(Sprint 46)*
- `DELETE /api/market/universe-exclude` — Body: `{tickers: [...]}`. Removes tickers from exclusion list. Returns `{ok, excluded: [...]}`. *(Sprint 46)*

### Alerts (Telegram)
- `GET /api/alerts/config` — `{has_telegram: bool}` — whether credentials are stored.
- `POST /api/alerts/telegram` — send message. Body: `{message, token?, chat_id?}`. Explicit creds override stored. Used by the Test button.
- `POST /api/alerts/telegram/save` — persist `{token, chat_id}` to the `settings` table (keys `tg_token`, `tg_chat_id`). Pass empty strings to clear.

### Broker CSV import
- `POST /api/import/csv` — multipart upload; field `file` = CSV, optional `broker` hint (`commsec`|`selfwealth`|`auto`). Returns `{ok, broker, rows:[BUY rows], sells:[SELL rows], skipped:[{row,reason}], total}`. *(Sprint 46: SELL rows now in `sells` array, not `skipped`)*

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
- `POST /api/debate` — generate bull/bear debate for a ticker (4h signal-hash cache).
- `POST /api/debate/tag-win` — auto-tag a closed WIN with success tags (combined with skill score in Sprint 28 — use `/api/debate/skill` instead).
- `POST /api/debate/postmortem` — single-model auto-tag error_type for loss/breakeven. Auto-triggered on close (LOW priority).
- `POST /api/debate/postmortem-debate` — adversarial two-model postmortem debate (⚔️ button — user-initiated only). Phase 1 independent → Phase 2 agreement check → Phase 3 neutral synthesis on full divergence.
- `POST /api/debate/adjudicate` — cloud adjudicator (Gemini → Groq → Claude auto-pick). Scores both local models 0-10, picks winner, uses blind alias assignment. ⚖️ button — user-initiated on rows with stored debate.
- `GET /api/debate/adjudicator-status` — `{available, provider, model, providers:[...]}`. Used to enable/disable ⚖️ button and show provider picker.
- `POST /api/debate/staleness` — entry staleness check for recs ≥ 2 days old. Fires banner on rec card.
- `POST /api/debate/skill` — score closed trade quality 0–10 (skill vs luck). Also populates `success_tags` for wins in the same Ollama call (Sprint 28). 🔬 button.
- `GET /api/debate/calib-quality` — Phase 6 calibration quality card. Pre-computes binomial SE + Z-scores per calibration band, builds a constrained Ollama prompt (statistical verdict as immutable fact), returns per-band verdicts (`signal`/`uncertain`/`noise`) + qualitative analysis. Cached in `blob_store.calib_quality_latest`; `?force=1` bypasses cache; `?regime=X` scopes bands to that regime. *(Sprint 26)*
- `POST /api/debate/quick-analysis` — lightweight portfolio analysis via local Ollama (BUY/TOP_UP/HOLD/SELL/TRIM). Body: `{userMessage, model?}`. Context truncated to 6000 chars. Returns `{ok, text, model, elapsed_ms}`. Tags each rec with `_source:'local'` for the `🔒 Local` badge. SELL/TRIM use simplified 5-driver taxonomy; stop direction validated post-response. *(Sprint 41; extended Sprint 48)*

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

### Enable local LLM for portfolio analysis (no API spend)
Settings page → Display → "Use local LLM for analysis" toggle. Routes `'portfolio'` agentType calls to `POST /api/debate/quick-analysis` (Ollama) instead of Claude API. Generates BUY/TOP_UP/HOLD/SELL/TRIM — SELL/TRIM use a simplified 5-driver taxonomy (`thesis_broken`, `stop_triggered`, `target_reached`, `time_stop`, `risk_management`). The full 9-driver Claude path is still needed for secondary_factors and advanced calibration injection. Recs show `🔒 Local` badge. *(Sprint 48: SELL/TRIM support added)*

### Record a DRP event (dividend reinvestment plan)
Portfolio page → click **DRP** button on a holding row → enter shares issued, price per share, and settlement date → Apply DRP. Updates the holding's `avgPrice` (weighted), adds a `state.cgtParcels` entry with `action:'DRP'`, and logs to `state.tradeJournal`. CGT page shows an indigo DRP badge on DRP parcels. The `applyDrpEvent()` function in `portfolio.js` handles the state mutation.

### Rebalance holdings to target allocations
Risk page → Target Allocations & Drift card → **📋 Suggest Rebalance** button (visible when targets are set) → deterministic BUY/TRIM suggestions modal (no Claude call). `_buildRebalanceSuggestions()` computes drift for all tickers; filters out <1% drift and <1 share trades; sorts by largest drift; shows BUY/TRIM action, share count, estimated value, and CGT discount-at-risk warnings for parcels 320–364 days old. Cash shortfall alert shown when total BUY value exceeds `state.cash`.

### Run tests
```bash
python test_app.py   # all Python tests
npm run test:js      # Vitest JS tests (quant-engine, regime-engine, response-validator, _detectExitReason)
```
The Python suite covers: all learning-loop routes, Claude proxy endpoints, polymarket shape, JS syntax for every modified file, function presence (catches accidental deletion), regression tests for every fixed bug, infra invariants (db.py contract, ttl_cache memoisation, gunicorn config).

The Vitest suite (`tests/`) uses `vm.runInThisContext` to load browser-global scripts into Node context (mirrors the browser `<script>` tag loading order). `extractFunction()` in `tests/setup.js` uses brace-counting to extract individual functions from page files. `detect-exit-reason.test.js` loads `_detectExitReason` from `utils.js` (hoisted Sprint 43) and asserts that neither `recommendations.js` nor `performance.js` redefines it. Sprint 41 added `TestSprint41PlanAB` covering regime-aware ATR stop floor and `high_60d`/`low_60d` fields.

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

12. **API key never logged.** `saveStateToDb` explicitly skips `settings.apiKey`. If you add another secret field, do the same. Telegram `tg_token`/`tg_chat_id` are stored **server-side** in the `settings` table (not in the browser save payload) — don't move them client-side.

13. **`_detectExitReason` is direction-aware.** SELL/TRIM recs frame the stop *above* and target *below* entry (a bearish/exit thesis) — the inverse of BUY/TOP_UP. The comparisons flip on `action`. Always pass the rec's `action`. Forgetting this mislabels profitable trims as `stop_hit` and pollutes `failure_patterns`/`exit_reason_dist`.

14. **`_detectExitReason` lives in `js/utils.js` — do not redefine it in page files.** Hoisted in Sprint 43: the canonical copy is in `utils.js` (loads first); `recommendations.js` and `performance.js` both resolve it from the shared global at call time. If either page file accidentally re-introduces a local definition it will shadow the canonical copy and silently diverge. The Vitest tests (`detect-exit-reason.test.js`) assert that `utils.js` owns the definition and neither page file redefines it.

15. **`fetch_with_retry` is not the `ttl_cache`.** They're orthogonal: `ttl_cache` serves the cached result within TTL; `fetch_with_retry` retries the live call and falls back to `_last_good` only when the call keeps failing. Both can coexist on the same function — the cache returns early before a retry is needed.

16. **Broker CSV import returns SELL rows in `sells` array (not `skipped`).** *(Sprint 46)* `handleBrokerCSV()` shows a confirmation dialog for SELL rows; "Apply SELL imports" uses `matchSaleAgainstParcels()` (FIFO/LIFO per `state.cgtMethod`) and logs to `cgtDisposals` + `tradeJournal`. Tickers with no open parcels are skipped. Does not update `state.cash` (historical import).

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

31. **Heat budget uses `maxRiskBudgetPct`, not `heatBudgetPct`.** `analysis.js` reads `state.settings.maxRiskBudgetPct || 5` (default 5%). This field is also used by the Risk page gauge. The field is NOT in `config.js` defaults — it's set at runtime via the Risk page input and persisted to DB. Using a different key name when adding budget-related settings will silently break the gate.

32. **`useLocalLLM` fast-path now supports SELL/TRIM with a simplified 5-driver taxonomy** (`thesis_broken`, `stop_triggered`, `target_reached`, `time_stop`, `risk_management`). Secondary factors and the full 9-driver set require the Claude path. Recs show `🔒 Local` badge. Exit stop direction is validated post-response: SELL/TRIM stop is corrected to entry×1.03 if the model outputs it below entry.

33. **`high_60d` / `low_60d` require ≥60 bars.** `indicators.py` returns `None` for both when the ticker has fewer than 60 trading days of OHLCV history. Day-trade Signal #4 (Fibonacci zone) falls back to `return_60d` between −20% and −5% when either field is `None`. New tickers or recently listed stocks always take the fallback path.

34. **SELL/TRIM stop floor is regime-aware since Sprint 41.** `analysis.js` Step 3 reads `regimeMod.stopAtrMult ?? 2.5` from `getRegimeModifiers(state.currentRegime.regime)` — values: 2.5 riskOn/trend/sideways, 3.0 highVol, 3.5 riskOff, 4.0 panic. Recs where the stop was repaired carry `_stopRepaired: true` and `_stopRepairedMult: N`. Do not hardcode 2.5× anywhere — always read from `getRegimeModifiers()`.

35. **DRP parcels use the same `state.cgtParcels` key as regular parcels.** DRP entries are distinguished by `action: 'DRP'`. CGT calculations and cost-basis code must handle `action === 'DRP'` alongside `'BUY'`/`'TOP_UP'`. `applyDrpEvent()` in `portfolio.js` matches holdings by `ticker + activeAccount` (multi-account safe) — do not match by ticker alone.

36. **Mobile table rows must use `display:''` not `display:'table-row'` when toggling visibility.** `toggleLots()` (and any future show/hide of `<tr>` elements) sets `el.style.display = ''` so the `.tbl-stack` CSS at ≤640px can override with `display:block`. Setting `'table-row'` explicitly wins over the stylesheet and breaks the stacked card layout on mobile.

37. **New tables should include `.tbl-stack` + `data-label` to be mobile-friendly.** Any `<table>` added to a page file should: (a) set `class="tbl-stack"` on the `<table>` tag, and (b) add `data-label="Column Name"` to every `<td>`. The CSS in `asx_trading.css` then transforms it to a labelled card layout at ≤640px automatically. Secondary stats/comparison tables where side-by-side column alignment matters may intentionally omit `.tbl-stack`.

38. **`js/config.js` `API` and `settings.serverUrl` are origin-relative when served over HTTP/HTTPS.** Both fall back to `http://localhost:5000` only when the page is opened as a local `file://`. This allows the ngrok tunnel (`https://…ngrok-free.app`) to work without any config change — all fetch calls are relative to `location.origin`. Do not hardcode `localhost:5000` in new API call sites.

39. **Canvas draw operations must use `chartColor(token, fallback)`, not hardcoded hex.** *(Sprint 60)* All `strokeStyle`/`fillStyle` assignments in `charts.js` now read from CSS custom properties via `chartColor()`, so they automatically switch between light and dark palettes. When adding a new canvas chart: use `--chart-1..6` for data series, `--chart-grid` for grid lines, `--up`/`--down` for bullish/bearish fills, `--text-tertiary` for axis labels. Do NOT hardcode `#3b82f6`, `#22c55e`, etc. in new canvas code — the colors are different in dark mode.

40. **Theme is applied via `document.documentElement.dataset.theme`, not body classes.** *(Sprint 60)* CSS rules are scoped to `:root[data-theme="dark"]` (attribute) and `@media (prefers-color-scheme:dark) :root:not([data-theme="light"])` (OS). `_applyTheme('auto')` deletes the attribute; `_applyTheme('dark')` sets it. Do not try to toggle dark mode via a `body.dark` class — that pattern is not wired up and will silently do nothing.

41. **Post-mortem tagging + skill scoring are deterministic, not LLM, by default.** *(Sprint 70)* `_resolve_deterministic_tags()` (in `_calib_compute`) fills `error_type`/`skill_score` from the entry/exit capture — `classify_error_type_deterministic()` and `compute_skill_score_deterministic()` are pure functions keyed off `thesis_verdict` (the entry-vs-exit technical comparison patched onto the parent BUY at close via `recommendations.js` outcome call). The local-LLM postmortem (`/api/debate/postmortem`) and skill (`/api/debate/skill`) endpoints still exist but are **manual overrides only** — the resolver fills NULLs and never overwrites a `manual`/`auto` tag, so if you re-introduce auto-triggering of the LLM path it will silently shadow the deterministic tags. `skill_score` requires a non-null `thesis_verdict`; legacy/uncaptured trades stay NULL (neutral calibration weight) rather than getting a fabricated score. Deterministic tags carry `error_type_source='deterministic'` and are NOT subject to the `agree_rate` auto-tag gate (that gate only distrusts `'auto'`/LLM tags).

42. **Calibration nudges are gated for statistical power, not just presence.** *(Sprint 70)* `_ESS_MIN=6.0`, `_MIN_NUDGE_N=12`, and confidence-band nudges must pass `_ci_excludes(raw_wins, n, midpoint)` (Wilson 95% CI clears the band midpoint) before they fire. Do not lower these back toward the old 2.5/3 values to "surface more signal" — they were raised precisely because nudges fired on 3–5 trades inside the sampling noise. Aggregate Wilson-CI'd stats (stats page) are always shown; only behaviour-changing nudges are gated. The virtual-outcome resolver uses a **stop-first** intrabar convention (a straddle bar books the conservative loss) to match `_resolve_execution_alpha()`.

43. **The learning-event `entry_signals_json` is the WIDE entry signature; the journal `entrySignals` is a separate narrow capture.** *(Sprint 71 Phase 1A)* `logRecsToLearningLoop()` in `js/analysis.js` now writes ~24 null-safe fields into `entry_signals_json` (the original 6 + price-location `px_vs_sma20/50/200`/`pct_from_high60/low60`, volume `rvol`/`adv_20`, MACD `macd_hist`/`macd_hist_prev`/`macd_bullish`, RS `rs_score`/`rs_5d_alpha`, `setup_score`, fundamentals `forward_pe`/`pb_ratio`/`dividend_yield`/`revenue_growth`/`earnings_growth`/`days_to_earnings`). All are pulled from `state.liveSignals[ticker]` and are forward-looking (new trades only). **Update *(Sprint 71 Phase 2)*:** `rs_score` and `rs_5d_alpha` are now surfaced in `analyse_ticker()`'s main return dict in `indicators.py` (from a single `_score_ticker` call reused for `score`), so they propagate to liveSignals — but because `analyse_ticker` calls `_score_ticker` WITHOUT an index series, `rs_score` is the neutral default (5) and `rs_5d_alpha` is `None`. The fields now EXIST in the snapshot rather than being dropped; to get real relative-strength values you must pass an `^AXJO` close series into `_score_ticker`. The current-volume field on liveSignals is `volume_today` (used for `rvol`); the ADX field is `adx` (mapped to `adx_14`). The narrow 6-field `state.tradeJournal[].entrySignals` (manual-trade journal capture, Sprint 69) is a different code path — don't conflate them.

44. **MAE/MFE path stats are lazily captured, not written at close.** *(Sprint 71 Phase 1B)* `mae_pct`/`mfe_pct`/`mae_mfe_resolved_at` on `ai_learning_events` are filled by `_resolve_mae_mfe(conn)` (called inside `_calib_compute()`), 5 rows/call, only for executed closed BUY/TOP_UP. They are NULL until the resolver runs — downstream consumers (Phase 2 empirical `stop_too_tight`/`early_exit`, skill scoring) must treat them as optional. Math via the pure helper `_mae_mfe_from_ohlc(hist, entry)`: `mae_pct=(min(Low)−entry)/entry×100` (≤0), `mfe_pct=(max(High)−entry)/entry×100` (≥0); numpy scalars cast to python floats (gotcha #21).

45. **`error_type` is MULTI-TAG (comma-separated) — always split on `,` before counting or comparing.** *(Sprint 71 Phase 2A)* `classify_error_type_deterministic()` now joins ALL applicable tags (e.g. `thesis_broken,overconfident,poor_rr`). Every consumer must split: the calibration top_err nudge, `failure_patterns.by_error_type`, `_is_good_loss`, `_is_shock`, and the tag-review flow all do `(error_type or "").split(",")`. A bare equality check (`error_type == "stop_too_tight"`) silently misses compound rows. The tags are ordered most-specific→least-specific, so `split(",")[0]` is the dominant tag. Deterministic multi-tags carry `error_type_source='deterministic'` and bypass the `agree_rate` auto-tag gate (gotcha #41).

46. **The `stop_too_tight` tag is empirically validated and self-suppressing.** *(Sprint 71 Phase 2D)* When MAE/MFE are present the tag fires only if the adverse excursion pierced the stop AND price later recovered ≥50% toward target (else it falls back to the 1.5×ATR distance heuristic). Separately, `_resolve_stop_tag_counterfactual()` walks OHLC to test whether a regime-`stopAtrMult`×ATR WIDER stop would have reached target, writing `stop_cf_saved` (1/0). If the aggregate precision (`_compute_stop_tag_precision()`) is <0.5 with n≥5, `_calib_compute()` suppresses the top_err "widen stops" nudge and emits `⚠STOP_TAG_UNRELIABLE` instead — mirroring `⚠AUTO_TAGS_UNRELIABLE`. The regime stop multiples live in `_REGIME_STOP_ATR_MULT` (mirror of regime-engine.js `getRegimeModifiers().stopAtrMult`) — keep them in sync if you change the JS values.

47. **Calibration feed has a deep/light split; only deep carries exemplars + playbook + cross-tabs.** *(Sprint 71 Phase 3)* `_calib_compute(..., deep=False)` and `GET /api/learning/calibration?deep=1`. The full portfolio-analysis path (`analysis.js`) passes `fetchCalibrationBlock(..., {deep:true})`; high-frequency / intraday refreshes should stay light (default) to keep the marginal token cost low — the cached system prompt means the learning block is the only delta. `deep` is part of the calibration TTL cache key (deep and light produce different blocks). **Few-shot exemplars ride a separate `exemplars` field, NOT the char-budgeted `parts` array** — they're the highest-impact lever and must never be silently truncated; `buildExemplarsBlock()` (learning-loop.js) renders them from `window._calibExemplars` as the `EXEMPLARS:` block, injected between calibration and lessons in the user message. The playbook/cross-tab/negative lines DO live in `parts`, appended last (drop first under truncation); deep raises the char budget to 900/1100. Entry signatures (`_entry_signature`) deliberately OMIT `rs_score`/`rs_5d_alpha` (neutral placeholders today — see gotcha #43). All conditional blocks are Wilson-CI gated via `_ci_excludes`.

48. **Sector stats are ALWAYS a delta vs the whole-ASX-market baseline — never surface an absolute sector WR alone.** *(Sprint 71 sector analysis)* The whole-market view is the overall (all-rows) calibration WR. A 55% sector reads as strong in a 45% market and weak in a 65% market, so the calibration sector line (`SECTOR:NN%WR vs mkt MM% (±Xpp,n=…)`), the sector×regime block, and the `/api/learning/stats` `by_sector[].wr_vs_market_pp` all express the signed delta. The ✓strong/⚠underperform flag fires only when ESS≥6.0 AND the sector's Wilson 95% CI (on RAW win/total) excludes the market WR — reuse `_ci_excludes()`, don't build new stat machinery. Deep mode emits the full per-sector breakdown; light mode collapses to one `sector:<most-divergent>` summary line. Sector capture is hardened three ways: the log payload falls back `r.sector || holding?.sector || state.liveSignals[r.ticker]?.sector || null` (analysis.js), and `_resolve_missing_sectors(conn)` backfills historical null sectors from `core.SECTOR_MAP` (no network; strips `.AX`; unknown tickers stay null — never guessed). `_compute_exemplars(conn, sector=…)` prefers same-sector examples (dominant sector derived from the requested tickers via `SECTOR_MAP`), falling back to whole-market when too few.

49. **Never run more than one server instance against `asx_trader.db` at the same time.** The 2026-06-20 WAL corruption incident (dozens of "invalid page number" errors under `PRAGMA integrity_check`, requiring manual rowid-bisection recovery) is suspected to have come from two concurrent writers — e.g. `python asx_server.py` and `python waitress_server.py` both running, or a stray leftover process from a crashed/Ctrl+C'd session — racing on the same WAL file, possibly compounded by an ungraceful kill mid-checkpoint. Two defensive guards now exist: (a) **Single-instance lockfile** — `_acquire_single_instance_lock()` in `asx_server.py`, called only from the `if __name__ == "__main__":` block (never at import time, so `test_app.py`'s `asx_server.init_db()` + `app.test_client()` pattern is unaffected). It writes the current PID to `asx_trader.lock` next to the DB; on startup, if a lockfile exists with a different, **live** PID (checked via `os.kill(pid, 0)` — raises `OSError` for a dead/nonexistent PID on both POSIX and Windows, raises nothing if alive), the new process refuses to start and exits with a CRITICAL log line. A stale lockfile (dead PID) is silently reclaimed. The check is deliberately **fail-open**: any ambiguity — unreadable/malformed lockfile, an unexpected (non-`OSError`) exception from the liveness probe itself — logs a warning and lets startup proceed rather than risk blocking a legitimate restart. The lockfile is removed via `atexit.register()` on clean shutdown (Ctrl+C/`SystemExit` included, since Python's default SIGINT handler raises `KeyboardInterrupt`); a hard kill (Task Manager, `Stop-Process -Force`, SIGKILL) leaves a stale lockfile behind, which the *next* startup correctly reclaims. (b) **Startup integrity check** — `quick_integrity_check()` in `db.py` runs `PRAGMA quick_check` (cheaper than full `integrity_check`, sufficient as a sanity probe) once at server boot, called right after `init_db()`/`backup_db()` in `asx_server.py`. It is **non-blocking** — a result other than `'ok'` logs a CRITICAL message (console + `ai_responses/server.log`) with recovery guidance, but never refuses to start (a false positive or a merely-slow check on a large DB would be its own incident). (c) **Recovery path**: backups are plain file copies living next to the DB itself as `asx_trader.db.bak-YYYYMMDD` (NOT a `backups/` subdirectory), written by `backup_db(keep=7)` in `db.py` on every server startup plus once per 24h via the `db-backup` daemon thread in `asx_server.py`; only the 7 most recent dated copies are kept. If `quick_check` (or a manual `PRAGMA integrity_check`) ever reports corruption again, stop all server instances first, then restore the most recent `.bak-YYYYMMDD` file by copying it over `asx_trader.db` (and removing/checkpointing the stale `-wal`/`-shm` files alongside it).

---

## Deferred work (not done yet, noted for the next pass)

| Item | Why deferred | What it would unlock |
|---|---|---|
| **Full ES-modules migration** | Touching 27 JS files with no dev-server verification = high regression risk. Better to do under a feature branch + visual smoke test. | Safe dependency order, dead-code elimination, single bundled HTTP request. |
| **FastAPI migration** | Half-day refactor of every route. Current Flask + gthread is fast enough. | Native async, auto-generated OpenAPI docs, faster I/O concurrency. |
| **Walk-forward backtesting** | ~~Requires vectorised OHLCV replay engine + parameter grid.~~ **Shipped Sprint 20.** `POST /api/backtest/walk-forward`; Walk-Forward tab in Backtest page. | Robust strategy parameter tuning. |
| ~~**Mobile / responsive layout**~~ | **SHIPPED Sprint 56.** `100dvh`, 44px touch targets, safe-area insets, Safari zoom fix (16px inputs), `.tbl-stack` card layout on 5 primary tables, `_fitCanvas()` DPR helper + resize/orientationchange redraw. Phase 5 (real-device QA) remains manual via the ngrok URL. | Phone-friendly read-only mode during market hours. |
| ~~**DRP parcel tracking**~~ | **SHIPPED Sprint 44.** `applyDrpEvent()` in `portfolio.js`; DRP badge in CGT page; `action:'DRP'` in `state.cgtParcels` and `state.tradeJournal`. | Accurate CGT cost-base for DRP investors. |
| **Vitest frontend tests** | ~~JS test infrastructure needs setting up (jsdom, mocking globals).~~ **Shipped Sprint 19.** `npm run test:js` — 127 tests (Sprint 41 added Plan A/B coverage). | Catch logic regressions in quant-engine, regime-engine, _detectExitReason. |
| ~~**Hoist `_detectExitReason` into `utils.js`**~~ | **SHIPPED Sprint 43.** Single canonical copy in `js/utils.js`; neither page file redefines it; Vitest tests assert this. | Single source of truth for exit classification. |
| **`pip install feedparser`** | Optional dep; RSS falls back to a built-in XML parser when absent (logs a warning each scan). | More robust news-feed parsing. |
| ~~**Stooq rate-limiting**~~ | **SHIPPED Sprint 43.** `_stooq_sem = threading.BoundedSemaphore(1)` in `core.py`; `stooq_quote()` and `_fetch_stooq_history()` both acquire it with a 1-second `finally` sleep. | Reliable Stooq fallback under load. |
| ~~**"Quiet Terminal" UI redesign**~~ | **SHIPPED Sprint 60.** Full `asx_trading.css` rewrite: new token system (`--bg-base/surface/inset`, `--text-primary/secondary/tertiary`, `--text-muted` alias, `--border` alias, `--shadow-card/pop`, `--up/down/warn` + bg variants, `--chart-1..6`, `--chart-grid`). Dual dark-mode block (media-scoped `@media` + `[data-theme="dark"]` attribute). `chartColor(token, fallback)` in `charts.js` reads tokens at draw time. `_applyTheme(theme)` in `utils.js`. `state.settings.theme: 'auto'|'light'|'dark'`, startup call in `init.js`, Auto/Light/Dark segmented control in Settings → Display. | Token-driven theming; canvas charts follow active theme; eliminating `--text-muted`/`--border` undefined errors. |

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
