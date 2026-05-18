// ============================================================
// MACRO
// ============================================================

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
        <span class="text-xs text-muted" style="margin-left:8px">via Polymarket</span>
        ${fetchedAgo != null ? `<span class="text-xs text-muted" style="margin-left:6px">(${fetchedAgo < 2 ? 'just now' : fetchedAgo + ' min ago'}${pm.cached ? ' · cached' : ''})</span>` : ''}
      </div>
      <div class="flex-row" style="gap:10px;align-items:center">
        <label style="font-size:12px;color:var(--text-secondary);display:flex;align-items:center;gap:5px;cursor:pointer" title="When checked, Polymarket probabilities are included in the next AI Macro Brief prompt">
          <input type="checkbox" id="pm-include" onchange="state.includePolymarket=this.checked;renderPage()" ${state.includePolymarket ? 'checked' : ''}>
          Include in AI Brief
        </label>
        <button class="btn btn-sm" onclick="fetchPolymarket()">⟳ Polymarket</button>
      </div>
    </div>

    ${state.includePolymarket ? `
      <div style="background:var(--bg-tertiary,#1e293b);border:1px solid #d97706;border-radius:var(--radius-sm);padding:6px 10px;margin-bottom:10px;font-size:11px;color:#d97706">
        ⚡ Polymarket data <strong>will be appended</strong> to the next AI Macro Brief prompt
      </div>` : ''}

    ${!hasPm ? `
      <div class="empty-state" style="padding:1.5rem">
        <div class="empty-icon" style="font-size:20px">📊</div>
        <p>No Polymarket data loaded.</p>
        <p class="sub">Click ⟳ Polymarket to fetch live prediction market probabilities.</p>
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
        Polymarket is a crowd-sourced prediction market. Probabilities reflect real-money bets, not financial advice.
        ${pm.cached ? '· Serving cached data.' : ''}
      </p>
    `}
  </div>`;
}

async function fetchPolymarket() {
  if (!state.serverOk) { toast('Backend server not running', 'error'); return; }
  toast('Fetching Polymarket data…', 'info');
  try {
    const r = await fetch(`${API}/api/polymarket`);
    if (!r.ok) throw new Error(`Server error ${r.status}`);
    const data = await r.json();
    state.polymarketData = data;
    const ok = data.markets?.filter(m => m.question).length ?? 0;
    toast(`Polymarket: ${ok} markets loaded`, 'success');
    renderPage();
  } catch (e) {
    toast('Polymarket error: ' + e.message, 'error');
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
        <p class="text-muted text-sm">Morning macro brief &mdash; ${todayStr()}</p>
        ${macroRanToday ? `<span style="font-size:11px;color:#16a34a;font-weight:600">✓ Updated today</span>` : `<span style="font-size:11px;color:var(--text-tertiary)">Not yet run today</span>`}
      </div>
      <div class="flex-row">
        <button class="btn" onclick="fetchRealMacro()">⟳ Live Macro Data</button>
        <button class="btn btn-sm" onclick="fetchEarningsCalendar()" title="Refresh earnings dates">⟳ Earnings</button>
        ${macroRanToday
          ? `<button class="btn" onclick="runMacroAnalysis(true)" title="Already ran today — click to force refresh">↺ Refresh Brief</button>`
          : `<button class="btn btn-primary" onclick="runMacroAnalysis()">◎ AI Macro Brief</button>`
        }
      </div>
    </div>

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
          <span class="text-xs text-muted">Portfolio Forward Yield</span>
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
        ${[['ASX 200','asx200'],['VIX','vix'],['US 10Y Yield','us10y']].map(([n,k])=>{
          const v=m[k]; const pct=v?.change_pct;
          const isRisk=(k==='vix');
          return `<div class="signal-row"><span>${n}</span><div>
            ${v?`<span class="${isRisk?((pct||0)>0?'text-danger':'text-success'):((pct||0)>=0?'text-success':'text-danger')}">${fmtp(pct)} </span><span class="text-xs text-muted">${fmt(v.value,2)}</span>`:'<span class="text-xs text-muted">—</span>'}
          </div></div>`;
        }).join('')}
        ${m._source==='ai'?`<div class="signal-row"><span>Sentiment</span><span style="color:${m.sentiment==='risk-on'?'#16a34a':'#dc2626'};font-weight:700">${m.sentiment==='risk-on'?'RISK ON':'RISK OFF'}</span></div>`:''}
      </div>
    </div>
    ${m.analysis?`
    <div class="card mb-2">
      <div class="card-title">AI Macro Analysis</div>
      <p class="text-sm" style="line-height:1.75;white-space:pre-wrap">${m.analysis}</p>
      ${m.keyDrivers?`<div class="mt-2"><div class="card-title">Key Drivers</div><p class="text-sm" style="line-height:1.75">${m.keyDrivers}</p></div>`:''}
    </div>`:''}
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
  toast('Fetching live macro data...','info');
  try {
    const r = await fetch(`${API}/api/macro`);
    if(!r.ok) throw new Error('Server error');
    const data = await r.json();
    state.macroData = {...data, _source:'live'};
    toast('Live macro data loaded','success'); renderPage();
  } catch(e) {
    toast('Macro fetch error: '+e.message,'error');
  }
}

async function runMacroAnalysis(force=false) {
  const key=getApiKey();
  if(!key){toast('Add API key in Settings','error');showPage('settings');return;}

  // Once-per-day guard — skip if already ran today (unless forced)
  const today = todayStr();
  if(!force && state.macroDate === today && state.macroData?.analysis) {
    toast('Macro brief already ran today — showing cached data','info');
    renderPage();
    return;
  }

  // First fetch live data if available
  let liveCtx='';
  if(state.serverOk) {
    try {
      const r=await fetch(`${API}/api/macro`);
      if(r.ok) {
        const d=await r.json();
        state.macroData={...d, _source:'live'};
        const lines=[];
        if(d.sp500) lines.push(`S&P500: ${fmt(d.sp500.value)} (${fmtp(d.sp500.change_pct)})`);
        if(d.asx200) lines.push(`ASX200: ${fmt(d.asx200.value)} (${fmtp(d.asx200.change_pct)})`);
        if(d.gold) lines.push(`Gold: ${fmt(d.gold.value)} (${fmtp(d.gold.change_pct)})`);
        if(d.aud_usd) lines.push(`AUD/USD: ${fmt(d.aud_usd.value,4)} (${fmtp(d.aud_usd.change_pct)})`);
        if(d.vix) lines.push(`VIX: ${fmt(d.vix.value)}`);
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
      pmCtx = ' | Prediction market probabilities (Polymarket): ' + pmLines.join('; ');
    }
  }

  const system=`You are a macro analyst for Australian equity markets. Return ONLY valid JSON, no markdown.
