# TASK-T8-state-engine

- Task: T8 상태 엔진 — 단일 writer·outbox·WS 발행·ACK·유료 멱등 (`docs/tasks/TASK_SPECS.md` §T8)
- Branch: `dnhynk/t8-state-engine` · PR: #12
- Orca: task `task_0aadf1c96dcf` · dispatch `ctx_658aa3ad45d1`
- Spec sections read: §2.1, §5.2, §6.2, §6.4, §7.3 전체, §7.4, §7.5, §9.2, §9.4, §10.2, §11
- BOARD decisions/assumptions relied on: D-1, A-1, A-2, A-3, A-9, A-14, A-15, A-17

## Goal

inbox와 타이머를 하나의 단일 writer 루프에서 `ingestSeq`·시각 순으로 직렬화해, 각 입력을
`dedupe → 파서/arbiter(T6) → reducer(T7) → commitStateTransition(T4) 한 트랜잭션 → WS 발행 →
ACK 추적`으로 처리한다. 시작 시에는 snapshot 로드 → deadline 정책 적용 → inbox drain →
`ready` 순서를 지키고, degraded 동안 수신한 이벤트를 잃지 않으며, 유료 이벤트는
`paid_ledger`/`gift_combo`/inbox event key 3중 멱등으로 정확히 한 번만 반영한다.

## Plan

1. **엔진 상태의 영속화(설계 결정)** — T7 `WorldState`(seed·stepIndex·욕구 압력·audit 링·
   variation 링·deadline 집합)는 contract `WorldSnapshot`(읽기 모델)으로 복원할 수 없다. 재기동
   결정성을 위해 `world_snapshot` 행에 엔진 소유의 불투명 JSON 컬럼(`engine_state_json`)을
   migration으로 추가하고, `commitStateTransition`에 선택 필드 `engineState`를 더해 **같은
   트랜잭션**에서 쓴다(§7.3(5)). → 코디네이터 `ask` 승인(아래 표).
2. **`apps/server/src/engine/` 신설** — `config`(engine·world tuning·simulator) / `ids`(결정적
   effectId·deadline row id) / `effects`(EffectDraft → contract Effect 조립, A-17) /
   `deadlines`(pending 집합 diff → `deadlines` 테이블) / `state`(도메인 상태 직렬화) /
   `metrics`(4구간 히스토그램) / `snapshot`(읽기 모델 조립) / `publisher`(`/ws/renderer` 허브) /
   `ingest`(`POST /ingest/simulator`) / `engine`(단일 writer 루프).
3. **입력 병합** — 이벤트 `now = max(worldTimeUtc, receivedAt)`, deadline `now = dueAt`.
   시각 순 병합, 동시각이면 이벤트 우선(T7 `runWorld`와 같은 규칙).
4. **arbiter 연동** — `direct`는 즉시 step, `aggregated`는 held(처리 기록을 남기지 않아 커서가
   그 아래에 머문다) → 창 마감 시 `aggregatedOnly`만 **실제 마지막 이벤트**에 실어 1회 적용.
5. **`command.argument` 어휘 검사** — 열린 `mission.choices`의 `choiceId`가 아니면 이유 코드와
   함께 버린다(원문 미저장).
6. **degraded 규칙(§9.2)** — 입력 건강 신호 또는 renderer ACK 건강이 불건전하면
   `interactionEnabled=false` snapshot을 발행하고 이벤트는 inbox에 보존(타이머는 계속 진행).
   복구 시 유효시간 내면 처리, 지나면 `expired`. 유료는 만료 없음.
