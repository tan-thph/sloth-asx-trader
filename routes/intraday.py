"""
routes/intraday.py — ASX100 intraday day-trade strategy endpoints.

Strategy: buy at a technically discounted intraday price (below VWAP, RSI oversold),
exit at a configurable +3–4% target same session. Entry window: 10:45–15:00 AEST.

Routes:
    GET  /api/intraday/<ticker>       Single-ticker 5m intraday analysis
    POST /api/intraday/scan           Batch scan: {"tickers": ["CBA", "BHP", ...]}
"""

import json
import math
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as _FutureTimeout
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import yfinance as yf
from flask import Blueprint, jsonify, request

from core import fetch_with_retry, log, ttl_cache
from db import get_db
from indicators import asx, safe_float

bp = Blueprint("intraday", __name__)


# ── VWAP helper ───────────────────────────────────────────────────────────────

def _compute_vwap(hist: pd.DataFrame) -> pd.Series:
    """Standard intraday VWAP (typical price × volume, cumulative).

    Caller is responsible for passing only today's bars so the VWAP
    resets correctly at market open.
    """
    tp = (hist["High"] + hist["Low"] + hist["Close"]) / 3
    vol = hist["Volume"].replace(0, np.nan)
    return (tp * hist["Volume"]).cumsum() / vol.cumsum()


# ── Intraday RSI helper ───────────────────────────────────────────────────────

