// ============================================================
// NAVIGATION
// ============================================================
// ── Page header metadata (title + one-line description) ──────────────────────
// Keyed by the exact page-id strings used in showPage('...') calls.
// Centralized here so no individual page file needs to render its own header.
const PAGE_META = {
  dashboard:       { title: 'Dashboard',              description: 'Portfolio snapshot, cash position, and today’s key signals at a glance.' },
  portfolio:       { title: 'Portfolio',              description: 'Current holdings, cost basis, sector weights, and live valuations.' },
  macro:           { title: 'Morning Macro',          description: 'Index levels, AUD/USD, commodities, and the AI morning briefing.' },
  recommendations: { title: 'Trade Recommendations',  description: 'AI-generated buy/sell/hold recommendations with sizing and risk levels.' },
  'day-trading':   { title: 'Day Trading',            description: 'Intraday setups, ATR-based stops/targets, and same-day strategy scans.' },
  signals:         { title: 'Live Signals',           description: 'Real-time technical indicators (RSI, MACD, Bollinger Bands) via yfinance.' },
  journal:         { title: 'Trade Journal',          description: 'Manual and AI-linked trade history with entry/exit detail.' },
  performance:     { title: 'Performance Analytics',  description: 'Win rate, drawdown, and outcome reconciliation across closed trades.' },
  history:         { title: 'Portfolio Value History', description: 'Net worth over time benchmarked against the ASX200.' },
  cgt:             { title: 'CGT Parcel Tracker',     description: 'Capital-gains parcels, discount eligibility, and disposal history.' },
  backtest:        { title: 'Backtesting',            description: 'Run historical strategy simulations and replay scoring of past recs.' },
  risk:            { title: 'Portfolio Risk',         description: 'Beta, Sharpe, VaR/CVaR, correlation matrix, and risk-budget gauge.' },
  assistant:       { title: 'AI Assistant',           description: 'Freeform chat with Claude about your portfolio and the market.' },
  news:            { title: 'News Scanner',           description: 'Aggregated headlines with LLM-classified sentiment.' },
  announcements:   { title: 'ASX Announcements',      description: 'Scraped company announcements with AI relevance scoring.' },
  scanner:         { title: 'Market Scanner',         description: 'Scan the ASX universe for setups matching your screening criteria.' },
  watchlist:       { title: 'Watchlist',              description: 'Tickers you’re monitoring but don’t yet hold.' },
  compare:         { title: 'Market Scanner',         description: 'Side-by-side comparison of selected tickers.' },
  learning:        { title: 'Learning Loop',          description: 'Calibration stats, error patterns, and trade-outcome feedback.' },
  settings:        { title: 'Settings',               description: 'API keys, display preferences, alerts, and app configuration.' },
};

// ── Page header rendering ─────────────────────────────────────────────────────
// Renders into a dedicated DOM node that lives OUTSIDE #main-content, so a
// crash inside a page's own renderX() (which overwrites #main-content wholesale,
// sometimes asynchronously) can never blank the header. Inserted lazily as a
// sibling immediately before #main-content on first use.
function _getPageHeaderEl() {
  let headerEl = document.getElementById('page-header-block');
  if (!headerEl) {
    const mainContent = document.getElementById('main-content');
    if (!mainContent || !mainContent.parentNode) return null;
    headerEl = document.createElement('div');
    headerEl.id = 'page-header-block';
    mainContent.parentNode.insertBefore(headerEl, mainContent);
  }
  return headerEl;
}

function _renderPageHeader(page) {
  const headerEl = _getPageHeaderEl();
  if (!headerEl) return;
  const meta = PAGE_META[page];
  if (!meta) { headerEl.innerHTML = ''; return; }
  headerEl.innerHTML = `
    <div class="page-header">
      <div class="page-header-title">${meta.title}</div>
      <div class="page-header-desc">${meta.description}</div>
    </div>`;
}

