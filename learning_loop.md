# Learning Loop — Architecture & Data Flow

**Last Updated:** May 2026
**Status:** Phases 1–5, 7 Complete · Phase 6 & 8 Planned

The Learning Loop closes the feedback cycle between Claude's recommendations and real-world outcomes. It systematically records every AI-generated trade recommendation, links it to execution and closure data, analyses performance, and feeds compact, statistically meaningful insights back into future Claude calls.

---

## Purpose

- Provide objective measurement of Claude's (and the overall system's) edge.
- Detect prompt decay, regime mismatches, and recurring failure patterns.
- Deliver high-signal, regime-aware, time-decayed calibration feedback without breaking prompt caching.
- Distinguish between bad analysis and good-discipline losses (capital protection).
- Support continuous improvement through structured post-mortem analysis and local-model debate.

---

## Data Storage

All learning data lives in `asx_trader.db` (SQLite, WAL mode).

### `ai_learning_events` table (primary)

| Column                | Type       | Description |
|-----------------------|------------|-------------|
| `id`                  | INTEGER PK | Auto-incremented event ID |
| `ticker`              | TEXT       | ASX ticker |
| `recommendation`      | TEXT       | BUY / SELL / TRIM / TOP_UP / HOLD |
| `ai_confidence`       | REAL       | Claude's stated confidence (0–1) |
| `ensemble_confidence` | REAL       | Quant engine confidence (0–1) |
| `outcome_status`      | TEXT       | win / loss / breakeven / open / skipped |
| `realized_pnl_pct`    | REAL       | Exit P&L as % of cost basis |
| `realized_pnl_aud`    | REAL       | Exit P&L in AUD |
| `regime`              | TEXT       | Market regime at time of rec |
| `prompt_version`      | TEXT       | System prompt version |
| `was_executed`        | INTEGER    | 0/1 |
| `suggested_stop`      | REAL       | Claude's stop-loss price |
| `suggested_target`    | REAL       | Claude's target price |
| `rr_ratio`            | REAL       | Reward:risk ratio |
| `holding_period_days` | INTEGER    | Days held |
| `exit_reason`         | TEXT       | `stop_hit` / `target_hit` / `manual` / `protective_stop` / `time_exit` |
| `rationale_summary`   | TEXT       | First 400 chars of Claude's reasoning |
| `actual_entry_price`  | REAL       | Actual fill price |
| `actual_exit_price`   | REAL       | Actual exit price |
| `sector`              | TEXT       | GICS sector |
| `error_type`          | TEXT       | Comma-separated tags (loss/breakeven only) |
| `error_type_source`   | TEXT       | `'manual'` or `'auto'` (Ollama postmortem) |
| `skill_score`         | REAL       | 0–10 analysis quality vs luck (Ollama scored) |
| `debate_summary`      | TEXT       | ≤200-char bull/bear summary stored at analysis time |
| `prompt_hash`         | TEXT       | 12-char djb2 fingerprint of prompt version + regime + date |

> **Note on `loss_quality`:** This is a *computed property*, not a stored column. It is derived at calibration time from existing fields:
> - `exit_reason = 'protective_stop'` → **good** loss (deliberate capital defence, excluded from calibration)
> - `error_type` contains `external_shock` → **good** loss (market accident, excluded from calibration)
> - `error_type` contains `overconfident` or `poor_entry` → **bad** loss (model error, full weight)
> - Otherwise → **neutral**
>
> Storing it separately would require a separate Ollama call and a new column that duplicates information already in `error_type` and `exit_reason`. Deriving it is simpler, more consistent, and zero-cost.

### Supporting Tables
- `rec_history` — Every Claude recommendation + `learning_id` link to `ai_learning_events`.
- `trade_journal` — All trades (AI + manual) with `close_date`.

---

## Event Lifecycle

1. **Recommendation Generated** (`analysis.js` → `logRecsToLearningLoop()`)
   - `POST /api/learning/log` — creates partial record, returns `id`
   - Stores `rec._learningId`, persists `debate_summary`, `prompt_hash`

2. **Trade Executed** (`recommendations.js` → `markExecuted()`)
   - `POST /api/learning/outcome` — updates entry price, outcome fields

3. **Trade Closed** (`performance.js` → `syncClosedTradesToLearningLoop()`)
   - Reconciles journal against `rec_history` and patches outcome for closed trades

4. **Manual Trades** — Supported via Branch B (full record creation on SELL/TRIM)

---

## Handling Market Non-Stationarity & Good Losses

