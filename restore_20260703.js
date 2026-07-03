// ===== Restore today's (2026-07-03) morning macro + recommendations =====
// Paste this whole block into the browser DevTools Console (F12) while the app is open.
(function () {
  if (typeof state === 'undefined') { alert('Run this in the Sloth ASX Trader browser tab.'); return; }

  // 1) Morning AI macro brief (recovered from ai_call_log #22)
  var brief = {"sentiment": "risk-on", "sentimentConf": 0.62, "bullish": 63, "macro_regime": "mild_risk_on", "what_changed": [{"factor": "Gold", "observed": "$4,068 → $4,195 (+3.11%)", "signal": "Sharp safe-haven/geopolitical bid — Russia's 'most massive' Kyiv attack and Iran Strait of Hormuz tension driving hedging demand; NST, EVN, NEM likely strong open."}, {"factor": "US 10Y Yield", "observed": "4.37% → 4.48% (+11bp)", "signal": "Yield jump pressures rate-sensitive REITs and growth/tech; also signals inflation or fiscal concern despite equity strength in Dow."}, {"factor": "Copper", "observed": "6.120 → 6.260 (+2.26%)", "signal": "Copper surge bullish for diversified miners (BHP, RIO) and offsets iron ore weakness partially."}, {"factor": "Iron Ore", "observed": "100.2 → 98.4 (-1.84%; 5d: -2.15%)", "signal": "China reportedly restricting FMG iron ore shipments — direct headwind for FMG specifically; broader materials sector cushioned by copper/gold gains."}, {"factor": "Nasdaq vs Dow divergence", "observed": "Nasdaq -0.80% vs Dow +1.14%", "signal": "Rotation out of growth/tech into value/industrials; higher yields punishing duration; ASX tech names (WTC, XRO) face relative headwind."}], "drivers": [{"factor": "Gold surge (+3.11%)", "direction": "bullish_asx", "importance": 9, "confidence": "high", "observed": "Gold $4,068 → $4,195; driven by geopolitical escalation (Russian Kyiv attack, Iran Hormuz threat) and likely USD dynamics. Gold miners NST, EVN, NEM direct revenue tailwind."}, {"factor": "US 10Y Yield spike (+11bp to 4.48%)", "direction": "bearish_asx", "importance": 8, "confidence": "high", "observed": "Yield rose 11bp overnight — mechanistic headwind for REITs (higher discount rates), growth tech, and dividend plays; also signals fiscal or inflation concern worth monitoring."}, {"factor": "Iron Ore decline (-1.84%) + China import restriction on FMG", "direction": "bearish_asx", "importance": 7, "confidence": "high", "observed": "Iron ore 100.2 → 98.4; China reportedly restricting FMG shipments (Fortescue-specific risk, not yet confirmed sector-wide). FMG direct headwind; BHP/RIO partially insulated by copper strength."}, {"factor": "Copper rally (+2.26%)", "direction": "bullish_asx", "importance": 7, "confidence": "high", "observed": "Copper 6.120 → 6.260; bullish for BHP, RIO, OZL-linked plays. Implies better demand signal for industrial metals ex-iron ore."}, {"factor": "AUD/USD stability (0.6900, +0.71% on day; +0.59% 5d)", "direction": "neutral", "importance": 5, "confidence": "medium", "observed": "AUD held 0.6900 despite iron ore weakness — copper and gold strength likely offsetting commodity terms-of-trade drag. No significant currency headwind for offshore earners today."}, {"factor": "Geopolitical escalation (Russia-Ukraine, Iran Hormuz)", "direction": "bearish_asx", "importance": 6, "confidence": "medium", "observed": "Russia's largest Kyiv attack (27 killed) and Iran tightening Strait of Hormuz access; oil only +0.79% so market not pricing full supply shock yet — tail risk remains. Energy names modest tailwind if Hormuz tension escalates."}], "sector_impact": {"materials": 5, "energy": 2, "financials": 1, "healthcare": 3, "reits": -4, "technology": -3}, "analysis": "Gold +3.11% ($4,068 → $4,195). Likely driver: geopolitical safe-haven demand following Russia's largest recorded attack on Kyiv (27 killed) and Iran tightening Strait of Hormuz tanker traffic (high conf). USD weakness also possible contributor (medium conf). US 10Y yield +11bp (4.37% → 4.48%) — likely driver: fiscal/inflation repricing or bond market supply concerns (medium conf); notable that equities did not sell off uniformly, suggesting yield move is not yet alarming to equity investors. Dow +1.14% vs Nasdaq -0.80% — clear rotation from growth into value/cyclicals, mechanistically consistent with yield spike. Copper +2.26% (6.120 → 6.260). Iron ore -1.84% (100.2 → 98.4); corroborated by China reportedly restricting Fortescue shipments specifically (high conf headline). AUD/USD +0.71% to 0.6900, stable despite iron ore weakness — copper and gold offsetting.\n\nFor ASX, the gold surge is the dominant overnight driver. Gold miner ETFs and individual names (NST, EVN) face a strong open — mechanistically a 3%+ gold move translates directly to earnings estimate upgrades. Materials sector gets a net positive read from copper, partially offset by iron ore decline; FMG is the isolated loser given the China shipment restriction headline. The 11bp yield spike is the key risk to REITs (MGR, SCG, GMG) and growth tech (WTC, XRO) — these sectors face valuation headwinds on higher discount rates. Healthcare's 5-day +5.45% run continues to attract defensive rotation. The ASX200 futures implied open of ~+1.21% (8,725 → 8,830 live) appears consistent with the gold/copper boost offsetting yield and iron ore drags.\n\nKey risk today: the China iron ore shipment restriction on Fortescue, if confirmed or broadened to other miners, could shift the materials sector from net positive to net negative rapidly — watch any official Chinese customs or trade ministry statement. The geopolitical tail risk (Iran Hormuz) is not yet priced into oil (+0.79% only); if a tanker incident occurs, energy spikes and gold extends, but broader risk-off could cap equity upside. Watch the AUD for any break below 0.6870 as a signal the terms-of-trade repricing is accelerating.", "keyDrivers": "Gold's 3.11% surge — driven by geopolitical escalation in Ukraine and the Strait of Hormuz — is the single most important overnight factor for the ASX, directly lifting gold miners and supporting the broader index. This is partially countered by the 11bp US 10Y yield spike, which mechanistically pressures REITs and growth tech. Iron ore's decline, amplified by the China-FMG shipment restriction headline, is a material company-specific risk that must be monitored for any broadening to sector-wide policy."};
  state.macroData = Object.assign({}, state.macroData || {}, brief);
  state.macroDate = '03-07-2026';

  // 2) The three pending recommendations (recovered from ai_call_log #23 + learning events 57-59)
  var restored = [
{
"ticker": "QBE",
"action": "TOP_UP",
"sector": "Financials",
"isWatchlist": false,
"priceRange": [
24.9,
25.15
],
"target": 27.2,
"stopLoss": 23.99,
"qty": 0,
"tranches": 1,
"orderType": "LIMIT",
"limitPrice": 25.1,
"confidence": 0.7,
"scenarios": {
"bull": {
"p": 0.3,
"ret": 0.14
},
"base": {
"p": 0.5,
"ret": 0.08
},
"bear": {
"p": 0.2,
"ret": -0.05
}
},
"expectedTimeToTarget": 70,
"factorsUsed": [
"Valuation: PE 12.1 / fwdPE 12.6 cheap vs financials sector; PB 2.21",
"Catalyst: Raheja QBE India buyout completed 02-Jul (bullish merger 8.5) — expands offshore book",
"Income: DivYield 4.35% vs RBA 4.35% — near-parity, payout 42% highly sustainable",
"Sharpe 2.47 (90d) — best risk-adjusted in book, justifies return vs 4.35% RBA",
"Risk: VaR1d -1.54%, MaxDD90d 7.7% — low volatility earner (Vol 17.7%ann)"
],
"reasoning": "Cheap valuation + India buyout completion + sustainable 42% payout. Insurer margins benefit from higher US10Y (4.48%) investment yields.",
"risks": "Catastrophe claims spike or reserve strengthening compresses combined ratio.",
"catalysts": "Raheja QBE integration; FY earnings; higher bond yields lift investment income.",
"signals": [
"RSI14 68 rising",
"OBV rising",
"ADX 50 strong uptrend",
"Stoch %K 88 overbought"
],
"invalidationCondition": "Close below $23.99 stop or combined ratio guidance > 95%",
"bearCase": "Major catastrophe season lifts combined ratio; investment yield gains offset by underwriting losses.",
"bullCase": "Cheap PE + India growth + rising bond-yield investment income drive re-rate to $27+.",
"weightGuidance": "Accumulate (+1-2%)",
"expectedProfit": 41.8,
"netProfit": 22.15,
"primary_entry_driver": "fundamental_value",
"status": "pending",
"id": "R-1783000000000-0",
"date": "03-07-2026",
"generatedAt": "2026-07-03 13:06",
"regime": "sideways",
"_learningId": 57
},
{
"ticker": "WOW",
"action": "TOP_UP",
"sector": "Consumer Staples",
"isWatchlist": false,
"priceRange": [
39.1,
39.55
],
"target": 42.5,
"stopLoss": 37.64,
"qty": 0,
"tranches": 1,
"orderType": "LIMIT",
"limitPrice": 39.5,
"confidence": 0.68,
"scenarios": {
"bull": {
"p": 0.3,
"ret": 0.12
},
"base": {
"p": 0.5,
"ret": 0.07
},
"bear": {
"p": 0.2,
"ret": -0.05
}
},
"expectedTimeToTarget": 65,
"factorsUsed": [
"Defensive earnings: staples resilient in sideways regime; Beta 0.29 low",
"Momentum: 90D return +26.3%, 20D +11.6%; strong ADX 54.1 uptrend",
"Sharpe 1.39 (90d) positive vs RBA 4.35% — solid risk-adjusted",
"Risk: MaxDD90d 14.7%, VaR1d -1.76% moderate",
"Prior WOW TRIM 30-Jun was a win (+$198.54) — but thesis is now momentum continuation not exit"
],
"reasoning": "Defensive staples with strong momentum in sideways market. Low beta 0.29 anchors book. Fwd PE 28 rich but earnings recovery underway.",
"risks": "Payout ratio 172% and rich PE 80.8; margin pressure could stall re-rate.",
"catalysts": "Sales update; margin normalisation; defensive rotation in sideways market.",
"signals": [
"RSI14 64 rising",
"OBV rising",
"SMA20>SMA50 golden cross",
"MACD hist contracting"
],
"invalidationCondition": "Close below $37.64 stop or same-store sales decline > 2%",
"bullCase": "Defensive momentum leader; low-beta ballast re-rates toward $42.50 on margin recovery.",
"bearCase": "Rich PE 80.8 + 172% payout leave no room for a sales miss; pulls back to $36.",
"weightGuidance": "Accumulate (+1-2%)",
"expectedProfit": 76.2,
"netProfit": 55.85,
"primary_entry_driver": "momentum_breakout",
"status": "pending",
"id": "R-1783000000000-1",
"date": "03-07-2026",
"generatedAt": "2026-07-03 13:06",
"regime": "sideways",
"_learningId": 58
},
{
"ticker": "CBA",
"action": "TRIM",
"sector": "Banking",
"isWatchlist": false,
"priceRange": [
161,
162
],
"target": 150,
"stopLoss": 169,
"qty": 0,
"tranches": 1,
"orderType": "LIMIT",
"limitPrice": 161,
"confidence": 0.66,
"scenarios": {
"bull": {
"p": 0.25,
"ret": 0.05
},
"base": {
"p": 0.5,
"ret": -0.06
},
"bear": {
"p": 0.25,
"ret": -0.14
}
},
"expectedTimeToTarget": 60,
"factorsUsed": [
"Valuation: PE 26.4 / fwdPE 24.4 extreme for a bank; PB 3.55 vs peers ~1.5-2.6",
"Analyst: sell rating, target $122.57 (-23.9%) — supporting context not sole driver",
"Fundamental: 90D return -9.73%, death cross SMA20<SMA50, RBA 4.35% steady limits NIM upside",
"Sharpe -0.95 (90d) negative — poor risk-adjusted, weighed with valuation not alone",
"Position: 29.88% unrealised gain, held 322d (>12m CGT discount applies)"
],
"reasoning": "Technical breakdown (death cross, below SMA20) confirmed by extreme valuation PE 26.4 for a bank — a genuine fundamental stretch, not just chart weakness. Trim overvaluation.",
"risks": "Bank rally on RBA surprise or flight-to-quality could squeeze the trim.",
"catalysts": "H1 result; RBA decision; sector rotation out of expensive majors.",
"signals": [
"Death cross SMA20<SMA50",
"Price below SMA20",
"RSI14 45 falling",
"OBV rising conflict"
],
"invalidationCondition": "Close above $169 or fwdPE compresses below 20x on upgrade",
"bearCase": "PE 26.4 unsustainable for low-growth bank; reverts toward analyst $122 as NIM stalls.",
"bullCase": "Could be wrong if RBA cuts spur housing credit and defensive bid re-rates majors higher.",
"reallocationSuggestion": "Rotate into QBE — cheaper financials PE 12.1, better Sharpe 2.47, India catalyst.",
"weightGuidance": "Reduce (-25-50%)",
"expectedProfit": 0,
"netProfit": 693.44,
"primary_driver": "technical_breakdown",
"secondary_factors": [
"held_over_12m",
"peer_outperformance"
],
"urgency": "routine",
"status": "pending",
"id": "R-1783000000000-2",
"date": "03-07-2026",
"generatedAt": "2026-07-03 13:06",
"regime": "sideways",
"_learningId": 59
}
];
  var have = new Set((state.recommendations || []).map(function (r) { return (r.ticker + '|' + r.action); }));
  var add = restored.filter(function (r) { return !have.has(r.ticker + '|' + r.action); });
  state.recommendations = (state.recommendations || []).concat(add);

  // 3) Persist through the live app + refresh the view
  Promise.resolve(typeof saveStateToDb === 'function' ? saveStateToDb() : null).then(function () {
    if (typeof showPage === 'function') showPage('recommendations');
    else if (typeof renderPage === 'function') renderPage();
    console.log('[restore] macro + ' + add.length + ' recs restored:', add.map(function(r){return r.action+' '+r.ticker;}));
    alert('Restored the 03-07-2026 macro brief + ' + add.length + ' recommendations. Check the Recommendations and Macro pages.');
  });
})();
