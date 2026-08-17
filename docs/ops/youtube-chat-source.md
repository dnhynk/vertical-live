# YouTube 채팅 수집 켜기 (T9)

> 대상: `liveChatMessages.streamList`(gRPC) 기본 경로 + `liveChatMessages.list`(REST) fallback.
> 코드: `apps/server/src/youtube/chat/`, 인증은 `docs/ops/youtube-auth-setup.md`(T3)가 먼저다.

## 1. 무엇이 켜지는가

`youtube.chat.enabled = true`이면 서버는 시작 시 다음을 한다.

1. 엔진이 inbox drain을 마치고 `ready`가 될 때까지 기다린다(스펙 §7.3(3)). 그 전에는 한 건도 받지 않는다.
2. `source_checkpoint`에서 `youtube:{liveChatId}` 행의 `next_page_token`을 복원한다.
3. gRPC `StreamList`를 열고(`part = id,snippet`, `authorDetails` 없음) 응답마다 item과 token을
   **하나의 트랜잭션**으로 inbox에 commit한다(§7.3(2)).
4. 끊기면 마지막 token으로 재연결한다. gRPC가 연속 실패하면 REST 폴링으로 넘어가고
   (`pollingIntervalMillis` 준수), 냉각 시간 뒤 다시 gRPC를 시도한다. checkpoint는 공유한다.

## 2. 설정

`config/default.json`의 `youtube.chat` (env override 포함):

| 키 | 기본값 | 성격 |
|---|---|---|
| `enabled` | `false` | 마스터 스위치 |
| `liveChatId` | `null` (env `VL_YOUTUBE_LIVE_CHAT_ID`) | T10의 `broadcast_resources`가 붙기 전에는 여기에 넣는다 |
| `broadcastId` | `null` (env `VL_YOUTUBE_BROADCAST_ID`) | `eventKey`에 들어간다(§7.4) |
| `parts` | `["id","snippet"]` | **고정.** `authorDetails`를 넣으면 서버가 기동을 거부한다(§7.2, A-1) |
| `maxResults` | `500` | 공식 기본값(허용 200–2000) |
| `grpc.endpoint` | `youtube.googleapis.com:443` | [S4] 데모의 주소 |
| `grpc.keepalive` | 300000 / 20000 / false | provisional. gRPC 공식 가이드의 서버 기본 허용치(5분) 안쪽 |
| `rest.minPollIntervalMs` / `maxPollIntervalMs` | 2000 / 60000 | provisional. 서버가 준 간격을 이 범위로만 clamp한다 |
| `reconnect.*` | 1000 / 60000 / 2 / 0.2 / 8 | provisional. `maxAttempts`는 포기 횟수가 아니라 **degraded 보고 임계값**이다 |
| `fallback.*` | 3 / 300000 | provisional. 연속 실패 3회 → REST, 5분 뒤 gRPC 재시도 |

`liveChatId`가 없으면 소스는 연결하지 않고 `youtube.chat.transport` 신호를
`degraded / no_live_chat_id`로 보고한다. 조용히 성공한 척하지 않는다.

## 3. 건강 신호 (`GET /health` → `sources`)

| 신호 | ok | degraded | unknown |
|---|---|---|---|
| `youtube.chat.transport` | 수신 중 | 중단(권한·채팅 종료 등), 재시도 예산 소진 | 미시작, 재연결 중 |
| `youtube.chat.keepalive` | 채널 READY/IDLE | 채널 TRANSIENT_FAILURE | REST 경로, 채널 없음 |
| `youtube.chat.reconnect` | 정상 | resume token을 잃은 재연결 | — |
| `youtube.chat.user_events` | **항상** | — | — |

`user_events`가 항상 `ok`인 것은 의도다: 스펙 §9.4(3)이 "사용자 메시지 무수신만으로 degraded
판정하지 않음"을 요구한다. 시청자가 없어도 세계는 진행한다(§2.1). 마지막 사용자 이벤트 시각은
`detail.lastUserEventAt`으로만 보고하고, 그것으로 상태를 바꾸지 않는다.

재연결 시 `detail`에 중복·손실 추정치가 있다(§11): `estimatedDuplicates`는 inbox가 이미 갖고
있던 event key 수(측정값), `estimatedLostMessages`는 token으로 재개했으면 `0`, 제시할 token이
없었으면 `null`(= 알 수 없음)이다. **추측한 숫자를 넣지 않는다.**

## 4. 실계정으로만 확인되는 것

mock으로는 판정하지 않는다. 절차는 `docs/ops/gate2-experiments.md`(T16)로 넘긴다.

- `streamList`가 실제로 요구하는 OAuth scope(공식 문서에 Authorization 절이 없다 — `scopes.ts`의
  `verified: false` 참조).
- 실제 keepalive 정책(서버가 `too_many_pings`로 GOAWAY를 보내는지) 및 스트림 최대 수명.
- 실제 `pollingIntervalMillis` 값의 범위와 `rateLimitExceeded` 발생 지점.
- `streamList`/`list`의 실제 quota 단위 비용.
- 장시간(수 시간) 연결에서의 재연결 빈도와 중복 수신량.
