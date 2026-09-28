CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  document_type TEXT NOT NULL CHECK(document_type IN ('invoice','delivery_note','order','other')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft')),
  supplier TEXT NOT NULL DEFAULT '',
  document_number TEXT NOT NULL DEFAULT '',
  document_date TEXT NOT NULL DEFAULT '',
  related_document_id TEXT REFERENCES documents(id),
  file_key TEXT NOT NULL,
  file_type TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size > 0),
  ai_status TEXT NOT NULL CHECK(ai_status IN ('review','unavailable','error')),
  reviewed INTEGER NOT NULL DEFAULT 0 CHECK(reviewed IN (0,1)),
  reviewed_at TEXT,
  data TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX documents_created ON documents(created_at DESC);
CREATE INDEX documents_supplier_number ON documents(supplier, document_number);
