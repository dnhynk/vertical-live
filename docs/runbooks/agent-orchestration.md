# 에이전트 오케스트레이션 runbook — 스펙 v1 구현 무인 체계

> 상태: 운영 중 (2026-08-16 시작)
> 대상: 이 저장소를 구현하는 코디네이터(Claude, Orca Run 소유), worker(Claude), 리뷰어(Codex)
> 정본: 작업 명세 `docs/tasks/TASK_SPECS.md`, 상태 `docs/tasks/BOARD.md`, 런타임 상태 Orca(`orca orchestration task-list --json`)
> 저장소: `https://github.com/dnhynk/vertical-live` (**public** — 2026-08-18 사용자 전환, BOARD D-4; 기본 브랜치 `main`, squash merge만, 머지 시 브랜치 삭제)

이 문서는 사람이 자리를 비운 동안 **worker가 PR을 올리고, 리뷰어가 검토하고, 코디네이터가 머지한 뒤 다음 작업을 자동으로 지시하는 절차**와 각 역할의 **계약**을 정한다. `CLAUDE.md`와 `~/.claude/CLAUDE.md`의 규칙을 완화하지 않는다. 충돌하면 그쪽이 이긴다.

---

## 0. 결정된 전제 (2026-08-16, 사용자 확정)

| 항목 | 결정 |
|---|---|
| 스택 | TypeScript / Node 26, npm workspaces, SQLite(better-sqlite3), React + R3F 렌더러, vitest |
| 1차 호스트 | 이 Windows 11 PC(OBS Studio 설치됨). 코어는 OS 무관, 운영 스크립트는 Windows 우선 |
| 알림 | Slack incoming webhook(`AlertSink` 구현; BOARD D-3, 2026-08-22 개정) |
| 원격 | `dnhynk/vertical-live` **public**(2026-08-18 전환, 원래 private — BOARD D-4·E-5), `main`, squash merge만, 브랜치 자동 삭제 |
| 동시성 | 구현 worker 최대 **2** + 리뷰어 1(리뷰는 순차). 근거: 2026-08-16 ToneAndMove에서 worker 4 병행 중 호스트 BSOD 2회 → 2로 하향한 이력 |
| worker | `claude`(Orca `--agent claude` = `claude --dangerously-skip-permissions`) |
| 리뷰어 | `codex -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" -c service_tier="fast" --dangerously-bypass-approvals-and-sandbox` (모델·effort는 `~/.codex/models_cache.json` 카탈로그, `service_tier="fast"`는 Codex 공식 config reference에서 확인: fast→요청값 priority) |
| 머지 정책 | CI 통과 + 리뷰어 approve + 코디네이터 최종 게이트(2.6) → **자동 머지**. 2.5의 에스컬레이션 항목만 사용자에게 묻는다 |

스펙에 값이 없어 코디네이터가 가정으로 둔 것은 `docs/tasks/BOARD.md`의 "가정" 표에 적고, 해당 task의 티켓에도 남긴다.

---

## 1. 구조

```text
사용자 ──(에스컬레이션만)── 코디네이터(Claude, Orca Run 소유, term_1bb65169…)
                               │  task-create / worker-start / check --wait / 최종 게이트 / squash merge
                               ├──▶ worker N (claude, 독립 worktree, 브랜치 1개, PR 1개)
                               │        │  worker_done / ask / escalation
                               │        ▼
                               │     GitHub PR + Actions CI
                               │        │
                               └──▶ 리뷰어 (codex, PR마다 새 터미널, `review` worktree에서 PR 브랜치 checkout)
                                        │  gh pr review (approve | request-changes) + worker_done(verdict)
                                        ▼
                                  코디네이터 최종 게이트 ──▶ gh pr merge --squash ──▶ BOARD 갱신 ──▶ 다음 task 디스패치
```

