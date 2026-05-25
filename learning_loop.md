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

---

## Internal Debate — Design Spec

### What it is

Internal debate is a technique where multiple model passes argue for and against a position before a final decision is made. The disagreement surface-mines assumptions, risks and edge cases that a single-pass model skips over. In a trading assistant the debate is structurally natural: every trade has a bull case and a bear case, and the final recommendation quality improves when Claude has already seen both stated explicitly.

Local models (Qwen3:9B, Gemma3:4B via Ollama) handle the debate cheaply and privately — no API cost, no data leaving the machine. They don't need Claude-level capability; they only need to generate plausible, specific counterarguments. Claude arbitrates.

### Architecture

```
┌───────────────────────────────────────────────────────────┐
│  Local machine                                            │
│                                                           │
│  Ollama  ←──────────────────────────────────────────┐    │
│   Qwen3:9B  or  Gemma3:4B                           │    │
│                                                     │    │
│  asx_server.py                                      │    │
│   ├─ _call_ollama()          shared HTTP client ────┘    │
│   ├─ POST /api/debate        bull/bear on a ticker        │
│   ├─ POST /api/debate/postmortem  auto-tagger            │
│   └─ GET  /api/debate/status      Ollama health check    │
│                                                           │
│  Browser (JS)                                            │
│   ├─ analysis.js — fetchBullBearDebate()                 │
│   │   inject debate block into Claude user message       │
│   ├─ recommendations.js — triggerPostMortem()            │
│   │   auto-tag error_type on trade close                 │
│   └─ pages/learning.js — show attribution in events     │
└───────────────────────────────────────────────────────────┘
               ↓  Claude API (Anthropic)
       Final recommendation with debate context
```

If Ollama is not running: `/api/debate` returns `{"available": false}` immediately and every caller falls back gracefully — analysis runs unchanged, manual tags remain available. Zero disruption to the existing flow.

---

### Use Case 1 — Bull/Bear Pre-Analysis

**Where in the pipeline:** After signal fetch, before assembling the Claude user message.

**What happens:**
For each top-N candidates (post `_dtPreFilter` or post regime detection in the main scanner), fire two local model calls in parallel:

- **Bull pass** (system: *"You are a bullish ASX swing trader. Be specific to the numbers."*): "Given these signals, write 2-3 specific reasons to BUY `{ticker}` in under 80 words."
- **Bear pass** (system: *"You are a bearish ASX risk analyst. Be specific to the numbers."*): "Given these signals, write 2-3 specific risks AGAINST buying `{ticker}` in under 80 words."

Both receive the same compact signal summary:
```
WBC: Price=$29.10, BB%B=0.08, RSI=31.2, ADX=18.4, VolZ=2.1, OBV=rising, 5D=−2.1%
```

**Output injected into Claude's user message** (after the calibration note, before the main portfolio data):
```
INTERNAL DEBATE (pre-analysis, local model):
[WBC] BULL: RSI turning from 31 with volume surge — classic mean-reversion setup; support at $28.40 held. OBV rising confirms accumulation. BEAR: Ex-dividend in 8 days will distort signal; NIM compression still unresolved; property exposure elevated in riskOff.
[CSL] BULL: … BEAR: …
```

**Why Claude benefits:** Claude now receives two structured opposing views before forming its own. If the bear case is strong and specific, Claude is more likely to lower confidence, tighten the stop suggestion, or skip the rec entirely — without needing to be explicitly prompted to consider risks.

**Token budget:** ~150 tokens per ticker. For 3 tickers: ~450 tokens added to Claude's context.

**Time budget:** 2 calls × ~3 seconds each, run in parallel per ticker → ~3-6 seconds total added to analysis time. Acceptable; run concurrently with news/announcement fetches.

**Scoping:** Only debate top-N candidates (3–5), not every portfolio ticker. Universe scan: debate the top 5 after pre-filter, skip the rest.

---

### Use Case 2 — Post-Mortem Auto-Tagger

**Where in the pipeline:** Immediately after a trade closes (`markExecuted()` or `syncClosedTradesToLearningLoop()`).

**What happens:**
Send closed trade data to the local model and ask it to classify the primary failure reason. Run twice at different temperatures to check agreement:

