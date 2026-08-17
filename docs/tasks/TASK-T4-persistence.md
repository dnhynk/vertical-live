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
| `better-sqlite3` 버전·Node 지원 | https://www.npmjs.com/package/better-sqlite3 (`npm view`) | 2026-08-17 | 13.0.3 latest, `engines.node >= 22`, `prebuilds/win32-x64.node`·`linux-x64.node` 포함. **주의(round 1에서 정정)**: prebuild가 tarball에 있어도 npm은 `gypfile:false`를 못 보고 `node-gyp rebuild`를 주입한다 — 아래 "Review round 1" B2 참조 |
| npm의 암묵적 node-gyp 판정 | `@npmcli/arborist/lib/arborist/rebuild.js:239-265`, `@npmcli/run-script/lib/run-script-pkg.js:25-38` (npm 11.6.2 번들 소스, 로컬에서 직접 읽음) | 2026-08-17 | `const { gypfile, bin, scripts = {} } = pkg` 뒤 `const isGyp = gypfile !== false && !install && !preinstall && await isNodeGypPackage(node.path)`. `pkg`는 lockfile/축약 packument에서 온 manifest이고 두 곳 모두 `gypfile`을 담지 않으므로 `undefined !== false` → `binding.gyp`가 있으면 `install: node-gyp rebuild`가 주입된다. 디스크의 package.json을 다시 읽는 경로(같은 파일 243행)는 `hasInstallScript`가 true일 때만 도는데 better-sqlite3는 install script가 없어 false다 |
| npm 축약 packument 필드 목록 | https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md | 2026-08-17 | 축약(`application/vnd.npm.install-v1+json`) 응답에 `gypfile`이 없다. `npm view better-sqlite3@13.0.3 gypfile` → `false`(전체 packument)이지만 install 경로는 그 값을 쓰지 않는다 |

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

> round 2 갱신(2026-08-17): 리뷰 round 1의 blocker 2 + major 1을 고치고, 그 사이 머지된 T1b(A-17) 계약에 맞췄다. 아래 표와 게이트는 **round 2 상태**다.

