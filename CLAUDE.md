# CLAUDE.md — Sloth ASX Trader

## What this app is

Local-only ASX decision-support tool. **Backend:** Python Flask (`asx_server.py`) on `localhost:5000`, yfinance data, SQLite (`asx_trader.db`, WAL). **Frontend:** Vanilla JS SPA (`asx_trading.html`), talks to backend + Anthropic API directly. **AI:** Claude Sonnet 4.6 (analysis/recs), Gemini (announcements), Ollama (news/debate/optional portfolio analysis).

---

## Run instructions

```bash
pip install -r requirements.txt
python asx_server.py          # dev (single worker)
python waitress_server.py     # prod Windows (multi-threaded)
# gunicorn only on Linux/macOS (uses fcntl)
```

API key: paste in Settings (localStorage) or use backend proxy mode (`POST /api/claude/settings {api_key}` → writes git-ignored `claude-api.txt`).

Tests: `python test_app.py` · `npm run test:js`

---

## Architecture — AI pipeline

```
Signals (indicators.py) → Regime gate (regime-engine.js) → Claude → Quant engine (quant-engine.js) → Validator (response-validator.js) → UI
```

| Layer | Job |
|---|---|
| **Regime engine** | Classifies macro (riskOn/riskOff/panic/highVol/trend/sideways); gates strategies; `sizeMult=0` on panic → `_regimeBlocked`, recs dropped. `stopAtrMult` 2.5–4.0×; `_blendedSizeMult` transitions over 30 min on flip. SPI200 futures vote in classifier. |
| **Claude** | Qualitative conviction only — never does arithmetic. Always receives TAX_LOSS_HARVEST_ACTIVE, date, time, regime, calibration block. |
| **Quant engine** | Deterministic sizing: Kelly + vol scalar + multi-constraint. Rejects `kellyFrac ≤ 0`. Stop = `stopAtrMult × earningsAdj × ATR`; `earningsAdj=1.3` when `pre_earnings_risk`. |
| **Validator** | Schema + business rules; auto-repair ≤2 retries; HOLD uses `requiredUnless`. |

---

## File map — Backend

| File | Purpose |
|---|---|
| `asx_server.py` | Flask app + middleware + blueprint registration. Holds no routes itself. Single-instance lockfile (`_acquire_single_instance_lock()`); startup `quick_integrity_check()`. |
| `core.py` | `ttl_cache`, `fetch_with_retry` (exponential backoff + `_last_good` stale-cache; 4xx except 429 break retry immediately), `stooq_quote()` (price fallback), `_stooq_sem` (BoundedSemaphore(1) — 1 req/sec pace), `SECTOR_MAP`, `ASX_UNIVERSE`, `OLLAMA_BASE`. No Flask import. |
| `db.py` | SQLite schema, `get_db()`, `init_db()`, migrations, `backup_db(keep=7)`. Single source of truth — never `sqlite3.connect()` directly. `init_db()` runs `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` on startup. |
| `indicators.py` | All technical indicators + `analyse_ticker()` + `_score_ticker()`. `_drop_forming_bar()` drops today's candle before 07:00 UTC. `_sanity_check()` drops >25% single-day moves. `_fetch_stooq_history()` is free fallback provider. Returns `days_to_earnings`, `pre_earnings_risk`, `high_60d`, `low_60d`, `sector_rs_5d`. |
| `announcement_engine.py` + `announcement_routes.py` | ASX announcements, PDF parser, Gemini scorer. `get_ann_brief()` returns `key_figures` from `details` JSON on PS-type announcements, appended to `signal`. `addAnnToContext()` uses `window._annCache` (key: `ticker|date|annId`) for rich snippets. |
| `news_engine.py` | RSS aggregator, TF-IDF dedup, LLM sentiment classifier. `geopolitics` category (BBC World, oilprice.com). |
| `notifications_db.py` | Separate `notifications.db` for notification centre. |
| `day_trade_db.py` | Separate `day_trade_history.db` for ML training data. |

### `routes/` — blueprints

| File | URL prefix | Notes |
|---|---|---|
| `routes/portfolio.py` | `/api/cash`, `/api/db/*`, `/api/tax/eofy-pack`, `/api/portfolio/splits-check` | Bulk state save/load, EOFY tax ZIP (real trades only). |
| `routes/dividends.py` | `/api/dividends/*` | yfinance + ASX scrape, 12h cache. |
| `routes/market.py` | `/health`, `/api/{analyse,quote,macro,rba-rate,polymarket,risk,portfolio/nav-history,earnings-calendar,log/*,market/universe-health}` | All yfinance read-only data + prompt/response logging. |
| `routes/backtest.py` | `/api/backtest`, `/api/backtest/ai-replay` | Historical backtest + AI rec replay scoring. |
| `routes/scanner.py` | `/api/market/scan*` | Background scan thread; computes `breadth_ratio` (% universe above 20d SMA). |
| `routes/learning.py` | `/api/learning/*` | Log→outcome→stats/calibration. `_calib_compute()` (5-min TTL, thread-safe). Decay-weighted WRs, Mann-Whitney gate, regime-flip penalty, cluster-loss/lesson-drag nudges, exemplars. `_HL_MAP`: panic=20d→sideways=60d. |
| `routes/debate.py` | `/api/debate/*` | Ollama bull/bear, postmortem, adversarial debate, skill scoring, scrutinize, quick-analysis. `_call_ollama()` uses `/api/chat` (NOT `/api/generate`) with `{"messages":[{"role":"user","content":prompt}]}`; parse `data["message"]["content"]`. |
| `routes/news.py` | `/api/news/*`, `/api/groq/models`, `/api/google/models`, `/api/sbc-mode`, `/api/system/gpu`, `/api/ollama/start` | RSS scanner + provider management. |
| `routes/claude.py` | `/api/claude/*` | Backend proxy for Anthropic API. Key from `claude-api.txt` (file-first) then legacy SQLite row. |
| `routes/alerts.py` | `/api/alerts/*` | Telegram alerts. Creds in `settings` table server-side. |
| `routes/import_csv.py` | `/api/import/csv` | Broker CSV parser (CommSec/SelfWealth/generic). BUY→`rows`, SELL→`sells` (not `skipped`). |
| `routes/intraday.py` | `/api/intraday/<ticker>`, `/api/intraday/scan` | 5m intraday analysis. Returns `atr_5m`, `vwap`, `intraday_target = vwap + 2×atr_5m`. Entry window 10:45–15:00 AEST. |
| `routes/notifications.py` | `/api/notifications` | Notification persistence (separate `notifications.db`). |
| `routes/day_trade_training.py` | `/api/daytrading/*` | Local logistic regression ML pipeline (pure numpy). FEATURES_SWING (16) + FEATURES_INTRADAY (19). |

