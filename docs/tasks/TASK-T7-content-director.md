# TASK-T7-content-director

- Task: T7 콘텐츠 디렉터·크리처 상태 모델 (순수 도메인) (`docs/tasks/TASK_SPECS.md` §T7)
- Branch: `dnhynk/t7-content-director` · PR: #<n>
- Orca: task `task_e1e7531798ad` · dispatch `ctx_f38356ff64be`
- Spec sections read: §2.1–§2.4, §5.2, §5.3, §6.1–§6.4, §7.1, §7.3, §7.4, §8.4, §8.5, §9.2, §10.2, §12.3, §12.5, §14.1
- BOARD decisions/assumptions relied on: D-1, A-1, A-3, A-9, A-15

## Goal

`apps/server/src/world/`에 I/O·DB·타이머가 없는 순수 도메인을 만든다. 핵심은 reducer
`step(state, input, now, rng) → {state, transitions, effects, deadlines}` 하나이며, 여기에 스펙 §6.3 상태 모델,
§6.2의 4개 시간 규모 콘텐츠(수초·수분·수시간·하루 챕터), §6.4의 두 분기 경로(identity gate 개방 시 A/B/C 투표,
닫힘 시 디렉터 승인 사건 조합 + 비경쟁 집계), §8.4–§8.5의 유료 무영향 감사 연출과 §9.2의 대체 감사 연출,
§12.5의 반복 방지 변주와 §14.1 "신선도" 계산 함수가 들어간다. 영속·발행·ACK·트랜잭션은 T8이 이 reducer를 감싼다.

## Plan

1. **골격**: `apps/server/src/world/`에 타입(`types.ts`)·시드 RNG(`rng.ts`)·콘텐츠 카탈로그(`content/`)·reducer(`reducer.ts`) 파일을 만들고
   `apps/server/src/index.ts`에서 `./world/index.js`를 re-export 한다. `packages/contract`는 **읽기만** 한다(이 task는 `[contract]` 아님).
2. **상태(§6.3)**: `WorldState = { world: GameState, audit: AuditState }`로 나눈다.
   - `GameState`: 크리처(생애·성장 단계, 욕구 압력, 정서, 유대·성장 진행, 위기 `sleeping|tired|needs_help|null`),
     환경(장소·시간대·날씨·방문자), 챕터(일자·비트·분기), 미션, 선택 창, identity 플래그, 변주 이력, deadline 스케줄.
   - `AuditState`: 유료 감사 연출 대기열뿐. 유료 입력 경로는 반환 타입상 `GameState`를 만들 수 없다 → **결제가 게임 파워를 사지 못함을 타입으로 강제**(§8.5).
3. **감쇠·성장**: 욕구 압력은 `need_decay` deadline으로 증가하고 무료 명령으로 감소한다. 위기 상태는 시간 경과와 무료 행동으로만 회복하며
   성장 진행도는 단조 비감소(영구 퇴화·죽음 없음, §6.3). 성장 단계 전이는 무료 기여만으로 완주 가능(§2.3).
4. **시간 규모 콘텐츠(§6.2)** 를 `content/` 데이터로 둔다: 수초(idle 비트·행동 반응), 수분(욕구 해결·놀이 미션·장소 선택),
   수시간(시간대·날씨·방문자·성격 반응), 하루(재료 찾기/축제 준비/성장 선택 챕터의 setup→turn→resolution). 하루 경계는 JST(§5.3).
5. **deadline 정책(§10.2)**: `DEADLINE_DEFINITIONS`를 `satisfies Record<DeadlineKind, DeadlineDefinition>`로 두어
   종류 하나라도 `policy`가 빠지면 **타입 오류**가 나게 한다. `ScheduledDeadline`은 정의 표를 통해서만 만들어지므로 policy 없는 deadline은 존재할 수 없다.
   `recoverDeadlines()`로 replay/coalesce/skip 복구 의미를 이 패키지에서 정의해 T8이 추측하지 않게 한다.
6. **분기(§6.4, A-9)**: `identity.gateOpen=true` → A/B/C 투표 창(`VOTE_A|B|C` 집계, 마감 deadline에서 결정, 동률은 시드 RNG).
   `false` → 투표 창을 열지 않고 디렉터가 승인된 사건 조합 규칙 + 비경쟁 집계(무료 명령 총 기여)로 분기를 정하고,
   화면에는 `nextChoiceAt`(다음 선택 시점) 예고만 낸다. 두 경로 모두 구현하고 플래그로 나눈다. 사용자 단위 공정성을 주장하지 않는다.
7. **유료(§8.4, §8.5, §9.2)**: 유료 이벤트 → 고정 감사 연출 effect 1건 + `paid_thanks_fallback` deadline.
   원 연출 시각이 지나면 `fallback: true` 감사 연출을 **정확히 1회** 낸다. 유료 경로는 RNG를 소비하지 않는다(소비하면 이후 확률이 달라지므로 §8.5 위반).
