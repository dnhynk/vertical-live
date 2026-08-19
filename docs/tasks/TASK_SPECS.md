# 구현 작업 명세 (T0–T17)

> 정본: 제품 요구는 `docs/PROJECT_SPEC.md`(이하 "스펙")가 유일한 근거다. 이 문서는 스펙을 PR 단위 작업으로 나눈 것이며, 스펙과 충돌하면 스펙이 이긴다.
> 절차: `docs/runbooks/agent-orchestration.md`. 상태: `docs/tasks/BOARD.md`.
> 고정 결정(2026-08-16, 사용자 확정): TypeScript / Node 24 · SQLite · 이 Windows 11 PC가 1차 호스트 · Discord webhook 알림 · `dnhynk/vertical-live` `main`, squash merge만(저장소는 2026-08-18 public으로 전환 — BOARD D-4).

## 공통 규약 (모든 task)

- **읽기 순서**: `CLAUDE.md` → 이 문서의 해당 절 → 스펙의 지정 절 → `docs/tasks/BOARD.md`의 "가정"과 "결정" 표.
- **모른다고 메우지 않는다.** 스펙에 값이 없으면 (a) 공식 문서(Google/YouTube/OBS/SQLite/Node 등)로 확정하고 URL과 확인 날짜를 티켓에 남기거나, (b) `orca orchestration ask`로 코디네이터에게 묻는다. 둘 다 안 되면 `provisional: true`로 표시한 config 값으로 두고 티켓과 PR "Assumptions"에 적는다.
- **불변조건은 코드로 강제한다** (스펙 §2). 특히: identity gate가 닫힌 V1에서 `authorDetails`·표시명·channelId·안정 hash를 저장하거나 화면에 내지 않는다(§7.4, §12.4); raw chat을 화면에 내지 않는다(§12.3); 결제가 게임 파워를 사지 않는다(§8.5); 크리처는 죽거나 영구 퇴화하지 않는다(§6.3); 가짜 참여를 만들지 않는다(§2.6 — fixture·simulator의 ID/이름도 명백한 합성값만).
- **공용 규격**: 패키지명 `@vl/contract`, `@vl/server`, `@vl/renderer`, `@vl/simulator`. 서버 HTTP/WS `127.0.0.1:8787`(env `VL_PORT`), WS 경로 `/ws/renderer`, 건강 `GET /health`, 지표 `GET /metrics`(JSON), 시뮬레이터 주입 `POST /ingest/simulator`(loopback + bearer token, `simulator.enabled=true`일 때만), kill switch `POST /admin/kill`(loopback + token). DB 파일 `data/vertical-live.db`(gitignore). 설정은 `config/default.json` + env override, 비밀정보는 vault(T3)만.
- **시간**: 영속 시각은 UTC ISO 8601 절대값, 실행 중 간격은 monotonic clock(`process.hrtime.bigint()`/`performance.now()`), 모든 시간 의존 모듈은 주입 가능한 `Clock` 인터페이스를 받는다(§10.2; T11 가상 시계 필요).
- **테스트**: vitest. 성공 경로와 거부/오류 경로를 함께 테스트한다. 실행하지 못한 게이트는 "실행하지 않았음: 이유"로 적는다.
- **일본어 문구**: `apps/renderer/src/i18n/ja.json`(및 서버 측 필요 시 `packages/contract/src/i18n/`)에 두고 항목마다 `"nativeReview": "pending"`을 유지한다. 원어민 sign-off 전에는 "검수됨"이라 쓰지 않는다(§5.3, Gate 3).
- **자산**: 새 시각·음향 자산을 추가하려면 자체 제작(코드/프리미티브) 또는 CC0·상업 이용 허용 라이선스만, 출처·라이선스·날짜를 `ASSETS.md`에 기록한다(§12.1). Pokémon 관련 명칭·형태·UI·음악 금지.
- **브랜치·PR**: worktree 생성 시 Orca가 만든 브랜치(`dnhynk/<slug>`)를 그대로 쓴다. PR 제목 `<type>(<scope>): <summary>` (영어, Conventional Commits). PR 본문은 `.github/pull_request_template.md`.
- **티켓**: `docs/tasks/TASK-<T-ID>-<slug>.md`를 `docs/tasks/TASK_TEMPLATE.md`로 만든다. `## Result`에 실행 명령과 결과를 적는다.

---

## T0 — 모노레포 스캐폴드·CI

- 브랜치 slug `t0-scaffold` · PR 접두 `chore(repo):` · 의존 없음 · `[contract]` 아님
- **목표**: 이후 모든 task가 같은 툴체인에서 돌아가는 뼈대와 CI를 만든다.
- **읽을 것**: 스펙 §10.1, §10.2, §16, `CLAUDE.md`
- **범위**
  - npm workspaces: `packages/contract`, `apps/server`, `apps/renderer`, `tools/simulator`. Node 24(`.nvmrc`, `engines`), TypeScript 5 strict, ESM(`"type":"module"`), tsconfig base + project references, vitest, eslint 9 flat config + prettier, `.editorconfig`.
  - 루트 스크립트: `npm run lint`, `typecheck`, `test`, `build`, `format:check` — 모두 워크스페이스 전체를 돈다.
  - 기존 Vite 앱 중 **R3F 장면 자산만** `apps/renderer`로 이동한다(`components/Pet.jsx`, `components/Background.jsx`, `main.jsx`, css, `public/pet.glb`, `index.html`, `vite.config.js`; JSX 그대로, TS 전환은 T5). `Pet.jsx`의 store 의존은 props 기본값(idle)으로 최소 수정하고, 새 최소 `App.jsx`는 9:16 캔버스에 Background+Pet idle만 마운트한다(게임 로직·이름·결제·사망·Pokemon 문자열 0). 프로토타입 게임 로직·로컬 테스트 패널·overlay(`store.js`, 구 `App.jsx`)와 `server.py`, `extension/`, `artifacts/`는 `legacy/`(렌더러는 `legacy/renderer-prototype/`)로 이동하고 `legacy/README.md`에 "스펙 §10.4·§16에 따라 production 경로에서 제외, 참고용"이라고 적는다. (2026-08-16 R-T0-1 리뷰 결과로 재기술: 스펙 §16이 재사용을 인정한 것은 렌더링 경험뿐이며 CLAUDE.md §3 불변조건은 활성 워크스페이스에서 예외 없이 적용한다.)
  - `packages/contract`: `CONTRACT_VERSION = 1` export + 테스트 1개. `apps/server`: `GET /health` 반환 `{status:"ok"}` 최소 서버 + 테스트 1개. `tools/simulator`: 빈 CLI 뼈대.
  - GitHub Actions `.github/workflows/ci.yml`: PR과 `main` push에서 Node 24, `npm ci`, lint, typecheck, test, build. job 이름 `ci`.
  - `README.md` 상단에 새 구조·실행법 요약(정식 재작성은 T16).
- **범위 밖**: 기능 구현, 계약 정의, 렌더러 개편.
- **합격 기준**
  1. 새 clone에서 `npm ci && npm run lint && npm run typecheck && npm run test && npm run build`가 통과한다(출력을 티켓에 첨부).
  2. `apps/renderer`가 `npm run dev -w @vl/renderer`로 떠서 R3F 장면(Background+Pet idle)을 9:16으로 렌더한다(스크린샷 또는 로그). `apps/renderer` 안에 이름 표시·결제 처리·사망·Pokemon 문자열이 없다(grep 증빙).
  3. CI가 PR에서 녹색이다.
  4. `legacy/`로 이동한 코드는 어떤 워크스페이스에서도 import되지 않는다.

## T1 — 정규 이벤트·snapshot·effect 계약과 fixture `[contract]`

