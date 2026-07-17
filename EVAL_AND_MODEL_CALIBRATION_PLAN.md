# Eval Harness + Model-Aware Calibration — Implementation Plan

**Status:** plan only (2026-07-17). Written for an implementing agent. Nothing here is built yet.
**Why now:** ~6 months from a real-money go-live, with the learning loop as the validation
instrument (n≈28 closed, calibration activates at n≥30). Two structural risks make the go-live
number less trustworthy than it looks:
1. **Model drift is silent.** Recent portfolio runs used `claude-sonnet-5` then `claude-opus-4-8`
   while docs say `claude-sonnet-4-6`. `ai_learning_events` has **no model column** — so calibration
   and the go-live scorecard blend the track records of different models into one figure.
2. **The only regression signal is the 30-day outcome loop.** 13 prompt versions shipped
   undocumented (v11 → v24). A bad prompt/model change isn't caught until trades close.

The two features below address these directly. They are independent — ship either first.

---

## Part A — Eval Harness (fast regression feedback)

### Goal
Replace "find out 30 days later that a change regressed" with "find out in seconds." A frozen set
of real portfolio inputs + expected behaviors, run against every prompt or model change.

### Two layers (build Layer 1 first — it's free and catches most regressions)

> **✅ Layer 1 IMPLEMENTED 2026-07-17.** `tests/eval/eval.test.js` + `tests/eval/fixtures/`
> (bootstrapped from `ai_call_log` id=39 — the CBA `risk_management`+`peer_outperformance`
> mis-tag run), `tests/eval/README.md`, and `npm run eval`. Auto-collected into `npm run test:js`
> (260 JS tests). Asserts: parse shape, structural usability, no duplicate actionable tickers,
> validator flags the mis-tagged rec, HOLDs never dropped, panic hard-blocks BUYs, no qty=0 leak.
> Uses the engine globals `setup.js` already loads — no `runAnalysis()` refactor needed. Grow by
> dropping a JSON fixture in `fixtures/`. **Layer 2 (live-model) not yet built.**

**Layer 1 — deterministic pipeline checks (no API cost, run every commit)**
Freezes `raw model output → post-processing → final recs` and asserts the *deterministic* layers
behave. This is where the quant engine, validator, regime gate, dedup, and sizing live — all pure
functions already unit-tested in isolation, but never tested end-to-end on realistic whole-book
inputs.
- **Harness:** piggyback the existing Vitest infra (`tests/setup.js` already loads browser-global
  scripts via `vm.runInThisContext` in load order). Add `tests/eval/` with fixtures + a runner
  test file.
- **Fixtures:** each is `{ input: <frozen state snapshot>, rawResponse: <frozen model JSON>,
  expect: <assertions> }`. Bootstrap directly from `ai_call_log` — it already stores
  `system_prompt`, `user_message`, and `response_text` for every real run. Pick ~15 representative
  logged calls (different regimes, a panic case, a SELL/TRIM case, a mis-tag case like the CBA
  `risk_management`+`peer_outperformance` run) and snapshot them.
