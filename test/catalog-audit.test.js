import { D1 } from './d1.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';

class R2Mock {
  files = new Map();
  async put(key, value) { this.files.set(key, value); }
  async get(key) { return this.files.has(key) ? { body: new Blob([this.files.get(key)]).stream() } : null; }
  async delete(key) { this.files.delete(key); }
}

async function setup() {
  const DB = new D1(), DOCUMENTS = new R2Mock(), env = { DB, DOCUMENTS, BOOTSTRAP_TOKEN: 'private-installation-token', APP_ENV: 'development' };
  let cookie = '', ip = 1;
  async function call(path, method = 'GET', data, opts = {}) {
    const headers = { Origin: 'https://pelo.test', 'Content-Type': 'application/json', Cookie: opts.cookie ?? cookie, 'CF-Connecting-IP': String(ip++), ...opts.headers };
    const response = await worker.fetch(new Request(`https://pelo.test/api${path}`, { method, headers, body: data ? JSON.stringify(data) : undefined }), env);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  const login = async (email, password = 'long-password-test') => (await call('/login', 'POST', { email, password })).cookie.split(';')[0];
  await call('/setup', 'POST', { token: env.BOOTSTRAP_TOKEN, name: 'Admin', email: 'admin@test.com', password: 'long-password-test' });
  cookie = await login('admin@test.com');
  return { DB, DOCUMENTS, env, call, login, set: c => { cookie = c; }, key: () => ({ headers: { 'Idempotency-Key': crypto.randomUUID() } }) };
}

test('archived products, suppliers, price evolution and audit', async () => {
  const { DB, call, login, set, key } = await setup();
  let r = await call('/suppliers', 'POST', { name: 'Distribuidora Sur' }); assert.equal(r.status, 201);
  assert.equal((await call('/suppliers', 'POST', { name: 'distribuidora sur' })).status, 409);
  const supplier = (await call('/data')).data.suppliers[0];
  for (const [name, price] of [['Alfajor', '1000'], ['Gaseosa', '2000'], ['Sin proveedor', '500']]) await call('/products', 'POST', { name, price, supplier_id: name === 'Sin proveedor' ? '' : supplier.id });
  let products = (await call('/data')).data.products;
  const [alfajor, gaseosa, loose] = ['Alfajor', 'Gaseosa', 'Sin proveedor'].map(n => products.find(p => p.name === n));
  assert.equal(alfajor.supplier_name, 'Distribuidora Sur'); assert.equal(loose.supplier_id, null);
  assert.equal((await call('/products', 'POST', { name: 'X', price: '1', supplier_id: 'nope' })).status, 400);
  r = await call('/products/assign-supplier', 'POST', { product_ids: [loose.id], supplier_id: supplier.id }); assert.equal(r.status, 200);
  await call('/products/assign-supplier', 'POST', { product_ids: [loose.id], supplier_id: null });
  assert.equal((await call('/data')).data.products.find(p => p.id === loose.id).supplier_id, null);

  // price evolution for the supplier
  await call(`/products/${alfajor.id}`, 'PUT', { price: '1200' });
  DB.db.exec("UPDATE price_history SET created_at='2026-01-10T12:00:00.000Z' WHERE price IN (1000000,100000,200000) OR price=100000");
  DB.db.exec("UPDATE price_history SET created_at='2026-01-10T12:00:00.000Z' WHERE price IN (100000,200000,50000)");
  DB.db.exec("UPDATE price_history SET created_at='2026-02-10T12:00:00.000Z' WHERE price=120000");
  r = await call(`/suppliers/${supplier.id}/evolution?from=2026-01-31&to=2026-03-01`);
  assert.equal(r.status, 200);
  assert.equal(r.data.summary.products, 2);
  assert.equal(r.data.summary.average_change_pct, 10);
  assert.equal(r.data.summary.with_change, 1);
  assert.equal(r.data.items.find(i => i.name === 'Alfajor').change_pct, 20);
  assert.equal(r.data.items.find(i => i.name === 'Gaseosa').change_pct, 0);
  assert.equal(r.data.changes.length, 1); assert.equal(r.data.changes[0].previous, 100000);
  assert.equal(r.data.series.at(-1).date, '2026-03-01'); assert.equal(r.data.series.at(-1).index, 110);
  assert.equal(r.data.series[0].index, 100);
  assert.equal((await call(`/suppliers/${supplier.id}/evolution?from=2026-03-01&to=2026-01-01`)).status, 400);
  assert.equal((await call(`/products/history?supplier=${supplier.id}`)).data.every(h => h.product_id !== loose.id), true);

  // archive: hidden from new charges, still usable in existing ledgers, restorable
  r = await call('/clients', 'POST', { name: 'Familia', kind: 'Familia', school_id: 'school-1', mode: 'current' }); const client = r.data.id;
  const charge = (extra = {}) => call(`/clients/${client}/charge`, 'POST', { product_id: gaseosa.id, quantity: 1, unit_price: '2000', occurred_on: '2026-09-27', ...extra }, key());
  assert.equal((await charge()).status, 200);
  assert.equal((await call(`/products/${gaseosa.id}/archive`, 'POST', { archived: true })).status, 200);
  assert.ok((await call('/data')).data.products.find(p => p.id === gaseosa.id).archived_at);
  r = await charge(); assert.equal(r.status, 400); assert.match(r.data.error, /archivado/);
  assert.equal((await call(`/clients/${client}`)).data.lines.length, 1, 'existing ledger unchanged');
  const eventId = (await call(`/clients/${client}`)).data.events[0].id;
  r = await call(`/clients/${client}/amend`, 'POST', { event_id: eventId, reason: 'ajuste', product_id: gaseosa.id, quantity: 2, unit_price: '2000', occurred_on: '2026-09-27' }, key());
  assert.equal(r.status, 200, 'an existing charge can keep its archived product when amended');
  assert.equal((await call(`/products/${gaseosa.id}/archive`, 'POST', { archived: 'yes' })).status, 400);
  await call(`/products/${gaseosa.id}/archive`, 'POST', { archived: false });
  assert.equal((await charge()).status, 200);

  // date bounds
  assert.equal((await charge({ occurred_on: '2099-01-01' })).status, 400);
  assert.equal((await charge({ occurred_on: '1999-01-01' })).status, 400);

  // audit
  await call('/users', 'POST', { name: 'Admin 1', email: 'a1@test.com', password: 'long-password-test', role: 'admin', school_ids: ['school-2'] });
  await call('/users', 'POST', { name: 'Op', email: 'op@test.com', password: 'long-password-test', role: 'operator', school_ids: ['school-1'] });
  r = await call('/audit'); assert.equal(r.status, 200);
  assert.ok(r.data.rows.some(x => x.action === 'product.archive'));
  assert.ok(r.data.rows.some(x => x.action === 'account.charge' && x.client_name === 'Familia'));
  assert.ok(r.data.actions.includes('supplier.create') && r.data.actors.length >= 3);
  assert.equal((await call('/audit?action=product.archive')).data.rows.every(x => x.action === 'product.archive'), true);
  assert.equal((await call('/audit?from=2099-01-01')).data.rows.length, 0);
  assert.equal((await call('/audit?from=bad')).status, 400);
  const opCookie = await login('op@test.com');
  assert.equal((await call('/audit', 'GET', null, { cookie: opCookie })).status, 403);
  const adminOtherSchool = await login('a1@test.com');
  const scoped = await call('/audit', 'GET', null, { cookie: adminOtherSchool });
  assert.equal(scoped.status, 200); assert.equal(scoped.data.rows.length, 0, 'admin of another school sees no other-school ledgers or system audit');
  assert.equal((await call(`/suppliers/${supplier.id}/evolution`, 'GET', null, { cookie: opCookie })).status, 403);
  set(opCookie);
  r = await charge({ unit_price: '1' }); assert.equal(r.status, 403); assert.match(r.data.error, /precio vigente/);
});

test('deleting a document that another one references unlinks it', async () => {
  const { call, env } = await setup();
  const rows = [['a', null], ['b', 'a']];
  for (const [id, related] of rows) env.DB.db.prepare("INSERT INTO documents(id,document_type,file_key,file_type,file_size,ai_status,data,actor,created_at,updated_at,related_document_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(id, 'invoice', `documents/${id}`, 'image/jpeg', 4, 'unavailable', '{}', 'initial-superadmin', '2026-01-01', '2026-01-01', related);
  env.DOCUMENTS.files.set('documents/a', new Uint8Array([1]));
  const r = await call('/documents/a', 'DELETE');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(env.DB.db.prepare("SELECT related_document_id AS r FROM documents WHERE id='b'").get().r, null);
});
