// ============================================================
// ANALYSIS ENGINE
// ============================================================
async function runAnalysis() {
  if(state.analysisRunning){toast('Analysis already running','info');return;}
  const key=getApiKey();
  if(!key){toast('Add API key in Settings','error');showPage('settings');return;}
  state.analysisRunning=true;
  toast('Running analysis — refreshing live prices first...','info');

  // ── Step 0: ALWAYS refresh portfolio prices before sending data to the AI ──
  if (state.serverOk && state.portfolio.length) {
    try { await refreshPrices({silent: true}); } catch {}
  }

  // ── Step 0b: Sync cash from DB (authoritative balance) ──
  await fetchCashFromDb();

  // ── Step 0c: Refresh RBA rate if we don't have a live reading today ──
  const today = todayStr();
  if (state.rbaRateSource !== 'live-rba' || state.rbaRateDate !== today) {
    await fetchRbaRate();
  }

  // ── Step 0d: Fetch dividend data — runs ONLY here, just before the Claude API call.
  //    Covers portfolio tickers + any extra watchlist tickers.
  //    Manual refresh available via ⟳ button in Portfolio tab.
  {
    const _pt = mergedPortfolio().map(h=>h.ticker);
    const _et = (state.analysisConfig.extraTickers||[]).filter(t=>!_pt.includes(t));
    toast('Fetching dividend data…', 'info');
    await fetchDividends([..._pt, ..._et], true);
  }

    async function fetchNews() {
        if (!state.serverOk) return [];
        const tickers = mergedPortfolio().map(h => h.ticker).join(',');
        try {
          // Try new news scanner brief first (LLM-classified, high-impact articles)
          const r = await fetch(`${API}/api/news/brief?tickers=${tickers}&days=3`);
          if (r.ok) {
            const d = await r.json();
            const items = d.items || [];
            if (items.length) return items;
          }
        } catch {}
        // Fall back to legacy yfinance news
        try {
          const r = await fetch(`${API}/api/news?tickers=${tickers}`);
          if (!r.ok) return [];
          const data = await r.json();
          return data.news || [];
        } catch {
          return [];
        }
      }

  // ── Step 1: Auto-run macro brief (once per day) in parallel with signal fetch ──
  const macroPromise = (async () => {
    const macroToday = todayStr();
    // Skip if macro already ran today and has content
    if (state.macroDate === macroToday && state.macroData?.analysis) {
      console.log('Macro brief already ran today — using cached data');
      return;
    }
    try {
      let liveCtx = '';
      if(state.serverOk) {
        const r = await fetch(`${API}/api/macro`);
        if(r.ok) {
          const d = await r.json();
          state.macroData = {...d, _source:'live'};
          const lines = [];
          if(d.sp500)   lines.push(`S&P500: ${fmt(d.sp500.value)} (${fmtp(d.sp500.change_pct)})`);
          if(d.asx200)  lines.push(`ASX200: ${fmt(d.asx200.value)} (${fmtp(d.asx200.change_pct)})`);
          if(d.gold)    lines.push(`Gold: ${fmt(d.gold.value)} (${fmtp(d.gold.change_pct)})`);
          if(d.aud_usd) lines.push(`AUD/USD: ${fmt(d.aud_usd.value,4)} (${fmtp(d.aud_usd.change_pct)})`);
          if(d.vix)     lines.push(`VIX: ${fmt(d.vix.value)}`);
          liveCtx = lines.join(' | ');
        }
      }


      const macroSystem = MACRO_SYSTEM_PROMPT;
      const macroResp = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},
        body: JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1000,system:macroSystem,
          messages:[{role:'user',content:`Provide current macro analysis for ASX morning brief. Today: ${todayStr()}${liveCtx?'. Live market data: '+liveCtx:'. Use realistic current estimates.'}  Return only JSON.`}]})
      });
      const macroData = await macroResp.json();
      if(!macroData.error) {
        const macroText = macroData.content?.[0]?.text || '{}';
        const macroAI = JSON.parse(macroText.replace(/```json|```/g,'').trim());
        state.macroData = {...(state.macroData||{}), ...macroAI, _source: state.macroData?._source==='live'?'live':'ai'};
        state.macroDate = macroToday;
      }
    } catch(e) { console.warn('Macro brief failed silently:', e.message); }
  })();

  // ── Step 2: fetch signals (in parallel with macro above) ──
  toast('Fetching live signals...','info');

  // All tickers = portfolio + any extras from analysisConfig
  const portfolioTickers = mergedPortfolio().map(h=>h.ticker);
  const extraTickers = (state.analysisConfig.extraTickers||[]).filter(t=>!portfolioTickers.includes(t));
  const allTickers = [...portfolioTickers, ...extraTickers];

  // Fetch signals for all tickers — force-refresh so the AI gets the freshest
  // technical data (bypasses the 15-min fetchSignals cache).
  if(state.serverOk && allTickers.length) { try { await fetchSignals(allTickers, true); } catch {} }

  // ── Step 2b: fetch portfolio risk metrics ───────────────────────────────────
  // Run in parallel with the rest of context building — non-blocking failure.
  let _riskMetrics = {};   // {TICKER: {var_95, cvar_95, max_drawdown, beta, sharpe, volatility_ann}}
  let _riskComposite = null; // portfolio-level weighted values
  if (state.serverOk && portfolioTickers.length) {
    try {
      const rf = state.rbaRate || 4.35;
      const riskResp = await fetch(`${API}/api/risk?tickers=${portfolioTickers.join(',')}&rf=${rf}`);
      if (riskResp.ok) {
        const rd = await riskResp.json();
        _riskMetrics = rd.metrics || {};
        // Compute portfolio-weighted composites for the prompt
        const pv = portfolioValue();
        let wVol=0, wBeta=0, wVaR=0, wDD=0, wSharpe=0, covered=0;
        for (const h of mergedPortfolio()) {
          const m = _riskMetrics[h.ticker];
          if (!m) continue;
          const w = pv > 0 ? (h.shares * h.currentPrice) / pv : 0;
          wVol    += m.volatility_ann * w;
          wBeta   += m.beta           * w;
          wVaR    += (m.var_95  || 0) * w;
          wDD     += (m.max_drawdown || 0) * w;
          wSharpe += m.sharpe         * w;
          covered++;
        }
        if (covered > 0) _riskComposite = { wVol, wBeta, wVaR, wDD, wSharpe };
      }
    } catch { /* non-fatal — analysis continues without risk data */ }
  }

  // Build indicator context (full detail per ticker)
  let indicatorCtx = '';
  const loaded = allTickers.filter(t=>state.liveSignals[t]&&!state.liveSignals[t].error);
  if(loaded.length) {
    indicatorCtx = '\n\nLIVE TECHNICAL DATA (yfinance, real-time):\n' + loaded.map(t=>{
      const s = state.liveSignals[t];
      const f = s.fundamentals || {};
      const sr = s.support_resistance || {};
      const inPortfolio = portfolioTickers.includes(t);
      return `\n[${t}]${inPortfolio?'':' ★WATCHLIST★'}
  Price=$${s.current_price} | Signal=${s.composite_signal} (${(s.confidence*100).toFixed(0)}% conf) | Trend=${s.trend_direction} | ADX=${s.adx?.toFixed(1)} (${s.trend_strength})
  Momentum: RSI14=${s.rsi_14?.toFixed(1)}, RSI9=${s.rsi_9?.toFixed(1)}, MACDhist=${s.macd_hist?.toFixed(4)}, Stoch%K=${s.stoch_k?.toFixed(1)}/%D=${s.stoch_d?.toFixed(1)}, CCI=${s.cci?.toFixed(1)}, MFI=${s.mfi?.toFixed(1)}, WillR=${s.williams_r?.toFixed(1)}, ROC10=${s.roc_10?.toFixed(2)}%
  Trend: SMA20=$${s.sma_20?.toFixed(3)}, SMA50=${s.sma_50?'$'+s.sma_50.toFixed(3):'n/a'}, SMA200=${s.sma_200?'$'+s.sma_200.toFixed(3):'n/a'}, EMA12=$${s.ema_12?.toFixed(3)}, EMA26=$${s.ema_26?.toFixed(3)}
  Bollinger: Upper=$${s.bb_upper?.toFixed(3)}, Mid=$${s.bb_mid?.toFixed(3)}, Lower=$${s.bb_lower?.toFixed(3)}, %B=${s.bb_pct_b!=null?(s.bb_pct_b*100).toFixed(0)+'%':'n/a'}, Width=${s.bb_bandwidth?.toFixed(1)}%
  Volatility: ATR=$${s.atr_14?.toFixed(3)} (${s.atr_pct?.toFixed(1)}%), HistVol20d=${s.hist_vol_20?.toFixed(1)}%ann, Keltner=${s.keltner_lower?.toFixed(3)}-${s.keltner_upper?.toFixed(3)}
  Volume: Today=${s.volume_today?.toLocaleString()}, Avg20=${s.volume_avg_20?.toLocaleString()}, Ratio=${s.volume_ratio?.toFixed(2)}x, OBV=${s.obv_trend}, VWAP20=$${s.vwap_20d?.toFixed(3)} (price ${s.price_vs_vwap})
  S/R Pivots: R2=$${sr.r2?.toFixed(3)}, R1=$${sr.r1?.toFixed(3)}, Pivot=$${sr.pivot?.toFixed(3)}, S1=$${sr.s1?.toFixed(3)}, S2=$${sr.s2?.toFixed(3)}
  Returns: 1D=${s.return_1d?.toFixed(2)}%, 5D=${s.return_5d?.toFixed(2)}%, 20D=${s.return_20d?.toFixed(2)}%, 60D=${s.return_60d?.toFixed(2)}%
  Fundamentals: PE=${f.pe_ratio?.toFixed(1)||'n/a'}, FwdPE=${f.forward_pe?.toFixed(1)||'n/a'}, PB=${f.pb_ratio?.toFixed(2)||'n/a'}, DivYield=${f.dividend_yield?(f.dividend_yield*100).toFixed(2)+'%':'n/a'}, Beta=${f.beta?.toFixed(2)||'n/a'}, ROE=${f.roe?(f.roe*100).toFixed(1)+'%':'n/a'}
  52W: High=$${f['52w_high']?.toFixed(3)||'n/a'}, Low=$${f['52w_low']?.toFixed(3)||'n/a'}, FromHigh=${f.pct_from_52w_high?.toFixed(1)||'n/a'}%, Analyst=${f.analyst_recommendation||'n/a'} (target $${f.analyst_target?.toFixed(2)||'n/a'})
  BuySignals: ${(s.buy_signals||[]).join(', ')||'none'} | SellSignals: ${(s.sell_signals||[]).join(', ')||'none'}`;
    }).join('\n');
  }

  // Merged portfolio for analysis (deduplicated, weighted avg)
  const mp = mergedPortfolio();
  const portfolioJson = JSON.stringify(mp.map(h=>({
    ticker: h.ticker,
    sector: h.sector,
    shares: h.shares,
    avgPrice: h.avgPrice,
    currentPrice: h.currentPrice,
    value: h.shares * h.currentPrice,
    unrealisedPnl: (h.currentPrice - h.avgPrice) * h.shares,
    weight: ((h.shares * h.currentPrice) / portfolioValue() * 100).toFixed(1) + '%',
  })));

  // Recent recommendation history with outcomes + feedback
  // Strategy: send at most 10 recs. Prioritise:
  //   1. Last 5 regardless (always needed for same-day/7-day dedup logic)
  //   2. Executed recs with actual P&L (feedback loop — up to 3)
  //   3. Recs with explicit user feedback (up to 2)
  // This keeps the history context to ~300-400 tokens vs ~900 for flat last-15.
  const last5 = state.recHistory.slice(0, 5);
  const withPnl = state.recHistory.slice(5).filter(r => r.actualProfit != null).slice(0, 3);
  const withFeedback = state.recHistory.slice(5).filter(r => r.feedback && !withPnl.includes(r)).slice(0, 2);
  const recentRecs = [...new Set([...last5, ...withPnl, ...withFeedback])];
  const recCtx = recentRecs.length ? '\n\nRECENT RECOMMENDATION HISTORY (last 5 + key outcomes):\n' + recentRecs.map(r =>
    `${r.date} ${r.action} ${r.ticker} @ $${r.priceRange?.[0]||'?'} → target $${r.target||'?'} | conf=${fmt(r.confidence*100,0)}% | outcome=${r.outcome||'open'} | actualPnL=${r.actualProfit!=null?'$'+fmt(r.actualProfit):'pending'}${r.feedback?' | FEEDBACK: "'+r.feedback+'"':''}`
  ).join('\n') : '';

  // Pending recs with feedback
  const pendingWithFeedback = state.recommendations.filter(r=>r.status==='pending'&&r.feedback);
  const pendingFeedbackCtx = pendingWithFeedback.length ? '\n\nFEEDBACK ON CURRENT PENDING RECS:\n' + pendingWithFeedback.map(r=>
    `${r.ticker} ${r.action}: "${r.feedback}"`
  ).join('\n') : '';

  // Market view / user instructions context
  const marketView = state.analysisConfig.marketView || '';
  const marketViewCtx = marketView ? `\n\nINVESTOR MARKET VIEW & INSTRUCTIONS (high priority — incorporate into analysis):\n${marketView}` : '';

  // Include today's macro brief in the prompt if available
  const _m = state.macroData;
  // Macro context: omit verbose analysis prose — keyDrivers is sufficient and avoids
  // double-counting narrative already in the cached system prompt. Saves ~300-400 tokens/run.
  const macroCtx = _m ? `\n\nTODAY'S MACRO BRIEF (${state.macroDate||todayStr()}):
Sentiment: ${_m.sentiment||'n/a'} | Bullish: ${_m.bullish!=null?_m.bullish+'/100':'n/a'} | Conf: ${_m.sentimentConf!=null?Math.round(_m.sentimentConf*100)+'%':'n/a'}
Key drivers: ${(_m.keyDrivers||'n/a').slice(0,200)}` : '';


  // ── News signals — compact tiered block ─────────────────────────────────────
  // Tier 1: articles whose primary subject is a portfolio holding (high signal value)
  // Tier 2: high-impact market-wide articles (impact ≥ 6.0, no holding as primary subject)
  // Each article pre-formatted to ~15-20 tokens via the 'signal' field from the server.
  // Total budget: ~150 tokens vs ~3,500 tokens for the old separate API call approach.
  let newsOutlook = '';
  const news = await fetchNews();
  if (news.length) {
    const direct  = news.filter(n => n.portfolio_direct);
    const broad   = news.filter(n => !n.portfolio_direct);

    const fmtSignal = n => {
      if (n.signal) return `  • ${n.signal}`;
      const date = (n.date || n.timestamp || '').slice(5, 10);
      return `  • ${n.title?.slice(0, 70)} (${date})`;
    };

    const lines = [];
    if (direct.length)  lines.push('Holdings directly covered:', ...direct.map(fmtSignal));
    if (broad.length)   lines.push('Market-wide signals:', ...broad.map(fmtSignal));

    if (lines.length) {
      newsOutlook = `\n\nNEWS SIGNALS (LLM-classified, last 2d — use to adjust conviction on impacted tickers):\n${lines.join('\n')}`;
    }
  }

  // ── ASX Announcements — price-sensitive filings for portfolio tickers ────────
  // Fetched from the local announcement DB (synced separately by the Ann engine).
  // Only included when the server is up and there is data — silently skipped otherwise.
  // Signal format: TICKER [Type|sentiment|impact|⚡PS] Headline (date)
  //   ⚡PS = price sensitive flag from ASX/Markit directly (high reliability)
  let annCtx = '';
  if (state.serverOk && allTickers.length) {
    try {
      const annResp = await fetch(
        `${API}/api/announcements/brief?tickers=${allTickers.join(',')}&days=3&max=10`
      ).then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] }));

      const annItems = annResp.items || [];
      if (annItems.length) {
        // Separate price-sensitive from routine to give the AI a clear priority signal
        const psItems   = annItems.filter(a => a.price_sensitive);
        const otherItems = annItems.filter(a => !a.price_sensitive);
        const lines = [];
        if (psItems.length)    lines.push('⚡ Price-sensitive (ASX-flagged):',   ...psItems.map(a   => `  • ${a.signal}`));
        if (otherItems.length) lines.push('Routine filings:',                     ...otherItems.map(a => `  • ${a.signal}`));
        annCtx = `\n\nASX ANNOUNCEMENT FILINGS (last 3d — authoritative: from ASX/Markit directly):\n${lines.join('\n')}`;
      }
    } catch { /* non-fatal — analysis continues without announcements */ }
  }


  // ── Risk metrics context ─────────────────────────────────────────────────────
  let riskCtx = '';
  if (_riskComposite) {
    const rc = _riskComposite;
    // Per-ticker risk rows (portfolio holdings only)
    const riskRows = mergedPortfolio().map(h => {
      const m = _riskMetrics[h.ticker];
      if (!m) return `  ${h.ticker}: no risk data`;
      const ddWarn  = m.max_drawdown > 25 ? ' ⚠HIGH-DD' : '';
      const varWarn = m.var_95 < -3.5    ? ' ⚠HIGH-VAR' : '';
      return `  ${h.ticker}: Vol=${m.volatility_ann.toFixed(1)}%ann | Beta=${m.beta.toFixed(2)} | Sharpe=${m.sharpe.toFixed(2)} | VaR1d=${m.var_95.toFixed(2)}%${varWarn} | CVaR=${m.cvar_95.toFixed(2)}% | MaxDD90d=${m.max_drawdown.toFixed(1)}%${ddWarn}`;
    }).join('\n');
    // Portfolio composite risk score (same formula as risk page)
    const clamp  = (v, lo, hi) => Math.max(0, Math.min(25, (v - lo) / (hi - lo) * 25));
    const sectorMap2 = {};
    for (const h of mergedPortfolio()) { const s=h.sector||'Other'; sectorMap2[s]=(sectorMap2[s]||0)+h.shares*h.currentPrice; }
    const topConc2 = portfolioValue()>0 ? Math.max(...Object.values(sectorMap2))/portfolioValue()*100 : 0;
    const compScore2 = Math.round(clamp(rc.wVol,10,35)+clamp(topConc2,20,60)+clamp(rc.wDD,5,25)+clamp(rc.wBeta,0.5,1.5));
    const scoreLabel2 = compScore2 < 34 ? 'Low' : compScore2 < 67 ? 'Moderate' : 'High';
    riskCtx = `\n\nPORTFOLIO RISK METRICS (90-day, yfinance — use for sizing and conviction):
Composite risk score: ${compScore2}/100 (${scoreLabel2}) | Weighted: Vol=${rc.wVol.toFixed(1)}%ann | Beta=${rc.wBeta.toFixed(2)} | VaR1d=${rc.wVaR.toFixed(2)}% | AvgMaxDD=${rc.wDD.toFixed(1)}% | Sharpe=${rc.wSharpe.toFixed(2)}
Per-ticker:
${riskRows}`;
  }

  // Extra tickers context
  const extraTickersCtx = extraTickers.length ? `\n\nADDITIONAL WATCHLIST TICKERS (assess for entry, not yet in portfolio): ${extraTickers.join(', ')}` : '';

  // Dividend data context
  const divLines = allTickers.filter(t => state.dividendData[t] && !state.dividendData[t].error).map(t => {
    const d = state.dividendData[t];
    const yieldStr = d.dividendYield != null ? (d.dividendYield * 100).toFixed(2) + '%' : 'n/a';
    const annualStr = d.annualDivPerShare != null ? '$' + d.annualDivPerShare.toFixed(4) + '/yr' : 'n/a';
    const nextStr = d.nextEstAmount != null ? '$' + d.nextEstAmount.toFixed(4) + ' est' : 'n/a';
    const exStr = d.exDividendDate || 'unknown';
    const freqStr = d.frequencyLabel || 'Unknown';
    const payoutStr = d.payoutRatio != null ? (d.payoutRatio * 100).toFixed(0) + '%' : 'n/a';
    const recentHist = (d.history || []).slice(0, 4).map(h => `${h.date}:$${h.amount}`).join(', ');
    return `  ${t}: yield=${yieldStr} | annual=${annualStr} | nextEst=${nextStr} | exDiv=${exStr} | freq=${freqStr} | payoutRatio=${payoutStr} | recent=[${recentHist||'none'}]`;
  });
  const dividendCtx = divLines.length ? `\n\nDIVIDEND SCHEDULE & HISTORY (yfinance, use for income analysis and ex-div timing):\n${divLines.join('\n')}` : '';

  // Earnings calendar context
 const earningsLines = allTickers
    .filter(t => state.earningsCalendar[t] && !state.earningsCalendar[t].error && state.earningsCalendar[t].nextEarningsDate)
    .map(t => {
      const e = state.earningsCalendar[t];
      const todayISO = new Date().toISOString().slice(0,10);
      const daysAway = Math.round((new Date(e.nextEarningsDate) - new Date(todayISO)) / 86400000);
      const epsStr = e.forwardEps != null ? `fwdEPS=$${e.forwardEps.toFixed(2)}` : '';
      const epsGrowthStr = e.epsGrowth != null ? `epsGrowth=${(e.epsGrowth*100).toFixed(0)}%` : '';
      const revGrowthStr = e.revenueGrowth != null ? `revGrowth=${(e.revenueGrowth*100).toFixed(0)}%` : '';
      const urgencyFlag = Math.abs(daysAway) <= 14 ? ' ⚡IMMINENT' : daysAway < 0 ? ' (past)' : '';
      return `  ${t}: nextEarnings=${e.nextEarningsDate} (${daysAway}d)${urgencyFlag} | ${[epsStr,epsGrowthStr,revGrowthStr].filter(Boolean).join(' | ')} | analyst=${e.analystRec||'n/a'} target=$${e.analystTarget?.toFixed(2)||'n/a'}`;
    });
  const earningsCtx = earningsLines.length ? `\n\nEARNINGS CALENDAR (use for catalyst timing and pre-earnings positioning):\n${earningsLines.join('\n')}` : '';


  // ── Calibration: computed client-side so the AI receives a deterministic instruction
  //    rather than being asked to do arithmetic on the history itself.
  const calibrationNote = (() => {
    const closed = state.recHistory.filter(r => r.actualProfit != null);
    if (closed.length < 5) return '';
    const bands = {};
    for (const r of closed) {
      const conf = r.confidence || 0;
      const band = conf >= 0.9 ? '0.90+' : conf >= 0.8 ? '0.80-0.89' : conf >= 0.7 ? '0.70-0.79' : '0.60-0.69';
      if (!bands[band]) bands[band] = { hits: 0, total: 0 };
      bands[band].total++;
      if (r.actualProfit > 0) bands[band].hits++;
    }
    const lines = Object.entries(bands)
      .filter(([, s]) => s.total >= 3)
      .map(([band, s]) => {
        const hr = Math.round(s.hits / s.total * 100);
        return hr < 60
          ? `  ${band}: ${s.hits}/${s.total} = ${hr}% hit rate → apply −0.10 confidence to new recs in this band`
          : `  ${band}: ${s.hits}/${s.total} = ${hr}% hit rate → no adjustment needed`;
      });
    return lines.length
      ? `\n\nCALIBRATION (pre-computed — apply adjustments below before setting confidence scores):\n${lines.join('\n')}`
      : '';
  })();

  // ── userMessage carries ALL dynamic/live context; systemPrompt stays fully static
  //    for stable prompt-cache hits across the entire trading day.
  const userMessage = `Date: ${todayStr()} | Time: ${nowSydney()}
Account settings: brokerage $${state.settings.brokerage}/trade (round-trip $${state.settings.brokerage * 2}) | max ${state.settings.maxTradesPerDay} trades/day | min trade $${state.settings.minTradeSize}

LIVE PORTFOLIO STATE:
Holdings: ${portfolioJson}
Cash available: $${fmt(state.cash)} | Total invested: $${fmt(totalCost())} | Net worth: $${fmt(totalNetWorth())}
RBA Cash Rate: ${state.rbaRate.toFixed(2)}% (${state.rbaRateSource}${state.rbaRateDate ? ', ' + state.rbaRateDate : ''})
${recCtx}${pendingFeedbackCtx}${calibrationNote}${macroCtx}${newsOutlook}${annCtx}${marketViewCtx}${extraTickersCtx}${dividendCtx}${earningsCtx}${riskCtx}${indicatorCtx}

TASK:
1. Apply any CALIBRATION adjustments above to confidence scores before output.
2. Assess macro regime — Rule 12: if sentiment = "bearish" AND bullish < 35, block all BUY/TOP_UP.
3. For every holding and watchlist ticker, run the Section 3 multi-factor framework. Exclude any ticker with < 3 independent non-technical factors from recs[].
4. For each candidate rec: compute priceRange, target (next S/R), stopLoss (1.5×ATR), qty, scenarios (p sums to 1.0), invalidationCondition (must include a measurable value), bearCase (if conf ≥ 0.70), factorsUsed (≥ 3 specific data points).
5. Apply Section 7 pre-flight checks. Fix all failures before writing JSON.
6. Return JSON only — no preamble, no markdown.`;

  // ── systemPrompt is defined in js/prompts.js — edit there, not here.
  const systemPrompt = ANALYSIS_SYSTEM_PROMPT;

  // ── Wait for macro to finish, then send main analysis ──
  await macroPromise;
  toast('Running AI trade analysis...','info');

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        // portfolioAnalysis removed — responses are now recs[] + summary + dataGaps only.
        // 6000 tokens is generous for up to ~8 recs; raise if truncation reappears.
        max_tokens: 6000,
        system: [
          // FIX #9: Only static rules are cached — no live portfolio state.
          // This cache is now stable across the entire trading day regardless of trades executed.
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{
          role: 'user',
          content: userMessage
        }]
      })
    });

    const data = await resp.json();
    if(data.error) throw new Error(data.error.message);

    // Track cache usage for cost display
    const usage = data.usage || {};
    if(usage.cache_read_input_tokens || usage.cache_creation_input_tokens) {
      const saved = usage.cache_read_input_tokens || 0;
      const created = usage.cache_creation_input_tokens || 0;
      console.log(`Prompt cache: ${saved} tokens read from cache, ${created} tokens written to cache`);
    }
    // Log context breakdown to help diagnose token usage
    console.log(`[Token audit] recHistory sent: ${recentRecs.length} entries (last5=${last5.length} withPnl=${withPnl.length} withFeedback=${withFeedback.length})`);
    console.log(`[Token audit] indicatorCtx chars: ${indicatorCtx.length} | macroCtx chars: ${macroCtx.length} | divCtx chars: ${dividendCtx.length} | earningsCtx chars: ${earningsCtx.length}`);

    const text = data.content?.[0]?.text || '{"recs":[],"summary":""}';
    // Save raw response to DB for debugging
    if (text) {
        fetch(`${API}/api/log/ai_response`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ text })
        }).catch(() => {});
    }
    const cleaned = text.replace(/```json|```/g,'').trim();

    let recs = [], summary = null;
    try {
      const parsed = JSON.parse(cleaned);
      recs = Array.isArray(parsed) ? parsed : (parsed.recs || []);
      summary = Array.isArray(parsed) ? null : (parsed.summary || null);
      // Hard-truncate to prevent bloating history context on subsequent runs
      if (summary && summary.length > 600) summary = summary.slice(0, 597) + '...';
    } catch(parseErr) {
      console.warn('Direct JSON parse failed, attempting recovery:', parseErr.message);

      // Try to extract summary first (appears at end — may be truncated)
      const summaryMatchClosed = cleaned.match(/"summary"\s*:\s*"([\s\S]*?)"\s*[,}]\s*?$/);
      let summaryRaw = null;
      if (summaryMatchClosed) {
          summaryRaw = summaryMatchClosed[1];
      } else {
          // Try to grab up to the end of the (possibly truncated) string
          const summaryMatchPartial = cleaned.match(/"summary"\s*:\s*"([\s\S]*?)$/);
          if (summaryMatchPartial) {
              summaryRaw = summaryMatchPartial[1];
              // Tag it as partial so the user knows
              summaryRaw += ' … [summary truncated]';
          }
      }
      if (summaryRaw) {
          summary = summaryRaw.replace(/\\n/g,'\n').replace(/\\"/g,'"');
          if (summary.length > 600) summary = summary.slice(0, 597) + '...';
      }

      // Extract all complete rec objects using a brace-depth tracker.
      // FIX #11: This parser can miscount if string values contain literal { or } chars.
      // The prompt now instructs the model not to use { or } in string values (Pre-flight check h),
      // which eliminates that failure mode. If truncation persists, increase max_tokens first.
      const recsArrayMatch = cleaned.match(/"recs"\s*:\s*\[/);
      if(recsArrayMatch) {
        const arrayStart = cleaned.indexOf('[', recsArrayMatch.index + recsArrayMatch[0].length - 1);
        const arrayContent = cleaned.slice(arrayStart + 1);
        let depth = 0, objStart = -1, recovered = [];
        for(let i = 0; i < arrayContent.length; i++) {
          const ch = arrayContent[i];
          if(ch === '{') { if(depth === 0) objStart = i; depth++; }
          else if(ch === '}') {
            depth--;
            if(depth === 0 && objStart >= 0) {
              try {
                const obj = JSON.parse(arrayContent.slice(objStart, i + 1));
                recovered.push(obj);
              } catch {}
              objStart = -1;
            }
          }
        }
        recs = recovered;
      }

      if(!summary && recs.length === 0) {
        summary = `Response was truncated before JSON could be fully parsed (${recs.length} partial recs recovered). Try running again — if this persists the portfolio may have too many tickers for a single run.`;
      } else if(!summary) {
        summary = `Response truncated — ${recs.length} recommendation(s) were recovered. Summary unavailable.`;
      }
    }

    // ── Post-process AI recs: recompute SELL/TRIM P&L from real avg cost,
    //    drop BUY/TOP_UP recs the AI returned with non-positive expected P&L.
    // FIX #2: netProfit for SELL/TRIM is authoritatively recomputed here from actual
    //    cost basis. The AI's value is display-only and is overwritten below.
    const fees = state.settings.brokerage;
    let droppedNegEV = 0;
    const cleanedRecs = [];
    for (const r of recs) {
      const action = (r.action || '').toUpperCase();
      const isReducing = action === 'SELL' || action === 'TRIM';
      const isAdding   = action === 'BUY'  || action === 'TOP_UP';
      const qty   = Number(r.qty) || 0;
      const sellPrice = Array.isArray(r.priceRange) ? Number(r.priceRange[0]) : (Number(r.target) || null);

      if (isReducing) {
        const holding = getPortfolioHolding(r.ticker);
        if (holding && qty > 0 && sellPrice != null && !Number.isNaN(sellPrice)) {
          r.netProfit = (sellPrice - holding.avgPrice) * qty - fees;
          r.expectedProfit = (sellPrice - holding.avgPrice) * qty;
          r._costBasis = holding.avgPrice;
        }
      }

      if (isAdding) {
        // Hard guard: never show a buy/top-up the AI rated as a guaranteed loss.
        const entryHigh = Array.isArray(r.priceRange) ? Number(r.priceRange[1]) : Number(r.target);
        const target    = Number(r.target);
        const aiNet     = Number(r.netProfit);
        const targetBelowEntry = isFinite(entryHigh) && isFinite(target) && target <= entryHigh;
        if (!isFinite(aiNet) || aiNet <= 0 || targetBelowEntry) {
          droppedNegEV++;
          continue;
        }
      }

      cleanedRecs.push(r);
    }
    if (droppedNegEV > 0) {
      const note = ` [Filtered ${droppedNegEV} buy rec(s) with non-positive est. P&L]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }
    recs = cleanedRecs;

    // ── HARD CONFIDENCE FLOOR: drop any rec below 0.62 that slipped through ──
    const MIN_CONFIDENCE = 0.62;
    let lowConfDropped = 0;
    recs = recs.filter(r => {
      if ((r.confidence || 0) < MIN_CONFIDENCE) { lowConfDropped++; return false; }
      return true;
    });
    if (lowConfDropped > 0) {
      const note = ` [Dropped ${lowConfDropped} rec(s) below ${(MIN_CONFIDENCE*100).toFixed(0)}% confidence floor]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }

    // FIX #3: conviction is derived client-side — no longer required from the model.
    // Compute it here for any downstream UI that references it.
    recs = recs.map(r => ({
      ...r,
      conviction: Math.round((r.confidence || 0) * 10),
    }));

    const filteredRecs = recs.filter(r => r.action && r.action.toUpperCase() !== 'HOLD');

    // ── SAME-DAY BUY/SELL CONFLICT GUARD ──────────────────────────────────────
    const sameDayBoughtToday = new Set();
    const sameDaySoldToday   = new Set();
    for (const hist of state.recHistory) {
      if (hist.date !== todayStr() || !hist.executed) continue;
      const a = (hist.action || '').toUpperCase();
      if (a === 'BUY' || a === 'TOP_UP') sameDayBoughtToday.add(hist.ticker);
      if (a === 'SELL' || a === 'TRIM')  sameDaySoldToday.add(hist.ticker);
    }
    for (const pend of state.recommendations) {
      if (pend.date !== todayStr() || pend.status !== 'pending') continue;
      const a = (pend.action || '').toUpperCase();
      if (a === 'BUY' || a === 'TOP_UP') sameDayBoughtToday.add(pend.ticker);
      if (a === 'SELL' || a === 'TRIM')  sameDaySoldToday.add(pend.ticker);
    }
    const batchBuys  = new Set();
    const batchSells = new Set();
    for (const r of filteredRecs) {
      const a = (r.action || '').toUpperCase();
      if (a === 'BUY' || a === 'TOP_UP') batchBuys.add(r.ticker);
      if (a === 'SELL' || a === 'TRIM')  batchSells.add(r.ticker);
    }
    let sameDayConflictDropped = 0;
    const conflictFreeRecs = filteredRecs.filter(r => {
      const a = (r.action || '').toUpperCase();
      const isBuy  = a === 'BUY'  || a === 'TOP_UP';
      const isSell = a === 'SELL' || a === 'TRIM';
      if (isSell && (sameDayBoughtToday.has(r.ticker) || batchBuys.has(r.ticker))) {
        sameDayConflictDropped++;
        console.warn(`[same-day conflict] Dropping ${r.action} ${r.ticker} — BUY already present today`);
        return false;
      }
      if (isBuy && (sameDaySoldToday.has(r.ticker) || batchSells.has(r.ticker))) {
        sameDayConflictDropped++;
        console.warn(`[same-day conflict] Dropping ${r.action} ${r.ticker} — SELL already present today`);
        return false;
      }
      return true;
    });
    if (sameDayConflictDropped > 0) {
      const note = ` [Blocked ${sameDayConflictDropped} same-day BUY/SELL conflict(s) — use the 7-day window or catastrophic override only]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }
    const deconflictedRecs = conflictFreeRecs;

    const newRecs = deconflictedRecs.map((r,i) => ({
      ...r,
      id: `R-${Date.now()}-${i}`,
      status: 'pending',
      generatedAt: nowSydney(),
      date: todayStr(),
      feedback: null,
    }));

    // ── SAME-DAY DEDUP: prevent multiple TRIM or TOP_UP on the same ticker today ──
    const todayKey = todayStr();
    const alreadyActioned = new Set();
    for (const hist of state.recHistory) {
      if (hist.date === todayKey && (hist.action === 'TRIM' || hist.action === 'TOP_UP')) {
        alreadyActioned.add(`${hist.ticker}::${hist.action}`);
      }
    }
    for (const pend of state.recommendations) {
      if (pend.status === 'pending' && pend.date === todayKey &&
          (pend.action === 'TRIM' || pend.action === 'TOP_UP')) {
        alreadyActioned.add(`${pend.ticker}::${pend.action}`);
      }
    }
    const batchSeen = new Map();
    for (const r of newRecs) {
      if (r.action !== 'TRIM' && r.action !== 'TOP_UP') continue;
      const k = `${r.ticker}::${r.action}`;
      if (!batchSeen.has(k) || r.confidence > batchSeen.get(k).confidence) {
        batchSeen.set(k, r);
      }
    }
    let dupsSuppressed = 0;
    const dedupedRecs = newRecs.filter(r => {
      if (r.action !== 'TRIM' && r.action !== 'TOP_UP') return true;
      const k = `${r.ticker}::${r.action}`;
      if (alreadyActioned.has(k)) { dupsSuppressed++; return false; }
      if (batchSeen.get(k) !== r) { dupsSuppressed++; return false; }
      return true;
    });
    if (dupsSuppressed > 0) {
      const note = ` [Suppressed ${dupsSuppressed} duplicate TRIM/TOP_UP rec(s) — already actioned/pending today]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }

    // ── Strip HOLD from pending survivors ──
    const survivingPending = state.recommendations.filter(r =>
      r.status === 'pending' && r.action && r.action.toUpperCase() !== 'HOLD'
    );

    // ── MAX TRADES PER DAY CAP ──
    const todayKey2 = todayStr();
    const todayExecutedCount = state.recHistory.filter(r => r.date === todayKey2 && r.executed).length;
    const maxNew = Math.max(0, (state.settings.maxTradesPerDay || 5) - todayExecutedCount);
    let capDropped = 0;
    let cappedDedupedRecs = dedupedRecs;
    if (dedupedRecs.length > maxNew) {
      cappedDedupedRecs = dedupedRecs
        .slice()
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, maxNew);
      capDropped = dedupedRecs.length - cappedDedupedRecs.length;
    }
    if (capDropped > 0) {
      const note = ` [Capped: dropped ${capDropped} lower-confidence rec(s) — max ${state.settings.maxTradesPerDay} trades/day, ${todayExecutedCount} already executed today]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }

    state.recommendations = [...cappedDedupedRecs, ...survivingPending];

    // Build structured summary from actual recs — never rely on AI free-text for this
    const recLines = cappedDedupedRecs.map(r => {
      const reason = (r.reasoning || '').replace(/\n/g, ' ').trim().slice(0, 70);
      return `${r.ticker}: ${r.action}${reason ? ' — ' + reason : ''}`;
    });

    // Extract [system notes] appended to summary string (e.g. confidence floor drops, conflicts)
    // Filter out JSON array patterns like ["value","growth"] that the AI may dump in the summary field
    const bracketNotes = summary
      ? (summary.match(/\[[^\]]+\]/g) || []).filter(n => !/^\[["{\d]/.test(n))
      : [];

    // Extract macro + cash context from AI summary; strip calibration stats and rec enumeration
    let contextLine = '';
    if (summary) {
      // Strip from "Calibration:" to the next known section header (case-sensitive to avoid
      // matching "Wins:", "Losses:" etc. which have mixed case)
      const stripped = summary
        .replace(/Calibration:.*?(?=Macro:|Key actions:|Cash:)/s, '')
        .replace(/Calibration:.*?adjustment applied[.,]?\s*/s, '')
        .replace(/insufficient history for calibration[.,]?\s*/i, '')
        .replace(/Key actions:.*?(?=Macro:|Cash:|$)/s, '')
        .replace(/\[[^\]]+\]/g, '')
        // Remove lines that look like raw JSON (object braces, quoted keys, array wrappers)
        .split('\n')
        .filter(line => line.trim() && !/^\s*[{}\[\]"\\]/.test(line) && !/^\s*"[^"]+"\s*:/.test(line))
        .join(' ')
        .trim();
      // Skip if remaining content looks like a JSON fragment
      if (stripped && !/^\s*[{\[]/.test(stripped)) {
        contextLine = stripped.slice(0, 180).trim();
      }
    }
    // Suppress contradictory "no actionable" note when recs were actually generated
    if (recLines.length > 0 && /no actionable setup/i.test(contextLine)) {
      contextLine = '';
    }

    const allParts = [
      ...(recLines.length ? recLines : ['No actionable setups — holding cash.']),
      ...(contextLine ? [contextLine] : []),
      ...(bracketNotes.length ? [bracketNotes.join(' ')] : []),
    ];
    const structuredText = allParts.join('\n');

    state.analysisLastSummary = {
      text: structuredText,
      date: todayStr(),
      time: nowSydney(),
      recCount: cappedDedupedRecs.length,
    };
    state.analysisRunning = false;
    scheduleSave();
    toast(`Analysis done: ${cappedDedupedRecs.length} recommendation(s)`, 'success');
    showPage('recommendations');
  } catch(e) {
    state.analysisRunning = false;
    toast('Analysis error: ' + e.message, 'error');
  }
}
