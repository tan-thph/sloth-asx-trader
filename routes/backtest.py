"""
routes/backtest.py — Historical strategy backtesting + AI replay.

Endpoints:
  /api/backtest             POST — run strategy backtest on yfinance history.
  /api/backtest/ai-replay   POST — measure forward returns on executed AI recs.
"""

import math
import datetime as _dt

import yfinance as yf
from flask import Blueprint, jsonify, request

from core import adv_slippage
from indicators import (
    asx, safe_float,
    compute_rsi, compute_macd, compute_bollinger, compute_adx, compute_atr,
)


bp = Blueprint("backtest", __name__)


@bp.route("/api/backtest", methods=["POST"])
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
    data = request.get_json() or {}

    # Improvement C: validate all inputs before reaching yfinance/strategy code.
    _ALLOWED_PERIODS    = {"3mo", "6mo", "1y", "2y"}
    _ALLOWED_STRATEGIES = {"rsi_trend", "macd", "bb_reversion", "momentum", "buy_hold",
                           "sma_crossover"}
    _ALLOWED_SLIPPAGE   = {"flat", "liquidity"}

    tickers = data.get("tickers", [])
    if not isinstance(tickers, list) or not tickers:
        return jsonify({"error": "tickers must be a non-empty list"}), 400
    if len(tickers) > 100:
        return jsonify({"error": "tickers list must contain at most 100 items"}), 400

    period = data.get("period", "1y")
    if period not in _ALLOWED_PERIODS:
        return jsonify({"error": f"period must be one of {sorted(_ALLOWED_PERIODS)}"}), 400

    strategy = data.get("strategy", "rsi_trend")
    if strategy not in _ALLOWED_STRATEGIES:
        return jsonify({"error": f"strategy must be one of {sorted(_ALLOWED_STRATEGIES)}"}), 400

    slippage_mode = data.get("slippage_mode", "flat")
    if slippage_mode not in _ALLOWED_SLIPPAGE:
        return jsonify({"error": f"slippage_mode must be one of {sorted(_ALLOWED_SLIPPAGE)}"}), 400

    try:
        starting_capital = float(data.get("capital", 50000))
        if starting_capital <= 0 or starting_capital > 10_000_000:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"error": "capital must be a number between 1 and 10,000,000"}), 400

    try:
        brokerage = float(data.get("brokerage", 10))
        if brokerage < 0 or brokerage > 1000:
            raise ValueError
    except (ValueError, TypeError):
        return jsonify({"error": "brokerage must be a number between 0 and 1000"}), 400

    try:
        slippage_pct = float(data.get("slippage_pct", 0.10)) / 100  # e.g. 0.10 → 0.001
    except (ValueError, TypeError):
        return jsonify({"error": "slippage_pct must be a number"}), 400

    # ADV-tiered slippage hoisted to core.adv_slippage (§9.2) — shared with the
    # learning loop's virtual-outcome and execution-alpha resolvers.
    _adv_slippage = adv_slippage

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

            # ── Per-ticker slippage (overrides flat rate when mode=liquidity) ──
            ticker_slip = slippage_pct  # default: use flat rate from request
            if slippage_mode == "liquidity":
                adv = float((close * volume).rolling(20).mean().iloc[-1])
                ticker_slip = _adv_slippage(adv)

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
                if math.isnan(float(price)) or price <= 0:
                    continue
                date_str = close.index[i].strftime("%Y-%m-%d")

                if strategy == "rsi_trend":
                    # Buy: RSI < 45 (mild short-term weakness) AND price > SMA50
                    # (medium-term uptrend intact).
                    # RSI < 40 required a severe 10-15 day decline which almost always
                    # breaks SMA20 too. RSI < 45 fires on 3-5 weak days — shallow enough
                    # that SMA50 (2.5 months of history) is still below current price.
                    _sma50 = safe_float(sma_50.iloc[i], None) or price
                    _rsi_v = safe_float(rsi.iloc[i], 50)
                    buy_sig = _rsi_v < 45 and price > _sma50
                    # Sell: RSI overbought OR price drops >3% below SMA50 (trend broken)
                    sell_sig = _rsi_v > 70 or price < _sma50 * 0.97

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

                elif strategy == "sma_crossover":
                    # Golden cross: fast SMA crosses above slow SMA → buy
                    # Death cross: fast SMA crosses below slow SMA → sell
                    _sma_fast_cur  = safe_float(sma_20.iloc[i],   None) or price
                    _sma_slow_cur  = safe_float(sma_50.iloc[i],   None) or price
                    _sma_fast_prev = safe_float(sma_20.iloc[i-1], None) or price
                    _sma_slow_prev = safe_float(sma_50.iloc[i-1], None) or price
                    buy_sig  = _sma_fast_cur > _sma_slow_cur and _sma_fast_prev <= _sma_slow_prev
                    sell_sig = _sma_fast_cur < _sma_slow_cur and _sma_fast_prev >= _sma_slow_prev

                else:
                    buy_sig = sell_sig = False

                # Execute trades (entry cost includes slippage + brokerage; exit proceeds net both)
                if buy_sig and position == 0 and cash > brokerage * 2:
                    fill_price = price * (1 + ticker_slip)
                    qty = int((cash - brokerage) / fill_price)
                    if qty > 0:
                        cost = qty * fill_price + brokerage
                        cash -= cost
                        position = qty
                        entry_price = fill_price  # record slippage-adjusted entry
                        entry_date = date_str

                elif sell_sig and position > 0:
                    fill_price = price * (1 - ticker_slip)
                    proceeds = position * fill_price - brokerage
                    pnl = proceeds - (position * entry_price)
                    cash += proceeds
                    trades.append({
                        "ticker": ticker.upper(),
                        "entryDate": entry_date,
                        "exitDate": date_str,
                        "entryPrice": round(entry_price, 3),
                        "exitPrice": round(fill_price, 3),
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
                open_pnl = round(position * final_price * (1 - ticker_slip) - position * entry_price - brokerage, 2)
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
                "effectiveSlippagePct": round(ticker_slip * 100, 3),
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
                if math.isnan(float(price)) or price <= 0:
                    continue
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
                    _sma50e = safe_float(sma_50.iloc[i], None) or price
                    buy_sig = rsi_v < 45 and price > _sma50e
                    sell_sig = rsi_v > 70 or price < _sma50e * 0.97
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
                elif strategy == "sma_crossover":
                    _sf_cur  = safe_float(sma_20.iloc[i],   None) or price
                    _ss_cur  = safe_float(sma_50.iloc[i],   None) or price
                    _sf_prev = safe_float(sma_20.iloc[i-1], None) or price
                    _ss_prev = safe_float(sma_50.iloc[i-1], None) or price
                    buy_sig  = _sf_cur > _ss_cur and _sf_prev <= _ss_prev
                    sell_sig = _sf_cur < _ss_cur and _sf_prev >= _ss_prev
                else:
                    buy_sig = sell_sig = False

                if buy_sig and _pos == 0 and _cash > brokerage * 2:
                    fp = price * (1 + ticker_slip)
                    qty = int((_cash - brokerage) / fp)
                    if qty > 0:
                        _cash -= qty * fp + brokerage
                        _pos = qty
                        _ep = fp
                elif sell_sig and _pos > 0:
                    _cash += _pos * price * (1 - ticker_slip) - brokerage
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
    total_brokerage_cost = brokerage * 2 * len([t for t in all_trades if not t.get("isOpen")])
    # Slippage cost: use effective slippage from each ticker's result (fallback to flat rate)
    _slip_map = {
        k: v.get("effectiveSlippagePct", slippage_pct * 100) / 100
        for k, v in ticker_results.items() if isinstance(v, dict) and "effectiveSlippagePct" in v
    }
    total_slippage_cost = round(
        sum(
            t["qty"] * (t["entryPrice"] + t["exitPrice"])
            * _slip_map.get(t["ticker"], slippage_pct)
            for t in all_trades if not t.get("isOpen")
        ), 2
    )
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
        "slippagePct": round(slippage_pct * 100, 3),
        "slippageMode": slippage_mode,
        "totalReturn": round(total_return, 2),
        "totalPnl": round(total_pnl, 2),
        "totalBrokerageCost": round(total_brokerage_cost, 2),
        "totalSlippageCost": total_slippage_cost,
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
        # Price-basis metadata — displayed in the UI to avoid misinterpretation
        "priceBasis": "total_return_adjusted",
        "priceBasisNote": (
            "Prices use yfinance's dividend-adjusted (total-return) series. "
            "Dividends are notionally reinvested into the price, so returns reflect "
            "total return (capital gains + income), not pure price appreciation. "
            "Signal timing (RSI, MACD, BB, ADX) is unaffected — all are scale-invariant. "
            "Price levels in the trade log are adjusted and will be lower than the nominal "
            "price visible on a chart on that date."
        ),
    })