- slug `t1-contract` · PR 접두 `feat(contract):` · 의존 T0
- **목표**: 서버·렌더러·시뮬레이터·adapter가 공유하는 단일 타입/스키마 정본을 만든다. zod 스키마가 정본이고 JSON Schema를 export한다.
- **읽을 것**: 스펙 §5.2, §6.3, §6.4, §7.1–§7.4, §9.2, §10.2; [S3] liveChatMessages 리소스, [S4] streamList 가이드(proto 인라인)
- **범위**
  - `IngestEnvelope`: 모든 API item에 대해 최소 필드 `messageId`, `sourceShape: "grpc"|"rest"|"simulator"`, `source: "youtube"|"simulator"`, `broadcastId`, `liveChatId`, `receivedAt`, `validationStatus: "valid"|"unsupported"|"invalid"`, `validationError?`, 그리고 valid일 때만 정규화 필드(`kind`, `command`, `payment`, `occurredAt`, `giftName?`). author·표시명·raw text는 **필드 자체가 없다**(§7.3(1)).
  - `CanonicalEvent`: 스펙 §7.4 JSON과 필드명·값을 그대로. `eventKey` 규칙(일반 `youtube:{broadcastId}:{messageId}`, Gift `...:gift:{effectiveCount}`), `effectiveCount = comboCount > 0 ? comboCount : 1`. `sourceDataExpiresAt`은 ISO UTC로 두고 값은 보존 정책 상수(§12.4 30일)에서 계산한다. `actor`는 타입상 `null`만 허용(identity extension은 이번 범위 밖).
  - `WorldSnapshot`: `stateRevision`, `processedIngestSeq`, `worldTimeUtc`, `inputMode: "direct"|"aggregate"`, `interactionEnabled`, `broadcastLifecycle`(§9.2 6개 값), §6.3의 최소 상태(크리처 식별자·생애/성장 단계, 욕구·정서, 유대·성장 진행도, 활성 미션·선택지, 환경/시간/날씨/챕터, 다음 전이 절대 시각, 시즌 optional), 그리고 렌더러용 `display` 블록 = §5.2의 4개 고정 정보(`currentNeedOrMission`, `lastAppliedAction`, `growthOrChapterProgress`, `nextChoiceAt`) + `aggregateWindow?`(모드·남은 시간·집계 결과, §6.4).
  - `Effect`: `effectId`, `kind`, `causedByEventKey`, `stateRevision`, `startsAt`, `endsAt`(절대 시각), `paid: boolean`, `payload`(kind별 discriminated union; 이름 표시 필드는 없음).
  - WS 프로토콜: 서버→렌더러 `snapshot`, `effect`, `ping`; 렌더러→서버 `hello{rendererId,lastAppliedStateRevision}`, `ack_state{stateRevision,appliedAt}`, `ack_effect{effectId,appliedAt}`, `renderer_health{frameCounter,fps,webglContextLost,lastAppliedStateRevision,lastAppliedEffectId}`(§7.3(6)(7), §9.4(4)).
  - 명령 정의: `CommandName = FEED|PLAY|PET|VOTE_A|VOTE_B|VOTE_C`, 별칭 표 데이터(§7.1의 일본어·아이콘·영어 예시 포함, `nativeReview: pending`), 정규화 규칙은 T6이 구현하되 별칭 데이터는 여기.
  - enum: `DeadlinePolicy = replay|coalesce|skip`(§10.2), `BroadcastLifecycle`(§9.2), `EventKind`(§7.4).
  - **Source adapter 정규화 함수 2개**: `fromGrpcStreamListItem(item)`, `fromRestListItem(item)` → `IngestEnvelope`. 필드명은 [S4] proto(snake_case, `snippet.gift_details`)와 [S3] REST(camelCase, `snippet.giftEventDetails.giftMetadata`)를 **각각** 따르고 섞지 않는다. 지원 type: textMessageEvent, superChatEvent, superStickerEvent, gift(Jewels) event, newSponsorEvent, memberMilestoneChatEvent, membershipGiftingEvent, giftMembershipReceivedEvent → 나머지는 `unsupported`. type 이름과 필드는 [S3]/[S4]에서 확인해 티켓에 URL과 확인 날짜를 남긴다.
  - **Fixture**: `packages/contract/fixtures/{grpc,rest}/*.json` — 각 지원 type, comboCount 0/1/3/5 Gift 시퀀스, 미지원 type, 필드 누락·형식 오류 item, Unicode·URL·금칙어가 든 텍스트. 이름/ID는 합성값(`UC_TEST_...`, `msg_test_...`).
- **범위 밖**: 파서 로직, DB, 렌더링.
- **합격 기준**
  1. 모든 fixture가 스키마 테스트를 통과하고, `unsupported`/`invalid` fixture도 최소 envelope를 만든다(§7.3(1)).
  2. Gift fixture 시퀀스로 `eventKey`와 `effectiveCount`가 스펙 §7.4 규칙대로 나온다(delta 계산은 T8).
  3. `IngestEnvelope`·`CanonicalEvent`·`Effect`·`WorldSnapshot`·WS 메시지의 JSON Schema가 `packages/contract/schema/*.json`으로 생성되고 CI에서 최신인지 검사한다.
  4. 타입 어디에도 author/표시명/channelId 필드가 없다(테스트로 키 목록 검사).

## T2 — obs-websocket 5 감시·제어 + OBS 프로파일

- slug `t2-obs-monitor` · PR 접두 `feat(obs):` · 의존 T0
- **읽을 것**: 스펙 §9.4(5)(7), §10.2, §10.3, §11 "송출"·"화면", [S21] obs-websocket, [S26] 인코더 권장 설정, [S27] RTMPS
- **범위**
  - `apps/server/src/obs/`: obs-websocket protocol v5 클라이언트(`obs-websocket-js` v5 계열, exact version 고정). loopback 주소·인증 비밀번호는 vault(T3) 인터페이스를 통해 받되 T3 전에는 env `VL_OBS_PASSWORD`로 임시(주석에 T3 연동 TODO 금지 — 대신 `SecretProvider` 인터페이스를 이 task에서 정의하고 env 구현을 넣는다).
  - 건강 신호 producer: stream active/reconnecting, `outputBytes`·`outputDuration` 증가 여부, skipped/dropped frame, congestion, 재연결 횟수 → `HealthSignal` 타입(`apps/server/src/health/types.ts`; T12가 집계).
  - 제어: StartStream/StopStream, Browser Source 새로고침(`refreshnocache`), 씬 전환. 각 명령은 결과 검증 후 반환한다.
  - `ops/obs/`: 9:16 1080x1920 30fps, H.264 CBR, keyframe 2초, RTMPS 프로파일과 Browser Source(`http://127.0.0.1:5173/?mode=broadcast` 또는 빌드 서빙 주소) 1080x1920 씬 컬렉션. 값의 근거는 [S26][S27]에서 인용.
  - `docs/ops/obs-setup.md`: 설치 버전 고정, websocket 서버 활성화·loopback·비밀번호, 프로파일/씬 import 절차, legacy 4.x plugin 설치 금지(§10.3).
- **범위 밖**: supervisor 상태기계(T12), Windows 자동시작(T17).
- **합격 기준**
  1. 가짜 obs-websocket v5 서버(handshake·auth·요청/응답·이벤트) 또는 mock에 대한 테스트로 연결·인증·재연결·`GetStreamStatus` 파싱·이벤트 구독이 검증된다.
  2. 로컬 OBS가 있으면 실제 연결 스모크(`npm run obs:probe`)를 실행해 출력 첨부; 없으면 "실행하지 않았음" 명시.
  3. 프로파일 값이 [S26][S27]과 일치함을 문서에 표로 대조.

## T3 — OAuth·비밀정보 vault·quota 계정

- slug `t3-auth-vault` · PR 접두 `feat(auth):` · 의존 T0
- **읽을 것**: 스펙 §9.1, §10.2(비밀정보·scope), §11 fault matrix 행(OAuth 만료·철회·403·429·quota), §12.4; Google OAuth 2.0 installed-app 문서, YouTube Data API scopes 목록, quota 계산 문서
- **범위**
  - `apps/server/src/youtube/auth/`: OAuth 2.0 installed-app(loopback redirect) 로그인 CLI(`npm run auth:login -w @vl/server`), 최소 scope(어떤 scope가 liveChatMessages/liveBroadcasts/liveStreams에 필요한지 공식 문서로 확정하고 티켓에 URL), access-token 자동 갱신, refresh-token 회전 처리, `invalid_grant`/철회 감지 → `AuthRevoked` 이벤트(T12 alert, T13 삭제 트리거용 hook).
  - `SecretProvider` 구현: Windows Credential Manager(DPAPI) 기반(유지보수되는 Node 바인딩을 선택하고 근거를 티켓에; 후보 비교표 필수), 비-Windows/CI용 fallback은 테스트 전용 in-memory. 저장 대상: OAuth refresh token, stream key, obs-websocket 비밀번호, simulator/admin bearer token. 로그·에러 메시지에 값이 찍히지 않음을 테스트.
  - Quota 계정: 메서드별 단위 비용 표(공식 문서 인용), 일일 사용량 추적, `quotaExceeded`/403/429 분류와 backoff 정책 인터페이스(T9/T10이 사용).
  - Google 클라이언트 라이브러리는 `googleapis` 공식 패키지, exact version.
- **합격 기준**
  1. 가짜 OAuth 서버로 로그인·갱신·회전·철회 시나리오 테스트 통과.
  2. vault round-trip 테스트(Windows에서 실제 Credential Manager, CI에서는 fallback) 통과.
  3. quota 표에 모든 사용 예정 메서드(liveChatMessages.list/streamList, liveBroadcasts.insert/list/bind/transition, liveStreams.insert/list)가 있고 근거 URL이 있다.

## T4 — SQLite 영속층: inbox·checkpoint·snapshot·outbox·deadline

