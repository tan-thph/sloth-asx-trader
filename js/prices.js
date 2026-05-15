// ============================================================
// LIVE PRICE REFRESH
// ============================================================
async function refreshPrices(opts = {}) {
  const {silent = false} = opts;
  if(!state.serverOk) { if(!silent) toast('Backend server not running. See Settings.','error'); return 0; }
  if(!silent) toast('Fetching live ASX prices...','info');
  const uniqueTickers = [...new Set(state.portfolio.map(h => h.ticker))];
  let updated = 0;
  for(const ticker of uniqueTickers) {
    try {
      const r = await fetch(`${API}/api/quote/${ticker}`);
      if(!r.ok) continue;
      const d = await r.json();
      if(d.price) {
        state.portfolio.filter(h => h.ticker === ticker).forEach(h => {
          h.currentPrice = d.price;
          if(d.sector && (!h.sector || h.sector === 'Other')) h.sector = d.sector;
        });
        updated++;
      }
    } catch {}
  }
  state.lastPriceRefresh = Date.now();
  if(!silent) toast(`Updated ${updated} prices from yfinance`,'success');
  recordPortfolioSnapshot();
  scheduleSave();
  renderPage();
  return updated;
}

// ============================================================
// PORTFOLIO SNAPSHOT (records net worth over time)
// ============================================================
function recordPortfolioSnapshot() {
  const today = todayStr();
  const nw = totalNetWorth();
  const pv = portfolioValue();
  const last = state.portfolioHistory[state.portfolioHistory.length - 1];
  // Only record one snapshot per day (overwrite if same day)
  if (last && last.date === today) {
    last.netWorth = nw;
    last.portfolioValue = pv;
    last.cash = state.cash;
  } else {
    state.portfolioHistory.push({ date: today, netWorth: nw, portfolioValue: pv, cash: state.cash });
  }
  // Keep max 3 years of daily data
  if (state.portfolioHistory.length > 1095) state.portfolioHistory.shift();
  // Always persist to localStorage as fallback (works even when backend is offline)
  try { localStorage.setItem('asx_portfolio_history', JSON.stringify(state.portfolioHistory)); } catch {}
}
