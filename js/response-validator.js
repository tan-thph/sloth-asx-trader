// ============================================================
// response-validator.js — Post-parse rec validation + auto-repair (3.5)
//
// validateRec(rec)                          → { valid, errors, fixed }
// validateResponse(parsed, minConfidence)   → { recs, summary, rejected, errors }
// getValidatedAnalysis(rawText, minConf)    → validated result or throws
// getValidatedAnalysisWithRepair(userMsg, agentType, maxAttempts)
//   → calls callClaude() up to maxAttempts times, validating each response
// ============================================================

// ── SELL/TRIM decision-tagging taxonomy ───────────────────────────────────────
// Three orthogonal dimensions required on every SELL/TRIM rec.
// Validated by validateSellTags(); error messages fed into the repair prompt.

const SELL_PRIMARY_DRIVERS = new Set([
  'thesis_broken',       // core reason for buying no longer holds
  'target_reached',      // price hit or exceeded the entry target
  'stop_triggered',      // price hit the stop loss
  'technical_breakdown', // SMA200 lost, BB upper rejection, MACD bearish cross + volume
  'regime_change',       // macro/sector regime that supported the trade has shifted
  'better_opportunity',  // capital better deployed elsewhere (requires alternativeTicker)
  'time_stop',           // hold window elapsed with no progress toward target
  'risk_management',     // position/sector oversized or portfolio risk metric breached
  'tax_optimisation',    // tax-loss harvest or CGT discount window
]);

const SELL_SECONDARY_FACTORS = new Set([
  'earnings_approaching',   // catalyst risk within hold window
  'sector_rotation',        // capital rotating out of the sector
  'franking_captured',      // dividend + franking already received this cycle
  'unrealised_loss_large',  // loss large enough to consider harvesting (>$500 rule)
  'held_over_12m',          // CGT discount window active
  'held_11_to_12m',         // CGT discount window approaching — flag for review
  'sector_concentration',   // single sector >30% of portfolio
  'position_oversized',     // single position >15-20% of portfolio
  'negative_news_flow',     // recent announcements or news sentiment turned negative
  'peer_outperformance',    // sector peers materially outperforming this name
  'volume_decline',         // sustained volume drying up — institutional exit signal
  'dividend_at_risk',       // dividend coverage ratio deteriorating
]);

const SELL_URGENCY = new Set(['immediate', 'routine', 'monitor']);

// ── Reject/defer contradiction phrases ────────────────────────────────────
// Strong, specific language that means "this rec should not be actionable" —
// kept narrow to avoid false positives on legitimate cautionary reasoning
// (e.g. "risk of X" or "watch for Y" do NOT trigger; only explicit
// reject/defer/fail-rule/do-not-execute language does).
const _REJECT_DEFER_PHRASES = [
  'reject this',
  'reject —',
  'reject:',
  'fails rule',
  'anti-churn block applies',
  'do not execute',
  "don't execute",
  'should be omitted',
  'should not be executed',
  'deferring to',
  'defer to',
  'defer this',
];

// Matches "reject <TICKER>" (e.g. "REJECT GMG") without hardcoding any ticker.
const _REJECT_TICKER_RE = /\breject\s+[A-Z0-9]{2,5}\b/i;

// Forbidden combinations — logical contradictions that indicate confused reasoning.
const SELL_FORBIDDEN_COMBOS = [
  ['target_reached', 'stop_triggered'],     // can't hit both simultaneously
  ['time_stop',      'target_reached'],     // time stop implies target NOT hit
  // target_reached requires "thesis STILL INTACT" (prompt §2.1) — dividend_at_risk
  // is itself a thesis-deterioration signal (income thesis breaking), so the two
  // cannot both be true. A 2026-06-25 live response tagged WOW target_reached
  // while citing an unsustainable payout ratio via dividend_at_risk — the real
  // driver was thesis_broken wearing a target_reached label.
  ['target_reached', 'dividend_at_risk'],
];

