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
**Status:** Resolved (2026-07-06) — backfill has been run (0/24 closed events now missing `primary_entry_driver`, was 23/24), and `syncClosedTradesToLearningLoop()` now fires the endpoint (fire-and-forget, idempotent) at the end of every sync so the column can't silently rot again.

One `POST /api/learning/backfill-entry-drivers` call fills `primary_entry_driver` on historical rows from stored entry signals. Today 23/24 closed events lack it, which empties three whole analytics surfaces (driver × regime × sector matrix, driver × thesis matrix, capital-efficiency-by-driver) and starves `computeThesisDrift()`'s entry context. Suggest: invoke it once now, then call it opportunistically at the end of `syncClosedTradesToLearningLoop()` (idempotent, cheap) so it can never silently rot again.

### 2. Seed the lessons loop from the postmortem digest
**Files:** Learning page digest flow, `POST /api/learning/lessons`
**Status:** Resolved (verified 2026-07-06 — already shipped as the **AI Lesson Generator** card on the Learning page: `generateTradingLessons()` pulls `GET /api/learning/lesson-source` + macro history + local-critic track record, asks Claude for 3–6 one-sentence scoped lessons as JSON, validates scopes, and persists each via `POST /api/learning/lessons` with `source:'ai_digest'`.) The table is empty only because the button has never been clicked — **user action: Learning page → AI Lesson Generator → Generate Lessons** (works at the current n=24 closed).

The entire lesson life-cycle (scoped injection into prompts, before/after effectiveness scoring, `⚠LESSON_DRAG` nudge) is built and tested but has zero rows. The AI Postmortem Digest already produces exactly the material lessons need. Add a per-insight "save as lesson" button on digest output (pre-filled ticker/sector/regime scope) so lessons accrue as a by-product of a monthly ritual the scheduler already reminds about, rather than requiring free-form manual entry nobody does.

### 3. Learning-loop coverage panel ("data hygiene at a glance")
**Files:** `js/pages/learning.js`
**Status:** Resolved (2026-07-06) — new `GET /api/learning/coverage` (read-only COUNT queries, no resolvers triggered) + "🧹 Capture Coverage" strip at the top of the Learning page: per-capture fill rates (error tags, win tags, entry driver, thesis verdict, MAE/MFE, exit signals — green ≥80% / amber ≥50% / red below; `pct=None` when the eligible population is empty so an empty denominator never reads as a 0% alarm) and work-queue chips (stuck-open >60d, virtual pending with days-until-eligible, HOLD resolved, lessons). Each cell's tooltip names the fixing action. Tests in `TestLearningCoverage`.

The starvation gaps above were only findable by SQL. Add a small coverage strip to the Learning page: % of closed events with error_type / driver / thesis_verdict / MAE-MFE / exit_signals, count of events stuck `open` >60d, and days until virtual-outcome eligibility. Each cell links to the fixing action (backfill endpoint, untagged list, sync button). This turns silent decay into a visible checklist.

