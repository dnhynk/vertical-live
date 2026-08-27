# TASK-T51-chat-restart-readiness

- Task: T51 chat-source 재시작 완료를 transport 회복까지 검증 (`docs/tasks/TASK_SPECS.md` §T51)
- Branch: `dnhynk/t51-chat-restart-readiness` · PR: #64
- Orca worktree: `t51-chat-restart-readiness`
- Spec sections read: §9.1, §9.2, §9.4, §10.2, §11
- BOARD decisions/assumptions relied on: D-25, A-15

## Goal

chat-source restart가 `start()` 호출만으로 성공 처리되어 새 transport가 회복할 틈 없이 bounded restart budget을 소모하는 결함을 고친다. restart attempt는 canonical chat transport readiness가 실제로 `ok`가 될 때까지 in-flight로 남고, timeout과 abort는 기존 supervisor 안전 경계를 유지한다.

## Incident evidence

| UTC | 사실 |
|---|---|
| 2026-08-26T16:00:38.380Z | chat-source attempt 1 completed; 새 source start 1ms 뒤 |
| 2026-08-26T16:00:42.286Z | attempt 2 completed; attempt 1 뒤 3.906s |
| 2026-08-26T16:00:51.317Z | attempt 3 completed 및 새 source start |
| 2026-08-26T16:00:51.456Z | 세 번째 start 139ms 뒤 `restart_budget_exhausted` safe-stop |

`frame_loss`는 `componentsToRestart()`에서 restart target이 아니다. 실제 target은 함께 degraded였던 `chat_transport`였고, 모든 attempt가 T47 pacing/transport readiness 전에 성공 반환한 것이 예산 폭주의 직접 원인이다.

## Plan

1. canonical chat transport readiness 판정을 production chat port와 startup이 공유하게 한다.
2. stop → abort gate → start → bounded readiness wait를 restart action으로 추출한다.
3. FakeClock 회귀 테스트로 in-flight budget 보존, readiness 성공, timeout 실패, abort를 고정한다.
4. focused 및 전체 게이트를 실행하고 결과와 exact SHA/CI를 기록한다.

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| restart readiness timeout | `grpcStreamMinStartIntervalMs + supervisor.chatStart.timeoutMs` | 기존 provisional 값의 합 | T47 pacing 전체와 기존 chat readiness window를 모두 보장하며 새 임계값을 만들지 않는다. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거 |
|---|---|---|---|
| 1 | canonical transport `ok` 뒤 completed | met | fix `89a64e7`: `ChatSource.transportReady()`가 정본 `youtube.chat.transport=ok`를 읽고 production startup/restart port가 같은 판정을 사용한다. `restartChatSource()`는 이 판정 전에는 반환하지 않는다. |
| 2 | 회복 대기 중 attempt 1회 유지 | met | `runtime.test.ts`: incident보다 긴 14초 동안 2초 간격 recovery request를 반복해도 모두 `in_flight`, attempts=1이며 readiness 뒤에만 완료된다. |
| 3 | pacing + readiness timeout, injected clock | met | production은 `chatRestartReadinessTimeoutMs(chatStart.timeoutMs, grpcStreamMinStartIntervalMs)`를 사용한다. shipped 30,000+25,000=55,000ms를 FakeClock으로 고정했고 unsafe integer 합은 거부한다. |
| 4 | timeout/backoff/exhaustion 및 abort 보존 | met | FakeClock에서 1,000ms readiness timeout이 `lastError`로 남고 두 번째 실패 뒤 기존 maxAttempts=2 exhaustion에 도달한다. stop-await abort는 start 0회, active wait abort는 pending timer 1→0을 증명한다. |
| 5 | startup 및 T47/T48 회귀 없음 | met | startup도 canonical readiness를 기다린다. focused 3 files/51 passed 및 전체 155 files/2,251 passed/1 skipped; contract/dependency/host/live 변경 0. |
| 6 | focused + 5 gates + latest-head CI | pending | `npm ci`, fetch(HEAD가 origin/main보다 2 commits ahead/behind 0), focused 및 로컬 5 gates는 성공. PR latest-head CI 대기. |

## Gates (executed)

```text
git fetch origin --prune
git rev-list --left-right --count origin/main...HEAD -> 0 2 (rebase 불필요)
npm ci                -> pass (431 packages; audit 경고 10건, dependency 변경 없음)
npx vitest run apps/server/src/supervisor/runtime.test.ts apps/server/src/supervisor/restart.test.ts apps/server/src/youtube/chat/chat-source.test.ts
                      -> pass (3 files; 51 passed)
npm run format:check  -> pass
npm run lint          -> pass (legacy imports 0; install scripts reviewed 4)
npm run typecheck     -> pass
npm run test          -> pass (155 files; 2,251 passed; 1 skipped)
npm run build         -> pass (schema/data map up to date; renderer/server/simulator/soak)
GitHub Actions CI     -> pending
```

## Not done / out of scope

- 실행 중 public 방송·server·OBS·renderer 재시작 또는 host scheduled task 변경.
- secret 조회·출력, contract/dependency 변경, 새 운영 임계값 도입.

## Follow-ups

- PR 독립 GPT 리뷰·머지 뒤 안전한 구간에 서버만 배포하고, 새 public segment에서 실제 restart recovery 시간을 관측한다.