- slug `t4-persistence` · PR 접두 `feat(db):` · 의존 T1
- **읽을 것**: 스펙 §7.3(2)(3)(5)(7), §7.4, §9.2, §10.2, §11 "상태 복구"·"유료 무결성"; SQLite WAL·synchronous 문서
- **범위**
  - `apps/server/src/db/`: `better-sqlite3`(exact version), 마이그레이션 러너(순번 SQL 파일), WAL 모드. journal/synchronous 설정은 "호스트 전원 장애 후에도 commit된 유료 이벤트가 남는다"를 만족하는 값으로 sqlite.org 문서를 인용해 고른다.
  - 테이블(최소): `ingest_inbox(ingest_seq PK AUTOINCREMENT, message_id, source, source_shape, broadcast_id, live_chat_id, received_at, validation_status, envelope_json, processed_at NULL, processing_result NULL)` + `UNIQUE(source, broadcast_id, message_id, gift_effective_count?)`(Gift는 eventKey 단위); `source_checkpoint(source_key PK, live_chat_id, next_page_token, last_ingest_seq, updated_at)`; `world_snapshot(world_id PK, state_revision, processed_ingest_seq, snapshot_json, updated_at)`; `state_transitions(revision, caused_by_event_key NULL, kind, at)`; `deadlines(id PK, kind, due_at, policy, payload_json, status)`; `effect_outbox(effect_id PK, caused_by_event_key, kind, paid, starts_at, ends_at, payload_json, published_at NULL, acked_at NULL, expired_at NULL)`; `paid_ledger(event_key PK, kind, amount_micros, currency, tier, jewels, applied_at)`; `gift_combo(base_key PK, stored_max)`; `broadcast_resources(...)`(T10이 컬럼 확정, 뼈대만); `retention_ledger(field_key, source, purpose, allowed_until, deleted_at)`(T13용 뼈대).
  - API: `commitIngestBatch(envelopes, checkpoint)` — 한 트랜잭션에서 inbox insert(중복 message는 무시하되 결과 보고) + `ingestSeq` 발급 + checkpoint 갱신(§7.3(2)); `drainUnprocessed(afterSeq, limit)`; `commitStateTransition({snapshot, revision, processedSeq, transitions[], deadlines[], effects[], paidLedger[], giftCombo[]})` 한 트랜잭션(§7.3(5)); `markEffectPublished/Acked/Expired`; `upsertGiftMax(baseKey, effectiveCount) → delta`(§7.4: `delta = max(0, effectiveCount - storedMax)`, storedMax 비감소).
  - 시작 복구: 마지막 snapshot·`processedIngestSeq`·미ACK effect·due deadline 로드 API.
- **합격 기준**
  1. crash-window 테스트: inbox insert 뒤/checkpoint 전, state 쓰기 중, effect 기록 뒤/ACK 전 각각 예외를 주입해도 부분 commit이 없다(트랜잭션 원자성).
  2. 같은 message를 두 번 commit해도 inbox에 1건, Gift combo 0→1→3→5→3(감소 무시) 시퀀스에서 delta가 1,0,2,2,0이다.
  3. `PRAGMA journal_mode`/`synchronous` 선택 근거 URL이 티켓에 있다.
  4. `busy_timeout`과 lock 오류 분류가 있고 테스트된다(fault matrix "DB lock").

## T5 — 렌더러 read model: snapshot 복구·effect 멱등·ACK·건강 신호

- slug `t5-renderer-readmodel` · PR 접두 `feat(renderer):` · 의존 T1
- **읽을 것**: 스펙 §5.2, §7.3(6)(7), §9.2(degraded CTA), §9.4(4), §10.2, §11 "화면", §12.3, §16
- **범위**
  - `apps/renderer`를 TypeScript로 전환하고 `@vl/contract` 타입 사용. 기존 R3F 장면(`Pet.jsx`, `Background.jsx`)은 시각 자산으로 유지(TSX 전환). 프로토타입 게임 로직·테스트 패널은 T0에서 `legacy/renderer-prototype/`로 이미 격리됐으므로 참고만 하고 import하지 않는다(권위는 서버).
  - WS 클라이언트: 재연결 backoff, `hello`(마지막 적용 revision), `snapshot` 전체 치환, `effect`는 `effectId` 집합으로 1회만 시작(재수신 무시), `ack_state`/`ack_effect`는 실제 프레임에 적용된 뒤 전송, `renderer_health` 주기 송신(rAF 프레임 카운터, FPS, WebGL `webglcontextlost/restored` 처리와 보고).
  - 9:16 1080x1920 고정 캔버스, §5.2의 4개 고정 정보 슬롯을 `snapshot.display`에서만 그린다. raw chat·이름 표시 UI 없음. `interactionEnabled=false`면 CTA를 숨기고 "相互作用一時停止"(ja.json, nativeReview pending) 표시.
  - `?mode=broadcast`(OBS용, 패널 없음)와 `?mode=dev`(디버그 패널: 연결 상태·revision·effect 로그; 이벤트 주입 UI는 T11).
  - 새로고침 시 로컬 저장 없이 서버 snapshot만으로 복구(§10.2).
- **합격 기준**
  1. jsdom 테스트: 같은 effectId 재수신 시 연출 1회, snapshot 적용 후 ack_state 송신, 연결 끊김→재연결 후 hello에 마지막 revision 포함.
  2. WebGL context loss를 시뮬레이션하면 renderer_health에 반영되고 복구 시도 로그가 남는다.
  3. `npm run build -w @vl/renderer` 성공, 1080x1920에서 4개 정보 슬롯 스크린샷 첨부.
  4. 코드 어디에도 랜덤 이름·가짜 사용자 이벤트 생성이 없다(§2.6).

## T6 — 명령 파서·모더레이션·입력 arbiter

- slug `t6-command-parser` · PR 접두 `feat(input):` · 의존 T1
- **읽을 것**: 스펙 §6.4, §7.1, §7.2, §7.3(1)(4), §11 "모더레이션", §12.3
- **범위**
  - `apps/server/src/input/`: 순수 함수. `normalizeText`(Unicode NFKC, zero-width·제어문자·RTL override 제거, 대소문자 정규화, 공백 정리) → allowlist·별칭(T1 데이터) 매칭 → `ParsedCommand | Rejection{reason}`. 자연어 해석·LLM 없음(§7.1).
  - 거부 규칙: URL, 개인정보 패턴, 혐오·성적·자해·폭력·광고/사기 금칙어 목록(데이터 파일, ja/en; 출처를 티켓에), 명령 뒤 임의 텍스트 정책(명령+짧은 인자만 허용). 거부 이유는 코드로만 기록, 원문은 저장하지 않는다.
  - `VOTE_A/B/C`: `identity.gateOpen && voteWindowOpen`일 때만 수락, 아니면 `vote_disabled`(§6.4, §7.1).
  - Input arbiter: 모드 `direct`(순서대로 반영) / `aggregate`(창 단위 집계, 기여 수 보존). 전환 임계값·창 길이는 `config.input.*`에 `provisional: true`로 두고 BOARD 가정에 기록(§6.4). 사용자별 cooldown 없음(actor=null). 전역 flood control(창당 최대 처리 수, 초과분은 집계로만 반영).
  - 지표: 명령처럼 보이는 메시지 수 vs 수락 수(§14.1 "명령 성공").
- **합격 기준**
  1. adversarial fixture(T1 + 추가: 혼동 문자, 결합 문자, 전각/반각, URL 변형, 반복 flood)에서 우회 0건, 정상 별칭(`ごはん`, `🍙`, `FEED`, `feed`)은 모두 `FEED`.
  2. 모드 전환과 창 집계가 시계 주입으로 결정적으로 테스트된다.
  3. 거부된 입력의 원문이 어떤 로그·반환값에도 없다(테스트).

## T7 — 콘텐츠 디렉터·크리처 상태 모델 (순수 도메인)

