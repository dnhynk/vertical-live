# TASK-T51-chat-restart-readiness

- Task: T51 component 재시작 완료를 정본 health 회복까지 검증 (`docs/tasks/TASK_SPECS.md` §T51)
- Branch: `dnhynk/t51-chat-restart-readiness` · PR: #64
- Orca worktree: `t51-chat-restart-readiness`
- Spec sections read: §9.1, §9.2, §9.4, §10.2, §11
- BOARD decisions/assumptions relied on: D-25, A-15

## Goal

restart action의 명령 반환을 실제 회복 완료로 오인해 동일한 degraded signal이 bounded restart budget을 연속 소모하는 결함을 고친다. chat-source는 canonical transport readiness까지 action 안에서 기다리고, OBS stream은 action 반환 뒤 정본 health family가 회복될 때까지 supervisor attempt를 in-flight로 유지한다. timeout과 abort는 기존 supervisor 안전 경계를 유지한다.

## Incident evidence

| UTC | 사실 |
|---|---|
| 2026-08-26T16:00:38.380Z | chat-source attempt 1 completed; 새 source start 1ms 뒤 |
| 2026-08-26T16:00:42.286Z | attempt 2 completed; attempt 1 뒤 3.906s |
| 2026-08-26T16:00:51.317Z | attempt 3 completed 및 새 source start |
| 2026-08-26T16:00:51.456Z | 세 번째 start 139ms 뒤 `restart_budget_exhausted` safe-stop |

`frame_loss`는 `componentsToRestart()`에서 restart target이 아니다. 실제 target은 함께 degraded였던 `chat_transport`였고, 모든 attempt가 T47 pacing/transport readiness 전에 성공 반환한 것이 예산 폭주의 직접 원인이다.

| UTC | OBS 추가 관측 |
|---|---|
| 2026-08-27T12:18:37.899Z | obs-stream attempt 1 action completed |
| 2026-08-27T12:18:54.443Z | attempt 2 action completed; YouTube는 계속 `stream_inactive` |
| 2026-08-27T12:18:57.996Z | attempt 3 action completed |
| 2026-08-27T12:19:06.795Z | `youtube_broadcast` 재차 degraded |
| 2026-08-27T12:19:06.799Z | `obs-stream:youtube_broadcast` restart budget exhausted safe-stop |

`ObsControl.startStream()`은 OBS output active까지만 확인한다. YouTube ingest의 `streamStatus=active`는 별도 health poll에서 늦게 관측되므로, action 반환 뒤에도 같은 attempt를 유지해야 한다.

## Plan

1. canonical chat transport readiness 판정을 production chat port와 startup이 공유하게 한다.
2. stop → abort gate → start → bounded readiness wait를 restart action으로 추출한다.
3. FakeClock 회귀 테스트로 in-flight budget 보존, readiness 성공, timeout 실패, abort를 고정한다.
4. `obs-stream`에만 action 이후 정본 health 회복 확인 window를 연결하고 FakeClock으로 성공·timeout·abort를 고정한다.
5. focused 및 전체 게이트를 실행하고 결과와 exact SHA/CI를 기록한다.

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| restart readiness timeout | `grpcStreamMinStartIntervalMs + supervisor.chatStart.timeoutMs` | 기존 provisional 값의 합 | T47 pacing 전체와 기존 chat readiness window를 모두 보장하며 새 임계값을 만들지 않는다. |
| OBS recovery verification timeout | `youtube.broadcast.autoStartWaitMs + healthPollIntervalMs` | 기존 provisional 값의 합 | YouTube ingest에 이미 허용한 최대 회복 시간 뒤 마지막 canonical status poll 한 번을 포함하며 새 임계값을 만들지 않는다. |

## Review round 1

- [blocker] `apps/server/src/supervisor/restart.ts` / `supervisor.ts`: action 이후 verification 중에도 `componentsToRestart()`가 `obs-stream`을 선택하지 않으면 generic `noteHealthy()`가 timer·in-flight·attempt budget을 지웠다. 따라서 `youtube.stream_status=unknown/status_unreadable`이고 같은 family의 다른 신호가 `ok`인 경우, 또는 `youtube.stream_health=degraded/health_bad`처럼 OBS restart 대상이 아닌 reason인 경우에도 `active` 관측 없이 recovery가 승인됐다.
- 고침 (`57880e4`): `StartStream` action 반환 시점의 canonical stream-status observation version을 캡처한다. 그 뒤 새 `youtube.stream_status=ok` 관측이 들어왔고 현재 관측도 `ok`일 때만 generic healthy acknowledgement가 verification을 끝낸다. production producer에서 이 `ok`는 명시적 `streamStatus=active`만 뜻한다.
- 회귀 (`supervisor.test.ts`, `restart.test.ts`): (1) status unknown + family aggregate `ok`, (2) status unknown + 별도 `health_bad` degraded reason은 timer/in-flight/attempts를 보존한다. (3) OBS-output-only 장애는 output 회복과 새 active status 뒤 정상 완료되며, 별도 `health_bad`는 supervisor를 degraded로 유지하되 OBS restart budget을 붙잡지 않는다.

## Review round 2

