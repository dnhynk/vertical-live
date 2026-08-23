-- 007_quota-usage — the day's YouTube API spend, so the guard survives a restart.
--
-- `QuotaTracker` already knows the daily allowance, warns when the local count
-- passes it and refuses calls that would eat the reserve. On 2026-08-23 the
-- allowance was exhausted anyway and the log carried zero quota warnings: the
-- counter lived only in process memory, so every restart set it back to zero
-- while Google's account-wide daily counter kept climbing. A guard that forgets
-- what it is guarding is not a guard (T44; the module comment already named
-- this table's job — "T4 owns persistence and can restore a snapshot on start").
--
-- One row per (quota day, method). Per-method rather than a single total
-- because the reserve and the polling budget are tuned against where the units
-- actually went, and a total cannot answer that.
--
-- `quota_day` is a Pacific-Time date (`YYYY-MM-DD`) — the boundary Google
-- resets on, not UTC midnight. Rows for past days are kept: they are a few
-- dozen bytes each and they are the only record of what a day cost.
--
-- Nothing here is about a person. The columns are a method name and a count.
CREATE TABLE quota_usage (
  quota_day TEXT NOT NULL,
  method    TEXT NOT NULL,
  units     INTEGER NOT NULL CHECK (units >= 0),
  PRIMARY KEY (quota_day, method)
) WITHOUT ROWID;
