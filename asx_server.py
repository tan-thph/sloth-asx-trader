#!/usr/bin/env python3
"""
ASX Trading Assistant - Backend Server
Run: python3 asx_server.py
Then open asx_trading_assistant.html in your browser.

Requirements:
    pip install yfinance pandas numpy flask flask-cors ta
"""

import json
import math
import sqlite3
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
from datetime import datetime, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np
import pandas as pd
import yfinance as yf
from flask import Flask, jsonify, request
from flask_cors import CORS

import os
import re
import time
import threading
import urllib.request
from pathlib import Path
import requests

LOG_DIR = Path(__file__).parent / "ai_responses"
LOG_DIR.mkdir(exist_ok=True)

# ── News engine (optional — graceful if missing deps) ─────────────────────────
try:
    import news_engine as _ne
    _NE_OK = True
except ImportError as _ne_err:
    _ne_err_msg = str(_ne_err)
    _NE_OK = False

# ── Announcement engine (optional — graceful if missing deps) ──────────────────
try:
    import announcement_engine as _ae
    from announcement_routes import ann_bp
    _AE_OK = True
except ImportError as _ae_err:
    _ae_err_msg = str(_ae_err)
    _AE_OK = False

app = Flask(__name__)
CORS(app)  # allow browser requests from the HTML file

# ── SQLite database ─────────────────────────────────────────────────────────────

