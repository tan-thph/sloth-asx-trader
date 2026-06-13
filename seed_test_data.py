"""seed_test_data.py — Sprint 70 deterministic-tagging test seed.

The live DB has only SELL/TRIM events (no BUY parents), so the new deterministic
skill scorer (which needs thesis_verdict) and the thesis-accuracy matrix have
nothing to operate on. This script creates one synthetic *closed BUY/TOP_UP entry*
per existing SELL/TRIM event so those features can be exercised.

Grounded in REAL data (yfinance): entry/exit prices, entry technicals
(RSI/BB/ADX/ATR), peer correlations, P&L, and the thesis verdict are all computed
from actual historical bars. The only *synthetic* assumption is that each position
was opened ENTRY_LOOKBACK trading days before it was sold, at the real close.

Every row is tagged  notes='TEST_SEED_SPRINT70'  and uses prompt_version='TEST'.
Remove them with:
    env/Scripts/python.exe seed_test_data.py --clean
"""
import sys
import json
import datetime as dt

import pandas as pd
import yfinance as yf

from db import get_db, init_db
from indicators import (
    asx, compute_rsi, compute_bollinger, compute_atr, compute_adx,
)
from routes.learning import (
    classify_entry_driver, _resolve_deterministic_tags,
)

TAG = "TEST_SEED_SPRINT70"
ENTRY_LOOKBACK = 45          # trading days before the sell that we pretend we bought
NOTIONAL_AUD   = 5000.0      # assumed position size for realized_pnl_aud
RR_CYCLE       = [1.2, 1.8, 2.2, 2.5]   # vary planned R:R so error tags get coverage
CONF_CYCLE     = [0.68, 0.78, 0.83, 0.71]


def _thesis_verdict(driver, e, n):
    """Python port of js/learning-loop.js computeThesisDrift() — same rules."""
    def g(d, k):
        v = d.get(k)
        try:
            return float(v) if v is not None else None
        except (TypeError, ValueError):
            return None
    eRsi, eBB = g(e, "rsi_14"), g(e, "bb_pct_b")
    nRsi, nBB, nAdx, nRet5 = g(n, "rsi_14"), g(n, "bb_pct_b"), g(n, "adx_14"), g(n, "return_5d")
    if driver == "mean_reversion":
        reverted = (eBB is not None and nBB is not None and eBB < 0.25 and nBB > 0.45) \
            or (eRsi is not None and nRsi is not None and eRsi < 35 and nRsi > 45)
        worsened = (eBB is not None and nBB is not None and nBB < eBB - 0.05) \
            or (eRsi is not None and nRsi is not None and nRsi < eRsi - 3)
        return "validated" if reverted else ("invalidated" if worsened else "irrelevant")
    if driver == "momentum_breakout":
        sustained = nRet5 is not None and nRet5 > 0 and (nBB is None or nBB > 0.55)
        invalid = nRet5 is not None and (nRet5 < 0 or (nBB is not None and nBB < 0.45))
        return "validated" if sustained else ("invalidated" if invalid else "irrelevant")
    if driver == "trend_pullback":
        resumed = nRet5 is not None and nRet5 > 0 and (nAdx is None or nAdx > 20)
        broke = (nAdx is not None and nAdx < 20) or (nRet5 is not None and nRet5 < -3)
        return "validated" if resumed else ("invalidated" if broke else "irrelevant")
    return "irrelevant"


def _clean():
    with get_db() as conn:
        n = conn.execute("DELETE FROM ai_learning_events WHERE notes=?", (TAG,)).rowcount
    print(f"Removed {n} test-seed rows (notes='{TAG}').")


