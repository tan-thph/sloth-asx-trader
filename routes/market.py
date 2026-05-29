"""
routes/market.py — Live market data + per-ticker analysis + portfolio risk.

Endpoints:
  /health                          GET
  /api/analyse/<ticker>            GET     — full indicator pack (5 min cache)
  /api/analyse/batch               POST    — parallel batch
  /api/quote/<ticker>              GET     — fast price + sector (45 s cache)
  /api/macro                       GET     — ASX200 + global indices (5 min cache)
  /api/rba-rate                    GET     — live → cache → user fallback → 4.35
  /api/polymarket                  GET     — Manifold market probabilities (30 min cache)
  /api/risk                        GET     — beta, Sharpe, VaR, CVaR per ticker
  /api/portfolio/nav-history       POST    — reconstruct NAV curve vs VAS
  /api/earnings-calendar           GET     — next earnings + EPS per ticker (ETFs skipped)
  /api/seasonality/<ticker>        GET     — 12-month avg return pattern (10yr, 24 h cache)
  /api/log/ai_response             POST/GET — store + retrieve raw Claude output (legacy)
  /api/log/ai_calls                GET     — browse ai_call_log (limit/offset/agent_type)
  /api/log/ai_call/<id>            GET     — full detail for one logged call
"""

import json
import re
import time as _time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from flask import Blueprint, jsonify, request

from core import LOG_DIR, ttl_cache, fetch_with_retry
from db import get_db, log_failed_ticker
from indicators import analyse_ticker, asx, safe_float


bp = Blueprint("market", __name__)


# ── Health ───────────────────────────────────────────────────────────────────

_SERVER_START = datetime.now()

@bp.route("/health")
def health():
    uptime_s = int((datetime.now() - _SERVER_START).total_seconds())
    # Latest backup file (if any)
    from db import DB_PATH
    import glob as _glob
    bak_files = sorted(_glob.glob(str(DB_PATH.parent / f"{DB_PATH.name}.bak-2*")))
    last_backup = bak_files[-1].split("bak-")[-1] if bak_files else None
    return jsonify({
        "status":      "ok",
        "time":        datetime.now().isoformat(),
        "version":     "2026-05",
        "uptime_s":    uptime_s,
        "last_backup": last_backup,
    })


# ── Per-ticker analysis ──────────────────────────────────────────────────────

@ttl_cache(seconds=300)
def _analyse_cached(ticker: str, period: str) -> dict:
    """Indicator pack for one ticker. 5 min cache — full pack is ~3 s on a Pi 5."""
    try:
        return analyse_ticker(ticker, period)
    except Exception as e:
        log_failed_ticker(ticker, str(e), context='analyse')
        return {"error": str(e), "ticker": ticker.upper()}


@bp.route("/api/analyse/<ticker>")
def analyse(ticker):
    period = request.args.get("period", "6mo")
    return jsonify(_analyse_cached(ticker.upper(), period))


@bp.route("/api/analyse/batch", methods=["POST"])
def analyse_batch():
    """Analyse multiple tickers in parallel. Body: {"tickers": ["CBA","BHP",...]}"""
    data = request.get_json(silent=True) or {}
    tickers = data.get("tickers", [])
    period = data.get("period", "6mo")
    if not tickers:
        return jsonify({}), 200
    results = {}

    def _one(t):
        return t.upper(), _analyse_cached(t.upper(), period)

    max_workers = min(len(tickers), 8)
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        for ticker, result in pool.map(_one, tickers):
            results[ticker] = result
    return jsonify(results)


# ── Seasonality ──────────────────────────────────────────────────────────────

_MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

