// ============================================================
// DAY TRADING ANALYSIS ENGINE
// Swing-trading strategy: holds of 2-10 days, ATR-based sizing,
// BB + RSI + MACD confluence framework.
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

  if (state.serverOk && allTickers.length) {
    try { await fetchSignals(allTickers, true); } catch {}
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
      return `\n[${t}]
  Price=$${s.current_price} | Trend=${s.trend_direction} | ADX=${s.adx?.toFixed(1)} (${s.trend_strength})
  RSI14=${s.rsi_14?.toFixed(1)} | MACDhist=${s.macd_hist?.toFixed(4)} (prev=${s.macd_hist_prev?.toFixed(4)}) | Stoch%K=${s.stoch_k?.toFixed(1)}/%D=${s.stoch_d?.toFixed(1)}
  BB: Upper=$${s.bb_upper?.toFixed(3)}, Mid=$${s.bb_mid?.toFixed(3)}, Lower=$${s.bb_lower?.toFixed(3)}, %B=${s.bb_pct_b != null ? (s.bb_pct_b * 100).toFixed(0) + '%' : 'n/a'}
  ATR14=$${s.atr_14?.toFixed(3)} (${s.atr_pct?.toFixed(1)}%) | SMA20=$${s.sma_20?.toFixed(3)} | SMA50=${s.sma_50 ? '$' + s.sma_50.toFixed(3) : 'n/a'} | SMA200=${s.sma_200 ? '$' + s.sma_200.toFixed(3) : 'n/a'}
  Volume: ratio=${s.volume_ratio?.toFixed(2)}x avg20 | OBV=${s.obv_trend} | VWAP20=$${s.vwap_20d?.toFixed(3)}
  S/R: R2=$${sr.r2?.toFixed(3)}, R1=$${sr.r1?.toFixed(3)}, Pivot=$${sr.pivot?.toFixed(3)}, S1=$${sr.s1?.toFixed(3)}
  Returns: 1D=${s.return_1d?.toFixed(2)}%, 5D=${s.return_5d?.toFixed(2)}%, 20D=${s.return_20d?.toFixed(2)}%
  BuySignals: ${(s.buy_signals || []).join(', ') || 'none'} | SellSignals: ${(s.sell_signals || []).join(', ') || 'none'}`;
    }).join('\n');
  }

  // ── Cash and sizing ──────────────────────────────────────────────────────────
  const allocated = state.dayTrading.allocatedCash != null
    ? state.dayTrading.allocatedCash
    : Math.round(state.cash * 0.20);
  const riskPct = state.dayTrading.riskPct || 1.5;
  const riskPerTrade = allocated * riskPct / 100;

  // ── System prompt ────────────────────────────────────────────────────────────
  const systemPrompt = `You are a disciplined ASX swing-trader applying a technical confluence strategy.
Time horizon: 2–10 days per trade. You manage a ring-fenced day trading allocation (see user message).
Never force trades when setups are absent. Cash is the default when nothing qualifies.
Brokerage: $${state.settings.brokerage}/trade.

═══ HARD RULES ═══
1. Enter ONLY if ≥3 of 6 Entry Signals confirmed AND all 3 Entry Filters pass. Signal #1 is mandatory.
2. ATR sizing: qty = floor(riskPerTrade / (1.5 × atr_14)). Never exceed 20% of allocatedCash in one position.
3. R:R must be ≥ 2:1 (rewardAUD / riskAUD). Reject setup if R:R < 2.
4. Stop = entry − 1.5 × atr_14. Hard rule, no exceptions.
5. Skip ticker if earnings within 5 trading days (use earningsCalendar data).
6. Max 3 concurrent positions at once. If existing recs already cover 3, output no new BUYs.
7. LIMIT orders only.

═══ ENTRY SIGNALS (need ≥3 including #1) ═══
#1 [PRIMARY — MANDATORY] BB lower band: bb_pct_b ≤ 0.10 (price at or near lower Bollinger Band).
#2 RSI: rsi_14 < 40 AND return_5d > return_20d (RSI recovering, short-term momentum turning up).
#3 MACD: macd_hist > macd_hist_prev (histogram improving — bars shrinking bearish side or crossing positive).
#4 Stochastic: stoch_k < 25 AND stoch_k > stoch_d (crossing up from oversold).
#5 Volume: volume_ratio > 1.2 (today's volume 20% above 20-day average).
#6 OBV: obv_trend = "rising" while return_5d is negative (bullish OBV divergence).

═══ ENTRY FILTERS (ALL must pass) ═══
F1 Trend: current_price ≥ sma_200 (if sma_200 null, use current_price ≥ sma_50).
F2 ADX: adx < 30 OR trend_strength = "weak" (not in a strong trending-down regime).
F3 Catalyst: no earningsCalendar entry with nextEarningsDate within 5 days.

═══ TARGET & STOP ═══
Target = min(bb_upper, support_resistance.r1) — whichever is closer to entry.
Stop = entry − 1.5 × atr_14.
Reject if R:R < 2:1.

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
  "confidence": number (signals_hit / 6, min 0.50 to output),
  "holdDays": integer (2–10),
  "signalsHit": string[] (e.g. ["BB Primary","RSI<40","MACD improving"]),
  "filtersPass": {"aboveSMA200": boolean, "adxOk": boolean, "noCatalyst": boolean},
  "reasoning": string (MAX 100 chars),
  "stopReason": string (MAX 80 chars — single condition that invalidates this trade),
  "riskAUD": number,
  "rewardAUD": number,
  "rrRatio": number
}
summary: MAX 150 chars — market regime, setups found, cash deployed, key risk.
If no setups qualify: {"recs":[],"summary":"No valid setups — holding cash."}`;

  // ── User message ─────────────────────────────────────────────────────────────
  const userMessage = `Date: ${todayStr()} | Time: ${nowSydney()}

DAY TRADING ALLOCATION:
Allocated cash: $${fmt(allocated)} of $${fmt(state.cash)} total available
Risk per trade: ${riskPct}% = $${fmt(riskPerTrade)} max loss per trade
Brokerage: $${state.settings.brokerage}/trade

TICKERS TO SCAN: ${allTickers.join(', ')}
${indicatorCtx}${newsOutlook}${annCtx}${earningsCtx}

TASK:
For each ticker, check all 6 Entry Signals and 3 Entry Filters using the live data above.
Output a rec only if: Signal #1 (BB Primary) fires + ≥2 more signals + all filters pass + R:R ≥ 2:1.
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
      // Try to recover recs via brace-depth parser
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
    notes: `DayTrade | Target:$${rec.target} | Stop:$${rec.stopLoss} | R:R ${rec.rrRatio?.toFixed(1)}x`,
  };
  state.tradeJournal.unshift(entry);
  state.cash -= cost;
  rec.status = 'executed';
  scheduleSave();
  pushCashToDb(state.cash);
  toast(`Executed ${rec.ticker} day trade — ${rec.qty} shares @ $${entryPrice.toFixed(3)}`, 'success');
  renderPage();
}

function dismissDayTradeRec(recId) {
  const rec = state.dayTrading.recommendations.find(r => r.id === recId);
  if (rec) rec.status = 'dismissed';
  scheduleSave();
  renderPage();
}
