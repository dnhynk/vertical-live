# TASK-T20b-identity-server

- Task: T20b identity (B) 서버: 동의 저장·authorDetails 처리·삭제·보존·compliance 문서 (`docs/tasks/TASK_SPECS.md` §T20b)
- Branch: `dnhynk/t20b-identity-server` · PR: #28
- Orca: task `task_d221f62c9dae` · dispatch `ctx_db0ddb93029b`
- Spec sections read: §7.2, §7.3, §7.4, §12.3, §12.4, §14.1
- BOARD decisions/assumptions relied on: D-9, D-11, D-13, A-1(부분 뒤집힘), A-9, A-15, A-20

## Goal

D-9가 고른 Gate 0 §1.3 (B) — "고지문에 opt-in한 시청자만 표시명 저장·표시" — 를 서버에서 구현한다.
`engine.identityGateOpen`을 **동의 모드** 스위치로 재정의하고(닫힘=A-1 그대로, 열림=D-9 동의자 한정),
열림일 때만 chat source가 `authorDetails` part를 요청한다. `authorDetails.channelId`·`displayName`은
프로세스 메모리에서만 다루며, 유일한 영속 저장소는 새 `viewer_consent` 테이블이다. `JOIN`은 동의
레코드를 만들고 `LEAVE`는 즉시 지운다. 미동의자의 authorDetails는 즉시 폐기되고 어떤 저장소·로그·
metrics·health·에러 문자열에도 남지 않는다. 보존은 `config/retention.json`이 정본이며 T13 스케줄러가
비활성 레코드를 지우고 `retention_ledger`에 기록한다. 문서로는 고지문 초안과 YouTube API Services
compliance 체크리스트를 남겨 사용자가 audit 제출 전에 검토할 수 있게 한다.

## Plan