```
Prompt:
"This ASX trade closed as {loss/win} with P&L {pnl_pct:.1f}%.
Rec: {action} {ticker} at confidence {confidence:.0%} during {regime} regime.
Entry signals: BB%B={bb_pct_b:.2f}, RSI={rsi:.1f}, VolZ={vol_z:.1f}.
Exit: {exit_reason}.

Classify the PRIMARY failure reason from exactly one:
  overconfident    — stated confidence too high given signals and regime
  missed_catalyst  — earnings, news or corporate event not accounted for
  regime_mismatch  — strategy was wrong for prevailing market conditions
  poor_entry       — timing or price entry was off
  stop_too_tight   — stopped out by normal volatility before the move
  luck             — good analysis but random adverse movement
  none             — outcome was expected given the signals

Reply with ONLY the single classification word."
```

Run 1: temperature 0.2 (deterministic)
Run 2: temperature 0.5 (slightly varied)

**Decision logic:**
| Result | Action |
|--------|--------|
| Both agree on a valid tag | Auto-write `error_type` to `ai_learning_events`; show filled button in UI |
| Only one is valid | Store as a *suggestion*; show a faded `?` badge next to tag buttons |
| Neither is valid / both differ | Leave blank; user tags manually |

**Why this helps:** Manual tagging requires the user to remember context weeks or months after the trade. The local model has the numbers at close time and can classify immediately with decent accuracy on structured inputs.

---

### Use Case 3 — Outcome Attribution (Skill vs Luck)

**Where:** Same timing as post-mortem auto-tagger — runs in parallel on trade close.

**What happens:**
Ask the local model to rate 0–10 whether the outcome reflects **analysis quality** vs **random market movement**:

```
Prompt:
"ASX trade: {action} {ticker}, confidence {confidence:.0%}, regime {regime}.
BB%B at entry: {bb_pct_b:.2f}, RSI: {rsi:.1f}, ADX: {adx:.1f}.
Outcome: {outcome_status}, P&L: {pnl_pct:.1f}%, exit: {exit_reason}, held {hold_days}d.

On a scale 0–10, how much does the outcome reflect the QUALITY of the analysis
(vs random market luck)? 0=pure luck, 10=fully explained by the signals.
Reply with ONLY a number 0–10."
```

**Storage:** Store the score as `skill_score` in `ai_learning_events` (new column).

**Use in calibration weighting:**
```python
# In /api/learning/calibration
# Down-weight events where skill_score < 4 (likely luck)
weight = max(0.3, skill_score / 10) if skill_score is not None else 1.0
weighted_wins += weight * (1 if outcome == 'win' else 0)
weighted_total += weight
```

**Why this matters:** Currently all wins are equal in calibration. A win because CSL bounced on a global biotech rally (luck) is treated the same as a win because the BB reclaim + RSI + volume confluence played out exactly as predicted (skill). Skill-weighted calibration gives better signal.

---

### Use Case 4 — Calibration Quality Debate

**Where:** On-demand from the Learning Loop display page, or on each stats load when closed ≥ 10.

**What happens:**
Send the calibration stats to the local model and ask two interpretive questions:

```
Prompt 1 (signal vs noise):
"Calibration data: {band summaries with n, win_rate, delta}.
Is the observed underperformance in the 70-80% band (n=8, WR=61%, expected=75%) a
systematic signal or likely small-sample noise? Consider: sample size, consistency
across bands, regime conditions. Answer in 2 sentences."

Prompt 2 (decay interpretation):
"Recent 30d win rate: {rec_wr:.0%} vs all-time: {all_wr:.0%} (Δ{delta:+.0%}, n={n}).
Could this be explained by a regime shift (e.g. transition to riskOff) rather than
strategy decay? Give one sentence for each interpretation."
```

**Output:** Display the model's interpretations as a "Debate note" card beneath the calibration table on the Learning Loop page. Label it `⚡ Local model interpretation (Qwen3:9B)` so the user knows the source.

**Why this helps:** Raw numbers like "65% WR vs 75% expected" leave the user to interpret significance alone. The model adds: "With only 8 observations, this delta sits within the expected sampling variance — don't adjust yet" vs "This pattern is consistent across 3 consecutive months and 2 regime types — the overconfidence is likely real."

---

### Use Case 5 — Entry Staleness Check

**Where:** On-demand — fires when the user clicks **Execute** on a pending recommendation.

**What happens:**
The rec was generated at some point in the past (potentially days ago). Conditions change. Before the user commits capital:

1. Fetch fresh signals for the ticker (may already be in `state.liveSignals`)
2. Fire a single local model call: "This BUY rec was generated {days_ago}d ago at confidence {confidence:.0%}. Current signals: {fresh_summary}. Is the setup still valid, deteriorated, or invalidated? Reply: VALID / WEAKENED / INVALIDATED — then one sentence why."
3. If WEAKENED or INVALIDATED: show a warning banner on the Execute dialog
4. If VALID: show a small green checkmark

