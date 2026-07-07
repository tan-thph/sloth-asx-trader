# AI Trading Platform Review

## Critique and Recommendations for the AI API Call Architecture

---

# Executive Summary

The current AI decision engine is significantly more sophisticated than a typical retail trading prompt. Rather than asking an LLM to generate buy/sell recommendations from a handful of indicators, the platform combines deterministic validation, risk management, portfolio awareness, calibration, macro analysis and structured reasoning into a single decision framework.

Overall architecture quality is estimated at **8.5/10**.

The primary challenge is no longer model capability. Instead, the system has reached the point where **information architecture** is becoming the bottleneck.

The prompt contains a large amount of high-quality information, but much of it is presented at a level of detail that forces the model to perform data reduction before reasoning can begin.

The next stage of development should focus on improving information hierarchy, feature engineering and structured intelligence rather than adding additional prompt rules.

---

# Overall Assessment

| Category              | Rating   |
| --------------------- | -------- |
| Prompt Engineering    | 9.5 / 10 |
| Risk Controls         | 9.5 / 10 |
| Explainability        | 9 / 10   |
| Output Schema         | 9 / 10   |
| Decision Quality      | 8 / 10   |
| Information Hierarchy | 5 / 10   |
| Token Efficiency      | 5 / 10   |
| AI Utilisation        | 7.5 / 10 |

---

# Strengths

## Excellent Separation Between Rules and Reasoning

One of the strongest aspects of the platform is that deterministic logic is implemented outside of the language model.

Examples include:

* confidence gating
* position sizing
* portfolio limits
* validation rules
* tax calculations
* risk constraints

This allows Claude to focus on reasoning rather than arithmetic or rule execution.

This architecture is considerably more robust than allowing an LLM to perform these calculations independently.

---

## Evidence-Based Recommendations

Recommendations are generally supported by multiple independent observations.

Rather than producing statements such as:

> Buy because RSI is oversold.

The model combines:

* valuation
* profitability
* macro environment
* technical confirmation
* historical performance

This significantly improves explainability and user confidence.

---

## Strong Risk Management

The platform already includes:

* confidence thresholds
* exposure limits
* concentration checks
* thesis validation
* exit sizing
* calibration

Many retail AI trading systems ignore these entirely.

---

## Structured Output

The response schema is clean and machine-readable.

This makes downstream automation straightforward and enables future analytics and reporting.

---

# Primary Weakness

## Information Overload

The prompt has become extremely large.

The language model is expected to process:

* market macro
* portfolio
* watchlist
* technical indicators
* valuation
* financial quality
* historical calibration
* learning data
* risk controls
* formatting rules

before producing a recommendation.

Although modern models can process this volume of information, it reduces attention available for higher-level reasoning.

The issue is not token cost.

The issue is cognitive load.

---

# Recommendation 1

## Introduce an AI Feature Engineering Layer

Instead of providing dozens of raw indicators, generate higher-level features before invoking Claude.

Current input:

* RSI
* MACD
* ROC
* OBV
* CCI
* ATR
* VWAP
* MFI
* Williams %R
* multiple moving averages

Instead provide:

```json
{
  "trendQuality": "Strong Bullish",
  "momentumQuality": "Improving",
  "valuation": "Attractive",
  "financialQuality": "High",
  "riskProfile": "Medium",
  "signalStrength": 84
}
```

Claude is significantly more effective when reasoning from engineered features rather than raw measurements.

---

# Recommendation 2

## Reduce Raw Technical Indicators

Many supplied indicators measure similar market behaviour.

For example:

* RSI
* CCI
* Williams %R
* Stochastic

all represent momentum or overbought/oversold conditions.

Similarly:

* SMA
* EMA
* MACD
* ROC

all describe trend or momentum.

Instead of providing every indicator, calculate composite scores.

Example:

Trend Score

Momentum Score

Mean Reversion Score

Volatility Score

Risk Score

These scores should become the primary AI inputs.

---

# Recommendation 3

## Perform Signal Aggregation Before Claude

Rather than providing dozens of individual alerts, summarise market structure.

Example:

```json
{
  "marketBreadth": "+24",
  "marketRegime": "Moderately Bullish",

  "leadingSectors":[
    "Healthcare",
    "REITs",
    "Consumer"
  ],

  "laggingSectors":[
    "Materials",
    "Energy"
  ],

  "bullClusters":[
    "CSL",
    "MQG",
    "QBE"
  ],

  "bearClusters":[
    "RIO",
    "FMG",
    "WDS"
  ]
}
```

This provides significantly more useful context.

---

# Recommendation 4