- **Run 1개**가 구현 전체를 담는다. Task는 `docs/tasks/BOARD.md`의 T-ID와 1:1이고, PR 검토는 T-ID당 `R-<T-ID>-<round>` 리뷰 Task로 별도 등록한다.
- **worker 1명 = worktree 1개 = 브랜치 1개 = PR 1개.** worker는 `main`에 직접 push하지 않고 자기 PR을 머지하지 않는다.
- **리뷰어는 코드를 고치지 않는다.** 읽고, 실행하고, 판정하고, `gh pr review`를 남기고, 코디네이터에게 verdict를 보고한다.
- `[contract]` task(`packages/contract` 스키마를 바꾸는 task)는 **동시에 하나만** 진행한다. contract를 바꿔야 하는 다른 task는 멈추고 `ask`한다.

---

## 2. 코디네이터 절차

### 2.1 시작 / 재개

```bash
orca status --json
orca orchestration run-list --json                    # 기존 Run 확인
orca orchestration run-use --id <run_id> --json       # 재개 시 바인딩
orca orchestration task-list --brief --json
```

새로 시작할 때만 `run-create`로 Run을 만들고 BOARD의 모든 task를 `task-create --deps`로 등록한다. Run ID·task ID 대응은 BOARD에 기록한다.

### 2.2 디스패치 (worker)

`task-list --ready`에서 의존이 풀린 task를 동시 상한(2) 안에서 시작한다. `[contract]`는 동시에 하나만.

```bash
orca orchestration worker-start --task <task_id> --worktree new-top-level \
  --repo id:f5dd030a-828b-4bcc-b1b8-dc22b95053bf --name <slug> --agent claude --setup run --timeout-ms 180000 --json
# → result.dispatchId, worktree id, agentTerminalHandle
# worktree: C:/Users/dongh/orca/workspaces/vertical-live/<slug>, 브랜치 dnhynk/<slug> (origin/main 기준), setup hook: npm install
```

**기동 직후 반드시 확인(2026-08-16 T0 사례)**: `worker-start`가 `dispatch_input: accepted`를 반환해도 주입된 프리앰블+TASK가 Claude Code composer에 **제출되지 않은 채** 남을 수 있다(터미널 tail에 `❯ coordinator has more for you …` 텍스트가 보이고 아래에 `bypass permissions on` 상태줄만 있음). `orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 20000` 뒤 `orca terminal send --terminal <handle> --enter`로 Enter 1회를 보내고, 30초 후 `terminal read`로 `● …` 응답이 시작됐는지 확인한다. 빈 composer에 Enter는 무해하므로 확인이 어려우면 보낸다.

기동 후 `orca terminal show --terminal <handle>` preview에 `bypass permissions on`이 없으면 그 worker는 프롬프트에서 멈출 수 있다. 그 경우에만 2단계 경로(`worktree create` → `terminal create --command "claude --dangerously-skip-permissions"` → `terminal wait --for tui-idle` → `dispatch --task --to <handle> --inject`)를 쓴다.

task `--spec`에는 반드시 넣는다: T-ID, 한 줄 목표, `docs/tasks/TASK_SPECS.md`의 절 이름, 브랜치 slug, PR 제목 접두어, `[contract]` 여부, "3장 worker 계약을 먼저 읽는다", 핵심 합격 기준 요약.

### 2.3 대기·처리 루프

```bash
orca orchestration check --wait --types worker_done,escalation,question --timeout-ms 600000 --json
```

- 타임아웃(`count:0`)은 실패가 아니다. `worker-show`/`worker-read`로 살아 있는지 보고 다시 기다린다. 코딩 task는 20~90분 걸린다.
- **question**: `orca orchestration reply --id <msg_id> --body <답> --json`. 답은 스펙 절 번호와 함께 준다. 스펙·공식 문서로 답이 안 되고 2.5에 해당하면 사용자에게 올린다.
- **worker_done(succeeded, PR 있음)**: 2.4 리뷰 디스패치로 간다.
- **worker_done(failed)** / **escalation**: 원인을 읽고 재시도 가능하면 같은 worker에 fix task 재디스패치. 같은 task에서 fix가 **2회 연속 실패**하면 사용자에게 보고하고 task를 `blocked`로 둔다.
- 처리한 Delivery는 `check --ack <delivery_id> --wait ...`로 확인하고 계속 기다린다.
- worker 터미널이 질문을 띄운 채 멈춰 있으면(`terminal read`) `terminal send`로 답한다. "진행할까요?"류 승인 대기면 "진행"을 보내되 반복되면 명세를 고친다.
- worker_done을 받은 뒤 그 worker 터미널은 (a) 리뷰 결과 대기 동안 **유지**(fix task 재사용 가능성) → (b) 머지 후 다음 task가 있으면 `worker-start --task <next> --terminal <handle>`, 없으면 `worker-release --dispatch <id>`.

