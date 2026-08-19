# TASK-T19-gate0-apply

- Task: T19 Gate 0 승인 반영: 체크리스트·설정·모더레이션 호출표 (`docs/tasks/TASK_SPECS.md` §T19)
- Branch: `dnhynk/t19-gate0-apply` · PR: #25
- Orca: task `task_8633302d4f33` · dispatch `ctx_e3bb7d6ceff7`
- Spec sections read: §12.3, §15, §17 (경유: `docs/ops/gate0-checklist.md`, `docs/ops/moderation-call-table.md`, `docs/ops/supervisor.md` 4.3)
- BOARD decisions/assumptions relied on: D-8, D-9, D-10, D-11, D-12, D-13, D-14, D-15, D-16; A-1(D-9로 부분 뒤집힘), A-3, A-4, A-15

## Goal

2026-08-19 사용자 Gate 0 결정(BOARD §2 D-8~D-16)을 저장소의 문서·설정에 **그대로 옮긴다**. 새 사실·새 숫자를
만들지 않고, BOARD가 정한 값만 (1) `gate0-checklist.md` 체크박스·§17 표, (2) `moderation-call-table.md`
승인표·사유 토큰 표, (3) `config/default.json`의 `supervisor.moderation`·`input.provisional`,
(4) `ROADMAP.md`·`runbook-operations.md`·`supervisor.md`의 상태 문구에 반영한다. 미결로 남은 3건(§1.2 audit
값은 채널 생성 후, §1.4는 T21 초안 승인 대기, §1.7 합격선은 Gate 2 후 잠금)은 **체크하지 않고 상태만** 적는다.
BOARD는 코디네이터 소유이므로 건드리지 않는다.

## Plan

1. **`docs/ops/gate0-checklist.md`**
   - 1.1 5개 체크박스 → `[x]`, 각 줄 끝에 `(승인 2026-08-19, D-8)`.
   - 1.2 audit 9개 + 귀속 규칙 → D-10이 "전용 새 채널(미생성)"이라 **실제 값이 아직 없다**. 채널 식별·귀속 규칙만
     `[x]`(D-10), 나머지 Studio 값 항목은 `[ ]` 유지 + "채널 생성 후 값 기입(D-10)" 상태 문구.
   - 1.3 (A)는 `[ ]`, (B)를 `[x]`(D-9, 동의자 한정) + §14.1 지표 미계산 확인 `[x]`(D-9). "현재 코드" 문단에
     "구현은 T20a/b/c, 그 전까지 코드는 A-1(닫힘) 유지"를 D-9 인용으로 명시.
   - 1.4 4개 → `[ ]` 유지 + "T21 초안 제출 후 사용자 승인(D-15)" 상태.
   - 1.5 입력 모드·보호값 `[x]`(D-11), direct↔vote 실험 순서는 D-9 개방이 전제이므로 상태 문구(T20 이후).
   - 1.6 2개 `[x]`(D-12).
   - 1.7 합격선 `[ ]` 유지 + "provisional 유지 → Gate 2 72h baseline 후 잠금(D-14)", 예산 항목 `[x]`(D-14,
     월 10만원·누적 손실 중단선 50만원·최대 관측기간 6개월).
   - 1.8 `[x]`(D-13).
   - 3장 §17 표의 '현재 취급' 열을 D-번호로 갱신(결정된 행은 D-*, 미결 행은 근거와 함께 그대로).
   - 4장은 절차 문서이므로 유지, 상단 "최종 갱신"을 2026-08-19로.
2. **`docs/ops/moderation-call-table.md`**
   - 헤더 상태를 "승인(2026-08-19, BOARD D-13)"으로.
   - 1장 승인표 5칸을 D-13 값으로. 3번 escalation은 "2차 = 본인 휴대폰 문자/전화(번호 미기재)"이며
     **V1에 자동 발송이 없어 Discord 모바일 알림이 사실상 유일한 자동 경로**임을 표와 본문에 명시.
   - 1번 옆에 "1인 24h(JST) → 부재 구간은 2장의 자동 safe-stop 4개 사유가 덮는다(사전 safe-stop)".
   - 2장 사유 토큰 표를 D-13의 4개 토큰으로 채우고 4개 전부 2단계(safe-stop) 체크.
   - 3장 jsonc 예시를 승인값으로 갱신, 5장은 "승인 뒤에 할 일" → 완료 표기.
