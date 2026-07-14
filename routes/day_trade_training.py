"""
routes/day_trade_training.py — Day trading ML training pipeline.

Endpoints:
  POST /api/daytrading/snapshot           — record entry snapshot
  PATCH /api/daytrading/snapshot/<id>/close — patch with exit outcome
  GET  /api/daytrading/history            — paginated trade history
  GET  /api/daytrading/stats              — summary statistics
  POST /api/daytrading/train              — run logistic regression (pure numpy)
  GET  /api/daytrading/model              — latest model weights + feature importances
  POST /api/daytrading/predict            — win-probability from a feature dict
  DELETE /api/daytrading/snapshot/<id>   — remove a record

No Claude API calls — all computation is local numpy.
"""

from flask import Blueprint, jsonify, request
from day_trade_db import get_dt_db

bp = Blueprint("day_trade_training", __name__)

# ─── Feature set (must stay identical between training and prediction) ─────────
FEATURES = [
    "rsi_14",        "bb_pct_b",      "bb_bandwidth",  "atr_pct",
    "adx",           "volume_zscore", "mfi_14",        "stoch_k",
    "williams_r",    "cci_20",        "setup_score",
    "price_vs_sma20", "price_vs_sma50",
    "asx200_5d_ret", "adl_ratio",
    "intraday_rsi",  "vwap_position", "volume_accel",
]

# Swing-only features (no intraday-specific indicators)
FEATURES_SWING = [
    "rsi_14", "bb_pct_b", "bb_bandwidth", "atr_pct",
    "adx", "volume_zscore", "mfi_14", "stoch_k",
    "williams_r", "cci_20", "setup_score",
    "price_vs_sma20", "price_vs_sma50",
    "asx200_5d_ret", "adl_ratio", "regime_risk",
]  # 16 features

# Intraday features (swing + 3 intraday-specific)
FEATURES_INTRADAY = FEATURES_SWING + [
    "intraday_rsi", "vwap_position", "volume_accel",
]  # 19 features

# Regime as an ordinal risk feature (Sprint 61) — DERIVED at training time from the
# snapshot's stored `regime` TEXT column: no schema change, applies retroactively to
# every historical snapshot. Unknown/absent regime → None → mean-imputed like any
# other missing feature. Keep this map in sync with dtBuildFeatures() in dt-training.js.
_REGIME_RISK = {
    "riskOn": 0, "trend": 1, "sideways": 2, "highVol": 3, "riskOff": 4, "panic": 5,
}

# FEATURES kept for backward compatibility (same as FEATURES_INTRADAY)

MIN_TRAIN_SAMPLES = 30   # increased from 15 — continuous regression needs more data


# ─── Helpers ──────────────────────────────────────────────────────────────────

