"""
routes/scanner.py — Background market scanner.

Endpoints:
  /api/market/scan         POST — start background scan (409 if running)
  /api/market/scan/status  GET  — poll progress + results
  /api/market/scan/stop    POST — cancel running scan
"""

import threading
from datetime import datetime

import numpy as np
import yfinance as yf
from flask import Blueprint, jsonify, request

from core import ASX_UNIVERSE as _ASX_UNIVERSE, SECTOR_MAP as _SECTOR_MAP
from indicators import _score_ticker


bp = Blueprint("scanner", __name__)


# Background scan state — module-level so the worker thread and status route share it.
_scan_state: dict = {
    "running": False, "stopped": False, "stage": "idle",
    "progress": 0, "total": 0, "results": [], "error": None,
    "scanned_at": None, "universe": None,
    "universe_size": 0, "filtered_count": 0,
}
_scan_lock = threading.Lock()


def _run_market_scan(universe: str, exclude: list, min_adv_aud: float, max_results: int) -> None:
    global _scan_state
    tickers = _ASX_UNIVERSE.get(universe, _ASX_UNIVERSE["asx200"])
    asx_tickers = [f"{t}.AX" for t in tickers]

    with _scan_lock:
        _scan_state.update({
            "running": True, "stopped": False, "stage": "downloading",
            "progress": 0, "total": len(tickers), "results": [],
            "error": None, "universe": universe, "universe_size": len(tickers),
            "filtered_count": 0,
        })

    try:
        dl_tickers = asx_tickers + ["^AXJO"]
        raw = yf.download(
            dl_tickers, period="90d", auto_adjust=True,
            progress=False, group_by="column",
        )
        if raw.empty:
            with _scan_lock:
                _scan_state.update({"running": False, "error": "No data from yfinance", "stage": "error"})
            return

        closes_df = raw["Close"]  if "Close"  in raw.columns.get_level_values(0) else None
        volume_df = raw["Volume"] if "Volume" in raw.columns.get_level_values(0) else None

        axjo_closes = None
        try:
            if closes_df is not None and "^AXJO" in closes_df.columns:
                axjo_closes = closes_df["^AXJO"].dropna().values
        except Exception:
            pass

        if closes_df is None:
            with _scan_lock:
                _scan_state.update({"running": False, "error": "Unexpected data format", "stage": "error"})
            return

        with _scan_lock:
            _scan_state["stage"] = "scoring"

        results = []
        exclude_set = set(t.upper() for t in exclude)

        for i, (ticker, asx_t) in enumerate(zip(tickers, asx_tickers)):
            if _scan_state["stopped"]:
                break
            with _scan_lock:
                _scan_state["progress"] = i + 1

            if ticker in exclude_set:
                continue

            col = asx_t if asx_t in closes_df.columns else None
            if col is None:
                continue

            closes = closes_df[col].dropna().values
            volumes = volume_df[col].dropna().values if (volume_df is not None and col in volume_df.columns) else np.ones(len(closes))

            if len(closes) < 45:
                continue

            avg_price = float(np.mean(closes[-20:]))
            avg_vol   = float(np.mean(volumes[-20:])) if len(volumes) >= 20 else 0
            adv_aud   = avg_price * avg_vol
            if adv_aud < min_adv_aud:
                continue

            scored = _score_ticker(closes, volumes, index_closes=axjo_closes)
            if scored is None:
                continue

            scored["ticker"]  = ticker
            scored["sector"]  = _SECTOR_MAP.get(ticker, "Other")
            scored["adv_aud"] = round(adv_aud / 1_000_000, 2)
            results.append(scored)

        results.sort(key=lambda x: x["score"], reverse=True)

        # Sector aggregates from ALL liquidity-passing tickers (not just top-N)
        sector_agg: dict = {}
        for r in results:
            sec = r["sector"]
            if sec not in sector_agg:
                sector_agg[sec] = {
                    "scores": [], "ret_5d": [], "ret_20d": [],
                    "top_ticker": "", "top_score": -1,
                }
            d = sector_agg[sec]
            d["scores"].append(r["score"])
            d["ret_5d"].append(r["ret_5d"])
            d["ret_20d"].append(r["ret_20d"])
            if r["score"] > d["top_score"]:
                d["top_ticker"] = r["ticker"]
                d["top_score"]  = r["score"]

        sector_stats = sorted([
            {
                "sector":      sec,
                "count":       len(d["scores"]),
                "avg_score":   round(sum(d["scores"])  / len(d["scores"]),  1),
                "avg_ret_5d":  round(sum(d["ret_5d"])  / len(d["ret_5d"]),  2),
                "avg_ret_20d": round(sum(d["ret_20d"]) / len(d["ret_20d"]), 2),
                "top_ticker":  d["top_ticker"],
            }
            for sec, d in sector_agg.items()
        ], key=lambda x: x["avg_score"], reverse=True)

        sector_counts: dict[str, int] = {}
        diversified = []
        for r in results:
            sec = r["sector"]
            if sector_counts.get(sec, 0) < 4:
                diversified.append(r)
                sector_counts[sec] = sector_counts.get(sec, 0) + 1
            if len(diversified) >= max_results:
                break

        with _scan_lock:
            _scan_state.update({
                "running":        False,
                "stage":          "complete",
                "results":        diversified,
                "all_results":    results,
                "sector_stats":   sector_stats,
                "filtered_count": len(results),
                "scanned_at":     datetime.now().strftime("%H:%M"),
            })

    except Exception as exc:
        with _scan_lock:
            _scan_state.update({"running": False, "error": str(exc), "stage": "error"})


@bp.route("/api/market/scan", methods=["POST"])
def market_scan_start():
    """Start a background market scan. Returns 409 if already running."""
    if _scan_state["running"]:
        return jsonify({"error": "Scan already running"}), 409

    data        = request.get_json() or {}
    universe    = data.get("universe", "asx200")
    exclude     = data.get("exclude", [])
    min_adv_aud = float(data.get("min_adv_aud", 2_000_000))
    max_results = int(data.get("max_results", 25))

    if universe not in _ASX_UNIVERSE:
        return jsonify({"error": f"Unknown universe: {universe}"}), 400

    t = threading.Thread(
        target=_run_market_scan,
        args=(universe, exclude, min_adv_aud, max_results),
        daemon=True,
    )
    t.start()
    return jsonify({"ok": True, "message": f"Scan started — {len(_ASX_UNIVERSE[universe])} tickers in {universe}"})


@bp.route("/api/market/scan/status")
def market_scan_status():
    with _scan_lock:
        return jsonify(dict(_scan_state))


@bp.route("/api/market/scan/stop", methods=["POST"])
def market_scan_stop():
    with _scan_lock:
        _scan_state["stopped"] = True
    return jsonify({"ok": True})
