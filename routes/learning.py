"""
routes/learning.py — Learning Loop (recommendation logging + analytics).

Endpoints:
  /api/learning/log                  POST   — log a recommendation event
  /api/learning/outcome              POST   — partial-patch event outcome
  /api/learning/event/<id>           DELETE — hard-delete one event
  /api/learning/stats                GET    — win rates by band/regime/version
  /api/learning/debate-stats         GET    — per-pairing debate agreement breakdown
  /api/learning/calibration          GET    — compact context-aware prompt block
"""

import json
import math
import threading
import time
from datetime import datetime, timedelta

from flask import Blueprint, current_app, jsonify, request

from core import adv_slippage
from db import get_db

# Columns that /api/learning/outcome is allowed to update (§0.E SQL whitelist)
_ALLOWED_OUTCOME_COLS = (
    "outcome_status", "realized_pnl_pct", "realized_pnl_aud",
    "holding_period_days", "exit_reason", "error_type", "notes",
    "actual_entry_price", "actual_exit_price", "sector",
    "skill_score", "debate_summary", "prompt_hash",
    "tags", "trade_thesis", "rr_ratio",
    "success_tags", "checklist_bypasses",
    "thesis_verdict", "exit_signals_json",
    "regime_at_execution",
    # Paper/real firewall (gotcha #88): recs are logged at GENERATION time (before
    # the user picks paper vs real), so trade_mode defaults to 'paper' at INSERT and
    # is upgraded here at EXECUTION time when the lodge gatekeeper's choice is known.
    "trade_mode",
    "bull_case", "bear_case",
    "local_scrutiny_json",
    # Failed-quant-rule capture — patchable so the client can one-time backfill
    # historical events from recHistory._ruleWarnings (rows logged before the
    # capture shipped). Going-forward recs already carry it from INSERT time.
    "rule_warnings_json",
)

# ── Calibration TTL cache (L4) ────────────────────────────────────────────────
# Keyed by (regime, sectors_str, tickers_str, days); evicted after 5 minutes.
# Fix #8: _calib_lock serialises reads and writes so concurrent gunicorn threads
# cannot interleave a partial cache write and serve corrupted calibration data.
# The expensive _calib_compute() runs *outside* the lock; only the dict access is
# protected, so lock contention is negligible.
_calib_cache: dict = {}
_CALIB_TTL   = 300
_calib_lock  = threading.Lock()


bp = Blueprint("learning", __name__)

# ── Thesis Tracking (Sprint 67) ───────────────────────────────────────────────
# Structured entry-driver taxonomy. Mirrors the BUY-side counterpart of
# sell_primary_driver and aligns with indicators.FACTOR_WEIGHTS so the
# thesis-accuracy matrix ties back to the scanner's scoring factors.
ENTRY_DRIVERS = frozenset({
    "mean_reversion",      # oversold bounce: RSI low / price at lower BB
    "momentum_breakout",   # volume + price thrust above resistance
    "trend_pullback",      # established uptrend (ADX strong), buying a dip
    "fundamental_value",   # cheap on PE / high yield vs RBA — non-technical
    "macro_tailwind",      # sector rotation / commodity move — non-technical
})


def classify_entry_driver(sig: dict | None) -> str:
    """Deterministically infer the dominant TECHNICAL entry driver from a signal
    snapshot (the entry_signals_json shape: rsi_14, bb_pct_b, adx_14, atr_pct,
    return_5d, return_20d).

    Used to backfill historical BUY/TOP_UP rows for free (no Claude spend) and as
    a cross-check against Claude's live primary_entry_driver tag.

    fundamental_value / macro_tailwind cannot be inferred from price signals
    alone, so this returns the best *technical* match or "unknown".
    """
    if not sig:
        return "unknown"

    def _f(key):
        v = sig.get(key)
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    rsi = _f("rsi_14")
    bb  = _f("bb_pct_b")
    adx = _f("adx_14")
    r5  = _f("return_5d")
    r20 = _f("return_20d")

    # mean_reversion: oversold and/or sitting at the lower Bollinger band.
    if (rsi is not None and rsi < 35) or (bb is not None and bb < 0.15):
        return "mean_reversion"
    # trend_pullback: strong trend (ADX) in an up 20d, buying a short-term dip.
    if (adx is not None and adx > 25 and r20 is not None and r20 > 0
            and r5 is not None and r5 < 0):
        return "trend_pullback"
    # momentum_breakout: recent thrust higher, near/above the upper band.
    if (r5 is not None and r5 > 4) or (bb is not None and bb > 0.85) \
            or (r20 is not None and r20 > 8):
        return "momentum_breakout"
    return "unknown"


def classify_exit_quality_deterministic(exit_signals_json) -> str | None:
    """Deterministic exit-timing classification for SELL/TRIM events, computed
    purely from the exit-time technical snapshot (exit_signals_json) — no LLM.

    Answers: was this exit well-timed technically, or did it leave a strong
    setup early / get sold into an oversold extreme?

      exit_into_strength            — RSI>60 or BB%B>0.65 at exit: sold while
                                       the technical setup was still bullish —
                                       likely cut a winner early.
      exit_after_reversal_confirmed — momentum had genuinely turned (RSI<55 and
                                       MACD histogram negative) — a well-timed
                                       technical exit.
      exit_into_weakness            — RSI<35 or BB%B<0.25 at exit: sold near an
                                       oversold extreme — possible panic exit.
      exit_neutral                  — none of the above clearly fires.
      None                          — insufficient data (RSI and BB%B both null).

    Mirrors classify_entry_driver()'s pure-function style: same row in → same
    tag out, reproducible for calibration.
    """
    rsi  = _sig_get(exit_signals_json, "rsi_14")
    bb   = _sig_get(exit_signals_json, "bb_pct_b")
    macd = _sig_get(exit_signals_json, "macd_hist")
    if rsi is None and bb is None:
        return None
    if (rsi is not None and rsi > 60) or (bb is not None and bb > 0.65):
        return "exit_into_strength"
    if (rsi is not None and rsi < 35) or (bb is not None and bb < 0.25):
        return "exit_into_weakness"
    if macd is not None and macd < 0 and (rsi is None or rsi < 55):
        return "exit_after_reversal_confirmed"
    return "exit_neutral"


# ── Deterministic post-mortem tagging (Sprint 70) ─────────────────────────────
# Replaces the blind local-LLM postmortem/skill scorer. Driven by the entry/exit
# capture feature: thesis_verdict is the entry-vs-exit TECHNICAL comparison
# (validated/invalidated/irrelevant) computed by computeThesisDrift() at SELL/TRIM
# time, plus entry_signals_json (entry technicals) and the standard numeric
# outcome fields. Everything here is reproducible — same row → same tag/score — so
# it can feed calibration without the LLM-noise problem that motivated the rewrite.
#
# Deliberately does NOT emit missed_catalyst / external_shock: those need
# world-knowledge (news, index events) the row does not contain. They remain
# available only via the optional manual LLM postmortem buttons.


def _sig_get(entry_signals_json, key):
    """Pull one float field out of the stored entry_signals_json blob.

    Accepts either a JSON string (DB shape) or an already-parsed dict. Returns
    None for missing/unparseable values so callers can treat absence uniformly.
    """
    sig = entry_signals_json
    if isinstance(sig, str):
        try:
            sig = json.loads(sig)
        except (ValueError, TypeError):
            return None
    if not isinstance(sig, dict):
        return None
    v = sig.get(key)
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None


def classify_error_type_deterministic(row) -> str:
    """Deterministic error_type for a closed loss/breakeven, from real captured data.

    Sprint 71 Phase 2A: returns a COMMA-SEPARATED set of ALL applicable tags,
    ordered most-specific / most-data-backed → least-specific. A loss can carry
    several distinct lessons (e.g. an overconfident entry that ALSO had a stop
    sitting inside normal noise), and collapsing to a single tag threw away signal.
    Wins / no-error still return 'none' — a win has no entry error to learn from.
    Every tag is a member of VALID_PM_TYPES.

    Emission order (the order tags appear in the joined string):
      1. thesis_broken      — entry thesis demonstrably reversed (verdict invalidated)
      2. stop_too_tight     — empirical (MAE/MFE) first, else ATR-distance heuristic
      3. missed_catalyst    — earnings fell inside the holding window (partly deterministic)
      4. early_exit         — manual exit that left a favourable move / mechanical edge on table
      5. oversized/undersized — sizing-bypass token in checklist_bypasses
      6. overconfident      — high stated conviction that did not pan out
      7. poor_rr            — unfavourable planned risk/reward
      8. poor_entry         — entry technically stretched for the stated driver
      9. regime_mismatch    — bought into a bearish macro regime

    `row` is a sqlite Row or dict exposing: recommendation, outcome_status,
    realized_pnl_pct, ai_confidence, rr_ratio, exit_reason, regime, thesis_verdict,
    suggested_stop, suggested_target, actual_entry_price, entry_signals_json,
    primary_entry_driver, mae_pct, mfe_pct, exec_mech_pnl_pct, checklist_bypasses,
    holding_period_days. The MAE/MFE/exec_mech/holding fields are optional — every
    new tag guards its None values and degrades to the legacy heuristic when data is
    absent, so cached/legacy rows never raise.
    """
    def _g(key):
        try:
            return row[key]
        except (KeyError, IndexError, TypeError):
            return row.get(key) if hasattr(row, "get") else None

    def _fnum(v):
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    status = (_g("outcome_status") or "").lower()
    if status not in ("loss", "breakeven"):
        return "none"

    rec      = (_g("recommendation") or "").upper()
    conf     = _g("ai_confidence")
    rr       = _g("rr_ratio")
    verdict  = (_g("thesis_verdict") or "")
    exit_r   = (_g("exit_reason") or "")
    regime   = (_g("regime") or "")
    driver   = (_g("primary_entry_driver") or "")
    esj      = _g("entry_signals_json")
    entry_px = _fnum(_g("actual_entry_price"))
    stop_px  = _fnum(_g("suggested_stop"))
    target_px = _fnum(_g("suggested_target"))
    mae_pct  = _fnum(_g("mae_pct"))
    mfe_pct  = _fnum(_g("mfe_pct"))
    mech_pct = _fnum(_g("exec_mech_pnl_pct"))
    realized = _fnum(_g("realized_pnl_pct"))
    hold     = _g("holding_period_days")
    bypasses = (_g("checklist_bypasses") or "").lower()

    tags: list = []

    def _add(tag):
        if tag not in tags:
            tags.append(tag)

    # 1. thesis_broken — the entry technical thesis demonstrably reversed.
    #    DATA-BACKED (the entry-vs-exit comparison) rather than guessed.
    #    'reversed' is treated as a stronger form of invalidation (signals flipped
    #    rather than just deteriorated), so it also earns the thesis_broken tag.
    if verdict in ("invalidated", "reversed"):
        _add("thesis_broken")

    # 2. stop_too_tight.
    #    EMPIRICAL path (Sprint 71 Phase 2B): when MAE/MFE are available, tag it
    #    when the trade was stopped out while the thesis stayed intact AND price
    #    later recovered toward the target — i.e. the stop sat *inside* the eventual
    #    favourable path (the adverse excursion was deeper than the stop, yet MFE
    #    shows price subsequently climbed back toward where the target sat). The
    #    target-distance proxy: MFE recovered to ≥50% of the planned target move.
    #    Falls back to the ATR-distance heuristic when MAE/MFE are null.
    if exit_r == "stop_hit" and verdict in ("validated", "partially_validated", "irrelevant", ""):
        atr_pct = _sig_get(esj, "atr_pct")
        empirical_done = False
        if mae_pct is not None and mfe_pct is not None and entry_px:
            # Stop-distance as a % of entry (how far below entry the stop sat).
            stop_dist_pct = (abs(entry_px - stop_px) / entry_px * 100) if stop_px else None
            # Planned target move as a % of entry (favourable direction).
            target_move_pct = ((target_px - entry_px) / entry_px * 100) if target_px else None
            # The stop sat inside the eventual favourable path when the worst
            # drawdown (MAE) pierced the stop level, yet best excursion (MFE)
            # later recovered toward target.
            if stop_dist_pct is not None and mae_pct <= -stop_dist_pct:
                recovered = (
                    (target_move_pct is not None and mfe_pct >= 0.5 * target_move_pct)
                    or (target_move_pct is None and mfe_pct >= max(0.5 * stop_dist_pct, 1.0))
                )
                if recovered:
                    _add("stop_too_tight")
                empirical_done = True
        if not empirical_done and entry_px and stop_px and entry_px > 0 and atr_pct and atr_pct > 0:
            # Legacy ATR-distance heuristic: stop inside ~1.5×ATR ⇒ likely shaken
            # out by normal noise rather than a genuine thesis break.
            stop_dist_pct = abs(entry_px - stop_px) / entry_px * 100
            if stop_dist_pct < 1.5 * atr_pct:
                _add("stop_too_tight")

    # 3. missed_catalyst — partly deterministic (Sprint 71 Phase 2B): an earnings
    #    event fell INSIDE the holding window and wasn't flagged at entry. World-
    #    knowledge catalysts (news, index events) remain LLM-only.
    dte = _sig_get(esj, "days_to_earnings")
    if dte is not None:
        try:
            hold_days = int(hold) if hold is not None else None
        except (TypeError, ValueError):
            hold_days = None
        if hold_days is not None and 0 <= dte <= hold_days:
            _add("missed_catalyst")

    # 4. early_exit — a manual (discretionary) exit on a non-win where price had
    #    already offered the planned gain, or the mechanical rules would have done
    #    materially better. Uses Phase 1 MFE + Phase-0 exec_mech_pnl_pct.
    if exit_r == "manual":
        early = False
        # (a) MFE shows price reached/exceeded the planned target move before exit.
        if mfe_pct is not None and entry_px and target_px:
            target_move_pct = (target_px - entry_px) / entry_px * 100
            if target_move_pct > 0 and mfe_pct >= target_move_pct:
                early = True
        # (b) the mechanical exit materially beats the realized P&L (≥2pp better).
        if mech_pct is not None and realized is not None and mech_pct - realized >= 2.0:
            early = True
        if early:
            _add("early_exit")

    # 5. oversized / undersized — sizing discipline. Sizing context is not reliably
    #    captured per-trade, so this is scoped to an explicit sizing bypass token in
    #    checklist_bypasses (e.g. 'oversized_position' / 'undersized_position' /
    #    'size_override'). We do NOT infer sizing from P&L — that would fabricate the
    #    tag. (Limitation noted for Phase 3: richer sizing capture would let us tag
    #    these from actual qty vs the quant engine's suggested qty.)
    if bypasses:
        if any(tok in bypasses for tok in ("oversize", "size_up", "size-up", "over_size")):
            _add("oversized")
        if any(tok in bypasses for tok in ("undersize", "size_down", "size-down", "under_size")):
            _add("undersized")

    # 6. overconfident — high stated conviction that did not pan out.
    if conf is not None and _fnum(conf) is not None and _fnum(conf) >= 0.75:
        _add("overconfident")

    # 7. poor_rr — took an unfavourable risk/reward to begin with.
    if rr is not None and _fnum(rr) is not None and _fnum(rr) < 1.5:
        _add("poor_rr")

    # 8. poor_entry — entry was technically stretched for the stated driver.
    rsi = _sig_get(esj, "rsi_14")
    bb  = _sig_get(esj, "bb_pct_b")
    if driver == "mean_reversion" and (
            (rsi is not None and rsi > 45) or (bb is not None and bb > 0.45)):
        _add("poor_entry")
    if driver in ("momentum_breakout", "trend_pullback") and bb is not None and bb > 0.95:
        _add("poor_entry")

    # 9. regime_mismatch — bought into a bearish macro regime.
    if rec in ("BUY", "TOP_UP") and regime in ("riskOff", "panic"):
        _add("regime_mismatch")

    return ",".join(tags) if tags else "none"


def compute_skill_score_deterministic(row):
    """Deterministic skill-vs-luck score 0–10 for a closed trade, or None.

    The core signal is the thesis_verdict × outcome quadrant — exactly the
    skill/luck split the LLM was being asked to guess, but now read straight from
    the captured entry-vs-exit comparison:

        validated  + win  → 8.0  (right read, made money — skill)
        validated  + loss → 6.0  (right read, stopped on noise — unlucky, good process)
        irrelevant + win  → 5.5  (thesis didn't drive it, won)
        irrelevant + loss → 4.0  (thesis didn't drive it, lost)
        invalidated+ win  → 3.0  (wrong read, won anyway — luck)
        invalidated+ loss → 2.0  (wrong read, lost — bad analysis)

    Returns None when thesis_verdict is absent (no capture data) — we refuse to
    invent a skill score for legacy/uncaptured trades; those keep neutral weight.
    """
    def _g(key):
        try:
            return row[key]
        except (KeyError, IndexError, TypeError):
            return row.get(key) if hasattr(row, "get") else None

    verdict = (_g("thesis_verdict") or "")
    if verdict not in ("validated", "invalidated", "irrelevant",
                       "partially_validated", "reversed"):
        return None

    status = (_g("outcome_status") or "").lower()
    pnl    = _g("realized_pnl_pct")
    win    = status == "win" or (status not in ("loss", "breakeven") and pnl is not None and float(pnl) > 0)

    base = {
        # Original quadrant scores
        ("validated",           True):  8.0, ("validated",           False): 6.0,
        ("irrelevant",          True):  5.5, ("irrelevant",          False): 4.0,
        ("invalidated",         True):  3.0, ("invalidated",         False): 2.0,
        # New states (Improvement A)
        # partially_validated: thesis partially held — slightly below validated
        ("partially_validated", True):  7.0, ("partially_validated", False): 5.0,
        # reversed: signals flipped compared to entry — worse than invalidated
        ("reversed",            True):  2.0, ("reversed",            False): 1.0,
    }[(verdict, win)]

    exit_r = (_g("exit_reason") or "")
    conf   = _g("ai_confidence")
    rr     = _g("rr_ratio")

    # Discipline modifiers
    if exit_r == "target_hit":
        base += 0.5                      # let the winner run to plan
    if exit_r == "stop_hit" and not win:
        base += 0.5                      # respected the stop — disciplined loss
    if exit_r == "manual" and not win and verdict == "validated":
        base -= 0.5                      # bailed early on a thesis that was still intact

    # Confidence-calibration modifiers
    if conf is not None:
        if float(conf) >= 0.80 and not win:
            base -= 1.0                  # very confident and wrong
        if float(conf) < 0.65 and win:
            base -= 0.5                  # won, but low conviction — closer to luck

    # Planned R:R discipline
    if rr is not None and float(rr) >= 2.0:
        base += 0.25

    # Sprint 71 Phase 2C — path-quality modifier from MAE/MFE (when captured).
    # A *win* that spent most of the hold deeply underwater (large negative MAE,
    # little MFE headroom over the realized gain) leans toward luck → small penalty.
    # A clean win (shallow MAE, comfortable MFE headroom) reflects a well-timed
    # entry → small bonus. Only applied to wins; losses already carry the verdict
    # and discipline signal. Guards all None values (legacy rows are unaffected).
    if win:
        mae = _g("mae_pct")
        mfe = _g("mfe_pct")
        try:
            mae = float(mae) if mae is not None else None
            mfe = float(mfe) if mfe is not None else None
        except (TypeError, ValueError):
            mae, mfe = None, None
        if mae is not None and mfe is not None:
            # Deep-MAE win (drawdown worse than −8%) with thin MFE headroom → luck.
            if mae <= -8.0 and mfe < 8.0:
                base -= 0.5
            # Clean win: shallow drawdown and healthy favourable excursion → skill.
            elif mae >= -3.0 and mfe >= 5.0:
                base += 0.5

    return round(max(0.0, min(10.0, base)), 1)


def compute_skill_score_fallback(row):
    """LOWER-TRUST skill score 0–10 for legacy rows that lack a thesis_verdict.

    The primary scorer (compute_skill_score_deterministic) refuses to score a trade
    with no entry-vs-exit comparison, because the verdict is what separates skill
    from luck. This fallback produces a *reduced-trust* estimate from observable
    outcome data only — outcome × R-multiple × exit-discipline — so legacy/uncaptured
    rows are not silently treated as neutral forever.

    It is DELIBERATELY NOT wired into _resolve_deterministic_tags: a verdict-backed
    score and a no-verdict estimate must not be stored indistinguishably (that would
    pollute the Phase 8 skill gate / calibration with lower-confidence numbers). It is
    exposed for explicit, opt-in use (e.g. a future UI "estimate legacy" action or a
    separate lower-weight calibration channel) and is unit-tested. Returns None only
    when there is no usable outcome at all.

    Scoring (centred on 5.0 = neutral):
      win  → 6.0 base; loss/breakeven → 4.0 base
      + R-multiple (realized_pnl_pct / planned stop-distance %) nudges ±1.5 max
      + exit discipline: target_hit +0.5; disciplined stop loss +0.5; manual non-win −0.5
    """
    def _g(key):
        try:
            return row[key]
        except (KeyError, IndexError, TypeError):
            return row.get(key) if hasattr(row, "get") else None

    def _fnum(v):
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None

    status = (_g("outcome_status") or "").lower()
    pnl    = _fnum(_g("realized_pnl_pct"))
    if status not in ("win", "loss", "breakeven") and pnl is None:
        return None
    win = status == "win" or (status not in ("loss", "breakeven") and pnl is not None and pnl > 0)

    base = 6.0 if win else 4.0

    # R-multiple from realized P&L over the planned stop distance (risk taken).
    entry_px = _fnum(_g("actual_entry_price"))
    stop_px  = _fnum(_g("suggested_stop"))
    if pnl is not None and entry_px and stop_px and entry_px > 0:
        risk_pct = abs(entry_px - stop_px) / entry_px * 100
        if risk_pct > 0:
            r_mult = pnl / risk_pct
            base += max(-1.5, min(1.5, r_mult * 0.5))

    exit_r = (_g("exit_reason") or "")
    if exit_r == "target_hit":
        base += 0.5
    if exit_r == "stop_hit" and not win:
        base += 0.5
    if exit_r == "manual" and not win:
        base -= 0.5

    return round(max(0.0, min(10.0, base)), 1)


def _classify_success_tags_deterministic(row) -> str:
    """Pure function. Returns comma-separated success tags for closed wins.

    Improvement B: deterministic success-tag tagger that runs alongside the
    error-type tagger in _resolve_deterministic_tags. Never overwrites existing
    manual/Ollama tags (caller guards this).

    Tags emitted (any combination):
      regime_aligned  — won in a pro-risk regime AND hit the target (not a lucky exit)
      disciplined_hold — held for ≥5 days and reached target (no premature exit)
      clean_path      — shallow drawdown (MAE) relative to peak gain (MFE); |MAE| < 30% MFE
      thesis_confirmed — thesis verdict was validated or partially_validated
      strong_process   — skill_score ≥ 7 (deterministic or Ollama)

    Returns '' (empty) when no tag fires, so callers can skip the UPDATE.
    """
    def _g(key):
        try:
            return row[key]
        except (KeyError, IndexError, TypeError):
            return row.get(key) if hasattr(row, "get") else None

    tags: list = []

    verdict  = (_g("thesis_verdict") or "").lower()
    exit_r   = (_g("exit_reason")    or "").lower()
    hold_d   = _g("holding_period_days") or 0
    mfe      = _g("mfe_pct")    # float or None (≥0 for longs)
    mae      = _g("mae_pct")    # float or None (≤0 for longs)
    skill    = _g("skill_score")  # float or None
    regime   = (_g("regime") or "")

    # regime_aligned: won in a favourable regime AND hit target (not just a lucky exit)
    if regime in ("riskOn", "trend") and exit_r == "target_hit":
        tags.append("regime_aligned")

    # disciplined_hold: held for enough time AND hit target (no premature exit)
    if exit_r == "target_hit" and hold_d >= 5:
        tags.append("disciplined_hold")

    # clean_path: MFE high relative to MAE (shallow drawdown, high upside captured)
    try:
        mfe_f = float(mfe) if mfe is not None else None
        mae_f = float(mae) if mae is not None else None
    except (TypeError, ValueError):
        mfe_f, mae_f = None, None
    if mfe_f is not None and mae_f is not None and mfe_f > 0 and mae_f < 0:
        if abs(mae_f) < 0.3 * mfe_f:   # drawdown was less than 30% of peak gain
            tags.append("clean_path")

    # thesis_confirmed: thesis validated or partially_validated → analysis was correct
    if verdict in ("validated", "partially_validated"):
        tags.append("thesis_confirmed")

    # strong_process: high skill score (deterministic or Ollama)
    try:
        skill_f = float(skill) if skill is not None else None
    except (TypeError, ValueError):
        skill_f = None
    if skill_f is not None and skill_f >= 7.0:
        tags.append("strong_process")

    return ",".join(tags)


def _resolve_deterministic_tags(conn, cap: int = 50) -> int:
    """Lazily fill error_type + skill_score for closed, executed events that lack
    them, using the deterministic functions above. Idempotent, capped per call,
    runs alongside _resolve_virtual_outcomes / _resolve_sell_outcomes.

    error_type_source is set to 'deterministic' so the calibration auto-tag gate
    (which only distrusts LLM 'auto' tags) treats these as reliable. Manual/LLM
    tags already present are never overwritten — they win.

    Scoped to BUY/TOP_UP entries only: error_type ("why the entry failed") and the
    thesis_verdict skill quadrant are entry-centric. A SELL/TRIM 'loss' just means a
    position was cut below its entry — that is exit-decision quality, tracked
    separately by sell_verify_verdict, not an entry error. The parent BUY/TOP_UP
    events (which receive per-entry outcomes and the patched thesis_verdict at
    close) are the correct home for these tags.
    """
    rows = conn.execute("""
        SELECT id, recommendation, outcome_status, realized_pnl_pct, ai_confidence,
               rr_ratio, exit_reason, regime, thesis_verdict, suggested_stop,
               suggested_target, actual_entry_price, entry_signals_json,
               primary_entry_driver, mae_pct, mfe_pct, exec_mech_pnl_pct,
               checklist_bypasses, holding_period_days,
               error_type, error_type_source, skill_score, success_tags
          FROM ai_learning_events
         WHERE was_executed = 1
           AND recommendation IN ('BUY','TOP_UP')
           AND outcome_status IN ('win','loss','breakeven')
           AND (
                 (skill_score IS NULL AND NOT (outcome_status = 'win' AND success_tags = 'none'))
                 OR (outcome_status IN ('loss','breakeven')
                     AND (error_type IS NULL OR error_type = ''))
                 OR (outcome_status = 'win'
                     AND (success_tags IS NULL OR success_tags = ''))
               )
         ORDER BY timestamp DESC
         LIMIT ?
    """, (cap,)).fetchall()

    resolved = 0
    for r in rows:
        row_dict = dict(r)
        sets, vals = [], []
        if r["outcome_status"] in ("loss", "breakeven") and not (r["error_type"] or ""):
            sets.append("error_type=?");        vals.append(classify_error_type_deterministic(row_dict))
            sets.append("error_type_source=?"); vals.append("deterministic")
        if r["skill_score"] is None:
            sk = compute_skill_score_deterministic(row_dict)
            if sk is not None:
                sets.append("skill_score=?"); vals.append(sk)
        # Improvement B: fill success_tags for wins that don't already have them.
        # Runs AFTER skill_score is computed so _classify_success_tags_deterministic
        # can read the freshly-computed skill_score value. We pass a merged dict so
        # the new skill_score is visible even if it was set in this same iteration.
        if r["outcome_status"] == "win" and not (r["success_tags"] or ""):
            merged = dict(row_dict)
            # If skill_score was just computed above, merge it so the tag can fire.
            for i, s in enumerate(sets):
                if s == "skill_score=?":
                    merged["skill_score"] = vals[i]
            stags = _classify_success_tags_deterministic(merged)
            # BE-2 fix: write 'none' sentinel even when no tags fire so this row
            # doesn't re-enter the batch cap forever. Mirrors error_type='none' for
            # losses. Skill-score-less wins stay NULL until thesis_verdict arrives.
            sets.append("success_tags=?"); vals.append(stags if stags else "none")
        if sets:
            vals.append(r["id"])
            conn.execute(f"UPDATE ai_learning_events SET {', '.join(sets)} WHERE id=?", vals)
            resolved += 1
    return resolved


def _resolve_exit_quality_tags(conn, cap: int = 50) -> int:
    """Lazily fill exit_quality_tag for SELL/TRIM events that have an
    exit_signals_json snapshot but no tag yet. Idempotent, capped per call,
    runs alongside the other _resolve_* helpers inside _calib_compute().

    Scoped to SELL/TRIM only — exit timing quality is a property of the exit
    decision, distinct from classify_error_type_deterministic() (entry-centric,
    BUY/TOP_UP only).
    """
    rows = conn.execute("""
        SELECT id, exit_signals_json
          FROM ai_learning_events
         WHERE recommendation IN ('SELL','TRIM')
           AND exit_signals_json IS NOT NULL
           AND exit_signals_json != ''
           AND exit_quality_tag IS NULL
         ORDER BY timestamp DESC
         LIMIT ?
    """, (cap,)).fetchall()

    resolved = 0
    for r in rows:
        tag = classify_exit_quality_deterministic(r["exit_signals_json"])
        if tag is not None:
            conn.execute("UPDATE ai_learning_events SET exit_quality_tag=? WHERE id=?", (tag, r["id"]))
            resolved += 1
    return resolved


def _compute_exit_quality_nudge(conn, min_n: int = 5) -> str:
    """Behavioural nudge: do exit_into_strength exits actually leave money on
    the table? Joins exit_quality_tag against sell_verify_sold_chg (the
    already-resolved post-sell price change from _resolve_sell_outcomes()) so
    no new price-fetch logic is needed — reuses the existing 25-day-later
    verification pass.

    Gated on min_n per bucket (continuous-metric n-gate, mirroring
    _compute_thesis_drift's pattern — Wilson CI doesn't apply to an averaged
    percentage). Returns "" when ungated or no signal.
    """
    rows = conn.execute("""
        SELECT exit_quality_tag, sell_verify_sold_chg
          FROM ai_learning_events
         WHERE recommendation IN ('SELL','TRIM')
           AND exit_quality_tag IS NOT NULL
           AND sell_verify_sold_chg IS NOT NULL
    """).fetchall()
    if not rows:
        return ""
    by_tag: dict = {}
    for r in rows:
        by_tag.setdefault(r["exit_quality_tag"], []).append(r["sell_verify_sold_chg"])

    strength = by_tag.get("exit_into_strength", [])
    reversal = by_tag.get("exit_after_reversal_confirmed", [])
    if len(strength) < min_n:
        return ""
    avg_strength = sum(strength) / len(strength)
    # Only worth flagging if the ticker kept running materially after the exit.
    if avg_strength < 3.0:
        return ""
    if len(reversal) >= min_n:
        avg_reversal = sum(reversal) / len(reversal)
        return (
            f"⚠EXIT_INTO_STRENGTH: avg+{avg_strength:.1f}% post-exit (n={len(strength)}) "
            f"vs reversal-confirmed exits avg{avg_reversal:+.1f}% (n={len(reversal)}) "
            f"→ hold winners until momentum genuinely turns"
        )
    return (
        f"⚠EXIT_INTO_STRENGTH: sold while still bullish, stock kept running "
        f"+{avg_strength:.1f}% avg afterwards (n={len(strength)}) → don't cut winners early"
    )


def _resolve_missing_sectors(conn, cap: int = 50) -> int:
    """Backfill `sector` on executed events that logged it null/empty, using the
    static `core.SECTOR_MAP` (no network). Idempotent, capped per call, runs
    lazily inside _calib_compute() beside the other _resolve_* resolvers.

    Sector is a first-class analysis lens (calibration block + /api/learning/stats
    by_sector), so a null sector silently drops the row from every sector stat.
    This cleans historical rows that predate the liveSignals sector fallback.

    SECTOR_MAP is keyed by the bare ASX code (no '.AX' suffix); learning events
    store '.AX'-suffixed tickers, so we strip the suffix before lookup. Tickers
    not in the map are skipped (left null) — never guessed.
    """
    from core import SECTOR_MAP
    rows = conn.execute("""
        SELECT id, ticker
          FROM ai_learning_events
         WHERE was_executed = 1
           AND (sector IS NULL OR sector = '')
           AND ticker IS NOT NULL
         ORDER BY timestamp DESC
         LIMIT ?
    """, (cap,)).fetchall()

    resolved = 0
    for r in rows:
        tk = (r["ticker"] or "").upper()
        base = tk[:-3] if tk.endswith(".AX") else tk
        sec = SECTOR_MAP.get(base)
        if not sec:
            continue
        conn.execute("UPDATE ai_learning_events SET sector=? WHERE id=?", (sec, r["id"]))
        resolved += 1
    return resolved


