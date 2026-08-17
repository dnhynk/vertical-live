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

- T12 `supervisor/signals.ts:309`의 `coordinatorSignal`이 이미 `engine.consecutiveFailures > 0`을 `degraded('writer_failing')`으로 읽는다. 같은 필드에 실으면 **T12를 한 줄도 고치지 않고** 같은 tick에 supervisor 판정에 반영된다. 새 degraded 토큰을 만들면 `signals.ts`가 그것을 모르므로 표면화만 되고 판정에는 쓰이지 않는다(= 명세 (b) 미충족). T12 파일 수정은 이 task 범위 밖이다.
- 원인 구분은 `/metrics` 카운터 `ack_effect_store_failed`와 로그 이벤트 `engine.ack_store_failed`(kind·code)로 남긴다 — 이것이 명세가 말한 "별도 ack failure 카운터"다. `EngineHealth`에 아무도 읽지 않는 필드를 새로 만들지 않는다(`CLAUDE.md` §4 "사용하지 않는 추상화 금지").

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

### 재현 관측

<수정 전 실행 명령과 출력>

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
<명령과 출력 요약>
```

## Not done / out of scope

- T15의 `tools/soak/src/injection/renderer.ts`(ACK 일시 중단 도구)는 건드리지 않았다 — PR #18에서 리뷰 중이고, 이 저장소 브랜치에는 아직 존재하지 않는다.
- `apps/server/src/supervisor/*`는 고치지 않았다(위 "설계 판단" 참조).

## Follow-ups

- PR #18(T15) 머지 후, F-12 drill에서 `pauseEffectAcks()`를 빼고 disk-full 중에도 ACK가 흐르는 상태로 drill을 돌릴 수 있는지 재검토(T15 소유).