# ═══════════════════════════════════════════════════════════════════════════════
# Walk-forward backtesting helpers
# ═══════════════════════════════════════════════════════════════════════════════

# Parameter grids — one dict per strategy; each entry is one candidate param set.
_WF_PARAM_GRIDS = {
    "rsi_trend": [
        {"rsi_period": rp, "rsi_oversold": ob, "rsi_overbought": os_, "trend_period": tp}
        for rp in [10, 14, 21]
        for ob in [38, 42, 45, 48]
        for os_ in [65, 70, 75]
        for tp in [20, 50]
    ],
    "macd": [
        {"fast": f, "slow": s, "signal": sig}
        for f, s in [(8, 21), (12, 26), (10, 22)]
        for sig in [7, 9]
    ],
    "bb_reversion": [
        {"bb_period": p, "bb_std": std, "rsi_entry": re}
        for p in [14, 20]
        for std in [1.5, 2.0, 2.5]
        for re in [35, 40]
    ],
    "momentum": [
        {"adx_entry": ae, "adx_exit": ax, "trend_period": tp}
        for ae in [20, 25, 30]
        for ax in [15, 18, 22]
        for tp in [20, 50]
    ],
    "sma_crossover": [
        {"fast_period": fp, "slow_period": sp}
        for fp in [10, 20]
        for sp in [30, 50, 100]
    ],
}