**Core philosophy:** Markets change regimes. A loss from 6 months ago in a risk-off bear market should not carry the same weight as a loss from last week in the same conditions. And a disciplined stop-out that protected capital from a larger drawdown is *not* a model error — penalising it would train Claude to hold losers.

### How the system addresses this (implemented)

**1. Exponential time-decay weighting** ✅
All confidence-band, regime, sector, and decay calculations use decay-weighted win rates:
```python
weight = exp(-ln(2) × days_since_close / 45)
# Today = 1.0 · 45 days ago = 0.5 · 90 days ago = 0.25 · 6 months ago ≈ 0.1
```
Old data fades gracefully — it still contributes when sample sizes are small, but cannot dominate when fresh data exists. The default window is 90 days (extended from 60d) with a 180-day hard cap.

**2. Protective stop exclusion** ✅
Two types of "good loss" are excluded from confidence-band calibration:
- `exit_reason = 'protective_stop'` — user explicitly marks these in the Learning Loop UI (🛡? button appears on `stop_hit` losses)
- `error_type` contains `external_shock` — auto-tagged by Ollama postmortem

These trades still appear in the event list and affect regime/sector stats (they happened, after all), but they do **not** distort the model's confidence calibration. Their count is shown in the block prefix as `Nexcl` so Claude knows they were filtered.

**3. Regime freshness gate** ✅
If fewer than 3 trades exist in the current regime, the calibration block warns Claude rather than omitting data silently:
```
⚠only 1 trade in bullTrending regime—calibration limited
```
This prevents a freshly-transitioned regime from inheriting the previous regime's failure patterns.

**4. Date range in calibration block** ✅
Every calibration block now includes the date range and regime so Claude can contextualise the data:
```
CALIBRATION(12cls,2026-02→2026-05,bullTrending,2excl): conf 70-80%:61%WR(…)
```

**5. Regime-conditional filtering** ✅ (partial)
Calibration fetches the current regime from the request and compares same-regime historical trades. The `regime` column on each event stores the regime active at the time of the recommendation.

### Still to implement

**Skill-weighted calibration (Phase 8)**
Once enough `skill_score` values accumulate (target: ~20+ scored events), weight calibration by:
```python
weight = time_decay × max(0.2, skill_score / 10)
```
A luck win from 60 days ago: `0.5 × 0.2 = 0.10` effective weight.
A high-skill win from last week: `1.0 × 0.9 = 0.90` effective weight.

---

## Calibration Injection

`fetchCalibrationBlock(regime, sectors)` in `analysis.js` calls `GET /api/learning/calibration` after regime detection. The backend:
1. Fetches last 90 days of closed events (max 180d)
2. Applies exponential decay weighting (half-life 45d)
3. Excludes `external_shock` / `protective_stop` from confidence band calculations
4. Only emits findings where signal is statistically meaningful (n ≥ 3 + delta threshold)
5. Warns on thin same-regime data rather than silently omitting
6. Returns a block labelled with date range + regime for Claude context