Format: {"sentiment":"risk-on"|"risk-off","sentimentConf":0-1,"bullish":0-100,"analysis":"3 paragraph analysis","keyDrivers":"key market drivers today"}`;

  const userMsg = `Provide current macro analysis for ASX morning brief. Today: ${todayStr()}`
    + (liveCtx ? '. Live market data: ' + liveCtx : '. Use realistic current estimates.')
    + (pmCtx || '')
    + '  Return only JSON.';

  try {
    const r=await fetch('https://api.anthropic.com/v1/messages',{
      method:'POST',
      headers:{
        'Content-Type':'application/json',
        'x-api-key':key,
        'anthropic-version':'2023-06-01',
        'anthropic-dangerous-direct-browser-access':'true'
      },
      body:JSON.stringify({
        model:'claude-sonnet-4-6',
        max_tokens:1000,
        system,
        messages:[{role:'user', content: userMsg}]
      })
    });
    const data=await r.json();
    if(data.error) throw new Error(data.error.message);
    const text=data.content?.[0]?.text||'{}';
    const ai=JSON.parse(text.replace(/```json|```/g,'').trim());
    state.macroData={...state.macroData, ...ai, _source:'ai'};
    state.macroDate = today;
    scheduleSave();
    toast('AI macro brief ready' + (pmCtx ? ' (with Polymarket)' : ''), 'success');
    renderPage();
  } catch(e) {
    toast('Macro error: '+e.message,'error');
  }
}