DB_PATH = Path(__file__).parent / "asx_trader.db"


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db():
    """Create all tables on first run."""
    with get_db() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS portfolio (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                ticker      TEXT NOT NULL UNIQUE,
                shares      REAL NOT NULL,
                avg_price   REAL NOT NULL,
                current_price REAL NOT NULL,
                sector      TEXT DEFAULT 'Other',
                updated_at  TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS trade_journal (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                date        TEXT NOT NULL,
                timestamp   TEXT,
                ticker      TEXT NOT NULL,
                action      TEXT NOT NULL,
                qty         REAL NOT NULL,
                entry_price REAL NOT NULL,
                exit_price  REAL,
                fees        REAL DEFAULT 10,
                pnl         REAL,
                status      TEXT DEFAULT 'open',
                rec_id      TEXT,
                rec_executed INTEGER DEFAULT 0,
                close_date  TEXT,
                created_at  TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS rec_history (
                id                  TEXT PRIMARY KEY,
                date                TEXT NOT NULL,
                ticker              TEXT NOT NULL,
                action              TEXT NOT NULL,
                confidence          REAL,
                price_range_low     REAL,
                price_range_high    REAL,
                target              REAL,
                stop_loss           REAL,
                expected_profit     REAL,
                net_profit          REAL,
                executed            INTEGER DEFAULT 0,
                executed_at         TEXT,
                outcome             TEXT,
                actual_profit       REAL,
                reasoning           TEXT,
                risks               TEXT,
                signals             TEXT,
                learning_id         INTEGER,
                created_at          TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS settings (
                key     TEXT PRIMARY KEY,
                value   TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS cash (
                id      INTEGER PRIMARY KEY CHECK (id = 1),
                amount  REAL NOT NULL DEFAULT 15000,
                updated_at TEXT DEFAULT (datetime('now','localtime'))
            );

            INSERT OR IGNORE INTO cash (id, amount) VALUES (1, 15000);
            CREATE TABLE IF NOT EXISTS blob_store (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT DEFAULT (datetime('now','localtime'))
            );

            CREATE TABLE IF NOT EXISTS dividend_cache (
                ticker     TEXT PRIMARY KEY,
                data       TEXT NOT NULL,
                source     TEXT DEFAULT 'asx',
                fetched_at TEXT DEFAULT (datetime('now','localtime')),
                expires_at TEXT
            );

            CREATE TABLE IF NOT EXISTS ticker_metadata (
                ticker      TEXT PRIMARY KEY,
                sector      TEXT,
                industry    TEXT,
                short_name  TEXT,
                fetched_at  TEXT DEFAULT (datetime('now','localtime')),
                expires_at  TEXT
            );

            CREATE TABLE IF NOT EXISTS failed_tickers (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp   TEXT DEFAULT (datetime('now','localtime')),
                ticker      TEXT,
                error       TEXT,
                context     TEXT DEFAULT 'scan'
            );

            CREATE TABLE IF NOT EXISTS ai_learning_events (
                id                   INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                event_type           TEXT NOT NULL DEFAULT 'recommendation',
                ticker               TEXT,
                regime               TEXT,
                prompt_version       TEXT,
                agent_type           TEXT,
                ai_confidence        REAL,
                ensemble_confidence  REAL,
                recommendation       TEXT,
                rationale_summary    TEXT,
                suggested_stop       REAL,
                suggested_target     REAL,
                rr_ratio             REAL,
                outcome_status       TEXT,
                realized_pnl_pct     REAL,
                realized_pnl_aud     REAL,
                holding_period_days  INTEGER,
                exit_reason          TEXT,
                was_executed         INTEGER DEFAULT 0,
                actual_entry_price   REAL,
                actual_exit_price    REAL,
                sector               TEXT,
                follow_through_days  INTEGER,
                market_context       TEXT,
                error_type           TEXT,
                notes                TEXT
            );

            CREATE TABLE IF NOT EXISTS prompt_versions (
                version              TEXT PRIMARY KEY,
                created_at           TEXT,
                description          TEXT,
                total_calls          INTEGER DEFAULT 0,
                win_rate             REAL DEFAULT 0,
                high_conf_win_rate   REAL DEFAULT 0
            );

            CREATE INDEX IF NOT EXISTS idx_learning_ticker    ON ai_learning_events(ticker);
            CREATE INDEX IF NOT EXISTS idx_learning_ts        ON ai_learning_events(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_learning_regime    ON ai_learning_events(regime);
            CREATE INDEX IF NOT EXISTS idx_learning_pv        ON ai_learning_events(prompt_version);
            CREATE INDEX IF NOT EXISTS idx_learning_conf      ON ai_learning_events(ai_confidence);
            CREATE INDEX IF NOT EXISTS idx_failed_ts          ON failed_tickers(timestamp DESC);
        """)

init_db()

# Migrations for existing databases
with get_db() as _mig:
    _rh_cols = {r[1] for r in _mig.execute("PRAGMA table_info(rec_history)").fetchall()}
    if "learning_id" not in _rh_cols:
        _mig.execute("ALTER TABLE rec_history ADD COLUMN learning_id INTEGER")

    _le_cols = {r[1] for r in _mig.execute("PRAGMA table_info(ai_learning_events)").fetchall()}
    for _col, _defn in [
        ("actual_entry_price",  "REAL"),
        ("actual_exit_price",   "REAL"),
        ("sector",              "TEXT"),
        ("follow_through_days", "INTEGER"),
        ("market_context",      "TEXT"),
        ("error_type",          "TEXT"),
        ("notes",               "TEXT"),
    ]:
        if _col not in _le_cols:
            _mig.execute(f"ALTER TABLE ai_learning_events ADD COLUMN {_col} {_defn}")

    _tj_cols = {r[1] for r in _mig.execute("PRAGMA table_info(trade_journal)").fetchall()}
    if "close_date" not in _tj_cols:
        _mig.execute("ALTER TABLE trade_journal ADD COLUMN close_date TEXT")


def _log_failed_ticker(ticker: str, error: str, context: str = 'scan') -> None:
    """Persist a failed yfinance fetch to failed_tickers table (best-effort)."""
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT INTO failed_tickers (ticker, error, context) VALUES (?, ?, ?)",
                (ticker, str(error)[:500], context)
            )
    except Exception:
        pass


# ── Register blueprints ────────────────────────────────────────────────────────
if _AE_OK:
    app.register_blueprint(ann_bp, url_prefix='/api/announcements')

# ── Indicator calculations and analysis live in indicators.py ──────────────────
from indicators import (
    asx, safe_float, get_sector_for_ticker, ASX_SECTOR_MAP,
    compute_rsi, compute_macd, compute_bollinger, compute_atr,
    compute_stochastic, compute_adx, compute_obv, compute_vwap,
    compute_williams_r, compute_cci, compute_mfi, compute_donchian,
    compute_keltner, compute_support_resistance,
    _simple_rsi, _score_ticker,
    analyse_ticker,
)

# ── Flask routes ────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    return jsonify({"status": "ok", "time": datetime.now().isoformat()})


@app.route("/api/analyse/<ticker>")
def analyse(ticker):
    period = request.args.get("period", "6mo")
    try:
        result = analyse_ticker(ticker, period)
        return jsonify(result)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/analyse/batch", methods=["POST"])
def analyse_batch():
    """Analyse multiple tickers in parallel. Body: {"tickers": ["CBA","BHP",...]}"""
    data = request.get_json()
    tickers = data.get("tickers", [])
    period = data.get("period", "6mo")
    results = {}

    def _analyse(t):
        try:
            return t.upper(), analyse_ticker(t, period)
        except Exception as e:
            return t.upper(), {"error": str(e)}

    max_workers = min(len(tickers), 8)  # cap at 8 threads to avoid yfinance rate limits
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_analyse, t): t for t in tickers}
        for future in as_completed(futures):
            ticker, result = future.result()
            results[ticker] = result

    return jsonify(results)


@app.route("/api/macro")
def macro():
    """Return real market data for macro dashboard using yfinance.
    Extended with regime-detection fields:
      asx200_5d_return, asx200_20d_return, asx200_atr_pct, asx200_adx,
      advance_decline_ratio, aud_usd_change_5d, iron_ore_change_5d
    """
    symbols = {
        "sp500": "^GSPC",
        "nasdaq": "^IXIC",
        "dow": "^DJI",
        "asx200": "^AXJO",
        "gold": "GC=F",
        "oil": "CL=F",
        "aud_usd": "AUDUSD=X",
        "vix": "^VIX",
        "us10y": "^TNX",
        "iron_ore": "TIO=F",
        "copper": "HG=F",
    }
    macro_data = {}

    def _fetch_symbol(name_sym):
        name, sym = name_sym
        try:
            hist = yf.Ticker(sym).history(period="5d")
            if not hist.empty and len(hist) >= 2:
                latest = hist["Close"].iloc[-1]
                prev = hist["Close"].iloc[-2]
                pct = (latest / prev - 1) * 100
                return name, {
                    "value": round(latest, 2),
                    "change_pct": round(pct, 2),
                    "prev_close": round(prev, 2),
                }
        except Exception:
            pass
        return name, None

    with ThreadPoolExecutor(max_workers=len(symbols)) as pool:
        for name, result in pool.map(_fetch_symbol, symbols.items()):
            macro_data[name] = result

    # ── Regime detection fields — extended ASX200 stats ──────────────────────
    try:
        import numpy as np
        asx_hist = yf.Ticker("^AXJO").history(period="3mo")
        if not asx_hist.empty and len(asx_hist) >= 22:
            close = asx_hist["Close"]
            high  = asx_hist["High"]
            low   = asx_hist["Low"]

            latest_price = float(close.iloc[-1])

            # 5d and 20d returns
            ret5d  = float((close.iloc[-1] / close.iloc[-6]  - 1) * 100) if len(close) >= 6  else None
            ret20d = float((close.iloc[-1] / close.iloc[-21] - 1) * 100) if len(close) >= 21 else None

            # ATR% (14-day)
            tr_list = []
            for i in range(1, min(15, len(close))):
                tr = max(
                    float(high.iloc[-i]) - float(low.iloc[-i]),
                    abs(float(high.iloc[-i]) - float(close.iloc[-i-1])),
                    abs(float(low.iloc[-i])  - float(close.iloc[-i-1])),
                )
                tr_list.append(tr)
            atr14 = float(np.mean(tr_list)) if tr_list else None
            atr_pct = float(atr14 / latest_price * 100) if atr14 and latest_price else None

            # ADX (14-day, simplified)
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
                    atr_sm  = np.mean(tr_vals[-14:])
                    pdi_sm  = np.mean(plus_dm[-14:])
                    mdi_sm  = np.mean(minus_dm[-14:])
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
    except Exception as e:
        print(f"[macro] ASX200 regime fields error: {e}")

    # ── AUD/USD 5d change and Iron Ore 5d change ─────────────────────────────
    try:
        for field, sym in [("aud_usd_change_5d", "AUDUSD=X"), ("iron_ore_change_5d", "TIO=F")]:
            h = yf.Ticker(sym).history(period="10d")
            if h is not None and not h.empty and len(h) >= 6:
                macro_data[field] = round(float((h["Close"].iloc[-1] / h["Close"].iloc[-6] - 1) * 100), 2)
            else:
                macro_data[field] = None
    except Exception:
        macro_data.setdefault("aud_usd_change_5d", None)
        macro_data.setdefault("iron_ore_change_5d", None)

    # ── Advance / Decline ratio (proxy via ETF breadth) ───────────────────────
    # True A/D ratio requires live ASX exchange data; use XJO vs XJOA spread as proxy.
    # Falls back to None if unavailable — regime engine handles gracefully.
    try:
        xjoa = yf.Ticker("^XJOA").history(period="5d")
        xjo  = yf.Ticker("^AXJO").history(period="5d")
        if not xjoa.empty and not xjo.empty:
            adv = float(xjoa["Close"].iloc[-1])
            idx = float(xjo["Close"].iloc[-1])
            # Proxy: if accumulation index outpaces price index, breadth is positive
            adv_ratio = round(adv / idx, 4) if idx > 0 else None
            macro_data["advance_decline_ratio"] = adv_ratio
        else:
            macro_data["advance_decline_ratio"] = None
    except Exception:
        macro_data["advance_decline_ratio"] = None

    return jsonify(macro_data)


@app.route("/api/rba-rate")
def rba_rate():
    """
    Fetch the current RBA cash rate target from the RBA website.
    Falls back to DB cache, then to a user‑set value from frontend
    settings (passed via query param), and finally to 4.35.
    """
    CACHE_KEY = "rba_cash_rate"
    CACHE_DATE_KEY = "rba_cash_rate_date"
    today = datetime.now().strftime("%Y-%m-%d")

    # 1. Try live fetch with improved pattern matching
    rate = None
    source = "live"

    try:
        import urllib.request
        import re

        url = "https://www.rba.gov.au/statistics/cash-rate/"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"})
        with urllib.request.urlopen(req, timeout=8) as resp:
            html = resp.read().decode("utf-8", errors="ignore")

        # Pattern 1: look for "Cash Rate Target" followed by the number
        # Allows any characters (including HTML tags) in between
        m = re.search(r"Cash\s+Rate\s+Target[^0-9]*(\d+\.\d+)\s*%", html, re.IGNORECASE | re.DOTALL)
        if not m:
            # Pattern 2: look for a table cell that contains a percentage
            # Many RBA tables have the rate inside a <td> element
            m = re.search(r'<td[^>]*>\s*(\d+\.\d+)\s*%\s*</td>', html)

        if m:
            rate = float(m.group(1))
            # Sanity check – rates are usually between 0 and 10
            if not (0 <= rate <= 10):
                rate = None
                source = "live-failed"
            else:
                source = "live-rba"
    except Exception as e:
        print(f"RBA live fetch error: {e}")

    # 2. If live succeeded, update cache and return
    if rate is not None:
        with get_db() as conn:
            conn.execute("INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                         (CACHE_KEY, json.dumps(rate)))
            conn.execute("INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                         (CACHE_DATE_KEY, json.dumps(today)))
        return jsonify({"rate": rate, "source": source, "date": today})

    # 3. Fallback to DB cache (only if it exists and is less than 7 days old)
    with get_db() as conn:
        row = conn.execute("SELECT value, updated_at FROM blob_store WHERE key=?", (CACHE_KEY,)).fetchone()
        date_row = conn.execute("SELECT value FROM blob_store WHERE key=?", (CACHE_DATE_KEY,)).fetchone()
        if row and date_row:
            try:
                cached_rate = json.loads(row["value"])
                cached_date = json.loads(date_row["value"])
                # Consider cache stale after 7 days
                if (datetime.now() - datetime.strptime(cached_date, "%Y-%m-%d")).days < 7:
                    return jsonify({"rate": cached_rate, "source": "cached", "date": cached_date})
            except:
                pass

    # 4. Fallback to user's manually set rate (passed as query param from frontend)
    user_rate = request.args.get("user_rate")
    if user_rate:
        try:
            manual_rate = float(user_rate)
            if 0 <= manual_rate <= 10:
                return jsonify({"rate": manual_rate, "source": "user-settings", "date": today})
        except:
            pass

    # 5. Ultimate fallback – 4.35 (current rate as of May 2026)
    return jsonify({"rate": 4.35, "source": "fallback", "date": today})


# ── Prediction Markets (Manifold Markets) ─────────────────────────────────────
#
# Switched from Polymarket gamma API (broken keyword search, stale 2024 data)
# to Manifold Markets (https://docs.manifold.markets/api) which has current
# 2026 macro markets and reliable binary probability responses.
#
# Each query searches for the best open binary (cpmm-1) market and returns its
# crowd-sourced probability and volume so the AI can factor them into macro view.

_PM_QUERIES = [
    {
        "id": "rba_cut", "label": "RBA Rate Cut 2026", "positive_for_asx": True,
        "term": "RBA rate cut 2026",
        "required_terms": ["rba", "reserve bank", "cash rate"],
    },
    {
        "id": "fed_cut", "label": "Fed Rate Cut 2026", "positive_for_asx": True,
        "term": "Federal Reserve interest rate cut 2026",
        "required_terms": ["federal reserve", "fed", "fomc", "interest rate"],
    },
    {
        "id": "us_recession", "label": "US Recession 2026", "positive_for_asx": False,
        "term": "US recession 2026",
        "required_terms": ["recession", "gdp"],
    },
    {
        "id": "aud_usd", "label": "AUD/USD strength 2026", "positive_for_asx": None,
        "term": "AUD USD Australian dollar 2026",
        "required_terms": ["aud", "australian dollar", "aud/usd", "aussie"],
    },
    {
        "id": "china_gdp", "label": "China GDP target 2026", "positive_for_asx": True,
        "term": "China GDP growth 2026",
        "required_terms": ["china", "chinese", "gdp"],
    },
    {
        "id": "sp500", "label": "S&P 500 2026", "positive_for_asx": True,
        "term": "S&P 500 all-time high 2026",
        "required_terms": ["s&p", "sp500", "s&p 500", "stock market"],
    },
]

_PM_CACHE: dict = {"data": None, "fetched_at": 0.0}  # invalidated on server restart
_PM_CACHE_TTL = 1800  # 30 minutes

_MANIFOLD_HDR = {"User-Agent": "SlothASXTrader/1.0", "Accept": "application/json"}


def _fetch_manifold_market(query: dict, req_mod) -> dict:
    """Fetch the best open binary market from Manifold Markets for one query."""
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
            # Binary only — skip multi-choice (cpmm-multi-1) and numeric (pseudo-numeric)
            if m.get("mechanism") != "cpmm-1":
                continue
            # Must be open
            if m.get("isResolved") or m.get("closeTime", 0) < 1:
                continue
            # Relevance guard
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
                from datetime import timezone
                entry["end_date"] = datetime.fromtimestamp(close_ts / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            entry["url"] = m.get("url", "")
            break
    except Exception as exc:
        entry["error"] = str(exc)
    return entry


@app.route("/api/polymarket")
def polymarket_markets():
    """Return macro prediction market probabilities from Manifold Markets.

    The route name is kept as /api/polymarket for frontend compatibility.
    Source switched from Polymarket gamma API (broken keyword search) to
    Manifold Markets which has current 2026 economic questions.
    Caches results 30 minutes.
    """
    import time as _time

    now = _time.time()
    if _PM_CACHE["data"] and (now - _PM_CACHE["fetched_at"]) < _PM_CACHE_TTL:
        cached = dict(_PM_CACHE["data"])
        cached["cached"] = True
        return jsonify(cached)

    import requests as _req

    markets_out = [_fetch_manifold_market(q, _req) for q in _PM_QUERIES]

    result = {
        "markets":    markets_out,
        "fetched_at": datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "cached":     False,
        "source":     "manifold",
    }
    _PM_CACHE["data"]       = result
    _PM_CACHE["fetched_at"] = now
    return jsonify(result)


# ── ASX Dividend Scraper ──────────────────────────────────────────────────────

_ASX_DIV_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
    "Referer": "https://www.asx.com.au/markets/trade-our-cash-market/dividend-search",
}
_DIV_CACHE_TTL_HOURS = 12

# Hardcoded franking % for the most common ASX tickers.
# Used as fallback when the ASX scrape is unavailable.
# Banks/financials: 100%; REITs/infrastructure: 0%; miners: varies.
_FRANKING_MAP: dict[str, float] = {
    # Banks
    "CBA": 100.0, "NAB": 100.0, "WBC": 100.0, "ANZ": 100.0, "MQG": 45.0,
    "BOQ": 100.0, "BEN": 100.0, "SUN": 100.0, "IAG": 100.0, "QBE": 0.0,
    # Big miners
    "BHP": 100.0, "RIO": 0.0, "FMG": 100.0, "MIN": 100.0, "S32": 0.0,
    "WDS": 0.0, "STO": 0.0, "WHC": 100.0, "NHC": 100.0,
    # Industrials / consumer
    "WES": 100.0, "WOW": 100.0, "COL": 100.0, "JBH": 100.0, "HVN": 100.0,
    "NCK": 100.0, "SUL": 100.0, "LOV": 100.0, "DMP": 100.0,
    # Healthcare
    "CSL": 15.0, "RHC": 100.0, "SHL": 100.0, "ANN": 0.0, "COH": 100.0,
    # REITs / Infrastructure (0% franked — pass-through trusts)
    "GMG": 0.0, "SCG": 0.0, "GPT": 0.0, "VCX": 0.0, "CHC": 0.0,
    "DXS": 0.0, "CQR": 0.0, "HMC": 0.0, "MGR": 0.0, "BWP": 0.0,
    "NSR": 0.0, "CLW": 0.0, "GDF": 0.0, "URW": 0.0,
    # Infrastructure / Utilities
    "TCL": 0.0, "APA": 0.0, "SKI": 0.0, "ALX": 0.0,
    "AGL": 100.0, "ORG": 100.0, "ALD": 100.0,
    # Tech
    "WTC": 0.0, "XRO": 0.0, "CPU": 30.0, "NXT": 0.0, "TYR": 0.0,
    # Telcos
    "TLS": 100.0, "TPG": 0.0, "SPK": 0.0,
    # ETFs (0% — pass-through)
    "VAS": 0.0, "VHY": 0.0, "VLC": 0.0, "VGS": 0.0, "VDHG": 0.0,
    "NDQ": 0.0, "IVV": 0.0, "STW": 0.0, "IOZ": 0.0, "A200": 0.0,
    # Other
    "ALL": 100.0, "REH": 0.0, "RWC": 0.0, "BXB": 0.0, "AMC": 0.0,
    "ALQ": 100.0, "GWA": 100.0, "IPH": 100.0, "IEL": 100.0, "EML": 0.0,
}


def _get_cached_dividends(ticker: str) -> dict | None:
    """Return cached dividend data if still fresh, else None."""
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT data, expires_at FROM dividend_cache WHERE ticker=?",
                (ticker.upper(),)
            ).fetchone()
            if row and row["expires_at"] > datetime.now().isoformat():
                return json.loads(row["data"])
    except Exception:
        pass
    return None


def _set_cached_dividends(ticker: str, data: dict, source: str):
    expires = (datetime.now() + timedelta(hours=_DIV_CACHE_TTL_HOURS)).isoformat()
    try:
        with get_db() as conn:
            conn.execute(
                """INSERT OR REPLACE INTO dividend_cache (ticker, data, source, fetched_at, expires_at)
                   VALUES (?, ?, ?, datetime('now','localtime'), ?)""",
                (ticker.upper(), json.dumps(data), source, expires)
            )
    except Exception:
        pass


def scrape_asx_dividends(ticker: str) -> list[dict]:
    """
    Scrape dividend history from the ASX dividend-search iframe endpoint:
      https://www.asx.com.au/asx/v2/markets/dividends.do
    Returns list sorted by ex_date descending.
    Each record: {ex_date, payable_date, record_date, amount, franking_pct,
                  dividend_type, currency, comments}
    """
    from bs4 import BeautifulSoup

    code = ticker.upper().replace(".AX", "")
    resp = requests.get(
        "https://www.asx.com.au/asx/v2/markets/dividends.do",
        params={"by": "asxCodes", "asxCodes": code, "view": "all"},
        headers=_ASX_DIV_HEADERS,
        timeout=4,   # fail fast — ASX endpoint is unreliable; yfinance is the primary source
    )
    resp.raise_for_status()

    soup = BeautifulSoup(resp.text, "html.parser")
    table = soup.find("table")
    if not table:
        return []

    results = []
    for row in table.find_all("tr")[1:]:   # skip header row
        cells = [td.get_text(strip=True) for td in row.find_all(["th", "td"])]
        if len(cells) < 8:
            continue
        row_code, _, amount_raw, ex_raw, record_raw, payable_raw, franking_raw, div_type = cells[:8]
        comments = cells[8] if len(cells) > 8 else ""

        # Only keep rows that match our ticker (strip * latest-dividend marker)
        if row_code.upper().rstrip("*") != code:
            continue

        # Amount: "260c" → 2.60, "91.9273c" → 0.919273 (cents → dollars)
        amount = None
        amount_str = amount_raw.lower().replace(",", "").strip()
        try:
            if amount_str.endswith("c"):
                amount = round(float(amount_str[:-1]) / 100, 4)
            else:
                amount = round(float(amount_str), 4)
        except ValueError:
            pass

        # Dates: DD/MM/YYYY → YYYY-MM-DD
        def _parse_date(s: str) -> str | None:
            s = s.strip()
            if not s:
                return None
            try:
                return datetime.strptime(s, "%d/%m/%Y").strftime("%Y-%m-%d")
            except ValueError:
                return None

        ex_date      = _parse_date(ex_raw)
        record_date  = _parse_date(record_raw)
        payable_date = _parse_date(payable_raw)
        if not ex_date:
            continue

        # Franking: "100%" → 100.0
        franking = 0.0
        try:
            franking = round(float(franking_raw.replace("%", "").strip()), 1)
        except ValueError:
            pass

        # Infer currency from comments (BHP pays in USD)
        currency = "AUD"
        comments_upper = comments.upper()
        if "USD" in comments_upper:
            currency = "USD"
        elif "GBP" in comments_upper:
            currency = "GBP"

        results.append({
            "ex_date":       ex_date,
            "payable_date":  payable_date,
            "record_date":   record_date,
            "amount":        amount,
            "franking_pct":  franking,
            "dividend_type": div_type.strip() or "Ordinary",
            "currency":      currency,
            "comments":      comments.strip(),
        })

    results.sort(key=lambda x: x["ex_date"], reverse=True)
    return results


def _infer_frequency(history: list[dict]) -> tuple[int | None, str]:
    """Infer payment frequency from ex_date gaps."""
    if len(history) < 2:
        return None, "Unknown"
    dates = sorted([h["ex_date"] for h in history if h.get("ex_date")])
    gaps = []
    for i in range(1, min(len(dates), 6)):
        try:
            d1 = datetime.strptime(dates[-i], "%Y-%m-%d")
            d2 = datetime.strptime(dates[-i-1], "%Y-%m-%d")
            gaps.append((d1 - d2).days)
        except ValueError:
            pass
    if not gaps:
        return None, "Unknown"
    avg = sum(gaps) / len(gaps)
    if avg < 50:    return 12, "Monthly"
    if avg < 110:   return 4,  "Quarterly"
    if avg < 200:   return 2,  "Semi-annual"
    return 1, "Annual"


def _build_dividend_response(ticker: str, asx_history: list[dict], yf_info: dict) -> dict:
    """
    Merge ASX dividend history (primary) with yfinance metadata (secondary).
    ASX provides: exact dates, amounts, franking %.
    yfinance provides: forward yield, payout ratio, 5yr avg yield.
    """
    code = ticker.upper().replace(".AX", "")
    frequency, freq_label = _infer_frequency(asx_history)

    # Next payment estimate: average of last 2 ordinary dividends
    ordinary = [h for h in asx_history if "special" not in h.get("dividend_type", "").lower()]
    next_est = None
    if ordinary:
        last_2_amounts = [h["amount"] for h in ordinary[:2] if h.get("amount") is not None]
        if last_2_amounts:
            next_est = round(sum(last_2_amounts) / len(last_2_amounts), 4)

    # Annual div per share from history (last full year of ordinary payments)
    annual_div = yf_info.get("dividendRate")
    if not annual_div and next_est and frequency:
        annual_div = round(next_est * frequency, 4)
    if not annual_div and ordinary:
        one_year_ago = (datetime.now() - timedelta(days=370)).strftime("%Y-%m-%d")
        ttm = [h["amount"] for h in ordinary if h["ex_date"] >= one_year_ago and h.get("amount")]
        if ttm:
            annual_div = round(sum(ttm), 4)

    # Average franking % across recent history
    recent_franking = [h["franking_pct"] for h in asx_history[:6] if h.get("franking_pct") is not None]
    avg_franking = round(sum(recent_franking) / len(recent_franking), 1) if recent_franking else 0.0

    # Upcoming ex-div date: first future date in history
    today_str = datetime.now().strftime("%Y-%m-%d")
    upcoming = next(
        (h for h in sorted(asx_history, key=lambda x: x["ex_date"])
         if h["ex_date"] >= today_str),
        None
    )
    ex_date_str  = upcoming["ex_date"]     if upcoming else (asx_history[0]["ex_date"] if asx_history else None)
    pay_date_str = upcoming["payable_date"] if upcoming else None

    # Format history for frontend (last 12 payments)
    history = [
        {
            "date":          h["ex_date"],
            "amount":        h["amount"],
            "franking_pct":  h["franking_pct"],
            "dividend_type": h["dividend_type"],
            "payable_date":  h["payable_date"],
        }
        for h in asx_history[:12]
        if h.get("amount") is not None
    ]

    # yfinance changed its convention: older versions returned a decimal (e.g. 0.0316
    # for 3.16%), newer versions return a percentage (e.g. 3.16).  Normalise to decimal.
    def _norm_yield(v: float | None) -> float | None:
        if v is None:
            return None
        return round(v / 100.0, 6) if v > 1.0 else round(v, 6)

    div_yield    = _norm_yield(safe_float(yf_info.get("dividendYield")))
    payout_ratio = safe_float(yf_info.get("payoutRatio"))
    five_yr      = _norm_yield(safe_float(yf_info.get("fiveYearAvgDividendYield")))

    return {
        "ticker":            code,
        "dividendYield":     div_yield,
        "dividendRate":      safe_float(yf_info.get("dividendRate")),
        "annualDivPerShare": annual_div,
        "payoutRatio":       payout_ratio,
        "fiveYearAvgYield":  five_yr,
        "exDividendDate":    ex_date_str,
        "paymentDate":       pay_date_str,
        "frequency":         frequency,
        "frequencyLabel":    freq_label,
        "nextEstAmount":     next_est,
        "frankingPct":       avg_franking,
        "history":           history,
        "source":            "asx+yfinance",
    }


def _yf_info_safe(ticker: str) -> dict:
    """Fetch yfinance .info silently, return {} on any error."""
    try:
        return yf.Ticker(asx(ticker)).info or {}
    except Exception:
        return {}


def _fetch_dividends_for_ticker(code: str) -> dict:
    """
    Fetch dividend data for one ASX ticker.

    Strategy (primary → enrichment → fallback):
    1. yfinance  — primary source: history, amounts, dates, yield metadata.
                   Fast and reliable.
    2. ASX scrape — optional enrichment: franking %, exact payable date,
                   dividend type. Short timeout (4 s) so a dead endpoint
                   doesn't stall the whole batch.
    3. _FRANKING_MAP — hardcoded franking fallback when scrape unavailable.

    Returns a dict suitable for _build_dividend_response / caching.
    Never raises — returns {"error": ..., "ticker": code} on complete failure.
    """
    yf_info = _yf_info_safe(code)

    # ── Build history from yfinance ───────────────────────────────────────────
    history: list[dict] = []
    try:
        stk  = yf.Ticker(asx(code))
        divs = stk.dividends
        if not divs.empty:
            cutoff = datetime.now() - timedelta(days=3 * 365)
            for dt_raw, amt in divs.items():
                # Strip tz — yfinance returns tz-aware index (Australia/Sydney)
                dt = dt_raw.to_pydatetime().replace(tzinfo=None)
                if dt < cutoff:
                    continue
                history.append({
                    "ex_date":       dt.strftime("%Y-%m-%d"),
                    "amount":        round(float(amt), 4),
                    "franking_pct":  _FRANKING_MAP.get(code, 0.0),
                    "dividend_type": "Ordinary",
                    "payable_date":  None,
                    "record_date":   None,
                    "currency":      "AUD",
                    "comments":      "",
                })
            history.sort(key=lambda x: x["ex_date"], reverse=True)
    except Exception:
        pass  # will return empty history; still builds a valid response

    # ── Try ASX scrape as optional enrichment (franking, payable date) ────────
    try:
        asx_history = scrape_asx_dividends(code)
        if asx_history:
            # ASX data is more authoritative — use it wholesale
            result = _build_dividend_response(code, asx_history, yf_info)
            result["source"] = "asx+yfinance"
            return result
    except Exception:
        pass  # scrape failed or timed out — continue with yfinance-only data

    # ── Build response from yfinance data (with franking from _FRANKING_MAP) ──
    if not history and not yf_info:
        return {"error": "no dividend data available", "ticker": code}

    result = _build_dividend_response(code, history, yf_info)
    result["source"] = "yfinance"
    return result


@app.route("/api/dividends/<ticker>")
def dividend_info(ticker):
    """
    Returns dividend schedule, history and forward yield for an ASX ticker.
    Primary: yfinance (fast, reliable). Enriched by ASX scrape when available.
    Results cached for 12 h in dividend_cache table.
    """
    code = ticker.upper().replace(".AX", "")
    cached = _get_cached_dividends(code)
    if cached:
        return jsonify(cached)

    result = _fetch_dividends_for_ticker(code)
    if "error" not in result:
        _set_cached_dividends(code, result, result.get("source", "yfinance"))
    return jsonify(result)


@app.route("/api/dividends/batch", methods=["POST"])
def dividend_batch():
    """
    Fetch dividend info for multiple tickers in parallel.
    Body: {"tickers": [...], "force": false}
    Primary: yfinance. Enriched by ASX scrape when available.
    """
    body    = request.get_json() or {}
    tickers = body.get("tickers", [])
    force   = bool(body.get("force", False))

    def _fetch_one(t: str) -> tuple[str, dict]:
        code = t.upper().replace(".AX", "")
        if not force:
            cached = _get_cached_dividends(code)
            if cached:
                return code, cached
        result = _fetch_dividends_for_ticker(code)
        if "error" not in result:
            _set_cached_dividends(code, result, result.get("source", "yfinance"))
        return code, result

    results: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=min(len(tickers), 6)) as pool:
        for code, result in pool.map(_fetch_one, tickers):
            results[code] = result

    return jsonify(results)


@app.route("/api/dividends/cache/clear", methods=["POST"])
def dividend_cache_clear():
    """Force-expire the dividend cache for given tickers (or all if none specified)."""
    body    = request.get_json() or {}
    tickers = [t.upper().replace(".AX", "") for t in body.get("tickers", [])]
    try:
        with get_db() as conn:
            if tickers:
                placeholders = ",".join("?" * len(tickers))
                conn.execute(
                    f"DELETE FROM dividend_cache WHERE ticker IN ({placeholders})", tickers
                )
            else:
                conn.execute("DELETE FROM dividend_cache")
        return jsonify({"ok": True})
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500


@app.route("/api/cash")
def get_cash():
    """Return current cash balance from DB."""
    with get_db() as conn:
        row = conn.execute("SELECT amount, updated_at FROM cash WHERE id=1").fetchone()
        if row:
            return jsonify({"cash": row["amount"], "updatedAt": row["updated_at"]})
        return jsonify({"cash": 15000, "updatedAt": None})


@app.route("/api/cash", methods=["POST"])
def set_cash():
    """Update cash balance. Body: {"amount": 12345.67}"""
    data = request.get_json()
    amount = data.get("amount")
    if amount is None:
        return jsonify({"error": "amount required"}), 400
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO cash (id, amount, updated_at) VALUES (1, ?, datetime('now','localtime'))",
            (float(amount),)
        )
    return jsonify({"ok": True, "cash": float(amount)})


@app.route("/api/quote/<ticker>")
def quick_quote(ticker):
    """Fast current price lookup with sector."""
    t = asx(ticker)
    try:
        stk = yf.Ticker(t)
        hist = stk.history(period="2d")
        if hist.empty:
            return jsonify({"error": "No data"}), 404
        cp = hist["Close"].iloc[-1]
        prev = hist["Close"].iloc[-2] if len(hist) >= 2 else cp
        
        # Get sector using improved lookup
        sector = get_sector_for_ticker(ticker)
        
        return jsonify({
            "ticker": ticker.upper(),
            "price": round(cp, 3),
            "change": round(cp - prev, 3),
            "change_pct": round((cp / prev - 1) * 100, 2),
            "sector": sector,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ── Portfolio Risk Analytics ────────────────────────────────────────────────────

@app.route("/api/risk")
def portfolio_risk():
    """Compute portfolio risk metrics: beta, annualised volatility, Sharpe, correlation."""
    tickers_raw = request.args.get("tickers", "")
    tickers = [t.strip().upper() for t in tickers_raw.split(",") if t.strip()]
    if not tickers:
        return jsonify({"error": "tickers required"}), 400

    rf_rate = float(request.args.get("rf", 4.35)) / 100   # RBA cash rate (annual)
    benchmark = "VAS.AX"                                   # ASX 300 ETF as market proxy
    asx_tickers = [f"{t}.AX" for t in tickers]
    all_dl = list(set(asx_tickers + [benchmark]))

    try:
        raw = yf.download(all_dl, period="90d", auto_adjust=True, progress=False)
        if raw.empty:
            return jsonify({"error": "No market data returned"}), 502

        # Handle both MultiIndex (multiple tickers) and Series (single ticker)
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

            vol_ann = float(tr.std() * (252 ** 0.5) * 100)      # annualised %
            mean_d  = float(tr.mean())
            daily_rf = rf_rate / 252
            sharpe  = float((mean_d - daily_rf) / tr.std() * (252 ** 0.5)) if tr.std() > 0 else 0.0

            # Beta vs benchmark
            beta = 1.0
            if bench_ret is not None:
                aligned = pd.concat([tr, bench_ret], axis=1).dropna()
                if len(aligned) >= 10:
                    cov_mat = aligned.cov()
                    var_b   = float(aligned.iloc[:, 1].var())
                    beta    = float(cov_mat.iloc[0, 1] / var_b) if var_b > 0 else 1.0

            # 30-calendar-day return (~21 trading days)
            ret_30d = float((1 + tr.tail(21)).prod() - 1) * 100
            ret_90d = float((1 + tr).prod() - 1) * 100

            # VaR / CVaR (historical simulation, 95% confidence, daily)
            var_95  = float(tr.quantile(0.05)) * 100   # negative = daily loss %
            cvar_95 = float(tr[tr <= tr.quantile(0.05)].mean()) * 100 if len(tr[tr <= tr.quantile(0.05)]) else var_95

            # Max drawdown over the 90-day price series
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

        # Correlation matrix (portfolio tickers only, not benchmark)
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


@app.route("/api/portfolio/nav-history", methods=["POST"])
def portfolio_nav_history():
    """Reconstruct portfolio NAV over time using current share quantities."""
    data      = request.get_json() or {}
    portfolio = data.get("portfolio", [])   # [{ticker, shares}, ...]
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

        # Portfolio NAV = sum of (shares × price) per day + cash constant
        nav = pd.Series(0.0, index=closes.index)
        for t, asx_t in zip(tickers, asx_tickers):
            if asx_t in closes.columns:
                nav += closes[asx_t].fillna(0) * shares_map[t]
        nav = nav[nav > 0]
        if nav.empty:
            return jsonify({"error": "No valid price data"}), 502

        nav_with_cash = nav + cash

        # Benchmark: normalise VAS to the same starting value as the portfolio
        bench_values = None
        if benchmark in closes.columns:
            bench_ser  = closes[benchmark].reindex(nav.index).ffill()
            first_b    = bench_ser.iloc[0]
            first_nav  = nav_with_cash.iloc[0]
            bench_norm = (bench_ser / first_b) * first_nav
            bench_values = [round(float(v), 2) for v in bench_norm.values]

        values = [round(float(v), 2) for v in nav_with_cash.values]
        dates  = [d.strftime("%Y-%m-%d") for d in nav_with_cash.index]

        # Summary stats
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


# ── Market Scanner ─────────────────────────────────────────────────────────────

# Sector map for all universe tickers (used for diversification in results)
_SECTOR_MAP: dict[str, str] = {
    # Financials
    **{t: "Financials" for t in [
        "CBA","WBC","ANZ","NAB","MQG","QBE","SUN","IAG","AMP","CGF",
        "HUB","PPT","PTM","MFG","CIN","EQT","ASX","IFL","AUB","GQG",
        "NWL","APE","JHG","PDL","SFG","AFG","CCP","OFX","MRM","WGB",
    ]},
    # Materials / Mining
    **{t: "Materials" for t in [
        "BHP","RIO","FMG","S32","MIN","IGO","LYC","NST","EVN","SFR",
        "AWC","BSL","JHX","BLD","CSR","RWC","ILU","PLS","WHC","NHC",
        "YAL","CMM","RRL","PRU","SAR","OZL","MGX","SBM","WAF","RED",
        "DEG","GOR","AKE","CRN","TBN","CHN","RSG","MML","IPX","DDH",
    ]},
    # Energy
    **{t: "Energy" for t in [
        "WDS","STO","ORG","BPT","KAR","IPL","ORI","CEG","BOE","NHC",
        "WHC","YAL","CRN",
    ]},
    # Healthcare
    **{t: "Healthcare" for t in [
        "CSL","RMD","COH","SHL","PME","MSB","HCA","EHE","HLS","IDX",
        "PNV","NAN","IMB","SDR","CU6","RAH","ACL","TLX","MX1","GEN",
    ]},
    # Consumer Discretionary
    **{t: "Consumer Discretionary" for t in [
        "WES","MYR","HVN","JBH","SUL","BRG","PMV","DMP","CKF","ARB",
        "TPW","KMD","CCX","RFG","FLT","WEB","CTD","HLO","SWM","NEC",
        "SKT","VOC","CAT","ELD",
    ]},
    # Consumer Staples
    **{t: "Consumer Staples" for t in [
        "WOW","COL","TWE","A2M","CCL","GNC","UNI","BKL","AHY","SSG",
    ]},
    # REITs
    **{t: "REITs" for t in [
        "GMG","SCG","VCX","MGR","DXS","CHC","ARF","CIP","NSR","ABP",
        "BWP","HDN","CLW","GDI","HPI","360","LIC","WPR","RGN","AEF",
    ]},
    # Industrials / Infrastructure
    **{t: "Industrials" for t in [
        "TCL","AZJ","QAN","ALQ","MND","CIM","DOW","SSM","NWH","GWA",
        "LLC","LNW","PTB","ICT","SEK","REA","CAR","IEL","DGL","MMS",
        "SIQ","SRV","CLX","NWS",
    ]},
    # Technology
    **{t: "Technology" for t in [
        "WTC","XRO","APX","CPU","ALU","MP1","TNE","DTL","DUB","ADA",
        "NEA","BVS","LNW","PPS","NXT","FPH","SPZ","AI1","FCL","MFT",
    ]},
    # Communication
    **{t: "Communication" for t in [
        "TLS","TPG","REH","SXL","HTA","NWS","SKT","QMS",
    ]},
    # Utilities
    **{t: "Utilities" for t in [
        "AGL","APA","SKI","MEZ","RGY","AGR",
    ]},
}

# ASX universes by tier — ordered roughly by market cap
_ASX_UNIVERSE: dict[str, list] = {
    "asx20": [
        "CBA","BHP","WBC","ANZ","NAB","WES","CSL","RIO","WTC","MQG",
        "FMG","GMG","WOW","TLS","REA","RMD","COH","QBE","WDS","TCL",
    ],
}
# Build asx50 = asx20 + 30 more, asx100 = asx50 + 50 more, asx200 = all
_ASX_UNIVERSE["asx50"] = _ASX_UNIVERSE["asx20"] + [
    "SUN","IAG","NST","EVN","ALL","SGP","CPU","SCG","FPH","ALQ",
    "STO","COL","TWE","NXT","LLC","MIN","HVN","ILU","JHX","ORG",
    "APA","MND","ALU","VCX","AZJ","DXS","APX","S32","MGR","CHC",
]
_ASX_UNIVERSE["asx100"] = _ASX_UNIVERSE["asx50"] + [
    "IGO","LYC","XRO","SHL","BLD","CSR","RWC","SFR","AMP","CGF",
    "HUB","PPT","PTM","IFL","EQT","AUB","GQG","NWL","JBH","SUL",
    "ARB","PMV","DMP","CKF","FLT","WEB","CTD","A2M","GNC","CCL",
    "ARF","CIP","NSR","BWP","ABP","HDN","CLW","QAN","SSM","MMS",
    "SEK","CAR","IEL","DTL","TNE","NWH","GWA","MP1","SWM","NEC",
]
_ASX_UNIVERSE["asx200"] = _ASX_UNIVERSE["asx100"] + [
    "CMM","RRL","PRU","SAR","WAF","RED","WHC","NHC","YAL","PLS",
    "AKE","CRN","TBN","OZL","MGX","SBM","DEG","GOR","AWC","BSL",
    "BPT","KAR","IPL","ORI","PME","MSB","HCA","EHE","HLS","IDX",
    "PNV","NAN","IMB","SDR","MYR","BRG","TPW","KMD","CCX","RFG",
    "HLO","SXL","HTA","TPG","REH","AGL","SKI","LNW","ICT","PTB",
    "ALU","DUB","ADA","NEA","BVS","MFG","CIN","JHG","PDL","AFG",
    "CCP","ASX","MQG","GDI","HPI","360","LLC","DGL","SIQ","NWS",
    "UNI","BKL","GNC","AUB","WGB","OFX","MRM","ELD","CAT","SFG",
]

# Background scan state
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

        # Extract Close and Volume DataFrames (MultiIndex columns)
        closes_df = raw["Close"]  if "Close"  in raw.columns.get_level_values(0) else None
        volume_df = raw["Volume"] if "Volume" in raw.columns.get_level_values(0) else None

        # Extract ^AXJO closes for relative-strength scoring
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

            # Liquidity filter: avg daily turnover ($ value)
            avg_price = float(np.mean(closes[-20:]))
            avg_vol   = float(np.mean(volumes[-20:])) if len(volumes) >= 20 else 0
            adv_aud   = avg_price * avg_vol
            if adv_aud < min_adv_aud:
                continue

            scored = _score_ticker(closes, volumes, index_closes=axjo_closes)
            if scored is None:
                continue

            scored["ticker"]       = ticker
            scored["sector"]       = _SECTOR_MAP.get(ticker, "Other")
            scored["adv_aud"]      = round(adv_aud / 1_000_000, 2)  # millions
            results.append(scored)

        # Sort by score descending, then enforce max 4 per sector for diversification
        results.sort(key=lambda x: x["score"], reverse=True)

        # ── Sector stats (from ALL liquidity-passing tickers, not just top-N) ──
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
                "avg_score":   round(sum(d["scores"])   / len(d["scores"]),   1),
                "avg_ret_5d":  round(sum(d["ret_5d"])   / len(d["ret_5d"]),   2),
                "avg_ret_20d": round(sum(d["ret_20d"])  / len(d["ret_20d"]),  2),
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
                "results":        diversified,       # top-N diversified opportunities
                "all_results":    results,            # every liquid ticker scored (no cap)
                "sector_stats":   sector_stats,
                "filtered_count": len(results),
                "scanned_at":     datetime.now().strftime("%H:%M"),
            })

    except Exception as exc:
        with _scan_lock:
            _scan_state.update({"running": False, "error": str(exc), "stage": "error"})


@app.route("/api/market/scan", methods=["POST"])
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


@app.route("/api/market/scan/status")
def market_scan_status():
    with _scan_lock:
        return jsonify(dict(_scan_state))


@app.route("/api/market/scan/stop", methods=["POST"])
def market_scan_stop():
    with _scan_lock:
        _scan_state["stopped"] = True
    return jsonify({"ok": True})


# ── DB: State save/load (bulk) ──────────────────────────────────────────────────

@app.route("/api/db/save", methods=["POST"])
def db_save():
    """Save full frontend state to SQLite in one call."""
    data = request.get_json()
    with get_db() as conn:
        # --- cash ---
        if "cash" in data:
            conn.execute(
                "INSERT OR REPLACE INTO cash (id, amount, updated_at) VALUES (1, ?, datetime('now','localtime'))",
                (data["cash"],)
            )

        # --- portfolio ---
        if "portfolio" in data:
            conn.execute("DELETE FROM portfolio")
            for h in data["portfolio"]:
                conn.execute(
                    "INSERT INTO portfolio (ticker, shares, avg_price, current_price, sector) VALUES (?,?,?,?,?)",
                    (h["ticker"], h["shares"], h["avgPrice"], h["currentPrice"], h.get("sector","Other"))
                )

        # --- trade journal ---
        if "tradeJournal" in data:
            conn.execute("DELETE FROM trade_journal")
            for t in data["tradeJournal"]:
                conn.execute("""
                    INSERT INTO trade_journal
                        (date, timestamp, ticker, action, qty, entry_price, exit_price, fees, pnl, status, rec_id, rec_executed, close_date)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    t.get("date"), t.get("timestamp"), t["ticker"], t["action"],
                    t["qty"], t["entryPrice"], t.get("exitPrice"),
                    t.get("fees", 10), t.get("pnl"), t.get("status","open"),
                    t.get("recId"), 1 if t.get("recExecuted") else 0,
                    t.get("closeDate"),
                ))

        # --- rec history ---
        if "recHistory" in data:
            conn.execute("DELETE FROM rec_history")
            for r in data["recHistory"]:
                pr = r.get("priceRange", [None, None])
                conn.execute("""
                    INSERT OR REPLACE INTO rec_history
                        (id, date, ticker, action, confidence, price_range_low, price_range_high,
                         target, stop_loss, expected_profit, net_profit, executed, executed_at,
                         outcome, actual_profit, reasoning, risks, signals, learning_id)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    r["id"], r["date"], r["ticker"], r["action"],
                    r.get("confidence"), pr[0] if pr else None, pr[1] if pr else None,
                    r.get("target"), r.get("stopLoss"), r.get("expectedProfit"), r.get("netProfit"),
                    1 if r.get("executed") else 0, r.get("executedAt"),
                    r.get("outcome"), r.get("actualProfit"),
                    r.get("reasoning"), r.get("risks"),
                    json.dumps(r.get("signals", [])),
                    r.get("learningId") or r.get("_learningId"),
                ))

        # --- settings ---
        if "settings" in data:
            for k, v in data["settings"].items():
                if k == "apiKey":
                    continue  # never persist API key to disk
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                    (k, json.dumps(v))
                )

        # --- blob_store: persist arbitrary JSON state fields ---
        BLOB_KEYS = [
            'analysisConfig', 'macroData', 'macroDate', 'analysisLastSummary',
            'portfolioHistory', 'cgtParcels', 'cgtDisposals', 'cgtMethod', 'activityLog',
            'recommendations', 'priceAlerts', 'dayTrading',
        ]
        for key in BLOB_KEYS:
            if key in data:
                conn.execute(
                    "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES (?, ?, datetime('now','localtime'))",
                    (key, json.dumps(data[key]))
                )

    return jsonify({"ok": True, "saved_at": datetime.now().isoformat()})


@app.route("/api/db/load")
def db_load():
    """Load full state from SQLite."""
    with get_db() as conn:
        # cash
        cash_row = conn.execute("SELECT amount FROM cash WHERE id=1").fetchone()
        cash = cash_row["amount"] if cash_row else 15000

        # portfolio
        portfolio = []
        for row in conn.execute("SELECT * FROM portfolio ORDER BY id").fetchall():
            portfolio.append({
                "ticker": row["ticker"],
                "shares": row["shares"],
                "avgPrice": row["avg_price"],
                "currentPrice": row["current_price"],
                "sector": row["sector"],
            })

        # trade journal
        trade_journal = []
        for row in conn.execute("SELECT * FROM trade_journal ORDER BY date DESC, id DESC").fetchall():
            trade_journal.append({
                "id": row["id"],
                "date": row["date"],
                "timestamp": row["timestamp"],
                "ticker": row["ticker"],
                "action": row["action"],
                "qty": row["qty"],
                "entryPrice": row["entry_price"],
                "exitPrice": row["exit_price"],
                "fees": row["fees"],
                "pnl": row["pnl"],
                "status": row["status"],
                "recId": row["rec_id"],
                "recExecuted": bool(row["rec_executed"]),
                "closeDate": row["close_date"],
            })

        # rec history
        rec_history = []
        for row in conn.execute("SELECT * FROM rec_history ORDER BY date DESC").fetchall():
            rec_history.append({
                "id": row["id"],
                "date": row["date"],
                "ticker": row["ticker"],
                "action": row["action"],
                "confidence": row["confidence"],
                "priceRange": [row["price_range_low"], row["price_range_high"]],
                "target": row["target"],
                "stopLoss": row["stop_loss"],
                "expectedProfit": row["expected_profit"],
                "netProfit": row["net_profit"],
                "executed": bool(row["executed"]),
                "executedAt": row["executed_at"],
                "outcome": row["outcome"],
                "actualProfit": row["actual_profit"],
                "reasoning": row["reasoning"],
                "risks": row["risks"],
                "signals": json.loads(row["signals"]) if row["signals"] else [],
                "_learningId": row["learning_id"],
            })

        # settings
        settings = {}
        for row in conn.execute("SELECT key, value FROM settings").fetchall():
            try:
                settings[row["key"]] = json.loads(row["value"])
            except Exception:
                settings[row["key"]] = row["value"]

        has_data = bool(portfolio or trade_journal or rec_history or settings)

        # --- blob_store: restore all persisted JSON state fields ---
        blobs = {}
        for row in conn.execute("SELECT key, value FROM blob_store").fetchall():
            try:
                blobs[row["key"]] = json.loads(row["value"])
            except Exception:
                blobs[row["key"]] = row["value"]

    return jsonify({
        "hasData": has_data,
        "cash": cash,
        "portfolio": portfolio,
        "tradeJournal": trade_journal,
        "recHistory": rec_history,
        "settings": settings,
        "loadedAt": datetime.now().isoformat(),
        # blob fields
        "analysisConfig":       blobs.get("analysisConfig"),
        "macroData":            blobs.get("macroData"),
        "macroDate":            blobs.get("macroDate"),
        "analysisLastSummary":  blobs.get("analysisLastSummary"),
        "portfolioHistory":     blobs.get("portfolioHistory"),
        "cgtParcels":           blobs.get("cgtParcels"),
        "cgtDisposals":         blobs.get("cgtDisposals"),
        "cgtMethod":            blobs.get("cgtMethod"),
        "activityLog":          blobs.get("activityLog"),
        "recommendations":      blobs.get("recommendations"),
        "dayTrading":           blobs.get("dayTrading"),
    })


@app.route("/api/db/refresh-sectors", methods=["POST"])
def refresh_portfolio_sectors():
    """Refresh sector information for all holdings in the portfolio."""
    with get_db() as conn:
        portfolio = conn.execute("SELECT ticker FROM portfolio").fetchall()
        updated_count = 0
        
        for row in portfolio:
            ticker = row["ticker"]
            sector = get_sector_for_ticker(ticker)
            conn.execute(
                "UPDATE portfolio SET sector = ? WHERE ticker = ?",
                (sector, ticker)
            )
            updated_count += 1
    
    return jsonify({
        "ok": True,
        "updated": updated_count,
        "message": f"Updated sectors for {updated_count} holdings"
    })


@app.route("/api/db/status")
def db_status():
    """Quick check — returns row counts."""
    with get_db() as conn:
        return jsonify({
            "db": str(DB_PATH),
            "portfolio_rows": conn.execute("SELECT COUNT(*) FROM portfolio").fetchone()[0],
            "journal_rows": conn.execute("SELECT COUNT(*) FROM trade_journal").fetchone()[0],
            "rec_rows": conn.execute("SELECT COUNT(*) FROM rec_history").fetchone()[0],
        })


@app.route("/api/backtest", methods=["POST"])
def backtest():
    """
    Real backtest engine using yfinance historical data.
    Body: {
        "tickers": ["CBA", "BHP"],
        "period": "1y",          # 3mo | 6mo | 1y | 2y
        "capital": 50000,
        "strategy": "rsi_trend"  # rsi_trend | macd | bb_reversion | momentum | buy_hold
        "brokerage": 10
    }
    Returns per-trade log, equity curve, and summary stats.
    """
    data = request.get_json()
    tickers = data.get("tickers", [])
    period = data.get("period", "1y")
    starting_capital = float(data.get("capital", 50000))
    strategy = data.get("strategy", "rsi_trend")
    brokerage = float(data.get("brokerage", 10))

    if not tickers:
        return jsonify({"error": "No tickers provided"}), 400

    # Map period string to days lookback
    period_days = {"3mo": 90, "6mo": 180, "1y": 252, "2y": 504}
    lookback_days = period_days.get(period, 252)

    all_trades = []
    equity_curve = []
    ticker_results = {}

    for ticker in tickers:
        t = asx(ticker)
        try:
            stk = yf.Ticker(t)
            hist = stk.history(period=period, auto_adjust=True)
            if hist.empty or len(hist) < 50:
                ticker_results[ticker.upper()] = {"error": "Insufficient data"}
                continue

            close = hist["Close"]
            high = hist["High"]
            low = hist["Low"]
            volume = hist["Volume"]

            # ── Compute indicators for signal generation ──────────────────────
            rsi = compute_rsi(close, 14)
            macd_line, macd_signal, macd_hist = compute_macd(close)
            sma_20 = close.rolling(20).mean()
            sma_50 = close.rolling(50).mean()
            bb_upper, bb_mid, bb_lower = compute_bollinger(close)
            adx, plus_di, minus_di = compute_adx(high, low, close)
            atr = compute_atr(high, low, close)

            # ── Signal generation ─────────────────────────────────────────────
            capital_per_ticker = starting_capital / len(tickers)
            cash = capital_per_ticker
            position = 0   # shares held
            entry_price = None
            entry_date = None
            trades = []

            for i in range(50, len(close)):
                price = close.iloc[i]
                date_str = close.index[i].strftime("%Y-%m-%d")

                if strategy == "rsi_trend":
                    # Buy: RSI < 35 AND price above SMA20 AND MACD hist positive
                    buy_sig = (
                        safe_float(rsi.iloc[i], 50) < 35 and
                        price > safe_float(sma_20.iloc[i], price) and
                        safe_float(macd_hist.iloc[i], 0) > 0
                    )
                    # Sell: RSI > 65 OR price crosses below SMA20
                    sell_sig = (
                        safe_float(rsi.iloc[i], 50) > 65 or
                        price < safe_float(sma_20.iloc[i], price * 0.98)
                    )

                elif strategy == "macd":
                    # Buy: MACD crosses above signal
                    buy_sig = (
                        safe_float(macd_hist.iloc[i], 0) > 0 and
                        safe_float(macd_hist.iloc[i-1], 0) <= 0
                    )
                    # Sell: MACD crosses below signal
                    sell_sig = (
                        safe_float(macd_hist.iloc[i], 0) < 0 and
                        safe_float(macd_hist.iloc[i-1], 0) >= 0
                    )

                elif strategy == "bb_reversion":
                    # Buy: price touches lower BB and RSI < 40
                    buy_sig = (
                        price <= safe_float(bb_lower.iloc[i], price) * 1.005 and
                        safe_float(rsi.iloc[i], 50) < 40
                    )
                    # Sell: price reaches BB midline or upper band
                    sell_sig = position > 0 and price >= safe_float(bb_mid.iloc[i], price) * 0.995

                elif strategy == "momentum":
                    # Buy: ADX > 25 (strong trend), +DI > -DI, price above SMA50
                    buy_sig = (
                        safe_float(adx.iloc[i], 0) > 25 and
                        safe_float(plus_di.iloc[i], 0) > safe_float(minus_di.iloc[i], 0) and
                        price > safe_float(sma_50.iloc[i], price)
                    )
                    # Sell: ADX weakens or -DI crosses above +DI
                    sell_sig = (
                        safe_float(adx.iloc[i], 0) < 20 or
                        safe_float(minus_di.iloc[i], 0) > safe_float(plus_di.iloc[i], 0)
                    )

                elif strategy == "buy_hold":
                    # Buy on first day, never sell
                    buy_sig = position == 0 and i == 50
                    sell_sig = False

                else:
                    buy_sig = sell_sig = False

                # Execute trades
                if buy_sig and position == 0 and cash > brokerage * 2:
                    qty = int((cash - brokerage) / price)
                    if qty > 0:
                        cost = qty * price + brokerage
                        cash -= cost
                        position = qty
                        entry_price = price
                        entry_date = date_str

                elif sell_sig and position > 0:
                    proceeds = position * price - brokerage
                    pnl = proceeds - (position * entry_price) - brokerage
                    cash += proceeds
                    trades.append({
                        "ticker": ticker.upper(),
                        "entryDate": entry_date,
                        "exitDate": date_str,
                        "entryPrice": round(entry_price, 3),
                        "exitPrice": round(price, 3),
                        "qty": position,
                        "pnl": round(pnl, 2),
                        "holdDays": (hist.index[i] - hist.index[
                            next(j for j in range(i) if hist.index[j].strftime("%Y-%m-%d") == entry_date)
                        ]).days if entry_date else 0,
                    })
                    position = 0
                    entry_price = None
                    entry_date = None

            # Final value: cash + open position at last price
            final_price = close.iloc[-1]
            open_value = position * final_price if position > 0 else 0
            final_value = cash + open_value

            # If a position is still open at period end, add it as a synthetic "open" trade
            # so win/loss stats and the trade log are meaningful (especially for Buy & Hold)
            if position > 0 and entry_price and entry_date:
                open_pnl = round(position * final_price - position * entry_price - brokerage, 2)
                try:
                    entry_idx_found = next(
                        j for j in range(len(hist))
                        if hist.index[j].strftime("%Y-%m-%d") == entry_date
                    )
                    hold_days_open = (hist.index[-1] - hist.index[entry_idx_found]).days
                except StopIteration:
                    hold_days_open = 0
                trades.append({
                    "ticker": ticker.upper(),
                    "entryDate": entry_date,
                    "exitDate": "(open)",
                    "entryPrice": round(entry_price, 3),
                    "exitPrice": round(final_price, 3),
                    "qty": position,
                    "pnl": open_pnl,
                    "holdDays": hold_days_open,
                    "isOpen": True,
                })

            wins = [t for t in trades if t["pnl"] > 0]
            losses = [t for t in trades if t["pnl"] <= 0]
            closed = [t for t in trades if not t.get("isOpen")]

            ticker_results[ticker.upper()] = {
                "startCapital": round(capital_per_ticker, 2),
                "finalValue": round(final_value, 2),
                "totalReturn": round((final_value / capital_per_ticker - 1) * 100, 2),
                "totalTrades": len(trades),
                "closedTrades": len(closed),
                "wins": len(wins),
                "losses": len(losses),
                "winRate": round(len(wins) / len(trades) * 100, 1) if trades else 0,
                "totalPnl": round(sum(t["pnl"] for t in trades), 2),
                "avgWin": round(sum(t["pnl"] for t in wins) / len(wins), 2) if wins else 0,
                "avgLoss": round(sum(t["pnl"] for t in losses) / len(losses), 2) if losses else 0,
                "openPosition": position,
                "openValue": round(open_value, 2),
                "trades": trades[-20:],  # last 20 trades for display
            }
            all_trades.extend(trades)

            # Equity curve for this ticker (daily portfolio value)
            equity_for_ticker = []
            _cash = capital_per_ticker
            _pos = 0
            _ep = None
            for i in range(50, len(close)):
                price = close.iloc[i]
                date_str = close.index[i].strftime("%Y-%m-%d")
                # Same signal logic — simplified for equity curve
                rsi_v = safe_float(rsi.iloc[i], 50)
                macd_v = safe_float(macd_hist.iloc[i], 0)
                macd_prev = safe_float(macd_hist.iloc[i-1], 0)
                sma20_v = safe_float(sma_20.iloc[i], price)
                adx_v = safe_float(adx.iloc[i], 0)
                pdi_v = safe_float(plus_di.iloc[i], 0)
                mdi_v = safe_float(minus_di.iloc[i], 0)
                bb_l = safe_float(bb_lower.iloc[i], price)
                bb_m = safe_float(bb_mid.iloc[i], price)

                if strategy == "rsi_trend":
                    buy_sig = rsi_v < 35 and price > sma20_v and macd_v > 0
                    sell_sig = rsi_v > 65 or price < sma20_v * 0.98
                elif strategy == "macd":
                    buy_sig = macd_v > 0 and macd_prev <= 0
                    sell_sig = macd_v < 0 and macd_prev >= 0
                elif strategy == "bb_reversion":
                    buy_sig = price <= bb_l * 1.005 and rsi_v < 40
                    sell_sig = _pos > 0 and price >= bb_m * 0.995
                elif strategy == "momentum":
                    buy_sig = adx_v > 25 and pdi_v > mdi_v and price > safe_float(sma_50.iloc[i], price)
                    sell_sig = adx_v < 20 or mdi_v > pdi_v
                elif strategy == "buy_hold":
                    buy_sig = _pos == 0 and i == 50
                    sell_sig = False
                else:
                    buy_sig = sell_sig = False

                if buy_sig and _pos == 0 and _cash > brokerage * 2:
                    qty = int((_cash - brokerage) / price)
                    if qty > 0:
                        _cash -= qty * price + brokerage
                        _pos = qty
                        _ep = price
                elif sell_sig and _pos > 0:
                    _cash += _pos * price - brokerage
                    _pos = 0
                    _ep = None

                equity_for_ticker.append({"date": date_str, "value": round(_cash + _pos * price, 2)})

            if equity_for_ticker:
                equity_curve.append({"ticker": ticker.upper(), "curve": equity_for_ticker})

        except Exception as e:
            ticker_results[ticker.upper()] = {"error": str(e)}

    # Aggregate stats
    all_wins = [t for t in all_trades if t["pnl"] > 0]
    all_losses = [t for t in all_trades if t["pnl"] <= 0]
    total_pnl = sum(t["pnl"] for t in all_trades)
    total_return = sum(
        v.get("totalReturn", 0) for v in ticker_results.values() if "totalReturn" in v
    ) / max(len([v for v in ticker_results.values() if "totalReturn" in v]), 1)

    # Sharpe ratio (annualised, using daily equity curve if available)
    sharpe = None
    try:
        if equity_curve:
            combined = {}
            for tc in equity_curve:
                for pt in tc["curve"]:
                    combined[pt["date"]] = combined.get(pt["date"], 0) + pt["value"]
            dates = sorted(combined.keys())
            values = [combined[d] for d in dates]
            daily_rets = [(values[i] / values[i-1] - 1) for i in range(1, len(values))]
            if len(daily_rets) > 10:
                import statistics
                mean_r = statistics.mean(daily_rets)
                std_r = statistics.stdev(daily_rets)
                risk_free_daily = 0.041 / 252  # approximate RBA rate
                sharpe = round((mean_r - risk_free_daily) / std_r * math.sqrt(252), 2) if std_r > 0 else None
    except Exception:
        pass

    # Max drawdown from combined equity curve
    max_dd = None
    try:
        if equity_curve:
            combined_vals = list(combined.values())
            peak = combined_vals[0]
            max_dd_val = 0
            for v in combined_vals:
                if v > peak: peak = v
                dd = (v - peak) / peak * 100
                if dd < max_dd_val: max_dd_val = dd
            max_dd = round(max_dd_val, 2)
    except Exception:
        pass

    return jsonify({
        "strategy": strategy,
        "period": period,
        "startingCapital": starting_capital,
        "totalReturn": round(total_return, 2),
        "totalPnl": round(total_pnl, 2),
        "totalTrades": len(all_trades),
        "winRate": round(len(all_wins) / len(all_trades) * 100, 1) if all_trades else 0,
        "avgWin": round(sum(t["pnl"] for t in all_wins) / len(all_wins), 2) if all_wins else 0,
        "avgLoss": round(sum(t["pnl"] for t in all_losses) / len(all_losses), 2) if all_losses else 0,
        "profitFactor": round(abs(sum(t["pnl"] for t in all_wins) / sum(t["pnl"] for t in all_losses)), 2)
            if all_losses and sum(t["pnl"] for t in all_losses) != 0 else None,
        "sharpe": sharpe,
        "maxDrawdown": max_dd,
        "tickers": ticker_results,
        "equityCurve": equity_curve,
    })


# ── AI Recommendation Replay ───────────────────────────────────────────────────
@app.route("/api/backtest/ai-replay", methods=["POST"])
def backtest_ai_replay():
    """
    Measures forward price movement for each executed AI recommendation.
    Body: {
      "trades": [{
        "ticker": "CBA", "action": "BUY", "date": "15-06-2024",
        "executedPrice": 118.50, "priceMid": 119.0,
        "confidence": 0.82, "qty": 50
      }, ...],
      "horizon": "1mo",   # 1w | 2w | 1mo | 3mo
      "brokerage": 10
    }
    Returns: hit rate, avg return, by-confidence, by-action, trade log, equity curve.
    """
    import datetime as _dt

    data       = request.get_json() or {}
    trades_in  = data.get("trades", [])
    horizon    = data.get("horizon", "1mo")
    brokerage  = float(data.get("brokerage", 10))

    horizon_days = {"1w": 7, "2w": 14, "1mo": 30, "3mo": 90}
    days = horizon_days.get(horizon, 30)

    results = []

    for trade in trades_in:
        ticker     = (trade.get("ticker") or "").upper()
        action     = (trade.get("action") or "").upper()
        date_str      = trade.get("date") or ""   # DD-MM-YYYY
        exec_price    = trade.get("executedPrice")
        price_mid     = trade.get("priceMid")
        confidence    = float(trade.get("confidence") or 0)
        qty           = int(trade.get("executedQty") or trade.get("qty") or 0)
        actual_profit = trade.get("actualProfit")   # pre-computed realized P&L from Trade Journal

        if not ticker or not date_str or action in ("HOLD", "WATCH"):
            continue

        # Parse DD-MM-YYYY
        try:
            parts = date_str.split("-")
            entry_date = _dt.date(int(parts[2]), int(parts[1]), int(parts[0]))
        except Exception:
            results.append({"ticker": ticker, "action": action, "entryDate": date_str,
                            "note": "invalid date", "isHit": None})
            continue

        # Fetch price history from entry date onward + buffer
        t_sym = asx(ticker)
        try:
            stk  = yf.Ticker(t_sym)
            start = (entry_date - _dt.timedelta(days=5)).strftime("%Y-%m-%d")
            end   = (entry_date + _dt.timedelta(days=days + 15)).strftime("%Y-%m-%d")
            hist  = stk.history(start=start, end=end, auto_adjust=True)
            if hist.empty:
                results.append({"ticker": ticker, "action": action, "entryDate": date_str,
                                "note": "no price data", "isHit": None})
                continue
        except Exception as e:
            results.append({"ticker": ticker, "action": action, "entryDate": date_str,
                            "note": str(e)[:60], "isHit": None})
            continue

        close = hist["Close"]
        dates = [d.date() for d in hist.index]

        # First trading day on/after entry_date
        entry_idx = next((i for i, d in enumerate(dates) if d >= entry_date), None)
        if entry_idx is None:
            results.append({"ticker": ticker, "action": action, "entryDate": date_str,
                            "note": "entry date after data", "isHit": None})
            continue

        # Use executedPrice if available, else priceMid, else actual close
        actual_entry = float(exec_price or price_mid or close.iloc[entry_idx])

        # First trading day on/after entry_date + horizon
        target_exit_date = entry_date + _dt.timedelta(days=days)
        exit_idx = next((i for i, d in enumerate(dates) if d >= target_exit_date), len(dates) - 1)
        exit_price = float(close.iloc[exit_idx])
        exit_date  = dates[exit_idx].strftime("%Y-%m-%d")

        # Was data available at full horizon?
        full_horizon = dates[exit_idx] >= target_exit_date
        note = "" if full_horizon else f"only {(dates[exit_idx] - entry_date).days}d data"

        price_chg_pct = (exit_price - actual_entry) / actual_entry * 100

        # Hit logic:
        #   BUY / TOP_UP  → price should rise → hit if exit > entry
        #   SELL / TRIM   → price should fall → hit if exit < entry
        if action in ("BUY", "TOP_UP"):
            is_hit = exit_price > actual_entry
        elif action in ("SELL", "TRIM"):
            is_hit = exit_price < actual_entry
            price_chg_pct = -price_chg_pct   # positive = saved money by selling before drop
        else:
            is_hit = None

        # P&L resolution — priority:
        #   1. actual_profit from Trade Journal (exact realized P&L for SELL/TRIM)
        #   2. computed from qty × price delta (BUY/TOP_UP unrealized, or SELL/TRIM fallback)
        #   3. None (qty unknown)
        pnl = None
        pnl_source = "none"

        if actual_profit is not None and action in ("SELL", "TRIM"):
            # Use the exact realized P&L already computed at execution time
            pnl = round(float(actual_profit), 2)
            pnl_source = "realized"
        elif qty > 0:
            if action in ("BUY", "TOP_UP"):
                # Unrealized: current/horizon price vs entry price
                pnl = round((exit_price - actual_entry) * qty - brokerage * 2, 2)
                pnl_source = "unrealized"
            elif action in ("SELL", "TRIM"):
                # Fallback: compute from price movement (less accurate — no avg cost basis)
                pnl = round((actual_entry - exit_price) * qty - brokerage, 2)
                pnl_source = "estimated"

        results.append({
            "ticker":         ticker,
            "action":         action,
            "entryDate":      entry_date.strftime("%Y-%m-%d"),
            "exitDate":       exit_date,
            "entryPrice":     round(actual_entry, 3),
            "exitPrice":      round(exit_price, 3),
            "priceChangePct": round(price_chg_pct, 2),
            "pnl":            pnl,
            "pnlSource":      pnl_source,   # "realized" | "unrealized" | "estimated" | "none"
            "isHit":          is_hit,
            "confidence":     confidence,
            "qty":            qty,
            "note":           note,
        })

    # ── Aggregate stats ────────────────────────────────────────────────────────
    scored       = [r for r in results if r.get("isHit") is not None]
    hits         = [r for r in scored if r["isHit"]]
    partial_data = [r for r in scored if r.get("note", "").startswith("only")]  # fewer days than horizon
    full_data    = [r for r in scored if not r.get("note", "").startswith("only")]

    hit_rate    = round(len(hits) / len(scored) * 100, 1) if scored else 0
    avg_return  = round(sum(r["priceChangePct"] for r in scored) / len(scored), 2) if scored else 0
    # Use full-horizon trades for avg return when available (partial = exit is today, not at horizon)
    avg_return_full = round(sum(r["priceChangePct"] for r in full_data) / len(full_data), 2) if full_data else None

    wins_ret   = [r["priceChangePct"] for r in scored if r["priceChangePct"] > 0]
    losses_ret = [r["priceChangePct"] for r in scored if r["priceChangePct"] <= 0]
    avg_win    = round(sum(wins_ret) / len(wins_ret), 2) if wins_ret else None
    avg_loss   = round(sum(losses_ret) / len(losses_ret), 2) if losses_ret else None

    # P&L: split by source for transparency
    realized_pnl   = round(sum(r["pnl"] for r in results if r.get("pnlSource") == "realized"), 2)
    unrealized_pnl = round(sum(r["pnl"] for r in results if r.get("pnlSource") in ("unrealized", "estimated")), 2)
    net_pnl        = round(sum(r["pnl"] for r in results if r.get("pnl") is not None), 2)
    has_pnl        = any(r.get("pnl") is not None for r in results)
    realized_count = sum(1 for r in results if r.get("pnlSource") == "realized")
    open_count     = sum(1 for r in results if r.get("pnlSource") in ("unrealized", "estimated"))

    # By confidence band
    bands = [
        ("High (≥80%)",    lambda r: r["confidence"] >= 0.80),
        ("Medium (60-79%)", lambda r: 0.60 <= r["confidence"] < 0.80),
        ("Low (<60%)",     lambda r: r["confidence"] < 0.60),
    ]
    by_confidence = []
    for label, fn in bands:
        group = [r for r in scored if fn(r)]
        if group:
            by_confidence.append({
                "label":     label,
                "count":     len(group),
                "hitRate":   round(len([r for r in group if r["isHit"]]) / len(group) * 100, 1),
                "avgReturn": round(sum(r["priceChangePct"] for r in group) / len(group), 2),
            })

    # By action type
    action_set = sorted(set(r["action"] for r in scored))
    by_action  = []
    for act in action_set:
        group = [r for r in scored if r["action"] == act]
        by_action.append({
            "action":    act,
            "count":     len(group),
            "hitRate":   round(len([r for r in group if r["isHit"]]) / len(group) * 100, 1),
            "avgReturn": round(sum(r["priceChangePct"] for r in group) / len(group), 2),
        })

    # ── Equity curves ─────────────────────────────────────────────────────────
    # Dollar P&L curve — sorted by ENTRY date (exit date is unreliable when horizon > data available)
    # Frontend adds the starting portfolio value to convert cumulative P&L → portfolio value
    dollar_curve = []
    if has_pnl:
        cum_dollar = 0.0
        for r in sorted([r for r in results if r.get("pnl") is not None],
                        key=lambda r: r.get("entryDate", "")):
            cum_dollar = round(cum_dollar + r["pnl"], 2)
            dollar_curve.append({
                "date":      r["entryDate"],   # use entry date — meaningful even when exit = today
                "pnl":       cum_dollar,        # cumulative P&L from first trade to this one
                "ticker":    r["ticker"],
                "action":    r["action"],
            })

    return jsonify({
        "trades":          results,
        "totalTrades":     len(scored),
        "partialCount":    len(partial_data),   # trades where full horizon wasn't reached yet
        "fullCount":       len(full_data),
        # Directional accuracy metrics (did price move in predicted direction?)
        "hitRate":         hit_rate,
        "avgReturn":       avg_return,           # avg directional % (all trades, incl. partial)
        "avgReturnFull":   avg_return_full,      # avg directional % (full-horizon trades only)
        "avgWin":          avg_win,
        "avgLoss":         avg_loss,
        # Execution P&L metrics (actual money made/lost)
        "netPnl":          net_pnl if has_pnl else None,
        "realizedPnl":     realized_pnl if realized_count > 0 else None,
        "unrealizedPnl":   unrealized_pnl if open_count > 0 else None,
        "realizedCount":   realized_count,
        "openCount":       open_count,
        "hasPnl":          has_pnl,
        "byConfidence":    by_confidence,
        "byAction":        by_action,
        "equityCurve":     dollar_curve,
        "horizon":         horizon,
        "horizonDays":     days,
    })


@app.route("/api/earnings-calendar")
def earnings_calendar():
    """
    Fetch upcoming earnings dates for all portfolio tickers.
    Returns next earnings date and EPS estimates from yfinance.
    """
    tickers_param = request.args.get("tickers", "")
    tickers = [t.strip() for t in tickers_param.split(",") if t.strip()]
    if not tickers:
        return jsonify({"error": "No tickers"}), 400

    results = {}

    def _fetch_earnings(ticker):
        try:
            stk = yf.Ticker(asx(ticker))
            info = stk.info or {}

            # Next earnings date
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
                        if len(vals): next_earnings = str(vals[0])[:10]
            except Exception:
                pass

            # EPS estimates from info
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


@app.route("/api/news")
def news():
    """Collect recent news for broad market and portfolio tickers."""
    from datetime import datetime, timedelta

    # Symbols to track: ASX200, sector ETFs, plus portfolio from query or DB
    base_symbols = ["^AXJO", "XIJ.AX", "XMJ.AX", "XEJ.AX", "XHJ.AX", "XTJ.AX"]
    try:
        portfolio_tickers = request.args.get("tickers", "")
        if portfolio_tickers:
            extra = [asx(t.strip()) for t in portfolio_tickers.split(",") if t.strip()]
            base_symbols.extend(extra)
    except Exception:
        pass

    all_news = []
    cutoff = datetime.now() - timedelta(days=30)  # keep 30 days of news

    for sym in base_symbols:
        try:
            tk = yf.Ticker(sym)
            items = tk.news  # list of dicts with 'title','link','publisher','providerPublishTime'
            for item in items:
                ts = item.get("providerPublishTime")
                if ts:
                    dt = datetime.fromtimestamp(ts)
                    if dt >= cutoff:
                        all_news.append({
                            "symbol": sym.replace(".AX",""),
                            "title": item.get("title", ""),
                            "publisher": item.get("publisher", ""),
                            "timestamp": dt.isoformat(),
                            "link": item.get("link", "")
                        })
        except Exception:
            continue

    # Sort newest first and deduplicate by title
    seen = set()
    unique = []
    for n in sorted(all_news, key=lambda x: x["timestamp"], reverse=True):
        if n["title"] not in seen:
            seen.add(n["title"])
            unique.append(n)
            if len(unique) >= 80:   # limit to prevent prompt bloat
                break

    return jsonify({"news": unique, "fetchedAt": datetime.now().isoformat()})


# ── News Scanner routes ───────────────────────────────────────────────────────

def _get_sbc_mode() -> bool:
    """Return True if SBC mode is currently active."""
    try:
        with get_db() as conn:
            row = conn.execute("SELECT value FROM blob_store WHERE key='sbc_mode'").fetchone()
            if row:
                return bool(json.loads(row["value"]).get("enabled", False))
    except Exception:
        pass
    return False


def _get_gpu_info() -> dict:
    """Return cached GPU detection result (calls news_engine.detect_gpu once)."""
    if _NE_OK:
        return _ne.detect_gpu()
    return {"cuda": False, "device": None, "driver": None, "source": None}


def _news_settings_from_db() -> dict:
    """Read news scanner settings from blob_store, injecting global SBC mode.

    The cpu_mode default is auto-detected from hardware: True (CPU-only) when
    no CUDA GPU is found (e.g. Raspberry Pi 5), False when CUDA is present
    (e.g. Jetson Orin, desktop NVIDIA).  A user-saved value always wins.
    """
    gpu = _get_gpu_info()
    defaults = {
        "llm_provider":        "ollama",
        "llm_model":           "",
        "ollama_url":          "http://localhost:11434",
        "groq_api_key":        "",
        "groq_model":          "llama-3.1-8b-instant",
        "google_api_key":      "",
        "google_model":        "gemini-2.0-flash",
        "scan_interval_hours": 6,
        "enabled":             True,
        "max_age_days":        7,
        "cpu_mode":            not gpu.get("cuda", False),
        "sbc_mode":            False,
    }
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM blob_store WHERE key='news_settings'"
            ).fetchone()
            saved = json.loads(row["value"]) if row else {}
            result = {**defaults, **saved}
            # Inject global SBC mode flag (overrides per-setting value)
            sbc_row = conn.execute("SELECT value FROM blob_store WHERE key='sbc_mode'").fetchone()
            if sbc_row:
                result["sbc_mode"] = bool(json.loads(sbc_row["value"]).get("enabled", False))
            return result
    except Exception:
        pass
    return defaults


def _portfolio_tickers_from_db() -> list[str]:
    try:
        with get_db() as conn:
            rows = conn.execute("SELECT ticker FROM portfolio").fetchall()
            return [r["ticker"] for r in rows]
    except Exception:
        return []


def _ensure_news_scheduler():
    """Start scheduler if news engine available and not already running."""
    if not _NE_OK:
        return
    cfg = _news_settings_from_db()
    if not cfg.get("enabled", True):
        return
    if cfg.get("sbc_mode", False):  # SBC mode: auto-scan disabled
        return
    if not _ne._sched_thread or not _ne._sched_thread.is_alive():
        _ne.start_scheduler(
            db_path=DB_PATH,
            interval_hours=cfg.get("scan_interval_hours", 6),
            get_tickers_fn=_portfolio_tickers_from_db,
            get_settings_fn=_news_settings_from_db,
        )


@app.route("/api/news/feed")
def news_feed():
    """Return processed news items from the scanner database."""
    if not _NE_OK:
        return jsonify({"items": [], "error": "news_engine not available — check requirements.txt"})
    days    = int(request.args.get("days", 3))
    limit   = int(request.args.get("limit", 50))
    cat     = request.args.get("category", "")
    ticker  = request.args.get("ticker", "")
    senti   = request.args.get("sentiment", "")
    min_imp = float(request.args.get("min_impact", 0))

    try:
        from news_engine import news_db, init_news_tables
        cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
        with news_db(DB_PATH) as conn:
            init_news_tables(conn)
            rows = conn.execute("""
                SELECT id, url, title, source, feed_type, published_date, fetched_at,
                       content, summary, category, sentiment, sentiment_score,
                       impact_score, tickers, primary_tickers, tags, llm_model, processed, decay_weight
                FROM news_items
                WHERE published_date >= ?
                ORDER BY processed DESC,
                         (COALESCE(impact_score,0) * COALESCE(decay_weight,0.5)) DESC
                LIMIT 200
            """, (cutoff,)).fetchall()

        items = []
        for row in rows:
            r = dict(row)
            r["tickers"]         = json.loads(r.get("tickers")         or "[]")
            r["primary_tickers"] = json.loads(r.get("primary_tickers") or "[]")
            r["tags"]            = json.loads(r.get("tags")            or "[]")
            # apply filters
            if cat    and r.get("category") != cat:
                continue
            if senti  and r.get("sentiment") != senti:
                continue
            if ticker and ticker.upper() not in [t.upper() for t in r["tickers"]]:
                continue
            if (r.get("impact_score") or 0) < min_imp:
                continue
            items.append(r)

        sentiment = _ne.get_market_sentiment(DB_PATH, days=days)
        return jsonify({"items": items[:limit], "sentiment": sentiment, "total": len(items)})
    except Exception as ex:
        return jsonify({"items": [], "error": str(ex)}), 500


@app.route("/api/news/scan", methods=["POST"])
def news_scan():
    """Trigger a manual news scan."""
    if not _NE_OK:
        return jsonify({"ok": False, "error": "news_engine not available"}), 503
    data    = request.get_json() or {}
    tickers = data.get("tickers") or _portfolio_tickers_from_db()
    cfg     = _news_settings_from_db()
    result  = _ne.trigger_scan(DB_PATH, tickers, cfg)
    return jsonify(result)


@app.route("/api/news/status")
def news_status():
    """Return news scanner pipeline status."""
    if not _NE_OK:
        return jsonify({
            "available": False,
            "error": "news_engine not available — run: pip install feedparser beautifulsoup4 scikit-learn",
        })
    status = _ne.get_status()
    cfg    = _news_settings_from_db()
    try:
        with _ne.news_db(DB_PATH) as conn:
            _ne.init_news_tables(conn)
            total = conn.execute("SELECT COUNT(*) FROM news_items").fetchone()[0]
            processed = conn.execute(
                "SELECT COUNT(*) FROM news_items WHERE processed=1"
            ).fetchone()[0]
            last_log = conn.execute(
                "SELECT * FROM news_scan_log ORDER BY scan_time DESC LIMIT 1"
            ).fetchone()
    except Exception:
        total = processed = 0
        last_log = None

    return jsonify({
        "available":  True,
        "running":    status["running"],
        "progress":   status["progress"],
        "phase":      status.get("phase", "idle"),
        "last_scan":  status["last_scan"],
        "next_scan":  status["next_scan"],
        "last_result":status["last_result"],
        "total_articles": total,
        "processed_articles": processed,
        "last_log": dict(last_log) if last_log else None,
        "settings": cfg,
        "ollama_available": _ne.OllamaLLM(
            model=cfg.get("llm_model") or "",
            base_url=cfg.get("ollama_url", "http://localhost:11434"),
        ).is_available(),
        "groq_available": bool(cfg.get("groq_api_key", "")),
        # Live progress fields (populated during active scans)
        "articles_to_classify":  status.get("articles_to_classify", 0),
        "articles_classified":   status.get("articles_classified", 0),
        "articles_failed":       status.get("articles_failed", 0),
        "current_article":       status.get("current_article", ""),
        "current_article_idx":   status.get("current_article_idx", 0),
        "tokens_generated":      status.get("tokens_generated", 0),
        "tokens_per_sec":        status.get("tokens_per_sec", 0.0),
        "avg_secs_per_article":  status.get("avg_secs_per_article", 0.0),
        "elapsed_secs":          status.get("elapsed_secs", 0.0),
        "eta_secs":              status.get("eta_secs"),
        "llm_model":             status.get("llm_model", ""),
        "gpu_vram_mb":           status.get("gpu_vram_mb"),
        "errors":                status.get("errors", []),
    })


@app.route("/api/news/models")
def news_models():
    """Return available Ollama models."""
    if not _NE_OK:
        return jsonify({"models": [], "available": False})
    cfg = _news_settings_from_db()
    llm = _ne.OllamaLLM(
        model=cfg.get("llm_model") or "",
        base_url=cfg.get("ollama_url", "http://localhost:11434"),
    )
    available = llm.is_available()
    models    = llm.list_models() if available else []
    return jsonify({"models": models, "available": available})


@app.route("/api/groq/models")
def groq_models():
    """Return available Groq models using the saved API key (news or announcements)."""
    # Try news settings first, then announcements settings
    news_cfg = _news_settings_from_db()
    api_key  = news_cfg.get("groq_api_key", "")
    if not api_key:
        try:
            with get_db() as conn:
                row = conn.execute("SELECT value FROM blob_store WHERE key='ann_settings'").fetchone()
            if row:
                api_key = json.loads(row["value"]).get("groq_api_key", "")
        except Exception:
            pass
    if not api_key:
        return jsonify({"models": [], "available": False, "error": "No Groq API key saved"})
    try:
        resp = requests.get(
            "https://api.groq.com/openai/v1/models",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=10,
        )
        if not resp.ok:
            return jsonify({"models": [], "available": False, "error": f"Groq API error {resp.status_code}"})
        _exclude = ("whisper", "guard", "safeguard", "orpheus")
        models = [
            m["id"] for m in resp.json().get("data", [])
            if not any(x in m["id"].lower() for x in _exclude)
        ]
        models.sort()
        return jsonify({"models": models, "available": True})
    except Exception as exc:
        return jsonify({"models": [], "available": False, "error": str(exc)})


@app.route("/api/google/models")
def google_models():
    """Return available Gemini models using the saved Google API key."""
    if not _NE_OK:
        return jsonify({"models": [], "available": False, "error": "news_engine not available"})
    api_key = _news_settings_from_db().get("google_api_key", "")
    if not api_key:
        return jsonify({"models": [], "available": False, "error": "No Google API key saved"})
    llm = _ne.GoogleLLM(api_key=api_key)
    models = llm.list_models()
    if not models:
        return jsonify({"models": [], "available": False, "error": "Could not fetch models — check API key"})
    return jsonify({"models": [m["name"] for m in models], "available": True})


@app.route("/api/ann/gemini/models")
def ann_gemini_models():
    """Return available Gemini models using the announcements gemini_api_key."""
    try:
        with get_db() as conn:
            row = conn.execute("SELECT value FROM blob_store WHERE key='ann_settings'").fetchone()
            api_key = json.loads(row["value"]).get("gemini_api_key", "") if row else ""
    except Exception:
        api_key = ""
    if not api_key:
        return jsonify({"models": [], "available": False, "error": "No Gemini API key saved"})
    if _NE_OK:
        llm = _ne.GoogleLLM(api_key=api_key)
        models = llm.list_models()
    else:
        # Fallback: fetch directly without news_engine
        try:
            resp = requests.get(
                "https://generativelanguage.googleapis.com/v1beta/models",
                params={"key": api_key}, timeout=10,
            )
            models = [
                {"name": m["name"].replace("models/", "")}
                for m in (resp.json().get("models", []) if resp.ok else [])
                if "generateContent" in m.get("supportedGenerationMethods", [])
                and "gemini" in m["name"].lower()
            ]
        except Exception:
            models = []
    if not models:
        return jsonify({"models": [], "available": False, "error": "Could not fetch models — check API key"})
    names = [m["name"].replace("models/", "") if isinstance(m, dict) else m.replace("models/", "") for m in models]
    return jsonify({"models": names, "available": True})


@app.route("/api/news/settings", methods=["GET", "POST"])
def news_settings_route():
    """GET or update news scanner settings."""
    if request.method == "GET":
        return jsonify(_news_settings_from_db())

    data = request.get_json() or {}
    current = _news_settings_from_db()
    updated = {**current, **data}

    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) "
            "VALUES ('news_settings', ?, datetime('now','localtime'))",
            (json.dumps(updated),)
        )

    # Restart scheduler if interval or enabled changed (only if not in SBC mode)
    if _NE_OK:
        _ne.stop_scheduler()
        if updated.get("enabled", True) and not _get_sbc_mode():
            _ne.start_scheduler(
                db_path=DB_PATH,
                interval_hours=updated.get("scan_interval_hours", 6),
                get_tickers_fn=_portfolio_tickers_from_db,
                get_settings_fn=_news_settings_from_db,
            )
    return jsonify({"ok": True, "settings": updated})


@app.route("/api/sbc-mode", methods=["POST"])
def sbc_mode_route():
    """Toggle SBC mode — pauses background auto-schedulers, sets 20-min price refresh hint."""
    data    = request.get_json() or {}
    enabled = bool(data.get("enabled", False))

    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) "
            "VALUES ('sbc_mode', ?, datetime('now','localtime'))",
            (json.dumps({"enabled": enabled}),)
        )

    # Pause or resume the news scanner background scheduler
    if _NE_OK:
        if enabled:
            _ne.stop_scheduler()
        else:
            cfg = _news_settings_from_db()
            if cfg.get("enabled", True):
                _ne.start_scheduler(
                    db_path=DB_PATH,
                    interval_hours=cfg.get("scan_interval_hours", 6),
                    get_tickers_fn=_portfolio_tickers_from_db,
                    get_settings_fn=_news_settings_from_db,
                )

    return jsonify({"ok": True, "sbc_mode": enabled})


@app.route("/api/system/gpu")
def system_gpu():
    """Return cached GPU/CUDA detection result for this host."""
    return jsonify(_get_gpu_info())


@app.route("/api/ollama/start", methods=["POST"])
def ollama_start():
    """Try to launch `ollama serve` if it is not already running."""
    import subprocess, sys
    ollama_url = "http://localhost:11434"
    # Check if already up
    try:
        r = requests.get(f"{ollama_url}/api/tags", timeout=2)
        if r.ok:
            return jsonify({"ok": True, "message": "Ollama is already running"})
    except Exception:
        pass
    # Attempt to start it
    try:
        if sys.platform == "win32":
            subprocess.Popen(
                ["ollama", "serve"],
                creationflags=subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        else:
            subprocess.Popen(
                ["ollama", "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
        return jsonify({"ok": True, "message": "Ollama start command sent — wait a few seconds"})
    except FileNotFoundError:
        return jsonify({"ok": False, "error": "ollama not found in PATH — install from https://ollama.com/download"}), 404
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500


@app.route("/api/news/ollama-ps")
def news_ollama_ps():
    """Return Ollama /api/ps — running models + VRAM usage."""
    if not _NE_OK:
        return jsonify({"models": [], "available": False})
    cfg = _news_settings_from_db()
    llm = _ne.OllamaLLM(
        model=cfg.get("llm_model") or "",
        base_url=cfg.get("ollama_url", "http://localhost:11434"),
    )
    ps = llm.get_ps()
    if ps is None:
        return jsonify({"models": [], "available": False})
    return jsonify({**ps, "available": True})


# ── Re-classify existing articles with a chosen model ────────────────────────
_reclassify_status: dict = {
    "running": False, "model": "", "total": 0, "done": 0, "failed": 0,
    "tokens_per_sec": 0.0, "current_article": "",
    "eta_secs": None, "elapsed_secs": 0.0, "avg_secs": 0.0, "error": None,
}
_reclassify_stop_event = threading.Event()

def _run_reclassify(model: str, days: int):
    global _reclassify_status
    _reclassify_status.update({
        "running": True, "model": model, "done": 0, "failed": 0,
        "total": 0, "error": None, "tokens_per_sec": 0.0,
        "current_article": "", "eta_secs": None, "elapsed_secs": 0.0, "avg_secs": 0.0,
    })
    try:
        cfg      = _news_settings_from_db()
        provider = cfg.get("llm_provider", "ollama").lower()
        if provider == "groq":
            llm = _ne.GroqLLM(api_key=cfg.get("groq_api_key", ""), model=cfg.get("groq_model", ""))
        elif provider == "google":
            llm = _ne.GoogleLLM(api_key=cfg.get("google_api_key", ""), model=cfg.get("google_model", ""))
        else:
            llm = _ne.OllamaLLM(model=model, base_url=cfg.get("ollama_url", "http://localhost:11434"))
        all_tick = _portfolio_tickers_from_db()
        cutoff   = (datetime.utcnow() - timedelta(days=days)).isoformat()

        with _ne.news_db(DB_PATH) as conn:
            rows = conn.execute(
                "SELECT id, title, content, published_date FROM news_items "
                "WHERE published_date >= ? ORDER BY published_date DESC",
                (cutoff,),
            ).fetchall()

        total = len(rows)
        _reclassify_status["total"] = total
        art_times: list[float] = []
        t0 = time.time()
        _reclassify_stop_event.clear()   # reset before starting

        for idx, row in enumerate(rows):
            if _reclassify_stop_event.is_set():
                _reclassify_status["error"] = f"Stopped by user after {idx}/{total} articles"
                break

            _reclassify_status["current_article"] = (row["title"] or "")[:80]
            art_t0 = time.monotonic()
            result = llm.classify(row["title"], row["content"] or "", all_tick,
                                  status_ref=_reclassify_status)
            art_elapsed = time.monotonic() - art_t0
            art_times.append(art_elapsed)
            avg = sum(art_times) / len(art_times)
            remaining = total - (idx + 1)
            _reclassify_status.update({
                "done": idx + 1,
                "avg_secs": round(avg, 1),
                "eta_secs": round(avg * remaining),
                "elapsed_secs": round(time.time() - t0, 1),
            })

            if result:
                from news_engine import _norm_sentiment, _safe_float, compute_decay
                primary  = [t.upper() for t in (result.get("primary_tickers") or []) if isinstance(t, str)][:5]
                mentioned = [t.upper() for t in (result.get("mentioned_tickers") or result.get("tickers_mentioned") or []) if isinstance(t, str)][:15]
                all_t    = list(dict.fromkeys(primary + [t for t in mentioned if t not in primary]))
                dw       = compute_decay(row["published_date"] or "")
                with _ne.news_db(DB_PATH) as conn:
                    conn.execute("""
                        UPDATE news_items SET
                            summary=:summary, category=:category, sentiment=:sentiment,
                            sentiment_score=:score, impact_score=:impact,
                            tickers=:tickers, primary_tickers=:primary_tickers,
                            tags=:tags, llm_model=:model, decay_weight=:decay, processed=1
                        WHERE id=:id
                    """, {
                        "summary":         str(result.get("summary") or "")[:500],
                        "category":        str(result.get("category") or "other").lower()[:30],
                        "sentiment":       _norm_sentiment(result.get("sentiment")),
                        "score":           _safe_float(result.get("sentiment_score"), max_val=1.0),
                        "impact":          _safe_float(result.get("impact_score"), max_val=10.0),
                        "tickers":         json.dumps(all_t),
                        "primary_tickers": json.dumps(primary),
                        "tags":            json.dumps([str(t) for t in (result.get("tags") or []) if t][:8]),
                        "model":           model,
                        "decay":           dw,
                        "id":              row["id"],
                    })
            else:
                _reclassify_status["failed"] += 1
    except Exception as ex:
        _reclassify_status["error"] = str(ex)
    finally:
        _reclassify_status["running"]         = False
        _reclassify_status["current_article"] = ""
        _reclassify_status["eta_secs"]        = 0


@app.route("/api/news/reclassify", methods=["POST"])
def news_reclassify():
    """Re-run LLM classification on all articles in the retention window using a chosen model."""
    if not _NE_OK:
        return jsonify({"ok": False, "error": "news_engine not available"}), 503
    data     = request.get_json() or {}
    days     = int(data.get("days", 7))
    cfg      = _news_settings_from_db()
    provider = cfg.get("llm_provider", "ollama").lower()
    if provider == "groq":
        if not cfg.get("groq_api_key"):
            return jsonify({"ok": False, "error": "Groq API key not set in News Scanner settings"}), 400
        model = f"groq/{_ne.GroqLLM.GROQ_MODEL}"
    elif provider == "google":
        if not cfg.get("google_api_key"):
            return jsonify({"ok": False, "error": "Google API key not set in News Scanner settings"}), 400
        model = f"google/{cfg.get('google_model', _ne.GoogleLLM.GOOGLE_MODEL)}"
    else:
        model = data.get("model", "").strip()
        if not model:
            return jsonify({"ok": False, "error": "model is required"}), 400
    if _reclassify_status["running"]:
        return jsonify({"ok": False, "error": "Reclassification already running"}), 409
    threading.Thread(target=_run_reclassify, args=(model, days), daemon=True, name="Reclassify").start()
    return jsonify({"ok": True, "message": f"Re-classifying with {model} over last {days}d"})


@app.route("/api/news/reclassify/status")
def news_reclassify_status():
    return jsonify({**_reclassify_status})


@app.route("/api/news/reclassify/stop", methods=["POST"])
def news_reclassify_stop():
    if not _reclassify_status.get("running"):
        return jsonify({"ok": False, "error": "No reclassify job running"})
    _reclassify_stop_event.set()
    return jsonify({"ok": True, "message": "Stop signal sent — finishing current article"})


@app.route("/api/news/scan/stop", methods=["POST"])
def news_scan_stop():
    if not _NE_OK:
        return jsonify({"ok": False, "error": "news_engine not available"}), 503
    return jsonify(_ne.stop_scan())


@app.route("/api/news/brief")
def news_brief():
    """Return top-impact recent news for the AI analysis prompt."""
    if not _NE_OK:
        return jsonify({"items": []})
    tickers = request.args.get("tickers", "").split(",")
    tickers = [t.strip().upper() for t in tickers if t.strip()]
    if not tickers:
        tickers = _portfolio_tickers_from_db()
    days       = int(request.args.get("days", 2))
    limit      = int(request.args.get("limit", 15))
    max_direct = max(1, limit * 2 // 3)   # ~2/3 of limit for portfolio-direct
    max_wide   = max(1, limit - max_direct)
    items = _ne.get_news_brief(DB_PATH, tickers, days=days, max_direct=max_direct, max_wide=max_wide)
    return jsonify({"items": items})


@app.route("/api/log/ai_response", methods=["POST"])
def log_ai_response():
    """Store the raw AI analysis response for debugging and save a readable copy."""
    data = request.get_json()
    text = data.get("text", "")
    if not text:
        return jsonify({"error": "text required"}), 400

    # ── 1. Save to database (exact raw) ──────────────────────────
    key = "last_ai_raw_response"
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) "
            "VALUES (?, ?, datetime('now','localtime'))",
            (key, json.dumps(text))
        )

    # ── 2. Save a readable .txt file ─────────────────────────────
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    filename = LOG_DIR / f"ai_response_{timestamp}.txt"

    # Remove any markdown fences and escape sequences for readability
    cleaned = text.strip()
    # Remove ```json and ``` fences
    cleaned = re.sub(r"^\s*```json\s*", "", cleaned, flags=re.MULTILINE)
    cleaned = re.sub(r"\s*```\s*$", "", cleaned)
    # Convert literal \n and \uXXXX to actual characters
    # The text comes as a JSON string, so it already has actual newlines.
    # If it's double-encoded we might need to unescape, but usually it's already fine.
    # Write as-is; Python will handle encoding.
    with open(filename, "w", encoding="utf-8") as f:
        f.write(cleaned)

    return jsonify({
        "ok": True,
        "saved_to": str(filename),
        "timestamp": timestamp
    })

@app.route("/api/log/ai_response")
def get_ai_response():
    with get_db() as conn:
        row = conn.execute(
            "SELECT value, updated_at FROM blob_store WHERE key='last_ai_raw_response'"
        ).fetchone()
    if row:
        return jsonify({"text": json.loads(row["value"]), "savedAt": row["updated_at"]})
    return jsonify({"text": None})

#Check raw AI response from http://localhost:5000/api/log/ai_response





# ── Learning Loop ──────────────────────────────────────────────────────────────

@app.route("/api/learning/log", methods=["POST"])
def learning_log():
    """Log an AI recommendation event for the learning loop."""
    data = request.get_json() or {}
    try:
        with get_db() as conn:
            conn.execute("""
                INSERT INTO ai_learning_events
                    (event_type, ticker, regime, prompt_version, agent_type,
                     ai_confidence, ensemble_confidence, recommendation, rationale_summary,
                     suggested_stop, suggested_target, rr_ratio, was_executed, market_context, notes,
                     outcome_status, realized_pnl_aud, realized_pnl_pct, holding_period_days, exit_reason,
                     actual_entry_price, actual_exit_price, sector)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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


@app.route("/api/learning/outcome", methods=["POST"])
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
                        "actual_entry_price", "actual_exit_price", "sector"):
                if col in data:
                    fields.append(f"{col}=?")
                    vals.append(data[col])
            if "was_executed" in data:
                fields.append("was_executed=?")
                vals.append(1 if data["was_executed"] else 0)
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


@app.route("/api/learning/event/<int:event_id>", methods=["DELETE"])
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


@app.route("/api/learning/stats")
def learning_stats():
    """Return learning loop stats: win rates by confidence band, regime, prompt version."""
    try:
        with get_db() as conn:
            # ── Auto-expire: open events older than 120 days have no useful outcome signal ──
            conn.execute("""
                UPDATE ai_learning_events
                SET outcome_status = 'expired',
                    notes = COALESCE(notes || ' | ', '') || 'Auto-expired: no outcome after 120 days'
                WHERE outcome_status = 'open'
                  AND datetime(timestamp) < datetime('now', '-120 days')
            """)

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

            # Recent events (richer — include error_type for tagging UI)
            recent = conn.execute("""
                SELECT id, timestamp, ticker, recommendation, ai_confidence, ensemble_confidence,
                       outcome_status, realized_pnl_pct, realized_pnl_aud, regime, prompt_version,
                       was_executed, suggested_stop, suggested_target, rr_ratio,
                       holding_period_days, exit_reason, rationale_summary, error_type
                FROM ai_learning_events ORDER BY timestamp DESC LIMIT 30
            """).fetchall()

            # Failure patterns — exit_reason and error_type breakdown for closed trades
            fail_exit = conn.execute("""
                SELECT exit_reason, COUNT(*) as cnt FROM ai_learning_events
                WHERE exit_reason IS NOT NULL AND outcome_status IN ('win','loss','breakeven')
                GROUP BY exit_reason ORDER BY cnt DESC
            """).fetchall()
            fail_type = conn.execute("""
                SELECT error_type, COUNT(*) as cnt FROM ai_learning_events
                WHERE error_type IS NOT NULL
                GROUP BY error_type ORDER BY cnt DESC
            """).fetchall()
            failure_patterns = {
                "by_exit_reason": {r["exit_reason"]: r["cnt"] for r in fail_exit},
                "by_error_type":  {r["error_type"]:  r["cnt"] for r in fail_type},
            }

            # Failed tickers
            failed = conn.execute(
                "SELECT ticker, error, context, timestamp FROM failed_tickers ORDER BY id DESC LIMIT 20"
            ).fetchall()

        return jsonify({
            "total":            total,
            "closed":           closed,
            "wins":             wins,
            "overall_win_rate": round(wins / closed * 100, 1) if closed else None,
            "conf_bands":       conf_bands,
            "regime_stats":     regime_list,
            "version_stats":    version_list,
            "recent_events":    [dict(r) for r in recent],
            "failed_tickers":   [dict(r) for r in failed],
            "avg_hold_days":    avg_hold_days,
            "exit_reason_dist": exit_reason_dist,
            "rr_stats":         rr_stats,
            "failure_patterns": failure_patterns,
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/learning/calibration")
def learning_calibration():
    """Smart compact calibration block for AI prompt injection.
    Context-aware: filters by regime + sectors. Only emits statistically
    meaningful findings. Target output: ~30-60 tokens."""
    regime  = request.args.get("regime", "")
    sectors = [s.strip() for s in request.args.get("sectors", "").split(",") if s.strip()]
    days    = min(int(request.args.get("days", 60)), 90)
    cutoff  = (datetime.now() - timedelta(days=days)).isoformat()
    cutoff_30 = (datetime.now() - timedelta(days=30)).isoformat()

    try:
        with get_db() as conn:
            rows = conn.execute("""
                SELECT ai_confidence, outcome_status, regime, sector,
                       realized_pnl_pct, rr_ratio, timestamp
                FROM ai_learning_events
                WHERE timestamp >= ? AND outcome_status IN ('win','loss','breakeven')
                ORDER BY timestamp DESC LIMIT 200
            """, (cutoff,)).fetchall()

        if len(rows) < 5:
            return jsonify({"available": False, "block": None})

        n = len(rows)
        parts = []

        # 1. Confidence bands — only bands with n≥3 AND |delta|>5pp
        # adj is proportional to delta (80%), capped at ±0.15; tells Claude exactly how much to shift
        for label, lo, hi, mid in [("60-70", 0.60, 0.70, 0.65), ("70-80", 0.70, 0.80, 0.75),
                                    ("80-90", 0.80, 0.90, 0.85)]:
            subset = [r for r in rows if lo <= (r["ai_confidence"] or 0) < hi]
            if len(subset) < 3:
                continue
            wr = sum(1 for r in subset if r["outcome_status"] == "win") / len(subset)
            delta = wr - mid
            if abs(delta) > 0.05:
                adj_val = round(max(-0.15, min(0.10, delta * 0.8)), 2)
                parts.append(f"conf {label}%:{wr*100:.0f}%WR(Δ{delta*100:+.0f}pp,adj{adj_val:+.2f},n={len(subset)})")

        # 2. Current regime win rate — only if n≥3
        if regime:
            reg = [r for r in rows if r["regime"] == regime]
            if len(reg) >= 3:
                wr = sum(1 for r in reg if r["outcome_status"] == "win") / len(reg)
                warn = " ⚠AVOID" if wr < 0.40 else (" ⚠CAUTION" if wr < 0.50 else "")
                parts.append(f"{regime}:{wr*100:.0f}%W(n={len(reg)}){warn}")

        # 3. Relevant sectors — only sectors in current analysis with n≥3 AND notable rate
        for sector in sectors:
            s_rows = [r for r in rows if r["sector"] == sector]
            if len(s_rows) < 3:
                continue
            wr = sum(1 for r in s_rows if r["outcome_status"] == "win") / len(s_rows)
            if wr < 0.45:
                parts.append(f"{sector}:{wr*100:.0f}%(n={len(s_rows)}) ⚠underperform")
            elif wr > 0.72:
                parts.append(f"{sector}:{wr*100:.0f}%(n={len(s_rows)}) ✓strong")

        # 4. Strategy decay — recent 30d vs window, only if clearly decaying (delta<-15pp, n≥5)
        recent_rows = [r for r in rows if r["timestamp"] >= cutoff_30]
        if len(recent_rows) >= 5 and n >= 10:
            all_wr = sum(1 for r in rows if r["outcome_status"] == "win") / n
            rec_wr = sum(1 for r in recent_rows if r["outcome_status"] == "win") / len(recent_rows)
            if (rec_wr - all_wr) < -0.15:
                parts.append(f"⚠decay:{rec_wr*100:.0f}%recent/{all_wr*100:.0f}%all(Δ{(rec_wr-all_wr)*100:+.0f}pp)→reduce posn 30%")

        # 5. R:R accuracy — only if n≥5 high-R:R trades with clear underperformance
        hi_rr = [r for r in rows if (r["rr_ratio"] or 0) >= 2.0]
        if len(hi_rr) >= 5:
            hi_wr = sum(1 for r in hi_rr if r["outcome_status"] == "win") / len(hi_rr)
            if hi_wr < 0.50:
                parts.append(f"RR≥2.0:{hi_wr*100:.0f}%WR(n={len(hi_rr)})⚠stops/targets off→widen stops")

        if not parts:
            return jsonify({"available": False, "block": None})

        block = f"CALIBRATION({n}cls,{days}d): " + "; ".join(parts) + "."
        return jsonify({"available": True, "block": block, "sample": n})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


# ============================================================
# INTERNAL DEBATE ENGINE
# Uses a local Ollama model (e.g. qwen3:9b) to generate a
# structured bull/bear debate before Claude analyses a ticker.
# All endpoints degrade gracefully — if Ollama is not running,
# the frontend simply skips the debate step.
# ============================================================

_OLLAMA_BASE = "http://localhost:11434"


def _call_ollama(model: str, prompt: str, timeout: int = 45) -> dict:
    """
    Send a prompt to a local Ollama model via /api/generate.
    Returns {"ok": True, "text": "..."} or {"ok": False, "error": "..."}.
    Uses streaming=False so we get a single JSON response.
    """
    try:
        resp = requests.post(
            f"{_OLLAMA_BASE}/api/generate",
            json={"model": model, "prompt": prompt, "stream": False},
            timeout=timeout,
        )
        if resp.ok:
            data = resp.json()
            return {"ok": True, "text": data.get("response", "").strip()}
        return {"ok": False, "error": f"Ollama HTTP {resp.status_code}"}
    except requests.exceptions.ConnectionError:
        return {"ok": False, "error": "Ollama not running — start it with ollama serve"}
    except requests.exceptions.Timeout:
        return {"ok": False, "error": f"Ollama timeout after {timeout}s"}
    except Exception as ex:
        return {"ok": False, "error": str(ex)}


@app.route("/api/debate/status")
def debate_status():
    """
    Health check: is Ollama up and which models are pulled?
    Returns {"available": bool, "models": [...], "url": "..."}.
    """
    try:
        r = requests.get(f"{_OLLAMA_BASE}/api/tags", timeout=3)
        if r.ok:
            tags = r.json()
            models = [m["name"] for m in tags.get("models", [])]
            return jsonify({"available": True, "models": models, "url": _OLLAMA_BASE})
        return jsonify({"available": False, "models": [], "url": _OLLAMA_BASE,
                        "error": f"Ollama HTTP {r.status_code}"})
    except Exception as ex:
        return jsonify({"available": False, "models": [], "url": _OLLAMA_BASE,
                        "error": str(ex)})


@app.route("/api/debate", methods=["POST"])
def debate_bull_bear():
    """
    Generate a structured bull/bear debate for one ticker using a local model.

    Request body:
        {
          "ticker":  "BHP.AX",
          "signals": {
              "current_price": 42.50,
              "rsi_14":        28.3,
              "bb_pct_b":      0.08,
              "volume_z_score": 2.1,
              "return_60d":    -12.4,
              "obv_trend":     "rising",
              "sma_200":       38.10,
              "adx_14":        22.5,
              "atr_14":        1.20
          },
          "model":   "qwen3:9b",   // optional, default qwen3:9b
          "timeout": 45            // optional, seconds per side
        }

    Response:
        {
          "ok": true,
          "ticker": "BHP.AX",
          "model": "qwen3:9b",
          "bull": "...",
          "bear": "...",
          "elapsed_ms": 12400
        }
    """
    data      = request.get_json() or {}
    ticker    = (data.get("ticker") or "").upper()
    signals   = data.get("signals") or {}
    model     = data.get("model") or "qwen3:9b"
    tout      = min(int(data.get("timeout", 45)), 90)

    if not ticker:
        return jsonify({"ok": False, "error": "ticker required"}), 400

    # ── Format key signals for the prompt ─────────────────────────────────────
    price   = signals.get("current_price", "?")
    rsi     = signals.get("rsi_14")
    bb_pct  = signals.get("bb_pct_b")
    vol_z   = signals.get("volume_z_score")
    ret60   = signals.get("return_60d")
    obv     = signals.get("obv_trend", "?")
    sma200  = signals.get("sma_200")
    adx     = signals.get("adx_14")

    sig_text = (
        f"Ticker: {ticker} | Price: {price}"
        + (f" | RSI(14)={rsi:.1f}" if rsi is not None else "")
        + (f" | BB%b={bb_pct:.2f}" if bb_pct is not None else "")
        + (f" | VolZ={vol_z:.1f}σ" if vol_z is not None else "")
        + (f" | 60d_ret={ret60:.1f}%" if ret60 is not None else "")
        + (f" | OBV={obv}" if obv else "")
        + (f" | SMA200={sma200:.2f}" if sma200 is not None else "")
        + (f" | ADX={adx:.1f}" if adx is not None else "")
    )

    # ── Bull prompt ────────────────────────────────────────────────────────────
    bull_prompt = (
        f"You are a disciplined ASX swing trader. Given these signals:\n{sig_text}\n\n"
        "Write 2–3 concise sentences arguing FOR a long entry (bull case). "
        "Focus on mean-reversion opportunity, oversold signals, and risk/reward. "
        "Be specific to the numbers. No waffle. No markdown."
    )

    # ── Bear prompt ────────────────────────────────────────────────────────────
    bear_prompt = (
        f"You are a disciplined ASX swing trader. Given these signals:\n{sig_text}\n\n"
        "Write 2–3 concise sentences arguing AGAINST a long entry (bear case). "
        "Focus on downtrend risk, momentum, and what could go wrong. "
        "Be specific to the numbers. No waffle. No markdown."
    )

    t0 = time.time()

    # Run both sides concurrently (2 threads)
    bull_result = {}
    bear_result = {}

    def _run_bull():
        bull_result.update(_call_ollama(model, bull_prompt, timeout=tout))

    def _run_bear():
        bear_result.update(_call_ollama(model, bear_prompt, timeout=tout))

    with ThreadPoolExecutor(max_workers=2) as ex:
        fb = ex.submit(_run_bull)
        fc = ex.submit(_run_bear)
        fb.result()
        fc.result()

    elapsed_ms = int((time.time() - t0) * 1000)

    if not bull_result.get("ok") or not bear_result.get("ok"):
        err = bull_result.get("error") or bear_result.get("error") or "unknown"
        return jsonify({"ok": False, "ticker": ticker, "error": err,
                        "elapsed_ms": elapsed_ms})

    return jsonify({
        "ok":         True,
        "ticker":     ticker,
        "model":      model,
        "bull":       bull_result["text"],
        "bear":       bear_result["text"],
        "elapsed_ms": elapsed_ms,
    })


@app.route("/api/debate/postmortem", methods=["POST"])
def debate_postmortem():
    """
    Auto-tag a closed learning event with an error_type using a local model.
    The model is given the trade summary and asked to classify the failure.

    Request body:
        {
          "id":            123,           // ai_learning_events.id
          "model":         "qwen3:9b",   // optional
          "timeout":       30             // optional
        }

    Response:
        {"ok": true, "id": 123, "error_type": "overconfident", "reason": "..."}
    """
    data    = request.get_json() or {}
    ev_id   = data.get("id")
    model   = data.get("model") or "qwen3:9b"
    tout    = min(int(data.get("timeout", 30)), 60)

    if not ev_id:
        return jsonify({"ok": False, "error": "id required"}), 400

    # Load the event
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT * FROM ai_learning_events WHERE id=?", (ev_id,)
            ).fetchone()
    except Exception as ex:
        return jsonify({"ok": False, "error": str(ex)}), 500

    if not row:
        return jsonify({"ok": False, "error": "event not found"}), 404

    status = row["outcome_status"]
    if status not in ("win", "loss", "breakeven"):
        return jsonify({"ok": False, "error": f"event is '{status}', not closed"}), 400

    # Build a compact trade summary for the model
    summary = (
        f"Ticker: {row['ticker']} | Outcome: {status}"
        + (f" | PnL: {row['realized_pnl_pct']:.1f}%" if row["realized_pnl_pct"] is not None else "")
        + (f" | HoldDays: {row['holding_period_days']}" if row["holding_period_days"] is not None else "")
        + (f" | AI_conf: {row['ai_confidence']:.0%}" if row["ai_confidence"] is not None else "")
        + (f" | ExitReason: {row['exit_reason']}" if row["exit_reason"] else "")
        + (f" | Regime: {row['regime']}" if row["regime"] else "")
    )

    prompt = (
        "Classify this closed trade into exactly ONE of these error types:\n"
        "  overconfident   — stated confidence was too high vs actual outcome\n"
        "  missed_catalyst — an earnings/news event was not accounted for\n"
        "  regime_mismatch — wrong strategy for the prevailing market regime\n"
        "  poor_entry      — entry timing or price was off\n"
        "  stop_too_tight  — stopped out by normal volatility\n"
        "  none            — no clear error (winning trade or random outcome)\n\n"
        f"Trade summary: {summary}\n\n"
        "Reply with ONLY a JSON object on one line, e.g.:\n"
        '{"error_type":"overconfident","reason":"Confidence was 80% but RSI already extended"}\n'
        "No extra text."
    )

    result = _call_ollama(model, prompt, timeout=tout)
    if not result["ok"]:
        return jsonify({"ok": False, "id": ev_id, "error": result["error"]})

    # Parse model output — expect {"error_type": "...", "reason": "..."}
    raw = result["text"].strip()
    # Tolerate the model wrapping in markdown code fences
    raw = re.sub(r"^```[a-z]*\n?", "", raw)
    raw = re.sub(r"\n?```$", "", raw)
    try:
        parsed    = json.loads(raw)
        error_type = parsed.get("error_type", "")
        reason    = parsed.get("reason", "")
    except Exception:
        # If JSON parse fails, try regex extraction
        m = re.search(r'"error_type"\s*:\s*"([^"]+)"', raw)
        error_type = m.group(1) if m else ""
        m2 = re.search(r'"reason"\s*:\s*"([^"]+)"', raw)
        reason = m2.group(1) if m2 else raw[:120]

    VALID_TYPES = {"overconfident", "missed_catalyst", "regime_mismatch",
                   "poor_entry", "stop_too_tight", "none"}
    if error_type not in VALID_TYPES:
        error_type = ""  # reject hallucinated categories

    # Persist if we got something useful
    if error_type and error_type != "none":
        try:
            with get_db() as conn:
                conn.execute(
                    "UPDATE ai_learning_events SET error_type=? WHERE id=?",
                    (error_type, ev_id)
                )
        except Exception as ex:
            return jsonify({"ok": False, "error": str(ex)}), 500

    return jsonify({
        "ok":         True,
        "id":         ev_id,
        "error_type": error_type or "none",
        "reason":     reason,
        "model":      model,
    })


if __name__ == "__main__":
    print("=" * 60)
    print("  ASX Trading Assistant – Backend Server")
    print("  http://localhost:5000")
    print("  Open asx_trading.html in your browser")
    print("=" * 60)
    if _NE_OK:
        _ensure_news_scheduler()
        print("  News Scanner: enabled (4×/day via Ollama)")
    else:
        print("  News Scanner: disabled — pip install feedparser beautifulsoup4 scikit-learn")
    if _AE_OK:
        def _get_ann_tickers():
            try:
                with get_db() as conn:
                    rows = conn.execute("SELECT ticker FROM portfolio").fetchall()
                    return [r["ticker"] for r in rows]
            except Exception:
                return []
        def _get_ann_settings():
            try:
                with get_db() as conn:
                    row = conn.execute("SELECT value FROM blob_store WHERE key='ann_settings'").fetchone()
                    settings = json.loads(row["value"]) if row else {}
                    # Inject global SBC mode so the scheduler can check it
                    sbc_row = conn.execute("SELECT value FROM blob_store WHERE key='sbc_mode'").fetchone()
                    if sbc_row:
                        settings["sbc_mode"] = bool(json.loads(sbc_row["value"]).get("enabled", False))
                    return settings
            except Exception:
                return {}
        _ae.start_scheduler(_get_ann_tickers, _get_ann_settings, DB_PATH)
        print("  Announcements: enabled (10:30 AM + 3:00 PM AEST, price-sensitive only)")
    else:
        print(f"  Announcements: disabled — {_ae_err_msg}")
    app.run(host="0.0.0.0", port=5000, debug=False)