def _compute_rsi_intraday(close: pd.Series, period: int = 14) -> float | None:
    """Wilder RSI on an intraday close series. Returns the last value as a float."""
    if len(close) < period + 1:
        return None
    delta = close.diff()
    gain  = delta.clip(lower=0)
    loss  = (-delta).clip(lower=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - 100 / (1 + rs)
    val = rsi.iloc[-1]
    return round(float(val), 1) if not math.isnan(val) else None


# ── Today's bar filter ────────────────────────────────────────────────────────

def _filter_today_bars(hist: pd.DataFrame) -> pd.DataFrame:
    """Return bars whose AEST date matches today.

    yfinance 5m data is timezone-aware (+10:00 or +11:00 for ASX).
    Extracting .date() from the index gives the local market date correctly
    for both AEST and AEDT without needing pytz.

    Falls back to the last 73 rows (one full ASX trading day of 5m bars)
    if filtering produces fewer than 3 bars.
    """
    today_aest = (datetime.utcnow() + timedelta(hours=10)).date()
    try:
        idx = pd.DatetimeIndex(hist.index)
        if idx.tz is not None:
            # tz-aware index — .date() gives the local date at each timestamp's tz
            dates = [ts.date() for ts in idx]
        else:
            # tz-naive — assume UTC, shift +10h for AEST
            dates = [(pd.Timestamp(ts) + pd.Timedelta(hours=10)).date() for ts in idx]
        mask = [d == today_aest for d in dates]
        result = hist.loc[mask]
        if len(result) >= 3:
            return result
    except Exception:
        pass
    return hist.tail(73)


# ── Entry window check ────────────────────────────────────────────────────────

def _in_entry_window() -> bool:
    """True between 10:45 and 15:00 AEST (minutes since midnight: 645–899)."""
    now_aest = datetime.utcnow() + timedelta(hours=10)
    mins = now_aest.hour * 60 + now_aest.minute
    return 645 <= mins < 900   # 10:45 = 645, 15:00 = 900


# ── Setup scoring ─────────────────────────────────────────────────────────────

def _score_setup(pct_from_vwap: float, intraday_rsi: float | None,
                 vol_rising: bool, current_price: float,
                 day_low: float, day_open: float) -> int:
    """Composite intraday setup score 0–100.

    Signal                Points    Condition
    ─────────────────── ────────── ─────────────────────────────────────────
    VWAP discount         0–30      ≥0.5% below VWAP, linear to max at −1.5%
    Intraday RSI oversold 0–25      RSI ≤ 40; 0 pts at 40, 25 pts at ≤ 10
    Volume accelerating  +20       Last 3 bars avg > 20-bar rolling avg
    Holding above day low +15      price ≥ day_low × 1.01 (support intact)
    Above opening price  +10       price > day_open (intraday recovery)
    """
    score = 0

    # VWAP discount (0–30 pts)
    if pct_from_vwap < -0.5:
        score += min(30, int(abs(pct_from_vwap) / 1.5 * 30))

    # Intraday RSI (0–25 pts)
    if intraday_rsi is not None and intraday_rsi <= 40:
        score += max(0, int((40 - intraday_rsi) / 30 * 25))

    # Volume acceleration (+20)
    if vol_rising:
        score += 20

    # Holding above day low (+15)
    if day_low > 0 and current_price >= day_low * 1.01:
        score += 15

    # Above opening price (+10)
    if day_open > 0 and current_price > day_open:
        score += 10

    return min(score, 100)


# ── Single-ticker intraday analysis ──────────────────────────────────────────

def _analyse_intraday(ticker: str, interval: str = "5m") -> dict:
    """Fetch intraday bars for `ticker` and compute setup quality metrics.

    Returns a dict with: current_price, vwap, pct_from_vwap, intraday_rsi,
    day_open/high/low, score (0–100), passes (bool), in_entry_window (bool),
    and raw bar count.
    """
    t = asx(ticker)
    try:
        stk  = yf.Ticker(t)
        hist = stk.history(period="2d", interval=interval, auto_adjust=True)
    except Exception as e:
        return {"error": f"yfinance error: {e}", "ticker": ticker.upper()}

    if hist.empty or len(hist) < 5:
        return {"error": "insufficient intraday data", "ticker": ticker.upper()}

    today_bars = _filter_today_bars(hist)
    if len(today_bars) < 3:
        return {"error": "market not open yet or no today bars", "ticker": ticker.upper()}

    # Use confirmed bars (all except the current forming bar) for indicators
    confirmed = today_bars.iloc[:-1] if len(today_bars) > 1 else today_bars

    current_price = float(today_bars["Close"].iloc[-1])
    day_open      = float(today_bars["Open"].iloc[0])
    day_high      = float(today_bars["High"].max())
    day_low       = float(today_bars["Low"].min())

    # VWAP — computed over all of today's bars (including forming bar)
    vwap_series  = _compute_vwap(today_bars)
    current_vwap = float(vwap_series.iloc[-1])
    if math.isnan(current_vwap) or current_vwap == 0:
        return {"error": "VWAP computation failed", "ticker": ticker.upper()}

    pct_from_vwap = (current_price - current_vwap) / current_vwap * 100
    pct_from_open = (current_price - day_open) / day_open * 100 if day_open > 0 else 0

    # RSI — computed on confirmed-bar closes
    intraday_rsi = _compute_rsi_intraday(confirmed["Close"], 14)

    # Volume acceleration: last 3 confirmed bars vs 20-bar rolling mean
    vol_rolling_mean = confirmed["Volume"].rolling(20).mean().iloc[-1]
    if len(confirmed) >= 3 and not math.isnan(vol_rolling_mean) and vol_rolling_mean > 0:
        last3_mean = confirmed["Volume"].tail(3).mean()
        vol_rising = bool(last3_mean > vol_rolling_mean)
    else:
        vol_rising = False

    score      = _score_setup(pct_from_vwap, intraday_rsi, vol_rising,
                              current_price, day_low, day_open)
    in_window  = _in_entry_window()

    passes = (
        in_window
        and pct_from_vwap <= -0.3
        and (intraday_rsi is None or intraday_rsi <= 40)
        and score >= 40
    )

    return {
        "ticker":          ticker.upper(),
        "current_price":   round(current_price, 3),
        "day_open":        round(day_open, 3),
        "day_high":        round(day_high, 3),
        "day_low":         round(day_low, 3),
        "vwap":            round(current_vwap, 3),
        "pct_from_vwap":  round(pct_from_vwap, 2),
        "pct_from_open":  round(pct_from_open, 2),
        "intraday_rsi":   intraday_rsi,
        "vol_rising":     vol_rising,
        "score":          score,
        "in_entry_window": in_window,
        "passes":         passes,
        "bars_today":     len(today_bars),
        "interval":       interval,
        "fetched_at":     datetime.now(timezone.utc).isoformat(),
    }


# ── Cached wrapper (2-min TTL — intraday data changes fast) ──────────────────

@ttl_cache(seconds=120)
def _intraday_cached(ticker: str) -> dict:
    """Cached single-ticker intraday analysis (2-min TTL)."""
    try:
        return fetch_with_retry(
            _analyse_intraday, ticker,
            cache_key=f"intraday:{ticker}",
            max_retries=2,
        )
    except Exception as e:
        log.warning("intraday: failed for %s: %s", ticker, e)
        return {"error": str(e), "ticker": ticker.upper()}


# ── Routes ────────────────────────────────────────────────────────────────────

@bp.route("/api/intraday/<ticker>")
def intraday_ticker(ticker):
    """Single-ticker intraday setup analysis.

    Query params:
        interval: yfinance interval string (default "5m")
    """
    result = _intraday_cached(ticker.upper())
    status = 200 if "error" not in result else 200   # always 200 — caller checks .error
    return jsonify(result), status


@bp.route("/api/intraday/scan", methods=["POST"])
def intraday_scan():
    """Batch intraday scan for multiple tickers.

    Body: {"tickers": ["CBA", "BHP", ...]}
    Returns: {TICKER: {score, passes, current_price, vwap, ...}, ...}

    Uses as_completed so one slow / delisted ticker doesn't block the whole scan.
    Per-ticker timeout: 8 s — delisted tickers that hang Yahoo Finance are skipped.
    """
    body    = request.get_json(silent=True) or {}
    tickers = [t.upper() for t in body.get("tickers", []) if t]
    if not tickers:
        return jsonify({}), 200

    # Filter out blob_store-excluded tickers
    try:
        with get_db() as conn:
            row = conn.execute("SELECT value FROM blob_store WHERE key='universe_excluded'").fetchone()
            if row:
                excluded = set(json.loads(row["value"]))
                tickers = [t for t in tickers if t not in excluded]
    except Exception:
        pass

    if not tickers:
        return jsonify({}), 200

    _PER_TICKER_TIMEOUT = 8   # seconds; delisted/slow tickers skipped after this

    results: dict = {}
    n_workers = min(len(tickers), 15)

    with ThreadPoolExecutor(max_workers=n_workers) as pool:
        future_to_ticker = {pool.submit(_intraday_cached, t): t for t in tickers}
        for future in as_completed(future_to_ticker, timeout=120):
            t = future_to_ticker[future]
            try:
                results[t] = future.result(timeout=_PER_TICKER_TIMEOUT)
            except _FutureTimeout:
                log.warning("intraday: per-ticker timeout (%ds) for %s — skipping", _PER_TICKER_TIMEOUT, t)
                results[t] = {"error": "timeout", "ticker": t}
            except Exception as exc:
                log.warning("intraday: error for %s: %s", t, exc)
                results[t] = {"error": str(exc), "ticker": t}

    return jsonify(results)
