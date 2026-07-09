# Learning Loop — Architecture & Data Flow

**Status:** Live. Closes the feedback cycle between Claude's recommendations and real-world outcomes: records every AI-generated trade recommendation, links it to execution and closure data, analyses performance, and feeds compact, statistically meaningful insights back into future Claude calls.

For sprint-by-sprint implementation history, use `git log` — this doc describes current behaviour only.

---

## Purpose

- Objective measurement of Claude's (and the system's) edge.
- Detect prompt decay, regime mismatches, and recurring failure patterns.
- Deliver high-signal, regime-aware, time-decayed calibration feedback without breaking prompt caching.
- Distinguish bad analysis from good-discipline losses (capital protection).
- Support continuous improvement via structured post-mortem analysis and local-model debate.

---

## Data Storage

All learning data lives in `asx_trader.db` (SQLite, WAL mode).

### `ai_learning_events` (primary table)

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER PK | Auto-incremented event ID |
| `ticker` | TEXT | ASX ticker |
| `recommendation` | TEXT | BUY / SELL / TRIM / TOP_UP / HOLD |
| `ai_confidence` | REAL | Claude's stated confidence (0–1) |
| `ensemble_confidence` | REAL | Quant engine confidence (0–1) |
| `outcome_status` | TEXT | `win`/`loss`/`breakeven`/`open`/`skipped`/`expired`, or **NULL** for a freshly-logged rec. Consumers must filter on explicit values, never `IS NOT NULL`-as-closed. Virtual values (`virtual_win`/`virtual_loss`/`virtual_open`, `virtual_hold_miss`/`virtual_hold_correct`) live in the separate `virtual_outcome` column. |
| `realized_pnl_pct` / `realized_pnl_aud` | REAL | Exit P&L |
| `regime` | TEXT | Market regime at rec generation (write-once) |
| `prompt_version` | TEXT | System prompt version |
| `was_executed` | INTEGER | 0/1 |
| `suggested_stop` / `suggested_target` | REAL | Claude's levels |
| `rr_ratio` | REAL | Reward:risk ratio |
| `holding_period_days` | INTEGER | Days held |
| `exit_reason` | TEXT | `stop_hit`/`target_hit`/`manual`/`protective_stop`/`time_exit`. ⚠ `day_trade_history.db`'s `trade_snapshots.exit_reason` uses `time_stop` instead — grep both when searching time-based exits. |
| `rationale_summary` | TEXT | First 400 chars of Claude's reasoning |
| `actual_entry_price` / `actual_exit_price` | REAL | Fill prices |
| `sector` | TEXT | GICS sector |
| `error_type` | TEXT | Comma-separated tags (loss/breakeven only). Default source is **deterministic** — `classify_error_type_deterministic()` fills NULLs; LLM/manual tags override and are never overwritten. |
| `error_type_source` | TEXT | `deterministic` / `manual` / `auto` (LLM) / `debated-*` / `adjudicated` |
| `skill_score` | REAL | 0–10 analysis quality vs luck. **Deterministic** via `compute_skill_score_deterministic()` from the `thesis_verdict × outcome` quadrant; NULL when no verdict. 🔬 Ollama scorer remains a manual override. |
| `debate_summary` | TEXT | ≤200-char bull/bear summary at analysis time |
| `prompt_hash` | TEXT | 12-char fingerprint of prompt version + regime + date |
| `postmortem_debate` | TEXT | JSON transcript of full adversarial debate |
| `entry_signals_json` | TEXT | ~24-field JSON snapshot of live signals at generation time: `rsi_14`, `bb_pct_b`, `adx_14`, `atr_pct`, `return_5d/20d`, `px_vs_sma20/50/200`, `pct_from_high60/low60`, `rvol`, `adv_20`, `macd_hist`(+prev/bullish), `rs_score`, `rs_5d_alpha`, `setup_score`, `forward_pe`, `pb_ratio`, `dividend_yield`, `revenue_growth`, `earnings_growth`, `days_to_earnings`. Feeds postmortem/skill prompts and `_entry_signature()` exemplars. |
| `debate_synthesis_winner` | TEXT | `'bull'/'bear'/'neutral'` (BUY) or `'hold'/'exit'/'neutral'` (SELL/TRIM) |
| `tags` / `trade_thesis` / `checklist_bypasses` | TEXT | User trade tags, entry thesis, bypassed checklist items |
| `success_tags` | TEXT | Comma-sep win tags, e.g. `confluence_entry`, `disciplined_hold`, `regime_aligned` |
| `sell_primary_driver` / `sell_secondary_factors` / `sell_urgency` | TEXT | Structured SELL/TRIM tags declared by Claude at generation time (9 primary values, 0–3 secondary, `immediate`/`routine`/`monitor`) |
| `virtual_outcome` | TEXT | `virtual_win`/`virtual_loss`/`virtual_open` — lazily resolved for `was_executed=0` recs ≥30d old. For `recommendation='HOLD'` the same column carries `virtual_hold_miss`/`virtual_hold_correct` (see HOLD Outcome Tracking) — value sets never collide. |
| `virtual_pnl_pct` | REAL | Reserved; NULL until entry price known |
| `virtual_speed_weight` | REAL | `min(1.0, 7.0/bars_to_resolution)` — fast target/stop hits weight near 1.0, slow drifts taper toward ~0.2. Used as `0.75 × virtual_speed_weight` inside `_weight()`. |
| `alternative_ticker` / `sell_verify_date` / `sell_verify_verdict` / `sell_verify_sold_chg` / `sell_verify_alt_chg` | — | `better_opportunity` SELL cross-check: 25d+ verification of sold vs alternative ticker performance |
| `exec_mech_pnl_pct` / `exec_mech_exit` | REAL/TEXT | Simulated mechanical exit (stop/target/15-bar time-stop) P&L and which rule fired — the execution-alpha baseline |
| `mae_pct` / `mfe_pct` / `mae_mfe_resolved_at` | REAL/TEXT | Max Adverse/Favorable Excursion during hold (stop-first intrabar convention); resolved lazily, idempotent |
| `stop_cf_saved` | INTEGER | 1 if a regime `stopAtrMult`×ATR wider stop would have reached target (OHLC counterfactual) |
| `primary_entry_driver` | TEXT | `mean_reversion`/`momentum_breakout`/`trend_pullback`/`fundamental_value`/`macro_tailwind` — declared by Claude at BUY/TOP_UP, backfillable via `classify_entry_driver()` |
| `thesis_verdict` | TEXT | `validated`/`invalidated`/`irrelevant` — did the entry driver play out? Computed by `computeThesisDrift()` at SELL/TRIM time, patched onto the **parent BUY/TOP_UP** at close. Distinct from `sell_verify_verdict` ("was selling the right call"). |
| `rule_warnings_json` | TEXT | JSON array of deterministic quant/validation rules that flagged this rec, e.g. `[{"code":"confidence_floor","detail":"...","severity":"warn"}]`. Stable `code` enum: `quant_declined`/`neg_ev`/`confidence_floor`/`whipsaw`/`self_contradiction`/`heat_budget`/`validator_fail`/`fallback_sized`. NULL when clean; auto-repaired issues excluded (fixed ≠ overridden). |
| `exit_signals_json` / `exit_quality_tag` | TEXT | Exit-time signal snapshot + classification (`exit_into_strength`/`exit_after_reversal_confirmed`/`exit_into_weakness`/`exit_neutral`); separate columns, not folded into `error_type` |
| `regime_at_execution` | TEXT | Regime at execution (the write-once `regime` column keeps generation-time value) |
| `fetch_failed_at` | TEXT | Last failed yfinance fetch — lazy resolvers skip the row for `_FETCH_RETRY_DAYS` (7d) before retrying |
| `calibrated_confidence` | REAL | Post-nudge confidence actually used for sizing; NULL when no nudge fired. `ai_confidence` always stores the original. |
| `trade_mode` | TEXT | `real`/`paper` — paper events get a 0.5× weight in `_weight()`; upgradeable at execution time |
| `local_scrutiny_json` | TEXT | Stored local-LLM scrutinize verdict for a pending rec |

