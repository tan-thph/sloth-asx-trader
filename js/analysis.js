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


      const macroUserMsg = `Provide current macro analysis for ASX morning brief. Today: ${todayStr()}${liveCtx ? '. Live market data: ' + liveCtx : '. Use realistic current estimates.'}  Return only JSON.`;
      const { text: macroText } = await callClaude('macro', macroUserMsg, { noCache: true });
      const { ok: macroOk, data: macroAI } = parseClaudeJSON(macroText);
      if (macroOk && macroAI) {
        state.macroData = { ...(state.macroData || {}), ...macroAI, _source: state.macroData?._source === 'live' ? 'live' : 'ai' };
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


  // calibrationNote assembled after regime detection below (needs _activeRegime + sectors)

  // ── userMessage carries ALL dynamic/live context; systemPrompt stays fully static
  //    for stable prompt-cache hits across the entire trading day.
  const _now = new Date();
  const _month = _now.getMonth() + 1;
  const inHarvestWindow = _month >= 5 && _month <= 6;

  // ── Build rule-override block from state.analysisConfig.rules ──────────────
  const _r = state.analysisConfig.rules || {};
  const rulesCtx = (() => {
    const def = { minConfidence:0.62, minIndepFactors:3, bearCaseThreshold:0.70,
      highRiskMinConf:0.75, veryHighRiskMinConf:0.80, minRrRatio:2.0,
      stopAtrMultiple:1.5, maxPositionPct:15, maxSectorPct:30,
      sameTickerWindowDays:7, minHoldingDays:1, minChurnProfitAud:100,
      minChurnProfitPct:2, dividendYieldPremium:1.5, highConvYieldPremium:2.5,
      highVarThreshold1:-3.5, highVarThreshold2:-5.0, highDdThreshold:25,
      compositeRiskHighScore:67, compositeRiskVeryHighScore:80,
      exDivProtectDays:5, exDivFlagDays:10, cgtHoldMonthsMin:11, cgtHoldMonthsMax:12 };
    const lines = [
      `Min confidence: ${_r.minConfidence ?? def.minConfidence} | Min R:R: ${_r.minRrRatio ?? def.minRrRatio}:1 | Stop ATR: ${_r.stopAtrMultiple ?? def.stopAtrMultiple}×ATR14`,
      `Max position: ${_r.maxPositionPct ?? def.maxPositionPct}% | Max sector: ${_r.maxSectorPct ?? def.maxSectorPct}% | Min independent factors: ${_r.minIndepFactors ?? def.minIndepFactors}`,
      `Bear case required above: ${_r.bearCaseThreshold ?? def.bearCaseThreshold} conf | Same-ticker BUY→SELL window: ${_r.sameTickerWindowDays ?? def.sameTickerWindowDays} days`,
      `Anti-churn: min hold ${_r.minHoldingDays ?? def.minHoldingDays}d | min profit $${_r.minChurnProfitAud ?? def.minChurnProfitAud} OR ${_r.minChurnProfitPct ?? def.minChurnProfitPct}% of position`,
      `Dividend yield premium: ≥${_r.dividendYieldPremium ?? def.dividendYieldPremium}% (high-conv: ≥${_r.highConvYieldPremium ?? def.highConvYieldPremium}%)`,
      `VaR1d thresholds: <${_r.highVarThreshold1 ?? def.highVarThreshold1}% → qty−25%; <${_r.highVarThreshold2 ?? def.highVarThreshold2}% → qty−50% | MaxDD90d >${_r.highDdThreshold ?? def.highDdThreshold}% → mandatory stop note`,
      `Portfolio risk score: >${_r.compositeRiskHighScore ?? def.compositeRiskHighScore} → raise min conf to ${_r.highRiskMinConf ?? def.highRiskMinConf}; >${_r.compositeRiskVeryHighScore ?? def.compositeRiskVeryHighScore} → no new BUYs (min conf ${_r.veryHighRiskMinConf ?? def.veryHighRiskMinConf} for TOP_UP)`,
      `Ex-div protection: no TRIM/SELL within ${_r.exDivProtectDays ?? def.exDivProtectDays} days; flag within ${_r.exDivFlagDays ?? def.exDivFlagDays} days`,
      `CGT discount window: flag positions held ${_r.cgtHoldMonthsMin ?? def.cgtHoldMonthsMin}–${_r.cgtHoldMonthsMax ?? def.cgtHoldMonthsMax} months`,
    ];
    const block = `\n\nACTIVE RULE OVERRIDES (apply these thresholds — override system prompt defaults):\n${lines.join('\n')}`;
    return _r.customRules ? block + `\n\nCUSTOM RULES (apply in addition to all above):\n${_r.customRules}` : block;
  })();

  const userMessage = `Date: ${todayStr()} | Time: ${nowSydney()} | TAX_LOSS_HARVEST_ACTIVE: ${inHarvestWindow}
Account settings: brokerage $${state.settings.brokerage}/trade (round-trip $${state.settings.brokerage * 2}) | max ${state.settings.maxTradesPerDay} trades/day | min trade $${state.settings.minTradeSize}

LIVE PORTFOLIO STATE:
Holdings: ${portfolioJson}
Cash available: $${fmt(state.cash)} | Total invested: $${fmt(totalCost())} | Net worth: $${fmt(totalNetWorth())}
RBA Cash Rate: ${state.rbaRate.toFixed(2)}% (${state.rbaRateSource}${state.rbaRateDate ? ', ' + state.rbaRateDate : ''})
${recCtx}${pendingFeedbackCtx}__CALIBRATION_PLACEHOLDER__${macroCtx}${newsOutlook}${annCtx}${marketViewCtx}${extraTickersCtx}${dividendCtx}${earningsCtx}${riskCtx}${indicatorCtx}${rulesCtx}

TASK:
1. Apply any CALIBRATION adjustments above to confidence scores before output.
2. Assess macro regime — Rule 12: if sentiment = "bearish" AND bullish < 35, block all BUY/TOP_UP.
3. For every holding and watchlist ticker, run the Section 3 multi-factor framework. Exclude any ticker with < 3 independent non-technical factors from recs[].
4. For each candidate rec: compute priceRange, target (next S/R), stopLoss (1.5×ATR), qty, scenarios (p sums to 1.0), invalidationCondition (must include a measurable value), bearCase (if conf ≥ 0.70), factorsUsed (≥ 3 specific data points).
5. Apply Section 7 pre-flight checks. Fix all failures before writing JSON.
6. Return JSON only — no preamble, no markdown.
PROMPT_VERSION: ${typeof PROMPT_VERSION !== 'undefined' ? PROMPT_VERSION : 'unknown'}`;

  // ── Wait for macro to finish, then classify regime ──────────────────────────
  await macroPromise;
  const _regimeResult = await fetchAndClassifyRegime();
  const _activeRegime = _regimeResult.regime;
  if (_activeRegime && _activeRegime !== 'unknown') state._lastRegime = _activeRegime;

  // Regime gate: panic → no new positions, skip AI call
  if (_activeRegime === 'panic') {
    toast('PANIC regime detected — no new positions. Holding cash.', 'error');
    state.analysisRunning = false;
    state.analysisLastSummary = {
      text: `PANIC regime (VIX extreme + breadth collapse). No new positions. Cash vs RBA rate ${state.rbaRate?.toFixed(2) ?? '?'}%.`,
      date: todayStr(), recCount: 0,
    };
    renderPage();
    return;
  }

  toast('Running AI trade analysis...','info');

  // ── Smart calibration — fetched after regime is known, filtered to context ──
  // Derive sectors + tickers from current portfolio for per-ticker memory branch.
  const _portfolioSectors = [...new Set(mergedPortfolio().map(h => h.sector).filter(Boolean))];
  const _portfolioTickers = mergedPortfolio().map(h => h.ticker).filter(Boolean);
  const _calibrationNote = typeof fetchCalibrationBlock === 'function'
    ? await fetchCalibrationBlock(_activeRegime, _portfolioSectors, _portfolioTickers)
    : '';

  // ── Internal Debate (optional — Ollama local model) ─────────────────────────
  // Respects state.debate.aggression: 'none' skips, 'light' = 3 tickers, 'full' = 8.
  // Results go into user message (not system prompt) to preserve prompt-cache hits.
  // debate_summary (≤200 chars) is stored in ai_learning_events for later review.
  let _debatePreamble = '';
  let _debateResults  = {};  // ticker → debate result; passed to logRecsToLearningLoop
  if (typeof fetchDebateBatch === 'function' && state.serverOk
      && (state.debate?.aggression || 'light') !== 'none') {
    try {
      const { maxTickers } = typeof _aggressionParams === 'function'
        ? _aggressionParams() : { maxTickers: 3 };
      const _debateTickers = mergedPortfolio()
        .map(h => h.ticker)
        .filter(t => state.liveSignals[t] && !state.liveSignals[t].error)
        .slice(0, maxTickers);
      if (_debateTickers.length) {
        const _dStatus = await debateStatus();
        if (_dStatus.available) {
          const _debModel = typeof preferredDebateModel === 'function'
            ? preferredDebateModel(_dStatus.models) : '?';
          toast(`🤖 ${_debModel} debating ${_debateTickers.join(', ')}…`, 'info');
          // D7: build action map so debate engine uses exit-biased prompts for SELL/TRIM
          const _debateActions = {};
          for (const t of _debateTickers) {
            const rec = (state.recommendations || []).find(r => r.ticker === t);
            if (rec) _debateActions[t] = rec.action || 'BUY';
          }
          const _debateT0 = Date.now();
          _debateResults  = await fetchDebateBatch(_debateTickers, undefined, { actions: _debateActions });
          _debatePreamble = buildDebatePreamble(_debateResults);

          const _debated  = Object.values(_debateResults).filter(d => d?.ok);
          const _cached   = _debated.filter(d => d._fromCache).length;
          const _fresh    = _debated.length - _cached;
          const _debMs    = Date.now() - _debateT0;
          if (_debated.length > 0) {
            const _cacheNote = _cached > 0 ? ` (${_cached} cached, ${_fresh} fresh)` : '';
            toast(`🤖 Debate done in ${(_debMs/1000).toFixed(1)}s${_cacheNote} — ${_debated.length} ticker(s) ready`, 'success');
            console.log(`[Debate] ${_debated.length} ticker(s) | ${_fresh} fresh, ${_cached} cached | ${_debMs}ms`);
          } else {
            console.log('[Debate] No successful debates — skipping preamble');
          }
        }
      }
    } catch (_debateErr) {
      console.warn('[Debate] skipped:', _debateErr.message);
    }
  }

  // ── Assemble dynamic system prompt (core cached + regime/date modules) ──────
  const _systemArray = typeof buildSystemArray === 'function'
    ? buildSystemArray({ regime: _activeRegime, portfolio: mergedPortfolio() })
    : [{ type: 'text', text: ANALYSIS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];

  // Inject calibration, regime, and (optional) debate into the final user message
  const regimeCtx = _activeRegime && _activeRegime !== 'unknown'
    ? `\nACTIVE_REGIME: ${_activeRegime} (confidence: ${(_regimeResult.confidence * 100).toFixed(0)}%)`
    : '';

  const fullUserMessage = userMessage
    .replace('__CALIBRATION_PLACEHOLDER__', _calibrationNote) + regimeCtx + _debatePreamble;

  try {
    const { text, usage: _usage } = await callClaude('portfolio', fullUserMessage, {
      systemArray: _systemArray,
      maxTokens: 6000,
    });

    console.log(`[Token audit] recHistory sent: ${recentRecs.length} entries (last5=${last5.length} withPnl=${withPnl.length} withFeedback=${withFeedback.length})`);
    console.log(`[Token audit] indicatorCtx chars: ${indicatorCtx.length} | macroCtx chars: ${macroCtx.length} | divCtx chars: ${dividendCtx.length} | earningsCtx chars: ${earningsCtx.length}`);

    // Save raw response to DB for debugging
    if (text) {
      fetch(`${API}/api/log/ai_response`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({ text })
      }).catch(() => {});
    }

    // ── Parse with safe parser, fall back to brace-depth recovery on failure ──
    let recs = [], summary = null;
    const _parsed = parseClaudeJSON(text);
    if (_parsed.ok) {
      const d = _parsed.data;
      recs    = Array.isArray(d) ? d : (d.recs || []);
      summary = Array.isArray(d) ? null : (d.summary || null);
      if (summary && summary.length > 600) summary = summary.slice(0, 597) + '...';
    } else {
      console.warn('parseClaudeJSON failed, attempting brace-depth recovery:', _parsed.error);
      const cleaned = (text || '').replace(/```json|```/g, '').trim();

      // Try to extract summary
      const summaryMatchClosed = cleaned.match(/"summary"\s*:\s*"([\s\S]*?)"\s*[,}]\s*?$/);
      let summaryRaw = summaryMatchClosed ? summaryMatchClosed[1] : null;
      if (!summaryRaw) {
        const summaryMatchPartial = cleaned.match(/"summary"\s*:\s*"([\s\S]*?)$/);
        if (summaryMatchPartial) summaryRaw = summaryMatchPartial[1] + ' … [summary truncated]';
      }
      if (summaryRaw) {
        summary = summaryRaw.replace(/\\n/g, '\n').replace(/\\"/g, '"');
        if (summary.length > 600) summary = summary.slice(0, 597) + '...';
      }

      // Extract complete rec objects via brace-depth tracker
      const recsArrayMatch = cleaned.match(/"recs"\s*:\s*\[/);
      if (recsArrayMatch) {
        const arrayStart = cleaned.indexOf('[', recsArrayMatch.index + recsArrayMatch[0].length - 1);
        const arrayContent = cleaned.slice(arrayStart + 1);
        let depth = 0, objStart = -1, recovered = [];
        for (let i = 0; i < arrayContent.length; i++) {
          const ch = arrayContent[i];
          if (ch === '{') { if (depth === 0) objStart = i; depth++; }
          else if (ch === '}') {
            depth--;
            if (depth === 0 && objStart >= 0) {
              try { recovered.push(JSON.parse(arrayContent.slice(objStart, i + 1))); } catch {}
              objStart = -1;
            }
          }
        }
        recs = recovered;
      }

      if (!summary && recs.length === 0) {
        summary = `Response was truncated before JSON could be fully parsed (${recs.length} partial recs recovered). Try running again.`;
      } else if (!summary) {
        summary = `Response truncated — ${recs.length} recommendation(s) recovered. Summary unavailable.`;
      }
    }

    // ── Quant Engine post-processing: override AI sizing with deterministic math (3.1) ──
    // computeTradeParams() replaces AI-computed qty/stopLoss/rrRatio/riskAUD/rewardAUD
    // for BUY/TOP_UP recs. The AI's confidence (winProb proxy) drives Kelly sizing.
    if (typeof computeTradeParams === 'function') {
      const _portfolioCtx = {
        allocatedCash: state.cash,
        portfolioValue: portfolioValue(),
        brokerage: state.settings.brokerage,
        rbaRate: state.rbaRate || 4.35,
      };
      recs = recs.map(r => {
        const action = (r.action || '').toUpperCase();
        if (action !== 'BUY' && action !== 'TOP_UP') return r;
        const signals = state.liveSignals[r.ticker];
        if (!signals || signals.error) return r;
        const qt = computeTradeParams(r.ticker, signals, _portfolioCtx, {
          winProb: r.confidence ?? 0.6,
          expectedTimeToTarget: r.holdDays ?? 10,
          priceRange: r.priceRange,
          target: r.target,
        });
        if (!qt.ok) return r;  // keep AI values if quant rejects
        return {
          ...r,
          qty: qt.qty,
          stopLoss: qt.stopLoss,
          target: qt.target,
          rrRatio: qt.rrRatio,
          riskAUD: qt.riskAUD,
          rewardAUD: qt.rewardAUD,
          _quantEngine: true,
          _constraintBinding: qt.constraintBinding,
        };
      });
    }

    // ── Apply regime size modifiers ─────────────────────────────────────────────
    if (typeof applyRegimeModifiers === 'function' && _activeRegime && _activeRegime !== 'unknown') {
      recs = recs.map(r => {
        const action = (r.action || '').toUpperCase();
        return (action === 'BUY' || action === 'TOP_UP') ? applyRegimeModifiers(r, _activeRegime) : r;
      });
      // Drop recs hard-blocked by regime (e.g. panic → sizeMult=0)
      const blocked = recs.filter(r => r._regimeBlocked).length;
      recs = recs.filter(r => !r._regimeBlocked);
      if (blocked > 0) {
        const note = ` [Blocked ${blocked} BUY/TOP_UP rec(s) — regime ${_activeRegime} disallows new exposure]`;
        summary = (summary ? summary + ' ' : '') + note.trim();
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

    // ── HARD CONFIDENCE FLOOR: drop any rec below threshold that slipped through ──
    const MIN_CONFIDENCE = state.analysisConfig.rules?.minConfidence ?? 0.62;
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
    // Fire desktop notification for high-conviction recs
    if (typeof alertHighConviction === 'function') alertHighConviction(cappedDedupedRecs);
    // Log recommendations to the Learning Loop backend (fire-and-forget)
    logRecsToLearningLoop(cappedDedupedRecs, _activeRegime, _debateResults);
    showPage('recommendations');
  } catch(e) {
    state.analysisRunning = false;
    toast('Analysis error: ' + e.message, 'error');
  }
}

// ── Learning Loop: log recommendations to backend ────────────────────────────
// Fire-and-forget: called after cappedDedupedRecs is finalised.
// Stores _learningId on each rec so markExecuted / markSkipped can update it.
// debates: optional map of ticker → debate result from fetchDebateBatch()
async function logRecsToLearningLoop(recs, regime, debates = {}) {
  if (!state.serverOk || !recs || !recs.length) return;
  const pv = typeof PROMPT_VERSION !== 'undefined' ? PROMPT_VERSION : 'unknown';

  // Lightweight prompt_hash — first 12 chars of a djb2-style hash over pv + regime + today
  const _hashInput = `${pv}|${regime || ''}|${todayStr()}`;
  let _hash = 5381;
  for (let i = 0; i < _hashInput.length; i++) {
    _hash = ((_hash << 5) + _hash) ^ _hashInput.charCodeAt(i);
    _hash >>>= 0; // keep unsigned
  }
  const _promptHash = _hash.toString(16).padStart(8, '0').slice(0, 12);

  // Capture market context once per analysis run
  const _mktCtx = { rba_rate: typeof state.rbaRate === 'number' ? state.rbaRate : null };

  for (const r of recs) {
    if (r._learningId) continue;  // already logged — idempotency guard
    try {
      const entry = Array.isArray(r.priceRange) ? r.priceRange[0] : null;
      let rrRatio = null;
      if (entry && r.stopLoss && r.target && entry !== r.stopLoss) {
        rrRatio = Math.abs((r.target - entry) / (entry - r.stopLoss));
      }
      const holding = (typeof mergedPortfolio === 'function' ? mergedPortfolio() : [])
        .find(h => h.ticker === r.ticker);

      // debate_summary: condensed bull/bear for this ticker (if debate was run)
      const _debate = debates[r.ticker];
      const _debateSummary = (typeof buildDebateSummary === 'function' && _debate?.ok)
        ? buildDebateSummary(_debate)
        : null;

      // entry_signals_json: compact snapshot of 6 key signals at log time for postmortem quality
      const _sigs = state.liveSignals?.[r.ticker];
      const entry_signals_json = _sigs ? JSON.stringify({
        rsi_14:    _sigs.rsi_14   ?? null,
        bb_pct_b:  _sigs.bb_pct_b ?? null,
        adx_14:    _sigs.adx      ?? null,
        atr_pct:   _sigs.atr_pct  ?? null,
        return_5d: _sigs.return_5d  ?? null,
        return_20d: _sigs.return_20d ?? null,
      }) : null;

      // L6: track synthesizer prediction for calibration feedback over time
      const debate_synthesis_winner = _debate?.synthesis?.winner ?? null;

      const payload = {
        event_type:          'recommendation',
        ticker:              r.ticker,
        regime:              regime || null,
        prompt_version:      pv,
        prompt_hash:         _promptHash,
        agent_type:          'portfolio-scanner',
        ai_confidence:       r.confidence ?? null,
        ensemble_confidence: r.ensembleConfidence ?? null,
        recommendation:      r.action,
        rationale_summary:   r.reasoning ? r.reasoning.slice(0, 400) : null,
        suggested_stop:      r.stopLoss ?? null,
        suggested_target:    r.target ?? null,
        rr_ratio:            rrRatio != null ? +rrRatio.toFixed(2) : null,
        sector:              r.sector || holding?.sector || null,
        was_executed:             false,
        market_context:           _mktCtx,
        debate_summary:           _debateSummary,
        entry_signals_json,
        debate_synthesis_winner,
      };
      const resp = await fetch(`${API}/api/learning/log`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (resp.ok) {
        const result = await resp.json();
        if (result.id) r._learningId = result.id;
      }
    } catch (_) { /* non-critical — never break analysis */ }
  }
}
