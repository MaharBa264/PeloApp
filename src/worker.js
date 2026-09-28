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
  return rows(db, 'SELECT c.*,COALESCE(sp.price,p.price) AS current_price FROM charges c LEFT JOIN products p ON p.id=c.product_id JOIN clients a ON a.id=c.client_id LEFT JOIN product_school_prices sp ON sp.product_id=c.product_id AND sp.school_id=a.school_id WHERE c.client_id=? AND c.remaining>0 ORDER BY c.occurred_on,c.id', clientId);
}
async function detail(db, client, offset=0) {
  assert(Number.isSafeInteger(offset)&&offset>=0,'Página inválida.');
  const lines = await pending(db, client.id);
  const events = await rows(db, 'SELECT e.*,u.name AS actor_name,(v.target_event_id IS NOT NULL) AS voided,ve.kind AS void_kind FROM events e JOIN users u ON u.id=e.actor LEFT JOIN event_voids v ON v.target_event_id=e.id LEFT JOIN events ve ON ve.id=v.void_event_id WHERE e.client_id=? ORDER BY e.version DESC LIMIT 50 OFFSET ?', client.id,offset);
  return { client, offset, lines: lines.map(l => ({ ...l, current_value: valueOf(l, 'current') })), events: events.map(e => ({ ...e, voided: Boolean(e.voided), data: JSON.parse(e.data) })) };
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
const documentTypes = ['invoice','delivery_note','order','other'];
function normalizeDocumentData(value) {
  const data = value && typeof value === 'object' ? value : {};
  const lines = Array.isArray(data.lines) ? data.lines.slice(0, 150).map(line => ({
    code: text(line?.code, 80), description: text(line?.description, 180),
    quantity: String(line?.quantity ?? '').slice(0, 32), unit: text(line?.unit, 32),
    unit_price: String(line?.unit_price ?? '').slice(0, 32), line_total: String(line?.line_total ?? '').slice(0, 32)
  })) : [];
  return {
    document_type: documentTypes.includes(data.document_type) ? data.document_type : 'other',
    supplier: text(data.supplier, 180), document_number: text(data.document_number, 100),
    document_date: /^\d{4}-\d{2}-\d{2}$/.test(data.document_date || '') ? data.document_date : '',
    total: String(data.total ?? '').slice(0, 32), notes: text(data.notes, 1000), lines
  };
}
function validDocumentDate(value) {
  return !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0,10) === value;
}
function parseDocumentAnswer(answer) {
  if (typeof answer !== 'string') return null;
  const start = answer.indexOf('{'), end = answer.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { const result = JSON.parse(answer.slice(start, end + 1)); return result && typeof result === 'object' ? result : null; } catch { return null; }
}
function base64(data) {
  let binary = '';
  for (let start = 0; start < data.length; start += 0x8000) binary += String.fromCharCode(...data.subarray(start, start + 0x8000));
  return btoa(binary);
}
function hasImageSignature(data, type) {
  if (type === 'image/jpeg') return data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (type === 'image/png') return data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
  if (type === 'image/webp') return String.fromCharCode(...data.subarray(0,4)) === 'RIFF' && String.fromCharCode(...data.subarray(8,12)) === 'WEBP';
  return false;
}
async function extractDocument(env, data, type, requestedType) {
  if (!env.AI) return { status: 'unavailable', data: normalizeDocumentData({ document_type: requestedType }) };
  try {
    const answer = await env.AI.run('@cf/moondream/moondream3.1-9B-A2B', {
      task: 'query', image: `data:${type};base64,${base64(data)}`, reasoning: false,
      temperature: 0, max_tokens: 4096,
      question: `Leé esta foto de un documento comercial argentino. Devolvé SOLO un objeto JSON válido, sin texto ni Markdown, con este formato: {"document_type":"invoice|delivery_note|order|other","supplier":"","document_number":"","document_date":"YYYY-MM-DD o vacío","total":"","notes":"anotaciones visibles","lines":[{"code":"","description":"","quantity":"","unit":"","unit_price":"","line_total":""}]}. Transcribí lo legible sin inventar valores. Conservá importes como texto tal como aparecen. Si un dato no se lee, dejalo vacío. Tipo sugerido: ${requestedType}.`
    });
    const parsed = parseDocumentAnswer(answer?.answer);
    return parsed ? { status: 'review', data: normalizeDocumentData(parsed) } : { status: 'error', data: normalizeDocumentData({ document_type: requestedType }) };
  } catch (error) {
    console.error('document_ai_failed', error?.name || 'Error');
    return { status: 'error', data: normalizeDocumentData({ document_type: requestedType }) };
  }
}
async function buildCharge(db, user, client, b) {
  assert(Number.isInteger(b.quantity) && b.quantity > 0 && b.quantity <= 1000, 'Cantidad: entre 1 y 1000 unidades.');
  const product = b.product_id ? await one(db, 'SELECT * FROM products WHERE id=?', b.product_id) : null;
  assert(!b.product_id || product, 'Producto no encontrado.');
  const schoolPrice=product?await one(db,'SELECT price FROM product_school_prices WHERE product_id=? AND school_id=?',product.id,client.school_id):null;
  const effectivePrice=schoolPrice?.price??product?.price;
  const unitPrice = b.unit_price==null&&product?effectivePrice:cents(b.unit_price); assert(unitPrice > 0, 'El precio debe ser mayor a cero.');
  if (user.role === 'operator' && product) assert(unitPrice === effectivePrice, 'Solo un administrador puede cargar un precio histórico diferente.', 403);
  const description = product?.name || text(b.description);
  assert(description, 'Indicá el concepto.');
  assert(/^\d{4}-\d{2}-\d{2}$/.test(b.occurred_on || '') && !Number.isNaN(Date.parse(b.occurred_on)) && new Date(b.occurred_on).toISOString().slice(0,10) === b.occurred_on, 'Fecha inválida.');
  const charge = { id: id(), description, quantity: b.quantity, unit_price: unitPrice, total: unitPrice * b.quantity, product_id: product?.id || null, occurred_on: b.occurred_on };
  return charge;
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
  if (path === '/api/documents' || path.startsWith('/api/documents/')) {
    role(user, ['superadmin','admin']);
    assert(env.DOCUMENTS, 'Falta configurar el almacenamiento privado de documentos en Cloudflare R2.', 503);
    if (path === '/api/documents' && method === 'GET') {
      return json(await rows(db, `SELECT id,document_type,status,supplier,document_number,document_date,related_document_id,file_type,file_size,ai_status,reviewed,reviewed_at,actor,created_at,updated_at FROM documents ORDER BY created_at DESC LIMIT 100`));
    }
    if (path === '/api/documents' && method === 'POST') {
      const length = Number(request.headers.get('Content-Length') || 0);
      assert(!length || length <= 3_500_000, 'La imagen debe pesar menos de 3 MB.', 413);
      assert((request.headers.get('Content-Type') || '').startsWith('multipart/form-data'), 'Subí una foto del documento.', 415);
      const form = await request.formData(), file = form.get('file'), requestedType = String(form.get('document_type') || 'other');
      assert(file instanceof File && file.size > 0 && file.size <= 3 * 1024 * 1024, 'Elegí una imagen de hasta 3 MB.', 413);
      assert(documentTypes.includes(requestedType), 'Tipo de documento inválido.');
      const type = String(file.type || '').toLowerCase();
      assert(['image/jpeg','image/png','image/webp'].includes(type), 'Usá una foto JPG, PNG o WebP.');
      const image = new Uint8Array(await file.arrayBuffer());
      assert(hasImageSignature(image, type), 'El archivo no coincide con el formato de imagen declarado.');
      const documentId = id(), fileKey = `documents/${documentId}`;
      await env.DOCUMENTS.put(fileKey, image, { httpMetadata: { contentType: type, cacheControl: 'private, no-store' } });
      const extracted = await extractDocument(env, image, type, requestedType), data = extracted.data;
      const date = now();
      try {
        await db.batch([
          stmt(db, 'INSERT INTO documents(id,document_type,supplier,document_number,document_date,file_key,file_type,file_size,ai_status,data,actor,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', documentId, data.document_type, data.supplier, data.document_number, data.document_date, fileKey, type, image.length, extracted.status, JSON.stringify(data), user.id, date, date),
          audit(db, user.id, 'document.upload', { id: documentId, document_type: data.document_type, ai_status: extracted.status, size: image.length })
        ]);
      } catch (error) { await env.DOCUMENTS.delete(fileKey); throw error; }
      return json({ id: documentId, document_type: data.document_type, ai_status: extracted.status, data }, 201);
    }
      const documentMatch = path.match(/^\/api\/documents\/([^/]+)(?:\/(image))?$/);
    if (documentMatch) {
      const doc = await one(db, 'SELECT * FROM documents WHERE id=?', documentMatch[1]);
      assert(doc, 'Documento no encontrado.', 404);
      if (!documentMatch[2] && method === 'GET') {
        const { file_key, ...safe } = doc;
        return json({ ...safe, data: JSON.parse(doc.data) });
      }
      if (documentMatch[2] === 'image' && method === 'GET') {
        const object = await env.DOCUMENTS.get(doc.file_key); assert(object, 'La imagen original no está disponible.', 404);
        return new Response(object.body, { headers: { 'Content-Type': doc.file_type, 'Content-Length': String(doc.file_size), 'Cache-Control': 'private, no-store', 'Content-Disposition': 'inline' } });
      }
      if (!documentMatch[2] && method === 'PUT') {
        const b = await body(request), data = normalizeDocumentData(b.data);
        assert(documentTypes.includes(data.document_type), 'Tipo de documento inválido.');
        assert(validDocumentDate(data.document_date), 'Fecha inválida.');
        const related = text(b.related_document_id, 80);
        assert(!related || related !== doc.id && await one(db, 'SELECT id FROM documents WHERE id=?', related), 'Documento relacionado inválido.');
        const date = now();
        await db.batch([
          stmt(db, 'UPDATE documents SET document_type=?,supplier=?,document_number=?,document_date=?,related_document_id=?,data=?,reviewed=1,reviewed_at=?,updated_at=? WHERE id=?', data.document_type, data.supplier, data.document_number, data.document_date, related || null, JSON.stringify(data), date, date, doc.id),
          audit(db, user.id, 'document.review', { id: doc.id, related_document_id: related || null, lines: data.lines.length })
        ]);
        return json({ ok: true });
      }
      if (!documentMatch[2] && method === 'DELETE') {
        await db.batch([stmt(db, 'DELETE FROM documents WHERE id=?', doc.id), audit(db, user.id, 'document.delete', { id: doc.id })]);
        await env.DOCUMENTS.delete(doc.file_key);
        return json({ ok: true });
      }
    }
  }
  if (path === '/api/logout' && method === 'POST') {
    await stmt(db, 'DELETE FROM sessions WHERE token=?', await hash(token)).run();
    return json({ ok: true }, 200, { 'Set-Cookie': 'pelo_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (path === '/api/data' && method === 'GET') {
    const schools = await rows(db, 'SELECT * FROM schools ORDER BY id');
    const clients = await rows(db, `SELECT c.*,s.name AS school_name,COALESCE(SUM(h.remaining),0) AS original_due,
      COALESCE(SUM(CASE WHEN h.product_id IS NULL THEN h.remaining ELSE CAST(ROUND(h.remaining*1.0*COALESCE(sp.price,p.price)/h.unit_price) AS INTEGER) END),0) AS current_due
      FROM clients c JOIN schools s ON s.id=c.school_id LEFT JOIN charges h ON h.client_id=c.id AND h.remaining>0 LEFT JOIN products p ON p.id=h.product_id LEFT JOIN product_school_prices sp ON sp.product_id=h.product_id AND sp.school_id=c.school_id
      WHERE (?='superadmin' OR c.school_id IN (SELECT value FROM json_each(?))) GROUP BY c.id ORDER BY c.name`, user.role, user.school_ids);
    const categories = await rows(db,'SELECT * FROM categories ORDER BY name');
    const products = await rows(db,'SELECT p.*,c.name AS category_name FROM products p LEFT JOIN categories c ON c.id=p.category_id ORDER BY p.name');
    const schoolPrices = await rows(db,`SELECT product_id,school_id,price FROM product_school_prices WHERE (?='superadmin' OR school_id IN (SELECT value FROM json_each(?)))`,user.role,user.school_ids);
    return json({ user: publicUser(user), environment: env.APP_ENV, schools: schools.filter(s => user.role === 'superadmin' || JSON.parse(user.school_ids).includes(s.id)), clients, products, categories, school_prices: schoolPrices, settings: JSON.parse((await one(db, 'SELECT data FROM settings WHERE id=1')).data) });
  }
  if (path === '/api/clients' && method === 'POST') {
    role(user, ['superadmin','admin','operator']); const b = await body(request);
    const schoolIds=Array.isArray(b.school_ids)?b.school_ids:(b.school_id?[b.school_id]:[]);
    assert(schoolIds.length>0&&schoolIds.length<=3&&new Set(schoolIds).size===schoolIds.length&&schoolIds.every(s=>['school-1','school-2','school-3'].includes(s)),'Elegí al menos un colegio válido.');
    schoolIds.forEach(s=>scope(user,s)); assert(text(b.name), 'Ingresá el nombre.');
    assert(['original','current'].includes(b.mode), 'Criterio inválido.');
    assert(['Familia','Alumno','Personal','Otro'].includes(b.kind), 'Tipo de cliente inválido.');
    const profileId=id(), created=now(), accountIds=schoolIds.map(()=>id());
    await db.batch([...schoolIds.map((s,i)=>stmt(db,'INSERT INTO clients(id,name,kind,contact,school_id,mode,created_at,profile_id) VALUES (?,?,?,?,?,?,?,?)',accountIds[i],text(b.name),b.kind,text(b.contact),s,b.mode,created,profileId)),audit(db,user.id,'client.create',{profile_id:profileId,name:text(b.name),schools:schoolIds,mode:b.mode})]);
    return json({ id: accountIds[0], profile_id:profileId, accounts:accountIds.map((id,i)=>({id,school_id:schoolIds[i]})) }, 201);
  }
  const match = path.match(/^\/api\/clients\/([^/]+)(?:\/(charge|quote|payment|schools|void|amend))?$/);
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
      await commitAccount(db,client,user,key,'profile',data,requestHash,[stmt(db,'UPDATE clients SET name=?,kind=?,contact=?,notes=?,version=version+1 WHERE profile_id=? AND id<>?',data.after.name,data.after.kind,data.after.contact,data.after.notes,client.profile_id||client.id,client.id),stmt(db,'UPDATE clients SET name=?,kind=?,contact=?,notes=?,mode=? WHERE id=?',data.after.name,data.after.kind,data.after.contact,data.after.notes,data.after.mode,client.id)]);
      return json({ok:true});
    }
    if(match[2]==='schools'&&method==='POST'){
      role(user,['superadmin','admin','operator']);const b=await body(request),schoolIds=Array.isArray(b.school_ids)?b.school_ids:[];
      assert(schoolIds.length>0&&schoolIds.length<=3&&new Set(schoolIds).size===schoolIds.length&&schoolIds.every(s=>['school-1','school-2','school-3'].includes(s)),'Elegí al menos un colegio válido.');
      schoolIds.forEach(s=>scope(user,s));
      const profileId=client.profile_id||client.id,existing=await rows(db,'SELECT school_id FROM clients WHERE profile_id=?',profileId),known=new Set(existing.map(x=>x.school_id));
      assert(schoolIds.every(s=>!known.has(s)),'Ya existe una cuenta para ese cliente en uno de esos colegios.',409);
      const newAccounts=schoolIds.map(s=>({id:id(),school_id:s})),created=now();
      await db.batch([...newAccounts.map(a=>stmt(db,'INSERT INTO clients(id,name,kind,contact,school_id,mode,credit,version,created_at,notes,profile_id) VALUES (?,?,?,?,?,?,0,0,?,?,?)',a.id,client.name,client.kind,client.contact,a.school_id,client.mode,created,client.notes||'',profileId)),audit(db,user.id,'client.school_account.create',{profile_id:profileId,schools:schoolIds,accounts:newAccounts.map(a=>a.id)})]);
      return json({ok:true,accounts:newAccounts},201);
    }
    if (match[2] === 'void' && method === 'POST') {
      role(user, ['superadmin','admin']);
      const b = await body(request), key = request.headers.get('Idempotency-Key'), reason = text(b.reason, 300);
      assert(reason.length >= 3, 'Indicá el motivo de la anulación.');
      const requestHash = await hash(JSON.stringify({ action: 'void', b }));
      const old = await one(db, 'SELECT client_id,request_hash FROM events WHERE id=?', key || '');
      if (old) { assert(old.client_id === client.id && old.request_hash === requestHash, 'Identificador de operación ya utilizado.', 409); return json({ ok: true, repeated: true }); }
      const target = await one(db, 'SELECT * FROM events WHERE id=? AND client_id=?', String(b.event_id || ''), client.id);
      assert(target, 'Movimiento no encontrado.', 404);
      assert(['charge','payment'].includes(target.kind), 'Solo se pueden anular consumos y pagos.');
      assert(!await one(db, 'SELECT 1 AS x FROM event_voids WHERE target_event_id=?', target.id), 'Ese movimiento ya fue anulado.', 409);
      const original = JSON.parse(target.data);
      let statements, credit = client.credit;
      if (target.kind === 'charge') {
        const charge = await one(db, 'SELECT * FROM charges WHERE event_id=? AND client_id=?', target.id, client.id);
        assert(charge, 'No se encontró el consumo original.', 404);
        assert(charge.remaining === charge.quantity * charge.unit_price, 'El consumo ya tiene pagos aplicados. Anulá primero esos pagos.', 409);
        statements = [stmt(db, 'UPDATE charges SET remaining=0 WHERE id=? AND remaining=quantity*unit_price', charge.id)];
      } else {
        const later = await one(db, `SELECT 1 AS x FROM events e WHERE e.client_id=? AND e.kind='payment' AND e.version>? AND NOT EXISTS (SELECT 1 FROM event_voids v WHERE v.target_event_id=e.id)`, client.id, target.version);
        assert(!later, 'Hay pagos posteriores. Anulá primero el pago más reciente.', 409);
        credit = client.credit - original.credit + original.previous_credit;
        assert(Number.isSafeInteger(credit) && credit >= 0, 'El saldo a favor cambió y no permite anular este pago.', 409);
        for (const a of original.allocations) {
          const line = await one(db, 'SELECT quantity,unit_price,remaining FROM charges WHERE id=? AND client_id=?', a.id, client.id);
          assert(line && line.remaining + a.base <= line.quantity * line.unit_price, 'Un consumo del pago cambió. No se puede anular este pago.', 409);
        }
        const encoded = JSON.stringify(original.allocations);
        statements = [
          stmt(db, `UPDATE charges SET remaining=remaining+(SELECT json_extract(value,'$.base') FROM json_each(?) WHERE json_extract(value,'$.id')=charges.id) WHERE client_id=? AND id IN (SELECT json_extract(value,'$.id') FROM json_each(?))`, encoded, client.id, encoded),
          stmt(db, 'UPDATE clients SET credit=? WHERE id=?', credit, client.id)
        ];
      }
      statements.push(stmt(db, 'INSERT INTO event_voids VALUES (?,?,?,?,?)', target.id, key, reason, user.id, now()));
      await commitAccount(db, client, user, key, 'void', { target_id: target.id, target_kind: target.kind, reason, credit }, requestHash, statements);
      return json({ ok: true });
    }
    if (match[2] === 'amend' && method === 'POST') {
      role(user, ['superadmin','admin']);
      const b = await body(request), key = request.headers.get('Idempotency-Key'), reason = text(b.reason, 300);
      assert(reason.length >= 3, 'Indicá el motivo de la modificación.');
      const requestHash = await hash(JSON.stringify({ action: 'amend', b }));
      const old = await one(db, 'SELECT client_id,request_hash FROM events WHERE id=?', key || '');
      if (old) { assert(old.client_id === client.id && old.request_hash === requestHash, 'Identificador de operación ya utilizado.', 409); return json({ ok: true, repeated: true }); }
      const target = await one(db, "SELECT * FROM events WHERE id=? AND client_id=? AND kind='charge'", String(b.event_id || ''), client.id);
      assert(target, 'Consumo no encontrado.', 404);
      assert(!await one(db, 'SELECT 1 AS x FROM event_voids WHERE target_event_id=?', target.id), 'Ese consumo ya fue anulado o modificado.', 409);
      const charge = await one(db, 'SELECT * FROM charges WHERE event_id=? AND client_id=?', target.id, client.id);
      assert(charge, 'No se encontró el consumo original.', 404);
      assert(charge.remaining === charge.quantity * charge.unit_price, 'El consumo ya tiene pagos aplicados. Anulá primero esos pagos.', 409);
      const next = await buildCharge(db, user, client, b);
      await commitAccount(db, client, user, key, 'amend', { target_id: target.id, reason, before: JSON.parse(target.data), after: next }, requestHash, [
        stmt(db, 'UPDATE charges SET remaining=0 WHERE id=? AND remaining=quantity*unit_price', charge.id),
        stmt(db, 'INSERT INTO charges VALUES (?,?,?,?,?,?,?,?,?)', next.id, client.id, next.product_id, next.description, next.quantity, next.unit_price, next.total, next.occurred_on, key),
        stmt(db, 'INSERT INTO event_voids VALUES (?,?,?,?,?)', target.id, key, reason, user.id, now())
      ]);
      return json({ ok: true });
    }
    role(user, ['superadmin','admin','operator']); assert(method === 'POST', 'Método no permitido.', 405);
    const b = await body(request), action = match[2], key = request.headers.get('Idempotency-Key');
    const requestHash = await hash(JSON.stringify({ action, b }));
    if (action !== 'quote') {
      const old = await one(db, 'SELECT client_id,request_hash FROM events WHERE id=?', key || '');
      if (old) { assert(old.client_id === client.id && old.request_hash === requestHash, 'Identificador de operación ya utilizado.', 409); return json({ ok: true, repeated: true }); }
    }
    if (action === 'charge') {
      const charge = await buildCharge(db, user, client, b);
      await commitAccount(db, client, user, key, 'charge', charge, requestHash, [stmt(db, 'INSERT INTO charges VALUES (?,?,?,?,?,?,?,?,?)', charge.id, client.id, charge.product_id, charge.description, charge.quantity, charge.unit_price, charge.total, charge.occurred_on, key)]);
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
    return json(await rows(db,`SELECT h.*,p.name AS product_name,u.name AS actor_name,s.name AS school_name FROM (SELECT id,product_id,price,actor,created_at,NULL AS school_id FROM price_history UNION ALL SELECT id,product_id,price,actor,created_at,school_id FROM school_price_history) h JOIN products p ON p.id=h.product_id JOIN users u ON u.id=h.actor LEFT JOIN schools s ON s.id=h.school_id WHERE (? IS NULL OR h.product_id=?) AND (?=1 OR h.school_id IS NULL OR h.school_id IN (SELECT value FROM json_each(?))) ORDER BY h.created_at DESC LIMIT ? OFFSET ?`,productId,productId,user.role==='superadmin'?1:0,user.school_ids,limit,offset));
  }
  if(path==='/api/categories'&&method==='POST'){
    role(user,['superadmin','admin']);const b=await body(request),name=text(b.name,80);assert(name,'Ingresá el nombre de la categoría.');
    try{await db.batch([stmt(db,'INSERT INTO categories(id,name,created_at) VALUES (?,?,?)',id(),name,now()),audit(db,user.id,'category.create',{name})]);}catch(e){if(/UNIQUE constraint/.test(e.message))assert(false,'Ya existe una categoría con ese nombre.',409);throw e;}
    return json({ok:true},201);
  }
  const categoryMatch=path.match(/^\/api\/categories\/([^/]+)$/);
  if(categoryMatch&&method==='PUT'){
    role(user,['superadmin','admin']);const b=await body(request),name=text(b.name,80);assert(name,'Ingresá el nombre de la categoría.');
    try{const result=await stmt(db,'UPDATE categories SET name=? WHERE id=?',name,categoryMatch[1]).run();assert(result.meta.changes,'Categoría no encontrada.',404);await db.batch([audit(db,user.id,'category.rename',{id:categoryMatch[1],name})]);}catch(e){if(/UNIQUE constraint/.test(e.message))assert(false,'Ya existe una categoría con ese nombre.',409);throw e;}
    return json({ok:true});
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
      stmt(db,`INSERT INTO price_history(id,product_id,price,actor,created_at) SELECT ? || ':' || json_extract(value,'$.id'),json_extract(value,'$.id'),json_extract(value,'$.price'),?,? FROM json_each(?)`,key,user.id,created,encoded),
      audit(db,user.id,'products.import',{created:plan.create,updated:plan.update,skipped:plan.skip})
    ]);return json({ok:true,created:plan.create,updated:plan.update,skipped:plan.skip});
  }
  if (path === '/api/products' && method === 'POST') {
    role(user, ['superadmin','admin']); const b = await body(request), price = cents(b.price), productId = id();
    assert(text(b.name) && price > 0, 'Completá nombre y precio.');
    const categoryId=text(b.category_id)||null;assert(!categoryId||await one(db,'SELECT id FROM categories WHERE id=?',categoryId),'Categoría no encontrada.');
    await catalogCommit(db,user,id(),'create',await catalogVersion(db),[stmt(db, 'INSERT INTO products(id,name,price,category_id) VALUES (?,?,?,?)', productId, text(b.name), price,categoryId), stmt(db, 'INSERT INTO price_history(id,product_id,price,actor,created_at) VALUES (?,?,?,?,?)', id(), productId, price, user.id, now())]);
    return json({ ok: true });
  }
  const schoolPriceMatch=path.match(/^\/api\/products\/([^/]+)\/school-price$/);
  if(schoolPriceMatch&&['POST','DELETE'].includes(method)){
    role(user,['superadmin','admin']);const productId=schoolPriceMatch[1],product=await one(db,'SELECT * FROM products WHERE id=?',productId);assert(product,'Producto no encontrado.',404);
    const b=method==='POST'?await body(request):{},schoolId=text(b.school_id||url.searchParams.get('school_id'));assert(['school-1','school-2','school-3'].includes(schoolId),'Colegio inválido.');scope(user,schoolId);
    const existing=await one(db,'SELECT price FROM product_school_prices WHERE product_id=? AND school_id=?',productId,schoolId);assert(method!=='DELETE'||existing,'No hay precio diferencial para restaurar.',404);
    const price=method==='POST'?cents(b.price):product.price;assert(method!=='POST'||price>0,'El precio debe ser mayor a cero.');
    const statements=method==='POST'?[stmt(db,'INSERT INTO product_school_prices(product_id,school_id,price,actor,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(product_id,school_id) DO UPDATE SET price=excluded.price,actor=excluded.actor,updated_at=excluded.updated_at',productId,schoolId,price,user.id,now())]:[stmt(db,'DELETE FROM product_school_prices WHERE product_id=? AND school_id=?',productId,schoolId)];
    statements.push(stmt(db,'INSERT INTO school_price_history(id,product_id,school_id,price,actor,created_at) VALUES (?,?,?,?,?,?)',id(),productId,schoolId,price,user.id,now()),audit(db,user.id,method==='POST'?'product.school_price.set':'product.school_price.reset',{product_id:productId,school_id:schoolId,price}));
    await catalogCommit(db,user,id(),JSON.stringify({productId,schoolId,method,price}),await catalogVersion(db),statements);return json({ok:true,price,school_id:schoolId});
  }
  if (/^\/api\/products\/[^/]+$/.test(path) && method === 'PUT') {
    role(user, ['superadmin','admin']); const b = await body(request), price = b.price==null?null:cents(b.price), productId = path.split('/').pop();
    assert(price===null||price>0,'Precio inválido.');
    const product = await one(db, 'SELECT * FROM products WHERE id=?', productId); assert(product, 'Producto no encontrado.', 404);
    const name=b.name==null?product.name:text(b.name,160),categoryId=b.category_id===undefined?product.category_id:(text(b.category_id)||null);assert(name,'Ingresá el nombre del producto.');assert(!categoryId||await one(db,'SELECT id FROM categories WHERE id=?',categoryId),'Categoría no encontrada.');
    const statements=[stmt(db,'UPDATE products SET name=?,category_id=?,price=COALESCE(?,price),version=version+1 WHERE id=?',name,categoryId,price,productId)];
    if(price!==null)statements.push(stmt(db,'INSERT INTO price_history(id,product_id,price,actor,created_at) VALUES (?,?,?,?,?)',id(),productId,price,user.id,now()));
    statements.push(audit(db,user.id,'product.update',{id:productId,name,category_id:categoryId,price}));
    await catalogCommit(db,user,id(),'update',await catalogVersion(db),statements);
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
