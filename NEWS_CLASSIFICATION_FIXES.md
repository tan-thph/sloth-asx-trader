# NEWS_CLASSIFICATION_FIXES.md — Transmission-channel scoring for news classification

**Date:** 2026-07-15 · **Scope:** the news classifier's impact rubric, the silent-zero path behind it, and the two `critics.md` items worth applying · **Status:** C1-C6 implemented + tested (27 tests, `TestNewsClassificationFixes`; 1103 Python / 236 JS green).

**Map to `critics.md`:** C5 = R5 (decay half-life) · C6 = R4 (portfolio exposure). C1-C4 are this round's own findings. Evaluation of all 10 critic recommendations — including what was dropped and why — is in the *Critic evaluation* section at the foot of this doc. R3 + R7 are planned separately in `NEWS_EVENT_MODEL_PLAN.md`.

## Context

Follow-on from PROMPT_RELEVANCE_FIXES.md. R1-R7 fixed *selection* (which scored articles reach the
prompt). This round fixes *scoring* — the layer selection depends on. R4's category allow-list removed
the Bangkok bar fire because it happened to be `category='other'`, but that masked the symptom: the same
pathology was alive inside `geopolitics`, where the allow-list lets articles through by design.

**Root cause.** The rubric told the model, for macro/geopolitics only:

> *"For macro/geopolitics rows, skip the primary-subject test … use the **magnitude test alone**"*

Every magnitude anchor the rubric offers is financial — *"earnings change >5%, deal >$500M, index move
>2%"*. None fit a conflict story. So the model substituted the only magnitude such an article carries:
**the casualty count.** That inverted the scale against market impact:

| Article | Old impact |
|---|---|
| Death toll from Bangkok bar fire rises to 30 | **10.0** |
| Sri Lanka prison riots leave 26 dead | **7.8** |
| German court convicts Iraqi couple of enslaving Yazidi girl | 6.9 |
| **Iran says Strait of Hormuz closed 'until further notice'** | **7.0** |

A bar fire outranked the closure of the strait ~20% of the world's oil transits — with WDS in the book.

Keyword filtering cannot rescue this: *"Iran says Strait of Hormuz closed"* contains no commodity word at
all. The channel has to be reasoned about, then backstopped — the same "LLM selects, deterministic code
backstops" shape as X1/S2/R2.

**Decisions taken (user, 2026-07-15):** strict — no channel, no entry; do **not** rescore the 1064
existing rows (the brief reads a 3-day window, so they age out); keep the BBC World feed and let the
channel gate filter it.

---

## C1 — Rubric scores macro/geopolitics on event drama, not market transmission (P0)

- **Status:** Resolved. `core.TRANSMISSION_CHANNELS` + `transmission_rubric_text()` added (one constant,
  shared by the prompt and the backstop so the emit-vocabulary and the validate-vocabulary cannot drift).
  `CLASSIFY_PROMPT` gains a required `transmission` field and a STEP 2 transmission test.
- **Where:** `news_engine.py` `OllamaLLM.CLASSIFY_PROMPT` (shared by `GoogleLLM`/`GroqLLM` via
  `CLASSIFY_PROMPT = OllamaLLM.CLASSIFY_PROMPT`); `core.py` channel vocabulary.
- **Fix:**
  1. Model must name the channel by which the event reaches an ASX-relevant price:
     `oil_gas | iron_ore_coal | gold | base_metals | agriculture | aud_fx | rates_inflation |
     trade_policy | shipping_supply_chain | none`.
  2. Channel `none` → impact 0.5-2.0, stop.
  3. One explicit line does most of the work:
     **"CASUALTY COUNTS ARE NOT MARKET MAGNITUDE."** A fire killing 30 with no channel scores 1.0; a
     strait closure that kills nobody but halts oil shipments scores 8.0.
  4. Removed `is_portfolio_relevant` — emitted by the prompt, **consumed nowhere** (`portfolio_direct` is
     recomputed from `primary_tickers` at brief time). Pure token + reasoning cost.
