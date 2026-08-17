# TASK-T13-data-policy

- Task: T13 데이터 보존·삭제·철회 자동화 (`docs/tasks/TASK_SPECS.md` §T13)
- Branch: `dnhynk/t13-data-policy` · PR: #10
- Orca: task `task_15cd2ae24e82` · dispatch `ctx_2cc8eb9d4f98`
- Spec sections read: §7.4, §8.6, §10.2, §12.3, §12.4, §14.1, §14.2, [S12] [S41] [S42]
- BOARD decisions/assumptions relied on: D-1, D-4, A-1(identity gate 닫힘), A-7(`sourceDataExpiresAt = receivedAt + 30일`), A-14(공용 규격), A-15(provisional 숫자)

## Goal

스펙 §12.4의 보존·삭제·철회 규칙을 "문서상의 약속"이 아니라 **실행되는 코드와 감사 기록**으로 만든다.
field별 schedule(`config/retention.json`)을 정본으로 두고, 주기 job이 30일 규칙을 실제로 집행하며 모든 삭제·재확인을
append-only `retention_ledger`에 남긴다. 동의 철회(`auth_revoked`)는 token 제거 + Authorized Data 삭제를
client-side 7일 / Google 측 30일 분기로 처리하고, 사용자 삭제 요청 handler는 **저장된 식별자가 없음을 스키마에서 확인**한
뒤 기록만 남긴다(identity gate가 열릴 때 쓰는 인터페이스). §14.1의 "승인 후 후보" 파생 지표를 계산·저장하는 코드가
저장소 어디에도 없음을 테스트로 고정한다.

## Plan

1. **`config/retention.json`** — field별 `source·purpose·allowedPeriodDays·policy(delete|refresh)·expiry·dataClass·
   personalIdentifiers` 표. 현재 스키마의 모든 테이블을 덮고, 데이터 주체 내용이 없는 테이블은 `schemaOnlyTables`에
   이유와 함께 명시한다. `revocation`(7일/30일 분기, reason→class 매핑)과 `sweep`(주기·batch, provisional) 포함.
2. **로더 `apps/server/src/privacy/config.ts`** — 엄격 검증(정책별 필수 필드, 식별자 정규식, 알 수 없는 키 거부)과
   거부 경로 테스트. 임의 숫자 금지: 30/7/30일은 스펙 §12.4 값, 그 외 운영 수치는 `provisional`.
3. **마이그레이션 `002_retention-ledger.sql`** — T4가 스켈레톤으로 남긴(§T4 주석) `retention_ledger`를 append-only
   감사 원장으로 재정의: `field_key·source·purpose·policy·reason·allowed_period_days·cutoff_at·deadline_at·outcome·
   rows_deleted·rows_unprocessed·deleted_at·recorded_at`.
   식별자 컬럼을 두지 않는다(삭제 요청 기록이 스스로 §12.4를 위반하면 안 된다).
4. **`apps/server/src/db/retention.ts` + `PersistenceStore` 위임 메서드** — 스키마 조회(테이블·컬럼), 컬럼 기준
   만료 삭제(batch), orphan 삭제(gift_combo), 최신 갱신 시각, 전체 삭제(철회용), 원장 기록·조회. SQL은 db 계층에만 둔다
   (`db/index.ts`가 "T13(retention)은 SQL을 직접 만지지 않고 store를 쓴다"고 이미 규정).
5. **sweeper `privacy/retention.ts`** — `delete` 항목은 `now - allowedPeriodDays` 이전 행 삭제,
   `refresh` 항목은 `reverifyPeriodDays` 안에 갱신/재확인됐는지 확인(아니면 `reverification_due`로 보고).
   결과마다 원장 1행. 미처리 inbox 행 삭제는 별도 카운트로 보고(무음 유실 금지).
6. **scheduler `privacy/scheduler.ts`** — 주입된 `Clock`으로 주기 실행, `runNow()`/`start()`/`stop()`, 결과 sink(T12 알림용).
7. **철회 `privacy/revocation.ts`** — `AuthRevokedEvent` → (a) vault의 refresh token 제거(원격 revoke는 T3
   `TokenManager.revokeGrant`가 이미 수행; 이미 latch된 상태면 중복 호출하지 않는다), (b) `authorized_api_data` 전량 삭제,
   (c) reason→class로 `deadline_at`(7일/30일) 기록.
