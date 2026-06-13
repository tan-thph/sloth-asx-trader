"""
gunicorn.conf.py — production-grade WSGI server config (Linux / macOS only).

gunicorn uses fcntl which is a POSIX-only module — it does NOT run on Windows.
On Windows use waitress_server.py instead:

    python waitress_server.py          # Windows / macOS / Linux

On Linux / macOS you can also use gunicorn:

    pip install gunicorn
    gunicorn -c gunicorn.conf.py 'asx_server:app'

Compared to `python asx_server.py` (Flask dev server), both options give:
  • Proper multi-threaded request handling (not Flask's single-threaded default)
  • Graceful shutdown that terminates the ngrok tunnel cleanly
  • Production-level logging
"""

import multiprocessing

# Bind to loopback only — prevents other devices on your LAN from reaching the API.
# Change to "0.0.0.0:5000" only if you deliberately access the app from another
# device (e.g. phone on the same Wi-Fi).
bind = "127.0.0.1:5000"

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