- slug `t7-content-director` · PR 접두 `feat(world):` · 의존 T1
- **읽을 것**: 스펙 §2.1–§2.4, §5.2, §5.3, §6 전체, §8.4, §8.5, §9.2(유료 대체 감사 연출), §10.2(deadline 정책), §12.5, §14.1 "신선도"
- **범위**
  - `apps/server/src/world/`: 순수 reducer `step(state, input: {kind:"event", event}|{kind:"deadline", deadline}, now, rng) → {state, transitions[], effects[], deadlines[]}`. I/O·DB·타이머 없음(T8이 감싼다). RNG는 시드 주입.
  - 상태: §6.3 최소 항목 + 표시용 파생값(§5.2). 욕구·정서 감쇠, 유대·성장 진행, 성장 단계 전이(무료 참여만으로 완주 가능, §2.3), 위기 상태는 `sleeping|tired|needs_help`처럼 시간·무료 행동으로 회복(§6.3, 죽음·영구 퇴화 없음).
  - 시간 규모별 콘텐츠(§6.2 Gate 3 필수 4단): 수초(effect), 수분(욕구 해결·놀이 목표·장소 선택), 수시간(날씨·방·방문자·성격 반응), 하루(재료·축제 준비·성장/진화 선택이 있는 시작→변화→결말 챕터). 콘텐츠는 데이터 정의(`content/*.ts|json`)로 두고 각 deadline 종류에 `policy: replay|coalesce|skip`을 명시(§10.2).
  - 선택 분기: `identity.gateOpen=true`면 A/B/C 투표 창(집계 결과로 결정), `false`면 스펙 §6.4에 따라 분기 투표 비활성 → 디렉터가 승인된 사건 조합 규칙과 비경쟁 집계(무료 명령의 총 기여)로 진행하고 화면에는 "다음 선택 시점"을 디렉터 예고로 표시. 두 경로 모두 구현하고 플래그로 나눈다.
  - 유료 이벤트 반응: 고정 감사 동작·연출만(§8.4), 어떤 상태 확률·성장·투표에도 영향 없음(§8.5)을 타입/테스트로 강제. 원래 연출 시간이 지난 유료 이벤트는 "대체 감사 연출" 1회(§9.2).
  - 반복 방지(§12.5): 같은 명령이라도 상태·챕터·환경에 따라 다른 transition/effect 변형이 나오도록 하고 "고유 상태 전이 수", "반복 장면 표본 비율" 계산 함수 제공.
- **합격 기준**
  1. 입력 0으로 가상 24시간(시계·시드 주입) 진행 시 일일 챕터가 시작·변화·결말을 갖고, 고유 전이 수가 사전 정의 최소치 이상이며(값은 provisional 라벨), 크리처가 죽지 않는다.
  2. 같은 시드·같은 입력 시퀀스 → 같은 결과(결정성).
  3. 유료 이벤트가 상태 수치·확률·선택 결과를 바꾸지 않는다는 속성 테스트.
  4. 모든 deadline 종류에 policy가 있고 누락 시 타입 오류.

## T8 — 상태 엔진: 단일 writer·outbox·WS 발행·ACK·유료 멱등

- slug `t8-state-engine` · PR 접두 `feat(engine):` · 의존 T4, T6, T7
- **읽을 것**: 스펙 §7.3 전체, §7.4, §7.5, §9.2, §10.2, §11 "상태 복구"·"유료 무결성"·"엔진 지연"
- **범위**
  - `apps/server/src/engine/`: 단일 writer 루프. 입력 = inbox 미처리 envelope(`ingestSeq` 순) + due deadline을 시각 기준으로 병합. 각 envelope: 무효/미지원은 이유와 함께 처리 완료로 전진(§7.3(3)); 유효는 dedupe(paid_ledger/gift_combo/eventKey) → T6 파서/arbiter → T7 reducer → T4 `commitStateTransition` 한 트랜잭션 → WS 발행 → ACK 추적(`ackedAt` 또는 만료).
  - 시작 순서(§7.3(3)): snapshot 로드 → deadline 정책 적용(replay/coalesce/skip) → inbox drain → 그 다음에야 source 수신 재개 신호(T9는 `engine.ready`를 기다린다).
  - degraded 규칙(§9.2): 입력 또는 renderer ACK 불건전 시 `interactionEnabled=false` snapshot 발행; degraded 중 수신 이벤트는 inbox에 보존, 복구 후 유효시간(콘텐츠 정의) 내면 처리, 지나면 `expired`; 유료는 commit 전 "접수 완료" 표시 금지, 원 연출 시간이 지나면 대체 감사 연출 1회.
  - 지연 계측(§7.3(8), §7.5): receivedAt→committedAt→publishedAt→ackedAt 히스토그램을 `/metrics`에 노출.
  - Effect 발행 멱등: 같은 effectId 재전송 시 렌더러가 무시하는 것을 전제로 재전송 정책(미ACK 재전송 간격)을 둔다.
  - `Clock` 주입, `POST /ingest/simulator`(T11이 사용) 수신 → `commitIngestBatch`.
  - **추가(2026-08-17, 선행 task 리뷰 결과 — 의존 T1b·T4·T6·T7 머지본 기준)**:
    - Effect 조립(A-17): T7 reducer가 반환하는 `EffectDraft.cause`({kind:'event',eventKey}|{kind:'deadline',deadlineKind})로 `@vl/contract` `Effect`를 조립한다 — `effectId` 발급, `stateRevision`, `causedByEventKey`(event면 eventKey, deadline이면 null), 유료는 event 유래만. T4 `effect_outbox`의 cause 컬럼(cause_kind/cause_deadline_kind/cause_deadline_id, CHECK 제약)에 맞춰 저장한다.
    - T4 `commitStateTransition`의 커서 규칙: `processedSeq` 전진은 (이전, 새] 구간 모든 inbox 행의 처리 기록을 함께 넘겨야 통과한다(`ProcessedCursorError`) — 무효/미지원 envelope도 처리 기록을 남겨 전진시킨다(§7.3(3)).
    - T7 `planDeadlineRecovery`/`recoverDeadlines`(replay/coalesce/skip + recurrence)를 시작 시 적용하고, 결과 `deliver`만 reducer에 전달한다. world tuning(`FRESHNESS_MINIMUMS` 등 provisional 값)은 `config/default.json`(`provisional: true`)에서 읽어 `step()`에 주입한다(A-15).
    - T6 arbiter의 창 마감 payload는 명령별 `{directApplied, aggregatedOnly}`이다 — `aggregatedOnly`만 집계 적용해 재적용·유실을 막는다(§6.4). `command.argument`는 현재 선택창(`mission.choices`)이 기대하는 어휘일 때만 상태에 들어가고, 그 외는 이유 코드와 함께 버린다(원문 미저장).
    - `.gitignore`의 `data/` 규칙을 `/data/`(저장소 루트 DB 디렉터리만)로 좁힌다 — T6에서 `apps/server/src/input/data`가 숨겨졌던 사례.
    - `POST /ingest/simulator`는 `simulator.enabled=false`면 404, loopback + bearer token(vault)이며 envelope 스키마 검증 실패는 400.
- **합격 기준**
  1. replay 테스트: 같은 inbox 내용으로 두 번 부팅하면 같은 snapshot·revision(결정성) — T7 시드 고정.
  2. 유료 무결성: 동일 Super Chat 두 번 → paid_ledger 1건·effect 1건; Gift combo 시퀀스에서 delta만 반영; 같은 paid effectId 재발행 시 새 effect row 없음.
  3. commit 후 발행 전 프로세스 종료 → 재기동 시 미ACK effect가 재발행되고 렌더러 snapshot으로 정합.
  4. degraded 창 replay: CTA 비활성 발행, 만료 명령 `expired`, 유료 대체 감사 연출 1회.
  5. 로컬에서 API 수신→ACK p95를 측정한 수치를 티켓에 기록(합격선 자체는 Gate 2 후 잠금, §7.5).

## T9 — YouTube source adapter: gRPC streamList + REST fallback

- slug `t9-youtube-adapter` · PR 접두 `feat(youtube):` · 의존 T3, T4, T8
- **읽을 것**: 스펙 §4(streamList·ultra-low latency 행), §7.2, §7.3(1)(2), §9.4(3), §11 "연결 복구"; [S3], [S4](proto·데모)
- **범위**
  - [S4]의 proto를 `apps/server/proto/stream_list.proto`로 복사(출처 URL·복사 날짜 헤더), `@grpc/grpc-js` + `@grpc/proto-loader`(exact version)로 클라이언트 생성. `parts = id,snippet`만(§7.2), `authorDetails` 요청 금지(테스트).
  - 재연결: `next_page_token`을 checkpoint에서 복원, backoff, keepalive 설정, gRPC status별 처리(UNAVAILABLE 재시도, PERMISSION_DENIED/UNAUTHENTICATED → T3 갱신 또는 AuthRevoked, RESOURCE_EXHAUSTED → quota 정책).
  - REST fallback `liveChatMessages.list`: 서버가 준 `pollingIntervalMillis` 준수(§4), `nextPageToken` checkpoint 공유.
  - 각 응답의 모든 item → T1 adapter(gRPC/REST 각각) → `commitIngestBatch`(같은 트랜잭션에 token checkpoint, §7.3(2)). poison item이 있어도 checkpoint는 전진.
  - 건강 신호(§9.4(3)): transport 상태, keepalive, reconnect 횟수, 마지막 token, 마지막 사용자 이벤트 시각 — 무수신만으로 degraded 판정하지 않음. 재연결 시 중복·손실 추정치 보고(§11).
  - `liveChatId` 획득: T10의 `broadcast_resources`에서 읽되 T10 전에는 config로 주입 가능.