### 4. Grade paper trades against real-fill friction in day-trade ML
**Files:** `day_trade_db.py`, `routes/day_trade_training.py`, `js/dt-training.js`
**Status:** Resolved (2026-07-06) — `trade_mode` column added to `trade_snapshots` (migration); captured on snapshot save (`dtSaveSnapshot` sends the position's mode; only explicit `real`/`paper` stored, else NULL); and the Ridge training now applies a per-row `sample_weight` — paper rows 0.5×, real/legacy(NULL) 1.0× — threaded through both the final fit and every walk-forward/holdout fold. `_ridge_regression()` was lifted to module scope so the weighting is unit-tested directly: **uniform weights are bit-identical to the old unweighted fit** (proven — so the current all-real/legacy corpus is completely unchanged; the down-weighting is dormant until paper day-trades are tagged), and down-weighting a divergent group provably pulls the fit toward the up-weighted group. `n_paper` surfaced per model in the train response. Tests in `TestDayTradeTraining`.

### 5. Surface save failures (non-409) to the user
**Files:** `js/api.js` (`saveStateToDb`)
**Status:** Resolved — `saveStateToDb()` tracks consecutive failures; a single transient failure stays silent, ≥2 in a row fires a red toast ("Changes are NOT being saved…"), and recovery fires a success toast. Non-409 non-OK responses (e.g. a 500) now escalate instead of being swallowed.

`saveStateToDb()` swallows every non-409 failure silently, which is how FIXES.md #2 (every save failing on a UNIQUE violation) could go unnoticed indefinitely. One-shot toast + a persistent "unsaved changes" indicator when ≥2 consecutive saves fail. Keep the silent path for transient single failures.

### 6. Mode filter completeness sweep on remaining aggregations
**Files:** `js/pages/dashboard.js`, `js/pages/performance.js`, `js/portfolio-helpers.js`
**Status:** Resolved (2026-07-06; Telegram out of scope per user) — swept all peripheral consumers against gotcha #88's surface list:
- **Dashboard** — already mode-aware (routes through `mergedPortfolio()`/`viewCash()`/`paperPortfolioValue()`, driven by `portfolioViewMode`). No change needed.
- **Critical-alert engine** — made multi-book aware in FIXES #7.
- **Performance drawdown** (the one real gap) — the drawdown alert banner and the Current/Max Drawdown metric cards are computed from real NAV (`netWorth`) but were rendering in **all** views including Paper, mixing a real-money drawdown in with paper P&L. Now gated on `vm !== 'paper'` (`_showDd`), matching how the equity curve was already hidden in Paper view.
- **Telegram** — out of scope (user opted out).

### 7. Paper book reset button
**Files:** `js/pages/settings.js` / portfolio page
**Status:** Resolved (2026-07-06) — `resetPaperBook()` in `js/utils.js` + a "Reset paper book" card in Settings (`resetPaperBookUI()`, preview-then-confirm). It removes explicit-`mode==='paper'` rows from portfolio/parcels/journal/disposals/recHistory, drops day-trade & intraday positions linked to a removed paper parcel (or explicitly paper), clears each snapshot's `paperValue` (real NAV fields untouched), and restores `paperCash` to `paperStartCash`. **Real-safety invariant:** the delete predicate is explicit-paper, NOT `isRealTrade` — a *missing* mode is ambiguous (possible un-backfilled real history) and is preserved, so no real or untagged row is ever deleted. Proven by 4 vitest cases in `paper-real-firewall.test.js` (real + untagged survive; linked positions drop; cash restored; real cash untouched); source-guard in `TestPaperBookReset`.

### 8. Test coverage for the firewall's persistence boundary
**Files:** `test_app.py`, `tests/paper-real-firewall.test.js`
**Status:** Open — companion to FIXES.md #1/#2

The existing firewall vitest suite covers in-memory invariants (`isRealTrade`, cash routing, parcel scoping) but nothing crosses the client↔server persistence boundary, which is exactly where the real/paper distinction was lost. Add: (a) Python round-trip test — save a dual-mode ticker, load, assert both rows and their modes survive; (b) vitest — `_validHolding` preserves `mode`; (c) Python test — EOFY pack contains real disposals after a mixed-mode save.

### 9. Go-live readiness scorecard
**Files:** `routes/learning.py` (`_compute_go_live_readiness`, `GET /api/learning/go-live-readiness`), `js/pages/learning.js` (`renderGoLiveCard`)
**Status:** Resolved (2026-07-06) — the user is running a ≥6-month paper validation before funding live trading; this turns "is the model capable?" into an objective 🎯 Go-Live Readiness card (top of the Learning page). Five friction-adjusted criteria → `ready`/`almost`/`not_ready`:
1. **Sample size** ≥40 closed (warn ≥20).
2. **Regime coverage** ≥3 distinct regimes (an edge in one regime isn't proven).
3. **Calibration honesty** — `|mean stated confidence − actual win rate| ≤ 7pp`. Deliberately NOT Brier: Brier's irreducible `p(1−p)` floor (a perfectly honest 65%-win model scores 0.2275) makes a <0.20 bar unachievable and would punish honesty. The gap is 0 exactly when confidence matches reality — which is what feeds Kelly sizing.
4. **Edge survives friction** — each trade's P&L haircut `?friction_bps` (default 30 = 0.30% round-trip, since paper fills are frictionless), then the Wilson 95% CI lower bound of the win rate must exceed the payoff-ratio break-even. Catches a marginal edge that only exists because paper ignores spread/slippage.
5. **Profitable entry archetypes** — ≥2 `primary_entry_driver`s with positive post-cost expectancy at n≥5 each.

Thresholds are module constants (`_GOLIVE_*`), tunable. Verified against the live DB: currently `almost` (2/5) — calibration honesty already passes (65.4% stated vs 62.5% actual, 2.9pp gap) and the edge passes after friction; sample size, regime coverage, and per-driver n are the gaps that 6 months of paper trading will fill. Tests in `TestGoLiveReadiness` (strong record → ready; negative edge → fail; friction flips a marginal edge; single regime → fail).

### 10. Realistic paper fills
**Files:** `js/utils.js` (`paperFillPrice`, `_advSlippageRate`), `js/pages/recommendations.js` (`markExecuted`), `js/pages/settings.js`, `js/pages/learning.js`
**Status:** Resolved (2026-07-06) — so the paper book fills like the market will, not at a frictionless target. On execution of an AI rec, a **paper** fill is slipped adversely (BUY/TOP_UP pays up, SELL/TRIM receives down) by the **same model the backtester and virtual-outcome resolvers already use**: ADV-tier one-way rate (0.05–0.35% by 20-day turnover) × regime multiplier (highVol 1.5×, riskOff 1.25×, panic 2×). Everything downstream — cost basis, journal, P&L, learning-loop `realized_pnl_pct` — then reflects real friction. **Firewall-safe:** gated on `!isRealTrade(mode)`, so a real trade always books at the price the user actually got; a cross-language parity test (`TestRealisticPaperFills`) pins the JS tiers/multipliers to `core.adv_slippage` + `_SLIP_REGIME_MULT`. Toggle in Settings → Paper trading (`paperRealisticFills`, **default on**); a toast discloses the modeled slippage on each fill. The go-live scorecard reads the setting and passes `friction_bps=0` when it's on, so friction isn't double-counted (the P&L already contains it). **Scope:** the AI-rec execution path (`markExecuted`) — where validation trades enter/exit. Manual journal entries (user asserts their own fill) and the separate day-trade subsystem are intentionally not slipped; extend later if wanted. 5 vitest cases (adverse direction, ADV tiers, regime widening, invalid-input passthrough, backend parity).

---

# Audit 2026-07-08 — Claude API prompts + Learning Loop: enhancements

Companion to the same-dated section in `FIXES.md` (defects live there). Overall verdict first, then itemised improvements.

## Verdict — what is working well

**Claude API pipeline:** architecturally strong. The static-system-prompt / dynamic-user-message split preserves prompt-cache hits; forced tool use (§8.5) eliminates the malformed-JSON class for the portfolio agent; every quantitative decision (Kelly sizing, stops, EV, calibration nudges, correlation, heat budget) is engine-side and deterministic, with Claude scoped to conviction/direction/tagging only — this is the correct division of labour and it is consistently enforced in post-processing. Logging (`ai_call_log`), retry/backoff, key hygiene, and the flag-don't-drop validator philosophy are all sound.

**Learning Loop:** the statistical hygiene is genuinely above average for a system like this — Kish ESS floors, Wilson-CI gates, Mann-Whitney-gated skill weighting, decay half-lives keyed to regime, paper down-weighting that provably cancels in pure-paper phases, self-suppressing tags (`stop_too_tight` counterfactual precision), and a priority-ordered token budget with machine-readable adjustments computed independently of the truncated text. The n<30 base-rate prior is a nice touch. The main weaknesses are *feed starvation* (some resolvers structurally receive no data — FIXES #8) and a few direction/consistency bugs (FIXES #9, #11), not the statistics.

## Improvements

### I-1. Delete or wire the dead 3-phase pipeline (`ANALYST_SYSTEM_PROMPT`, `PM_SYSTEM_PROMPT`)

`callClaude('analyst', …)` and `callClaude('pm', …)` have zero call sites — the "Phase 1/3" prompts in `js/prompts.js` (~:746-828) and their `_AGENT_MAX_TOKENS`/`_resolveSystemPrompt` entries are dead code. The PM prompt has also drifted: its `scenarios` shape is `[{"label","prob","outcome"}]` (array) vs the main schema's `{bull,base,bear}` object, and it tells the model to emit computed `qty`/`evNet` (contradicting the Rule-4 architecture). Either wire the pipeline or delete the prompts; if kept for future use, align the shapes now so the drift doesn't calcify.

### I-2. Forced tool use for the macro agent

Macro's `maxTokens` was raised 1800→3000 after a truncation-mid-string JSON failure. A `tool_choice`-forced `emit_macro_brief` tool (same pattern as §8.5) removes the parse-failure class entirely; macro already runs `noCache` once daily so there is no cache-stability concern. Low effort, kills a known recurring failure mode.

### I-3. Log `scenarios` probabilities to the learning loop

`logRecsToLearningLoop()` drops the `scenarios` object (bull/base/bear p+ret) at log time. Persisting it (one JSON column or riding `market_context`) would let calibration score the model's *probability distribution* (e.g. did bear cases hit at ~bear-p frequency?) instead of only the scalar confidence — a materially richer Brier/calibration signal for near-zero cost.

### I-4. Grade the macro agent

The morning macro brief emits `sentiment`, `sentimentConf`, `bullish` daily, but nothing ever scores it. A tiny resolver (compare against next-day ASX200 return, log to `calibration_snapshots`-style table) would close the loop on the second-most-important AI call in the app and reveal whether the `bullish < 35` Rule-12 BUY-blocker threshold is calibrated.

### I-5. Consolidate redundant/overlapping prompt rules

`ANALYSIS_SYSTEM_PROMPT` restates the same constraints in multiple places: Rules 17 and 19 both say Sharpe is backward-looking/never standalone; Rule 4's "qty=0" is re-explained inside Rules 15, 16, the field spec, and the ACTION DEFINITIONS. Caching makes tokens cheap, but duplicated rules with slightly different wording create ambiguity about which variant is authoritative (Rule 3 says "Stop-loss at stopAtrMultiple×ATR" while Rule 16 references "1.5×ATR" in the HIGH-DD note). One consolidation pass + `PROMPT_VERSION` bump; the calibration-trend chart will show whether compliance improves.

### I-6. Stale comments / cosmetic drift (batch fix)

- `js/claude-client.js` `_AGENT_MAX_TOKENS.portfolio` comment says "8000 → 10000" but the value is 12000.
- `routes/learning.py` §7 comment says "ESS≥2.5" but the code gates on `_ESS_MIN` (6.0).
- `routes/learning.py:4385` `overall_wr = _wwr(calib_rows) if "overall_wr" not in dir() else overall_wr` — fragile `dir()` idiom; assign unconditionally.
- `routes/learning.py` sell-tag exclusion list includes `'position_sizing'`, which is not in the nine-driver taxonomy (harmless, but signals drift).
- `js/analysis.js` NEWS SIGNALS header says "last 2d" but `fetchNews()` requests `days=3`; `fetchNews()` also builds its ticker list from unfiltered `mergedPortfolio()` while the analysis itself excludes `'trading'`-account holdings.

### I-7. Day-trade prompts still have the AI doing sizing arithmetic

`getDayTradeSystemPrompt()`/`getDayTradeUniverseScanPrompt()` instruct the model to compute `qty = floor(riskPerTrade / (2.5 × atr_14))` — the exact arithmetic-in-LLM pattern the portfolio path eliminated. `buildDtSystemArray()`'s comment notes the DT Claude path is currently dormant (scans are quantitative-only), so this is not live risk — but if the path is reactivated, route DT recs through `computeTradeParams()` and set qty=0 in the prompt, same as portfolio. Flag it in the prompt file header so reactivation doesn't ship the old pattern.

### I-8. Consider a symmetric per-ticker nudge

`_calib_compute` §7 applies per-ticker adjustments penalty-only (−0.10 on ⚠weak). That matches the documented rule, but a capped positive nudge (+0.05 at ✓strong, same ESS/delta gates) would make the per-ticker memory two-sided like the band nudges (which allow up to +0.10). Optional — the asymmetry may be a deliberate conservatism choice; if so, document it next to the band logic.

### I-9. Retry budget for 529s is small

`callClaude()`'s total backoff is ~7s across 4 attempts. Anthropic 529 (overloaded) bursts often outlast that. Consider a longer final delay (e.g. 0/1/4/15s) + jitter for the portfolio agent specifically — it is a user-initiated, once-per-run call where an extra 15s beats a failed analysis.