// Certain primary drivers require at least one specific secondary tag to be grounded.
const SELL_REQUIRED_SECONDARY = {
  tax_optimisation: ['unrealised_loss_large', 'held_over_12m', 'held_11_to_12m'],
  risk_management:  ['sector_concentration', 'position_oversized'],
};

// Secondary tags whose entire definition IS a numeric threshold (prompt §2.2)
// — these aren't judgment calls, they're checkable facts. Each entry returns
// true when the threshold the tag claims is actually met by ctx.holding.
// A 2026-06-25 live response tagged a $76 loss as unrealised_loss_large and
// two 1.8%-weight positions as position_oversized — both contradicted the
// numbers the model had been given.  Thresholds deliberately lower than the
// original fix to avoid false-rejections on borderline-but-genuine cases:
//   unrealised_loss_large: ≤−$200  (orig −$500; bonds/small positions still valid)
//   position_oversized:    > 10 %  (orig 15%; 10–14% IS over-weight for most mandates)
//   sector_concentration:  > 15 %  (orig 20%; Financials at 18% IS concentrated)
const SELL_GROUND_TRUTH_CHECKS = {
  unrealised_loss_large: (h) => h.unrealisedPnl != null && h.unrealisedPnl <= -200,
  position_oversized:     (h) => h.weightPct != null && h.weightPct > 10,
  sector_concentration:   (h) => h.sectorWeightPct != null && h.sectorWeightPct > 15,
  held_over_12m:          (h) => cgtDiscountEligible(h.daysHeld),   // > 365 (Audit C2)
  held_11_to_12m:         (h) => h.daysHeld != null && h.daysHeld >= 335 && h.daysHeld <= 365,
};

/**
 * _groundTruthFilterSecondary — strips any secondary_factors tag whose claimed
 * numeric threshold isn't actually met by the holding's real data. Returns the
 * surviving tags plus a human-readable list of what was dropped and why.
 * No-op (nothing dropped) when ctx.holding is absent — callers without portfolio
 * context (e.g. unit tests) get the old permissive behaviour.
 */
function _groundTruthFilterSecondary(secondary, ctx) {
  const h = ctx && ctx.holding;
  if (!h) return { kept: secondary, dropped: [] };
  const dropped = [];
  const kept = secondary.filter(tag => {
    const check = SELL_GROUND_TRUTH_CHECKS[tag];
    if (!check) return true;   // not a numeric tag — nothing to ground-check
    if (check(h)) return true; // threshold genuinely met
    dropped.push(tag);
    return false;
  });
  return { kept, dropped };
}

/**
 * validateSellTags — validates the three SELL/TRIM tagging dimensions.
 * Called from validateRec() for every SELL or TRIM rec.
 * `ctx.holding` (optional) carries real portfolio numbers — { weightPct,
 * sectorWeightPct, unrealisedPnl, daysHeld } — for the ground-truth checks above.
 * Returns { ok, errors[] } — errors feed into the auto-repair prompt.
 */
