# SCORING_FIXES.md — Impact-score rubric fixes (News Scanner + Announcements)

**Date:** 2026-07-14 · **Scope:** the two impact-score weaknesses found in the scoring review · **Status:** all three items (X1, S1, S2) implemented + tested (18 tests, `TestScoringFixes` in `test_app.py`).

## Context

Review verdicts being actioned:
- **News Scanner `impact_score`** — rubric is well-designed, but its multi-step *additive arithmetic*
  is unreliable on the small local models this path actually runs on (the score may not follow the
  rubric even though the rubric is sound).
- **Announcement `impact`** — has **no rubric at all**; the prompt seeds a numeric example
  (`"impact":6` normal, `"impact":8` PS) that both under-specifies the scale AND anchors the output.
  Two templates seed two different numbers → impact isn't even on one internal scale.

Shared root cause: impact is asked for as a *number the model computes/guesses* rather than a *band the
model selects by event type*. Small models do selection far more reliably than arithmetic. The fix for
both is one shared **type → impact band** table, plus a deterministic server-side floor as a backstop.

---

## S1 — Announcement `impact` has no rubric and is anchored by the example value (P0)

- **Status:** Resolved. Both templates now embed `core.impact_band_rubric_text()` (X1's shared table)
  and replace the seeded `"impact":6`/`"impact":8` example with a neutral `<integer 1-10, per the band
  table above>` placeholder. `classify_announcement()` applies the PS floor (`max(impact, 5.0)`) as a
  post-classification step (works for both the LLM and keyword-fallback paths), not a prompt anchor.
- **Where:** `announcement_engine.py:219` (`"impact":6` in `_LLM_PROMPT_TEMPLATE`), `:246`
  (`"impact":8` in `_LLM_PROMPT_TEMPLATE_PS`), templates `:208-250`; clamp `:1488-1491`
- **Cause:** The JSON template shows a concrete impact value as its "example", giving the model (a) zero
  definition of what 1–10 means and (b) a strong anchor toward the seeded number. The PS template seeds
  8, the normal one seeds 6, so the same event scores differently purely by which template fired. The
  number is surfaced in the UI (`|8.0`) and injected into prompts as if measured.
- **Fix:**
  1. Add a shared **impact band rubric** (module constant) keyed by announcement type, e.g.:
     `Trading Halt / Suspension → 8–9`, `Acquisition / Takeover / Scheme → 8–9`,
     `Capital Raise → 6–8`, `Earnings / Guidance Update → 6–8`, `Dividend → 5–7 (cut/suspension top of band)`,
     `CEO/Board Change → 4–6`, `Asset Sale / Operational Update → 3–5`, `AGM / Admin / Other → 1–3`.
  2. Inject that rubric into **both** templates (`_build_prompt`, `:1364`) and replace the seeded number
     with a neutral placeholder that references the scale (e.g. `"impact":<1-10, pick per the band table above>`),
     so neither template anchors a value.
  3. Because ASX `isPriceSensitive` is authoritative (`:716`), keep the PS/normal split but express it as
     a **floor**, not an anchor: PS announcements → `max(impact, 5)` in the post-parse clamp
     (`:1488-1491`), rather than seeding 8 in the prompt.
- **Test:** An AGM/administrative notice scores 1–3 (not ~6/8); a trading-halt scores 8–9; a PS
  announcement never scores below the PS floor; the two templates produce the same band for the same
  event type.
- **Effort:** S.

---

## S2 — News `impact_score` rubric is fragile on weak local models (arithmetic) (P1)

- **Status:** Resolved. STEP 2 rewritten as a row lookup against the shared band table plus one
  qualitative top/bottom/middle nudge — no more `add +1.5`/`subtract 2`/`sum of applicable steps`.
  STEP 1 (commentary/opinion floor) and the macro/geopolitics specificity exemption kept unchanged.
  Added `core.impact_floor_for_keywords()` — a deterministic, provider-agnostic backstop that floors
  a halt/takeover article's score to its band minimum regardless of what the model actually emitted.
- **Where:** `news_engine.py:817-822` (the 4-step additive rubric, `final = min(10.0, sum of applicable steps)`)
- **Cause:** The rubric asks a 4–8B local model to run conditional arithmetic across four steps and sum
  them. Small models do this unreliably, so emitted scores often don't actually follow the (good) rubric.
  Cloud providers execute it fine; the local path — the whole reason this rubric exists — is where it
  degrades.
- **Fix:**
  1. Rewrite the rubric as **band selection, not arithmetic**: reuse the same shared type → band table
     from S1 (see X1). "Pick the row that best matches the event; choose the **top** of that row's range
     if a portfolio ticker is the primary subject AND a large figure is cited, the **bottom** if only a
     passing mention, else the middle." This is a lookup + one qualitative nudge — no summing.
  2. Keep STEP 1 as-is (opinion/commentary/listicle → 0.5–2.0). It's a classify-then-assign, not
     arithmetic — already reliable.
  3. Keep the macro/geopolitics specificity exemption (current STEP 3 skip) — it's correct.
  4. **Deterministic backstop** (server-side, provider-agnostic): after parse, apply a type-keyword
     floor/ceiling so weak-model output can't produce absurd values — e.g. a title matching
     halt/takeover keywords floors impact to the band minimum. Same defensive pattern as the announcement
     heuristic fallback. This makes correctness independent of whether the model followed the prompt.
- **Test:** A listicle → ≤2; an M&A headline → ≥7; the assembled prompt contains **no** "sum of steps"
  arithmetic instruction; a halt article whose model output says impact=2 is floored to the halt band by
  the backstop.
- **Effort:** S–M.

---

## X1 — Cross-cutting: one shared impact scale for both surfaces (P1, do alongside S1/S2)

- **Status:** Resolved. `IMPACT_BAND_TABLE` + `impact_band_rubric_text()` + `impact_floor_for_keywords()`
  added to `core.py`; both `news_engine.py` and `announcement_engine.py` import and embed the identical
  rendered rubric text (verified byte-identical in both real prompts by a dedicated test).
- **Cause:** News impact (rubric-anchored) and Announcement impact (unanchored guess) are both surfaced
  as "impact 0–10" but mean different things — not comparable. Any code that ever ranks or merges them
  together would be invalid.
- **Fix:** Define the type → band table **once** (a shared constant importable by both
  `news_engine.py` and `announcement_engine.py`, e.g. in `core.py`) and have both S1 and S2 reference it.
  Then an "Earnings result" lands in the same band whether it arrives via News or Announcements, and the
  0–10 unit means the same thing everywhere. Document the shared scale where both prompts are defined.
- **Test:** The same event type maps to the same band constant from both modules; a fixture asserts the
  two prompts embed identical band definitions.
- **Effort:** S (mostly moving a constant + wiring imports).

---

## Suggested sequencing

| Phase | Items | Rationale |
|---|---|---|
| 1 | X1 | Land the shared band table first — S1 and S2 both consume it. |
| 2 | S1 | Highest-value: turns the announcement guess into a real, un-anchored score. |
| 3 | S2 | Makes the News rubric robust on local models + adds the deterministic backstop. |

**Cross-cutting:** all three are prompt/constant changes plus one server-side backstop function — no
schema migration. Each needs a regression test asserting the *band selection* behaviour (not just that
JSON parses). Guard against re-introducing a seeded numeric example in either template (a small test that
greps the templates for a bare `"impact":<digit>` would catch regressions).

## Resolution log — 2026-07-14

Implemented in the suggested order (X1 -> S1 -> S2), verified against the full Python (1044 tests) and
JS (222 tests) suites. 18 new tests in `TestScoringFixes` (`test_app.py`), including the doc's own
suggested regression guard (grep both templates for a bare `"impact":<digit>` anchor) and a test that
renders both real prompts and asserts the shared band-table text is byte-identical in each.
