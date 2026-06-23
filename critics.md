Major Problem #1: Too Much Narrative, Not Enough Evidence

Example:

Gold is pricing in
inflation concerns
geopolitical hedging
central bank accumulation

This sounds intelligent.

But where is the evidence?

The report never answers:

Why did gold move today?

A good macro system should distinguish:

Observed

from

Possible explanations
Better Version

Example:

Gold +0.57%.

Potential drivers:
- USD weakness
- geopolitical concerns
- central-bank demand

Primary driver not confirmed.

Much more rigorous.

Major Problem #2: Generic AI Language

Several phrases appear generated rather than analytical.

Examples:

wall of liquidity
persistent but measured risk appetite
traders not dismissive of tail risks
constructive backdrop

These phrases sound good but carry little information.

If you removed them:

the investment decision would not change.

Major Problem #3: Missing What Changed

The most important question in macro:

What changed since yesterday?

The report doesn't answer this.

Instead it describes current levels.

Example:

VIX = 17.28

Meaningless alone.

More useful:

VIX fell from 20.1 to 17.3

or

VIX rose from 14 to 17 over 3 days

Context matters.

Major Problem #4: No Historical Context

Example:

AUD = 0.7000

The report says:

psychological level reclaimed

That's reasonable.

But I would want:

AUD:
1 week: +1.2%
1 month: +3.5%
3 months: +6.8%

Now I know whether:

trend

or

noise

is occurring.

Major Problem #5: No Impact Scoring

Your AI system ultimately needs:

What should I care about?

Current report treats everything equally.

A better system:

Factor	Importance
Gold	3/10
AUD	5/10
RBA Expectations	9/10
US Yields	8/10
China Data	9/10
Earnings Revisions	8/10

Without ranking, Claude must decide for itself.

Major Problem #6: Missing Forward-Looking Signals

The report is mostly:

market went up
gold went up
AUD went up

That's backward-looking.

Markets care about:

What happens next?

Missing:

RBA probability changes
Fed probability changes
Bond yield changes
Economic calendar
Upcoming catalysts
Major Problem #7: Weak ASX Mapping

This is the biggest weakness for your trading system.

The report says:

Resources supported
Healthcare headwind
Financials tread water

Too generic.

A portfolio engine needs:

BHP
RIO
WDS
CSL
COH
WBC
MQG

or at least sector scores.

Better Output

Example:

{
  "materials": 7,
  "energy": 6,
  "financials": 0,
  "healthcare": -2,
  "technology": -1
}

Now Claude can directly use it.

Major Problem #8: No Confidence Attribution

Every statement is written as if equally certain.

Example:

AUD supported by commodity demand tailwinds

Maybe.

Maybe not.

The system should express uncertainty.

Example:

Observed:
AUD +0.2%

Possible drivers:
- commodity strength (medium confidence)
- USD weakness (high confidence)
What I Would Add

Instead of only prose, produce structured output.

Example:

{
  "macro_regime": "mild_risk_on",
  "confidence": 0.68,

  "drivers": [
    {
      "factor": "US Equities",
      "direction": "bullish",
      "importance": 6
    },
    {
      "factor": "Gold",
      "direction": "bullish",
      "importance": 4
    },
    {
      "factor": "AUD",
      "direction": "bullish",
      "importance": 5
    }
  ],

  "sector_impact": {
    "materials": 2,
    "energy": 1,
    "financials": 0,
    "healthcare": -1,
    "technology": -1
  }
}

This is much easier for Claude to consume.

What I'd Change in Your System Prompt

Add mandatory sections:

1. What Changed
Biggest changes in last 24h.
2. Why It Matters
Expected impact on ASX.
3. Confidence
High
Medium
Low
4. Sector Impact
Financials
Materials
Energy
Healthcare
Tech
5. Portfolio Impact
Beneficiaries
Headwinds
Neutral