function validateSellTags(rec, ctx) {
  const errors = [];
  const action = (rec.action || '').toUpperCase();
  if (action !== 'SELL' && action !== 'TRIM') return { ok: true, errors, repaired: null };

  // Fix #40: better_opportunity without alternativeTicker — auto-repair to risk_management.
  // Checked first so validateRec can apply the repaired rec immediately without a retry.
  // (The old code checked fixed.sell_primary_driver which is a storage-layer field name —
  // Claude outputs primary_driver; that bug meant Fix #40 never fired. Corrected here.)
  if (rec.primary_driver === 'better_opportunity' &&
      (!rec.alternativeTicker || !rec.alternativeTicker.trim())) {
    const repaired = { ...rec, primary_driver: 'risk_management', _driverRepaired: true };
    return { ok: true, errors: [], repaired };
  }

  // ── secondary_factors: optional array, max 3, all from closed vocabulary ───
  const rawSecondary = Array.isArray(rec.secondary_factors) ? rec.secondary_factors : [];

  // Ground-truth numeric check, run before everything else so the
  // forbidden-combo/required-secondary checks below see the corrected list.
  // When stripping a bad tag still leaves the primary_driver grounded, this is
  // a silent, mechanical correction (no model regeneration needed) — same
  // pattern as the Fix #40 early-return above.
  const { kept: secondary, dropped: groundTruthDropped } = _groundTruthFilterSecondary(rawSecondary, ctx);
  // groundTruthUngrounded: true when stripping left the primary driver without its
  // required evidence — used below to suppress the redundant required-secondary check
  // (same root cause, only one user-facing message needed).
  let groundTruthUngrounded = false;
  if (groundTruthDropped.length) {
    const needed = SELL_REQUIRED_SECONDARY[rec.primary_driver];
    const stillGrounded = !needed || needed.some(t => secondary.includes(t));
    if (stillGrounded) {
      return {
        ok: true,
        errors: [],
        repaired: { ...rec, secondary_factors: secondary, _groundTruthTagsDropped: groundTruthDropped },
      };
    }
    // Stripping leaves primary_driver without its required grounding — flag for
    // user review with a plain-English message (no internal tag names / JSON paths).
    groundTruthUngrounded = true;
    const _GT_LABELS = {
      position_oversized:    'position not oversized (≤10% of portfolio)',
      sector_concentration:  'sector not overconcentrated (≤15% of portfolio)',
      unrealised_loss_large: 'unrealised loss too small (above −$200)',
      held_over_12m:         'holding under 12 months',
      held_11_to_12m:        'holding is not in the 11–12 month CGT window',
    };
    const droppedLabels = groundTruthDropped.map(t => _GT_LABELS[t] || t).join('; ');
    const driverLabel = (rec.primary_driver || 'unknown').replace(/_/g, ' ');
    errors.push(`Tagged as "${driverLabel}", but your actual numbers don't back it up — ${droppedLabels}. Review before acting on this one.`);
  }

  // ── primary_driver: required, must be in closed vocabulary ─────────────────
  if (!rec.primary_driver) {
    errors.push('This SELL/TRIM has no stated reason (primary_driver) — Claude didn\'t say why it wants to exit.');
  } else if (!SELL_PRIMARY_DRIVERS.has(rec.primary_driver)) {
    errors.push(`This SELL/TRIM cites an unrecognised reason "${rec.primary_driver}" — not one of the standard exit reasons.`);
  }

  if (secondary.length > 3) {
    errors.push(`This rec lists ${secondary.length} supporting factors — more than the 3-factor cap, likely padding out a thin case.`);
  }
  for (const tag of secondary) {
    if (!SELL_SECONDARY_FACTORS.has(tag)) {
      errors.push(`This rec cites an unrecognised supporting factor "${tag}" — not one of the standard tags.`);
    }
  }

  // ── urgency: required, must be in closed vocabulary ────────────────────────
  if (!rec.urgency) {
    errors.push('This SELL/TRIM has no urgency rating — unclear whether it should be acted on now or just watched.');
  } else if (!SELL_URGENCY.has(rec.urgency)) {
    errors.push(`This SELL/TRIM has an unrecognised urgency rating "${rec.urgency}".`);
  } else if (rec.action === 'SELL' && rec.urgency === 'monitor') {
    // "monitor" means "conditions forming but not yet crystallised" — only valid for TRIM
    // where a partial exit can wait. SELL is an immediate/routine decisive exit.
    errors.push('This is a full SELL marked urgency "monitor" — that\'s a "just watch it" rating, not a decisive exit. Should be immediate or routine.');
  }

  // ── forbidden combinations ─────────────────────────────────────────────────
  const allTags = new Set([rec.primary_driver, ...secondary]);
  for (const [a, b] of SELL_FORBIDDEN_COMBOS) {
    if (allTags.has(a) && allTags.has(b)) {
      errors.push(`Contradictory reasoning: this rec cites both "${a.replace(/_/g, ' ')}" and "${b.replace(/_/g, ' ')}", which can't both be true at the same time.`);
    }
  }

  // ── required secondary for certain primaries ───────────────────────────────
  // Skip when groundTruthUngrounded already captured the same problem above
  // (double-firing both messages for one root cause confuses the user).
  if (!groundTruthUngrounded && rec.primary_driver && SELL_REQUIRED_SECONDARY[rec.primary_driver]) {
    const needed = SELL_REQUIRED_SECONDARY[rec.primary_driver];
    if (!needed.some(t => secondary.includes(t))) {
      const driverLabel = rec.primary_driver.replace(/_/g, ' ');
      const neededLabels = needed.map(t => t.replace(/_/g, ' ')).join(' or ');
      errors.push(`Tagged as "${driverLabel}", but no evidence for it was given (expected ${neededLabels}) — treat this rec with extra scrutiny.`);
    }
  }

  // ── better_opportunity with valid alternativeTicker ────────────────────────
  if (rec.primary_driver === 'better_opportunity') {
    if (!/^[A-Z0-9]{2,5}(\.AX)?$/.test(rec.alternativeTicker)) {
      errors.push(`This rec says capital should rotate into "${rec.alternativeTicker}", but that doesn't look like a valid ASX ticker.`);
    }
  }

  // ── rationale must reference the primary_driver ────────────────────────────
  // The prompt's contract is "word or CONCEPT" — a literal substring check
  // cannot detect concepts ("reduce concentration" ⊆ risk_management), so a
  // miss is AUTO-REPAIRED by appending the driver token, never hard-failed.
  // (The old hard-fail silently destroyed 3 of 5 good recs in the
  // 2026-06-11 11:44 run: EVN/WBC/CBA all phrased the concept, not the token.)
  let repaired = null;
  if (rec.primary_driver && rec.reasoning) {
    const rat    = rec.reasoning.toLowerCase();
    const needle = rec.primary_driver.replace(/_/g, ' ');
    const needleRaw = rec.primary_driver;
    if (!rat.includes(needle) && !rat.includes(needleRaw)) {
      repaired = { ...rec,
        reasoning: `${rec.reasoning} [driver: ${rec.primary_driver}]`,
        _driverMentionAppended: true };
    }
  }

  return { ok: errors.length === 0, errors, repaired };
}

