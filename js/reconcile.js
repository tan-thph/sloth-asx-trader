// ============================================================
// RECONCILE JOURNAL → PARCELS
// Runs on load and can be triggered manually.
// Creates missing parcels for BUY entries that have no parcelId,
// and links the journal entry back to the parcel.
// ============================================================
function reconcileJournalParcels() {
  let created = 0;
  // Walk journal oldest-first so parcels are created in chronological order
  const buys = state.tradeJournal
    .filter(t => t.action === 'BUY' && !t.parcelId)
    .sort((a, b) => (a.date||'').localeCompare(b.date||''));

  for (const t of buys) {
    // Check if a parcel already exists that matches this trade closely
    const existing = state.cgtParcels.find(p =>
      p.ticker === t.ticker &&
      p.date === t.date &&
      p.qty === t.qty &&
      Math.abs(p.costPerShare - t.entryPrice) < 0.005
    );
    if (existing) {
      t.parcelId = existing.id;
    } else {
      // Create the missing parcel
      addParcel(t.ticker, t.date || todayStr(), t.qty, t.entryPrice, t.fees || 0, t.sector || 'Other');
      const newParcel = state.cgtParcels[state.cgtParcels.length - 1];
      t.parcelId = newParcel.id;
      created++;
    }
  }
  return created;
}