- [blocker] `RestartSupervisor`가 OBS recovery verification timeout 때 canonical observation version boundary를 지웠다. 이후 `youtube.stream_status=unknown`으로 family aggregate가 `ok`가 되거나 OBS restart 대상이 아닌 `health_bad` reason만 남으면 generic `noteHealthy()`가 실패한 attempt 1과 `lastError`를 초기화했다.
- 고침 (`64ac0b4`): action 직후 캡처한 canonical stream-status version boundary를 timeout·backoff·exhaustion 동안 보존한다. timeout 뒤에도 더 새로운 `recovered=true` observation, 즉 production의 명시적 `streamStatus=active`, 없이는 attempt/error를 초기화하지 않는다. 통합 회귀는 timeout 뒤 unknown이 attempt 1/error를 보존하고, 이후 `stream_inactive`가 attempt 2를 예약해 두 번째 timeout에서 maxAttempts=2로 bounded safe-stop하는 것을 고정한다.
- [blocker] 같은 `ChatSource`를 supervisor가 `stop()`→`start()`로 재사용할 때 이전 run의 `consecutiveFailures`와 `retryBudgetExhausted`까지 재사용했다. 따라서 새 zero-viewer gRPC transport가 `READY`여도 canonical transport signal은 unknown/degraded로 남아 restart readiness가 성공할 수 없었다.
- 고침 (`64ac0b4`): completed restart의 `start()` 경계에서 per-run failure budget인 `consecutiveFailures`와 `retryBudgetExhausted`만 초기화한다. last error, gRPC start pacing timestamp, durable checkpoint, outage/reconnect 측정, token rejection/reconnect counters, user-event facts는 보존한다. 한 번 실패한 prior run과 budget-exhausted prior run을 각각 production-shape FakeClock 테스트로 고정했고, 후자는 다음 actual start가 기존 T47 floor를 지키면서 checkpoint token으로 resume하고 outage/reconnect/user-event/quota 사실을 보존함을 증명한다.

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거 |
|---|---|---|---|
| 1 | canonical transport `ok` 뒤 completed | met | fix `89a64e7`: `ChatSource.transportReady()`가 정본 `youtube.chat.transport=ok`를 읽고 production startup/restart port가 같은 판정을 사용한다. `restartChatSource()`는 이 판정 전에는 반환하지 않는다. |
| 2 | 회복 대기 중 attempt 1회 유지 | met | `runtime.test.ts`: incident보다 긴 14초 동안 2초 간격 recovery request를 반복해도 모두 `in_flight`, attempts=1이며 readiness 뒤에만 완료된다. |
| 3 | pacing + readiness timeout, injected clock | met | production은 `chatRestartReadinessTimeoutMs(chatStart.timeoutMs, grpcStreamMinStartIntervalMs)`를 사용한다. shipped 30,000+25,000=55,000ms를 FakeClock으로 고정했고 unsafe integer 합은 거부한다. |
| 4 | timeout/backoff/exhaustion 및 abort 보존 | met | FakeClock에서 1,000ms readiness timeout이 `lastError`로 남고 두 번째 실패 뒤 기존 maxAttempts=2 exhaustion에 도달한다. stop-await abort는 start 0회, active wait abort는 pending timer 1→0을 증명한다. |
| 5 | startup 및 T47/T48 회귀 없음 | met | startup도 canonical readiness를 기다린다. `64ac0b4`는 chat restart에서 failure budget만 새로 열고 T47 pacing/checkpoint/outage·reconnect/token/user-event facts와 T48 halt를 보존한다. 전체 155 files/2,264 passed/1 skipped; contract/dependency/host/live 변경 0. |
| 6 | OBS action 이후 canonical health 회복까지 in-flight | met | `57880e4`가 action 뒤 fresh canonical version을 요구하고, `64ac0b4`가 그 boundary를 timeout 뒤에도 보존한다. timeout 뒤 unknown + aggregate ok가 attempt 1/error를 지우지 않고, 이후 inactive가 attempt 2를 예약해 maxAttempts=2에서 bounded safe-stop한다. OBS-output-only 장애의 fresh active 완료, stop timer 취소, production 120,000+20,000=140,000ms window도 유지된다. |
| 7 | focused + 5 gates + latest-head CI | unverifiable | fetch/rebase behind 0, `npm ci`, focused 5 files/127 passed, 로컬 5 gates와 `soak:ci`가 성공했다. 이 티켓 갱신으로 생기는 최종 head의 GitHub CI(`soak:ci` 포함)는 push 뒤 확인하고 PR evidence에 exact SHA/run을 기록한다. |

## Gates (executed)

```text
git fetch origin --prune
git rebase origin/main -> current branch up to date
git rev-list --left-right --count origin/main...HEAD -> 0 10 (이 result-only 티켓 commit 전)
npm ci                -> pass (431 packages; audit 경고 10건, dependency 변경 없음)
npx vitest run apps/server/src/supervisor/runtime.test.ts apps/server/src/supervisor/restart.test.ts apps/server/src/supervisor/supervisor.test.ts apps/server/src/youtube/chat/grpc-pacing.test.ts apps/server/src/youtube/chat/health.test.ts
                      -> pass (5 files; 127 passed)
npm run format:check  -> pass
npm run lint          -> pass (legacy imports 0; install scripts reviewed 4)
npm run typecheck     -> pass
npm run test          -> pass (155 files; 2,264 passed; 1 skipped)
npm run build         -> pass (schema/data map up to date; renderer/server/simulator/soak)
npm run soak:ci       -> pass (72.00h virtual scenario in 28.6s; 20/20 recoveries; final state live)
GitHub Actions CI     -> pending for the final result-only head; exact SHA/run은 PR evidence에 기록
```

## Not done / out of scope

- 실행 중 public 방송·server·OBS·renderer 재시작 또는 host scheduled task 변경.
- secret 조회·출력, contract/dependency 변경, 새 운영 임계값 도입.

## Follow-ups

- PR 독립 GPT 리뷰·머지 뒤 안전한 구간에 서버만 배포하고, 새 public segment에서 실제 restart recovery 시간을 관측한다.
