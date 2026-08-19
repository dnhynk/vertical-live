# TASK-T8e-clock-jump-flaky

- Task: T8e 엔진 후속 — 가상 시계 31일 점프 후 `pump()` 미반환 · `ingest.test.ts` SQLite write lock flaky (`docs/tasks/TASK_SPECS.md` §T8e)
- Branch: `dnhynk/t8e-clock-jump-flaky` · PR: #31
- Orca: task `task_364b480f6a22` · dispatch `ctx_e18ea3300000`
- Spec sections read: §7.3(3), §9.2, §10.2, §11 "상태 복구"
- BOARD decisions/assumptions relied on: A-15(월드 튜닝 provisional), D-4(public repo)

## Goal

두 건의 엔진 후속을 CLAUDE.md 디버깅 절차(가설 → 반증 관측 → 실제 관측 → 확인 후 수정)로 처리한다.
(1) 가상 시계를 31일 전진시킨 뒤 `StateEngine.pump()`가 사실상 반환하지 않는 문제(T20b 리뷰 관측)의 원인을 규명하고 최소 수정한다.
(2) `apps/server/src/engine/ingest.test.ts:442`(SQLite write lock 503 테스트)의 1/3 flaky(T21 관측) 원인을 관측으로 규명하고 원인별 최소 수정한다. 증상만 가리는 재시도는 넣지 않는다.

## Plan

1. **(1) 재현·계측** — 엔진 하니스로 가상 시계를 N시간 전진시킨 뒤 `runPending()` 1회의 커밋 수·소요시간을 측정해 점프 크기와의 관계를 본다(반증 관측: 무한 루프라면 커밋 수가 점프 크기에 비례하지 않고 `pass_limit_reached`가 찍힌다).
2. **(1) 원인 확정** — `#runPending` 루프가 반복 deadline의 *모든* 발생을 1건씩 `commitStateTransition`으로 소비하는지 확인한다.
3. **(1) 수정** — 스펙 §10.2 downtime 정책(이미 `start()` 경로에서 쓰는 `recoverDeadlines`)을 러닝 루프에도 적용한다. 임계값은 `engine.deadlines.catchUpWindowMs`(provisional) config로 두고 근거를 남긴다.
4. **(1) 재현 테스트** — 31일 점프 후 `pump()` 1회가 유한 시간(테스트 예산 내)에 반환하고 커밋 수가 상한 아래인지 검사하는 테스트를 추가한다. 수정을 되돌려 실패를 확인한다.
5. **(2) 관측** — `ingest.test.ts:442`의 DB 파일이 실제로 테스트별 격리인지(`createTempStore`가 `mkdtemp`), `busy_timeout`이 설정돼 있는지, 반복 실행에서 어떤 assertion이 어떻게 깨지는지 관측한다.
6. **(2) 수정** — 관측된 원인에 대한 최소 수정.
7. 게이트 5개 + 10회 반복 flaky 0 확인 → PR.

## Debugging record — (1) 31일 점프 후 `pump()` 미반환

### 가설

`#runPending`의 루프가 **반복 deadline의 모든 발생을 1건씩** 소비한다. `#advanceOnce`가 가장 이른 due deadline을
골라 `#prepareDeadline`에서 내부 시각을 그 `dueAt`으로 전진시키고 `#applySteps`가 `commitStateTransition`
트랜잭션을 1건 커밋한다. 핸들러가 다음 발생을 재무장하면 그것도 이미 due이므로 루프가 계속된다. 따라서 소요 시간은
점프 크기에 **비례**하고, 무한 루프가 아니라 "매우 긴 유한 루프"다.

### 이 가설을 반증할 관측

- 무한 루프(진행 없음)라면 커밋 수가 점프 크기에 비례하지 않고, `MAX_STEPS_PER_PASS`(100,000) 상한에 걸려
  `pass_limit_reached` 카운터가 1이 되며 곧바로 반환한다.
- 비례하지 않는다면(예: 점프 크기와 무관하게 일정) 원인은 다른 곳이다.

### 실제 관측

`createEngineHarness()` + `FakeClock.advance(N)` 후 `runPending()` 1회의 커밋 수·소요 시간을 측정했다
(관측용 임시 테스트, 커밋하지 않음):

| 점프 | commits | elapsed | `pass_limit_reached` |
|---|---|---|---|
| 1h | 113 | 249 ms | 0 |
| 2h | 226 | 461 ms | 0 |
| 4h | 458 | 656 ms | 0 |
| 8h | 935 | 2,156 ms | 0 |
| 24h | 2,836 | 6,341 ms | 0 |
| **31d** | **88,479** | **265,863 ms (4분 26초)** | **0** |

