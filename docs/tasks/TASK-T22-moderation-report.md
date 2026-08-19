# TASK-T22-moderation-report

- Task: T22 모더레이션 사유 보고 경로: 사람 트리거 admin 엔드포인트 + `filter_evasion_surge` 휴리스틱 (`docs/tasks/TASK_SPECS.md` §T22)
- Branch: `dnhynk/t22-moderation-report` · PR: #<n>
- Orca: task `task_43f8dd164d5a` · dispatch `ctx_b2c790f96ad4`
- Spec sections read: §12.3, §9.2, §10.2, §11, §14.1
- BOARD decisions/assumptions relied on: **D-13**(사유 토큰 4개 전부 safe-stop), D-3(Discord webhook), D-9/A-1(identity), D-14/A-15(합격선 provisional 유지)

## Goal

D-13이 승인한 모더레이션 호출표의 사유 토큰 4개(`targeted_harassment`·`pii_exposure`·`sexual_or_self_harm_risk`·`filter_evasion_surge`)를 **실제로 보고하는 production 경로**를 만든다. 지금 저장소에는 `supervisor.reportModerationHealth()`라는 진입점만 있고 그것을 부르는 production 호출부가 없다(`moderation-call-table.md` 5장의 "남은 것"). 이 task는 (1) 사람이 판단해 누르는 admin 엔드포인트와 CLI, (2) 네 토큰 중 유일하게 기계가 관측할 수 있는 `filter_evasion_surge`의 자동 휴리스틱을 붙여 호출표 1번의 "부재 구간 자동 safe-stop"이 실제로 성립하게 한다.

## Plan

1. **승인 토큰 정본을 코드에 고정** — `supervisor/moderation-report.ts`에 `MODERATION_REASON_TOKENS`(호출표 2장 4개). `config/default.json`의 `supervisor.moderation.safeStopConditions`와 문자열이 일치하는지 테스트로 못박는다(호출표 2장 경고: "문자열이 다르면 조건은 영원히 일치하지 않는다").
2. **admin 인증 규칙 공유** — `supervisor/admin-auth.ts`로 loopback + bearer(`server.adminToken`, timing-safe) 검사를 옮기고 `AdminKillEndpoint`가 그것을 쓰게 한다. 새 엔드포인트가 kill-switch와 **같은** 규칙이어야 하므로(§T22 범위) 상수시간 비교를 두 번 쓰지 않는다. 동작·응답 코드는 그대로(기존 kill-switch 테스트 무변경 통과가 근거).
3. **`POST /admin/moderation`** — `{reason, note?}` → `supervisor.reportModerationHealth('degraded', reason)`. 승인표에 없는 토큰은 400(응답은 `error`와 허용 토큰 이름 목록만, 요청 본문은 echo하지 않는다). `POST /admin/moderation/clear` → `reportModerationHealth('ok')`. `note`는 길이 제한 + 제어문자 제거 후 **로그에만**; alert·`/health`에는 토큰과 시각만.
4. **`/health` detail** — `SupervisorHealthSummary.moderation = {status, reason, reportedAtUtc, filterEvasion}`. 토큰·시각·정수만(자유 텍스트 없음).
5. **CLI** — `npm run moderation -w @vl/server -- --reason <토큰> [--note <text>] [--clear]`. kill-cli 패턴이되 **플래그 파일 fallback 없음**(근거는 아래 "설계 결정").
6. **휴리스틱** — `supervisor/moderation-heuristic.ts`. 입력 metrics(`CommandMetricsSnapshot`)를 `windowMs` 창마다 표본 추출해 delta를 내고, `commandLike >= minCommandLike && 우회거부/commandLike >= rejectRatio`인 창이 연속 `enterWindows`개면 `reportModerationHealth('degraded','filter_evasion_surge')`, 보고 뒤 임계 미만 창이 연속 `clearWindows`개면 `'ok'`. supervisor의 평가 루프에서 구동한다(safe_stop 뒤에는 루프가 서므로 자동으로 멈춘다).
7. **metrics 배선** — `CommandMetrics`가 production에서 한 번도 생성되지 않고 있었다(T21 Follow-up "명령 성공률 /metrics 미배선"). 휴리스틱의 입력이므로 `main.ts`에서 하나 만들어 `createChatSource` → `chatParserPort` → `createCommandParserPort({metrics})`로 넘긴다. 이 task가 필요로 하는 최소 배선만 한다(`/metrics` 노출은 범위 밖 → Follow-up).
8. **config** — `supervisor.moderation.heuristics.filterEvasion {enabled, windowMs, minCommandLike, rejectRatio, enterWindows, clearWindows}`, 전부 `supervisor.provisional` 목록에 추가.
9. **문서** — `moderation-call-table.md` 2장에 '보고 경로(사람/자동)' 열 + 5장 갱신, `runbook-operations.md`에 운영 절차, `supervisor.md` 4.3 갱신.
10. **테스트** — 엔드포인트(인증 실패 3종·미승인 토큰·정상 보고·clear), 서버 라우팅, CLI(성공·서버 미응답·미승인 토큰·clear), 휴리스틱(진입·해제·오탐 없음·identity 열림/닫힘), 그리고 T12 전이(보고 → CTA off + safe_stopped + critical alert 1회).

