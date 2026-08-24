# TASK-T47-chat-quota-pacing

- Task: T47 successful gRPC `streamList` quota-safe pacing (`docs/tasks/TASK_SPECS.md` §T47)
- Branch: `dnhynk/t47-chat-quota-pacing` · PR: #60
- Orca: task `task_2d2fd2082b4f` · dispatch `ctx_218e2507997c`
- Spec sections read: §7.2, §9.4, §11, Gate 2
- BOARD decisions/assumptions relied on: A-15 (operational thresholds stay provisional until Gate 2 calibration)

## Goal

Cap successful gRPC `liveChatMessages.streamList` reconnect starts at a quota-safe deterministic rate while preserving durable response-token resume, existing error and empty-end backoff, cancellation, REST server-directed polling, retarget/stop behavior, and exact per-request quota accounting.

## Plan

1. Trace chat config loading, gRPC reconnect state/health, injected clock/timer seams, quota accounting, and T44's daily budget calculation.
2. Add a provisional configured 25,000ms successful-call start-to-start interval through the normal JSON/env path, with cancellable pacing only after a normal end containing at least one response.
3. Extend health detail only as needed to distinguish successful paced reconnect waits from failure backoff, without changing supervisor semantics.
4. Add deterministic regressions for the start-rate cap, durable response-token resume, cancellation/stop, unchanged error/empty/REST behavior, and a daily budget derived from the shipped pacing value.
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
| Successful gRPC call minimum start-to-start interval | 25,000ms | `provisional: true`, Gate 2 calibration | Deterministically caps chat opens at 2.4/minute (3,456/day at one modeled unit/call), keeping the existing T44 fixed budget plus chat below the 9,500 usable daily budget even if streams close immediately. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | Shipped configured start-to-start cap keeps the T44 combined daily model at or below 9,500 units. | met | `quota/budget.test.ts`: `ceil(86,400,000 / 25,000) = 3,456` chat units; T44 fixed broadcast 5,244; combined 8,700; usable budget 9,500; headroom 800. |
| 2 | Pacing applies only after a normal gRPC end with at least one response and preserves existing failure/empty/REST semantics. | met | `grpc-source.ts` branches on `kind === 'end' && responses > 0`; `grpc-pacing.test.ts` pins empty-end to 1,000ms error backoff; existing gRPC/REST/auth suites and full suite pass. |
| 3 | Rapid successful normal closes cannot exceed the configured start rate and resume the durable response token. | met | `grpc-pacing.test.ts`: virtual starts `[0, 25000, 50000, 75000]`; requests resume `token_1`→`token_3`; 4 actual opens produce exactly 4 quota units. A separate 10,000ms-open case waits only the remaining 15,000ms. |
| 4 | Stop/cancel interrupts a pacing wait without waiting the full interval. | met | `grpc-pacing.test.ts`: stop during a 25,000ms pace resolves `cancelled` at monotonic 0 with zero pending timers and cleared health wait. Existing target-watcher and source stop suites remain green. |
| 5 | Health distinguishes successful pacing from failure backoff; no fake events, duplicate quota records, or contract changes. | met | `health.test.ts`: `waitReason=successful_close_pacing` vs `failure_backoff`; reconnect remains observational `ok`. Diff has no contract/fake-event/dependency changes. |
| 6 | Rebase, five local gates, PR latest-head CI. | met | Rebased onto `origin/main` `76399d5`; `npm ci` and all five local gates passed. PR #60 CI run `32707789506` passed all steps on implementation/evidence head `8b7adc9`; the final documentation-only result commit is verified by its own latest-head CI before worker completion. |

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
  PASS — 153 files; 2,227 passed, 1 skipped (2,228 total)
npm run build
  PASS — all workspaces; contract schema and data map current
```

## Not done / out of scope

- Live-host deployment, restart, and Gate 2 production calibration remain coordinator-owned; the worker did not touch the running unlisted host.
- No migrations, contract changes, payment/identity/public-flag changes, or dependencies.
- A setup-generated `package-lock.json` peer-metadata diff predated implementation, remained unchanged through `npm ci`, and was intentionally excluded from commits/PR rather than overwritten.

## Follow-ups

- Calibrate the provisional 25,000ms interval against fresh Gate 2 quota and latency evidence after deployment.

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
