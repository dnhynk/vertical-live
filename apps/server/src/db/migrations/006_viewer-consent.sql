-- 006_viewer-consent — the one place a consented viewer's identity is stored
-- (BOARD D-9, 2026-08-19; spec §7.4, §12.4).
--
-- Gate 0 §1.3 chose option (B): a viewer who sends the opt-in command after
-- reading the notice has a name stored and shown, the withdrawal command
-- deletes it immediately, and everybody else stays anonymous exactly as they
-- were while the gate was closed (BOARD A-1, partially reversed by D-9).
--
-- Every other table in this schema still has nowhere to put a person, and the
-- audit in `apps/server/src/privacy/identity-columns.ts` enforces that: it
-- allows identity-shaped columns in this table and in no other. That is what
-- makes deletion provable — "delete everything about this viewer" is one row,
-- not a search across the database (spec §12.4 사용자 삭제 요청).
--
-- What is deliberately NOT here:
--   * no message text, no command history, no per-viewer counters. The name is
--     stored to be shown next to '방금 반영된 행동' and for nothing else (D-9);
--     a per-person activity series would be the §14.1 D1/D7/D30 metric that is
--     forbidden before an [S42] approval.
--   * no hash of the channel id. §12.4 forbids storing a reversible or stable
--     hash just as firmly as the id itself, so `channel_ref` is 128 random bits
--     with no relation to the id it points at.
CREATE TABLE viewer_consent (
  -- Opaque server-issued reference, the only identity value allowed to leave
  -- this table (contract `CHANNEL_REF_PATTERN`: `ref_` + 32 lower-case hex).
  -- The length and prefix are checked here as well so a row written by anything
  -- other than the issuing code is still refused; the full pattern is enforced
  -- by the contract schema on the way in.
  channel_ref     TEXT NOT NULL PRIMARY KEY
                    CHECK (length(channel_ref) = 36 AND substr(channel_ref, 1, 4) = 'ref_'),
  -- The raw YouTube channel id of the consenting viewer. This column is the
  -- **only** storage of it in the whole system: nothing else — no inbox
  -- envelope, no effect row, no metric, no log line — may hold it, which is
  -- what keeps `LEAVE` and a deletion request able to erase it completely
  -- (spec §12.4 삭제 가능성).
  channel_id      TEXT NOT NULL UNIQUE,
  -- Display name from `authorDetails`, refreshed on every message this viewer
  -- sends. [S41] Developer Policies III.E.4.c allows Authorized Data outside
  -- the III.E.4.b exceptions to be stored only as long as the consent needs it
  -- and never beyond 30 calendar days, so a row that stops being refreshed is
  -- deleted by the retention sweep (config/retention.json).
  display_name    TEXT NOT NULL,
  consented_at    TEXT NOT NULL,
  -- Last time a message from this viewer refreshed the two columns above. The
  -- retention sweep expires rows by this column.
  last_active_at  TEXT NOT NULL,
  -- Which version of the notice the viewer consented to. A changed notice needs
  -- a fresh consent, and this column is what makes "which text did they agree
  -- to" answerable during an API compliance audit (docs/ops/identity-consent.md).
  notice_version  TEXT NOT NULL
) STRICT;

-- "Which consent records stopped being refreshed before this instant?" — the
-- query the retention sweep runs (spec §12.4 field별 schedule).
CREATE INDEX viewer_consent_last_active ON viewer_consent (last_active_at);