- 커밋 수는 점프 크기에 선형(≈118 commits / world-hour)이고 `pass_limit_reached`는 0 — 즉 무한 루프도,
  런어웨이 가드에 걸린 것도 아니다. **가설 확인.**
- 88,479건은 콘텐츠 정의로 설명된다: `idle_beat` 30–75 s(평균 ≈52.5 s) ≈51,000회 + `need_decay` 90 s
  ≈29,760회 + `crisis_recovery` 300 s + `weather_change` 150 min + `visitor_arrival` 210 min +
  `world_phase` + `chapter_beat`.
- T20b가 본 "184 s timeout까지 미반환"은 실제 265.9 s < 반환 시점이므로 정확히 일치한다.

### 원인

러닝 루프에는 **downtime 정책이 적용되지 않는다.** 스펙 §10.2는 deadline 종류마다 downtime 뒤 정책
(`replay`/`coalesce`/`skip`)을 두라고 하고, T7 `planDeadlineRecovery`와 엔진의 `#recoverDeadlines`가 이미
그것을 구현해 `start()` 경로에서 쓴다. 그런데 점프는 재시작이 아니므로 그 경로를 타지 않고, 루프가 간격 안의 모든
발생을 하나씩 스테이징한다. 이는 성능 문제일 뿐 아니라 **§10.2 위반**이다 — `idle_beat`가 `skip`인 이유가
"지나간 순간의 연출을 뒤늦게 재생하지 않는다"이고, `need_decay`가 `coalesce`인 이유가 "경과 시간으로 적분하므로
1회 전달이 downtime 전체를 정확히 재현한다"인데, 루프는 둘 다 어긴다.

### 수정

`#runPending`이 패스마다 한 번, `engine.deadlines.catchUpWindowMs`보다 오래 밀린 pending deadline이 있으면
`start()`가 쓰는 것과 **같은** `#recoverDeadlines(now)`를 적용한다(`engine.ts` `#catchUpOverdueDeadlines`).
창 안쪽이면 루프 동작은 이전과 완전히 동일하다. 재시도·특수 케이스 분기가 아니라, 이미 있는 §10.2 경로를 러닝
루프에도 적용하는 것이다.

수정 후 같은 31일 점프: **commits 10, 27 ms**, `deadline_gap_recovered=1`, `deadline_expired=2`.
(리뷰 라운드 1 M1 정정: 최초 보고의 "commits 4"는 `pump()`의 **반환값**이었고, 그 패스가 실제로 쓴
`commitStateTransition`은 10건이었다 — recovery 내부 트랜잭션이 반환값에 합산되지 않았다. 반환 계약을
고쳐 이제 둘이 같은 수다. 자세한 것은 아래 `## Review round 1`.)

## Debugging record — (2) `ingest.test.ts:442` write lock flaky

### 가설과 반증 관측

명세가 제시한 두 후보부터 코드로 확인했다.

| 후보 | 관측 | 결론 |
|---|---|---|
| 다른 테스트·워커와 DB 파일·WAL 공유 | `createEngineHarness()` → `createTempStore()`가 `mkdtempSync(join(tmpdir(), 'vl-db-'))`로 **테스트마다 새 디렉터리**를 만들고 `dispose()`가 지운다(`apps/server/src/db/testing/temp-store.ts`). vitest 4는 파일마다 격리 프로세스다 | **기각.** 공유 없음 |
| `busy_timeout` 부재 | `openDatabase()`가 `PRAGMA busy_timeout`을 반드시 설정하고 `assertPragmas()`가 되읽어 검증한다. 테스트 값은 `TEST_BUSY_TIMEOUT_MS = 250` | **기각.** 설정돼 있음 |

남은 가설: **엔드포인트는 정확히 답하지만 테스트의 `AbortSignal.timeout(2_000)` 예산보다 늦게 답한다.**
이 요청은 `commitIngestBatch`의 `BEGIN IMMEDIATE`가 동기(better-sqlite3) 호출 안에서 `busy_timeout`을 다 기다린
뒤에야 `SQLITE_BUSY`를 던지고, 그동안 이벤트 루프가 막힌다. 격리 실행에서는 여유가 크지만 전체 스위트가 병렬로
도는 호스트에서는 그렇지 않을 것이다.

반증 관측: 부하 아래에서도 요청 지연이 격리 실행과 비슷하게 400 ms 안팎이면 예산은 원인이 아니다.

