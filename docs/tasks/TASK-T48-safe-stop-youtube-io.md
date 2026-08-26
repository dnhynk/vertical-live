# TASK-T48-safe-stop-youtube-io

- Task: T48 `safe_stopped` 뒤 process-owned YouTube API loop 중단 (`docs/tasks/TASK_SPECS.md` §T48)
- Branch: `dnhynk/t48-safe-stop-youtube-io` · PR: #61
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
| 1 | safe stop이 broadcast health/chat API loop를 중단하고 HTTP/world/store는 유지 | met | `main.ts`가 두 loop handle을 supervisor의 동기 halt 경계에 연결한다. `supervisor.test.ts` blocked-alert safe-stop 회귀가 API loop 중단을 검증하며 HTTP server·engine·store에는 stop을 호출하지 않는다. |
| 2 | in-flight health poll 뒤 추가 API call/timer 없음 | met | `health.test.ts`: fake clock에서 in-flight `liveStreams.list` 중 stop 뒤 `liveBroadcasts.list` 0회, timer 0개, 이후 120초 advance에도 변화 없음. supervisor safe-stop 통합 회귀도 같은 경계를 검증한다. |
| 3 | repeated stop 멱등 | met | monitor `stop()` 2회와 supervisor safe-stop request 2회에서 halt/chat stop이 정확히 1회임을 검증한다. |
| 4 | 정상 live polling·quota accounting 유지 | met | live resource poll에서 `liveStreams.list`와 `liveBroadcasts.list` 사용량이 각각 정확히 1 증가한다. T47 `grpc-pacing.test.ts` 포함 targeted 57 tests와 전체 2,235 tests 통과. |
| 5 | contract/privacy/secret/BOARD/HANDOFF/dependency/unit cost 무변경 | met | `git diff --name-only origin/main...HEAD`: server lifecycle/test 6개 + T48 문서 2개뿐. `packages/contract`, config, lockfile commit, BOARD, HANDOFF 변경 없음. |
| 6 | fetch/rebase, npm ci, 게이트 5개, latest-head CI | unverifiable | `origin/main` rebase, `npm ci`, 로컬 게이트 5개 통과. PR #61 latest-head CI 대기 중. |

### Gates (executed)

```text
git fetch origin; git rebase --autostash origin/main
  -> pass; origin/main 8a47046 위로 2 commits rebase
npm ci
  -> pass; 431 packages installed, audit는 기존 10 vulnerabilities 보고
npm run format:check
  -> pass; All matched files use Prettier code style
npm run lint
  -> pass; ESLint + no-legacy-imports + install-script checks
npm run typecheck
  -> pass; tsc --build tsconfig.json
npm run test
  -> pass; 153 files, 2,235 passed, 1 skipped
npm run build
  -> pass; contract schema current, renderer/server/simulator/soak built
```

## Not done / out of scope

- `safe_stopped`에서 YouTube broadcast를 complete로 전이하거나 process를 종료하지 않는다.
- API unit cost, polling interval, quota budget을 변경하지 않는다.

## Follow-ups

- 없음.

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
