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
    ]);
  }
  // Restore portfolioHistory from localStorage if DB had none (offline fallback)
  if (!state.portfolioHistory.length) {
    try {
      const saved = localStorage.getItem('asx_portfolio_history');
      if (saved) { state.portfolioHistory = JSON.parse(saved); }
    } catch {}
  }

  // Auto-save whenever the user leaves/hides the tab — catches browser close, tab switch, etc.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveStateToDb();
  });
  window.addEventListener('beforeunload', () => saveStateToDb());

  // Periodic auto-save every 2 minutes as a safety net
  setInterval(() => { if (state.serverOk) saveStateToDb(); }, 2 * 60 * 1000);
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
}

// Init
initApp();
