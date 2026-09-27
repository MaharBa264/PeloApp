import { D1 } from './d1.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { passwordHash } from '../src/worker.js';
import { cents, valueOf, settlement } from '../src/domain.js';


const line = { id:'line',description:'Alfajor', product_id:'p', remaining:300000,unit_price:100000,current_price:120000 };
test('money parsing, repricing, paid base and credit are conserved',()=>{
  assert.equal(cents('1,25'),125); assert.throws(()=>cents('1.234,56'));assert.throws(()=>cents('-5'));
  assert.equal(valueOf(line,'current'),360000);
  const first=settlement([line],120000,0,'current');assert.equal(first.allocations[0].base,100000);assert.equal(first.allocations[0].remaining,200000);assert.equal(first.allocations[0].adjustment,20000);
  const next={...line,remaining:200000,current_price:150000};assert.equal(valueOf(next,'current'),300000);
  const full=settlement([next],350000,0,'current');assert.equal(full.credit,50000);assert.equal(full.allocations[0].remaining,0);
  assert.equal(settlement([{...line,product_id:null}],310000,0,'current').credit,10000);
  assert.equal(settlement([line],0,400000,'original').credit,100000);
  assert.equal(settlement([],3000,5000,'original').credit,8000);
});
test('rounding never creates a negative balance; original payments cancel exactly',()=>{
  for(let remaining=1;remaining<300;remaining++){
    const result=settlement([{...line,remaining}],remaining,0,'original');assert.equal(result.allocations[0].remaining,0);assert.equal(result.credit,0);
  }
  assert.throws(()=>settlement([{...line,remaining:1,unit_price:1,current_price:100}],1,0,'current'));
});
test('real SQL integration: setup, roles, price changes, partial payment, idempotency and isolation', async()=>{
  const DB=new D1(),env={DB,BOOTSTRAP_TOKEN:'private-installation-token',APP_ENV:'development'};
  let cookie='',ip=1;
  async function call(path,method='GET',data,opts={}){
    const headers={Origin:'https://pelo.test','Content-Type':'application/json',Cookie:opts.cookie??cookie,'CF-Connecting-IP':opts.ip||String(ip++),...opts.headers};
    const response=await worker.fetch(new Request(`https://pelo.test/api${path}`,{method,headers,body:data?JSON.stringify(data):undefined}),env);
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')};
  }
  let r=await call('/status');assert.equal(r.data.initialized,false);
  r=await call('/setup','POST',{token:'wrong'});assert.equal(r.status,403);
  r=await call('/setup','POST',{token:env.BOOTSTRAP_TOKEN,name:'Admin',email:'admin@test.com',password:'long-password-test'});assert.equal(r.status,200);
  r=await call('/login','POST',{email:'admin@test.com',password:'long-password-test'});assert.equal(r.status,200);cookie=r.cookie.split(';')[0];const adminCookie=cookie;
  assert.match(r.cookie,/HttpOnly/);assert.match(r.cookie,/Secure/);
  assert.equal((await call('/setup','POST',{token:env.BOOTSTRAP_TOKEN})).status,409);
  await call('/products','POST',{name:'Alfajor',price:'1000'});
  r=await call('/data');assert.equal(r.status,200);const product=r.data.products[0];
  r=await call('/clients','POST',{name:'Familia Test',kind:'Familia',contact:'',school_id:'school-1',mode:'current'});assert.equal(r.status,201);const client=r.data.id;
  const chargeKey=crypto.randomUUID(),charge={product_id:product.id,quantity:3,unit_price:'1000',occurred_on:'2026-09-27'};
  r=await call(`/clients/${client}/charge`,'POST',charge,{headers:{'Idempotency-Key':chargeKey}});assert.equal(r.status,200,JSON.stringify(r.data));
  r=await call(`/clients/${client}/charge`,'POST',charge,{headers:{'Idempotency-Key':chargeKey}});assert.equal(r.data.repeated,true);
  assert.equal((await call(`/clients/${client}`)).data.lines.length,1);
  await call(`/products/${product.id}`,'PUT',{price:'1200'});
  const pay={amount:'1200',method:'Efectivo',note:''};r=await call(`/clients/${client}/quote`,'POST',pay);assert.equal(r.status,200);const stale=r.data.fingerprint;
  await call(`/products/${product.id}`,'PUT',{price:'1500'});
  r=await call(`/clients/${client}/payment`,'POST',{...pay,fingerprint:stale},{headers:{'Idempotency-Key':crypto.randomUUID()}});assert.equal(r.status,409);
  await call(`/products/${product.id}`,'PUT',{price:'1200'});
  r=await call(`/clients/${client}/quote`,'POST',pay);const finalPay={...pay,fingerprint:r.data.fingerprint},payKey=crypto.randomUUID();
  r=await call(`/clients/${client}/payment`,'POST',finalPay,{headers:{'Idempotency-Key':payKey}});assert.equal(r.status,200,JSON.stringify(r.data));
  r=await call(`/clients/${client}/payment`,'POST',finalPay,{headers:{'Idempotency-Key':payKey}});assert.equal(r.data.repeated,true);
  r=await call(`/clients/${client}`);assert.equal(r.data.lines[0].remaining,200000);assert.equal(r.data.events.length,2);assert.equal(r.data.events[0].data.allocations[0].adjustment,20000);
  // Reject reuse of a successful operation key with different data.
  assert.equal((await call(`/clients/${client}/payment`,'POST',{...finalPay,amount:'99'},{headers:{'Idempotency-Key':payKey}})).status,409);
  // Two concurrent charges read the same account version: at most one is committed.
  const concurrency=await Promise.all([call(`/clients/${client}/charge`,'POST',charge,{headers:{'Idempotency-Key':crypto.randomUUID()}}),call(`/clients/${client}/charge`,'POST',charge,{headers:{'Idempotency-Key':crypto.randomUUID()}})]);
  assert.deepEqual(concurrency.map(r=>r.status).sort(),[200,409]);
  assert.equal((await call(`/clients/${client}`)).data.lines.length,2);
  // Account pending totals and details agree.
  const summary=(await call('/data')).data.clients[0],details=(await call(`/clients/${client}`)).data;
  assert.equal(summary.current_due,details.lines.reduce((s,l)=>s+l.current_value,0));
  const overpay={amount:'10000',method:'Transferencia'};r=await call(`/clients/${client}/quote`,'POST',overpay);
  assert.equal((await call(`/clients/${client}/payment`,'POST',{...overpay,fingerprint:r.data.fingerprint},{headers:{'Idempotency-Key':crypto.randomUUID()}})).status,200);
  r=await call(`/clients/${client}`);assert.equal(r.data.lines.length,0);assert.equal(r.data.client.credit,400000);
  await call('/users','POST',{name:'Operator',email:'operator@test.com',password:'long-password-test',role:'operator',school_ids:['school-2']});
  r=await call('/login','POST',{email:'operator@test.com',password:'long-password-test'});cookie=r.cookie.split(';')[0];
  assert.equal((await call(`/clients/${client}`)).status,403);assert.equal((await call('/data')).data.clients.length,0);
  assert.equal((await call('/products','POST',{name:'Forbidden',price:'5'})).status,403);
  assert.equal((await call('/users')).status,403);
  assert.equal((await call('/clients','POST',{name:'Cross school',kind:'Otro',school_id:'school-1',mode:'original'})).status,403);
  assert.equal((await call('/logout','POST',{}, {headers:{Origin:'https://evil.test'}})).status,403);
  cookie=adminCookie;
  await call('/users','POST',{name:'Viewer',email:'viewer@test.com',password:'long-password-test',role:'viewer',school_ids:['school-1']});
  r=await call('/login','POST',{email:'viewer@test.com',password:'long-password-test'});cookie=r.cookie.split(';')[0];
  assert.equal((await call(`/clients/${client}`)).status,200);
  assert.equal((await call(`/clients/${client}/charge`,'POST',charge)).status,403);
  cookie=adminCookie;
  const users=(await call('/users')).data,viewer=users.find(u=>u.role==='viewer');
  assert.equal((await call(`/users/${viewer.id}`,'PUT',{active:false})).status,200);
  assert.equal((await call('/login','POST',{email:'viewer@test.com',password:'long-password-test'})).status,401);
  const settings={name:'Mi Buffet',color:'#2255aa',font:'system',logo:'',footer:'Gracias',schools:[1,2,3].map(n=>({id:`school-${n}`,name:`Colegio ${n}`}))};
  assert.equal((await call('/settings','PUT',settings)).status,200);
  assert.equal((await call('/settings','PUT',{...settings,logo:'javascript:alert(1)'})).status,400);
  const response=await worker.fetch(new Request('https://pelo.test/api/status'),env);assert.match(response.headers.get('Content-Security-Policy'),/frame-ancestors 'none'/);
});
test('D1 batch rollback protects against half-written financial movements',async()=>{
  const db=new D1();await assert.rejects(db.batch([db.prepare('INSERT INTO schools VALUES (?,?)').bind('x','X'),db.prepare('INSERT INTO schools VALUES (?,?)').bind('x','Duplicate')]));
  assert.equal(await db.prepare('SELECT * FROM schools WHERE id=?').bind('x').first(),null);
});