// Fields required for actionable recs (BUY/SELL/TRIM/TOP_UP).
// HOLD recs skip target/stop/qty/priceRange since they describe no trade.
const REC_SCHEMA = {
  ticker:     { type: 'string',  required: true,  pattern: /^[A-Z0-9]{2,5}(\.AX)?$/ },
  action:     { type: 'string',  required: true,  enum: ['BUY', 'SELL', 'TRIM', 'TOP_UP', 'HOLD'] },
  priceRange: { type: 'array',   requiredUnless: 'HOLD' },
  target:     { type: 'number',  requiredUnless: 'HOLD', min: 0 },
  stopLoss:   { type: 'number',  requiredUnless: 'HOLD', min: 0 },
  qty:        { type: 'number',  requiredUnless: 'HOLD', min: 1, integer: true },
  confidence: { type: 'number',  required: true,  min: 0, max: 1 },
  rrRatio:    { type: 'number',  required: false, min: 0 },
  scenarios:            { requiredUnless: 'HOLD' },  // required for BUY/SELL/TRIM/TOP_UP; p-sum validated below when present
  invalidationCondition:{ type: 'string', requiredUnless: 'HOLD' },
};

// _validateField — returns an error string or null.
// `action` is passed so `requiredUnless: 'HOLD'` style rules can opt out
// schema fields for non-trade actions.
function _validateField(value, schema, fieldName, action) {
  const isRequired = schema.required
    || (schema.requiredUnless && action !== schema.requiredUnless);
  if (isRequired && (value == null || value === '')) {
    return `${fieldName}: required but missing`;
  }
  if (value == null) return null;  // optional, absent — OK

  if (schema.type === 'string' && typeof value !== 'string') {
    return `${fieldName}: expected string, got ${typeof value}`;
  }
  if (schema.type === 'number' && typeof value !== 'number') {
    // Try coercion before rejecting
    if (!isNaN(Number(value))) return null;
    return `${fieldName}: expected number, got ${typeof value}`;
  }
  if (schema.type === 'array' && !Array.isArray(value)) {
    return `${fieldName}: expected array`;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `${fieldName}: "${value}" not in [${schema.enum.join(', ')}]`;
  }
  if (schema.pattern && !schema.pattern.test(value)) {
    return `${fieldName}: "${value}" fails pattern ${schema.pattern}`;
  }
  if (schema.min != null && value < schema.min) {
    return `${fieldName}: ${value} < min ${schema.min}`;
  }
  if (schema.max != null && value > schema.max) {
    return `${fieldName}: ${value} > max ${schema.max}`;
  }
  if (schema.integer && !Number.isInteger(value)) {
    return `${fieldName}: ${value} is not an integer`;
  }
  return null;
}

