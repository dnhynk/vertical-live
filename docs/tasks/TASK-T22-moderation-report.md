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

| 사유 | 어디서 나오는가 | 우회 신호인가 |
|---|---|---|
| `url` | `moderation.ts:moderate()` — `buildLinkProbe`가 `example(dot)com`·`ｈｘｘｐ`·`www-example-com` 같은 **난독화를 되돌린 뒤** 매치 | **예** |
| `personal_data` | 같은 함수 — email/handle/우편번호/9자리 이상 숫자열, 역시 난독화 해제 후 | **예** |
| `banned_hate`·`banned_sexual`·`banned_self_harm`·`banned_violence`·`banned_ads_scam` | 같은 함수 — `normalizeText().skeleton`(homoglyph 접기·결합문자 제거·반복 접기)으로 매치 | **예** |
| `too_long`·`empty`·`no_command`·`extraneous_text`·`invalid_argument`·`vote_disabled`·`consent_disabled` | `parse.ts`의 **형식·게이트** 규칙 | 아니오 |

근거 두 가지.

1. `moderate()`가 돌려주는 7개는 정의상 "YouTube의 blocked words·URL hold를 **통과해 우리 파서까지 도달한** 금칙 내용"이다. 승인표 4번이 자동 차단 범위를 "YouTube 기본 필터 전부"로 정해 두었으므로, 이 코드가 올라간다는 것은 곧 그 자동 차단이 새고 있다는 뜻 — 호출표가 말하는 "자동 차단이 사실상 무력해졌다"와 같은 사건이다. 게다가 `moderate()`의 매칭은 전부 **난독화 해제 뒤**에 일어나므로(`buildLinkProbe`, `skeleton`), 이 코드가 붙었다는 것 자체가 "변형 입력"의 관측이다.
2. 형식·게이트 사유는 평범한 채팅과 오타에서 상시 발생한다. 특히 `no_command`는 명령이 아닌 모든 채팅 줄이며, 이것을 우회 신호로 세면 휴리스틱이 정상 트래픽에서 항상 켜진다(§T22 합격 기준 2 "오탐 없음"과 정면 충돌). `too_long`도 마찬가지로 긴 잡담이다.

`consent_disabled`는 identity 게이트가 닫혀 있을 때만 나오고 게이트에 따라 `rejectedByReason`에서 키 자체가 사라지므로(`input/metrics.ts` `#reasonCounts`), 계산은 항상 `counts[reason] ?? 0`으로 읽어 두 모드에서 같은 답을 낸다(합격 기준 2 "identity 모드 무관").

디스패치 명세의 괄호 예시("allowlist 불일치·길이 초과·반복 차단 등")와 다르므로 `orca orchestration ask`로 코디네이터에게 확인했다 — 아래 질문 표 참조.

### (b) CLI에 플래그 파일 fallback을 두지 않는 이유

kill-cli는 파일 fallback이 있다. 이유가 "**프로세스가 응답하지 않아도 방송을 멈출 수 있어야 한다**"이고, 파일은 다음 기동에서도 읽혀 재개를 막기 때문이다(`kill-switch.ts` 상단 주석). 모더레이션 보고는 성질이 반대다.

1. 보고의 효과(CTA off, alert, safe-stop 판정)는 **살아 있는 supervisor 안에서만** 일어난다. 서버가 죽어 있으면 끌 CTA도, 멈출 방송도 없다 — 그 상황에서 운영자가 할 일은 모더레이션 보고가 아니라 kill switch다.
2. 파일을 두면 "모더레이션 degraded"가 디스크에 남아 다음 기동에서 되살아나는데, 그 상태를 **해제하는 프로토콜이 없다**(§12.3은 사람이 판단해 보고하고 사람이 해제한다). 채팅이 멀쩡한 새 프로세스를 과거의 파일이 멈추는 것은 §9.2가 말하는 안전 정지가 아니라 오탐이다.

그래서 CLI는 HTTP만 쓰고, 실패하면 **명확히 실패**한다(exit 1 + `http_<status>`/`ECONNREFUSED` 같은 기계 토큰 + "서버가 죽었으면 `npm run kill`" 안내).

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| (없음 — 외부 API를 부르지 않는다. 근거는 스펙 §12.3·§9.2·§10.2와 저장소 코드) | — | — | — |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| `filter_evasion_surge`의 '우회' 거부 사유 집합을 `moderate()`가 내는 7개(url·personal_data·banned_*)로 고정해도 되는가(디스패치 예시의 no_command·too_long은 정상 트래픽이라 오탐) | (대기) | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `supervisor.moderation.heuristics.filterEvasion.windowMs` | 60000 | **provisional(근거 없음)** | 5초 flood 창(D-11)보다 길어 버스트를 평균내되 60분 응답시간(D-13 2번) 안에 여러 창이 쌓일 길이. 실측 근거는 없다 |
| `…minCommandLike` | 20 | **provisional(근거 없음)** | 창의 표본 하한. 명령성 메시지가 이보다 적으면 비율을 신뢰하지 않는다 |
| `…rejectRatio` | 0.5 | **provisional(근거 없음)** | 명령성 메시지 1건당 우회형 거부 0.5건 이상 |
| `…enterWindows` / `clearWindows` | 3 / 3 | **provisional(근거 없음)** | 단발 버스트로 방송이 멈추지 않도록 연속 3창 |

전부 `config/default.json`의 `supervisor.provisional` 목록에 넣었다. **합격선이 아니다** — Gate 2의 실트래픽 baseline 뒤에 잠근다(BOARD D-14/A-15).

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
```

## Not done / out of scope

- …

## Follow-ups

- …