def _safe(v):
    """Return float or None; silently discard NaN strings."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if (f != f) else f   # NaN check without math import
    except (TypeError, ValueError):
        return None


def _row_to_dict(row):
    return dict(row) if row else None


def _ridge_regression(X, y, lr=0.01, epochs=2000, l2=0.05, sample_weight=None):
    """Ridge regression (weighted MSE + L2) via gradient descent, pure numpy.

    sample_weight (IMPROVEMENTS #4): per-row weight on the squared error. Paper
    day-trades get 0.5 so their perfect-fill, zero-slippage outcomes don't train
    the model as strongly as real fills. When every weight is 1.0 (the current
    all-real/all-legacy corpus) this is IDENTICAL to the old unweighted fit —
    weighted GD with uniform weights reduces exactly to unweighted GD.
    """
    import numpy as np
    n, p = X.shape
    w = np.zeros(p)
    b = 0.0
    sw = np.ones(n) if sample_weight is None else np.asarray(sample_weight, dtype=float)
    sw_sum = float(sw.sum()) or 1.0
    for _ in range(epochs):
        predictions = np.dot(X, w) + b
        error       = (predictions - y) * sw   # weight each residual
        dw = np.dot(X.T, error) / sw_sum + l2 * w
        db = float(np.sum(error) / sw_sum)
        w -= lr * dw
        b -= lr * db
    return w, b


def _resolve_shadow_outcomes(conn):
    """
    Compute r_multiple for shadow records old enough to have played out.
    Uses yfinance to fetch post-entry price history and simulates target/stop/time-stop exits.
    Called before training to ensure full unbiased dataset.
    """
    import yfinance as yf
    from datetime import datetime, timedelta
    from core import log

    TIME_STOP_DAYS = {
        'riskOn': 15, 'trend': 15, 'sideways': 12, 'highVol': 10, 'riskOff': 8,
    }

    # Fetch shadows with no r_multiple that are at least 8 days old
    rows = conn.execute("""
        SELECT id, ticker, entry_date, entry_price, target, stop_loss, regime
        FROM trade_snapshots
        WHERE record_type = 'shadow'
          AND r_multiple IS NULL
          AND entry_date <= date('now', '-8 days')
        LIMIT 50
    """).fetchall()

    if not rows:
        return 0

    resolved = 0
    for row in rows:
        try:
            max_hold = TIME_STOP_DAYS.get(row['regime'] or '', 12)
            entry_dt = datetime.strptime(row['entry_date'], '%Y-%m-%d')
            # Fetch enough calendar days to cover max_hold trading days
            end_dt  = entry_dt + timedelta(days=int(max_hold * 1.5) + 5)
            ticker  = row['ticker']
            if not ticker.upper().endswith('.AX'):
                ticker = ticker + '.AX'

            hist = yf.Ticker(ticker).history(
                start=row['entry_date'],
                end=end_dt.strftime('%Y-%m-%d'),
                auto_adjust=True,
            )
            if hist.empty or row['entry_price'] is None:
                continue

            ep    = float(row['entry_price'])
            sl    = float(row['stop_loss']) if row['stop_loss'] else ep * 0.95
            tgt   = float(row['target'])   if row['target']    else ep * 1.05
            denom = ep - sl
            if abs(denom) < 1e-9:
                continue

            r_multiple   = None
            exit_price   = None
            exit_reason  = 'time_stop'
            exit_date_str = None
            trading_days = 0

            for bar_dt, bar in hist.iterrows():
                # Only count weekdays as trading days
                if bar_dt.weekday() < 5:
                    trading_days += 1
                if float(bar['High']) >= tgt:
                    r_multiple   = round((tgt - ep) / denom, 4)
                    exit_price   = tgt
                    exit_reason  = 'target'
                    exit_date_str = bar_dt.strftime('%Y-%m-%d')
                    break
                if float(bar['Low']) <= sl:
                    r_multiple   = round((sl - ep) / denom, 4)
                    exit_price   = sl
                    exit_reason  = 'stop'
                    exit_date_str = bar_dt.strftime('%Y-%m-%d')
                    break
                if trading_days >= max_hold:
                    exit_price   = float(bar['Close'])
                    r_multiple   = round((exit_price - ep) / denom, 4)
                    exit_reason  = 'time_stop'
                    exit_date_str = bar_dt.strftime('%Y-%m-%d')
                    break

            if r_multiple is None and not hist.empty:
                exit_price   = float(hist['Close'].iloc[-1])
                r_multiple   = round((exit_price - ep) / denom, 4)
                exit_reason  = 'time_stop'
                exit_date_str = hist.index[-1].strftime('%Y-%m-%d')

            if r_multiple is None:
                continue

            pnl_pct = round((exit_price - ep) / ep * 100, 4) if exit_price else None
            outcome = 'win' if r_multiple > 0 else ('loss' if r_multiple < 0 else 'breakeven')

            conn.execute("""
                UPDATE trade_snapshots
                   SET r_multiple=?, exit_price=?, exit_reason=?, outcome=?,
                       exit_date=?, pnl_pct=?, updated_at=datetime('now')
                 WHERE id=?
            """, (r_multiple, exit_price, exit_reason, outcome,
                  exit_date_str, pnl_pct, row['id']))
            resolved += 1

        except Exception as exc:
            log.debug("shadow resolution failed for id=%s: %s", row['id'], exc)
            continue

    return resolved


# ─── POST /api/daytrading/snapshot ────────────────────────────────────────────

@bp.route("/api/daytrading/snapshot", methods=["POST"])
def dt_snapshot_save():
    """Record a new entry snapshot. Returns the new snapshot id."""
    d = request.get_json(force=True) or {}

    COLS = (
        "ticker action trade_type record_type shadow_reason target stop_loss hold_days confidence regime "
        "trade_mode "
        "entry_date entry_price qty "
        "rsi_14 rsi_9 macd_hist bb_pct_b bb_bandwidth atr_14 atr_pct "
        "price_vs_sma20 price_vs_sma50 price_vs_sma200 "
        "adx volume_zscore mfi_14 stoch_k williams_r cci_20 setup_score "
        "intraday_rsi vwap_position volume_accel "
        "asx200_price asx200_5d_ret adl_ratio rba_rate "
        "sector sector_5d_ret"
    ).split()

    vals = {c: d.get(c) for c in COLS}
    # Normalise trade_mode to the firewall vocabulary — only an explicit 'paper'
    # is stored as paper; anything else (incl. missing) stays NULL = full weight.
    vals["trade_mode"] = "paper" if vals.get("trade_mode") == "paper" else (
        "real" if vals.get("trade_mode") == "real" else None)

    # Validate required fields
    if not vals.get("ticker") or not vals.get("entry_date"):
        return jsonify({"ok": False, "error": "ticker and entry_date are required"}), 400

    # Cast numeric fields
    NUMERIC = {c for c in COLS if c not in ("ticker", "action", "trade_type", "record_type",
                                              "shadow_reason", "regime", "trade_mode",
                                              "entry_date", "sector")}
    for c in NUMERIC:
        vals[c] = _safe(vals[c])

    # Only INSERT columns that have a non-None value so DB column defaults apply
    cols   = [c for c in vals if vals[c] is not None]
    if not cols:
        cols = ["ticker", "entry_date"]  # already validated above
    placeholders = ", ".join("?" * len(cols))
    col_names = ", ".join(cols)
    values = [vals[c] for c in cols]

    with get_dt_db() as conn:
        cur = conn.execute(
            f"INSERT INTO trade_snapshots ({col_names}) VALUES ({placeholders})",
            values
        )
        new_id = cur.lastrowid

    return jsonify({"ok": True, "id": new_id})


# ─── PATCH /api/daytrading/snapshot/<id>/close ────────────────────────────────

@bp.route("/api/daytrading/snapshot/<int:snap_id>/close", methods=["PATCH"])
def dt_snapshot_close(snap_id):
    """Patch exit data onto an existing snapshot."""
    d = request.get_json(force=True) or {}

    exit_price      = _safe(d.get("exit_price"))
    entry_price_ovr = _safe(d.get("entry_price"))   # for pnl_pct if needed
    pnl_pct         = _safe(d.get("pnl_pct"))
    exit_reason     = d.get("exit_reason")
    exit_date       = d.get("exit_date")
    actual_hold_days = d.get("actual_hold_days")
    exit_signals_json = d.get("exit_signals_json")  # JSON string, opaque here
    regime_at_close = d.get("regime_at_close")  # regime live at close time, vs entry-time `regime`

    # Exit-signals capture: diagnostic-only technical classification of the exit
    # timing, reused from the same pure function the main Learning Loop uses for
    # SELL/TRIM events (routes/learning.py). Never fed into FEATURES/training —
    # exit-time indicators don't exist yet at the entry decision, so using them
    # as a predictive input would be data leakage.
    exit_quality_tag = None
    if exit_signals_json:
        try:
            from routes.learning import classify_exit_quality_deterministic
            exit_quality_tag = classify_exit_quality_deterministic(exit_signals_json)
        except Exception:
            pass

    # Compute outcome from pnl_pct
    if pnl_pct is not None:
        if pnl_pct > 0.5:
            outcome = "win"
        elif pnl_pct < -0.5:
            outcome = "loss"
        else:
            outcome = "breakeven"
    else:
        outcome = None

    with get_dt_db() as conn:
        # If pnl_pct not provided, compute from prices in DB
        if pnl_pct is None and exit_price is not None:
            row = conn.execute(
                "SELECT entry_price FROM trade_snapshots WHERE id=?", (snap_id,)
            ).fetchone()
            if row and row["entry_price"]:
                ep = row["entry_price"]
                pnl_pct = (exit_price - ep) / ep * 100
                if pnl_pct > 0.5:
                    outcome = "win"
                elif pnl_pct < -0.5:
                    outcome = "loss"
                else:
                    outcome = "breakeven"

        # Compute r_multiple = (exit - entry) / (entry - stop)
        r_multiple = None
        if exit_price is not None:
            row2 = conn.execute(
                "SELECT entry_price, stop_loss FROM trade_snapshots WHERE id=?", (snap_id,)
            ).fetchone()
            if row2 and row2["entry_price"] and row2["stop_loss"]:
                ep  = float(row2["entry_price"])
                sl  = float(row2["stop_loss"])
                denom = ep - sl
                if abs(denom) > 1e-9:
                    r_multiple = round((float(exit_price) - ep) / denom, 4)

        conn.execute("""
            UPDATE trade_snapshots
               SET exit_date=?, exit_price=?, exit_reason=?,
                   actual_hold_days=?, pnl_pct=?, outcome=?, r_multiple=?,
                   exit_signals_json=?, exit_quality_tag=?, regime_at_close=?,
                   updated_at=datetime('now')
             WHERE id=?
        """, (exit_date, exit_price, exit_reason, actual_hold_days,
              pnl_pct, outcome, r_multiple, exit_signals_json, exit_quality_tag,
              regime_at_close, snap_id))

    return jsonify({"ok": True, "id": snap_id, "outcome": outcome})


# ─── GET /api/daytrading/history ──────────────────────────────────────────────

@bp.route("/api/daytrading/history", methods=["GET"])
def dt_history():
    """Paginated trade history. Returns items + has_more."""
    limit   = min(int(request.args.get("limit", 20)), 100)
    offset  = int(request.args.get("offset", 0))
    outcome = request.args.get("outcome")        # 'win' | 'loss' | 'open' | '' = all
    record_type = request.args.get("record_type")
    sort    = request.args.get("sort", "entry_date")  # 'entry_date' | 'exit_date'

    where = []
    params = []
    if outcome and outcome != "all":
        where.append("outcome = ?")
        params.append(outcome)
    if record_type and record_type != "all":
        where.append("record_type = ?")
        params.append(record_type)

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    # Sorting by exit_date puts still-open trades (exit_date IS NULL) last
    # regardless of direction — there's no exit date to sort them by, and
    # burying them at the bottom of a "most recently closed first" list
    # reads correctly (they haven't closed yet).
    order_sql = (
        "ORDER BY exit_date IS NULL, exit_date DESC, created_at DESC"
        if sort == "exit_date"
        else "ORDER BY entry_date DESC, created_at DESC"
    )

    with get_dt_db() as conn:
        rows = conn.execute(
            f"""SELECT * FROM trade_snapshots
                {where_sql}
                {order_sql}
                LIMIT ? OFFSET ?""",
            params + [limit + 1, offset]
        ).fetchall()

    has_more = len(rows) > limit
    items = [_row_to_dict(r) for r in rows[:limit]]
    return jsonify({"ok": True, "items": items, "has_more": has_more})


# ─── GET /api/daytrading/stats ────────────────────────────────────────────────

@bp.route("/api/daytrading/stats", methods=["GET"])
def dt_stats():
    """Summary statistics over all completed trades."""
    with get_dt_db() as conn:
        totals = conn.execute("""
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN outcome='win'       THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN outcome='loss'      THEN 1 ELSE 0 END) AS losses,
                SUM(CASE WHEN outcome='breakeven' THEN 1 ELSE 0 END) AS breakevens,
                SUM(CASE WHEN outcome='open'  OR outcome IS NULL THEN 1 ELSE 0 END) AS open_trades,
                AVG(CASE WHEN outcome='win'  THEN pnl_pct END) AS avg_win_pct,
                AVG(CASE WHEN outcome='loss' THEN pnl_pct END) AS avg_loss_pct,
                AVG(CASE WHEN outcome IN ('win','loss','breakeven') THEN actual_hold_days END) AS avg_hold_days
            FROM trade_snapshots
        """).fetchone()

        by_regime = conn.execute("""
            SELECT regime,
                   COUNT(*) AS n,
                   SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS wins
            FROM trade_snapshots
            WHERE outcome IN ('win','loss','breakeven') AND regime IS NOT NULL
            GROUP BY regime
            ORDER BY n DESC
        """).fetchall()

        by_type = conn.execute("""
            SELECT trade_type,
                   COUNT(*) AS n,
                   SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS wins
            FROM trade_snapshots
            WHERE outcome IN ('win','loss','breakeven')
            GROUP BY trade_type
        """).fetchall()

        by_exit_quality = conn.execute("""
            SELECT exit_quality_tag,
                   COUNT(*) AS n,
                   SUM(CASE WHEN outcome='win' THEN 1 ELSE 0 END) AS wins,
                   AVG(pnl_pct) AS avg_pnl_pct
            FROM trade_snapshots
            WHERE outcome IN ('win','loss','breakeven') AND exit_quality_tag IS NOT NULL
            GROUP BY exit_quality_tag
            ORDER BY n DESC
        """).fetchall()

        model_row = conn.execute(
            "SELECT trained_at, n_samples, accuracy, f1_w FROM model_state ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()

        shadow_stats = conn.execute("""
            SELECT
                COUNT(*) AS shadow_total,
                SUM(CASE WHEN r_multiple IS NOT NULL THEN 1 ELSE 0 END) AS shadow_resolved
            FROM trade_snapshots WHERE record_type='shadow'
        """).fetchone()

        completed = int(conn.execute("""
            SELECT COUNT(*) FROM trade_snapshots
            WHERE outcome IN ('win', 'loss', 'breakeven')
        """).fetchone()[0])

    t = dict(totals)
    win_rate = ((t.get("wins") or 0) / completed * 100) if completed > 0 else None

    return jsonify({
        "ok": True,
        "total": t.get("total", 0),
        "completed": completed,
        "wins": t.get("wins", 0),
        "losses": t.get("losses", 0),
        "breakevens": t.get("breakevens", 0),
        "open_trades": t.get("open_trades", 0),
        "win_rate_pct": round(win_rate, 1) if win_rate is not None else None,
        "avg_win_pct": round(t["avg_win_pct"], 2) if t.get("avg_win_pct") is not None else None,
        "avg_loss_pct": round(t["avg_loss_pct"], 2) if t.get("avg_loss_pct") is not None else None,
        "avg_hold_days": round(t["avg_hold_days"], 1) if t.get("avg_hold_days") is not None else None,
        "by_regime": [
            {"regime": r["regime"], "n": r["n"],
             "win_rate": round(r["wins"] / r["n"] * 100, 1) if r["n"] else 0}
            for r in by_regime
        ],
        "by_type": [
            {"type": r["trade_type"], "n": r["n"],
             "win_rate": round(r["wins"] / r["n"] * 100, 1) if r["n"] else 0}
            for r in by_type
        ],
        # Exit-signals capture: diagnostic-only breakdown of how well-timed exits
        # were, by exit_quality_tag (classify_exit_quality_deterministic in
        # routes/learning.py). NOT a training feature — see dt_snapshot_close().
        "by_exit_quality": [
            {"tag": r["exit_quality_tag"], "n": r["n"],
             "win_rate": round(r["wins"] / r["n"] * 100, 1) if r["n"] else 0,
             "avg_pnl_pct": round(r["avg_pnl_pct"], 2) if r["avg_pnl_pct"] is not None else None}
            for r in by_exit_quality
        ],
        "model": _row_to_dict(model_row) if model_row else None,
        "min_train_samples": MIN_TRAIN_SAMPLES,
        "ready_to_train": completed >= MIN_TRAIN_SAMPLES,
        "shadow_count":    shadow_stats["shadow_total"] if shadow_stats else 0,
        "shadow_resolved": shadow_stats["shadow_resolved"] if shadow_stats else 0,
    })


# ─── POST /api/daytrading/train ───────────────────────────────────────────────

@bp.route("/api/daytrading/train", methods=["POST"])
def dt_train():
    """
    Train a logistic regression model on completed trade snapshots.
    Pure numpy — no LLM calls, no external API.
    """
    with get_dt_db() as conn:
        result = _train_model_impl(conn)
    return jsonify(result)


def _train_model_impl(conn):
    """
    Train two Ridge regression models (swing / intraday) using R-multiple as target.
    Returns a results dict. Called by POST /api/daytrading/train.
    """
    import json
    import numpy as np
    import warnings as _warnings
    from datetime import datetime, timezone

    # First resolve any pending shadow outcomes
    _resolve_shadow_outcomes(conn)

    results = {"ok": True, "models": {}}

    for scope, feat_list in [("swing", FEATURES_SWING), ("intraday", FEATURES_INTRADAY)]:
        if scope == "swing":
            type_filter = "trade_type IN ('swing') OR trade_type NOT IN ('intraday')"
        else:
            type_filter = "trade_type = 'intraday'"

        rows = conn.execute(f"""
            SELECT * FROM trade_snapshots
            WHERE outcome IN ('win', 'loss', 'breakeven')
              AND ({type_filter})
            ORDER BY entry_date ASC, created_at ASC
            LIMIT 2000
        """).fetchall()

        if len(rows) < MIN_TRAIN_SAMPLES:
            results["models"][scope] = {
                "ok": False,
                "error": (f"Need at least {MIN_TRAIN_SAMPLES} completed {scope} trades "
                          f"(have {len(rows)})"),
                "n_available": len(rows),
            }
            continue

        # Materialise rows as dicts and derive regime_risk from the stored regime
        # string — sqlite Rows would KeyError on the synthetic feature name.
        rows = [dict(r) for r in rows]
        for r in rows:
            r["regime_risk"] = _REGIME_RISK.get(r.get("regime"))

        # ── Build feature matrix ─────────────────────────────────────────────
        X_raw = np.array(
            [[float(r[f]) if r[f] is not None else np.nan for f in feat_list] for r in rows],
            dtype=float,
        )

        # Build y = r_multiple; compute from prices if stored r_multiple is missing
        y = []
        for r in rows:
            rm = r['r_multiple']
            if rm is None:
                try:
                    ep = float(r['entry_price'] or 0)
                    sl = float(r['stop_loss']   or 0)
                    ex = float(r['exit_price']  or 0)
                    denom = ep - sl
                    rm = (ex - ep) / denom if abs(denom) > 1e-9 else 0.0
                except (TypeError, ValueError):
                    rm = 0.0
            y.append(float(rm))
        y = np.array(y)

        # ── Per-row training weight (IMPROVEMENTS #4) ────────────────────────
        # Paper rows → 0.5 (optimistic perfect fills); real/legacy(NULL) → 1.0.
        # All-1.0 today, so no behavior change until paper day-trades are tagged.
        sample_w = np.array([0.5 if r.get("trade_mode") == "paper" else 1.0
                             for r in rows])
        n_paper = int(sum(1 for r in rows if r.get("trade_mode") == "paper"))

        # ── Mean imputation for NaN cells ────────────────────────────────────
        with _warnings.catch_warnings():
            _warnings.simplefilter("ignore", RuntimeWarning)
            col_means = np.nanmean(X_raw, axis=0)
        col_means = np.where(np.isnan(col_means), 0.0, col_means)
        for j in range(X_raw.shape[1]):
            mask = np.isnan(X_raw[:, j])
            X_raw[mask, j] = col_means[j]

        # ── Z-score standardisation ─────────────────────────────────────────
        means = X_raw.mean(axis=0)
        stds  = X_raw.std(axis=0)
        stds[stds < 1e-9] = 1.0
        X = (X_raw - means) / stds

        # ── Spearman IC per feature ──────────────────────────────────────────
        def _spearman(a, b):
            n = len(a)
            if n < 3:
                return 0.0
            ra = np.argsort(np.argsort(a)).astype(float)
            rb = np.argsort(np.argsort(b)).astype(float)
            d  = ra - rb
            denom = float(n) * (float(n) * float(n) - 1.0)
            return 0.0 if denom == 0 else 1.0 - 6.0 * float(np.sum(d * d)) / denom

        ics = [_spearman(X_raw[:, i], y) for i in range(len(feat_list))]

        # Ridge regression is module-level (_ridge_regression) so it can be
        # unit-tested directly — see the weighted-fit tests in test_app.py.

        # ── Out-of-sample evaluation (§0.I) ──────────────────────────────────
        # Fit transforms on train rows only to avoid leakage; collect held-out
        # predictions across folds; then refit on all rows for deployment.

        def _fit_and_predict_fold(X_tr_raw, y_tr, X_te_raw, sw_tr=None):
            """Standardise + impute on train only; return OOS predictions."""
            # Impute train NaNs
            with _warnings.catch_warnings():
                _warnings.simplefilter("ignore", RuntimeWarning)
                tr_col_means = np.nanmean(X_tr_raw, axis=0)
            tr_col_means = np.where(np.isnan(tr_col_means), 0.0, tr_col_means)
            Xtr = X_tr_raw.copy()
            Xte = X_te_raw.copy()
            for j in range(Xtr.shape[1]):
                Xtr[np.isnan(Xtr[:, j]), j] = tr_col_means[j]
                Xte[np.isnan(Xte[:, j]), j] = tr_col_means[j]
            # Standardise on train
            tr_means = Xtr.mean(axis=0)
            tr_stds  = Xtr.std(axis=0)
            tr_stds[tr_stds < 1e-9] = 1.0
            Xtr = (Xtr - tr_means) / tr_stds
            Xte = (Xte - tr_means) / tr_stds
            w, b = _ridge_regression(Xtr, y_tr, sample_weight=sw_tr)
            return np.dot(Xte, w) + b

        n = len(rows)
        oos_preds = np.full(n, np.nan)

        if n >= 60:
            # Expanding-window walk-forward: 4 folds
            cv_method = 'walk_forward'
            n_folds = 4
            fold_size = n // (n_folds + 1)
            start = fold_size  # first train window
            for k in range(n_folds):
                train_end = start + k * fold_size
                test_start = train_end
                test_end   = min(test_start + fold_size, n)
                if test_start >= n:
                    break
                oos_preds[test_start:test_end] = _fit_and_predict_fold(
                    X_raw[:train_end], y[:train_end],
                    X_raw[test_start:test_end],
                    sw_tr=sample_w[:train_end],
                )
        else:
            # Single chronological holdout: train on first 70%, test on last 30%
            cv_method = 'holdout'
            split = int(n * 0.70)
            oos_preds[split:] = _fit_and_predict_fold(
                X_raw[:split], y[:split], X_raw[split:],
                sw_tr=sample_w[:split],
            )

        # Compute OOS metrics on held-out rows only
        mask = ~np.isnan(oos_preds)
        n_test = int(mask.sum())
        if n_test >= 2:
            y_te   = y[mask]
            p_te   = oos_preds[mask]
            ss_r   = float(np.sum((y_te - p_te) ** 2))
            ss_t   = float(np.sum((y_te - y_te.mean()) ** 2))
            r2_oos  = round(1.0 - ss_r / ss_t if ss_t > 1e-9 else 0.0, 4)
            mae_oos = round(float(np.mean(np.abs(y_te - p_te))), 4)
        else:
            r2_oos = mae_oos = None
            cv_method = 'insufficient'
            n_test = 0

        # ── Final model fit — all rows (paper down-weighted) ─────────────────
        weights, bias = _ridge_regression(X, y, sample_weight=sample_w)

        # ── Metrics (R², MAE) ────────────────────────────────────────────────
        y_pred    = np.dot(X, weights) + bias
        ss_res    = float(np.sum((y - y_pred) ** 2))
        ss_tot    = float(np.sum((y - y.mean()) ** 2))
        r2_score  = round(1.0 - ss_res / ss_tot if ss_tot > 1e-9 else 0.0, 4)
        mae_score = round(float(np.mean(np.abs(y - y_pred))), 4)
        n_positive = int(np.sum(y > 0))

        # ── Persist model ────────────────────────────────────────────────────
        trained_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")
        cur = conn.execute(
            """INSERT INTO model_state
                   (trained_at, n_samples, n_features, n_wins, n_losses,
                    model_type, trade_type_scope, r2_score, mae_score,
                    r2_oos, mae_oos, n_test, cv_method,
                    feature_names, weights, bias, feature_means, feature_stds)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                trained_at, len(rows), len(feat_list),
                n_positive, int(len(rows) - n_positive),
                'ridge', scope, r2_score, mae_score,
                r2_oos, mae_oos, n_test, cv_method,
                json.dumps(feat_list),
                json.dumps(weights.tolist()),
                float(bias),
                json.dumps(means.tolist()),
                json.dumps(stds.tolist()),
            ),
        )
        model_id = cur.lastrowid

        # ── Feature importance ───────────────────────────────────────────────
        sorted_feats = sorted(
            [(i, feat_list[i], ics[i], float(weights[i])) for i in range(len(feat_list))],
            key=lambda x: abs(x[2]),
            reverse=True,
        )
        for rank, (i, name, ic, w) in enumerate(sorted_feats):
            conn.execute(
                """INSERT INTO feature_importance
                       (model_id, feature_name, ic, lr_weight, importance_rank)
                   VALUES (?,?,?,?,?)""",
                (model_id, name, float(ic), w, rank + 1),
            )

        results["models"][scope] = {
            "ok":         True,
            "n_samples":  len(rows),
            "n_paper":    n_paper,   # rows down-weighted 0.5× (IMPROVEMENTS #4)
            "n_positive": n_positive,
            "r2_score":   r2_score,
            "mae_score":  mae_score,
            "r2_oos":     r2_oos,
            "mae_oos":    mae_oos,
            "n_test":     n_test,
            "cv_method":  cv_method,
            "trained_at": trained_at,
            "feature_importances": [
                {"feature": name, "ic": round(ic, 4), "coefficient": round(w, 4)}
                for _, name, ic, w in sorted_feats
            ],
        }

    # Backward-compat: expose top-level ok/accuracy fields from swing model
    swing = results["models"].get("swing", {})
    if swing.get("ok"):
        results["n_samples"]  = swing["n_samples"]
        results["accuracy"]   = 0.0   # ridge doesn't have classification accuracy
        results["r2_score"]   = swing["r2_score"]
        results["mae_score"]  = swing["mae_score"]
        results["r2_oos"]     = swing.get("r2_oos")
        results["mae_oos"]    = swing.get("mae_oos")
        results["n_test"]     = swing.get("n_test")
        results["cv_method"]  = swing.get("cv_method")
        results["trained_at"] = swing["trained_at"]
        results["feature_importances"] = swing["feature_importances"]
    elif results["models"].get("intraday", {}).get("ok"):
        intra = results["models"]["intraday"]
        results["n_samples"]  = intra["n_samples"]
        results["accuracy"]   = 0.0
        results["r2_score"]   = intra["r2_score"]
        results["trained_at"] = intra["trained_at"]
        results["feature_importances"] = intra["feature_importances"]
    else:
        results["ok"] = False
        results["error"] = "; ".join(
            m.get("error", "") for m in results["models"].values() if not m.get("ok")
        )

    return results


