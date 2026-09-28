import { test } from 'node:test';
import assert from 'node:assert/strict';
import { D1 } from './d1.js';
import worker from '../src/worker.js';

class R2Mock {
  files = new Map();
  async put(key, value, options) { this.files.set(key, { value: new Uint8Array(value), type: options.httpMetadata.contentType }); }
  async get(key) { const value=this.files.get(key);return value?{body:new Blob([value.value]).stream(),httpMetadata:{contentType:value.type}}:null; }
  async delete(key) { this.files.delete(key); }
}

test('document photos are private review drafts and never change catalog or ledgers', async () => {
  const DB=new D1(), DOCUMENTS=new R2Mock();
  let aiCalls=0;
  const AI={async run(model,input){aiCalls++;assert.equal(model,'@cf/moondream/moondream3.1-9B-A2B');assert.equal(input.task,'query');return {answer:JSON.stringify({document_type:'invoice',supplier:'Proveedor Demo',document_number:'A-0001',document_date:'2026-09-27',total:'1250,00',notes:'',lines:[{code:'123',description:'Alfajor',quantity:'2',unit:'u',unit_price:'625,00',line_total:'1250,00'}]})};}};
  const env={DB,DOCUMENTS,AI,BOOTSTRAP_TOKEN:'test-token',APP_ENV:'development'};
  let cookie='',ip=1;
  async function req(path,method='GET',body,headers={}){const response=await worker.fetch(new Request('https://test.local/api'+path,{method,headers:{Origin:'https://test.local','Content-Type':'application/json',Cookie:cookie,'CF-Connecting-IP':String(ip++),...headers},body:body?JSON.stringify(body):undefined}),env);return {status:response.status,data:await response.json(),response};}
  await req('/setup','POST',{token:'test-token',name:'Super',email:'super@documents.test',password:'test-password-123'});
  let auth=await req('/login','POST',{email:'super@documents.test',password:'test-password-123'});cookie=auth.response.headers.get('set-cookie').split(';')[0];
  const image=new Uint8Array([0xff,0xd8,0xff,0x00,0x01]);
  async function upload(type='image/jpeg',bytes=image){const form=new FormData();form.set('file',new Blob([bytes],{type}),'sample.jpg');form.set('document_type','invoice');return worker.fetch(new Request('https://test.local/api/documents',{method:'POST',headers:{Origin:'https://test.local',Cookie:cookie,'CF-Connecting-IP':String(ip++)},body:form}),env);}
  let response=await upload();assert.equal(response.status,201);const created=await response.json();assert.equal(created.ai_status,'review');assert.equal(created.data.supplier,'Proveedor Demo');assert.equal(created.data.lines[0].description,'Alfajor');assert.equal(aiCalls,1);
  let list=await req('/documents');assert.equal(list.data.length,1);assert.equal(list.data[0].supplier,'Proveedor Demo');assert.equal('data' in list.data[0],false);
  response=await worker.fetch(new Request(`https://test.local/api/documents/${created.id}/image`,{headers:{Cookie:cookie,'CF-Connecting-IP':String(ip++)}}),env);assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/jpeg');assert.deepEqual(new Uint8Array(await response.arrayBuffer()),image);
  const edited={document_type:'invoice',supplier:'Proveedor Editado',document_number:'A-0001',document_date:'2026-09-27',total:'1250,00',notes:'Foto revisada',lines:created.data.lines};
  assert.equal((await req(`/documents/${created.id}`,'PUT',{data:edited})).status,200);
  list=await req('/documents');assert.equal(list.data[0].supplier,'Proveedor Editado');assert.equal(list.data[0].reviewed,1);
  let detail=await req(`/documents/${created.id}`);assert.equal(detail.data.data.lines[0].description,'Alfajor');assert.equal('file_key' in detail.data,false);
  assert.equal((await req(`/documents/${created.id}`,'PUT',{data:{...edited,document_date:'2026-02-31'}})).status,400);
  assert.equal((await req('/data')).data.products.length,0);
  assert.equal((await req('/documents','POST',{})).status,415);
  response=await upload('image/png',image);assert.equal(response.status,400);
  await req('/users','POST',{name:'Operador',email:'operator@documents.test',password:'test-password-123',role:'operator',school_ids:['school-1']});
  auth=await req('/login','POST',{email:'operator@documents.test',password:'test-password-123'});cookie=auth.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/documents')).status,403);
  await req('/login','POST',{email:'super@documents.test',password:'test-password-123'});auth=await req('/login','POST',{email:'super@documents.test',password:'test-password-123'});cookie=auth.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await req(`/documents/${created.id}`,'DELETE')).status,200);assert.equal(DOCUMENTS.files.size,0);assert.equal(aiCalls,1);
});

test('documents remain manually editable when Cloudflare AI is unavailable', async()=>{
  const DB=new D1(),DOCUMENTS=new R2Mock(),env={DB,DOCUMENTS,BOOTSTRAP_TOKEN:'test-token',APP_ENV:'development'};let ip=1;
  const request=async(path,method='GET',body,headers={})=>worker.fetch(new Request('https://test.local/api'+path,{method,headers:{Origin:'https://test.local','Content-Type':'application/json','CF-Connecting-IP':String(ip++),...headers},body:body?JSON.stringify(body):undefined}),env);
  await request('/setup','POST',{token:'test-token',name:'Super',email:'super@manual.test',password:'test-password-123'});
  const login=await request('/login','POST',{email:'super@manual.test',password:'test-password-123'}),cookie=login.headers.get('set-cookie').split(';')[0];
  const form=new FormData();form.set('file',new Blob([new Uint8Array([0xff,0xd8,0xff])],{type:'image/jpeg'}),'manual.jpg');form.set('document_type','delivery_note');
  const response=await worker.fetch(new Request('https://test.local/api/documents',{method:'POST',headers:{Origin:'https://test.local',Cookie:cookie},body:form}),env),doc=await response.json();
  assert.equal(response.status,201);assert.equal(doc.ai_status,'unavailable');assert.equal(doc.data.document_type,'delivery_note');
});
