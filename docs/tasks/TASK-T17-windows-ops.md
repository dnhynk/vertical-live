# TASK-T17-windows-ops

- Task: T17 Windows 운영 스크립트: 자동시작·OBS 기동·아카이브 순환 (`docs/tasks/TASK_SPECS.md` §T17)
- Branch: `dnhynk/t17-windows-ops` · PR: #17
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
| 합격 기준 2를 위해 이 PC에서 scheduled task를 **실제로 등록 → `/Query` 확인 → 즉시 해제**하는 1사이클을 돌려도 되는가(A), 아니면 `-WhatIf` dry-run 출력만 첨부하고 "실행하지 않았음"으로 적는가(B)? 권장 A(잔여물 없음, XML 유효성 실증) | **A 승인.** 조건: (1) 등록 직후 `/Query`와 삭제 직후 "없음" 로그를 모두 첨부 (2) 삭제 실패 시 즉시 ask (3) 티켓 Result에 "등록·해제 1사이클 실행함(영구 변경 없음)"으로 기록 (4) **실제 자동시작 활성화(등록 유지)는 절대 하지 않는다** — 사용자 결정 영역이므로 문서 절차로만 | 아래 Result 3에 전체 로그. 등록된 두 task는 같은 세션에서 삭제했고 `schtasks /Query`가 둘 다 "없음"을 반환하는 것까지 확인했다. 호스트에는 아무 task도 남아 있지 않다 |

## Assumptions / provisional values

스펙 §11: "rolling archive의 최대 용량·최소 여유공간·보존·자동 삭제 규칙도 같은 시점에 승인한다"(= 72시간 soak 전, Gate 0/2). 따라서 아래 숫자는 전부 `provisional`이며 합격선이 아니다(BOARD A-15). `archive.provisional` 배열이 코드에도 그대로 들어 있고 `sweep.test.ts`가 그 목록을 검사한다.

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `archive.retentionDays` | 7 | provisional | 스펙에 보존일 값이 없다. 12시간 미만 rolling 방송(§9.3)이면 1주가 며칠치 방송을 덮는 값이라 시작점으로 잡았다 |
| `archive.maxTotalBytes` | 200 GiB | provisional | 아카이브 자체 상한. 호스트 볼륨 크기를 Gate 2에서 실측해 정한다 |
| `archive.minFreeBytes` | 50 GiB | provisional | disk-full fault(§11)를 만나기 전에 지우기 시작하는 여유. 실제 필요량은 인코딩 비트레이트·녹화 여부에 달렸다 |
| `archive.activeFileGraceMs` | 600000 | provisional | 진행 중인 녹화 파일을 후보에서 빼기 위한 여유. OBS가 파일을 계속 쓰는 동안 mtime이 갱신된다는 사실에만 의존한다 |
| `archive.roots[]` | recordings/diagnostics/ops-logs 3개 | provisional | V1은 녹화하지 않으므로(`RecEncoder=none`) 첫 루트는 비어 있는 것이 정상이다. 실제 녹화 경로는 Gate 2에서 정한다 |
| `\VerticalLive\vl-archive-sweep` 주기 | `PT1H` | provisional | `-ArchiveInterval`로 바꾼다 |
| task 로그온 지연 | 자동시작 `PT30S`, 아카이브 `PT5M` | provisional | 로그온 직후 네트워크·GPU가 자리를 잡는 시간. 준비 대기는 스크립트가 따로 한다 |
| `obs.process.executablePath` | `C:\Program Files\obs-studio\bin\64bit\obs64.exe` | 호스트 확인값 | 이 호스트에 실제로 존재하는 경로(2026-08-17 확인). `enabled`는 기본 `false` |

## Result