def _entry_signals_at(hist, idx):
    """Compute the 6-field entry_signals snapshot at integer position `idx`."""
    close, high, low = hist["Close"], hist["High"], hist["Low"]
    rsi = compute_rsi(close)
    up, _mid, lo = compute_bollinger(close)
    adx, _p, _m = compute_adx(high, low, close)
    atr = compute_atr(high, low, close)
    c = float(close.iloc[idx])
    bb_rng = float(up.iloc[idx] - lo.iloc[idx])
    return {
        "rsi_14":    round(float(rsi.iloc[idx]), 2),
        "bb_pct_b":  round((c - float(lo.iloc[idx])) / bb_rng, 4) if bb_rng else None,
        "adx_14":    round(float(adx.iloc[idx]), 2),
        "atr_pct":   round(float(atr.iloc[idx]) / c * 100, 4) if c else None,
        "return_5d": round((c / float(close.iloc[idx - 5]) - 1) * 100, 4),
        "return_20d": round((c / float(close.iloc[idx - 20]) - 1) * 100, 4),
    }, c


def _seed():
    init_db()
    with get_db() as conn:
        sells = conn.execute("""
            SELECT id, ticker, timestamp, regime, sector, entry_signals_json
              FROM ai_learning_events
             WHERE recommendation IN ('SELL','TRIM')
               AND (notes IS NULL OR notes != ?)
             ORDER BY id
        """, (TAG,)).fetchall()
        existing = conn.execute(
            "SELECT COUNT(*) FROM ai_learning_events WHERE notes=?", (TAG,)).fetchone()[0]

    if existing:
        print(f"{existing} test-seed rows already present — run with --clean first to reseed.")
        return
    if not sells:
        print("No SELL/TRIM events found to base test entries on.")
        return

    tickers = sorted({s["ticker"] for s in sells})
    print(f"Fetching real history for {len(tickers)} tickers via yfinance...")

    hist_by_ticker, close_by_ticker = {}, {}
    for t in tickers:
        try:
            h = yf.download(asx(t), period="1y", auto_adjust=True, progress=False)
            if isinstance(h.columns, pd.MultiIndex):
                h.columns = h.columns.get_level_values(0)
            h = h.dropna(subset=["Close"])
            if len(h) > ENTRY_LOOKBACK + 25:
                hist_by_ticker[t] = h
                close_by_ticker[t] = h["Close"]
        except Exception as e:
            print(f"  ! {t}: fetch failed ({e})")

    # Peer correlation matrix from real daily returns
    corr = pd.DataFrame(close_by_ticker).pct_change().corr() if len(close_by_ticker) >= 2 else None

    def max_corr_to_others(t):
        if corr is None or t not in corr.columns:
            return None
        row = corr[t].drop(labels=[t], errors="ignore")
        row = row[row.apply(lambda v: pd.notna(v) and abs(v) <= 1.0)]
        if row.empty:
            return None
        return round(float(row.loc[row.abs().idxmax()]), 2)

    rows, summary = [], []
    for i, s in enumerate(sells):
        t = s["ticker"]
        hist = hist_by_ticker.get(t)
        if hist is None:
            continue
        close, high, low = hist["Close"], hist["High"], hist["Low"]

        # locate the sell bar, then step back ENTRY_LOOKBACK trading days for entry
        try:
            sell_dt = dt.datetime.fromisoformat(s["timestamp"]).date()
        except Exception:
            sell_dt = hist.index[-1].date()
        sell_idx = hist.index.searchsorted(pd.Timestamp(sell_dt))
        sell_idx = min(max(sell_idx, ENTRY_LOOKBACK + 22), len(hist) - 1)
        entry_idx = sell_idx - ENTRY_LOOKBACK

        entry_sig, entry_px = _entry_signals_at(hist, entry_idx)
        try:
            exit_sig = json.loads(s["entry_signals_json"]) if s["entry_signals_json"] else {}
        except Exception:
            exit_sig = {}

        driver = classify_entry_driver(entry_sig)
        if driver == "unknown":
            driver = "momentum_breakout" if entry_sig["return_20d"] > 0 else "mean_reversion"
        verdict = _thesis_verdict(driver, entry_sig, exit_sig)

        # planned stop/target from real ATR; vary R:R for tag coverage
        atr_abs = entry_px * (entry_sig["atr_pct"] or 2.0) / 100.0
        stop_px = round(entry_px - 2.5 * atr_abs, 4)
        rr = RR_CYCLE[i % len(RR_CYCLE)]
        target_px = round(entry_px + rr * (entry_px - stop_px), 4)

        # walk the real path entry→sell, STOP-FIRST, to set exit_reason + exit price
        path = hist.iloc[entry_idx + 1: sell_idx + 1]
        exit_reason, exit_px = "manual", float(close.iloc[sell_idx])
        for _, bar in path.iterrows():
            if float(bar["Low"]) <= stop_px:
                exit_reason, exit_px = "stop_hit", stop_px; break
            if float(bar["High"]) >= target_px:
                exit_reason, exit_px = "target_hit", target_px; break

        pnl_pct = round((exit_px - entry_px) / entry_px * 100, 3)
        outcome = "win" if pnl_pct > 0.5 else ("loss" if pnl_pct < -0.5 else "breakeven")
        hold_days = int((hist.index[sell_idx] - hist.index[entry_idx]).days)
        conf = CONF_CYCLE[i % len(CONF_CYCLE)]
        rec = "TOP_UP" if i % 5 == 0 else "BUY"
        mc = {"rba_rate": 4.35, "max_corr_to_holdings": max_corr_to_others(t)}

        rows.append((
            "recommendation", t, rec, s["regime"] or "unknown", "TEST", conf,
            f"[TEST SEED] {driver} entry on {t}", stop_px, target_px, round(rr, 2),
            outcome, pnl_pct, round(NOTIONAL_AUD * pnl_pct / 100, 2), hold_days,
            exit_reason, 1, round(entry_px, 4), round(exit_px, 4), s["sector"],
            json.dumps(mc), json.dumps(entry_sig), driver, verdict,
            f"Synthetic test entry ({driver}); paired with sell event #{s['id']}",
            TAG, hist.index[entry_idx].strftime("%Y-%m-%d %H:%M:%S"),
        ))
        summary.append((t, rec, driver, verdict, outcome, pnl_pct, exit_reason, conf, rr))

    if not rows:
        print("No rows built (insufficient history?).")
        return

    with get_db() as conn:
        conn.executemany("""
            INSERT INTO ai_learning_events
              (event_type, ticker, recommendation, regime, prompt_version, ai_confidence,
               rationale_summary, suggested_stop, suggested_target, rr_ratio,
               outcome_status, realized_pnl_pct, realized_pnl_aud, holding_period_days,
               exit_reason, was_executed, actual_entry_price, actual_exit_price, sector,
               market_context, entry_signals_json, primary_entry_driver, thesis_verdict,
               trade_thesis, notes, timestamp)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        """, rows)
        # Now exercise the Sprint 70 deterministic resolver on the fresh entries.
        resolved = _resolve_deterministic_tags(conn)
        tagged = conn.execute("""
            SELECT ticker, recommendation, primary_entry_driver, thesis_verdict,
                   outcome_status, realized_pnl_pct, error_type, error_type_source, skill_score
              FROM ai_learning_events WHERE notes=? ORDER BY id
        """, (TAG,)).fetchall()

    print(f"\nInserted {len(rows)} synthetic closed BUY/TOP_UP entries (notes='{TAG}').")
    print(f"_resolve_deterministic_tags() filled {resolved} rows.\n")
    print(f"{'ticker':7}{'rec':7}{'driver':18}{'verdict':12}{'outcome':9}"
          f"{'pnl%':>7}  {'error_type':16}{'skill':>5}")
    print("-" * 90)
    for r in tagged:
        print(f"{r['ticker']:7}{r['recommendation']:7}{(r['primary_entry_driver'] or '-'):18}"
              f"{(r['thesis_verdict'] or '-'):12}{r['outcome_status']:9}"
              f"{r['realized_pnl_pct']:>7.1f}  {(r['error_type'] or '-'):16}"
              f"{('-' if r['skill_score'] is None else f'{r['skill_score']:.1f}'):>5}")
    print(f"\nClean up with:  env/Scripts/python.exe seed_test_data.py --clean")


if __name__ == "__main__":
    if "--clean" in sys.argv:
        _clean()
    else:
        _seed()
