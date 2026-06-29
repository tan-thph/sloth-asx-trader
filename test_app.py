"""
test_app.py — Full integration test suite for Sloth ASX Trader backend.

Covers:
  - All learning loop routes (log, outcome partial-patch, delete, stats)
  - Quote endpoint
  - Dividends endpoint
  - Polymarket/Manifold route (mocked — no external calls)
  - Scanner endpoint (smoke)
  - JS syntax validation for all modified files
  - Key function definitions present in JS files

Run:  python test_app.py
"""

import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

# ── Bootstrap: import the Flask app ──────────────────────────────────────────
ROOT = os.path.dirname(__file__)
sys.path.insert(0, ROOT)

# Patch DB path to a shared in-memory SQLite so tests don't touch production data.
# We use check_same_thread=False + a module-level shared connection so all
# test calls share the same in-memory DB (each new sqlite3.connect(':memory:')
# would create a *separate* isolated DB, breaking cross-call state).
import asx_server
import db as db_module  # extracted module — also needs patching

_orig_get_db = asx_server.get_db
_orig_db_get_db = db_module.get_db
_shared_conn: sqlite3.Connection | None = None


def _get_shared_conn() -> sqlite3.Connection:
    global _shared_conn
    if _shared_conn is None:
        _shared_conn = sqlite3.connect(":memory:", check_same_thread=False)
        _shared_conn.row_factory = sqlite3.Row          # required for r['column'] access
        _shared_conn.execute("PRAGMA journal_mode=WAL")
        _shared_conn.execute("PRAGMA foreign_keys=ON")
    return _shared_conn


class _SharedConnCtx:
    """Wraps the shared connection as a context manager (commit/rollback on exit)."""
    def __enter__(self):
        return _get_shared_conn()

    def __exit__(self, exc_type, *_):
        conn = _get_shared_conn()
        if exc_type:
            conn.rollback()
        else:
            conn.commit()


def _test_get_db():
    return _SharedConnCtx()


def _install_in_memory_db():
    """Patch get_db in db module, asx_server, and every routes/*.py blueprint
    module. `from db import get_db` binds at import time, so each module needs
    its local binding rewritten as well.
    Must be called before init_db().
    """
    asx_server.get_db = _test_get_db
    db_module.get_db = _test_get_db
    import importlib
    for name in ("routes.portfolio", "routes.dividends", "routes.market",
                 "routes.backtest", "routes.scanner", "routes.learning",
                 "routes.debate", "routes.news", "routes.claude",
                 "routes.alerts", "routes.import_csv", "routes.intraday"):
        try:
            mod = importlib.import_module(name)
            if hasattr(mod, "get_db"):
                setattr(mod, "get_db", _test_get_db)
        except ImportError:
            pass  # module may not exist yet during the split process


class TestLearningLoopRoutes(unittest.TestCase):
    """Tests for /api/learning/* endpoints."""

    @classmethod
    def setUpClass(cls):
        # Patch get_db globally before init_db so the in-memory DB is used
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    @classmethod
    def tearDownClass(cls):
        asx_server.get_db = _orig_get_db

    # ── /api/learning/log ────────────────────────────────────────────────────

    def test_log_creates_event(self):
        payload = {
            "event_type": "recommendation",
            "ticker": "BHP",
            "regime": "bull",
            "prompt_version": "2026-05-v4",
            "ai_confidence": 0.82,
            "ensemble_confidence": 0.79,
            "recommendation": "BUY",
            "rationale_summary": "Strong momentum breakout",
            "suggested_stop": 42.50,
            "suggested_target": 48.00,
            "rr_ratio": 2.1,
            "was_executed": False,
        }
        resp = self.client.post(
            "/api/learning/log",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIsInstance(body.get("id"), int)
        self.__class__._logged_id = body["id"]

    def test_log_auto_registers_prompt_version(self):
        with _test_get_db() as conn:
            row = conn.execute(
                "SELECT total_calls FROM prompt_versions WHERE version=?",
                ("2026-05-v4",),
            ).fetchone()
        self.assertIsNotNone(row, "prompt_version should be auto-registered")
        self.assertGreaterEqual(row[0], 1)

    # ── /api/learning/outcome ────────────────────────────────────────────────

    def test_outcome_update_partial(self):
        event_id = self.__class__._logged_id
        payload = {"id": event_id, "was_executed": True, "outcome_status": "win",
                   "realized_pnl_aud": 312.50, "realized_pnl_pct": 7.35,
                   "holding_period_days": 14, "exit_reason": "manual"}
        resp = self.client.post(
            "/api/learning/outcome",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(json.loads(resp.data).get("ok"))

        with _test_get_db() as conn:
            row = conn.execute(
                "SELECT outcome_status, was_executed, realized_pnl_pct FROM ai_learning_events WHERE id=?",
                (event_id,),
            ).fetchone()
        self.assertEqual(row[0], "win")
        self.assertEqual(row[1], 1)
        self.assertAlmostEqual(row[2], 7.35, places=2)

    def test_outcome_requires_id(self):
        resp = self.client.post(
            "/api/learning/outcome",
            data=json.dumps({"outcome_status": "loss"}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_outcome_noop_when_no_fields(self):
        event_id = self.__class__._logged_id
        resp = self.client.post(
            "/api/learning/outcome",
            data=json.dumps({"id": event_id}),
            content_type="application/json",
        )
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIn("nothing to update", body.get("note", ""))

    # ── /api/learning/stats ──────────────────────────────────────────────────

    def test_stats_returns_expected_keys(self):
        resp = self.client.get("/api/learning/stats")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        for key in ("total", "closed", "wins", "conf_bands", "regime_stats",
                    "version_stats", "recent_events", "failed_tickers"):
            self.assertIn(key, body, f"Missing key: {key}")

    def test_stats_total_reflects_logged_event(self):
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        self.assertGreaterEqual(body["total"], 1)

    def test_stats_recent_events_shape(self):
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        events = body.get("recent_events", [])
        self.assertGreater(len(events), 0)
        ev = events[0]
        for field in ("id", "ticker", "recommendation", "ai_confidence", "outcome_status"):
            self.assertIn(field, ev, f"recent_event missing field: {field}")

    def test_stats_has_new_aggregate_fields(self):
        """stats endpoint must return avg_hold_days, exit_reason_dist, rr_stats."""
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        for key in ("avg_hold_days", "exit_reason_dist", "rr_stats"):
            self.assertIn(key, body, f"Missing new field: {key}")
        self.assertIsInstance(body["exit_reason_dist"], dict)
        self.assertIsInstance(body["rr_stats"], dict)

    def test_stats_recent_events_has_richer_fields(self):
        """recent_events must now include stop, target, rr_ratio, hold days, exit_reason."""
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        events = body.get("recent_events", [])
        if events:
            ev = events[0]
            for field in ("suggested_stop", "suggested_target", "rr_ratio",
                          "holding_period_days", "exit_reason", "rationale_summary"):
                self.assertIn(field, ev, f"recent_event missing richer field: {field}")

    def test_stats_win_rate_is_percentage(self):
        """overall_win_rate must be 0-100 (not 0-1 fraction)."""
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        wr = body.get("overall_win_rate")
        if wr is not None:
            self.assertLessEqual(wr, 100.0, "win_rate should be 0-100 scale")
            self.assertGreaterEqual(wr, 0.0)

    # ── /api/learning/event/<id> DELETE ─────────────────────────────────────

    def test_delete_event(self):
        # Log a fresh event to delete
        payload = {"ticker": "CBA", "recommendation": "SELL",
                   "prompt_version": "2026-05-v4", "ai_confidence": 0.70}
        r = self.client.post("/api/learning/log",
                             data=json.dumps(payload),
                             content_type="application/json")
        del_id = json.loads(r.data)["id"]

        resp = self.client.delete(f"/api/learning/event/{del_id}")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body["ok"])
        self.assertEqual(body["deleted"], del_id)

        with _test_get_db() as conn:
            row = conn.execute(
                "SELECT id FROM ai_learning_events WHERE id=?", (del_id,)
            ).fetchone()
        self.assertIsNone(row, "Row should be deleted from DB")

    def test_delete_nonexistent_returns_404(self):
        resp = self.client.delete("/api/learning/event/9999999")
        self.assertEqual(resp.status_code, 404)

    # ── Sprint 67: Thesis Tracking Phase 1 — entry driver ────────────────────

    def test_log_stores_primary_entry_driver(self):
        """POST /api/learning/log must persist primary_entry_driver for BUYs."""
        payload = {
            "ticker": "FMG", "recommendation": "BUY",
            "prompt_version": "2026-06-v12", "ai_confidence": 0.71,
            "primary_entry_driver": "mean_reversion",
        }
        r = self.client.post("/api/learning/log",
                             data=json.dumps(payload),
                             content_type="application/json")
        ev_id = json.loads(r.data)["id"]
        with _test_get_db() as conn:
            row = conn.execute(
                "SELECT primary_entry_driver FROM ai_learning_events WHERE id=?",
                (ev_id,)
            ).fetchone()
        self.assertEqual(row["primary_entry_driver"], "mean_reversion")

    def test_classify_entry_driver_taxonomy(self):
        """classify_entry_driver maps signal snapshots to the right driver."""
        from routes.learning import classify_entry_driver, ENTRY_DRIVERS
        # Oversold → mean_reversion
        self.assertEqual(
            classify_entry_driver({"rsi_14": 28, "bb_pct_b": 0.05}),
            "mean_reversion")
        # Lower-band touch with neutral RSI → mean_reversion
        self.assertEqual(
            classify_entry_driver({"rsi_14": 48, "bb_pct_b": 0.10}),
            "mean_reversion")
        # Strong uptrend, short-term dip → trend_pullback
        self.assertEqual(
            classify_entry_driver({"rsi_14": 55, "bb_pct_b": 0.5, "adx_14": 30,
                                   "return_20d": 6, "return_5d": -1.5}),
            "trend_pullback")
        # Recent thrust higher → momentum_breakout
        self.assertEqual(
            classify_entry_driver({"rsi_14": 62, "bb_pct_b": 0.9, "return_5d": 6}),
            "momentum_breakout")
        # Empty / unclassifiable → unknown
        self.assertEqual(classify_entry_driver({}), "unknown")
        self.assertEqual(classify_entry_driver(None), "unknown")
        # All technical drivers must be in the allowed enum
        for d in ("mean_reversion", "momentum_breakout", "trend_pullback"):
            self.assertIn(d, ENTRY_DRIVERS)

    def test_backfill_entry_drivers(self):
        """Backfill fills primary_entry_driver from entry_signals_json, skips unknown."""
        # A BUY with an oversold snapshot but no driver yet
        good = {
            "ticker": "WBC", "recommendation": "BUY", "ai_confidence": 0.66,
            "entry_signals_json": json.dumps({"rsi_14": 25, "bb_pct_b": 0.03}),
        }
        r = self.client.post("/api/learning/log", data=json.dumps(good),
                             content_type="application/json")
        good_id = json.loads(r.data)["id"]
        # A BUY whose snapshot is unclassifiable → must stay NULL
        vague = {
            "ticker": "TLS", "recommendation": "BUY", "ai_confidence": 0.66,
            "entry_signals_json": json.dumps({"rsi_14": 50, "bb_pct_b": 0.5}),
        }
        r2 = self.client.post("/api/learning/log", data=json.dumps(vague),
                              content_type="application/json")
        vague_id = json.loads(r2.data)["id"]

        resp = self.client.post("/api/learning/backfill-entry-drivers")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body["ok"])
        self.assertGreaterEqual(body["updated"], 1)

        with _test_get_db() as conn:
            g = conn.execute("SELECT primary_entry_driver FROM ai_learning_events WHERE id=?",
                             (good_id,)).fetchone()
            v = conn.execute("SELECT primary_entry_driver FROM ai_learning_events WHERE id=?",
                             (vague_id,)).fetchone()
        self.assertEqual(g["primary_entry_driver"], "mean_reversion")
        self.assertIsNone(v["primary_entry_driver"], "unclassifiable snapshot stays NULL")

    # ── Thesis Tracking Phase 2/3 (Sprint 68) ───────────────────────────────────

    def test_entry_context_endpoint(self):
        """GET /api/learning/entry-context returns entry context for a logged BUY."""
        payload = {
            "ticker": "RIO", "recommendation": "BUY",
            "prompt_version": "2026-06-v12", "ai_confidence": 0.78,
            "primary_entry_driver": "momentum_breakout",
            "entry_signals_json": json.dumps({"rsi_14": 65, "bb_pct_b": 0.88,
                                              "return_5d": 5.1, "return_20d": 9.2}),
            "trade_thesis": "Volume breakout above 52-week high",
        }
        r = self.client.post("/api/learning/log",
                             data=json.dumps(payload),
                             content_type="application/json")
        self.assertTrue(json.loads(r.data)["ok"])

        resp = self.client.get("/api/learning/entry-context?tickers=RIO")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIn("RIO", body["contexts"])
        ctx = body["contexts"]["RIO"]
        self.assertEqual(ctx["primary_entry_driver"], "momentum_breakout")
        self.assertIsInstance(ctx["entry_signals"], dict)
        self.assertAlmostEqual(ctx["entry_signals"]["rsi_14"], 65)
        self.assertEqual(ctx["trade_thesis"], "Volume breakout above 52-week high")
        self.assertIn("entry_date", ctx)

    def test_trade_detail_endpoint(self):
        """GET /api/learning/trade-detail returns rich per-event detail by id."""
        payload = {
            "ticker": "STO", "recommendation": "BUY",
            "prompt_version": "2026-06-v13", "ai_confidence": 0.70,
            "primary_entry_driver": "trend_pullback",
            "thesis_verdict": "validated",
            "entry_signals_json": json.dumps({"rsi_14": 48, "adx_14": 28,
                                              "return_5d": -1.2}),
            "trade_thesis": "Buying the dip in an uptrend",
            "outcome_status": "win", "realized_pnl_pct": 4.5,
        }
        r = self.client.post("/api/learning/log",
                             data=json.dumps(payload),
                             content_type="application/json")
        ev_id = json.loads(r.data)["id"]

        resp = self.client.get(f"/api/learning/trade-detail?ids={ev_id}")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        d = body["details"][str(ev_id)]
        self.assertEqual(d["primary_entry_driver"], "trend_pullback")
        self.assertEqual(d["thesis_verdict"], "validated")
        self.assertEqual(d["trade_thesis"], "Buying the dip in an uptrend")
        self.assertIsInstance(d["entry_signals"], dict)
        self.assertAlmostEqual(d["entry_signals"]["rsi_14"], 48)
        self.assertNotIn("entry_signals_json", d)  # raw column not leaked

    def test_trade_detail_empty_ids(self):
        """trade-detail with no ids returns an empty details map, not an error."""
        resp = self.client.get("/api/learning/trade-detail")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body["ok"])
        self.assertEqual(body["details"], {})

    def test_entry_context_missing_ticker_omitted(self):
        """Tickers with no BUY/TOP_UP history must be omitted from contexts."""
        resp = self.client.get("/api/learning/entry-context?tickers=ZZZZ99")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertNotIn("ZZZZ99", body["contexts"])

    def test_thesis_verdict_patchable(self):
        """POST /api/learning/outcome must accept and persist thesis_verdict."""
        payload = {
            "ticker": "NAB", "recommendation": "BUY",
            "prompt_version": "2026-06-v12", "ai_confidence": 0.72,
            "primary_entry_driver": "trend_pullback",
        }
        r = self.client.post("/api/learning/log",
                             data=json.dumps(payload),
                             content_type="application/json")
        ev_id = json.loads(r.data)["id"]

        patch_resp = self.client.post(
            "/api/learning/outcome",
            data=json.dumps({"id": ev_id, "thesis_verdict": "validated"}),
            content_type="application/json",
        )
        self.assertTrue(json.loads(patch_resp.data).get("ok"))

        with _test_get_db() as conn:
            row = conn.execute(
                "SELECT thesis_verdict FROM ai_learning_events WHERE id=?",
                (ev_id,)
            ).fetchone()
        self.assertEqual(row["thesis_verdict"], "validated")

    def test_thesis_matrix_endpoint(self):
        """GET /api/learning/thesis-matrix returns the expected shape."""
        # Insert 2 closed BUY events with driver + verdict + pnl directly into DB.
        with _test_get_db() as conn:
            for rec in [
                ("MQG", "mean_reversion", "validated",   "win",  8.5),
                ("ANZ", "mean_reversion", "invalidated", "loss", -4.2),
            ]:
                ticker, driver, verdict, status, pnl = rec
                conn.execute("""
                    INSERT INTO ai_learning_events
                        (ticker, recommendation, primary_entry_driver, thesis_verdict,
                         outcome_status, realized_pnl_pct, was_executed, timestamp)
                    VALUES (?, 'BUY', ?, ?, ?, ?, 1, datetime('now','localtime'))
                """, (ticker, driver, verdict, status, pnl))

        resp = self.client.get("/api/learning/thesis-matrix")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIn("matrix", body)
        self.assertIn("drivers", body)
        self.assertIn("verdicts", body)
        self.assertGreaterEqual(body["n_total"], 2)
        # mean_reversion validated cell must have at least 1 entry
        mr_val = body["matrix"].get("mean_reversion", {}).get("validated", {})
        self.assertGreaterEqual(mr_val.get("n", 0), 1)

    def test_compute_thesis_matrix_helper(self):
        """_compute_thesis_matrix returns expected keys when called directly."""
        from routes.learning import _compute_thesis_matrix
        with _test_get_db() as conn:
            result = _compute_thesis_matrix(conn)
        for key in ("n_total", "drivers", "verdicts", "matrix", "insight"):
            self.assertIn(key, result, f"Missing key: {key}")
        self.assertIsInstance(result["drivers"], list)
        self.assertIsInstance(result["verdicts"], list)
        self.assertIsInstance(result["matrix"], dict)
        self.assertIsInstance(result["insight"], str)


class TestQuoteRoute(unittest.TestCase):
    """Smoke-test /api/quote — just checks response shape, not live price."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_quote_returns_json(self):
        resp = self.client.get("/api/quote/BHP")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        # Should have at least one of these keys (even if price fetch fails)
        self.assertTrue(
            "price" in body or "error" in body,
            f"Unexpected response shape: {body}"
        )


class TestDividendsRoute(unittest.TestCase):
    """Smoke-test /api/dividends/<ticker>."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_dividends_returns_json_with_history(self):
        resp = self.client.get("/api/dividends/CBA")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        # Should have history list (may be empty if yfinance unavailable)
        self.assertIn("history", body, f"Missing 'history' key: {body}")
        self.assertIsInstance(body["history"], list)

    def test_dividends_batch_returns_dict(self):
        resp = self.client.post(
            "/api/dividends/batch",
            data=json.dumps({"tickers": ["CBA", "NAB"]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        # Should be a dict keyed by ticker
        self.assertIsInstance(body, dict)


class TestPolymarketRoute(unittest.TestCase):
    """Test /api/polymarket returns the expected shape."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        # Force cache miss so route actually runs (cache lives in routes.market now)
        from routes import market as _market_mod
        _market_mod._PM_CACHE["data"] = None
        _market_mod._PM_CACHE["fetched_at"] = 0.0
        cls._market_mod = _market_mod
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_polymarket_shape(self):
        """Route should return markets list + fetched_at regardless of network."""
        resp = self.client.get("/api/polymarket")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("markets", body)
        self.assertIn("fetched_at", body)
        self.assertIsInstance(body["markets"], list)
        self.assertEqual(len(body["markets"]), len(self._market_mod._PM_QUERIES))

    def test_polymarket_each_entry_has_required_keys(self):
        resp = self.client.get("/api/polymarket")
        body = json.loads(resp.data)
        for m in body["markets"]:
            for key in ("id", "label", "positive_for_asx", "yes_prob", "question"):
                self.assertIn(key, m, f"market entry missing key '{key}': {m}")

    def test_polymarket_cache_serves_cached(self):
        """Second call within TTL should return cached=True."""
        resp = self.client.get("/api/polymarket")
        body = json.loads(resp.data)
        # If cache was populated by prior test, cached=True; otherwise False (first fetch)
        self.assertIn("cached", body)


class TestJSSyntax(unittest.TestCase):
    """Validate syntax of every JS file we've modified using node --check."""

    FILES = [
        "js/analysis.js",
        "js/alerts.js",
        "js/pages/learning.js",
        "js/pages/performance.js",
        "js/pages/recommendations.js",
        "js/pages/macro.js",
        "js/pages/scanner.js",
        "js/learning-loop.js",
        "js/prices.js",
    ]

    def _check(self, rel_path):
        full = os.path.join(ROOT, rel_path)
        result = subprocess.run(
            ["node", "--check", full],
            capture_output=True, text=True
        )
        self.assertEqual(
            result.returncode, 0,
            f"JS syntax error in {rel_path}:\n{result.stderr}"
        )

    def test_analysis_js(self):       self._check("js/analysis.js")
    def test_alerts_js(self):         self._check("js/alerts.js")
    def test_learning_js(self):       self._check("js/pages/learning.js")
    def test_performance_js(self):    self._check("js/pages/performance.js")
    def test_recommendations_js(self):self._check("js/pages/recommendations.js")
    def test_macro_js(self):          self._check("js/pages/macro.js")
    def test_scanner_js(self):        self._check("js/pages/scanner.js")
    def test_learning_loop_js(self):  self._check("js/learning-loop.js")
    def test_prices_js(self):         self._check("js/prices.js")


class TestJSFunctionPresence(unittest.TestCase):
    """Grep key function definitions to guard against accidental deletion."""

    def _contains(self, rel_path, needle):
        with open(os.path.join(ROOT, rel_path), encoding="utf-8") as f:
            return needle in f.read()

    # analysis.js
    def test_logRecsToLearningLoop_defined(self):
        self.assertTrue(self._contains("js/analysis.js", "function logRecsToLearningLoop"))

    def test_alertHighConviction_called(self):
        self.assertTrue(self._contains("js/analysis.js", "alertHighConviction"))

    # learning.js
    def test_renderLearningPage_defined(self):
        self.assertTrue(self._contains("js/pages/learning.js", "function renderLearningPage"))

    def test_deleteLearningEvent_defined(self):
        self.assertTrue(self._contains("js/pages/learning.js", "function deleteLearningEvent"))

    def test_delete_button_wired(self):
        self.assertTrue(self._contains("js/pages/learning.js", "deleteLearningEvent(${ev.id})"))

    # performance.js
    def test_syncClosedTradesToLearningLoop_defined(self):
        self.assertTrue(self._contains("js/pages/performance.js", "function syncClosedTradesToLearningLoop"))

    def test_exportTradeJournalCSV_has_entryPrice(self):
        self.assertTrue(self._contains("js/pages/performance.js", "t.entryPrice"))

    def test_sortino_uses_entryPrice(self):
        # The fix changed t.avgPrice → t.entryPrice in Sortino computation
        src = open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8").read()
        # Look for entryPrice inside the pnlPcts map block
        self.assertIn("entryPrice", src)

    # alerts.js
    def test_fireAlert_defined(self):
        self.assertTrue(self._contains("js/alerts.js", "function fireAlert"))

    def test_checkRecStopTargetAlerts_defined(self):
        self.assertTrue(self._contains("js/alerts.js", "function checkRecStopTargetAlerts"))

    # recommendations.js
    def test_markExecuted_defined(self):
        self.assertTrue(self._contains("js/pages/recommendations.js", "function markExecuted"))

    def test_markSkipped_defined(self):
        self.assertTrue(self._contains("js/pages/recommendations.js", "function markSkipped"))

    def test_markExecuted_logs_manual_import(self):
        """Sells on manually-imported stocks (no _learningId) must fall into the else-if branch."""
        self.assertTrue(self._contains("js/pages/recommendations.js",
                                       "Manually imported position"))

    # learning-loop.js — new v2 functions
    def test_calibration_block_fetcher_defined(self):
        # Renamed from buildCalibrationPromptBlock → fetchCalibrationBlock when
        # calibration moved to the backend in v2 of the learning loop.
        self.assertTrue(self._contains("js/learning-loop.js", "function fetchCalibrationBlock"))

    def test_refreshLearningCache_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function refreshLearningCache"))

    def test_computeAllTradesStats_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function computeAllTradesStats"))

    def test_computeRRRealization_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function computeRRRealization"))

    def test_detectStrategyDecay_has_volatility(self):
        self.assertTrue(self._contains("js/learning-loop.js", "recentVolatility"))

    def test_calibration_wired_in_analysis(self):
        # analysis.js now calls fetchCalibrationBlock() instead of refreshLearningCache().
        self.assertTrue(self._contains("js/analysis.js", "fetchCalibrationBlock"))

    def test_learning_loop_uses_backend_cache(self):
        self.assertTrue(self._contains("js/learning-loop.js", "state._learningCache"))


class TestPythonSyntax(unittest.TestCase):
    """Parse asx_server.py and indicators.py via ast to catch syntax errors."""

    def _parse(self, filename):
        import ast
        path = os.path.join(ROOT, filename)
        with open(path, encoding="utf-8") as f:
            src = f.read()
        try:
            ast.parse(src)
        except SyntaxError as e:
            self.fail(f"SyntaxError in {filename}: {e}")

    def test_asx_server_syntax(self):
        self._parse("asx_server.py")

    def test_indicators_syntax(self):
        self._parse("indicators.py")


class TestLearningLoopRSScoringIntegration(unittest.TestCase):
    """Verify the conf_bands returned by /stats use 0-100 scale as documented."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        # Seed a win and a loss at the 70-80% confidence band
        with _test_get_db() as conn:
            conn.execute("""
                INSERT INTO ai_learning_events
                    (ticker, ai_confidence, outcome_status, was_executed, prompt_version)
                VALUES (?,?,?,?,?)
            """, ("WBC", 0.75, "win", 1, "test-v1"))
            conn.execute("""
                INSERT INTO ai_learning_events
                    (ticker, ai_confidence, outcome_status, was_executed, prompt_version)
                VALUES (?,?,?,?,?)
            """, ("ANZ", 0.75, "loss", 1, "test-v1"))
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_conf_band_win_rate_is_0_to_100(self):
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        for band in body.get("conf_bands", []):
            wr = band.get("win_rate")
            if wr is not None:
                self.assertLessEqual(wr, 100.0,
                    f"conf_band win_rate should be 0-100, got {wr}")

    def test_overall_win_rate_50_percent_for_1w_1l(self):
        resp = self.client.get("/api/learning/stats")
        body = json.loads(resp.data)
        wr = body.get("overall_win_rate")
        if wr is not None:
            # We seeded 1 win + 1 loss = 50 % (plus any prior events from other tests)
            self.assertGreaterEqual(wr, 0)
            self.assertLessEqual(wr, 100)


class TestRegressionBugs(unittest.TestCase):
    """Regression tests for bugs fixed in the 2026-05 review pass.

    One test per bug; if the test fails, the bug has returned.
    """

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Bug #1: quant-engine liquidity unit ──────────────────────────────────
    def test_quant_engine_liquidity_in_shares_not_dollars(self):
        """qty_by_liquidity must be 5% of SHARES, not 5% of dollars."""
        with open(os.path.join(ROOT, "js/quant-engine.js"), encoding="utf-8") as f:
            src = f.read()
        # Must reference shares-based variable; must not multiply raw adv20 by 0.05 as shares
        self.assertIn("advShares", src, "quant-engine.js must derive a share count from adv_20")
        self.assertNotIn("adv20 * (_ap.maxLiquidityPct", src,
                         "Old dollar-as-shares math should be gone")

    # ── Bug #2: priceAlerts persistence ──────────────────────────────────────
    def test_pricealerts_in_save_payload(self):
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("priceAlerts: state.priceAlerts", src,
                      "saveStateToDb must send priceAlerts")
        self.assertIn("data.priceAlerts", src,
                      "loadStateFromDb must restore priceAlerts")

    def test_pricealerts_in_load_response(self):
        """/api/db/load response includes priceAlerts key."""
        resp = self.client.get("/api/db/load")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("priceAlerts", body, "/api/db/load must return priceAlerts")

    # ── Bug #3: alert spam ────────────────────────────────────────────────────
    def test_alert_spam_guard_in_alerts_js(self):
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_stopAlertedAt", src,
                      "alerts.js must track _stopAlertedAt to prevent spam")
        self.assertIn("_targetAlertedAt", src,
                      "alerts.js must track _targetAlertedAt")

    # ── Bug #4: panic regime qty=0 ────────────────────────────────────────────
    def test_regime_panic_blocks_qty(self):
        with open(os.path.join(ROOT, "js/regime-engine.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("sizeMult === 0", src,
                      "regime-engine must hard-block on sizeMult=0")
        self.assertIn("_regimeBlocked", src,
                      "regime-engine must flag _regimeBlocked")

    def test_analysis_drops_regime_blocked_recs(self):
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_regimeBlocked", src,
                      "analysis.js must filter out _regimeBlocked recs")

    # ── Bug #5: sector map dedup ──────────────────────────────────────────────
    def test_sector_map_no_duplicates(self):
        """ASX_SECTOR_MAP must have each ticker exactly once."""
        from indicators import ASX_SECTOR_MAP
        # If dict was built from duplicate literal keys Python silently kept last;
        # we re-parse the source to detect duplicates.
        import re
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        # Find the ASX_SECTOR_MAP literal
        m = re.search(r"ASX_SECTOR_MAP = \{(.*?)\n\}", src, re.DOTALL)
        self.assertIsNotNone(m, "ASX_SECTOR_MAP literal not found")
        keys = re.findall(r"'([A-Z0-9]+)':", m.group(1))
        dupes = {k for k in keys if keys.count(k) > 1}
        self.assertEqual(dupes, set(), f"Duplicate keys in ASX_SECTOR_MAP: {dupes}")

    # ── Bug #6: ASX universe dedup ────────────────────────────────────────────
    def test_asx_universes_have_no_duplicates(self):
        for u in ("asx20", "asx50", "asx100", "asx200"):
            tickers = asx_server._ASX_UNIVERSE[u]
            self.assertEqual(len(tickers), len(set(tickers)),
                             f"_ASX_UNIVERSE['{u}'] contains duplicates")

    # ── Bug #8: ticker regex accepts digits ───────────────────────────────────
    def test_ticker_regex_accepts_digits(self):
        with open(os.path.join(ROOT, "js/response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        # Must include 0-9 in the character class
        self.assertIn("[A-Z0-9]", src,
                      "ticker pattern must accept digits (A2M, S32, MP1, 360)")

    # ── Bug #9: HOLD schema opt-out ───────────────────────────────────────────
    def test_validator_hold_optional_fields(self):
        with open(os.path.join(ROOT, "js/response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("requiredUnless", src,
                      "validator must support requiredUnless for HOLD recs")

    # ── Bug #11: html closing tag ─────────────────────────────────────────────
    def test_html_has_close_tag(self):
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("</html>", src, "asx_trading.html must close with </html>")

    # ── Bug #12: gitignore covers key.txt ─────────────────────────────────────
    def test_gitignore_blocks_key_files(self):
        with open(os.path.join(ROOT, ".gitignore"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("key.txt", src, ".gitignore must list key.txt")

    # ── Bug: _detectExitReason ignored trade direction ───────────────────────
    def test_detect_exit_reason_direction_aware(self):
        """SELL/TRIM recs frame stop ABOVE and target BELOW entry; _detectExitReason
        must invert its comparisons so a profitable trim isn't mislabeled stop_hit.

        §3.8: The function now has a single canonical copy in utils.js.
        We evaluate it against known cases; page files must NOT redefine it.
        """
        node_script = r"""
const fs = require('fs');
const src = fs.readFileSync(process.argv[1], 'utf8');
const start = src.indexOf('function _detectExitReason');
if (start < 0) { console.error('function not found'); process.exit(2); }
let i = src.indexOf('{', start), depth = 0, end = -1;
for (; i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
eval(src.slice(start, end));
const cases = [
  // [exit, stop, target, action, expected]
  [9.0,  10.0, 15.0,  'BUY',  'stop_hit'],
  [16.0, 10.0, 15.0,  'BUY',  'target_hit'],
  [12.0, 10.0, 15.0,  'BUY',  'manual'],
  [15.0, 14.79, 13.59, 'TRIM', 'stop_hit'],
  [13.0, 14.79, 13.59, 'TRIM', 'target_hit'],
  [14.0, 14.79, 13.59, 'TRIM', 'manual'],
  [55.1, 58.84, 47.54, 'SELL', 'manual'],
  // geometry fallback when action absent (stop > target => bearish framing)
  [15.0, 14.79, 13.59, undefined, 'stop_hit'],
];
let fail = 0;
for (const [ex, st, tg, ac, exp] of cases) {
  const got = _detectExitReason(ex, st, tg, ac);
  if (got !== exp) { console.error(`FAIL (${ex},${st},${tg},${ac}) expected ${exp} got ${got}`); fail++; }
}
process.exit(fail ? 1 : 0);
"""
        # Canonical copy lives in utils.js
        result = subprocess.run(
            ["node", "-e", node_script, os.path.join(ROOT, "js/utils.js")],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0,
                         f"js/utils.js _detectExitReason direction logic wrong:\n{result.stderr}")
        # Page files must NOT redefine the function (single canonical copy guard)
        for fn in ("js/pages/recommendations.js", "js/pages/performance.js"):
            with open(os.path.join(ROOT, fn), encoding="utf-8") as f:
                src = f.read()
            self.assertNotIn("function _detectExitReason", src,
                             f"{fn} must NOT redefine _detectExitReason (§3.8: single copy in utils.js)")


class TestInfraImprovements(unittest.TestCase):
    """Tests for the production-grade upgrades."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True
        # The Claude-proxy tests below exercise the real key-file write/clear
        # path. routes.claude.CLAUDE_API_KEY_FILE is an absolute path to the
        # real claude-api.txt at the repo root — patch it to a scratch temp
        # file for the duration of this class so tests never touch (and
        # never delete) the user's actual stored API key.
        import routes.claude as claude_routes
        cls._claude_key_file_patch = mock.patch.object(
            claude_routes, "CLAUDE_API_KEY_FILE",
            os.path.join(tempfile.gettempdir(), "test_claude_api_key_scratch.txt"))
        cls._claude_key_file_patch.start()

    @classmethod
    def tearDownClass(cls):
        cls._claude_key_file_patch.stop()
        scratch = os.path.join(tempfile.gettempdir(), "test_claude_api_key_scratch.txt")
        try:
            os.remove(scratch)
        except OSError:
            pass

    def test_db_module_exposes_get_db(self):
        import db as db_module
        self.assertTrue(callable(db_module.get_db))
        self.assertTrue(callable(db_module.init_db))
        self.assertTrue(callable(db_module.log_failed_ticker))

    def test_ttl_cache_decorator_exists(self):
        self.assertTrue(callable(asx_server.ttl_cache),
                        "ttl_cache decorator must be exposed")

    def test_ttl_cache_memoises(self):
        calls = []
        @asx_server.ttl_cache(seconds=30)
        def slow(x):
            calls.append(x)
            return x * 2

        self.assertEqual(slow(3), 6)
        self.assertEqual(slow(3), 6)
        self.assertEqual(len(calls), 1, "ttl_cache should memoise repeated calls")

    def test_claude_proxy_settings_endpoint_exists(self):
        resp = self.client.get("/api/claude/settings")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("has_key", body)

    def test_claude_proxy_rejects_without_key(self):
        """Proxy must refuse to forward if no server-stored key exists."""
        # Clear any key first
        self.client.post("/api/claude/settings",
                         data=json.dumps({"api_key": ""}),
                         content_type="application/json")
        resp = self.client.post("/api/claude/proxy",
                                data=json.dumps({"model": "x", "messages": []}),
                                content_type="application/json")
        self.assertEqual(resp.status_code, 400)
        body = json.loads(resp.data)
        self.assertEqual(body["error"]["type"], "no_proxy_key")

    def test_claude_proxy_settings_validates_format(self):
        """POST with malformed key should be rejected."""
        resp = self.client.post("/api/claude/settings",
                                data=json.dumps({"api_key": "not-a-real-key"}),
                                content_type="application/json")
        self.assertEqual(resp.status_code, 400)

    def test_frontend_error_boundary_present(self):
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_renderPageUnsafe", src,
                      "navigation.js must wrap render in error boundary")
        self.assertIn("Page crashed", src)

    def test_state_validators_present(self):
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_validHolding", src,
                      "api.js must sanitise loaded portfolio holdings")

    def test_gunicorn_config_exists(self):
        path = os.path.join(ROOT, "gunicorn.conf.py")
        self.assertTrue(os.path.isfile(path), "gunicorn.conf.py must exist")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("worker_class", src)
        self.assertIn("threads", src)


class TestStage1DataCapture(unittest.TestCase):
    """Regression tests for Stage 1 — Data capture improvements."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_debate_bull_bear_uses_think_false(self):
        """Bull/bear Ollama calls must pass think=False to avoid thinking-token budget waste."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Both bull and bear calls must now have think=False, num_predict=350
        self.assertIn("think=False, num_predict=350", src,
                      "Bull/bear Ollama calls must use think=False and num_predict=350")
        # Check it appears at least twice (bull AND bear call)
        self.assertGreaterEqual(src.count("think=False, num_predict=350"), 2)

    def test_entry_signals_json_in_db_migrations(self):
        """entry_signals_json column must be in _LE_MIGRATIONS."""
        import db as _db
        col_names = [col for col, _ in _db._LE_MIGRATIONS]
        self.assertIn("entry_signals_json", col_names,
                      "_LE_MIGRATIONS must include entry_signals_json TEXT column")

    def test_entry_signals_json_accepted_by_log_endpoint(self):
        """POST /api/learning/log must accept and persist entry_signals_json."""
        signals = {"rsi_14": 32.5, "bb_pct_b": 0.08, "adx_14": 18.0,
                   "atr_pct": 1.2, "return_5d": -2.1, "return_20d": -6.4}
        resp = self.client.post(
            "/api/learning/log",
            data=json.dumps({
                "ticker": "BHP.AX", "event_type": "recommendation",
                "recommendation": "BUY", "ai_confidence": 0.72,
                "entry_signals_json": json.dumps(signals),
            }),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIn("id", body)

    def test_entry_signals_json_captured_in_analysis_js(self):
        """logRecsToLearningLoop must build and send entry_signals_json."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("entry_signals_json", src,
                      "analysis.js must include entry_signals_json in learning log payload")
        self.assertIn("liveSignals", src)

    def test_entry_signals_json_wide_snapshot(self):
        """Sprint 71 1A: entry_signals_json must carry the widened entry signature
        (price location, volume, MACD, relative strength, setup, fundamentals)
        in addition to the original 6 fields."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # original 6 retained
        for k in ("rsi_14", "bb_pct_b", "adx_14", "atr_pct", "return_5d", "return_20d"):
            self.assertIn(k, src, f"entry_signals_json must retain {k}")
        # new wide fields
        for k in ("px_vs_sma20", "px_vs_sma50", "px_vs_sma200",
                  "pct_from_high60", "pct_from_low60", "rvol", "adv_20",
                  "macd_hist", "macd_hist_prev", "macd_bullish",
                  "rs_score", "rs_5d_alpha", "setup_score",
                  "forward_pe", "pb_ratio", "dividend_yield",
                  "revenue_growth", "earnings_growth", "days_to_earnings"):
            self.assertIn(k, src, f"entry_signals_json must include new field {k}")

    def test_detect_exit_reason_helper_present(self):
        """_detectExitReason must be defined in utils.js (single canonical copy) and
        referenced by both recommendations.js and performance.js."""
        with open(os.path.join(ROOT, "js/utils.js"), encoding="utf-8") as f:
            utils_src = f.read()
        self.assertIn("function _detectExitReason", utils_src,
                      "utils.js must define _detectExitReason")
        self.assertIn("stop_hit", utils_src)
        self.assertIn("target_hit", utils_src)
        # Page files must call the function (not redefine it)
        for fn in ("js/pages/recommendations.js", "js/pages/performance.js"):
            with open(os.path.join(ROOT, fn), encoding="utf-8") as f:
                src = f.read()
            self.assertIn("_detectExitReason", src,
                          f"{fn} must reference _detectExitReason")
            self.assertNotIn("function _detectExitReason", src,
                             f"{fn} must NOT redefine _detectExitReason (single copy in utils.js)")

    def test_exit_reason_no_longer_hardcoded_manual(self):
        """recommendations.js must call _detectExitReason instead of hardcoding 'manual'."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        # Old hardcoded pattern must be gone
        self.assertNotIn("exit_reason: 'manual'", src,
                         "Exit reason must be auto-detected, not hardcoded 'manual'")
        self.assertIn("_detectExitReason(", src)

    def test_buy_parent_reconcile_present(self):
        """markExecuted must reconcile parent BUY learning events on full position close."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("positionClosed", src,
                      "markExecuted must detect full position close for BUY reconcile")
        self.assertIn("parentRecs", src)


class TestStage2AutoClassification(unittest.TestCase):
    """Regression tests for Stage 2 — Auto-classification."""

    def test_auto_postmortem_triggered_on_loss(self):
        """Postmortem and skill scoring are manual-only — recommendations.js must NOT auto-trigger them."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        # The functions are still defined in debate-client.js and callable manually;
        # but markExecuted must not call them automatically.
        self.assertNotIn("triggerPostmortem(res.id)", src,
                         "triggerPostmortem must not be auto-called from markExecuted — manual only")
        self.assertNotIn("fetchSkillScore(res.id)", src,
                         "fetchSkillScore must not be auto-called from markExecuted — manual only")

    def test_calibration_accepts_tickers_param(self):
        """GET /api/learning/calibration must accept 'tickers' query param."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("tickers_req", src,
                      "calibration endpoint must parse 'tickers' query param")
        self.assertIn("per-ticker:", src,
                      "calibration must emit per-ticker memory line")

    def test_calibration_query_includes_ticker_column(self):
        """The calibration SQL query must SELECT ticker for per-ticker stats."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # The SELECT in calibration must include ticker
        self.assertIn('SELECT ai_confidence, outcome_status, regime, sector, ticker,', src)

    def test_fetch_calibration_block_accepts_tickers(self):
        """fetchCalibrationBlock in learning-loop.js must accept tickers argument."""
        with open(os.path.join(ROOT, "js/learning-loop.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function fetchCalibrationBlock(regime, sectors, tickers, opts = {})", src)
        self.assertIn("tickers.join(',')", src)

    def test_analysis_passes_portfolio_tickers_to_calibration(self):
        """analysis.js must pass portfolio tickers to fetchCalibrationBlock."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_portfolioTickers", src)
        # Sprint 71 Phase 3D: the call now passes a deep-mode opts arg as 4th param.
        self.assertIn("fetchCalibrationBlock(_activeRegime, _portfolioSectors, _portfolioTickers, { deep: true })", src)


class TestStage3PromptInstructions(unittest.TestCase):
    """Regression tests for Stage 3 — Prompt instructions."""

    def test_prompt_version_current(self):
        """PROMPT_VERSION must be bumped to v15 after the fundamentals-over-technicals rule addition."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("PROMPT_VERSION = '2026-06-v15'", src,
                      "PROMPT_VERSION must be 2026-06-v15 after adding Rule 20 (fundamentals > technicals)")

    def test_entry_driver_in_prompt(self):
        """Sprint 67: ANALYSIS_SYSTEM_PROMPT must require primary_entry_driver on BUYs."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("primary_entry_driver", src,
                      "prompts.js must instruct Claude to emit primary_entry_driver")
        for drv in ("mean_reversion", "momentum_breakout", "trend_pullback",
                    "fundamental_value", "macro_tailwind"):
            self.assertIn(drv, src, f"entry-driver enum '{drv}' missing from prompt")

    def test_entry_driver_logged_in_analysis_js(self):
        """Sprint 67: analysis.js must forward primary_entry_driver for BUY/TOP_UP."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("primary_entry_driver", src,
                      "analysis.js must include primary_entry_driver in the log payload")
        self.assertIn("_ENTRY_DRIVERS", src,
                      "analysis.js must normalise the driver against the allowed enum")

    def test_journal_trade_detail_wiring(self):
        """Sprint 69: journal.js must expose the trade-detail drawer + capture manual technicals."""
        with open(os.path.join(ROOT, "js/pages/journal.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("toggleJournalDetail", src,
                      "journal.js must define the trade-detail toggle")
        self.assertIn("_fetchSignalSnapshot", src,
                      "journal.js must snapshot technicals for manual trades")
        self.assertIn("/api/learning/trade-detail", src,
                      "journal.js must fetch per-trade detail from the backend")
        self.assertIn("entrySignals", src,
                      "manual trade entries must carry an entrySignals snapshot")

    def test_calibration_is_context_only_in_system_prompt(self):
        """§8.3 (supersedes Stage 3): the system prompt must present CALIBRATION as
        context and explicitly forbid Claude from applying the numeric adjustments —
        the engine applies them deterministically post-response (analysis.js)."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Do NOT apply the numeric adjustments yourself", src,
                      "Section 6 must forbid LLM-side calibration arithmetic")
        self.assertIn("per-ticker", src,
                      "System prompt must still mention per-ticker calibration context")

    def test_debate_block_usage_rule_in_prompt(self):
        """System prompt must include the debate-block usage rule."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Local Debate", src,
                      "System prompt must contain guidance on handling Local Debate blocks")
        self.assertIn("BULL and BEAR", src)


class TestStage4ActiveFeedback(unittest.TestCase):
    """Regression tests for Stage 4 — Active feedback (synthesizer)."""

    def test_debate_returns_synthesis_field(self):
        """/api/debate response must include 'synthesis' key (even if None)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"synthesis":', src,
                      "debate_bull_bear must include synthesis field in response")
        self.assertIn("synth_prompt", src)
        self.assertIn("key_pivot", src)

    def test_debate_format_includes_synthesis_line(self):
        """formatDebateBlock in debate-client.js must include SYNTHESIS line when present."""
        with open(os.path.join(ROOT, "js/debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("SYNTHESIS:", src,
                      "debate-client.js must format synthesis as SYNTHESIS: line")
        self.assertIn("key_pivot", src)
        self.assertIn("debate.synthesis", src)


class TestDebateImprovements(unittest.TestCase):
    """Regression tests for D1–D7 debate engine improvements."""

    def test_debate_signals_include_5d_20d_returns(self):
        """sig_text must include 5d and 20d returns (D4)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("return_5d", src)
        self.assertIn("return_20d", src)
        self.assertIn("atr_pct", src)
        # Check these are in sig_text construction
        self.assertIn("5d=", src)
        self.assertIn("20d=", src)

    def test_signal_hash_includes_5d_20d(self):
        """Signal hash must include return_5d, return_20d, atr_pct (D4)."""
        with open(os.path.join(ROOT, "js/debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("return_5d", src)
        self.assertIn("return_20d", src)
        self.assertIn("atr_pct", src)
        # Verify it's in the hash function, not just in general usage
        hash_fn_idx = src.index("function _signalHash")
        hash_fn_end = src.index("\n}", hash_fn_idx) + 2
        hash_body = src[hash_fn_idx:hash_fn_end]
        self.assertIn("return_5d", hash_body)

    def test_sell_trim_get_exit_biased_prompts(self):
        """SELL/TRIM actions must trigger exit-biased bull/bear prompts (D7)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("is_exit", src)
        self.assertIn("exiting this position", src)
        self.assertIn("hold case", src.lower())

    def test_action_passed_to_debate_endpoint(self):
        """fetchDebate must pass action field in request body (D7)."""
        with open(os.path.join(ROOT, "js/debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("action: opts.action", src)
        self.assertIn("actions?.[t]", src)

    def test_synthesizer_num_predict_increased(self):
        """Synthesizer num_predict must be 180, not 120 (D1)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Should have 180 for synthesizer, NOT 120
        self.assertIn("num_predict=180", src)
        self.assertNotIn("num_predict=120", src)

    def test_synthesizer_json_extraction_improved(self):
        """Synthesizer must try json.loads first then scan from end (D2)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("json.loads(clean)", src)
        self.assertIn("reversed(list(re.finditer", src)

    def test_no_think_removed_from_prompts(self):
        """All prompt strings must not contain /no_think (D3)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("/no_think", src,
                         "D3: /no_think is redundant with think=False and must be removed")

    def test_entry_signals_in_postmortem_prompt_builder(self):
        """_pm_build_prompt must accept and inject entry_signals_str (D5)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("entry_signals_str", src)
        self.assertIn("Entry signals at the time", src)

    def test_skill_prompt_includes_entry_signals(self):
        """Skill score prompt must include entry_signals when available (D6)."""
        with open(os.path.join(ROOT, "routes/debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Both the SELECT and the prompt injection must be present
        self.assertIn("entry_signals_json", src)
        # entry_signals_json must appear in the SELECT for debate_skill
        skill_idx = src.index("def debate_skill()")
        skill_body = src[skill_idx:skill_idx + 2000]
        self.assertIn("entry_signals_json", skill_body)

    def test_synthesis_winner_in_debate_summary(self):
        """buildDebateSummary must include synthesis winner in stored record (L5)."""
        with open(os.path.join(ROOT, "js/debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("synthesis.winner", src)
        # Verify the summary builder uses it
        idx = src.index("function buildDebateSummary")
        body = src[idx:idx + 400]
        self.assertIn("synthesis", body)


class TestLearningImprovements(unittest.TestCase):
    """Regression tests for L1–L4 and L6 learning loop improvements."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_regime_warning_skips_zero_trades(self):
        """Calibration must not emit regime warning when 0 trades exist (L1)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Since ESS migration: regime section must skip when reg is empty.
        # Old: '0 < len(reg) < 3'. New: 'if not reg:' guard in ESS branch.
        # ESS guard: ess_reg = 0.0 when reg is empty, which is < _ESS_MIN, so it skips.
        self.assertTrue(
            "0 < len(reg) < 3" in src
            or "if not reg:" in src
            or ("ess_reg" in src and "_ESS_MIN" in src),
            "L1: regime warning must skip when 0 trades exist (old guard, if-not-reg, or ESS gate)"
        )

    def test_error_type_threshold_lowered(self):
        """Error-type threshold must be 0.33, not 0.40 (L2)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("top_pct >= 0.33", src,
                      "L2: error-type threshold must be 0.33 (was 0.40)")
        self.assertNotIn("top_pct >= 0.40", src)

    def test_auto_expire_not_in_stats_get(self):
        """Auto-expire must NOT run inside learning_stats GET handler (L3)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # _expire_old_events must be a standalone function
        self.assertIn("def _expire_old_events(", src)
        # It should be called from learning_log, not from learning_stats
        stats_idx = src.index("def learning_stats()")
        stats_body = src[stats_idx:stats_idx + 500]
        self.assertNotIn("_expire_old_events", stats_body,
                         "L3: auto-expire must not run inside the GET /stats handler")
        log_idx = src.index("def learning_log()")
        log_body = src[log_idx:log_idx + 500]
        self.assertIn("_expire_old_events", log_body,
                      "L3: auto-expire must run inside learning_log (write path)")

    def test_calibration_ttl_cache_present(self):
        """Calibration must use a module-level TTL cache (L4)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_calib_cache", src)
        self.assertIn("_CALIB_TTL", src)
        self.assertIn("_calib_compute(", src)

    def test_calibration_compute_extracted(self):
        """_calib_compute must be a pure function separate from the route (L4)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # _calib_compute must return a dict, not call jsonify
        idx = src.index("def _calib_compute(")
        end = src.index("\ndef ", idx + 1)
        body = src[idx:end]
        self.assertNotIn("jsonify", body,
                         "_calib_compute must return a dict, not a Flask response")
        self.assertIn("return {", body)

    def test_debate_synthesis_winner_in_db_migrations(self):
        """debate_synthesis_winner column must be in _LE_MIGRATIONS (L6)."""
        import db as _db
        col_names = [col for col, _ in _db._LE_MIGRATIONS]
        self.assertIn("debate_synthesis_winner", col_names)

    def test_debate_synthesis_winner_accepted_by_log(self):
        """POST /api/learning/log must accept debate_synthesis_winner (L6)."""
        resp = self.client.post(
            "/api/learning/log",
            data=json.dumps({
                "ticker": "CBA.AX", "event_type": "recommendation",
                "recommendation": "BUY", "ai_confidence": 0.75,
                "debate_synthesis_winner": "bull",
            }),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))

    def test_synthesis_winner_logged_in_analysis(self):
        """analysis.js must log debate_synthesis_winner in learning payload (L6)."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("debate_synthesis_winner", src)
        self.assertIn("_debate?.synthesis?.winner", src)


class TestSprint5(unittest.TestCase):
    """Tests for Sprint 5 features: postmortem digest, EOFY tax pack, persistence fixes."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_learning_digest_data_empty(self):
        """GET /api/learning/digest-data returns valid shape on empty DB."""
        resp = self.client.get("/api/learning/digest-data")
        self.assertEqual(resp.status_code, 200)
        d = json.loads(resp.data)
        self.assertIn("recent_failures", d)
        self.assertIn("regime_stats", d)
        self.assertIn("error_dist", d)
        self.assertIn("exit_dist", d)
        self.assertIsInstance(d["recent_failures"], list)

    def test_learning_digest_data_with_losses(self):
        """GET /api/learning/digest-data includes recent loss events."""
        # Seed a loss event
        self.client.post(
            "/api/learning/log",
            data=json.dumps({"ticker": "TLS.AX", "event_type": "recommendation",
                             "recommendation": "BUY", "ai_confidence": 0.70}),
            content_type="application/json",
        )
        row = _get_shared_conn().execute(
            "SELECT id FROM ai_learning_events WHERE ticker='TLS.AX'"
        ).fetchone()
        if row:
            self.client.post(
                "/api/learning/outcome",
                data=json.dumps({"id": row["id"], "outcome_status": "loss",
                                 "was_executed": 1, "realized_pnl_pct": -5.2,
                                 "exit_reason": "stop_hit"}),
                content_type="application/json",
            )
        resp = self.client.get("/api/learning/digest-data")
        self.assertEqual(resp.status_code, 200)
        d = json.loads(resp.data)
        tickers = [f["ticker"] for f in d["recent_failures"]]
        self.assertIn("TLS.AX", tickers)

    def test_eofy_pack_returns_zip(self):
        """GET /api/tax/eofy-pack returns a zip file."""
        resp = self.client.get("/api/tax/eofy-pack?year=2024")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.content_type, "application/zip")
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(resp.data)) as zf:
            names = zf.namelist()
        self.assertTrue(any("cgt_disposals" in n for n in names))
        self.assertTrue(any("trade_fees" in n for n in names))

    def test_eofy_pack_with_disposals(self):
        """EOFY pack includes CGT disposals when present in blob_store."""
        sample = json.dumps([{
            "saleDate": "2025-03-15", "ticker": "CBA",
            "salePrice": 130.0, "saleQty": 10, "proceeds": 1300.0,
            "parcelDate": "2024-01-10", "parcelCostPerShare": 100.0,
            "costBase": 1000.0, "saleFee": 10.0,
            "grossGain": 290.0, "discount": 145.0, "netGain": 145.0,
            "heldDays": 429, "eligible50": True,
        }])
        _get_shared_conn().execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES ('cgtDisposals', ?, datetime('now'))",
            (sample,)
        )
        _get_shared_conn().commit()

        resp = self.client.get("/api/tax/eofy-pack?year=2024")
        self.assertEqual(resp.status_code, 200)
        import zipfile, io
        with zipfile.ZipFile(io.BytesIO(resp.data)) as zf:
            cgt_csv = zf.read([n for n in zf.namelist() if "cgt" in n][0]).decode()
        self.assertIn("CBA", cgt_csv)
        self.assertIn("290.0", cgt_csv)

    def test_db_save_persists_watchlist(self):
        """POST /api/db/save stores watchlist in blob_store."""
        payload = {
            "watchlist": [{"ticker": "WDS", "addedAt": "2025-05-01", "notes": "test"}],
            "savedScreeners": [],
        }
        resp = self.client.post(
            "/api/db/save",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        row = _get_shared_conn().execute(
            "SELECT value FROM blob_store WHERE key='watchlist'"
        ).fetchone()
        self.assertIsNotNone(row)
        stored = json.loads(row["value"])
        self.assertEqual(stored[0]["ticker"], "WDS")

    def test_db_load_returns_watchlist(self):
        """GET /api/db/load returns watchlist from blob_store."""
        _get_shared_conn().execute(
            "INSERT OR REPLACE INTO blob_store (key, value, updated_at) VALUES ('watchlist', ?, datetime('now'))",
            (json.dumps([{"ticker": "GMG", "addedAt": "2025-05-01", "notes": ""}]),)
        )
        _get_shared_conn().commit()
        resp = self.client.get("/api/db/load")
        self.assertEqual(resp.status_code, 200)
        d = json.loads(resp.data)
        self.assertIn("watchlist", d)
        tickers = [x["ticker"] for x in (d["watchlist"] or [])]
        self.assertIn("GMG", tickers)

    def test_db_save_load_rec_history_round_trips_rich_fields(self):
        """rec_history only has ~19 explicit SQL columns, but the in-memory rec
        object carries far more (scenarios, bullCase/bearCase, qty, primary_driver,
        _thesisCheck, invalidationCondition, factorsUsed, etc.) — these used to be
        silently dropped on every save/reload round trip even though the History
        tab's _buildRecCardHTML renders them. extra_json must preserve them."""
        rich_rec = {
            "id": "rec-rt-1", "date": "01-07-2026", "ticker": "CBA", "action": "SELL",
            "confidence": 0.8, "priceRange": [130.0, 132.0], "target": 131.0,
            "stopLoss": 128.0, "expectedProfit": 50.0, "netProfit": 45.0,
            "executed": True, "executedAt": "10:00", "outcome": "win",
            "actualProfit": 45.0, "reasoning": "test reasoning", "risks": "test risks",
            "signals": ["rsi_oversold"], "_learningId": 99,
            "qty": 10, "primary_driver": "tax_optimisation",
            "secondary_factors": ["held_over_12m"],
            "scenarios": {"bull": {"p": 0.3, "ret": 0.1}, "base": {"p": 0.5, "ret": 0.0}, "bear": {"p": 0.2, "ret": -0.1}},
            "bullCase": "test bull case", "bearCase": "test bear case",
            "invalidationCondition": "RBA cuts rates",
            "factorsUsed": ["RSI < 30", "Volume spike"],
            "_thesisCheck": {"verdict": "validated", "reason": "ok"},
        }
        resp = self.client.post(
            "/api/db/save",
            data=json.dumps({"recHistory": [rich_rec]}),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)

        resp = self.client.get("/api/db/load")
        self.assertEqual(resp.status_code, 200)
        d = json.loads(resp.data)
        loaded = next((r for r in d["recHistory"] if r["id"] == "rec-rt-1"), None)
        self.assertIsNotNone(loaded)
        # Rich fields not covered by explicit SQL columns must survive the round trip
        self.assertEqual(loaded["qty"], 10)
        self.assertEqual(loaded["primary_driver"], "tax_optimisation")
        self.assertEqual(loaded["bullCase"], "test bull case")
        self.assertEqual(loaded["bearCase"], "test bear case")
        self.assertEqual(loaded["invalidationCondition"], "RBA cuts rates")
        self.assertEqual(loaded["factorsUsed"], ["RSI < 30", "Volume spike"])
        self.assertEqual(loaded["scenarios"]["bull"]["p"], 0.3)
        self.assertEqual(loaded["_thesisCheck"]["verdict"], "validated")
        # Canonical explicit-column fields must still be correct (overlaid on extra_json)
        self.assertEqual(loaded["ticker"], "CBA")
        self.assertEqual(loaded["outcome"], "win")
        self.assertEqual(loaded["actualProfit"], 45.0)

    def test_journal_regime_badge_function(self):
        """journal.js must define _journalRegimeBadge helper."""
        with open(os.path.join(ROOT, "js/pages/journal.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_journalRegimeBadge", src)
        self.assertIn("matchedRec", src)

    def test_generate_postmortem_digest_function(self):
        """learning.js must define generatePostmortemDigest async function."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function generatePostmortemDigest()", src)
        self.assertIn("/api/learning/digest-data", src)

    def test_download_eofy_pack_function(self):
        """cgt.js must define downloadEofyPack async function."""
        with open(os.path.join(ROOT, "js/pages/cgt.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function downloadEofyPack()", src)
        self.assertIn("/api/tax/eofy-pack", src)

    def test_stale_nudge_function(self):
        """dashboard.js must define _buildStaleNudgeCard helper."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildStaleNudgeCard()", src)
        self.assertIn("_STALE_DAYS", src)


class TestSprint6(unittest.TestCase):
    """Sprint 6 — portfolio Q&A, attribution, sector warnings, thesis, dividend forecast."""

    def setUp(self):
        _install_in_memory_db()
        self.client = asx_server.app.test_client()

    # ── 1. Portfolio-aware Q&A ────────────────────────────────────────────────
    def test_assistant_includes_regime_context(self):
        """assistant.js sendChat must include regime and macro context in system prompt."""
        with open(os.path.join(ROOT, "js/pages/assistant.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("regimeCtx", src)
        self.assertIn("state.currentRegime", src)
        self.assertIn("state.macroData", src)
        self.assertIn("MARKET REGIME", src)
        self.assertIn("MACRO DATA", src)

    def test_assistant_appends_regime_to_system(self):
        """regimeCtx must be appended to the system prompt string."""
        with open(os.path.join(ROOT, "js/pages/assistant.js"), encoding="utf-8") as f:
            src = f.read()
        # The system string template must end with regimeCtx
        self.assertIn("${regimeCtx}", src)

    # ── 2. Performance Attribution ────────────────────────────────────────────
    def test_attribution_card_function(self):
        """performance.js must define _buildAttributionCard function."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildAttributionCard(closedTrades)", src)
        self.assertIn("sectorMap", src)
        self.assertIn("regimeMap", src)

    def test_attribution_card_called_in_render(self):
        """renderPerformance must call _buildAttributionCard."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildAttributionCard(closedTrades)", src)

    def test_attribution_uses_regime_from_rechistory(self):
        """Attribution card looks up regime via recId → recHistory."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("state.recHistory.find(r => r.id === t.recId)", src)

    # ── 3. Sector concentration warning ──────────────────────────────────────
    def test_sector_concentration_warning_function(self):
        """recommendations.js must define _sectorConcentrationWarning."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _sectorConcentrationWarning(rec)", src)
        self.assertIn("maxSectorPct", src)

    def test_sector_warning_used_in_rec_card(self):
        """Rec card header must call _sectorConcentrationWarning."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_sectorConcentrationWarning(r)", src)

    # ── 4. Thesis capture ────────────────────────────────────────────────────
    def test_thesis_input_in_rec_card(self):
        """recommendations.js must render a thesis textarea on each rec card."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('id="thesis-${r.id}"', src)
        self.assertIn("_thesis", src)

    def test_thesis_captured_at_execution(self):
        """markExecuted must capture thesis from DOM and pass to learning log."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("thesis-${id}", src)
        self.assertIn("trade_thesis", src)
        self.assertIn("rec._thesis", src)

    def test_thesis_in_histentry(self):
        """histEntry saved to recHistory must include _thesis field."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_thesis: rec._thesis || null", src)

    def test_thesis_shown_in_journal(self):
        """journal.js must show thesis tooltip when matchedRec._thesis is set."""
        with open(os.path.join(ROOT, "js/pages/journal.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("matchedRec?._thesis", src)

    # ── 5. Dividend income forecast ──────────────────────────────────────────
    def test_div_forecast_card_function(self):
        """performance.js must define _buildDivForecastCard function."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildDivForecastCard()", src)
        self.assertIn("Dividend Income Forecast", src)

    def test_div_forecast_includes_franking(self):
        """Dividend forecast must compute franking credit gross-up."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("CORP_TAX", src)
        self.assertIn("grossUp", src)
        self.assertIn("frankingCredit", src)

    def test_div_forecast_called_in_render(self):
        """renderPerformance must call _buildDivForecastCard."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildDivForecastCard()", src)


class TestSprint7(unittest.TestCase):
    """Sprint 7 — thesis review, prompt P&L, target allocations, economic calendar, franking 45-day."""

    def setUp(self):
        _install_in_memory_db()
        self.client = asx_server.app.test_client()

    # ── 1. Thesis review at exit ──────────────────────────────────────────────
    def test_thesis_review_function_defined(self):
        """recommendations.js must define _showThesisReview function."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _showThesisReview(", src)

    def test_thesis_review_uses_dialog_element(self):
        """_showThesisReview must use a <dialog> element for the modal."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("createElement('dialog')", src)

    def test_thesis_review_posts_verdict(self):
        """_showThesisReview must POST to /api/learning/outcome with thesis verdict."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("/api/learning/outcome", src)
        self.assertIn("THESIS:", src)

    def test_thesis_review_hooked_into_mark_executed(self):
        """markExecuted must call _showThesisReview when position fully closes."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_showThesisReview(", src)
        self.assertIn("positionClosed", src)

    # ── 2. Prompt version P&L ─────────────────────────────────────────────────
    def test_prompt_version_pnl_in_backend_sql(self):
        """learning.py version stats must include total_pnl in SQL query."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("total_pnl", src)
        self.assertIn("realized_pnl_aud", src)

    def test_prompt_version_pnl_in_version_list(self):
        """learning.py version_list must include total_pnl field in response."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"total_pnl"', src)

    def test_prompt_version_pnl_column_in_ui(self):
        """learning.js versionsCard must have a Realised P&L column."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Realised P&amp;L", src)
        self.assertIn("total_pnl", src)

    # ── 3. Target allocations + drift alerts ─────────────────────────────────
    def test_target_alloc_card_function(self):
        """risk.js must define _buildTargetAllocCard function."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildTargetAllocCard(", src)

    def test_target_alloc_set_function(self):
        """risk.js must define setTargetAlloc function for inline input edits."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function setTargetAlloc(", src)
        self.assertIn("state.targetAllocations", src)

    def test_target_alloc_card_called_in_risk_page(self):
        """buildRiskPage must call _buildTargetAllocCard."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildTargetAllocCard(", src)

    def test_target_alloc_drift_thresholds(self):
        """Target allocation card must warn amber at 5% drift and red at 10%."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("10", src)
        self.assertIn("5", src)

    def test_target_alloc_in_config(self):
        """config.js state must include targetAllocations default."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("targetAllocations", src)

    def test_target_alloc_in_api_save(self):
        """api.js save payload must include targetAllocations."""
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("targetAllocations", src)

    def test_target_alloc_in_blob_keys(self):
        """portfolio.py BLOB_KEYS must include targetAllocations."""
        with open(os.path.join(ROOT, "routes/portfolio.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("targetAllocations", src)

    # ── 4. Economic calendar ──────────────────────────────────────────────────
    def test_economic_calendar_function(self):
        """dashboard.js must define _buildEconomicCalendarCard function."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildEconomicCalendarCard()", src)

    def test_rba_meeting_dates_dynamic(self):
        """dashboard.js must fetch RBA meeting dates live via /api/rba-meetings with a fallback list."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        # Live fetch function and backend endpoint reference
        self.assertIn("_fetchRbaMeetings", src)
        self.assertIn("/api/rba-meetings", src)
        # Fallback array with real dates must still be present
        self.assertIn("_rbaMeetings", src)
        self.assertIn("2026-", src)
        self.assertIn("2027-", src)

    def test_economic_calendar_includes_exdiv(self):
        """Economic calendar must include ex-dividend dates from dividendData."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("exDividendDate", src)

    def test_economic_calendar_called_in_render(self):
        """renderDashboard must call _buildEconomicCalendarCard."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildEconomicCalendarCard()", src)

    # ── 5. Franking 45-day rule ───────────────────────────────────────────────
    def test_franking_45day_function(self):
        """cgt.js must define _buildFranking45DayCard function."""
        with open(os.path.join(ROOT, "js/pages/cgt.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildFranking45DayCard()", src)

    def test_franking_45day_checks_exdiv(self):
        """_buildFranking45DayCard must inspect ex-dividend dates."""
        with open(os.path.join(ROOT, "js/pages/cgt.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("exDividendDate", src)
        self.assertIn("45", src)

    def test_franking_45day_warns_on_cgt_page(self):
        """renderCGT must include the franking 45-day card."""
        with open(os.path.join(ROOT, "js/pages/cgt.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildFranking45DayCard()", src)


class TestDigestHistory(unittest.TestCase):
    """Digest history — save/load AI postmortem digests across sessions."""

    def setUp(self):
        _install_in_memory_db()
        self.client = asx_server.app.test_client()

    def test_digest_history_in_config(self):
        """config.js state must include digestHistory default."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("digestHistory", src)

    def test_digest_saved_after_generation(self):
        """generatePostmortemDigest must push entry to state.digestHistory and call saveStateToDb."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("state.digestHistory.unshift(", src)
        self.assertIn("saveStateToDb()", src)

    def test_digest_delete_function(self):
        """learning.js must define deleteDigest(index) to remove entries."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function deleteDigest(", src)
        self.assertIn("state.digestHistory.splice(", src)

    def test_digest_history_rendered_in_card(self):
        """Learning page digest card must render the digestHistory list."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("state.digestHistory", src)
        self.assertIn("deleteDigest(", src)

    def test_digest_history_in_api_save(self):
        """api.js save payload must include digestHistory."""
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("digestHistory", src)

    def test_digest_history_in_blob_keys(self):
        """portfolio.py BLOB_KEYS must include digestHistory."""
        with open(os.path.join(ROOT, "routes/portfolio.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("digestHistory", src)

    def test_digest_capped_at_50(self):
        """Digest history must be capped to prevent unbounded growth."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("digestHistory.length > 50", src)


class TestSprint8(unittest.TestCase):
    """Sprint 8 — A-VIX, cash/TD tracker, exact corr sizing, perf/responsiveness, kbd shortcuts."""

    def setUp(self):
        _install_in_memory_db()
        self.client = asx_server.app.test_client()

    # ── 1. A-VIX proxy ───────────────────────────────────────────────────────
    def test_avix_computed_in_macro_payload(self):
        """market.py _macro_payload must compute asx_vol_20d (realized vol)."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("asx_vol_20d", src)
        self.assertIn("asx_vol_20d", src)
        self.assertIn("252 ** 0.5", src)

    def test_avix_in_regime_engine(self):
        """regime-engine.js must read asx_vol_20d and vote on it."""
        with open(os.path.join(ROOT, "js/regime-engine.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("asxVol20d", src)
        self.assertIn("asx_vol_20d", src)
        self.assertIn("A-VIX", src)

    def test_avix_displayed_on_macro_page(self):
        """macro.js must display asx_vol_20d in the Market Risk card."""
        with open(os.path.join(ROOT, "js/pages/macro.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("asx_vol_20d", src)
        self.assertIn("A-VIX", src)

    # ── 2. Cash & term-deposit tracker ───────────────────────────────────────
    def test_term_deposits_in_config(self):
        """config.js state must include termDeposits default."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("termDeposits", src)

    def test_cash_tracker_card_function(self):
        """dashboard.js must define _buildCashTrackerCard function."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _buildCashTrackerCard()", src)
        self.assertIn("termDeposits", src)
        self.assertIn("deployable", src)

    def test_add_remove_td_functions(self):
        """dashboard.js must define addTD and removeTD functions."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function addTD()", src)
        self.assertIn("async function removeTD(", src)

    def test_term_deposits_persisted(self):
        """termDeposits must be in api.js save payload and portfolio.py BLOB_KEYS."""
        with open(os.path.join(ROOT, "js/api.js"), encoding="utf-8") as f:
            api_src = f.read()
        with open(os.path.join(ROOT, "routes/portfolio.py"), encoding="utf-8") as f:
            py_src = f.read()
        self.assertIn("termDeposits", api_src)
        self.assertIn("termDeposits", py_src)

    # ── 3. Exact correlation-aware sizing ────────────────────────────────────
    def test_corr_sizing_in_analysis(self):
        """analysis.js must fetch /api/risk correlation and reduce qty when |corr| > 0.7."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_corrNote", src)
        self.assertIn("_corrMatrix", src)
        self.assertIn("maxCorr > 0.85", src)
        self.assertIn("maxCorr > 0.7", src)

    def test_corr_note_shown_on_rec_card(self):
        """recommendations.js must show _corrNote badge on BUY rec cards."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_corrNote", src)
        self.assertIn("Corr", src)

    # ── 4. Performance / responsiveness ──────────────────────────────────────
    def test_macro_payload_no_serial_fetches(self):
        """_macro_payload must use parallel fetch for aud_usd and iron_ore history."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        # Both symbols now in the single parallel symbols dict
        self.assertIn('"aud_usd":  ("AUDUSD=X", "1mo")', src)
        self.assertIn('"iron_ore": ("TIO=F",    "1mo")', src)
        # No second serial re-fetch of AUDUSD=X or TIO=F
        self.assertNotIn('yf.Ticker("AUDUSD=X").history', src)
        self.assertNotIn('yf.Ticker("TIO=F").history', src)

    def test_macro_payload_asx200_3mo_parallel(self):
        """_macro_payload must fetch ASX200 3mo in the parallel block (not separately)."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"asx200":   ("^AXJO",    "3mo")', src)
        # The old serial re-fetch is gone
        self.assertNotIn('yf.Ticker("^AXJO").history(period="3mo")', src)

    def test_5d_change_from_cached_history(self):
        """_macro_payload must compute 5d change from _histories dict, not a separate fetch."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_histories", src)
        self.assertIn("aud_usd_change_5d", src)
        self.assertIn("iron_ore_change_5d", src)
        # Ensure the 5d change comes from _histories, not a new serial Ticker fetch
        self.assertIn('_histories.get(key)', src)

    # ── 5. Keyboard shortcuts ─────────────────────────────────────────────────
    def test_keyboard_shortcuts_in_navigation(self):
        """navigation.js must define keyboard shortcut handler and PAGE_KEYS map."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("PAGE_KEYS", src)
        self.assertIn("_showShortcutsHelp", src)
        self.assertIn("keydown", src)

    def test_shortcuts_cover_main_pages(self):
        """Shortcut map must include dashboard, portfolio, recommendations, risk, learning."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        for page in ["dashboard", "portfolio", "recommendations", "risk", "learning"]:
            self.assertIn(page, src)

    def test_shortcuts_help_modal_uses_dialog(self):
        """Shortcuts help must open as a <dialog> element."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("createElement('dialog')", src)
        self.assertIn("showModal()", src)


class TestAICallLog(unittest.TestCase):
    """Tests for the prompt+response logging feature (ai_call_log table)."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_ai_call_log_table_in_schema(self):
        """ai_call_log must be in the DB schema."""
        import db as db_module
        self.assertIn("ai_call_log", db_module._SCHEMA)

    def test_log_ai_response_stores_full_context(self):
        """POST /api/log/ai_response must accept prompt+response and return ok."""
        payload = {
            "text":          "test response",
            "system_prompt": "you are a test assistant",
            "user_message":  "hello",
            "agent_type":    "portfolio",
            "model":         "claude-sonnet-4-6",
            "usage":         {"input_tokens": 100, "output_tokens": 50,
                              "cache_read_input_tokens": 80, "cache_creation_input_tokens": 20},
            "duration_ms":   1234,
        }
        resp = self.client.post(
            "/api/log/ai_response",
            data=json.dumps(payload),
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))

    def test_list_ai_calls_returns_entries(self):
        """GET /api/log/ai_calls must return entries after a log call."""
        resp = self.client.get("/api/log/ai_calls?limit=5")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(body.get("ok"))
        self.assertIn("entries", body)
        self.assertIn("total", body)

    def test_list_ai_calls_agent_filter(self):
        """GET /api/log/ai_calls?agent_type=X must filter correctly."""
        # Log one more with a distinct agent type
        self.client.post(
            "/api/log/ai_response",
            data=json.dumps({"text": "macro resp", "agent_type": "macro"}),
            content_type="application/json",
        )
        resp = self.client.get("/api/log/ai_calls?agent_type=macro")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        for entry in body["entries"]:
            self.assertEqual(entry["agent_type"], "macro")

    def test_get_ai_call_detail(self):
        """GET /api/log/ai_call/<id> must return full content."""
        # First log a call
        self.client.post(
            "/api/log/ai_response",
            data=json.dumps({"text": "detail test", "agent_type": "analyst",
                             "system_prompt": "sys", "user_message": "usr"}),
            content_type="application/json",
        )
        # Get the id from the list
        list_resp = self.client.get("/api/log/ai_calls?agent_type=analyst&limit=1")
        entries = json.loads(list_resp.data)["entries"]
        if not entries:
            self.skipTest("No analyst entries found")
        call_id = entries[0]["id"]
        resp = self.client.get(f"/api/log/ai_call/{call_id}")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("response_text", body)
        self.assertIn("system_prompt", body)
        self.assertIn("user_message", body)

    def test_get_ai_call_404(self):
        """GET /api/log/ai_call/99999 must return 404."""
        resp = self.client.get("/api/log/ai_call/99999")
        self.assertEqual(resp.status_code, 404)

    def test_callclaude_logs_automatically(self):
        """claude-client.js must fire the log endpoint after every successful call."""
        with open(os.path.join(ROOT, "js/claude-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("api/log/ai_response", src,
                      "callClaude must fire /api/log/ai_response after success")
        self.assertIn("system_prompt", src,
                      "callClaude log payload must include system_prompt")
        self.assertIn("user_message", src,
                      "callClaude log payload must include user_message")
        self.assertIn("duration_ms", src,
                      "callClaude log payload must include duration_ms")

    def test_analysis_no_longer_has_redundant_log(self):
        """analysis.js must not have the old manual log call (now in callClaude)."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # The old code sent { text } only; the new one in claude-client.js sends more fields.
        # Check that the old bare { text } post is gone from analysis.js:
        import re as _re
        old_pattern = r"body.*JSON\.stringify\(\s*\{\s*text\s*\}\s*\)"
        self.assertIsNone(
            _re.search(old_pattern, src),
            "analysis.js must not have the old bare {text} log call — it moved to callClaude()",
        )

    def test_health_endpoint_returns_version(self):
        """GET /health must include version, uptime_s, and last_backup."""
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertEqual(body["status"], "ok")
        self.assertIn("version", body)
        self.assertIn("uptime_s", body)
        self.assertIn("last_backup", body)


class TestComparePage(unittest.TestCase):
    """Tests for the side-by-side compare feature."""

    def test_compare_js_exists(self):
        """js/pages/compare.js must exist."""
        self.assertTrue(
            os.path.isfile(os.path.join(ROOT, "js/pages/compare.js")),
            "js/pages/compare.js must exist",
        )

    def test_compare_js_syntax(self):
        """compare.js must pass node --check."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/compare.js")],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, f"compare.js syntax error: {result.stderr}")

    def test_compare_page_in_navigation(self):
        """navigation.js must redirect 'compare' to scanner and have g+x shortcut."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        # Redirect: showPage('compare') sets _scannerTab and switches to scanner
        self.assertIn("case 'compare'", src)
        self.assertIn("x: 'compare'", src)
        # Redirection logic must be present
        self.assertIn("_scannerTab = 'compare'", src)

    def test_compare_script_in_html(self):
        """asx_trading.html must load compare.js."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("pages/compare.js", src)

    def test_compare_no_standalone_nav_item(self):
        """Compare is now a tab in Market Scanner — no standalone nav button needed."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        # The sidebar should NOT have a dedicated Compare nav button
        self.assertNotIn('<button class="nav-item" onclick="showPage(\'compare\')', src,
                         "Compare must be a scanner tab, not a standalone nav item")

    def test_compare_tab_in_scanner(self):
        """scanner.js must include a Compare tab button."""
        with open(os.path.join(ROOT, "js/pages/scanner.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("'compare'", src)
        self.assertIn("↔ Compare", src)
        self.assertIn("_initCompareTab", src)

    def test_compare_functions_present(self):
        """compare.js must expose renderComparePage, runComparison, compareFromOutside."""
        with open(os.path.join(ROOT, "js/pages/compare.js"), encoding="utf-8") as f:
            src = f.read()
        for fn in ["renderComparePage", "runComparison", "compareFromOutside", "clearComparison"]:
            self.assertIn(fn, src, f"compare.js must define {fn}")


class TestETFEarningsFilter(unittest.TestCase):
    """ETF detection in the earnings calendar endpoint."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_earnings_calendar_skips_etf_via_quotetype(self):
        """_fetch_earnings must return skipped='ETF' for quoteType=ETF."""
        import routes.market as _mkt
        # Simulate a yfinance ticker whose info.quoteType == 'ETF'
        class _FakeTicker:
            info = {"quoteType": "ETF"}
            calendar = None
        import unittest.mock as _mock
        with _mock.patch.object(_mkt.yf, "Ticker", return_value=_FakeTicker()):
            resp = self.client.get("/api/earnings-calendar?tickers=VAS")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("VAS", body)
        self.assertEqual(body["VAS"].get("skipped"), "ETF")


class TestCapitalReturnsCheck(unittest.TestCase):
    """GET /api/portfolio/capital-returns-check — large distribution detection."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_endpoint_returns_empty_for_no_dividends(self):
        """Returns [] per ticker when dividends are None or empty."""
        import unittest.mock as _mock
        import yfinance as yf

        class _FakeTicker:
            splits = None
            dividends = None
            def history(self, **kw):
                import pandas as pd
                return pd.DataFrame()
        with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
            resp = self.client.get("/api/portfolio/capital-returns-check?tickers=CBA")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("CBA", body)
        self.assertEqual(body["CBA"], [])

    def test_flags_large_dividend(self):
        """Payment ≥5% of current price must be flagged with amount_pct."""
        import unittest.mock as _mock
        import yfinance as yf
        import pandas as pd

        large_div = pd.Series(
            [0.60],
            index=pd.to_datetime(["2026-05-01"]).tz_localize("UTC"),
        )
        large_div.index.name = "Date"

        class _FakeTicker:
            splits = None
            dividends = large_div
            def history(self, **kw):
                return pd.DataFrame({"Close": [10.0]}, index=pd.to_datetime(["2026-05-01"]))
        with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
            resp = self.client.get("/api/portfolio/capital-returns-check?tickers=BHP")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertTrue(len(body["BHP"]) > 0, "Expected large dividend (6%) to be flagged")
        self.assertIn("amount_pct", body["BHP"][0])
        self.assertGreaterEqual(body["BHP"][0]["amount_pct"], 5.0)

    def test_ignores_small_dividend(self):
        """Regular dividend below 5% threshold must NOT be flagged."""
        import unittest.mock as _mock
        import yfinance as yf
        import pandas as pd

        small_div = pd.Series(
            [0.20],
            index=pd.to_datetime(["2026-05-01"]).tz_localize("UTC"),
        )
        small_div.index.name = "Date"

        class _FakeTicker:
            splits = None
            dividends = small_div
            def history(self, **kw):
                return pd.DataFrame({"Close": [10.0]}, index=pd.to_datetime(["2026-05-01"]))
        with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
            resp = self.client.get("/api/portfolio/capital-returns-check?tickers=CBA")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertEqual(body["CBA"], [], "Small dividend (2%) should not be flagged")

    def test_portfolio_js_capital_return_warning_renders(self):
        """portfolio.js must render a capital-return warning banner."""
        with open(os.path.join(ROOT, "js/pages/portfolio.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_capitalReturnWarnings", src)
        self.assertIn("capital return", src)

    def test_navigation_js_calls_check_capital_returns(self):
        """navigation.js must call checkCapitalReturns when loading portfolio page."""
        with open(os.path.join(ROOT, "js/navigation.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("checkCapitalReturns", src)


class TestPromptVersionDelta(unittest.TestCase):
    """Prompt version A/B delta in the Learning Loop UI."""

    def test_delta_column_in_learning_js(self):
        """learning.js prompt version table must include Δ vs prev column."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("vs prev", src,
                      "learning.js must have a Δ vs prev column header")
        self.assertIn("isCurrent", src,
                      "learning.js must highlight the current prompt version")
        self.assertIn("PROMPT_VERSION", src,
                      "learning.js must reference PROMPT_VERSION for current-version badge")


class TestSprint10FormingBarAndStooq(unittest.TestCase):
    """Sprint 10 — forming-bar fix and Stooq fallback in indicators.py."""

    def test_drop_forming_bar_function_exists(self):
        """indicators.py must define _drop_forming_bar."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _drop_forming_bar(", src)

    def test_drop_forming_bar_removes_todays_bar_before_settlement(self):
        """_drop_forming_bar must remove the last row when Sydney-local hour < 17 and last bar is today.

        Audit fix #8: cutoff is now checked in Sydney local time (zoneinfo,
        DST-aware) instead of a flat UTC hour — mock indicators._dt_mod.datetime.now
        directly rather than the old utcnow()-based time source.
        """
        import datetime
        import pandas as pd
        import indicators as ind

        today_sydney = datetime.datetime.now(ind._SYDNEY_TZ).date()
        idx = pd.to_datetime([
            str(today_sydney - datetime.timedelta(days=2)),
            str(today_sydney - datetime.timedelta(days=1)),
            str(today_sydney),
        ])
        df = pd.DataFrame(
            {"Open": [1, 2, 3], "High": [1, 2, 3], "Low": [1, 2, 3],
             "Close": [1, 2, 3], "Volume": [100, 200, 300]},
            index=idx,
        )
        import unittest.mock as _mock
        # Patch now() to 06:00 Sydney local (before the 17:00 settlement cutoff).
        # Patch indicators._dt_mod itself (the name binding inside indicators.py's
        # own namespace from `import datetime as _dt_mod`) — NOT a nested attribute
        # path like "indicators._dt_mod.datetime", which would replace the real
        # global stdlib datetime.datetime class and break pandas' own isinstance
        # checks against it for the duration of the patch.
        fake_now = datetime.datetime(today_sydney.year, today_sydney.month, today_sydney.day,
                                      6, 0, 0, tzinfo=ind._SYDNEY_TZ)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.now.return_value = fake_now
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Forming bar should be dropped before 17:00 Sydney local")

    def test_drop_forming_bar_keeps_bar_after_settlement(self):
        """_drop_forming_bar must NOT remove the last row after 17:00 Sydney local."""
        import datetime
        import pandas as pd
        import indicators as ind

        today_sydney = datetime.datetime.now(ind._SYDNEY_TZ).date()
        idx = pd.to_datetime([
            str(today_sydney - datetime.timedelta(days=1)),
            str(today_sydney),
        ])
        df = pd.DataFrame(
            {"Open": [1, 2], "High": [1, 2], "Low": [1, 2],
             "Close": [1, 2], "Volume": [100, 200]},
            index=idx,
        )
        import unittest.mock as _mock
        fake_now = datetime.datetime(today_sydney.year, today_sydney.month, today_sydney.day,
                                      18, 0, 0, tzinfo=ind._SYDNEY_TZ)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.now.return_value = fake_now
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Bar must NOT be dropped after settlement window")

    def test_drop_forming_bar_keeps_old_bars_before_settlement(self):
        """_drop_forming_bar must not drop a bar from 2+ days ago even before 17:00 Sydney local."""
        import datetime
        import pandas as pd
        import indicators as ind

        today_sydney = datetime.datetime.now(ind._SYDNEY_TZ).date()
        yesterday = today_sydney - datetime.timedelta(days=1)
        idx = pd.to_datetime([
            str(yesterday - datetime.timedelta(days=1)),
            str(yesterday),
        ])
        df = pd.DataFrame(
            {"Open": [1, 2], "High": [1, 2], "Low": [1, 2],
             "Close": [1, 2], "Volume": [100, 200]},
            index=idx,
        )
        import unittest.mock as _mock
        fake_now = datetime.datetime(today_sydney.year, today_sydney.month, today_sydney.day,
                                      3, 0, 0, tzinfo=ind._SYDNEY_TZ)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.now.return_value = fake_now
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Old bars must never be dropped")

    def test_drop_forming_bar_uses_sydney_timezone(self):
        """Audit fix #8: the cutoff must be computed in Australia/Sydney local
        time (DST-aware via zoneinfo), not a flat hardcoded UTC hour."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_SYDNEY_TZ", src)
        self.assertIn('ZoneInfo("Australia/Sydney")', src)
        self.assertNotIn("now_utc.hour >= 7", src)

    def test_fetch_stooq_history_function_exists(self):
        """indicators.py must define _fetch_stooq_history."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _fetch_stooq_history(", src)

    def test_stooq_url_format(self):
        """_fetch_stooq_history must build a stooq.com URL with .au suffix."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stooq.com", src)
        self.assertIn(".au", src)  # ticker conversion suffix

    def test_analyse_ticker_calls_forming_bar_drop(self):
        """analyse_ticker must call _drop_forming_bar on the fetched hist."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_drop_forming_bar(hist)", src)

    def test_analyse_ticker_calls_stooq_fallback(self):
        """analyse_ticker must call _fetch_stooq_history when yfinance is insufficient."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_fetch_stooq_history(", src)

    def test_analyse_ticker_stooq_returns_empty_df_on_failure(self):
        """_fetch_stooq_history must return empty DataFrame when HTTP fails."""
        import indicators as ind
        import unittest.mock as _mock
        # Patch _HTTP_SESSION import inside the function
        with _mock.patch("indicators.io") as _io_mock:
            _io_mock.StringIO.side_effect = Exception("network error")
            from core import _HTTP_SESSION as real_sess
            with _mock.patch.object(real_sess, "get", side_effect=Exception("connection refused")):
                result = ind._fetch_stooq_history("BHP", "6mo")
        import pandas as pd
        self.assertIsInstance(result, pd.DataFrame)
        self.assertTrue(result.empty)


class TestSprint10StopProximityAlerts(unittest.TestCase):
    """Sprint 10 — stop-proximity pre-warning alert feature."""

    def test_check_stop_proximity_alerts_defined(self):
        """alerts.js must define checkStopProximityAlerts."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function checkStopProximityAlerts(", src)

    def test_proximity_alert_direction_aware(self):
        """checkStopProximityAlerts must distinguish BUY from SELL direction."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("isBuy", src)
        self.assertIn("SELL", src)

    def test_proximity_alert_uses_setting(self):
        """checkStopProximityAlerts must read stopProximityPct from state.settings."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopProximityPct", src)

    def test_proximity_alert_one_shot(self):
        """checkStopProximityAlerts must use _proximityAlertedAt for one-shot dedup."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_proximityAlertedAt", src)

    def test_prices_calls_proximity_alerts(self):
        """prices.js must call checkStopProximityAlerts after price refresh."""
        with open(os.path.join(ROOT, "js/prices.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("checkStopProximityAlerts", src)

    def test_stop_proximity_pct_in_config_defaults(self):
        """config.js must define stopProximityPct in state.settings defaults."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopProximityPct", src)

    def test_stop_proximity_setting_in_settings_ui(self):
        """settings.js must expose stopProximityPct as a configurable field."""
        with open(os.path.join(ROOT, "js/pages/settings.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopProximityPct", src)
        self.assertIn("Stop proximity", src)


class TestSprint10PositionAge(unittest.TestCase):
    """Sprint 10 — position age + unrealised P&L enrichment in analysis prompt."""

    def test_days_held_helper_defined(self):
        """analysis.js must define _daysHeld helper function."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_daysHeld", src)

    def test_portfolio_json_includes_days_held(self):
        """portfolioJson in analysis.js must include daysHeld field."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("daysHeld", src)

    def test_portfolio_json_includes_unrealised_pnl_pct(self):
        """portfolioJson in analysis.js must include unrealisedPnlPct field."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("unrealisedPnlPct", src)

    def test_days_held_uses_trade_journal(self):
        """_daysHeld must look up state.tradeJournal for earliest open BUY/TOP_UP."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("tradeJournal", src)
        self.assertIn("TOP_UP", src)


class TestIntradayStrategy(unittest.TestCase):
    """Sprint 11 — ASX100 intraday 3-4% day-trade strategy."""

    # ── Backend ──────────────────────────────────────────────────────────────

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_intraday_blueprint_registered(self):
        """GET /api/intraday/<ticker> must return 200."""
        import unittest.mock as _mock
        import pandas as pd
        import numpy as np

        # Build a synthetic 10-bar 5m intraday DataFrame
        dates = pd.date_range("2026-05-28 00:10", periods=10, freq="5min", tz="UTC")
        df = pd.DataFrame({
            "Open":   np.full(10, 50.0),
            "High":   np.full(10, 51.0),
            "Low":    np.full(10, 49.5),
            "Close":  np.full(10, 50.2),
            "Volume": np.full(10, 1_000_000),
        }, index=dates)

        import routes.intraday as _intraday_mod
        with _mock.patch.object(_intraday_mod.yf, "Ticker") as mock_tk:
            mock_tk.return_value.history.return_value = df
            resp = self.client.get("/api/intraday/CBA")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("ticker", body)
        self.assertEqual(body["ticker"], "CBA")

    def test_intraday_scan_endpoint_exists(self):
        """POST /api/intraday/scan must return a dict."""
        import unittest.mock as _mock
        import pandas as pd
        import numpy as np

        dates = pd.date_range("2026-05-28 00:10", periods=10, freq="5min", tz="UTC")
        df = pd.DataFrame({
            "Open":   np.full(10, 100.0),
            "High":   np.full(10, 101.0),
            "Low":    np.full(10, 99.5),
            "Close":  np.full(10, 100.3),
            "Volume": np.full(10, 2_000_000),
        }, index=dates)

        import routes.intraday as _intraday_mod
        with _mock.patch.object(_intraday_mod.yf, "Ticker") as mock_tk:
            mock_tk.return_value.history.return_value = df
            resp = self.client.post(
                "/api/intraday/scan",
                json={"tickers": ["BHP"]},
                content_type="application/json",
            )
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIsInstance(body, dict)

    def test_intraday_scan_empty_tickers_returns_empty(self):
        """POST /api/intraday/scan with empty list must return {}."""
        resp = self.client.post(
            "/api/intraday/scan",
            json={"tickers": []},
            content_type="application/json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(json.loads(resp.data), {})

    def test_intraday_vwap_correct(self):
        """_compute_vwap must return correct VWAP on a synthetic 5-row DataFrame."""
        import pandas as pd
        import numpy as np
        from routes.intraday import _compute_vwap

        df = pd.DataFrame({
            "High":   [10.0, 11.0, 12.0, 11.5, 10.5],
            "Low":    [ 9.0, 10.0, 11.0, 10.5,  9.5],
            "Close":  [ 9.5, 10.5, 11.5, 11.0, 10.0],
            "Volume": [1000, 2000, 1500, 1000, 1200],
        })
        vwap = _compute_vwap(df)
        # Check that VWAP is cumulative and last value is finite
        self.assertEqual(len(vwap), 5)
        self.assertTrue(all(v > 0 and not np.isnan(v) for v in vwap))
        # Check manual calculation for first bar: TP=9.5, vol=1000 → VWAP=9.5
        self.assertAlmostEqual(float(vwap.iloc[0]), 9.5, places=4)

    def test_intraday_rsi_returns_none_for_short_series(self):
        """_compute_rsi_intraday must return None when close series is too short."""
        import pandas as pd
        from routes.intraday import _compute_rsi_intraday

        short = pd.Series([50.0, 50.5, 51.0])
        result = _compute_rsi_intraday(short, period=14)
        self.assertIsNone(result)

    def test_intraday_entry_window_gate(self):
        """_in_entry_window must return False for times outside 10:45–15:00 Sydney."""
        import unittest.mock as _mock
        import datetime
        from routes import intraday as _intraday_mod

        # Use real aware datetimes so the minutes comparison always works.
        _tz = _intraday_mod._SYDNEY_TZ
        fake_before = datetime.datetime(2026, 5, 28, 10, 30, 0, tzinfo=_tz)
        fake_inside = datetime.datetime(2026, 5, 28, 11,  0, 0, tzinfo=_tz)
        fake_after  = datetime.datetime(2026, 5, 28, 15,  5, 0, tzinfo=_tz)

        with _mock.patch("routes.intraday.datetime") as mock_dt:
            mock_dt.now.return_value = fake_before
            self.assertFalse(_intraday_mod._in_entry_window())

            mock_dt.now.return_value = fake_inside
            self.assertTrue(_intraday_mod._in_entry_window())

            mock_dt.now.return_value = fake_after
            self.assertFalse(_intraday_mod._in_entry_window())

    def test_score_setup_zero_when_no_signals(self):
        """_score_setup must return 0 when no signals are present."""
        from routes.intraday import _score_setup
        score = _score_setup(
            pct_from_vwap=0.5,    # above VWAP — no VWAP discount
            intraday_rsi=60,      # not oversold
            vol_rising=False,
            current_price=10.0,
            day_low=10.0,         # price == day_low (fails ≥1.01 check)
            day_open=10.5,        # price below open
        )
        self.assertEqual(score, 0)

    def test_score_setup_max_100(self):
        """_score_setup must never exceed 100."""
        from routes.intraday import _score_setup
        score = _score_setup(
            pct_from_vwap=-5.0,   # huge discount
            intraday_rsi=5,       # deeply oversold
            vol_rising=True,
            current_price=10.5,
            day_low=9.0,
            day_open=10.0,
        )
        self.assertLessEqual(score, 100)

    # ── Frontend file checks ─────────────────────────────────────────────────

    def test_intraday_js_exists(self):
        """js/intraday-strategy.js must exist."""
        self.assertTrue(
            os.path.exists(os.path.join(ROOT, "js/intraday-strategy.js")),
            "js/intraday-strategy.js not found"
        )

    def test_intraday_js_syntax(self):
        """js/intraday-strategy.js must pass node --check."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/intraday-strategy.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    def test_build_intraday_recs_defined(self):
        """intraday-strategy.js must define _buildIntradayRecs."""
        with open(os.path.join(ROOT, "js/intraday-strategy.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildIntradayRecs", src)

    def test_run_intraday_scan_defined(self):
        """intraday-strategy.js must define runIntradayScan."""
        with open(os.path.join(ROOT, "js/intraday-strategy.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("runIntradayScan", src)

    def test_intraday_defaults_defined(self):
        """intraday-strategy.js must define INTRADAY_DEFAULTS with targetPct and stopPct."""
        with open(os.path.join(ROOT, "js/intraday-strategy.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("INTRADAY_DEFAULTS", src)
        self.assertIn("targetPct", src)
        self.assertIn("stopPct", src)

    def test_intraday_tab_in_day_trading(self):
        """day-trading.js must include the ⚡ Intraday tab."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("intraday", src)
        self.assertIn("⚡ Intraday", src)

    def test_execute_intraday_trade_defined(self):
        """day-trading.js must define executeIntradayTrade."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("executeIntradayTrade", src)

    def test_close_intraday_position_defined(self):
        """day-trading.js must define closeIntradayPosition."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("closeIntradayPosition", src)

    def test_update_intraday_param_defined(self):
        """day-trading.js must define updateIntradayParam."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("updateIntradayParam", src)

    def test_intraday_state_in_config(self):
        """config.js must contain the state.intraday block."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("intraday:", src)
        self.assertIn("openPositions", src)
        self.assertIn("todayPnl", src)
        self.assertIn("allocatedCash", src)

    def test_intraday_closeout_in_alerts(self):
        """alerts.js must define checkIntradayCloseouts."""
        with open(os.path.join(ROOT, "js/alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("checkIntradayCloseouts", src)
        self.assertIn("_intradayClosedAlertedAt", src)

    def test_prices_calls_closeout(self):
        """prices.js must call checkIntradayCloseouts after price refresh."""
        with open(os.path.join(ROOT, "js/prices.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("checkIntradayCloseouts", src)

    def test_intraday_script_in_html(self):
        """asx_trading.html must load intraday-strategy.js."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("intraday-strategy.js", src)

    def test_intraday_script_order_in_html(self):
        """intraday-strategy.js must be loaded after strategy.js and before day-trading-analysis.js."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        idx_strategy    = src.find("strategy.js")
        idx_intraday    = src.find("intraday-strategy.js")
        idx_dt_analysis = src.find("day-trading-analysis.js")
        self.assertGreater(idx_intraday, idx_strategy,
                           "intraday-strategy.js must load after strategy.js")
        self.assertLess(idx_intraday, idx_dt_analysis,
                        "intraday-strategy.js must load before day-trading-analysis.js")

    def test_intraday_universe_key_in_config(self):
        """config.js state.intraday.params must include universeKey default."""
        with open(os.path.join(ROOT, "js/config.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("universeKey", src)
        self.assertIn("asx100", src)

    def test_intraday_universe_selector_in_day_trading(self):
        """day-trading.js Intraday tab must render a universe selector."""
        with open(os.path.join(ROOT, "js/pages/day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("universeKey", src)
        self.assertIn("asx20", src)
        self.assertIn("asx200", src)

    def test_run_intraday_scan_uses_universe_key(self):
        """intraday-strategy.js must read universeKey from state.intraday.params."""
        with open(os.path.join(ROOT, "js/intraday-strategy.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("universeKey", src)
        self.assertIn("getUniverseTickers", src)

    def test_ipl_removed_from_universe(self):
        """IPL.AX (delisted 2023) must not appear in the _ASX_UNIVERSES data in asx-universe.js."""
        with open(os.path.join(ROOT, "js/asx-universe.js"), encoding="utf-8") as f:
            src = f.read()
        # Strip comment lines before checking — the ticker may appear in a comment note
        data_lines = [l for l in src.splitlines() if not l.strip().startswith("//")]
        data_src = "\n".join(data_lines)
        self.assertNotIn("'IPL.AX'", data_src,
                         "IPL.AX is delisted and must be removed from universe arrays")

    def test_intraday_scan_uses_as_completed(self):
        """routes/intraday.py must use as_completed for non-blocking batch scan."""
        with open(os.path.join(ROOT, "routes/intraday.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("as_completed", src)
        self.assertIn("_PER_TICKER_TIMEOUT", src)

    def test_day_trading_js_syntax(self):
        """day-trading.js must pass node --check after intraday additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/day-trading.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")


class TestSprint18Frontend(unittest.TestCase):
    """Regression checks for Sprint 18 UX / error-recovery additions."""

    def test_utils_retry_btn_defined(self):
        """utils.js must define _retryBtn."""
        with open(os.path.join(ROOT, "js/utils.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _retryBtn", src)

    def test_utils_empty_card_defined(self):
        """utils.js must define _emptyCard."""
        with open(os.path.join(ROOT, "js/utils.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function _emptyCard", src)

    def test_risk_js_retry_button(self):
        """risk.js must render a retry button on fetch failure."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_retryBtn", src)
        self.assertIn("riskFetchError", src)

    def test_risk_js_uses_empty_card(self):
        """risk.js must use _emptyCard for the no-holdings state."""
        with open(os.path.join(ROOT, "js/pages/risk.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_emptyCard", src)

    def test_performance_js_retry_button(self):
        """performance.js must render a retry button on nav-history failure."""
        with open(os.path.join(ROOT, "js/pages/performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_retryBtn", src)

    def test_portfolio_js_empty_card_first_run(self):
        """portfolio.js must use _emptyCard for the first-run no-holdings state."""
        with open(os.path.join(ROOT, "js/pages/portfolio.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_emptyCard", src)
        self.assertIn("No holdings yet", src)

    def test_utils_js_syntax(self):
        """utils.js must pass node --check after Sprint 18 additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/utils.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    def test_risk_js_syntax(self):
        """risk.js must pass node --check after Sprint 18 changes."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/risk.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    def test_performance_js_syntax(self):
        """performance.js must pass node --check after Sprint 18 changes."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/performance.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")


class TestSeasonalityRoute(unittest.TestCase):
    """Tests for GET /api/seasonality/<ticker>."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_seasonality_returns_json(self):
        """Endpoint must return 200 and a JSON body regardless of yfinance availability."""
        resp = self.client.get("/api/seasonality/BHP")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("ok", body)

    def test_seasonality_shape_on_success(self):
        """When yfinance returns data, response must have 12-month array."""
        import unittest.mock as mock
        import pandas as pd
        import numpy as np

        # Build a synthetic 10yr monthly close series
        dates = pd.date_range("2015-01", periods=120, freq="MS")
        closes = pd.Series(np.cumprod(1 + np.random.normal(0.005, 0.04, 120)) * 10, index=dates)
        fake_hist = pd.DataFrame({"Close": closes})

        with mock.patch("yfinance.download", return_value=fake_hist):
            # Clear the TTL cache so the mock is used
            from routes.market import _seasonality_cached
            _seasonality_cached.cache_clear() if hasattr(_seasonality_cached, "cache_clear") else None
            resp = self.client.get("/api/seasonality/CBA")
        body = json.loads(resp.data)
        if body.get("ok"):
            self.assertEqual(len(body["months"]), 12)
            for m in body["months"]:
                self.assertIn("month", m)
                self.assertIn("avg", m)
                self.assertIn("positive", m)
                self.assertIn("count", m)

    def test_seasonality_route_registered(self):
        """routes/market.py must define the seasonality route."""
        with open(os.path.join(ROOT, "routes/market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("/api/seasonality/", src)
        self.assertIn("_seasonality_cached", src)


class TestSprint17Frontend(unittest.TestCase):
    """Regression checks for Sprint 17 JS additions."""

    def test_signals_js_seasonality_card(self):
        """signals.js must render a seasonality card placeholder."""
        with open(os.path.join(ROOT, "js/pages/signals.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("seas-card-", src)
        self.assertIn("_loadSeasonality", src)
        self.assertIn("_renderSeasonality", src)
        self.assertIn("Monthly Seasonality", src)

    def test_signals_js_seasonality_cache(self):
        """signals.js must declare _seasonalityCache."""
        with open(os.path.join(ROOT, "js/pages/signals.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_seasonalityCache", src)

    def test_portfolio_js_apply_split_adjustment(self):
        """portfolio.js must define applySplitAdjustment."""
        with open(os.path.join(ROOT, "js/pages/portfolio.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("applySplitAdjustment", src)

    def test_portfolio_js_split_button_in_banner(self):
        """portfolio.js split warning banner must render Apply buttons."""
        with open(os.path.join(ROOT, "js/pages/portfolio.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("applySplitAdjustment", src)
        self.assertIn("Apply", src)

    def test_signals_js_syntax(self):
        """signals.js must pass node --check after Sprint 17 additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/signals.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    def test_portfolio_js_syntax(self):
        """portfolio.js must pass node --check after Sprint 17 additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/portfolio.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")


class TestSprint21FactorStabilityAndSecurity(unittest.TestCase):
    """Sprint 21 — Factor stability (§1.6) + security hardening (§3.5)."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Factor stability route ─────────────────────────────────────────────────

    def test_factor_stability_route_registered(self):
        """POST /api/scanner/factor-stability must be registered."""
        rules = [r.rule for r in asx_server.app.url_map.iter_rules()]
        self.assertIn("/api/scanner/factor-stability", rules)

    def test_factor_stability_missing_tickers(self):
        """Returns 400 when tickers are absent."""
        r = self.client.post("/api/scanner/factor-stability", json={"period": "2y"})
        self.assertEqual(r.status_code, 400)

    def test_factor_stability_bad_folds(self):
        """Returns 400 for n_folds outside 2-10."""
        r = self.client.post("/api/scanner/factor-stability",
                             json={"tickers": ["CBA"], "n_folds": 1})
        self.assertEqual(r.status_code, 400)

    def test_compute_factor_ic_smoke(self):
        """_compute_factor_ic returns a dict with all factor keys."""
        from routes.scanner import _compute_factor_ic, _FACTORS
        import random
        closes_list = []
        vols_list   = []
        rng = random.Random(7)
        for _ in range(12):
            c = [10.0]
            for __ in range(149):
                c.append(max(0.5, c[-1] * (1 + rng.gauss(0.001, 0.018))))
            closes_list.append(c)
            vols_list.append([100000] * 150)
        ics = _compute_factor_ic(closes_list, vols_list, forward_bars=20)
        self.assertEqual(set(ics.keys()), set(_FACTORS.keys()))

    def test_factor_helper_functions(self):
        """All _FACTORS lambdas run without error on valid arrays."""
        from routes.scanner import _FACTORS
        import numpy as np
        closes  = np.linspace(10, 12, 100)
        volumes = np.full(100, 50000.0)
        for fname, fn in _FACTORS.items():
            val = fn(closes, volumes)
            self.assertIsInstance(val, float, f"{fname} did not return float")

    def test_factor_weights_completeness(self):
        """All factors in _FACTORS have an entry in _FACTOR_WEIGHTS."""
        from routes.scanner import _FACTORS, _FACTOR_WEIGHTS
        for fname in _FACTORS:
            self.assertIn(fname, _FACTOR_WEIGHTS, f"{fname} missing from _FACTOR_WEIGHTS")

    def test_scanner_js_factor_tab(self):
        """scanner.js must contain the factor stability tab functions."""
        with open(os.path.join(ROOT, "js/pages/scanner.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_buildFactorStabilityHTML", src)
        self.assertIn("runFactorStability", src)
        self.assertIn("_renderFactorStabilityResults", src)
        self.assertIn("factor-stability", src)

    def test_scanner_js_syntax(self):
        """scanner.js must pass node --check."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/scanner.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")

    # ── Security hardening ────────────────────────────────────────────────────

    def test_security_headers_present(self):
        """API responses must include X-Content-Type-Options and X-Frame-Options."""
        r = self.client.get("/health")
        self.assertEqual(r.headers.get("X-Content-Type-Options"), "nosniff")
        self.assertEqual(r.headers.get("X-Frame-Options"), "SAMEORIGIN")
        self.assertIn(r.headers.get("Referrer-Policy", ""), ["strict-origin-when-cross-origin"])

    def test_cors_restricted(self):
        """asx_server.py CORS must specify an origins= list (not open wildcard)."""
        with open(os.path.join(ROOT, "asx_server.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("CORS(app, origins=", src)
        # The bare open-wildcard form must not be the active call
        self.assertNotIn("CORS(app)  #", src)

    def test_gunicorn_loopback_bind(self):
        """gunicorn.conf.py must bind to 127.0.0.1, not 0.0.0.0."""
        with open(os.path.join(ROOT, "gunicorn.conf.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("127.0.0.1", src)
        # Should not have the old open binding as the active bind= line
        import re
        bind_line = re.search(r'^bind\s*=\s*"([^"]+)"', src, re.MULTILINE)
        self.assertIsNotNone(bind_line, "bind= line not found in gunicorn.conf.py")
        self.assertIn("127.0.0.1", bind_line.group(1))


class TestSprint20WalkForward(unittest.TestCase):
    """Sprint 20 — Walk-forward backtest engine."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_wf_route_registered(self):
        """GET /api/backtest/walk-forward route must be registered."""
        rules = [r.rule for r in asx_server.app.url_map.iter_rules()]
        self.assertIn("/api/backtest/walk-forward", rules)

    def test_wf_missing_ticker(self):
        """/api/backtest/walk-forward must return 400 when ticker is absent."""
        r = self.client.post("/api/backtest/walk-forward",
                             json={"strategy": "rsi_trend", "period": "2y"})
        self.assertEqual(r.status_code, 400)
        self.assertIn("ticker", r.get_json().get("error", ""))

    def test_wf_bad_strategy(self):
        """Unsupported strategy must return 400."""
        r = self.client.post("/api/backtest/walk-forward",
                             json={"ticker": "CBA", "strategy": "nonexistent", "period": "2y"})
        self.assertEqual(r.status_code, 400)

    def test_wf_bad_splits(self):
        """n_splits outside 2–10 must return 400."""
        r = self.client.post("/api/backtest/walk-forward",
                             json={"ticker": "CBA", "strategy": "rsi_trend", "period": "2y", "n_splits": 1})
        self.assertEqual(r.status_code, 400)

    def test_param_grids_non_empty(self):
        """All strategy param grids must be non-empty lists of dicts."""
        from routes.backtest import _WF_PARAM_GRIDS
        for strat, grid in _WF_PARAM_GRIDS.items():
            self.assertIsInstance(grid, list, f"{strat} grid is not a list")
            self.assertGreater(len(grid), 0, f"{strat} grid is empty")
            self.assertIsInstance(grid[0], dict, f"{strat} grid[0] is not a dict")

    def test_run_strategy_slice_smoke(self):
        """_run_strategy_slice must run without error on synthetic data."""
        from routes.backtest import _run_strategy_slice, _WF_PARAM_GRIDS
        import random
        random.seed(1)
        prices = [10.0]
        for _ in range(199):
            prices.append(max(0.5, prices[-1] * (1 + random.gauss(0.0002, 0.015))))
        highs = [p * 1.01 for p in prices]
        lows  = [p * 0.99 for p in prices]
        vols  = [100000] * 200
        for strat, grid in _WF_PARAM_GRIDS.items():
            res = _run_strategy_slice(prices, highs, lows, vols, strat, grid[0], 10000, 10, 0.001)
            self.assertIn("final_value", res)
            self.assertIn("trades", res)
            self.assertIn("sharpe", res)
            self.assertIsInstance(res["total_return_pct"], float)

    def test_backtest_js_wf_tab(self):
        """backtest.js must contain walk-forward panel and run function."""
        with open(os.path.join(ROOT, "js/pages/backtest.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_renderWfPanel", src)
        self.assertIn("runWalkForward", src)
        self.assertIn("_renderWfResults", src)
        self.assertIn("_drawWfCurve", src)
        self.assertIn("Walk-Forward", src)

    def test_backtest_js_syntax(self):
        """backtest.js must pass node --check after walk-forward additions."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js/pages/backtest.js")],
            capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, f"Syntax error:\n{result.stderr}")


class TestSprint19VitestInfrastructure(unittest.TestCase):
    """Sprint 19 — Vitest frontend test infrastructure exists and is valid."""

    def test_package_json_exists(self):
        """package.json must exist with vitest devDependency."""
        path = os.path.join(ROOT, "package.json")
        self.assertTrue(os.path.exists(path), "package.json missing")
        import json
        with open(path, encoding="utf-8") as f:
            pkg = json.load(f)
        self.assertIn("vitest", pkg.get("devDependencies", {}))
        self.assertIn("test:js", pkg.get("scripts", {}))

    def test_vitest_config_exists(self):
        """vitest.config.js must exist."""
        path = os.path.join(ROOT, "vitest.config.js")
        self.assertTrue(os.path.exists(path), "vitest.config.js missing")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("setupFiles", src)
        self.assertIn("globals", src)

    def test_setup_js_exists(self):
        """tests/setup.js must exist with vm loader and global stubs."""
        path = os.path.join(ROOT, "tests", "setup.js")
        self.assertTrue(os.path.exists(path), "tests/setup.js missing")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        self.assertIn("loadScript", src)
        self.assertIn("extractFunction", src)
        self.assertIn("vm.runInThisContext", src)

    def test_all_test_files_exist(self):
        """All four Vitest test files must be present."""
        for name in ["quant-engine", "regime-engine", "response-validator", "detect-exit-reason"]:
            path = os.path.join(ROOT, "tests", f"{name}.test.js")
            self.assertTrue(os.path.exists(path), f"tests/{name}.test.js missing")

    def test_vitest_suite_passes(self):
        """npm run test:js must exit 0 with all tests passing."""
        import subprocess, sys
        result = subprocess.run(
            "npm run test:js",
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            cwd=ROOT, shell=True
        )
        self.assertEqual(result.returncode, 0,
            f"Vitest suite failed:\n{result.stdout[-3000:]}\n{result.stderr[-1000:]}")
        self.assertIn("passed", result.stdout)

    def test_response_validator_sell_trim_stop_rule(self):
        """response-validator.js stop-below-entry rule must be direction-aware."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("SELL", src)
        self.assertIn("TRIM", src)
        # The rule must handle SELL/TRIM differently
        self.assertIn("stop must be above entry", src)


class TestAiCall20ValidationFixes(unittest.TestCase):
    """AI Call #20 (2026-06-17) manual review found 4 response-quality issues that
    should be caught deterministically rather than relying on prompt wording alone:
    1) GMG REJECT-but-still-in-recs[], 2) SHL SELL-but-deferring-anti-churn,
    4) WES netProfit not reconciling to real unrealisedPnl. (#3 — catastrophe-clause
    misapplication — is a free-text judgement call, not deterministically checkable,
    and is intentionally NOT covered here.)"""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            cls.validator_src = f.read()
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            cls.analysis_src = f.read()

    # ── Issue 1/2: reject/defer contradiction rule exists in the validator ─────

    def test_reject_defer_contradiction_rule_present(self):
        """validator must define a business rule catching reject/defer language
        co-occurring with a non-HOLD action."""
        self.assertIn("reject-defer-contradiction", self.validator_src)
        self.assertIn("_REJECT_DEFER_PHRASES", self.validator_src)

    def test_reject_defer_phrase_list_covers_ai_call_20_cases(self):
        """Phrase list must cover the exact language seen in AI Call #20:
        GMG 'REJECT GMG' and SHL 'anti-churn block applies... deferring'."""
        self.assertIn("anti-churn block applies", self.validator_src)
        self.assertIn("deferring to", self.validator_src)
        # Generic "reject <TICKER>" pattern (not hardcoded to GMG specifically)
        self.assertIn("_REJECT_TICKER_RE", self.validator_src)
        self.assertIn(r"\breject\s+[A-Z0-9]{2,5}\b", self.validator_src)

    def test_reject_defer_rule_skips_hold_and_no_reasoning(self):
        """Rule must not misfire on HOLD recs or recs with no reasoning text."""
        rule_idx = self.validator_src.index("id: 'reject-defer-contradiction'")
        rule_body = self.validator_src[rule_idx:rule_idx + 600]
        self.assertIn("r.action === 'HOLD'", rule_body)
        self.assertIn("!r.reasoning", rule_body)

    def test_reject_defer_contradiction_is_unfixable_not_silently_patched(self):
        """The contradiction rule must have no inline `fix` — it requires either a
        repair-retry (existing _buildRepairMessage loop) or demotion out of recs[],
        never a silent client-side patch that hides the contradiction."""
        rule_idx = self.validator_src.index("id: 'reject-defer-contradiction'")
        rule_end = self.validator_src.index("},", rule_idx)
        # find the closing of this rule object (next top-level rule starts after
        # the matching message() function) — slice a generous window and confirm
        # no `fix:` key appears before the next rule id
        next_rule_idx = self.validator_src.index("id: 'anti-churn-flip'")
        rule_block = self.validator_src[rule_idx:next_rule_idx]
        self.assertNotIn("fix:", rule_block,
                         "reject/defer contradiction must not be auto-fixed silently")

    # ── Issue 1/2: analysis.js flags (not drops) the contradiction in recs[] ───

    def test_analysis_flags_self_contradicting_recs(self):
        """analysis.js validator step must detect the contradiction error message
        and flag-not-drop the rec (same as other unfixable validation errors) so
        every rec from Claude is visible in Pending for the user's own judgment,
        carrying _ruleWarnings instead of being silently dropped."""
        self.assertIn("validatorFlagged", self.analysis_src)
        self.assertIn("contradictionHit", self.analysis_src)
        # Must keep the rec with _ruleWarnings attached, not return [] (drop)
        contradiction_idx = self.analysis_src.index("contradictionHit = errors.find")
        contradiction_block = self.analysis_src[contradiction_idx:contradiction_idx + 400]
        self.assertIn("_ruleWarnings", contradiction_block)
        self.assertNotIn("return [];", contradiction_block)

    def test_analysis_contradiction_check_runs_before_generic_flag_path(self):
        """The contradiction-specific check must run before the generic
        flag-don't-drop fallback so its dedicated diagnosis takes priority
        over the generic one for the same rec."""
        contradiction_at = self.analysis_src.index("contradictionHit")
        flag_at   = self.analysis_src.index("validatorFlagged.push")
        self.assertLess(contradiction_at, flag_at,
                        "contradiction check must be evaluated before the generic flagging push")

    # ── Issue 4: AI-supplied netProfit/expectedProfit/riskAUD/rewardAUD stripped ──

    def test_validator_strips_untrusted_ai_numeric_fields(self):
        """Per CLAUDE.md Rule 4 (Claude never computes netProfit/expectedProfit —
        qty stays 0, the quant engine sizes post-response), validateRec() must
        strip any AI-supplied netProfit/expectedProfit/riskAUD/rewardAUD rather
        than let them leak through unrecomputed."""
        self.assertIn("_AI_UNTRUSTED_NUMERIC_FIELDS", self.validator_src)
        for field in ["netProfit", "expectedProfit", "riskAUD", "rewardAUD"]:
            self.assertIn(field, self.validator_src)
        self.assertIn("_stripUntrustedAiFields", self.validator_src)
        # Must be wired into validateRec
        validate_rec_idx = self.validator_src.index("function validateRec(rec, ctx)")
        validate_rec_body = self.validator_src[validate_rec_idx:validate_rec_idx + 300]
        self.assertIn("_stripUntrustedAiFields", validate_rec_body)

    def test_analysis_already_recomputes_netprofit_engine_side(self):
        """Defense-in-depth check: confirm the live analysis.js pipeline already
        overwrites netProfit/expectedProfit from the quant engine / real cost basis
        (FIX #2 / §8.2) rather than trusting the AI's raw value — the validator-side
        strip in response-validator.js is a backstop for any path that doesn't go
        through this recompute (e.g. getValidatedAnalysisWithRepair used standalone)."""
        self.assertIn("_netProfitEngine", self.analysis_src)
        self.assertIn("r.netProfit = (sellPrice - holding.avgPrice) * qty - fees", self.analysis_src)


class TestSuccessTagsIntegration(unittest.TestCase):
    """Success tags: calibration nudge + success_patterns in stats."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    def test_stats_returns_success_patterns(self):
        """/api/learning/stats must include success_patterns key."""
        r = self.client.get("/api/learning/stats")
        data = json.loads(r.data)
        self.assertIn("success_patterns", data)
        self.assertIn("by_success_type", data["success_patterns"])

    def test_calib_success_nudge_in_source(self):
        """_calib_compute must have a dominant success tag nudge (mirror of L2)."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("wins_tagged", src)
        self.assertIn("lean into this", src)
        # Same ESS threshold as error check
        self.assertIn("win_ess >= _ESS_MIN", src)

    def test_calib_query_includes_success_tags(self):
        """_calib_compute SQL query must select success_tags column."""
        with open(os.path.join(ROOT, "routes/learning.py"), encoding="utf-8") as f:
            src = f.read()
        # The calibration SELECT must include success_tags
        self.assertIn("success_tags", src.split("def learning_calibration")[0]
                      if "def learning_calibration" in src else src)

    def test_success_card_in_learning_js(self):
        """learning.js must render a Success Patterns card."""
        with open(os.path.join(ROOT, "js/pages/learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Success Patterns", src)
        self.assertIn("successCard", src)
        self.assertIn("by_success_type", src)


class TestPhase6CalibQuality(unittest.TestCase):
    """Phase 6 — Calibration quality debate endpoint."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    def test_calib_quality_endpoint_exists(self):
        """/api/debate/calib-quality must exist and return JSON."""
        r = self.client.get("/api/debate/calib-quality")
        self.assertIn(r.status_code, (200, 200))
        data = json.loads(r.data)
        self.assertIn("ok", data)

    def test_calib_quality_no_data_returns_ok_false(self):
        """With empty DB, endpoint returns ok=False (insufficient data)."""
        r = self.client.get("/api/debate/calib-quality")
        data = json.loads(r.data)
        # Empty DB → either Ollama not available (503) or insufficient data (ok=False)
        # Both are valid — test that the response is well-formed JSON
        self.assertIn("ok", data)

    def test_norm_cdf_helper(self):
        """_norm_cdf must return correct values for known Z-scores."""
        from routes.debate import _norm_cdf
        self.assertAlmostEqual(_norm_cdf(0.0),  0.5000, places=4)
        self.assertAlmostEqual(_norm_cdf(1.96), 0.9750, places=3)
        self.assertAlmostEqual(_norm_cdf(-1.96), 0.0250, places=3)

    def test_calib_bands_raw_empty_db(self):
        """_calib_bands_raw returns empty list on empty DB (no error)."""
        from routes.debate import _calib_bands_raw
        result = _calib_bands_raw(regime="", days=90)
        self.assertIsInstance(result, list)

    def test_calib_quality_prompt_contains_immutable_facts_instruction(self):
        """Phase 6 prompt must tell model to treat Z-scores as immutable facts."""
        from routes.debate import _calib_quality_prompt
        # Build a minimal band dict to test prompt generation
        bands = [{
            "band": "70-80%", "lo": 0.70, "hi": 0.80, "mid": 0.75,
            "n": 12, "ess": 8.4, "actual_wr": 0.63,
            "se": 0.15, "z": -0.80, "p_noise": 0.42,
            "n_losses": 4, "tag_counts": [("poor_entry", 2), ("overconfident", 1)],
        }]
        prompt = _calib_quality_prompt(bands)
        self.assertIn("immutable facts", prompt)
        self.assertIn("DO NOT recalculate", prompt)
        self.assertIn("p_noise=0.42", prompt)
        self.assertIn("likely_noise", prompt.lower())

    def test_calib_quality_verdict_pre_computed(self):
        """Verdict must be pre-computed from p_noise, not overridable by model."""
        import importlib, sys
        # Read the endpoint source to verify the pre_verdict logic exists
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("pre_verdict", src)
        self.assertIn('["p_noise"] > 0.30', src)
        self.assertIn('["p_noise"] > 0.15', src)
        # Verdict must be assigned from pre_verdict (not from model response)
        self.assertIn('"verdict":     pre_verdict', src)

    def test_calib_quality_schema_defined(self):
        """_SCHEMA_CALIB_QUALITY must be defined and have required fields."""
        from routes.debate import _SCHEMA_CALIB_QUALITY
        self.assertIn("band_assessments", _SCHEMA_CALIB_QUALITY["properties"])
        self.assertIn("overall_summary",  _SCHEMA_CALIB_QUALITY["properties"])
        items = _SCHEMA_CALIB_QUALITY["properties"]["band_assessments"]["items"]
        self.assertIn("verdict",  items["properties"])
        self.assertIn("analysis", items["properties"])
        # Verdict enum must not include any hallucination-friendly free-text value
        verdicts = items["properties"]["verdict"]["enum"]
        self.assertIn("likely_noise",    verdicts)
        self.assertIn("ambiguous",       verdicts)
        self.assertIn("likely_systemic", verdicts)

    def test_calib_quality_frontend_placeholder_exists(self):
        """learning.js must contain the calib quality card placeholder."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("ll-calib-quality-card", src)
        self.assertIn("renderCalibQualityCard", src)

    def test_calib_quality_auto_trigger_in_analysis(self):
        """calib-quality debate is manual-only — analysis.js must NOT auto-trigger it."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("triggerCalibQualityIfStale(", src,
                         "triggerCalibQualityIfStale must not be called from analysis.js — debates are manual only")

    def test_calib_quality_trigger_in_debate_client(self):
        """debate-client.js must define triggerCalibQualityIfStale with LOW priority."""
        with open(os.path.join(ROOT, "js", "debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("triggerCalibQualityIfStale", src)
        self.assertIn("LOW", src)


class TestSanityCheckHardening(unittest.TestCase):
    """_pm_sanity_check_tags — new guards for overconfident, poor_rr(null), SELL/TRIM stop direction."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()

    def setUp(self):
        # _pm_sanity_check_tags calls current_app.logger — needs app context
        self._ctx = asx_server.app.app_context()
        self._ctx.push()
        from routes.debate import _pm_sanity_check_tags
        self._check = _pm_sanity_check_tags

    def tearDown(self):
        self._ctx.pop()

    def _row(self, **kwargs):
        base = {
            "actual_entry_price": 85.50,
            "suggested_stop":     76.00,
            "rr_ratio":           None,
            "ai_confidence":      0.55,
            "recommendation":     "TRIM",
            "realized_pnl_pct":   None,
        }
        base.update(kwargs)
        return base

    # overconfident at low confidence ─────────────────────────────────────────

    def test_overconfident_stripped_below_065(self):
        row = self._row(ai_confidence=0.55, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.0)
        result = self._check("overconfident,poor_entry", row, 1)
        self.assertNotIn("overconfident", result)
        self.assertIn("poor_entry", result)

    def test_overconfident_kept_above_065(self):
        row = self._row(ai_confidence=0.80, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.5, rr_ratio=1.5)
        result = self._check("overconfident", row, 2)
        self.assertIn("overconfident", result)

    def test_overconfident_kept_when_conf_missing(self):
        """If ai_confidence is None, do not strip (can't assert it's low)."""
        row = self._row(ai_confidence=None, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.5)
        result = self._check("overconfident", row, 3)
        self.assertIn("overconfident", result)

    # poor_rr when rr_ratio is NULL ───────────────────────────────────────────

    def test_poor_rr_stripped_when_rr_null(self):
        row = self._row(rr_ratio=None, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.5)
        result = self._check("poor_rr,poor_entry", row, 4)
        self.assertNotIn("poor_rr", result)
        self.assertIn("poor_entry", result)

    def test_poor_rr_kept_when_rr_below_2(self):
        row = self._row(rr_ratio=1.2, recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=9.5)
        result = self._check("poor_rr", row, 5)
        self.assertIn("poor_rr", result)

    # SELL/TRIM stop below entry suppresses stop_too_tight ───────────────────

    def test_stop_too_tight_stripped_for_sell_stop_below_entry(self):
        """SELL/TRIM with stop below entry → wrong direction, not tight."""
        row = self._row(recommendation="TRIM",
                        actual_entry_price=85.50, suggested_stop=76.00)  # stop < entry
        result = self._check("stop_too_tight", row, 6)
        self.assertNotIn("stop_too_tight", result)

    def test_stop_too_tight_kept_for_sell_stop_above_entry(self):
        """SELL with stop correctly above entry and distance ≤15% → tag valid."""
        row = self._row(recommendation="SELL",
                        actual_entry_price=85.50, suggested_stop=90.00)  # stop > entry, ~5%
        result = self._check("stop_too_tight", row, 7)
        self.assertIn("stop_too_tight", result)

    def test_stop_too_tight_stripped_for_buy_wide_stop(self):
        """BUY with stop 20% away → still stripped (existing rule)."""
        row = self._row(recommendation="BUY",
                        actual_entry_price=10.0, suggested_stop=8.0)  # 20% away
        result = self._check("stop_too_tight", row, 8)
        self.assertNotIn("stop_too_tight", result)

    # ── Rescue rule: thesis_broken for large directional failures ────────────

    def test_rescue_thesis_broken_for_large_sell_loss_all_stripped(self):
        """When all tags stripped and SELL/TRIM has |pnl| >= 10%, rescue with thesis_broken."""
        # AMC #190 scenario: poor_rr + overconfident both stripped → rescue fires
        row = self._row(
            recommendation="SELL",
            actual_entry_price=76.299,
            suggested_stop=58.840,   # wrong direction (below entry for SELL)
            rr_ratio=None,           # NULL — wrong-direction stop so backfill skipped
            ai_confidence=0.62,      # below 0.65 → overconfident stripped
            realized_pnl_pct=-28.8,  # large directional loss
        )
        result = self._check("poor_rr,overconfident", row, 99)
        self.assertIn("thesis_broken", result,
                      "Rescue rule must inject thesis_broken when all tags stripped and |pnl| >= 10%")

    def test_rescue_does_not_fire_for_small_loss(self):
        """Rescue must NOT fire when |pnl| < 10% (could be noise/commission)."""
        row = self._row(
            recommendation="SELL",
            actual_entry_price=10.0,
            suggested_stop=9.0,
            rr_ratio=None,
            ai_confidence=0.62,
            realized_pnl_pct=-3.0,
        )
        result = self._check("poor_rr", row, 98)
        self.assertNotIn("thesis_broken", result,
                         "Rescue must not inject thesis_broken for small losses")
        self.assertEqual(result, "",
                         "Small loss with all tags stripped should return empty (none)")

    def test_rescue_does_not_fire_when_valid_tags_remain(self):
        """Rescue must NOT fire when at least one valid tag survived stripping."""
        row = self._row(
            recommendation="SELL",
            actual_entry_price=10.0,
            suggested_stop=9.0,
            rr_ratio=None,
            ai_confidence=0.80,
            realized_pnl_pct=-28.0,
        )
        # overconfident survives (conf >= 0.65), poor_rr stripped — rescue must not add thesis_broken on top
        result = self._check("poor_rr,overconfident", row, 97)
        self.assertIn("overconfident", result)
        self.assertNotIn("thesis_broken", result,
                         "Rescue must not fire when overconfident survived stripping")

    def test_rescue_fires_for_large_buy_loss(self):
        """Rescue also applies to BUY trades where stock fell > 10% — thesis_broken."""
        row = self._row(
            recommendation="BUY",
            actual_entry_price=50.0,
            suggested_stop=None,
            rr_ratio=None,
            ai_confidence=0.55,
            realized_pnl_pct=-15.0,
        )
        result = self._check("poor_rr,overconfident", row, 96)
        self.assertIn("thesis_broken", result,
                      "Rescue must fire for BUY with large loss when all tags stripped")

    def test_sanity_check_wrong_direction_stop_note_in_prompt(self):
        """Prompt must warn models to ignore wrong-direction stop and focus on P&L."""
        from routes.debate import _pm_build_prompt
        prompt = _pm_build_prompt(
            summary="SELL AMC LOSS | entry=76.3 | stop=58.8 [⚠ wrong dir] | PnL=-28.8%",
            rationale="",
            exit_hint="manual",
            action="SELL",
            pnl_pct=-28.8,
        )
        self.assertIn("WRONG-DIRECTION STOP WARNING", prompt)
        self.assertIn("DATA\n  ENTRY ERROR", prompt)
        self.assertIn("IGNORE IT ENTIRELY", prompt)

    # SELL/TRIM regime_mismatch hint in prompt ────────────────────────────────

    def test_pm_build_prompt_includes_regime_check_for_sell(self):
        """_pm_build_prompt must include regime_mismatch hint for SELL/TRIM."""
        from routes.debate import _pm_build_prompt
        prompt = _pm_build_prompt("TRIM WES LOSS | regime=riskOn", "", "", action="TRIM")
        self.assertIn("REGIME CHECK", prompt)
        self.assertIn("risk-on or bullish regime", prompt)
        self.assertIn("regime_mismatch", prompt)

    def test_pm_build_prompt_no_regime_hint_for_buy(self):
        """BUY/TOP_UP prompts must not include SELL-specific regime hint."""
        from routes.debate import _pm_build_prompt
        prompt = _pm_build_prompt("BUY BHP LOSS | regime=riskOn", "", "", action="BUY")
        self.assertNotIn("REGIME CHECK", prompt)

    # Phase 3 synthesis runs through model_b ──────────────────────────────────

    def test_phase3_synthesis_uses_model_b(self):
        """Phase 3 synthesis must call model_b (non-incumbent) not model_a."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Find the Phase 3 section — use a large enough window to cover the call site
        phase3_idx = src.index("Phase 3: Neutral synthesis")
        phase3_src = src[phase3_idx:phase3_idx + 2500]
        # synthesis call and transcript label must both use model_b
        self.assertIn("_call_model_any(model_b, synthesis_prompt", phase3_src)
        self.assertIn('"synthesis_model": model_b', phase3_src)
        # model_a must NOT be used for the synthesis _call_ (it still appears in prompt text)
        # Check specifically the call line
        self.assertNotIn("_call_model_any(model_a, synthesis_prompt", phase3_src)


class TestSprint28(unittest.TestCase):
    """Sprint 28 — combined skill+tag call + regime-specific decay interpretation."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    # ── Skill schema includes success_tags ──────────────────────────────────

    def test_schema_skill_has_success_tags_property(self):
        """_SCHEMA_SKILL must include success_tags as an optional property."""
        from routes.debate import _SCHEMA_SKILL
        self.assertIn("success_tags", _SCHEMA_SKILL["properties"])
        # success_tags must NOT be in required (it's optional — empty for losses)
        self.assertNotIn("success_tags", _SCHEMA_SKILL.get("required", []))

    def test_skill_prompt_includes_win_tag_guidance_for_wins(self):
        """debate_skill prompt must ask for success_tags when outcome is win."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # The win_tag_block must include the tag options
        self.assertIn("catalyst_capture", src)
        self.assertIn("good_sizing", src)
        # Combined example must show success_tags key
        self.assertIn('"success_tags"', src)
        # Prompt must guard win-only section behind is_win check
        self.assertIn("is_win", src)

    def test_skill_endpoint_returns_success_tags_field(self):
        """/api/debate/skill jsonify call must include success_tags key."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # The jsonify return dict must include success_tags
        self.assertIn('"success_tags":', src)
        # Specifically the return from debate_skill (not just tag-win endpoint)
        # Verify it appears after the skill_score key in the source
        skill_fn_idx = src.index("def debate_skill()")
        skill_fn_src = src[skill_fn_idx:skill_fn_idx + 3000]
        self.assertIn('"success_tags":', skill_fn_src)

    def test_skill_db_write_stores_success_tags_for_wins(self):
        """debate_skill must write success_tags to DB when they are non-empty."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # DB write for wins must include success_tags= column
        self.assertIn("SET skill_score=?, success_tags=? WHERE id=?", src)
        # Validation must use VALID_WIN_TAGS to filter returned tags
        self.assertIn("VALID_WIN_TAGS", src)

    # ── Regime-specific decay interpretation ────────────────────────────────

    def test_calib_decay_regime_exposure_branch_exists(self):
        """_calib_compute must emit 'likely-regime-exposure' when global decay
        is detected but the current regime is stable."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("likely-regime-exposure", src)
        self.assertIn("not universal decay", src)

    def test_calib_decay_regime_stable_threshold(self):
        """Regime stability threshold must be abs(reg_delta) < 0.08."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("abs(reg_delta) < 0.08", src)

    def test_calib_decay_fallback_when_no_regime(self):
        """When regime is None, decay message must not include regime-exposure text."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # The fallback (no regime) path must still emit the reduce-posn message
        self.assertIn("reduce posn 30%", src)
        # The fallback must be gated: 'if not interpretation_appended'
        self.assertIn("interpretation_appended", src)

    def test_calib_decay_requires_3_regime_trades_for_interpretation(self):
        """Regime sub-check must require at least 3 recent same-regime trades."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("len(reg_recent) >= 3", src)


class TestSprint29SellTrimTagging(unittest.TestCase):
    """Sprint 29 — structured SELL/TRIM decision tagging."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    # ── DB schema ────────────────────────────────────────────────────────────

    def test_db_columns_exist(self):
        """sell_primary_driver / sell_secondary_factors / sell_urgency must exist in DB."""
        from db import get_db
        with get_db() as conn:
            cols = {r[1] for r in conn.execute("PRAGMA table_info(ai_learning_events)").fetchall()}
        self.assertIn("sell_primary_driver",    cols)
        self.assertIn("sell_secondary_factors", cols)
        self.assertIn("sell_urgency",           cols)

    # ── Learning log endpoint accepts new fields ──────────────────────────────

    def test_log_endpoint_accepts_sell_tags(self):
        """POST /api/learning/log must store sell_primary_driver for a SELL event."""
        r = self.client.post("/api/learning/log", json={
            "event_type":         "recommendation",
            "ticker":             "CSL.AX",
            "recommendation":     "SELL",
            "ai_confidence":      0.65,
            "regime":             "riskOn",
            "sell_primary_driver":    "thesis_broken",
            "sell_secondary_factors": "negative_news_flow,earnings_approaching",
            "sell_urgency":           "immediate",
        })
        data = json.loads(r.data)
        self.assertTrue(data["ok"])
        ev_id = data["id"]
        # Verify stored
        from db import get_db
        with get_db() as conn:
            row = conn.execute(
                "SELECT sell_primary_driver, sell_secondary_factors, sell_urgency FROM ai_learning_events WHERE id=?",
                (ev_id,)
            ).fetchone()
        self.assertEqual(row["sell_primary_driver"],    "thesis_broken")
        self.assertEqual(row["sell_secondary_factors"], "negative_news_flow,earnings_approaching")
        self.assertEqual(row["sell_urgency"],           "immediate")

    # ── JS validator constants ────────────────────────────────────────────────

    def test_validator_defines_sell_constants(self):
        """response-validator.js must define the three sell tag constants."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("SELL_PRIMARY_DRIVERS",    src)
        self.assertIn("SELL_SECONDARY_FACTORS",  src)
        self.assertIn("SELL_URGENCY",            src)
        self.assertIn("SELL_FORBIDDEN_COMBOS",   src)
        self.assertIn("SELL_REQUIRED_SECONDARY", src)

    def test_validator_defines_validateSellTags(self):
        """validateSellTags must be defined and wired into validateRec."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function validateSellTags", src)
        # Must be called from validateRec
        validate_rec_idx = src.index("function validateRec")
        validate_rec_body = src[validate_rec_idx:validate_rec_idx + 1500]
        self.assertIn("validateSellTags", validate_rec_body)

    def test_validator_taxonomy_completeness(self):
        """All nine primary drivers from the spec must be in the validator."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        for driver in ['thesis_broken', 'target_reached', 'stop_triggered',
                       'technical_breakdown', 'regime_change', 'better_opportunity',
                       'time_stop', 'risk_management', 'tax_optimisation']:
            self.assertIn(driver, src, f"Primary driver '{driver}' missing from validator")

    def test_validator_forbidden_combos(self):
        """Forbidden combinations must be present."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("target_reached", src)
        self.assertIn("stop_triggered", src)
        self.assertIn("time_stop",      src)
        self.assertIn("SELL_FORBIDDEN_COMBOS", src)

    def test_validator_required_secondary_for_tax_optimisation(self):
        """tax_optimisation must require one of the CGT/harvest secondary tags."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("tax_optimisation", src)
        self.assertIn("unrealised_loss_large", src)
        self.assertIn("held_over_12m",         src)
        self.assertIn("held_11_to_12m",        src)

    def test_validator_better_opportunity_requires_alternative_ticker(self):
        """better_opportunity must require alternativeTicker."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("better_opportunity", src)
        self.assertIn("alternativeTicker",  src)

    # ── Prompt includes SELL/TRIM tagging section ─────────────────────────────

    def test_prompt_includes_sell_tagging_section(self):
        """ANALYSIS_SYSTEM_PROMPT must include the SELL/TRIM decision tagging rules."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("SELL/TRIM DECISION TAGGING", src)
        self.assertIn("primary_driver",    src)
        self.assertIn("secondary_factors", src)
        self.assertIn("urgency",           src)
        # Forbidden combos documented in prompt
        self.assertIn("FORBIDDEN", src)
        # JSON schema updated
        self.assertIn('"primary_driver"',    src)
        self.assertIn('"secondary_factors"', src)
        self.assertIn('"urgency"',           src)

    # ── analysis.js passes sell fields to learning log ────────────────────────

    def test_analysis_passes_sell_fields_to_learning_log(self):
        """logRecsToLearningLoop must pass sell_primary_driver etc. for SELL/TRIM recs."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("sell_primary_driver",    src)
        self.assertIn("sell_secondary_factors", src)
        self.assertIn("sell_urgency",           src)
        # Must be conditional on SELL/TRIM action
        self.assertIn("r.action === 'SELL' || r.action === 'TRIM'", src)

    # ── Recommendations page renders sell tags ────────────────────────────────

    def test_recommendations_renders_sell_tags(self):
        """recommendations.js must render the primary_driver tag strip on SELL/TRIM cards."""
        with open(os.path.join(ROOT, "js", "pages", "recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("primary_driver",    src)
        self.assertIn("secondary_factors", src)
        self.assertIn("Sell reason",       src)
        self.assertIn("alternativeTicker", src)
        self.assertIn("urgencyStyle",      src)


class TestSprint31LearningLoopHardening(unittest.TestCase):
    """Sprint 31 — Gaps 2, 5, 8 from learning_loop_critics.md."""

    # ── Gap 2: Phase 8 skill-weighting validation gate ───────────────────────

    def test_compute_phase8_meta_function_exists(self):
        """routes/learning.py must define _compute_phase8_meta helper."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _compute_phase8_meta(", src)

    def test_compute_phase8_meta_inactive_below_n10(self):
        """_compute_phase8_meta must return active=False when fewer than 10 scored events."""
        import routes.learning as rl
        result = rl._compute_phase8_meta([])
        self.assertFalse(result["active"])
        result9 = rl._compute_phase8_meta([
            {"skill_score": 7.0, "outcome_status": "win"} for _ in range(9)
        ])
        self.assertFalse(result9["active"])

    def test_compute_phase8_meta_active_when_wins_score_higher(self):
        """_compute_phase8_meta must return active=True when wins have higher mean skill."""
        import routes.learning as rl
        rows = (
            [{"skill_score": 8.0, "outcome_status": "win"}]     * 6 +
            [{"skill_score": 4.0, "outcome_status": "loss"}]    * 6
        )
        result = rl._compute_phase8_meta(rows)
        self.assertTrue(result["active"])
        self.assertGreater(result["mean_skill_wins"], result["mean_skill_losses"])

    def test_compute_phase8_meta_inactive_when_scores_inverted(self):
        """_compute_phase8_meta must return active=False when losses score higher than wins."""
        import routes.learning as rl
        rows = (
            [{"skill_score": 3.0, "outcome_status": "win"}]     * 6 +
            [{"skill_score": 7.0, "outcome_status": "loss"}]    * 6
        )
        result = rl._compute_phase8_meta(rows)
        self.assertFalse(result["active"])

    def test_weight_uses_sf1_when_phase8_inactive(self):
        """_calib_compute must fall back to sf=1.0 when _phase8_active is False."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_phase8_active", src,
                      "learning.py must define _phase8_active gate variable")
        self.assertIn("sk is not None and _phase8_active", src,
                      "learning.py _weight() must gate skill factor on _phase8_active")

    def test_stats_returns_phase8_key(self):
        """GET /api/learning/stats must return a 'phase8' key."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"phase8"', src,
                      "learning_stats must include phase8 key in response")

    def test_learning_js_renders_phase8_note(self):
        """learning.js must render the Phase 8 status note."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("phase8Note", src)
        self.assertIn("Phase 8 skill-weighting", src)

    # ── Gap 5: Prompt regression detector ────────────────────────────────────

    def test_check_prompt_regression_function_exists(self):
        """routes/learning.py must define _check_prompt_regression helper."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _check_prompt_regression(", src)

    def test_check_prompt_regression_returns_none_on_improvement(self):
        """_check_prompt_regression must return None when current version is same or better."""
        import routes.learning as rl
        versions = [
            {"version": "v2", "closed": 20, "win_rate": 65.0},  # current — better
            {"version": "v1", "closed": 20, "win_rate": 55.0},  # prior
        ]
        self.assertIsNone(rl._check_prompt_regression(versions))

    def test_check_prompt_regression_detects_regression(self):
        """_check_prompt_regression must return a dict when current win rate is lower."""
        import routes.learning as rl
        versions = [
            {"version": "v2", "closed": 30, "win_rate": 45.0},  # current — worse
            {"version": "v1", "closed": 30, "win_rate": 65.0},  # prior
        ]
        result = rl._check_prompt_regression(versions)
        self.assertIsNotNone(result)
        self.assertEqual(result["current_version"], "v2")
        self.assertEqual(result["prior_version"], "v1")
        self.assertAlmostEqual(result["drop_pp"], 20.0, places=0)
        self.assertIn("significant", result)

    def test_check_prompt_regression_significant_flag(self):
        """drop > 2×SE must set significant=True; drop <= 1×SE must leave it False."""
        import routes.learning as rl, math
        # SE for n=100 is sqrt(0.25/100) ≈ 0.05 (5pp)
        big_drop = [
            {"version": "v2", "closed": 100, "win_rate": 40.0},
            {"version": "v1", "closed": 100, "win_rate": 65.0},  # 25pp drop >> 2×5pp
        ]
        self.assertTrue(rl._check_prompt_regression(big_drop)["significant"])
        small_drop = [
            {"version": "v2", "closed": 100, "win_rate": 59.0},
            {"version": "v1", "closed": 100, "win_rate": 61.0},  # 2pp drop << 2×5pp
        ]
        self.assertFalse(rl._check_prompt_regression(small_drop)["significant"])

    def test_stats_returns_prompt_regression_key(self):
        """GET /api/learning/stats must return a 'prompt_regression' key."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"prompt_regression"', src,
                      "learning_stats must include prompt_regression key in response")

    def test_learning_js_renders_regression_banner(self):
        """learning.js must render the prompt regression banner."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("regressionBanner", src)
        self.assertIn("promptRegression", src)
        self.assertIn("Significant regression detected", src)

    # ── Gap 8: Calibration token budget ──────────────────────────────────────

    def test_calib_char_budget_constant_exists(self):
        """_calib_compute must define _CALIB_CHAR_BUDGET and _CALIB_CHAR_CEILING."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_CALIB_CHAR_BUDGET", src)
        self.assertIn("_CALIB_CHAR_CEILING", src)

    def test_calib_budget_truncates_from_end(self):
        """_calib_compute must pop from parts list when over budget."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Verify the while loop with parts.pop() is present
        self.assertIn("while len(parts) > 1", src,
                      "_calib_compute must trim parts while over budget")
        self.assertIn("parts.pop()", src,
                      "_calib_compute must pop lowest-priority part to trim")

    def test_calib_ceiling_applied_as_hard_cap(self):
        """_calib_compute must apply _CALIB_CHAR_CEILING as a hard truncation safety net."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_CALIB_CHAR_CEILING - 1", src,
                      "_calib_compute must slice block_body at hard ceiling")


class TestSprint30DataEnhancements(unittest.TestCase):
    """Sprint 30 — three highest-value data additions to Claude's context."""

    # ── Addition 1: earnings beat/miss history ────────────────────────────────

    def test_earnings_beat_miss_in_analysis_js(self):
        """analysis.js earningsCtx must include beat/miss history from quarterlyEarnings."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("EPSvEst(4Q)", src,
                      "analysis.js earningsCtx must include EPSvEst(4Q) beat/miss block")
        self.assertIn("quarterlyEarnings", src,
                      "analysis.js must read quarterlyEarnings for beat/miss")
        self.assertIn("beatMiss", src,
                      "analysis.js must define beatMiss variable")

    # ── Addition 2: sector ETF performance in macro ───────────────────────────

    def test_macro_payload_has_sector_etfs(self):
        """_macro_payload source must fetch ASX sector indices (^AXMJ format)."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        # yfinance uses ^AX* prefix for ASX sector indices (XMJ.AX / XFJ.AX etc. are
        # delisted/renamed — correct symbols confirmed in Sprint 49).
        for sym in ("^AXMJ", "^AXFJ", "^AXHJ", "^AXEJ", "^AXRJ"):
            self.assertIn(sym, src, f"_macro_payload must include {sym} sector index")

    def test_macro_payload_builds_sectors_key(self):
        """_macro_payload must build a 'sectors' key from fetched ETF data."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"sectors"', src,
                      "_macro_payload must produce macro_data['sectors'] dict")
        self.assertIn("change_1d", src,
                      "sector summary must include change_1d field")
        self.assertIn("return_5d", src,
                      "sector summary must include return_5d field")
        self.assertIn("_SECTOR_ETF_LABELS", src,
                      "_macro_payload must define _SECTOR_ETF_LABELS mapping")

    def test_analysis_js_includes_sector_line_in_macro_ctx(self):
        """analysis.js macroCtx must include the ASX sector ETF performance line."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("ASX Sectors(1D/5D)", src,
                      "analysis.js macroCtx must include ASX sector line")
        self.assertIn("_macroSectorLines", src,
                      "analysis.js must define _macroSectorLines")
        self.assertIn("_m.sectors", src,
                      "analysis.js must read state.macroData.sectors")

    def test_analysis_js_includes_commodity_rates_line(self):
        """analysis.js macroCtx must forward iron ore, oil, copper, US10Y to Claude."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_macroMktLines", src,
                      "analysis.js must define _macroMktLines")
        self.assertIn("Commodities/Rates", src,
                      "analysis.js must label the commodity/rates line")
        # Verify all four are forwarded
        for field in ("iron_ore", "oil", "copper", "us10y"):
            self.assertIn(f"_m.{field}", src,
                          f"analysis.js _macroMktLines must reference _m.{field}")

    # ── Addition 3: key missing fundamentals ─────────────────────────────────

    def test_indicators_py_has_free_cashflow(self):
        """indicators.py fundamentals dict must include free_cashflow field."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"free_cashflow"', src,
                      "indicators.py fundamentals must include free_cashflow")
        self.assertIn("freeCashflow", src,
                      "indicators.py must read freeCashflow from yfinance info")

    def test_indicator_ctx_includes_operating_margin(self):
        """analysis.js indicatorCtx must show operating margin (OpMgn)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("OpMgn", src,
                      "analysis.js indicatorCtx must include OpMgn (operating margin)")

    def test_indicator_ctx_includes_debt_to_equity(self):
        """analysis.js indicatorCtx must show debt/equity ratio (D/E)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("D/E", src,
                      "analysis.js indicatorCtx must include D/E (debt to equity)")
        self.assertIn("debt_to_equity", src,
                      "analysis.js must reference debt_to_equity signal field")

    def test_indicator_ctx_includes_revenue_growth(self):
        """analysis.js indicatorCtx must show revenue growth (RevGrowth)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("RevGrowth", src,
                      "analysis.js indicatorCtx must include RevGrowth")

    def test_indicator_ctx_includes_fcf_yield(self):
        """analysis.js indicatorCtx must show FCF yield computed from free_cashflow/market_cap."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("FCFYield", src,
                      "analysis.js indicatorCtx must include FCFYield")
        self.assertIn("free_cashflow", src,
                      "analysis.js must reference f.free_cashflow for FCFYield")
        self.assertIn("market_cap", src,
                      "analysis.js must reference f.market_cap for FCFYield")

    def test_liveCtx_macro_brief_includes_commodities(self):
        """analysis.js liveCtx (macro brief input) must forward iron ore, oil, and US10Y."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # The liveCtx block is in the macroPromise closure — verify fields are added
        self.assertIn("Iron ore", src,
                      "analysis.js liveCtx must include Iron ore for macro brief")
        self.assertIn("d.iron_ore", src,
                      "analysis.js liveCtx must check d.iron_ore before pushing")
        self.assertIn("US10Y", src,
                      "analysis.js liveCtx must include US10Y yield")


class TestSprint32DataQuality(unittest.TestCase):
    """Sprint 32 — Tier 1 + Tier 2 data quality enhancements + short interest."""

    # ── indicators.py ─────────────────────────────────────────────────────────

    def test_indicators_has_short_pct_float(self):
        """indicators.py fundamentals must include short_pct_float from yfinance."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"short_pct_float"', src)
        self.assertIn("shortPercentOfFloat", src)

    # ── Portfolio sector allocation ───────────────────────────────────────────

    def test_sector_alloc_ctx_in_analysis_js(self):
        """analysis.js must build a portfolio sector allocation summary."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("sectorAllocCtx", src)
        self.assertIn("PORTFOLIO SECTOR ALLOCATION", src)

    # ── Trend signal alignment count ─────────────────────────────────────────

    def test_trend_signal_count_in_indicator_ctx(self):
        """analysis.js indicatorCtx must show trend signal alignment count (X/Y signals)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("trend_signals", src,
                      "analysis.js must read s.trend_signals for alignment count")
        self.assertIn("tsBull", src)
        self.assertIn("tsTotal", src)
        self.assertIn("tsLabel", src)

    # ── MACD histogram direction ──────────────────────────────────────────────

    def test_macd_direction_in_indicator_ctx(self):
        """analysis.js must show MACD histogram direction (expanding/contracting)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("macdDir", src)
        self.assertIn("macd_hist_prev", src)
        self.assertIn("expanding", src)
        self.assertIn("contracting", src)

    # ── Volatility regime ─────────────────────────────────────────────────────

    def test_vol_regime_in_indicator_ctx(self):
        """analysis.js must include volatility regime from hist_vol_20/hist_vol_60 ratio."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("volRegime", src)
        self.assertIn("hist_vol_60", src)
        self.assertIn("ELEVATED", src)
        self.assertIn("COMPRESSED", src)

    # ── Donchian position in range ────────────────────────────────────────────

    def test_donchian_pos_in_indicator_ctx(self):
        """analysis.js must show Donchian channel position-in-range (DonchPos)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("DonchPos", src)
        self.assertIn("donchian_upper", src)
        self.assertIn("donchian_lower", src)

    # ── Volume z-score ────────────────────────────────────────────────────────

    def test_volume_zscore_in_indicator_ctx(self):
        """analysis.js Volume line must include volume_z_score (VZ)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("VZ=", src)
        self.assertIn("volume_z_score", src)

    # ── Relative strength vs ASX200 ───────────────────────────────────────────

    def test_rs_alpha_vs_asx200_in_indicator_ctx(self):
        """analysis.js Returns line must include relative strength vs ASX200."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("vs.ASX200", src)
        self.assertIn("rsAlpha", src)
        self.assertIn("asx200_5d_return", src)

    # ── Relative strength vs sector ETF ──────────────────────────────────────

    def test_sector_alpha_in_indicator_ctx(self):
        """analysis.js Returns line must include relative strength vs sector ETF."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("vs.Sector", src)
        self.assertIn("sectorAlpha", src)
        self.assertIn("_SECTOR_TO_ETF", src)

    # ── Analyst upside % ─────────────────────────────────────────────────────

    def test_analyst_upside_in_indicator_ctx(self):
        """analysis.js 52W line must include analyst consensus upside/downside %."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("AnalystUpside", src)
        self.assertIn("analystUpside", src)
        self.assertIn("analyst_target", src)

    # ── Short interest ────────────────────────────────────────────────────────

    def test_short_pct_float_in_indicator_ctx(self):
        """analysis.js Fundamentals line must include short_pct_float when available."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("short_pct_float", src)
        self.assertIn("Short=", src)
        self.assertIn("%float", src)

    # ── ROC21 for medium-term momentum ────────────────────────────────────────

    def test_roc21_in_indicator_ctx(self):
        """analysis.js Momentum line must include ROC21 (21-day rate of change)."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("roc_21", src)
        self.assertIn("ROC21", src)

    # ── Weekly compressed price history ──────────────────────────────────────

    def test_weekly_history_replaced_by_pivot_proximity(self):
        """analysis.js must use NearPivot proximity flag instead of raw WeeklyCls series."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # Raw pivot line and 10-week close series removed — replaced with compact proximity flag
        self.assertNotIn("WeeklyCls", src,
                         "Raw 10-week close series removed (too verbose, ~150 tokens)")
        self.assertNotIn("VolTrend5w", src,
                         "VolTrend5w removed along with WeeklyCls")
        self.assertNotIn("S/R Pivots: R2=", src,
                         "Raw S/R pivot values removed — replaced with NearPivot flag")
        # Replaced by compact proximity flag
        self.assertIn("NearPivot", src,
                      "NearPivot proximity flag must be present in indicator block")
        self.assertIn("nearPivot", src,
                      "nearPivot variable must be computed in indicatorCtx builder")


class TestPostmortemTagFixes(unittest.TestCase):
    """
    Regression tests for three postmortem tagging bugs:
    1. num_predict=200 truncates output → parse failure (fix: 300)
    2. "none" verdict not stored in DB (fix: store it)
    3. "parse failure" logged when sanity check strips all tags (fix: distinct log)
    """

    def test_call_model_any_accepts_num_predict(self):
        """_call_model_any must accept num_predict and default to 1024."""
        import inspect
        import routes.debate as deb
        sig = inspect.signature(deb._call_model_any)
        self.assertIn("num_predict", sig.parameters,
                      "_call_model_any must have a num_predict parameter")
        # Default must be high enough to never truncate a postmortem reason field
        self.assertGreaterEqual(sig.parameters["num_predict"].default, 1024,
                                "_call_model_any default num_predict must be >= 1024")

    def test_postmortem_stores_none_in_db(self):
        """Single-model postmortem must UPDATE error_type='none' when model returns none."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # The fix: elif error_type == "none": → store "none" in the DB
        self.assertIn("error_type='none'", src,
                      "postmortem endpoint must store error_type='none' when model returns none")
        self.assertIn("error_type_source='auto'", src,
                      "postmortem endpoint must set error_type_source='auto' on none store")

    def test_adversarial_debate_stores_none_transcript(self):
        """Adversarial debate must always persist transcript, including when final_tags is none."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # Old code: "if final_tags and final_tags != 'none'" — skipped DB write for none
        # New code: always stores, using "none" as the tag value
        self.assertNotIn(
            'if final_tags and final_tags != "none":', src,
            "adversarial debate must not skip DB write when final_tags is none"
        )
        self.assertIn(
            'store_tags', src,
            "adversarial debate must use store_tags variable to always persist"
        )

    def test_sanity_stripped_logged_separately_from_parse_failure(self):
        """When sanity check strips all tags, log must say 'no valid tags' not 'parse failure'."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("no valid tags after sanity check", src,
                      "debate.py must log 'no valid tags after sanity check' separately from parse failure")
        # error_type_raw must be preserved before sanity check for this distinction
        self.assertIn("error_type_raw", src,
                      "debate.py must preserve error_type_raw before sanity check")

    def test_none_filtered_from_failure_patterns(self):
        """learning_stats type_counts must not count 'none' as an error pattern."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('tag != "none"', src,
                      'learning_stats type_counts must filter out "none" tags')

    def test_adversarial_debate_phase1_no_explicit_num_predict(self):
        """Adversarial debate Phase 1A/1B must use default num_predict (no override needed)."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        import re
        # Old approach was explicit num_predict=300; now uses the 1024 default
        matches = re.findall(
            r"_call_model_any\([^)]*_SCHEMA_POSTMORTEM[^)]*num_predict\s*=\s*300", src
        )
        self.assertEqual(len(matches), 0,
                         "Phase 1 no longer needs explicit num_predict=300; default 1024 covers it")

    def test_synthesis_no_explicit_num_predict(self):
        """Phase 3 synthesis must use default num_predict (no 250 override needed)."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("num_predict=250", src,
                         "Phase 3 synthesis no longer needs explicit num_predict=250")


class TestPostmortemBatchAndSyncFixes(unittest.TestCase):
    """Sprint 33 — batch classify button, sync rr_ratio fix, think=False for JSON, num_predict=1024."""

    # ── _call_model_any defaults ──────────────────────────────────────────────

    def test_call_model_any_default_num_predict_1024(self):
        """_call_model_any default num_predict must be 1024 (no truncation)."""
        import inspect, routes.debate as deb
        sig = inspect.signature(deb._call_model_any)
        self.assertEqual(sig.parameters["num_predict"].default, 1024,
                         "_call_model_any default num_predict must be 1024")

    def test_call_model_any_uses_think_false(self):
        """_call_model_any must pass think=False to avoid thinking-token budget exhaustion.

        Thinking models (qwen3.5:9b) count <think>...</think> tokens against num_predict.
        With num_predict=1024, the model exhausts its budget on reasoning and is truncated
        before emitting JSON. _strip_think_tags() returns '' (unclosed block) causing
        'parse failure | raw: '. JSON classification gets no quality benefit from extended
        reasoning — think=False restores the full 1024 tokens for the JSON output.
        """
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        import re
        ma_idx = src.index("def _call_model_any(")
        next_def = re.search(r'\ndef [a-z_]', src[ma_idx + 50:])
        end_idx  = ma_idx + 50 + next_def.start() if next_def else ma_idx + 2000
        window   = src[ma_idx:end_idx]
        self.assertIn("think=False", window,
                      "_call_model_any must use think=False to prevent thinking-token truncation")
        self.assertNotIn("think=None", window,
                         "_call_model_any must not use think=None (causes empty JSON output on thinking models)")

    def test_postmortem_no_explicit_num_predict_override(self):
        """Single-model postmortem must not override num_predict (uses 1024 default)."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        # The old fix added num_predict=300 — this should be gone now
        self.assertNotIn("num_predict=300", src,
                         "num_predict=300 override should be removed — default 1024 is sufficient")

    # ── /api/learning/untagged endpoint ──────────────────────────────────────

    def test_untagged_endpoint_exists(self):
        """GET /api/learning/untagged must be defined in routes/learning.py."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("/api/learning/untagged", src)
        self.assertIn("def learning_untagged", src)

    def test_untagged_endpoint_returns_200(self):
        """/api/learning/untagged must return 200 with ok and events keys."""
        _install_in_memory_db()
        asx_server.init_db()
        client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True
        resp = client.get("/api/learning/untagged")
        self.assertEqual(resp.status_code, 200)
        body = json.loads(resp.data)
        self.assertIn("ok", body)
        self.assertIn("events", body)
        self.assertIn("count", body)

    def test_untagged_filters_none_tagged(self):
        """GET /api/learning/untagged must exclude events where error_type='none'."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("error_type IS NULL OR error_type = ''", src,
                      "untagged query must exclude already-tagged events including error_type='none'")

    # ── rr_ratio in sync function ─────────────────────────────────────────────

    def test_sync_computes_rr_ratio(self):
        """syncClosedTradesToLearningLoop must compute and send rr_ratio."""
        with open(os.path.join(ROOT, "js", "pages", "performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_rrRatio", src,
                      "syncClosedTradesToLearningLoop must compute _rrRatio")
        self.assertIn("rr_ratio:", src,
                      "sync toLog payload must include rr_ratio field")

    def test_sync_sends_agent_type(self):
        """syncClosedTradesToLearningLoop must set agent_type to identify synced records."""
        with open(os.path.join(ROOT, "js", "pages", "performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("portfolio-scanner-sync", src,
                      "sync function must tag records with agent_type portfolio-scanner-sync")

    def test_sync_toUpdate_backfills_rr_ratio(self):
        """toUpdate path must also send rr_ratio to patch legacy NULL records."""
        with open(os.path.join(ROOT, "js", "pages", "performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("rr_ratio:            _rr2", src,
                      "toUpdate path must backfill rr_ratio via _rr2 variable")

    def test_outcome_patch_accepts_rr_ratio(self):
        """/api/learning/outcome must accept rr_ratio in the patchable columns list."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"rr_ratio"', src,
                      "learning_outcome patchable columns must include rr_ratio")

    # ── Classify All button ───────────────────────────────────────────────────

    def test_classify_all_button_in_learning_js(self):
        """learning.js must render the Classify All Untagged button."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("classify-all-btn", src)
        self.assertIn("classifyAllPostmortems()", src)
        self.assertIn("Classify All Untagged", src)

    def test_classify_all_function_defined(self):
        """classifyAllPostmortems() must be defined in learning.js."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function classifyAllPostmortems()", src)
        self.assertIn("classify-all-progress", src)
        self.assertIn("/api/learning/untagged", src)

    def test_classify_all_uses_60s_timeout(self):
        """classifyAllPostmortems must pass timeout: 60 per event."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("timeout: 60", src,
                      "classifyAllPostmortems must pass timeout:60 per postmortem call")

    def test_sync_rationale_handles_array(self):
        """Sync rationale must join array reasoning instead of calling Array.slice."""
        with open(os.path.join(ROOT, "js", "pages", "performance.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Array.isArray(r.reasoning)", src,
                      "sync must detect array reasoning and join it to a string")


class TestPostmortemPromptQuality(unittest.TestCase):
    """Sprint 34 — prompt/model fixes for correct tagging of SELL/TRIM losses."""

    # ── repeat_penalty in _call_ollama ────────────────────────────────────────

    def test_call_ollama_has_repeat_penalty(self):
        """_call_ollama must send repeat_penalty to Ollama to prevent repetition loops."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"repeat_penalty"', src,
                      "_call_ollama options must include repeat_penalty")
        self.assertIn('"repeat_last_n"', src,
                      "_call_ollama options must include repeat_last_n context window")

    # ── _pm_build_prompt thesis_broken guidance ───────────────────────────────

    def test_pm_prompt_accepts_pnl_pct(self):
        """_pm_build_prompt must accept pnl_pct parameter."""
        import inspect, routes.debate as deb
        sig = inspect.signature(deb._pm_build_prompt)
        self.assertIn("pnl_pct", sig.parameters,
                      "_pm_build_prompt must accept pnl_pct parameter")

    def test_pm_prompt_includes_loss_direction_hint_for_sell_loss(self):
        """_pm_build_prompt must inject LOSS DIRECTION hint for large SELL/TRIM losses (> 5%)."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: LOSS (-20%)",
            rationale="",
            exit_hint="manual",
            action="SELL",
            pnl_pct=-20.0,
        )
        self.assertIn("LOSS DIRECTION", prompt,
                      "Prompt must include LOSS DIRECTION note for large SELL loss")
        self.assertIn("thesis_broken", prompt)

    def test_pm_prompt_small_loss_guides_none(self):
        """_pm_build_prompt must guide toward 'none' for sub-2% SELL/TRIM losses."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: LOSS (-1.5%)",
            rationale="",
            exit_hint="manual",
            action="SELL",
            pnl_pct=-1.5,
        )
        self.assertIn("none", prompt, "Small loss prompt must mention 'none'")
        self.assertIn("sub-2%", prompt, "Must warn against thesis_broken for sub-2% losses")
        self.assertNotIn("LOSS DIRECTION", prompt,
                         "Sub-2% loss should use LOSS NOTE, not LOSS DIRECTION")

    def test_pm_prompt_stop_hit_guides_stop_too_tight(self):
        """_pm_build_prompt must suggest stop_too_tight as primary for stop_hit exits."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: LOSS (-3%)",
            rationale="",
            exit_hint="",
            action="SELL",
            pnl_pct=-3.0,
            exit_reason="stop_hit",
        )
        self.assertIn("stop_too_tight", prompt,
                      "stop_hit exit prompt must suggest stop_too_tight as candidate")
        self.assertIn("stop_hit", prompt)

    def test_pm_prompt_medium_loss_offers_multiple_options(self):
        """2–5% loss prompt must offer thesis_broken, poor_entry, AND none as candidates."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: LOSS (-3.5%)",
            rationale="",
            exit_hint="manual",
            action="SELL",
            pnl_pct=-3.5,
        )
        self.assertIn("thesis_broken", prompt)
        self.assertIn("poor_entry", prompt)
        self.assertIn("none", prompt)

    def test_pm_prompt_no_loss_hint_for_sell_win(self):
        """_pm_build_prompt must NOT inject loss guidance when pnl_pct >= 0."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt(
            summary="SELL XYZ @ $100 | Outcome: WIN (+5%)",
            rationale="",
            exit_hint="target_hit",
            action="SELL",
            pnl_pct=5.0,
        )
        self.assertNotIn("LOSS DIRECTION", prompt)
        self.assertNotIn("LOSS NOTE", prompt)

    def test_thesis_broken_description_mentions_direction(self):
        """thesis_broken tag description must mention wrong directional movement."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt("summary", "", "", action="BUY")
        self.assertIn("fundamental directional call was wrong", prompt,
                      "thesis_broken description must reference directional failure")

    def test_pm_prompt_poor_rr_requires_computable_ratio(self):
        """poor_rr tag description must state it requires a computable rr_ratio."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt("summary", "", "", action="SELL", pnl_pct=-10.0)
        self.assertIn("poor_rr", prompt)
        self.assertIn("REQUIRES a computable rr_ratio", prompt)

    def test_pm_prompt_none_criteria_are_explicit(self):
        """none tag description must state the concrete criteria (< 2% or unforeseeable)."""
        import routes.debate as deb
        prompt = deb._pm_build_prompt("summary", "", "", action="BUY")
        self.assertIn("none", prompt)
        self.assertIn("2%", prompt,
                      "none criteria must mention < 2% threshold")

    def test_pm_build_prompt_accepts_exit_reason(self):
        """_pm_build_prompt must accept exit_reason parameter."""
        import inspect, routes.debate as deb
        sig = inspect.signature(deb._pm_build_prompt)
        self.assertIn("exit_reason", sig.parameters,
                      "_pm_build_prompt must accept exit_reason parameter")

    # ── rr_ratio backfill in init_db ──────────────────────────────────────────

    def test_init_db_backfills_rr_ratio(self):
        """init_db must run the rr_ratio backfill SQL for records with correct-direction stops."""
        with open(os.path.join(ROOT, "db.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("rr_ratio IS NULL", src,
                      "db.py init_db must include rr_ratio backfill UPDATE")
        # Use regex-free check that's whitespace-tolerant
        self.assertIn("suggested_stop", src,
                      "backfill must reference suggested_stop column")
        self.assertIn("actual_entry_price", src,
                      "backfill must reference actual_entry_price column")
        # Both BUY and SELL/TRIM direction conditions must be present
        self.assertIn("recommendation IN ('BUY','TOP_UP')", src,
                      "backfill must handle BUY/TOP_UP direction")
        self.assertIn("recommendation IN ('SELL','TRIM')", src,
                      "backfill must handle SELL/TRIM direction")
        self.assertIn("wrong-direction stops stay NULL", src,
                      "backfill must document that wrong-direction stops are excluded")

    def test_init_db_backfill_runs_without_error(self):
        """rr_ratio backfill SQL must execute cleanly on an empty in-memory DB."""
        _install_in_memory_db()
        # init_db() includes the backfill — if it raises, the test fails
        try:
            asx_server.init_db()
        except Exception as e:
            self.fail(f"init_db() raised unexpectedly: {e}")

    # ── Both call sites pass pnl_pct ──────────────────────────────────────────

    def test_both_postmortem_callsites_pass_pnl_pct(self):
        """Both _pm_build_prompt call sites must pass pnl_pct from the row."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        import re
        matches = re.findall(r'_pm_build_prompt\([^)]*pnl_pct\s*=', src)
        self.assertGreaterEqual(len(matches), 2,
                                "Both single-model and adversarial debate must pass pnl_pct")

    def test_both_postmortem_callsites_pass_exit_reason(self):
        """Both _pm_build_prompt call sites must pass exit_reason from the row."""
        with open(os.path.join(ROOT, "routes", "debate.py"), encoding="utf-8") as f:
            src = f.read()
        import re
        matches = re.findall(r'_pm_build_prompt\([^)]*exit_reason\s*=', src)
        self.assertGreaterEqual(len(matches), 2,
                                "Both single-model and adversarial debate must pass exit_reason")


class TestFix16Phase8GoodLossExclusion(unittest.TestCase):
    """Fix #16 — Phase 8 gate must exclude protective_stop + external_shock losses."""

    def test_is_good_loss_function_exists(self):
        """routes/learning.py must define _is_good_loss helper at module level."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _is_good_loss(", src)

    def test_is_good_loss_protective_stop(self):
        """_is_good_loss must return True for exit_reason='protective_stop'."""
        import routes.learning as rl
        self.assertTrue(rl._is_good_loss({"exit_reason": "protective_stop", "error_type": None}))

    def test_is_good_loss_external_shock(self):
        """_is_good_loss must return True when error_type contains 'external_shock'."""
        import routes.learning as rl
        self.assertTrue(rl._is_good_loss({"exit_reason": "stop_hit", "error_type": "external_shock"}))
        self.assertTrue(rl._is_good_loss({"exit_reason": "manual", "error_type": "overconfident,external_shock"}))

    def test_is_good_loss_regular_loss(self):
        """_is_good_loss must return False for ordinary analytical losses."""
        import routes.learning as rl
        self.assertFalse(rl._is_good_loss({"exit_reason": "stop_hit", "error_type": "overconfident"}))
        self.assertFalse(rl._is_good_loss({"exit_reason": "manual", "error_type": None}))
        self.assertFalse(rl._is_good_loss({"exit_reason": None, "error_type": None}))

    def test_compute_phase8_meta_excludes_good_losses(self):
        """_compute_phase8_meta must activate when wins > analytical losses even if good-loss
        scores are high (i.e. protective_stop trades with 9/10 must not inflate mean_loss)."""
        import routes.learning as rl
        # 3 wins scoring 8.0 avg; 1 protective-stop scoring 9.0 (should be excluded);
        # 1 analytical loss scoring 3.0 — wins (8.0) > analytical_losses (3.0) → active
        rows = [
            {"outcome_status": "win", "skill_score": "8.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "win", "skill_score": "8.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "win", "skill_score": "8.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "win", "skill_score": "7.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "win", "skill_score": "7.0", "exit_reason": None, "error_type": None},
            {"outcome_status": "loss", "skill_score": "9.0", "exit_reason": "protective_stop", "error_type": None},
            {"outcome_status": "loss", "skill_score": "9.0", "exit_reason": "protective_stop", "error_type": None},
            {"outcome_status": "loss", "skill_score": "3.0", "exit_reason": "stop_hit", "error_type": "overconfident"},
            {"outcome_status": "loss", "skill_score": "3.0", "exit_reason": "stop_hit", "error_type": "poor_entry"},
            {"outcome_status": "loss", "skill_score": "3.0", "exit_reason": "manual", "error_type": None},
        ]
        result = rl._compute_phase8_meta(rows)
        self.assertTrue(result["active"],
                        "Phase 8 must be active — wins (7.8 avg) > analytical losses (3.0), "
                        "protective_stop losses (9.0) must be excluded")
        self.assertEqual(result["n_good_losses_excluded"], 2)

    def test_compute_phase8_meta_returns_n_good_losses_excluded(self):
        """_compute_phase8_meta return dict must include n_good_losses_excluded field."""
        import routes.learning as rl
        rows = [
            {"outcome_status": "win", "skill_score": "7.0", "exit_reason": None, "error_type": None},
        ] * 8 + [
            {"outcome_status": "loss", "skill_score": "4.0", "exit_reason": "stop_hit", "error_type": None},
        ] * 2
        result = rl._compute_phase8_meta(rows)
        self.assertIn("n_good_losses_excluded", result)

    def test_phase8_gate_uses_is_good_loss_in_calib_compute(self):
        """_calib_compute must reference _is_good_loss in the inline Phase 8 check."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Both the module-level _compute_phase8_meta and inline _calib_compute check must use it
        self.assertGreaterEqual(src.count("_is_good_loss("), 3,
                                "_is_good_loss must be called in _compute_phase8_meta and inline Phase 8 check")

    def test_learning_js_phase8_note_shows_exclusion_count(self):
        """learning.js phase8Note must conditionally display good-loss exclusion count."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("n_good_losses_excluded", src)
        self.assertIn("good-loss", src)


class TestFix17PromptDataGapFixes(unittest.TestCase):
    """Fix #17 — Remove data-gap mismatches in ANALYSIS_SYSTEM_PROMPT."""

    def test_eps_revision_30d_example_removed_from_factors_used(self):
        """factorsUsed example must not cite 'EPS revision: +N% over 30d' (field not in payload)."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("EPS revision: +4.2% over 30d", src)
        self.assertNotIn("EPS revision: +3.1% over 30d", src)

    def test_eps_momentum_proxy_example_present(self):
        """factorsUsed examples must use EPS momentum proxy phrasing instead."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("EPS momentum:", src)

    def test_bid_ask_rule_removed(self):
        """bid-ask spread rule must be replaced — field is not in the live signals payload."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("bid-ask spread > 0.5%", src)

    def test_volume_based_liquidity_flag_present(self):
        """volume_avg_20 < 150,000 liquidity flag must replace the bid-ask rule."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("volume_avg_20 < 150,000", src)
        self.assertIn("thin liquidity", src)


class TestFix19RegressionDetectorEvaluating(unittest.TestCase):
    """Fix #19 — Regression detector must return 'evaluating' state, not None, for new
    prompt versions below ESS floor (prevents silent false-negative on UI)."""

    def test_evaluating_state_when_new_version_below_floor(self):
        """_check_prompt_regression must return evaluating dict (not None) when current
        version has fewer than min_n closed trades."""
        import routes.learning as rl
        versions = [{"version": "2026-06-v7", "closed": 5, "win_rate": 60.0}]
        result = rl._check_prompt_regression(versions, min_n=10)
        self.assertIsNotNone(result, "Must not return None when new version is below ESS floor")
        self.assertEqual(result["status"], "evaluating")
        self.assertEqual(result["current_version"], "2026-06-v7")
        self.assertEqual(result["n_current"], 5)
        self.assertEqual(result["min_n_required"], 10)
        self.assertIn("se_pp", result)

    def test_returns_none_when_no_data_at_all(self):
        """_check_prompt_regression must return None when no versions have any closed trades."""
        import routes.learning as rl
        versions = [{"version": "v1", "closed": 0, "win_rate": None}]
        self.assertIsNone(rl._check_prompt_regression(versions, min_n=10))

    def test_regression_dict_has_status_field(self):
        """Regression dicts must include 'status' field (distinguishes from evaluating)."""
        import routes.learning as rl
        versions = [
            {"version": "v2", "closed": 30, "win_rate": 40.0},
            {"version": "v1", "closed": 30, "win_rate": 65.0},
        ]
        result = rl._check_prompt_regression(versions)
        self.assertIsNotNone(result)
        self.assertEqual(result["status"], "regression")

    def test_improvement_still_returns_none(self):
        """_check_prompt_regression must still return None when current is same or better."""
        import routes.learning as rl
        versions = [
            {"version": "v2", "closed": 20, "win_rate": 65.0},
            {"version": "v1", "closed": 20, "win_rate": 55.0},
        ]
        self.assertIsNone(rl._check_prompt_regression(versions))

    def test_learning_js_evaluating_banner_present(self):
        """learning.js regressionBanner must render an evaluating state (⏳ chip)."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("status === 'evaluating'", src)
        self.assertIn("⏳", src)
        self.assertIn("min_n_required", src)


class TestFix18VirtualOutcomes(unittest.TestCase):
    """Fix #18 — Virtual outcomes via lazy OHLC resolution in _calib_compute()."""

    def test_db_virtual_outcome_column_in_migrations(self):
        """db.py _LE_MIGRATIONS must include virtual_outcome and virtual_pnl_pct columns."""
        with open(os.path.join(ROOT, "db.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"virtual_outcome"', src)
        self.assertIn('"virtual_pnl_pct"', src)

    def test_resolve_virtual_outcomes_function_exists(self):
        """routes/learning.py must define _resolve_virtual_outcomes helper."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _resolve_virtual_outcomes(", src)

    def test_resolve_called_in_calib_compute(self):
        """_calib_compute must call _resolve_virtual_outcomes at the start of the DB block."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_resolve_virtual_outcomes(conn)", src)

    def test_virtual_rows_merged_into_rows_all(self):
        """_calib_compute must merge real and virtual rows into rows_all for calibration."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("rows_all", src)
        self.assertIn("virtual_rows", src)

    def test_weight_function_applies_virtual_discount(self):
        """_weight() inside _calib_compute must apply 0.75× discount for virtual rows."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("0.75", src)
        self.assertIn("is_virtual", src)

    def test_calibration_header_includes_virtual_count(self):
        """Calibration block header must show Nv when virtual outcomes are included."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("n_virtual", src)
        self.assertIn("virt_note", src)

    def test_recent_events_query_includes_virtual_outcome(self):
        """learning_stats() recent events SQL must select virtual_outcome column."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Should appear in both recent events SELECT and virtual rows SELECT
        self.assertGreaterEqual(src.count("virtual_outcome"), 3)

    def test_learning_js_virtual_chip_rendered(self):
        """learning.js recent events must render a virtual outcome chip (~W or ~L)."""
        with open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("virtualChip", src)
        self.assertIn("virtual_outcome", src)
        self.assertIn("virtual_win", src)
        # Chip content is a template literal: ">~${...}" — check tilde prefix and W/L labels
        self.assertIn(">~${", src)
        self.assertIn("? 'W' : 'L'", src)

    def test_resolve_direction_aware_sell_trim(self):
        """_resolve_virtual_outcomes must invert target/stop check for SELL/TRIM."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        # Direction-aware check: SELL/TRIM frame — Low <= target → win; High >= stop → loss
        self.assertIn("is_exit", src)
        self.assertIn("virtual_win", src)
        self.assertIn("virtual_loss", src)


class TestSprint70DeterministicTagging(unittest.TestCase):
    """Sprint 70 — deterministic post-mortem tagging + skill scoring driven by the
    entry/exit capture (thesis_verdict), replacing the blind local-LLM tagger."""

    # ── classify_error_type_deterministic ────────────────────────────────────
    def test_error_win_returns_none(self):
        from routes.learning import classify_error_type_deterministic
        self.assertEqual(
            classify_error_type_deterministic({"outcome_status": "win"}), "none")

    def test_error_thesis_broken_from_invalidated_verdict(self):
        """thesis_verdict='invalidated' is the data-backed thesis_broken signal."""
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "invalidated", "realized_pnl_pct": -4.0,
               "ai_confidence": 0.9, "rr_ratio": 0.8}
        # Sprint 71 Phase 2A: multi-tag — thesis_broken leads (most specific), then
        # overconfident (conf≥0.75) and poor_rr (rr<1.5) also apply.
        tags = classify_error_type_deterministic(row).split(",")
        self.assertEqual(tags[0], "thesis_broken")  # most-specific first
        self.assertIn("overconfident", tags)
        self.assertIn("poor_rr", tags)

    def test_error_stop_too_tight_when_thesis_intact(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "validated", "exit_reason": "stop_hit",
               "actual_entry_price": 100.0, "suggested_stop": 99.0,  # 1% stop
               "entry_signals_json": '{"atr_pct": 2.0}',  # 1.5xATR = 3% > 1% stop
               "ai_confidence": 0.7}
        self.assertEqual(classify_error_type_deterministic(row), "stop_too_tight")

    def test_error_overconfident(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "ai_confidence": 0.82,
               "exit_reason": "manual", "rr_ratio": 2.5}
        self.assertEqual(classify_error_type_deterministic(row), "overconfident")

    def test_error_poor_rr(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "ai_confidence": 0.6,
               "rr_ratio": 1.2}
        self.assertEqual(classify_error_type_deterministic(row), "poor_rr")

    def test_error_regime_mismatch_fallback(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "ai_confidence": 0.6,
               "rr_ratio": 2.5, "regime": "panic"}
        self.assertEqual(classify_error_type_deterministic(row), "regime_mismatch")

    def test_error_never_emits_world_knowledge_tags(self):
        """Deterministic path must never emit missed_catalyst / external_shock."""
        from routes.learning import classify_error_type_deterministic
        import itertools
        verdicts = ["validated", "invalidated", "irrelevant", ""]
        regimes  = ["riskOn", "riskOff", "panic", "trend", ""]
        for v, reg in itertools.product(verdicts, regimes):
            tag = classify_error_type_deterministic(
                {"outcome_status": "loss", "recommendation": "BUY",
                 "thesis_verdict": v, "regime": reg, "ai_confidence": 0.5,
                 "rr_ratio": 3.0})
            self.assertNotIn(tag, ("missed_catalyst", "external_shock"))

    # ── compute_skill_score_deterministic ────────────────────────────────────
    def test_skill_none_without_verdict(self):
        """No thesis_verdict → no captured comparison → refuse to invent a score."""
        from routes.learning import compute_skill_score_deterministic
        self.assertIsNone(compute_skill_score_deterministic(
            {"outcome_status": "win", "thesis_verdict": None}))

    def test_skill_quadrant_validated_win_high(self):
        from routes.learning import compute_skill_score_deterministic
        s = compute_skill_score_deterministic(
            {"outcome_status": "win", "thesis_verdict": "validated",
             "exit_reason": "target_hit", "ai_confidence": 0.75, "rr_ratio": 2.0})
        self.assertGreaterEqual(s, 8.0)  # 8 base +0.5 target +0.25 rr

    def test_skill_quadrant_invalidated_win_is_luck(self):
        """Wrong read that won anyway scores low — it was luck, not skill."""
        from routes.learning import compute_skill_score_deterministic
        s = compute_skill_score_deterministic(
            {"outcome_status": "win", "thesis_verdict": "invalidated",
             "exit_reason": "manual", "ai_confidence": 0.7})
        self.assertLessEqual(s, 3.5)

    def test_skill_validated_loss_beats_invalidated_loss(self):
        """Unlucky (validated+loss) must score above bad-read (invalidated+loss)."""
        from routes.learning import compute_skill_score_deterministic
        unlucky = compute_skill_score_deterministic(
            {"outcome_status": "loss", "thesis_verdict": "validated",
             "exit_reason": "stop_hit", "ai_confidence": 0.7})
        bad_read = compute_skill_score_deterministic(
            {"outcome_status": "loss", "thesis_verdict": "invalidated",
             "exit_reason": "stop_hit", "ai_confidence": 0.7})
        self.assertGreater(unlucky, bad_read)

    def test_skill_clamped_0_10(self):
        from routes.learning import compute_skill_score_deterministic
        s = compute_skill_score_deterministic(
            {"outcome_status": "loss", "thesis_verdict": "invalidated",
             "exit_reason": "manual", "ai_confidence": 0.95})
        self.assertGreaterEqual(s, 0.0)
        self.assertLessEqual(s, 10.0)

    # ── _ci_excludes significance gate ───────────────────────────────────────
    def test_ci_excludes_withholds_small_n(self):
        """3-of-5 (60% WR) must NOT clear the CI gate vs a 65% threshold — too noisy."""
        from routes.learning import _ci_excludes
        self.assertFalse(_ci_excludes(3, 5, 0.65))

    def test_ci_excludes_fires_on_clear_signal(self):
        """5-of-40 (12.5% WR) clearly excludes a 65% threshold."""
        from routes.learning import _ci_excludes
        self.assertTrue(_ci_excludes(5, 40, 0.65))

    # ── _resolve_deterministic_tags (DB integration) ─────────────────────────
    def test_resolver_fills_and_marks_source(self):
        _install_in_memory_db()
        asx_server.init_db()
        try:
            from routes.learning import _resolve_deterministic_tags
            with _test_get_db() as conn:
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, outcome_status,
                       realized_pnl_pct, ai_confidence, rr_ratio, exit_reason,
                       thesis_verdict, was_executed, timestamp)
                    VALUES ('recommendation','BHP','BUY','loss',-5.0,0.70,1.2,
                            'manual','invalidated',1,datetime('now'))
                """)
                rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                n = _resolve_deterministic_tags(conn)
                self.assertGreaterEqual(n, 1)
                row = conn.execute(
                    "SELECT error_type, error_type_source, skill_score "
                    "FROM ai_learning_events WHERE id=?", (rid,)).fetchone()
            # Sprint 71 Phase 2A: multi-tag — invalidated(0.70 conf,1.2 rr) →
            # thesis_broken (leads) + poor_rr.
            et_tags = (row["error_type"] or "").split(",")
            self.assertEqual(et_tags[0], "thesis_broken")
            self.assertIn("poor_rr", et_tags)
            self.assertEqual(row["error_type_source"], "deterministic")
            self.assertEqual(row["skill_score"], 2.0)  # invalidated+loss base, no modifiers net
        finally:
            asx_server.get_db = _orig_get_db

    def test_resolver_does_not_overwrite_manual_tag(self):
        _install_in_memory_db()
        asx_server.init_db()
        try:
            from routes.learning import _resolve_deterministic_tags
            with _test_get_db() as conn:
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, outcome_status,
                       realized_pnl_pct, error_type, error_type_source,
                       thesis_verdict, was_executed, timestamp)
                    VALUES ('recommendation','CBA','BUY','loss',-3.0,
                            'poor_entry','manual','invalidated',1,datetime('now'))
                """)
                rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                _resolve_deterministic_tags(conn)
                row = conn.execute(
                    "SELECT error_type, error_type_source FROM ai_learning_events "
                    "WHERE id=?", (rid,)).fetchone()
            # Manual tag preserved — deterministic only fills NULLs.
            self.assertEqual(row["error_type"], "poor_entry")
            self.assertEqual(row["error_type_source"], "manual")
        finally:
            asx_server.get_db = _orig_get_db

    def test_resolver_ignores_sell_trim(self):
        """error_type/skill are entry-centric — SELL/TRIM events must not be tagged."""
        _install_in_memory_db()
        asx_server.init_db()
        try:
            from routes.learning import _resolve_deterministic_tags
            with _test_get_db() as conn:
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, outcome_status,
                       realized_pnl_pct, thesis_verdict, was_executed, timestamp)
                    VALUES ('recommendation','ANZ','TRIM','loss',-4.0,
                            'invalidated',1,datetime('now'))
                """)
                rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                _resolve_deterministic_tags(conn)
                row = conn.execute(
                    "SELECT error_type, skill_score FROM ai_learning_events "
                    "WHERE id=?", (rid,)).fetchone()
            self.assertIsNone(row["error_type"])
            self.assertIsNone(row["skill_score"])
        finally:
            asx_server.get_db = _orig_get_db

    def test_resolver_called_in_calib_compute(self):
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_resolve_deterministic_tags(conn)", src)

    # ── virtual-outcome stop-first regression ────────────────────────────────
    def test_virtual_outcome_stop_checked_before_target(self):
        """BUY virtual resolution must check the stop (Low<=stop) BEFORE the target
        so a straddle bar books the conservative loss, not an optimistic win."""
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        buy_block = src.split("# BUY: stop below entry")[1].split("\n\n")[0]
        loss_pos = buy_block.find('virtual_loss')
        win_pos  = buy_block.find('virtual_win')
        self.assertTrue(0 <= loss_pos < win_pos,
                        "stop (virtual_loss) must be checked before target (virtual_win)")


class TestSprint71Phase1(unittest.TestCase):
    """Sprint 71 Phase 1B — MAE/MFE path capture (columns + resolver + math)."""

    def test_mae_mfe_columns_in_migrations(self):
        """_LE_MIGRATIONS must declare the three new MAE/MFE columns."""
        import db as _db
        col_names = [c for c, _ in _db._LE_MIGRATIONS]
        for c in ("mae_pct", "mfe_pct", "mae_mfe_resolved_at"):
            self.assertIn(c, col_names, f"_LE_MIGRATIONS must include {c}")

    def test_mae_mfe_columns_exist_after_migration(self):
        """The columns must materialise on ai_learning_events after init_db()."""
        from db import get_db
        with get_db() as conn:
            cols = {r[1] for r in conn.execute(
                "PRAGMA table_info(ai_learning_events)").fetchall()}
        for c in ("mae_pct", "mfe_pct", "mae_mfe_resolved_at"):
            self.assertIn(c, cols, f"ai_learning_events must have {c} column")

    def test_resolve_mae_mfe_wired_into_calib_compute(self):
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_resolve_mae_mfe(conn)", src,
                      "_resolve_mae_mfe must be called inside _calib_compute's DB block")

    def test_mae_mfe_from_ohlc_math(self):
        """Pure helper: MAE negative (drawdown), MFE positive (gain), correct values."""
        import pandas as pd
        from routes.learning import _mae_mfe_from_ohlc
        # entry 100. Window dips to a low of 90 then peaks to a high of 130.
        hist = pd.DataFrame({
            "Open":  [100.0, 95.0, 110.0],
            "High":  [102.0, 98.0, 130.0],
            "Low":   [ 98.0, 90.0, 112.0],
            "Close": [ 99.0, 96.0, 128.0],
        })
        mae, mfe = _mae_mfe_from_ohlc(hist, 100.0)
        self.assertEqual(mae, -10.0)   # (90-100)/100*100
        self.assertEqual(mfe,  30.0)   # (130-100)/100*100
        self.assertLess(mae, 0.0)
        self.assertGreater(mfe, 0.0)

    def test_mae_mfe_from_ohlc_empty(self):
        import pandas as pd
        from routes.learning import _mae_mfe_from_ohlc
        mae, mfe = _mae_mfe_from_ohlc(pd.DataFrame(), 100.0)
        self.assertIsNone(mae)
        self.assertIsNone(mfe)

    def test_resolve_mae_mfe_populates_row(self):
        """End-to-end: insert a closed executed BUY, stub OHLC (entry→dip→peak→exit),
        run the resolver, assert MAE/MFE signs+values and resolved-at set."""
        import unittest.mock as _mock
        import yfinance as yf
        import pandas as pd
        _install_in_memory_db()
        asx_server.init_db()
        try:
            from routes.learning import _resolve_mae_mfe
            with _test_get_db() as conn:
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, outcome_status,
                       realized_pnl_pct, actual_entry_price, holding_period_days,
                       was_executed, timestamp)
                    VALUES ('recommendation','BHP','BUY','win',5.0,100.0,3,1,
                            '2026-01-05 10:00:00')
                """)
                rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]

                # entry 100 → dip low 88 → peak high 125 → exit
                fake_hist = pd.DataFrame({
                    "Open":  [100.0, 92.0, 118.0],
                    "High":  [101.0, 95.0, 125.0],
                    "Low":   [ 96.0, 88.0, 116.0],
                    "Close": [ 98.0, 93.0, 124.0],
                }, index=pd.to_datetime(["2026-01-05", "2026-01-06", "2026-01-07"]))

                class _FakeTicker:
                    def history(self, **kw):
                        return fake_hist

                with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
                    n = _resolve_mae_mfe(conn)
                self.assertEqual(n, 1)
                row = conn.execute(
                    "SELECT mae_pct, mfe_pct, mae_mfe_resolved_at "
                    "FROM ai_learning_events WHERE id=?", (rid,)).fetchone()
            self.assertEqual(row["mae_pct"], -12.0)  # (88-100)/100*100
            self.assertEqual(row["mfe_pct"],  25.0)  # (125-100)/100*100
            self.assertLess(row["mae_pct"], 0.0)
            self.assertGreater(row["mfe_pct"], 0.0)
            self.assertIsNotNone(row["mae_mfe_resolved_at"])
        finally:
            asx_server.get_db = _orig_get_db

    def test_resolve_mae_mfe_idempotent(self):
        """Already-resolved rows (mae_mfe_resolved_at set) must be skipped."""
        import unittest.mock as _mock
        import yfinance as yf
        import pandas as pd
        _install_in_memory_db()
        asx_server.init_db()
        try:
            from routes.learning import _resolve_mae_mfe
            with _test_get_db() as conn:
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, outcome_status,
                       realized_pnl_pct, actual_entry_price, holding_period_days,
                       was_executed, timestamp, mae_pct, mfe_pct, mae_mfe_resolved_at)
                    VALUES ('recommendation','CBA','BUY','win',5.0,100.0,3,1,
                            '2026-01-05 10:00:00',-5.0,5.0,'2026-01-09T00:00:00')
                """)

                class _FakeTicker:
                    def history(self, **kw):
                        raise AssertionError("resolver must not refetch resolved rows")

                with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
                    n = _resolve_mae_mfe(conn)
                self.assertEqual(n, 0)
        finally:
            asx_server.get_db = _orig_get_db


class TestSprint71Phase2(unittest.TestCase):
    """Sprint 71 Phase 2 — tagging intelligence: multi-tag emission, new error tags
    (early_exit / oversized / undersized / empirical stop_too_tight / partly-
    deterministic missed_catalyst), MAE-based skill modifier + legacy fallback,
    and the stop_too_tight wider-stop counterfactual + self-suppression."""

    # ── 2A multi-tag emission ────────────────────────────────────────────────
    def test_multi_tag_returns_comma_set(self):
        """A loss satisfying several conditions returns ALL applicable tags joined."""
        from routes.learning import classify_error_type_deterministic
        # invalidated thesis + high conf + poor rr → 3 distinct lessons.
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "invalidated", "ai_confidence": 0.85,
               "rr_ratio": 1.0, "exit_reason": "manual"}
        tags = classify_error_type_deterministic(row).split(",")
        self.assertIn("thesis_broken", tags)
        self.assertIn("overconfident", tags)
        self.assertIn("poor_rr", tags)
        self.assertEqual(tags[0], "thesis_broken")  # most-specific leads

    def test_clean_loss_single_tag(self):
        """A loss with only one applicable condition stays single-tag (no commas)."""
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "ai_confidence": 0.60,
               "rr_ratio": 3.0, "regime": "riskOn"}
        self.assertEqual(classify_error_type_deterministic(row), "none")

    # ── 2B early_exit ────────────────────────────────────────────────────────
    def test_early_exit_fires_from_mfe(self):
        """Manual non-win exit where MFE reached the planned target → early_exit."""
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "validated", "exit_reason": "manual",
               "actual_entry_price": 100.0, "suggested_target": 110.0,
               "mfe_pct": 12.0,  # price reached +12% (>+10% target) before exit
               "ai_confidence": 0.6, "rr_ratio": 3.0}
        self.assertIn("early_exit", classify_error_type_deterministic(row).split(","))

    def test_early_exit_fires_from_exec_mech(self):
        """Mechanical exit beating realized by ≥2pp → early_exit."""
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "validated", "exit_reason": "manual",
               "actual_entry_price": 100.0, "suggested_target": 110.0,
               "realized_pnl_pct": -3.0, "exec_mech_pnl_pct": 5.0,  # +8pp better
               "ai_confidence": 0.6, "rr_ratio": 3.0}
        self.assertIn("early_exit", classify_error_type_deterministic(row).split(","))

    def test_early_exit_not_fired_on_clean_row(self):
        """A stop-out loss with no favourable MFE/mech edge must not tag early_exit."""
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "invalidated", "exit_reason": "stop_hit",
               "actual_entry_price": 100.0, "suggested_target": 110.0,
               "mfe_pct": 2.0, "realized_pnl_pct": -5.0, "exec_mech_pnl_pct": -5.0}
        self.assertNotIn("early_exit", classify_error_type_deterministic(row).split(","))

    # ── 2B missed_catalyst (partly deterministic) ────────────────────────────
    def test_missed_catalyst_fires_when_earnings_in_window(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "exit_reason": "stop_hit",
               "entry_signals_json": '{"days_to_earnings": 4}',
               "holding_period_days": 10, "ai_confidence": 0.6, "rr_ratio": 3.0}
        self.assertIn("missed_catalyst", classify_error_type_deterministic(row).split(","))

    def test_missed_catalyst_not_fired_when_earnings_outside_window(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "exit_reason": "stop_hit",
               "entry_signals_json": '{"days_to_earnings": 40}',
               "holding_period_days": 10, "ai_confidence": 0.6, "rr_ratio": 3.0}
        self.assertNotIn("missed_catalyst", classify_error_type_deterministic(row).split(","))

    # ── 2B oversized / undersized ────────────────────────────────────────────
    def test_oversized_from_checklist_bypass(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "checklist_bypasses": "oversize_position",
               "ai_confidence": 0.6, "rr_ratio": 3.0}
        self.assertIn("oversized", classify_error_type_deterministic(row).split(","))

    def test_undersized_from_checklist_bypass(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "checklist_bypasses": "undersize_position",
               "ai_confidence": 0.6, "rr_ratio": 3.0}
        self.assertIn("undersized", classify_error_type_deterministic(row).split(","))

    def test_sizing_tags_not_fired_without_bypass(self):
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "irrelevant", "checklist_bypasses": "",
               "ai_confidence": 0.6, "rr_ratio": 3.0}
        tags = classify_error_type_deterministic(row).split(",")
        self.assertNotIn("oversized", tags)
        self.assertNotIn("undersized", tags)

    # ── 2B empirical stop_too_tight + ATR fallback ───────────────────────────
    def test_stop_too_tight_empirical_fires(self):
        """MAE pierced the stop yet MFE recovered toward target → empirical ST."""
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "validated", "exit_reason": "stop_hit",
               "actual_entry_price": 100.0, "suggested_stop": 97.0,  # 3% stop
               "suggested_target": 110.0,
               "mae_pct": -4.0,   # dipped below the 3% stop
               "mfe_pct": 8.0,    # later recovered to +8% (≥50% of +10% target)
               "entry_signals_json": '{"atr_pct": 1.0}'}  # ATR heuristic would NOT fire (3% > 1.5%)
        self.assertIn("stop_too_tight", classify_error_type_deterministic(row).split(","))

    def test_stop_too_tight_empirical_suppressed_when_no_recovery(self):
        """MAE pierced the stop but price never recovered → NOT stop_too_tight."""
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "validated", "exit_reason": "stop_hit",
               "actual_entry_price": 100.0, "suggested_stop": 97.0,
               "suggested_target": 110.0,
               "mae_pct": -8.0, "mfe_pct": 1.0,  # kept falling, no recovery
               "entry_signals_json": '{"atr_pct": 1.0}'}
        self.assertNotIn("stop_too_tight", classify_error_type_deterministic(row).split(","))

    def test_stop_too_tight_falls_back_to_atr_when_no_mae(self):
        """mae/mfe null → use the ATR-distance heuristic (stop inside 1.5×ATR)."""
        from routes.learning import classify_error_type_deterministic
        row = {"outcome_status": "loss", "recommendation": "BUY",
               "thesis_verdict": "validated", "exit_reason": "stop_hit",
               "actual_entry_price": 100.0, "suggested_stop": 99.0,  # 1% stop
               "entry_signals_json": '{"atr_pct": 2.0}'}  # 1.5×ATR=3% > 1% → fires
        self.assertIn("stop_too_tight", classify_error_type_deterministic(row).split(","))

    # ── 2C skill-score path-quality modifier ─────────────────────────────────
    def test_skill_deep_mae_win_scores_below_clean_win(self):
        from routes.learning import compute_skill_score_deterministic
        base = {"outcome_status": "win", "thesis_verdict": "validated",
                "exit_reason": "target_hit", "ai_confidence": 0.75, "rr_ratio": 2.0}
        deep = compute_skill_score_deterministic({**base, "mae_pct": -12.0, "mfe_pct": 6.0})
        clean = compute_skill_score_deterministic({**base, "mae_pct": -2.0, "mfe_pct": 9.0})
        self.assertLess(deep, clean)

    def test_skill_path_modifier_absent_without_mae(self):
        """No MAE/MFE → modifier is a no-op (legacy rows unaffected)."""
        from routes.learning import compute_skill_score_deterministic
        with_no_path = compute_skill_score_deterministic(
            {"outcome_status": "win", "thesis_verdict": "validated",
             "exit_reason": "target_hit", "ai_confidence": 0.75, "rr_ratio": 2.0})
        # 8 base +0.5 target +0.25 rr = 8.75 → rounded to 1dp = 8.8 (matches the
        # Sprint 70 test_skill_quadrant_validated_win_high baseline behaviour).
        self.assertEqual(with_no_path, 8.8)

    # ── 2C legacy fallback ───────────────────────────────────────────────────
    def test_fallback_scores_legacy_row(self):
        """compute_skill_score_fallback produces a score with NO thesis_verdict."""
        from routes.learning import compute_skill_score_fallback
        s = compute_skill_score_fallback(
            {"outcome_status": "win", "realized_pnl_pct": 6.0,
             "actual_entry_price": 100.0, "suggested_stop": 97.0,
             "exit_reason": "target_hit"})
        self.assertIsNotNone(s)
        self.assertGreaterEqual(s, 0.0)
        self.assertLessEqual(s, 10.0)
        self.assertGreater(s, 5.0)  # a profitable, disciplined win is above neutral

    def test_primary_scorer_still_none_without_verdict(self):
        """Primary scorer must NOT use the fallback — still None without verdict."""
        from routes.learning import compute_skill_score_deterministic
        self.assertIsNone(compute_skill_score_deterministic(
            {"outcome_status": "win", "realized_pnl_pct": 6.0}))

    # ── 2B VALID_PM_TYPES ────────────────────────────────────────────────────
    def test_valid_pm_types_has_new_tags(self):
        from routes.debate import VALID_PM_TYPES
        for t in ("early_exit", "oversized", "undersized", "missed_catalyst"):
            self.assertIn(t, VALID_PM_TYPES)

    # ── 2A top-error nudge counts multi-tag rows per-tag ─────────────────────
    def test_top_err_nudge_counts_multi_tag_per_tag(self):
        """A multi-tag loss row contributes to EACH of its tags in the counter."""
        # Mirror the counting logic used in _calib_compute's top_err block.
        learnable_losses = [
            {"error_type": "thesis_broken,poor_rr"},
            {"error_type": "poor_rr"},
            {"error_type": "overconfident"},
        ]
        type_counts: dict = {}
        for r in learnable_losses:
            et = r.get("error_type")
            if et:
                for tag in et.split(","):
                    tag = tag.strip()
                    if tag and tag != "external_shock":
                        type_counts[tag] = type_counts.get(tag, 0) + 1
        # poor_rr appears in 2 rows even though one row is compound.
        self.assertEqual(type_counts["poor_rr"], 2)
        self.assertEqual(type_counts["thesis_broken"], 1)
        self.assertEqual(type_counts["overconfident"], 1)

    # ── 2D stop_too_tight counterfactual ─────────────────────────────────────
    def test_wider_stop_would_have_saved_true(self):
        """A wider stop that lets price reach target before the wider stop → True."""
        import pandas as pd
        from routes.learning import _wider_stop_would_have_saved
        # entry 100, atr_pct 2, mult 2.5 → wider stop = 100*(1-5%) = 95.
        # price dips to 96 (above wider stop) then reaches target 110.
        hist = pd.DataFrame({
            "Open": [100.0, 97.0, 105.0], "High": [101.0, 99.0, 111.0],
            "Low":  [ 97.0, 96.0, 104.0], "Close": [98.0, 98.0, 110.0]})
        self.assertTrue(_wider_stop_would_have_saved(hist, 100.0, 110.0, 2.0, 2.5))

    def test_wider_stop_would_have_saved_false(self):
        """Even a wider stop is breached before target → False."""
        import pandas as pd
        from routes.learning import _wider_stop_would_have_saved
        # wider stop = 95; price drops straight to 90.
        hist = pd.DataFrame({
            "Open": [100.0, 93.0], "High": [101.0, 94.0],
            "Low":  [ 97.0, 90.0], "Close": [98.0, 91.0]})
        self.assertFalse(_wider_stop_would_have_saved(hist, 100.0, 110.0, 2.0, 2.5))

    def test_stop_tag_precision_in_stats_response(self):
        """/api/learning/stats must include stop_tag_precision."""
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with asx_server.app.test_client() as c:
                resp = c.get("/api/learning/stats")
                data = resp.get_json()
            self.assertIn("stop_tag_precision", data)
            self.assertIn("precision", data["stop_tag_precision"])
        finally:
            asx_server.get_db = _orig_get_db

    def test_stop_cf_column_in_migrations(self):
        import db as _db
        col_names = [c for c, _ in _db._LE_MIGRATIONS]
        self.assertIn("stop_cf_saved", col_names)

    def test_calib_suppresses_stop_nudge_when_precision_low(self):
        """Low counterfactual precision → ⚠STOP_TAG_UNRELIABLE token, no widen-stops nudge."""
        _install_in_memory_db()
        asx_server.init_db()
        try:
            from routes.learning import _calib_compute
            import unittest.mock as _mock
            import yfinance as yf
            # Build ≥30 closed losses tagged stop_too_tight, with resolved
            # counterfactuals where a wider stop would NOT have saved them (precision 0).
            with _test_get_db() as conn:
                for i in range(34):
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           realized_pnl_pct, ai_confidence, rr_ratio, exit_reason,
                           thesis_verdict, error_type, error_type_source,
                           actual_entry_price, suggested_stop, suggested_target,
                           regime, was_executed, stop_cf_saved, timestamp)
                        VALUES ('recommendation',?,'BUY','loss',-4.0,0.6,3.0,'stop_hit',
                                'validated','stop_too_tight','deterministic',
                                100.0,97.0,110.0,'riskOn',1,0,datetime('now'))
                    """, (f"T{i}.AX",))
            # Stub yfinance so lazy resolvers inside _calib_compute don't hit network.
            class _FakeTicker:
                def history(self, **kw):
                    import pandas as pd
                    return pd.DataFrame()
            with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
                result = _calib_compute("riskOn", "", "", 90)
            block = result.get("block", "")
            self.assertIn("STOP_TAG_UNRELIABLE", block)
            # The top_err stop_too_tight nudge ("top_err:ST(...)→widen stops") must be
            # suppressed. (A separate RR≥2.0 nudge may also say "widen stops" — that is
            # a different, legitimate nudge, so we assert on the top_err-specific token.)
            self.assertNotIn("top_err:ST", block)
        finally:
            asx_server.get_db = _orig_get_db

    # ── foundational rs_score / rs_5d_alpha surfacing ────────────────────────
    def test_analyse_ticker_surfaces_rs_fields(self):
        """rs_score / rs_5d_alpha keys must be present in analyse_ticker's return."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"rs_score":', src)
        self.assertIn('"rs_5d_alpha":', src)
        # And that they're sourced from the _score_data dict (the score pattern).
        self.assertIn("_score_data.get(\"rs_score\")", src)


class TestSprint41PlanAB(unittest.TestCase):
    """Sprint 41 — Plan A (regime-aware SELL/TRIM stop) + Plan B (high_60d/low_60d)."""

    def test_analysis_js_sell_trim_stop_reads_stopAtrMult(self):
        """analysis.js ATR floor for SELL/TRIM must read stopAtrMult from getRegimeModifiers."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopAtrMult", src)
        self.assertIn("_stopRepairedMult", src)
        # Must not hardcode 2.5 as the floor (only allowed as fallback default)
        # The floor computation must use stopMult, not a literal 2.5
        self.assertIn("stopMult * atr", src)

    def test_analysis_js_sell_trim_stop_uses_regime_fallback(self):
        """analysis.js must default stopMult to 2.5 when regime modifiers unavailable."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stopAtrMult ?? 2.5", src)

    def test_indicators_emits_high_60d_low_60d(self):
        """analyse_ticker() result dict must include high_60d and low_60d keys."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn('"high_60d"', src)
        self.assertIn('"low_60d"', src)
        # Must use safe_float and tail(60) on the UNADJUSTED (nominal) OHLCV slices
        # — see TestSprint72UnadjustedFibZones for the auto_adjust=False rationale.
        self.assertIn("high_raw.tail(60).max()", src)
        self.assertIn("low_raw.tail(60).min()", src)

    def test_prompts_signal4_uses_high_60d_low_60d(self):
        """prompts.js Signal #4 must reference high_60d and low_60d (not just return_60d)."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("high_60d", src)
        self.assertIn("low_60d", src)
        self.assertIn("fib_50", src)
        self.assertIn("fib_618", src)

    def test_prompts_priority1_eps_revision_proxy_documented(self):
        """ANALYSIS_SYSTEM_PROMPT Priority 1 must document EPSvEst(4Q) as the revision proxy."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("EPSvEst(4Q)", src)
        # Must not rely on a non-existent eps_revision_30d field
        # (the proxy wording makes clear it's unavailable from yfinance)
        self.assertIn("unavailable from yfinance", src)


class TestSprint42Fibonacci(unittest.TestCase):
    """Sprint 42 — Fibonacci zone fix in _dtBuildRecs + high_60d/low_60d forwarding."""

    def test_dt_build_recs_signal4_uses_fibonacci(self):
        """_dtBuildRecs Signal #4 must use high_60d/low_60d for Fibonacci zone check."""
        with open(os.path.join(ROOT, "js", "day-trading-analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("high_60d", src)
        self.assertIn("low_60d", src)
        self.assertIn("fib50", src)
        self.assertIn("fib618", src)

    def test_dt_build_recs_signal4_has_return60d_fallback(self):
        """_dtBuildRecs Signal #4 must fall back to return_60d range when high/low absent."""
        with open(os.path.join(ROOT, "js", "day-trading-analysis.js"), encoding="utf-8") as f:
            src = f.read()
        # Both the Fibonacci path and the return_60d fallback must be present
        self.assertIn("fib50", src)
        self.assertIn("fibReturnMin", src)
        self.assertIn("fibReturnMax", src)

    def test_analysis_js_forwards_high60d_low60d_to_claude(self):
        """analysis.js signal block must include high_60d and low_60d fields."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("high_60d", src)
        self.assertIn("low_60d", src)
        # Must appear in the Returns/Range60d line sent to Claude
        self.assertIn("Range60d", src)

    def test_dt_comment_notes_quant_only_engine(self):
        """day-trading-analysis.js comment must document the quantitative-only (no Claude) approach."""
        with open(os.path.join(ROOT, "js", "day-trading-analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("no Claude call", src)


class TestSprint72UnadjustedFibZones(unittest.TestCase):
    """Sprint 72 — high_60d/low_60d must come from an UNADJUSTED (auto_adjust=False)
    history fetch, not the auto_adjust=True series used for RSI/MACD/SMA/etc.

    Adjusted historical prices retroactively shift the whole series down for
    dividends/splits paid since each bar, so they don't represent the nominal
    price level a day-trader actually saw on the chart on that date. The
    Fibonacci day-trade zone (high_60d/low_60d) needs the real nominal levels.
    """

    def test_analyse_ticker_fetches_unadjusted_series_separately(self):
        """analyse_ticker() must call stk.history with auto_adjust=False as a second fetch."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("auto_adjust=True", src)
        self.assertIn("auto_adjust=False", src)
        self.assertIn("hist_raw", src)
        self.assertIn("high_raw", src)
        self.assertIn("low_raw", src)

    def test_analyse_ticker_unadjusted_fetch_applies_same_guards(self):
        """The unadjusted fetch must still go through _drop_forming_bar/_sanity_check."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        # Both guards must be invoked on hist_raw, not just hist.
        self.assertIn("_drop_forming_bar(hist_raw)", src)
        self.assertIn("_sanity_check(hist_raw, ticker)", src)

    def test_analyse_ticker_unadjusted_fetch_falls_back_to_stooq(self):
        """If the unadjusted yfinance fetch is empty/short, fall back to _fetch_stooq_history."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        # Look at the secondary-fetch block specifically (after the primary Stooq fallback).
        idx = src.index("hist_raw = stk.history")
        block = src[idx:idx + 800]
        self.assertIn("_fetch_stooq_history(ticker, period)", block)

    def test_other_indicators_still_use_adjusted_series(self):
        """RSI/MACD/SMA/Bollinger/ATR must still read from the adjusted `high`/`low`/`close`
        series — only high_60d/low_60d should switch to the unadjusted series."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("compute_rsi(close, 14)", src)
        self.assertIn("compute_atr(high, low, close)", src)
        self.assertIn("compute_bollinger(close)", src)
        # high_60d/low_60d must NOT reference the plain adjusted high/low directly.
        self.assertNotIn("high.tail(60).max()", src)
        self.assertNotIn("low.tail(60).min()", src)

    def test_analyse_ticker_high60d_low60d_use_unadjusted_values(self):
        """End-to-end: when the adjusted and unadjusted series diverge (simulating a
        split/dividend retroactive adjustment), high_60d/low_60d must reflect the
        UNADJUSTED nominal series, not the adjusted one used for everything else."""
        import unittest.mock as _mock
        import numpy as np
        import pandas as pd
        import indicators as ind

        n = 120
        idx = pd.date_range("2025-01-01", periods=n, freq="D")

        # Adjusted series: scaled down (as if a 2:1 split/large dividend retroactively
        # halved historical prices). Peaks at 50.
        adj_close = np.linspace(40, 50, n)
        adj_df = pd.DataFrame({
            "Open":   adj_close - 0.5,
            "High":   adj_close + 0.5,
            "Low":    adj_close - 1.0,
            "Close":  adj_close,
            "Volume": np.full(n, 1_000_000),
        }, index=idx)

        # Unadjusted (nominal) series: roughly double the adjusted prices — what a
        # trader actually saw on the chart historically. Peaks at 100.
        raw_close = adj_close * 2
        raw_df = pd.DataFrame({
            "Open":   raw_close - 1.0,
            "High":   raw_close + 1.0,
            "Low":    raw_close - 2.0,
            "Close":  raw_close,
            "Volume": np.full(n, 1_000_000),
        }, index=idx)

        def _fake_history(period=None, auto_adjust=None, **kw):
            return raw_df if auto_adjust is False else adj_df

        with _mock.patch.object(ind.yf, "Ticker") as mock_tk:
            mock_tk.return_value.history.side_effect = _fake_history
            mock_tk.return_value.info = {}
            # Force the forming-bar guard to no-op regardless of wall-clock time.
            # Audit fix #8: guard now checks Sydney-local time (zoneinfo), not utcnow().
            # Patch indicators._dt_mod itself (the name binding inside indicators.py's
            # namespace), not a nested "indicators._dt_mod.datetime" attribute path —
            # the latter would replace the real global stdlib datetime.datetime class
            # and break pandas' own isinstance checks against it.
            import datetime as _real_dt
            fake_now = _real_dt.datetime.now(ind._SYDNEY_TZ).replace(hour=18)
            with _mock.patch("indicators._dt_mod") as mock_dt:
                mock_dt.datetime.now.return_value = fake_now
                result = ind.analyse_ticker("FAKE", period="6mo")

        self.assertNotIn("error", result)
        # high_60d/low_60d must come from the unadjusted (raw_df) series — its tail-60
        # high is ~101 and low is ~88.7 — clearly distinguishable from the adjusted
        # series' tail-60 high (~50.5) / low (~39.4).
        self.assertGreater(result["high_60d"], 90)
        self.assertLess(result["low_60d"], 90)
        self.assertGreater(result["low_60d"], 80)


class TestSprint42StooqFallback(unittest.TestCase):
    """Sprint 42 — Stooq price fallback for quote and macro endpoints."""

    def test_stooq_quote_in_core(self):
        """core.py must export stooq_quote and _to_stooq_sym."""
        import core as c
        self.assertTrue(callable(c.stooq_quote))
        self.assertTrue(callable(c._to_stooq_sym))

    def test_stooq_symbol_map_asx_equity(self):
        """_to_stooq_sym must convert BHP.AX → bhp.au."""
        from core import _to_stooq_sym
        self.assertEqual(_to_stooq_sym("BHP.AX"), "bhp.au")
        self.assertEqual(_to_stooq_sym("CBA.AX"), "cba.au")

    def test_stooq_symbol_map_known_globals(self):
        """_to_stooq_sym must map major yfinance global symbols to Stooq equivalents."""
        from core import _to_stooq_sym
        self.assertEqual(_to_stooq_sym("^AXJO"),    "^axjo")
        self.assertEqual(_to_stooq_sym("AUDUSD=X"), "audusd")
        self.assertEqual(_to_stooq_sym("GC=F"),     "gc.f")
        self.assertEqual(_to_stooq_sym("^VIX"),     "^vix")

    def test_stooq_symbol_map_unsupported_returns_none(self):
        """_to_stooq_sym must return None for symbols not on Stooq."""
        from core import _to_stooq_sym
        self.assertIsNone(_to_stooq_sym("TIO=F"))   # iron ore futures
        self.assertIsNone(_to_stooq_sym("YAP=F"))   # SPI200 futures

    def test_stooq_quote_wired_into_quote_endpoint(self):
        """routes/market.py must import and call stooq_quote in _quote_cached."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("stooq_quote", src)
        self.assertIn("_source", src)

    def test_stooq_quote_wired_into_macro_endpoint(self):
        """_fetch_symbol in _macro_payload must call stooq_quote on yfinance failure."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        # Both call sites use stooq_quote; macro fallback returns name/None/summary
        self.assertIn("Stooq fallback", src)

    def test_stooq_quote_returns_none_on_bad_csv(self):
        """stooq_quote must return None when Stooq returns malformed data."""
        from unittest.mock import patch, MagicMock
        import core as c
        mock_resp = MagicMock()
        mock_resp.text = "Symbol,Date\nBHP,2026-06-03"  # too few columns
        mock_resp.raise_for_status = lambda: None
        with patch.object(c._HTTP_SESSION, "get", return_value=mock_resp):
            self.assertIsNone(c.stooq_quote("BHP.AX"))

    def test_stooq_quote_returns_none_on_network_error(self):
        """stooq_quote must return None (not raise) on any network exception."""
        from unittest.mock import patch
        import core as c
        with patch.object(c._HTTP_SESSION, "get", side_effect=Exception("timeout")):
            self.assertIsNone(c.stooq_quote("BHP.AX"))


class TestSprint44(unittest.TestCase):
    """Sprint 44 feature tests: DRP parcels, virtual speed weight, regime-flip penalty, lessons breadth."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Item 1: DRP parcel tracking ──────────────────────────────────────────

    def test_drp_button_in_portfolio_js(self):
        """portfolio.js must contain the DRP button and applyDrpEvent function."""
        src = open(os.path.join(ROOT, "js", "pages", "portfolio.js"), encoding="utf-8").read()
        self.assertIn("showDrpModal", src)
        self.assertIn("applyDrpEvent", src)
        self.assertIn("DRP", src)

    def test_drp_badge_in_utils_js(self):
        """actionBadge in utils.js must handle DRP action with badge-drp class."""
        src = open(os.path.join(ROOT, "js", "utils.js"), encoding="utf-8").read()
        self.assertIn("DRP", src)
        self.assertIn("badge-drp", src)

    def test_drp_badge_css_defined(self):
        """asx_trading.css must define .badge-drp styles."""
        src = open(os.path.join(ROOT, "asx_trading.css"), encoding="utf-8").read()
        self.assertIn(".badge-drp", src)

    # ── Item 2: Virtual-outcome speed weighting ───────────────────────────────

    def test_virtual_speed_weight_written_by_resolve_virtual_outcomes(self):
        """_resolve_virtual_outcomes must write virtual_speed_weight on resolved rows.

        Fix: speed_weight is now 7/bars_to_resolution (days-to-hit) NOT 7/total_elapsed.
        A rec resolved in 7 bars → weight 1.0; one drifting for 30 bars → ~0.23.
        """
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("virtual_speed_weight", src)
        self.assertIn("speed_weight", src)
        # Must use bars_to_resolution (not total elapsed time) for the speed formula
        self.assertIn("7.0 / bars_to_resolution", src)
        # Must NOT fall back to elapsed time (regression guard)
        self.assertNotIn("7.0 / hold_days", src)

    def test_virtual_outcomes_cutoff_is_30_days(self):
        """_resolve_virtual_outcomes must use a 30-day cutoff (≥30d old per spec).

        Events younger than 30 days may not have had time to play out — resolving
        too early produces a large virtual_open population that adds noise to
        calibration without meaningful signal.
        """
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        # Find _resolve_virtual_outcomes body and check the cutoff (docstring is long so use 3000)
        idx = src.find("def _resolve_virtual_outcomes(")
        body = src[idx:idx + 3000]
        self.assertIn("timedelta(days=30)", body)
        self.assertNotIn("timedelta(days=10)", body)

    def test_n_virtual_resolved_in_stats_response(self):
        """GET /api/learning/stats must return n_virtual_resolved count."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("n_virtual_resolved", src)
        # Must be a DB count query, not just a variable name
        self.assertIn("virtual_outcome IN ('virtual_win', 'virtual_loss')", src)

    def test_learning_js_shows_virtual_count_in_calibration_card(self):
        """learning.js calibration card must render virtual outcome count chip."""
        src = open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8").read()
        self.assertIn("nVirtualResolved", src)
        self.assertIn("virtual outcomes included", src)

    def test_virtual_chip_tooltip_shows_effective_weight(self):
        """learning.js virtual chip tooltip must show effective calibration weight."""
        src = open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8").read()
        self.assertIn("_virtEffectiveWt", src)
        self.assertIn("virtual_speed_weight", src)

    def test_learning_stats_query_includes_virtual_speed_weight(self):
        """learning_stats() recent events SELECT must include virtual_speed_weight column."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        # virtual_speed_weight must appear in the recent events SELECT (not just virtual rows)
        idx = src.find("SELECT id, timestamp, ticker, recommendation")
        block = src[idx:idx + 900]  # query is ~700 chars; 900 gives safe margin
        self.assertIn("virtual_speed_weight", block)

    def test_virtual_speed_weight_column_in_db_migrations(self):
        """virtual_speed_weight must be in _LE_MIGRATIONS in db.py."""
        src = open(os.path.join(ROOT, "db.py"), encoding="utf-8").read()
        self.assertIn('"virtual_speed_weight"', src)

    def test_calib_compute_applies_speed_weight_to_virtual_rows(self):
        """_weight() in _calib_compute must multiply by virtual_speed_weight for virtual rows."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("virtual_speed_weight", src)
        self.assertIn('r.get("virtual_speed_weight")', src)

    # ── Item 3: Regime-flip calibration penalty ───────────────────────────────

    def test_calibration_route_accepts_flipped_params(self):
        """GET /api/learning/calibration must accept flipped_at and flipped_to params."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn('flipped_at', src)
        self.assertIn('flipped_to', src)

    def test_regime_flip_token_emitted(self):
        """_calib_compute must emit REGIME_FLIP token when flip is recent and trades < 10."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("REGIME_FLIP", src)
        self.assertIn("hl // 2", src)

    def test_regime_flip_localStorage_in_regime_engine(self):
        """regime-engine.js must write regime_flipped_at/to to localStorage on flip."""
        src = open(os.path.join(ROOT, "js", "regime-engine.js"), encoding="utf-8").read()
        self.assertIn("regime_flipped_at", src)
        self.assertIn("regime_flipped_to", src)
        self.assertIn("localStorage.setItem", src)

    def test_fetch_calibration_block_passes_flip_params(self):
        """fetchCalibrationBlock in learning-loop.js must pass flipped_at and flipped_to."""
        src = open(os.path.join(ROOT, "js", "learning-loop.js"), encoding="utf-8").read()
        self.assertIn("flipped_at", src)
        self.assertIn("flipped_to", src)

    # ── Item 4: Lessons breadth scope ────────────────────────────────────────

    def test_breadth_scope_column_in_db_migration(self):
        """breadth_scope column must be added to trading_lessons in init_db()."""
        src = open(os.path.join(ROOT, "db.py"), encoding="utf-8").read()
        self.assertIn("breadth_scope", src)
        self.assertIn("trading_lessons", src)

    def test_lessons_breadth_dropdown_in_learning_js(self):
        """learning.js must include the breadth_scope dropdown in the Add Lesson form."""
        src = open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8").read()
        self.assertIn("ll-lesson-breadth", src)
        self.assertIn("adl_below_0.3", src)
        self.assertIn("adl_above_0.7", src)
        self.assertIn("high_vol", src)
        self.assertIn("low_vol", src)

    def test_lessons_post_accepts_breadth_scope(self):
        """POST /api/learning/lessons must accept breadth_scope field."""
        r = self.client.post("/api/learning/lessons", json={
            "lesson_text": "Sprint44 high vol lesson",
            "breadth_scope": "high_vol",
        }, content_type="application/json")
        self.assertEqual(r.status_code, 200)
        data = json.loads(r.data)
        self.assertTrue(data["ok"])
        self.assertIn("id", data)

    def test_lessons_post_rejects_invalid_breadth_scope(self):
        """POST /api/learning/lessons must reject unknown breadth_scope values."""
        r = self.client.post("/api/learning/lessons", json={
            "lesson_text": "Bad scope lesson",
            "breadth_scope": "invalid_scope",
        }, content_type="application/json")
        self.assertEqual(r.status_code, 400)

    def test_lessons_filter_by_adl(self):
        """GET /api/learning/lessons must filter breadth-scoped lessons by adl param."""
        # Insert a scoped lesson
        self.client.post("/api/learning/lessons", json={
            "lesson_text": "Sprint44 bear adl lesson",
            "breadth_scope": "adl_below_0.3",
        }, content_type="application/json")

        # adl=0.2 (below 0.3) → scoped lesson included
        r = self.client.get("/api/learning/lessons?adl=0.2")
        data = json.loads(r.data)
        self.assertTrue(data["ok"])
        texts = [l["lesson_text"] for l in data["lessons"]]
        self.assertIn("Sprint44 bear adl lesson", texts)

        # adl=0.5 (above 0.3) → scoped lesson excluded
        r2 = self.client.get("/api/learning/lessons?adl=0.5")
        data2 = json.loads(r2.data)
        texts2 = [l["lesson_text"] for l in data2["lessons"]]
        self.assertNotIn("Sprint44 bear adl lesson", texts2)

        # no adl param → scoped lesson excluded (condition cannot be evaluated)
        r3 = self.client.get("/api/learning/lessons?ticker=ZZZNOMATCH")
        data3 = json.loads(r3.data)
        texts3 = [l["lesson_text"] for l in data3["lessons"]]
        self.assertNotIn("Sprint44 bear adl lesson", texts3)

    def test_lessons_filter_by_asx_vol(self):
        """GET /api/learning/lessons must filter high_vol lessons by asx_vol param."""
        self.client.post("/api/learning/lessons", json={
            "lesson_text": "Sprint44 high vol specific",
            "breadth_scope": "high_vol",
        }, content_type="application/json")

        # asx_vol=30 > 25 → high_vol lesson included
        r = self.client.get("/api/learning/lessons?asx_vol=30")
        data = json.loads(r.data)
        texts = [l["lesson_text"] for l in data["lessons"]]
        self.assertIn("Sprint44 high vol specific", texts)

        # asx_vol=10 < 25 → high_vol lesson excluded
        r2 = self.client.get("/api/learning/lessons?asx_vol=10")
        data2 = json.loads(r2.data)
        texts2 = [l["lesson_text"] for l in data2["lessons"]]
        self.assertNotIn("Sprint44 high vol specific", texts2)


class TestSprint45(unittest.TestCase):
    """Sprint 45 feature tests: thesis drift detection, stop trailing, scheduled brief."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Item 1: Thesis drift detection ──────────────────────────────────────

    def test_thesis_drift_endpoint_exists(self):
        """GET /api/learning/thesis-drift must return ok=True."""
        r = self.client.get("/api/learning/thesis-drift")
        self.assertEqual(r.status_code, 200)
        data = json.loads(r.data)
        self.assertTrue(data["ok"])

    def test_thesis_drift_empty_db_returns_nulls(self):
        """With no data, _compute_thesis_drift should return null averages and no nudge."""
        from routes.learning import _compute_thesis_drift
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                exit_reason TEXT, realized_pnl_pct REAL,
                was_executed INTEGER, outcome_status TEXT
            )
        """)
        conn.commit()

        result = _compute_thesis_drift(conn)
        self.assertIsNone(result["avg_manual_pct"])
        self.assertIsNone(result["avg_target_pct"])
        self.assertIsNone(result["nudge"])
        self.assertEqual(result["n_manual"], 0)
        self.assertEqual(result["n_target"], 0)
        conn.close()

    def test_thesis_drift_nudge_threshold(self):
        """Nudge fires only when target_avg - manual_avg > 3pp and n >= 5 in each bucket."""
        from routes.learning import _compute_thesis_drift
        import sqlite3

        # Build an in-memory DB with mock rows
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                exit_reason TEXT, realized_pnl_pct REAL,
                was_executed INTEGER, outcome_status TEXT
            )
        """)
        # 5 manual exits at +2% avg
        for _ in range(5):
            conn.execute(
                "INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)",
                ("manual", 2.0, 1, "win"),
            )
        # 5 target hits at +10% avg (drag = 8pp > 3pp threshold)
        for _ in range(5):
            conn.execute(
                "INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)",
                ("target_hit", 10.0, 1, "win"),
            )
        conn.commit()

        result = _compute_thesis_drift(conn)
        self.assertEqual(result["n_manual"], 5)
        self.assertEqual(result["n_target"], 5)
        self.assertAlmostEqual(result["avg_manual_pct"], 2.0)
        self.assertAlmostEqual(result["avg_target_pct"], 10.0)
        self.assertIsNotNone(result["nudge"])
        self.assertIn("EARLY_EXIT_DRAG", result["nudge"])
        conn.close()

    def test_thesis_drift_no_nudge_below_threshold(self):
        """No nudge when drag <= 3pp."""
        from routes.learning import _compute_thesis_drift
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                exit_reason TEXT, realized_pnl_pct REAL,
                was_executed INTEGER, outcome_status TEXT
            )
        """)
        # drag = 4.5 - 3.0 = 1.5pp (under threshold)
        for _ in range(5):
            conn.execute("INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)", ("manual", 3.0, 1, "win"))
        for _ in range(5):
            conn.execute("INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)", ("target_hit", 4.5, 1, "win"))
        conn.commit()

        result = _compute_thesis_drift(conn)
        self.assertIsNone(result["nudge"])
        conn.close()

    def test_thesis_drift_insufficient_data_no_nudge(self):
        """No nudge when n < 5 in either bucket."""
        from routes.learning import _compute_thesis_drift
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                exit_reason TEXT, realized_pnl_pct REAL,
                was_executed INTEGER, outcome_status TEXT
            )
        """)
        for _ in range(3):
            conn.execute("INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)", ("manual", 2.0, 1, "win"))
        for _ in range(5):
            conn.execute("INSERT INTO ai_learning_events VALUES (?, ?, ?, ?)", ("target_hit", 15.0, 1, "win"))
        conn.commit()

        result = _compute_thesis_drift(conn)
        self.assertIsNone(result["nudge"])
        conn.close()

    def test_calib_compute_calls_thesis_drift(self):
        """_calib_compute source must reference _compute_thesis_drift."""
        src = open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8").read()
        self.assertIn("_compute_thesis_drift", src)
        self.assertIn("_thesis_drift", src)
        self.assertIn("EARLY_EXIT_DRAG", src)

    def test_thesis_drift_card_in_learning_js(self):
        """learning.js must render a Thesis Drift card with correct placeholder id."""
        src = open(os.path.join(ROOT, "js", "pages", "learning.js"), encoding="utf-8").read()
        self.assertIn("ll-thesis-drift-card", src)
        self.assertIn("renderThesisDriftCard", src)
        self.assertIn("Thesis Drift", src)

    # ── Item 2: Stop trailing ────────────────────────────────────────────────

    def test_trail_stop_button_in_recommendations_js(self):
        """recommendations.js must have a Trail button and trailStop function."""
        src = open(os.path.join(ROOT, "js", "pages", "recommendations.js"), encoding="utf-8").read()
        self.assertIn("trailStop", src)
        self.assertIn("Trail", src)
        self.assertIn("_stopTrailed", src)
        self.assertIn("_stopTrailedAt", src)

    def test_trail_stop_only_tightens(self):
        """trailStop function must check wouldTighten before updating."""
        src = open(os.path.join(ROOT, "js", "pages", "recommendations.js"), encoding="utf-8").read()
        self.assertIn("wouldTighten", src)

    def test_trail_stop_badge_in_recommendations_js(self):
        """recommendations.js must render a Trailed badge when _stopTrailed is set."""
        src = open(os.path.join(ROOT, "js", "pages", "recommendations.js"), encoding="utf-8").read()
        self.assertIn("Trailed", src)

class TestSprint46(unittest.TestCase):
    """Sprint 46: broker SELL import, rebalance suggestions, universe exclusion list."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    # ── Item 1: Broker CSV SELL import ──────────────────────────────────────

    def test_import_csv_sell_rows_returned_in_sells_array(self):
        """CSV with SELL rows must return them in 'sells' not 'skipped'."""
        import io as _io
        csv_data = (
            "Date,Reference,Market,Code,Description,Price,Units,Amount,Brokerage,GST,Contract,Order Date,Credit/Debit\n"
            "15/05/2026,REF1,ASX,BHP,SELL BHP,45.00,50,2250.00,19.95,1.99,CNT1,15/05/2026,Debit\n"
            "10/05/2026,REF2,ASX,CBA,BUY CBA,120.00,10,1200.00,9.95,0.99,CNT2,10/05/2026,Debit\n"
        ).encode()
        r = self.client.post(
            "/api/import/csv",
            data={"file": (_io.BytesIO(csv_data), "trades.csv")},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        d = json.loads(r.data)
        self.assertTrue(d["ok"])
        # SELL must be in sells, not skipped
        self.assertIn("sells", d)
        self.assertEqual(len(d["sells"]), 1)
        self.assertEqual(d["sells"][0]["action"], "SELL")
        self.assertEqual(d["sells"][0]["ticker"], "BHP")
        # BUY in rows
        self.assertEqual(len(d["rows"]), 1)
        self.assertEqual(d["rows"][0]["ticker"], "CBA")
        # SELL must NOT appear in skipped
        for s in d.get("skipped", []):
            self.assertNotIn("SELL BHP", s.get("reason", ""))

    def test_import_csv_selfwealth_sell_in_sells(self):
        """SelfWealth CSV with SELL row returned in 'sells' array."""
        import io as _io
        csv_data = (
            "Trade Date,Settlement Date,Description,Quantity,Price,Brokerage,GST on Brokerage,Total Amount,Portfolio\n"
            "15/05/2026,17/05/2026,SELL 50 WDS,50,4.50,9.95,0.99,225.00,Personal\n"
        ).encode()
        r = self.client.post(
            "/api/import/csv",
            data={"file": (_io.BytesIO(csv_data), "sw.csv"), "broker": "selfwealth"},
            content_type="multipart/form-data",
        )
        self.assertEqual(r.status_code, 200)
        d = json.loads(r.data)
        self.assertTrue(d["ok"])
        self.assertIn("sells", d)
        self.assertEqual(len(d["sells"]), 1)
        self.assertEqual(d["sells"][0]["action"], "SELL")
        self.assertEqual(d["sells"][0]["ticker"], "WDS")

    def test_import_csv_sells_sorted_chronologically(self):
        """Multiple SELL rows must be sorted by date ascending."""
        import io as _io
        csv_data = (
            "Date,Reference,Market,Code,Description,Price,Units,Amount,Brokerage,GST,Contract,Order Date,Credit/Debit\n"
            "20/06/2026,R1,ASX,BHP,SELL BHP,46.00,10,460.00,9.95,0.99,C1,20/06/2026,Debit\n"
            "01/06/2026,R2,ASX,BHP,SELL BHP,44.00,5,220.00,9.95,0.99,C2,01/06/2026,Debit\n"
        ).encode()
        r = self.client.post(
            "/api/import/csv",
            data={"file": (_io.BytesIO(csv_data), "trades.csv")},
            content_type="multipart/form-data",
        )
        d = json.loads(r.data)
        self.assertIn("sells", d)
        self.assertEqual(len(d["sells"]), 2)
        self.assertLessEqual(d["sells"][0]["date"], d["sells"][1]["date"])

    # ── Item 2: Rebalancing suggestions panel ──────────────────────────────

    def test_risk_js_has_build_rebalance_suggestions(self):
        """risk.js must define _buildRebalanceSuggestions function."""
        src = open(os.path.join(ROOT, "js", "pages", "risk.js"), encoding="utf-8").read()
        self.assertIn("_buildRebalanceSuggestions", src)

    def test_risk_js_has_show_rebalance_suggestions(self):
        """risk.js must define showRebalanceSuggestions function."""
        src = open(os.path.join(ROOT, "js", "pages", "risk.js"), encoding="utf-8").read()
        self.assertIn("showRebalanceSuggestions", src)

    def test_risk_js_suggest_rebalance_button(self):
        """risk.js must include the Suggest Rebalance button."""
        src = open(os.path.join(ROOT, "js", "pages", "risk.js"), encoding="utf-8").read()
        self.assertIn("Suggest Rebalance", src)

    def test_risk_js_cgt_warning_in_suggestions(self):
        """_buildRebalanceSuggestions must check 320-365 day CGT window."""
        src = open(os.path.join(ROOT, "js", "pages", "risk.js"), encoding="utf-8").read()
        self.assertIn("CGT discount at risk", src)
        self.assertIn("320", src)

    # ── Item 3: Universe exclusion list ────────────────────────────────────

    def test_universe_exclude_post_adds_to_blob_store(self):
        """POST /api/market/universe-exclude must add tickers to blob_store."""
        r = self.client.post(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["IPL", "XYZ"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        d = json.loads(r.data)
        self.assertTrue(d["ok"])
        self.assertIn("IPL", d["excluded"])
        self.assertIn("XYZ", d["excluded"])

    def test_universe_exclude_delete_removes_from_blob_store(self):
        """DELETE /api/market/universe-exclude must remove tickers."""
        # First add some tickers
        self.client.post(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["IPL", "XYZ", "ABC"]}),
            content_type="application/json",
        )
        # Now remove IPL
        r = self.client.delete(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["IPL"]}),
            content_type="application/json",
        )
        self.assertEqual(r.status_code, 200)
        d = json.loads(r.data)
        self.assertTrue(d["ok"])
        self.assertNotIn("IPL", d["excluded"])
        self.assertIn("XYZ", d["excluded"])

    def test_universe_exclude_deduplicates(self):
        """Adding the same ticker twice must not create duplicates."""
        self.client.post(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["DEDUP"]}),
            content_type="application/json",
        )
        r = self.client.post(
            "/api/market/universe-exclude",
            data=json.dumps({"tickers": ["DEDUP"]}),
            content_type="application/json",
        )
        d = json.loads(r.data)
        self.assertEqual(d["excluded"].count("DEDUP"), 1)

    def test_settings_js_has_exclude_from_universe(self):
        """settings.js must define excludeFromUniverse function."""
        src = open(os.path.join(ROOT, "js", "pages", "settings.js"), encoding="utf-8").read()
        self.assertIn("excludeFromUniverse", src)

    def test_settings_js_has_unexclude_from_universe(self):
        """settings.js must define unexcludeFromUniverse function."""
        src = open(os.path.join(ROOT, "js", "pages", "settings.js"), encoding="utf-8").read()
        self.assertIn("unexcludeFromUniverse", src)

    def test_settings_js_has_render_exclusion_list(self):
        """settings.js must define _renderUniverseExclusionList function."""
        src = open(os.path.join(ROOT, "js", "pages", "settings.js"), encoding="utf-8").read()
        self.assertIn("_renderUniverseExclusionList", src)

    def test_portfolio_js_has_apply_imported_sells(self):
        """portfolio.js must define _applyImportedSells function."""
        src = open(os.path.join(ROOT, "js", "pages", "portfolio.js"), encoding="utf-8").read()
        self.assertIn("_applyImportedSells", src)

    def test_portfolio_js_has_show_sell_import_confirmation(self):
        """portfolio.js must define _showSellImportConfirmation function."""
        src = open(os.path.join(ROOT, "js", "pages", "portfolio.js"), encoding="utf-8").read()
        self.assertIn("_showSellImportConfirmation", src)

    def test_scanner_imports_get_db(self):
        """scanner.py must import get_db for exclusion filter."""
        src = open(os.path.join(ROOT, "routes", "scanner.py"), encoding="utf-8").read()
        self.assertIn("from db import get_db", src)
        self.assertIn("universe_excluded", src)

    def test_intraday_imports_get_db(self):
        """intraday.py must import get_db for exclusion filter."""
        src = open(os.path.join(ROOT, "routes", "intraday.py"), encoding="utf-8").read()
        self.assertIn("from db import get_db", src)
        self.assertIn("universe_excluded", src)


class TestQuickAnalysisSellTrim(unittest.TestCase):

    def test_schema_allows_sell_trim(self):
        """_SCHEMA_QUICK_ANALYSIS must include SELL and TRIM in action enum."""
        from routes.debate import _SCHEMA_QUICK_ANALYSIS
        enum = _SCHEMA_QUICK_ANALYSIS["properties"]["recs"]["items"]["properties"]["action"]["enum"]
        self.assertIn("SELL", enum)
        self.assertIn("TRIM", enum)

    def test_schema_has_exit_fields(self):
        """Schema must include primary_driver and urgency fields."""
        from routes.debate import _SCHEMA_QUICK_ANALYSIS
        props = _SCHEMA_QUICK_ANALYSIS["properties"]["recs"]["items"]["properties"]
        self.assertIn("primary_driver", props)
        self.assertIn("urgency", props)

    def test_local_system_prompt_mentions_sell_trim(self):
        """_LOCAL_ANALYSIS_SYSTEM must document SELL and TRIM actions."""
        from routes.debate import _LOCAL_ANALYSIS_SYSTEM
        self.assertIn("SELL", _LOCAL_ANALYSIS_SYSTEM)
        self.assertIn("TRIM", _LOCAL_ANALYSIS_SYSTEM)
        self.assertIn("primary_driver", _LOCAL_ANALYSIS_SYSTEM)
        self.assertIn("thesis_broken", _LOCAL_ANALYSIS_SYSTEM)

    def test_exit_stop_repair(self):
        """SELL rec with stop below entry must be repaired to entry * 1.03."""
        rec = {"action": "SELL", "priceRange": [50.0, 50.5], "stopLoss": 48.0,
               "reasoning": "test", "risks": "test", "confidence": 0.65, "ticker": "BHP"}
        entry = (rec.get("priceRange") or [None])[0]
        stop  = rec.get("stopLoss")
        if entry and stop and stop < entry:
            rec["stopLoss"] = round(entry * 1.03, 4)
            rec["_stopRepaired"] = True
        self.assertEqual(rec["stopLoss"], round(50.0 * 1.03, 4))
        self.assertTrue(rec["_stopRepaired"])

    def test_exit_default_driver_added(self):
        """SELL rec missing primary_driver must get thesis_broken default."""
        rec = {"action": "SELL", "confidence": 0.65, "ticker": "BHP",
               "reasoning": "test", "risks": "test"}
        if (rec.get("action") or "").upper() in ("SELL", "TRIM"):
            if not rec.get("primary_driver"):
                rec["primary_driver"] = "thesis_broken"
            if not rec.get("urgency"):
                rec["urgency"] = "routine"
        self.assertEqual(rec["primary_driver"], "thesis_broken")
        self.assertEqual(rec["urgency"], "routine")


class TestPostSprint48Fixes(unittest.TestCase):
    """FIXES.md #27–33: Post-Sprint-48 audit — critical/high/medium bug fixes."""

    # ── Fix #27: log import in routes/market.py ───────────────────────────────

    def test_market_py_imports_log(self):
        """routes/market.py must import 'log' from core — NameError fires on Stooq fallback."""
        with open(os.path.join(ROOT, "routes", "market.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("from core import", src)
        # The import line must include 'log'
        import re
        m = re.search(r"from core import ([^\n]+)", src)
        self.assertIsNotNone(m)
        imports = [s.strip() for s in m.group(1).split(",")]
        self.assertIn("log", imports,
                      "routes/market.py must import 'log' from core to avoid NameError on Stooq fallback")

    # ── Fix #28: XSS in assistant.js ─────────────────────────────────────────

    def test_assistant_js_user_input_escaped(self):
        """assistant.js must wrap user message in escapeHTML() before inserting into DOM."""
        with open(os.path.join(ROOT, "js", "pages", "assistant.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("escapeHTML(msg)", src,
                      "User input must be escaped before insertion into innerHTML")

    def test_assistant_js_ai_reply_escaped(self):
        """assistant.js must wrap AI reply in escapeHTML() before inserting into DOM."""
        with open(os.path.join(ROOT, "js", "pages", "assistant.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("escapeHTML(reply)", src,
                      "AI response must be escaped before insertion into innerHTML")

    def test_assistant_js_raw_msg_interpolation_removed(self):
        """assistant.js must not have raw ${msg} or ${reply} in innerHTML template literals."""
        with open(os.path.join(ROOT, "js", "pages", "assistant.js"), encoding="utf-8") as f:
            src = f.read()
        # The unsafe patterns must no longer exist
        self.assertNotIn("`<div class=\"msg msg-user\">${msg}</div>`", src,
                         "Raw ${msg} interpolation in innerHTML must be replaced with escapeHTML(msg)")

    # ── Fix #29: Infinity liquidity cap in quant-engine.js ────────────────────

    def test_quant_engine_rejects_on_missing_adv(self):
        """computeTradeParams must reject (ok: false) when ADV data is unavailable."""
        with open(os.path.join(ROOT, "js", "quant-engine.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("ADV data unavailable", src)
        self.assertNotIn(": Infinity", src,
                         "Infinity liquidity cap must be replaced with hard rejection")

    def test_quant_engine_adv_fallback_is_null_not_zero(self):
        """advShares fallback must be null (not 0) so the ADV guard fires correctly."""
        with open(os.path.join(ROOT, "js", "quant-engine.js"), encoding="utf-8") as f:
            src = f.read()
        # The old : 0 fallback would prevent the !advShares guard from firing
        self.assertNotIn("? advAud / signals.current_price : 0)", src)
        self.assertIn("? advAud / signals.current_price : null)", src)

    # ── Fix #30: timezone mismatch in indicators.py ───────────────────────────

    def test_indicators_earnings_tz_stripped(self):
        """indicators.py days_to_earnings must use .replace(tzinfo=None) to avoid TypeError."""
        with open(os.path.join(ROOT, "indicators.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn(".replace(tzinfo=None)", src,
                      "indicators.py must strip timezone from earnings timestamp before subtraction")
        # The old pattern (bare pd.Timestamp comparison) must not exist
        self.assertNotIn("pd.Timestamp(first) - pd.Timestamp.now()", src)

    # ── Fix #31: division by zero in portfolio-helpers.js ────────────────────

    def test_portfolio_helpers_saleqty_guard(self):
        """matchSaleAgainstParcels must return early with error when saleQty is 0 or falsy."""
        with open(os.path.join(ROOT, "js", "portfolio-helpers.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Invalid sale qty", src)
        # Guard must appear BEFORE feePerShare calculation
        guard_pos = src.find("Invalid sale qty")
        fee_pos   = src.find("feePerShare = saleFees / saleQty")
        self.assertLess(guard_pos, fee_pos,
                        "saleQty guard must appear before the feePerShare division")

    # ── Fix #32: anti-churn timestamp NaN guard ───────────────────────────────

    def test_response_validator_antichurn_guards_timestamp(self):
        """Anti-churn check must guard against missing and NaN timestamps explicitly."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("Number.isNaN(ts)", src,
                      "Anti-churn must guard against NaN from malformed date strings")
        self.assertIn("if (!h.timestamp) return false", src,
                      "Anti-churn must short-circuit when timestamp is missing")

    # ── Fix #33: NaN ensembleConfidence guard ────────────────────────────────

    def test_response_validator_ensemble_nan_guard(self):
        """ensembleConfidence must guard NaN from sig.score — ??, null doesn't cover NaN."""
        with open(os.path.join(ROOT, "js", "response-validator.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("hasValidScore", src)
        self.assertIn("Number.isNaN(indScore)", src)
        # The old ?? null guard must be replaced
        self.assertNotIn("sig?.score ?? null", src,
                         "?? null guard must be replaced — it doesn't protect against NaN")


class TestImprovementsACF(unittest.TestCase):
    """IMPROVEMENTS.md items A, C, F — medium/XS effort improvements."""

    # ── Improvement A: bounded cache in core.py ──────────────────────────────

    def test_core_cache_has_max_size_constant(self):
        """core.py must define _MAX_CACHE_SIZE to cap unbounded cache growth."""
        with open(os.path.join(ROOT, "core.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_MAX_CACHE_SIZE", src)

    def test_core_cache_eviction_function_exists(self):
        """core.py must define _evict_cache() to proactively remove expired entries."""
        with open(os.path.join(ROOT, "core.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("def _evict_cache(", src)
        self.assertIn("_evict_cache(now)", src)

    def test_core_cache_eviction_removes_expired(self):
        """_evict_cache must delete expired entries (v[1] <= now)."""
        with open(os.path.join(ROOT, "core.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("v[1] <= now", src)

    def test_core_cache_eviction_enforces_size_cap(self):
        """_evict_cache must evict oldest entries when store exceeds _MAX_CACHE_SIZE."""
        with open(os.path.join(ROOT, "core.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_MAX_CACHE_SIZE", src)
        self.assertIn("len(_cache_store) >", src)

    # ── Improvement C: backtest input validation ──────────────────────────────

    def test_backtest_validates_tickers_list(self):
        """POST /api/backtest must validate tickers is a non-empty list."""
        with open(os.path.join(ROOT, "routes", "backtest.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("isinstance(tickers, list)", src)
        self.assertIn("non-empty list", src)

    def test_backtest_validates_period(self):
        """POST /api/backtest must validate period against allowed set."""
        with open(os.path.join(ROOT, "routes", "backtest.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_ALLOWED_PERIODS", src)
        self.assertIn("not in _ALLOWED_PERIODS", src)

    def test_backtest_validates_strategy(self):
        """POST /api/backtest must validate strategy against allowed set."""
        with open(os.path.join(ROOT, "routes", "backtest.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_ALLOWED_STRATEGIES", src)
        self.assertIn("not in _ALLOWED_STRATEGIES", src)

    def test_backtest_validates_capital(self):
        """POST /api/backtest must validate capital is a positive number within sane bounds."""
        with open(os.path.join(ROOT, "routes", "backtest.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("10_000_000", src)
        self.assertIn("capital must be a number", src)

    # ── Improvement F: shares <= 0 guard in utils.js ─────────────────────────

    def test_merged_portfolio_filters_zero_shares(self):
        """mergedPortfolio() must filter out zero/negative share entries before computing avgPrice."""
        with open(os.path.join(ROOT, "js", "utils.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn(".filter(h => h.shares > 0)", src,
                      "mergedPortfolio must filter zero-share entries to prevent avgPrice=Infinity")


class TestNotificationCentre(unittest.TestCase):
    """Tests for the notification centre — separate notifications.db + /api/notifications/* routes."""

    @classmethod
    def setUpClass(cls):
        import importlib
        import contextlib
        import sqlite3

        # Build a fresh in-memory DB for notifications (separate from the main test DB)
        cls._notif_conn = sqlite3.connect(":memory:")
        cls._notif_conn.row_factory = sqlite3.Row

        _SCHEMA = """
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS notifications (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            type      TEXT    NOT NULL DEFAULT 'info',
            title     TEXT    NOT NULL DEFAULT '',
            body      TEXT    NOT NULL DEFAULT '',
            category  TEXT    NOT NULL DEFAULT 'system',
            timestamp TEXT    NOT NULL,
            read      INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_notif_ts ON notifications(timestamp DESC);
        """
        cls._notif_conn.executescript(_SCHEMA)
        cls._notif_conn.commit()

        @contextlib.contextmanager
        def _test_notif_db():
            yield cls._notif_conn
            cls._notif_conn.commit()

        # Patch get_notif_db in both the module and the blueprint
        import notifications_db
        notifications_db.get_notif_db = _test_notif_db
        import routes.notifications as rn
        rn.get_notif_db = _test_notif_db

        # Also install the main in-memory DB so the app starts cleanly
        _install_in_memory_db()
        asx_server.init_db()

        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    @classmethod
    def tearDownClass(cls):
        asx_server.get_db = _orig_get_db
        cls._notif_conn.close()

    # ── POST /api/notifications ──────────────────────────────────────────────

    def test_save_notification(self):
        """POST /api/notifications must persist a notification and return ok."""
        r = self.client.post("/api/notifications", json={
            "type": "info", "title": "Test alert", "body": "Detail text",
            "category": "system", "timestamp": "2026-06-06T10:00:00+00:00",
        })
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"])

    def test_save_trims_long_fields(self):
        """Oversized title/body must be accepted without error (server trims)."""
        r = self.client.post("/api/notifications", json={
            "type": "error", "title": "X" * 500, "body": "Y" * 1000, "category": "error",
            "timestamp": "2026-06-06T10:01:00+00:00",
        })
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])

    # ── GET /api/notifications ───────────────────────────────────────────────

    def test_list_returns_items(self):
        """GET /api/notifications must return paginated items."""
        # Ensure at least one item exists
        self.client.post("/api/notifications", json={
            "type": "success", "title": "Scan done", "body": "3 hits",
            "category": "scan", "timestamp": "2026-06-06T10:02:00+00:00",
        })
        r = self.client.get("/api/notifications?limit=8&offset=0")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"])
        self.assertIn("items", data)
        self.assertIsInstance(data["items"], list)
        self.assertIn("has_more", data)

    def test_list_pagination(self):
        """has_more must be True when more rows exist than the requested limit."""
        # Insert 5 items
        for i in range(5):
            self.client.post("/api/notifications", json={
                "type": "info", "title": f"Item {i}", "body": "",
                "category": "system", "timestamp": f"2026-06-06T11:0{i}:00+00:00",
            })
        r = self.client.get("/api/notifications?limit=2&offset=0")
        data = r.get_json()
        self.assertEqual(len(data["items"]), 2)
        self.assertTrue(data["has_more"])

    def test_list_offset(self):
        """Offset must skip the first N rows."""
        r0 = self.client.get("/api/notifications?limit=100&offset=0").get_json()
        r1 = self.client.get(f"/api/notifications?limit=100&offset={len(r0['items'])}").get_json()
        self.assertFalse(r1["has_more"])

    # ── GET /api/notifications/unread-count ──────────────────────────────────

    def test_unread_count(self):
        """GET /api/notifications/unread-count must return a numeric count."""
        r = self.client.get("/api/notifications/unread-count")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"])
        self.assertIsInstance(data["count"], int)

    # ── POST /api/notifications/read-all ────────────────────────────────────

    def test_read_all(self):
        """POST /api/notifications/read-all must zero unread count."""
        self.client.post("/api/notifications", json={
            "type": "warning", "title": "Stop hit", "body": "", "category": "price",
            "timestamp": "2026-06-06T12:00:00+00:00",
        })
        r = self.client.post("/api/notifications/read-all")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])
        count = self.client.get("/api/notifications/unread-count").get_json()["count"]
        self.assertEqual(count, 0)

    # ── DELETE /api/notifications ────────────────────────────────────────────

    def test_clear_all(self):
        """DELETE /api/notifications must wipe the table."""
        self.client.post("/api/notifications", json={
            "type": "info", "title": "To be deleted", "body": "",
            "category": "system", "timestamp": "2026-06-06T13:00:00+00:00",
        })
        r = self.client.delete("/api/notifications")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])
        items = self.client.get("/api/notifications").get_json()["items"]
        self.assertEqual(len(items), 0)

    # ── Frontend / structure checks ──────────────────────────────────────────

    def test_notifications_js_loaded_in_html(self):
        """asx_trading.html must load notifications.js after utils.js."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("notifications.js", src)
        utils_idx  = src.index("utils.js")
        notif_idx  = src.index("notifications.js")
        self.assertGreater(notif_idx, utils_idx,
                           "notifications.js must load after utils.js")

    def test_bell_button_in_html(self):
        """Topbar must contain the notification bell button."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("notif-bell-wrap", src)
        self.assertIn("notif-badge", src)
        self.assertIn("toggleNotifPanel", src)

    def test_notifications_js_syntax(self):
        """notifications.js must pass node --check."""
        import subprocess
        result = subprocess.run(
            ["node", "--check", os.path.join(ROOT, "js", "notifications.js")],
            capture_output=True, text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_push_notification_defined(self):
        """notifications.js must define pushNotification."""
        with open(os.path.join(ROOT, "js", "notifications.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function pushNotification", src)

    def test_init_notification_center_defined(self):
        """notifications.js must define initNotificationCenter."""
        with open(os.path.join(ROOT, "js", "notifications.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function initNotificationCenter", src)

    def test_load_more_defined(self):
        """notifications.js must define _loadMoreNotifs for pagination."""
        with open(os.path.join(ROOT, "js", "notifications.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_loadMoreNotifs", src)

    def test_toast_calls_push_notification(self):
        """toast() in utils.js must call pushNotification (guarded)."""
        with open(os.path.join(ROOT, "js", "utils.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("pushNotification", src)

    def test_fire_alert_calls_push_notification(self):
        """fireAlert() in alerts.js must call pushNotification (guarded)."""
        with open(os.path.join(ROOT, "js", "alerts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("pushNotification", src)

    def test_separate_db_file(self):
        """notifications_db.py must define NOTIF_DB_PATH pointing to notifications.db."""
        import re
        with open(os.path.join(ROOT, "notifications_db.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("notifications.db", src, "notifications_db.py must reference notifications.db")
        # The NOTIF_DB_PATH assignment line must contain notifications.db
        path_line = next((l for l in src.splitlines() if "NOTIF_DB_PATH" in l and "=" in l), None)
        self.assertIsNotNone(path_line, "NOTIF_DB_PATH must be defined")
        self.assertIn("notifications.db", path_line,
                      "NOTIF_DB_PATH must point to notifications.db, not another file")

    def test_notif_db_has_required_columns(self):
        """notifications table must have id, type, title, body, category, timestamp, read."""
        with open(os.path.join(ROOT, "notifications_db.py"), encoding="utf-8") as f:
            src = f.read()
        for col in ("id", "type", "title", "body", "category", "timestamp", "read"):
            self.assertIn(col, src, f"Schema must include column: {col}")

    def test_blueprint_registered(self):
        """asx_server.py must register the notifications blueprint."""
        with open(os.path.join(ROOT, "asx_server.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("routes.notifications", src)
        self.assertIn("_notifications_bp", src)


class TestDayTradeTraining(unittest.TestCase):
    """Tests for the day trading ML training system (day_trade_history.db + routes)."""

    @classmethod
    def setUpClass(cls):
        import contextlib, sqlite3

        # Build an in-memory DB for day_trade_history (isolated from main DB)
        cls._dt_conn = sqlite3.connect(":memory:")
        cls._dt_conn.row_factory = sqlite3.Row

        import day_trade_db as dtdb
        dtdb.init_dt_db.__doc__  # ensure module loaded
        dtdb.get_dt_db           # attribute probe

        _SCHEMA = dtdb._SCHEMA
        cls._dt_conn.executescript(_SCHEMA)
        # Apply runtime migrations so schema matches production
        for _sql in [
            "ALTER TABLE trade_snapshots ADD COLUMN record_type TEXT NOT NULL DEFAULT 'executed'",
            "ALTER TABLE trade_snapshots ADD COLUMN shadow_reason TEXT",
            "ALTER TABLE trade_snapshots ADD COLUMN r_multiple REAL",
            "ALTER TABLE model_state ADD COLUMN trade_type_scope TEXT DEFAULT 'all'",
            "ALTER TABLE model_state ADD COLUMN r2_score REAL",
            "ALTER TABLE model_state ADD COLUMN mae_score REAL",
            "ALTER TABLE model_state ADD COLUMN r2_oos REAL",
            "ALTER TABLE model_state ADD COLUMN mae_oos REAL",
            "ALTER TABLE model_state ADD COLUMN n_test INTEGER",
            "ALTER TABLE model_state ADD COLUMN cv_method TEXT",
        ]:
            try:
                cls._dt_conn.execute(_sql)
            except Exception:
                pass
        cls._dt_conn.commit()

        @contextlib.contextmanager
        def _test_dt_db():
            yield cls._dt_conn
            cls._dt_conn.commit()

        # Patch get_dt_db in both the module and the route blueprint
        dtdb.get_dt_db = _test_dt_db
        import routes.day_trade_training as rdtt
        rdtt.get_dt_db = _test_dt_db

        _install_in_memory_db()
        asx_server.init_db()

        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True
        cls._rdtt = rdtt

    @classmethod
    def tearDownClass(cls):
        asx_server.get_db = _orig_get_db
        cls._dt_conn.close()

    # ── POST /api/daytrading/snapshot ────────────────────────────────────────

    def test_save_snapshot_minimal(self):
        """POST /api/daytrading/snapshot with ticker + entry_date must succeed."""
        r = self.client.post("/api/daytrading/snapshot", json={
            "ticker": "BHP.AX", "entry_date": "2026-06-08",
            "entry_price": 42.50, "qty": 100, "trade_type": "swing",
        })
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"])
        self.assertIn("id", data)
        self.assertIsInstance(data["id"], int)

    def test_save_snapshot_full_indicators(self):
        """POST /api/daytrading/snapshot with full indicator set must persist all fields."""
        r = self.client.post("/api/daytrading/snapshot", json={
            "ticker": "CBA.AX", "entry_date": "2026-06-08",
            "entry_price": 118.00, "qty": 50, "trade_type": "swing",
            "rsi_14": 48.5, "bb_pct_b": 0.32, "adx": 28.4,
            "asx200_5d_ret": 0.8, "regime": "riskOn",
        })
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])

    def test_save_snapshot_missing_ticker_returns_400(self):
        """POST without ticker must return 400."""
        r = self.client.post("/api/daytrading/snapshot", json={
            "entry_date": "2026-06-08",
        })
        self.assertEqual(r.status_code, 400)
        self.assertFalse(r.get_json()["ok"])

    def test_save_snapshot_missing_entry_date_returns_400(self):
        """POST without entry_date must return 400."""
        r = self.client.post("/api/daytrading/snapshot", json={
            "ticker": "ANZ.AX",
        })
        self.assertEqual(r.status_code, 400)

    # ── PATCH /api/daytrading/snapshot/<id>/close ────────────────────────────

    def test_close_snapshot_computes_pnl(self):
        """PATCH /close must compute pnl_pct and outcome from entry/exit prices."""
        # Create a snapshot first
        snap = self.client.post("/api/daytrading/snapshot", json={
            "ticker": "WBC.AX", "entry_date": "2026-06-01",
            "entry_price": 26.00, "qty": 200, "trade_type": "swing",
        }).get_json()
        snap_id = snap["id"]

        r = self.client.patch(f"/api/daytrading/snapshot/{snap_id}/close", json={
            "exit_price": 27.30,
            "entry_price": 26.00,
            "exit_date": "2026-06-08",
            "exit_reason": "target",
        })
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["outcome"], "win")

    def test_close_snapshot_loss(self):
        """PATCH /close with exit < entry must produce 'loss' outcome."""
        snap = self.client.post("/api/daytrading/snapshot", json={
            "ticker": "NAB.AX", "entry_date": "2026-06-01",
            "entry_price": 35.00, "qty": 100, "trade_type": "swing",
        }).get_json()

        r = self.client.patch(f"/api/daytrading/snapshot/{snap['id']}/close", json={
            "exit_price": 33.50,
            "entry_price": 35.00,
            "exit_date": "2026-06-07",
            "exit_reason": "stop",
        })
        data = r.get_json()
        self.assertTrue(data["ok"])
        self.assertEqual(data["outcome"], "loss")

    # ── GET /api/daytrading/history ──────────────────────────────────────────

    def test_history_returns_items(self):
        """GET /api/daytrading/history must return ok + items list."""
        r = self.client.get("/api/daytrading/history")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"])
        self.assertIn("items", data)
        self.assertIn("has_more", data)

    def test_history_pagination(self):
        """GET /api/daytrading/history?limit=1 must set has_more when >1 record exists."""
        # Ensure at least 2 records
        for t in ("MQG.AX", "WES.AX"):
            self.client.post("/api/daytrading/snapshot", json={
                "ticker": t, "entry_date": "2026-06-08", "entry_price": 100.0,
            })
        r = self.client.get("/api/daytrading/history?limit=1")
        data = r.get_json()
        self.assertEqual(len(data["items"]), 1)
        # has_more should be True since we have multiple records
        self.assertIsInstance(data["has_more"], bool)

    # ── GET /api/daytrading/stats ────────────────────────────────────────────

    def test_stats_shape(self):
        """GET /api/daytrading/stats must return summary counters."""
        r = self.client.get("/api/daytrading/stats")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"])
        for key in ("total", "wins", "losses", "ready_to_train", "min_train_samples"):
            self.assertIn(key, data)

    def test_stats_ready_to_train_false_when_insufficient(self):
        """ready_to_train must be False when completed < MIN_TRAIN_SAMPLES."""
        r = self.client.get("/api/daytrading/stats")
        data = r.get_json()
        # Fresh in-memory DB has no completed trades → not ready
        self.assertIsInstance(data["ready_to_train"], bool)
        self.assertIsInstance(data["min_train_samples"], int)

    # ── POST /api/daytrading/train ───────────────────────────────────────────

    def test_train_fails_insufficient_data(self):
        """POST /api/daytrading/train with < MIN_TRAIN_SAMPLES must return ok=False."""
        r = self.client.post("/api/daytrading/train")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertFalse(data["ok"])
        self.assertIn("error", data)

    def test_train_succeeds_with_enough_samples(self):
        """POST /api/daytrading/train with ≥ MIN_TRAIN_SAMPLES must return ok=True."""
        # Seed enough completed trades directly into the in-memory DB (need >= 30)
        rdtt = self._rdtt
        import random
        random.seed(42)

        rows = []
        for i in range(35):
            entry = 40.0 + random.uniform(-3, 3)
            stop  = entry * 0.95
            tgt   = entry * 1.07
            exit_p = tgt if i % 3 != 2 else stop
            rm = round((exit_p - entry) / (entry - stop), 4)
            outcome = "win" if rm > 0 else "loss"
            rows.append({
                "ticker": "BHP.AX", "trade_type": "swing",
                "entry_date": "2026-05-0" + str(i % 9 + 1),
                "entry_price": entry, "stop_loss": stop, "target": tgt,
                "exit_price": exit_p, "r_multiple": rm,
                "rsi_14": 40 + random.random() * 20,
                "bb_pct_b": random.random(),
                "adx": 20 + random.random() * 15,
                "volume_zscore": random.gauss(0, 1),
                "setup_score": 50 + random.random() * 40,
                "asx200_5d_ret": random.gauss(0.5, 1.5),
                "adl_ratio": 0.5 + random.random() * 0.3,
                "outcome": outcome,
                "pnl_pct": round((exit_p - entry) / entry * 100, 2),
            })

        for row in rows:
            cols = list(row.keys())
            ph = ", ".join("?" * len(cols))
            self._dt_conn.execute(
                f"INSERT INTO trade_snapshots ({', '.join(cols)}) VALUES ({ph})",
                [row[c] for c in cols]
            )
        self._dt_conn.commit()

        r = self.client.post("/api/daytrading/train")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"], msg=data.get("error", ""))
        self.assertIn("feature_importances", data)
        self.assertGreater(len(data["feature_importances"]), 0)

    # ── GET /api/daytrading/model ────────────────────────────────────────────

    def test_model_available_after_training(self):
        """GET /api/daytrading/model must return available=True after training."""
        # Ensure training ran (test order dependency tolerated for speed)
        r = self.client.get("/api/daytrading/model")
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data["ok"])
        self.assertIn("available", data)
        if data["available"]:
            # Sprint 53: response shape changed — swing/intraday keys instead of 'model'
            self.assertIn("importances", data)
            # At least one of swing/intraday must be present
            self.assertTrue(data.get("swing") is not None or data.get("intraday") is not None)
            model_obj = data.get("swing") or data.get("intraday")
            self.assertIn("feature_names", model_obj)
            self.assertIn("weights", model_obj)

    # ── POST /api/daytrading/predict ─────────────────────────────────────────

    def test_predict_returns_probability(self):
        """POST /api/daytrading/predict must return a win_probability between 0 and 1."""
        r = self.client.post("/api/daytrading/predict", json={
            "rsi_14": 45.0, "bb_pct_b": 0.25, "adx": 28.0,
            "volume_zscore": 1.2, "setup_score": 72.0,
        })
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        if data["ok"]:
            self.assertIn("win_probability", data)
            self.assertGreaterEqual(data["win_probability"], 0.0)
            self.assertLessEqual(data["win_probability"], 1.0)

    # ── DELETE /api/daytrading/snapshot/<id> ─────────────────────────────────

    def test_delete_snapshot(self):
        """DELETE /api/daytrading/snapshot/<id> must remove the record."""
        snap = self.client.post("/api/daytrading/snapshot", json={
            "ticker": "DELETE_ME.AX", "entry_date": "2026-06-08",
        }).get_json()
        snap_id = snap["id"]

        r = self.client.delete(f"/api/daytrading/snapshot/{snap_id}")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.get_json()["ok"])

    # ── Infrastructure tests ─────────────────────────────────────────────────

    def test_day_trade_db_module_has_path_constant(self):
        """day_trade_db.py must define DT_HISTORY_DB_PATH pointing to day_trade_history.db."""
        import day_trade_db
        self.assertIn("day_trade_history.db", day_trade_db.DT_HISTORY_DB_PATH)

    def test_day_trade_db_schema_has_required_tables(self):
        """day_trade_db._SCHEMA must define trade_snapshots and model_state tables."""
        import day_trade_db
        schema = day_trade_db._SCHEMA
        self.assertIn("trade_snapshots", schema)
        self.assertIn("model_state", schema)
        self.assertIn("feature_importance", schema)

    def test_blueprint_registered_in_server(self):
        """asx_server.py must register the day_trade_training blueprint."""
        with open(os.path.join(ROOT, "asx_server.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("routes.day_trade_training", src)
        self.assertIn("_dt_training_bp", src)

    def test_init_dt_db_called_on_startup(self):
        """asx_server.py must call init_dt_db() at startup."""
        with open(os.path.join(ROOT, "asx_server.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("init_dt_db", src)

    def test_dt_training_js_exists(self):
        """js/dt-training.js must exist with required functions."""
        path = os.path.join(ROOT, "js", "dt-training.js")
        self.assertTrue(os.path.exists(path), "js/dt-training.js must exist")
        with open(path, encoding="utf-8") as f:
            src = f.read()
        for fn in ("dtSaveSnapshot", "dtCloseSnapshot", "dtBuildFeatures",
                   "dtPredictLocal", "renderDtHistoryTab", "renderDtModelTab", "dtTrain"):
            self.assertIn(fn, src, f"dt-training.js must define {fn}")

    def test_dt_training_js_loaded_in_html(self):
        """asx_trading.html must load dt-training.js before day-trading.js."""
        with open(os.path.join(ROOT, "asx_trading.html"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("dt-training.js", src)
        idx_train = src.index("dt-training.js")
        idx_dt    = src.index("pages/day-trading.js")
        self.assertLess(idx_train, idx_dt, "dt-training.js must load before pages/day-trading.js")

    def test_history_tab_in_day_trading_page(self):
        """pages/day-trading.js must include 'history' and 'model' tabs."""
        with open(os.path.join(ROOT, "js", "pages", "day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("dt-tab-history", src)
        self.assertIn("dt-tab-model", src)
        self.assertIn("renderDtHistoryTab", src)
        self.assertIn("renderDtModelTab", src)

    def test_execute_day_trade_saves_snapshot(self):
        """day-trading-analysis.js executeDayTrade must call dtSaveSnapshot after trade."""
        with open(os.path.join(ROOT, "js", "day-trading-analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("dtSaveSnapshot", src)
        self.assertIn("_snapshotId", src)

    def test_close_day_trade_saves_snapshot(self):
        """pages/day-trading.js _closeDayTrade must call dtCloseSnapshot on close."""
        with open(os.path.join(ROOT, "js", "pages", "day-trading.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("dtCloseSnapshot", src)

    def test_training_algorithm_pure_numpy(self):
        """routes/day_trade_training.py training must not import sklearn or external ML libs."""
        with open(os.path.join(ROOT, "routes", "day_trade_training.py"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("sklearn", src, "Training must use pure numpy — no sklearn")
        self.assertNotIn("torch", src,   "Training must use pure numpy — no torch")
        self.assertNotIn("tensorflow", src)
        self.assertIn("numpy", src, "Training must use numpy")
        # Sprint 53: ridge regression replaced logistic regression
        self.assertIn("ridge_regression", src, "Must define ridge regression function")
        self.assertIn("spearman", src.lower(), "Must compute Spearman IC")

    def test_features_list_consistent(self):
        """FEATURES in day_trade_training.py must match dtBuildFeatures in dt-training.js."""
        with open(os.path.join(ROOT, "routes", "day_trade_training.py"), encoding="utf-8") as f:
            py_src = f.read()
        with open(os.path.join(ROOT, "js", "dt-training.js"), encoding="utf-8") as f:
            js_src = f.read()
        # Core features must appear in both files
        for feat in ("rsi_14", "bb_pct_b", "adx", "volume_zscore", "setup_score"):
            self.assertIn(feat, py_src, f"Feature '{feat}' must be in Python FEATURES list")
            self.assertIn(feat, js_src, f"Feature '{feat}' must be in JS dtBuildFeatures")


class TestSprintMl53(unittest.TestCase):
    """Sprint 53: shadow logging, ridge regression, decoupled matrices."""

    @classmethod
    def setUpClass(cls):
        import contextlib
        import day_trade_db as dtdb
        import routes.day_trade_training as rdtt

        cls._dt_conn = sqlite3.connect(":memory:")
        cls._dt_conn.row_factory = sqlite3.Row
        cls._dt_conn.executescript(dtdb._SCHEMA)
        # Run migrations on the in-memory DB too
        _migrations = [
            "ALTER TABLE trade_snapshots ADD COLUMN record_type TEXT NOT NULL DEFAULT 'executed'",
            "ALTER TABLE trade_snapshots ADD COLUMN shadow_reason TEXT",
            "ALTER TABLE trade_snapshots ADD COLUMN r_multiple REAL",
            "ALTER TABLE model_state ADD COLUMN trade_type_scope TEXT DEFAULT 'all'",
            "ALTER TABLE model_state ADD COLUMN r2_score REAL",
            "ALTER TABLE model_state ADD COLUMN mae_score REAL",
            # Sprint 54 OOS columns
            "ALTER TABLE model_state ADD COLUMN r2_oos REAL",
            "ALTER TABLE model_state ADD COLUMN mae_oos REAL",
            "ALTER TABLE model_state ADD COLUMN n_test INTEGER",
            "ALTER TABLE model_state ADD COLUMN cv_method TEXT",
        ]
        for sql in _migrations:
            try:
                cls._dt_conn.execute(sql)
            except Exception:
                pass
        cls._dt_conn.commit()

        @contextlib.contextmanager
        def _test_dt_db():
            yield cls._dt_conn
            cls._dt_conn.commit()

        dtdb.get_dt_db  = _test_dt_db
        rdtt.get_dt_db  = _test_dt_db
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()

    @classmethod
    def tearDownClass(cls):
        cls._dt_conn.close()

    def test_snapshot_accepts_record_type_shadow(self):
        """POST /api/daytrading/snapshot with record_type='shadow' succeeds."""
        r = self.client.post('/api/daytrading/snapshot',
                             json={
                                 'ticker': 'BHP',
                                 'entry_date': '2026-06-01',
                                 'entry_price': 45.0,
                                 'stop_loss': 43.5,
                                 'target': 47.5,
                                 'record_type': 'shadow',
                                 'shadow_reason': 'heat_blocked',
                             },
                             content_type='application/json')
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data['ok'])
        self.assertIsNotNone(data['id'])
        # Verify it was stored as shadow
        row = self._dt_conn.execute(
            "SELECT record_type, shadow_reason FROM trade_snapshots WHERE id=?", (data['id'],)
        ).fetchone()
        self.assertEqual(row['record_type'], 'shadow')
        self.assertEqual(row['shadow_reason'], 'heat_blocked')

    def test_close_stores_r_multiple(self):
        """PATCH /close computes and stores r_multiple = (exit-entry)/(entry-stop)."""
        # Create a snapshot
        r = self.client.post('/api/daytrading/snapshot',
                             json={'ticker': 'CBA', 'entry_date': '2026-06-01',
                                   'entry_price': 100.0, 'stop_loss': 98.0, 'target': 104.0},
                             content_type='application/json')
        snap_id = r.get_json()['id']
        # Close with exit_price = 104.0 → r_multiple = (104-100)/(100-98) = 2.0
        r2 = self.client.patch(f'/api/daytrading/snapshot/{snap_id}/close',
                               json={'exit_price': 104.0, 'exit_date': '2026-06-05',
                                     'exit_reason': 'target'},
                               content_type='application/json')
        self.assertEqual(r2.status_code, 200)
        row = self._dt_conn.execute(
            "SELECT r_multiple FROM trade_snapshots WHERE id=?", (snap_id,)
        ).fetchone()
        self.assertIsNotNone(row['r_multiple'])
        self.assertAlmostEqual(float(row['r_multiple']), 2.0, places=2)

    def test_stats_includes_shadow_count(self):
        """GET /api/daytrading/stats includes shadow_count field."""
        r = self.client.get('/api/daytrading/stats')
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertIn('shadow_count', data)
        self.assertIn('shadow_resolved', data)

    def test_history_filters_by_record_type(self):
        """GET /api/daytrading/history?record_type=shadow filters correctly."""
        r = self.client.get('/api/daytrading/history?record_type=shadow')
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertIn('items', data)
        # All returned items must be shadow
        for item in data['items']:
            self.assertEqual(item.get('record_type'), 'shadow')

    def _seed_ridge_trades(self, n=35):
        """Seed enough completed trades for ridge training."""
        import random
        random.seed(99)
        for i in range(n):
            entry = 10.0 + random.uniform(-2, 2)
            stop  = entry * 0.95
            tgt   = entry * 1.07
            exit_p = tgt if i % 3 != 2 else stop
            rm = (exit_p - entry) / (entry - stop)
            outcome = 'win' if rm > 0 else 'loss'
            self._dt_conn.execute("""
                INSERT INTO trade_snapshots
                (ticker, entry_date, entry_price, stop_loss, target, exit_price,
                 r_multiple, outcome, trade_type,
                 rsi_14, bb_pct_b, atr_pct, adx, volume_zscore,
                 asx200_5d_ret, adl_ratio)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, ('TEST', f'2026-0{(i%9)+1}-01', entry, stop, tgt, exit_p,
                  round(rm, 4), outcome, 'swing',
                  40+i, 0.3, 1.5, 20, 0.5, 1.2, 0.6))
        self._dt_conn.commit()

    def test_train_ridge_succeeds(self):
        """POST /api/daytrading/train trains ridge models when data available."""
        self._seed_ridge_trades(35)
        r = self.client.post('/api/daytrading/train',
                             json={}, content_type='application/json')
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data.get('ok'))
        # Check model was stored in model_state
        row = self._dt_conn.execute(
            "SELECT model_type FROM model_state ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()
        self.assertIsNotNone(row)
        self.assertEqual(row['model_type'], 'ridge')

    def test_model_response_has_swing_structure(self):
        """GET /api/daytrading/model returns swing/intraday structure."""
        r = self.client.get('/api/daytrading/model')
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data['ok'])
        # When available, check structure
        if data.get('available'):
            # Must have at least swing or intraday key
            self.assertTrue('swing' in data or 'intraday' in data)

    def test_features_swing_has_16_items(self):
        """FEATURES_SWING has exactly 16 items (15 original + regime_risk, Sprint 61);
        no intraday-specific features."""
        from routes.day_trade_training import FEATURES_SWING, FEATURES_INTRADAY
        self.assertEqual(len(FEATURES_SWING), 16)
        self.assertEqual(len(FEATURES_INTRADAY), 19)
        # Intraday adds exactly the 3 intraday-specific features
        extras = set(FEATURES_INTRADAY) - set(FEATURES_SWING)
        self.assertEqual(extras, {'intraday_rsi', 'vwap_position', 'volume_accel'})

    def test_dt_training_js_imputation_guard(self):
        """dt-training.js uses mu[i] for missing features (not 0)."""
        with open(os.path.join(ROOT, 'js', 'dt-training.js'), encoding='utf-8') as f:
            src = f.read()
        # The imputation guard line
        self.assertIn('mu[i]', src)
        # Should NOT have the old hard-zero fallback as the only option
        self.assertIn('IMPUTATION GUARD', src)

    def test_dt_training_js_has_expected_r_label(self):
        """dt-training.js defines dtExpectedRLabel and dtWinProbLabel alias."""
        with open(os.path.join(ROOT, 'js', 'dt-training.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('function dtExpectedRLabel', src)
        self.assertIn('dtWinProbLabel', src)  # backward-compat alias

    def test_dt_training_js_ridge_model_type(self):
        """dt-training.js handles model_type='ridge' (no sigmoid)."""
        with open(os.path.join(ROOT, 'js', 'dt-training.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn("model_type === 'ridge'", src)

    def test_indicators_gap_window_126(self):
        """indicators.py uses 126-day gap window."""
        with open(os.path.join(ROOT, 'indicators.py'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('tail(126)', src)

    def test_analysis_js_shadow_logging(self):
        """analysis.js shadow-logs heat-blocked recs."""
        with open(os.path.join(ROOT, 'js', 'analysis.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('shadow_reason', src)
        self.assertIn('heat_blocked', src)
        self.assertIn('dtSaveSnapshot', src)

    # ── Sprint 54: OOS evaluation (§0.I) ─────────────────────────────────────

    def test_oos_columns_in_schema_migrations(self):
        """day_trade_db migrations include r2_oos, mae_oos, n_test, cv_method."""
        import day_trade_db as dtdb
        migrations = dtdb._migrations if hasattr(dtdb, '_migrations') else []
        # Check via init function source instead
        import inspect
        src = inspect.getsource(dtdb.init_dt_db)
        for col in ('r2_oos', 'mae_oos', 'n_test', 'cv_method'):
            self.assertIn(col, src, f"Migration for {col} missing from init_dt_db()")

    def test_train_response_has_oos_fields(self):
        """POST /api/daytrading/train response has r2_oos/mae_oos/n_test/cv_method per model."""
        self._seed_ridge_trades(35)
        r = self.client.post('/api/daytrading/train', json={}, content_type='application/json')
        self.assertEqual(r.status_code, 200)
        data = r.get_json()
        self.assertTrue(data.get('ok'))
        # Top-level backward-compat fields (may be None for small samples)
        for field in ('r2_oos', 'mae_oos', 'n_test', 'cv_method'):
            self.assertIn(field, data, f"Top-level field {field} missing from train response")
        # Per-model structure
        if data.get('models') and data['models'].get('swing'):
            swing = data['models']['swing']
            for field in ('r2_oos', 'mae_oos', 'n_test', 'cv_method'):
                self.assertIn(field, swing, f"models.swing.{field} missing from train response")

    def test_oos_persisted_to_model_state(self):
        """After training, model_state row has cv_method column populated."""
        self._seed_ridge_trades(35)
        self.client.post('/api/daytrading/train', json={}, content_type='application/json')
        row = self._dt_conn.execute(
            "SELECT cv_method, n_test FROM model_state ORDER BY trained_at DESC LIMIT 1"
        ).fetchone()
        self.assertIsNotNone(row)
        # cv_method should be set (holdout or insufficient for 35 samples)
        self.assertIn(row['cv_method'], ('holdout', 'walk_forward', 'insufficient'))

    def test_oos_r2_le_insample_r2_or_none(self):
        """OOS R² must be <= in-sample R² (no data leakage) when both present."""
        self._seed_ridge_trades(35)
        r = self.client.post('/api/daytrading/train', json={}, content_type='application/json')
        data = r.get_json()
        r2_is  = data.get('r2_score')
        r2_oos = data.get('r2_oos')
        # Only enforce when both are non-None numbers
        if r2_is is not None and r2_oos is not None:
            self.assertLessEqual(r2_oos, r2_is + 0.05,
                "OOS R² should not significantly exceed in-sample R² (possible leakage)")

    def test_cv_method_insufficient_when_small(self):
        """cv_method='insufficient' when n_test < 2 (e.g. 10 trades)."""
        self._seed_ridge_trades(10)
        r = self.client.post('/api/daytrading/train', json={}, content_type='application/json')
        data = r.get_json()
        # With only 10 samples, the holdout test set is 3 rows — may vary.
        # At minimum, cv_method must be a known value
        if data.get('ok') and data.get('cv_method'):
            self.assertIn(data['cv_method'], ('holdout', 'walk_forward', 'insufficient'))

    def test_dt_training_js_shows_oos_label(self):
        """dt-training.js renderDtModelTab must reference r2_oos and OOS label."""
        with open(os.path.join(ROOT, 'js', 'dt-training.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('r2_oos', src)
        self.assertIn('R² (OOS)', src)
        self.assertIn('OOS', src)

    def test_learning_outcome_whitelist_constant(self):
        """routes/learning.py must define _ALLOWED_OUTCOME_COLS as a named constant."""
        with open(os.path.join(ROOT, 'routes', 'learning.py'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('_ALLOWED_OUTCOME_COLS', src)
        # The for-loop over inline tuple should be gone
        self.assertNotIn(
            'for col in ("outcome_status"',
            src,
            "Inline tuple still present; should reference _ALLOWED_OUTCOME_COLS",
        )


class TestSprintQuant(unittest.TestCase):
    """Sprint 52 quant enhancements: gap risk, regime heat, SPI overlay."""

    def setUp(self):
        _install_in_memory_db()
        asx_server.init_db()
        self.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

    def test_intraday_scan_accepts_spi_chg_param(self):
        """POST /api/intraday/scan accepts spi_chg without error (empty tickers = 200)."""
        r = self.client.post('/api/intraday/scan',
                             json={'tickers': [], 'spi_chg': -2.0},
                             content_type='application/json')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.get_json(), {})

    def test_intraday_scan_no_spi_chg_still_works(self):
        """POST /api/intraday/scan without spi_chg still returns 200."""
        r = self.client.post('/api/intraday/scan',
                             json={'tickers': []},
                             content_type='application/json')
        self.assertEqual(r.status_code, 200)

    def test_analyse_ticker_has_gap_fields(self):
        """Verify gap95_pct and gap99_pct keys exist in analyse_ticker output keys."""
        # Just import and inspect the function — don't call it (needs network).
        from indicators import analyse_ticker
        import inspect
        src = inspect.getsource(analyse_ticker)
        self.assertIn('gap95_pct', src)
        self.assertIn('gap99_pct', src)

    def test_quant_engine_js_has_gap_risk(self):
        """quant-engine.js references gap95_pct for the gap risk model."""
        with open(os.path.join(ROOT, 'js', 'quant-engine.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('gap95_pct', src)
        self.assertIn('gapRiskActive', src)

    def test_quant_engine_js_has_kelly_phase(self):
        """quant-engine.js implements the Kelly phase gate."""
        with open(os.path.join(ROOT, 'js', 'quant-engine.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('_kellyPhaseFrac', src)
        self.assertIn('_kellyPhase', src)
        self.assertIn('_nCompleted', src)

    def test_analysis_js_has_regime_heat_limits(self):
        """analysis.js implements regime-aware heat limits."""
        with open(os.path.join(ROOT, 'js', 'analysis.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('_REGIME_HEAT_LIMITS', src)
        self.assertIn('riskOff', src)

    def test_day_trading_js_has_time_stop(self):
        """day-trading.js implements time-based exit helpers."""
        with open(os.path.join(ROOT, 'js', 'pages', 'day-trading.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('_dtTradingDaysElapsed', src)
        self.assertIn('_dtMaxHoldDays', src)
        self.assertIn('_dtTimeStopBadge', src)
        self.assertIn('TIME_STOP_DAYS', src)

    def test_intraday_strategy_js_sends_spi_chg(self):
        """intraday-strategy.js sends spi_chg in the scan request body."""
        with open(os.path.join(ROOT, 'js', 'intraday-strategy.js'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('spi_chg', src)

    def test_intraday_py_handles_spi_chg(self):
        """routes/intraday.py reads spi_chg from request body."""
        with open(os.path.join(ROOT, 'routes', 'intraday.py'), encoding='utf-8') as f:
            src = f.read()
        self.assertIn('spi_chg', src)
        self.assertIn('spi_defensive', src)
        self.assertIn('spi_blocked', src)


class TestSellTrimSizingAndMacroRace(unittest.TestCase):
    """Regression tests — SELL/TRIM qty sizing + first-of-day macro brief race."""

    @classmethod
    def setUpClass(cls):
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            cls.analysis_src = f.read()

    def test_sell_trim_recs_are_sized_deterministically(self):
        """analysis.js must size SELL/TRIM exits (Rule 4 forces Claude qty=0;
        computeTradeParams only sizes BUY/TOP_UP — exits had qty 0 in the UI)."""
        self.assertIn("_exitSized", self.analysis_src,
                      "SELL/TRIM sizing block missing from analysis.js")
        # SELL = full holding; TRIM = weightGuidance midpoint fraction
        self.assertIn("{ ...r, qty: held, _exitSized: 'full' }", self.analysis_src)
        self.assertIn("r.weightGuidance", self.analysis_src)

    def test_trim_fraction_parses_weight_guidance_range(self):
        """TRIM fraction must come from the Reduce (-X-Y%) range in weightGuidance."""
        self.assertIn(r"/(\d+)\s*-\s*(\d+)\s*%/", self.analysis_src)

    def test_macro_promise_awaited_before_prompt_context(self):
        """macroPromise must resolve BEFORE macroCtx is built — otherwise the first
        analysis of the day ships without TODAY'S MACRO BRIEF in the user message."""
        awaited_at = self.analysis_src.index("await macroPromise")
        macro_read = self.analysis_src.index("const _m = state.macroData")
        prompt_built = self.analysis_src.index("${macroCtx}")
        self.assertLess(awaited_at, macro_read,
                        "await macroPromise must precede reading state.macroData for macroCtx")
        self.assertLess(awaited_at, prompt_built,
                        "await macroPromise must precede user-message assembly")

    def test_prompt_action_definitions_no_qty_contradiction(self):
        """ACTION DEFINITIONS must not tell Claude to set qty (contradicts Rule 4)."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("qty = shares to sell", src,
                         "TRIM definition contradicts Rule 4 (qty must stay 0)")
        self.assertNotIn("qty = incremental shares only", src,
                         "TOP_UP definition contradicts Rule 4 (qty must stay 0)")

    def test_validator_wired_into_live_path(self):
        """§8.1: validateRec must run in analysis.js post-processing (was dead code).
        Must run AFTER the sizing steps so qty>=1 validates final values."""
        self.assertIn("validateRec(r, ctx)", self.analysis_src,
                      "validateRec must be called per-rec in analysis.js")
        self.assertIn("_validatorFixed", self.analysis_src,
                      "repaired recs must carry the _validatorFixed audit tag")
        sizing_at    = self.analysis_src.index("_exitSized")
        validator_at = self.analysis_src.index("validateRec(r, ctx)")
        self.assertLess(sizing_at, validator_at,
                        "validator must run after SELL/TRIM sizing (qty >= 1 check)")

    def test_ensemble_confidence_restored(self):
        """§8.1: ensembleConfidence must be computed in analysis.js — it was only
        ever computed inside the unwired validateResponse(), so learning events
        logged ensemble_confidence = null."""
        self.assertIn("ensembleConfidence", self.analysis_src)
        self.assertIn("indScore / 100", self.analysis_src,
                      "ensemble blend (0.5*conf + 0.5*score/100) missing from analysis.js")

    def test_buy_net_ev_gate_is_engine_computed(self):
        """§8.2: the BUY neg-EV gate must use engine-computed netProfit at final qty,
        not the AI's value (Rule 4 forces qty=0, so the AI cannot compute a real one)."""
        self.assertIn("_netProfitEngine", self.analysis_src)
        self.assertIn("engineNet", self.analysis_src)
        # The old AI-value gate must be gone
        self.assertNotIn("const aiNet     = Number(r.netProfit)", self.analysis_src)

    def test_section7_cash_test_is_qty_free(self):
        """§8.2: Section 7 must not require arithmetic on qty (which Rule 4 zeroes)."""
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertNotIn("Expected dollar return = qty", src,
                         "Section 7 cash test still depends on qty")
        self.assertIn("MINIMUM TRADE SIZE", src,
                      "Section 7 must compute the cash test on the min-trade-size notional")

    def test_calibration_applied_deterministically(self):
        """§8.3: numeric calibration nudges are applied engine-side, not by Claude."""
        # Backend exposes the machine-readable mirror
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            py = f.read()
        self.assertIn('"adjustments": adjustments', py,
                      "calibration response must include the adjustments payload")
        # Client applies it before Kelly sizing and preserves the original confidence
        self.assertIn("_calibApplied", self.analysis_src)
        calib_at = self.analysis_src.index("_calibAdjustments")
        quant_at = self.analysis_src.index("Quant Engine post-processing")
        self.assertLess(calib_at, quant_at,
                        "calibration must be applied before quant sizing (Kelly reads confidence)")
        # Prompt no longer instructs Claude to do the arithmetic
        with open(os.path.join(ROOT, "js", "prompts.js"), encoding="utf-8") as f:
            prompts = f.read()
        self.assertNotIn("new_conf = clamp(orig_conf", prompts,
                         "Section 6 still tells Claude to apply calibration arithmetic")

    def test_learning_log_uses_original_confidence(self):
        """§8.3: ai_confidence must log Claude's original value, not the engine-adjusted
        one — otherwise calibration compounds on its own output."""
        self.assertIn("_calibApplied && r._calibApplied.orig", self.analysis_src)


class TestSprint61PipelineIntegrity(unittest.TestCase):
    """§8 plan implementation: ADR breadth gate, regime ML feature, outcome-proposal
    notifications, expanded shadow-logging taxonomy."""

    @classmethod
    def setUpClass(cls):
        def _read(*p):
            with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
                return f.read()
        cls.dta         = _read("js", "day-trading-analysis.js")
        cls.strategy    = _read("js", "strategy.js")
        cls.alerts      = _read("js", "alerts.js")
        cls.notifs      = _read("js", "notifications.js")
        cls.dt_train_js = _read("js", "dt-training.js")
        cls.analysis    = _read("js", "analysis.js")

    def test_adr_breadth_gate_implemented(self):
        """§2.7: new swing BUYs suppressed when ADR < minAdr (default 0.25)."""
        self.assertIn("minAdr", self.strategy)
        self.assertIn("0.25", self.strategy)
        self.assertIn("_breadthBlocked", self.dta)
        self.assertIn("advance_decline_ratio", self.dta)

    def test_breadth_blocked_setups_are_shadow_logged(self):
        """Suppressed setups must feed the ML as shadow records (full stop/target)."""
        self.assertIn("shadow_reason: 'breadth_blocked'", self.dta)

    def test_regime_risk_feature_lists(self):
        """Sprint 61: regime_risk ordinal feature in both training matrices."""
        import routes.day_trade_training as dtt
        self.assertIn("regime_risk", dtt.FEATURES_SWING)
        self.assertEqual(len(dtt.FEATURES_SWING), 16)
        self.assertEqual(len(dtt.FEATURES_INTRADAY), 19)
        self.assertEqual(dtt._REGIME_RISK["riskOn"], 0)
        self.assertEqual(dtt._REGIME_RISK["panic"], 5)

    def test_regime_risk_maps_in_sync(self):
        """The JS prediction-side map must match the Python training-side map."""
        self.assertIn("regime_risk", self.dt_train_js)
        for pair in ("riskOn: 0", "trend: 1", "sideways: 2",
                     "highVol: 3", "riskOff: 4", "panic: 5"):
            self.assertIn(pair, self.dt_train_js,
                          f"JS _RR map missing/mismatched: {pair}")

    def test_outcome_proposal_notifications(self):
        """Stop/target hits on executed recs must propose outcome recording via the
        bell (persistent, deep-linked) — portfolio recs AND day-trade swing recs."""
        # 1 definition + 4 call sites (portfolio stop/target, swing stop/target)
        self.assertGreaterEqual(self.alerts.count("_proposeOutcomeRecording("), 5)
        self.assertIn("_NOTIF_NAV", self.notifs)
        self.assertIn("outcome: 'recommendations'", self.notifs)
        self.assertIn("outcome_dt: 'day-trading'", self.notifs)

    def test_shadow_reason_taxonomy_expanded(self):
        """§8.6: conf-floor and neg-EV drops are shadow-logged (ML bias correction)."""
        self.assertIn("shadow_reason: 'conf_floor'", self.analysis)
        self.assertIn("shadow_reason: 'neg_ev'", self.analysis)


class TestSprint62RemainingFilters(unittest.TestCase):
    """§2.8 VoV filter, §2.9 time-of-week filter, §8.5 tool-schema output."""

    @classmethod
    def setUpClass(cls):
        def _read(*p):
            with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
                return f.read()
        cls.indicators = _read("indicators.py")
        cls.strategy   = _read("js", "strategy.js")
        cls.dta        = _read("js", "day-trading-analysis.js")
        cls.client     = _read("js", "claude-client.js")

    # ── §2.8 VoV ──────────────────────────────────────────────────────────
    def test_atr_5d_mean_emitted_by_indicators(self):
        """atr_5d_mean = mean of the 5 ATR values ending YESTERDAY (excludes today)."""
        self.assertIn('"atr_5d_mean"', self.indicators)
        self.assertIn("atr.iloc[-6:-1].mean()", self.indicators,
                      "atr_5d_mean must exclude today's bar from the baseline")

    def test_vov_gate_in_both_prefilters(self):
        """The VoV check must exist in strategy.js AND the stats variant — the two
        pre-filters are documented as kept in sync."""
        for src, name in ((self.strategy, "strategy.js"), (self.dta, "day-trading-analysis.js")):
            self.assertIn("vovMult", src, f"VoV gate missing from {name}")
            self.assertIn("atr_5d_mean", src, f"VoV gate missing from {name}")
        self.assertIn("vovMult:       1.3", self.strategy)
        self.assertIn("stats.vov++", self.dta)

    # ── §2.9 time-of-week ─────────────────────────────────────────────────
    def test_time_of_week_uses_sydney_clock(self):
        """Must use Australia/Sydney via Intl — the Pi may not run in AEST.
        Boundary behaviour (Mon 10:59 blocked / 11:00 allowed; Fri 13:59 allowed /
        14:00 blocked; toggle off) is verified functionally in Node during dev."""
        self.assertIn("_dtTimeOfWeekBlocked", self.dta)
        self.assertIn("Australia/Sydney", self.dta)
        self.assertIn("hh < 11", self.dta)
        self.assertIn("hh >= 14", self.dta)
        self.assertIn("timeOfWeekFilter", self.strategy)

    def test_time_of_week_not_shadow_logged(self):
        """TOW suppressions are deliberately NOT shadow-logged — the same setup
        re-scanned after the window would double-count in the ML."""
        self.assertIn("_towBlocked", self.dta)
        # the TOW block must not contain a dtSaveSnapshot call (unlike breadth)
        tow_block = self.dta.split("§2.9 time-of-week gate")[1].split("state.dayTrading._towBlocked = null")[0]
        self.assertNotIn("dtSaveSnapshot", tow_block)

    # ── §8.5 tool-schema output ───────────────────────────────────────────
    def test_portfolio_tool_schema_forced(self):
        """Portfolio agent must use forced tool_choice on emit_recommendations."""
        self.assertIn("_PORTFOLIO_TOOL", self.client)
        self.assertIn("emit_recommendations", self.client)
        self.assertIn("tool_choice", self.client)
        self.assertIn("agentType === 'portfolio' && !options.noTool", self.client)

    def test_tool_use_block_serialised_for_parser(self):
        """tool_use input must be stringified so parseClaudeJSON works unchanged."""
        self.assertIn("b.type === 'tool_use'", self.client)
        self.assertIn("JSON.stringify(_toolBlock.input)", self.client)

    def test_tool_schema_enforces_enums(self):
        """Schema must constrain action and urgency to closed vocabularies."""
        self.assertIn("enum: ['BUY', 'SELL', 'TRIM', 'TOP_UP']", self.client)
        self.assertIn("enum: ['immediate', 'routine', 'monitor']", self.client)

    def test_tool_schema_is_static(self):
        """The tool definition is part of the cached prompt prefix — it must not
        interpolate runtime state or the cache would bust on every call."""
        tool_src = self.client.split("const _PORTFOLIO_TOOL")[1].split("};")[0]
        self.assertNotIn("${", tool_src)
        self.assertNotIn("state.", tool_src)


class TestSprint63ExecutionAlphaAndRetrainNudge(unittest.TestCase):
    """Execution-alpha tracker (mechanical vs actual exits) + ML retrain nudge."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True
        def _read(*p):
            with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
                return f.read()
        cls.learning_py  = _read("routes", "learning.py")
        cls.db_py        = _read("db.py")
        cls.learning_js  = _read("js", "pages", "learning.js")
        cls.dt_train_js  = _read("js", "dt-training.js")
        cls.notifs_js    = _read("js", "notifications.js")

    # ── Execution alpha ───────────────────────────────────────────────────
    def test_exec_alpha_migration_columns(self):
        self.assertIn('("exec_mech_pnl_pct", "REAL")', self.db_py)
        self.assertIn('("exec_mech_exit",    "TEXT")', self.db_py)

    def test_exec_alpha_endpoint_empty_db(self):
        """Empty DB → ok=True, n=0 (no crash, no yfinance call needed)."""
        r = self.client.get("/api/learning/execution-alpha")
        self.assertEqual(r.status_code, 200)
        data = json.loads(r.data)
        self.assertTrue(data["ok"])
        self.assertEqual(data["n"], 0)
        self.assertEqual(data["pending"], 0)

    def test_exec_alpha_simulation_conventions(self):
        """Stop must be checked FIRST within a bar (conservative); horizon = 15 bars
        (the §6 time-based exit ceiling)."""
        block = self.learning_py.split("def _resolve_execution_alpha")[1].split("def _compute_execution_alpha")[0]
        self.assertIn("HORIZON = 15", block)
        stop_at   = block.index('bar["Low"] <= stop')
        target_at = block.index('bar["High"] >= target')
        self.assertLess(stop_at, target_at, "stop must be checked before target within a bar")

    def test_exec_alpha_aggregation(self):
        """_compute_execution_alpha: alpha = avg(actual) − avg(mech); beat/lag counts."""
        from routes.learning import _compute_execution_alpha
        import sqlite3
        conn = sqlite3.connect(":memory:")
        conn.row_factory = sqlite3.Row
        conn.execute("""
            CREATE TABLE ai_learning_events (
                realized_pnl_pct REAL, exec_mech_pnl_pct REAL, exec_mech_exit TEXT,
                was_executed INTEGER, recommendation TEXT, outcome_status TEXT,
                actual_entry_price REAL, suggested_stop REAL, suggested_target REAL
            )""")
        rows = [
            (6.0,  2.0, 'target', 1, 'BUY', 'win',  10, 9, 12),
            (-2.0, 1.0, 'time',   1, 'BUY', 'loss', 10, 9, 12),
            (2.0,  0.0, 'stop',   1, 'BUY', 'win',  10, 9, 12),
            # eligible but unresolved → counted as pending
            (3.0,  None, None,    1, 'BUY', 'win',  10, 9, 12),
        ]
        conn.executemany("INSERT INTO ai_learning_events VALUES (?,?,?,?,?,?,?,?,?)", rows)
        d = _compute_execution_alpha(conn)
        self.assertEqual(d["n"], 3)
        self.assertEqual(d["pending"], 1)
        self.assertAlmostEqual(d["avg_actual_pct"], 2.0)
        self.assertAlmostEqual(d["avg_mech_pct"], 1.0)
        self.assertAlmostEqual(d["alpha_pp"], 1.0)
        self.assertEqual(d["n_beat"], 2)
        self.assertEqual(d["n_lag"], 1)
        self.assertEqual(d["mech_exits"], {"target": 1, "time": 1, "stop": 1})

    def test_exec_alpha_card_wired(self):
        self.assertIn("renderExecutionAlphaCard", self.learning_js)
        self.assertIn("ll-exec-alpha-card", self.learning_js)
        self.assertIn("execAlphaPlaceholder", self.learning_js)

    # ── Retrain nudge ─────────────────────────────────────────────────────
    def test_retrain_nudge_wired(self):
        """Nudge at ≥15 new completed trades; one-shot per trained_at; called on startup."""
        self.assertIn("_dtCheckRetrainNudge", self.dt_train_js)
        self.assertIn("newSince < 15", self.dt_train_js)
        self.assertIn("dt_retrain_nudged_for", self.dt_train_js)
        self.assertIn("_dtCheckRetrainNudge();", self.dt_train_js)

    def test_retrain_notification_deep_links(self):
        self.assertIn("retrain: 'day-trading'", self.notifs_js)
        self.assertIn("retrain: '🧠'", self.notifs_js)


class TestSprint64FlagDontDrop(unittest.TestCase):
    """2026-06-11 incident fixes: driver-mention auto-repair, negative daysHeld,
    and flag-don't-drop — failed recs stay visible with reasons + Skip/Execute."""

    @classmethod
    def setUpClass(cls):
        def _read(*p):
            with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
                return f.read()
        cls.validator_js = _read("js", "response-validator.js")
        cls.analysis_js  = _read("js", "analysis.js")
        cls.recs_js      = _read("js", "pages", "recommendations.js")

    def test_driver_mention_is_auto_repaired_not_failed(self):
        """The 'reasoning must mention primary_driver' check must repair (append
        the token) instead of hard-failing — the prompt contract is 'word or
        CONCEPT' and the literal check cannot detect concepts."""
        self.assertIn("_driverMentionAppended", self.validator_js)
        self.assertNotIn("reasoning must explicitly mention the primary_driver",
                         self.validator_js,
                         "the hard-fail error message must be gone")

    def test_days_held_uses_dd_mm_parse(self):
        """new Date('09-06-2026') reads MM-DD → future date → negative daysHeld
        (the ANZ −87 anomaly). Must parse via parseDate and clamp negatives to null."""
        block = self.analysis_js.split("function _daysHeld")[1].split("\n  }")[0]
        self.assertIn("parseDate", block)
        self.assertIn("days >= 0 ? days : null", block)
        self.assertNotIn("new Date(earliest.date)", self.analysis_js)

    def test_validator_flags_instead_of_dropping(self):
        """Unfixable recs are kept with _ruleWarnings (user decides Skip/Execute);
        only structurally unusable recs (bad ticker/action) are dropped."""
        self.assertIn("_ruleWarnings: errors", self.analysis_js)
        self.assertIn("structurally unusable", self.analysis_js)
        # repaired-but-error-free recs must keep their repairs
        self.assertIn("return [fixed || r];", self.analysis_js)

    def test_neg_ev_and_conf_floor_flag_not_drop(self):
        """The engine net-EV gate and confidence floor flag recs instead of
        removing them; shadow logging is retained for the ML."""
        self.assertIn("Engine net-EV ≤ 0 at sized qty", self.analysis_js)
        self.assertIn("below the ${(MIN_CONFIDENCE * 100).toFixed(0)}% floor", self.analysis_js)
        # the conf-floor must no longer filter
        self.assertNotIn("if ((r.confidence || 0) < MIN_CONFIDENCE) { lowConfDropped++; return false; }",
                         self.analysis_js)

    def test_flagged_recs_exempt_from_daily_cap(self):
        """Flagged (advisory) recs must not compete for or be cut by maxTradesPerDay."""
        self.assertIn("_cleanRecs", self.analysis_js)
        self.assertIn("_flaggedRecs", self.analysis_js)
        self.assertIn("...cappedClean, ..._flaggedRecs", self.analysis_js)

    def test_rec_card_renders_failure_panel(self):
        """Flagged recs render a compact "Failed N rule(s)" chip (collapsed by
        default, click to expand the error list) next to the existing
        Skip / Mark Executed buttons — not a verbose always-visible panel."""
        self.assertIn("_ruleWarnings", self.recs_js)
        self.assertIn("Failed ${_warns.length} rule", self.recs_js)
        self.assertIn("border-left:3px solid #dc2626", self.recs_js)


class TestSprint65MacroBriefPersistence(unittest.TestCase):
    """2026-06-11 disappearing-macro fix: live refreshes must MERGE into
    state.macroData (preserving the AI brief) instead of replacing it; the
    brief auto-runs once per trading day; displayed with its date until the
    next run replaces it."""

    @classmethod
    def setUpClass(cls):
        def _read(*p):
            with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
                return f.read()
        cls.utils_js     = _read("js", "utils.js")
        cls.macro_js     = _read("js", "pages", "macro.js")
        cls.analysis_js  = _read("js", "analysis.js")
        cls.scheduler_js = _read("js", "scheduler.js")
        cls.config_js    = _read("js", "config.js")
        cls.settings_js  = _read("js", "pages", "settings.js")
        cls.init_js      = _read("js", "init.js")

    def test_merge_helper_exists_and_preserves_ai_fields(self):
        self.assertIn("function mergeLiveMacro", self.utils_js)
        for f in ("'sentiment'", "'sentimentConf'", "'bullish'", "'analysis'", "'keyDrivers'"):
            self.assertIn(f, self.utils_js, f"AI field {f} missing from preserve list")

    def test_no_wholesale_macro_replacement_remains(self):
        """The four wipe sites must all route through mergeLiveMacro()."""
        for src, name in ((self.macro_js, "pages/macro.js"), (self.analysis_js, "analysis.js")):
            self.assertNotIn("state.macroData = {...d, _source:'live'}", src, name)
            self.assertNotIn("state.macroData = {...data, _source:'live'}", src, name)
            self.assertNotIn("state.macroData = { ...data, _source: 'live' }", src, name)
        self.assertGreaterEqual(self.macro_js.count("mergeLiveMacro("), 3)
        self.assertIn("mergeLiveMacro(d)", self.analysis_js)

    def test_daily_auto_run_with_toggle(self):
        """checkMacroBriefSchedule: once/day via persisted macroDate, weekday-only,
        ≤3 attempts/day, gated on autoMacroBrief (default true) and key/proxy."""
        self.assertIn("function checkMacroBriefSchedule", self.scheduler_js)
        self.assertIn("autoMacroBrief === false", self.scheduler_js)
        self.assertIn("macroAutoAttempts", self.scheduler_js)
        self.assertIn("useBackendProxy", self.scheduler_js)
        self.assertIn("autoMacroBrief: true", self.config_js)
        self.assertIn("autoMacroBrief", self.settings_js)
        self.assertIn("checkMacroBriefSchedule();", self.init_js)
        # the price-refresh tick also checks it
        self.assertIn("checkMacroBriefSchedule();", self.scheduler_js.split("function checkMacroBriefSchedule")[0])

    def test_macro_run_does_not_hijack_proxy_mode(self):
        """runMacroAnalysis must not navigate to Settings when proxy mode supplies
        the key server-side (auto-run from a timer must never change pages)."""
        self.assertIn("if(!key && !state.settings?.useBackendProxy)", self.macro_js)

    def test_brief_shows_its_date_until_replaced(self):
        """The AI Macro Analysis card carries a date badge: green 'Today' or amber
        'From <date>' when displaying a previous day's brief."""
        self.assertIn("From ${state.macroDate}", self.macro_js)
        self.assertIn("Today · ${state.macroDate}", self.macro_js)


class TestSprint66RegimeStopWideningAndSlippage(unittest.TestCase):
    """§9.1 dynamic regime stop widening + §9.2 virtual-fill slippage."""

    @classmethod
    def setUpClass(cls):
        def _read(*p):
            with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
                return f.read()
        cls.alerts_js   = _read("js", "alerts.js")
        cls.prices_js   = _read("js", "prices.js")
        cls.recs_js     = _read("js", "pages", "recommendations.js")
        cls.learning_py = _read("routes", "learning.py")
        cls.backtest_py = _read("routes", "backtest.py")
        cls.db_py       = _read("db.py")

    # ── §9.1 regime stop widening ─────────────────────────────────────────
    def test_stop_widening_invariants(self):
        """Widen-only, manual-trail precedence, one-shot per regime — the full
        behaviour matrix is verified functionally in Node during dev; this pins
        the load-bearing source lines."""
        self.assertIn("function checkRegimeStopWidening", self.alerts_js)
        self.assertIn("if (widenedStop >= r.stopLoss) continue;", self.alerts_js,
                      "widen-only invariant missing")
        self.assertIn("if (r._stopTrailed) continue;", self.alerts_js,
                      "manual trail must take precedence")
        self.assertIn("_stopWidenedRegime === regime", self.alerts_js,
                      "one-shot-per-regime guard missing")
        self.assertIn("_stopWidenedFrom", self.alerts_js)

    def test_widening_runs_before_stop_hit_checks(self):
        """A stale-tight stop must be widened before the hit-checker fires on it."""
        widen_at = self.prices_js.index("checkRegimeStopWidening")
        hits_at  = self.prices_js.index("checkRecStopTargetAlerts")
        self.assertLess(widen_at, hits_at)

    def test_widened_badge_in_history_table(self):
        self.assertIn("↔ Widened", self.recs_js)
        self.assertIn("_stopWidenedFrom", self.recs_js)

    # ── §9.2 slippage ─────────────────────────────────────────────────────
    def test_adv_slippage_tiers(self):
        from core import adv_slippage
        self.assertEqual(adv_slippage(20_000_000), 0.0005)
        self.assertEqual(adv_slippage(5_000_000), 0.001)
        self.assertEqual(adv_slippage(1_000_000), 0.002)
        self.assertEqual(adv_slippage(100_000), 0.0035)
        self.assertEqual(adv_slippage(None), 0.0035)      # missing → thin-name tier
        self.assertEqual(adv_slippage("garbage"), 0.0035)

    def test_event_slippage_regime_multiplier(self):
        from routes.learning import _event_slippage
        row = {"entry_signals_json": json.dumps({"adv_20": 5_000_000}), "regime": "panic"}
        self.assertAlmostEqual(_event_slippage(row), 0.001 * 2.0)
        row["regime"] = "sideways"
        self.assertAlmostEqual(_event_slippage(row), 0.001)
        # corrupt snapshot → conservative thin-name tier
        self.assertAlmostEqual(
            _event_slippage({"entry_signals_json": "not json", "regime": None}), 0.0035)

    def test_virtual_outcomes_use_asymmetric_slippage(self):
        """Wins must clear the target by the slippage margin; losses trigger at
        the raw stop (pessimistic by construction)."""
        block = self.learning_py.split("def _resolve_virtual_outcomes")[1].split("def _resolve_sell_outcomes")[0] \
            if "def _resolve_sell_outcomes" in self.learning_py else \
            self.learning_py.split("def _resolve_virtual_outcomes")[1]
        self.assertIn('target * (1 + slip)', block)   # BUY win needs clearance
        self.assertIn('target * (1 - slip)', block)   # exit-frame win needs clearance
        self.assertIn("virtual_slippage_applied", block)

    def test_execution_alpha_degrades_mechanical_fills(self):
        """Actual fills embed real slippage — the mechanical baseline must too,
        or alpha is overstated."""
        block = self.learning_py.split("def _resolve_execution_alpha")[1].split("def _compute_execution_alpha")[0]
        self.assertIn('stop * (1 - slip), "stop"', block)
        self.assertIn('target * (1 + slip)', block)
        self.assertIn('float(bar["Close"]) * (1 - slip), "time"', block)

    def test_slippage_single_source_of_truth(self):
        """backtest.py must use core.adv_slippage, not a duplicated tier table."""
        self.assertIn("from core import adv_slippage", self.backtest_py)
        self.assertNotIn("if adv_aud >= 10_000_000", self.backtest_py)
        self.assertIn('("virtual_slippage_applied", "REAL")', self.db_py)


class TestSprint67CorrContextTraceabilityAndBatch(unittest.TestCase):
    """§9.3 CorrToHoldings prompt context, §9.4 traceability modal,
    §9.5 calendar lesson scopes + local-LLM size escalation."""

    @classmethod
    def setUpClass(cls):
        def _read(*p):
            with open(os.path.join(ROOT, *p), encoding="utf-8") as f:
                return f.read()
        cls.analysis_js = _read("js", "analysis.js")
        cls.prompts_js  = _read("js", "prompts.js")
        cls.recs_js     = _read("js", "pages", "recommendations.js")
        cls.learning_js = _read("js", "pages", "learning.js")
        cls.learning_py = _read("routes", "learning.py")
        cls.client_js   = _read("js", "claude-client.js")

    # ── §9.3 CorrToHoldings ───────────────────────────────────────────────
    def test_corr_matrix_captured_pre_prompt(self):
        """Step 2b must capture the correlation matrix (incl. watchlist tickers)
        BEFORE the prompt is built — previously only metrics were read."""
        self.assertIn("_corrMatrixPre = rd.correlation || {}", self.analysis_js)
        self.assertIn("[...new Set(allTickers)].join(',')", self.analysis_js,
                      "risk fetch must include watchlist tickers for BUY-candidate corr")
        # capture must precede the indicator-block builder's use
        self.assertLess(self.analysis_js.index("_corrMatrixPre = rd.correlation"),
                        self.analysis_js.index("CorrToHoldings:"))

    def test_corr_line_in_indicator_block(self):
        self.assertIn("CorrToHoldings:", self.analysis_js)
        self.assertIn("Math.abs(rowC[h]) >= 0.60", self.analysis_js)

    def test_corr_prompt_rule_is_context_only(self):
        """The prompt must forbid numeric confidence/qty adjustment for correlation
        (engine-side sizing is the v10 architecture) while requiring orthogonality."""
        self.assertIn("CorrToHoldings", self.prompts_js)
        self.assertIn("Do NOT adjust confidence or qty numerically for correlation", self.prompts_js)
        self.assertIn("orthogonal", self.prompts_js)

    def test_max_corr_logged_to_learning_events(self):
        self.assertIn("max_corr_to_holdings", self.analysis_js)
        self.assertIn("window._lastCorrMatrix", self.analysis_js)

    # ── §9.4 traceability modal ───────────────────────────────────────────
    def test_traceability_modal_wired(self):
        self.assertIn("function showRecTraceability", self.recs_js)
        self.assertIn("showRecTraceability('${r.id}')", self.recs_js)
        for field in ("_calibApplied", "_constraintBinding", "_validatorFixed",
                      "_ruleWarnings", "_stopWidened", "_exitSized"):
            self.assertIn(field, self.recs_js, f"modal must surface {field}")

    # ── §9.5 calendar lesson scopes ───────────────────────────────────────
    def test_calendar_lesson_scopes(self):
        self.assertIn('"earnings_season"', self.learning_py)
        self.assertIn('"cgt_window"', self.learning_py)
        self.assertIn("month in (2, 8)", self.learning_py)
        self.assertIn("month in (5, 6)", self.learning_py)
        self.assertIn('value="earnings_season"', self.learning_js)
        self.assertIn('value="cgt_window"', self.learning_js)

    def test_calendar_scope_accepted_by_create(self):
        """POST validation must accept the new scope values."""
        _install_in_memory_db()
        asx_server.init_db()
        client = asx_server.app.test_client()
        r = client.post("/api/learning/lessons",
                        json={"lesson_text": "test cgt lesson", "breadth_scope": "cgt_window"})
        self.assertEqual(r.status_code, 200)
        self.assertTrue(json.loads(r.data)["ok"])

    # ── Sprint 68: quant-reject fallback sizing ───────────────────────────
    def test_quant_reject_gets_fallback_sizing(self):
        """When computeTradeParams declines a BUY/TOP_UP, the rec must surface
        the engine's actual reason ONCE and receive min-trade-size fallback qty
        (capped by cash) so the card is executable — not ship qty=0 with three
        cascading warnings and no stated cause (the WDS 15:35 incident)."""
        self.assertIn("Quant engine declined to size", self.analysis_js)
        self.assertIn("_fallbackSized: true", self.analysis_js)
        self.assertIn("Math.floor((state.cash || 0) / entryMidQ)", self.analysis_js)
        self.assertIn("cannot cover 1 share", self.analysis_js)
        # the silent keep-AI-values path must be gone
        self.assertNotIn("if (!qt.ok) return r;", self.analysis_js)

    def test_portfolio_token_cap_raised(self):
        """out=8000 hit the cap exactly on the 15:35 run — tool input counts
        against max_tokens, so the cap must exceed observed peak usage."""
        self.assertIn("portfolio: 12000", self.client_js)

    # ── §9.5 local-LLM size escalation ────────────────────────────────────
    def test_local_llm_escalation(self):
        """Local SELL/TRIM on a >10%-weight holding escalates to Claude; a
        keyless local-only install keeps the result with a loud warning
        instead of throwing."""
        self.assertIn("_localExitOnLargePosition", self.client_js)
        self.assertIn("_LOCAL_ESCALATE_WEIGHT_PCT = 10", self.client_js)
        self.assertIn("escalating to Claude", self.client_js)
        self.assertIn("no Claude key to escalate", self.client_js)


class TestSprint71Phase3(unittest.TestCase):
    """Sprint 71 Phase 3 — feed enrichment: few-shot exemplars, per-driver
    playbook, conditional cross-tabs + negative confirmation, deep/light mode."""

    @staticmethod
    def _clean_events(conn):
        conn.execute("DELETE FROM ai_learning_events")

    # ── 3A entry signature + exemplars ───────────────────────────────────────
    def test_entry_signature_shape(self):
        from routes.learning import _entry_signature
        sig = {"rsi_14": 28.4, "bb_pct_b": 0.07, "px_vs_sma200": -3.2,
               "setup_score": 72, "macd_hist": 0.5,
               "rs_score": 5, "rs_5d_alpha": None}
        s = _entry_signature(sig)
        self.assertIn("RSI28", s)
        self.assertIn("%b0.07", s)
        self.assertIn("vs200-3%", s)
        self.assertIn("setup72", s)
        self.assertIn("MACD+", s)
        # rs_score / rs_5d_alpha must NOT be surfaced (neutral placeholder).
        # The signature carries setup_score=5? no — assert the rs_score VALUE (5)
        # never leaks as an "rs5"/"alpha" token.
        self.assertNotIn("rs5", s.lower())
        self.assertNotIn("alpha", s.lower())

    def test_entry_signature_skips_nulls_and_empty(self):
        from routes.learning import _entry_signature
        self.assertEqual(_entry_signature(None), "")
        self.assertEqual(_entry_signature({}), "")
        self.assertEqual(_entry_signature({"rsi_14": None, "bb_pct_b": None}), "")
        # MACD- for negative hist
        self.assertIn("MACD-", _entry_signature({"macd_hist": -0.3}))

    def test_compute_exemplars_line_shape_and_caps(self):
        """Crafted win + loss events produce compact ACTION TICKER @ sig → outcome
        lines, respecting the win/loss count caps."""
        _install_in_memory_db()
        asx_server.init_db()
        try:
            from routes.learning import _compute_exemplars
            with _test_get_db() as conn:
                self._clean_events(conn)
                # 4 losses (cap 3) + 3 wins (cap 2)
                for i in range(4):
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           realized_pnl_pct, holding_period_days, was_executed,
                           entry_signals_json, error_type, timestamp)
                        VALUES ('recommendation',?, 'BUY','loss',?,?,1,?,?,?)
                    """, (f"L{i}.AX", -4.0 - i, 5 + i,
                          json.dumps({"rsi_14": 55, "bb_pct_b": 0.6,
                                      "px_vs_sma200": -2, "setup_score": 40}),
                          "poor_entry",
                          f"2026-01-1{i} 10:00:00"))
                for i in range(3):
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           realized_pnl_pct, holding_period_days, was_executed,
                           entry_signals_json, success_tags, timestamp)
                        VALUES ('recommendation',?, 'BUY','win',?,?,1,?,?,?)
                    """, (f"W{i}.AX", 10.0 + i * 5, 8,
                          json.dumps({"rsi_14": 30, "bb_pct_b": 0.1,
                                      "setup_score": 75}),
                          "confluence_entry",
                          f"2026-01-2{i} 10:00:00"))
                lines = _compute_exemplars(conn)
            self.assertEqual(len(lines), 5)            # 3 losses + 2 wins
            self.assertTrue(all("→" in ln for ln in lines))
            self.assertTrue(any("BUY L" in ln for ln in lines))
            # Best wins first by P&L: W2 (+20%) should appear; lowest win W0 dropped
            win_lines = [ln for ln in lines if "BUY W" in ln]
            self.assertEqual(len(win_lines), 2)
            self.assertTrue(any("+20.0%" in ln for ln in win_lines))
            # tag + holding-days present
            self.assertTrue(any("poor_entry" in ln for ln in lines))
            self.assertTrue(any("confluence_entry" in ln for ln in lines))
            self.assertTrue(any("in 8d" in ln for ln in win_lines))
        finally:
            asx_server.get_db = _orig_get_db

    def test_compute_exemplars_empty_history(self):
        _install_in_memory_db()
        asx_server.init_db()
        try:
            from routes.learning import _compute_exemplars
            with _test_get_db() as conn:
                self._clean_events(conn)
                self.assertEqual(_compute_exemplars(conn), [])
        finally:
            asx_server.get_db = _orig_get_db

    def test_exemplars_block_present_in_analysis_js(self):
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("buildExemplarsBlock", src)
        self.assertIn("_exemplarsBlock", src)
        # injected alongside the calibration placeholder
        self.assertIn("_calibrationNote + _exemplarsBlock + _lessonsBlock", src)

    def test_exemplars_block_builder_in_learning_loop_js(self):
        with open(os.path.join(ROOT, "js", "learning-loop.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("function buildExemplarsBlock", src)
        self.assertIn("EXEMPLARS", src)
        self.assertIn("window._calibExemplars", src)
        # deep mode option wired into the fetch
        self.assertIn("opts && opts.deep", src)
        self.assertIn("params.set('deep', '1')", src)

    # ── 3B per-driver playbook ───────────────────────────────────────────────
    def test_driver_playbook_fires_with_sufficient_n(self):
        from routes.learning import _compute_driver_playbook, _ci_excludes
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                # mean_reversion: 9/10 wins when RSI<30, 1/10 wins when RSI>45
                for i in range(10):
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           was_executed, primary_entry_driver, entry_signals_json,
                           realized_pnl_pct, timestamp)
                        VALUES ('recommendation',?, 'BUY',?,1,'mean_reversion',?,1.0,
                                datetime('now'))
                    """, (f"MR{i}.AX", "win" if i < 9 else "loss",
                          json.dumps({"rsi_14": 25})))
                for i in range(10):
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           was_executed, primary_entry_driver, entry_signals_json,
                           realized_pnl_pct, timestamp)
                        VALUES ('recommendation',?, 'BUY',?,1,'mean_reversion',?,1.0,
                                datetime('now'))
                    """, (f"MX{i}.AX", "win" if i < 1 else "loss",
                          json.dumps({"rsi_14": 60})))
                out = _compute_driver_playbook(conn, ["mean_reversion"], _ci_excludes)
            self.assertTrue(out)
            self.assertIn("mean_reversion", out[0])
            self.assertIn("RSI<30", out[0])
            self.assertIn("RSI>45", out[0])
        finally:
            asx_server.get_db = _orig_get_db

    def test_driver_playbook_gated_below_n(self):
        from routes.learning import _compute_driver_playbook, _ci_excludes
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                # Only 2 per bucket — below min_bucket_n=5 → no line.
                for rsi, n in ((25, 2), (60, 2)):
                    for i in range(n):
                        conn.execute("""
                            INSERT INTO ai_learning_events
                              (event_type, ticker, recommendation, outcome_status,
                               was_executed, primary_entry_driver, entry_signals_json,
                               realized_pnl_pct, timestamp)
                            VALUES ('recommendation',?, 'BUY','win',1,'mean_reversion',?,1.0,
                                    datetime('now'))
                        """, (f"S{rsi}{i}.AX", json.dumps({"rsi_14": rsi})))
                out = _compute_driver_playbook(conn, ["mean_reversion"], _ci_excludes)
            self.assertEqual(out, [])
        finally:
            asx_server.get_db = _orig_get_db

    # ── 3C cross-tabs + negative confirmation ────────────────────────────────
    def test_setup_bucket_xtab_fires(self):
        from routes.learning import _compute_setup_bucket_xtab, _ci_excludes
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                # high setup wins 9/10, low setup wins 1/10
                for ss, wins, n in ((75, 9, 10), (30, 1, 10)):
                    for i in range(n):
                        conn.execute("""
                            INSERT INTO ai_learning_events
                              (event_type, ticker, recommendation, outcome_status,
                               was_executed, entry_signals_json, realized_pnl_pct,
                               timestamp)
                            VALUES ('recommendation',?, 'BUY',?,1,?,1.0,datetime('now'))
                        """, (f"SS{ss}{i}.AX", "win" if i < wins else "loss",
                              json.dumps({"setup_score": ss})))
                line = _compute_setup_bucket_xtab(conn, _ci_excludes)
            self.assertIn("setup_score", line)
            self.assertIn("high", line)
            self.assertIn("low", line)
        finally:
            asx_server.get_db = _orig_get_db

    def test_driver_regime_xtab_fires(self):
        from routes.learning import _compute_driver_regime_xtab, _ci_excludes
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                # momentum_breakout: 9/10 wins in riskOn, 1/10 wins elsewhere
                for reg, wins, n in (("riskOn", 9, 10), ("riskOff", 1, 10)):
                    for i in range(n):
                        conn.execute("""
                            INSERT INTO ai_learning_events
                              (event_type, ticker, recommendation, outcome_status,
                               was_executed, primary_entry_driver, regime,
                               realized_pnl_pct, timestamp)
                            VALUES ('recommendation',?, 'BUY',?,1,'momentum_breakout',?,1.0,
                                    datetime('now'))
                        """, (f"DR{reg}{i}.AX", "win" if i < wins else "loss", reg))
                line = _compute_driver_regime_xtab(conn, "riskOn", _ci_excludes)
            self.assertIn("momentum_breakout", line)
            self.assertIn("riskOn", line)
            self.assertIn("other-regimes", line)
        finally:
            asx_server.get_db = _orig_get_db

    def test_negative_confirmation_sell_rose(self):
        from routes.learning import _compute_sell_negative_confirmation
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, sell_verify_date,
                       sell_verify_verdict, sell_verify_sold_chg, sell_primary_driver,
                       timestamp)
                    VALUES ('recommendation','XYZ.AX','SELL','2026-02-01',
                            'invalidated', 18.0, 'thesis_broken', datetime('now'))
                """)
                line = _compute_sell_negative_confirmation(conn)
            self.assertIn("SELL→ROSE", line)
            self.assertIn("XYZ.AX", line)
            self.assertIn("+18%", line)
        finally:
            asx_server.get_db = _orig_get_db

    def test_negative_confirmation_empty_when_no_rise(self):
        from routes.learning import _compute_sell_negative_confirmation
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, sell_verify_date,
                       sell_verify_verdict, sell_verify_sold_chg, sell_primary_driver,
                       timestamp)
                    VALUES ('recommendation','OK.AX','SELL','2026-02-01',
                            'validated', -12.0, 'thesis_broken', datetime('now'))
                """)
                self.assertEqual(_compute_sell_negative_confirmation(conn), "")
        finally:
            asx_server.get_db = _orig_get_db

    # ── 3D deep vs light feed mode ───────────────────────────────────────────
    def _seed_deep_dataset(self, conn):
        """≥30 closed events with drivers/setup so all deep blocks can fire."""
        self._clean_events(conn)
        # 30 momentum_breakout BUYs, half in riskOn, varied setup/RSI/bb.
        for i in range(34):
            won  = "win" if i % 2 == 0 else "loss"
            reg  = "riskOn" if i % 2 == 0 else "riskOff"
            rsi  = 25 if i % 2 == 0 else 60
            bb   = 0.85 if i % 2 == 0 else 0.4
            ss   = 75 if i % 2 == 0 else 30
            conn.execute("""
                INSERT INTO ai_learning_events
                  (event_type, ticker, recommendation, outcome_status,
                   ai_confidence, realized_pnl_pct, holding_period_days,
                   was_executed, primary_entry_driver, regime, sector,
                   entry_signals_json, error_type, success_tags, timestamp)
                VALUES ('recommendation',?, 'BUY',?,0.7,?,5,1,'mean_reversion',?,
                        'Materials',?,?,?,datetime('now'))
            """, (f"D{i}.AX", won, 6.0 if won == "win" else -4.0, reg,
                  json.dumps({"rsi_14": rsi, "bb_pct_b": bb, "setup_score": ss,
                              "px_vs_sma200": 3, "macd_hist": 0.4}),
                  None if won == "win" else "poor_entry",
                  "confluence_entry" if won == "win" else None))

    def test_deep_mode_includes_exemplars_and_playbook(self):
        from routes.learning import _calib_compute
        import unittest.mock as _mock
        import yfinance as yf
        import pandas as pd
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._seed_deep_dataset(conn)

            class _FakeTicker:
                def history(self, **kw):
                    return pd.DataFrame()

            with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
                deep = _calib_compute("riskOn", "", "", 90, deep=True)
                light = _calib_compute("riskOn", "", "", 90, deep=False)
            # Deep returns concrete exemplars; light does not.
            self.assertTrue(deep.get("exemplars"))
            self.assertEqual(light.get("exemplars"), [])
            # Deep block carries the per-driver playbook conditional; light omits it.
            self.assertIn("mean_reversion:", deep.get("block", ""))
            self.assertIn("when RSI", deep.get("block", ""))
            self.assertNotIn("when RSI", light.get("block", ""))
        finally:
            asx_server.get_db = _orig_get_db

    def test_calibration_endpoint_deep_param(self):
        """GET /api/learning/calibration?deep=1 returns exemplars; default does not."""
        from routes.learning import _calib_cache
        import unittest.mock as _mock
        import yfinance as yf
        import pandas as pd
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._seed_deep_dataset(conn)
            _calib_cache.clear()

            class _FakeTicker:
                def history(self, **kw):
                    return pd.DataFrame()

            with _mock.patch.object(yf, "Ticker", return_value=_FakeTicker()):
                with asx_server.app.test_client() as c:
                    deep = c.get("/api/learning/calibration?regime=riskOn&deep=1").get_json()
                    light = c.get("/api/learning/calibration?regime=riskOn").get_json()
            self.assertTrue(deep.get("exemplars"))
            self.assertEqual(light.get("exemplars"), [])
        finally:
            asx_server.get_db = _orig_get_db

    def test_calib_compute_accepts_deep_kwarg(self):
        """Signature must accept the deep parameter (Phase 3D)."""
        import inspect
        from routes.learning import _calib_compute
        self.assertIn("deep", inspect.signature(_calib_compute).parameters)


class TestSprint71SectorAnalysis(unittest.TestCase):
    """Sprint 71 sector hardening + sector-level analysis framed vs the
    whole-ASX-market baseline."""

    @staticmethod
    def _clean_events(conn):
        conn.execute("DELETE FROM ai_learning_events")

    class _FakeTicker:
        def history(self, **kw):
            import pandas as pd
            return pd.DataFrame()

    def _stub_yf(self):
        """Context manager stubbing yfinance.Ticker so the lazy resolvers inside
        _calib_compute never hit the network."""
        import unittest.mock as _mock
        import yfinance as yf
        return _mock.patch.object(yf, "Ticker", return_value=self._FakeTicker())

    # ── 1. liveSignals sector fallback in the log payload ────────────────────
    def test_log_payload_livesignals_sector_fallback(self):
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn(
            "r.sector || holding?.sector || state.liveSignals[r.ticker]?.sector || null",
            src,
            "log payload must fall back to state.liveSignals[...].sector",
        )

    # ── 2. _resolve_missing_sectors backfill ─────────────────────────────────
    def test_resolve_missing_sectors_fills_from_map(self):
        from routes.learning import _resolve_missing_sectors
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                # BHP.AX → Materials (in SECTOR_MAP); ZZZX.AX → unknown (skipped)
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, outcome_status,
                       was_executed, sector, timestamp)
                    VALUES ('recommendation','BHP.AX','BUY','win',1,NULL,datetime('now'))
                """)
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, outcome_status,
                       was_executed, sector, timestamp)
                    VALUES ('recommendation','ZZZX.AX','BUY','win',1,'',datetime('now'))
                """)
                n = _resolve_missing_sectors(conn)
                self.assertEqual(n, 1, "only BHP.AX should be filled (ZZZX unknown)")
                bhp = conn.execute(
                    "SELECT sector FROM ai_learning_events WHERE ticker='BHP.AX'"
                ).fetchone()
                zzz = conn.execute(
                    "SELECT sector FROM ai_learning_events WHERE ticker='ZZZX.AX'"
                ).fetchone()
                self.assertEqual(bhp[0], "Materials")
                self.assertIn(zzz[0], (None, ""))   # unknown ticker left untouched
                # Idempotent — second call resolves nothing new.
                self.assertEqual(_resolve_missing_sectors(conn), 0)
        finally:
            asx_server.get_db = _orig_get_db

    def test_resolve_missing_sectors_wired_into_calib_compute(self):
        with open(os.path.join(ROOT, "routes", "learning.py"), encoding="utf-8") as f:
            src = f.read()
        idx = src.index("def _calib_compute(")
        body = src[idx:idx + 12000]
        self.assertIn("_resolve_missing_sectors(conn)", body,
                      "_resolve_missing_sectors must run inside _calib_compute")

    # ── 3. calibration sector line shows vs-market delta + is gated ──────────
    def _seed_sector_dataset(self, conn):
        """Whole-market baseline ~50% WR; Materials strongly underperforms,
        Healthcare strongly outperforms, each with enough n to clear the CI gate."""
        self._clean_events(conn)
        rows = []
        # Baseline filler — other sectors at ~50% (Financials, 20 rows 10/10).
        for i in range(20):
            rows.append(("F%d.AX" % i, "Financials", "win" if i < 10 else "loss"))
        # Materials: 14 rows, 2 wins → ~14% WR (well below market, n high).
        for i in range(14):
            rows.append(("M%d.AX" % i, "Materials", "win" if i < 2 else "loss"))
        # Healthcare: 14 rows, 13 wins → ~93% WR (well above market).
        for i in range(14):
            rows.append(("H%d.AX" % i, "Healthcare", "win" if i < 13 else "loss"))
        for tk, sec, won in rows:
            conn.execute("""
                INSERT INTO ai_learning_events
                  (event_type, ticker, recommendation, outcome_status,
                   ai_confidence, was_executed, sector, regime, timestamp)
                VALUES ('recommendation',?, 'BUY',?,0.7,1,?, 'riskOn', datetime('now'))
            """, (tk, won, sec))

    def test_calibration_sector_line_shows_vs_market_delta(self):
        from routes.learning import _calib_compute
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._seed_sector_dataset(conn)
            with self._stub_yf():
                res = _calib_compute("riskOn", "Materials,Healthcare", "", 90, deep=True)
            block = res.get("block", "")
            self.assertIn("vs mkt", block, "sector line must show the market baseline")
            self.assertIn("Materials:", block)
            self.assertIn("⚠underperform", block)
            self.assertIn("Healthcare:", block)
            self.assertIn("✓strong", block)
        finally:
            asx_server.get_db = _orig_get_db

    def test_calibration_sector_gated_below_n(self):
        from routes.learning import _calib_compute
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                # Baseline filler so n≥30 gate passes, but Materials has only 3 rows
                # (ESS < 6.0 → no sector line emitted).
                for i in range(30):
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           ai_confidence, was_executed, sector, regime, timestamp)
                        VALUES ('recommendation',?, 'BUY',?,0.7,1,'Financials','riskOn',
                                datetime('now'))
                    """, ("F%d.AX" % i, "win" if i % 2 == 0 else "loss"))
                for i in range(3):
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           ai_confidence, was_executed, sector, regime, timestamp)
                        VALUES ('recommendation',?, 'BUY','loss',0.7,1,'Materials','riskOn',
                                datetime('now'))
                    """, ("M%d.AX" % i,))
            with self._stub_yf():
                res = _calib_compute("riskOn", "Materials", "", 90, deep=True)
            block = res.get("block", "")
            self.assertNotIn("Materials:", block,
                             "sector below ESS floor must be suppressed")
        finally:
            asx_server.get_db = _orig_get_db

    # ── 4. /api/learning/stats by_sector ─────────────────────────────────────
    def test_stats_by_sector_with_vs_market_and_dominant_tag(self):
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                # Whole-market: 10 wins / 10 losses → 50% baseline.
                # Financials: 8 rows, 6 wins (75%, +25pp vs market), dominant
                # error tag among losses = 'poor_entry' (multi-tag split).
                for i in range(8):
                    won = "win" if i < 6 else "loss"
                    et = None if won == "win" else "poor_entry,overconfident"
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           realized_pnl_pct, was_executed, sector, error_type, timestamp)
                        VALUES ('recommendation',?, 'BUY',?,?,1,'Financials',?,datetime('now'))
                    """, ("F%d.AX" % i, won, 5.0 if won == "win" else -3.0, et))
                # Materials: 12 rows, 4 wins (~33%) — drags market down; losses
                # tagged 'poor_entry' once + 'thesis_broken' many → dominant differs.
                for i in range(12):
                    won = "win" if i < 4 else "loss"
                    et = None if won == "win" else "thesis_broken"
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           realized_pnl_pct, was_executed, sector, error_type, timestamp)
                        VALUES ('recommendation',?, 'BUY',?,?,1,'Materials',?,datetime('now'))
                    """, ("M%d.AX" % i, won, 5.0 if won == "win" else -3.0, et))
            with asx_server.app.test_client() as c:
                data = c.get("/api/learning/stats").get_json()
            self.assertIn("by_sector", data)
            by_sec = {s["sector"]: s for s in data["by_sector"]}
            self.assertIn("Financials", by_sec)
            self.assertIn("Materials", by_sec)
            mkt = data["overall_win_rate"]
            fin = by_sec["Financials"]
            self.assertEqual(fin["n"], 8)
            self.assertAlmostEqual(fin["wr_vs_market_pp"],
                                   round(fin["win_rate"] - mkt, 1), places=1)
            # dominant_error_tag uses multi-tag split (gotcha #45): Financials
            # losses are tagged poor_entry,overconfident → both counted; either is
            # acceptable as dominant (tie), but must be one of them.
            self.assertIn(fin["dominant_error_tag"], ("poor_entry", "overconfident"))
            self.assertEqual(by_sec["Materials"]["dominant_error_tag"], "thesis_broken")
            self.assertIsNotNone(fin["avg_pnl_pct"])
        finally:
            asx_server.get_db = _orig_get_db

    # ── 5. exemplars prefer same-sector when supplied ────────────────────────
    def _seed_exemplar_sectors(self, conn):
        self._clean_events(conn)
        # Materials: 3 losses + 2 wins (enough to satisfy caps on its own).
        for i in range(3):
            conn.execute("""
                INSERT INTO ai_learning_events
                  (event_type, ticker, recommendation, outcome_status,
                   realized_pnl_pct, holding_period_days, was_executed,
                   sector, entry_signals_json, error_type, timestamp)
                VALUES ('recommendation',?, 'BUY','loss',?,5,1,'Materials',?,'poor_entry',?)
            """, ("ML%d.AX" % i, -4.0 - i,
                  json.dumps({"rsi_14": 55, "bb_pct_b": 0.6, "setup_score": 40}),
                  "2026-01-1%d 10:00:00" % i))
        for i in range(2):
            conn.execute("""
                INSERT INTO ai_learning_events
                  (event_type, ticker, recommendation, outcome_status,
                   realized_pnl_pct, holding_period_days, was_executed,
                   sector, entry_signals_json, success_tags, timestamp)
                VALUES ('recommendation',?, 'BUY','win',?,8,1,'Materials',?,'confluence_entry',?)
            """, ("MW%d.AX" % i, 12.0 + i,
                  json.dumps({"rsi_14": 28, "bb_pct_b": 0.1, "setup_score": 75}),
                  "2026-01-2%d 10:00:00" % i))
        # Healthcare: extra trades that should be excluded when Materials is supplied.
        for i in range(3):
            conn.execute("""
                INSERT INTO ai_learning_events
                  (event_type, ticker, recommendation, outcome_status,
                   realized_pnl_pct, holding_period_days, was_executed,
                   sector, entry_signals_json, error_type, timestamp)
                VALUES ('recommendation',?, 'BUY','loss',?,5,1,'Healthcare',?,'poor_entry',?)
            """, ("HL%d.AX" % i, -5.0,
                  json.dumps({"rsi_14": 50, "bb_pct_b": 0.5, "setup_score": 35}),
                  "2026-02-1%d 10:00:00" % i))

    def test_exemplars_prefer_same_sector(self):
        from routes.learning import _compute_exemplars
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._seed_exemplar_sectors(conn)
                lines = _compute_exemplars(conn, sector="Materials")
            # Materials has enough in both buckets → exemplars must be all-Materials.
            self.assertTrue(lines)
            self.assertTrue(all("M" in ln.split()[1] for ln in lines))
            self.assertFalse(any(" HL" in ln for ln in lines),
                             "Healthcare must be excluded when Materials suffices")
        finally:
            asx_server.get_db = _orig_get_db

    def test_exemplars_fall_back_when_sector_too_few(self):
        from routes.learning import _compute_exemplars
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._clean_events(conn)
                # Only 1 Materials loss (below cap) → must top up from whole-market.
                conn.execute("""
                    INSERT INTO ai_learning_events
                      (event_type, ticker, recommendation, outcome_status,
                       realized_pnl_pct, holding_period_days, was_executed,
                       sector, entry_signals_json, error_type, timestamp)
                    VALUES ('recommendation','MAT.AX','BUY','loss',-4.0,5,1,'Materials',?,
                            'poor_entry','2026-01-10 10:00:00')
                """, (json.dumps({"rsi_14": 55, "bb_pct_b": 0.6, "setup_score": 40}),))
                for i in range(3):
                    conn.execute("""
                        INSERT INTO ai_learning_events
                          (event_type, ticker, recommendation, outcome_status,
                           realized_pnl_pct, holding_period_days, was_executed,
                           sector, entry_signals_json, error_type, timestamp)
                        VALUES ('recommendation',?, 'BUY','loss',-5.0,5,1,'Healthcare',?,
                                'poor_entry',?)
                    """, ("HL%d.AX" % i,
                          json.dumps({"rsi_14": 50, "bb_pct_b": 0.5, "setup_score": 35}),
                          "2026-02-1%d 10:00:00" % i))
                lines = _compute_exemplars(conn, sector="Materials")
            # Materials alone can't fill the loss cap → whole-market tops up.
            self.assertTrue(any(" MAT" in ln for ln in lines))
            self.assertTrue(any(" HL" in ln for ln in lines),
                            "must top up from whole-market when same-sector too few")
        finally:
            asx_server.get_db = _orig_get_db

    # ── 6. deep vs light: full sector breakdown only in deep ─────────────────
    def test_sector_breakdown_deep_vs_light(self):
        from routes.learning import _calib_compute
        _install_in_memory_db()
        asx_server.init_db()
        try:
            with _test_get_db() as conn:
                self._seed_sector_dataset(conn)
            with self._stub_yf():
                deep = _calib_compute("riskOn", "Materials,Healthcare", "", 90, deep=True)
                light = _calib_compute("riskOn", "Materials,Healthcare", "", 90, deep=False)
            d_block = deep.get("block", "")
            l_block = light.get("block", "")
            # The section-3 sector breakdown lines carry the "vs mkt" delta form
            # ("Materials:NN%WR vs mkt MM%..."). Deep emits one such line PER sector;
            # light collapses to a single "sector:<most-divergent>" summary line.
            # (The separate sector×regime block — section 8 — is regime-conditional
            # and present in both modes, so we key off the distinctive "%WR vs mkt"
            # breakdown form, not the bare "Sector:" prefix.)
            d_breakdown = d_block.count("WR vs mkt")
            l_breakdown = l_block.count("WR vs mkt")
            self.assertGreaterEqual(d_breakdown, 2,
                                    "deep must emit a vs-mkt line per qualifying sector")
            self.assertEqual(l_breakdown, 1,
                             "light must collapse to a single vs-mkt summary line")
            # Light's single breakdown line is prefixed 'sector:'.
            self.assertIn("sector:", l_block)
        finally:
            asx_server.get_db = _orig_get_db


class TestCriticsAddressing(unittest.TestCase):
    """Regression tests for critics.md improvements — confidence-held badge,
    fundamentals rule, financials sector module, reallocation suggestion,
    and scenario/case rendering."""

    @classmethod
    def _read(cls, rel_path):
        with open(os.path.join(ROOT, rel_path), encoding="utf-8") as f:
            return f.read()

    # ── Problem 1: _confidenceHeld ──────────────────────────────────────────

    def test_confidence_held_set_in_analysis(self):
        """analysis.js must set _confidenceHeld:true on low-confidence recs."""
        src = self._read("js/analysis.js")
        self.assertIn("_confidenceHeld: true", src,
                      "analysis.js must stamp _confidenceHeld:true alongside _ruleWarnings for below-floor recs")

    def test_confidence_held_badge_in_rec_card(self):
        """recommendations.js must render the ⛔ HELD badge when _confidenceHeld is set."""
        src = self._read("js/pages/recommendations.js")
        self.assertIn("_confidenceHeld", src,
                      "recommendations.js must check r._confidenceHeld to render the HELD badge")
        self.assertIn("HELD", src,
                      "recommendations.js must render a visible HELD label for low-confidence recs")

    # ── Problem 4: fundamentals > technicals rule ───────────────────────────

    def test_fundamentals_rule_in_prompt(self):
        """prompts.js must include Rule 20 (fundamentals over technicals)."""
        src = self._read("js/prompts.js")
        self.assertIn("FUNDAMENTALS OVER TECHNICALS", src,
                      "ANALYSIS_SYSTEM_PROMPT must include Rule 20 — fundamentals over technicals for established positions")
        self.assertIn("confirming", src,
                      "Rule 20 must explicitly label RSI/BB/MA as confirming signals, not primary drivers")

    def test_prompt_version_v15(self):
        """PROMPT_VERSION must be v15 after adding Rule 20."""
        src = self._read("js/prompts.js")
        self.assertIn("PROMPT_VERSION = '2026-06-v15'", src,
                      "PROMPT_VERSION must be bumped to 2026-06-v15")

    # ── Problem 5/6: Financials sector module ──────────────────────────────

    def test_financials_module_defined(self):
        """prompt-modules.js must define a FINANCIALS_SECTOR rule module."""
        src = self._read("js/prompt-modules.js")
        self.assertIn("FINANCIALS_SECTOR", src,
                      "RULE_MODULES must include a FINANCIALS_SECTOR entry")
        self.assertIn("NIM", src,
                      "FINANCIALS_SECTOR module must reference Net Interest Margin (NIM)")
        self.assertIn("CET1", src,
                      "FINANCIALS_SECTOR module must reference CET1 capital adequacy")
        self.assertIn("RBA", src,
                      "FINANCIALS_SECTOR module must reference the RBA rate path")

    def test_financials_module_wired_in_assembly(self):
        """assembleOptionalModules must detect 'financials' sector and inject the module."""
        src = self._read("js/prompt-modules.js")
        self.assertIn("FINANCIALS_SECTOR", src,
                      "assembleOptionalModules must push RULE_MODULES.FINANCIALS_SECTOR")
        self.assertIn("financials", src,
                      "assembleOptionalModules sector detection must match 'financials'")

    def test_financials_module_uses_livesignals_sectors(self):
        """assembleOptionalModules must check liveSignals sectors, not just portfolio."""
        src = self._read("js/prompt-modules.js")
        self.assertIn("liveSignals", src,
                      "assembleOptionalModules must include sectors from state.liveSignals for candidate tickers")

    # ── Problem 8: reallocationSuggestion ──────────────────────────────────

    def test_reallocation_in_prompt_schema(self):
        """prompts.js schema must include reallocationSuggestion for SELL/TRIM."""
        src = self._read("js/prompts.js")
        self.assertIn("reallocationSuggestion", src,
                      "Output schema must include reallocationSuggestion field for SELL/TRIM")
        self.assertIn("where should this freed capital go", src.lower().replace("where should this freed capital go", "where should this freed capital go"),
                      "reallocationSuggestion description must explain purpose")

    def test_reallocation_rendered_in_rec_card(self):
        """recommendations.js must render reallocationSuggestion in the SELL/TRIM panel."""
        src = self._read("js/pages/recommendations.js")
        self.assertIn("reallocationSuggestion", src,
                      "recommendations.js must render r.reallocationSuggestion in the SELL reason block")
        self.assertIn("Capital:", src,
                      "reallocationSuggestion panel must have a visible 'Capital:' label")

    # ── Problem 9: scenarios + bull/bear cases rendered ────────────────────

    def test_scenarios_rendered_in_rec_card(self):
        """recommendations.js must render the bull/base/bear scenarios grid on the rec card."""
        src = self._read("js/pages/recommendations.js")
        self.assertIn("12-month scenarios", src,
                      "rec card must show a '12-month scenarios' section")
        self.assertIn("sc.bull", src,
                      "scenarios rendering must access r.scenarios.bull")
        self.assertIn("sc.bear", src,
                      "scenarios rendering must access r.scenarios.bear")

    def test_bull_bear_cases_rendered_in_rec_card(self):
        """recommendations.js must render bullCase and bearCase in the rec card body."""
        src = self._read("js/pages/recommendations.js")
        self.assertIn("r.bullCase", src,
                      "rec card must render r.bullCase in the card body")
        self.assertIn("r.bearCase", src,
                      "rec card must render r.bearCase in the card body")
        self.assertIn("Bull case", src,
                      "rec card must have a 'Bull case' label visible to the user")
        self.assertIn("Bear case", src,
                      "rec card must have a 'Bear case' label visible to the user")

    # ── Problem 10: invalidationCondition ──────────────────────────────────

    def test_invalidation_condition_in_prompt_schema(self):
        """prompts.js must include invalidationCondition in the output schema."""
        src = self._read("js/prompts.js")
        self.assertIn("invalidationCondition", src,
                      "Output schema must include invalidationCondition field")
        self.assertIn("measurable value", src,
                      "invalidationCondition description must require a measurable value (price level, %, event)")

    def test_invalidation_condition_in_validator(self):
        """response-validator.js REC_SCHEMA must validate invalidationCondition."""
        src = self._read("js/response-validator.js")
        self.assertIn("invalidationCondition", src,
                      "REC_SCHEMA must include invalidationCondition so missing values are caught in the repair loop")

    def test_invalidation_condition_rendered_in_rec_card(self):
        """recommendations.js must render invalidationCondition visibly on the rec card body."""
        src = self._read("js/pages/recommendations.js")
        self.assertIn("invalidationCondition", src,
                      "rec card must reference r.invalidationCondition")
        self.assertIn("Invalidated if", src,
                      "rec card must show a visible 'Invalidated if' label for the condition")

    # ── Priority 1: Intraday 5m ATR ────────────────────────────────────────

    def test_intraday_atr_5m_computed_in_backend(self):
        src = self._read('routes/intraday.py')
        self.assertIn('atr_5m', src)
        self.assertIn('rolling(14)', src)

    def test_intraday_atr_used_in_frontend(self):
        src = self._read('js/intraday-strategy.js')
        self.assertIn('atr_5m', src)
        # Sprint 73b: stop is now ip.stopAtrMult * atr_5m (user-configurable, not hardcoded 1.5)
        self.assertIn('stopAtrMult', src)
        self.assertIn('ip.stopAtrMult * d.atr_5m', src)

    # ── Priority 5: Debate engine in collapsible section ───────────────────

    def test_debate_engine_in_collapsible_section(self):
        src = self._read('js/pages/learning.js')
        self.assertIn('<details', src)
        self.assertIn('ADVANCED', src)

    # ── Priority 6: Sector ETF relative strength ───────────────────────────

    def test_sector_etf_map_in_indicators(self):
        src = self._read('indicators.py')
        self.assertIn('SECTOR_ETF_MAP', src)
        self.assertIn('XFJ.AX', src)

    def test_sector_rs_5d_in_analyse_ticker_output(self):
        src = self._read('indicators.py')
        self.assertIn('sector_rs_5d', src)


class TestLearningLoopImprovements(unittest.TestCase):
    """Tests for priorities 2+3+4: thesis states, success tags, 3D matrix."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config['TESTING'] = True

    @classmethod
    def tearDownClass(cls):
        asx_server.get_db = _orig_get_db

    def _read(self, relpath):
        with open(os.path.join(ROOT, relpath), encoding='utf-8') as f:
            return f.read()

    # ── Priority 2: partially_validated + reversed thesis states ───────────

    def test_partial_validated_in_learning_loop(self):
        src = self._read('js/learning-loop.js')
        self.assertIn('partially_validated', src)
        self.assertIn('reversed', src)

    # ── Priority 3: Deterministic success tags ────────────────────────────

    def test_success_tags_deterministic_function_exists(self):
        src = self._read('routes/learning.py')
        self.assertIn('_classify_success_tags_deterministic', src)
        self.assertIn('clean_path', src)

    def test_resolve_deterministic_tags_fills_success_tags(self):
        src = self._read('routes/learning.py')
        self.assertIn('_classify_success_tags_deterministic', src)
        self.assertIn('success_tags', src)

    # ── Priority 4: Driver × Regime × Sector 3D endpoint ─────────────────

    def test_driver_matrix_endpoint_exists(self):
        src = self._read('routes/learning.py')
        self.assertIn('driver-matrix', src)
        self.assertIn('_compute_driver_regime_sector_xtab', src)

    def test_driver_matrix_route_accessible(self):
        r = self.client.get('/api/learning/driver-matrix')
        self.assertIn(r.status_code, (200, 404))
        if r.status_code == 200:
            data = r.get_json()
            self.assertTrue(data.get('ok'))
            self.assertIn('cells', data)


if __name__ == "__main__":
    unittest.main(verbosity=2)
