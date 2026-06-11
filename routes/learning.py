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

from flask import Blueprint, jsonify, request

from db import get_db

# Columns that /api/learning/outcome is allowed to update (§0.E SQL whitelist)
_ALLOWED_OUTCOME_COLS = (
    "outcome_status", "realized_pnl_pct", "realized_pnl_aud",
    "holding_period_days", "exit_reason", "error_type", "notes",
    "actual_entry_price", "actual_exit_price", "sector",
    "skill_score", "debate_summary", "prompt_hash",
    "tags", "trade_thesis", "rr_ratio",
    "success_tags", "checklist_bypasses",
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
    """
    et = (r.get("error_type") or "")
    er = (r.get("exit_reason") or "")
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
            conn.execute("""
                INSERT INTO ai_learning_events
                    (event_type, ticker, regime, prompt_version, agent_type,
                     ai_confidence, ensemble_confidence, recommendation, rationale_summary,
                     suggested_stop, suggested_target, rr_ratio, was_executed, market_context, notes,
                     outcome_status, realized_pnl_aud, realized_pnl_pct, holding_period_days, exit_reason,
                     actual_entry_price, actual_exit_price, sector,
                     skill_score, debate_summary, prompt_hash, error_type_source,
                     entry_signals_json, debate_synthesis_winner,
                     tags, trade_thesis,
                     sell_primary_driver, sell_secondary_factors, sell_urgency,
                     alternative_ticker)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
                data.get("debate_synthesis_winner"),
                data.get("tags"),
                data.get("trade_thesis"),
                data.get("sell_primary_driver"),
                data.get("sell_secondary_factors"),
                data.get("sell_urgency"),
                data.get("alternative_ticker"),
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
                       virtual_outcome, virtual_speed_weight
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
            success_patterns = {
                "by_success_type": dict(sorted(success_counts.items(), key=lambda x: -x[1])),
            }

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


@bp.route("/api/learning/digest-data")
def learning_digest_data():
    """Structured data for the postmortem digest AI prompt.

    Returns recent closed losses + breakevens, failure pattern counts,
    and regime win-rate breakdown so the frontend can build a Claude prompt.
    """
    try:
        with get_db() as conn:
            failures = conn.execute("""
                SELECT ticker, regime, ai_confidence, recommendation,
                       outcome_status, realized_pnl_pct, exit_reason,
                       error_type, trade_thesis, timestamp, debate_summary, tags
                FROM ai_learning_events
                WHERE outcome_status IN ('loss', 'breakeven')
                  AND was_executed = 1
                ORDER BY timestamp DESC
                LIMIT 20
            """).fetchall()

            regime_rows = conn.execute("""
                SELECT regime,
                       SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) as wins,
                       COUNT(*) as total
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven') AND was_executed=1
                GROUP BY regime
            """).fetchall()

            overall = conn.execute("""
                SELECT SUM(CASE WHEN outcome_status='win' THEN 1 ELSE 0 END) as wins,
                       COUNT(*) as total
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven') AND was_executed=1
            """).fetchone()

            error_dist = conn.execute("""
                SELECT error_type, COUNT(*) as n
                FROM ai_learning_events
                WHERE outcome_status IN ('loss','breakeven') AND was_executed=1
                  AND error_type IS NOT NULL AND error_type != ''
                GROUP BY error_type
                ORDER BY n DESC
            """).fetchall()

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

        return jsonify({
            "recent_failures": [dict(r) for r in failures],
            "regime_stats": regime_stats,
            "overall_wins": overall["wins"] if overall else 0,
            "overall_total": overall["total"] if overall else 0,
            "error_dist": [dict(r) for r in error_dist],
            "exit_dist": [dict(r) for r in exit_dist],
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@bp.route("/api/learning/calibration-stats")
def learning_calibration_stats():
    """Brier score + reliability-diagram bins.

    Brier score = mean((confidence - outcome)^2); outcome=1 for win, 0 otherwise.
    Lower is better (perfect model = 0, random = 0.25).
    """
    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT ai_confidence, outcome_status
                FROM ai_learning_events
                WHERE outcome_status IN ('win','loss','breakeven')
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
            ORDER BY timestamp DESC LIMIT 5
        """, (cutoff,)).fetchall()
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
    try:
        rows = conn.execute("""
            SELECT id, ticker, recommendation, suggested_stop, suggested_target, timestamp
            FROM ai_learning_events
            WHERE was_executed = 0
              AND suggested_stop IS NOT NULL AND suggested_target IS NOT NULL
              AND virtual_outcome IS NULL
              AND outcome_status IN ('open', 'skipped')
              AND timestamp < ?
            ORDER BY timestamp DESC LIMIT 10
        """, (cutoff,)).fetchall()
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
            continue

        outcome = "virtual_open"
        # Track the bar index (1-indexed) at which target or stop was first hit.
        # This is used as `hold_days` for speed_weight — rewards fast resolutions.
        bars_to_resolution = 0
        for i, (_, bar) in enumerate(hist.iterrows(), 1):
            if is_exit:
                # SELL/TRIM: falling price = thesis confirmed (target below entry)
                if bar["Low"]  <= target: outcome = "virtual_win";  bars_to_resolution = i; break
                if bar["High"] >= stop:   outcome = "virtual_loss"; bars_to_resolution = i; break
            else:
                # BUY: rising price = thesis confirmed (target above entry)
                if bar["High"] >= target: outcome = "virtual_win";  bars_to_resolution = i; break
                if bar["Low"]  <= stop:   outcome = "virtual_loss"; bars_to_resolution = i; break

        # virtual_open: neither level was hit — use full bar count as hold_days
        # (the position drifted for the entire available history without resolution)
        if not bars_to_resolution:
            bars_to_resolution = max(1, len(hist))

        # speed_weight = min(1.0, 7 / bars_to_resolution):
        #   resolved in ≤7 bars → 1.0 (fast, high-conviction signal)
        #   resolved in 30 bars → ~0.23 (slow drift, weaker signal)
        speed_weight = round(min(1.0, 7.0 / bars_to_resolution), 3)
        conn.execute(
            "UPDATE ai_learning_events SET virtual_outcome=?, virtual_speed_weight=? WHERE id=?",
            (outcome, speed_weight, row["id"]))
        resolved += 1

    return resolved


def _calib_compute(regime: str, sectors_str: str, tickers_str: str, days: int,
                   flipped_at: str = "", flipped_to: str = "") -> dict:
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
            flip_dt  = datetime.fromisoformat(flipped_at.replace("Z", "+00:00").replace("+00:00", ""))
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
            # Sprint 37: lazy-resolve sell tag outcomes (Gap 3 + Gap 7) — capped at 5.
            _resolve_sell_outcomes(conn)

            rows = conn.execute("""
                SELECT ai_confidence, outcome_status, regime, sector, ticker,
                       realized_pnl_pct, rr_ratio, timestamp,
                       error_type, error_type_source, exit_reason, skill_score, success_tags
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

        _ESS_MIN = 2.5  # Kish ESS threshold — suppresses calibration when decay renders
                        # sample statistically unreliable (e.g. 1 fresh + 3 very stale trades)

        # 1. Confidence bands — decay-weighted ESS≥2.5 AND |delta|>5pp
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
            if abs(delta) > 0.05:
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

        # 3. Relevant sectors — ESS≥2.5 AND notable rate
        for sector in sectors:
            s_rows = [r for r in rows_all if r["sector"] == sector]
            if not s_rows:
                continue
            if _ess(s_rows) < _ESS_MIN:
                continue
            wr = _wwr(s_rows)
            if wr < 0.45:
                parts.append(f"{sector}:{wr*100:.0f}%(n={len(s_rows)}) ⚠underperform")
            elif wr > 0.72:
                parts.append(f"{sector}:{wr*100:.0f}%(n={len(s_rows)}) ✓strong")

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
        if len(learnable_losses) >= 3:
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
                             "thesis_broken": "TB"}.get(top_et, top_et)
                    parts.append(
                        f"top_err:{short}({top_cnt}/{len(learnable_losses)}losses)→"
                        + ("reduce conf" if top_et == "overconfident" else
                           "check news" if top_et == "missed_catalyst" else
                           "check regime fit" if top_et == "regime_mismatch" else
                           "refine entry timing" if top_et == "poor_entry" else
                           "widen stops" if top_et == "stop_too_tight" else
                           "require min R:R 2.5" if top_et == "poor_rr" else
                           "add re-validation step")
                    )
        # Gap 6: auto-tags unreliable and not enough manually-reviewed events — warn Claude.
        if not _auto_tags_ok and len(learnable_losses) < 3:
            parts.append(f"⚠AUTO_TAGS_UNRELIABLE({int(_auto_tag_agree*100)}%agree,n={_auto_tag_n})→err nudge suppressed")

        # 6b. Dominant success tag — mirror of L2 dominant error check
        # Only emit when ESS of wins is high enough to trust the pattern.
        wins_tagged = [r for r in rows_all if r["outcome_status"] == "win"
                       and r.get("success_tags") and r["success_tags"] not in ("", "none")]
        if len(wins_tagged) >= 3:
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

        # 7. Per-ticker memory — ESS≥2.5 AND |delta from overall WR| > 15pp
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

        # 8. Sector × current regime interaction — most actionable for ASX sector rotation.
        # Only fires when current regime is known (passed in), ESS≥2.5, and win-rate
        # differs from the overall by >12pp. Capped at 2 entries to stay within budget.
        if regime and len(calib_rows) >= 10:
            overall_wr = _wwr(calib_rows) if "overall_wr" not in dir() else overall_wr
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
                    direction = "✓" if delta > 0 else "⚠"
                    sx_parts.append(
                        f"{sector}:{sx_wr*100:.0f}%(Δ{delta*100:+.0f}pp,ESS={sx_ess:.1f}){direction}"
                    )
            if sx_parts:
                # Sort by |delta| descending; keep top 2
                sx_parts.sort(key=lambda x: abs(float(x.split("Δ")[1].split("pp")[0])), reverse=True)
                parts.append(f"sector×{regime}:" + ",".join(sx_parts[:2]))

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

        # Sprint 44: insert regime-flip warning at the front (high priority — survives truncation)
        if _regime_flip_token:
            parts.insert(0, _regime_flip_token)

        # Sprint 45: thesis drift nudge — lowest priority (appended last, first to drop).
        if _thesis_drift.get("nudge"):
            parts.append(_thesis_drift["nudge"])

        if not parts:
            return {"available": False, "block": None}

        # ── Gap 8: token budget — priority-ordered truncation ─────────────────
        # Parts are appended in priority order (conf bands first, per-ticker last).
        # Drop from the end (lowest priority) until under the operating budget.
        # Hard ceiling applied as a safety net after truncation.
        _CALIB_CHAR_BUDGET  = 400   # ~100 tokens target
        _CALIB_CHAR_CEILING = 600   # ~150 tokens hard ceiling
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
        return {"available": True, "block": block, "sample": n, "adjustments": adjustments}
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
    """
    regime      = request.args.get("regime", "")
    sectors_str = request.args.get("sectors", "")
    tickers_str = request.args.get("tickers", "")
    days        = min(int(request.args.get("days", 90)), 180)
    flipped_at  = request.args.get("flipped_at", "")
    flipped_to  = request.args.get("flipped_to", "")

    # L4: serve from cache if fresh (Fix #8: lock protects dict access only)
    # flipped_at/flipped_to are not part of the cache key — they are short-lived
    # and the TTL (5 min) is shorter than the minimum meaningful penalty window.
    cache_key = (regime, sectors_str, tickers_str, days)
    with _calib_lock:
        cached = _calib_cache.get(cache_key)
        if cached and (time.time() - cached[1]) < _CALIB_TTL:
            return jsonify(cached[0])

    # Expensive computation runs outside the lock to avoid blocking other threads
    result = _calib_compute(regime, sectors_str, tickers_str, days, flipped_at, flipped_to)

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
            if scope == "adl_below_0.3" and adl is not None and adl < 0.3:
                lessons.append(d)
            elif scope == "adl_above_0.7" and adl is not None and adl > 0.7:
                lessons.append(d)
            elif scope == "high_vol" and asx_vol is not None and asx_vol > 25:
                lessons.append(d)
            elif scope == "low_vol" and asx_vol is not None and asx_vol < 12:
                lessons.append(d)
        return jsonify({"ok": True, "lessons": lessons})
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@bp.route("/api/learning/lessons", methods=["POST"])
def lessons_create():
    """Create a new trading lesson.

    Body: { lesson_text, ticker?, sector?, regime?, setup_type?,
             learning_event_id?, source?, breadth_scope? }
    breadth_scope: adl_below_0.3 | adl_above_0.7 | high_vol | low_vol | null
    """
    data = request.get_json() or {}
    lesson_text   = (data.get("lesson_text") or "").strip()
    breadth_scope = data.get("breadth_scope") or None
    if breadth_scope and breadth_scope not in (
            "adl_below_0.3", "adl_above_0.7", "high_vol", "low_vol"):
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


# ── Sell tag outcome tracking (Gap 3 + Gap 7) ────────────────────────────────

@bp.route("/api/learning/sell-outcomes", methods=["GET"])
def sell_outcomes():
    """Return executed SELL/TRIM events with their driver + 30d verification.

    Query params:
      limit (default 30, max 100) — number of events to return.
      force (0|1) — if 1, immediately run _resolve_sell_outcomes before querying.
    """
    limit = min(int(request.args.get("limit", 30)), 100)
    force = request.args.get("force", "0") == "1"
    try:
        with get_db() as conn:
            if force:
                _resolve_sell_outcomes(conn)
            rows = conn.execute("""
                SELECT id, ticker, sell_primary_driver, sell_secondary_factors,
                       sell_urgency, alternative_ticker,
                       actual_exit_price, realized_pnl_pct, outcome_status,
                       sell_verify_date, sell_verify_verdict,
                       sell_verify_sold_chg, sell_verify_alt_chg,
                       timestamp
                FROM ai_learning_events
                WHERE was_executed = 1
                  AND sell_primary_driver IS NOT NULL
                ORDER BY timestamp DESC LIMIT ?
            """, (limit,)).fetchall()
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
