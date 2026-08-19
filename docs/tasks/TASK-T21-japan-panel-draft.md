# TASK-T21-japan-panel-draft

- Task: T21 일본 패널·5초 이해 테스트·24h 콘텐츠 목록·일본 시장 증빙 초안 (`docs/tasks/TASK_SPECS.md` §T21)
- Branch: `dnhynk/t21-japan-panel-draft` · PR: #<n>
- Orca: task `task_5ccfd178a887` · dispatch `ctx_8fda1be1b646`
- Spec sections read: §5.2, §5.3, §6.2, §6.4, §12.5, §14.1, §14.2(1), §15(Gate 0·Gate 3·Gate 4), §17, §18
- BOARD decisions/assumptions relied on: D-8, D-9, D-10, D-14, D-15, A-1, A-9, A-15

## Goal

Gate 0 §1.4의 네 항목(일본 패널 모집 조건 · 5초 무음 이해 테스트 통과 기준 · 24시간 콘텐츠 목록과 반복 장면 표본
기준 · 일본 시장 증빙 방식과 Gate 4 합격 기준)을 사용자가 **승인 또는 반려할 수 있는 형태의 초안**으로 만든다
(D-15: 코디네이터가 초안 제안 → 사용자 승인). 이 문서의 모든 숫자는 '제안'이며 승인 전에는 합격선이 아니다.
콘텐츠 목록은 상상이 아니라 T7 디렉터 코드(`apps/server/src/world`)가 실제로 낼 수 있는 사건·챕터에서 도출한다.

## Plan

1. 읽기: runbook 3장 → `CLAUDE.md` → TASK_SPECS 공통 규약·§T21·§T14·§T7 → BOARD D-15·D-8 →
   스펙 §5.2·§5.3·§6.2·§12.5·§14.2(1)·§15·§17 → `docs/ops/gate0-checklist.md` §1.4, `docs/ops/gate2-experiments.md`.
2. 콘텐츠 목록 도출: `apps/server/src/world`의 정의 테이블(`content/chapters.ts`, `content/variants.ts`,
   `content/tuning.ts`, `time.ts`, `types.ts`, `deadlines.ts`)에서 식별자를 읽고, 빌드한 `runWorld()`로 입력 0의
   가상 24시간을 여러 시드로 실행해 **JST 시간대별로 실제 발생한 사건**을 집계한다. 문서의 사건명은 코드 식별자
   그대로 쓰고 grep 명령을 증빙으로 붙인다.
3. 외부 주장 확인: (a) 표본 크기·5초 테스트 관련 UX 리서치 관행, (b) YouTube Analytics geography aggregate와
   개인정보 threshold, (c) vertical feed traffic source. 각각 공식/1차 출처 URL과 확인 날짜를 남기고, 확정하지
   못한 값은 "제안(근거 없음)"으로 표기한다.
4. `docs/ops/japan-panel-plan.md` 신규 작성 — 4개 장(패널 모집 / 5초 테스트 / 24h 콘텐츠 목록 / 일본 시장 증빙),
   숫자마다 `제안` 라벨 + 근거 열, 승인 기록 자리(BOARD `D-*`)를 둔다.
5. `docs/ops/gate0-checklist.md` §1.4만 "초안 제출(T21 PR #n), 승인 대기"로 갱신(다른 항목·다른 절 손대지 않음).
6. 게이트 5종 실행 → 커밋·push → PR(`docs(gate0):`) → CI 확인 → worker_done.

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
(작성 중)
```

## Not done / out of scope

- 패널 실제 모집·실행·결과 기록(사용자 작업, D-15)
- 코드 변경(T21은 문서 전용)

## Follow-ups

- 사용자 승인 후 승인값을 BOARD `D-*`에 기록하고 `gate0-checklist.md` §1.4 체크박스를 채우는 후속 task
