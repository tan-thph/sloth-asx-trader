# Improvements — Paper/Real Firewall + Learning Loop Audit (2026-07-03)

Companion to `FIXES.md` (same audit — defects live there, enhancements live here). Verified against source and the live `asx_trader.db`. Baseline: 865 Python + 183 JS tests green.

Prior improvements audit (2026-06-23, all 12 findings resolved) is preserved in git history at `c81ebe9`.

---

## Learning Loop — state of the nation

The user asked "what is working and what is not". Assessment from the live data (41 events, 24 closed with outcomes, 15W/9L):

### Working ✅

| Capability | Evidence |
|---|---|
| Rec logging at generation | 41 events with 100% coverage of entry_signals_json, sector, regime; bull/bear cases captured |
| Outcome grading on close | 24 closed events with realized P&L (AUD + %), exit_reason, per-parcel blended entry price; SELL/TRIM get immediate outcomes |
| Deterministic post-mortem tagging (Sprint 70) | Recent losses carry `error_type` with `error_type_source='auto'` (`regime_mismatch`, `thesis_broken`, `none`) — firing correctly on new closes |
| Deterministic success tags | Newer wins carry `success_tags` (`regime_aligned`, `disciplined_hold`, `catalyst_capture`…) |
| Daily calibration snapshots | 5 snapshots, Brier 0.246 @ n=24, prompt_version stamped — trend endpoint has data |
| Paper down-weighting math | The uniform 0.5× paper multiplier provably cancels out of Kish ESS and weighted-WR during a pure-paper phase (verified the docstring's claim) — calibration is not degraded by the current all-paper data |
| Statistical gating | ESS_MIN=6.0 / MIN_NUDGE_N=12 / Wilson gates mean no spurious nudges are being injected at current n |
| Data durability | `ai_learning_events` + `ai_call_log` are outside the version-guarded bulk state save — the 2026-07-03 stale-tab incident could not have touched them |

### Not working / starved ⚠️

| Gap | Root cause | Action |
|---|---|---|
| HOLD outcome tracking **dead** | HOLDs filtered before logging | **Defect — FIXES.md #4** |
| Calibration serves base-rate prior only | n=24 closed < 30 threshold | Not a bug. ~6 more closed trades activates real calibration; set expectations accordingly |
| `primary_entry_driver` NULL on 23/24 closed events | Backfill endpoint `POST /api/learning/backfill-entry-drivers` exists but has never been invoked | **Improvement #1 below** — driver-matrix, thesis-matrix, capital_efficiency analytics are all empty because of this one gap |
| `thesis_verdict` NULL on 20/24 | Only propagates via the SELL-rec `_thesisCheck` path, which needs entry context (driver) to exist — starved by the same driver gap | Largely self-heals after improvement #1 + more closes |
| Virtual outcomes all NULL (9 skipped events) | **By design** — 30-day age gate before resolution; oldest skipped event is 7 days old | No action; first resolutions ~26-07-2026 |
| MAE/MFE NULL on 23/24 | Only closed BUY/TOP_UP qualify (most closes are SELL/TRIM); resolver caps 5/call | No action; fills lazily as BUY/TOP_UPs close |
| 5 pre-Sprint-70 losses untagged | Deterministic tagger only covers rows with entry/exit capture | Surface via `/api/learning/untagged`, tag manually (🔍 button) |
| Lessons machinery fully dormant | `trading_lessons` table has 0 rows — injection, effectiveness scoring, `⚠LESSON_DRAG` all no-op | **Improvement #2** |
| `real_vs_paper` stat degenerate | All 41 events `trade_mode='paper'` (see FIXES.md #3) | Heals with the legacy-mode migration |
| skill_score on 1/24 | Manual-only by design (🔬 button) | Working as intended |

**Bottom line:** the pipeline plumbing (log → outcome → resolvers → calibration) is sound and the capture quality is excellent. What's missing is almost entirely *data*: one dead input (HOLD), one never-run backfill (entry drivers), and a corpus that's still below the statistical activation thresholds. The loop will not visibly "do" anything to prompts until n≥30 closed — that is intended behaviour, not breakage.

---

## Improvements

### 1. Run (and then automate) the entry-driver backfill
**Files:** `routes/learning.py` (`/api/learning/backfill-entry-drivers`), Learning page
**Status:** Open

One `POST /api/learning/backfill-entry-drivers` call fills `primary_entry_driver` on historical rows from stored entry signals. Today 23/24 closed events lack it, which empties three whole analytics surfaces (driver × regime × sector matrix, driver × thesis matrix, capital-efficiency-by-driver) and starves `computeThesisDrift()`'s entry context. Suggest: invoke it once now, then call it opportunistically at the end of `syncClosedTradesToLearningLoop()` (idempotent, cheap) so it can never silently rot again.

### 2. Seed the lessons loop from the postmortem digest
**Files:** Learning page digest flow, `POST /api/learning/lessons`
**Status:** Open

The entire lesson life-cycle (scoped injection into prompts, before/after effectiveness scoring, `⚠LESSON_DRAG` nudge) is built and tested but has zero rows. The AI Postmortem Digest already produces exactly the material lessons need. Add a per-insight "save as lesson" button on digest output (pre-filled ticker/sector/regime scope) so lessons accrue as a by-product of a monthly ritual the scheduler already reminds about, rather than requiring free-form manual entry nobody does.

### 3. Learning-loop coverage panel ("data hygiene at a glance")
**Files:** `js/pages/learning.js`
**Status:** Open

The starvation gaps above were only findable by SQL. Add a small coverage strip to the Learning page: % of closed events with error_type / driver / thesis_verdict / MAE-MFE / exit_signals, count of events stuck `open` >60d, and days until virtual-outcome eligibility. Each cell links to the fixing action (backfill endpoint, untagged list, sync button). This turns silent decay into a visible checklist.

### 4. Grade paper trades against real-fill friction in day-trade ML
**Files:** `day_trade_db.py`, `routes/day_trade_training.py`
**Status:** Open

Day-trade training snapshots don't record trade mode; paper fills (perfect price, zero slippage) train the Ridge models with the same weight as real fills. Once real day-trades exist, add `trade_mode` to snapshots and either down-weight paper rows (as `_calib_compute` already does with 0.5×) or add it as a feature. Low priority until real day-trade volume exists.

### 5. Surface save failures (non-409) to the user
**Files:** `js/api.js` (`saveStateToDb`)
**Status:** Resolved — `saveStateToDb()` tracks consecutive failures; a single transient failure stays silent, ≥2 in a row fires a red toast ("Changes are NOT being saved…"), and recovery fires a success toast. Non-409 non-OK responses (e.g. a 500) now escalate instead of being swallowed.

`saveStateToDb()` swallows every non-409 failure silently, which is how FIXES.md #2 (every save failing on a UNIQUE violation) could go unnoticed indefinitely. One-shot toast + a persistent "unsaved changes" indicator when ≥2 consecutive saves fail. Keep the silent path for transient single failures.

### 6. Mode filter completeness sweep on remaining aggregations
**Files:** `js/pages/dashboard.js`, `js/scheduler.js` (drawdown monitor), `js/alerts.js`
**Status:** Open

The core paths (portfolio, CGT, journal, performance, NAV, charts) are correctly mode-aware. A few peripheral consumers still aggregate mode-blind: critical-alert engine (FIXES.md #7), drawdown alert (reads NAV — real-only, fine — but verify the alert copy when paper view is active), and Telegram alert payloads. Do a one-pass sweep with a checklist against gotcha #88's surface list after the FIXES.md #1–#3 migration lands, since some of these are currently masked by the all-paper data.

### 7. Paper book reset button
**Files:** `js/pages/settings.js` / portfolio page
**Status:** Open

Paper trading exists to experiment, but there's no way to wipe the paper book (close paper parcels/journal rows, restore `paperCash` to `paperStartCash`) without touching real data. A "Reset paper book" action with a confirm dialog makes the sandbox actually reusable — and is itself a good end-to-end test of the firewall (it must provably delete zero real rows; assert via `isRealTrade` filter and add a vitest).

### 8. Test coverage for the firewall's persistence boundary
**Files:** `test_app.py`, `tests/paper-real-firewall.test.js`
**Status:** Open — companion to FIXES.md #1/#2

The existing firewall vitest suite covers in-memory invariants (`isRealTrade`, cash routing, parcel scoping) but nothing crosses the client↔server persistence boundary, which is exactly where the real/paper distinction was lost. Add: (a) Python round-trip test — save a dual-mode ticker, load, assert both rows and their modes survive; (b) vitest — `_validHolding` preserves `mode`; (c) Python test — EOFY pack contains real disposals after a mixed-mode save.
