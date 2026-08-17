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
| `youtube.chat.reconnect.*` | initial 1000ms / max 60000ms / factor 2 / jitter 0.2 / maxAttempts 8 | provisional | 스펙 §11 "backoff로 재연결"만 요구. `maxAttempts`는 **포기 횟수가 아니라 degraded 보고 임계값**이다 — 소진 뒤에도 `maxDelayMs` 간격으로 계속 재연결한다(§2.1 무인성). 판정은 T12 |
| `youtube.chat.rest.minPollIntervalMs` / `requestTimeoutMs` | 2000 / 20000 | provisional | 서버가 준 `pollingIntervalMillis`를 **늘리기만** 하는 하한(주지 않거나 하한 미만일 때만 적용). 상한은 두지 않는다 — 서버가 요청한 것보다 빨리 폴링하는 것이 `rateLimitExceeded`의 문서화된 원인이다(round 1 M1) |
| `youtube.chat.readyPollIntervalMs` | `250` | provisional | 엔진 `ready`를 기다리는 폴링 간격. 스펙은 순서만 정한다(§7.3(3)) |
| `youtube.chat.fallback.*` | gRPC 연속 실패 3회 → REST, `retryPrimaryAfterMs` 300000 | provisional | 스펙은 "REST는 fallback"만 정함 |
| `liveChatId` 출처 | config `youtube.chat.liveChatId`(기본 `null`) 또는 주입된 resolver | — | T10 `broadcast_resources`는 아직 main에 없다(PR #11 리뷰 중). 명세 §T9가 허용한 config 주입 + resolver 포트로 두어 T10/T12가 배선한다 |

## Result

구현 완료. 새 파일은 `apps/server/proto/stream_list.proto`,
`apps/server/src/youtube/chat/*`(config·transport·sink·state·health·grpc-source·rest-source·
chat-source·retry·runtime), 테스트 지원 `apps/server/src/testing/`(fake-stream-list-server·
fake-live-chat-rest-server·tcp-breaker·chat-test-support), 운영 문서
`docs/ops/youtube-chat-source.md`. 기존 파일 수정은 `config/default.json`(`youtube.chat` 블록),
`apps/server/src/health/types.ts`(`HealthComponent`에 `youtube-chat` 추가),
`apps/server/src/server.ts`(`/health`의 `sources`), `apps/server/src/main.ts`(배선),
`apps/server/src/youtube/index.ts`(re-export), `scripts/check-install-scripts.mjs`(protobufjs 근거),
`apps/server/package.json`·`package-lock.json`(새 의존성 2개).

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 가짜 gRPC 서버(같은 proto)로 스트림 수신·token 재개·중간 끊김·poison item·REST 전환 테스트 통과 | met | `apps/server/src/youtube/chat/grpc-source.test.ts`(12), `rest-source.test.ts`(9), `chat-source.test.ts`(5), `sink.test.ts`(9). 끊김은 실제 소켓 절단(`testing/tcp-breaker.ts`) — grpc-js 서버의 `call.destroy()`는 클라이언트가 관측할 수 있는 것을 보내지 않음을 실험으로 확인하고 relay 방식으로 바꿨다. 전환은 `chat-source.test.ts > falls back to REST and keeps the same checkpoint`(REST 첫 요청의 `pageToken`이 gRPC가 저장한 token) |
| 2 | 요청 parts에 `authorDetails`가 없음을 테스트로 고정 | met | 3중으로 고정: (a) config 로더가 `parts`를 **정확히 `id,snippet`**으로만 받는다 — `authorDetails`는 물론 부분집합·중복도 거부(`config.test.ts`; round 1 M2에서 부분집합 허용을 고침), (b) 실제 wire에 도착한 요청을 검사(`grpc-source.test.ts > requests id,snippet only — never authorDetails`, `rest-source.test.ts > requests id,snippet only …`), (c) proto에 `author_details`가 존재함을 확인해 "요청하지 않는다"가 공허한 주장이 아님을 보임(`proto.test.ts`) |
| 3 | 실계정 없이 완료 판정 가능한 범위를 티켓에 명시하고 실계정 절차는 T16으로 | met | 아래 "Not done" + `docs/ops/youtube-chat-source.md` §4 |

추가로 구현·검증한 명세 항목:

- `next_page_token` checkpoint 복원·전진과 **같은 트랜잭션** 커밋(§7.3(2)): `sink.test.ts`(빈 응답도 전진, token 없는 응답은 이전 token 유지, 중복은 오류가 아니라 카운트).
- poison item에도 checkpoint 전진: `sink.test.ts > drops an item whose adapter throws …`, `> drops an envelope the contract schema would refuse`, `grpc-source.test.ts > commits a poison item as a minimal envelope and keeps going`.
- gRPC status별 처리: UNAVAILABLE 재시도, UNAUTHENTICATED/PERMISSION_DENIED는 T3 갱신 1회 후 중단(`AuthRevokedError`면 `auth_revoked`), FAILED_PRECONDITION/NOT_FOUND 중단, INVALID_ARGUMENT는 token 폐기 후 재연결 — `grpc-source.test.ts` 6개 케이스.
- REST `pollingIntervalMillis` 준수: 서버가 준 값보다 **짧게 기다리지 않는다**(로컬 하한은 늘리기만 한다). `rest-source.test.ts > never waits less than the interval the server asked for`(1시간 요청이 1시간 그대로), `> waits the interval the server asked for between polls`. round 1 M1에서 상한 절단을 제거했다.
- 건강 신호(§9.4(3)) 4종과 "무수신은 degraded가 아니다": `health.test.ts`(6시간 무수신에도 `ok`), `chat-source.test.ts > publishes the four health signals …`.
- 재연결 중복·손실 추정(§11): **관측된 것만** 센다. 재연결 = 수신 중이던 경로가 끊겼다가 응답이 실제로 다시 도착한 사건이며, 시도·재시도·평범한 REST 폴은 아무것도 바꾸지 않는다(round 1 M3에서 시도마다 세고 gap이 누적되던 것을 고쳤다). 중복은 `commitIngestBatch`의 실측값, 손실은 복구 응답을 만든 시도가 token을 제시했을 때만 0, 아니면 `null`. `health.test.ts`(cold start 미집계, outage 1회 gap 400ms, gRPC 끊김 1회 + REST 폴 2회 → count 1), `grpc-source.test.ts`.
- `engine.ready` 이전에는 수신하지 않음(§7.3(3)): `chat-source.test.ts > waits for the engine to finish its recovery drain before connecting`.

### Gates (executed)

```text
$ npm run format:check && npm run lint && npm run typecheck && npm run test && npm run build
All matched files use Prettier code style!
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)
tsc --build tsconfig.json                     (no output = pass)
Test Files  96 passed (96)
     Tests  1354 passed | 1 skipped (1355)
schema up to date (6 files)
copied 4 migration(s) to dist/db/migrations
docs/ops/data-map.md up to date
exit=0                                        (2026-08-17, this Windows 11 host, Node 24)

$ npx vitest run apps/server/src/youtube/chat
Test Files  8 passed (8)
     Tests  62 passed (62)

$ node -e "import('./apps/server/dist/youtube/chat/transport.js') …"
proto path from dist: …\apps\server\proto\stream_list.proto
client loaded from dist build: true          (빌드 산출물에서도 proto 경로가 풀린다)
```

## Not done / out of scope

**실계정 없이 판정할 수 없는 것** (합격 기준 3, 절차는 `docs/ops/gate2-experiments.md`(T16)):

1. `streamList`가 실제로 요구하는 OAuth scope. streamList 레퍼런스에는 Authorization 절 자체가
   없고 REST discovery에도 없다(T3가 `scopes.ts`에 `verified: false`로 남긴 그대로 — 이 task도
   확정하지 못했다). 실제 호출로만 확인된다.
2. 실제 keepalive 수용 범위. 설정한 5분/20초는 gRPC 공식 가이드의 서버 기본 허용치(`PERMIT_KEEPALIVE_TIME`
   300000ms) 안쪽이라는 근거뿐이고, YouTube가 공표한 값은 없다. `too_many_pings` GOAWAY 여부는 실측이다.
3. 스트림의 실제 수명·재연결 빈도·중복 수신량, 그리고 `pollingIntervalMillis`의 실제 값 범위.
4. `streamList`/`list`의 실제 quota 단위 비용(T3 `costs.ts`가 `documented: false`로 둔 값).
5. gRPC 응답 item의 실제 필드 조합(예: Gifts가 켜진 일본 채널의 `gift_details`). fixture는 [S3]/[S4]
   문서 기준이며 실제 응답으로 재확인해야 한다.

**범위 밖으로 둔 것**

- `liveChatId`를 T10 `broadcast_resources`에서 읽는 배선. T10(PR #11)이 아직 main에 없어 그 테이블이
  존재하지 않는다. `LiveChatTargetResolver` 포트만 두고 기본 구현은 config다(명세 §T9가 허용).
- 채팅 소스의 degraded/safe_stopped 판정과 알림. 이 task는 신호를 **보고만** 한다(§9.4 서문, T12).
- gRPC 채널 풀링([S4]가 동시 스트림이 많을 때 권고). 세계당 채팅 1개이므로 필요 없다.

## Follow-ups

- T12: `/health`의 `sources` 배열을 supervisor 상태기계에 연결하고, `youtube.chat.transport`가
  `degraded`로 오래 머물면 알림·safe_stopped 정책을 적용한다. `no_live_chat_id`는 T10 배선 신호다.
- T10/T12: `broadcast_resources`가 생기면 `resolveTarget`을 그 테이블 판독기로 바꾼다(`liveChatId`
  교체 시 소스 재시작 필요 — rolling broadcast 실험(A-4)에서 발생).
- T15 fault matrix: 이 소스가 만드는 상태(`retry`/`degraded`/`stopped`)를 행으로 넣고, inbox commit과
  token checkpoint 사이의 crash window는 이미 하나의 트랜잭션이라 해당 없음을 기록한다.
- T16: 위 "실계정" 5개 항목을 `docs/ops/gate2-experiments.md`로 옮긴다.
