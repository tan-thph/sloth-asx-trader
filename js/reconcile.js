// ============================================================
// RECONCILE JOURNAL → PARCELS
// Runs on load and can be triggered manually.
// Creates missing parcels for BUY entries that have no parcelId,
// and links the journal entry back to the parcel.
// ============================================================
function reconcileJournalParcels() {
  let created = 0;
  // Walk journal oldest-first so parcels are created in chronological order
  const _rISO = d => { const p = (d||'').split('-'); return p.length===3 ? `${p[2]}-${p[1]}-${p[0]}` : (d||''); };
  const buys = state.tradeJournal
    .filter(t => (t.action === 'BUY' || t.action === 'TOP_UP') && !t.parcelId)
    .sort((a, b) => _rISO(a.date||'').localeCompare(_rISO(b.date||'')));

  for (const t of buys) {
    const tAcct = t.account || 'personal';
    const tMode = t.mode || 'paper';   // paper/real firewall (gotcha #88)
    // Check if a parcel already exists that matches this trade closely.
    // Account AND mode are part of the match — without account, two accounts
    // buying the same ticker on the same day at the same cost could silently
    // link a journal row to a parcel that actually belongs to a DIFFERENT
    // account; without mode, a real journal row could link to (or recreate)
    // a paper parcel, breaking mode-scoped sell matching for that lot.
    const existing = state.cgtParcels.find(p =>
      p.ticker === t.ticker &&
      p.date === t.date &&
      p.qty === t.qty &&
      Math.abs(p.costPerShare - t.entryPrice) < 0.005 &&
      (p.account || 'personal') === tAcct &&
      (p.mode || 'paper') === tMode
    );
    if (existing) {
      t.parcelId = existing.id;
    } else {
      // Create the missing parcel — account and mode MUST match the journal
      // row's, or they silently default to 'personal'/'paper' regardless of
      // what the row says.
      addParcel(t.ticker, t.date || todayStr(), t.qty, t.entryPrice, t.fees || 0, t.sector || 'Other', tAcct, tMode);
      const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
      t.parcelId = newParcel.id;
      created++;
    }
  }
  return created;
}
