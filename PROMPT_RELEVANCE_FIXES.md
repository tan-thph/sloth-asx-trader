# PROMPT_RELEVANCE_FIXES.md — News + Announcement relevance gating for the Claude prompt

**Date:** 2026-07-15 · **Scope:** ensure the portfolio prompt carries only decision-relevant news/announcements · **Status:** RESOLVED — R1-R7 all implemented (2026-07-15).

## Context

Goal: *"the prompt to Claude should only include high-relevance news and announcements, not random or
low-value news."* Audit of the **live** payload (real 26-ticker book, `days=3`) says it currently does not:
**6/10 announcements and 5/7 news items are noise.**

Measured announcement block (`get_ann_brief(tickers, days=3, max_items=10)`):

```
PS=T imp=9.0 | SDF [Acquisition|positive]      Further update on non-binding proposal   ← real
PS=T imp=7.0 | RIO [Guidance Update|positive]  Q2 production results                    ← real
PS=T imp=6.0 | SDF [Trading Halt|neutral]      Pause in Trading                         ← real
PS=F imp=9.0 | RIO [Other|negative]            Notification of cessation of securities  ← NOISE (and harmful)
PS=F imp=3.0 | MQG [Other|neutral]             Becoming a substantial holder            ← NOISE
PS=F imp=3.0 | RIO [Other|neutral]             Ceasing to be a substantial holder       ← NOISE
PS=F imp=3.0 | WDS [Other|neutral]             Notification of cessation of securities  ← NOISE
PS=F imp=3.0 | WDS [Other|neutral]             Notification re unquoted securities      ← NOISE
PS=F imp=3.0 | SUN [Other|neutral]             Change in substantial holding            ← NOISE
PS=F imp=2.0 | FMG [Other|neutral]             Notification of cessation of securities  ← NOISE
```

Measured news block (`/api/news/brief?days=3`, limit 15):

```
DIRECT imp= 8.0  BHP Faces Port Hedland Strike After Labor Talks    ← useful
DIRECT imp= 6.8  CSL Share Price Has Won Back A$15 Billion...       ← useful
WIDE   imp= 0.0  Can Commonwealth Bank Outperform the ASX 200?      ← clickbait, impact ZERO
WIDE   imp=10.0  Death toll from Bangkok bar fire rises to 30       ← irrelevant to an ASX book
WIDE   imp=10.0  Utility-Scale Solar Costs Rise 18%                 ← marginal
WIDE   imp= 7.8  EU bans gold imports from Sudan                    ← marginal
WIDE   imp= 6.8  Israeli strike on police post in north Gaza        ← marginal
```

**Shared root cause:** selection is *rank-and-fill to a fixed slot count* rather than *admit only what
clears a relevance bar*. Both briefs will always emit `max_items` rows if that many exist, so when real
signal is thin the slots fill with whatever ranks next — which is boilerplate. Compounding it, the one
gate that does exist (impact) is applied as an `OR` in news, and not at all in announcements.

**Note on SCORING_FIXES.md:** X1/S1/S2 (landed 2026-07-14 13:40) fixed the *rubric*. These items are
about *selection*, which is a separate layer — a correct score still has to be filtered on. R2 below is
the one genuine gap left in the scoring layer itself (a floor with no matching ceiling).

---

## R1 — Announcement brief has no impact floor and no type gate (P0)

- **Status:** Resolved. `_ADMIN_ANN_PATTERNS`/`is_admin_announcement` added to `core.py`
  (shared with R2). `get_ann_brief` (`announcement_engine.py`) now fetches the full window
  unbounded, admits a row only when `price_sensitive OR (impact >= _ANN_BRIEF_MIN_IMPACT(5.0)
  AND not is_admin_announcement(headline+summary))`, and stops once `max_items` is reached —
  it no longer pads. Tests: `TestPromptRelevanceFixes.test_get_ann_brief_*` (5 tests).
