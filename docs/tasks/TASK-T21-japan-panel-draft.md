# TASK-T21-japan-panel-draft

- Task: T21 일본 패널·5초 이해 테스트·24h 콘텐츠 목록·일본 시장 증빙 초안 (`docs/tasks/TASK_SPECS.md` §T21)
- Branch: `dnhynk/t21-japan-panel-draft` · PR: #27
- Orca: task `task_5ccfd178a887` · dispatch `ctx_8fda1be1b646`
- Spec sections read: §5.1, §5.2, §5.3, §6.2, §6.3, §6.4, §12.2, §12.3, §12.4, §12.5, §14.1, §14.2(1),
  §15(Gate 0·Gate 3·Gate 4), §17, §18
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
   `content/tuning.ts`, `time.ts`, `types.ts`)에서 식별자를 읽고, 빌드한 `runWorld()`로 입력 0의 가상 24시간을
   여러 시드로 실행해 **JST 시간대별로 실제 발생한 사건**을 집계한다. 문서의 사건명은 코드 식별자 그대로 쓰고
   grep 명령을 증빙으로 붙인다.
3. 외부 주장 확인: (a) 표본 크기·5초 테스트 관련 UX 리서치 관행, (b) YouTube Analytics geography aggregate와
   개인정보 threshold, (c) traffic source. 각각 출처 URL과 확인 날짜를 남기고, 확정하지 못한 값은
   "확인 필요(출처 없음)"으로 표기한다.
4. `docs/ops/japan-panel-plan.md` 신규 작성 — 4개 장, 숫자마다 `제안` 라벨 + 근거/무근거, 승인 요청 표.
5. `docs/ops/gate0-checklist.md` §1.4만 "초안 제출(T21 PR #27), 승인 대기"로 갱신.
6. 게이트 5종 실행 → PR(`docs(gate0):`) → CI 확인 → worker_done.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| 정성 사용성 테스트 표본 5명 | https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/ | 2026-08-19 | Jakob Nielsen, 2000-03-18. "테스트는 5명 이하로 하고 작은 테스트를 여러 번" — 문제 발견용 권장치. 1단계 n=5의 근거 |
| 정량 사용성 표본 크기 | https://www.nngroup.com/articles/summary-quant-sample-sizes/ | 2026-08-19 | Budiu·Moran, 2021-07-25. 이항 지표·95% 신뢰수준·±15%p → 40명 권장. 2단계 n=40과 오차 해석의 근거 |
| 5초 테스트의 정의·한계 | https://www.nngroup.com/articles/testing-visual-design/ | 2026-08-19 | Megan Chan, 2024-12-13. 5초 테스트는 **첫인상** 방법이고 5초는 카피를 읽기에 부족. 시간 제한을 미리 알리면 안 됨. 문서 2.5·2.6의 근거 |
| Prolific 참가자 국가 | https://researcher-help.prolific.com/en/articles/445224-who-are-the-participants-on-prolific | 2026-08-19 | 참가자는 대부분 OECD 회원국 거주, **일본 포함**. 모집 경로 후보 1개 확인 |
| Analytics `country` 차원 | https://developers.google.com/youtube/analytics/dimensions | 2026-08-19 | `country`는 ISO-3166-1 alpha-2(일본 `JP`), 식별 불가 행은 `ZZ`. 일본 시장 증빙의 기본 차원 |
| Analytics limited data | https://support.google.com/youtube/answer/9101241 | 2026-08-19 | "국가/지역 관련 지표·차원은 limited될 수 있다", **임계치는 비공개이며 변경 가능**. §15 Gate 4의 "국가 데이터 없으면 선언하지 않음"과 직접 연결 |
| traffic source 값 | https://developers.google.com/youtube/analytics/dimensions#Traffic_Source_Dimensions | 2026-08-19 | `BROWSE`, `SHORTS`, `LIVE_REDIRECT` 등. **세로 Live 피드 유입이 어느 값인지는 문서에서 확정 못 함** → "확인 필요" |
| engaged views 정의 | https://support.google.com/youtube/answer/9313698 | 2026-08-19 | 이 페이지에 engaged views의 **독립 정의가 없다**(평균 시청 지속시간 설명 안에서 1회 언급). 세로 Live 제공 여부 → "확인 필요" |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) | — | 스펙·BOARD·공식 문서·코드로 전부 확정했고, 확정 못 한 것은 문서에 "확인 필요(출처 없음)"으로 남겼다 |

