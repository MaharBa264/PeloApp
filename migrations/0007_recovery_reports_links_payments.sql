ALTER TABLE clients ADD COLUMN debt_limit INTEGER CHECK(debt_limit IS NULL OR debt_limit>0);

CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX password_resets_user ON password_resets(user_id);

CREATE TABLE statement_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  client_id TEXT NOT NULL REFERENCES clients(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at TEXT
);
CREATE INDEX statement_links_client ON statement_links(client_id);

CREATE TABLE payment_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id),
  amount INTEGER NOT NULL CHECK(amount>0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','review','cancelled')),
  provider TEXT NOT NULL DEFAULT 'mercadopago',
  preference_id TEXT,
  provider_ref TEXT,
  checkout_url TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  paid_at TEXT,
  event_id TEXT REFERENCES events(id)
);
CREATE INDEX payment_requests_client ON payment_requests(client_id,status);
CREATE UNIQUE INDEX payment_requests_provider_ref ON payment_requests(provider,provider_ref) WHERE provider_ref IS NOT NULL;

INSERT INTO users(id,name,email,password,role,school_ids,active,created_at)
VALUES ('system-mercadopago','Mercado Pago (automático)','system-mercadopago@invalid','!disabled','viewer','[]',0,'2026-01-01T00:00:00.000Z');
