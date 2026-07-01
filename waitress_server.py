"""
waitress_server.py — production-grade WSGI server for Windows.

Waitress is a pure-Python WSGI server with no POSIX dependencies.
Use this instead of gunicorn on Windows (gunicorn requires fcntl which
is Linux/macOS only).

Usage:
    pip install waitress
    python waitress_server.py

Equivalent to:
    gunicorn -c gunicorn.conf.py 'asx_server:app'

Config mirrors gunicorn.conf.py:
  • 16 threads (matches 2 workers × 8 threads)
  • 180 s request timeout
  • Bind 0.0.0.0:5000 so LAN and Tailscale access both work
"""

import logging
import sys

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger(__name__)

try:
    from waitress import serve
except ImportError:
    sys.exit("waitress is not installed — run:  pip install waitress")

from asx_server import app

HOST    = "0.0.0.0"
PORT    = 5000
THREADS = 16        # matches gunicorn's 2 workers × 8 threads

print("=" * 60)
print("  ASX Trading Assistant – Waitress (production)")
print(f"  http://localhost:{PORT}")
print(f"  {THREADS} threads")
print("=" * 60)

log.info("Starting waitress on %s:%d with %d threads", HOST, PORT, THREADS)

serve(
    app,
    host=HOST,
    port=PORT,
    threads=THREADS,
    channel_timeout=180,    # matches gunicorn timeout = 180
    cleanup_interval=30,    # matches gunicorn graceful_timeout = 30
    connection_limit=1000,  # matches gunicorn max_requests = 1000
)