### 2.4 리뷰 디스패치 (리뷰어)

worker_done(succeeded)에 PR 번호가 있으면:

1. `gh pr view <n> --json state,mergeStateStatus,headRefName,statusCheckRollup` — 열려 있고 CI가 돌고 있는지. `mergeStateStatus == CONFLICTING`이면 리뷰 전에 worker에게 "origin/main rebase 후 재검증" fix task.
2. `gh pr checks <n> --watch` — CI **전부 성공**할 때까지. 실패면 리뷰 없이 worker에게 fix task(로그 요약 첨부).
3. 리뷰 Task 생성·디스패치(코드에서 리뷰어는 codex 커스텀 argv가 필요하므로 저수준 경로):

```bash
orca orchestration task-create --spec "R-<T-ID>-<round>: PR #<n> 리뷰. runbook 4장 리뷰어 계약을 먼저 읽는다. 대상 task: T<k> (docs/tasks/TASK_SPECS.md). 판정을 gh pr review로 남기고 worker_done으로 verdict를 보고한다. 코드를 수정하지 않는다." --json
orca terminal create --worktree id:f5dd030a-828b-4bcc-b1b8-dc22b95053bf::C:/Users/dongh/orca/workspaces/vertical-live/review \
  --title "review-pr-<n>" \
  --command 'codex -c model="gpt-5.6-sol" -c model_reasoning_effort="xhigh" -c service_tier="fast" --dangerously-bypass-approvals-and-sandbox' --json
orca terminal wait --terminal <handle> --for tui-idle --timeout-ms 90000 --json
orca orchestration dispatch --task <review_task_id> --to <handle> --inject --json
```

**주의(2026-08-17)**: codex 화면의 `esc to interrupt`는 MCP 서버 부팅 중에도 표시되므로 '시작됨'의 증거가 아니다 — 부팅 중 Enter를 보내면 MCP 부팅이 중단되고 프롬프트는 composer에 남는다(R-T8-1·R-T13-2에서 30분 유휴 사례). `• Ran`/`Working(`가 보이고 tail 끝에 `[Pasted Content …]`가 없을 때만 시작으로 판정한다(`start_reviewer.py`의 `is_running`). `dispatch --inject` 뒤 codex 화면에 `[Pasted Content N chars]`가 composer에 남으면(2026-08-16 R-T0-1 사례) `orca terminal send --terminal <handle> --enter`로 Enter 1회를 보내고 30초 뒤 `terminal read`로 `• Ran …`/`Working` 표시를 확인한다(2.2와 같은 gotcha).

`review` worktree는 처음 한 번 `orca worktree create --repo id:f5dd… --name review --no-parent --setup run --json`으로 만든다(브랜치는 리뷰어가 PR마다 `gh pr checkout <n> --branch review/pr-<n> --force`로 바꾼다; worker worktree에 checkout된 브랜치는 다른 worktree에서 checkout할 수 없으므로 반드시 `--branch`로 별도 이름을 쓴다). 리뷰는 **한 번에 하나**만 돌린다(같은 worktree).

4. 리뷰어 worker_done을 받으면 body의 verdict를 읽는다:
   - (리뷰는 GitHub에 `--comment`로만 남는다. `gh pr view <n> --json reviews`의 APPROVED를 기대하지 않는다.)
   - `approve` → 2.6 최종 게이트
   - `request_changes` → findings를 그대로 worker에게 fix task로 재디스패치(같은 터미널, `worker-start --task <fix_task> --terminal <handle>`), 다음 round는 새 리뷰어. **round 3에 도달하면**(fix 2회 실패) 사용자 에스컬레이션.
   - `escalate` → 리뷰어가 스펙 모순·정책 위험을 발견한 경우. 코디네이터가 스펙으로 판단하거나 2.5로 올린다.