8. **반복 방지(§12.5)·신선도(§14.1)**: 변주 후보는 상태·챕터·환경 조건으로 필터 → 최근 사용분 제외 → 시드 가중 추첨.
   `countUniqueTransitions`, `repeatedSceneRatio`, `computeFreshness`를 제공하고 최소치는 `provisional` 라벨(A-15).
9. **테스트**: (1) 입력 0 가상 24h 챕터 완결·고유 전이 최소치·불사 (2) 같은 시드·같은 입력 → 같은 결과
   (3) 유료 무영향 속성 테스트(임의 유료 이벤트를 임의 위치에 끼워 넣어도 `world` 참조까지 동일) (4) deadline policy 누락 시 타입 오류(`@ts-expect-error`)
   (5) 거부 경로: 투표 창이 닫혀 있을 때의 `VOTE_*`, gate 닫힘 상태의 투표, 미지원 입력.
10. 게이트(`format:check`/`lint`/`typecheck`/`test`/`build`) 실행 후 PR.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| (없음 — 이 task는 플랫폼 API를 호출하지 않는 순수 도메인이다. 근거는 전부 `docs/PROJECT_SPEC.md`) | — | — | — |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| timer 유래 effect의 `causedByEventKey`: contract는 non-null `{source}:{broadcastId}:{messageId}`를 요구하는데 deadline 입력에는 event가 없다. (A) T7은 `EffectDraft`만 반환하고 조립은 T8 (B) 타이머 effect 미발행 (C) 지금 contract 변경 | **A**. "§7.3(6)의 `causedByEventKey`는 event 유래 effect의 원인 표기이므로 타이머 유래 effect는 계약 확장이 필요하고, 그것은 `[contract]` 변경이라 T7 범위 밖. reducer는 `EffectDraft{kind, payload, startsAt/endsAt, paid, cause}`만 반환하고 `effectId`/`stateRevision`/`causedByEventKey` 조립은 T8. cause 판별자는 `world/` 안에 두되 필드명은 `cause.kind`/`eventKey`/`deadlineKind`로 맞춘다(계약 후속 T1b에서 같은 형태로 승격). 유료 effect는 항상 `cause.kind='event'`임을 타입/테스트로 고정." | `EffectDraft`·`EffectCause`를 `world/types.ts`에 정의(`effect.ts`), 유료 감사 연출은 `PaidThanksDraft`가 `EventCause`를 요구해 타입으로 강제 + `paid.test.ts` |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| effect 조립 책임 | reducer는 `EffectDraft`(+`cause` 판별자)만 반환, `effectId`/`stateRevision`/`causedByEventKey`는 T8 | 코디네이터 결정(위 Q&A) | contract `Effect.causedByEventKey`가 non-null이라 타이머 유래 effect를 표현할 수 없다. 계약 후속 **T1b**(`causedByEventKey` nullable + `cause` 판별자 승격)는 코디네이터가 등록한다 |
| 튜닝 상수 위치 | `apps/server/src/world/content/tuning.ts`의 `DEFAULT_WORLD_TUNING`(`provisional: true` 필드 포함), `step`/카탈로그가 override를 받는다 | provisional (A-15) | `config/default.json`은 아직 main에 없고 PR #3·#4가 동시에 추가 중이라 이 PR이 같은 파일을 만들면 충돌한다. T8이 config→`WorldTuning`으로 주입하면 된다 |
| 신선도 최소치 | `uniqueTransitionsPerVirtualDay >= 40`, `repeatedSceneRatio <= 0.55` (24h·입력 0 기준) | provisional (A-15) | 스펙 §14.1은 "고유 상태 전이"·"반복 장면 표본 비율"을 지표로만 정하고 합격선을 정하지 않는다. 실제 구현이 내는 값(64 / 0.33)보다 낮게 잡은 회귀 방지선이며 Gate 0/2 승인값으로 교체한다 |
| 챕터·비트 시각 | 하루 챕터 = JST 자정 경계, setup 0h / turn +7h(선택 창 30분) / resolution +16h | 콘텐츠 정의 | 스펙 §5.3이 방송 시간 기준을 JST로 정하고 §6.2가 시작→변화→결말을 요구한다. 수치 자체는 콘텐츠 설계값이라 합격선이 아니다 |
| 위기 상태 집합 | `sleeping` \| `tired` \| `needs_help` | 스펙 §6.3 예시 그대로 | §6.3이 세 예시를 직접 든다. 죽음·영구 퇴화 상태는 만들지 않는다 |
| 욕구 집합 | `hungry` \| `play` \| `affection` \| `rest` | 콘텐츠 정의 | §7.1의 무료 명령 3종(FEED/PLAY/PET)에 각각 대응하는 욕구 + 시간 경과로만 회복하는 `rest`(§6.3 `잠듦`) |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
(작성 중)
```

## Not done / out of scope

- 영속·트랜잭션·WS 발행·ACK·`stateRevision` 발급·유료 멱등 ledger — T8
- 명령 파싱·모더레이션·입력 arbiter(direct/aggregate 전환 임계값) — T6
- 화면·i18n 일본어 문구 — T5/T14 (이 task는 `TextKey`만 발행한다)

## Follow-ups

- (작성 중)
