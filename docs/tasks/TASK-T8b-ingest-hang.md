# TASK-T8b-ingest-hang

- Task: T8b 엔진 버그픽스 — `POST /ingest/simulator`가 inbox write 예외 시 응답 없이 hang (`docs/tasks/TASK_SPECS.md` §T8, 공통 규약)
- Branch: `dnhynk/t8b-ingest-hang` · PR: #<n>
- Orca: task `task_f1aeb51337bf` · dispatch `ctx_8691c39fdcf8`
- Spec sections read: §7.3(2), §9.2, §10.2, §11("DB lock"), §12.3
- BOARD decisions/assumptions relied on: A-5(SQLite 단일 파일·WAL), A-14(공용 규격), E-5(GitHub Actions 결제 차단 → CI 실행 불가)

## Goal

T15(PR #18)이 fault matrix drill 중 발견한 결함을 고친다: `POST /ingest/simulator`가 inbox write에서 예외(실측 `SQLITE_BUSY`)를 만나면 **HTTP 응답을 하나도 보내지 않고** 연결이 열린 채 남는다. 24시간 무인 운영에서 주입 경로가 조용히 멈추는 것은 스펙 §9.2("무엇이 왜 멈췄는지 알 수 있어야 한다")에 어긋나고, 호출자(T11 시뮬레이터·T15 soak·dev 패널)는 타임아웃 워크어라운드를 갖게 된다. 모든 예외 경로에서 이유 코드가 붙은 HTTP 응답(503/500)을 돌려주고, unhandled rejection을 0으로 만든다.

## Hypothesis → observation → fix (~/.claude/CLAUDE.md 디버깅 절차)

**1. 원인 가설**

`apps/server/src/server.ts:262`의

```ts
void readJsonBody(req).then(
  (body) => { /* … ingest.handle(...) … */ },
  () => { /* body 파싱 실패 */ },
)
```

에서 두 번째 인자(onRejected)는 **`readJsonBody(req)` 자신의 rejection만** 처리한다. `ingest.handle()`이 던지면 그 예외는 `.then()`이 만든 **새 promise**를 reject 시키는데, 그 promise는 `void`로 버려져 아무도 처리하지 않는다 → (a) `res`는 `writeHead`/`end`를 못 받고 열린 채 남아 클라이언트가 hang, (b) Node가 `unhandledRejection`을 발생시킨다.

`ingest.handle()`이 던지는 실제 경로: `inbox.ingest()` → `StateEngine.ingest()` → `PersistenceStore.commitIngestBatch()`. SQLite는 단일 writer이므로 다른 커넥션이 write lock을 잡고 있으면 `busy_timeout` 경과 후 `SQLITE_BUSY`를 던진다(`apps/server/src/db/locking.test.ts`가 이미 실증). 스펙 §11 fault matrix "DB lock" 행이 그 상황이다.

**2. 이 가설을 반증할 관측**

실제 HTTP 서버를 띄우고, 두 번째 커넥션이 `BEGIN IMMEDIATE`로 write lock을 잡은 상태에서 `POST /ingest/simulator`를 보낸다.

- 가설이 **맞다면**: fetch가 응답을 받지 못하고(2초 abort), 그 사이 `unhandledRejection`이 1회 이상 발생하며 그 error의 `code`가 `SQLITE_BUSY*`다.
- 가설이 **틀리다면**: 어떤 상태 코드든 응답이 온다(예: 500). 그러면 원인은 다른 곳이다.

**3. 관측 결과** → `## Result`의 "재현 관측" 절에 명령·출력을 기록한다.

**4. 수정**은 관측이 가설을 확인한 뒤에만 한다.

## Plan

1. 티켓(이 파일) 커밋·push. (완료)
2. **재현 테스트 먼저**(수정 전 실패해야 한다):
   - `apps/server/src/engine/ingest.test.ts`에 HTTP 레벨 describe 추가 — `createServer({ ingest })`를 실제 포트에 띄우고, `openDatabase()`로 연 두 번째 커넥션이 `BEGIN IMMEDIATE`로 write lock을 잡은 채 `POST /ingest/simulator`를 보낸다. `AbortSignal.timeout()`으로 hang을 실패로 만든다. `process.on('unhandledRejection')`으로 유출 건수를 센다.
   - 같은 파일에 endpoint 단위 테스트: inbox가 `SQLITE_BUSY`를 던지면 503, 비-SQLite 예외면 500, 응답 본문에 예외 메시지·경로·원문이 없다.
3. **수정 A — `apps/server/src/engine/ingest.ts`**: `inbox.ingest()` 호출을 try/catch로 감싸고 `classifySqliteError()`(T4 `db/errors.ts`, 이미 존재)로 분류해 응답으로 바꾼다.
   - `retryable`(= `busy`/`locked`) → `503 {error:'ingest_unavailable', reason:'db_busy'|'db_locked'}` — 같은 요청을 그대로 다시 보내면 성공할 수 있다는 뜻.
   - 그 외 SQLite 실패 → `500 {error:'ingest_failed', reason:'db_disk_full'|'db_corrupt'|'db_io'|…}`.
   - 비-SQLite 예외 → `500 {error:'ingest_failed', reason:'internal'}`.
   - 이유 코드는 `SQLITE_*` 분류에서 나온 **고정 어휘**만 쓴다. 예외 메시지·스택·요청 본문은 응답에 넣지 않는다(§12.3, 비밀 미노출).
4. **수정 B — `apps/server/src/server.ts`**: `.then(onFulfilled, onRejected)` 뒤에 `.catch()`를 달아, 핸들러 안에서 던져진 어떤 예외도 응답 없이 끝나지 않게 한다(`500 {error:'internal_error'}`, 이미 헤더가 나갔으면 `res.end()`). 같은 두 줄 구문을 쓰는 `POST /admin/kill`에도 같은 net을 적용한다(범위 판단은 아래 참조).
5. 게이트 5개 로컬 실행(CI는 E-5로 불가 — 티켓·PR에 명시), PR 생성, `worker_done`.

### 범위 판단 (`/admin/kill`을 함께 고치는 이유)

지시받은 범위는 `/ingest/simulator`다. `/admin/kill`은 **같은 함수 안의 동일한 `void readJsonBody(req).then(...)` 구문**이며 같은 방식으로 hang한다(`adminKill.handle()`이 supervisor kill을 동기 호출한다). 수정 B가 공용 helper 1개이므로 두 번째 호출부에 적용하는 비용은 1줄이고, 알면서 같은 hang을 남기는 편이 더 나쁘다고 판단했다. 라우팅 규칙·상태 코드·인증은 건드리지 않는다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| SQLite 결과 코드(`SQLITE_BUSY`, 확장 코드) | https://sqlite.org/rescode.html | 2026-08-18 | `db/errors.ts`의 분류(접두 매칭)가 근거로 삼은 문서와 동일. 새 분류를 추가하지 않고 그대로 사용 |
| `Promise.prototype.then`의 두 번째 인자 범위 | https://tc39.es/ecma262/#sec-promise.prototype.then | 2026-08-18 | onRejected는 **호출 대상 promise**의 rejection만 받는다. onFulfilled 안의 throw는 `then`이 반환한 promise를 reject한다 → 별도 `catch` 필요 |
| Node `unhandledRejection` | https://nodejs.org/api/process.html#event-unhandledrejection | 2026-08-18 | 처리되지 않은 rejection은 프로세스 이벤트로 관측 가능 → 테스트에서 "유출 0"을 직접 검증 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| lock 경합 시 상태 코드 | 503 | — | `SqliteFailure.retryable`의 의미("같은 문장을 그대로 재시도하면 성공할 수 있다")와 정확히 대응. 스펙에 값이 없어 T8b 명세("503/500 + 이유 코드")를 따랐다 |
| 그 외 write 실패 상태 코드 | 500 | — | 재시도해도 같은 실패이므로 호출자에게 재시도를 권하지 않는다 |

## Result

<채워짐 — 아래>

## Not done / out of scope

- <채워짐>

## Follow-ups

- <채워짐>