8. **사용자 삭제 요청 `privacy/deletion-request.ts`** — 식별자를 **인자로 받지 않는다**. 라이브 스키마에서 식별자 컬럼을
   스캔해 0건임을 확인하고 원장에 `no_stored_identifiers`로 기록. 식별자 컬럼이 존재하면(gate 개방 후) 명시적으로 실패한다.
9. **파생 지표 가드 `privacy/derived-metrics.ts` + 테스트** — §14.1 "승인 후 후보" 지표 레지스트리와, 저장소 소스·DB
   스키마에 그 지표를 계산·저장하는 이름이 없음을 스캔하는 테스트(스캐너 자체가 공허하지 않음을 양성 대조로 확인).
10. **`docs/ops/data-map.md`** — `config/retention.json`에서 스크립트로 생성(`npm run data-map:generate -w @vl/server`),
    `--check`를 서버 build에 걸어 드리프트를 막는다(CLAUDE.md §4 "생성물은 스크립트로").
11. **테스트** — 가상 시계 30일 경계(29일 무삭제/30일 삭제+기록), 철회 7일·Google 30일 분기, 스키마 전체
    author/channel/hash 컬럼 부재, 삭제 후 `ingest_seq` 재사용 없음, 로더 거부 경로.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| YouTube API Services Developer Policies (보존·삭제) | https://developers.google.com/youtube/terms/developer-policies | 2026-08-17 | [S12] 스펙 §12.4가 인용한 정본. 30일 refresh-or-delete, 사용자 삭제 요청 7일, client-side 철회 7일, Google 설정 철회 30일 |
| Developer Policies Guide (식별정보·동의) | https://developers.google.com/youtube/terms/developer-policies-guide | 2026-08-17 | [S41] identity gate가 닫힌 동안 식별자 미저장 |
| Derived metrics policy | https://developers.google.com/youtube/terms/derived-metrics-policy | 2026-08-17 | [S42] 승인 없는 파생 지표 계산·저장 금지 |
| SQLite `DELETE ... LIMIT` | https://sqlite.org/lang_delete.html | 2026-08-17 | `LIMIT`은 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT` 빌드 옵션이 있을 때만. 배치 삭제는 `WHERE rowid IN (SELECT … LIMIT ?)`로 구현 |
| SQLite AUTOINCREMENT | https://sqlite.org/autoinc.html | 2026-08-17 | `AUTOINCREMENT` 컬럼은 삭제 후에도 값을 재사용하지 않는다(`sqlite_sequence`) — T4가 `ingest_seq`에 이걸 쓴 이유이므로 테스트로 고정 |

