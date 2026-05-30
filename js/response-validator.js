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

// Forbidden combinations — logical contradictions that indicate confused reasoning.
const SELL_FORBIDDEN_COMBOS = [
  ['target_reached', 'stop_triggered'],   // can't hit both simultaneously
  ['time_stop',      'target_reached'],   // time stop implies target NOT hit
];

// Certain primary drivers require at least one specific secondary tag to be grounded.
const SELL_REQUIRED_SECONDARY = {
  tax_optimisation: ['unrealised_loss_large', 'held_over_12m', 'held_11_to_12m'],
  risk_management:  ['sector_concentration', 'position_oversized'],
};

/**
 * validateSellTags — validates the three SELL/TRIM tagging dimensions.
 * Called from validateRec() for every SELL or TRIM rec.
 * Returns { ok, errors[] } — errors feed into the auto-repair prompt.
 */
function validateSellTags(rec) {
  const errors = [];
  const action = (rec.action || '').toUpperCase();
  if (action !== 'SELL' && action !== 'TRIM') return { ok: true, errors };

  // ── primary_driver: required, must be in closed vocabulary ─────────────────
  if (!rec.primary_driver) {
    errors.push('SELL/TRIM requires primary_driver — choose one of: ' + [...SELL_PRIMARY_DRIVERS].join(', '));
  } else if (!SELL_PRIMARY_DRIVERS.has(rec.primary_driver)) {
    errors.push(`primary_driver "${rec.primary_driver}" is not in the allowed list. Valid: ${[...SELL_PRIMARY_DRIVERS].join(', ')}`);
  }

  // ── secondary_factors: optional array, max 3, all from closed vocabulary ───
  const secondary = Array.isArray(rec.secondary_factors) ? rec.secondary_factors : [];
  if (secondary.length > 3) {
    errors.push(`secondary_factors has ${secondary.length} entries — maximum is 3. Remove the least specific tags.`);
  }
  for (const tag of secondary) {
    if (!SELL_SECONDARY_FACTORS.has(tag)) {
      errors.push(`secondary_factors "${tag}" not in allowed list. Valid: ${[...SELL_SECONDARY_FACTORS].join(', ')}`);
    }
  }

  // ── urgency: required, must be in closed vocabulary ────────────────────────
  if (!rec.urgency) {
    errors.push('SELL/TRIM requires urgency — one of: immediate, routine, monitor');
  } else if (!SELL_URGENCY.has(rec.urgency)) {
    errors.push(`urgency "${rec.urgency}" must be one of: immediate, routine, monitor`);
  }

  // ── forbidden combinations ─────────────────────────────────────────────────
  const allTags = new Set([rec.primary_driver, ...secondary]);
  for (const [a, b] of SELL_FORBIDDEN_COMBOS) {
    if (allTags.has(a) && allTags.has(b)) {
      errors.push(`forbidden combination: "${a}" and "${b}" cannot both apply — choose the causally upstream one`);
    }
  }

  // ── required secondary for certain primaries ───────────────────────────────
  if (rec.primary_driver && SELL_REQUIRED_SECONDARY[rec.primary_driver]) {
    const needed = SELL_REQUIRED_SECONDARY[rec.primary_driver];
    if (!needed.some(t => secondary.includes(t))) {
      errors.push(`primary_driver "${rec.primary_driver}" requires at least one of: ${needed.join(', ')} in secondary_factors`);
    }
  }

  // ── better_opportunity requires an alternativeTicker ──────────────────────
  if (rec.primary_driver === 'better_opportunity') {
    if (!rec.alternativeTicker) {
      errors.push('primary_driver "better_opportunity" requires alternativeTicker — specify the ticker to redeploy capital into');
    } else if (!/^[A-Z0-9]{2,5}(\.AX)?$/.test(rec.alternativeTicker)) {
      errors.push(`alternativeTicker "${rec.alternativeTicker}" is not a valid ASX ticker (2-5 uppercase alphanumeric, optional .AX)`);
    }
  }

  // ── rationale must reference the primary_driver ────────────────────────────
  if (rec.primary_driver && rec.reasoning) {
    const rat    = rec.reasoning.toLowerCase();
    const needle = rec.primary_driver.replace(/_/g, ' ');
    const needleRaw = rec.primary_driver;
    if (!rat.includes(needle) && !rat.includes(needleRaw)) {
      errors.push(`reasoning must explicitly mention the primary_driver ("${rec.primary_driver}") — currently it does not`);
    }
  }

  return { ok: errors.length === 0, errors };
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
  scenarios:  { type: 'array',   required: false },
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
        const ts = h.timestamp ? new Date(h.timestamp).getTime() : 0;
        return ts > sevenDaysAgo;
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

// validateRec — returns { valid, errors[], fixed }
// fixed is the auto-repaired rec if all fixable errors were repaired; null otherwise.
function validateRec(rec) {
  const errors = [];
  let fixed = { ...rec };
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

  // SELL/TRIM structured tagging — required dimensions (primary_driver, secondary_factors, urgency)
  if (action === 'SELL' || action === 'TRIM') {
    const { ok: sellOk, errors: sellErrors } = validateSellTags(fixed);
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
    const indScore = sig?.score ?? null;
    r.ensembleConfidence = indScore != null
      ? Math.round((0.5 * r.confidence + 0.5 * (indScore / 100)) * 100) / 100
      : r.confidence;

    // Use ensembleConfidence for the minConfidence threshold gate
    if ((r.ensembleConfidence ?? 0) < minConf && r.action !== 'HOLD') {
      rejected.push({ rec: r, errors: [`ensembleConfidence ${r.ensembleConfidence?.toFixed(2)} < minConf ${minConf}`] });
      continue;
    }

    validated.push(r);
  }

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