// Business rules — each returns { pass, fix?, message }
const _REC_BUSINESS_RULES = [
  // Target must exceed entry high for BUY / TOP_UP
  {
    id: 'profitable-entry',
    check: r => {
      if (r.action !== 'BUY' && r.action !== 'TOP_UP') return true;
      const hi = Array.isArray(r.priceRange) ? r.priceRange[1] : null;
      return hi == null || r.target > hi;
    },
    message: r => `target $${r.target} ≤ entry high $${Array.isArray(r.priceRange) ? r.priceRange[1] : '?'} — BUY/TOP_UP is unprofitable`,
  },
  // Stop placement must be direction-aware:
  // BUY/TOP_UP: stop below entry low; SELL/TRIM: stop above entry high
  {
    id: 'stop-below-entry',
    check: r => {
      if (r.action === 'HOLD') return true;
      const lo = Array.isArray(r.priceRange) ? r.priceRange[0] : null;
      const hi = Array.isArray(r.priceRange) ? r.priceRange[1] : null;
      if (r.action === 'SELL' || r.action === 'TRIM') {
        return hi == null || r.stopLoss == null || r.stopLoss > hi;
      }
      return lo == null || r.stopLoss == null || r.stopLoss < lo;
    },
    message: r => (r.action === 'SELL' || r.action === 'TRIM')
      ? `stopLoss $${r.stopLoss} ≤ entry high $${Array.isArray(r.priceRange) ? r.priceRange[1] : '?'} — SELL/TRIM stop must be above entry`
      : `stopLoss $${r.stopLoss} ≥ entry low $${Array.isArray(r.priceRange) ? r.priceRange[0] : '?'}`,
  },
  // priceRange must be a 2-element array with lo ≤ hi (not required for HOLD)
  {
    id: 'price-range-valid',
    check: r => r.action === 'HOLD' || (Array.isArray(r.priceRange) && r.priceRange.length === 2 && r.priceRange[0] <= r.priceRange[1]),
    message: r => `priceRange invalid: ${JSON.stringify(r.priceRange)}`,
    fix: r => Array.isArray(r.priceRange) && r.priceRange.length === 2
      ? { ...r, priceRange: [Math.min(...r.priceRange), Math.max(...r.priceRange)] }
      : null,
  },
  // qty must be a positive integer
  {
    id: 'qty-positive-int',
    check: r => r.action === 'HOLD' || (Number.isFinite(r.qty) && r.qty >= 1),
    message: r => `qty=${r.qty} is not a positive integer`,
    fix: r => r.action !== 'HOLD' && r.qty > 0
      ? { ...r, qty: Math.max(1, Math.round(Number(r.qty))) }
      : null,
  },
  // confidence must be in [0, 1]
  {
    id: 'confidence-range',
    check: r => typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1,
    message: r => `confidence=${r.confidence} outside [0,1]`,
    fix: r => ({ ...r, confidence: Math.max(0, Math.min(1, Number(r.confidence) || 0)) }),
  },
  // R:R must be ≥ 2.0 for BUY / TOP_UP
  {
    id: 'rr-ratio',
    check: r => {
      if (r.action !== 'BUY' && r.action !== 'TOP_UP') return true;
      if (r.rrRatio == null) return true;
      return r.rrRatio >= 2.0;
    },
    message: r => `rrRatio ${r.rrRatio} < 2.0 minimum for ${r.action}`,
  },
  // scenarios p-sum: when present, bull+base+bear probabilities must sum to ~1.0 (±0.01)
  {
    id: 'scenarios-p-sum',
    check: r => {
      if (!r.scenarios || typeof r.scenarios !== 'object') return true;
      const s = r.scenarios;
      if (!s.bull || !s.base || !s.bear) return true;
      const total = (s.bull.p || 0) + (s.base.p || 0) + (s.bear.p || 0);
      return Math.abs(total - 1.0) <= 0.01;
    },
    message: r => {
      const s = r.scenarios || {};
      const total = ((s.bull?.p || 0) + (s.base?.p || 0) + (s.bear?.p || 0)).toFixed(2);
      return `scenarios p-values sum to ${total} — must sum to 1.0 (±0.01)`;
    },
  },
  // Reject/defer contradiction: reasoning concludes "reject this rec" or "defer to a later
  // date" but the rec still carries an actionable (non-HOLD) action. Claude sometimes talks
  // itself out of a trade in the reasoning text yet still emits the rec object — AI Call #20
  // 2026-06-17 found this twice (GMG "REJECT", SHL "anti-churn block applies... deferring").
  // A contradiction here means the rec should never have been actionable in the first place.
  {
    id: 'reject-defer-contradiction',
    check: r => {
      if (r.action === 'HOLD' || !r.reasoning) return true;
      const text = r.reasoning.toLowerCase();
      const phraseHit = _REJECT_DEFER_PHRASES.some(p => text.includes(p));
      const tickerHit = _REJECT_TICKER_RE.test(r.reasoning);
      return !phraseHit && !tickerHit;
    },
    message: r => {
      const text = (r.reasoning || '').toLowerCase();
      const hit = _REJECT_DEFER_PHRASES.find(p => text.includes(p))
        || (_REJECT_TICKER_RE.exec(r.reasoning) || [])[0]
        || 'reject/defer language';
      return `reasoning says "${hit}" but action="${r.action}" — contradiction: ` +
        `either the rec should be omitted/deferred or the reasoning corrected`;
    },
  },
  // Anti-churn: SELL/TRIM within 7 days of a BUY/TOP_UP requires a catastrophe flag in factorsUsed[]
  {
    id: 'anti-churn-flip',
    check: r => {
      if (r.action !== 'SELL' && r.action !== 'TRIM') return true;
      const recHistory = (state.recHistory || []);
      const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000;
      const recentBuy = recHistory.find(h => {
        if (h.ticker !== r.ticker) return false;
        if (h.action !== 'BUY' && h.action !== 'TOP_UP') return false;
        // Fix #32: no timestamp = can't determine recency — skip (don't assume recent).
        // Also guard NaN from malformed date strings (new Date("bad").getTime() = NaN).
        if (!h.timestamp) return false;
        const ts = new Date(h.timestamp).getTime();
        return !Number.isNaN(ts) && ts > sevenDaysAgo;
      });
      if (!recentBuy) return true;  // no recent buy — flip is fine
      // There WAS a recent buy — require catastrophe keyword in factorsUsed[]
      const factors = (r.factorsUsed || []).join(' ').toLowerCase();
      const hasCatastrophe = ['earnings miss', 'debt default', 'regulatory ban',
        'enforcement action', 'accounting fraud', 'covenant breach'].some(kw => factors.includes(kw));
      return hasCatastrophe;
    },
    message: r => `anti-churn: SELL/TRIM on ${r.ticker} within 7 days of BUY/TOP_UP — no catastrophe keyword found in factorsUsed[]. Omit this rec or add explicit catastrophe evidence.`,
  },
];

