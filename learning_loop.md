# Learning Loop — Architecture & Data Flow

**Last Updated:** 2026-06-10 (doc sync: PROMPT_VERSION ref, phantom regime names in examples, exit_reason vocab note. Content current through Sprint 49 — virtual speed weight fix, 30d cutoff, n_virtual UI)
**Status:** Phases 1–8 Complete · Stages 1–4 + D1–D7 + L1–L6 + Sprint 23–46 improvements applied · Phase 8 Live (Mann-Whitney U gate, z>1.28, now in both stats and calibration block)

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
| `outcome_status`      | TEXT       | `win` / `loss` / `breakeven` / `open` / `skipped` / `expired`. Virtual values (`virtual_win`/`virtual_loss`/`virtual_open`) are stored in the separate `virtual_outcome` column — `outcome_status` stays `open` or `skipped` for unexecuted recs. |
| `realized_pnl_pct`    | REAL       | Exit P&L as % of cost basis |
| `realized_pnl_aud`    | REAL       | Exit P&L in AUD |
| `regime`              | TEXT       | Market regime at time of rec |
| `prompt_version`      | TEXT       | System prompt version |
| `was_executed`        | INTEGER    | 0/1 |
| `suggested_stop`      | REAL       | Claude's stop-loss price |
| `suggested_target`    | REAL       | Claude's target price |
| `rr_ratio`            | REAL       | Reward:risk ratio |
| `holding_period_days` | INTEGER    | Days held |
| `exit_reason`         | TEXT       | `stop_hit` / `target_hit` / `manual` / `protective_stop` / `time_exit`. ⚠ Vocabulary differs from the day-trade ML DB: `trade_snapshots.exit_reason` (in `day_trade_history.db`) uses `time_stop`, not `time_exit` — grep both when searching for time-based exits. |
| `rationale_summary`   | TEXT       | First 400 chars of Claude's reasoning |
| `actual_entry_price`  | REAL       | Actual fill price |
| `actual_exit_price`   | REAL       | Actual exit price |
| `sector`              | TEXT       | GICS sector |
| `error_type`          | TEXT       | Comma-separated tags (loss/breakeven only) |
| `error_type_source`   | TEXT       | `'manual'` / `'auto'` / `'debated-consensus'` / `'debated-merged'` / `'debated-singleton'` / `'debated'` / `'debated-synthesis'` (Phase 3 neutral synthesis) / `'adjudicated'` (cloud adjudicator) |
| `skill_score`              | REAL       | 0–10 analysis quality vs luck (Ollama scored) |
| `debate_summary`           | TEXT       | ≤200-char bull/bear summary stored at analysis time |
| `prompt_hash`              | TEXT       | 12-char djb2 fingerprint of prompt version + regime + date |
| `postmortem_debate`        | TEXT       | JSON blob of full adversarial debate transcript (Phase 3) |
| `entry_signals_json`       | TEXT       | JSON snapshot of live signals at rec generation time — used by postmortem and skill-score prompts (Stage 1 / D5 / D6) |
| `debate_synthesis_winner`  | TEXT       | Synthesizer verdict at analysis time: `'bull'`/`'bear'`/`'neutral'` for BUY recs, `'hold'`/`'exit'`/`'neutral'` for SELL/TRIM (Stage 4 / L6) |
| `tags`                     | TEXT       | Comma-separated user trade tags (sprint-3C) |
| `trade_thesis`             | TEXT       | Entry thesis captured at execution (sprint-3C) |
| `checklist_bypasses`       | TEXT       | Pre-trade checklist items bypassed at execution (Sprint 15) |
| `success_tags`             | TEXT       | Comma-sep win tags: `confluence_entry`, `trend_aligned`, `catalyst_driven`, `tight_stop_well_placed`, `momentum_entry` (Sprint 15) |
| `sell_primary_driver`      | TEXT       | One of 9 closed values declared by Claude at SELL/TRIM generation (Sprint 29) |
| `sell_secondary_factors`   | TEXT       | 0–3 comma-sep secondary tags (Sprint 29) |
| `sell_urgency`             | TEXT       | `immediate` / `routine` / `monitor` (TRIM only) (Sprint 29) |
| `virtual_outcome`          | TEXT       | `virtual_win` / `virtual_loss` / `virtual_open` — lazy-resolved by `_resolve_virtual_outcomes()` for `was_executed=0` recs ≥30d old (Sprint 36) |
| `virtual_pnl_pct`          | REAL       | Reserved for future use; NULL until entry price known (Sprint 36) |
| `virtual_speed_weight`     | REAL       | `min(1.0, 7.0 / bars_to_resolution)` — how many daily bars elapsed until target/stop was first hit. ≤7 bars → 1.0 (fast, high-conviction); 30 bars → ~0.23 (slow drift, weaker signal). Used as multiplier inside `_weight()`: effective virtual weight = `0.75 × virtual_speed_weight`. NULL until resolved. (Sprint 44; fixed Sprint 49: now uses bars-to-hit, not elapsed time) |
| `alternative_ticker`       | TEXT       | Set at SELL/TRIM generation when `primary_driver=better_opportunity`; used by `_resolve_sell_outcomes()` for cross-check (Sprint 37) |
| `sell_verify_date`         | TEXT       | Date when the 25d+ sell outcome verification ran (Sprint 37) |
| `sell_verify_verdict`      | TEXT       | `validated` / `invalidated` / `inconclusive` (Sprint 37) |
| `sell_verify_sold_chg`     | REAL       | % price change of sold ticker from sell date → verify date (Sprint 37) |
| `exec_mech_pnl_pct`        | REAL       | Execution-alpha tracker: simulated MECHANICAL exit P&L % (stop/target/15-bar time-stop, stop-first within a bar) for executed closed BUY/TOP_UP trades; lazily resolved by `_resolve_execution_alpha()` (≤5/call) (Sprint 63) |
| `exec_mech_exit`           | TEXT       | `stop` / `target` / `time` — which mechanical rule fired in the simulation (Sprint 63) |
| `sell_verify_alt_chg`      | REAL       | % price change of `alternative_ticker` from sell date → verify date (Sprint 37) |

> **Note on `loss_quality`:** This is a *computed property*, not a stored column. It is derived at calibration time from existing fields:
> - `exit_reason = 'protective_stop'` → **good** loss (deliberate capital defence, excluded from confidence calibration)
> - `error_type` contains `external_shock` → **good** loss (market accident, excluded from confidence calibration)
> - `error_type` contains `overconfident` or `poor_entry` → **bad** loss (model error, full weight)
> - Otherwise → **neutral**
>
> Storing it separately would require a separate Ollama call and a new column that duplicates information already in `error_type` and `exit_reason`. Deriving it is simpler, more consistent, and zero-cost.

### Supporting Tables
- `rec_history` — Every Claude recommendation + `learning_id` link to `ai_learning_events`.
- `trade_journal` — All trades (AI + manual) with `close_date`.
- `trading_lessons` — Scoped persistent trading lessons `(lesson_text, ticker?, sector?, regime?, source, breadth_scope?)` injected into Claude user messages (Sprint 39). `breadth_scope` TEXT column added Sprint 44: `adl_below_0.3`, `adl_above_0.7`, `high_vol`, `low_vol`, or null (always inject). CRUD via `GET/POST /api/learning/lessons` and `DELETE /api/learning/lesson/<id>`.
- `tag_reviews` — Manual spot-check verdicts for Ollama auto-tagged events `(event_id UNIQUE, verdict, corrected_tag, original_tag)`. Drives `agree_rate` gate on the `top_err` calibration nudge (Sprint 41).
- `ai_call_log` — Full prompt + response audit trail for every `callClaude()` call `(agent_type, model, system_prompt [8k cap], user_message [30k cap], response, tokens, duration_ms)`. Also written by `quick_analysis()` with `agent_type='portfolio:local'` for local LLM calls (Sprint 42). Browsable via `GET /api/log/ai_calls` and `GET /api/log/ai_call/<id>`; filter by agent type with `?agent_type=portfolio:local`.

---

## Event Lifecycle

1. **Recommendation Generated** (`analysis.js` → `logRecsToLearningLoop()`)
   - `POST /api/learning/log` — creates partial record, returns `id`
   - Stores `rec._learningId`, persists `debate_summary`, `prompt_hash`, `entry_signals_json` (signal snapshot), `debate_synthesis_winner`

2. **Trade Executed** (`recommendations.js` → `markExecuted()`)
   - `POST /api/learning/outcome` — updates entry price, outcome fields
   - `exit_reason` auto-detected via `_detectExitReason(exitPrice, stopLoss, target)` — sets `stop_hit`/`target_hit` (±0.5% tolerance) or falls back to `manual` (Stage 1); function now lives in `js/utils.js` (hoisted Sprint 43)
   - Auto-reconciles parent BUY/TOP_UP learning events when a SELL/TRIM fully closes the position (Stage 1)
   - **No longer auto-triggers postmortem/skill-score** — these must be initiated via the 🤖/🔬 buttons on the Learning page (hotfix a888eec)

3. **Trade Closed** (`performance.js` → `syncClosedTradesToLearningLoop()`)
   - Reconciles journal against `rec_history` and patches outcome for closed trades
   - `exit_reason` also auto-detected here via `_detectExitReason()` (Stage 1)
   - **After logging a new event, `_learningId` is written back to the original `state.recHistory` entry** (not just the spread copy) before `scheduleSave()` — prevents the same trade from being re-logged as a new event on every subsequent Sync. *(Fixed Sprint 29)*

4. **Manual Trades** — Supported via Branch B (full record creation on SELL/TRIM)

---

## Handling Market Non-Stationarity & Good Losses

**Core philosophy:** Markets change regimes. A loss from 6 months ago in a risk-off bear market should not carry the same weight as a loss from last week in the same conditions. And a disciplined stop-out that protected capital from a larger drawdown is *not* a model error — penalising it would train Claude to hold losers.

### How the system addresses this (implemented)

**1. Exponential time-decay weighting with adaptive half-life** ✅ *(Sprint 25)*
All confidence-band, regime, sector, and decay calculations use decay-weighted win rates:
```python
weight = exp(-ln(2) × days_since_close / half_life)
# half_life=45 (default): Today=1.0 · 45d=0.5 · 90d=0.25 · 6mo≈0.1
```
The half-life is **regime-adaptive** — volatile regimes force faster decay so stale data from a different market state doesn't dilute the calibration; calm regimes keep older samples to preserve statistical power:

| Regime | Half-life | Rationale |
|--------|-----------|-----------|
| `panic` | 20d | Fast-moving; yesterday's patterns may already be invalid |
| `riskOff` | 30d | Sustained bear bias; still moving fast |
| `highVol` | 35d | High intraday noise; quick regime transitions |
| `trend` | 45d | Directional but moderate recency bias |
| `riskOn` | 50d | Momentum regime; moderate recency bias |
| `sideways` | 60d | Low volatility; historical samples remain valid longer |
| (default) | 45d | Fallback when regime string is absent or unrecognised |

