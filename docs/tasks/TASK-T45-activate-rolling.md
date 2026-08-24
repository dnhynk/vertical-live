# TASK-T45-activate-rolling

- Task: T45 D-21 11시간 rolling production 경로 활성화 (`docs/tasks/TASK_SPECS.md` §T45)
- Branch: `dnhynk/t45-activate-rolling` · PR: #58
- Orca: task `task_c10281b8b944` · dispatch `ctx_3daff14bd4c8`
- Spec sections read: §9.1, §9.3, §11
- BOARD decisions/assumptions relied on: D-21, D-24

## Goal

T33과 T36에서 구현·실측까지 끝난 rolling 방송 교체를 shipped non-secret 설정에서 활성화한다. 기본 전략은 기존 enum 값 `rolling-experiment`, 구간은 정확히 39,600,000ms(11시간)로 고정하되 최초 공개 안전은 `private`, simulator는 비활성으로 유지한다.

## Plan

1. shipped 설정과 broadcast config/rollover 테스트, 직접 stale한 운영 문서를 대조한다.
2. `config/default.json`을 `rolling-experiment` + `segmentMs: 39600000`으로 바꾸고 선택 완료와 운영 동작을 설명하는 코드·운영 문서만 정합화한다.
3. repository 기본값이 rolling/11시간/private/simulator-off임을 고정하고, 주입한 `segmentMs: null` 설정에서는 rollover가 계속 꺼짐을 회귀 테스트한다.
4. `origin/main`을 fetch/rebase한 뒤 format, lint, typecheck, test, build 다섯 게이트를 실행하고 결과를 이 티켓과 PR에 기록한다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| 새 외부 사실 | 해당 없음 | 2026-08-24 | 구현·실측된 T33과 정본 §9.3, 사용자 결정 D-21/D-24만 적용한다. |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | 해당 없음 | 문서 간 충돌 없음 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 없음 | 해당 없음 | 사용자 결정 | 11시간은 D-21이 확정했으며 provisional이 아니다. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | shipped 기본값이 `rolling-experiment`와 정확히 39,600,000ms를 선택한다. | met | `config/default.json`, `apps/server/src/youtube/broadcast/api.test.ts` product-default test |
| 2 | shipped 기본 privacy는 `private`, simulator는 disabled로 남는다. | met | broadcast config test와 `apps/server/src/engine/config.test.ts` repository-config test |
| 3 | 주입한 `segmentMs: null`에서는 rollover가 일어나지 않는다. | met | `apps/server/src/youtube/broadcast/lifecycle.test.ts`가 API 요청 증가도 없음을 검증 |
| 4 | 비밀정보·contract 변경 없이 직접 stale한 운영 문서만 정합화한다. | met | `git diff --name-only origin/main...HEAD`; BOARD/HANDOFF/contract 변경 없음 |
| 5 | fetch/rebase와 게이트 5개, CI가 녹색이다. | met | `git fetch origin; git rebase --autostash origin/main` 완료, 로컬 게이트 전부 통과; PR #58 CI run 32699875783 통과 |

### Gates (executed)

```text
git fetch origin; git rebase --autostash origin/main -> up to date; setup-generated package-lock drift autostash/restored
npm run format:check -> passed; All matched files use Prettier code style
npm run lint         -> passed; 0 legacy imports, 4 install scripts reviewed
npm run typecheck    -> passed
npm run test         -> passed; 151 files, 2,213 passed, 1 skipped
npm run build        -> passed; 4 workspace builds, schema/data-map checks up to date
PR #58 CI            -> passed; run 32699875783 (all gates + soak:ci)
```

## Not done / out of scope

- `BOARD.md`, `HANDOFF.md`, contract schema는 수정하지 않는다.
- 실제 YouTube/OBS 자원은 호출하지 않는다. T33의 실채널 archive 검증 결과를 다시 수행하지 않는다.

## Follow-ups

- 없음.

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