5. 리뷰어 터미널: `worker-release --dispatch <id>`; release가 pre-existing terminal이라 거부되면 `orca terminal close --terminal <handle> --json`. `close`가 `tab_not_found`로 실패하는 잔여 터미널이 누적되면(2026-08-17: review worktree에 18개) 리뷰가 돌고 있지 않을 때 `orca terminal stop --worktree path:<review worktree> --json`으로 일괄 정리한다(진행 중 리뷰가 있는 worktree에는 쓰지 않는다).

### 2.5 에스컬레이션 — 사용자에게 묻는 것

다음만 사용자에게 올린다. 그 외는 코디네이터가 판단한다.

1. 스펙 §17 "현재 미정인 결정" 중 코드 구조를 바꾸는 것(identity gate 개방, broadcast 프로덕션 전략 선택 등). 플래그로 양쪽을 구현할 수 있으면 묻지 않고 양쪽을 구현한다.
2. 정책·권리·개인정보 처리 방식의 **변경**(스펙이 이미 정한 것을 구현하는 것은 해당 없음)
3. 스펙·`TASK_SPECS.md`에 값이 없고 공식 문서로도 못 정하는 결정(provisional config로 둘 수 없는 것)
4. 같은 task의 fix가 2회 연속 실패, 또는 리뷰 round 3 도달
5. main CI가 깨졌는데 원인이 방금 머지한 PR 밖에 있음
6. 외부 자원·비용·계정 조작이 필요한 것(YouTube 계정, Slack workspace, 유료 서비스)

올릴 때는 **추상화한 질문 + 선택지 + 권장안 + 근거**로 묻고, 답을 기다리는 동안 의존성이 없는 다른 task를 계속 돌린다.

### 2.6 최종 게이트·머지

리뷰어 approve 뒤 코디네이터가 직접 확인한다:

1. `gh pr view <n> --json state,mergeStateStatus,statusCheckRollup,files,additions,deletions,comments` — OPEN, CI 성공, 리뷰어 코멘트의 `## Verdict: approve`(worker_done verdict와 일치)
2. `gh pr diff <n>`을 훑어(1,500줄 초과 시 하위 에이전트에 위임 가능, 판단은 코디네이터):
   - 티켓 `docs/tasks/TASK-<T-ID>-*.md`가 있고 `## Result`에 실행 명령·결과가 있는가, "실행하지 않았음"이 정직하게 적혔는가
   - TASK_SPECS 합격 기준마다 테스트 또는 재현 근거가 있는가
   - 범위 밖 refactor·리네이밍·의존성 추가가 섞이지 않았는가(있으면 근거가 티켓에 있는가)
   - `[contract]` 아닌 task가 `packages/contract`를 바꾸지 않았는가
   - author/표시명/channelId 저장, raw chat 표시, 결제→게임 파워, 가짜 이벤트 생성, secret/PII fixture, Pokémon 자산 — 0건
   - 새 dependency는 exact version + 근거
3. `mergeStateStatus`가 `CONFLICTING`/`BEHIND`면 worker에게 rebase fix task
4. 통과 → `gh pr merge <n> --squash --delete-branch` → BOARD 갱신 커밋(2.7) → 후속 task 디스패치 → worker 터미널 재사용/release
5. 머지 후 `gh run list --branch main --limit 1`로 main CI 확인. 실패면 fix task(원인이 PR 밖이면 2.5(5))

### 2.7 기록

- 머지·에스컬레이션·가정 추가 때마다 `docs/tasks/BOARD.md`를 갱신해 main에 직접 커밋한다(`docs(board): ...`). BOARD 갱신은 코디네이터만 main에 직접 커밋할 수 있는 유일한 예외다.
- 세션이 끊기면 다음 코디네이터는 2.1로 재개한다. Orca Run·task·dispatch 상태는 Orca가 보존한다.