### Acceptance criteria (TASK_SPECS §T17)

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 스크립트 dry-run 모드와 단위 테스트(경로·용량 계산·삭제 대상 선정) | **met** | dry run: `Register/Unregister/Start-VerticalLive.ps1 -WhatIf` 3종 실행(아래 Result 1), `node apps/server/dist/bin/archive.js`(기본이 dry run) 실행(Result 2), `obs-launch.js --dry-run` 실행(Result 2). 단위 테스트: 경로 `sweep.test.ts`("resolves relative roots…", "rejects paths outside the root…", "drops a listed path that is not inside its root", "matches extensions case-insensitively…") · 용량 계산 `plan.test.ts`("fits under maxTotalBytes", "until the volume has minFreeBytes again", "reports rules it cannot satisfy") · 삭제 대상 선정 `plan.test.ts`("deletes files older than the retention window", "names the rule that condemned each file", "never proposes a file that may still be open for writing", "orders equal timestamps by path") · dry-run 기본값 `cli.test.ts`("is a dry run unless apply is asked for", "deletes nothing without --apply") · **실제 링크 경로 `sweep.test.ts`("runArchiveSweep against real links (review round 1, B1)" 3건 + nodeArchiveFs junction 1건, round 2 추가)**. `apps/server/src/ops/archive` 4 파일 **56 tests**, `apps/server/src/ops` 전체 6 파일 76 tests (round 1 m1 정정: 이전 표기 "60"은 archive가 아니라 ops 전체 수였고 그마저도 지금은 76이다) |
| 2 | 이 PC에서 자동시작 등록·해제 실행 로그 첨부(가능하면), 아니면 "실행하지 않았음" | **met** | Result 3에 `schtasks /Create` → `/Query`(`Logon Mode: Interactive only`) → `/Delete` → `/Query`(없음) 전체 출력. **등록·해제 1사이클만 실행했고 호스트에 영구 변경은 남기지 않았다**(코디네이터 승인 조건 4에 따라 자동시작을 켜 두지 않았다) |

범위 항목 대조:

| 범위(§T17) | 결과 |
|---|---|
| `ops/windows/` 로그온 자동시작(Task Scheduler XML + schtasks 스크립트) | `ops/windows/tasks/*.xml`, `Register-/Unregister-VerticalLive.ps1` |
| 서버·렌더러 정적 서빙·OBS(프로파일·씬 지정, websocket) | `Start-VerticalLive.ps1` 3단계. 정적 서빙은 새로 만든 `apps/server/src/ops/static-server.ts`(loopback 전용), OBS는 `obs-launch.js`가 `--profile vertical-live --collection vertical-live`로 띄운다. **websocket 서버 활성화는 OBS UI 설정이라 자동화하지 않는다**(`docs/ops/obs-setup.md` §2, 호스트 소유자 결정) — 대신 4455 포트를 준비 신호로 확인하고 닫혀 있으면 실패로 기록한다 |
| 순서와 준비 대기 | 정적 서빙 → 서버 → OBS. 각 단계는 HTTP 응답/포트 개방을 폴링하고 타임아웃이면 exit 1. 이미 응답하는 단계는 건너뛴다 |
| 실행 계정·interactive session 전제 문서화 | `docs/ops/windows-host.md` 1장 + XML 주석. `LogonType InteractiveToken`이 `/Query`의 `Logon Mode: Interactive only`로 확인됨 |
| 로컬 rolling archive 자동 삭제(최대 용량·최소 여유·보존일 provisional config) | `config/default.json` `archive` + `apps/server/src/ops/archive/`(plan/sweep/cli) + `\VerticalLive\vl-archive-sweep` task |
| `docs/ops/windows-host.md` 체크리스트 | 5장(재부팅·자동 로그온·sleep·GPU reset·remote-session·자동 업데이트) — 각 항목이 "설정 + 확인 방법" 짝. **실행은 사용자**(§11) |

### Result 1 — 스크립트 dry run (실행함)

