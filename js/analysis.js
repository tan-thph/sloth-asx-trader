// ============================================================
// PIPELINE HELPERS — pure functions, no I/O (testable in Vitest)
// ============================================================

/**
 * Apply correlation-based size reduction to BUY/TOP_UP recs.
 * @param {Array}  recs            - recommendation objects with {action, ticker, qty, riskAUD}
 * @param {Object} corrMatrix      - {TICKER: {OTHER_TICKER: correlation_coefficient}}
 * @param {Array}  portfolioTickers - tickers of existing holdings
 * @returns {Array} recs with qty/riskAUD adjusted and _corrNote set where applicable
 */
function _applyCorrSizing(recs, corrMatrix, portfolioTickers) {
  return recs.map(function(r) {
    if (!['BUY','TOP_UP'].includes((r.action||'').toUpperCase())) return r;
    var tkrRow = corrMatrix[r.ticker] || {};
    var maxCorr = 0, maxCorrTicker = null;
    for (var i = 0; i < portfolioTickers.length; i++) {
      var h = portfolioTickers[i];
      if (h === r.ticker) continue;
      var c = Math.abs(tkrRow[h] || 0);
      if (c > maxCorr) { maxCorr = c; maxCorrTicker = h; }
    }
    if (maxCorr > 0.85) {
      var mult = 0.5;
      return Object.assign({}, r, {
        qty: Math.max(1, Math.round(r.qty * mult)),
        riskAUD: r.riskAUD ? Math.round(r.riskAUD * mult) : r.riskAUD,
        _corrNote: 'corr ' + maxCorr.toFixed(2) + ' with ' + maxCorrTicker + ' — size halved'
      });
    } else if (maxCorr > 0.7) {
      var mult2 = 0.7;
      return Object.assign({}, r, {
        qty: Math.max(1, Math.round(r.qty * mult2)),
        riskAUD: r.riskAUD ? Math.round(r.riskAUD * mult2) : r.riskAUD,
        _corrNote: 'corr ' + maxCorr.toFixed(2) + ' with ' + maxCorrTicker + ' — size −30%'
      });
    }
    return r;
  });
}

/**
 * Apply heat-budget gate to BUY/TOP_UP recs.
 * Recs that fit within the remaining budget pass through unchanged.
 * Recs that partially fit are scaled down (_budgetScaled).
 * Recs that don't fit at all are marked _budgetBlocked (qty=0).
 *
 * @param {Array}  recs       - recs to process
 * @param {number} budgetAUD  - total $ at-risk budget
 * @param {number} consumed   - $ already consumed by pre-existing pending recs
 * @param {string} source     - label for _budgetNote ('user' | 'regime:X')
 * @returns {{ recs: Array, scaled: number, blocked: number }}
 */