@ttl_cache(seconds=86400)  # 24 h — historical monthly returns change very slowly
def _seasonality_cached(ticker: str) -> dict:
    sym = ticker if ticker.endswith(".AX") else ticker + ".AX"
    hist = yf.download(sym, period="10y", interval="1mo", auto_adjust=True, progress=False)
    if hist.empty:
        return {"ok": False, "error": "no data", "ticker": ticker}
    close = hist["Close"]
    if hasattr(close, "squeeze"):
        close = close.squeeze()
    returns = close.pct_change().dropna()
    by_month: dict[int, list[float]] = {}
    for idx, val in returns.items():
        m = idx.month
        v = float(val) * 100
        if not (v != v):  # skip NaN
            by_month.setdefault(m, []).append(v)
    months = []
    for m in range(1, 13):
        vals = by_month.get(m, [])
        pos = sum(1 for v in vals if v > 0)
        months.append({
            "month":    _MONTH_NAMES[m - 1],
            "avg":      round(sum(vals) / len(vals), 2) if vals else 0.0,
            "positive": pos,
            "count":    len(vals),
            "min":      round(min(vals), 2) if vals else 0.0,
            "max":      round(max(vals), 2) if vals else 0.0,
        })
    return {"ok": True, "ticker": ticker, "months": months, "years": len(close) // 12}


@bp.route("/api/seasonality/<ticker>")
def seasonality(ticker):
    """Monthly return seasonality pattern for a ticker (10yr, 24 h cache).

    Returns {ok, ticker, years, months:[{month, avg, positive, count, min, max}]}.
    avg and min/max are in percent.
    """
    try:
        return jsonify(_seasonality_cached(ticker.upper()))
    except Exception as e:
        log_failed_ticker(ticker, str(e), context='seasonality')
        return jsonify({"ok": False, "error": str(e), "ticker": ticker.upper()})


# ── Quote ────────────────────────────────────────────────────────────────────

@ttl_cache(seconds=45)
def _quote_cached(ticker: str) -> dict:
    """yfinance lookup, memoised for 45 s. Retries 3× with backoff; serves stale on full failure."""
    from indicators import get_sector_for_ticker
    t = asx(ticker)
    def _fetch():
        stk = yf.Ticker(t)
        hist = stk.history(period="2d")
        if hist.empty:
            raise ValueError("No data returned")
        cp = hist["Close"].iloc[-1]
        prev = hist["Close"].iloc[-2] if len(hist) >= 2 else cp
        sector = get_sector_for_ticker(ticker)
        return {
            "ticker":     ticker.upper(),
            "price":      round(cp, 3),
            "change":     round(cp - prev, 3),
            "change_pct": round((cp / prev - 1) * 100, 2),
            "sector":     sector,
            "fetched_at": datetime.now(timezone.utc).isoformat(),
        }
    try:
        return fetch_with_retry(_fetch, cache_key=f"quote:{ticker}")
    except Exception as e:
        log_failed_ticker(ticker, str(e), context='quote')
        return {"error": str(e), "_status": 500}


@bp.route("/api/quote/<ticker>")
def quick_quote(ticker):
    """Fast current price lookup with sector. 45 s cache."""
    result = _quote_cached(ticker.upper())
    status = result.pop("_status", 200) if "error" in result else 200
    return jsonify(result), status


# ── Macro ────────────────────────────────────────────────────────────────────

@ttl_cache(seconds=300)
def _macro_payload() -> dict:
    """Build the macro payload. Cached 5 min.

    Perf note: all yfinance fetches run in one parallel pool. Symbols that
    need wider history (ASX200 → extended stats + A-VIX; AUD/USD + iron ore
    → 5d change) use longer periods so no second serial fetch pass is needed.
    """
    # period "3mo" for ASX200 (extended regime stats + A-VIX);
    # period "1mo" for AUD/USD and iron ore (need 6+ bars for 5d change).
    symbols = {
        "sp500":    ("^GSPC",    "5d"),
        "nasdaq":   ("^IXIC",    "5d"),
        "dow":      ("^DJI",     "5d"),
        "asx200":   ("^AXJO",    "3mo"),
        "gold":     ("GC=F",     "5d"),
        "oil":      ("CL=F",     "5d"),
        "aud_usd":  ("AUDUSD=X", "1mo"),
        "vix":      ("^VIX",     "5d"),
        "us10y":    ("^TNX",     "5d"),
        "iron_ore": ("TIO=F",    "1mo"),
        "copper":   ("HG=F",     "5d"),
    }
    macro_data = {}
    _histories: dict = {}

    def _fetch_symbol(item):
        name, (sym, period) = item
        def _do():
            h = yf.Ticker(sym).history(period=period)
            if not h.empty and len(h) >= 2:
                return h  # full DataFrame; summary computed below
            raise ValueError("Empty history")
        try:
            hist = fetch_with_retry(_do, cache_key=f"macro:{sym}:hist", max_retries=2, backoff=1.5)
            latest = float(hist["Close"].iloc[-1])
            prev   = float(hist["Close"].iloc[-2])
            summary = {
                "value":       round(latest, 2),
                "change_pct":  round((latest / prev - 1) * 100, 2),
                "prev_close":  round(prev, 2),
            }
            return name, hist, summary
        except Exception:
            return name, None, None

    with ThreadPoolExecutor(max_workers=len(symbols)) as pool:
        for name, hist, summary in pool.map(_fetch_symbol, symbols.items()):
            macro_data[name] = summary
            if hist is not None:
                _histories[name] = hist

    # ── Extended ASX200 stats + A-VIX (realized 20d vol) ─────────────────────
    asx_hist = _histories.get("asx200")
    if asx_hist is not None and len(asx_hist) >= 22:
        try:
            close = asx_hist["Close"]
            high  = asx_hist["High"]
            low   = asx_hist["Low"]

            latest_price = float(close.iloc[-1])
            ret5d  = float((close.iloc[-1] / close.iloc[-6]  - 1) * 100) if len(close) >= 6  else None
            ret20d = float((close.iloc[-1] / close.iloc[-21] - 1) * 100) if len(close) >= 21 else None

            # A-VIX: realized 20-day annualized volatility (ASX local volatility gauge)
            if len(close) >= 21:
                daily_rets = close.pct_change().dropna().iloc[-20:]
                asx_vol_20d = round(float(daily_rets.std() * (252 ** 0.5) * 100), 1)
            else:
                asx_vol_20d = None

            tr_list = []
            for i in range(1, min(15, len(close))):
                tr = max(
                    float(high.iloc[-i]) - float(low.iloc[-i]),
                    abs(float(high.iloc[-i]) - float(close.iloc[-i-1])),
                    abs(float(low.iloc[-i])  - float(close.iloc[-i-1])),
                )
                tr_list.append(tr)
            atr14   = float(np.mean(tr_list)) if tr_list else None
            atr_pct = float(atr14 / latest_price * 100) if atr14 and latest_price else None

            adx_val = None
            try:
                if len(close) >= 28:
                    plus_dm  = np.maximum(np.diff(high.values[-28:]),  0)
                    minus_dm = np.maximum(-np.diff(low.values[-28:]), 0)
                    tr_vals  = np.array([
                        max(float(high.iloc[-28+i]) - float(low.iloc[-28+i]),
                            abs(float(high.iloc[-28+i]) - float(close.iloc[-29+i])),
                            abs(float(low.iloc[-28+i])  - float(close.iloc[-29+i])))
                        for i in range(1, 28)
                    ])
                    atr_sm = np.mean(tr_vals[-14:])
                    pdi_sm = np.mean(plus_dm[-14:])
                    mdi_sm = np.mean(minus_dm[-14:])
                    if atr_sm > 0:
                        pdi = 100 * pdi_sm / atr_sm
                        mdi = 100 * mdi_sm / atr_sm
                        dx  = 100 * abs(pdi - mdi) / (pdi + mdi) if (pdi + mdi) > 0 else 0
                        adx_val = round(float(dx), 1)
            except Exception:
                pass

            macro_data["asx200_5d_return"]  = round(ret5d,  2) if ret5d  is not None else None
            macro_data["asx200_20d_return"] = round(ret20d, 2) if ret20d is not None else None
            macro_data["asx200_atr_pct"]    = round(atr_pct, 3) if atr_pct is not None else None
            macro_data["asx200_adx"]        = adx_val
            macro_data["asx_vol_20d"]       = asx_vol_20d
        except Exception:
            pass

    # ── 5d changes for AUD/USD and iron ore (reuse already-fetched history) ──
    for field, key in [("aud_usd_change_5d", "aud_usd"), ("iron_ore_change_5d", "iron_ore")]:
        h = _histories.get(key)
        if h is not None and len(h) >= 6:
            macro_data[field] = round(float((h["Close"].iloc[-1] / h["Close"].iloc[-6] - 1) * 100), 2)
        else:
            macro_data[field] = None

    # Advance/decline breadth: populated from the most recent market scan's
    # universe breadth (% of ASX tickers above 20-day SMA). Falls back to None
    # before the first scan runs; regime-engine.js guards `adr != null`.
    try:
        from routes.scanner import _scan_state as _scanner_state  # lazy import avoids circular dep
        macro_data["advance_decline_ratio"] = _scanner_state.get("breadth_ratio")
    except Exception:
        macro_data["advance_decline_ratio"] = None

    return macro_data


@bp.route("/api/macro")
def macro():
    """Real market data for macro dashboard (yfinance). Cached 5 min upstream."""
    return jsonify(_macro_payload())


# ── RBA cash rate ────────────────────────────────────────────────────────────

@bp.route("/api/rba-rate")
def rba_rate():
    """Live RBA scrape → DB cache (7d) → user-set → 4.35 fallback."""
    CACHE_KEY = "rba_cash_rate"
    CACHE_DATE_KEY = "rba_cash_rate_date"
    today = datetime.now().strftime("%Y-%m-%d")

    rate = None
    source = "live"
    try:
        url = "https://www.rba.gov.au/statistics/cash-rate/"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        m = re.search(r"Cash\s+Rate\s+Target[^0-9]*(\d+\.\d+)\s*%", html, re.IGNORECASE | re.DOTALL)
        if not m:
            m = re.search(r'<td[^>]*>\s*(\d+\.\d+)\s*%\s*</td>', html)
        if m:
            rate = float(m.group(1))
            if not (0 <= rate <= 10):
                rate = None
                source = "live-failed"
            else:
                source = "live-rba"
    except Exception:
        pass

    if rate is not None:
        with get_db() as conn:
            conn.execute("INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                         (CACHE_KEY, json.dumps(rate)))
            conn.execute("INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                         (CACHE_DATE_KEY, json.dumps(today)))
        return jsonify({"rate": rate, "source": source, "date": today})

    with get_db() as conn:
        row = conn.execute("SELECT value, updated_at FROM blob_store WHERE key=?", (CACHE_KEY,)).fetchone()
        date_row = conn.execute("SELECT value FROM blob_store WHERE key=?", (CACHE_DATE_KEY,)).fetchone()
        if row and date_row:
            try:
                cached_rate = json.loads(row["value"])
                cached_date = json.loads(date_row["value"])
                if (datetime.now() - datetime.strptime(cached_date, "%Y-%m-%d")).days < 7:
                    return jsonify({"rate": cached_rate, "source": "cached", "date": cached_date})
            except Exception:
                pass

    user_rate = request.args.get("user_rate")
    if user_rate:
        try:
            manual_rate = float(user_rate)
            if 0 <= manual_rate <= 10:
                return jsonify({"rate": manual_rate, "source": "user-settings", "date": today})
        except Exception:
            pass

    return jsonify({"rate": 4.35, "source": "fallback", "date": today})


# ── Prediction markets (Manifold) ────────────────────────────────────────────

_PM_QUERIES = [
    {"id": "rba_cut",      "label": "RBA Rate Cut 2026",       "positive_for_asx": True,
     "term": "RBA rate cut 2026",                 "required_terms": ["rba", "reserve bank", "cash rate"]},
    {"id": "fed_cut",      "label": "Fed Rate Cut 2026",       "positive_for_asx": True,
     "term": "Federal Reserve interest rate cut 2026",
     "required_terms": ["federal reserve", "fed", "fomc", "interest rate"]},
    {"id": "us_recession", "label": "US Recession 2026",       "positive_for_asx": False,
     "term": "US recession 2026",                 "required_terms": ["recession", "gdp"]},
    {"id": "aud_usd",      "label": "AUD/USD strength 2026",   "positive_for_asx": None,
     "term": "AUD USD Australian dollar 2026",
     "required_terms": ["aud", "australian dollar", "aud/usd", "aussie"]},
    {"id": "china_gdp",    "label": "China GDP target 2026",   "positive_for_asx": True,
     "term": "China GDP growth 2026",             "required_terms": ["china", "chinese", "gdp"]},
    {"id": "sp500",        "label": "S&P 500 2026",            "positive_for_asx": True,
     "term": "S&P 500 all-time high 2026",
     "required_terms": ["s&p", "sp500", "s&p 500", "stock market"]},
]
_PM_CACHE: dict = {"data": None, "fetched_at": 0.0}
_PM_CACHE_TTL = 1800
_MANIFOLD_HDR = {"User-Agent": "SlothASXTrader/1.0", "Accept": "application/json"}


def _fetch_manifold_market(query: dict, req_mod) -> dict:
    """Fetch best open binary market from Manifold for one query."""
    entry = {
        "id": query["id"], "label": query["label"],
        "positive_for_asx": query["positive_for_asx"],
        "question": None, "yes_prob": None, "volume": None, "end_date": None,
        "source": "manifold", "error": None,
    }
    try:
        r = req_mod.get(
            "https://api.manifold.markets/v0/search-markets",
            params={"term": query["term"], "filter": "open", "limit": 10, "sort": "liquidity"},
            headers=_MANIFOLD_HDR, timeout=8,
        )
        r.raise_for_status()
        markets = r.json()
        if not isinstance(markets, list):
            markets = markets.get("markets", [])

        required = [t.lower() for t in query.get("required_terms", [])]
        for m in markets:
            if m.get("mechanism") != "cpmm-1":
                continue
            if m.get("isResolved") or m.get("closeTime", 0) < 1:
                continue
            q_lc = (m.get("question") or "").lower()
            if required and not any(t in q_lc for t in required):
                continue
            prob = m.get("probability")
            if prob is None:
                continue
            entry["question"] = m.get("question", "")
            entry["yes_prob"] = round(float(prob), 4)
            entry["volume"]   = round(float(m.get("volume") or 0), 2)
            close_ts = m.get("closeTime")
            if close_ts:
                entry["end_date"] = datetime.fromtimestamp(close_ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            entry["url"] = m.get("url", "")
            break
    except Exception as exc:
        entry["error"] = str(exc)
    return entry


@bp.route("/api/polymarket")
def polymarket_markets():
    """Manifold market probabilities. Route name kept as /api/polymarket for frontend compat."""
    now = _time.time()
    if _PM_CACHE["data"] and (now - _PM_CACHE["fetched_at"]) < _PM_CACHE_TTL:
        cached = dict(_PM_CACHE["data"])
        cached["cached"] = True
        return jsonify(cached)

    markets_out = [_fetch_manifold_market(q, requests) for q in _PM_QUERIES]
    result = {
        "markets":    markets_out,
        "fetched_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cached":     False,
        "source":     "manifold",
    }
    _PM_CACHE["data"]       = result
    _PM_CACHE["fetched_at"] = now
    return jsonify(result)


# ── Portfolio risk ───────────────────────────────────────────────────────────

@bp.route("/api/risk")
def portfolio_risk():
    """Compute portfolio risk metrics: beta, annualised volatility, Sharpe, correlation."""
    tickers_raw = request.args.get("tickers", "")
    tickers = [t.strip().upper() for t in tickers_raw.split(",") if t.strip()]
    if not tickers:
        return jsonify({"error": "tickers required"}), 400

    rf_rate = float(request.args.get("rf", 4.35)) / 100
    benchmark = "VAS.AX"
    asx_tickers = [f"{t}.AX" for t in tickers]
    all_dl = list(set(asx_tickers + [benchmark]))

    try:
        raw = yf.download(all_dl, period="90d", auto_adjust=True, progress=False)
        if raw.empty:
            return jsonify({"error": "No market data returned"}), 502

        if isinstance(raw.columns, pd.MultiIndex):
            closes = raw["Close"] if "Close" in raw.columns.get_level_values(0) else raw.iloc[:, 0]
        else:
            closes = raw[["Close"]] if "Close" in raw.columns else raw

        closes = closes.dropna(how="all")
        returns = closes.pct_change().dropna(how="all")

        bench_col = benchmark if benchmark in returns.columns else None
        bench_ret = returns[bench_col] if bench_col else None

        metrics = {}
        for ticker, asx_t in zip(tickers, asx_tickers):
            col = asx_t if asx_t in returns.columns else None
            if col is None:
                continue
            tr = returns[col].dropna()
            if len(tr) < 10:
                continue

            vol_ann = float(tr.std() * (252 ** 0.5) * 100)
            mean_d  = float(tr.mean())
            daily_rf = rf_rate / 252
            sharpe  = float((mean_d - daily_rf) / tr.std() * (252 ** 0.5)) if tr.std() > 0 else 0.0

            beta = 1.0
            if bench_ret is not None:
                aligned = pd.concat([tr, bench_ret], axis=1).dropna()
                if len(aligned) >= 10:
                    cov_mat = aligned.cov()
                    var_b   = float(aligned.iloc[:, 1].var())
                    beta    = float(cov_mat.iloc[0, 1] / var_b) if var_b > 0 else 1.0

            ret_30d = float((1 + tr.tail(21)).prod() - 1) * 100
            ret_90d = float((1 + tr).prod() - 1) * 100

            var_95  = float(tr.quantile(0.05)) * 100
            cvar_95 = float(tr[tr <= tr.quantile(0.05)].mean()) * 100 if len(tr[tr <= tr.quantile(0.05)]) else var_95

            px_series = closes[col].dropna()
            peak_px   = px_series.iloc[0]
            max_dd    = 0.0
            for px_val in px_series:
                if px_val > peak_px:
                    peak_px = px_val
                dd = (peak_px - px_val) / peak_px * 100 if peak_px > 0 else 0.0
                if dd > max_dd:
                    max_dd = dd

            metrics[ticker] = {
                "volatility_ann": round(vol_ann, 2),
                "sharpe":         round(sharpe, 3),
                "beta":           round(beta, 3),
                "return_30d":     round(ret_30d, 2),
                "return_90d":     round(ret_90d, 2),
                "var_95":         round(var_95, 2),
                "cvar_95":        round(cvar_95, 2),
                "max_drawdown":   round(max_dd, 2),
                "data_points":    len(tr),
            }

        port_cols = [t for t in asx_tickers if t in returns.columns]
        correlation = {}
        if len(port_cols) >= 2:
            corr = returns[port_cols].corr()
            for i, at in enumerate(port_cols):
                t = tickers[asx_tickers.index(at)]
                correlation[t] = {}
                for j, bt in enumerate(port_cols):
                    t2 = tickers[asx_tickers.index(bt)]
                    correlation[t][t2] = round(float(corr.iloc[i, j]), 3)

        return jsonify({"metrics": metrics, "correlation": correlation, "tickers": tickers})

    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Portfolio NAV history ────────────────────────────────────────────────────

@bp.route("/api/portfolio/nav-history", methods=["POST"])
def portfolio_nav_history():
    """Reconstruct portfolio NAV over time using current share quantities."""
    data      = request.get_json() or {}
    portfolio = data.get("portfolio", [])
    period    = data.get("period", "1y")
    cash      = float(data.get("cash", 0))

    if not portfolio:
        return jsonify({"error": "portfolio required"}), 400

    benchmark   = "VAS.AX"
    tickers     = [h["ticker"].upper() for h in portfolio]
    shares_map  = {h["ticker"].upper(): float(h["shares"]) for h in portfolio}
    asx_tickers = [f"{t}.AX" for t in tickers]
    all_dl      = list(set(asx_tickers + [benchmark]))

    try:
        raw = yf.download(all_dl, period=period, auto_adjust=True, progress=False)
        if raw.empty:
            return jsonify({"error": "No data returned"}), 502

        if isinstance(raw.columns, pd.MultiIndex):
            closes = raw["Close"]
        else:
            closes = raw[["Close"]]

        closes = closes.ffill().dropna(how="all")

        nav = pd.Series(0.0, index=closes.index)
        for t, asx_t in zip(tickers, asx_tickers):
            if asx_t in closes.columns:
                nav += closes[asx_t].fillna(0) * shares_map[t]
        nav = nav[nav > 0]
        if nav.empty:
            return jsonify({"error": "No valid price data"}), 502

        nav_with_cash = nav + cash

        bench_values = None
        if benchmark in closes.columns:
            bench_ser  = closes[benchmark].reindex(nav.index).ffill()
            first_b    = bench_ser.iloc[0]
            first_nav  = nav_with_cash.iloc[0]
            bench_norm = (bench_ser / first_b) * first_nav
            bench_values = [round(float(v), 2) for v in bench_norm.values]

        values = [round(float(v), 2) for v in nav_with_cash.values]
        dates  = [d.strftime("%Y-%m-%d") for d in nav_with_cash.index]

        total_return = (values[-1] - values[0]) / values[0] * 100 if values[0] else 0.0
        peak = values[0]
        max_dd = 0.0
        for v in values:
            if v > peak:
                peak = v
            dd = (peak - v) / peak * 100 if peak > 0 else 0.0
            if dd > max_dd:
                max_dd = dd

        bench_return = None
        if bench_values and bench_values[0]:
            bench_return = round((bench_values[-1] - bench_values[0]) / bench_values[0] * 100, 2)

        return jsonify({
            "dates":         dates,
            "values":        values,
            "benchmark":     bench_values,
            "total_return":  round(total_return, 2),
            "max_drawdown":  round(max_dd, 2),
            "bench_return":  bench_return,
            "period":        period,
        })
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── ASX200 benchmark history ────────────────────────────────────────────────

@bp.route("/api/benchmark")
def benchmark_history():
    """Return ^AXJO (ASX200) historical closes for benchmark overlay on Value History chart."""
    period = request.args.get("period", "2y")
    valid = {"1mo", "3mo", "6mo", "1y", "2y", "5y", "10y"}
    if period not in valid:
        period = "2y"
    try:
        raw = yf.download("^AXJO", period=period, auto_adjust=True, progress=False)
        if raw.empty:
            return jsonify({"error": "No data returned"}), 502
        if isinstance(raw.columns, pd.MultiIndex):
            closes = raw["Close"].iloc[:, 0]
        else:
            closes = raw["Close"]
        closes = closes.dropna()
        dates  = [d.strftime("%Y-%m-%d") for d in closes.index]
        prices = [round(float(v), 2) for v in closes.values]
        return jsonify({"dates": dates, "prices": prices, "symbol": "^AXJO"})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 500


# ── Earnings calendar ────────────────────────────────────────────────────────

@bp.route("/api/earnings-calendar")
def earnings_calendar():
    """Fetch upcoming earnings dates + EPS estimates from yfinance (ETFs skipped)."""
    tickers_param = request.args.get("tickers", "")
    tickers = [t.strip() for t in tickers_param.split(",") if t.strip()]
    if not tickers:
        return jsonify({"error": "No tickers"}), 400

    results = {}

    def _fetch_earnings(ticker):
        try:
            stk = yf.Ticker(asx(ticker))
            info = stk.info or {}
            # Skip ETFs and mutual funds — they have no earnings data and yfinance
            # logs 404 errors per symbol.  Detect via quoteType from the info dict.
            if info.get("quoteType", "").upper() in ("ETF", "MUTUALFUND", "MONEYMARKET"):
                return ticker.upper(), {"nextEarningsDate": None, "skipped": "ETF"}

            next_earnings = None
            try:
                cal = stk.calendar
                if cal is not None:
                    if isinstance(cal, dict):
                        ed = cal.get("Earnings Date")
                        if ed:
                            if hasattr(ed, '__iter__') and not isinstance(ed, str):
                                ed = list(ed)[0]
                            next_earnings = str(ed)[:10] if ed else None
                    elif hasattr(cal, 'loc') and "Earnings Date" in cal.index:
                        vals = cal.loc["Earnings Date"].values
                        if len(vals):
                            next_earnings = str(vals[0])[:10]
            except Exception:
                pass

            eps_fwd = safe_float(info.get("forwardEps"))
            eps_ttm = safe_float(info.get("trailingEps"))
            eps_growth = safe_float(info.get("earningsGrowth"))
            revenue_growth = safe_float(info.get("revenueGrowth"))
            earnings_quarterly = []
            try:
                eq = stk.quarterly_earnings
                if eq is not None and not eq.empty:
                    for dt, row in eq.tail(4).iterrows():
                        earnings_quarterly.append({
                            "date": str(dt)[:10] if hasattr(dt, '__str__') else str(dt),
                            "actual": safe_float(row.get("Reported EPS") or row.get("actual")),
                            "estimate": safe_float(row.get("Estimated EPS") or row.get("estimate")),
                        })
            except Exception:
                pass

            return ticker.upper(), {
                "nextEarningsDate": next_earnings,
                "forwardEps": eps_fwd,
                "trailingEps": eps_ttm,
                "epsGrowth": eps_growth,
                "revenueGrowth": revenue_growth,
                "quarterlyEarnings": earnings_quarterly,
                "analystTarget": safe_float(info.get("targetMeanPrice")),
                "analystRec": info.get("recommendationKey", "n/a"),
            }
        except Exception as e:
            return ticker.upper(), {"error": str(e)}

    with ThreadPoolExecutor(max_workers=min(len(tickers), 8)) as pool:
        for ticker, result in pool.map(_fetch_earnings, tickers):
            results[ticker] = result
    return jsonify(results)


# ── AI response / call logging ────────────────────────────────────────────────

@bp.route("/api/log/ai_response", methods=["POST"])
def log_ai_response():
    """Store the full AI call (prompt + response) for debugging and audit.

    Required:  text          — the raw AI response text
    Optional:  system_prompt — system prompt sent to the model
               user_message  — user message sent to the model
               agent_type    — e.g. 'portfolio', 'macro', 'dayTrade'
               model         — model name (e.g. 'claude-sonnet-4-6')
               usage         — {input_tokens, output_tokens,
                               cache_read_input_tokens, cache_creation_input_tokens}
               duration_ms   — wall-clock ms for the API call
    """
    data = request.get_json() or {}
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "text required"}), 400

    system_prompt = (data.get("system_prompt") or "")[:20000]
    user_message  = (data.get("user_message")  or "")[:30000]
    agent_type    = data.get("agent_type", "")
    model         = data.get("model", "")
    duration_ms   = data.get("duration_ms")
    usage         = data.get("usage") or {}
    input_tokens  = usage.get("input_tokens")
    output_tokens = usage.get("output_tokens")
    cache_read    = usage.get("cache_read_input_tokens", 0) or 0
    cache_written = usage.get("cache_creation_input_tokens", 0) or 0

    with get_db() as conn:
        # Legacy: keep last_ai_raw_response for backward compat
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) "
            "VALUES (?, ?, datetime('now','localtime'))",
            ("last_ai_raw_response", json.dumps(text))
        )
        # New: append full call to ai_call_log
        conn.execute(
            """INSERT INTO ai_call_log
               (agent_type, model, system_prompt, user_message, response_text,
                input_tokens, output_tokens, cache_read, cache_written, duration_ms)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (agent_type, model, system_prompt, user_message, text,
             input_tokens, output_tokens, cache_read, cache_written, duration_ms)
        )

    # Write human-readable file with both prompt and response
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename  = LOG_DIR / f"ai_response_{timestamp}.txt"
    cleaned   = text.strip()
    cleaned   = re.sub(r"^\s*```json\s*", "", cleaned, flags=re.MULTILINE)
    cleaned   = re.sub(r"\s*```\s*$", "", cleaned)

    tok_summary = (
        f"Tokens: in={input_tokens or '?'} out={output_tokens or '?'} | "
        f"Cache: read={cache_read} written={cache_written} | "
        f"Duration: {duration_ms or '?'}ms"
    )
    with open(filename, "w", encoding="utf-8") as f:
        f.write(f"=== AI CALL LOG ===\n")
        f.write(f"Agent: {agent_type or '?'} | Model: {model or '?'} | {timestamp}\n")
        f.write(f"{tok_summary}\n\n")
        if system_prompt:
            f.write(f"--- SYSTEM PROMPT ---\n{system_prompt}\n\n")
        if user_message:
            f.write(f"--- USER MESSAGE ---\n{user_message}\n\n")
        f.write(f"--- RESPONSE ---\n{cleaned}\n")

    return jsonify({"ok": True, "saved_to": str(filename), "timestamp": timestamp})


@bp.route("/api/log/ai_response")
def get_ai_response():
    """Legacy: return the most recent raw response text (kept for backward compat)."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT value, updated_at FROM blob_store WHERE key='last_ai_raw_response'"
        ).fetchone()
    if row:
        return jsonify({"text": json.loads(row["value"]), "savedAt": row["updated_at"]})
    return jsonify({"text": None})


