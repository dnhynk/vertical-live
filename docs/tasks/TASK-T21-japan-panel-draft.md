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
4. `docs/ops/content-and-market-criteria.md` 신규 작성 — 4개 장, 숫자마다 `제안` 라벨 + 근거/무근거, 승인 요청 표.
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
| traffic source 값 (Query API) | https://developers.google.com/youtube/analytics/dimensions#Traffic_Source_Dimensions | 2026-08-19 | `insightTrafficSourceType`에 `SHORTS`·`LIVE_REDIRECT` 등. **이 값 목록에는 세로 Live 피드에 대응하는 값이 없다**(확인일 기준) → Query API 쪽만 "확인 필요". 리뷰 round 2 m1에서 범위를 좁혔다 |
| playback location 값 | https://developers.google.com/youtube/analytics/dimensions#Playback_Location_Dimensions | 2026-08-19 | `BROWSE`(홈·구독 피드 등 탐색 기능에서의 재생)는 traffic source가 아니라 **`insightPlaybackLocationType`** 값이다. 리뷰 round 1 m1에서 정정 |
| engaged views (도움말) | https://support.google.com/youtube/answer/9313698 | 2026-08-19 | 이 **도움말 페이지**에는 engaged views의 독립 정의가 없다(평균 시청 지속시간 설명 안에서 1회 언급). 남은 "확인 필요"는 **Studio 화면 표기**뿐이다 — API 정의는 아래 Reporting API 행에 있다. 리뷰 round 2 m1 |
| **Reporting API** traffic source 값 (bulk) | https://developers.google.com/youtube/reporting/v1/reports/dimensions | 2026-08-19 | 채널 리포트 차원 `traffic_source_type` 값 **`31` = `Vertical live feed`**("Views originated from the vertical live feed."). Query API의 `insightTrafficSourceType`과 **다른 차원**이다. 리뷰 round 2 m1 |
| **Reporting API** 채널 리포트 스키마 | https://developers.google.com/youtube/reporting/v1/reports/channel_reports | 2026-08-19 | `channel_traffic_source_a3` 차원 = `date, channel_id, video_id, live_or_on_demand, subscribed_status, country_code, traffic_source_type, traffic_source_detail`, 지표에 `engaged_views` 포함. 일본 × 세로 Live 유입 × engaged views가 **한 리포트 안에** 있다. 리뷰 round 2 m1 |
| **Reporting API** 지표 정의 | https://developers.google.com/youtube/reporting/v1/reports/metrics | 2026-08-19 | `engaged_views` = "The number of times the channel's videos have been viewed past the initial seconds". 리뷰 round 2 m1 |

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
| Gate 4 관측 구간 길이 | baseline 14일 → freeze → 겹치지 않는 validation 14일 | `제안(근거 없음)` | §15는 "겹치지 않는 post-freeze validation"만 요구한다. 구간 **길이**는 절차값이고 합격선이 아니다 |
| Gate 4 절대 통과선·표본 하한(가동률·명령 성공률 포함) | **제안하지 않음** | — | §14.1이 "기준선 수집 뒤, 결과를 보기 전에 고정"을 요구하므로 기준선이 없는 지금은 숫자를 만들 수 없다. 지표·계산식·freeze 절차만 제안하고, 숫자는 freeze 단계에서 처음 정한다(리뷰 round 1 M1) |
| 패널 부수 조건 | OS 배분 1/3, 1인 10분, 1인당 자극물 2종, 채점자 2인 | `제안(근거 없음)` | 실행 편의값 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 모든 숫자에 '제안' 라벨과 근거/무근거 표기; 외부 주장에 URL·확인 날짜 | met | 문서 §0이 라벨 규약을 정의하고, §1–§4의 모든 수치 표에 `제안(근거: …)` / `제안(근거 없음)` / `측정값(…)` / `확인 필요(출처 없음)` 중 하나가 붙어 있다. 외부 주장은 §6 출처 표([P1]–[P12])에 URL과 확인일 2026-08-19로 있다. 리뷰 round 2 m1에서 지적된 세로 Live 피드 유입·engaged views 서술의 결함(공식 Reporting API 문서를 확인하지 않고 "문서에서 확정 못 함"이라고 쓴 것)은 `c961f32`에서 고쳤다 |
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