### 2.8 비정상 종료 복구

호스트나 Orca 런타임이 죽으면 코디네이터 세션과 worker 터미널이 함께 사라진다. Orca는 재기동 시 살아 있지 않은 worker의 Dispatch를 `failed`로 정리하고 Task를 `ready`로 되돌린다. **worktree·브랜치·파일·PR은 남는다.**

1. `orca status --json` → `orca orchestration run-use --id <run_id> --json` → `task-list --brief --json`, `dispatch-show --task <id>`로 어떤 dispatch가 죽었는지 확인
2. `orca orchestration check --peek --json`으로 미처리 mail 확인. 죽기 직전 worker_done이 유실됐을 수 있으므로 **`gh pr list --state all`로 실제 PR 상태를 본다** — PR이 열려 있으면 worker_done 없이도 2.4로 간다. 머지됐으면 `task-update --id <task> --status completed --result '{...}'`로 수동 정리(복구 예외)
3. 각 worktree(`git worktree list`)에서 `git status --short | wc -l`, `git log --oneline -3`, 티켓 존재 여부로 진행 상태를 파악한다. 미커밋 변경은 지우지 않는다
4. 미완 task는 **같은 worktree**에 새 dispatch: `worker-start --task <id> --worktree id:<repo-id>::<path> --agent claude --json`(`--retry-of`는 recovery로 settled된 dispatch에는 거부된다; 기존 worktree는 setup을 다시 돌리지 않는다). 주입된 TASK가 composer에 안정적으로 머문 상태에서 `orca terminal send --text "<복구 안내>"`로 안내문을 **덧붙인 뒤** `--enter` 1회로 함께 제출한다(2026-08-17 복구에서 검증; `docs/runbooks/scripts/resume_worker.py`). 안내문으로 (a) 이전 세션 소실 사실, (b) 티켓·git status·diff·log를 읽고 이어갈 것, (c) `git fetch && git rebase origin/main`, (d) 새 preamble의 taskId/dispatchId만 쓸 것, (e) 그동안 답한 질문의 결론(BOARD 가정 번호)을 전달한다
5. 머지가 끝난 worktree는 미커밋 변경 0을 확인한 뒤 `orca worktree rm --worktree path:<path>`로 정리한다
6. BOARD 이력에 종료 시각·소실 범위·복구 조치를 남긴다

**NTFS 0바이트 손상**(크래시 순간 쓰이던 파일): `git worktree list`에 `0000000 (error)`, ref·HEAD·index가 NUL로 채워짐. 복구: `.git/worktrees/<name>/logs/HEAD`·`.git/logs/refs/heads/<branch>`의 마지막 정상 SHA → `git cat-file -t` 확인 → 깨진 ref 삭제 후 `git update-ref` → HEAD 복구 → 깨진 index 삭제 후 `git reset` → 작업 트리 NUL 파일은 `git reset --hard HEAD`(커밋된 것만 복원됨 — 그래서 3.6의 조기 push 규칙이 있다).

**재부팅 원인은 System 로그로 먼저 확인**: `Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,1001,6008}`. BSOD면 사용자에게 보고하고 동시 worker 수·무거운 명령 병행을 줄인다. 이력: 2026-08-16 14:47 UTC bugcheck 0x00000050(PAGE_FAULT_IN_NONPAGED_AREA, minidump `C:\WINDOWS\Minidump\081626-14718-01.dmp`) — worker 2 + 리뷰어 0 상태에서 발생(ToneAndMove의 0x50 2회와 동일 코드). 재발 시 코디네이터가 고칠 수 없는 호스트 문제이므로 사용자에게 minidump 분석·메모리 진단을 권고하고, 조기 커밋 규칙(3.6)으로 손실만 최소화한다.

**worker 브랜치를 코디네이터가 origin에 push해 둔다.** 복구 직후 커밋이 있는 브랜치는 `git push -u origin <branch>`로 보존한다(비파괴).

---

## 3. worker 계약

