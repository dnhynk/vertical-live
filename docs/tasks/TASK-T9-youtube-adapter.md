# TASK-T9-youtube-adapter

- Task: T9 YouTube source adapter — gRPC `streamList` + REST fallback (`docs/tasks/TASK_SPECS.md` §T9)
- Branch: `dnhynk/t9-youtube-adapter` · PR: #14
- Orca: task `task_ec3d66a159bd` · dispatch `ctx_054a70617198`
- Spec sections read: §4(streamList·ultra-low latency 행), §7.2, §7.3(1)(2)(3), §7.4, §9.4(3), §11(연결 복구·fault matrix), §12.4
- BOARD decisions/assumptions relied on: D-1, A-1(identity gate 닫힘), A-2, A-4, A-14, A-15

## Goal

YouTube Live Chat을 production 입력 경로로 연결한다. `liveChatMessages.streamList`(gRPC)를 기본
경로로, `liveChatMessages.list`(REST)를 fallback으로 두고, 두 경로 모두 **`part = id,snippet`만**
요청한다. 각 응답의 모든 item은 T1 adapter(shape별)로 최소 envelope가 되어 T8 엔진의
`ingest()` → `commitIngestBatch`로 들어가고, **재연결 token checkpoint가 같은 트랜잭션에서**
갱신된다. 한 item이 불량이어도 checkpoint는 전진한다. 끊기면 `next_page_token`으로 재개하고,
gRPC status를 T3의 분류·backoff·토큰 관리에 연결하며, §9.4(3) 건강 신호(transport·keepalive·
reconnect 횟수·마지막 token·마지막 사용자 이벤트 시각)와 재연결 중복·손실 추정치를 보고한다.
사용자 메시지가 없다는 사실만으로는 절대 degraded가 아니다.

## Plan

1. **proto 복사** — [S4] 가이드의 인라인 proto를 `apps/server/proto/stream_list.proto`로 복사한다
   (출처 URL·복사 날짜 헤더). 게시된 목록이 `google.protobuf.Duration`을 import 없이 참조해
   로더가 실패하므로 `import` 한 줄만 표시를 달아 추가하고, 그 외에는 손대지 않는다. 로드 가능
   여부와 우리가 읽는 필드가 그대로인지를 테스트로 고정한다.
2. **의존성** — `@grpc/grpc-js`, `@grpc/proto-loader`(exact version). 로더 옵션은 T1 티켓이
   전제로 문서화한 `keepCase: true, enums: String, longs: String, defaults: false`.
3. **`apps/server/src/youtube/chat/`**
   - `config.ts` — `youtube.chat` 블록(엔드포인트·part·keepalive·backoff·fallback 정책·
     REST 폴링 하한) 로드. 확정 근거가 없는 수치는 `provisional`.
   - `proto.ts` — proto 로드와 `StreamList` 클라이언트 생성(요청 part 강제 포함).
   - `sink.ts` — item 배열 → shape별 T1 adapter → 스키마 검사 → `ingest(envelopes, checkpoint)`
     1회. poison item은 개수를 세고 배치는 계속 커밋한다(checkpoint 전진).
   - `grpc-source.ts` — 스트림 수신 루프: checkpoint에서 `pageToken` 복원, 응답마다 sink 호출,
     끊기면 status 분류(T3 `classifyYouTubeApiError` + `decideRetry`) 후 backoff 재연결.
     `UNAUTHENTICATED`/`PERMISSION_DENIED`는 T3 `TokenManager` 갱신 1회 → 실패면 중단 사유 보고.
   - `rest-source.ts` — `liveChatMessages.list` 폴링. 서버가 준 `pollingIntervalMillis`를 지키고
     checkpoint(`nextPageToken`)를 gRPC와 **공유**한다.
   - `health.ts` — §9.4(3) 신호. 무수신은 `ok` + `lastUserEventAt` 상세로만 보고.
   - `chat-source.ts` — gRPC 우선, 연속 실패 시 REST로 전환, 냉각 후 gRPC 복귀. `liveChatId`는
     주입된 resolver(T10 `broadcast_resources`, 없으면 config)에서 얻는다. `engine.ready`를
     기다린 뒤에만 수신을 시작한다(§7.3(3)).
4. **가짜 서버** — `apps/server/src/testing/fake-stream-list-server.ts`(같은 proto를 쓰는 실제
   `@grpc/grpc-js` 서버, loopback 임의 포트)와 `fake-live-chat-rest-server.ts`(node http).
   수신·token 재개·중간 끊김·poison item·REST 전환·`authorDetails` 미요청을 테스트한다.
