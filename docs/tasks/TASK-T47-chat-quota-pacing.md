# TASK-T47-chat-quota-pacing

- Task: T47 successful gRPC `streamList` quota-safe pacing (`docs/tasks/TASK_SPECS.md` §T47)
- Branch: `dnhynk/t47-chat-quota-pacing` · PR: pending
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
| 1 | Shipped configured start-to-start cap keeps the T44 combined daily model at or below 9,500 units. | pending | — |
| 2 | Pacing applies only after a normal gRPC end with at least one response and preserves existing failure/empty/REST semantics. | pending | — |
| 3 | Rapid successful normal closes cannot exceed the configured start rate and resume the durable response token. | pending | — |
| 4 | Stop/cancel interrupts a pacing wait without waiting the full interval. | pending | — |
| 5 | Health distinguishes successful pacing from failure backoff; no fake events, duplicate quota records, or contract changes. | pending | — |
| 6 | Rebase, five local gates, PR latest-head CI. | pending | — |

### Gates (executed)

```text
Not run yet.
```

## Not done / out of scope

- Live-host deployment, restart, and Gate 2 production calibration remain coordinator-owned.
- No migrations, contract changes, payment/identity/public-flag changes, or dependencies.

## Follow-ups

- Calibrate the provisional 25,000ms interval against fresh Gate 2 quota and latency evidence after deployment.

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|

