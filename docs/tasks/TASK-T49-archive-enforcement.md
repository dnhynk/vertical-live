# TASK-T49-archive-enforcement

- Task: T49 rolling archive default roots and Windows hourly schedule enforcement (`docs/tasks/TASK_SPECS.md` §T49)
- Branch: `dnhynk/t49-archive-enforcement` · PR: pending
- Orca: task `task_cbcd6207d6eb` · dispatch `ctx_b83f0f15c559`
- Spec sections read: §9.1, §11
- BOARD decisions/assumptions relied on: D-25, A-15

## Goal

Make the rolling archive sweep inspect the repository-owned archive roots from every supported invocation and make its Windows scheduled task retain an observable future hourly run across logons and calendar days, without weakening deletion safety or mutating the live host.

## Plan

1. Pin the CLI's default relative-root base to the repository containing `config/default.json`, while retaining an explicitly injected `cwd` for isolated tests.
2. Add deterministic cross-cwd CLI regressions for repository-root and npm workspace invocation shapes, plus safety regressions for explicit apply and root refusal.
3. Replace event-only repetition with a logon trigger plus a daily calendar trigger whose registration-time future boundary, one-day repetition duration and configured hourly interval follow Task Scheduler semantics.
4. Add registration/XML regressions for trigger cadence, replacement values, interactive ownership, repository working directory and explicit apply.
5. Document a read-only host assertion for a successful result and non-null future next run, then run install, rebase checks, five gates, CI and PR delivery.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| Task Scheduler daily XML example | https://learn.microsoft.com/en-us/windows/win32/taskschd/daily-trigger-example--xml- | 2026-08-26 | Microsoft의 daily 예시는 `CalendarTrigger`에 필수 `StartBoundary`, `Repetition`, `ScheduleByDay`를 함께 둔다. |
| CalendarTrigger schema | https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-calendartrigger-triggergroup-element | 2026-08-26 | time/calendar trigger에는 `StartBoundary`가 필수이고 `ScheduleByDay`가 daily cadence를 정의한다. |
| Repetition schema | https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-repetition-triggerbasetype-element | 2026-08-26 | `Interval`은 반복 간격, `Duration`은 trigger가 시작된 뒤 반복 패턴이 지속되는 기간이다. |
| StartWhenAvailable | https://learn.microsoft.com/en-us/windows/win32/taskschd/tasksettings-startwhenavailable | 2026-08-26 | 예약 시각을 놓친 time-based task를 이후 실행할 수 있게 하므로 daily calendar trigger에 적용한다. |
| LogonTrigger | https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger | 2026-08-26 | 지정 user의 logon 때 실행하는 이벤트 trigger이므로 로그인 직후 sweep 책임만 유지한다. |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | — | Dispatch가 관측, 보존할 안전 규칙과 스케줄 요구를 모두 지정했다. |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| Archive retention/capacity/free-space/grace/root rules | 기존 `config/default.json` 값 그대로 | `provisional: true`, A-15 | T49는 enforcement 경로만 고치며 용량 값을 승인하거나 변경하지 않는다. |
| Archive schedule interval | 기존 기본 `PT1H` | 기존 운영 기본값 | Dispatch가 hourly enforcement를 요구했고 새 capacity/quality 합격선을 만들지 않는다. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 두 지원 invocation이 같은 repository archive roots를 스캔한다. | pending | 구현 후 기록 |
| 2 | injected cwd와 deletion/root safeguards를 보존한다. | pending | 구현 후 기록 |
| 3 | logon + daily calendar hourly XML이 미래 실행을 만든다. | pending | 구현 후 기록 |
| 4 | apply/interactive ownership/working directory 안전을 보존한다. | pending | 구현 후 기록 |
| 5 | host 검증 명령이 successful last result와 future next run을 모두 검사한다. | pending | 구현 후 기록 |
| 6 | install, rebase, five gates, latest-head CI가 녹색이다. | pending | 구현 후 기록 |

### Gates (executed)

```text
npm ci
  PASS — added 431 packages and audited 437; npm reported 10 existing audit findings
git fetch origin && git rebase origin/main
  PASS — rebased before implementation
나머지 게이트와 CI는 구현 후 기록
```

## Not done / out of scope

- Live archive files are not deleted and the host scheduled task is not registered, changed or run by this worker.
- Provisional capacity values, package contract, dependencies, secrets, BOARD and HANDOFF are unchanged.

## Follow-ups

- Coordinator-owned host deployment must re-register the task, then run the documented read-only verification against the host Task Scheduler state.