- **Assertions (examples):**
  - Panic regime → zero BUY/TOP_UP recs survive (`_regimeBlocked`).
  - A `risk_management` SELL/TRIM without `sector_concentration`/`position_oversized` → carries
    `_ruleWarnings` (validator flag fired).
  - `qty` on every surviving actionable rec ≥ 1 (quant engine sized it; Rule-4 zero didn't leak).
  - Kelly ≤ 0 rec → dropped or fallback-sized, never silently qty=0.
  - CHANGES block has no duplicate ticker lines (the fix just shipped — lock it in).
  - Schema/validator: every surviving rec passes `validateRec`.

**Layer 2 — live-model behavioral checks (costs API, manual gate before shipping a change)**
Freezes `input context → model → output` and asserts *behavioral* properties + diffs against a
stored baseline. This is what actually catches "the new prompt/model got worse."
- **Harness:** a standalone script (`eval/run_live.py` or a Node script) that POSTs each frozen
  `user_message` + current system prompt to the API at the current production model, then runs the
  same assertion set as Layer 1 **plus** behavioral ones that require real generation:
  - Panic input → model emits no BUYs (not just that post-processing drops them).
  - An overvalued-holding-with-sell-target input → model produces a TRIM/SELL or an explicit flag,
    not a complacent HOLD.
  - Every BUY/TOP_UP has ≥3 `[FUNDAMENTAL]`/`[MACRO]` factors (Rule 1C / factor_thin).
  - Output parses and passes the validator (catches prompt changes that break JSON shape).
- **Baseline diff:** store the last-approved run's output per fixture; on a new prompt/model, show a
  semantic diff (action changes, confidence deltas, dropped/added recs) for human sign-off. This is
  the "did v25 quietly change behavior" check.
- **When to run:** before bumping `PROMPT_VERSION`, before adopting a new model, and on demand.
  Not in CI (costs money, non-deterministic).

### Deliverables
- `tests/eval/fixtures/*.json` (~15 bootstrapped from `ai_call_log`)
- `tests/eval/eval.test.js` (Layer 1, runs under `npm run test:js`)
- `eval/run_live.py` + `eval/baselines/*.json` (Layer 2, manual)
- `npm run eval` script alias; a short `eval/README.md` on how to add a fixture

### Non-goals (keep it from sprawling)
- No scoring rubric / grade. Assertions pass or fail — binary.
- No auto-generation of expected outputs. Assertions are hand-written invariants, not "match the
  golden string" (which would break on every legitimate wording change).
- Start at ~15 fixtures, grow only when a real regression slips through that a fixture would've caught.

---

## Part B — Model-Aware Calibration  ✅ IMPLEMENTED 2026-07-17

Shipped: `model` column on `ai_learning_events` (`db.py` migration); `callClaude` returns
`usage.model` (cloud path); `analysis.js` captures + forwards it via `logRecsToLearningLoop`;
`learning_log()` persists it; `POST /api/learning/backfill-models` (dry-run default) recovers the
model on pre-feature rows from `ai_call_log`; go-live scorecard returns a `model_mix` honesty note
(rendered amber on the 🎯 card when >1 model); `/api/learning/stats` returns `by_model`. Step 3
(model as a `_calib_compute` segmentation dimension) deliberately deferred until per-model n clears
the nudge floors — capturing + surfacing first, splitting later. Prompt-version history was KEPT
(not replaced) — a regression can come from either prompt or model, and you need to tell them apart.

### Design principle
At n≈28, **model-aware ≠ model-segmented**. Splitting calibration by model now would shrink each
bucket below the statistical gates (`_MIN_NUDGE_N=12`, `ESS_MIN=6.0`) and produce noise. So:
**capture the model on every event now, surface the model mix in the go-live scorecard now, and
only enable model-segmented calibration once per-model n is large enough.** The immediate win is
*honesty* about the sample, not slicing it.

### Step 1 — capture the model (DB + write path)
1. **DB migration** (`db.py`): add `model` to the `_LE_MIGRATIONS` list —
   `("model", "TEXT")`. Idempotent ALTER, same pattern as every other learning-event column.
2. **Expose the model from `callClaude`** (`js/claude-client.js`): the cloud path resolves `model`
   (line ~319) but only uses it for `ai_call_log` logging — add it to the return value's `usage`
   so callers can read it: `return { text: responseText, usage: { ...usage, model } }`. (The local
   path already returns `usage.model`, so this makes both paths symmetric.)
3. **Pass it through** (`js/analysis.js`): capture `_usage.model` from the `callClaude('portfolio', …)`
   result and store it alongside `prompt_version` when calling `logRecsToLearningLoop()`; add
   `model:` to the POST payload it builds (~line 2442, next to `prompt_version: pv`).
4. **Persist it** (`routes/learning.py`, `learning_log()` INSERT ~line 1083): add `model` to the
   column list, the `VALUES` placeholders, and `data.get("model")` to the tuple.
5. **Backfill existing rows:** the 40 closed events pre-date the column. `ai_call_log` stores the
   real model per call — approximate-join on `(agent_type='portfolio', timestamp)` nearest-match to
   set `model` on historical events; anything unmatched stays `NULL` and is treated as
   `'unknown/legacy'`. One-shot script, dry-run first (mirror the `backfill-modes` pattern).

### Step 2 — surface the model mix (go-live scorecard)
In `_compute_go_live_readiness` (`routes/learning.py`), add a **sample-homogeneity signal** (not a
hard gate): count distinct models across the closed trades feeding the scorecard. If >1, add a
visible note to the 🎯 card — e.g. *"Track record spans 2 models (opus-4-8: 18, sonnet-5: 10) —
edge estimate blends them."* This is the single most important change: it makes the go-live number
*honest* about what it's measuring without needing more data.

### Step 3 — model-segmented stats (only once n permits)
Add `model` as an optional segmentation dimension in `_calib_compute` (alongside the existing
regime/sector params), gated behind the same `_MIN_NUDGE_N`/`ESS_MIN` floors so a thin per-model
bucket silently falls back to the pooled prior. Also add a per-model row to the Learning-page stats
(win rate + Wilson CI per model) so you can *see* whether models differ before trusting any split.
Ship this last; it's inert until per-model samples are large enough.

### Deliverables
- `db.py`: one `_LE_MIGRATIONS` entry
- `js/claude-client.js`: expose `usage.model` on the cloud path
- `js/analysis.js`: capture + forward the model
- `routes/learning.py`: INSERT column; scorecard homogeneity note; (later) `_calib_compute` segment
- `routes/*` backfill endpoint + one-shot run
- `test_app.py`: assert the new column round-trips; assert scorecard note fires on mixed-model data

---

## Part C — Future models & obsolescence (strategy)

**Yes, old model IDs go obsolete.** Anthropic publishes deprecation and retirement dates; a pinned
model ID will eventually stop serving. So `CLAUDE_MODEL = 'claude-sonnet-4-6'` hardcoded in
`claude-client.js` is a latent maintenance liability — not urgent, but plan for it.

**The governing idea:** treat the model as part of the *system version*, alongside `PROMPT_VERSION`.
Your calibration validates a **(prompt × model × quant engine)** tuple, not a prompt in the
abstract. When the model changes materially, part of your track record resets — exactly like a
prompt bump. So:

1. **Pin the production model explicitly.** Stop the silent run-to-run drift (sonnet-5 → opus-4-8
   this session). Set `state.settings.analysisModel` deliberately and treat changing it as an event,
   not a default. Keep `CLAUDE_MODEL` as the fallback only.
2. **A new release is not a reason to switch.** A validated, calibrated model is worth more than a
   newer un-validated one. Upgrade only when (a) your current model is being retired, or (b) the
   eval harness (Part A, Layer 2) shows a clear behavioral improvement worth re-validating for.
3. **The eval harness is your migration safety net.** When you *are* forced to move (retirement) or
   *choose* to (better model), run Layer 2 against the new model first: behavioral assertions + diff
   vs the current baseline. This turns "discover the new model behaves differently over 30 days of
   live trades" into "confirm it matches expectations in minutes." This is the main reason Part A
   is worth building before you ever need it.
4. **Per-model track records make forced migrations survivable.** With Part B capturing the model,
   a retirement means you switch to a model whose *eval-set* behavior you've verified, even if you
   don't yet have *live* calibration for it — and the scorecard honestly shows the new segment
   starting fresh rather than pretending the old model's edge carries over.
5. **Keep the model a config value, never a code constant in call sites.** A retirement should be a
   settings change + an eval-harness run, not a code hunt.

**Net:** obsolescence is a *managed* event, not a threat, once (a) the model is captured per event,
(b) the scorecard is honest about model mix, and (c) the eval harness can validate a replacement in
minutes. Build those three and future model churn costs you an afternoon each, not a re-validation
from zero.