// AI-Call-#20 (2026-06-17, WES TRIM netProfit=-12.77 vs real unrealisedPnl=-$2.77):
// per CLAUDE.md Rule 4, Claude is told NOT to compute these — qty stays 0 and the
// quant engine (computeTradeParams() for BUY/TOP_UP; analysis.js's deterministic
// SELL/TRIM sizing) is the sole source of truth for sizing-derived P&L fields.
// Strip any AI-supplied values here so a raw, unrecomputed rec can never leak
// fabricated numbers to the UI/learning log if this validator is used outside the
// analysis.js pipeline (which currently overwrites these fields itself downstream).
const _AI_UNTRUSTED_NUMERIC_FIELDS = ['netProfit', 'expectedProfit', 'riskAUD', 'rewardAUD'];

function _stripUntrustedAiFields(rec) {
  let out = rec;
  let stripped = false;
  for (const f of _AI_UNTRUSTED_NUMERIC_FIELDS) {
    if (out[f] != null) {
      if (!stripped) { out = { ...out }; stripped = true; }
      delete out[f];
    }
  }
  if (stripped) out._aiNumericFieldsStripped = true;
  return out;
}

// validateRec — returns { valid, errors[], fixed }
// fixed is the auto-repaired rec if all fixable errors were repaired; null otherwise.
// `ctx.holding` (optional) — { weightPct, sectorWeightPct, unrealisedPnl, daysHeld } —
// enables the SELL/TRIM ground-truth secondary-tag checks in validateSellTags().
// Callers without portfolio context (tests, ad-hoc checks) simply omit it.
function validateRec(rec, ctx) {
  const errors = [];
  let fixed = { ..._stripUntrustedAiFields(rec) };
  let allFixed = true;

  // Schema checks
  const action = (rec.action || '').toUpperCase();
  for (const [field, schema] of Object.entries(REC_SCHEMA)) {
    const err = _validateField(rec[field], schema, field, action);
    if (err) errors.push(err);
  }

  // Business rule checks
  for (const rule of _REC_BUSINESS_RULES) {
    if (!rule.check(fixed)) {
      errors.push(rule.message(fixed));
      if (rule.fix) {
        const repaired = rule.fix(fixed);
        if (repaired) {
          fixed = repaired;
        } else {
          allFixed = false;
        }
      } else {
        allFixed = false;
      }
    }
  }

  // SELL/TRIM structured tagging — primary_driver, secondary_factors, urgency.
  // validateSellTags() handles Fix #40 auto-repair (better_opportunity → risk_management)
  // and returns { ok, errors, repaired } — apply repaired if set.
  if (action === 'SELL' || action === 'TRIM') {
    const { ok: sellOk, errors: sellErrors, repaired: sellRepaired } = validateSellTags(fixed, ctx);
    if (sellRepaired) fixed = sellRepaired;
    if (!sellOk) {
      errors.push(...sellErrors);
      allFixed = false;   // tag errors require model regeneration, not client-side fix
    }
  }

  return {
    valid:  errors.length === 0,
    errors,
    fixed:  allFixed ? fixed : null,
  };
}

