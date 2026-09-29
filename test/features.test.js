import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { setup } from './helpers.js';

const isoDay = offset => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Argentina/San_Luis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400000));

test('own password change and admin-issued recovery links', async () => {
  const { call, login, DB, set, adminCookie } = await setup();
  await call('/users', 'POST', { name: 'Op', email: 'op@test.com', password: 'long-password-test', role: 'operator', school_ids: ['school-1'] });
  await call('/users', 'POST', { name: 'Adm', email: 'adm@test.com', password: 'long-password-test', role: 'admin', school_ids: ['school-1'] });
  const users = (await call('/users')).data, op = users.find(u => u.email === 'op@test.com'), root = users.find(u => u.email === 'admin@test.com');
  const opCookie = await login('op@test.com'), opOther = await login('op@test.com');
  assert.equal((await call('/password', 'POST', { current: 'wrong-password-123', password: 'another-long-password' }, { cookie: opCookie })).status, 403);
  assert.equal((await call('/password', 'POST', { current: 'long-password-test', password: 'short' }, { cookie: opCookie })).status, 400);
  assert.equal((await call('/password', 'POST', { current: 'long-password-test', password: 'long-password-test' }, { cookie: opCookie })).status, 400);
  assert.equal((await call('/password', 'POST', { current: 'long-password-test', password: 'brand-new-password-1' }, { cookie: opCookie })).status, 200);
  assert.equal((await call('/data', 'GET', null, { cookie: opCookie })).status, 200, 'current session survives');
  assert.equal((await call('/data', 'GET', null, { cookie: opOther })).status, 401, 'other sessions are closed');
  assert.equal(await login('op@test.com'), undefined);
  assert.ok(await login('op@test.com', 'brand-new-password-1'));

  // recovery link
  const admCookie = await login('adm@test.com');
  assert.equal((await call(`/users/${root.id}/reset-link`, 'POST', {}, { cookie: admCookie })).status, 403, 'admin cannot reset a superadmin');
  assert.equal((await call(`/users/${op.id}/reset-link`, 'POST', {}, { cookie: opCookie })).status, 403, 'operator cannot issue links');
  const first = await call(`/users/${op.id}/reset-link`, 'POST', {}, { cookie: admCookie }); assert.equal(first.status, 201);
  const second = await call(`/users/${op.id}/reset-link`, 'POST', {}, { cookie: admCookie });
  assert.equal((await call('/reset', 'POST', { token: first.data.token, password: 'recovered-password-1' }, { cookie: '' })).status, 400, 'a new link replaces the old one');
  assert.equal((await call('/reset', 'POST', { token: second.data.token, password: 'short' }, { cookie: '' })).status, 400);
  assert.equal((await call('/reset', 'POST', { token: second.data.token, password: 'recovered-password-1' }, { cookie: '' })).status, 200);
  assert.equal((await call('/reset', 'POST', { token: second.data.token, password: 'recovered-password-2' }, { cookie: '' })).status, 400, 'single use');
  assert.equal((await call('/data', 'GET', null, { cookie: opCookie })).status, 401, 'reset closes sessions');
  assert.ok(await login('op@test.com', 'recovered-password-1'));
  const expired = await call(`/users/${op.id}/reset-link`, 'POST', {}, { cookie: adminCookie });
  DB.db.exec('UPDATE password_resets SET expires_at=1');
  assert.equal((await call('/reset', 'POST', { token: expired.data.token, password: 'recovered-password-3' }, { cookie: '' })).status, 400, 'expired');
  const rootLink = await call(`/users/${root.id}/reset-link`, 'POST', {}, { cookie: adminCookie });
  assert.equal(rootLink.status, 201, 'superadmin can recover a superadmin');
  set(adminCookie);
  assert.ok((await call('/audit')).data.rows.some(r => r.action === 'user.reset_link'));
});

