// ============================================================
// RBA RATE (auto-fetch from backend)
// ============================================================
async function fetchRbaRate() {
  if (!state.serverOk) return;
  try {
    const userRate = state.rbaRate;  // Current value from settings
    const r = await fetch(`${API}/api/rba-rate?user_rate=${userRate}`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.rate != null) {
      state.rbaRate = d.rate;
      state.rbaRateSource = d.source;
      state.rbaRateDate = d.date;
      console.log(`RBA rate: ${d.rate}% (${d.source}, ${d.date})`);
    }
  } catch(e) { console.warn('RBA rate fetch failed:', e.message); }
}

// ============================================================
// CASH SYNC (fetch authoritative balance from backend)
// ============================================================
async function fetchCashFromDb() {
  if (!state.serverOk) return;
  try {
    const r = await fetch(`${API}/api/cash`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.cash != null) {
      state.cash = d.cash;
      console.log(`Cash synced from DB: $${d.cash}`);
    }
  } catch(e) { console.warn('Cash fetch failed:', e.message); }
}

// Push updated cash back to backend
async function pushCashToDb(amount) {
  if (!state.serverOk) return;
  try {
    await fetch(`${API}/api/cash`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ amount })
    });
  } catch {}
}

// ============================================================
// EARNINGS CALENDAR
// ============================================================
async function fetchEarningsCalendar(force = false) {
  if (!state.serverOk) return;
  const tickers = [...new Set([
    ...mergedPortfolio().map(h => h.ticker),
    ...(state.analysisConfig.extraTickers || []),
  ])];
  if (!tickers.length) return;
  try {
    const r = await fetch(`${API}/api/earnings-calendar?tickers=${tickers.join(',')}`);
    if (!r.ok) return;
    const data = await r.json();
    state.earningsCalendar = data;
    state.earningsLastFetch = Date.now();
    console.log(`Earnings calendar loaded for: ${Object.keys(data).join(', ')}`);
    if (state.page === 'macro' || state.page === 'dashboard') renderPage();
  } catch(e) { console.warn('Earnings calendar fetch failed:', e.message); }
}


async function fetchDividends(tickers, force = false) {
  if (!state.serverOk || !tickers.length) return;
  const toFetch = force ? tickers : tickers.filter(t => !state.dividendData[t]);
  if (!toFetch.length) return;
  try {
    const r = await fetch(`${API}/api/dividends/batch`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ tickers: toFetch, force })
    });
    if (!r.ok) return;
    const data = await r.json();
    // Normalise history: ASX uses ex_date, old yfinance path used date
    for (const ticker of Object.keys(data)) {
      const d = data[ticker];
      if (d && d.history) {
        d.history = d.history.map(h => ({
          ...h,
          date: h.date || h.ex_date,
        }));
      }
    }
    Object.assign(state.dividendData, data);
    console.log(`Dividend data loaded for: ${Object.keys(data).join(', ')}`);
  } catch(e) { console.warn('Dividend fetch failed:', e.message); }
}

// ============================================================
// DB PERSISTENCE (SQLite via Flask)
// ============================================================
let _saveTimer = null;

// Optimistic-concurrency guard. `_stateVersion` is the monotonic version the
// server returned on our last load/save. We send it as `baseVersion` on every
// save; if the server's version has moved on (another tab/device saved in
// between), the save is rejected 409 and we reload instead of clobbering the
// newer data (the 2026-07-03 stale-tab incident that wiped that morning's macro
// + recs). `null` until the first load/save completes.
let _stateVersion = null;
let _conflictReloading = false;

function scheduleSave() {
  // Debounce — save 500ms after last change (was 1500ms — shorter window = less data loss
  // if the tab is closed before the timer fires).
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(saveStateToDb, 500);
}

// On a 409 (another tab saved newer state), don't overwrite it — reload the
// fresh state so this tab catches up. Guarded against re-entrancy so a burst of
// queued saves can't trigger a reload storm.
async function _handleSaveConflict() {
  if (_conflictReloading) return;
  _conflictReloading = true;
  try {
    if (typeof toast === 'function') {
      toast('Newer data was saved in another tab — reloading to stay in sync', 'warning');
    }
    await loadStateFromDb();
    if (typeof renderPage === 'function') renderPage();
  } catch (e) { /* ignore — next interaction will retry */ }
  finally { _conflictReloading = false; }
}