worker는 디스패치 프리앰블과 함께 이 절을 받는다. **task 명세보다 이 절이 먼저다.**

### 3.1 시작

1. `git status && git log --oneline -3`으로 현재 worktree가 `origin/main` 기준의 자기 브랜치(`dnhynk/<slug>`)인지 확인한다. 브랜치를 바꾸지 않는다.
2. `CLAUDE.md` → `docs/tasks/TASK_SPECS.md`의 자기 절 → 스펙의 지정 절 → `docs/tasks/BOARD.md`의 "결정"·"가정" 표 순으로 **반드시 읽는다.**
3. `docs/tasks/TASK-<T-ID>-<slug>.md`를 `docs/tasks/TASK_TEMPLATE.md`로 만든다. `## Plan`은 티켓 안에 쓴다. **채팅으로 승인을 기다리지 않는다** — 코디네이터가 task 명세로 이미 접근을 합의했다. `~/.claude/CLAUDE.md`의 "먼저 합의" 규칙은 이 티켓과 코디네이터 `ask`로 충족된다.

### 3.2 질문

- 스펙·명세에 값이 없거나 두 문서가 어긋나면 **추측으로 메우지 않는다.** `orca orchestration ask --question "<질문. 선택지와 네 권장안 포함>" --timeout-ms 1800000 --json`으로 코디네이터에게 묻는다. 타임아웃이면 `ask --resume <message_id>`로 같은 질문을 이어간다. 새로 묻지 않는다.
- 답을 기다리는 동안 그 답에 의존하지 않는 부분을 먼저 한다.
- 공식 문서(Google/YouTube API·정책, OBS, SQLite, Node, gRPC 등)로 확정할 수 있는 것은 묻지 말고 근거 URL과 확인 날짜를 티켓에 남긴다.
- 그래도 정할 수 없는 수치는 `provisional: true` config로 두고 티켓·PR "Assumptions"에 적는다.
- 사용자에게 직접 말할 수 없다. 사용자 결정이 필요한 것도 `ask`로 코디네이터에게 보낸다.

### 3.3 환경 (Windows, 로컬)

- Node 24 + npm(`package-lock.json`). pnpm/yarn을 쓰지 않는다. worktree setup hook이 `npm install`을 돌린다.
- 개발 서버 포트가 겹치면 env로 바꾼다(`VL_PORT`, Vite `--port`). 다른 worker의 서버·프로세스를 죽이지 않는다.
- 셸: bash(Git Bash) 또는 PowerShell. 스크립트는 Node로 쓰고 bash 전용 문법에 의존하지 않는다.
- `.env*`, `data/*.db`, vault 값은 커밋하지 않는다. 실제 Google/YouTube 계정·키를 쓰지 않는다(가짜 서버·fixture만).

### 3.4 구현 규칙 (요약 — 정본은 `CLAUDE.md`)

- 가장 작은 수직 slice. UI만 만들고 backend를 TODO로 두지 않는다.
- 성공 경로와 거부/오류 경로를 함께 구현하고 둘 다 테스트한다.
- `[contract]` task만 `packages/contract`의 스키마를 바꾼다. 아닌 task가 contract 변경이 필요해지면 **멈추고 `ask`**.
- 생성 파일(JSON Schema 등)은 스크립트로 만들고 손으로 고치지 않는다.
- 새 dependency는 exact version으로 고정하고 선택 근거를 티켓에 남긴다.
- 실제 개인정보·production secret·실존 사용자명을 코드·fixture·테스트에 넣지 않는다.
- 요청 범위를 넘는 refactor·리네이밍 금지. 필요하면 Follow-up에 적는다.

### 3.5 PR 전 게이트

```bash
git fetch origin && git rebase origin/main
npm run format:check && npm run lint && npm run typecheck
npm run test
npm run build
```

실행하지 못한 게이트는 티켓 `## Result`와 PR 본문에 **"실행하지 않았음: <이유>"** 로 적는다. 통과했다고 거짓으로 쓰지 않는다.

### 3.6 커밋·PR