> **Note:** Only the six regime names produced by `classifyRegime()` are valid keys. Phantom names (`bearVolatile`, `bearTrending`, `bullTrending`, `neutral`) were previously documented but never existed in the code — they were removed in hotfix 16bba99. `_REGIME_GROUPS` for hierarchical fallback: bearish={riskOff, panic}, bullish={riskOn, trend}, neutral={highVol, sideways}.

The active half-life is logged in the calibration block header when non-default:
```
CALIBRATION(18cls,2026-02→2026-05,panic,hl=20d): conf 70-80%:52%WR(ESS=3.1)⚠adj -8pp
```

The default window is 90 days (extended from 60d) with a 180-day hard cap.

**2. Protective stop & external shock exclusion** ✅
Exclusion rules differ by calibration check — they are not a blanket filter:

| Where excluded | `protective_stop` | `external_shock` |
|---|---|---|
| Confidence-band calibration | ❌ Excluded | ❌ Excluded |
| Error pattern learning | ✅ If has error tags | ❌ Excluded |
| Regime / Sector / Decay / R:R | ✅ Included | ✅ Included |

Protective stops are excluded from confidence calibration regardless of tags, but contribute to error pattern learning if they carry analytical error tags (e.g. `regime_mismatch`, `poor_entry`).

- **Confidence bands**: both excluded — neither reflects model quality. One is deliberate capital protection, the other a market accident.
- **Error pattern learning**: `external_shock` excluded (nothing learnable from a black swan). `protective_stop` losses are included if tagged — a `regime_mismatch` tag on a protective stop is still a learnable signal that the trade was entered in the wrong conditions.
- **Regime/sector/strategy stats**: both included — they happened, Claude should see the full outcome picture. Excluding them would inflate the win rate and make Claude overconfident.

The count of confidence-band exclusions is shown in the block prefix as `Nexcl` so Claude knows they were filtered.

**3. Effective Sample Size (ESS) gating** ✅ *(Sprint 23)*
Raw trade count is a poor gate for stale samples. If 4 trades exist but 3 are 90 days old (weight ≈ 0.1 each) and 1 is fresh (weight = 1.0), the sample reads as 4 but is dominated entirely by the single recent trade.

All calibration sections now use Kish's ESS formula:
```
ESS = (Σwi)² / Σwi²
```
Threshold is **ESS ≥ 2.5**. Below this, the system emits a warning token rather than a confidence nudge:
```
conf 70-80%:⚠low ESS=1.6(n=4)—data too stale for reliable calibration
```
Equal-weight samples behave the same as before (4 trades, equal weights → ESS = 4.0). Stale samples are correctly gated regardless of raw count.

**3b. Hierarchical regime fallbacks** ✅ (L1, ESS-integrated, Sprint 24)
When the active regime has ESS < 2.5 (e.g. recently transitioned), rather than emitting nothing, the system falls through three levels:

1. **Specific regime** (e.g. `riskOn`) — ESS ≥ 2.5 → full decay-weighted win rate
2. **Macro group** (`bearish` / `bullish` / `neutral`) — if specific is thin, pool all regimes in the same macro family
3. **All trades** — if even the macro group is thin, fall back to overall with a low-specificity warning

This prevents a freshly-transitioned regime from getting no signal at all. Each fallback level emits a progressively weaker warning so Claude knows how specific the data is:
```
⚠riskOn(ESS=1.4)→bullish-group:68%W(ESS=3.2)⚠low-specificity
```
0 trades in a regime = silently omitted even at the all-trades level.

**4. Date range in calibration block** ✅
Every calibration block includes the date range and regime so Claude can contextualise the data:
```
CALIBRATION(12cls,2026-02→2026-05,riskOn,2excl): conf 70-80%:61%WR(…)
```

**5. Regime-conditional filtering** ✅ (partial)
Calibration fetches the current regime from the request and compares same-regime historical trades. The `regime` column on each event stores the regime active at the time of the recommendation.

**SQLite passive maintenance on startup** ✅ *(Sprint 25)*
`init_db()` in `db.py` runs two non-blocking pragmas on every server start:
- `PRAGMA optimize` — updates index statistics so the query planner stays accurate as `ai_learning_events` and `ai_call_log` accumulate large JSON blobs (debate transcripts, signal snapshots).
- `PRAGMA wal_checkpoint(PASSIVE)` — moves WAL pages back to the main DB file without blocking any concurrent reader or writer. Prevents WAL file growth under heavy write workloads (postmortem debates, call log writes, scan state updates).

Both are safe on any existing database and complete in milliseconds on a <100 MB DB.

---

### Calibration Design Notes

**Skill-weighted calibration (Phase 8)** ✅ *live (Sprint 31)*
The `_weight()` function in `_calib_compute()` applies skill weighting centered at 5 (neutral):
```python
sf = max(0.2, min(1.8, skill_score / 5.0))  # skill_score=5 → sf=1.0 (neutral)
weight = time_decay × sf
```
Centering at 5 means unscored events (`skill_score=NULL`) fall back to `sf=1.0` — identical to a neutral-scored trade. A high-skill trade (score=8) gets `sf=1.6`, amplifying its calibration signal; a low-skill trade (score=2) gets `sf=0.4`, down-weighting lucky wins. The old formula (`max(0.2, skill/10)`) centred at 10 and penalised all scored trades vs unscored, which was backwards. Phase 8 is fully live via `_compute_phase8_meta()` (Sprint 31): Mann-Whitney U gate (z>1.28, one-sided p<0.10) compares skill scores for wins vs losses — when the gate fails, `sf=1.0` for all events regardless of `skill_score`. Activates automatically once 10+ scored events exist where wins score statistically higher than losses.

> **Bug fix (hotfix 16bba99):** The Phase 8 gate now runs in **both** `_compute_phase8_meta()` (stats endpoint) and `_calib_compute()` (calibration block). Previously the calibration block used a raw mean comparison instead of the Mann-Whitney U z-score — this meant Phase 8 in the calibration block could activate on a single high-skill outlier, incorrectly amplifying or suppressing event weights. The fix aligns both code paths: `_phase8_active = _mann_whitney_z(win_skills, loss_skills) > 1.28`.

**Phase 6: Calibration quality debate card** ✅ *(Sprint 26)*
`GET /api/debate/calib-quality` — backend pre-calculates binomial SE + Z-scores per confidence band, builds a constrained prompt, calls the local Ollama model, returns per-band verdicts and qualitative analysis. Result cached in `blob_store` key `calib_quality_latest` with date; `force=1` bypasses cache.

*Statistical hallucination guard:* Small local models (4B–9B) invent causal narratives for deviations that are pure random variance. The backend pre-computes significance programmatically (`_norm_cdf(x) = 0.5 × erfc(-x/√2)`) and presents the verdict as an immutable fact. The model cannot override the pre-verdict — it only provides qualitative root-cause analysis:

```python
se = math.sqrt(p_exp * (1 - p_exp) / n)
z  = (actual_wr - p_exp) / se
p_noise = 2 * (1 - _norm_cdf(abs(z)))   # two-tailed
# verdict: "noise" if p_noise > 0.15, "signal" if p_noise < 0.05, else "uncertain"
```

Prompt instructs: *"Programmatic analysis shows p_noise=34% — do NOT identify a systemic cause. Focus only on whether the specific failure tags of the N losses share a common mechanism."*

**Note (hotfix a888eec):** `triggerCalibQualityIfStale()` is **no longer auto-called** from `runAnalysis()`. The calib-quality card on the Learning page loads with `cache_only=1` and shows a "▶ Run debate" button when no cached result exists. The `triggerCalibQualityIfStale()` function still exists in `debate-client.js` but must be called manually via the card button. Manual Refresh button forces a fresh run (`force=1`).

**Regime-flip calibration penalty** *(Sprint 44)*
When `fetchAndClassifyRegime()` detects a regime change, it writes `regime_flipped_at` (ISO timestamp) and `regime_flipped_to` (new regime name) to `localStorage`. `fetchCalibrationBlock()` passes these as query params. In `_calib_compute()`, if `flipped_to == regime` (current regime matches the flip destination) and the flip was within 30 days and fewer than 10 trades have accumulated in the new regime, the effective half-life is halved (`hl = max(10, hl // 2)`). The calibration block emits `⚠REGIME_FLIP(Nd ago, N trades, hl=Nd)` so Claude knows the data is thin. Once 10+ trades accumulate or 30 days pass, normal HL resumes automatically.

**Thesis drift detection** *(Sprint 45)*
`_compute_thesis_drift(conn)` compares average `realized_pnl_pct` for `exit_reason='manual'` vs `exit_reason='target_hit'` closed events (both `was_executed=1`). Requires n≥5 in each bucket. When manual avg P&L lags target-hit avg by >3pp, emits `⚠EARLY_EXIT_DRAG: manual_avg=X% vs target_avg=Y%→cutting winners early` as the lowest-priority token in the calibration block (first dropped by the token budget). Also exposed directly via `GET /api/learning/thesis-drift` for the Learning page `renderThesisDriftCard()`.

**Breadth-scope trading lessons** *(Sprint 44)*
`trading_lessons` table gained a `breadth_scope TEXT` column. Valid values: `adl_below_0.3` (inject when ADL < 0.3), `adl_above_0.7` (inject when ADL > 0.7), `high_vol` (inject when `asx_vol_20d > 25%`), `low_vol` (inject when `asx_vol_20d < 12%`), or `null` (always inject). `GET /api/learning/lessons` accepts `adl=<float>` and `asx_vol=<float>` query params; lessons are filtered so only contextually relevant scope-matched lessons reach Claude. `analysis.js` reads `state.macroData.advance_decline_ratio` and `state.macroData.asx_vol_20d` to supply these params.

**Auto-trigger removal** *(hotfix a888eec)*
`triggerPostmortem()` and `fetchSkillScore()` are no longer called automatically when `markExecuted()` closes a trade. `triggerCalibQualityIfStale()` is no longer called from `runAnalysis()` / `logRecsToLearningLoop()`. All three are now **manual-only**:
- 🤖 button on Learning page events → `triggerPostmortem()`
- 🔬 button on Learning page events → `fetchSkillScore()`
- "▶ Run debate" button on the calib-quality card → `triggerCalibQualityIfStale(force=true)`

The calib-quality card on the Learning page loads with `cache_only=1` — it shows the last cached result immediately without making an Ollama call. The "▶ Run debate" button appears when no cached result exists (or "Refresh" when one does). This prevents auto-trigger queue saturation and unintended Ollama calls during market hours.

**Confidence → position sizing (deferred)**
The quant engine already binds Claude's calibrated confidence to Kelly position sizing via `winProb: r.confidence`. When the calibration block instructs Claude to adjust confidence (e.g. -8pp nudge), that adjusted value flows directly into the Kelly fraction and thus the share count. Adding a second linear multiplier on top would double-discount. Deferred until empirical evidence shows Kelly alone is insufficient to transmit calibration feedback into execution sizes.

**Virtual outcomes / paper-trade skipped recs** ✅ *(Sprint 36 + Sprint 44)*
`_resolve_virtual_outcomes(conn)` runs lazily inside `_calib_compute()`. For `was_executed=0` recs ≥30 days old with non-null stop and target, it fetches OHLCV history and checks whether `high ≥ target` (virtual_win) or `low ≤ stop` (virtual_loss). Results written to `virtual_outcome` and fed back into calibration at 0.75× weight via `rows_all`. Prevents the pessimism loop where suppressed calibration produces no new outcomes. Frontend shows virtual outcome count in the calibration stats card.