def _run_strategy_slice(close, high, low, volume, strategy, params, capital, brokerage, slip_pct, trade_from_idx=0):
    """
    Run a single strategy with given params over a price slice.
    trade_from_idx: bars before this index compute indicators but don't execute trades (burn-in).
    Returns dict: {final_value, trades, sharpe, total_return_pct, win_rate, equity}.
    """
    import statistics

    n = len(close)
    if n < 40:
        return {"final_value": capital, "trades": [], "sharpe": 0, "total_return_pct": 0, "win_rate": 0}

    # Precompute indicators
    def _rsi(prices, period=14):
        deltas = [prices[i] - prices[i-1] for i in range(1, len(prices))]
        gains = [max(d, 0) for d in deltas]
        losses = [abs(min(d, 0)) for d in deltas]
        if len(gains) < period:
            return [50.0] * len(prices)
        avg_g = sum(gains[:period]) / period
        avg_l = sum(losses[:period]) / period
        rsi = [50.0] * (period + 1)
        for i in range(period, len(gains)):
            avg_g = (avg_g * (period - 1) + gains[i]) / period
            avg_l = (avg_l * (period - 1) + losses[i]) / period
            rs = avg_g / avg_l if avg_l > 0 else 100
            rsi.append(100 - 100 / (1 + rs))
        return [50.0] + rsi  # align length

    def _ema(prices, period):
        k = 2 / (period + 1)
        result = [prices[0]]
        for p in prices[1:]:
            result.append(p * k + result[-1] * (1 - k))
        return result

    def _sma(prices, period):
        result = [None] * (period - 1)
        for i in range(period - 1, len(prices)):
            result.append(sum(prices[i-period+1:i+1]) / period)
        return result

    def _bb(prices, period=20, std_mult=2.0):
        sma = _sma(prices, period)
        upper = [None] * len(prices)
        lower = [None] * len(prices)
        mid   = sma
        for i in range(period - 1, len(prices)):
            window = prices[i-period+1:i+1]
            sd = statistics.stdev(window)
            upper[i] = sma[i] + std_mult * sd
            lower[i] = sma[i] - std_mult * sd
        return upper, mid, lower

    def _atr(high, low, close, period=14):
        trs = [max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
               for i in range(1, len(high))]
        result = [None] + trs[:period-1]
        avg = sum(trs[:period]) / period
        result.append(avg)
        for tr in trs[period:]:
            avg = (avg * (period - 1) + tr) / period
            result.append(avg)
        return result

    def _adx_vals(high, low, close, period=14):
        """Returns (adx, plus_di, minus_di) lists."""
        pdm = [max(high[i] - high[i-1], 0) if (high[i] - high[i-1]) > (low[i-1] - low[i]) else 0
               for i in range(1, len(high))]
        mdm = [max(low[i-1] - low[i], 0) if (low[i-1] - low[i]) > (high[i] - high[i-1]) else 0
               for i in range(1, len(low))]
        trs = [max(high[i] - low[i], abs(high[i] - close[i-1]), abs(low[i] - close[i-1]))
               for i in range(1, len(high))]
        atr_sum = sum(trs[:period]) if len(trs) >= period else sum(trs)
        pdm_sum = sum(pdm[:period]) if len(pdm) >= period else sum(pdm)
        mdm_sum = sum(mdm[:period]) if len(mdm) >= period else sum(mdm)
        adx_vals = [25.0] * (period + 1)
        pdi_vals = [25.0] * (period + 1)
        mdi_vals = [25.0] * (period + 1)
        prev_dx = 25.0
        for i in range(period, len(trs)):
            atr_sum = atr_sum - atr_sum / period + trs[i]
            pdm_sum = pdm_sum - pdm_sum / period + pdm[i]
            mdm_sum = mdm_sum - mdm_sum / period + mdm[i]
            pdi = 100 * pdm_sum / atr_sum if atr_sum > 0 else 0
            mdi = 100 * mdm_sum / atr_sum if atr_sum > 0 else 0
            dx = 100 * abs(pdi - mdi) / (pdi + mdi) if (pdi + mdi) > 0 else 0
            adx_val = (prev_dx * (period - 1) + dx) / period
            adx_vals.append(adx_val)
            pdi_vals.append(pdi)
            mdi_vals.append(mdi)
            prev_dx = adx_val
        return adx_vals, pdi_vals, mdi_vals

    prices = list(close)
    highs  = list(high)
    lows   = list(low)

    # Strategy-specific indicator precompute
    rp = params.get("rsi_period", 14)
    ob = params.get("rsi_oversold", 45)
    os_ = params.get("rsi_overbought", 70)
    fast = params.get("fast", 12)
    slow = params.get("slow", 26)
    sig_period = params.get("signal", 9)
    bb_period = params.get("bb_period", 20)
    bb_std = params.get("bb_std", 2.0)
    rsi_entry = params.get("rsi_entry", 40)
    adx_entry = params.get("adx_entry", 25)
    adx_exit  = params.get("adx_exit", 18)
    trend_period = params.get("trend_period", 50)
    fast_period  = params.get("fast_period", 20)
    slow_period  = params.get("slow_period", 50)

    rsi_vals  = _rsi(prices, rp)
    ema_fast  = _ema(prices, fast)
    ema_slow  = _ema(prices, slow)
    macd_line = [ema_fast[i] - ema_slow[i] for i in range(len(prices))]
    macd_sig  = _ema(macd_line, sig_period)
    macd_hist = [macd_line[i] - macd_sig[i] for i in range(len(prices))]
    bb_upper, bb_mid, bb_lower = _bb(prices, bb_period, bb_std)
    sma_trend = _sma(prices, trend_period)
    sma_fast  = _sma(prices, fast_period)
    sma_slow  = _sma(prices, slow_period)
    adx_v, pdi_v, mdi_v = _adx_vals(highs, lows, prices)

    cash = capital
    position = 0
    entry_price = None
    trades = []
    equity = []
    warmup = max(50, slow + sig_period, trend_period, slow_period)
    # Effective start: indicators need warmup bars; trade_from_idx may extend this for burn-in.
    start_idx = min(warmup, trade_from_idx) if trade_from_idx > warmup else warmup

    for i in range(start_idx, n):
        price = prices[i]
        if price <= 0:
            if i >= trade_from_idx:
                equity.append(cash + position * price)
            continue

        rv = rsi_vals[i] if i < len(rsi_vals) else 50
        mh = macd_hist[i] if i < len(macd_hist) else 0
        mh_prev = macd_hist[i-1] if i > 0 and i - 1 < len(macd_hist) else 0
        bbu = bb_upper[i] if i < len(bb_upper) and bb_upper[i] is not None else price * 1.04
        bbm = bb_mid[i] if i < len(bb_mid) and bb_mid[i] is not None else price
        bbl = bb_lower[i] if i < len(bb_lower) and bb_lower[i] is not None else price * 0.96
        smt = sma_trend[i] if i < len(sma_trend) and sma_trend[i] is not None else price
        adx = adx_v[i] if i < len(adx_v) else 20
        pdi = pdi_v[i] if i < len(pdi_v) else 20
        mdi = mdi_v[i] if i < len(mdi_v) else 20

        if i >= trade_from_idx:
            if strategy == "rsi_trend":
                # Buy: RSI oversold AND price above trend SMA (default SMA20).
                # MACD > 0 removed — contradicts RSI < oversold.
                buy_sig  = rv < ob and price > smt
                sell_sig = rv > os_ or price < smt * 0.97
            elif strategy == "macd":
                buy_sig  = mh > 0 and mh_prev <= 0
                sell_sig = mh < 0 and mh_prev >= 0
            elif strategy == "bb_reversion":
                buy_sig  = bbl is not None and price <= bbl * 1.005 and rv < rsi_entry
                sell_sig = position > 0 and bbm is not None and price >= bbm * 0.995
            elif strategy == "momentum":
                buy_sig  = adx > adx_entry and pdi > mdi and price > smt
                sell_sig = adx < adx_exit or mdi > pdi
            elif strategy == "buy_hold":
                buy_sig  = position == 0 and i == trade_from_idx
                sell_sig = False
            elif strategy == "sma_crossover":
                sf_cur  = sma_fast[i]  if i < len(sma_fast)  and sma_fast[i]  is not None else price
                ss_cur  = sma_slow[i]  if i < len(sma_slow)  and sma_slow[i]  is not None else price
                sf_prev = sma_fast[i-1] if i > 0 and i-1 < len(sma_fast) and sma_fast[i-1] is not None else price
                ss_prev = sma_slow[i-1] if i > 0 and i-1 < len(sma_slow) and sma_slow[i-1] is not None else price
                buy_sig  = sf_cur > ss_cur and sf_prev <= ss_prev
                sell_sig = sf_cur < ss_cur and sf_prev >= ss_prev
            else:
                buy_sig = sell_sig = False

            if buy_sig and position == 0 and cash > brokerage * 2:
                fp = price * (1 + slip_pct)
                qty = int((cash - brokerage) / fp)
                if qty > 0:
                    cash -= qty * fp + brokerage
                    position = qty
                    entry_price = fp

            elif sell_sig and position > 0:
                fp = price * (1 - slip_pct)
                pnl = position * fp - brokerage - position * entry_price
                cash += position * fp - brokerage
                trades.append({"pnl": round(pnl, 2), "entry": round(entry_price, 3), "exit": round(fp, 3)})
                position = 0
                entry_price = None

            equity.append(cash + position * price)

    # Close open position at end of slice
    if position > 0 and entry_price:
        fp = prices[-1] * (1 - slip_pct)
        pnl = position * fp - brokerage - position * entry_price
        cash += position * fp - brokerage
        trades.append({"pnl": round(pnl, 2), "entry": round(entry_price, 3), "exit": round(fp, 3), "forced_close": True})

    final_value = cash
    total_return_pct = round((final_value / capital - 1) * 100, 2) if capital > 0 else 0
    wins = [t for t in trades if t["pnl"] > 0]
    win_rate = round(len(wins) / len(trades) * 100, 1) if trades else 0

    # Annualised Sharpe from equity curve
    sharpe = 0.0
    try:
        if len(equity) > 20:
            daily_rets = [(equity[i] / equity[i-1] - 1) for i in range(1, len(equity)) if equity[i-1] > 0]
            if len(daily_rets) > 5:
                mean_r = statistics.mean(daily_rets)
                std_r  = statistics.stdev(daily_rets)
                rf_d   = 0.041 / 252
                sharpe = round((mean_r - rf_d) / std_r * math.sqrt(252), 3) if std_r > 0 else 0.0
    except Exception:
        pass

    return {
        "final_value": round(final_value, 2),
        "trades": trades,
        "sharpe": sharpe,
        "total_return_pct": total_return_pct,
        "win_rate": win_rate,
        "equity": equity,
    }