---

## Frontend — JS load order

```
config.js → utils.js → notifications.js → regime-engine.js → learning-loop.js → quant-engine.js
→ api.js → portfolio-helpers.js → scheduler.js → reconcile.js → prices.js → charts.js
→ pages/dashboard.js → pages/portfolio.js → pages/macro.js → pages/signals.js
→ pages/recommendations.js → pages/journal.js → pages/cgt.js → pages/performance.js
→ pages/backtest.js → pages/risk.js → pages/assistant.js
→ prompts.js → prompt-modules.js → claude-client.js → debate-client.js
→ response-validator.js → analysis.js
→ asx-universe.js → strategy.js → intraday-strategy.js → day-trading-analysis.js → dt-training.js → pages/day-trading.js
→ pages/news.js → pages/announcements.js → pages/scanner.js → pages/watchlist.js → pages/compare.js → pages/learning.js
→ pages/settings.js → alerts.js → navigation.js → init.js
```

### Key infrastructure modules

| File | Owns |
|---|---|
| `js/config.js` | Global `state` object, `API` base URL, defaults |
| `js/utils.js` | `escapeHTML`, `fmt`, `fmtp`, portfolio math, `mergedPortfolio()`, `_detectExitReason()` (canonical — do NOT redefine in page files), `isRealTrade()`, `askTradeMode()`, `adjustCashForMode()`, `_applyTheme()`, `reasoningText()`, `entrySignature()` |
| `js/api.js` | Backend fetch wrappers, `saveStateToDb()` / `loadStateFromDb()` |
| `js/claude-client.js` | `callClaude(agentType, msg, opts)` — direct + proxy mode. Portfolio uses forced tool use. `_callLocalAnalysis()` fast-path when `useLocalLLM`. Agent types: `portfolio`, `analyst`, `pm`, `dayTrade`, `universe`, `macro`, `assistant`. |
| `js/regime-engine.js` | `classifyRegime()`, `applyRegimeModifiers()`, `getRegimeModifiers()` (returns `stopAtrMult`). Panic → `_regimeBlocked`. `_blendedSizeMult` 30-min linear transition on flip. SPI200 votes in classifier. |
| `js/quant-engine.js` | `computeTradeParams()` — Kelly + constraints. Rejects `kellyFrac ≤ 0` before `minQty` floor. Stop = `regimeMod.stopAtrMult × earningsAdj × ATR`. |
| `js/response-validator.js` | `validateRec()`, `getValidatedAnalysisWithRepair()`. Ticker: `[A-Z0-9]{2,5}`. `requiredUnless:'HOLD'`. |
| `js/learning-loop.js` | `fetchCalibrationBlock()`, `computeThesisDrift()` (exit verdict: validated/partially_validated/invalidated/reversed/irrelevant), `fetchEntryContexts()`. |
| `js/prompts.js` | All system prompts. `PROMPT_VERSION = '2026-06-v15'`. `scenarios` required non-HOLD. `bullCase` required BUY/TOP_UP. `bearCase` required SELL/TRIM and BUY/TOP_UP ≥0.70 confidence. `invalidationCondition` required non-HOLD. `primary_entry_driver` required BUY/TOP_UP. |
| `js/prompt-modules.js` | `RULE_MODULES` + `assembleOptionalModules()`. Detects sectors from: portfolio, liveSignals, context.sectors. |
| `js/analysis.js` | Portfolio analysis orchestration. Injects `ACTIVE_REGIME`, `stopAtrMult`, calibration block, exemplars, lessons. `maxTokens` uses claude-client.js default (12000). |
| `js/charts.js` | `_fitCanvas()` (DPR-crisp), `chartColor(token, fallback)` (CSS custom props — never hardcode hex). Redraws on viewport-width change. |
| `js/navigation.js` | `showPage()` + `renderPage()` with error boundary. |
| `js/strategy.js` | `DT_FILTER` + `DT_AI_PARAMS`. `_ruleOn(paramsObj, key)` checks `enabled[key] !== false`. |
| `js/pages/signals.js` | `SIGNAL_RULES` (buy/sell/info types), `_computeSignalClusters()`, `_renderBreadthGauge()`, `_renderSectorHeatmap()`. See gotcha #89. |
| `js/pages/portfolio.js` | `toggleLots()` sets `display:''` not `'table-row'` (mobile override). Per-lot account `<select>`. |

---

## Key data shapes

