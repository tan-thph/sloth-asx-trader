# Learning Loop — Architecture & Data Flow

## Purpose

The Learning Loop closes the feedback cycle between Claude's recommendations and their real-world outcomes. Historical win rates, calibration deltas, and regime performance are fed back into each new Claude call as a compact calibration block, allowing the model to improve its recommendations over time without manual tuning.

---

## Data Storage

All learning data lives in `asx_trader.db` (SQLite, WAL mode).

### `ai_learning_events` table (primary)
| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incremented event ID |
| `ticker` | TEXT | ASX ticker |
| `recommendation` | TEXT | BUY / SELL / TRIM / TOP_UP |
| `ai_confidence` | REAL | Claude's stated confidence (0–1) |
| `ensemble_confidence` | REAL | Quant engine confidence (0–1) |
| `outcome_status` | TEXT | win / loss / open / skipped |
| `realized_pnl_pct` | REAL | Exit P&L as % of cost basis |
| `realized_pnl_aud` | REAL | Exit P&L in AUD |
| `regime` | TEXT | Market regime at time of rec |
| `prompt_version` | TEXT | System prompt version |
| `was_executed` | INTEGER | 0/1 — did the user trade it? |
| `suggested_stop` | REAL | Claude's stop-loss price |
| `suggested_target` | REAL | Claude's target price |
| `rr_ratio` | REAL | Reward:risk ratio |
| `holding_period_days` | INTEGER | Days held (open → close) |
| `exit_reason` | TEXT | stop_hit / target_hit / manual / … |
| `rationale_summary` | TEXT | First 400 chars of Claude's reasoning |
| `actual_entry_price` | REAL | Actual fill price |
| `actual_exit_price` | REAL | Actual exit price |
| `sector` | TEXT | GICS sector of the ticker |

### `rec_history` table
Stores every Claude recommendation. The `learning_id` column links each rec to its `ai_learning_events` row, persisted across restarts.

### `trade_journal` table
Stores all trades (AI-executed and manual). The `close_date` column records when a SELL/TRIM was executed, enabling hold-duration analytics.

---

## Event Lifecycle

### 1. Recommendation generated
`logRecsToLearningLoop()` in `analysis.js` fires after Claude returns results. For each rec it calls `POST /api/learning/log` with:
- `ticker`, `recommendation`, `ai_confidence`, `ensemble_confidence`
- `regime` (from `state._lastRegime`)
- `sector`, `rationale_summary` (400-char excerpt)
- `suggested_stop`, `suggested_target`, `rr_ratio`
- `prompt_version`

The backend inserts a row in `ai_learning_events` and returns the new `id`, which is stored as `rec._learningId` in JS state and persisted to `rec_history.learning_id` in the database.

### 2. Trade executed
`markExecuted()` in `recommendations.js` fires when the user clicks Execute on a pending rec.

- **Branch A** (prior event exists — `rec._learningId` is set): calls `PATCH /api/learning/outcome/{id}` to update `outcome_status`, `realized_pnl_*`, `actual_entry_price`, `actual_exit_price`, `holding_period_days`, `exit_reason`, `sector`.
- **Branch B** (no prior event — manually-entered stock): calls `POST /api/learning/log` with all outcome fields pre-filled (creates a complete event in one shot).

### 3. Trade closed via journal sync
`syncClosedTradesToLearningLoop()` in `performance.js` reconciles the trade journal against `rec_history` on each Performance page load. Any closed trade with a linked rec that hasn't updated its learning event gets an outcome PATCH call.

### 4. Manual trade imports
When a SELL/TRIM is added manually in the journal for a ticker that had a prior AI recommendation, the reconciliation in step 3 picks it up on the next Performance page load.

---

## Calibration Injection

### Old approach (removed)
`buildCalibrationPromptBlock()` generated a verbose multi-section text block (~150 tokens) from local `recHistory` and injected it into every Claude call regardless of whether there was enough data.