// ── Global system-critical banner (Forven_UIUX_Adoption.md §2.3) ─────────────
// A FOURTH, distinct alert tier from: toast() (utils.js, transient), the
// notification centre (notifications.js, historical/dismissible), and
// renderCriticalAlertBanners() (portfolio-helpers.js — PORTFOLIO-specific:
// price-decline alerts, triggered user price-alerts, rendered inside the
// Dashboard page body using the .critical-alert-banner CSS class). This banner
// is APP-WIDE (visible on every page, like the page header) and covers
// system/process-level conditions, not per-ticker ones. Deliberately named and
// classed differently (.system-critical-banner, not .critical-alert-banner) to
// avoid confusing the two tiers. Off by default — renders nothing when no
// condition is active, never a permanent empty bar.
function _getSystemBannerEl() {
  let bannerEl = document.getElementById('system-banner-block');
  if (!bannerEl) {
    const mainContent = document.getElementById('main-content');
    if (!mainContent || !mainContent.parentNode) return null;
    bannerEl = document.createElement('div');
    bannerEl.id = 'system-banner-block';
    mainContent.parentNode.insertBefore(bannerEl, mainContent);
  }
  return bannerEl;
}

// Pure — reads state only, never mutates it (gotcha #10). Each condition has
// a stable `id` (for future per-condition dismiss-when-resolved support) and
// a `severity` ('critical' | 'warning') controlling banner color.
function _computeSystemCriticalConditions() {
  const conditions = [];

  if (!state.serverOk) {
    // Nothing else here can be reliably evaluated without the backend
    // (live prices, regime, risk metrics all depend on it) — report just this.
    conditions.push({
      id: 'backend-down', severity: 'critical',
      text: 'Backend unreachable — live data, AI analysis, and trade execution are unavailable.',
    });
    return conditions;
  }

  if (state.currentRegime?.regime === 'panic') {
    conditions.push({
      id: 'panic-regime', severity: 'critical',
      text: 'PANIC regime active — new positions are blocked by the regime gate. Review existing holdings.',
    });
  }

  // Heat budget breach — same $-at-risk-on-the-live-book calc added to the
  // heat budget gate itself (js/analysis.js, Improvements.md #2), evaluated
  // here read-only for display (does not affect sizing).
  try {
    const heldTickers = new Set((state.portfolio || []).map(h => h.ticker));
    const consumed = (state.recHistory || [])
      .filter(r => r.executed && r.stopLoss > 0 && r.qty > 0 &&
                   (r.action === 'BUY' || r.action === 'TOP_UP') &&
                   (r.outcome === 'open' || !r.outcome) &&
                   heldTickers.has(r.ticker))
      .reduce((s, r) => {
        const entry = r.executedPrice || (Array.isArray(r.priceRange) ? r.priceRange[0] : null);
        return entry ? s + r.qty * Math.abs(entry - r.stopLoss) : s;
      }, 0);
    const totalValue = typeof totalNetWorth === 'function' ? totalNetWorth() : 0;
    const budgetPct  = parseFloat(state.settings?.maxRiskBudgetPct || 5);
    const budgetAUD  = totalValue * budgetPct / 100;
    if (budgetAUD > 0 && consumed > budgetAUD) {
      conditions.push({
        id: 'heat-budget', severity: 'warning',
        text: `Heat budget breached — $${Math.round(consumed).toLocaleString()} at risk vs `
            + `$${Math.round(budgetAUD).toLocaleString()} budget (${budgetPct}% of net worth).`,
      });
    }
  } catch { /* never let a risk-calc edge case break the banner */ }

  // Stop pierced without exit — an open BUY/TOP_UP recHistory entry whose
  // stop the live price has already breached, but no SELL/TRIM has closed it.
  try {
    (state.recHistory || []).forEach(r => {
      if (!r.executed || !r.stopLoss || (r.outcome && r.outcome !== 'open')) return;
      if (r.action !== 'BUY' && r.action !== 'TOP_UP') return;
      const holding = (state.portfolio || []).find(h => h.ticker === r.ticker);
      if (!holding) return; // already closed/sold
      const price = state.liveSignals?.[r.ticker]?.current_price ?? holding.currentPrice;
      if (price != null && price <= r.stopLoss) {
        conditions.push({
          id: `stop-pierced-${r.ticker}`, severity: 'warning',
          text: `${r.ticker} stop pierced ($${fmt(price)} <= $${fmt(r.stopLoss)}) — no exit recorded yet.`,
        });
      }
    });
  } catch { /* never let a stop-check edge case break the banner */ }

  return conditions;
}

function _renderSystemCriticalBanner() {
  const bannerEl = _getSystemBannerEl();
  if (!bannerEl) return;
  const conditions = _computeSystemCriticalConditions();
  if (!conditions.length) { bannerEl.innerHTML = ''; return; }
  bannerEl.innerHTML = conditions.map(c => `
    <div class="system-critical-banner system-critical-banner--${c.severity}">
      <span class="system-critical-banner-dot"></span>
      <span class="system-critical-banner-text">${escapeHTML(c.text)}</span>
    </div>`).join('');
}

