# Evaluation of Current AI Portfolio Recommendation Framework

## Executive Summary

The current recommendation engine demonstrates several advanced capabilities that are uncommon in retail portfolio management systems:

* Thesis tracking
* Confidence calibration
* Anti-churn controls
* Tax-aware checks
* Ex-dividend awareness
* Position sizing guidance
* Explainable reasoning

These features place the system significantly ahead of simple indicator-based trading models.

However, several weaknesses reduce decision quality and may result in inconsistent or suboptimal recommendations. Most issues stem from weak signal selection, insufficient fundamental analysis, and logical inconsistencies between confidence scoring and trade execution.

Overall Assessment:

| Category                   | Score  |
| -------------------------- | ------ |
| Explainability             | 8/10   |
| Risk Controls              | 8/10   |
| Portfolio Awareness        | 6/10   |
| Quantitative Rigor         | 5/10   |
| Market Context Integration | 4/10   |
| Decision Quality           | 6/10   |
| Overall System Quality     | 6.5/10 |

---

# Problem 1: Confidence Gate Is Not Enforced

## Current Behaviour

The system produced:

```text
Claude Confidence: 63%
Calibration Adjustment: -15%
Final Confidence: 48%

Minimum Confidence Threshold: 60%
```

Despite confidence being below the required threshold, the engine still issued:

```text
TRIM WBC
```

## Why This Is Problematic

The recommendation contradicts the validation framework.

If confidence thresholds are intended to control risk, recommendations should not bypass them.

This creates:

* Inconsistent behaviour
* Reduced trust in recommendations
* Hidden risk escalation

## Suggested Solution

Introduce a hard confidence gate:

```python
if confidence < minimum_threshold:
    action = "HOLD"
    trade_allowed = False
```

### Alternative

Allow low-confidence recommendations but downgrade them:

```text
TRIM → WATCHLIST
BUY → CANDIDATE
SELL → REVIEW REQUIRED
```

---

# Problem 2: Analyst Price Targets Are Overweighted

## Current Behaviour

The recommendation relies heavily on:

```text
Consensus Target: $33.38
Current Price: ~$35
Implied Downside: -4.7%
```

## Why This Is Problematic

Analyst targets are historically weak predictors because:

* Often lag price movements
* Frequently revised after market moves
* Tend to cluster around consensus
* Can exhibit herding behaviour

Numerous studies show limited predictive power.

## Suggested Solution

Reduce weighting significantly.

Suggested weighting:

| Signal                 | Weight |
| ---------------------- | ------ |
| Earnings revisions     | High   |
| Cashflow trends        | High   |
| Analyst target price   | Low    |
| Analyst rating changes | Medium |

Analyst targets should support a thesis rather than drive it.

---

# Problem 3: Sharpe Ratio Misuse

## Current Behaviour

The recommendation states:

```text
Sharpe Ratio (90d): -1.56
```

and treats this as evidence supporting a trim decision.

## Why This Is Problematic

Sharpe ratio is backward-looking.

Negative Sharpe means:

```text
Past risk-adjusted performance was poor.
```

It does not necessarily imply:

```text
Future performance will be poor.
```

For individual equities, short-term Sharpe ratios are highly unstable.

## Suggested Solution

Reduce importance.

Use Sharpe primarily for:

* Portfolio construction
* Position ranking
* Portfolio optimization

Avoid using it as a primary sell signal.

### Better Alternatives

* Earnings revision trend
* Relative earnings growth
* Free cashflow trend
* Return on equity trend
* Net interest margin trend (for banks)

---

# Problem 4: Excessive Reliance on Technical Indicators

## Current Behaviour

The recommendation uses:

```text
RSI
Bollinger %
SMA20
SMA50
Death Cross
```

as major drivers.

## Why This Is Problematic

Technical indicators often describe recent price action rather than explain future business performance.

For major Australian banks, price is typically driven by:

* Interest rates
* Loan growth
* Credit quality
* Capital adequacy
* Earnings expectations
* Dividend outlook

rather than moving average crossovers.

## Suggested Solution

Reweight factors.

### Current

```text
Technical Indicators → High Weight
Fundamentals → Medium Weight
```

### Recommended

```text
Fundamentals → High Weight
Macro Drivers → High Weight
Technical Indicators → Low Weight
```

---

# Problem 5: Missing Banking-Specific Analysis

## Current Behaviour

The recommendation contains almost no bank-specific analysis.

## Missing Factors

For WBC the engine should evaluate:

### Earnings Quality

* Revenue growth
* Earnings growth
* Cost-to-income ratio

### Lending Metrics

* Mortgage growth
* Business lending growth
* Deposit growth

### Risk Metrics

