# TASK-T19-gate0-apply

- Task: T19 Gate 0 승인 반영: 체크리스트·설정·모더레이션 호출표 (`docs/tasks/TASK_SPECS.md` §T19)
- Branch: `dnhynk/t19-gate0-apply` · PR: #(미생성)
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
| D-13의 safe-stop 토큰 4개(`targeted_harassment`·`pii_exposure`·`sexual_or_self_harm_risk`·`filter_evasion_surge`)가 코드에 없다. `reportModerationHealth()`는 임의 문자열 `reason`을 받고 production 호출부가 없으며, 존재하는 토큰은 테스트의 예시값 `block_control_unavailable`(supervisor.test.ts:186,220)과 config.test.ts:138의 `'moderation control unreachable'`뿐이다. config에 D-13 4개를 넣고 "V1에는 아직 이 토큰을 보고하는 경로가 없음"을 문서에 명시 + follow-up으로 남기는 것을 권장한다. | (대기) | (대기) |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | `assertModerationCallTableApproved()` 통과 + 거부 경로 테스트 유지 | (진행 중) | |
| 2 | `input.provisional`에 `window.*` 없음, 값이 D-11과 일치 | (진행 중) | |
| 3 | 게이트 5개 + CI 녹색, 문서 값이 D-번호 인용 | (진행 중) | |

### Gates (executed)

```text
(미실행)
```

## Not done / out of scope

- BOARD(`docs/tasks/BOARD.md`) 갱신 — 코디네이터 소유(TASK_SPECS §T19).
- identity (B) 구현 — T20a/b/c. 이 PR은 D-9를 **체크리스트에 기록만** 하고 코드 동작(`engine.identityGateOpen=false`)은 바꾸지 않는다.
- 일본 패널·5초 테스트·콘텐츠 목록 초안 — T21.

## Follow-ups

- (Questions 답변에 따라 기입)