// validateResponse — validates a full parsed AI response
// Returns { recs (valid+fixed), summary, dataGaps, rejected, errors }
function validateResponse(parsed, minConfidence) {
  const minConf = minConfidence ?? (state.analysisConfig?.rules?.minConfidence ?? 0.62);
  const rawRecs = Array.isArray(parsed) ? parsed : (parsed?.recs || []);
  const validated = [];
  const rejected  = [];

  for (const rec of rawRecs) {
    const { valid, errors, fixed } = validateRec(rec);

    if (!valid && !fixed) {
      rejected.push({ rec, errors });
      continue;
    }

    const r = fixed || rec;

    // Ensemble confidence: blend AI confidence with indicator composite score
    // liveSignals[ticker].score is 0-100 from _score_ticker; normalise to 0-1
    const sig = state.liveSignals?.[r.ticker] ?? state.liveSignals?.[r.ticker + '.AX'];
    // Fix #33: ?? null guards undefined but NOT NaN (sig.score can be NaN from a partial
    // analyse_ticker() response). NaN / 100 = NaN propagates into ensembleConfidence and
    // makes the confidence gate always pass (NaN < minConf is always false).
    const indScore = sig?.score;
    const hasValidScore = indScore != null && !Number.isNaN(indScore);
    r.ensembleConfidence = hasValidScore
      ? Math.round((0.5 * r.confidence + 0.5 * (indScore / 100)) * 100) / 100
      : r.confidence;

    // Use ensembleConfidence for the minConfidence threshold gate
    if ((r.ensembleConfidence ?? 0) < minConf && r.action !== 'HOLD') {
      rejected.push({ rec: r, errors: [`ensembleConfidence ${r.ensembleConfidence?.toFixed(2)} < minConf ${minConf}`] });
      continue;
    }

    validated.push(r);
  }

  // Note: the book-level "portfolio synthesis" is now computed deterministically in
  // analysis.js (concentration/cash + changes-since-last-review), not emitted by the model —
  // so there is no synthesis field to validate here.
  return {
    recs:     validated,
    summary:  parsed?.summary  ?? null,
    dataGaps: parsed?.dataGaps ?? [],
    rejected,
    errors:   rejected.flatMap(r => r.errors),
  };
}