7. **HTTP** — `GET /metrics`, `POST /ingest/simulator`, `/health`에 엔진 신호.
8. **`.gitignore`의 `data/` → `/data/`**.
9. **테스트** — 합격 기준 5개 각각에 대응하는 vitest.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| SQLite `ALTER TABLE ADD COLUMN` | https://sqlite.org/lang_altertable.html | 2026-08-17 | nullable 컬럼 추가는 기존 행에 NULL로 채워지며 STRICT 테이블에도 적용 가능. migration 004에서 사용 |
| SQLite `ON CONFLICT DO NOTHING`·UPSERT | https://sqlite.org/lang_upsert.html | 2026-08-17 | effect_outbox·paid_ledger 재발행이 새 행을 만들지 않는 근거(T4가 이미 사용, T8이 의존) |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| T7 `WorldState` 영속화를 위해 T4 `world_snapshot`에 엔진 소유 JSON 컬럼을 새 마이그레이션으로 추가하고 `commitStateTransition`에 선택 필드를 더해도 되는가 | **A 승인**. 근거: §7.3(5)의 "하나의 영속 트랜잭션"에 도메인 상태도 포함된다. 조건 (1) 새 마이그레이션 파일, (2) `engineState`는 선택 필드·기존 T4 테스트 불변·crash-window 원자성 테스트 1건 추가, (3) `loadRecoveryState`가 engineState를 함께 반환하고 없으면 초기 상태로 시작함을 테스트, (4) 티켓·PR "Scope"에 승인 사실 명시, (5) `packages/contract` 불변 | 전부 반영: `004_engine-state.sql`, `StateTransitionInput.engineState?`, `RecoveryState.engineState`, `db/crash.test.ts` "process killed while writing the snapshot", `db/recovery.test.ts` "returns the writer domain state it was given, and null when it was not", `engine/recovery.test.ts` "starts a fresh world when the database holds no engine state". contract 변경 0 |
| (후속 지시 2회) 마이그레이션 번호 | T13이 002, T10이 003 → **T8은 004**. 러너가 번호 간격을 허용하는지 확인할 것 | `004_engine-state.sql`로 번호 확정. `db/migrate.ts`의 `loadMigrations`가 "Gaps are allowed (a reverted branch may burn a number)"로 간격을 명시 허용하고 중복만 거부하므로 `002`·`003` 부재 상태에서도 적용된다(`migrate.test.ts` "rejects two files claiming the same version"가 중복만 막는 것을 고정). 별도 ask 불필요 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `engine.degraded.eventValidityMs` | 900000 (15분) | `provisional` | §9.2의 "사전에 승인된 유효시간"은 콘텐츠 정의 값이고 스펙·TASK_SPECS에 수치가 없다. Gate 0/2 승인값으로 교체(A-15) |
| `engine.degraded.rendererAckTimeoutMs` | 15000 | `provisional` | §9.2 "renderer ACK 불건전" 판정 임계값. §11 freeze 허용치와 함께 Gate 2에서 잠금 |
| `engine.effects.retransmitIntervalMs` / `expiryGraceMs` | 3000 / 20000 | `provisional` | §7.3(7) 재전송 정책의 간격은 스펙 미정 |
| `engine.tickIntervalMs` / `drainBatchSize` / `metricsSampleSize` | 250 / 200 / 1024 | `provisional` | 엔진 페이싱. 실측 후 조정 |
| degraded 판정에 `no_renderer` 포함 | 렌더러 0개면 degraded | — | §9.2 "renderer ACK가 불건전하면"의 가장 강한 경우. 이 상태에서 무료 이벤트는 inbox에 보존되고 유효시간 안에 복구되면 처리된다 |
| `world.tuning` / `world.freshness` 블록 | `DEFAULT_WORLD_TUNING` / `FRESHNESS_MINIMUMS`와 동일 값 | `provisional: true` | TASK_SPECS §T8의 tuning 주입 요구(A-15). 값이 두 곳에 있으므로 `engine/config.test.ts`가 둘의 동등성을 강제해 조용한 어긋남을 막는다 |
| aggregate 창 적용 시각 | `max(worldTimeUtc, window.endedAtUtc)` | — | 창의 기여는 창이 닫힌 시점의 사건이다 |
| 복구 시 deliver되는 deadline의 `now` | 복구 시각 | — | 정책이 이미 "이 발생이 여전히 유효한가"를 결정했고, T7 핸들러는 절대 상태(`needsUpdatedAt`, `crisisSince`)에서 적분하므로 복구 시각 전달이 coalesce 의미와 일치한다 |
| `state_transitions.kind` | 전이 타입 `+` 결합(8개 초과 시 `+more`) | — | 테이블의 PK가 `revision`이라 한 revision에 한 행뿐이다. 값은 닫힌 어휘(TransitionType)라 사용자 문자열이 들어갈 수 없다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | replay 결정성: 같은 inbox로 두 번 부팅하면 같은 snapshot·revision | met | `apps/server/src/engine/replay.test.ts` — "two boots over the same inbox reach the same snapshot and revision"(snapshot 전체 deep-equal + effectId·cause 목록 일치), "produces effect ids derived from the revision, not from a random source", "restarting on the same database resumes instead of restarting the world". 결정성은 (inbox 내용, seed, 주입 Clock) 3자에 대해 성립하며 셋 다 주입값이다 |
| 2 | 유료 무결성: 동일 Super Chat 1건, Gift delta만, 같은 paid effectId 재발행 시 새 row 없음 | met | `apps/server/src/engine/paid.test.ts` 6건 — 중복 Super Chat → paid effect 1·ledger 1 / 원장에 이미 있는 event는 world에 도달하지 않음(`paid_duplicate`) / combo 0→1→3→5→3 → thanks 3건(delta 1,2,2), `getGiftStoredMax=5` / 최댓값보다 낮은 combo → `gift_no_delta`, 연출 없음 / 재기동 재발행 후 `listUnackedEffects` 수 불변 / ACK 후 `ackedAt` 기록 |
| 3 | commit 후 발행 전 종료 → 재기동 시 미ACK effect 재발행·정합 | met | `apps/server/src/engine/recovery.test.ts` — "republishes an effect committed but never published"(발행 직전 예외로 크래시 창 재현 → 재기동 후 같은 effectId 1회 재발행, `publishedAt` 기록, snapshot revision ≥ effect revision, outbox row 수 불변). 추가로 hello 시 전량 재발행, 창 경과 시 `expired`, 구 DB(engine state 없음) 기동, 다른 버전 상태 거부 |
| 4 | degraded 창 replay: CTA 비활성, 만료 명령 `expired`, 유료 대체 감사 1회 | met | `apps/server/src/engine/degraded.test.ts` 6건 — 렌더러 0/입력 불건전 시 `interactionEnabled=false`·`broadcastLifecycle=degraded` 발행 / degraded 중 이벤트 보존(inbox 잔존, `lastAppliedAction` null) 후 복구 시 적용 / 유효시간 경과 시 `event_expired` 1·적용 0 / 유료는 만료 없이 `fallback: true` 연출 정확히 1회 / 원 연출이 ACK되면 대체 연출 없음 |
| 5 | 로컬 API 수신→ACK p95 기록 | met(기록) | `apps/server/src/engine/e2e.test.ts`가 실제 HTTP·WS·시스템 시계로 20건을 왕복시키고 `/metrics`를 읽어 출력한다. 단독 실행 3회: `receivedToAcked` p95 = **41 / 67 / 13 ms**(p50 19/38/9, max 58/288/60), 구간별 p95 `receivedToCommitted` 39/59/9, `committedToPublished` 1/1/1, `publishedToAcked` 10/22/4. 전체 스위트 병렬 실행 중에는 `receivedToAcked` p95 55–100 ms로 올라간다(같은 호스트에서 72개 테스트 파일이 동시에 도는 상태). 합격선은 §7.5에 따라 Gate 2 calibration 후 잠그며 여기서는 판정하지 않는다 |

