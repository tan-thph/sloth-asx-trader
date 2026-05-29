# Learning Loop Critique & Future Architecture

This document provides a critical analysis of the current **Learning Loop** implementation in the Sloth ASX Trader codebase (as of May 2026) and outlines a comprehensive, phased implementation plan to enhance its capability, making the trading engine smarter, more disciplined, and highly adaptive.

---

## 1. Architectural Critique of Current Implementation

While the current Learning Loop successfully closes the feedback loop between recommendations and outcomes, several architectural limitations constrain its long-term efficacy:

### A. Bias Toward Failure (Negative-Only Attribution)
* **Critique:** The post-mortem engine (`/api/debate/postmortem` and adversarial debates) is strictly triggered on `loss` or `breakeven` outcomes. 
* **Impact:** The system only learns what *not* to do (e.g., identifying `overconfident` or `poor_entry`). It lacks positive reinforcement mechanisms to identify *why* a trade succeeded (e.g., strong macro alignment, sector tailwinds, or perfect execution). Consequently, the model cannot systematically double-down on high-conviction winning setups.

### B. Calibration Noise (Win/Loss vs. Skill)
* **Critique:** Calibration win rates are decay-weighted by time but treat all wins and losses equally. 
* **Impact:** A high-risk, low-skill trade that succeeded purely due to random market noise (luck) is treated as a validation of Claude's confidence. Conversely, a high-skill, disciplined trade stopped out by a sudden macro event is penalized as a model error. The calibration data remains noisy, leading to sub-optimal prompt nudges.

### C. Absence of a Structured Lessons Database
* **Critique:** Post-mortem analyses are logged as static text fields (`rationale_summary`, `postmortem_debate`, `debate_summary`) in `ai_learning_events`. There is no structured, indexed representation of "lessons learned."
* **Impact:** The system cannot perform semantically matched or tag-based retrievals of historical lessons during prompt assembly. Every new analysis starts with a blank slate regarding specific stock behaviors or setup nuances.

### D. Ex-Post Analysis vs. Ex-Ante Displipinary Gap
* **Critique:** The system measures execution outcomes retrospectively but does not enforce compliance rules prior to trade execution.
* **Impact:** If Claude suggests a trade that violates active strategy guidelines (e.g., wrong regime, inadequate liquidity), the system still logs it. The learning loop lacks an integration check that maps ex-post failure back to ex-ante checklist non-compliance.

### E. Vulnerability to Regime Transitions
* **Critique:** While the system warns Claude if there is thin data in a new regime, it does not analyze historical regime transition phases to adjust risk.
* **Impact:** When transitioning from a trend to a volatile/sideways regime, the model suffers a lag phase of losing trades before the decay weighting shifts the calibration stats.

---

## 2. Proposed Improvements & System Extensions

To resolve these limitations, we propose the following upgrades to the database, backend APIs, frontend client, and prompt structure.

### A. Skill-Weighted Calibration Algorithm
Incorporate the Ollama-scored `skill_score` (0-10) directly into the calibration weighting calculation:
$$\text{Weight}_{event} = \text{TimeDecay} \times \text{SkillFactor}$$
Where:
* $\text{TimeDecay} = e^{-\ln(2) \times \frac{\text{DaysSinceClose}}{45}}$
* $\text{SkillFactor} = \max\left(0.2, \frac{\text{SkillScore}}{10}\right)$ (guarantees that even low-score trades carry a minor baseline weight, but high-skill trades carry up to $5\times$ more statistical influence).

### B. Dynamic Lessons Database (Ticker & Sector Memory)
Implement a structured `lessons` table in SQLite to hold distilled rules. When a trade is analyzed, query this database for matches and inject them into Claude's prompt:
* **Storage Schema:** Distill post-mortems into a schema containing `ticker`, `sector`, `regime`, `setup_type`, and `lesson_text`.
* **Inference Injection:** When analyzing `BHP.AX` in `bullTrending`, retrieve specific lessons related to `BHP.AX` or the `Materials` sector during `bullTrending` regimes.

### C. Ex-Post Success Tagging (Balanced Learning)
Extend the post-mortem flow to analyze wins:
* **Tags:** `catalyst_capture` (captured earnings/news), `regime_aligned` (perfect macro timing), `confluence_entry` (technical indicators aligned), `disciplined_hold` (stayed in trade through minor drawdowns).
* **Benefit:** Allows the prompt builder to tell Claude: *"Historically in this regime, your most successful trades utilized the following setups: [Success Tags]."*

### D. Ex-Ante Structured Trade Checklist
Introduce a checklist verification step in the user interface before execution.
* **Checklist Rules:** Regime alignment, ATR volatility stop adequacy, volume Z-score, index breadth check.
* **Correlation Logging:** Save checklist answers. If a trade fails, the post-mortem automatically cross-references if any checklist rules were bypassed.

---

## 3. Database Schema Extensions