test('debtors report: aging, filters, CSV and scope', async () => {
  const { call, login, raw, key } = await setup();
  await call('/users', 'POST', { name: 'Op', email: 'op@test.com', password: 'long-password-test', role: 'operator', school_ids: ['school-1'] });
  const mk = async (name, school) => (await call('/clients', 'POST', { name, kind: 'Familia', school_id: school, mode: 'original', contact: name === '=Malo' ? '=HYPERLINK("x")' : '' })).data.id;
  const charge = (client, price, daysAgo) => call(`/clients/${client}/charge`, 'POST', { description: 'Cafe', quantity: 1, unit_price: price, occurred_on: isoDay(-daysAgo) }, key());
  const a = await mk('Ana', 'school-1'), b = await mk('Beto', 'school-1'), c = await mk('Cami', 'school-2'), bad = await mk('=Malo', 'school-1');
  await mk('Sin deuda', 'school-1');
  await charge(a, '100', 5); await charge(a, '200', 40); await charge(a, '300', 75); await charge(a, '400', 120);
  await charge(b, '5000', 10); await charge(c, '50', 200); await charge(bad, '10', 1);
  let r = await call('/reports/debtors'); assert.equal(r.status, 200);
  assert.deepEqual(r.data.rows.map(x => x.name), ['Beto', 'Ana', 'Cami', '=Malo']);
  const ana = r.data.rows.find(x => x.name === 'Ana');
  assert.equal(ana.due, 100000); assert.equal(ana.oldest_days, 120);
  assert.deepEqual(ana.buckets, { d0_30: 10000, d31_60: 20000, d61_90: 30000, d90: 40000 });
  assert.equal(r.data.totals.clients, 4); assert.equal(r.data.totals.buckets.d90, 40000 + 5000);
  assert.equal((await call('/reports/debtors?school=school-2')).data.rows.length, 1);
  assert.deepEqual((await call('/reports/debtors?min=100')).data.rows.map(x => x.name), ['Beto', 'Ana']);
  assert.equal((await call('/reports/debtors?school=nope')).status, 400);
  const csvResponse = await raw('/api/reports/debtors?format=csv'), csvBytes = new Uint8Array(await csvResponse.arrayBuffer());
  assert.deepEqual([...csvBytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM so Excel reads accents');
  const csv = new TextDecoder().decode(csvBytes);
  assert.ok(csv.startsWith('Cliente;Tipo;Colegio'));
  assert.match(csv, /Beto;Familia;Colegio 1;;5000,00;5000,00;0,00;;No;10;/);
  assert.match(csv, /'=Malo/, 'formula injection is neutralised');
  assert.match(csv, /'=HYPERLINK/);
  const opCookie = await login('op@test.com');
  const scoped = await call('/reports/debtors', 'GET', null, { cookie: opCookie });
  assert.equal(scoped.data.rows.some(x => x.name === 'Cami'), false, 'operator only sees own school');
  assert.equal((await call('/reports/debtors?school=school-2', 'GET', null, { cookie: opCookie })).status, 403);
});

test('debt limit warns and needs confirmation', async () => {
  const { call, key } = await setup();
  const client = (await call('/clients', 'POST', { name: 'Familia', kind: 'Familia', school_id: 'school-1', mode: 'original' })).data.id;
  const detail = async () => (await call(`/clients/${client}`)).data;
  const edit = async limit => call(`/clients/${client}`, 'PUT', { name: 'Familia', kind: 'Familia', contact: '', notes: '', mode: 'original', debt_limit: limit, version: (await detail()).client.version }, key());
  assert.equal((await edit('-5')).status, 400);
  assert.equal((await edit('0')).status, 400);
  assert.equal((await edit('1000')).status, 200);
  assert.equal((await detail()).client.debt_limit, 100000);
  const charge = (price, extra = {}) => call(`/clients/${client}/charge`, 'POST', { description: 'Almuerzo', quantity: 1, unit_price: price, occurred_on: isoDay(0), ...extra }, key());
  assert.equal((await charge('600')).status, 200, 'under the limit');
  let r = await charge('500'); assert.equal(r.status, 409); assert.equal(r.data.code, 'over_limit'); assert.match(r.data.error, /supera el límite/);
  assert.equal((await detail()).lines.length, 1, 'nothing was saved');
  assert.equal((await charge('500', { confirm_over_limit: true })).status, 200);
  const ev = (await detail()).events.find(e => e.kind === 'charge' && e.data.over_limit); assert.ok(ev);
  const amendTarget = (await detail()).events.find(e => e.id === ev.id);
  r = await call(`/clients/${client}/amend`, 'POST', { event_id: amendTarget.id, reason: 'sube', description: 'Almuerzo', quantity: 1, unit_price: '900', occurred_on: isoDay(0) }, key());
  assert.equal(r.status, 409); assert.equal(r.data.code, 'over_limit');
  assert.equal((await edit('')).status, 200); assert.equal((await detail()).client.debt_limit, null);
  assert.equal((await charge('9000')).status, 200, 'no limit, no alert');
});

test('payments can target chosen items and leave the rest untouched', async () => {
  const { call, key } = await setup();
  const client = (await call('/clients', 'POST', { name: 'Familia', kind: 'Familia', school_id: 'school-1', mode: 'original' })).data.id;
  for (const [desc, price, ago] of [['Viejo', '100', 30], ['Medio', '200', 20], ['Nuevo', '300', 10]]) await call(`/clients/${client}/charge`, 'POST', { description: desc, quantity: 1, unit_price: price, occurred_on: isoDay(-ago) }, key());
  const lines = async () => (await call(`/clients/${client}`)).data.lines;
  const [viejo, medio, nuevo] = await lines();
  const pay = async (amount, extra) => { const body = { amount, method: 'Efectivo', note: '', ...extra }, q = await call(`/clients/${client}/quote`, 'POST', body); assert.equal(q.status, 200, JSON.stringify(q.data)); return call(`/clients/${client}/payment`, 'POST', { ...body, fingerprint: q.data.fingerprint }, key()); };
  assert.equal((await call(`/clients/${client}/quote`, 'POST', { amount: '100', method: 'Efectivo', item_ids: ['nope'] })).status, 409);
  assert.equal((await call(`/clients/${client}/quote`, 'POST', { amount: '100', method: 'Efectivo', item_ids: 'x' })).status, 400);
  assert.equal((await pay('300', { item_ids: [nuevo.id] })).status, 200);
  assert.deepEqual((await lines()).map(l => l.description), ['Viejo', 'Medio'], 'only the chosen item was paid');
  const q = await call(`/clients/${client}/quote`, 'POST', { amount: '500', method: 'Efectivo', item_ids: [medio.id] });
  assert.equal(q.data.allocations.length, 1); assert.equal(q.data.credit, 30000, 'surplus becomes credit');
  assert.equal((await pay('50', { item_ids: [] })).status, 200);
  const d = (await call(`/clients/${client}`)).data;
  assert.equal(d.client.credit, 5000, 'empty selection is a pure advance');
  assert.equal(d.lines.length, 2);
  const last = d.events.find(e => e.kind === 'payment' && e.data.manual);
  assert.equal((await call(`/clients/${client}/void`, 'POST', { event_id: last.id, reason: 'prueba' }, key())).status, 200);
  assert.equal((await call(`/clients/${client}`)).data.client.credit, 0);
  assert.ok(viejo);
});

test('read-only statement links', async () => {
  const { call, raw, DB, key } = await setup();
  const client = (await call('/clients', 'POST', { name: 'Familia Ruiz', kind: 'Familia', school_id: 'school-1', mode: 'original', contact: '2664-111111' })).data.id;
  await call(`/clients/${client}/charge`, 'POST', { description: 'Cafe', quantity: 2, unit_price: '150', occurred_on: isoDay(-3) }, key());
  assert.equal((await call(`/clients/${client}/statement-link`, 'POST', { days: 0 })).status, 400);
  const link = await call(`/clients/${client}/statement-link`, 'POST', { days: 7 }); assert.equal(link.status, 201);
  const view = async token => raw(`/api/public/statement/${token}`, 'GET', null, { cookie: '' });
  let r = await view(link.data.token); assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.client.name, 'Familia Ruiz'); assert.equal(data.due, 30000); assert.equal(data.lines[0].description, 'Cafe');
  assert.equal(JSON.stringify(data).includes('2664-111111'), false, 'no contact data is exposed');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal((await view('x'.repeat(43))).status, 404);
  assert.equal((await raw('/api/public/statement/short', 'GET', null, { cookie: '' })).status, 401, 'malformed tokens fall through to auth');
  assert.equal((await call(`/clients/${client}/statement-link`, 'DELETE')).status, 200);
  assert.equal((await view(link.data.token)).status, 404, 'revoked');
  const again = await call(`/clients/${client}/statement-link`, 'POST', {});
  DB.db.exec('UPDATE statement_links SET expires_at=1'); assert.equal((await view(again.data.token)).status, 404, 'expired');
});

test('Mercado Pago: signed webhook reconciles payments idempotently', async () => {
  const secret = 'webhook-secret', calls = [], payments = new Map(), realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    if (String(url).endsWith('/checkout/preferences')) return Response.json({ id: 'pref-1', init_point: 'https://mp.test/checkout/pref-1' });
    const m = String(url).match(/\/v1\/payments\/(\w+)$/); if (m && payments.has(m[1])) return Response.json(payments.get(m[1]));
    return new Response('{}', { status: 404 });
  };
  try {
    const off = await setup();
    const client = (await off.call('/clients', 'POST', { name: 'Familia', kind: 'Familia', school_id: 'school-1', mode: 'original' })).data.id;
    assert.equal((await off.call('/data')).data.features.mercadopago, false);
    assert.equal((await off.call(`/clients/${client}/payment-request`, 'POST', { amount: '100' })).status, 503);
    assert.equal((await off.raw('/api/webhooks/mercadopago?data.id=1&type=payment', 'POST', {}, { noOrigin: true })).status, 503);

    const { call, raw, key, DB } = await setup({ MP_ACCESS_TOKEN: 'APP_USR-test', MP_WEBHOOK_SECRET: secret, MP_API_BASE: 'https://mp.test' });
    assert.equal((await call('/data')).data.features.mercadopago, true);
    const cid = (await call('/clients', 'POST', { name: 'Familia', kind: 'Familia', school_id: 'school-1', mode: 'original' })).data.id;
    for (const [d, p, ago] of [['Viejo', '400', 9], ['Nuevo', '900', 2]]) await call(`/clients/${cid}/charge`, 'POST', { description: d, quantity: 1, unit_price: p, occurred_on: isoDay(-ago) }, key());
    assert.equal((await call(`/clients/${cid}/payment-request`, 'POST', { amount: '0' })).status, 400);
    const created = await call(`/clients/${cid}/payment-request`, 'POST', { amount: '1200', note: 'cuota' }); assert.equal(created.status, 201);
    assert.equal(created.data.checkout_url, 'https://mp.test/checkout/pref-1');
    assert.equal((await call(`/clients/${cid}`)).data.payment_requests.length, 1);
    const requestId = created.data.id;
    const send = (dataId, { sign = true, ts = String(Date.now()), reqId = 'req-1', type = 'payment' } = {}) => {
      const signature = createHmac('sha256', secret).update(`id:${dataId.toLowerCase()};request-id:${reqId};ts:${ts};`).digest('hex');
      return raw(`/api/webhooks/mercadopago?data.id=${dataId}&type=${type}`, 'POST', { type, data: { id: dataId } }, { noOrigin: true, cookie: '', headers: { 'x-request-id': reqId, 'x-signature': sign ? `ts=${ts},v1=${signature}` : 'ts=1,v1=deadbeef' } });
    };
    payments.set('555', { id: 555, status: 'approved', external_reference: requestId, transaction_amount: 1200, currency_id: 'ARS' });
    assert.equal((await send('555', { sign: false })).status, 401, 'bad signature');
    assert.equal((await send('555', { type: 'merchant_order' })).status, 200);
    assert.equal((await call(`/clients/${cid}`)).data.lines.length, 2, 'ignored events change nothing');
    assert.equal((await send('555')).status, 200);
    let d = (await call(`/clients/${cid}`)).data;
    assert.equal(d.lines.length, 1); assert.equal(d.lines[0].remaining, 10000, '1200 pays 400 + 800 of 900');
    assert.equal(d.client.credit, 0); assert.equal(d.payment_requests.length, 0);
    const paid = d.events.find(e => e.kind === 'payment'); assert.equal(paid.data.method, 'Mercado Pago'); assert.equal(paid.actor_name, 'Mercado Pago (automático)');
    assert.equal(DB.db.prepare('SELECT status FROM payment_requests WHERE id=?').get(requestId).status, 'paid');
    assert.equal((await send('555', { reqId: 'req-2' })).status, 200, 'webhook replays are harmless');
    assert.equal((await call(`/clients/${cid}`)).data.events.filter(e => e.kind === 'payment').length, 1);
    assert.equal((await call(`/clients/${cid}/void`, 'POST', { event_id: paid.id, reason: 'Devolución en Mercado Pago' }, key())).status, 200, 'automatic payments can be voided');
    assert.equal((await call(`/clients/${cid}`)).data.lines.reduce((s, l) => s + l.remaining, 0), 130000);

    // amount mismatch goes to manual review; unapproved payments are ignored
    const second = (await call(`/clients/${cid}/payment-request`, 'POST', { amount: '500' })).data.id;
    payments.set('556', { id: 556, status: 'approved', external_reference: second, transaction_amount: 499, currency_id: 'ARS' });
    payments.set('557', { id: 557, status: 'pending', external_reference: second, transaction_amount: 500, currency_id: 'ARS' });
    assert.equal((await send('557')).status, 200);
    assert.equal(DB.db.prepare('SELECT status FROM payment_requests WHERE id=?').get(second).status, 'pending');
    assert.equal((await send('556')).status, 200);
    assert.equal(DB.db.prepare('SELECT status FROM payment_requests WHERE id=?').get(second).status, 'review');
    assert.equal((await call(`/clients/${cid}`)).data.lines.reduce((s, l) => s + l.remaining, 0), 130000, 'nothing applied on mismatch');
    assert.equal((await call(`/payment-requests/${second}/cancel`, 'POST', {})).status, 200);
    assert.equal((await call(`/payment-requests/${second}/cancel`, 'POST', {})).status, 409);
    assert.ok((await call('/audit')).data.rows.some(r => r.action === 'payment_request.review'));
    assert.ok(calls.some(u => u.endsWith('/checkout/preferences')));
  } finally { globalThis.fetch = realFetch; }
});

test('reset-password script restores a locked-out superadmin', async () => {
  const { execFileSync } = await import('node:child_process');
  const { call, login, DB } = await setup();
  const sql = execFileSync('node', ['scripts/reset-password.mjs', 'admin@test.com'], { env: { ...process.env, NEW_PASSWORD: 'recovered-by-cli-1' }, encoding: 'utf8' });
  assert.equal(await login('admin@test.com', 'recovered-by-cli-1'), undefined, 'nothing changes until the SQL is applied');
  DB.db.exec(sql);
  assert.ok(await login('admin@test.com', 'recovered-by-cli-1'));
  assert.equal(await login('admin@test.com'), undefined, 'old password no longer works');
  assert.throws(() => execFileSync('node', ['scripts/reset-password.mjs', "x'; DROP TABLE users;--@a.com"], { env: { ...process.env, NEW_PASSWORD: 'recovered-by-cli-1' }, stdio: 'pipe' }));
  assert.throws(() => execFileSync('node', ['scripts/reset-password.mjs', 'admin@test.com'], { env: { ...process.env, NEW_PASSWORD: 'short' }, stdio: 'pipe' }));
  void call;
});
