# TASK-T10-broadcast-lifecycle

- Task: T10 broadcast lifecycle·reconcile·한도 처리 (`docs/tasks/TASK_SPECS.md` §T10)
- Branch: `dnhynk/t10-broadcast-lifecycle` · PR: #11
- Orca: task `task_41769f69d4b7` · dispatch `ctx_a44401984418`
- Spec sections read: §4(liveBroadcasts·12h archive 행), §9.1, §9.2, §9.3, §9.4(6), §10.2, §11, §12.2, §12.4, §17
- BOARD decisions/assumptions relied on: D-1, D-2, A-4(전략 기본 `single`), A-14(공용 규격), A-15(provisional 숫자), A-16(stream key = vault 정본)

## Goal

YouTube 방송 자원(liveStream · liveBroadcast)의 생명주기를 서버가 소유하게 만든다. 각 외부 호출 **전에** 시도의 단계와 이미 알고 있는 외부 ID를 `broadcast_resources`에 영속하고, 결과가 불확실하면(timeout·소켓 오류·5xx) `list`로 실제 상태를 reconcile한 뒤에만 재시도한다. 3종 한도 오류에서는 새로 만들지 않고 기존 방송 복구를 먼저 시도하며, 불가능하면 `safe_stopped` 요청 + alert hook으로 끝낸다. stream key는 vault에만 들어가고 반환값·로그·DB·health 신호 어디에도 나타나지 않는다. 상태 기계(T12)와 chat 수신(T9)은 이 모듈이 만든 read model(`BroadcastAttemptRecord`·`BroadcastTarget`, `HealthSignal`)만 소비한다.

## Plan

