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
python test_app.py        # all 156 tests, ~10 s
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
| **Regime engine** | Classifies macro (`riskOn/riskOff/panic/highVol/trend/sideways`) from live data; gates which strategies are allowed; applies size modifiers. Panic regime returns `sizeMult=0` → `_regimeBlocked` flag, recs are dropped. |
| **Claude** | Qualitative conviction only — what to buy/sell and why. Never does arithmetic. |
| **Quant engine** | Deterministic sizing: Kelly + vol scalar + multi-constraint (account-risk %, max-position %, liquidity, Kelly). Same input → same output. |
| **Validator** | Schema + business rules; auto-repair loop (≤2 retries); HOLD recs use `requiredUnless` to skip target/stop/qty checks. |

Calibration feedback (recent hit rates by confidence band and regime) is fetched from `GET /api/learning/calibration` and injected into every Claude user message.

---

## File map

### Backend (Python)

| File | Lines | Purpose |
|---|--:|---|
| `asx_server.py` | ~205 | Flask app + middleware + blueprint registration + `__main__` bootstrap. **Holds no routes itself.** |
| `core.py` | ~230 | Shared infrastructure: `ttl_cache`, `fetch_with_retry` (exponential backoff + `_last_good` stale-cache), `_HTTP_SESSION`, `log`, `LOG_DIR`, `SECTOR_MAP`, `ASX_UNIVERSE`, `OLLAMA_BASE`. No Flask import. |
| `db.py` | ~260 | SQLite schema, `get_db()`, `init_db()`, migrations, `log_failed_ticker()`, `backup_db(keep=7)`. Single source of truth — never `sqlite3.connect()` directly. |
| `indicators.py` | ~660 | All technical indicators + `analyse_ticker()` + `_score_ticker()`. Pure compute, no Flask. |
| `announcement_engine.py` + `announcement_routes.py` | — | ASX announcements scraper, PDF parser, Gemini scorer, blueprint `/api/announcements/*`. |
| `news_engine.py` | — | RSS aggregator, TF-IDF dedup, LLM sentiment classifier (Ollama/Groq/Gemini). |
| `gunicorn.conf.py` | — | Production WSGI config. 2 workers × 8 threads. |
| `test_app.py` | ~1600 | 156 unit + integration tests. Patches `get_db` across `db`, `asx_server`, and every `routes/*` module. |

#### `routes/` — one blueprint per concern

| File | Lines | URL prefix(es) | Notes |
|---|--:|---|---|
| `routes/portfolio.py`  | ~380 | `/api/cash`, `/api/db/*`, `/api/tax/eofy-pack` | Bulk state save/load, cash balance, EOFY tax pack ZIP download. |
| `routes/dividends.py`  | ~395 | `/api/dividends/*`                              | yfinance + ASX scrape, 12 h cache, `_FRANKING_MAP` fallback. |
| `routes/market.py`     | ~670 | `/health`, `/api/{analyse,quote,macro,rba-rate,polymarket,risk,portfolio/nav-history,earnings-calendar,log/ai_response}` | All yfinance read-only data + Anthropic response logging. Uses `@ttl_cache`. |
| `routes/backtest.py`   | ~575 | `/api/backtest`, `/api/backtest/ai-replay`     | Historical strategy backtest + replay scoring of executed AI recs. |
| `routes/scanner.py`    | ~210 | `/api/market/scan*`                              | Background thread + `_scan_state` dict, sector diversification. Computes `breadth_ratio` (% of universe above 20-day SMA) after each scan; consumed by `/api/macro` via lazy import. |
| `routes/learning.py`   | ~730 | `/api/learning/*`                                | Log → outcome → stats/calibration analytics. Decay-weighted win rates. `_calib_compute()` is a pure function cached 5 min. `GET /api/learning/calibration-stats` (Brier score + reliability-diagram bins). `GET /api/learning/digest-data` (structured failure data for postmortem digest AI prompt). |
| `routes/debate.py`     | ~1001 | `/api/debate/*`                                  | Local Ollama bull/bear + postmortem + skill scoring. Direction-aware prompts (BUY vs SELL/TRIM). Uses `current_app.logger`. |
| `routes/news.py`       | ~690 | `/api/news/*`, `/api/groq/models`, `/api/google/models`, `/api/sbc-mode`, `/api/system/gpu`, `/api/ollama/start` | RSS scanner + LLM provider management + SBC toggle. Owns `_NE_OK`. |
| `routes/claude.py`     | ~85  | `/api/claude/*`                                  | Backend proxy for the Anthropic API (opt-in). |
| `routes/alerts.py`     | ~100 | `/api/alerts/*`                                  | Telegram off-device alerts. `POST /api/alerts/telegram` (send), `POST /api/alerts/telegram/save` (persist creds to settings table), `GET /api/alerts/config` (has_telegram?). Credentials stored in `settings` table as `tg_token`/`tg_chat_id` — never logged. |
| `routes/import_csv.py` | ~200 | `/api/import/csv`                                | Broker CSV parser. Auto-detects CommSec / SelfWealth / generic format; normalises to `{action, ticker, shares, price, date, brokerage}`. Returns BUY rows only; SELL rows reported as skipped (require manual entry). |