**Sprint 44 addition — virtual speed weighting:** `_resolve_virtual_outcomes()` also writes `virtual_speed_weight = min(1.0, 7.0 / bars_to_resolution)` to the `ai_learning_events` row (`virtual_speed_weight REAL` column added via `_LE_MIGRATIONS`). `bars_to_resolution` is the 1-indexed bar number at which the target or stop was **first hit** during the daily OHLCV bar scan — NOT total elapsed time from creation to today. A virtual win resolved in 7 bars (target hit on day 7) gets weight=1.0; one where target is only hit on bar 30 gets ~0.23. Unresolved (virtual_open) uses the total bar count of the history fetch. In `_calib_compute()`, the effective weight for virtual rows is `0.75 × virtual_speed_weight` — fast hits are treated nearly as strongly as executed outcomes; slow drifts are further discounted. This prevents a slow-moving unexecuted rec from inflating calibration as much as a clean, fast win.

> **Sprint 49 fix:** The original implementation incorrectly computed `hold_days = (today − creation_date)`, making a rec from 40 days ago that hit target on bar 5 get `speed_weight = 7/40 = 0.175` instead of the intended `1.0`. The fix tracks `bars_to_resolution` during the bar scan loop and uses that value. Cutoff confirmed at 30 days (was briefly 10 days in the initial implementation; corrected to match the spec). `n_virtual_resolved` count now exposed via `GET /api/learning/stats` and shown as a cyan badge on the calibration card.

---

## Calibration Injection

