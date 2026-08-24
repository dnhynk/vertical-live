# TASK-T47-chat-quota-pacing

- Task: T47 all-start gRPC `streamList` quota-safe pacing (`docs/tasks/TASK_SPECS.md` §T47)
- Branch: `dnhynk/t47-chat-quota-pacing` · PR: #60
- Orca: task `task_2d2fd2082b4f` · dispatch `ctx_218e2507997c`
- Review fix: F-T47-R1 task `task_b9d4fd94e525` · dispatch `ctx_b173ccdf4b32`
- Review fix: F-T47-R2 task `task_4e60a3301bc1` · dispatch `ctx_480ff7644031`
- Spec sections read: §7.2, §9.4, §11, Gate 2
- BOARD decisions/assumptions relied on: A-15 (operational thresholds stay provisional until Gate 2 calibration)

## Goal

Cap every actual gRPC `liveChatMessages.streamList` start at a quota-safe deterministic rate while preserving durable response-token resume, existing error and empty-end backoff, auth/error classification, cancellation, REST server-directed polling, retarget/stop behavior, and exact per-request quota accounting.

## Plan

1. Trace chat config loading, gRPC reconnect state/health, injected clock/timer seams, quota accounting, and T44's daily budget calculation.
2. Add a provisional configured 25,000ms all-start gRPC interval through the normal JSON/env path and enforce it at the one boundary before every actual start, after any existing branch-specific wait.
3. Extend health detail only as needed to distinguish quota-floor waits from empty/failure backoff, without changing supervisor semantics.
4. Add deterministic regressions for normal, response-then-error, empty, token-rejection, alternating, stop, and retarget paths plus durable token/accounting and the config timer boundary.
5. Run `npm ci`, rebase on `origin/main`, execute all five local gates, record exact results, push the worker branch, open a PR, and verify latest-head CI.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| YouTube Streaming Live Chat | https://developers.google.com/youtube/v3/live/streaming-live-chat | 2026-08-24 | `streamList` responses carry the next-page token used to resume a subsequent stream; pacing is a local quota safeguard and must not replace that token. |
| `liveChatMessages.streamList` | https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList | 2026-08-24 | The API is the official low-latency streaming path; normal stream completion behavior and quota-safe reconnect cadence require Gate 2 calibration. |
| YouTube Data API quota | https://developers.google.com/youtube/v3/determine_quota_cost | 2026-08-24 | The default allocation is 10,000 units/day; the repository keeps 500 units reserved, so shipped combined modeled use must stay at or below 9,500. |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | — | Dispatch supplied the observed rate and preferred provisional cap. |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| Every actual gRPC call minimum start-to-start interval | 25,000ms | `provisional: true`, Gate 2 calibration | Deterministically caps all chat opens, independent of terminal outcome, at 2.4/minute (3,456/day at one modeled unit/call), keeping the existing T44 fixed budget plus chat below the 9,500 usable daily budget. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | Shipped configured floor keeps every actual gRPC start inside the T44 combined daily model and retains meaningful resilience headroom. | met | `quota/budget.test.ts`: `ceil(86,400,000 / 25,000) = 3,456` chat; health 4,608; rollover 636; combined 8,700; usable 9,500; headroom 800 `> rolloverUnits` 636. |
| 2 | Response-bearing normal end, response-then-error, empty end, token rejection, and alternating outcomes all obey the configured floor without erasing branch backoff. | met | `grpc-pacing.test.ts`: reviewer sequence formerly `[0,1000,2000]` is `[0,25000,50000]`; alternating path starts `[0,25000,50000,75000,100000,125000]` while observing `failure_backoff`, `empty_end_backoff`, and `quota_start_pacing`. |
| 3 | Durable response-token resume and quota accounting remain exact per actual request. | met | Reviewer regression requests `undefined → token_error_1 → token_error_2` with 3 starts = 3 units; alternating path advances/forgets tokens exactly and 6 starts = 6 units. |
| 4 | Stop, retarget, and a completed same-instance production restart cancel the old run without bypassing the shared floor or weakening auth/policy stops. | met | `grpc-pacing.test.ts` uses one `ChatSource` and the `main.ts` shape `await stop(); start()`: an `auth_revoked` run remains terminal until that explicit action, restart clears idle/sticky stop and `lastResult`, starts remain `[0]` through 24,999ms then become `[0,25000]`, quota is exactly 2 for 2 requests, health returns `ok`, concurrent `start()` is idempotent, and final timer count is 0. Fix `b108845`. |
| 5 | Existing classification/health semantics remain additive. | met | Error and empty branch delays run first, then only the remaining quota floor; health reports `quota_start_pacing` separately from `failure_backoff`/`empty_end_backoff`; REST/auth suites remain in the full gate. No fake events or contract changes. |
| 6 | Node timer overflow is impossible through the renamed config/env path. | met | `config.test.ts` accepts `2,147,483,647` and rejects `2,147,483,648` from both JSON and `VL_YOUTUBE_CHAT_GRPC_STREAM_MIN_START_INTERVAL_MS`. |
| 7 | Fetch/rebase check, install, five local gates, and latest-head CI. | met | `git fetch origin` plus `git rebase origin/main` reported the branch up to date; setup lock drift was stashed only for the rebase and restored. `npm ci` and all five local gates passed. PR #60's final documentation-evidence head is verified by its exact-head CI before worker completion, with the run and full SHA reported in `worker_done`. |

