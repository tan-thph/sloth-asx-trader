"""
gunicorn.conf.py — production-grade WSGI server config.

Run instead of `python asx_server.py` to get:
  • Multiple workers (one process per CPU is overkill; we use threads inside one
    or two workers since most blocking is I/O on yfinance).
  • Graceful worker recycling.
  • Pre-fork model so SQLite + scheduler thread are initialised cleanly.

Usage:
    pip install gunicorn
    gunicorn -c gunicorn.conf.py 'asx_server:app'
"""

import multiprocessing

# Bind locally only — same as `app.run(host="0.0.0.0")` but explicit
bind = "0.0.0.0:5000"

# Threaded model: yfinance is I/O-bound, so threads beat processes.
# 2 workers × 8 threads = 16 concurrent in-flight requests.
workers = 2
threads = 8
worker_class = "gthread"

# Generous timeout for heavy /api/market/scan and /api/backtest endpoints
timeout = 180

# Recycle workers periodically to release memory leaked by yfinance/pandas
max_requests = 1000
max_requests_jitter = 100

# Logging — gunicorn writes to stdout/stderr; the app's own RotatingFileHandler
# captures app-level logs to ai_responses/server.log.
accesslog = "-"
errorlog  = "-"
loglevel  = "info"
access_log_format = '%(h)s %(t)s "%(r)s" %(s)s %(b)s %(D)sus'

# Don't let stale workers hang on yfinance hangs
graceful_timeout = 30

# Pre-load app code so workers share the parsed module (cuts startup memory).
# IMPORTANT: this means init_db() and module-level state are shared across forks.
preload_app = True


def on_starting(server):
    server.log.info("Sloth ASX Trader starting — %d workers × %d threads", workers, threads)
