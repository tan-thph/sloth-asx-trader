// ============================================================
// AI ASSISTANT
// ============================================================
function renderAssistant() {
  const key=getApiKey();
  return `
    <div class="card chat-wrap">
      <div class="card-title">AI Trading Assistant &mdash; Powered by Claude</div>
      ${!key?`<div class="info-banner">⚠ Enter your Anthropic API key in <button onclick="showPage('settings')" style="background:none;border:none;color:inherit;cursor:pointer;font-weight:600;text-decoration:underline">Settings</button> to enable AI analysis.</div>`:''}
      <div id="chat-messages" class="chat-messages">
        <div class="msg msg-ai">Hello! I'm your ASX trading assistant. I have access to real-time technical indicators for your portfolio via yfinance.<br><br>Try: <em>"Analyse my TLS position with the latest indicators"</em> or <em>"What does the RSI and MACD say about CBA?"</em></div>
        ${state.chatHistory.map(m=>`<div class="msg msg-${m.role}">${m.content}</div>`).join('')}
      </div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" placeholder="Ask about stocks, indicators, or strategy..." onkeydown="if(event.key==='Enter')sendChat()">
        <button class="btn btn-primary" onclick="sendChat()">Send</button>
      </div>
    </div>
  `;
}
async function sendChat() {
  const input=document.getElementById('chat-input');
  const msg=input.value.trim(); if(!msg) return;
  const key=getApiKey();
  if(!key) { toast('Add API key in Settings','error'); return; }
  input.value='';
  state.chatHistory.push({role:'user',content:msg});
  const msgs=document.getElementById('chat-messages');
  msgs.innerHTML+=`<div class="msg msg-user">${escapeHTML(msg)}</div>`;
  msgs.innerHTML+=`<div class="msg msg-ai" id="typing"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;
  msgs.scrollTop=msgs.scrollHeight;

  // ── Portfolio snapshot ────────────────────────────────────────────────────
  const merged = mergedPortfolio();
  const pv = portfolioValue(), tc = totalCost(), gain = totalGain();
  const gainPct = tc > 0 ? (gain/tc*100) : 0;
  const ps = merged.map(h => {
    const val = h.shares * h.currentPrice;
    const pl  = (h.currentPrice - h.avgPrice) * h.shares;
    const plp = ((h.currentPrice - h.avgPrice) / h.avgPrice * 100).toFixed(1);
    const wt  = pv > 0 ? (val/pv*100).toFixed(1) : '0';
    return `${h.ticker}(${h.shares}sh @$${h.currentPrice.toFixed(2)}, cost $${h.avgPrice.toFixed(2)}, P&L ${pl>=0?'+':''}$${fmt(Math.abs(pl))} / ${plp}%, wt ${wt}%)`;
  }).join('\n  ');

  // Top gainer / loser context
  const sorted = [...merged].sort((a,b)=>((b.currentPrice-b.avgPrice)/b.avgPrice)-((a.currentPrice-a.avgPrice)/a.avgPrice));
  const topGainer = sorted[0], topLoser = sorted[sorted.length-1];
  const gainLossCtx = sorted.length >= 2
    ? `\nTop gainer: ${topGainer.ticker} +${fmt((topGainer.currentPrice-topGainer.avgPrice)/topGainer.avgPrice*100)}%  |  Top loser: ${topLoser.ticker} ${fmt((topLoser.currentPrice-topLoser.avgPrice)/topLoser.avgPrice*100)}%`
    : '';

  // ── Technical indicators ──────────────────────────────────────────────────
  let indicatorCtx='';
  const loadedTickers=Object.keys(state.liveSignals).filter(t=>!state.liveSignals[t]?.error);
  if(loadedTickers.length) {
    indicatorCtx='\n\nLIVE TECHNICAL INDICATORS:\n'+loadedTickers.map(t=>{
      const s=state.liveSignals[t];
      return `${t}: RSI14=${s.rsi_14?.toFixed(1)}, MACD_hist=${s.macd_hist?.toFixed(3)}, Signal=${s.composite_signal}, Conf=${(s.confidence*100).toFixed(0)}%, Trend=${s.trend_direction}, ADX=${s.adx?.toFixed(1)}, BB%B=${s.bb_pct_b!=null?(s.bb_pct_b*100).toFixed(0)+'%':'n/a'}, SMA20=$${s.sma_20?.toFixed(3)}, MFI=${s.mfi?.toFixed(1)}, ATR=${s.atr_14?.toFixed(3)}`;
    }).join('\n');
  }

  // ── Dividend context ──────────────────────────────────────────────────────
  const chatDivLines = merged
    .filter(h => state.dividendData[h.ticker] && !state.dividendData[h.ticker].error)
    .map(h => {
      const d = state.dividendData[h.ticker];
      const yld = d.dividendYield != null ? (d.dividendYield*100).toFixed(2)+'%' : 'n/a';
      const ann = d.annualDivPerShare != null ? '$'+d.annualDivPerShare.toFixed(4)+'/yr/share' : 'n/a';
      const ex  = d.exDividendDate || 'unknown';
      const inc = d.annualDivPerShare != null ? '$'+fmt(h.shares * d.annualDivPerShare)+'/yr income' : '';
      return `${h.ticker}: yield=${yld}, annual=${ann}, exDiv=${ex}, freq=${d.frequencyLabel||'?'}${inc?' — '+inc:''}`;
    });
  const chatDivCtx = chatDivLines.length ? '\n\nDIVIDEND DATA:\n' + chatDivLines.join('\n') : '';

  // ── Recent ASX announcements ──────────────────────────────────────────────
  let annCtx = '';
  if (state.serverOk && merged.length) {
    try {
      const tickers = merged.map(h=>h.ticker).join(',');
      const annResp = await fetch(`${API}/api/announcements/brief?tickers=${tickers}&days=3&max=8`)
        .then(r => r.ok ? r.json() : {items:[]}).catch(() => ({items:[]}));
      const annItems = (annResp.items || []);
      if (annItems.length) {
        const psAnns  = annItems.filter(a => a.price_sensitive);
        const othAnns = annItems.filter(a => !a.price_sensitive);
        const lines = [];
        if (psAnns.length)  lines.push('⚡ Price-sensitive:', ...psAnns.map(a=>`  • ${a.signal}`));
        if (othAnns.length) lines.push('Routine filings:',   ...othAnns.map(a=>`  • ${a.signal}`));
        annCtx = '\n\nASX ANNOUNCEMENTS (last 3d):\n' + lines.join('\n');
      }
    } catch {}
  }

  // ── Pending recommendations ───────────────────────────────────────────────
  const pendingRecs = state.recommendations.filter(r => r.status === 'pending');
  const recCtx = pendingRecs.length
    ? '\n\nPENDING TRADE RECOMMENDATIONS:\n' + pendingRecs.map(r =>
        `  • ${r.action} ${r.ticker} @ $${r.priceRange?.[0]?.toFixed(2)||'?'}–$${r.priceRange?.[1]?.toFixed(2)||'?'}, target $${r.target?.toFixed(2)||'?'}, stop $${r.stopLoss?.toFixed(2)||'?'}, conf ${r.confidence!=null?(r.confidence*100).toFixed(0)+'%':'?'} — ${(r.reasoning||'').slice(0,80)}`
      ).join('\n')
    : '';

  // ── Recent news headlines ─────────────────────────────────────────────────
  const recentNews = (state.news?.items || [])
    .filter(n => !n.error && n.sentiment !== undefined)
    .slice(0, 8);
  const newsCtx = recentNews.length
    ? '\n\nRECENT NEWS (LLM-classified):\n' + recentNews.map(n =>
        `  • [${n.tickers?.join(',')||'general'}] ${n.sentiment?.toUpperCase()} | ${(n.title||'').slice(0,80)}`
      ).join('\n')
    : '';

  // ── Market regime + macro context ─────────────────────────────────────────
  let regimeCtx = '';
  const cr = state.currentRegime;
  if (cr && cr.regime && cr.regime !== 'unknown') {
    const signals = (cr.signals || []).slice(0, 4).map(s => s.label || s).join(', ');
    regimeCtx += `\n\nMARKET REGIME: ${cr.regime.toUpperCase()} (confidence ${cr.confidence != null ? (cr.confidence * 100).toFixed(0) + '%' : '?'})`;
    if (signals) regimeCtx += ` — signals: ${signals}`;
  }
  const m = state.macroData;
  if (m) {
    const macroLines = [];
    if (m.asx200_level != null)     macroLines.push(`ASX200: ${m.asx200_level.toFixed(0)}`);
    if (m.asx200_5d_return != null) macroLines.push(`5d return: ${m.asx200_5d_return >= 0 ? '+' : ''}${m.asx200_5d_return.toFixed(2)}%`);
    if (m.vix?.value != null)       macroLines.push(`VIX: ${m.vix.value.toFixed(1)}`);
    if (m.sentiment)                macroLines.push(`Macro sentiment: ${m.sentiment}`);
    if (m.bullish != null)          macroLines.push(`Bullish%: ${m.bullish}%`);
    if (m.aud_usd != null)          macroLines.push(`AUD/USD: ${m.aud_usd.toFixed(4)}`);
    if (macroLines.length) regimeCtx += '\nMACRO DATA: ' + macroLines.join(' | ');
  }

  const system=`You are an expert ASX (Australian Stock Exchange) quantitative analyst and trading coach with deep knowledge of technical analysis, Australian equity markets, sector dynamics, and risk management. You support human traders who manually execute all trades — never suggest automated or algorithmic execution.

PORTFOLIO CONTEXT (${new Date().toLocaleDateString('en-AU',{timeZone:'Australia/Sydney'})}):
Portfolio value: $${fmt(pv)} | Net worth: $${fmt(pv + state.cash)} | Unrealised P&L: ${gain>=0?'+':''}$${fmt(Math.abs(gain))} (${gainPct>=0?'+':''}${fmt(Math.abs(gainPct))}%)${gainLossCtx}
Cash: $${fmt(state.cash)} | RBA: ${state.rbaRate.toFixed(2)}% | Brokerage: $${state.settings.brokerage}/trade | Max trades/day: ${state.settings.maxTradesPerDay}

Holdings:
  ${ps}${chatDivCtx}${indicatorCtx}${annCtx}${recCtx}${newsCtx}${regimeCtx}

RESPONSE FRAMEWORK — tailor depth to the question:
• For indicator questions: interpret each indicator in context (e.g. "RSI14=68 approaching overbought but momentum still rising — watch for divergence"). Cross-reference at least 3 indicators before forming a view.
• For trade setups: always provide entry range (near S/R level), target (next S/R or BB level), stop-loss (ATR-based, 1–2×ATR below entry), position size (respect 15% max position), expected net profit after $${state.settings.brokerage} brokerage, and R:R ratio. Only recommend R:R ≥ 2:1.
• For portfolio questions: consider sector concentration, correlation, cash deployment vs. opportunity cost. When comparing yield to cash, use the live RBA rate of ${state.rbaRate.toFixed(2)}%.
• For dividend questions: use the dividend data above to compute income, yield-on-cost, and ex-div timing. Flag stocks where payout ratio is unsustainable.
• For risk questions: quantify downside in dollars, not just percentages. Reference stop-loss levels explicitly.
• Always cite actual indicator values from the live data when available. Never invent numbers.
• ASX-specific context: note ex-dividend dates if relevant, sector tailwinds/headwinds (e.g. AUD/USD for BHP, interest rate sensitivity for REITs/banks), and ASX trading hours (10am–4pm AEDT).
• Be direct and actionable. Avoid generic disclaimers. Lead with your view, then support it with data.`;

  try {
    const { text: reply } = await callClaude('assistant', '', {
      systemPrompt: system,
      messages: state.chatHistory.map(m => ({ role: m.role, content: m.content })),
      maxTokens: 1200,
      noCache: true,
    });
    state.chatHistory.push({role:'assistant',content:reply});
    document.getElementById('typing').outerHTML=`<div class="msg msg-ai" style="white-space:pre-wrap">${escapeHTML(reply)}</div>`;
  } catch(err) {
    document.getElementById('typing').outerHTML=`<div class="msg msg-ai text-danger">Error: ${escapeHTML(err.message)}</div>`;
  }
  msgs.scrollTop=msgs.scrollHeight;
}
