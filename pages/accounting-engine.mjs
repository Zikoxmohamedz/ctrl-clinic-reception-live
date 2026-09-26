// Inventory counts are end-of-business-day observations, not entry timestamps.
export function cairoDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
const clean = n => Math.round(n * 1e8) / 1e8;
export function calculateAccounts(source, materials, from, to) {
  const sessions = new Map(source.sessions.map(s => [s.id, s]));
  const counts = new Map();
  for (const entry of source.entries) {
    const session = sessions.get(entry.session_id);
    if (session?.status !== 'completed') continue;
    const key = `${entry.session_id}|${entry.material_id}`;
    if (!counts.has(key)) counts.set(key, { material_id: entry.material_id, date: session.inventory_date, quantity: 0, type: 'count', id: session.id, order: session.completed_at || session.created_at });
    counts.get(key).quantity += Number(entry.quantity);
  }
  const events = new Map(materials.map(m => [m.id, []]));
  const add = event => { if (!events.has(event.material_id)) events.set(event.material_id, []); events.get(event.material_id).push(event); };
  source.openings.forEach(o => add({ ...o, date: cairoDate(o.opened_at), type: 'opening', order: o.opened_at }));
  source.additions.forEach(a => add({ ...a, type: 'addition', order: a.created_at }));
  source.consumption.forEach(c => add({ ...c, type: c.record_type === 'transfer' ? 'transfer' : 'consumption', order: c.created_at }));
  counts.forEach(add);
  const rank = { addition: 0, consumption: 0, transfer: 0, opening: 1, count: 2 };
  const materialMap = new Map(materials.map(m => [m.id, m]));
  const rows = [], ledger = [], variances = [];
  for (const [materialId, history] of events) {
    history.sort((a,b) => a.date.localeCompare(b.date) || rank[a.type]-rank[b.type] || String(a.order).localeCompare(String(b.order)) || String(a.id).localeCompare(String(b.id)));
    const material = materialMap.get(materialId) || { id: materialId, name: materialId };
    let balance = null, opening = null, added = 0, consumed = 0, transferred = 0, adjustment = 0, shortage = 0, surplus = 0, actual = null, actualDate = '', baselineDate = '', unknownVariance = false, initialised = false;
    for (const event of history) {
      if (event.date > to) break;
      const inPeriod = event.date >= from;
      if (inPeriod && !initialised) { opening = balance; initialised = true; }
      const before = balance;
      const quantity = Number(event.quantity);
      let delta = 0, variance = null;
      if (event.type === 'opening') {
        // A migration seed must never overwrite an existing physical count.
        if (actualDate) continue;
        balance = quantity; baselineDate = event.date;
        delta = before === null ? null : clean(balance-before);
      } else if (event.type === 'count') {
        variance = before === null ? null : clean(quantity-before);
        delta = variance;
        balance = quantity; actual = quantity; actualDate = event.date; baselineDate = event.date;
        if (inPeriod) {
          if (variance === null) unknownVariance = true;
          else { adjustment = clean(adjustment+variance); shortage = clean(shortage+Math.max(0,-variance)); surplus = clean(surplus+Math.max(0,variance)); }
          variances.push({ material, date: event.date, expected: before, actual: quantity, variance, session_id: event.id });
        }
      } else {
        delta = event.type === 'addition' ? quantity : -quantity;
        if (balance !== null) balance = clean(balance+delta);
        if (inPeriod) {
          if (event.type === 'addition') added += quantity;
          else if (event.type === 'transfer') transferred += quantity;
          else consumed += quantity;
        }
      }
      if (inPeriod) ledger.push({ ...event, material, before, delta, balance, variance });
    }
    if (!initialised) opening = balance;
    rows.push({ material, opening, added: clean(added), consumed: clean(consumed), transferred: clean(transferred), adjustment: unknownVariance ? null : adjustment, shortage: unknownVariance ? null : shortage, surplus: unknownVariance ? null : surplus, balance, actual, actualDate, baselineDate,
      expected: opening === null ? null : clean(opening+added-consumed-transferred),
      status: balance === null ? 'لا يوجد رصيد تأسيسي موثّق' : actualDate === to ? 'جرد فعلي بنهاية الفترة' : actualDate ? 'رصيد دفتري بعد آخر جرد' : 'رصيد دفتري من الافتتاحي' });
  }
  ledger.sort((a,b) => a.date.localeCompare(b.date) || rank[a.type]-rank[b.type] || String(a.order).localeCompare(String(b.order)));
  return { rows, ledger, variances };
}
