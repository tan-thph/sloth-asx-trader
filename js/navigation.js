// ============================================================
// NAVIGATION
// ============================================================
function showPage(page) {
  // Stop page-specific pollers when navigating away
  if (state.page === 'announcements' && page !== 'announcements') {
    if (typeof _stopAnnSyncPoller    === 'function') _stopAnnSyncPoller();
    if (typeof _stopAnnReclassifyPoller === 'function') _stopAnnReclassifyPoller();
  }
  if (state.page === 'news' && page !== 'news') {
    if (typeof _reclassifyPollTimer !== 'undefined' && _reclassifyPollTimer) {
      clearInterval(_reclassifyPollTimer);
      _reclassifyPollTimer = null;
    }
  }
  if (state.page === 'scanner' && page !== 'scanner') {
    if (typeof _stopScanPoller === 'function') _stopScanPoller();
  }
  state.page = page;
  state._renderGen = (state._renderGen || 0) + 1; // invalidate any in-flight async renders
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => { if(el.getAttribute('onclick')?.includes("'"+page+"'")) el.classList.add('active'); });
  const titles = {dashboard:'Dashboard',portfolio:'Portfolio',macro:'Morning Macro',recommendations:'Trade Recommendations','day-trading':'Day Trading',signals:'Live Signals (yfinance)',journal:'Trade Journal',performance:'Performance Analytics',history:'Portfolio Value History',cgt:'CGT Parcel Tracker',backtest:'Backtesting',assistant:'AI Assistant',news:'News Scanner',announcements:'ASX Announcements',risk:'Portfolio Risk',scanner:'Market Scanner',watchlist:'Watchlist',learning:'Learning Loop',settings:'Settings'};
  document.getElementById('page-title').textContent = titles[page] || page;
  renderPage();
}
function renderPage() {
  try {
    _renderPageUnsafe();
  } catch (err) {
    console.error('[renderPage] crashed:', err);
    const el = document.getElementById('main-content');
    if (el) {
      el.innerHTML = `
        <div class="card" style="padding:18px;border-left:3px solid #dc2626">
          <div style="font-weight:600;color:#dc2626;margin-bottom:6px">⚠ Page crashed</div>
          <div class="text-sm text-muted" style="margin-bottom:10px">
            The <code>${state.page}</code> page threw an exception during render.
            Other pages should still work — pick one from the sidebar, or click reset to reload.
          </div>
          <details style="margin-bottom:10px">
            <summary class="text-xs text-muted" style="cursor:pointer">Show error details</summary>
            <pre style="font-size:11px;background:var(--bg-secondary);padding:8px;border-radius:4px;margin-top:6px;white-space:pre-wrap;word-break:break-word">${String(err && err.stack || err).replace(/</g,'&lt;')}</pre>
          </details>
          <button class="btn btn-sm" onclick="showPage('dashboard')">← Back to Dashboard</button>
          <button class="btn btn-sm" onclick="location.reload()">⟳ Reload App</button>
        </div>`;
    }
  }
}

function _renderPageUnsafe() {
  const el = document.getElementById('main-content');
  const gen = (state._renderGen = (state._renderGen || 0)); // snapshot current gen
  switch(state.page) {
    case 'dashboard':       el.innerHTML = renderDashboard(); break;
    case 'portfolio':       el.innerHTML = renderPortfolio(); break;
    case 'macro':           el.innerHTML = renderMacro(); break;
    case 'recommendations':
      el.innerHTML = renderRecommendations();
      if (typeof initRecStalenessChecks === 'function') initRecStalenessChecks().catch(() => {});
      break;
    case 'day-trading':     renderDayTradingPage(gen); break;
    case 'signals':         renderSignalsPage(gen); break;
    case 'journal':         el.innerHTML = renderJournal(); break;
    case 'performance':     renderPerformancePage(gen); break;
    case 'history':         el.innerHTML = renderPortfolioHistory(); setTimeout(() => { if(state._renderGen === gen) drawHistoryChart(); }, 80); break;
    case 'cgt':             el.innerHTML = renderCGT(); break;
    case 'backtest':        el.innerHTML = renderBacktest(); break;
    case 'risk':            renderRiskPage(gen); break;
    case 'assistant':       el.innerHTML = renderAssistant(); setTimeout(() => { const m = document.getElementById('chat-messages'); if(m) m.scrollTop = m.scrollHeight; }, 50); break;
    case 'news':            renderNewsPage(gen); break;
    case 'announcements':   renderAnnouncementsPage(gen); break;
    case 'scanner':         renderScannerPage(gen); break;
    case 'watchlist':       renderWatchlistPage(gen); break;
    case 'learning':        renderLearningPage(gen); break;
    case 'settings':        el.innerHTML = renderSettings(); setTimeout(() => { if(state._renderGen === gen) renderSchedulerLog(); }, 0); break;
  }
}