`fetchCalibrationBlock(regime, sectors, tickers)` in `analysis.js` calls `GET /api/learning/calibration?regime=X&sectors=A,B&tickers=BHP.AX,CBA.AX` after regime detection. The backend:
1. Fetches last 90 days of closed events (max 180d) — pure `_calib_compute()` function, TTL-cached 5 min (L4)
2. Applies exponential + skill-weighted decay (`weight = time_decay × max(0.2, min(1.8, skill_score/5.0))`); half-life is **regime-adaptive** (20–60d, default 45d); unscored → sf=1.0
3. Excludes `external_shock` / `protective_stop` from confidence band calculations only
4. Only emits findings where **ESS ≥ 2.5** (Kish's formula) — replaces raw n≥3 guard (Sprint 23)
5. Low-ESS subsets emit a warning token rather than a calibration nudge (Sprint 23)
6. Warns on low-ESS same-regime data rather than silently omitting (L1 + Sprint 23)
7. Dominant error type threshold: 33% of losses, min 3 losses (L2, lowered from 40%/4)
7b. **Dominant success tag nudge** *(Sprint 27):* mirrors L2 for wins. If ≥33% of tagged wins share a success tag and ESS≥2.5, emits `✓tag_name(N/Mwins,ESS=X.X)→lean into this` so Claude can reinforce winning patterns, not just avoid losing ones. Threshold: ≥33% of tagged wins, min 3 wins. Supported tags: `confluence_entry`, `trend_aligned`, `catalyst_driven`, `tight_stop_well_placed`, `momentum_entry`.
8. Per-ticker stats: emits `per-ticker:BHP.AX:62%(Δ+14pp,ESS=3.2)✓strong` for portfolio tickers with >15pp delta vs overall WR (Stage 2 + Sprint 23)
8b. **Sector × regime interaction** *(Sprint 28):* when current regime is known and ≥10 calib rows exist, groups rows by `sector × regime`, computes weighted WR per group, emits up to 2 sectors with |delta| ≥ 12pp vs overall WR and ESS ≥ 2.5. Format: `sector×riskOn:Materials:78%(Δ+22pp,ESS=3.1)✓,REITs:31%(Δ-25pp)⚠`. Most actionable for ASX sector rotation.
9. Sell tag validation: emits `⚠SELL_TAG:time_stop(n=4,val=25%)→CUTTING WINNERS` or `✓SELL_TAG:target_rch(n=5,val=80%)→reliable` when a SELL driver is consistently unreliable/reliable (capped at 3 drivers, only verifiable drivers)
10. Returns a block labelled with date range + regime for Claude context
11. Auto-expire (events >120 days old → `expired`) runs on write path only, not on this GET (L3)

Injected into **user message** via `__CALIBRATION_PLACEHOLDER__` — never the system prompt (preserves Anthropic's server-side prompt cache).
Target size: 30–60 tokens.

Since `PROMPT_VERSION='2026-06-v10'` (Sprint 61, §8.3) the numeric adjustments are applied **engine-side**: the calibration response includes a machine-readable `adjustments: {bands, tickers}` payload, stashed by `fetchCalibrationBlock()` on `window._calibAdjustments` and applied deterministically in `analysis.js` before Kelly sizing (clamped [0.05, 0.98], audit-tagged `_calibApplied`). The text block remains in the user message as context only, and the system prompt explicitly forbids Claude from pre-adjusting confidence. Learning events log the **original** confidence so calibration never compounds on its own output. (The earlier LLM-applied algorithm `confidence += adj` ran from `2026-05-v5` to `2026-06-v9`.) The prompt also includes a debate-block usage rule: treat Local Debate as a second opinion, weight synthesis winner, don't anchor to it over fundamentals (Stage 3).

---

## Backend Endpoints

| Endpoint                                | Method | Description |
|-----------------------------------------|--------|-------------|
| `POST /api/learning/log`                | Write  | Create new event |
| `POST /api/learning/outcome`            | Write  | Update outcome, tags, exit_reason |
| `DELETE /api/learning/event/<id>`       | Write  | Hard delete |
| `GET /api/learning/stats`               | Read   | Aggregates for Learning Loop UI; includes `success_patterns`, `phase8_meta` (mann_whitney_z), `prompt_regression`, Wilson 95% CI on all win-rate fields |
| `GET /api/learning/calibration`         | Read   | Decay-weighted, shock-excluded calibration block (5-min TTL, thread-safe `_calib_lock`) |
| `GET /api/learning/calibration-stats`   | Read   | Brier score + reliability-diagram bins `{brier_score, n, bins:[{range,lo,hi,n,mean_confidence,actual_win_rate}]}` |
| `GET /api/learning/digest-data`         | Read   | Structured failure data for the postmortem digest `{recent_failures, regime_stats, overall_wins, error_dist, exit_dist}` |
| `GET /api/learning/sell-outcomes`       | Read   | Executed SELL/TRIM events with `sell_primary_driver` set and per-event `sell_verify_verdict` badges; `?force=1` triggers immediate re-resolve *(Sprint 37)* |
| `GET /api/learning/lessons`             | Read   | Scoped lessons matching `?ticker=X&sector=Y&regime=Z&adl=<float>&asx_vol=<float>` (cap 4); filtered by `breadth_scope` column; injected into Claude user messages *(Sprint 39, breadth-scope Sprint 44)* |
| `POST /api/learning/lessons`            | Write  | Create a lesson `{lesson_text, ticker?, sector?, regime?, source, breadth_scope?}` *(Sprint 39)* |
| `GET /api/learning/thesis-drift`        | Read   | `{n_manual, n_target, avg_manual_pct, avg_target_pct, nudge}` — requires n≥5 per bucket; backed by `_compute_thesis_drift(conn)` *(Sprint 45)* |
| `GET /api/learning/execution-alpha`     | Read   | `{n, pending, avg_actual_pct, avg_mech_pct, alpha_pp, n_beat, n_lag, mech_exits}` — actual realized P&L vs simulated mechanical exit for executed BUY/TOP_UP; resolves ≤5 pending events per call. Display-only (no calibration nudge — `⚠EARLY_EXIT_DRAG` already covers exit-timing feedback) *(Sprint 63)* |
| `DELETE /api/learning/lesson/<id>`      | Write  | Hard-delete one lesson *(Sprint 39)* |
| `GET /api/learning/untagged`            | Read   | Loss/breakeven events with no `error_type` — batch-classify queue *(Sprint 38)* |
| `GET /api/learning/tag-reviews`         | Read   | Up to 5 random unreviewed auto-tagged events for weekly spot-check *(Sprint 41)* |
| `POST /api/learning/tag-review`         | Write  | Submit `{event_id, verdict:'agree'\|'disagree', corrected_tag?}`; disagree updates `error_type` → manual and clears `_calib_cache` *(Sprint 41)* |
| `GET /api/learning/tag-accuracy`        | Read   | `{n, n_agree, agree_rate, label, pending_review}` — agree_rate gates top_err nudge *(Sprint 41)* |
| `GET /api/learning/debate-stats`        | Read   | Per-pairing adversarial-debate breakdown (consensus/partial/diverged + concede rate) |
| `GET /api/market/universe-health`       | Read   | Checks all ASX200 tickers via yfinance quoteType (20-worker pool, per-ticker 8s timeout); persists `universe_verified_at` to blob_store; returns `excluded` list *(Sprint 41; Sprint 46: excluded list)* |
| `POST /api/market/universe-exclude`     | Write  | Body: `{tickers:[...]}`. Adds to `blob_store.universe_excluded`; scanner and intraday routes filter excluded tickers *(Sprint 46)* |
| `DELETE /api/market/universe-exclude`   | Write  | Body: `{tickers:[...]}`. Removes from exclusion list *(Sprint 46)* |
| `GET /api/debate/status`                | Read   | Ollama health check (60s TTL in JS) |
| `POST /api/debate`                      | Write  | Bull/Bear debate (sequential, 4h signal-hash cache) |
| `POST /api/debate/postmortem`           | Write  | Auto-tag error_type for loss/breakeven events (single model) |
| `POST /api/debate/postmortem-debate`    | Write  | Adversarial two-model debate → CONSENSUS / PARTIAL / DIVERGED |
| `POST /api/debate/adjudicate`           | Write  | Cloud adjudicator (Gemini/Groq auto-pick) scores both local models + picks winner |
| `GET  /api/debate/adjudicator-status`   | Read   | Is a cloud adjudicator configured? Used by UI to enable/disable 🧑‍⚖️ button |
| `POST /api/debate/staleness`            | Write  | Freshness check for pending recs ≥ 2 days old |
| `POST /api/debate/skill`                | Write  | Score closed trade outcome quality 0–10 |
| `GET  /api/debate/calib-quality`        | Read   | Calibration quality debate: pre-computes Z-scores per band, calls Ollama for qualitative root-cause, returns per-band verdicts. Cached in `blob_store.calib_quality_latest`; `?force=1` bypasses cache *(Sprint 26)* |
| `POST /api/debate/quick-analysis`       | Write  | Local LLM portfolio analysis via Ollama (BUY/TOP_UP/HOLD/SELL/TRIM; 6000-char context limit; opt-in via `state.settings.useLocalLLM`). SELL/TRIM use simplified 5-driver taxonomy. *(Sprint 41; SELL/TRIM extended Sprint 48)* |

---

## Learning Loop Display Page

**Key Sections:**
- Summary cards (overall win rate, high-confidence WR, prompt version)
- Calibration accuracy table (per confidence band, decay-weighted, n<5 warnings)
- **Calibration Quality card** *(Sprint 26):* shows per-band verdict (🟢 noise / 🟡 uncertain / 🔴 signal) with statistical significance badges (Z-score, p_noise, ESS). Ollama's qualitative analysis shown per band. Card loads with `cache_only=1` — shows last cached result immediately. "▶ Run debate" button appears when no cached result exists; "Refresh" button forces `force=1` re-run. Manual-only since hotfix a888eec (auto-trigger from analysis removed)
- Regime performance table
- Prompt version history (with Δ vs prior version + regression detector banner)
- **Success Patterns card** *(Sprint 27):* two-column layout — left: tag chips with count + win rate bars (color-coded per tag type); right: calibration nudge explanation when a dominant tag was injected into the last calibration block. Tags: `confluence_entry`, `trend_aligned`, `catalyst_driven`, `tight_stop_well_placed`, `momentum_entry`
- Failure Patterns (exit reason distribution + error tag counts, shock excluded)
- **Sell Decision Tracker card** *(Sprint 37):* executed SELL/TRIM events with `sell_primary_driver` set; 🟢 validated / 🔴 invalidated / — inconclusive badges per event; "↺ Check Now" button triggers `?force=1` re-resolve
- **Execution Alpha card** *(Sprint 63):* actual exits vs simulated mechanical exits (stop/target/15-bar time-stop) — three tiles (actual avg, mechanical avg, alpha pp) + verdict banner; each page visit lazily resolves up to 5 pending events
- **Lessons card** *(Sprint 39):* list of scoped trading lessons with ticker/sector/regime scope badges; "Add Lesson" form; delete button per lesson
- **Auto-Tag Accuracy card** *(Sprint 41):* agree-rate badge (🟢 ≥75% / 🟡 60–75% / 🔴 <60%); "Review Batch (5)" button loads up to 5 unreviewed auto-tagged events with agree/disagree/retag UI; when <60%, emits `⚠AUTO_TAGS_UNRELIABLE` in calibration block and suppresses `top_err` nudge
- Recent Events table (30 most recent) — features:
  - `outcomeChip` + 🛡 badge if `protective_stop`, 🛡? button if `stop_hit` loss
  - **Error tags column** — 8 clickable tag chips (OC/MC/RM/PE/ST/PR/ES/TB), loss/breakeven rows only; auto-tagged rows show dashed border; manual solid border. When `error_type='none'` (Ollama reviewed, no systematic error found), shows a small `✓ no error` grey badge above the buttons so reviewed-clean rows are distinguishable from unreviewed ones.
  - **Claude column** — generation-time tags logged by Claude when the rec was created (not post-hoc Ollama classification):
    - SELL/TRIM rows: `sell_primary_driver` chip (colour-coded — red for `thes broken`, green for `target hit`, amber for `time stop`, etc.) + `sell_urgency` chip (`immediate` red / `monitor` amber / `routine` grey). Falls back to a generic grey pill for any unrecognised driver value.
    - WIN rows: `success_tags` chips (same colour scheme as the Success Patterns card).
    - All other rows: `—` placeholder.
  - **"Classify All Untagged" auto-refresh** — after the batch completes, the page reloads automatically (800 ms delay) so newly-assigned tags appear without a manual Refresh click.
  - 🤖 postmortem button (loss/breakeven, re-runnable — overwrites existing tag)
  - ⚔️ adversarial debate button (loss/breakeven, user-initiated only)
  - 📜 stored-debate viewer (only shown on rows where `postmortem_debate` is non-null — opens transcript modal with no model call)
  - ⚖️ cloud adjudicator (only shown on rows with stored debate; user-initiated; scores both local models 0-10 and picks a winner via Gemini/Groq)
  - 🔬 skill score button (all closed events, re-runnable); badge when scored (green/amber/red)
  - ✕ delete button
- Debate Summaries (last 5 with stored debate_summary)
- **Debate Stats card** (per-pairing breakdown of all stored adversarial debates — total, consensus, partial, diverged, singleton, agreement %, A→B concede rate)
- Debate Engine card (primary model, opposition model, aggression, Test Debate button)

### Error Tag Reference

| Tag | Short | When to use | Calibration? |
|-----|-------|-------------|--------------|
| `overconfident` | OC | AI confidence too high for actual risk | ✅ Yes |
| `missed_catalyst` | MC | Key event not accounted for | ✅ Yes |
| `regime_mismatch` | RM | Wrong strategy for regime | ✅ Yes |
| `poor_entry` | PE | Timing/price suboptimal | ✅ Yes |
| `stop_too_tight` | ST | Normal volatility triggered stop | ✅ Yes |
| `poor_rr` | PR | R:R ratio too low from start | ✅ Yes |
| `thesis_broken` | TB | New info invalidated thesis post-entry | ✅ Yes |
| `external_shock` | ES | Black swan / unpredictable market event | ❌ Excluded |

`protective_stop` exit_reason is excluded from confidence-band calibration — it classifies how the trade was exited (deliberate capital protection), not why the thesis failed. Protective stops are excluded from confidence calibration regardless of tags, but contribute to error pattern learning if they carry analytical error tags.

---

## Internal Debate System (Ollama)

**Status:** Phases 1–7 implemented. D1–D7 improvements + Sprint 23–27 applied May 2026.

### Implemented
- Bull/Bear pre-analysis injected into Claude user message (4h signal-hash cache, keyed on 10 signal fields including 5d/20d returns and ATR%)
- Direction-aware prompts (D7): BUY recs → bull/bear/neutral framing; SELL/TRIM recs → hold/exit/neutral framing
- Synthesizer round returns `{winner, margin, key_pivot}` — `winner` stored as `debate_synthesis_winner` in DB; included in `formatDebateBlock()` SYNTHESIS line (Stage 4 / L5 / L6)
- Extended signal set in debate prompt: `return_5d`, `return_20d`, `atr_pct`, `atr_14` added alongside existing RSI, BB%b, volume_z, OBV, ADX, SMA200 (D4)
- `entry_signals_json` injected into postmortem prompts (D5) and skill-score prompts (D6)
- Improved synthesizer JSON extraction: try full parse first, then reverse-scan for last valid `{...}` object (D2)
- Single-model post-mortem auto-tagging (`/api/debate/postmortem`) — losses/breakevens only; **manual via 🤖 button on Learning page** (Stage 2; auto-trigger removed hotfix a888eec)
- **Adversarial two-model postmortem debate** (`/api/debate/postmortem-debate`) — user-initiated via ⚔️ button
- Entry staleness check (`/api/debate/staleness`) — banner on recs ≥ 2 days old
- Skill score (`/api/debate/skill`) — 🔬 button on all closed events
- Debate Engine UI card (primary model, **opposition model**, aggression=none/light/full, Test Debate)

### Future

All phases implemented. No open future items for the debate system.

### Ollama stability rules
- Bull and bear calls are **sequential** (not concurrent) to avoid VRAM spikes
- `keep_alive: "10m"` keeps model in VRAM between calls
- `num_predict` is per-endpoint: **180** for synthesizer (D1, increased from 120), **200** for postmortem/staleness (short JSON), **350** for skill score (longer reason string)
- `think: false` passed to Ollama for all JSON-output endpoints — suppresses thinking tokens that would consume the token budget before any JSON is written
- **`format_schema` (Sprint 23):** All JSON-producing Ollama calls now pass a JSON Schema via Ollama's native `format` parameter. The inference engine constrains token selection at the grammar level — valid JSON is guaranteed without relying on regex fallback parsers. Schemas: `_SCHEMA_POSTMORTEM`, `_SCHEMA_WIN_TAG`, `_SCHEMA_SYNTHESIS`, `_SCHEMA_EXIT_SYNTHESIS`, `_SCHEMA_PM_SYNTHESIS`, `_SCHEMA_SKILL`. Cloud callers (Groq/Gemini/Claude) are not affected — they receive schema guidance via prompt text.
- No retry on timeout — fail immediately, caller switches to smaller model
- Batch concurrency always 1 — Ollama queues internally; external concurrency wastes VRAM
- **JS priority queue (Sprint 24):** `_oqEnqueue(fn, priority)` in `debate-client.js` enforces a HIGH/LOW semaphore on all Ollama backend calls. HIGH tasks (user-initiated: `fetchDebate`, manual postmortem button) insert before queued LOW tasks. LOW tasks (user-initiated from Learning page: `triggerPostmortem`, `fetchSkillScore`, `triggerCalibQualityIfStale`) are queued in arrival order. A running call is never interrupted — the priority only determines insertion point in the waiting queue. *(hotfix a888eec: these were previously auto-triggered; they are now manual-only)*
- **Calibration quality trigger (Sprint 26, manual-only since hotfix a888eec):** `triggerCalibQualityIfStale(regime)` in `debate-client.js` is no longer called automatically from `analysis.js`. It fires only when the user clicks "▶ Run debate" on the Learning page calib-quality card (`?force=1`). The card loads with `cache_only=1` on page render — shows the last cached result without an Ollama call. `GET /api/debate/calib-quality` accepts `?cache_only=1` to return cached result immediately.

### Model priority (Auto selection)
`preferredDebateModel()` selects from pulled models in this order:
```
qwen3.5:9b → qwen3.5:4b → qwen3:9b → qwen3:8b → qwen3:4b → qwen3:0.6b
→ gemma4 → gemma3:4b → gemma3:2b → llama3.2:3b → phi4-mini
```
Explicit user preference (saved in `state.debate.model`) overrides Auto if the model is still pulled. If the saved preference is no longer pulled, Auto silently falls back to the priority list — no error.

### Thinking model compatibility
Reasoning models (qwen3.5, qwen3, some gemma4 variants) emit `<think>…</think>` blocks before output. Two mitigations in order of priority:

1. **`think: false` API flag** (primary) — Ollama suppresses thinking tokens entirely before generation. The model outputs JSON directly. Passed on every JSON-output call. Ignored by non-thinking models.
2. **`_strip_think_tags()`** (safety net) — strips complete `<think>…</think>` blocks post-generation. Also detects unclosed `<think>` tags (model truncated mid-thought) and returns `""` so callers surface a clean error rather than attempting to parse incomplete output.

> **`/no_think` prompt suffix removed (D3):** Previously added as a text instruction at the end of every prompt. The API flag is the correct suppression mechanism — the text suffix is fragile (model may ignore it, or it may be truncated). Removed from all postmortem, staleness, skill, and challenge prompts.

If all three fail and `skill_raw` is still unparseable, the error response now includes the first 120 chars of raw output (`WARNING` logged) to assist diagnosis.

---

## Postmortem Classification — Prompt Design

### Trade summary fields sent to model
```
{recommendation} {ticker} {outcome_status}
| PnL={realized_pnl_pct}%
| hold={holding_period_days}d
| AI_conf={ai_confidence}
| RR={rr_ratio}
| entry={actual_entry_price}
| stop={suggested_stop}
| target={suggested_target}
| exit={exit_reason}
| regime={regime}
| sector={sector}
```

Plus (when available): `entry_signals_json` serialised via `_flatten_entry_signals()` (D5/D6, Sprint 23). This produces a compact flat string of the 12 most diagnostic fields:
```
[Signals] rsi=42.1 | macd_hist=-0.12 | bb%b=0.31 | vol_z=1.4σ | atr_pct=2.1% | ret5d=-1.8% | ret20d=+3.2% | adx=22.4 | score=61 | sma200=28.45 | px=31.20 | rr=2.10
```
Raw nested JSON blobs and `None`/NaN values are dropped. This reduces context window overhead and improves extraction accuracy for smaller local models (Qwen 4B, Gemma 2B). Contrast with the earlier approach of dumping all `key=value` pairs including raw arrays and metadata — which wasted ~200 tokens and confused small models.

`recommendation` (BUY/SELL/TRIM) is listed first so the model knows trade direction. Without it, the model assumes BUY for all trades and misinterprets entry prices for SELL/TRIM (e.g. calling a high entry "suboptimal" on a short where a higher entry is better).

### Exit context hints
Exit reason is translated to a factual description only — no tag suggestions:

| `exit_reason` | Hint sent to model |
|---|---|
| `stop_hit` | "The pre-set stop loss price was triggered." |
| `time_exit` | "The position was closed after the expected holding period without reaching stop or target." |
| `manual` | "The position was closed manually before reaching stop or target." |
| `protective_stop` | "The position was deliberately closed early to protect capital." |

**Why no tag suggestions?** Early versions included hints like "consider stop_too_tight or overconfident" for `stop_hit`. This caused the model to pattern-match on exit reason rather than analyse the trade, producing identical templated reasons for all manual closes, all stop_hits, etc.

---

## Adversarial Two-Model Postmortem Debate

**Endpoint:** `POST /api/debate/postmortem-debate`  
**Trigger:** ⚔️ button per row — **never automatic**. Normal 🤖 runs single-model only.  
**UI control:** Opposition model selector in Debate Engine card (`state.debate.oppositionModel`).

### Three-Phase Protocol

**Phase 1 — Independent classification**  
Model A and Model B each receive the same base prompt (same `_pm_build_prompt()` output) and classify independently. Neither sees the other's response. Runs sequentially to avoid VRAM spikes (two concurrent calls on a 16 GB machine can OOM).

**Phase 2 — Agreement check**

| Outcome | Condition | `error_type_source` | Next |
|---|---|---|---|
| SINGLETON_A | A parsed, B failed | `debated-singleton` | Done (use A) |
| SINGLETON_B | B parsed, A failed | `debated-singleton` | Done (use B) |
| CONSENSUS | Both parsed, sets identical (or both "none") | `debated-consensus` | Done |
| PARTIAL | Both parsed, non-empty intersection | `debated-merged` | Done (keep overlap) |
| DIVERGED | Both parsed, no overlap | — | Phase 3 |

If both models fail to produce parseable output, the endpoint returns an error rather than running Phase 3 on garbage.

For PARTIAL, only the *agreed* tags are kept. This is conservative — an agreed subset is higher-confidence than either model's full output.

The SINGLETON case prevents a wasteful Phase 3 debate when one model parses successfully and the other doesn't. Without this guard, the challenge round would ask the successful model to defend its real classification against an empty "none" reason from the failed model — meaningless and slow.

**Phase 3 — Neutral synthesis** *(only on full divergence)*  
Rather than asking one model to defend its position against the other (which biases toward whichever model is the "challenger"), Phase 3 runs a neutral reconciliation: both positions are presented to Model A as a third-party adjudication task.

Model A sees:
- Model A's Phase 1 tags + reason
- Model B's Phase 1 tags + reason
- The original trade summary (for reference)

The prompt asks: *produce the single best error classification by reconciling both assessments*. The model must choose which position is better-supported and explain why — it is **not** defending its own prior output.

Model A responds: `{"error_type": "TAG1,TAG2", "reason": "why this classification over the alternative, citing specific numbers"}`

`error_type_source` is `debated-synthesis` if the synthesis parsed successfully, `debated` otherwise (fallback to whichever Phase 1 result was non-empty).

> **Note:** An earlier design used a "Model A maintains or concedes" protocol with a digit-check heuristic. This was replaced with neutral synthesis because the challenger framing introduced a structural bias toward Model B's position regardless of analytical quality. The neutral synthesis gives equal weight to both positions and produces more consistent results.

### Post-classification sanity check (`_pm_sanity_check_tags`)
After all phases (and also after the single-model 🤖 path), tags are validated against the actual trade numbers and stripped if logically inconsistent:

| Tag | Stripped when |
|---|---|
| `stop_too_tight` | `\|entry − stop\| / entry > 15%` (a wide stop cannot be "tight") |
| `poor_rr`        | `rr_ratio >= 2.0` (the trade was set up with adequate reward) |

This catches model self-contradictions (e.g. a model calling a 43%-distance stop "too tight" while citing the 43% distance in its own reason). Direction-agnostic (absolute distance), so works for both BUY and SELL. Logged at INFO with the specific contradiction.

### Storage
Results are stored in:
- `error_type` — final resolved tags (post sanity-check)
- `error_type_source` — one of: `debated-consensus`, `debated-merged`, `debated-singleton`, `debated`
- `postmortem_debate` — full JSON transcript of all phases for later inspection

The transcript contains:
- `trade` — recommendation, entry/stop/target, P&L, R:R, regime, hold days, AI confidence — surfaced in the modal so users can spot direction misreads (e.g. SELL trade tagged as `poor_entry` by a model that assumed BUY)
- `phase_1` — both models' tags and reasons
- `phase_3` (optional) — `synthesis_model`, full raw response (600 chars), `final_tags`, `reason`
- `verdict`, `final_tags`

The modal is shown immediately after the debate completes and is re-openable later via the 📜 button on rows with stored transcripts.

### Model Selection
- **Primary model**: `state.debate.model` (or Auto via `preferredDebateModel()`)
- **Opposition model**: `state.debate.oppositionModel` (or auto-picks a different pulled model)
- If only one model is pulled, the ⚔️ button shows an error toast rather than starting a debate with itself

### Why user-initiated only
The divergence pattern between models is valuable but computationally expensive: up to 3 Ollama calls × model timeout. Running this automatically on every loss would block the UI for 3–5 minutes per event and keep Ollama occupied. The 🤖 button already provides fast single-model tagging; ⚔️ is for when you want a second opinion on a disputed or surprising classification.

---

## Cloud Adjudicator (Phase 4)

**Endpoint:** `POST /api/debate/adjudicate`  
**Trigger:** ⚖️ button per row — **never automatic**. Only visible on rows with stored `postmortem_debate`.  
**Provider:** User-selectable (Sprint 22). Auto-detect order: Gemini → Groq → Claude. Keys: Gemini/Groq read from `blob_store.news_settings` (same as News Scanner); Claude API key read from `settings.claude_api_key`. The ⚖️ button shows a provider picker when multiple keys are configured; fires immediately if only one is available.  
**Status check:** `GET /api/debate/adjudicator-status` returns `{available, provider, model, providers:[...]}` — `providers` lists all three with availability flags for the picker UI.

### Purpose
The local debate (Phase 1–3) can deadlock with a stubborn incumbent or both models missing the actual issue (e.g. both flagging `poor_entry` when the real problem was `overconfident` position sizing). The adjudicator brings in a larger, capable cloud model to:

1. **Score each local model's reasoning 0-10** on four criteria:
   - Did it cite specific numbers (R:R, stop distance, P&L)?
   - Is the reasoning internally consistent?
   - Are the tags well-supported by the trade data?
   - Did it interpret trade direction (BUY/SELL/TRIM) correctly?
2. **Pick a winner** (A, B, or NEITHER) and final tags.

`NEITHER` means both models missed the real issue — the adjudicator proposes its own tags.

### Blind adjudication *(Sprint 24)*
Before building the adjudicator prompt, the server randomly assigns aliases:
```python
if random.random() < 0.5:
    alias_a, alias_b = "Analyst Alpha", "Analyst Beta"
    # identity map — no swap
else:
    alias_a, alias_b = "Analyst Beta", "Analyst Alpha"
    # swapped — winner must be un-swapped after parsing
```
The cloud model receives "Analyst Alpha" and "Analyst Beta" instead of model names. This prevents halo-effect bias — Gemini Flash has been observed preferring `qwen3.5:9b` over `gemma3:4b` by name alone, independent of reasoning quality. The swap is resolved after parsing: the winner alias is translated back to canonical "A"/"B" using the stored `blind_map`.

Score fields in the JSON response are named `score_alpha`/`score_beta` (matching the alias names), then swapped back to `score_a`/`score_b` (canonical model order) before storage.

### Storage
- `error_type` is overwritten with the adjudicator's `final_tags` (unless empty/invalid)
- `error_type_source` becomes `'adjudicated'`
- `postmortem_debate.phase_4` is appended:
  ```json
  {
    "provider":   "gemini",
    "model":      "gemini-2.0-flash",
    "winner":     "A" | "B" | "NEITHER",
    "score_a":    7.5,
    "score_b":    4.0,
    "final_tags": "stop_too_tight,poor_rr",
    "reason":     "Analyst Alpha engaged with the R:R numbers; Beta was generic.",
    "elapsed_ms": 2840,
    "blind_swap": true,
    "alias_a":    "Analyst Beta",
    "alias_b":    "Analyst Alpha"
  }
  ```
`blind_swap`, `alias_a`, and `alias_b` are stored for auditability — they let you verify the winner translation is correct and track any systematic alias bias over time.

### Output validation
The adjudicator's `final_tags` go through the same `_pm_validate_tags` + `_pm_sanity_check_tags` pipeline as the local models — even a cloud model can't claim `stop_too_tight` on a 43%-wide stop.

### Why cloud and not stronger local
A 70B+ local model would need 40 GB+ VRAM and run for minutes per call. Cloud providers like Gemini Flash and Groq Llama-3.3-70B answer in 1-3 seconds per call for a few thousandths of a cent. The adjudicator is the right place to spend cloud cost — it runs on demand, on already-disputed cases.

### Classification instructions
The model is explicitly told:
- Classify the **primary reason** the trade failed
- Do **not** base the tag solely on the exit method
- Reason from P&L, holding period, confidence, R:R, entry/stop/target prices
- Cite specific numbers in the reason string
- `none` is only valid if the loss was genuinely unforeseeable with available data

### Logging
```
DEBUG  [PostMortem] raw output for event#N: <first 200 chars of model output>
INFO   [PostMortem] event#N (TICKER) → <tag> via <model> | <reason[:60]>
INFO   [PostMortem] event#N (TICKER) → none (model found no systematic error) via <model>
INFO   [PostMortem] event#N (TICKER) → INVALID tag '<tag>' via <model> — rejected. Raw: ...
INFO   [PostMortem] event#N (TICKER) → parse failure via <model> | raw: ...
```
`none` (deliberate model decision) and parse failure are now logged separately — previously both appeared as "no clear error".

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| User message for calibration + debate | Preserves Anthropic system-prompt cache |
| Exponential decay vs hard cutoff | Smooth fade; no artificial cliffs at day 60/90 |
| Derived `loss_quality` not stored | Avoids duplicate column; derived from `error_type` + `exit_reason` |
| `external_shock` excluded from confidence calibration only | Market accidents don't reflect model quality, but they happened and should show in regime stats |
| `protective_stop` excluded from confidence calibration, included in error synergy if tagged | Capital protection is not a model error; but if the trade also had a learnable tag (e.g. `regime_mismatch`), that signal should count |
| Regime freshness gate (warn, don't omit) | Thin data is itself useful context for Claude |
| Factual exit hints, no tag suggestions | Prescriptive hints cause pattern-matching on exit method, not trade analysis |
| `recommendation` first in postmortem summary | Model assumes BUY direction without it; SELL/TRIM entry analysis is inverted |
| `think: false` API flag, not just text stripping | Text stripping requires a closing `</think>` tag; truncated output has none. API-level suppression prevents thinking tokens from consuming the token budget entirely |
| `/no_think` text suffix removed | API flag is the correct suppression path; text suffix is fragile and can be overridden or ignored. Removed from all prompts (D3) |
| `num_predict=180` for synthesizer (vs 120) | Short synthesizer JSON ran into token limit at 120 when `key_pivot` was verbose; 180 prevents truncation (D1) |
| `num_predict=350` for skill (vs 200 for others) | Skill reason strings run 30–50 tokens longer than postmortem/staleness JSON; 200 caused truncation |
| Direction-aware debate prompts (D7) | SELL/TRIM recs ask "hold vs exit" not "bull vs bear" — framing matters; wrong framing produces off-target synthesis |
| `entry_signals_json` in postmortem/skill prompts (D5/D6) | Model can reason from actual signal values rather than inferring conditions from price/stop/target alone |
| Calibration TTL cache 5 min (L4) | Calibration query is CPU-heavy (Python loops over 300 rows); caching avoids re-computation on every Claude call |
| Postmortem is manual-only (hotfix a888eec) | Auto-triggering on close caused queue saturation and unintended Ollama calls during market hours. Manual 🤖 button on the Learning page gives explicit control; the endpoint (`/api/debate/postmortem`) is unchanged |
| Auto-detect exit reason (Stage 1) | Eliminates `exit_reason='manual'` blanket; stop_hit/target_hit now correctly detected ±0.5% so calibration has accurate exit stats |
| Adversarial debate: user-initiated only | 3 sequential Ollama calls × up to 120s each; auto-running on every loss would block UI for minutes. 🤖 fast-path handles the common case; ⚔️ is for disputes |
| PARTIAL verdict: keep intersection only | Higher confidence than either model's full output. A tag both agreed on is stronger signal than either individual response |
| Phase 3 neutral synthesis replaces challenger model | Earlier design: Model A defends vs Model B (challenger bias toward B regardless of quality). Current: both positions presented as equal inputs to a neutral reconciliation pass. More balanced and produces more consistent results |
| Sanity check after final tags determined | Catches model self-contradictions like `stop_too_tight` on a 43%-distance stop. Cheaper and more reliable than asking the model to verify its own output |
| ESS instead of raw trade count for calibration gates | Raw count misrepresents statistical power when most weights are near zero. Kish ESS = (Σwi)²/Σwi² correctly reflects a sample dominated by one fresh trade vs N equally-weighted trades. Threshold 2.5 — below this a warning token replaces a calibration nudge |
| `format_schema` for Ollama JSON calls | Engine-level constraint eliminates the regex fallback parser chain. When the schema is provided, Ollama guarantees the output is valid JSON matching the schema — `_strip_think_tags`, reverse-scanning, and field regexes are still present as defensive safety nets but will rarely trigger |
| `_flatten_entry_signals()` for prompt injection | Raw `entry_signals_json` contains ~40+ fields including NaN values, arrays, and metadata. Injecting it verbatim wastes ~200 tokens and confuses smaller models. Flattening to 12 key fields in a single line reduces overhead and improves signal extraction accuracy |
| SQLite `timeout=30` (up from 10) | Concurrent postmortem + debate + price-refresh writes can all arrive within seconds during market close. 30s gives queued writers enough time to succeed without aborting |
| Trade context block at top of debate modal | Surfaces recommendation (BUY/SELL/TRIM) and prices upfront so users can spot direction misreads. The model can still hallucinate direction in its reason, but the user sees the actual numbers |
| Phase 3 raw response shown via collapsible `<details>` | Lets users see exactly what the challenger wrote without dominating the modal. Critical for diagnosing whether the model engaged with B's points or just rubber-stamped |
| Adjudicator is user-initiated, not auto | Costs real money per call. Worth spending on disputed cases (the user explicitly clicks ⚖️) but wasteful as a default on every postmortem |
| Adjudicator output validated by same `_pm_sanity_check_tags` | Even a 70B+ cloud model can produce contradictory tags. Same validation pipeline = same guarantees |
| Provider auto-pick (Gemini > Groq) | Gemini Flash has a generous free tier and you're already using it for ASX announcements — zero extra cost in common case. Groq is the fallback because it's also free up to per-day limits |
| Blind adjudication (aliases not model names) | Cloud models exhibit halo-effect bias — they prefer certain model families by name regardless of reasoning quality. Random alias assignment removes this bias. `blind_swap` stored in phase_4 for audit |
| Skill weight centered at 5, not 10 | Old formula `max(0.2, skill/10)` set neutral at 10 — a skill=8 trade (0.8×) was penalised vs unscored (1.0×). Centering at 5 makes unscored and average-skill identical (sf=1.0); high-skill amplified (sf up to 1.8); low-skill down-weighted (sf down to 0.2) |
| Hierarchical regime fallbacks (specific → macro → all) | When a newly-transitioned regime has ESS < 2.5, falling back to a macro group (bearish/bullish/neutral) gives Claude useful signal instead of nothing. Each level is labelled so Claude knows the specificity |
| JS priority queue: HIGH/LOW semaphore | Multiple LOW-priority background calls (e.g. manual postmortems in batch) can queue up. Without a priority gate, a burst would block the user's next HIGH-priority manual debate. Auto-trigger removal (hotfix a888eec) further reduces queue saturation |
| Volatility-adaptive half-life (panic=20d, calm=60d) | Fixed 45d assumes constant regime-shift speed. Volatile regimes invalidate historical patterns faster; calm regimes benefit from larger statistical samples. Non-default hl logged in calibration block header |
| SQLite `PRAGMA optimize` + `wal_checkpoint(PASSIVE)` on startup | Accumulating JSON blobs (debate transcripts, call logs) degrade query planner statistics and grow the WAL file. Both pragmas are non-blocking and complete in ms — zero runtime cost |
| Phase 6 pre-calculates Z-scores before LLM prompt | Small local models invent causal narratives for deviations that are pure noise. Pre-computing binomial SE and presenting the significance verdict as a fact constrains the model to qualitative analysis of actual failure tags |
| Confidence → Kelly binding (not a second multiplier) | `winProb: r.confidence` already feeds calibrated confidence into Kelly sizing. A second linear multiplier would double-discount and over-suppress trades. Kelly alone transmits calibration feedback mechanically |
| Combined skill + success-tag call (Sprint 28) | Running two sequential Ollama calls for wins (skill score + tag-win) doubles the LOW-priority queue depth. The model sees the same trade context for both tasks; combining into one call with `success_tags` as optional JSON field is equivalent quality at half the cost |
| Regime-specific decay interpretation (Sprint 28) | Global decay could be driven entirely by poor performance in non-current regimes. If the current regime is stable (|delta|<8pp vs all-time), Claude should not apply a blanket 30% size reduction — that would penalise a strategy that's actually working in the present conditions |
| SELL/TRIM tags provided by Claude at generation time (Sprint 29) | Post-hoc LLM tagging creates self-justification bias: the model reads its own closed trade and rationalises it. Tagging at generation time (before the outcome is known) forces honest causal attribution. Ollama remains the postmortem agent for closed trades — it reads outcomes without prior knowledge of the original rationale |
| Closed tag vocabularies for SELL/TRIM (Sprint 29) | Open-ended strings would produce inconsistent tags (e.g. "target reached" vs "price hit target" vs "hit my target"). Closed sets allow reliable GROUP BY queries on `sell_primary_driver` to answer: *which exit reasons actually predict good exits?* |
| `better_opportunity` requires `alternativeTicker` (Sprint 29) | An opportunity claim that names no alternative is unverifiable and untrackable. Requiring the ticker lets the learning loop later cross-check whether the "better" ticker actually performed better post-sell |
| Phase 8 outcome-correlation gate (Sprint 31) | Raw event count (n≥20) is the wrong activation criterion — a biased scorer with 25 scored events is worse than no scoring. The gate compares mean skill score for wins vs losses: if wins don't score higher, `sf=1.0` regardless of n. Prevents Ollama's potential stop-hit bias from silently amplifying miscalibrated trades |
| Prompt regression detector using binomial SE (Sprint 31) | A Δ column in the UI requires the user to notice a regression. Automated detection with SE-thresholded significance (1×SE = early warning, 2×SE = significant) surfaces the signal immediately. Displaying SE alongside the drop prevents false alarms from being acted on |
| Priority-ordered calibration token budget (Sprint 31) | Parts appended in priority order (conf bands first, per-ticker last) means dropping from the end always removes the least critical information. A hard ceiling as safety net prevents mid-sentence truncation even if a single part is unusually long |
| `risk_management_score` dropped | Redundant — `skill_score` + error tags already cover this |
| Lessons Database ✅ *(Sprint 39)* | `trading_lessons` table with scoped keys (ticker/sector/regime). `GET /api/learning/lessons?ticker=X&sector=Y&regime=Z` returns up to 4 matching lessons injected as `LESSONS_BLOCK` in every Claude user message. CRUD: `POST /api/learning/lessons`, `DELETE /api/learning/lesson/<id>`. |

---

## Implementation Notes

- **Stage 1–4 improvements (May 2026):**
  - Stage 1: `entry_signals_json` + `debate_synthesis_winner` columns; `_detectExitReason()` auto-detects stop/target hits; parent BUY reconcile on full position close
  - Stage 2: postmortem endpoint (`/api/debate/postmortem`) wired; per-ticker calibration stats via `tickers` param. **Auto-trigger on close removed in hotfix a888eec — now manual-only via 🤖 button.**
  - Stage 3: explicit calibration algorithm + debate-block usage rule in system prompt; `PROMPT_VERSION='2026-05-v5'`
  - Stage 4: synthesizer returns `{winner, margin, key_pivot}`; stored in DB and shown in SYNTHESIS line
- **D1–D7 debate improvements (May 2026):** synthesizer `num_predict` 120→180 (D1); reversed JSON scan (D2); `/no_think` suffix removed (D3); 5d/20d/ATR signals in debate + hash (D4); `entry_signals_json` in postmortem/skill prompts (D5/D6); direction-aware prompts for SELL/TRIM (D7)
- **L1–L6 learning improvements (May 2026):** regime warning skips 0 trades (L1); error-type threshold 40%→33%, min losses 4→3 (L2); auto-expire moved to write path only (L3); `_calib_compute()` pure function + 5-min TTL cache (L4); synthesis winner in `buildDebateSummary` (L5); `debate_synthesis_winner` logged from JS (L6)
- **Sprint 23 hardening (May 2026):**
  - **Ollama structured outputs:** `format_schema` param added to `_call_ollama`; all 6 JSON-producing Ollama endpoints now pass a schema object; Ollama constrains token generation at grammar level
  - **ESS calibration gates:** `_ess(subset)` helper added to `_calib_compute()`; all `n≥3` raw count guards replaced with `ESS≥2.5`; low-ESS subsets emit warning tokens instead of confidence nudges; ESS values shown in calibration block output
  - **SQLite timeout:** `sqlite3.connect(timeout=10)` → `timeout=30` in `db.py`
  - **Signal flattening:** `_flatten_entry_signals(json_str)` helper; 12 key diagnostic fields; compact pipe-separated format; replaces all raw `", ".join(k=v)` patterns in postmortem, postmortem-debate, and skill endpoints
  - **Phase 3 corrected in docs:** was documenting old "maintains/concedes + digit check" protocol; current code is neutral synthesis since the challenger-bias redesign; doc now accurately reflects the implementation
  - **Cloud adjudicator provider picker (Sprint 22):** user can select Gemini, Groq, or Claude API explicitly; auto-detect still available; provider picker modal shown when multiple keys are configured
- **Sprint 24 (May 2026):**
  - **Blind adjudication:** `debate_adjudicate()` randomly assigns "Analyst Alpha"/"Analyst Beta" aliases before building the cloud prompt; response parsed using `score_alpha`/`score_beta` fields; winner un-swapped via `blind_map` to canonical A/B before storage; `blind_swap`, `alias_a`, `alias_b` stored in `phase_4` transcript
  - **JS Ollama priority queue:** `_oqEnqueue(fn, priority)` added to `debate-client.js`; HIGH lane for user-initiated calls (`fetchDebate`, manual `fetchPostmortemDebate`); LOW lane for Learning-page-initiated calls (`triggerPostmortem`, `fetchSkillScore`, `triggerCalibQualityIfStale`); manual postmortem button passes `priority:'HIGH'`. *(hotfix a888eec: auto-triggers removed — all three are now Learning-page-initiated)*
  - **Skill-weight centering:** `_weight()` formula changed from `max(0.2, sk/10)` to `max(0.2, min(1.8, sk/5.0))`; neutral at 5 instead of 10; unscored events remain at sf=1.0
  - **Hierarchical regime fallbacks:** `_REGIME_GROUPS` dict added to `learning.py`; calibration falls through: specific regime → macro group (bearish/bullish/neutral) → all trades when ESS < 2.5; each level labelled with specificity warning
- **Sprint 25 (May 2026):**
  - **Volatility-adaptive half-life:** `_HL_MAP` dict in `_calib_compute()` maps regime → half-life (20–60d); `_decay()` and `_weight()` pick up `hl` via closure; non-default half-life shown in calibration block header as `hl=Nd`
  - **SQLite startup maintenance:** `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` added to `init_db()` in `db.py`; runs non-blocking on every server start
  - **Phase 6 design spec documented:** binomial SE pre-calculation as statistical hallucination guard; prompt template constraining model to qualitative failure-tag analysis only
  - **Confidence → sizing analysis:** Kelly already binds calibrated confidence to position size via `winProb`; second multiplier deferred as double-discount risk
- **Sprint 26 (May 2026):**
  - **Phase 6 implemented:** `GET /api/debate/calib-quality` in `routes/debate.py`. `_norm_cdf(x)` using `math.erfc` (no scipy). `_calib_bands_raw(regime, days)` fetches recent bands. `_calib_quality_prompt(bands)` builds constrained prompt with pre-computed Z-scores, p_noise, immutable verdict facts. `_SCHEMA_CALIB_QUALITY` JSON schema enforces Ollama output. Result cached to `blob_store.calib_quality_latest`. `force=1` query param bypasses cache
  - **Learning page Calibration Quality card:** `renderCalibQualityCard()` async function; traffic-light badges (🟢/🟡/🔴); loads with `cache_only=1` on render (no Ollama call); "▶ Run debate" button when no cached result; "Refresh" button when cached. **Manual-only since hotfix a888eec** — auto-trigger removed
  - **Auto-trigger (removed hotfix a888eec):** `triggerCalibQualityIfStale(regime)` was added to `debate-client.js` and called from `analysis.js` after `logRecsToLearningLoop()`; this auto-call was removed; now triggered only by the "▶ Run debate" / "Refresh" button on the Learning page card. `routes/debate.py` accepts `?cache_only=1` to return the cached result immediately without an Ollama call.
- **Sprint 27 (May 2026):**
  - **Success tag calibration nudge:** Step 6b in `_calib_compute()`. Queries `success_tags` from closed win events. If ≥33% of tagged wins share a tag and ESS≥2.5, emits `✓tag(N/Mwins,ESS=X.X)→lean into this` in the calibration block
  - **`success_patterns` in stats:** `/api/learning/stats` now returns `success_patterns: {tag: {wins, total, win_rate}}` for all 5 supported tags with ≥1 win
  - **Success Patterns UI card:** inserted between Failure Patterns and Recent Events in Learning page; two-column layout (tag chips + bar chart left, calibration nudge explanation right); 5 tags with distinct colors from `WIN_TAG_META`
- **Sprint 28 (May 2026):**
  - **Combined skill + success-tag call:** `debate_skill()` now also populates `success_tags` for wins in the same Ollama call. `_SCHEMA_SKILL` extended with optional `success_tags` property. Prompt conditionally adds tag guidance + example only when `outcome == 'win'`. Tags validated against `VALID_WIN_TAGS` before DB write. Saves one Ollama round-trip vs the separate `tag-win` endpoint
  - **Regime-specific decay interpretation:** Section 4 of `_calib_compute()` now sub-checks the current regime when global decay (`Δ<-15pp`) is detected. If ≥3 recent same-regime trades exist and |regime_delta|<8pp, emits `...but {regime}:XX%stable→likely-regime-exposure(not universal decay)` instead of the generic reduce-posn instruction. Helps Claude distinguish a universal strategy breakdown from under-performance concentrated in other regimes
- **Sprint 30 (May 2026):**
  - **Earnings beat/miss history:** `earnings_history` (yfinance ≥0.2.x) now forwarded to Claude in `earningsCtx` as `EPSvEst(4Q):[+0.05,-0.02,+0.08,+0.03]` — last 4 quarters of actual-minus-estimate per ticker
  - **ASX sector ETF performance:** 5 SPDR sector ETFs (XMJ/XFJ/XHJ/XEJ/XRJ) added to `_macro_payload()` parallel fetch; `macro_data["sectors"]` returned with 1D change + 5D return; rendered as `ASX Sectors(1D/5D): Materials:+1.2%(5d+3.1%) | ...` in `macroCtx`
  - **Key missing fundamentals:** `free_cashflow` added to `indicators.py` fundamentals dict; `indicatorCtx` now includes `OpMgn`, `D/E`, `RevGrowth`, `FCFYield` (FCFYield computed client-side as `free_cashflow / market_cap`)
  - **Commodity/rates forwarding:** `liveCtx` (macro brief input) and `macroCtx` (portfolio analysis) now include iron ore, oil, copper, US10Y — already fetched by `_macro_payload()` but previously dropped before reaching Claude
- **Sprint 31 (June 2026):**
  - **Phase 8 outcome-correlation gate (Gap 2):** `_compute_phase8_meta()` helper added to `routes/learning.py`; computes whether mean skill score for wins exceeds losses/breakeven (n≥10 required). `_weight()` in `_calib_compute()` now sets `sf=1.0` when gate fails — activated via closure over `_phase8_active` variable set after rows are fetched. Phase 8 status exposed in `GET /api/learning/stats` as `phase8` key; Learning page renders ✅/⏸️ status line
  - **Prompt regression detector (Gap 5):** `_check_prompt_regression()` helper compares two most recent versions (n≥10 each); binomial SE used as significance threshold (1×SE = early warning, 2×SE = significant). Result in stats as `prompt_regression`; Learning page renders amber/red banner above calibration card when regression detected
  - **Calibration token budget (Gap 8):** `_CALIB_CHAR_BUDGET=400` (target) and `_CALIB_CHAR_CEILING=600` (hard ceiling) added to `_calib_compute()`. While loop drops lowest-priority parts (per-ticker last → conf bands first) until under budget; ceiling applied as safety net with `…` truncation. Prevents malformed partial calibration instructions as more parts are added
- **Sprint 29 (May 2026):**
  - **SELL/TRIM structured decision tagging:** Three new DB columns (`sell_primary_driver`, `sell_secondary_factors`, `sell_urgency`) added via `_LE_MIGRATIONS`. Claude declares tags at SELL/TRIM generation time — before outcome is known — to avoid self-justification bias. 9 primary drivers (closed vocabulary), 12 secondary factors (0–3), 3 urgency levels. `validateSellTags()` added to `response-validator.js` and wired into `validateRec()` for SELL/TRIM; enforces forbidden combos, required-secondary rules, and `alternativeTicker` presence for `better_opportunity`. Tags logged to backend via `logRecsToLearningLoop()` and rendered as a colour-coded strip on SELL/TRIM rec cards. Ollama postmortem remains the separate agent for closed-trade analysis
  - **Sync to Learning Loop duplicate fix:** `syncClosedTradesToLearningLoop()` was setting `r._learningId = res.id` on a spread copy of the `recHistory` entry, not the original. `scheduleSave()` then persisted the unchanged original (still lacking `_learningId`), causing every subsequent Sync to re-log the same trades as new events and inflate calibration stats. Fixed by also writing `_learningId` back to the matching `state.recHistory` entry before `scheduleSave()`
  - **`quarterly_earnings` deprecation fix:** `routes/market.py` earnings calendar switched from deprecated `stk.quarterly_earnings` to `stk.earnings_history` (yfinance ≥0.2.x). Column name mapping updated: `epsActual`/`epsEstimate` (new) with `Reported EPS`/`Estimated EPS` as fallbacks
- **Sprint 42 (June 2026):**
  - **Stooq price fallback (third line of defence):** `stooq_quote(yf_symbol)` added to `core.py`. Fires only when `fetch_with_retry` exhausts retries AND `_last_good` stale cache is empty (fresh server start + yfinance completely down). `_to_stooq_sym()` converts Yahoo Finance symbols: dict for globals (`^AXJO→^axjo`, `AUDUSD=X→audusd`, `GC=F→gc.f`, etc.), `.AX→.au` rule for ASX equities. `TIO=F` and `YAP=F` unsupported (not on Stooq). Integrated in `_quote_cached()` (quote endpoint) and `_fetch_symbol()` (macro payload). Response includes `_source: 'stooq'` when the fallback fires. Normal operation never hits Stooq.
  - **`ai_call_log` for local LLM:** `quick_analysis()` in `routes/debate.py` now writes to `ai_call_log` with `agent_type='portfolio:local'` after every successful Ollama response. `input_tokens`/`output_tokens` are `NULL` (Ollama doesn't return token counts); `duration_ms` is the Ollama round-trip time. Browsable via `GET /api/log/ai_calls?agent_type=portfolio:local`.
  - **`high_60d`/`low_60d` forwarded to Claude:** `analysis.js` user message now appends `| Range60d: hi=${n} lo=${n}` to the Returns line when both fields are non-null. Previously emitted by `indicators.py` but never reached the Claude prompt. Signal #4 in `_dtBuildRecs()` also updated to use the actual Fibonacci computation (`fib50 = low_60d + 0.50 × range`, `fib618 = low_60d + 0.618 × range`) with `return_60d` fallback.
  - **Multiple portfolios (account tagging):** `account: 'personal'|'super'|'trading'` field added to each holding. `state.activeAccount` ('all' by default) filters `mergedPortfolio()`. Portfolio page shows account filter tabs and colour-coded account badges (click to cycle). `analysis.js` injects `Account: SUPER` (etc.) into the Claude user message header when `activeAccount !== 'all'`. `ai_learning_events` rows do not yet capture account scope — recorded as a future enhancement when per-account calibration data is sufficient.

- **Sprint 49 — Virtual outcome accuracy + UI fixes (June 2026):**
  - **Speed weight fix:** `_resolve_virtual_outcomes()` now tracks `bars_to_resolution` (the 1-indexed bar at which target/stop was first hit) instead of total elapsed time from creation to today. A rec from 40 days ago that hit target on bar 5 now correctly gets `speed_weight = min(1.0, 7/5) = 1.0` instead of the old `7/40 = 0.175`. Unresolved (virtual_open) uses the full bar count of the OHLCV history fetch.
  - **Cutoff corrected:** Recs must be ≥30 days old before virtual resolution — was incorrectly 10 days in the initial implementation; corrected to match the spec. Ensures trades have had time to play out before being classified as virtual_open.
  - **`n_virtual_resolved` in stats:** `/api/learning/stats` now returns `n_virtual_resolved` (total DB count of resolved virtual outcomes). Learning page calibration card shows a cyan badge "~N virtual outcomes included" when N > 0; `virtual_speed_weight` shown in the `~W`/`~L` chip tooltip as the effective calibration weight (0.75 × speed_weight).
  - **`virtual_speed_weight` in recent events SELECT:** `learning_stats()` recent events query now fetches `virtual_speed_weight` so the UI can render the per-event effective weight.
  - **`virtual_speed_weight` documented in table:** column now listed in the `ai_learning_events` table above (was missing from the doc despite being live in the DB since Sprint 44).

- **Post-Sprint-48 — Claude tags column in Recent Events table (June 2026):**
  - **New "Claude" column** inserted between Error tags and the Skill column in `js/pages/learning.js`. Shows `sell_primary_driver` + `sell_urgency` chips for SELL/TRIM rows, `success_tags` chips for WIN rows, and `—` for all other rows. `DRIVER_META` and `URG_META` lookup tables provide colour-coded short labels for all 9 primary drivers and 3 urgency levels. The column surfaces data that was already logged in `ai_learning_events` but had no UI representation.
  - **`✓ no error` badge in Error tags column** — `tagCell()` now prepends a small grey `✓ no error` span when `error_type === 'none'` so Ollama-reviewed rows are distinguishable from unreviewed ones. The 8 tag buttons are still rendered (for manual re-tagging).
  - **Auto-refresh after "Classify All Untagged"** — `classifyAllPostmortems()` now calls `showPage('learning')` via `setTimeout(..., 800)` after the batch completes, so newly-assigned tags appear without a manual Refresh click.
  - WIN `success_tags` display moved exclusively to the Claude column; the Error tags column is now strictly for Ollama-classified error tags on loss/breakeven rows.

- **Tag button HTML fix (May 2026):** `JSON.stringify()` double-quotes broke `onclick` attribute parsing. Fixed with `.replace(/"/g, '&quot;')`.
- **Calibration default window:** 90d default, 180d hard cap — more data for decay weighting to work with.
- **Protective stop UX:** 🛡? button only shows on `stop_hit` loss/breakeven rows. Clicking sets `exit_reason = 'protective_stop'` via `POST /api/learning/outcome`. Green 🛡 badge confirms exclusion from confidence calibration.
- **Calibration block format:** `CALIBRATION(Ncls,YYYY-MM→YYYY-MM,regime,Nexcl): …` — `Nexcl` is omitted when zero.
- **Staleness banner:** renders with spinner immediately on page load for old recs; Ollama fills it async without page reload.
- **Skill score badge colours:** green ≥7 · amber 4–6.9 · red <4.
- **Ollama 404 error:** now surfaces `"Model not found — run: ollama pull <model>"` with Ollama's own error body, instead of the opaque `"Ollama HTTP 404"`.
- **`qwen3.5:9b` is a valid Ollama model** (confirmed). It is a thinking/reasoning model — `think: false` and `/no_think` both apply. Works for all JSON endpoints after the thinking-model fixes.
- **Shared postmortem helpers** (`_pm_build_summary`, `_pm_exit_hint`, `_pm_build_prompt`, `_pm_validate_tags`, `_pm_parse`): extracted before both postmortem endpoints so single-model and adversarial debate use identical trade summaries and prompts. This ensures Phase 1 of the adversarial debate is a fair comparison — both models see exactly what 🤖 would have seen.
- **`_pm_validate_tags()`**: stand-alone validator (no JSON roundtrip). Splits comma-separated tags, validates each against `VALID_PM_TYPES`, and strips `none` when mixed with real tags (mutually exclusive).
- **`error_type_source` values for adversarial debate**: `debated-consensus` (sets identical), `debated-merged` (overlap kept), `debated-singleton` (only one model parsed), `debated-synthesis` (Phase 3 neutral synthesis parsed successfully), `debated` (Phase 3 fallback when synthesis parsing fails). These are distinct from `'auto'` (single 🤖 run) and `'manual'` (user button clicks).
- **Debate transcript modal**: shown immediately after ⚔️ completes, before the page re-renders. The transcript persists in `postmortem_debate` column for later inspection. The modal shows Phase 1 tags+reason per model, Phase 3 neutral synthesis result, final tag, and timing.
- **Per-phase logging**: each phase logs separate INFO lines with timing — `Phase 1A — qwen3.5:9b…` / `Phase 1A done (4231ms)`. Lets you tail `asx_server.log` to watch a debate progress without polling.
- **Stored-debate viewer (📜)**: rows where `postmortem_debate IS NOT NULL` get a 📜 button next to ⚔️. Click opens the same modal used after a fresh run, with a `STORED` badge in the header. The data comes from an in-memory cache (`_learningEventsById`) populated by `_renderLearningContent` — no extra HTTP round-trip. ⚔️ still triggers a fresh debate that overwrites the stored transcript.
- **Modal ESC-to-close**: keydown listener attached on modal mount, removed via MutationObserver when the modal element is detached (handles all three close paths: ✕ button, click-outside, ESC).
- **Debate Stats card** (`GET /api/learning/debate-stats`): aggregates all stored `postmortem_debate` JSON blobs by `(model_a, model_b)` pair. Counts verdicts and computes `concede_rate = concedes_in_phase_3 / total_diverged`. High Agree% with low A→B = healthy pair; low Agree% with high A→B = primary model is weaker than opposition (consider swapping).

---

## Next Milestones

1. ✅ **Phase 8** — `_compute_phase8_meta()` live with Mann-Whitney U gate (z>1.28, one-sided p<0.10). Now also in `_calib_compute()` (hotfix 16bba99). Phase 8 activates automatically once 10+ scored events exist where wins score statistically higher than losses.
2. ✅ **Phase 6** — `GET /api/debate/calib-quality` live; Z-scores pre-computed server-side; Learning page traffic-light card. **Manual-only** (hotfix a888eec removed auto-trigger; card loads with `cache_only=1`).
3. ✅ **Virtual outcomes** — `_resolve_virtual_outcomes()` live (Sprint 36); feeds back at 0.75× weight × `virtual_speed_weight` (Sprint 44). Speed weight uses `bars_to_resolution` (not elapsed time) since Sprint 49 fix; cutoff is ≥30d.
4. ✅ **Lessons Database** — `trading_lessons` table + CRUD + Claude injection + `breadth_scope` filtering live (Sprint 39, Sprint 44).
5. ✅ **Regime-aware SELL/TRIM ATR floor** — `analysis.js` Step 3 now reads `regimeMod.stopAtrMult ?? 2.5` from `getRegimeModifiers(state.currentRegime.regime)`. Rec flagged `_stopRepaired: true` and `_stopRepairedMult: N`. *(Sprint 41)*
6. ✅ **`high_60d` / `low_60d` for Fibonacci** — `indicators.py` `analyse_ticker()` now emits `high_60d = high.tail(60).max()` and `low_60d = low.tail(60).min()`. Signal #4 in `prompts.js` updated to use `fib_50`/`fib_618` computed from these values, with `return_60d` as fallback. *(Sprint 41)*
7. ✅ **Thesis drift detection** — `_compute_thesis_drift(conn)` + `GET /api/learning/thesis-drift` + `renderThesisDriftCard()` on Learning page. *(Sprint 45)*
8. ✅ **Regime-flip calibration penalty** — `fetchAndClassifyRegime()` writes flip timestamp to localStorage; `_calib_compute()` halves HL for first <10 trades; emits `⚠REGIME_FLIP` token. *(Sprint 44)*

---

## Implementation Plans — Open Items

### ✅ Plan A: Regime-aware SELL/TRIM stop floor in `analysis.js` — SHIPPED Sprint 41

**Problem (resolved):** Post-processing Step 3 previously hardcoded `2.5×ATR` for SELL/TRIM regardless of regime.

**Fix applied:** `analysis.js` reads `regimeMod.stopAtrMult ?? 2.5` from `getRegimeModifiers(state.currentRegime.regime)`. Uses that value for both the check threshold and the floor value. Recs flagged `_stopRepaired: true` and `_stopRepairedMult: stopMult`. Tests in `test_app.py` `TestSprint41PlanAB`.

---

### ✅ Plan B: `high_60d` / `low_60d` for day-trade Fibonacci levels — SHIPPED Sprint 41

**Fix applied:** `indicators.py` `analyse_ticker()` now emits `"high_60d": safe_float(high.tail(60).max())` and `"low_60d": safe_float(low.tail(60).min())` (None when < 60 bars). Signal #4 in both day-trade prompts in `prompts.js` updated to use `fib_50 = low_60d + 0.50*(high_60d - low_60d)` and `fib_618 = low_60d + 0.618*(high_60d - low_60d)`, with `return_60d` fallback. Tests in `test_app.py` `TestSprint41PlanAB`.

---

### ✅ Plan C: Formalise `eps_revision_30d` proxy in system prompt — ALREADY SHIPPED

**Already in place:** `ANALYSIS_SYSTEM_PROMPT` Priority 1 already explicitly states "This is a PROXY for revision direction, not true 30-day analyst consensus revision data (which is unavailable from yfinance)" with clear 3+ beat / 2+ miss rules. No code change required — only doc update to close the gap.
