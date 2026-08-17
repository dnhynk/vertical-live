# TASK-T4-persistence

- Task: T4 SQLite 영속층: inbox·checkpoint·snapshot·outbox·deadline (`docs/tasks/TASK_SPECS.md` §T4)
- Branch: `dnhynk/t4-persistence` · PR: #(pending)
- Orca: task `task_6bb9ff9f79c8` · dispatch `ctx_b455135e621e`
- Spec sections read: §7.3(2)(3)(5)(7), §7.4, §9.2, §10.2, §11 "상태 복구"·"유료 무결성"·fault matrix
- BOARD decisions/assumptions relied on: D-1(TypeScript/Node 24), A-2(유료 4타입 규칙 구현), A-5(SQLite WAL 단일 파일), A-14(DB `data/vertical-live.db`), A-15(스펙에 없는 숫자는 provisional config)

## Goal

`apps/server/src/db/`에 SQL 영속층을 만든다. 이 계층이 스펙 §10.2가 말하는 "policy-filtered ingest inbox / current snapshot / state revision / processed ingest sequence / deadline / idempotency의 권위값"이다. 상태 엔진(T8)·source adapter(T9)·broadcast(T10)·보존 자동화(T13)가 쓰는 트랜잭션 경계를 여기서 확정한다: 한 응답의 envelope 전체와 checkpoint가 한 트랜잭션, 한 상태 전이의 snapshot·revision·processedSeq·처리기록·deadline·effect outbox·유료 원장·gift combo가 한 트랜잭션. 부분 commit이 없어야 하고, 호스트 전원 장애 뒤에도 commit된 유료 이벤트가 남아야 한다.

## Plan

1. **의존성**: `better-sqlite3@13.0.3`(exact) + `@types/better-sqlite3@9.6.0`(exact, dev). 근거는 아래 "Assumptions" 표.
2. **연결·PRAGMA** (`db/open.ts`): `journal_mode=WAL`, `synchronous=FULL`, `foreign_keys=ON`, `busy_timeout`(provisional config). 선택 근거는 "Sources consulted".
3. **마이그레이션 러너** (`db/migrations.ts` + `db/migrations/NNN_*.sql`): 순번 SQL 파일을 오름차순으로 각각 한 트랜잭션에서 적용하고 `schema_migrations(version, name, checksum, applied_at)`에 기록. 이미 적용된 파일의 checksum이 바뀌면 거부(손으로 고친 마이그레이션 탐지). `tsc`가 `.sql`을 복사하지 않으므로 `apps/server/scripts/copy-migrations.mjs`를 build에 추가.
4. **스키마** (`001_initial.sql`): `ingest_inbox`(+ `UNIQUE(source, broadcast_id, message_id, gift_effective_count)`), `source_checkpoint`, `world_snapshot`, `state_transitions`, `deadlines`, `effect_outbox`, `paid_ledger`, `gift_combo`, `broadcast_resources`(T10 뼈대), `retention_ledger`(T13 뼈대).
5. **API** (`db/store.ts`):
   - `commitIngestBatch(envelopes, checkpoint)` — 한 트랜잭션에서 inbox insert(중복은 무시하고 결과로 보고) + `ingestSeq` 발급 + checkpoint 갱신.
   - `drainUnprocessed(afterSeq, limit)`.
   - `commitStateTransition({snapshot, revision, processedSeq, transitions, processed, deadlines, effects, paidLedger, giftCombo})` — 한 트랜잭션.
   - `markEffectPublished/Acked/Expired`.
   - `upsertGiftMax(baseKey, effectiveCount) → delta`(`delta = max(0, effectiveCount - storedMax)`, `storedMax` 비감소).
   - `loadRecoveryState()` — 마지막 snapshot·`stateRevision`·`processedIngestSeq`·미ACK effect·due deadline; `getSourceCheckpoint(sourceKey)`.