## 설계 결정

### (a) 어떤 거부 사유가 '필터 우회'인가

호출표 2장의 정의: `filter_evasion_surge` = "**금칙어·URL 필터를 우회하는 변형 입력**이 급증해 자동 차단이 사실상 무력해졌다". T6 파서의 사유 목록(`apps/server/src/input/types.ts` `REJECTION_REASONS`)을 두 갈래로 나눈다.

`REJECTION_REASONS`(`apps/server/src/input/types.ts`) 14개 전수표:

| # | 사유 | 어디서 나오는가 | 우회? | 근거 |
|---|---|---|---|---|
| 1 | `url` | `moderation.ts:moderate()` | **O** | `buildLinkProbe`가 `example(dot)com`·`ｈｘｘｐ`·`www-example-com`·`example。com`·zero-width 삽입을 **되돌린 뒤** 매치. 붙었다는 것 자체가 변형 입력의 관측 |
| 2 | `personal_data` | `moderate()` | **O** | email/handle/우편번호/9자리+ 숫자열. 역시 난독화 해제(`someone (at) example.invalid`) 후 |
| 3 | `banned_hate` | `moderate()` | **O** | `normalizeText().skeleton`(homoglyph 접기·결합문자 제거·반복 접기)으로 매치 — `ｷﾁｶﾞｲ` |
| 4 | `banned_sexual` | `moderate()` | **O** | 같은 skeleton — `p0rn`·`ро rn`·`p̸o̸r̸n̸` |
| 5 | `banned_self_harm` | `moderate()` | **O** | 같은 skeleton — `k y s`·`死ね` |
| 6 | `banned_violence` | `moderate()` | **O** | 같은 skeleton |
| 7 | `banned_ads_scam` | `moderate()` | **O** | 같은 skeleton |
| 8 | `no_command` | `parse.ts` 4단계 | X | **명령이 아닌 모든 채팅 줄.** 방송 중 대부분의 메시지가 이것이다. 세면 탐지기가 항상 켜진다 |
| 9 | `too_long` | `parse.ts` 1단계 | X | `maxRawLength` 초과 — 긴 잡담. 정규화조차 하지 않으므로 내용에 대한 정보가 없다 |
| 10 | `empty` | `parse.ts` 2단계 | X | 정규화 후 남은 것이 없음(이모지·공백만). 우회 의도의 증거가 아니다 |
| 11 | `extraneous_text` | `parse.ts` 5단계 | X | `feed play`처럼 인자 형식이 틀린 것 — 흔한 사용자 실수 |
| 12 | `invalid_argument` | `parse.ts` 5단계 | X | 같은 형식 규칙 |
| 13 | `vote_disabled` | `parse.ts` 6단계 | X | 투표창이 닫혀 있을 때의 `VOTE_*` — 게이트 상태이지 공격이 아니다 |
| 14 | `consent_disabled` | `parse.ts` 4a단계 | X | identity 게이트가 닫힌 동안의 `JOIN`/`LEAVE` — 게이트 상태 |

핵심 근거 두 가지.

1. 1–7번은 `moderate()`의 **전체 출력 집합**이고(그 함수 밖에서 이 코드를 만드는 경로가 없다 — grep 확인), 정의상 "YouTube의 blocked words·URL hold를 **통과해 우리 파서까지 도달한** 금칙 내용"이다. 승인표 4번이 자동 차단 범위를 "YouTube 기본 필터 전부"로 정해 두었으므로, 이 코드가 올라간다는 것은 그 자동 차단이 새고 있다는 뜻 — 호출표가 말하는 "자동 차단이 사실상 무력해졌다"와 같은 사건이다.
2. 8–14번은 평범한 채팅과 오타에서 상시 발생한다. 이것을 우회 신호로 세면 합격 기준 2("임계 미만에서 오탐 없음")를 만족할 수 없고, `filter_evasion_surge`는 D-13에서 safe-stop 조건이라 **오탐이 곧 방송 정지**다.

이 분류는 `moderation-heuristic.test.ts`의 두 테스트로 고정된다: (a) `REJECTED_VECTORS`(T6 적대적 fixture)를 `moderate()`에 통과시켜 나오는 코드 집합이 `FILTER_EVASION_REJECTION_REASONS`와 **정확히** 일치하는가, (b) 우회 7 + 형식 7이 `REJECTION_REASONS` 14개를 중복 없이 덮는가(분류 누락·이중 계수 방지).