- **합격 기준**
  1. 가짜 gRPC 서버(proto 동일)로 스트림 수신·token 재개·중간 끊김·poison item·REST fallback 전환 테스트 통과.
  2. 요청 parts에 `authorDetails`가 없음을 테스트로 고정.
  3. 실계정 없이 완료 판정 가능한 범위를 티켓에 명시하고, 실계정 검증 절차는 `docs/ops/gate2-experiments.md`(T16)로 넘긴다.

## T10 — broadcast lifecycle·reconcile·한도 처리

- slug `t10-broadcast-lifecycle` · PR 접두 `feat(broadcast):` · 의존 T3, T4
- **읽을 것**: 스펙 §4(liveBroadcasts 행), §9.1(reconcile·3종 한도), §9.3, §9.4(6), §17(방송 길이 미정); [S33][S34][S37][S39]
- **범위**
  - `apps/server/src/youtube/broadcast/`: liveStreams 생성/재사용(RTMPS ingestion 주소, stream key는 vault로만), liveBroadcasts insert(미래 scheduledStartTime, 9:16 관련 설정은 공식 문서에서 확인 가능한 것만), bind, transition(testing→live), auto-start 시도 후 `invalidAutoStart`면 transition fallback(§4), 각 호출 전 `broadcast_resources`에 외부 ID·lifecycle 단계 영속, 결과 불확실(timeout) 시 `list/get`으로 reconcile 후에만 재시도(§9.1).
  - 오류: `userBroadcastsExceedLimit`, 일일 생성 한도, `concurrentBroadcastsExceedLimit` → 기존 방송 복구 우선, 불가 시 `safe_stopped` 요청 + alert hook(§9.1).
  - `liveStreams.status`(streamStatus/healthStatus/configurationIssues) 폴링 → 건강 신호(§9.4(6)).
  - 전략 플래그 `broadcast.strategy = "single" | "rolling-experiment"`(기본 `single`). rolling은 새 broadcast 생성→transition→`liveChatId` 교체 신호까지만, "실험" 라벨. 프로덕션 자동화 전략은 Gate 2 후 결정(§9.3, BOARD 가정).
  - quota는 T3 계정 모듈 사용.
- **합격 기준**
  1. 가짜 API 서버로 정상 경로, timeout→reconcile, 3종 한도 오류, invalidAutoStart fallback 테스트 통과.
  2. stream key가 로그·DB·응답에 없음(테스트).
  3. lifecycle 단계 영속 → 재기동 후 이어서 진행하는 테스트.

## T11 — 로컬 시뮬레이터·replay·지연 계측

- slug `t11-simulator-replay` · PR 접두 `feat(sim):` · 의존 T5, T8
- **읽을 것**: 스펙 §7.3(8), §7.5, §9.2, §11(모더레이션·유료 무결성·상태 복구·엔진 지연), Gate 1 "local simulator"
- **범위**
  - `tools/simulator`: 시나리오 파일(JSON/TS)로 envelope 시퀀스 생성 → `POST /ingest/simulator`. 시나리오: idle(입력 0) 24h 가상 시계, 저참여 direct, 고참여 aggregate 전환, flood, 악성(Unicode·URL·금칙어), 유료 replay(Super Chat 중복, Gift combo, 멤버십), degraded 창(엔진 degraded 강제 후 이벤트 주입).
  - 렌더러 `?mode=dev` 패널에서 시나리오 실행·단일 이벤트 주입(서버 API 경유, 렌더러 로컬 상태 조작 금지).
  - 계측: 서버 `/metrics` 구간별 p50/p95를 읽어 리포트 출력(`npm run sim:report`).
  - `npm run test:replay`: §11 행에 대응하는 자동 시나리오(유료 무결성, 모더레이션 우회 0, 백엔드 재시작 후 미처리 ingestSeq 복구).
- **합격 기준**
  1. 모든 시나리오가 CI에서 통과(가상 시계 사용, 실시간 대기 없음).
  2. 리포트에 구간별 p95가 출력되고 티켓에 로컬 수치를 기록(합격선 잠금은 아님).
  3. 시뮬레이터가 만든 이벤트는 `source: "simulator"`로만 표시되고 공개 방송 경로에서 `simulator.enabled=false`면 엔드포인트가 404다.

## T12 — supervisor 상태기계·건강 집계·kill switch·알림·dead-man

- slug `t12-supervisor` · PR 접두 `feat(ops):` · 의존 T2, T8, T9, T10
- **읽을 것**: 스펙 §2.9, §9.1, §9.2, §9.4, §10.2(하나의 component에 하나의 supervisor), §11(관측성·안전 정지), §12.3(safe_stopped 조건), [S23]
- **범위**
  - `apps/server/src/supervisor/`: 상태기계 `offline→starting→live→degraded→recovering→live | safe_stopped`(§9.2), 전이 규칙은 8개 건강 신호(§9.4) 집계 결과로만. `starting` 사전 점검(자격·비밀정보·상태·API·렌더러·인코더).
  - 단일 restart supervisor: 컴포넌트(엔진, adapter, obs 연결, 렌더러 소스 새로고침, OBS 프로세스)마다 하나, backoff, 최대 재시도 후 `safe_stopped`.
  - `safe_stopped` 트리거: 권리·정책·데이터 무결성 오류, 계정 정지/strike/재동의 필요(§9.1), 모더레이션 제어 불건전(§12.3) → 자동 재시작 금지 + alert.
  - kill switch: `POST /admin/kill`(loopback+token) + 로컬 파일 플래그 + CLI. 
  - 알림: `AlertSink` 인터페이스 + Discord webhook 구현(URL은 vault), 심각도·중복 억제, 전달 실패 로그. 모더레이션 호출표(§12.3, Gate 0)는 config 자리만.
  - dead-man: Uptime Kuma push URL로 주기 heartbeat(§9.4(8)), off-host availability 사건은 외부에서 기록됨을 문서화. 주기 screenshot은 진단 저장만(freeze 판정 아님, §9.4).
  - `/health`에 상태기계·신호 요약.
  - **추가(2026-08-18, 선행 task가 T12에 남긴 배선 — 각 티켓/PR 참조)**:
    - 시작 순서(§7.3(3)·§9.1): DB 열기·마이그레이션 → 엔진 복구(T8 `engine.ready`) → T13 `RetentionScheduler.start()`·`RevocationAuthEventSink`를 T3 TokenManager sink에 연결 → T10 `ensureBound()` → T2 `ObsControl.setStreamServiceFromVault()` → `startStream()` → T9 chat source 시작(liveChatId는 T10 `broadcast_resources`의 열린 attempt에서 resolver로 읽음; config fallback은 개발 전용) → 마커 제거 후 `publish()`(A-18) — 이 순서를 코드와 테스트로 고정.
    - T2 `HealthSignal`, T9 §9.4(3) 신호, T10 §9.4(6) 신호, T8 writer 실패(`lastFailure`/`consecutiveFailures`), 렌더러 `renderer_health`(§9.4(4))를 하나의 집계기로 모아 §9.2 전이를 결정하고 `interactionEnabled`를 엔진에 지시.
    - T13 스케줄러/철회 sink의 `onResult/onError`를 필수로 연결하고 `clean===false`·`rowsUnprocessed>0`은 alert.
    - `metrics_daily` 테이블이 생기면 T13 retention.json의 상태를 `planned`→`present`로 갱신(T15와 조율).
    - `/admin/kill`은 T8 엔진의 `POST /admin/kill` 자리와 통합(loopback+token, vault). 렌더러 토큰(`server.rendererToken`)과 OBS Browser Source URL 주입은 T17과 분담(T12는 obs-websocket `SetInputSettings`로 URL+토큰 주입 함수 제공).
    - AlertSink Discord 구현의 webhook URL은 vault(`alerts.discordWebhookUrl`), 심각도·중복 억제·전달 실패 로그.
- **합격 기준**
  1. 신호 조합별 전이 테이블 테스트(입력 불건전→degraded+CTA off, 복구→live, 정책 오류→safe_stopped 후 자동 재시작 없음).
  2. kill switch 3경로 테스트, alert 전송 mock 테스트, dead-man push mock 테스트.
  3. 각 컴포넌트에 supervisor가 정확히 하나임을 구조 테스트로 고정.

## T13 — 데이터 보존·삭제·철회 자동화

- slug `t13-data-policy` · PR 접두 `feat(privacy):` · 의존 T3, T4
- **읽을 것**: 스펙 §7.4(actor), §12.4, §14.1(승인 전 금지 지표), [S12][S41][S42]
- **범위**
  - `config/retention.json`: field별 source·목적·허용 기간·정책(refresh|delete) — inbox envelope, checkpoint, paid_ledger, snapshot, metrics 집계. 개인 식별자는 없음을 명시.
  - 스케줄 job: 30일 규칙 삭제/refresh, 삭제 실행을 `retention_ledger`에 기록. client-side 동의 철회(T3 `AuthRevoked`) → token revoke + Authorized Data 7일 내 삭제 경로. Google 측 철회 30일 규칙 분기. 사용자 삭제 요청 handler는 저장 식별자가 없음을 확인하고 기록만 남김(향후 gate용 인터페이스).
  - 파생 지표 가드: 승인 전 후보 지표(§14.1의 "승인 후 후보")를 계산·저장하는 코드가 없음을 테스트로 고정.
  - `docs/ops/data-map.md`: 필드별 표.
