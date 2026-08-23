# TASK-T29-token-rejected-sticky

- Task: T29 거부된 resume token 하나가 `chat_transport`를 영구 degraded로 만든다 (`docs/tasks/TASK_SPECS.md` §T29)
- Branch: `dnhynk/t29-token-rejected-sticky` · PR: #<n>
- Spec sections read: §9.4(3)(채팅 건강 신호), §9.2(상태 전이), §11(재접속·유실 추정)
- BOARD decisions/assumptions relied on: —

## Goal

resume token이 한 번 거부됐다는 이유로 스택이 `safe_stopped`에 빠지지 않게 한다.

## 원인

`recordTokenRejected()`가 세운 `#tokenRejected`를 어디서도 지우지 않고, `reconnect()`가 그 값을 `degraded:resumed_without_token`으로 매핑한다. 이후는 T28과 같은 경로다:

1. `chat_transport` family는 degraded 신호 **하나**로 degraded가 된다(`signals.ts` `#verdict`).
2. `componentsToRestart`가 `chat-source` 재시작을 지시한다.
3. 재시작 액션(`main.ts`)은 **같은 `ChatSource` 인스턴스**를 stop→start 하므로 `ChatSourceState`가 살아남고 플래그도 남는다.
4. 재시작 예산은 family가 건강해질 때만 반환된다(`restart.ts` `noteHealthy`) → 반환되지 않는다 → `restart.maxAttempts['chat-source']=3` 소진 → `safe_stopped`.

코드 독해로 확정했고 실측은 없다(토큰 거부를 실제로 유발하려면 서버가 저장된 토큰을 거부해야 한다).

## 판정: 만료가 아니라 판정 제거

명세 초안은 "다음 재접속이 응답을 받으면 `ok`로 돌아온다"였다. 구현하면서 **짧게라도 degraded로 두는 설계 자체가 같은 해를 만든다**는 것을 확인했으므로 판정을 없애는 쪽으로 정했다. 근거 둘:

- **재시작이 고칠 수 있는 종류가 아니다.** 거부된 토큰이 뜻하는 것은 **이미 일어난 유실**이다. `chat-source` 재시작은 그 메시지를 되돌리지 못하고, 연결을 한 번 더 끊어 유실 구간을 넓힌다.
- **예약된 재시작은 취소되지 않는다.** `RestartSupervisor.noteHealthy()`는 `#inFlight`(= 재시작이 예약된 순간부터 true)면 즉시 반환한다. 그래서 "회복될 때까지만 degraded"로 두면 backoff 지연 뒤 재시작이 **회복 중인 연결을 끊으며** 실행된다.

그래서 `youtube.chat.reconnect`는 `youtube.chat.user_events`와 같은 성격이 된다 — 기록하되 판정하지 않는다. §9.4(3)이 요구하는 기록은 detail로 남는다.

## 변경

- `reconnect()`가 항상 `ok`를 낸다. detail에 `tokenRejected`·`tokenRejections`·`lastTokenRejectedAt`을 넣어 무슨 일이 있었는지 `/health`에서 읽힌다.
- `ChatSourceState`가 거부 횟수와 마지막 거부 시각을 센다(`recordTokenRejected`).
- `health.ts` 머리말에서 "resume token을 포기한 재접속"을 degraded 사유 목록에서 뺐다.
- 임계값·재시도 횟수·재시작 경로는 건드리지 않았다.

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 토큰이 거부돼도 `reconnect`가 degraded가 되지 않고, 거부 횟수·시각이 detail에 남는다 | met | `health.test.ts` "records a reconnect that lost its resume token without calling it a fault"(`status=ok`, `tokenRejections:1`, `lastTokenRejectedAt`), "leaves the family free to recover after a refused token"(거부 이력 + 건강한 transport에서 degraded 신호 0건) |
| 2 | 토큰이 계속 거부되는 동안에는 여전히 문제로 보인다 | met | `grpc-source.test.ts` "keeps reporting a refusal that never resolves, through the transport signal" — 저장된 토큰이 거부되고 토큰 없는 재시도도 거부되면 소스가 멈추고 `youtube.chat.transport`가 `degraded:invalidRequest`. `reconnect`는 `ok`로 기록만 한다 |
| 3 | 게이트 5개 + CI 녹색 | met (CI는 PR에서) | 아래 Gates |

**반증 확인**: `health.ts`만 되돌리면 3건이 실패한다(`3 failed | 35 passed`).

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> ok (0 legacy imports; 4 install scripts reviewed)
npm run typecheck    -> exit 0
npm run test         -> 150 files | 2173 passed | 1 skipped
npm run build        -> exit 0
npm run soak:ci      -> exit 0 (임계값 not-locked 유지, A-15)
```

실측은 하지 않았다: 토큰 거부를 실제 방송에서 유발하려면 YouTube가 저장된 토큰을 거부해야 하고, 그것을 의도적으로 만들 방법이 없다. 대신 실제 gRPC 서버를 쓰는 `grpc-source.test.ts`가 거부 응답을 직접 낸다.

## Not done / out of scope

- 재시작 액션이 `ChatSource` 인스턴스를 재사용해 상태가 살아남는 것 자체는 그대로 뒀다. 그것은 절반의 원인이고, 고칠 곳은 "언제 degraded인가"라는 것이 §T29의 판단이다.
- 예약된 재시작이 family 회복 시 취소되지 않는 것(`noteHealthy`의 `#inFlight` 조기 반환)도 그대로 뒀다. 이 task의 판정 근거로만 썼다 — 바꾸면 T12의 재시작 의미론 전체에 영향이 간다.

## Follow-ups

- resume token 유실을 운영자에게 **알림**으로 낼지. `/health` detail에는 남지만 사람을 깨우지는 않는다. 알림 정책은 D-13(호출표)의 범위이므로 별도 결정이 필요하다.
