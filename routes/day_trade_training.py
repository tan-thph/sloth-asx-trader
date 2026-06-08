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

MIN_TRAIN_SAMPLES = 15   # minimum completed trades before training is allowed


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


# ─── POST /api/daytrading/snapshot ────────────────────────────────────────────

@bp.route("/api/daytrading/snapshot", methods=["POST"])
def dt_snapshot_save():
    """Record a new entry snapshot. Returns the new snapshot id."""
    d = request.get_json(force=True) or {}

    COLS = (
        "ticker action trade_type target stop_loss hold_days confidence regime "
        "entry_date entry_price qty "
        "rsi_14 rsi_9 macd_hist bb_pct_b bb_bandwidth atr_14 atr_pct "
        "price_vs_sma20 price_vs_sma50 price_vs_sma200 "
        "adx volume_zscore mfi_14 stoch_k williams_r cci_20 setup_score "
        "intraday_rsi vwap_position volume_accel "
        "asx200_price asx200_5d_ret adl_ratio rba_rate "
        "sector sector_5d_ret"
    ).split()

    vals = {c: d.get(c) for c in COLS}

    # Validate required fields
    if not vals.get("ticker") or not vals.get("entry_date"):
        return jsonify({"ok": False, "error": "ticker and entry_date are required"}), 400

    # Cast numeric fields
    NUMERIC = {c for c in COLS if c not in ("ticker", "action", "trade_type", "regime",
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

        conn.execute("""
            UPDATE trade_snapshots
               SET exit_date=?, exit_price=?, exit_reason=?,
                   actual_hold_days=?, pnl_pct=?, outcome=?,
                   updated_at=datetime('now')
             WHERE id=?
        """, (exit_date, exit_price, exit_reason, actual_hold_days,
              pnl_pct, outcome, snap_id))

    return jsonify({"ok": True, "id": snap_id, "outcome": outcome})


# ─── GET /api/daytrading/history ──────────────────────────────────────────────

@bp.route("/api/daytrading/history", methods=["GET"])
def dt_history():
    """Paginated trade history. Returns items + has_more."""
    limit   = min(int(request.args.get("limit", 20)), 100)
    offset  = int(request.args.get("offset", 0))
    outcome = request.args.get("outcome")        # 'win' | 'loss' | 'open' | '' = all

    where = []
    params = []
    if outcome and outcome != "all":
        where.append("outcome = ?")
        params.append(outcome)

    where_sql = ("WHERE " + " AND ".join(where)) if where else ""

    with get_dt_db() as conn:
        rows = conn.execute(
            f"""SELECT * FROM trade_snapshots
                {where_sql}
                ORDER BY entry_date DESC, created_at DESC
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

        model_row = conn.execute(
            "SELECT trained_at, n_samples, accuracy, f1_w FROM model_state ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()

    t = dict(totals)
    completed = (t.get("wins") or 0) + (t.get("losses") or 0) + (t.get("breakevens") or 0)
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
        "model": _row_to_dict(model_row) if model_row else None,
        "min_train_samples": MIN_TRAIN_SAMPLES,
        "ready_to_train": completed >= MIN_TRAIN_SAMPLES,
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
    Fit a logistic regression (gradient descent) and persist model artefacts.
    Returns a results dict with metrics and feature importances.
    """
    import json
    import numpy as np

    rows = conn.execute("""
        SELECT * FROM trade_snapshots
        WHERE outcome IN ('win', 'loss', 'breakeven')
        ORDER BY entry_date DESC
        LIMIT 2000
    """).fetchall()

    if len(rows) < MIN_TRAIN_SAMPLES:
        return {
            "ok": False,
            "error": (
                f"Need at least {MIN_TRAIN_SAMPLES} completed trades to train "
                f"(have {len(rows)})"
            ),
        }

    # ── Build feature matrix ─────────────────────────────────────────────────
    X_raw = np.array(
        [[float(r[f]) if r[f] is not None else np.nan for f in FEATURES] for r in rows],
        dtype=float,
    )
    y = np.array([1.0 if r["outcome"] == "win" else 0.0 for r in rows])

    # Mean imputation for NaN cells (suppress all-NaN slice warning)
    import warnings as _warnings
    with _warnings.catch_warnings():
        _warnings.simplefilter("ignore", RuntimeWarning)
        col_means = np.nanmean(X_raw, axis=0)
    col_means = np.where(np.isnan(col_means), 0.0, col_means)
    for j in range(X_raw.shape[1]):
        mask = np.isnan(X_raw[:, j])
        X_raw[mask, j] = col_means[j]

    # z-score standardisation
    means = X_raw.mean(axis=0)
    stds = X_raw.std(axis=0)
    stds[stds < 1e-9] = 1.0
    X = (X_raw - means) / stds

    n_wins   = int(y.sum())
    n_losses = int(len(y) - n_wins)

    # ── Information Coefficient (Spearman rank correlation) ──────────────────
    def _spearman(a, b):
        n = len(a)
        if n < 3:
            return 0.0
        ra = np.argsort(np.argsort(a)).astype(float)
        rb = np.argsort(np.argsort(b)).astype(float)
        d = ra - rb
        denom = float(n) * (float(n) * float(n) - 1.0)
        return 0.0 if denom == 0 else 1.0 - 6.0 * float(np.sum(d * d)) / denom

    ics = [_spearman(X_raw[:, i], y) for i in range(len(FEATURES))]

    # ── Logistic regression (gradient descent, L2 regularisation) ────────────
    def _logistic_regression(X, y, lr=0.05, epochs=1000, l2=0.01):
        n, p = X.shape
        w = np.zeros(p)
        b = 0.0
        for _ in range(epochs):
            logits = np.clip(np.dot(X, w) + b, -20.0, 20.0)
            pred = 1.0 / (1.0 + np.exp(-logits))
            err = pred - y
            dw = np.dot(X.T, err) / n + l2 * w
            db = float(np.mean(err))
            w -= lr * dw
            b -= lr * db
        return w, b

    weights, bias = _logistic_regression(X, y)

    # ── Metrics ──────────────────────────────────────────────────────────────
    logits = np.clip(np.dot(X, weights) + bias, -20.0, 20.0)
    y_prob = 1.0 / (1.0 + np.exp(-logits))
    y_pred = (y_prob >= 0.5).astype(float)

    accuracy  = float(np.mean(y_pred == y))
    tp = float(np.sum((y_pred == 1) & (y == 1)))
    fp = float(np.sum((y_pred == 1) & (y == 0)))
    fn = float(np.sum((y_pred == 0) & (y == 1)))
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall    = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1        = (2 * precision * recall / (precision + recall)
                 if (precision + recall) > 0 else 0.0)

    # ── Persist model ─────────────────────────────────────────────────────────
    from datetime import datetime, timezone
    trained_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    cur = conn.execute(
        """INSERT INTO model_state
               (trained_at, n_samples, n_features, n_wins, n_losses,
                accuracy, precision_w, recall_w, f1_w,
                feature_names, weights, bias, feature_means, feature_stds)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            trained_at, len(rows), len(FEATURES), n_wins, n_losses,
            accuracy, precision, recall, f1,
            json.dumps(FEATURES),
            json.dumps(weights.tolist()),
            float(bias),
            json.dumps(means.tolist()),
            json.dumps(stds.tolist()),
        ),
    )
    model_id = cur.lastrowid

    # ── Feature importance — sorted by |IC| ──────────────────────────────────
    sorted_feats = sorted(
        [(i, FEATURES[i], ics[i], float(weights[i])) for i in range(len(FEATURES))],
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

    return {
        "ok": True,
        "n_samples": len(rows),
        "n_wins": n_wins,
        "n_losses": n_losses,
        "accuracy": round(accuracy, 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
        "trained_at": trained_at,
        "feature_importances": [
            {"feature": name, "ic": round(ic, 4), "lr_weight": round(w, 4)}
            for _, name, ic, w in sorted_feats
        ],
    }


# ─── GET /api/daytrading/model ────────────────────────────────────────────────

@bp.route("/api/daytrading/model", methods=["GET"])
def dt_model():
    """Return the latest trained model (weights, means, stds) + feature importances."""
    import json

    with get_dt_db() as conn:
        model_row = conn.execute(
            "SELECT * FROM model_state ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()

        if not model_row:
            return jsonify({
                "ok": True,
                "available": False,
                "min_train_samples": MIN_TRAIN_SAMPLES,
            })

        model_id = model_row["id"]
        importances = conn.execute(
            """SELECT feature_name, ic, lr_weight, importance_rank
               FROM feature_importance WHERE model_id=? ORDER BY importance_rank""",
            (model_id,)
        ).fetchall()

    m = dict(model_row)
    # Parse JSON fields so they're arrays, not strings
    for key in ("feature_names", "weights", "feature_means", "feature_stds"):
        if m.get(key):
            m[key] = json.loads(m[key])

    return jsonify({
        "ok": True,
        "available": True,
        "model": m,
        "importances": [dict(r) for r in importances],
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