- **Where:** `announcement_engine.py:2122-2129` (`get_ann_brief` query), consumed at `js/analysis.js:662-674`.
- **Cause:** The query is `WHERE date >= ? AND ticker IN (...) ORDER BY price_sensitive DESC, impact DESC,
  date DESC LIMIT ?`. There is **no `WHERE` clause on impact and no exclusion by type** — so `LIMIT 10`
  is a quota that always fills. With 3 real filings in the window, the other 7 slots are handed to
  registry boilerplate ("cessation of securities", "becoming/ceasing to be a substantial holder",
  "notice of proposed sale"). These are ASX-mandated administrative notices with no trading implication.
- **Fix:**
  1. Add a module constant `_ADMIN_ANN_PATTERNS` — headline substrings that mark a filing as
     administrative regardless of its score: `cessation of securities`, `substantial holder`,
     `substantial holding`, `unquoted securities`, `proposed sale of securities`, `notice of annual general
     meeting`, `change of address`, `director interest notice`, `appendix 3` / `appendix 2a`.
  2. In `get_ann_brief`, admit a row only when `price_sensitive OR impact >= _ANN_BRIEF_MIN_IMPACT` (5.0),
     **and** it does not match `_ADMIN_ANN_PATTERNS`. `price_sensitive` remains an unconditional pass —
     ASX's own flag is authoritative (CLAUDE.md gotcha, `announcement_engine.py:716`).
  3. **Let the block shrink.** `max_items` becomes a ceiling, not a quota. 3 real filings > 3 real + 7 noise.
  4. Filter at brief time only — do **not** delete from the DB. The Announcements page still shows
     everything; this is a prompt-injection gate, not a data-retention change.
- **Test:** a book whose window holds only admin filings yields `[]`; a PS admin filing still passes
  (flag is authoritative); a non-PS impact-3 "substantial holder" is excluded; a non-PS impact-7 earnings
  filing passes; result length is ≤ `max_items` but not padded to it.
- **Effort:** S.

---

## R2 — Admin filings have an impact FLOOR but no CEILING (P0)

- **Status:** Resolved. `core.impact_cap_for_admin(text)` added (mirrors
  `impact_floor_for_keywords`, shares `_ADMIN_ANN_PATTERNS` with R1). Applied in
  `classify_announcement` (`announcement_engine.py`) as a post-parse clamp against
  `headline + summary`, ordered BEFORE the existing PS floor so ASX's own flag still wins.
  Tests: `test_impact_cap_for_admin_*`, `test_classify_announcement_caps_admin_impact`,
  `test_classify_announcement_ps_floor_beats_admin_cap`,
  `test_classify_announcement_genuine_halt_untouched`.
- **Where:** `core.py:324` (`impact_floor_for_keywords` — floors only), band table `core.py:303-314`,
  applied in `announcement_engine.py:classify_announcement` (`:1894`).
- **Cause:** `IMPACT_BAND_TABLE` **already** says `AGM / Admin / Broad Commentary / Other → 1-3`, and the
  scorer still emitted **9.0** for RIO. X1 added a deterministic *floor* backstop but nothing symmetric on
  the top side, so a small model that ignores the rubric upward is never corrected. Evidence — identical
  boilerplate, same model (`ollama/gemma4:e4b`), same week:

  | Ticker | Headline | Impact |
  |---|---|---|
  | RIO | Notification of cessation of securities | **9.0** |
  | COH | Notification of cessation of securities | 4.0 |
  | WDS / GMG / BHP / ALL / DRO | Notification of cessation of securities | 3.0 |
  | FMG / SCG / XRO | Notification of cessation of securities | 2.0 |

  A 2.0–9.0 spread on byte-identical text is pure scorer variance. This is **not just wasted tokens** —
  RIO's row reaches Claude as `RIO [Other|negative|9.0]`, i.e. *high-impact negative news on a holding*,
  when it is an options-expiry registry notice. That is a fabricated bear signal on a live position.
  `type='Other'` currently holds 38 rows at impact 6.0 and 25 at 5.0, so **R1's floor alone will not
  catch this** — the noise scores straight through it. R1 and R2 are complementary, not redundant.