def _is_good_loss(r: dict) -> bool:
    """Returns True for losses/breakevenents that reflect disciplined execution,
    not analytical error — must be excluded from Phase 8's skill-gate.

    Mirrors the _is_shock() exclusion logic used for confidence-band calibration.
    Two cases qualify:
      - exit_reason = 'protective_stop': deliberate capital-protection exit; the
        model correctly identified risk and acted; Ollama should (and does) score
        these 8–9/10 for good execution. Including them in loss_skills inflates
        mean_loss and can keep the Phase 8 gate permanently locked.
      - error_type contains 'external_shock': black-swan events outside the
        model's control — including them punishes correct analysis for bad luck.

    Accepts either a dict or a sqlite3.Row (the Phase 8 gate passes raw rows).
    """
    def _f(key):
        try:
            return r[key]
        except (KeyError, IndexError, TypeError):
            return r.get(key) if hasattr(r, "get") else None
    et = (_f("error_type") or "")
    er = (_f("exit_reason") or "")
    return er == "protective_stop" or "external_shock" in et.split(",")


def _mann_whitney_z(wins: list, losses: list) -> float:
    """Mann-Whitney U statistic normalised to a Z-score (no scipy required).

    Positive z means wins tend to score higher than losses.
    z > 1.28 ≈ one-sided p < 0.10  (Phase 8 activation threshold)
    z > 1.65 ≈ one-sided p < 0.05

    Uses the standard normal approximation — valid for n₁, n₂ ≥ 5.
    """
    n1, n2 = len(wins), len(losses)
    if n1 == 0 or n2 == 0:
        return 0.0
    u = sum(
        1.0 if w > l else (0.5 if w == l else 0.0)
        for w in wins for l in losses
    )
    mu    = n1 * n2 / 2
    sigma = math.sqrt(n1 * n2 * (n1 + n2 + 1) / 12)
    return (u - mu) / sigma if sigma > 0 else 0.0


def _compute_phase8_meta(skill_rows: list) -> dict:
    """Gap 2 — Phase 8 validation gate (Fix #10: Mann-Whitney U replaces mean compare).

    Phase 8 skill-weighting (sf = max(0.2, min(1.8, score/5.0))) is only
    trustworthy if Ollama's scores actually predict trade outcomes.

    Fix #10: the old mean comparison (mean_win > mean_loss) is flipped by a single
    outlier — e.g. a well-executed trade that hit an external shock scores 9/10 and
    inflates mean_loss, locking Phase 8 off even when the scorer is predictive across
    the other 9 events. Mann-Whitney U tests the full rank distribution; a single
    high-skill loss doesn't dominate.

    Threshold: z > 1.28 (one-sided p < 0.10). Returns z and threshold in the response
    so the Learning page can display the statistical evidence.
    """
    n = len(skill_rows)
    if n < 10:
        return {"active": False, "n_scored": n,
                "reason": f"insufficient scored events (need 10, have {n})"}
    win_skills = [float(r["skill_score"]) for r in skill_rows if r["outcome_status"] == "win"]
    # Exclude protective_stop + external_shock losses — disciplined capital protection
    # and black-swan events reflect execution quality, not analytical error. Including
    # their high scores in loss_skills would suppress Phase 8 despite correct analysis.
    good_loss_rows       = [r for r in skill_rows
                            if r["outcome_status"] in ("loss", "breakeven") and _is_good_loss(r)]
    analytical_loss_rows = [r for r in skill_rows
                            if r["outcome_status"] in ("loss", "breakeven") and not _is_good_loss(r)]
    loss_skills = [float(r["skill_score"]) for r in analytical_loss_rows]
    n_good_excl = len(good_loss_rows)
    if not win_skills or not loss_skills:
        return {"active": False, "n_scored": n, "n_good_losses_excluded": n_good_excl,
                "reason": "no wins or no analytical losses among scored events"}

    mean_win  = round(sum(win_skills)  / len(win_skills),  2)
    mean_loss = round(sum(loss_skills) / len(loss_skills), 2)
    z         = round(_mann_whitney_z(win_skills, loss_skills), 2)
    threshold = 1.28  # one-sided p < 0.10
    active    = z > threshold

    excl_note = f"; {n_good_excl} good-loss excluded" if n_good_excl else ""
    return {
        "active":                  active,
        "n_scored":                n,
        "n_good_losses_excluded":  n_good_excl,
        "mean_skill_wins":         mean_win,
        "mean_skill_losses":       mean_loss,
        "mann_whitney_z":          z,
        "mann_whitney_threshold":  threshold,
        "reason": (
            f"MW Z={z:.2f}>{threshold} — scores predict outcomes (wins={mean_win}, losses={mean_loss}{excl_note})"
            if active else
            f"MW Z={z:.2f}≤{threshold} — scores do NOT reliably predict wins — sf=1.0 applied"
        ),
    }


def _check_prompt_regression(version_list: list, min_n: int = 10) -> dict | None:
    """Gap 5 — prompt version regression detector.

    Compares the two most recent prompt versions with enough closed events.
    Returns a dict if current version shows a lower hit-rate than prior, else None.
    Uses binomial SE (50/50 worst-case) as the significance threshold:
      - drop > 1×SE → early warning (flag for monitoring)
      - drop > 2×SE → significant (flag for action)

    Fix #19: when a new version exists but is below the ESS floor, returns an
    "evaluating" dict instead of None — prevents silent false-negative on UI.
    None is now reserved for "no versions with any data at all".
    """
    eligible = [v for v in version_list
                if (v.get("closed") or 0) >= min_n and v.get("win_rate") is not None]

    # Fix #19: current version exists but below ESS floor — return evaluating, not None
    all_with_closes = [v for v in version_list if (v.get("closed") or 0) > 0]
    if len(eligible) < 2 and all_with_closes:
        current = all_with_closes[0]
        n = current.get("closed", 0)
        if n < min_n:
            se_pp = round(math.sqrt(0.25 / max(n, 1)) * 100, 1)
            return {
                "status":          "evaluating",
                "current_version": current["version"],
                "n_current":       n,
                "min_n_required":  min_n,
                "se_pp":           se_pp,
                "reason": (
                    f"Only {n}/{min_n} closed trades on {current['version']} — "
                    f"SE={se_pp}pp is too wide for reliable comparison. "
                    "No action needed; monitoring."
                ),
            }

    if len(eligible) < 2:
        return None  # No versions with data at all — nothing to report

    current, prior = eligible[0], eligible[1]
    curr_wr = current["win_rate"] / 100
    prev_wr = prior["win_rate"]  / 100
    drop    = prev_wr - curr_wr
    if drop <= 0:
        return None  # no regression — current is same or better; silent green is correct
    se = math.sqrt(0.25 / current["closed"])
    return {
        "status":           "regression",
        "current_version":  current["version"],
        "prior_version":    prior["version"],
        "current_win_rate": round(curr_wr * 100, 1),
        "prior_win_rate":   round(prev_wr * 100, 1),
        "drop_pp":          round(drop * 100, 1),
        "se_pp":            round(se   * 100, 1),
        "significant":      drop > 2 * se,
        "n_current":        current["closed"],
        "n_prior":          prior["closed"],
    }


def _wilson_ci(successes: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """Wilson score confidence interval for a proportion.

    Returns (lo, hi) as percentages (0–100), or None if n == 0.
    z=1.96 → 95% CI.
    """
    if n == 0:
        return None
    p = successes / n
    z2 = z * z
    denom = 1 + z2 / n
    centre = (p + z2 / (2 * n)) / denom
    spread = z * math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / denom
    lo = max(0.0, (centre - spread) * 100)
    hi = min(100.0, (centre + spread) * 100)
    return round(lo, 1), round(hi, 1)


def _ci_excludes(successes: int, n: int, threshold: float) -> bool:
    """True iff the Wilson 95% CI for successes/n lies entirely on one side of
    `threshold` (a fraction 0–1). Used to gate behaviour-changing nudges: only
    emit when the observed win-rate is *significantly* off the reference, so a
    3-of-5 fluke (whose CI spans the threshold) is correctly withheld.

    Operates on RAW integer counts (significance) even though the magnitude of the
    nudge is taken from the decay-weighted rate — counts carry the statistical
    power, weighting only re-centres the point estimate.
    """
    ci = _wilson_ci(successes, n)
    if not ci:
        return False
    lo, hi = ci
    t = threshold * 100
    return lo > t or hi < t


def _days_window_sql(alias=""):
    """Master date-window filter for the Learning page's dated list cards.

    If the request carries ?days=N (N>0), return an (SQL clause, param) pair that
    restricts `timestamp` to the last N days; otherwise ('', None) for the full
    history. `alias` optionally prefixes the column (e.g. 'e.') for joined
    queries. 'now','localtime' matches the insert-time convention
    (datetime('now','localtime')) so the window is day-accurate, not UTC-skewed.
    """
    try:
        days = int(request.args.get("days", 0))
    except (TypeError, ValueError):
        days = 0
    if days <= 0:
        return "", None
    col = f"{alias}timestamp" if alias else "timestamp"
    return f" AND {col} >= datetime('now','localtime',?)", f"-{days} days"


def _expire_old_events(conn) -> None:
    """Auto-expire open events older than 120 days. Called on write paths only (L3)."""
    conn.execute("""
        UPDATE ai_learning_events
        SET outcome_status = 'expired',
            notes = COALESCE(notes || ' | ', '') || 'Auto-expired: no outcome after 120 days'
        WHERE outcome_status = 'open'
          AND datetime(timestamp) < datetime('now', '-120 days')
    """)


@bp.route("/api/learning/log", methods=["POST"])
def learning_log():
    """Log an AI recommendation event for the learning loop."""
    data = request.get_json() or {}
    try:
        with get_db() as conn:
            _expire_old_events(conn)   # L3: side-effect on write, not GET
            # HOLD dedupe: HOLDs are re-generated for every holding on every
            # analysis run (unlike actionable recs, which get executed or
            # superseded), so without a window guard a daily-analysed 15-stock
            # book logs ~450 HOLD events/month — each needing its own yfinance
            # fetch in _resolve_hold_outcomes (capped 5/call, queue grows faster
            # than it drains) and repeated tickers dominating the hold_outcomes
            # miss-rate. One HOLD per ticker per window is the same passivity
            # signal; return the existing event id so the client's _learningId
            # bookkeeping still works.
            if (data.get("recommendation") == "HOLD"
                    and data.get("event_type", "recommendation") == "recommendation"):
                cutoff = (datetime.now() - timedelta(days=_HOLD_DEDUP_DAYS)) \
                    .strftime("%Y-%m-%d %H:%M:%S")
                dup = conn.execute("""
                    SELECT id FROM ai_learning_events
                     WHERE recommendation = 'HOLD' AND ticker = ?
                       AND timestamp >= ?
                     ORDER BY id DESC LIMIT 1
                """, (data.get("ticker"), cutoff)).fetchone()
                if dup:
                    return jsonify({"ok": True, "id": dup["id"], "deduped": True})
            conn.execute("""
                INSERT INTO ai_learning_events
                    (event_type, ticker, regime, prompt_version, agent_type,
                     ai_confidence, ensemble_confidence, recommendation, rationale_summary,
                     suggested_stop, suggested_target, rr_ratio, was_executed, market_context, notes,
                     outcome_status, realized_pnl_aud, realized_pnl_pct, holding_period_days, exit_reason,
                     actual_entry_price, actual_exit_price, sector,
                     skill_score, debate_summary, prompt_hash, error_type_source,
                     entry_signals_json, exit_signals_json, debate_synthesis_winner,
                     tags, trade_thesis,
                     sell_primary_driver, sell_secondary_factors, sell_urgency,
                     alternative_ticker, primary_entry_driver, thesis_verdict,
                     bull_case, bear_case, calibrated_confidence, trade_mode,
                     rule_warnings_json)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                data.get("event_type", "recommendation"),
                data.get("ticker"),
                data.get("regime"),
                data.get("prompt_version"),
                data.get("agent_type"),
                data.get("ai_confidence"),
                data.get("ensemble_confidence"),
                data.get("recommendation"),
                data.get("rationale_summary"),
                data.get("suggested_stop"),
                data.get("suggested_target"),
                data.get("rr_ratio"),
                1 if data.get("was_executed") else 0,
                json.dumps(data.get("market_context")) if data.get("market_context") else None,
                data.get("notes"),
                data.get("outcome_status"),
                data.get("realized_pnl_aud"),
                data.get("realized_pnl_pct"),
                data.get("holding_period_days"),
                data.get("exit_reason"),
                data.get("actual_entry_price"),
                data.get("actual_exit_price"),
                data.get("sector"),
                data.get("skill_score"),
                data.get("debate_summary"),
                data.get("prompt_hash"),
                data.get("error_type_source"),
                data.get("entry_signals_json"),
                data.get("exit_signals_json"),
                data.get("debate_synthesis_winner"),
                data.get("tags"),
                data.get("trade_thesis"),
                data.get("sell_primary_driver"),
                data.get("sell_secondary_factors"),
                data.get("sell_urgency"),
                data.get("alternative_ticker"),
                data.get("primary_entry_driver"),
                data.get("thesis_verdict"),
                data.get("bull_case"),
                data.get("bear_case"),
                data.get("calibrated_confidence"),
                # Paper/real firewall — default 'paper' so a mode-less event is
                # never treated as a real outcome. Paper events still calibrate
                # the model but at a discounted weight in _calib_compute().
                data.get("trade_mode") or "paper",
                # Failed-quant-rule capture (structured JSON array). Accept either a
                # pre-serialized string or a list/dict and normalise to a JSON string.
                (data.get("rule_warnings_json")
                 if isinstance(data.get("rule_warnings_json"), (str, type(None)))
                 else json.dumps(data.get("rule_warnings_json"))),
            ))
            row_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

        pv = data.get("prompt_version")
        if pv:
            with get_db() as conn:
                conn.execute(
                    "INSERT OR IGNORE INTO prompt_versions (version, created_at, description) VALUES (?, datetime('now','localtime'), 'Auto-registered')",
                    (pv,)
                )
                conn.execute("UPDATE prompt_versions SET total_calls = total_calls + 1 WHERE version=?", (pv,))

        return jsonify({"ok": True, "id": row_id})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/backfill-entry-drivers", methods=["POST"])
def backfill_entry_drivers():
    """Deterministically fill primary_entry_driver for historical BUY/TOP_UP rows
    that have an entry_signals_json snapshot but no driver yet.

    No Claude spend — uses classify_entry_driver() on the stored snapshot. Rows
    classified 'unknown' are left NULL so a future Claude/manual tag can set them.
    """
    try:
        updated = 0
        skipped = 0
        with get_db() as conn:
            rows = conn.execute("""
                SELECT id, entry_signals_json
                  FROM ai_learning_events
                 WHERE recommendation IN ('BUY', 'TOP_UP')
                   AND (primary_entry_driver IS NULL OR primary_entry_driver = '')
                   AND entry_signals_json IS NOT NULL
            """).fetchall()
            for row in rows:
                try:
                    sig = json.loads(row["entry_signals_json"] or "{}")
                except (ValueError, TypeError):
                    skipped += 1
                    continue
                driver = classify_entry_driver(sig)
                if driver == "unknown":
                    skipped += 1
                    continue
                conn.execute(
                    "UPDATE ai_learning_events SET primary_entry_driver=? WHERE id=?",
                    (driver, row["id"]),
                )
                updated += 1
        return jsonify({"ok": True, "updated": updated, "skipped": skipped,
                        "candidates": len(rows)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/entry-context", methods=["GET"])
def entry_context():
    """Return the most recent BUY/TOP_UP entry context for each requested ticker.

    GET /api/learning/entry-context?tickers=BHP.AX,CBA.AX

    For each ticker returns: entry_date, primary_entry_driver, entry_signals (parsed
    dict), trade_thesis. Prefers executed events (was_executed=1) over unexecuted,
    then most recent id. Tickers with no BUY/TOP_UP history are omitted from the
    response. Capped at 50 tickers.
    """
    raw = (request.args.get("tickers") or "").strip()
    tickers = [t.strip().upper() for t in raw.split(",") if t.strip()][:50]
    contexts = {}
    if not tickers:
        return jsonify({"ok": True, "contexts": contexts})
    try:
        with get_db() as conn:
            for tk in tickers:
                row = conn.execute("""
                    SELECT timestamp, primary_entry_driver, entry_signals_json, trade_thesis
                      FROM ai_learning_events
                     WHERE ticker = ? AND recommendation IN ('BUY','TOP_UP')
                     ORDER BY was_executed DESC, id DESC
                     LIMIT 1
                """, (tk,)).fetchone()
                if not row:
                    continue
                try:
                    sig = json.loads(row["entry_signals_json"] or "{}")
                    if not isinstance(sig, dict):
                        sig = {}
                except (ValueError, TypeError):
                    sig = {}
                contexts[tk] = {
                    "entry_date": row["timestamp"],
                    "primary_entry_driver": row["primary_entry_driver"],
                    "entry_signals": sig,
                    "trade_thesis": row["trade_thesis"],
                }
        return jsonify({"ok": True, "contexts": contexts})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/recent-rec", methods=["GET"])
def recent_rec():
    """Return the single most recent logged rec for one ticker, ANY action.

    GET /api/learning/recent-rec?ticker=BHP.AX

    Unlike entry-context (BUY/TOP_UP only, used for HOLDING_CONTEXT at SELL
    time), this is action-agnostic — used by the whipsaw/contradiction check
    in analysis.js to compare a new rec's entry signature + direction against
    whatever was last recommended for the same ticker, regardless of action.
    Returns {ok:true, rec:null} when the ticker has no history.
    """
    ticker = (request.args.get("ticker") or "").strip().upper()
    if not ticker:
        return jsonify({"ok": False, "error": "ticker required"}), 400
    try:
        with get_db() as conn:
            row = conn.execute("""
                SELECT recommendation, entry_signals_json, timestamp
                  FROM ai_learning_events
                 WHERE ticker = ?
                 ORDER BY id DESC
                 LIMIT 1
            """, (ticker,)).fetchone()
        if not row:
            return jsonify({"ok": True, "rec": None})
        try:
            sig = json.loads(row["entry_signals_json"] or "{}")
            if not isinstance(sig, dict):
                sig = {}
        except (ValueError, TypeError):
            sig = {}
        return jsonify({"ok": True, "rec": {
            "recommendation": row["recommendation"],
            "entry_signals":  sig,
            "timestamp":      row["timestamp"],
        }})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/hold-recs", methods=["GET"])
def hold_recs():
    """List logged HOLD recommendations with their 30-day passivity verdict.

    GET /api/learning/hold-recs[?limit=N]   (default 100, cap 200)

    HOLD recs never enter client rec state (analysis.js strips them from
    filteredRecs before state.recommendations is built) — they live only here,
    in ai_learning_events. This feeds the Learning-page "HOLD Decisions" card:
    each carries its virtual_outcome once _resolve_hold_outcomes grades it
    (≥30 days out), or a days-until-review countdown while still pending. The
    verdict IS the "30-day price check as performance review" — endpoint-based,
    direction-aware, vol-scaled (see _resolve_hold_outcomes).
    """
    try:
        limit = min(200, max(1, int(request.args.get("limit", 100))))
    except (TypeError, ValueError):
        limit = 100
    out = []
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT id, ticker, timestamp, ai_confidence, rationale_summary,
                       regime, sector, virtual_outcome
                  FROM ai_learning_events
                 WHERE recommendation = 'HOLD'
                 ORDER BY timestamp DESC
                 LIMIT ?
            """, (limit,)).fetchall()
        now = datetime.now()
        resolved_n = 0
        for r in rows:
            try:
                ts = datetime.strptime((r["timestamp"] or "")[:19], "%Y-%m-%d %H:%M:%S")
                age_days = (now - ts).days
            except (ValueError, TypeError):
                age_days = None
            vo = r["virtual_outcome"]
            resolved = vo in ("virtual_hold_miss", "virtual_hold_correct")
            if resolved:
                resolved_n += 1
            reason = (r["rationale_summary"] or "").strip()
            if len(reason) > 160:
                reason = reason[:157] + "…"
            out.append({
                "id":                 r["id"],
                "ticker":             r["ticker"],
                "timestamp":          r["timestamp"],
                "confidence":         r["ai_confidence"],
                "regime":             r["regime"],
                "sector":             r["sector"],
                "reasoning":          reason,
                "virtual_outcome":    vo,     # None | virtual_open | virtual_hold_miss | virtual_hold_correct
                "resolved":           resolved,
                "age_days":           age_days,
                # HOLDs resolve ≥30 days after generation (runway for the forward window).
                "days_until_review":  (max(0, 30 - age_days) if (not resolved and age_days is not None) else None),
            })
        return jsonify({"ok": True, "holds": out, "resolved_n": resolved_n, "n": len(out)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e), "holds": []}), 500


@bp.route("/api/learning/trade-detail", methods=["GET"])
def trade_detail():
    """Return rich per-trade detail for a set of learning-event ids.

    GET /api/learning/trade-detail?ids=12,15,18

    Used by the Trade Journal's expandable detail drawer to show the entry
    technical snapshot, thesis, entry/exit driver, thesis verdict, and outcome
    for AI-linked trades. Cap 50 ids. `entry_signals` is the parsed snapshot.
    """
    raw = (request.args.get("ids") or "").strip()
    ids = []
    for part in raw.split(","):
        part = part.strip()
        if part.isdigit():
            ids.append(int(part))
    ids = ids[:50]
    details = {}
    if not ids:
        return jsonify({"ok": True, "details": details})
    try:
        placeholders = ",".join("?" for _ in ids)
        with get_db() as conn:
            rows = conn.execute(f"""
                SELECT id, ticker, timestamp, recommendation, ai_confidence,
                       regime, prompt_version, suggested_stop, suggested_target,
                       rr_ratio, outcome_status, realized_pnl_pct, realized_pnl_aud,
                       holding_period_days, exit_reason, rationale_summary,
                       entry_signals_json, exit_signals_json, exit_quality_tag,
                       trade_thesis, primary_entry_driver,
                       thesis_verdict, sell_primary_driver, sell_secondary_factors,
                       success_tags, error_type
                  FROM ai_learning_events
                 WHERE id IN ({placeholders})
            """, ids).fetchall()
            def _parse_sig(blob):
                try:
                    parsed = json.loads(blob or "{}")
                    return parsed if isinstance(parsed, dict) else {}
                except (ValueError, TypeError):
                    return {}
            for row in rows:
                d = dict(row)
                d["entry_signals"] = _parse_sig(d.pop("entry_signals_json", None))
                d["exit_signals"]  = _parse_sig(d.pop("exit_signals_json", None))
                details[str(row["id"])] = d
        return jsonify({"ok": True, "details": details})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


_VERDICT_LIST = ("validated", "invalidated", "irrelevant", "partially_validated", "reversed")


def _compute_thesis_matrix(conn) -> dict:
    """Build the entry-driver × thesis-verdict accuracy matrix.

    Selects closed BUY/TOP_UP events that have BOTH primary_entry_driver AND
    thesis_verdict set, and a non-null realized_pnl_pct. A 'win' is
    realized_pnl_pct > 0.

    Returns a dict ready to be merged into the GET /api/learning/thesis-matrix
    response: n_total, drivers, verdicts, matrix, insight.
    """
    rows = conn.execute("""
        SELECT primary_entry_driver, thesis_verdict, realized_pnl_pct
          FROM ai_learning_events
         WHERE recommendation IN ('BUY','TOP_UP')
           AND outcome_status IN ('win','loss','breakeven')
           AND primary_entry_driver IS NOT NULL
           AND thesis_verdict IS NOT NULL
           AND realized_pnl_pct IS NOT NULL
    """).fetchall()

    # Build nested counts/sums keyed driver → verdict
    _data: dict = {}
    for r in rows:
        drv = r["primary_entry_driver"]
        vrd = r["thesis_verdict"]
        pnl = float(r["realized_pnl_pct"])
        if drv not in ENTRY_DRIVERS or vrd not in _VERDICT_LIST:
            continue
        bucket = _data.setdefault(drv, {}).setdefault(vrd, {"n": 0, "pnl_sum": 0.0, "wins": 0})
        bucket["n"] += 1
        bucket["pnl_sum"] += pnl
        if pnl > 0:
            bucket["wins"] += 1

    n_total = sum(
        b["n"]
        for drv_data in _data.values()
        for b in drv_data.values()
    )

    # Format the matrix: driver → verdict → {n, avg_pnl_pct, win_rate}
    matrix: dict = {}
    for drv in sorted(ENTRY_DRIVERS):
        drv_data = _data.get(drv, {})
        matrix[drv] = {}
        for vrd in _VERDICT_LIST:
            b = drv_data.get(vrd, {"n": 0, "pnl_sum": 0.0, "wins": 0})
            n = b["n"]
            matrix[drv][vrd] = {
                "n": n,
                "avg_pnl_pct": round(b["pnl_sum"] / n, 1) if n else 0.0,
                "win_rate": round(b["wins"] / n * 100, 1) if n else 0.0,
            }

    # Build insight: driver with best (validated WR − invalidated WR) gap where
    # both buckets have n≥5.
    best_driver = None
    best_gap = 0.0
    best_val_wr = 0.0
    best_inval_wr = 0.0
    best_n_val = 0
    best_n_inval = 0
    for drv, cells in matrix.items():
        val_cell   = cells.get("validated",   {"n": 0, "win_rate": 0.0})
        inval_cell = cells.get("invalidated", {"n": 0, "win_rate": 0.0})
        if val_cell["n"] >= 5 and inval_cell["n"] >= 5:
            gap = val_cell["win_rate"] - inval_cell["win_rate"]
            if gap > best_gap:
                best_gap      = gap
                best_driver   = drv
                best_val_wr   = val_cell["win_rate"]
                best_inval_wr = inval_cell["win_rate"]
                best_n_val    = val_cell["n"]
                best_n_inval  = inval_cell["n"]

    insight = ""
    if best_driver:
        insight = (
            f"{best_driver}: {best_val_wr:.0f}% win when thesis validated vs "
            f"{best_inval_wr:.0f}% when invalidated (n={best_n_val}/{best_n_inval})."
        )

    return {
        "n_total": n_total,
        "drivers": sorted(ENTRY_DRIVERS),
        "verdicts": list(_VERDICT_LIST),
        "matrix": matrix,
        "insight": insight,
    }