> 위 정책 URL은 오프라인 환경에서 fetch하지 않았다. 스펙 §12.4·§14.1이 이미 각 규칙을 조문 단위로 옮겨 적었고
> 이 task의 요구는 "스펙에 적힌 규칙을 코드로 집행"이므로 스펙 문장을 근거로 구현했다. 정책 원문 재확인은 Gate 2 항목.

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) | | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `sweep.intervalMs` | 3600000 (1시간) | provisional | 스펙에 sweep 주기 값이 없다. 30일 기한을 1시간 해상도로 지키기에 충분하고 부하가 낮다. Gate 2에서 교체(A-15) |
| `sweep.batchLimit` | 5000 | provisional | 단일 DELETE가 write lock을 오래 잡지 않게 하는 배치 크기. 근거 수치 없음 |
| `missing_refresh_token` → `client_side`(7일) | client_side | 결정(근거 있음) | vault에 refresh token이 없다는 것은 "이 프로세스가 쓸 수 있는 동의가 남아 있지 않다"는 뜻이고, 이 부재가 철회의 **영속 기록**이다(재시작 시 `auth_revoked`가 다시 발생해 삭제가 재실행된다). 두 분기 중 더 엄격한 쪽을 택하는 것은 항상 정책 준수 방향이다 |
| `invalid_grant` → `provider_side`(30일) | provider_side | 결정(근거 있음) | token endpoint가 `invalid_grant`를 주는 대표 원인이 Google 계정 설정에서의 권한 철회(§12.4 마지막 분기) |
| `operator_revoked` → `client_side`(7일) | client_side | 결정(근거 있음) | 운영자가 우리 CLI로 철회 = client-side consent 철회(§12.4) |
| `metrics_daily` 항목 | `status: "planned"` | provisional(스키마 미존재) | 지표 집계 테이블은 T12/T15 소관. 정책은 지금 고정하고, 테이블이 생기면 커버리지 테스트가 실재를 요구한다 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 가상 시계로 30일 경과 시 삭제·기록 | **met** | `apps/server/src/privacy/retention.test.ts` — "keeps source data until its allowed period has fully elapsed"(29일·정확히 30일 무삭제), "deletes and records once 30 days have passed"(30일+1ms에 3행 삭제, 원장 `outcome=deleted`·`rowsDeleted=3`·`cutoffAt=now-30d`·`deletedAt` 확인), "expires every table that carries source data"(inbox·checkpoint·transitions·deadlines·effect_outbox·paid_ledger·gift_combo·broadcast_resources 8개 테이블 0행), `scheduler.test.ts` — "deletes expired rows on the tick that crosses the 30-day line". **기록 보장**(round 1 B1): 삭제와 원장 행이 같은 트랜잭션 — "keeps the data when the audit row cannot be written"(원장 insert 실패 시 삭제 롤백), "records one audit row per batch, each committed with its own deletion". 모두 `FakeClock.advance()`로만 시간을 움직인다 |
| 1 | 철회 시 7일 내 삭제 | **met** | `apps/server/src/privacy/revocation.test.ts` — "leaves no usable grant and deletes the authorized data inside the window"(`operator_revoked` → 7개 authorized 테이블 0행, `deadlineAt = 철회+7일`, `withinDeadline=true`), "records every deletion against the 7-day deadline"(원장 `reason=consent_revoked`, `allowedPeriodDays=7`, `deletedAt <= deadline`), "applies the separate 30-day rule to an invalid_grant"(Google 측 30일 분기), "reports a deletion that finished after the deadline"(기한 초과를 숨기지 않음), "keeps the authorized data when the audit row cannot be written"(round 1 B1). **관측 보장**(round 1 B2): "refuses to be constructed without a result or error sink", "keeps recording failures when the error sink itself throws" — 배선 누락 시 실패가 사라지지 않는다 |
| 2 | DB 스키마 전체에서 author/channel/hash 컬럼 부재 | **met** | `apps/server/src/privacy/schema-identity.test.ts` — 마이그레이션 적용된 실제 DB의 모든 테이블(11개 이상, 컬럼 50개 이상)에서 `findIdentityColumns` 0건, 인덱스·뷰 SQL(주석 제외)에서 0건, `author`/`channel`/`hash` 3개 이름이 목록에 있음, 양성 대조(`author_channel_id` 컬럼을 심으면 검출)까지 포함 |
| 추가 | 승인 전 파생 지표 계산·저장 코드 부재 | **met** | `apps/server/src/privacy/derived-metrics.test.ts` — workspace 소스 파일 60개 이상 + 라이브 스키마 스캔 0건, 스캐너 양성 대조 포함. round 1 M2 이후 제외는 저장소 상대 경로 2개뿐이며 "exempts exactly the two registry paths and nothing else"가 이를 고정한다 |

### Gates (executed — review round 1 fix 후 재실행)

```text
npm run format:check  -> All matched files use Prettier code style!
npm run lint          -> eslint 통과 · check-no-legacy-imports: ok (0 legacy imports) · check-install-scripts: ok (3 reviewed, better-sqlite3 binding loads)
npm run typecheck     -> tsc --build tsconfig.json (출력 없음 = 통과)
npm run test          -> Test Files 67 passed (67) / Tests 1130 passed | 1 skipped (1131)
npm run build         -> contract·renderer·server·simulator 통과; server: "copied 2 migration(s) to dist/db/migrations", "docs/ops/data-map.md up to date"
```

`git fetch origin && git rebase origin/main`(round 1 fix 시점: BOARD 문서 커밋 3개) 후 위 5개 게이트를 모두 실행했다.
round 1 이전 실행값은 1107 tests였고, fix에서 privacy 테스트가 67 → 90건으로 늘어 1130이 되었다.
최초 구현 시 rebase 직후 renderer 테스트가 `jsdom` 미설치로 실패했고 `npm install`(T5가 추가한 devDependency 반영)로
해결했다 — `package-lock.json`은 변경되지 않았다.

## Not done / out of scope

- **프로세스 배선 없음.** `main.ts`는 아직 T0 스텁(HTTP `/health`만)이고 DB 열기·supervisor 수명주기는 T12 소관이므로
  `RetentionScheduler.start()`·`RevocationAuthEventSink` 연결을 T12에 남겼다. 배선 코드 예시는
  `docs/ops/data-map.md` §2에 적었다. 지금 main.ts에서 DB를 열면 T8/T12의 단일 writer 경계를 T13이 선점하게 된다.