// getValidatedAnalysis — parse + validate raw Claude text (no retry)
function getValidatedAnalysis(rawText, minConfidence) {
  const { ok, data, error } = parseClaudeJSON(rawText);
  if (!ok) throw new Error('JSON parse failed: ' + error);
  return validateResponse(data, minConfidence);
}

// _buildRepairMessage — appends validation errors to the original user message
// so a second Claude call can fix them.
function _buildRepairMessage(originalUserMessage, errors) {
  const lines = errors.map((e, i) => {
    if (typeof e === 'string') return `  - ${e}`;
    return `  - rec[${e.index ?? i}] (${e.ticker ?? '?'}): ${Array.isArray(e.errors) ? e.errors.join('; ') : e}`;
  });

  return `${originalUserMessage}

=== PREVIOUS RESPONSE HAD VALIDATION ERRORS — REGENERATE ===
${lines.join('\n')}

Regenerate the full JSON response with these errors corrected.
If a rec cannot be fixed without violating hard rules, omit it from recs[] and
add it to dataGaps[] with a brief reason. Maintain the same JSON schema.`;
}

// getValidatedAnalysisWithRepair — calls Claude, validates, retries on failure
// agentType: 'portfolio' | 'dayTrade' | ...
// Returns { recs, summary, dataGaps, partial } or throws after maxAttempts
async function getValidatedAnalysisWithRepair(userMessage, agentType = 'portfolio', options = {}, maxAttempts = 2) {
  const minConf = options.minConfidence ?? (state.analysisConfig?.rules?.minConfidence ?? 0.62);
  let currentMessage = userMessage;
  let lastErrors = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const msg = lastErrors ? _buildRepairMessage(currentMessage, lastErrors) : currentMessage;
    const { text } = await callClaude(agentType, msg, options);

    const { ok: parseOk, data, error: parseErr } = parseClaudeJSON(text);
    if (!parseOk) {
      lastErrors = [{ type: 'parse', message: 'Output was not valid JSON: ' + parseErr }];
      console.warn(`[validator] attempt ${attempt}: JSON parse failed`);
      continue;
    }

    const result = validateResponse(data, minConf);

    if (!result.errors.length) return { ...result, partial: false };

    // Partial success — keep valid recs on final attempt
    if (result.recs.length > 0 && attempt === maxAttempts) {
      console.warn(`[validator] partial: ${result.recs.length} valid, ${result.rejected.length} rejected`);
      return { ...result, partial: true };
    }

    lastErrors = result.errors;
    console.warn(`[validator] attempt ${attempt}: ${result.errors.length} validation errors — retrying`);
  }

  throw new Error(`Validation failed after ${maxAttempts} attempts: ${(lastErrors || []).join('; ')}`);
}