### (c) 비율의 분모 — `commandLike`가 아니라 '파서 도달 메시지 수'

코디네이터 지시로 코드를 확인한 결과 §T22 본문의 `commandLike` 분모를 **바꿨다.**

- `commandLike`는 "첫 토큰이 allowlist에 맞은 메시지"다(`parse.ts`가 4단계에서 계산). §14.1의 명령 성공률에서는 분자(`accepted`)가 `commandLike`의 **부분집합**이라 비율이 [0,1]로 잘 정의된다.
- 그러나 우회형 거부는 대부분 명령이 아니다(`https://…`만 있는 줄은 `commandLike=false`인 `url` 거부다). 분자가 분모의 부분집합이 아니므로 서로 다른 두 모집단을 나누는 셈이고, 비율이 1을 넘을 수 있어 임계 해석이 어렵다.
- 파서 도달 메시지 수(`accepted + consentAccepted + rejected`, `recordParse`가 정확히 한 번 세는 값)를 분모로 쓰면 비율은 [0,1]의 실제 비중("채팅의 이만큼이 필터 우회형이다")이고 채널 규모에 대해 정규화된다.
- 그래서 config 키는 `minCommandLike`가 아니라 **`minMessages`**다(§T22 본문과의 유일한 이름 차이, 위 확인에 근거).
- `consentAccepted`는 게이트가 열렸을 때만 snapshot에 나타나므로 `?? 0`으로 읽는다 → 열림/닫힘 두 모드에서 같은 답(합격 기준 2).

근거 두 가지.

1. `moderate()`가 돌려주는 7개는 정의상 "YouTube의 blocked words·URL hold를 **통과해 우리 파서까지 도달한** 금칙 내용"이다. 승인표 4번이 자동 차단 범위를 "YouTube 기본 필터 전부"로 정해 두었으므로, 이 코드가 올라간다는 것은 곧 그 자동 차단이 새고 있다는 뜻 — 호출표가 말하는 "자동 차단이 사실상 무력해졌다"와 같은 사건이다. 게다가 `moderate()`의 매칭은 전부 **난독화 해제 뒤**에 일어나므로(`buildLinkProbe`, `skeleton`), 이 코드가 붙었다는 것 자체가 "변형 입력"의 관측이다.
2. 형식·게이트 사유는 평범한 채팅과 오타에서 상시 발생한다. 특히 `no_command`는 명령이 아닌 모든 채팅 줄이며, 이것을 우회 신호로 세면 휴리스틱이 정상 트래픽에서 항상 켜진다(§T22 합격 기준 2 "오탐 없음"과 정면 충돌). `too_long`도 마찬가지로 긴 잡담이다.

`consent_disabled`는 identity 게이트가 닫혀 있을 때만 나오고 게이트에 따라 `rejectedByReason`에서 키 자체가 사라지므로(`input/metrics.ts` `#reasonCounts`), 계산은 항상 `counts[reason] ?? 0`으로 읽어 두 모드에서 같은 답을 낸다(합격 기준 2 "identity 모드 무관").

디스패치 명세의 괄호 예시("allowlist 불일치·길이 초과·반복 차단 등")와 다르므로 `orca orchestration ask`로 코디네이터에게 확인했다 — 아래 질문 표 참조.

### (b) CLI에 플래그 파일 fallback을 두지 않는 이유

kill-cli는 파일 fallback이 있다. 이유가 "**프로세스가 응답하지 않아도 방송을 멈출 수 있어야 한다**"이고, 파일은 다음 기동에서도 읽혀 재개를 막기 때문이다(`kill-switch.ts` 상단 주석). 모더레이션 보고는 성질이 반대다.

1. 보고의 효과(CTA off, alert, safe-stop 판정)는 **살아 있는 supervisor 안에서만** 일어난다. 서버가 죽어 있으면 끌 CTA도, 멈출 방송도 없다 — 그 상황에서 운영자가 할 일은 모더레이션 보고가 아니라 kill switch다.
2. 파일을 두면 "모더레이션 degraded"가 디스크에 남아 다음 기동에서 되살아나는데, 그 상태를 **해제하는 프로토콜이 없다**(§12.3은 사람이 판단해 보고하고 사람이 해제한다). 채팅이 멀쩡한 새 프로세스를 과거의 파일이 멈추는 것은 §9.2가 말하는 안전 정지가 아니라 오탐이다.

