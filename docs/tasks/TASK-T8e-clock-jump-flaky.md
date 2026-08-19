# TASK-T8e-clock-jump-flaky

- Task: T8e 엔진 후속 — 가상 시계 31일 점프 후 `pump()` 미반환 · `ingest.test.ts` SQLite write lock flaky (`docs/tasks/TASK_SPECS.md` §T8e)
- Branch: `dnhynk/t8e-clock-jump-flaky` · PR: #<n>
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

수정 후 같은 31일 점프: **commits 4, 27 ms**, `deadline_gap_recovered=1`, `deadline_expired=2`.

## Debugging record — (2) `ingest.test.ts:442` write lock flaky

<pending>

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
<pending>
```

## Not done / out of scope

- …

## Follow-ups

- …
