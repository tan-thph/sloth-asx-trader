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
    data = request.get_json()
    tickers = data.get("tickers", [])
    period = data.get("period", "1y")
    starting_capital = float(data.get("capital", 50000))
    strategy = data.get("strategy", "rsi_trend")
    brokerage = float(data.get("brokerage", 10))
    slippage_pct = float(data.get("slippage_pct", 0.10)) / 100  # e.g. 0.10 → 0.001

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

                # Execute trades (entry cost includes slippage + brokerage; exit proceeds net both)
                if buy_sig and position == 0 and cash > brokerage * 2:
                    fill_price = price * (1 + slippage_pct)
                    qty = int((cash - brokerage) / fill_price)
                    if qty > 0:
                        cost = qty * fill_price + brokerage
                        cash -= cost
                        position = qty
                        entry_price = fill_price  # record slippage-adjusted entry
                        entry_date = date_str

                elif sell_sig and position > 0:
                    fill_price = price * (1 - slippage_pct)
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
                open_pnl = round(position * final_price * (1 - slippage_pct) - position * entry_price - brokerage, 2)
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
                    fp = price * (1 + slippage_pct)
                    qty = int((_cash - brokerage) / fp)
                    if qty > 0:
                        _cash -= qty * fp + brokerage
                        _pos = qty
                        _ep = fp
                elif sell_sig and _pos > 0:
                    _cash += _pos * price * (1 - slippage_pct) - brokerage
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
    # Slippage cost = round-trip cost per trade: entry_slip + exit_slip per share × qty × price (approx)
    total_slippage_cost = round(
        sum(t["qty"] * (t["entryPrice"] + t["exitPrice"]) * slippage_pct for t in all_trades if not t.get("isOpen")), 2
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