1. **정본 사실 확정(먼저)**: liveBroadcasts insert/bind/transition/list, liveStreams insert/list, liveBroadcast·liveStream 리소스, Live Streaming API 오류표, 일일 생성 한도 Help 문서를 읽고 표(아래 "Sources consulted")로 고정한다. 9:16 관련 필드가 API에 있는지, 일일 한도 reason 문자열이 공개돼 있는지를 특히 확인한다.
2. **migration 002**: 001의 `broadcast_resources`는 "T10이 컬럼을 확정한다"는 skeleton이고 어떤 코드도 쓰지 않는다(grep: 001과 migrate.test.ts의 테이블 목록 뿐). 001은 적용 후 수정 금지이므로 `002_broadcast-resources.sql`에서 skeleton을 대체한다(파일명은 runner의 `NNN_lower-kebab-name.sql` 패턴에 맞춘 kebab-case; **round 1 m2로 003으로 재번호** — PR #10이 002를 씀). 컬럼: 시도 식별자(attempt_id) PK, strategy, stage, **pending_call**(호출 직전 기록·결과 확정 후 해제), pending_since, stream_id, broadcast_id, live_chat_id, scheduled_start_time(insert reconcile 키), stream_title(liveStreams 재사용·reconcile 키), auto_start_supported, last_error_reason, created_at/updated_at/closed_at.
3. **`PersistenceStore` 확장**(T4가 정한 유일 writer 인터페이스): `beginBroadcastAttempt`, `markBroadcastCallPending`, `recordBroadcastCallResult`, `closeBroadcastAttempt`, `getBroadcastAttempt`, `findOpenBroadcastAttempt`, `listBroadcastAttempts`. 단계 전진은 단조(monotonic) — 뒤로 가는 전이는 거부.
4. **`youtube/broadcast/api.ts`**: `liveStreams.insert|list`, `liveBroadcasts.insert|bind|transition|list`를 REST로 호출하는 얇은 클라이언트. `fetch` + `AbortSignal`(주입 `Clock`), base URL 주입, 응답에서 `cdn.ingestionInfo.streamName`(= stream key)을 **파싱 즉시 vault로 보내고 반환 shape에서 제거**. 실패는 `YouTubeApiCallError{classification, outcome: 'rejected'|'uncertain'}`로 정규화. `uncertain`은 "요청이 서버에 적용됐는지 알 수 없음"(timeout/abort/network/5xx), `rejected`는 "서버가 확정 거부"(4xx). quota는 T3 `QuotaTracker`로 사전 검사·기록.
5. **`youtube/broadcast/limits.ts`**: 3종 한도 판정과 복구 정책. named reason 3개 + limit-shaped unknown(공개 reason 없는 일일 생성 한도) → 모두 동일 행동(복구 우선 → 불가 시 safe_stopped 요청 + alert).
6. **`youtube/broadcast/lifecycle.ts`**: `ensureLive()` 단계 기계 `planned → stream_ready → broadcast_created → bound → testing → live`. 각 단계: (a) pending 기록 → (b) 호출 → (c) 성공이면 결과 영속·pending 해제, (d) uncertain이면 `list`로 reconcile → 이미 적용됐으면 그 결과를 채택, 안 됐으면 재시도. insert는 `enableAutoStart: true`로 시도하고 `invalidAutoStart`(400, 확정 거부 → 자원 미생성)면 auto-start 없이 재-insert하고 transition(testing→live)로 진행. 재기동 시 열린 시도를 이어서 진행(`resume()`).
7. **`youtube/broadcast/health.ts`**: `liveStreams.list?part=status` + `liveBroadcasts.list?part=status` 폴링 → §9.4(6) health 신호 3개(`youtube.stream_status`, `youtube.stream_health`, `youtube.broadcast_lifecycle`). 판정은 T12, 여기서는 보고만.
8. **`youtube/broadcast/config.ts`** + `config/default.json`의 `youtube.broadcast`: strategy(기본 `single`), privacyStatus(기본 `private` — 최초 공개는 사람 권한 §9.1), selfDeclaredMadeForKids(false, §12.2), latencyPreference, monitorStream, dvr, scheduledStartLeadMs, requestTimeoutMs, statusPollIntervalMs, stream(title/resolution/frameRate/ingestionType/isReusable). 스펙에 값이 없는 것은 `provisional`.
9. **가짜 API 서버**(`testing/fake-youtube-api-server.ts`): 실제 loopback HTTP 서버. 시나리오: 정상, timeout(응답 지연/무응답), 3종+unknown 한도, `invalidAutoStart`, `errorStreamInactive`, 재기동. 모든 값은 명백한 합성값.
10. **테스트**: 합격 기준 1(정상/timeout reconcile/한도 3종/invalidAutoStart), 2(stream key 미노출 — 반환 shape·DB 전체 dump·로그 sink·health 신호를 문자열로 검사), 3(단계 영속 후 새 인스턴스에서 이어가기). 거부 경로도 함께.
11. 게이트(`format:check → lint → typecheck → test → build`) 실행 후 PR.

## 전송 계층 선택: `fetch` (googleapis 아님) — 근거 (review round 1, m1)

T3는 `googleapis@174.0.1`을 "T9/T10이 쓸 Data API 클라이언트"로 선언했다. T10은 그것을 쓰지 않고 Node 24 내장 `fetch`로 직접 호출한다. 근거는 **재시도·timeout 정책의 소유권**이다.

1. 이 task의 핵심 불변조건은 "결과를 모르는 mutating 호출은 절대 맹목 재시도하지 않는다"(스펙 §9.1)다. 즉 재시도 여부와 시점이 제품 규칙이며, 라이브러리 설정값이 되면 안 된다. gaxios는 `retryConfig`로 5xx·네트워크 오류를 자동 재시도할 수 있고, 그 동작은 우리가 소유하지 않는 기본값·버전에 따라 바뀐다. `liveBroadcasts.insert`에는 idempotency key가 없으므로 라이브러리의 자동 재시도 1회가 곧 방송 2개다.
2. `not_attempted` / `rejected` / `uncertain` 구분(4xx는 확정 미적용, timeout·소켓·5xx는 불확실)을 오류가 발생한 지점에서 직접 내려야 한다. 라이브러리 오류 분류를 역추적해 이 세 가지를 복원하는 것보다, 요청을 소유하는 편이 단순하고 검증 가능하다.
3. 응답에서 `cdn.ingestionInfo.streamName`(stream key)을 **필드 단위로** 걷어내고 반환 shape·오류 메시지에서 제거해야 한다(§10.2, A-16). 파싱을 소유하지 않으면 이 보증을 코드로 강제할 수 없다.
4. 부가 효과: T3가 측정한 `googleapis` 배럴 모듈 로드 5,194 ms를 서버 기동·모든 테스트에서 지불하지 않는다. 새 dependency도 없다.

`googleapis`는 선언된 채 남는다(T9의 `videos.list` 등에서 쓸 수 있다). 이 판단은 T10 범위의 것이며 T3의 선언을 되돌리지 않는다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| liveBroadcasts.insert 요구·오류 | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert | 2026-08-17 | 필수: `snippet.title`, `snippet.scheduledStartTime`, `status.privacyStatus`. 쓰기 가능: `status.selfDeclaredMadeForKids`, `contentDetails.enableAutoStart/enableAutoStop/enableDvr/monitorStream.enableMonitorStream`. 오류에 `limitExceeded/userBroadcastsExceedLimit`, `invalidValue/invalidAutoStart`, `invalidValue/invalidScheduledStartTime`("미래이고 예약 가능한 시각") |
| liveBroadcasts.transition | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition | 2026-08-17 | `broadcastStatus ∈ {testing, live, complete}`, `id`, `part` 필수. 오류: `rateLimitExceeded/concurrentBroadcastsExceedLimit`, `forbidden/errorStreamInactive|invalidTransition|redundantTransition`, `backendError/errorExecutingTransition`. **`invalidAutoStart`는 transition에 없다** — insert 오류다 |
| liveBroadcasts.bind | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind | 2026-08-17 | `id`·`part` 필수, `streamId` 생략 시 결합 해제. 오류: `forbidden/liveBroadcastBindingNotAllowed`, `notFound/liveStreamNotFound` |
| liveBroadcasts.list | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list | 2026-08-17 | 필터 `broadcastStatus ∈ {active, all, completed, upcoming}` / `id` / `mine` 중 **정확히 하나**. `broadcastType` 기본값 `event`이므로 reconcile은 `all`을 명시. `maxResults` 0–50 |
| liveBroadcast 리소스 | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts | 2026-08-17 | `status.lifeCycleStatus ∈ {complete, created, live, liveStarting, ready, revoked, testStarting, testing}`, `contentDetails.latencyPreference ∈ {normal, low, ultraLow}`(쓰기 가능), `contentDetails.boundStreamId`, `snippet.liveChatId`, `madeForKids` 읽기 전용 |
| liveStreams.insert | https://developers.google.com/youtube/v3/live/docs/liveStreams/insert | 2026-08-17 | 필수: `snippet.title`, `cdn.frameRate`, `cdn.ingestionType`, `cdn.resolution`. `contentDetails.isReusable` 쓰기 가능 |
| liveStreams.list | https://developers.google.com/youtube/v3/live/docs/liveStreams/list | 2026-08-17 | 필터 `id` 또는 `mine` 하나 필수, `maxResults` 0–50. **"The part names that you can include in the parameter value are `id`, `snippet`, `cdn`, and `status`."** — `contentDetails`는 허용되지 않는다(round 1 B1의 원인). 따라서 list 결과의 `isReusable`은 항상 null이며 `insert`에서만 알 수 있다 |
| 메서드별 허용 part (B1) | insert: .../liveStreams/insert · .../liveBroadcasts/insert · bind · transition · list | 2026-08-17 | `liveStreams.insert` {id,snippet,cdn,contentDetails,status} · `liveStreams.list` {id,snippet,cdn,status} · `liveBroadcasts.insert`/`bind`/`transition` {id,snippet,contentDetails,status} · `liveBroadcasts.list` {id,snippet,contentDetails,monetizationDetails,status}. 코드의 `METHOD_ALLOWED_PARTS`가 정본이고 가짜 서버도 같은 표로 거부한다 |
| part 오류 reason | https://developers.google.com/youtube/v3/docs/errors | 2026-08-17 | `badRequest(400)/unknownPart`("specifies an unknown value"), `badRequest(400)/unexpectedPart`("specifies an unexpected value"). 가짜 서버는 리소스에 없는 이름 → `unknownPart`, 리소스에는 있으나 메서드가 받지 않는 이름 → `unexpectedPart`로 답한다 |
| liveStream 리소스(§9.4(6)) | https://developers.google.com/youtube/v3/live/docs/liveStreams | 2026-08-17 | `cdn.ingestionType ∈ {dash, hls, rtmp}`("rtmp"가 RTMPS 포함), `cdn.resolution ∈ {240p…2160p, variable}`, `cdn.frameRate ∈ {30fps, 60fps, variable}`, `status.streamStatus ∈ {active, created, error, inactive, ready}`, `status.healthStatus.status ∈ {good, ok, bad, noData}`, `configurationIssues[].severity ∈ {info, warning, error}`. **`cdn.ingestionInfo.streamName` = YouTube가 배정한 stream key** |
| Live Streaming API 전체 오류표 | https://developers.google.com/youtube/v3/live/docs/errors | 2026-08-17 | `invalidAutoStart` = 400 `invalidValue`("contentDetails.enableAutoStart 값이 잘못됨"), `userBroadcastsExceedLimit` = `limitExceeded`, `concurrentBroadcastsExceedLimit`·`sharedIngestionBroadcastsExceedLimit` = 403 `rateLimitExceeded`. **일일 생성 한도에 해당하는 reason 문자열은 이 표에 없다** |
| 일일 Live 생성 한도([S37]) | https://support.google.com/youtube/answer/2853834 | 2026-08-17 | "If you've reached your daily limit for creating live streams, you can try again in 24 hours." — 한도의 **숫자도 API reason도 공개되지 않는다**. 따라서 코드는 카운터로 한도를 추정하지 않고 API 오류만 신뢰한다 |
| 9:16 세로 설정 | (위 liveStream/liveBroadcast 리소스) | 2026-08-17 | **API에 종횡비·세로 지정 필드가 없다.** `cdn.resolution`은 높이 열거값이고, 실제 해상도는 인코더가 보내는 것으로 결정된다. 그러므로 기본값은 `variable`/`variable`이고 9:16은 OBS 캔버스(T2·T17)가 만든다. 임의 값으로 세로를 "설정"하지 않는다 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음 — 스펙·공식 문서로 확정) | | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `youtube.broadcast.strategy` | `single` | 결정(A-4) | 스펙 §9.3·§17: 프로덕션 전략은 Gate 2 후 선택. `rolling-experiment`는 실험 라벨로만 구현 |
| `youtube.broadcast.privacyStatus` | `private` | 결정(스펙 §9.1) | 최초 공개는 사람의 권한. 자동화가 스스로 public으로 만들지 않는다 |
| `youtube.broadcast.selfDeclaredMadeForKids` | `false` | 결정(스펙 §12.2) | 선언만으로 분류를 피할 수 없다는 §12.2를 코드가 바꾸지 않는다. 증빙 검토는 사람 게이트 |
| `scheduledStartLeadMs` | 120000 | provisional(A-15) | `invalidScheduledStartTime`이 "미래이고 예약 가능"만 요구하고 최소 리드타임은 비공개. Gate 2에서 실측 |
| `requestTimeoutMs` | 15000 | provisional(A-15) | 공식 권고 없음. reconcile 경로가 있으므로 안전 |
| `statusPollIntervalMs` | 15000 | provisional(A-15) | 폴링 간격 공식 권고 없음(`liveStreams.status`에는 서버 제공 간격이 없다) |
| `reconcileMaxAttempts` / backoff | T3 `youtube.quota.backoff` 재사용 | provisional(A-15) | 새 숫자를 만들지 않고 T3의 정책을 쓴다 |
| 일일 생성 한도 판정 | named reason 3개 외의 limit-shaped 오류 | 추론(문서화됨) | 위 Sources 표: 공개 reason 없음. 4가지 kind의 **행동은 동일**(복구 우선 → safe_stopped + alert)이므로 오분류는 alert 라벨만 바꾸고 조치를 바꾸지 않는다 |

