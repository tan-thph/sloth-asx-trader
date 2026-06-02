// ============================================================
// LIVE SIGNALS PAGE (yfinance powered)
// ============================================================
let _sigRefreshing = false; // true while a background refresh is in flight

async function renderSignalsPage(gen) {
  const el = document.getElementById('main-content');
  const tickers = state.portfolio.map(h => h.ticker);

  if(!state.serverOk) {
    if(state._renderGen !== gen) return;
    el.innerHTML=`<div class="info-banner">⚠ Backend not running. Start with: <code>python3 asx_server.py</code></div>
      <div class="card"><div class="empty-state">
        <div class="empty-icon">◇</div>
        <p>Real-time signals require the yfinance backend.</p>
        <p class="sub">Run <code>python3 asx_server.py</code> in your terminal, then refresh.</p>
        <button class="btn btn-primary mt-2" onclick="checkServer().then(renderPage)">Check Connection</button>
      </div></div>`;
    return;
  }

  const now = Date.now();
  const hasCachedData = tickers.some(t => state.liveSignals[t] && !state.liveSignals[t].error);
  const needsRefresh  = tickers.some(t => !state.lastSignalFetch[t] || (now - state.lastSignalFetch[t]) > 15*60*1000);

  if (hasCachedData) {
    // Render immediately with what we have; kick a background refresh if data is stale
    if(state._renderGen !== gen) return;
    if (needsRefresh && !_sigRefreshing) {
      _sigRefreshing = true;
      fetchSignals(tickers, false)
        .then(() => {
          _sigRefreshing = false;
          if (state.page === 'signals' && state._renderGen === gen) renderPage();
        })
        .catch(() => { _sigRefreshing = false; });
    }
  } else {
    // No cached data — show spinner and wait for first fetch
    if(state._renderGen !== gen) return;
    el.innerHTML=`<div class="card"><div class="empty-state"><div class="loading-dots"><span></span><span></span><span></span></div><p class="text-muted mt-1">Fetching yfinance data for ${tickers.join(', ')}...</p></div></div>`;
    await fetchSignals(tickers, false);
    if(state._renderGen !== gen) return;
  }

  const signals=state.liveSignals;

  const hasData=tickers.some(t=>signals[t]&&!signals[t].error);
  if(!hasData) {
    el.innerHTML=`<div class="card"><div class="empty-state">
      <div class="empty-icon">◇</div>
      <p>Could not load signal data. Check server logs.</p>
      <button class="btn btn-primary mt-2" onclick="fetchSignals(${JSON.stringify(tickers)},true).then(renderPage)">Retry</button>
    </div></div>`;
    return;
  }

  let html=`
    <div class="flex-between section-gap">
      <p class="text-muted text-sm">Real-time technical indicators via yfinance · 6-month lookback
        ${_sigRefreshing ? ' <span class="text-xs" style="color:var(--text-secondary)">⟳ Refreshing…</span>' : ''}
      </p>
      <button class="btn btn-primary btn-sm" onclick="refreshSignals()">⟳ Refresh Signals</button>
    </div>

    <!-- SIGNAL CONDITION RULES -->
    ${_buildSignalRulesCard(tickers, signals)}

    <!-- SUMMARY TABLE -->
    <div class="card section-gap">
      <div class="card-title">Signal Summary</div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>Ticker</th><th>Price</th><th>1D</th><th>5D</th><th>Signal</th><th>Confidence</th><th>RSI(14)</th><th>MACD</th><th>Trend</th><th>ADX</th><th>Vol Ratio</th><th>BB%B</th><th>Detail</th></tr></thead>
          <tbody>
          ${tickers.map(t=>{
            const s=signals[t];
            if(!s||s.error) return `<tr><td><strong>${t}</strong></td><td colspan="12" class="text-xs text-muted">Error: ${s?.error||'No data'}</td></tr>`;
            const rsiColor=s.rsi_14>70?'text-danger':s.rsi_14<30?'text-success':'';
            const macdStr=s.macd_hist!=null?`<span class="${s.macd_hist>0?'text-success':'text-danger'}">${s.macd_hist>0?'▲':'▼'} ${fmt(Math.abs(s.macd_hist),3)}</span>`:'—';
            const confPct=Math.round(s.confidence*100);
            const bbPct=s.bb_pct_b!=null?Math.round(s.bb_pct_b*100):null;
            return `<tr>
              <td><strong>${t}</strong><br><span class="text-xs text-muted">${s.fundamentals?.sector||''}</span></td>
              <td>$${fmt(s.current_price,3)}</td>
              <td class="${(s.return_1d||0)>=0?'text-success':'text-danger'}">${fmtp(s.return_1d,1)}</td>
              <td class="${(s.return_5d||0)>=0?'text-success':'text-danger'}">${fmtp(s.return_5d,1)}</td>
              <td>${actionBadge(s.composite_signal)}</td>
              <td>
                <div class="flex-row" style="gap:5px">
                  <div class="conf-bar"><div class="conf-fill" style="width:${confPct}%;background:${confColor(s.confidence)}"></div></div>
                  <span class="text-xs">${confPct}%</span>
                </div>
              </td>
              <td><span class="${rsiColor}">${fmt(s.rsi_14,1)}</span><span class="text-xs text-muted">${s.rsi_14>70?' OB':s.rsi_14<30?' OS':''}</span></td>
              <td>${macdStr}</td>
              <td><span class="${s.trend_direction==='bullish'?'text-success':s.trend_direction==='bearish'?'text-danger':'text-muted'}">${s.trend_direction==='bullish'?'↑ Bull':s.trend_direction==='bearish'?'↓ Bear':'→ Neutral'}</span></td>
              <td><span class="${(s.adx||0)>25?'text-success':''}">${fmt(s.adx,0)}</span><span class="text-xs text-muted">${(s.adx||0)>25?' Strong':' Weak'}</span></td>
              <td class="${(s.volume_ratio||0)>1.5?'text-warn':''}">${fmt(s.volume_ratio,1)}x</td>
              <td>${bbPct!=null?`<span class="${bbPct>80?'text-danger':bbPct<20?'text-success':''}">${bbPct}%</span>`:'—'}</td>
              <td><button class="btn btn-sm" onclick="showTickerDetail('${t}')">Detail</button></td>
            </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </div>

    <!-- DETAIL CARDS -->
    ${tickers.map(t=>{
      const s=signals[t];
      if(!s||s.error) return '';
      const f=s.fundamentals||{};
      return `
      <div class="card section-gap" id="detail-${t}" style="display:none">
        <div class="flex-between mb-2">
          <div class="flex-row">
            <strong style="font-size:16px">${t}</strong>
            ${actionBadge(s.composite_signal)}
            <span class="text-xs text-muted">${f.short_name||''} · ${s.fetched_at||''}</span>
          </div>
          <button class="btn btn-sm" onclick="document.getElementById('detail-${t}').style.display='none'">✕ Close</button>
        </div>

        <!-- Price chart -->
        <div class="mb-2" style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
            <div style="display:flex;gap:2px;background:var(--bg-primary);border-radius:var(--radius-md);padding:2px">
              <button class="btn btn-sm" style="padding:3px 9px;font-size:11px;${(_sigChartOpts[t]||{}).mode!=='line'?'background:var(--accent);color:#fff;border-color:var(--accent)':''}" onclick="_sigChartSet('${t}','mode','candle')">Candle</button>
              <button class="btn btn-sm" style="padding:3px 9px;font-size:11px;${(_sigChartOpts[t]||{}).mode==='line'?'background:var(--accent);color:#fff;border-color:var(--accent)':''}" onclick="_sigChartSet('${t}','mode','line')">Line</button>
            </div>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" ${(_sigChartOpts[t]||{}).showBB!==false?'checked':''} onchange="_sigChartSet('${t}','showBB',this.checked)"> BB
            </label>
            <label style="display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer">
              <input type="checkbox" ${(_sigChartOpts[t]||{}).showSMA50!==false?'checked':''} onchange="_sigChartSet('${t}','showSMA50',this.checked)"> SMA50
            </label>
            <span class="text-xs text-muted" style="margin-left:auto">Last 90 trading days</span>
          </div>
          <canvas id="chart-${t}" style="width:100%;height:280px"></canvas>
        </div>

        <div class="grid-4" style="margin-bottom:1rem">
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 12px">
            <div class="text-xs text-muted">Entry Range</div>
            <div style="font-weight:600">$${fmt(s.entry_range?.[0],3)} – $${fmt(s.entry_range?.[1],3)}</div>
          </div>
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 12px">
            <div class="text-xs text-muted">Target / Stop</div>
            <div style="font-weight:600"><span class="text-success">$${fmt(s.target,3)}</span> / <span class="text-danger">$${fmt(s.stop_loss,3)}</span></div>
          </div>
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 12px">
            <div class="text-xs text-muted">ATR(14)</div>
            <div style="font-weight:600">$${fmt(s.atr_14,3)} <span class="text-xs">(${fmt(s.atr_pct,1)}%)</span></div>
          </div>
          <div style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:10px 12px">
            <div class="text-xs text-muted">Hist Vol (20d)</div>
            <div style="font-weight:600">${fmt(s.hist_vol_20,1)}% ann.</div>
          </div>
        </div>

        <div class="grid-3">

          <!-- Momentum indicators -->
          <div class="card" style="padding:1rem">
            <div class="card-title">Momentum</div>
            ${[
              ['RSI(14)', `<span class="${s.rsi_14>70?'text-danger':s.rsi_14<30?'text-success':''}">${fmt(s.rsi_14,1)}${s.rsi_14>70?' ⚠ Overbought':s.rsi_14<30?' ⚡ Oversold':''}</span>`],
              ['RSI(9)', fmt(s.rsi_9,1)],
              ['MACD Line', fmt(s.macd_line,3)],
              ['MACD Signal', fmt(s.macd_signal,3)],
              ['MACD Hist', `<span class="${(s.macd_hist||0)>0?'text-success':'text-danger'}">${fmt(s.macd_hist,3)}</span>`],
              ['Stoch %K', `<span class="${(s.stoch_k||50)>80?'text-danger':(s.stoch_k||50)<20?'text-success':''}">${fmt(s.stoch_k,1)}</span>`],
              ['Stoch %D', fmt(s.stoch_d,1)],
              ['Williams %R', fmt(s.williams_r,1)],
              ['CCI(20)', `<span class="${(s.cci||0)>100?'text-danger':(s.cci||0)<-100?'text-success':''}">${fmt(s.cci,1)}</span>`],
              ['MFI(14)', `<span class="${(s.mfi||50)>80?'text-danger':(s.mfi||50)<20?'text-success':''}">${fmt(s.mfi,1)}</span>`],
              ['ROC(10)', fmtp(s.roc_10,2)],
              ['ROC(21)', fmtp(s.roc_21,2)],
            ].map(([l,v])=>`<div class="ind-row"><span class="ind-label">${l}</span><span class="ind-val">${v}</span></div>`).join('')}
          </div>

          <!-- Trend & Volatility -->
          <div class="card" style="padding:1rem">
            <div class="card-title">Trend & Volatility</div>
            ${[
              ['SMA(20)', `$${fmt(s.sma_20,3)}`],
              ['SMA(50)', `$${fmt(s.sma_50,3)}`],
              ['SMA(200)', s.sma_200?`$${fmt(s.sma_200,3)}`:'<span class="text-muted">n/a</span>'],
              ['EMA(12)', `$${fmt(s.ema_12,3)}`],
              ['EMA(26)', `$${fmt(s.ema_26,3)}`],
              ['ADX(14)', `<span class="${(s.adx||0)>25?'text-success':''}">${fmt(s.adx,1)} (${s.trend_strength})</span>`],
              ['+DI', `<span class="text-success">${fmt(s.adx_plus_di,1)}</span>`],
              ['-DI', `<span class="text-danger">${fmt(s.adx_minus_di,1)}</span>`],
              ['BB Upper', `$${fmt(s.bb_upper,3)}`],
              ['BB Mid', `$${fmt(s.bb_mid,3)}`],
              ['BB Lower', `$${fmt(s.bb_lower,3)}`],
              ['BB %B', s.bb_pct_b!=null?`${fmt(s.bb_pct_b*100,0)}%`:'—'],
              ['BB Width', s.bb_bandwidth?`${fmt(s.bb_bandwidth,1)}%`:'—'],
              ['Keltner Up', `$${fmt(s.keltner_upper,3)}`],
              ['Keltner Low', `$${fmt(s.keltner_lower,3)}`],
            ].map(([l,v])=>`<div class="ind-row"><span class="ind-label">${l}</span><span class="ind-val">${v}</span></div>`).join('')}
          </div>

          <!-- Volume & Fundamentals -->
          <div class="card" style="padding:1rem">
            <div class="card-title">Volume & Fundamentals</div>
            ${[
              ['Vol Today', fmt(s.volume_today,0)],
              ['Vol Avg(20)', fmt(s.volume_avg_20,0)],
              ['Vol Ratio', `<span class="${(s.volume_ratio||0)>1.5?'text-warn':''}">${fmt(s.volume_ratio,2)}x</span>`],
              ['OBV Trend', `<span class="${s.obv_trend==='rising'?'text-success':'text-danger'}">${s.obv_trend}</span>`],
              ['VWAP(20d)', `$${fmt(s.vwap_20d,3)}`],
              ['vs VWAP', `<span class="${s.price_vs_vwap==='above'?'text-success':'text-danger'}">${s.price_vs_vwap}</span>`],
              ['P/E', fmt(f.pe_ratio,1)],
              ['Fwd P/E', fmt(f.forward_pe,1)],
              ['P/B', fmt(f.pb_ratio,2)],
              ['Div Yield', f.dividend_yield!=null?`${fmt(f.dividend_yield*100,2)}%`:'—'],
              ['ROE', f.roe!=null?`${fmt(f.roe*100,1)}%`:'—'],
              ['Beta', fmt(f.beta,2)],
              ['52W High', f['52w_high']?`$${fmt(f['52w_high'],3)}`:'—'],
              ['52W Low', f['52w_low']?`$${fmt(f['52w_low'],3)}`:'—'],
              ['From 52W H', f.pct_from_52w_high!=null?`${fmt(f.pct_from_52w_high,1)}%`:'—'],
            ].map(([l,v])=>`<div class="ind-row"><span class="ind-label">${l}</span><span class="ind-val">${v}</span></div>`).join('')}
          </div>
        </div>

        <!-- Support & Resistance -->
        <div class="grid-2 mt-2">
          <div class="card" style="padding:1rem">
            <div class="card-title">Support & Resistance (Pivot)</div>
            ${s.support_resistance ? [
              ['R2', s.support_resistance.r2, 'sr-r'],
              ['R1', s.support_resistance.r1, 'sr-r'],
              ['Pivot', s.support_resistance.pivot, 'sr-p'],
              ['S1', s.support_resistance.s1, 'sr-s'],
              ['S2', s.support_resistance.s2, 'sr-s'],
            ].map(([l,v,cls])=>`<div class="sr-level ${cls}"><span>${l}</span><strong>$${fmt(v,3)}</strong></div>`).join('') : '<div class="text-xs text-muted">—</div>'}
          </div>
          <div class="card" style="padding:1rem">
            <div class="card-title">Returns</div>
            ${[['1 Day',s.return_1d],['5 Day',s.return_5d],['20 Day (1M)',s.return_20d],['60 Day (3M)',s.return_60d],['90 Day',s.return_90d]].map(([l,v])=>`
              <div class="signal-row"><span class="text-sm">${l}</span><span class="${v!=null?(v>=0?'text-success':'text-danger'):'text-muted'}">${v!=null?fmtp(v,2):'—'}</span></div>`).join('')}
          </div>
        </div>

        <!-- Buy / Sell signals -->
        <div class="grid-2 mt-2">
          <div class="card" style="padding:1rem">
            <div class="card-title" style="color:#15803d">▲ Buy Signals (${s.buy_signals?.length||0})</div>
            <div>${(s.buy_signals||[]).map(sig=>`<span class="signal-chip chip-buy">✓ ${sig}</span>`).join('')||'<span class="text-xs text-muted">None</span>'}</div>
          </div>
          <div class="card" style="padding:1rem">
            <div class="card-title" style="color:#b91c1c">▼ Sell Signals (${s.sell_signals?.length||0})</div>
            <div>${(s.sell_signals||[]).map(sig=>`<span class="signal-chip chip-sell">✗ ${sig}</span>`).join('')||'<span class="text-xs text-muted">None</span>'}</div>
          </div>
        </div>

        <!-- Analyst -->
        ${f.analyst_target||f.analyst_recommendation?`
        <div class="card mt-2" style="padding:1rem">
          <div class="card-title">Analyst Consensus</div>
          <div class="flex-row">
            ${f.analyst_recommendation?`<span class="badge badge-neutral" style="text-transform:capitalize">${f.analyst_recommendation}</span>`:''}
            ${f.analyst_target?`<span class="text-sm">Target: <strong>$${fmt(f.analyst_target,3)}</strong></span>`:''}
            ${f.analyst_target&&s.current_price?`<span class="text-xs text-muted">Upside: <span class="${f.analyst_target>s.current_price?'text-success':'text-danger'}">${fmtp((f.analyst_target/s.current_price-1)*100,1)}</span></span>`:''}
          </div>
        </div>`:''}

        <!-- Seasonality -->
        <div class="card mt-2" style="padding:1rem" id="seas-card-${t}">
          <div class="flex-between mb-1">
            <div class="card-title" style="margin:0">Monthly Seasonality <span class="text-xs text-muted" style="font-weight:400">(10yr avg)</span></div>
            <span class="text-xs text-muted" id="seas-meta-${t}">Loading…</span>
          </div>
          <div id="seas-body-${t}" style="min-height:48px;display:flex;align-items:center;justify-content:center">
            <span class="text-xs text-muted">Fetching…</span>
          </div>
        </div>
      </div>`;
    }).join('')}
  `;

  el.innerHTML=html;

  // Draw candle charts for any expanded ticker rows — guard gen
  tickers.forEach(t=>{
    const s=signals[t];
    if(s&&!s.error&&s.chart_data?.length) {
      const detail=document.getElementById(`detail-${t}`);
      if(detail&&detail.style.display!=='none') {
        setTimeout(()=>{ if(state._renderGen===gen) _sigChartDraw(t); }, 50);
      }
    }
  });

  // Load seasonality for expanded tickers
  tickers.forEach(t=>{
    const detail=document.getElementById(`detail-${t}`);
    if(detail&&detail.style.display!=='none') {
      _loadSeasonality(t, gen);
    }
  });
}

// Cached seasonality data per ticker session
if(!window._seasonalityCache) window._seasonalityCache={};

async function _loadSeasonality(ticker, gen) {
  if(window._seasonalityCache[ticker]) {
    _renderSeasonality(ticker, window._seasonalityCache[ticker]);
    return;
  }
  try {
    const r = await fetch(`${API}/api/seasonality/${ticker}`);
    const d = await r.json();
    if(state._renderGen!==gen) return;
    window._seasonalityCache[ticker] = d;
    _renderSeasonality(ticker, d);
  } catch(e) {
    const body=document.getElementById(`seas-body-${ticker}`);
    if(body) body.innerHTML='<span class="text-xs text-muted">Unavailable</span>';
  }
}

function _renderSeasonality(ticker, d) {
  const metaEl=document.getElementById(`seas-meta-${ticker}`);
  const bodyEl=document.getElementById(`seas-body-${ticker}`);
  if(!bodyEl) return;
  if(!d||!d.ok||!d.months) {
    bodyEl.innerHTML='<span class="text-xs text-muted">No seasonality data</span>';
    if(metaEl) metaEl.textContent='';
    return;
  }
  if(metaEl) metaEl.textContent=`${d.years||'?'}yr sample`;

  const months=d.months;
  const maxAbs=Math.max(...months.map(m=>Math.abs(m.avg)),0.1);
  const now=new Date().getMonth(); // 0-based, matches index 0=Jan

  const bars=months.map((m,i)=>{
    const pct=Math.min(Math.abs(m.avg)/maxAbs*100,100);
    const isPos=m.avg>=0;
    const isCurrent=i===now;
    const winRate=m.count>0?Math.round(m.positive/m.count*100):0;
    const col=isPos?'#16a34a':'#dc2626';
    const border=isCurrent?'2px solid var(--accent)':'1px solid transparent';
    return `<div style="display:flex;flex-direction:column;align-items:center;flex:1;min-width:0;cursor:default;border:${border};border-radius:4px;padding:2px 1px"
              title="${m.month}: avg ${m.avg>=0?'+':''}${m.avg}% | win rate ${winRate}% | range ${m.min}% to ${m.max}% (${m.count} years)">
      <div style="font-size:10px;font-weight:600;color:${col};margin-bottom:2px">${m.avg>=0?'+':''}${m.avg}%</div>
      <div style="width:100%;height:40px;display:flex;align-items:${isPos?'flex-end':'flex-start'};justify-content:center">
        <div style="width:70%;background:${col};opacity:0.8;height:${Math.max(pct*0.4,2)}px;border-radius:2px"></div>
      </div>
      <div style="font-size:9px;color:var(--text-secondary);margin-top:2px">${m.month}</div>
      <div style="font-size:9px;color:var(--text-muted)">${winRate}%</div>
    </div>`;
  }).join('');

  bodyEl.innerHTML=`
    <div style="width:100%">
      <div style="display:flex;gap:1px;align-items:stretch;padding:4px 0">${bars}</div>
      <div style="display:flex;justify-content:space-between;margin-top:4px">
        <span class="text-xs text-muted">Bar = avg monthly return · bottom % = historical win rate · highlighted = current month</span>
      </div>
    </div>`;
}

function drawSparklineFromData(ticker, s) {
  const canvas=document.getElementById(`chart-${ticker}`);
  if(!canvas||!s.chart_data?.length) return;
  const ctx=canvas.getContext('2d');
  canvas.width=canvas.offsetWidth||800;
  canvas.height=180;
  const w=canvas.width, h=canvas.height;
  const data=s.chart_data;
  const prices=data.map(d=>d.close);
  const allV=[...prices];
  if(s.bb_upper) allV.push(s.bb_upper);
  if(s.bb_lower) allV.push(s.bb_lower);
  const mn=Math.min(...allV)*0.998, mx=Math.max(...allV)*1.002, rng=mx-mn||1;
  const px=v=>h-((v-mn)/rng)*(h-20)-10;
  const py=i=>(i/(data.length-1))*(w-20)+10;

  ctx.clearRect(0,0,w,h);

  // Grid lines
  ctx.strokeStyle='rgba(128,128,128,0.1)'; ctx.lineWidth=0.5;
  [0.25,0.5,0.75].forEach(f=>{ ctx.beginPath(); ctx.moveTo(0,h*f); ctx.lineTo(w,h*f); ctx.stroke(); });

  // BB bands
  if(s.bb_upper&&s.bb_lower) {
    ctx.beginPath();
    data.forEach((_,i)=>i===0?ctx.moveTo(py(i),px(s.bb_upper)):ctx.lineTo(py(i),px(s.bb_upper)));
    data.slice().reverse().forEach((_,i)=>ctx.lineTo(py(data.length-1-i),px(s.bb_lower)));
    ctx.closePath(); ctx.fillStyle='rgba(59,130,246,0.06)'; ctx.fill();
    // BB lines
    ctx.setLineDash([2,3]); ctx.strokeStyle='rgba(59,130,246,0.4)'; ctx.lineWidth=1;
    ['bb_upper','bb_lower'].forEach(k=>{ ctx.beginPath(); data.forEach((_,i)=>i===0?ctx.moveTo(py(i),px(s[k])):ctx.lineTo(py(i),px(s[k]))); ctx.stroke(); });
    ctx.setLineDash([]);
  }

  // SMA lines
  if(s.sma_20) { ctx.beginPath(); data.forEach((_,i)=>i===0?ctx.moveTo(py(i),px(s.sma_20)):ctx.lineTo(py(i),px(s.sma_20))); ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1; ctx.setLineDash([3,3]); ctx.stroke(); ctx.setLineDash([]); }
  if(s.sma_50) { ctx.beginPath(); data.forEach((_,i)=>i===0?ctx.moveTo(py(i),px(s.sma_50)):ctx.lineTo(py(i),px(s.sma_50))); ctx.strokeStyle='#8b5cf6'; ctx.lineWidth=1; ctx.setLineDash([4,4]); ctx.stroke(); ctx.setLineDash([]); }

  // Price line with gradient fill
  const grad=ctx.createLinearGradient(0,0,0,h);
  const isUp=prices[prices.length-1]>=prices[0];
  grad.addColorStop(0, isUp?'rgba(22,163,74,0.15)':'rgba(220,38,38,0.15)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.beginPath();
  data.forEach((d,i)=>i===0?ctx.moveTo(py(i),px(d.close)):ctx.lineTo(py(i),px(d.close)));
  ctx.strokeStyle=isUp?'#16a34a':'#dc2626'; ctx.lineWidth=2; ctx.stroke();
  ctx.lineTo(w-10,h); ctx.lineTo(10,h); ctx.closePath(); ctx.fillStyle=grad; ctx.fill();

  // Current price label
  const cp=prices[prices.length-1];
  ctx.fillStyle=isUp?'#16a34a':'#dc2626';
  ctx.font='11px sans-serif';
  ctx.textAlign='right';
  ctx.fillText(`$${cp.toFixed(3)}`, w-12, px(cp)-4);

  // Legend
  ctx.font='10px sans-serif'; ctx.textAlign='left';
  const leg=[['─ Price',isUp?'#16a34a':'#dc2626'],['-- SMA20','#f59e0b'],['-- SMA50','#8b5cf6'],['~~ BB','#3b82f6']];
  leg.forEach(([l,c],i)=>{ ctx.fillStyle=c; ctx.fillText(l,10+i*85,14); });
}

// ── Signal chart helpers ───────────────────────────────────────────────────────
if (!window._sigChartOpts) window._sigChartOpts = {};

function _sigChartDraw(ticker) {
  const s = state.liveSignals && state.liveSignals[ticker];
  if (!s || !s.chart_data || !s.chart_data.length) return;
  const opts = window._sigChartOpts[ticker] || {};
  drawCandleChart(`chart-${ticker}`, s.chart_data, {
    mode:      opts.mode || 'candle',
    showBB:    opts.showBB !== false,
    showSMA50: opts.showSMA50 !== false,
    height:    280,
  });
}

function _sigChartSet(ticker, key, val) {
  if (!window._sigChartOpts[ticker]) window._sigChartOpts[ticker] = {};
  window._sigChartOpts[ticker][key] = val;
  _sigChartDraw(ticker);
}

function showTickerDetail(ticker) {
  document.querySelectorAll('[id^="detail-"]').forEach(el=>el.style.display='none');
  const el=document.getElementById(`detail-${ticker}`);
  if(el) {
    el.style.display='block';
    el.scrollIntoView({behavior:'smooth',block:'start'});
    setTimeout(()=>_sigChartDraw(ticker), 100);
    _loadSeasonality(ticker, state._renderGen);
  }
}

async function refreshSignals() {
  const tickers=state.portfolio.map(h=>h.ticker);
  toast('Refreshing all signals...','info');
  await fetchSignals(tickers, true);
  renderPage();
  toast('Signals refreshed','success');
}

// ── Signal Condition Rules ────────────────────────────────────────────────────
// Built-in rules evaluated against live signal data. Each rule has a label,
// description, and an evaluator function (signal object → true/false).
const SIGNAL_RULES = [
  {
    id: 'rsi_oversold',
    label: 'RSI Oversold',
    desc: 'RSI(14) < 30 — potential reversal candidate',
    color: '#16a34a',
    type: 'buy',
    eval: s => s.rsi_14 != null && s.rsi_14 < 30,
    detail: s => `RSI = ${fmt(s.rsi_14, 1)}`,
  },
  {
    id: 'rsi_overbought',
    label: 'RSI Overbought',
    desc: 'RSI(14) > 70 — consider trimming',
    color: '#dc2626',
    type: 'sell',
    eval: s => s.rsi_14 != null && s.rsi_14 > 70,
    detail: s => `RSI = ${fmt(s.rsi_14, 1)}`,
  },
  {
    id: 'macd_bullish',
    label: 'MACD Crossover ▲',
    desc: 'MACD histogram > 0 — bullish momentum',
    color: '#16a34a',
    type: 'buy',
    eval: s => s.macd_hist != null && s.macd_hist > 0 && s.macd_line != null && s.macd_line > s.macd_signal,
    detail: s => `Hist = ${fmt(s.macd_hist, 3)}`,
  },
  {
    id: 'macd_bearish',
    label: 'MACD Crossover ▼',
    desc: 'MACD histogram < 0 — bearish momentum',
    color: '#dc2626',
    type: 'sell',
    eval: s => s.macd_hist != null && s.macd_hist < 0 && s.macd_line != null && s.macd_line < s.macd_signal,
    detail: s => `Hist = ${fmt(s.macd_hist, 3)}`,
  },
  {
    id: 'bb_squeeze_low',
    label: 'BB Lower Touch',
    desc: 'Price near Bollinger lower band (BB%B < 10%)',
    color: '#16a34a',
    type: 'buy',
    eval: s => s.bb_pct_b != null && s.bb_pct_b < 0.10,
    detail: s => `BB%B = ${fmt(s.bb_pct_b * 100, 0)}%`,
  },
  {
    id: 'bb_upper_touch',
    label: 'BB Upper Touch',
    desc: 'Price near Bollinger upper band (BB%B > 90%)',
    color: '#dc2626',
    type: 'sell',
    eval: s => s.bb_pct_b != null && s.bb_pct_b > 0.90,
    detail: s => `BB%B = ${fmt(s.bb_pct_b * 100, 0)}%`,
  },
  {
    id: 'strong_trend',
    label: 'Strong Trend',
    desc: 'ADX > 25 — directional trend confirmed',
    color: '#3b82f6',
    type: 'info',
    eval: s => (s.adx || 0) > 25,
    detail: s => `ADX = ${fmt(s.adx, 0)} (${s.trend_direction})`,
  },
  {
    id: 'volume_spike',
    label: 'Volume Spike',
    desc: 'Volume ratio > 2× average — unusual activity',
    color: '#d97706',
    type: 'info',
    eval: s => (s.volume_ratio || 0) > 2,
    detail: s => `${fmt(s.volume_ratio, 1)}× avg volume`,
  },
  {
    id: 'above_sma50',
    label: 'Above SMA(50)',
    desc: 'Price above 50-day moving average — uptrend',
    color: '#16a34a',
    type: 'buy',
    eval: s => s.current_price != null && s.sma_50 != null && s.current_price > s.sma_50,
    detail: s => `Price $${fmt(s.current_price, 3)} vs SMA50 $${fmt(s.sma_50, 3)}`,
  },
  {
    id: 'below_sma50',
    label: 'Below SMA(50)',
    desc: 'Price below 50-day moving average — downtrend',
    color: '#dc2626',
    type: 'sell',
    eval: s => s.current_price != null && s.sma_50 != null && s.current_price < s.sma_50,
    detail: s => `Price $${fmt(s.current_price, 3)} vs SMA50 $${fmt(s.sma_50, 3)}`,
  },
];

function _buildSignalRulesCard(tickers, signals) {
  // Evaluate each rule against each ticker
  const triggered = []; // {rule, ticker, s}
  for (const t of tickers) {
    const s = signals[t];
    if (!s || s.error) continue;
    for (const rule of SIGNAL_RULES) {
      try {
        if (rule.eval(s)) triggered.push({ rule, ticker: t, s });
      } catch {}
    }
  }

  if (!triggered.length) {
    return `<div class="card" style="margin-bottom:14px">
      <div class="card-title">Signal Condition Alerts</div>
      <div class="text-xs text-muted" style="padding:8px 0">No conditions triggered across your holdings right now.</div>
    </div>`;
  }

  const byType = { buy: [], sell: [], info: [] };
  for (const item of triggered) byType[item.rule.type].push(item);

  const renderGroup = (items, icon, headerColor) => items.map(({rule, ticker, s}) =>
    `<div style="display:flex;align-items:flex-start;gap:10px;padding:6px 0;border-bottom:0.5px solid var(--border-light)">
      <span style="min-width:80px;font-weight:600;font-size:12px;color:${rule.color}">${icon} ${ticker}</span>
      <div style="flex:1">
        <div style="font-size:12px;font-weight:600">${rule.label}</div>
        <div style="font-size:11px;color:var(--text-muted)">${rule.desc} · <span style="color:${rule.color}">${rule.detail(s)}</span></div>
      </div>
    </div>`
  ).join('');

  return `<div class="card" style="margin-bottom:14px">
    <div class="flex-between" style="margin-bottom:10px">
      <div class="card-title" style="margin:0">Signal Condition Alerts <span style="font-size:12px;font-weight:400;color:var(--text-muted)">(${triggered.length} triggered)</span></div>
    </div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:0 24px">
      ${byType.buy.length  ? `<div><div style="font-size:11px;font-weight:700;color:#16a34a;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">▲ Bullish (${byType.buy.length})</div>${renderGroup(byType.buy,'↑','#16a34a')}</div>` : ''}
      ${byType.sell.length ? `<div><div style="font-size:11px;font-weight:700;color:#dc2626;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">▼ Bearish (${byType.sell.length})</div>${renderGroup(byType.sell,'↓','#dc2626')}</div>` : ''}
      ${byType.info.length ? `<div><div style="font-size:11px;font-weight:700;color:#3b82f6;margin-bottom:4px;text-transform:uppercase;letter-spacing:.05em">◆ Notable (${byType.info.length})</div>${renderGroup(byType.info,'·','#3b82f6')}</div>` : ''}
    </div>
  </div>`;
}
