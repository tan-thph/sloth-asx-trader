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
        if (!state.priceTimestamps) state.priceTimestamps = {};
        state.priceTimestamps[ticker] = d.fetched_at || new Date().toISOString();
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
  checkPriceAlerts();
  if (typeof checkRecStopTargetAlerts === 'function') checkRecStopTargetAlerts();
  checkExDivReminders();
  checkEarningsReminders();
  recordPortfolioSnapshot();
  scheduleSave();
  // Skip re-render on silent auto-refresh for async pages (news/announcements) —
  // they manage their own render cycles and a forced re-render would interrupt pollers
  const asyncPages = ['news', 'announcements'];
  if (!silent || !asyncPages.includes(state.page)) renderPage();
  return updated;
}

// ============================================================
// PRICE ALERTS — check thresholds after every price refresh
// ============================================================
function checkPriceAlerts() {
  if (!state.priceAlerts || !state.priceAlerts.length) return;
  const priceMap = {};
  for (const h of state.portfolio) priceMap[h.ticker] = h.currentPrice;

  let anyTriggered = false;
  for (const alert of state.priceAlerts) {
    if (!alert.active || alert.triggeredAt) continue;
    const price = priceMap[alert.ticker];
    if (price == null) continue;

    let fired = false;
    let msg = '';
    if (alert.type === 'above' && price >= alert.value) {
      fired = true;
      msg = `🔔 ${alert.ticker} hit $${price.toFixed(2)} — above your $${alert.value.toFixed(2)} target`;
    } else if (alert.type === 'below' && price <= alert.value) {
      fired = true;
      msg = `🔔 ${alert.ticker} fell to $${price.toFixed(2)} — below your $${alert.value.toFixed(2)} floor`;
    } else if (alert.type === 'pct_drop' && alert.referencePrice) {
      const drop = (alert.referencePrice - price) / alert.referencePrice * 100;
      if (drop >= alert.value) {
        fired = true;
        msg = `🔔 ${alert.ticker} dropped ${drop.toFixed(1)}% from $${alert.referencePrice.toFixed(2)} (now $${price.toFixed(2)})`;
      }
    }

    if (fired) {
      alert.triggeredAt = new Date().toISOString();
      alert.lastPrice   = price;
      anyTriggered = true;
      toast(msg, 'warning');
      // Browser push notification (if permission granted)
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        try { new Notification('ASX Price Alert', { body: msg }); } catch {}
      }
    }
  }
  if (anyTriggered) scheduleSave();
}

function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return;
  if (Notification.permission === 'default') {
    Notification.requestPermission().then(p => {
      if (p === 'granted') toast('Browser notifications enabled for price alerts ✓', 'success');
    });
  }
}

function addPriceAlert(ticker, type, value) {
  ticker = ticker.toUpperCase().trim();
  if (!ticker || isNaN(value) || value <= 0) { toast('Invalid alert parameters', 'error'); return; }
  // Check ticker exists in portfolio or extra tickers
  const knownTickers = [
    ...state.portfolio.map(h => h.ticker),
    ...(state.analysisConfig.extraTickers || []),
  ];
  const priceMap = {};
  for (const h of state.portfolio) priceMap[h.ticker] = h.currentPrice;

  if (!state.priceAlerts) state.priceAlerts = [];
  const referencePrice = priceMap[ticker] || null;
  state.priceAlerts.push({
    id: 'alert-' + Date.now(),
    ticker,
    type,     // 'above' | 'below' | 'pct_drop'
    value: parseFloat(value),
    referencePrice,
    active: true,
    createdAt: new Date().toISOString(),
    triggeredAt: null,
    lastPrice: null,
  });
  requestNotificationPermission();
  scheduleSave();
  toast(`Alert set: ${ticker} ${type === 'above' ? '↑ above' : type === 'below' ? '↓ below' : '↓ drop'} ${type === 'pct_drop' ? value + '%' : '$' + parseFloat(value).toFixed(2)}`, 'success');
}

function deletePriceAlert(id) {
  state.priceAlerts = (state.priceAlerts || []).filter(a => a.id !== id);
  scheduleSave();
  renderPage();
}

function rearmPriceAlert(id) {
  const alert = (state.priceAlerts || []).find(a => a.id === id);
  if (!alert) return;
  // Update reference price for pct_drop alerts
  const priceMap = {};
  for (const h of state.portfolio) priceMap[h.ticker] = h.currentPrice;
  if (alert.type === 'pct_drop' && priceMap[alert.ticker]) {
    alert.referencePrice = priceMap[alert.ticker];
  }
  alert.triggeredAt = null;
  alert.lastPrice   = null;
  scheduleSave();
  renderPage();
  toast(`Alert re-armed for ${alert.ticker}`, 'success');
}

// ============================================================
// EX-DIVIDEND & EARNINGS REMINDERS (one-shot per event per day)
// ============================================================
const _exDivAlerted    = {};  // key: `${ticker}_${exDate}` → ISO date string of when alerted
const _earningsAlerted = {};  // key: `${ticker}_${earnDate}` → ISO date string

function checkExDivReminders() {
  if (!state.portfolio || !state.dividendData) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const h of state.portfolio) {
    const div = state.dividendData[h.ticker];
    if (!div || !div.exDividendDate) continue;
    const exDate = div.exDividendDate.slice(0, 10);
    const daysUntil = Math.round((new Date(exDate) - new Date(today)) / 86400000);
    if (daysUntil < 0 || daysUntil > 5) continue;
    const key = `${h.ticker}_${exDate}`;
    if (_exDivAlerted[key] === today) continue;
    _exDivAlerted[key] = today;
    const when = daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `In ${daysUntil} days`;
    const amt  = div.nextEstAmount ? `$${fmt(div.nextEstAmount)} per share` : (div.annualDivPerShare ? `~$${fmt(div.annualDivPerShare / 4)} per share est.` : 'check broker');
    if (typeof fireAlert === 'function') {
      fireAlert(`📅 Ex-Div: ${h.ticker}`, `${when} (${exDate}) · ${amt}`, `sloth-exdiv-${h.ticker}-${exDate}`);
    }
    toast(`📅 ${h.ticker} ex-dividend ${when.toLowerCase()} (${exDate})`, 'warning');
  }
}

function checkEarningsReminders() {
  if (!state.portfolio || !state.earningsCalendar) return;
  const today = new Date().toISOString().slice(0, 10);
  for (const h of state.portfolio) {
    const ec = state.earningsCalendar[h.ticker];
    if (!ec || !ec.nextEarningsDate) continue;
    const earnDate = ec.nextEarningsDate.slice(0, 10);
    const daysUntil = Math.round((new Date(earnDate) - new Date(today)) / 86400000);
    if (daysUntil < 0 || daysUntil > 3) continue;
    const key = `${h.ticker}_${earnDate}`;
    if (_earningsAlerted[key] === today) continue;
    _earningsAlerted[key] = today;
    const when = daysUntil === 0 ? 'Today' : daysUntil === 1 ? 'Tomorrow' : `In ${daysUntil} days`;
    const target = ec.analystTarget ? ` · Analyst target $${ec.analystTarget}` : '';
    if (typeof fireAlert === 'function') {
      fireAlert(`📊 Earnings: ${h.ticker}`, `${when} (${earnDate})${target}`, `sloth-earnings-${h.ticker}-${earnDate}`);
    }
    toast(`📊 ${h.ticker} earnings ${when.toLowerCase()} (${earnDate})`, 'warning');
  }
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
