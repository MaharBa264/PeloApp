import {test} from 'node:test';
import assert from 'node:assert/strict';
import {D1} from './d1.js';
import worker from '../src/worker.js';

test('categories, school prices and shared clients keep each school ledger independent',async()=>{
  const DB=new D1(),env={DB,BOOTSTRAP_TOKEN:'test-token',APP_ENV:'development'};let cookie='';
  async function req(path,method='GET',body,extra={}){
    const r=await worker.fetch(new Request(`https://test.local/api${path}`,{method,headers:{Origin:'https://test.local','Content-Type':'application/json',Cookie:cookie,...extra},body:body===undefined?undefined:JSON.stringify(body)}),env);
    return {status:r.status,data:await r.json(),cookie:r.headers.get('set-cookie')};
  }
  await req('/setup','POST',{token:'test-token',name:'Super',email:'super@test.com',password:'long-password-test'});
  const login=await req('/login','POST',{email:'super@test.com',password:'long-password-test'});cookie=login.cookie.split(';')[0];
  let r=await req('/categories','POST',{name:'Bebidas'});assert.equal(r.status,201);
  assert.equal((await req('/categories','POST',{name:'bebidas'})).status,409);
  const category=(await req('/data')).data.categories[0];
  assert.equal((await req('/products','POST',{name:'Agua',price:'1000',category_id:category.id})).status,200);
  let data=(await req('/data')).data;const product=data.products[0];assert.equal(product.category_name,'Bebidas');
  assert.equal((await req(`/categories/${category.id}`,'PUT',{name:'Bebidas frías'})).status,200);
  assert.equal((await req('/data')).data.products[0].category_name,'Bebidas frías');
  assert.equal((await req(`/products/${product.id}/school-price`,'POST',{school_id:'school-1',price:'1200'})).status,200);

  r=await req('/clients','POST',{name:'Familia compartida',kind:'Familia',contact:'familia@test.com',school_ids:['school-1','school-2'],mode:'current'});
  assert.equal(r.status,201);assert.equal(r.data.accounts.length,2);
  const [a1,a2]=r.data.accounts;
  assert.notEqual(a1.id,a2.id);assert.equal(a1.school_id,'school-1');assert.equal(a2.school_id,'school-2');
  for(const account of [a1,a2]) assert.equal((await req(`/clients/${account.id}/charge`,'POST',{product_id:product.id,quantity:2,occurred_on:'2026-09-28'},{'Idempotency-Key':crypto.randomUUID()})).status,200);
  let d1=(await req(`/clients/${a1.id}`)).data,d2=(await req(`/clients/${a2.id}`)).data;
  assert.equal(d1.lines[0].unit_price,120000);assert.equal(d2.lines[0].unit_price,100000);
  assert.notEqual(d1.client.profile_id,d1.client.school_id);assert.equal(d1.client.profile_id,d2.client.profile_id);

  assert.equal((await req(`/products/${product.id}`,'PUT',{price:'1100'})).status,200);
  data=(await req('/data')).data;
  const account1=data.clients.find(c=>c.id===a1.id),account2=data.clients.find(c=>c.id===a2.id);
  assert.equal(account1.current_due,240000);assert.equal(account2.current_due,220000);
  d1=(await req(`/clients/${a1.id}`)).data;assert.equal(d1.lines[0].unit_price,120000);

  assert.equal((await req(`/clients/${a1.id}/schools`,'POST',{school_ids:['school-3']})).status,201);
  data=(await req('/data')).data;const accounts=data.clients.filter(c=>c.profile_id===d1.client.profile_id);
  assert.equal(accounts.length,3);assert.equal(new Set(accounts.map(c=>c.school_id)).size,3);
  assert.equal(accounts.reduce((sum,c)=>sum+c.original_due,0),440000);
  const history=(await req(`/products/history?product=${product.id}`)).data;
  assert.ok(history.some(h=>h.school_id==='school-1'&&h.price===120000));
  assert.ok(history.some(h=>h.school_id===null&&h.price===110000));
});
