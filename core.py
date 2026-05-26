"""
core.py — Shared infrastructure for asx_server and its route blueprints.

Anything that multiple route files need (TTL cache, HTTP session, logger,
data constants) lives here. Pure values + side-effect-free decorators only —
no Flask, no DB writes at import time.
"""

import logging
import threading
import time
from logging.handlers import RotatingFileHandler
from pathlib import Path

import requests


# ── Paths ──────────────────────────────────────────────────────────────────────

ROOT_DIR = Path(__file__).parent
LOG_DIR  = ROOT_DIR / "ai_responses"
LOG_DIR.mkdir(exist_ok=True)


# ── Logging ────────────────────────────────────────────────────────────────────
# Structured logger with daily rotation to ai_responses/server.log.

_LOG_FMT = "%(asctime)s %(levelname)-5s %(name)-12s %(message)s"
logging.basicConfig(level=logging.INFO, format=_LOG_FMT, datefmt="%H:%M:%S")

_file_handler = RotatingFileHandler(
    LOG_DIR / "server.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8"
)
_file_handler.setFormatter(logging.Formatter(_LOG_FMT, datefmt="%Y-%m-%d %H:%M:%S"))
_file_handler.setLevel(logging.INFO)
# Only attach once — re-imports during testing should not duplicate handlers.
if not any(isinstance(h, RotatingFileHandler) for h in logging.getLogger().handlers):
    logging.getLogger().addHandler(_file_handler)

log = logging.getLogger("asx")
logging.getLogger("yfinance").setLevel(logging.WARNING)
logging.getLogger("urllib3").setLevel(logging.WARNING)
logging.getLogger("werkzeug").setLevel(logging.WARNING)


# ── TTL cache decorator ───────────────────────────────────────────────────────
# Simple in-process memoiser. Thread-safe via a single lock.
# Key is (func.__name__, args, frozenset(kwargs.items())).

_cache_lock = threading.Lock()
_cache_store: dict = {}


def ttl_cache(seconds: int):
    """Memoise a function's return value for `seconds` seconds."""
    def deco(fn):
        def wrapper(*args, **kwargs):
            key = (fn.__name__, args, tuple(sorted(kwargs.items())))
            now = time.time()
            with _cache_lock:
                entry = _cache_store.get(key)
                if entry and entry[1] > now:
                    return entry[0]
            value = fn(*args, **kwargs)
            with _cache_lock:
                _cache_store[key] = (value, now + seconds)
            return value
        wrapper.__name__ = fn.__name__
        wrapper.cache_clear = lambda: _cache_store.clear()
        return wrapper
    return deco


# ── Shared HTTP session ───────────────────────────────────────────────────────
# Module-level requests.Session = HTTP keep-alive + connection pooling.
# yfinance and any other outbound HTTP picks this up via _HTTP_SESSION directly.

_HTTP_SESSION = requests.Session()
_HTTP_SESSION.headers.update({
    "User-Agent": "Mozilla/5.0 (compatible; SlothASXTrader/2.0)"
})
_adapter = requests.adapters.HTTPAdapter(pool_connections=20, pool_maxsize=50, max_retries=2)
_HTTP_SESSION.mount("http://",  _adapter)
_HTTP_SESSION.mount("https://", _adapter)


# ── Ollama base URL (debate engine + local LLM news classifier) ──────────────

OLLAMA_BASE = "http://localhost:11434"


# ── Sector map (used by market scanner) ──────────────────────────────────────
# Curated lookup for ASX200-ish tickers. Each ticker appears exactly once.
# Falls back to "Other" if a scanned ticker isn't here.

