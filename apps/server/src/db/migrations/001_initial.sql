-- 001_initial — the authoritative persistence schema (spec §10.2).
--
-- Every table is STRICT so a column can never silently hold another type
-- (SQLite >= 3.37, https://sqlite.org/stricttables.html). Persisted instants are
-- absolute UTC ISO 8601 TEXT; elapsed intervals are never stored, they are
-- measured with a monotonic clock at runtime (spec §10.2).
--
-- No table has a column for an author, a display name, a channel id or raw
-- message text: while the identity feature gate is closed those values must not
-- be storable at all (spec §7.3(1), §7.4, §12.4, BOARD A-1).

-- Append-only policy-filtered ingest inbox (spec §7.3(1)(2)(3)).
--
-- AUTOINCREMENT, not plain rowid: `ingest_seq` is the total order the single
-- writer replays and `processedIngestSeq` compares against, so a value must
-- never be reused after T13 deletes expired rows.
CREATE TABLE ingest_inbox (
  ingest_seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  -- NULL when the API item carried no usable id: the gap is recorded instead of
  -- inventing one (spec §7.3(1)).
  message_id           TEXT,
  source               TEXT    NOT NULL CHECK (source IN ('youtube', 'simulator')),
  source_shape         TEXT    NOT NULL CHECK (source_shape IN ('grpc', 'rest', 'simulator')),
  broadcast_id         TEXT    NOT NULL,
  live_chat_id         TEXT    NOT NULL,
  received_at          TEXT    NOT NULL,
  validation_status    TEXT    NOT NULL CHECK (validation_status IN ('valid', 'unsupported', 'invalid')),
  -- Gift dedupe granularity: `effectiveCount = comboCount > 0 ? comboCount : 1`
  -- is part of the event key, so each combo step is its own inbox row
  -- (spec §7.4). 0 means "not a gift" and keeps the unique index NOT NULL.
  gift_effective_count INTEGER NOT NULL DEFAULT 0 CHECK (gift_effective_count >= 0),
  envelope_json        TEXT    NOT NULL,
  processed_at         TEXT,
  processing_result    TEXT
) STRICT;

-- The idempotency unit of the inbox, at event-key granularity (spec §7.3(4)).
-- SQLite treats NULLs as distinct in a unique index, so items with no
-- `message_id` are never deduplicated — which is correct: two malformed items
-- without ids are two observations, not one.
CREATE UNIQUE INDEX ingest_inbox_identity
  ON ingest_inbox (source, broadcast_id, message_id, gift_effective_count);

-- Recovery drain: `WHERE ingest_seq > ? AND processed_at IS NULL` (spec §7.3(3)).
CREATE INDEX ingest_inbox_unprocessed
  ON ingest_inbox (ingest_seq)
  WHERE processed_at IS NULL;

-- Reconnect token checkpoint, committed with the envelopes it covers (spec §7.3(2)).
CREATE TABLE source_checkpoint (
  source_key      TEXT    PRIMARY KEY,
  live_chat_id    TEXT    NOT NULL,
  next_page_token TEXT,
  last_ingest_seq INTEGER NOT NULL DEFAULT 0 CHECK (last_ingest_seq >= 0),
  updated_at      TEXT    NOT NULL
) STRICT;

-- Current authoritative snapshot. V1 runs one supervised host and one world
-- (spec §10.2); `world_id` is the primary key TASK_SPECS §T4 fixes, so a second
-- world is a data change rather than a schema change.
CREATE TABLE world_snapshot (
  world_id             TEXT    PRIMARY KEY,
  state_revision       INTEGER NOT NULL CHECK (state_revision >= 0),
  processed_ingest_seq INTEGER NOT NULL CHECK (processed_ingest_seq >= 0),
  snapshot_json        TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL
) STRICT;

-- Audit trail of committed transitions (spec §7.3(5), §9.4(2)).
CREATE TABLE state_transitions (
  revision            INTEGER PRIMARY KEY CHECK (revision >= 0),
  -- NULL for a timer/system transition that no external event caused.
  caused_by_event_key TEXT,
  kind                TEXT    NOT NULL,
  at                  TEXT    NOT NULL
) STRICT;

-- Absolute UTC deadlines with the per-kind downtime policy (spec §10.2).
CREATE TABLE deadlines (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  due_at       TEXT NOT NULL,
  policy       TEXT NOT NULL CHECK (policy IN ('replay', 'coalesce', 'skip')),
  payload_json TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'fired', 'expired', 'cancelled'))
) STRICT;

