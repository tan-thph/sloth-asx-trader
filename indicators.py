"""
indicators.py — Technical indicator computations and ticker analysis.

All compute_* functions and analyse_ticker live here so they can be edited
independently of the server routing logic in asx_server.py.
"""

import math
from datetime import datetime

import numpy as np
import pandas as pd
import yfinance as yf


# ── Helpers ────────────────────────────────────────────────────────────────────

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


# ── ASX Sector Lookup ──────────────────────────────────────────────────────────

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
    'Scentre': 'REITs', 'MGR': 'REITs',
    'TCL': 'Infrastructure', 'ASX': 'Infrastructure',

    # Consumer Staples
    'WES': 'Retail', 'COL': 'Retail',

    # Industrials
    'MQG': 'Diversified', 'SKI': 'Diversified', 'BEN': 'Diversified',
    'AZJ': 'Diversified', 'MPL': 'Industrial',
}


def get_sector_for_ticker(ticker: str) -> str:
    t = ticker.upper().strip().replace('.AX', '')
    if t in ASX_SECTOR_MAP:
        return ASX_SECTOR_MAP[t]
    try:
        stk = yf.Ticker(asx(ticker))
        info = stk.info
        sector = info.get("sector", "").strip()
        if sector and sector != "Unknown":
            return sector
    except Exception:
        pass
    return "Other"


# ── Core indicator functions ───────────────────────────────────────────────────
# Edit these to change how indicators are calculated across the whole app.

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


# ── Market scanner scoring (lightweight, numpy-only) ──────────────────────────
# Used by _run_market_scan in asx_server.py. Edit scoring weights here.