`apps/server/src/db/`에 `PersistenceStore`를 만들었다. 파일 9개(`open`·`migrate`·`store`·`config`·`errors`·`types`·`index`·`migrations/001_initial.sql`·testing 3개)와 테스트 9개 파일 **98건**. 전체 스위트 **585건** 통과.

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 0 | (round 1 리뷰 install precondition) 이 Windows 호스트에서 새 clone + 표준 `npm ci`가 컴파일 없이 성공한다 | met | 위 "Gates" round 2 블록의 clone→`npm ci` `EXIT=0`과 `build/` 디렉터리 부재. 원인·해결은 "Review round 1" B2 |
| 1 | crash-window 테스트: inbox insert 뒤/checkpoint 전, state 쓰기 중, effect 기록 뒤/ACK 전 각각 예외를 주입해도 부분 commit이 없다 | met | **in-process 예외 주입 3건**: (a) `db/ingest.test.ts` "crash window \"after inbox insert, before checkpoint\"" — `ArmableClock`이 checkpoint용 `nowUtcIso()` 호출(inbox insert 뒤 유일한 clock 사용처)에서 throw → inbox 0행·checkpoint null. (b) `db/state.test.ts` "crash window \"while writing state\"" — deadline payload에 `BigInt`를 넣어 snapshot·transitions·처리기록 이후 `JSON.stringify`가 throw → revision·processedSeq·effect·deadline·gift 전부 이전 값, inbox 행은 미처리로 남아 재drain. (c) `db/effects.test.ts` "crash window \"after the effect was recorded, before the ACK\"" — publish 뒤 재오픈 시 미ACK로 복귀. **실제 프로세스 SIGKILL 4건**: `db/crash.test.ts` + `db/testing/crash-child.mjs`(자식 프로세스가 open transaction 상태로 SIGKILL) — 트랜잭션 중 kill → inbox 0행·checkpoint 0행, commit 직후 kill → `paid_ledger` 행 생존(`synchronous=FULL`), effect publish 후 kill → 미ACK effect 복구 |
| 2 | 같은 message 두 번 commit → inbox 1건; Gift combo 0→1→3→5→3 delta 1,0,2,2,0 | met | `db/ingest.test.ts` "stores the same message once and reports the second as a duplicate"(두 번째 결과 `duplicate:true`, 같은 `ingestSeq`, 행 1개) + "deduplicates a duplicate inside a single batch". `db/gift-combo.test.ts` "yields deltas 1, 0, 2, 2, 0 for the combo sequence 0 → 1 → 3 → 5 → 3" + `storedMax`가 5로 유지됨(감소 무시) + 같은 파일의 마지막 테스트가 contract fixture(`gift-event-combo-0/1/3/5`)에서 effectiveCount 1,1,3,5를 재확인 |
| 3 | `PRAGMA journal_mode`/`synchronous` 선택 근거 URL이 티켓에 있다 | met | 위 "Sources consulted" 표(sqlite.org 인용문 + 확인일 2026-08-17). 같은 인용이 `db/open.ts` 상단 주석에 있고 `db/migrate.test.ts` "applies and verifies the durability PRAGMAs"가 `journal_mode=wal`·`synchronous=2`·`foreign_keys=1`·`busy_timeout`을 읽어 확인한다. `openDatabase`는 값이 다르면 열지 않는다(`PRAGMA journal_mode=WAL`은 실패해도 예외를 던지지 않고 실제 모드를 반환하므로) |
| 4 | `busy_timeout`과 lock 오류 분류가 있고 테스트된다(fault matrix "DB lock") | met | `db/errors.ts` `classifySqliteError` → `{kind,retryable,code}`; `db/locking.test.ts` 7건: 두 번째 연결이 `BEGIN IMMEDIATE`로 write lock을 잡은 상태에서 `commitIngestBatch`가 `busy_timeout`만큼 대기한 뒤 `SQLITE_BUSY`(kind `busy`, `retryable:true`)로 실패하고 아무것도 쓰지 않음, lock 해제 후 성공, WAL이라 write 중에도 read(drain)는 통과, 그리고 constraint/readonly/disk_full/corrupt/io/other 분류 |

### Gates (executed)