3. **`config/default.json`**
   - `supervisor.moderation` = D-13 승인표(`approved: true` 외 5필드).
   - `input.provisional`에서 `window.*` 4개 제거(`maxRawLength`만 남김). 값 4개는 이미 D-11과 동일함을 확인했으므로
     값 변경 없음(windowMs 5000 / maxDirectPerWindow 20 / enterAggregateAtCommands 30 / exitAggregateAtCommands 10).
4. **테스트**(합격 기준 1·2)
   - `apps/server/src/supervisor/config.test.ts`: "ships unapproved and empty" → 저장소 config가 D-13 승인값임을
     검사하도록 개정하고 `assertModerationCallTableApproved(loadSupervisorConfig().moderation)`이 **통과**함을 고정.
     거부 경로(빈 칸 이름을 대고 throw)는 합성 config로 유지·보강.
   - `apps/server/src/input/config.test.ts`: `provisional`에 `window.*`가 **없고** `maxRawLength`만 있음 +
     4개 값이 D-11과 일치함을 검사.
5. **상태 문구**: `docs/ROADMAP.md` Gate 0 표·상태 문단, `docs/ops/runbook-operations.md`·`docs/ops/supervisor.md`
   4.3의 "미승인/자리만 있고 비어 있다" 문구를 승인 상태로.
6. **막힌 것**: D-13의 safe-stop 토큰 4개가 현재 코드 어디에도 없다(아래 Questions). TASK_SPECS §T19 지시대로
   코드 토큰을 바꾸지 않고 `orca orchestration ask`로 보고한다. 답을 기다리는 동안 1~5의 나머지를 진행한다.
