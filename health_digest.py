"""
health_digest.py — Daily system-health digest.

Every serious incident this app has had was a SILENT failure: the mode-drop
bug quietly demoting real holdings to paper, the stale-tab save wipe, weeks
of news articles sitting mis-scored at impact 0. The common thread is a
background process degrading with nothing telling the user. This module
composes a once-daily digest of the signals that already exist — DB
integrity, backup freshness (and backup *validity*), news-scanner health,
yfinance failure volume — and delivers it through the notification centre
(always) and Telegram (only when something is wrong, so a healthy system
never spams the phone).

Wiring:
  - start_digest_scheduler() — daemon thread started from asx_server.py
    (fires ~3 min after startup, then every 24 h; a once-per-calendar-day
    guard in blob_store makes server restarts idempotent).
  - GET /api/system/health-digest (routes/news.py) — on-demand run.

No Flask imports here — same layering rule as core.py.
"""

import glob
import json
import sqlite3
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

from core import _HTTP_SESSION, log
from db import DB_PATH, get_db, quick_integrity_check

# Backup older than this is stale — backup_db() runs on startup + every 24 h,
# so 48 h of slack tolerates a skipped day without crying wolf.
_BACKUP_MAX_AGE_H = 48
# News scan older than this while the scanner is enabled = scheduler is stuck.
# Default interval is 6 h; 24 h of slack tolerates the machine being off.
_NEWS_MAX_AGE_H = 24

_TG_API = "https://api.telegram.org/bot{token}/sendMessage"


def _check_db_integrity() -> dict:
    result = quick_integrity_check()
    return {"ok": result == "ok", "detail": result}


def _check_backup() -> dict:
    """Newest dated backup: exists, is fresh, and passes PRAGMA quick_check.

    Checking the backup's own integrity matters: with keep=7 dailies, a
    corrupt backup that sits undetected for 7 days means ALL copies are bad
    by the time you need one.
    """
    pattern = str(DB_PATH.parent / f"{DB_PATH.name}.bak-2*")
    backups = sorted(glob.glob(pattern))
    if not backups:
        return {"ok": False, "detail": "no backup files found"}
    newest = Path(backups[-1])
    age_h = (time.time() - newest.stat().st_mtime) / 3600
    if age_h > _BACKUP_MAX_AGE_H:
        return {"ok": False, "detail": f"newest backup {newest.name} is {age_h:.0f}h old"}
    try:
        conn = sqlite3.connect(f"file:{newest}?mode=ro", uri=True)
        try:
            rows = conn.execute("PRAGMA quick_check").fetchall()
        finally:
            conn.close()
        if not (len(rows) == 1 and str(rows[0][0]).strip().lower() == "ok"):
            return {
                "ok": False,
                "detail": f"{newest.name} FAILED quick_check: "
                          + "; ".join(str(r[0]) for r in rows)[:200],
            }
    except Exception as exc:
        return {"ok": False, "detail": f"could not verify {newest.name}: {exc}"}
    return {"ok": True, "detail": f"{newest.name} ({age_h:.0f}h old, quick_check ok)"}


def _check_news() -> dict:
    """Last scan result + terminal-failure count + scheduler liveness."""
    detail: list[str] = []
    ok = True
    try:
        import news_engine as _ne
        with get_db() as conn:
            row = conn.execute(
                "SELECT scan_time, articles_processed, error FROM news_scan_log "
                "ORDER BY id DESC LIMIT 1"
            ).fetchone()
            terminal = conn.execute(
                "SELECT COUNT(*) FROM news_items WHERE processed = -2"
            ).fetchone()[0]
            cfg_row = conn.execute(
                "SELECT value FROM blob_store WHERE key='news_settings'"
            ).fetchone()
        enabled = True
        if cfg_row:
            try:
                enabled = bool(json.loads(cfg_row["value"]).get("enabled", True))
            except Exception:
                pass
        if not enabled:
            return {"ok": True, "detail": "scanner disabled"}
        if row is None:
            ok = False
            detail.append("no scan has ever run")
        else:
            age_h = None
            try:
                age_h = (datetime.utcnow() - datetime.fromisoformat(row["scan_time"])).total_seconds() / 3600
            except Exception:
                pass
            if row["error"]:
                ok = False
                detail.append(f"last scan errored: {str(row['error'])[:100]}")
            elif age_h is not None and age_h > _NEWS_MAX_AGE_H:
                ok = False
                detail.append(f"last scan {age_h:.0f}h ago (scheduler stuck?)")
            else:
                detail.append(
                    f"last scan {age_h:.0f}h ago, {row['articles_processed']} classified"
                    if age_h is not None else "last scan time unparseable"
                )
        alive = bool(_ne._sched_thread and _ne._sched_thread.is_alive())
        if not alive:
            # Manual-scan-only setups are legitimate; report, don't warn.
            detail.append("scheduler thread not running")
        if terminal:
            detail.append(f"{terminal} articles given up (processed=-2)")
    except ImportError:
        return {"ok": True, "detail": "news engine not installed"}
    except Exception as exc:
        return {"ok": False, "detail": f"check failed: {exc}"}
    return {"ok": ok, "detail": "; ".join(detail)}


