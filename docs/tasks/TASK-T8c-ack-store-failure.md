# TASK-T8c-ack-store-failure

- Task: T8c 엔진 버그픽스 — 렌더러 ACK 경로의 store 실패가 uncaught throw로 프로세스를 죽인다 (`docs/tasks/TASK_SPECS.md` §T8, 공통 규약)
- Branch: `dnhynk/t8c-ack-store-failure` · PR: #21
- Orca: task `task_658a5641bf1c` · dispatch `ctx_2313b56ee0d2`
- Spec sections read: §7.3(6)(7), §7.5, §9.2, §9.4(2)(4), §10.2, §11("disk-full", "상태 복구")
- BOARD decisions/assumptions relied on: A-5(SQLite 단일 파일·WAL), A-14(공용 규격), E-5(GitHub Actions 결제 차단 → CI 실행 불가)

## Goal

T15(PR #18)의 F-12 disk-full drill이 발견한 결함(F-T15-1)을 고친다: 렌더러가 `ack_effect` 프레임을 보내면 `RendererHub`의 WebSocket `message` 핸들러가 `StateEngine.onAckEffect()`를 부르고, 그 안의 `store.markEffectAcked()`가 disk-full 등으로 던지면 예외가 아무 데도 잡히지 않고 이벤트 루프 밖으로 나가 **프로세스가 죽는다**. T15는 이 구멍을 피하려고 drill에서 ACK를 일시 중단(`pauseEffectAcks`)해야 했다. 24시간 무인 운영에서 렌더러가 보낸 정상 프레임 하나가 서버를 내리는 것은 스펙 §9.2("degraded로 계속 돌되 무엇이 왜 멈췄는지 알 수 있어야 한다")에 정면으로 어긋난다. 고친 뒤에는 (a) 프로세스가 죽지 않고, (b) 실패가 엔진 건강으로 표면화돼 T12 supervisor가 degraded 판정에 쓰며, (c) 그 ACK는 재시도 대상으로 남아 공간이 확보되면 정상 기록된다.

## Hypothesis → observation → fix (`~/.claude/CLAUDE.md` 디버깅 절차)

**1. 원인 가설**

`apps/server/src/engine/engine.ts:393` `onAckEffect()`는

```ts
this.#openEffects.delete(effectId)          // (1) 먼저 in-memory 상태를 지우고
try {
  this.#store.markEffectAcked(effectId, appliedAt)   // (2) 그다음 영속화한다
} catch (error) {
  if (error instanceof UnknownEffectError || error instanceof EffectNotPublishedError) { … return }
  throw error                                // (3) 그 외 실패는 그대로 던진다
}
```

이고, 호출자는 `apps/server/src/engine/publisher.ts:207`의 `socket.on('message', …)` 핸들러다. `ws`의 message 이벤트는 소켓 `data` 이벤트 안에서 동기로 emit되므로, (3)의 throw는 어떤 try/catch도 거치지 않고 이벤트 루프 최상단까지 올라가 `uncaughtException`이 된다 — 핸들러가 없으면 Node는 프로세스를 종료한다(https://nodejs.org/api/process.html#event-uncaughtexception). `markEffectAcked`는 `UPDATE effect_outbox SET acked_at = ?`를 트랜잭션으로 도는 **쓰기**이므로 disk-full(`SQLITE_FULL`)·lock(`SQLITE_BUSY`)·I/O 오류에서 던질 수 있다(스펙 §11 fault matrix "disk-full" 행).

부수적으로 (1)이 (2)보다 먼저이므로, 쓰기가 실패하면 effect는 `#openEffects`에서 이미 지워져 재전송 대상이 아니게 되는데 `effect_outbox.acked_at`은 NULL로 남는다 → 그 ACK는 영원히 유실된다(재시도 경로 없음).

**2. 이 가설을 반증할 관측**

실제 SQLite 파일 위에서, 프로덕션 커넥션의 페이지 예산을 실제로 소진시킨 뒤(`PRAGMA max_page_count`, T15 `fillDisk`와 같은 방법) 실제 WebSocket으로 `ack_effect` 프레임을 보낸다.

- 가설이 **맞다면**: `process.on('uncaughtException')`으로 잡은 예외가 1건 이상이고 그 `code`가 `SQLITE_FULL`이다. (핸들러를 달지 않았다면 프로세스가 죽었을 자리다.)
- 가설이 **틀리다면**: 예외가 0건이거나 다른 곳에서 잡힌다. 그러면 원인은 다른 곳이다.

**3. 관측 결과** → `## Result`의 "재현 관측" 절에 명령·출력을 기록한다.

**4. 수정**은 관측이 가설을 확인한 뒤에만 한다.

## Plan

1. 티켓(이 파일) 커밋·push.
2. **재현 테스트 먼저**(수정 전 실패해야 한다) — `apps/server/src/engine/ack-store-failure.test.ts` 신설:
   - `vi.mock('../db/open.js')`로 `openDatabase`를 감싸 `PersistenceStore`가 실제로 연 **프로덕션 커넥션**을 잡는다. `max_page_count`는 커넥션 단위 설정이고 파일에 저장되지 않으므로(https://sqlite.org/pragma.html#pragma_max_page_count) 다른 커넥션에서 걸어봐야 프로덕션 쓰기는 실패하지 않는다 — T15 `tools/soak/src/injection/storage.ts`가 같은 이유로 같은 방법을 쓴다.
   - `VACUUM` 후 `max_page_count = page_count`로 페이지 예산을 소진(= 실제 `SQLITE_FULL`).
   - (A) 엔진 단위: effect 1건 발행 → disk full → `engine.onAckEffect()`가 던지지 않는다 / `acked_at`이 NULL로 남는다 / effect가 열린 채 남는다 / `health().lastFailure`·`consecutiveFailures`가 실패를 보고한다 → 공간 확보 후 재ACK가 `acked_at`을 기록한다.
   - (B) e2e: 실제 HTTP 서버 + 실제 `/ws/renderer` 클라이언트로 `ack_effect` 프레임 전송. `process.on('uncaughtException')` 카운터가 0, 서버는 계속 `/health`에 응답, 공간 확보 후 **서버가 재전송**(§7.3(7))하고 렌더러가 재ACK하면 `acked_at`이 기록된다.
3. **수정 A — `apps/server/src/engine/engine.ts`**: `onAckEffect()`에서 store 쓰기를 **먼저** 하고, 성공한 뒤에만 `#openEffects` 삭제·`#thanksToClear` 적재·지연 계측을 한다. `UnknownEffectError`/`EffectNotPublishedError`는 지금처럼 카운트 후 무시하고, 그 외 예외는 `classifySqliteError()`로 분류해 `#recordAckFailure()`로 기록한 뒤 **삼키지 않고 남긴다**(effect는 열린 채 → §7.3(7) 재전송 → 렌더러 재ACK → 재시도).
4. **수정 B — `apps/server/src/engine/publisher.ts`**: `#receive()`의 콜백 디스패치를 try/catch로 감싼다. 허브는 transport이고, 브라우저가 보낸 프레임 하나가 서버를 내릴 수 있는 경계는 여기뿐이다. 프레임 내용은 로그에 넣지 않는다(§12.3).
5. 게이트 5개 로컬 실행(CI는 E-5로 불가 — PR에 명시), PR 1개, `worker_done`.

### 설계 판단 — 실패를 어디에 표면화하는가

명세는 "writer failure/`lastFailure` 또는 별도 ack failure 카운터"를 허용한다. **기존 `lastFailure`/`consecutiveFailures`를 쓴다**:

- T12 `supervisor/signals.ts:309`의 `coordinatorSignal`이 이미 `engine.consecutiveFailures > 0`을 `degraded('writer_failing')`으로 읽는다. 같은 필드에 실으면 **T12를 한 줄도 고치지 않고** supervisor 판정에 반영된다. 새 degraded 토큰을 만들면 `signals.ts`가 그것을 모르므로 표면화만 되고 판정에는 쓰이지 않는다(= 명세 (b) 미충족). T12 파일 수정은 이 task 범위 밖이다.
- 원인 구분은 `/metrics` 카운터 `ack_effect_store_failed`와 로그 이벤트 `engine.ack_store_failed`(kind·code)로 남긴다 — 이것이 명세가 말한 "별도 ack failure 카운터"다. `EngineHealth`에 아무도 읽지 않는 필드를 새로 만들지 않는다(`CLAUDE.md` §4 "사용하지 않는 추상화 금지").

**정정 (review round 1, B1)**: *어느 필드에 싣는가*는 위 판단대로였지만 *얼마나 오래 남는가*가 틀렸다. `#consecutiveFailures`는 writer **pass** 스트릭이고 `runPending()`이 pass 완료마다 0으로 되돌린다. 엔진 pass는 250ms(`engine.tickIntervalMs`), T12 평가는 2000ms(`supervisor.evaluateIntervalMs`)이므로, 같은 ACK 경로가 여전히 깨져 있어도 커밋할 것이 없는 pass 하나가 신호를 지워 aggregator가 아예 못 볼 수 있었다. round 1 수정(`765ef36`)은 ACK-store 실패를 별도 상태 `#unrecordedAcks`(아직 열려 있는 effect id 집합)로 옮기고 `EngineHealth.consecutiveFailures`를 **두 값의 합**으로 보고한다 — T12는 그대로 두고, 각 절반은 자기 증거(pass 완료 / ACK 기록)로만 지워진다. 자세한 내용은 `## Review round 1`.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| `PRAGMA max_page_count` | https://sqlite.org/pragma.html#pragma_max_page_count | 2026-08-18 | 파일 페이지 상한. 커넥션 설정이며 파일에 저장되지 않는다 → 프로덕션 커넥션에 직접 걸어야 실제 `SQLITE_FULL`이 난다 |
| SQLite 결과 코드(`SQLITE_FULL`) | https://sqlite.org/rescode.html | 2026-08-18 | `db/errors.ts`의 접두 분류(`SQLITE_FULL*` → `disk_full`)가 그대로 적용된다. 새 분류를 추가하지 않았다 |
| Node `uncaughtException` | https://nodejs.org/api/process.html#event-uncaughtexception | 2026-08-18 | 핸들러가 없으면 예외 출력 후 프로세스 종료. 테스트는 핸들러를 달아 "유출 0"을 직접 센다 |
| `ws` message 이벤트 | https://github.com/websockets/ws/blob/master/doc/ws.md#event-message | 2026-08-18 | 리스너는 소켓 데이터 처리 중 동기로 호출된다 → 리스너 안의 throw는 emit 스택을 타고 이벤트 루프 최상단으로 나간다 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 재시도 창 | effect 창(`endsAt` + `expiryGraceMs`) 안에서만 | — | 창이 지나면 §7.3(7)대로 `expired`가 되고 §9.2 대체 감사 연출이 그 경로를 맡는다. ACK 재시도를 창 밖으로 늘리면 두 정책이 충돌한다 |

## Result

### 재현 관측 (수정 전, 2026-08-18)

`apps/server/src/engine/ack-store-failure.test.ts`를 먼저 쓰고 **수정 전** 코드에서 실행했다.

```text
$ npx vitest run apps/server/src/engine/ack-store-failure.test.ts
 ❯ apps/server/src/engine/ack-store-failure.test.ts (3 tests | 2 failed)
     × records the failure, keeps the effect open and re-acks once space is free
     × survives an ack_effect frame the store cannot record

 FAIL  … > records the failure, keeps the effect open and re-acks once space is free
SqliteError: database or disk is full
 ❯ sqliteTransaction.<anonymous> apps/server/src/db/store.ts:841:10
    839|       this.#db
    840|         .prepare('UPDATE effect_outbox SET acked_at = ? WHERE effect_i…
    841|         .run(at, effectId)
 ❯ PersistenceStore.markEffectAcked apps/server/src/db/store.ts:844:17
 ❯ StateEngine.onAckEffect apps/server/src/engine/engine.ts:406:19

 FAIL  … > survives an ack_effect frame the store cannot record
AssertionError: expected [ …(1) ] to have a length of +0 but got 1
 ❯ apps/server/src/engine/ack-store-failure.test.ts:346:22   // expect(uncaught).toHaveLength(0)
```

가설이 그대로 확인됐다: (1) `markEffectAcked`의 `UPDATE`가 실제 `SQLITE_FULL`("database or disk is full")로 실패하고, (2) 그 예외가 `StateEngine.onAckEffect`(engine.ts:406)에서 그대로 올라가며, (3) 실제 `/ws/renderer` 소켓으로 보냈을 때 `uncaughtException`이 **1건** 잡혔다 — 테스트가 리스너를 달지 않았다면 그 자리에서 프로세스가 끝난다. 반증(예외 0건·다른 위치에서 처리)은 관측되지 않았다.

수정 후 같은 파일: `Test Files 1 passed (1) / Tests 4 passed (4)`(허브 백스톱 테스트 1건 추가). review round 1에서 2건이 더 붙어 지금은 6건이다.

### 재현 방법에 대한 메모 (왜 200건인가)

가득 찬 파일이 **모든** 쓰기를 거부하지는 않는다. b-tree 페이지에 남은 여유 바이트 안에 들어가는 `UPDATE`는 그대로 커밋된다. 이 스키마에서 실측(`dbstat`, 4 KiB 페이지): `VACUUM` 직후 `effect_outbox` 리프 하나가 약 20행을 담고 약 180바이트를 남기며, `acked_at` 기록은 행을 약 24바이트 늘린다. 리프가 2~4개뿐인 작은 픽스처는 ACK를 전부 흡수해버려 아무것도 증명하지 못했다(측정: 71건 open effect → 71건 모두 성공). 유료 이벤트 200건(= open effect 201건)에서는 여유 바이트가 대부분의 행에서 닿지 않는 곳에 있어 **201건 중 94건이 실제 `SQLITE_FULL`로 거부**됐고 첫 거부는 두 번째 ACK에서 났다. 테스트는 "거부가 1건 이상"과 "기록이 1건 이상"을 모두 단언해 픽스처가 실제로 결함을 만들었는지 자체 검증한다.

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 재현 테스트가 수정 전 실패, 수정 후 통과 | met | 위 "재현 관측"(수정 전 2건 실패) / 수정 후 `Tests 4 passed (4)` |
| 2 | (a) store 실패로 프로세스가 죽지 않는다 | met | `ack-store-failure.test.ts` "survives an ack_effect frame the store cannot record": 실제 WS로 201건 ACK 전송, `process.on('uncaughtException')` 수집 0건, 이후 `GET /health`가 응답. 허브 백스톱은 "renderer hub, when a handler throws" |
| 3 | (b) 실패가 엔진 건강으로 표면화되고 T12가 degraded 판정에 쓸 수 있다 | met (round 1 수정 후) | 실제 `HealthAggregator`로 검증한다 — `health()` 필드가 움직였다는 것과 supervisor 판정이 움직였다는 것은 다른 주장이고, round 1이 그 틈을 찾아냈다. `ack-store-failure.test.ts` "stays degraded across successful writer passes and clears when the ACK lands": ACK 실패 → 공간 확보 → **성공한 pass 16회**(250ms 간격, T12 평가 주기 2회분) 이후에도 `families.coordinator = {status:'degraded', reason:'writer_failing'}`이고 `consecutiveFailures === 거부 건수`, 재ACK 성공 후 `ok`. 같은 파일의 disk-full 테스트가 `lastFailure.error =~ /database or disk is full/`, `/metrics` `ack_effect_store_failed`, 로그 `engine.ack_store_failed`(kind·code)를 함께 단언한다 |
| 4 | (c) 해당 ACK는 재시도 대상으로 남는다 | met | 거부된 effect는 `acked_at` NULL이고 `openEffectCount == 거부 건수`, `listUnackedEffects()`에 그대로 있다. 공간 확보 후 §7.3(7) 재전송 → 렌더러 재ACK → `listUnackedEffects()` 0건(엔진 API·실제 WS 두 경로 모두 단언) |
| 5 | 기존 T8/T11/T15 테스트 회귀 없음 | met | `npm run test` → 137 files, 1875 passed, 1 skipped (skip은 기존 것) |
| 6 | 게이트 5개 로컬 통과 | met | 아래 Gates. CI는 BOARD **E-5**(GitHub Actions 결제 차단)로 실행 불가 |

### Gates (executed)

`git fetch origin && git rebase origin/main`(40ee4bb 기준) 후 실행:

```text
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports);
                        check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)
npm run typecheck    -> tsc --build tsconfig.json (오류 없음)
npm run test         -> Test Files 137 passed (137) / Tests 1875 passed | 1 skipped (1876)
npm run build        -> contract·renderer·server·simulator·soak 빌드 성공,
                        copied 5 migration(s) to dist/db/migrations, docs/ops/data-map.md up to date
```

CI: **실행하지 않았음 — BOARD E-5**(GitHub Actions 결제 차단으로 모든 run이 2초 만에 실패). 위 로컬 결과가 근거다.

## Not done / out of scope

- T15의 `tools/soak/src/injection/renderer.ts`(`pauseEffectAcks`)는 건드리지 않았다(명세 지시).
- `apps/server/src/supervisor/*`는 고치지 않았다(위 "설계 판단" 참조). 새 degraded 토큰도 새 `EngineHealth` 필드도 만들지 않고 기존 `consecutiveFailures`에 합산했으므로, T12는 round 1 수정 뒤에도 한 줄도 바뀌지 않았다. supervisor가 실제로 그렇게 판정하는지는 `HealthAggregator`를 직접 돌려 단언한다(합격 기준 3).
- 테스트의 `fillDisk`/`freeDisk`는 T15 `tools/soak/src/injection/storage.ts`와 같은 방법이지만 재사용하지 않고 6줄을 다시 썼다: `tools/soak`가 `@vl/server`에 의존하므로 반대 방향 의존은 순환이 된다. 출처(같은 SQLite 문서)는 주석에 적었다.
- `markEffectExpired`(`#sweepEffects`)·`markEffectPublished`도 같은 store 예외를 낼 수 있지만 그 둘은 이미 writer pass 안에서 돌아 `pump()`가 잡는다 — 범위 밖이고 결함도 아니다.

## Follow-ups

- T15 F-12 drill에서 `pauseEffectAcks()`를 빼고(이제 gap이 닫혔다) disk-full 중에도 ACK가 흐르는 상태로 drill을 돌릴 수 있는지 재검토 — `tools/soak/src/injection/renderer.ts`의 주석이 이 티켓을 가리킨다(T15 소유).
- ~~disk-full이 지속되는 동안 `#reconcileInteraction`이 커밋을 시도했다 실패하며 `consecutiveFailures`가 0↔1을 오가는 진동은 T8 때부터 있던 동작이다(idle pass가 카운터를 0으로 되돌린다). ACK 실패도 같은 필드를 쓰므로 같은 진동을 공유한다. 표면을 sticky하게 바꾸는 것은 T8/T12 공동 결정이 필요해 이 티켓에서 하지 않았다.~~ → **round 1 B1에서 고쳤다.** ACK-store 실패 절반은 더 이상 진동하지 않는다(`#unrecordedAcks`). **writer pass 실패 절반의 진동은 그대로 남아 있다** — pass 실패는 다음 pass가 성공하면 사라지는 것이 정의이고, 이를 sticky하게 바꾸는 것은 여전히 T8/T12 공동 결정이다. 이 티켓의 범위는 ACK 경로다.

## Review round 1

리뷰: PR #21, verdict `request_changes`(blocker 1). 게이트 5개와 합격 기준 1·2·4·5·6은 리뷰어가 직접 실행해 통과 확인했고, 기준 3만 미충족이었다. 지적이 정확하며 반박하지 않는다 — 티켓 스스로 이 진동을 `## Follow-ups`에 적어두고도 "명세 (b) 충족"이라고 썼던 것이 잘못이다. 수정은 한 커밋(`765ef36`).

- Orca: task `task_33718e078e54` · dispatch `ctx_582591b5e760`

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] `engine.ts:341` — `#recordAckFailure()`가 writer의 공유 `consecutiveFailures`를 올리지만 `runPending()` 완료마다 그 값이 무조건 0이 되어, 같은 ACK 경로가 깨져 있어도(effect open, `markEffectAcked` 여전히 실패) 신호가 사라진다. 리뷰어 관측: `afterAckFailure={1,degraded,open 2}` → 무관한 pass 1회 → `{0,false,2}` → 같은 ACK 재실패 `{1,true,2}`. 엔진 pass 250ms(`config/default.json:33`) vs T12 평가 2000ms(`:140`, `supervisor.ts:803`)라 `signals.ts:309`가 읽는 시점에 실패가 안 보일 수 있음 → 기준 (b) 미충족 | **고침 `765ef36`.** ACK-store 실패의 **수명**을 writer pass에서 떼어냈다. 새 상태 `#unrecordedAcks: Set<string>` — store가 그 effect의 ACK를 거부하면 id가 들어가고, **그 effect가 열린 집합을 떠날 때만** 나온다(ACK가 마침내 기록됨, 또는 §7.3(7)이 창을 닫아 재전송 자체가 사라짐). `runPending()`은 이제 writer 카운터만 0으로 되돌린다. `EngineHealth.consecutiveFailures`는 **두 값의 합**을 보고하므로 `signals.ts`도 `supervisor/*`도 한 줄도 바뀌지 않았고, 두 절반은 각자의 증거로만 지워진다. 열려 있지 않은 effect의 ACK 실패는 집합에 넣지 않는다 — 재전송이 없어 어떤 미래의 ACK도 그것을 지울 수 없으므로 영구 degraded가 된다(그런 실패도 `lastFailure`·`/metrics`·로그에는 그대로 남는다). |
| ↳ 요구된 타이밍/통합 테스트 | **추가 `765ef36`.** `ack-store-failure.test.ts`에 실제 `HealthAggregator`(T12)로 판정을 읽는 헬퍼 `coordinatorVerdict()`를 두고 2건: (1) "stays degraded across successful writer passes and clears when the ACK lands" — 실제 `SQLITE_FULL`로 ACK 94건 거부 → 공간 확보 → **250ms 간격 성공 pass 16회**(= T12 평가 주기 2회분, `runPending()`이라 pass가 실패하면 테스트가 실패한다) → `families.coordinator={degraded, writer_failing}` · `consecutiveFailures === 94` · `openEffectCount === 94` → 렌더러 재ACK → `consecutiveFailures === 0` · `coordinator = ok`(false-degraded 고착 없음). 수정 전 코드에서 이 테스트는 `expected +0 to be 94`로 실패한다(아래 반증 실행). (2) "stops reporting a fault that no ACK can clear any more" — 지속 가능한 상태는 고착도 가능하므로, effect 창이 닫히면(§7.3(7) expiry) 신호가 스스로 풀리는 것을 단언한다. |
| [minor] 티켓 `## Result` 기준 3의 "같은 tick" 서술이 250ms 리셋 대 2000ms pull이 보장할 수 있는 것을 넘어선다 | **고침 `765ef36`.** "같은 tick" 표현을 지우고(설계 판단 절·Not done 절), 기준 3의 근거를 실제 aggregator 판정으로 바꿔 적었다. `## Follow-ups`의 진동 항목도 "ACK 절반은 고쳤고 writer pass 절반은 그대로"로 정정했다. |

### 반증 실행 (수정이 실제로 그 결함을 고치는가)

```text
$ git stash push -- apps/server/src/engine/engine.ts   # 수정 전 engine.ts로 되돌림
$ npx vitest run apps/server/src/engine/ack-store-failure.test.ts
 ❯ apps/server/src/engine/ack-store-failure.test.ts (6 tests | 1 failed)
     × stays degraded across successful writer passes and clears when the ACK lands
AssertionError: expected +0 to be 94 // Object.is equality
 ❯ apps/server/src/engine/ack-store-failure.test.ts:292:42
     expect(degraded.consecutiveFailures).toBe(refused.length)
$ git stash pop
$ npx vitest run apps/server/src/engine/ack-store-failure.test.ts
 Test Files  1 passed (1) / Tests  6 passed (6)
```

리뷰어가 본 그 값(성공 pass 뒤 `0`)이 그대로 재현됐고, 수정 후에는 94가 유지된다.

### Gates (round 1 fix, 로컬)

`git fetch origin && git rebase origin/main`(cbb7cba 기준) 후 실행:

```text
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> eslint 0 problems; check-no-legacy-imports: ok (0 legacy imports);
                        check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)
npm run typecheck    -> tsc --build tsconfig.json (오류 없음)
npm run test         -> Test Files 137 passed (137) / Tests 1877 passed | 1 skipped (1878)
npm run build        -> contract·renderer·server·simulator·soak 빌드 성공,
                        copied 5 migration(s) to dist/db/migrations, docs/ops/data-map.md up to date
```

CI: **실행하지 않았음 — BOARD E-5**(GitHub Actions 결제 차단). 위 로컬 결과가 근거다.