> **`loss_quality`** is a *computed* property, not a column — derived from `exit_reason`/`error_type` at calibration time (`protective_stop` or `external_shock` → good loss, excluded from confidence calibration; `overconfident`/`poor_entry` → bad loss, full weight; else neutral).

### Supporting tables
- `rec_history` — every Claude recommendation + `learning_id` link.
- `trade_journal` — all trades (AI + manual) with `close_date`.
- `trading_lessons` — scoped `(lesson_text, ticker?, sector?, regime?, source, breadth_scope?)` injected into Claude's user message. `breadth_scope`: `adl_below_0.3`, `adl_above_0.7`, `high_vol`, `low_vol`, `earnings_season`, `cgt_window`, or null (always inject). CRUD via `GET/POST /api/learning/lessons`, `DELETE /api/learning/lesson/<id>`.
- `tag_reviews` — manual spot-check verdicts for auto-tagged events; drives the `agree_rate` gate on the `top_err` nudge.
- `calibration_snapshots` — one row/day `(snapshot_date, brier_score, n, prompt_version)`; feeds `GET /api/learning/calibration-trend`.
- `ai_call_log` — full prompt+response audit trail for every `callClaude()` call, including local-LLM calls (`agent_type='portfolio:local'`). Browsable via `GET /api/log/ai_calls[/<id>]`.

---

## Event Lifecycle

1. **Recommendation Generated** (`analysis.js → logRecsToLearningLoop()`) — `POST /api/learning/log` creates a partial record and returns `id`, stored as `rec._learningId`. Persists `debate_summary`, `prompt_hash`, `entry_signals_json`, `debate_synthesis_winner`, `primary_entry_driver` (BUY/TOP_UP), `thesis_verdict` (SELL/TRIM), `rule_warnings_json` (when any rule flagged the rec). **HOLD recs are logged too** — stripped from the pending/UI set but re-collected (`_holdRecs`) so `_resolve_hold_outcomes()` can grade passivity. Server-side dedupe: one HOLD event per ticker per `_HOLD_DEDUP_DAYS` (7d) — `deduped:true` returned on repeat.

2. **Trade Executed** (`recommendations.js → markExecuted()`) — `POST /api/learning/outcome` updates entry price + outcome fields. `exit_reason` auto-detected via `_detectExitReason()` (±0.5% tolerance). Auto-reconciles parent BUY/TOP_UP events (incl. `thesis_verdict`) when a SELL/TRIM fully closes a position. **No auto-triggered LLM postmortem/skill-score** — those are manual-only (🤖/🔬 buttons); deterministic tagging/scoring fills automatically instead (step 2b).