**Trigger condition:** Only run if rec is ≥ 2 days old. For same-day recs, skip (too new to be stale).

**Why this helps:** A BB-reclaim setup seen on Monday is meaningless if the stock has ripped 4% by Thursday and BB%B is now 0.65. The user is about to execute a stale signal. This check adds a cheap, fast sanity layer before capital is deployed.

---

### Prompt Design Rules for Small Models

Small models drift easily. Keep prompts tight:

| Rule | Rationale |
|---|---|
| One task per call | Combining bull+bear in one prompt produces compromised, hedged output |
| Hard output constraint | Set `num_predict: 150-200` in Ollama options; prevents rambling |
| Explicit format instruction | "Reply with ONLY the word" / "Format: BULL: … BEAR: …" |
| Compact signal summary | Fit all relevant signals in one line; models ignore long data dumps |
| Low temperature for classification (0.2–0.3) | Needed for reliable structured output |
| Higher temperature for debate (0.6–0.8) | Encourages diverse, non-obvious arguments |
| 1-shot example for classification | One example in the prompt doubles accuracy on small models |

---

### Model Selection

| Model | Command | VRAM | Speed | Best for |
|---|---|---|---|---|
| **Qwen3:9B** (recommended) | `ollama pull qwen3:9b` | ~6 GB | ~3–5 s/call | Post-mortem tagging, attribution, calibration debate — needs structured output |
| **Gemma3:4B** | `ollama pull gemma3:4b` | ~3 GB | ~1–2 s/call | Bull/bear debate, staleness check — needs fluent argument, not precise classification |
| **Qwen3:0.6B** (fallback) | `ollama pull qwen3:0.6b` | ~0.5 GB | <1 s/call | CPU-only machines; basic debate only |

Both sides of the bull/bear debate can use the **same model** with different system prompts and different random seeds — the perspective shift comes entirely from framing.

The Ollama model used is configurable via a `debate_model` key in `blob_store` (Settings page), defaulting to `"qwen3:9b"`.

---

### Where Debate Output Sits in Claude's Context

```
[System prompt — cached]
[User message — dynamic]
  ├─ Date + time
  ├─ Portfolio summary
  ├─ Live signals (indicators per ticker)
  ├─ __CALIBRATION_PLACEHOLDER__   ← 30-60 tokens from /api/learning/calibration
  ├─ INTERNAL DEBATE BLOCK         ← 150-500 tokens from /api/debate (new)
  └─ Task instruction
```

Debate goes **after** calibration and **before** the task instruction, so Claude processes:
1. How its past confidence has performed (calibration)
2. What the bull and bear cases are for each candidate (debate)
3. What the actual task is (analyse and recommend)

---

### What NOT to Use Local Debate For

| Tempting idea | Why to skip |
|---|---|
| Debate every ticker in universe scan (200+) | Too slow — 200 × 6s = 20 minutes. Only debate post-filter survivors (top 5). |
| Local model makes final trading decision | It can't. Small models hallucinate price levels and don't know ASX micro-structure. Claude arbitrates. |
| Macro / RBA / interest rate debate | Local models have unreliable economic reasoning. Use news/announcement engine for macro context. |
| Risk quantification (stop levels, position size) | Keep that in the deterministic quant engine. Non-negotiable. |
| Replacing manual error tags | Assist, not replace. Low-confidence auto-tags still need human confirmation. |

---

### Implementation Sequence

| Phase | What | Files |
|---|---|---|
| 1 | `_call_ollama()` helper + `/api/debate/status` health check + graceful fallback everywhere | `asx_server.py` |
| 2 | `/api/debate` endpoint (bull/bear type) | `asx_server.py` |
| 3 | `fetchBullBearDebate()` in JS + inject into Claude user message | `js/analysis.js` |
| 4 | `/api/debate/postmortem` endpoint + auto-tag on trade close | `asx_server.py`, `js/pages/recommendations.js` |
| 5 | `skill_score` column + attribution call on close + weighted calibration | `asx_server.py` |
| 6 | Calibration quality debate card on Learning Loop page | `js/pages/learning.js` |
| 7 | Entry staleness check on Execute dialog | `js/pages/recommendations.js` |

Phase 1–3 deliver the highest-value change (debate in Claude's context) with the least risk. Phases 4–7 can be added incrementally without breaking anything already built.