- **합격 기준**
  1. 가상 시계로 30일 경과 시 삭제·기록, 철회 시 7일 내 삭제 테스트 통과.
  2. DB 스키마 전체에서 author/channel/hash 컬럼이 없음을 테스트.

## T14 — 렌더러 화면 완성: 5초 무음 이해·감사 연출·i18n

- slug `t14-renderer-screen` · PR 접두 `feat(renderer):` · 의존 T5, T7
- **읽을 것**: 스펙 §5.2, §5.3, §6.1, §6.4(모드 표시), §8.4, §8.5(유료 CTA 문구), §12.1, §12.3, §12.5
- **범위**
  - 4개 고정 정보 슬롯(현재 욕구/미션·방금 반영된 행동·성장/챕터 진행·다음 선택 시점)을 일본어 주 표기 + 아이콘 + 짧은 영어 별칭으로. 내부 수치 나열 금지(§5.2).
  - 모드 표시(direct/aggregate·남은 시간·집계 결과), CTA(무료 명령 3개 + "無料でもすべて達成できます" 취지 문구, ja.json pending), CTA 비활성 상태.
  - 유료 감사 연출: 고정 동작·연출·익명 아이콘만(§8.4), 이름 표시 없음, 지출 순위표 없음(§8.5). 멤버 정체성은 배지/이모지 아이콘.
  - 시각 변주: 상태·챕터·환경(날씨·방·시간대)에 따른 배경·조명 변화(§12.5).
  - 성능: 1080x1920@30에서 프레임 카운터가 유지되는지 로컬 측정.
  - 새 자산은 `ASSETS.md`에 출처·라이선스. (2026-08-17 정정: `pet.glb`는 Pokémon 실루엣으로 확인되어 T5에서 `legacy/renderer-prototype/`로 격리됐고 렌더러는 코드 생성 primitive placeholder를 쓴다 — T14는 이를 원본 크리처 자산(자체 제작 또는 CC0·상업 허용, `ASSETS.md` 기록)으로 대체한다.)
- **합격 기준**
  1. 스토리북 없이 `?mode=dev`에서 대표 상태 6종(평시·배고픔·놀이·수면·degraded·유료 감사) 스크린샷 첨부.
  2. ja.json 모든 키에 `nativeReview: "pending"`, 하드코딩 일본어 문자열 0건(lint 규칙 또는 테스트).
  3. 유료 연출 컴포넌트가 상태 수치를 읽거나 바꾸는 코드가 없음(정적 검사).

## T15 — fault matrix·72시간 soak harness

- slug `t15-fault-soak` · PR 접두 `test(ops):` · 의존 T11, T12, T13
- **읽을 것**: 스펙 §11 전체(fault matrix 행·crash window·soak 정의), §9.2, §9.4
- **범위**
  - `docs/ops/fault-matrix.md`: 행마다 주입 방법·예상 상태(`retry|degraded|safe_stopped`)·데이터 보존 결과를 **실행 전에** 고정(§11).
  - 주입 hook(테스트/플래그 전용): OAuth access-token 만료, refresh-token 철회, API 403·429·quota 고갈, DNS·RTMPS 단절(obs 신호 mock), DB lock, disk-full, WebGL context loss(렌더러), OBS·host crash(프로세스 kill), inbox commit·token checkpoint·state commit·effect ACK 사이 crash window.
  - `tools/soak`: 가속 시계 모드(CI, 72h 압축)와 실시간 모드(로컬), 종료 리포트(중단·복구 횟수, 상태·이벤트 유실, freeze 카운터, p95). 합격선 숫자는 Gate 0/2 승인값을 config로 받는다(임의값 금지, provisional 라벨).
- **합격 기준**
  1. matrix 모든 행이 자동 테스트로 존재하고 예상 상태와 일치.
  2. 가속 soak가 CI에서 통과하고 리포트 산출.
  3. 실시간 72h 실행은 이 PR의 합격 조건이 아니며 절차만 문서화(사용자 실행).

## T16 — 문서 정합화·운영 런북·Gate 체크리스트

- slug `t16-docs-alignment` · PR 접두 `docs:` · 의존 T12(구조 확정 후)
- **읽을 것**: 스펙 전체(특히 §3, §8, §9, §12, §15, §16, §17), 기존 `README.md`, `docs/ROADMAP.md`, `docs/ACCOUNT_SETUP_FROM_ZERO.md`, `docs/YOUTUBE_MONETIZATION_RUNBOOK.md`
- **범위**
  - `README.md` 재작성(구조·실행·검증·문서 지도), `docs/ROADMAP.md`를 Gate 0–5 기준으로 재작성, 계정 설정·수익화 런북에서 스펙과 상충하는 내용(Pokémon 명칭, 후원→부활, Gifts 지역 서술 등) 제거·정정(근거는 스펙 [S] 출처만).
  - 신규: `docs/ops/gate0-checklist.md`(§15 Gate 0 항목·미정 결정 §17 표), `docs/ops/gate2-experiments.md`(방송 길이 실험 절차, 모바일 calibration 절차, 실계정 검증 항목), `docs/ops/moderation-call-table.md`(템플릿), `docs/ops/runbook-operations.md`(시작·정지·kill switch·복구·알림 대응).
  - 새 사실을 추가하지 않는다. 확인이 필요한 서술은 "확인 필요(출처 없음)"로 표시.
- **합격 기준**
  1. 문서에 Pokémon 직접 사용·유료 부활·게임 파워 판매 서술 0건(grep 증빙).
  2. 모든 외부 주장에 스펙 [S] 번호 또는 URL이 붙는다.

## T17 — Windows 운영 스크립트: 자동시작·OBS 기동·아카이브 순환

- slug `t17-windows-ops` · PR 접두 `feat(ops):` · 의존 T2, T12
- **읽을 것**: 스펙 §9.1(rolling archive·off-host), §10.2, §11(hosting OS·interactive session·archive 정책), [S7]
- **범위**
  - `ops/windows/`: 로그온 시 자동시작(Task Scheduler XML 또는 `schtasks` 스크립트) — 서버, 렌더러 정적 서빙, OBS(프로파일·씬 컬렉션 지정, websocket 활성), 순서와 준비 대기. 실행 계정·interactive session 전제를 문서화(§11).
  - 로컬 rolling archive: OBS 녹화 또는 원격 지침에 따른 파일에 대해 최대 용량·최소 여유공간·보존일 규칙(config, provisional)으로 자동 삭제; off-host availability 기록은 T12 dead-man 참조.
  - `docs/ops/windows-host.md`: 재부팅·자동 로그온·sleep 비활성·GPU reset·remote-session 종료·자동 업데이트 시험 체크리스트(사용자 실행, §11).
- **합격 기준**
  1. 스크립트 dry-run 모드와 단위 테스트(경로·용량 계산·삭제 대상 선정).
  2. 이 PC에서 자동시작 등록·해제 실행 로그 첨부(가능하면), 아니면 "실행하지 않았음".

## T18 — OBS safe-mode sentinel 정책(D-7)·버전 고정(D-6)·public 문구 (완료, 2026-08-18)

- slug `t18-obs-safemode-policy` · PR 접두 `feat(ops):` · 의존 T17, T2 · PR #24 머지. 사용자 결정 D-6/D-7/D-4 반영 — 상세는 `docs/tasks/TASK-T18-obs-safemode-policy.md`, `docs/ops/windows-host.md` §5.7.

## T19 — Gate 0 승인 반영: 체크리스트·설정·모더레이션 호출표