### 실제 관측 — 요청 지연 계측

`post()`에 소요 시간 출력을 임시로 넣고(커밋하지 않음) `AbortSignal`을 30 s로 올려 **중단 대신 실제 지연을**
측정했다. write lock을 쥔 채 보내는 요청(`:442`가 그 첫 번째다):

| 조건 | 측정값 |
|---|---|
| `ingest.test.ts` 단독 실행 3회 | **418 ms · 392 ms · 425 ms** |
| 전체 `npm run test` 3회 | **1,384 ms · 661 ms · 808 ms** |
| 당시 예산 | **2,000 ms** |

즉 부하 아래 최악값이 예산의 **69 %**까지 올라간다. 이 호스트는 오케스트레이션 모델상 worker 2 + 리뷰어 1이
동시에 도는 상자이고(runbook §0), 내 측정은 세션 1개만 도는 상태였다. T21이 본 1/3 실패는 여기서 나온다.

### 원인

`AbortSignal.timeout(2_000)`은 **행(hang) 감지기**이지 지연 단언이 아니다(T8b가 고친 버그는 *무한* 대기였다).
그런데 값이 유휴 호스트 기준으로 잡혀 있어, 부하 아래의 정상 지연과 겹친다. SQLite도, 격리도, `busy_timeout`도
원인이 아니다.

### 수정

- 예산을 이름 있는 상수 `RESPONSE_BUDGET_MS = 15_000`으로 올리고 위 측정값을 주석에 남겼다. 함께
  `TEST_TIMEOUT_MS = 30_000`을 **describe 옵션**(`describe(name, { timeout }, fn)`)으로 두어, 실제로 행이
  나면 vitest 기본 타임아웃(5 s)이 아니라 예산이 보고하도록 했다. **재시도는 넣지 않았다.**
  (describe 옵션을 쓴 이유: `it`마다 세 번째 인자를 붙이면 prettier가 네 개의 `it` 본문을 전부 재들여쓰기해
  손대지도 않은 테스트가 diff에 잡힌다. 옵션 방식은 삭제 3줄로 끝난다. 옵션이 실제로 먹는지는 임시 probe로
  확인했다 — 기본 5 s에서는 6 s 테스트가 `Test timed out in 5000ms`로 실패하고, `{ timeout: 30_000 }`에서는
  통과한다.)
- 부하에 의존하지 않는 **결정적 재현 테스트**를 추가했다(`POST /ingest/simulator while the write lock outlasts
  the old budget`): write lock을 `busy_timeout = 2,500 ms`로 잡아 요청이 **매번** 2,000 ms를 넘게 만들고,
  그래도 503 `db_busy`가 오는지, 그리고 테스트가 그것을 보는지 검사한다. 이 테스트는 옛 예산에서 100 % 실패한다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `engine.deadlines.catchUpWindowMs` | 3600000 (1시간) | `provisional`(BOARD A-15) | 스펙 §10.2는 downtime 정책만 정하고 "얼마나 밀리면 downtime인가"는 정하지 않는다. 하한: 엔진은 `tickIntervalMs`(250 ms)마다 pump하므로 정상 운전에서 1시간 지연은 나올 수 없다. 상한: 창 안쪽을 1건씩 걷는 비용은 측정값 ≈118 commits/world-hour × ≈2–3 ms ≈ **0.3 s**로, writer 패스가 동기라서 그 시간 동안 프로세스 전체가 관측 불가가 되는 `supervisor.signalStaleAfterMs`(30 s)의 **1 %**에 머문다. Gate 0/2 승인값으로 교체 대상 |