2b. **Deterministic tagging + scoring** (`_resolve_deterministic_tags(conn)`) — runs lazily inside `_calib_compute()` (capped 50/call, idempotent, NULLs only). `classify_error_type_deterministic()` assigns multi-tag `error_type` for closed losses/breakevens; `compute_skill_score_deterministic()` assigns `skill_score` from the verdict×outcome quadrant. Manual/LLM tags are never overwritten.

3. **Trade Closed** (`performance.js → syncClosedTradesToLearningLoop()`) — reconciles journal against `rec_history`, patches outcome, auto-detects `exit_reason`. Writes `_learningId` back onto the **original** `state.recHistory` entry (not a spread copy) before `scheduleSave()` — prevents re-logging the same trade as a new event on every Sync.

4. **Manual Trades** — full record creation on SELL/TRIM (Branch B).

---

## Handling Market Non-Stationarity & Good Losses

**Core philosophy:** a loss from 6 months ago in a different regime shouldn't carry the same weight as one from last week; a disciplined stop-out that protected capital is not a model error.

**1. Exponential time-decay, regime-adaptive half-life**
```python
weight = exp(-ln(2) × days_since_close / half_life)
```
| Regime | Half-life | | Regime | Half-life |
|---|---|---|---|---|
| `panic` | 20d | | `riskOn` | 50d |
| `riskOff` | 30d | | `sideways` | 60d |
| `highVol` | 35d | | (default/unrecognised) | 45d |
| `trend` | 45d | | | |

Only the six `classifyRegime()` names are valid keys. `_REGIME_GROUPS` for hierarchical fallback: bearish={riskOff,panic}, bullish={riskOn,trend}, neutral={highVol,sideways}. Non-default half-life is logged in the calibration block header (`hl=Nd`). Default window 90d, hard cap 180d.

**2. Protective-stop / external-shock exclusion** — differs by check:

| Where excluded | `protective_stop` | `external_shock` |
|---|---|---|
| Confidence-band calibration | ❌ Excluded | ❌ Excluded |
| Error pattern learning | ✅ Included if tagged | ❌ Excluded |
| Regime/Sector/Decay/R:R stats | ✅ Included | ✅ Included |

The count of confidence-band exclusions shows as `Nexcl` in the block prefix.

**3. Effective Sample Size (ESS) gating** — raw count misrepresents power when weights vary. `ESS = (Σwᵢ)² / Σwᵢ²`, threshold **6.0**. Below it, a warning token replaces a nudge (`⚠low ESS=4.1(n=6)`). Behaviour-changing tag nudges use a separate raw-count floor `_MIN_NUDGE_N=12`. Aggregate Wilson-CI'd stats on the Learning page are always shown — only prompt-injected nudges are gated.

**3b. Hierarchical regime fallback** — specific regime (ESS≥6) → macro group (bearish/bullish/neutral) → all trades, each level labelled with a specificity warning. 0 trades in a regime = silently omitted even at the all-trades level.

**4–5. Date range + regime-conditional filtering** — every calibration block states its date range and regime; the `regime` column on each event drives same-regime comparison.

**SQLite startup maintenance** — `init_db()` runs `PRAGMA optimize` + `PRAGMA wal_checkpoint(PASSIVE)` on every start (non-blocking, ms-scale).

### Calibration design notes

**Skill-weighted calibration** — `_weight() = time_decay × sf`, `sf = clamp(0.2, 1.8, skill_score/5.0)` (neutral at 5; unscored → sf=1.0). Phase 8 gate: Mann-Whitney U (z>1.28) compares win vs loss skill scores; if it fails, `sf=1.0` for everyone regardless of score. `skill_score` itself is deterministic (see below) so amplifying it is defensible rather than compounding LLM noise.

**Calibration Quality debate card** (`GET /api/debate/calib-quality`, manual "▶ Run debate" only) — backend pre-computes binomial SE + Z-score per confidence band (`p_noise = 2×(1−Φ(|z|))`) and presents the verdict as an immutable fact; Ollama only supplies qualitative root-cause analysis, guarding against a small model inventing causal narratives for pure noise.

**Regime-flip penalty** — on a detected regime flip, if the new regime has <10 trades within 30 days, half-life is halved; emits `⚠REGIME_FLIP(Nd ago, N trades, hl=Nd)`.

**Thesis drift** — `_compute_thesis_drift(conn)` compares avg P&L for `manual` vs `target_hit` exits (n≥5 each); >3pp lag emits `⚠EARLY_EXIT_DRAG`. Exposed via `GET /api/learning/thesis-drift`.

**Breadth-scope lessons** — `trading_lessons.breadth_scope` filters injection by ADL/vol context (see Data Storage).

**All Ollama auto-triggers are manual-only** — 🤖/🔬 buttons and the calib-quality "▶ Run debate" button; none fire automatically on trade close or analysis run (prevents queue saturation and unwanted calls during market hours).

**Virtual outcomes** (`_resolve_virtual_outcomes`, lazy in `_calib_compute()`) — for `was_executed=0` recs ≥30d old with stop+target, fetches OHLCV and checks `high≥target` (win) / `low≤stop` (loss), stop-checked-first on straddle bars. Fed back at `0.75 × virtual_speed_weight`. Asymmetric slippage applied: a win must clear the target by an ADV-tier × regime-multiplier margin (`core.adv_slippage`); losses trigger at the raw stop (pessimistic by construction). Rate stored in `virtual_slippage_applied`.

