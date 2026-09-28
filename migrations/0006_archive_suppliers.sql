ALTER TABLE products ADD COLUMN archived_at TEXT;

CREATE TABLE suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

ALTER TABLE products ADD COLUMN supplier_id TEXT REFERENCES suppliers(id);
CREATE INDEX products_supplier ON products(supplier_id);
CREATE INDEX price_history_product ON price_history(product_id,created_at);
CREATE INDEX audit_created ON audit(created_at DESC);