- **Fix:**
  1. Add `core.impact_cap_for_admin(text) -> float | None` — the mirror of `impact_floor_for_keywords`.
     Returns the `AGM / Admin / …` band ceiling (3.0) when the headline matches `_ADMIN_ANN_PATTERNS`
     (shared with R1 — one source of truth, imported by both engines).
  2. Apply in `classify_announcement` post-parse clamp, next to the existing PS floor, so it corrects
     **both** the LLM and keyword-fallback paths and fixes the stored value (the UI shows this too).
  3. Order matters: **cap admin, then apply the PS floor.** ASX's PS flag wins over our keyword guess —
     if ASX flagged it price-sensitive, it isn't routine, whatever the headline looks like.
- **Test:** "Notification of cessation of securities" caps at 3.0 whatever the model emits (assert with a
  stubbed 9.0); a PS-flagged admin filing keeps the PS floor of 5.0 (floor beats cap); a genuine
  "Trading Halt" is untouched at 8-9; cap and floor never invert.
- **Effort:** S.

---

## R3 — News market-wide floor is an `OR` that recency bypasses (P0)

- **Status:** Resolved. `news_engine.py` gained `_WIDE_MIN_IMPACT(5.0)`,
  `_RECENT_MIN_IMPACT(4.0)`, `_DIRECT_MIN_IMPACT(3.0)`. The market_wide append condition is now
  `imp >= _WIDE_MIN_IMPACT or (is_recent and imp >= _RECENT_MIN_IMPACT)`; `_select()`'s recency
  pass takes a `recency_min_impact` param so recency slots can't re-admit what the tier filter
  rejected. `portfolio_direct` now floors at `_DIRECT_MIN_IMPACT` (previously no floor at all).
  Tests: `test_get_news_brief_market_wide_zero_impact_recent_excluded`,
  `..._admits_fresh_moderate_impact`, `..._excludes_stale_moderate_impact`,
  `..._admits_stale_high_impact`, `..._portfolio_direct_has_impact_floor`,
  `..._empty_pool_returns_empty_not_padded`.
- **Where:** `news_engine.py:2126` (`elif imp >= 5.0 or is_recent`), `:2130-2160` (`_select`), `:2067`
  (`recency_cutoff`, 6h).
- **Cause:** Two independent bypasses of the impact bar:
  1. `elif imp >= 5.0 or is_recent:` — the `or` means **any** article <6h old is admitted at **any**
     impact. This is how a **0.0**-impact piece ("Can Commonwealth Bank Outperform the ASX 200 Again?")
     reached the prompt.
  2. `_select()` fills `recency_slots` first, straight off a date-DESC pool, **before impact is consulted
     at all**. So even post-admission, the freshest item wins a slot on recency alone.
  The intent is sound and worth keeping (a breaking 4.5 beats a stale 8.0 the market has absorbed) — but
  it is currently implemented as *no floor*, not *a lower floor*.
- **Fix:**
  1. Replace the disjunction with a two-tier floor: `imp >= _WIDE_MIN_IMPACT` (5.0) **or**
     (`is_recent and imp >= _RECENT_MIN_IMPACT`) with `_RECENT_MIN_IMPACT = 4.0`. Recency still buys a
     concession, but never a free pass.
  2. Apply `_RECENT_MIN_IMPACT` inside `_select`'s recency pass too, so the recency slots can't re-admit
     what the tier filter would reject. Skip, don't fail, when nothing clears — let the block shrink.
  3. Add a floor to `portfolio_direct` as well (`_DIRECT_MIN_IMPACT`, 3.0 — deliberately lower; an article
     genuinely *about* a holding is relevant at lower impact than market chatter). Currently there is
     **no floor at all** on the direct tier.
- **Test:** a 0.0-impact fresh article is excluded; a 4.5-impact fresh article is admitted; a 4.5-impact
  2-day-old article is excluded; a 9.0-impact 2-day-old article is admitted; recency slots never emit
  below `_RECENT_MIN_IMPACT`; an empty pool returns `[]` rather than padding.
