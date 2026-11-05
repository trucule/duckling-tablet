-- A device whose family was deleted keeps a tombstone so its next check-in is told to release the tablet.
CREATE TABLE device_tombstone (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
