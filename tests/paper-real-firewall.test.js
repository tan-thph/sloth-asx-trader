/**
 * paper-real-firewall.test.js — locks in the money-critical behaviors of the
 * Paper/Real trade firewall (CLAUDE.md gotcha #88, Stage 2 + Phase D).
 *
 * These all live in js/utils.js, which tests/setup.js already loads as globals.
 * The ONE invariant under test: a record is REAL only when mode==='real';
 * everything else (explicit 'paper', missing, null) is paper and is kept out of
 * real cash / real NAV. Cash routes to the right pool; the display view mode
 * filters holdings/cash without touching the real-only NAV basis.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadScript } from './setup.js';

// portfolio-helpers.js holds the parcel/split/rollback layer under test below.
// Pure function declarations (no DOM at load time), so it loads cleanly into
// the same global context utils.js already lives in.
loadScript('js/portfolio-helpers.js');
// Browser-global stubs used by the helpers' side-effect paths.
global.scheduleSave = () => {};
global.toast = () => {};

function resetState() {
  global.state.portfolio = [];
  global.state.cash = 1000;
  global.state.paperCash = 0;
  global.state._paperCashSeeded = false;
  global.state.portfolioViewMode = 'all';
  global.state.activeAccount = 'all';
  global.state.settings = { paperStartCash: 100000, brokerage: 10 };
  global.state.cgtParcels = [];
  global.state.cgtDisposals = [];
  global.state.tradeJournal = [];
  global.state.cgtMethod = 'fifo';
  global.state.intraday = { openPositions: [], recommendations: [] };
  global.state.dayTrading = { ...global.state.dayTrading, recommendations: [] };
}

describe('isRealTrade invariant', () => {
  it('is real ONLY for mode==="real"', () => {
    expect(isRealTrade('real')).toBe(true);
    expect(isRealTrade({ mode: 'real' })).toBe(true);
    // everything else fails safe → paper
    expect(isRealTrade('paper')).toBe(false);
    expect(isRealTrade({ mode: 'paper' })).toBe(false);
    expect(isRealTrade({})).toBe(false);        // missing
    expect(isRealTrade({ mode: null })).toBe(false);
    expect(isRealTrade(null)).toBe(false);
    expect(isRealTrade(undefined)).toBe(false);
    expect(isRealTrade('REAL')).toBe(false);     // case-sensitive on purpose
  });
});

describe('adjustCashForMode routing + paper-cash seeding', () => {
  beforeEach(resetState);

  it('real trades move real cash, never paperCash', () => {
    adjustCashForMode(-250, 'real');
    expect(state.cash).toBe(750);
    expect(state.paperCash).toBe(0);         // untouched, not seeded by a real trade
    expect(state._paperCashSeeded).toBe(false);
  });

  it('first paper trade seeds paperCash from paperStartCash, then applies delta', () => {
    adjustCashForMode(-5000, 'paper');       // buy $5000 of paper
    expect(state._paperCashSeeded).toBe(true);
    expect(state.paperCash).toBe(95000);     // 100000 seed − 5000
    expect(state.cash).toBe(1000);           // real cash untouched
  });

  it('missing/paper mode both route to the paper pool (fail-safe)', () => {
    adjustCashForMode(-1000, undefined);
    expect(state.paperCash).toBe(99000);
    expect(state.cash).toBe(1000);
  });

  it('does not re-seed after a genuine spend-down to zero', () => {
    ensurePaperCashSeeded();                 // seed → 100000
    state.paperCash = 0;                      // user spent it all
    ensurePaperCashSeeded();                  // must NOT re-seed (flag already set)
    expect(state.paperCash).toBe(0);
  });
});

describe('view-mode display filtering', () => {
  beforeEach(() => {
    resetState();
    state.portfolio = [
      { ticker: 'BHP', shares: 10, avgPrice: 40, currentPrice: 50, account: 'personal', mode: 'real' },
      { ticker: 'CBA', shares: 5,  avgPrice: 100, currentPrice: 120, account: 'personal', mode: 'paper' },
      { ticker: 'WOW', shares: 20, avgPrice: 30, currentPrice: 30, account: 'personal' }, // legacy, no mode ⇒ paper
    ];
    state.paperCash = 200;
  });

  it("'all' shows every holding but only REAL cash (paper cash is a fiction)", () => {
    state.portfolioViewMode = 'all';
    expect(portfolioValue()).toBe(10*50 + 5*120 + 20*30); // 500+600+600 = 1700
    expect(viewCash()).toBe(1000);                 // real cash only — paperCash never summed
    expect(totalNetWorth()).toBe(1700 + 1000);
  });

  it("'real' shows only real holdings and real cash", () => {
    state.portfolioViewMode = 'real';
    expect(portfolioValue()).toBe(10*50);    // BHP only
    expect(viewCash()).toBe(1000);
    expect(totalNetWorth()).toBe(500 + 1000);
  });

  it("'paper' shows paper + legacy-mode-less holdings and NO cash", () => {
    state.portfolioViewMode = 'paper';
    expect(portfolioValue()).toBe(5*120 + 20*30); // CBA + WOW(legacy)
    expect(viewCash()).toBe(0);                    // paper has no funds/available-cash concept
    expect(totalNetWorth()).toBe(5*120 + 20*30);   // holdings value only, no phantom cash
  });
});

describe('real-only NAV basis ignores the view toggle', () => {
  beforeEach(() => {
    resetState();
    state.portfolio = [
      { ticker: 'BHP', shares: 10, avgPrice: 40, currentPrice: 50, mode: 'real' },
      { ticker: 'CBA', shares: 5,  avgPrice: 100, currentPrice: 120, mode: 'paper' },
    ];
    state.paperCash = 99999;
  });

  it('realPortfolioValue / realNetWorth stay real-only in EVERY view mode', () => {
    for (const vm of ['all', 'real', 'paper']) {
      state.portfolioViewMode = vm;
      expect(realPortfolioValue()).toBe(500);       // BHP only, always
      expect(realNetWorth()).toBe(500 + 1000);      // + real cash only, never paperCash
    }
  });

  it('paperPortfolioValue is paper holdings only (no cash), in EVERY view mode', () => {
    for (const vm of ['all', 'real', 'paper']) {
      state.portfolioViewMode = vm;
      expect(paperPortfolioValue()).toBe(600);      // CBA only (5×120), never real BHP, never paperCash
    }
  });
});

describe('mergedPortfolio keys real and paper lots separately', () => {
  beforeEach(() => {
    resetState();
    state.portfolio = [
      { ticker: 'BHP', shares: 10, avgPrice: 40, currentPrice: 50, account: 'personal', mode: 'real' },
      { ticker: 'BHP', shares: 3,  avgPrice: 45, currentPrice: 50, account: 'personal', mode: 'paper' },
    ];
    state.portfolioViewMode = 'all';
  });

  it('same ticker+account but different mode → two rows, each tagged', () => {
    const rows = mergedPortfolio().filter(r => r.ticker === 'BHP');
    expect(rows).toHaveLength(2);
    const modes = rows.map(r => r.mode).sort();
    expect(modes).toEqual(['paper', 'real']);
  });

  it("'real' view collapses to just the real BHP lot", () => {
    state.portfolioViewMode = 'real';
    const rows = mergedPortfolio().filter(r => r.ticker === 'BHP');
    expect(rows).toHaveLength(1);
    expect(rows[0].mode).toBe('real');
    expect(rows[0].shares).toBe(10);
  });
});

// ── Audit fixes (2026-07-02): mode integrity in the parcel/rollback layer ─────

describe('splitParcel inherits the parent mode', () => {
  beforeEach(resetState);

  it('splitting a REAL parcel produces a REAL sibling (never paper)', () => {
    addParcel('BHP', '01-06-2026', 10, 40, 10, 'Mining', 'personal', 'real');
    const parent = state.cgtParcels[0];
    expect(splitParcel(parent.id, 4)).toBe(true);
    const sibling = state.cgtParcels[state.cgtParcels.length - 1];
    expect(sibling.mode).toBe('real');
    expect(isRealTrade(sibling)).toBe(true);
    // the split-off lot's new journal row must carry the mode too
    const newRow = state.tradeJournal.find(j => j.parcelId === sibling.id);
    expect(newRow.mode).toBe('real');
  });

  it('splitting a legacy (mode-less) parcel stays paper', () => {
    addParcel('CBA', '01-06-2026', 10, 100, 10, 'Banking', 'personal');  // no mode
    const parent = state.cgtParcels[0];
    delete parent.mode;   // simulate a true pre-feature parcel
    expect(splitParcel(parent.id, 3)).toBe(true);
    const sibling = state.cgtParcels[state.cgtParcels.length - 1];
    expect(isRealTrade(sibling)).toBe(false);
  });
});

describe('mode-scoped sell matching (paper sell never consumes real parcels)', () => {
  beforeEach(resetState);

  it('a paper sell fails when only a real holding exists', () => {
    applyBuyToPortfolio('BHP', 10, 40, '01-06-2026', 10, 'Mining', 'personal', 'real');
    const res = applySellToPortfolio('BHP', 5, 50, 10, '02-07-2026', 'fifo', 'personal', 'paper');
    expect(res.ok).toBe(false);
    // real holding untouched
    expect(getPortfolioHolding('BHP', 'personal', 'real').shares).toBe(10);
  });

  it('a real sell consumes only the real parcel and credits real cash', () => {
    applyBuyToPortfolio('BHP', 10, 40, '01-06-2026', 0, 'Mining', 'personal', 'real');
    applyBuyToPortfolio('BHP', 10, 40, '01-06-2026', 0, 'Mining', 'personal', 'paper');
    const cashBefore = state.cash, paperBefore = state.paperCash;
    const res = applySellToPortfolio('BHP', 10, 50, 0, '02-07-2026', 'fifo', 'personal', 'real');
    expect(res.ok).toBe(true);
    expect(state.cash).toBe(cashBefore + 500);
    expect(state.paperCash).toBe(paperBefore);           // untouched
    // paper parcel untouched, real parcel consumed
    const paperParcel = state.cgtParcels.find(p => (p.mode||'paper') === 'paper');
    const realParcel  = state.cgtParcels.find(p => p.mode === 'real');
    expect(paperParcel.remainingQty).toBe(10);
    expect(realParcel.remainingQty).toBe(0);
    // disposal carries the mode for the CGT firewall
    expect(res.disposals.every(d => d.mode === 'real')).toBe(true);
  });
});

describe('_recomputeHoldingFromParcels keeps real and paper rows separate', () => {
  beforeEach(resetState);

  it('rebuilds one row per mode, never a blended real+paper row', () => {
    addParcel('WES', '01-06-2026', 10, 60, 0, 'Retail', 'personal', 'real');
    addParcel('WES', '01-06-2026', 4, 65, 0, 'Retail', 'personal', 'paper');
    _recomputeHoldingFromParcels('WES', 'personal');
    const rows = state.portfolio.filter(h => h.ticker === 'WES');
    expect(rows).toHaveLength(2);
    const real  = rows.find(h => h.mode === 'real');
    const paper = rows.find(h => h.mode === 'paper');
    expect(real.shares).toBe(10);
    expect(real.avgPrice).toBe(60);
    expect(paper.shares).toBe(4);
    expect(paper.avgPrice).toBe(65);
  });
});

describe('rollbackTradeJournalEntry routes cash by the row mode', () => {
  beforeEach(resetState);

  it('rolling back a PAPER buy refunds paperCash, never real cash', () => {
    applyBuyToPortfolio('NAB', 10, 30, '01-07-2026', 10, 'Banking', 'personal', 'paper');
    const parcel = state.cgtParcels[0];
    const row = { action: 'BUY', status: 'open', ticker: 'NAB', qty: 10,
                  entryPrice: 30, fees: 10, account: 'personal', mode: 'paper', parcelId: parcel.id };
    const cashBefore = state.cash;
    ensurePaperCashSeeded();
    const paperBefore = state.paperCash;
    expect(rollbackTradeJournalEntry(row)).toBe(true);
    expect(state.cash).toBe(cashBefore);                       // real cash untouched
    expect(state.paperCash).toBe(paperBefore + 10 * 30 + 10);  // refund landed in paper pool
  });

  it('rolling back a REAL closed sell debits real cash only', () => {
    // a real holding exists post-sale reversal target
    const row = { action: 'SELL', status: 'closed', ticker: 'ANZ', qty: 5,
                  entryPrice: 20, exitPrice: 25, fees: 0, account: 'personal', mode: 'real' };
    const cashBefore = state.cash, paperBefore = state.paperCash;
    expect(rollbackTradeJournalEntry(row)).toBe(true);
    expect(state.cash).toBe(cashBefore - 5 * 25);   // sale proceeds clawed back from real cash
    expect(state.paperCash).toBe(paperBefore);
    // restored holding carries the mode
    const h = state.portfolio.find(x => x.ticker === 'ANZ');
    expect(h.mode).toBe('real');
  });
});

// api.js is all top-level function declarations (fetch/DOM refs are inside
// functions), so it loads cleanly into the same global context.
loadScript('js/api.js');

describe('_validHolding preserves mode across the load sanitiser (FIXES #1)', () => {
  it('keeps mode==="real" and fails everything else safe to paper', () => {
    expect(_validHolding({ ticker: 'cba', shares: 10, avgPrice: 90, currentPrice: 130,
                           account: 'personal', mode: 'real' }).mode).toBe('real');
    // missing / null / explicit paper / bogus → paper (isRealTrade invariant)
    expect(_validHolding({ ticker: 'BHP', shares: 1, avgPrice: 40, currentPrice: 45 }).mode).toBe('paper');
    expect(_validHolding({ ticker: 'BHP', mode: null }).mode).toBe('paper');
    expect(_validHolding({ ticker: 'BHP', mode: 'paper' }).mode).toBe('paper');
    expect(_validHolding({ ticker: 'BHP', mode: 'REAL' }).mode).toBe('paper'); // case-sensitive
  });
});

describe('critical-alert engine is multi-book aware (FIXES #7)', () => {
  beforeEach(resetState);

  it('_holdingsForTicker returns every account/mode row, skipping zero-share rows', () => {
    state.portfolio = [
      { ticker: 'WDS', shares: 0,  avgPrice: 30, currentPrice: 25, account: 'personal', mode: 'real' },
      { ticker: 'WDS', shares: 10, avgPrice: 30, currentPrice: 25, account: 'trading',  mode: 'real' },
      { ticker: 'WDS', shares: 5,  avgPrice: 28, currentPrice: 25, account: 'trading',  mode: 'paper' },
      { ticker: 'BHP', shares: 3,  avgPrice: 40, currentPrice: 45, account: 'personal', mode: 'real' },
    ];
    const rows = _holdingsForTicker('WDS');
    expect(rows.length).toBe(2);            // zero-share personal row excluded
    expect(rows.every(h => h.ticker === 'WDS')).toBe(true);
  });

  it('fires the alert even when only a NON-first portfolio row holds shares', () => {
    // Old bug: getPortfolioHolding(ticker) returned the first match (0 shares)
    // → `continue` → the crash on the actually-held book went un-alerted.
    state.portfolio = [
      { ticker: 'ZIP', shares: 0,   avgPrice: 2, currentPrice: 1.6, account: 'personal', mode: 'real' },
      { ticker: 'ZIP', shares: 100, avgPrice: 2, currentPrice: 1.6, account: 'trading',  mode: 'paper' },
    ];
    state.criticalAlerts = {};
    state.liveSignals = { ZIP: { chart_data: [{ close: 2.0 }, { close: 1.6 }] } }; // −20% day
    const alerts = computeCriticalAlerts();
    expect(alerts.ZIP).toBeDefined();
    expect(alerts.ZIP.type).toBe('single_day');
  });

  it('does not alert on tickers with no held book at all', () => {
    state.portfolio = [];
    state.criticalAlerts = {};
    state.liveSignals = { ZIP: { chart_data: [{ close: 2.0 }, { close: 1.6 }] } };
    expect(computeCriticalAlerts().ZIP).toBeUndefined();
  });
});

describe('resetPaperBook wipes only the paper sandbox (IMPROVEMENTS #7)', () => {
  beforeEach(() => {
    resetState();
    global.state.recHistory = [];
    global.state.portfolioHistory = [];
    global.state.intraday = { openPositions: [] };
    global.state.dayTrading = { recommendations: [] };
    global.state.settings = { paperStartCash: 50000 };
    global.state.paperCash = 12345;
    global.state._paperCashSeeded = true;
  });

  it('removes explicit-paper rows, preserves real AND untagged rows', () => {
    state.portfolio = [
      { ticker: 'CBA', shares: 10, mode: 'real' },
      { ticker: 'BHP', shares: 5,  mode: 'paper' },
      { ticker: 'WOW', shares: 3 },                 // untagged → ambiguous → keep
    ];
    state.cgtParcels = [
      { id: 1, ticker: 'CBA', mode: 'real' },
      { id: 2, ticker: 'BHP', mode: 'paper' },
    ];
    state.tradeJournal = [
      { id: 1, ticker: 'CBA', mode: 'real' },
      { id: 2, ticker: 'BHP', mode: 'paper' },
      { id: 3, ticker: 'WOW' },                     // untagged → keep
    ];
    state.cgtDisposals = [{ id: 1, mode: 'paper' }, { id: 2, mode: 'real' }];
    state.recHistory   = [{ id: 1, mode: 'paper' }, { id: 2, mode: 'real' }, { id: 3 }];

    const s = resetPaperBook();

    expect(s).toMatchObject({ portfolio: 1, parcels: 1, journal: 1, disposals: 1, recHistory: 1 });
    // Real + untagged survive; explicit paper gone.
    expect(state.portfolio.map(h => h.ticker).sort()).toEqual(['CBA', 'WOW']);
    expect(state.tradeJournal.map(j => j.id).sort()).toEqual([1, 3]);
    expect(state.cgtParcels.map(p => p.id)).toEqual([1]);
    expect(state.cgtDisposals.map(d => d.id)).toEqual([2]);
    expect(state.recHistory.map(r => r.id).sort()).toEqual([2, 3]);
    // The money-critical invariant: nothing real was deleted.
    expect(state.portfolio.every(h => h.mode !== 'paper')).toBe(true);
  });

  it('drops day-trade/intraday positions linked to a removed paper parcel', () => {
    state.cgtParcels = [{ id: 7, ticker: 'ZIP', mode: 'paper' },
                        { id: 8, ticker: 'CBA', mode: 'real' }];
    state.intraday.openPositions = [
      { id: 'a', ticker: 'ZIP', parcelId: 7 },      // linked to removed paper parcel
      { id: 'b', ticker: 'CBA', parcelId: 8 },      // real parcel → keep
    ];
    state.dayTrading.recommendations = [
      { id: 'r1', ticker: 'XYZ', mode: 'paper' },   // explicit paper → drop
      { id: 'r2', ticker: 'CBA', mode: 'real' },
    ];
    const s = resetPaperBook();
    expect(s.positions).toBe(2);
    expect(state.intraday.openPositions.map(p => p.id)).toEqual(['b']);
    expect(state.dayTrading.recommendations.map(r => r.id)).toEqual(['r2']);
  });

  it('resets paperCash to paperStartCash and clears only paperValue on snapshots', () => {
    state.portfolioHistory = [
      { date: '2026-07-01', netWorth: 5000, portfolioValue: 4000, cash: 1000, paperValue: 800 },
    ];
    resetPaperBook();
    expect(state.paperCash).toBe(50000);
    expect(state._paperCashSeeded).toBe(true);
    const snap = state.portfolioHistory[0];
    expect('paperValue' in snap).toBe(false);        // paper curve cleared
    expect(snap.netWorth).toBe(5000);                 // real NAV untouched
    expect(snap.cash).toBe(1000);
  });

  it('touches no real cash', () => {
    state.cash = 9999;
    resetPaperBook();
    expect(state.cash).toBe(9999);
  });
});

describe('realistic paper fills — paperFillPrice (IMPROVEMENTS #10)', () => {
  it('BUY/TOP_UP fills UP, SELL/TRIM fills DOWN (adverse)', () => {
    // adv >= 10M → 0.05% one-way, no regime bump.
    expect(paperFillPrice(100, 'BUY', 20e6, 'riskOn')).toBeCloseTo(100.05, 4);
    expect(paperFillPrice(100, 'TOP_UP', 20e6, 'riskOn')).toBeCloseTo(100.05, 4);
    expect(paperFillPrice(100, 'SELL', 20e6, 'riskOn')).toBeCloseTo(99.95, 4);
    expect(paperFillPrice(100, 'TRIM', 20e6, 'riskOn')).toBeCloseTo(99.95, 4);
  });

  it('rate scales down with liquidity (ADV tiers)', () => {
    const buy = (adv) => paperFillPrice(100, 'BUY', adv, 'riskOn') - 100;
    expect(buy(20e6)).toBeCloseTo(0.05, 4);   // 0.05%
    expect(buy(5e6)).toBeCloseTo(0.10, 4);    // 0.10%
    expect(buy(1e6)).toBeCloseTo(0.20, 4);    // 0.20%
    expect(buy(100e3)).toBeCloseTo(0.35, 4);  // 0.35% thin
    expect(buy(null)).toBeCloseTo(0.35, 4);   // unknown → conservative thin tier
  });

  it('regime multiplier widens slippage in volatile/panic markets', () => {
    // thin tier 0.35% × panic 2.0 = 0.70%
    expect(paperFillPrice(100, 'BUY', 100e3, 'panic')).toBeCloseTo(100.70, 4);
    // 0.35% × highVol 1.5 = 0.525%
    expect(paperFillPrice(100, 'BUY', 100e3, 'highVol')).toBeCloseTo(100.525, 4);
    // 0.05% × riskOff 1.25 = 0.0625%
    expect(paperFillPrice(100, 'SELL', 20e6, 'riskOff')).toBeCloseTo(100 * (1 - 0.000625), 4);
  });

  it('returns the price unchanged on invalid inputs', () => {
    expect(paperFillPrice(0, 'BUY', 20e6, 'riskOn')).toBe(0);
    expect(paperFillPrice(-5, 'BUY', 20e6, 'riskOn')).toBe(-5);
    expect(paperFillPrice(NaN, 'BUY', 20e6, 'riskOn')).toBeNaN();
  });

  it('mirrors the backend tiers exactly (0.05/0.10/0.20/0.35 + 1.5/1.25/2.0)', () => {
    expect(_advSlippageRate(10e6)).toBe(0.0005);
    expect(_advSlippageRate(2e6)).toBe(0.0010);
    expect(_advSlippageRate(500e3)).toBe(0.0020);
    expect(_advSlippageRate(499e3)).toBe(0.0035);
    expect(_SLIP_REGIME_MULT.highVol).toBe(1.5);
    expect(_SLIP_REGIME_MULT.riskOff).toBe(1.25);
    expect(_SLIP_REGIME_MULT.panic).toBe(2.0);
  });
});
