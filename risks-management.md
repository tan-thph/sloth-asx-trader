# Risk Management Guide — Backtesting, Risk Dashboard & Learning Loop

A practical, plain-English guide to the three tools in Sloth ASX Trader that exist to keep you disciplined: **Backtesting**, the **Risk Dashboard**, and the **Learning Loop**. This is a *user* guide — it explains what each number means, how to read it, and what to do about it. (For the engineering internals, see [`learning_loop.md`](learning_loop.md) and [`CLAUDE.md`](CLAUDE.md).)

---

## The big picture: three different questions

These three tools are easy to confuse because they all touch "risk." They actually answer three *different* questions, at three different points in time:

| Tool | The question it answers | Time frame |
|---|---|---|
| **Backtesting** | "Would this *strategy* have worked in the past?" | The past, hypothetically |
| **Risk Dashboard** | "How exposed is my portfolio *right now*?" | The present |
| **Learning Loop** | "Are *my actual decisions* any good, and where am I systematically wrong?" | Your real track record |

A useful way to hold them in your head:

- **Backtesting** tests a *rule*. (Does "buy when RSI < 45 and price > SMA50" make money?)
- **Risk Dashboard** tests your *current book*. (If the market drops 5% tomorrow, how much do I lose?)
- **Learning Loop** tests *you* (and Claude). (When I say I'm 80% confident, do I actually win 80% of the time?)

You need all three. A great strategy (backtest) run on an over-concentrated portfolio (risk dashboard) by an over-confident operator (learning loop) still blows up.

---

# Part 1 — Backtesting

## What it is

Backtesting replays a **mechanical trading rule** over real historical price data and tells you how it would have performed. It is a *hypothesis test*: "if I had blindly followed this rule, would I have made money, and how painful would the ride have been?"

It is found on the **Backtest** page. There are three modes:

1. **Standard backtest** — run one strategy over one lookback window.
2. **Walk-forward** — the honest version (tunes parameters on old data, tests on *unseen* data).
3. **AI replay** — scores how Claude's *actual past recommendations* would have played out.

> **Important framing.** A backtest is a sanity check, not a crystal ball. The market doesn't promise to repeat. A backtest that looks amazing tells you the rule *wasn't insane* in the recent past — nothing more. Its real value is the *opposite*: a backtest that looks terrible is a strong reason **not** to trade a rule.

## The strategies you can test

| Strategy | The rule, in one line |
|---|---|
| `rsi_trend` | Buy mild weakness (RSI < 45) *while the medium-term uptrend holds* (price > SMA50). |
| `macd` | Buy/sell on MACD line crossing its signal line. |
| `bb_reversion` | Mean-reversion: buy near the lower Bollinger band, sell near the upper. |
| `momentum` | Buy strength, ride the trend. |
| `sma_crossover` | Classic moving-average crossover. |
| `buy_hold` | The benchmark — buy on day one, hold to the end. **This is the bar every other strategy must beat.** |

> **Always compare against `buy_hold`.** If a clever strategy can't beat simply buying and holding the same stock over the same window, the cleverness is costing you money (in brokerage, slippage, and missed upside). The walk-forward mode shows the buy-and-hold return alongside the strategy return for exactly this reason.

## How to run one

On the **Backtest** page:

1. Pick one or more **tickers** (up to 100).
2. Choose a **period**: `3mo`, `6mo`, `1y`, or `2y`.
3. Set **starting capital** and **brokerage per trade**.
4. Choose a **strategy**.
5. Choose a **slippage mode** (see below).
6. Run. You get summary stats, a per-trade log, and an equity curve.

### Slippage — don't skip this

Slippage is the gap between the price you *see* and the price you actually *get*. Ignoring it makes every backtest look better than reality.

- **Flat** — a fixed % haircut on every fill (default 0.10%). Simple, conservative-ish.
- **Liquidity** — smarter. It scales the haircut by the stock's **average daily turnover (ADV)**: thin, illiquid names get a bigger haircut because you actually move the price when you trade them. This is the realistic choice for small-cap ASX names.

> **Rule of thumb:** if you trade anything outside the ASX 50, use **liquidity** slippage. A strategy that only works under flat slippage but dies under liquidity slippage is a strategy that only works on paper.

## Reading the results — every metric explained

| Metric | What it means | How to read it |
|---|---|---|
| **Total Return** | Net % gain/loss over the window, after costs. | Compare to buy_hold over the *same* window, not in isolation. |
| **Total P&L** | The dollar version of total return. | Reality check against your real capital. |
| **Total Trades** | How many round-trips the rule generated. | Very high = over-trading; costs and slippage will eat you. Very low = not enough data to trust the stats. |
| **Win Rate** | % of trades that closed green. | **A high win rate is NOT the goal.** A 40% win rate with big winners beats an 80% win rate with tiny wins and huge losers. Read it *with* profit factor and avg win/loss. |
| **Avg Win / Avg Loss** | Average $ on winning vs losing trades. | You want avg win meaningfully bigger than avg loss. This is your "edge per trade." |
| **Profit Factor** | Gross profit ÷ gross loss. | **The single most useful number.** >1 = profitable. >1.5 = decent. >2 = strong. <1 = the rule loses money. `null` means there were no losing trades in the sample (too small to trust). |
| **Sharpe Ratio** | Return per unit of volatility (risk-adjusted return). | >1 is good, >2 is excellent, <0 means you'd have been better off in cash. A high return with a low Sharpe means you took a wild, stomach-churning ride to get it. |
| **Max Drawdown** | The worst peak-to-trough fall the equity curve suffered. | This is the **"could I actually have stomached this?"** number. A strategy with +30% return but −40% max drawdown would have had you panic-selling at the bottom. Always ask: could I have held through that? |

> **Price basis note.** Backtest prices use yfinance's **dividend-adjusted (total-return)** series — dividends are notionally reinvested. So returns include income, not just capital gains, and the price levels in the trade log will sit *below* the nominal chart price on that date. Signal timing (RSI, MACD, etc.) is unaffected because those indicators are scale-invariant.

## Walk-forward — the version you should actually trust

The dirty secret of backtesting is **overfitting**: if you try enough parameter combinations, *something* will look brilliant on past data purely by luck. It then falls apart the moment you trade it live.

**Walk-forward** defends against this. It:

1. Splits history into an **in-sample** (training) window and an **out-of-sample** (test) window.
2. Finds the best parameters on the *training* window.
3. Then measures how those parameters perform on the *unseen test* window — data they were never tuned on.

The **test-window** Sharpe and win rate are the honest numbers. If a strategy looks great in-sample but mediocre out-of-sample, you've caught overfitting before it cost you real money. **Trust the out-of-sample result, not the headline backtest.**

## AI Replay

This scores how Claude's *real historical recommendations* would have played out as mechanical trades — a bridge between backtesting (hypothetical rules) and the Learning Loop (your real outcomes). Use it to ask: "would I have done better just executing every AI call mechanically?"

## Common backtesting pitfalls (read before you trust any result)

- **Survivorship & small samples.** Ten trades is not a track record. Be very skeptical of any stat from <30 trades.
- **Curve-fitting.** If you tweaked the strategy until the backtest looked good, you've fitted to noise. Use walk-forward.
- **Ignoring costs.** Always include realistic brokerage and liquidity slippage.
- **One ticker, one window.** A strategy that only works on CBA over the last year is not a strategy. Test across several names and periods.
- **Confusing return with quality.** Read Sharpe and max drawdown, not just total return.

---

# Part 2 — The Risk Dashboard

## What it is

The Risk Dashboard (the **Risk** page) is an X-ray of your portfolio **as it stands right now**. Backtesting asks "would this rule have worked?"; the Risk Dashboard asks "if something goes wrong tomorrow, how badly am I hurt — and am I too concentrated, too leveraged to the market, or too exposed to a single sector?"

It fetches 90 days of data from yfinance and computes per-holding and portfolio-level risk metrics. (If yfinance is rate-limited you'll see a warning banner and dashes — just retry.)

## The Composite Risk Score (0–100)

At the top is a single gauge that blends **four** dimensions, 25 points each:

1. **Volatility** — how much your holdings swing (10–35% annualised range).
2. **Concentration** — how much sits in your single biggest sector (20–60% range).
3. **Drawdown** — the historical worst-fall of your holdings (5–25% range).
4. **Beta** — how much you amplify market moves (0.5–1.5 range).

| Score | Label | Reading |
|---|---|---|
| 0–33 | 🟢 Low Risk | Conservative book. Fine — but check you're not *under*-invested for your goals. |
| 34–66 | 🟡 Moderate | Normal for an active equity portfolio. |
| 67–100 | 🔴 High Risk | You're carrying real fragility — concentrated, volatile, or highly market-sensitive. Look at *which* of the four dimensions is driving it. |

The score is a conversation-starter, not a verdict. Its job is to make you look at the components.

## The per-holding and portfolio metrics

| Metric | What it means | What "good" looks like |
|---|---|---|
| **Beta** | How much you move when the market (VAS.AX) moves. Beta 1.2 = you swing 20% *more* than the index. | <0.8 defensive · 0.8–1.2 market-like · >1.2 aggressive. Neither is "right" — it should match your conviction on market direction. |
| **Volatility (annualised)** | The size of your typical swings, scaled to a year. | <15% calm · 15–25% normal · >25% rough. |
| **Sharpe** | Return earned per unit of risk taken (uses the live RBA cash rate as the risk-free benchmark). | >1 good · 0–1 mediocre · <0 you're being paid less than cash for the risk. |
| **VaR 95% (Value at Risk)** | The loss you'd expect to *exceed* on the worst 1-in-20 days. "VaR −3%" ≈ "on a bad day, expect to lose at least 3%." | Closer to zero is safer. Worse than −3.5% is a hot book. |
| **CVaR 95% (Conditional VaR)** | The *average* loss on those worst-5% days — i.e. how bad the tail actually gets *when* it goes bad. Always worse than VaR. | This is your "how ugly is the ugly scenario" number. |
| **Max Drawdown** | Worst peak-to-trough fall in the holding's history. | The gut-check: could you have held through it? |

> **VaR vs CVaR, the intuition.** VaR says "the bouncer at the door turns away the worst 5% of days." CVaR says "and here's how bad those turned-away days actually were on average." CVaR is the more honest tail measure — pay attention to it for concentrated or volatile books.

## Correlation heatmap

A grid showing how your holdings move *together*. Two holdings with high positive correlation (e.g. two big banks, two iron-ore miners) are not real diversification — when one falls, the other usually falls with it.

> **Use it to find hidden concentration.** You might *think* you hold six different stocks, but if four of them are 0.8+ correlated, you effectively hold three positions. Look for clusters of dark "high-correlation" cells.

## Sector concentration

A pie of your portfolio by GICS sector, with warnings:

- **>25% in one sector** → amber. Getting concentrated.
- **>40% in one sector** → red. One sector shock can wreck your year.

The ASX is *structurally* concentrated (Financials + Materials dominate the index), so this is an easy trap. The dashboard makes it visible.

## Heat Budget — your single most important risk control

The **Heat Budget** caps the **total dollars you have at risk to your stop-losses**, expressed as a % of your portfolio. Set it in the budget input on the Risk page (`maxRiskBudgetPct`, default **5%**).

"Heat" = the sum, across all open positions, of (entry − stop) × shares. It's the money you'd lose if *every* open position hit its stop at once.

- The dashboard shows **current heat vs your budget**.
- When you're near or over budget, the analysis engine **scales down or blocks new BUY recommendations** so you can't keep piling on risk.
- The budget **tightens automatically in worse regimes** (the regime engine shrinks position sizes in risk-off/panic).

> **Why this matters more than any single metric.** Position sizing is where accounts actually blow up — not on any one bad call, but on *too many* bad calls open at once. The heat budget is the seatbelt. A conservative 3–6% is sensible for most people; only raise it if you genuinely understand the drawdown that implies.

## Target Allocations, Drift & Rebalance

Set a **target weight %** per ticker. The dashboard then shows **drift** — how far each holding has wandered from its target:

- **>5% drift** → amber △ Drift
- **>10% drift** → red ⚠ Rebalance

The **📋 Suggest Rebalance** button generates **deterministic** BUY/TRIM suggestions (no AI call) to pull everything back toward target — sorted by largest drift, filtering out trivial moves, and **warning you about CGT-discount-at-risk parcels** (holdings 320–364 days old that you'd lose the 12-month discount on if you sell early). It also flags if the buys exceed your available cash.

> Rebalancing is unglamorous and it works. It mechanically forces you to trim winners and add to laggards — the opposite of what fear and greed tell you to do.

## Drawdown Monitor

If you have at least two days of portfolio history, the dashboard tracks your **live drawdown** from your peak net worth and fires an alert when it breaches your `drawdownAlertPct` threshold (Settings, default 10%). This is your early-warning system that something in the book is going wrong *across* positions.

---

# Part 3 — The Learning Loop

## What it is

The Learning Loop is the system's **memory and conscience**. Every recommendation — whether you executed it or not — is logged, tracked to its real outcome, and fed back into future analysis as compact **calibration**.

Backtesting tests a rule; the Risk Dashboard tests your current book; the **Learning Loop tests your actual decision-making over time**. It answers the questions traders almost never ask honestly:

- When I (or Claude) say "80% confident," do I actually win 80% of the time?
- Which market regimes am I good in, and which chew me up?
- Which *sectors* do I have an edge in, vs the whole market?
- *Why* do my losers lose — bad thesis, stop too tight, over-confidence, wrong regime?
- Which entry *styles* pay off for me, and only when their thesis actually holds?

## How it learns — the cycle

```
You get a recommendation  →  it's logged with a full signal snapshot
        ↓
You execute (or skip) it  →  outcome tracked to close, incl. the real price path
        ↓
Closed trades are tagged & scored automatically (by rule, not guesswork)
        ↓
Compact calibration is fed into the NEXT analysis  →  Claude adjusts
```

Crucially, even trades you **skip** are price-checked weeks later ("virtual outcomes"), so the system learns from the trades you *didn't* take — not just a biased sample of the ones you did.

## Calibration — the heart of it

After every analysis, the app injects a small **calibration block** into Claude's prompt. It's a dense, decay-weighted summary of your recent track record. A real example:

```
CALIBRATION(30cls, 2026-03→2026-06, riskOn, hl=50d):
  conf 60-70%: 26%WR (Δ-39pp, adj-0.15, ESS=12.7);
  conf 70-80%: 29%WR (Δ-46pp, adj-0.15, ESS=7.3);
  conf 80-90%: ⚠low ESS=3.3(n=5) — data too stale for reliable calibration;
  top_err: TB(9/23 losses) → add re-validation step.
```

How to read it:

| Piece | Meaning |
|---|---|
| `30cls` | 30 closed trades in the sample. |
| `2026-03→2026-06` | The date range of the data. |
| `riskOn` | The current market regime the stats are scoped to. |
| `hl=50d` | Half-life of the decay weighting — recent trades count more (shorter in volatile regimes). |
| `conf 70-80%: 29%WR` | When confidence was 70–80%, you actually won 29% of the time. |
| `Δ-46pp` | That's **46 percentage points worse** than the stated confidence — serious over-confidence. |
| `adj-0.15` | So the engine automatically shaves 0.15 off confidence in that band. |
| `ESS=7.3` | **Effective Sample Size** — the statistically meaningful trade count after decay weighting. |
| `⚠low ESS` | Not enough reliable data in that band — the system *withholds* judgment rather than acting on noise. |
| `top_err: TB(9/23)` | The dominant error tag: `thesis_broken` caused 9 of 23 losses → a concrete fix is suggested. |

> **The discipline here is statistical honesty.** The loop only nudges Claude when the data clears a real significance bar (a Wilson confidence interval, ESS ≥ 6, minimum trade counts). It deliberately stays *silent* on small samples instead of "finding" patterns in noise. When you see a `⚠low ESS` warning, that's the system being honest that it doesn't yet know — which is exactly what you want.

## What gets measured

### Confidence bands
Win rate per confidence band (60–70%, 70–80%, …) with confidence intervals. This is your **calibration curve** — the gap between stated and actual confidence. Persistent over-confidence is the most common and most expensive trading flaw, and this is where you'll see it.

### Regime performance
Win rates split by market regime (riskOn / riskOff / trend / sideways / highVol / panic). You will almost certainly discover you have an edge in some regimes and a *negative* edge in others. The actionable lesson: trade smaller (or not at all) in your bad regimes.

### Sector vs the whole market
Every sector's win rate is shown as a **delta against your overall baseline** — `Banking: 50%WR vs mkt 23% (+26.7pp)`. This framing is deliberate: a 55% win rate reads as *strong* in a 45% market and *weak* in a 65% market. An absolute number lies; the delta tells the truth. The `by_sector` breakdown also shows your dominant error tag per sector.

### Thesis Tracking & the Accuracy Matrix
Each BUY is tagged with **why** you entered:

- `mean_reversion` · `momentum_breakout` · `trend_pullback` · `fundamental_value` · `macro_tailwind`

When you sell, the app compares your original thesis to current conditions and records whether it was **validated** (it played out), **invalidated** (it reversed), or **irrelevant** (didn't drive the result). The **Thesis Accuracy Matrix** then cross-tabs entry style × verdict × average P&L, so you can see which entry styles actually pay off for you — and that they usually only pay off *when the thesis holds*.

### Error tags — why losers lose
Every closed loser is automatically tagged (by rule, from the captured data — no AI guessing by default). A single loss can carry **several** tags at once:

| Tag | Meaning |
|---|---|
| `thesis_broken` | The technical reason you bought reversed. |
| `stop_too_tight` | Shaken out by ordinary noise while the thesis was still intact. |
| `missed_catalyst` | Entered within 14 days of an earnings date. |
| `early_exit` | Cut a winner short — it later reached target. |
| `oversized` / `undersized` | Sizing was overridden at entry. |
| `overconfident` | High stated confidence (≥75%) yet it lost. |
| `poor_rr` | Entered with reward:risk below 1.5. |
| `poor_entry` | Entry was technically stretched for the chosen style. |
| `regime_mismatch` | Bought into a risk-off or panic market. |
| `external_shock` | Black swan (manual tagging only — rules can't infer news). |

The dominant tag across your losses becomes a concrete suggestion in the calibration block.

### Skill Score (0–10) — separating skill from luck
The most subtle and valuable measure. It uses the **thesis verdict × outcome** quadrant:

| At exit, the thesis was… | You won | You lost |
|---|---|---|
| **Validated** | ~8 — right read, made money (**skill**) | ~6 — right read, stopped on noise (**unlucky, good process**) |
| **Irrelevant** | ~5.5 | ~4 |
| **Invalidated** | ~3 — wrong read, won anyway (**luck**) | ~2 — wrong read, lost (**misread**) |

> **Why this matters.** A naive review rewards every win and punishes every loss. That trains you to chase luck and abandon good process after unlucky losses. The skill score does the opposite: it praises a *disciplined loss* (right thesis, stopped by noise) and is suspicious of a *lucky win* (wrong thesis, paid anyway). Over time it steers you toward repeatable process, not gambling.

### Few-shot exemplars
During full analysis, the loop feeds Claude a handful of your **own recent losses and best wins** — matched by entry conditions (RSI, Bollinger position, trend) to your *current* setup. Instead of abstract stats, Claude sees concrete reminders: "last time you bought this kind of setup, here's what happened." This is the single highest-impact lever in the feed.

## How to use the Learning page

The **Learning** page is where you close the loop. A practical weekly routine:

1. **Tag your losers** (or let the automatic rule-based tagging do it — it runs free on every calibration fetch). For losses needing world-knowledge (a news shock), run the optional 🤖 Ollama postmortem.
2. **Read the calibration accuracy table** — is your confidence honest? Are you systematically over-confident in any band?
3. **Read the Thesis Accuracy Matrix** monthly — which entry styles actually work for you?
4. **Check regime and sector performance** — where's your edge, where's your bleed?
5. **Add trading lessons** — persistent, scoped notes ("don't buy REITs in rising-rate regimes") that get injected into future analysis automatically.

> The optional **Ollama debate engine** (local, free) gives a manual second opinion on disputed losses — single-model postmortems, adversarial two-model debates, and an optional cloud adjudicator. It's a *manual override*; the automatic rule-based tagging is the default.

## What makes this loop trustworthy

- **Deterministic by default.** Tags and skill scores are computed by rule from captured data — same trade in, same tags out. No AI hallucinating a tidy story for a random loss.
- **Statistically gated.** Nudges only fire when the sample clears a significance bar. The loop withholds judgment on thin data.
- **Decay-weighted & regime-aware.** A loss from a different market six months ago doesn't carry the same weight as last week's loss in today's regime.
- **Unbiased by skips.** Virtual outcomes mean the loop learns from the trades you avoided, not just the ones you took.
- **Honest about exits.** A disciplined stop-out that protected capital is *not* counted as a model error — penalizing it would train you to hold losers.

---

# Part 4 — Factor Stability (Market Scanner)

## What it is

The **Factor Stability** tab lives inside Market Scanner. It answers a specific, important question: **are the signals the scanner uses to score stocks actually predictive of future returns, or do they just look good in retrospect?**

Every stock in a market scan gets a score from 0 to 100. That score is built from five factor components — Trend, Pullback, Volume, Momentum, and Relative Strength — weighted according to `FACTOR_WEIGHTS` in `indicators.py`. The default weights (Trend 30, Pullback 30, Volume 20, Momentum 10, RS 10) are reasonable priors, but the market's factor landscape shifts. What predicted forward returns two years ago may not predict them now. Factor Stability is the periodic check that the weights still earn their keep.

## The underlying test — Information Coefficient (IC)

For each factor signal, the test computes its **Information Coefficient**: a Spearman rank correlation between the factor signal value (measured today) and the actual stock return 20 trading days later.

- **IC = +1.0** — the factor perfectly ranks stocks by their subsequent return. Higher signal = higher return. Ideal.
- **IC = 0.0** — the factor has no relationship with forward returns. It's noise.
- **IC = −1.0** — the factor is perfectly *anti*-predictive. Higher signal = lower return. The factor should be removed or inverted.

In practice, a factor IC of 0.05–0.15 is considered useful in equity markets. Anything below 0.03 in absolute value is indistinguishable from noise at the sample sizes the ASX provides.

## K-fold cross-validation — why it matters

The test doesn't just measure IC on the full history, which would let a factor look good by fitting to the past. It uses **K-fold cross-validation** (default 5 folds):

1. The price history for your selected tickers is divided into K equal time slices.
2. For each fold, that slice becomes the **out-of-sample (test) window** — data the factor was never tuned on.
3. The remaining slices become the **in-sample (train) window**.
4. Both IC values are recorded, and the process repeats K times.
5. Final ICs are averaged across all folds.

The result: two IC values per factor — **train IC** (in-sample, optimistic) and **test IC** (out-of-sample, honest). The test IC is the one that matters.

## The eight factors tested

The stability test evaluates eight granular sub-signals that feed into the five high-level scanner components:

| Factor | What it measures | High signal = |
|---|---|---|
| `above_sma20` | Price above 20-day SMA | Short-term uptrend intact |
| `above_sma50` | Price above 50-day SMA | Medium-term trend intact |
| `sma20_rising` | 20-day SMA slope positive | Trend accelerating |
| `rsi_zone` | RSI in 35–55 zone (ideal pullback RSI) | Healthy reset — not oversold panic, not overbought |
| `pullback_pct` | Price 5–20% below its 90-day high | Textbook pullback entry window |
| `vol_surge` | 5-day average volume > 1.5× 20-day average | Accumulation underway |
| `momentum_5d` | 5-day return % | Short-term price momentum |
| `momentum_20d` | 20-day return % | Medium-term price momentum |

These are more granular than the five high-level `FACTOR_WEIGHTS` — the stability test drills into the sub-components to find which specific signals are carrying the weight.

## Reading the results

### Per-factor verdict

| Verdict | Stability ratio (test_ic / train_ic) | What it means | Action |
|---|---|---|---|
| **stable** | ≥ 0.6 | Factor predicts returns OOS almost as well as in-sample. | Keep or increase weight. |
| **marginal** | 0.3–0.6 | Some OOS predictive power, weaker than in-sample. | Acceptable — monitor. |
| **weak** | 0.2–0.3 | OOS power is thin. Might be noise. | Consider reducing weight. |
| **overfitted** | Negative (sign flip) | Factor that looked positive in-sample *inverts* OOS — a fitted artefact, not signal. | **Reduce weight to zero** or remove. |
| **noise** | |test_ic| < 0.03 | IC too small to distinguish from random. | Reduce weight. |
| **insufficient_data** | — | Not enough bars in the test window. | Run with more tickers or a longer period. |

### Stability ratio

`stability = test_ic / train_ic`

A ratio of 1.0 means the OOS IC matches the in-sample IC perfectly — the factor generalises completely. A ratio of 0.5 means half the in-sample signal survives. A negative ratio means the OOS relationship flipped sign — the classic signature of curve-fitting.

> A factor with a high train IC but a negative stability ratio is actively dangerous: it passed the in-sample screen but does the *opposite* of what you want in live trading. This is the pattern factor stability is specifically designed to catch.

### Overall Weighted IC

A single summary number: the weighted average of absolute test ICs across all factors, weighted by their current `_FACTOR_WEIGHTS`. Higher is better.

- **> 0.10** — good overall factor quality
- **0.05–0.10** — acceptable
- **< 0.05** — the scanner score may be driven more by noise than signal

### Suggested weights row

The UI shows a "suggested weights" row that scales factor weights proportionally to their out-of-sample IC. This is the empirically-derived weight set — if you update `FACTOR_WEIGHTS` in `indicators.py` to match these values, the scanner score will reflect actual predictive power rather than prior beliefs.

## How to run it

On the **Market Scanner** page → **Factor Stability** tab:

1. Select **tickers** — paste in your portfolio or a representative sample. Use at least 10 diverse names; more is better.
2. Set **period** — `2y` recommended. Longer periods give more stable fold estimates.
3. Set **folds** (2–10, default 5) — more folds = more robust estimate but slower.
4. Set **forward bars** (default 20) — the number of trading days you're trying to predict. 20 bars ≈ 4 weeks.
5. Click **Run**.

The endpoint calls `POST /api/scanner/factor-stability`, fetches 2 years of adjusted OHLCV for each ticker, runs K-fold IC on the 8 granular factors, and returns results in ~10–30 seconds.

## When to run it

**Run it quarterly**, or after a major market regime change (a sharp selloff/rally, a regime flip that persists for 4+ weeks). Factor effectiveness is regime-dependent:

- Momentum factors tend to work better in trend/riskOn regimes and poorly in panic/sideways.
- Mean-reversion factors (RSI zone, pullback_pct) work better in ranging/highVol markets.
- Volume factors tend to be more consistent across regimes.

If you run it and see `vol_surge: overfitted`, that's a signal to reduce the Volume weight in `indicators.py` for this market environment. If `above_sma50: stable` but `momentum_5d: noise`, consider shifting weight from momentum toward trend.

## Updating the weights

When the stability test recommends different weights:

1. Open `indicators.py`.
2. Find `FACTOR_WEIGHTS` (line ~361):
   ```python
   FACTOR_WEIGHTS = {
       "trend":    30,
       "pullback": 30,
       "volume":   20,
       "momentum": 10,
       "rs":       10,
   }
   ```
3. Update the values to match the suggested weights row from the Factor Stability output. **The five values must sum to exactly 100** — the code emits a warning at import time if they don't.
4. No server restart needed — `_score_ticker()` reads `FACTOR_WEIGHTS` at runtime.

> The stability test evaluates 8 sub-factors; the `FACTOR_WEIGHTS` dict controls 5 high-level groups. Use the sub-factor results directionally: if `above_sma20`, `above_sma50`, and `sma20_rising` are all stable, the Trend group deserves high weight. If `momentum_5d` is noise and `momentum_20d` is weak, reduce the Momentum weight.

## What factor stability does not tell you

- It measures **linear rank correlation** (Spearman). It will miss a factor that's useful in a non-linear way (e.g. only matters at extremes).
- It uses **price returns as ground truth**. A factor that predicts volatility or drawdown risk is invisible to it.
- A **short history** (< 80 bars per fold) can produce noisy IC estimates — treat borderline verdicts with scepticism on small samples.
- It does not account for **transaction costs**. A factor with a modest IC might still be worthwhile if it drives slow-turnover, low-cost positions.

---

# How the three work together

A complete risk-management workflow uses all three in sequence:

1. **Before you trust a strategy** → backtest it (with liquidity slippage, against buy_hold, ideally walk-forward).
2. **Before you place a trade** → check the Risk Dashboard: are you within heat budget, not over-concentrated, not adding correlated exposure?
3. **After the trade closes** → the Learning Loop records the outcome, tags it, and feeds the lesson into your next decision.

The loop is virtuous: backtesting keeps your *rules* sane, the dashboard keeps your *book* sane, and the learning loop keeps *you* honest. Skip any one and the other two can't save you.

---

# Quick glossary

| Term | Plain meaning |
|---|---|
| **Sharpe ratio** | Return per unit of risk. Higher is better; >1 is good. |
| **Max drawdown** | The worst peak-to-trough fall. "Could I have held through this?" |
| **VaR (Value at Risk)** | The loss you'd expect to exceed on a bad (1-in-20) day. |
| **CVaR** | The *average* loss on those bad days — the tail's true ugliness. |
| **Beta** | How much you amplify market moves. 1.0 = moves with the index. |
| **Profit factor** | Gross wins ÷ gross losses. >1 is profitable; >2 is strong. |
| **Slippage** | The gap between the price you see and the price you get. |
| **Walk-forward** | Backtesting that tests on *unseen* data — guards against overfitting. |
| **Heat / Heat budget** | Total $ at risk to your stops / the cap you set on it. |
| **Drift** | How far a holding has wandered from its target weight. |
| **Calibration** | How well stated confidence matches actual win rate. |
| **ESS (Effective Sample Size)** | The statistically meaningful trade count after decay weighting. |
| **Regime** | The current market mode (riskOn / riskOff / panic / etc.). |
| **Thesis verdict** | Did the reason you entered actually play out? (validated/invalidated/irrelevant) |
| **Skill score** | How much of an outcome was skill vs luck (0–10). |
| **MAE / MFE** | The worst drawdown / best gain a trade reached while you held it. |
| **Virtual outcome** | The hypothetical result of a trade you *skipped*, checked later. |

---

*This guide describes the app as of Sprint 71 (2026-06). The behaviour of every number here is enforced in code and covered by the test suite — see [`learning_loop.md`](learning_loop.md) for the technical detail.*