### Gates (executed)

```text
npm ci
  PASS — added 431 packages and audited 437; npm reported 10 existing audit findings
npm run format:check
  PASS — all matched files use Prettier style
npm run lint
  PASS — ESLint, no-legacy-imports, and reviewed install-script checks
npm run typecheck
  PASS — tsc --build tsconfig.json
npm run test
  PASS — 153 files; 2,232 passed, 1 skipped (2,233 total)
npm run build
  PASS — all workspaces; contract schema and data map current
PR #60 latest-head CI
  PASS — final evidence head verified before worker completion; exact run/SHA in worker_done
```

## Not done / out of scope

- Live-host deployment, restart, and Gate 2 production calibration remain coordinator-owned; the worker did not touch the running unlisted host.
- No migrations, contract changes, payment/identity/public-flag changes, or dependencies.
- A setup-generated `package-lock.json` peer-metadata diff predated implementation, remained unchanged through `npm ci`, and was intentionally excluded from commits/PR rather than overwritten.

## Follow-ups

- Calibrate the provisional 25,000ms interval against fresh Gate 2 quota and latency evidence after deployment.

## Review round 1 — R-T47-1

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] response-then-`UNAVAILABLE` bypasses success-only pacing, so budget does not cap all actual starts. | 고침 `faae286`: pacing moved to the single pre-start boundary and shared across retarget sessions; deterministic reviewer and alternating-path regressions pin gaps, tokens, quota, and backoff reasons. |
| [major] `budget.test.ts` weakened resilience headroom to `> 0`. | 고침 `faae286`: exact model is health 4,608 + chat 3,456 + rollover 636 = 8,700; usable headroom 800 must be greater than `rolloverUnits` 636. |
| [major] interval `2147483648` overflows Node timers to 1ms. | 고침 `faae286`: renamed JSON/env value is validated at `<= 2147483647`; JSON/env boundary regressions reject `2147483648`. |

## Review round 2 — R-T47-2R

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] production `main.ts` reuses one `ChatSource` for `await stop(); start()`, but outer `#cancelled=true` and sticky stop state made the restart a permanent idle no-op; reviewer starts stayed `[0]` through 25,000ms. | 고침 `b108845`: only completed-run outer lifecycle state is reset at `start()` after `#running` is cleared by `stop()`; sticky stop and stale refs/results are cleared, concurrent starts remain idempotent, and `#grpcStartPacingState` intentionally survives. The FakeClock regression pins explicit auth-stop behavior, starts `[0]` then `[0,25000]`, recovered mode/health, two requests/two quota units, and zero leaked timers. |