- **Effort:** S.

---

## R4 — The market-wide tier is defined by *absence*, not relevance (P1)

- **Status:** Resolved. `_WIDE_RELEVANT_CATEGORIES = {macro, geopolitics, sector, regulatory,
  merger}` added to `news_engine.py`; market_wide admission now requires
  `category in _WIDE_RELEVANT_CATEGORIES` in addition to R3's floor. `portfolio_direct` is
  unaffected (gate is market-wide-only). Tests:
  `test_get_news_brief_market_wide_excludes_other_category_regardless_of_impact`,
  `..._excludes_analyst_category_regardless_of_impact`,
  `..._portfolio_direct_unaffected_by_category_gate`.
- **Where:** `news_engine.py:2092` (`is_direct = bool(primary & ticker_set)`), `:2124-2128` (the
  `if is_direct / elif` split).
- **Cause:** An article is "market-wide" purely because **no portfolio ticker is its primary subject**.
  That is a definition by negation: a Bangkok bar fire has no ASX primary ticker, so it is structurally
  classified as ASX market context and competes for a slot on impact alone. Since the scorer will happily
  hand an unrelated tragedy a 10.0 (see the measured block above), it wins that competition. No amount of
  impact-floor tuning fixes this — a higher floor *promotes* the bar fire and drops the Gaza strike.
  The tier needs a positive relevance predicate, not a stricter score.
- **Fix:**
  1. Admit to `market_wide` only when `category in _WIDE_RELEVANT_CATEGORIES` **and** the impact floor
     from R3 is met. Live vocabulary verified against the DB (last 30d) — the set is:

     | Category | n | avg impact | Market-wide? | Why |
     |---|---|---|---|---|
     | `other` | 331 | 0.5 | **exclude** | the catch-all the Bangkok bar fire landed in |
     | `geopolitics` | 242 | 3.0 | **include** | gotcha #72 — moves a resources book |
     | `sector` | 182 | — | **include** | genuine sector rotation context |
     | `analyst` | 114 | 1.4 | **exclude** | the clickbait bucket — *this is where the 0.0 CBA piece came from* |
     | `macro` | 62 | 1.9 | **include** | core macro |
     | `dividend` | 43 | 1.2 | exclude | stock-specific — belongs in the direct tier |
     | `technical` | 28 | — | **exclude** | TA clickbait ("52-week high!") |
     | `regulatory` | 23 | — | **include** | policy/regulatory shifts |
     | `earnings` | 13 | 3.4 | exclude | stock-specific — direct tier |
     | `merger` | 9 | 3.5 | **include** | sector-moving M&A |
     | `operational` | 1 | 3.0 | exclude | stock-specific |

     → `_WIDE_RELEVANT_CATEGORIES = {macro, geopolitics, sector, regulatory, merger}`.
  2. Keep `geopolitics` first-class (gotcha #72) — the fix is to exclude `other`/`analyst`, not to narrow
     the deliberate macro set.
  3. **Two of my assumptions were wrong and the DB corrected them** — the real category is `regulatory`,
     not `regulator`, and there is no `commodities` category at all. Excluding `analyst` also turns out to
     be load-bearing: that is the actual category of the 0.0-impact CBA clickbait in the measured block,
     so R3's floor and R4's category gate each independently catch it.
  4. Stock-specific categories (`dividend`/`earnings`/`operational`) are excluded from *market-wide* only.
     They still reach the prompt via the direct tier when they concern a holding, which is the correct route.
- **Test:** an impact-10 `category='other'` article is excluded from the market-wide tier; an impact-6
  `category='geopolitics'` article is admitted; an `analyst` article is excluded regardless of impact; a
  `category='other'` article that IS portfolio-direct is unaffected (this gate is market-wide-only).
- **Effort:** S — vocabulary now verified, no open question.

---

## R5 — `analysis.js` comment documents a filter that does not exist (P2)

- **Status:** Resolved. Comment rewritten to state the real R3/R4 contract and point to
  `news_engine.get_news_brief()` as the single owner of the thresholds. No logic change.
  Test: `test_analysis_js_comment_points_to_news_engine_thresholds`.
- **Where:** `js/analysis.js:630`.
- **Cause:** Reads *"Tier 2: high-impact market-wide articles (impact ≥ 6.0, no holding as primary
  subject)"*. There is no 6.0 threshold anywhere in the stack — the real rule is `>= 5.0 OR is_recent`
  (R3), and the client applies **no** impact filter of its own (`news.filter(n => !n.portfolio_direct)`,
  `:636-637`). The comment describes a stricter gate than exists, which is how this drifted unnoticed.
