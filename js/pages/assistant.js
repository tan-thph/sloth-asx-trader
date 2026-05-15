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
  msgs.innerHTML+=`<div class="msg msg-user">${msg}</div>`;
  msgs.innerHTML+=`<div class="msg msg-ai" id="typing"><div class="loading-dots"><span></span><span></span><span></span></div></div>`;
  msgs.scrollTop=msgs.scrollHeight;

  // Build indicator context from live signals
  const ps=state.portfolio.map(h=>`${h.ticker}(${h.shares}sh@$${h.currentPrice}, cost $${h.avgPrice})`).join(', ');
  let indicatorCtx='';
  const loadedTickers=Object.keys(state.liveSignals).filter(t=>!state.liveSignals[t]?.error);
  if(loadedTickers.length) {
    indicatorCtx='\n\nLive Technical Indicators:\n'+loadedTickers.map(t=>{
      const s=state.liveSignals[t];
      return `${t}: RSI14=${s.rsi_14?.toFixed(1)}, MACD=${s.macd_hist?.toFixed(3)}, Signal=${s.composite_signal}, Conf=${(s.confidence*100).toFixed(0)}%, Trend=${s.trend_direction}, ADX=${s.adx?.toFixed(1)}, BB%B=${s.bb_pct_b!=null?(s.bb_pct_b*100).toFixed(0)+'%':'n/a'}, SMA20=$${s.sma_20?.toFixed(3)}, MFI=${s.mfi?.toFixed(1)}, ATR=${s.atr_14?.toFixed(3)}`;
    }).join('\n');
  }

  // Dividend context for chat assistant
  const chatDivLines = mergedPortfolio()
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

  const system=`You are an expert ASX (Australian Stock Exchange) quantitative analyst and trading coach with deep knowledge of technical analysis, Australian equity markets, sector dynamics, and risk management. You support human traders who manually execute all trades — never suggest automated or algorithmic execution.

PORTFOLIO CONTEXT:
Holdings: ${ps}
Cash available: $${fmt(state.cash)} | RBA Cash Rate: ${state.rbaRate.toFixed(2)}% (${state.rbaRateSource}) | Brokerage: $${state.settings.brokerage}/trade | Min trade: $${state.settings.minTradeSize} | Max ${state.settings.maxTradesPerDay} trades/day${chatDivCtx}${indicatorCtx}

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
    const resp=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1200,system,messages:state.chatHistory.map(m=>({role:m.role,content:m.content}))})});
    const data=await resp.json();
    if(data.error) throw new Error(data.error.message);
    const reply=data.content?.[0]?.text||'No response.';
    state.chatHistory.push({role:'assistant',content:reply});
    document.getElementById('typing').outerHTML=`<div class="msg msg-ai" style="white-space:pre-wrap">${reply}</div>`;
  } catch(err) {
    document.getElementById('typing').outerHTML=`<div class="msg msg-ai text-danger">Error: ${err.message}</div>`;
  }
  msgs.scrollTop=msgs.scrollHeight;
}