Total: **11 blueprints, 75 routes** (including announcements blueprint).

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
→ asx-universe.js → strategy.js → day-trading-analysis.js → pages/day-trading.js
→ pages/news.js → pages/announcements.js → pages/scanner.js → pages/watchlist.js → pages/learning.js
→ pages/settings.js → alerts.js → navigation.js → init.js
```

**Don't reorder these without checking dependencies.** A future ES-modules migration would make this safer (see "Deferred work" below).

### Infrastructure modules (the non-page JS)

| File | Owns |
|---|---|
| `js/config.js` | Global `state` object, `API` base URL, defaults |
| `js/api.js` | All backend fetch wrappers + `saveStateToDb()` / `loadStateFromDb()` with input validators |
| `js/claude-client.js` | `callClaude(agentType, msg, opts)` — central wrapper; supports direct + proxy mode. Agent types: `portfolio`, `analyst`, `pm`, `dayTrade`, `universe`, `macro`, `assistant`, `briefing`. |
| `js/regime-engine.js` | `classifyRegime()`, `applyRegimeModifiers()`; panic regime hard-blocks via `_regimeBlocked` |
| `js/quant-engine.js` | `computeTradeParams()` — deterministic sizing. Reads `signals.adv_20` (AUD) and `signals.volume_avg_20` (shares); liquidity cap is in shares. |
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

`js/pages/*.js` — each is a render function `renderX()` plus event handlers. Most are pure HTML-string builders. `pages/scanner.js`, `pages/day-trading.js`, `pages/learning.js`, `pages/news.js`, `pages/announcements.js` have async pollers — `navigation.js` stops them on page change. `pages/watchlist.js` renders the Watchlist page (⭐ nav item); fetches live signals async per ticker and hosts the indicator-alert creation UI.

---

## Key data shapes

```js
state.portfolio:          [{ ticker, shares, avgPrice, currentPrice, sector }]
state.tradeJournal:       [{ id, date, ticker, action, qty, entryPrice, exitPrice, fees, pnl, status, recId, recExecuted, closeDate }]
state.recHistory:         [{ id, date, ticker, action, confidence, ensembleConfidence, priceRange, target, stopLoss, qty, executed, outcome, actualProfit, regime, _learningId, _thesis?, _stopAlertedAt?, _targetAlertedAt? }]
state.recommendations:    pending recs (same shape as recHistory entries with status='pending')
state.liveSignals:        { TICKER: { current_price, rsi_14, bb_*, atr_14, adv_20 (AUD), volume_avg_20 (shares), score, ... } }
state.currentRegime:      { regime, confidence, signals: [...] }
state.priceTimestamps:    { TICKER: ISO-string }  — fetched_at from last quote call; used for stale-data badge (>25 min)
state.portfolioHistory:   [{ date, netWorth, portfolioValue, cash }]  — daily snapshots; used for drawdown monitor
state.watchlist:          [{ ticker, addedAt, notes }]  — tickers monitored but not held; persisted in blob_store
state.savedScreeners:     [{ name, savedAt, config: { universe, min_adv_aud, excludeHoldings } }]  — named scanner presets; persisted in blob_store
state.priceAlerts:        [{ id, ticker, type, value, ... }]  — types include 'rsi_below'|'rsi_above'|'bb_breakout'|'bb_breakdown'|'volume_spike' (indicator alerts) in addition to 'above'|'below'|'pct_drop'
state.settings.telegramEnabled:   bool — mirrors alerts to Telegram when true
state.settings.tgToken / tgChatId: stored locally in state but credentials saved server-side via POST /api/alerts/telegram/save
state.settings.drawdownAlertPct:  number — alert threshold for drawdown monitor (default 10)
state.targetAllocations:  { TICKER: number }  — ticker → target weight %; persisted in blob_store; used by Risk page drift card
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
performance.js syncClosedTradesToLearningLoop()  → batch backfill for legacy recs lacking a _learningId
   │
routes/learning.py  _calib_compute() / stats   → decay-weighted win rates fed back into the next prompt
```

### Key functions

| Function | File | Contract |
|---|---|---|
| `markExecuted(id, price, fee, qty)` | `recommendations.js` | Records a fill: updates portfolio/CGT/journal, pushes a `recHistory` entry, then patches the learning event. For SELL/TRIM that **fully closes** a position, it loops the still-open parent BUY/TOP_UP events and stamps each a **per-entry** outcome (`tradePrice` vs that parcel's own `executedPrice`) — never the SELL's blanket outcome. |
| `_detectExitReason(exitPrice, stopLoss, target, action)` | `recommendations.js` **and** `performance.js` (identical copies) | Classifies the exit as `stop_hit` / `target_hit` / `manual`. **Direction-aware:** BUY/TOP_UP use a long frame (stop below, target above); SELL/TRIM use the inverse (stop above, target below). Pass the rec's `action`; absent that, it infers direction from `stop > target` geometry. |
| `triggerPostmortem(learningId)` | `debate-client.js` | Fired automatically on `loss`/`breakeven`. Runs the local Ollama bull/bear postmortem. |
| `fetchSkillScore(learningId)` | `debate-client.js` | Scores the closed trade's process quality 0-10. |
| `fetchCalibrationBlock(regime, sectors, tickers)` | `learning-loop.js` | Pulls the compact calibration string from `GET /api/learning/calibration`; injected into every Claude user message. |
| `_calib_compute()` | `routes/learning.py` | Pure function, 5-min TTL cache. Decay-weighted win rate per confidence band; returns the `adj` nudge the prompt applies to confidence. |

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

### Market data (all cached via `ttl_cache`)
- `GET /api/macro` — ASX200, AUD/USD, gold, iron ore + regime fields. **5 min cache.** `advance_decline_ratio` is now populated from the last scanner run: `routes/market.py` lazy-imports `_scan_state["breadth_ratio"]` from `routes/scanner.py` (computed as % of universe above 20-day SMA after each scan). Will be `null` until the first scan completes.
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
- `GET /api/learning/stats` — confidence-band win rates + **Wilson 95% CI**, regime stats, prompt-version history, R:R stats, failure patterns, debate insights. Includes `calibration_active` (bool: n≥30) and `overall_ci_lo/hi`.
- `GET /api/learning/calibration?regime=X&sectors=A,B&tickers=BHP.AX,CBA.AX` — compact calibration block (~30–60 tokens) for prompt injection. Includes per-ticker stats for portfolio holdings. 5-min TTL cache via `_calib_compute()`. Gated at n<30 — returns `{available:false}` when sample too small.
- `GET /api/learning/calibration-stats` — Brier score + reliability-diagram bins. Returns `{brier_score, n, bins:[{range,lo,hi,n,mean_confidence,actual_win_rate}]}`. Displayed on Learning page.
- `GET /api/learning/digest-data` — structured failure data for the postmortem digest: `{recent_failures, regime_stats, overall_wins, overall_total, error_dist, exit_dist}`. Frontend builds a Claude prompt from this and calls `callClaude('assistant', …)`.

### Alerts (Telegram)
- `GET /api/alerts/config` — `{has_telegram: bool}` — whether credentials are stored.
- `POST /api/alerts/telegram` — send message. Body: `{message, token?, chat_id?}`. Explicit creds override stored. Used by the Test button.
- `POST /api/alerts/telegram/save` — persist `{token, chat_id}` to the `settings` table (keys `tg_token`, `tg_chat_id`). Pass empty strings to clear.

### Broker CSV import
- `POST /api/import/csv` — multipart upload; field `file` = CSV, optional `broker` hint (`commsec`|`selfwealth`|`auto`). Returns `{ok, broker, rows:[{action,ticker,shares,price,date,brokerage}], skipped:[{row,reason}], total}`.

### Claude proxy (opt-in)
- `GET /api/claude/settings` → `{has_key: bool}`
- `POST /api/claude/settings {api_key: 'sk-ant-...'}` — store / clear server-side key.
- `POST /api/claude/proxy` — forward request to api.anthropic.com using stored key.

### Debate engine (local Ollama)
- `GET /api/debate/status` — Ollama reachable? models available?
- `POST /api/debate` — generate bull/bear debate for a ticker.
- `POST /api/debate/postmortem` — postmortem on a closed trade.

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
`indicators.py` → `_score_ticker()`. The market scanner uses this directly.

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
python test_app.py
```
The suite covers: all learning-loop routes, Claude proxy endpoints, polymarket shape, JS syntax for every modified file, function presence (catches accidental deletion), regression tests for every fixed bug, infra invariants (db.py contract, ttl_cache memoisation, gunicorn config).

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

---

## Deferred work (not done yet, noted for the next pass)

| Item | Why deferred | What it would unlock |
|---|---|---|
| **Full ES-modules migration** | Touching 27 JS files with no dev-server verification = high regression risk. Better to do under a feature branch + visual smoke test. | Safe dependency order, dead-code elimination, single bundled HTTP request. |
| **FastAPI migration** | Half-day refactor of every route. Current Flask + gthread is fast enough. | Native async, auto-generated OpenAPI docs, faster I/O concurrency. |
| **Walk-forward backtesting** | Requires vectorised OHLCV replay engine + parameter grid — a mini framework. | Robust strategy parameter tuning. |
| **Mobile compact mode** | Needs CSS breakpoint pass on every card/table. | Phone-friendly read-only mode during market hours. |
| **Correlation-aware sizing (exact)** | Current impl warns by sector weight; actual correlation matrix (from `/api/risk`) not yet injected into quant sizing step. | Reduce size automatically when |corr| > 0.7 with existing holding. |
| **DRP parcel tracking** | Dividend income forecast assumes no DRP (dividend reinvestment); DRP parcels need their own CGT lot management. | Accurate CGT cost-base for DRP investors. |
| **Side-by-side ticker compare** | New view; 2–4 tickers' signals side-by-side. | Faster entry selection when you have multiple candidates. |
| **Vitest frontend tests** | JS test infrastructure needs setting up (jsdom, mocking globals). | Catch logic regressions in quant-engine, regime-engine, _detectExitReason. |
| **Hoist `_detectExitReason` into `utils.js`** | Currently duplicated in two page files; dedup risks the fragile script order. | Single source of truth for exit classification. |
| **Filter ETFs from `/api/earnings-calendar`** | ETF symbols (VAS, VHY, IVV…) have no fundamentals; yfinance logs a 404 ERROR per symbol. Harmless (endpoint still 200s) but noisy. | Cleaner logs. |
| **`pip install feedparser`** | Optional dep; RSS falls back to a built-in XML parser when absent (logs a warning each scan). | More robust news-feed parsing. |

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

# 2. Server starts?
python asx_server.py &
sleep 2
curl -s localhost:5000/health
kill %1

# 3. Frontend parses?
for f in js/*.js js/pages/*.js; do node --check "$f" || break; done
```

If any of those fail, something landed broken — diff against the last known-good commit.