| `RESPONSE_BUDGET_MS` (테스트 상수, `ingest.test.ts`) | 15000 | 측정 기반 | 부하 아래 최악 측정값 1,384 ms의 약 11배. config가 아니라 테스트 내부의 행 감지기이므로 `config/default.json`에 넣지 않았다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1a | (1) 재현 테스트가 수정 전 실패·수정 후 통과(되돌려 확인) | met | `apps/server/src/engine/clock-jump.test.ts`. **수정 전**(`#catchUpOverdueDeadlines(passNow)` 호출 1줄만 제거하고 실행): `× returns after a 31-day jump ... 251546ms → expected 88479 to be less than 200`, `× recovers once per pass ... 419433ms → expected undefined to be 1`. 창 안쪽 케이스(`leaves a gap inside the catch-up window`)는 수정 전후 모두 통과 — 루프 동작이 안 바뀐 증거다. **수정 후**: 6/6 통과, 31일 점프가 commits 10 · 27 ms(라운드 1 M1으로 정정된 실측 커밋 수) |
| 1b | (2) 재현 테스트가 수정 전 실패·수정 후 통과(되돌려 확인) | met | `ingest.test.ts` › `while the write lock outlasts the old budget`. **`RESPONSE_BUDGET_MS`를 2_000으로 되돌리면**: `× ... 3081ms → TimeoutError: The operation was aborted due to timeout`(100 % 실패). **15_000에서**: 통과, 요청 실측 2,864 ms |
| 2 | 10회 반복 flaky 0 | met | **라운드 1**: `ingest.test.ts` + `clock-jump.test.ts` 10회 연속 매회 `Tests 27 passed (27)`, 전체 `npm run test` 10회 연속 모두 `Tests 2091 passed \| 1 skipped (2092)` (아래 "정직 보고" 항목 참조). **라운드 2**(`engine.ts`를 고쳤으므로 엔진 디렉터리 전체): `npx vitest run apps/server/src/engine` 10회 연속 매회 `Test Files 17 passed (17) / Tests 124 passed (124)`, 실패 0 |
| 3 | 게이트 5개 녹색 | met | 아래 Gates |
| 4 | 기존 T8/T15 테스트 무변경 통과 | met | `apps/server/src/engine/ingest.test.ts`는 **§T8e가 직접 고치라고 지정한 예외**(108+/3-)이고, **그 외 T8/T15 테스트 파일은 무변경**이다(`git diff --stat origin/main...HEAD`에 `engine.ts`·`config.ts`·`config.test.ts`·`ingest.test.ts`·`clock-jump.test.ts`·`config/default.json`·티켓만). 전체 스위트 149파일 2,143건 통과(rebase 후) |
| 5 | PR CI 녹색 | met | **라운드 1**: run `32292215316` pass (3m31s). **라운드 2**(rebase 후 `1919af5`): run `32299862258` **pass** (2m59s) — https://github.com/dnhynk/vertical-live/actions/runs/32299862258 (attempt 1은 아래 Follow-ups의 `replay.test.ts` 부하 타임아웃으로 실패, 같은 커밋 재실행에서 녹색). 그 뒤 Follow-ups만 추가한 docs 커밋 `acbc5ef`의 run `32300903178`도 **pass** — https://github.com/dnhynk/vertical-live/actions/runs/32300903178 |

### Gates (executed — 라운드 1; 라운드 2 게이트는 아래 `## Review round 1` §Round 2 게이트)

```text
npm run format:check  -> pass ("All matched files use Prettier code style!")
npm run lint          -> pass (eslint 0, check-no-legacy-imports: ok (0 legacy imports),
                               check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads))
npm run typecheck     -> pass (tsc --build tsconfig.json, 출력 없음, exit 0)
npm run test          -> pass, 10회 연속 (Test Files 146 passed (146),
                               Tests 2091 passed | 1 skipped (2092))
npm run build         -> pass (contract/renderer/server/simulator/soak, migrations 6,
                               docs/ops/data-map.md up to date)
```

실행하지 않은 게이트: 없음.

**정직 보고 — 식별하지 못한 실패 1건.** 수정을 모두 넣은 뒤 처음 돌린 `npm run test`에서
`Tests 1 failed | 2090 passed | 1 skipped (2092)`가 나왔는데, **출력을 파일로 남기지 않아 어떤 테스트인지
확인하지 못했다.** 곧바로 출력을 캡처하며 **10회 연속 재실행했고 모두 통과**했으므로(위 수치), 재현하지 못한
상태로 남긴다. 해결했다고 쓰지 않는다. 이 브랜치가 건드린 두 테스트 파일은 별도로 10회 반복해 실패 0이다.

## Review round 1

리뷰어 verdict: `request_changes` (blocker 2 · major 1 · minor 1). 네 건 모두 타당했고, CLAUDE.md 디버깅
절차대로 **각각 먼저 재현한 뒤** 고치고, 고친 코드를 되돌려 재현 테스트가 다시 실패하는 것까지 확인했다.

