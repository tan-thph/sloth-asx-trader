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

        # Market breadth: fraction of scored tickers trading above their 20-day SMA
        above_sma20 = sum(1 for r in results if r["current_price"] > r["sma20"])
        breadth_ratio = round(above_sma20 / len(results), 3) if results else None

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
                "breadth_ratio":  breadth_ratio,  # fraction of universe above 20d SMA (0–1)
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


# ── Factor stability (§1.6 overfitting guard) ─────────────────────────────────

# Factor definitions: name → lambda(closes_array, volumes_array) → float signal value.
# Each signal is cross-sectionally evaluated against 20-bar forward return.
_FACTORS = {
    "above_sma20":   lambda c, v: 1.0 if c[-1] > float(np.mean(c[-20:])) else 0.0,
    "above_sma50":   lambda c, v: 1.0 if len(c) >= 50 and c[-1] > float(np.mean(c[-50:])) else 0.0,
    "sma20_rising":  lambda c, v: 1.0 if len(c) >= 25 and float(np.mean(c[-20:])) > float(np.mean(c[-25:-5])) else 0.0,
    "rsi_zone":      lambda c, v: _rsi_factor_val(c),
    "pullback_pct":  lambda c, v: _pullback_factor_val(c),
    "vol_surge":     lambda c, v: _vol_factor_val(v),
    "momentum_5d":   lambda c, v: float((c[-1] / c[-6] - 1) * 100) if len(c) > 6 else 0.0,
    "momentum_20d":  lambda c, v: float((c[-1] / c[-21] - 1) * 100) if len(c) > 21 else 0.0,
}

# Score-component weights (must match _score_ticker bucketing; used to compute
# current-weight IC contribution and flag any single overweight factor)
_FACTOR_WEIGHTS = {
    "above_sma20": 10, "above_sma50": 10, "sma20_rising": 10,
    "rsi_zone": 15, "pullback_pct": 15,
    "vol_surge": 20, "momentum_5d": 10, "momentum_20d": 0,
}


def _simple_rsi_arr(closes, period=14):
    deltas = np.diff(closes[-period*3:])
    gains  = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)
    avg_g = float(np.mean(gains[-period:]))
    avg_l = float(np.mean(losses[-period:]))
    rs = avg_g / avg_l if avg_l > 0 else 100.0
    return 100 - 100 / (1 + rs)


def _rsi_factor_val(c):
    if len(c) < 30:
        return 0.5
    rsi = _simple_rsi_arr(c)
    # Normalise: score 1.0 for ideal zone (35-55), down to 0.0 for extremes
    if 35 <= rsi <= 55:   return 1.0
    if 30 <= rsi < 35:    return 0.8
    if 55 < rsi <= 65:    return 0.7
    if rsi < 30:          return 0.3
    return 0.2


def _pullback_factor_val(c):
    if len(c) < 10:
        return 0.5
    cp       = float(c[-1])
    high_90  = float(np.max(c))
    pct_high = (cp / high_90 - 1) * 100
    if -20 <= pct_high <= -5:  return 1.0   # ideal pullback window
    if  -5 < pct_high <=  0:  return 0.6
    if -30 <= pct_high < -20: return 0.7
    return 0.2


def _vol_factor_val(v):
    if len(v) < 20:
        return 0.5
    avg20 = float(np.mean(v[-20:])) or 1.0
    ratio = float(np.mean(v[-5:])) / avg20
    if ratio > 1.5:  return 1.0
    if ratio > 1.1:  return 0.75
    if ratio > 0.8:  return 0.5
    return 0.25


