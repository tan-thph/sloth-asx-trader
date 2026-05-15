// ============================================================
// LIVE SIGNALS PAGE (yfinance powered)
// ============================================================
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

  // Show loading — only if still on signals page
  if(state._renderGen !== gen) return;
  el.innerHTML=`<div class="card"><div class="empty-state"><div class="loading-dots"><span></span><span></span><span></span></div><p class="text-muted mt-1">Fetching yfinance data for ${tickers.join(', ')}...</p></div></div>`;

  await fetchSignals(tickers, false);

  // After await — check we're still on signals page before writing
  if(state._renderGen !== gen) return;

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
      <p class="text-muted text-sm">Real-time technical indicators via yfinance · 6-month lookback</p>
      <button class="btn btn-primary btn-sm" onclick="refreshSignals()">⟳ Refresh Signals</button>
    </div>

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

        <!-- Price chart placeholder -->
        <div class="mb-2" style="background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px">
          <canvas id="chart-${t}" style="width:100%;height:180px"></canvas>
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
      </div>`;
    }).join('')}
  `;

  el.innerHTML=html;

  // Draw sparkline charts for each ticker with data — guard gen again in case of slow draws
  tickers.forEach(t=>{
    const s=signals[t];
    if(s&&!s.error&&s.chart_data?.length) {
      setTimeout(()=>{ if(state._renderGen===gen) drawSparklineFromData(t, s); }, 50);
    }
  });
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

function showTickerDetail(ticker) {
  document.querySelectorAll('[id^="detail-"]').forEach(el=>el.style.display='none');
  const el=document.getElementById(`detail-${ticker}`);
  if(el) { el.style.display='block'; el.scrollIntoView({behavior:'smooth',block:'start'}); setTimeout(()=>{ const s=state.liveSignals[ticker]; if(s&&!s.error&&s.chart_data) drawSparklineFromData(ticker, s); },100); }
}

async function refreshSignals() {
  const tickers=state.portfolio.map(h=>h.ticker);
  toast('Refreshing all signals...','info');
  await fetchSignals(tickers, true);
  renderPage();
  toast('Signals refreshed','success');
}