- 커밋: 영어 Conventional Commits. 작은 논리 단위로 나눈다.
- push: **첫 커밋 직후 `git push -u origin <branch>`, 이후 커밋마다 push**(WIP push 허용 — 호스트 크래시 시 push되지 않은 작업만 잃는다). **첫 커밋(티켓+뼈대)은 시작 10분 안에, 이후 논리 단위마다·최소 30분마다 커밋+push**한다(2026-08-16 14:47 UTC BSOD 0x50으로 T2의 20분치 미커밋 작업이 worktree에만 남았던 사례; 2026-08-17 복구에서 회수). rebase 뒤 자기 feature 브랜치가 non-fast-forward가 되면 **`git push --force-with-lease`만 허용**(자기 브랜치 한정). 맨 `--force`, main·타인 브랜치에 대한 force는 금지.
- PR: `gh pr create --base main --title "<type(scope): summary>" --body-file <file>`. 본문은 `.github/pull_request_template.md`. "Tests"에는 **실행한 명령과 결과 요약**을 쓴다.
- PR 하나. 범위 밖 변경은 Follow-up에 적는다.

### 3.7 완료 보고

```bash
orca orchestration send --type worker_done --subject "<T-ID> <succeeded|failed>: <한 줄>" \
  --body "PR: #<n> <url>
Completed: ...
Not done / assumptions: ...
Tests: <명령과 결과>
Escalation needed: <있으면>" \
  --task-id <task_id> --dispatch-id <dispatch_id> --outcome <succeeded|failed> \
  --files-modified "<주요 파일, 쉼표 구분>" --json
```

- 정확히 **한 번**, 자기 터미널에서. `--outcome`을 반드시 넣는다. PR을 못 만들었으면 `failed`.
- 보낸 뒤 턴을 끝내고 프롬프트에서 대기한다. 코디네이터가 fix task를 같은 터미널로 다시 보낼 수 있다.

### 3.8 fix task를 받았을 때

- 리뷰 findings를 하나씩 티켓 `## Review round <n>`에 옮겨 적고 각각 "고침(커밋 SHA) / 반박(근거)"을 쓴다. 반박은 스펙·명세·공식 문서 근거가 있을 때만.
- 게이트(3.5)를 다시 돌리고 push한 뒤 worker_done을 다시 보낸다.

### 3.9 금지

- `main`에 push, 자기 PR 머지, 다른 브랜치·worktree 수정
- 맨 `git push --force`, main·타인 브랜치에 대한 force push, `git reset --hard`로 남의 커밋 제거, worktree 삭제
- 실제 Google/YouTube/Discord 자원 개설·호출, 실제 API 키 사용
- 사용자에게 직접 승인 요청(코디네이터 `ask`만 사용)
- 테스트를 skip/삭제해 게이트를 통과시키기
- author/표시명/channelId 저장, raw chat 표시, 결제→게임 파워, 임의 사용자명·가짜 이벤트 생성 코드

---

## 4. 리뷰어 계약 (Codex)

리뷰어는 디스패치 프리앰블과 함께 이 절을 받는다. `AGENTS.md`가 이 절을 가리킨다.

### 4.1 역할

PR을 **읽고·실행하고·판정**한다. 코드를 고치지 않고, push·머지하지 않는다. 결과는 두 곳에 남긴다: GitHub PR review와 코디네이터에게 보내는 `worker_done`.

### 4.2 절차

