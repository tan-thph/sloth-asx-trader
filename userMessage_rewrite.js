// ============================================================
// ANALYSIS ENGINE — USER MESSAGE (rewrite v2)
// Replaces the messages: [{role:'user', content:`...`}] block.
// All JS template-literal variables preserved as-is.
// ============================================================

const userMessage = `Date: ${todayStr()} | Time: ${nowSydney()}

CURRENT PORTFOLIO STATE:
${portfolioJson}
Cash: $${fmt(state.cash)}
${recCtx}${pendingFeedbackCtx}${macroCtx}${marketViewCtx}${extraTickersCtx}${dividendCtx}${earningsCtx}${indicatorCtx}

════════════════════════════════════════
ANALYSIS INSTRUCTIONS — follow in order, do not skip steps
════════════════════════════════════════

STEP 1 — CALIBRATION CHECK
Review RECENT RECOMMENDATION HISTORY. Compute hit-rate per confidence band.
If any band hit-rate < 60%, note the adjustment you will apply to today's recs.
If < 5 closed recs with actualPnL, write "insufficient history" and proceed.

STEP 2 — FAILED REC REVIEW
For any ticker with a previous loss outcome or negative feedback:
  - Identify which factor failed (macro? earnings? stop not triggered?)
  - Decide: has that factor changed enough to re-recommend?
  - If yes, cite the specific change in reasoning[]. If no, exclude the ticker.

STEP 3 — MACRO REGIME FILTER
Assess macroData.sentiment and bullish score.
If sentiment = "bearish" AND bullish < 35 → Hard Rule 12 applies. No BUY/TOP_UP.
Otherwise, summarise the regime in one line for use in the summary field.

STEP 4 — SEASONAL FLAGS
Is today in Feb 1–28 or Aug 1–31? If yes, check for earnings clusters (≥ 3 holdings within 7 days).
Is today in May 1–Jun 30? If yes, scan for tax-loss harvest candidates (unrealised loss > $500).
Apply relevant rules from Sections 4 and 5.

STEP 5 — PER-TICKER ANALYSIS (for every holding and watchlist ticker)
For each ticker, work through the framework in priority order:
  1. Earnings & revisions: EPS trend bullish or bearish? Forward PE vs sector benchmark?
  2. Macro fit: does the current regime explicitly help or hurt this stock?
  3. Sector flows: is institutional money flowing toward or away from this sector?
  4. Valuation: is PE/yield attractive vs sector? Compute grossed-up yield if dividend payer.
  5. Technical confirmation: one signal from each of the 3 independent categories.
     Do any categories conflict? Note it — do not suppress conflicting signals.
  6. Cash comparison test: does expected return clear the RBA hurdle + 2× brokerage?
  7. If ≥ 3 independent non-technical factors align AND cash test passes → candidate rec.
     If < 3 factors → HOLD, exclude from recs[].

STEP 6 — BUILD RECS[]
For each candidate rec from Step 5:
  - Compute priceRange, target (next S/R), stopLoss (1.5×ATR from entry), qty (sizing rule).
  - Assign scenarios (bull/base/bear probabilities summing to 1.0).
  - Write invalidationCondition (falsifiable, ≤ 80 chars).
  - Write bearCase if confidence ≥ 0.70 (or downgrade confidence by 0.10).
  - Populate factorsUsed[] with ≥ 3 entries citing specific data points.
  - Check liquidity: qty × price ≤ 5% of avg daily turnover. Set tranches if needed.
  - Apply anti-churn rules: no SELL/TRIM if BUY within last 7 days on same ticker.
  - Apply CGT window check (Rule 13) and ex-div protection (Rule 10).

STEP 7 — PRE-FLIGHT CHECKS
Before writing JSON, verify all 7 checks from Section 5 pass. Fix any failure.

STEP 8 — OUTPUT
Return the JSON object only. No preamble, no markdown, no explanation outside the JSON.`;
