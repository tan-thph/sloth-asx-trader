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
import time
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

from db import get_db

# ── Calibration TTL cache (L4) ────────────────────────────────────────────────
# Keyed by (regime, sectors_str, tickers_str, days); evicted after 5 minutes.
_calib_cache: dict = {}
_CALIB_TTL = 300


bp = Blueprint("learning", __name__)


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
                     entry_signals_json, debate_synthesis_winner)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
            for col in ("outcome_status", "realized_pnl_pct", "realized_pnl_aud",
                        "holding_period_days", "exit_reason", "error_type", "notes",
                        "actual_entry_price", "actual_exit_price", "sector",
                        "skill_score", "debate_summary", "prompt_hash"):
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

            # Confidence bands
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
                conf_bands.append({
                    "band":     f"{int(lo*100)}-{int(hi*100)}%",
                    "wins":     band_wins,
                    "total":    band_total,
                    "win_rate": round(band_wins / band_total * 100, 1) if band_total else None,
                })

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
            regime_list = [
                {"regime": k, "wins": v['wins'], "total": v['total'],
                 "win_rate": round(v['wins'] / v['total'] * 100, 1) if v['total'] else None}
                for k, v in sorted(regime_agg.items())
            ]

            # Prompt version stats
            pv_rows = conn.execute("""
                SELECT pv.version, pv.total_calls,
                       COALESCE(SUM(CASE WHEN e.outcome_status='win' THEN 1 ELSE 0 END), 0) as wins,
                       COALESCE(SUM(CASE WHEN e.outcome_status IN ('win','loss','breakeven') THEN 1 ELSE 0 END), 0) as closed
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
                       postmortem_debate
                FROM ai_learning_events ORDER BY timestamp DESC LIMIT 30
            """).fetchall()

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
                    if tag:
                        type_counts[tag] = type_counts.get(tag, 0) + 1
            failure_patterns = {
                "by_exit_reason": {r["exit_reason"]: r["cnt"] for r in fail_exit},
                "by_error_type":  dict(sorted(type_counts.items(), key=lambda x: -x[1])),
            }

            # Failed tickers
            failed = conn.execute(
                "SELECT ticker, error, context, timestamp FROM failed_tickers ORDER BY id DESC LIMIT 20"
            ).fetchall()

        return jsonify({
            "total":              total,
            "closed":             closed,
            "wins":               wins,
            "overall_win_rate":   round(wins / closed * 100, 1) if closed else None,
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
            "debate_insights":    debate_insights,
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


def _calib_compute(regime: str, sectors_str: str, tickers_str: str, days: int) -> dict:
    """
    Pure calibration computation. Returns a plain dict.
    Separated from the route so results can be TTL-cached (L4).
    """
    sectors     = [s for s in sectors_str.split(",") if s]
    tickers_req = [t for t in tickers_str.split(",") if t]
    cutoff      = (datetime.now() - timedelta(days=days)).isoformat()
    cutoff_30   = (datetime.now() - timedelta(days=30)).isoformat()

    def _decay(ts, half_life=45):
        try:
            d = (datetime.now() - datetime.fromisoformat(ts)).days
            return math.exp(-math.log(2) * d / half_life)
        except Exception:
            return 1.0

    def _wwr(subset):
        w_wins  = sum(_decay(r["timestamp"]) for r in subset if r["outcome_status"] == "win")
        w_total = sum(_decay(r["timestamp"]) for r in subset)
        return w_wins / w_total if w_total > 0 else 0.0

    def _is_shock(r):
        et = r["error_type"] or ""
        er = r["exit_reason"] or ""
        return "external_shock" in et.split(",") or er == "protective_stop"

    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT ai_confidence, outcome_status, regime, sector, ticker,
                       realized_pnl_pct, rr_ratio, timestamp,
                       error_type, exit_reason
                FROM ai_learning_events
                WHERE timestamp >= ? AND outcome_status IN ('win','loss','breakeven')
                ORDER BY timestamp DESC LIMIT 300
            """, (cutoff,)).fetchall()

        if len(rows) < 5:
            return {"available": False, "block": None}

        n = len(rows)
        parts = []

        calib_rows = [r for r in rows if not _is_shock(r)]
        n_excluded = n - len(calib_rows)

        # 1. Confidence bands — decay-weighted; n≥3 AND |delta|>5pp
        for label, lo, hi, mid in [("60-70", 0.60, 0.70, 0.65), ("70-80", 0.70, 0.80, 0.75),
                                    ("80-90", 0.80, 0.90, 0.85)]:
            subset = [r for r in calib_rows if lo <= (r["ai_confidence"] or 0) < hi]
            if len(subset) < 3:
                continue
            wr    = _wwr(subset)
            delta = wr - mid
            if abs(delta) > 0.05:
                adj_val = round(max(-0.15, min(0.10, delta * 0.8)), 2)
                parts.append(f"conf {label}%:{wr*100:.0f}%WR(Δ{delta*100:+.0f}pp,adj{adj_val:+.2f},n={len(subset)})")

        # 2. Current regime — L1: only warn when 1-2 trades (skip if 0 — no data to warn about)
        if regime:
            reg = [r for r in rows if r["regime"] == regime]
            if 0 < len(reg) < 3:
                parts.append(f"⚠only {len(reg)} trade{'s' if len(reg)!=1 else ''} in {regime} regime—calibration limited")
            elif len(reg) >= 3:
                wr   = _wwr(reg)
                warn = " ⚠AVOID" if wr < 0.40 else (" ⚠CAUTION" if wr < 0.50 else "")
                parts.append(f"{regime}:{wr*100:.0f}%W(n={len(reg)}){warn}")

        # 3. Relevant sectors — decay-weighted; n≥3 AND notable rate
        for sector in sectors:
            s_rows = [r for r in rows if r["sector"] == sector]
            if len(s_rows) < 3:
                continue
            wr = _wwr(s_rows)
            if wr < 0.45:
                parts.append(f"{sector}:{wr*100:.0f}%(n={len(s_rows)}) ⚠underperform")
            elif wr > 0.72:
                parts.append(f"{sector}:{wr*100:.0f}%(n={len(s_rows)}) ✓strong")

        # 4. Strategy decay — recent 30d vs full window; only if clearly decaying (Δ<-15pp, n≥5)
        recent_rows = [r for r in rows if r["timestamp"] >= cutoff_30]
        if len(recent_rows) >= 5 and n >= 10:
            all_wr = _wwr(rows)
            rec_wr = _wwr(recent_rows)
            if (rec_wr - all_wr) < -0.15:
                parts.append(f"⚠decay:{rec_wr*100:.0f}%recent/{all_wr*100:.0f}%all(Δ{(rec_wr-all_wr)*100:+.0f}pp)→reduce posn 30%")

        # 5. R:R accuracy — n≥5 high-R:R with clear underperformance
        hi_rr = [r for r in rows if (r["rr_ratio"] or 0) >= 2.0]
        if len(hi_rr) >= 5:
            hi_wr = _wwr(hi_rr)
            if hi_wr < 0.50:
                parts.append(f"RR≥2.0:{hi_wr*100:.0f}%WR(n={len(hi_rr)})⚠stops/targets off→widen stops")

        # 6. Dominant learnable error in non-shock losses — L2: threshold lowered to 33%, n≥3
        learnable_losses = [r for r in rows if r["outcome_status"] == "loss"
                            and "external_shock" not in (r["error_type"] or "").split(",")]
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

        # 7. Per-ticker memory — n≥3 AND |delta from overall WR| > 15pp
        if tickers_req and len(calib_rows) >= 5:
            overall_wr = _wwr(calib_rows)
            ticker_parts = []
            for tk in tickers_req[:5]:
                tk_rows = [r for r in calib_rows if r["ticker"] == tk]
                if len(tk_rows) < 3:
                    continue
                tk_wr = _wwr(tk_rows)
                delta = tk_wr - overall_wr
                if abs(delta) > 0.15:
                    direction = "✓strong" if delta > 0 else "⚠weak"
                    ticker_parts.append(
                        f"{tk}:{tk_wr*100:.0f}%(Δ{delta*100:+.0f}pp,n={len(tk_rows)}){direction}"
                    )
            if ticker_parts:
                parts.append("per-ticker:" + ",".join(ticker_parts))

        if not parts:
            return {"available": False, "block": None}

        date_from  = cutoff[:7]
        date_to    = datetime.now().strftime("%Y-%m")
        regime_tag = f",{regime}" if regime else ""
        excl_note  = f",{n_excluded}excl" if n_excluded > 0 else ""
        block = (
            f"CALIBRATION({n}cls,{date_from}→{date_to}{regime_tag}{excl_note}): "
            + "; ".join(parts) + "."
        )
        return {"available": True, "block": block, "sample": n}
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
    """
    regime      = request.args.get("regime", "")
    sectors_str = request.args.get("sectors", "")
    tickers_str = request.args.get("tickers", "")
    days        = min(int(request.args.get("days", 90)), 180)

    # L4: serve from cache if fresh
    cache_key = (regime, sectors_str, tickers_str, days)
    cached = _calib_cache.get(cache_key)
    if cached and (time.time() - cached[1]) < _CALIB_TTL:
        return jsonify(cached[0])

    result = _calib_compute(regime, sectors_str, tickers_str, days)
    if "error" not in result:
        _calib_cache[cache_key] = (result, time.time())
        # Prune if cache grows unexpectedly (many different param combos)
        if len(_calib_cache) > 50:
            oldest = sorted(_calib_cache.items(), key=lambda x: x[1][1])[:25]
            for k, _ in oldest:
                _calib_cache.pop(k, None)

    if "error" in result:
        return jsonify(result), 500
    return jsonify(result)