## Implemented

| 파일 | 역할 |
|---|---|
| `apps/server/src/db/migrations/003_broadcast-resources.sql` | 001의 skeleton 대체(번호는 round 1 m2로 002→003). attempt 단위 행 + `pending_call`·`pending_transition`(호출 전 기록) + 단조 stage + 열린 행 1개당 broadcast 1개 unique index |
| `apps/server/src/db/store.ts`, `db/types.ts` | `beginBroadcastAttempt` · `markBroadcastCallPending` · `recordBroadcastCallResult` · `updateBroadcastAttempt` · `closeBroadcastAttempt` · `getBroadcastAttempt` · `findOpenBroadcastAttempt` · `listBroadcastAttempts`. 단계 역행·외부 ID 재지정·닫힌 attempt 호출 거부 |
| `youtube/broadcast/api.ts` | `fetch` + `AbortSignal`(주입 Clock) REST 클라이언트. `METHOD_ALLOWED_PARTS`로 메서드별 part를 강제(B1), 목록은 `ListResult{items, complete}`로 잘림을 알리고(B2), status-only `listLiveStreamStatuses`는 `cdn`을 아예 요청하지 않는다(M1). 실패를 `not_attempted` / `rejected` / `uncertain`으로 정규화, quota 사전검사·기록, `streamName`을 파싱 즉시 sink로 넘기고 반환 shape·오류 메시지에서 제거 |
| `youtube/broadcast/stream-key.ts` | `StreamKeyCustodian`: stream별 staging → 선택된 stream만 vault write, redactor 등록, unchanged면 미기록, 생성된 stream에 키 없으면 실패 |
| `youtube/broadcast/limits.ts` | 3종 named reason + limit-shaped unknown(일일 한도) 판정, adoptable lifecycle 목록 |
| `youtube/broadcast/lifecycle.ts` | `resume` · `ensureBound` · `goLive` · `ensureLive` · `rollOver` · `stopBroadcast`(모두 같은 reconcile 래퍼를 통과). 호출 전 영속 → 불확실이면 `list` reconcile → 결론이 나야만 재시도(불완전 목록은 inconclusive), `invalidAutoStart`/`invalidScheduledStartTime`/`redundantTransition`/`errorStreamInactive` 개별 처리, 한도는 복구 우선 → 불가 시 safe stop |
| `youtube/broadcast/health.ts` | §9.4(6) 신호 3개(`youtube.stream_status`·`youtube.stream_health`·`youtube.broadcast_lifecycle`) + 폴링 모니터. 관측 실패는 `unknown`이며 판정하지 않음 |
| `youtube/broadcast/alerts.ts` | `BroadcastAlertSink` · `SafeStopRequestSink` 인터페이스(구현은 T12) |
| `testing/fake-youtube-api-server.ts` | 상태를 가진 loopback 가짜 API. 문서화된 part 집합·필터 배타성을 검증하고 요청한 part만 응답에 담는다(B1). `holdApplied()`는 **적용 후 응답 보류**로 벽시계 없는 applied-but-unknown을 만든다(M2) |
| `config/default.json` `youtube.broadcast` + `broadcast/config.ts` | 전략·공개범위·MFK·지연·auto-start·stream cdn 값과 provisional 목록 |
| `docs/ops/obs-setup.md`, `docs/ops/youtube-auth-setup.md` | stream key는 이제 서버가 vault에 채우고 수동 입력은 fallback임을 명시(기존 안내가 틀린 상태로 남지 않게) |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 가짜 API 서버로 정상 경로 | met | `youtube/broadcast/lifecycle.test.ts` "normal path" 4건 + round 1 신설 "request shapes" 2건(모든 요청 part ⊆ 문서 집합, 가짜 서버가 미지원 part 거부): 호출 순서 `liveStreams.list → insert → liveBroadcasts.insert → bind → list → transition(testing) → transition(live)`, 필수 필드·part·Bearer 검증, stream 재사용, monitorStream off일 때 testing 생략 |
| 1 | timeout → reconcile | met | 같은 파일 "uncertain results are reconciled, never retried blindly" 10건(round 2에서 마커 기반 negative 4건 추가: 같은 시각 무관 방송 미채택, insert 미적용 시 미채택, 마커 중복 inconclusive, 마커-시각 불일치 inconclusive) + `attempt-marker.test.ts` 9건(round 1에서 배리어 기반으로 전환 + 잘린 목록 inconclusive 2건 추가): insert timeout 후 insert 요청 **1회**·broadcast **1개**·`call_reconciled=applied`; liveStreams timeout 후 vault에 키 저장; 503 bind는 reconcile이 not_applied를 확인한 뒤에만 재시도(요청 2회); 끝까지 불확실하면 `BroadcastReconcileFailedError` |
| 1 | 3종 한도 오류 | met | 같은 파일 "channel limits" 5건: `userBroadcastsExceedLimit`(복구), `concurrentBroadcastsExceedLimit`(live 방송 채택), 복구 불가 시 `safe_stopped` 요청 + alert + attempt abandoned, 문서화되지 않은 일일 한도(limit-shaped) 동일 경로·insert 1회, `liveStreams` 한도는 stream 재사용으로 복구. reason 매핑 단위 테스트는 `limits.test.ts`(rate limit·quota를 한도로 오분류하지 않음 포함) |
| 1 | invalidAutoStart fallback | met | 같은 파일 "auto-start" 3건: 400 `invalidAutoStart` → alert + `enableAutoStart:false`로 재-insert → transition 2회, attempt `autoStart=false`; auto-start가 실제로 동작하면 transition 0회; 수락됐지만 발화하지 않으면 `auto_start_did_not_fire`로 transition fallback |
| 2 | stream key가 로그·DB·응답에 없음 | met | 같은 파일 "the stream key never leaves the vault" 5건(round 1: 폴링이 `cdn`을 요청하지 않음, 미일치 조회 후 staging 0): 반환값·attempt 행 전체·alert·로그 dump·**DB 디렉터리의 모든 바이트(WAL 포함)** 에 키 없음, vault에는 있음; 채널에 stream이 여러 개일 때 선택된 것만 저장; redactor로 마스킹됨. 스키마 차원 강제는 `db/broadcast-resources.test.ts` "has no column that could hold a stream key", 전송 차원은 `api.test.ts` "stream key handling" 3건 |
| 3 | 단계 영속 → 재기동 후 이어가기 | met | 같은 파일 "restart" 3건 + "stopping a broadcast" 3건(round 1 B4: 불확실한 stop은 행을 닫지 않고, 재기동이 `pending_transition`으로 관측을 해석): `ensureBound` 후 store 재오픈 → `goLive`가 같은 attempt/broadcast/stream으로 이어가고 insert·bind 각 1회; 호출 중 사망(pending transition) → 재기동 `resume()`이 reconcile로 `live` 확정, transition 요청 0회; insert가 이미 만든 broadcast를 `scheduledStartTime`으로 찾아 채택, broadcast 1개 |

