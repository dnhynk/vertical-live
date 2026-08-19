# 일본 패널·5초 무음 이해 테스트·24시간 콘텐츠 목록·일본 시장 증빙 (Gate 0 §1.4 초안, T21)

> 근거: [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §5.1, §5.2, §5.3, §6.2, §6.4, §12.2, §12.4, §12.5, §14.1,
> §14.2(1), §15(Gate 0·Gate 3·Gate 4), §17. 관련 절은 항목마다 표기했다.
> 상태: **초안이다. 사용자 승인 전이며 이 문서의 어떤 숫자도 합격선이 아니다**(BOARD `D-15`).
> 승인 기록 위치: [`docs/tasks/BOARD.md`](../tasks/BOARD.md) §2 결정 표(`D-*`). 승인 뒤에
> [`gate0-checklist.md`](gate0-checklist.md) §1.4 체크박스를 채운다.
> 패널 **모집·실행·보상 집행은 사용자 작업**이다. 이 저장소는 절차·기준·증빙 양식만 제안한다.
> 최종 갱신: 2026-08-19.

## 0. 라벨 규약

이 문서에 나오는 모든 숫자와 외부 주장에는 아래 라벨 중 하나가 붙는다. 라벨 없는 숫자는 이 문서에 없다.

| 라벨 | 뜻 |
|---|---|
| `제안(근거: …)` | 스펙 문장 또는 6장의 출처에서 도출한 값. 그래도 **승인 전에는 합격선이 아니다** |
| `제안(근거 없음)` | 근거를 찾지 못하고 코디네이터가 고른 값. 사용자가 바꿔도 잃는 근거가 없다 |
| `측정값(…)` | 이 저장소의 코드를 실제로 실행해 얻은 수. 실행 명령은 3.1에 있다 |
| `확인 필요(출처 없음)` | 공식 문서를 찾지 못했거나 실계정에서만 확인 가능한 사실 |

---

## 1. 일본 패널 모집 조건 (제안)

### 1.1 이 패널이 검증하는 것과 검증하지 않는 것

- **검증한다**: 스펙 §5.2의 첫 화면 이해 — 처음 본 사람이 소리를 끈 상태로 5초 안에 (1) 크리처의 현재 상황,
  (2) 지금 달성할 공동 목표 하나, (3) 무료로 입력할 명령 하나, (4) 다음 변화까지 남은 진행도를 설명할 수 있는가.
  이것은 Gate 3의 선행조건이다(§15 Gate 3).
- **검증하지 않는다**: 시장 규모, 수요, 수익성, 재방문. 패널은 **지표가 아니다.** §14.1의 발견·참여·반복 참여
  지표는 YouTube Analytics와 내부 무식별 카운터에서만 나오고(4장), 패널 응답은 그 표에 들어가지 않는다.
- 패널 결과만으로 "일본 시장 검증 완료"를 선언하지 않는다. §15 Gate 4는 Analytics geography aggregate를 함께
  요구한다(4.2).

### 1.2 모집 조건

| 항목 | 제안 | 라벨·근거 |
|---|---|---|
| 1단계(정성) 인원 | **5명** | `제안(근거: [P1] NN/g "Why You Only Need to Test with 5 Users", Jakob Nielsen, 2000-03-18 — 질적 문제 발견용 권장치. 확인 2026-08-19)` |
| 2단계(정량) 인원 | **40명** | `제안(근거: [P2] NN/g "How Many Participants for Quantitative Usability Studies", Budiu·Moran, 2021-07-25 — 이항 지표·95% 신뢰수준·±15%p 오차의 기본 권장치. 확인 2026-08-19)` |
| 주 연령대 | **18–34세** | `제안(근거: 스펙 §5.1 "연령 가설: 18~34세를 우선 검증")` |
| 보조 셀(선택) | 35–44세 **10명** | `제안(근거 없음)` — 연령 인식(§17 "크리처 비주얼·연령 인식 검사")을 함께 보고 싶을 때만 |
| 최소 연령 | **18세 이상만** | `제안(근거: 스펙 §12.2 Made for Kids 게이트 — 아동 대상 신호를 만들지 않는다. 미성년 동의 절차도 이 프로젝트 범위 밖)` |
| 언어·거주 | 일본어 모어, 일본 거주 | `제안(근거: 스펙 §5.3 "방송의 주 언어와 시간 기준은 일본어와 JST")` |
| 기기 | 본인 스마트폰의 **YouTube 앱 세로 화면** | `제안(근거: 스펙 §14.2(1) "실제 YouTube 모바일 UI가 겹친 5초 무음 화면")` |
| OS 배분 | Android·iOS 각각 최소 1/3 | `제안(근거 없음)` — 앱 UI 겹침이 OS마다 다르기 때문 |
| 사전 지식 | 이 채널·이 크리처를 본 적 없음 | `제안(근거: 스펙 §5.2 "처음 본 사람이")` |
| 1인 소요 | 10분 | `제안(근거 없음)` |
| 보상 | 현지 관행에 따름, 금액 미정 | `제안(근거 없음)` — 금액은 사용자 결정(1.4) |

### 1.3 모집 경로 후보

| 경로 | 확인한 사실 | 위험 |
|---|---|---|
| **Prolific** | 참가자는 대부분 OECD 회원국 거주자이며 **일본이 지원 국가 목록에 포함**된다 [P3](확인 2026-08-19) | 유료. 조사 플랫폼 참가자는 일반 시청자보다 조사 숙련도가 높을 수 있다 |
| 일본 리서치 패널 업체 | `확인 필요(출처 없음)` — 업체·조건·견적을 이 문서에서 확정하지 않는다 | 비용이 가장 크다. 스크리너 품질이 업체에 의존한다 |
| 지인·커뮤니티 모집 | 경로 자체는 비용 0(출처 없음) | **선택 편향이 크다.** 1단계 정성에만 쓰고 2단계 정량 통과 판정에는 쓰지 않기를 제안한다 `제안(근거 없음)` |

어느 경로를 쓰든 **스크리너 문항과 실제 통과 인원을 기록**한다. 참가자를 지어내거나 응답을 대신 채우지 않는다
(스펙 §2.6, `CLAUDE.md` §3 — 가짜 참여 금지는 패널 자료에도 그대로 적용된다).

### 1.4 예산과의 상호작용 (BOARD `D-14`)

`D-14`는 public 운영의 **월 예산 10만원 · 누적 손실 중단선 50만원 · 최대 관측기간 6개월**을 승인했다. 유료 패널
40명은 이 월 예산과 같은 지갑에서 나가므로, 1단계(5명)로 화면을 먼저 고치고 2단계(40명)는 그 뒤에 한 번만 돌리는
구조를 제안한다 `제안(근거: [P1]의 "작은 테스트를 여러 번" 권고 + D-14 예산 제약)`. 패널 비용을 월 예산 안에서
볼지 별도 항목으로 볼지는 **사용자 결정**이다(5장 A-4).

### 1.5 하지 않는 것

- 패널이 **실제 public Live를 동시에 시청하게 하지 않는다.** 자극물은 녹화 화면이다(2.1). 조사용 시청으로
  조회수·시청시간을 만들면 §14.1의 발견 지표가 오염되고 YouTube의 fake engagement 정책 위험이 있다(스펙 [S28]).
- 패널 응답·연락처·개인 식별정보를 이 저장소, DB, fixture, 로그에 넣지 않는다(스펙 §12.4, `CLAUDE.md` §3).
  집계된 문항별 정답률과 코드북만 문서로 남긴다.
- 패널은 identity gate(§12.4, BOARD `D-9`)와 무관하다. 패널 참가자는 시청자가 아니고 동의 저장 대상도 아니다.

---

## 2. 5초 무음 이해 테스트 (제안)

### 2.1 자극물

| 항목 | 제안 | 라벨·근거 |
|---|---|---|
| 화면비·소리 | 9:16 세로, **무음** | `제안(근거: 스펙 §5.2 "소리를 끈 상태로")` |
| 노출 시간 | **5초** | `제안(근거: 스펙 §5.2 "5초 안에")` |
| 화면 출처 | Gate 2의 **private/unlisted 기술 방송**을 실제 모바일 YouTube 앱에서 화면 녹화한 정지 프레임 또는 5초 클립 | `제안(근거: 스펙 §14.2(1) "실제 YouTube 모바일 UI가 겹친". private/unlisted를 쓰는 이유는 1.5)` |
| 상태 종류 | 아래 6종에서 고른다 | `제안(근거: 구현된 대표 상태 목록 — apps/renderer/src/testing/preview-states.ts:419 PREVIEW_STATES)` |
| 1인당 제시 수 | **2종**(무작위 순서, **첫 자극물만 첫인상으로 채점**) | `제안(근거 없음)` |

`PREVIEW_STATES`의 6종(코드 그대로): `CALM`, `HUNGRY`, `PLAY`, `SLEEPING`, `DEGRADED`, `PAID_THANKS`.
이 중 **`HUNGRY`(평시에 목표가 떠 있는 화면)와 `SLEEPING`(위기 상태 화면)** 을 기본 2종으로 제안한다
`제안(근거 없음)`. `DEGRADED`(상호작용 일시정지)와 `PAID_THANKS`(유료 감사 연출)는 이해 테스트가 아니라
오해·안전 검사용이므로 별도 문항으로 돌린다 `제안(근거 없음)` — 특히 `PAID_THANKS`는 "돈을 내면 세지는가"라는
오해가 생기는지 확인하는 자리다(스펙 §8.5).

### 2.2 질문 4개와 화면 슬롯 대응

질문은 스펙 §5.2의 네 항목을 그대로 옮긴 것이고, "정답을 읽을 화면 근거"는 그 답이 화면 어디에서 읽혀야 하는지를
가리킨다. 일본어 문구는 **원어민 검수 전(`nativeReview: pending`)** 이며 Gate 3 sign-off 대상이다(§5.3).

| # | 스펙 §5.2 요구 | 일본어 질문 초안(`nativeReview: pending`) | 정답을 읽을 화면 근거 |
|---|---|---|---|
| Q1 | 살아 있는 크리처의 현재 상황 | いま、この生きものはどんな様子でしたか？ | `ui.slot.needOrMission` → `need.*` / `crisis.*` (`apps/renderer/src/i18n/ja.json`) |
| Q2 | 지금 달성할 공동 목표 하나 | いま、みんなで達成しようとしている目標は何でしたか？ | `ui.slot.needOrMission` → `mission.*` 와 목표 진행도 |
| Q3 | 무료로 입력할 명령 하나 | 参加するには、チャットに何と送ればいいですか？ | CTA 영역 — `ごはん`(🍙) / `あそぶ`(🎾) / `なでる`(❤️) (`packages/contract/src/commands.ts:85`) |
| Q4 | 다음 변화까지 남은 진행도 | 次の変化まで、あとどれくらいでしたか？ | `ui.slot.progress`(성장·챕터)와 `ui.slot.nextChoice`(다음 선택 시점) |

### 2.3 채점

| 항목 | 제안 | 라벨 |
|---|---|---|
| 채점 단위 | 문항당 0/1 | `제안(근거 없음)` |
| 채점자 | 2인 독립 채점 → 불일치 문항만 3인째가 조정 | `제안(근거 없음)` |
| 응답 형식 | 자유 서술(**선택지 제시 금지** — 보기를 주면 이해가 아니라 재인을 측정한다) | `제안(근거 없음)` |

정답 판정 코드북 제안 `제안(근거 없음)`:

| # | 정답으로 본다 | 오답으로 본다 |
|---|---|---|
| Q1 | 배고픔·졸림·지침·도움 필요처럼 **지금의 상태**를 지목 | "귀엽다", "동물이 있다"처럼 상태를 말하지 않는 인상 |
| Q2 | 화면의 미션(밥 나누기·리본 쫓기·조용히 함께·재료 모으기·등불 달기) 중 하나를 지목 | "키우는 것" 같은 일반론 |
| Q3 | `ごはん` / `あそぶ` / `なでる` 중 하나 또는 대응 아이콘을 지목 | "채팅한다"까지만 말하고 명령을 특정하지 못함 |
| Q4 | 남은 시간 또는 진행 막대의 위치를 근사하게 지목 | 시각·시간·진행을 전혀 언급하지 못함 |

### 2.4 통과 기준 (제안)

**1단계(n=5, 정성)**: 통과선을 두지 않는다. 목적은 합격 판정이 아니라 **무엇이 안 보이는지 찾는 것**이다
`제안(근거: [P1] — 5명은 문제 발견에는 충분하지만 비율 추정에는 부족하다)`. 1단계에서 나온 문제를 화면에 반영한
뒤 2단계를 돌린다.

**2단계(n=40, 정량)**:

| 문항 | 통과선 제안 | 라벨 |
|---|---|---|
| Q1 현재 상황 | 정답률 **≥ 80%** | `제안(근거 없음)` |
| Q2 공동 목표 | 정답률 **≥ 70%** | `제안(근거 없음)` |
| Q3 무료 명령 | 정답률 **≥ 70%** | `제안(근거 없음)` |
| Q4 남은 진행도 | 정답률 **≥ 50%** | `제안(근거 없음)` — 2.6의 이유로 가장 어려울 것으로 본다 |
| 종합 | 4문항 중 **3문항 이상**을 맞힌 참가자 비율 **≥ 70%** | `제안(근거 없음)` |

**중단 조건 제안**: Q3(무료 명령)이 **50% 미만**이면 Gate 3 public 파일럿을 시작하지 않는다
`제안(근거: 스펙 §2.3의 무료 핵심 플레이는 화면에서 명령을 읽을 수 있을 때만 성립한다 — 숫자 50%는 근거 없음)`.

**오차 해석(승인할 때 함께 봐야 하는 것)**: n=40·이항 지표·95% 신뢰수준에서 오차범위는 약 **±15%p**이다
[P2](확인 2026-08-19). 즉 관측 정답률 70%는 참값 55~85%와 양립한다. **이 폭을 감수할지, 인원을 늘려 좁힐지가
승인 대상**이다. 인원을 늘리면 비용이 오른다(1.4).

### 2.5 측정 방법

| 항목 | 제안 | 라벨 |
|---|---|---|
| 노출 통제 | 5초 정확히 노출한 뒤 화면 제거, 즉시 자유 서술 | `제안(근거: 스펙 §5.2)` |
| 사전 고지 | **"5초만 보여준다"고 미리 알리지 않는다** | `제안(근거: [P4] NN/g "Testing Visual Design", 2024-12-13 — 시간 제한을 미리 알리면 첫 반응이 왜곡된다. 확인 2026-08-19)` |
| 1단계 도구 | 대면 또는 원격 화면 공유 + 진행자 기록 | `제안(근거 없음)` |
| 2단계 도구 | 시간 제한 노출을 지원하는 온라인 설문/테스트 도구 | `제안(근거 없음)` — 도구 선정은 사용자 |
| 기록 항목 | 참가자 코드(개인 식별정보 없음), 자극물 id, 응답 원문, 채점자 2인의 점수, 최종 점수 | `제안(근거: 스펙 §12.4 — 개인정보를 저장소에 두지 않는다)` |

### 2.6 이 방법의 한계 (정직 표기)

- 업계에서 쓰는 **5초 테스트는 원래 "첫인상(visual first impression)" 방법**이고, 5초는 카피를 읽거나 세부를
  알아보기에는 **부족한 시간**이라고 출처가 명시한다 [P4]. 스펙 §5.2는 같은 5초 안에 네 개 사실의 **이해**를
  요구하므로 원 방법보다 강한 요구다. 따라서 통과의 부담은 문장이 아니라 **아이콘·형태·크기·색**에 있고, 문장이
  길수록 실패한다. 이 사실은 통과선을 낮추자는 뜻이 아니라 **자극물이 실패했을 때 무엇을 고쳐야 하는지**를 가리킨다.
- 현재 4번째 슬롯(`ui.slot.nextChoice`)은 "다음 선택 시점"을 **남은 시간과 절대 JST 시각**으로 보여주고
  (`apps/renderer/src/components/Hud.tsx:118`–`131`), 그 값은 하루 챕터 구조상 **몇 시간 뒤**가 될 수 있다
  (3.3 타임라인: 06:00 JST 시작 → 14:24 JST turn). `apps/server/src/world/project.ts:48`의 `nextChoiceAt`이
  choice 창이 열리기 전에는 turn beat 시각을 그대로 돌려주기 때문이다. Q4의 통과율이 낮게 나올 가능성이 크며,
  그것은 **패널이 답을 주어야 할 튜닝 질문**이지 이 문서가 미리 정할 값이 아니다.
- `content/tuning.ts`의 `choice.previewLeadMs`(30분)는 **정의만 있고 reducer가 참조하지 않는다**
  (grep: `previewLeadMs`는 `apps/server/src/world/content/tuning.ts`에만 나온다). 즉 "선택 30분 전 예고"는 현재
  동작하지 않는다. 화면을 고쳐야 한다면 T21이 아니라 별도 task다(5장 A-5).

### 2.7 언제 다시 돌리는가

- Gate 3 선행조건(§15 Gate 3): "실제 YouTube 모바일 UI가 겹친 첫 화면 이해 테스트를 Gate 0 기준으로 통과".
  즉 **여기서 승인한 기준으로** 통과해야 public 파일럿을 시작한다.
- 4개 슬롯의 문구·아이콘·레이아웃, 크리처 자산, CTA 문구가 바뀌면 2단계를 다시 돌린다 `제안(근거 없음)`.
- **T20c(identity (B) 렌더러)가 머지되면 CTA에 고지 한 줄과 동의/철회 명령(`なのる`/`なまえけす`,
  `packages/contract/src/commands.ts:113`)이 추가된다**(BOARD `D-9`). CTA 영역이 늘어나면 Q3의 읽힘이 달라지므로,
  **자극물은 T20c가 반영된 화면으로 잡는다** `제안(근거: D-9로 확정된 후속 구현이 첫 화면을 바꾼다)`.

---

## 3. 24시간 콘텐츠 목록 (T7 디렉터 코드에서 도출)

### 3.1 어떻게 도출했고 어떻게 재현하는가

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

### 3.2 승인 대상 어휘 (코드 식별자 = 화면 어휘)

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

### 3.3 하루 챕터 타임라인 (JST)

챕터는 **매일 06:00 JST에 시작**하고(`chapter.anchorHourJst = 6`, `tuning.ts:171`) 다음 06:00까지 이어진다
(`chapterEndFor`, `world/reducer.ts:426`). 비트 시각은 챕터 길이의 고정 비율이다(`turnFraction = 0.35`,
`resolutionFraction = 0.72`, `tuning.ts:173`–`174`).

| JST | 무엇이 일어나는가 | 근거 |
|---|---|---|
| 06:00 | `chapter_started` — 그날 챕터의 `setup` 비트. 챕터는 직전 날과 다른 것으로 뽑는다 | `reducer.ts:446` `pickChapterId` |
| 14:24 | `chapter_beat`(`turn`) + `choice_opened` — 그날의 분기점이 열린다 | `0.35 × 24h` |
| 14:24–14:44 | 선택 창 20분. identity gate가 닫힌 V1에서는 **투표가 아니라** 무료 명령 총량을 가중치로 쓰는 비경쟁 집계 | `choice.windowMs`(`tuning.ts:168`), 스펙 §6.4 |
| 14:44 | `choice_resolved` → 조합 1개 확정(예: `combo_forage_garden`), 장소·미션 성향이 바뀐다 | 관측(3.5) |
| 23:16 | `chapter_resolved` — 결말 비트, 성장·유대 가산 | `0.72 × 24h`, `reducer.ts:552` |
| 다음 06:00 | 다음 챕터 `chapter_started` | 관측(3.5) |

즉 스펙 §6.2가 요구하는 **시작 → 변화 → 결말**이 하루 안에 한 번씩 있고, 관측에서도 `chapter_started` 1회 이상,
`chapter_beat` 1회, `chapter_resolved` 1회로 나온다(`world/acceptance.test.ts`의 첫 테스트와 같은 성질).

### 3.4 JST 시간대별 콘텐츠 표

시간대 경계는 코드가 정한 값이다(`world/time.ts:72`). "언제나"는 시간대와 무관하게 도는 타이머다.

| 시간대(JST) | phase | 이 구간에 고정으로 오는 것 | 이 구간에서 주로 보이는 연출(조건부) |
|---|---|---|---|
| 04:00–06:59 | `dawn` | 04:00 `phase_changed→dawn`, **06:00 `chapter_started`** | `idle_dawn_yawn`(`phases:['dawn']`), `recover_wake_dawn`, `crisis_sleep_curl`에서 깨어나는 구간 |
| 07:00–11:59 | `morning` | 07:00 `phase_changed→morning` | `idle_sun_stretch`(`phases:['morning']`+`clear`), `mission_meal_together`, `visitor_postal_bird` |
| 12:00–16:59 | `afternoon` | 12:00 `phase_changed→afternoon`, **14:24 `chapter_beat(turn)`+`choice_opened`**, **14:44 `choice_resolved`** | 확정된 조합의 장소로 이동(`garden`/`riverside`/`home_room`/`night_terrace`), `mission_gather_basket`, `mission_ribbon_*` |
| 17:00–20:59 | `evening` | 17:00 `phase_changed→evening` | `visitor_lantern_moth`, `mission_quiet_night`, `mission_lantern_calm`(`phases:['evening','night']`) |
| 21:00–03:59 | `night` | 21:00 `phase_changed→night`, **23:16 `chapter_resolved`** | `crisis_sleeping`(밤에 `rest` 압력이 임계 초과), `idle_star_gaze`(`night`+`starry`/`clear`), `idle_curl_sleep`, `weather_star_clear`, `growth_stage_advanced` |
| 언제나 | — | `idle_beat` 30–75초(`tuning.ts:132`), `need_decay` 90초(`tuning.ts:135`), **미션 20분 주기**(`mission_started`→`mission_resolved`, `tuning.ts:159`), `weather_change` 150분 판정(`tuning.ts:179`, 값이 바뀔 때만 전이), `visitor_arrival` 210분 판정·체류 40분(`tuning.ts:181`), `crisis_recovery` 300초 판정(`tuning.ts:152`) | 무료 명령이 들어오면 그 자리에서 `feed_*`/`play_*`/`pet_*` 반응 20종 중 하나 |

**유료 이벤트**는 시간대와 무관하게 `PAID_THANKS` 연출 1회만 만들고(원 연출 시간이 지나면 대체 감사 연출 1회,
스펙 §9.2), 상태·확률·성장·선택에 어떤 영향도 주지 않는다(스펙 §8.5, `world/paid.ts`, `world/paid.test.ts`).

### 3.5 입력 0으로 관측한 하루 (측정값)

3.1(b) 명령을 5개 시드로 실행한 결과다. **시청자 입력·결제 0**이다.

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

### 3.6 반복 장면 표본 검토 기준 (제안, 스펙 §12.5)

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

## 4. 일본 시장 증빙 방식과 Gate 4 합격 기준 (제안)

### 4.1 무엇을 쓸 수 있고 무엇을 못 쓰는가

| 쓸 수 있다 | 근거 |
|---|---|
| YouTube Analytics/Studio의 공식 aggregate: 조회수, 시청시간, 평균 시청 지속시간, traffic source, **geography(`country`)** | 스펙 §14.1, [P5] |
| 내부 무식별 카운터: 유효 명령 수, 창 집계 결과, 명령 성공률 | 스펙 §14.1 "무식별 유효 명령 수", `apps/server/src/input/metrics.ts` |
| 승인된 일본 패널 결과(1–2장) | 스펙 §15 Gate 4 "승인된 일본 패널" |

| 못 쓴다(승인 전) | 근거 |
|---|---|
| 개인 D1·D7·D30 재명령률, `고유 작성자 / 1,000 engaged views`, `/viewer-hour`, 상위 결제자 집중도 | 스펙 §14.1 "승인 후 후보" + [S42] derived-metric 정책 — **계산·저장하지 않는다** |
| 시청자 개인 식별정보 기반 국가 추정 | 스펙 §12.4, [S41] |

### 4.2 일본 시장 증빙: geography aggregate

- **차원**: YouTube Analytics API의 `country` 차원은 ISO-3166-1 alpha-2 두 글자 코드이며(일본은 `JP`), 국가를
  식별하지 못한 행은 `ZZ`로 보고된다 [P5](확인 2026-08-19).
- **한계(중요)**: "Metrics or dimensions related to countries or regions where viewers were located may be
  limited"이고, **"The actual thresholds at which data is limited are not published and subject to change at
  YouTube's discretion"** [P6](확인 2026-08-19). 즉 **트래픽이 작으면 일본 행 자체가 나오지 않을 수 있고, 그
  임계치는 공개되지 않는다.**
- **그때 무엇을 하는가**(제안): ① 기간을 늘려 재조회, ② 필터·breakdown을 제거하고 재조회, ③ 그래도 비면
  **"일본 검증 완료"를 선언하지 않고 미달로 기록한다.** 이것은 제안이 아니라 스펙 §15 Gate 4의 문장이다
  ("개인정보 threshold로 국가 데이터가 제공되지 않으면 일본 검증 완료를 선언하지 않음").
- **유입 경로**: `insightTrafficSourceType`에는 `BROWSE`(홈·구독 피드 등 탐색 기능), `SHORTS`(Shorts 시청
  경험에서의 세로 스와이프), `LIVE_REDIRECT` 등이 있다 [P7](확인 2026-08-19). **세로 Live 피드 유입이 어떤
  값으로 집계되는지는 공식 문서에서 확정하지 못했다** — `확인 필요(출처 없음)`, Gate 2 실계정에서 확인한다.

### 4.3 패널과 Analytics의 역할 분담

| | 패널(1–2장) | Analytics aggregate(4.2) |
|---|---|---|
| 답하는 질문 | 일본 시청자가 **화면을 이해하는가** | 일본에서 **실제로 발견·시청·참여가 일어나는가** |
| 표본 | 모집한 40명 | 실제 시청자 전체(임계치 이상일 때) |
| Gate | Gate 3 선행조건 | Gate 4 |
| 결합 방식 | **두 값을 하나의 점수로 곱하거나 더하지 않는다.** 패널은 원인 쪽, Analytics는 결과 쪽 증거이며 Gate 4는 **둘 다** 요구한다(§15) | |

패널이 통과했는데 Analytics가 미달이면 "화면은 이해되지만 일본에서 발견되지 않았다"로 기록한다. 반대면
"발견은 됐지만 이해는 검증되지 않았다"이며, 어느 쪽도 서로를 대체하지 못한다.

### 4.4 Gate 4 발견·시청·참여 합격 기준 (제안)

스펙 §15 Gate 4는 **"기간·표본·통과선·중단선을 먼저 고정하고, 겹치지 않는 post-freeze validation에서 세 축을
모두 통과"** 를 요구하고, §14.1은 **"절대 성공 수치는 기준선과 비용을 수집한 뒤, 결과를 보기 전에 평가 기간과
함께 고정한다"** 고 못박는다. 따라서 **이 문서는 절대 숫자를 정할 수 없다** — 기준선이 아직 없기 때문이다.
정할 수 있는 것은 **절차와 식의 형태**이며, 아래가 그 제안이다.

**절차 제안**

| 단계 | 내용 | 라벨 |
|---|---|---|
| ① baseline | Gate 3 파일럿 이후 **연속 14일** 관측. 이 구간에서는 통과 판정을 하지 않는다 | `제안(근거 없음)` |
| ② freeze | baseline 값을 보고 **통과선 숫자를 문서에 적어 커밋한다**(BOARD `D-*` + 이 파일). 이후 수정 금지 | `제안(근거: 스펙 §14.1 "결과를 보기 전에 고정")` |
| ③ validation | baseline과 **겹치지 않는 연속 14일**. 여기 숫자로만 판정 | `제안(근거: 스펙 §15 "겹치지 않는 post-freeze validation")` |
| 표본 요건 | validation 14일 중 방송 가동률 **≥ 90%**, 일 단위 표본 14개 | `제안(근거 없음)` |

**세 축의 지표와 식의 형태**

| 축 | 지표(정책상 허용) | 통과선의 형태 | 라벨 |
|---|---|---|---|
| 발견 | `country=JP`의 일별 조회수, JP 비중, traffic source 분포 | validation의 **일별 중앙값 ≥ freeze에서 적은 절대값** | 절대값은 ② 이전에는 `제안 불가` |
| 시청 | `country=JP`의 일별 평균 시청 지속시간 | 같음 | 같음 |
| 참여 | 방송 1시간당 **무식별 유효 명령 수**, **명령 성공률**(수락/명령처럼 보이는 메시지) | 같음. 명령 성공률만 절대 하한 **≥ 70%** 를 제안한다 | `제안(근거 없음)` |

**중단선 제안**

| 조건 | 처리 | 라벨 |
|---|---|---|
| 누적 손실 50만원 도달 또는 관측 6개월 경과 | 중단 | `제안(근거: BOARD D-14 승인값)` |
| JP geography 행이 **2주 연속 limited data로 비어 있음** | "일본 검증 미달"로 기록하고, 기간 연장 여부를 사용자에게 묻는다. 자동 연장하지 않는다 | `제안(근거: 스펙 §15 Gate 4 + [P6])` |
| validation 도중 통과선을 고치고 싶어짐 | **금지**. 고치면 그 validation은 무효이고 ①부터 다시 한다 | `제안(근거: 스펙 §14.1)` |

### 4.5 확인 필요 항목 (지금 확정하지 못한 것)

| # | 항목 | 상태 |
|---|---|---|
| 1 | `engaged views`가 세로 Live에도 제공되는가 | `확인 필요(출처 없음)` — 공식 도움말 [P8]에는 정의가 없고 "평균 시청 지속시간" 설명 안에서 한 번 언급될 뿐이다(확인 2026-08-19). Gate 2 실계정 Studio에서 확인한다 |
| 2 | 세로 Live 피드 유입이 `insightTrafficSourceType`의 어떤 값으로 집계되는가 | `확인 필요(출처 없음)` — 4.2 |
| 3 | 명령 성공률을 `GET /metrics`에서 읽을 수 있는가 | **읽을 수 없다.** `commandSuccessRatio`는 구현되어 있으나(`apps/server/src/input/metrics.ts:25`) production 경로 `chatParserPort`가 `metrics`를 넘기지 않는다(`apps/server/src/youtube/chat/runtime.ts:124`). Gate 4에서 쓰려면 배선이 필요하다(5장 A-6) |

---

## 5. 사용자에게 요청하는 승인 항목

각 항목에 **승인 / 수정(값 지정) / 반려** 중 하나를 정해 주면 BOARD `D-*`에 기록하고
[`gate0-checklist.md`](gate0-checklist.md) §1.4 체크박스를 채운다.

| # | 승인 대상 | 이 문서의 제안 | 결정 |
|---|---|---|---|
| A-1 | 패널 규모·구성 | 1단계 5명(정성) → 2단계 40명(정량), 18–34세, 일본 거주·일본어 모어, 본인 스마트폰 YouTube 앱 | |
| A-2 | 5초 테스트 통과 기준 | Q1 ≥80% / Q2 ≥70% / Q3 ≥70% / Q4 ≥50%, 종합(3문항 이상) ≥70%, Q3 <50%면 Gate 3 미시작 | |
| A-3 | 24시간 콘텐츠 목록 | 3.2의 어휘 표 전체(챕터 3 × 조합 9, 디렉터 규칙 10, 미션 5, 연출 변형 71) | |
| A-4 | 패널 비용의 예산 처리 | 월 예산(D-14) 안에서 볼지 별도 항목으로 볼지 | |
| A-5 | 반복 장면 기준 | 하루 고유 전이 ≥60, 반복 서사 장면 비율 ≤0.55, 사람 표본 검토 매일 6구간×5분 | |
| A-6 | 일본 시장 증빙 방식 | geography `country=JP` aggregate + 패널, 국가 행이 비면 미달로 기록 | |
| A-7 | Gate 4 절차 | baseline 14일 → freeze(숫자 커밋) → 겹치지 않는 validation 14일, 가동률 ≥90%, 명령 성공률 ≥70% | |
| A-8 | 후속 코드 작업 착수 여부 | (a) 명령 성공률을 `GET /metrics`에 노출, (b) `choice.previewLeadMs`를 실제 예고에 쓰기 — 둘 다 이 문서 범위 밖의 별도 task | |

---

## 6. 출처

이 문서가 외부 사실로 인용한 것 전부다. 확인일은 2026-08-19이며, 실행 전에 다시 확인한다.

| # | 출처 | URL | 확인일 |
|---|---|---|---|
| [P1] | Nielsen Norman Group, "Why You Only Need to Test with 5 Users" (Jakob Nielsen, 2000-03-18) | https://www.nngroup.com/articles/why-you-only-need-to-test-with-5-users/ | 2026-08-19 |
| [P2] | Nielsen Norman Group, "How Many Participants for Quantitative Usability Studies: A Summary of Sample-Size Recommendations" (Budiu·Moran, 2021-07-25) | https://www.nngroup.com/articles/summary-quant-sample-sizes/ | 2026-08-19 |
| [P3] | Prolific Researcher Help, "Who are the participants on Prolific?" — 참가자 거주 국가 목록(일본 포함) | https://researcher-help.prolific.com/en/articles/445224-who-are-the-participants-on-prolific | 2026-08-19 |
| [P4] | Nielsen Norman Group, "Testing Visual Design: A Comprehensive Guide" (Megan Chan, 2024-12-13) — 5초 테스트의 정의와 한계, 사전 고지 금지 | https://www.nngroup.com/articles/testing-visual-design/ | 2026-08-19 |
| [P5] | Google, "Dimensions — YouTube Analytics and Reporting APIs" — `country` 등 geographic dimensions | https://developers.google.com/youtube/analytics/dimensions | 2026-08-19 |
| [P6] | YouTube Help, "Understand limited data in YouTube Analytics" — 국가/지역 지표의 limited data, 임계치 비공개 | https://support.google.com/youtube/answer/9101241 | 2026-08-19 |
| [P7] | Google, "Dimensions — Traffic source dimensions" — `insightTrafficSourceType` 값 | https://developers.google.com/youtube/analytics/dimensions#Traffic_Source_Dimensions | 2026-08-19 |
| [P8] | YouTube Help, "Understand your YouTube engagement" — engaged views의 독립 정의 없음(확인 결과) | https://support.google.com/youtube/answer/9313698 | 2026-08-19 |

스펙이 이미 인용한 출처는 번호를 그대로 쓴다: [S28](fake engagement 정책), [S41](API Data 식별정보·동의),
[S42](파생 지표 정책) — URL은 [`docs/PROJECT_SPEC.md`](../PROJECT_SPEC.md) §18에 있다.