```text
$ powershell -ExecutionPolicy Bypass -File ops\windows\Register-VerticalLive.ps1 -WhatIf
2026-08-17T17:26:40.412Z [info] repository: C:\Users\dongh\orca\workspaces\vertical-live\t17-windows-ops
2026-08-17T17:26:40.425Z [info] run-as account: DESKTOP-S67O4BQ\dongh (interactive session required)
2026-08-17T17:26:40.428Z [info] node: C:\Program Files\nodejs\node.exe
2026-08-17T17:26:40.452Z [info] schtasks.exe /Create /TN \VerticalLive\vl-autostart /XML <temp>.xml /F
What if: Performing the operation "register scheduled task" on target "\VerticalLive\vl-autostart".
--- would register \VerticalLive\vl-autostart with this definition ---
<치환된 XML 전체 출력: UserId=DESKTOP-S67O4BQ\dongh, LogonType=InteractiveToken, WorkingDirectory=<repo>>
... (아카이브 task도 같은 형식)
2026-08-17T17:26:40.467Z [warn] the host still needs the docs/ops/windows-host.md checklist ... before it runs unattended

$ powershell -ExecutionPolicy Bypass -File ops\windows\Start-VerticalLive.ps1 -WhatIf
2026-08-17T17:27:49.427Z [info] starting vertical-live from C:\Users\dongh\orca\workspaces\vertical-live\t17-windows-ops
2026-08-17T17:27:49.434Z [info] session: user=dongh interactive=True node=C:\Program Files\nodejs\node.exe
What if: Performing the operation "start renderer static serving" on target "http://127.0.0.1:5173/".
What if: Performing the operation "start @vl/server" on target "http://127.0.0.1:8787/health".
2026-08-17T17:27:51.500Z [warn] obs.process.enabled is false: not starting OBS. ...
2026-08-17T17:27:51.500Z [info] start sequence complete; the supervisor owns the run from here
EXIT=0

$ powershell -ExecutionPolicy Bypass -File ops\windows\Unregister-VerticalLive.ps1 -WhatIf
2026-08-17T17:27:52.066Z [warn] not registered: \VerticalLive\vl-autostart
2026-08-17T17:27:52.118Z [warn] not registered: \VerticalLive\vl-archive-sweep
EXIT=0
```

빌드 산출물이 없을 때 시작을 거부하는 것도 실행으로 확인했다(빌드 전 실행 시 `missing build artifact: ...\apps\renderer\dist\index.html` + `run "npm run build" first`, exit 1).

### Result 2 — 아카이브 스위퍼 (실행함)

저장소 기본 설정 그대로 dry run:

```text
$ node apps/server/dist/bin/archive.js
archive sweep 2026-08-17T17:29:20.322Z (dry run — nothing deleted)
rules: retention 7d · max total 204800.0 MiB · min free 51200.0 MiB (all provisional, BOARD A-15)
root recordings: (missing) ...\data\archive\recordings
root diagnostics: (missing) ...\data\diagnostics\screenshots
root ops-logs: (missing) ...\data\ops\logs
scanned 0 file(s), 0.0 MiB; 0 inside the write grace window; free 59936.8 MiB
no files selected for deletion
```

합성 파일로 dry run → apply 대조(스크래치 디렉터리, 임시 config):

```text
$ (old.mkv mtime 2026-08-01, newer.mkv mtime 2026-08-17, notes.txt)
$ node apps/server/dist/bin/archive.js --config <tmp>.json
would delete 1 file(s), 1.9 MiB:
  [retention_days] 1.9 MiB  ...\archive-smoke\recordings\old.mkv
$ node apps/server/dist/bin/archive.js --config <tmp>.json --apply
deleted 1 file(s), 1.9 MiB:
  [retention_days] 1.9 MiB  ...\archive-smoke\recordings\old.mkv
$ ls
newer.mkv  notes.txt      # 보존일 안의 .mkv와 루트가 소유하지 않은 .txt는 그대로
```

OBS 실행기:

```text
$ node apps/server/dist/bin/obs-launch.js --dry-run
C:\Program Files\obs-studio\bin\64bit\obs64.exe --profile vertical-live --collection vertical-live --disable-updater --disable-missing-files-check
(cwd C:\Program Files\obs-studio\bin\64bit, dry run)
$ node apps/server/dist/bin/obs-launch.js
obs launch refused (not_configured): obs process launch is not configured (obs.process.enabled is false)   # exit 1
```

**실제 OBS를 띄우지는 않았다**: `obs.process.enabled`가 기본 `false`이고, 호스트에서 OBS를 기동·설정하는 것은 사용자 결정 영역이다(런북 2.5(6), BOARD E-2·E-3).