- **Structure note (learned the hard way):** the scoring rules live ABOVE the JSON template as numbered
  prose; the template itself stays terse. A first revision inlined the transmission rules *inside* the
  JSON spec and qwen3.5:9b began emitting hallucinated keys and truncated objects — a 9B model cannot
  follow a dense instruction wall while generating valid JSON.
- **Test:** `test_classify_prompt_states_casualties_are_not_magnitude`,
  `test_transmission_vocabulary_is_shared_with_the_prompt`, `test_dead_is_portfolio_relevant_field_removed`.
- **Regression guard:** SCORING_FIXES' existing prompt guards (`"skip the primary-subject test"`,
  `"0.5-2.0 and stop"`, `"broad market relevance is the point, not a penalty"`) caught the rewrite when
  line-wrapping broke the literal substrings. The rules were semantically intact, but the **original
  wording was restored rather than the guards loosened** — those tests still assert the SCORING_FIXES
  phrasing verbatim.

---

## C2 — Deterministic backstop + lenient channel parsing (P0)

- **Status:** Resolved. `core.impact_cap_no_transmission(category, transmission)` mirrors
  `impact_cap_for_admin`: macro/geopolitics with no channel → cap `NO_TRANSMISSION_IMPACT_CAP` (2.0);
  every other category → `None` (no opinion — a stock-specific article's relevance comes from
  `primary_tickers`, not a macro channel). Applied in the scan loop after the S2 keyword floor.
- **Backstops STRUCTURED output, not text.** Pattern-matching the headline would drop exactly the
  article that matters most (Hormuz has no commodity word).
- **`core.normalize_transmission()` — bug found during implementation.** The vocabulary is shown
  pipe-delimited, which reliably teaches the model to answer in kind: qwen3.5:9b returns
  `"oil_gas|shipping_supply_chain"` for a strike on shipping — a genuinely **correct** multi-channel
  read. A strict `in TRANSMISSION_CHANNELS` membership test scored that as unrecognised → "no channel" →
  **capped the single best signal in the live set down to 2.0**. Now splits on `|,/;+&`/" and " and takes
  the first recognised channel; `"none|oil_gas"` → `oil_gas` (a real channel always beats a leading "none").
- **Test:** `test_normalize_transmission_accepts_multi_channel_answer`,
  `test_impact_cap_no_transmission_{caps_channelless_macro,spares_channelled_macro,ignores_non_macro_categories}`.

---

## C3 — Surface the channel in the prompt line (P2)

- **Status:** Resolved. `get_news_brief` selects `transmission` and renders macro/geopolitics signals as
  `[geopolitics→oil_gas|bearish|8.0]`. ~2 tokens; tells Claude *why* a world event is in an ASX prompt.
  Legacy rows (`transmission` NULL) omit the arrow.
- **Migration:** `ALTER TABLE news_items ADD COLUMN transmission TEXT`, additive, idempotent. Legacy rows
  stay **NULL** — deliberately not backfilled (age-out decision). Downstream must read NULL as
  *"unknown"*, never as *"no channel"*, or every pre-2026-07-15 row would be retro-capped — which is
  rescoring by the back door.
- **Test:** `test_transmission_column_migrated_and_legacy_rows_left_null`.

---

## C4 — A classification missing `impact_score` was stored as a silent 0.0 (P0)

- **Status:** Resolved. `_validate_classification()` rejects a result with no `impact_score`, applied at
  all three providers' `classify()` returns.
- **Found while verifying C1 — not part of the original brief, and the largest issue in this round.**
- **Where:** `news_engine.py` `_validate_classification` (new); provider returns; the N3 trigger at
  `if result is None and cloud_fallback_llms`.
- **Cause:** The local model frequently emits well-formed JSON that simply **stops early** —
  `{"summary":…, "category":…, "sentiment":…}`, no `impact_score`. That dict is *not None*, so it sailed
  past N3's `if result is None` fallback trigger, reached `_safe_float(missing) → 0.0`, and was stored as
  though the model had judged the article worthless.