@bp.route("/api/learning/thesis-matrix", methods=["GET"])
def thesis_matrix():
    """Entry-driver × thesis-verdict accuracy matrix.

    GET /api/learning/thesis-matrix

    Returns n_total, drivers, verdicts, matrix (driver→verdict→{n,avg_pnl_pct,
    win_rate}), and a human-readable insight string for the driver with the largest
    validated vs invalidated win-rate gap (both buckets n≥5; else empty string).
    """
    try:
        with get_db() as conn:
            result = _compute_thesis_matrix(conn)
        return jsonify({"ok": True, **result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/outcome", methods=["POST"])
def learning_outcome():
    """Update the outcome of a previously logged event."""
    data = request.get_json() or {}
    event_id = data.get("id")
    if not event_id:
        return jsonify({"error": "id required"}), 400
    try:
        with get_db() as conn:
            # Build update dynamically so callers can send partial patches
            fields, vals = [], []
            for col in _ALLOWED_OUTCOME_COLS:
                if col in data:
                    fields.append(f"{col}=?")
                    vals.append(data[col])
            if "was_executed" in data:
                fields.append("was_executed=?")
                vals.append(1 if data["was_executed"] else 0)
            # When error_type is set by this endpoint (UI button), mark source as 'manual'
            if "error_type" in data:
                fields.append("error_type_source=?")
                vals.append("manual" if data["error_type"] else None)
            if not fields:
                return jsonify({"ok": True, "note": "nothing to update"})
            vals.append(event_id)
            conn.execute(
                f"UPDATE ai_learning_events SET {', '.join(fields)} WHERE id=?",
                vals,
            )
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/event/<int:event_id>", methods=["DELETE"])
def learning_delete_event(event_id):
    """Hard-delete a single learning event by id."""
    try:
        with get_db() as conn:
            rows = conn.execute(
                "DELETE FROM ai_learning_events WHERE id=?", (event_id,)
            ).rowcount
        if rows == 0:
            return jsonify({"ok": False, "error": "Event not found"}), 404
        return jsonify({"ok": True, "deleted": event_id})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/untagged")
def learning_untagged():
    """Return loss/breakeven events with no error_type set (error_type IS NULL).

    Used by the Learning page 'Classify All Untagged' button to build the
    batch postmortem queue.  Events already tagged 'none' are excluded —
    they have been reviewed and found to have no systematic error.

    Query params:
        limit (int, default 50): max events to return
    """
    limit = min(int(request.args.get("limit", 50)), 200)
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT id, ticker, recommendation, outcome_status,
                       ai_confidence, realized_pnl_pct, timestamp
                FROM ai_learning_events
                WHERE outcome_status IN ('loss', 'breakeven')
                  AND (error_type IS NULL OR error_type = '')
                  AND was_executed = 1
                ORDER BY timestamp DESC
                LIMIT ?
            """, (limit,)).fetchall()
        return jsonify({"ok": True, "events": [dict(r) for r in rows], "count": len(rows)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/coverage")
def learning_coverage():
    """Data-hygiene coverage for the Learning page coverage strip (IMPROVEMENTS #3).

    The learning loop's biggest silent failure mode is *capture decay*: a
    column stops being filled (dead input, never-run backfill, resolver
    starvation) and every analytics surface built on it quietly empties.
    Historically these gaps were only findable by ad-hoc SQL. This endpoint
    reports, per capture, how much of the eligible population actually has
    the data, plus the work-queue counts (stuck-open events, pending virtual
    resolutions, lessons). Read-only, cheap (COUNT queries only), no lazy
    resolvers triggered — it measures state, it doesn't change it.

    Each coverage entry: {covered, total, pct} where pct is None when the
    eligible population is empty (no denominator ≠ 0% coverage).
    """
    def _cov(covered, total):
        return {"covered": covered, "total": total,
                "pct": round(covered / total * 100, 1) if total else None}
    try:
        with get_db() as conn:
            def _n(sql, args=()):
                return conn.execute(sql, args).fetchone()[0]

            closed = "outcome_status IN ('win','loss','breakeven') AND was_executed = 1"
            entry  = "recommendation IN ('BUY','TOP_UP')"
            exits  = "recommendation IN ('SELL','TRIM')"
            T = "ai_learning_events"

            n_closed      = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed}")
            n_loss_be     = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND outcome_status IN ('loss','breakeven')")
            n_loss_tagged = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND outcome_status IN ('loss','breakeven') AND error_type IS NOT NULL AND error_type != ''")
            n_wins        = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND outcome_status = 'win'")
            n_wins_tagged = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND outcome_status = 'win' AND success_tags IS NOT NULL AND success_tags != ''")
            n_ce          = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND {entry}")
            n_ce_driver   = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND {entry} AND primary_entry_driver IS NOT NULL")
            n_ce_thesis   = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND {entry} AND thesis_verdict IS NOT NULL")
            n_ce_maemfe   = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND {entry} AND mae_pct IS NOT NULL")
            n_cx          = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND {exits}")
            n_cx_exitsig  = _n(f"SELECT COUNT(*) FROM {T} WHERE {closed} AND {exits} AND exit_signals_json IS NOT NULL")

            # Work queues -----------------------------------------------------
            # Executed but never graded — after 60d these are almost always a
            # missed Sync (Performance page), not a genuinely open position.
            stale_cutoff = (datetime.now() - timedelta(days=60)).strftime("%Y-%m-%d %H:%M:%S")
            n_stuck_open = _n(f"""SELECT COUNT(*) FROM {T}
                WHERE was_executed = 1
                  AND (outcome_status IS NULL OR outcome_status = 'open')
                  AND timestamp < ?""", (stale_cutoff,))
            # Unexecuted recs awaiting the 30d virtual-outcome gate (needs
            # stop+target — HOLDs have their own resolver below).
            n_virtual_pending = _n(f"""SELECT COUNT(*) FROM {T}
                WHERE was_executed = 0 AND virtual_outcome IS NULL
                  AND suggested_stop IS NOT NULL AND suggested_target IS NOT NULL
                  AND recommendation != 'HOLD'""")
            oldest_pending = conn.execute(f"""SELECT MIN(timestamp) FROM {T}
                WHERE was_executed = 0 AND virtual_outcome IS NULL
                  AND suggested_stop IS NOT NULL AND suggested_target IS NOT NULL
                  AND recommendation != 'HOLD'""").fetchone()[0]
            days_until_virtual = None
            if oldest_pending:
                try:
                    age = (datetime.now() - datetime.fromisoformat(oldest_pending.replace(" ", "T"))).days
                    days_until_virtual = max(0, 30 - age)
                except (ValueError, TypeError):
                    pass
            n_hold          = _n(f"SELECT COUNT(*) FROM {T} WHERE recommendation = 'HOLD'")
            n_hold_resolved = _n(f"SELECT COUNT(*) FROM {T} WHERE recommendation = 'HOLD' AND virtual_outcome IS NOT NULL")
            n_lessons       = _n("SELECT COUNT(*) FROM trading_lessons")

        return jsonify({
            "ok": True,
            "n_closed": n_closed,
            "coverage": {
                "error_type":     _cov(n_loss_tagged, n_loss_be),
                "success_tags":   _cov(n_wins_tagged, n_wins),
                "entry_driver":   _cov(n_ce_driver, n_ce),
                "thesis_verdict": _cov(n_ce_thesis, n_ce),
                "mae_mfe":        _cov(n_ce_maemfe, n_ce),
                "exit_signals":   _cov(n_cx_exitsig, n_cx),
            },
            "queues": {
                "stuck_open_60d":     n_stuck_open,
                "virtual_pending":    n_virtual_pending,
                "days_until_virtual": days_until_virtual,
                "hold_events":        n_hold,
                "hold_resolved":      n_hold_resolved,
                "lessons":            n_lessons,
            },
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Go-live readiness scorecard thresholds (tunable) ─────────────────────────
# Turns "is the model good enough to trade live?" into a checklist. The user is
# running a ≥6-month PAPER validation before funding real trades; this scores
# the paper track record against objective bars. Paper fills are frictionless
# (brokerage only, no spread/slippage), so every P&L-based criterion applies a
# per-trade friction haircut first — a paper edge inside costs is not a real edge.
_GOLIVE_MIN_CLOSED       = 40      # closed trades before an edge estimate is trustworthy
_GOLIVE_WARN_CLOSED      = 20      # amber floor
_GOLIVE_MIN_REGIMES      = 3       # edge must hold across market states, not one
# Calibration HONESTY = |mean stated confidence − actual win rate|. This is the
# reliability gap, NOT Brier: Brier has an irreducible p(1−p) floor (a perfectly
# honest 65%-win model still scores 0.2275), so a Brier<0.20 bar is unachievable
# for any 55–70% system and would punish honesty. The gap has no such floor —
# it's 0 exactly when confidence matches reality, which is what feeds Kelly sizing.
_GOLIVE_MAX_CALIB_GAP    = 0.07    # ≤7pp between stated confidence and actual WR
_GOLIVE_WARN_CALIB_GAP   = 0.12
_GOLIVE_FRICTION_BPS      = 30     # round-trip haircut per trade (0.30%) — ASX200 tier
_GOLIVE_MIN_POS_DRIVERS  = 2       # entry archetypes with positive post-cost expectancy
_GOLIVE_MIN_DRIVER_N     = 5       # per-driver sample floor


def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def _compute_go_live_readiness(conn, friction_bps=_GOLIVE_FRICTION_BPS):
    """Score the (paper) track record against the go-live bars. Pure read.

    Returns {ok, n_closed, friction_bps, overall, n_pass, n_total, criteria[]}.
    Each criterion: {key, label, status: pass|warn|fail, detail, value, target}.
    """
    haircut = friction_bps / 100.0   # bps → percentage points (30 bps = 0.30 pp)

    rows = conn.execute("""
        SELECT outcome_status, realized_pnl_pct, regime, primary_entry_driver,
               ai_confidence, recommendation
        FROM ai_learning_events
        WHERE was_executed = 1
          AND outcome_status IN ('win','loss','breakeven')
    """).fetchall()
    rows = [dict(r) for r in rows]
    n_closed = len(rows)

    crit = []

    # 1 — Sample size ---------------------------------------------------------
    if n_closed >= _GOLIVE_MIN_CLOSED:
        s1 = "pass"
    elif n_closed >= _GOLIVE_WARN_CLOSED:
        s1 = "warn"
    else:
        s1 = "fail"
    crit.append({"key": "sample", "label": "Sample size",
                 "status": s1, "value": n_closed, "target": _GOLIVE_MIN_CLOSED,
                 "detail": f"{n_closed} closed trades (need {_GOLIVE_MIN_CLOSED}+ for a trustworthy edge estimate)"})

    # 2 — Regime coverage -----------------------------------------------------
    regimes = {r["regime"] for r in rows if r["regime"]}
    n_reg = len(regimes)
    s2 = "pass" if n_reg >= _GOLIVE_MIN_REGIMES else "warn" if n_reg == 2 else "fail"
    crit.append({"key": "regimes", "label": "Regime coverage",
                 "status": s2, "value": n_reg, "target": _GOLIVE_MIN_REGIMES,
                 "detail": (f"{n_reg} distinct regime(s): {', '.join(sorted(regimes)) or 'none'} "
                            f"(need {_GOLIVE_MIN_REGIMES}+ — an edge in one regime isn't proven)")})

    # 3 — Calibration honesty (confidence vs actual WR) -----------------------
    wl = [r for r in rows if r["outcome_status"] in ("win", "loss")
          and r["ai_confidence"] is not None]
    n_wl = len(wl)
    if n_wl:
        mean_conf = _mean([float(r["ai_confidence"]) for r in wl])
        actual_wr = sum(1 for r in wl if r["outcome_status"] == "win") / n_wl
        gap = abs(mean_conf - actual_wr)
        brier = sum((float(r["ai_confidence"]) - (1.0 if r["outcome_status"] == "win" else 0.0)) ** 2
                    for r in wl) / n_wl   # kept for the detail line only
    else:
        mean_conf = actual_wr = gap = brier = None
    # Brier trend: earliest vs latest daily snapshot (secondary signal only).
    snaps = conn.execute(
        "SELECT brier_score FROM calibration_snapshots WHERE brier_score IS NOT NULL "
        "ORDER BY snapshot_date ASC").fetchall()
    trend = None
    if len(snaps) >= 2:
        first_b, last_b = snaps[0]["brier_score"], snaps[-1]["brier_score"]
        trend = "improving" if last_b <= first_b + 0.005 else "worsening"
    if gap is None or n_wl < _GOLIVE_WARN_CLOSED:
        s3 = "warn"
    elif gap <= _GOLIVE_MAX_CALIB_GAP and trend != "worsening":
        s3 = "pass"
    elif gap <= _GOLIVE_WARN_CALIB_GAP:
        s3 = "warn"
    else:
        s3 = "fail"
    crit.append({"key": "calibration", "label": "Calibration honesty",
                 "status": s3,
                 "value": round(gap * 100, 1) if gap is not None else None,
                 "target": round(_GOLIVE_MAX_CALIB_GAP * 100, 1),
                 "detail": ((f"Stated confidence {round(mean_conf*100,1)}% vs actual win-rate "
                             f"{round(actual_wr*100,1)}% → {round(gap*100,1)}pp gap "
                             f"(target ≤{round(_GOLIVE_MAX_CALIB_GAP*100)}pp; Brier {round(brier,3)}, trend {trend or 'n/a'})")
                            if gap is not None else
                            f"Need {_GOLIVE_WARN_CLOSED}+ win/loss with confidence to judge (have {n_wl})")})

    # 4 — Edge survives friction (win-rate CI vs break-even) ------------------
    adj = [(float(r["realized_pnl_pct"]) - haircut) for r in rows
           if r["realized_pnl_pct"] is not None]
    wins = [a for a in adj if a > 0]
    losses = [a for a in adj if a < 0]
    n_wl2 = len(wins) + len(losses)
    expectancy = round(_mean(adj), 3) if adj else None
    p_lo = break_even = p_pt = None
    if n_wl2 >= 1:
        ci = _wilson_ci(len(wins), n_wl2)
        p_lo = ci[0] / 100.0 if ci else None
        p_pt = len(wins) / n_wl2
        avg_win = _mean(wins)
        avg_loss = _mean([abs(x) for x in losses])
        break_even = avg_loss / (avg_win + avg_loss) if (avg_win + avg_loss) > 0 else 0.0
    if p_lo is None or break_even is None or n_closed < _GOLIVE_WARN_CLOSED:
        s4 = "warn"
    elif p_lo > break_even:
        s4 = "pass"
    elif p_pt is not None and p_pt > break_even:
        s4 = "warn"   # point estimate clears it but the CI doesn't yet
    else:
        s4 = "fail"
    crit.append({"key": "edge", "label": "Edge survives friction",
                 "status": s4,
                 "value": round(p_lo * 100, 1) if p_lo is not None else None,
                 "target": round(break_even * 100, 1) if break_even is not None else None,
                 "detail": (f"After {friction_bps}bps/trade haircut: win-rate {round(p_pt*100,1) if p_pt is not None else '—'}% "
                            f"(95% CI low {round(p_lo*100,1) if p_lo is not None else '—'}%) vs break-even "
                            f"{round(break_even*100,1) if break_even is not None else '—'}%; "
                            f"expectancy {expectancy if expectancy is not None else '—'}%/trade")})

    # 5 — Per-driver expectancy (post-friction) -------------------------------
    by_driver = {}
    for r in rows:
        d = r["primary_entry_driver"]
        if not d or r["realized_pnl_pct"] is None:
            continue
        by_driver.setdefault(d, []).append(float(r["realized_pnl_pct"]) - haircut)
    eligible = {d: v for d, v in by_driver.items() if len(v) >= _GOLIVE_MIN_DRIVER_N}
    positive = {d: _mean(v) for d, v in eligible.items() if _mean(v) > 0}
    n_pos = len(positive)
    if n_pos >= _GOLIVE_MIN_POS_DRIVERS:
        s5 = "pass"
    elif n_pos == 1 or len(eligible) < _GOLIVE_MIN_POS_DRIVERS:
        s5 = "warn"
    else:
        s5 = "fail"
    crit.append({"key": "drivers", "label": "Profitable entry archetypes",
                 "status": s5, "value": n_pos, "target": _GOLIVE_MIN_POS_DRIVERS,
                 "detail": (f"{n_pos} driver(s) with positive post-cost expectancy "
                            f"(n≥{_GOLIVE_MIN_DRIVER_N} each) of {len(eligible)} eligible: "
                            f"{', '.join(sorted(positive)) or 'none yet'}")})

    n_pass = sum(1 for c in crit if c["status"] == "pass")
    if any(c["status"] == "fail" for c in crit):
        overall = "not_ready"
    elif n_pass == len(crit):
        overall = "ready"
    else:
        overall = "almost"

    return {"ok": True, "n_closed": n_closed, "friction_bps": friction_bps,
            "overall": overall, "n_pass": n_pass, "n_total": len(crit),
            "criteria": crit}


@bp.route("/api/learning/go-live-readiness")
def learning_go_live_readiness():
    """Go-live readiness scorecard — is the paper track record strong enough to
    fund live trading? Read-only; five friction-adjusted criteria (see
    _compute_go_live_readiness). ?friction_bps=N overrides the per-trade haircut."""
    try:
        fb = request.args.get("friction_bps", _GOLIVE_FRICTION_BPS)
        try:
            fb = max(0, min(200, int(fb)))
        except (TypeError, ValueError):
            fb = _GOLIVE_FRICTION_BPS
        with get_db() as conn:
            return jsonify(_compute_go_live_readiness(conn, fb))
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/stats")
def learning_stats():
    """Return learning loop stats: win rates by confidence band, regime, prompt version."""
    try:
        with get_db() as conn:
            total  = conn.execute("SELECT COUNT(*) FROM ai_learning_events").fetchone()[0]
            closed = conn.execute(
                "SELECT COUNT(*) FROM ai_learning_events WHERE outcome_status IN ('win','loss','breakeven')"
            ).fetchone()[0]
            wins   = conn.execute(
                "SELECT COUNT(*) FROM ai_learning_events WHERE outcome_status='win'"
            ).fetchone()[0]

            # Confidence bands (with Wilson 95% CI)
            conf_bands = []
            for lo, hi in [(0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 1.01)]:
                rows = conn.execute("""
                    SELECT outcome_status, COUNT(*) as cnt FROM ai_learning_events
                    WHERE ai_confidence >= ? AND ai_confidence < ?
                      AND outcome_status IN ('win','loss','breakeven')
                    GROUP BY outcome_status
                """, (lo, hi)).fetchall()
                band_wins  = sum(r['cnt'] for r in rows if r['outcome_status'] == 'win')
                band_total = sum(r['cnt'] for r in rows)
                ci = _wilson_ci(band_wins, band_total)
                conf_bands.append({
                    "band":     f"{int(lo*100)}-{int(hi*100)}%",
                    "wins":     band_wins,
                    "total":    band_total,
                    "win_rate": round(band_wins / band_total * 100, 1) if band_total else None,
                    "ci_lo":    ci[0] if ci else None,
                    "ci_hi":    ci[1] if ci else None,
                    "low_n":    band_total < 30,
                })

            # Overall Wilson CI
            overall_ci = _wilson_ci(wins, closed)

            # Regime stats
            regime_rows = conn.execute("""
                SELECT regime, outcome_status, COUNT(*) as cnt FROM ai_learning_events
                WHERE regime IS NOT NULL AND outcome_status IN ('win','loss','breakeven')
                GROUP BY regime, outcome_status
            """).fetchall()
            regime_agg: dict = {}
            for r in regime_rows:
                reg = r['regime']
                if reg not in regime_agg:
                    regime_agg[reg] = {'wins': 0, 'total': 0}
                regime_agg[reg]['total'] += r['cnt']
                if r['outcome_status'] == 'win':
                    regime_agg[reg]['wins'] += r['cnt']
            regime_list = []
            for k, v in sorted(regime_agg.items()):
                ci = _wilson_ci(v['wins'], v['total'])
                regime_list.append({
                    "regime":   k,
                    "wins":     v['wins'],
                    "total":    v['total'],
                    "win_rate": round(v['wins'] / v['total'] * 100, 1) if v['total'] else None,
                    "ci_lo":    ci[0] if ci else None,
                    "ci_hi":    ci[1] if ci else None,
                    "low_n":    v['total'] < 30,
                })

            # Prompt version stats
            pv_rows = conn.execute("""
                SELECT pv.version, pv.total_calls,
                       COALESCE(SUM(CASE WHEN e.outcome_status='win' THEN 1 ELSE 0 END), 0) as wins,
                       COALESCE(SUM(CASE WHEN e.outcome_status IN ('win','loss','breakeven') THEN 1 ELSE 0 END), 0) as closed,
                       COALESCE(SUM(CASE WHEN e.realized_pnl_aud IS NOT NULL THEN e.realized_pnl_aud ELSE 0 END), 0) as total_pnl
                FROM prompt_versions pv
                LEFT JOIN ai_learning_events e ON e.prompt_version = pv.version
                GROUP BY pv.version ORDER BY pv.created_at DESC
            """).fetchall()
            version_list = [{
                "version":     r['version'],
                "total_calls": r['total_calls'],
                "wins":        r['wins'],
                "closed":      r['closed'],
                "win_rate":    round(r['wins'] / r['closed'] * 100, 1) if r['closed'] else None,
                "total_pnl":   round(r['total_pnl'], 2) if r['total_pnl'] else None,
            } for r in pv_rows]

            # Avg hold days for closed trades
            hold_row = conn.execute("""
                SELECT AVG(holding_period_days) FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven')
                  AND holding_period_days IS NOT NULL
            """).fetchone()
            avg_hold_days = round(hold_row[0], 1) if hold_row and hold_row[0] else None

            # Exit reason distribution
            exit_rows = conn.execute("""
                SELECT exit_reason, COUNT(*) as cnt FROM ai_learning_events
                WHERE exit_reason IS NOT NULL
                GROUP BY exit_reason ORDER BY cnt DESC
            """).fetchall()
            exit_reason_dist = {r['exit_reason']: r['cnt'] for r in exit_rows}

            # R:R stats — suggested rr and win rate when rr_ratio >= 2.0
            rr_rows = conn.execute("""
                SELECT AVG(rr_ratio) as avg_rr,
                       SUM(CASE WHEN rr_ratio >= 2.0 AND outcome_status='win' THEN 1 ELSE 0 END) as hi_rr_wins,
                       SUM(CASE WHEN rr_ratio >= 2.0 AND outcome_status IN ('win','loss','breakeven') THEN 1 ELSE 0 END) as hi_rr_total,
                       COUNT(*) as rr_sample
                FROM ai_learning_events
                WHERE rr_ratio IS NOT NULL
            """).fetchone()
            rr_stats = {}
            if rr_rows and rr_rows['rr_sample']:
                hi_total = rr_rows['hi_rr_total'] or 0
                rr_stats = {
                    "avg_suggested_rr": round(rr_rows['avg_rr'], 2) if rr_rows['avg_rr'] else None,
                    "hi_rr_win_rate": round(rr_rows['hi_rr_wins'] / hi_total * 100, 1) if hi_total else None,
                    "hi_rr_sample": hi_total,
                    "sample": rr_rows['rr_sample'],
                }

            # Recent events (richer — include error_type, source, debate_summary for UI)
            recent = conn.execute("""
                SELECT id, timestamp, ticker, recommendation, ai_confidence, ensemble_confidence,
                       outcome_status, realized_pnl_pct, realized_pnl_aud, regime, prompt_version,
                       was_executed, suggested_stop, suggested_target, rr_ratio,
                       holding_period_days, exit_reason, rationale_summary,
                       error_type, error_type_source, debate_summary, skill_score,
                       postmortem_debate, success_tags, checklist_bypasses,
                       sell_primary_driver, sell_secondary_factors, sell_urgency,
                       primary_entry_driver,
                       virtual_outcome, virtual_speed_weight, virtual_slippage_applied
                FROM ai_learning_events ORDER BY timestamp DESC LIMIT 30
            """).fetchall()

            # Virtual outcome count — for calibration stats card display
            n_virtual_resolved = conn.execute("""
                SELECT COUNT(*) FROM ai_learning_events
                WHERE was_executed = 0
                  AND virtual_outcome IN ('virtual_win', 'virtual_loss')
            """).fetchone()[0]

            # Debate insights — events that have a stored debate_summary (for Insights card)
            debate_rows = conn.execute("""
                SELECT id, timestamp, ticker, outcome_status, realized_pnl_pct, debate_summary
                FROM ai_learning_events
                WHERE debate_summary IS NOT NULL AND debate_summary != ''
                ORDER BY timestamp DESC LIMIT 5
            """).fetchall()
            debate_insights = [dict(r) for r in debate_rows]

            # Failure patterns — exit_reason and error_type breakdown for closed trades
            fail_exit = conn.execute("""
                SELECT exit_reason, COUNT(*) as cnt FROM ai_learning_events
                WHERE exit_reason IS NOT NULL AND outcome_status IN ('win','loss','breakeven')
                GROUP BY exit_reason ORDER BY cnt DESC
            """).fetchall()
            # error_type may be comma-separated (multi-tag) — split and aggregate
            fail_type_rows = conn.execute("""
                SELECT error_type FROM ai_learning_events
                WHERE error_type IS NOT NULL AND error_type != ''
            """).fetchall()
            type_counts: dict = {}
            for r in fail_type_rows:
                for tag in (r["error_type"] or "").split(","):
                    tag = tag.strip()
                    # "none" means model found no systematic error — not an error pattern
                    if tag and tag != "none":
                        type_counts[tag] = type_counts.get(tag, 0) + 1
            failure_patterns = {
                "by_exit_reason": {r["exit_reason"]: r["cnt"] for r in fail_exit},
                "by_error_type":  dict(sorted(type_counts.items(), key=lambda x: -x[1])),
            }

            # Success patterns — success_tags distribution for wins
            success_tag_rows = conn.execute("""
                SELECT success_tags FROM ai_learning_events
                WHERE success_tags IS NOT NULL AND success_tags != ''
                  AND outcome_status = 'win'
            """).fetchall()
            success_counts: dict = {}
            for r in success_tag_rows:
                for tag in (r["success_tags"] or "").split(","):
                    tag = tag.strip()
                    if tag and tag != "none":
                        success_counts[tag] = success_counts.get(tag, 0) + 1
            # Disciplined-hold duration + payoff (request 2026-07-09). The
            # `disciplined_hold` success tag marks an executed WIN held ≥5 days
            # that reached target (no premature exit) — distinct from HOLD recs.
            # Surface how long those disciplined holds actually ran and what they
            # paid, so "held patiently" has concrete numbers under it. Small-n
            # gated: min/max are noise below 3, so expose avg-only there.
            dh_rows = conn.execute("""
                SELECT holding_period_days, realized_pnl_pct
                  FROM ai_learning_events
                 WHERE outcome_status = 'win'
                   AND success_tags LIKE '%disciplined_hold%'
            """).fetchall()
            dh_days = [r["holding_period_days"] for r in dh_rows
                       if r["holding_period_days"] is not None]
            dh_rets = [r["realized_pnl_pct"] for r in dh_rows
                       if r["realized_pnl_pct"] is not None]
            disciplined_hold_stats = None
            if dh_days:
                n_dh = len(dh_days)
                disciplined_hold_stats = {
                    "n":        n_dh,
                    "days_min": min(dh_days) if n_dh >= 3 else None,
                    "days_avg": round(sum(dh_days) / n_dh, 1),
                    "days_max": max(dh_days) if n_dh >= 3 else None,
                    "ret_avg":  round(sum(dh_rets) / len(dh_rets), 2) if dh_rets else None,
                }
            success_patterns = {
                "by_success_type": dict(sorted(success_counts.items(), key=lambda x: -x[1])),
                "disciplined_hold_stats": disciplined_hold_stats,
            }

            # Sprint 71 sector analysis: per-sector stats framed vs the whole-market
            # baseline. `wr_vs_market_pp` is the signed delta against `overall_win_rate`
            # (the all-rows WR already returned at the top of this response) — the
            # whole-ASX-market view IS the baseline, so an absolute sector WR is only
            # actionable as a delta. dominant_error_tag splits multi-tag error_type on
            # ',' (gotcha #45) and excludes 'none'/'external_shock'.
            sector_rows = conn.execute("""
                SELECT sector, outcome_status, realized_pnl_pct, error_type
                  FROM ai_learning_events
                 WHERE sector IS NOT NULL AND sector != ''
                   AND outcome_status IN ('win','loss','breakeven')
            """).fetchall()
            _mkt_wr_pct = (wins / closed * 100) if closed else 0.0
            sec_agg: dict = {}
            for r in sector_rows:
                sec = r["sector"]
                a = sec_agg.setdefault(sec, {
                    "n": 0, "wins": 0, "pnl_sum": 0.0, "pnl_n": 0, "err": {},
                })
                a["n"] += 1
                if r["outcome_status"] == "win":
                    a["wins"] += 1
                if r["realized_pnl_pct"] is not None:
                    a["pnl_sum"] += float(r["realized_pnl_pct"])
                    a["pnl_n"]   += 1
                # multi-tag split (gotcha #45) — losses/breakevens carry error_type
                for tag in (r["error_type"] or "").split(","):
                    tag = tag.strip()
                    if tag and tag not in ("none", "external_shock"):
                        a["err"][tag] = a["err"].get(tag, 0) + 1
            by_sector = []
            for sec, a in sec_agg.items():
                wr_pct = (a["wins"] / a["n"] * 100) if a["n"] else None
                dom = max(a["err"].items(), key=lambda x: x[1])[0] if a["err"] else None
                by_sector.append({
                    "sector":          sec,
                    "n":               a["n"],
                    "win_rate":        round(wr_pct, 1) if wr_pct is not None else None,
                    "avg_pnl_pct":     round(a["pnl_sum"] / a["pnl_n"], 2) if a["pnl_n"] else None,
                    "wr_vs_market_pp": round(wr_pct - _mkt_wr_pct, 1) if wr_pct is not None else None,
                    "dominant_error_tag": dom,
                })
            by_sector.sort(key=lambda s: s["n"], reverse=True)

            # Failed tickers
            failed = conn.execute(
                "SELECT ticker, error, context, timestamp FROM failed_tickers ORDER BY id DESC LIMIT 20"
            ).fetchall()

            # Gap 2: Phase 8 skill-weighting validation
            # Fix #16: include exit_reason and error_type so _is_good_loss() can filter them
            skill_rows_raw = conn.execute("""
                SELECT skill_score, outcome_status, exit_reason, error_type
                FROM ai_learning_events
                WHERE skill_score IS NOT NULL
                  AND outcome_status IN ('win','loss','breakeven')
            """).fetchall()
            phase8 = _compute_phase8_meta([dict(r) for r in skill_rows_raw])

            # Sprint 71 Phase 2D: stop_too_tight tag-precision counterfactual.
            stop_tag_precision_stat = _compute_stop_tag_precision(conn)

            # HOLD outcome tracking: surfaced here (not just the compact
            # calibration token) so the Learning page can show it directly.
            hold_row = conn.execute("""
                SELECT
                    SUM(CASE WHEN virtual_outcome='virtual_hold_miss'    THEN 1 ELSE 0 END) AS n_miss,
                    SUM(CASE WHEN virtual_outcome='virtual_hold_correct' THEN 1 ELSE 0 END) AS n_correct
                FROM ai_learning_events
                WHERE recommendation = 'HOLD'
            """).fetchone()
            _hold_n_miss    = hold_row["n_miss"] or 0
            _hold_n_correct = hold_row["n_correct"] or 0
            _hold_n          = _hold_n_miss + _hold_n_correct
            hold_outcomes = {
                "n":          _hold_n,
                "miss_rate":  round(_hold_n_miss / _hold_n * 100, 1) if _hold_n else None,
                "correct_rate": round(_hold_n_correct / _hold_n * 100, 1) if _hold_n else None,
            }

            # ── Deepening fields ───────────────────────────────────────────────

            # a) BUY vs TOP_UP performance split
            buy_vs_topup_rows = conn.execute("""
                SELECT recommendation,
                       COUNT(*) AS n,
                       SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) AS wins,
                       AVG(realized_pnl_pct) AS avg_pnl,
                       AVG(holding_period_days) AS avg_hold
                FROM ai_learning_events
                WHERE recommendation IN ('BUY','TOP_UP')
                  AND outcome_status IN ('win','loss','breakeven')
                GROUP BY recommendation
            """).fetchall()
            buy_vs_topup = {r["recommendation"]: {
                "n": r["n"], "wins": r["wins"],
                "win_rate": round(r["wins"]/r["n"]*100, 1) if r["n"] else None,
                "avg_pnl": round(r["avg_pnl"], 2) if r["avg_pnl"] is not None else None,
                "avg_hold": round(r["avg_hold"], 1) if r["avg_hold"] is not None else None,
            } for r in buy_vs_topup_rows}

            # a2) REAL vs PAPER performance split (gotcha #88) — does paper-trade
            # performance actually predict real-trade performance? Groups closed
            # executed outcomes by trade_mode (NULL ⇒ paper, matching the
            # isRealTrade() invariant). Empty-safe: {} when no closed trades.
            real_vs_paper_rows = conn.execute("""
                SELECT CASE WHEN trade_mode='real' THEN 'real' ELSE 'paper' END AS mode,
                       COUNT(*) AS n,
                       SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) AS wins,
                       AVG(realized_pnl_pct) AS avg_pnl,
                       AVG(holding_period_days) AS avg_hold
                FROM ai_learning_events
                WHERE was_executed=1
                  AND outcome_status IN ('win','loss','breakeven')
                GROUP BY 1
            """).fetchall()
            real_vs_paper = {r["mode"]: {
                "n": r["n"], "wins": r["wins"],
                "win_rate": round(r["wins"]/r["n"]*100, 1) if r["n"] else None,
                "avg_pnl": round(r["avg_pnl"], 2) if r["avg_pnl"] is not None else None,
                "avg_hold": round(r["avg_hold"], 1) if r["avg_hold"] is not None else None,
            } for r in real_vs_paper_rows}

            # b) Capital efficiency (pnl/day by entry driver)
            cap_eff_rows = conn.execute("""
                SELECT primary_entry_driver,
                       COUNT(*) AS n,
                       AVG(CASE WHEN holding_period_days > 0
                           THEN realized_pnl_pct / holding_period_days ELSE NULL END) AS avg_pnl_per_day,
                       AVG(realized_pnl_pct) AS avg_pnl,
                       AVG(holding_period_days) AS avg_hold
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven')
                  AND realized_pnl_pct IS NOT NULL
                  AND holding_period_days IS NOT NULL AND holding_period_days > 0
                  AND primary_entry_driver IS NOT NULL AND primary_entry_driver != ''
                GROUP BY primary_entry_driver
                ORDER BY avg_pnl_per_day DESC NULLS LAST
            """).fetchall()
            capital_efficiency = [{
                "driver": r["primary_entry_driver"],
                "n": r["n"],
                "avg_pnl_per_day": round(r["avg_pnl_per_day"], 3) if r["avg_pnl_per_day"] is not None else None,
                "avg_pnl": round(r["avg_pnl"], 2) if r["avg_pnl"] is not None else None,
                "avg_hold": round(r["avg_hold"], 1) if r["avg_hold"] is not None else None,
            } for r in cap_eff_rows]

            # c) Ensemble divergence cross-tab
            ens_div_rows = conn.execute("""
                SELECT
                    CASE WHEN ABS(COALESCE(ensemble_confidence, ai_confidence) - ai_confidence) > 0.10
                         THEN 'diverged' ELSE 'aligned' END AS div_group,
                    COUNT(*) AS n,
                    SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) AS wins
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven')
                  AND ai_confidence IS NOT NULL
                GROUP BY div_group
            """).fetchall()
            ensemble_divergence = {r["div_group"]: {
                "n": r["n"], "wins": r["wins"],
                "win_rate": round(r["wins"]/r["n"]*100, 1) if r["n"] else None,
            } for r in ens_div_rows}

            # d) MAE/MFE distribution summary
            mae_mfe_row = conn.execute("""
                SELECT
                    AVG(CASE WHEN outcome_status='win'  THEN mae_pct END) AS avg_mae_wins,
                    AVG(CASE WHEN outcome_status='loss' THEN mae_pct END) AS avg_mae_losses,
                    AVG(CASE WHEN outcome_status='win'  THEN mfe_pct END) AS avg_mfe_wins,
                    AVG(CASE WHEN outcome_status='loss' THEN mfe_pct END) AS avg_mfe_losses,
                    COUNT(CASE WHEN mae_pct IS NOT NULL AND outcome_status='win'  THEN 1 END) AS n_mae_wins,
                    COUNT(CASE WHEN mae_pct IS NOT NULL AND outcome_status='loss' THEN 1 END) AS n_mae_losses
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven')
            """).fetchone()
            mae_mfe_summary = {
                "avg_mae_wins":   round(mae_mfe_row["avg_mae_wins"], 2)   if mae_mfe_row["avg_mae_wins"]   is not None else None,
                "avg_mae_losses": round(mae_mfe_row["avg_mae_losses"], 2) if mae_mfe_row["avg_mae_losses"] is not None else None,
                "avg_mfe_wins":   round(mae_mfe_row["avg_mfe_wins"], 2)   if mae_mfe_row["avg_mfe_wins"]   is not None else None,
                "avg_mfe_losses": round(mae_mfe_row["avg_mfe_losses"], 2) if mae_mfe_row["avg_mfe_losses"] is not None else None,
                "n_wins":  mae_mfe_row["n_mae_wins"]   or 0,
                "n_losses": mae_mfe_row["n_mae_losses"] or 0,
            }

        oci = overall_ci
        # Gap 5: prompt regression detector (uses version_list already built above)
        prompt_regression = _check_prompt_regression(version_list)

        return jsonify({
            "total":              total,
            "closed":             closed,
            "wins":               wins,
            "overall_win_rate":   round(wins / closed * 100, 1) if closed else None,
            "overall_ci_lo":      oci[0] if oci else None,
            "overall_ci_hi":      oci[1] if oci else None,
            "calibration_active": closed >= 30,  # True when n is large enough to trust CI
            "insufficient_data":  closed < 10,  # flag for UI to soften calibration display
            "conf_bands":         conf_bands,
            "regime_stats":       regime_list,
            "version_stats":      version_list,
            "recent_events":      [dict(r) for r in recent],
            "failed_tickers":     [dict(r) for r in failed],
            "avg_hold_days":      avg_hold_days,
            "exit_reason_dist":   exit_reason_dist,
            "rr_stats":           rr_stats,
            "failure_patterns":   failure_patterns,
            "success_patterns":   success_patterns,
            "debate_insights":    debate_insights,
            "phase8":             phase8,           # Gap 2: skill-weighting gate status
            "prompt_regression":  prompt_regression, # Gap 5: prompt version regression
            "n_virtual_resolved": n_virtual_resolved, # virtual outcome count for UI display
            "stop_tag_precision": stop_tag_precision_stat,  # Sprint 71 Phase 2D
            "by_sector":          by_sector,    # Sprint 71: per-sector WR vs market baseline
            "hold_outcomes":      hold_outcomes,  # HOLD passivity calibration (virtual_hold_miss/correct)
            "buy_vs_topup":       buy_vs_topup,
            "real_vs_paper":      real_vs_paper,  # gotcha #88: paper as predictor of real
            "capital_efficiency": capital_efficiency,
            "ensemble_divergence": ensemble_divergence,
            "mae_mfe_summary":    mae_mfe_summary,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/learning/debate-stats")
def learning_debate_stats():
    """
    Aggregate statistics from stored adversarial-debate transcripts.
    Groups by (model_a, model_b) pair and counts each verdict type.
    Also tracks concede rate (when DIVERGED → Phase 3, how often A conceded).

    Response:
        {
          "pairs": [
            {
              "model_a": "qwen3.5:9b", "model_b": "gemma3:4b",
              "total": 12, "consensus": 5, "partial": 4, "diverged": 3,
              "singleton_a": 0, "singleton_b": 0,
              "concede_count": 1, "concede_total": 3, "concede_rate": 0.33
            }, ...
          ],
          "total_debates": 12
        }
    """
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT postmortem_debate
                FROM ai_learning_events
                WHERE postmortem_debate IS NOT NULL AND postmortem_debate != ''
            """).fetchall()
    except Exception as ex:
        return jsonify({"error": str(ex)}), 500

    pairs: dict = {}   # (model_a, model_b) → stats dict
    skipped = 0

    for r in rows:
        try:
            d = json.loads(r["postmortem_debate"])
        except Exception:
            skipped += 1
            continue
        p1 = d.get("phase_1") or {}
        ma = p1.get("model_a") or "?"
        mb = p1.get("model_b") or "?"
        verdict = d.get("verdict") or "?"
        key = (ma, mb)
        p = pairs.setdefault(key, {
            "model_a":      ma,
            "model_b":      mb,
            "total":        0,
            "consensus":    0,
            "partial":      0,
            "diverged":     0,
            "singleton_a":  0,
            "singleton_b":  0,
            "concede_count": 0,
            "concede_total": 0,
        })
        p["total"] += 1
        if   verdict == "CONSENSUS":   p["consensus"]   += 1
        elif verdict == "PARTIAL":     p["partial"]     += 1
        elif verdict == "SINGLETON_A": p["singleton_a"] += 1
        elif verdict == "SINGLETON_B": p["singleton_b"] += 1
        elif verdict == "DIVERGED":
            p["diverged"]      += 1
            p["concede_total"] += 1
            # Phase 3 transcript records maintain=true/false
            if (d.get("phase_3") or {}).get("maintains") is False:
                p["concede_count"] += 1

    result_pairs = []
    for p in sorted(pairs.values(), key=lambda x: -x["total"]):
        p["concede_rate"] = round(p["concede_count"] / p["concede_total"], 2) \
            if p["concede_total"] else None
        result_pairs.append(p)

    return jsonify({
        "pairs":         result_pairs,
        "total_debates": sum(p["total"] for p in result_pairs),
        "skipped":       skipped,
    })