그래서 CLI는 HTTP만 쓰고, 실패하면 **명확히 실패**한다(exit 1 + `http_<status>`/`ECONNREFUSED` 같은 기계 토큰 + "서버가 죽었으면 `npm run kill -w @vl/server -- --reason \"<why>\"`" 안내).

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| (없음 — 외부 API를 부르지 않는다. 근거는 스펙 §12.3·§9.2·§10.2와 저장소 코드) | — | — | — |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| `filter_evasion_surge`의 '우회' 거부 사유 집합을 `moderate()`가 내는 7개(url·personal_data·banned_*)로 고정해도 되는가(디스패치 예시의 no_command·too_long은 정상 트래픽이라 오탐) | **A 승인** — 7개로 고정. "난독화 해제 후 매칭된 금칙 내용만이 호출표 2장 정의와 1:1이고, no_command/too_long/형식·게이트 오류는 정상 트래픽이라 safe-stop 오탐 위험." 추가 지시 2건: (1) 14개 사유 전수표를 티켓에 남길 것, (2) **분모가 `commandLike`가 맞는지 코드로 확인해 근거와 함께 고정할 것** | 아래 (a) 전수표, (c) 분모 결정. `FILTER_EVASION_REJECTION_REASONS`(moderation-heuristic.ts)와 `moderation-heuristic.test.ts`의 partition 테스트로 고정 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `supervisor.moderation.heuristics.filterEvasion.windowMs` | 60000 | **provisional(근거 없음)** | 5초 flood 창(D-11)보다 길어 버스트를 평균내되 60분 응답시간(D-13 2번) 안에 여러 창이 쌓일 길이. 실측 근거는 없다 |
| `…minMessages` | 20 | **provisional(근거 없음)** | 창의 표본 하한. 파서에 도달한 메시지가 이보다 적으면 비율을 신뢰하지 않는다 |
| `…rejectRatio` | 0.5 | **provisional(근거 없음)** | 명령성 메시지 1건당 우회형 거부 0.5건 이상 |
| `…enterWindows` / `clearWindows` | 3 / 3 | **provisional(근거 없음)** | 단발 버스트로 방송이 멈추지 않도록 연속 3창 |