리뷰 round 1 수정 뒤 `origin/main` `c6bbf0d` 위로 rebase한 상태에서 다시 돌린 결과다.

```text
npm run format:check  -> pass ("All matched files use Prettier code style!")
npm run lint          -> pass (eslint 0, check-no-legacy-imports: ok (0), check-install-scripts: ok (4 reviewed))
npm run typecheck     -> pass (tsc --build, 출력 없음)
npm run test          -> pass (Test Files 139 passed (139), Tests 1955 passed | 1 skipped (1956), 120.38s)
npm run build         -> pass (전 워크스페이스 tsc --build, data-map up to date)
```

실행하지 않은 게이트: 없음. (round 0은 `c56f9d4` 위에서 같은 5개가 pass했고 결과 수치도 같았다.)

### 코드 변경 없음

이 PR은 문서 **3개**만 바꾼다. `git diff --name-only origin/main...HEAD`:

```text
docs/ops/gate0-checklist.md
docs/ops/content-and-market-criteria.md
docs/tasks/TASK-T21-japan-panel-draft.md
```

`docs/` 밖으로 나가지 않는다. `packages/contract` 변경 0(이 task는 `[contract]`가 아니다), 새 dependency 0.

## Not done / out of scope

- 패널 실제 모집·실행·보상 집행·결과 기록 — 사용자 작업(D-15, 스펙 §15 Gate 0).
- Gate 4의 **절대 통과 숫자** — 기준선이 없어 만들 수 없다(스펙 §14.1). 절차와 식의 형태만 제안했다.
- 코드 변경 일절 없음. 아래 Follow-up 2건은 이 PR에서 고치지 않았다.

## Follow-ups

- **명령 성공률이 `GET /metrics`에 노출되지 않는다.** `commandSuccessRatio`는 구현되어 있으나
  (`apps/server/src/input/metrics.ts:25`) production 경로 `chatParserPort`가 `metrics`를 주입하지 않는다
  (`apps/server/src/youtube/chat/runtime.ts:124`). Gate 4 참여 축에서 쓰려면 배선이 필요하다(문서 §4.5, §5 A-8).
- **`choice.previewLeadMs`(30분)가 정의만 있고 읽는 코드가 없다.** 정의는 `world/content/tuning.ts:79`(타입)·
  `:168`(기본값)·`config/default.json:278`(설정값) 3곳이고 런타임·reducer 소비처는 0곳이다.
  "다음 선택 30분 전 예고"는 현재 동작하지 않으며, 5초 테스트 Q4의 난이도와 직접 관련이 있다(문서 §2.6, §5 A-8).
- 사용자 승인 뒤: 승인값을 BOARD `D-*`에 기록하고 `gate0-checklist.md` §1.4 체크박스를 채우는 후속 task.
  승인된 반복 장면 기준은 `world/content/tuning.ts`의 `FRESHNESS_MINIMUMS`를 교체하고 `provisional`에서 뺀다.
