# TASK-T52-rollover-singleflight

- Task: T52 rolling lifecycle single-flight and crash recovery (`docs/tasks/TASK_SPECS.md` §T52)
- Branch: `dnhynk/t52-rollover-singleflight` · PR: #65
- Orca: task `task_55c76aed6821` · dispatch `ctx_ad8cf70abb12`
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
| 2 | 모든 충돌 mutation이 lifecycle 단일 경계를 통과하고 retry/reconcile·고정 rollover 순서·publish·OBS ingest·chat refresh를 보존하며 reentrant wait가 없다. | met | `BroadcastLifecycle.#serializeMutation`과 private composite 구현; public/unlisted에서 marker clear→bind→old complete→visibility→new live, private no-op, explicit rollover 공개, 실패 뒤 queue 진행을 focused regression으로 검증. |
| 3 | 여러 stale/open attempt 재시작이 최신 정당 상태를 결정론적으로 복구하고 evidence 없이 row/ID를 고치거나 resource를 만들지 않으며 background 오류가 관측된다. | met | exact incident shape(newest `broadcast_created` + two older `live`)는 아무 row/resource/visibility도 바꾸지 않고 safe-stop하며, 단일 predecessor 및 durable predecessor-close interruption은 같은 replacement만 이어 공개한다. detached rejection observer도 검증. |
| 4 | `segmentMs=39,600,000`, simulator off, privacy/world/quota/T51 semantics가 유지된다. | met | config/contract/lockfile 변경 없음; full suite 155 files 통과, accelerated soak 72h PASS·20/20 recovery·final `live`·safe stop 0. |
| 5 | 모든 로컬 gate와 exact-head CI/`soak:ci`가 녹색이고 단일 PR이 열려 있다. | met | 로컬 gate 전부 통과. implementation head `3b5fc398c0c86d50154370e4816ed8338e0586a6`의 CI run 33152179513에서 install/format/lint/typecheck/test/build/`soak:ci` 전부 통과했고 PR #65는 open이다. 이 Result 기록 commit도 push 후 exact-head CI를 worker completion gate로 재확인한다. |

### Gates (executed)

```text
npm ci
  PASS — 431 packages installed; package-lock.json unchanged
npm test -- --run apps/server/src/youtube/broadcast/lifecycle.test.ts apps/server/src/db/broadcast-resources.test.ts apps/server/src/supervisor/supervisor.test.ts
  PASS — 3 files, 141 tests
npm run format:check
  PASS — all matched files use Prettier
npm run lint
  PASS — ESLint; 0 legacy imports; 4 install scripts reviewed
npm run typecheck
  PASS — tsc --build tsconfig.json
npm run test
  PASS — 155 files, 2,275 passed, 1 skipped
npm run build
  PASS — contract schema current; renderer/server/simulator/soak built
npm run soak:ci
  PASS — accelerated 72.00h; 1,728/1,728 processed; 20/20 recoveries;
         final live; no safe stop; verdict PASS
git fetch origin && git rebase origin/main
  PASS — current branch up to date
GitHub Actions run 33152179513 (implementation head 3b5fc398c0c86d50154370e4816ed8338e0586a6)
  PASS — npm ci, format:check, lint, typecheck, test, build, soak:ci
  https://github.com/dnhynk/vertical-live/actions/runs/33152179513
```

## Not done / out of scope

- 실제 host, database, YouTube resources, credentials, scheduled tasks, runtime logs, data/ops journals는 접근하거나 변경하지 않는다.
- `packages/contract`, dependency, `package-lock.json`, `BOARD.md`, `HANDOFF.md`는 변경하지 않는다.

## Follow-ups

- 코디네이터 차단 지적 `msg_fab2f4f6a71e`: rolling replacement가 initial startup publish에 의존해 private로 남던 결함을 확인했다. lifecycle handoff 안에서 predecessor complete 뒤 configured visibility를 복원하도록 수정하고 public/unlisted/private·ordering·crash recovery·chat concurrency 회귀 테스트를 추가했다.
- 코디네이터 topology 보강 `msg_0562085143c7`: 실제 두 older live rows와 newest broadcast-created row를 그대로 구성해 mutation 없는 safe-stop을 고정했다.

## Review round <n>

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
