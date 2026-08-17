# TASK-T7-content-director

- Task: T7 콘텐츠 디렉터·크리처 상태 모델 (순수 도메인) (`docs/tasks/TASK_SPECS.md` §T7)
- Branch: `dnhynk/t7-content-director` · PR: #6
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
| effect 조립 책임 | reducer는 `EffectDraft`(+`cause` 판별자)만 반환, `effectId`/`stateRevision`/`causedByEventKey`는 T8 | 코디네이터 결정(위 Q&A) + **T1b 머지됨(PR #7, 6efc9b5)** | 계약이 `EffectCauseSchema`를 갖게 됐으므로 round 1에서 world의 `EffectCause`를 계약 타입과 정렬했다. world 쪽은 `deadlineKind`가 닫힌 union이라 더 좁고, `deadlineId`는 **필드 자체를 두지 않는다**(영속 row id는 T4/T8만 발급). `WorldEffectCauseIsContractCause` 타입과 `EffectCauseSchema` 파싱 테스트가 정렬을 강제한다 |
| 튜닝 상수 위치 | `apps/server/src/world/content/tuning.ts`의 `DEFAULT_WORLD_TUNING`(`provisional: true` 필드 포함), `step`/카탈로그가 override를 받는다 | provisional (A-15) | `config/default.json`은 아직 main에 없고 PR #3·#4가 동시에 추가 중이라 이 PR이 같은 파일을 만들면 충돌한다. T8이 config→`WorldTuning`으로 주입하면 된다 |
| 신선도 최소치 | `uniqueTransitionsPerVirtualDay >= 40`, `maxRepeatedNarrativeSceneRatio <= 0.7` (24h·입력 0 기준, 표본 200) | provisional (A-15) | 스펙 §14.1은 "고유 상태 전이"·"반복 장면 표본 비율"을 지표로만 정하고 합격선을 정하지 않는다. 4개 시드 실측이 unique 74–81 / narrative ratio 0.388–0.434라서 그보다 느슨하게 잡은 **회귀 방지선**이며 Gate 0/2 승인값으로 교체한다 |
| "반복 장면 표본"의 표본 정의 | 두 값을 함께 보고한다: 전체 staged scene 기준 `repeatedSceneRatio`(실측 0.83–0.88)와 수초 idle을 뺀 `repeatedNarrativeSceneRatio`(실측 0.39–0.43). 합격 판정은 후자 | 설계 판단 | 24h ambient 방송은 수초 idle 연출이 표본의 82%(1646/2003)를 차지해 전체 비율이 idle 반복만 측정하게 된다. §12.5가 막으려는 것은 "같은 **장면** 반복"이므로 수분 이상 스케일을 판정 표본으로 쓰되, 전체 비율도 숨기지 않고 같이 낸다 |
| 챕터·비트 시각 | 챕터 경계 = JST 06:00(첫 챕터는 최소 8시간), 비트는 챕터 길이의 0%(setup) / 35%(turn, 선택 창 20분) / 72%(resolution) | 콘텐츠 정의 | 스펙 §5.3이 방송 시간 기준을 JST로 정하고 §6.2가 시작→변화→결말을 요구한다. 비율로 두면 콜드 스타트 시각과 무관하게 세 비트가 모두 하루 안에 들어간다. 수치 자체는 콘텐츠 설계값이라 합격선이 아니다 |
| skip 정책의 완결성 | `skip`은 만료 기록 + pending 제거 + **후속 재무장**까지 한다. `skip`을 받을 수 있는 종류는 `recurrence: 'interval'`(튜닝과 `now`만으로 다음 due를 계산 가능한 것)로 제한한다 | round 1 blocker 수정 | 만료만 기록하면 idle_beat가 영원히 같은 과거 deadline으로 남거나(상태 유지 시) 재무장 없이 사라져(외부 삭제 시) 무입력 진행이 멎는다(§2.1). 재무장을 도메인 안에서 끝내야 T8이 도메인 동작을 지어내지 않는다(§10.2) |
| 비경쟁 집계의 가중치 | 디렉터 모드에서 무료 명령 총량은 `min(6, sqrt(count))`만큼만 분기 가중치에 더한다(`choice.contributionWeightCap`) | provisional (A-15) | 원시 카운트를 그대로 쓰면 사실상 표 계산이 되어 §6.4의 "비경쟁 집계"가 아니게 되고, 사용자 단위 공정성 없는 투표가 된다. 감쇠·상한을 두면 방의 기여가 신호로는 남되 승인 사건 조합 규칙을 무력화하지 않는다 |
| 유료 이벤트에 실린 명령 | 실행하지 않는다(감사 연출만) | 설계 판단 | §8.5. Super Chat 메시지에 붙은 `FEED`를 실행하면 결제가 행동을 사는 경로가 생긴다. 같은 명령은 무료로 보내면 그대로 반영된다 |
| 위기 상태 집합 | `sleeping` \| `tired` \| `needs_help` | 스펙 §6.3 예시 그대로 | §6.3이 세 예시를 직접 든다. 죽음·영구 퇴화 상태는 만들지 않는다 |
| 욕구 집합 | `hungry` \| `play` \| `affection` \| `rest` | 콘텐츠 정의 | §7.1의 무료 명령 3종(FEED/PLAY/PET)에 각각 대응하는 욕구 + 시간 경과로만 회복하는 `rest`(§6.3 `잠듦`) |

## Result

구현 위치: `apps/server/src/world/` (reducer `reducer.ts`, 상태·타입 `types.ts`, 시드 RNG `rng.ts`,
deadline 정책 `deadlines.ts`, 크리처 `creature.ts`, 분기 `choices.ts`, 유료 `paid.ts`,
반복 방지·신선도 `variation.ts`, read model 투영 `project.ts`, 순수 드라이버 `run.ts`,
콘텐츠 데이터 `content/{tuning,variants,chapters}.ts`). `packages/contract`는 **읽기만** 했다.

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 입력 0 가상 24시간 진행 시 일일 챕터가 시작·변화·결말을 갖는다 | met | `acceptance.test.ts` "completes a daily chapter with a start, a change and an end" — 시드 3개 각각 `chapter_started` ≥1, `chapter_beat`(turn) 1, `chapter_resolved` 1이고 시각 순서까지 검사. `choice_opened`/`choice_resolved`도 각 1 |
| 1 | 고유 전이 수가 사전 정의 최소치 이상 (값은 provisional) | met | `acceptance.test.ts` "meets the provisional freshness floors" — `uniqueTransitions >= 40`(실측 74–81), `repeatedNarrativeSceneRatio <= 0.7`(실측 0.388–0.434). 최소치는 `FRESHNESS_MINIMUMS.provisional === true`로 라벨되어 있고 테스트가 그 라벨도 검사한다 |
| 1 | 크리처가 죽지 않는다 | met | `acceptance.test.ts` "never kills or permanently degrades the creature" — 욕구 압력 [0,1], 성장 단계 인덱스 유효, 등장한 위기는 `sleeping\|tired\|needs_help`뿐, 입력 0에서도 위기 진입·회복이 모두 발생(진입 15 / 회복 12). 단위 근거는 `creature.test.ts`(음수 성장 무시, 최종 단계 포화, 압력 클램프) |
| 1b | 성장 단계를 무료 참여만으로 완주 | met | `acceptance.test.ts` "reaches the last growth stage with no payment and no viewer input" — 입력 0으로 5일차에 `guardian` 도달, 그동안 `paid` effect 0건, 단계 인덱스 단조 비감소 |
| 2 | 같은 시드·같은 입력 → 같은 결과 | met | `acceptance.test.ts` "replays a full virtual day to the identical state and transitions"(24h 전체 재생 동일), `reducer.test.ts` "produces the same state and transitions for the same seed and inputs" / "produces a different world for a different seed" / "does not depend on the identity of the injected generator", `rng.test.ts` 전체 |
| 3 | 유료 이벤트가 상태 수치·확률·선택 결과를 바꾸지 않는다(속성 테스트) | met | `paid.test.ts` — (a) 단일 step에서 `result.state.world`가 **참조까지 동일**(`toBe`) (b) 시드 RNG로 만든 유료 이벤트 40건을 6시간 실행에 끼워 넣어도 world·비유료 transition·비유료 effect가 baseline과 동일 (c) 10건을 11시간에 끼워도 크리처·분기·환경 동일. 구조적 강제: `applyPaidEvent`는 `AuditState`만 받고 반환하며 `Rng`를 아예 받지 않는다 |
| 4 | 모든 deadline 종류에 policy가 있고 누락 시 타입 오류 | met | `DEADLINE_DEFINITIONS ... as const satisfies Record<DeadlineKind, DeadlineDefinition>` + `ScheduledDeadline`의 유일한 생성자 `scheduleDeadline()`가 표에서 policy를 복사. `deadlines.test.ts` "fails to compile when a kind has no policy"의 `@ts-expect-error`가 `npm run typecheck`에서 이 규칙을 강제하고(제거하면 typecheck 실패), 런타임 커버리지도 함께 검사. **round 1 이후**: policy가 있는 것으로 끝나지 않고 세 정책의 복구 의미가 도메인 안에서 완결된다 — `skip`은 만료 기록·pending 제거·후속 재무장까지 하고(`recurrence: 'interval'`인 종류에만 부여, 테스트로 강제), `recoverDeadlines(state, now)`가 그 결과를 상태에 반영한다 |

부가로 확인한 스펙 요구:

- §6.2 4개 시간 규모가 입력 0에서 모두 콘텐츠를 낸다: `transitionsByScale = { seconds 1646, minutes 328, hours 22, day 7 }` (`acceptance.test.ts` "produces content on all four §6.2 time scales")
- §6.4 두 분기 경로: gate 열림 → `mode: 'vote'`, 옵션에 `VOTE_A/B/C`; gate 닫힘 → `mode: 'director'`, 옵션 `commandName: null` + 승인 사건 조합 + 비경쟁 집계 (`reducer.test.ts`, `choices.test.ts`)
- §6.4/§7.1 거부 경로: gate 닫힘 투표 → `vote_disabled`, 창 없음 → `vote_window_closed`, 명령 없는 이벤트 → `not_a_world_input`, 유료 재수신 → `duplicate_paid_event`. 모두 world 미변경(참조 동일)
- §9.2 대체 감사 연출 1회: 확정 전 fallback deadline(policy `replay`) → 발화 시 `fallback: true` 1건, 재발화 시 0건; 렌더러 확인 시 의무 소멸; 창을 넘겨 도착한 유료 이벤트는 즉시 대체 연출 1회 (`paid.test.ts`)
- §5.2 4개 고정 정보 + §12.3: `projectWorldView` 결과를 엔진 필드와 합쳐 `WorldSnapshotSchema.safeParse` 통과, 직렬화 결과에 author/displayName/channelId/message/text 문자열 0건 (`reducer.test.ts`)

### Gates (executed)

```text
$ git fetch origin && git rebase origin/main
Successfully rebased and updated refs/heads/dnhynk/t7-content-director.
(apps/server/package.json 충돌 1건 — main의 T2 obs 의존성과 이 PR의 @vl/contract 의존성을 양쪽 다 유지해 해소)

$ npm run format:check
Checking formatting...
All matched files use Prettier code style!

$ npm run lint
eslint . && node scripts/check-no-legacy-imports.mjs
check-no-legacy-imports: ok (0 legacy imports)

$ npm run typecheck
tsc --build tsconfig.json          (오류 없음)

$ npm run test
Test Files  27 passed (27)
Tests  592 passed (592)
  이 중 apps/server/src/world/: Test Files 9 passed (9) / Tests 108 passed (108)

$ npm run build
@vl/contract / @vl/server / @vl/simulator  tsc --build  (오류 없음)
```

`npm install`로 `package-lock.json`에 `@vl/server → @vl/contract` workspace 의존 1줄이 추가됐다(외부 의존성 추가 없음).

## Not done / out of scope

- 영속·트랜잭션·WS 발행·ACK·`stateRevision`·`effectId` 발급·유료 멱등 ledger — T8. reducer는 `EffectDraft`와 `ScheduledDeadline`만 낸다
- 명령 파싱·유니코드 정규화·모더레이션·arbiter의 direct↔aggregate 전환 임계값 — T6. reducer는 이미 정규화된 `CanonicalEvent`와 선택적 `contributions` 수만 받는다
- 화면·i18n 일본어 문구 — T5/T14. 이 task는 `TextKey`(`need.*`, `mission.*`, `chapter.*`, `crisis.*`, `choice.*`)와 `Identifier`만 발행하고 문장을 만들지 않는다
- `config/default.json` 연동 — 파일이 아직 main에 없고 PR #4가 추가 중이라 건드리지 않았다. `step(..., { tuning })`로 주입 가능
- 실제 OBS·YouTube·DB 연동 없음(순수 도메인)

## Follow-ups

- ~~**T1b(contract)**~~ — 2026-08-17 PR #7(`6efc9b5`)로 머지됐고 round 1에서 이 PR을 거기에 정렬했다(world `EffectCause`가 계약 `EffectCauseSchema`에 assignable, `deadlineId`는 T7에서 미발급)
- **T8**: 부팅 시 snapshot 로드 → `recoverDeadlines(state, now)` 1회 → 반환된 `state`를 저장하고 `plan.deliver`를 **순서대로** `step`에 넣고 `plan.expired`를 만료로 기록 → 그 다음에야 source 수신 재개(§7.3(3)). 재무장·제거는 이미 도메인 안에서 끝나 있으므로 엔진이 deadline 표를 직접 손보지 않는다. 실행 중에는 `StepResult.deadlines`(= `pendingDeadlines`, world 스케줄 + 유료 의무)를 그대로 표에 반영하면 된다. 렌더러 ACK 후에는 `markThanksDelivered(audit, eventKey)`를 호출해야 대체 감사 연출 의무가 사라진다. `EffectDraft.cause`는 계약 `EffectCauseSchema`와 같은 모양이지만 `deadlineId`가 없다 — 영속 row id를 아는 쪽이 T8이므로 조립할 때 채운다
- **T14**: `content/variants.ts`·`content/chapters.ts`의 `ambienceId`·`textKey` 목록이 `ja.json` 항목의 정본이다(모두 `nativeReview: pending`으로 추가해야 함)
- **T15/Gate 0**: `FRESHNESS_MINIMUMS`와 `DEFAULT_WORLD_TUNING`의 provisional 값을 승인값으로 교체
- 콘텐츠 폭(변주 수, 챕터 3종)은 Gate 3 파일럿 관찰 뒤 늘리는 것이 맞다. 지금은 §14.1 지표를 재는 최소 폭이다

## Review round 1

리뷰: <https://github.com/dnhynk/vertical-live/pull/6#pullrequestreview-4949110401> (verdict `request_changes`).
먼저 `git fetch origin && git rebase origin/main`(`c6a7610`, T1b PR #7 포함). 수정 커밋 `9725f63`.

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| **[blocker]** `deadlines.ts:181` — `skip`이 만료만 기록하고 pending에서 제거하지도, 반복 후속을 만들지도 않는다. T8이 도메인 변경을 지어내야 하고 §2.1·§10.2 위반 | **고침 `9725f63`.** 지적이 맞다. (1) `DeadlineDefinition`에 `recurrence: 'interval' \| 'state' \| 'one_shot'`를 추가하고 표를 exhaustive하게 채웠다. (2) `nextDueAfterSkip(kind, now, tuning)`가 `interval` 종류의 다음 due를 튜닝과 `now`만으로 계산한다(switch에 `never` 기본절 — 새 종류는 재무장 방식을 정하지 않으면 컴파일 실패). (3) `planDeadlineRecovery`가 `{deliver, expired, rescheduled, pending}`를 돌려준다: due였던 것은 전부 `pending`에서 빠지고(전달된 것은 step에서 각 핸들러가 재무장한다), `skip` 종류는 후속이 `pending`에 들어간다. (4) 세계 수준 `recoverDeadlines(state, now)`가 그 `pending`을 `world.deadlines`에 써 넣고 유료 의무는 audit에서 파생된 채로 분리 유지한다 → T8의 의무는 "plan.deliver를 순서대로 step, expired 기록, plan의 state 저장" 뿐. 회귀 테스트: 초기 상태 +2h 프로브에서 idle_beat가 `expired`에 있고 `deliver`에 없으며, **직전의 그 deadline이 `pendingDeadlines`에 없고** 미래 due의 후속이 정확히 1건 존재. 이어서 `plan.deliver`를 step한 뒤 1시간 더 돌려 idle_beat 전이가 다시 나오고 원래 pending에 있던 모든 종류가 복구되는 것까지 확인(`deadlines.test.ts` "world recovery after downtime" 3건 + 정책 단위 4건 추가) |
| **[blocker]** `reducer.ts:336` — 무료 명령이 mission을 동기 완료시켰을 때도 mission lifecycle effect가 `{kind:'deadline'}`로 표기됨. T8이 event 유래 effect를 `causedByEventKey=null`로 조립하게 됨(A-17 위반) | **고침 `9725f63`.** 지적이 맞다. `resolveMission`/`startMission`에 `effectCause`를 인자로 넣어 호출자가 원인을 정한다: `applyCareCommand`의 조기 완료 경로는 `{kind:'event', eventKey}`를, `mission_close` 타이머 경로는 `{kind:'deadline', deadlineKind:'mission_close'}`를 넘긴다. 테스트: 집계 `PET`×6(초기 mission 목표)로 완료시키면 COMPLETED·다음 mission의 STARTED·그 ambience·reaction까지 **결과의 모든 effect**가 `{kind:'event', eventKey}`이고, 타이머로 닫으면 mission effect가 모두 deadline cause임을 함께 검사 |
| **[major]** `reducer.ts:469` — chapter staging의 `deadlineId`에 beat 라벨을 넣음. 계약상 `deadlineId`는 영속이 발급하는 row id | **고침 `9725f63`.** 지적이 맞다. 라벨을 지우는 데 그치지 않고 world의 `EffectCause`에서 **`deadlineId` 필드 자체를 없앴다** — T7에는 row id가 없으므로 무엇도 그럴듯한 가짜 id를 넣을 수 없다. 계약 타입에서 `deadlineId`가 optional이라 assignability는 유지되고, `WorldEffectCauseIsContractCause` 타입 검사와 `EffectCauseSchema` 런타임 파싱 테스트가 이를 고정한다. beat는 `variantId`(`gathering_turn`)와 beat별 `ambienceId`(`chapter_gathering_turn`)로 이미 식별되며, 테스트가 cause의 키 목록이 `['deadlineKind','kind']`뿐임을 검사한다 |
| **[minor]** `deadlines.ts:189` — 그룹 구분자가 literal NUL이라 git이 소스를 바이너리로 판정 | **고침 `9725f63`.** `JSON.stringify([kind, key])`로 교체했다(구분자 모호성도 함께 사라진다). 확인: 파일의 NUL 0바이트, `git diff --numstat origin/main...HEAD -- apps/server/src/world/deadlines.ts` → `285 0`(이전 `- -`) |

리뷰어가 지적한 티켓 정직성 문제("T8은 `plan.deliver`만 전달하면 된다"는 서술이 반복 `skip`에는 맞지 않음)도 위 (3)(4)로 실제로 참이 되게 고쳤고, `## Result`의 인수 기준 4번 근거와 Follow-ups의 T8 안내를 같은 내용으로 갱신했다.

### Gates (round 1 재실행)

```text
$ git fetch origin && git rebase origin/main        # c6a7610 (T1b PR #7 포함), 충돌 없음
$ npm run format:check   -> All matched files use Prettier code style!
$ npm run lint           -> eslint 통과, check-no-legacy-imports: ok (0 legacy imports)
$ npm run typecheck      -> tsc --build tsconfig.json (오류 없음)
$ npm run test           -> Test Files 27 passed (27) / Tests 615 passed (615)
                            (apps/server/src/world/: 9 files / 120 tests)
$ npm run build          -> @vl/contract, @vl/server, @vl/simulator (오류 없음)
```
