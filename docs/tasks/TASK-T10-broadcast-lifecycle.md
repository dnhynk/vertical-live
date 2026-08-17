# TASK-T10-broadcast-lifecycle

- Task: T10 broadcast lifecycle·reconcile·한도 처리 (`docs/tasks/TASK_SPECS.md` §T10)
- Branch: `dnhynk/t10-broadcast-lifecycle` · PR: #11
- Orca: task `task_41769f69d4b7` · dispatch `ctx_a44401984418`
- Spec sections read: §4(liveBroadcasts·12h archive 행), §9.1, §9.2, §9.3, §9.4(6), §10.2, §11, §12.2, §12.4, §17
- BOARD decisions/assumptions relied on: D-1, D-2, A-4(전략 기본 `single`), A-14(공용 규격), A-15(provisional 숫자), A-16(stream key = vault 정본)

## Goal

YouTube 방송 자원(liveStream · liveBroadcast)의 생명주기를 서버가 소유하게 만든다. 각 외부 호출 **전에** 시도의 단계와 이미 알고 있는 외부 ID를 `broadcast_resources`에 영속하고, 결과가 불확실하면(timeout·소켓 오류·5xx) `list`로 실제 상태를 reconcile한 뒤에만 재시도한다. 3종 한도 오류에서는 새로 만들지 않고 기존 방송 복구를 먼저 시도하며, 불가능하면 `safe_stopped` 요청 + alert hook으로 끝낸다. stream key는 vault에만 들어가고 반환값·로그·DB·health 신호 어디에도 나타나지 않는다. 상태 기계(T12)와 chat 수신(T9)은 이 모듈이 만든 read model(`BroadcastResourceRecord`, `HealthSignal`)만 소비한다.

## Plan