function _applyHeatBudget(recs, budgetAUD, consumed, source) {
  var scaledCount = 0, blockedCount = 0;
  var out = recs.map(function(r) {
    var action = (r.action || '').toUpperCase();
    if ((action !== 'BUY' && action !== 'TOP_UP') || !(r.riskAUD > 0)) return r;

    var remaining = budgetAUD - consumed;

    if (r.riskAUD <= remaining) {
      consumed += r.riskAUD;
      return r;
    }

    if (remaining <= 0) {
      blockedCount++;
      return Object.assign({}, r, { qty: 0, _budgetBlocked: true,
        _budgetNote: 'Heat budget exhausted ($' + budgetAUD.toFixed(0) + ' limit, $0 remaining) [' + source + ']' });
    }

    var riskPerShare = r.riskAUD / r.qty;
    var scaledQty = Math.floor(remaining / riskPerShare);
    if (scaledQty < 1) {
      blockedCount++;
      return Object.assign({}, r, { qty: 0, _budgetBlocked: true,
        _budgetNote: 'Heat budget: $' + remaining.toFixed(0) + ' remaining < 1-share risk ($' + riskPerShare.toFixed(0) + ') [' + source + ']' });
    }
    scaledCount++;
    var scaledRisk = +(scaledQty * riskPerShare).toFixed(2);
    consumed += scaledRisk;
    return Object.assign({}, r, { qty: scaledQty, riskAUD: scaledRisk, _budgetScaled: true,
      _budgetNote: 'Heat budget: $' + remaining.toFixed(0) + ' of $' + budgetAUD.toFixed(0) + ' remaining [' + source + ']' });
  });
  return { recs: out, scaled: scaledCount, blocked: blockedCount };
}

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
          mergeLiveMacro(d);   // merge — never wipe the persisted AI brief fields
          const lines = [];
          if(d.sp500)    lines.push(`S&P500: ${fmt(d.sp500.value)} (${fmtp(d.sp500.change_pct)})`);
          if(d.asx200)   lines.push(`ASX200: ${fmt(d.asx200.value)} (${fmtp(d.asx200.change_pct)})`);
          if(d.gold)     lines.push(`Gold: ${fmt(d.gold.value)} (${fmtp(d.gold.change_pct)})`);
          if(d.aud_usd)  lines.push(`AUD/USD: ${fmt(d.aud_usd.value,4)} (${fmtp(d.aud_usd.change_pct)})`);
          if(d.vix)      lines.push(`VIX: ${fmt(d.vix.value)}`);
          if(d.iron_ore) lines.push(`Iron ore: ${fmt(d.iron_ore.value)} (${fmtp(d.iron_ore.change_pct)})`);
          if(d.oil)      lines.push(`Oil: ${fmt(d.oil.value)} (${fmtp(d.oil.change_pct)})`);
          if(d.us10y)    lines.push(`US10Y: ${fmt(d.us10y.value,3)}%`);
          if(d.copper)   lines.push(`Copper: ${fmt(d.copper.value)} (${fmtp(d.copper.change_pct)})`);
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

  // Macro brief must be resolved BEFORE any prompt context is built. It was
  // previously awaited only at regime-classification time — after macroCtx and
  // the user message were already assembled — so the first analysis of the day
  // shipped without (or with yesterday's) TODAY'S MACRO BRIEF section.
  await macroPromise;

  // ── Step 2b: fetch portfolio risk metrics ───────────────────────────────────
  // Run in parallel with the rest of context building — non-blocking failure.
  // §9.3: includes watchlist tickers so the correlation matrix covers BUY
  // candidates vs existing holdings (CorrToHoldings prompt context).
  let _riskMetrics = {};   // {TICKER: {var_95, cvar_95, max_drawdown, beta, sharpe, volatility_ann}}
  let _riskComposite = null; // portfolio-level weighted values
  let _corrMatrixPre = {}; // §9.3: correlation matrix captured pre-prompt (bare tickers)
  if (state.serverOk && portfolioTickers.length) {
    try {
      const rf = state.rbaRate || 4.35;
      const riskResp = await fetch(`${API}/api/risk?tickers=${[...new Set(allTickers)].join(',')}&rf=${rf}`);
      if (riskResp.ok) {
        const rd = await riskResp.json();
        _riskMetrics = rd.metrics || {};
        _corrMatrixPre = rd.correlation || {};
        window._lastCorrMatrix = _corrMatrixPre;   // logRecsToLearningLoop reads this
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

  // ── Portfolio sector allocation summary ──────────────────────────────────
  // Computed here so it sits just above the per-ticker indicator block.
  const sectorAllocCtx = (() => {
    const smap = {};
    const pv = portfolioValue();
    if (!pv) return '';
    for (const h of mergedPortfolio()) {
      const sec = h.sector || 'Other';
      smap[sec] = (smap[sec] || 0) + h.shares * (h.currentPrice || 0);
    }
    if (!Object.keys(smap).length) return '';
    const parts = Object.entries(smap)
      .sort((a, b) => b[1] - a[1])
      .map(([sec, val]) => `${sec}=${(val / pv * 100).toFixed(0)}%`);
    return `\n\nPORTFOLIO SECTOR ALLOCATION: ${parts.join(', ')}`;
  })();

  // Sector ETF key lookup for relative-strength computation
  const _SECTOR_TO_ETF = {
    'Materials': 'xmj', 'Financials': 'xfj',
    'Health Care': 'xhj', 'Healthcare': 'xhj',
    'Energy': 'xej', 'Real Estate': 'xrj', 'RealEstate': 'xrj',
  };

  // _isCandidate — Tier 1 (full block) when ticker has an active setup; Tier 2 (compact) otherwise
  const _isCandidate = (s, t) => {
    if (!s) return false;
    const rsi = s.rsi_14 ?? 50;
    const bbPctB = s.bb_pct_b ?? 0.5;
    const score = s.score ?? 0;
    const unrealisedPnlPct = (() => {
      const h = mergedPortfolio().find(h => h.ticker === t);
      if (!h || !h.avgPrice) return 0;
      const livePrice = state.liveSignals?.[t]?.current_price ?? h.currentPrice;
      return ((livePrice / h.avgPrice) - 1) * 100;
    })();
    const preEarnings = s.pre_earnings_risk === true;
    const volSpike = (s.volume_z_score ?? 0) > 2.5;
    const isExtra = extraTickers.includes(t);
    return isExtra
      || rsi < 38
      || rsi > 68
      || bbPctB < 0.12
      || bbPctB > 0.88
      || score >= 65
      || score <= 30
      || preEarnings
      || volSpike
      || unrealisedPnlPct < -8
      || unrealisedPnlPct > 25;
  };

  // Build indicator context (full detail per ticker)
  let indicatorCtx = '';
  const loaded = allTickers.filter(t=>state.liveSignals[t]&&!state.liveSignals[t].error);
  if(loaded.length) {
    // ASX200 5d return for relative-strength baseline (from macro data)
    const _asx200_5d = state.macroData?.asx200_5d_return ?? null;

    indicatorCtx = sectorAllocCtx + '\n\nLIVE TECHNICAL DATA (yfinance, real-time):\n' + loaded.map(t=>{
      const s  = state.liveSignals[t];
      const f  = s.fundamentals || {};
      const sr = s.support_resistance || {};
      const inPortfolio = portfolioTickers.includes(t);

      // ── Trend signal alignment (5/7 = 5 of 7 signals bullish) ──────────────
      const tsVals  = Object.values(s.trend_signals || {});
      const tsBull  = tsVals.filter(v => v === true).length;
      const tsTotal = tsVals.filter(v => v !== null && v !== undefined).length;
      const tsLabel = tsTotal > 0 ? `(${tsBull}/${tsTotal}signals)` : '';

      // ── MACD histogram direction ─────────────────────────────────────────────
      const macdDir = s.macd_hist_prev != null
        ? (s.macd_hist > s.macd_hist_prev ? '↑expanding' : '↓contracting')
        : '';

      // ── Volatility regime: current 20d vol vs 60d baseline ──────────────────
      const volRatio  = (s.hist_vol_20 && s.hist_vol_60)
        ? s.hist_vol_20 / s.hist_vol_60 : null;
      const volRegime = volRatio == null ? '' :
        volRatio > 1.2 ? 'ELEVATED' : volRatio < 0.8 ? 'COMPRESSED' : 'NORMAL';

      // ── Donchian channel position in range (0%=20d low, 100%=20d high) ──────
      const donchRange = (s.donchian_upper && s.donchian_lower && s.donchian_upper !== s.donchian_lower)
        ? (s.current_price - s.donchian_lower) / (s.donchian_upper - s.donchian_lower) * 100
        : null;

      // ── Relative strength vs ASX200 and sector ETF ──────────────────────────
      const rsAlpha = (s.return_5d != null && _asx200_5d != null)
        ? (s.return_5d - _asx200_5d).toFixed(1) : null;
      const sectorKey = _SECTOR_TO_ETF[f.sector || ''] || null;
      const sectorRet5d = sectorKey ? (state.macroData?.sectors?.[sectorKey]?.return_5d ?? null) : null;
      const sectorAlpha = (s.return_5d != null && sectorRet5d != null)
        ? (s.return_5d - sectorRet5d).toFixed(1) : null;

      // ── Analyst upside/downside vs current price ─────────────────────────────
      const analystUpside = (f.analyst_target && s.current_price)
        ? ((f.analyst_target / s.current_price - 1) * 100).toFixed(1) : null;

      // ── Nearest S/R pivot proximity flag ────────────────────────────────────
      // Raw pivot levels (R2/R1/Pivot/S1/S2) are ~50 tokens each and not well
      // interpreted by LLMs as chart zones. Pre-compute the nearest level and
      // its distance from current price instead (~15 tokens, high signal quality).
      const nearPivot = (() => {
        const price = s.current_price;
        if (!price || !sr) return '';
        const levels = [
          { name: 'R2', v: sr.r2 }, { name: 'R1', v: sr.r1 },
          { name: 'Pivot', v: sr.pivot },
          { name: 'S1', v: sr.s1 }, { name: 'S2', v: sr.s2 },
        ].filter(l => l.v != null);
        if (!levels.length) return '';
        const nearest = levels.reduce((best, l) =>
          Math.abs(l.v - price) < Math.abs(best.v - price) ? l : best
        );
        const pct = ((nearest.v - price) / price * 100).toFixed(1);
        return `, NearPivot:${nearest.name}(${pct > 0 ? '+' : ''}${pct}%)`;
      })();

      // §9.3: top correlations to existing holdings — CONTEXT for thesis
      // orthogonality (cite in factorsUsed). The numeric response stays
      // engine-side (qty −30%/−50% at |ρ|>0.70/0.85) per the v10 architecture.
      const corrLine = (() => {
        const rowC = _corrMatrixPre[t];
        if (!rowC) return '';
        const pairs = portfolioTickers
          .filter(h => h !== t && typeof rowC[h] === 'number' && Math.abs(rowC[h]) >= 0.60)
          .map(h => ({ h, c: rowC[h] }))
          .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
          .slice(0, 3);
        if (!pairs.length) return '';
        return `\n  CorrToHoldings: ${pairs.map(p => `${p.h}:${p.c.toFixed(2)}`).join(' ')}`;
      })();

      const volSpikeFlag = (s.volume_z_score ?? 0) > 3 ? ' ⚡VOLSPIKE' : '';
      if (!_isCandidate(s, t)) {
        // Tier 2: compressed 1-line summary for stable holds
        const trend = s.trend_direction || 'neutral';
        const rsiTier2 = s.rsi_14?.toFixed(0) ?? '?';
        const scoreTier2 = s.score?.toFixed(0) ?? '?';
        return `\n[${t}]${volSpikeFlag}${inPortfolio ? '' : ' ★WATCHLIST★'} $${s.current_price ?? '?'} | RSI=${rsiTier2} | score=${scoreTier2} | trend=${trend} | no active setup`;
      }
      // Tier 1: full indicator block
      return `\n[${t}]${volSpikeFlag}${inPortfolio?'':' ★WATCHLIST★'}
  Price=$${s.current_price} | Signal=${s.composite_signal} (${(s.confidence*100).toFixed(0)}% conf) | Trend=${s.trend_direction}${tsLabel} | ADX=${s.adx?.toFixed(1)} (${s.trend_strength})
  Momentum: RSI14=${s.rsi_14?.toFixed(1)}, RSI9=${s.rsi_9?.toFixed(1)}, MACDhist=${s.macd_hist?.toFixed(4)}${macdDir?` ${macdDir}`:''}, ROC10=${s.roc_10?.toFixed(2)}% ROC21=${s.roc_21?.toFixed(2)}%, Stoch%K=${s.stoch_k?.toFixed(1)}/%D=${s.stoch_d?.toFixed(1)}, CCI=${s.cci?.toFixed(1)}, MFI=${s.mfi?.toFixed(1)}, WillR=${s.williams_r?.toFixed(1)}
  Trend: SMA20=$${s.sma_20?.toFixed(3)}, SMA50=${s.sma_50?'$'+s.sma_50.toFixed(3):'n/a'}, SMA200=${s.sma_200?'$'+s.sma_200.toFixed(3):'n/a'}, EMA12=$${s.ema_12?.toFixed(3)}, EMA26=$${s.ema_26?.toFixed(3)}
  Bollinger: Upper=$${s.bb_upper?.toFixed(3)}, Mid=$${s.bb_mid?.toFixed(3)}, Lower=$${s.bb_lower?.toFixed(3)}, %B=${s.bb_pct_b!=null?(s.bb_pct_b*100).toFixed(0)+'%':'n/a'}, Width=${s.bb_bandwidth?.toFixed(1)}%${donchRange!=null?`, DonchPos=${donchRange.toFixed(0)}%`:''}
  Volatility: ATR=$${s.atr_14?.toFixed(3)} (${s.atr_pct?.toFixed(1)}%), HistVol20d=${s.hist_vol_20?.toFixed(1)}%ann${s.hist_vol_60?` 60d:${s.hist_vol_60.toFixed(1)}% regime:${volRegime}`:''}, Keltner=${s.keltner_lower?.toFixed(3)}-${s.keltner_upper?.toFixed(3)}
  Volume: Today=${s.volume_today?.toLocaleString()}, Avg20=${s.volume_avg_20?.toLocaleString()}, Ratio=${s.volume_ratio?.toFixed(2)}x, VZ=${s.volume_z_score?.toFixed(1)}σ, OBV=${s.obv_trend}, VWAP20=$${s.vwap_20d?.toFixed(3)} (price ${s.price_vs_vwap})${nearPivot}
  Returns: 1D=${s.return_1d?.toFixed(2)}%, 5D=${s.return_5d?.toFixed(2)}%, 20D=${s.return_20d?.toFixed(2)}%, 60D=${s.return_60d?.toFixed(2)}%${s.return_90d!=null?` 90D:${s.return_90d.toFixed(2)}%`:''}${rsAlpha!=null?` vs.ASX200:${rsAlpha>0?'+':''}${rsAlpha}pp`:''}${sectorAlpha!=null?` vs.Sector:${sectorAlpha>0?'+':''}${sectorAlpha}pp`:''}${s.high_60d!=null?` | Range60d: hi=$${s.high_60d.toFixed(3)} lo=$${s.low_60d?.toFixed(3)||'?'}`  :''}
  Fundamentals: PE=${f.pe_ratio?.toFixed(1)||'n/a'}, FwdPE=${f.forward_pe?.toFixed(1)||'n/a'}, PB=${f.pb_ratio?.toFixed(2)||'n/a'}, DivYield=${f.dividend_yield?(f.dividend_yield*100).toFixed(2)+'%':'n/a'}, Beta=${f.beta?.toFixed(2)||'n/a'}, ROE=${f.roe?(f.roe*100).toFixed(1)+'%':'n/a'}, OpMgn=${f.operating_margin!=null?(f.operating_margin*100).toFixed(1)+'%':'n/a'}, D/E=${f.debt_to_equity?.toFixed(1)||'n/a'}, RevGrowth=${f.revenue_growth!=null?(f.revenue_growth*100).toFixed(1)+'%':'n/a'}, FCFYield=${(f.free_cashflow&&f.market_cap)?((f.free_cashflow/f.market_cap)*100).toFixed(1)+'%':'n/a'}${f.short_pct_float!=null?`, Short=${(f.short_pct_float*100).toFixed(1)}%float`:''}
  52W: High=$${f['52w_high']?.toFixed(3)||'n/a'}, Low=$${f['52w_low']?.toFixed(3)||'n/a'}, FromHigh=${f.pct_from_52w_high?.toFixed(1)||'n/a'}%${analystUpside!=null?`, AnalystUpside=${analystUpside>0?'+':''}${analystUpside}%`:''}, Analyst=${f.analyst_recommendation||'n/a'} (target $${f.analyst_target?.toFixed(2)||'n/a'})
  BuySignals: ${(s.buy_signals||[]).join(', ')||'none'} | SellSignals: ${(s.sell_signals||[]).join(', ')||'none'}${corrLine}`;
    }).join('\n');
  }

  // ── Helper: days held since earliest open BUY/TOP_UP for this ticker ──────
  // Journal dates are DD-MM-YYYY. `new Date('09-06-2026')` reads MM-DD → a
  // FUTURE date → negative daysHeld (the ANZ −87 / EVN −117 anomaly in the
  // 2026-06-11 logs, which corrupted Claude's CGT-window reasoning). Parse via
  // parseDate() (DD-MM aware) and compare as timestamps, not strings — a
  // lexicographic compare on day-first dates picks the wrong "earliest" too.
  function _daysHeld(ticker) {
    const buys = (state.tradeJournal || []).filter(t =>
      t.ticker === ticker &&
      (t.action === 'BUY' || t.action === 'TOP_UP') &&
      !t.closeDate && t.date
    );
    if (!buys.length) return null;
    let earliestMs = null;
    for (const b of buys) {
      const d = (typeof parseDate === 'function') ? parseDate(b.date) : new Date(b.date);
      const ms = d instanceof Date ? d.getTime() : NaN;
      if (Number.isNaN(ms)) continue;
      if (earliestMs == null || ms < earliestMs) earliestMs = ms;
    }
    if (earliestMs == null) return null;
    const days = Math.floor((Date.now() - earliestMs) / 86400000);
    return days >= 0 ? days : null;   // future-dated entry = data error → null, not negative
  }

  // Merged portfolio for analysis — exclude day-trade ('trading') account
  // positions. Those are managed via the Day Trading page and should not
  // receive swing-analysis recommendations.
  const mp = mergedPortfolio().filter(h => (h.account || 'personal') !== 'trading');

  // Phase 2: fetch entry contexts for all holdings (thesis-aware exit analysis).
  // Fire early so it can resolve in parallel with other async fetches below.
  // entryContexts is in scope for prompt-building AND post-response verdict computation.
  const entryContexts = (typeof fetchEntryContexts === 'function')
    ? await fetchEntryContexts(mp.map(h => h.ticker))
    : {};
  const portfolioJson = JSON.stringify(mp.map(h => {
    const days = _daysHeld(h.ticker);
    const livePrice = state.liveSignals?.[h.ticker]?.current_price ?? h.currentPrice;
    const pnlPct = h.avgPrice > 0
      ? +((livePrice / h.avgPrice - 1) * 100).toFixed(2) : null;
    return {
      ticker: h.ticker,
      sector: h.sector,
      shares: h.shares,
      avgPrice: h.avgPrice,
      currentPrice: livePrice,
      value: h.shares * livePrice,
      unrealisedPnl: (livePrice - h.avgPrice) * h.shares,
      unrealisedPnlPct: pnlPct,
      daysHeld: days,
      weight: ((h.shares * livePrice) / portfolioValue() * 100).toFixed(1) + '%',
    };
  }));

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
  const recCtx = recentRecs.length ? '\n\nRECENT RECOMMENDATION HISTORY (last 5 + key outcomes):\n' + recentRecs.map(r => {
    const _rDate = typeof parseDate === 'function' ? parseDate(r.date) : new Date(r.date);
    const daysAgo = _rDate ? Math.floor((Date.now() - _rDate.getTime()) / 86400000) : '?';
    return `${r.date} (${daysAgo}d ago) ${r.action} ${r.ticker} @ $${r.priceRange?.[0]||'?'} → target $${r.target||'?'} | conf=${fmt(r.confidence*100,0)}% | outcome=${r.outcome||'open'} | actualPnL=${r.actualProfit!=null?'$'+fmt(r.actualProfit):'pending'}${r.feedback?' | FEEDBACK: "'+r.feedback+'"':''}`;
  }).join('\n') : '';

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
  const _macroMktLines = (() => {
    if (!_m) return '';
    const fmtp2 = v => v != null ? (v >= 0 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`) : '';
    const parts = [];
    if (_m.iron_ore) parts.push(`IronOre=$${fmt(_m.iron_ore.value)}(${fmtp2(_m.iron_ore.change_pct)})`);
    if (_m.oil)      parts.push(`Oil=$${fmt(_m.oil.value)}(${fmtp2(_m.oil.change_pct)})`);
    if (_m.copper)   parts.push(`Copper=$${fmt(_m.copper.value)}(${fmtp2(_m.copper.change_pct)})`);
    if (_m.us10y)    parts.push(`US10Y=${fmt(_m.us10y.value,3)}%`);
    return parts.length ? `\nCommodities/Rates: ${parts.join(' | ')}` : '';
  })();
  const _macroSectorLines = (() => {
    if (!_m || !_m.sectors) return '';
    const fmtp2 = v => v != null ? (v >= 0 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`) : '?';
    const parts = Object.values(_m.sectors).map(s =>
      `${s.label}:${fmtp2(s.change_1d)}(5d${fmtp2(s.return_5d)})`
    );
    return parts.length ? `\nASX Sectors(1D/5D): ${parts.join(' | ')}` : '';
  })();
  const macroCtx = _m ? `\n\nTODAY'S MACRO BRIEF (${state.macroDate||todayStr()}):
Sentiment: ${_m.sentiment||'n/a'} | Bullish: ${_m.bullish!=null?_m.bullish+'/100':'n/a'} | Conf: ${_m.sentimentConf!=null?Math.round(_m.sentimentConf*100)+'%':'n/a'}
Key drivers: ${(_m.keyDrivers||'n/a').slice(0,200)}${_macroMktLines}${_macroSectorLines}` : '';


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
      // Beat/miss history: show actual-vs-estimate delta for last 4 quarters
      const beatMiss = (() => {
        const q = e.quarterlyEarnings || [];
        if (!q.length) return '';
        const results = q.slice(0, 4).map(r => {
          if (r.actual == null || r.estimate == null) return '?';
          const d = r.actual - r.estimate;
          return d >= 0 ? `+${d.toFixed(2)}` : d.toFixed(2);
        });
        return ` | EPSvEst(4Q):[${results.join(',')}]`;
      })();
      return `  ${t}: nextEarnings=${e.nextEarningsDate} (${daysAway}d)${urgencyFlag} | ${[epsStr,epsGrowthStr,revGrowthStr].filter(Boolean).join(' | ')} | analyst=${e.analystRec||'n/a'} target=$${e.analystTarget?.toFixed(2)||'n/a'}${beatMiss}`;
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
      `Min confidence: ${_r.minConfidence ?? def.minConfidence} | Min R:R: ${_r.minRrRatio ?? def.minRrRatio}:1 | Stop ATR: __STOP_MULT_PLACEHOLDER__×ATR14`,
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

  const _acctLabel = state.activeAccount && state.activeAccount !== 'all' ? ` | Account: ${state.activeAccount.toUpperCase()}` : '';
  // Build HOLDING_CONTEXT block: inject entry thesis per holding so Claude reasons thesis-aware
  const _holdingCtxLines = mp
    .filter(h => entryContexts[h.ticker])
    .map(h => {
      const ec = entryContexts[h.ticker];
      const es = ec.entry_signals || {};
      const rsiStr = es.rsi_14   != null ? `rsi=${es.rsi_14}` : '';
      const bbStr  = es.bb_pct_b != null ? `bb%b=${Number(es.bb_pct_b).toFixed(2)}` : '';
      const adxStr = es.adx_14   != null ? `adx=${es.adx_14}` : '';
      const sigs   = [rsiStr, bbStr, adxStr].filter(Boolean).join(', ');
      return `HOLDING_CONTEXT: ${h.ticker} | EntryDriver: ${ec.primary_entry_driver || 'untagged'} | EntryDate: ${ec.entry_date || '?'} | EntrySignals: ${sigs || 'none'}`;
    });
  const _holdingCtxBlock = _holdingCtxLines.length
    ? '\n\nENTRY THESIS CONTEXT (original buy rationale per holding):\n' + _holdingCtxLines.join('\n')
    : '';

  const userMessage = `Date: ${todayStr()} | Time: ${nowSydney()} | TAX_LOSS_HARVEST_ACTIVE: ${inHarvestWindow}${_acctLabel}
Account settings: brokerage $${state.settings.brokerage}/trade (round-trip $${state.settings.brokerage * 2}) | max ${state.settings.maxTradesPerDay} trades/day | min trade $${state.settings.minTradeSize}
ACTIVE_REGIME: __REGIME_PLACEHOLDER__ (confidence: __CONF_PLACEHOLDER__)

LIVE PORTFOLIO STATE:
Holdings: ${portfolioJson}${_holdingCtxBlock}
Cash available: $${fmt(state.cash)} | Total invested: $${fmt(totalCost())} | Net worth: $${fmt(totalNetWorth())}
RBA Cash Rate: ${state.rbaRate.toFixed(2)}% (${state.rbaRateSource}${state.rbaRateDate ? ', ' + state.rbaRateDate : ''})
${recCtx}${pendingFeedbackCtx}__CALIBRATION_PLACEHOLDER__${macroCtx}${newsOutlook}${annCtx}${marketViewCtx}${extraTickersCtx}${dividendCtx}${earningsCtx}${riskCtx}${rulesCtx}${indicatorCtx}

TASK:
1. Read the CALIBRATION block above as context for your reasoning. Do NOT pre-adjust confidence scores — numeric band/per-ticker adjustments are applied by the engine after your response.
2. Assess macro regime — Rule 12: if sentiment = "bearish" AND bullish < 35, block all BUY/TOP_UP.
3. For every holding and watchlist ticker, run the Section 3 multi-factor framework. Exclude any ticker with < 3 independent non-technical factors from recs[].
4. For each candidate rec: compute priceRange, target (next S/R), stopLoss (stopAtrMultiple×ATR from ACTIVE RULE OVERRIDES), set qty=0 (quant engine sizes), optionally scenarios (if included, p must sum to 1.0), invalidationCondition (must include a measurable value), bearCase (if conf ≥ 0.70), factorsUsed (≥ 3 specific data points).
5. Apply Section 7 pre-flight checks. Fix all failures before writing JSON.
6. Return JSON only — no preamble, no markdown.
PROMPT_VERSION: ${typeof PROMPT_VERSION !== 'undefined' ? PROMPT_VERSION : 'unknown'}`;

  // ── Classify regime (macroPromise already awaited before context build) ─────
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
  // Sprint 71 Phase 3D: the full portfolio analysis is the DEEP feed path —
  // request the token-heavy exemplar/playbook/cross-tab blocks. The cached system
  // prompt means this learning block is the only marginal token cost. High-frequency
  // intraday refreshes (if/when wired) should pass { deep: false } for the lean feed.
  const _calibrationNote = typeof fetchCalibrationBlock === 'function'
    ? await fetchCalibrationBlock(_activeRegime, _portfolioSectors, _portfolioTickers, { deep: true })
    : '';
  // Phase 3A: concrete few-shot exemplars from own history (stashed by the fetch above).
  const _exemplarsBlock = (typeof buildExemplarsBlock === 'function')
    ? buildExemplarsBlock(window._calibExemplars) : '';

  // ── Historical lessons — contextual rules distilled from past adjudications ──
  // Fetches lessons matching any combo of (portfolio tickers, sectors, active regime).
  // Silently skipped when server is down or table is empty.
  let _lessonsBlock = '';
  if (state.serverOk) {
    try {
      const _lParams = new URLSearchParams();
      if (_activeRegime && _activeRegime !== 'unknown') _lParams.set('regime', _activeRegime);
      if (_portfolioTickers.length) _lParams.set('ticker', _portfolioTickers.slice(0, 5).join(','));
      if (_portfolioSectors.length) {
        // Weight sectors by portfolio value, send top 2 as comma-separated
        const sectorWeights = {};
        for (const h of mergedPortfolio()) {
          const sec = h.sector || 'Other';
          const livePrice = state.liveSignals?.[h.ticker]?.current_price ?? h.currentPrice;
          sectorWeights[sec] = (sectorWeights[sec] || 0) + h.shares * livePrice;
        }
        const topSectors = Object.entries(sectorWeights)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 2)
          .map(([s]) => s);
        _lParams.set('sector', topSectors.join(','));
      }
      _lParams.set('limit', '10');
      // Sprint 44: pass breadth metrics so backend can filter breadth-scoped lessons
      const _adl = state.macroData?.advance_decline_ratio;
      const _vol = state.macroData?.asx_vol_20d;
      if (_adl != null) _lParams.set('adl', _adl);
      if (_vol != null) _lParams.set('asx_vol', _vol);
      const _lr = await fetch(`${API}/api/learning/lessons?${_lParams}`);
      if (_lr.ok) {
        const _ld = await _lr.json();
        if (_ld.lessons && _ld.lessons.length) {
          _lessonsBlock = typeof buildLessonsBlock === 'function'
            ? buildLessonsBlock(_ld.lessons) : '';
        }
      }
    } catch { /* non-fatal */ }
  }

  // ── Inject cached debate results (read-only — never starts new debates) ──────
  // Only uses results already in the client-side cache from user-initiated debates.
  // To run debates, use the Debate Engine on the Learning page.
  let _debatePreamble = '';
  let _debateResults  = {};
  if (typeof _getCachedDebate === 'function') {
    for (const h of mergedPortfolio()) {
      const sig = state.liveSignals[h.ticker];
      if (!sig || sig.error) continue;
      const cached = _getCachedDebate(h.ticker, sig);
      if (cached) _debateResults[h.ticker] = { ...cached, _fromCache: true };
    }
    if (Object.keys(_debateResults).length > 0) {
      _debatePreamble = buildDebatePreamble(_debateResults);
      console.log(`[Debate] injecting ${Object.keys(_debateResults).length} cached result(s) into prompt`);
    }
  }

  // ── Assemble dynamic system prompt (core cached + regime/date modules) ──────
  const _systemArray = typeof buildSystemArray === 'function'
    ? buildSystemArray({ regime: _activeRegime, portfolio: mp })
    : [{ type: 'text', text: ANALYSIS_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }];

  // ── Regime transition detection ───────────────────────────────────────────
  // Track when the regime last changed so Claude can discount calibration data
  // that predates the transition (it may come from a prior market cycle).
  // Capture prev BEFORE updating so the transition note can compare old vs new.
  const _prevKnownRegime = state.lastKnownRegime;
  if (_activeRegime && _activeRegime !== 'unknown') {
    if (_prevKnownRegime && _prevKnownRegime !== _activeRegime) {
      // Regime just changed — record the transition timestamp
      state.regimeChangedAt = Date.now();
    }
    state.lastKnownRegime = _activeRegime;
  }

  // Inject calibration, regime, and (optional) debate into the final user message
  const _regimeDaysAgo = state.regimeChangedAt
    ? Math.floor((Date.now() - state.regimeChangedAt) / 86_400_000) : null;
  const _regimeTransitionNote =
    (_prevKnownRegime && _prevKnownRegime !== _activeRegime &&
     _regimeDaysAgo !== null && _regimeDaysAgo <= 7)
      ? ` [TRANSITION: ${_prevKnownRegime}→${_activeRegime} ${_regimeDaysAgo}d ago — calibration data for ${_activeRegime} may be from prior cycle]`
      : '';

  // Regime-aware stop multiple for R:R guidance (Fix 3B)
  const _regimeStopMult = (() => {
    if (typeof getRegimeModifiers === 'function' && _activeRegime) {
      return getRegimeModifiers(_activeRegime).stopAtrMult ?? 2.5;
    }
    return _r.stopAtrMultiple ?? 1.5;
  })();

  // Build the regime line that replaces __REGIME_PLACEHOLDER__ at top of message (Fix 2)
  const regimeLine = _activeRegime && _activeRegime !== 'unknown'
    ? `${_activeRegime}${_regimeTransitionNote}`
    : 'unknown';

  const fullUserMessage = userMessage
    .replace('__REGIME_PLACEHOLDER__', regimeLine)
    .replace('__CONF_PLACEHOLDER__', ((_regimeResult.confidence ?? 0) * 100).toFixed(0) + '%')
    .replace('__CALIBRATION_PLACEHOLDER__', _calibrationNote + _exemplarsBlock + _lessonsBlock)
    .replace('__STOP_MULT_PLACEHOLDER__', String(_regimeStopMult))
    + _debatePreamble;

  try {
    const { text, usage: _usage } = await callClaude('portfolio', fullUserMessage, {
      systemArray: _systemArray,
      model: state.settings?.analysisModel || undefined,
    });

    console.log(`[Token audit] recHistory sent: ${recentRecs.length} entries (last5=${last5.length} withPnl=${withPnl.length} withFeedback=${withFeedback.length})`);
    console.log(`[Token audit] indicatorCtx chars: ${indicatorCtx.length} | macroCtx chars: ${macroCtx.length} | divCtx chars: ${dividendCtx.length} | earningsCtx chars: ${earningsCtx.length}`);
    // Note: prompt+response logging is now handled automatically in callClaude()

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

    // ── Deterministic calibration application (§8.3) ───────────────────────────
    // The CALIBRATION block in the user message is context only — the numeric
    // band/per-ticker nudges are applied HERE (exactly, engine-side) instead of
    // trusting Claude's arithmetic. Runs before the quant engine so Kelly sizing
    // sees the calibrated confidence. Original confidence is preserved in
    // _calibApplied.orig and logged as ai_confidence so calibration stats never
    // compound on already-adjusted values.
    {
      const _adj = window._calibAdjustments;
      if (_adj && (_adj.bands || _adj.tickers)) {
        recs = recs.map(r => {
          const orig = Number(r.confidence) || 0;
          const bandKey = orig >= 0.80 && orig < 0.90 ? '80-90'
                        : orig >= 0.70 && orig < 0.80 ? '70-80'
                        : orig >= 0.60 && orig < 0.70 ? '60-70' : null;
          let adj = 0;
          if (bandKey && _adj.bands && typeof _adj.bands[bandKey] === 'number') {
            adj += _adj.bands[bandKey];
          }
          const tickAdj = _adj.tickers
            ? (_adj.tickers[r.ticker] ?? _adj.tickers[r.ticker + '.AX']) : null;
          if (typeof tickAdj === 'number') adj += tickAdj;
          if (!adj) return r;
          const conf = Math.min(0.98, Math.max(0.05, orig + adj));
          return { ...r, confidence: +conf.toFixed(2),
                   _calibApplied: { band: bandKey, adj: +adj.toFixed(2), orig } };
        });
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
        if (!qt.ok) {
          // Quant engine declined to size. Rule 4 means the AI qty is 0, so a
          // bare `return r` used to ship an unexecutable card with three
          // cascading qty warnings and no stated cause (the WDS 15:35 case).
          // Flag-don't-drop: surface the engine's ACTUAL reason once, and apply
          // fallback min-trade-size sizing (capped by cash) so the user can
          // still execute on their own judgment with a sane prefilled qty.
          const entryLoQ  = Array.isArray(r.priceRange) ? Number(r.priceRange[0]) : NaN;
          const entryHiQ  = Array.isArray(r.priceRange) ? Number(r.priceRange[1]) : Number(r.target);
          const entryMidQ = isFinite(entryLoQ) && isFinite(entryHiQ) ? (entryLoQ + entryHiQ) / 2 : entryHiQ;
          const minTrade  = Number(state.settings.minTradeSize) || 1000;
          const warnings  = [...(r._ruleWarnings || [])];
          if (!entryMidQ || !isFinite(entryMidQ) || entryMidQ <= 0) {
            warnings.push(`Quant engine declined to size: ${qt.reason || 'unknown'} — and no valid entry price for fallback sizing`);
            return { ...r, _ruleWarnings: warnings };
          }
          const affordable = Math.floor((state.cash || 0) / entryMidQ);
          const wanted     = Math.max(1, Math.round(minTrade / entryMidQ));
          const fbQty      = Math.min(wanted, affordable);
          if (fbQty < 1) {
            warnings.push(`Quant engine declined to size: ${qt.reason || 'unknown'} — and cash $${fmt(state.cash || 0)} cannot cover 1 share at $${entryMidQ.toFixed(2)}`);
            return { ...r, _ruleWarnings: warnings };
          }
          warnings.push(`Quant engine declined to size: ${qt.reason || 'unknown'}. Fallback min-trade sizing applied (${fbQty} sh ≈ $${fmt(fbQty * entryMidQ)}) — review before executing`);
          return { ...r, qty: fbQty, _fallbackSized: true, _ruleWarnings: warnings };
        }
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
          _preEarningsAdj: qt._preEarningsAdj,
        };
      });
    }

    // ── Deterministic SELL/TRIM sizing ──────────────────────────────────────────
    // Rule 4 makes Claude emit qty=0 for every action, but computeTradeParams()
    // above only sizes BUY/TOP_UP — exits were reaching the UI with no quantity.
    // SELL = full position. TRIM = the "Reduce (-25-50%)" range midpoint from
    // weightGuidance (default 35%) of the held shares, clamped to [1, held].
    recs = recs.map(r => {
      const action = (r.action || '').toUpperCase();
      if (action !== 'SELL' && action !== 'TRIM') return r;
      const holding = mergedPortfolio().find(h => h.ticker === r.ticker);
      const held = holding ? Math.floor(Number(holding.shares) || 0) : 0;
      if (held < 1) return r;  // not held — downstream guards handle the rec
      const aiQty = Math.round(Number(r.qty) || 0);
      if (aiQty >= 1 && aiQty <= held) return r;  // respect a valid explicit qty
      if (action === 'SELL') return { ...r, qty: held, _exitSized: 'full' };
      let frac = 0.35;
      const m = /(\d+)\s*-\s*(\d+)\s*%/.exec(r.weightGuidance || '');
      if (m) frac = (Number(m[1]) + Number(m[2])) / 2 / 100;
      frac = Math.min(1, Math.max(0.05, frac));
      const qty = Math.min(held, Math.max(1, Math.round(held * frac)));
      return { ...r, qty, _exitSized: `${Math.round(frac * 100)}%` };
    });

    // ── ATR floor for SELL/TRIM stop loss ──────────────────────────────────────
    // Claude sometimes generates near-zero stop distances for SELL/TRIM (e.g. +0.2%
    // above entry = a 60:1 R:R). Apply a regime-aware minimum of stopAtrMult×ATR above entry.
    // stopAtrMult matches computeTradeParams(): 2.5 riskOn/trend/sideways · 3.0 highVol ·
    // 3.5 riskOff · 4.0 panic.
    {
      const regimeMod = (state.currentRegime && typeof getRegimeModifiers === 'function')
        ? getRegimeModifiers(state.currentRegime.regime) : {};
      const stopMult = regimeMod.stopAtrMult ?? 2.5;
      recs = recs.map(r => {
        const action = (r.action || '').toUpperCase();
        if (action !== 'SELL' && action !== 'TRIM') return r;
        const entry   = Array.isArray(r.priceRange) ? r.priceRange[0] : null;
        const signals = state.liveSignals && state.liveSignals[r.ticker];
        const atr     = signals && signals.atr_14;
        if (!entry || !atr || atr <= 0) return r;
        const minStop = +(entry + stopMult * atr).toFixed(3);
        if (!r.stopLoss || r.stopLoss < minStop) {
          return { ...r, stopLoss: minStop, _stopRepaired: true, _stopRepairedMult: stopMult };
        }
        return r;
      });
    }

    // ── Validator (§8.1) — schema + business rules, local fix-or-drop ──────────
    // Runs AFTER the sizing + ATR-floor steps so the qty ≥ 1 and stop-direction
    // checks validate what the user will actually see (Rule 4 makes Claude emit
    // qty=0; the engine sizes BUY/TOP_UP and SELL/TRIM above). No network repair
    // loop — unfixable recs are dropped with a summary note. This also drops
    // quant-rejected BUYs (Kelly ≤ 0 → qty stayed 0) and SELL/TRIM on unheld
    // tickers (sizing skipped → qty stayed 0), both of which previously slipped
    // through with qty=0.
    if (typeof validateRec === 'function') {
      const validatorFlagged = [];
      const validatorDropped = [];
      recs = recs.flatMap(r => {
        // Ground-truth context for the SELL/TRIM secondary-tag checks — mirrors
        // the exact weight/unrealisedPnl/daysHeld formulas used to build the
        // Holdings JSON above (portfolioJson), so the validator checks the AI's
        // tags (unrealised_loss_large, position_oversized, sector_concentration,
        // held_over_12m/11_to_12m) against the same numbers it was actually given.
        const _h = mp.find(x => x.ticker === r.ticker);
        let ctx;
        if (_h) {
          const livePrice = state.liveSignals?.[r.ticker]?.current_price ?? _h.currentPrice;
          const pv = portfolioValue();
          const sectorTotal = mp
            .filter(x => x.sector === _h.sector)
            .reduce((s, x) => s + x.shares * (state.liveSignals?.[x.ticker]?.current_price ?? x.currentPrice), 0);
          ctx = { holding: {
            weightPct:       pv > 0 ? (_h.shares * livePrice) / pv * 100 : null,
            sectorWeightPct: pv > 0 ? sectorTotal / pv * 100 : null,
            unrealisedPnl:   (livePrice - _h.avgPrice) * _h.shares,
            daysHeld:        _daysHeld(r.ticker),
          } };
        }
        const { valid, errors, fixed } = validateRec(r, ctx);
        if (valid) return [fixed || r];   // fixed carries error-free repairs (e.g. [driver: X] suffix)
        if (fixed) {
          console.warn(`[validator] repaired ${r.action} ${r.ticker}:`, errors);
          return [{ ...fixed, _validatorFixed: errors }];
        }
        const contradictionHit = errors.find(e => /^reasoning says ".*" but action=/.test(e));
        if (contradictionHit) {
          console.warn(`[validator] flagged self-contradicting ${r.action} ${r.ticker}:`, errors);
          validatorFlagged.push(`${r.action} ${r.ticker}`);
          return [{ ...r, _ruleWarnings: errors }];
        }
        // Flag-don't-drop (user decision 2026-06-11): unfixable recs stay
        // visible with a highlighted warning panel listing every failed rule —
        // the user makes the final Skip/Execute call. Only structurally
        // unusable recs (no valid ticker/action — unrenderable, unexecutable)
        // are still dropped.
        const action = (r.action || '').toUpperCase();
        const usable = /^[A-Z0-9]{2,5}(\.AX)?$/.test(r.ticker || '')
          && ['BUY', 'SELL', 'TRIM', 'TOP_UP', 'HOLD'].includes(action);
        if (!usable) {
          console.warn(`[validator] dropped structurally unusable rec:`, errors, r);
          validatorDropped.push(r.ticker || '?');
          return [];
        }
        console.warn(`[validator] flagged ${r.action} ${r.ticker} for review:`, errors);
        validatorFlagged.push(`${r.action} ${r.ticker}`);
        return [{ ...r, _ruleWarnings: errors }];
      });
      if (validatorFlagged.length > 0) {
        const note = ` [⚠ ${validatorFlagged.length} rec(s) failed validation — shown highlighted for your review: ${validatorFlagged.join(', ')}]`;
        summary = (summary ? summary + ' ' : '') + note.trim();
      }
      if (validatorDropped.length > 0) {
        const note = ` [Validator dropped ${validatorDropped.length} structurally unusable rec(s): ${validatorDropped.join(', ')}]`;
        summary = (summary ? summary + ' ' : '') + note.trim();
      }
    }

    // ── Whipsaw / contradiction check (Learning Loop improvement F) ────────────
    // Compares each rec's entry signature + direction against the most recent
    // rec ever logged for the same ticker (any action). A near-identical setup
    // with a flipped direction inside 10 days is a likely overreaction to noise
    // rather than a genuine thesis change. Flag-and-keep — same philosophy as
    // the validator's own contradiction check above (CLAUDE.md: flag-don't-drop,
    // user decision 2026-06-11) — this never drops a rec, only adds a warning.
    if (state.serverOk && recs.length && typeof entrySignature === 'function') {
      try {
        const uniqueTickers = [...new Set(recs.map(r => r.ticker).filter(Boolean))];
        const recentMap = {};
        await Promise.all(uniqueTickers.map(async (tk) => {
          try {
            const resp = await fetch(`${API}/api/learning/recent-rec?ticker=${encodeURIComponent(tk)}`);
            if (resp.ok) {
              const d = await resp.json();
              if (d.ok && d.rec) recentMap[tk] = d.rec;
            }
          } catch (_) {}
        }));
        const isBuySide  = a => a === 'BUY' || a === 'TOP_UP';
        const isSellSide = a => a === 'SELL' || a === 'TRIM';
        recs = recs.map(r => {
          const prior = recentMap[r.ticker];
          if (!prior) return r;
          const curAction   = (r.action || '').toUpperCase();
          const priorAction = (prior.recommendation || '').toUpperCase();
          const flipped = (isBuySide(curAction) && isSellSide(priorAction)) ||
                          (isSellSide(curAction) && isBuySide(priorAction));
          if (!flipped) return r;
          const priorDate  = prior.timestamp ? prior.timestamp.slice(0, 10) : null;
          const daysSince  = priorDate ? (Date.now() - new Date(priorDate).getTime()) / 86400000 : 999;
          if (!priorDate || daysSince > 10) return r;
          // Build the current ticker's signature from the same derived fields
          // logRecsToLearningLoop() snapshots into entry_signals_json (CLAUDE.md
          // gotcha #43) — liveSignals itself doesn't carry px_vs_sma200/setup_score
          // directly, they're derived from current_price/sma_200/score.
          const ls = state.liveSignals?.[r.ticker];
          const curSigObj = ls ? {
            rsi_14:       ls.rsi_14 ?? null,
            bb_pct_b:     ls.bb_pct_b ?? null,
            px_vs_sma200: (typeof ls.current_price === 'number' && typeof ls.sma_200 === 'number' && ls.sma_200)
                            ? ((ls.current_price / ls.sma_200 - 1) * 100) : null,
            setup_score:  ls.score ?? null,
            macd_hist:    ls.macd_hist ?? null,
          } : null;
          const curSig   = entrySignature(curSigObj);
          const priorSig = entrySignature(prior.entry_signals || {});
          if (!curSig || !priorSig) return r;
          const curTokens   = curSig.split(' ');
          const priorTokens = priorSig.split(' ');
          if (Math.max(curTokens.length, priorTokens.length) < 4) return r;
          const matches = curTokens.filter(t => priorTokens.includes(t)).length;
          if (matches < 4) return r;
          const warn = `contradicts your own ${priorAction} rec on ${priorDate} under a near-identical setup`;
          const warnings = Array.isArray(r._ruleWarnings) ? [...r._ruleWarnings, warn] : [warn];
          return { ...r, _ruleWarnings: warnings };
        });
      } catch (_) {}
    }

    // ── Ensemble confidence — blend AI confidence with indicator composite ─────
    // Previously computed only inside the unwired validateResponse(), so every
    // learning event logged ensemble_confidence = null. Restored here.
    recs = recs.map(r => {
      const sig = state.liveSignals?.[r.ticker] ?? state.liveSignals?.[r.ticker + '.AX'];
      const indScore = sig?.score;
      const hasValidScore = indScore != null && !Number.isNaN(indScore);
      return { ...r, ensembleConfidence: hasValidScore
        ? Math.round((0.5 * (r.confidence || 0) + 0.5 * (indScore / 100)) * 100) / 100
        : r.confidence };
    });

    // ── Apply regime size modifiers ─────────────────────────────────────────────
    if (typeof applyRegimeModifiers === 'function' && _activeRegime && _activeRegime !== 'unknown') {
      recs = recs.map(r => {
        const action = (r.action || '').toUpperCase();
        return (action === 'BUY' || action === 'TOP_UP') ? applyRegimeModifiers(r, _activeRegime) : r;
      });
      // Drop recs hard-blocked by regime (e.g. panic → sizeMult=0)
      const regimeBlockedRecs = recs.filter(r => r._regimeBlocked);
      const blocked = regimeBlockedRecs.length;
      recs = recs.filter(r => !r._regimeBlocked);
      // Shadow-log regime-blocked recs for ML bias correction
      if (typeof dtSaveSnapshot === 'function' && regimeBlockedRecs.length > 0) {
        regimeBlockedRecs.forEach(function(r) {
          var sigs  = (state.liveSignals && state.liveSignals[r.ticker]) || {};
          var price = sigs.current_price
            || (Array.isArray(r.priceRange) ? r.priceRange[0] : 0);
          dtSaveSnapshot(r, 'swing', sigs, state.macroData || {}, price, 0,
            { record_type: 'shadow', shadow_reason: 'regime_blocked' });
        });
      }
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
        // §8.2: deterministic net-EV gate at the ENGINE-computed qty. The AI's
        // netProfit is a min-trade-size estimate (Rule 4 forces qty=0, so it can
        // no longer compute a real one) — recompute here from final sizing:
        // gross reward − opportunity cost vs RBA − round-trip brokerage.
        const entryLo   = Array.isArray(r.priceRange) ? Number(r.priceRange[0]) : NaN;
        const entryHigh = Array.isArray(r.priceRange) ? Number(r.priceRange[1]) : Number(r.target);
        const entryMid  = isFinite(entryLo) && isFinite(entryHigh) ? (entryLo + entryHigh) / 2 : entryHigh;
        const target    = Number(r.target);
        const targetBelowEntry = isFinite(entryHigh) && isFinite(target) && target <= entryHigh;
        const grossReward = qty * (target - entryMid);
        const oppCost = qty * entryMid * ((state.rbaRate || 4.35) / 100)
                        * ((Number(r.expectedTimeToTarget) || 30) / 365);
        const engineNet = grossReward - oppCost - 2 * fees;
        if (targetBelowEntry || !isFinite(engineNet) || engineNet <= 0) {
          droppedNegEV++;
          // §8.6: shadow-log so the ML sees the unpruned setup distribution
          if (typeof dtSaveSnapshot === 'function' && r.stopLoss && r.target) {
            const _sigs = (state.liveSignals && state.liveSignals[r.ticker]) || {};
            dtSaveSnapshot(r, 'swing', _sigs, state.macroData || {},
              _sigs.current_price || entryMid || 0, 0,
              { record_type: 'shadow', shadow_reason: 'neg_ev' });
          }
          // Flag-don't-drop: keep visible with the failure reason for user review
          r._ruleWarnings = [...(r._ruleWarnings || []),
            targetBelowEntry
              ? `Target $${isFinite(target) ? target : '?'} ≤ entry high — trade cannot profit as specified`
              : `Engine net-EV ≤ 0 at sized qty (gross $${isFinite(grossReward) ? grossReward.toFixed(0) : '?'} − opportunity cost − $${(2 * fees).toFixed(0)} round-trip brokerage = $${isFinite(engineNet) ? engineNet.toFixed(0) : '?'})`];
        } else {
          r.expectedProfit = +grossReward.toFixed(2);
          r.netProfit = +engineNet.toFixed(2);
          r._netProfitEngine = true;
        }
      }

      cleanedRecs.push(r);
    }
    if (droppedNegEV > 0) {
      const note = ` [⚠ ${droppedNegEV} buy rec(s) flagged with non-positive est. P&L — review before executing]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }
    recs = cleanedRecs;

    // ── CONFIDENCE FLOOR: flag (not drop) any rec below threshold ──────────────
    const MIN_CONFIDENCE = state.analysisConfig.rules?.minConfidence ?? 0.62;
    let lowConfFlagged = 0;
    recs = recs.map(r => {
      if ((r.confidence || 0) < MIN_CONFIDENCE) {
        lowConfFlagged++;
        // §8.6: shadow-log BUY-side fails so the ML sees the unpruned distribution
        const _act = (r.action || '').toUpperCase();
        if (typeof dtSaveSnapshot === 'function' && r.stopLoss && r.target
            && (_act === 'BUY' || _act === 'TOP_UP')) {
          const _sigs = (state.liveSignals && state.liveSignals[r.ticker]) || {};
          dtSaveSnapshot(r, 'swing', _sigs, state.macroData || {},
            _sigs.current_price || (Array.isArray(r.priceRange) ? r.priceRange[0] : 0), 0,
            { record_type: 'shadow', shadow_reason: 'conf_floor' });
        }
        return { ...r,
          _confidenceHeld: true,
          _ruleWarnings: [...(r._ruleWarnings || []),
          `Confidence ${(100 * (r.confidence || 0)).toFixed(0)}% is below the ${(MIN_CONFIDENCE * 100).toFixed(0)}% floor`] };
      }
      return r;
    });
    if (lowConfFlagged > 0) {
      const note = ` [⚠ ${lowConfFlagged} rec(s) below ${(MIN_CONFIDENCE*100).toFixed(0)}% confidence floor — flagged for review]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }

    // ── Correlation-aware size reduction ──────────────────────────────────────
    // Fetch exact correlation between BUY rec tickers and existing holdings.
    // Reduces qty when |corr| > 0.7 (−30%) or > 0.85 (−50%) to limit
    // inadvertent concentration in correlated names.
    const _buyRecs = recs.filter(r => ['BUY','TOP_UP'].includes((r.action||'').toUpperCase()));
    if (state.serverOk && portfolioTickers.length && _buyRecs.length) {
      try {
        const _corrTickers = [...new Set([...portfolioTickers, ..._buyRecs.map(r => r.ticker)])];
        if (_corrTickers.length >= 2) {
          const _corrResp = await fetch(`${API}/api/risk?tickers=${_corrTickers.join(',')}&rf=${state.rbaRate||4.35}`);
          if (_corrResp.ok) {
            const _corrData = await _corrResp.json();
            const _corrMatrix = _corrData.correlation || {};
            recs = _applyCorrSizing(recs, _corrMatrix, portfolioTickers);
          }
        }
      } catch { /* non-fatal — analysis continues without correlation adjustment */ }
    }

    // ── Portfolio heat budget gate ─────────────────────────────────────────────
    // Scale or block BUY/TOP_UP recs that would push total $ at-risk beyond the
    // user-configured heat budget (Risk page → "Set budget", stored in
    // state.settings.maxRiskBudgetPct, default 5% of net worth).
    {
      // Regime-aware heat limit: tighter caps during stress regimes.
      // Effective limit = min(user setting, regime ceiling).
      const _REGIME_HEAT_LIMITS = { riskOn: 6, trend: 5, sideways: 5, highVol: 3, riskOff: 2, panic: 0 };
      const _curRegimeName  = (state.currentRegime && state.currentRegime.regime) || 'sideways';
      const _regimeHeatPct  = _REGIME_HEAT_LIMITS[_curRegimeName] != null ? _REGIME_HEAT_LIMITS[_curRegimeName] : 5;
      const _userHeatPct    = parseFloat(state.settings.maxRiskBudgetPct || 5);
      const budgetPct       = Math.min(_userHeatPct, _regimeHeatPct);
      const _heatLimitSource = _regimeHeatPct <= _userHeatPct ? `regime:${_curRegimeName}` : 'user';
      const totalValue  = totalNetWorth();
      const budgetAUD   = totalValue * budgetPct / 100;

      // Sum riskAUD already consumed by pre-existing pending recs
      let consumed = (state.recommendations || [])
        .filter(r => r.status === 'pending' &&
                     (r.action === 'BUY' || r.action === 'TOP_UP') &&
                     r.riskAUD > 0)
        .reduce((s, r) => s + r.riskAUD, 0);

      // Audit fix #2: also sum $-at-risk on the LIVE book — executed BUY/TOP_UP
      // recHistory entries still open (i.e. the position is still held), using
      // each parcel's own qty/entryPrice/stopLoss (mirrors checkStopProximityAlerts'
      // open-rec filter in alerts.js). Without this, a portfolio already at or
      // beyond maxRiskBudgetPct shows consumed=0 the moment its recs clear
      // "pending" on execution — the gate only ever throttled same-batch new
      // recs against each other, never against risk already on the book.
      const heldTickers = new Set((state.portfolio || []).map(h => h.ticker));
      consumed += (state.recHistory || [])
        .filter(r =>
          r.executed && r.stopLoss > 0 && r.qty > 0 &&
          (r.action === 'BUY' || r.action === 'TOP_UP') &&
          (r.outcome === 'open' || !r.outcome) &&
          heldTickers.has(r.ticker)
        )
        .reduce((s, r) => {
          const entry = r.executedPrice || (Array.isArray(r.priceRange) ? r.priceRange[0] : null);
          if (!entry) return s;
          return s + r.qty * Math.abs(entry - r.stopLoss);
        }, 0);

      const _budgetResult = _applyHeatBudget(recs, budgetAUD, consumed, _heatLimitSource);
      recs = _budgetResult.recs;
      const budgetScaledCount  = _budgetResult.scaled;
      const budgetBlockedCount = _budgetResult.blocked;

      // Drop budget-blocked recs — shadow-log them first for ML bias correction
      const budgetBlockedRecs = recs.filter(r => r._budgetBlocked);
      recs = recs.filter(r => !r._budgetBlocked);
      const budgetDropped = budgetBlockedRecs.length;

      // Fire-and-forget shadow snapshots (never blocks execution)
      if (typeof dtSaveSnapshot === 'function' && budgetBlockedRecs.length > 0) {
        budgetBlockedRecs.forEach(function(r) {
          var sigs  = (state.liveSignals && state.liveSignals[r.ticker]) || {};
          var price = sigs.current_price
            || (Array.isArray(r.priceRange) ? r.priceRange[0] : 0);
          dtSaveSnapshot(r, 'swing', sigs, state.macroData || {}, price, 0,
            { record_type: 'shadow', shadow_reason: 'heat_blocked' });
        });
      }

      if (budgetScaledCount > 0 || budgetDropped > 0) {
        const parts = [];
        if (budgetScaledCount > 0) parts.push(`${budgetScaledCount} scaled to heat budget`);
        if (budgetDropped > 0)     parts.push(`${budgetDropped} blocked (budget exhausted)`);
        summary = (summary ? summary + ' ' : '') + `[Heat budget: ${parts.join('; ')}]`;
      }
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
    const batchBuys      = new Set();
    const batchSells     = new Set(); // SELL + TRIM (BUY/SELL same-day conflict guard)
    const batchSellsOnly = new Set(); // SELL only (TRIM suppression — full exit beats partial)
    for (const r of filteredRecs) {
      const a = (r.action || '').toUpperCase();
      if (a === 'BUY' || a === 'TOP_UP') batchBuys.add(r.ticker);
      if (a === 'SELL' || a === 'TRIM')  batchSells.add(r.ticker);
      if (a === 'SELL')                  batchSellsOnly.add(r.ticker);
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

    const newRecs = deconflictedRecs.map((r,i) => {
      // Attach generation-time context for the "Why this rec?" traceability panel.
      const _sig = state.liveSignals && state.liveSignals[r.ticker];
      const _signalsSnap = _sig ? {
        rsi_14:      _sig.rsi_14,
        atr_14:      _sig.atr_14,
        adx:         _sig.adx,
        obv_trend:   _sig.obv_trend,
        bb_pct_b:    _sig.bb_pct_b,
        score:       _sig.score,
        macd_signal: _sig.macd_signal,
        volume_ratio:_sig.volume_ratio,
        rs_score:    _sig.rs_score,
      } : null;
      return {
        ...r,
        id: `R-${Date.now()}-${i}`,
        status: 'pending',
        generatedAt: nowSydney(),
        date: todayStr(),
        feedback: null,
        _genRegime:     _activeRegime || null,
        _genRegimeConf: state.currentRegime ? state.currentRegime.confidence : null,
        _calibSnap:     _calibrationNote ? String(_calibrationNote).slice(0, 350) : null,
        _signalsSnap,
      };
    });

    // ── SAME-DAY DEDUP: prevent multiple TRIM/TOP_UP and SELL+TRIM conflicts ──
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
    // Within this batch: keep highest-confidence TRIM/TOP_UP per ticker.
    const batchSeen = new Map();
    for (const r of newRecs) {
      if (r.action !== 'TRIM' && r.action !== 'TOP_UP') continue;
      const k = `${r.ticker}::${r.action}`;
      if (!batchSeen.has(k) || r.confidence > batchSeen.get(k).confidence) {
        batchSeen.set(k, r);
      }
    }
    // batchSells already populated above (line ~1362) — SELL+TRIM conflict:
    // if SELL and TRIM both appear for the same ticker, SELL wins (full exit
    // overrides partial exit — they're contradictory positions).

    let dupsSuppressed = 0;
    const dedupedRecs = newRecs.filter(r => {
      if (r.action !== 'TRIM' && r.action !== 'TOP_UP') return true;
      // SELL+TRIM conflict: drop the TRIM when a SELL exists for the same ticker.
      if (r.action === 'TRIM' && batchSellsOnly.has(r.ticker)) {
        console.warn(`[dedup] Suppressing TRIM ${r.ticker} — SELL also present in this batch (full exit takes priority)`);
        dupsSuppressed++;
        return false;
      }
      const k = `${r.ticker}::${r.action}`;
      if (alreadyActioned.has(k)) { dupsSuppressed++; return false; }
      if (batchSeen.get(k) !== r) { dupsSuppressed++; return false; }
      return true;
    });
    if (dupsSuppressed > 0) {
      const note = ` [Suppressed ${dupsSuppressed} duplicate/conflicting rec(s)]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }

    // ── Strip HOLD from pending survivors ──
    const survivingPending = state.recommendations.filter(r =>
      r.status === 'pending' && r.action && r.action.toUpperCase() !== 'HOLD'
    );

    // ── MAX TRADES PER DAY CAP ──
    // Flagged recs (failed validation/EV/confidence — shown for review) don't
    // compete for cap slots and aren't cut by the cap: they're advisory until
    // the user decides, not planned trades.
    const todayKey2 = todayStr();
    const todayExecutedCount = state.recHistory.filter(r => r.date === todayKey2 && r.executed).length;
    const maxNew = Math.max(0, (state.settings.maxTradesPerDay || 5) - todayExecutedCount);
    let capDropped = 0;
    let cappedDedupedRecs = dedupedRecs;
    const _cleanRecs   = dedupedRecs.filter(r => !(r._ruleWarnings && r._ruleWarnings.length));
    const _flaggedRecs = dedupedRecs.filter(r =>  (r._ruleWarnings && r._ruleWarnings.length));
    if (_cleanRecs.length > maxNew) {
      const cappedClean = _cleanRecs
        .slice()
        .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
        .slice(0, maxNew);
      capDropped = _cleanRecs.length - cappedClean.length;
      cappedDedupedRecs = [...cappedClean, ..._flaggedRecs];
    }
    if (capDropped > 0) {
      const note = ` [Capped: dropped ${capDropped} lower-confidence rec(s) — max ${state.settings.maxTradesPerDay} trades/day, ${todayExecutedCount} already executed today]`;
      summary = (summary ? summary + ' ' : '') + note.trim();
    }

    // ── Expand SELL/TRIM recs into per-parcel sub-recs ───────────────────────
    // Must run AFTER the day-cap (we treat a multi-parcel SELL as one trade
    // decision) but BEFORE state assignment so each card shows accurate data.
    cappedDedupedRecs = _splitRecsByParcels(
      cappedDedupedRecs, state.cgtParcels, state.liveSignals, state.settings.brokerage
    );

    state.recommendations = [...cappedDedupedRecs, ...survivingPending];

    // Build structured summary from actual recs — never rely on AI free-text for this.
    // `summaryRecs` carries the full untruncated reasoning for rich card rendering.
    // `recLines` (truncated) is kept only for the plain-text `text` fallback field.
    const summaryRecs = cappedDedupedRecs.map(r => ({
      ticker: r.ticker,
      action: r.action,
      confidence: r.confidence,
      reasoning: reasoningText(r.reasoning).replace(/\n/g, ' ').trim(),
      _parcelLabel: r._parcelLabel || null,
    }));
    const recLines = summaryRecs.map(r =>
      `${r.ticker}: ${r.action}${r.reasoning ? ' — ' + smartTruncate(r.reasoning, 110) : ''}`
    );

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
        contextLine = stripped;   // stored untruncated; renderer wraps naturally
      }
    }
    // Suppress contradictory "no actionable" note when recs were actually generated
    if (recLines.length > 0 && /no actionable setup/i.test(contextLine)) {
      contextLine = '';
    }

    const allParts = [
      ...(recLines.length ? recLines : ['No actionable setups — holding cash.']),
      ...(contextLine ? [smartTruncate(contextLine, 220)] : []),
      ...(bracketNotes.length ? [bracketNotes.join(' ')] : []),
    ];
    const structuredText = allParts.join('\n');

    state.analysisLastSummary = {
      text: structuredText,         // plain-text fallback (backward compat)
      recs: summaryRecs,            // structured rows for rich rendering
      contextLine,                  // macro/cash context (untruncated)
      bracketNotes,                 // system notes array e.g. ['[⚠ N recs failed…]']
      date: todayStr(),
      time: nowSydney(),
      recCount: cappedDedupedRecs.length,
    };
    state.analysisRunning = false;
    scheduleSave();
    toast(`Analysis done: ${cappedDedupedRecs.length} recommendation(s)`, 'success');
    // Fire desktop notification for high-conviction recs
    if (typeof alertHighConviction === 'function') alertHighConviction(cappedDedupedRecs);
    // Phase 2+3: compute thesis verdict for SELL/TRIM recs deterministically
    // using entry context fetched at the top of this function (entryContexts in scope).
    cappedDedupedRecs.forEach(r => {
      const action = (r.action || '').toUpperCase();
      if (action !== 'SELL' && action !== 'TRIM') return;
      const _ls = state.liveSignals?.[r.ticker];
      const liveSnap = _ls ? {
        rsi_14:    _ls.rsi_14    ?? null,
        bb_pct_b:  _ls.bb_pct_b ?? null,
        adx_14:    _ls.adx      ?? null,
        atr_pct:   _ls.atr_pct  ?? null,
        return_5d: _ls.return_5d ?? null,
        return_20d:_ls.return_20d?? null,
      } : null;
      const ec = entryContexts[r.ticker];
      r._thesisCheck = (ec && typeof computeThesisDrift === 'function')
        ? computeThesisDrift(ec.primary_entry_driver, ec.entry_signals || {}, liveSnap)
        : null;
      r._entryDriver  = ec?.primary_entry_driver || null;
      r.thesis_verdict = r._thesisCheck?.verdict ?? null;
    });

    // Log recommendations to the Learning Loop backend (fire-and-forget)
    logRecsToLearningLoop(cappedDedupedRecs, _activeRegime, _debateResults);
    showPage('recommendations');
  } catch(e) {
    state.analysisRunning = false;
    toast('Analysis error: ' + e.message, 'error');
  }
}

// Sprint 67: allowed structured entry drivers (BUY/TOP_UP). Mirrors
// learning.ENTRY_DRIVERS on the backend; used to normalise Claude's tag.
const _ENTRY_DRIVERS = new Set([
  'mean_reversion', 'momentum_breakout', 'trend_pullback',
  'fundamental_value', 'macro_tailwind',
]);

// ── Per-parcel split for SELL/TRIM recs ──────────────────────────────────────
// When a SELL or TRIM rec covers a position built from multiple CGT parcels,
// the aggregate avgCost/unrealisedPnl/daysHeld hides per-lot data.  This
// function expands one Claude rec into N recs — one per open parcel (SELL) or
// one per FIFO-consumed portion (TRIM) — so each card shows accurate cost
// basis, holding period, and CGT eligibility for that specific lot.
// Single-lot positions are annotated but not split.
// Called just before state.recommendations is assembled.
function _splitRecsByParcels(recs, cgtParcels, liveSignals, brokerage) {
  const _daysSince = (dateStr) => {
    const d = (typeof parseDate === 'function') ? parseDate(dateStr) : new Date(dateStr);
    if (!d || isNaN(d.getTime())) return null;
    const days = Math.floor((Date.now() - d.getTime()) / 86400000);
    return days >= 0 ? days : null;
  };
  const _normTk = t => (t || '').replace(/\.AX$/i, '').toUpperCase();

  const result = [];
  for (const r of recs) {
    const action = (r.action || '').toUpperCase();
    if (action !== 'SELL' && action !== 'TRIM') { result.push(r); continue; }

    const ticker = _normTk(r.ticker);
    const sellPrice = Array.isArray(r.priceRange) ? Number(r.priceRange[0]) : null;
    const fees = brokerage || 0;

    // Resolve the single unambiguous account for this ticker's open lots.
    // When 2+ accounts hold the same ticker we can't know which will be targeted
    // until the exec-account picker fires — so skip splitting and leave the rec unsplit.
    const _holdingAccts = [...new Set(
      (state.portfolio || [])
        .filter(h => _normTk(h.ticker) === ticker)
        .map(h => h.account || 'personal')
    )];
    const _singleAcct = _holdingAccts.length === 1 ? _holdingAccts[0] : null;

    // Open parcels for this ticker (account-scoped when unambiguous), sorted oldest-first (FIFO order)
    const openParcels = _holdingAccts.length > 1 ? [] : (cgtParcels || [])
      .filter(p => _normTk(p.ticker) === ticker && (p.remainingQty || 0) > 0
                   && (!_singleAcct || (p.account || 'personal') === _singleAcct))
      .slice()
      .sort((a, b) => {
        const da = (typeof parseDate === 'function') ? parseDate(a.date) : new Date(a.date);
        const db = (typeof parseDate === 'function') ? parseDate(b.date) : new Date(b.date);
        return (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
      });

    if (openParcels.length <= 1) {
      // Single or no parcel — annotate with metadata but keep as one rec
      if (openParcels.length === 1) {
        const p = openParcels[0];
        const days = _daysSince(p.date);
        const livePrice = liveSignals?.[ticker]?.current_price ?? liveSignals?.[ticker + '.AX']?.current_price;
        result.push({
          ...r,
          _parcelId:            p.id,
          _parcelLabel:         `P#${p.id}`,
          _parcelCostPerShare:  p.costPerShare,
          _parcelDate:          p.date,
          _parcelRemainingQty:  p.remainingQty,
          _holdingDays:         days,
          _cgtEligible:         days != null && days > 365,
          _parcelUnrealisedPnl: livePrice != null ? (livePrice - p.costPerShare) * p.remainingQty : null,
        });
      } else {
        result.push(r);
      }
      continue;
    }

    // ── Multiple parcels ─────────────────────────────────────────────────────
    if (action === 'SELL') {
      // Full exit: one sub-rec per open parcel
      openParcels.forEach((p, i) => {
        const days = _daysSince(p.date);
        const livePrice = liveSignals?.[ticker]?.current_price ?? liveSignals?.[ticker + '.AX']?.current_price;
        result.push({
          ...r,
          id:                   `${r.id}-p${p.id}`,
          qty:                  p.remainingQty,
          _parcelId:            p.id,
          _parcelLabel:         `P#${p.id}`,
          _parcelCostPerShare:  p.costPerShare,
          _parcelDate:          p.date,
          _parcelRemainingQty:  p.remainingQty,
          _holdingDays:         days,
          _cgtEligible:         days != null && days > 365,
          _parcelUnrealisedPnl: livePrice != null ? (livePrice - p.costPerShare) * p.remainingQty : null,
          // Per-parcel P&L (brokerage charged only on the first sub-rec to avoid duplication)
          netProfit:     sellPrice != null ? (sellPrice - p.costPerShare) * p.remainingQty - (i === 0 ? fees : 0) : null,
          expectedProfit: sellPrice != null ? (sellPrice - p.costPerShare) * p.remainingQty : r.expectedProfit,
          _costBasis:    p.costPerShare,
          _splitFrom:    r.id,
          _splitIndex:   i,
          _splitTotal:   openParcels.length,
        });
      });
    } else {
      // TRIM: FIFO-distribute the trim qty across parcels
      let remaining = Number(r.qty) || 0;
      if (remaining < 1) { result.push(r); continue; }

      const consumed = [];
      for (const p of openParcels) {
        if (remaining <= 0) break;
        const take = Math.min(p.remainingQty, remaining);
        consumed.push({ parcel: p, qty: take });
        remaining -= take;
      }

      if (consumed.length <= 1) {
        // Trim only touches one parcel — annotate, no split
        if (consumed.length === 1) {
          const { parcel: p, qty: trimQty } = consumed[0];
          const days = _daysSince(p.date);
          result.push({
            ...r,
            qty:                  trimQty,
            _parcelId:            p.id,
            _parcelLabel:         `P#${p.id}`,
            _parcelCostPerShare:  p.costPerShare,
            _parcelDate:          p.date,
            _parcelRemainingQty:  p.remainingQty,
            _holdingDays:         days,
            _cgtEligible:         days != null && days > 365,
            _parcelUnrealisedPnl: sellPrice != null ? (sellPrice - p.costPerShare) * trimQty : null,
            netProfit:     sellPrice != null ? (sellPrice - p.costPerShare) * trimQty - fees : r.netProfit,
            expectedProfit: sellPrice != null ? (sellPrice - p.costPerShare) * trimQty : r.expectedProfit,
            _costBasis:    p.costPerShare,
          });
        } else {
          result.push(r);
        }
      } else {
        // Trim spans multiple parcels — split
        const splitTotal = consumed.length;
        consumed.forEach(({ parcel: p, qty: trimQty }, i) => {
          const days = _daysSince(p.date);
          result.push({
            ...r,
            id:                   `${r.id}-p${p.id}`,
            qty:                  trimQty,
            _parcelId:            p.id,
            _parcelLabel:         `P#${p.id}`,
            _parcelCostPerShare:  p.costPerShare,
            _parcelDate:          p.date,
            _parcelRemainingQty:  p.remainingQty,
            _holdingDays:         days,
            _cgtEligible:         days != null && days > 365,
            _parcelUnrealisedPnl: sellPrice != null ? (sellPrice - p.costPerShare) * trimQty : null,
            netProfit:     sellPrice != null ? (sellPrice - p.costPerShare) * trimQty - (i === 0 ? fees : 0) : null,
            expectedProfit: sellPrice != null ? (sellPrice - p.costPerShare) * trimQty : r.expectedProfit,
            _costBasis:    p.costPerShare,
            _splitFrom:    r.id,
            _splitIndex:   i,
            _splitTotal:   splitTotal,
          });
        });
      }
    }
  }
  return result;
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
  // §9.3: max |ρ| vs holdings at generation time — lets later analysis answer
  // "do high-correlation entries underperform?" from the learning DB.
  const _corrM = window._lastCorrMatrix || {};
  const _holdingTickers = mergedPortfolio().map(h => h.ticker);

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

      // entry_signals_json: wide snapshot of the entry signature at log time (Sprint 71 Phase 1A).
      // Keeps the original 6 fields + adds price-location/volume/trend/RS/setup/fundamental fields.
      // All null-safe — the deterministic classifier treats the new fields as optional.
      const _sigs = state.liveSignals?.[r.ticker];
      // pct distance helper: (price/ref − 1) × 100, null when either input is missing/zero.
      const _pct = (px, ref) =>
        (typeof px === 'number' && typeof ref === 'number' && ref)
          ? +(((px / ref) - 1) * 100).toFixed(2)
          : null;
      const entry_signals_json = _sigs ? JSON.stringify({
        // — original 6 —
        rsi_14:     _sigs.rsi_14   ?? null,
        bb_pct_b:   _sigs.bb_pct_b ?? null,
        adx_14:     _sigs.adx      ?? null,
        atr_pct:    _sigs.atr_pct  ?? null,
        return_5d:  _sigs.return_5d  ?? null,
        return_20d: _sigs.return_20d ?? null,
        // — price location —
        px_vs_sma20:   _pct(_sigs.current_price, _sigs.sma_20),
        px_vs_sma50:   _pct(_sigs.current_price, _sigs.sma_50),
        px_vs_sma200:  _pct(_sigs.current_price, _sigs.sma_200),
        pct_from_high60: _pct(_sigs.current_price, _sigs.high_60d),
        pct_from_low60:  _pct(_sigs.current_price, _sigs.low_60d),
        // — volume —
        rvol: (typeof _sigs.volume_today === 'number' && _sigs.volume_avg_20)
                ? +(_sigs.volume_today / _sigs.volume_avg_20).toFixed(2) : null,
        adv_20: _sigs.adv_20 ?? null,
        // — trend (MACD) —
        macd_hist:      _sigs.macd_hist      ?? null,
        macd_hist_prev: _sigs.macd_hist_prev ?? null,
        macd_bullish:   _sigs.macd_bullish   ?? null,
        // — relative strength (not currently propagated to liveSignals → usually null) —
        rs_score:    _sigs.rs_score    ?? null,
        rs_5d_alpha: _sigs.rs_5d_alpha ?? null,
        // — setup —
        setup_score: _sigs.score ?? null,
        // — fundamentals —
        forward_pe:      _sigs.forward_pe      ?? null,
        pb_ratio:        _sigs.pb_ratio        ?? null,
        dividend_yield:  _sigs.dividend_yield  ?? null,
        revenue_growth:  _sigs.revenue_growth  ?? null,
        earnings_growth: _sigs.earnings_growth ?? null,
        days_to_earnings: _sigs.days_to_earnings ?? null,
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
        // §8.3: log Claude's ORIGINAL confidence — calibration stats measure the
        // model, so feeding back engine-adjusted values would compound the nudges.
        ai_confidence:       (r._calibApplied && r._calibApplied.orig != null)
                               ? r._calibApplied.orig : (r.confidence ?? null),
        ensemble_confidence: r.ensembleConfidence ?? null,
        recommendation:      r.action,
        rationale_summary:   r.reasoning ? reasoningText(r.reasoning).slice(0, 400) : null,
        bull_case:           r.bullCase ? String(r.bullCase).slice(0, 200) : null,
        bear_case:           r.bearCase ? String(r.bearCase).slice(0, 200) : null,
        suggested_stop:      r.stopLoss ?? null,
        suggested_target:    r.target ?? null,
        rr_ratio:            rrRatio != null ? +rrRatio.toFixed(2) : null,
        sector:              r.sector || holding?.sector || state.liveSignals[r.ticker]?.sector || null,
        was_executed:             false,
        market_context:           (() => {
          const rowC = _corrM[r.ticker] || {};
          let maxC = null;
          for (const h of _holdingTickers) {
            if (h === r.ticker) continue;
            const c = rowC[h];
            if (typeof c === 'number' && (maxC == null || Math.abs(c) > Math.abs(maxC))) maxC = c;
          }
          return { ..._mktCtx, max_corr_to_holdings: maxC != null ? +maxC.toFixed(2) : null };
        })(),
        debate_summary:           _debateSummary,
        entry_signals_json,
        debate_synthesis_winner,
        // Sprint 29: SELL/TRIM structured decision tags (set by Claude at generation time)
        ...(r.action === 'SELL' || r.action === 'TRIM' ? {
          sell_primary_driver:    r.primary_driver    ?? null,
          sell_secondary_factors: Array.isArray(r.secondary_factors)
            ? r.secondary_factors.join(',') : (r.secondary_factors ?? null),
          sell_urgency:           r.urgency           ?? null,
          // Sprint 37: Gap 7 — log alternativeTicker for better_opportunity cross-check
          alternative_ticker:     r.alternativeTicker ?? null,
          // Phase 2+3: deterministic thesis verdict computed client-side
          thesis_verdict:         r.thesis_verdict    ?? null,
        } : {}),
        // Sprint 67: BUY/TOP_UP structured entry driver (set by Claude). Normalised
        // to the allowed enum so a stray value lands as null rather than polluting
        // the thesis-accuracy matrix; backfill can fill nulls deterministically.
        ...(r.action === 'BUY' || r.action === 'TOP_UP' ? {
          primary_entry_driver: _ENTRY_DRIVERS.has(r.primary_entry_driver)
            ? r.primary_entry_driver : null,
        } : {}),
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
