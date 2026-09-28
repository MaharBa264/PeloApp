CREATE TABLE categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at TEXT NOT NULL
);

ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES categories(id);

ALTER TABLE clients ADD COLUMN profile_id TEXT;
UPDATE clients SET profile_id=id WHERE profile_id IS NULL OR profile_id='';
CREATE INDEX clients_profile ON clients(profile_id,school_id);

CREATE TABLE product_school_prices (
  product_id TEXT NOT NULL REFERENCES products(id),
  school_id TEXT NOT NULL REFERENCES schools(id),
  price INTEGER NOT NULL CHECK(price>0),
  actor TEXT NOT NULL REFERENCES users(id),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(product_id,school_id)
);

CREATE TABLE school_price_history (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  school_id TEXT NOT NULL REFERENCES schools(id),
  price INTEGER NOT NULL CHECK(price>0),
  actor TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX school_price_history_lookup ON school_price_history(product_id,school_id,created_at DESC);
