// Inventory counts are end-of-business-day observations, not entry timestamps.
export function cairoDate(value) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
const clean = n => Math.round(n * 1e8) / 1e8;
export function calculateAccounts(source, materials, from, to) {
  const strict = Object.hasOwn(source, 'baseline');
  const anchor = source.baseline?.date;
  const sessions = new Map(source.sessions.map(s => [s.id, s]));
  const counts = new Map();
  for (const entry of source.entries) {
    const session = sessions.get(entry.session_id);
    if (session?.status !== 'completed') continue;
    if (strict && (!anchor || session.inventory_date < anchor)) continue;
    const key = `${entry.session_id}|${entry.material_id}`;
    if (!counts.has(key)) counts.set(key, { material_id: entry.material_id, date: session.inventory_date, quantity: 0, type: 'count', id: session.id, order: session.completed_at || session.created_at });
    counts.get(key).quantity += Number(entry.quantity);
  }
  const events = new Map(materials.map(m => [m.id, []]));
  const add = event => { if (!events.has(event.material_id)) events.set(event.material_id, []); events.get(event.material_id).push(event); };
  if (!strict) source.openings.forEach(o => add({ ...o, date: cairoDate(o.opened_at), type: 'opening', order: o.opened_at }));
  (source.receipt_foundations || []).forEach(f => add({ ...f, quantity: 0, type: 'receipt_opening', order: '' }));
  source.additions.forEach(a => add({ ...a, type: 'addition', order: a.created_at }));
  source.consumption.forEach(c => add({ ...c, type: c.record_type === 'transfer' ? 'transfer' : 'consumption', order: c.created_at }));
  counts.forEach(add);
  if (source.missing_count_policy === 'shortage') {
    for (const session of source.sessions.filter(s => s.status === 'completed' && s.inventory_date >= anchor && source.entries.some(e => e.session_id === s.id))) {
      for (const material of materials) if (!counts.has(`${session.id}|${material.id}`)) add({material_id:material.id,date:session.inventory_date,quantity:0,type:'count',id:session.id,order:session.completed_at||session.created_at,assumedMissing:true});
    }
  }
  const rank = { receipt_opening: -1, addition: 0, consumption: 0, transfer: 0, opening: 1, count: 2 };
  const materialMap = new Map(materials.map(m => [m.id, m]));
  const rows = [], ledger = [], variances = [];
  for (const [materialId, history] of events) {
    history.sort((a,b) => a.date.localeCompare(b.date) || rank[a.type]-rank[b.type] || String(a.order).localeCompare(String(b.order)) || String(a.id).localeCompare(String(b.id)));
    const material = materialMap.get(materialId) || { id: materialId, name: materialId };
    let balance = null, opening = null, added = 0, consumed = 0, transferred = 0, adjustment = 0, shortage = 0, surplus = 0, actual = null, actualDate = '', baselineDate = '', unknownVariance = false, initialised = false;
    let foundingDate = '', foundingQuantity = null, excludedMovements = 0, actualAssumedMissing = false;
    for (const event of history) {
      if (event.date > to) break;
      if (event.assumedMissing && !(balance > 0)) continue;
      const inPeriod = event.date >= from;
      if (inPeriod && !initialised) { opening = balance; initialised = true; }
      const before = balance;
      const establishes = strict && ['count','receipt_opening'].includes(event.type) && before === null;
      const quantity = Number(event.quantity);
      let delta = 0, variance = null;
      if (event.type === 'receipt_opening') {
        if (balance !== null) continue;
        balance = 0; foundingDate = event.date; foundingQuantity = 0; baselineDate = event.date;
        if (inPeriod) opening = 0;
      } else if (event.type === 'opening') {
        // A migration seed must never overwrite an existing physical count.
        if (actualDate) continue;
        balance = quantity; baselineDate = event.date;
        delta = before === null ? null : clean(balance-before);
      } else if (event.type === 'count') {
        if (!foundingDate) { foundingDate = event.date; foundingQuantity = quantity; }
        if (establishes && inPeriod) opening = quantity;
        variance = before === null ? null : clean(quantity-before);
        delta = variance;
        balance = quantity; actual = quantity; actualDate = event.date; baselineDate = event.date;
        actualAssumedMissing = !!event.assumedMissing;
        if (inPeriod && !establishes) {
          if (variance === null) unknownVariance = true;
          else { adjustment = clean(adjustment+variance); shortage = clean(shortage+Math.max(0,-variance)); surplus = clean(surplus+Math.max(0,variance)); }
          variances.push({ material, date: event.date, expected: before, actual: quantity, variance, session_id: event.id, assumedMissing: !!event.assumedMissing });
        }
      } else {
        delta = event.type === 'addition' ? quantity : -quantity;
        if (balance !== null) balance = clean(balance+delta);
        if (inPeriod && (!strict || before !== null)) {
          if (event.type === 'addition') added += quantity;
          else if (event.type === 'transfer') transferred += quantity;
          else consumed += quantity;
        }
        if (inPeriod && strict && before === null) excludedMovements++;
      }
      if (inPeriod) ledger.push({ ...event, type: establishes ? 'opening' : event.type, material, before, delta, balance, variance, excluded: strict && before === null && !establishes });
    }
    if (!initialised) opening = balance;
    rows.push({ material, opening, added: clean(added), consumed: clean(consumed), transferred: clean(transferred), adjustment: unknownVariance ? null : adjustment, shortage: unknownVariance ? null : shortage, surplus: unknownVariance ? null : surplus, balance, actual, actualDate, actualAssumedMissing, baselineDate, foundingDate, foundingQuantity, excludedMovements,
      expected: opening === null ? null : clean(opening+added-consumed-transferred),
      status: balance === null ? 'لا يوجد رصيد تأسيسي موثّق' : actualAssumedMissing ? 'رصيد بعد إثبات عجز لعدم إدراج الصنف' : actualDate === to ? 'جرد فعلي بنهاية الفترة' : actualDate ? 'رصيد دفتري بعد آخر جرد' : 'رصيد دفتري من الافتتاحي' });
  }
  ledger.sort((a,b) => a.date.localeCompare(b.date) || rank[a.type]-rank[b.type] || String(a.order).localeCompare(String(b.order)));
  return { rows, ledger, variances };
}
