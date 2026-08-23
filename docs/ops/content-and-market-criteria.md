# 24시간 콘텐츠 목록과 일본 시장 증빙 (Gate 0 §1.4, Gate 4)

> 근거: [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §5.2, §6.2, §12.5, §14.1, §14.2(1), §15(Gate 0·Gate 3·Gate 4), §17.
> 관련 절은 항목마다 표기했다.
> 상태: **승인됨**(2026-08-23, `D-20`). 이 문서의 숫자는 이제 합격선이다 — 바꾸려면 새 `D-*`가 필요하다.
> 승인 기록 위치: [`docs/tasks/BOARD.md`](../tasks/BOARD.md) §2 결정 표(`D-*`). 승인 뒤에
> [`gate0-checklist.md`](gate0-checklist.md) §1.4 체크박스를 채운다.
> 최종 갱신: 2026-08-23.

**기각: 일본 패널 모집**(2026-08-23, 사용자 결정 `D-18`). §5.2의 5초 이해는 모집한 패널의 설문이 아니라
**실제 방송의 행동 지표**(5초 리텐션, 무식별 명령 입력률)로 본다. 패널은 애초에 §14.1 지표가 아니었고(2.3),
유입이 있는지도 모르는 상태에서 유료 패널에 먼저 지출하는 것은 순서가 틀렸다는 것이 기각 근거다.
행동 지표를 재려면 명령 성공률이 `GET /metrics`에 있어야 한다 — `TASK_SPECS` §T31.

## 0. 라벨 규약

이 문서에 나오는 모든 숫자와 외부 주장에는 아래 라벨 중 하나가 붙는다. 라벨 없는 숫자는 이 문서에 없다.

| 라벨 | 뜻 |
|---|---|
| `제안(근거: …)` | 스펙 문장 또는 6장의 출처에서 도출한 값. 그래도 **승인 전에는 합격선이 아니다** |
| `제안(근거 없음)` | 근거를 찾지 못하고 코디네이터가 고른 값. 사용자가 바꿔도 잃는 근거가 없다 |
| `측정값(…)` | 이 저장소의 코드를 실제로 실행해 얻은 수. 실행 명령은 1.1에 있다 |
| `확인 필요(출처 없음)` | 공식 문서를 찾지 못했거나 실계정에서만 확인 가능한 사실 |

---

## 1. 24시간 콘텐츠 목록 (T7 디렉터 코드에서 도출)

### 1.1 어떻게 도출했고 어떻게 재현하는가

이 장의 사건명·챕터명은 **전부 `apps/server/src/world`의 실제 식별자**다. 두 경로로 확인했다.

**(a) 정의 테이블 grep** — 승인 대상 어휘가 코드에 있는 그대로인지:

```bash
grep -n "export const CHAPTER_IDS\|export const MISSION_IDS\|export const WEATHER_IDS\|export const VISITOR_IDS\|export const CRISIS_IDS\|export const ENVIRONMENT_IDS\|export const GROWTH_STAGES\|export const WORLD_PHASE_IDS" apps/server/src/world/types.ts
grep -on "chapterId: '[a-z_]*'\|eventCombinationId: '[a-z_]*'\|ruleId: '[a-z_]*'" apps/server/src/world/content/chapters.ts
grep -on "variantId: '[a-z_]*'" apps/server/src/world/content/variants.ts
```

**(b) 입력 0 가상 24시간 실행** — 디렉터가 실제로 무엇을 내는지(스펙 §2.1: 시청자가 0명이어도 진행된다):

```bash
npm run build -w @vl/server
node --input-type=module -e "
import { initialWorldState, runWorld, computeFreshness, MILLIS_PER_DAY, addMillis, jstHour } from './apps/server/dist/world/index.js'
const START = '2026-08-17T21:00:00.000Z'   // 06:00 JST
const SKIP = new Set(['idle_beat', 'need_pressure', 'growth_progress', 'emotion_changed'])
for (const seed of ['seed_day_1', 'seed_day_2', 'seed_day_3', 'seed_day_4', 'seed_day_5']) {
  const run = runWorld({ to: addMillis(START, MILLIS_PER_DAY), state: initialWorldState({ seed, startedAt: START }) })
  const f = computeFreshness(run.transitions)
  console.log(seed, 'steps=' + run.steps, 'transitions=' + f.totalTransitions, 'unique=' + f.uniqueTransitions, 'repeatedNarrative=' + f.repeatedNarrativeSceneRatio.toFixed(3), JSON.stringify(f.transitionsByScale))
  for (const t of run.transitions) {
    if (SKIP.has(t.type)) continue
    console.log('   ', t.at, 'JST' + String(jstHour(t.at)).padStart(2, '0'), t.type, '->', t.to, '[' + (t.variantId ?? '-') + ']')
  }
}
"
```

시드는 고정이고 시계는 주입값이므로 같은 명령은 같은 결과를 낸다(T7 합격 기준 2, `world/acceptance.test.ts`).

### 1.2 승인 대상 어휘 (코드 식별자 = 화면 어휘)

| 종류 | 식별자 | 정의 위치 |
|---|---|---|
| 일일 챕터 3종 | `gathering`, `festival_prep`, `growth_choice` | `world/types.ts:97`, `world/content/chapters.ts:48` |
| 챕터 비트 3종 | `setup`, `turn`, `resolution` | `world/types.ts:101` |
| 승인된 사건 조합 9종 | `combo_forage_garden`, `combo_river_walk`, `combo_rest_indoors`, `combo_lantern_row`, `combo_music_practice`, `combo_night_stalls`, `combo_grow_swift`, `combo_grow_gentle`, `combo_grow_curious` | `world/content/chapters.ts:60,69,78,97,106,115,134,143,152` |
| 디렉터 규칙 10종 | `rule_shelter_from_rain`, `rule_music_when_wet`, `rule_forage_when_hungry`, `rule_stalls_when_hungry`, `rule_river_when_playful`, `rule_lanterns_at_night`, `rule_quiet_when_in_crisis`, `rule_gentle_growth_when_tired`, `rule_swift_growth_when_clear`, `rule_curious_growth_with_visitor` | `world/content/chapters.ts:181`–`242` |
| 미션 5종 | `share_a_meal`, `chase_the_ribbon`, `quiet_company`, `gather_ingredients`, `hang_the_lanterns` | `world/types.ts:87` |
| 미션 연출 변형 11종 | `mission_meal_together`, `mission_meal_picnic`, `mission_ribbon_chase`, `mission_ribbon_windy`, `mission_quiet_company`, `mission_quiet_night`, `mission_gather_basket`, `mission_gather_river`, `mission_hang_lanterns`, `mission_lantern_calm`, `mission_rest_watch` | `world/content/variants.ts:398`– |
| 장소 4종 | `home_room`, `garden`, `riverside`, `night_terrace` | `world/types.ts:69` |
| 시간대 5종 | `dawn`, `morning`, `afternoon`, `evening`, `night` | `world/types.ts:73`, 경계는 `world/time.ts:72` |
| 날씨 5종 | `clear`, `cloudy`, `rain`, `wind`, `starry` | `world/types.ts:76` |
| 방문자 4종 | `postal_bird`, `lantern_moth`, `garden_cat`, `wandering_tinker` | `world/types.ts:79` |
| 위기 3종(전부 회복 가능) | `sleeping`, `tired`, `needs_help` | `world/types.ts:43` |
| 성장 단계 5종 | `egg`, `hatchling`, `fledgling`, `companion`, `guardian` | `world/types.ts:62` |
| 자유 명령 3종 | `FEED`(`ごはん`/🍙), `PLAY`(`あそぶ`/🎾), `PET`(`なでる`/❤️) | `world/types.ts:109`, `packages/contract/src/commands.ts:85` |
| 연출 변형 총 71종 | `idle_*` 19, `feed_*` 7, `play_*` 7, `pet_*` 6, `mission_*` 11, `weather_*` 5, `visitor_*` 4, `crisis_*` 6, `recover_*` 6 | `world/content/variants.ts` (`grep -c "variantId: '"` = 71) |
| 타이머 종류 10종 | `idle_beat`, `need_decay`, `mission_close`, `choice_close`, `world_phase`, `weather_change`, `visitor_arrival`, `chapter_beat`, `crisis_recovery`, `paid_thanks_fallback` | `world/types.ts:121` |

**승인 대상은 이 목록 자체**다. 스펙 §6.2가 말하는 "승인된 사건 조합"은 위의 챕터 3종 × 조합 9종이고, 디렉터는
규칙 10종으로 그중 하나에 가중치를 줄 뿐 **새 조합을 만들지 못한다**(`world/content/chapters.ts:168`–`172` 주석).

### 1.3 하루 챕터 타임라인 (JST)

챕터는 **매일 06:00 JST에 시작**하고(`chapter.anchorHourJst = 6`, `tuning.ts:171`) 다음 06:00까지 이어진다
(`chapterEndFor`, `world/reducer.ts:426`). 비트 시각은 챕터 길이의 고정 비율이다(`turnFraction = 0.35`,
`resolutionFraction = 0.72`, `tuning.ts:173`–`174`).

| JST | 무엇이 일어나는가 | 근거 |
|---|---|---|
| 06:00 | `chapter_started` — 그날 챕터의 `setup` 비트. 챕터는 직전 날과 다른 것으로 뽑는다 | `reducer.ts:446` `pickChapterId` |
| 14:24 | `chapter_beat`(`turn`) + `choice_opened` — 그날의 분기점이 열린다 | `0.35 × 24h` |
| 14:24–14:44 | 선택 창 20분. identity gate가 닫힌 V1에서는 **투표가 아니라** 무료 명령 총량을 가중치로 쓰는 비경쟁 집계 | `choice.windowMs`(`tuning.ts:168`), 스펙 §6.4 |
| 14:44 | `choice_resolved` → 조합 1개 확정(예: `combo_forage_garden`), 장소·미션 성향이 바뀐다 | 관측(1.5) |
| 23:16 | `chapter_resolved` — 결말 비트, 성장·유대 가산 | `0.72 × 24h`, `reducer.ts:552` |
| 다음 06:00 | 다음 챕터 `chapter_started` | 관측(1.5) |

즉 스펙 §6.2가 요구하는 **시작 → 변화 → 결말**이 하루 안에 한 번씩 있고, 관측에서도 `chapter_started` 1회 이상,
`chapter_beat` 1회, `chapter_resolved` 1회로 나온다(`world/acceptance.test.ts`의 첫 테스트와 같은 성질).

### 1.4 JST 시간대별 콘텐츠 표

시간대 경계는 코드가 정한 값이다(`world/time.ts:72`). "언제나"는 시간대와 무관하게 도는 타이머다.

| 시간대(JST) | phase | 이 구간에 고정으로 오는 것 | 이 구간에서 주로 보이는 연출(조건부) |
|---|---|---|---|
| 04:00–06:59 | `dawn` | 04:00 `phase_changed→dawn`, **06:00 `chapter_started`** | `idle_dawn_yawn`(`phases:['dawn']`), `recover_wake_dawn`, `crisis_sleep_curl`에서 깨어나는 구간 |
| 07:00–11:59 | `morning` | 07:00 `phase_changed→morning` | `idle_sun_stretch`(`phases:['morning']`+`clear`), `mission_meal_together`, `visitor_postal_bird` |
| 12:00–16:59 | `afternoon` | 12:00 `phase_changed→afternoon`, **14:24 `chapter_beat(turn)`+`choice_opened`**, **14:44 `choice_resolved`** | 확정된 조합의 장소로 이동(`garden`/`riverside`/`home_room`/`night_terrace`), `mission_gather_basket`, `mission_ribbon_*` |
| 17:00–20:59 | `evening` | 17:00 `phase_changed→evening` | `visitor_lantern_moth`, `mission_quiet_night`, `mission_lantern_calm`(`phases:['evening','night']`) |
| 21:00–03:59 | `night` | 21:00 `phase_changed→night`, **23:16 `chapter_resolved`** | `crisis_entered -> sleeping`(밤에 `rest`가 임계 초과, `world/creature.ts:102`·`world/reducer.ts:215`, 연출 변형 `crisis_sleep_curl` `world/content/variants.ts:492`), `idle_star_gaze`(`night`+`starry`/`clear`), `idle_curl_sleep`, `weather_star_clear`, `growth_stage_advanced` |
| 언제나 | — | `idle_beat` 30–75초(`tuning.ts:132`), `need_decay` 90초(`tuning.ts:135`), **미션 20분 주기**(`mission_started`→`mission_resolved`, `tuning.ts:159`), `weather_change` 150분 판정(`tuning.ts:179`, 값이 바뀔 때만 전이), `visitor_arrival` 210분 판정·체류 40분(`tuning.ts:181`), `crisis_recovery` 300초 판정(`tuning.ts:152`) | 무료 명령이 들어오면 그 자리에서 `feed_*`/`play_*`/`pet_*` 반응 20종 중 하나 |

**유료 이벤트**는 시간대와 무관하게 `PAID_THANKS` 연출 1회만 만들고(원 연출 시간이 지나면 대체 감사 연출 1회,
스펙 §9.2), 상태·확률·성장·선택에 어떤 영향도 주지 않는다(스펙 §8.5, `world/paid.ts`, `world/paid.test.ts`).

### 1.5 입력 0으로 관측한 하루 (측정값)

1.1(b) 명령을 5개 시드로 실행한 결과다. **시청자 입력·결제 0**이다.

| 시드 | step | 전이 수 | 고유 전이 수 | 반복 서사 장면 비율 | 시간 규모별 전이 수 |
|---|---|---|---|---|---|
| `seed_day_1` | 2844 | 2004 | 70 | 0.455 | seconds 1647 / minutes 328 / hours 22 / day 7 |
| `seed_day_2` | 2844 | 2004 | 83 | 0.339 | seconds 1647 / minutes 328 / hours 22 / day 7 |
| `seed_day_3` | 2831 | 1990 | 76 | 0.475 | seconds 1634 / minutes 328 / hours 21 / day 7 |
| `seed_day_4` | 2844 | 2004 | 74 | 0.438 | seconds 1647 / minutes 328 / hours 22 / day 7 |
| `seed_day_5` | 2827 | 1986 | 83 | 0.425 | seconds 1630 / minutes 328 / hours 21 / day 7 |

`측정값(2026-08-19, 위 명령)`. 다섯 시드 모두에서 관측된 것:

- 하루 챕터 1개가 `setup → turn → resolution`으로 끝나고, 다음 챕터가 06:00에 시작한다.
- 선택은 전부 `director` 모드로 열렸다(identity gate 닫힘 = BOARD `A-1`). 확정된 조합은 시드마다 달랐다:
  `combo_forage_garden` 3회, `combo_grow_curious` 1회, `combo_grow_swift` 1회.
- 미션은 20분마다 새로 시작하고 **입력이 없으므로 전부 `eased`로 끝난다**(목표 미달이지만 벌점 없음 — 스펙 §6.3).
- 위기는 들어갔다가 **스스로 회복한다**: `crisis_entered` 12–15회, `crisis_recovered` 9–12회(밤 `sleeping` 포함).
  다섯 시드 어디에도 죽음·영구 퇴화·유료 전용 회복은 없다.
- 유료 효과 0건(`paid` 효과 0, `pendingThanks` 0) — 아무도 결제하지 않은 하루를 합성 결제로 채우지 않는다(§2.6).
- 성장은 무료·무입력만으로도 `egg → hatchling`으로 올라갔다(`growth_stage_advanced`, 다섯 시드 모두 1회).

### 1.6 반복 장면 표본 검토 기준 (제안, 스펙 §12.5)

스펙 §12.5는 두 가지를 요구한다: (1) 같은 명령이 매번 같은 장면이 되지 않을 것, (2) **사람이 정기적으로 Live와
archive를 표본 검토하고 기록을 남길 것**. 아래는 그 둘을 각각 자동 지표와 사람 절차로 나눈 제안이다.

**(a) 자동 지표 — 코드가 이미 계산한다** (`world/variation.ts` `computeFreshness`):

| 지표 | 현재 코드의 잠정 하한 | 관측값(입력 0, 5시드) | 승인 제안 |
|---|---|---|---|
| 하루 고유 전이 수 | `40` (`tuning.ts:204`, `provisional`) | 70–83 | **≥ 60** `제안(근거: 관측 최저 70에 여유 15%. 여유폭 자체는 근거 없음)` |
| 반복 서사 장면 비율(분 단위 이상) | `≤ 0.7` (`tuning.ts:205`) | 0.339–0.475 | **≤ 0.55** `제안(근거: 관측 최고 0.475에 여유. 여유폭 자체는 근거 없음)` |
| 표본 크기 | `200` (`tuning.ts:206`) | — | **200 유지** `제안(근거 없음)` |

`repeatedSceneRatio`(초 단위 idle 포함)는 0.83–0.88로 높지만, 이는 24시간 동안 숨쉬기·눈 깜빡임 같은 초 단위
연출이 작은 목록에서 반복되기 때문이다. **§12.5가 말하는 "장면"은 분 단위 이상**이므로 합격선은 서사 장면 비율로
두기를 제안한다(`world/variation.ts`의 `repeatedNarrativeSceneRatio`가 그 값이다).

**(b) 사람 표본 검토 절차** `제안(근거 없음)`:

| 항목 | 제안 |
|---|---|
| 주기 | 파일럿 기간 매일 1회 |
| 표본 | 지난 24시간에서 **무작위 6구간 × 5분 = 30분** |
| 확인 항목 | ① 그날 챕터의 시작·변화·결말이 실제로 보였는가 ② 같은 장면이 "숫자·이름만 바뀐 반복"으로 느껴졌는가 ③ 무료 명령 반응이 상태·장소·날씨에 따라 달라 보였는가 ④ 안전 사건(개인정보 노출·부적절 표시) 유무 |
| 기록 | 날짜·표본 구간·①~④ 판정과 한 줄 근거·자동 지표 그날 값. 기록 없는 날은 "검토하지 않음"으로 남긴다 |
| 실패 처리 | ②가 2일 연속 "반복으로 느껴짐"이면 콘텐츠 목록을 늘리기 전에는 Gate 3 통과로 기록하지 않는다 |

Gate 3의 "24시간 산출물 사후 표본이 승인된 일일 챕터 완결성과 반복 장면 기준을 통과하고 검토 기록을 남김"(§15)이
이 절차를 가리킨다.

---

## 2. 일본 시장 증빙 방식과 Gate 4 합격 기준 (제안)

### 2.1 무엇을 쓸 수 있고 무엇을 못 쓰는가

| 쓸 수 있다 | 근거 |
|---|---|
| YouTube Analytics/Studio의 공식 aggregate: 조회수, 시청시간, 평균 시청 지속시간, traffic source, **geography(`country`)** | 스펙 §14.1, [P5] |
| 내부 무식별 카운터: 유효 명령 수, 창 집계 결과, 명령 성공률 | 스펙 §14.1 "무식별 유효 명령 수", `apps/server/src/input/metrics.ts` |
| YouTube **Reporting API**의 채널 bulk 리포트: `channel_traffic_source_a3`(`country_code`·`traffic_source_type`·`live_or_on_demand` 차원 × `engaged_views`·`views`·`watch_time_minutes` 등 지표) | 같은 §14.1의 공식 aggregate, [P10][P11][P12] — 2.2 |
| 승인된 일본 패널 결과(1–2장) | 스펙 §15 Gate 4 "승인된 일본 패널" |

| 못 쓴다(승인 전) | 근거 |
|---|---|
| 개인 D1·D7·D30 재명령률, `고유 작성자 / 1,000 engaged views`, `/viewer-hour`, 상위 결제자 집중도 | 스펙 §14.1 "승인 후 후보" + [S42] derived-metric 정책 — **계산·저장하지 않는다** |
| 시청자 개인 식별정보 기반 국가 추정 | 스펙 §12.4, [S41] |

### 2.2 일본 시장 증빙: geography aggregate

- **차원**: YouTube Analytics API의 `country` 차원은 ISO-3166-1 alpha-2 두 글자 코드이며(일본은 `JP`), 국가를
  식별하지 못한 행은 `ZZ`로 보고된다 [P5](확인 2026-08-19).
- **한계(중요)**: "Metrics or dimensions related to countries or regions where viewers were located may be
  limited"이고, **"The actual thresholds at which data is limited are not published and subject to change at
  YouTube's discretion"** [P6](확인 2026-08-19). 즉 **트래픽이 작으면 일본 행 자체가 나오지 않을 수 있고, 그
  임계치는 공개되지 않는다.**
- **그때 무엇을 하는가**(제안): ① 기간을 늘려 재조회, ② 필터·breakdown을 제거하고 재조회, ③ 그래도 비면
  **"일본 검증 완료"를 선언하지 않고 미달로 기록한다.** 이것은 제안이 아니라 스펙 §15 Gate 4의 문장이다
  ("개인정보 threshold로 국가 데이터가 제공되지 않으면 일본 검증 완료를 선언하지 않음").
- **유입 경로와 재생 위치는 서로 다른 차원이다.** `insightTrafficSourceType`에는 `SHORTS`(앞 영상에서 세로로
  스와이프해 넘어온 Shorts 시청 경험 유입), `LIVE_REDIRECT`(Live Redirect 유입) 등이 있고 [P7](확인 2026-08-19),
  `BROWSE`(홈 화면·구독 피드 등 탐색 기능에서 일어난 재생)는 유입 경로가 아니라 **`insightPlaybackLocationType`
  의 값**이다 [P9](확인 2026-08-19). 두 차원을 한 표에 섞어 읽지 않는다.
- **API가 둘이라는 것부터 구분한다.** 위 두 차원은 **Analytics Query API**(질의형)의 것이고, 아래의
  `traffic_source_type`·`country_code`는 **Reporting API**(bulk 리포트)의 것이다. 이름이 비슷해도 서로 다른
  차원이므로 값을 옮겨 쓰지 않는다.
- **세로 Live 피드 유입은 bulk Reporting API에 문서로 정의돼 있다.** 채널 리포트 차원 `traffic_source_type`에
  값 **`31` = `Vertical live feed`**("Views originated from the vertical live feed.")가 있다
  [P10](확인 2026-08-19). 반면 Query API `insightTrafficSourceType`의 값 목록에는 **확인일 기준 세로 Live 피드에
  대응하는 값이 없다**(`SHORTS`·`LIVE_REDIRECT`는 있지만 둘 다 다른 유입이다) [P7](확인 2026-08-19).
- **일본 × 세로 Live 피드 × engaged views는 한 리포트 안에 같이 있다(문서 기준).** 채널 리포트
  `channel_traffic_source_a3`의 차원은 `date, channel_id, video_id, live_or_on_demand, subscribed_status,
  country_code, traffic_source_type, traffic_source_detail`이고 지표에 `engaged_views`가 있다
  [P11](확인 2026-08-19). `engaged_views`는 "The number of times the channel's videos have been viewed past the
  initial seconds"로 정의된다 [P12](확인 2026-08-19). 즉 `country_code`=`JP` × `traffic_source_type`=`31` ×
  `live_or_on_demand`로 이 절의 일본 증빙을 뽑는 **경로가 문서상으로는 존재한다.** 다만 이 경로를 **실계정에서
  실행해 본 적은 없고**, 위의 limited data 한계 [P6]는 그대로 적용된다.
- **그래서 지금 남은 미확인은 Query API·Studio 쪽으로 좁혀진다.** Query API로 같은 분해가 되는지, Studio 화면이
  이 유입과 engaged views를 어떤 이름으로 보여 주는지는 실계정에서만 확인된다 — `확인 필요(출처 없음)`,
  Gate 2에서 확인한다(2.5).

### 2.3 무엇이 무엇을 증명하는가

Analytics aggregate가 답하는 질문은 "일본에서 **실제로 발견·시청·참여가 일어나는가**"이고, 표본은 실제 시청자
전체다(임계치 이상일 때). 국가 행이 임계치 미만이면 그것은 통과가 아니라 **미달 기록**이다(스펙 §15 Gate 4).

"일본 시청자가 **화면을 이해하는가**"는 `D-18`에 따라 같은 곳에서 본다 — 5초 리텐션과 무식별 명령 입력률이다.
명령을 실제로 입력했다는 것은 "무료로 입력할 명령이 있다"(§5.2의 세 번째 항목)를 읽었다는 행동 증거다.
그 계측은 `TASK_SPECS` §T31. **이 방식이 답하지 못하는 것**: 리텐션이 미달일 때 §5.2의 네 항목 중
무엇이 안 읽혔는지는 분해되지 않는다.

### 2.4 Gate 4 발견·시청·참여 합격 기준 (제안)

스펙 §15 Gate 4는 **"기간·표본·통과선·중단선을 먼저 고정하고, 겹치지 않는 post-freeze validation에서 세 축을
모두 통과"** 를 요구하고, §14.1은 **"절대 성공 수치는 기준선과 비용을 수집한 뒤, 결과를 보기 전에 평가 기간과
함께 고정한다"** 고 못박는다. 따라서 **이 문서는 절대 숫자를 정할 수 없다** — 기준선이 아직 없기 때문이다.
정할 수 있는 것은 **절차와 식의 형태**이며, 아래가 그 제안이다.

> **이 절에는 통과선·표본 하한의 절대 숫자가 하나도 없다. 그것이 의도다.** 아래 ①③의 "14일"은 *관측 구간의
> 길이 제안*이고 합격 여부를 가르는 값이 아니다. 가동률·명령 성공률·조회수 같은 **판정 숫자는 ② freeze에서
> baseline을 보고 validation 시작 전에 처음 정해지며**, 그 전에 이 문서가 숫자를 제시하면 스펙 §14.1을 어긴다.

**절차 제안**

| 단계 | 내용 | 라벨 |
|---|---|---|
| ① baseline | Gate 3 파일럿 이후 **연속 14일** 관측. 이 구간에서는 통과 판정을 하지 않는다 | `제안(근거 없음)` |
| ② freeze | baseline 값을 보고 **세 축의 통과선과 표본 하한 숫자를 전부 이때 처음 적어 커밋한다**(BOARD `D-*` + 이 파일). 이후 수정 금지 | `제안(근거: 스펙 §14.1 "결과를 보기 전에 고정")` |
| ③ validation | baseline과 **겹치지 않는 연속 14일**. 여기 숫자로만 판정 | `제안(근거: 스펙 §15 "겹치지 않는 post-freeze validation")` |
| 표본 요건(식) | **방송 가동률** = 실제 방송 시간 ÷ 구간 총 시간, **유효 일 표본 수** = 가동률 하한을 넘긴 날의 수. 두 하한 값은 ②에서 정한다 | 숫자는 ② 이전에는 `제안 불가` |

**세 축의 지표와 식의 형태**

| 축 | 지표(정책상 허용) | 통과선의 형태 | 라벨 |
|---|---|---|---|
| 발견 | `country=JP`의 일별 조회수, JP 비중, traffic source 분포 | validation의 **일별 중앙값 ≥ freeze에서 적은 절대값** | 절대값은 ② 이전에는 `제안 불가` |
| 시청 | `country=JP`의 일별 평균 시청 지속시간 | 같음 | 같음 |
| 참여 | 방송 1시간당 **무식별 유효 명령 수**; **명령 성공률** = `accepted ÷ commandLike`(allowlist 첫 토큰을 가진 메시지 대비 수락된 명령 수, `apps/server/src/input/metrics.ts:15`–`25`) | 같음 | 같음 |

**중단선 제안**

| 조건 | 처리 | 라벨 |
|---|---|---|
| 누적 손실 50만원 도달 또는 관측 6개월 경과 | 중단 | `제안(근거: BOARD D-14 승인값)` |
| JP geography 행이 **2주 연속 limited data로 비어 있음** | "일본 검증 미달"로 기록하고, 기간 연장 여부를 사용자에게 묻는다. 자동 연장하지 않는다 | `제안(근거: 스펙 §15 Gate 4 + [P6])` |
| validation 도중 통과선을 고치고 싶어짐 | **금지**. 고치면 그 validation은 무효이고 ①부터 다시 한다 | `제안(근거: 스펙 §14.1)` |

### 2.5 확인 필요 항목 (지금 확정하지 못한 것)

| # | 항목 | 상태 |
|---|---|---|
| 1 | **Studio 화면**이 세로 Live의 engaged views를 보여 주는가(그리고 어떤 이름으로) | API 쪽은 **문서로 확인됨**: Reporting API `channel_traffic_source_a3` 지표에 `engaged_views`가 있고 정의도 공개돼 있다 [P11][P12](확인 2026-08-19). 남은 미확인은 **Studio 화면 표기**뿐이다 — 공식 도움말 [P8]에는 독립 정의가 없다(확인 2026-08-19). `확인 필요(출처 없음)`, Gate 2 실계정 Studio에서 확인한다 |
| 2 | **Analytics Query API**(`insightTrafficSourceType`)로 세로 Live 피드 유입을 분리할 수 있는가 | **bulk Reporting API는 문서로 확인됨**: `traffic_source_type` 값 `31` = `Vertical live feed` [P10](확인 2026-08-19). Query API 값 목록에는 확인일 기준 대응 값이 없다 [P7] — 실계정에서 다시 확인한다. `확인 필요(출처 없음)` — 2.2 |
| 2-1 | 위 Reporting API 경로가 **실계정에서 실제로** 일본 행을 내주는가(limited data [P6] 포함) | 문서상 경로는 있으나 실행해 본 적 없음 → `확인 필요(출처 없음)`, Gate 2에서 확인한다 |
| 3 | 명령 성공률을 `GET /metrics`에서 읽을 수 있는가 | **읽을 수 없다.** `commandSuccessRatio`는 구현되어 있으나(`apps/server/src/input/metrics.ts:25`) production 경로 `chatParserPort`가 `metrics`를 넘기지 않는다(`apps/server/src/youtube/chat/runtime.ts:124`). Gate 4에서 쓰려면 배선이 필요하다(5장 A-8) |

---

## 3. 사용자에게 요청하는 승인 항목

네 항목 모두 **승인됐다**(2026-08-23, `D-20`). [`gate0-checklist.md`](gate0-checklist.md) §1.4는 닫혔다.

| # | 승인 대상 | 이 문서의 제안 | 결정 |
|---|---|---|---|
| A-3 | 24시간 콘텐츠 목록 | 1.2의 어휘 표 전체(챕터 3 × 조합 9, 디렉터 규칙 10, 미션 5, 연출 변형 71) | **승인** 2026-08-23 (`D-20`) |
| A-5 | 반복 장면 기준 | 하루 고유 전이 ≥60, 반복 서사 장면 비율 ≤0.55, 사람 표본 검토 매일 6구간×5분 | **승인** 2026-08-23 (`D-20`) |
| A-6 | 일본 시장 증빙 방식 | geography `country=JP` aggregate, 국가 행이 비면 미달로 기록. 세로 Live 유입까지 보려면 Reporting API `channel_traffic_source_a3`(`country_code` × `traffic_source_type`=`31` × `live_or_on_demand`)를 쓴다(2.2) | **승인** 2026-08-23 (`D-20`) |
| A-7 | Gate 4 **절차**(숫자 아님) | baseline 14일 → freeze(이때 통과선·표본 하한 숫자를 처음 커밋) → 겹치지 않는 validation 14일. 세 축의 지표와 식은 2.4, **절대 숫자는 이 문서가 제안하지 않는다**(스펙 §14.1) | **승인** 2026-08-23 (`D-20`) |

> A-1(패널 규모)·A-2(설문 통과 기준)·A-4(패널 비용)는 `D-18`로 기각됐다. A-8(후속 코드 작업)은 그중
> (a) 명령 성공률 `/metrics` 노출이 `T31`로 등록되면서 승인 항목이 아니게 됐고,
> (b) `choice.previewLeadMs`를 실제 예고에 쓰는 것은 별도 task로 남는다.

---

## 4. 출처

이 문서가 외부 사실로 인용한 것 전부다. 확인일은 2026-08-19이며, 실행 전에 다시 확인한다.

| # | 출처 | URL | 확인일 |
|---|---|---|---|
| [P1] | Nielsen Norman Group, "Why You Only Need to Test with 5 Users" (Jakob Nielsen, 2000-03-18) | https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/ | 2026-08-19 |
| [P2] | Nielsen Norman Group, "How Many Participants for Quantitative Usability Studies: A Summary of Sample-Size Recommendations" (Budiu·Moran, 2021-07-25) | https://www.nngroup.com/articles/summary-quant-sample-sizes/ | 2026-08-19 |
| [P3] | Prolific Researcher Help, "Who are the participants on Prolific?" — 참가자 거주 국가 목록(일본 포함) | https://researcher-help.prolific.com/en/articles/445224-who-are-the-participants-on-prolific | 2026-08-19 |
| [P4] | Nielsen Norman Group, "Testing Visual Design: A Comprehensive Guide" (Megan Chan, 2024-12-13) — 5초 테스트의 정의와 한계, 사전 고지 금지 | https://www.nngroup.com/articles/testing-visual-design/ | 2026-08-19 |
| [P5] | Google, "Dimensions — YouTube Analytics and Reporting APIs" — `country` 등 geographic dimensions | https://developers.google.com/youtube/analytics/dimensions | 2026-08-19 |
| [P6] | YouTube Help, "Understand limited data in YouTube Analytics" — 국가/지역 지표의 limited data, 임계치 비공개 | https://support.google.com/youtube/answer/9101241 | 2026-08-19 |
| [P7] | Google, "Dimensions — Traffic source dimensions" — `insightTrafficSourceType` 값(`SHORTS`, `LIVE_REDIRECT` 포함) | https://developers.google.com/youtube/analytics/dimensions#Traffic_Source_Dimensions | 2026-08-19 |
| [P8] | YouTube Help, "Understand your YouTube engagement" — engaged views의 독립 정의 없음(확인 결과) | https://support.google.com/youtube/answer/9313698 | 2026-08-19 |
| [P9] | Google, "Dimensions — Playback location dimensions" — `insightPlaybackLocationType` 값(`BROWSE` 포함) | https://developers.google.com/youtube/analytics/dimensions#Playback_Location_Dimensions | 2026-08-19 |
| [P10] | Google, "Dimensions — YouTube Reporting API" — 채널 리포트 `traffic_source_type` 값 `31` = `Vertical live feed` | https://developers.google.com/youtube/reporting/v1/reports/dimensions | 2026-08-19 |
| [P11] | Google, "Channel Reports — YouTube Reporting API" — `channel_traffic_source_a3`의 차원(`country_code`·`traffic_source_type`·`live_or_on_demand` 포함)과 지표(`engaged_views` 포함) | https://developers.google.com/youtube/reporting/v1/reports/channel_reports | 2026-08-19 |
| [P12] | Google, "Metrics — YouTube Reporting API" — `engaged_views` 정의 | https://developers.google.com/youtube/reporting/v1/reports/metrics | 2026-08-19 |

스펙이 이미 인용한 출처는 번호를 그대로 쓴다: [S28](fake engagement 정책), [S41](API Data 식별정보·동의),
[S42](파생 지표 정책) — URL은 [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §18에 있다.
