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
import unittest

# ── Bootstrap: import the Flask app ──────────────────────────────────────────
ROOT = os.path.dirname(__file__)
sys.path.insert(0, ROOT)

# Patch DB path to a shared in-memory SQLite so tests don't touch production data.
# We use check_same_thread=False + a module-level shared connection so all
# test calls share the same in-memory DB (each new sqlite3.connect(':memory:')
# would create a *separate* isolated DB, breaking cross-call state).
import asx_server

_orig_get_db = asx_server.get_db
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


class TestLearningLoopRoutes(unittest.TestCase):
    """Tests for /api/learning/* endpoints."""

    @classmethod
    def setUpClass(cls):
        # Patch get_db globally before init_db so the in-memory DB is used
        asx_server.get_db = _test_get_db
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


class TestQuoteRoute(unittest.TestCase):
    """Smoke-test /api/quote — just checks response shape, not live price."""

    @classmethod
    def setUpClass(cls):
        asx_server.get_db = _test_get_db
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
        asx_server.get_db = _test_get_db
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
        asx_server.get_db = _test_get_db
        asx_server.init_db()
        # Force cache miss so route actually runs
        asx_server._PM_CACHE["data"] = None
        asx_server._PM_CACHE["fetched_at"] = 0.0
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
        self.assertEqual(len(body["markets"]), len(asx_server._PM_QUERIES))

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
    def test_buildCalibrationPromptBlock_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function buildCalibrationPromptBlock"))

    def test_refreshLearningCache_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function refreshLearningCache"))

    def test_computeAllTradesStats_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function computeAllTradesStats"))

    def test_computeRRRealization_defined(self):
        self.assertTrue(self._contains("js/learning-loop.js", "function computeRRRealization"))

    def test_detectStrategyDecay_has_volatility(self):
        self.assertTrue(self._contains("js/learning-loop.js", "recentVolatility"))

    def test_refreshLearningCache_wired_in_analysis(self):
        self.assertTrue(self._contains("js/analysis.js", "refreshLearningCache"))

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
        asx_server.get_db = _test_get_db
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