- slug `t19-gate0-apply` · PR 접두 `chore(gate0):` · 의존 T16, T18
- **읽을 것**: `docs/tasks/BOARD.md` §2 **D-8~D-16**(정본), `docs/ops/gate0-checklist.md` 4장(승인 뒤에 할 일), `docs/ops/moderation-call-table.md`, 스펙 §12.3, §15, §17, `apps/server/src/supervisor/config.ts`(`assertModerationCallTableApproved`)
- **범위**
  - `docs/ops/gate0-checklist.md`: 1장 체크박스를 D-8~D-16대로 채우고 각 항목에 승인 날짜(2026-08-19)와 D-번호를 적는다. 미결 항목(§1.4는 T21 초안 대기, §1.2 audit은 채널 생성 후 값 기입, §1.7 합격선은 Gate 2 후 잠금)은 **체크하지 않고** 상태를 적는다. 3장 §17 표 '현재 취급' 열 갱신.
  - `docs/ops/moderation-call-table.md` 1장 승인표와 2장 사유 토큰 표를 D-13 값으로 채운다(휴대폰 번호·webhook URL 등 값은 적지 않는다). "V1에서는 문자/전화 자동 발송이 없어 Discord 모바일 알림이 사실상 유일한 자동 경로"를 명시. 승인 날짜·D-13 기록.
  - `config/default.json`: `supervisor.moderation` = D-13 승인표(`approved: true`, `onCallOwner`, `maxResponseMinutes: 60`, `escalationChannel`, `autoBlockScope`, `safeStopConditions` 4개 토큰) — `assertModerationCallTableApproved()`가 통과해야 하며 토큰 문자열은 `supervisor.reportModerationHealth()` 호출부(T12)와 정확히 같아야 한다(불일치면 코드 쪽 토큰을 바꾸지 말고 ask). `input.window.*` 4개를 D-11 승인값으로 확정하고 `input.provisional`에서 제거(`maxRawLength`는 남긴다).
  - `docs/ROADMAP.md`: Gate 0 상태를 "부분 승인(D-8~D-16, 잔여: §1.2 audit 값·§1.4 초안 승인·§1.7 Gate 2 잠금)"으로 갱신. `docs/ops/runbook-operations.md`·`supervisor.md`에 호출표 참조가 있으면 승인 상태로 갱신.
  - 새 사실을 만들지 않는다. BOARD는 코디네이터 소유라 건드리지 않는다.
- **합격 기준**
  1. `assertModerationCallTableApproved()` 통과 + 거부 경로 테스트(빈 칸 하나라도 있으면 이름을 대고 throw) 유지.
  2. `input.provisional`에 `window.*`가 없고 값이 D-11과 일치함을 테스트 또는 설정 검증으로 확인.
  3. 게이트 5개 + CI 녹색; 문서의 모든 값이 BOARD D-번호를 인용.

## T20a — identity (B) 계약: 동의자 한정 `actor`·동의/철회 명령 `[contract]`

- slug `t20a-identity-contract` · PR 접두 `feat(contract):` · 의존 T1b, T6 · **[contract]**
- **읽을 것**: BOARD **D-9**, A-1(부분 뒤집힘), A-9; 스펙 §7.1(allowlist), §7.4(actor), §12.4, §14.1, [S41] https://developers.google.com/youtube/terms/developer-policies-guide , [S42]; `packages/contract/src/event.ts`(`actor: z.null()`), `commands.ts`, `privacy.test.ts`, `docs/ops/data-map.md`
- **범위**
  - `actor`: `null | { kind: 'consented', displayName: string, channelRef: string }` — `channelRef`는 **원 channelId가 아니라 서버가 consent 레코드에 매긴 불투명 id**(렌더러·fixture·로그에 channelId가 나가지 않도록). 미동의자는 계속 `null`. 스키마 주석에 D-9 인용.
  - 명령 별칭 데이터에 동의/철회 명령 추가(예: `join`/`leave` 계열; ja·icons·en 별칭은 기존 규칙대로, 실제 문자열은 T14 CTA와 충돌하지 않게). 명령 의미: `join` = 고지문 동의 + 표시명 저장 시작, `leave` = 즉시 삭제. 두 명령은 세계 상태에 영향이 없다(§7.1 allowlist이지만 `effect`를 내지 않음 — 확인 effect는 익명 "참여 등록됨"류 1종만 허용, 이름 포함 금지).
  - snapshot: 표시명은 snapshot에 넣지 않는다(read model 복구는 익명으로 충분). effect의 `actor`만 표시명을 싣는다(D-9 "화면 표시").
  - JSON Schema·fixture 재생성(스크립트), fixture의 표시명은 명백한 합성값(`synthetic-viewer-1` 등). `privacy.test.ts`를 "동의자 한정" 규칙으로 개정: `actor`가 non-null이면 `kind==='consented'`이고 channelId 형식(`UC…`)이 어디에도 없음을 검사.
- **합격 기준**
  1. 계약 테스트·스키마 생성물 최신·fixture round-trip 통과; `UC`로 시작하는 24자 channelId 패턴이 contract 전체(스키마·fixture·테스트)에 0건.
  2. 미동의 경로(`actor=null`)의 기존 fixture·테스트가 변경 없이 통과(하위 호환).

## T20b — identity (B) 서버: 동의 저장·authorDetails 처리·삭제·보존·compliance 문서

- slug `t20b-identity-server` · PR 접두 `feat(privacy):` · 의존 T20a, T9, T13, T8
- **읽을 것**: BOARD D-9, D-13; 스펙 §7.2, §7.4, §12.3, §12.4(삭제 7일·보존 field별), [S41][S42]; `apps/server/src/youtube/chat/{config,grpc-source,rest-source}.ts`(`IDENTITY_PART`), `apps/server/src/privacy/*`, `apps/server/src/input/parse.ts`(`identityGateOpen`), `config/retention.json`, `docs/ops/data-map.md`
- **범위**
  - 설정: `engine.identityGateOpen`을 **동의 모드**로 재정의(`false`=A-1 닫힘, `true`=D-9 동의자 한정). 열림일 때만 chat source가 `authorDetails` part를 요청한다(닫힘이면 현재처럼 `id,snippet`).
  - 수신 경로(열림): 메시지의 `authorDetails.channelId`·`displayName`은 **메모리에서만** 다룬다 — (a) `join` 명령이면 consent 레코드 생성(channelRef=불투명 id, channelId는 **해시가 아닌 원값을 별도 테이블에 저장하되 이 테이블만이 유일한 저장소**(§12.4 삭제 가능성), displayName, consentedAt, lastActiveAt, noticeVersion); (b) 동의자의 메시지면 `actor={consented, displayName, channelRef}`로 정규화하고 lastActiveAt 갱신; (c) 그 외는 authorDetails를 즉시 버리고 `actor=null`. inbox envelope·로그·metrics·health에 미동의자의 channelId·이름이 남지 않음을 테스트로 고정.
  - `leave` 명령: consent 레코드·파생(표시명 캐시) 즉시 삭제, 이후 메시지는 익명. 사용자 삭제 요청 handler(T13)를 channelRef/channelId로 실제 삭제하도록 확장(7일 규칙보다 즉시).
  - 보존: `config/retention.json`에 consent 필드(source·목적·**30일 미refresh(미활동) 삭제**·삭제 경로) 추가, T13 스케줄러가 `lastActiveAt+30d` 경과 레코드를 삭제하고 `retention_ledger`에 기록. (2026-08-19 정정: D-9의 90일은 [S41] Developer Policies III.E.4.c의 Authorized Data 30일 상한에 막혀 30일로 정정됨 — 동의자 메시지마다 channel_id/display_name을 refresh하고, 30 초과 값은 설정 검증으로 금지.)
  - 동의자 한정 기능: 사용자별 cooldown·한 표(A-9)는 channelRef 기준으로 열되 미동의자 경로는 집계창 그대로. 분기 투표는 이 PR 범위 밖(플래그만 유지).
  - `docs/ops/data-map.md` 갱신; 신규 `docs/ops/identity-consent.md`: 고지문 초안(ja 주 표기 + 영어 별칭, `nativeReview: pending`; 수집 항목·목적·보존·삭제 방법·명령), 채널 설명/고정 댓글용 전문, **YouTube API Services compliance 체크리스트**(Developer Policies의 user data·privacy policy·데이터 보존·삭제 항목을 URL·조항 번호와 함께 나열하고 각 항목이 코드 어디에서 충족되는지 표) — 사용자가 audit 제출 전 검토.
  - 금지: 개인 D1/D7/D30·재방문 지표 계산(§14.1 가드 테스트 유지·확장), 이름 표시 외 용도 사용, 미동의 데이터 영속.
- **합격 기준**
  1. 열림 모드 통합 테스트: join→표시명 부착→leave→익명 복귀, 미동의 메시지의 authorDetails가 어떤 저장소·로그에도 없음, 30일 미refresh 자동 삭제(가상 시계), 닫힘 모드는 기존 테스트 전부 무변경 통과.
  2. 스키마 검사 테스트를 "identity 컬럼은 consent 테이블에만 존재"로 개정하고 통과.
  3. 게이트 5개 + CI 녹색; 새 외부 주장은 URL·확인 날짜.

## T20c — identity (B) 렌더러: 동의자 표시명·고지 CTA