## Build Technical Signal Clusters

Raw signals should become clusters.

Instead of:

* MACD Bullish
* Above SMA50
* ADX Bullish

present:

```text
Strong Bullish Trend
```

Similarly:

MACD Bearish

Below SMA50

ADX Bearish

becomes:

```text
Strong Downtrend
```

This dramatically reduces prompt size while preserving information.

---

# Recommendation 5

## Increase Use of Learning Engine

The platform already records valuable information:

* entry conditions
* exit conditions
* thesis outcomes
* realised returns
* error tags

These should become first-class inputs to Claude.

Example:

Historical playbook:

Driver:

Fundamental Value

Environment:

Risk-On

Financial Sector

Performance:

* Trades: 61
* Win Rate: 65%
* Average Return: +6.8%

Similarity:

82%

Current setup closely resembles historical successful trades.

This type of information is substantially more valuable than another technical indicator.

---

# Recommendation 6

## Introduce Hierarchical Information

The prompt currently mixes strategic information with low-level data.

Instead structure information in layers.

### Layer 1

Portfolio state

Market regime

Macro summary

Learning summary

---

### Layer 2

Sector analysis

Signal clusters

News

---

### Layer 3

Individual stock analysis

---

### Layer 4

Raw indicators

Claude should rarely need to examine Layer 4.

---

# Recommendation 7

## Expand News Integration

Technical indicators explain where price has been.

News explains why expectations changed.

Future weighting should move toward:

* Fundamentals
* Macro
* News
* Technicals

rather than allowing technical indicators to dominate every recommendation.

---

# Recommendation 8

## Keep Deterministic Logic Outside the Model

Continue implementing deterministic decisions in software.

Examples include:

* confidence thresholds
* tax calculations
* position sizing
* exposure calculations
* portfolio constraints
* validation checks

Claude should remain responsible for:

* interpreting evidence
* evaluating trade-offs
* assessing thesis quality
* synthesising macro, fundamental and technical information

This separation improves consistency and makes system behaviour easier to audit.

---

# Recommendation 9

## Reduce Prompt Growth

Each new rule increases prompt complexity.

Before adding another instruction, ask:

> Can this be implemented deterministically?

If the answer is yes, it should generally be implemented in code instead of prompt text.

The prompt should gradually become smaller as the platform matures.

---

# Long-Term Architecture

The ideal pipeline should resemble:

```text
Market Data
        │
        ▼
Indicator Calculation
        │
        ▼
Feature Engineering
        │
        ▼
Signal Clustering
        │
        ▼
Portfolio Analysis
        │
        ▼
Historical Learning
        │
        ▼
Macro Intelligence
        │
        ▼
News Intelligence
        │
        ▼
Claude Reasoning
        │
        ▼
Validation
        │
        ▼
Recommendation
```

Claude should consume structured intelligence rather than raw market data.

---

# Development Priorities

## Highest Priority

* AI feature engineering layer
* Signal clustering
* Market breadth summaries
* Historical playbook integration

## Medium Priority

* News intelligence
* Sector-level scoring
* Portfolio fit analysis

## Lower Priority

* Additional prompt rules
* Additional technical indicators
* Secondary debate models

---

# Final Recommendation

The current platform has reached a maturity level where incremental prompt engineering will provide diminishing returns.

Future improvements should focus on transforming raw data into structured market intelligence before invoking the language model.

By reducing information overload and providing Claude with higher-level features, historical playbooks, signal clusters and market summaries, the platform will become:

* more consistent
* more explainable
* more efficient
* easier to maintain
* easier to extend
* better aligned with institutional research workflows

The objective should no longer be to give Claude more information.

The objective should be to give Claude **better organised information**.

////////
Critic B:
Overall Grade: C-
Both recommendations violate at least one non-negotiable hard rule. The structural compliance is good, but the core output fails where it matters most.

❌ CRITICAL VIOLATIONS
1. BOTH TRADES FAIL R:R ≥ 2:1 (Rule 3 — "non-negotiable")
Ticker
Entry (worst)
Target
Stop
Risk
Reward
R:R
QBE	$25.05	$27.20	$23.86	$1.19	$2.15	1.81:1 ❌
CSL	$124.80	$138.90	$114.79	$10.01	$14.10	1.41:1 ❌

QBE stop verification: ATR(14) = $0.453, override = 2.5× → expected stop = 25.05 − (2.5 × 0.453) = $23.92. AI set $23.86 (slightly wider, making R:R worse).