```js
state.portfolio:         [{ ticker, shares, avgPrice, currentPrice, sector }]
state.tradeJournal:      [{ id, date, ticker, action, qty, entryPrice, exitPrice, fees, pnl,
                           status: 'open'|'trimmed'|'closed', recId, regime, parcel, mode }]
  // action: BUY|SELL|TOP_UP|TRIM|HOLD|DRP|RECLASSIFY
  // parcel: "P#<id>" on SELL/TRIM disposal rows; null on BUY/TOP_UP
  // mode: 'real'|'paper' — only 'real' appears in tax math
state.recHistory:        [{ id, date, ticker, action, confidence, target, stopLoss, qty,
                           executed, outcome, regime, _learningId, mode,
                           bullCase, bearCase, scenarios, primary_entry_driver,
                           thesis_verdict, invalidationCondition, reallocationSuggestion,
                           _confidenceHeld, _regimeBlocked, _preEarningsAdj }]
state.liveSignals:       { TICKER: { current_price, rsi_14, bb_pct_b, bb_upper, bb_lower,
                           atr_14, adv_20 (AUD $), volume_avg_20 (shares), score,
                           sector_rs_5d, macd_hist, ... } }
state.currentRegime:     { regime, confidence, signals, _blendedSizeMult?, _prevSizeMult? }
state.portfolioHistory:  [{ date, netWorth, portfolioValue, cash, paperValue }]  // netWorth/portfolioValue/cash = real (NAV); paperValue = paper holdings mkt value (no cash), undefined pre-split
state.settings:          { apiKey, useBackendProxy, useLocalLLM, maxRiskBudgetPct (default 5),
                           autoMacroBrief, autoMacroBriefTime, theme:'auto'|'light'|'dark',
                           telegramEnabled, drawdownAlertPct, compactMode, paperStartCash }
state.paperCash:         number  // simulated pool; real state.cash stays separate
state.portfolioViewMode: 'all'|'real'|'paper'  // Portfolio page toggle
state.targetAllocations: { TICKER: number }  // % weight targets
state.termDeposits:      [{ id, label, amount, rate, maturityDate, notes }]
state.watchlist:         [{ ticker, addedAt, notes }]
state.savedScreeners:    [{ name, savedAt, config }]
state.priceAlerts:       [{ id, ticker, type, value }]
```

**Critical:** `adv_20` = dollar turnover (close × volume). `volume_avg_20` = share count. Quant liquidity cap is in shares.

---

## Learning Loop

### Life-cycle
```
analysis.js logRecsToLearningLoop() → POST /api/learning/log  (was_executed=0)
recommendations.js markExecuted()   → POST /api/learning/outcome (was_executed=1, outcome)
performance.js syncClosedTrades()   → batch backfill; writes _learningId back to recHistory
routes/learning.py _calib_compute() → decay-weighted WRs injected into next prompt
```

### Key functions

| Function | File | Contract |
|---|---|---|
| `markExecuted()` | `recommendations.js` | Per-entry outcome on close (each parcel judged vs its own entry price). For full-close SELL, reconciles all parent BUY/TOP_UP events. Now async — fetches missing liveSignals/regime before snapshotting. |
| `_detectExitReason()` | `utils.js` (canonical) | `stop_hit`/`target_hit`/`manual`. Direction-aware: BUY long frame, SELL/TRIM inverse. Both `recommendations.js` and `performance.js` resolve it from utils at runtime — never redefine. |
| `_calib_compute()` | `routes/learning.py` | Pure, 5-min TTL cache (thread-safe `_calib_lock`). Calls lazy resolvers: `_resolve_virtual_outcomes`, `_resolve_sell_outcomes`, `_resolve_mae_mfe`, `_resolve_deterministic_tags`, `_resolve_hold_outcomes`, `_resolve_exit_quality_tags`, `_resolve_stop_tag_counterfactual`, `_resolve_missing_sectors`. Phase 8 gate: Mann-Whitney z > 1.28. ESS_MIN=6.0, MIN_NUDGE_N=12. `deep=True` raises char budget and adds exemplars/playbook/cross-tabs. |
| `fetchCalibrationBlock()` | `learning-loop.js` | Pass `{deep:true}` for full portfolio analysis; stashes `exemplars` on `window._calibExemplars`. |
| `computeThesisDrift()` | `learning-loop.js` | 5-state verdict: `validated`/`partially_validated`/`invalidated`/`reversed`/`irrelevant`. |

---

## Backend endpoint reference

### Portfolio
- `POST /api/db/save` / `GET /api/db/load` — bulk state save/restore
- `GET /api/cash` / `POST /api/cash`
- `GET /api/tax/eofy-pack?year=N` — ZIP with CGT + fee CSVs (real trades only)
- `GET /api/portfolio/splits-check?tickers=...` — yfinance splits last 90d

### Market data
- `GET /api/macro` — ASX200, AUD/USD, gold, iron ore, SPI200 futures, A-VIX proxy. 5-min cache.
- `GET /api/quote/<ticker>` — price + sector + `fetched_at`. 45s cache. Falls back to Stooq (`_source:'stooq'`).
- `GET /api/analyse/<ticker>` / `POST /api/analyse/batch` — full indicator pack. 5-min cache.
- `GET /api/risk?tickers=...&rf=4.35` — beta, Sharpe, VaR, CVaR, correlation matrix
- `GET /api/seasonality/<ticker>` — 12-month avg return pattern. 24h cache.
- `GET /api/rba-rate` — live scrape → DB cache → fallback
- `GET /api/polymarket` — Manifold probabilities. 30-min cache.
- `GET /api/market/universe-health` — checks all ASX200 tickers via yfinance
- `POST/DELETE /api/market/universe-exclude` — exclusion list for scanner

### Scanner
- `POST /api/market/scan` — start background scan (409 if running)
- `GET /api/market/scan/status` — progress poll
- `POST /api/market/scan/stop`