전부 `config/default.json`의 `supervisor.provisional` 목록에 넣었다. **합격선이 아니다** — Gate 2의 실트래픽 baseline 뒤에 잠근다(BOARD D-14/A-15).

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1a | 엔드포인트 테스트: 인증 실패 | **met** | `supervisor/moderation-report.test.ts` — 비-loopback 403, 토큰 없음/틀림/미설정 401(3케이스), 모두 `onReport` 미호출. 라우팅 수준은 `server.test.ts` "refuses an unauthenticated or unknown-token moderation report" |
| 1b | 잘못된 토큰 | **met** | 같은 파일 "refuses a token that is not on the approved table, without echoing it" — 400, 응답에 허용 토큰만, `JSON.stringify(body)`에 제출값 미포함, supervisor 미도달. 본문 없음/빈 문자열/배열도 400. **round 1 M1 이후** "compares the reason as sent, so no variant launders into an approved token" — 승인 토큰의 근접 변형 12개(제어문자 `\u0000`·`\n`·`\t`, 서식문자 `\u200b`, 리뷰어의 원본 프로브, 괄호·`!`·`?`, 앞뒤·중간 공백, 대문자)를 전부 400으로 고정 |
| 1c | 정상 보고 | **met** | 같은 파일 202 + `{source:'http', reason, at}`; 라우팅은 `server.test.ts` "routes POST /admin/moderation to the report endpoint" |
| 1d | clear | **met** | 같은 파일 "clears on the same admission rules…" (202, `resumesRun:false`); 라우팅 `server.test.ts` "routes POST /admin/moderation/clear" |
| 1e | CLI 테스트 | **met** | `supervisor/moderation-cli.test.ts` 7케이스 — 정상 보고(URL·헤더·본문 검증), 미승인 토큰(요청 자체를 보내지 않음), clear, 서버 미응답(exit 1 + `ECONNREFUSED` + `npm run kill -w @vl/server -- --reason` 안내 — round 1 M2), `http_401`, 토큰 미설정, 잘못된 인자 |
| 1f | 보고 시 CTA off + safe_stopped + alert 1회 (T12 전이 테스트 재사용) | **met** | `supervisor/supervisor.test.ts` "stops the run for an approved token from POST /admin/moderation (§T22)" — T12의 `createSupervisorHarness`/`goLive` 그대로 사용. `inputHealth='degraded'`, `interactionEnabled=false`, `state='safe_stopped'`, `safeStop.kind='moderation_unhealthy'`. **round 1 B1 이후** §12.3의 2단계를 함께 고정한다 — `ofKind('moderation.unhealthy')` 길이 **1**(severity warning, `reason='targeted_harassment'`, `detail.safeStopConditionMatched=true`)와 `ofKind('supervisor.safe_stopped')` 길이 **1**(severity critical), 그리고 전달 순서가 warning → critical임을 `alerts.alerts`의 index로 확인. **round 2 B1 이후** 그 index 비교는 `RecordingAlertSink`가 동기 push라서 비동기 sink의 타이밍을 못 덮는다는 것이 드러났으므로, warning만 막는 sink로 전달 순서를 직접 고정한다 — "delivers the warning before the stop when the sink is slow (round 2, B1)"(막힌 동안 이미 `safe_stopped`·CTA off, 전달 0건 → 풀면 `['moderation.unhealthy','supervisor.safe_stopped']`)와 "lets a stuck sink time out instead of holding the stop alert (§T22)". 해제 경로는 "turns the CTA back on when a report is cleared" |
| 2a | 합성 입력으로 창별 비율 계산 | **met** | `supervisor/moderation-heuristic.test.ts` "computes the ratio over messages that reached the parser" — 실제 `parseMessage`에 합성 문자열을 넣어 messages=60, evasion=35, ratio≈0.583. 창별 delta는 "counts only differences" |
| 2b | 연속 N창 진입 / M창 해제 | **met** | 같은 파일 "reports only after enterWindows consecutive exceeding windows", "clears after clearWindows consecutive quiet windows", "one quiet window in the middle restarts the count" |
| 2c | 임계 미만에서 오탐 없음 | **met** | 같은 파일 4케이스 — 평범한 채팅 20창, 비율 0.12로 10창, `minMessages` 미만(비율 1.0인데도 진입 안 함), 빈 창. supervisor 수준의 대조군은 `supervisor.test.ts` "leaves an ordinary chat alone however long it runs" (10창 후 `live` 유지) |
| 2d | identity 닫힘/열림 무관 | **met** | 같은 파일 "reaches the same verdict with the consent gate open and closed" — 두 모드 모두 `report`, 같은 messages/evasion 수치 |
| 2e | 우회 사유 집합의 근거 | **met** | 같은 파일 "is exactly the set `moderate()` produces" + "partitions every T6 rejection code exactly once" + 티켓 (a) 전수표 |
| 3a | 게이트 5개 | **met** | 아래 Gates |
| 3b | CI 녹색 | **met** | round 1 fix `b4895f8` — <https://github.com/dnhynk/vertical-live/actions/runs/32293554124>. **round 2 fix `22c4fe7`** — <https://github.com/dnhynk/vertical-live/actions/runs/32297198891> |
| 3c | 문서의 모든 임계가 provisional 표기 | **met** | `config/default.json`의 `supervisor.provisional`에 5개 키 추가 + 테스트로 강제(`moderation-heuristic.test.ts` "carries the heuristic thresholds as provisional values"). 문서 3곳(`moderation-call-table.md` 2·3·5장, `runbook-operations.md` 3.1, `supervisor.md` 4.3)에 "합격선이 아니다 / Gate 2 baseline 뒤 잠금" 명시 |

### Gates (executed)

```text
$ npm run format:check
> prettier --check .
Checking formatting...
All matched files use Prettier code style!

$ npm run lint
> eslint . && node scripts/check-no-legacy-imports.mjs && node scripts/check-install-scripts.mjs
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)

$ npm run typecheck
> tsc --build tsconfig.json
(출력 없음 = 통과)

$ npm run test
> vitest run
 Test Files  148 passed (148)
      Tests  2133 passed | 1 skipped (2134)
   Duration  62.48s

$ npm run build
> tsc --build (contract/server/renderer/simulator/soak) + copy-migrations + generate-data-map --check
copied 6 migration(s) to dist/db/migrations
docs/ops/data-map.md up to date
✓ built in 9.12s
```

`origin/main` rebase 후 실행했다(round 1 fix 뒤 base `ccf2ab4`에서 다시 실행, 5개 모두 통과; round 2 fix 뒤 base `212e49b`에서 또 재실행 — §Review round 2). 신규 테스트 파일 3개 = 35 tests, 그 밖에 `supervisor.test.ts` +7,
`server.test.ts` +5, `wiring.test.ts` +1.

### 추가로 실행한 end-to-end 스모크 (mock 없음)

빌드된 CLI → 실제 `fetch` → 실제 HTTP 라우트 → 실제 엔드포인트 → supervisor 콜백까지 한 번에 돌렸다
(스크립트는 저장소 밖 임시 파일).

```text
exit codes: report=0 unknown=1 clear=0 offline=1
supervisor received: [["log","moderation reported",{"reason":"filter_evasion_surge","at":"...","note":"synthetic smoke note"}],
                     ["report","filter_evasion_surge","..."],
                     ["log","moderation cleared",{"at":"...","note":null}],
                     ["clear","..."]]
cli output:
moderation reported: filter_evasion_surge
unknown reason token: not in the approved call table
allowed: targeted_harassment, pii_exposure, sexual_or_self_harm_risk, filter_evasion_surge
moderation cleared: the CTA comes back on the next evaluation. ...
moderation report failed: ECONNRESET (server not reachable; stop the broadcast with `npm run kill -w @vl/server -- --reason "<why>"`)
```

