# TASK-T8d-publish-store-failure

- Task: T8d 엔진 버그픽스 — `#publish`의 `markEffectPublished` store 실패로 committed effect가 재시작까지 미발행 (`docs/tasks/TASK_SPECS.md` §T8, 공통 규약)
- Branch: `dnhynk/t8d-publish-store-failure` · PR: #(미생성)
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
   - (A) 라이브 commit 경로: 커밋과 mark 사이에 파일이 차는 순간(= 프로덕션의 실제 레이스). 무료·유료 effect 각각에 대해 uncaught 0 · row `published_at NULL` · 렌더러 미전송 · health `writer_failing` → 공간 확보 후 **다음 pass**가 발행 → 렌더러 ACK가 `acked_at` 기록 → health 0.
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

<!-- 구현 후 채운다 -->

## Not done / out of scope

<!-- 구현 후 채운다 -->

## Follow-ups

<!-- 구현 후 채운다 -->