CSL stop verification: If ATR ≈ $3.27 (derived from 41.9%ann vol), 2.5×ATR = $8.18 → expected stop = $116.62. AI set $114.79 — that's ~3.06×ATR, not 2.5×. Stop doesn't match the formula.

This is the single most important rule and both trades fail it. The AI appears to be setting targets at convenient levels and then placing stops to match, rather than calculating from ATR first and then finding a target that achieves 2:1.

How to fix: Stop is determined by formula (entry − 2.5×ATR). Target must then be ≥ entry + 2×(entry − stop). For QBE: target must be ≥ 25.05 + 2×1.19 = $27.43. For CSL: target must be ≥ 124.8 + 2×10.01 = $144.82.

2. CSL: LIKELY DATA FABRICATION (Rule 2 — "non-negotiable")
The user message's technical data blocks are: BHP, MQG, QBE, RIO, SGP(summary), VAP(summary), VDHG, VHY(summary), VLC, TCL(summary), WES(summary), CBA, JBH(truncated).

CSL has no full technical block in the provided data. Yet the AI cites:

RSI14 70 (overbought) — not in provided data
MACD hist +1.48 expanding — not in provided data
7/7 bullish signals, golden cross — not in provided data
fwdPE 13.5 vs 5yr history ~30x — not in provided data (no fundamentals block for CSL)
If this data wasn't in the original message, every CSL factor is fabricated. This would invalidate the entire recommendation.

Note: If CSL's technical block was present in the full message but truncated in your paste, this violation doesn't apply. But you should verify.

3. CSL: INSUFFICIENT NON-TECHNICAL FACTORS (Rule 5)
Required: ≥3 independent non-technical factors. Technicals are "tie-breakers only."

CSL's factorsUsed:

Factor
Type
Counts?
fwdPE 13.5 vs 30x history	Valuation	✅ Yes — 1
Analyst target $138.91	Analyst	❌ Explicitly excluded by Rule 18
Healthcare +5.8% 5D, CSL leadership	Sector momentum	⚠️ Borderline — this is relative price performance, arguably technical
Sharpe -0.91	Risk metric	❌ Required by Rule 17 but explicitly "backward-looking," not a bullish factor
MaxDD90d 36.6%	Risk flag	❌ Not bullish
7/7 bullish signals, golden cross, OBV, MACD	Technical	❌ Explicitly excluded by Rule 5

Clear non-technical bullish factors: 1 (valuation). Maybe 2 if you're generous with "sector leadership."

This should have been omitted from recs[] entirely per Rule 5: "If < 3 independent factors align, omit that ticker from recs[] entirely — do NOT add a HOLD entry."

4. CSL: ENTRY DRIVER MISMATCH (Section 1C)
text

primary_entry_driver: "fundamental_value"
But the reasoning says: "Healthcare sector leadership + strong momentum reversal confirm"

And factors cite: "7/7 bullish signals, golden cross, OBV rising, MACD expanding"

This is a momentum_breakout or mean_reversion entry dressed as fundamental_value. The rule requires the driver to be "the single causally-dominant reason you are entering NOW" and "must be reflected in factorsUsed[]/reasoning." The dominant reasoning here is technical reversal, not fundamental valuation.

5. DATA FABRICATION IN dataGaps
Three watchlist tickers cite metrics not present anywhere in the user message:

Ticker
Claimed Metric
In User Message?
JHX	"PE 136"	❌ Only fwdEPS=$2.10 and epsGrowth=-51% shown
XRO	"fwdPE 37.6"	❌ Only fwdEPS=$1.99 shown, no price
WTC	"vol 101.7%ann, death cross"	❌ No technical or risk data for WTC

JHX PE 136 is especially suspicious. If price ≈ $35 (implied by analyst target context) and fwdEPS = $2.10, fwdPE ≈ 16.7. Even trailing PE at -51% growth wouldn't approach 136. This looks like a hallucinated number.

⚠️ MODERATE ISSUES
6. QBE Target Above 52-Week High Without S/R Justification
QBE 52W High = $25.32. Target = $27.20 — 7.5% above the high with no identified support/resistance level. The rule says "Target at next confirmed S/R level." Setting a target in open air above the range isn't grounded.

7. CSL Target = Analyst Target (Subtle Rule 18 Issue)
CSL target: $138.90 | Analyst target: $138.91

The AI correctly labels analyst target as "supporting context only" in factorsUsed, but then uses it as the actual target price. This is a semantic compliance that violates the spirit of Rule 18. The target should be derived from S/R levels, not lifted from analyst consensus.

8. CSL TOP_UP Reverses 7-Day-Old TRIM Without Flagging
text