CREATE INDEX deadlines_pending_due ON deadlines (due_at) WHERE status = 'pending';

-- Durable effect outbox for side effects that cannot be regenerated, i.e. paid
-- audit staging (spec §7.3(6)(7), §10.2). `state_revision` is stored because the
-- renderer contract carries it and the effect is rebuilt from this row on restart.
--
-- The cause is stored as its discriminator plus the members of that branch
-- (BOARD A-17): content keeps moving with zero viewers (spec §2.1, §6.2), so a
-- timer-caused effect has no event to point at and `caused_by_event_key` is NULL
-- for exactly those rows. The CHECK constraints below are the same two rules the
-- `EffectCause` contract enforces, so a row that disagrees cannot be written even
-- by a caller that skipped validation.
CREATE TABLE effect_outbox (
  effect_id           TEXT    PRIMARY KEY,
  cause_kind          TEXT    NOT NULL CHECK (cause_kind IN ('event', 'deadline')),
  caused_by_event_key TEXT,
  cause_deadline_kind TEXT,
  cause_deadline_id   TEXT,
  kind                TEXT    NOT NULL,
  paid                INTEGER NOT NULL CHECK (paid IN (0, 1)),
  state_revision      INTEGER NOT NULL CHECK (state_revision >= 0),
  starts_at           TEXT    NOT NULL,
  ends_at             TEXT    NOT NULL,
  payload_json        TEXT    NOT NULL,
  published_at        TEXT,
  acked_at            TEXT,
  expired_at          TEXT,
  CHECK (
    (cause_kind = 'event'
       AND caused_by_event_key IS NOT NULL
       AND cause_deadline_kind IS NULL
       AND cause_deadline_id IS NULL)
    OR
    (cause_kind = 'deadline'
       AND caused_by_event_key IS NULL
       AND cause_deadline_kind IS NOT NULL)
  ),
  -- A paid effect is a durable audit row and spec §10.2 requires it to carry the
  -- causing event key; a timer never owes anyone thanks (spec §8.4).
  CHECK (paid = 0 OR cause_kind = 'event')
) STRICT;

-- Restart republish set: committed but neither acked nor expired (spec §7.3(7)).
CREATE INDEX effect_outbox_open
  ON effect_outbox (state_revision, effect_id)
  WHERE acked_at IS NULL AND expired_at IS NULL;

-- Paid audit ledger. The primary key is the canonical event key, which is what
-- makes "the same Super Chat is applied once" a schema guarantee rather than a
-- code convention (spec §7.4, §11 유료 무결성). Money buys audit only (spec §8.5).
CREATE TABLE paid_ledger (
  event_key     TEXT    PRIMARY KEY,
  kind          TEXT    NOT NULL CHECK (kind IN ('SUPER_CHAT', 'SUPER_STICKER', 'GIFT', 'MEMBERSHIP')),
  amount_micros INTEGER CHECK (amount_micros IS NULL OR amount_micros >= 0),
  currency      TEXT    CHECK (currency IS NULL OR length(currency) = 3),
  tier          INTEGER CHECK (tier IS NULL OR tier > 0),
  jewels        INTEGER CHECK (jewels IS NULL OR jewels >= 0),
  applied_at    TEXT    NOT NULL
) STRICT;

-- Highest gift combo count already applied per base event key. `stored_max` is
-- non-decreasing and `delta = max(0, effectiveCount - stored_max)` (spec §7.4).
CREATE TABLE gift_combo (
  base_key   TEXT    PRIMARY KEY,
  stored_max INTEGER NOT NULL CHECK (stored_max >= 0)
) STRICT;

-- Skeleton only: T10 fixes the columns when it implements broadcast lifecycle
-- and reconcile (spec §9.2, §9.3). World state and broadcast id stay separate.
CREATE TABLE broadcast_resources (
  broadcast_id TEXT PRIMARY KEY,
  live_chat_id TEXT,
  stream_id    TEXT,
  lifecycle    TEXT CHECK (lifecycle IS NULL OR lifecycle IN ('offline', 'starting', 'live', 'degraded', 'recovering', 'safe_stopped')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

-- Skeleton only: T13 fills and enforces this when it automates retention,
-- deletion and revocation (spec §12.4, BOARD A-7).
CREATE TABLE retention_ledger (
  field_key     TEXT NOT NULL,
  source        TEXT NOT NULL,
  purpose       TEXT NOT NULL,
  allowed_until TEXT NOT NULL,
  deleted_at    TEXT,
  PRIMARY KEY (field_key, source, purpose)
) STRICT;
