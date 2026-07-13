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
Iron ore < $90/t: do NOT recommend BUY/TOP_UP on BHP, RIO, FMG, MIN — hold existing positions or TRIM only.
AUD/USD < 0.65: bias toward unhedged exporters (BHP, RIO, WDS, STO) — weak AUD inflates their AUD revenue.
AUD/USD > 0.72: headwind for unhedged exporters — apply higher conviction bar for TOP_UP.
`.trim(),

  REIT_SECTOR: `
=== REIT-SPECIFIC RULES ===
REITs are pass-through trusts: use 0% franking credit unless explicitly stated in dividend data.
Rising rates environment: flag debt coverage ratios and loan-to-value. Favour low-gearing REITs (LVR < 35%).
Defensive income play: only recommend BUY if dividend yield > 5% AND distribution growth is positive.
`.trim(),

  FINANCIALS_SECTOR: `
=== FINANCIALS / BANKING SECTOR RULES ===
For Australian banks and diversified financials (CBA, WBC, ANZ, NAB, MQG, QBE, SUN, IAG, etc.):

PRIMARY DRIVERS (must be evaluated; cite at least 2 that are directly relevant):
  • RBA rate path — current cash rate and market-implied trajectory directly drive Net Interest Margin (NIM).
    Rising rates expand NIM for deposit-funded banks; cuts compress it. State the RBA rate from the user message
    and the implied direction. This is the DOMINANT macro factor for Australian banks.
  • Net Interest Margin (NIM) — the spread between lending rates and deposit costs.
    NIM compression is a SELL/TRIM signal; expansion is a BUY/TOP_UP support.
    If NIM data is unavailable, state "NIM: not in data" and weight this factor as unknown.
  • Loan book growth — mortgage growth, business lending growth, and deposit growth
    indicate top-line revenue trajectory. Slowing loan growth + margin compression = double headwind.
  • Credit quality — bad debt provisions, arrears rates, and loan impairment charges.
    A rising impairment cycle is a fundamental SELL trigger; a benign cycle is a BUY support.
  • Capital adequacy — CET1 ratio relative to APRA's minimum (11.25% for major banks).
    CET1 > 13% supports dividend sustainability; CET1 decline toward 11.5% is a risk flag.
  • Dividend sustainability — payout ratio and franking credits.
    Australian banks are high-yield income stocks; dividend cut risk is the #1 retail concern.
    Gross yield (after franking) should be cited alongside cash yield.

TECHNICAL SIGNALS ARE CONFIRMING ONLY (Rule 19 applies):
  Do NOT recommend SELL/TRIM on a major bank solely due to RSI, death cross, or BB breakdown.
  Require at least one fundamental deterioration (NIM compression, rising bad debts, capital breach,
  dividend at risk) alongside any technical signal. Moving-average crossovers on banks reflect
  short-term sentiment, not business-value changes.

MACRO INTEGRATION (cite in factorsUsed[]):
  • Housing market — mortgage stress and house price trajectory directly affect loan book quality.
  • Employment — rising unemployment increases default risk and dampens loan demand.
  • AUD/USD — minimal direct impact on domestic banks; matters more for insurers with offshore operations.
`.trim(),

  HIGH_VOL_REGIME: `
=== HIGH VOLATILITY REGIME ACTIVE ===
Raise minimum confidence to 0.75 for all BUY and TOP_UP recommendations (from default 0.62).
Position size and stop distance are set deterministically by the quant engine for this
regime — do NOT adjust qty or the stop-ATR multiple yourself (Rule 4). Report the elevated
risk in factorsUsed[]; the engine reduces size and widens/tightens the stop.
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

  // Sector modules — combine portfolio sectors + liveSignals sectors for candidate tickers
  const _liveSectors = typeof state !== 'undefined' && state.liveSignals
    ? Object.values(state.liveSignals).map(s => (s.sector || '').toLowerCase())
    : [];
  const sectors = new Set([
    ...(portfolio).map(h => (h.sector || '').toLowerCase()),
    ..._liveSectors,
    ...((context.sectors || []).map(s => (s || '').toLowerCase())),
  ]);
  if (sectors.has('mining') || sectors.has('resources') || sectors.has('materials'))
    modules.push(RULE_MODULES.MINING_SECTOR);
  if (sectors.has('reits') || sectors.has('reit') || sectors.has('real estate'))
    modules.push(RULE_MODULES.REIT_SECTOR);
  if (sectors.has('financials') || sectors.has('financial services') || sectors.has('banks'))
    modules.push(RULE_MODULES.FINANCIALS_SECTOR);

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

// buildLessonsBlock — format fetched trading lessons into a prompt block.
// lessons: array from GET /api/learning/lessons
// Returns a non-empty string only when there are ≥1 lessons.
function buildLessonsBlock(lessons) {
  if (!lessons || !lessons.length) return '';
  const lines = lessons.map(l => {
    const scope = [l.ticker, l.sector, l.regime].filter(Boolean).join('/') || 'general';
    return `* [${scope}] ${l.lesson_text}`;
  });
  return `\n\n=== HISTORICAL LESSONS FOR THIS SETUP ===
Review these lessons before making recommendations. If your current thesis conflicts with a lesson,
explicitly state why this trade is different — or downgrade your conviction score.
${lines.join('\n')}`;
}

// buildDtSystemArray — reference implementation for the dormant day-trade Claude path.
// Not called: runDayTradeAnalysis() (dispatches to _runPortfolioWatchlistScan/_runUniverseScan) is quantitative-only.
// Kept so the Claude AI phase can be re-activated by wiring callClaude('dayTrade',…)
// from day-trading-analysis.js and passing buildDtSystemArray(context) as systemArray.
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