def _simple_rsi(closes: np.ndarray, period: int = 14) -> float:
    if len(closes) < period + 2:
        return 50.0
    delta = np.diff(closes[-(period + 2):])
    gains  = np.where(delta > 0, delta, 0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    avg_g, avg_l = gains.mean(), losses.mean()
    return float(100 - 100 / (1 + avg_g / avg_l)) if avg_l > 0 else 100.0


def _score_ticker(closes: np.ndarray, volumes: np.ndarray) -> dict | None:
    n = len(closes)
    if n < 45:
        return None
    cp = float(closes[-1])
    if cp <= 0:
        return None

    # ── Trend quality (0-30) ─────────────────────────────────────────────────
    sma20        = float(np.mean(closes[-20:]))
    sma50        = float(np.mean(closes[-50:])) if n >= 50 else sma20
    sma20_5d_ago = float(np.mean(closes[-25:-5])) if n >= 25 else sma20
    sma_rising   = sma20 > sma20_5d_ago

    trend = (10 if cp > sma20 else 0) + (10 if cp > sma50 else 0) + (10 if sma_rising else 0)

    # ── Pullback quality (0-30): RSI zone + position from high ──────────────
    rsi      = _simple_rsi(closes)
    high_90  = float(np.max(closes))
    pct_high = (cp / high_90 - 1) * 100  # negative

    if   35 <= rsi <= 55: rsi_score = 15
    elif 30 <= rsi <  35: rsi_score = 12
    elif 55 <  rsi <= 65: rsi_score = 10
    elif rsi < 30:        rsi_score = 5
    else:                 rsi_score = 3  # overbought

    if   -20 <= pct_high <= -5:  pos_score = 15  # ideal pullback window
    elif  -5 <  pct_high <=  0:  pos_score = 9   # near high — momentum play
    elif -30 <= pct_high < -20:  pos_score = 10  # deeper dip, higher risk
    else:                        pos_score = 4   # very deep — distress risk

    pullback = rsi_score + pos_score

    # ── Volume signal (0-20): is accumulation building? ─────────────────────
    vol_avg20  = float(np.mean(volumes[-20:])) if np.mean(volumes[-20:]) > 0 else 1
    vol5_avg   = float(np.mean(volumes[-5:]))
    vol5_ratio = vol5_avg / vol_avg20

    if   vol5_ratio > 1.5: vol_score = 20
    elif vol5_ratio > 1.1: vol_score = 15
    elif vol5_ratio > 0.8: vol_score = 10
    else:                  vol_score = 5

    # ── Short-term momentum (0-20): price turning up ─────────────────────────
    ret_5d  = float((cp / closes[-6]  - 1) * 100) if n > 6  else 0.0
    ret_20d = float((cp / closes[-21] - 1) * 100) if n > 21 else 0.0

    if   ret_5d > 3:  mom_score = 20
    elif ret_5d > 0:  mom_score = 15
    elif ret_5d > -2: mom_score = 10
    else:             mom_score = 5

    total = trend + pullback + vol_score + mom_score

    return {
        "score":          round(min(total, 100), 1),
        "trend_score":    trend,
        "pullback_score": pullback,
        "vol_score":      vol_score,
        "mom_score":      mom_score,
        "rsi":            round(rsi, 1),
        "ret_5d":         round(ret_5d, 2),
        "ret_20d":        round(ret_20d, 2),
        "vol_ratio":      round(vol5_ratio, 2),
        "pct_from_high":  round(pct_high, 1),
        "current_price":  round(cp, 3),
        "sma20":          round(sma20, 3),
        "sma50":          round(sma50, 3),
    }


# ── Main ticker analysis ───────────────────────────────────────────────────────

def analyse_ticker(ticker: str, period: str = "6mo") -> dict:
    t = asx(ticker)
    stk = yf.Ticker(t)

    hist = stk.history(period=period, auto_adjust=True)
    if hist.empty or len(hist) < 30:
        return {"error": f"Insufficient data for {ticker}"}

    close  = hist["Close"]
    high   = hist["High"]
    low    = hist["Low"]
    volume = hist["Volume"]
    open_  = hist["Open"]

    # ── Trend ─────────────────────────────────────────────────────────────────
    sma_20  = close.rolling(20).mean()
    sma_50  = close.rolling(50).mean()
    sma_200 = close.rolling(200).mean()
    ema_12  = close.ewm(span=12, adjust=False).mean()
    ema_26  = close.ewm(span=26, adjust=False).mean()
    ema_50  = close.ewm(span=50, adjust=False).mean()

    # ── Momentum ──────────────────────────────────────────────────────────────
    rsi             = compute_rsi(close, 14)
    rsi_9           = compute_rsi(close, 9)
    macd_line, macd_signal, macd_hist = compute_macd(close)
    stoch_k, stoch_d = compute_stochastic(high, low, close)
    williams_r      = compute_williams_r(high, low, close)
    cci             = compute_cci(high, low, close)
    mfi             = compute_mfi(high, low, close, volume)
    roc_10          = close.pct_change(10) * 100
    roc_21          = close.pct_change(21) * 100

    # ── Volatility ────────────────────────────────────────────────────────────
    bb_upper, bb_mid, bb_lower = compute_bollinger(close)
    atr = compute_atr(high, low, close)
    keltner_upper, _keltner_mid, keltner_lower = compute_keltner(high, low, close)
    donchian_upper, donchian_lower = compute_donchian(high, low)

    daily_returns = close.pct_change().dropna()
    hist_vol_20 = daily_returns.rolling(20).std().iloc[-1] * math.sqrt(252) * 100
    hist_vol_60 = daily_returns.rolling(60).std().iloc[-1] * math.sqrt(252) * 100 if len(daily_returns) >= 60 else None

    bb_pct_b   = (close - bb_lower) / (bb_upper - bb_lower).replace(0, np.nan)
    bb_bandwidth = (bb_upper - bb_lower) / bb_mid * 100

    # ── Volume ────────────────────────────────────────────────────────────────
    vol_sma_20  = volume.rolling(20).mean()
    vol_ratio   = (volume.iloc[-1] / vol_sma_20.iloc[-1]) if vol_sma_20.iloc[-1] > 0 else 1
    vol_std_20  = volume.rolling(20).std()
    _vol_std    = vol_std_20.iloc[-1]
    vol_z_score = float((volume.iloc[-1] - vol_sma_20.iloc[-1]) / _vol_std) if (not pd.isna(_vol_std) and _vol_std > 0) else 0.0
    adv_20      = float((close * volume).rolling(20).mean().iloc[-1]) if len(close) >= 20 else 0.0
    obv         = compute_obv(close, volume)
    obv_signal  = "rising" if obv.iloc[-1] > obv.rolling(10).mean().iloc[-1] else "falling"
    vwap_20     = compute_vwap(high, low, close, volume)

    # ── Trend direction score ─────────────────────────────────────────────────
    cp = close.iloc[-1]
    trend_signals = {
        "above_sma20":       cp > sma_20.iloc[-1],
        "above_sma50":       cp > sma_50.iloc[-1] if not pd.isna(sma_50.iloc[-1]) else None,
        "above_ema50":       cp > ema_50.iloc[-1],
        "sma20_above_sma50": sma_20.iloc[-1] > sma_50.iloc[-1] if not pd.isna(sma_50.iloc[-1]) else None,
        "macd_bullish":      macd_line.iloc[-1] > macd_signal.iloc[-1],
        "macd_hist_positive": macd_hist.iloc[-1] > 0,
        "macd_hist_rising":  macd_hist.iloc[-1] > macd_hist.iloc[-2],
    }
    bullish_count = sum(1 for v in trend_signals.values() if v is True)
    bearish_count = sum(1 for v in trend_signals.values() if v is False)
    trend_score   = (bullish_count - bearish_count) / len(trend_signals)

    # ── ADX ───────────────────────────────────────────────────────────────────
    adx, plus_di, minus_di = compute_adx(high, low, close)
    adx_val        = safe_float(adx.iloc[-1])
    trend_strength = "strong" if (adx_val or 0) > 25 else "weak"

    # ── Support / Resistance ──────────────────────────────────────────────────
    sr = compute_support_resistance(high, low, close)

    # ── Fundamental data ──────────────────────────────────────────────────────
    info = {}
    try:
        info = stk.info or {}
    except Exception:
        pass

    def pct_return(days):
        if len(close) > days:
            return safe_float((close.iloc[-1] / close.iloc[-days] - 1) * 100)
        return None

    # ── Composite buy/sell signal list ────────────────────────────────────────
    rsi_val   = safe_float(rsi.iloc[-1], 50)
    macd_bull = macd_line.iloc[-1] > macd_signal.iloc[-1]
    stoch_val = safe_float(stoch_k.iloc[-1], 50)
    cci_val   = safe_float(cci.iloc[-1], 0)
    mfi_val   = safe_float(mfi.iloc[-1], 50)

    buy_signals, sell_signals = [], []

    if rsi_val < 30:   buy_signals.append("RSI Oversold (<30)")
    elif rsi_val < 40: buy_signals.append("RSI Low (30-40)")
    if rsi_val > 70:   sell_signals.append("RSI Overbought (>70)")
    elif rsi_val > 60: sell_signals.append("RSI High (60-70)")

    if macd_bull: buy_signals.append("MACD Bullish crossover")
    else:         sell_signals.append("MACD Bearish crossover")

    if macd_hist.iloc[-1] > macd_hist.iloc[-2]: buy_signals.append("MACD Histogram expanding")
    else:                                        sell_signals.append("MACD Histogram contracting")

    if cp > bb_mid.iloc[-1] and cp < bb_upper.iloc[-1]: buy_signals.append("Price above BB midline")
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

    if cci_val < -100: buy_signals.append("CCI oversold (<-100)")
    if cci_val > 100:  sell_signals.append("CCI overbought (>100)")

    if mfi_val < 20: buy_signals.append("MFI oversold (<20) — accumulation")
    if mfi_val > 80: sell_signals.append("MFI overbought (>80) — distribution")

    if obv_signal == "rising"  and trend_score > 0: buy_signals.append("OBV rising with uptrend")
    if obv_signal == "falling" and trend_score < 0: sell_signals.append("OBV falling with downtrend")

    signal_score = (len(buy_signals) - len(sell_signals)) / max(len(buy_signals) + len(sell_signals), 1)
    if signal_score > 0.3:    composite = "BUY"
    elif signal_score < -0.3: composite = "SELL"
    else:                     composite = "HOLD"

    confidence = min(0.95, abs(signal_score) * 0.7 + (adx_val or 20) / 100 * 0.3)

    # ── Price targets ─────────────────────────────────────────────────────────
    atr_val = safe_float(atr.iloc[-1], cp * 0.02)
    if composite == "BUY":
        target     = round(cp + 2.5 * atr_val, 3)
        stop_loss  = round(max(cp - 1.5 * atr_val, sr["s1"]), 3)
        entry_low  = round(cp * 0.995, 3)
        entry_high = round(cp * 1.005, 3)
    elif composite == "SELL":
        target     = round(cp - 2.5 * atr_val, 3)
        stop_loss  = round(min(cp + 1.5 * atr_val, sr["r1"]), 3)
        entry_low  = round(cp * 0.995, 3)
        entry_high = round(cp * 1.005, 3)
    else:
        target     = round(cp + atr_val, 3)
        stop_loss  = round(cp - atr_val, 3)
        entry_low  = round(cp * 0.997, 3)
        entry_high = round(cp * 1.003, 3)

    # ── Fundamentals ─────────────────────────────────────────────────────────
    fundamentals = {
        "market_cap":             safe_float(info.get("marketCap")),
        "pe_ratio":               safe_float(info.get("trailingPE")),
        "forward_pe":             safe_float(info.get("forwardPE")),
        "pb_ratio":               safe_float(info.get("priceToBook")),
        "eps":                    safe_float(info.get("trailingEps")),
        "dividend_yield":         (lambda v: round(v/100, 6) if v and v > 1 else v)(safe_float(info.get("dividendYield"))),
        "payout_ratio":           safe_float(info.get("payoutRatio")),
        "roe":                    safe_float(info.get("returnOnEquity")),
        "roa":                    safe_float(info.get("returnOnAssets")),
        "debt_to_equity":         safe_float(info.get("debtToEquity")),
        "current_ratio":          safe_float(info.get("currentRatio")),
        "revenue_growth":         safe_float(info.get("revenueGrowth")),
        "earnings_growth":        safe_float(info.get("earningsGrowth")),
        "gross_margin":           safe_float(info.get("grossMargins")),
        "operating_margin":       safe_float(info.get("operatingMargins")),
        "net_margin":             safe_float(info.get("profitMargins")),
        "beta":                   safe_float(info.get("beta")),
        "52w_high":               safe_float(info.get("fiftyTwoWeekHigh")),
        "52w_low":                safe_float(info.get("fiftyTwoWeekLow")),
        "analyst_target":         safe_float(info.get("targetMeanPrice")),
        "analyst_recommendation": info.get("recommendationKey", "n/a"),
        "sector":                 get_sector_for_ticker(ticker),
        "industry":               info.get("industry", ""),
        "short_name":             info.get("shortName", ticker),
    }

    if fundamentals["52w_high"] and cp:
        fundamentals["pct_from_52w_high"] = round((cp / fundamentals["52w_high"] - 1) * 100, 2)
    if fundamentals["52w_low"] and cp:
        fundamentals["pct_from_52w_low"] = round((cp / fundamentals["52w_low"] - 1) * 100, 2)

    # ── Chart data (last 90 days) ─────────────────────────────────────────────
    chart_data = []
    for dt, row in hist.tail(90).iterrows():
        chart_data.append({
            "date":   dt.strftime("%Y-%m-%d"),
            "open":   round(row["Open"], 3),
            "high":   round(row["High"], 3),
            "low":    round(row["Low"], 3),
            "close":  round(row["Close"], 3),
            "volume": int(row["Volume"]),
        })

    return {
        "ticker":      ticker.upper(),
        "asx_ticker":  t,
        "current_price": round(cp, 3),
        "fetched_at":  datetime.now().strftime("%Y-%m-%d %H:%M:%S"),

        # Trend
        "sma_20":          round(sma_20.iloc[-1], 3),
        "sma_50":          safe_float(sma_50.iloc[-1]),
        "sma_200":         safe_float(sma_200.iloc[-1]),
        "ema_12":          round(ema_12.iloc[-1], 3),
        "ema_26":          round(ema_26.iloc[-1], 3),
        "ema_50":          round(ema_50.iloc[-1], 3),
        "trend_score":     round(trend_score, 3),
        "trend_direction": "bullish" if trend_score > 0.1 else "bearish" if trend_score < -0.1 else "neutral",
        "adx":             round(adx_val, 2) if adx_val else None,
        "adx_plus_di":     safe_float(plus_di.iloc[-1]),
        "adx_minus_di":    safe_float(minus_di.iloc[-1]),
        "trend_strength":  trend_strength,

        # Momentum
        "rsi_14":       round(rsi_val, 2),
        "rsi_9":        safe_float(rsi_9.iloc[-1]),
        "macd_line":    safe_float(macd_line.iloc[-1]),
        "macd_signal":  safe_float(macd_signal.iloc[-1]),
        "macd_hist":    safe_float(macd_hist.iloc[-1]),
        "macd_hist_prev": safe_float(macd_hist.iloc[-2]),
        "stoch_k":      safe_float(stoch_k.iloc[-1]),
        "stoch_d":      safe_float(stoch_d.iloc[-1]),
        "williams_r":   safe_float(williams_r.iloc[-1]),
        "cci":          safe_float(cci.iloc[-1]),
        "mfi":          safe_float(mfi.iloc[-1]),
        "roc_10":       safe_float(roc_10.iloc[-1]),
        "roc_21":       safe_float(roc_21.iloc[-1]),

        # Volatility
        "bb_upper":       safe_float(bb_upper.iloc[-1]),
        "bb_mid":         safe_float(bb_mid.iloc[-1]),
        "bb_lower":       safe_float(bb_lower.iloc[-1]),
        "bb_pct_b":       safe_float(bb_pct_b.iloc[-1]),
        "bb_bandwidth":   safe_float(bb_bandwidth.iloc[-1]),
        "atr_14":         safe_float(atr.iloc[-1]),
        "atr_pct":        safe_float((atr.iloc[-1] / cp) * 100) if cp else None,
        "keltner_upper":  safe_float(keltner_upper.iloc[-1]),
        "keltner_lower":  safe_float(keltner_lower.iloc[-1]),
        "donchian_upper": safe_float(donchian_upper.iloc[-1]),
        "donchian_lower": safe_float(donchian_lower.iloc[-1]),
        "hist_vol_20":    safe_float(hist_vol_20),
        "hist_vol_60":    safe_float(hist_vol_60),

        # Volume
        "volume_today":   int(volume.iloc[-1]),
        "volume_avg_20":  int(vol_sma_20.iloc[-1]) if not pd.isna(vol_sma_20.iloc[-1]) else None,
        "volume_ratio":   round(vol_ratio, 2),
        "volume_z_score": round(vol_z_score, 2),
        "adv_20":         round(adv_20, 0),
        "obv_trend":      obv_signal,
        "vwap_20d":       safe_float(vwap_20.iloc[-1]),
        "price_vs_vwap":  "above" if cp > (vwap_20.iloc[-1] or cp) else "below",

        # Support / Resistance
        "support_resistance": sr,

        # Returns
        "return_1d":  pct_return(1),
        "return_5d":  pct_return(5),
        "return_20d": pct_return(20),
        "return_60d": pct_return(60),
        "return_90d": pct_return(90),

        # Signal
        "composite_signal": composite,
        "signal_score":     round(signal_score, 3),
        "confidence":       round(confidence, 3),
        "buy_signals":      buy_signals,
        "sell_signals":     sell_signals,
        "target":           target,
        "stop_loss":        stop_loss,
        "entry_range":      [entry_low, entry_high],

        # Fundamentals
        "fundamentals": fundamentals,

        # Chart data
        "chart_data": chart_data,
    }
