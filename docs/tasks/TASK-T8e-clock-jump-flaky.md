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
