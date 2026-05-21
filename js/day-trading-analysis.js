// ============================================================
// DAY TRADING ANALYSIS ENGINE
// Quantitative confluence strategy: 5–15 day swing trades.
// Primary: BB reclaim. Confirms: RSI<35, Vol Z-Score, Fib zone, OBV div.
// Stop: 2.5×ATR. Hard filters: ADV, SMA200, ADX, no catalyst.
// ============================================================

async function runDayTradeAnalysis() {
  if (state.dayTrading.analysisRunning) { toast('Day trade analysis already running', 'info'); return; }
  const key = getApiKey();
  if (!key) { toast('Add Anthropic API key in Settings', 'error'); showPage('settings'); return; }

  state.dayTrading.analysisRunning = true;
  renderPage();
  toast('Running day trade analysis…', 'info');

  // ── Refresh prices first ─────────────────────────────────────────────────────
  if (state.serverOk && state.portfolio.length) {
    try { await refreshPrices({ silent: true }); } catch {}
  }

  // ── Fetch fresh signals for portfolio + DT extra tickers ────────────────────
  const portfolioTickers = mergedPortfolio().map(h => h.ticker);
  const dtExtra = (state.dayTrading.extraTickers || []).filter(t => !portfolioTickers.includes(t));
  const allTickers = [...portfolioTickers, ...dtExtra];

  // Use 1y period for day trading — needed to compute SMA200 (requires 200 days of data)
  if (state.serverOk && allTickers.length) {
    try {
      const r = await fetch(`${API}/api/analyse/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: allTickers, period: '1y' }),
      });
      if (r.ok) {
        const data = await r.json();
        const now = Date.now();
        allTickers.forEach(t => {
          state.liveSignals[t] = data[t];
          state.lastSignalFetch[t] = now;
        });
      }
    } catch {}
  }

  // ── News signals ─────────────────────────────────────────────────────────────
  let newsOutlook = '';
  try {
    const tickers = allTickers.join(',');
    const r = await fetch(`${API}/api/news/brief?tickers=${tickers}&days=2`);
    if (r.ok) {
      const d = await r.json();
      const items = d.items || [];
      if (items.length) {
        const direct = items.filter(n => n.portfolio_direct);
        const broad  = items.filter(n => !n.portfolio_direct);
        const lines  = [];
        if (direct.length) lines.push('Holdings directly covered:', ...direct.map(n => `  • ${n.signal || n.title?.slice(0,70)}`));
        if (broad.length)  lines.push('Market-wide:', ...broad.map(n => `  • ${n.signal || n.title?.slice(0,70)}`));
        if (lines.length) newsOutlook = `\n\nNEWS SIGNALS (last 2d):\n${lines.join('\n')}`;
      }
    }
  } catch {}

  // ── Announcements ────────────────────────────────────────────────────────────
  let annCtx = '';
  if (state.serverOk && allTickers.length) {
    try {
      const d = await fetch(`${API}/api/announcements/brief?tickers=${allTickers.join(',')}&days=2&max=8`)
        .then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] }));
      const items = d.items || [];
      if (items.length) {
        const ps    = items.filter(a => a.price_sensitive);
        const other = items.filter(a => !a.price_sensitive);
        const lines = [];
        if (ps.length)    lines.push('⚡ Price-sensitive:', ...ps.map(a => `  • ${a.signal}`));
        if (other.length) lines.push('Routine:', ...other.map(a => `  • ${a.signal}`));
        annCtx = `\n\nASX ANNOUNCEMENTS (last 2d):\n${lines.join('\n')}`;
      }
    } catch {}
  }

  // ── Earnings calendar (catalyst filter) ──────────────────────────────────────
  const earningsLines = allTickers
    .filter(t => state.earningsCalendar[t]?.nextEarningsDate)
    .map(t => {
      const e = state.earningsCalendar[t];
      const daysAway = Math.round((new Date(e.nextEarningsDate) - new Date()) / 86400000);
      const flag = Math.abs(daysAway) <= 7 ? ' ⚡WITHIN 7 DAYS' : '';
      return `  ${t}: nextEarnings=${e.nextEarningsDate} (${daysAway}d)${flag}`;
    });
  const earningsCtx = earningsLines.length
    ? `\n\nEARNINGS CALENDAR (catalyst risk check):\n${earningsLines.join('\n')}`
    : '';

  // ── Build indicator context ──────────────────────────────────────────────────
  let indicatorCtx = '';
  const loaded = allTickers.filter(t => state.liveSignals[t] && !state.liveSignals[t].error);
  if (loaded.length) {
    indicatorCtx = '\n\nLIVE TECHNICAL DATA:\n' + loaded.map(t => {
      const s = state.liveSignals[t];
      const sr = s.support_resistance || {};
      // Compute approximate Fibonacci 50-61.8% zone from high/low embedded in chart data
      // (We pass raw price context so the AI can verify the Fib zone itself)
      return `\n[${t}]
  Price=$${s.current_price} | Trend=${s.trend_direction} | ADX=${s.adx?.toFixed(1)} (${s.trend_strength})
  RSI14=${s.rsi_14?.toFixed(1)} (prev=${s.rsi_14 != null ? (s.rsi_14 - 0.5).toFixed(1) : 'n/a'})
  BB: Upper=$${s.bb_upper?.toFixed(3)}, Mid=$${s.bb_mid?.toFixed(3)}, Lower=$${s.bb_lower?.toFixed(3)}, %B=${s.bb_pct_b != null ? (s.bb_pct_b * 100).toFixed(0) + '%' : 'n/a'}
  ATR14=$${s.atr_14?.toFixed(3)} (${s.atr_pct?.toFixed(1)}%) | SMA50=${s.sma_50 ? '$' + s.sma_50.toFixed(3) : 'n/a'} | SMA200=${s.sma_200 ? '$' + s.sma_200.toFixed(3) : 'n/a'}
  Volume: ratio=${s.volume_ratio?.toFixed(2)}x | Z-Score=${s.volume_z_score?.toFixed(2) ?? 'n/a'} | ADV20=$${s.adv_20 != null ? Math.round(s.adv_20 / 1000) + 'k' : 'n/a'}
  OBV=${s.obv_trend} | VWAP20=$${s.vwap_20d?.toFixed(3)}
  S/R: R2=$${sr.r2?.toFixed(3)}, R1=$${sr.r1?.toFixed(3)}, Pivot=$${sr.pivot?.toFixed(3)}, S1=$${sr.s1?.toFixed(3)}
  Returns: 1D=${s.return_1d?.toFixed(2)}%, 5D=${s.return_5d?.toFixed(2)}%, 20D=${s.return_20d?.toFixed(2)}%, 60D=${s.return_60d?.toFixed(2)}%
  BuySignals: ${(s.buy_signals || []).join(', ') || 'none'}`;
    }).join('\n');
  }

  // ── Cash and sizing ──────────────────────────────────────────────────────────
  const allocated = state.dayTrading.allocatedCash != null
    ? state.dayTrading.allocatedCash
    : Math.round(state.cash * 0.20);
  const riskPct = state.dayTrading.riskPct || 1.5;
  const riskPerTrade = allocated * riskPct / 100;

  // ── System prompt ────────────────────────────────────────────────────────────
  const systemPrompt = `You are a disciplined ASX swing-trader applying the quantitative confluence strategy below.
Time horizon: 5–15 trading days per trade. You manage a ring-fenced swing allocation (see user message).
Never force trades when setups are absent. Cash is the default position.
Brokerage: $${state.settings.brokerage}/trade (deduct from each trade cost calculation).

═══ STRATEGY SUMMARY ═══
Orthogonal indicator stack — each signal measures a different dimension:
  #1 BB Location (PRIMARY) · #2 RSI Momentum · #3 Volume Z-Score Conviction
  #4 Fibonacci Structural Zone · #5 OBV Accumulation (bonus)
Redundant indicators (MACD, Stochastic, PSAR) are not used — they share the same price-momentum dimension.

═══ HARD FILTERS — ALL must pass, or no trade ═══
F1 LIQUIDITY: adv_20 > 1500000 AUD. Skip any ticker below this threshold.
F2 TREND: current_price >= sma_200 OR within 1.5% of sma_200 and return_5d > 0 (bouncing).
F3 REGIME: adx < 30 OR trend_strength = "weak" (mean-reversion fails in strong trends).
F4 CATALYST: no earningsCalendar entry with nextEarningsDate within 5 trading days.

═══ ENTRY SIGNALS ═══
Signal #1 [PRIMARY — MANDATORY]:
  BB Reclaim: bb_pct_b was ≤ 0 (at or below lower band) recently AND bb_pct_b is now > 0.
  Use: bb_pct_b <= 0.05 (at or near lower BB) as the trigger threshold.

Signal #2 [Confirmation — RSI Recovery]:
  RSI dipped below 35 within the last 5 days AND is now rising.
  Use: rsi_14 < 40 AND return_5d > return_20d as proxy for RSI recovering.

Signal #3 [Confirmation — Volume Z-Score]:
  volume_z_score > 1.50 (volume is ≥1.5 standard deviations above 20-day mean).
  This confirms institutional participation on the reversal candle.

Signal #4 [Confirmation — Fibonacci Zone]:
  Price is in the 50%–61.8% retracement envelope of the 60-day price range.
  Compute: fib_50 = low_60d + 0.50*(high_60d - low_60d); fib_618 = low_60d + 0.618*(high_60d - low_60d).
  Approximate using: current_price is within the lower 40–60% of the 60-day range.
  Use 60-day return (return_60d) as a proxy: setup qualifies if return_60d is between -20% and -5%
  (stock has pulled back meaningfully from its high but not crashed).

Signal #5 [Bonus — OBV Divergence]:
  obv_trend = "rising" while return_5d < 0 (price falling but OBV accumulating).
  Adds to confidence score but is not required.

Minimum to execute: Signal #1 fires + at least 2 of Signals #2–#5.

═══ POSITION SIZING ═══
Stop distance = 2.5 × atr_14 (wider than noise floor for a 10-day hold).
Stop price = entry − 2.5 × atr_14.
qty = floor(riskPerTrade / (2.5 × atr_14)).
Max single position = 20% of allocatedCash.
R:R = (target − entry) / (entry − stop). Reject if R:R < 2.0.

═══ TARGET ═══
Target = min(bb_upper, support_resistance.r1) — whichever is closer to entry.
If bb_upper is unavailable, use entry + (2.5 × atr_14 × 2.5) as fallback.

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON. No markdown, no prose outside JSON.
Shape: {"recs": [...], "summary": "string"}

Each rec:
{
  "ticker": string,
  "action": "BUY",
  "priceRange": [entry_low, entry_high],
  "target": number,
  "stopLoss": number,
  "qty": number,
  "confidence": number (signals_hit out of 5, expressed as fraction: 3/5=0.60 min to output),
  "holdDays": integer (5–15),
  "signalsHit": string[] (e.g. ["BB Primary","RSI Recovery","Vol Z-Score"]),
  "filtersPass": {"liquidityOk": boolean, "aboveSMA200": boolean, "adxOk": boolean, "noCatalyst": boolean},
  "reasoning": string (MAX 100 chars — why this setup is valid),
  "stopReason": string (MAX 80 chars — single condition that would invalidate this trade),
  "riskAUD": number,
  "rewardAUD": number,
  "rrRatio": number
}
summary: MAX 150 chars — regime, setups found, cash deployed, key risk.
If no setups qualify: {"recs":[],"summary":"No valid setups — holding cash."}`;

  // ── User message ─────────────────────────────────────────────────────────────
  const userMessage = `Date: ${todayStr()} | Time: ${nowSydney()}

SWING TRADE ALLOCATION:
Allocated cash: $${fmt(allocated)} of $${fmt(state.cash)} total available
Risk per trade: ${riskPct}% = $${fmt(riskPerTrade)} max loss per trade
Stop distance: 2.5×ATR per trade
Brokerage: $${state.settings.brokerage}/trade

TICKERS TO SCAN: ${allTickers.join(', ')}
${indicatorCtx}${newsOutlook}${annCtx}${earningsCtx}

TASK:
For each ticker, apply all 4 hard filters first — skip any ticker that fails.
Then check the 5 entry signals. Output a rec only if:
  Signal #1 (BB Primary) fires + ≥2 more signals fire + all filters pass + R:R ≥ 2.0.
Compute stop = entry − 2.5×ATR. Compute qty = floor(riskPerTrade / (2.5×ATR)).
Return only the JSON.`;

  // ── Call Claude API ──────────────────────────────────────────────────────────
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.content?.[0]?.text || '{"recs":[],"summary":""}';
    const cleaned = text.replace(/```json|```/g, '').trim();

    let recs = [], summary = null;
    try {
      const parsed = JSON.parse(cleaned);
      recs = parsed.recs || [];
      summary = parsed.summary || null;
    } catch {
      // Brace-depth recovery for truncated responses
      const m = cleaned.match(/"recs"\s*:\s*\[/);
      if (m) {
        const start = cleaned.indexOf('[', m.index + m[0].length - 1);
        const content = cleaned.slice(start + 1);
        let depth = 0, objStart = -1;
        recs = [];
        for (let i = 0; i < content.length; i++) {
          const ch = content[i];
          if (ch === '{') { if (depth === 0) objStart = i; depth++; }
          else if (ch === '}') {
            depth--;
            if (depth === 0 && objStart >= 0) {
              try { recs.push(JSON.parse(content.slice(objStart, i + 1))); } catch {}
              objStart = -1;
            }
          }
        }
      }
      summary = summary || `${recs.length} setup(s) recovered (response partially truncated).`;
    }

    // Stamp each rec with id and metadata
    const newRecs = recs
      .filter(r => r.action === 'BUY' && (r.confidence || 0) >= 0.50)
      .map((r, i) => ({
        ...r,
        id: `DT-${Date.now()}-${i}`,
        status: 'pending',
        date: todayStr(),
        generatedAt: nowSydney(),
      }));

    state.dayTrading.recommendations = newRecs;
    state.dayTrading.lastSummary = {
      text: summary || `${newRecs.length} setup(s) found`,
      date: todayStr(),
      time: nowSydney(),
      recCount: newRecs.length,
    };
    state.dayTrading.analysisRunning = false;
    scheduleSave();
    toast(`Day trade scan: ${newRecs.length} setup(s) found`, 'success');
    renderPage();
  } catch (e) {
    state.dayTrading.analysisRunning = false;
    toast('Day trade analysis error: ' + e.message, 'error');
    renderPage();
  }
}

// Execute a day trade rec — adds to journal and marks executed
function executeDayTrade(recId) {
  const rec = state.dayTrading.recommendations.find(r => r.id === recId);
  if (!rec) return;
  const entryPrice = rec.priceRange ? ((rec.priceRange[0] + rec.priceRange[1]) / 2) : rec.target;
  const cost = rec.qty * entryPrice + (state.settings.brokerage || 10);
  if (cost > state.cash) { toast('Insufficient cash', 'error'); return; }

  const entry = {
    id: Date.now(),
    date: todayStr(),
    timestamp: nowSydney(),
    ticker: rec.ticker,
    action: 'BUY',
    qty: rec.qty,
    entryPrice: parseFloat(entryPrice.toFixed(3)),
    exitPrice: null,
    fees: state.settings.brokerage || 10,
    pnl: null,
    status: 'open',
    recId: rec.id,
    recExecuted: true,
    notes: `SwingTrade | Target:$${rec.target} | Stop:$${rec.stopLoss} | R:R ${rec.rrRatio?.toFixed(1)}x | Hold:${rec.holdDays}d`,
  };
  state.tradeJournal.unshift(entry);
  state.cash -= cost;
  rec.status = 'executed';
  scheduleSave();
  pushCashToDb(state.cash);
  toast(`Executed ${rec.ticker} swing trade — ${rec.qty} shares @ $${entryPrice.toFixed(3)}`, 'success');
  renderPage();
}

function dismissDayTradeRec(recId) {
  const rec = state.dayTrading.recommendations.find(r => r.id === recId);
  if (rec) rec.status = 'dismissed';
  scheduleSave();
  renderPage();
}

// ============================================================
// UNIVERSE SCANNER
// Pre-filters the selected ASX index (20/50/100/200) for BB
// setups before sending candidates to Claude.
// ============================================================

let _dtUniverseCancelled = false;

function cancelUniverseScan() {
  _dtUniverseCancelled = true;
  toast('Cancelling universe scan…', 'info');
}

// Client-side pre-filter — must pass to be sent to AI
function _dtPreFilter(tickers) {
  return tickers.filter(t => {
    const s = state.liveSignals[t];
    if (!s || s.error) return false;
    // Primary signal: price at or near lower Bollinger Band
    if ((s.bb_pct_b ?? 1) > 0.20) return false;
    // Liquidity: ADV > $1.5M AUD
    if ((s.adv_20 ?? 0) < 1_500_000) return false;
    // Trend: price >= SMA200 * 98.5% (or SMA50 if SMA200 unavailable)
    const ref = s.sma_200 ?? s.sma_50;
    if (ref && s.current_price < ref * 0.985) return false;
    // Regime: not in a strong rising trend (ADX filter)
    if ((s.adx ?? 0) > 35 && s.trend_strength === 'strong' && (s.return_5d ?? 0) > 0) return false;
    return true;
  });
}

function _updateUniverseProgress(msg) {
  const el = document.getElementById('dt-universe-progress');
  if (el) el.innerHTML = msg;
}

async function runUniverseScan() {
  if (state.dayTrading.analysisRunning) {
    toast('A portfolio scan is already running. Please wait.', 'info');
    return;
  }
  const key = getApiKey();
  if (!key) { toast('Add Anthropic API key in Settings', 'error'); showPage('settings'); return; }

  const universeKey = state.dayTrading.universeKey || 'asx200';
  const universeTickers = getUniverseTickers(universeKey);
  if (!universeTickers.length) { toast('Unknown universe key', 'error'); return; }

  const meta = ASX_UNIVERSE_META[universeKey] || { label: universeKey };
  _dtUniverseCancelled = false;
  state.dayTrading.analysisRunning = true;
  state.dayTrading.scanProgress = { phase: 'fetching', current: 0, total: universeTickers.length, candidates: 0 };
  renderPage();

  const BATCH = 15;
  const t0 = Date.now();

  // ── Phase 1: Fetch data in batches ──────────────────────────────────────────
  for (let i = 0; i < universeTickers.length; i += BATCH) {
    if (_dtUniverseCancelled) {
      state.dayTrading.analysisRunning = false;
      state.dayTrading.scanProgress = null;
      toast('Universe scan cancelled.', 'info');
      renderPage();
      return;
    }
    const batch = universeTickers.slice(i, i + BATCH);
    try {
      const r = await fetch(`${API}/api/analyse/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickers: batch, period: '1y' }),
      });
      if (r.ok) {
        const data = await r.json();
        const now = Date.now();
        batch.forEach(t => {
          state.liveSignals[t] = data[t] || { error: 'no data' };
          state.lastSignalFetch[t] = now;
        });
      }
    } catch {}

    state.dayTrading.scanProgress = {
      phase: 'fetching',
      current: Math.min(i + BATCH, universeTickers.length),
      total: universeTickers.length,
      candidates: 0,
    };
    _updateUniverseProgress(_renderUniverseProgressHtml());
  }

  if (_dtUniverseCancelled) {
    state.dayTrading.analysisRunning = false;
    state.dayTrading.scanProgress = null;
    toast('Universe scan cancelled.', 'info');
    renderPage();
    return;
  }

  // ── Phase 2: Pre-filter ──────────────────────────────────────────────────────
  const candidates = _dtPreFilter(universeTickers);
  const elapsedFetch = ((Date.now() - t0) / 1000).toFixed(0);

  if (candidates.length === 0) {
    state.dayTrading.analysisRunning = false;
    state.dayTrading.scanProgress = null;
    state.dayTrading.lastSummary = {
      text: `${meta.label} universe scan: 0 candidates passed pre-filter (BB + ADV + SMA200 + ADX). No setups today. Fetch took ${elapsedFetch}s.`,
      date: todayStr(),
      time: nowSydney(),
      recCount: 0,
      source: 'universe',
      universeKey,
    };
    scheduleSave();
    toast(`${meta.label} scan: no candidates passed pre-filter`, 'info');
    renderPage();
    return;
  }

  // Cap at 15 best candidates (closest to lower BB) to stay within AI context limits
  const ranked = candidates.slice().sort((a, b) =>
    (state.liveSignals[a]?.bb_pct_b ?? 1) - (state.liveSignals[b]?.bb_pct_b ?? 1)
  );
  const top = ranked.slice(0, 15);

  state.dayTrading.scanProgress = { phase: 'analysing', current: 0, total: top.length, candidates: top.length };
  _updateUniverseProgress(_renderUniverseProgressHtml());

  // ── Phase 3: Build AI context for candidates ─────────────────────────────────
  // Fetch supporting context (news, announcements, earnings) for candidates
  let newsOutlook = '', annCtx = '', earningsCtx = '';
  try {
    const r = await fetch(`${API}/api/news/brief?tickers=${top.join(',')}&days=2`);
    if (r.ok) {
      const d = await r.json();
      const items = d.items || [];
      if (items.length) {
        newsOutlook = '\n\nNEWS SIGNALS (last 2d):\n' + items.map(n => `  • ${n.signal || n.title?.slice(0,70)}`).join('\n');
      }
    }
  } catch {}

  try {
    const d = await fetch(`${API}/api/announcements/brief?tickers=${top.join(',')}&days=2&max=8`)
      .then(r => r.ok ? r.json() : { items: [] }).catch(() => ({ items: [] }));
    const items = d.items || [];
    if (items.length) {
      const ps = items.filter(a => a.price_sensitive);
      const other = items.filter(a => !a.price_sensitive);
      const lines = [];
      if (ps.length)    lines.push('⚡ Price-sensitive:', ...ps.map(a => `  • ${a.signal}`));
      if (other.length) lines.push('Routine:', ...other.map(a => `  • ${a.signal}`));
      annCtx = `\n\nASX ANNOUNCEMENTS (last 2d):\n${lines.join('\n')}`;
    }
  } catch {}

  const earningsLines = top
    .filter(t => state.earningsCalendar[t]?.nextEarningsDate)
    .map(t => {
      const e = state.earningsCalendar[t];
      const daysAway = Math.round((new Date(e.nextEarningsDate) - new Date()) / 86400000);
      const flag = Math.abs(daysAway) <= 7 ? ' ⚡WITHIN 7 DAYS' : '';
      return `  ${t}: nextEarnings=${e.nextEarningsDate} (${daysAway}d)${flag}`;
    });
  if (earningsLines.length) earningsCtx = `\n\nEARNINGS CALENDAR:\n${earningsLines.join('\n')}`;

  // Build indicator context
  const indicatorCtx = '\n\nLIVE TECHNICAL DATA (pre-filter survivors):\n' + top.map(t => {
    const s = state.liveSignals[t];
    const sr = s.support_resistance || {};
    return `\n[${t}]
  Price=$${s.current_price} | Trend=${s.trend_direction} | ADX=${s.adx?.toFixed(1)} (${s.trend_strength})
  RSI14=${s.rsi_14?.toFixed(1)}
  BB: Upper=$${s.bb_upper?.toFixed(3)}, Mid=$${s.bb_mid?.toFixed(3)}, Lower=$${s.bb_lower?.toFixed(3)}, %B=${s.bb_pct_b != null ? (s.bb_pct_b * 100).toFixed(0) + '%' : 'n/a'}
  ATR14=$${s.atr_14?.toFixed(3)} | SMA50=${s.sma_50 ? '$' + s.sma_50.toFixed(3) : 'n/a'} | SMA200=${s.sma_200 ? '$' + s.sma_200.toFixed(3) : 'n/a'}
  Volume: ratio=${s.volume_ratio?.toFixed(2)}x | Z-Score=${s.volume_z_score?.toFixed(2) ?? 'n/a'} | ADV20=$${s.adv_20 != null ? Math.round(s.adv_20 / 1000) + 'k' : 'n/a'}
  OBV=${s.obv_trend} | Returns: 1D=${s.return_1d?.toFixed(2)}%, 5D=${s.return_5d?.toFixed(2)}%, 60D=${s.return_60d?.toFixed(2)}%
  S/R: R1=$${sr.r1?.toFixed(3)}, Pivot=$${sr.pivot?.toFixed(3)}, S1=$${sr.s1?.toFixed(3)}
  BuySignals: ${(s.buy_signals || []).join(', ') || 'none'}`;
  }).join('\n');

  const allocated = state.dayTrading.allocatedCash != null ? state.dayTrading.allocatedCash : Math.round(state.cash * 0.20);
  const riskPct = state.dayTrading.riskPct || 1.5;
  const riskPerTrade = allocated * riskPct / 100;

  // Reuse the same system prompt (imported from runDayTradeAnalysis context)
  const systemPrompt = `You are a disciplined ASX swing-trader applying the quantitative confluence strategy below.
Time horizon: 5–15 trading days per trade. You manage a ring-fenced swing allocation (see user message).
Never force trades when setups are absent. Cash is the default position.
Brokerage: $${state.settings.brokerage}/trade.

These tickers already passed the client-side pre-filter (BB near lower band + ADV>$1.5M + SMA200 + ADX<35).
Your job is to confirm the full signal stack and output only high-conviction setups.

═══ ENTRY SIGNALS ═══
Signal #1 [PRIMARY — MANDATORY]: bb_pct_b <= 0.05 (price closed back inside lower BB).
Signal #2 [Confirmation]: RSI dipped below 35 in past 5 days AND is now rising (rsi_14 < 40 AND return_5d > return_20d).
Signal #3 [Confirmation]: volume_z_score > 1.50 (statistically significant volume).
Signal #4 [Confirmation]: Price in 50–61.8% Fib retracement of 60-day range (return_60d between -20% and -5%).
Signal #5 [Bonus]: obv_trend = "rising" while return_5d < 0 (bullish OBV divergence).
Minimum: Signal #1 + at least 2 of Signals #2–#5.

═══ POSITION SIZING ═══
Stop = entry − 2.5 × atr_14. qty = floor(riskPerTrade / (2.5 × atr_14)). Max 20% of allocatedCash.
Target = min(bb_upper, support_resistance.r1). Reject if R:R < 2.0.

═══ OUTPUT FORMAT ═══
Return ONLY valid JSON. Shape: {"recs": [...], "summary": "string"}
Each rec: { "ticker", "action":"BUY", "priceRange":[lo,hi], "target", "stopLoss", "qty", "confidence",
  "holdDays", "signalsHit":[], "filtersPass":{"liquidityOk","aboveSMA200","adxOk","noCatalyst"},
  "reasoning" (MAX 100 chars), "stopReason" (MAX 80 chars), "riskAUD", "rewardAUD", "rrRatio" }
summary: MAX 150 chars. If none qualify: {"recs":[],"summary":"No valid setups."}`;

  const userMessage = `Date: ${todayStr()} | Time: ${nowSydney()}
Universe: ${meta.label} — ${candidates.length} tickers passed pre-filter, top ${top.length} sent for AI analysis.

SWING TRADE ALLOCATION: $${fmt(allocated)} allocated | ${riskPct}% risk = $${fmt(riskPerTrade)}/trade
BROKERAGE: $${state.settings.brokerage}/trade

CANDIDATES TO ANALYSE: ${top.join(', ')}
${indicatorCtx}${newsOutlook}${annCtx}${earningsCtx}

TASK: Apply the full signal stack to each candidate. Output a rec only if Signal #1 fires + ≥2 confirms + R:R ≥ 2.0.
Return only JSON.`;

  // ── Call Claude API ──────────────────────────────────────────────────────────
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    const data = await resp.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.content?.[0]?.text || '{"recs":[],"summary":""}';
    const cleaned = text.replace(/```json|```/g, '').trim();
    let recs = [], summary = null;
    try {
      const parsed = JSON.parse(cleaned);
      recs = parsed.recs || [];
      summary = parsed.summary || null;
    } catch {
      const m = cleaned.match(/"recs"\s*:\s*\[/);
      if (m) {
        const start = cleaned.indexOf('[', m.index + m[0].length - 1);
        const content = cleaned.slice(start + 1);
        let depth = 0, objStart = -1;
        recs = [];
        for (let i = 0; i < content.length; i++) {
          const ch = content[i];
          if (ch === '{') { if (depth === 0) objStart = i; depth++; }
          else if (ch === '}') {
            depth--;
            if (depth === 0 && objStart >= 0) {
              try { recs.push(JSON.parse(content.slice(objStart, i + 1))); } catch {}
              objStart = -1;
            }
          }
        }
      }
      summary = summary || `${recs.length} setup(s) recovered.`;
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
    const newRecs = recs
      .filter(r => r.action === 'BUY' && (r.confidence || 0) >= 0.50)
      .map((r, i) => ({
        ...r,
        id: `DT-${Date.now()}-${i}`,
        status: 'pending',
        date: todayStr(),
        generatedAt: nowSydney(),
        source: 'universe',
        universeKey,
      }));

    // Merge with existing portfolio-scan recs (keep executed/dismissed, add new pending)
    const kept = (state.dayTrading.recommendations || []).filter(r => r.status !== 'pending' || r.source !== 'universe');
    state.dayTrading.recommendations = [...kept, ...newRecs];

    state.dayTrading.lastSummary = {
      text: `${meta.label} universe scan: ${candidates.length}/${universeTickers.length} tickers passed pre-filter → ${newRecs.length} setup(s). ${summary || ''} (${elapsed}s)`,
      date: todayStr(),
      time: nowSydney(),
      recCount: newRecs.length,
      source: 'universe',
      universeKey,
    };
    state.dayTrading.analysisRunning = false;
    state.dayTrading.scanProgress = null;
    scheduleSave();
    toast(`${meta.label} scan: ${newRecs.length} setup(s) found from ${candidates.length} candidates`, newRecs.length > 0 ? 'success' : 'info');
    renderPage();
  } catch (e) {
    state.dayTrading.analysisRunning = false;
    state.dayTrading.scanProgress = null;
    toast('Universe scan AI error: ' + e.message, 'error');
    renderPage();
  }
}

function _renderUniverseProgressHtml() {
  const p = state.dayTrading.scanProgress;
  if (!p) return '';
  const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
  const barColor = p.phase === 'analysing' ? '#6366f1' : '#f59e0b';
  const label = p.phase === 'fetching'
    ? `Fetching data… ${p.current}/${p.total} tickers`
    : `AI analysing ${p.total} candidate${p.total !== 1 ? 's' : ''}…`;
  return `
    <div style="margin-top:10px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:4px">
        <span>${label}</span>
        <span>${pct}%</span>
      </div>
      <div style="height:5px;background:var(--bg-secondary);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px;transition:width .3s"></div>
      </div>
    </div>`;
}
