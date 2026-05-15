// ============================================================
// NAVIGATION
// ============================================================
function showPage(page) {
  // Stop announcement poller when navigating away from announcements
  if (state.page === 'announcements' && page !== 'announcements') {
    if (typeof _stopAnnSyncPoller === 'function') _stopAnnSyncPoller();
  }
  state.page = page;
  state._renderGen = (state._renderGen || 0) + 1; // invalidate any in-flight async renders
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => { if(el.getAttribute('onclick')?.includes("'"+page+"'")) el.classList.add('active'); });
  const titles = {dashboard:'Dashboard',portfolio:'Portfolio',macro:'Morning Macro',recommendations:'Trade Recommendations',signals:'Live Signals (yfinance)',journal:'Trade Journal',performance:'Performance Analytics',history:'Portfolio Value History',cgt:'CGT Parcel Tracker',backtest:'Backtesting',assistant:'AI Assistant',news:'News Scanner',announcements:'ASX Announcements',settings:'Settings'};
  document.getElementById('page-title').textContent = titles[page] || page;
  renderPage();
}
function renderPage() {
  const el = document.getElementById('main-content');
  const gen = (state._renderGen = (state._renderGen || 0)); // snapshot current gen
  switch(state.page) {
    case 'dashboard':       el.innerHTML = renderDashboard(); break;
    case 'portfolio':       el.innerHTML = renderPortfolio(); break;
    case 'macro':           el.innerHTML = renderMacro(); break;
    case 'recommendations': el.innerHTML = renderRecommendations(); break;
    case 'signals':         renderSignalsPage(gen); break;
    case 'journal':         el.innerHTML = renderJournal(); break;
    case 'performance':     el.innerHTML = renderPerformance(); break;
    case 'history':         el.innerHTML = renderPortfolioHistory(); setTimeout(() => { if(state._renderGen === gen) drawHistoryChart(); }, 80); break;
    case 'cgt':             el.innerHTML = renderCGT(); break;
    case 'backtest':        el.innerHTML = renderBacktest(); break;
    case 'assistant':       el.innerHTML = renderAssistant(); setTimeout(() => { const m = document.getElementById('chat-messages'); if(m) m.scrollTop = m.scrollHeight; }, 50); break;
    case 'news':            renderNewsPage(gen); break;
    case 'announcements':   renderAnnouncementsPage(gen); break;
    case 'settings':        el.innerHTML = renderSettings(); setTimeout(() => { if(state._renderGen === gen) renderSchedulerLog(); }, 0); break;
  }
}
