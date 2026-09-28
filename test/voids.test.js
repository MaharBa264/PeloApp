import { D1 } from './d1.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

test('voiding charges and payments restores balances and keeps the ledger', async () => {
  const DB = new D1(), env = { DB, BOOTSTRAP_TOKEN: 'private-installation-token', APP_ENV: 'development' };
  let cookie = '', ip = 1;
  async function call(path, method = 'GET', data, opts = {}) {
    const headers = { Origin: 'https://pelo.test', 'Content-Type': 'application/json', Cookie: opts.cookie ?? cookie, 'CF-Connecting-IP': String(ip++), ...opts.headers };
    const response = await worker.fetch(new Request(`https://pelo.test/api${path}`, { method, headers, body: data ? JSON.stringify(data) : undefined }), env);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  const key = () => ({ headers: { 'Idempotency-Key': crypto.randomUUID() } });
  await call('/setup', 'POST', { token: env.BOOTSTRAP_TOKEN, name: 'Admin', email: 'admin@test.com', password: 'long-password-test' });
  let r = await call('/login', 'POST', { email: 'admin@test.com', password: 'long-password-test' });
  const adminCookie = cookie = r.cookie.split(';')[0];
  r = await call('/users', 'POST', { name: 'Op', email: 'op@test.com', password: 'long-password-test', role: 'operator', school_ids: ['school-1'] });
  assert.equal(r.status, 200);
  r = await call('/login', 'POST', { email: 'op@test.com', password: 'long-password-test' });
  const opCookie = r.cookie.split(';')[0];
  r = await call('/clients', 'POST', { name: 'Familia', kind: 'Familia', school_id: 'school-1', mode: 'original' });
  const client = r.data.id;
  const charge = async (price, quantity = 1) => { const k = crypto.randomUUID(); r = await call(`/clients/${client}/charge`, 'POST', { description: 'Cafe', quantity, unit_price: price, occurred_on: '2026-09-27' }, { headers: { 'Idempotency-Key': k } }); assert.equal(r.status, 200); return k; };
  const pay = async amount => { const body = { amount, method: 'Efectivo', note: '' }; r = await call(`/clients/${client}/quote`, 'POST', body); const k = crypto.randomUUID(); r = await call(`/clients/${client}/payment`, 'POST', { ...body, fingerprint: r.data.fingerprint }, { headers: { 'Idempotency-Key': k } }); assert.equal(r.status, 200, JSON.stringify(r.data)); return k; };
  const detail = async () => (await call(`/clients/${client}`)).data;
  const voidOf = (event_id, reason = 'Error de carga', opts = key()) => call(`/clients/${client}/void`, 'POST', { event_id, reason }, opts);

  const c1 = await charge('1000'), c2 = await charge('500');
  const p1 = await pay('1200');
  let d = await detail();
  assert.equal(d.lines.reduce((s, l) => s + l.remaining, 0), 150000 - 120000);
  assert.equal((await voidOf(c1)).status, 409, 'paid charge cannot be voided');
  const p2 = await pay('100'); // 50000-? partial on second charge
  assert.equal((await voidOf(p1)).status, 409, 'only the latest payment can be voided');

  r = await voidOf(p2, 'ab'); assert.equal(r.status, 400, 'reason too short');
  r = await call(`/clients/${client}/void`, 'POST', { event_id: p2, reason: 'Cobro duplicado' }, { cookie: opCookie, ...key() }); assert.equal(r.status, 403, 'operators cannot void');
  const k = { headers: { 'Idempotency-Key': crypto.randomUUID() } };
  assert.equal((await voidOf(p2, 'Cobro duplicado', k)).status, 200);
  assert.equal((await voidOf(p2, 'Cobro duplicado', k)).data.repeated, true, 'retry is idempotent');
  assert.equal((await voidOf(p2, 'Otra vez')).status, 409, 'cannot void twice');
  d = await detail();
  assert.equal(d.lines.reduce((s, l) => s + l.remaining, 0), 30000);
  assert.equal(d.events.find(e => e.id === p2).voided, true);

  assert.equal((await voidOf(p1)).status, 200);
  d = await detail();
  assert.equal(d.lines.reduce((s, l) => s + l.remaining, 0), 150000);
  assert.equal((await voidOf(c1)).status, 200);
  assert.equal((await voidOf(c2)).status, 200);
  d = await detail();
  assert.equal(d.lines.length, 0);
  assert.equal(d.client.credit, 0);
  assert.equal(d.events.filter(e => e.kind === 'void').length, 4);

  // advance payments: voiding restores the previous credit
  await charge('300');
  const adv = await pay('1000'); // 300 applied, 700 credit
  assert.equal((await detail()).client.credit, 70000);
  assert.equal((await voidOf(adv)).status, 200);
  d = await detail();
  assert.equal(d.client.credit, 0);
  assert.equal(d.lines.reduce((s, l) => s + l.remaining, 0), 30000);
  assert.equal((await voidOf('nonexistent')).status, 404);

  // amending a charge replaces it atomically and keeps both records
  const wrong = await charge('900', 2);
  const amend = (event_id, extra = {}, opts = key()) => call(`/clients/${client}/amend`, 'POST', { event_id, reason: 'Precio mal cargado', description: 'Cafe', quantity: 2, unit_price: '800', occurred_on: '2026-09-26', ...extra }, opts);
  const before = (await detail()).lines.reduce((s, l) => s + l.remaining, 0);
  assert.equal((await amend(wrong, { reason: '' })).status, 400);
  assert.equal((await amend(wrong, { unit_price: 'abc' })).status, 400);
  assert.equal((await detail()).lines.reduce((s, l) => s + l.remaining, 0), before, 'failed amend changes nothing');
  r = await call(`/clients/${client}/amend`, 'POST', { event_id: wrong, reason: 'x y z', description: 'Cafe', quantity: 2, unit_price: '800', occurred_on: '2026-09-26' }, { cookie: opCookie, ...key() });
  assert.equal(r.status, 403, 'operators cannot amend');
  assert.equal((await amend(wrong)).status, 200);
  d = await detail();
  assert.equal(d.lines.reduce((s, l) => s + l.remaining, 0), before - 2 * 90000 + 2 * 80000);
  assert.equal(d.events.find(e => e.id === wrong).void_kind, 'amend');
  assert.equal((await amend(wrong)).status, 409, 'cannot amend twice');
  const newest = d.events.find(e => e.kind === 'amend');
  assert.equal(newest.data.after.unit_price, 80000);
  void adminCookie;
});
