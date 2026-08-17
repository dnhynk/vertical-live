-- 005_inbox-argument-rejected — the storage-boundary rejection marker (T8).
--
-- `command.argument` is dropped before the row is written when the token is
-- outside the content's choice vocabulary, so the original never reaches the
-- database (spec §12.3, TASK_SPECS §T8). That left no trace at all: the writer
-- later saw `argument: null` and recorded the row as plainly `applied`, which
-- is the same record an ordinary argument-less command produces (R-T8-2
-- blocker 2).
--
-- This column is that trace. It is a flag and nothing else — it says *that* a
-- token was refused, never which one — and it lives on the inbox row so it is
-- written in the same transaction as the envelope it describes and survives a
-- restart, which a batch-local counter could not.
ALTER TABLE ingest_inbox
  ADD COLUMN argument_rejected INTEGER NOT NULL DEFAULT 0 CHECK (argument_rejected IN (0, 1));
