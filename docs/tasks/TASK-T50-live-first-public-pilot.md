# TASK-T50-live-first-public-pilot

- Task: T50 D-25 live-first 72시간 public observational pilot (`docs/tasks/TASK_SPECS.md` §T50)
- Branch: `dnhynk/t50-live-first-public-pilot` · PR: #63
- Orca: task `task_f941e0758e93` · dispatch `ctx_ac1eb99cea48`
- Spec sections read: §0, §11, §12, §14, §15
- BOARD decisions/assumptions relied on: D-25, D-21, D-24, A-15

## Goal

D-25의 사용자 위험 수용 결정을 정본과 운영 경로에 정직하게 반영한다. 기존 Gate 2→Gate 3 사전 합격 경로를 최소 72 real hours의 11시간 rolling public observational pilot 하나로 대체하되, 생략한 검증을 통과로 만들지 않고 shipped private 기본값과 기존 unlisted 경로를 보존한 명시적 public opt-in만 추가한다.

## Plan

1. 정본과 gate2/soak/public/Windows 운영 문서를 D-25의 superseded 경로, 미검증 위험, factual metrics, stop conditions에 맞춘다.
2. `Start-VerticalLive.ps1`·`Register-VerticalLive.ps1`에 `-Broadcast`를 요구하고 `-Unlisted`와 배타적인 `-Public` 전달 경로를 구현한다.
3. PowerShell/config 회귀 테스트로 거부 경로, exact argument propagation, private/unlisted 보존, public privacy override를 검증한다.
4. fetch/rebase, `npm ci`, 게이트 5개와 CI를 실행하고 실제 결과만 티켓·PR에 기록한다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| — | — | — | 새 플랫폼 사실을 추가하지 않는다. D-25 사용자 결정과 저장소 정본만 반영한다. |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | — | task 명세와 D-25가 구현 선택을 충분히 고정한다. |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 운영 임계값 | 기존 config 값, 잠금 없음 | `provisional` / `not-locked` | D-25는 calibration·threshold lock을 면제했으며 통과선을 새로 만들지 않는다. |
| pilot 지속시간 | 최소 72 real hours | user-approved decision | 가속 soak나 24시간 실행으로 대체하지 않는다. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 정본의 D-25·Gate 경로 정합화 | met | `docs/PROJECT_SPEC.md` §0·§11·§12·§14·§15: Gate 2/3은 미통과·superseded, 현재 경로는 11시간 rolling·simulator-off·최소 72 real hours 관측 |
| 2 | 관련 운영 문서 정합화 | met | R-T50-1 fix `28d9441`: 실제 API `quotaExceeded`, platform/policy enforcement, 자동 복구 뒤에도 남는 viewer-facing output loss, 자동 복구 뒤 repeated crash, 새 secret exposure/suspected leakage의 정확한 5개 범주. `safe_stopped` 비범주와 recovered transient journal/gap 처리를 정본·연결 runbook에 반영 |
| 3 | Start `-Public` validation/privacy | met | `ops/windows/Start-VerticalLive.ps1`: `-Broadcast` 요구, `-Unlisted` 배타, side effect 전 거부, public branch의 단일 privacy env assignment. `public-windows.test.ts` Windows 실행 포함 |
| 4 | Register exact argument propagation | met | Windows `-WhatIf` 실행이 public `-Broadcast -Public` 정확히 1회, unlisted `-Unlisted`, default 빈 start args를 증명; 잘못된 두 조합은 `schtasks.exe` 전 거부 |
| 5 | 테스트·범위 불변조건 | met | focused 3 files / 34 passed; full 155 files / 2,246 passed / 1 skipped. `packages/contract`, dependency, channel audience config, secret 변경 0; `engine/config.test.ts`가 shipped simulator disabled 고정 |
| 6 | fetch/rebase·npm ci·게이트 5개·CI | met | `origin/main` rebase·`npm ci`·로컬 5 gates 성공. code/result head `083d293` CI run `32954681749` 성공; 이 티켓 결과만 갱신한 최종 head도 worker_done 전 PR check green 확인 |

### Gates (executed)

```text
git fetch origin && git rebase --autostash origin/main -> pass (main a3ce1aa 위에 2개 commit 재배치)
npm ci                -> pass (431 packages; audit 경고 10건, dependency 변경 없음)
npm run format:check  -> pass
npm run lint          -> pass (legacy imports 0; install scripts reviewed 4)
npm run typecheck     -> pass
npm run test          -> pass (155 files; 2,246 passed, 1 skipped)
npm run build         -> pass (contract schema up to date; renderer/server/simulator/soak build)

Focused:
npx vitest run apps/server/src/ops/public-windows.test.ts apps/server/src/youtube/broadcast/api.test.ts apps/server/src/engine/config.test.ts
-> pass (3 files; 34 passed; Windows PowerShell execution paths included)

GitHub Actions CI run 32954681749 (head 083d293) -> pass (2m11s; five gates + soak:ci)
Final result-only ticket head -> worker_done 전 PR #63 latest-head check green 재확인
```

## Not done / out of scope

- 실제 YouTube channel audience 설정 변경.
- 실제 72시간 public pilot 실행 또는 Gate 2/Gate 3 통과 선언.
- 권리·법률·원어민 승인 생성, production secret 조회·출력, Orca runtime 변경.

## Follow-ups

- PR 머지·호스트 배포 뒤 사용자가 운영 런북대로 public pilot를 시작하고 durable factual record를 최소 72 real hours 수집한다.

## Review round 1 (R-T50-1)

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [major] [`public-observational-pilot.md` §4가 모든 quota 관련 오류, 첫 output loss, 모든 `safe_stopped`를 mandatory stop으로 넓힘](https://github.com/dnhynk/vertical-live/pull/63#pullrequestreview-5029091360) | **고침 `28d9441`.** mandatory stop을 실제 API `quotaExceeded`; platform/policy enforcement, warning, strike 또는 imposed feature restriction; 자동 복구 뒤에도 남는 viewer-facing video/renderer/OBS output loss; 자동 복구 뒤 repeated component/process crash; 새 secret exposure 또는 suspected leakage의 정확한 다섯 범주로 좁혔다. `safe_stopped`는 outward work가 이미 멈춘 durable event지만 여섯 번째 범주가 아니며, recovered transient quota/output/crash/safe-stop은 factual journal과 duration/gap 계산에 남는다고 정본 §11·§12·§15, T50, public/gate2/soak/operations/Windows/supervisor/ROADMAP 문서에 일관되게 명시했다. focused Prettier와 `git diff --check`는 통과했고 worker_done 전 전체 게이트와 exact-new-head CI를 다시 실행한다. |
