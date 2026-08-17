-- 002_retention-ledger — the append-only retention audit trail (spec §12.4).
--
-- 001 created `retention_ledger` as an explicitly labelled skeleton ("T13 fills
-- and enforces this when it automates retention, deletion and revocation") with
-- one row per (field_key, source, purpose). That shape can only hold the *last*
-- deletion instant, and spec §12.4 asks for the record that each deletion and
-- each re-verification actually ran: "각 field의 source, 목적, 허용 기간, 삭제
-- 시각을 기록하고 자동 삭제·철회 test를 Gate 2에 포함한다". An audit trail that
-- overwrites itself cannot answer "did the 30-day sweep run last month", so the
-- table is rebuilt here as append-only.
--
-- Dropping is safe rather than lossy: nothing has ever written this table (T13
-- is its first writer) and R-T4-2 confirmed no operational database exists yet.
-- The rebuild is a new migration rather than an edit to 001, because 001 is
-- already recorded with a checksum and the runner refuses an edited file.
--
-- The table deliberately has no free-text column and no column for a user name,
-- channel id or hash. A deletion request must be recordable without storing
-- anything about the person who made it — otherwise the audit record would
-- itself breach the rule it exists to prove (spec §12.4, §7.4, BOARD A-1).
DROP TABLE retention_ledger;

CREATE TABLE retention_ledger (
  -- AUTOINCREMENT, not plain rowid: an audit row id must never be reused after
  -- an old ledger segment is archived (https://sqlite.org/autoinc.html).
  entry_id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- `fields[].key` of config/retention.json, or `request.user_data` for a user
  -- deletion request. The config is the authority for what each key covers.
  field_key           TEXT    NOT NULL,
  source              TEXT    NOT NULL CHECK (source IN ('youtube_api', 'simulator', 'internal')),
  purpose             TEXT    NOT NULL,
  policy              TEXT    NOT NULL CHECK (policy IN ('delete', 'refresh')),
  -- Why this row was written. Spec §12.4 lists the obligations separately and
  -- gives them different windows, so the reason is part of the evidence.
  reason              TEXT    NOT NULL CHECK (reason IN (
                        'scheduled', 'consent_revoked', 'provider_revoked', 'user_request')),
  -- 허용 기간 (spec §12.4): the period this obligation allowed, in days. For a
  -- scheduled sweep it is the field's retention (or re-verification) period; for
  -- a revocation or a user request it is the policy window for completing the
  -- deletion (7 or 30 days).
  allowed_period_days INTEGER NOT NULL CHECK (allowed_period_days > 0),
  -- Scheduled runs only: data older than this instant was no longer allowed to
  -- be retained, i.e. `recorded_at - allowed_period_days`. Makes "nothing
  -- survived past its own deadline" checkable from the ledger alone.
  cutoff_at           TEXT,
  -- Revocation and user-request runs only: the absolute deadline the policy gave
  -- for completing the deletion, i.e. trigger instant + allowed_period_days.
  deadline_at         TEXT,
  outcome             TEXT    NOT NULL CHECK (outcome IN (
                        'deleted',
                        'nothing_expired',
                        'reverified',
                        'reverification_due',
                        'table_absent',
                        'no_stored_identifiers',
                        'failed')),
  rows_deleted        INTEGER NOT NULL DEFAULT 0 CHECK (rows_deleted >= 0),
  -- How many of the deleted inbox rows had no processing record yet. Never
  -- silently dropped: spec §9.2 forbids unreported loss, so the count travels
  -- with the audit row and T12 can alert on it.
  rows_unprocessed    INTEGER NOT NULL DEFAULT 0 CHECK (rows_unprocessed >= 0),
  -- When the deletion actually ran. NULL when this row records a check that
  -- deleted nothing, so `deleted_at IS NOT NULL` means data really went.
  deleted_at          TEXT,
  recorded_at         TEXT    NOT NULL,
  -- `deleted` is the only outcome that may claim rows and a deletion instant,
  -- and it must claim both — otherwise the count and the evidence disagree.
  CHECK (
    (outcome = 'deleted' AND rows_deleted > 0 AND deleted_at IS NOT NULL)
    OR
    (outcome <> 'deleted' AND rows_deleted = 0 AND deleted_at IS NULL)
  ),
  CHECK (rows_unprocessed <= rows_deleted),
  -- A scheduled run has a cutoff and no deadline; a triggered one has a deadline
  -- and no cutoff (it deletes the authorized data regardless of age).
  CHECK (
    (reason = 'scheduled' AND cutoff_at IS NOT NULL AND deadline_at IS NULL)
    OR
    (reason <> 'scheduled' AND cutoff_at IS NULL AND deadline_at IS NOT NULL)
  )
) STRICT;

-- "What happened to this field, most recent first" — the query an audit answers.
CREATE INDEX retention_ledger_field_recorded
  ON retention_ledger (field_key, recorded_at);

-- "Did every triggered obligation complete before its deadline?" across fields.
CREATE INDEX retention_ledger_reason_recorded
  ON retention_ledger (reason, recorded_at);