| # | 지적 | 재현(수정 전) | 고침 | SHA |
|---|---|---|---|---|
| B1 | `engine.ts:750`·`:1554`·`:1563` — 러닝 catch-up이 부르는 `#recoverDeadlines()`가 `this.#world = recovery.state`를 DB commit **앞**에 대입. `deadline_recovery` commit에 `SQLITE_BUSY` 1회를 주입하면 DB엔 과거 pending deadline이 남는데 메모리는 이미 제거/재무장돼 다음 pass가 재시도하지 않고 health가 `degraded`→`live`로 거짓 회복(SQL 저장소 권위·§10.2·§11 위반) | `first pump returned 0` / `lastFailure "database is locked"` / **`db overdue pending 7`** / `degraded ["writer_failing"]` → 락 해제 후 **`second pump returned 0`**, **`db overdue pending 7`**, `degraded []`, `lifecycle live` | commit 성공 뒤에만 `recovery.state` 채택(store-first, `#applySteps()`와 같은 원칙). deliver 중 거부되면 마지막으로 저장소가 확인한 state로 메모리 되돌림 → 다음 pass가 같은 gap을 다시 보고 재시도, 그때까지 health 유지. `start()`도 같은 함수를 쓰므로 동일 수정이 start 경로에 그대로 적용된다 | `0091a06` |
| B2 | `engine.ts:1584` — recovery의 `plan.deliver`가 ordinary loop의 `#settleAcknowledgedFallback()` durable-ACK 검사를 건너뜀. 원본 `PAID_THANKS` ACK 후 audit-state commit 전 재시작 + 31일 전진 + `start()`이면 원본 row `ackedAt`이 있는데도 `fallback:true` 효과 1건 발행(§9.2 "대체 감사 연출 **한 번**"·§11 유료 무결성 위반) | `acked_at 2026-08-16T00:00:01.100Z` 인데 **`fallback stagings 1`**, `settled_by_ack undefined` | recovered deliver도 `#settleAcknowledgedFallback()`을 먼저 통과시켜, ACK가 durable하면 효과를 내지 않고 의무만 원자적으로 닫는다(ordinary loop와 완전히 같은 경유) | `0091a06` |
| M1 | `engine.ts:693` — `#catchUpOverdueDeadlines()`/`#recoverDeadlines()`가 `void`라 recovery 내부 트랜잭션이 `runPending()` 반환값에 합산되지 않음. 31일 점프에서 `pump()`는 4를 반환했지만 `stateRevision`은 10 증가 | `returned 4` / `revision delta 10` / `metrics.commit delta 9` / `deadline_recovery_commit 1` (합계 = 10 `commitStateTransition`) | 두 메서드가 커밋 수를 반환하고 `#runPending()`이 합산 → 반환값 = 그 패스의 실제 `commitStateTransition` 수. 테스트가 `expect(commits).toBe(stateRevision 증가분)`으로 계약을 고정한다. 티켓의 "4 commits" 근거를 **10**으로 정정(위 §수정, §Result, §Follow-ups) | `0091a06` |
| m1 | 티켓 `:157` — "T8/T15 테스트 파일은 하나도 수정하지 않았다"가 같은 문장의 `ingest.test.ts` 108+/3-와 모순 | — | "`ingest.test.ts`는 §T8e가 직접 지정한 예외, **그 외** T8/T15 테스트 파일 무변경"으로 정정 | 이 커밋 |

### 회귀 테스트 (되돌려 확인)

`apps/server/src/engine/clock-jump.test.ts`에 2건 추가 + 기존 1건에 반환 계약 단언 1줄 추가. `engine.ts`만
`git stash`로 되돌려 실행한 결과 — 세 지적이 각각 정확히 하나의 실패를 만든다:

```text
FAIL  ... > returns after a 31-day jump without walking the gap occurrence by occurrence
      AssertionError: expected 4 to be 10                                       (M1)
FAIL  ... > does not adopt a recovery the store refused, and retries it on the next pass
      AssertionError: expected 0 to be greater than 0                           (B1)
FAIL  ... > does not stage a substitute for a recovered fallback the renderer already acked
      AssertionError: expected [ { schemaVersion: 1, …(9) } ] to have a length of +0 but got 1   (B2)
Tests  3 failed | 3 passed (6)
```

수정 후: `Tests 6 passed (6)`.

B1 재현은 **실제 SQLite 락**이다(`better-sqlite3` 두 번째 연결이 `BEGIN IMMEDIATE`를 잡고, 프로덕션 연결의
`busy_timeout`이 지나 `SQLITE_BUSY`). 배치되는 것은 *시점*뿐이고 스토어·트랜잭션·에러는 전부 진짜다 — §11
fault matrix의 "DB lock" 행이며, 라이브 중 백업이 파일을 잡는 상황이 정확히 이 창에 들어온다.

### Round 2 게이트

`git fetch origin && git rebase origin/main`(main이 9 커밋 전진) **뒤** 5개 전부 재실행했다.