## Assumptions / provisional values

문서의 숫자는 전부 `제안` 라벨이 붙어 있고 승인 전에는 합격선이 아니다(D-15). 근거 없는 제안만 다시 적는다.

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 5초 테스트 문항별 통과선 | Q1 80% / Q2 70% / Q3 70% / Q4 50%, 종합 70% | `제안(근거 없음)` | 스펙에 값이 없고 공식 문서에도 없다. 사용자 승인 대상 |
| Gate 3 미시작 조건 | Q3 < 50% | `제안(근거 없음)`(조건의 취지는 §2.3) | 무료 명령을 못 읽으면 무료 핵심 플레이가 화면에서 성립하지 않는다 |
| 반복 장면 합격선 | 고유 전이 ≥ 60, 반복 서사 장면 비율 ≤ 0.55 | `제안(근거: 측정값 + 임의 여유폭)` | 관측 70–83 / 0.339–0.475에서 여유를 둔 값. 여유폭 자체는 근거 없음 |
| 사람 표본 검토 | 매일 6구간 × 5분 | `제안(근거 없음)` | §12.5는 "정기적 표본 검토"만 요구하고 주기·표본을 정하지 않는다 |
| Gate 4 기간 | baseline 14일 → freeze → validation 14일, 가동률 ≥ 90% | `제안(근거 없음)` | §15는 "겹치지 않는 post-freeze validation"만 요구한다 |
| Gate 4 절대 통과선 | **제안하지 않음** | — | §14.1이 "기준선 수집 뒤, 결과를 보기 전에 고정"을 요구하므로 기준선이 없는 지금은 숫자를 만들 수 없다. 절차와 식의 형태만 제안 |
| 명령 성공률 하한 | ≥ 70% | `제안(근거 없음)` | 유일하게 baseline 없이 절대값을 제안한 항목. 근거 없음을 문서에 명시 |
| 패널 부수 조건 | OS 배분 1/3, 1인 10분, 1인당 자극물 2종, 채점자 2인 | `제안(근거 없음)` | 실행 편의값 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 모든 숫자에 '제안' 라벨과 근거/무근거 표기; 외부 주장에 URL·확인 날짜 | met | 문서 §0이 라벨 규약을 정의하고, §1–§4의 모든 수치 표에 `제안(근거: …)` / `제안(근거 없음)` / `측정값(…)` / `확인 필요(출처 없음)` 중 하나가 붙어 있다. 외부 주장은 §6 출처 표([P1]–[P8])에 URL과 확인일 2026-08-19로 있다 |
| 2 | 콘텐츠 목록의 사건명이 T7 코드의 실제 사건 식별자와 일치(grep 증빙) | met | 문서 §3.1(a)에 grep 명령 3개, §3.2에 식별자마다 `파일:줄`. 아래 "재현한 명령" 참조 |

### 재현한 명령과 출력 (요약)

식별자 대조(grep):

```text
$ grep -n "export const CHAPTER_IDS" apps/server/src/world/types.ts
97:export const CHAPTER_IDS = ['gathering', 'festival_prep', 'growth_choice'] as const

$ grep -on "eventCombinationId: '[a-z_]*'" apps/server/src/world/content/chapters.ts
60:eventCombinationId: 'combo_forage_garden'      97:eventCombinationId: 'combo_lantern_row'
69:eventCombinationId: 'combo_river_walk'        106:eventCombinationId: 'combo_music_practice'
78:eventCombinationId: 'combo_rest_indoors'      115:eventCombinationId: 'combo_night_stalls'
134:eventCombinationId: 'combo_grow_swift'       143:eventCombinationId: 'combo_grow_gentle'
152:eventCombinationId: 'combo_grow_curious'

$ grep -on "ruleId: '[a-z_]*'" apps/server/src/world/content/chapters.ts   -> 10 rules (183..237)
$ grep -c "variantId: '" apps/server/src/world/content/variants.ts         -> 71
```

