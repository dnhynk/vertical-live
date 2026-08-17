# TASK-T17-windows-ops

- Task: T17 Windows 운영 스크립트: 자동시작·OBS 기동·아카이브 순환 (`docs/tasks/TASK_SPECS.md` §T17)
- Branch: `dnhynk/t17-windows-ops` · PR: #<n>
- Orca: task `task_e2466b978ebe` · dispatch `ctx_f952a9dfbf9f`
- Spec sections read: §9.1(rolling archive·off-host), §9.2, §9.4, §10.2, §10.3, §11(hosting OS·interactive session·archive 정책), §12.1, [S7] [S19] [S21] [S23] [S26] [S27]
- BOARD decisions/assumptions relied on: D-2(1차 호스트 = 이 Windows 11 PC), D-3(Discord webhook), A-15(합격선 숫자는 provisional config), A-16(stream key는 vault가 정본, 정지 시 제거·프로파일 ACL은 T17)

## Goal

이 Windows 11 호스트가 **사람 없이 로그온만으로** 방송 스택을 올리고, 디스크가 차서 스스로 멈추지 않게 만든다. 세 덩이다. (1) 로그온 자동시작: 렌더러 정적 서빙 → 서버 → OBS 순서로 띄우고 각 단계의 **준비 상태를 확인한 뒤에만** 다음으로 간다(§11 "hosting OS와 OBS interactive-session 실행 방식을 선택하고 reboot, 자동 시작, sleep, GPU reset, remote-session 종료, 자동 업데이트를 시험한다"). (2) 로컬 rolling archive: 보존일·최대 용량·최소 여유공간 규칙으로 오래된 파일부터 지운다(§9.1 "용량 제한이 있는 로컬 rolling archive"). 규칙 숫자는 Gate 2 승인 대상이라 전부 `provisional`이다(§11 마지막 문단, A-15). (3) `docs/ops/windows-host.md`: 재부팅·자동 로그온·sleep·GPU reset·remote-session·자동 업데이트를 **사용자가 실행할** 체크리스트로 고정한다.

여기에 선행 task가 T17로 미룬 세 갈래를 함께 닫는다: `obs-process` 컴포넌트의 실행기 주입(T12), 렌더러 Browser Source URL·토큰 주입(T12/T2 — 이게 없으면 자동시작이 무인으로 완결되지 않는다. 서버가 `/ws/renderer`에서 토큰 없는 렌더러를 4401로 끊기 때문이다), 정지 시 stream key를 OBS 프로파일에서 지우는 것(A-16).

## Plan

1. **티켓 + 뼈대 커밋**(이 파일), push.
2. **정적 서빙**: `apps/server/src/ops/static-server.ts` — loopback 전용 정적 파일 서버(디렉터리 탈출 차단, index fallback, mime 표). CLI `apps/server/src/bin/serve-renderer.ts`, npm script `serve:renderer`. 새 dependency 없음.
3. **아카이브 순환**: `apps/server/src/ops/archive/`
   - `config.ts` — `config/default.json`의 `archive` 절(전 항목 `provisional`) + env override.
   - `plan.ts` — **순수 함수** `planArchiveSweep({roots, freeBytes, nowMs, config})` → 삭제 대상·이유·예상 회수량. 규칙 순서: 보존일 초과 → 최대 용량 초과분(오래된 것부터) → 최소 여유공간 미달분(오래된 것부터). 쓰기 중일 수 있는 파일(`activeFileGraceMs` 이내 수정)은 후보에서 제외.
   - `sweep.ts` — 실제 스캔·삭제. `fs`·`clock`·`logger` 주입.
   - `apps/server/src/bin/archive.ts` — **기본이 dry-run**, 삭제는 `--apply`를 명시해야 한다. `--json`.
4. **OBS 기동**: `apps/server/src/obs/process.ts` — `ObsProcessLauncher`(spawn 주입, 실행 파일 존재 확인, `--profile`/`--collection`/`--multi`는 공식 launch parameter만 사용). `main.ts`의 `actions.obsProcess`에 배선(설정이 없으면 지금처럼 정직하게 실패).
5. **A-16 잔여**: `ObsControl.clearStreamServiceKey()`(정지 후 키 제거) + `setRendererSourceFromVault()`(Browser Source URL에 vault 토큰 주입). 프로파일 디렉터리 ACL은 명령을 문서에 싣고 **실행은 사용자**(호스트 권한 변경).
6. **ops/windows/**: `tasks/*.xml`(Task Scheduler 정의 템플릿) + `Register-VerticalLive.ps1` / `Unregister-VerticalLive.ps1` / `Start-VerticalLive.ps1`(순서·준비 대기 launcher). 셋 다 `-WhatIf` dry-run.
7. **docs/ops/windows-host.md**: 실행 계정·interactive session 전제, 체크리스트(재부팅·자동 로그온·sleep·GPU reset·remote-session·자동 업데이트), 아카이브 규칙 표, OBS 32의 safe-mode 프롬프트 문제.
8. 게이트 5종 실행 → PR.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| OBS Studio launch parameters | https://obsproject.com/kb/launch-parameters | 2026-08-17 | `--profile "name"`, `--collection "name"`, `--scene "name"`, `--minimize-to-tray`, `--multi`, `--disable-updater`, `--disable-missing-files-check`, `--safe-mode` 등이 공식 목록. **`--disable-shutdown-check`와 `--websocket_*`는 이 목록에 없다** — 문서에 없는 플래그를 자동시작 스크립트에 넣지 않는다 |
| `--disable-shutdown-check` 제거 | https://github.com/obsproject/obs-studio/issues/12650 · https://obsproject.com/forum/threads/obs-version-32-0-0-removed-disable-shutdown-check.190590/ | 2026-08-17 | OBS **32.0.0에서 제거**(이슈는 "closed as not planned"). 우리 고정 후보가 32.0.2(E-2)이므로 **비정상 종료 뒤 safe-mode 프롬프트를 공식 방법으로 끌 수 없다.** 무인 운영의 실질 위험 → windows-host.md 체크리스트 항목 |
| OBS Safe Mode 메커니즘 | https://github.com/obsproject/obs-studio/pull/8455 | 2026-08-17 | Safe Mode는 third-party plugin과 **obs-websocket을 끈다** → safe mode로 부팅되면 우리 제어 경로 전체가 죽는다 |
| `%APPDATA%\obs-studio\.sentinel` | 이 호스트에서 직접 확인(`ls -ld`) | 2026-08-17 | 존재하며 **디렉터리**다. 비정상 종료 표식. 삭제로 프롬프트를 피할 수 있다는 것은 커뮤니티 보고이며 공식 문서에 없다 → 문서에 "비공식"으로 표기하고 스크립트에서는 opt-in 플래그로만 |
| `schtasks /create` | https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create | 2026-08-17 | `/xml <file> /tn <name>`로 XML 등록, `/f` 덮어쓰기, `/it` = "run the scheduled task only when the run as user ... is logged on to the computer"(interactive session 전제), `/ru`, `/rl`. `/query /v`의 `Logon Mode: Interactive only`로 확인 |
| Task Scheduler XML(LogonTrigger·Principal) | https://learn.microsoft.com/en-us/windows/win32/taskschd/logon-trigger-example--xml- · https://learn.microsoft.com/en-us/windows/win32/taskschd/logontrigger | 2026-08-17 | `<LogonTrigger><UserId>`, `<Principal><LogonType>InteractiveToken</LogonType>` |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
<pending>
```

## Not done / out of scope

- (작성 중)

## Follow-ups

- (작성 중)
