// ============================================================
// INIT
// ============================================================
async function initApp() {
  await checkServer();
  if (state.serverOk) {
    const loaded = await loadStateFromDb();
    if (loaded) toast('Portfolio loaded from database', 'success');
    // Fetch live RBA rate and authoritative cash balance on startup
    await Promise.all([
      fetchRbaRate(),
      fetchCashFromDb(),
      fetchEarningsCalendar(),
      fetchNewsSettings(),
    ]);
  }
  // Restore portfolioHistory from localStorage if DB had none (offline fallback)
  if (!state.portfolioHistory.length) {
    try {
      const saved = localStorage.getItem('asx_portfolio_history');
      if (saved) { state.portfolioHistory = JSON.parse(saved); }
    } catch {}
  }

  // Auto-save whenever the user leaves/hides the tab — catches tab switch, minimize, etc.
  // The visibilitychange path has time to complete the async fetch because the browser
  // keeps background tabs alive briefly after the event fires.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveStateToDb();
  });

  // beforeunload: the browser may kill the page before an async fetch completes.
  // Cancel any pending debounce timer and fire immediately; use keepalive so the
  // browser allows the request to outlive the page (capped at 64 KB by the spec —
  // if the payload is too large the browser silently falls back to a normal request,
  // but the visibilitychange save above will have already handled large payloads for
  // normal tab/window closes).
  window.addEventListener('beforeunload', () => {
    clearTimeout(_saveTimer);  // flush any pending debounce immediately
    if (!state.serverOk) return;
    try {
      const body = JSON.stringify({
        cash: state.cash, portfolio: state.portfolio,
        tradeJournal: state.tradeJournal, recHistory: state.recHistory,
        recommendations: state.recommendations, settings: state.settings,
        activityLog: _schedulerLog, portfolioHistory: state.portfolioHistory,
        cgtParcels: state.cgtParcels, cgtDisposals: state.cgtDisposals,
        cgtMethod: state.cgtMethod, analysisConfig: state.analysisConfig,
        macroData: state.macroData, macroDate: state.macroDate,
        analysisLastSummary: state.analysisLastSummary,
        dayTrading: state.dayTrading, intraday: state.intraday,
        priceAlerts: state.priceAlerts, watchlist: state.watchlist,
        savedScreeners: state.savedScreeners, targetAllocations: state.targetAllocations,
        digestHistory: state.digestHistory, termDeposits: state.termDeposits,
      });
      fetch(`${API}/api/db/save`, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body, keepalive: true,
      });
    } catch (_) { /* best-effort — visibilitychange save already handled most cases */ }
  });

  // Periodic auto-save every 60 seconds (was 120s — halved to reduce the data-loss window
  // for long sessions with many changes).
  setInterval(() => { if (state.serverOk) saveStateToDb(); }, 60 * 1000);
  applyScheduler();
  startPriceRefresh();
  updateSbcModeButton();
  recordPortfolioSnapshot();
  scheduleSave(); // Ensure snapshot is persisted immediately
  const reconciled = reconcileJournalParcels();
  if (reconciled > 0) { scheduleSave(); }
  scheduleSave();
  if (getApiKey()) {
    // API cost is viewed directly via Anthropic Console link
  }
  renderPage();
  if (state.settings.compactMode) document.body.classList.add('compact');
  checkAutoBriefSchedule();
}

// Init
initApp();