Injected into **user message** via `__CALIBRATION_PLACEHOLDER__` — never the system prompt (preserves Anthropic's server-side prompt cache).
Target size: 30–60 tokens.

---

## Backend Endpoints

| Endpoint                           | Method | Description |
|------------------------------------|--------|-------------|
| `POST /api/learning/log`           | Write  | Create new event |
| `POST /api/learning/outcome`       | Write  | Update outcome, tags, exit_reason |
| `DELETE /api/learning/event/<id>`  | Write  | Hard delete |
| `GET /api/learning/stats`          | Read   | Aggregates for Learning Loop UI |
| `GET /api/learning/calibration`    | Read   | Decay-weighted, shock-excluded calibration block |
| `GET /api/debate/status`           | Read   | Ollama health check (60s TTL in JS) |
| `POST /api/debate`                 | Write  | Bull/Bear debate (sequential, 4h signal-hash cache) |
| `POST /api/debate/postmortem`      | Write  | Auto-tag error_type for loss/breakeven events |
| `POST /api/debate/staleness`       | Write  | Freshness check for pending recs ≥ 2 days old |
| `POST /api/debate/skill`           | Write  | Score closed trade outcome quality 0–10 |

---

## Learning Loop Display Page

**Key Sections:**
- Summary cards (overall win rate, high-confidence WR, prompt version)
- Calibration accuracy table (per confidence band, decay-weighted, n<5 warnings)
- Regime performance table
- Prompt version history
- Failure Patterns (exit reason distribution + error tag counts, shock excluded)
- Recent Events table (30 most recent) — features:
  - `outcomeChip` + 🛡 badge if `protective_stop`, 🛡? button if `stop_hit` loss
  - Error tag buttons (8 tags, multi-select, auto=dashed/manual=solid border)
  - 🤖 postmortem button (loss/breakeven, untagged only)
  - 🔬 skill score button (all closed events); badge when scored (green/amber/red)
  - ✕ delete button
- Debate Summaries (last 5 with stored debate_summary)
- Debate Engine card (model selector, aggression, Test Debate button)

### Error Tag Reference

| Tag | Short | When to use | Included in calibration? |
|-----|-------|-------------|--------------------------|
| `overconfident` | OC | AI confidence too high for actual risk | ✅ Yes |
| `missed_catalyst` | MC | Key event not accounted for | ✅ Yes |
| `regime_mismatch` | RM | Wrong strategy for regime | ✅ Yes |
| `poor_entry` | PE | Timing/price suboptimal | ✅ Yes |
| `stop_too_tight` | ST | Normal volatility triggered stop | ✅ Yes |
| `poor_rr` | PR | R:R ratio too low from start | ✅ Yes |
| `thesis_broken` | TB | New info invalidated thesis post-entry | ✅ Yes |
| `external_shock` | ES | Black swan / unpredictable market event | ❌ Excluded |

`protective_stop` exit_reason is also excluded — it classifies how the trade was exited (deliberate capital protection), not why the thesis failed.

---

## Internal Debate System (Ollama)

**Status:** Phases 1–5, 7 implemented.

### Implemented
- Bull/Bear pre-analysis injected into Claude user message (4h signal-hash cache)
- Post-mortem auto-tagging (`/api/debate/postmortem`) — losses/breakevens only
- Entry staleness check (`/api/debate/staleness`) — banner on recs ≥ 2 days old
- Skill score (`/api/debate/skill`) — 🔬 button on all closed events
- Debate Engine UI card (model selector, aggression=none/light/full, Test Debate)

### Future
- Phase 6: Calibration quality debate — local model interprets calibration band deltas ("Is this underperformance signal or noise?")
- Phase 8: Skill-weighted calibration (needs ~20+ scored events to validate weights)

### Ollama stability rules
- Bull and bear calls are **sequential** (not concurrent) to avoid VRAM spikes
- `keep_alive: "10m"` keeps model in VRAM between calls
- `num_predict: 200` caps output length
- No retry on timeout — fail immediately, caller switches to smaller model
- Batch concurrency always 1 — Ollama queues internally; external concurrency only wastes memory

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| User message for calibration + debate | Preserves Anthropic system-prompt cache |
| Exponential decay vs hard cutoff | Smooth fade; no artificial cliffs at day 60/90 |
| Derived `loss_quality` not stored | Avoids duplicate column; derived from existing `error_type` + `exit_reason` |
| `external_shock` excluded from calibration | Market accidents don't reflect model quality |
| Regime freshness gate (warn, don't omit) | Thin data is itself useful context for Claude |
| `risk_management_score` dropped | Redundant — `skill_score` + error tags already cover this |
| Lessons Database deferred | Needs proper design: what is a "lesson"? How injected? Until defined, premature to implement. |

---

## Implementation Notes

- **Tag button HTML fix (May 2026):** `JSON.stringify()` double-quotes broke `onclick` attribute parsing. Fixed with `.replace(/"/g, '&quot;')`.
- **Calibration default window extended** from 60d to 90d — more data for decay weighting to work with.
- **Protective stop UX:** 🛡? button only shows on `stop_hit` loss/breakeven rows. Clicking sets `exit_reason = 'protective_stop'` via `POST /api/learning/outcome`. Green 🛡 badge confirms exclusion.
- **Calibration block format:** `CALIBRATION(Ncls,YYYY-MM→YYYY-MM,regime,Nexcl): …` — `Nexcl` is omitted when zero.
- **Staleness banner:** renders with spinner immediately on page load for old recs; Ollama fills it async without page reload.
- **Skill score badge colours:** green ≥7 · amber 4–6.9 · red <4.

---

## Next Milestones

1. Accumulate ~20+ `skill_score` values, then implement skill-weighted calibration (Phase 8)
2. Phase 6: Calibration quality debate card (local model interprets band deltas)
3. Success tags for wins (`strong_confluence`, `catalyst_capture`, `regime_aligned`)
4. Structured Trade Checklist UI form (currently documented as reference only)
