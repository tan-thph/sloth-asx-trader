// ============================================================
// LIVE SIGNALS PAGE (yfinance powered)
// ============================================================
let _sigRefreshing = false; // true while a background refresh is in flight

// Portfolio tickers + watchlist tickers (deduped, portfolio first) — Live
// Signals now pulls technicals for both so candidates not yet held still show
// up here; _isWatchlistOnlyTicker() tags the ones that aren't actual holdings.
function _signalsPageTickers() {
  const portfolioTickers = state.portfolio.map(h => h.ticker);
  const portfolioSet = new Set(portfolioTickers);
  const watchlistTickers = (state.watchlist || [])
    .map(w => w.ticker)
    .filter(t => t && !portfolioSet.has(t));
  return [...portfolioTickers, ...new Set(watchlistTickers)];
}

function _isWatchlistOnlyTicker(t) {
  return !state.portfolio.some(h => h.ticker === t) && (state.watchlist || []).some(w => w.ticker === t);
}

async function renderSignalsPage(gen) {
  const el = document.getElementById('main-content');
  const tickers = _signalsPageTickers();

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

    <!-- SIGNAL DASHBOARD -->
    ${_buildSignalDashboard(tickers, signals)}

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
            const watchlistBadge = _isWatchlistOnlyTicker(t)
              ? '<span class="badge" style="background:#ede9fe;color:#6d28d9;border:none;margin-left:5px">★ Watchlist</span>' : '';
            return `<tr>
              <td><strong>${t}</strong>${watchlistBadge}<br><span class="text-xs text-muted">${s.fundamentals?.sector||''}</span></td>
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
            ${_isWatchlistOnlyTicker(t) ? '<span class="badge" style="background:#ede9fe;color:#6d28d9;border:none">★ Watchlist</span>' : ''}
            ${actionBadge(s.composite_signal)}
            <span class="text-xs text-muted">${f.short_name||''} · ${s.fetched_at||''}</span>
          </div>
          <button class="btn btn-sm" onclick="document.getElementById('detail-${t}').style.display='none'">✕ Close</button>
        </div>

        <!-- Price chart -->
        <div class="mb-2" style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px">
          <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
            <div style="display:flex;gap:2px;background:var(--bg-primary);border-radius:var(--radius-md);padding:2px">
              <button class="btn btn-sm" style="padding:3px 9px;font-size:11px;${(_sigChartOpts[t]||{}).mode!=='line'?'background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)':''}" onclick="_sigChartSet('${t}','mode','candle')">Candle</button>
              <button class="btn btn-sm" style="padding:3px 9px;font-size:11px;${(_sigChartOpts[t]||{}).mode==='line'?'background:var(--accent-primary);color:#fff;border-color:var(--accent-primary)':''}" onclick="_sigChartSet('${t}','mode','line')">Line</button>
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
            ${s.sector_rs_5d != null ? `<div class="signal-row"><span class="text-sm">Sector RS (5d)</span><span class="${s.sector_rs_5d >= 0 ? 'text-success' : 'text-danger'}">${s.sector_rs_5d > 0 ? '+' : ''}${s.sector_rs_5d.toFixed(1)}%</span></div>` : ''}
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
    const border=isCurrent?'2px solid var(--accent-primary)':'1px solid transparent';
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
  const { ctx, w, h } = typeof _fitCanvas === 'function'
    ? _fitCanvas(canvas, 180)
    : (() => { canvas.width = canvas.offsetWidth||800; canvas.height = 180; return { ctx: canvas.getContext('2d'), w: canvas.width, h: 180 }; })();
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
  const tickers=_signalsPageTickers();
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
    desc: 'RSI(14) < 35 — potential reversal candidate',
    color: '#16a34a',
    type: 'buy',
    eval: s => s.rsi_14 != null && s.rsi_14 < 35,
    detail: s => `RSI = ${fmt(s.rsi_14, 1)}`,
  },
  {
    id: 'rsi_overbought',
    label: 'RSI Overbought',
    desc: 'RSI(14) > 65 — consider trimming',
    color: '#dc2626',
    type: 'sell',
    eval: s => s.rsi_14 != null && s.rsi_14 > 65,
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
    label: 'BB Lower Band',
    desc: 'Price near Bollinger lower band (BB%B < 20%)',
    color: '#16a34a',
    type: 'buy',
    eval: s => s.bb_pct_b != null && s.bb_pct_b < 0.20,
    detail: s => `BB%B = ${fmt(s.bb_pct_b * 100, 0)}%`,
  },
  {
    id: 'bb_upper_touch',
    label: 'BB Upper Band',
    desc: 'Price near Bollinger upper band (BB%B > 80%)',
    color: '#dc2626',
    type: 'sell',
    eval: s => s.bb_pct_b != null && s.bb_pct_b > 0.80,
    detail: s => `BB%B = ${fmt(s.bb_pct_b * 100, 0)}%`,
  },
  {
    id: 'momentum_rising',
    label: 'Momentum Strong',
    desc: '20-day return > +8% — sustained upward momentum',
    color: '#16a34a',
    type: 'buy',
    eval: s => s.return_20d != null && s.return_20d > 8,
    detail: s => `20d return = +${fmt(s.return_20d, 1)}%`,
  },
  {
    id: 'momentum_falling',
    label: 'Momentum Weak',
    desc: '20-day return < −8% — sustained selling pressure',
    color: '#dc2626',
    type: 'sell',
    eval: s => s.return_20d != null && s.return_20d < -8,
    detail: s => `20d return = ${fmt(s.return_20d, 1)}%`,
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
    desc: 'Price above 50-day moving average — trend context',
    color: '#3b82f6',
    type: 'info',
    eval: s => s.current_price != null && s.sma_50 != null && s.current_price > s.sma_50,
    detail: s => `Price $${fmt(s.current_price, 3)} vs SMA50 $${fmt(s.sma_50, 3)}`,
  },
  {
    id: 'below_sma50',
    label: 'Below SMA(50)',
    desc: 'Price below 50-day moving average — trend context',
    color: '#9ca3af',
    type: 'info',
    eval: s => s.current_price != null && s.sma_50 != null && s.current_price < s.sma_50,
    detail: s => `Price $${fmt(s.current_price, 3)} vs SMA50 $${fmt(s.sma_50, 3)}`,
  },
];

// ── Signal Clustering — deterministic verdict engine (no LLM) ───────────────
// Replaces the old flat "Signal Condition Alerts" list (77+ rows = noise) with
// a per-ticker verdict derived purely from how many SIGNAL_RULES fire bullish
// vs bearish. Pure function of state.liveSignals — never calls an AI model.
function _computeSignalClusters(tickers, signals) {
  const clusters = [];
  for (const t of tickers) {
    const s = signals[t];
    if (!s || s.error) continue;
    const buy = [], sell = [], info = [];
    for (const rule of SIGNAL_RULES) {
      try {
        if (rule.eval(s)) {
          const item = { rule, detail: rule.detail(s) };
          if (rule.type === 'buy') buy.push(item);
          else if (rule.type === 'sell') sell.push(item);
          else info.push(item);
        }
      } catch {}
    }
    const net = buy.length - sell.length;
    let verdict;
    if (buy.length === 0 && sell.length === 0) verdict = 'Neutral';
    else if (buy.length > 0 && sell.length > 0 && Math.abs(net) <= 1) verdict = 'Mixed';
    else if (net >= 3) verdict = 'Strong Bull';
    else if (net >= 1) verdict = 'Mild Bull';
    else if (net <= -3) verdict = 'Strong Bear';
    else if (net <= -1) verdict = 'Mild Bear';
    else verdict = 'Mixed';
    clusters.push({ ticker: t, sector: s.fundamentals?.sector || 'Other', buy, sell, info, netScore: net, verdict });
  }
  return clusters;
}

const _VERDICT_STYLE = {
  'Strong Bull': { color: '#16a34a', bg: 'rgba(22,163,74,0.15)',  icon: '▲▲' },
  'Mild Bull':   { color: '#16a34a', bg: 'rgba(22,163,74,0.08)',  icon: '▲'  },
  'Neutral':     { color: 'var(--text-muted)', bg: 'rgba(128,128,128,0.06)', icon: '·' },
  'Mixed':       { color: '#d97706', bg: 'rgba(217,119,6,0.10)',  icon: '◆' },
  'Mild Bear':   { color: '#dc2626', bg: 'rgba(220,38,38,0.08)',  icon: '▼'  },
  'Strong Bear': { color: '#dc2626', bg: 'rgba(220,38,38,0.15)',  icon: '▼▼' },
};

// Chart 1 — Market Breadth Gauge: bull/bear balance across the whole portfolio
function _renderBreadthGauge(clusters) {
  const total = clusters.length;
  if (!total) return '';
  const bullish = clusters.filter(c => c.verdict === 'Strong Bull' || c.verdict === 'Mild Bull').length;
  const bearish = clusters.filter(c => c.verdict === 'Strong Bear' || c.verdict === 'Mild Bear').length;
  const neutral = total - bullish - bearish;
  const bullPct = Math.round(bullish / total * 100), bearPct = Math.round(bearish / total * 100);
  const neutPct = 100 - bullPct - bearPct;
  const breadthScore = Math.round((bullish - bearish) / total * 100); // -100..100
  const scoreColor = breadthScore > 10 ? '#16a34a' : breadthScore < -10 ? '#dc2626' : '#d97706';
  const scoreLabel = breadthScore > 30 ? 'Strongly Bullish'
    : breadthScore > 10 ? 'Bullish'
    : breadthScore > 0  ? 'Slight Bull'
    : breadthScore === 0 ? 'Balanced'
    : breadthScore >= -10 ? 'Slight Bear'
    : breadthScore >= -30 ? 'Bearish'
    : 'Strongly Bearish';
  return `
  <div class="card mb-2">
    <div class="card-title">Market Breadth Gauge <span class="text-xs text-muted" style="font-weight:400">— bull/bear balance across your holdings</span></div>
    <div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:10px">
      <div style="font-size:28px;font-weight:800;color:${scoreColor}">${breadthScore > 0 ? '+' : ''}${breadthScore}</div>
      <div>
        <div style="font-weight:700;color:${scoreColor}">${scoreLabel}</div>
        <div class="text-xs text-muted">${bullish} bullish · ${neutral} neutral/mixed · ${bearish} bearish (of ${total} holdings)</div>
      </div>
    </div>
    <div style="display:flex;height:14px;border-radius:7px;overflow:hidden;background:var(--bg-inset)">
      ${bullPct ? `<div style="width:${bullPct}%;background:#16a34a" title="Bullish ${bullPct}%"></div>` : ''}
      ${neutPct ? `<div style="width:${neutPct}%;background:#9ca3af" title="Neutral/Mixed ${neutPct}%"></div>` : ''}
      ${bearPct ? `<div style="width:${bearPct}%;background:#dc2626" title="Bearish ${bearPct}%"></div>` : ''}
    </div>
    <div class="flex-between text-xs text-muted mt-1">
      <span>▲ Bullish ${bullPct}%</span><span>· Neutral ${neutPct}%</span><span>▼ Bearish ${bearPct}%</span>
    </div>
  </div>`;
}

// Chart 2 — Sector Strength Heatmap: average net signal score per sector
function _renderSectorHeatmap(clusters) {
  const bySector = {};
  for (const c of clusters) {
    if (!bySector[c.sector]) bySector[c.sector] = { sum: 0, n: 0, tickers: [] };
    bySector[c.sector].sum += c.netScore;
    bySector[c.sector].n += 1;
    bySector[c.sector].tickers.push(c.ticker);
  }
  const entries = Object.entries(bySector);
  if (!entries.length) return '';
  return `
  <div class="card mb-2">
    <div class="card-title">Sector Strength Heatmap <span class="text-xs text-muted" style="font-weight:400">— avg net signal score by sector</span></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px">
      ${entries.map(([sector, v]) => {
        const avg = v.sum / v.n;
        const col = avg > 1 ? '#16a34a' : avg < -1 ? '#dc2626' : avg !== 0 ? '#d97706' : 'var(--text-muted)';
        const pct = Math.min(100, Math.abs(avg) * 25);
        return `<div style="background:var(--bg-surface);border-radius:6px;padding:10px" title="${escapeHTML(v.tickers.join(', '))}">
          <div style="font-size:11px;color:var(--text-tertiary);margin-bottom:4px">${escapeHTML(sector)} <span class="text-xs text-muted">(${v.n})</span></div>
          <div style="display:flex;align-items:center;gap:6px">
            <div style="flex:1;height:5px;background:var(--bg-inset);border-radius:3px">
              <div style="width:${pct}%;height:100%;background:${col};border-radius:3px"></div>
            </div>
            <span style="font-weight:700;color:${col};font-size:13px">${avg > 0 ? '+' : ''}${avg.toFixed(1)}</span>
          </div>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

// Chart 3 — Signal Cluster Table: one row per ticker with verdict + chips
// (replaces the old flat 77-row alert list)
function _renderSignalClusterTable(clusters) {
  if (!clusters.length) return '';
  const sorted = [...clusters].sort((a, b) => b.netScore - a.netScore);
  return `
  <div class="card mb-2">
    <div class="card-title">Signal Cluster Table <span class="text-xs text-muted" style="font-weight:400">— per-ticker verdict from ${SIGNAL_RULES.length} deterministic rules</span></div>
    <div class="table-wrap">
      <table class="tbl-stack">
        <thead><tr><th>Ticker</th><th>Verdict</th><th>Net</th><th>Bullish signals</th><th>Bearish signals</th></tr></thead>
        <tbody>
        ${sorted.map(c => {
          const vs = _VERDICT_STYLE[c.verdict];
          return `<tr>
            <td data-label="Ticker"><strong>${c.ticker}</strong>${_isWatchlistOnlyTicker(c.ticker) ? ' <span class="badge" style="background:#ede9fe;color:#6d28d9;border:none;font-size:9px">★ WL</span>' : ''}<br><span class="text-xs text-muted">${escapeHTML(c.sector)}</span></td>
            <td data-label="Verdict"><span class="badge" style="background:${vs.bg};color:${vs.color};border:none">${vs.icon} ${c.verdict}</span></td>
            <td data-label="Net" style="font-weight:700;color:${vs.color}">${c.netScore > 0 ? '+' : ''}${c.netScore}</td>
            <td data-label="Bullish">${c.buy.length ? c.buy.map(b => `<span class="signal-chip chip-buy" title="${escapeHTML(b.detail)}">${escapeHTML(b.rule.label)}</span>`).join('') : '<span class="text-xs text-muted">—</span>'}</td>
            <td data-label="Bearish">${c.sell.length ? c.sell.map(b => `<span class="signal-chip chip-sell" title="${escapeHTML(b.detail)}">${escapeHTML(b.rule.label)}</span>`).join('') : '<span class="text-xs text-muted">—</span>'}</td>
          </tr>`;
        }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

// Chart 4 — Top Opportunities: best bullish and worst bearish clusters, ranked
function _renderTopOpportunities(clusters) {
  const bullish = clusters.filter(c => c.netScore > 0).sort((a, b) => b.netScore - a.netScore).slice(0, 5);
  const bearish = clusters.filter(c => c.netScore < 0).sort((a, b) => a.netScore - b.netScore).slice(0, 5);
  if (!bullish.length && !bearish.length) {
    return `<div class="card mb-2"><div class="card-title">Top Opportunities</div><div class="text-xs text-muted" style="padding:8px 0">No directional clusters right now — portfolio is signal-neutral.</div></div>`;
  }
  const renderList = (items, label, color) => !items.length ? '' : `
    <div>
      <div style="font-size:11px;font-weight:700;color:${color};margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em">${label}</div>
      ${items.map(c => {
        const topSignals = (c.netScore > 0 ? c.buy : c.sell).slice(0, 2).map(x => x.rule.label).join(', ');
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:0.5px solid var(--border-light)">
          <div><strong>${c.ticker}</strong><span class="text-xs text-muted" style="margin-left:6px">${escapeHTML(topSignals)}</span></div>
          <span style="font-weight:700;color:${color}">${c.netScore > 0 ? '+' : ''}${c.netScore}</span>
        </div>`;
      }).join('')}
    </div>`;
  return `
  <div class="card mb-2">
    <div class="card-title">Top Opportunities <span class="text-xs text-muted" style="font-weight:400">— ranked by net signal score</span></div>
    <div class="grid-2">
      ${renderList(bullish, '▲ Top Bullish Setups', '#16a34a')}
      ${renderList(bearish, '▼ Top Bearish / Risk Setups', '#dc2626')}
    </div>
  </div>`;
}

function _buildSignalDashboard(tickers, signals) {
  const clusters = _computeSignalClusters(tickers, signals);
  if (!clusters.length) {
    return `<div class="card mb-2"><div class="card-title">Signal Dashboard</div><div class="text-xs text-muted" style="padding:8px 0">No live signal data yet.</div></div>`;
  }
  return _renderBreadthGauge(clusters)
    + _renderSectorHeatmap(clusters)
    + _renderSignalClusterTable(clusters)
    + _renderTopOpportunities(clusters);
}