### Learning
- `POST /api/learning/log` — log a rec event
- `POST /api/learning/outcome` — patch outcome (partial update)
- `DELETE /api/learning/event/<id>`
- `GET /api/learning/stats` — confidence-band WRs, Wilson CIs, regime stats, sector stats, buy_vs_topup, capital_efficiency, ensemble_divergence, mae_mfe_summary, hold_outcomes, real_vs_paper
- `GET /api/learning/calibration?regime=X&sectors=A,B&tickers=...&deep=1` — compact calibration block for prompt injection. 5-min TTL. n<30 returns base-rate prior.
- `GET /api/learning/calibration-stats` — Brier score + reliability diagram. Writes daily snapshot.
- `GET /api/learning/calibration-trend` — Brier history (last 180d)
- `GET /api/learning/calibration-efficacy` — does nudge beat raw confidence? (Brier comparison)
- `GET /api/learning/recent-rec?ticker=X` — most recent logged rec (any action)
- `GET /api/learning/entry-context?tickers=...` — most recent BUY/TOP_UP per ticker for holding-context injection
- `GET /api/learning/trade-detail?ids=...` — rich per-trade detail for Journal drawer
- `GET /api/learning/thesis-matrix` — driver × thesis_verdict cross-tab
- `GET /api/learning/driver-matrix` — driver × regime × sector 3D cross-tab (n≥3 cells)
- `GET /api/learning/factor-win-rates` — empirical IC per entry-signal factor
- `GET /api/learning/lessons?ticker=X&sector=Y&regime=Z&adl=&asx_vol=` — scoped lessons for prompt injection
- `POST /api/learning/lessons` / `DELETE /api/learning/lesson/<id>`
- `GET /api/learning/lesson-effectiveness` — WR before/after each lesson, sorted worst-first
- `GET /api/learning/sell-outcomes` — SELL/TRIM events with `sell_verify_verdict`
- `GET /api/learning/untagged` — loss/BE events missing `error_type`
- `GET /api/learning/tag-reviews?limit=5` / `POST /api/learning/tag-review` — spot-check auto-tags
- `GET /api/learning/tag-accuracy` — agree_rate (gates calibration nudge at <0.60)
- `GET /api/learning/stop-tag-precision` — `stop_too_tight` counterfactual accuracy
- `GET /api/learning/thesis-drift` — manual vs target-hit exit P&L gap
- `GET /api/learning/execution-alpha` — actual vs simulated mechanical exits
- `POST /api/learning/backfill-entry-drivers` — fills `primary_entry_driver` on historical rows
- `GET /api/learning/digest-data` — structured data for AI Postmortem Digest (150 trades, 15 exemplars)
- `GET /api/learning/scrutiny-stats` — local-LLM critic track record vs outcomes

### Debate engine
- `GET /api/debate/status`
- `POST /api/debate` — bull/bear debate (4h cache)
- `POST /api/debate/postmortem` — single-model error_type tagger (manual via 🔍 button, NOT auto)
- `POST /api/debate/postmortem-debate` — adversarial two-model (⚔️ button, user-initiated only)
- `POST /api/debate/adjudicate` — cloud adjudicator (Gemini→Groq→Claude)
- `POST /api/debate/skill` — quality score 0-10 (🔬 button, manual only)
- `POST /api/debate/scrutinize` — local-LLM second opinion on pending rec by `id` (_learningId). Manual only.
- `GET /api/debate/calib-quality` — per-band statistical verdicts (▶ Run debate button only)
- `POST /api/debate/quick-analysis` — Ollama portfolio analysis when `useLocalLLM`. Simplified 5-driver taxonomy for SELL/TRIM.

### Alerts, CSV, Notifications, Day-trade ML, AI log
- `GET/POST /api/alerts/config`, `/api/alerts/telegram`, `/api/alerts/telegram/save`
- `POST /api/import/csv` — BUY→`rows`, SELL→`sells`
- `POST/GET/DELETE /api/notifications`, `/api/notifications/unread-count`, `/api/notifications/read-all`
- `POST /api/daytrading/snapshot` / `PATCH .../close` / `GET .../history` / `GET .../stats` / `POST .../train` / `GET .../model` / `POST .../predict` / `DELETE .../<id>`
- `POST /api/log/ai_response` — auto-called from `callClaude()`. `GET /api/log/ai_calls` / `GET /api/log/ai_call/<id>`

### Claude proxy
- `GET /api/claude/settings` / `POST /api/claude/settings {api_key}` — writes `claude-api.txt` (git-ignored). Empty string clears both file and legacy DB row.
- `POST /api/claude/proxy`

---

## Gotchas / contracts

1. **Ticker symbols include digits.** `A2M`, `S32`, `360` are valid. Validator regex: `[A-Z0-9]{2,5}(\.AX)?`.

2. **`adv_20` ≠ share count.** Dollar turnover (close × volume). Use `volume_avg_20` for shares.

3. **Panic regime drops recs entirely.** `qty=0, _regimeBlocked='panic'`. Don't surface them.

4. **HOLD recs omit target/stop/qty.** `requiredUnless:'HOLD'`. Follow this for new action types.

5. **`priceAlerts`, `watchlist`, `savedScreeners` ARE persisted** in both `api.js` save payload and `BLOB_KEYS`. Don't drop from either side.

6. **Stop/target alerts fire once.** `_stopAlertedAt`/`_targetAlertedAt` — re-arms only after >2% retreat.

7. **HTML script load order is fragile.** Append new modules after their dependencies. No ES-modules safety yet.

8. **SQLite `synchronous=NORMAL` + WAL.** Crash-safe. Don't downgrade to FULL.

9. **`db.get_db` is the single source of truth.** Never `sqlite3.connect()` directly. Every `routes/*.py` has its own `get_db` binding — patch ALL in `test_app.py → _install_in_memory_db()` when adding a new blueprint.

10. **Render functions must be pure.** No state mutation inside render; reconcile before the HTML build.

11. **Error boundary catches render exceptions.** `navigation.js → renderPage()`. Stack in `console.error`.