### Result 3 — 자동시작 등록·해제 1사이클 (실행함, 영구 변경 없음)

```text
$ powershell -ExecutionPolicy Bypass -File ops\windows\Register-VerticalLive.ps1
2026-08-17T17:34:03.502Z [info] schtasks.exe /Create /TN \VerticalLive\vl-autostart /XML <temp>.xml /F
2026-08-17T17:34:03.561Z [info] SUCCESS: The scheduled task "\VerticalLive\vl-autostart" has successfully been created.
2026-08-17T17:34:03.606Z [info]
Folder: \VerticalLive
TaskName:                             \VerticalLive\vl-autostart
Status:                               Ready
Logon Mode:                           Interactive only          <- §11 interactive-session 전제
Task To Run:                          powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "<repo>\ops\windows\Start-VerticalLive.ps1"
Start In:                             <repo>
Run As User:                          dongh
Schedule Type:                        At logon time
2026-08-17T17:34:03.611Z [info] schtasks.exe /Create /TN \VerticalLive\vl-archive-sweep /XML <temp>.xml /F
2026-08-17T17:34:03.664Z [info] SUCCESS: The scheduled task "\VerticalLive\vl-archive-sweep" has successfully been created.
2026-08-17T17:34:03.699Z [info]
TaskName:                             \VerticalLive\vl-archive-sweep
Logon Mode:                           Interactive only
Task To Run:                          C:\Program Files\nodejs\node.exe "<repo>\apps\server\dist\bin\archive.js" --apply
Stop Task If Runs X Hours and X Mins: 00:10:00
Schedule Type:                        At logon time
REGISTER_EXIT=0

$ powershell -ExecutionPolicy Bypass -File ops\windows\Unregister-VerticalLive.ps1
2026-08-17T17:34:12.151Z [info] SUCCESS: The scheduled task "\VerticalLive\vl-autostart" was successfully deleted.
2026-08-17T17:34:12.184Z [info] removed: \VerticalLive\vl-autostart
2026-08-17T17:34:12.264Z [info] SUCCESS: The scheduled task "\VerticalLive\vl-archive-sweep" was successfully deleted.
2026-08-17T17:34:12.295Z [info] removed: \VerticalLive\vl-archive-sweep
UNREGISTER_EXIT=0

$ schtasks /Query /TN "\VerticalLive\vl-autostart"       -> ERROR: The system cannot find the path specified. (exit 1)
$ schtasks /Query /TN "\VerticalLive\vl-archive-sweep"   -> ERROR: The system cannot find the path specified. (exit 1)
$ schtasks /Query /FO CSV /NH | Select-String 'VerticalLive'  -> none
```

첫 등록 시도에서 아카이브 task가 `ERROR: The task XML is malformed. (16,5)::잘못된 주석 구문`으로 거부됐다. 원인은 XML 주석 안의 연속 하이픈(`--apply`)이고, 주석 문구를 고쳐 해결했다(`ops/windows/tasks/vertical-live-archive.xml`). dry run만 했다면 발견하지 못했을 결함이다.

### Gates (executed)

```text
$ git fetch origin && git rebase origin/main      -> Successfully rebased and updated refs/heads/dnhynk/t17-windows-ops
$ npm run format:check                            -> All matched files use Prettier code style!
$ npm run lint                                    -> eslint 통과, check-no-legacy-imports: ok (0), check-install-scripts: ok (4 reviewed)
$ npm run typecheck                               -> tsc --build 통과(출력 없음)
$ npm run test                                    -> Test Files 129 passed (129) / Tests 1802 passed | 1 skipped (1803)
$ npm run build                                   -> 전 워크스페이스 성공(data-map up to date)
```

## Not done / out of scope

