# TASK-T20b-identity-server

- Task: T20b identity (B) 서버: 동의 저장·authorDetails 처리·삭제·보존·compliance 문서 (`docs/tasks/TASK_SPECS.md` §T20b)
- Branch: `dnhynk/t20b-identity-server` · PR: #<n>
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

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
```

## Not done / out of scope

- 분기 투표(A/B/C) 실험 자체 — A-20에 따라 Gate 2. 이 PR은 플래그와 코드 경로를 그대로 둔다.
- 렌더러 표시(T20c).

## Follow-ups

- 

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
