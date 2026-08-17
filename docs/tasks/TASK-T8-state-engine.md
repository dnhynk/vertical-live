# TASK-T8-state-engine

- Task: T8 상태 엔진 — 단일 writer·outbox·WS 발행·ACK·유료 멱등 (`docs/tasks/TASK_SPECS.md` §T8)
- Branch: `dnhynk/t8-state-engine` · PR: #<n>
- Orca: task `task_0aadf1c96dcf` · dispatch `ctx_658aa3ad45d1`
- Spec sections read: §7.3 전체, §7.4, §7.5, §9.2, §9.4, §10.2, §11
- BOARD decisions/assumptions relied on: D-1, A-1, A-2, A-3, A-9, A-14, A-15, A-17

## Goal

inbox와 타이머를 하나의 단일 writer 루프에서 `ingestSeq`·시각 순으로 직렬화해, 각 입력을
`dedupe → 파서/arbiter(T6) → reducer(T7) → commitStateTransition(T4) 한 트랜잭션 → WS 발행 →
ACK 추적`으로 처리한다. 시작 시에는 snapshot 로드 → deadline 정책 적용 → inbox drain →
`engine.ready` 순서를 지키고, degraded 동안 수신한 이벤트를 잃지 않으며, 유료 이벤트는
`paid_ledger`/`gift_combo`/`eventKey` 3중 멱등으로 정확히 한 번만 반영한다.

## Plan

1. **엔진 상태의 영속화(설계 결정)** — T7 `WorldState`(seed·stepIndex·욕구 압력·audit 링·
   variation 링·deadline 집합)는 contract `WorldSnapshot`으로 복원할 수 없다. 재기동 결정성을
   위해 `world_snapshot` 행에 엔진 소유의 불투명 JSON 컬럼(`engine_state_json`)을 migration 002로
   추가하고, `commitStateTransition`에 선택 필드 `engineState`를 더해 **같은 트랜잭션**에서 쓴다
   (§7.3(5)). 두 트랜잭션으로 나누면 어느 순서든 크래시 창에서 snapshot과 도메인 상태의 revision이
   어긋나 이미 처리 기록이 남은 입력을 재적용하게 된다. → 코디네이터 `ask` 발송(아래 표).
2. **`apps/server/src/engine/` 신설**
   - `config.ts` — `config/default.json`의 `engine.*`(+`world.tuning` 주입, A-15 provisional)와
     `simulator.*`를 읽는다. 기존 `db/config.ts`·`input/config.ts` 패턴 그대로.
   - `ids.ts` — 결정적 `effectId`(`e{revision}_{index}`)와 deadline row id
     (`{kind}` 또는 `{kind}_{sha256(key)[0:16]}`) 발급. 재부팅 replay에서 같은 id가 나온다.
   - `effects.ts` — T7 `EffectDraft` → contract `Effect` 조립(A-17): `cause` 판별자 그대로,
     event면 `causedByEventKey = cause.eventKey`, deadline이면 `null`, 유료는 event 유래만.
   - `deadlines.ts` — `ScheduledDeadline` ↔ T4 `DeadlineRecord` 매핑과 pending 집합 diff
     (`fired`/`expired`/`cancelled` 상태 기록).
   - `dedupe.ts` — `paid_ledger`(eventKey PK) · `gift_combo`(delta) · 처리 기록 기반 3중 멱등.
   - `metrics.ts` — `receivedAt→committedAt→publishedAt→ackedAt` 히스토그램(p50/p95/max).
   - `publisher.ts` — `/ws/renderer` WS 서버, `hello`에 snapshot + 미ACK effect 재발행,
     `ack_state`/`ack_effect` 기록, 미ACK 재전송 간격·만료.
   - `engine.ts` — 단일 writer 루프. 시작 순서, drain, degraded 규칙, aggregate 창 처리.
   - `index.ts` — 공개 표면.
3. **입력 병합 규칙** — 이벤트의 `now`는 `max(worldTimeUtc, envelope.receivedAt)`, deadline은
   `dueAt`. 둘을 시각 순으로 병합하되 실제 발화는 주입된 `Clock`이 그 시각을 지났을 때만 한다
   (backlog drain은 시각 순으로 즉시 소화). 결정성은 (inbox 내용, seed, 주입 Clock) 3자에 대해
   성립하며 replay 테스트가 이를 고정한다.
4. **arbiter 연동(§6.4, TASK_SPECS §T8 추가 항목)** — `direct` 판정은 즉시 reducer에 넣고,
   `aggregated` 판정은 엔진 영속 상태의 창 버퍼에 명령별 개수와 **대표 실제 event**를 쌓는다
   (가짜 이벤트를 만들지 않는다, §2.6). 창이 닫히면 `aggregatedOnly`만 명령별 1회 step으로 적용한다
   (`directApplied`는 이미 반영됨). inbox 행은 처리 시점에 처리 기록을 남겨 커서를 순서대로 전진시키고,
   버퍼는 같은 트랜잭션에 영속되므로 크래시에도 기여가 사라지지 않는다.
5. **`command.argument` 어휘 검사** — 현재 열린 `mission.choices`의 `choiceId` 어휘일 때만
   상태에 넣고, 그 외는 이유 코드(`unknown_choice`)로 버린다(원문 미저장).
6. **degraded 규칙(§9.2)** — 입력 건강 신호(외부 보고) 또는 renderer ACK 건강(엔진 자체 관측)이
   불건전하면 `interactionEnabled=false` snapshot을 발행하고, 그 동안 도착한 이벤트는 inbox에
   보존만 한다(타이머는 계속 진행 — §2.1). 복구 시 `receivedAt + engine.degraded.eventValidityMs`
   안이면 처리, 지나면 처리 기록 `expired`. 유료는 만료시키지 않고 commit 후에만 화면에 나가며,
   원 연출 시간이 지난 건은 T7의 `paid_thanks_fallback`(replay) 타이머가 대체 감사 1회를 만든다.
7. **HTTP** — `server.ts`에 `GET /metrics`(JSON), `POST /ingest/simulator`(loopback + bearer
   `server.simulatorToken`, `simulator.enabled=false`면 404, 스키마 실패 400 → `commitIngestBatch`)
   추가. `/health`에 엔진 신호(ready·degraded·마지막 commit 시각·미ACK 수)를 더한다.
8. **`.gitignore`의 `data/` → `/data/`** (T6에서 `apps/server/src/input/data`가 숨겨졌던 사례).
9. **테스트** — 합격 기준 5개 각각에 대응하는 vitest: replay 결정성, 유료 무결성(중복 Super Chat·
   Gift delta·effect 재발행), commit 후 발행 전 종료 → 재발행 정합, degraded 창 replay,
   로컬 p95 계측 기록.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| SQLite `ALTER TABLE ADD COLUMN` (STRICT 테이블 포함) | https://sqlite.org/lang_altertable.html | 2026-08-17 | 기존 행에 NULL로 채워지는 nullable 컬럼 추가는 지원됨(상수 기본값 제한). migration 002에서 사용 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| T7 `WorldState` 영속화를 위해 T4 `world_snapshot`에 엔진 소유 JSON 컬럼을 migration 002로 추가하고 `commitStateTransition`에 선택 필드를 더해도 되는가(범위 검사 대비) | | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
```

## Not done / out of scope

- …

## Follow-ups

- …