- **Measured 2026-07-15:** **484 of 1048 processed articles (46%) sat at `impact_score` 0/NULL** from this
  path. Since R3's floors gate on `impact_score`, ~half the corpus was being excluded by *parse failure
  rather than judgement* — intermittently including the Hormuz closure.
- **Pre-existing, not introduced here.** The old prompt from git HEAD was run as a control and returns
  `impact=None` on the same articles, 3/3 runs.
- **Not a model-size problem.** qwen3.6:27b was tested on the same 4 articles and is **worse** —
  `impact_score` missing 4/4 vs the 9B's 1/4. "Use a bigger model" is not the fix.
- **Fix:** treat a missing `impact_score` as a failed classification (`return None`) so the existing retry
  path (N1 attempts cap) and, if enabled, the N3 cloud fallback get another attempt. The failure is
  **non-deterministic** — the same article/model/prompt scored `impact=None` on one run and 8.0 on the
  next — so a retry is all these articles ever needed. Zero cloud cost when the fallback is off (the
  current default); an unrecoverable article stays *unclassified* rather than wearing a fake 0.0.
  Only `impact_score` is required: it is what every downstream floor gates on and what truncation drops.
  `category`/`sentiment` survive truncation and have safe defaults — demanding them too would reject
  usable rows. A model that *deliberately* returns 0.0 is a judgement and is accepted; only a MISSING
  field is a failure.
- **Test:** `test_validate_classification_{rejects_missing_impact_score,accepts_complete_result,accepts_a_genuine_zero,rejects_non_dict}`,
  `test_all_three_providers_validate_before_returning`.

---

## C5 — Decay half-life was flat; a war decayed like a TA note (critics R5) (P1)

- **Status:** Resolved. `core.DECAY_HALF_LIFE_DAYS` + `decay_half_life_for(category)`; wired into **both**
  `compute_decay()` call sites.
- **Where:** `core.py` (map); `news_engine.py` classify loop + `_refresh_decay` loop.
- **Cause:** `compute_decay(published_iso, half_life_days=3.0)` has taken the parameter since it was
  written and **both call sites used the default** — the hook was built and never wired. So a war and a
  "52-week high!" note decayed identically, and the `impact × decay` ranking that picks the market_wide
  tier treated them the same.
- **Fix:** half-life by category — `technical` 2d, `analyst`/`other` 3d, `operational` 7d,
  `sector`/`dividend` 14d, `earnings`/`merger` 30d, `regulatory` 45d, `geopolitics` 90d, `macro` 180d.
  Unknown category keeps the flat 3.0, so an unrecognised row can never decay *slower* than today.
- **Concrete effect** — at 3 days old, the edge of the brief window:

  | Article | impact | old rank | new rank |
  |---|---|---|---|
  | "52-week high!" (technical) | 8.0 | **4.00** | 2.83 |
  | Hormuz closure (geopolitics) | 6.0 | 3.00 | **5.86** |

  The TA note used to **outrank the strait closure**. It no longer does.
- **Trap found while wiring:** `_refresh_decay` recomputes decay for every processed row nightly and
  selected only `id, published_date`. Left alone it would have silently flattened every half-life back to
  3.0 and undone C5 entirely — `category` added to that SELECT, guarded by
  `test_decay_refresh_loop_selects_category`.
- **Window caveat:** the brief reads a 2-3 day window, so anything past ~30d is functionally "does not
  decay in-window" (90d vs 180d is 0.977 vs 0.989 at 3 days). The long values express intent and survive
  a wider window later; what actually bites is the ORDER.
- **Test:** `test_decay_half_life_{orders_events_by_persistence,unknown_category_keeps_flat_default,is_case_insensitive}`,
  `test_type_aware_decay_reranks_war_above_ta_noise`, `test_decay_refresh_loop_selects_category`.

---

## C6 — "Who owns this risk?" — channel → holdings annotation (critics R4) (P1)

