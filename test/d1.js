import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
export class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec(readFileSync(new URL('../migrations/0001_accounts.sql', import.meta.url),'utf8')); this.db.exec(readFileSync(new URL('../migrations/0002_management.sql', import.meta.url),'utf8')); this.db.exec(readFileSync(new URL('../migrations/0003_documents.sql', import.meta.url),'utf8')); this.db.exec(readFileSync(new URL('../migrations/0004_catalog_and_shared_clients.sql', import.meta.url),'utf8')); }
  prepare(sql) {
    const db=this.db;
    return { bind(...args) { return { sql, args, first:async()=>db.prepare(sql).get(...args)||null, all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:db.prepare(sql).run(...args)}) }; } };
  }
  async batch(statements) { this.db.exec('BEGIN');try{const result=statements.map(s=>({meta:this.db.prepare(s.sql).run(...s.args)}));this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;} }
}
