# Sloth ASX Trader — Improvement Roadmap
**Last Updated:** May 2026

---

## IMPLEMENTATION PLAN (Active Sprint)

Items below are confirmed for implementation, ordered by execution sequence.
Large-effort items (walk-forward backtesting, mobile compact mode, local LLM fallback) are deferred.

---

### 1. Relative Strength vs ^AXJO ✅ PLANNED
**Files:** `indicators.py`, `scanner.js`
**What:** Fetch `^AXJI` (ASX 200 index) once per scan session. Compute
`rs_5d = ticker_return_5d / index_return_5d` and `rs_20d` equivalents.
Add `rs_score` (0–20 pts) to `_score_ticker` composite — replaces the
weakest sub-component. Surface `rs_5d` and `rs_20d` columns in the
scanner results table.
**Outcome:** Rankings stop rewarding absolute-return tickers that merely
followed the market. Only genuine out-performers score high.

---

### 2. Phase 2 — Learning Loop System ✅ PLANNED
**Files:** `asx_server.py` (DB + routes), new `js/pages/learning.js`, `prompts.js`
**What:**
- SQLite migration: `ai_learning_events` + `prompt_versions` tables (schema below).
- Backend routes: `POST /api/learning/log`, `GET /api/learning/stats`,
  `GET /api/learning/calibration` (returns compact block injected into every AI call).
- Frontend Learning Loop page: win-rate table by regime / confidence band /
  prompt version; open vs closed rec counts; calibration summary card.
- `prompts.js` injects calibration block into userMessage when available.
**Outcome:** Claude's next call knows its recent hit rate by confidence tier
and regime. Prompt decay is detected automatically. Audit trail persists
across sessions.

---

### 3. Performance Metrics (Sortino, Calmar, Streaks) ✅ PLANNED
**Files:** `js/performance.js`
**What:** Add to the existing performance page:
- **Sortino ratio** (downside deviation only, target return = 0)
- **Calmar ratio** (annualised return / max drawdown)
- **Longest winning streak** and **longest losing streak** from trade history
- **Avg hold days** for wins vs losses
**Outcome:** Richer risk-adjusted view beyond Sharpe. Streak stats expose
whether losses cluster (regime problem) or are random.

---

### 4. Prompt Versioning & Hardening ✅ PLANNED
**Files:** `js/prompts.js`
**What:**
- Add `PROMPT_VERSION: 2026-05-v3` constant at top, referenced in every
  userMessage so the Learning Loop can track it.
- Wrap hard rules block with `=== HARD RULES (non-negotiable) ===` delimiter.
- Append strict JSON schema example at the end of the system prompt so
  the model always has a concrete output reference.
**Outcome:** Version is captured in every `ai_learning_events` row.
Delimiters prevent mid-prompt context bleed on long analysis sessions.

---

### 5. Error Resilience in Data Layer ✅ PLANNED
**Files:** `indicators.py`, `asx_server.py`
**What:**
- Wrap all `yf.download()` / `yf.Ticker()` calls in try/except; return
  `{"ticker": t, "error": "yfinance timeout", "score": null}` instead of
  raising or silently returning empty data.
- Log failed tickers to a `failed_tickers` SQLite table with timestamp +
  error string so the UI can show "3 tickers failed to load" with details.
- Scanner skips failed tickers gracefully rather than aborting the whole scan.
**Outcome:** A single bad ticker no longer breaks a full scan. User sees
explicit warnings rather than missing rows.

---

### 6. Sector Map Robustness + Caching ✅ PLANNED
**Files:** `asx_server.py`, `indicators.py`
**What:**
- Expand `ASX_SECTOR_MAP` with ~50 additional common ASX200 tickers.
- Cache yfinance sector lookups to a `ticker_metadata` SQLite table
  (TTL: 7 days). Warm from cache before hitting yfinance.
- Fallback chain: hardcoded map → SQLite cache → yfinance live → "Unknown".
**Outcome:** Scanner no longer loses sector data on repeated runs or when
yfinance rate-limits. Cold-start time improves significantly.

---

### 7. Ensemble Confidence ✅ PLANNED
**Files:** `js/response-validator.js`, `js/pages/signals.js`
**What:**
- After AI response is validated, compute
  `ensemble = 0.5 * ai_confidence + 0.5 * (indicator_score / 100)`.
- Surface `ensembleConfidence` alongside `confidence` in the rec card.
- `response-validator.js` uses `ensembleConfidence` (not raw AI confidence)
  for the `minConfidence` threshold check.
**Outcome:** AI confidence alone is no longer the sole gate. A high-scoring
ticker with moderate AI confidence can still pass. A low-scoring ticker
with inflated AI confidence is filtered out.

---

### 8. Alert System (Desktop Notifications) ✅ PLANNED
**Files:** new `js/alerts.js`, `js/app.js`
**What:**
- Request `Notification` permission on first run (one-time prompt).
- Fire desktop notification when: (a) a scan finishes with score ≥ 75,
  (b) a high-conviction AI rec (confidence ≥ 0.80) is validated,
  (c) a held position hits its stop or target (based on live price refresh).
- Notification includes ticker, action, price, and score. Click opens app.
**Outcome:** User doesn't need to keep the tab in focus during market hours.

---

### 9. Export Trade Journal + ATO Tax Report ✅ PLANNED
**Files:** `js/performance.js`
**What:**
- "Export CSV" button generates ATO-compatible trade journal:
  columns = Date, Ticker, Action, Qty, Price, Brokerage, Cost Base,
  Proceeds, Gross P&L, CGT Discount Eligible (held > 12 months: Y/N).
- Separate "Tax Year Summary" row: total proceeds, total cost, net capital gain.
- Uses browser `Blob` + `URL.createObjectURL` — no backend needed.
**Outcome:** Drop the CSV straight into a tax spreadsheet or accountant portal.

---

## PHASE 2 — Learning Loop DB Schema

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

---

## DEFERRED (Large Effort — Not in This Sprint)

| Item | Reason deferred |
|---|---|
| Walk-forward backtesting | Needs vectorised OHLCV replay engine + parameter grid search — a mini-framework |
| Mobile compact mode | Requires full CSS breakpoint pass + reworking every card/table layout |
| Local LLM fallback | Needs Ollama API integration, separate prompt translation, response parser |