이 스모크가 **단위 테스트가 놓친 결함 하나를 찾았다**: Node의 `fetch`는 연결 거부를 `TypeError`로 감싸고 실제
코드(`ECONNREFUSED`)를 `cause`에 넣는데, CLI는 `TypeError`만 출력하고 있었다(단위 테스트가 평평한 에러를 주고
있어서 통과했다). `errorToken`이 `cause`를 한 단계 풀도록 고치고, 테스트의 에러 모양도 실제와 같게 바꿨다.

### 디버깅 1건 (CLAUDE.md 절차)

`supervisor.test.ts`의 휴리스틱 테스트 초안이 평범한 채팅에서도 `safe_stopped`가 됐다.

1. **가설**: 내 휴리스틱이 아니라 테스트가 `clock.advance(60_000)`으로 한 번에 점프해서, supervisor가 자기
   평가를 60초 동안 못 본 것이 원인이다(coordinator family degraded → 재시작 예산 소진).
2. **반증 관측**: `config/default.json`의 `coordinatorHeartbeatTimeoutMs`가 60초 이상이면 가설이 틀린다.
3. **결과**: `coordinatorHeartbeatTimeoutMs=15000`, `evaluateIntervalMs=2000`. 가설 성립.
4. **수정**: `tickFor()` 헬퍼로 production처럼 2초마다 평가하며 진행. 이제 평범한 채팅 10창은 `live`를 유지하고
   (대조군), 우회 폭증 3창은 `safe_stopped`가 된다 — 정지의 원인이 휴리스틱임이 대조로 분리된다.

## Review round 1

리뷰 verdict `request_changes` — blocker 1 + major 2. **셋 다 타당했다.** 게이트 5개와 CI는 리뷰 시점에도
통과하고 있었으므로, 세 지적은 모두 "통과하는 테스트가 잘못된 것을 고정하고 있었다"는 종류다.

| 지적 | 무엇이 틀렸나 | 고침 | SHA |
|---|---|---|---|
| **[blocker] B1** `supervisor.ts:265` — 승인표 토큰이면 `requestSafeStop()` 후 `return`해서 1단계 `moderation.unhealthy` warning을 건너뜀 | §12.3의 1단계는 2단계의 전제 조건이지 대체물이 아니다. 리뷰어의 하네스 프로브에서 warning 0 / critical 1이 나왔고, `supervisor.test.ts:288`은 critical만 고정하고 있어서 이 누락을 못 잡았다 | 조건 분기를 `safeStopConditionMatched` 값으로 바꾸고 **warning을 항상 먼저** 보낸 뒤, 매치된 경우에만 `requestSafeStop()`을 호출한다. ~~`#alert`가 `deliver()`를 동기적으로 부르므로 순서는 결정적이다~~ — **이 문장은 round 2 B1에서 반증됐다**(동기 sink에서만 참, 아래 §Review round 2). warning의 `detail.safeStopConditionMatched`도 하드코딩 `false`에서 실제 값으로 바뀌어, 멈춘 경우와 멈추지 않은 경우가 같은 필드로 구분된다 | `b4895f8` |
| **[major] M1** `moderation-report.ts:104` — 제출 reason을 `readTokenField()`로 정제한 뒤 allowlist 비교 | 정제 후 비교는 sanitizer를 **세탁기**로 만든다. 비승인 원문이 승인 토큰이 되어 202로 통과한다 | allowlist는 **원문 그대로 exact match**한다(`readReason()`). `readTokenField()`는 경계가 필요한 자유 텍스트(kill의 reason)에 그대로 남는다 | `b4895f8` |
| **[major] M2** `moderation-cli.ts:139`·`moderation-call-table.md:65` — 서버 미응답 시 안내하는 `npm run kill`이 루트에 없음 | 방송이 도는 중에 붙여넣으면 `Missing script: kill`이 난다. 즉 **가장 급할 때 동작하지 않는 안내**다 | CLI 3곳(모듈 주석·`--help`·실패 메시지)과 문서 4곳을 실행 가능한 workspace 형식으로 정정. 테스트도 `'npm run kill'`이 아니라 `'npm run kill -w @vl/server -- --reason'`을 요구한다 | `b4895f8` |

### 재현 → 수정 → 확인 (CLAUDE.md 디버깅 절차)