- slug `t20c-identity-renderer` · PR 접두 `feat(renderer):` · 의존 T20a, T14
- **읽을 것**: BOARD D-9; 스펙 §5.2(슬롯), §5.3, §8.4·§8.5(유료 연출에 이름 금지·순위표 금지), §12.3; `apps/renderer` 슬롯 구현, `i18n/ja.json`
- **범위**
  - '방금 반영된 행동' 슬롯에 `actor.kind==='consented'`일 때만 표시명을 붙인다(길이 제한·이모지/제어문자 정리·XSS 무해화; raw chat은 여전히 표시하지 않음). `actor=null`이면 현재와 동일.
  - 유료 감사 연출에는 **이름을 붙이지 않는다**(§8.4 유지 — 동의자여도 익명 아이콘). 지출·참여 순위표 없음.
  - CTA 영역에 고지 한 줄(ja 주 표기, `nativeReview: pending`)과 `join`/`leave` 명령 안내; T14의 CTA 비활성 상태에서는 함께 숨김.
  - `?mode=dev` 대표 상태에 '동의자 행동 표시' 1종 추가, 스크린샷 첨부.
- **합격 기준**
  1. 표시명이 닫힘 모드 fixture에서는 절대 렌더되지 않음(테스트), 유료 연출 컴포넌트가 `actor`를 읽지 않음(정적 검사).
  2. ja.json 키 전부 `nativeReview: pending`, 하드코딩 일본어 0건(기존 규칙 유지).

## T21 — 일본 패널·5초 이해 테스트·24h 콘텐츠 목록·일본 시장 증빙 초안(D-15)

- slug `t21-japan-panel-draft` · PR 접두 `docs(gate0):` · 의존 T14, T16
- **읽을 것**: BOARD D-15, D-8; 스펙 §5.2, §5.3, §6.2, §12.5, §14.2(1), §15(Gate 0·Gate 3·Gate 4), §17; `docs/ops/gate0-checklist.md` §1.4, `docs/ops/gate2-experiments.md`; 콘텐츠 디렉터 구현(`apps/server/src/world`, T7)의 실제 사건·챕터 목록
- **범위**
  - 신규 `docs/ops/japan-panel-plan.md`: (1) 패널 모집 조건 **제안**(인원·연령대·기기(모바일 YouTube 앱)·언어·모집 경로 후보) — 숫자는 '제안'으로 표기하고 근거(스펙 문장 또는 일반적 UX 리서치 관행의 출처 URL)를 붙인다, 출처가 없으면 "제안(근거 없음)"으로 정직 표기; (2) 5초 무음 이해 테스트 절차와 **통과 기준 제안**(무엇을 묻고 몇 %를 통과로 볼지, 측정 방법); (3) 24시간 콘텐츠 목록 — T7 디렉터가 실제로 낼 수 있는 사건·챕터 조합을 코드에서 도출해 시간대별 표로, 반복 장면 표본 검토 기준(§12.5) 제안; (4) 일본 시장 증빙 방식 — 정책상 허용되는 YouTube Analytics geography aggregate(공식 문서 URL)와 패널 결과의 결합, Gate 4에서 쓸 발견·시청·참여 합격 기준 **제안**.
  - 패널 실행·모집은 사용자 작업. 코드 변경 없음. `gate0-checklist.md` §1.4는 "초안 제출(T21 PR #n), 승인 대기"로만 갱신.
- **합격 기준**
  1. 모든 숫자에 '제안' 라벨과 근거/무근거 표기; 외부 주장에 URL·확인 날짜.
  2. 콘텐츠 목록의 사건명이 T7 코드의 실제 사건 식별자와 일치(grep 증빙).

## T22 — 모더레이션 사유 보고 경로: 사람 트리거 admin 엔드포인트 + filter_evasion_surge 휴리스틱

- slug `t22-moderation-report` · PR 접두 `feat(supervisor):` · 의존 T12, T19
- **읽을 것**: BOARD **D-13**(토큰 4개: `targeted_harassment`·`pii_exposure`·`sexual_or_self_harm_risk`·`filter_evasion_surge`; 전부 safe-stop), 스펙 §12.3(2단계: CTA off → safe_stopped), §9.2, §10.2(loopback+token), §11; `docs/ops/moderation-call-table.md`(2장 토큰 표·5장), `apps/server/src/supervisor/supervisor.ts:232 reportModerationHealth`, `kill-switch.ts`/`kill-cli.ts`(admin 엔드포인트·CLI 패턴), `apps/server/src/input/metrics.ts`(rejectedByReason·commandLike), `config/default.json` `supervisor.moderation`
- **범위**
  - **사람 트리거 경로**: `POST /admin/moderation`(loopback + bearer `server.adminToken`, kill-switch와 동일 인증/거부 규칙) `{ "reason": "<토큰>", "note"?: string }` → `supervisor.reportModerationHealth('degraded', reason)`; `POST /admin/moderation/clear` → `'ok'`. 승인표에 없는 토큰은 400(토큰 이름만 응답, 본문 echo 금지). CLI `npm run moderation -w @vl/server -- --reason <토큰> [--clear]`(kill-cli 패턴: 서버 미응답 시 실패를 명확히, 플래그 파일 fallback은 두지 않는다 — 모더레이션은 kill이 아니므로 근거를 티켓에). 호출 결과는 alert(warning: CTA off / critical: safe_stopped)와 `/health` detail에 토큰·시각만(자유 텍스트 note는 로그에만, raw chat 금지).
  - **자동 휴리스틱(filter_evasion_surge 전용)**: 입력 metrics의 집계창 단위로 `commandLike` 대비 거부(`rejectedByReason` 중 allowlist 불일치·길이 초과·반복 차단 등 '우회 시도'로 분류되는 사유)의 비율과 절대 건수가 **provisional 임계**(config `supervisor.moderation.heuristics.filterEvasion: { windowMs, minCommandLike, rejectRatio }`, `provisional` 목록에 추가 — 임의 합격선 금지 원칙대로 문서에 '잠정'으로)를 연속 N창 넘으면 `reportModerationHealth('degraded','filter_evasion_surge')`, 연속 M창 아래면 clear. 어떤 거부 사유를 '우회'로 분류하는지는 T6 파서의 실제 사유 목록을 보고 티켓에 근거와 함께 고정하고, 확신이 없으면 `ask`. 나머지 3개 토큰은 **자동 탐지하지 않는다**(사람 판단 대상, §12.3) — 문서에 명시.
  - `docs/ops/moderation-call-table.md` 2장 토큰 표에 '보고 경로(사람/자동)' 열 채움, 5장 'T22에서 구현' 문구 갱신; `docs/ops/runbook-operations.md`에 운영 절차(알림 수신 → 판단 → CLI 1줄 → 해제); `docs/ops/supervisor.md` 4.3 갱신.
  - 가짜 참여·raw chat 표시 금지 유지; 결제 무영향.
- **합격 기준**
  1. 엔드포인트/CLI 테스트: 인증 실패·잘못된 토큰·정상 보고·clear; 보고 시 CTA off + 승인표 토큰이면 `safe_stopped`(T12 전이 테스트 재사용) + alert 1회.
  2. 휴리스틱 테스트: 합성 입력으로 창별 비율 계산·연속 N창 진입·M창 해제, 임계 미만에서 오탐 없음; 닫힘/열림 identity 모드 무관.
  3. 게이트 5개 + CI 녹색; 문서의 모든 임계가 provisional로 표기.

## T8e — 엔진 후속: 가상 시계 31일 점프 후 `pump()` 미반환 · `ingest.test.ts` SQLite write lock flaky

- slug `t8e-clock-jump-flaky` · PR 접두 `fix(engine):` · 의존 T8, T8d
- **읽을 것**: `apps/server/src/engine/engine.ts`(`pump`, `#runPending`, deadline/expiry 루프), `apps/server/src/engine/ingest.test.ts:442` 근처, T20b 리뷰 관측(BOARD 이력 2026-08-20: 31일 가상 시계 점프 후 `StateEngine.pump()`가 184초 timeout까지 반환하지 않음), T21 관측(`ingest.test.ts:442` SQLite write lock 1/3 실패)
- **범위**
  - 디버깅 절차(CLAUDE.md): 가설 → 반증 관측 → 수정. (1) 31일 점프: 재현 테스트(가상 시계로 31일 전진 후 `pump()` 1회 호출이 유한 시간에 반환) 작성 → 원인 규명(예: 만료/deadline 재스케줄 루프가 점프 크기에 비례해 틱을 하나씩 소모, 또는 while 조건) → 최소 수정(틱 상한·점프 시 일괄 처리)과 근거. (2) flaky: `ingest.test.ts:442`가 다른 테스트/워커와 같은 DB 파일·WAL을 공유하는지, busy_timeout 부재인지 관측 → 원인별 최소 수정(격리된 temp DB 또는 busy_timeout 설정). 증상만 가리는 재시도 추가 금지.
- **합격 기준**
  1. 두 재현 테스트가 수정 전 실패·수정 후 통과(되돌려 확인), `vitest --repeat` 또는 10회 반복으로 flaky 0.
  2. 게이트 5개 + CI 녹색, 기존 T8/T15 테스트 무변경 통과.