// ── Global book lens (All / Live / Paper) — top ribbon ────────────────────────
// A single app-wide control for state.portfolioViewMode (gotcha #88), always
// visible in the topbar regardless of which page is open. Six pages (Dashboard,
// Portfolio, Performance, Recommendations, Risk, Backtest AI-Replay) already
// render their OWN inline copy of this same toggle — this does not replace
// them, it just adds a fast path that doesn't require navigating to one of
// those pages first. All of them write the same global, so nothing can drift
// out of sync: this ribbon re-renders on every renderPage() call (below), and
// the per-page toggles already call renderPage() themselves on click.
const _BOOK_LENS_LABELS = { all: 'All', real: '● Live', paper: '◦ Paper' };
function _getBookLensEl() {
  return document.getElementById('book-lens-ribbon');
}
function _renderBookLensRibbon() {
  const el = _getBookLensEl();
  if (!el) return;
  const vm = state.portfolioViewMode || 'all';
  el.innerHTML = `
    <span class="text-xs text-muted" style="align-self:center">Book:</span>
    ${['all', 'real', 'paper'].map(m => `
      <button class="btn btn-sm" style="${m === vm ? 'background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)' : ''}"
        onclick="setBookLens('${m}')"
        title="${m === 'all' ? 'Show live + paper together' : m === 'real' ? 'Live trades only' : 'Paper trades only'}">${_BOOK_LENS_LABELS[m]}</button>
    `).join('')}
  `;
}
// Shared setter for the topbar ribbon. Per-page toggles keep setting
// state.portfolioViewMode directly (unchanged) — this is just the ribbon's own
// click handler, kept as a named function so it survives renderPage() re-renders.
function setBookLens(mode) {
  state.portfolioViewMode = mode;
  renderPage();
}

// ── Mobile sidebar toggle ─────────────────────────────────────────────────────
function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (!sidebar) return;
  const open = sidebar.classList.toggle('mobile-open');
  if (overlay) overlay.classList.toggle('mobile-open', open);
}
function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('mobile-open');
  if (overlay) overlay.classList.remove('mobile-open');
}