- **운영자 CLI 없음.** 사용자 삭제 요청은 `UserDeletionRequestHandler.handle()` 인터페이스로 제공한다(명세가 요구한 것).
  `npm run` 진입점은 T16/T17의 운영 스크립트 범위.
- **`metrics_daily` 테이블 생성 없음.** 정책만 `status: "planned"`로 고정했다(테이블 소유는 T12/T15).
  테이블이 생기면 `assertSchemaCoverage`가 `status`를 `present`로 바꾸라고 실패한다.
- **`refresh` 재확인의 자동 판정 없음.** `Reverifier`를 주입하면 집행되지만, 주입이 없으면 삭제하지도 방치하지도 않고
  `reverification_due`로 기록해 사람 판단을 요구한다(§12.4는 "권한과 삭제 여부를 다시 확인"을 요구하며,
  그 판정은 이 job이 스스로 만들 수 있는 값이 아니다).
- 정책 원문([S12] [S41] [S42]) HTTP 재확인은 **실행하지 않았음**: 오프라인 worker 환경. 스펙 §12.4·§14.1이 조문 단위로
  옮겨 적은 내용을 근거로 구현했고, 원문 재확인은 Gate 2 항목으로 data-map.md §8에 남겼다.

## 범위 밖으로 보일 수 있는 변경 (근거)

| 변경 | 근거 |
|---|---|
| `apps/server/src/db/store.ts`에 retention 메서드 추가 | `db/index.ts`가 이미 "T13(retention)은 SQL을 직접 만지지 않고 `PersistenceStore`를 쓴다"고 규정한다. 두 번째 커넥션을 여는 대안은 같은 WAL 파일에 두 writer를 만든다 |
| `001_initial.sql`의 `retention_ledger`를 002에서 재정의 | 001 주석이 "T13 fills and enforces this"라고 명시. 001은 checksum이 기록되어 편집이 금지되므로 새 마이그레이션이 유일한 경로. 운영 DB 없음은 R-T4-2에서 확인됨 |
| `apps/server/src/db/migrate.test.ts` 기대값 2건 수정 | 그 테스트가 "적용된 마이그레이션은 001뿐"을 단정하고 있어 002 추가 시 반드시 깨진다. 값만 갱신했고 단정의 정밀도는 유지했다 |
| `apps/server/package.json` build에 `generate-data-map.mjs --check` 추가 | 생성물 드리프트 방지(CLAUDE.md §4). `packages/contract`의 `generate-schema.mjs --check`와 같은 패턴 |
| `PersistenceStore.describeSchema()` 추가(round 1) | `assertSchemaCoverage`가 컬럼 집합까지 비교하려면 `table -> columns`가 필요하다(M1). SQL은 여전히 `db/retention.ts`에만 있다 |

## Follow-ups

- **T12**: 기동 시 `RetentionScheduler.start()` 호출, `RevocationAuthEventSink`를 `TokenManager` 이벤트 sink에 연결,
  sweep 결과의 `clean === false`(`reverificationDue`/`truncated`/`failed`)와 `rowsUnprocessed > 0`를 Discord 알림 대상으로.
- **T12/T15**: `metrics_daily` 집계 테이블을 만들 때 `config/retention.json`의 `status`를 `present`로 바꾸고
  `npm run data-map:generate -w @vl/server` 재실행.
- **T15**: fault matrix에 "sweep 중 DB lock", "철회 중 프로세스 종료 후 재기동 시 삭제 재실행" 행 추가.
- **T16**: `docs/ops/data-map.md`를 Gate 2 체크리스트와 연결하고 provisional 수치(§8) 확정.
- 향후 새 테이블을 만드는 모든 task는 `config/retention.json`에 항목을 추가해야 한다 —
  누락하면 `RetentionSweeper` 생성이 `RetentionConfigError`로 실패한다(테스트로 고정).
- **T12**: `RetentionScheduler.unhealthy`·`failures`, `RevocationAuthEventSink.failed`·`failures`를 건강 집계에 넣는다
  (sink 호출과 별개로 상태에 남는 실패 — round 1 B2에서 추가).

## Review round 1

