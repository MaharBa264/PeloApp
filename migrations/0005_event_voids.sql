CREATE TABLE event_voids (
  target_event_id TEXT PRIMARY KEY REFERENCES events(id),
  void_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  reason TEXT NOT NULL,
  actor TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);
