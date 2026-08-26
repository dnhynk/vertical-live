# TASK-T48-safe-stop-youtube-io

- Task: T48 `safe_stopped` 뒤 process-owned YouTube API loop 중단 (`docs/tasks/TASK_SPECS.md` §T48)
- Branch: `dnhynk/t48-safe-stop-youtube-io` · PR: #61
- Orca: task `task_696a409f6a0a` · dispatch `ctx_7959cc07bfaf`
- Fix dispatch: task `task_8cf1fe20a43f` · dispatch `ctx_5f2ec6494e97`
- Fix dispatch 2: task `task_ac34b4a59872` · dispatch `ctx_b1d4af1d4c51`
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
| 1 | safe stop이 broadcast health/chat API loop를 중단하고 HTTP/world/store는 유지 | met | `main.ts`가 두 loop handle을 supervisor의 동기 halt 경계에 연결한다. R-T48-1 뒤 `rest-source.ts`도 pending token/fetch/body/refresh await가 끝날 때마다 stop을 재확인한다. `supervisor.test.ts`는 HTTP server·engine·store에 stop을 호출하지 않음을, `rest-source.test.ts`는 pending token 중 stop 뒤 quota/fetch가 0임을 검증한다. |
| 2 | in-flight health poll 뒤 추가 API call/timer 없음 | met | `health.test.ts`: in-flight `liveStreams.list` 중 stop 뒤 `liveBroadcasts.list` 0회와 timer 0개. `rest-source.test.ts`: `getAccessToken()`을 보류하고 stop→resolve 뒤 quota 0, fetch 0, timer 0이며 fake clock을 request timeout+poll interval 뒤까지 advance해도 그대로다. |
| 3 | repeated stop 멱등 | met | monitor `stop()` 2회와 supervisor safe-stop request 2회에서 halt/chat stop이 정확히 1회임을 검증한다. |
| 4 | 정상 live polling·quota accounting 유지 | met | live resource poll에서 `liveStreams.list`와 `liveBroadcasts.list` 사용량이 각각 정확히 1 증가한다. REST quota 회귀와 전체 2,242 tests 통과. |
| 5 | contract/privacy/secret/BOARD/HANDOFF/dependency/unit cost 무변경 | met | `git diff --name-only origin/main...HEAD`: server lifecycle/test 8개 + T48 문서 2개뿐. `packages/contract`, config, committed lockfile, BOARD, HANDOFF 변경 없음. |
| 6 | fetch/rebase, npm ci, 게이트 5개, latest-head CI | unverifiable | `origin/main` `8e32ed7` 위로 rebase, `npm ci`, 로컬 게이트 5개 통과. 이 티켓 commit 뒤 PR #61 exact-head CI 대기 중. |

### Gates (executed)

```text
git fetch origin; git rebase --autostash origin/main
  -> pass; TASK_SPECS에서 T48·T49를 모두 보존해 충돌 해결, origin/main 8e32ed7 위로 rebase
  -> known npm-ci package-lock peer-metadata noise는 autostash로 복원했고 stage/commit하지 않음
npm ci
  -> pass; 431 packages installed, audit는 기존 10 vulnerabilities 보고
npm run test -- --run apps/server/src/youtube/chat/rest-source.test.ts (fix 전)
  -> fail; 새 회귀 1건이 5,000ms timeout (stop 뒤 fetch가 fake-clock timer를 예약해 run이 끝나지 않음)
npm run test -- --run apps/server/src/youtube/chat/rest-source.test.ts (fix 후)
  -> pass; 1 file, 12 tests
npm run format:check && npm run lint && ... (첫 실행)
  -> fail at lint; 회귀의 초기 resolver placeholder가 no-unused-vars를 위반
npm run format:check
  -> pass; All matched files use Prettier code style
npm run lint
  -> pass; ESLint + no-legacy-imports + install-script checks
npm run typecheck
  -> pass; tsc --build tsconfig.json
npm run test
  -> pass; 154 files, 2,242 passed, 1 skipped
npm run build
  -> pass; contract schema current, renderer/server/simulator/soak built
```

## Not done / out of scope

- `safe_stopped`에서 YouTube broadcast를 complete로 전이하거나 process를 종료하지 않는다.
- API unit cost, polling interval, quota budget을 변경하지 않는다.

## Follow-ups

- 없음.

## Review round 1 (R-T48-1)

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] `rest-source.ts:101` — `getAccessToken()` pending 중 stop 뒤 resolve되면 quota를 기록하고 `liveChatMessages.list`를 호출함 | 고침 `a316c72`: token resolve/reject 직후 cancellation guard를 두고, fake clock regression이 token hold→stop→release 뒤 quota 0·fetch 0·timer 0을 증명한다. 같은 REST loop의 equivalent await boundary를 좁게 감사해 fetch resolve, response body parse, auth force-refresh resolve/reject 뒤에도 guard를 두었다. in-flight fetch는 기존 AbortController로 중단하고 cancelled catch는 failure/backoff를 만들지 않으며, poll/backoff delay는 기존 `CancellableDelay.cancel()`과 outer post-poll guard가 재예약을 막는다. |

## Review round 2 (R-T48-2R)

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] `docs/tasks/TASK_SPECS.md:996` — T48 추가 diff가 기존 T49 합격 기준 6을 삭제해 T49를 범위 밖에서 변경함 | 고침 `e67446c`: origin/main의 `6. fetch/rebase + \`npm ci\` + 게이트 5개 + latest-head CI가 녹색이다.`를 verbatim 복구했다. `git diff origin/main -- docs/tasks/TASK_SPECS.md`는 이제 T48 절 추가만 보이며 기존 T49 절의 편집은 0건이다. 이 restoration은 `docs/tasks/TASK_SPECS.md` 1개 파일·1줄 추가만 담았고 executable code, `package-lock.json` metadata noise, `HANDOFF.md`를 stage·commit하지 않았다. |

### R-T48-2R 재검증

```text
git fetch origin; git rebase --autostash origin/main
  -> pass; branch는 origin/main 8e32ed7 기준 최신이었고 pre-existing package-lock metadata noise만 autostash로 복원
T49 section Compare-Object (working tree vs git show origin/main:docs/tasks/TASK_SPECS.md)
  -> pass; T49_COMPARE=PASS lines=19
npx prettier --check docs/tasks/TASK_SPECS.md docs/tasks/TASK-T48-safe-stop-youtube-io.md
  -> pass; All matched files use Prettier code style
git diff --check
  -> pass; whitespace error 0
git diff origin/main -- docs/tasks/TASK_SPECS.md
  -> pass; T48 절 추가만 있고 pre-existing T49 절 edit 0
npm ci
  -> pass; 431 packages installed, audit는 기존 10 vulnerabilities 보고
npm run format:check
  -> pass; All matched files use Prettier code style
npm run lint
  -> pass; ESLint + no-legacy-imports + install-script checks
npm run typecheck
  -> pass; tsc --build tsconfig.json
npm run test
  -> pass; 154 files, 2,242 passed, 1 skipped
npm run build
  -> pass; contract schema current, renderer/server/simulator/soak built
PR #61 latest-head CI
  -> 이 티켓 commit·push 뒤 확인 예정; 실행 전 green으로 기록하지 않음
```
