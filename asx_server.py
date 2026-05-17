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
        """)

init_db()

# ── Register blueprints ────────────────────────────────────────────────────────
if _AE_OK:
    app.register_blueprint(ann_bp, url_prefix='/api/announcements')

# ── helpers ────────────────────────────────────────────────────────────────────

def asx(ticker: str) -> str:
    """Append .AX suffix if missing."""
    t = ticker.upper().strip()
    return t if t.endswith(".AX") else f"{t}.AX"


def safe_float(v, default=None):
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except Exception:
        return default


# ── ASX Sector Lookup ───────────────────────────────────────────────────────────

# Comprehensive mapping of ASX tickers to sectors
ASX_SECTOR_MAP = {
    # Banking & Finance
    'CBA': 'Banking', 'WBC': 'Banking', 'ANZ': 'Banking', 'NAB': 'Banking',
    'AMP': 'Insurance', 'SUN': 'Insurance', 'QBE': 'Insurance', 'IAG': 'Insurance',
    'HUB24': 'Fintech', 'APT': 'Fintech', 'Z1P': 'Fintech',
    
    # Materials & Mining
    'BHP': 'Mining', 'RIO': 'Mining', 'FCX': 'Mining', 'ORI': 'Mining',
    'AGO': 'Mining', 'IVR': 'Mining', 'DDR': 'Mining',
    'RMS': 'Materials', 'ALU': 'Materials', 'FMG': 'Mining',
    
    # Energy
    'WOW': 'Energy', 'ORG': 'Energy', 'STO': 'Energy', 'APA': 'Energy',
    'AEJ': 'Energy', 'ELD': 'Energy',
    
    # Healthcare & Pharmaceuticals
    'CSL': 'Healthcare', 'COH': 'Healthcare', 'SHL': 'Healthcare',
    'JHG': 'Healthcare', 'EVE': 'Healthcare', 'RHC': 'Healthcare',
    'NVL': 'Healthcare', 'SIP': 'Healthcare',
    
    # Telcos & Technology
    'TLS': 'Telcos', 'VOC': 'Telcos',
    'WTC': 'Technology', 'XRO': 'Technology', 'WFE': 'Technology',
    'ADA': 'Technology', 'ALT': 'Technology', 'CCC': 'Technology',
    
    # Consumer Discretionary
    'JBH': 'Retail', 'DMP': 'Retail', 'ARG': 'Retail',
    'QAN': 'Transport', 'TCL': 'Retail',
    
    # Real Estate & Infrastructure
    'GMG': 'REITs', 'SCG': 'REITs', 'SCA': 'REITs', 'GPT': 'REITs',
    'Scentre': 'REITs', 'MGR': 'REITs', 'APA': 'Infrastructure',
    'TCL': 'Infrastructure', 'ASX': 'Infrastructure',
    
    # Consumer Staples
    'WES': 'Retail', 'COL': 'Retail',
    
    # Industrials
    'MQG': 'Diversified', 'SKI': 'Diversified', 'BEN': 'Diversified',
    'AZJ': 'Diversified', 'MPL': 'Industrial',
}

def get_sector_for_ticker(ticker: str) -> str:
    """
    Get sector for an ASX ticker using:
    1. Local mapping table (most reliable for ASX)
    2. yfinance info (fallback for non-mapped tickers)
    3. Default to 'Other'
    """
    t = ticker.upper().strip().replace('.AX', '')
    
    # Try local mapping first (most reliable for ASX stocks)
    if t in ASX_SECTOR_MAP:
        return ASX_SECTOR_MAP[t]
    
    # Try yfinance as fallback
    try:
        stk = yf.Ticker(asx(ticker))
        info = stk.info
        sector = info.get("sector", "").strip()
        if sector and sector != "Unknown":
            return sector
    except:
        pass
    
    return "Other"


# ── technical indicators ───────────────────────────────────────────────────────

def compute_rsi(series: pd.Series, period: int = 14) -> pd.Series:
    delta = series.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(com=period - 1, min_periods=period).mean()
    avg_loss = loss.ewm(com=period - 1, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def compute_macd(series: pd.Series, fast=12, slow=26, signal=9):
    ema_fast = series.ewm(span=fast, adjust=False).mean()
    ema_slow = series.ewm(span=slow, adjust=False).mean()
    macd_line = ema_fast - ema_slow
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return macd_line, signal_line, histogram


def compute_bollinger(series: pd.Series, period=20, std_dev=2):
    sma = series.rolling(period).mean()
    std = series.rolling(period).std()
    upper = sma + std_dev * std
    lower = sma - std_dev * std
    return upper, sma, lower


def compute_atr(high: pd.Series, low: pd.Series, close: pd.Series, period=14) -> pd.Series:
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs()
    ], axis=1).max(axis=1)
    return tr.ewm(com=period - 1, min_periods=period).mean()


def compute_stochastic(high, low, close, k_period=14, d_period=3):
    lowest_low = low.rolling(k_period).min()
    highest_high = high.rolling(k_period).max()
    k = 100 * (close - lowest_low) / (highest_high - lowest_low).replace(0, np.nan)
    d = k.rolling(d_period).mean()
    return k, d


def compute_adx(high, low, close, period=14):
    """Average Directional Index."""
    tr = pd.concat([
        high - low,
        (high - close.shift()).abs(),
        (low - close.shift()).abs()
    ], axis=1).max(axis=1)

    plus_dm = high.diff()
    minus_dm = -low.diff()
    plus_dm[plus_dm < 0] = 0
    minus_dm[minus_dm < 0] = 0
    plus_dm[(plus_dm < minus_dm)] = 0
    minus_dm[(minus_dm < plus_dm)] = 0

    atr = tr.ewm(span=period, adjust=False).mean()
    plus_di = 100 * plus_dm.ewm(span=period, adjust=False).mean() / atr
    minus_di = 100 * minus_dm.ewm(span=period, adjust=False).mean() / atr
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    adx = dx.ewm(span=period, adjust=False).mean()
    return adx, plus_di, minus_di


def compute_obv(close, volume):
    direction = np.sign(close.diff()).fillna(0)
    return (direction * volume).cumsum()


def compute_vwap(high, low, close, volume):
    typical = (high + low + close) / 3
    return (typical * volume).cumsum() / volume.cumsum()


def compute_williams_r(high, low, close, period=14):
    highest_high = high.rolling(period).max()
    lowest_low = low.rolling(period).min()
    return -100 * (highest_high - close) / (highest_high - lowest_low).replace(0, np.nan)


def compute_cci(high, low, close, period=20):
    typical = (high + low + close) / 3
    sma = typical.rolling(period).mean()
    mad = typical.rolling(period).apply(lambda x: np.mean(np.abs(x - x.mean())))
    return (typical - sma) / (0.015 * mad)


def compute_mfi(high, low, close, volume, period=14):
    """Money Flow Index."""
    typical = (high + low + close) / 3
    raw_money_flow = typical * volume
    flow_direction = typical.diff()
    pos_flow = raw_money_flow.where(flow_direction > 0, 0).rolling(period).sum()
    neg_flow = raw_money_flow.where(flow_direction <= 0, 0).rolling(period).sum()
    mfr = pos_flow / neg_flow.replace(0, np.nan)
    return 100 - (100 / (1 + mfr))


def compute_donchian(high, low, period=20):
    return high.rolling(period).max(), low.rolling(period).min()


def compute_keltner(high, low, close, ema_period=20, atr_period=10, multiplier=2):
    ema = close.ewm(span=ema_period, adjust=False).mean()
    atr = compute_atr(high, low, close, atr_period)
    return ema + multiplier * atr, ema, ema - multiplier * atr


def compute_support_resistance(high, low, close, lookback=50):
    """Simple pivot-based S/R levels."""
    recent_high = high.rolling(lookback).max().iloc[-1]
    recent_low = low.rolling(lookback).min().iloc[-1]
    pivot = (recent_high + recent_low + close.iloc[-1]) / 3
    r1 = 2 * pivot - recent_low
    r2 = pivot + (recent_high - recent_low)
    s1 = 2 * pivot - recent_high
    s2 = pivot - (recent_high - recent_low)
    return {
        "pivot": round(pivot, 3),
        "r1": round(r1, 3),
        "r2": round(r2, 3),
        "s1": round(s1, 3),
        "s2": round(s2, 3),
    }


# ── main analysis function ─────────────────────────────────────────────────────

def analyse_ticker(ticker: str, period: str = "6mo") -> dict:
    t = asx(ticker)
    stk = yf.Ticker(t)

    # Fetch price history
    hist = stk.history(period=period, auto_adjust=True)
    if hist.empty or len(hist) < 30:
        return {"error": f"Insufficient data for {ticker}"}

    close = hist["Close"]
    high = hist["High"]
    low = hist["Low"]
    volume = hist["Volume"]
    open_ = hist["Open"]

    # ── Trend indicators ──────────────────────────────────────────────────────
    sma_20 = close.rolling(20).mean()
    sma_50 = close.rolling(50).mean()
    sma_200 = close.rolling(200).mean()
    ema_12 = close.ewm(span=12, adjust=False).mean()
    ema_26 = close.ewm(span=26, adjust=False).mean()
    ema_50 = close.ewm(span=50, adjust=False).mean()

    # ── Momentum ──────────────────────────────────────────────────────────────
    rsi = compute_rsi(close, 14)
    rsi_9 = compute_rsi(close, 9)   # short-term RSI
    macd_line, macd_signal, macd_hist = compute_macd(close)
    stoch_k, stoch_d = compute_stochastic(high, low, close)
    williams_r = compute_williams_r(high, low, close)
    cci = compute_cci(high, low, close)
    mfi = compute_mfi(high, low, close, volume)

    # Rate of change
    roc_10 = close.pct_change(10) * 100
    roc_21 = close.pct_change(21) * 100

    # ── Volatility ────────────────────────────────────────────────────────────
    bb_upper, bb_mid, bb_lower = compute_bollinger(close)
    atr = compute_atr(high, low, close)
    keltner_upper, keltner_mid, keltner_lower = compute_keltner(high, low, close)
    donchian_upper, donchian_lower = compute_donchian(high, low)

    # Historical volatility (annualised)
    daily_returns = close.pct_change().dropna()
    hist_vol_20 = daily_returns.rolling(20).std().iloc[-1] * math.sqrt(252) * 100
    hist_vol_60 = daily_returns.rolling(60).std().iloc[-1] * math.sqrt(252) * 100 if len(daily_returns) >= 60 else None

    # BB %B and bandwidth
    bb_pct_b = (close - bb_lower) / (bb_upper - bb_lower).replace(0, np.nan)
    bb_bandwidth = (bb_upper - bb_lower) / bb_mid * 100

    # ── Volume ────────────────────────────────────────────────────────────────
    vol_sma_20 = volume.rolling(20).mean()
    vol_ratio = (volume.iloc[-1] / vol_sma_20.iloc[-1]) if vol_sma_20.iloc[-1] > 0 else 1
    obv = compute_obv(close, volume)
    obv_signal = "rising" if obv.iloc[-1] > obv.rolling(10).mean().iloc[-1] else "falling"

    # VWAP (rolling daily approx from intraday not available at daily resolution — use 20-day)
    vwap_20 = compute_vwap(high, low, close, volume)

    # ── Trend direction score ─────────────────────────────────────────────────
    cp = close.iloc[-1]
    trend_signals = {
        "above_sma20": cp > sma_20.iloc[-1],
        "above_sma50": cp > sma_50.iloc[-1] if not pd.isna(sma_50.iloc[-1]) else None,
        "above_ema50": cp > ema_50.iloc[-1],
        "sma20_above_sma50": sma_20.iloc[-1] > sma_50.iloc[-1] if not pd.isna(sma_50.iloc[-1]) else None,
        "macd_bullish": macd_line.iloc[-1] > macd_signal.iloc[-1],
        "macd_hist_positive": macd_hist.iloc[-1] > 0,
        "macd_hist_rising": macd_hist.iloc[-1] > macd_hist.iloc[-2],
    }
    bullish_count = sum(1 for v in trend_signals.values() if v is True)
    bearish_count = sum(1 for v in trend_signals.values() if v is False)
    trend_score = (bullish_count - bearish_count) / len(trend_signals)  # -1 to 1

    # ── ADX ───────────────────────────────────────────────────────────────────
    adx, plus_di, minus_di = compute_adx(high, low, close)
    adx_val = safe_float(adx.iloc[-1])
    trend_strength = "strong" if (adx_val or 0) > 25 else "weak"

    # ── Support / Resistance ──────────────────────────────────────────────────
    sr = compute_support_resistance(high, low, close)

    # ── Fundamental data ──────────────────────────────────────────────────────
    info = {}
    try:
        info = stk.info or {}
    except Exception:
        pass

    # ── Returns ───────────────────────────────────────────────────────────────
    def pct_return(days):
        if len(close) > days:
            return safe_float((close.iloc[-1] / close.iloc[-days] - 1) * 100)
        return None

    # ── Composite signal ──────────────────────────────────────────────────────
    rsi_val = safe_float(rsi.iloc[-1], 50)
    macd_bull = macd_line.iloc[-1] > macd_signal.iloc[-1]
    stoch_val = safe_float(stoch_k.iloc[-1], 50)

    buy_signals, sell_signals = [], []

    if rsi_val < 30:  buy_signals.append("RSI Oversold (<30)")
    elif rsi_val < 40: buy_signals.append("RSI Low (30-40)")
    if rsi_val > 70: sell_signals.append("RSI Overbought (>70)")
    elif rsi_val > 60: sell_signals.append("RSI High (60-70)")

    if macd_bull: buy_signals.append("MACD Bullish crossover")
    else:         sell_signals.append("MACD Bearish crossover")

    if macd_hist.iloc[-1] > macd_hist.iloc[-2]: buy_signals.append("MACD Histogram expanding")
    else:                                        sell_signals.append("MACD Histogram contracting")

    if cp > bb_mid.iloc[-1] and cp < bb_upper.iloc[-1]:  buy_signals.append("Price above BB midline")
    if cp < bb_mid.iloc[-1] and cp > bb_lower.iloc[-1]: sell_signals.append("Price below BB midline")
    if cp < bb_lower.iloc[-1]: buy_signals.append("Price at/below BB lower band")
    if cp > bb_upper.iloc[-1]: sell_signals.append("Price at/above BB upper band")

    if stoch_val < 20:  buy_signals.append("Stochastic %K oversold")
    elif stoch_val > 80: sell_signals.append("Stochastic %K overbought")

    if cp > sma_20.iloc[-1]: buy_signals.append("Price above SMA20")
    else:                    sell_signals.append("Price below SMA20")

    if not pd.isna(sma_50.iloc[-1]):
        if sma_20.iloc[-1] > sma_50.iloc[-1]: buy_signals.append("Golden cross (SMA20>SMA50)")
        else:                                  sell_signals.append("Death cross (SMA20<SMA50)")

    if vol_ratio > 1.5 and cp > open_.iloc[-1]: buy_signals.append(f"High volume bullish day ({vol_ratio:.1f}x avg)")
    if vol_ratio > 1.5 and cp < open_.iloc[-1]: sell_signals.append(f"High volume bearish day ({vol_ratio:.1f}x avg)")

    cci_val = safe_float(cci.iloc[-1], 0)
    if cci_val < -100:  buy_signals.append("CCI oversold (<-100)")
    if cci_val > 100:   sell_signals.append("CCI overbought (>100)")

    mfi_val = safe_float(mfi.iloc[-1], 50)
    if mfi_val < 20:   buy_signals.append("MFI oversold (<20) — accumulation")
    if mfi_val > 80:   sell_signals.append("MFI overbought (>80) — distribution")

    if obv_signal == "rising" and trend_score > 0: buy_signals.append("OBV rising with uptrend")
    if obv_signal == "falling" and trend_score < 0: sell_signals.append("OBV falling with downtrend")

    # Composite score (-1 to 1)
    signal_score = (len(buy_signals) - len(sell_signals)) / max(len(buy_signals) + len(sell_signals), 1)
    if signal_score > 0.3:    composite = "BUY"
    elif signal_score < -0.3: composite = "SELL"
    else:                     composite = "HOLD"

    confidence = min(0.95, abs(signal_score) * 0.7 + (adx_val or 20) / 100 * 0.3)

    # ── Price targets ─────────────────────────────────────────────────────────
    atr_val = safe_float(atr.iloc[-1], cp * 0.02)
    if composite == "BUY":
        target = round(cp + 2.5 * atr_val, 3)
        stop_loss = round(max(cp - 1.5 * atr_val, sr["s1"]), 3)
        entry_low = round(cp * 0.995, 3)
        entry_high = round(cp * 1.005, 3)
    elif composite == "SELL":
        target = round(cp - 2.5 * atr_val, 3)
        stop_loss = round(min(cp + 1.5 * atr_val, sr["r1"]), 3)
        entry_low = round(cp * 0.995, 3)
        entry_high = round(cp * 1.005, 3)
    else:
        target = round(cp + atr_val, 3)
        stop_loss = round(cp - atr_val, 3)
        entry_low = round(cp * 0.997, 3)
        entry_high = round(cp * 1.003, 3)

    # ── Fundamental metrics ───────────────────────────────────────────────────
    fundamentals = {
        "market_cap": safe_float(info.get("marketCap")),
        "pe_ratio": safe_float(info.get("trailingPE")),
        "forward_pe": safe_float(info.get("forwardPE")),
        "pb_ratio": safe_float(info.get("priceToBook")),
        "eps": safe_float(info.get("trailingEps")),
        "dividend_yield": (lambda v: round(v/100,6) if v and v>1 else v)(safe_float(info.get("dividendYield"))),
        "payout_ratio": safe_float(info.get("payoutRatio")),
        "roe": safe_float(info.get("returnOnEquity")),
        "roa": safe_float(info.get("returnOnAssets")),
        "debt_to_equity": safe_float(info.get("debtToEquity")),
        "current_ratio": safe_float(info.get("currentRatio")),
        "revenue_growth": safe_float(info.get("revenueGrowth")),
        "earnings_growth": safe_float(info.get("earningsGrowth")),
        "gross_margin": safe_float(info.get("grossMargins")),
        "operating_margin": safe_float(info.get("operatingMargins")),
        "net_margin": safe_float(info.get("profitMargins")),
        "beta": safe_float(info.get("beta")),
        "52w_high": safe_float(info.get("fiftyTwoWeekHigh")),
        "52w_low": safe_float(info.get("fiftyTwoWeekLow")),
        "analyst_target": safe_float(info.get("targetMeanPrice")),
        "analyst_recommendation": info.get("recommendationKey", "n/a"),
        "sector": get_sector_for_ticker(ticker),
        "industry": info.get("industry", ""),
        "short_name": info.get("shortName", ticker),
    }

    # Distance to 52w high/low
    if fundamentals["52w_high"] and cp:
        fundamentals["pct_from_52w_high"] = round((cp / fundamentals["52w_high"] - 1) * 100, 2)
    if fundamentals["52w_low"] and cp:
        fundamentals["pct_from_52w_low"] = round((cp / fundamentals["52w_low"] - 1) * 100, 2)

    # ── Historical price series (last 90 days for charting) ───────────────────
    chart_data = []
    hist_90 = hist.tail(90)
    for dt, row in hist_90.iterrows():
        chart_data.append({
            "date": dt.strftime("%Y-%m-%d"),
            "open": round(row["Open"], 3),
            "high": round(row["High"], 3),
            "low": round(row["Low"], 3),
            "close": round(row["Close"], 3),
            "volume": int(row["Volume"]),
        })

    return {
        "ticker": ticker.upper(),
        "asx_ticker": t,
        "current_price": round(cp, 3),
        "fetched_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),

        # Trend
        "sma_20": round(sma_20.iloc[-1], 3),
        "sma_50": safe_float(sma_50.iloc[-1]),
        "sma_200": safe_float(sma_200.iloc[-1]),
        "ema_12": round(ema_12.iloc[-1], 3),
        "ema_26": round(ema_26.iloc[-1], 3),
        "ema_50": round(ema_50.iloc[-1], 3),
        "trend_score": round(trend_score, 3),
        "trend_direction": "bullish" if trend_score > 0.1 else "bearish" if trend_score < -0.1 else "neutral",
        "adx": round(adx_val, 2) if adx_val else None,
        "adx_plus_di": safe_float(plus_di.iloc[-1]),
        "adx_minus_di": safe_float(minus_di.iloc[-1]),
        "trend_strength": trend_strength,

        # Momentum
        "rsi_14": round(rsi_val, 2),
        "rsi_9": safe_float(rsi_9.iloc[-1]),
        "macd_line": safe_float(macd_line.iloc[-1]),
        "macd_signal": safe_float(macd_signal.iloc[-1]),
        "macd_hist": safe_float(macd_hist.iloc[-1]),
        "macd_hist_prev": safe_float(macd_hist.iloc[-2]),
        "stoch_k": safe_float(stoch_k.iloc[-1]),
        "stoch_d": safe_float(stoch_d.iloc[-1]),
        "williams_r": safe_float(williams_r.iloc[-1]),
        "cci": safe_float(cci.iloc[-1]),
        "mfi": safe_float(mfi.iloc[-1]),
        "roc_10": safe_float(roc_10.iloc[-1]),
        "roc_21": safe_float(roc_21.iloc[-1]),

        # Volatility
        "bb_upper": safe_float(bb_upper.iloc[-1]),
        "bb_mid": safe_float(bb_mid.iloc[-1]),
        "bb_lower": safe_float(bb_lower.iloc[-1]),
        "bb_pct_b": safe_float(bb_pct_b.iloc[-1]),
        "bb_bandwidth": safe_float(bb_bandwidth.iloc[-1]),
        "atr_14": safe_float(atr.iloc[-1]),
        "atr_pct": safe_float((atr.iloc[-1] / cp) * 100) if cp else None,
        "keltner_upper": safe_float(keltner_upper.iloc[-1]),
        "keltner_lower": safe_float(keltner_lower.iloc[-1]),
        "donchian_upper": safe_float(donchian_upper.iloc[-1]),
        "donchian_lower": safe_float(donchian_lower.iloc[-1]),
        "hist_vol_20": safe_float(hist_vol_20),
        "hist_vol_60": safe_float(hist_vol_60),

        # Volume
        "volume_today": int(volume.iloc[-1]),
        "volume_avg_20": int(vol_sma_20.iloc[-1]) if not pd.isna(vol_sma_20.iloc[-1]) else None,
        "volume_ratio": round(vol_ratio, 2),
        "obv_trend": obv_signal,
        "vwap_20d": safe_float(vwap_20.iloc[-1]),
        "price_vs_vwap": "above" if cp > (vwap_20.iloc[-1] or cp) else "below",

        # Support / Resistance
        "support_resistance": sr,

        # Returns
        "return_1d": pct_return(1),
        "return_5d": pct_return(5),
        "return_20d": pct_return(20),
        "return_60d": pct_return(60),
        "return_90d": pct_return(90),

        # Signal
        "composite_signal": composite,
        "signal_score": round(signal_score, 3),
        "confidence": round(confidence, 3),
        "buy_signals": buy_signals,
        "sell_signals": sell_signals,
        "target": target,
        "stop_loss": stop_loss,
        "entry_range": [entry_low, entry_high],

        # Fundamentals
        "fundamentals": fundamentals,

        # Chart data
        "chart_data": chart_data,
    }


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
    """Return real market data for macro dashboard using yfinance."""
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


# ── ASX Dividend Scraper ──────────────────────────────────────────────────────

_ASX_DIV_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-AU,en;q=0.9",
    "Referer": "https://www.asx.com.au/markets/trade-our-cash-market/dividend-search",
}
_DIV_CACHE_TTL_HOURS = 12


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
        timeout=15,
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


@app.route("/api/dividends/<ticker>")
def dividend_info(ticker):
    """
    Returns dividend schedule, history and forward yield for an ASX ticker.
    Primary source: ASX dividend-search API (real ex-dates + franking %).
    Secondary: yfinance for yield / payout ratio metadata.
    Results cached for 12 h in dividend_cache table.
    """
    code = ticker.upper().replace(".AX", "")

    cached = _get_cached_dividends(code)
    if cached:
        return jsonify(cached)

    # ── 1. Try ASX scrape ────────────────────────────────────────────────────
    asx_history: list[dict] = []
    asx_ok = False
    try:
        asx_history = scrape_asx_dividends(code)
        asx_ok = bool(asx_history)
    except Exception as ex:
        pass  # fall through to yfinance-only path

    # ── 2. yfinance metadata (yield, payout ratio, 5yr avg) ─────────────────
    yf_info = _yf_info_safe(code)

    # ── 3. Build response ────────────────────────────────────────────────────
    if asx_ok:
        result = _build_dividend_response(code, asx_history, yf_info)
    else:
        # Pure yfinance fallback (original behaviour)
        try:
            stk  = yf.Ticker(asx(code))
            divs = stk.dividends
            history = []
            if not divs.empty:
                cutoff = datetime.now() - timedelta(days=3 * 365)
                for dt, amt in divs[divs.index >= cutoff].items():
                    history.append({"ex_date": dt.strftime("%Y-%m-%d"),
                                    "amount": round(float(amt), 4),
                                    "franking_pct": 0.0,
                                    "dividend_type": "Ordinary"})
                history.sort(key=lambda x: x["ex_date"], reverse=True)
            result = _build_dividend_response(code, history, yf_info)
            result["source"] = "yfinance"
        except Exception as e:
            return jsonify({"error": str(e), "ticker": code}), 500

    _set_cached_dividends(code, result, result.get("source", "asx"))
    return jsonify(result)


@app.route("/api/dividends/batch", methods=["POST"])
def dividend_batch():
    """
    Fetch dividend info for multiple tickers in parallel.
    Body: {"tickers": [...], "force": false}
    Each ticker: ASX scrape → cache → yfinance fallback.
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

        asx_history: list[dict] = []
        asx_ok = False
        try:
            asx_history = scrape_asx_dividends(code)
            asx_ok = bool(asx_history)
        except Exception:
            pass

        yf_info = _yf_info_safe(code)

        if asx_ok:
            result = _build_dividend_response(code, asx_history, yf_info)
        else:
            try:
                stk  = yf.Ticker(asx(code))
                divs = stk.dividends
                history = []
                if not divs.empty:
                    cutoff = datetime.now() - timedelta(days=3 * 365)
                    for dt, amt in divs[divs.index >= cutoff].items():
                        history.append({"ex_date": dt.strftime("%Y-%m-%d"),
                                        "amount": round(float(amt), 4),
                                        "franking_pct": 0.0,
                                        "dividend_type": "Ordinary"})
                    history.sort(key=lambda x: x["ex_date"], reverse=True)
                result = _build_dividend_response(code, history, yf_info)
                result["source"] = "yfinance"
            except Exception as ex:
                return code, {"error": str(ex), "ticker": code}

        _set_cached_dividends(code, result, result.get("source", "asx"))
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

            metrics[ticker] = {
                "volatility_ann": round(vol_ann, 2),
                "sharpe":         round(sharpe, 3),
                "beta":           round(beta, 3),
                "return_30d":     round(ret_30d, 2),
                "return_90d":     round(ret_90d, 2),
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
                        (date, timestamp, ticker, action, qty, entry_price, exit_price, fees, pnl, status, rec_id, rec_executed)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    t.get("date"), t.get("timestamp"), t["ticker"], t["action"],
                    t["qty"], t["entryPrice"], t.get("exitPrice"),
                    t.get("fees", 10), t.get("pnl"), t.get("status","open"),
                    t.get("recId"), 1 if t.get("recExecuted") else 0
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
                         outcome, actual_profit, reasoning, risks, signals)
                    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """, (
                    r["id"], r["date"], r["ticker"], r["action"],
                    r.get("confidence"), pr[0] if pr else None, pr[1] if pr else None,
                    r.get("target"), r.get("stopLoss"), r.get("expectedProfit"), r.get("netProfit"),
                    1 if r.get("executed") else 0, r.get("executedAt"),
                    r.get("outcome"), r.get("actualProfit"),
                    r.get("reasoning"), r.get("risks"),
                    json.dumps(r.get("signals", []))
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
            'recommendations', 'priceAlerts',
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

def _news_settings_from_db() -> dict:
    """Read news scanner settings from blob_store."""
    defaults = {
        "llm_model": "gemma3:4b",
        "ollama_url": "http://localhost:11434",
        "scan_interval_hours": 6,
        "enabled": True,
        "max_age_days": 7,
        "cpu_mode": False,
    }
    try:
        with get_db() as conn:
            row = conn.execute(
                "SELECT value FROM blob_store WHERE key='news_settings'"
            ).fetchone()
            if row:
                saved = json.loads(row["value"])
                return {**defaults, **saved}
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
            model=cfg.get("llm_model", "gemma3:4b"),
            base_url=cfg.get("ollama_url", "http://localhost:11434"),
        ).is_available(),
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
        model=cfg.get("llm_model", "gemma3:4b"),
        base_url=cfg.get("ollama_url", "http://localhost:11434"),
    )
    available = llm.is_available()
    models    = llm.list_models() if available else []
    return jsonify({"models": models, "available": available})


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

    # Restart scheduler if interval or enabled changed
    if _NE_OK:
        _ne.stop_scheduler()
        if updated.get("enabled", True):
            _ne.start_scheduler(
                db_path=DB_PATH,
                interval_hours=updated.get("scan_interval_hours", 6),
                get_tickers_fn=_portfolio_tickers_from_db,
                get_settings_fn=_news_settings_from_db,
            )
    return jsonify({"ok": True, "settings": updated})


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
        model=cfg.get("llm_model", "gemma3:4b"),
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
        llm      = _ne.OllamaLLM(model=model, base_url=cfg.get("ollama_url", "http://localhost:11434"))
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
    data  = request.get_json() or {}
    model = data.get("model", "").strip()
    days  = int(data.get("days", 7))
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
    days  = int(request.args.get("days", 2))
    limit = int(request.args.get("limit", 15))
    items = _ne.get_news_brief(DB_PATH, tickers, days=days, limit=limit)
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
                    return json.loads(row["value"]) if row else {}
            except Exception:
                return {}
        _ae.start_scheduler(_get_ann_tickers, _get_ann_settings, DB_PATH)
        print("  Announcements: enabled (10:30 AM + 3:00 PM AEST, price-sensitive only)")
    else:
        print(f"  Announcements: disabled — {_ae_err_msg}")
    app.run(host="0.0.0.0", port=5000, debug=False)