- **Status:** Resolved. `core.exposed_holdings(channel, tickers)` + `TICKER_COMMODITY_EXPOSURE` /
  `CHANNEL_EXPOSURE_SECTORS`; rendered on the brief's signal line.
- **Where:** `core.py`; `news_engine.get_news_brief`.
- **Shipped as ANNOTATION, not a filter.** A 26-ticker book spanning Materials/Energy/Financials/
  Healthcare/REITs matches nearly every channel, so gating on exposure would discriminate almost
  nothing — but naming *which* holdings a channel reaches is real context. C1's `transmission` was the
  first half of R4 ("what risk is this?"); this is the second ("who owns it?").
- **Two resolutions, because sector is the wrong grain for a commodity.** A sector-level map was built
  first and **produced confident falsehoods**:

  ```
  gold          -> Materials -> BHP, FMG, RIO, SGM     # FMG is pure iron ore. Zero gold.
  oil_gas       -> Energy    -> SMR, WDS               # SMR is met coal, not oil.
  iron_ore_coal -> Mat+Energy-> ..., WDS               # WDS is oil/gas, not iron ore.
  ```

  An annotation that asserts a position is exposed when it isn't is **worse than no annotation** — the
  reader cannot audit it. So commodity channels (`oil_gas`/`iron_ore_coal`/`gold`/`base_metals`) resolve
  through an explicit per-ticker map; broad channels (`rates_inflation`/`agriculture`/`trade_policy`/
  `shipping_supply_chain`) keep SECTOR_MAP, where sector genuinely *is* the transmission grain (a rate
  move reaches Financials and REITs as sectors, not via any one company's assets).
- **`aud_fx` annotates nothing on purpose** — it touches every offshore earner and USD-revenue miner, so
  "exposed: <the whole book>" is noise pretending to be signal.
- **SECTOR_MAP gap closed:** 10 of 26 holdings were unmapped. Four are real companies and were added —
  `SDF`→Financials, `SGM`→Materials, `SGP`→REITs, `SMR`→Energy (met coal, matching CRN/WHC/YAL).
  **SMR mattered**: a coal holding that an `iron_ore_coal` story could not flag. The other six
  (VAP/VDHG/VHY/VLC/VVLU/HBRD) are diversified ETFs with no single sector — they correctly get no
  annotation.
- **Rendered output** (verified end-to-end against the live book):

  ```
  — [geopolitics→oil_gas|bearish|8.0] Iran says Strait of Hormuz closed … [exposed: WDS]
  — [sector|neutral|10.0] Utility-Scale Solar Costs Rise 18% …          ← legacy row: no arrow, no exposure
  ```
- **Test:** `test_exposure_{commodity_channels_are_precise_not_sector_wide,iron_ore_coal_covers_miners_and_steel,broad_channels_use_sector,aud_fx_deliberately_annotates_nothing,empty_for_none_unknown_and_etfs,handles_ax_suffix_and_empty_book}`,
  `test_previously_unmapped_holdings_now_in_sector_map`.

---

## Verified against the real model

`qwen3.5:9b`, real articles pulled from the live DB, full path (prompt → normalize → cap → production
`_safe_float` clamp):

| Article | Old | New | Channel | Verdict |
|---|---|---|---|---|
| Death toll from Bangkok bar fire | 10.0 / 5.0 | **0.0** | none | DROP ✓ |
| Sri Lanka prison riots leave 26 dead | 7.8 | **0.0** | none | DROP ✓ |
| German court convicts Iraqi couple | 6.9 | **0.0** | none | DROP ✓ |
| UK-Switzerland roaming charges deal | 6.8 | **0.0** | none | DROP ✓ |
| **Iran says Strait of Hormuz closed** | 7.0 | **8.0** | oil_gas | **KEEP ✓** |

**The inversion is fixed**: Hormuz (8.0) now outranks the bar fire (0.0), where before the bar fire
(10.0) outranked Hormuz (7.0). C4's retry was observed recovering the bar-fire article on attempt 2 after
the validator rejected an incomplete first result.

## Known residual

- **Borderline articles remain model-variable.** "Ukraine strikes Russian ships near Crimea" scored
  `oil_gas → 6.0 (KEEP)` on some runs and `none → 2.0 (DROP)` on others. The transmission genuinely is
  arguable (Black Sea shipping vs a purely military action), so some of this is real ambiguity rather
  than model failure. C4's retry does not resolve it — a retry fixes a *missing* score, not a *different*
  one. Not worth chasing further without evidence it costs money.
- **C4 reduces but does not eliminate the ~46%.** One retry should take it to ~20%, two to ~10%, on the
  observed independence of failures. Worth re-measuring after a full scan cycle:
  `SELECT COUNT(*) FROM news_items WHERE processed=1 AND (impact_score=0 OR impact_score IS NULL)`.
- **Legacy rows keep their body-count scores** until they age out of the 3-day window (age-out decision).
  `get_market_sentiment` aggregates over a longer window, so its averages stay skewed for longer.

---

## Critic evaluation (`critics.md`, 10 recommendations)

The decisive constraint is measured, not aesthetic: **C4 found the local 9B model omits `impact_score`
46% of the time**, adding *one* field (C1's `transmission`) forced a full prompt restructure to stop
hallucinated keys, and **qwen3.6:27b is worse** (missing 4/4 vs the 9B's 1/4). So any recommendation that
**widens the classification schema is contraindicated** — it amplifies a measured failure. That single
criterion resolves four of the ten.

| # | Recommendation | Verdict | Reason |
|---|---|---|---|
| **R4** | Portfolio exposure engine | **Applied** → C6 | Critic's own top pick. C1's `transmission` was half of it already. Shipped as annotation, not filter. |
| **R5** | Event decay half-life | **Applied** → C5 | The hook (`half_life_days`) was already built and never wired. ~20 lines for a real re-ranking. |
| **R6** | Learn actual market impact | **Deferred, highest value** | The only item that makes the classifier self-correcting, and native to the existing learning-loop architecture. Shares its whole collection layer with R7 — see `NEWS_EVENT_MODEL_PLAN.md`. Blocked on C4's 46% being re-measured first: calibrating a scorer that fails to emit a score half the time would just measure the parse failure. |
| **R3** | Event lifecycles | **Planned** | `NEWS_EVENT_MODEL_PLAN.md`. Buildable now; payoff unproven — measure story-spam first. |
| **R7** | Historical playbooks | **Planned** | `NEWS_EVENT_MODEL_PLAN.md`. Data-starved ~2 orders of magnitude: 15 capital raises vs the critic's 82, over 24 days of history, against a 48-day median recovery. |
| **R1** | Split importance / tradeOpportunity / portfolioImportance | **Dropped** | Diagnosis is right — `impact` *is* overloaded — but the fix turns 1 required numeric into 3 on a model that can't reliably emit 1. `transmission` already separates *"does this reach a price"* from *"how big"*, which is the useful half. |
| **R2** | Event objects (actors/winner/loser/certainty) | **Dropped** | Four more fields. Precisely what produced hallucinated keys and truncated JSON when tried. |
| **R9** | Event novelty (expected vs unexpected) | **Dropped, revisit** | Best *idea* on the list — surprise is more predictive than importance. But it's another field, and judging "was this expected?" needs a consensus baseline that doesn't exist. Revisit if R6 ever provides one. |
| **R10** | Multi-model consensus | **Dropped** | 3× GPU across ~1000 articles, and we measured the 27B as *worse* — consensus would average a bad signal into a good one. Also triples the 46% exposure. |
| **R8** | Market knowledge graph | **Dropped** | Over-engineering for a local 26-ticker tool. The critic's own worked example (Iran→Hormuz→Oil→Shipping→Rates→Banks) is what `transmission: oil_gas` captures in one hop, for one field instead of a graph. |