12. **API key never logged.** `saveStateToDb` skips `settings.apiKey`. Telegram creds stored server-side only.

13. **`_detectExitReason` is direction-aware.** SELL/TRIM stop is ABOVE entry (bearish frame). Always pass `action`. Lives in `utils.js` — never redefine in page files (Vitest asserts this).

14. **`fetch_with_retry` ≠ `ttl_cache`.** Orthogonal: cache serves within TTL; retry/fallback fires only on live-call failure.

15. **`fetch_with_retry` 4xx handling.** 4xx except 429 break retry immediately. 429 gets minimum 5s sleep.

16. **CSV import SELL rows in `sells` array, not `skipped`.** `handleBrokerCSV()` handles them separately with FIFO matching.

17. **Drawdown monitor needs ≥2 portfolio history entries.** Intentional — no spurious cards on fresh install.

18. **Forming-bar guard drops today's candle before 07:00 UTC.** `_drop_forming_bar()` in `indicators.py`. Prevents incomplete intraday bars from inflating signals.

19. **Stooq ticker format:** `BHP.AX` → `bhp.au`. Do NOT pass `.AX` format to Stooq.

20. **Stop proximity alert is direction-aware.** BUY: `(price − stop) / price`. SELL/TRIM: `(stop − price) / price`. One-shot via `_proximityAlertedAt`.

21. **Numpy scalars must be cast before JSON serialization.** Use `safe_float()`, `int()`, `bool()` — never raw numpy in any `analyse_ticker()` return dict.

22. **`syncClosedTradesToLearningLoop()` must write `_learningId` back to the original `state.recHistory` entry.** Writing only to the spread copy loses it on next save.

23. **Use `stk.earnings_history` not `stk.quarterly_earnings`.** Deprecated in yfinance ≥0.2.x.

24. **`_calib_cache` protected by `_calib_lock`.** Compute DB work OUTSIDE the lock; only dict read/write inside.

25. **`minQty` floor must never run on zero/negative pre-floor qty.** Kelly guard and `rawQty * volScalar ≤ 0` guard both run BEFORE `Math.max(minQty, ...)`.

26. **`_sanity_check` runs after `_drop_forming_bar`.** Drops >25% moves (data errors). Penny stocks (<$0.50) exempt.

27. **`FACTOR_WEIGHTS` must sum to 100.** `_score_ticker()` normalizes against weights. Emits `warnings.warn` at import if wrong.

28. **`pre_earnings_risk` comes from `analyse_ticker()`, not the quant engine.** If absent from cache, `earningsAdj` defaults to 1.0. Recs show `📅 Pre-earnings` badge.

29. **`_blendedSizeMult` set by `fetchAndClassifyRegime()`, not `getRegimeModifiers()`.** Stored on `_regimeCache`. 15-min TTL.

30. **Intraday strategy is same-day only.** Entry window 10:45–15:00 AEST. Time-stop alert at 15:00. Stops/targets are ATR-based (`atr_5m`), NOT fixed-%. Falls back to fixed-% when `atr_5m` null.

31. **Heat budget key is `maxRiskBudgetPct`, not `heatBudgetPct`.** Not in `config.js` defaults — set via Risk page input.

32. **`useLocalLLM` fast-path supports SELL/TRIM with 5-driver taxonomy only** (`thesis_broken`, `stop_triggered`, `target_reached`, `time_stop`, `risk_management`). SELL/TRIM stop validated post-response: corrected to entry×1.03 if below entry.

33. **`high_60d`/`low_60d` require ≥60 bars.** Returns `None` for newer tickers. Day-trade Fibonacci fallback uses `return_60d` when either is `None`.

34. **SELL/TRIM stop floor is regime-aware.** Always read `regimeMod.stopAtrMult` from `getRegimeModifiers()` — never hardcode 2.5×.

35. **DRP parcels use `state.cgtParcels` with `action:'DRP'`.** CGT code must handle DRP alongside BUY/TOP_UP.

36. **Mobile table rows: use `display:''` not `display:'table-row'`** when toggling `<tr>` visibility (lets `.tbl-stack` CSS override at ≤640px).

37. **New tables should use `.tbl-stack` + `data-label` for mobile.** Exception: comparison tables where column alignment matters.

38. **`API` constant is origin-relative when served over HTTP/HTTPS.** Falls back to `http://localhost:5000` only for `file://`. Never hardcode `localhost:5000` in new fetch calls.

39. **Canvas draw operations must use `chartColor(token, fallback)`.** Never hardcode hex. Tokens: `--chart-1..6`, `--chart-grid`, `--up`/`--down`, `--text-tertiary`.

40. **Theme via `document.documentElement.dataset.theme` attribute.** `_applyTheme('auto')` deletes it. Not body class — body class does nothing.

41. **Post-mortem tagging is deterministic by default (Sprint 70).** `_resolve_deterministic_tags()` fills `error_type`/`skill_score` from entry/exit capture. LLM postmortem/skill are manual-only overrides. Source: `error_type_source='deterministic'`.

42. **Calibration nudges are statistically gated.** `_ESS_MIN=6.0`, `_MIN_NUDGE_N=12`, Wilson-CI gate. Don't lower these.

43. **`entry_signals_json` is the WIDE entry signature (~24 fields).** `state.tradeJournal[].entrySignals` is a SEPARATE narrow 6-field capture (manual trades). Don't conflate.

44. **MAE/MFE are lazily captured post-close.** NULL until `_resolve_mae_mfe()` runs. Downstream must treat as optional.

45. **`error_type` is MULTI-TAG (comma-separated).** Always split on `,` before counting or comparing. `split(",")[0]` is the dominant tag.

46. **`stop_too_tight` tag is empirically validated.** MAE version: adverse excursion pierced stop AND price recovered ≥50% toward target. Self-suppresses if counterfactual precision <0.5 (n≥5).

