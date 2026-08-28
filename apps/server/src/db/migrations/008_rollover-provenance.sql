-- 008_rollover-provenance — candidate-specific rolling recovery evidence (T52).
--
-- A same-stream historical row, timestamp, title, or merely having an older open
-- row cannot prove that a newer attempt is its replacement. The direct predecessor
-- id is therefore written on the replacement before any YouTube mutation. It is
-- deliberately not a foreign key: retention deletes broadcast rows in bounded
-- batches, and a dangling link must be surfaced as an ambiguous safe-stop rather
-- than making the scheduled privacy sweep fail.
ALTER TABLE broadcast_resources
  ADD COLUMN rollover_predecessor_attempt_id TEXT;

-- The value is evidence from a successful API response or an exact-id read-back.
-- It lets recovery distinguish "configured visibility already applied" from
-- "visibility still pending" without replaying a quota-bearing update.
ALTER TABLE broadcast_resources
  ADD COLUMN privacy_status TEXT
    CHECK (privacy_status IS NULL OR privacy_status IN ('private', 'unlisted', 'public'));

ALTER TABLE broadcast_resources
  ADD COLUMN privacy_status_observed_at TEXT;

-- One predecessor cannot legitimately own two open replacement candidates. A
-- conclusively failed candidate keeps its provenance after closure, but must not
-- reserve the predecessor forever: a later operator-approved/restarted attempt
-- needs to be able to create a fresh, independently evidenced replacement.
CREATE UNIQUE INDEX broadcast_resources_rollover_predecessor
  ON broadcast_resources (rollover_predecessor_attempt_id)
  WHERE rollover_predecessor_attempt_id IS NOT NULL AND closed_at IS NULL;

-- Visibility evidence is either absent as a whole or complete as a whole.
CREATE TRIGGER broadcast_resources_visibility_evidence_insert
BEFORE INSERT ON broadcast_resources
WHEN (NEW.privacy_status IS NULL) <> (NEW.privacy_status_observed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'broadcast visibility evidence must be complete');
END;

CREATE TRIGGER broadcast_resources_visibility_evidence_update
BEFORE UPDATE OF privacy_status, privacy_status_observed_at ON broadcast_resources
WHEN (NEW.privacy_status IS NULL) <> (NEW.privacy_status_observed_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'broadcast visibility evidence must be complete');
END;