**HOLD outcome tracking** — HOLD recs carry no stop/target, so the virtual-outcome resolver above structurally never touches them; `_resolve_hold_outcomes(conn, cap=5, move_threshold=0.08)` handles them separately for events ≥30d old. A HOLD keeps an existing **long**, so it's judged **direction-aware and endpoint-based over a bounded forward window**:
- **Bounded window** — `history(start=entry, end=entry+45d)`, not entry→today, so miss-probability doesn't rise with resolution lag.
- **Endpoint, not peak** — the endpoint return over the first `_HOLD_HORIZON_DAYS` (20) trading bars; a transient dip that recovers is not a miss.
- **Vol-scaled, downside-only threshold** — `_hold_move_threshold() = K·(atr_pct/100)·√H`, floored 5%/capped 20%. Endpoint return `≤ −threshold` → `virtual_hold_miss`; flat/up → `virtual_hold_correct` (an 8% rally is never a miss). `<10` forward bars → `virtual_open`.
- The verdict freezes at first resolution. `⚠HOLD_TOO_PASSIVE(N/M …)` fires only when `n≥_MIN_NUDGE_N` (12) **and** the Wilson-95%-CI lower bound clears 50% — a bare-majority fluke stays silent.
- `hold_outcomes {n, miss_rate, correct_rate}` on `GET /api/learning/stats`; per-HOLD list + verdict/countdown via `GET /api/learning/hold-recs`, rendered as the Learning page's **HOLD Decisions** card.

---

## Calibration Injection

`fetchCalibrationBlock(regime, sectors, tickers, opts)` → `GET /api/learning/calibration?regime=X&sectors=A,B&tickers=...[&deep=1]`. Full portfolio analysis passes `{deep:true}`; high-frequency refreshes use the light feed. The backend (`_calib_compute()`, pure function, 5-min TTL):