### Reproduction checks (round 1)

각 재현 테스트가 **수정을 되돌린 빌드에서 실패**하는지 확인했다(무의미한 테스트를 남기지 않기 위해). 스크립트가 임시로 un-fix를 적용하고 해당 테스트만 돌린 뒤 원복한다.

```text
B2: exit=1 Tests  1 failed | 38 skipped (39)  (#assertConclusive를 no-op으로)
B3: exit=1 Tests  1 failed | 38 skipped (39)  (#prepareAdoption이 attempt.streamId 유지)
B4: exit=1 Tests  1 failed | 38 skipped (39)  (stopBroadcast가 모든 오류를 삼킴)
B1: exit=1 Tests  1 failed | 38 skipped (39)  (가짜 서버 validateParts를 항상 null로)
```

### Reproduction check (round 2)

리뷰어의 재현을 negative 테스트로 고정하고, **마커 대조를 되돌린 빌드에서 실패**하는지 확인했다.

```text
$ (un-fix: #findInsertedBroadcast가 scheduledStartTime만 비교)
$ npx vitest run .../lifecycle.test.ts -t "never adopts an unrelated broadcast"
  × never adopts an unrelated broadcast that merely shares the scheduled time
  AssertionError: expected 'synthetic-broadcast-1' not to be 'synthetic-broadcast-1'
  Tests  1 failed | 42 skipped (43)          ← 리뷰어의 adoptedId == unrelatedId 재현
$ (원복 후) 동일 명령 → Tests  1 passed | 42 skipped (43)
```