47. **Calibration deep/light split.** Only `deep=1` carries exemplars + playbook + cross-tabs. `deep` is part of the TTL cache key. Exemplars ride a separate field — never char-budget truncated. Full portfolio analysis passes `{deep:true}`; high-frequency passes light.

48. **Sector stats always expressed as delta vs whole-market baseline.** `wr_vs_market_pp` = signed delta. The ✓/⚠ flag fires only when ESS≥6.0 AND Wilson CI excludes the market WR. `_resolve_missing_sectors()` backfills null sectors from `SECTOR_MAP` (no network).

49. **Never run two server instances against `asx_trader.db` simultaneously.** WAL corruption risk (happened twice: 2026-06-20, 2026-07-02). Single-instance lockfile in `asx_server.py`. Backups: `asx_trader.db.bak-YYYYMMDD` (keep=7), written on startup + every 24h. Recovery: stop all instances, copy `.bak-YYYYMMDD` over `asx_trader.db`, remove `-wal`/`-shm` files. `.corrupted-*` files are untracked — never commit.

50. **Backend-proxy key lives in `claude-api.txt`, not the DB.** File-first in `_resolve_proxy_key()`. Survives DB reset. Empty `api_key` in `POST /api/claude/settings` removes both file and legacy DB row.

51. **`syncClosedTradesToLearningLoop()` requires `recId != null`** before grading against a journal entry. `addManualTrade()` always sets `recId:null` — don't let manual-close pollute calibration.

52. **Confidence-floor breach is a hard gate in pre-trade checklist.** Red banner + forced-ack checkbox required. "Proceed anyway" button removed for `_confidenceHeld` cases.

53. **`scenarios` required for all non-HOLD recs; `bullCase` required on all BUY/TOP_UP; `invalidationCondition` required non-HOLD** (must be measurable — a price level, %, timeframe, or named event).

54. **`dt-training.js` fetch URLs must use `${API}` prefix.** Bare `/api/...` paths fail under `file://`.

55. **Sector module detection reads three sources.** `assembleOptionalModules()`: portfolio sectors, `state.liveSignals` sectors, `context.sectors`. Don't trim the liveSignals scan.