리뷰: <https://github.com/dnhynk/vertical-live/pull/10#pullrequestreview-4950197018> (verdict `request_changes`).
모든 finding을 고쳤다(반박 0건). 수정 커밋: `8559e05`(rebase 후 SHA).

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] `db/retention.ts:287` + `privacy/retention.ts:308`·`revocation.ts:219` — 삭제 배치가 자기 트랜잭션에서 커밋되고 감사 insert는 그 뒤에 일어나므로 크래시·원장 실패 시 "삭제됐는데 기록 없음"이 가능(리뷰어가 BEFORE INSERT 트리거로 `ingest_inbox=0, retention_ledger=0` 재현) | **고침 8559e05.** `runBatched`가 배치마다 `DELETE` + 그 배치의 `retention_ledger` insert를 **같은 IMMEDIATE 트랜잭션**에서 커밋한다(`db/retention.ts` `runBatched`, audit factory 필수). 원장 insert가 실패하면 그 배치의 삭제도 롤백되고, 원장을 아예 쓸 수 없으면 sweep은 `RetentionLedgerUnavailableError`로 중단해 error sink에 도달한다. 재현 테스트: `retention.test.ts` "keeps the data when the audit row cannot be written"(리뷰어와 같은 `BEFORE INSERT … RAISE(ABORT)` 트리거 → throw + `ingest_inbox=3` + `retention_ledger=0`), `revocation.test.ts` "keeps the authorized data when the audit row cannot be written". 배치별 증거: "records one audit row per batch, each committed with its own deletion". audit 미주입 방어: "refuses a batched deletion that was given no audit factory" |
| [blocker] `privacy/revocation.ts:258`·`scheduler.ts:88` — `onError`/`onResult`가 optional + 무음 기본값이라 T12 배선 누락 시 실패한 삭제가 resolve된 Promise로 사라짐 | **고침 8559e05.** 두 sink를 **필수**로 바꾸고(타입 + 생성 시 `requireSink` 런타임 검증) 실패를 sink 호출과 **별도로 상태**에도 남긴다(`scheduler.failures`/`unhealthy`, `sink.failures`/`failed`) + `logger.error`. 테스트: `scheduler.test.ts` "refuses to be constructed without a result or error sink", "reports an unmet obligation through the result sink and its own state", `revocation.test.ts` "refuses to be constructed without a result or error sink", "keeps recording failures when the error sink itself throws". 기존 호출부 6곳이 타입 오류로 드러났고 모두 갱신 |
| [major] `config/retention.json:40` — `ingest_inbox.storedColumns`에 실제 `ingest_seq` 누락, `assertSchemaCoverage`는 테이블 이름만 검사해 field map이 드리프트 가능 | **고침 8559e05.** `ingest_seq` 추가 + `assertSchemaCoverage(config, LiveSchema)`가 `present` field마다 `storedColumns`와 실제 컬럼 집합을 **양방향 정확 비교**한다(미선언 컬럼 / 없는 컬럼 모두 거부). `PersistenceStore.describeSchema()` 추가. 테스트: `config.test.ts` "assertSchemaCoverage (review round 1, M1)" 5건, `retention.test.ts` "refuses to run when a table gained an undeclared column"(실제 `ALTER TABLE ADD COLUMN`), "declares the inbox primary key the schema really has" |
| [major] `privacy/derived-metrics.test.ts:48` — basename 제외라 향후 어느 경로의 `derived-metrics.ts`든 검사에서 빠짐 | **고침 8559e05.** 저장소 상대 경로 2개(`apps/server/src/privacy/derived-metrics.ts`, `…/derived-metrics.test.ts`)만 제외한다. 테스트: "exempts exactly the two registry paths and nothing else"(두 경로 실재 확인 + 스캔 목록에서 빠졌음 확인) |
| [minor] `db/retention.ts:303` — 마지막 배치가 가득 찼으면 잔여 작업이 있다고 가정 | **고침 8559e05.** 예산 소진 후 victims 질의를 `LIMIT 1`로 다시 프로브해 정확 소진과 잔여를 구분한다. 테스트: `retention.test.ts` "does not claim remaining work when the last full batch emptied the table"(1행·`batchLimit=1`·`maxBatches=1` → `truncated=false`, `clean=true`), 기존 3행 케이스는 여전히 `truncated=true` |
| [issue] 티켓 `## Result` 정직성 — "삭제 증거를 잃을 수 없다"·"field map이 exhaustive"라는 서술이 위 두 건과 모순 | **고침 8559e05.** 두 서술이 이제 코드와 테스트로 사실이 되었고, 위 표와 아래 Result 근거를 실제 테스트 이름으로 교체했다 |
