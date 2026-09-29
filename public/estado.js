const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const money = n => new Intl.NumberFormat('es-AR', { style:'currency', currency:'ARS' }).format((n || 0) / 100);
const day = v => new Date(`${v.slice(0, 10)}T12:00:00`).toLocaleDateString('es-AR', { dateStyle: 'medium' });
const root = $('#statement');
const token = location.hash.slice(1);
try {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new Error('Este enlace no es válido. Pedí uno nuevo.');
  const res = await fetch(`/api/public/statement/${token}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'No se pudo cargar el estado de cuenta.');
  document.documentElement.style.setProperty('--accent', data.school.color || '#315ded');
  document.title = `Estado de cuenta · ${data.client.name}`;
  const differs = data.mode === 'current' && data.due !== data.original_due;
  root.innerHTML = `<div class="eyebrow">${esc(data.business.name)} · ${esc(data.school.name)}</div><h1>Estado de cuenta</h1><p class="muted">${esc(data.client.name)} · al ${day(data.as_of)}</p>
    <div class="stats" style="grid-template-columns:1fr 1fr"><div class="stat blue"><span>Saldo a pagar</span><strong>${money(data.due)}</strong><small>${differs ? 'Calculado con los precios de hoy' : 'Según los precios de cada consumo'}</small></div><div class="stat mint"><span>Saldo a favor</span><strong>${money(data.credit)}</strong><small>Se descuenta en el próximo pago</small></div></div>
    <div class="card"><div class="card-head"><h2>Consumos pendientes</h2><span class="badge">${data.lines.length}</span></div>${data.lines.length ? `<div class="scroll"><table><thead><tr><th>Detalle</th><th class="number">Pendiente</th></tr></thead><tbody>${data.lines.map(l => `<tr><td><strong>${esc(l.description)}</strong><br><small>${day(l.occurred_on)} · ${l.quantity} × ${money(l.unit_price)}${l.partial ? ' · pago parcial' : ''}</small></td><td class="number">${money(data.mode === 'current' ? l.current_value : l.remaining)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty"><h3>Sin consumos pendientes</h3><p>Está todo al día. ¡Gracias!</p></div>'}</div>
    ${data.payments.length ? `<div class="card"><div class="card-head"><h2>Últimos pagos</h2></div><div class="scroll"><table><tbody>${data.payments.map(p => `<tr><td>${day(p.date)}</td><td class="number">${money(p.amount)}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    <p class="muted">Enlace de solo lectura, válido hasta el ${day(new Date(data.expires_at).toISOString())}. ${esc(data.business.footer || '')}</p>`;
} catch (error) {
  root.innerHTML = `<div class="empty"><h3>No pudimos mostrar el estado de cuenta</h3><p>${esc(error.message)}</p></div>`;
}
