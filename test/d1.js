import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
export class D1 {
  constructor() { this.db = new DatabaseSync(':memory:'); for (const f of readdirSync(new URL('../migrations/', import.meta.url)).sort()) this.db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8')); }
  prepare(sql) {
    const db=this.db;
    return { bind(...args) { return { sql, args, first:async()=>db.prepare(sql).get(...args)||null, all:async()=>({results:db.prepare(sql).all(...args)}),run:async()=>({meta:db.prepare(sql).run(...args)}) }; } };
  }
  async batch(statements) { this.db.exec('BEGIN');try{const result=statements.map(s=>({meta:this.db.prepare(s.sql).run(...s.args)}));this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;} }
}