_DIGEST_MIN_N = 6  # minimum bucket/cell size before a cross-tab cell is reported —
                    # same small-n suppression philosophy as _ESS_MIN elsewhere (gotcha #42):
                    # a "pattern" computed off 2-3 trades is sampling noise, not signal.


def _compute_digest_aggregates(rows: list[dict]) -> dict:
    """Pure cross-tab aggregation over the digest's closed-trade sample.

    `rows` are dict-like sqlite Rows already fetched by the caller (one query,
    reused for both these aggregates and exemplar selection — see
    learning_digest_data()). Every cross-tab cell is gated at n>=_DIGEST_MIN_N;
    macro-bucket and driver cells are additionally CI-flagged (via _ci_excludes)
    when they're significantly off the overall win rate, so the digest prompt
    can distinguish "this is a real divergence" from "this is just noise."
    """
    n_total = len(rows)
    if n_total == 0:
        return {"n": 0}

    n_wins = sum(1 for r in rows if r["outcome_status"] == "win")
    overall_wr = n_wins / n_total

    # ── Macro-bucket cross-tab: win rate vs the CLASSIFIED regime ignores the
    # raw macro tape. A trade can be tagged "trend" regardless of whether SPI
    # futures were up or down that morning — this answers "does it matter
    # independent of the label?" Buckets derived from market_context JSON
    # (gotcha: this field only carries macro data on events logged after this
    # feature shipped — older rows have it null/partial, which is fine, they
    # just don't contribute to these specific buckets).
    buckets: dict = {}
    for r in rows:
        try:
            mc = json.loads(r["market_context"]) if r["market_context"] else {}
        except Exception:
            mc = {}
        vol = mc.get("asx_vol_20d")
        adl = mc.get("advance_decline_ratio")
        if isinstance(vol, (int, float)):
            buckets.setdefault(f"vol_{'high' if vol >= 18 else 'low'}", []).append(r)
        if isinstance(adl, (int, float)):
            buckets.setdefault(f"breadth_{'above50' if adl >= 0.5 else 'below50'}", []).append(r)

    macro_bucket_stats = []
    for label, brows in buckets.items():
        n = len(brows)
        if n < _DIGEST_MIN_N:
            continue
        wins = sum(1 for r in brows if r["outcome_status"] == "win")
        macro_bucket_stats.append({
            "bucket": label, "n": n,
            "win_rate": round(wins / n * 100, 1),
            "flagged": _ci_excludes(wins, n, overall_wr),
        })
    macro_bucket_stats.sort(key=lambda x: -x["n"])

    # ── thesis_verdict × outcome — the luck-vs-skill split. invalidated/reversed
    # losses are process errors (the read on the setup was wrong, fixable);
    # validated losses are bad variance (the thesis held, the trade still lost —
    # not something a rule change fixes). See gotcha #59 for the verdict taxonomy.
    verdict_counts: dict = {}
    for r in rows:
        v = r["thesis_verdict"] or "unresolved"
        d = verdict_counts.setdefault(v, {"n": 0, "wins": 0})
        d["n"] += 1
        if r["outcome_status"] == "win":
            d["wins"] += 1
    thesis_verdict_xtab = [
        {"verdict": v, "n": d["n"], "win_rate": round(d["wins"] / d["n"] * 100, 1)}
        for v, d in verdict_counts.items() if d["n"] >= 3 and v != "unresolved"
    ]

    # ── skill_score / ai_confidence avg, win vs loss — is the model's own
    # process-quality self-score and its stated conviction actually tracking
    # the outcome, or flat across both buckets (i.e. not discriminating)?
    def _avg(vals):
        return round(sum(vals) / len(vals), 2) if len(vals) >= 3 else None

    skill_win  = [r["skill_score"] for r in rows if r["outcome_status"] == "win" and r["skill_score"] is not None]
    skill_loss = [r["skill_score"] for r in rows if r["outcome_status"] in ("loss", "breakeven") and r["skill_score"] is not None]
    conf_win   = [r["ai_confidence"] for r in rows if r["outcome_status"] == "win" and r["ai_confidence"] is not None]
    conf_loss  = [r["ai_confidence"] for r in rows if r["outcome_status"] in ("loss", "breakeven") and r["ai_confidence"] is not None]

    # ── exit_quality_tag distribution — systemic early-exit/panic-exit detection
    # across the whole sample, not just the single existing nudge (gotcha #64).
    exit_quality_dist: dict = {}
    for r in rows:
        t = r["exit_quality_tag"]
        if t:
            exit_quality_dist[t] = exit_quality_dist.get(t, 0) + 1

    # ── entry-driver win rate (primary_entry_driver, BUY/TOP_UP only by construction)
    driver_counts: dict = {}
    for r in rows:
        dr = r["primary_entry_driver"]
        if not dr:
            continue
        d = driver_counts.setdefault(dr, {"n": 0, "wins": 0})
        d["n"] += 1
        if r["outcome_status"] == "win":
            d["wins"] += 1
    driver_xtab = [
        {"driver": dr, "n": d["n"], "win_rate": round(d["wins"] / d["n"] * 100, 1),
         "flagged": _ci_excludes(d["wins"], d["n"], overall_wr)}
        for dr, d in driver_counts.items() if d["n"] >= _DIGEST_MIN_N
    ]
    driver_xtab.sort(key=lambda x: -x["n"])

    return {
        "n": n_total,
        "overall_win_rate":  round(overall_wr * 100, 1),
        "macro_bucket_stats": macro_bucket_stats,
        "thesis_verdict_xtab": thesis_verdict_xtab,
        "skill_score_avg":   {"win": _avg(skill_win), "loss": _avg(skill_loss)},
        "confidence_avg":    {"win": _avg(conf_win),  "loss": _avg(conf_loss)},
        "exit_quality_dist": exit_quality_dist,
        "driver_xtab":       driver_xtab,
    }


def _format_digest_exemplar(row: dict) -> str:
    """Render one curated trade as a compact, information-dense line for the
    digest prompt: action/ticker/regime/macro context, entry→exit technical
    delta, tags, P&L, and a short bull/bear-case quote (mirrors the reasoning-
    text exemplar pattern already used in deep calibration — gotcha #47)."""
    def _j(raw):
        try:
            return json.loads(raw) if raw else {}
        except Exception:
            return {}

    entry = _j(row.get("entry_signals_json"))
    exitd = _j(row.get("exit_signals_json"))
    mc    = _j(row.get("market_context"))

    def _n(v, suffix=""):
        return f"{v}{suffix}" if isinstance(v, (int, float)) else "?"

    tech = (f"RSI {_n(entry.get('rsi_14'))}→{_n(exitd.get('rsi_14'))}, "
            f"BB%b {_n(entry.get('bb_pct_b'))}→{_n(exitd.get('bb_pct_b'))}")
    macro = (f"vol{_n(mc.get('asx_vol_20d'))} "
             f"breadth{_n(mc.get('advance_decline_ratio'))}")
    tags = ",".join(t for t in [row.get("error_type"), row.get("success_tags"),
                                 row.get("thesis_verdict"), row.get("exit_quality_tag")] if t)
    case_text = (row.get("bear_case") if row.get("outcome_status") != "win" and row.get("bear_case")
                 else row.get("bull_case")) or ""
    case_str = f' — "{case_text.strip()[:70]}"' if case_text.strip() else ""

    pnl = row.get("realized_pnl_pct")
    pnl_str = f"{pnl:+.1f}%" if isinstance(pnl, (int, float)) else "?"
    days = row.get("holding_period_days")
    days_str = f" in {days}d" if days else ""

    return (f"- {row.get('ticker')} ({row.get('recommendation') or '?'}, "
            f"{row.get('regime') or '?'} regime, {macro}): {pnl_str}{days_str}. "
            f"Tech {tech}. Tags: {tags or 'none'}{case_str}")


def _select_digest_exemplars(rows: list[dict], cap: int = 15) -> list[dict]:
    """Hand-pick the most instructive trades from the sample rather than a
    blind top-N-by-recency: worst losses, best wins, process failures
    (thesis invalidated/reversed), validated stop-widening evidence
    (stop_cf_saved), and early-exit-drag cases. Capped well below the full
    fetch (~150) because these go verbatim into the LLM prompt body — see
    the digest design note: aggregate over many, show the model only a few
    rich examples."""
    by_id = {}

    def _take(candidates, n):
        for r in candidates[:n]:
            by_id[r["id"]] = r

    losses = [r for r in rows if r["outcome_status"] in ("loss", "breakeven")
              and isinstance(r["realized_pnl_pct"], (int, float))]
    losses.sort(key=lambda r: r["realized_pnl_pct"])
    _take(losses, 5)

    wins = [r for r in rows if r["outcome_status"] == "win"
            and isinstance(r["realized_pnl_pct"], (int, float))]
    wins.sort(key=lambda r: -r["realized_pnl_pct"])
    _take(wins, 3)

    process_fail = [r for r in rows if r["thesis_verdict"] in ("invalidated", "reversed")]
    _take(process_fail, 3)

    stop_saved = [r for r in rows if r["stop_cf_saved"] == 1]
    _take(stop_saved, 3)

    early_exit = [r for r in rows if r["exit_quality_tag"] == "exit_into_strength"
                  and isinstance(r["sell_verify_sold_chg"], (int, float))
                  and r["sell_verify_sold_chg"] >= 3]
    _take(early_exit, 3)

    return list(by_id.values())[:cap]


@bp.route("/api/learning/digest-data")
def learning_digest_data():
    """Structured data for the AI Postmortem Digest prompt.

    Pulls up to 150 recent closed trades (wins included — you can't separate
    luck from skill or see what's working if the sample is loss-only) with
    full technical/macro/tag context, computes CI-gated cross-tab aggregates
    over the whole sample, and hand-picks ~15 rich exemplars for the prompt
    body. See CLAUDE.md "AI Postmortem Digest" for the full design rationale.
    """
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT id, ticker, sector, regime, regime_at_execution, ai_confidence,
                       ensemble_confidence, recommendation, outcome_status,
                       realized_pnl_pct, realized_pnl_aud, holding_period_days,
                       exit_reason, error_type, success_tags, primary_entry_driver,
                       thesis_verdict, sell_primary_driver, sell_urgency, skill_score,
                       mae_pct, mfe_pct, rr_ratio, trade_thesis, bull_case, bear_case,
                       entry_signals_json, exit_signals_json, market_context, timestamp,
                       prompt_version, stop_cf_saved, exit_quality_tag, sell_verify_sold_chg
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven') AND was_executed = 1
                ORDER BY timestamp DESC
                LIMIT 150
            """).fetchall()
            rows = [dict(r) for r in rows]

            regime_rows = conn.execute("""
                SELECT regime,
                       SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) as wins,
                       COUNT(*) as total
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven') AND was_executed=1
                GROUP BY regime
            """).fetchall()

            # BE-3 fix: aggregate error_dist by splitting multi-tag error_type on
            # ',' so "thesis_broken,overconfident" counts as two separate tags
            # rather than one opaque compound bucket.  Mirrors the split-on-','
            # convention used in failure_patterns / by_sector / _is_shock etc.
            _error_dist_rows = conn.execute("""
                SELECT error_type
                FROM ai_learning_events
                WHERE outcome_status IN ('loss','breakeven') AND was_executed=1
                  AND error_type IS NOT NULL AND error_type != ''
            """).fetchall()
            _err_counter: dict = {}
            for _er in _error_dist_rows:
                for _tag in (_er["error_type"] or "").split(","):
                    _tag = _tag.strip()
                    if _tag and _tag not in ("none", "external_shock"):
                        _err_counter[_tag] = _err_counter.get(_tag, 0) + 1
            error_dist = [{"error_type": k, "n": v}
                          for k, v in sorted(_err_counter.items(), key=lambda x: -x[1])]

            exit_dist = conn.execute("""
                SELECT exit_reason, COUNT(*) as n
                FROM ai_learning_events
                WHERE outcome_status IN ('loss','breakeven') AND was_executed=1
                  AND exit_reason IS NOT NULL AND exit_reason != ''
                GROUP BY exit_reason
                ORDER BY n DESC
            """).fetchall()

        regime_stats = [
            {
                "regime": r["regime"] or "unknown",
                "wins": r["wins"],
                "total": r["total"],
                "win_rate": round(r["wins"] / r["total"] * 100, 1) if r["total"] else None,
            }
            for r in regime_rows
        ]
        overall_total = sum(r["total"] for r in regime_rows)
        overall_wins  = sum(r["wins"] for r in regime_rows)

        aggregates = _compute_digest_aggregates(rows)
        exemplar_rows = _select_digest_exemplars(rows)
        exemplars = [_format_digest_exemplar(r) for r in exemplar_rows]

        return jsonify({
            "n_sample":           len(rows),
            "regime_stats":       regime_stats,
            "overall_wins":       overall_wins,
            "overall_total":      overall_total,
            "error_dist":         error_dist,
            "exit_dist":          [dict(r) for r in exit_dist],
            "aggregates":         aggregates,
            "exemplars":          exemplars,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/learning/lesson-source")
def learning_lesson_source():
    """Structured dataset for the AI Lesson Generator (manual-trigger only).

    Sibling of /digest-data, but tuned for *lesson synthesis* rather than a
    free-text postmortem: pulls the most recent N closed+executed trades (BUY,
    TOP_UP, SELL, TRIM — wins AND losses, since a lesson must know what works,
    not just what failed), reuses the same CI-gated cross-tab aggregates, and
    returns a WIDER curated exemplar set (cap 30 vs the digest's 15) so Claude
    has enough concrete cases to generalise from.

    Unlike the digest (which produces prose for the user to read), this feeds a
    prompt whose output is parsed into scoped rows written to `trading_lessons`,
    which are then injected back into every future decision prompt. The point of
    the larger sample / exemplar cap is to bias toward durable, repeatable
    patterns over one-off recency.

    Query: ?n=100 (default 100, clamped 30..200).
    """
    try:
        try:
            n = int(request.args.get("n", 100))
        except (TypeError, ValueError):
            n = 100
        n = max(30, min(200, n))

        with get_db() as conn:
            rows = conn.execute("""
                SELECT id, ticker, sector, regime, regime_at_execution, ai_confidence,
                       ensemble_confidence, recommendation, outcome_status,
                       realized_pnl_pct, realized_pnl_aud, holding_period_days,
                       exit_reason, error_type, success_tags, primary_entry_driver,
                       thesis_verdict, sell_primary_driver, sell_urgency, skill_score,
                       mae_pct, mfe_pct, rr_ratio, trade_thesis, bull_case, bear_case,
                       entry_signals_json, exit_signals_json, market_context, timestamp,
                       prompt_version, stop_cf_saved, exit_quality_tag, sell_verify_sold_chg
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven') AND was_executed = 1
                ORDER BY timestamp DESC
                LIMIT ?
            """, (n,)).fetchall()
            rows = [dict(r) for r in rows]

            regime_rows = conn.execute("""
                SELECT regime,
                       SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) as wins,
                       COUNT(*) as total
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven') AND was_executed=1
                GROUP BY regime
            """).fetchall()

            # Error distribution — split multi-tag error_type on ',' (gotcha #45).
            _error_dist_rows = conn.execute("""
                SELECT error_type
                FROM ai_learning_events
                WHERE outcome_status IN ('loss','breakeven') AND was_executed=1
                  AND error_type IS NOT NULL AND error_type != ''
            """).fetchall()
            _err_counter: dict = {}
            for _er in _error_dist_rows:
                for _tag in (_er["error_type"] or "").split(","):
                    _tag = _tag.strip()
                    if _tag and _tag not in ("none", "external_shock"):
                        _err_counter[_tag] = _err_counter.get(_tag, 0) + 1
            error_dist = [{"error_type": k, "n": v}
                          for k, v in sorted(_err_counter.items(), key=lambda x: -x[1])]

            # Entry-driver × outcome (BUY/TOP_UP) — what setup styles actually pay.
            buy_driver_rows = conn.execute("""
                SELECT primary_entry_driver as driver,
                       SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) as wins,
                       COUNT(*) as total,
                       ROUND(AVG(realized_pnl_pct), 2) as avg_pnl
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven') AND was_executed=1
                  AND recommendation IN ('BUY','TOP_UP')
                  AND primary_entry_driver IS NOT NULL AND primary_entry_driver != ''
                GROUP BY primary_entry_driver
            """).fetchall()
            buy_drivers = [
                {"driver": r["driver"], "wins": r["wins"], "total": r["total"],
                 "win_rate": round(r["wins"] / r["total"] * 100, 1) if r["total"] else None,
                 "avg_pnl": r["avg_pnl"]}
                for r in buy_driver_rows if r["total"] >= _DIGEST_MIN_N
            ]

            # Last 60 trading-day macro snapshots for trend context in the lesson prompt.
            _macro_hist_rows = conn.execute("""
                SELECT snapshot_date, asx200_chg, aud_usd_chg, gold_chg, oil_chg,
                       iron_ore_chg, spi200_futures_chg, asx_vol_20d,
                       advance_decline_ratio, vix_level, sp500_chg, copper_chg, us10y_level
                FROM macro_snapshots
                ORDER BY snapshot_date DESC
                LIMIT 60
            """).fetchall()
            macro_history = [dict(r) for r in _macro_hist_rows]

        regime_stats = [
            {"regime": r["regime"] or "unknown", "wins": r["wins"], "total": r["total"],
             "win_rate": round(r["wins"] / r["total"] * 100, 1) if r["total"] else None}
            for r in regime_rows
        ]
        overall_total = sum(r["total"] for r in regime_rows)
        overall_wins  = sum(r["wins"] for r in regime_rows)

        aggregates = _compute_digest_aggregates(rows)
        exemplar_rows = _select_digest_exemplars(rows, cap=30)
        exemplars = [_format_digest_exemplar(r) for r in exemplar_rows]

        return jsonify({
            "n_sample":      len(rows),
            "n_requested":   n,
            "regime_stats":  regime_stats,
            "overall_wins":  overall_wins,
            "overall_total": overall_total,
            "error_dist":    error_dist,
            "buy_drivers":   buy_drivers,
            "aggregates":    aggregates,
            "exemplars":     exemplars,
            "macro_history": macro_history,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


def _compute_scrutiny_stats(conn, cap_exemplars: int = 3) -> dict:
    """Aggregate local-LLM (24B Ollama) scrutiny verdicts vs eventual outcomes.

    Each scrutiny event (written by POST /api/debate/scrutinize, manually
    triggered per-rec) records whether the local critic *agreed* or
    *disagreed* with Claude's rec at generation time. Once the rec eventually
    closes (outcome_status win/loss), score whether the critic's skepticism
    was warranted: disagree+loss or agree+win = critic "right"; the inverse =
    "wrong". Breakevens/open positions are excluded — no clear right/wrong
    signal yet. Accuracy is n-gated at _DIGEST_MIN_N (same small-n suppression
    philosophy as the rest of this module) so a handful of scrutinized trades
    can't produce a misleadingly confident percentage.
    """
    rows = conn.execute("""
        SELECT ticker, recommendation, local_scrutiny_json,
               outcome_status, realized_pnl_pct
        FROM ai_learning_events
        WHERE local_scrutiny_json IS NOT NULL
        ORDER BY timestamp DESC
        LIMIT 300
    """).fetchall()

    n_scrutinized, n_agree, n_disagree = 0, 0, 0
    n_disagree_resolved, n_disagree_right = 0, 0
    n_agree_resolved, n_agree_right = 0, 0
    exemplars = []

    for r in rows:
        try:
            sc = json.loads(r["local_scrutiny_json"] or "{}")
        except Exception:
            continue
        verdict = sc.get("verdict")
        if verdict not in ("agree", "disagree", "uncertain"):
            continue
        n_scrutinized += 1
        if verdict == "agree":
            n_agree += 1
        elif verdict == "disagree":
            n_disagree += 1

        outcome = r["outcome_status"]
        if outcome not in ("win", "loss") or verdict == "uncertain":
            continue
        was_win = outcome == "win"
        if verdict == "disagree":
            n_disagree_resolved += 1
            critic_right = not was_win
            if critic_right:
                n_disagree_right += 1
            if len(exemplars) < cap_exemplars:
                exemplars.append({
                    "ticker":           r["ticker"],
                    "action":           r["recommendation"],
                    "concerns":         sc.get("concerns"),
                    "outcome":          outcome,
                    "realized_pnl_pct": r["realized_pnl_pct"],
                    "critic_right":     critic_right,
                })
        elif verdict == "agree":
            n_agree_resolved += 1
            if was_win:
                n_agree_right += 1

    return {
        "n_scrutinized":       n_scrutinized,
        "n_agree":             n_agree,
        "n_disagree":          n_disagree,
        "disagree_rate":       round(n_disagree / n_scrutinized * 100, 1) if n_scrutinized else None,
        "n_disagree_resolved": n_disagree_resolved,
        "disagree_accuracy":   round(n_disagree_right / n_disagree_resolved * 100, 1) if n_disagree_resolved >= _DIGEST_MIN_N else None,
        "n_agree_resolved":    n_agree_resolved,
        "agree_accuracy":      round(n_agree_right / n_agree_resolved * 100, 1) if n_agree_resolved >= _DIGEST_MIN_N else None,
        "exemplars":           exemplars,
    }


@bp.route("/api/learning/scrutiny-stats", methods=["GET"])
def learning_scrutiny_stats():
    """Read-only rollup of local-LLM scrutiny verdicts vs eventual outcomes.

    Powers the 'Local critic feedback' summary consumed by the AI Lesson
    Generator (js/pages/learning.js generateTradingLessons()) so Claude gets a
    second opinion's track record, not a raw dump of every scrutiny event.
    """
    try:
        with get_db() as conn:
            return jsonify({"ok": True, **_compute_scrutiny_stats(conn)})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/calibration-stats")
def learning_calibration_stats():
    """Brier score + reliability-diagram bins.

    Brier score = mean((confidence - outcome)^2); outcome=1 for win, 0 otherwise.
    Lower is better (perfect model = 0, random = 0.25).
    """
    try:
        with get_db() as conn:
            # Sprint 70: Brier is a binary-outcome score. Breakevens were previously
            # folded in as 'loss' (0.0), biasing the score and the reliability bins.
            # Exclude them — only unambiguous win/loss outcomes belong here.
            rows = conn.execute("""
                SELECT ai_confidence, outcome_status
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss')
                  AND ai_confidence IS NOT NULL
            """).fetchall()

        n = len(rows)
        if n == 0:
            return jsonify({"brier_score": None, "n": 0, "bins": []})

        sq_errors = [
            (float(r["ai_confidence"]) - (1.0 if r["outcome_status"] == "win" else 0.0)) ** 2
            for r in rows
        ]
        brier = round(sum(sq_errors) / n, 4)

        # Learning Loop improvement E: persist one snapshot per calendar day so
        # Brier score can be plotted over time instead of only ever showing the
        # latest value — this endpoint already runs regularly from the Learning
        # page, so piggybacking here avoids a separate scheduler thread.
        # UNIQUE(snapshot_date) makes this idempotent (INSERT OR REPLACE updates
        # the same-day row rather than duplicating on repeated calls).
        try:
            with get_db() as conn:
                today = datetime.now().date().isoformat()
                latest_pv = conn.execute(
                    "SELECT prompt_version FROM ai_learning_events "
                    "WHERE prompt_version IS NOT NULL ORDER BY id DESC LIMIT 1"
                ).fetchone()
                conn.execute(
                    "INSERT OR REPLACE INTO calibration_snapshots "
                    "(snapshot_date, brier_score, n, prompt_version) VALUES (?,?,?,?)",
                    (today, brier, n, latest_pv["prompt_version"] if latest_pv else None),
                )
        except Exception:
            pass  # snapshotting must never break the stats response

        bins = []
        for lo, hi in [(0.50, 0.60), (0.60, 0.70), (0.70, 0.80), (0.80, 0.90), (0.90, 1.01)]:
            subset = [r for r in rows if lo <= float(r["ai_confidence"]) < hi]
            if not subset:
                continue
            mean_conf = sum(float(r["ai_confidence"]) for r in subset) / len(subset)
            wins = sum(1 for r in subset if r["outcome_status"] == "win")
            bins.append({
                "range":           f"{int(lo*100)}-{int(min(hi, 1.0)*100)}%",
                "lo":              lo,
                "hi":              min(hi, 1.0),
                "n":               len(subset),
                "mean_confidence": round(mean_conf, 3),
                "actual_win_rate": round(wins / len(subset), 3),
            })

        return jsonify({"brier_score": brier, "n": n, "bins": bins})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/learning/calibration-trend")
def learning_calibration_trend():
    """Brier score history (Learning Loop improvement E) — answers "is the
    learning loop actually learning" by showing whether calibration is
    sharpening over time, not just the latest snapshot. Snapshots are written
    lazily by GET /api/learning/calibration-stats (one row/day); this endpoint
    is pure read. Capped to the last 180 days."""
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT snapshot_date, brier_score, n, prompt_version
                FROM calibration_snapshots
                ORDER BY snapshot_date DESC LIMIT 180
            """).fetchall()
        snapshots = [dict(r) for r in rows][::-1]  # chronological order for charting
        return jsonify({"ok": True, "snapshots": snapshots})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/calibration-efficacy")
