# TASK-T48-safe-stop-youtube-io

- Task: T48 `safe_stopped` 뒤 process-owned YouTube API loop 중단 (`docs/tasks/TASK_SPECS.md` §T48)
- Branch: `dnhynk/t48-safe-stop-youtube-io` · PR: pending
- Orca: task `task_696a409f6a0a` · dispatch `ctx_7959cc07bfaf`
- Spec sections read: §9.1, §9.2, §11
- BOARD decisions/assumptions relied on: D-17, D-21, D-25, A-15

## Goal

`safe_stopped` 진입 즉시 이 process가 소유한 반복 YouTube API 작업을 중단해 quota가 더 소비되지 않게 하되, 사람이 조사하고 복구할 수 있도록 HTTP health surface와 영속 world/store는 살아 있게 둔다.

## Plan

1. production main wiring과 YouTube 관련 timer/loop 소유권을 추적해 `safe_stopped` 뒤 실제로 살아 있는 loop를 확정한다.
2. broadcast health monitor handle을 보존하고 supervisor의 동기 halt 경계에서 health monitor와 chat source를 멱등 중단한다.
3. 가상 시계로 in-flight poll, repeated stop, 정상 live polling과 quota accounting 회귀를 고정한다.
4. fetch/rebase, `npm ci`, 게이트 5개와 latest-head CI를 실행하고 근거를 기록한다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| 해당 없음 | — | 2026-08-26 | API 비용·주기·계약을 바꾸지 않는 내부 lifecycle 수정이므로 새 외부 사실을 사용하지 않는다. |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | — | task 명세와 정본에 구현 경계가 충분하다. |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 새 값 없음 | — | — | 기존 quota cost·poll interval을 변경하지 않는다. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | safe stop이 broadcast health/chat API loop를 중단하고 HTTP/world/store는 유지 | pending | 구현·테스트 예정 |
| 2 | in-flight health poll 뒤 추가 API call/timer 없음 | pending | 구현·테스트 예정 |
| 3 | repeated stop 멱등 | pending | 구현·테스트 예정 |
| 4 | 정상 live polling·quota accounting 유지 | pending | 구현·테스트 예정 |
| 5 | contract/privacy/secret/BOARD/HANDOFF/dependency/unit cost 무변경 | pending | 최종 diff 검사 예정 |
| 6 | fetch/rebase, npm ci, 게이트 5개, latest-head CI | pending | 실행 예정 |

### Gates (executed)

```text
실행 전
```

## Not done / out of scope

- `safe_stopped`에서 YouTube broadcast를 complete로 전이하거나 process를 종료하지 않는다.
- API unit cost, polling interval, quota budget을 변경하지 않는다.

## Follow-ups

- 없음.

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