// True when in-memory state holds any real user data (holdings, journal, or recs).
// A tab that never finished loading — or a stale tab whose state was reset — holds
// all-empty arrays. Persisting that blank state wipes the DB (the 2026-07-07
// incident, where a stale tab's unguarded unload-save overwrote 21 holdings + 72
// journal rows). We refuse to auto-save a fully-blank state; an intentional
// full-clear still lands because it goes through forceSave paths.
function _hasAnyUserData() {
  return !!((state.portfolio && state.portfolio.length) ||
            (state.tradeJournal && state.tradeJournal.length) ||
            (state.recHistory && state.recHistory.length));
}

async function saveStateToDb() {
  if (!state.serverOk) return;
  // Wipe-guard: never let an auto-save clobber the DB with an all-blank state.
  if (!_hasAnyUserData()) return;
  try {
    const _resp = await fetch(`${API}/api/db/save`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        baseVersion: _stateVersion,
        cash: state.cash,
        paperCash: state.paperCash,
        portfolio: state.portfolio,
        tradeJournal: state.tradeJournal,
        recHistory: state.recHistory,
        recommendations: state.recommendations,
        settings: (({ apiKey: _omit, ...rest }) => rest)(state.settings || {}),
        activityLog: _schedulerLog,
        portfolioHistory: state.portfolioHistory,
        cgtParcels: state.cgtParcels,
        cgtDisposals: state.cgtDisposals,
        cgtMethod: state.cgtMethod,
        analysisConfig: state.analysisConfig,
        macroData: state.macroData,
        macroDate: state.macroDate,
        analysisLastSummary: state.analysisLastSummary,
        dayTrading: state.dayTrading,
        intraday: state.intraday,
        priceAlerts: state.priceAlerts,
        watchlist: state.watchlist,
        savedScreeners: state.savedScreeners,
        targetAllocations: state.targetAllocations,
        digestHistory: state.digestHistory,
        termDeposits: state.termDeposits,
      })
    });
    if (_resp.status === 409) {
      // Stale save — another tab/device has newer data. Reload, don't clobber.
      await _handleSaveConflict();
      return;
    }
    if (_resp.ok) {
      try {
        const _d = await _resp.json();
        if (typeof _d.stateVersion === 'number') _stateVersion = _d.stateVersion;
      } catch (e) { /* body parse optional */ }
      _noteSaveOk();
      return;
    }
    // Non-OK, non-409 (e.g. a 500 from a UNIQUE violation — FIXES #2). A single
    // transient failure stays silent, but persistent failure is the worst thing
    // this app can do quietly (changes silently not persisting), so surface it.
    _noteSaveFail();
  } catch(e) {
    // Network/throw — same escalation as a non-OK response.
    _noteSaveFail();
  }
}

// Consecutive-failure tracker for saveStateToDb. One transient failure is normal
// (server restart, sleep); ≥2 in a row means saves are genuinely not landing.
let _saveFailCount = 0;
function _noteSaveOk() {
  if (_saveFailCount >= 2 && typeof toast === 'function') {
    toast('Saving recovered — changes are persisting again ✓', 'success');
  }
  _saveFailCount = 0;
}
function _noteSaveFail() {
  _saveFailCount++;
  if (_saveFailCount === 2 && typeof toast === 'function') {
    toast('⚠ Changes are NOT being saved (server rejected the save). Check the backend — your recent edits are at risk.', 'error');
  }
}

// Validators — coerce DB inputs to safe shapes so a bad migration or manual
// edit can't crash the UI. Each validator returns a sanitised value (never throws).

function _validNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function _validArray(v) {
  return Array.isArray(v) ? v : [];
}

function _validHolding(h) {
  if (!h || typeof h !== 'object' || !h.ticker) return null;
  const VALID_ACCOUNTS = ['personal', 'super', 'trading'];
  return {
    ticker:       String(h.ticker).toUpperCase(),
    shares:       _validNumber(h.shares, 0),
    avgPrice:     _validNumber(h.avgPrice, 0),
    currentPrice: _validNumber(h.currentPrice, 0),
    sector:       typeof h.sector === 'string' ? h.sector : 'Other',
    // account MUST be preserved — determines which portfolio tab this holding belongs to.
    // Omitting it collapses all accounts back to 'personal' on every reload.
    account:      VALID_ACCOUNTS.includes(h.account) ? h.account : 'personal',
    // mode MUST be preserved — the paper/real firewall (gotcha #88) keys every
    // real-only surface off it. Omitting it demoted the real book to paper on
    // every reload (FIXES #1). Fail-safe: anything not explicitly 'real' → 'paper'.
    mode:         h.mode === 'real' ? 'real' : 'paper',
  };
}

