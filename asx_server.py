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
import logging
from pathlib import Path
import requests

# Shared infrastructure — see core.py
from core import (
    LOG_DIR, log,
    ttl_cache,
    _HTTP_SESSION,
    OLLAMA_BASE as _OLLAMA_BASE,
    SECTOR_MAP   as _SECTOR_MAP,
    ASX_UNIVERSE as _ASX_UNIVERSE,
)

# News engine availability is exposed by routes.news (see blueprint import below)
# so `if _NE_OK:` works in the __main__ block.

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


# ── Per-request timing — warn on slow handlers ────────────────────────────────
@app.before_request
def _req_start():
    request._t0 = time.monotonic()


@app.after_request
def _req_end(resp):
    t0 = getattr(request, "_t0", None)
    if t0 is not None:
        dur_ms = (time.monotonic() - t0) * 1000
        if dur_ms > 2000:
            log.warning("SLOW %s %s %dms → %d", request.method, request.path, dur_ms, resp.status_code)
        elif dur_ms > 500:
            log.info("%s %s %dms → %d", request.method, request.path, dur_ms, resp.status_code)
    return resp

# ── SQLite database ─────────────────────────────────────────────────────────────
# Schema, get_db(), init_db(), log_failed_ticker() live in db.py so route
# modules can import them without dragging in Flask.
from db import DB_PATH, get_db, init_db, log_failed_ticker as _log_failed_ticker_impl

# Run migrations on startup
init_db()

# Keep the existing name for internal call sites
_log_failed_ticker = _log_failed_ticker_impl


# ── Register blueprints ────────────────────────────────────────────────────────
from routes.claude    import bp as _claude_bp
from routes.portfolio import bp as _portfolio_bp
from routes.dividends import bp as _dividends_bp
from routes.market    import bp as _market_bp
from routes.backtest  import bp as _backtest_bp
from routes.scanner   import bp as _scanner_bp
from routes.learning  import bp as _learning_bp
from routes.debate    import bp as _debate_bp
from routes.news      import bp as _news_bp, _NE_OK
app.register_blueprint(_claude_bp)
app.register_blueprint(_portfolio_bp)
app.register_blueprint(_dividends_bp)
app.register_blueprint(_market_bp)
app.register_blueprint(_backtest_bp)
app.register_blueprint(_scanner_bp)
app.register_blueprint(_learning_bp)
app.register_blueprint(_debate_bp)
app.register_blueprint(_news_bp)

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

# health, analyse, macro, rba-rate, polymarket, quote routes live in routes/market.py


# ── Dividend routes live in routes/dividends.py ───────────────────────────────


# cash + db_save/load/refresh-sectors/status routes live in routes/portfolio.py


# quote, risk, portfolio nav-history live in routes/market.py


# ── Market scanner routes live in routes/scanner.py ────────────────────────


# ── DB: State save/load (bulk) ──────────────────────────────────────────────────

# /api/db/* + /api/cash routes live in routes/portfolio.py


# /api/backtest + /api/backtest/ai-replay live in routes/backtest.py


# earnings-calendar lives in routes/market.py


# ── News scanner + LLM provider routes live in routes/news.py ────────────────


# /api/log/ai_response lives in routes/market.py


# ── Learning Loop routes live in routes/learning.py ───────────────────────────


# ── Debate routes live in routes/debate.py ────────────────────────────────────


# ── Claude API proxy lives in routes/claude.py (registered below) ─────────────


if __name__ == "__main__":
    print("=" * 60)
    print("  ASX Trading Assistant – Backend Server")
    print("  http://localhost:5000")
    print("  Open asx_trading.html in your browser")
    print("=" * 60)
    print(f"  Debate Engine: {_OLLAMA_BASE} (GET /api/debate/status to check)")
    if _NE_OK:
        from routes.news import _ensure_news_scheduler
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
