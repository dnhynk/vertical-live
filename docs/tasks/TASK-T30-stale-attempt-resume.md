# TASK-T30-stale-attempt-resume

- Task: T30 끝난 방송에 묶인 attempt가 닫히지 않아 두 번째 방송을 시작할 수 없다 (`docs/tasks/TASK_SPECS.md` §T30)
- Branch: `dnhynk/t30-stale-attempt-resume` · PR: #<n>
- Spec sections read: §9.1(방송 lifecycle·reconcile·"결론이 나지 않으면 재시도하지 않는다"), §9.2(상태 전이)
- BOARD decisions/assumptions relied on: D-2, A-18

## Goal

첫 방송이 끝난 뒤에도 다음 기동이 방송을 시작할 수 있게 한다. 지금은 열린 attempt가 끝난 방송을 가리킨 채 남아 있고, 재개가 그것을 무조건 채택해 모든 기동이 같은 방식으로 죽는다.

## 원인

`resume()`이 `findOpenBroadcastAttempt()`로 **열린 attempt를 검증 없이 채택**한다. attempt가 닫히는 유일한 경로인 `stopBroadcast()`는 **코드베이스 어디에서도 호출되지 않는다**(`lifecycle.ts`와 그 테스트 밖 참조 0건) — 정상 종료든 safe stop이든 row는 `stage=live`, `closed_at=NULL`로 남는다. 그 사이 YouTube는 인코더가 사라진 방송을 `complete`로 옮기고, 끝난 방송에는 live chat이 없다.

2026-08-23 05:04 UTC 실측(호스트 `WORKSTATION`, T28 실측을 시도하다가):

```text
broadcast_resources  attempt 22d0ba05…  stage=live  closed_at=NULL  broadcast=1c8WAFCmAQI
youtube_broadcast      degraded  lifecycle_complete
youtube.chat.transport degraded  failedPrecondition   (gRPC status 9, 기동 1초 뒤)
chat-source 재시작 3/3 (05:04:47 → 05:04:58) → safe stop 05:05:06
safeStop.reason = chat-source:chat_transport+youtube_broadcast
```

`chat_transport`는 `stopped` 사유로 **유예 창을 거치지도 않고** degraded가 되므로 재시작 예산이 11초 만에 소진된다. 즉 **첫 방송 이후 무인 운전이 성립하지 않는다.**

## 변경

- `resume()`이 결과를 `#stillResumable()`로 통과시킨다. 열린 attempt가 broadcast id를 가지고 있으면 `liveBroadcasts.list({ids})`로 lifecycle을 읽고,
  - 재개 가능(`created`·`ready`·`testStarting`·`testing`·`liveStarting`·`live`)이면 그대로 채택한다 — §9.1의 크래시 복구는 그대로다.
  - `complete`·`revoked`이면 attempt를 `abandoned`로 닫고(`lastErrorReason = broadcast_<status>`) `null`을 돌려준다 → `ensureBound()`가 새 attempt를 시작한다.
  - id 조회 결과가 비어 있으면(리소스 삭제) `broadcast_missing`으로 같은 처리를 한다. id 조회는 marker 검색과 달리 **절단될 수 없으므로** 결론으로 삼을 수 있다.
  - lifecycle을 읽지 못하거나(`list` 실패) 상태가 `null`이면 **아무것도 결정하지 않고 올린다**(§9.1). 시작 순서가 backoff로 재시도한다.
- 닫힌 attempt는 `resume()`이 `null`로 답한다. 닫힌 attempt를 그대로 돌려주면 `ensureBound()`가 `stageAtLeast`로 생성 단계를 건너뛰고 끝난 방송에 bind·go-live를 시도한다.
- 검증은 **프로세스가 attempt를 처음 넘겨받을 때 한 번만** 한다(`#pickedUpAttemptId`). `resume()`은 `goLive()` 진입에서도 돌기 때문에, 이 프로세스가 직접 만들었거나 이미 확인한 attempt에 매번 `liveBroadcasts.list`(quota 1)를 쓰는 것은 실제 비용이다.
- alert 종류 `attempt_discarded` 추가. 소비자는 `main.ts`의 로깅 sink 하나뿐이다.

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 재개 가능 lifecycle 목록 | `created`·`ready`·`testStarting`·`testing`·`liveStarting`·`live` | 확정 | `LiveBroadcastSummary.lifeCycleStatus`가 문서화한 8개 값에서 끝 상태 `complete`·`revoked`만 제외했다 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | `complete` 방송에 묶인 열린 attempt를 재사용하지 않고 새 방송을 만든다. 닫힌 attempt에 사유가 남는다 | met | `lifecycle.test.ts` "discards an open attempt whose broadcast has completed and starts a new one" — `stage=abandoned`, `lastErrorReason=broadcast_complete`, 새 `broadcastId`. 삭제된 방송은 "…no longer exists"(`broadcast_missing`) |
| 2 | 재개 가능한 attempt는 여전히 재개된다 | met | "still resumes an attempt whose broadcast is live" — 같은 attemptId·broadcastId, `closedAt` null. 기존 62건 무수정 통과 |
| 3 | 실측: stale row를 둔 채 기동해 `live`에 도달하고, 같은 기동으로 T28 합격 기준 1을 확인한다 | met | 아래 실측 — stale attempt가 `broadcast_complete`로 닫히고 새 방송 `z6yv6yNbcPw`가 `live`에 도달했다. 같은 스냅샷이 T28 기준 1을 만족한다 |
| 4 | 게이트 5개 + CI 녹색 | met (CI는 PR에서) | 아래 Gates |