```text
npm run format:check  -> pass ("All matched files use Prettier code style!")
npm run lint          -> pass (eslint 0, check-no-legacy-imports: ok (0 legacy imports),
                               check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads))
npm run typecheck     -> pass (tsc --build tsconfig.json, 출력 없음, exit 0)
npm run test          -> pass (Test Files 149 passed (149),
                               Tests 2143 passed | 1 skipped (2144))
npm run build         -> pass (contract/renderer/server/simulator/soak, migrations 6,
                               docs/ops/data-map.md up to date)
```

반복: `npx vitest run apps/server/src/engine` **10회 연속** 매회 `Test Files 17 passed (17) / Tests 124
passed (124)`, 실패 0. 이번 라운드는 `engine.ts`를 고쳤으므로 두 파일이 아니라 엔진 디렉터리 전체를 반복했다.
rebase 전 기준으로 전체 `npm run test`도 4회 연속 `Tests 2093 passed | 1 skipped (2094)`로 실패 0이었다.

## Review round 2

리뷰어 verdict: `request_changes` (blocker 1). 라운드 1의 B1·B2·M1·m1은 **해소 확인**을 받았고(게이트 5개와
head `0720d41`의 CI run `32301155923` 녹색 포함), 남은 blocker 하나는 라운드 1의 store-first 수정이 *첫*
트랜잭션에만 적용됐다는 지적이다. 타당하다. 아래도 CLAUDE.md 디버깅 절차대로 **먼저 재현**한 뒤 고쳤다.

> 라운드 1 표의 SHA는 그 뒤 두 번의 rebase로 다시 쓰였다: `17fee1a` → `00bed27` → **`0091a06`**. 위 표를
> 현재 값으로 정정했다.

### 가설 → 반증 관측 → 실측

**가설.** recovery는 트랜잭션이 하나가 아니다. `deadline_recovery` commit 1건 + `plan.deliver` 1건당 1건이다.
그런데 첫 commit이 영속시키는 `recovery.state`는 세계가 **deliver까지 마친 뒤**의 상태라 deliver 대상이 이미
pending set에서 빠져 있고, 따라서 `deadlineTableDiff`가 그 행들을 `cancelled`로 닫는다. 그 뒤 per-deadline
commit이 거부되면 `catch`가 `durable = recovery.state`로 되돌리는데 거기엔 **재시도할 것이 남아 있지 않다**.

**이 가설을 반증할 관측.** 가설이 틀렸다면, recovery commit 직후 첫 전달 전에 락을 잡았을 때 (a) DB에 overdue
pending 행이 남아 있고, (b) 락 해제 후 다음 pass가 그 전달을 완료해야 한다. 하나라도 관측되면 가설 기각.

**실측.** `better-sqlite3` 두 번째 연결이 recovery commit **직후** `BEGIN IMMEDIATE`를 잡아 첫 전달이
`busy_timeout` 만료로 실제 `SQLITE_BUSY`를 받게 한 probe(수정 전 = `engine.ts`만 되돌린 트리):

```text
pump  {"refused":0,"lastFailure":"database is locked","lifecycle":"degraded",
       "overduePending":0,"overdueKinds":[],
       "cancelled":["chapter_beat/replay","mission_close/coalesce","need_decay/coalesce",
                    "weather_change/coalesce","world_phase/coalesce"],"gapRecovered":1}
락 해제 후 {"retried":0,"overduePending":0,"gapRecovered":1,"lifecycle":"live"}
start {"thrown":"database is locked","overduePending":0,"overdueKinds":[]}
다음 부팅 {"overduePending":0,"lifecycle":"live","revision":2}
```

반증 관측은 하나도 나오지 않았다. §10.2가 "전달한다"고 정한 `replay`·`coalesce` 점유 5건이 전부 `cancelled`로
닫혔고, 다음 pass는 0 커밋·`deadline_gap_recovered` 그대로 1·`live`(거짓 회복)였다. start 경로도 같다: 다음
부팅이 같은 리비전대(revision 2)에서 overdue 0으로 올라온다 — 수정 후 같은 시나리오의 revision 9와 비교하면
**전달 7건이 조용히 사라진 것**이다. 스펙 §10.2·§11 위반, 리뷰어 재현과 일치.

### 고침