7. 게이트 5개 실행 → 커밋·push → PR(`chore(gate0):`).

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| (없음 — 이 task는 외부 사실을 추가하지 않는다. 모든 값의 출처는 BOARD §2 D-8~D-16이다) | — | — | — |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| **msg 미회신(제출 2026-08-19, `--timeout-ms 1800000`)**: D-13의 safe-stop 토큰 4개(`targeted_harassment`·`pii_exposure`·`sexual_or_self_harm_risk`·`filter_evasion_surge`)가 코드에 없다. `reportModerationHealth()`(`apps/server/src/supervisor/supervisor.ts:232`)는 임의 문자열 `reason`을 받고 **production 호출부가 0건**이며, 저장소에 존재하는 토큰 문자열은 테스트 예시값 `block_control_unavailable`(`supervisor.test.ts:186,220`)과 `'moderation control unreachable'`(`config.test.ts:138`)뿐이다. 권장 옵션 A = config에 D-13 4개 토큰을 그대로 넣고(코드 변경 0), "V1에 이 토큰을 보고하는 production 경로가 없음"을 문서에 정직 표기 + follow-up. | **회신 없음** (worker_done 시점까지 답이 오지 않음) | **옵션 A로 진행.** TASK_SPECS §T19가 "코드 쪽 토큰을 바꾸지 말라"만 지시하고 config 값은 D-13이 정본이므로, 코드는 손대지 않고 config·문서에만 반영했다. 코디네이터가 다른 처리를 지시하면 fix task로 되돌릴 수 있다(문서 3곳 + config 1곳) |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `supervisor.moderation.onCallOwner` | `"owner-operator"` | 승인값의 **역할명 표기** | D-13의 호출 책임자는 사용자 본인이지만 개인 식별자는 저장소·alert 본문·`/health`에 두지 않는다(§10.2, §12.4, `CLAUDE.md` §3). 호출표 템플릿 1번이 허용한 "역할명" 표기다. 사람이 읽는 정본은 `moderation-call-table.md` 1장 |
| `supervisor.moderation.escalationChannel` | `"discord-webhook"` | 승인값의 **1차 채널 토큰** | 필드가 문자열 1개라 자동 경로(1차)를 담았다. D-13의 2차(본인 휴대폰 문자/전화)는 **수동**이고 번호를 적지 않으므로 config가 아니라 호출표 1장 3번에 적었다 |
| `supervisor.moderation.autoBlockScope` | `"youtube-default-filters"` | 승인값의 **기계 토큰** | D-13 "YouTube 기본 필터 전부(blocked words·URL hold·hold for review·slow mode)"의 축약. 항목 나열은 호출표 1장 4번 |
| safe-stop 토큰 4개 | D-13 문자열 그대로 | 승인값 | 보고하는 쪽과 문자열이 같아야 하므로 축약·변형하지 않았다. **보고 경로는 아직 없다**(Follow-up) |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | `assertModerationCallTableApproved()` 통과 + 거부 경로 테스트(빈 칸 하나라도 있으면 이름을 대고 throw) 유지 | met | `apps/server/src/supervisor/config.test.ts` — `accepts the repository config as approved`(저장소 config로 통과), `still refuses an unapproved table, and names what is missing`(`/onCallOwner/`·`/safeStopConditions/`), `names the one field that was blanked out of an otherwise approved table`(`missing: safeStopConditions`, `missing: approved`). `npx vitest run apps/server/src/supervisor/config.test.ts apps/server/src/supervisor/supervisor.test.ts` → **2 files, 39 tests passed** |
| 2 | `input.provisional`에 `window.*`가 없고 값이 D-11과 일치 | met | `apps/server/src/input/config.test.ts` — `reads the repository config with the Gate 0 approved window values (D-11)`(5000/20/30/10 정확 비교), `lists only maxRawLength as provisional now that D-11 approved the window`(`toEqual(['maxRawLength'])` + `window.` 접두 0건). `npx vitest run apps/server/src/input/config.test.ts` → **9 tests passed** |
| 3 | 게이트 5개 + CI 녹색; 문서의 모든 값이 BOARD D-번호를 인용 | met(로컬) / CI는 PR에서 확인 | 아래 Gates 블록. 문서 인용: `gate0-checklist.md` 1.1~1.8·3장이 항목마다 D-8~D-16과 승인일 2026-08-19을 적었고, `moderation-call-table.md` 1·2·3·5장이 D-13, `ROADMAP.md` Gate 0 표가 D-8~D-16, `README.md`·`runbook-operations.md`·`supervisor.md`가 D-13을 인용한다. **round 2 정정(2026-08-19)**: D-9의 보존기간이 origin/main BOARD에서 `~~90일~~ → 30일 미refresh(미활동) 시 삭제`로 정정됐으므로([S41] Developer Policies **III.E.4.c** Authorized Data 30일 상한, https://developers.google.com/youtube/terms/developer-policies 확인 2026-08-19), `gate0-checklist.md` §1.3 승인 범위와 `ROADMAP.md` Gate 0 표의 D-9 요약을 30일로 맞췄다 — 이 정정 전에는 두 문서가 정본 D-9와 모순되어 이 기준은 met가 아니었다 |

### Gates (executed)

2026-08-19, `dnhynk/t19-gate0-apply` @ `e5a593d`, Node 24 / Windows 11. (round 1에서 origin/main `6fba7b8`
위로 다시 rebase해 이 커밋의 현재 SHA는 `8a9ac45`다. 재실행 결과는 아래 `## Review round 1`의 Gates.)

```text
$ npm run format:check
> prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ npm run lint
> eslint . && node scripts/check-no-legacy-imports.mjs && node scripts/check-install-scripts.mjs
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)
(eslint: 위반 0건)

$ npm run typecheck
> tsc --build tsconfig.json
(출력 없음 = 통과)

$ npm run test
> vitest run
 Test Files  138 passed (138)
      Tests  1911 passed | 1 skipped (1912)
   Duration  56.59s

$ npm run build
> @vl/renderer: ✓ built in 9.89s
> @vl/server: copied 5 migration(s) to dist/db/migrations · docs/ops/data-map.md up to date
> @vl/simulator, @vl/soak: tsc --build (출력 없음 = 통과)
```

실행하지 않은 게이트: 없음.

## Not done / out of scope

- BOARD(`docs/tasks/BOARD.md`) 갱신 — 코디네이터 소유(TASK_SPECS §T19).
- identity (B) 구현 — T20a/b/c. 이 PR은 D-9를 **체크리스트·ROADMAP에 기록만** 하고 코드 동작
  (`engine.identityGateOpen: false`)은 바꾸지 않는다.
- 일본 패널·5초 테스트·콘텐츠 목록 초안 — T21. `gate0-checklist.md` §1.4는 "T21 초안 → 승인 대기" 상태만 적었다.
- **체크하지 않은 Gate 0 항목 4건**(승인이 없으므로 닫지 않았다):
  1. §1.2 Studio audit 8개 — 전용 채널이 아직 없어 실제 값·증빙이 없다(D-10).
  2. §1.4 4개 — T21 초안 승인 전(D-15).
  3. §1.7 운영 합격선 — provisional 유지, Gate 2 baseline 후 잠금(D-14).
  4. §1.5 `direct↔vote 실험 순서` — **D-8~D-16에 이 항목의 결정이 없다.** 코디네이터 명세는 잔여를 3건으로
     봤지만 체크리스트 항목 기준으로는 이것이 4번째다. 임의로 채우지 않고 상태만 적었다.
     **round 1 후속(2026-08-19)**: 코디네이터가 BOARD **A-20**(가정: direct 먼저, vote는 T20a/b/c 머지 후
     Gate 2에서 동의자 표본으로 실험)을 등록했다. 가정은 사용자 승인이 아니므로 **체크박스는 여전히 열려
     있고**, 문서는 '잔여 3건 + 가정 1건(A-20)'으로 고쳤다.
- `supervisor.provisional`·`world.*.provisional`·`soak.thresholds` 등 나머지 잠정치 — D-14가 provisional 유지를
  명시했으므로 손대지 않았다.
- 코드 로직 변경 0건. 바뀐 `.ts`는 테스트 2개와 `input/config.ts`의 **주석 1개**뿐이다(주석이 "이 절의 모든 숫자는
  provisional"이라고 단언하고 있어 D-11 반영 후 거짓이 되므로 최소 수정).

## Follow-ups

- **[중요] safe-stop 4개 토큰을 보고하는 production 경로가 없다.** `reportModerationHealth()`는 진입점만 있고
  `targeted_harassment`·`pii_exposure`·`sexual_or_self_harm_risk`·`filter_evasion_surge`를 실제로 보고하는
  코드가 저장소에 0건이다. D-13은 **호출 책임자 부재 구간을 자동 safe-stop이 덮는다**고 승인했으므로, 그 커버리지는
  이 경로가 구현되어야 실제로 성립한다. → **`T22`로 등록됐다**(BOARD 2026-08-19, round 1: 사람 트리거 admin
  보고 엔드포인트 + `filter_evasion_surge` 휴리스틱, 의존 T12·T19). **Gate 3 public 파일럿 전에 T22가 머지되어야
  한다.** 귀속은 `moderation-call-table.md` 2·5장과 `gate0-checklist.md` §1.8에 적었다.
- §1.2 audit 값 기입: 전용 채널·Google Cloud·OAuth 개설(D-16, 사용자) 후 체크리스트 §1.2를 닫는 후속 작업.
- §1.5 `direct↔vote 실험 순서` 결정: identity 개방(T20) 이후 **사용자 결정 필요**. 그때까지는 BOARD **A-20**이
  가정으로 순서를 정해 두며(direct 먼저), 가정이므로 체크리스트 항목은 열린 채로 둔다.
- **[round 2 발견] `docs/tasks/TASK_SPECS.md` §T20a의 보존 문구가 아직 90일이다** — `:356`("90일 미활동 삭제",
  `lastActiveAt+90d`)과 `:361`("90일 미활동 자동 삭제(가상 시계)"). 정본 BOARD D-9는 30일로 정정됐으므로 이 명세대로
  구현하면 [S41] III.E.4.c를 위반한다. **T20의 명세이고 `TASK_SPECS.md`는 코디네이터 소유**라 이 PR에서 고치지
  않았다(범위 밖). 코디네이터가 T20a 명세를 30일로 정정해야 한다 — worker_done에 보고했다.

## Review round 1

리뷰: PR #25, verdict `request_changes`(major 2, blocker 0). 리뷰어가 게이트 5개 + CI를 직접 실행해 전부 pass였고
수용 기준 1·2도 met였다. 지적 2건은 **둘 다 문서 추적성**이며 코드 변경은 없다. 반박은 없다 — 두 지적 모두 사실이다.
두 지적의 해소에 필요한 **BOARD 등록(A-20·T22)은 코디네이터가 했고**(`docs/tasks/BOARD.md`, origin/main `6fba7b8`),
이 라운드는 그 번호를 문서에 인용해 귀속을 고정한다.

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [major] `docs/ops/gate0-checklist.md:6`·`docs/ROADMAP.md:27` — 머리말이 Gate 0 잔여를 '3건'이라 하지만 같은 체크리스트 `:116`의 §1.5 `direct↔vote 실험 순서`가 미체크다(스펙 §15가 승인을 요구, D-8~D-16에 결정 없음, 티켓 `:128-133`도 4번째로 인정). 요약이 상세와 모순되고 부분 승인의 완결성을 과장한다 | **고침 `e0fb59f`.** 숫자를 지어내지 않고 **성격을 나눠** 적었다: 두 문서 머리말을 "**미승인 잔여 3건 + 가정 1건**"으로 고치고, 잔여 3건(§1.2 audit 값 · §1.4 T21 초안 승인 · §1.7 Gate 2 잠금)과 가정 1건(§1.5 = BOARD **A-20**)을 각각 나열했다. 두 문서 모두 "**열려 있는 체크박스는 4건**"이라고 명시한다. §1.5 항목 자체(`gate0-checklist.md` 1.5)에 A-20의 내용(direct 먼저 · vote는 T20a/b/c 머지 후 Gate 2에서 동의자 표본)과 **"가정이므로 체크하지 않는다 — 사용자가 뒤집을 수 있다"**를 적었고, 같은 절 본문과 `ROADMAP.md` Gate 0 표의 입력 모드 행에도 A-20을 인용했다. §4 "승인 뒤에 할 일" 3번의 '잔여 3건' 표현도 같이 고쳤다. **A-20은 사용자 결정이 아니므로 체크박스는 열린 채다** |
| [major] `docs/ops/moderation-call-table.md:77-81`·`:133` — D-13 safe-stop 토큰 4개를 보고하는 production 경로가 V1에 없다는 사실은 정직하게 적혀 있으나 "별도 작업 / T19 follow-up"이라는 **이름 없는 산문**으로 남아 소유자가 없다. `rg -n "T22"`가 0건. Gate 3 전제조건이 주인 없이 사라질 수 있다 | **고침 `01a35ca`.** 코디네이터가 BOARD §1에 등록한 **T22**(모더레이션 사유 보고 경로: 사람 트리거 admin 보고 엔드포인트 + `filter_evasion_surge` 휴리스틱, 의존 T12·T19)로 귀속을 고정했다. (1) `moderation-call-table.md` 2장 커버리지 블록: "별도 작업(T19 티켓 Follow-up)" → "**후속 task `T22`에서 구현한다**(BOARD §1, 의존 T12·T19)" + "**Gate 3 public 파일럿 전에 T22가 머지되어야 한다**". (2) 같은 문서 5장 5번을 "**남은 것 → `T22`**"로 고치고 범위·의존을 적었다. (3) `gate0-checklist.md` §1.8에 상태 단서 블록을 추가해 "승인 체크박스는 D-13 **승인 기록**이라 닫혀 있고, **구현 여부는 T22가 추적한다**"를 분리했다 — 승인과 구현을 같은 체크박스로 착각하지 않게 한다. (4) 이 티켓 Follow-up 1번에도 T22를 적었다 |

### Gates (round 1 fix, 로컬)

2026-08-19, `dnhynk/t19-gate0-apply` @ `01a35ca`(origin/main `6fba7b8` 위로 rebase 후), Node 24 / Windows 11.

```text
$ npm run format:check
Checking formatting...
All matched files use Prettier code style!            (exit 0)

$ npm run lint
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)   (eslint 위반 0건, exit 0)

$ npm run typecheck
> tsc --build tsconfig.json                            (출력 없음 = 통과, exit 0)

$ npm run test
 Test Files  138 passed (138)
      Tests  1911 passed | 1 skipped (1912)
   Duration  83.59s                                    (exit 0)

$ npm run build
copied 5 migration(s) to dist/db/migrations · docs/ops/data-map.md up to date
@vl/renderer · @vl/simulator · @vl/soak: 통과            (exit 0)
```

실행하지 않은 게이트: 없음. **테스트 수는 round 0과 동일한 1911 pass**다 — 이 라운드의 변경이 `.md` 4개뿐이고
코드·config·테스트를 건드리지 않았기 때문이다. 근거: round 0 tip은 rebase 후 `9cdf193`이고
`git diff --stat 9cdf193..01a35ca`는 `docs/ROADMAP.md`·`docs/ops/gate0-checklist.md`·
`docs/ops/moderation-call-table.md` 3개(+31 −10)만 보고한다. 여기에 이 티켓 파일이 더해져 4개다.

### 이 라운드에서 하지 않은 것

- **BOARD 편집 없음.** A-20·T22 등록은 코디네이터 소유다(`CLAUDE.md` §8, TASK_SPECS §T19). 이 라운드는 인용만 했다.
  확인한 현재 상태(origin/main `6fba7b8`): **A-20은 BOARD §3 가정 표에 행이 있다**(`BOARD.md:88`). **T22는 §5
  이력(`BOARD.md:231`)에만 있고 §1 작업 상태 표에는 아직 행이 없다** — 그래서 문서 인용을 "BOARD §1"이 아니라
  "BOARD 등록 2026-08-19"로 적었다. §1 행 추가는 코디네이터 몫이라 worker_done에 보고했다.
- **T22 구현 없음.** 보고 경로 구현은 T22의 범위다. 이 PR은 귀속만 고정한다.
- **§1.5 체크박스를 닫지 않았다.** A-20은 가정이고 사용자 결정이 아니다 — 닫으면 리뷰가 지적한 과장을 반대 방향으로
  반복하는 것이다.
- 코드·config·테스트 변경 0건.

## Review round 2

리뷰: PR #25, verdict `request_changes`(major 1, blocker 0). 리뷰어가 게이트 5개 + CI(run 32247104953)를 다시 직접
실행해 전부 pass였고, **round 1의 major 2건(잔여 건수 서술 · T22 귀속)은 해소로 확인**됐다. 남은 지적 1건은 round 1
이후 **정본이 움직여서** 생긴 것이다: 코디네이터가 2026-08-19 11:25 T20b 질문에 답하며 BOARD **D-9의 보존기간을
90일 → 30일로 정정**했는데(`docs/tasks/BOARD.md:58`, `:234`), 이 PR의 두 문서는 정정 전 값을 그대로 요약하고 있었다.
반박은 없다 — 지적은 사실이고, 30일은 [S41] Developer Policies **III.E.4.c**(Authorized Data refresh·보관 30일 상한,
https://developers.google.com/youtube/terms/developer-policies, 확인 2026-08-19)라는 **외부 구속**이라 협상 대상이
아니다. 이 라운드도 코드 변경 0건, `.md`만 바꿨다.

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [major] `docs/ops/gate0-checklist.md:87`·`docs/ROADMAP.md:40` — 두 곳이 "90일 미활동 시 자동 삭제"를 D-9로 귀속하지만, 정본 BOARD D-9(`origin/main`, `docs/tasks/BOARD.md:58`)는 이를 **30일**로 정정했다([S41] III.E.4.c가 Authorized Data를 30일로 상한, 90일 불가). 이대로 머지하면 체크리스트·ROADMAP이 인용한 결정과 모순되므로 수용 기준 3과 스펙 §12.4 정책 정합이 성립하지 않는다 | **고침 `3057007`.** 두 문서의 D-9 요약을 **"30일 미refresh(미활동) 시 자동 삭제"**로 바꾸고, 값 옆에 **정정 근거**(2026-08-19 D-9 정정 · [S41] Developer Policies III.E.4.c의 Authorized Data 30일 상한 · 정책 URL과 확인 날짜)를 함께 적었다. 숫자만 바꾸지 않고 "**최초 승인 문구의 90일은 쓸 수 없다**"를 명시해, 90일을 본 사람이 이 문서를 옛 버전으로 오해하지 않게 했다. 티켓 `## Result` 수용 기준 3의 근거 칸에도 같은 정정을 적고 **정정 전에는 met가 아니었다**고 명시했다 |

### Gates (round 2 fix, 로컬)

2026-08-19, `dnhynk/t19-gate0-apply` @ `3057007`(origin/main `958b494` 위로 rebase 후), Node 24 / Windows 11.

```text
$ npm run format:check
> prettier --check .
Checking formatting...
All matched files use Prettier code style!             (exit 0)

$ npm run lint
> eslint . && node scripts/check-no-legacy-imports.mjs && node scripts/check-install-scripts.mjs
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)   (eslint 위반 0건, exit 0)

$ npm run typecheck
> tsc --build tsconfig.json                            (출력 없음 = 통과, exit 0)

$ npm run test
> vitest run
 Test Files  139 passed (139)
      Tests  1957 passed | 1 skipped (1958)
   Duration  74.79s                                    (exit 0)

$ npm run build
> @vl/renderer: ✓ built in 11.53s
> @vl/server: copied 5 migration(s) to dist/db/migrations · docs/ops/data-map.md up to date
> @vl/simulator, @vl/soak: tsc --build (출력 없음 = 통과)   (exit 0)
```

실행하지 않은 게이트: 없음. 이 라운드의 변경은 `.md` 2개뿐이다 — `git diff --stat 8662329..3057007`은
`docs/ROADMAP.md`·`docs/ops/gate0-checklist.md` 2개(+5 −2)만 보고한다. **테스트 수가 round 1의 1911 pass에서
1957 pass(139 files)로 늘어난 것은 이 PR 때문이 아니라 rebase 대상이 origin/main `6fba7b8` → `958b494`로
바뀌면서 그 사이에 머지된 다른 PR의 테스트가 들어왔기 때문이다.** 이 라운드가 건드린 파일에는 테스트가 없다.
이 티켓 파일은 위 게이트 실행 뒤에 커밋했으므로, 티켓 텍스트에 대해서는 `prettier --check`를 다시 돌려 확인했다:
`npx prettier --check docs/tasks/TASK-T19-gate0-apply.md` → `All matched files use Prettier code style!`(exit 0).

### 이 라운드에서 하지 않은 것

- **BOARD 편집 없음.** D-9 정정 자체는 코디네이터가 `origin/main`에 이미 기록했다(`BOARD.md:58`, `:234`). 이 PR은
  파생 문서를 정본에 맞추기만 한다.
- **`docs/tasks/TASK_SPECS.md` §T20a의 90일 문구는 고치지 않았다**(`:356`, `:361`). T20의 명세이고 파일 소유자가
  코디네이터라 범위 밖이다 — Follow-ups에 적고 worker_done으로 보고했다. **정본 D-9와 모순이 남아 있는 유일한
  지점이므로 T20a 착수 전에 정정되어야 한다.**
- **코드·config·테스트 변경 0건.** `config/retention.json`의 실제 보존 구현은 T20a/b/c 범위이고, 이 PR은
  `engine.identityGateOpen: false`(A-1) 상태를 그대로 둔다.
- `docs/PROJECT_SPEC.md:261-262`·`gate0-checklist.md:60`의 "90일"은 **YPP 자격 임계치**(업로드·Shorts 조회 기간)라
  D-9 보존기간과 무관하다 — 건드리지 않았다.