### New approach
`fetchCalibrationBlock(regime, sectors)` in `learning-loop.js` calls `GET /api/learning/calibration?regime=X&sectors=Y,Z` after regime detection in `analysis.js`. The backend:

1. Filters to the last 60 days (max 90)
2. Applies the current regime as a filter
3. Only emits findings where **n ≥ 3 AND the signal is statistically meaningful**:
   - Confidence bands: |hit rate − midpoint| > 5pp
   - Regime: current regime only, n ≥ 3
   - Sectors: n ≥ 3 AND notable performance
   - Strategy decay: recent win rate dropped > 15pp, n ≥ 5
   - R:R underperformance: high-R:R win rate < 55%, n ≥ 5
4. Returns `{ available: false }` when no meaningful signal
5. Target output: ~30–60 tokens

The calibration note goes into the **user message** (not the system prompt), so it doesn't break Anthropic's prompt cache on the system prompt.

The template pattern used:
```
userMessage = "... __CALIBRATION_PLACEHOLDER__ ..."
// After regime detected:
const calibrationNote = await fetchCalibrationBlock(regime, sectors);
const fullUserMessage = userMessage.replace('__CALIBRATION_PLACEHOLDER__', calibrationNote);
```

---

## Analytics Functions (`learning-loop.js`)

| Function | Source | Description |
|---|---|---|
| `refreshLearningCache()` | Backend `/api/learning/stats` | Populates `state._learningCache` for the Learning Loop display page |
| `computeCalibrationStats(recHistory)` | Cache → local fallback | Per-confidence-band hit rates vs expected |
| `computeRegimePerformance(recHistory)` | Cache → local fallback | Win rate and avg P&L per regime |
| `detectStrategyDecay(recHistory, days)` | Local only | Recent vs all-time win rate + return volatility |
| `computeAllTradesStats(journalHistory)` | Local tradeJournal | AI-recommended vs manual trade win rates |
| `computeRRRealization(recHistory)` | Cache → local fallback | Suggested R:R vs actual win rate on high-R:R trades |
| `fetchCalibrationBlock(regime, sectors)` | Backend `/api/learning/calibration` | Smart, compressed calibration string for Claude injection |

---

## Backend Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `POST /api/learning/log` | Write | Create a new `ai_learning_events` row |
| `PATCH /api/learning/outcome/{id}` | Write | Update outcome fields on an existing event |
| `GET /api/learning/stats` | Read | Full aggregate stats for the Learning Loop page |
| `GET /api/learning/calibration` | Read | Smart, context-aware calibration block for Claude injection |

---

## Learning Loop Display Page

The Learning Loop tab in the app renders:
- **Calibration accuracy** — per-confidence-band hit rates vs expected (e.g., 80–90% confidence band should hit ~85% of the time)
- **Regime performance** — win rate and avg P&L broken down by market regime
- **Strategy decay** — recent vs all-time win rate with volatility flag
- **R:R realization** — whether high-R:R setups are actually winning at the expected rate
- **Recent events** — last 20 events with outcome, P&L%, regime, hold days, exit reason
- **AI vs Manual** — side-by-side comparison of AI-recommended vs manually-entered trade performance

---

## Key Design Decisions

**Why user message, not system prompt, for calibration?**
Anthropic caches system prompts. Injecting dynamic per-call data (calibration) into the system prompt would invalidate the cache on every call. Placing it in the user message keeps the cache hit rate high.

**Why 30–60 token target for calibration?**
The full calibration stats (all bands, all regimes, decay, R:R) could easily be 200+ tokens. At 30–60 tokens we spend ~$0.003/call on calibration overhead vs $0.02+ for the verbose version. The backend only emits what's statistically meaningful, so noisy low-confidence signals don't inflate the context.

**Why link `rec_history` to `ai_learning_events` via `learning_id`?**
Without the link, the only way to match an outcome to a recommendation is by ticker + action + approximate date, which is ambiguous when the same ticker gets multiple recs close together. The integer foreign key makes the match exact and allows the backend to update the right event even months later.