1. **정본 사실 확정(먼저)**: liveBroadcasts insert/bind/transition/list, liveStreams insert/list, liveBroadcast·liveStream 리소스, Live Streaming API 오류표, 일일 생성 한도 Help 문서를 읽고 표(아래 "Sources consulted")로 고정한다. 9:16 관련 필드가 API에 있는지, 일일 한도 reason 문자열이 공개돼 있는지를 특히 확인한다.
2. **migration 002**: 001의 `broadcast_resources`는 "T10이 컬럼을 확정한다"는 skeleton이고 어떤 코드도 쓰지 않는다(grep: 001과 migrate.test.ts의 테이블 목록 뿐). 001은 적용 후 수정 금지이므로 `002_broadcast_resources.sql`에서 skeleton을 대체한다. 컬럼: 시도 식별자(attempt_id) PK, strategy, stage, **pending_call**(호출 직전 기록·결과 확정 후 해제), pending_since, stream_id, broadcast_id, live_chat_id, scheduled_start_time(insert reconcile 키), stream_title(liveStreams 재사용·reconcile 키), auto_start_supported, last_error_reason, created_at/updated_at/closed_at.
3. **`PersistenceStore` 확장**(T4가 정한 유일 writer 인터페이스): `beginBroadcastAttempt`, `markBroadcastCallPending`, `recordBroadcastCallResult`, `advanceBroadcastStage`, `closeBroadcastAttempt`, `getBroadcastAttempt`, `findOpenBroadcastAttempt`, `listBroadcastAttempts`. 단계 전진은 단조(monotonic) — 뒤로 가는 전이는 거부.
4. **`youtube/broadcast/api.ts`**: `liveStreams.insert|list`, `liveBroadcasts.insert|bind|transition|list`를 REST로 호출하는 얇은 클라이언트. `fetch` + `AbortSignal`(주입 `Clock`), base URL 주입, 응답에서 `cdn.ingestionInfo.streamName`(= stream key)을 **파싱 즉시 vault로 보내고 반환 shape에서 제거**. 실패는 `YouTubeApiCallError{classification, outcome: 'rejected'|'uncertain'}`로 정규화. `uncertain`은 "요청이 서버에 적용됐는지 알 수 없음"(timeout/abort/network/5xx), `rejected`는 "서버가 확정 거부"(4xx). quota는 T3 `QuotaTracker`로 사전 검사·기록.
5. **`youtube/broadcast/limits.ts`**: 3종 한도 판정과 복구 정책. named reason 3개 + limit-shaped unknown(공개 reason 없는 일일 생성 한도) → 모두 동일 행동(복구 우선 → 불가 시 safe_stopped 요청 + alert).
6. **`youtube/broadcast/lifecycle.ts`**: `ensureLive()` 단계 기계 `planned → stream_ready → broadcast_created → bound → testing → live`. 각 단계: (a) pending 기록 → (b) 호출 → (c) 성공이면 결과 영속·pending 해제, (d) uncertain이면 `list`로 reconcile → 이미 적용됐으면 그 결과를 채택, 안 됐으면 재시도. insert는 `enableAutoStart: true`로 시도하고 `invalidAutoStart`(400, 확정 거부 → 자원 미생성)면 auto-start 없이 재-insert하고 transition(testing→live)로 진행. 재기동 시 열린 시도를 이어서 진행(`resume()`).
7. **`youtube/broadcast/health.ts`**: `liveStreams.list?part=status` + `liveBroadcasts.list?part=status` 폴링 → §9.4(6) health 신호 3개(`youtube.stream_status`, `youtube.stream_health`, `youtube.broadcast_lifecycle`). 판정은 T12, 여기서는 보고만.
8. **`youtube/broadcast/config.ts`** + `config/default.json`의 `youtube.broadcast`: strategy(기본 `single`), privacyStatus(기본 `private` — 최초 공개는 사람 권한 §9.1), selfDeclaredMadeForKids(false, §12.2), latencyPreference, monitorStream, dvr, scheduledStartLeadMs, requestTimeoutMs, statusPollIntervalMs, stream(title/resolution/frameRate/ingestionType/isReusable). 스펙에 값이 없는 것은 `provisional`.
9. **가짜 API 서버**(`testing/fake-youtube-api-server.ts`): 실제 loopback HTTP 서버. 시나리오: 정상, timeout(응답 지연/무응답), 3종+unknown 한도, `invalidAutoStart`, `errorStreamInactive`, 재기동. 모든 값은 명백한 합성값.
10. **테스트**: 합격 기준 1(정상/timeout reconcile/한도 3종/invalidAutoStart), 2(stream key 미노출 — 반환 shape·DB 전체 dump·로그 sink·health 신호를 문자열로 검사), 3(단계 영속 후 새 인스턴스에서 이어가기). 거부 경로도 함께.
11. 게이트(`format:check → lint → typecheck → test → build`) 실행 후 PR.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| liveBroadcasts.insert 요구·오류 | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/insert | 2026-08-17 | 필수: `snippet.title`, `snippet.scheduledStartTime`, `status.privacyStatus`. 쓰기 가능: `status.selfDeclaredMadeForKids`, `contentDetails.enableAutoStart/enableAutoStop/enableDvr/monitorStream.enableMonitorStream`. 오류에 `limitExceeded/userBroadcastsExceedLimit`, `invalidValue/invalidAutoStart`, `invalidValue/invalidScheduledStartTime`("미래이고 예약 가능한 시각") |
| liveBroadcasts.transition | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition | 2026-08-17 | `broadcastStatus ∈ {testing, live, complete}`, `id`, `part` 필수. 오류: `rateLimitExceeded/concurrentBroadcastsExceedLimit`, `forbidden/errorStreamInactive|invalidTransition|redundantTransition`, `backendError/errorExecutingTransition`. **`invalidAutoStart`는 transition에 없다** — insert 오류다 |
| liveBroadcasts.bind | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind | 2026-08-17 | `id`·`part` 필수, `streamId` 생략 시 결합 해제. 오류: `forbidden/liveBroadcastBindingNotAllowed`, `notFound/liveStreamNotFound` |
| liveBroadcasts.list | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/list | 2026-08-17 | 필터 `broadcastStatus ∈ {active, all, completed, upcoming}` / `id` / `mine` 중 **정확히 하나**. `broadcastType` 기본값 `event`이므로 reconcile은 `all`을 명시. `maxResults` 0–50 |
| liveBroadcast 리소스 | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts | 2026-08-17 | `status.lifeCycleStatus ∈ {complete, created, live, liveStarting, ready, revoked, testStarting, testing}`, `contentDetails.latencyPreference ∈ {normal, low, ultraLow}`(쓰기 가능), `contentDetails.boundStreamId`, `snippet.liveChatId`, `madeForKids` 읽기 전용 |
| liveStreams.insert | https://developers.google.com/youtube/v3/live/docs/liveStreams/insert | 2026-08-17 | 필수: `snippet.title`, `cdn.frameRate`, `cdn.ingestionType`, `cdn.resolution`. `contentDetails.isReusable` 쓰기 가능 |
| liveStreams.list | https://developers.google.com/youtube/v3/live/docs/liveStreams/list | 2026-08-17 | 필터 `id` 또는 `mine` 하나 필수, `part ∈ {id, snippet, cdn, status}`, `maxResults` 0–50 |
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
| `apps/server/src/db/migrations/002_broadcast-resources.sql` | 001의 skeleton 대체. attempt 단위 행 + `pending_call`(호출 전 기록) + 단조 stage + 열린 행 1개당 broadcast 1개 unique index |
| `apps/server/src/db/store.ts`, `db/types.ts` | `beginBroadcastAttempt` · `markBroadcastCallPending` · `recordBroadcastCallResult` · `updateBroadcastAttempt` · `closeBroadcastAttempt` · `getBroadcastAttempt` · `findOpenBroadcastAttempt` · `listBroadcastAttempts`. 단계 역행·외부 ID 재지정·닫힌 attempt 호출 거부 |
| `youtube/broadcast/api.ts` | `fetch` + `AbortSignal`(주입 Clock) REST 클라이언트 6개 메서드. 실패를 `not_attempted` / `rejected` / `uncertain`으로 정규화, quota 사전검사·기록, `streamName`을 파싱 즉시 sink로 넘기고 반환 shape·오류 메시지에서 제거 |
| `youtube/broadcast/stream-key.ts` | `StreamKeyCustodian`: stream별 staging → 선택된 stream만 vault write, redactor 등록, unchanged면 미기록, 생성된 stream에 키 없으면 실패 |
| `youtube/broadcast/limits.ts` | 3종 named reason + limit-shaped unknown(일일 한도) 판정, adoptable lifecycle 목록 |
| `youtube/broadcast/lifecycle.ts` | `resume` · `ensureBound` · `goLive` · `ensureLive` · `rollOver` · `stopBroadcast`. 호출 전 영속 → 불확실이면 `list` reconcile → 그 뒤에만 재시도, `invalidAutoStart`/`invalidScheduledStartTime`/`redundantTransition`/`errorStreamInactive` 개별 처리, 한도는 복구 우선 → 불가 시 safe stop |
| `youtube/broadcast/health.ts` | §9.4(6) 신호 3개(`youtube.stream_status`·`youtube.stream_health`·`youtube.broadcast_lifecycle`) + 폴링 모니터. 관측 실패는 `unknown`이며 판정하지 않음 |
| `youtube/broadcast/alerts.ts` | `BroadcastAlertSink` · `SafeStopRequestSink` 인터페이스(구현은 T12) |
| `testing/fake-youtube-api-server.ts` | 상태를 가진 loopback 가짜 API. 지연은 **적용 후 늦게 응답**하므로 timeout이 진짜 불확실 결과가 된다 |
| `config/default.json` `youtube.broadcast` + `broadcast/config.ts` | 전략·공개범위·MFK·지연·auto-start·stream cdn 값과 provisional 목록 |
| `docs/ops/obs-setup.md`, `docs/ops/youtube-auth-setup.md` | stream key는 이제 서버가 vault에 채우고 수동 입력은 fallback임을 명시(기존 안내가 틀린 상태로 남지 않게) |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 가짜 API 서버로 정상 경로 | met | `youtube/broadcast/lifecycle.test.ts` "normal path" 4건: 호출 순서 `liveStreams.list → insert → liveBroadcasts.insert → bind → list → transition(testing) → transition(live)`, 필수 필드·part·Bearer 검증, stream 재사용, monitorStream off일 때 testing 생략 |
| 1 | timeout → reconcile | met | 같은 파일 "uncertain results are reconciled, never retried blindly" 4건: insert timeout 후 insert 요청 **1회**·broadcast **1개**·`call_reconciled=applied`; liveStreams timeout 후 vault에 키 저장; 503 bind는 reconcile이 not_applied를 확인한 뒤에만 재시도(요청 2회); 끝까지 불확실하면 `BroadcastReconcileFailedError` |
| 1 | 3종 한도 오류 | met | 같은 파일 "channel limits" 5건: `userBroadcastsExceedLimit`(복구), `concurrentBroadcastsExceedLimit`(live 방송 채택), 복구 불가 시 `safe_stopped` 요청 + alert + attempt abandoned, 문서화되지 않은 일일 한도(limit-shaped) 동일 경로·insert 1회, `liveStreams` 한도는 stream 재사용으로 복구. reason 매핑 단위 테스트는 `limits.test.ts`(rate limit·quota를 한도로 오분류하지 않음 포함) |
| 1 | invalidAutoStart fallback | met | 같은 파일 "auto-start" 3건: 400 `invalidAutoStart` → alert + `enableAutoStart:false`로 재-insert → transition 2회, attempt `autoStart=false`; auto-start가 실제로 동작하면 transition 0회; 수락됐지만 발화하지 않으면 `auto_start_did_not_fire`로 transition fallback |
| 2 | stream key가 로그·DB·응답에 없음 | met | 같은 파일 "the stream key never leaves the vault" 3건: 반환값·attempt 행 전체·alert·로그 dump·**DB 디렉터리의 모든 바이트(WAL 포함)** 에 키 없음, vault에는 있음; 채널에 stream이 여러 개일 때 선택된 것만 저장; redactor로 마스킹됨. 스키마 차원 강제는 `db/broadcast-resources.test.ts` "has no column that could hold a stream key", 전송 차원은 `api.test.ts` "stream key handling" 3건 |
| 3 | 단계 영속 → 재기동 후 이어가기 | met | 같은 파일 "restart" 3건: `ensureBound` 후 store 재오픈 → `goLive`가 같은 attempt/broadcast/stream으로 이어가고 insert·bind 각 1회; 호출 중 사망(pending transition) → 재기동 `resume()`이 reconcile로 `live` 확정, transition 요청 0회; insert가 이미 만든 broadcast를 `scheduledStartTime`으로 찾아 채택, broadcast 1개 |