def _check_yfinance() -> dict:
    """Volume of failed ticker fetches in the last 24 h — the early-warning
    signal for a yfinance breakage (the app's one real external dependency)."""
    try:
        with get_db() as conn:
            n = conn.execute(
                "SELECT COUNT(*) FROM failed_tickers "
                "WHERE timestamp >= datetime('now','localtime','-1 day')"
            ).fetchone()[0]
        # A handful of failures is normal (delistings, suspensions); a spike
        # means the data source itself is broken.
        return {"ok": n < 20, "detail": f"{n} failed ticker fetches in 24h"}
    except Exception as exc:
        return {"ok": False, "detail": f"check failed: {exc}"}


def collect_health() -> dict:
    """Run all checks. Pure read — safe to call from a request handler."""
    checks = {
        "db_integrity": _check_db_integrity(),
        "backup":       _check_backup(),
        "news_scanner": _check_news(),
        "yfinance":     _check_yfinance(),
    }
    # db/backup corruption is critical (data-loss risk); the rest degrade service.
    if not checks["db_integrity"]["ok"] or not checks["backup"]["ok"]:
        level = "error"
    elif not all(c["ok"] for c in checks.values()):
        level = "warning"
    else:
        level = "info"
    return {"level": level, "checks": checks, "generated_at": datetime.now().isoformat()}


def format_digest(health: dict) -> tuple[str, str]:
    """Return (title, body) for notification/Telegram delivery."""
    icon = {"info": "✅", "warning": "⚠️", "error": "🚨"}[health["level"]]
    title = f"{icon} Daily health digest — {'all systems OK' if health['level'] == 'info' else 'attention needed'}"
    lines = []
    for name, c in health["checks"].items():
        mark = "✓" if c["ok"] else "✗"
        lines.append(f"{mark} {name.replace('_', ' ')}: {c['detail']}")
    return title, "\n".join(lines)


def _write_notification(title: str, body: str, level: str) -> None:
    from notifications_db import get_notif_db
    with get_notif_db() as conn:
        conn.execute(
            "INSERT INTO notifications (type, title, body, category, timestamp) "
            "VALUES (?,?,?,?,?)",
            (level, title, body, "system", datetime.now().isoformat()),
        )


def _send_telegram(text: str) -> None:
    """Best-effort Telegram delivery using the stored server-side creds."""
    try:
        with get_db() as conn:
            rows = conn.execute(
                "SELECT key, value FROM settings WHERE key IN ('tg_token','tg_chat_id')"
            ).fetchall()
        cfg = {r["key"]: r["value"] for r in rows}
        token, chat_id = cfg.get("tg_token"), cfg.get("tg_chat_id")
        if not (token and chat_id):
            return
        _HTTP_SESSION.post(
            _TG_API.format(token=token),
            json={"chat_id": chat_id, "text": text},
            timeout=10,
        )
    except Exception as exc:
        log.warning("Health digest Telegram send failed: %s", exc)


def send_digest(force: bool = False) -> dict:
    """Compose + deliver the digest.

    Notification centre: always. Telegram: only when level != info (a healthy
    system must never train the user to ignore the alert channel). The
    once-per-calendar-day guard (blob_store) makes restart re-fires no-ops;
    `force=True` (the on-demand endpoint) bypasses it.
    """
    today = datetime.now().strftime("%Y-%m-%d")
    if not force:
        try:
            with get_db() as conn:
                row = conn.execute(
                    "SELECT value FROM blob_store WHERE key='health_digest_last'"
                ).fetchone()
            if row and row["value"] == today:
                return {"skipped": "already sent today"}
        except Exception:
            pass

    health = collect_health()
    title, body = format_digest(health)
    try:
        _write_notification(title, body, health["level"])
    except Exception as exc:
        log.warning("Health digest notification write failed: %s", exc)
    if health["level"] != "info":
        _send_telegram(f"{title}\n{body}")
        log.warning("Health digest: %s\n%s", title, body)
    else:
        log.info("Health digest: all systems OK")
    try:
        with get_db() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO blob_store (key, value, updated_at) "
                "VALUES ('health_digest_last', ?, datetime('now','localtime'))",
                (today,),
            )
    except Exception:
        pass
    return health


def start_digest_scheduler() -> None:
    """Daemon thread: first digest ~3 min after startup (lets the news
    scheduler / first scans settle), then every 24 h."""
    def _loop():
        time.sleep(180)
        while True:
            try:
                send_digest()
            except Exception as exc:
                log.warning("Health digest run failed: %s", exc)
            time.sleep(86400)

    threading.Thread(target=_loop, daemon=True, name="health-digest").start()
    log.info("Health digest scheduler started (daily)")