def _compute_factor_ic(closes_list, volumes_list, forward_bars=20):
    """
    Compute the Information Coefficient (rank correlation) between each factor
    signal and the realized forward_bars-period return, across all tickers
    supplied for one time window.

    Returns dict: factor_name → IC float in [-1, 1].
    """
    import statistics as _stats

    factor_signals  = {f: [] for f in _FACTORS}
    forward_returns = []

    for closes, volumes in zip(closes_list, volumes_list):
        closes  = np.array(closes, dtype=float)
        volumes = np.array(volumes, dtype=float)

        n = len(closes)
        if n < 50 + forward_bars:
            continue

        # Evaluate factors on the slice ending at bar (n - forward_bars)
        c_eval = closes[:n - forward_bars]
        v_eval = volumes[:n - forward_bars]

        fwd_ret = float(closes[-1] / closes[n - forward_bars] - 1)
        forward_returns.append(fwd_ret)

        for fname, fn in _FACTORS.items():
            try:
                factor_signals[fname].append(fn(c_eval, v_eval))
            except Exception:
                factor_signals[fname].append(float("nan"))

    if len(forward_returns) < 5:
        return {f: None for f in _FACTORS}

    def _rank_corr(xs, ys):
        """Spearman rank correlation (no scipy needed)."""
        paired = [(x, y) for x, y in zip(xs, ys) if x == x and y == y]  # drop nan
        if len(paired) < 4:
            return None
        xs2, ys2 = zip(*paired)

        def _ranks(seq):
            s = sorted(range(len(seq)), key=lambda i: seq[i])
            r = [0.0] * len(seq)
            for rank, idx in enumerate(s):
                r[idx] = rank + 1
            return r

        rx, ry = _ranks(xs2), _ranks(ys2)
        n = len(rx)
        mean_x = sum(rx) / n
        mean_y = sum(ry) / n
        num  = sum((rx[i] - mean_x) * (ry[i] - mean_y) for i in range(n))
        den  = (sum((x - mean_x)**2 for x in rx) * sum((y - mean_y)**2 for y in ry)) ** 0.5
        return round(num / den, 4) if den > 0 else 0.0

    return {
        fname: _rank_corr(factor_signals[fname], forward_returns)
        for fname in _FACTORS
    }


