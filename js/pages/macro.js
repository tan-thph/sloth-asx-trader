// ============================================================
// MACRO
// ============================================================

let _macroRefreshing = false;

// ── Polymarket helpers ──────────────────────────────────────
function _pmFmt(vol) {
  if (vol == null) return '—';
  if (vol >= 1e6) return '$' + (vol / 1e6).toFixed(1) + 'M';
  if (vol >= 1e3) return '$' + (vol / 1e3).toFixed(0) + 'K';
  return '$' + vol.toFixed(0);
}

function _pmProbColor(prob, positiveForAsx) {
  // Green when the outcome is good for ASX; red when bad; neutral otherwise
  if (prob == null) return 'var(--text-secondary)';
  if (positiveForAsx === true)  return prob >= 0.5 ? '#16a34a' : '#dc2626';
  if (positiveForAsx === false) return prob >= 0.5 ? '#dc2626' : '#16a34a';
  return prob >= 0.7 ? '#d97706' : prob >= 0.4 ? 'var(--text-secondary)' : '#d97706';
}

function renderPolymarketSection() {
  const pm = state.polymarketData;
  const hasPm = pm && Array.isArray(pm.markets) && pm.markets.length;
  const fetchedAgo = pm?.fetched_at
    ? Math.round((Date.now() - new Date(pm.fetched_at).getTime()) / 60000)
    : null;

  return `
  <div class="card mb-2">
    <div class="flex-between" style="margin-bottom:10px">
      <div>
        <span class="card-title" style="margin:0">Prediction Markets</span>
        <span class="text-xs text-muted" style="margin-left:8px">via Manifold Markets</span>
        ${fetchedAgo != null ? `<span class="text-xs text-muted" style="margin-left:6px">(${fetchedAgo < 2 ? 'just now' : fetchedAgo + ' min ago'}${pm.cached ? ' · cached' : ''})</span>` : ''}
      </div>
      <div class="flex-row" style="gap:10px;align-items:center">
        <label style="font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:5px;cursor:pointer" title="When checked, prediction market probabilities are included in the next AI Macro Brief prompt">
          <input type="checkbox" id="pm-include" onchange="state.includePolymarket=this.checked;renderPage()" ${state.includePolymarket ? 'checked' : ''}>
          Include in AI Brief
        </label>
        <button class="btn btn-sm" onclick="fetchPolymarket()" ${window._pmFetching ? 'disabled style="opacity:0.6"' : ''}>${window._pmFetching ? '⟳ fetching…' : '⟳ Predictions'}</button>
      </div>
    </div>

    ${state.includePolymarket ? `
      <div style="background:var(--bg-tertiary,#1e293b);border:1px solid #d97706;border-radius:var(--radius-sm);padding:6px 10px;margin-bottom:10px;font-size:11px;color:#d97706">
        ⚡ Prediction market data <strong>will be appended</strong> to the next AI Macro Brief prompt
      </div>` : ''}

    ${window._pmFetching ? `
      <div style="display:flex;align-items:center;gap:10px;padding:1rem;color:var(--text-muted);font-size:13px">
        <span style="animation:spin 1s linear infinite;display:inline-block">⟳</span> Fetching prediction markets…
      </div>` : !hasPm ? `
      <div class="empty-state" style="padding:1.5rem">
        <div class="empty-icon" style="font-size:20px">📊</div>
        <p>No prediction market data loaded.</p>
        <p class="sub">Click ⟳ Predictions to fetch live probabilities from Manifold Markets.</p>
      </div>
    ` : `
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Theme</th>
            <th>Question</th>
            <th style="text-align:center">Yes Prob</th>
            <th style="text-align:right">Volume</th>
            <th style="text-align:right">Ends</th>
          </tr></thead>
          <tbody>
            ${pm.markets.map(m => {
              if (m.error && !m.question) {
                return `<tr>
                  <td><strong>${m.label}</strong></td>
                  <td colspan="4" class="text-xs text-muted">⚠ ${m.error}</td>
                </tr>`;
              }
              if (!m.question) {
                return `<tr>
                  <td><strong>${m.label}</strong></td>
                  <td colspan="4" class="text-xs text-muted">No active market found</td>
                </tr>`;
              }
              const prob = m.yes_prob;
              const pct  = prob != null ? Math.round(prob * 100) : null;
              const col  = _pmProbColor(prob, m.positive_for_asx);
              const barW = pct != null ? pct : 0;
              const endShort = m.end_date ? m.end_date.slice(5).replace('-', '/') : '—';
              return `<tr>
                <td style="white-space:nowrap"><strong>${m.label}</strong></td>
                <td class="text-xs" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${m.question}">${m.question}</td>
                <td style="text-align:center;min-width:100px">
                  ${pct != null ? `
                    <div style="display:flex;align-items:center;gap:6px;justify-content:center">
                      <div style="width:60px;height:6px;background:var(--border-light);border-radius:3px;overflow:hidden">
                        <div style="width:${barW}%;height:100%;background:${col};border-radius:3px;transition:width 0.3s"></div>
                      </div>
                      <span style="font-weight:700;color:${col};font-size:13px">${pct}%</span>
                    </div>` : '<span class="text-xs text-muted">—</span>'}
                </td>
                <td class="text-xs text-muted" style="text-align:right">${_pmFmt(m.volume)}</td>
                <td class="text-xs text-muted" style="text-align:right">${endShort}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p class="text-xs text-muted mt-1">
        Manifold Markets is a crowd-sourced prediction market. Probabilities reflect crowd sentiment and play-money bets, not financial advice.
        ${pm.cached ? '· Serving cached data.' : ''}
      </p>
    `}
  </div>`;
}

async function fetchPolymarket() {
  if (!state.serverOk) { toast('Backend server not running', 'error'); return; }
  if (window._pmFetching) return;
  window._pmFetching = true;
  renderPage();
  try {
    const r = await fetch(`${API}/api/polymarket`);
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    const data = await r.json();
    state.polymarketData = data;
    const ok = data.markets?.filter(m => m.question).length ?? 0;
    toast(`Polymarket: ${ok} markets loaded`, 'success');
  } catch (e) {
    toast('Polymarket error: ' + e.message, 'error');
  } finally {
    window._pmFetching = false;
    renderPage();
  }
}

function renderMacro() {
  const m=state.macroData;
  const macroRanToday = state.macroDate === todayStr() && m?.analysis;
  const ec = state.earningsCalendar || {};
  const hasEarnings = Object.keys(ec).some(t => ec[t] && !ec[t].error && ec[t].nextEarningsDate);

  // Sort tickers by upcoming earnings date
  const earningsTickers = Object.entries(ec)
    .filter(([, v]) => v && !v.error && v.nextEarningsDate)
    .sort((a, b) => a[1].nextEarningsDate.localeCompare(b[1].nextEarningsDate));

  const todayISO = new Date().toISOString().slice(0,10);

  return `
    <div class="flex-between section-gap">
      <div>
        <p class="text-muted text-sm">Morning macro brief &mdash; ${todayStr()}
          ${_macroRefreshing ? ' <span class="text-xs" style="color:var(--text-secondary)">⟳ Refreshing…</span>' : ''}
        </p>
        ${macroRanToday ? `<span style="font-size:11px;color:#16a34a;font-weight:600">✓ Updated today</span>` : `<span style="font-size:11px;color:var(--text-tertiary)">Not yet run today</span>`}
      </div>
      <div class="flex-row">
        <button class="btn" onclick="fetchRealMacro()" ${window._macroFetching ? 'disabled style="opacity:0.6"' : ''}>
          ${window._macroFetching ? '⟳ fetching…' : '⟳ Live Macro Data'}
        </button>
        <button class="btn btn-sm" onclick="fetchEarningsCalendar()" title="Refresh earnings dates">⟳ Earnings</button>
        ${macroRanToday
          ? `<button class="btn" onclick="runMacroAnalysis(true)" title="Already ran today — click to force refresh">↺ Refresh Brief</button>`
          : `<button class="btn btn-primary" onclick="runMacroAnalysis()">◎ AI Macro Brief</button>`
        }
      </div>
    </div>

    ${window._macroFetching ? `
    <div class="card" style="margin-bottom:12px;padding:12px 1.25rem;display:flex;align-items:center;gap:10px;color:var(--text-muted);font-size:13px">
      <span style="animation:spin 1s linear infinite;display:inline-block">⟳</span> Fetching live macro data…
    </div>` : ''}

    <!-- RBA Rate Banner -->
    <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:16px;flex-wrap:wrap">
      <div>
        <span class="text-xs text-muted">RBA Cash Rate Target</span>
        <span style="font-size:18px;font-weight:700;margin-left:8px">${state.rbaRate.toFixed(2)}%</span>
        <span class="text-xs text-muted" style="margin-left:6px">${state.rbaRateSource === 'live-rba' ? '✓ live' : state.rbaRateSource === 'cached' ? '(cached)' : '(fallback)'}</span>
        <button class="btn btn-sm" style="margin-left:8px" onclick="fetchRbaRate().then(renderPage)">⟳</button>
      </div>
      ${(()=>{
        const annualIncome = mergedPortfolio().reduce((sum, h) => {
          const d = state.dividendData[h.ticker];
          return sum + (d && d.annualDivPerShare != null ? h.shares * d.annualDivPerShare : 0);
        }, 0);
        const pv = portfolioValue();
        const fwdYield = pv > 0 ? (annualIncome / pv) * 100 : 0;
        const spread = fwdYield - state.rbaRate;
        if (!annualIncome) return '';
        return `<div style="border-left:1px solid var(--border-light);padding-left:16px">
          <span class="text-xs text-muted" title="Annual dividend income ÷ current market value. Lower than 'yield on cost' (Performance tab) when the portfolio has risen since purchase — same income, larger denominator.">Portfolio Forward Yield <span style="font-size:9px">(on market value)</span></span>
          <span style="font-size:18px;font-weight:700;margin-left:8px;color:${fwdYield > state.rbaRate ? '#16a34a' : '#dc2626'}">${fmt(fwdYield)}%</span>
          <span class="text-xs" style="margin-left:6px;color:${spread >= 0 ? '#16a34a' : '#dc2626'}">${spread >= 0 ? '+' : ''}${fmt(spread)}% vs RBA</span>
        </div>`;
      })()}
    </div>

    ${m ? `
    <div class="grid-3 mb-2">
      <div class="card">
        <div class="card-title">US Markets (Overnight)</div>
        ${[['S&P 500','sp500'],['Nasdaq','nasdaq'],['Dow Jones','dow']].map(([n,k])=>{
          const v=m[k]; const pct=v?.change_pct;
          return `<div class="signal-row"><span>${n}</span><div>
            ${v?`<span class="${(pct||0)>=0?'text-success':'text-danger'}">${fmtp(pct)} </span><span class="text-xs text-muted">${fmt(v.value,0)}</span>`:'<span class="text-xs text-muted">—</span>'}
          </div></div>`;
        }).join('')}
      </div>
      <div class="card">
        <div class="card-title">Commodities & FX</div>
        ${[['Gold','gold'],['Oil (WTI)','oil'],['Iron Ore','iron_ore'],['AUD/USD','aud_usd'],['Copper','copper']].map(([n,k])=>{
          const v=m[k]; const pct=v?.change_pct;
          return `<div class="signal-row"><span>${n}</span><div>
            ${v?`<span class="${(pct||0)>=0?'text-success':'text-danger'}">${fmtp(pct)} </span><span class="text-xs text-muted">${fmt(v.value,3)}</span>`:'<span class="text-xs text-muted">—</span>'}
          </div></div>`;
        }).join('')}
      </div>
      <div class="card">
        <div class="card-title">Market Risk</div>
        ${[['ASX 200','asx200'],['VIX (US)','vix'],['US 10Y Yield','us10y']].map(([n,k])=>{
          const v=m[k]; const pct=v?.change_pct;
          const isRisk=(k==='vix');
          return `<div class="signal-row"><span>${n}</span><div>
            ${v?`<span class="${isRisk?((pct||0)>0?'text-danger':'text-success'):((pct||0)>=0?'text-success':'text-danger')}">${fmtp(pct)} </span><span class="text-xs text-muted">${fmt(v.value,2)}</span>`:'<span class="text-xs text-muted">—</span>'}
          </div></div>`;
        }).join('')}
        ${m.asx_vol_20d!=null?`<div class="signal-row"><span title="ASX 200 20-day realized annualized volatility (local fear gauge)">A-VIX (ASX 20d)</span><div>
          <span class="${m.asx_vol_20d>25?'text-danger':m.asx_vol_20d<12?'text-success':'text-muted'}">${m.asx_vol_20d.toFixed(1)}%</span>
          <span class="text-xs text-muted" style="margin-left:4px">${m.asx_vol_20d>25?'elevated':m.asx_vol_20d<12?'low':'normal'}</span>
        </div></div>`:''}
        ${m._source==='ai'?`<div class="signal-row"><span>Sentiment</span><span style="color:${m.sentiment==='risk-on'?'#16a34a':'#dc2626'};font-weight:700">${m.sentiment==='risk-on'?'RISK ON':'RISK OFF'}</span></div>`:''}
      </div>
    </div>
    ${m.analysis?`
    <div class="card mb-2">
      <div class="flex-between" style="margin-bottom:0.875rem">
        <div class="card-title" style="margin-bottom:0">AI Macro Analysis</div>
        ${state.macroDate ? (state.macroDate === todayStr()
          ? `<span class="badge" style="background:var(--up-bg,#dcfce7);color:var(--up,#16a34a);border:none">Today · ${state.macroDate}</span>`
          : `<span class="badge" style="background:var(--warn-bg,#fef3c7);color:var(--warn,#d97706);border:none" title="Shown until the next run replaces it — run AI Macro Brief for today's update">From ${state.macroDate}</span>`) : ''}
      </div>
      <p class="text-sm" style="line-height:1.75;white-space:pre-wrap">${m.analysis}</p>
      ${m.keyDrivers?`<div class="mt-2"><div class="card-title">Key Drivers</div><p class="text-sm" style="line-height:1.75">${m.keyDrivers}</p></div>`:''}
    </div>`:''}

    ${m.what_changed?.length ? `
    <div class="card mb-2">
      <div class="card-title" style="margin-bottom:10px">What Changed (24h)</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px">
        ${m.what_changed.map(w => {
          const sig = (w.signal||'').toLowerCase();
          const borderCol = sig.includes('bullish')||sig.includes('positive')||sig.includes('up') ? 'var(--up,#16a34a)'
            : sig.includes('bearish')||sig.includes('negative')||sig.includes('down') ? 'var(--down,#dc2626)'
            : 'var(--border-medium)';
          const chipBg = sig.includes('bullish')||sig.includes('positive')||sig.includes('up') ? 'var(--up-bg,#dcfce7)'
            : sig.includes('bearish')||sig.includes('negative')||sig.includes('down') ? 'var(--down-bg,#fee2e2)'
            : 'var(--bg-inset,#f3f4f6)';
          const chipCol = sig.includes('bullish')||sig.includes('positive')||sig.includes('up') ? 'var(--up,#15803d)'
            : sig.includes('bearish')||sig.includes('negative')||sig.includes('down') ? 'var(--down,#b91c1c)'
            : 'var(--text-secondary)';
          return `<div style="background:var(--bg-surface);border-radius:var(--radius-md);padding:10px 12px;border-left:3px solid ${borderCol}">
            <div style="font-weight:700;font-size:12px;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px">${escapeHTML(w.factor||'')}</div>
            <div style="font-size:13px;color:var(--text-primary);line-height:1.5">${escapeHTML(w.observed||'')}</div>
            ${w.signal ? `<div style="margin-top:6px"><span style="display:inline-block;font-size:11px;font-weight:600;padding:2px 8px;border-radius:3px;background:${chipBg};color:${chipCol}">${escapeHTML(w.signal)}</span></div>` : ''}
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}

    ${m.drivers?.length ? `
    <div class="card mb-2">
      <div class="card-title">Key Drivers (Ranked)</div>
      <div class="table-wrap">
        <table class="tbl-stack">
          <thead><tr><th>Factor</th><th>Signal</th><th>Imp</th><th>Conf</th><th>Observed</th></tr></thead>
          <tbody>
          ${m.drivers.map(dr => {
            const dirColor = dr.direction==='bullish_asx' ? 'var(--up,#16a34a)' : dr.direction==='bearish_asx' ? 'var(--down,#dc2626)' : 'var(--text-secondary)';
            const dirLabel = dr.direction==='bullish_asx' ? '▲ Bullish' : dr.direction==='bearish_asx' ? '▼ Bearish' : '→ Neutral';
            const confColor = dr.confidence==='high' ? 'var(--up,#16a34a)' : dr.confidence==='medium' ? 'var(--warn,#d97706)' : 'var(--text-tertiary)';
            return `<tr>
              <td data-label="Factor"><strong>${escapeHTML(dr.factor||'')}</strong></td>
              <td data-label="Signal"><span style="color:${dirColor};font-weight:700">${dirLabel}</span></td>
              <td data-label="Importance">${dr.importance!=null?dr.importance+'/10':'—'}</td>
              <td data-label="Confidence"><span style="color:${confColor};font-size:11px">${escapeHTML(dr.confidence||'')}</span></td>
              <td data-label="Observed" class="text-xs text-muted">${escapeHTML(dr.observed||'')}</td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    ${m.sector_impact ? `
    <div class="card mb-2">
      <div class="card-title">ASX Sector Impact</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px">
        ${Object.entries(m.sector_impact).map(([sector, score]) => {
          const s = Number(score) || 0;
          const pct = Math.min(100, Math.abs(s) * 10);
          const col = s > 2 ? 'var(--up,#16a34a)' : s < -2 ? 'var(--down,#dc2626)' : s !== 0 ? 'var(--warn,#d97706)' : 'var(--text-muted)';
          return `<div style="background:var(--bg-surface);border-radius:6px;padding:8px 10px">
            <div style="font-size:11px;color:var(--text-tertiary);text-transform:capitalize;margin-bottom:4px">${escapeHTML(sector)}</div>
            <div style="display:flex;align-items:center;gap:6px">
              <div style="flex:1;height:4px;background:var(--bg-inset);border-radius:2px">
                <div style="width:${pct}%;height:100%;background:${col};border-radius:2px"></div>
              </div>
              <span style="font-weight:700;color:${col};font-size:13px">${s>0?'+':''}${s}</span>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>` : ''}
    ` : ''}

    ${renderPolymarketSection()}

    ${!m ? `
    <div class="card mb-2"><div class="empty-state">
      <div class="empty-icon">◎</div>
      <p>No macro data loaded.</p>
      <p class="sub">Click "Live Macro Data" for real yfinance market data, or "AI Macro Brief" for AI analysis.</p>
    </div></div>
    ` : ''}

    <!-- Earnings Calendar -->
    <div class="card">
      <div class="flex-between" style="margin-bottom:10px">
        <div class="card-title" style="margin:0">Earnings Calendar — Portfolio Holdings</div>
        <button class="btn btn-sm" onclick="fetchEarningsCalendar()">⟳ Refresh</button>
      </div>
      ${!hasEarnings ? `
        <div class="empty-state" style="padding:1.5rem">
          <div class="empty-icon" style="font-size:24px">📅</div>
          <p>Click ⟳ Refresh to load upcoming earnings dates.</p>
        </div>
      ` : `
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Ticker</th>
              <th>Next Earnings</th>
              <th>Days Away</th>
              <th>Fwd EPS</th>
              <th>EPS Growth</th>
              <th>Revenue Growth</th>
              <th>Analyst Rec</th>
              <th>Target</th>
            </tr></thead>
            <tbody>
              ${earningsTickers.map(([t, v]) => {
                const daysAway = Math.round((new Date(v.nextEarningsDate) - new Date(todayISO)) / 86400000);
                const isSoon = daysAway >= 0 && daysAway <= 14;
                const isPast = daysAway < 0;
                const dateCell = isSoon
                  ? `<span style="color:#d97706;font-weight:600">${v.nextEarningsDate} ⚡</span>`
                  : isPast
                  ? `<span class="text-muted">${v.nextEarningsDate}</span>`
                  : `<span>${v.nextEarningsDate}</span>`;
                const daysCell = isPast ? '<span class="text-muted">Past</span>'
                  : isSoon ? `<span style="color:#d97706;font-weight:600">${daysAway}d</span>`
                  : `<span>${daysAway}d</span>`;
                const epsGrowthColor = v.epsGrowth > 0 ? 'text-success' : v.epsGrowth < 0 ? 'text-danger' : '';
                const revGrowthColor = v.revenueGrowth > 0 ? 'text-success' : v.revenueGrowth < 0 ? 'text-danger' : '';
                const currentPrice = getPortfolioHolding(t)?.currentPrice;
                const upside = v.analystTarget && currentPrice ? ((v.analystTarget/currentPrice - 1)*100) : null;
                return `<tr>
                  <td><strong>${t}</strong></td>
                  <td>${dateCell}</td>
                  <td>${daysCell}</td>
                  <td class="text-xs">${v.forwardEps != null ? '$'+fmt(v.forwardEps) : '—'}</td>
                  <td class="text-xs ${epsGrowthColor}">${v.epsGrowth != null ? fmtp(v.epsGrowth*100) : '—'}</td>
                  <td class="text-xs ${revGrowthColor}">${v.revenueGrowth != null ? fmtp(v.revenueGrowth*100) : '—'}</td>
                  <td class="text-xs" style="text-transform:capitalize">${v.analystRec || '—'}</td>
                  <td class="text-xs">
                    ${v.analystTarget != null ? `$${fmt(v.analystTarget)}` : '—'}
                    ${upside != null ? `<span class="text-xs ${upside >= 0 ? 'text-success' : 'text-danger'}" style="display:block">${upside >= 0 ? '+' : ''}${fmt(upside, 0)}% upside</span>` : ''}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <p class="text-xs text-muted mt-1">⚡ = earnings within 14 days. Data from yfinance — verify against ASX announcements.</p>
      `}
    </div>
  `;
}

async function fetchRealMacro() {
  if(!state.serverOk) { toast('Backend server not running','error'); return; }
  if(window._macroFetching) return;
  window._macroFetching = true;
  renderPage();
  try {
    const r = await fetch(`${API}/api/macro`);
    if(!r.ok) throw new Error('Server error');
    const data = await r.json();
    mergeLiveMacro(data);   // preserves the day's AI brief fields
    state.macroLastFetch = Date.now();
    toast('Live macro data loaded','success');
  } catch(e) {
    toast('Macro fetch error: '+e.message,'error');
  } finally {
    window._macroFetching = false;
    renderPage();
  }
}

// Ensures the News Scanner has run recently before the macro brief is built,
// so MACRO/GEOPOLITICS news is available to inject into the prompt. Triggers
// a scan only when one isn't already running and the last scan is stale
// (>30 min) — repeated manual "Run Macro" clicks in the same session won't
// re-trigger a scan every time. Fails silently (no news_engine, server down,
// etc.) since news context is an enhancement, not a hard dependency.
async function _ensureFreshNewsScan(maxWaitMs = 90000) {
  if (!state.serverOk) return;
  try {
    let status = await fetch(`${API}/api/news/status`).then(r => r.json());
    if (!status.available) return;
    const lastScanMs = status.last_scan ? new Date(status.last_scan).getTime() : 0;
    const isStale = (Date.now() - lastScanMs) > 30 * 60 * 1000;
    if (!status.running && isStale) {
      toast('Scanning news before macro brief…', 'info');
      await fetch(`${API}/api/news/scan`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    }
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      status = await fetch(`${API}/api/news/status`).then(r => r.json()).catch(() => ({ running: false }));
      if (!status.running) return;
      await new Promise(res => setTimeout(res, 2000));
    }
  } catch (_) { /* news context is best-effort */ }
}

async function runMacroAnalysis(force=false) {
  const key=getApiKey();
  // Proxy mode has no browser-side key — callClaude() routes via the backend
  if(!key && !state.settings?.useBackendProxy){toast('Add API key in Settings','error');showPage('settings');return;}

  // Once-per-day guard — skip if already ran today (unless forced)
  const today = todayStr();
  if(!force && state.macroDate === today && state.macroData?.analysis) {
    toast('Macro brief already ran today — showing cached data','info');
    renderPage();
    return;
  }

  // Run/await the News Scanner first so RECENT NEWS below has fresh data
  await _ensureFreshNewsScan();

  // First fetch live data if available
  let liveCtx='';
  if(state.serverOk) {
    try {
      const r=await fetch(`${API}/api/macro`);
      if(r.ok) {
        const d=await r.json();
        mergeLiveMacro(d);   // preserves the AI brief if the Claude call below fails
        const fmtPC = (o, dp=2) => {
          if (!o) return null;
          const curr = fmt(o.value, dp);
          const chg = fmtp(o.change_pct);
          return o.prev_close != null ? `${fmt(o.prev_close, dp)} → ${curr} (${chg})` : `${curr} (${chg})`;
        };
        const lines=[];
        if(d.sp500)    lines.push(`S&P500: ${fmtPC(d.sp500, 0)}`);
        if(d.nasdaq)   lines.push(`Nasdaq: ${fmtPC(d.nasdaq, 0)}`);
        if(d.dow)      lines.push(`Dow: ${fmtPC(d.dow, 0)}`);
        if(d.vix)      lines.push(`VIX: ${fmtPC(d.vix)}`);
        if(d.us10y)    lines.push(`US 10Y Yield: ${fmtPC(d.us10y)}%`);
        if(d.gold)     lines.push(`Gold: ${fmtPC(d.gold, 0)}`);
        if(d.oil)      lines.push(`Oil WTI: ${fmtPC(d.oil, 1)}`);
        if(d.iron_ore) lines.push(`Iron Ore: ${fmtPC(d.iron_ore, 1)}` + (d.iron_ore_change_5d != null ? ` (5d: ${fmtp(d.iron_ore_change_5d)})` : ''));
        if(d.copper)   lines.push(`Copper: ${fmtPC(d.copper, 3)}`);
        if(d.aud_usd)  lines.push(`AUD/USD: ${fmtPC(d.aud_usd, 4)}` + (d.aud_usd_change_5d != null ? ` (5d: ${fmtp(d.aud_usd_change_5d)})` : ''));
        if(d.asx200)   lines.push(`ASX200: ${fmtPC(d.asx200, 0)}`
          + (d.asx200_5d_return != null ? ` (5d: ${fmtp(d.asx200_5d_return)}` : '')
          + (d.asx200_20d_return != null ? `, 20d: ${fmtp(d.asx200_20d_return)})` : (d.asx200_5d_return != null ? ')' : '')));
        if(d.asx_vol_20d != null) lines.push(`ASX 20d Realised Vol: ${d.asx_vol_20d.toFixed(1)}%`);
        if(d.spi200_futures_chg != null) lines.push(`SPI200 Futures vs ASX200 spot: ${fmtp(d.spi200_futures_chg)}`);
        if(d.advance_decline_ratio != null) lines.push(`ASX Breadth (% above 20d SMA): ${d.advance_decline_ratio.toFixed(1)}%`);
        if(d.sectors) {
          const sLines = Object.values(d.sectors).filter(Boolean)
            .map(s => `${s.label} ${fmtp(s.change_1d)}${s.return_5d != null ? ` (5d ${fmtp(s.return_5d)})` : ''}`);
          if(sLines.length) lines.push('Sector ETFs: ' + sLines.join(', '));
        }
        liveCtx = lines.join(' | ');
      }
    } catch {}
  }

  // Optionally append Polymarket prediction market probabilities
  let pmCtx = '';
  if (state.includePolymarket && state.polymarketData?.markets?.length) {
    const pmLines = state.polymarketData.markets
      .filter(m => m.question && m.yes_prob != null)
      .map(m => `${m.label}: ${Math.round(m.yes_prob * 100)}% (${m.question.slice(0, 60)})`);
    if (pmLines.length) {
      pmCtx = ' | Prediction market probabilities (Manifold Markets): ' + pmLines.join('; ');
    }
  }

  // High-relevance macro/geopolitics news from the News Scanner (just refreshed
  // above) — capped at 12 items (raised from 8: this call runs a handful of
  // times/day, not per-rec like portfolio analysis, so the token-budget
  // pressure that justifies tighter caps elsewhere is weaker here). days=2
  // (was 1) so slower-developing geopolitical stories (sanctions, trade
  // negotiations) aren't missed by a strict 24h window. Category-only filter,
  // still no impact_score fallback — the impact rubric's portfolio-specificity
  // bonus inflates scores for stock-specific stories (e.g. "CBA still the
  // premium pick") that have real portfolio relevance but zero macro
  // relevance; letting those through wasted tokens with nothing for Claude to
  // cite (2026-06-25 call #10 review — none of 4 impact-only items were used
  // in the brief). A score-based fallback was deliberately tried and removed
  // for this exact reason — don't re-add one without re-litigating that.
  let newsCtx = '';
  if (state.serverOk) {
    try {
      const nr = await fetch(`${API}/api/news/brief?days=2&limit=20`);
      if (nr.ok) {
        const nd = await nr.json();
        const items = (nd.items || [])
          .filter(it => ['macro', 'geopolitics'].includes(it.category))
          .slice(0, 12);
        if (items.length) {
          newsCtx = ' | Recent news (last 48h): ' + items.map(it => it.signal || it.title).join('; ');
        }
      }
    } catch (_) {}
  }

  const userMsg = `Provide current macro analysis for ASX morning brief. Today: ${todayStr()}`
    + (liveCtx ? '. Live market data: ' + liveCtx : '. Use realistic current estimates.')
    + (pmCtx || '')
    + (newsCtx || '')
    + '  Return only JSON.';

  try {
    const { text } = await callClaude('macro', userMsg, { noCache: true });
    const { ok: macroOk, data: ai } = parseClaudeJSON(text);
    let macroAI = ai;
    let recovered = false;
    if (!macroOk) {
      // 2026-06-24: a run hit the macro max_tokens cap mid-string in the
      // trailing keyDrivers field, leaving unparseable JSON even though every
      // structurally important field (sentiment/regime/what_changed/drivers/
      // sector_impact) had already completed before the cutoff. Don't throw
      // the whole brief away for a truncated prose tail — recover what's there.
      console.warn('[macro] parseClaudeJSON failed, attempting truncation recovery:', text?.slice(0, 200));
      macroAI = _recoverTruncatedMacroJSON(text);
      recovered = !!macroAI;
      if (!macroAI) throw new Error('Failed to parse macro response: ' + text?.slice(0, 200));
    }
    state.macroData={...state.macroData, ...macroAI, _source:'ai'};
    state.macroDate = today;
    scheduleSave();
    toast(
      recovered
        ? 'AI macro brief recovered from a truncated response — some detail may be missing'
        : 'AI macro brief ready' + (pmCtx ? ' (with Polymarket)' : ''),
      recovered ? 'warning' : 'success'
    );
    renderPage();
  } catch(e) {
    toast('Macro error: '+e.message,'error');
  }
}

// Best-effort recovery when the macro response hits max_tokens mid-string.
// The schema is ordered cheapest/most-important-first (sentiment/regime →
// what_changed/drivers/sector_impact → verbose analysis/keyDrivers prose), so
// a truncation almost always lands in the trailing prose fields while the
// structured fields are already complete — recover those instead of
// discarding the whole brief. Returns null if nothing usable was recovered
// (caller falls back to a hard error in that case).
function _recoverTruncatedMacroJSON(rawText) {
  const cleaned = (rawText || '').replace(/```json|```/g, '').trim();
  const out = {};
  let m;

  if ((m = cleaned.match(/"sentiment"\s*:\s*"([^"]+)"/)))     out.sentiment = m[1];
  if ((m = cleaned.match(/"sentimentConf"\s*:\s*([\d.]+)/)))  out.sentimentConf = parseFloat(m[1]);
  if ((m = cleaned.match(/"bullish"\s*:\s*([\d.]+)/)))        out.bullish = parseFloat(m[1]);
  if ((m = cleaned.match(/"macro_regime"\s*:\s*"([^"]+)"/)))  out.macro_regime = m[1];

  // Array fields — brace-depth extraction of COMPLETE {...} objects only; an
  // in-progress object straddling the cutoff is dropped, never guessed at.
  const extractArray = (key) => {
    const arrMatch = cleaned.match(new RegExp(`"${key}"\\s*:\\s*\\[`));
    if (!arrMatch) return [];
    const start = cleaned.indexOf('[', arrMatch.index + arrMatch[0].length - 1);
    const body = cleaned.slice(start + 1);
    let depth = 0, objStart = -1;
    const items = [];
    for (let i = 0; i < body.length; i++) {
      const ch = body[i];
      if (ch === '{') { if (depth === 0) objStart = i; depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          try { items.push(JSON.parse(body.slice(objStart, i + 1))); } catch {}
          objStart = -1;
        }
      } else if (ch === ']' && depth === 0) {
        break;
      }
    }
    return items;
  };
  out.what_changed = extractArray('what_changed');
  out.drivers       = extractArray('drivers');

  // sector_impact — flat {string: number, ...} object, single regex pass.
  const secMatch = cleaned.match(/"sector_impact"\s*:\s*\{([^}]*)\}/);
  if (secMatch) {
    out.sector_impact = {};
    const pairRe = /"(\w+)"\s*:\s*(-?\d+)/g;
    let pm;
    while ((pm = pairRe.exec(secMatch[1]))) out.sector_impact[pm[1]] = parseInt(pm[2], 10);
  }

  // Trailing prose fields — may be complete or cut off mid-string. Recover
  // whatever text exists rather than dropping it; mark partials explicitly.
  const proseField = (key) => {
    const closed = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"\\s*[,}]`));
    if (closed) return closed[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
    const partial = cleaned.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*)$`));
    if (partial) return partial[1].replace(/\\n/g, '\n').replace(/\\"/g, '"') + ' … [response truncated]';
    return null;
  };
  out.analysis   = proseField('analysis');
  out.keyDrivers = proseField('keyDrivers');

  const recoveredSomething = out.sentiment || out.macro_regime
    || out.what_changed.length || out.drivers.length;
  return recoveredSomething ? out : null;
}

async function renderMacroPage(gen) {
  const el = document.getElementById('main-content');
  if (state._renderGen !== gen) return;
  el.innerHTML = renderMacro(); // render cached state immediately

  if (!state.serverOk) return;
  const now = Date.now();

  // Auto-refresh live data if it's stale (>5 min) — silent background fetch, no disruptive spinner
  const macroStale = state.macroData &&
    (!state.macroLastFetch || now - state.macroLastFetch > 5 * 60 * 1000);
  // Auto-load earnings calendar if not yet populated for portfolio tickers
  const needsEarnings = mergedPortfolio().length > 0 &&
    (!state.earningsCalendar || !Object.keys(state.earningsCalendar).length);

  if (!_macroRefreshing && macroStale) {
    _macroRefreshing = true;
    if (state._renderGen === gen) el.innerHTML = renderMacro(); // show ⟳ badge
    try {
      const r = await fetch(`${API}/api/macro`);
      if (!r.ok) throw new Error('Server error');
      const data = await r.json();
      mergeLiveMacro(data);   // THE disappearing-brief bug: this silent refresh used to wipe the AI fields
      state.macroLastFetch = Date.now();
    } catch (_) { /* stale data stays visible */ } finally {
      _macroRefreshing = false;
      if (state.page === 'macro' && state._renderGen === gen) renderPage();
    }
  }

  if (needsEarnings) fetchEarningsCalendar();
}