1. Fetches last 90d closed events (180d cap).
2. Applies decay × skill weighting (regime-adaptive half-life, deterministic skill score).
3. Excludes `external_shock`/`protective_stop` from confidence-band calcs only.
4. Emits findings only where ESS ≥ 6.0, gated further by a **Wilson-CI significance check** (`_ci_excludes`) on raw counts — a nudge fires only when the band's CI lies entirely on one side of the reference.
5. Dominant error-type nudge: ≥33% of losses share a tag, min 12 losses (`_MIN_NUDGE_N`).
6. Dominant success-tag nudge (mirror of #5 for wins): `✓tag(N/Mwins,ESS=X.X)→lean into this`.
7. Per-ticker stats: >15pp delta vs overall WR, ESS≥6.
8. **Sector stats always framed as delta vs whole-market baseline** (`SECTOR:NN%WR vs mkt MM%(±Xpp,n=…)`), flagged only when ESS≥6 and the sector's Wilson CI excludes the market WR. `_resolve_missing_sectors()` backfills null sectors from `core.SECTOR_MAP`. Deep mode adds sector×regime interaction cross-tabs.
9. Sell-tag validation: `⚠SELL_TAG:time_stop(n=4,val=25%)→CUTTING WINNERS` when a driver proves unreliable.
10. Date range + regime labelled in the block header.
11. Auto-expire (>120d → `expired`) runs on the write path only.

Injected into the **user message** via `__CALIBRATION_PLACEHOLDER__` (never the system prompt — preserves Anthropic's prompt cache), expanding to `_calibrationNote + _exemplarsBlock + _lessonsBlock`.

**Deep vs light** — light = stats-only (conf bands, regime, per-ticker, sector summary). Deep adds a per-driver conditional playbook, driver×regime/setup_score cross-tabs, an `⚠SELL→ROSE` negative-confirmation line, and a separate `exemplars` field (2–3 recent losses + 1–2 best wins as compact one-liners, never truncated by the char budget — 900/1100 deep vs 400/600 light). `deep` is part of the TTL cache key.

**Thesis-matrix nudge** — lowest priority, first dropped. Emits `THESIS:<driver> val=X% inval=Y%` when validated-vs-invalidated WR gap ≥25pp with both buckets n≥5.

**Engine-side application** — the calibration response's `adjustments:{bands,tickers}` payload is applied deterministically in `analysis.js` before Kelly sizing (clamped [0.05,0.98], audit-tagged `_calibApplied`). The text block is context-only; the system prompt forbids Claude from self-adjusting confidence. Learning events always log the **original** confidence, so calibration never compounds on its own output.

---

## Thesis Tracking (Entry Driver → Exit Verdict)

Closes the loop between why a position was entered and whether that reason survived to exit, using `entry_signals_json` + two columns: `primary_entry_driver`, `thesis_verdict`.

```
BUY/TOP_UP generation           SELL/TRIM generation                Position close
Claude tags primary_entry_   →  fetchEntryContexts() injects    →   markExecuted() patches
driver (5-value enum);          HOLDING_CONTEXT; computeThesis-      thesis_verdict onto the
logged via logRecsTo-           Drift() computes verdict             parent BUY/TOP_UP event
LearningLoop()                  DETERMINISTICALLY (engine, not       (→ matrix data source)
                                 Claude) → r._thesisCheck
```

- **Entry taxonomy** (aligned to `indicators.FACTOR_WEIGHTS`): `mean_reversion`, `momentum_breakout`, `trend_pullback`, `fundamental_value`, `macro_tailwind`. `classify_entry_driver(sig)` is a deterministic technical classifier used for backfill (`POST /api/learning/backfill-entry-drivers`) and cross-check.
- **Exit side** — `fetchEntryContexts()` → `GET /api/learning/entry-context` returns the most recent BUY/TOP_UP per ticker. `computeThesisDrift(driver, entrySignals, liveSnapshot)` gives a deterministic verdict per driver: `mean_reversion` validated if it reverted toward the mean; `momentum_breakout` validated if the thrust sustained; `trend_pullback` validated if the trend resumed; `fundamental_value`/`macro_tailwind` always `irrelevant` (not technically verifiable client-side).
- **Matrix** — `_compute_thesis_matrix()` → `GET /api/learning/thesis-matrix`: driver × verdict cross-tab, each cell `{n, avg_pnl_pct, win_rate}`; rendered as the Thesis Accuracy Matrix card, plus a per-rec Thesis Check box on SELL/TRIM cards.
- **Backfill caveat** — entry drivers are backfillable from `entry_signals_json`; `thesis_verdict` is not (needs exit-time signals that only exist going forward).

---

## Decision Trackers (Sell/Trim + Buy/Top-Up)

Two per-trade review tables on the Learning page — display/aggregation layers only, no new data sources or LLM calls.

- **`GET /api/learning/sell-outcomes`** — executed SELL/TRIM with `sell_primary_driver`, `holding_period_days`, both regime columns, sector, skill_score, exit_quality_tag, MAE/MFE, thesis_verdict, error_type, bull/bear case. `?action=SELL|TRIM|all`, `?force=1`, `?days=N` (master window).
- **`GET /api/learning/buy-outcomes`** — entry-side complement: `primary_entry_driver`, thesis_verdict, P&L, same shared fields. Only closed rows (`outcome_status IS NOT NULL`).
- Shared UI helpers (`_dtActionBadge`, `_dtThesisChip`, `_dtExitQualityChip`, `_dtSkillChip`, `_dtPnlCell`) render both cards identically; each row expands to a detail view; filter bars scoped per-tracker; "↺ Check Now" forces immediate re-resolve. Cards hide entirely under the `all` filter with zero events; show a "no match" message under a non-`all` filter with zero matches.

---

## Failed-Quant-Rule Capture & Rule Override Efficacy

A second feedback loop — not over Claude's conviction (calibration) but over the **deterministic quant/validation rules**. When a rule flags a rec and the user overrides it (executes anyway), did that pay off?

`_classifyRuleWarnings(r)` (`analysis.js`) maps `_ruleWarnings` + flags into `{code, detail, severity}`. `code` is a stable enum kept in sync across `analysis.js`, `_RULE_CODE_LABELS` (`routes/learning.py`), the scrutinize prompt (`routes/debate.py`), and `db.py`'s column comment:

| `code` | Fires when | Severity |
|---|---|---|
| `quant_declined` | Kelly ≤0 / liquidity decline, or min-trade fallback | block |
| `neg_ev` | net-EV ≤0 at sized qty | block |
| `confidence_floor` | below confidence floor | warn |
| `whipsaw` | direction flip vs a near-identical recent setup | warn |
| `self_contradiction` | reasoning contradicts the action | warn |
| `heat_budget` | heat-budget block/scale | warn |
| `validator_fail` | other unrepaired validator breach | warn |

Auto-repaired issues (`_validatorFixed`) are excluded (fixed ≠ overridden). `rule_override_efficacy()` splits breached recs into **closed** (only these feed win-rate/avg P&L/verdict) / **open** (BUY/TOP_UP not yet sold — no realized P&L, shown as live mark-to-market instead) / **skipped**. Verdict `too_strict`/`validated`/`inconclusive` via Wilson-CI + `min_n` (default 12). Feeds: the scrutinize prompt, the 🧪 Rule Override Efficacy Learning-page card, a `RULE-OVERRIDE CALIBRATION` prompt nudge, and a journal `⚠ override` mirror. `_backfillRuleWarningsOnce()` runs once per session to populate pre-feature history.

---

## Master Date-Window Filter

A single global selector (`_llWindowBar()` → `30d/90d/6M/1Y/All`, default 90d) at the top of the Learning page — a **master** control, not per-card filters. Applies to dated transaction-LIST cards only (Recent Events, Sell/Buy Decision Trackers); every aggregate/stat card (win-rates, calibration, thesis matrix, rule-override verdicts) ignores it deliberately, since full history is the learning signal. The Untagged work-queue is also exempt. `?days=N` relaxes each card's count cap so a window shows everything in it; `All` keeps the cap.

---

## Deterministic Post-Mortem Tagging & Skill Scoring

**Why deterministic:** a small local model reading a one-line trade summary is structurally blind to the price path, in-hold context, or news — yet was asked to assign timing tags and a 0–10 skill score that depend on exactly that. The Thesis Tracking columns (`thesis_verdict`, `entry_signals_json`, `market_context`) provide real before/after data instead. Two pure functions in `routes/learning.py` consume it; `_resolve_deterministic_tags(conn)` applies them lazily (capped 50/call, NULLs only).

**Scope: BUY/TOP_UP only** — `error_type` and the skill quadrant are entry-centric; a SELL/TRIM loss is an exit-decision question already tracked by `sell_verify_verdict`.

### `classify_error_type_deterministic(row)` — multi-tag, comma-joined, most→least specific (`split(",")[0]` is dominant)

| Priority | Tag | Rule |
|---|---|---|
| 1 | `thesis_broken` | `thesis_verdict == 'invalidated'` |
| 2 | `stop_too_tight` | `stop_hit` + thesis not invalidated. Empirical (MAE/MFE): stop pierced AND price recovered ≥50% toward target. Fallback: stop `<1.5×ATR`. |
| 3 | `missed_catalyst` | `days_to_earnings ≤14` at entry AND hold crossed the earnings date (partly deterministic; else manual only) |
| 4 | `early_exit` | Non-win manual exit where MFE reached target or mechanical sim beats realized by ≥2pp |
| 5 | `oversized`/`undersized` | Sizing-bypass token in `checklist_bypasses` |
| 6 | `overconfident` | `ai_confidence ≥0.75` on a loss |
| 7 | `poor_rr` | `rr_ratio <1.5` |
| 8 | `poor_entry` | Entry stretched for the driver (e.g. `mean_reversion` bought with RSI>45) |
| 9 | `regime_mismatch` | Entered in `riskOff`/`panic` |
| — | `none` | Nothing matched |

Never emits `external_shock` (requires world knowledge — manual only).

**Counterfactual stop validation** — `_resolve_stop_tag_counterfactual()` tests whether a regime `stopAtrMult`×ATR stop would have reached target; `_compute_stop_tag_precision()` self-suppresses the `stop_too_tight` nudge (`⚠STOP_TAG_UNRELIABLE`) when precision <0.5 at n≥5.

### `compute_skill_score_deterministic(row)` — 0–10 or None

| `thesis_verdict` | outcome | base |
|---|---|---|
| validated | win | 8.0 |
| validated | loss | 6.0 (unlucky, good process) |
| irrelevant | win | 5.5 |
| irrelevant | loss | 4.0 |
| invalidated | win | 3.0 (luck) |
| invalidated | loss | 2.0 |

Modifiers (clamped 0–10): `target_hit` +0.5 · disciplined `stop_hit` +0.5 · manual exit on still-validated thesis −0.5 · high-conf loss −1.0 · low-conf win −0.5 · planned `rr≥2.0` +0.25 · MAE/MFE path quality ±0.5 (lucky-survivor win vs clean-follow-through win). **Returns `None`** when `thesis_verdict` is absent — no fabricated score for legacy trades (stays neutral `sf=1.0`). `compute_skill_score_fallback()` exists as a documented lower-trust estimate but is **not** wired into the resolver.

The LLM endpoints (`POST /api/debate/postmortem`, `/skill`) remain manual overrides only — the resolver fills NULLs, never overwrites a manual/LLM/adjudicated tag. Deterministic tags bypass the `agree_rate` auto-tag gate (that gate distrusts LLM tags specifically).

---

## Backend Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `POST /api/learning/log` | Write | Create new event |
| `POST /api/learning/outcome` | Write | Update outcome, tags, exit_reason |
| `DELETE /api/learning/event/<id>` | Write | Hard delete |
| `GET /api/learning/stats` | Read | Aggregates for the Learning page: `success_patterns` (`by_success_type` + `disciplined_hold_stats` — holding-period days min/avg/max + avg return for `disciplined_hold` wins, min/max suppressed <n3), `phase8_meta`, `prompt_regression`, Wilson CI on all WR fields, `stop_tag_precision`, `by_sector`, `hold_outcomes`, `buy_vs_topup`, `real_vs_paper`, `capital_efficiency`, `ensemble_divergence`, `mae_mfe_summary` — all empty-safe |
| `GET /api/learning/calibration` | Read | Decay-weighted, shock-excluded calibration block, 5-min TTL. `?deep=1` for exemplars/playbook/cross-tabs |
| `GET /api/learning/calibration-stats` | Read | Brier score + reliability diagram; lazily snapshots one row/day |
| `GET /api/learning/calibration-trend` | Read | Brier history (last 180d) — is the loop actually learning? |
| `GET /api/learning/calibration-efficacy` | Read | Does the engine-side confidence nudge beat raw confidence (Brier comparison)? |
| `GET /api/learning/recent-rec?ticker=X` | Read | Most recent logged rec, any action — powers the whipsaw/contradiction check |
| `GET /api/learning/hold-recs?limit=N` | Read | Logged HOLD recs with `virtual_outcome` or `days_until_review` countdown — feeds the HOLD Decisions card (HOLDs never enter client rec state) |
| `GET /api/learning/driver-matrix` | Read | 3D cross-tab: entry driver × regime × sector (n≥3) |
| `GET /api/learning/factor-win-rates` | Read | Empirical IC per entry-signal factor |
| `GET /api/learning/lesson-effectiveness` | Read | Per-lesson WR before/after creation date |
| `GET /api/learning/lesson-source?n=100` | Read | Dataset for the manual AI Lesson Generator |
| `GET /api/learning/scrutiny-stats` | Read | Local-LLM scrutinize verdict track record |
| `GET /api/learning/go-live-readiness` | Read | Paper-validation scorecard: 5 friction-adjusted criteria (`n≥40`, regime coverage ≥3, calibration gap ≤7pp, edge survives `?friction_bps=N` haircut, ≥2 drivers with positive post-cost expectancy). Uses calibration gap, not Brier |
| `GET /api/learning/coverage` | Read | Per-capture fill rates + work queues (Capture Coverage card) |
| `GET /api/learning/digest-data` | Read | Structured failure data for the postmortem digest |
| `GET /api/learning/sell-outcomes` / `buy-outcomes` | Read | Per-trade decision trackers — see Decision Trackers above |
| `GET /api/learning/rule-override-efficacy` | Read | Per-rule-code cross-tab — see Rule Override Efficacy above |
| `GET /api/learning/lessons` / `POST` / `DELETE /lesson/<id>` | — | Scoped lesson CRUD |
| `GET /api/learning/thesis-drift` | Read | Manual vs target-hit exit P&L gap |
| `POST /api/learning/backfill-entry-drivers` | Write | Fills historical `primary_entry_driver` (no Claude spend) |
| `GET /api/learning/entry-context?tickers=A,B` | Read | Most recent BUY/TOP_UP per ticker for HOLDING_CONTEXT injection |
| `GET /api/learning/thesis-matrix` | Read | Entry-driver × thesis_verdict cross-tab |
| `GET /api/learning/trade-detail?ids=..` | Read | Per-trade detail for the Journal drawer |
| `GET /api/learning/stop-tag-precision` | Read | `stop_too_tight` counterfactual accuracy |
| `GET /api/learning/execution-alpha` | Read | Actual vs simulated mechanical exit P&L |
| `GET /api/learning/untagged` | Read | Loss/breakeven events missing `error_type` |
| `GET /api/learning/tag-reviews` / `POST /tag-review` | — | Manual spot-check of auto-tags |
| `GET /api/learning/tag-accuracy` | Read | Agree-rate gating the `top_err` nudge |
| `GET /api/learning/debate-stats` | Read | Per-pairing adversarial-debate breakdown |
| `GET /api/market/universe-health` | Read | ASX200 ticker health check via yfinance |
| `POST`/`DELETE /api/market/universe-exclude` | Write | Scanner/intraday exclusion list |
| `GET /api/debate/status` | Read | Ollama health check |
| `POST /api/debate` | Write | Bull/Bear debate (4h cache) |
| `POST /api/debate/postmortem` | Write | Single-model error_type tagger (manual) |
| `POST /api/debate/postmortem-debate` | Write | Adversarial two-model debate |
| `POST /api/debate/adjudicate` | Write | Cloud adjudicator (Gemini/Groq/Claude) |
| `GET /api/debate/adjudicator-status` | Read | Is a cloud adjudicator configured? |
| `POST /api/debate/staleness` | Write | Freshness check for pending recs ≥2d old |
| `POST /api/debate/skill` | Write | Score closed trade quality 0–10 (manual) |
| `GET /api/debate/calib-quality` | Read | Calibration quality debate (cached; `?force=1` bypasses) |
| `POST /api/debate/quick-analysis` | Write | Local-LLM portfolio analysis (Ollama, opt-in) |

---

## Learning Loop Display Page

Key sections, top to bottom: master date-window filter · summary cards (WR, high-conf WR, prompt version) · calibration accuracy table · Calibration Quality card (manual "▶ Run debate") · regime performance table · prompt version history + regression banner · **Success Patterns** (tag chips + win-rate bars, plus a Disciplined Hold duration/return line) · Failure Patterns · **HOLD Passivity Check** + **HOLD Decisions** (per-HOLD 30-day review) · **Sell** and **Buy/Top-Up Decision Trackers** (action badge, driver, holding period, regime, P&L, exit-quality/skill chips, expandable detail row, "↺ Check Now") · **Rule Override Efficacy** (🧪, per-rule closed/open/skipped counts + verdict + drill-down) · **Execution Alpha** · **Thesis Accuracy Matrix** · Lessons card · Auto-Tag Accuracy card · Recent Events table (error-tag chips, Claude-declared tags, 🤖/⚔️/📜/⚖️/🔬/✕ action buttons) · Debate Summaries + Debate Stats + Debate Engine card.

### Error Tag Reference

| Tag | Short | When | Calibration? |
|---|---|---|---|
| `overconfident` | OC | AI confidence too high for actual risk | ✅ |
| `missed_catalyst` | MC | Key event not accounted for | ✅ |
| `regime_mismatch` | RM | Wrong strategy for regime | ✅ |
| `poor_entry` | PE | Timing/price suboptimal | ✅ |
| `stop_too_tight` | ST | Shaken out by noise | ✅ |
| `poor_rr` | PR | R:R too low from the start | ✅ |
| `thesis_broken` | TB | Entry thesis invalidated post-entry | ✅ |
| `early_exit` | EE | Manual exit before MFE reached target | ✅ |
| `oversized`/`undersized` | OZ/UZ | Sizing bypass token | ✅ |
| `external_shock` | ES | Black swan / unpredictable event | ❌ Excluded |

`protective_stop` exit_reason is excluded from confidence-band calibration regardless of tags (deliberate capital protection), but contributes to error-pattern learning if it also carries an analytical tag.

---

## Internal Debate System (Ollama)

**Live:** bull/bear pre-analysis (4h signal-hash cache), direction-aware framing (BUY→bull/bear/neutral, SELL/TRIM→hold/exit/neutral), synthesizer `{winner, margin, key_pivot}`, single-model postmortem tagging (manual 🤖), adversarial two-model debate (⚔️, manual), entry staleness check, skill scoring (🔬, manual), Debate Engine config card (primary/opposition model, aggression, Test Debate).

### Stability rules
- Bull/bear calls run **sequentially** (avoid VRAM spikes); `keep_alive:"10m"`.
- `num_predict`: 180 synthesizer · 200 postmortem/staleness · 350 skill (longer reason string).
- `think:false` passed on every JSON call, suppressing thinking tokens before the budget is consumed.
- **`format_schema`** — all JSON-producing calls pass a JSON Schema via Ollama's `format` param; the engine constrains token selection at the grammar level. Cloud callers (Groq/Gemini/Claude) get schema guidance via prompt text instead.
- No retry on timeout — fail immediately, caller switches to a smaller model. Batch concurrency always 1.
- JS priority queue (`_oqEnqueue`) — HIGH lane for user-initiated calls, LOW lane for Learning-page batch calls; a running call is never interrupted, priority only affects queue insertion point.

### Model priority (Auto)
```
qwen3.5:9b → qwen3.5:4b → qwen3:9b → qwen3:8b → qwen3:4b → qwen3:0.6b
→ gemma4 → gemma3:4b → gemma3:2b → llama3.2:3b → phi4-mini
```
An explicit user preference overrides Auto while the model is pulled; otherwise falls back silently.

### Thinking-model compatibility
Reasoning models (qwen3.5, qwen3, some gemma4) emit `<think>…</think>` before output. `think:false` is the primary suppression; `_strip_think_tags()` is a safety net that also detects an unclosed tag (truncated mid-thought) and returns `""` for a clean error instead of a bad parse.

---

## Postmortem Classification — Prompt Design

Trade summary sent to the model: `{recommendation} {ticker} {outcome_status} | PnL={pct}% | hold={days}d | AI_conf={x} | RR={x} | entry/stop/target | exit={reason} | regime | sector`, plus (when available) `_flatten_entry_signals()` — a compact 12-field one-liner (`rsi=42.1 | macd_hist=-0.12 | bb%b=0.31 | ...`) instead of the raw ~40-field JSON blob, which wastes tokens and confuses small models. `recommendation` is listed first so direction isn't misread (a high SELL entry price is not "suboptimal").

Exit-reason hints are **factual only**, never tag suggestions — early versions hinting "consider stop_too_tight" caused templated pattern-matching instead of genuine analysis.

### Adversarial two-model debate (⚔️, manual only)
Three phases: (1) both models classify independently, sequentially (VRAM); (2) agreement check — SINGLETON (one parsed) / CONSENSUS (identical) / PARTIAL (overlap kept, conservative) / DIVERGED → phase 3; (3) **neutral synthesis** — a third model call reconciles both positions as a neutral adjudicator (not a "defend vs challenger" framing, which biased toward whichever model played challenger). Post-classification, `_pm_sanity_check_tags` strips logically inconsistent tags (e.g. `stop_too_tight` on a >15%-distance stop, `poor_rr` when `rr_ratio≥2.0`). Full transcript stored in `postmortem_debate`, reopenable via 📜.

### Cloud Adjudicator (⚖️, manual, only on rows with a stored debate)
Brings a larger cloud model (auto-detect Gemini→Groq→Claude) to score each local model's reasoning 0–10 and pick a winner (or `NEITHER`, proposing its own tags). **Blind** — models are aliased ("Analyst Alpha/Beta", randomly assigned) to avoid halo-effect bias toward a named model family; the swap is resolved after parsing. Output passes through the same `_pm_sanity_check_tags` pipeline as local models.

---

## Key Design Decisions

| Decision | Rationale |
|---|---|
| User message for calibration + debate | Preserves Anthropic's system-prompt cache |
| Exponential decay vs hard cutoff | Smooth fade, no artificial cliffs |
| `loss_quality` derived, not stored | Avoids a duplicate column already implied by `error_type`+`exit_reason` |
| ESS over raw count | Kish ESS correctly reflects a sample dominated by one fresh trade vs N stale ones |
| Wilson-CI gate + higher floors | Old thresholds fired nudges on samples too small to clear their own CI — sophisticated-looking math on noise |
| Deterministic tagging/scoring over local-LLM | A 2–9B model guessing skill-vs-luck from a one-line summary manufactures labels that then steer the live prompt; the entry/exit capture gives real before/after data instead |
| Skill weight centered at 5, not 10 | Old formula penalised all scored trades vs unscored; centering at 5 makes unscored ≡ average |
| Hierarchical regime fallback | A freshly-transitioned regime gets useful signal (macro group) instead of nothing |
| Confidence → Kelly binding, no second multiplier | `winProb: r.confidence` already transmits calibration into sizing; a second multiplier would double-discount |
| Postmortem/skill/calib-quality manual-only | Auto-triggering caused Ollama queue saturation during market hours |
| Phase 3 neutral synthesis over challenger model | A "defend vs challenger" framing biased toward whichever model played challenger, regardless of quality |
| Blind adjudication (aliases, not names) | Cloud models exhibit measurable halo-effect bias toward specific model names |
| Rule-override P&L from CLOSED trades only | An open BUY/TOP_UP realizes nothing until sold — attributing an outcome to it would be fabricated |
| Master date window, not per-card filters | Per-card pickers drift out of sync; a global window matches how a user actually thinks ("show me this quarter") |
| Date window excludes stat/aggregate cards | Win-rates and calibration need full history to carry statistical power |
| HOLD judged direction-aware + endpoint-based, vol-scaled | A HOLD keeps a long, so only a sustained downside matters — the naive |move|-anywhere-in-an-unbounded-window rule scored an 8% rally identically to an 8% drawdown and got noisier the longer resolution lagged |
| `_flatten_entry_signals()` for prompt injection | Raw JSON blob wastes ~200 tokens and confuses small models; 12 key fields in one line improves extraction accuracy |
| `format_schema` for Ollama JSON calls | Engine-level constraint eliminates the regex-fallback parser chain |

---

## Open Items

None outstanding — all planned phases (1–8), sprint improvements, and the current session's HOLD-tracking redesign are live. New work should append here rather than growing a historical changelog; use `git log` for what shipped when.