- **`docs/ops/windows-host.md` 5장 체크리스트 자체는 실행하지 않았다**(재부팅·자동 로그온·sleep·GPU reset·remote-session·자동 업데이트). 스펙 §11이 "72시간 soak 전에 시험한다"고 정한 **사용자 실행 항목**이며, 자동 로그온·전원 정책·원격 접속 방식은 호스트 소유자의 결정이다(런북 2.5(6)). 이 PR은 절차·확인 방법·통과 기준을 고정했다.
- **실제 OBS 기동·실제 방송 경로 스모크 실행하지 않았음**: `obs.process.enabled` 기본 false, OBS WebSocket 서버 활성화는 사용자 작업(E-3), 버전 고정은 E-2 대기. `ObsControl`의 새 명령 4개는 가짜 obs-websocket v5 서버(wire protocol 수준)에 대해 테스트했다.
- **자동시작을 켜 두지 않았다**: 코디네이터 승인 조건 4. 등록은 사용자가 `Register-VerticalLive.ps1`로 한다.
- **OBS 32의 safe-mode 프롬프트를 우회하지 않았다**: `--disable-shutdown-check`가 32.0.0에서 제거됐고 대체 공식 수단이 없다. 문서에 위험과 선택지 3개를 적었고(`windows-host.md` 5.7), 스크립트는 문서에 없는 플래그를 붙이거나 `.sentinel`을 지우지 않는다.
- **off-host 아카이브 업로드·보관은 범위 밖**(§9.1의 off-host availability 기록은 T12 dead-man). 이 PR은 로컬 rolling archive의 삭제 규칙만 다룬다.
- 렌더러 정적 서빙에 HTTP 캐시·압축·HTTP/2 같은 것은 넣지 않았다. loopback에서 한 브라우저에게 주는 페이지다.

## Follow-ups

- **Gate 0/2**: `archive.*` 4개 값과 sweep 주기를 승인값으로 교체(A-15). `docs/ops/gate0-checklist.md`(T16)에 항목으로 넣을 것.
- **E-2와 함께**: OBS 32 safe-mode 선택지(31.1.2 고정 / 사람 개입 / `.sentinel` 삭제) 결정. 결정되면 `windows-host.md` 5.7과 `obs-setup.md` §1을 같이 고친다.
- **T15**: disk-full·host crash fault 행에서 아카이브 스위퍼와 자동시작 복귀를 주입 대상으로 쓸 수 있다(`runArchiveSweep`은 fs 포트를 주입받는다).
- **T16**: `docs/ops/runbook-operations.md`에서 시작·정지 절차를 이 문서로 연결.
- 아카이브 스위퍼는 지금 스케줄된 task로만 돈다. 서버 프로세스 안에서도 돌릴 필요가 관측되면 `RetentionScheduler`(T13)와 같은 형태로 추가할 수 있다 — 지금은 서버가 죽어 있을 때도 도는 편이 낫다고 판단했다.
- 여러 볼륨에 걸친 루트: 현재는 가장 빡빡한 여유공간 값을 쓴다(같은 볼륨 가정). 실제로 분리하면 볼륨별 계획으로 나눠야 한다.

## Review round 1

