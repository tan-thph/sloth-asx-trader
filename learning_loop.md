# Learning Loop — Architecture & Data Flow

**Last Updated:** May 2026  
**Status:** Advanced Implementation (Phases 1–4 Complete)

The Learning Loop closes the feedback cycle between Claude’s recommendations and real-world outcomes. It systematically records every AI-generated trade recommendation, links it to execution and closure data, analyzes performance, and feeds compact, statistically meaningful insights back into future Claude calls.

---

## Purpose

- Provide objective measurement of Claude’s (and the overall system’s) edge.
- Detect prompt decay, regime mismatches, and recurring failure patterns.
- Deliver high-signal calibration feedback without breaking prompt caching.
- Support continuous improvement through structured post-mortem analysis and debate.

---

## Data Storage

All learning data lives in `asx_trader.db` (SQLite, WAL mode).

### `ai_learning_events` table (primary)

| Column                | Type    | Description |
|-----------------------|---------|-----------|
| `id`                  | INTEGER PK | Auto-incremented event ID |
| `ticker`              | TEXT    | ASX ticker |
| `recommendation`      | TEXT    | BUY / SELL / TRIM / TOP_UP / HOLD |
| `ai_confidence`       | REAL    | Claude's stated confidence (0–1) |
| `ensemble_confidence` | REAL    | Quant engine confidence (0–1) |
| `outcome_status`      | TEXT    | win / loss / breakeven / open / skipped |
| `realized_pnl_pct`    | REAL    | Exit P&L as % of cost basis |
| `realized_pnl_aud`    | REAL    | Exit P&L in AUD |
| `regime`              | TEXT    | Market regime at time of rec |
| `prompt_version`      | TEXT    | System prompt version |
| `was_executed`        | INTEGER | 0/1 |
| `suggested_stop`      | REAL    | Claude's stop-loss price |
| `suggested_target`    | REAL    | Claude's target price |
| `rr_ratio`            | REAL    | Reward:risk ratio |
| `holding_period_days` | INTEGER | Days held |
| `exit_reason`         | TEXT    | stop_hit / target_hit / manual / time_exit / catalyst |
| `rationale_summary`   | TEXT    | First 400 chars of Claude’s reasoning |
| `actual_entry_price`  | REAL    | Actual fill price |
| `actual_exit_price`   | REAL    | Actual exit price |
| `sector`              | TEXT    | GICS sector |
| `error_type`          | TEXT    | Comma-separated tags (losses/breakevens only) |
| `error_type_source`   | TEXT    | `'manual'` or `'auto'` (Ollama) |
| `skill_score`         | REAL    | 0–10 (analysis quality vs luck) — Phase 5 |
| `debate_summary`      | TEXT    | ≤200-char bull/bear summary |
| `prompt_hash`         | TEXT    | 12-char fingerprint |

### Supporting Tables
- `rec_history` — Stores every Claude recommendation + `learning_id` link.
- `trade_journal` — All trades (AI + manual) with `close_date`.

---

## Event Lifecycle

1. **Recommendation Generated** (`analysis.js` → `logRecsToLearningLoop()`)
   - Calls `POST /api/learning/log`
   - Creates partial record and returns `id`
   - Stores `rec._learningId`

2. **Trade Executed** (`recommendations.js` → `markExecuted()`)
   - Updates existing event via `POST /api/learning/outcome`

3. **Trade Closed** (`performance.js` → `syncClosedTradesToLearningLoop()`)
   - Reconciliation between journal and learning events

4. **Manual Trades**
   - Supported via Branch B (full record creation) or reconciliation

---

## Calibration Injection

**Strategy**: Dynamic, context-aware, low-token.

- `fetchCalibrationBlock(regime, sectors)` calls `GET /api/learning/calibration`
- Backend filters last 60–90 days and only returns **statistically meaningful** findings (n ≥ 3 + notable delta).
- Injected into **user message** via `__CALIBRATION_PLACEHOLDER__` (preserves system prompt cache).
- Target size: 30–60 tokens.

---

## Analytics Functions (`learning-loop.js`)

- `refreshLearningCache()`
- `computeCalibrationStats()`
- `computeRegimePerformance()`
- `detectStrategyDecay()`
- `computeAllTradesStats()` (AI vs Manual)
- `computeRRRealization()`
- `fetchCalibrationBlock()`

---

## Backend Endpoints (`asx_server.py`)

| Endpoint                        | Method | Description |
|--------------------------------|--------|-----------|
| `POST /api/learning/log`       | Write  | Create new event |
| `POST /api/learning/outcome`   | Write  | Update outcome + tags |
| `DELETE /api/learning/event/<id>` | Write | Hard delete |
| `GET /api/learning/stats`      | Read   | Aggregates for UI |
| `GET /api/learning/calibration`| Read   | Smart calibration block |
| `GET /api/debate/status`       | Read   | Ollama health |
| `POST /api/debate`             | Write  | Bull/Bear debate |
| `POST /api/debate/postmortem`  | Write  | Auto error tagging (loss/breakeven only) |
| `POST /api/debate/staleness`   | Write  | Staleness check for pending recs ≥ 2 days old |
| `POST /api/debate/skill`       | Write  | Score closed trade outcome quality (0–10) |

---

## Learning Loop Display Page

