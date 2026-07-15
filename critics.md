Recommendation 1
Separate Importance from Trading Opportunity

Currently

Impact

is doing too much work.

I'd split it.

Example

{
  "importance": 9,
  "tradeOpportunity": 3,
  "portfolioImportance": 8
}

Example:

Fed rate decision

Importance = 10

Trade Opportunity = 4

Portfolio Importance = 10

Small-cap earnings beat

Importance = 6

Trade Opportunity = 9

Portfolio Importance = 2

Those are different concepts.

Recommendation 2
Replace Event Types with Event Objects

Currently

Takeover

is an event type.

I'd evolve toward

{
  "eventType":"Takeover",

  "actors":[
      "Company A",
      "Company B"
  ],

  "winner":"Target",

  "loser":"Competitors",

  "certainty":"Confirmed"
}

The AI then reasons over richer semantics instead of labels.

Recommendation 3
Add Event Lifecycles

Most news isn't a single event.

Example

Guidance Warning

↓

Analyst Downgrade

↓

Price Collapse

↓

CEO Resigns

↓

Capital Raise

These are all one evolving story.

I'd assign

event_id

to each story.

Then maintain

Current Severity

↓

Current Confidence

↓

Latest Update

↓

Resolved?

instead of treating each article independently.

Recommendation 4
Portfolio Exposure Engine

This would be my highest-priority enhancement.

Every event should answer

Who owns this risk?

Example

Iron Ore Falls

↓

Portfolio

↓

RIO

BHP

FMG


and

Banks

↓

No exposure

↓

Ignore

Then Claude receives

Today's News

↓

Portfolio Exposure

↓

Only Relevant News

instead of every high-impact article.

Recommendation 5
Event Persistence

Different events decay differently.

Example

CEO resigns

↓

Importance drops quickly

versus

Rate Cut Cycle

↓

Important for months

I'd add

Decay Half-Life


Examples

Factory Fire

3 days

Dividend

2 weeks

Earnings

30 days

War

90 days

Interest Rates

180 days

Your portfolio AI then naturally focuses on active stories.

Recommendation 6
Learn Actual Market Impact

This is the feature I'd invest in before anything else.

Currently

LLM predicts

↓

Impact = 8

Later evaluate

Sector Move

↓

Only 2%

Store

Prediction Error

Eventually

War

↓

Usually overestimated


or

Guidance Downgrade

↓

Usually underestimated


The classifier gradually becomes calibrated.

Recommendation 7
Historical Event Playbooks

Very similar to your Learning Loop.

Example

Event

↓

Capital Raise

↓

History

↓

Average

↓

Market Reaction

Then Claude can receive

Historically

82 capital raises

Average

-7.4%

Median Recovery

48 days


instead of reasoning from first principles.

Recommendation 8
Build a Market Knowledge Graph

This is where I think your platform naturally evolves.

Instead of

News

↓

JSON


construct

Company

↓

Sector

↓

Commodity

↓

Macro

↓

Country

↓

Supply Chain

↓

Customers

↓

Competitors

Then

Iran

↓

Hormuz

↓

Oil

↓

Shipping

↓

Inflation

↓

Rates

↓

Banks

↓

REITs

↓

AUD


The AI no longer sees isolated articles.

It sees an evolving market network.

Recommendation 9
Event Novelty

One dimension you're missing is

Expected

vs

Unexpected

Markets react to surprises.

Examples

Expected Rate Cut

↓

Low Novelty

↓

Lower Impact

versus

Unexpected Profit Warning

↓

High Novelty

↓

High Impact

Novelty is often more predictive than absolute importance.

Recommendation 10
Event Consensus

Collect classifications from multiple local models.

Example

Llama

Impact 8

Qwen

Impact 7

Gemma

Impact 8


Consensus

7.7

High Confidence

versus

Llama

9

Gemma

3

Qwen

4


Consensus

Low Confidence

Needs Cloud Review