- **Fix:** rewrite the comment to state the real contract once R3/R4 land, and name `news_engine.get_news_brief`
  as the owner of the thresholds so the next reader looks in one place.
- **Effort:** XS.

---

## R6 — 41 legacy `news_items` rows hold impossible impact scores (P1)

- **Status:** Resolved (migration tool shipped; user must run it). **Found incidentally while
  verifying R4's category vocabulary — not part of the original brief.** `POST
  /api/news/backfill-impact-clamp` (`routes/news.py`) added, dry-run by default
  (`{"dry_run": true|false}`), same shape as the `backfill-modes` precedent — clamps
  `impact_score` to `[0, 10]` for out-of-range rows. Not auto-run on startup; the 41 rows persist
  until this endpoint is called with `dry_run:false`. Test:
  `test_news_backfill_impact_clamp_dry_run_then_apply`.
- **Where:** `news_items.impact_score`, written pre-`2026-07-14T13:11` (NEWS_LLM_FIXES N7 clamp).
- **Cause:** **41 of 1064 rows are outside the valid 0–10 scale**, all from `qwen3.5:9b`:

  ```
  imp=  -13,479,800,000.0  technical   CBA (ASX:CBA) ASX Technical Analysis: 52-Week...
  imp=   -3,894,700,000.0  sector      DroneShield (ASX:DRO) Shares Rebound...
  imp=   -1,349,876,000.0  regulatory  Australian Shares Rise; Australia's Federal...
  imp=         -164,987.0  sector      ANZ (ASX:ANZ) Shares Rise as the Big Banks...
  imp=              -10.0  other       West Texas Cowboys Are Cashing In on the AI...
  ```

  The `-13479800000.0` / `-1.347689` pairing suggests a mangled exponent or a digit-run swallowed from
  adjacent text, not a model "opinion". **N7's clamp is confirmed working** — `_safe_float(..., max_val=10.0,
  min_val=0.0)` at `news_engine.py:1752` is the *only* LLM write path for `impact_score`, and **0 of the 63
  rows processed since the clamp landed are out of range** (all 41 predate it). So this is residue, not an
  active leak — no code fix needed, only cleanup.
- **Why it still matters:** 6 of the 41 are inside the live `days=3` prompt window right now (e.g. ANZ at
  `-164987.0`). They rank last on `impact × decay` so they lose the impact pass — but the R3 recency
  bypass can still hand them a slot, and they corrupt the `AVG(impact_score)` in
  `get_market_sentiment` (`:2175`), which is a **whole-of-book sentiment aggregate**: one `-1.3e10` row
  drags an entire category's average to `-481,421,427`. That average feeds the macro brief.
- **Fix:** one-off clamp pass over stored rows (dry-run → report → commit), same shape as the
  `POST /api/portfolio/backfill-modes` precedent. `UPDATE news_items SET impact_score =
  MAX(0.0, MIN(10.0, impact_score)) WHERE impact_score < 0 OR impact_score > 10`. R3's floor masks them
  from the prompt immediately, but the sentiment aggregate stays poisoned until this runs.
- **Test:** post-backfill, `SELECT COUNT(*) WHERE impact_score NOT BETWEEN 0 AND 10` is 0; no in-range
  row is modified; `get_market_sentiment` returns a plausible average.
- **Effort:** S.

---

## R7 — Backfill: existing mis-scored announcements keep leaking until they age out (P2, optional)

- **Status:** Resolved (migration tool shipped; optional to run). `POST
  /api/announcements/backfill-admin-cap` added (`announcement_routes.py`), dry-run by default —
  applies `core.impact_cap_for_admin` to stored non-PS `announcements` rows and writes the
  capped value. Test: `test_announcement_backfill_admin_cap_dry_run_then_apply`.
- **Cause:** R2's cap fixes rows at classify time, but the ones already stored (RIO 9.0 et al.) keep
  reaching the prompt for the rest of their `days=3` window. R1's brief-time type gate masks them
  immediately, so this is cleanup, not a blocker.
- **Fix:** one-off pass applying `impact_cap_for_admin` to stored `announcements` rows (dry-run first,
  report count, then commit). Only worth doing if the UI's historical impact numbers matter to you;
  otherwise the rows age out in 3 days. Pairs naturally with R6 — same migration, two tables.
- **Effort:** S.

---

## Suggested order

**R1 + R2 first** — together they remove all 6 noise announcements, and they're the pair that fixes the
*harmful* RIO row rather than merely the wasteful ones. **R3** next (kills the 0.0 clickbait), **R4**
after (kills the bar fire). **R6** is independent and can land any time — it's a data migration with no
code change. **R5** cosmetic, **R7** optional.

R1 and R2 share `_ADMIN_ANN_PATTERNS` — land it in `core.py` with R2 and import it into R1 so the
deny-list has exactly one home.

**Sequencing note:** R3's floor and R4's category gate each independently exclude the 0.0 CBA clickbait
(low impact *and* `category='analyst'`). That redundancy is deliberate — belt-and-braces on the tier that
demonstrably leaks — but it means neither alone should be judged by that single example when testing.

## Expected effect on the measured payload

| Block | Now | After R1–R4 |
|---|---|---|
| Announcements | 10 items, 6 noise | 3–4 items, 0 noise |
| News | 7 items, 5 low-relevance | 2–4 items, 0–1 marginal |

Both blocks get **smaller**, which is the point — the prompt stops asserting that a registry notice is
high-impact negative news about a holding. Token saving (~200-400/run) is incidental; the real win is
removing a fabricated bear signal on RIO.

## Cross-cutting test

After R1–R4, re-run the live audit (26-ticker book, `days=3`) and assert every injected row satisfies
`price_sensitive OR impact >= floor`, and that no injected row matches `_ADMIN_ANN_PATTERNS` or
`category='other'`.

## Resolution log (2026-07-15)

All seven items landed in one pass:

- **R1/R2** share `_ADMIN_ANN_PATTERNS` / `is_admin_announcement` / `impact_cap_for_admin` in
  `core.py`, imported by `announcement_engine.py`. `get_ann_brief` is now a filter, not a
  fixed-slot quota; `classify_announcement` caps admin filings before applying the PS floor.
- **R3/R4** land together in `news_engine.get_news_brief`: two-tier impact floor
  (`_WIDE_MIN_IMPACT`/`_RECENT_MIN_IMPACT`) plus a positive category allow-list
  (`_WIDE_RELEVANT_CATEGORIES`) gate market_wide; `portfolio_direct` gained its own floor
  (`_DIRECT_MIN_IMPACT`) where none existed before.
- **R5** — `analysis.js` comment now names `news_engine.get_news_brief()` as the single owner of
  the thresholds instead of describing a stale 6.0 rule.
- **R6/R7** — one-off migration endpoints (`POST /api/news/backfill-impact-clamp`, `POST
  /api/announcements/backfill-admin-cap`), dry-run by default, same shape as the
  `backfill-modes` precedent. **Not auto-run** — the legacy rows persist until you call these
  with `dry_run:false`.

29 new tests (`TestPromptRelevanceFixes` in `test_app.py`) — 1076 Python tests total, all green.
No JS logic changed (R5 was comment-only); 236 JS tests unaffected.