5. **main.ts 배선** — 설정에 `liveChatId`가 있을 때만 기동(없으면 비활성). `/health`에 chat 신호.
6. **실계정 검증 범위** — mock으로 판정 가능한 것과 실계정이 필요한 것을 아래 "Not done"에
   명시하고 절차는 `docs/ops/gate2-experiments.md`(T16)로 넘긴다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| [S4] Streaming Live Chat 가이드(인라인 proto·데모) | https://developers.google.com/youtube/v3/live/streaming-live-chat | 2026-08-17 | 엔드포인트 `dns:///youtube.googleapis.com:443`, TLS 채널, 메타데이터 `authorization: "Bearer " + token`(또는 `x-goog-api-key`). 데모는 응답마다 `next_page_token`을 갱신하고 스트림이 끝나면 그 token으로 다시 연다. 동시 스트림이 많으면 채널 풀링 권고. proto는 `proto2`, snake_case, `LiveChatMessageListResponse{offline_at, page_info, next_page_token, items, active_poll_item}` — **`polling_interval_millis` 필드는 없다**. `LiveChatGiftDetails.gift_duration`이 `google.protobuf.Duration`을 import 없이 참조 |
| [S4] streamList 레퍼런스 | https://developers.google.com/youtube/v3/live/docs/liveChatMessages/streamList | 2026-08-17 | "Each response also includes a nextPageToken. If your client disconnects, you can use this token to resume the stream." `part` 지원값 `id`,`snippet`,`authorDetails` → V1은 `id,snippet`. gRPC 오류: `PERMISSION_DENIED(7)`, `INVALID_ARGUMENT(3)`, `FAILED_PRECONDITION(9)`(LIVE_CHAT_DISABLED / LIVE_CHAT_ENDED), `NOT_FOUND(5)`, `RESOURCE_EXHAUSTED(8)`("The request was sent too quickly after the previous request"). 응답 JSON 예시에는 `pollingIntervalMillis`가 있으나 **속성 표에는 정의가 없고 proto에도 없다** → gRPC 경로에서는 쓰지 않는다 |
| [S3] liveChatMessages.list 레퍼런스 | https://developers.google.com/youtube/v3/live/docs/liveChatMessages/list | 2026-08-17 | "The pollingIntervalMillis property indicates how long your API client should wait before requesting additional results." = "The amount of time, in milliseconds, that the client should wait before polling again". 문서 첫 줄이 폴링 대신 `streamList`를 쓰라고 안내한다(quota 절약). 오류: `403 forbidden`, `403 liveChatDisabled`, `403 liveChatEnded`, `404 liveChatNotFound`, `rateLimitExceeded`("sent too quickly after the previous request") |
| gRPC keepalive 옵션 | https://grpc.io/docs/guides/keepalive/ · https://github.com/grpc/grpc/blob/master/doc/keepalive.md | 2026-08-17 | 채널 인자 `grpc.keepalive_time_ms`, `grpc.keepalive_timeout_ms`, `grpc.keepalive_permit_without_calls`. 서버가 정책보다 자주 오는 ping을 GOAWAY로 끊을 수 있으므로 기본 권고(최소 간격 5분 이상, 클라이언트 기본 무한)를 넘지 않는 값만 쓴다 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음 — 스펙·명세·공식 문서로 확정됨) | | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `youtube.chat.grpc.endpoint` | `youtube.googleapis.com:443` | 확정 | [S4] 데모의 `dns:///youtube.googleapis.com:443` |
| `youtube.chat.parts` | `["id","snippet"]` | 확정 | 스펙 §7.2. `authorDetails`는 identity gate가 열릴 때만 |
| `youtube.chat.maxResults` | `500` | 확정(문서 기본값) | [S4] 레퍼런스 "The default value is 500", 허용 200–2000 |
| `youtube.chat.grpc.keepalive.*` | time 300000ms / timeout 20000ms / permitWithoutCalls false | provisional | 공식 keepalive 가이드의 "5분 미만 ping 금지" 권고 안쪽. YouTube가 공표한 값은 없음 |
| `youtube.chat.reconnect.*` | initial 1000ms / max 60000ms / factor 2 / jitter 0.2 / maxAttempts 0(무한) | provisional | 스펙 §11 "backoff로 재연결"만 요구. 채팅 수집은 포기하면 무인성이 깨지므로 시도 상한을 두지 않고 T12가 degraded를 판정 |
| `youtube.chat.rest.minPollIntervalMs` | `2000` | provisional | 서버가 `pollingIntervalMillis`를 주지 않은 응답에서만 쓰는 하한. 문서에 기본값 없음 |
| `youtube.chat.fallback.*` | gRPC 연속 실패 3회 → REST, `retryPrimaryAfterMs` 300000 | provisional | 스펙은 "REST는 fallback"만 정함 |
| `liveChatId` 출처 | config `youtube.chat.liveChatId`(기본 `null`) 또는 주입된 resolver | — | T10 `broadcast_resources`는 아직 main에 없다(PR #11 리뷰 중). 명세 §T9가 허용한 config 주입 + resolver 포트로 두어 T10/T12가 배선한다 |

## Result

(구현 후 채움)

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
(구현 후 채움)
```

## Not done / out of scope

- (구현 후 채움)

## Follow-ups

- (구현 후 채움)
