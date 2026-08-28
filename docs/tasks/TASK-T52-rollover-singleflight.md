# TASK-T52-rollover-singleflight

- Task: T52 rolling lifecycle single-flight and crash recovery (`docs/tasks/TASK_SPECS.md` §T52)
- Branch: `dnhynk/t52-rollover-singleflight` · PR: #65
- Orca: task `task_55c76aed6821` · dispatch `ctx_ad8cf70abb12`
- Review fix: task `task_01e19e3a2abe` · dispatch `ctx_7e8030e89bb0`
- Spec sections read: §9.1, §9.2, §9.3, §9.4, §10.2, §11
- BOARD decisions/assumptions relied on: D-21, D-25, A-15, A-18

## Goal

Prevent the production rollover crash in which `rolloverIfDue()` and chat target resolution concurrently mutate one `broadcast_resources` attempt, while preserving the fixed rolling order, write-once external IDs, bounded quota/reconcile behavior, continuous OBS ingest, public publication, and T51 chat recovery semantics. Restart recovery must deterministically reconcile the newest legitimate attempt in the presence of older open rows without guessing, rewriting IDs, or creating additional YouTube resources.

## Plan

1. Add deterministic lifecycle regressions that pause a rollover mutation at a controlled API boundary, overlap it with `ensureBound()` as used by chat target resolution, and prove a single owner performs insert/bind/transition work without duplicate resources or write-once-ID repointing.
2. Put one lifecycle-local asynchronous serialization boundary around every public operation that can inspect and then mutate broadcast attempts. Keep locked implementations private so composite operations (`ensureLive`, rollover, explicit rollover, stop, publish, resume) never wait on their own lock.
3. Reconcile all open attempts on restart in deterministic newest-first order. Continue the newest legitimate replacement, recognize an older live attempt as its rollover predecessor, close rows only after YouTube terminal/missing evidence or a completed lifecycle mutation, and fail safely on ambiguous competing live state instead of rewriting an external ID or inserting another resource.
4. Add focused crash-boundary tests for pre-stop and post-stop rollover interruption plus the exact production topology of a newest `broadcast_created` replacement and two older `live` attempts. Assert stable resource counts, marker-clear/bind/stop/configured-visibility/live ordering, public/unlisted restoration, private no-op, preserved chat target behavior, and observed background rollover failures.
5. Run `npm ci`, focused tests, `format:check`, `lint`, `typecheck`, full `test`, `build`, and `soak:ci`; update this ticket with exact results, rebase on `origin/main`, push every commit, open one `fix(youtube):` PR, and wait for exact-head CI including `soak:ci`.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| YouTube `liveBroadcasts.bind` | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/bind | 2026-08-28 | 하나의 stream은 여러 broadcast에 bind될 수 있으므로 replacement를 같은 ingest stream에 먼저 bind하고 OBS는 계속 송출한다(T33 근거 재사용). |
| YouTube `liveBroadcasts.transition` | https://developers.google.com/youtube/v3/live/docs/liveBroadcasts/transition | 2026-08-28 | concurrent live 제한 때문에 이전 live를 끝낸 뒤 replacement를 live로 전환하는 순서를 보존한다(T33 근거 재사용). |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| 없음 | — | task 명세와 incident evidence가 구현 경계를 충분히 지정한다. |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 새 운영 수치 | 없음 | — | 기존 11시간 segment와 quota/retry/readiness 수치를 그대로 보존한다. |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | rollover와 `ensureBound()`/chat target resolution의 결정론적 중첩에서 mutation owner가 하나이고 duplicate insert/repoint가 없다. | met | `lifecycle.test.ts`의 `single-flights rollover with production chat target resolution`: fake API pre-apply barrier에서 두 흐름을 중첩해 replacement insert 1회·broadcast 총 2개·동일 최종 target·visibility update 1회를 검증. focused 재실행 결과는 아래 Gates에 기록한다. |
| 2 | 모든 충돌 mutation이 lifecycle 단일 경계를 통과하고 retry/reconcile·고정 rollover 순서·publish·OBS ingest·chat refresh를 보존하며 reentrant wait가 없다. | met | `BroadcastLifecycle.#serializeMutation`과 private composite 구현; due와 explicit request가 동일한 `#performRollover`를 사용하며 public/unlisted marker clear→bind→old complete→visibility→new live, private no-op, 실패 뒤 queue 진행을 focused regression으로 검증. |
| 3 | 여러 stale/open attempt 재시작이 candidate-specific evidence로만 복구하며 ambiguity/binding mismatch에서 outward/row mutation 없이 safe-stop한다. | met | migration 008의 direct predecessor id와 동일 stream 검증. unrelated historical close, unlinked multiple candidate, cross-stream linked candidate, competing live, exact production two-live/newest-created regressions가 API·row mutation 없는 safe-stop/초기 publish 경계를 고정한다. |
| 4 | visibility crash-before/during/after와 두 번째 crash에서 configured update가 중복되지 않고 같은 replacement만 이어진다. | met | focused regressions가 predecessor-close 뒤 두 번째 restart, pending unknown-response reconcile, 이미 public인 replacement read-back을 각각 검증하며 visibility update count가 0 또는 정확히 1 증가한다. |
| 5 | 반복 restart에도 resource/ID가 안정적이고 quota-bearing mutation은 reconcile-before-retry를 지킨다. | met | controlled rollover/chat barrier와 unknown visibility regression에서 replacement insert 1회, external ID write-once, visibility update 1회 이하. 기존 timeout/reconcile/limit tests 포함 lifecycle 85/85 통과. |
| 6 | background rejection, T47/T51/world/OBS continuity와 shipped rolling/private/simulator defaults, 범위 제한을 보존한다. | met | focused supervisor 포함 5 files/166 tests, full 155 files/2,282 passed/1 skipped, accelerated soak 72h 20/20 recovery/final live/safe stop 0. contract/dependency/lockfile/BOARD/HANDOFF 변경 없음. |
| 7 | `npm ci`, rebase, focused, format/lint/typecheck/full test/build/soak와 latest-head CI가 녹색이다. | unverifiable | 로컬 전부 통과, behind 0. 최종 evidence commit push 뒤 exact-head GitHub Actions(`soak:ci` 포함)을 worker completion 전에 확인하고 PR evidence/worker_done에 SHA/run을 기록한다. |