* Loan impairments
* Bad debt trends
* Arrears

### Capital Metrics

* CET1 ratio
* Regulatory capital position

### Profitability Metrics

* Net Interest Margin (NIM)
* Return on Equity (ROE)

### Shareholder Return Metrics

* Dividend yield
* Dividend sustainability

---

# Problem 6: No Macroeconomic Integration

## Current Behaviour

Only limited market context appears.

## Missing Drivers

For Australian banks:

### Critical Variables

* RBA rate path
* Inflation
* Employment
* Housing market
* Mortgage stress
* Consumer confidence

These often matter more than chart indicators.

## Suggested Solution

Create a macro score.

Example:

```python
macro_score =
(
rba_outlook +
inflation_trend +
housing_trend +
employment_trend
)
```

Include macro score in every recommendation.

---

# Problem 7: No Bull Case Analysis

## Current Behaviour

The recommendation presents only bearish evidence.

## Why This Is Problematic

A robust investment process must evaluate:

* Supporting evidence
* Contradicting evidence

Without counterarguments the model becomes confirmation-biased.

## Suggested Solution

Require:

```text
Bull Case
Bear Case
Neutral Case
```

for every recommendation.

Example:

### Bull Case

* Strong dividend yield
* Potential RBA easing
* Stable housing market

### Bear Case

* Earnings revisions declining
* Weak momentum
* Margin pressure

---

# Problem 8: No Opportunity-Cost Analysis

## Current Behaviour

The system recommends:

```text
TRIM 38%
```

but does not explain:

```text
Where should the capital go?
```

## Why This Matters

Selling is only half the decision.

Alternatives matter.

Examples:

* Move to cash
* Move to CBA
* Move to MQG
* Move to VGS
* Move to defensive sectors

Each has different implications.

## Suggested Solution

Add:

```text
Capital Reallocation Analysis
```

Example:

| Alternative | Expected Return | Risk   |
| ----------- | --------------- | ------ |
| Keep WBC    | 6%              | Medium |
| Cash        | 4%              | Low    |
| VGS         | 8%              | Medium |
| MQG         | 10%             | High   |

---

# Problem 9: Lack of Expected Return Forecasting

## Current Behaviour

Recommendation contains no explicit return expectations.

## Suggested Solution

Require:

### Base Case

Expected 12-month return

### Bull Case

Expected 12-month return

### Bear Case

Expected 12-month return

Example:

```text
Bull: +15%
Base: +7%
Bear: -8%
```

This enables risk/reward assessment.

---

# Problem 10: Thesis Failure Detection Needs More Precision

## Current Behaviour

The engine states:

```text
Mean reversion thesis failed
```

but evidence is relatively simple.

## Suggested Improvement

Track thesis KPIs at entry.

Example:

### Entry Thesis

```text
Oversold bank expected to revert to mean.
```

### Success Conditions

```text
RSI > 60
Price > SMA50
Relative strength positive
```

### Failure Conditions

```text
RSI deteriorates
Relative performance weakens
Earnings revisions decline
```

This creates objective thesis monitoring.

---

# Recommended Institutional Decision Framework

Before issuing BUY, SELL, TRIM or ADD:

## Thesis Review

1. Original thesis
2. Current thesis status
3. Supporting evidence
4. Contradicting evidence

## Fundamental Analysis

1. Earnings revisions
2. Revenue growth
3. Margin trends
4. Cashflow trends

## Macro Analysis

1. Interest rates
2. Inflation
3. Employment
4. Sector outlook

## Portfolio Analysis

1. Position size
2. Sector concentration
3. Diversification impact
4. Opportunity cost

## Risk Analysis

1. Confidence score
2. Downside estimate
3. Volatility estimate
4. Invalidation criteria

## Decision Logic

```python
if confidence < threshold:
    action = "HOLD"

elif expected_return < risk_free_rate:
    action = "TRIM"

elif thesis_broken:
    action = "SELL"

else:
    action = "HOLD"
```

---

# Final Recommendation

The current framework is stronger than most retail AI investment systems due to its focus on explainability and risk controls.

The highest-priority improvements are:

1. Enforce confidence gates.
2. Reduce reliance on analyst targets.
3. Reduce reliance on technical indicators.
4. Add company-specific fundamental analysis.
5. Add macroeconomic context.
6. Require bull and bear case evaluation.
7. Include opportunity-cost analysis.
8. Introduce expected-return forecasting.
9. Improve thesis tracking methodology.
10. Use portfolio-level optimization rather than position-level signals alone.

Implementing these improvements would likely elevate the system from approximately 6.5/10 quality to 8.5/10+ quality and make recommendations substantially more robust, consistent, and institutionally aligned.