### Gates (executed)

```text
$ npm run format:check
All matched files use Prettier code style!

$ npm run lint
eslint . && node scripts/check-no-legacy-imports.mjs && node scripts/check-install-scripts.mjs
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (3 reviewed, better-sqlite3 binding loads)

$ npm run typecheck
tsc --build tsconfig.json      (오류 없음)

$ npx vitest run
Test Files  72 passed (72)
Tests  1124 passed | 1 skipped (1125)

$ npm run build
@vl/contract / @vl/renderer / @vl/server / @vl/simulator 빌드 성공
copied 2 migration(s) to dist/db/migrations
```

`git fetch origin && git rebase origin/main`(main `44fefaa`) 후 위 게이트를 다시 실행해 모두 통과.

실행하지 않았음: 실제 YouTube·OBS 경로. T8은 source adapter(T9)·broadcast(T10) 이전 단계이고,
입력은 `POST /ingest/simulator`와 T4 inbox로만 들어온다. 실계정 검증은 Gate 2 범위.

### 구현 노트 (리뷰용 요약)

- **단일 writer 루프**(`engine/engine.ts`): `runPending()`이 (1) 닫힌 집계 창 flush → (2) 시각
  순으로 다음 입력 1건 처리 → (3) 반복 → (4) 남은 처리 기록 commit → (5) CTA 재조정 →
  (6) effect sweep. 각 입력은 `commitStateTransition` 한 번(= revision 1개)으로 확정된 뒤에만
  발행된다.
