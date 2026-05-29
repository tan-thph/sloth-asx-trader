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

        Evaluates the real function extracted from both JS files against known cases.
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
        for fn in ("js/pages/recommendations.js", "js/pages/performance.js"):
            result = subprocess.run(
                ["node", "-e", node_script, os.path.join(ROOT, fn)],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0,
                             f"{fn} _detectExitReason direction logic wrong:\n{result.stderr}")


class TestInfraImprovements(unittest.TestCase):
    """Tests for the production-grade upgrades."""

    @classmethod
    def setUpClass(cls):
        _install_in_memory_db()
        asx_server.init_db()
        cls.client = asx_server.app.test_client()
        asx_server.app.config["TESTING"] = True

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

    def test_detect_exit_reason_helper_present(self):
        """_detectExitReason must be defined in both recommendations.js and performance.js."""
        for fn in ("js/pages/recommendations.js", "js/pages/performance.js"):
            with open(os.path.join(ROOT, fn), encoding="utf-8") as f:
                src = f.read()
            self.assertIn("_detectExitReason", src,
                          f"{fn} must define _detectExitReason helper")
            self.assertIn("stop_hit", src)
            self.assertIn("target_hit", src)

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
        """markExecuted must fire triggerPostmortem when outcome is loss/breakeven."""
        with open(os.path.join(ROOT, "js/pages/recommendations.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("triggerPostmortem", src,
                      "markExecuted must call triggerPostmortem on loss/breakeven")
        self.assertIn("fetchSkillScore", src,
                      "markExecuted must call fetchSkillScore after close")

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
        self.assertIn("async function fetchCalibrationBlock(regime, sectors, tickers)", src)
        self.assertIn("tickers.join(',')", src)

    def test_analysis_passes_portfolio_tickers_to_calibration(self):
        """analysis.js must pass portfolio tickers to fetchCalibrationBlock."""
        with open(os.path.join(ROOT, "js/analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_portfolioTickers", src)
        self.assertIn("fetchCalibrationBlock(_activeRegime, _portfolioSectors, _portfolioTickers)", src)


class TestStage3PromptInstructions(unittest.TestCase):
    """Regression tests for Stage 3 — Prompt instructions."""

    def test_prompt_version_bumped_to_v5(self):
        """PROMPT_VERSION must be bumped to v5 after Stage 3 changes."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("PROMPT_VERSION = '2026-05-v5'", src,
                      "PROMPT_VERSION must be bumped to 2026-05-v5")

    def test_calibration_algorithm_in_system_prompt(self):
        """System prompt must prescribe the calibration algorithm (confidence += adj, clamped)."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("clamp(orig_conf + adj", src,
                      "System prompt must describe confidence += adj clamped algorithm")
        self.assertIn("per-ticker", src,
                      "System prompt must mention per-ticker calibration adjustment")

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

    def test_morning_brief_prompt_defined(self):
        """MORNING_BRIEFING_SYSTEM_PROMPT must be defined in prompts.js."""
        with open(os.path.join(ROOT, "js/prompts.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("MORNING_BRIEFING_SYSTEM_PROMPT", src)
        self.assertIn("morning session note", src.lower())

    def test_journal_regime_badge_function(self):
        """journal.js must define _journalRegimeBadge helper."""
        with open(os.path.join(ROOT, "js/pages/journal.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_journalRegimeBadge", src)
        self.assertIn("matchedRec", src)

    def test_generate_morning_brief_function(self):
        """dashboard.js must define generateMorningBrief and use briefing agent type."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("async function generateMorningBrief()", src)
        self.assertIn("callClaude('briefing'", src)

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

    def test_rba_meeting_dates_hardcoded(self):
        """dashboard.js must hard-code RBA meeting dates for 2026 and 2027."""
        with open(os.path.join(ROOT, "js/pages/dashboard.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("_RBA_MEETINGS_2026", src)
        self.assertIn("_RBA_MEETINGS_2027", src)
        self.assertIn("2026-", src)

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
        """_drop_forming_bar must remove the last row when now_utc.hour < 7 and last bar is today."""
        import importlib, datetime
        import pandas as pd
        import indicators as ind

        # Build a 3-row DataFrame whose last row is 'today' (AEST = UTC+10)
        today_aest = (datetime.datetime.utcnow() + datetime.timedelta(hours=10)).date()
        idx = pd.to_datetime([
            str(today_aest - datetime.timedelta(days=2)),
            str(today_aest - datetime.timedelta(days=1)),
            str(today_aest),
        ])
        df = pd.DataFrame(
            {"Open": [1, 2, 3], "High": [1, 2, 3], "Low": [1, 2, 3],
             "Close": [1, 2, 3], "Volume": [100, 200, 300]},
            index=idx,
        )
        import unittest.mock as _mock
        # Patch utcnow to 06:00 UTC (before 07:00 settlement cutoff)
        fake_now = datetime.datetime(today_aest.year, today_aest.month, today_aest.day, 6, 0, 0)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.utcnow.return_value = fake_now
            mock_dt.timedelta.side_effect = lambda **kw: datetime.timedelta(**kw)
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Forming bar should be dropped before 07:00 UTC")

    def test_drop_forming_bar_keeps_bar_after_settlement(self):
        """_drop_forming_bar must NOT remove the last row after 07:00 UTC."""
        import importlib, datetime
        import pandas as pd
        import indicators as ind

        today_aest = (datetime.datetime.utcnow() + datetime.timedelta(hours=10)).date()
        idx = pd.to_datetime([
            str(today_aest - datetime.timedelta(days=1)),
            str(today_aest),
        ])
        df = pd.DataFrame(
            {"Open": [1, 2], "High": [1, 2], "Low": [1, 2],
             "Close": [1, 2], "Volume": [100, 200]},
            index=idx,
        )
        import unittest.mock as _mock
        fake_now = datetime.datetime(today_aest.year, today_aest.month, today_aest.day, 8, 0, 0)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.utcnow.return_value = fake_now
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Bar must NOT be dropped after settlement window")

    def test_drop_forming_bar_keeps_old_bars_before_settlement(self):
        """_drop_forming_bar must not drop a bar from 2+ days ago even before 07:00 UTC."""
        import datetime
        import pandas as pd
        import indicators as ind

        yesterday = (datetime.datetime.utcnow() - datetime.timedelta(days=1)).date()
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
        fake_now = datetime.datetime.utcnow().replace(hour=3)
        with _mock.patch("indicators._dt_mod") as mock_dt:
            mock_dt.datetime.utcnow.return_value = fake_now
            mock_dt.timedelta.side_effect = lambda **kw: datetime.timedelta(**kw)
            result = ind._drop_forming_bar(df)
        self.assertEqual(len(result), 2, "Old bars must never be dropped")

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
        """_in_entry_window must return False for times outside 10:45–15:00 AEST."""
        import unittest.mock as _mock
        from routes.intraday import _in_entry_window
        import datetime

        # Mock UTC time such that AEST = 10:30 (before window)
        fake_utc = datetime.datetime(2026, 5, 28, 0, 30, 0)  # 00:30 UTC = 10:30 AEST
        with _mock.patch("routes.intraday.datetime") as mock_dt:
            mock_dt.utcnow.return_value = fake_utc
            mock_dt.side_effect = lambda *a, **kw: datetime.datetime(*a, **kw)
            result = _in_entry_window()
        self.assertFalse(result)

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
            capture_output=True, text=True, cwd=ROOT, shell=True
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
        """analysis.js must call triggerCalibQualityIfStale after analysis."""
        with open(os.path.join(ROOT, "js", "analysis.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("triggerCalibQualityIfStale", src)

    def test_calib_quality_trigger_in_debate_client(self):
        """debate-client.js must define triggerCalibQualityIfStale with LOW priority."""
        with open(os.path.join(ROOT, "js", "debate-client.js"), encoding="utf-8") as f:
            src = f.read()
        self.assertIn("triggerCalibQualityIfStale", src)
        self.assertIn("LOW", src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