function showPage(page) {
  // Auto-close mobile sidebar when navigating
  if (window.innerWidth <= 768) closeMobileSidebar();

  // Compare is now a tab inside Market Scanner — redirect transparently
  if (page === 'compare') {
    if (typeof _scannerTab !== 'undefined') _scannerTab = 'compare';
    page = 'scanner';
  }

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
  if (state.page === 'recommendations' && page !== 'recommendations') {
    if (typeof _stopRecPoller === 'function') _stopRecPoller();
  }
  state.page = page;
  state._renderGen = (state._renderGen || 0) + 1; // invalidate any in-flight async renders
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => { if(el.getAttribute('onclick')?.includes("'"+page+"'")) el.classList.add('active'); });
  const titles = {dashboard:'Dashboard',portfolio:'Portfolio',macro:'Morning Macro',recommendations:'Trade Recommendations','day-trading':'Day Trading',signals:'Live Signals (yfinance)',journal:'Trade Journal',performance:'Performance Analytics',history:'Portfolio Value History',cgt:'CGT Parcel Tracker',backtest:'Backtesting',assistant:'AI Assistant',news:'News Scanner',announcements:'ASX Announcements',risk:'Portfolio Risk',scanner:'Market Scanner',watchlist:'Watchlist',learning:'Learning Loop',settings:'Settings',compare:'Market Scanner'};
  document.getElementById('page-title').textContent = titles[page] || page;
  renderPage();
}
function renderPage() {
  // System banner renders FIRST so it lands above the page header in the DOM
  // (both insertBefore() themselves immediately ahead of #main-content, so
  // insertion order determines final order — system status outranks the page
  // title). Same isolation reasoning as the header below: its own try/catch,
  // outside the page-body one, so a crash in a page's renderX() can never
  // blank it — if anything it matters MORE during a page crash.
  try {
    _renderSystemCriticalBanner();
  } catch (err) {
    console.error('[renderPage] system banner render crashed:', err);
  }
  // Header render is intentionally OUTSIDE the page-body try/catch below, in its
  // own try/catch, so a crash in a page's renderX() can never blank the title.
  try {
    _renderPageHeader(state.page);
  } catch (err) {
    console.error('[renderPage] header render crashed:', err);
  }
  try {
    _renderBookLensRibbon();
  } catch (err) {
    console.error('[renderPage] book lens ribbon render crashed:', err);
  }
  try {
    _renderPageUnsafe();
  } catch (err) {
    console.error('[renderPage] crashed:', err);
    if (typeof pushNotification === 'function') {
      pushNotification('error', 'Page crashed: ' + (state && state.page || 'unknown'),
        String(err && err.message || err).slice(0, 200), 'error');
    }
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

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
// g + letter → navigate; ? → toggle help
(function () {
  const PAGE_KEYS = {
    d: 'dashboard', p: 'portfolio', m: 'macro',   r: 'recommendations',
    j: 'journal',   f: 'performance', c: 'cgt',   k: 'risk',
    s: 'scanner',   l: 'learning',  n: 'news',    a: 'assistant',
    t: 'day-trading', w: 'watchlist', x: 'compare',
  };
  let _gPressed = false, _gTimer = null;

  document.addEventListener('keydown', e => {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();

    if (_gPressed) {
      clearTimeout(_gTimer);
      _gPressed = false;
      if (PAGE_KEYS[key]) { e.preventDefault(); showPage(PAGE_KEYS[key]); return; }
    }
    if (key === 'g') {
      _gPressed = true;
      _gTimer = setTimeout(() => { _gPressed = false; }, 1000);
      return;
    }
    if (e.key === '?') _showShortcutsHelp();
  });

  window._showShortcutsHelp = function () {
    const existing = document.getElementById('shortcuts-modal');
    if (existing) { existing.remove(); return; }
    const d = document.createElement('dialog');
    d.id = 'shortcuts-modal';
    d.style.cssText = 'border-radius:8px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);padding:0;max-width:420px;width:95%';
    const kbd = s => `<kbd style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:3px;padding:1px 5px;font-size:11px">${s}</kbd>`;
    d.innerHTML = `
      <div style="padding:18px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
          <strong style="font-size:14px">Keyboard Shortcuts</strong>
          <button class="btn btn-sm" onclick="document.getElementById('shortcuts-modal').close()">✕</button>
        </div>
        <div class="text-xs text-muted" style="margin-bottom:10px">Press ${kbd('g')} then a letter to navigate:</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;font-size:12px">
          ${Object.entries(PAGE_KEYS).map(([k, pg]) =>
            `<div style="padding:3px 6px;display:flex;gap:8px;align-items:center">${kbd('g')} ${kbd(k)}<span class="text-muted">${pg.replace('-',' ')}</span></div>`
          ).join('')}
        </div>
        <div style="margin-top:12px;font-size:12px;color:var(--text-muted)">${kbd('?')} toggle this help</div>
      </div>`;
    d.addEventListener('click', e => { if (e.target === d) d.close(); });
    d.addEventListener('close', () => d.remove());
    document.body.appendChild(d);
    d.showModal();
  };
}());

function _renderPageUnsafe() {
  const el = document.getElementById('main-content');
  const gen = (state._renderGen = (state._renderGen || 0)); // snapshot current gen
  switch(state.page) {
    case 'dashboard':
      el.innerHTML = renderDashboard();
      // Auto-fetch earnings if Upcoming Catalysts card has no data yet
      if (state.serverOk && mergedPortfolio().length > 0) {
        const _hasEarnings = state.earningsCalendar && Object.keys(state.earningsCalendar).length > 0;
        if (!_hasEarnings) fetchEarningsCalendar();
      }
      break;
    case 'portfolio':
      el.innerHTML = renderPortfolio();
      if (state._splitWarnings === undefined) checkPortfolioSplits();
      if (state._capitalReturnWarnings === undefined) checkCapitalReturns();
      break;
    case 'macro':           renderMacroPage(gen); break;
    case 'recommendations':
      el.innerHTML = renderRecommendations();
      if (typeof initRecStalenessChecks === 'function') initRecStalenessChecks().catch(() => {});
      if (typeof _startRecPoller === 'function') _startRecPoller();
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
    case 'compare':         if (typeof _scannerTab !== 'undefined') _scannerTab = 'compare'; renderScannerPage(gen); break;
    case 'learning':        renderLearningPage(gen); break;
    case 'settings':        el.innerHTML = renderSettings(); setTimeout(() => { if(state._renderGen !== gen) return; renderSchedulerLog(); loadAICallLog(); loadSettingsAppInfo(); loadProxyKeyStatus(); }, 0); break;
  }
}
