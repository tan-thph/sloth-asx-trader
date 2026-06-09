"""
day_trade_db.py — Standalone SQLite store for day trading history and ML training.

Keeps training data isolated from the main asx_trader.db.
Database: day_trade_history.db  (WAL mode, same directory as this file)
"""

import contextlib
import os
import sqlite3

DT_HISTORY_DB_PATH = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "day_trade_history.db"
)

_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;

CREATE TABLE IF NOT EXISTS trade_snapshots (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,

    -- Identity
    ticker           TEXT    NOT NULL,
    action           TEXT    NOT NULL DEFAULT 'BUY',
    trade_type       TEXT    NOT NULL DEFAULT 'swing',   -- 'swing' | 'intraday'

    -- Recommendation context
    target           REAL,
    stop_loss        REAL,
    hold_days        INTEGER,
    confidence       REAL,
    regime           TEXT,

    -- Entry
    entry_date       TEXT    NOT NULL,
    entry_price      REAL,
    qty              INTEGER,

    -- Exit  (patched when the trade closes)
    exit_date        TEXT,
    exit_price       REAL,
    exit_reason      TEXT,   -- 'target' | 'stop' | 'time_stop' | 'manual'
    actual_hold_days INTEGER,
    pnl_pct          REAL,
    outcome          TEXT,   -- 'win' | 'loss' | 'breakeven' | 'open'

    -- Technical indicators at entry
    rsi_14           REAL,
    rsi_9            REAL,
    macd_hist        REAL,
    bb_pct_b         REAL,
    bb_bandwidth     REAL,
    atr_14           REAL,
    atr_pct          REAL,   -- atr_14 / entry_price * 100
    price_vs_sma20   REAL,   -- (price / sma20 - 1) * 100
    price_vs_sma50   REAL,
    price_vs_sma200  REAL,
    adx              REAL,
    volume_zscore    REAL,
    mfi_14           REAL,
    stoch_k          REAL,
    williams_r       REAL,
    cci_20           REAL,
    setup_score      REAL,   -- composite signal score 0–100

    -- Intraday-specific (null for swing trades)
    intraday_rsi     REAL,
    vwap_position    REAL,   -- (price - vwap) / price * 100
    volume_accel     REAL,

    -- Market context at entry
    asx200_price     REAL,
    asx200_5d_ret    REAL,
    adl_ratio        REAL,   -- advance/decline ratio
    rba_rate         REAL,

    -- Sector
    sector           TEXT,
    sector_5d_ret    REAL,

    created_at       TEXT    DEFAULT (datetime('now')),
    updated_at       TEXT    DEFAULT (datetime('now')),
    record_type      TEXT    NOT NULL DEFAULT 'executed',   -- 'executed' | 'shadow'
    shadow_reason    TEXT,   -- 'heat_blocked' | 'regime_blocked' | 'manual_skip'
    r_multiple       REAL    -- (exit_price - entry_price) / (entry_price - stop_loss)
);

CREATE INDEX IF NOT EXISTS idx_dts_ticker  ON trade_snapshots(ticker);
CREATE INDEX IF NOT EXISTS idx_dts_outcome ON trade_snapshots(outcome);
CREATE INDEX IF NOT EXISTS idx_dts_entry   ON trade_snapshots(entry_date DESC);
CREATE INDEX IF NOT EXISTS idx_dts_type    ON trade_snapshots(trade_type);

-- Trained model artefacts
CREATE TABLE IF NOT EXISTS model_state (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    trained_at   TEXT    NOT NULL,
    n_samples    INTEGER,
    n_features   INTEGER,
    n_wins       INTEGER,
    n_losses     INTEGER,
    accuracy     REAL,
    precision_w  REAL,
    recall_w     REAL,
    f1_w         REAL,
    model_type   TEXT    DEFAULT 'logistic_regression',
    trade_type_scope TEXT    DEFAULT 'all',   -- 'swing' | 'intraday' | 'all'
    r2_score         REAL,
    mae_score        REAL,
    feature_names TEXT,   -- JSON array of column names
    weights       TEXT,   -- JSON array of LR coefficients
    bias          REAL,
    feature_means TEXT,   -- JSON array (for z-score standardisation)
    feature_stds  TEXT    -- JSON array
);

-- Per-feature IC and coefficient for each training run
CREATE TABLE IF NOT EXISTS feature_importance (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id        INTEGER NOT NULL REFERENCES model_state(id) ON DELETE CASCADE,
    feature_name    TEXT    NOT NULL,
    ic              REAL,   -- Spearman rank-correlation with outcome
    lr_weight       REAL,   -- standardised LR coefficient
    importance_rank INTEGER
);
"""


@contextlib.contextmanager
def get_dt_db():
    """WAL-mode context manager for day_trade_history.db."""
    conn = sqlite3.connect(DT_HISTORY_DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_dt_db():
    """Create schema. Safe to call on every startup."""
    with get_dt_db() as conn:
        conn.executescript(_SCHEMA)
        # Runtime migrations — safe to run on existing installs (ALTER TABLE IF NOT EXISTS
        # is not supported in SQLite, so we catch the "duplicate column" error)
        _migrations = [
            "ALTER TABLE trade_snapshots ADD COLUMN record_type TEXT NOT NULL DEFAULT 'executed'",
            "ALTER TABLE trade_snapshots ADD COLUMN shadow_reason TEXT",
            "ALTER TABLE trade_snapshots ADD COLUMN r_multiple REAL",
            "ALTER TABLE model_state ADD COLUMN trade_type_scope TEXT DEFAULT 'all'",
            "ALTER TABLE model_state ADD COLUMN r2_score REAL",
            "ALTER TABLE model_state ADD COLUMN mae_score REAL",
            # Sprint 54 — out-of-sample evaluation (§0.I)
            "ALTER TABLE model_state ADD COLUMN r2_oos REAL",
            "ALTER TABLE model_state ADD COLUMN mae_oos REAL",
            "ALTER TABLE model_state ADD COLUMN n_test INTEGER",
            "ALTER TABLE model_state ADD COLUMN cv_method TEXT",
        ]
        for _sql in _migrations:
            try:
                conn.execute(_sql)
            except Exception:
                pass   # column already exists
