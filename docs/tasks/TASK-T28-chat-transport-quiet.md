# TASK-T28-chat-transport-quiet

- Task: T28 조용한 채팅에서 `chat_transport`가 `ok`에 도달하지 못한다 (`docs/tasks/TASK_SPECS.md` §T28)
- Branch: `dnhynk/t28-chat-transport-quiet` · PR: #<n>
- Spec sections read: §2.1(시청자 0명), §9.2(상태 전이), §9.4(3)(채팅 건강 신호)
- BOARD decisions/assumptions relied on: D-2, D-13

## Goal

시청자가 아무도 입력하지 않는 라이브 채팅에 붙었을 때도 `chat_transport`가 `ok`가 되게 한다. 스펙 §2.1이 시청자 0명을 정상으로 규정하므로 조용한 채팅은 장애가 아니고, 그 상태에서 스택이 `safe_stopped`로 끝나면 안 된다.

## 원인

`health.ts`의 `transport()`가 `ok`를 주는 유일한 조건이 `observation.connected`이고, `state.ts`의 `connected`는 `recordResponse()` — **서버가 메시지 페이지를 보냈을 때** 선다. gRPC 채널이 `READY`여도 조용한 채팅은 20초 넘게 아무것도 보내지 않으므로 그 사이 신호는 `unknown:reconnecting`이다.

거기서 스스로 무너진다:

1. `chat_transport`는 required family(`config/default.json` `supervisor.requiredFamilies`)다.
2. 집계기가 required family의 `unknown`을 `unobservableGraceMs`(30s) 뒤 `degraded:unobservable:reconnecting`으로 승격한다(`signals.ts` `#verdict`).
3. `componentsToRestart`가 degraded `chat_transport` → `chat-source` 재시작을 지시한다(`transitions.ts:159`).
4. 재시작(`main.ts:613`)은 같은 인스턴스를 stop→start 하고, `stop()`이 gRPC transport를 닫는다 → 첫 응답 대기가 처음부터 다시 시작된다. **재시작이 회복을 되돌리므로 수렴하지 않는다.**
5. `restart.maxAttempts['chat-source'] = 3` 소진 → `safe_stop: restart_budget_exhausted (chat-source:chat_transport)`.

2026-08-23 첫 private 기술 방송(`1c8WAFCmAQI`, 호스트 `WORKSTATION`)에서 실측한 1초 해상도 추적이 TASK_SPECS §T28에 있다: `+3s` 채널 `READY`, `+22s` 첫 응답, `+28s` 재시작, `+40s` safe stop. required family 6개 중 5개는 `ok`였다.

같은 파일의 keepalive 주석은 이미 "a quiet chat legitimately sends nothing for a long time"이라고 적어 두었다 — 그 판단이 transport 신호에만 적용되지 않았다.

## Plan

1. `transport()`가 **연결되어 있다는 사실**과 **메시지를 받았다는 사실**을 분리한다: `connected`가 아니어도 gRPC 채널이 `READY`이고 연속 실패가 없으면 `ok`.
2. 판별할 수 있도록 transport detail에 `channelState`를 넣는다(`connected:false` + `channelState:'READY'` + `ok`가 그 자체로 읽힌다).
3. REST 경로는 손대지 않는다 — 폴 응답마다 `recordResponse()`가 서고 실패에서만 `recordDisconnect()`가 내리므로 폴 주기를 지키는 동안 이미 `connected`다.
4. 회귀 테스트: 조용한 READY 채널 → `ok`; 연속 실패 중 READY 채널 → `ok` 아님; 채널 실패·retry budget 소진·stop → 기존대로 degraded 경로.
5. 실측: 방송 하나를 띄워 `/health` 스냅샷을 이 티켓에 남긴다.

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| gRPC `READY`를 연결 증거로 보는 것 | 채택 | 확정(스펙 §T28 범위 문구) | `getConnectivityState`가 `READY`면 엔드포인트와 HTTP/2 연결이 서 있다는 뜻이다. 서버가 호출 자체를 거부하면 `onError` → `recordFailure`로 연속 실패가 올라가고, 그 경로는 아래 4번 가드가 잡는다 |
| 연속 실패 가드(`consecutiveFailures === 0`) | 채택 | 확정 | 이것이 없으면 매 호출이 즉시 실패하는 채널도 `READY`인 동안 `ok`로 보인다. 가드가 있으면 기존 `unknown:reconnecting` → 유예 후 degraded 경로가 그대로 유지된다 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 메시지가 한 건도 없는 라이브 채팅에서 `chat_transport`가 `ok`가 되고 supervisor가 `live`에 도달한다 | | |
| 2 | 실제로 끊겼을 때는 여전히 degraded로 내려간다 | | |
| 3 | 게이트 5개 + CI 녹색 | | |

### Gates (executed)

```text
```

## Not done / out of scope

- 임계값·재시도 횟수 조정(스펙 §T28이 명시적으로 금지).
- REST 경로 변경.

## Follow-ups