| # | 지적 | 재현(수정 전) | 고침 | SHA |
|---|---|---|---|---|
| B3 | `engine.ts:1583`·`:1595`·`:1605`·`:1634` — `deadline_recovery` commit이 `recovery.state`(deliver가 이미 빠진 상태)를 영속시켜 deliver 행을 `cancelled`로 닫음. 이후 per-deadline commit이 거부되면 `catch`의 복원 지점에 재시도할 것이 없음 → pump 0·degraded인데 overdue 0, 다음 pump 0·`deadline_gap_recovered` 1·`live`(거짓 회복). start 경로는 다음 부팅이 같은 리비전에서 overdue 0으로 `live` | 위 §실측 블록(수정 전 4줄). `cancelled` 5행 = `chapter_beat/replay` + coalesce 4건, 다음 pass `retried 0`, 다음 부팅 `revision 2` | **(b) deliver deadline을 각 전달 트랜잭션이 성공할 때까지 durable pending으로 유지.** recovery commit이 채택하는 것은 그 commit이 실제로 정산한 것뿐 — 만료와 재무장된 후속뿐이고, 전달을 아직 빚진 타이머는 자기 트랜잭션이 `fired`로 닫을 때까지 `pending` 행으로 남는다. store-first가 첫 트랜잭션이 아니라 **트랜잭션마다** 성립한다. 새 모듈 함수 `withDeliveriesPending()`이 `recovery.state`에 그 타이머들을 되돌려 놓고, commit·`durable`·`this.#world`가 모두 그 상태를 쓴다. 전달 경로 자체는 무수정이라 durable-ACK 검사와 "결제 1건당 대체 감사 1회" 불변조건은 그대로 | `57bde88` |

원자적 recovery(선택지 (a))를 택하지 않은 이유: `#applySteps()`는 이미 여러 step을 한 트랜잭션에 담지만, 만료·
재무장은 step이 아니라 `recovery.state`에서 오므로 합치려면 `#applySteps()`에 base-state와 `expired` 인자를
추가해야 하고, 한 리비전에 `deadline_recovery` 전이 종류가 사라진다. (b)는 §10.2가 이미 말하는 것 — "전달될
점유는 아직 살아 있는 타이머" — 을 저장소에 그대로 적는 쪽이고, 실패 시 남은 전달만 다음 pump/start가 이어받는다.
멱등성도 (b) 쪽이 강하다: 재시도에서 `plan.expired`·`plan.rescheduled`가 비므로 두 번째 `deadline_recovery`
commit은 아예 일어나지 않고, 남은 전달만 실행된다(아래 `gapRecovered 2`·`retried 7`).

### 회귀 테스트 (되돌려 확인)

`clock-jump.test.ts`에 2건 추가 — pump 경로와 start 경로가 같은 창을 각각 덮는다. 락 시점만 한 커밋 뒤로 옮긴
`lockAfterDeadlineRecovery()` 훅을 쓰며, 라운드 1과 마찬가지로 **스토어·트랜잭션·에러는 전부 진짜**다(§11 fault
matrix "DB lock"). 훅은 `store.commitStateTransition`을 테스트에서 감싸는 것뿐이라 리뷰어가 소스 무수정으로
동등 재현할 수 있다.

`engine.ts`만 되돌려 실행한 결과 — 지적이 정확히 두 개의 실패를 만들고, 기존 6건은 그대로 통과한다:

```text
FAIL  ... > keeps a recovered delivery pending when its own transaction is refused
      AssertionError: expected 0 to be greater than 0        (clock-jump.test.ts:285, overdue pending)
FAIL  ... > keeps a recovered delivery pending when start() is refused, and finishes it on the next boot
      AssertionError: expected 0 to be greater than 0        (clock-jump.test.ts:329, overdue pending)
Tests  2 failed | 6 passed (8)
```

수정 후: `Tests 8 passed (8)`. 같은 probe의 수정 후 실측 —

```text
pump  {"refused":0,"lastFailure":"database is locked","lifecycle":"degraded",
       "overduePending":5,
       "overdueKinds":["need_decay/coalesce","mission_close/coalesce","weather_change/coalesce",
                       "world_phase/coalesce","chapter_beat/replay"],
       "cancelled":[],"gapRecovered":1}
락 해제 후 {"retried":7,"overduePending":0,"gapRecovered":2,"lifecycle":"live"}
start {"thrown":"database is locked","overduePending":5,"overdueKinds":[…같은 5건]}
다음 부팅 {"overduePending":0,"lifecycle":"live","revision":9}
```

`cancelled` 0건, overdue 5건 잔존, 다음 pass가 7커밋으로 전달을 마치고서야 `live`. start 경로도 다음 부팅이
같은 5건을 찾아 revision 9까지 올린다.

### Round 3 게이트