1. `CLAUDE.md` → 이 절 → 대상 task의 `docs/tasks/TASK_SPECS.md` 절 → 그 절이 지정한 스펙 절 → PR의 티켓 `docs/tasks/TASK-<T-ID>-*.md`를 읽는다.
2. review worktree는 리뷰 전용 일회용 checkout이다. 먼저 `git reset --hard && git clean -fd -e node_modules`로 정리한다(setup hook의 lockfile 변경 등이 남아 있을 수 있음; 이는 PR 코드 수정이 아니다). 그다음 `gh pr checkout <n> --branch review/pr-<n> --force` (반드시 `--branch`; worker의 브랜치를 그대로 checkout하면 다른 worktree와 충돌한다). `git log --oneline origin/main..HEAD`로 범위를 본다.
3. 게이트를 직접 실행한다: `npm ci`(또는 `npm install`), `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`. 결과를 그대로 기록한다(요약 금지, 실패 로그 인용).
4. 합격 기준을 **하나씩** 대조한다: 만족(근거: 테스트 파일/명령/출력) · 불만족(무엇이 없는가) · 확인 불가(왜).
5. 금지 항목 검사(3.9 마지막 줄, `CLAUDE.md` 불변조건): grep·코드 읽기로 확인하고 결과를 적는다.
6. 범위 검사: TASK_SPECS 범위 밖 변경, `[contract]` 아닌데 `packages/contract` 변경, 새 dependency의 exact version·근거, 티켓 `## Result`의 정직성("실행하지 않았음" 표기 허용, 거짓 표기 불가).
7. 판정:
   - `approve`: 모든 합격 기준 만족(또는 확인 불가 항목이 코디네이터가 수용 가능한 이유로 문서화됨) + 금지 0건 + 범위 정상
   - `request_changes`: 위반이 하나라도 있음. finding마다 `파일:줄`, 심각도(blocker/major/minor), 무엇이 왜 문제인지, 어떤 합격 기준·스펙 절에 걸리는지
   - `escalate`: 스펙 자체의 모순·정책/권리/개인정보 위험·명세로 판단 불가한 설계 갈림 — 코디네이터 판단 필요
8. `gh pr review <n> --comment --body-file <review.md>` — **항상 `--comment`**. 리뷰어와 worker가 같은 GitHub 계정(`dnhynk`)이라 GitHub가 자기 PR에 대한 approve/request-changes를 거부한다(2026-08-16 R-T0-1: "Can not request changes on your own pull request"). verdict는 본문 첫 줄 `## Verdict:`와 `worker_done` body로 전달하고, 최종 게이트는 코디네이터가 맡는다. 본문 형식은 4.3.
9. `worker_done` 1회:

```bash
orca orchestration send --type worker_done --subject "R-<T-ID>-<round> <approve|request_changes|escalate>: PR #<n>" \
  --body "verdict: <approve|request_changes|escalate>
gates: format=<pass|fail|skipped> lint=<…> typecheck=<…> test=<…> build=<…>
acceptance: <k>/<n> met; unmet: <목록>
blockers: <목록 또는 none>
majors: <목록 또는 none>
notes: <한 문단>" \
  --task-id <task_id> --dispatch-id <dispatch_id> --outcome succeeded --json
```

`--outcome`은 리뷰 작업 자체의 성공 여부다. request_changes도 리뷰는 succeeded다. PR을 checkout·실행하지 못했으면 failed.

10. 보낸 뒤 턴을 끝내고 대기한다.

### 4.3 review 본문 형식

```markdown
## Verdict: approve | request_changes | escalate

## Gates (executed by reviewer)
| gate | result | evidence |
|---|---|---|
| format:check | pass | … |
| lint | … | … |
| typecheck | … | … |
| test | … | N passed / M failed: <실패명> |
| build | … | … |

## Acceptance criteria (docs/tasks/TASK_SPECS.md §T<k>)
1. <기준> — met | unmet | unverifiable — <근거>
…

## Findings
- [blocker] path/file.ts:123 — <문제> — <걸리는 기준/스펙 절> — <제안(선택)>
- [major] …
- [minor] …

## Scope / policy checks
- packages/contract changed: yes/no (task is [contract]: yes/no)
- forbidden patterns (author/name/channelId storage, raw chat display, paid→game power, fake events, secrets, Pokémon assets): none | <목록>
- new dependencies: <이름@exact 근거> | none
- ticket ## Result honesty: ok | issue
```

### 4.4 금지

- 파일 수정·커밋·push·머지·브랜치 삭제, PR 본문 편집
- worker나 사용자에게 직접 지시(코디네이터에게만 보고)
- 실행하지 않은 게이트를 통과로 적기
- 취향 지적을 blocker로 올리기(스타일은 minor, 근거는 lint 규칙·명세)