- **커서 규칙**: 해결된 행은 `#resolved`에, 집계 보류 행은 `#held`에 쌓이고, 커서는 항상
  "가장 낮은 held seq 미만"까지만 전진한다. T4의 `ProcessedCursorError`가 이 규칙을 강제한다.
- **Effect 조립**(A-17): `assembleEffect`가 `effectId = e{revision}_{index}`를 발급하고 cause
  판별자에 따라 `causedByEventKey`를 채운다. deadline 유래 effect에는 지금 배달 중인 타이머와
  kind가 같을 때만 `deadlineId`를 붙인다(없는 row id를 지어내지 않는다).
- **deadline 테이블**: reducer가 매 step마다 전체 pending 집합을 돌려주므로 엔진은 diff를 써서
  pending/fired/expired/cancelled를 upsert한다. row id는 `{kind}[_{sha256(key)[0:16]}]`.
- **degraded**: `#degradedReasons()`가 `input_*`·`no_renderer`·`renderer_ack_stale`을 돌려주고,
  하나라도 있으면 이벤트를 보류하고 `interactionEnabled=false`를 새 revision으로 발행한다.
- **지표**: `receivedAt→committedAt→publishedAt→ackedAt` 4구간 + 카운터를 `/metrics`에 JSON으로
  노출. 타이머 유래 revision은 "API 수신"이 없으므로 end-to-end 히스토그램에 넣지 않는다.

## Not done / out of scope

- kill switch `POST /admin/kill`과 건강 신호 집계·supervisor 상태기계는 T12.
- `engine.ready`를 기다리는 source adapter 쪽 구현은 T9(엔진은 `ready`/`health()`만 노출).
- 시뮬레이터 시나리오·리포트(`npm run sim:report`, `npm run test:replay`)는 T11. T8은 수신
  엔드포인트와 `/metrics`만 제공한다.
- `broadcastLifecycle`은 엔진이 `starting|live|degraded`만 파생한다. `offline`·`recovering`·
  `safe_stopped`는 T10/T12가 소유한다.
- `RendererHub.ping()`은 구현되어 있지만 주기 송신은 걸지 않았다(T12의 dead-man 주기와 함께
  정하는 편이 맞다).

## Follow-ups

- T12가 `reportInputHealth()`와 `health()`를 supervisor 집계에 연결하고 `broadcastLifecycle`
  소유권을 가져갈 때 엔진의 파생 규칙을 한 곳으로 합칠 것.
- `engine.degraded.eventValidityMs`는 콘텐츠 정의값이 확정되면 `world/content/`로 옮기는 편이
  자연스럽다(현재는 운영이 조정하는 값이라 `config`에 둠).
