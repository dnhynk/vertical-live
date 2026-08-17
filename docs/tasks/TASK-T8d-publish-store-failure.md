# TASK-T8d-publish-store-failure

- Task: T8d 엔진 버그픽스 — `#publish`의 `markEffectPublished` store 실패로 committed effect가 재시작까지 미발행 (`docs/tasks/TASK_SPECS.md` §T8, 공통 규약)
- Branch: `dnhynk/t8d-publish-store-failure` · PR: #22
- Orca: task `task_43eb61f3968d` · dispatch `ctx_f8e5bd22e56b`
- Spec sections read: §7.3(3)(6)(7)(8), §7.5, §9.1, §9.2, §11("disk-full", "상태 복구", "유료 무결성")
- BOARD decisions/assumptions relied on: A-5(SQLite 단일 파일·WAL), A-19(store 실패 → `writer_failing` → 엔진 restart → 소진 시 `safe_stopped`), E-5(GitHub Actions 결제 차단 → CI 실행 불가)

## Goal

T8c(PR #21) 리뷰 round 2가 관측만 하고 범위 밖으로 남긴 결함을 고친다: `StateEngine.#publish()`는 `commitStateTransition`이 반환한 **뒤** 별도 트랜잭션으로 `markEffectPublished()`를 부르고 `#openEffects.set`은 그 다음 줄이다. 그 쓰기가 거부되면(예: `SQLITE_FULL`) effect row는 `published_at NULL`로 커밋된 채 in-memory 어디에도 없고 — 재전송 대상도, 만료 대상도, 건강 보고 대상도 아니고 렌더러에 나가지도 않은 채 — 재시작이 `#adoptRecoveredEffect`로 주워 갈 때까지 남는다. 유료 감사 연출이 24시간 무인 운영에서 재시작 전까지 지연되는 것은 §9.2("degraded로 계속 돌되 무엇이 왜 멈췄는지 알 수 있어야 한다")·§7.3(7)에 어긋난다. T8c B1(expiry)·ACK와 **같은 모양의 결함**이며, 고친 뒤에는 (a) 미발행 row가 in-memory 재시도 대상으로 남고, (b) 실패가 엔진 건강으로 표면화돼 T12가 A-19 정책으로 처리하며, (c) 공간이 확보되면 **재시작 없이** 다음 pass가 발행하고 렌더러 ACK가 기록된다.

## Hypothesis → observation → fix (`~/.claude/CLAUDE.md` 디버깅 절차)

**1. 원인 가설**

`apps/server/src/engine/engine.ts:1121` `#publish()`는

```ts
for (const effect of effects) {
  this.#store.markEffectPublished(effect.effectId, publishedAt)   // (1) 영속화
  this.#openEffects.set(effect.effectId, { effect, lastSentAt })  // (2) 그다음 in-memory
  this.#publisher.publishEffect(effect)                           // (3) 그리고 발행
}
```

이고 `#adoptRecoveredEffect()`(`:1142`)는 반대로 (2)를 먼저 한 뒤 (1)을 한다. (1)이 던지면 `#publish`는 (2)(3)에 도달하지 못한 채 `#applySteps` → `#runPending` 밖으로 나가고 `pump()`가 잡는다. 그런데 **`commitStateTransition`은 이미 커밋됐다**: effect row는 `published_at NULL`로 존재하고, `#openEffects`에는 없다. `#sweepEffects`는 `#openEffects`만 돌므로 재전송·만료가 없고, `#unrecordedEffects` latch에도 없으므로 건강에도 안 남는다(다음 pass가 성공하면 `#consecutiveFailures`는 0으로 돌아간다 — T8c round 1이 이미 증명한 진동). 즉 **committed·미발행 effect가 조용히 사라진다.**

`#adoptRecoveredEffect`는 더 나쁘다: `markEffectPublished`가 가드 없이 `start()` 안에서 돌기 때문에, 미발행 row가 있는 상태에서 디스크가 차 있으면 **`start()` 자체가 던진다**. A-19가 이 결함을 engine restart로 라우팅하므로 재시작 시도마다 같은 자리에서 던진다.

**2. 이 가설을 반증할 관측**

실제 SQLite 파일 위에서 프로덕션 커넥션의 페이지 예산을 소진시켜(`PRAGMA max_page_count`, T8c/T15와 같은 방법) 실제 `SQLITE_FULL`을 만든다.

- 가설이 **맞다면**: `markEffectPublished`가 실제 `SQLITE_FULL`로 거부되고, 그 row는 `published_at NULL`인데 `health().openEffectCount`·`consecutiveFailures`에 잡히지 않으며, 공간을 확보해도 다음 pass가 그 row를 발행하지 않는다. `#adoptRecoveredEffect` 쪽은 `start()`가 던진다.
- 가설이 **틀리다면**: 거부가 0건이거나, 거부돼도 어딘가가 그 row를 다시 줍는다. 그러면 원인은 다른 곳이다.

**3. 관측 결과** → `## Result`의 "재현 관측" 절.

**4. 수정**은 관측이 가설을 확인한 뒤에만 한다.

## Plan

1. 티켓(이 파일) 커밋·push.
2. **재현 테스트 먼저**(수정 전 실패) — `apps/server/src/engine/publish-store-failure.test.ts` 신설. T8c `ack-store-failure.test.ts`와 같은 방법으로 프로덕션 커넥션을 잡고(`vi.mock('../db/open.js')`) `VACUUM` + `max_page_count = page_count`로 실제 `SQLITE_FULL`을 만든다.
   - (A) 라이브 commit 경로: 커밋과 mark 사이에 store가 쓰기를 거부하는 순간(= 프로덕션의 실제 레이스). 무료·유료 effect 각각에 대해 uncaught 0 · row `published_at NULL` · 렌더러 미전송 · health `writer_failing` → 공간 확보 후 **다음 pass**가 발행 → 렌더러 ACK가 `acked_at` 기록 → health 0. **정정(측정 후, 아래 "재현 관측 (2) 왜 라이브 경로는 disk-full로 재현되지 않는가")**: 이 자리의 거부는 `SQLITE_FULL`로 만들 수 없어 §11 fault matrix의 다른 쓰기 거부 행인 **"DB lock"**(두 번째 커넥션이 write lock 보유 → `SQLITE_BUSY`)으로 만든다. disk-full은 (B)가 담당한다.
   - (B) 복구 경로: 커밋 뒤 발행 전에 죽은 뒤 남는 durable 상태(미발행 row)에서 가득 찬 파일로 `start()` — 던지지 않고, 전송하지 않고, latch에 남고, 공간 확보 후 다음 pass가 발행한다.
   - (C) e2e: 실제 HTTP 서버 + 실제 `/ws/renderer` 클라이언트. `uncaughtException` 0, `/health`가 계속 응답하며 실패를 말한다, 렌더러는 미발행 effect를 받지 않는다, 공간 확보 후 받고 ACK하면 `acked_at`이 기록된다(= mark-first가 `markEffectAcked`의 "미발행 ACK 거부" 계약을 지킨다).
3. **수정 — `apps/server/src/engine/engine.ts` 발행 경로만**: 코디네이터 권고안 **mark-first**.
   - `#publish()`: effect를 `#openEffects`에 `published: false`로 먼저 담고 `markEffectPublished`를 시도한다. 성공해야만 `published = true` · `publishEffect()` · 지연 계측. 거부되면 보내지 않고 `#recordPublishFailure()`로 T8c와 같은 latch(`#unrecordedEffects`)에 실어 `EngineHealth.consecutiveFailures` 합산 → A-19.
   - `#sweepEffects()`: 이미 pass마다 도는 루프이므로 미발행 effect의 mark를 여기서 재시도한다(= "pass마다 줍는다"). 창이 닫힌 미발행 effect는 기존 만료 분기가 그대로 처리한다(store-first, T8c B1).
   - `#adoptRecoveredEffect()`: 같은 순서로 뒤집어 `start()`가 store 실패로 던지지 않게 한다.
   - `onRendererHello()`: 미발행 effect는 재전송하지 않는다(보내면 그 ACK는 `EffectNotPublishedError`로 거부된다).
4. 게이트 5개 로컬 실행(CI는 E-5로 불가 — PR에 명시), PR 1개, `worker_done`.

### 설계 판단 — 왜 mark-first인가 (§7.3(7)·유료 "정확히 한 번"과의 정합성)

권고안이 코드와 맞는지 먼저 확인했고, 맞는다:

- **`markEffectAcked`의 계약**(`db/store.ts:837`)이 `published_at IS NULL`인 row의 ACK를 `EffectNotPublishedError`로 거부한다. 그래서 "발행은 하되 기록은 나중에"(send-first)는 성립하지 않는다 — 렌더러가 실제로 연출해도 그 ACK가 기록되지 않고, 유료 effect는 §9.2 대체 감사 연출 판정(`#settleAcknowledgedFallback`이 `acked_at`을 authority로 읽는다)에서 "연출되지 않음"으로 취급돼 **두 번째 연출**이 나갈 수 있다. mark-first는 이 창을 없앤다.
- **mark-first의 위험은 반대 방향뿐이다**: 기록은 됐는데 프레임이 못 나간 채 죽는 경우. 그건 §7.3(7)이 이미 정의한 상태다 — `listUnackedEffects()`가 `acked_at IS NULL AND expired_at IS NULL` row를 돌려주고 재시작이 재전송한다. 렌더러는 같은 `effectId`를 다시 받아도 재시작하지 않으므로(§7.3(7)) 이중 연출이 아니다. T15의 F-16/F-17 crash drill(`tools/soak/src/injection/crash-child.ts:116`)이 이미 "`markEffectPublished` commit 직후 `publishEffect` 진입점"을 그 창으로 명시하고 있어, mark → send 순서는 이 저장소가 이미 가정하던 순서다(이 수정은 실패 처리만 바꾸고 성공 경로의 외부 관측 순서는 그대로 둔다).
- **미발행 effect를 `#openEffects`에 `published: false`로 담는 이유**: 재시도 큐와 만료 대상이 같은 자료구조여야 창이 닫힌 미발행 effect가 §7.3(7)대로 `expired`가 되고 §9.2 대체 연출 경로로 넘어간다. 별도 map을 두면 만료 로직을 복제해야 하고, 디스크가 오래 차 있으면 창이 지난 effect를 뒤늦게 발행하게 된다. `openEffectCount`는 "미결 outbox row 수"라는 뜻이 유지된다.
- **건강 표면은 T8c와 동일**하게 `#unrecordedEffects` latch에 합산한다. 새 `EngineHealth` 필드도 새 degraded 토큰도 만들지 않으므로 `supervisor/*`는 한 줄도 바뀌지 않고 A-19가 그대로 적용된다. 원인 구분은 `/metrics` `effect_publish_store_failed`와 로그 `engine.publish_store_failed`(kind·code)로 남긴다.
- **A-19와의 정합**: 미발행 effect가 남아 있는 동안 `writer_failing`이 유지되므로 engine restart → 예산 소진 → `safe_stopped`(F-12 → F-18)로 간다. 이번 수정은 그 경로에서 `start()`가 던지지 않게 만들어(adopt도 mark-first) 재시작이 **정책대로** 소진되게 한다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| `PRAGMA max_page_count` | https://sqlite.org/pragma.html#pragma_max_page_count | 2026-08-18 | 파일 페이지 상한. 커넥션 설정이며 파일에 저장되지 않는다 → 프로덕션 커넥션에 직접 걸어야 실제 `SQLITE_FULL`이 난다(T8c·T15와 동일) |
| SQLite 결과 코드(`SQLITE_FULL`) | https://sqlite.org/rescode.html | 2026-08-18 | `db/errors.ts`의 접두 분류(`SQLITE_FULL*` → `disk_full`)가 그대로 적용된다. 새 분류를 추가하지 않았다 |
| Node `uncaughtException` | https://nodejs.org/api/process.html#event-uncaughtexception | 2026-08-18 | 핸들러가 없으면 예외 출력 후 프로세스 종료. e2e 테스트는 핸들러를 달아 "유출 0"을 직접 센다 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 — 권고안(mark-first)이 코드·스펙과 정합함을 위 "설계 판단"에서 확인했으므로 묻지 않았다 | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 미발행 effect의 재시도 창 | effect 창(`endsAt` + `expiryGraceMs`) 안에서만 | — | T8c의 ACK 재시도와 같은 창. 창이 지나면 §7.3(7)대로 `expired`가 되고 §9.2 대체 감사 연출이 그 경로를 맡는다. 창 밖으로 늘리면 지난 연출을 뒤늦게 내보내고 두 정책이 충돌한다 |

## Result

### 재현 관측 (1) — 가설 확인 (수정 전, 2026-08-18)

`apps/server/src/engine/publish-store-failure.test.ts`(4건)를 먼저 쓰고 **수정 전** 엔진(`git checkout HEAD~1 -- apps/server/src/engine/engine.ts`)에서 실행했다.

```text
$ npx vitest run apps/server/src/engine/publish-store-failure.test.ts
 ❯ apps/server/src/engine/publish-store-failure.test.ts (4 tests | 4 failed)
     × keeps a paid effect retriable, off the wire and on the health surface
     × keeps a free effect retriable too
     × starts, reports the fault and publishes when space comes back
     × shows the renderer nothing until the row is written, then everything

 FAIL  … > keeps a paid effect retriable …
AssertionError: expected 1 to be 2      // openEffectCount vs listUnackedEffects().length
 ❯ publish-store-failure.test.ts:254  expect(degraded.openEffectCount).toBe(harness.store.listUnackedEffects().length)

 FAIL  … > keeps a free effect retriable too
AssertionError: expected [ 'e2_0', 'e2_1' ] to have a length of +0 but got 2   // 공간이 돌아와도 발행되지 않음

 FAIL  … > starts, reports the fault and publishes when space comes back
SqliteError: database or disk is full
 ❯ PersistenceStore.markEffectPublished apps/server/src/db/store.ts:823:17
 ❯ StateEngine.#adoptRecoveredEffect apps/server/src/engine/engine.ts:1144:48
 ❯ StateEngine.start apps/server/src/engine/engine.ts:317:54

 FAIL  … > shows the renderer nothing until the row is written, then everything
Error: timed out waiting for a condition   // 렌더러가 그 effect를 끝내 받지 못함
```

가설이 그대로 확인됐다: (1) `markEffectPublished`가 실제 store 실패로 거부되면 outbox row는 커밋된 채 `published_at NULL`로 남고 **in-memory 어디에도 없다**(`openEffectCount 1` vs 미결 row 2건), (2) 무관한 pass 하나가 완료되면 `consecutiveFailures`가 0으로 돌아가 건강 표면에서도 사라진다, (3) 공간·락이 풀려도 그 row는 발행되지 않는다(재시작 전까지), (4) 미발행 row가 있는 상태로 가득 찬 파일에서 재시작하면 `#adoptRecoveredEffect`가 `start()` 밖으로 던진다 — A-19가 이 결함에 붙이는 engine restart가 매번 같은 자리에서 죽는다. 반증(거부돼도 어딘가가 그 row를 줍는다)은 관측되지 않았다.

수정 후 같은 파일: `Test Files 1 passed (1) / Tests 4 passed (4)`.

### 재현 관측 (2) — 왜 라이브 경로는 disk-full로 재현되지 않는가 (측정)

코디네이터 명세의 재현 레시피는 "`max_page_count`로 프로덕션 연결을 채운 뒤 유료/무료 effect를 낳는 전이 commit → mark 거부"였다. **그 순서로는 mark가 거부되지 않는다.** 테스트를 쓰기 전에 실제로 측정했다(스크래치 테스트, 커밋하지 않음):

| 픽스처 | 관측 |
|---|---|
| `VACUUM` 후 `max_page_count = page_count + slack`(slack 0·1·2·4·8·16·32·40·60·80·120·200·400), 유료 이벤트 60~300건 | 예산 안에서 **커밋된 effect row 223건 전부** `published_at` 기록 성공, mark 거부 **0건**. 예산이 닿으면 거부되는 것은 항상 *commit*(pass 실패)이고 mark는 아예 실행되지 않는다 |
| outbox에 200건이 이미 있는 상태에서 **커밋이 반환하는 순간** `VACUUM`+cap | 그 커밋의 mark도 기록 성공(거부 0건) |
| 같은 가득 찬 파일에서 **이미 packed된** row 201건의 `published_at`을 갱신 | **133건 실제 `SQLITE_FULL` 거부**, 68건 성공 |

이유는 스키마에 있다: `published_at`은 방금 자기 commit이 insert한 row의 in-place 갱신이고, 그 row는 테이블 b-tree의 **마지막** 자리(= `VACUUM`이 남긴 여유 있는 leaf)에 있다. `max_page_count`가 거부할 수 있는 것은 **새 페이지 할당**뿐인데, 그 갱신은 새 페이지를 필요로 하지 않는다(형제 leaf가 모두 꽉 찼을 때만 필요하다). T8c의 ACK 거부가 통했던 것은 그 row들이 이미 packed된 오래된 row였기 때문이다.

그래서 테스트는 §11 fault matrix의 **쓰기 거부 두 행을 각각 통하는 자리에** 쓴다:

- **"DB lock"** — 두 번째 커넥션이 `BEGIN IMMEDIATE`로 write lock을 잡아 프로덕션 연결의 다음 쓰기가 `busy_timeout`(250ms) 뒤 `SQLITE_BUSY`가 된다. 라이브 `#publish` 경로는 이걸로 몬다(어떤 쓰기든 거부되므로 결정적).
- **"disk-full"** — packed된 미발행 row를 재시작이 다시 읽는 자리(`#adoptRecoveredEffect`·pass 재시도)는 실제 `SQLITE_FULL`(`max_page_count`) 그대로다.

`classifySqliteError`가 둘을 `busy`/`disk_full`로 분류하고 엔진은 둘을 같은 경로로 처리하므로(= store가 단일 writer의 쓰기를 거부했다), 두 테스트는 같은 결함의 두 진입점을 덮는다. 어느 쪽도 예외를 흉내 내지 않는다 — 실제 store, 실제 트랜잭션, 실제 SQLite 오류다.

### 수정 (`b26040f`, `58d391a`)

`apps/server/src/engine/engine.ts`만 바꿨다(supervisor 프로덕션 코드 변경 0, `packages/contract` 변경 0).

| 자리 | 변경 |
|---|---|
| `#publish()` | effect를 `#openEffects`에 `published:false`·`committedAt`과 함께 **먼저** 담고 `#sendEffect()`에 넘긴다 |
| `#sendEffect()` (신설) | `markEffectPublished` → 성공해야만 `published=true`·latch 해제·`publishEffect()`·`recordPublish` 계측·`effect_published`. `UnknownEffectError`는 갚을 쓰기가 없으므로 드롭·카운트(`effect_publish_unknown`), 그 외는 `#recordPublishFailure()` 후 **보내지 않는다** |
| `#recordPublishFailure()` (신설) | `#unrecordedEffects` latch에 싣고 `lastFailure`·`/metrics` `effect_publish_store_failed`·로그 `engine.publish_store_failed`(kind·code·retryable) |
| `#sweepEffects()` | 만료 분기 다음에 "미발행이면 mark 재시도" 분기 추가 = **pass마다 재시도**. 렌더러 유무와 무관하게 시도한다(row가 있어야 ACK가 가능하므로) |
| `#adoptRecoveredEffect()` | 같은 store-first 경로를 쓴다 → 가득 찬 디스크에서 `start()`가 더 이상 던지지 않는다(A-19 재시작이 예산을 정상적으로 쓴다) |
| `onRendererHello()` | 미발행 effect는 재전송하지 않는다 |

새 `EngineHealth` 필드도 새 degraded 토큰도 없다. `#unrecordedEffects`가 "publish·ACK·expiry 중 store가 아직 받지 않은 쓰기를 진 열린 effect"로 확장됐고, `consecutiveFailures`는 그대로 그 합이다 → `supervisor/*` 0줄 변경, A-19 정책 그대로.

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 재현 테스트가 수정 전 실패·수정 후 통과 | met | 위 "재현 관측 (1)": 수정 전 4/4 실패(각 실패 지점 인용), 수정 후 `Tests 4 passed (4)` |
| 2 | 실제 SQLITE_FULL로 `markEffectPublished` 거부 | met | `unpublished rows read back on a full disk (§11 "disk-full")`: `PRAGMA max_page_count`로 프로덕션 커넥션을 채워 201건 중 다수가 실제 `SQLITE_FULL`로 거부됨(테스트가 "거부 ≥1 & 기록 ≥1"을 스스로 단언). 라이브 commit 경로는 disk-full로 재현 불가(측정: 위 (2)) → §11 "DB lock"(`SQLITE_BUSY`)로 같은 자리를 몬다 |
| 3 | uncaught 0 | met | `a refused publish mark, over /ws/renderer`: 실제 HTTP 서버 + 실제 `/ws/renderer` 클라이언트, `process.on('uncaughtException')` 수집 **0건**(거부 시점과 복구 후 두 번 단언), `GET /health`가 계속 응답 |
| 4 | row `published_at NULL` · 렌더러 미전송 | met | 같은 파일 4개 테스트 전부: `listUnackedEffects().filter(publishedAt === null)`이 거부분과 일치하고, `publisher.uniqueEffectIds`(엔진 단위)·렌더러가 실제로 받은 `seen`(WS)에 그 id가 **없다** |
| 5 | health degraded | met | `openEffectCount === listUnackedEffects().length`(수정 전 1 vs 2로 실패), `consecutiveFailures ≥ 거부 건수`, `degradedReasons`에 `writer_failing`, 실제 `HealthAggregator`(T12) 판정 `{degraded, writer_failing}`, `/metrics` `effect_publish_store_failed`. **무관한 성공 pass 뒤에도 유지**된다(R-T8c-1과 같은 진동 검사) |
| 6 | 공간(락) 확보 후 다음 pass에서 발행·ACK·해제 | met | 재시작·재수신 없이 다음 `pump()`가 `published_at`을 기록하고 effect가 전송된다 → 렌더러 ACK가 `acked_at`을 기록(그 전 ACK는 거부되는 것도 단언 = mark-first가 필요한 이유) → `consecutiveFailures 0`·`writer_failing` 해제·coordinator `ok` |
| 7 | 기존 T8/T11/T15/T8c 테스트 회귀 없음 | met | `npm run test` → 138 files, 1884 passed, 1 skipped(기존 skip). 이전 main은 137 files/1880 passed — 늘어난 4건이 이 티켓의 테스트다 |
| 8 | (선택 b) F-12 drill의 `pauseEffectAcks` 제거 | met (제거함, `dc28e54`) | 디스크가 찬 동안에도 ACK가 흐르는 상태로 F-12가 그대로 `degraded`·safe-stop 없음·공간 확보 후 `live` 복귀. `npx vitest run tools/soak/src/matrix/matrix.test.ts` → 20 passed, `npm run soak:ci` → `verdict: PASS`. 다른 호출자가 없어 `pauseEffectAcks`/`resumeEffectAcks`와 플래그도 함께 제거했다 |
| 9 | 게이트 5개 로컬 통과 | met | 아래 Gates. CI는 BOARD **E-5**(GitHub Actions 결제 차단)로 실행 불가 |

### Gates (executed)

`git fetch origin && git rebase origin/main`(389fde6 = T8c 머지 후 BOARD 커밋 포함) 후 실행:

```text
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports);
                        check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)
npm run typecheck    -> tsc --build tsconfig.json (오류 없음)
npm run test         -> Test Files 138 passed (138) / Tests 1884 passed | 1 skipped (1885)
npm run build        -> contract·renderer·server·simulator·soak 빌드 성공,
                        copied 5 migration(s) to dist/db/migrations, docs/ops/data-map.md up to date
npm run soak:ci      -> verdict: PASS (freezeEvents=5, 전부 주입된 drill 중;
                        invariants 5/5 ok, finalState=live)  [선택 b 검증용]
```

CI: **실행하지 않았음 — BOARD E-5**(GitHub Actions 결제 차단으로 모든 run이 2초 만에 실패). 위 로컬 결과가 근거다.

## Not done / out of scope

- `apps/server/src/supervisor/*`는 한 줄도 바꾸지 않았다. A-19가 이 실패 부류의 정책을 이미 정했고, 새 `EngineHealth` 필드나 새 degraded 토큰은 T12 계약 변경이다. T8c가 A-19 정책을 실제 `Supervisor`로 e2e 검증해 두었고(같은 latch·같은 필드), 이번 변경은 그 latch에 세 번째 종류의 미기록 쓰기를 더할 뿐이라 그 e2e를 복제하지 않았다.
- `packages/contract` 변경 0(`[contract]` task 아님). DB 스키마·마이그레이션 변경 0.
- 라이브 `#publish` 경로를 `SQLITE_FULL`로 모는 테스트는 **만들 수 없다**(위 측정). 만들려면 방금 insert된 row가 packed된 leaf에 놓이도록 픽스처가 페이지 내부 바이트를 조작해야 하는데, 그건 실제 결함보다 SQLite 내부 사정을 시험하는 테스트가 된다.
- 미발행 effect의 재시도 창을 effect 창 밖으로 늘리지 않았다(Assumptions 표). 창이 지나면 기존 만료 분기가 §7.3(7)대로 `expired`를 기록하고 §9.2 대체 감사 연출이 그 경로를 맡는다 — 지난 연출을 뒤늦게 내보내지 않는다.
- 렌더러 hub(`publisher.ts`)는 건드리지 않았다. T8c가 이미 프레임 핸들러 백스톱을 넣었고, 이 결함은 writer pass 안에서 일어나 `pump()` 아래에 있다.

## Follow-ups

- `#reconcileInteraction()`은 커밋이 실패해도 `#interactionEnabled`를 먼저 바꾼다(`engine.ts:1240` 부근). 그래서 store가 거부하는 동안 CTA 스위치가 in-memory에서만 뒤집히고 snapshot은 갱신되지 않은 상태가 생긴다 — T8 때부터 있던 동작이고 이 티켓 범위 밖이라 손대지 않았다. 고치려면 "커밋 성공 후에만 플래그 전환"으로 뒤집어야 하는데, 그 pass가 실패로 끝나는 경로와 함께 봐야 해서 T8 소유의 별도 판단이 필요하다.
- `#unrecordedEffects` latch의 나머지 절반(writer pass 실패의 진동)은 T8c `## Follow-ups`에 적힌 대로 여전히 남아 있다(pass 실패는 다음 pass가 성공하면 사라지는 것이 정의). 이번 변경은 publish 실패를 sticky한 절반에 넣었을 뿐이다.