@bp.route("/api/backtest/walk-forward", methods=["POST"])
def backtest_walk_forward():
    """
    Walk-forward backtest: rolling train/test windows with in-sample parameter
    optimisation and out-of-sample performance measurement.

    Body: {
        "ticker":      "CBA",
        "period":      "3y",      // 2y | 3y | 5y
        "strategy":    "rsi_trend",
        "capital":     50000,
        "brokerage":   10,
        "slippage_pct": 0.10,
        "n_splits":    5,         // number of walk-forward folds
        "train_ratio": 0.70       // fraction of each window used for training
    }
    Returns per-fold results + combined out-of-sample equity curve + aggregate stats.
    """
    data = request.get_json() or {}
    ticker      = data.get("ticker", "")
    period      = data.get("period", "3y")
    strategy    = data.get("strategy", "rsi_trend")
    capital     = float(data.get("capital", 50000))
    brokerage   = float(data.get("brokerage", 10))
    slip_pct    = float(data.get("slippage_pct", 0.10)) / 100
    n_splits    = int(data.get("n_splits", 5))
    train_ratio = float(data.get("train_ratio", 0.70))

    if not ticker:
        return jsonify({"error": "ticker required"}), 400
    if strategy not in _WF_PARAM_GRIDS and strategy != "buy_hold":
        return jsonify({"error": f"strategy '{strategy}' not supported for walk-forward"}), 400
    if n_splits < 2 or n_splits > 10:
        return jsonify({"error": "n_splits must be 2–10"}), 400

    t_sym = asx(ticker)
    try:
        stk  = yf.Ticker(t_sym)
        hist = stk.history(period=period, auto_adjust=True)
    except Exception as e:
        return jsonify({"error": f"yfinance fetch failed: {e}"}), 500

    if hist.empty or len(hist) < 150:
        return jsonify({"error": f"Insufficient data for {ticker} (need ≥150 bars; got {len(hist)})"}), 422

    close  = list(hist["Close"])
    high   = list(hist["High"])
    low    = list(hist["Low"])
    volume = list(hist["Volume"])
    dates  = [d.strftime("%Y-%m-%d") for d in hist.index]

    n_bars = len(close)
    param_grid = _WF_PARAM_GRIDS.get(strategy, [{}])

    # Divide the full bar range into n_splits consecutive, non-overlapping TEST windows.
    # Each fold = [fold_start .. fold_end], with [fold_start .. train_end] as train
    # and [train_end+1 .. fold_end] as test.
    fold_size  = n_bars // n_splits
    min_warmup = 60  # bars needed before signals become reliable

    folds = []
    oos_equity   = []          # combined out-of-sample equity curve
    oos_all_pnls = []

    oos_capital = capital / n_splits  # each fold trades an equal share of capital

    for split_idx in range(n_splits):
        fold_start = split_idx * fold_size
        fold_end   = (fold_start + fold_size) if split_idx < n_splits - 1 else n_bars
        fold_len   = fold_end - fold_start

        if fold_len < min_warmup + 20:
            continue

        train_end = fold_start + max(min_warmup, int(fold_len * train_ratio))
        test_start = train_end
        test_end   = fold_end

        if test_end - test_start < 10:
            continue

        c_train = close[fold_start:train_end]
        h_train = high[fold_start:train_end]
        l_train = low[fold_start:train_end]
        v_train = volume[fold_start:train_end]

        # Prepend burn-in bars from training window so indicators warm up before OOS trading.
        BURNIN = 65  # enough to cover max warmup (max(50, slow+signal, trend_period))
        burn_start  = max(fold_start, test_start - BURNIN)
        actual_burnin = test_start - burn_start

        c_test = close[burn_start:test_end]
        h_test = high[burn_start:test_end]
        l_test = low[burn_start:test_end]
        v_test = volume[burn_start:test_end]

        # ── Grid-search on training window ────────────────────────────────────
        best_params = param_grid[0]
        best_sharpe = -999
        for params in param_grid:
            res = _run_strategy_slice(c_train, h_train, l_train, v_train,
                                      strategy, params, oos_capital, brokerage, slip_pct)
            if res["sharpe"] > best_sharpe:
                best_sharpe = res["sharpe"]
                best_params = params

        train_result = _run_strategy_slice(c_train, h_train, l_train, v_train,
                                           strategy, best_params, oos_capital, brokerage, slip_pct)

        # ── Apply best params to test (OOS) window with burn-in prefix ────────
        test_result = _run_strategy_slice(c_test, h_test, l_test, v_test,
                                          strategy, best_params, oos_capital, brokerage, slip_pct,
                                          trade_from_idx=actual_burnin)

        oos_all_pnls.extend([t["pnl"] for t in test_result["trades"]])

        # Build OOS equity curve segment (equity list starts at trade_from_idx)
        for j, val in enumerate(test_result["equity"]):
            date_idx = test_start + j
            dt = dates[date_idx] if date_idx < len(dates) else dates[-1]
            oos_equity.append({"date": dt, "value": round(val, 2)})

        folds.append({
            "fold":             split_idx + 1,
            "train_start":      dates[fold_start],
            "train_end":        dates[train_end - 1],
            "test_start":       dates[test_start],
            "test_end":         dates[test_end - 1],
            "best_params":      best_params,
            "train_return_pct": train_result["total_return_pct"],
            "train_sharpe":     round(best_sharpe, 3),
            "train_trades":     len(train_result["trades"]),
            "test_return_pct":  test_result["total_return_pct"],
            "test_sharpe":      test_result["sharpe"],
            "test_trades":      len(test_result["trades"]),
            "test_win_rate":    test_result["win_rate"],
        })

    if not folds:
        return jsonify({"error": "Not enough data to build any walk-forward folds"}), 422

    # ── Buy-and-hold benchmark (same period, same capital) ────────────────────
    bh_result = _run_strategy_slice(close, high, low, volume,
                                    "buy_hold", {}, capital, brokerage, slip_pct)

    # ── OOS aggregate stats ───────────────────────────────────────────────────
    import statistics as _stats

    oos_wins   = [p for p in oos_all_pnls if p > 0]
    oos_losses = [p for p in oos_all_pnls if p <= 0]
    oos_total_pnl = round(sum(oos_all_pnls), 2)

    # Reconstruct combined OOS curve starting at 'capital'
    oos_combined_curve = []
    if oos_equity:
        scale = capital / oos_capital  # scale up from per-fold capital
        running = capital
        for pt in oos_equity:
            oos_combined_curve.append({"date": pt["date"], "value": round(pt["value"] * scale, 2)})

    # OOS Sharpe
    oos_sharpe = None
    try:
        vals = [pt["value"] for pt in oos_combined_curve]
        if len(vals) > 20:
            dr = [(vals[i] / vals[i-1] - 1) for i in range(1, len(vals)) if vals[i-1] > 0]
            if len(dr) > 5:
                mean_r = _stats.mean(dr)
                std_r  = _stats.stdev(dr)
                rf_d   = 0.041 / 252
                oos_sharpe = round((mean_r - rf_d) / std_r * math.sqrt(252), 2) if std_r > 0 else None
    except Exception:
        pass

    # OOS max drawdown
    oos_max_dd = None
    try:
        vals = [pt["value"] for pt in oos_combined_curve]
        if vals:
            peak = vals[0]
            worst = 0.0
            for v in vals:
                if v > peak: peak = v
                dd = (v - peak) / peak * 100 if peak > 0 else 0
                if dd < worst: worst = dd
            oos_max_dd = round(worst, 2)
    except Exception:
        pass

    # OOS total return from combined curve
    oos_return_pct = None
    if oos_combined_curve:
        start_val = oos_combined_curve[0]["value"]
        end_val   = oos_combined_curve[-1]["value"]
        oos_return_pct = round((end_val / start_val - 1) * 100, 2) if start_val > 0 else None

    return jsonify({
        "ok":             True,
        "ticker":         ticker.upper(),
        "strategy":       strategy,
        "period":         period,
        "n_splits":       n_splits,
        "train_ratio":    train_ratio,
        "capital":        capital,
        "folds":          folds,
        "oos_equity_curve": oos_combined_curve,
        "oos_return_pct": oos_return_pct,
        "oos_sharpe":     oos_sharpe,
        "oos_max_drawdown_pct": oos_max_dd,
        "oos_total_pnl":  oos_total_pnl,
        "oos_trades":     len(oos_all_pnls),
        "oos_win_rate":   round(len(oos_wins) / len(oos_all_pnls) * 100, 1) if oos_all_pnls else 0,
        "oos_avg_win":    round(sum(oos_wins) / len(oos_wins), 2) if oos_wins else 0,
        "oos_avg_loss":   round(sum(oos_losses) / len(oos_losses), 2) if oos_losses else 0,
        "buy_hold_return_pct": bh_result["total_return_pct"],
        "data_bars":      n_bars,
        "price_basis":    "total_return_adjusted",
    })


# ── AI Recommendation Replay ───────────────────────────────────────────────────
@bp.route("/api/backtest/ai-replay", methods=["POST"])
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
            # auto_adjust=False: nominal (unadjusted) prices so the forward exit price
            # is on the same basis as the actual executedPrice captured at trade time.
            # auto_adjust=True would adjust historical closes for dividends paid AFTER
            # each bar's date, creating a mixed basis (nominal entry vs adjusted exit)
            # that understates BUY returns by ~div_yield and overstates SELL returns.
            hist  = stk.history(start=start, end=end, auto_adjust=False)
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
        # Price-basis metadata
        "priceBasis":      "nominal_unadjusted",
        "priceBasisNote":  (
            "Forward exit prices are nominal (unadjusted) closes, matching the basis of "
            "your actual executedPrice. Ex-dividend gaps during the measurement window "
            "appear as price drops, consistent with real mark-to-market P&L."
        ),
    })
