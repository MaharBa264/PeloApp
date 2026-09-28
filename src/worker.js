import { planImport } from './import-products.js';
import { assert, cents, settlement, valueOf } from './domain.js';

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const text = (v, max = 160) => String(v ?? '').trim().slice(0, max);
const stmt = (db, sql, ...args) => db.prepare(sql).bind(...args);
const one = (db, sql, ...args) => stmt(db, sql, ...args).first();
const rows = async (db, sql, ...args) => (await stmt(db, sql, ...args).all()).results;
const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const bytes = s => new TextEncoder().encode(s);
const hex = b => Array.from(new Uint8Array(b), n => n.toString(16).padStart(2, '0')).join('');
const hash = async s => hex(await crypto.subtle.digest('SHA-256', bytes(s)));
export async function passwordHash(password, salt = id()) {
  const key = await crypto.subtle.importKey('raw', bytes(password), 'PBKDF2', false, ['deriveBits']);
  const result = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(salt), iterations: 100000 }, key, 256);
  return `${salt}:${hex(result)}`;
}
function safeEqual(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function role(user, allowed) { assert(allowed.includes(user.role), 'No tenés permiso para esta operación.', 403); }
function scope(user, school) { assert(user.role === 'superadmin' || JSON.parse(user.school_ids).includes(school), 'No tenés acceso a ese colegio.', 403); }
function publicUser(u) { const { password, ...safe } = u; return safe; }
const audit = (db, actor, action, data) => stmt(db, 'INSERT INTO audit VALUES (?,?,?,?,?)', id(), actor, action, JSON.stringify(data), now());
async function body(request) {
  assert((request.headers.get('content-type') || '').includes('application/json'), 'Se requiere JSON.', 415);
  const raw = await request.text();
  assert(raw.length <= 180000, 'Solicitud demasiado grande.', 413);
  try { return JSON.parse(raw); } catch { assert(false, 'JSON inválido.'); }
}
async function account(db, user, clientId) {
  const client = await one(db, 'SELECT * FROM clients WHERE id=?', clientId);
  assert(client, 'Cuenta no encontrada.', 404); scope(user, client.school_id); return client;
}
async function pending(db, clientId) {
  return rows(db, 'SELECT c.*,p.price AS current_price FROM charges c LEFT JOIN products p ON p.id=c.product_id WHERE c.client_id=? AND c.remaining>0 ORDER BY c.occurred_on,c.id', clientId);
}
async function detail(db, client, offset=0) {
  assert(Number.isSafeInteger(offset)&&offset>=0,'Página inválida.');
  const lines = await pending(db, client.id);
  const events = await rows(db, 'SELECT e.*,u.name AS actor_name FROM events e JOIN users u ON u.id=e.actor WHERE client_id=? ORDER BY version DESC LIMIT 50 OFFSET ?', client.id,offset);
  return { client, offset, lines: lines.map(l => ({ ...l, current_value: valueOf(l, 'current') })), events: events.map(e => ({ ...e, data: JSON.parse(e.data) })) };
}
async function commitAccount(db, client, user, key, kind, data, requestHash, statements) {
  assert(/^[a-zA-Z0-9-]{16,80}$/.test(key || ''), 'Falta el identificador de operación.');
  try {
    await db.batch([
      stmt(db, 'INSERT INTO events VALUES (?,?,?,?,?,?,?,?)', key, client.id, client.version + 1, kind, JSON.stringify(data), user.id, requestHash, now()),
      ...statements,
      stmt(db, 'UPDATE clients SET version=version+1 WHERE id=?', client.id)
    ]);
  } catch (error) {
    if (/UNIQUE constraint/.test(error.message)) assert(false, 'La cuenta cambió mientras operabas. Actualizá y revisá antes de confirmar.', 409);
    throw error;
  }
}
async function catalogCommit(db,user,key,requestHash,version,statements) {
  assert(/^[a-zA-Z0-9-]{16,80}$/.test(key||''),'Falta el identificador de importación.');
  try { await db.batch([stmt(db,'INSERT INTO catalog_events VALUES (?,?,?,?,?)',key,version+1,user.id,requestHash,now()),...statements]); }
  catch(e){if(/UNIQUE constraint/.test(e.message))assert(false,'El catálogo cambió. Revisá de nuevo antes de guardar.',409);throw e;}
}
async function catalogVersion(db){return (await one(db,'SELECT COALESCE(MAX(version),0) AS n FROM catalog_events')).n;}
function manageUser(user,target){
  role(user,['superadmin','admin']);
  if(user.role==='admin'){
    assert(['operator','viewer'].includes(target.role),'Solo el superadministrador puede administrar ese nivel.',403);
    JSON.parse(target.school_ids).forEach(s=>scope(user,s));
  }
}
async function rateLimit(db, request) {
  const ip = await hash(request.headers.get('CF-Connecting-IP') || 'local');
  const since = Date.now() - 15 * 60 * 1000;
  const recent = await one(db, 'SELECT COUNT(*) AS n FROM auth_attempts WHERE ip=? AND at>?', ip, since);
  assert(recent.n < 15, 'Demasiados intentos. Esperá 15 minutos.', 429);
  await db.batch([stmt(db, 'INSERT INTO auth_attempts VALUES (?,?,?)', id(), ip, Date.now()), stmt(db, 'DELETE FROM auth_attempts WHERE at<?', since)]);
}
async function api(request, env) {
  const db = env.DB, url = new URL(request.url), path = url.pathname, method = request.method;
  assert(db, 'Falta vincular la base D1.', 503);
  if (!['GET','HEAD'].includes(method)) {
    assert(request.headers.get('Origin') === url.origin, 'Origen no permitido.', 403);
  }
  if (path === '/api/status' && method === 'GET') {
    const existing = await one(db, 'SELECT id FROM users LIMIT 1');
    return json({ initialized: Boolean(existing), environment: env.APP_ENV });
  }
  if (path === '/api/setup' && method === 'POST') {
    await rateLimit(db, request);
    const b = await body(request);
    assert(env.BOOTSTRAP_TOKEN && safeEqual(String(b.token || ''), env.BOOTSTRAP_TOKEN), 'Clave de instalación incorrecta.', 403);
    assert(!await one(db, 'SELECT id FROM users LIMIT 1'), 'La instalación ya se completó.', 409);
    assert(text(b.name) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(b.email)), 'Completá nombre y correo.');
    assert(typeof b.password === 'string' && b.password.length >= 12 && b.password.length <= 128, 'Usá una contraseña de 12 a 128 caracteres.');
    await db.batch([
      stmt(db, 'INSERT INTO users(id,name,email,password,role,created_at) VALUES (?,?,?,?,?,?)', 'initial-superadmin', text(b.name), text(b.email).toLowerCase(), await passwordHash(b.password), 'superadmin', now()),
      audit(db, 'initial-superadmin', 'setup', {})
    ]);
    return json({ ok: true });
  }
  if (path === '/api/login' && method === 'POST') {
    await rateLimit(db, request);
    const b = await body(request), email = text(b.email).toLowerCase();
    assert(typeof b.password === 'string' && b.password.length <= 128, 'Credenciales incorrectas.', 401);
    const user = await one(db, 'SELECT * FROM users WHERE email=? AND active=1', email);
    const candidate = await passwordHash(b.password, user ? user.password.split(':')[0] : 'unknown-user-salt');
    assert(user && safeEqual(candidate, user.password), 'Credenciales incorrectas.', 401);
    const token = id() + id();
    await db.batch([stmt(db, 'INSERT INTO sessions VALUES (?,?,?)', await hash(token), user.id, Date.now() + 12 * 3600000), stmt(db, 'DELETE FROM sessions WHERE expires_at<?', Date.now())]);
    return json({ user: publicUser(user) }, 200, { 'Set-Cookie': `pelo_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200` });
  }
  const token = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)pelo_session=([^;]+)/)?.[1] || '';
  const user = await one(db, 'SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at>? AND u.active=1', await hash(token), Date.now());
  assert(user, 'Iniciá sesión para continuar.', 401);
  if (path === '/api/logout' && method === 'POST') {
    await stmt(db, 'DELETE FROM sessions WHERE token=?', await hash(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'pelo_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (path === '/api/data' && method === 'GET') {
    const schools = await rows(db, 'SELECT * FROM schools ORDER BY id');
    const clients = await rows(db, `SELECT c.*,s.name AS school_name,COALESCE(SUM(h.remaining),0) AS original_due,
      COALESCE(SUM(CASE WHEN h.product_id IS NULL THEN h.remaining ELSE CAST(ROUND(h.remaining*1.0*p.price/h.unit_price) AS INTEGER) END),0) AS current_due
      FROM clients c JOIN schools s ON s.id=c.school_id LEFT JOIN charges h ON h.client_id=c.id AND h.remaining>0 LEFT JOIN products p ON p.id=h.product_id
      WHERE (?='superadmin' OR c.school_id IN (SELECT value FROM json_each(?))) GROUP BY c.id ORDER BY c.name`, user.role, user.school_ids);
    return json({ user: publicUser(user), environment: env.APP_ENV, schools: schools.filter(s => user.role === 'superadmin' || JSON.parse(user.school_ids).includes(s.id)), clients, products: await rows(db, 'SELECT * FROM products ORDER BY name'), settings: JSON.parse((await one(db, 'SELECT data FROM settings WHERE id=1')).data) });
  }
  if (path === '/api/clients' && method === 'POST') {
    role(user, ['superadmin','admin','operator']); const b = await body(request);
    scope(user, b.school_id); assert(text(b.name), 'Ingresá el nombre.');
    assert(['original','current'].includes(b.mode), 'Criterio inválido.');
    assert(['Familia','Alumno','Personal','Otro'].includes(b.kind), 'Tipo de cliente inválido.');
    const clientId = id();
    await db.batch([stmt(db, 'INSERT INTO clients(id,name,kind,contact,school_id,mode,created_at) VALUES (?,?,?,?,?,?,?)', clientId, text(b.name), b.kind, text(b.contact), b.school_id, b.mode, now()), audit(db, user.id, 'client.create', { id: clientId, name: text(b.name), school: b.school_id, mode: b.mode })]);
    return json({ id: clientId }, 201);
  }
  const match = path.match(/^\/api\/clients\/([^/]+)(?:\/(charge|quote|payment))?$/);
  if (match) {
    const client = await account(db, user, match[1]);
    if (!match[2] && method === 'GET') return json(await detail(db, client,Number(url.searchParams.get('offset')||0)));
    if(!match[2] && method==='PUT'){
      role(user,['superadmin','admin']); const b=await body(request);
      assert(text(b.name) && ['Familia','Alumno','Personal','Otro'].includes(b.kind),'Nombre o tipo inválido.');
      assert(['original','current'].includes(b.mode),'Criterio de cobro inválido.');
      assert(b.version===client.version,'La cuenta cambió. Volvé a abrir la edición.',409);
      const data={before:{name:client.name,kind:client.kind,contact:client.contact,notes:client.notes,mode:client.mode},after:{name:text(b.name),kind:b.kind,contact:text(b.contact),notes:text(b.notes,1000),mode:b.mode}};
      const key=request.headers.get('Idempotency-Key'),requestHash=await hash(JSON.stringify(b));
      await commitAccount(db,client,user,key,'profile',data,requestHash,[stmt(db,'UPDATE clients SET name=?,kind=?,contact=?,notes=?,mode=? WHERE id=?',data.after.name,data.after.kind,data.after.contact,data.after.notes,data.after.mode,client.id)]);
      return json({ok:true});
    }
    role(user, ['superadmin','admin','operator']); assert(method === 'POST', 'Método no permitido.', 405);
    const b = await body(request), action = match[2], key = request.headers.get('Idempotency-Key');
    const requestHash = await hash(JSON.stringify({ action, b }));
    if (action !== 'quote') {
      const old = await one(db, 'SELECT client_id,request_hash FROM events WHERE id=?', key || '');
      if (old) { assert(old.client_id === client.id && old.request_hash === requestHash, 'Identificador de operación ya utilizado.', 409); return json({ ok: true, repeated: true }); }
    }
    if (action === 'charge') {
      assert(Number.isInteger(b.quantity) && b.quantity > 0 && b.quantity <= 1000, 'Cantidad: entre 1 y 1000 unidades.');
      const product = b.product_id ? await one(db, 'SELECT * FROM products WHERE id=?', b.product_id) : null;
      assert(!b.product_id || product, 'Producto no encontrado.');
      const unitPrice = cents(b.unit_price); assert(unitPrice > 0, 'El precio debe ser mayor a cero.');
      if (user.role === 'operator' && product) assert(unitPrice === product.price, 'Solo un administrador puede cargar un precio histórico diferente.', 403);
      const description = product?.name || text(b.description);
      assert(description, 'Indicá el concepto.');
      assert(/^\d{4}-\d{2}-\d{2}$/.test(b.occurred_on || '') && !Number.isNaN(Date.parse(b.occurred_on)) && new Date(b.occurred_on).toISOString().slice(0,10) === b.occurred_on, 'Fecha inválida.');
      const charge = { id: id(), description, quantity: b.quantity, unit_price: unitPrice, total: unitPrice * b.quantity, product_id: product?.id || null, occurred_on: b.occurred_on };
      await commitAccount(db, client, user, key, 'charge', charge, requestHash, [stmt(db, 'INSERT INTO charges VALUES (?,?,?,?,?,?,?,?,?)', charge.id, client.id, charge.product_id, description, charge.quantity, unitPrice, charge.total, b.occurred_on, key)]);
      return json({ ok: true });
    }
    if (action === 'quote' || action === 'payment') {
      const lines = await pending(db, client.id), amount = cents(b.amount), mode = client.mode;
      assert(amount > 0 || client.credit > 0, 'Ingresá un importe o aplicá un saldo a favor.');
      assert(['Efectivo','Transferencia','Otro'].includes(b.method), 'Medio de pago inválido.');
      const quote = settlement(lines, amount, client.credit, mode);
      const fingerprint = await hash(JSON.stringify({ version: client.version, quote, method: b.method }));
      if (action === 'quote') return json({ ...quote, fingerprint, version: client.version });
      assert(b.fingerprint === fingerprint, 'La cuenta o los precios cambiaron. Volvé a calcular antes de cobrar.', 409);
      const data = { ...quote, method: b.method, note: text(b.note, 500) };
      await commitAccount(db, client, user, key, 'payment', data, requestHash, [
        stmt(db, `UPDATE charges SET remaining=(SELECT json_extract(value,'$.remaining') FROM json_each(?) WHERE json_extract(value,'$.id')=charges.id) WHERE client_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`, JSON.stringify(quote.allocations), client.id, JSON.stringify(quote.allocations)),
        stmt(db, 'UPDATE clients SET credit=? WHERE id=?', quote.credit, client.id)
      ]);
      return json({ ok: true });
    }
  }
  if(path==='/api/products/history' && method==='GET'){
    const productId=url.searchParams.get('product');
    const limit=50,offset=Number(url.searchParams.get('offset')||0);
    assert(Number.isSafeInteger(offset)&&offset>=0,'Página inválida.');
    return json(await rows(db,'SELECT h.*,p.name AS product_name,u.name AS actor_name FROM price_history h JOIN products p ON p.id=h.product_id JOIN users u ON u.id=h.actor WHERE (? IS NULL OR h.product_id=?) ORDER BY h.created_at DESC,h.rowid DESC LIMIT ? OFFSET ?',productId,productId,limit,offset));
  }
  if(path==='/api/products/import' && method==='POST'){
    role(user,['superadmin','admin']);const b=await body(request),key=request.headers.get('Idempotency-Key');
    const requestHash=await hash(JSON.stringify({rows:b.rows,update_existing:b.update_existing,fingerprint:b.fingerprint}));
    if(b.confirm){const old=await one(db,'SELECT request_hash FROM catalog_events WHERE id=?',key||'');if(old){assert(old.request_hash===requestHash,'Identificador reutilizado.',409);return json({ok:true,repeated:true});}}
    const revision=await catalogVersion(db),products=await rows(db,'SELECT * FROM products ORDER BY id');
    const plan=planImport(b.rows,products,b.update_existing===true);
    const fingerprint=await hash(JSON.stringify({revision,plan}));
    if(!b.confirm)return json({...plan,fingerprint});
    assert(!plan.errors.length,'Corregí las filas con errores antes de importar.');
    assert(b.fingerprint===fingerprint,'El catálogo cambió. Volvé a revisar la importación.',409);
    const changes=plan.items.filter(x=>x.action!=='skip').map(x=>({...x,id:x.id||id()}));
    assert(changes.length,'No hay cambios para guardar.');
    const encoded=JSON.stringify(changes),created=now();
    await catalogCommit(db,user,key,requestHash,revision,[
      stmt(db,`INSERT INTO products(id,name,price,version) SELECT json_extract(value,'$.id'),json_extract(value,'$.name'),json_extract(value,'$.price'),0 FROM json_each(?) WHERE json_extract(value,'$.action')='create'`,encoded),
      stmt(db,`UPDATE products SET price=(SELECT json_extract(value,'$.price') FROM json_each(?) WHERE json_extract(value,'$.id')=products.id),version=version+1 WHERE id IN (SELECT json_extract(value,'$.id') FROM json_each(?) WHERE json_extract(value,'$.action')='update')`,encoded,encoded),
      stmt(db,`INSERT INTO price_history SELECT ? || ':' || json_extract(value,'$.id'),json_extract(value,'$.id'),json_extract(value,'$.price'),?,? FROM json_each(?)`,key,user.id,created,encoded),
      audit(db,user.id,'products.import',{created:plan.create,updated:plan.update,skipped:plan.skip})
    ]);return json({ok:true,created:plan.create,updated:plan.update,skipped:plan.skip});
  }
  if (path === '/api/products' && method === 'POST') {
    role(user, ['superadmin','admin']); const b = await body(request), price = cents(b.price), productId = id();
    assert(text(b.name) && price > 0, 'Completá nombre y precio.');
    await catalogCommit(db,user,id(),'create',await catalogVersion(db),[stmt(db, 'INSERT INTO products(id,name,price) VALUES (?,?,?)', productId, text(b.name), price), stmt(db, 'INSERT INTO price_history VALUES (?,?,?,?,?)', id(), productId, price, user.id, now())]);
    return json({ ok: true });
  }
  if (/^\/api\/products\/[^/]+$/.test(path) && method === 'PUT') {
    role(user, ['superadmin','admin']); const b = await body(request), price = cents(b.price), productId = path.split('/').pop();
    assert(price > 0, 'Precio inválido.');
    const product = await one(db, 'SELECT * FROM products WHERE id=?', productId); assert(product, 'Producto no encontrado.', 404);
    await catalogCommit(db,user,id(),'price',await catalogVersion(db),[stmt(db, 'UPDATE products SET price=?,version=version+1 WHERE id=?', price, productId), stmt(db, 'INSERT INTO price_history VALUES (?,?,?,?,?)', id(), productId, price, user.id, now())]);
    return json({ ok: true });
  }
  if (path === '/api/settings' && method === 'PUT') {
    role(user, ['superadmin']); const b = await body(request);
    assert(text(b.name) && /^#[0-9a-f]{6}$/i.test(b.color) && ['system','humanist','serif'].includes(b.font), 'Configuración inválida.');
    assert(!b.logo || /^https:\/\/[^\s]+$/.test(b.logo), 'El logo debe tener una dirección HTTPS.');
    const settings = { name: text(b.name, 60), color: b.color, font: b.font, logo: text(b.logo, 1000), footer: text(b.footer, 300) };
    assert(Array.isArray(b.schools) && b.schools.length === 3 && new Set(b.schools.map(s => s.id)).size === 3 && b.schools.every(s => ['school-1','school-2','school-3'].includes(s.id) && text(s.name) && (!s.logo || /^https:\/\/[^\s]+$/.test(s.logo)) && /^#[0-9a-f]{6}$/i.test(s.color||'#315ded')), 'Completá los nombres de los tres colegios.');
    await db.batch([stmt(db, 'UPDATE settings SET data=? WHERE id=1', JSON.stringify(settings)), ...b.schools.map(s => stmt(db, 'UPDATE schools SET name=?,logo=?,color=? WHERE id=?', text(s.name),text(s.logo,1000),s.color||'#315ded',s.id)), audit(db, user.id, 'settings.update', {...settings,schools:b.schools})]);
    return json({ ok: true });
  }
  if (path === '/api/users' && method === 'GET') {
    role(user, ['superadmin','admin']);
    const list=await rows(db,'SELECT id,name,email,role,school_ids,active FROM users ORDER BY name');
    return json(list.filter(u=>user.role==='superadmin'||(['operator','viewer'].includes(u.role)&&JSON.parse(u.school_ids).every(s=>JSON.parse(user.school_ids).includes(s)))));
  }
  if (path === '/api/users' && method === 'POST') {
    role(user, ['superadmin','admin']); const b = await body(request);
    assert(text(b.name) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(b.email)), 'Completá nombre y correo.');
    assert(['superadmin','admin','operator','viewer'].includes(b.role), 'Rol inválido.');
    assert(Array.isArray(b.school_ids) && b.school_ids.every(s => ['school-1','school-2','school-3'].includes(s)) && (b.role === 'superadmin' || b.school_ids.length), 'Asigná al menos un colegio.');
    assert(typeof b.password === 'string' && b.password.length >= 12 && b.password.length <= 128, 'Usá una contraseña de 12 a 128 caracteres.');
    manageUser(user,{role:b.role,school_ids:JSON.stringify(b.school_ids)});
    const userId = id();
    await db.batch([stmt(db, 'INSERT INTO users(id,name,email,password,role,school_ids,created_at) VALUES (?,?,?,?,?,?,?)', userId, text(b.name), text(b.email).toLowerCase(), await passwordHash(b.password), b.role, JSON.stringify(b.school_ids), now()), audit(db, user.id, 'user.create', { id: userId, role: b.role, schools: b.school_ids })]);
    return json({ ok: true });
  }
  if (/^\/api\/users\/[^/]+$/.test(path) && method === 'PUT') {
    role(user,['superadmin','admin']);const target=path.split('/').pop(),b=await body(request);
    const old=await one(db,'SELECT * FROM users WHERE id=?',target);assert(old,'Usuario no encontrado.',404);manageUser(user,old);
    const next={...old,...b};
    next.school_ids=b.school_ids??JSON.parse(old.school_ids);
    assert(text(next.name)&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text(next.email)),'Completá nombre y correo.');
    assert(['superadmin','admin','operator','viewer'].includes(next.role),'Rol inválido.');
    assert(Array.isArray(next.school_ids)&&next.school_ids.every(s=>['school-1','school-2','school-3'].includes(s))&&(next.role==='superadmin'||next.school_ids.length),'Asigná colegios válidos.');
    manageUser(user,{role:next.role,school_ids:JSON.stringify(next.school_ids)});
    const active=b.active===undefined?Boolean(old.active):b.active;assert(typeof active==='boolean','Estado inválido.');
    assert(target!==user.id||(active&&next.role===old.role),'No podés desactivar o cambiar tu propio nivel.');
    assert(old.role!=='superadmin'||(next.role==='superadmin'&&active),'No se puede degradar o desactivar un superadministrador desde esta pantalla.');
    let password=old.password;
    if(b.password){assert(typeof b.password==='string'&&b.password.length>=12&&b.password.length<=128,'Contraseña: de 12 a 128 caracteres.');password=await passwordHash(b.password);}
    await db.batch([
      stmt(db,'UPDATE users SET name=?,email=?,role=?,school_ids=?,active=?,password=? WHERE id=?',text(next.name),text(next.email).toLowerCase(),next.role,JSON.stringify(next.school_ids),active?1:0,password,target),
      stmt(db,'DELETE FROM sessions WHERE user_id=?',target),
      audit(db,user.id,'user.update',{id:target,before:{name:old.name,email:old.email,role:old.role,schools:JSON.parse(old.school_ids),active:Boolean(old.active)},after:{name:text(next.name),email:text(next.email),role:next.role,schools:next.school_ids,active},password_changed:Boolean(b.password)})
    ]);
    return json({ ok: true });
  }
  assert(false, 'Ruta no encontrada.', 404);
}
export default {
  async fetch(request, env) {
    let response;
    try {
      if (new URL(request.url).pathname.startsWith('/api/')) response = await api(request, env);
      else response = await env.ASSETS.fetch(request);
    } catch (error) {
      console.error('request_failed', error.status || 500, error.status ? error.message : 'database_or_internal_error');
      const conflict = /UNIQUE constraint/.test(error.message);
      response = json({ error: error.status ? error.message : conflict ? 'Ese registro ya existe. Actualizá la pantalla.' : 'No se pudo completar la operación. Revisá la configuración o intentá nuevamente.' }, error.status || (conflict ? 409 : 500));
    }
    response = new Response(response.body, response);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'same-origin');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    return response;
  }
};