1. **계약 확인(변경 없음)**: T20a(PR #26, `c56f9d4`)가 `Actor`, `CHANNEL_REF_PATTERN`,
   `ConsentCommandName`, `CONSENT_COMMAND_ALIASES`, `IngestEnvelope.consentCommand`,
   `ACTION_REACTION.actor`를 이미 main에 넣었다. 이 task는 `[contract]`가 아니므로
   `packages/contract`를 건드리지 않는다(필요해지면 멈추고 ask).
2. **마이그레이션 006 `viewer_consent`**(현재 최신은 005 — `apps/server/src/db/migrations` 확인):
   `channel_ref`(PK, `ref_` + hex32) · `channel_id`(UNIQUE, 원값 — 이 컬럼이 유일 저장소) ·
   `display_name` · `consented_at` · `last_active_at` · `notice_version`. 스키마 주석에 D-9와
   §12.4 삭제 가능성 근거를 적는다.
3. **schema-identity 감사 개정**: `findIdentityColumns`/`findIdentitySchemaText`에
   "identity 컬럼은 consent 테이블에만" 규칙을 넣는다(허용 테이블 1개를 상수로 고정하고, 그 밖의
   테이블에서 한 건이라도 나오면 실패). 양성 대조 테스트 유지.
4. **파서(T6) 확장**: `aliases.ts`의 조회 표를 `ALLOWLISTED_COMMAND_ALIASES`까지 넓히고
   `parseMessage`가 세계 명령(`CommandRef`)과 동의 명령(`ConsentCommandRef`)을 **다른 필드로**
   돌려준다. 게이트가 닫혀 있으면 동의 명령은 `consent_disabled`로 거부한다(닫힘 모드 동작 불변).
   `createCommandParserPort`는 `AnyCommandRef | null`을 그대로 반환 → contract adapter가
   `consentCommand`에 넣는다. 세계 명령 집계·effect 경로에는 절대 섞이지 않는다.
5. **identity 모듈 신설** `apps/server/src/identity/`:
   - `author-details.ts` — shape별 reader(gRPC `author_details.channel_id`/`display_name` snake_case,
     REST `authorDetails.channelId`/`displayName` camelCase). 두 어휘를 섞지 않는다(§7.2).
   - `consent-store.ts` — `viewer_consent` CRUD(`PersistenceStore` 위임): 발급·조회·`last_active_at`
     갱신·`channelRef`/`channelId`로 삭제.
   - `directory.ts` — `ConsentDirectory`: 한 메시지에 대해 (a) `JOIN`→레코드 생성, (b) `LEAVE`→즉시
     삭제, (c) 동의자→`last_active_at` 갱신 + **메모리 전용** `messageId → ConsentedActor` 버퍼에 적재,
     (d) 그 외→즉시 폐기. 버퍼는 상한이 있는 FIFO이며 소비 즉시 제거된다.
   - `channelRef` 발급은 `crypto.randomBytes(16)` hex — channelId에서 파생하지 않는다(안정 hash 금지, §12.4).
6. **수신 경로 연결**: `ChatIngestSink.commit`이 원 item과 envelope를 `ConsentDirectory`에 넘긴다
   (게이트가 닫혀 있으면 directory 자체가 없다). envelope에는 identity가 들어가지 않는다.
7. **엔진**: `toCanonicalEvent`가 메모리 버퍼에서 `actor`를 붙이고, `assembleEffect`가
   `ACTION_REACTION`(direct, `contributionCount === 1`)에만 `actor`를 싣는다. `effect_outbox`에는
   actor 컬럼이 없으므로 재기동 후 재발행은 익명이다 — 의도된 성질(영속 금지)이며 테스트로 고정한다.
8. **동의자 한정 입력 규칙(A-9)**: `InputArbiter.admit`이 `channelRef` 기준 cooldown과 창당 한 표를
   적용한다(미동의자는 기존 집계창 그대로). 값은 `input.perUser.*`에 `provisional: true`.
   분기 투표 자체는 범위 밖 — `identityGateOpen`이 지금처럼 vote/director 분기를 계속 몬다(A-20).
9. **삭제·보존**: `LEAVE` 즉시 삭제 + T13 `UserDeletionRequestHandler`를 `channelRef`/`channelId`로
   실제 삭제하도록 확장(7일 규칙보다 즉시). `config/retention.json`에 `viewer_consent` field 추가,
   T13 스케줄러의 기존 `deleteExpiredByColumn`이 `last_active_at` 기준으로 지우고 ledger에 남긴다.
10. **문서**: `docs/ops/data-map.md` 재생성(`npm run data-map:generate -w @vl/server`),
    신규 `docs/ops/identity-consent.md`(고지문 초안 ja+en `nativeReview: pending`, 채널 설명/고정 댓글
    전문, compliance 체크리스트 표). §14.1 가드(`derived-metrics`)는 동의자 재방문 지표 토큰까지 넓힌다.
11. **테스트**: 열림 모드 통합(join→표시명→leave→익명), 미동의 authorDetails 누출 0건(저장소·로그·
    metrics·health·에러), 90일/30일 미활동 자동 삭제(가상 시계), 닫힘 모드 기존 테스트 무변경.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| YouTube API Services — Developer Policies, Authorized Data 저장 기간 | https://developers.google.com/youtube/terms/developer-policies | 2026-08-19 | III.E.4.c: III.E.4.b(Analytics/Reporting/statistics)에 해당하지 않는 Authorized Data는 "active user가 부여한 특정 동의의 목적에 필요한 기간 동안, 그리고 30 캘린더 일을 넘지 않게" 저장할 수 있다. 표시명·channelId는 그 예외에 없으므로 **30일 규칙 대상**이다 |
| 같은 문서 — III.E.4.b 예외 | https://developers.google.com/youtube/terms/developer-policies | 2026-08-19 | 예외 데이터도 "30일마다 사용자가 여전히 그 데이터 접근을 승인했는지 확인"해야 한다 |
| 같은 문서 — 사용자/계정 삭제 요청 | https://developers.google.com/youtube/terms/developer-policies | 2026-08-19 | III.E.4.g: 요청 후 "가능한 빨리, 7 캘린더 일 이내" 삭제 |
| 같은 문서 — privacy policy·동의 | https://developers.google.com/youtube/terms/developer-policies | 2026-08-19 | III.A.2 privacy policy 상시 게시·수집 항목 설명, III.D.2.a 적용 법률에 따른 사용자 동의 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| D-9의 "90일 미활동 삭제"가 [S41] III.E.4.c의 30일 상한과 충돌한다. (A) 30일로 좁힌다 / (B) 90일 유지 / (C) 컬럼별 분리 — 권장 (A) | **(A) 채택.** 30일 상한은 외부 정책이라 사용자 결정으로 넘을 수 없다. 코디네이터가 BOARD D-9를 '30일 미refresh 삭제'로 정정하고 사용자에게 보고(main `c6bbf0d`, BOARD D-9 행). 구현: 메시지마다 refresh, `last_active_at+30d` 삭제, config 한 줄, **30 초과 값은 검증으로 차단**, 고지문에도 '30일' 기재 | `config/retention.json` `viewer_consent.identity.allowedPeriodDays: 30`, `POLICY_MAX_CONSENT_IDENTITY_DAYS` 로더 검증, `docs/ops/identity-consent.md` §1·§3.4, 가상 시계 테스트 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `input.perUser.cooldownMs` | 5000 | `provisional` (`input.provisional`에 등재) | 스펙 §6.4는 동의자 cooldown 값을 정하지 않는다. 집계창 길이(`window.windowMs=5000`, D-11 승인)와 같게 두어 "동의자는 창당 최대 1회 개별 반영"이 되게 했다. Gate 2 실트래픽 후 재조정 |
| `CONSENT_NOTICE_VERSION` | `2026-08-20` (round 2에서 `2026-08-19`에서 올림) | 고정 상수 | 고지문 문서의 최종 수정일. 문서와 상수가 어긋나면 테스트가 실패한다. round 2 M1이 저장 항목 고지를 고쳤고 round 1과 달리 같은 날이 아니므로 날짜를 올렸다 — 게시 전·동의 레코드 0건이라 재동의 대상은 없다 |
| 분기 투표 플래그 | 기존 `engine.identityGateOpen` 유지 | 가정 | TASK_SPECS §T20b "분기 투표는 이 PR 범위 밖(플래그만 유지)"과 `docs/ops/gate0-checklist.md` §1.5("vote 경로는 켤 수 없다 — 사용자별 한 표·cooldown은 identity gate 개방을 전제")를 최소 diff로 읽었다. 새 플래그를 만들지 않았고 vote/director 분기 코드는 건드리지 않았다. A-20의 실험 **순서**는 운영 결정이지 코드 분기가 아니다 |
| in-memory 귀속 버퍼 상한 | 1024 | 내부 메모리 한도(정책 아님) | drain 배치(200)·창당 직접 반영 상한(20)보다 훨씬 크다. 넘치면 오래된 항목이 익명이 될 뿐 잘못된 이름이 붙지 않는다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1a | 열림 모드 통합: join→표시명 부착→leave→익명 복귀 | met (round 2에서 즉시 삭제 보장 3건 보강) | `apps/server/src/identity/consent-mode.test.ts` "joins, attaches the name, leaves, and is anonymous again" — 원 gRPC item → sink → 파서 → inbox → 단일 writer → 발행된 `ACTION_REACTION.actor`까지 실제로 통과 |
| 1b | 미동의 메시지의 authorDetails가 어떤 저장소·로그에도 없음 | met | 같은 파일 "leaves no trace of a viewer who never consented" — 모든 테이블 전체 덤프 + snapshot/effect/metrics/health JSON + 로그를 검사. 원문(`ごはん`)도 없음. 프로브 자체는 `msg_test_lurk` 존재로 검증. 동의자 경우도 "keeps a consented viewer out of every store except the consent row"에서 디스크 상 이름 등장 횟수 == 1 |
| 1c | 90일→**30일** 미활동 자동 삭제(가상 시계) | met | 같은 파일 "deletes a consent record after 30 days without a message" — 29일 sweep 후 잔존, 31일 sweep 후 삭제 + `retention_ledger(outcome=deleted, allowedPeriodDays=30)`. 30일 근거는 [S41] III.E.4.c(위 ask 표) |
| 1d | 닫힘 모드 기존 테스트 전부 무변경 통과 | met (round 2) | round 1에서 `input/metrics.test.ts`의 기대값을 새 필드에 맞게 고친 것이 이 기준 위반이었다(리뷰 M1). round 2에서 그 파일을 `origin/main` 그대로 원복하고 스냅샷 shape 자체를 gate에 종속시켰다(`new CommandMetrics({ consentGateOpen })`) — 닫힘이면 T20b 이전 문서 그대로다. gate-on 기대값은 새 파일 `input/metrics-consent.test.ts`로 분리했다. `/health`도 같은 규칙이다: consent 신호는 gate가 열렸을 때만 추가되고 닫힘이면 §9.4(3) 4개 신호 그대로다(`health.test.ts` "is absent entirely while the gate is closed"). 남은 "바뀐 기존 테스트"는 (i) chat config의 authorDetails 거부 메시지, (ii) `input.provisional`/`perUser` 추가, (iii) 스키마 감사 규칙 개정(합격 기준 2), (iv) round 2에서 `inbox.ingest`에 3번째 인자(hooks)를 넘기게 된 테스트 헬퍼 3곳뿐이다 |
| 2 | 스키마 검사 테스트를 "identity 컬럼은 consent 테이블에만"으로 개정 | met | `apps/server/src/privacy/schema-identity.test.ts` — `viewer_consent` 밖 identity 컬럼/표현식 0건, 그 테이블 **안**에는 정확히 6개 컬럼이 있음을 함께 검사(양성 대조 유지). 로더도 `personalIdentifiers: "consented_identity"`를 그 field 하나에만 허용 |
| 3 | 게이트 5개 + CI 녹색 | met(로컬 5개) / CI는 PR에서 확인 | 아래 Gates 블록 |
| 3 | 새 외부 주장은 URL·확인 날짜 | met | 위 "Sources consulted" 표 + `docs/ops/identity-consent.md` §4(조항별 원문 인용·URL·확인 날짜) + `privacy/config.ts` `POLICY_MAX_CONSENT_IDENTITY_DAYS` 주석 |

### Gates (executed)

```text
$ git fetch origin && git rebase origin/main      # 2adddb4 (T19 #25 머지본) 위로 rebase, 충돌 2건 해결
$ npm run format:check   → All matched files use Prettier code style!
$ npm run lint           → eslint 0 errors; check-no-legacy-imports: ok (0); check-install-scripts: ok (4)
$ npm run typecheck      → tsc --build, 오류 없음
$ npm run test           → Test Files 141 passed (141) / Tests 2009 passed | 1 skipped (2010)
$ npm run build          → 전 워크스페이스 성공, "copied 6 migration(s)", "docs/ops/data-map.md up to date"
```

실행하지 않았음: 실제 YouTube 계정·실제 gRPC 엔드포인트 검증. `youtube.chat.enabled=false`가 기본이고
worker는 실계정을 쓰지 않는다(runbook 3.3). 열림 모드의 실계정 확인은 `docs/ops/gate2-experiments.md` 소관이다.

## Not done / out of scope

- 분기 투표(A/B/C) 실험 자체 — A-20에 따라 Gate 2. 이 PR은 플래그와 vote/director 분기 코드를 그대로 둔다.
  동의자 한정 규칙 중 **cooldown과 창당 한 표는 구현**했고(`InputArbiter`, `channelRef` 기준),
  투표 창 자체가 열리는 조건은 기존 그대로다.
- 렌더러 표시·CTA(T20c).
- 채널 프라이버시 정책 본문 — 사용자/법률 검토 사항. `docs/ops/identity-consent.md`가 요구 항목만 정리한다.
- 실계정에서의 `authorDetails` 수신 확인 — Gate 2.

## Follow-ups

- `docs/ops/identity-consent.md` §4의 조항 번호는 2026-08-19 기준이다. Google이 이 페이지를 개정하므로
  **audit 제출 직전에 번호와 문구를 재확인**해야 한다(문서에 그렇게 적어 두었다).
- 채널 프라이버시 정책 URL이 정해지면 §2.2 전문의 placeholder를 채운다.
- `input.perUser.cooldownMs`는 Gate 2 실트래픽 후 재조정 대상(provisional).
- consent 카운터는 round 2에서 노출했다: `/health`의 `youtube.chat.consent` 신호(gate-on 전용 —
  joined·left·failures·lastFailure·withdrawalRetrying)와 `/metrics`의 `consent_observe_failed_*` 카운터
  (실패가 한 번이라도 났을 때만 키가 생기므로 닫힘 모드 출력은 그대로다). 남은 T12 소관은 이 신호를
  supervisor 판정·알림에 어떻게 쓸지다.
- `refresh` field의 자동 재확인(`RetentionSweeper`의 `reverify` 콜백)은 production에서 주입되지 않는다.
  30일이 지나면 `reverification_due` 보고까지만 한다 — `docs/ops/identity-consent.md` §4 행 4·§5에 그대로
  적었고, 알림화는 T12 소관이다.
- 30일 sweep이 지운 `channel_ref`는 round 2(B2)에서 purge 경로가 생겼다. sweeper는 여전히 SQL 일괄
  삭제라 ref를 모르지만, 매 sweep 끝에 `ConsentDirectory.forgetDeleted()`가 **버퍼 쪽에서** 같은 경계에
  닿는다 — 버퍼에 남은 ref 중 행이 사라진 것을 골라 표시명을 버리고 그 ref를 `drainForgotten` 큐에
  넣는다. round 1에 적었던 "필요하지 않다"는 근거(arbiter viewer 항목은 cooldown 5초 뒤 prune, 투표한
  viewer는 choice window 교체 시 `forgetVoteScope`)는 arbiter에 대해서는 그대로 유효하지만, **버퍼에
  대해서는 틀렸다** — 그것이 B2의 후반부다.
- consent 경로의 지속 실패가 source를 영구 정지시키는지: 정지시키지 **않는다**(무한 재시도이며 영구
  정지 상태는 없다). 실패한 LEAVE는 batch·checkpoint를 롤백하고 같은 토큰으로 재시도하며, 재시도 간격은
  transport의 기존 backoff(`chat.reconnect` — initial/max/factor/jitter)와 `retryBudgetExhausted`가
  관장한다. consent 실패 자체에는 별도 backoff도 별도 차단기도 없다. 이 선택의 대가(계속 실패하면 그
  소스는 checkpoint를 진행시키지 못한다)는 §12.4를 위한 의도된 fail-closed이고, `/health`의
  `youtube.chat.consent`·`consecutiveFailures`·`retryBudgetExhausted`와 `/metrics`의
  `consent_observe_failed_*`로 보인다. **전용 backoff·차단기를 둘지는 T12 판단으로 남긴다** — 그 판정은
  supervisor 소관이고, 이 PR은 신호만 낸다.
- `youtube.chat.consent` 신호·`consent_observe_failed_*` 카운터를 supervisor가 어떻게 소비할지(경보·상태
  전이 임계)는 **T12 소관으로 남아 있다.** 이 PR은 신호를 내보내기만 한다(위 항목과 같은 T12 티켓).
- `RetentionSweeper`의 `reverify` 자동 재확인은 여전히 미구현이다(위 항목 참조). round 2에서 sweeper에
  추가된 것은 `identity` 포트뿐이며 reverify와는 무관하다.
- `StateEngine.pump()`를 31일치 가상 시간 점프 직후에 부르면 비트 단위로 따라잡느라 돌아오지 않는다.
  이 PR과 무관한 엔진 자체의 성질이며(변경 전 코드로 만든 최소 재현 테스트에서도 같았다), 그래서 B2
  회귀 테스트는 sweep 이후의 재시도를 writer pass 없이 `sink.commit`으로만 검증한다. 실서버는 시계가
  그렇게 뛰지 않지만, 호스트가 31일 절전됐다 깨어나는 경우는 T12/T15에서 따로 볼 값어치가 있다.

## Review round 1

리뷰어 판정: `request_changes` (blocker 3 + major 4). 일곱 건 모두 타당해 반박 없이 고쳤다.
고침 커밋은 아래 표의 SHA이며, round 2 게이트 결과는 그 아래에 있다.

| finding | 처리 | 근거·테스트 |
|---|---|---|
| **B1** `youtube/chat/sink.ts:168` — consent 부작용이 inbox event-key dedupe보다 먼저 실행돼, LEAVE 뒤 같은 messageId의 JOIN replay가 동의를 새 channelRef로 부활시킴 | consent mutation을 inbox와 **같은 트랜잭션·같은 멱등 경계**로 옮겼다. `commitIngestBatch(inputs, checkpoint, hooks)`에 `onInserted` 훅을 추가해 **실제로 insert된 envelope에만** 호출하고(중복 event key는 호출 자체가 없다), sink는 raw item을 envelope와 짝지어 그 훅에서 directory에 넘긴다 | `sink.test.ts` "shows the directory only the items it actually inserted"(관측 1회, replay는 0회), `consent-mode.test.ts` "does not revive a deleted identity when a page is replayed"(JOIN→LEAVE→같은 messageId replay → `viewer_consent` 0행, DB 덤프에 이름 없음) |
| **B2** `privacy/deletion-request.ts:117` — 요청 handler가 store만 지워 directory의 pending 표시명이 남고, 삭제 직후 `takeActor`가 이름을 반환 | 삭제 경계를 하나로 합쳤다. `ConsentDirectory.deleteWithAudit(selector, audit)`이 행 삭제 + pending 제거 + arbiter purge 큐 적재를 소유하고, handler는 `directory` 옵션을 받으면 그 경계로만 지운다(감사 문구는 그대로 handler가 쓴다). 운영 절차(`identity-consent.md` §3.3)에 "서버 프로세스 안에서 호출하면 directory를 넘긴다"를 명시 | `consent-mode.test.ts` "answers a deletion request through the same boundary the chat path uses" — 삭제 전 `pendingCount=1`, 삭제 후 `takeActor` null·`pendingCount=0`·발행 effect에 이름 없음. `directory`를 빼고 돌리면 리뷰어가 본 그대로(표시명 반환) 실패하는 것을 확인했다 |
| **B3** `youtube/chat/sink.ts:163` — consent 실패를 세기만 하고 envelope·checkpoint를 commit → 실패한 LEAVE가 영구 skip; state·health·log에 신호 없음 | 원칙을 **철회·삭제 fail-closed**로 바꿨다. LEAVE의 consent mutation이 던지면 `ConsentObserveError`로 batch 전체(행+checkpoint)를 롤백해 같은 토큰으로 재시도한다. JOIN·일반 메시지 실패는 세고 진행한다(저장된 것이 없어 안전한 쪽이며 정책을 여기 명시한다). 신호는 `ChatSourceState.recordConsentFailure`/`recordCommit(consentJoined,consentLeft)` → `/health`의 `youtube.chat.consent`(미해결 withdrawal이면 `degraded: consent_withdrawal_retrying`) + `/metrics`의 `consent_observe_failed_*` + `warn` 로그. sink 주석의 "reaches /health and /metrics" 과장은 실제 경로 설명으로 교체 | `sink.test.ts` "refuses to commit a batch whose withdrawal could not be applied"(throw·행 0·checkpoint 미생성 → 재시도에서 삭제·checkpoint 진행), `consent-mode.test.ts` "rolls the batch back when a withdrawal cannot be applied, and deletes on the retry"(실제 DB·directory), `health.test.ts` consent signal 4건 |
| **M1** `input/metrics.ts:16·:92` — gate 닫힘에서도 `consentAccepted`·`suppressed`·`rejectedByReason.consent_disabled`가 붙어 `/metrics`가 달라지고 기존 테스트를 수정함 | snapshot shape를 gate에 종속시켰다(`CommandMetricsOptions.consentGateOpen`, 기본 닫힘). 닫힘이면 세 필드가 **없고** 키 순서까지 T20b 이전과 같다(거부 자체는 `rejected` 합계에 남는다). `input/metrics.test.ts`는 `origin/main` 그대로 원복 | 원복된 `metrics.test.ts` 통과 + 새 `input/metrics-consent.test.ts`(닫힘: 세 토큰이 JSON에 없음·비율 공식 동일 / 열림: 세 필드 존재) |
| **M2** `identity-consent.md:48·:67`, `retention.json:247` — 고지문이 "이름 표시에만 쓴다"고 하지만 channelRef를 cooldown·창당 한 표에 씀 | ja/en 전문의 "つかいみち / Used for"를 두 용도로 고쳐 적었다(둘째 용도는 이름이 아니라 무작위 내부 참조를 쓴다는 사실 포함). §1 요약표와 `config/retention.json`의 `viewer_consent.identity.purpose`도 같게 고치고 `data-map.md`를 재생성했다. noticeVersion은 `2026-08-19` 유지 — 같은 날 정정이고 게시 전·동의 레코드 0건이라는 근거를 문서에 적었다 | [S41] III.A.2(e)-(f) 수집·사용 목적 고지. `npm run data-map:generate -w @vl/server` 후 `build`의 `--check` 통과 |
| **M3** `identity-consent.md:156·:158` — III.E.4.b 재확인을 "충족"으로 표시, III.E.4.d를 `authorized_api_data` 항목에 매핑 | 행 4: **대상 없음**(III.E.4.b 예외로 보관하는 Authorized Data가 없다)으로 정정하고, `world_snapshot`·`metrics_daily`의 `refresh`는 내부 규칙이며 production sweeper에 `reverify`가 없어 `reverification_due` 보고까지만 한다고 명시(부분·후속). 행 6: `dataClass: non_authorized` field가 0건이므로 **대상 없음**, 열거했던 field는 행 5(III.E.4.c) 소관임을 명시. §5 "범위 밖"에 후속 항목 추가 | `apps/server/src/main.ts`의 `RetentionSweeper` 생성(콜백 미주입), `config/retention.json`의 `dataClass` 값 |
| **M4** `input/arbiter.ts:318·:332` — 투표한 viewer가 prune되지 않고 `forgetVoteScope`의 production 호출이 0건 | production 호출자를 만들었다: `StateEngine`이 매 writer pass마다 (1) 열린 choice의 scope가 바뀌면 이전 scope를 `forgetVoteScope`로 해제하고, (2) `ActorResolver.drainForgotten()`으로 삭제된 channelRef를 받아 새 `InputArbiter.forgetViewer`로 지운다. directory는 LEAVE·요청 삭제 시 그 큐에 ref를 넣는다 | `arbiter.test.ts` "keeps a voter out of the prune until their scope is retired" / "purges a viewer whose identity was deleted", `identity.test.ts` "reports every deleted reference once, whichever path deleted it", `consent-mode.test.ts` "drains the deleted references on every writer pass" |

### Round 2 gates (executed)

```text
$ npm run format:check   → All matched files use Prettier code style!
$ npm run lint           → eslint 0 errors; check-no-legacy-imports: ok (0); check-install-scripts: ok (4)
$ npm run typecheck      → tsc --build, 오류 없음
$ npm run test           → Test Files 142 passed (142) / Tests 2028 passed | 1 skipped (2029)
$ npm run build          → 전 워크스페이스 성공, "copied 6 migration(s)", "docs/ops/data-map.md up to date"
```

첫 `npm run test`에서 `db/crash.test.ts` 3건이 Windows 임시 디렉터리 `EPERM`으로 실패했다. 같은 파일 단독
재실행(5 passed)과 전체 재실행(2028 passed)에서 재현되지 않았다 — 자식 프로세스를 죽이는 테스트의 Windows
파일 잠금 flake이며 이 변경과 무관하다.

### Round 2 설계 노트 (반박이 아니라 선택의 근거)

- **fail-closed의 대가**: consent 저장소가 계속 실패하면 그 소스는 checkpoint를 진행시키지 못하고 멈춘다.
  의도한 선택이다 — 대안은 "삭제해 달라고 한 사람을 삭제하지 않는 것"이다(§12.4). 멈춘 사실은 보이게 했다:
  기존 transport 신호(`consecutiveFailures`·`retryBudgetExhausted`)와 새 consent 신호·metrics 카운터.
- **JOIN 실패는 fail-open**: 저장된 것이 없으므로 개인정보 관점에서 안전한 쪽이고 시청자가 다시 보내면 된다.
  실패는 같은 경로로 세고 로그·health·metrics에 남긴다.
- **트랜잭션 중첩**: `deleteConsent`/`upsertConsent`는 better-sqlite3의 중첩 트랜잭션(SAVEPOINT)으로
  `commitIngestBatch` 안에서 실행된다. 실제 DB를 쓰는 통합 테스트가 JOIN·LEAVE·롤백 세 경로를 모두 통과한다.
- **메모리 버퍼의 롤백**: 훅이 던져 트랜잭션이 롤백돼도 directory가 이미 지운 pending 표시명은 돌아오지
  않는다. 개인정보 관점에서 안전한 방향(이름은 덜 나가고 행은 재시도로 다시 지워진다)이라 그대로 뒀다.
  **→ 이 판단은 틀렸다(round 2 B2에서 정정).** 삭제 방향만 보고 기록 방향을 보지 않았다: 같은 롤백이
  `#remember`도 되돌리지 않으며 그쪽은 안전하지 않다. 지금은 두 방향 다 스테이징으로 닫혀 있다.

## Review round 2

리뷰어 판정: `request_changes` (blocker 2 + major 1). round 1의 일곱 건은 해소 확인을 받았고, 새로 나온
세 건도 모두 타당해 반박 없이 고쳤다. **round 1에서 내가 "안전한 방향이라 그대로 뒀다"고 적은 판단
하나(메모리 버퍼의 롤백)가 틀렸다** — 반대 방향을 보지 않았다. 아래 표의 마지막 열은 각각 그 지적을
재현하는 테스트이며, 고침을 되돌리면 실패하는 것을 실제로 확인했다.

| finding | 처리 | 고침 SHA | 근거·테스트 |
|---|---|---|---|
| **B1** `main.ts:639` — production chat adapter가 `(envelopes, checkpoint) => engine.ingest(...)`라 sink가 넘기는 `{ onInserted }`를 버린다. gate-open production에서 JOIN observe·LEAVE delete가 전혀 실행되지 않는데 envelope·checkpoint는 commit된다 | 배선을 함수로 꺼내고(`youtube/chat/wiring.ts`의 `chatRuntimeDeps`) 어댑터를 **없앴다**: engine이 이미 `InboxWriter`를 만족하므로 그대로 넘긴다 — 넘기지 않는 인자를 잃을 수는 없다. `main.ts`는 이 함수가 만든 객체 하나만 넘긴다. 같은 부류를 rg로 확인했다(아래 "같은 부류 확인") | `926d0c9` | 새 `youtube/chat/wiring.test.ts` 3건 — 실제 store·`StateEngine`·`ConsentDirectory`로 `chatRuntimeDeps()`가 만든 객체에 JOIN→consent row, LEAVE→삭제; 리뷰어의 좁은 probe(`onInserted` 호출 index `[0]`, `insertedCount` 1); 닫힘에서는 `consent`/`onConsentFailure` 부재. 2-인자 wrapper로 되돌리면 앞 두 건이 실패한다(확인: `expected undefined to be 'synthetic-viewer-wiring'`, `expected [] to deeply equal [ +0 ]`). 추가로 `identity/consent-mode.test.ts`의 fixture도 자체 inbox 대신 `chatRuntimeDeps`를 쓰게 바꿔, 기존 9건이 production 배선 위에서 돈다 |
| **B2** `store.ts:336` 트랜잭션 안에서 훅이 `ConsentDirectory`의 in-memory `#remember`를 바꾸는데 rollback이 메모리를 되돌리지 않고(`directory.ts:145-151`), `RetentionSweeper`는 DB row만 지워(`retention.ts:249`) pending map을 안 비운다 → observe→checkpoint 실패→31일 sweep→같은 messageId retry에서 삭제된 actor가 `takeActor`로 재노출 | 두 쪽을 다 닫았다. (1) `ConsentDirectory.duringCommit(write)`가 메모리 전용 효과(`#remember`·삭제 시 forget) 두 가지를 write 동안 **스테이징**하고 write가 반환한 뒤에만 적용한다 — 롤백이면 폐기하고, 스테이징만 하고 적용/폐기를 안 하는 상태는 표현 자체가 불가능하다. sink가 inbox write를 이걸로 감싼다. `ConsentObserver`에 **필수** 메서드로 넣었다(선택으로 두면 반쪽 구현이 곧 이 결함이다 — 컴파일러가 stub 3개를 잡아냈다). (2) sweeper가 `identity` 포트를 받아 매 run 끝에 `forgetDeleted()`를 부른다: 버퍼에 남은 ref 중 행이 사라진 것을 골라 표시명을 버리고 ref를 arbiter purge 큐에 넣는다 — 일괄 삭제라 ref를 모르는 sweeper가 **버퍼 쪽에서** 같은 삭제 경계에 닿는 방식이다 | `8be3327` | `consent-mode.test.ts` 2건 신규. "discards a rolled-back attribution…": store 전용 `ArmedClock`으로 checkpoint 기록(트랜잭션 마지막 단계)을 실패시켜 훅 실행 **뒤** 롤백을 만들고 → 롤백 직후 `pendingCount 0` → 31일 sweep(`rowsDeleted 1`) → 같은 messageId 재시도 → `takeActor null`, `pendingCount 0`. "drops a buffered actor whose row the sweep deleted": 버퍼에 남은 상태로 sweep → `pendingCount 0`·`takeActor null`·`drainForgotten()`에 해당 ref. 스테이징과 `forgetDeleted`를 각각 무력화하면 두 건 다 `expected 1 to be +0`으로 실패한다(확인) |
| **M1** `identity-consent.md:27·52·74`의 ja/en 고지가 "channel ID와 display name 외 아무것도"인데 `006_viewer-consent.sql:29-50`·`retention.json:248-254`는 `channel_ref`·`channel_id`·`display_name`·`consented_at`·`last_active_at`·`notice_version`을 저장한다 | ja/en 전문과 §1 요약표에 **6개를 전부** 적었고, "YouTube에서 받는 2개 / 시스템이 만드는 4개"의 구분을 유지했다(`channel_ref`가 ID·이름에서 파생되지 않는다는 사실 포함). `CONSENT_NOTICE_VERSION`을 `2026-08-20`으로 올렸다 — round 1의 유예 근거("같은 날")가 이번엔 성립하지 않기 때문이며, 게시 전·동의 레코드 0건이라 재동의 대상은 없다. 체크리스트 행 7에 sweep 쪽 삭제 경계를, 행 4의 낡은 줄 번호를 생성 지점 표기로 고쳤다 | `d58270d` | [S41] III.A.2(e)-(f). `identity.test.ts` "is versioned by the document it comes from"(문서↔상수 일치), `build`의 `generate-data-map.mjs --check` 통과(`retention.json`은 이미 6개를 적고 있었으므로 무변경) |

### 같은 부류 확인 (B1, rg)

`inbox.ingest`를 어댑터로 감싸는 곳은 네 군데다.

| 위치 | hooks 전달 | 판정 |
|---|---|---|
| `apps/server/src/main.ts:639` (chat sink) | **버렸음** | B1 — 고쳤다. hooks를 넘기는 유일한 호출자(sink)가 여기로 들어온다 |
| `apps/server/src/main.ts:179` (`SimulatorIngestEndpoint`) | 전달함 | 이상 없음 |
| `tools/simulator/src/runner/harness.ts:152`, `tools/soak/src/system.ts:350` | 버림 | **무해**: 둘 다 `SimulatorIngestEndpoint`용이고 그 엔드포인트는 `inbox.ingest(envelopes, checkpoint)`로 2개만 넘긴다(`engine/ingest.ts:100`) — 넘길 hooks가 존재하지 않는다. consent 경로도 없다. 요청 범위 밖이라 건드리지 않았다 |
| `apps/server/src/engine/e2e.test.ts:48` | 버림 | 테스트 fixture이고 consent를 쓰지 않는다. 무해 |

### Round 3 gates (executed)

```text
$ npm run format:check   → All matched files use Prettier code style!
$ npm run lint           → eslint 0 errors; check-no-legacy-imports: ok (0); check-install-scripts: ok (4)
$ npm run typecheck      → tsc --build, 오류 없음
$ npm run test           → Test Files 145 passed (145) / Tests 2082 passed | 1 skipped (2083)
$ npm run build          → 전 워크스페이스 성공, "copied 6 migration(s)", "docs/ops/data-map.md up to date"
```

`origin/main` rebase 뒤에 실행한 수치다(rebase 전 이 브랜치 단독으로는 143 files / 2033 tests였고,
차이는 그 사이 main에 들어온 다른 PR의 테스트다). round 2에서 본 `db/crash.test.ts`의 Windows
`EPERM` flake는 이번 실행에서 재현되지 않았다.

### Round 3 노트 (반박이 아니라 정정)

- **round 1에서 틀린 판단**: "메모리 버퍼의 롤백 — 훅이 던져 롤백돼도 directory가 이미 지운 pending
  표시명은 돌아오지 않는다. 개인정보 관점에서 안전한 방향이라 그대로 뒀다." 삭제 방향만 보고 **기록
  방향**을 보지 않았다. 같은 롤백이 `#remember`도 되돌리지 않고, 그쪽은 안전하지 않다. round 2 B2가
  두 방향을 다 스테이징으로 닫았다.
- **`duringCommit`을 선택 메서드로 두지 않은 이유**: 관측만 구현한 observer는 롤백이 닿지 못하는
  메모리를 남기고, 그게 정확히 이 결함이다. 필수로 두니 컴파일러가 stub 3개를 짚었고, 그중
  `consent-mode.test.ts`의 wrapper는 실제 directory의 경계를 위임하도록 고쳤다 — 그러지 않았으면 그
  테스트가 스테이징을 조용히 꺼 버렸을 것이다.
- **"반환 = commit"의 가정**: `duringCommit`은 write가 반환하면 적용한다. SQL commit 뒤 반환 전에
  던지는 경로(`StateEngine.ingest`의 `notifyIngest()`)는 폐기로 떨어지는데, 그쪽이 안전한 방향이다 —
  이름이 붙지 않은 반응이 나갈 뿐, 저장소가 뒷받침하지 않는 이름이 나가지는 않는다. 주석에 적었다.
- **`packages/contract` 무변경**, `package.json`/lockfile 무변경, 새 dependency 0.