리뷰: PR #17 코멘트 `#4953245845`(verdict `request_changes`). 리뷰어는 게이트 5개를 직접 실행해 전부 pass를 확인했고, 합격 기준 2(등록·해제 사이클)도 독립적으로 재현했다. 합격 기준 1은 **삭제 경계가 실제로는 뚫린다**는 이유로 unmet 판정.

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] `apps/server/src/ops/archive/sweep.ts:222` — `listFiles()`가 순회 **내부**의 심볼릭 링크만 걸러서, 설정된 root 자체가 junction이면 대상 파일을 lexical link 경로 아래로 보고하고 `--apply`가 그것을 지운다. 리뷰어 재현: dry run이 `configured-root\victim.mkv` 1개를 선택했고 apply 후 `outsideVictimExistsAfterApply=false` | **고침 `20bfffc`.** 판정을 전부 **정규 경로**로 옮겼다. (1) `ArchiveFsPort`에 `isLink()`·`realPath()` 추가, `lstat`을 못 읽으면 **링크로 간주**(답을 못 하는 검사는 허용이 아니라 거부). (2) root가 reparse point면 스캔하지 않고 `REFUSED (reparse_point)`로 보고 — 링크가 가리키는 곳은 config로 검토할 수 없으므로 운영자가 승인한 삭제가 아니다. 정규 경로를 못 읽는 root는 `unresolvable`. (3) 항목은 `realpath` 후 정규 root와 비교하고, **삭제 직전에 같은 검사를 다시** 한다(스캔↔삭제 사이 교체 = TOCTOU) — 실패 시 삭제 대신 `path_escaped_root`로 보고. (4) 삭제·보고 경로는 검사한 정규 경로 그 자체. (5) refused root는 CLI exit 1. **테스트**: `sweep.test.ts`의 `runArchiveSweep against real links (review round 1, B1)` 3건이 `nodeArchiveFs`로 실제 junction/symlink를 만들어 검증하고(리뷰어가 지적한 fake `../` 케이스와 별개), `nodeArchiveFs`가 junction을 링크로 보고하는지도 확인한다. TOCTOU·unresolvable·정규경로 이탈은 주입 fs로 4건. 리뷰어 시나리오 실측 재현은 아래 Result 4-1 |
| [major] `ops/windows/Start-VerticalLive.ps1:120` — raw `config/default.json`을 읽어 `VL_OBS_PROCESS_ENABLED`·`VL_RENDERER_STATIC_PORT/HOST`·`VL_OBS_URL`을 무시. `VL_OBS_PROCESS_ENABLED=true`로도 "obs.process.enabled is false"를 찍고 exit 0 | **고침 `2bbda3b`.** PowerShell에서 우선순위 규칙을 재구현하지 않고, 서버의 로더가 해석한 값을 받는다: 새 `apps/server/src/ops/ops-config.ts`(`describeOpsConfig`)와 bin `dist/bin/ops-config.js`가 `loadRendererStaticConfig`·`loadObsConfig`·`loadArchiveConfig`·`resolvePort`로 한 JSON을 만들고, 스크립트는 그것만 쓴다(자식 프로세스가 env를 상속하므로 같은 값을 본다). 시작 전에 `resolved config: …` 한 줄로 남기고, `repoRoot`가 스크립트의 저장소와 다르면 즉시 실패한다. **테스트** `ops-config.test.ts` 7건(각 env override + 비-loopback 거부). 실측은 Result 4-2 |
| [major] `ops/windows/Start-VerticalLive.ps1:108`(렌더러는 97) — 열린 TCP 포트를 준비 완료로 보고 HTTP probe를 건너뛴다. 리뷰어가 `VL_PORT=18787`에 TCP 전용 리스너를 두자 `server already listening` 후 `start sequence complete`, exit 0 | **고침 `2bbda3b`.** 준비 판정을 프로토콜 응답으로 바꿨다: 렌더러 **HTTP 200**, 서버 **`/health` 200 + 건강 문서(`status` 필드)**, OBS는 4455를 **설정된 OBS 실행 파일이** 잡고 있을 때만. 게다가 이미 응답하는 포트라도 `Get-VLPortOwner`(Get-NetTCPConnection→Win32_Process, netstat fallback)로 **소유 프로세스의 명령행에 이 저장소 경로가 있을 때만** 채택하고, 아니면 소유 PID를 적고 실패한다 — 다른 worktree의 스택을 우리 것으로 착각하는 것이 이 확인이 막는 일이다. 명령행을 못 읽으면 "우리 것 아님"으로 본다. 실측은 Result 4-3(TCP 전용 리스너, 외부 200 응답 리스너 둘 다 거부) |
| [minor] 티켓 68행 아카이브 테스트 수 60 → 실제 47 | **고침(이 커밋).** 합격 기준 표를 `apps/server/src/ops/archive` 4 파일 **56 tests**(round 2에서 링크 테스트 9건 추가), `apps/server/src/ops` 전체 **76 tests**로 고쳤고, 이전 "60"이 archive가 아니라 ops 전체 수였다는 것도 적었다 |

### Result 4 — round 2 재현·검증 (모두 이 호스트에서 실행)

**4-1. B1: 리뷰어의 junction root 시나리오** (`New-Item -ItemType Junction`으로 `configured-root` → `outside`, `outside\victim.mkv`는 30일 전 mtime)