6. **lock 분류** (`db/errors.ts`): `SQLITE_BUSY`/`SQLITE_LOCKED`/`SQLITE_BUSY_SNAPSHOT`/`SQLITE_READONLY`/`SQLITE_FULL`/`SQLITE_CORRUPT`/`SQLITE_CONSTRAINT` → `{kind, retryable}`. fault matrix "DB lock" 행에 대응.
7. **테스트**: 마이그레이션, ingest 원자성·중복, state 원자성·revision 단조, effect 상태 전이, gift delta 시퀀스, 복구, busy/lock, 그리고 자식 프로세스를 트랜잭션 도중 SIGKILL 하는 crash-window 테스트.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| `PRAGMA synchronous` — WAL에서 NORMAL의 내구성 | https://sqlite.org/pragma.html#pragma_synchronous | 2026-08-17 | "WAL mode is always consistent with synchronous=NORMAL, but WAL mode does lose durability. **A transaction committed in WAL mode with synchronous=NORMAL might roll back following a power loss or system crash.**" → §T4 요구("전원 장애 후에도 commit된 유료 이벤트가 남는다")를 NORMAL은 만족하지 못한다 |
| `PRAGMA synchronous` — FULL의 보장 | https://sqlite.org/pragma.html#pragma_synchronous | 2026-08-17 | "When synchronous is FULL (2), the SQLite database engine will use the xSync method of the VFS to ensure that all content is safely written to the disk surface prior to continuing." → `synchronous=FULL` 선택. 같은 문서: "EXTRA is no different from FULL in WAL mode" → EXTRA는 이득 없음 |
| WAL — commit 시 sync 시점 | https://sqlite.org/wal.html | 2026-08-17 | "Writers sync the WAL on every transaction commit if PRAGMA synchronous is set to FULL but omit this sync if PRAGMA synchronous is set to NORMAL." |
| WAL — 모드 지속성 | https://sqlite.org/wal.html | 2026-08-17 | "Unlike the other journaling modes, PRAGMA journal_mode=WAL is persistent. If a process sets WAL mode, then closes and reopens the database, the database will come back in WAL mode." → 열 때마다 설정하지만 재기동 후에도 유지됨을 테스트로 확인 |
| `PRAGMA busy_timeout` | https://sqlite.org/pragma.html#pragma_busy_timeout | 2026-08-17 | "Query or change the setting of the busy timeout." 값 자체는 공식 문서가 정하지 않음 → provisional config |
| `better-sqlite3` 버전·Node 지원 | https://www.npmjs.com/package/better-sqlite3 (`npm view`) | 2026-08-17 | 13.0.3 latest, `engines.node >= 22`, `prebuilds/win32-x64.node`·`linux-x64.node` 포함(호스트 Windows·CI ubuntu 모두 소스 빌드 불필요) |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) | | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `db.busyTimeoutMs` | 5000 | `provisional` | 스펙·TASK_SPECS에 값이 없고 sqlite.org도 권장값을 주지 않는다. Gate 2 fault matrix("DB lock") 실측으로 교체 |
| `db.file` | `data/vertical-live.db` | 고정 | TASK_SPECS 공통 규약, BOARD A-14 |
| 세계 식별자 | `world_snapshot.world_id = 'default'` | 고정(V1) | 스펙 §10.2는 host 1개·world 1개. 컬럼은 스펙이 지정한 PK이므로 유지하고 값만 상수 |
| `better-sqlite3@13.0.3` / `@types/better-sqlite3@9.6.0` | exact | — | CLAUDE.md §2가 better-sqlite3를 고정. v13이 최신이고 Node 24 prebuild를 포함. 타입은 별도 패키지(라이브러리가 `.d.ts`를 배포하지 않음) |
| `apps/server/src/clock.ts`, `apps/server/src/testing/fake-clock.ts` | T2(PR #3)·T3(PR #4)와 **바이트 단위로 동일한 파일**을 추가 | — | 두 PR이 아직 머지되지 않아 `origin/main`에 없다. 내용이 동일하면 rebase 시 add/add가 자동 해소된다. 새 추상화가 아니라 같은 파일의 재사용 |
| `config/default.json` `db` 섹션 | 최상위 키 `db` 추가 | — | T2는 `obs`, T3는 `youtube` 최상위 키를 같은 파일에 추가하는 패턴. 키가 서로 겹치지 않는다 |
| `commitStateTransition` 입력에 `processed[]` 추가 | `{ingestSeq, result, at?}` | — | TASK_SPECS §T4가 나열한 필드에는 없지만 스펙 §7.3(5)의 "처리 기록"과 §7.3(3)의 "무효·미지원 envelope는 **이유와 함께** 처리 완료로 전진"이 같은 트랜잭션 안의 inbox 갱신을 요구한다 |
| `effect_outbox.state_revision` 컬럼 추가 | `INTEGER NOT NULL` | — | TASK_SPECS의 컬럼 목록에는 없으나 `Effect.stateRevision`이 계약 필드이고, 재시작 때 이 행에서 Effect를 그대로 복원해야 한다 |

## Result

`apps/server/src/db/`에 `PersistenceStore`를 만들었다. 파일 9개(`open`·`migrate`·`store`·`config`·`errors`·`types`·`index`·`migrations/001_initial.sql`·testing 3개)와 테스트 9개 파일 78건. 전체 스위트 562건 통과.

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | crash-window 테스트: inbox insert 뒤/checkpoint 전, state 쓰기 중, effect 기록 뒤/ACK 전 각각 예외를 주입해도 부분 commit이 없다 | met | **in-process 예외 주입 3건**: (a) `db/ingest.test.ts` "crash window \"after inbox insert, before checkpoint\"" — `ArmableClock`이 checkpoint용 `nowUtcIso()` 호출(inbox insert 뒤 유일한 clock 사용처)에서 throw → inbox 0행·checkpoint null. (b) `db/state.test.ts` "crash window \"while writing state\"" — deadline payload에 `BigInt`를 넣어 snapshot·transitions·처리기록 이후 `JSON.stringify`가 throw → revision·processedSeq·effect·deadline·gift 전부 이전 값, inbox 행은 미처리로 남아 재drain. (c) `db/effects.test.ts` "crash window \"after the effect was recorded, before the ACK\"" — publish 뒤 재오픈 시 미ACK로 복귀. **실제 프로세스 SIGKILL 4건**: `db/crash.test.ts` + `db/testing/crash-child.mjs`(자식 프로세스가 open transaction 상태로 SIGKILL) — 트랜잭션 중 kill → inbox 0행·checkpoint 0행, commit 직후 kill → `paid_ledger` 행 생존(`synchronous=FULL`), effect publish 후 kill → 미ACK effect 복구 |
| 2 | 같은 message 두 번 commit → inbox 1건; Gift combo 0→1→3→5→3 delta 1,0,2,2,0 | met | `db/ingest.test.ts` "stores the same message once and reports the second as a duplicate"(두 번째 결과 `duplicate:true`, 같은 `ingestSeq`, 행 1개) + "deduplicates a duplicate inside a single batch". `db/gift-combo.test.ts` "yields deltas 1, 0, 2, 2, 0 for the combo sequence 0 → 1 → 3 → 5 → 3" + `storedMax`가 5로 유지됨(감소 무시) + 같은 파일의 마지막 테스트가 contract fixture(`gift-event-combo-0/1/3/5`)에서 effectiveCount 1,1,3,5를 재확인 |
| 3 | `PRAGMA journal_mode`/`synchronous` 선택 근거 URL이 티켓에 있다 | met | 위 "Sources consulted" 표(sqlite.org 인용문 + 확인일 2026-08-17). 같은 인용이 `db/open.ts` 상단 주석에 있고 `db/migrate.test.ts` "applies and verifies the durability PRAGMAs"가 `journal_mode=wal`·`synchronous=2`·`foreign_keys=1`·`busy_timeout`을 읽어 확인한다. `openDatabase`는 값이 다르면 열지 않는다(`PRAGMA journal_mode=WAL`은 실패해도 예외를 던지지 않고 실제 모드를 반환하므로) |
| 4 | `busy_timeout`과 lock 오류 분류가 있고 테스트된다(fault matrix "DB lock") | met | `db/errors.ts` `classifySqliteError` → `{kind,retryable,code}`; `db/locking.test.ts` 7건: 두 번째 연결이 `BEGIN IMMEDIATE`로 write lock을 잡은 상태에서 `commitIngestBatch`가 `busy_timeout`만큼 대기한 뒤 `SQLITE_BUSY`(kind `busy`, `retryable:true`)로 실패하고 아무것도 쓰지 않음, lock 해제 후 성공, WAL이라 write 중에도 read(drain)는 통과, 그리고 constraint/readonly/disk_full/corrupt/io/other 분류 |

### Gates (executed)

`git fetch origin && git rebase origin/main`(main `079635d`, T2 PR #3 머지 포함) 후 실행:

```text
$ npm run format:check
Checking formatting...
All matched files use Prettier code style!

$ npm run lint
> eslint . && node scripts/check-no-legacy-imports.mjs
check-no-legacy-imports: ok (0 legacy imports)

$ npm run typecheck
> tsc --build tsconfig.json
(출력 없음 = 통과)

$ npm run test
 Test Files  27 passed (27)
      Tests  562 passed (562)
   Duration  14.06s

$ npx vitest run apps/server/src/db
 Test Files  9 passed (9)
      Tests  78 passed (78)
   (migrate 11, config 4, ingest 14, state 13, gift-combo 6, effects 13, locking 7, crash 4, recovery 6)

$ npm run build
> @vl/contract: schema up to date (6 files)
> @vl/renderer: ✓ built in 10.69s
> @vl/server: tsc --build && node scripts/copy-migrations.mjs
  copied 1 migration(s) to dist/db/migrations
> @vl/simulator: tsc --build
```

빌드 산출물 스모크(마이그레이션 경로가 `dist`에서도 해석되는지 — 실행한 명령과 출력):

```text
$ node --input-type=module -e "import { PersistenceStore } from '.../apps/server/dist/index.js' ..."
dist smoke ok: {"sourceKey":"youtube:chat_test_0001","liveChatId":"chat_test_0001","nextPageToken":"tok","lastIngestSeq":0,"updatedAt":"2026-08-17T05:48:19.095Z"}
gift delta: 3
```

## Not done / out of scope

- 상태 전이 규칙·deadline 정책 **실행**(replay/coalesce/skip)은 T8. 이 task는 정책을 행과 함께 저장하고 due/pending으로 되돌려주는 것까지만 한다.
- `broadcast_resources` 컬럼 확정은 T10, `retention_ledger` 사용은 T13. 여기서는 `001_initial.sql`의 테이블 뼈대만 만들고 API를 붙이지 않았다(마이그레이션 테스트가 존재만 확인).
- 보존 삭제 작업(30일 만료 행 제거)은 T13. `ingest_inbox.ingest_seq`가 `AUTOINCREMENT`인 이유가 여기에 있고, 삭제 후 seq 재사용이 없음을 `db/ingest.test.ts`가 확인한다(https://sqlite.org/autoinc.html, 2026-08-17: "The purpose of AUTOINCREMENT is to prevent the reuse of ROWIDs from previously deleted rows.").
- busy 재시도 루프는 만들지 않았다. `busy_timeout`이 대기를 담당하고, 그 뒤의 판단(retry/degraded/safe_stopped)은 T12 supervisor의 몫이므로 분류만 제공한다.

## Follow-ups

- **A-17(2026-08-17 BOARD)**: 타이머 유래 effect는 `causedByEventKey=null` + `cause` 판별자를 갖게 된다. 지금 contract(`EffectSchema.causedByEventKey` 필수)에 맞춰 `effect_outbox.caused_by_event_key`를 `NOT NULL`로 만들었다. T1b가 contract를 바꾼 뒤 `002_*.sql`에서 컬럼을 nullable로 바꾸고 `cause_kind`·`cause_deadline_kind`를 추가해야 한다(마이그레이션 러너가 적용된 파일 수정을 거부하므로 새 파일로). 이 task는 `[contract]`가 아니어서 미리 반영하지 않았다.
- `vitest.config.ts`에 `@vl/contract` → 소스 alias를 추가했다. 이 저장소의 첫 cross-package import이고, alias가 없으면 `vitest run`이 `dist/` 빌드 순서에 의존한다(CI는 typecheck가 먼저라 우연히 통과). T5·T6·T7도 같은 alias를 쓴다.
- `config/default.json`은 T3(PR #4)도 최상위 키(`youtube`)를 추가한다. 키가 겹치지 않으므로 rebase 시 텍스트 충돌만 해소하면 된다.
- `world_snapshot.world_id`는 V1에서 상수 `'default'`다. 다중 world가 필요해지면 `state_transitions`에 world 스코프를 넣는 마이그레이션이 필요하다(지금은 스펙이 지정한 컬럼만 둔다).