**Key Sections:**
- Summary cards (overall win rate, high-confidence win rate, etc.)
- Calibration accuracy (per band with sample size warnings)
- Regime performance
- Prompt version history
- Failure patterns (error tags + exit reasons)
- Recent Events table (with tags, P&L, delete)
- Debate Summaries
- Debate Engine status card

**Error Tag Rules:**
- Tags only on **loss** and **breakeven** (`TAG_STATUSES`)
- Wins have no automated error evaluation — `skill_score` (Phase 5) will add outcome-quality scoring for all closed events including wins
- Multi-tag support (comma-separated)
- Auto-tagged entries have dashed border

---

## Trade Evaluation Checklist

> **Status: Planned UI** — this checklist documents the intended review framework. The Ollama post-mortem already evaluates items 4 and 5. A full structured form UI is a future phase.

This checklist defines what a complete trade review covers:

### 1. Trade Context
- Ticker, Action, Regime, Confidence, R:R, Holding Period, Outcome

### 2. Signal & Thesis Quality (at Entry)
- Technical confluence strength
- Catalyst / fundamental support
- Regime alignment
- Position sizing appropriateness

### 3. Outcome Quality
- **Skill Score** (0–10): Analysis quality vs luck
- Did price follow the expected thesis?
- Stop/Target behavior

### 4. Tags

**Error Tags (Loss/Breakeven only):**

Implemented (in UI buttons + server validation):
- `overconfident` — stated AI confidence was too high for actual risk
- `missed_catalyst` — key earnings/news/macro event not accounted for
- `regime_mismatch` — wrong strategy for the prevailing market regime
- `poor_entry` — timing or price was suboptimal
- `stop_too_tight` — normal volatility triggered stop before move played out

Planned additions (next iteration):
- `poor_rr` — reward:risk ratio was insufficient from the start
- `external_shock` — outcome driven by unpredictable external event (policy, black swan)
- `thesis_broken` — thesis was invalidated by new information after entry

**Success Tags (Wins only — recommended future):**
- `strong_confluence`
- `catalyst_capture`
- `regime_aligned`
- `excellent_execution`
- `high_conviction_payoff`

### 5. Root Cause & Lessons
- Primary reason for outcome
- Actionable lesson for future prompts

---

## Internal Debate System (Ollama)

**Status:** Phases 1–4 implemented.

**Core Value**: Local models provide structured bull/bear arguments and post-mortem tagging before Claude makes final decisions.

**Use Cases Implemented:**
- Bull/Bear pre-analysis (injected into Claude user message)
- Post-mortem auto-tagging (`/api/debate/postmortem`)
- Debate Engine UI card

**Implemented Phases (1–5, 7):**
- Bull/Bear pre-analysis (injected into Claude user message)
- Post-mortem auto-tagging (`/api/debate/postmortem`)
- 8 error tags: 5 original + `poor_rr`, `external_shock`, `thesis_broken`
- Skill score (`/api/debate/skill`) — 🔬 button on all closed events in Learning Loop
- Entry staleness check (`/api/debate/staleness`) — banner on pending recs ≥ 2 days old
- Debate Engine UI card (model selector, aggression, Test Debate button)

**Future Phases:**
- Calibration quality debate (Phase 6) — local model interprets calibration band deltas
- Skill-weighted calibration (Phase 8) — `/api/learning/calibration` weighs events by `skill_score`

**Design Highlights:**
- Graceful fallback when Ollama unavailable
- 4-hour debate cache based on signal hash
- Sequential calls + keep_alive for stability
- Configurable aggression level

---

## Key Design Decisions

- **User message** for calibration & debate (preserves prompt cache)
- **Statistical filtering** in calibration (only meaningful signals)
- **Error tags restricted to losses/breakevens** (clear semantics)
- **Local models** for debate and tagging (cost, privacy, speed)
- **learning_id foreign key** for unambiguous linking

---

## Implementation Notes

- **Signal Hash** for debate caching prevents unnecessary calls on minor price changes.
- **Postmortem Prompt** includes original rationale for better context.
- **Tag Button Fix** (May 2026): `JSON.stringify()` produces double-quoted strings; embedding in `onclick="..."` broke attribute parsing. Fixed with `.replace(/"/g, '&quot;')`.
- **Staleness banner** renders immediately with a "checking…" spinner; Ollama call fills in VALID/WEAKENED/INVALIDATED asynchronously without re-rendering the page.
- **Skill score** is 🔬-button triggered (not automatic) — avoids Ollama load on every page render. Badge turns green ≥7, amber ≥4, red <4.
- **Sequential staleness checks** — `initRecStalenessChecks()` processes old recs one at a time to avoid stacking concurrent Ollama calls.
- **3 new error tags** (`poor_rr`, `external_shock`, `thesis_broken`) added to server `VALID_TYPES`, postmortem prompt, calibration synergy map, and UI buttons.

---

**This Learning Loop turns Sloth ASX Trader from an AI-assisted tool into a true self-improving trading intelligence system.**

It combines persistent memory, structured feedback, hybrid local+cloud reasoning, and disciplined risk/learning processes.

---

**Next Milestones (Recommended)**
1. Complete Phase 5 (`skill_score` + weighted calibration)
2. Add success tags for wins
3. Implement Entry Staleness Check
4. Add full Trade Checklist UI form
