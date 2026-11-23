-- Sync mailbox: append-only events per user (docs/design.md, "Sync").
CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- server order, used as cursor
  user_code  TEXT NOT NULL,
  event_id   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  body       TEXT NOT NULL,                     -- full event JSON
  UNIQUE (user_code, event_id)
);
CREATE INDEX events_user_seq ON events (user_code, seq);