function _validTrade(t) {
  if (!t || typeof t !== 'object' || !t.ticker || !t.action) return null;
  return {
    ...t,
    ticker: String(t.ticker).toUpperCase(),
    qty:    _validNumber(t.qty, 0),
    entryPrice: _validNumber(t.entryPrice, 0),
    fees:   _validNumber(t.fees, 10),
  };
}

async function loadStateFromDb() {
  try {
    const r = await fetch(`${API}/api/db/load`);
    if (!r.ok) return false;
    const data = await r.json();
    // Track the server's version even on an empty DB so the very first save
    // carries a correct baseVersion (guards the fresh-install race too).
    if (typeof data.stateVersion === 'number') _stateVersion = data.stateVersion;
    // Settings are applied even when hasData is false — a settings-only DB (new user
    // who set preferences before adding holdings) must still restore. hasData now
    // reflects real user data only (portfolio/journal/recs), not settings.
    if (data.settings && Object.keys(data.settings).length) {
      state.settings = {...state.settings, ...data.settings};
    }
    if (!data.hasData) return false;

    if (data.portfolio !== undefined)    state.portfolio    = _validArray(data.portfolio).map(_validHolding).filter(Boolean);
    if (data.tradeJournal !== undefined) state.tradeJournal = _validArray(data.tradeJournal).map(_validTrade).filter(Boolean);
    if (data.recHistory !== undefined)   state.recHistory   = _validArray(data.recHistory).filter(r => (r.action||'').toUpperCase() !== 'HOLD');
    if (data.cash != null)               state.cash         = _validNumber(data.cash, 0);
    if (data.paperCash != null)          state.paperCash    = _validNumber(data.paperCash, 0);
    if (data.activityLog != null) {
      _schedulerLog = data.activityLog;
    }
    if (data.portfolioHistory != null) {
      state.portfolioHistory = data.portfolioHistory;
    }
    if (data.cgtParcels != null)   state.cgtParcels   = data.cgtParcels;
    if (data.cgtDisposals != null) state.cgtDisposals = data.cgtDisposals;
    if (data.cgtMethod != null)    state.cgtMethod    = data.cgtMethod;
    if (data.analysisConfig != null) state.analysisConfig = { ...state.analysisConfig, ...data.analysisConfig };
    if (data.macroData != null)         state.macroData         = data.macroData;
    if (data.macroDate != null)         state.macroDate         = data.macroDate;
    if (data.analysisLastSummary != null) state.analysisLastSummary = data.analysisLastSummary;
    if (Array.isArray(data.recommendations)) {
      // Only restore pending non-HOLD recs — executed/skipped ones are already in recHistory
      state.recommendations = data.recommendations.filter(r => r.status === 'pending' && (r.action||'').toUpperCase() !== 'HOLD');
    }
    if (data.dayTrading != null) {
      state.dayTrading = { ...state.dayTrading, ...data.dayTrading };
      // Reset transient fields
      state.dayTrading.analysisRunning = false;
      state.dayTrading.scanProgress = null;
    }
    if (data.intraday != null) {
      state.intraday = { ...(state.intraday || {}), ...data.intraday };
      if (state.intraday) {
        // Reset transient scan flag — scan must be manually re-triggered
        state.intraday.scanRunning = false;
        // Reset today's P&L when a new trading day starts
        if (state.intraday.pnlDate !== todayStr()) {
          state.intraday.todayPnl = 0;
          state.intraday.pnlDate  = todayStr();
        }
      }
    }
    if (Array.isArray(data.priceAlerts)) state.priceAlerts = data.priceAlerts;
    if (Array.isArray(data.watchlist)) state.watchlist = data.watchlist;
    if (Array.isArray(data.savedScreeners)) state.savedScreeners = data.savedScreeners;
    if (data.targetAllocations && typeof data.targetAllocations === 'object') state.targetAllocations = data.targetAllocations;
    if (Array.isArray(data.digestHistory)) state.digestHistory = data.digestHistory;
    if (Array.isArray(data.termDeposits)) state.termDeposits = data.termDeposits;
    return true;
  } catch(e) {
    return false;
  }
}

// ============================================================
// NEWS SETTINGS SYNC (fetch Groq/Gemini keys from backend on startup)
// ============================================================
async function fetchNewsSettings() {
  if (!state.serverOk) return;
  try {
    const r = await fetch(`${API}/api/news/status`);
    if (!r.ok) return;
    const d = await r.json();
    if (d.settings && typeof d.settings === 'object') {
      state.news.settings = { ...state.news.settings, ...d.settings };
      console.log('News settings loaded from DB (provider:', d.settings.llm_provider, ')');
    }
  } catch(e) { console.warn('News settings fetch failed:', e.message); }
}
