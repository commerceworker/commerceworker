-- Bulk import jobs: a CSV an admin uploaded (kept in the documents bucket at `source_key`), read
-- and applied a chunk at a time by the engine's import Workflow. `offset` and `next_row` are where
-- reading continues; a chunk's progress is added only while the job is still at the offset it
-- began at, so a retried step adds nothing twice. `errors` holds the first refused rows as JSON
-- ([{ row, error }], at most 100); the full list is the report at `report_key`.
--
-- Expand only: a new table nothing deployed reads.
CREATE TABLE bulk_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  check_only INTEGER NOT NULL DEFAULT 0,
  file_name TEXT NOT NULL,
  source_key TEXT NOT NULL,
  report_key TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  header TEXT NOT NULL DEFAULT '[]',
  offset INTEGER NOT NULL DEFAULT 0,
  next_row INTEGER NOT NULL DEFAULT 1,
  applied INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  errors TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX bulk_jobs_created ON bulk_jobs(created_at);
