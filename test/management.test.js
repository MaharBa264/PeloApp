import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './d1.js';
import worker from '../src/worker.js';
import {planImport,importPrice} from '../src/import-products.js';
test('Excel mapping: Argentine prices, duplicates, missing values and opt-in updates',()=>{
 assert.equal(importPrice('1.234,50'),123450);assert.equal(importPrice('$ 1.200'),120000);assert.equal(importPrice(1200.5),120050);assert.throws(()=>importPrice('1,234.50'));assert.throws(()=>importPrice(''));
 const products=[{id:'a',name:'Alfajor',price:100000,version:0}];
 const input=[{name:' ALFAJOR ',price:1200},{name:'Galletitas',price:'850,50'}];
 assert.equal(planImport(input,products).skip,1);assert.equal(planImport(input,products,true).update,1);
 assert.equal(planImport([...input,{name:'galletitas',price:900}],products).errors.length,1);
 assert.equal(planImport([{name:'',price:3},{name:'Jugo',price:-1}],[]).errors.length,2);
});
test('management and imports preserve ledgers, roles, prices and atomicity',async()=>{
 const DB=new D1(),env={DB,BOOTSTRAP_TOKEN:'test-token',APP_ENV:'development'};let cookie='',ip=100;
 async function req(path,method='GET',body,extra={}){const r=await worker.fetch(new Request('https://test.local/api'+path,{method,headers:{Origin:'https://test.local','Content-Type':'application/json',Cookie:cookie,'CF-Connecting-IP':String(ip++),...extra},body:body?JSON.stringify(body):undefined}),env);return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')};}
 async function login(email){const r=await req('/login','POST',{email,password:'test-password-123'});assert.equal(r.status,200);cookie=r.cookie.split(';')[0];}
 await req('/setup','POST',{token:'test-token',name:'Super',email:'super@test.com',password:'test-password-123'});await login('super@test.com');const superCookie=cookie;
 const input={rows:[{name:'Alfajor',price:1000},{name:'Agua',price:'750,50'}],update_existing:false};
 let r=await req('/products/import','POST',input);assert.equal(r.data.create,2);
 const commit={...input,confirm:true,fingerprint:r.data.fingerprint},key=crypto.randomUUID();
 r=await req('/products/import','POST',commit,{'Idempotency-Key':key});assert.equal(r.status,200,JSON.stringify(r.data));
 r=await req('/products/import','POST',commit,{'Idempotency-Key':key});assert.equal(r.data.repeated,true);
 let products=(await req('/data')).data.products;assert.equal(products.length,2);const product=products.find(p=>p.name==='Alfajor');
 assert.equal((await req('/products/history')).data.length,2);
 r=await req('/clients','POST',{name:'Cliente',kind:'Familia',contact:'',school_id:'school-1',mode:'current'});const client=r.data.id;
 await req(`/clients/${client}/charge`,'POST',{product_id:product.id,quantity:2,unit_price:'1000',occurred_on:'2026-09-27'},{'Idempotency-Key':crypto.randomUUID()});
 const pay={amount:'500',method:'Efectivo'};const quote=(await req(`/clients/${client}/quote`,'POST',pay)).data;
 r=await req(`/clients/${client}`);const version=r.data.client.version;
 r=await req(`/clients/${client}`,'PUT',{name:'Familia Editada',kind:'Familia',contact:'Contact',notes:'Alumno: Juan',mode:'original',version},{'Idempotency-Key':crypto.randomUUID()});assert.equal(r.status,200);
 r=await req(`/clients/${client}`);assert.equal(r.data.client.name,'Familia Editada');assert.equal(r.data.lines[0].remaining,200000);assert.equal(r.data.events.length,2);assert.equal(r.data.events[0].kind,'profile');
 assert.equal((await req(`/clients/${client}/payment`,'POST',{...pay,fingerprint:quote.fingerprint},{'Idempotency-Key':crypto.randomUUID()})).status,409);
 // Explicitly enable existing-price updates; the new price must produce a history row.
 const update={rows:[{name:'Alfajor',price:1200},{name:'Jugo',price:500}],update_existing:true};r=await req('/products/import','POST',update);assert.equal(r.data.update,1);
 const updateCommit={...update,confirm:true,fingerprint:r.data.fingerprint};r=await req('/products/import','POST',updateCommit,{'Idempotency-Key':crypto.randomUUID()});assert.equal(r.status,200,JSON.stringify(r.data));
 assert.equal((await req('/products/history?product='+product.id)).data.length,2);
 r=await req(`/clients/${client}`);assert.equal(r.data.lines[0].unit_price,100000);assert.equal(r.data.lines[0].current_value,240000);
 // A preview is invalidated by another price edit.
 r=await req('/products/import','POST',update);const stale=r.data.fingerprint;
 await req(`/products/${product.id}`,'PUT',{price:'1300'});
 assert.equal((await req('/products/import','POST',{...update,confirm:true,fingerprint:stale},{'Idempotency-Key':crypto.randomUUID()})).status,409);
 const invalid={rows:[{name:'Must not exist',price:100},{name:'Bad',price:0}],update_existing:false};r=await req('/products/import','POST',invalid);assert.equal(r.data.errors.length,1);
 assert.equal((await req('/products/import','POST',{...invalid,confirm:true,fingerprint:r.data.fingerprint},{'Idempotency-Key':crypto.randomUUID()})).status,400);
 assert.equal((await req('/data')).data.products.some(p=>p.name==='Must not exist'),false);
 // Rename schools and assign identity without changing school IDs / account relations.
 const settings={name:'Buffet',color:'#315ded',font:'system',logo:'',footer:'',schools:[1,2,3].map(n=>({id:'school-'+n,name:'Instituto '+n,logo:'',color:'#227755'}))};
 assert.equal((await req('/settings','PUT',settings)).status,200);
 assert.equal((await req('/data')).data.clients[0].school_name,'Instituto 1');
 // Administrator manages only operator/viewer accounts wholly within assigned schools.
 await req('/users','POST',{name:'Admin',email:'admin@test.com',password:'test-password-123',role:'admin',school_ids:['school-1']});
 await req('/users','POST',{name:'Other',email:'other@test.com',password:'test-password-123',role:'operator',school_ids:['school-2']});
 const other=(await req('/users')).data.find(u=>u.email==='other@test.com');
 await login('admin@test.com');
 assert.equal((await req('/users','POST',{name:'Operator',email:'operator@test.com',password:'test-password-123',role:'operator',school_ids:['school-1']})).status,200);
 assert.equal((await req('/users','POST',{name:'Escalation',email:'evil@test.com',password:'test-password-123',role:'superadmin',school_ids:[]})).status,403);
 assert.equal((await req(`/users/${other.id}`,'PUT',{name:'Not allowed'})).status,403);
 let operator=(await req('/users')).data[0];assert.equal(operator.email,'operator@test.com');
 assert.equal((await req(`/users/${operator.id}`,'PUT',{role:'viewer',name:'Updated operator',school_ids:['school-1']})).status,200);
 assert.equal((await req(`/users/${operator.id}`,'PUT',{school_ids:['school-2']})).status,403);
 await login('operator@test.com');assert.equal((await req('/products/import','POST',input)).status,403);
 cookie=superCookie;
 // Reset password, preserve other fields, invalidate existing sessions.
 assert.equal((await req(`/users/${operator.id}`,'PUT',{password:'replacement-password-123'})).status,200);
 assert.equal((await req('/login','POST',{email:'operator@test.com',password:'test-password-123'})).status,401);
});