**B1** — 가설: `return`이 warning을 건너뛴다. 반증 관측: 승인 토큰 경로에서 `ofKind('moderation.unhealthy')` 길이가
1이면 가설이 틀린다. 관측 결과 **0**(테스트를 먼저 추가해 실패를 확인):

```text
$ npx vitest run apps/server/src/supervisor/supervisor.test.ts -t "approved token"
AssertionError: expected [] to have a length of 1 but got +0
 ❯ apps/server/src/supervisor/supervisor.test.ts:292:24
```

수정 후 같은 파일 32 tests 통과. 순서(warning → critical)까지 `alerts.alerts`의 index로 고정했다.

**M1** — 리뷰어의 프로브를 그대로 재현했다(빌드된 엔드포인트, mock 없음):

```text
$ node -e "... ep.report({... body:{ reason:'targeted_harassment\^@' }}) ..."
status= 202 onReport= "targeted_harassment"
```

수정 후 같은 입력은 400이고 `onReport`는 호출되지 않는다(`moderation-report.test.ts` 11 tests 통과).

**M2** — 루트에 script가 없다는 것을 먼저 확인하고:

```text
$ npm run kill -- --help
npm error Missing script: "kill"
```

고친 뒤, **CLI가 출력하는 문자열을 그대로 실행**해 동작을 확인했다:

```text
$ $env:VL_PORT='8799'; npm run moderation -w @vl/server -- --reason targeted_harassment --note "round 2 probe"
moderation report failed: ECONNREFUSED (server not reachable; stop the broadcast with `npm run kill -w @vl/server -- --reason "<why>"`)
EXIT=1

$ npm run kill -w @vl/server -- --help
usage:
  kill [--reason <text>] [--via auto|http|file]   stop the run (spec §9.2 safe_stopped)
  kill --clear                                    remove the local flag file
EXIT=0
```

### 리뷰의 "ticket Result honesty" 지적

리뷰어는 acceptance 1이 met으로 적혀 있으나 B1·M1을 반영하지 않았다고 지적했다. 위 세 건을 고치고 **1b·1e·1f의
근거 칸을 새 단언으로 교체**했다(이 커밋). 1은 이제 met이다 — 그 근거는 새로 고정된 warning+critical 2단 단언과
세탁 변형 12개의 400 고정이다.

## Review round 2

리뷰 verdict `request_changes` — round 1의 M1·M2는 해소 확인, **blocker 1건이 남았다.** 지적은 타당했다:
round 1에서 warning을 *먼저 호출*하도록 고쳤지만, 그 칸에 적은 "`#alert`가 `deliver()`를 동기적으로 부르므로
순서는 결정적이다"는 **`RecordingAlertSink`에서만 참**이다. production의 `AlertSink`(Discord webhook)는 비동기라,
두 전달이 동시에 진행되면 critical이 warning을 앞지를 수 있다.

| 지적 | 무엇이 틀렸나 | 고침 | SHA |
|---|---|---|---|
| **[blocker] B1** `supervisor.ts:272` — `void this.#alert(warning)` 직후 `void this.requestSafeStop(...)`이라 두 비동기 전달이 **동시 진행**. 느린 sink에서 critical(`supervisor.safe_stopped`)이 warning보다 먼저 도착한다 | *호출* 순서를 고쳤을 뿐 *전달* 순서를 고정하지 않았다. 기존 테스트가 이를 못 잡은 이유는 명확하다 — `RecordingAlertSink.deliver()`는 promise가 resolve되기 전에 배열에 **동기적으로 push**하므로, 배열 index 비교는 두 전달이 동시여도 항상 통과한다 | `#alert`가 전달을 **순서 보장 큐**에 넣는다(`#alertQueue` promise 체인). 각 전달은 자기 앞 전달이 끝난 뒤에 시작하므로 전달 순서 = 호출 순서다. **안전 정지는 큐 뒤에 있지 않다** — `#haltOutwardWork()`·`#state` 대입·CTA gate는 전부 첫 `await` 앞이라 sink가 막혀도 즉시 일어난다. 큐가 새로운 유실 경로가 되지 않도록 전달 하나는 `alerts.deliveryTimeoutMs`(10s, provisional)로 한계를 둔다 — 응답 없는 transport는 뒤의 alert를 잡아두지 못하고 로그(`alert delivery timed out`)를 남긴다 | `22c4fe7` |

### 재현 → 수정 → 확인 (CLAUDE.md 디버깅 절차)

1. **가설**: 두 전달이 동시 진행이라 순서는 sink 속도가 정한다. 원인은 `void #alert` + `void requestSafeStop`이지,
   round 1이 고친 호출 순서가 아니다.
2. **반증 관측**: `moderation.unhealthy`만 막는 sink에서 **warning을 풀기 전에는 어떤 전달도 완료되지 않아야**
   한다. 하나라도 완료되면 가설이 맞고, 아무것도 완료되지 않으면 가설이 틀린다.