부수: "decides nothing when the lifecycle cannot be read"가 §9.1의 불확정 규칙을 고정하고, "asks YouTube once per process, not once per resume"가 quota 비용을 고정한다.

**반증 확인**: `lifecycle.ts`·`alerts.ts`만 되돌리면 4건이 실패한다(`4 failed | 59 passed`).

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> ok (0 legacy imports; 4 install scripts reviewed)
npm run typecheck    -> exit 0
npm run test         -> 150 files | 2171 passed | 1 skipped
npm run build        -> exit 0
npm run soak:ci      -> exit 0 (임계값 not-locked 유지, A-15)
```

## 실측 (2026-08-23 05:23–05:33 UTC, 호스트 `WORKSTATION`)

`Start-VerticalLive.ps1 -WithObs` + `VL_BROADCAST_ENABLED=true`·`VL_YOUTUBE_CHAT_ENABLED=true`로 기동. 시작 시점의 DB에는 실패한 앞선 기동이 남긴 stale row가 그대로 있었다(attempt `22d0ba05…`, stage `live`, `closed_at` NULL, broadcast `1c8WAFCmAQI`).

```text
05:23:48  attempt 22d0ba05… → stage=abandoned  last_error_reason=broadcast_complete  closed_at 기록
          새 attempt 9bb6d5b4…  broadcast z6yv6yNbcPw  (private)
05:29:32  supervisor=live      lastTransitionReason=signals:all_families_ok
05:33     여전히 live, safeStop=null, 재시작 예산 소진 0건(모든 component attempts=0)

families:  coordinator=ok state_commit=ok chat_transport=ok renderer=ok
           obs_output=ok youtube_broadcast=ok frame_loss=ok dead_man=unknown(비활성)

youtube.chat.transport = ok
{"mode":"grpc","connected":false,"channelState":"READY","consecutiveFailures":0,
 "retryBudgetExhausted":false,"lastErrorKind":null,"lastResponseAt":"2026-08-23T05:32:12.671Z",
 "streamOfflineAt":null}

renderer: {"frameCounter":15291,"fps":30,"webglContextLost":false,"lastAppliedStateRevision":2223}
```

`connected:false` + `channelState:READY` + `ok` — 시청자가 아무도 입력하지 않는 채팅에서 transport가 서 있다고 보고하는 상태이며, 수정 전에는 이것이 `unknown:reconnecting`이었다. 3분 넘게 유지됐고 `chat-source` 재시작은 한 번도 요구되지 않았다. 같은 상태가 시작 직후뿐 아니라 운영 중에도 반복해서 나타난다(서버가 장수 호출을 정상 종료할 때마다 `connected`가 내려가고 채널은 `READY`로 남는다).

## Not done / out of scope

- **`stopBroadcast()`의 호출부를 만들지 않았다.** 이 변경으로 "attempt가 영원히 열린 채 남는다"는 구멍은 그것이 실제로 해를 끼치는 지점(재개)에서 닫힌다. 종료할 때 YouTube의 방송을 `complete`로 옮길지는 **운영 정책 결정**이다 — 운영자가 Studio에서 보는 것이 달라지고, 스펙 §9.2는 `safe_stopped`에 그런 요구를 두지 않는다. 결정 없이 wiring하지 않고, 검증된 메서드를 지우지도 않는다. 사용자 결정 대상으로 BOARD에 올린다.
- 재시작 예산·유예 시간 조정.

## Follow-ups

- 위 `stopBroadcast()` 정책 결정.
- 부수 관측(이 task 범위 밖, BOARD 이력 2026-08-23): 서버가 실제로 여는 DB는 `config/data/vertical-live.db`인데 CLAUDE.md §6·런북은 `data/vertical-live.db`로 적는다. `db.file`이 config 파일 위치 기준으로 풀리는 것으로 보인다.