**round 2**: `git fetch origin && git rebase origin/main`(main `d3df55c`, T1b PR #7 머지 포함) 후, **GitHub에서 새로 clone 한 디렉터리**에서 표준 명령만으로 실행했다(round 1 리뷰의 install blocker가 실제로 사라졌는지가 요점이므로 `--ignore-scripts` 같은 플래그를 쓰지 않았다).

```text
$ git clone --branch dnhynk/t4-persistence --depth 1 https://github.com/dnhynk/vertical-live.git finalclone
$ cd finalclone && git log --oneline -1
72547d5 feat(db): store the effect cause discriminator from the A-17 contract

$ npm ci
added 281 packages, and audited 286 packages in 23s
NPM_CI_EXIT=0
$ ls node_modules/better-sqlite3/build
no build/ directory: no compilation happened      # node-gyp가 돌지 않았다

$ npm run format:check
All matched files use Prettier code style!                            EXIT=0

$ npm run lint
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (3 reviewed, better-sqlite3 binding loads)   EXIT=0

$ npm run typecheck
> tsc --build tsconfig.json                                           EXIT=0

$ npm run test
 Test Files  27 passed (27)
      Tests  585 passed (585)                                         EXIT=0

$ npm run build
  copied 1 migration(s) to dist/db/migrations
> @vl/simulator@0.0.0 build                                           EXIT=0
```

같은 커밋에서 db 테스트만:

```text
$ npx vitest run apps/server/src/db
 Test Files  9 passed (9)
      Tests  98 passed (98)
   (migrate 13, config 4, ingest 14, state 19, gift-combo 6, effects 17, locking 7, crash 4, recovery 6)
```

round 1 리뷰가 지적한 실패의 재현(고치기 전, 같은 방식의 clean clone):

```text
$ npm ci      # .npmrc 없이
npm error command failed
npm error command C:\WINDOWS\system32\cmd.exe /d /s /c node-gyp rebuild
gyp ERR! stack Error: Could not find any Visual Studio installation to use
npm error path ...\node_modules\better-sqlite3
```

참고로 **CI(ubuntu)는 round 1에서도 컴파일하지 않았다**: run 31999612915의 `npm ci` 로그에
`npm warn allow-scripts 2 packages have install scripts not yet covered by allowScripts:` /
`better-sqlite3@13.0.3 (install: node-gyp rebuild)`가 남아 있고 설치는 17초에 끝났다. CI에 들어 있는 더 새 npm이 install script를 기본으로 건너뛴 것이며, 이 호스트의 npm 11.6.2에는 그 게이트(`npm approve-scripts`)가 없다 — 즉 round 1의 통과/실패 차이는 npm 버전 차이였고, `.npmrc`가 두 환경을 같은 결과로 고정한다.

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

- ~~**A-17**: 타이머 유래 effect~~ → **round 1에서 처리 완료**. T1b(PR #7)가 round 1 작업 중 main에 머지돼 rebase로 들어왔으므로 미룰 수 없게 됐다. 아래 "Review round 1" 마지막 항목 참조.
- `vitest.config.ts`에 `@vl/contract` → 소스 alias를 추가했다. 이 저장소의 첫 cross-package import이고, alias가 없으면 `vitest run`이 `dist/` 빌드 순서에 의존한다(CI는 typecheck가 먼저라 우연히 통과). T5·T6·T7도 같은 alias를 쓴다.
- `world_snapshot.world_id`는 V1에서 상수 `'default'`다. 다중 world가 필요해지면 `state_transitions`에 world 스코프를 넣는 마이그레이션이 필요하다(지금은 스펙이 지정한 컬럼만 둔다).
- `.npmrc`의 `ignore-scripts=true`는 이 저장소 전체에 적용된다. install script가 반드시 필요한 dependency를 새로 넣는 task는 `scripts/check-install-scripts.mjs`에서 실패하므로 그때 install 전략을 다시 판단해야 한다(무시하고 allowlist에 추가하지 말 것).
- better-sqlite3의 `gypfile:false`가 npm registry install 경로에서 무시되는 것은 upstream 이슈로 보고할 가치가 있다(이 저장소의 해결은 `.npmrc`로 완결).

## Review round 1

리뷰: https://github.com/dnhynk/vertical-live/pull/5#pullrequestreview-4948957259 (verdict `request_changes`, blocker 2 + major 1)

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| **[blocker] `db/store.ts:387`** — `commitStateTransition`이 `processedSeq` 전진을 처리 기록으로 증명하지 않아 미처리 inbox 행이 복구 커서 아래 영구히 묻힌다(§7.3(3)(5), §11 상태 복구). 리뷰어 재현: inbox `seq=1` commit → `processedSeq=1`·`processed` 없음 → `processedIngestSeq:1`, `drainFromRecoveryCursor:[]` | **고침 429bb8c**(rebase 후 `72547d5` 계보). 커서 전진 규칙을 세 겹으로 강제한다: (1) `processed[]`는 `ingestSeq` 오름차순·중복 없음(트랜잭션 진입 전 `ProcessedCursorError`), (2) 각 기록은 `(저장된 processedSeq, 새 processedSeq]` 창 안에 있어야 함, (3) `#markProcessed` 직후 `#assertCursorEarned`가 그 창의 inbox 행 중 `processed_at IS NULL`이 하나라도 있으면 거부. 행이 아예 없는 seq(롤백으로 소진된 번호, T13이 지운 행)는 통과시킨다. 새 `ProcessedCursorError`. 회귀 테스트 6건(`db/state.test.ts`): 리뷰어 재현 그대로 거부되고 `drainFromRecoveryCursor(10)`가 `[1]`을 계속 돌려주는지, 창 중간 간격(2 누락) 거부, 창 밖 기록 거부, 역순·중복 기록 거부, 행이 사라진 seq는 통과, 그리고 **재시작 회귀**: 3행 중 2행만 처리하고 재오픈하면 `drainFromRecoveryCursor(10) === [3]`. 커서와 행을 한 트랜잭션에서 읽는 `drainFromRecoveryCursor(limit)`를 추가했다(§7.3(3)이 요구하는 drain 지점을 호출자가 틀리게 조합할 여지를 없앰) |
| **[blocker] `apps/server/package.json:20`** — 이 Windows 호스트에서 clean `npm ci`가 `node-gyp rebuild`로 떨어져 실패(Windows SDK 없음). 티켓의 "소스 빌드 불필요" 주장이 거짓 | **고침 9266cbd**. 원인은 rate limit/네트워크/ABI가 **아니다**(better-sqlite3 13.0.3에는 install script도 `prebuild-install` 의존도 없다 — 다운로드 시도 자체가 없음). 실제 원인: npm이 `binding.gyp`를 보고 `install: node-gyp rebuild`를 **주입**한다. 패키지는 `"gypfile": false`로 이를 막으려 하지만 npm의 install 경로가 쓰는 manifest(lockfile 항목, 축약 packument) 어디에도 `gypfile`이 없어 `undefined !== false`로 판정된다(근거: 위 "Sources consulted"의 arborist·run-script 소스 인용). 해결: 저장소 `.npmrc`에 `ignore-scripts=true` → tarball에 들어 있는 prebuild가 실제로 쓰이는 바이너리가 된다. `scripts/check-install-scripts.mjs`(`npm run lint`에 연결)가 (a) lockfile에 allowlist 밖의 `hasInstallScript` 패키지가 생기면, (b) 이 플랫폼용 prebuild가 로드되지 않으면 실패시켜 이 설정이 조용히 다른 task를 깨뜨리지 못하게 한다. 검증 로그는 아래 "Gates" 참조. Windows SDK 설치는 요구하지 않는다 |
| **[major] `db/migrate.ts:115`** — 체크섬 검증이 존재하는 파일만 순회하므로 적용된 파일을 지우면 그 마이그레이션의 감사가 조용히 꺼진다. 리뷰어 재현: `001_probe.sql` 적용 후 삭제 → `migrate()` 성공(`alreadyApplied:[1]`) | **고침 429bb8c**. 감사를 **기록 기준**으로 돌린다: `schema_migrations`의 모든 행이 로드된 파일 집합에 같은 `version`·`name`으로 있어야 하고, 없으면 `applied migration N (name) has no file in <dir>`, 이름이 바뀌었으면 `recorded as X but the file is now Y`로 하드 실패. 회귀 테스트 2건(`db/migrate.test.ts`): 삭제·리네임 각각 |
| (추가, 리뷰 지적 아님) T1b(PR #7, A-17)가 round 1 작업 중 main에 머지 | **고침 72547d5**. `Effect`에 `cause`(`{kind:'event',eventKey}` \| `{kind:'deadline',deadlineKind,deadlineId?}`) 판별자가 생기고 `causedByEventKey`가 nullable이 됐다. `effect_outbox`에 `cause_kind`·`cause_deadline_kind`·`cause_deadline_id`를 추가하고 `caused_by_event_key`를 nullable로 바꿨으며, 계약의 두 규칙(cause↔key 일치, 유료 effect는 event 유래만)을 테이블 CHECK로도 강제한다. 테스트 4건 추가(타이머 유래 round-trip, `deadlineId` 없는 경우, 유료+deadline 거부, key 불일치 거부). **`002`를 새로 만들지 않고 `001_initial.sql`을 고쳤다**: 이 PR은 아직 머지되지 않아 001이 어디에도 적용된 적 없고 `data/*.db`는 gitignore 대상이다. 러너의 "적용된 파일 수정 금지" 규칙은 머지 이후부터 적용된다(그때부터는 `002`가 유일한 길) |