### Gates (executed)

```text
npm ci
  PASS — 431 packages installed; package-lock.json unchanged
npm test -- --run apps/server/src/youtube/broadcast/lifecycle.test.ts apps/server/src/db/broadcast-resources.test.ts apps/server/src/db/migrate.test.ts apps/server/src/privacy/data-map.test.ts apps/server/src/supervisor/supervisor.test.ts
  PASS — 5 files, 166 tests
npm run format:check
  PASS — all matched files use Prettier
npm run lint
  PASS — ESLint; 0 legacy imports; 4 install scripts reviewed
npm run typecheck
  PASS — tsc --build tsconfig.json
npm run test
  PASS — 155 files, 2,282 passed, 1 skipped
npm run build
  PASS — contract schema current; renderer/server/simulator/soak built
npm run soak:ci
  PASS — accelerated 72.00h; 1,728/1,728 processed; 20/20 recoveries;
         final live; no safe stop; verdict PASS (30.3s wall clock)
git fetch origin && git rebase origin/main
  PASS — current branch up to date; origin/main...HEAD = 0 behind / 8 ahead before this evidence commit
GitHub Actions exact final head
  PENDING — verified after this evidence commit is pushed; exact SHA/run goes in PR evidence and worker_done
```

## Not done / out of scope

- 실제 host, database, YouTube resources, credentials, scheduled tasks, runtime logs, data/ops journals는 접근하거나 변경하지 않는다.
- `packages/contract`, dependency, `package-lock.json`, `BOARD.md`, `HANDOFF.md`는 변경하지 않는다.

## Follow-ups

- 코디네이터 차단 지적 `msg_fab2f4f6a71e`: rolling replacement가 initial startup publish에 의존해 private로 남던 결함을 확인했다. lifecycle handoff 안에서 predecessor complete 뒤 configured visibility를 복원하도록 수정하고 public/unlisted/private·ordering·crash recovery·chat concurrency 회귀 테스트를 추가했다.
- 코디네이터 topology 보강 `msg_0562085143c7`: 실제 두 older live rows와 newest broadcast-created row를 그대로 구성해 mutation 없는 safe-stop을 고정했다.

## Review round 1 — R-T52-1

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] older-open/history heuristics can complete an unrelated predecessor and bypass startup publication | 고침 `093956d`, stream reuse hardening `195cf01`: migration 008 adds write-once candidate→predecessor provenance in the replacement's first durable row. Recovery validates the exact linked row and same `streamId` before API/row mutation; missing linkage, extra candidates/live rows, missing predecessor, and mismatch safe-stop. Historical same-stream close reasons are no longer consulted. |
| [major] recovery replays a configured visibility update already applied | 고침 `093956d`: each successful response or exact-id read-back persists `privacy_status` + observation time. Recovery reconciles a pending update and also reads back legacy/unrecorded visibility before mutation, so before/unknown-response/after crash boundaries issue at most one visibility update. |
| [major] public `rollOver()` completes predecessor before replacement bind | 고침 `093956d`: due and explicit paths now share `#performRollover`: linked private replacement create → marker clear/bind on predecessor stream → predecessor complete → configured visibility → replacement live. |

### Round 1 storage note

- `008_rollover-provenance.sql` adds `rollover_predecessor_attempt_id`, `privacy_status`, and `privacy_status_observed_at` to `broadcast_resources`, plus single-candidate and complete-evidence guards.
- `config/retention.json` and generated `docs/ops/data-map.md` describe the new lifecycle bookkeeping under the existing 30-day row retention policy; no identity, secret, contract, dependency, or lockfile surface changes.
