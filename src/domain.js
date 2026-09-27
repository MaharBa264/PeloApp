export function assert(ok, message, status = 400) {
  if (!ok) throw Object.assign(new Error(message), { status });
}
export function cents(value) {
  const s = String(value ?? '').trim().replace(',', '.');
  assert(/^\d{1,8}(\.\d{1,2})?$/.test(s), 'Ingresá un importe válido, con hasta dos decimales.');
  const [whole, fraction = ''] = s.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
export function valueOf(line, mode = 'original') {
  if (!line.product_id || mode === 'original') return line.remaining;
  assert(Number.isSafeInteger(line.current_price) && line.current_price > 0, 'Falta el precio vigente de un producto.');
  // Integer rational arithmetic avoids floating point rounding on repriced balances.
  return Number((BigInt(line.remaining) * BigInt(line.current_price) + BigInt(Math.floor(line.unit_price / 2))) / BigInt(line.unit_price));
}
export function settlement(lines, amount, credit, mode) {
  assert(['original','current'].includes(mode), 'Criterio de cobro inválido.');
  assert(Number.isSafeInteger(amount) && amount >= 0 && Number.isSafeInteger(credit) && credit >= 0, 'Importe inválido.');
  let funds = amount + credit;
  const allocations = [];
  for (const line of lines) {
    if (!funds || !line.remaining) continue;
    const due = valueOf(line, mode);
    assert(due > 0, 'El saldo es menor a un centavo al precio vigente. Usá el precio original.');
    const applied = Math.min(funds, due);
    const base = applied === due ? line.remaining : Number((BigInt(applied) * BigInt(line.remaining) + BigInt(Math.floor(due / 2))) / BigInt(due));
    assert(base > 0 && (applied === due || base < line.remaining), 'Ese pago parcial es demasiado pequeño para este ajuste. Cambiá el importe o cancelá el ítem.');
    allocations.push({ id: line.id, description: line.description, applied, base, adjustment: applied - base, remaining: line.remaining - base, unit_price: line.unit_price, current_price: line.current_price });
    funds -= applied;
  }
  return { allocations, credit: funds, received: amount, previous_credit: credit, mode, applied: amount + credit - funds };
}