SECTOR_MAP: dict[str, str] = {
    # Financials (insurance, asset managers, exchanges, fintech, banks)
    **{t: "Financials" for t in [
        "CBA","WBC","ANZ","NAB","MQG","QBE","SUN","IAG","AMP","CGF",
        "HUB","PPT","PTM","MFG","CIN","EQT","ASX","IFL","AUB","GQG",
        "NWL","APE","JHG","PDL","SFG","AFG","CCP","OFX","MRM","WGB",
    ]},
    # Materials / Mining
    **{t: "Materials" for t in [
        "BHP","RIO","FMG","S32","MIN","IGO","LYC","NST","EVN","SFR",
        "AWC","BSL","JHX","BLD","CSR","RWC","ILU","PLS","WHC","NHC",
        "YAL","CMM","RRL","PRU","SAR","OZL","MGX","SBM","WAF","RED",
        "DEG","GOR","AKE","CRN","TBN","CHN","RSG","MML","IPX","DDH",
    ]},
    # Energy
    **{t: "Energy" for t in [
        "WDS","STO","ORG","BPT","KAR","IPL","ORI","CEG","BOE","NHC",
        "WHC","YAL","CRN",
    ]},
    # Healthcare
    **{t: "Healthcare" for t in [
        "CSL","RMD","COH","SHL","PME","MSB","HCA","EHE","HLS","IDX",
        "PNV","NAN","IMB","SDR","CU6","RAH","ACL","TLX","MX1","GEN",
    ]},
    # Consumer Discretionary
    **{t: "Consumer Discretionary" for t in [
        "WES","MYR","HVN","JBH","SUL","BRG","PMV","DMP","CKF","ARB",
        "TPW","KMD","CCX","RFG","FLT","WEB","CTD","HLO","SWM","NEC",
        "SKT","VOC","CAT","ELD",
    ]},
    # Consumer Staples
    **{t: "Consumer Staples" for t in [
        "WOW","COL","TWE","A2M","CCL","GNC","UNI","BKL","AHY","SSG",
    ]},
    # REITs
    **{t: "REITs" for t in [
        "GMG","SCG","VCX","MGR","DXS","CHC","ARF","CIP","NSR","ABP",
        "BWP","HDN","CLW","GDI","HPI","360","LIC","WPR","RGN","AEF",
    ]},
    # Industrials / Infrastructure
    **{t: "Industrials" for t in [
        "TCL","AZJ","QAN","ALQ","MND","CIM","DOW","SSM","NWH","GWA",
        "LLC","LNW","PTB","ICT","SEK","REA","CAR","IEL","DGL","MMS",
        "SIQ","SRV","CLX","NWS",
    ]},
    # Technology
    **{t: "Technology" for t in [
        "WTC","XRO","APX","CPU","ALU","MP1","TNE","DTL","DUB","ADA",
        "NEA","BVS","LNW","PPS","NXT","FPH","SPZ","AI1","FCL","MFT",
    ]},
    # Communication
    **{t: "Communication" for t in [
        "TLS","TPG","REH","SXL","HTA","NWS","SKT","QMS",
    ]},
    # Utilities
    **{t: "Utilities" for t in [
        "AGL","APA","SKI","MEZ","RGY","AGR",
    ]},
}


# ── ASX universes — ordered roughly by market cap ────────────────────────────

ASX_UNIVERSE: dict[str, list] = {
    "asx20": [
        "CBA","BHP","WBC","ANZ","NAB","WES","CSL","RIO","WTC","MQG",
        "FMG","GMG","WOW","TLS","REA","RMD","COH","QBE","WDS","TCL",
    ],
}
ASX_UNIVERSE["asx50"] = ASX_UNIVERSE["asx20"] + [
    "SUN","IAG","NST","EVN","ALL","SGP","CPU","SCG","FPH","ALQ",
    "STO","COL","TWE","NXT","LLC","MIN","HVN","ILU","JHX","ORG",
    "APA","MND","ALU","VCX","AZJ","DXS","APX","S32","MGR","CHC",
]
ASX_UNIVERSE["asx100"] = ASX_UNIVERSE["asx50"] + [
    "IGO","LYC","XRO","SHL","BLD","CSR","RWC","SFR","AMP","CGF",
    "HUB","PPT","PTM","IFL","EQT","AUB","GQG","NWL","JBH","SUL",
    "ARB","PMV","DMP","CKF","FLT","WEB","CTD","A2M","GNC","CCL",
    "ARF","CIP","NSR","BWP","ABP","HDN","CLW","QAN","SSM","MMS",
    "SEK","CAR","IEL","DTL","TNE","NWH","GWA","MP1","SWM","NEC",
]
ASX_UNIVERSE["asx200"] = ASX_UNIVERSE["asx100"] + [
    "CMM","RRL","PRU","SAR","WAF","RED","WHC","NHC","YAL","PLS",
    "AKE","CRN","TBN","OZL","MGX","SBM","DEG","GOR","AWC","BSL",
    "BPT","KAR","IPL","ORI","PME","MSB","HCA","EHE","HLS","IDX",
    "PNV","NAN","IMB","SDR","MYR","BRG","TPW","KMD","CCX","RFG",
    "HLO","SXL","HTA","TPG","REH","AGL","SKI","LNW","ICT","PTB",
    "ALU","DUB","ADA","NEA","BVS","MFG","CIN","JHG","PDL","AFG",
    "CCP","ASX","MQG","GDI","HPI","360","LLC","DGL","SIQ","NWS",
    "UNI","BKL","GNC","AUB","WGB","OFX","MRM","ELD","CAT","SFG",
]

# Dedupe every universe — preserves order, removes any accidental duplicates.
for _u in list(ASX_UNIVERSE.keys()):
    ASX_UNIVERSE[_u] = list(dict.fromkeys(ASX_UNIVERSE[_u]))