@bp.route("/api/log/ai_calls")
def list_ai_calls():
    """Browse recent AI call log entries (metadata only, no full text).

    Query params: limit (default 20), offset (default 0), agent_type (optional filter).
    """
    limit      = min(int(request.args.get("limit", 20)), 200)
    offset     = int(request.args.get("offset", 0))
    agent_filter = request.args.get("agent_type", "")

    with get_db() as conn:
        if agent_filter:
            rows = conn.execute(
                """SELECT id, timestamp, agent_type, model,
                          input_tokens, output_tokens, cache_read, cache_written,
                          duration_ms,
                          substr(system_prompt, 1, 120)  AS sys_snippet,
                          substr(user_message,  1, 200)  AS usr_snippet,
                          substr(response_text, 1, 200)  AS resp_snippet
                   FROM ai_call_log
                   WHERE agent_type = ?
                   ORDER BY id DESC LIMIT ? OFFSET ?""",
                (agent_filter, limit, offset)
            ).fetchall()
            total = conn.execute(
                "SELECT COUNT(*) FROM ai_call_log WHERE agent_type=?", (agent_filter,)
            ).fetchone()[0]
        else:
            rows = conn.execute(
                """SELECT id, timestamp, agent_type, model,
                          input_tokens, output_tokens, cache_read, cache_written,
                          duration_ms,
                          substr(system_prompt, 1, 120)  AS sys_snippet,
                          substr(user_message,  1, 200)  AS usr_snippet,
                          substr(response_text, 1, 200)  AS resp_snippet
                   FROM ai_call_log
                   ORDER BY id DESC LIMIT ? OFFSET ?""",
                (limit, offset)
            ).fetchall()
            total = conn.execute("SELECT COUNT(*) FROM ai_call_log").fetchone()[0]

    entries = [dict(r) for r in rows]
    return jsonify({"ok": True, "total": total, "limit": limit, "offset": offset, "entries": entries})


@bp.route("/api/log/ai_call/<int:call_id>")
def get_ai_call(call_id):
    """Return the full content of a single logged AI call."""
    with get_db() as conn:
        row = conn.execute(
            "SELECT * FROM ai_call_log WHERE id=?", (call_id,)
        ).fetchone()
    if not row:
        return jsonify({"error": "not found"}), 404
    return jsonify(dict(row))
