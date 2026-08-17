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

## Result

(구현 후 채운다)

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
(구현 후 채운다)
```

## Not done / out of scope

- 상태 전이 규칙·deadline 정책 적용(replay/coalesce/skip 실행)은 T8. 이 task는 저장·로드와 트랜잭션 경계만 만든다.
- `broadcast_resources` 컬럼 확정은 T10, `retention_ledger` 사용은 T13. 여기서는 테이블 뼈대만.
- 보존 삭제 작업(30일 만료 행 제거)은 T13.

## Follow-ups

- `config/default.json`과 `clock.ts`/`fake-clock.ts`는 T2·T3 PR과 같은 파일을 만든다. 먼저 머지되는 PR 기준으로 rebase 필요(코디네이터 최종 게이트 2.6-3).