`git fetch origin && git rebase origin/main`(main이 3 커밋 전진) 뒤 5개 전부 재실행했다.

```text
npm run format:check  -> pass ("All matched files use Prettier code style!")
npm run lint          -> pass (eslint 0, check-no-legacy-imports: ok (0 legacy imports),
                               check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads))
npm run typecheck     -> pass (tsc --build tsconfig.json, 출력 없음, exit 0)
npm run test          -> pass (Test Files 149 passed (149),
                               Tests 2145 passed | 1 skipped (2146))
npm run build         -> pass (contract/renderer/server/simulator/soak, migrations 6,
                               docs/ops/data-map.md up to date)
```

반복: `npx vitest run apps/server/src/engine` **10회 연속** 매회 `Test Files 17 passed (17) / Tests 126
passed (126)`, 실패 0.

CI: head `7be10ee`에서 run
[`32305049033`](https://github.com/dnhynk/vertical-live/actions/runs/32305049033) **success**(3m31s,
attempt 1). 라운드 2의 후속 항목이던 `replay.test.ts` 5 s 타임아웃은 이번 attempt 1에서 재현되지 않았다 —
후속 T8f의 진단(러너 처리량)과 모순되지 않지만, 해결됐다는 근거도 아니므로 후속은 그대로 둔다.

## Not done / out of scope

- `MAX_STEPS_PER_PASS`(100,000)는 그대로 뒀다. 31일 점프에서도 88,479 < 100,000이라 이 가드는 **한 번도
  발동하지 않았고**(관측표의 `pass_limit_reached` = 0), 따라서 이번 증상의 원인도 해법도 아니다.
- 러닝 루프의 catch-up은 `#recoverDeadlines`를 **그대로 재사용**한다. §10.2 정책 자체(T7 `deadlines.ts`)는
  건드리지 않았다.
- `ingest.test.ts`의 나머지 단언(503·`db_busy`·미처리 rejection 0·inbox 미유입)은 그대로다. 예산 상수와
  per-test 타임아웃만 바뀌었다.

## Follow-ups

- **`apps/server/src/engine/replay.test.ts`의 vitest 기본 5 s 타임아웃이 CI 부하에서 끊어진다 — 이 PR
  범위 밖(코디네이터 결정, 후속 T8f).** rebase 후 첫 CI(run `32299862258` **attempt 1**)가
  `replay determinism > two boots over the same inbox reach the same snapshot and revision`에서
  `Test timed out in 5000ms`로 실패했다. 이 파일은 T8 파일이고 이 브랜치가 건드리지 않았다. 로직이 아니라
  러너 처리량 문제라는 관측 근거:
  - 같은 커밋 `1919af5`의 **attempt 2는 그대로 통과**(2m59s).
  - 같은 커밋 두 시도의 vitest `tests` CPU 시간이 **317.73 s vs 119.44 s**(2.7배). 같은 러너에서
    `clock-jump.test.ts`도 **8,209 ms vs 2,489 ms**로 같이 느려졌다 — 특정 테스트의 회귀가 아니라 전체가
    느려진 것이다.
  - 로컬 단독 실행은 `199–203 ms`(5 s 대비 25배 여유). 이번 라운드의 `engine.ts` 수정 **전/후**가 각각
    `201/199/199 ms` vs `203 ms`로 구분되지 않는다 — 이 브랜치가 느리게 만든 것이 아니다.
  - rebase **전** 이 브랜치 CI는 `tests 73.76 s`(146파일)였는데 main 단독 CI는 `tests 271.98 s`(149파일)다.
    최근 main 머지들로 스위트 CPU 시간이 3.7배 늘었고, 그 부하에서 스위트 전체를 통틀어 가장 얇은 여유였던
    `replay.test.ts`의 기본 타임아웃이 먼저 끊어졌다.
  - 후속에서 볼 것: main 스위트 CPU 시간 3.7배 증가의 원인 파일 계측, 그리고 기본 5 s 타임아웃에 기대고 있는
    무거운 테스트들의 여유 점검.

- `engine.deadlines.catchUpWindowMs`는 Gate 0/2 승인 수치로 교체 대상(A-15). 지금 값의 근거는 위 Assumptions.
- `chapter_beat`는 `policy: replay`이므로 catch-up 뒤에도 밀린 만큼 순차 전달된다(day 스케일이라 31일 ≈ 90건,
  측정상 패스 전체가 10 commits로 수렴). 더 짧은 주기의 `replay` 종류가 생기면 그때 다시 볼 것.