- ~~T19(PR #25)가 같은 `gate0-checklist.md`를 고치고 있다.~~ **#25는 `79a2e23`으로 머지됐고 round 2에서 rebase하며
  §1.5 헤딩 충돌을 해소했다**(아래 "Review round 2").

## Review round 1

리뷰 verdict `request_changes`(major 1 + minor 5, 전부 문서). 지적 6건 전부 `45d0319`에서 고쳤다. 이 절 자체와
티켓 §"Sources consulted" 표에 남아 있던 같은 m1 오기(`BROWSE`를 traffic source로 적어 둔 행)의 정정은 바로 다음
커밋에 있다. 코드 변경 없음.

| # | 지적 | 확인한 사실 | 고친 내용 | SHA |
|---|---|---|---|---|
| M1 | `content-and-market-criteria.md:398`(·`:431`)의 명령 성공률 절대 하한 `≥ 70%`와 `:390`의 가동률 `≥ 90%`가 스펙 §14.1(기준선 수집 뒤 결과 보기 전 고정) 및 문서 자신의 §4.4 서두·티켓 서술과 모순 | 지적이 맞다. §4.4 서두가 "이 문서는 절대 숫자를 정할 수 없다"고 써 놓고 표에서 두 개를 제안하고 있었다 | 두 숫자를 삭제했다. 남긴 것은 **지표·계산식·freeze 절차**뿐이다: 가동률 = 실제 방송 시간 ÷ 구간 총 시간, 명령 성공률 = `accepted ÷ commandLike`(`apps/server/src/input/metrics.ts:15`–`25`), 절차는 baseline 14일 → freeze → 겹치지 않는 validation 14일. §4.4 서두에 "판정 숫자는 ② freeze에서 처음 정해진다"는 인용 블록을 넣고, ①③의 "14일"은 구간 길이 제안이지 합격선이 아님을 명시했다. §5 A-7 행과 티켓 Assumptions 표의 같은 숫자도 함께 제거했다 | `45d0319` |
| m1 | `:360-362` P7 enum 귀속 오류 | 공식 문서 확인(2026-08-19): `BROWSE`는 `insightPlaybackLocationType`("views that took place on the YouTube home page or home screen, in the user's subscription feed, or in another YouTube browsing feature"), `SHORTS`·`LIVE_REDIRECT`는 `insightTrafficSourceType` 값 | §4.2를 두 차원으로 분리하고 "두 차원을 한 표에 섞어 읽지 않는다"를 추가. 재생 위치 차원 출처 `[P9]`(`#Playback_Location_Dimensions`, 앵커 존재 확인)를 6장에 추가하고 `[P7]` 설명을 traffic source로 한정. §4.5 항목 2도 "어느 차원의 어떤 값인가"로 고쳤다 | `45d0319` |
| m2 | `:273` `crisis_sleeping`이 `apps/server/src/world`에 없음 | `grep -rn crisis_sleeping` 결과는 renderer 2곳(`preview-states.ts:302`, `palette.test.ts:189`)의 textKey·iconId뿐이고 world에는 0건. 실제 식별자는 crisis id `sleeping`(`world/types.ts:43`), 전이 `crisis_entered`(`world/reducer.ts:215`), 연출 변형 `crisis_sleep_curl`(`world/content/variants.ts:492`) | night 행을 `crisis_entered -> sleeping`(임계 판정 `world/creature.ts:102`, 연출 변형 `crisis_sleep_curl`)로 바꾸고 file:line을 붙였다 | `45d0319` |
| m3 | `:58` `cost 0 (no source)`에 §0 라벨이 없음 | 지적이 맞다. §0은 "라벨 없는 숫자는 이 문서에 없다"고 선언해 놓았다 | `경로 자체의 비용 **0원** \`제안(근거 없음)\` — 견적을 받아본 적이 없다`로 고쳤다 | `45d0319` |
| m4 | `:171-172` previewLeadMs grep 주장이 거짓(`config/default.json:278`에도 정의) | 지적이 맞다. `previewLeadMs` 전체 출현은 정의 3곳(`tuning.ts:79` 타입, `tuning.ts:168` 기본값, `config/default.json:278` 설정값)이고, 이 값을 읽는 코드는 0곳이다(`world` 섹션을 읽는 config 로더도 없다) | 세 정의 위치를 그대로 적고, 사실로 유지되는 부분("런타임·reducer 소비처 0곳 → 30분 예고는 동작하지 않는다")만 남겼다. 같은 줄의 잘못된 상호참조 `5장 A-5`(반복 장면 기준)를 `A-8`(후속 코드 작업)로 정정했다 — 리뷰 지적 밖이지만 같은 두 줄 안의 오기다. 티켓 Follow-up의 같은 서술도 맞췄다 | `45d0319` |
| m5 | 티켓 Result의 변경 파일 수 2 ≠ 실제 3 | `git diff --name-only origin/main...HEAD` = checklist·plan·ticket 3개 | 숫자 대신 `--name-only` 실제 출력을 붙였다 | `45d0319` |

### Round 1 이후 재확인

- rebase: `origin/main` `c6bbf0d` 위로 충돌 없이 rebase됐다. T19(PR #25)는 아직 `gate0-checklist.md`를 바꾸지 않았고, 이 브랜치의 §1.4 3줄은 그대로다(`git diff origin/main...HEAD -- docs/ops/gate0-checklist.md` = 3줄 추가).
- 게이트 5개 재실행 결과는 위 "Gates (executed)"에 있다.
- 문서 전체에 남은 `70%`·`90%`는 5초 테스트(§2·A-2)의 통과선뿐이며, 이는 Gate 0 승인 대상이지 Gate 4 절대값이 아니다.

## Review round 2

리뷰 verdict `request_changes`. **round 1의 major 1 + minor 5는 리뷰어가 전부 해소 확인**했고(회귀 점검 통과),
수락 기준 2도 `met`으로 바뀌었다. 신규 지적은 minor 1건이고 그것만 고쳤다. **코드 변경 없음, 새 숫자·게이트 없음.**

| # | 지적 | 확인한 사실 (직접 재확인) | 고친 내용 | SHA |
|---|---|---|---|---|
| m1 | `content-and-market-criteria.md:365`(·`:419-420`)와 티켓 `:42,44`의 "세로 Live 피드 유입이 어느 차원의 어떤 값인지 공식 문서에서 확정 못 했다"·"engaged views 제공 여부 불확실"이 불완전·구식 | 지적이 맞다. 공식 문서를 직접 다시 열어 확인(2026-08-19): (a) **Reporting API** 채널 리포트 차원 `traffic_source_type` 값 **`31` = `Vertical live feed`**("Views originated from the vertical live feed.") [P10]; (b) `channel_traffic_source_a3` 차원 = `date, channel_id, video_id, live_or_on_demand, subscribed_status, country_code, traffic_source_type, traffic_source_detail`, 지표에 `engaged_views` 포함 [P11]; (c) `engaged_views` = "The number of times the channel's videos have been viewed past the initial seconds" [P12]. 반대로 **Query API** `insightTrafficSourceType`의 값 목록에는 확인일 기준 세로 Live 피드 대응 값이 **없다**(`SHORTS`·`LIVE_REDIRECT`는 다른 유입) [P7] | **경로를 둘로 분리해 다시 썼다.** §4.2에 "API가 둘이라는 것부터 구분한다" 항목을 넣고, bulk Reporting API 경로(값 `31`, `channel_traffic_source_a3`, `engaged_views`)를 **문서로 확인된 사실**로 URL·확인일과 함께 적었다. §4.1 "쓸 수 있다" 표에 Reporting API 채널 리포트 행을 추가하고, §5 A-6 제안에 같은 경로를 명시했다. **Gate 2 "확인 필요" 범위는 Query API·Studio 쪽으로 좁혔다**: §4.5 항목 1은 "Studio 화면 표기"만, 항목 2는 "Query API로 분리 가능한가"만 남기고, 문서상 경로를 실계정에서 실행해 본 적 없다는 사실을 항목 2-1로 분리했다. 6장에 [P10]·[P11]·[P12]를 추가했다. 티켓 "Sources consulted" 표의 두 행(`:42`·`:44`)도 같은 기준으로 고치고 새 출처 3행을 넣었다 | `c961f32` |

### Round 2 이후 재확인

- rebase: T19(PR #25, `79a2e23`)가 머지돼 `origin/main` `fc402f3` 위로 rebase했다. `gate0-checklist.md` §1.5
  헤딩에서 충돌 1건(main이 "— 승인 2026-08-19 (D-11)"을 붙임) → **main 쪽 헤딩을 취하고** 이 브랜치의 §1.4
  "초안 제출" 2줄을 그대로 유지해 해소했다. 이 브랜치의 checklist 변경은 **여전히 3줄 추가뿐**이다
  (`git diff origin/main...HEAD -- docs/ops/gate0-checklist.md`).
- 새로 만든 숫자·합격선·게이트는 **없다.** 추가된 `31`은 통과선이 아니라 공식 문서의 **열거형 값**이다.
- 게이트 5개 재실행 결과는 아래 "Gates (round 2)"에 있다.

### Gates (round 2)

리뷰 round 2 수정 뒤 `origin/main` `fc402f3` 위로 rebase한 상태에서 돌린 결과다.

```text
npm run format:check  -> pass ("All matched files use Prettier code style!")
npm run lint          -> pass (eslint 0, check-no-legacy-imports: ok (0), check-install-scripts: ok (4 reviewed))
npm run typecheck     -> pass (tsc --build, 출력 없음, exit 0)
npm run test          -> pass (Test Files 139 passed (139), Tests 1957 passed | 1 skipped (1958), 106.95s, exit 0)
npm run build         -> pass (contract/renderer/server/simulator/soak, migrations 5, data-map up to date, exit 0)
```

실행하지 않은 게이트: 없음.

**테스트 1회 실패 기록(정직 보고).** 같은 커밋에서 돌린 **첫 번째** `npm run test`에서
`apps/server/src/engine/ingest.test.ts:442`("answers 503 with a reason code while another connection holds the
write lock")가 1건 실패했고, **이어서 돌린 2회는 모두 통과**했다(위 수치는 3회차, exit 0). 이 브랜치의 diff는
문서 3개뿐이고 코드·config 변경이 0이므로(`git diff --name-only origin/main...HEAD`) 이 실패의 원인일 수 없다.
해당 테스트는 다른 커넥션이 write lock을 쥔 상태의 SQLite 반환 코드에 의존하고(같은 파일이 `db_busy`와
`db_locked` 두 reason을 다룬다), 이 테스트 파일은 `origin/main`의 `01d8f2a`(#20)에서 온 것으로 이 PR이
건드리지 않았다. **재현 1/3회**이며 근본 원인까지 규명하지는 않았다 — 코디네이터 판단용으로만 남긴다.


## Review round 3

리뷰 verdict `request_changes`. **round 1의 major 1 + minor 5와 round 2의 minor 1은 리뷰어가 전부 해소 확인**했고
(회귀 점검 통과), **수락 기준 1·2가 모두 `met`으로 바뀌었다.** 신규 지적은 minor 2건이고 **둘 다 문서 내부
상호참조의 추적성 문제**다 — 리뷰어도 두 건 모두 "실질 주장은 여전히 맞다"고 명시했다. 바뀐 것은 **가리키는
위치뿐**이며 사실·숫자·결론은 하나도 바뀌지 않았다. **코드·config·의존성 변경 없음, 새 숫자·합격선·게이트·출처 없음.**

| # | 지적 | 확인한 사실 (직접 재확인) | 고친 내용 | SHA |
|---|---|---|---|---|
| m1 | `content-and-market-criteria.md:439`와 티켓 `:150`이 명령 성공률 배선 후속을 "§5 A-6"이라 가리키지만, A-6은 일본 시장 증빙 결정이고 실제 항목은 A-8 | 지적이 맞다. §5 표를 직접 확인: `A-6`(`content-and-market-criteria.md:455`) = "일본 시장 증빙 방식", `A-8`(`:457`) = "후속 코드 작업 착수 여부 — (a) 명령 성공률을 `GET /metrics`에 노출, (b) `choice.previewLeadMs`를 실제 예고에 쓰기". `GET /metrics` 노출을 덮는 항목은 A-8이다 | 후속 참조 **2곳만** `A-8`로 고쳤다(`content-and-market-criteria.md:439`, 티켓 `:150`). 나머지 `A-6` 언급 2곳은 **정당하므로 그대로 뒀다**: §5의 A-6 행 자체(`:455`)와, round 2에서 Reporting API 경로를 실제로 A-6에 추가했다는 기록(티켓 `:187`) | `ae86325` |
| m2 | `previewLeadMs` 참조가 `config/default.json:279`인데 이 PR head 기준 정의는 `:278` | 지적이 맞다(`grep -n previewLeadMs config/default.json` → `278`). 추가로 **줄 밀림이 아님을 확인했다**: 이 브랜치의 모든 커밋과 `origin/main`에서 전부 278이었다(`for c in ...; do git show $c:config/default.json \| grep -n previewLeadMs; done`). 즉 round 1 리뷰 텍스트의 `:279`가 처음부터 off-by-one이었고, 내가 검증 없이 옮겨 적어 전파한 것이다 | 3곳 전부 `:278`로 고쳤다(`content-and-market-criteria.md:173`, 티켓 `:152`, 티켓 round 1 표 `:171`의 2회). round 1 표 "지적" 칸의 숫자도 함께 고쳤다 — 그 칸은 영문 리뷰의 한국어 요약이지 인용문이 아니고, 틀린 줄 번호를 남기면 그 표를 따라간 독자가 똑같이 잘못된 줄로 가기 때문이다. 줄 밀림이 아니라 원래 틀린 값이었으므로 `file:line` 표기 방식 자체는 문서 관례대로 유지했다 | `ae86325` |

### Round 3 이후 재확인

- rebase: `origin/main`이 `fc402f3` → `00ebc42`로 움직여 그 위로 rebase했다. **충돌 없음**(round 2와 달리
  checklist 충돌도 없었다). main이 움직였으므로 **인용 위치를 전부 다시 확인**했다: `previewLeadMs`는 새 base에서도
  `config/default.json:278`, `A-8` 행은 여전히 `content-and-market-criteria.md:457`, 변경 파일은 여전히 3개
  (`git diff --name-only origin/main...HEAD` → checklist·plan·ticket), `gate0-checklist.md` 변경은 여전히
  **§1.4 3줄 추가뿐**(`git diff --stat origin/main...HEAD -- docs/ops/gate0-checklist.md` → `3 +++`).
- 이번 라운드 diff는 **문서 5줄**이 전부다(plan 2줄, 티켓 3줄). 코드·config·의존성 0.
- 사실 주장은 그대로다: `previewLeadMs` 정의 3곳·소비처 0곳, 명령 성공률은 `GET /metrics`에 노출되지 않아 배선 필요.

### Gates (round 3)

리뷰 round 3 수정 뒤 `origin/main` `00ebc42` 위로 rebase한 상태에서 돌린 결과다(5개 전부 exit 0).

```text
npm run format:check  -> pass ("All matched files use Prettier code style!")
npm run lint          -> pass (eslint 0, check-no-legacy-imports: ok (0 legacy imports),
                               check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads))
npm run typecheck     -> pass (tsc --build tsconfig.json, 출력 없음, exit 0)
npm run test          -> pass (Test Files 139 passed (139), Tests 1957 passed | 1 skipped (1958), 139.15s)
npm run build         -> pass (schema up to date (6 files), renderer 733 modules, migrations 5,
                               data-map up to date, simulator/soak 빌드, exit 0)
```

실행하지 않은 게이트: 없음. round 2에서 1/3 확률로 관측했던 `ingest.test.ts` write-lock 실패는 이번 실행에서
재현되지 않았다(리뷰어 round 3 실행에서도 재현되지 않음). 여전히 근본 원인을 규명하지 못했으므로 해결됐다고
쓰지 않는다.