입력 0 가상 24시간 실행(문서 §3.1(b)의 명령 그대로, `npm run build -w @vl/server` 뒤):

```text
seed_day_1 steps=2844 transitions=2004 unique=70 repeatedNarrative=0.455 {"seconds":1647,"minutes":328,"hours":22,"day":7}
seed_day_2 steps=2844 transitions=2004 unique=83 repeatedNarrative=0.339 {"seconds":1647,"minutes":328,"hours":22,"day":7}
seed_day_3 steps=2831 transitions=1990 unique=76 repeatedNarrative=0.475 {"seconds":1634,"minutes":328,"hours":21,"day":7}
seed_day_4 steps=2844 transitions=2004 unique=74 repeatedNarrative=0.438 {"seconds":1647,"minutes":328,"hours":22,"day":7}
seed_day_5 steps=2827 transitions=1986 unique=83 repeatedNarrative=0.425 {"seconds":1630,"minutes":328,"hours":21,"day":7}

seed_day_1 타임라인 발췌(JST):
  06:00 chapter_started -> gathering        14:24 chapter_beat -> turn + choice_opened -> director
  14:44 choice_resolved -> combo_forage_garden [forage_garden]
  21:00 phase_changed -> night, crisis_entered -> sleeping [crisis_sleep_curl]
  22:40 growth_stage_advanced -> hatchling  23:16 chapter_resolved -> resolution [forage_garden]
  다음 06:00 chapter_started -> festival_prep
```

### Gates (executed)

```text
npm run format:check  -> pass ("All matched files use Prettier code style!")
npm run lint          -> pass (eslint 0, check-no-legacy-imports: ok (0), check-install-scripts: ok (4 reviewed))
npm run typecheck     -> pass (tsc --build, 출력 없음)
npm run test          -> pass (Test Files 139 passed (139), Tests 1955 passed | 1 skipped (1956), 76.43s)
npm run build         -> pass (전 워크스페이스 tsc --build 완료)
```

실행하지 않은 게이트: 없음. (`origin/main` `c56f9d4` 위로 rebase한 뒤 실행했다.)

### 코드 변경 없음

이 PR은 문서 2개만 바꾼다. `git diff --stat origin/main...HEAD`가 `docs/` 밖으로 나가지 않는다.
`packages/contract` 변경 0(이 task는 `[contract]`가 아니다), 새 dependency 0.

## Not done / out of scope

- 패널 실제 모집·실행·보상 집행·결과 기록 — 사용자 작업(D-15, 스펙 §15 Gate 0).
- Gate 4의 **절대 통과 숫자** — 기준선이 없어 만들 수 없다(스펙 §14.1). 절차와 식의 형태만 제안했다.
- 코드 변경 일절 없음. 아래 Follow-up 2건은 이 PR에서 고치지 않았다.

## Follow-ups

- **명령 성공률이 `GET /metrics`에 노출되지 않는다.** `commandSuccessRatio`는 구현되어 있으나
  (`apps/server/src/input/metrics.ts:25`) production 경로 `chatParserPort`가 `metrics`를 주입하지 않는다
  (`apps/server/src/youtube/chat/runtime.ts:124`). Gate 4 참여 축에서 쓰려면 배선이 필요하다(문서 §4.5, §5 A-6).
- **`choice.previewLeadMs`(30분)가 정의만 있고 reducer가 참조하지 않는다**(`world/content/tuning.ts:168`).
  "다음 선택 30분 전 예고"는 현재 동작하지 않으며, 5초 테스트 Q4의 난이도와 직접 관련이 있다(문서 §2.6, §5 A-8).
- 사용자 승인 뒤: 승인값을 BOARD `D-*`에 기록하고 `gate0-checklist.md` §1.4 체크박스를 채우는 후속 task.
  승인된 반복 장면 기준은 `world/content/tuning.ts`의 `FRESHNESS_MINIMUMS`를 교체하고 `provisional`에서 뺀다.
- T19(PR #25)가 같은 `gate0-checklist.md`를 고치고 있다. #25가 먼저 머지되면 이 브랜치를 rebase한다.