3. **관측** — 테스트를 먼저 넣고 수정 전 코드로 실행했다(리뷰어의 `before_warning_release`와 같은 값):

   ```text
   $ npx vitest run apps/server/src/supervisor/supervisor.test.ts -t "round 2, B1"
   AssertionError: expected [ 'supervisor.safe_stopped' ] to deeply equal []
    ❯ apps/server/src/supervisor/supervisor.test.ts:354:45
        354|       expect(delivered.slice(beforeReport)).toEqual([])
   ```

4. **수정 후 같은 명령**: `Test Files 1 passed / Tests 1 passed | 33 skipped`. 파일 전체는 34 tests 통과.

### 새로 고정한 것 (`supervisor.test.ts` +2)

- `delivers the warning before the stop when the sink is slow (round 2, B1)` — warning만 막는 sink.
  막힌 동안 `state='safe_stopped'`, `safeStop={kind:'moderation_unhealthy', reason:'targeted_harassment'}`,
  `interactionEnabled=false`, `inputHealth='degraded'`가 **이미** 참이고(= 안전 정지는 sink 지연과 무관), 전달은
  0건이다. 풀고 나면 전달 순서가 정확히 `['moderation.unhealthy', 'supervisor.safe_stopped']`이다.
- `lets a stuck sink time out instead of holding the stop alert (§T22)` — 영원히 resolve되지 않는 sink.
  `clock.advance(alerts.deliveryTimeoutMs)` 뒤 `supervisor.safe_stopped`는 전달되고 `moderation.unhealthy`는
  전달되지 않는다(= 큐가 막히지 않는다).

### 이 수정이 바꾼 기존 동작 (T12 테스트 3건 수정)

alert 전달이 이제 **최소 한 microtask 뒤**에 일어난다(동기 push에 의존할 수 없다). 이는 순서 보장의 대가이고,
supervisor 바깥 production 코드는 `#alert`의 promise를 보지 않으므로 영향이 없다. 다만 `RecordingAlertSink`의
동기성에 기대던 T12 테스트 3건이 `await flushMicrotasks()`를 필요로 했다 — 단언 자체는 그대로다:

- `stops on a rights or policy request from the broadcast lifecycle` (`onSafeStop` 호출 카운트)
- `alerts on a sweep that was not clean or left rows unprocessed`
- `alerts when a revocation misses its deadline (spec §12.4)`

`deliveryTimeoutMs`는 지금까지 Discord sink가 자기 fetch를 abort하는 데만 쓰였다. 이제 supervisor의 큐도 같은 값을
쓰므로 `config.ts`의 필드 주석에 그 사실을 적었다. 새 config 키는 추가하지 않았다.

### 게이트 (round 2 fix 뒤, base `212e49b`에서 재실행)

```text
$ npm run format:check   → All matched files use Prettier code style!
$ npm run lint           → eslint 0 / legacy imports 0 / install scripts 4 reviewed
$ npm run typecheck      → tsc --build tsconfig.json (출력 없음 = 통과)
$ npm run test           → Test Files 148 passed (148) / Tests 2135 passed | 1 skipped (2136), 69.31s
$ npm run build          → migrations 6 copied / data-map up to date / renderer·simulator·soak 빌드
```

## Not done / out of scope

- **`/metrics`에 `CommandMetrics` 노출**: T21이 남긴 Follow-up("명령 성공률 /metrics 미배선")은 이 task의 범위가
  아니다. T22가 한 것은 휴리스틱이 읽을 수 있도록 **production 파서 포트에 카운터를 연결한 것**까지다
  (`chatRuntimeDeps` → `chatParserPort` → `createCommandParserPort({metrics})`). §14.1 지표를 HTTP로 내보내는 것은
  별도 task로 남긴다.
- **나머지 3개 토큰의 자동 탐지**: 명세가 명시적으로 범위 밖(사람 판단, §12.3). 문서 3곳에 이유와 함께 적었다.
- **임계값 확정**: 실트래픽이 없어 provisional. Gate 2 baseline에서 잠근다(BOARD A-15/D-14).
- **BOARD 갱신**: 코디네이터 몫(runbook 2.7).

## Follow-ups

- `/metrics`에 `CommandMetrics.snapshot()` 노출(§14.1 명령 성공률). T21 Follow-up과 같은 건이다.
- Gate 2 72시간 baseline 뒤 `supervisor.moderation.heuristics.filterEvasion` 5개 값을 실측으로 교체하고
  `supervisor.provisional`에서 제거.
- `supervisor.moderation.heuristics.filterEvasion.enabled=true`가 기본이므로, Gate 3 파일럿 초기에는 오탐 여부를
  관측 대상에 넣는다(오탐 = 방송 정지).