### Gates (executed)

```text
$ npm run format:check   -> All matched files use Prettier code style!
$ npm run lint           -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports);
                            check-install-scripts: ok (3 reviewed, better-sqlite3 binding loads)
$ npm run typecheck      -> tsc --build tsconfig.json (no output)
$ npm run test           -> Test Files 64 passed (64) / Tests 1117 passed | 1 skipped (1118)
$ npm run build          -> contract, renderer(vite ✓ built), server(copied 2 migration(s)), simulator ok
```

위 게이트는 `git fetch && git rebase origin/main`(base `751126f`) 뒤에 돌렸다. rebase 직후 `npm run test`가 renderer 3파일에서 `Cannot find package 'jsdom'`로 실패했는데, 원인은 T5(PR #9)가 추가한 devDependency가 이 worktree의 `node_modules`에 없던 것이었다 — `npm install`(lockfile 변경 없음) 후 재실행하여 위 결과를 얻었다.

실행하지 않은 것: 실제 YouTube API 호출. 실계정 검증은 Gate 2 범위이며(§11 "실제 YouTube 계정이 필요한 … mock만으로 완료 판정하지 않는다"), 이 task는 가짜 API 서버까지가 판정 범위다.

## Not done / out of scope

- T12의 supervisor 상태 기계·Discord alert 구현: 이 task는 `BroadcastAlertSink`/`SafeStopRequestSink` 인터페이스와 호출만 제공한다.
- 실제 YouTube 계정 호출·Gate 2 실험(`docs/ops/gate2-experiments.md`는 T16).
- OBS로의 stream key 주입은 T2 `ObsControl.setStreamServiceFromVault()`가 이미 소유한다(A-16). T10은 vault에 키를 넣는 쪽만 담당한다.
- `rolling-experiment`의 프로덕션 자동화(§9.3: 두 전략을 모두 production 구현하지 않는다) — 새 broadcast 생성 → transition → `liveChatId` 교체 신호까지만.

## Follow-ups

- **T12 배선**: `BroadcastLifecycle`은 `BroadcastAlertSink`·`SafeStopRequestSink`·`HealthSignalSink`만 호출한다. T12가 (a) Discord alert 구현(D-3), (b) `safe_stopped` 전이, (c) `BroadcastHealthMonitor` 기동, (d) `ObsControl.setStreamServiceFromVault()` → `startStream()` 순서를 `ensureBound()` **뒤**에 두는 것을 맡는다. `errorStreamInactive`는 `BroadcastStreamInactiveError`로 나오므로 "인코더를 먼저 켜라"는 신호로 쓸 수 있다.
- **T9**: `liveChatId`는 `store.findOpenBroadcastAttempt()?.liveChatId` 또는 `ensureLive()`의 `BroadcastTarget.liveChatId`에서 읽는다(§T9 "T10의 broadcast_resources에서 읽되"). rolling 교체 신호는 새 attempt 행의 `live_chat_id`다.
- **T3 `quota/classify.ts`**: 공용 표에 `sharedIngestionBroadcastsExceedLimit`가 없어 403 → `forbidden`(safe_stopped)으로 분류된다. T10은 자기 `classifyBroadcastLimit`에서 먼저 잡으므로 이 task의 동작에는 영향이 없다. 공용 표에 한 줄 추가하는 것은 T3 소유 파일 변경이라 하지 않았다.
- **Gate 2에서 확정할 것**: 일일 생성 한도의 실제 reason 문자열(있다면), auto-start와 monitorStream 조합의 실제 수용 여부, `scheduledStartLeadMs` 최소값, `liveStreams.status` 폴링 간격, provisional quota 비용.
- `enableDvr`/`recordFromStart`는 config 기본값(false / API 기본)을 그대로 둔다. 12시간 초과 방송의 archive 부재(§4)는 전략 선택 문제이므로 Gate 2 실험에서 결정한다.
- `stopBroadcast()`가 `transition(complete)` 실패 후에도 attempt를 닫는다. 그 경우 YouTube에는 방송이 남을 수 있고 `last_error_reason=complete_failed:*`로 기록된다. 다음 `ensureLive()`의 한도 복구 경로가 그 방송을 찾아 채택한다.