### Gates (executed)

```text
$ npm run format:check   -> All matched files use Prettier code style!
$ npm run lint           -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports);
                            check-install-scripts: ok (3 reviewed, better-sqlite3 binding loads)
$ npm run typecheck      -> tsc --build tsconfig.json (no output)
$ npm run test           -> Test Files 64 passed (64) / Tests 1128 passed | 1 skipped (1129)
$ npm run build          -> contract, renderer(vite ✓ built), server(copied 2 migration(s)), simulator ok
```

round 1 수정 후 재실행(base `44fefaa`로 rebase): 위 5개 게이트 모두 통과, 테스트 **1129 passed | 1 skipped (1130)**, `copied 2 migration(s)`(003 재번호 후 dist 정리 확인).

round 2 수정 후 재실행(`git fetch && git rebase origin/main`): format `All matched files use Prettier code style!` · lint 0 problems · typecheck 무출력 · test **1141 passed | 1 skipped (1142)** · build `copied 2 migration(s)`.

그 뒤 **T13(PR #10)이 main에 머지되어 다시 rebase**했고(base `5457ac4`), 마이그레이션 번호와 T13의 데이터 맵에서 통합 충돌이 나왔다. 처리:

1. T13이 `002_retention-ledger.sql`을 가져왔으므로 이 브랜치의 마이그레이션은 rebase 중 **003**으로 유지하고 `migrate.test.ts` 기대치를 `['001_initial.sql','002_retention-ledger.sql','003_broadcast-resources.sql']`·버전 `[1,2,3]`으로 갱신했다.
2. T13의 `config/retention.json`은 `broadcast_resources`의 컬럼을 **001 skeleton 기준**으로 선언하고 있었고("columns fixed by T10"), 스키마 드리프트 검사가 이를 실패로 잡았다(`storedColumns does not match the live schema`). 선언을 migration 003의 실제 17개 컬럼으로 갱신하고 `npm run data-map:generate -w @vl/server`로 `docs/ops/data-map.md`를 재생성했다(손으로 고치지 않음). 드리프트 검사는 테이블당 field group 하나만 허용하므로(각 group을 전체 컬럼 집합과 대조) attempt 운영 컬럼도 같은 group에 들어가며, 그 결과 행 전체가 더 **엄격한** authorized-API-data 규칙(30일 delete)을 받는다 — 약한 쪽으로 재분류하지 않았다는 사실을 `purpose`에 적었다.
3. T13 테스트 하네스(`privacy/testing/harness.ts`)의 `broadcast_resources` raw insert를 003 컬럼으로 고쳤다(sweep 테스트는 과거 시각 `updated_at`이 필요해 store writer를 쓸 수 없다). 이 하네스는 T13 소유지만 스키마를 바꾼 쪽이 고치는 것이 맞다.

통합 후 게이트: format pass · lint pass · typecheck pass · test **1235 passed | 1 skipped (1236)**(T13 privacy 47건 포함) · build pass(`copied 3 migration(s)`, data-map `--check` 통과). 리뷰어가 관측한 `api.test.ts:162` flake는 M2의 배리어로 원인 자체를 제거했다(벽시계 의존 삭제).

위 게이트는 `git fetch && git rebase origin/main`(base `751126f`) 뒤에 돌렸다. rebase 직후 `npm run test`가 renderer 3파일에서 `Cannot find package 'jsdom'`로 실패했는데, 원인은 T5(PR #9)가 추가한 devDependency가 이 worktree의 `node_modules`에 없던 것이었다 — `npm install`(lockfile 변경 없음) 후 재실행하여 위 결과를 얻었다.

실행하지 않은 것: 실제 YouTube API 호출. 실계정 검증은 Gate 2 범위이며(§11 "실제 YouTube 계정이 필요한 … mock만으로 완료 판정하지 않는다"), 이 task는 가짜 API 서버까지가 판정 범위다.

## Not done / out of scope

- T12의 supervisor 상태 기계·Discord alert 구현: 이 task는 `BroadcastAlertSink`/`SafeStopRequestSink` 인터페이스와 호출만 제공한다.
- 실제 YouTube 계정 호출·Gate 2 실험(`docs/ops/gate2-experiments.md`는 T16).
- OBS로의 stream key 주입은 T2 `ObsControl.setStreamServiceFromVault()`가 이미 소유한다(A-16). T10은 vault에 키를 넣는 쪽만 담당한다.
- `rolling-experiment`의 프로덕션 자동화(§9.3: 두 전략을 모두 production 구현하지 않는다) — 새 broadcast 생성 → transition → `liveChatId` 교체 신호까지만.

## Review round 1

리뷰: https://github.com/dnhynk/vertical-live/pull/11#pullrequestreview-4950323999 (verdict `request_changes`, blocker 4 · major 2 · minor 2). 모두 고쳤고 반박은 없다. 커밋 `ab7ffb6`.

| finding | 처리 |
|---|---|
| **B1** `api.ts:251` `liveStreams.list`에 `contentDetails` (공식 문서는 `id,snippet,cdn,status`만 허용) | 고침 `ab7ffb6`. `METHOD_ALLOWED_PARTS`(메서드별 허용 part + 근거 URL)를 두고 `requestedParts()`가 위반 시 `YouTubePartError`로 **요청 전에** 실패한다. 가짜 서버도 같은 표로 검증해 `unexpectedPart`/`unknownPart`로 거부하고, 요청한 part만 응답에 담는다. 테스트: "only ever sends parts the method documents"(모든 기록된 요청의 part ⊆ 허용 집합), "is checked by a fake server that rejects an unsupported part". 부수 효과로 `LiveStreamSummary.isReusable`은 list 경로에서 null임을 문서화 |
| **B2** `api.ts:378`·`lifecycle.ts:615-635` 잘린 목록을 "미적용"으로 단정해 insert 재시도 | 고침 `ab7ffb6`. `#listAll`이 `ListResult{items, complete}`를 반환하고, reconcile은 "목록에 없음 + 목록 불완전"을 **inconclusive**로 처리한다: `pending_call`을 그대로 두고 `BroadcastReconcileInconclusiveError`를 던져 재시도를 금지한다(다음 `resume()`이 다시 묻는다). 재현 테스트: 200개 upcoming + applied-but-unheld insert에서 insert 요청 1회·같은 reconcile 키 방송 1개·`pendingCall` 유지, 그리고 목록이 다시 페이지 안에 들어오면 resume이 채택. **무-수정 빌드에서 이 테스트가 실패함을 확인**(아래 Result) |
| **B3** `lifecycle.ts:806·817` 복구가 후보의 실제 바인딩을 무시하고 attempt의 streamId 유지 | 고침 `ab7ffb6`. `#prepareAdoption()`이 후보의 `boundStreamId`를 검사해 (a) 우리 stream과 같으면 그대로, (b) 다르면 그 stream을 id로 읽어 **그 키를 vault에 commit**한 뒤 채택(행은 write-once이므로 기존 행을 닫고 새 행을 연다), (c) 키를 얻을 수 없거나 live인데 바인딩이 없으면 **채택 거부 → safe stop**. 소유 행과 관측된 바인딩이 어긋나면 `adoption_binding_conflict`로도 safe stop. 재현 테스트 2건(재바인딩 성공/키 불가 거부) |
| **B4** `lifecycle.ts:241` `stopBroadcast`가 reconcile 없이 attempt를 닫음 | 고침 `ab7ffb6`. `stopBroadcast`가 `#withRetries`+`#runCall`을 거치고, 마이그레이션에 `pending_transition`(testing/live/complete)을 추가해 어떤 전이가 in-flight였는지 영속한다. reconcile은 목표에 따라 관측을 해석한다(`complete` 관측은 stop을 확정하고 go-live를 반박). 불확실한 채로는 행을 닫지 않는다. 재현 테스트 3건(503 후 행 유지 + list 발생 + `reconciled_not_applied:live`, reconcile이 complete를 보면 닫힘, 재기동이 목표를 읽어 complete 확정) |
| **M1** `health.ts:205` 상태 폴링이 `cdn`을 요청해 키가 custodian에 머묾 | 고침 `ab7ffb6`. `listLiveStreamStatuses()`(`part=id,status`)를 추가해 폴링 경로에는 키가 응답에 **존재하지 않는다**. 아울러 `#selectStreamByTitle()`이 목록 조회 후 선택분 commit / 나머지 discard를 한 곳에서 보장한다(실패·예외 경로 포함). 테스트: 폴링 2회 후 `stagedStreamIds` 빈 배열 + 요청 part가 `id,status`, 그리고 "일치하는 stream이 없을 때 staging 잔여 0" |
| **M2** `api.test.ts:163` 50ms 벽시계 경쟁(리뷰어 환경에서 실제 flake) | 고침 `ab7ffb6`. 가짜 서버에 `holdApplied(method)` 배리어를 추가했다: 요청을 **적용한 뒤** `applied`를 resolve하고 응답을 보류한다. 테스트는 `await hold.applied`로 적용을 확인한 다음 `FakeClock.advance()`로 abort를 발생시킨다 — 벽시계 의존이 사라졌다. lifecycle의 timeout 테스트 2건도 같은 배리어로 전환했다 |
| **m1** 티켓에 `fetch` 선택 근거 없음 | 고침 `ab7ffb6`. 위 "전송 계층 선택" 절 신설(재시도·timeout 소유권, 3-way outcome, 필드 단위 키 제거, 모듈 로드 비용) |
| **m2** 마이그레이션 번호 충돌(PR #10이 002) | 고침 `ab7ffb6`. `003_broadcast-resources.sql`로 재번호, `migrate.test.ts` 기대치를 `['001_initial.sql','003_broadcast-resources.sql']`·버전 `[1,3]`로 갱신(runner는 번호 공백을 허용). 이 과정에서 `copy-migrations.mjs`가 `dist`를 정리하지 않아 이름이 바뀐 마이그레이션이 빌드 산출물에 남는 것을 발견 → 복사 전 target을 비우고 src/dist 개수 불일치를 오류로 처리 |

## Review round 2

리뷰: https://github.com/dnhynk/vertical-live/pull/11#pullrequestreview-4950922281 (verdict `request_changes`, blocker 1 · minor 2). round 1 findings 9건은 리뷰어가 모두 fixed로 확인했다. 커밋 `eeddfaa`.

| finding | 처리 |
|---|---|
| **B1** `lifecycle.ts:1055` insert reconcile이 `scheduledStartTime`만 같은 첫 방송을 채택 → 같은 시각의 무관 방송을 바인딩하고 실제 insert 자원은 고아가 됨(§9.1 무효, 합격 1) | 고침 `eeddfaa`. **제품 소유 attempt 마커**를 도입했다: `attempt-marker.ts`가 `vl-attempt:<attemptId>`를 만들고, 이 문자열이 `snippet.description`의 마지막 줄로 insert 본문에 실려 나가며, 호출 **전에** `broadcast_resources.attempt_marker`(migration 003, NOT NULL)에 영속된다. reconcile은 시각이 아니라 마커로 후보를 고른다: 마커 일치 1건 + `scheduledStartTime` 일치 → 채택, 마커 일치 0건 + 목록 완전 → 미적용(재시도 허용), 마커 일치 ≥2건 → `marker_ambiguous` inconclusive, 마커는 맞고 시각이 다르면 → `marker_time_mismatch` inconclusive, 목록 불완전 → `broadcast_list_truncated` inconclusive(round 1 B2). inconclusive는 `pending_call`을 남기고 재시도를 금지한다. 근거·필드 선택 이유는 아래 표와 `attempt-marker.ts` 주석 |
| **m1** 티켓 161행 Follow-up이 "transition(complete) 실패 시 항상 attempt를 닫는다"로 남아 round 1 B4 결과와 모순 | 고침 `eeddfaa`. 해당 항목을 취소선 + 정정으로 바꿨다(불확실하면 닫지 않고 `pending_transition='complete'`로 다시 reconcile한다) |
| **m2** `db/broadcast-resources.test.ts:9` 주석이 "migration 002" | 고침 `eeddfaa`. 003으로 정정하고, 이 파일이 이제 마커 영속까지 검증한다는 사실을 주석에 반영 |

### 마커 필드 선택 근거 (공식 문서, 2026-08-17 확인)

| 질문 | 답 | 출처 |
|---|---|---|
| insert 본문에 우리 문자열을 넣을 수 있는 필드가 있는가 | `snippet.description`이 insert에서 쓰기 가능 | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert (Writable: `snippet.description`) |
| 그 값을 list로 되읽을 수 있는가 | `snippet.description`은 liveBroadcast 리소스의 `snippet` 파트에 포함되어 응답으로 돌아온다 | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts ("As with the `title`, you can set this field by modifying the broadcast resource") |
| 길이 여유 | description 5,000자(`invalidDescription`), title 1–100자(`invalidTitle`) | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert 오류표 |
| `snippet.title`을 쓰지 않은 이유 | 제목은 watch 페이지·세로 피드에 노출되는 제품 문구다. 기계 식별자를 넣지 않는다. 길이 여유도 없다 | 위 오류표 + 스펙 §5.2 |
| custom metadata / idempotency key | **없다.** `liveBroadcasts.insert`에 idempotency key가 없고 API에 사용자 정의 메타데이터 필드도 없다 | 위 insert 참조 페이지(요청 본문 속성 목록) |
| 개인정보 | 마커는 합성 attempt id뿐이다(§12.4 대상 데이터 아님). 기본 `privacyStatus: private` | 스펙 §12.4 |

마커를 **파생값이 아니라 열로 영속**한 이유: 재기동 후의 reconcile은 "지금 빌드의 마커 형식"이 아니라 "그 attempt가 실제로 보낸 문자열"과 대조해야 한다. 형식이 바뀐 빌드로 재기동하면 파생값은 어긋나고, 그 결과는 정확히 이 task가 막으려는 중복 insert다.

## Follow-ups

- **T12 배선**: `BroadcastLifecycle`은 `BroadcastAlertSink`·`SafeStopRequestSink`·`HealthSignalSink`만 호출한다. T12가 (a) Discord alert 구현(D-3), (b) `safe_stopped` 전이, (c) `BroadcastHealthMonitor` 기동, (d) `ObsControl.setStreamServiceFromVault()` → `startStream()` 순서를 `ensureBound()` **뒤**에 두는 것을 맡는다. `errorStreamInactive`는 `BroadcastStreamInactiveError`로 나오므로 "인코더를 먼저 켜라"는 신호로 쓸 수 있다.
- **T9**: `liveChatId`는 `store.findOpenBroadcastAttempt()?.liveChatId` 또는 `ensureLive()`의 `BroadcastTarget.liveChatId`에서 읽는다(§T9 "T10의 broadcast_resources에서 읽되"). rolling 교체 신호는 새 attempt 행의 `live_chat_id`다.
- **T3 `quota/classify.ts`**: 공용 표에 `sharedIngestionBroadcastsExceedLimit`가 없어 403 → `forbidden`(safe_stopped)으로 분류된다. T10은 자기 `classifyBroadcastLimit`에서 먼저 잡으므로 이 task의 동작에는 영향이 없다. 공용 표에 한 줄 추가하는 것은 T3 소유 파일 변경이라 하지 않았다.
- **Gate 2에서 확정할 것**: 일일 생성 한도의 실제 reason 문자열(있다면), auto-start와 monitorStream 조합의 실제 수용 여부, `scheduledStartLeadMs` 최소값, `liveStreams.status` 폴링 간격, provisional quota 비용.
- `enableDvr`/`recordFromStart`는 config 기본값(false / API 기본)을 그대로 둔다. 12시간 초과 방송의 archive 부재(§4)는 전략 선택 문제이므로 Gate 2 실험에서 결정한다.
- ~~`stopBroadcast()`가 `transition(complete)` 실패 후에도 attempt를 닫는다~~ → **정정(round 1 B4로 폐기, round 2 m1 지적)**: 현재 `stopBroadcast()`는 다른 mutating 호출과 같은 reconcile 래퍼를 통과하고, 결과가 불확실하면 attempt를 **닫지 않는다**(`list`로 `complete`를 확인해야만 닫는다). 확정 거부(예: `redundantTransition`)는 성공으로 취급한다. 닫히지 않은 attempt는 다음 `resume()`이 `pending_transition='complete'`로 다시 reconcile한다.