# ─── GET /api/daytrading/model ────────────────────────────────────────────────

@bp.route("/api/daytrading/model", methods=["GET"])
def dt_model():
    """Return the latest trained swing and intraday models + feature importances."""
    import json

    with get_dt_db() as conn:
        swing_row    = conn.execute(
            "SELECT * FROM model_state WHERE trade_type_scope='swing'    ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()
        intraday_row = conn.execute(
            "SELECT * FROM model_state WHERE trade_type_scope='intraday' ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()
        # Legacy fallback: 'all' scope (pre-Sprint-53 rows)
        legacy_row = conn.execute(
            "SELECT * FROM model_state WHERE trade_type_scope='all' OR trade_type_scope IS NULL ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()

        def _load_model(row):
            if not row:
                return None
            m = dict(row)
            for key in ("feature_names", "weights", "feature_means", "feature_stds"):
                if m.get(key):
                    m[key] = json.loads(m[key])
            # Always report model_type as 'ridge' for new models
            if not m.get("model_type"):
                m["model_type"] = "logistic"
            return m

        def _load_importances(row):
            if not row:
                return []
            return [dict(r) for r in conn.execute(
                "SELECT feature_name, ic, lr_weight, importance_rank FROM feature_importance WHERE model_id=? ORDER BY importance_rank",
                (row["id"],)
            ).fetchall()]

        swing_m    = _load_model(swing_row)
        intraday_m = _load_model(intraday_row)
        # Fallback: if no typed models, use legacy 'all' model for swing
        if swing_m is None and intraday_m is None and legacy_row:
            swing_m = _load_model(legacy_row)

        available = swing_m is not None or intraday_m is not None

        swing_importances    = _load_importances(swing_row)
        intraday_importances = _load_importances(intraday_row)

    if not available:
        return jsonify({
            "ok": True,
            "available": False,
            "min_train_samples": MIN_TRAIN_SAMPLES,
        })

    return jsonify({
        "ok":        True,
        "available": True,
        "swing":     swing_m,
        "intraday":  intraday_m,
        "importances": {
            "swing":    swing_importances,
            "intraday": intraday_importances,
        },
    })


# ─── POST /api/daytrading/predict ─────────────────────────────────────────────

@bp.route("/api/daytrading/predict", methods=["POST"])
def dt_predict():
    """
    Predict win probability for a given feature snapshot.
    Body: { rsi_14: N, bb_pct_b: N, ... }
    """
    import json
    import numpy as np

    data = request.get_json(force=True) or {}

    with get_dt_db() as conn:
        model_row = conn.execute(
            "SELECT * FROM model_state ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()

    if not model_row:
        return jsonify({"ok": False, "error": "No trained model. Run training first."})

    features = json.loads(model_row["feature_names"])
    weights  = np.array(json.loads(model_row["weights"]))
    bias     = float(model_row["bias"])
    means    = np.array(json.loads(model_row["feature_means"]))
    stds     = np.array(json.loads(model_row["feature_stds"]))

    x_raw = np.array([float(data.get(f) or 0.0) for f in features])
    x_std = (x_raw - means) / stds
    logit = float(np.clip(np.dot(x_std, weights) + bias, -20.0, 20.0))
    prob  = 1.0 / (1.0 + np.exp(-logit))

    return jsonify({
        "ok": True,
        "win_probability": round(float(prob), 4),
        "model_trained_at": model_row["trained_at"],
        "n_training_samples": model_row["n_samples"],
    })


# ─── DELETE /api/daytrading/snapshot/<id> ─────────────────────────────────────

@bp.route("/api/daytrading/snapshot/<int:snap_id>", methods=["DELETE"])
def dt_snapshot_delete(snap_id):
    with get_dt_db() as conn:
        conn.execute("DELETE FROM trade_snapshots WHERE id=?", (snap_id,))
    return jsonify({"ok": True})