We will modify [db.py](file:///d:/Python/Projects/Sloth.ai/asx_trading/claude2/sloth-asx-trader/db.py) to register the new database tables and columns:

```sql
-- 1. Extend ai_learning_events with ex-ante checklist tags and success tags
ALTER TABLE ai_learning_events ADD COLUMN checklist_bypasses TEXT; -- Comma-separated list of bypassed checklist rules
ALTER TABLE ai_learning_events ADD COLUMN success_tags TEXT;       -- Comma-separated success tags for wins

-- 2. Add lessons table for semantic/tag retrieval
CREATE TABLE IF NOT EXISTS trading_lessons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    learning_event_id INTEGER,
    ticker TEXT,
    sector TEXT,
    regime TEXT,
    setup_type TEXT,             -- 'breakout', 'mean_reversion', 'dividend_run'
    lesson_text TEXT NOT NULL,   -- Actionable rule, e.g., "Do not buy breakouts on BHP during sideways regimes"
    confidence_delta REAL,       -- Impact score on future trades
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (learning_event_id) REFERENCES ai_learning_events(id)
);
CREATE INDEX IF NOT EXISTS idx_lessons_ticker ON trading_lessons(ticker);
CREATE INDEX IF NOT EXISTS idx_lessons_sector ON trading_lessons(sector);
```

---

## 4. Implementation Plan

```mermaid
gp Graph
    section Phase 1: Math & Analytics
    Skill-weighted Calibration      :crit, active, p1, 2026-05-28, 3d
    Success Tagging API & Prompts   :p2, after p1, 3d
    
    section Phase 2: Knowledge Storage
    Lessons DB Schema & Endpoints   :p3, after p2, 4d
    Auto-Lesson Distillation Logic  :p4, after p3, 4d
    
    section Phase 3: Inference Integration
    Lessons Prompt Injector         :p5, after p4, 3d
    Regime Transition Alerter       :p6, after p5, 2d
    
    section Phase 4: Ex-Ante Control
    Structured Checklist UI & Logic :p7, after p6, 4d
```

### Phase 1: Skill-Weighted Calibration & Success Tagging
1. **Modify Backend Calibration Compute:**
   Update `_calib_compute()` in [routes/learning.py](file:///d:/Python/Projects/Sloth.ai/asx_trading/claude2/sloth-asx-trader/routes/learning.py) to look up `skill_score` and apply the math formula.
2. **Extend Post-Mortem Prompts:**
   Update system prompts in [js/prompts.js](file:///d:/Python/Projects/Sloth.ai/asx_trading/claude2/sloth-asx-trader/js/prompts.js) to support winning trade analyses. Write a prompt that instructs the model to select positive tags (`catalyst_capture`, `regime_aligned`, etc.) and describe what went right.
3. **Automate Win Tagging:**
   Update the Javascript outcomes runner to send winning trades (e.g. `outcome_status = 'win'`) through the post-mortem tagging backend, storing tags in the new `success_tags` column.

### Phase 2: Lessons Database Integration
1. **Schema Migration:**
   Add migration logic to [db.py](file:///d:/Python/Projects/Sloth.ai/asx_trading/claude2/sloth-asx-trader/db.py) to create the `trading_lessons` table.
2. **Create REST Endpoints:**
   Add routes in `routes/learning.py` for `/api/learning/lessons` (create, read, delete).
3. **Auto-Lesson Generation:**
   Modify the post-mortem adjudication engine (`POST /api/debate/adjudicate`). When the adjudicator settles a trade analysis, instruct it to write a 1-sentence lesson (e.g., *"When trading CBA in riskOff, trailing stops must be at least 2.5x ATR to avoid volatility shakeouts"*). Save this lesson automatically to `trading_lessons`.

### Phase 3: Prompt Injection & Context-Aware Inference
1. **Fetch Matches during Analysis:**
   In [js/analysis.js](file:///d:/Python/Projects/Sloth.ai/asx_trading/claude2/sloth-asx-trader/js/analysis.js), query `/api/learning/lessons` with the current ticker, sector, and active regime.
2. **Inject Contextual Lessons:**
   Update [js/prompt-modules.js](file:///d:/Python/Projects/Sloth.ai/asx_trading/claude2/sloth-asx-trader/js/prompt-modules.js) to format the returned lessons block. Example injection payload:
   ```
   === HISTORICAL LESSONS FOR THIS SETUP ===
   * BHP: Breakout entry failed during highVol due to false upper-band breakout (Event #142).
   * Materials: Avoid long holdings in riskOff when 200 SMA is sloping downwards (Event #89).
   ```
3. **Enforce Lesson Compliance:**
   Add an instruction in the core analyst prompt: *"You must review the HISTORICAL LESSONS section. If your current trade thesis conflicts with any prior lesson, you must explicitly defend why this trade is different, or downgrade your conviction score."*

### Phase 4: Ex-Ante Checklist & Audit Trail
1. **Checklist UI Component:**
   Build a popup checklist on the Recommendations page. When executing a recommendation, the user marks off confirmation boxes:
   * [ ] Position size complies with volume liquidity thresholds?
   * [ ] Stop loss set outside the 14-day ATR boundary?
   * [ ] Macro regime gates permit this strategy?
2. **Persistence:**
   Log any unchecked items as `checklist_bypasses` in the database.
3. **Bypass Auditing:**
   During the retrospective post-mortem, display checklist bypasses to the adjudicator so it can map human/AI discipline errors directly to the outcome.

---

## 5. Verification Plan

### Automated Tests
* Add tests in [test_app.py](file:///d:/Python/Projects/Sloth.ai/asx_trading/claude2/sloth-asx-trader/test_app.py) validating:
  * Database schema migrations (creation of `trading_lessons`, index checks).
  * Skill weighting mathematical calculations (verify that a trade with a skill score of `10` is weighted higher than one with a score of `2`).
  * Endpoint functionality for fetching, saving, and deleting lessons.
  * Validation checks ensuring success tags are formatted correctly and do not overlap with error tags.

### Manual Verification
* Run a batch scan in the frontend with a mock lesson injected for a test ticker, verify that the lesson appears in the prompt logs (`POST /api/log/ai_response`).
* Manually execute a trade in the UI, bypass a checklist item, close it as a mock loss, and verify that the post-mortem debate output logs the bypass constraint.