```text
$ node apps/server/dist/bin/archive.js --config <tmp>.json
root recordings: REFUSED (reparse_point) C:\...\vl-b1-repro\configured-root
scanned 0 file(s), 0.0 MiB; 0 inside the write grace window; free 58808.6 MiB
no files selected for deletion
exit=1
$ node apps/server/dist/bin/archive.js --config <tmp>.json --apply
root recordings: REFUSED (reparse_point) C:\...\vl-b1-repro\configured-root
no files selected for deletion
exit=1
outsideVictimExistsAfterApply=True      # 리뷰어 재현에서는 False였다
```

**4-2. M1: env override가 실제로 반영된다**

```text
$ powershell -File ops\windows\Start-VerticalLive.ps1 -WhatIf          # 기본값
resolved config: renderer=http://127.0.0.1:5173/ server=http://127.0.0.1:8787/health obs=ws://127.0.0.1:4455 obsProcessEnabled=False

$ $env:VL_OBS_PROCESS_ENABLED='true'; $env:VL_RENDERER_STATIC_PORT='5999'; $env:VL_PORT='18787'; $env:VL_OBS_URL='ws://127.0.0.1:4499'
$ powershell -File ops\windows\Start-VerticalLive.ps1 -WhatIf
resolved config: renderer=http://127.0.0.1:5999/ server=http://127.0.0.1:18787/health obs=ws://127.0.0.1:4499 obsProcessEnabled=True
What if: would start renderer-static and wait for http://127.0.0.1:5999/ (HTTP 200)
What if: would start server and wait for http://127.0.0.1:18787/health (health document)
What if: would launch OBS and wait for obs-websocket :4499 owned by obs64.exe
```

**4-3. M2: 열린 포트는 준비가 아니고, 남의 프로세스는 채택하지 않는다**

```text
# (a) TCP 전용 리스너를 VL_PORT=18787에 두고 실행 — 리뷰어 재현과 같은 조건
[error] server: port 18787 is held by pid 38320 (powershell) and does not answer http://127.0.0.1:18787/health (health document)
[error] start sequence incomplete: server        EXIT=1

# (b) 저장소 밖에서 200을 돌려주는 정적 서버를 렌더러 포트에 두고 실행
[error] renderer-static: port 5899 answers but belongs to pid 11276 (node) outside C:\...\t17-windows-ops; refusing to adopt it
[error] start sequence incomplete: renderer-static, server        EXIT=1

# (c) 실제 기동: 우리 렌더러는 200으로 준비 판정되고, 재실행 시 우리 것이므로 채택된다
[info] start renderer-static: ... serve-renderer.js
[info] ready: http://127.0.0.1:5899/ (HTTP 200)
[info] renderer-static already running and ready (pid 36836, http://127.0.0.1:5899/ (HTTP 200))
# 같은 실행에서 서버는 vault에 server.rendererToken/adminToken이 없어 기동 직후 종료 →
[error] timed out after 12s waiting for: http://127.0.0.1:18899/health (health document)
[error] start sequence incomplete: server        EXIT=1     # 응답 없는 컴포넌트를 준비로 치지 않는다
```

(c)에서 서버가 뜨지 않는 것은 이 호스트의 vault가 비어 있기 때문이다(`secrets list` → 8개 전부 `missing`). 비밀정보를 만들지 않았고, 그 상태에서도 **거짓 성공이 나지 않는다**는 것이 여기서 확인된 것이다. 실행에 쓴 임시 리스너·fixture·프로세스는 모두 정리했고(포트 5173/8787/5899/18899 free, 잔여 node 프로세스 0), 등록된 scheduled task도 없다.

### Gates (round 2, 재실행)

```text
$ npm run format:check  -> All matched files use Prettier code style!
$ npm run lint          -> eslint 통과, check-no-legacy-imports: ok (0), check-install-scripts: ok (4 reviewed)
$ npm run typecheck     -> tsc --build 통과(출력 없음)
$ npm run test          -> Test Files 130 passed (130) / Tests 1818 passed | 1 skipped (1819)
$ npm run build         -> 전 워크스페이스 성공
```

CI는 여전히 E-5(결제 차단)로 실행되지 않는다.