30-06-2026: TRIM CSL @ $115.39 → outcome=loss, actualPnL=$-24.92
07-07-2026: TOP_UP CSL @ $124.30
Same ticker, opposite action, 7-day window. The anti-churn override says "Same-ticker BUY→SELL window: 7 days." While this was TRIM→TOP_UP (not strictly BUY→SELL), it's reversing a recent decision. The AI flagged MQG's anti-churn in dataGaps but didn't flag CSL's. This is inconsistent.

9. Phantom "Iron Ore $90 Threshold" in Summary
"RIO/BHP: hold, iron ore $98 (>$90) no top-up bias"

This $90 threshold appears nowhere in the system prompt, user message, or active overrides. The AI invented a decision rule that doesn't exist.

10. SGP: Silent on HIGH-DD + Negative Sharpe
SGP: MaxDD90d = 27.2% (⚠HIGH-DD), Sharpe = -2.28, weight = 3.1%, held 552 days, +3.62% gain.

The AI correctly notes Rule 15 isn't triggered (weight < 12%). But a -2.28 Sharpe with 27% drawdown on a 552-day position returning 3.6% deserves some commentary — even if no action is warranted. The summary is silent.

✅ WHAT WORKS WELL
Area
Assessment
Output structure	Clean JSON, all required fields present
qty = 0	Both recs correctly leave sizing to quant engine
Confidence thresholds	Both ≥ 0.62 ✅
Sector concentration	Financials would be ~17% post-trade, within 30% ✅
Macro override	Correctly identified as not triggered (bullish 74%) ✅
Sharpe context	Both recs cite Sharpe with proper framing ✅
QBE factor count	3+ non-technical factors identified ✅
QBE entry driver	"fundamental_value" matches reasoning ✅
dataGaps structure	Proper format, watchlist Sharpe proxy rule applied ✅
Scenario analysis	Bull/base/bear with probabilities — good practice
Invalidation conditions	Specific and testable ✅
Risk acknowledgment	Both recs honestly list key risks ✅

🔧 ROOT CAUSE ANALYSIS
The failures cluster around three systemic issues:

Issue 1: The AI doesn't calculate R:R bottom-up
It picks a target first, then places a stop, and doesn't verify the ratio meets 2:1. Fix: Add explicit instruction:

text

COMPUTE STOP FIRST: stopLoss = entry_high - (stopAtrMultiple × ATR14)
THEN COMPUTE MIN TARGET: minTarget = entry_high + 2 × (entry_high - stopLoss)
IF no S/R level exists at or above minTarget, DO NOT ISSUE THE REC.
Issue 2: Factor counting is superficial
The AI lists 6 factors and assumes it passes the 3-factor rule, but 4 of CSL's 6 factors are technical or risk-metric flags that explicitly don't count. Fix: Require explicit factor typing:

text

factorsUsed must label each factor as [FUNDAMENTAL] [MACRO] [TECHNICAL] [RISK_METRIC]
Count only [FUNDAMENTAL] and [MACRO] toward the 3-factor minimum.
Issue 3: Data boundary enforcement is weak
The AI references data not in the user message (CSL indicators, JHX PE, WTC vol). This is the most dangerous failure. Fix: Add a validation step:

text

Before outputting each factor in factorsUsed[], verify the source field exists in the user message.
If citing a metric, append the source: "PE 12.1 (from fundamentals block)"
📊 FINAL SCORING
Dimension
Score
Weight
Weighted
Rule 3 (R:R)	0/10	25%	0.00
Rule 2 (Real Data)	3/10	20%	0.60
Rule 5 (Factor Count)	4/10	15%	0.60
Entry Driver Accuracy	5/10	10%	0.50
Structural Compliance	9/10	10%	0.90
Risk Management	7/10	10%	0.70
Summary Quality	6/10	5%	0.30
dataGaps Quality	5/10	5%	0.25
TOTAL		100%	3.85/10

Adjusted to C- because the structural design and prompt engineering are excellent — the failures are in execution, not architecture. Your system is well-designed; the model is cutting corners on the hard constraints.

PRIORITY FIX LIST
🔴 R:R enforcement — Restructure the stop-then-target calculation order
🔴 Data boundary — Add explicit "source traceability" requirement for every cited metric
🟠 Factor typing — Require [FUNDAMENTAL]/[MACRO]/[TECHNICAL] labels with counting logic
🟠 Entry driver validation — Add: "If >50% of reasoning words reference technical signals, driver cannot be fundamental_value"
🟡 Anti-churn consistency — The dataGaps section flagged MQG but missed CSL
🟡 Summary hallucination — Remove the fabricated $90 iron ore threshold