def learning_calibration_efficacy():
    """Calibration-layer scoreboard: does the deterministic confidence nudge
    actually improve prediction, or is it noise we pay tokens for?

    `ai_confidence` stores the ORIGINAL (pre-nudge) confidence; `calibrated_
    confidence` stores the POST-nudge value actually used for sizing (NULL when no
    nudge fired). For every closed win/loss rec where BOTH are present and differ,
    we compute the Brier score twice — once on the original confidence, once on
    the adjusted — and compare. Lower Brier is better (perfect=0, random=0.25).

    A positive `improvement` (orig_brier − adj_brier > 0) means the nudges moved
    confidence toward reality; negative means they made calibration worse and the
    adjustment logic should be re-tuned or disabled. n-gated at _DIGEST_MIN_N so a
    handful of nudged trades can't produce a spurious verdict.
    """
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT ai_confidence, calibrated_confidence, outcome_status
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss')
                  AND ai_confidence IS NOT NULL
                  AND calibrated_confidence IS NOT NULL
            """).fetchall()

        # Only rows where the nudge actually changed the value are informative —
        # identical orig/adj contribute 0 to the DIFFERENCE and just dilute n.
        nudged = [r for r in rows
                  if abs(float(r["ai_confidence"]) - float(r["calibrated_confidence"])) > 1e-9]
        n = len(nudged)
        if n == 0:
            return jsonify({
                "ok": True, "n": 0,
                "orig_brier": None, "adj_brier": None, "improvement": None,
                "verdict": "no_data",
                "note": "No closed trades yet where a calibration nudge changed the confidence.",
            })

        def _brier(key):
            return sum(
                (float(r[key]) - (1.0 if r["outcome_status"] == "win" else 0.0)) ** 2
                for r in nudged
            ) / n

        orig_brier = round(_brier("ai_confidence"), 4)
        adj_brier  = round(_brier("calibrated_confidence"), 4)
        improvement = round(orig_brier - adj_brier, 4)  # >0 ⇒ nudges helped

        if n < _DIGEST_MIN_N:
            verdict = "insufficient_n"
        elif improvement > 0.002:
            verdict = "helping"
        elif improvement < -0.002:
            verdict = "hurting"
        else:
            verdict = "neutral"

        return jsonify({
            "ok": True, "n": n,
            "orig_brier": orig_brier, "adj_brier": adj_brier,
            "improvement": improvement, "verdict": verdict,
            "min_n": _DIGEST_MIN_N,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# Improvements.md #5: shared retry window for the fetch_failed_at sentinel —
# a permanently-delisted ticker still gets occasionally re-attempted (in case
# the symbol comes back, e.g. a relisting) rather than either starving the
# batch forever (the original bug) or being silently blacklisted forever.
_FETCH_RETRY_DAYS = 7

# HOLD dedupe window (days) for POST /api/learning/log: at most one logged
# HOLD event per ticker per window. HOLDs re-fire on every analysis run, so
# without this the event volume (and the _resolve_hold_outcomes fetch queue)
# grows linearly with run frequency while adding no new passivity signal.
_HOLD_DEDUP_DAYS = 7


def _mark_fetch_failed(conn, row_id) -> None:
    """Stamp fetch_failed_at so a row whose yfinance OHLC call raised drops out
    of the WHERE...IS NULL capped-batch selection for _FETCH_RETRY_DAYS, instead
    of permanently occupying a slot in every future lazy-resolver call."""
    conn.execute(
        "UPDATE ai_learning_events SET fetch_failed_at=? WHERE id=?",
        (datetime.now().isoformat(timespec="seconds"), row_id),
    )


def _resolve_sell_outcomes(conn) -> int:
    """Check sell driver validity 25+ days post-generation by comparing price evolution.

    Runs lazily inside _calib_compute() — capped at 5 resolutions per call.
    Finds executed SELL/TRIM events with sell_primary_driver set but not yet
    verified, from at least 25 days ago.

    Verdict rules (from the perspective of a long-position exit):
      target_reached   — validated if sold ticker ≤ +5% since sell, invalidated if > +10%
      thesis_broken    — validated if sold ticker < −5% since sell, invalidated if > +5%
      stop_triggered   — same as thesis_broken
      better_opportunity — validated if alt outperformed sold by > 3pp, invalidated if < −3pp
      all others       — inconclusive (can't be price-validated)
    """
    cutoff = (datetime.now() - timedelta(days=25)).isoformat()
    retry_cutoff = (datetime.now() - timedelta(days=_FETCH_RETRY_DAYS)).isoformat()
    try:
        rows = conn.execute("""
            SELECT id, ticker, alternative_ticker, sell_primary_driver,
                   actual_exit_price, timestamp
            FROM ai_learning_events
            WHERE was_executed = 1
              AND sell_primary_driver IS NOT NULL
              AND sell_verify_date IS NULL
              AND outcome_status IN ('win', 'loss', 'breakeven')
              AND timestamp < ?
              AND (fetch_failed_at IS NULL OR fetch_failed_at < ?)
            ORDER BY timestamp DESC LIMIT 5
        """, (cutoff, retry_cutoff)).fetchall()
    except Exception:
        return 0

    if not rows:
        return 0

    try:
        import yfinance as yf
    except ImportError:
        return 0

    resolved  = 0
    today_str = datetime.now().strftime("%Y-%m-%d")

    for row in rows:
        ticker   = (row["ticker"] or "").strip()
        driver   = row["sell_primary_driver"] or ""
        exit_px  = row["actual_exit_price"]
        start_dt = row["timestamp"][:10]
        alt_tk   = (row["alternative_ticker"] or "").strip()

        if not ticker or exit_px is None:
            conn.execute(
                "UPDATE ai_learning_events SET sell_verify_date=?, sell_verify_verdict='inconclusive' WHERE id=?",
                (today_str, row["id"]))
            resolved += 1
            continue

        yf_sym = ticker if ticker.endswith(".AX") else ticker + ".AX"
        try:
            hist = yf.Ticker(yf_sym).history(start=start_dt, interval="1d")
            if hist.empty:
                conn.execute(
                    "UPDATE ai_learning_events SET sell_verify_date=?, sell_verify_verdict='inconclusive' WHERE id=?",
                    (today_str, row["id"]))
                resolved += 1
                continue
            ref_px     = float(hist["Close"].iloc[0])
            current_px = float(hist["Close"].iloc[-1])
            sold_chg   = (current_px - ref_px) / ref_px * 100 if ref_px else 0
        except Exception:
            _mark_fetch_failed(conn, row["id"])
            continue

        # Fetch alt ticker price change for better_opportunity
        alt_chg = None
        if driver == "better_opportunity" and alt_tk:
            try:
                yf_alt   = alt_tk if alt_tk.endswith(".AX") else alt_tk + ".AX"
                hist_alt = yf.Ticker(yf_alt).history(start=start_dt, interval="1d")
                if not hist_alt.empty:
                    alt_ref = float(hist_alt["Close"].iloc[0])
                    alt_cur = float(hist_alt["Close"].iloc[-1])
                    alt_chg = (alt_cur - alt_ref) / alt_ref * 100 if alt_ref else 0
            except Exception:
                pass

        # Determine verdict
        if driver == "target_reached":
            verdict = "validated" if sold_chg <= 5 else ("invalidated" if sold_chg > 10 else "inconclusive")
        elif driver in ("thesis_broken", "stop_triggered"):
            verdict = "validated" if sold_chg < -5 else ("invalidated" if sold_chg > 5 else "inconclusive")
        elif driver == "better_opportunity":
            if alt_chg is not None:
                delta = alt_chg - sold_chg
                verdict = "validated" if delta > 3 else ("invalidated" if delta < -3 else "inconclusive")
            else:
                verdict = "inconclusive"
        else:
            # position_sizing, risk_management, portfolio_rebalance, time_stop — can't price-validate
            verdict = "inconclusive"

        conn.execute("""
            UPDATE ai_learning_events
            SET sell_verify_date=?, sell_verify_verdict=?,
                sell_verify_sold_chg=?, sell_verify_alt_chg=?
            WHERE id=?
        """, (today_str, verdict, round(sold_chg, 2), round(alt_chg, 2) if alt_chg is not None else None, row["id"]))
        resolved += 1

    return resolved


# §9.2: virtual fills must not assume perfect execution — thin ASX names would
# teach the calibration optimism from fills that wouldn't have happened.
# One-way slippage = ADV tier (core.adv_slippage) × regime multiplier.
_SLIP_REGIME_MULT = {"highVol": 1.5, "riskOff": 1.25, "panic": 2.0}


def _event_slippage(row) -> float:
    """One-way slippage rate for a learning event, from its stored signal snapshot."""
    adv = None
    try:
        sig = json.loads(row["entry_signals_json"] or "{}")
        adv = sig.get("adv_20")
    except Exception:
        pass
    try:
        regime = row["regime"] or ""
    except (KeyError, IndexError):
        regime = ""
    return adv_slippage(adv) * _SLIP_REGIME_MULT.get(regime, 1.0)


# ── HOLD outcome resolution tuning (redesign 2026-07-09) ─────────────────────
# The original resolver tagged a HOLD a "miss" if the largest |% move| from the
# entry-day close exceeded a FLAT 8% ANYWHERE in an UNBOUNDED entry→today window.
# Three biases made that near-worthless (see audit): (a) the window grew with
# resolution lag, so miss-probability rose with age not model quality; (b) a
# single transient spike counted (peak-based, no persistence); (c) an 8% move UP
# on a correctly-held long was scored a "miss" identically to an 8% drawdown.
# Combined, the ⚠HOLD_TOO_PASSIVE nudge would fire almost automatically once
# n≥10, systematically pushing the model to trade more (over-trading bias).
#
# Redesign: a HOLD in this app is always a decision to KEEP AN EXISTING LONG
# holding, so the meaningful passivity failure is "sat through a sustained
# drawdown you should have de-risked". We therefore judge on:
#   • a FIXED forward window of _HOLD_HORIZON_DAYS trading days from entry,
#   • the ENDPOINT return (a transient dip that recovered is NOT a miss —
#     persistence is required), and
#   • a DIRECTION-AWARE, VOL-SCALED threshold (downside only; the band scales
#     with the stock's own ATR so 8% means different things for a bank vs a
#     small-cap miner). Upside/flat = the hold worked = virtual_hold_correct.
_HOLD_HORIZON_DAYS = 20    # forward trading-day window a HOLD thesis must hold over
_HOLD_VOL_K        = 1.0   # threshold = K × horizon-σ of the stock's own ATR
_HOLD_THR_FLOOR    = 0.05  # never call a <5% drawdown a miss (noise floor)
_HOLD_THR_CAP      = 0.20  # never demand >20% before flagging (very high-vol names)
_HOLD_MIN_BARS     = 10    # too few forward bars to judge → leave unresolved
# Raw-count floor for the behaviour-changing HOLD nudge. Mirrors the local
# _MIN_NUDGE_N in _calib_compute() (Sprint 70) — same value, module-level so the
# standalone _compute_hold_outcome_nudge() can share the gate.
_MIN_NUDGE_N       = 12


def _hold_move_threshold(entry_signals_json, fallback: float) -> float:
    """Vol-scaled downside threshold for a HOLD, from the entry snapshot's daily
    ATR%. Expected drift over H trading days ≈ atr_pct × √H; we flag a sustained
    endpoint move beyond K× that. Falls back to a flat threshold when atr_pct is
    unavailable (legacy rows without entry_signals_json)."""
    try:
        atr_pct = float(json.loads(entry_signals_json or "{}").get("atr_pct"))
        if atr_pct <= 0:
            return fallback
        thr = _HOLD_VOL_K * (atr_pct / 100.0) * math.sqrt(_HOLD_HORIZON_DAYS)
        return min(_HOLD_THR_CAP, max(_HOLD_THR_FLOOR, thr))
    except (TypeError, ValueError, AttributeError):
        return fallback


def _resolve_hold_outcomes(conn, cap: int = 5, move_threshold: float = 0.08) -> int:
    """Lazy-evaluate HOLD recommendations for a passivity outcome signal.

    HOLD recs carry no suggested_stop/suggested_target (the validator's
    requiredUnless:'HOLD' rule means Claude/the quant engine never sizes a
    HOLD), so _resolve_virtual_outcomes()'s WHERE clause (which requires both
    NOT NULL) structurally never touches them. They get logged at generation
    time and then sit orphaned forever unless resolved here — so the model is
    never calibrated on its own passivity.

    A HOLD is a decision to KEEP AN EXISTING LONG holding, so the outcome we
    care about is direction-aware: did the position sit through a *sustained*
    drawdown that should have prompted a TRIM/SELL?

    Algorithm per unresolved HOLD event ≥30 days old (guarantees the full
    forward window has elapsed):
      1. Fetch daily closes for a BOUNDED window: entry date → entry + ~45
         calendar days (comfortably covers _HOLD_HORIZON_DAYS trading bars).
      2. Take the ENDPOINT return over the first _HOLD_HORIZON_DAYS bars after
         entry (a transient dip that recovered is not a miss — persistence to
         the horizon is required).
      3. Threshold is VOL-SCALED off the entry snapshot's ATR% (falls back to
         `move_threshold`). Endpoint return ≤ −threshold → 'virtual_hold_miss'
         (held a long through a sustained loss). Otherwise (flat or up) →
         'virtual_hold_correct' — the hold worked or patience was right.

    Writes to the existing virtual_outcome column, scoped to
    recommendation='HOLD' — these values never collide with the
    virtual_win/virtual_loss/virtual_open values _resolve_virtual_outcomes()
    writes for BUY/SELL/TRIM.

    Returns the number of events resolved this call.
    """
    cutoff = (datetime.now() - timedelta(days=30)).isoformat()
    retry_cutoff = (datetime.now() - timedelta(days=_FETCH_RETRY_DAYS)).isoformat()
    try:
        rows = conn.execute("""
            SELECT id, ticker, timestamp, entry_signals_json
            FROM ai_learning_events
            WHERE recommendation = 'HOLD'
              AND virtual_outcome IS NULL
              AND timestamp < ?
              AND (fetch_failed_at IS NULL OR fetch_failed_at < ?)
            ORDER BY timestamp DESC LIMIT ?
        """, (cutoff, retry_cutoff, cap)).fetchall()
    except Exception:
        return 0

    if not rows:
        return 0

    try:
        import yfinance as yf
    except ImportError:
        return 0

    def _mark_open(row_id):
        conn.execute(
            "UPDATE ai_learning_events SET virtual_outcome='virtual_open' WHERE id=?",
            (row_id,))

    resolved = 0
    for row in rows:
        ticker = row["ticker"] or ""
        yf_sym = ticker if ticker.endswith(".AX") else ticker + ".AX"
        start  = row["timestamp"][:10]  # YYYY-MM-DD
        try:
            start_dt = datetime.strptime(start, "%Y-%m-%d")
        except ValueError:
            _mark_open(row["id"]); resolved += 1
            continue
        # Bounded forward window: fix flaw (a) — the analysis window no longer
        # grows with how late we get around to resolving the row.
        end = (start_dt + timedelta(days=45)).strftime("%Y-%m-%d")

        try:
            hist = yf.Ticker(yf_sym).history(start=start, end=end, interval="1d")
            if hist.empty or len(hist) < _HOLD_MIN_BARS:
                _mark_open(row["id"]); resolved += 1
                continue
        except Exception:
            _mark_fetch_failed(conn, row["id"])
            continue

        closes = hist["Close"]
        entry_close = float(closes.iloc[0])
        if entry_close <= 0:
            _mark_open(row["id"]); resolved += 1
            continue

        # Endpoint return over the fixed forward horizon (first H bars *after*
        # entry). Persistence-based: a spike that reverted lands back near 0.
        window = closes.iloc[1:_HOLD_HORIZON_DAYS + 1]
        if window.empty:
            _mark_open(row["id"]); resolved += 1
            continue
        ret_end = float((window.iloc[-1] - entry_close) / entry_close)

        thr = _hold_move_threshold(row["entry_signals_json"], move_threshold)
        outcome = "virtual_hold_miss" if ret_end <= -thr else "virtual_hold_correct"
        conn.execute(
            "UPDATE ai_learning_events SET virtual_outcome=? WHERE id=?",
            (outcome, row["id"]))
        resolved += 1

    return resolved


def _compute_hold_outcome_nudge(conn) -> str:
    """Single calibration nudge token from resolved HOLD outcomes (see
    _resolve_hold_outcomes). Gated like every other behaviour-changing nudge in
    this module (gotcha #42/#92): a raw-count floor of _MIN_NUDGE_N AND a Wilson
    95% CI whose lower bound clears 50% — i.e. we're statistically confident the
    MAJORITY of HOLDs sat through a sustained adverse move, not a lucky-sample
    point estimate. A low or ambiguous miss rate is silent — correct caution
    isn't a problem to nudge against."""
    row = conn.execute("""
        SELECT
            SUM(CASE WHEN virtual_outcome='virtual_hold_miss' THEN 1 ELSE 0 END) AS n_miss,
            SUM(CASE WHEN virtual_outcome IN ('virtual_hold_miss','virtual_hold_correct')
                     THEN 1 ELSE 0 END) AS n_total
        FROM ai_learning_events
        WHERE recommendation = 'HOLD'
    """).fetchone()
    n_total = row["n_total"] or 0
    if n_total < _MIN_NUDGE_N:
        return ""
    n_miss = row["n_miss"] or 0
    # CI-gated majority: fire only when the whole 95% CI sits ABOVE 50%.
    ci = _wilson_ci(n_miss, n_total)
    if not ci or ci[0] <= 50.0:
        return ""
    return f"⚠HOLD_TOO_PASSIVE({n_miss}/{n_total} HOLDs sat through a sustained adverse move)"


def _resolve_virtual_outcomes(conn) -> int:
    """Lazy-evaluate skipped/unexecuted trades for virtual calibration signal.

    Called at the start of _calib_compute() on every calibration fetch.
    Safe to call frequently: capped at 10 resolutions per call; the 5-min TTL
    on _calib_compute() prevents excessive yfinance round-trips.

    Algorithm per unresolved skipped event:
      1. Fetch daily OHLC from event timestamp to today via yfinance.
      2. Scan bar-by-bar: check if Daily High reached target or Daily Low reached stop.
      3. For SELL/TRIM: inverted frame — target is BELOW entry, stop is ABOVE entry.
      4. Record the bar index where the level was first hit as `bars_to_resolution`.
      5. Write virtual_outcome = 'virtual_win' | 'virtual_loss' | 'virtual_open'.

    virtual_open means neither level was hit yet — event stays eligible for future
    resolution on the next calibration fetch.

    virtual_speed_weight = min(1.0, 7.0 / bars_to_resolution):
      - Target hit on bar 1–7  → weight = 1.0  (fast, high-conviction signal)
      - Target hit on bar 14   → weight = 0.5
      - Target hit on bar 29+  → weight ≈ 0.24 (slow drift, weaker signal)
      - virtual_open            → weight = 1.0 default (will be recomputed on resolution)

    IMPORTANT: bars_to_resolution is the number of daily bars from rec creation until
    the target/stop is first hit — NOT total elapsed time from creation to today.
    This correctly rewards fast target hits regardless of how old the event is.
    Events must be ≥30d old before resolution to ensure enough bars have elapsed
    for non-resolution to be meaningful (a rec from yesterday might just not have
    had enough time to play out).

    Returns the number of events resolved this call (for debug logging).
    """
    cutoff = (datetime.now() - timedelta(days=30)).isoformat()  # ≥30d old per spec
    retry_cutoff = (datetime.now() - timedelta(days=_FETCH_RETRY_DAYS)).isoformat()
    try:
        rows = conn.execute("""
            SELECT id, ticker, recommendation, suggested_stop, suggested_target, timestamp,
                   regime, entry_signals_json
            FROM ai_learning_events
            WHERE was_executed = 0
              AND suggested_stop IS NOT NULL AND suggested_target IS NOT NULL
              AND virtual_outcome IS NULL
              AND outcome_status IN ('open', 'skipped')
              AND timestamp < ?
              AND (fetch_failed_at IS NULL OR fetch_failed_at < ?)
            ORDER BY timestamp DESC LIMIT 10
        """, (cutoff, retry_cutoff)).fetchall()
    except Exception:
        return 0

    if not rows:
        return 0

    try:
        import yfinance as yf
    except ImportError:
        return 0

    resolved = 0
    for row in rows:
        try:
            stop    = float(row["suggested_stop"])
            target  = float(row["suggested_target"])
        except (TypeError, ValueError):
            continue
        is_exit = (row["recommendation"] or "BUY").upper() in ("SELL", "TRIM")
        ticker  = row["ticker"] or ""
        yf_sym  = ticker if ticker.endswith(".AX") else ticker + ".AX"
        start   = row["timestamp"][:10]  # YYYY-MM-DD

        try:
            hist = yf.Ticker(yf_sym).history(start=start, interval="1d")
            if hist.empty:
                conn.execute(
                    "UPDATE ai_learning_events SET virtual_outcome='virtual_open' WHERE id=?",
                    (row["id"],))
                resolved += 1
                continue
        except Exception:
            _mark_fetch_failed(conn, row["id"])
            continue

        # §9.2 asymmetric slippage: a virtual WIN must clear the target by the
        # slippage margin (the fill wouldn't happen at a barely-touched level);
        # losses trigger at the raw stop (slippage makes losses worse, never
        # less likely). Pessimistic by construction.
        slip = _event_slippage(row)

        outcome = "virtual_open"
        # Track the bar index (1-indexed) at which target or stop was first hit.
        # This is used as `hold_days` for speed_weight — rewards fast resolutions.
        bars_to_resolution = 0
        for i, (_, bar) in enumerate(hist.iterrows(), 1):
            # Sprint 70: STOP-FIRST intrabar convention. When a single daily bar's
            # range straddles BOTH the stop and the target, the real intraday path
            # is unknown; the conservative backtest convention is to assume the stop
            # hit first. The previous target-first ordering always booked the win,
            # inflating virtual win rates that feed calibration. This now matches the
            # stop-first convention in _resolve_execution_alpha().
            if is_exit:
                # SELL/TRIM: stop above entry (loss), target below entry (win)
                if bar["High"] >= stop:                outcome = "virtual_loss"; bars_to_resolution = i; break
                if bar["Low"]  <= target * (1 - slip): outcome = "virtual_win";  bars_to_resolution = i; break
            else:
                # BUY: stop below entry (loss), target above entry (win)
                if bar["Low"]  <= stop:                outcome = "virtual_loss"; bars_to_resolution = i; break
                if bar["High"] >= target * (1 + slip): outcome = "virtual_win";  bars_to_resolution = i; break

        # virtual_open: neither level was hit — use full bar count as hold_days
        # (the position drifted for the entire available history without resolution)
        if not bars_to_resolution:
            bars_to_resolution = max(1, len(hist))

        # speed_weight = min(1.0, 7 / bars_to_resolution):
        #   resolved in ≤7 bars → 1.0 (fast, high-conviction signal)
        #   resolved in 30 bars → ~0.23 (slow drift, weaker signal)
        speed_weight = round(min(1.0, 7.0 / bars_to_resolution), 3)
        conn.execute(
            "UPDATE ai_learning_events SET virtual_outcome=?, virtual_speed_weight=?, "
            "virtual_slippage_applied=? WHERE id=?",
            (outcome, speed_weight, round(slip, 5), row["id"]))
        resolved += 1

    return resolved


# ── Sprint 71 Phase 3A — few-shot exemplars from own trade history ────────────

def _entry_signature(sig: dict | None) -> str:
    """Compact, human-readable entry signature from an entry_signals_json dict.

    Pulls the most diagnostic, non-placeholder fields (RSI, BB%B, px_vs_sma200,
    setup_score, MACD-hist sign). Skips null fields. rs_score / rs_5d_alpha are
    deliberately NOT featured — they are neutral placeholders today (see Phase 2
    note in improvements.md), so surfacing them would imply real relative-strength
    data that doesn't exist. Returns "" when no usable field is present.
    """
    if not sig:
        return ""
    parts = []
    rsi = sig.get("rsi_14")
    if isinstance(rsi, (int, float)):
        parts.append(f"RSI{int(round(rsi))}")
    bb = sig.get("bb_pct_b")
    if isinstance(bb, (int, float)):
        parts.append(f"%b{bb:.2f}")
    px200 = sig.get("px_vs_sma200")
    if isinstance(px200, (int, float)):
        parts.append(f"vs200{px200:+.0f}%")
    ss = sig.get("setup_score")
    if isinstance(ss, (int, float)):
        parts.append(f"setup{int(round(ss))}")
    mh = sig.get("macd_hist")
    if isinstance(mh, (int, float)):
        parts.append("MACD+" if mh > 0 else "MACD-")
    return " ".join(parts)


def _compute_exemplars(conn, max_losses: int = 3, max_wins: int = 2,
                       sector: str | None = None) -> list[str]:
    """Return up-to (max_losses + max_wins) compact exemplar lines drawn from the
    user's own CLOSED, EXECUTED BUY/TOP_UP history.

    Each line: `ACTION TICKER @ <entry-signature> → <pnl%> in <Nd>, <tag(s)>`
    Losses use error_type; wins use success_tags. Recency-ordered; tickers deduped
    so the feed shows variety. Returns [] on empty history.

    When `sector` is supplied (the dominant sector of the portfolio under analysis),
    PREFER same-sector exemplars so the few-shot examples are sector-relevant, and
    fall back to whole-market history only when too few same-sector trades exist
    (fewer than the requested loss/win caps). Keeps the existing caps either way.
    """
    rows = conn.execute("""
        SELECT recommendation, ticker, outcome_status, realized_pnl_pct,
               holding_period_days, entry_signals_json, error_type, success_tags,
               timestamp, sector, bull_case, bear_case
          FROM ai_learning_events
         WHERE was_executed = 1
           AND recommendation IN ('BUY','TOP_UP')
           AND outcome_status IN ('win','loss','breakeven')
           AND realized_pnl_pct IS NOT NULL
           AND entry_signals_json IS NOT NULL
         ORDER BY timestamp DESC
         LIMIT 120
    """).fetchall()

    # Sector preference: pull same-sector first; top up from whole-market only when
    # the same-sector pool can't satisfy the caps. Preserves recency ordering.
    if sector:
        same  = [r for r in rows if (r["sector"] or "") == sector]
        other = [r for r in rows if (r["sector"] or "") != sector]
        same_losses = sum(1 for r in same if r["outcome_status"] in ("loss", "breakeven"))
        same_wins   = sum(1 for r in same if r["outcome_status"] == "win")
        # Only restrict to same-sector when BOTH buckets are deep enough; otherwise
        # use same-sector first then top up with whole-market for variety/coverage.
        if same_losses >= max_losses and same_wins >= max_wins:
            rows = same
        else:
            rows = same + other

    def _fmt(r) -> str | None:
        try:
            sig = json.loads(r["entry_signals_json"] or "{}")
        except Exception:
            sig = {}
        signature = _entry_signature(sig)
        if not signature:
            return None
        pnl  = float(r["realized_pnl_pct"])
        days = r["holding_period_days"]
        days_str = f" in {int(days)}d" if isinstance(days, (int, float)) and days else ""
        if r["outcome_status"] == "win":
            tags = (r["success_tags"] or "").strip()
        else:
            tags = (r["error_type"] or "").strip()
        tag_str = f", {tags}" if tags and tags not in ("none", "") else ""
        # Reasoning-text snippet: shows Claude its own past words next to the
        # outcome, not just a numeric signature. bull_case is the original
        # investment thesis (required on every BUY/TOP_UP) so it's preferred for
        # both wins and losses; bear_case (the steelman risk, only required at
        # confidence>=0.70) is shown for losses when present since "the risk you
        # yourself flagged" is the more instructive line when it played out.
        case_text = (r["bear_case"] if r["outcome_status"] != "win" and r["bear_case"] else r["bull_case"]) or ""
        case_str = f' — "{case_text.strip()[:70]}"' if case_text.strip() else ""
        return (f"{r['recommendation']} {r['ticker']} @ {signature} → "
                f"{pnl:+.1f}%{days_str}{tag_str}{case_str}")

    losses, wins = [], []
    seen_l, seen_w = set(), set()
    # Recent losses first (recency order preserved by the DESC query).
    for r in rows:
        if r["outcome_status"] in ("loss", "breakeven") and r["ticker"] not in seen_l:
            line = _fmt(r)
            if line:
                losses.append(line)
                seen_l.add(r["ticker"])
        if len(losses) >= max_losses:
            break
    # Best recent wins — sort the win subset by realized P&L desc, dedupe tickers.
    win_rows = sorted(
        [r for r in rows if r["outcome_status"] == "win"],
        key=lambda r: float(r["realized_pnl_pct"]), reverse=True,
    )
    for r in win_rows:
        if r["ticker"] in seen_w:
            continue
        line = _fmt(r)
        if line:
            wins.append(line)
            seen_w.add(r["ticker"])
        if len(wins) >= max_wins:
            break

    return losses + wins


# ── Sprint 71 Phase 3B — per-driver conditional playbook ──────────────────────

def _compute_driver_playbook(conn, drivers: list[str], wilson_excludes,
                             min_bucket_n: int = 5) -> list[str]:
    """For each requested entry driver, emit a conditional win-rate line comparing
    a 'favourable' vs 'unfavourable' entry-signal bucket, e.g.
        mean_reversion: 61%WR when RSI<30 vs 38% when RSI>45 (n=12/8)

    Buckets are driver-specific (RSI for mean_reversion / trend_pullback;
    BB%B for momentum_breakout). Each bucket must clear `min_bucket_n` AND its
    Wilson CI must exclude the OTHER bucket's win-rate (significance gate). Returns
    [] when no driver qualifies. Drivers without a technical bucket rule are skipped.
    """
    if not drivers:
        return []

    rows = conn.execute("""
        SELECT primary_entry_driver, outcome_status, entry_signals_json
          FROM ai_learning_events
         WHERE was_executed = 1
           AND recommendation IN ('BUY','TOP_UP')
           AND outcome_status IN ('win','loss','breakeven')
           AND primary_entry_driver IS NOT NULL
           AND entry_signals_json IS NOT NULL
    """).fetchall()

    by_driver: dict = {}
    for r in rows:
        drv = r["primary_entry_driver"]
        try:
            sig = json.loads(r["entry_signals_json"] or "{}")
        except Exception:
            sig = {}
        by_driver.setdefault(drv, []).append((r["outcome_status"], sig))

    # (field, lo_pred, lo_label, hi_pred, hi_label) per driver.
    _BUCKETS = {
        "mean_reversion": ("rsi_14",
                           lambda v: v < 30, "RSI<30",
                           lambda v: v > 45, "RSI>45"),
        "trend_pullback": ("rsi_14",
                           lambda v: v < 45, "RSI<45",
                           lambda v: v > 60, "RSI>60"),
        "momentum_breakout": ("bb_pct_b",
                              lambda v: v > 0.80, "%b>0.8",
                              lambda v: v < 0.55, "%b<0.55"),
    }

    out = []
    for drv in drivers:
        spec = _BUCKETS.get(drv)
        if not spec or drv not in by_driver:
            continue
        field, lo_pred, lo_lbl, hi_pred, hi_lbl = spec
        lo_w = lo_n = hi_w = hi_n = 0
        for status, sig in by_driver[drv]:
            v = sig.get(field)
            if not isinstance(v, (int, float)):
                continue
            won = 1 if status == "win" else 0
            if lo_pred(v):
                lo_n += 1; lo_w += won
            elif hi_pred(v):
                hi_n += 1; hi_w += won
        if lo_n < min_bucket_n or hi_n < min_bucket_n:
            continue
        lo_wr = lo_w / lo_n
        hi_wr = hi_w / hi_n
        # Significance: favourable bucket's CI must exclude the unfavourable WR.
        if not wilson_excludes(lo_w, lo_n, hi_wr):
            continue
        out.append(
            f"{drv}: {lo_wr*100:.0f}%WR when {lo_lbl} vs {hi_wr*100:.0f}% "
            f"when {hi_lbl} (n={lo_n}/{hi_n})"
        )
    return out


# ── Sprint 71 Phase 3C — conditional cross-tabs + negative confirmation ───────

def _compute_setup_bucket_xtab(conn, wilson_excludes, min_n: int = 6) -> str:
    """setup_score bucket × outcome cross-tab. Buckets the entry setup_score into
    low(<40)/mid(40-65)/high(≥65) and reports win-rate per bucket where each clears
    `min_n` and the high vs low CI separation is significant. Returns "" otherwise.
    """
    rows = conn.execute("""
        SELECT outcome_status, entry_signals_json
          FROM ai_learning_events
         WHERE was_executed = 1
           AND recommendation IN ('BUY','TOP_UP')
           AND outcome_status IN ('win','loss','breakeven')
           AND entry_signals_json IS NOT NULL
    """).fetchall()

    buckets = {"low": [0, 0], "mid": [0, 0], "high": [0, 0]}  # [wins, n]
    for r in rows:
        try:
            sig = json.loads(r["entry_signals_json"] or "{}")
        except Exception:
            continue
        ss = sig.get("setup_score")
        if not isinstance(ss, (int, float)):
            continue
        key = "low" if ss < 40 else ("mid" if ss < 65 else "high")
        buckets[key][1] += 1
        if r["outcome_status"] == "win":
            buckets[key][0] += 1

    lo_w, lo_n = buckets["low"]
    hi_w, hi_n = buckets["high"]
    if lo_n < min_n or hi_n < min_n:
        return ""
    lo_wr, hi_wr = lo_w / lo_n, hi_w / hi_n
    # Only surface when high-setup is significantly better than low-setup.
    if not wilson_excludes(hi_w, hi_n, lo_wr):
        return ""
    return (f"setup_score: high(≥65)={hi_wr*100:.0f}%WR(n={hi_n}) vs "
            f"low(<40)={lo_wr*100:.0f}%(n={lo_n})→favour high-setup entries")


def _compute_driver_regime_xtab(conn, regime: str, wilson_excludes,
                                min_n: int = 6) -> str:
    """driver × regime cross-tab for the CURRENT regime. Finds the entry driver
    whose win-rate in this regime most significantly diverges from its win-rate in
    all other regimes (both buckets ≥ min_n, CI-gated). Returns "" otherwise.
    """
    if not regime:
        return ""
    rows = conn.execute("""
        SELECT primary_entry_driver, regime, outcome_status
          FROM ai_learning_events
         WHERE was_executed = 1
           AND recommendation IN ('BUY','TOP_UP')
           AND outcome_status IN ('win','loss','breakeven')
           AND primary_entry_driver IS NOT NULL
    """).fetchall()

    by_drv: dict = {}
    for r in rows:
        drv = r["primary_entry_driver"]
        in_reg = (r["regime"] or "") == regime
        won = 1 if r["outcome_status"] == "win" else 0
        b = by_drv.setdefault(drv, {"in": [0, 0], "out": [0, 0]})
        key = "in" if in_reg else "out"
        b[key][1] += 1
        b[key][0] += won

    best = None
    best_gap = 0.0
    for drv, b in by_drv.items():
        iw, in_ = b["in"]
        ow, on_ = b["out"]
        if in_ < min_n or on_ < min_n:
            continue
        iwr, owr = iw / in_, ow / on_
        gap = abs(iwr - owr)
        if gap > best_gap and wilson_excludes(iw, in_, owr):
            best_gap = gap
            best = (drv, iwr, in_, owr, on_)
    if not best:
        return ""
    drv, iwr, in_, owr, on_ = best
    flag = "✓" if iwr > owr else "⚠"
    return (f"{flag}{drv}×{regime}:{iwr*100:.0f}%WR(n={in_}) vs "
            f"{owr*100:.0f}% other-regimes(n={on_})")


def _compute_driver_regime_sector_xtab(conn) -> list:
    """3D cross-tab: entry driver × regime × sector.

    Improvement C: returns a list of {driver, regime, sector, n, win_rate,
    avg_pnl_pct} cells for closed executed BUY/TOP_UP events that have all
    three dimensions populated. Cells with n < 3 are excluded (too noisy).

    win_rate is expressed as a fraction 0–1; avg_pnl_pct as a float.
    All values are Python-native floats/ints (numpy scalars cast at query time
    via CAST so SQLite returns plain Python types).
    """
    rows = conn.execute("""
        SELECT primary_entry_driver AS driver,
               regime,
               sector,
               COUNT(*) AS n,
               AVG(CASE WHEN outcome_status IN ('win','virtual_win') THEN 1.0 ELSE 0.0 END) AS win_rate,
               AVG(realized_pnl_pct) AS avg_pnl_pct
          FROM ai_learning_events
         WHERE was_executed = 1
           AND outcome_status IN ('win','loss','virtual_win','virtual_loss')
           AND recommendation IN ('BUY','TOP_UP')
           AND primary_entry_driver IS NOT NULL
           AND regime IS NOT NULL
           AND sector IS NOT NULL AND sector != ''
         GROUP BY primary_entry_driver, regime, sector
        HAVING COUNT(*) >= 3
         ORDER BY win_rate DESC
    """).fetchall()
    result = []
    for r in rows:
        result.append({
            "driver":      r["driver"],
            "regime":      r["regime"],
            "sector":      r["sector"],
            "n":           int(r["n"]),
            "win_rate":    round(float(r["win_rate"]), 3) if r["win_rate"] is not None else None,
            "avg_pnl_pct": round(float(r["avg_pnl_pct"]), 2) if r["avg_pnl_pct"] is not None else None,
        })
    return result


@bp.route("/api/learning/driver-matrix")
def driver_matrix():
    """3D entry-driver × regime × sector performance cross-tab.

    GET /api/learning/driver-matrix

    Returns cells where all three dimensions (primary_entry_driver, regime,
    sector) are populated AND n >= 3. Each cell: {driver, regime, sector, n,
    win_rate (0-1), avg_pnl_pct}. Useful for surfacing which driver works best
    in which regime for which sector — a more granular view than the 2D
    driver×regime tab already in the Learning page.
    """
    try:
        with get_db() as conn:
            cells = _compute_driver_regime_sector_xtab(conn)
        return jsonify({"ok": True, "cells": cells, "n": len(cells)})
    except Exception as e:
        current_app.logger.error("driver-matrix error: %s", e)
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/factor-win-rates")
def learning_factor_win_rates():
    """Win-rate analysis segmented by entry-signal buckets from entry_signals_json.

    For each of the 5 core entry signals (rsi_14, bb_pct_b, adx_14, return_5d,
    return_20d), computes mean value for wins vs losses among executed closed
    BUY/TOP_UP trades that carry an entry snapshot. Returns the mean difference
    (wins_mean - losses_mean) as an empirical IC proxy from real trades.

    Response: { ok, factors: [{factor, n_wins, n_losses, wins_mean, losses_mean,
                                mean_diff, interpretation}] }
    """
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT entry_signals_json, outcome_status
                FROM ai_learning_events
                WHERE was_executed = 1
                  AND outcome_status IN ('win','loss','breakeven')
                  AND recommendation IN ('BUY','TOP_UP')
                  AND entry_signals_json IS NOT NULL
            """).fetchall()

        factors_of_interest = ["rsi_14", "bb_pct_b", "adx_14", "return_5d", "return_20d", "setup_score"]
        accum = {f: {"wins": [], "losses": []} for f in factors_of_interest}

        for row in rows:
            try:
                sig = json.loads(row["entry_signals_json"] or "{}")
            except Exception:
                continue
            bucket = "wins" if row["outcome_status"] == "win" else "losses"
            for f in factors_of_interest:
                v = sig.get(f)
                try:
                    fv = float(v) if v is not None else None
                except (TypeError, ValueError):
                    fv = None
                if fv is not None:
                    accum[f][bucket].append(fv)

        result = []
        for f, data in accum.items():
            wins_vals   = data["wins"]
            losses_vals = data["losses"]
            if len(wins_vals) < 3 or len(losses_vals) < 3:
                continue
            wins_mean   = round(sum(wins_vals)   / len(wins_vals),   3)
            losses_mean = round(sum(losses_vals) / len(losses_vals), 3)
            mean_diff   = round(wins_mean - losses_mean, 3)
            # Interpretation: for rsi/bb, lower=better at entry (oversold);
            # for adx/return_20d, higher=better; for return_5d, context-dependent.
            _interp_map = {
                "rsi_14":     "lower at entry = more oversold = better for mean-reversion",
                "bb_pct_b":   "lower at entry = near lower band = better for mean-reversion",
                "adx_14":     "higher = stronger trend = better for trend-pullback",
                "return_5d":  "negative diff = buying dips works; positive = momentum pays",
                "return_20d": "positive = uptrend context helps wins",
                "setup_score":"higher at entry = better setup quality",
            }
            result.append({
                "factor":      f,
                "n_wins":      len(wins_vals),
                "n_losses":    len(losses_vals),
                "wins_mean":   wins_mean,
                "losses_mean": losses_mean,
                "mean_diff":   mean_diff,
                "interpretation": _interp_map.get(f, ""),
            })

        result.sort(key=lambda x: abs(x["mean_diff"]), reverse=True)
        return jsonify({"ok": True, "factors": result})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


def _compute_sell_negative_confirmation(conn, cap: int = 3) -> str:
    """Negative-confirmation line: SELL/TRIM calls that subsequently ROSE — i.e.
    the model sold and the stock then climbed (sell_verify_verdict='invalidated'
    OR a strongly positive sell_verify_sold_chg). Tells Claude what NOT to do.
    Returns "" when no such case exists.
    """
    rows = conn.execute("""
        SELECT ticker, sell_verify_sold_chg, sell_verify_verdict, sell_primary_driver
          FROM ai_learning_events
         WHERE recommendation IN ('SELL','TRIM')
           AND sell_verify_date IS NOT NULL
           AND sell_verify_sold_chg IS NOT NULL
           AND (sell_verify_verdict = 'invalidated' OR sell_verify_sold_chg >= 8)
         ORDER BY sell_verify_sold_chg DESC
    """).fetchall()
    if not rows:
        return ""
    seen = set()
    parts = []
    for r in rows:
        tk = r["ticker"]
        if tk in seen:
            continue
        seen.add(tk)
        parts.append(f"{tk}+{r['sell_verify_sold_chg']:.0f}%")
        if len(parts) >= cap:
            break
    if not parts:
        return ""
    return "⚠SELL→ROSE(don't repeat): " + ", ".join(parts)


def _calib_compute(regime: str, sectors_str: str, tickers_str: str, days: int,
                   flipped_at: str = "", flipped_to: str = "", deep: bool = False) -> dict:
    """
    Pure calibration computation. Returns a plain dict.
    Separated from the route so results can be TTL-cached (L4).

    flipped_at / flipped_to (Sprint 44): when a regime flip occurred recently and
    fewer than 10 trades have accumulated in the new regime, the half-life is
    temporarily halved to discount stale pre-flip calibration data faster.
    """
    sectors     = [s for s in sectors_str.split(",") if s]
    tickers_req = [t for t in tickers_str.split(",") if t]
    cutoff      = (datetime.now() - timedelta(days=days)).isoformat()
    cutoff_30   = (datetime.now() - timedelta(days=30)).isoformat()

    # Volatility-adaptive half-life: fast decay in volatile/panic regimes so
    # stale data from a different market state doesn't dilute the calibration;
    # slow decay in calm/sideways regimes to preserve statistical sample power.
    # Keyed on actual regime names emitted by classifyRegime() in regime-engine.js:
    # riskOn, riskOff, panic, sideways, trend, highVol, unknown
    _HL_MAP = {
        "panic":    20,
        "riskOff":  30,
        "highVol":  35,
        "trend":    45,
        "riskOn":   50,
        "sideways": 60,
    }
    hl = _HL_MAP.get(regime or "", 45)

    # Sprint 44: regime-flip penalty — temporarily halve hl when the regime
    # flipped recently AND fewer than 10 trades have accumulated in the new regime.
    # This prevents stale pre-flip calibration from dominating the first few weeks.
    _regime_flip_token = ""
    if flipped_at and flipped_to and flipped_to == regime:
        try:
            import re as _re
            try:
                _fa = flipped_at.rstrip("Z")
                # strip any +HH:MM or -HH:MM offset suffix robustly
                _fa = _re.sub(r'[+-]\d{2}:\d{2}$', '', _fa)
                flip_dt = datetime.fromisoformat(_fa)
            except Exception:
                flip_dt = None
            if flip_dt is None:
                raise ValueError(f"unparseable flipped_at: {flipped_at!r}")
            flip_days = (datetime.now() - flip_dt).days
            if flip_days <= 30:
                # Count executed trades logged since the flip
                from db import get_db as _get_db_local
                with _get_db_local() as _conn:
                    n_new = _conn.execute(
                        "SELECT COUNT(*) FROM ai_learning_events WHERE regime=? AND timestamp>=? AND outcome_status IN ('win','loss','breakeven')",
                        (regime, flipped_at[:10]),
                    ).fetchone()[0]
                if n_new < 10:
                    hl = max(10, hl // 2)
                    _regime_flip_token = f"⚠REGIME_FLIP({flip_days}d ago, {n_new} trades in new regime, hl={hl}d)"
        except Exception:
            pass

    # Phase 8 gate — set to True after rows are fetched if scores predict outcomes.
    # Captured by closure in _weight() below; Python reads the name at call time.
    _phase8_active = False

    def _decay(ts, half_life=None):
        half_life = hl if half_life is None else half_life
        try:
            d = (datetime.now() - datetime.fromisoformat(ts)).days
            return math.exp(-math.log(2) * d / half_life)
        except Exception:
            return 1.0

    def _weight(r, half_life=None):
        """Skill-weighted time-decay: weight = time_decay × skill_factor × virtual_discount.

        Skill factor is centred at 5/10 = 1.0 (neutral).
          skill=0  → 0.0 → clamped to 0.2  (lucky/random noise, heavily discounted)
          skill=5  → 1.0                    (average, neutral weight — same for unscored)
          skill=9  → 1.8                    (high-quality analysis, amplified)
          skill=10 → 2.0 → clamped to 1.8  (prevents single-trade dominance)

        Unscored trades (skill_score IS NULL) default to 1.0 — the neutral centre.
        This avoids the old discontinuity where an outstanding scored trade (8/10 → 0.8)
        was penalised relative to an unscored trade (→ 1.0).

        Fix #18: virtual outcomes (skipped recs resolved via OHLC scan) receive an
        additional 0.75× discount — they break pessimism loops caused by calibration
        suppression, but are synthetic; real outcomes always outweigh them.
        """
        half_life = hl if half_life is None else half_life
        td = _decay(r["timestamp"], half_life)
        sk = r["skill_score"]
        # Phase 8 gate: only apply skill amplification when scores predict outcomes.
        # _phase8_active is resolved at call time (closure over outer scope variable).
        sf = max(0.2, min(1.8, float(sk) / 5.0)) if (sk is not None and _phase8_active) else 1.0
        base = td * sf
        # Paper-trading discount: paper fills are idealized (no real slippage or
        # behavioural drag) so they're less trustworthy than real outcomes. A
        # uniform 0.5× is CORRECT: during a pure-paper phase every row scales
        # equally, so it cancels out of the ESS and weighted-win-rate ratios
        # (calibration behaves exactly as if undiscounted); once real trades mix
        # in, paper correctly contributes less statistical weight so real
        # outcomes dominate. Non-'real' (paper or missing) ⇒ discounted, matching
        # the isRealTrade() firewall invariant.
        pm = 1.0 if (r.get("trade_mode") == "real") else 0.5
        base *= pm
        # Fix #18: virtual rows get 0.75× multiplier × speed_weight (Sprint 44: fast hits weighted higher)
        if r.get("is_virtual"):
            return base * 0.75 * float(r.get("virtual_speed_weight") or 1.0)
        return base

    def _ess(subset):
        """Kish's effective sample size for weighted samples.

        ESS = (Σwi)² / Σwi²

        A subset with N trades of equal weight returns ESS = N.
        A subset with 1 recent trade (w=1.0) and 3 very old trades (w≈0.1)
        returns ESS ≈ 1.6 — correctly reflecting poor statistical power
        despite the raw count of 4.
        """
        weights = [_weight(r) for r in subset]
        sum_w   = sum(weights)
        sum_w2  = sum(w * w for w in weights)
        return (sum_w * sum_w) / sum_w2 if sum_w2 > 0 else 0.0

    def _wwr(subset):
        w_wins  = sum(_weight(r) for r in subset if r["outcome_status"] == "win")
        w_total = sum(_weight(r) for r in subset)
        return w_wins / w_total if w_total > 0 else 0.0

    def _is_shock(r):
        et = r["error_type"] or ""
        er = r["exit_reason"] or ""
        return "external_shock" in et.split(",") or er == "protective_stop"

    try:
        with get_db() as conn:
            # Fix #18: lazy-resolve skipped trades — capped at 10, fast, idempotent.
            # Failures degrade gracefully (yfinance timeout → marks virtual_open, skipped).
            _resolve_virtual_outcomes(conn)
            # HOLD outcome tracking: HOLD recs have no stop/target (validator's
            # requiredUnless:'HOLD' rule), so _resolve_virtual_outcomes() never
            # touches them — they were logged but orphaned, never calibrating
            # the model on its own passivity. Capped at 5, idempotent.
            _resolve_hold_outcomes(conn)
            # Sprint 37: lazy-resolve sell tag outcomes (Gap 3 + Gap 7) — capped at 5.
            _resolve_sell_outcomes(conn)
            # Exit-signals capture: lazily classify SELL/TRIM exit timing quality
            # from the captured exit_signals_json snapshot — capped at 50, idempotent.
            _resolve_exit_quality_tags(conn)
            # Sprint 71 Phase 1B: lazily capture MAE/MFE path stats for closed
            # executed BUY/TOP_UP trades — capped at 5, idempotent, degrades
            # gracefully on yfinance failure (row left unresolved).
            # BE-1 fix: resolve MAE/MFE (and execution alpha) BEFORE deterministic
            # tags so the empirical stop_too_tight/early_exit paths can read live
            # mae_pct/mfe_pct/exec_mech_pnl_pct values rather than still-NULL ones.
            _resolve_mae_mfe(conn)
            # BE-1 fix: resolve execution alpha BEFORE deterministic tags so the
            # empirical early_exit path can read exec_mech_pnl_pct values.
            _resolve_execution_alpha(conn)
            # Sprint 70: lazily assign deterministic error_type + skill_score to
            # closed trades from the entry/exit capture (replaces the LLM tagger).
            # Runs AFTER MAE/MFE + execution alpha so the empirical
            # stop_too_tight/early_exit paths read live values rather than NULLs.
            _resolve_deterministic_tags(conn)
            # Sprint 71 Phase 2D: lazily score the wider-stop counterfactual for
            # stop_too_tight-tagged trades — capped at 5, idempotent. Feeds the
            # tag-precision self-suppression gate below.
            _resolve_stop_tag_counterfactual(conn)
            # Sprint 71 sector hardening: backfill null sectors on historical
            # executed rows from core.SECTOR_MAP (no network) so the sector
            # analysis lens isn't silently censored. Capped at 50, idempotent.
            _resolve_missing_sectors(conn)
            _stop_tag_prec = _compute_stop_tag_precision(conn)

            rows = conn.execute("""
                SELECT ai_confidence, outcome_status, regime, sector, ticker,
                       realized_pnl_pct, rr_ratio, timestamp,
                       error_type, error_type_source, exit_reason, skill_score, success_tags,
                       trade_mode, recommendation, market_context
                FROM ai_learning_events
                WHERE timestamp >= ? AND outcome_status IN ('win','loss','breakeven')
                ORDER BY timestamp DESC LIMIT 300
            """, (cutoff,)).fetchall()

            # Gap 6: check auto-tag agreement rate to gate the top_err nudge.
            tag_acc = conn.execute("""
                SELECT COUNT(*) as n,
                       SUM(CASE WHEN verdict='agree' THEN 1 ELSE 0 END) as n_agree
                FROM tag_reviews
            """).fetchone()
            _auto_tag_n      = tag_acc["n"] if tag_acc else 0
            _auto_tag_agree  = (tag_acc["n_agree"] / tag_acc["n"]) if (_auto_tag_n > 0) else None
            _auto_tags_ok    = _auto_tag_agree is None or _auto_tag_agree >= 0.60

            # Fix #18: fetch resolved virtual outcomes to supplement calibration at 0.75× weight.
            # Sprint 44: virtual_speed_weight multiplies the 0.75× base for fast hits.
            # Maps virtual_win → 'win', virtual_loss → 'loss' so all downstream logic is unchanged.
            v_rows_raw = conn.execute("""
                SELECT ai_confidence,
                       CASE virtual_outcome WHEN 'virtual_win' THEN 'win' ELSE 'loss' END AS outcome_status,
                       regime, sector, ticker,
                       NULL AS realized_pnl_pct, rr_ratio, timestamp,
                       error_type, exit_reason, skill_score, success_tags,
                       trade_mode,
                       1 AS is_virtual,
                       COALESCE(virtual_speed_weight, 1.0) AS virtual_speed_weight
                FROM ai_learning_events
                WHERE was_executed = 0
                  AND virtual_outcome IN ('virtual_win', 'virtual_loss')
                  AND timestamp >= ?
                  AND ai_confidence IS NOT NULL
                LIMIT 100
            """, (cutoff,)).fetchall()
            virtual_rows = [dict(r) for r in v_rows_raw]
            n_virtual    = len(virtual_rows)

            # Part 9: sell tag verification stats — feeds sell-tag calibration signal.
            # Excludes drivers that are always inconclusive (can't be price-validated).
            sell_tag_rows = conn.execute("""
                SELECT sell_primary_driver,
                       COUNT(*) AS n,
                       SUM(CASE WHEN sell_verify_verdict = 'validated'   THEN 1 ELSE 0 END) AS n_val,
                       SUM(CASE WHEN sell_verify_verdict = 'invalidated' THEN 1 ELSE 0 END) AS n_inval
                FROM ai_learning_events
                WHERE sell_verify_date IS NOT NULL
                  AND sell_primary_driver IS NOT NULL
                  AND sell_primary_driver NOT IN (
                        'position_sizing', 'risk_management', 'tax_optimisation', 'regime_change'
                      )
                GROUP BY sell_primary_driver
                HAVING COUNT(*) >= 3
                ORDER BY COUNT(*) DESC
            """).fetchall()
            sell_tag_stats = [dict(r) for r in sell_tag_rows]

            # Sprint 45: thesis drift — compare manual exits vs target hits.
            _thesis_drift = _compute_thesis_drift(conn)

            # Sprint 71 Phase 3B: distinct entry drivers among the requested
            # portfolio tickers — used to scope the per-driver playbook (deep mode).
            tickers_drivers: list[str] = []
            if tickers_req:
                _ph = ",".join("?" * len(tickers_req))
                _dr_rows = conn.execute(
                    f"""SELECT DISTINCT primary_entry_driver
                          FROM ai_learning_events
                         WHERE recommendation IN ('BUY','TOP_UP')
                           AND primary_entry_driver IS NOT NULL
                           AND ticker IN ({_ph})""",
                    tuple(tickers_req),
                ).fetchall()
                tickers_drivers = [r["primary_entry_driver"] for r in _dr_rows]
            # Fallback: if no per-ticker drivers (e.g. fresh holdings), use every
            # driver that has closed history so the playbook can still surface.
            if not tickers_drivers:
                _all_dr = conn.execute(
                    """SELECT DISTINCT primary_entry_driver
                         FROM ai_learning_events
                        WHERE recommendation IN ('BUY','TOP_UP')
                          AND primary_entry_driver IS NOT NULL"""
                ).fetchall()
                tickers_drivers = [r["primary_entry_driver"] for r in _all_dr]

        # Gate: personalised calibration nudges require n ≥ 30 to avoid chasing noise.
        # Below that, return an ASX base-rate prior so the user message still has a
        # calibration anchor — Claude won't start from scratch for early-stage accounts.
        if len(rows) < 30:
            regime_note = f",regime={regime}" if regime else ""
            return {
                "available":          True,
                "calibration_active": False,
                "block": (
                    f"CALIBRATION(prior,n={len(rows)}{regime_note}): "
                    "Insufficient personal data for personalised calibration. "
                    "ASX historical base rates: bull-regime BUY win-rate≈54%, "
                    "bear≈36%, sideways≈48%. "
                    "Apply conservative sizing (max 50% of normal qty) until n≥30 closed trades. "
                    "Do not override these priors with high confidence."
                ),
                "exemplars": [],
            }

        n = len(rows)
        parts = []
        # §8.3: machine-readable mirror of the text nudges. The engine applies these
        # deterministically post-response (analysis.js) — the text block is context
        # only. Survives token-budget truncation of `parts` (computed independently).
        adjustments = {"bands": {}, "tickers": {}}

        # Fix #18: merge virtual outcomes (0.75× weight) into rows for all downstream calcs.
        # Virtual rows don't count toward `n` (the real-data gate) — only toward weighted stats.
        rows_all = [dict(r) for r in rows] + virtual_rows

        # ── Phase 8 gate: activate skill weighting only when scores predict outcomes ──
        # Python closures read names at call time, so assigning _phase8_active here
        # (in the same function scope as the earlier `_phase8_active = False`)
        # makes _weight() see the updated value when first called below.
        _scored_rows = [r for r in rows if r["skill_score"] is not None]
        if len(_scored_rows) >= 10:
            _win_sk  = [float(r["skill_score"]) for r in _scored_rows if r["outcome_status"] == "win"]
            # Fix #16: exclude good losses (protective_stop + external_shock) from gate comparison
            _loss_sk = [float(r["skill_score"]) for r in _scored_rows
                        if r["outcome_status"] in ("loss", "breakeven") and not _is_good_loss(r)]
            if _win_sk and _loss_sk:
                _phase8_active = _mann_whitney_z(_win_sk, _loss_sk) > 1.28  # same gate as _compute_phase8_meta()

        # calib_rows built from rows_all (real + virtual) so virtual outcomes
        # participate in conf-band/regime/sector calibration at their 0.75× weight.
        calib_rows = [r for r in rows_all if not _is_shock(r)]
        n_excluded = n - len([r for r in rows if not _is_shock(r)])

        # Sprint 70: ESS floor raised 2.5→6.0. A conditional win-rate claim needs
        # real statistical power; 2.5 effective trades licensed conclusions from
        # noise. 6.0 is the minimum at which a ±5pp delta starts to clear its CI.
        _ESS_MIN = 6.0  # Kish ESS threshold — suppresses calibration when decay renders
                        # sample statistically unreliable (e.g. 1 fresh + 3 very stale trades)
        _MIN_NUDGE_N = 12  # Sprint 70: raw-count floor for behaviour-changing tag nudges.
        # Sprint 71 Phase 2D: stop_too_tight tag-precision self-suppression gate.
        _STOP_TAG_MIN_N    = 5    # min resolved counterfactuals before trusting precision
        _STOP_TAG_PREC_MIN = 0.5  # <50% wider-stop-saved ⇒ tag unreliable, suppress nudge

        # 1. Confidence bands — ESS≥6 AND |delta|>5pp AND Wilson CI excludes the
        #    band midpoint (Sprint 70: the CI gate withholds small-n flukes).
        for label, lo, hi, mid in [("60-70", 0.60, 0.70, 0.65), ("70-80", 0.70, 0.80, 0.75),
                                    ("80-90", 0.80, 0.90, 0.85)]:
            subset = [r for r in calib_rows if lo <= (r["ai_confidence"] or 0) < hi]
            if not subset:
                continue
            ess = _ess(subset)
            if ess < _ESS_MIN:
                # Low ESS: warn rather than emit a calibration nudge
                parts.append(f"conf {label}%:⚠low ESS={ess:.1f}(n={len(subset)})—data too stale for reliable calibration")
                continue
            wr    = _wwr(subset)
            delta = wr - mid
            raw_wins = sum(1 for r in subset if r["outcome_status"] == "win")
            if abs(delta) > 0.05 and _ci_excludes(raw_wins, len(subset), mid):
                adj_val = round(max(-0.15, min(0.10, delta * 0.8)), 2)
                adjustments["bands"][label] = adj_val
                parts.append(f"conf {label}%:{wr*100:.0f}%WR(Δ{delta*100:+.0f}pp,adj{adj_val:+.2f},ESS={ess:.1f})")

        # 2. Current regime — hierarchical fallback when ESS < 2.5
        # Level 1: specific regime (e.g. "bearTrending")
        # Level 2: macro group  (bearish / bullish / neutral — see _REGIME_GROUPS)
        # Level 3: all trades   (90d window, mild 0.7× discount to flag lack of specificity)
        _REGIME_GROUPS = {
            "bearish": {"riskOff", "panic"},
            "bullish": {"riskOn", "trend"},
            "neutral": {"highVol", "sideways"},
        }
        def _regime_macro(r_name):
            """Return the macro-group name for a regime, or None if not mapped."""
            for grp, members in _REGIME_GROUPS.items():
                if r_name in members:
                    return grp
            return None

        if regime:
            reg = [r for r in rows_all if r["regime"] == regime]
            ess_reg = _ess(reg) if reg else 0.0
            if ess_reg >= _ESS_MIN:
                # Level 1: specific regime — reliable data
                wr   = _wwr(reg)
                warn = " ⚠AVOID" if wr < 0.40 else (" ⚠CAUTION" if wr < 0.50 else "")
                parts.append(f"{regime}:{wr*100:.0f}%W(ESS={ess_reg:.1f}){warn}")
            else:
                # Specific regime is thin — try macro-group fallback
                macro = _regime_macro(regime)
                macro_rows = [r for r in rows_all if _regime_macro(r["regime"] or "") == macro] if macro else []
                ess_macro  = _ess(macro_rows) if macro_rows else 0.0
                if macro and ess_macro >= _ESS_MIN:
                    wr   = _wwr(macro_rows)
                    warn = " ⚠AVOID" if wr < 0.40 else (" ⚠CAUTION" if wr < 0.50 else "")
                    parts.append(
                        f"{regime}⚠thin(ESS={ess_reg:.1f})→{macro}proxy:{wr*100:.0f}%W"
                        f"(ESS={ess_macro:.1f},n={len(macro_rows)}){warn}"
                    )
                else:
                    # No usable macro data either — fall back to all trades at 0.7× discount
                    # Represent as a warning so Claude knows specificity is low
                    if rows_all:
                        wr_all = _wwr(rows_all)
                        parts.append(
                            f"{regime}⚠thin(ESS={ess_reg:.1f})→allRegimes:{wr_all*100:.0f}%W"
                            f"(n={n},discount0.7×)⚠low-specificity"
                        )
                    else:
                        parts.append(f"⚠{regime}:no calibration data available")

        # 3. Relevant sectors — framed as a DELTA vs the whole-ASX-market baseline.
        # The baseline is the overall (all-rows) win rate — `mkt_wr`. An absolute
        # sector WR is not actionable on its own (a 55% sector reads as strong in a
        # 45% market and weak in a 65% market), so every sector line shows the
        # signed delta and gates the ✓strong / ⚠underperform flag on it. The flag
        # only fires when the sector's Wilson 95% CI (on RAW win/total counts)
        # excludes the market baseline — withholds small-n flukes (gotcha #42).
        # Deep mode: full per-sector breakdown. Light mode: one-line worst/best.
        _mkt_wr = _wwr(calib_rows) if calib_rows else 0.0
        _sector_lines = []   # (abs_delta, formatted_line, is_flagged)
        for sector in sectors:
            s_rows = [r for r in rows_all if r["sector"] == sector]
            if not s_rows:
                continue
            if _ess(s_rows) < _ESS_MIN:
                continue
            wr    = _wwr(s_rows)
            delta = wr - _mkt_wr
            s_wins  = sum(1 for r in s_rows if r["outcome_status"] == "win")
            s_total = len(s_rows)
            significant = _ci_excludes(s_wins, s_total, _mkt_wr)
            flag = ""
            if significant:
                if delta <= -0.05:
                    flag = " ⚠underperform"
                elif delta >= 0.05:
                    flag = " ✓strong"
            line = (f"{sector}:{wr*100:.0f}%WR vs mkt {_mkt_wr*100:.0f}% "
                    f"({delta*100:+.0f}pp,n={s_total}){flag}")
            _sector_lines.append((abs(delta), line, bool(flag)))
        if _sector_lines:
            _sector_lines.sort(key=lambda x: x[0], reverse=True)
            if deep:
                # Full breakdown (most-divergent first) in the deep feed.
                for _, line, _f in _sector_lines:
                    parts.append(line)
            else:
                # Light feed: one compact summary line — the most divergent
                # flagged sector (worst or best), or the most divergent overall.
                flagged = [t for t in _sector_lines if t[2]]
                pick = flagged[0] if flagged else _sector_lines[0]
                parts.append("sector:" + pick[1])

        # 4. Strategy decay — recent 30d vs full window; only if clearly decaying (Δ<-15pp, n≥5)
        # Regime-specific sub-check: if global decay detected, compare current-regime recent trades.
        # If current regime is stable (|reg_delta|<8pp), the decay is likely regime-exposure
        # (under-performance in other regimes) rather than a universal strategy breakdown.
        recent_rows = [r for r in rows_all if r["timestamp"] >= cutoff_30]
        if len(recent_rows) >= 5 and n >= 10:
            all_wr       = _wwr(rows_all)
            rec_wr       = _wwr(recent_rows)
            global_delta = rec_wr - all_wr
            if global_delta < -0.15:
                interpretation_appended = False
                if regime:
                    reg_recent = [r for r in recent_rows if (r.get("regime") or "") == regime]
                    if len(reg_recent) >= 3:
                        reg_wr    = _wwr(reg_recent)
                        reg_delta = reg_wr - all_wr
                        if abs(reg_delta) < 0.08:
                            parts.append(
                                f"⚠decay:{rec_wr*100:.0f}%recent/{all_wr*100:.0f}%all"
                                f"(Δ{global_delta*100:+.0f}pp)"
                                f" but {regime}:{reg_wr*100:.0f}%stable"
                                f"→likely-regime-exposure(not universal decay)"
                            )
                        else:
                            parts.append(
                                f"⚠decay:{rec_wr*100:.0f}%recent/{all_wr*100:.0f}%all"
                                f"(Δ{global_delta*100:+.0f}pp)"
                                f",{regime}:{reg_wr*100:.0f}%(Δ{reg_delta*100:+.0f}pp)"
                                f"→reduce posn 30%"
                            )
                        interpretation_appended = True
                if not interpretation_appended:
                    parts.append(
                        f"⚠decay:{rec_wr*100:.0f}%recent/{all_wr*100:.0f}%all"
                        f"(Δ{global_delta*100:+.0f}pp)→reduce posn 30%"
                    )

        # 5. R:R accuracy — n≥5 high-R:R with clear underperformance
        hi_rr = [r for r in rows_all if (r["rr_ratio"] or 0) >= 2.0]
        if len(hi_rr) >= 5:
            hi_wr = _wwr(hi_rr)
            if hi_wr < 0.50:
                parts.append(f"RR≥2.0:{hi_wr*100:.0f}%WR(n={len(hi_rr)})⚠stops/targets off→widen stops")

        # 6. Dominant learnable error in non-shock losses — L2: threshold lowered to 33%, n≥3
        learnable_losses = [r for r in rows if r["outcome_status"] == "loss"
                            and "external_shock" not in (r["error_type"] or "").split(",")]
        # Gap 6: if auto-tag accuracy < 60%, restrict to manually-reviewed events only.
        if not _auto_tags_ok:
            learnable_losses = [r for r in learnable_losses
                                if (r["error_type_source"] or "") != "auto"]
        if len(learnable_losses) >= _MIN_NUDGE_N:
            type_counts: dict = {}
            for r in learnable_losses:
                et = r["error_type"] if "error_type" in r.keys() else None
                if et:
                    for tag in et.split(","):
                        tag = tag.strip()
                        if tag and tag != "external_shock":
                            type_counts[tag] = type_counts.get(tag, 0) + 1
            if type_counts:
                top_et, top_cnt = max(type_counts.items(), key=lambda x: x[1])
                top_pct = top_cnt / len(learnable_losses)
                if top_pct >= 0.33:
                    short = {"overconfident": "OC", "missed_catalyst": "MC",
                             "regime_mismatch": "RM", "poor_entry": "PE",
                             "stop_too_tight": "ST", "poor_rr": "PR",
                             "thesis_broken": "TB", "early_exit": "EE",
                             "oversized": "OS", "undersized": "US"}.get(top_et, top_et)
                    # Sprint 71 Phase 2D: self-suppress the "widen stops" nudge when the
                    # stop_too_tight counterfactual precision is low — i.e. a wider stop
                    # would NOT have rescued most of these trades, so the tag is firing on
                    # losers whose real problem was the entry/thesis, not the stop width.
                    # Mirrors the ⚠AUTO_TAGS_UNRELIABLE pattern.
                    _stp = _stop_tag_prec or {}
                    _stp_n    = _stp.get("n") or 0
                    _stp_prec = _stp.get("precision")
                    _stop_tag_unreliable = (
                        top_et == "stop_too_tight"
                        and _stp_n >= _STOP_TAG_MIN_N
                        and _stp_prec is not None
                        and _stp_prec < _STOP_TAG_PREC_MIN
                    )
                    if _stop_tag_unreliable:
                        parts.append(
                            f"⚠STOP_TAG_UNRELIABLE({int(_stp_prec*100)}%wider-stop-saved,"
                            f"n={_stp_n})→stop-width nudge suppressed"
                        )
                    else:
                        parts.append(
                            f"top_err:{short}({top_cnt}/{len(learnable_losses)}losses)→"
                            + ("reduce conf" if top_et == "overconfident" else
                               "check news" if top_et == "missed_catalyst" else
                               "check regime fit" if top_et == "regime_mismatch" else
                               "refine entry timing" if top_et == "poor_entry" else
                               "widen stops" if top_et == "stop_too_tight" else
                               "require min R:R 2.5" if top_et == "poor_rr" else
                               "hold to plan/target" if top_et == "early_exit" else
                               "reduce position size" if top_et == "oversized" else
                               "size up to plan" if top_et == "undersized" else
                               "add re-validation step")
                        )
        # Gap 6: auto-tags unreliable and not enough manually-reviewed events — warn Claude.
        if not _auto_tags_ok and len(learnable_losses) < _MIN_NUDGE_N:
            parts.append(f"⚠AUTO_TAGS_UNRELIABLE({int(_auto_tag_agree*100)}%agree,n={_auto_tag_n})→err nudge suppressed")

        # 6b. Dominant success tag — mirror of L2 dominant error check
        # Only emit when ESS of wins is high enough to trust the pattern.
        wins_tagged = [r for r in rows_all if r["outcome_status"] == "win"
                       and r.get("success_tags") and r["success_tags"] not in ("", "none")]
        if len(wins_tagged) >= _MIN_NUDGE_N:
            win_ess = _ess(wins_tagged)
            if win_ess >= _ESS_MIN:
                stag_counts: dict = {}
                for r in wins_tagged:
                    for tag in (r["success_tags"] or "").split(","):
                        tag = tag.strip()
                        if tag and tag != "none":
                            stag_counts[tag] = stag_counts.get(tag, 0) + 1
                if stag_counts:
                    top_st, top_sc = max(stag_counts.items(), key=lambda x: x[1])
                    top_spct = top_sc / len(wins_tagged)
                    if top_spct >= 0.33:
                        parts.append(
                            f"✓{top_st}({top_sc}/{len(wins_tagged)}wins,ESS={win_ess:.1f})"
                            "→lean into this"
                        )

        # 6c. Cluster loss detection — ≥3 losses within a 5-trading-day window
        # indicates correlated losses (sector/macro event), not independent failures.
        # Lower priority than top_err / success nudge (placed after 6b) — survives
        # truncation less often but avoids displacing the more actionable error nudge.
        _loss_rows_dated = sorted(
            [r for r in rows if r["outcome_status"] in ("loss", "breakeven") and r["timestamp"]],
            key=lambda r: r["timestamp"]
        )
        if len(_loss_rows_dated) >= 3:
            from datetime import timedelta as _td
            for _i, _anchor in enumerate(_loss_rows_dated):
                try:
                    _anchor_dt = datetime.fromisoformat(_anchor["timestamp"][:10])
                    _window = [r for r in _loss_rows_dated[_i:]
                               if (datetime.fromisoformat(r["timestamp"][:10]) - _anchor_dt).days <= 5]
                    if len(_window) >= 3:
                        parts.append(
                            f"⚠CLUSTER_LOSS({len(_window)} losses in 5d "
                            f"from {_anchor['timestamp'][:10]})→check portfolio correlation"
                        )
                        break
                except Exception:
                    continue

        # 6d. Correlation-drag nudge — do new positions entered at HIGH correlation
        # to existing holdings underperform? `max_corr_to_holdings` is captured in
        # market_context JSON at generation time (the same check analysis.js already
        # uses to halve/cut BUY/TOP_UP size — see §9.3) but was never read back into
        # calibration. Real (non-virtual) closed BUY/TOP_UP only — correlation-to-
        # holdings is a new-money concept, not meaningful for SELL/TRIM/HOLD, and
        # virtual (never-executed) rows carry no market_context. 0.7 matches
        # analysis.js's own "high correlation" cutoff. CI-gated on the high-corr
        # bucket's Wilson interval vs the low-corr bucket's raw win rate so a small-n
        # fluke can't drive it; both buckets need _MIN_NUDGE_N for the comparison to
        # carry any weight.
        _corr_rows = [r for r in rows_all if r.get("recommendation") in ("BUY", "TOP_UP")]
        _hi_corr, _lo_corr = [], []
        for r in _corr_rows:
            try:
                _mc = json.loads(r.get("market_context") or "{}")
            except Exception:
                _mc = {}
            _mcorr = _mc.get("max_corr_to_holdings")
            if not isinstance(_mcorr, (int, float)):
                continue
            (_hi_corr if abs(_mcorr) > 0.7 else _lo_corr).append(r)
        if len(_hi_corr) >= _MIN_NUDGE_N and len(_lo_corr) >= _MIN_NUDGE_N:
            _hi_wins = sum(1 for r in _hi_corr if r["outcome_status"] == "win")
            _lo_wins = sum(1 for r in _lo_corr if r["outcome_status"] == "win")
            _lo_wr   = _lo_wins / len(_lo_corr)
            if _ci_excludes(_hi_wins, len(_hi_corr), _lo_wr):
                _hi_wr = _hi_wins / len(_hi_corr) * 100
                parts.append(
                    f"⚠CORR_DRAG(corr>0.7 entries {_hi_wr:.0f}%WR n={len(_hi_corr)} vs "
                    f"low-corr {_lo_wr*100:.0f}%WR n={len(_lo_corr)})→cut size or skip high-correlation adds"
                )

        # 7. Per-ticker memory — ESS≥_ESS_MIN (6.0) AND |delta from overall WR| > 15pp
        if tickers_req and len(calib_rows) >= 5:
            overall_wr = _wwr(calib_rows)
            ticker_parts = []
            for tk in tickers_req[:5]:
                tk_rows = [r for r in calib_rows if r["ticker"] == tk]
                if not tk_rows or _ess(tk_rows) < _ESS_MIN:
                    continue
                tk_wr = _wwr(tk_rows)
                delta = tk_wr - overall_wr
                if abs(delta) > 0.15:
                    direction = "✓strong" if delta > 0 else "⚠weak"
                    if delta < 0:
                        # Penalty-only, matching the prompt's documented per-ticker rule
                        # ("apply an extra −0.10 to that ticker's confidence").
                        adjustments["tickers"][tk] = -0.10
                    ticker_parts.append(
                        f"{tk}:{tk_wr*100:.0f}%(Δ{delta*100:+.0f}pp,ESS={_ess(tk_rows):.1f}){direction}"
                    )
            if ticker_parts:
                parts.append("per-ticker:" + ",".join(ticker_parts))

        # 8. Sector × current regime interaction — most actionable for ASX sector
        # rotation. Framed as a DELTA vs the whole-market baseline (overall WR),
        # same convention as section 3. Fires when current regime is known, ESS≥6.0,
        # |delta| ≥ 12pp, AND the sector's Wilson 95% CI excludes the market WR
        # (significance gate, gotcha #42) — the ✓/⚠ flag only shows when the
        # divergence clears the noise. Capped at 2 entries to stay within budget.
        if regime and len(calib_rows) >= 10:
            # _wwr is cheap + idempotent — assign unconditionally rather than the
            # fragile `"overall_wr" not in dir()` guard (Audit I-6).
            overall_wr = _wwr(calib_rows)
            sx_rows = [r for r in calib_rows if r["regime"] == regime and r["sector"]]
            sx_groups: dict = {}
            for r in sx_rows:
                sx_groups.setdefault(r["sector"], []).append(r)
            sx_parts = []
            for sector, s_rows in sx_groups.items():
                sx_ess = _ess(s_rows)
                if sx_ess < _ESS_MIN:
                    continue
                sx_wr  = _wwr(s_rows)
                delta  = sx_wr - overall_wr
                if abs(delta) >= 0.12:
                    sx_wins  = sum(1 for r in s_rows if r["outcome_status"] == "win")
                    sx_total = len(s_rows)
                    sig = _ci_excludes(sx_wins, sx_total, overall_wr)
                    direction = ("✓" if delta > 0 else "⚠") if sig else ""
                    sx_parts.append((
                        abs(delta),
                        f"{sector}:{sx_wr*100:.0f}% vs mkt {overall_wr*100:.0f}%"
                        f"(Δ{delta*100:+.0f}pp,ESS={sx_ess:.1f}){direction}"
                    ))
            if sx_parts:
                # Sort by |delta| descending; keep top 2
                sx_parts.sort(key=lambda x: x[0], reverse=True)
                parts.append(f"sector×{regime}:" + ",".join(p[1] for p in sx_parts[:2]))

        # 9. Sell tag validation — surface when a SELL driver is consistently reliable/unreliable.
        # Only verifiable drivers are included (target_reached, thesis_broken, stop_triggered,
        # technical_breakdown, better_opportunity, time_stop). Requires n≥3 per driver.
        if sell_tag_stats:
            _DRV_SHORT = {
                "time_stop":           "time_stop",
                "target_reached":      "target_rch",
                "better_opportunity":  "better_opp",
                "thesis_broken":       "thesis_brk",
                "stop_triggered":      "stop_trig",
                "technical_breakdown": "tech_break",
            }
            _DRV_TIP = {
                "time_stop":           "→CUTTING WINNERS:extend hold",
                "target_reached":      "→stock kept rising:raise targets",
                "better_opportunity":  "→alt rarely better",
                "thesis_broken":       "→stock recovered:tighten entry",
                "stop_triggered":      "→stock recovered:tighten entry",
                "technical_breakdown": "→breakdown reversed:need confluence",
            }
            st_parts = []
            for st in sell_tag_stats[:3]:  # cap at 3 drivers to stay within token budget
                drv      = st["sell_primary_driver"]
                n_st     = st["n"]
                val_rate   = st["n_val"]   / n_st
                inval_rate = st["n_inval"] / n_st
                short = _DRV_SHORT.get(drv, drv[:10])
                if inval_rate >= 0.50:
                    tip = _DRV_TIP.get(drv, "→unreliable")
                    st_parts.append(f"⚠SELL_TAG:{short}(n={n_st},val={val_rate*100:.0f}%){tip}")
                elif val_rate >= 0.65:
                    st_parts.append(f"✓SELL_TAG:{short}(n={n_st},val={val_rate*100:.0f}%)→reliable")
            if st_parts:
                parts.append(" | ".join(st_parts))

        # 9b. Lesson drag — warn when a trading lesson is making performance worse.
        # Reads lesson-effectiveness results directly (no extra network call — same conn).
        # Only fires when n_after >= 5 and delta_pp <= -5 AND n<=3 worst offenders.
        try:
            _drag_lessons = _compute_lesson_effectiveness(conn, min_n_after=5)
            _drag_lines = [l for l in _drag_lessons if l.get("delta_pp") is not None and l["delta_pp"] <= -5.0]
            if _drag_lines:
                _drag_lines.sort(key=lambda l: l["delta_pp"])
                _drag_top = _drag_lines[:2]
                for _dl in _drag_top:
                    scope = _dl.get("ticker") or _dl.get("sector") or _dl.get("regime") or "general"
                    parts.append(
                        f"⚠LESSON_DRAG({scope},Δ{_dl['delta_pp']:+.0f}pp,n={_dl['n_after']})→consider removing"
                    )
        except Exception:
            pass

        # Sprint 44: insert regime-flip warning at the front (high priority — survives truncation)
        if _regime_flip_token:
            parts.insert(0, _regime_flip_token)

        # Sprint 45: thesis drift nudge — lowest priority (appended last, first to drop).
        if _thesis_drift.get("nudge"):
            parts.append(_thesis_drift["nudge"])

        # Sprint 68: thesis-accuracy matrix nudge — very lowest priority (last item,
        # first to drop under token budget). Only fires when a driver has both
        # validated n≥5 and invalidated n≥5 with a win-rate gap ≥25pp.
        try:
            _tm = _compute_thesis_matrix(conn)
            _tm_insight = _tm.get("insight", "")
            if _tm_insight:
                # Extract the driver and win-rates from the insight for a compact token.
                # Full insight emitted only if space; otherwise compact THESIS: token.
                for _drv, _cells in _tm.get("matrix", {}).items():
                    _val_cell   = _cells.get("validated",   {"n": 0, "win_rate": 0.0})
                    _inval_cell = _cells.get("invalidated", {"n": 0, "win_rate": 0.0})
                    if _val_cell["n"] >= 5 and _inval_cell["n"] >= 5:
                        _gap = _val_cell["win_rate"] - _inval_cell["win_rate"]
                        if _gap >= 25.0:
                            parts.append(
                                f"THESIS:{_drv} val={_val_cell['win_rate']:.0f}% inval={_inval_cell['win_rate']:.0f}%"
                            )
                            break  # only one driver nudge per calibration block
        except Exception:
            pass  # never let thesis-matrix errors break calibration

        # HOLD outcome tracking: nudge when HOLD recs frequently sat through a
        # sustained adverse move — the model is too passive. Gated in
        # _compute_hold_outcome_nudge() on a raw-count floor (n>=_MIN_NUDGE_N)
        # AND a Wilson 95% CI whose lower bound clears 50%, same as every other
        # behaviour-changing nudge in this module (gotcha #42/#92).
        try:
            _hold_nudge = _compute_hold_outcome_nudge(conn)
            if _hold_nudge:
                parts.append(_hold_nudge)
        except Exception:
            pass

        # ── Sprint 71 Phase 3B/3C — heavy conditional blocks (deep mode only) ──
        # These are the lowest-priority, most token-heavy lines. They are appended
        # last so the priority-ordered truncation below drops them first, and are
        # gated on `deep` so the high-frequency (light) refresh path never pays for
        # them. The cached system prompt means this learning block is the only
        # marginal token cost, so the light path stays lean.
        exemplars: list[str] = []
        if deep:
            try:
                for _pb in _compute_driver_playbook(conn, tickers_drivers, _ci_excludes):
                    parts.append(_pb)
            except Exception:
                pass
            try:
                _dx = _compute_driver_regime_xtab(conn, regime, _ci_excludes)
                if _dx:
                    parts.append(_dx)
            except Exception:
                pass
            try:
                _sx = _compute_setup_bucket_xtab(conn, _ci_excludes)
                if _sx:
                    parts.append(_sx)
            except Exception:
                pass
            try:
                _neg = _compute_sell_negative_confirmation(conn)
                if _neg:
                    parts.append(_neg)
            except Exception:
                pass
            try:
                _exq = _compute_exit_quality_nudge(conn)
                if _exq:
                    parts.append(_exq)
            except Exception:
                pass
            # Exemplars ride a separate field (not the char-budgeted `parts`) so the
            # concrete few-shot examples — the highest-impact behavioural lever — are
            # never silently truncated by the calibration token budget. analysis.js
            # injects them as their own EXEMPLARS: block.
            #
            # Sector preference: when the portfolio under analysis is concentrated in
            # one sector, prefer same-sector exemplars. The dominant sector is the
            # most common sector across the requested tickers (via core.SECTOR_MAP),
            # falling back to the first requested `sectors` entry. _compute_exemplars
            # falls back to whole-market when same-sector trades are too few.
            _dominant_sector = None
            try:
                from core import SECTOR_MAP as _SMAP
                _sec_counts: dict = {}
                for _t in tickers_req:
                    _b = _t.upper()
                    _b = _b[:-3] if _b.endswith(".AX") else _b
                    _s = _SMAP.get(_b)
                    if _s:
                        _sec_counts[_s] = _sec_counts.get(_s, 0) + 1
                if _sec_counts:
                    _dominant_sector = max(_sec_counts.items(), key=lambda x: x[1])[0]
                elif sectors:
                    _dominant_sector = sectors[0]
            except Exception:
                _dominant_sector = sectors[0] if sectors else None
            try:
                exemplars = _compute_exemplars(conn, sector=_dominant_sector)
            except Exception:
                exemplars = []

        if not parts:
            return {"available": False, "block": None,
                    "exemplars": exemplars if deep else []}

        # ── Gap 8: token budget — priority-ordered truncation ─────────────────
        # Parts are appended in priority order (conf bands first, per-ticker last).
        # Drop from the end (lowest priority) until under the operating budget.
        # Hard ceiling applied as a safety net after truncation.
        # Deep mode raises the budget so the Phase 3 conditional blocks survive
        # (they are intentionally part of the morning-briefing / weekly-review feed).
        _CALIB_CHAR_BUDGET  = 900 if deep else 400   # ~225 / ~100 tokens target
        _CALIB_CHAR_CEILING = 1100 if deep else 600  # ~275 / ~150 tokens hard ceiling
        while len(parts) > 1 and len("; ".join(parts)) > _CALIB_CHAR_BUDGET:
            parts.pop()
        block_body = "; ".join(parts)
        if len(block_body) > _CALIB_CHAR_CEILING:
            block_body = block_body[:_CALIB_CHAR_CEILING - 1] + "…"

        date_from  = cutoff[:7]
        date_to    = datetime.now().strftime("%Y-%m")
        regime_tag = f",{regime}" if regime else ""
        excl_note  = f",{n_excluded}excl" if n_excluded > 0 else ""
        hl_note    = f",hl={hl}d" if hl != 45 else ""
        # Fix #18: include virtual count in header so Claude knows some data is synthetic
        virt_note  = f",{n_virtual}v" if n_virtual > 0 else ""
        block = (
            f"CALIBRATION({n}cls{virt_note},{date_from}→{date_to}{regime_tag}{excl_note}{hl_note}): "
            + block_body + "."
        )
        return {"available": True, "block": block, "sample": n, "adjustments": adjustments,
                "exemplars": exemplars if deep else []}
    except Exception as e:
        return {"error": str(e)}


@bp.route("/api/learning/calibration")
def learning_calibration():
    """Smart compact calibration block for AI prompt injection. Results are
    TTL-cached for 5 minutes (L4) — keyed by regime + sectors + tickers + days.

    Signal quality improvements vs naive equal-weight averaging:
    - Exponential time-decay (half-life 45d)
    - external_shock / protective_stop excluded from confidence-band calibration
    - Regime freshness gate (L1: silent when 0 trades, warn at 1-2)
    - Error-type threshold lowered to 33% from 40% for earlier pattern detection (L2)
    - Sprint 44: regime-flip penalty — halve hl for first <10 trades in new regime
    - Sprint 71 Phase 3D: deep=1 adds the token-heavy exemplar/playbook/cross-tab
      blocks (morning-briefing / weekly-review path); light (default) is stats-only
      for high-frequency intraday refreshes.
    """
    regime      = request.args.get("regime", "")
    sectors_str = request.args.get("sectors", "")
    tickers_str = request.args.get("tickers", "")
    days        = min(int(request.args.get("days", 90)), 180)
    flipped_at  = request.args.get("flipped_at", "")
    flipped_to  = request.args.get("flipped_to", "")
    deep        = request.args.get("deep", "") in ("1", "true", "True")

    # L4: serve from cache if fresh (Fix #8: lock protects dict access only)
    # flipped_at/flipped_to are not part of the cache key — they are short-lived
    # and the TTL (5 min) is shorter than the minimum meaningful penalty window.
    # `deep` IS part of the key — deep and light produce materially different blocks.
    cache_key = (regime, sectors_str, tickers_str, days, deep)
    with _calib_lock:
        cached = _calib_cache.get(cache_key)
        if cached and (time.time() - cached[1]) < _CALIB_TTL:
            return jsonify(cached[0])

    # Expensive computation runs outside the lock to avoid blocking other threads
    result = _calib_compute(regime, sectors_str, tickers_str, days, flipped_at, flipped_to, deep)

    if "error" not in result:
        with _calib_lock:
            _calib_cache[cache_key] = (result, time.time())
            # Prune if cache grows unexpectedly (many different param combos)
            if len(_calib_cache) > 50:
                oldest = sorted(_calib_cache.items(), key=lambda x: x[1][1])[:25]
                for k, _ in oldest:
                    _calib_cache.pop(k, None)

    if "error" in result:
        return jsonify(result), 500
    return jsonify(result)


# ── Thesis Drift Detection (Sprint 45) ───────────────────────────────────────

def _compute_thesis_drift(conn) -> dict:
    """Compare avg realized_pnl_pct of manual early exits vs target hits.

    Returns dict with counts, averages, and a nudge token string (or None).
    Minimum 5 events in each bucket before computing.
    """
    rows = conn.execute("""
        SELECT exit_reason, realized_pnl_pct
        FROM ai_learning_events
        WHERE was_executed = 1
          AND outcome_status IN ('win', 'loss', 'breakeven')
          AND realized_pnl_pct IS NOT NULL
          AND exit_reason IN ('manual', 'target_hit')
    """).fetchall()

    manual = [r["realized_pnl_pct"] for r in rows if r["exit_reason"] == "manual"]
    target = [r["realized_pnl_pct"] for r in rows if r["exit_reason"] == "target_hit"]

    result = {
        "n_manual":       len(manual),
        "n_target":       len(target),
        "avg_manual_pct": round(sum(manual) / len(manual), 2) if manual else None,
        "avg_target_pct": round(sum(target) / len(target), 2) if target else None,
        "nudge":          None,
    }

    if len(manual) >= 5 and len(target) >= 5:
        drag = result["avg_target_pct"] - result["avg_manual_pct"]
        if drag > 3.0:
            result["nudge"] = (
                f"⚠EARLY_EXIT_DRAG: manual_avg={result['avg_manual_pct']:+.1f}% "
                f"vs target_hit_avg={result['avg_target_pct']:+.1f}% "
                f"(n_manual={len(manual)},n_target={len(target)}) "
                f"→ hold longer before manual exits"
            )
    return result


@bp.route("/api/learning/thesis-drift")
def thesis_drift():
    with get_db() as conn:
        result = _compute_thesis_drift(conn)
    return jsonify({**result, "ok": True})


# ── Execution alpha (Sprint 63) ───────────────────────────────────────────────
# Generalises thesis drift: for every EXECUTED closed BUY/TOP_UP trade, simulate
# what the mechanical rules (stop / target / 15-bar time-stop) would have
# produced on the same entry, then compare with the actual realized P&L.
# alpha = avg(actual) − avg(mechanical). Positive = manual exits add value.

def _resolve_execution_alpha(conn, cap: int = 5) -> int:
    """Lazily simulate the mechanical exit for unresolved executed trades.

    Bar walk from the entry date (same machinery as _resolve_virtual_outcomes):
      - stop checked FIRST within each bar — the conservative backtest
        convention when both levels fall inside one bar's range
      - target hit → exit at target
      - neither within 15 bars → exit at the 15th bar's close ('time') —
        mirrors the §6 time-based exit ceiling (riskOn max hold 15 days)
      - fewer than 15 bars elapsed and no hit → too early, leave unresolved

    Writes exec_mech_pnl_pct + exec_mech_exit. Capped per call to bound
    yfinance round-trips (the endpoint resolves a few more on each visit).
    """
    try:
        rows = conn.execute("""
            SELECT id, ticker, actual_entry_price, suggested_stop, suggested_target, timestamp,
                   regime, entry_signals_json
            FROM ai_learning_events
            WHERE was_executed = 1
              AND recommendation IN ('BUY', 'TOP_UP')
              AND outcome_status IN ('win', 'loss', 'breakeven')
              AND realized_pnl_pct IS NOT NULL
              AND actual_entry_price IS NOT NULL
              AND suggested_stop IS NOT NULL AND suggested_target IS NOT NULL
              AND exec_mech_pnl_pct IS NULL
            ORDER BY timestamp DESC LIMIT ?
        """, (cap,)).fetchall()
    except Exception:
        return 0
    if not rows:
        return 0

    try:
        import yfinance as yf
    except ImportError:
        return 0

    HORIZON = 15  # trading bars — strategy max hold (§6 time-based exit)
    resolved = 0
    for row in rows:
        try:
            entry  = float(row["actual_entry_price"])
            stop   = float(row["suggested_stop"])
            target = float(row["suggested_target"])
        except (TypeError, ValueError):
            continue
        if entry <= 0:
            continue
        ticker = row["ticker"] or ""
        yf_sym = ticker if ticker.endswith(".AX") else ticker + ".AX"
        try:
            hist = yf.Ticker(yf_sym).history(start=row["timestamp"][:10], interval="1d")
        except Exception:
            continue
        if hist.empty:
            continue

        # §9.2: same slippage convention as virtual outcomes — stop fills are
        # WORSE than the level (gap/queue), target fills require the bar to
        # clear the level by the margin, time-stop sells degrade by the margin.
        # Actual fills (realized_pnl_pct) already embed real-world slippage,
        # so the mechanical baseline must too, or alpha is overstated.
        slip = _event_slippage(row)

        exit_px, exit_kind = None, None
        for i, (_, bar) in enumerate(hist.iterrows(), 1):
            if bar["Low"] <= stop:
                exit_px, exit_kind = stop * (1 - slip), "stop"
                break
            if bar["High"] >= target * (1 + slip):
                exit_px, exit_kind = target, "target"
                break
            if i >= HORIZON:
                exit_px, exit_kind = float(bar["Close"]) * (1 - slip), "time"
                break
        if exit_px is None:
            continue  # < HORIZON bars elapsed, no level hit — resolve later

        mech_pct = round((exit_px - entry) / entry * 100, 2)
        conn.execute(
            "UPDATE ai_learning_events SET exec_mech_pnl_pct=?, exec_mech_exit=? WHERE id=?",
            (mech_pct, exit_kind, row["id"]))
        resolved += 1
    return resolved


def _mae_mfe_from_ohlc(hist, entry: float):
    """Pure helper: compute (mae_pct, mfe_pct) for a long entry over an OHLC frame.

    mae_pct = (min(Low) − entry) / entry × 100   → worst drawdown (≤0 for longs)
    mfe_pct = (max(High) − entry) / entry × 100  → best unrealised gain (≥0)

    Stop-first intrabar convention (gotcha #42): a straddle bar's adverse extreme
    (the Low) is always credited — we book the conservative drawdown by taking the
    full min of Low across the window, consistent with _resolve_execution_alpha.
    Returns (None, None) when the frame is empty or has no usable Low/High.
    Casts numpy scalars to python floats (gotcha #21).
    """
    if hist is None or len(hist) == 0 or not entry:
        return None, None
    try:
        low_min  = hist["Low"].min()
        high_max = hist["High"].max()
    except Exception:
        return None, None
    if low_min is None or high_max is None:
        return None, None
    import math
    lo = float(low_min)
    hi = float(high_max)
    if math.isnan(lo) or math.isnan(hi):
        return None, None
    mae_pct = round((lo - entry) / entry * 100, 2)
    mfe_pct = round((hi - entry) / entry * 100, 2)
    return mae_pct, mfe_pct


def _resolve_mae_mfe(conn, cap: int = 5) -> int:
    """Lazily compute MAE/MFE path stats for unresolved executed closed BUY/TOP_UP.

    For each qualifying trade, walk daily OHLC from the entry date across the hold
    window (bounded by holding_period_days, with a small floor/ceiling so a single
    same-day close or a stale row still yields a usable frame), then record the
    worst drawdown (mae_pct) and best unrealised gain (mfe_pct) via
    _mae_mfe_from_ohlc (stop-first intrabar convention, gotcha #42).

    Writes mae_pct, mfe_pct, mae_mfe_resolved_at. Idempotent (skips rows already
    resolved). Capped per call to bound yfinance round-trips. On fetch failure for
    a row, that row is skipped (left unresolved) rather than crashing the batch.
    """
    retry_cutoff = (datetime.now() - timedelta(days=_FETCH_RETRY_DAYS)).isoformat()
    try:
        rows = conn.execute("""
            SELECT id, ticker, actual_entry_price, timestamp, holding_period_days
            FROM ai_learning_events
            WHERE was_executed = 1
              AND recommendation IN ('BUY', 'TOP_UP')
              AND outcome_status IN ('win', 'loss', 'breakeven')
              AND actual_entry_price IS NOT NULL
              AND timestamp IS NOT NULL
              AND mae_mfe_resolved_at IS NULL
              AND (fetch_failed_at IS NULL OR fetch_failed_at < ?)
            ORDER BY timestamp DESC LIMIT ?
        """, (retry_cutoff, cap)).fetchall()
    except Exception:
        return 0
    if not rows:
        return 0

    try:
        import yfinance as yf
    except ImportError:
        return 0

    now_iso = datetime.now().isoformat(timespec="seconds")
    resolved = 0
    for row in rows:
        try:
            entry = float(row["actual_entry_price"])
        except (TypeError, ValueError):
            continue
        if entry <= 0:
            continue
        start_str = (row["timestamp"] or "")[:10]
        if not start_str:
            continue
        # Bound the OHLC window to the holding period (+1 day buffer so the exit
        # bar is included). Default to a 15-bar (~3wk) window when unknown.
        try:
            hold = int(row["holding_period_days"]) if row["holding_period_days"] is not None else 15
        except (TypeError, ValueError):
            hold = 15
        hold = max(1, hold)
        try:
            start_dt = datetime.strptime(start_str, "%Y-%m-%d")
            end_dt   = start_dt + timedelta(days=hold + 5)  # calendar buffer for weekends/holidays
            end_str  = end_dt.strftime("%Y-%m-%d")
        except ValueError:
            end_str = None

        ticker = row["ticker"] or ""
        yf_sym = ticker if ticker.endswith(".AX") else ticker + ".AX"
        try:
            if end_str:
                hist = yf.Ticker(yf_sym).history(start=start_str, end=end_str, interval="1d")
            else:
                hist = yf.Ticker(yf_sym).history(start=start_str, interval="1d")
        except Exception:
            _mark_fetch_failed(conn, row["id"])
            continue
        if hist is None or hist.empty:
            # A delisted/suspended/renamed ticker commonly returns empty rather
            # than raising — same starvation risk as the except branch above.
            _mark_fetch_failed(conn, row["id"])
            continue

        mae_pct, mfe_pct = _mae_mfe_from_ohlc(hist, entry)
        if mae_pct is None or mfe_pct is None:
            continue
        conn.execute(
            "UPDATE ai_learning_events SET mae_pct=?, mfe_pct=?, mae_mfe_resolved_at=? WHERE id=?",
            (mae_pct, mfe_pct, now_iso, row["id"]))
        resolved += 1
    return resolved


def _compute_execution_alpha(conn) -> dict:
    """Aggregate actual-vs-mechanical P&L over resolved executed trades."""
    rows = conn.execute("""
        SELECT realized_pnl_pct, exec_mech_pnl_pct, exec_mech_exit
        FROM ai_learning_events
        WHERE was_executed = 1
          AND exec_mech_pnl_pct IS NOT NULL
          AND realized_pnl_pct IS NOT NULL
    """).fetchall()
    pending = conn.execute("""
        SELECT COUNT(*) FROM ai_learning_events
        WHERE was_executed = 1
          AND recommendation IN ('BUY', 'TOP_UP')
          AND outcome_status IN ('win', 'loss', 'breakeven')
          AND realized_pnl_pct IS NOT NULL
          AND actual_entry_price IS NOT NULL
          AND suggested_stop IS NOT NULL AND suggested_target IS NOT NULL
          AND exec_mech_pnl_pct IS NULL
    """).fetchone()[0]

    n = len(rows)
    if n == 0:
        return {"n": 0, "pending": pending}

    actual = [r["realized_pnl_pct"] for r in rows]
    mech   = [r["exec_mech_pnl_pct"] for r in rows]
    exits: dict = {}
    for r in rows:
        exits[r["exec_mech_exit"]] = exits.get(r["exec_mech_exit"], 0) + 1
    avg_a = sum(actual) / n
    avg_m = sum(mech) / n
    return {
        "n":              n,
        "pending":        pending,
        "avg_actual_pct": round(avg_a, 2),
        "avg_mech_pct":   round(avg_m, 2),
        "alpha_pp":       round(avg_a - avg_m, 2),
        "n_beat":         sum(1 for a, m in zip(actual, mech) if a > m),
        "n_lag":          sum(1 for a, m in zip(actual, mech) if a < m),
        "mech_exits":     exits,
    }


@bp.route("/api/learning/execution-alpha")
def execution_alpha():
    """Execution alpha: actual realized P&L vs the simulated mechanical exit for
    executed BUY/TOP_UP trades. Positive alpha = manual exit decisions beat the
    rules. Resolves up to 5 unresolved events per call (lazy, bounded)."""
    with get_db() as conn:
        _resolve_execution_alpha(conn)
        result = _compute_execution_alpha(conn)
    return jsonify({**result, "ok": True})


# ── stop_too_tight counterfactual validation (Sprint 71 Phase 2D) ─────────────
# Regime → stop ATR multiple, mirroring regime-engine.js getRegimeModifiers().
# A "wider stop" counterfactual uses the regime's stopAtrMult so we test the stop
# the engine would *actually* place today, not an arbitrary multiple.
_REGIME_STOP_ATR_MULT = {
    "riskOn":   2.5, "trend":   2.5, "sideways": 2.5,
    "highVol":  3.0, "riskOff": 3.5, "panic":    4.0,
}
_STOP_CF_DEFAULT_MULT = 2.5  # fallback when regime unknown


def _wider_stop_would_have_saved(hist, entry: float, target: float,
                                  atr_pct: float, stop_mult: float,
                                  slip: float = 0.0):
    """Pure counterfactual: on the given OHLC frame, would a WIDER stop
    (entry − stop_mult×atr_pct%×entry) have let the trade reach `target` before
    being stopped out?

    Returns True (target first), False (wider stop still hit first), or None when
    inputs are unusable (so the row can be excluded from the precision stat).

    Stop-first intrabar convention (gotcha #42): if one bar straddles both the
    wider stop and the target, the stop is assumed to fill first. A win must clear
    the target by the slippage margin; the stop fills at the raw level.
    """
    if hist is None or len(hist) == 0 or not entry or entry <= 0:
        return None
    if atr_pct is None or atr_pct <= 0 or not target or target <= 0:
        return None
    wider_stop = entry * (1 - (stop_mult * atr_pct) / 100.0)
    if wider_stop <= 0 or wider_stop >= entry:
        return None
    try:
        for _, bar in hist.iterrows():
            low  = float(bar["Low"])
            high = float(bar["High"])
            if low <= wider_stop:
                return False          # wider stop hit first (stop-first convention)
            if high >= target * (1 + slip):
                return True           # reached target before the wider stop
    except Exception:
        return None
    return None  # neither level hit within the available window — inconclusive


def _resolve_stop_tag_counterfactual(conn, cap: int = 5) -> int:
    """Lazily evaluate the wider-stop counterfactual for stop_too_tight-tagged
    trades that have not yet been scored. Writes stop_cf_saved (1/0) to the event.

    Idempotent (skips rows where stop_cf_saved IS NOT NULL), capped per call to
    bound yfinance round-trips. Inconclusive rows (neither level hit, or unusable
    inputs) are left NULL for a future attempt.
    """
    try:
        rows = conn.execute("""
            SELECT id, ticker, actual_entry_price, suggested_target, timestamp,
                   regime, entry_signals_json, holding_period_days
            FROM ai_learning_events
            WHERE was_executed = 1
              AND recommendation IN ('BUY', 'TOP_UP')
              AND error_type IS NOT NULL AND error_type != ''
              AND (',' || error_type || ',') LIKE '%,stop_too_tight,%'
              AND stop_cf_saved IS NULL
              AND actual_entry_price IS NOT NULL
              AND suggested_target IS NOT NULL
              AND timestamp IS NOT NULL
              AND (fetch_failed_at IS NULL OR fetch_failed_at < ?)
            ORDER BY timestamp DESC LIMIT ?
        """, ((datetime.now() - timedelta(days=_FETCH_RETRY_DAYS)).isoformat(), cap)).fetchall()
    except Exception:
        return 0
    if not rows:
        return 0

    try:
        import yfinance as yf
    except ImportError:
        return 0

    resolved = 0
    for row in rows:
        try:
            entry  = float(row["actual_entry_price"])
            target = float(row["suggested_target"])
        except (TypeError, ValueError):
            continue
        atr_pct = _sig_get(row["entry_signals_json"], "atr_pct")
        if atr_pct is None:
            continue
        stop_mult = _REGIME_STOP_ATR_MULT.get(row["regime"] or "", _STOP_CF_DEFAULT_MULT)
        start_str = (row["timestamp"] or "")[:10]
        if not start_str:
            continue
        try:
            hold = int(row["holding_period_days"]) if row["holding_period_days"] is not None else 30
        except (TypeError, ValueError):
            hold = 30
        # Give the wider stop a longer window than the real (tight-stopped) hold —
        # the whole point is whether more room would have let it recover to target.
        window = max(30, hold + 15)
        try:
            start_dt = datetime.strptime(start_str, "%Y-%m-%d")
            end_str  = (start_dt + timedelta(days=window + 5)).strftime("%Y-%m-%d")
        except ValueError:
            end_str = None
        ticker = row["ticker"] or ""
        yf_sym = ticker if ticker.endswith(".AX") else ticker + ".AX"
        try:
            if end_str:
                hist = yf.Ticker(yf_sym).history(start=start_str, end=end_str, interval="1d")
            else:
                hist = yf.Ticker(yf_sym).history(start=start_str, interval="1d")
        except Exception:
            _mark_fetch_failed(conn, row["id"])
            continue
        if hist is None or hist.empty:
            _mark_fetch_failed(conn, row["id"])
            continue
        saved = _wider_stop_would_have_saved(hist, entry, target, atr_pct, stop_mult)
        if saved is None:
            continue  # inconclusive — leave NULL, retry later
        conn.execute(
            "UPDATE ai_learning_events SET stop_cf_saved=? WHERE id=?",
            (1 if saved else 0, row["id"]))
        resolved += 1
    return resolved


def _compute_stop_tag_precision(conn) -> dict:
    """Aggregate the stop_too_tight tag-precision stat from resolved counterfactuals.

    precision = (# stop_too_tight trades a WIDER stop would have saved) / (# resolved).
    A low precision means the tag is firing on trades that would have lost anyway
    even with a wider stop — i.e. the stop wasn't really "too tight", the entry/thesis
    was just wrong. _calib_compute() self-suppresses the widen-stops nudge in that case.
    """
    try:
        rows = conn.execute("""
            SELECT stop_cf_saved FROM ai_learning_events
            WHERE was_executed = 1
              AND error_type IS NOT NULL AND error_type != ''
              AND (',' || error_type || ',') LIKE '%,stop_too_tight,%'
              AND stop_cf_saved IS NOT NULL
        """).fetchall()
    except Exception:
        return {"n": 0, "n_saved": 0, "precision": None}
    n = len(rows)
    n_saved = sum(1 for r in rows if r["stop_cf_saved"] == 1)
    return {
        "n":         n,
        "n_saved":   n_saved,
        "precision": round(n_saved / n, 3) if n else None,
    }


@bp.route("/api/learning/stop-tag-precision")
def stop_tag_precision():
    """stop_too_tight tag-precision: % of stop_too_tight-tagged trades that a wider
    (regime stopAtrMult × ATR) stop would have rescued to target. Resolves up to 5
    unresolved counterfactuals per call (lazy, bounded)."""
    with get_db() as conn:
        _resolve_stop_tag_counterfactual(conn)
        result = _compute_stop_tag_precision(conn)
    return jsonify({**result, "ok": True})


# ── Trading Lessons endpoints ─────────────────────────────────────────────────

@bp.route("/api/learning/lessons", methods=["GET"])
def lessons_list():
    """Fetch lessons, optionally filtered by ticker/sector/regime/breadth.

    Query params: ticker, sector, regime, adl (float), asx_vol (float), limit (default 20).
    Breadth-scoped lessons are only returned when the current market conditions match.
    Used by analysis.js to inject contextual lessons into Claude's prompt.
    """
    ticker  = request.args.get("ticker", "")
    sector  = request.args.get("sector", "")
    regime  = request.args.get("regime", "")
    limit   = min(int(request.args.get("limit", 20)), 100)
    adl_raw = request.args.get("adl", "")
    vol_raw = request.args.get("asx_vol", "")

    try:
        adl = float(adl_raw) if adl_raw else None
    except ValueError:
        adl = None
    try:
        asx_vol = float(vol_raw) if vol_raw else None
    except ValueError:
        asx_vol = None

    clauses, vals = [], []
    if ticker:
        clauses.append("(ticker=? OR ticker IS NULL)")
        vals.append(ticker)
    if sector:
        sector_list = [s.strip() for s in sector.split(",") if s.strip()]
        if len(sector_list) == 1:
            clauses.append("(sector=? OR sector IS NULL)")
            vals.append(sector_list[0])
        elif len(sector_list) > 1:
            placeholders = ",".join(["?" for _ in sector_list])
            clauses.append(f"(sector IN ({placeholders}) OR sector IS NULL)")
            vals.extend(sector_list)
    if regime:
        clauses.append("(regime=? OR regime IS NULL)")
        vals.append(regime)

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    try:
        with get_db() as conn:
            rows = conn.execute(
                f"""SELECT id, learning_event_id, ticker, sector, regime,
                           setup_type, lesson_text, source, created_at,
                           breadth_scope
                    FROM trading_lessons {where}
                    ORDER BY created_at DESC LIMIT ?""",
                vals + [limit],
            ).fetchall()
        lessons = []
        for r in rows:
            d = dict(r)
            scope = d.get("breadth_scope")
            if scope is None:
                lessons.append(d)
                continue
            # Breadth-scoped: only inject when current market conditions match
            month = datetime.now().month   # §9.5: calendar scopes are server-derived
            if scope == "adl_below_0.3" and adl is not None and adl < 0.3:
                lessons.append(d)
            elif scope == "adl_above_0.7" and adl is not None and adl > 0.7:
                lessons.append(d)
            elif scope == "high_vol" and asx_vol is not None and asx_vol > 25:
                lessons.append(d)
            elif scope == "low_vol" and asx_vol is not None and asx_vol < 12:
                lessons.append(d)
            elif scope == "earnings_season" and month in (2, 8):     # Feb/Aug reporting
                lessons.append(d)
            elif scope == "cgt_window" and month in (5, 6):          # May–Jun EOFY
                lessons.append(d)
        return jsonify({"ok": True, "lessons": lessons})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/lessons", methods=["POST"])
def lessons_create():
    """Create a new trading lesson.

    Body: { lesson_text, ticker?, sector?, regime?, setup_type?,
             learning_event_id?, source?, breadth_scope? }
    breadth_scope: adl_below_0.3 | adl_above_0.7 | high_vol | low_vol
                 | earnings_season | cgt_window | null   (§9.5: calendar scopes)
    """
    data = request.get_json() or {}
    lesson_text   = (data.get("lesson_text") or "").strip()
    breadth_scope = data.get("breadth_scope") or None
    if breadth_scope and breadth_scope not in (
            "adl_below_0.3", "adl_above_0.7", "high_vol", "low_vol",
            "earnings_season", "cgt_window"):
        return jsonify({"ok": False, "error": f"Invalid breadth_scope: {breadth_scope}"}), 400
    if not lesson_text:
        return jsonify({"ok": False, "error": "lesson_text required"}), 400
    try:
        with get_db() as conn:
            conn.execute(
                """INSERT INTO trading_lessons
                       (learning_event_id, ticker, sector, regime, setup_type,
                        lesson_text, source, breadth_scope)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (
                    data.get("learning_event_id"),
                    data.get("ticker"),
                    data.get("sector"),
                    data.get("regime"),
                    data.get("setup_type"),
                    lesson_text,
                    data.get("source", "manual"),
                    breadth_scope,
                )
            )
            row_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
        return jsonify({"ok": True, "id": row_id})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/lesson/<int:lesson_id>", methods=["DELETE"])
def lessons_delete(lesson_id):
    """Hard-delete a single lesson."""
    try:
        with get_db() as conn:
            rows = conn.execute(
                "DELETE FROM trading_lessons WHERE id=?", (lesson_id,)
            ).rowcount
        if rows == 0:
            return jsonify({"ok": False, "error": "Lesson not found"}), 404
        return jsonify({"ok": True, "deleted": lesson_id})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Lesson lifecycle scoring (Learning Loop improvement B) ───────────────────
# Lessons are injected forever once created, never retrospectively validated —
# a lesson from months ago, in a regime that's since shifted, could be net-
# negative now and nobody would know. This is a read-only health check: it
# never changes which lessons match/inject (see lessons_list() above), it only
# surfaces whether each lesson's win rate actually improved since creation so
# the user can prune low/negative-impact lessons manually.

def _compute_lesson_effectiveness(conn, min_n_after: int = 5) -> list[dict]:
    """For each lesson, reuse the same ticker/sector/regime OR-NULL scope-
    matching pattern as GET /api/learning/lessons against closed
    ai_learning_events, split into before/after buckets by the lesson's own
    created_at. Requires n>=min_n_after in the 'after' bucket before reporting
    a verdict (below that: insufficient_data=True — not enough trades since
    creation to judge yet).

    Returns a list sorted worst-first (most negative delta_pp), with
    insufficient-data lessons sorted last regardless of delta.
    """
    lessons = conn.execute("""
        SELECT id, ticker, sector, regime, lesson_text, created_at
        FROM trading_lessons
    """).fetchall()

    results = []
    for lesson in lessons:
        clauses, vals = ["outcome_status IN ('win','loss')"], []
        # Exact-match on scope fields (no OR-NULL fallback) — we want events
        # that fall within this lesson's declared scope, not events with no
        # scope data at all (those would dilute the before/after comparison,
        # especially for sector where backfill is lazy and many rows are null).
        if lesson["ticker"]:
            clauses.append("ticker=?")
            vals.append(lesson["ticker"])
        if lesson["sector"]:
            clauses.append("sector=?")
            vals.append(lesson["sector"])
        if lesson["regime"]:
            clauses.append("regime=?")
            vals.append(lesson["regime"])
        where = " AND ".join(clauses)

        before_row = conn.execute(f"""
            SELECT COUNT(*) AS n,
                   SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) AS wins
              FROM ai_learning_events
             WHERE {where} AND timestamp < ?
        """, vals + [lesson["created_at"]]).fetchone()
        after_row = conn.execute(f"""
            SELECT COUNT(*) AS n,
                   SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) AS wins
              FROM ai_learning_events
             WHERE {where} AND timestamp >= ?
        """, vals + [lesson["created_at"]]).fetchone()

        n_before = before_row["n"] or 0
        n_after  = after_row["n"] or 0
        wr_before = round(before_row["wins"] / n_before * 100, 1) if n_before else None
        wr_after  = round(after_row["wins"] / n_after * 100, 1) if n_after else None
        insufficient = n_after < min_n_after
        delta_pp = round(wr_after - wr_before, 1) if (wr_after is not None and wr_before is not None) else None

        results.append({
            "lesson_id":          lesson["id"],
            "lesson_text":        lesson["lesson_text"],
            "ticker":             lesson["ticker"],
            "sector":             lesson["sector"],
            "regime":             lesson["regime"],
            "created_at":         lesson["created_at"],
            "n_before":           n_before,
            "n_after":            n_after,
            "win_rate_before":    wr_before,
            "win_rate_after":     wr_after,
            "delta_pp":           delta_pp,
            "insufficient_data":  insufficient,
        })

    results.sort(key=lambda r: (r["insufficient_data"], r["delta_pp"] if r["delta_pp"] is not None else 0))
    return results


@bp.route("/api/learning/lesson-effectiveness", methods=["GET"])
def lesson_effectiveness():
    """Retrospective lesson health: win rate before vs after each lesson was
    created, scoped to the lesson's own ticker/sector/regime. Sorted worst-
    performing first. Read-only — surfaces health only, the user prunes
    lessons manually via the existing DELETE endpoint."""
    try:
        with get_db() as conn:
            results = _compute_lesson_effectiveness(conn)
        return jsonify({"ok": True, "lessons": results})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Sell tag outcome tracking (Gap 3 + Gap 7) ────────────────────────────────

@bp.route("/api/learning/sell-outcomes", methods=["GET"])
def sell_outcomes():
    """Return executed SELL/TRIM events with their driver + 30d verification.

    Query params:
      limit (default 30, max 100) — number of events to return.
      action (all|SELL|TRIM, default all) — filter by exit action type.
      force (0|1) — if 1, immediately run the lazy resolvers (sell-verify,
        deterministic tags, exit-quality tags, MAE/MFE) before querying, so a
        manual "Check Now" click reflects the freshest data instead of waiting
        for the next incidental _calib_compute() call.
    """
    limit = min(int(request.args.get("limit", 30)), 100)
    action = (request.args.get("action") or "all").upper()
    force = request.args.get("force", "0") == "1"
    try:
        with get_db() as conn:
            if force:
                _resolve_sell_outcomes(conn)
                _resolve_exit_quality_tags(conn, cap=10)
                _resolve_deterministic_tags(conn, cap=10)
                _resolve_mae_mfe(conn, cap=10)
            sql = """
                SELECT id, ticker, recommendation, sell_primary_driver, sell_secondary_factors,
                       sell_urgency, alternative_ticker,
                       actual_entry_price, actual_exit_price, realized_pnl_pct, outcome_status,
                       sell_verify_date, sell_verify_verdict,
                       sell_verify_sold_chg, sell_verify_alt_chg,
                       holding_period_days, regime, regime_at_execution, sector,
                       skill_score, exit_quality_tag, mae_pct, mfe_pct,
                       thesis_verdict, error_type, bull_case, bear_case,
                       timestamp
                FROM ai_learning_events
                WHERE was_executed = 1
                  AND sell_primary_driver IS NOT NULL
            """
            params = []
            if action in ("SELL", "TRIM"):
                sql += " AND recommendation = ?"
                params.append(action)
            # Master date window (Learning page). When a window is active it bounds
            # the set, so relax the count cap and let the window do the limiting.
            dclause, dparam = _days_window_sql()
            if dclause:
                sql += dclause
                params.append(dparam)
                limit = max(limit, 500)
            sql += " ORDER BY timestamp DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
        return jsonify({"ok": True, "events": [dict(r) for r in rows]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# Stable rule-code enum — kept in sync with _classifyRuleWarnings() (js/analysis.js)
# and the scrutinize prompt (routes/debate.py). Human labels for the Learning card.
_RULE_CODE_LABELS = {
    "quant_declined":    "Quant engine declined to size",
    "neg_ev":            "Negative expected value",
    "confidence_floor":  "Below confidence floor",
    "whipsaw":           "Whipsaw / self-contradiction",
    "self_contradiction":"Reasoning contradicts action",
    "heat_budget":       "Heat budget constraint",
    "validator_fail":    "Validator rule failure",
    "fallback_sized":    "Fallback min-trade sizing",
    "tier2_rec":         "Rec on Tier-2 (compressed) ticker",
    "factor_thin":       "Fewer than 3 non-technical factors",
}


@bp.route("/api/learning/rule-override-efficacy", methods=["GET"])
def rule_override_efficacy():
    """Did overriding a failed quant rule pay off?

    For every executed, closed rec that carried a deterministic rule warning
    (rule_warnings_json), cross-tab its outcome by rule `code` against the
    whole-book baseline win-rate. The verdict answers the user's question — was
    the rule right, too strict, or has the market moved?

      too_strict  — breached-and-taken trades won SIGNIFICANTLY MORE than baseline
                    (Wilson 95% CI entirely above the baseline WR). The rule is
                    over-cautious in the current environment; consider relaxing it.
      validated   — breached-and-taken trades won SIGNIFICANTLY LESS than baseline
                    (CI entirely below). The rule correctly flags losers — keep it.
      inconclusive — CI spans baseline / n below the floor. Not enough signal yet.

    Also reports how many breached recs were SKIPPED (deterrent value) alongside
    how many were executed. Gated by the same _MIN_NUDGE_N raw-count floor and
    Wilson-CI significance test used elsewhere so a 3-of-5 fluke stays quiet.

    Query params: min_n (default _MIN_NUDGE_N) — raw executed-count floor for a
    non-inconclusive verdict.
    """
    try:
        min_n = int(request.args.get("min_n", 12))
    except (TypeError, ValueError):
        min_n = 12

    try:
        with get_db() as conn:
            # Baseline: all executed, closed recs (rule-agnostic).
            base_rows = conn.execute("""
                SELECT outcome_status, realized_pnl_aud
                FROM ai_learning_events
                WHERE was_executed = 1
                  AND outcome_status IN ('win','loss','breakeven')
            """).fetchall()

            # All recs that carried a rule warning (executed or not). Pull the
            # per-trade fields the drill-down needs (ticker/action/entry price for
            # live tracking of still-open entries).
            flagged_rows = conn.execute("""
                SELECT id, ticker, recommendation, was_executed, outcome_status,
                       realized_pnl_aud, realized_pnl_pct, actual_entry_price,
                       timestamp, rule_warnings_json
                FROM ai_learning_events
                WHERE rule_warnings_json IS NOT NULL
                  AND rule_warnings_json != ''
                  AND rule_warnings_json != '[]'
            """).fetchall()

        base_n = len(base_rows)
        base_wins = sum(1 for r in base_rows if (r["outcome_status"] or "") == "win")
        base_wr = (base_wins / base_n) if base_n else None
        base_pnls = [r["realized_pnl_aud"] for r in base_rows if r["realized_pnl_aud"] is not None]
        base_avg_pnl = round(sum(base_pnls) / len(base_pnls), 2) if base_pnls else None

        _CLOSED = ("win", "loss", "breakeven")

        # Aggregate per rule code. A rec can carry >1 code; it counts once per code.
        agg: dict[str, dict] = {}
        for row in flagged_rows:
            try:
                warns = json.loads(row["rule_warnings_json"] or "[]")
            except Exception:
                continue
            if not isinstance(warns, list):
                continue
            codes = {w.get("code") for w in warns if isinstance(w, dict) and w.get("code")}
            status = (row["outcome_status"] or "")
            # Trade state: a still-open BUY/TOP_UP contributes NO P&L (realized P&L
            # is only meaningful once the parcel is sold — user requirement). Only
            # closed disposals feed win-rate + avg P&L; open entries are surfaced
            # separately with live mark-to-market computed client-side.
            if row["was_executed"] and status in _CLOSED:
                state = "closed"
            elif row["was_executed"]:
                state = "open"
            else:
                state = "skipped"
            for code in codes:
                a = agg.setdefault(code, {
                    "closed_n": 0, "closed_wins": 0, "closed_losses": 0,
                    "open_n": 0, "skipped_n": 0, "pnls": [], "events": [],
                })
                if state == "closed":
                    a["closed_n"] += 1
                    if status == "win":
                        a["closed_wins"] += 1
                    elif status == "loss":
                        a["closed_losses"] += 1
                    if row["realized_pnl_aud"] is not None:
                        a["pnls"].append(row["realized_pnl_aud"])
                elif state == "open":
                    a["open_n"] += 1
                else:
                    a["skipped_n"] += 1
                a["events"].append({
                    "id":              row["id"],
                    "ticker":          row["ticker"],
                    "action":          row["recommendation"],
                    "state":           state,
                    "realized_pnl_aud": row["realized_pnl_aud"] if state == "closed" else None,
                    "realized_pnl_pct": row["realized_pnl_pct"] if state == "closed" else None,
                    "entry_price":     row["actual_entry_price"],
                    "timestamp":       row["timestamp"],
                })

        rules = []
        _state_order = {"closed": 0, "open": 1, "skipped": 2}
        for code, a in agg.items():
            n = a["closed_n"]                    # win-rate/verdict use CLOSED only
            wins = a["closed_wins"]
            wr = (wins / n) if n else None
            avg_pnl = round(sum(a["pnls"]) / len(a["pnls"]), 2) if a["pnls"] else None
            wilson = _wilson_ci(wins, n) if n else None
            verdict = "inconclusive"
            if base_wr is not None and n >= min_n:
                if _ci_excludes(wins, n, base_wr):
                    # CI entirely on one side of baseline → significant.
                    verdict = "too_strict" if (wr or 0) > base_wr else "validated"
            events = sorted(
                a["events"],
                key=lambda e: (_state_order.get(e["state"], 3), e["timestamp"] or ""),
            )[:30]
            rules.append({
                "code":            code,
                "label":           _RULE_CODE_LABELS.get(code, code),
                "closed_n":        n,
                "closed_wins":     wins,
                "closed_losses":   a["closed_losses"],
                "open_n":          a["open_n"],
                "skipped_n":       a["skipped_n"],
                "win_rate":        round(wr * 100, 1) if wr is not None else None,
                "avg_pnl_aud":     avg_pnl,
                "wilson_ci":       wilson,
                "verdict":         verdict,
                "events":          events,
            })

        # Most-actionable first: too_strict, then validated, then by total activity.
        _order = {"too_strict": 0, "validated": 1, "inconclusive": 2}
        rules.sort(key=lambda r: (_order.get(r["verdict"], 3),
                                  -(r["closed_n"] + r["open_n"] + r["skipped_n"])))

        return jsonify({
            "ok": True,
            "baseline": {
                "n": base_n,
                "win_rate": round(base_wr * 100, 1) if base_wr is not None else None,
                "avg_pnl_aud": base_avg_pnl,
            },
            "min_n": min_n,
            "rules": rules,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/buy-outcomes", methods=["GET"])
def buy_outcomes():
    """Return executed BUY/TOP_UP events with entry-driver + outcome detail.

    Per-trade complement to /api/learning/sell-outcomes for the entry side.
    Existing BUY/TOP_UP analytics (thesis-matrix, factor-win-rates) are
    aggregate cross-tabs only — this is the first per-trade view of entry
    decisions, mirroring the sell tracker's shape so both can share a
    frontend rendering pattern.

    Query params:
      limit (default 30, max 100) — number of events to return.
      action (all|BUY|TOP_UP, default all) — filter by entry action type.
      force (0|1) — if 1, immediately run the lazy resolvers before querying.
    """
    limit = min(int(request.args.get("limit", 30)), 100)
    action = (request.args.get("action") or "all").upper()
    force = request.args.get("force", "0") == "1"
    try:
        with get_db() as conn:
            if force:
                _resolve_deterministic_tags(conn, cap=10)
                _resolve_mae_mfe(conn, cap=10)
                _resolve_exit_quality_tags(conn, cap=10)
            sql = """
                SELECT id, ticker, recommendation, primary_entry_driver, thesis_verdict,
                       actual_entry_price, actual_exit_price, realized_pnl_pct, outcome_status,
                       holding_period_days, regime, regime_at_execution, sector,
                       skill_score, exit_quality_tag, mae_pct, mfe_pct,
                       error_type, bull_case, bear_case,
                       timestamp
                FROM ai_learning_events
                WHERE was_executed = 1
                  AND recommendation IN ('BUY','TOP_UP')
                  AND outcome_status IS NOT NULL
            """
            params = []
            if action in ("BUY", "TOP_UP"):
                sql += " AND recommendation = ?"
                params.append(action)
            # Master date window (Learning page) — see sell_outcomes.
            dclause, dparam = _days_window_sql()
            if dclause:
                sql += dclause
                params.append(dparam)
                limit = max(limit, 500)
            sql += " ORDER BY timestamp DESC LIMIT ?"
            params.append(limit)
            rows = conn.execute(sql, params).fetchall()
        return jsonify({"ok": True, "events": [dict(r) for r in rows]})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


# ── Gap 6: Ollama tag spot-check ─────────────────────────────────────────────

@bp.route("/api/learning/tag-reviews", methods=["GET"])
def tag_reviews_queue():
    """Return up to 5 randomly-chosen auto-tagged loss/breakeven events not yet reviewed.

    These are served as the weekly spot-check queue on the Learning page. The user
    reviews each one (agree / disagree + corrected tag) to build an agreement-rate
    signal that gates the top_err calibration nudge in _calib_compute().

    Query params:
        limit (int, default 5, max 20): number of events to return.
    """
    limit = min(int(request.args.get("limit", 5)), 20)
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT e.id, e.ticker, e.error_type, e.error_type_source,
                       e.outcome_status, e.realized_pnl_pct, e.ai_confidence,
                       e.rationale_summary, e.timestamp, e.regime, e.recommendation
                FROM ai_learning_events e
                WHERE e.error_type_source = 'auto'
                  AND e.outcome_status IN ('loss', 'breakeven')
                  AND e.error_type IS NOT NULL AND e.error_type != ''
                  AND e.id NOT IN (SELECT event_id FROM tag_reviews)
                ORDER BY RANDOM()
                LIMIT ?
            """, (limit,)).fetchall()
            total_pending = conn.execute("""
                SELECT COUNT(*) FROM ai_learning_events
                WHERE error_type_source = 'auto'
                  AND outcome_status IN ('loss', 'breakeven')
                  AND id NOT IN (SELECT event_id FROM tag_reviews)
            """).fetchone()[0]
        return jsonify({"ok": True, "events": [dict(r) for r in rows],
                        "count": len(rows), "total_pending": total_pending})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/tag-review", methods=["POST"])
def submit_tag_review():
    """Submit a manual review verdict for one auto-tagged event.

    Body (JSON):
        event_id      int    — ID of the ai_learning_events row
        verdict       str    — 'agree' | 'disagree'
        corrected_tag str?   — required when verdict='disagree'; replaces error_type

    On 'disagree', updates the event's error_type and marks error_type_source='manual'
    so the corrected tag is included in future calibration without restriction.
    On 'agree', records the review without changing the event.
    """
    data      = request.get_json(force=True)
    event_id  = data.get("event_id")
    verdict   = data.get("verdict")
    corrected = data.get("corrected_tag", "").strip()

    if not event_id or verdict not in ("agree", "disagree"):
        return jsonify({"ok": False, "error": "event_id and verdict ('agree'|'disagree') required"}), 400
    if verdict == "disagree" and not corrected:
        return jsonify({"ok": False, "error": "corrected_tag required when verdict is 'disagree'"}), 400

    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT id, error_type FROM ai_learning_events WHERE id=? AND error_type_source='auto'",
                (event_id,)
            ).fetchone()
            if not row:
                return jsonify({"ok": False, "error": "Event not found or not auto-tagged"}), 404

            existing = conn.execute(
                "SELECT id FROM tag_reviews WHERE event_id=?", (event_id,)
            ).fetchone()
            if existing:
                conn.execute("""
                    UPDATE tag_reviews
                    SET verdict=?, corrected_tag=?, reviewed_at=datetime('now','localtime')
                    WHERE event_id=?
                """, (verdict, corrected if verdict == "disagree" else None, event_id))
            else:
                conn.execute("""
                    INSERT INTO tag_reviews (event_id, verdict, corrected_tag, original_tag)
                    VALUES (?, ?, ?, ?)
                """, (event_id, verdict,
                      corrected if verdict == "disagree" else None,
                      row["error_type"]))

            if verdict == "disagree":
                conn.execute("""
                    UPDATE ai_learning_events
                    SET error_type = ?, error_type_source = 'manual'
                    WHERE id = ?
                """, (corrected, event_id))

        # Invalidate calibration cache so the next request picks up the corrected tag.
        with _calib_lock:
            _calib_cache.clear()

        return jsonify({"ok": True, "event_id": event_id, "verdict": verdict})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/tag-accuracy", methods=["GET"])
def tag_accuracy():
    """Return Ollama auto-tag agreement rate computed from tag_reviews.

    Surfaced on the Learning page Debate Engine card as a small accuracy line.
    Also consumed by _calib_compute() to gate the top_err calibration nudge:
        ≥75%  → reliable    (green)
        60–75%→ acceptable  (amber)
        <60%  → unreliable  (red) — top_err nudge suppressed
    """
    try:
        with get_db() as conn:
            row = conn.execute("""
                SELECT COUNT(*) as n,
                       SUM(CASE WHEN verdict='agree' THEN 1 ELSE 0 END) as n_agree
                FROM tag_reviews
            """).fetchone()
            n       = row["n"]       or 0
            n_agree = row["n_agree"] or 0
            rate    = round(n_agree / n, 3) if n > 0 else None

            pending = conn.execute("""
                SELECT COUNT(*) FROM ai_learning_events
                WHERE error_type_source = 'auto'
                  AND outcome_status IN ('loss', 'breakeven')
                  AND id NOT IN (SELECT event_id FROM tag_reviews)
            """).fetchone()[0]

        if rate is None:
            label = "unreviewed"
        elif rate >= 0.75:
            label = "good"
        elif rate >= 0.60:
            label = "acceptable"
        else:
            label = "unreliable"

        return jsonify({
            "ok": True, "n": n, "n_agree": n_agree,
            "agree_rate": rate, "label": label, "pending_review": pending,
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