56. **`_confidenceHeld` preserves original action + adds ⛔ HELD badge.** Rec is NOT dropped or converted to HOLD. Pre-trade checklist gates execution (gotcha #52).

57. **`invalidationCondition` rendered as amber "⚡ Invalidated if" banner on rec card.** Vague triggers fail the repair loop.

58. **Intraday stops/targets are ATR-based, not fixed-%.** `stop = entry − 1.5 × atr_5m`, `target = vwap + 2 × atr_5m`. Falls back to fixed-% only when `atr_5m` null.

59. **`thesis_verdict` has 5 states.** `validated`/`partially_validated`/`invalidated`/`reversed`/`irrelevant`. Scores: partially_validated+win=7, reversed+win=2, reversed+loss=1.

60. **Deterministic success tags fill `success_tags` (wins only).** `_classify_success_tags_deterministic()`: `regime_aligned`, `disciplined_hold`, `clean_path`, `thesis_confirmed`, `strong_process`. Never overwrites Ollama/manual tags. Learning-page Recent Events shows the per-win tag-status via `winTagState` (`pattern`/`none`/`untagged`): pattern → chips, `'none'` → muted "✓ no pattern" chip (classified, nothing notable), NULL → hollow 🏆 button. `'none'` and NULL must stay visually distinct (a classified win ≠ an un-classified one). Rows carry `data-wintag`; `_llFilterWinTags()` filters by status. Header shows `Wins tagged: X/Y`.

61. **`GET /api/learning/driver-matrix` returns n≥3 cells only.** 3D: driver × regime × sector.

62. **Debate Engine is collapsed by default on Learning page** (`<details>` without `open`). Don't un-collapse — synthetic debate is lower signal than real trade data.

63. **`sector_rs_5d` = ticker 5d return minus sector ETF return.** Returns `None` on any ETF fetch failure. Never use Stooq fallback for ETFs.

64. **Exit-signals capture (`exit_signals_json`) is a SEPARATE column from `entry_signals_json`.** Captured by `markExecuted()` SELL/TRIM branch. `exit_quality_tag` is a distinct column — NOT folded into `error_type`.

65. **Regime captured at THREE independent points: generation time (`regime`), execution time (`regime_at_execution`), close time (`regime_at_close`).** Never update the write-once `regime` column after creation. `trade_journal.regime` is null for backdated/CSV imports.

66. **SELL/TRIM creates ONE journal row PER PARCEL.** `buildDisposalJournalEntries()` unshifts as it builds — callers must NOT push the returned array again. Parent BUY/TOP_UP status → `'closed'` or `'trimmed'`. Multi-parcel `recId` lookups must `.filter()` + sum, not `.find()`.

67. **`markExecuted()` account resolution prefers explicit `execAccount` over guessing.** Uses `_normTicker()` for matching (strips `.AX`). Day-trade sync checks remaining `'trading'`-account shares (ground truth), not the account argument.

68. **Groq/Gemini HTTP errors use `classify_llm_http_error()`.** Always log at `.warning()` or higher — `.debug()` is silent in `server.log` (INFO level).

69. **Every Day Trading rule is individually enable/disable-able via `enabled:{key:bool}` map.** `_ruleOn(paramsObj, key)` returns true unless `=== false`. Confirmation signals use AND-over-ticked signals. Defaults must deep-copy `enabled` on reset — shallow spread shares the reference. `setDtParam()` must check `typeof rawValue === 'boolean'` before `Number()` coercion.

70. **`updateSetting(key, value)` must not `Number()`-coerce booleans.** Check `typeof value === 'boolean'` first. Affects `autoMacroBrief`, `telegramEnabled`, and any future boolean setting.

71. **`runMacroAnalysis()` triggers a News Scanner pass first** (`_ensureFreshNewsScan()`, 90s cap). Then fetches `GET /api/news/brief?days=2&limit=15`, filtered to `category in [macro, geopolitics]`, capped at 12. **No impact-score fallback** — score rubric inflates stock-specific stories (confirmed 2026-06-25).

72. **`geopolitics` is a first-class news category.** Feeds: BBC World, oilprice.com. STEP 3 specificity penalty SKIPPED for `macro`/`geopolitics` articles.

73. **Day Trading scan dispatches via `state.dayTrading.universeKey`** to `_runPortfolioWatchlistScan()` or `_runUniverseScan()`. Single button. Third scan strategy → new `_run*Scan()` + new dispatch branch.

74. **Portfolio account assignment is per-lot, not per-holding.** `setParcelAccount(parcelId, newAccount)` mutates parcel then calls `_recomputeHoldingFromParcels()` for both old and new account. `splitParcel()` divides one open parcel into two (rejects already-partial-sold parcels). Lots row always expandable.

75. **`splitParcel()` keeps parcel↔position relationship 1:1.** Splitting a parcel linked to an open day-trade splits the position too (`_splitLinkedPosition()`). Every position carries `parcelId` from creation.

76. **Swing day-trading has same parcel-account sync as Intraday.** Closing via reclassification uses `status:'dismissed'` (not `'closed'` — no P&L event).

77. **SUPERSEDED by gotcha #79.** `setParcelAccount()` no longer inserts journal rows per move.

78. **A lot belongs to AT MOST ONE day-trade system (Intraday XOR Swing).** Removal functions return `true` iff they actually removed something. `parcel._dtLastSystem` tracks which system for re-open routing. Default to `'intraday'` for new entries.

79. **Every parcel has AT MOST ONE journal row, updated in place, found by `parcelId`.** `splitParcel()` → parent row flips to `RECLASSIFY`, sibling gets `BUY` row with original purchase date + inherited `recId`/`entrySignals`. `setParcelAccount()` → mutates `account`/`action:'RECLASSIFY'` in place. Status stays `'open'`. `_findParcelJournalRow()` filters to `action in BUY/TOP_UP/RECLASSIFY`. Journal regime badge reads `matchedRec?.regime || t.regime`.

80. **`buildDisposalJournalEntries()` status patch must match `action === 'RECLASSIFY'` too.** A reclassified parcel's row is still the open-parcel row and must receive `'closed'`/`'trimmed'` on sale.

81. **Nine account-scoping bugs fixed in one pass (2026-06-25).** Key rules: `_findParcelJournalRow()` filters action type; `markExecuted()` parent reconciliation scopes to `sellAccount`; `_applyImportedSells()` routes through `buildDisposalJournalEntries()`; `addHolding()` passes `account` to `addParcel()`; `reconcileJournalParcels()` scopes parcel match by account+mode; `matchSaleAgainstParcels()` no-parcels fallback uses scoped `getPortfolioHolding`; `removeHolding()` blocks if open parcels exist; `rollbackTradeJournalEntry()` returns `true`/`false` and `removeJournalTrade()` refuses to delete on false.

83. **`rec_history` has `extra_json` column for rich rec fields.** `db_save()` writes `json.dumps(r)` to `extra_json`; `db_load()` spreads parsed `extra_json` as base then overlays explicit columns. Legacy rows get the narrower explicit-only shape. New bulk-saved arrays with ad-hoc fields → use `BLOB_KEYS` JSON-blob pattern by default.

84. **`rec.reasoning` must always be a plain string.** `applyRegimeModifiers()` appends warnings as text. Use `reasoningText(r)` helper (`utils.js`) wherever string methods are called on `rec.reasoning`.

85. **Six Learning Loop deepening features:**
    - **Reasoning-text exemplars:** `bull_case`/`bear_case` columns in `ai_learning_events`. `logRecsToLearningLoop()` sends them. `_compute_exemplars()` appends ~60-char snippet (bearCase preferred for losses).
    - **HOLD outcome tracking:** `_resolve_hold_outcomes()` writes `virtual_hold_miss`/`virtual_hold_correct` (±8% band). Emits `⚠HOLD_TOO_PASSIVE` when miss rate >50% n≥10.
    - **Whipsaw check:** `GET /api/learning/recent-rec?ticker=X` (action-agnostic). `entrySignature()` in `js/utils.js`. Flags in `_ruleWarnings` when direction flips within 10d under ≥4/5 matching signature tokens.
    - **Lesson lifecycle scoring:** `_compute_lesson_effectiveness()` — WR before/after lesson creation. `GET /api/learning/lesson-effectiveness`. Rendered as chips on Learning page. Read-only; user prunes manually.
    - **Calibration trend:** `calibration_snapshots` table. `GET /api/learning/calibration-trend` (last 180d). Line chart on Learning page — Brier is lower-is-better so declining = green (inverted vs price charts).
    - **News feed swap:** `oilprice.com` added as `geopolitics` feed. Macro brief cap raised 8→12, window raised 1d→2d.

86. **Six more Learning Loop stats features:** `buy_vs_topup`, `capital_efficiency` (avg_pnl_per_day by driver), `ensemble_divergence`, `mae_mfe_summary` — all on `GET /api/learning/stats`, empty-safe. Cluster-loss nudge (`⚠CLUSTER_LOSS(N losses in 5d)`). Lesson-drag nudge (`⚠LESSON_DRAG`). Monthly digest reminder via `checkMonthlyDigestReminder()` in scheduler (≥15 new closed trades since last digest).

87. **Announcement PDF resolution uses Sydney date, not UTC.** `_sydney_now()` in `announcement_engine.py`. UTC can trail Sydney by ~10h — using UTC misses today's announcements during market hours.

88. **Paper/real firewall — `isRealTrade(x)` is the ONLY gate.** `x.mode === 'real'`. Missing/null/'paper' → paper. Failing safe: paper can never leak into tax records. Real-only surfaces: EOFY pack, CGT liability summary, NAV history, ATO-facing CSV exports. `adjustCashForMode(delta, mode)` routes to `state.cash` or `state.paperCash`. `askTradeMode()` modal blocks until user chooses — no default. `paperCash` seeded lazily from `settings.paperStartCash`. `splitParcel()` inherits parent mode. `rollbackTradeJournalEntry()` routes cash through mode. `_recomputeHoldingFromParcels()` rebuilds per mode separately. `trade_mode` in `_ALLOWED_OUTCOME_COLS` so mode is upgradeable at execution time. `portfolioViewMode` toggle on Portfolio page (default `'all'`) — **also drives the Performance page** (all trade/rec metrics filter by it via `_modeMatch`/`_recModeMatch`; portfolio helpers already follow it). NAV history + the Performance equity curve are always real-only regardless of toggle (hidden in Paper view, with a note). **Paper trading has NO funds/available-cash concept** — `viewCash()` returns real cash for `all`/`real` and `0` for `paper` (never sums `paperCash`); the Portfolio Cash card is hidden in Paper view; the Dashboard shows no paper cash. **Paper lodging is never gated on funds** — the day-trade cost>cash guards only fire for `isRealTrade(mode)`. `paperCash`/`adjustCashForMode` still track a paper pool internally but it is never surfaced. `GET /api/learning/stats` returns `real_vs_paper` (warns when WR gap ≥15pp n≥5 each side). **Mode filters:** Trade Journal (`journalFilter.mode`) and CGT Open Parcels (`_cgtFilter.parcel.mode`) both have an All/Live/Paper `Book` filter (`(x.mode||'paper')` match). CGT *disposal history* stays real-only (tax firewall) — only the parcels list is mode-filterable. **Value History** page has a Live/Paper toggle (`_historyMode` in `charts.js`): Live plots real `netWorth/portfolioValue/cash`; Paper plots `paperValue` (paper holdings mkt value, no cash) via `paperPortfolioValue()`. `recordPortfolioSnapshot()` captures `paperValue` per snapshot going forward — historical snapshots have it undefined (chart/table skip null points, `_plottable` gate).

89. **`SIGNAL_RULES` must not contain complementary pairs that always fire exactly one per stock** — they structurally lock the Market Breadth Gauge near "Balanced". `above_sma50`/`below_sma50` are both `type:'info'` (no vote). Discriminating signals: `momentum_rising` (buy, `return_20d > 8`) and `momentum_falling` (sell, `return_20d < -8`). RSI thresholds: <35/>65. BB thresholds: <0.20/>0.80. Display: 7 levels (Strongly Bullish → Balanced → Strongly Bearish). If adding new rules, check that its complement isn't also in the list.

90. **State saves are version-guarded (optimistic concurrency).** `blob_store._state_version` is a monotonic int bumped on every successful `POST /api/db/save`. `GET /api/db/load` returns `stateVersion`; the client tracks it in `_stateVersion` (`api.js`) and sends it as `baseVersion` on every save. If the stored version has advanced (another tab/device saved in between), the save is rejected **409** and the client reloads instead of clobbering (`_handleSaveConflict()`) — this prevents the stale-tab overwrite that wiped the 2026-07-03 morning macro + recs. `baseVersion` omitted → legacy client, guard skipped (backward compatible). `forceSave:true` → intentional override. The version bump is the LAST write in `db_save` so a rejected save never advances it. Lost AI outputs are always recoverable from `ai_call_log` (macro/portfolio responses) + `ai_learning_events` (logged recs) — neither is touched by state saves.

91. **Holding `mode` is a persisted `portfolio` column with `UNIQUE(ticker, account, mode)`.** Before this (FIXES.md #1/#2, 2026-07-03), `mode` was dropped on every `db_save` → the real book silently demoted to paper on reload (poisoned the NAV series), and a ticker held real+paper in one account raised an `IntegrityError` that 500'd the whole save (swallowed by `saveStateToDb`). All three of `db_save`, `db_load`, and `_validHolding()` (api.js) must carry `mode` (fail-safe `'paper'`). A ticker can legitimately be TWO portfolio rows (real + paper) — the wider UNIQUE allows it. `saveStateToDb()` now surfaces ≥2 consecutive non-409 save failures (silent persistent save failure is this app's worst failure mode). **Legacy backfill:** `POST /api/portfolio/backfill-modes` (dry-run first; Settings → Data maintenance) is a one-time tool to mark pre-firewall records real — it preserves the explicitly-paper CGT parcels + anything linked by id, bumps `_state_version`, and the client reloads so the migration isn't clobbered. `recordPortfolioSnapshot()` skips (+`console.warn`) a `$0` real PV while open real parcels exist (plausibility guard, FIXES.md #6).

---

## Deferred work

| Item | What it would unlock |
|---|---|
| Full ES-modules migration | Safe dependency order, dead-code elimination, single HTTP request |
| FastAPI migration | Native async, auto-generated OpenAPI docs |

---

## Logging

Console: human-readable. File: `ai_responses/server.log`, 2 MB × 5 rotation. Handlers >500 ms logged INFO, >2s WARN. Anthropic cache hits: `[agentType] cache read=X written=Y`.

---

## Quick smoke

```bash
python test_app.py
npm run test:js
python asx_server.py &
sleep 2
curl -s localhost:5000/health
kill %1
for f in js/*.js js/pages/*.js; do node --check "$f" || break; done
```
