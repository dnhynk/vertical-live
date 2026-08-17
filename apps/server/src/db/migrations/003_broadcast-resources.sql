-- 003_broadcast-resources — the columns 001 left as a skeleton for T10
-- (spec §9.1: "broadcast 생성·bind·transition 전 외부 resource ID와 lifecycle
-- 단계를 영속한다").
--
-- Why the table is replaced rather than altered: 001 declared it "Skeleton only:
-- T10 fixes the columns", its primary key was the broadcast id — which does not
-- exist yet at the moment the *first* call has to be recorded — and its
-- `lifecycle` CHECK held the supervisor states (`offline`…`safe_stopped`), which
-- belong to T12's state machine, not to one resource row. No code ever wrote to
-- it (the name appears only in 001 and in the table-list assertion of
-- `migrate.test.ts`), so nothing is lost. 001 itself is immutable once applied:
-- the runner refuses a checksum change.
DROP TABLE broadcast_resources;

-- One row per *attempt* to bring a broadcast up. The row is written before the
-- first API call and outlives every failure, so a restart can tell "the call may
-- have been applied" from "the call was never made" (spec §9.1 reconcile).
--
-- `attempt_id` is generated locally: `liveBroadcasts.insert` has no idempotency
-- key, so the durable identity of an attempt has to be ours. What makes the
-- attempt findable at YouTube is `scheduled_start_time` (unique per attempt,
-- chosen and persisted *before* insert) for the broadcast and `stream_title` for
-- the reusable ingestion stream.
CREATE TABLE broadcast_resources (
  attempt_id           TEXT    PRIMARY KEY,
  -- spec §9.3 / BOARD A-4: `single` is production, `rolling-experiment` is a
  -- labelled experiment. Both are recorded so a row states which one made it.
  strategy             TEXT    NOT NULL CHECK (strategy IN ('single', 'rolling-experiment')),
  -- Monotonic lifecycle stage of *our* work. Deliberately not YouTube's
  -- `lifeCycleStatus`: this is what we have durably done, that is what YouTube
  -- reports, and reconcile is the act of comparing the two.
  stage                TEXT    NOT NULL CHECK (stage IN (
                         'planned', 'stream_ready', 'broadcast_created', 'bound',
                         'testing', 'live', 'complete', 'abandoned')),
  -- Set immediately before a *mutating* call and cleared only once its outcome is
  -- known. A row found with `pending_call` set means the result is uncertain and
  -- `list/get` must reconcile before anything is retried (spec §9.1). Reads are
  -- never recorded here: re-reading is always safe.
  pending_call         TEXT    CHECK (pending_call IS NULL OR pending_call IN (
                         'liveStreams.insert', 'liveBroadcasts.insert',
                         'liveBroadcasts.bind', 'liveBroadcasts.transition')),
  pending_since        TEXT,
  stream_id            TEXT,
  -- Reuse and reconcile key for the ingestion stream. The stream *key*
  -- (`cdn.ingestionInfo.streamName`) is never stored here or anywhere else in this
  -- database: the vault is its system of record (spec §10.2, BOARD A-16).
  stream_title         TEXT    NOT NULL,
  broadcast_id         TEXT,
  live_chat_id         TEXT,
  scheduled_start_time TEXT    NOT NULL,
  -- NULL = not yet attempted, 1 = insert accepted `enableAutoStart`,
  -- 0 = YouTube answered `invalidAutoStart`, so the transition path is used (§4).
  auto_start           INTEGER CHECK (auto_start IS NULL OR auto_start IN (0, 1)),
  -- Machine-stable reason of the last failure (`userBroadcastsExceedLimit`, …).
  -- Never a response body: those can quote request content.
  last_error_reason    TEXT,
  created_at           TEXT    NOT NULL,
  updated_at           TEXT    NOT NULL,
  closed_at            TEXT,
  CHECK ((pending_call IS NULL) = (pending_since IS NULL)),
  CHECK (closed_at IS NULL OR stage IN ('complete', 'abandoned')),
  -- A closed attempt cannot still be waiting on a call outcome.
  CHECK (closed_at IS NULL OR pending_call IS NULL)
) STRICT;

-- One *open* attempt per broadcast id: two live rows claiming the same external
-- resource would make the audit trail a guess. Closed rows are excluded on purpose:
-- an attempt that was abandoned and whose broadcast is later found still running
-- has to be adoptable again (spec §9.1 recovery).
CREATE UNIQUE INDEX broadcast_resources_broadcast
  ON broadcast_resources (broadcast_id)
  WHERE broadcast_id IS NOT NULL AND closed_at IS NULL;

-- "What was in flight when the process died?" (spec §9.1 restart path).
CREATE INDEX broadcast_resources_open
  ON broadcast_resources (created_at)
  WHERE closed_at IS NULL;
