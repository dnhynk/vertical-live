# TASK-T46-unified-quota

- Task: T46 chat·broadcast 통합 quota 회계 (`docs/tasks/TASK_SPECS.md` §T46)
- Branch: `dnhynk/t46-unified-quota` · PR: #59
- Orca: task `task_7b961e0d39f5` · dispatch `ctx_e476c3181931`
- Spec sections read: §9.1, §11
- BOARD decisions/assumptions relied on: D-1, D-4, A-5, A-15, T44·T46 실측 기록

## Goal

YouTube broadcast와 chat의 모든 quota 사용을 기존 `quota_usage`에 영속되는 process-wide `QuotaTracker` 하나로 합쳐, health와 reserve guard가 gRPC streamList·REST fallback·broadcast 호출의 실제 합계를 보게 한다.

## Plan

1. production composition root와 quota/chat/broadcast 경로를 추적해 별도 tracker 생성 지점과 health 노출 조건을 고정한다.
2. store-backed tracker 하나를 필요한 모든 YouTube integration에 주입하고 chat-only health를 노출한다.
3. 합산 method별 사용량, 재시작 복원, chat-only health, 중복 계상 방지를 회귀 테스트로 고정한다.
4. main 최신화 뒤 format/lint/typecheck/test/build와 latest-head CI를 확인한다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| 없음 | — | — | 외부 API 계약 변경이 아니라 기존 내부 회계 composition 결함이므로 저장소 정본과 회귀 테스트로 확정한다. |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 없음 | — | — | 새 quota 값이나 임계값을 도입하지 않는다. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | production shared tracker 하나 | met | `youtube/quota/runtime.ts`, `main.ts`, `chat/runtime.ts`, `chat/wiring.test.ts` — production `new QuotaTracker` 1곳, 동일 인스턴스 전달 |
| 2 | combined/chat-only health | met | `server.test.ts` chat-only `/health.quota`가 gRPC+REST 합산 5 units와 `byMethod` 노출 |
| 3 | store 영속·복원·합산 guard | met | `quota.test.ts` mixed-method restart 복원, `broadcast/api.test.ts` chat spend 포함 reserve 차단, `quota/runtime.test.ts` 기존 store write-through |
| 4 | aggregate·restart·chat-only·no-double-count 회귀 | met | gRPC·REST 테스트가 실제 요청 1회당 정확히 1 unit, 전체 2,220 passed·1 skipped |
| 5 | fetch/rebase, 5 gates, latest-head CI | pending | fetch/rebase와 로컬 5개 gate 통과; PR latest-head CI 대기 |

### Gates (executed)

```text
git fetch origin && git rebase --autostash origin/main
  PASS — current branch was up to date; pre-existing package-lock.json change restored from autostash
npm run format:check
  PASS — all matched files use Prettier style
npm run lint
  PASS — ESLint + legacy/import/install-script checks
npm run typecheck
  PASS — tsc --build tsconfig.json
npm run test
  PASS — 152 files, 2,220 passed, 1 skipped
npm run build
  PASS — contract schema current; renderer/server/simulator/soak built
```

## Not done / out of scope

- live host 정지·재시작·배포는 implementation worktree에서 수행하지 않는다.
- 적용 완료 migration, packages/contract, BOARD, HANDOFF, secret은 변경하지 않는다.

## Follow-ups

- 없음.

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