@bp.route("/api/scanner/factor-stability", methods=["POST"])
def factor_stability():
    """
    K-fold cross-validation of _score_ticker factor ICs.

    Body: { "tickers": ["CBA","BHP",...], "period": "2y", "n_folds": 5,
             "forward_bars": 20 }
    Returns per-factor: train_ic, test_ic, stability_ratio, verdict.
    """
    data        = request.get_json() or {}
    tickers     = data.get("tickers") or []
    period      = data.get("period", "2y")
    n_folds     = int(data.get("n_folds", 5))
    fwd_bars    = int(data.get("forward_bars", 20))

    if not tickers:
        return jsonify({"error": "tickers required"}), 400
    if n_folds < 2 or n_folds > 10:
        return jsonify({"error": "n_folds must be 2-10"}), 400
    tickers = [t.upper().replace(".AX", "") for t in tickers[:20]]

    # Fetch OHLCV for each ticker
    all_closes  = []
    all_volumes = []
    fetched     = []

    for ticker in tickers:
        sym = ticker + ".AX"
        try:
            hist = yf.Ticker(sym).history(period=period, auto_adjust=True)
            if hist.empty or len(hist) < 80:
                continue
            all_closes.append(list(hist["Close"].values))
            all_volumes.append(list(hist["Volume"].values))
            fetched.append(ticker)
        except Exception:
            continue

    if not fetched:
        return jsonify({"error": "No usable data fetched for supplied tickers"}), 422

    # Align all series to the shortest length (they should be the same period)
    min_len = min(len(c) for c in all_closes)
    all_closes  = [c[:min_len] for c in all_closes]
    all_volumes = [v[:min_len] for v in all_volumes]

    fold_size = min_len // n_folds
    min_train = max(60, fold_size)  # need enough bars for indicators + forward return

    # Accumulate per-fold ICs
    train_ics = {f: [] for f in _FACTORS}
    test_ics  = {f: [] for f in _FACTORS}

    for fold in range(n_folds):
        test_start = fold * fold_size
        test_end   = test_start + fold_size if fold < n_folds - 1 else min_len
        test_len   = test_end - test_start

        if test_len < fwd_bars + 30:
            continue

        # All bars NOT in this fold = train
        train_closes  = [c[:test_start] + c[test_end:] for c in all_closes]
        train_volumes = [v[:test_start] + v[test_end:] for v in all_volumes]

        # Keep only tickers with enough training data
        usable = [(c, v) for c, v in zip(train_closes, train_volumes)
                  if len(c) >= min_train + fwd_bars]

        test_closes  = [c[test_start:test_end] for c in all_closes]
        test_volumes = [v[test_start:test_end] for v in all_volumes]
        usable_test  = [(c, v) for c, v in zip(test_closes, test_volumes)
                        if len(c) >= 50 + fwd_bars]

        if not usable or not usable_test:
            continue

        ic_train = _compute_factor_ic([c for c, _ in usable],  [v for _, v in usable],  fwd_bars)
        ic_test  = _compute_factor_ic([c for c, _ in usable_test], [v for _, v in usable_test], fwd_bars)

        for f in _FACTORS:
            if ic_train.get(f) is not None:
                train_ics[f].append(ic_train[f])
            if ic_test.get(f) is not None:
                test_ics[f].append(ic_test[f])

    # Summarise
    def _mean(lst):
        lst2 = [x for x in lst if x is not None]
        return round(sum(lst2) / len(lst2), 4) if lst2 else None

    factors_out = []
    for fname in _FACTORS:
        tr_ic  = _mean(train_ics[fname])
        te_ic  = _mean(test_ics[fname])
        weight = _FACTOR_WEIGHTS.get(fname, 0)

        # Stability: how well does OOS IC preserve the in-sample signal?
        # Values > 0.5 = stable, 0.2-0.5 = marginal, < 0.2 or sign-flip = overfitted
        if tr_ic is not None and te_ic is not None and abs(tr_ic) > 0.01:
            stability = round(te_ic / tr_ic, 3)
        else:
            stability = None

        if te_ic is None:
            verdict = "insufficient_data"
        elif abs(te_ic) < 0.03:
            verdict = "noise"
        elif stability is not None and stability < 0:
            verdict = "overfitted"   # sign flips OOS — opposite effect
        elif stability is not None and stability < 0.3:
            verdict = "weak"
        elif stability is not None and stability < 0.6:
            verdict = "marginal"
        else:
            verdict = "stable"

        factors_out.append({
            "factor":    fname,
            "weight":    weight,
            "train_ic":  tr_ic,
            "test_ic":   te_ic,
            "stability": stability,
            "verdict":   verdict,
        })

    # Sort by abs test IC descending
    factors_out.sort(key=lambda x: abs(x["test_ic"] or 0), reverse=True)

    # Overall score: weighted-average of absolute test ICs
    weighted_ic = sum(
        abs(f["test_ic"]) * f["weight"]
        for f in factors_out if f["test_ic"] is not None and f["weight"] > 0
    )
    total_weight = sum(f["weight"] for f in factors_out if f["test_ic"] is not None and f["weight"] > 0)
    overall_ic = round(weighted_ic / total_weight, 4) if total_weight > 0 else None

    stable_count   = sum(1 for f in factors_out if f["verdict"] == "stable")
    overfitted_count = sum(1 for f in factors_out if f["verdict"] == "overfitted")

    return jsonify({
        "ok":              True,
        "tickers_used":    fetched,
        "n_folds":         n_folds,
        "forward_bars":    fwd_bars,
        "factors":         factors_out,
        "overall_weighted_ic": overall_ic,
        "stable_count":    stable_count,
        "overfitted_count": overfitted_count,
        "summary": (
            "All factors stable" if overfitted_count == 0 and stable_count == len(factors_out)
            else f"{overfitted_count} factor(s) may be overfitted — consider reducing their weight"
            if overfitted_count > 0
            else f"{stable_count}/{len(factors_out)} factors stable OOS"
        ),
    })
