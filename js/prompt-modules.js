// ============================================================
// prompt-modules.js — Dynamic prompt assembly (3.4)
//
// RULE_MODULES — optional context blocks injected into user message.
//   Core hard rules remain in ANALYSIS_SYSTEM_PROMPT (cached).
//   Optional modules are appended to the system's second block (uncached)
//   so the core cache hit is preserved while modules vary per call.
//
// assembleOptionalModules(context) → string (optional modules concatenated)
// buildSystemArray(context) → [{type,text,cache_control?}] for claude-client
// ============================================================

// Optional rule modules — injected based on date / portfolio / regime
const RULE_MODULES = {

  TAX_LOSS_HARVEST: `
=== TAX-LOSS HARVESTING (ACTIVE: May 1 – Jun 30) ===
Scan all holdings for unrealised losses > $500. Recommend SELL to crystallise the loss before end of financial year.
Include taxBenefitEstimate: unrealisedLoss × assumed marginal rate (45%).
Flag wash-sale risk: if re-entry into substantially identical position within 30 days, ATO may deny the deduction.
Never recommend tax-loss harvest on a position that is ex-dividend within 5 days — the dividend capture offsets the benefit.
`.trim(),

  CGT_DISCOUNT_WINDOW: `
=== CGT DISCOUNT WINDOW ===
One or more holdings are in the 11–12 month holding window. The 50% CGT discount applies at exactly 12 months.
NEVER recommend SELL/TRIM on such a position without explicitly flagging the discount and calculating the after-tax difference.
Recommend holding to the 12-month mark unless the investment thesis is permanently and materially broken.
Note: CGT discount applies to capital gains only — does NOT block tax-loss harvesting on positions with unrealised losses.
`.trim(),

  REPORTING_SEASON: `
=== REPORTING SEASON (Feb or Aug) ===
Multiple holdings likely have earnings announcements imminent.
If ≥ 3 holdings have earnings within 7 days: flag the cluster risk explicitly.
Recommend de-risking the most expensive (highest PE) or most-shorted name in the cluster.
Do NOT recommend TOP_UP within 5 days of a holdings's earnings date — results risk is too high.
`.trim(),

  MINING_SECTOR: `
=== MINING SECTOR RULES ===
Iron ore < $90/t: reject any TOP_UP on BHP, RIO, FMG, MIN. Recommend HOLD or TRIM only.
AUD/USD < 0.65: bias toward unhedged exporters (BHP, RIO, WDS, STO) — weak AUD inflates their AUD revenue.
AUD/USD > 0.72: headwind for unhedged exporters — apply higher conviction bar for TOP_UP.
`.trim(),

  REIT_SECTOR: `
=== REIT-SPECIFIC RULES ===
REITs are pass-through trusts: use 0% franking credit unless explicitly stated in dividend data.
Rising rates environment: flag debt coverage ratios and loan-to-value. Favour low-gearing REITs (LVR < 35%).
Defensive income play: only recommend BUY if dividend yield > 5% AND distribution growth is positive.
`.trim(),

  HIGH_VOL_REGIME: `
=== HIGH VOLATILITY REGIME ACTIVE ===
Raise minimum confidence to 0.75 for all BUY and TOP_UP recommendations (from default 0.62).
Reduce qty by 30% on all BUY/TOP_UP — use the quant engine output as the ceiling, not the floor.
Stop distance: use 2.0×ATR (tighter than 2.5×) to limit dollar risk in gap scenarios.
Do NOT chase breakouts — wait for mean-reversion setups with clear support.
`.trim(),

  RISK_OFF_REGIME: `
=== RISK-OFF REGIME ===
Market breadth deteriorating. New BUY recommendations require confidence ≥ 0.80.
Maximum 1 new position this session. Prioritise reducing exposure to high-beta names.
Defensive rotation: REITs, Utilities, Consumer Staples are preferred over Mining and Financials.
`.trim(),

};

// holdingMonths — how long a holding has been held (in calendar months)
// Requires holding.purchaseDate in 'DD-MM-YYYY' or ISO format.
function _holdingMonths(holding) {
  if (!holding.purchaseDate) return 0;
  const parts = holding.purchaseDate.split('-');
  let d;
  if (parts.length === 3 && parts[2].length === 4) {
    d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
  } else {
    d = new Date(holding.purchaseDate);
  }
  if (isNaN(d)) return 0;
  const months = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
  return Math.floor(months);
}

// assembleOptionalModules — returns a concatenated string of applicable modules
// context: { regime, portfolio[], tickers[], inHarvestWindow, isReportingSeason }
function assembleOptionalModules(context = {}) {
  const modules = [];
  const month = new Date().getMonth() + 1;

  // Date-driven modules
  if (context.inHarvestWindow || (month >= 5 && month <= 6)) {
    modules.push(RULE_MODULES.TAX_LOSS_HARVEST);
  }

  if (context.isReportingSeason || [2, 8].includes(month)) {
    modules.push(RULE_MODULES.REPORTING_SEASON);
  }

  // CGT window — any holding in 11-12 month range
  const portfolio = context.portfolio || state.portfolio || [];
  if (portfolio.some(h => { const m = _holdingMonths(h); return m >= 11 && m < 12; })) {
    modules.push(RULE_MODULES.CGT_DISCOUNT_WINDOW);
  }

  // Sector modules
  const sectors = new Set((portfolio).map(h => (h.sector || '').toLowerCase()));
  if (sectors.has('mining') || sectors.has('resources')) modules.push(RULE_MODULES.MINING_SECTOR);
  if (sectors.has('reits') || sectors.has('reit'))       modules.push(RULE_MODULES.REIT_SECTOR);

  // Regime modules
  const regime = context.regime || state.currentRegime?.regime || 'unknown';
  if (regime === 'highVol') modules.push(RULE_MODULES.HIGH_VOL_REGIME);
  if (regime === 'riskOff') modules.push(RULE_MODULES.RISK_OFF_REGIME);

  return modules.join('\n\n');
}

// buildSystemArray — returns the Claude API `system` field array
// Core hard rules are cached; optional modules are a second uncached block.
function buildSystemArray(context = {}) {
  const core = ANALYSIS_SYSTEM_PROMPT;
  const optional = assembleOptionalModules(context);

  const system = [
    { type: 'text', text: core, cache_control: { type: 'ephemeral' } },
  ];

  if (optional) {
    // Second block: not cached — varies per call based on date/portfolio/regime
    system.push({ type: 'text', text: optional });
  }

  return system;
}

// buildDtSystemArray — same approach for day trade prompts
function buildDtSystemArray(context = {}) {
  const core = typeof getDayTradeSystemPrompt === 'function' ? getDayTradeSystemPrompt() : '';
  if (!core) return undefined;

  const system = [
    { type: 'text', text: core, cache_control: { type: 'ephemeral' } },
  ];

  const regime = context.regime || state.currentRegime?.regime;
  if (regime === 'highVol') {
    system.push({ type: 'text', text: RULE_MODULES.HIGH_VOL_REGIME });
  }

  return system;
}
