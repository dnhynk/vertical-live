# Windows 호스트 운영 (T17)

이 문서는 1차 호스트(BOARD D-2, 이 Windows 11 PC)가 **사람 없이** 방송 스택을 올리고 유지하기 위한 절차다. 근거는 스펙 §9.1(자동화 경계·용량 제한 rolling archive), §10.2(단일 supervised host·비밀정보), §11("72시간 soak 전에 hosting OS와 OBS interactive-session 실행 방식을 선택하고 reboot, 자동 시작, sleep, GPU reset, remote-session 종료, 자동 업데이트를 시험한다", "rolling archive의 최대 용량·최소 여유공간·보존·자동 삭제 규칙도 같은 시점에 승인한다").

코드는 `ops/windows/`(스크립트·Task Scheduler XML)와 `apps/server/src/ops/`(정적 서빙·아카이브 스위퍼)에 있다.

## 0. 이 문서가 다루지 않는 것

- supervisor 상태기계·건강 신호·kill switch·알림 → `docs/ops/supervisor.md`(T12)
- OBS 프로파일·씬·WebSocket 서버 켜기·인코더 값 → `docs/ops/obs-setup.md`(T2)
- OAuth·vault·비밀정보 등록 → `docs/ops/youtube-auth-setup.md`(T3)
- fault matrix·72시간 soak 실행 → T15
- **합격선 숫자.** 이 문서의 모든 수치는 `provisional`이며 Gate 0/2 승인값으로 교체된다(BOARD A-15).

## 1. 실행 계정과 interactive session 전제

**두 scheduled task 모두 "사용자가 로그온했을 때만" 실행된다**(`LogonType InteractiveToken`, `schtasks /it`). 이유는 하나다: OBS는 GPU가 붙은 **대화형 데스크톱 세션**에서 합성·인코딩한다. "사용자의 로그온 여부와 관계없이 실행"을 고르면 task는 session 0에서 돌고, 거기에는 OBS가 쓸 데스크톱이 없다.

여기서 따라오는 전제를 그대로 적는다.

| 전제 | 뜻 | 확인 |
|---|---|---|
| 전용 로컬 계정 1개 | 방송 스택은 이 계정의 세션에서만 돈다. 다른 사용자로 전환하거나 로그오프하면 스택이 죽는다 | `whoami` |
| 자동 로그온 | 재부팅 후 사람이 없어도 세션이 만들어져야 한다(3장) | 재부팅 후 로그온 화면에 멈추지 않는가 |
| 세션 유지 | 화면 잠금은 세션을 유지한다. **로그오프·사용자 전환·RDP 로그오프는 세션을 끝낸다** | 5장 remote-session 항목 |
| 관리자 권한 불필요 | task는 `LeastPrivilege`. 등록·해제도 현재 사용자 권한으로 된다 | `schtasks /Query /TN \VerticalLive\vl-autostart /V /FO LIST` 의 `Logon Mode` |
| 자동 로그온의 대가 | 계정 자격증명이 호스트에 저장된다. 물리적으로 접근 가능한 PC라면 그 자체가 위험이다 | 3장 |

## 2. 자동시작 등록·해제

```powershell
# 1) 먼저 빌드 (로그온 시점에 컴파일하지 않는다)
npm ci
npm run build

# 2) 무엇이 등록될지 먼저 본다 — dry run, 아무것도 바꾸지 않는다
powershell -ExecutionPolicy Bypass -File ops\windows\Register-VerticalLive.ps1 -WhatIf

# 3) 등록
powershell -ExecutionPolicy Bypass -File ops\windows\Register-VerticalLive.ps1

# 4) 해제 (역시 -WhatIf로 먼저 볼 수 있다)
powershell -ExecutionPolicy Bypass -File ops\windows\Unregister-VerticalLive.ps1
```

등록되는 task 2개:

| task | 트리거 | 하는 일 |
|---|---|---|
| `\VerticalLive\vl-autostart` | 로그온 + 30초 지연 | `ops\windows\Start-VerticalLive.ps1` (3장) |
| `\VerticalLive\vl-archive-sweep` | 로그온 + 5분 지연, 이후 1시간마다 반복 | `node apps\server\dist\bin\archive.js --apply` (4장) |

옵션: `-RepoRoot`(다른 체크아웃), `-Account DOMAIN\user`(다른 계정 — 그 계정으로 로그온해 있어야 실행된다), `-NodeExe`(PATH에 node가 없을 때), `-ArchiveInterval PT30M`, `-SkipArchiveTask`.

- 정의는 `ops/windows/tasks/*.xml`이고 스크립트는 `{{USER_ID}}`·`{{REPO_ROOT}}`·`{{NODE_EXE}}`·`{{INTERVAL}}`만 치환한다. 등록은 `schtasks /Create /XML`로 한다([Microsoft Learn, schtasks create](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create), 2026-08-17 확인).
- 등록 후 스크립트가 `schtasks /Query /V /FO LIST`를 그대로 출력한다. `Logon Mode: Interactive only`가 1장의 전제가 실제로 적용됐다는 증거다.
- 해제는 삭제 후 다시 `/Query`해서 **없어졌음을 확인**한다. 삭제만 하고 성공이라고 쓰지 않는다.
- 해제는 **실행 중인 프로세스를 멈추지 않는다.** 멈추는 것은 kill switch다(`npm run kill -w @vl/server`, `docs/ops/supervisor.md` 2장).

## 3. 시작 순서와 준비 대기

`ops\windows\Start-VerticalLive.ps1`(로그온 task가 실행, 손으로도 실행 가능):

| # | 대상 | 시작 명령 | 준비 신호 | 기본 대기 |
|---|---|---|---|---|
| 1 | 렌더러 정적 서빙 | `node apps\server\dist\bin\serve-renderer.js` | `http://127.0.0.1:5173/`가 **HTTP 200** | 60s |
| 2 | 서버 | `node apps\server\dist\main.js` | `/health`가 **200 + 건강 문서**(`status` 필드) | 120s |
| 3 | OBS | `node apps\server\dist\bin\obs-launch.js` | `127.0.0.1:4455` 포트를 **`obs64.exe`가** 점유 | 120s |

- **순서의 이유**: OBS Browser Source가 열릴 때 페이지가 있어야 하고(1), 페이지가 열리자마자 `/ws/renderer`에 붙으므로 서버가 떠 있어야 하며(2), 서버가 시작 순서에서 OBS에 렌더러 토큰과 스트림 키를 주입하므로 OBS는 마지막이다(3, BOARD A-16).
- **준비 신호를 기다리지 sleep하지 않는다.** 각 단계는 위 신호가 올 때까지 폴링하고, 시간이 지나면 그 단계를 실패로 기록하고 exit code 1로 끝난다.
- **열린 포트는 준비가 아니다**(리뷰 round 1 M2). 포트만 열려 있고 프로토콜 응답이 없으면 준비로 치지 않는다. 그리고 **이미 응답하는 포트라도 그 프로세스가 이 저장소에서 시작된 것일 때만** 그대로 쓴다(소유 프로세스의 명령행에 이 저장소 경로가 있는지 확인). 다른 worktree나 무관한 프로세스가 같은 loopback 포트를 잡고 있으면 그 단계는 **소유 PID를 적고 실패**한다 — 남의 스택을 우리 것으로 착각해 OBS를 남의 렌더러에 붙이는 것이 이 확인이 막는 일이다.
- **이미 떠 있고 우리 것이면 건너뛴다.** 로그는 `already running and ready (pid …)`. 두 번 로그온해도 스택이 두 벌 뜨지 않는다(task도 `MultipleInstancesPolicy=IgnoreNew`).
- **설정은 서버의 로더에서 온다**(리뷰 round 1 M1). 스크립트는 `config/default.json`을 직접 읽지 않고 `node apps\server\dist\bin\ops-config.js`가 출력한 해석 결과를 쓴다. 따라서 `VL_PORT`, `VL_RENDERER_STATIC_PORT`/`VL_RENDERER_STATIC_HOST`, `VL_OBS_URL`, `VL_OBS_PROCESS_ENABLED`, `VL_OBS_EXECUTABLE`이 서버에서와 **같은 뜻**을 가진다. 해석된 값은 시작 전에 `resolved config: …` 한 줄로 남는다.
- 로그: `data\ops\logs\autostart-<YYYYMMDD>.log`(순서·준비·실패), `renderer-static-*.log`, `server-*.log`(각 프로세스의 stdout/stderr).
- dry run: `-WhatIf`. 해석된 설정과 무엇을 시작할지만 출력하고 아무것도 시작하지 않으며 로그 파일도 쓰지 않는다.
- 옵션: `-SkipObs`, `-RendererTimeoutSec`, `-ServerTimeoutSec`, `-ObsTimeoutSec`, `-NodeExe`, `-RepoRoot`.
- 빌드 산출물(`dist\main.js`, `dist\bin\serve-renderer.js`, `dist\bin\ops-config.js`, `dist\bin\obs-launch.js`, `apps\renderer\dist\index.html`)이 없으면 **아무것도 시작하지 않고** 실패한다. 로그온 시점은 컴파일할 때가 아니다.

### OBS 실행기

`config/default.json`의 `obs.process`가 정의한다.

```json
"process": {
  "enabled": false,
  "executablePath": "C:\\Program Files\\obs-studio\\bin\\64bit\\obs64.exe",
  "profile": "vertical-live",
  "sceneCollection": "vertical-live",
  "extraArgs": ["--disable-updater", "--disable-missing-files-check"],
  "sentinelDir": ""
}
```

- 기본값이 `enabled: false`인 이유는 실행 파일 경로가 호스트마다 다르기 때문이다. 켜기 전에 경로를 확인한다(`VL_OBS_PROCESS_ENABLED=true`, `VL_OBS_EXECUTABLE=...`로도 덮어쓸 수 있다).
- 인자는 **공식 launch parameter만** 쓴다([OBS Knowledge Base, Launch Parameters](https://obsproject.com/kb/launch-parameters), 2026-08-17 확인). `--disable-updater`는 업데이트 대화상자를, `--disable-missing-files-check`는 누락 파일 대화상자를 막는다 — 둘 다 무인 시작을 붙잡는 모달이다.
- **obs-websocket 비밀번호는 명령행에 넣지 않는다.** 명령행은 같은 호스트의 다른 프로세스가 읽을 수 있다(스펙 §10.2). 비밀번호는 vault에 있고 서버가 접속할 때 쓴다.
- **실행 직전에 OBS의 크래시 표식(`.sentinel`)을 비운다**(BOARD D-7, 5.7). `sentinelDir`가 비어 있으면 `%APPDATA%\obs-studio\.sentinel`로 파생하고 `VL_OBS_SENTINEL_DIR`로 덮어쓸 수 있다. 그 경로가 junction/심볼릭 링크면 아무것도 지우지 않고 거부한다(5.7). 지운 개수는 자동시작 로그 한 줄과 `/health`의 `obs-process` `lastNote`에 남으며, 지우지 못해도 기동은 계속한다.
- 같은 실행기를 supervisor의 `obs-process` 복구 동작도 쓴다(`docs/ops/supervisor.md` 3장). 실행기는 **이미 OBS가 떠 있으면 거부한다**: 두 번째 인스턴스는 "이미 실행 중" 대화상자만 띄우고 응답 없는 OBS를 되살리지 못한다. 그 상황은 사람이 처리한다(7장).
- OBS는 자기 `bin\64bit` 디렉터리를 작업 디렉터리로 요구하므로 실행기가 그렇게 띄운다.

## 4. 로컬 rolling archive

스펙 §9.1이 요구하는 "용량 제한이 있는 로컬 rolling archive"의 삭제 규칙이다. **숫자는 전부 provisional**이며 §11에 따라 72시간 soak 전에 승인된다(BOARD A-15).

| 규칙 | config 키 | 기본값(provisional) | 뜻 |
|---|---|---|---|
| 보존일 | `archive.retentionDays` | 7 | 이보다 오래된 파일은 공간이 남아도 지운다 |
| 최대 용량 | `archive.maxTotalBytes` | 200 GiB | 아카이브 자체가 차지할 수 있는 상한 |
| 최소 여유공간 | `archive.minFreeBytes` | 50 GiB | 볼륨에 남겨야 할 여유. 미달이면 오래된 것부터 지운다 |
| 쓰기 유예 | `archive.activeFileGraceMs` | 600000 (10분) | 이 시간 안에 수정된 파일은 **후보에서 제외**(녹화 중일 수 있다) |
| 대상 | `archive.roots[]` | `data/archive/recordings`(.mkv .mp4 .flv .ts .mov), `data/diagnostics/screenshots`(.jpg .jpeg .png), `data/ops/logs`(.log) | 이 디렉터리 **안에서 이 확장자만** 지운다 |

적용 순서는 보존일 → 최대 용량 → 최소 여유공간이고, 각 단계에서 **오래된 것부터** 고른다. 리포트는 파일마다 어느 규칙이 지목했는지 적는다.

```powershell
# dry run (기본) — 무엇을 지울지만 출력한다
npm run archive -w @vl/server

# 실제 삭제
npm run archive -w @vl/server -- --apply

# 기계용
npm run archive -w @vl/server -- --json
```

`--apply` 없이는 절대 지우지 않는다. 스케줄된 task만 `--apply`를 붙인다.

지우지 않는 것:

- 루트 밖의 경로. 판정은 **정규 경로(realpath)로만** 한다(리뷰 round 1 B1): 심볼릭 링크·junction·`..`로 빠져나가는 항목은 후보에서 제거되고, **삭제 직전에 한 번 더** 같은 검사를 한다(스캔과 삭제 사이에 파일이 링크로 바뀔 수 있다).
- **루트 자체가 junction/심볼릭 링크면 그 루트 전체를 거부한다.** 리포트에 `root <이름>: REFUSED (reparse_point)`로 남기고 exit code 1로 끝난다. 링크가 가리키는 곳은 config를 읽어서는 알 수 없으므로, 그 안을 지우는 것은 운영자가 승인한 삭제가 아니다. 정규 경로를 읽을 수 없는 루트(`unresolvable`)도 같다.
- 루트가 소유하지 않은 확장자(예: 같은 폴더의 `notes.txt`)
- 쓰기 유예 안에 있는 파일(진행 중인 녹화)
- 루트가 아직 없으면 아무것도. "없음"은 실패가 아니다 — **V1은 녹화하지 않는다**(`ops/obs/profiles/vertical-live/basic.ini`의 `RecEncoder=none`).

따라서 `archive.roots[].path`에는 **실제 디렉터리**를 적는다. 다른 볼륨에 두고 싶으면 junction을 만들지 말고 그 볼륨의 경로를 그대로 적는다.

규칙을 다 적용해도 상한을 못 맞추면(예: 다른 프로그램이 디스크를 채웠다) 리포트에 `WARNING: <rule> is still unmet`으로 남긴다. 아카이브가 자기 것도 아닌 공간을 되찾을 수는 없고, 조용히 성공이라고 쓰는 편이 더 나쁘다. 볼륨 용량을 읽을 수 없으면 `free unknown`으로 적고 **여유공간 규칙을 적용하지 않는다**(모름은 0이 아니다).

### 녹화를 켜려면

V1 기본은 녹화 없음이다. Gate 2 실험 등으로 로컬 녹화가 필요하면 OBS **설정 → 출력 → 녹화**에서 녹화 경로를 `<repo>\data\archive\recordings`로 두고 인코더를 지정한다. 그때부터 위 규칙이 그 파일들에 적용된다. off-host 보관·가용성 기록은 dead-man monitor 쪽이다(§9.4(8), `docs/ops/supervisor.md` 6장).

## 5. 호스트 체크리스트 (사용자 실행, 스펙 §11)

§11이 "72시간 soak 전에 시험한다"고 못박은 6가지다. **각 항목은 설정과 확인이 짝이다.** 확인하지 않은 항목은 "확인 필요"로 남긴다.

### 5.1 재부팅

1. `powershell -ExecutionPolicy Bypass -File ops\windows\Register-VerticalLive.ps1`로 등록한다.
2. 재부팅한다.
3. 사람이 아무것도 하지 않은 상태에서 확인한다: `data\ops\logs\autostart-*.log`에 `start sequence complete`, `curl http://127.0.0.1:8787/health`, OBS 창 존재.
4. 실패하면 `schtasks /Query /TN \VerticalLive\vl-autostart /V /FO LIST`의 `Last Result`(0이 아니면 시작 자체가 실패)와 위 로그를 본다.

### 5.2 자동 로그온

로그온 트리거는 **로그온이 일어나야** 발화한다. 재부팅이 로그온 화면에서 멈추면 자동 운영은 거기서 끝난다.

- Microsoft 문서: [Configure Windows to automate logon](https://learn.microsoft.com/en-us/troubleshoot/windows-server/user-profiles-and-logon/turn-on-automatic-logon)(2026-08-17 확인). 레지스트리 `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon`의 `AutoAdminLogon`/`DefaultUserName`/`DefaultPassword`.
- **`DefaultPassword`는 평문이다.** 같은 문서가 권하는 대로 Sysinternals [Autologon](https://learn.microsoft.com/en-us/sysinternals/downloads/autologon)을 쓰면 LSA secret으로 저장된다. 어느 쪽이든 **물리적으로 접근 가능한 PC에서는 그 계정이 열려 있다는 뜻**이다. 방송 계정을 전용 저권한 계정으로 두는 이유가 이것이다.
- 확인: 재부팅 → 사람 입력 없이 데스크톱까지 도달 → 5.1의 확인이 통과.
- BitLocker가 켜져 있으면 부팅 시 PIN을 물을 수 있다. 그러면 무인 재부팅은 성립하지 않는다 — 승인 필요한 정책 결정이므로 Gate 0/2에 올린다.

### 5.3 sleep · 화면

```powershell
powercfg /change standby-timeout-ac 0     # 절전 안 함
powercfg /change hibernate-timeout-ac 0   # 최대 절전 안 함
powercfg /change disk-timeout-ac 0
powercfg /change monitor-timeout-ac 0     # 모니터도 끄지 않는다(아래 주의)
powercfg /query SCHEME_CURRENT            # 확인
```

([powercfg 명령줄 옵션, Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options), 2026-08-17 확인.)

- 확인: 30분 이상 조작 없이 두고 `/health`의 renderer frame counter와 OBS 출력 바이트가 계속 증가하는가.
- **모니터 절전·화면 잠금은 세션을 끝내지 않지만**, 이 호스트에서 실제로 프레임이 유지되는지는 GPU·드라이버에 달렸다. 잠근 채 최소 10분 두고 frame counter를 확인한다. **확인 전에는 "괜찮다"고 쓰지 않는다.**
- 절전에서 깨어난 뒤 OBS·인코더가 정상인지도 같은 방법으로 본다(권장: 절전을 아예 끈다).

### 5.4 GPU reset

Windows는 GPU가 응답하지 않으면 드라이버를 재시작한다(TDR). 그때 OBS는 그래픽 디바이스를 잃을 수 있고, 렌더러는 WebGL context를 잃는다(T5가 복구를 구현했고 §9.4(4)가 신호를 요구한다).

- 관측: 이벤트 뷰어 시스템 로그의 `Display` 원본 "디스플레이 드라이버가 응답하지 않아 복구되었습니다"(Event ID 4101). `Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='Display'} -MaxEvents 20`
- 서버 쪽 관측: `/health`의 renderer family(frame counter 정지, `webglContextLost`)와 OBS `obs_output` 신호.
- 필요하면 TDR 지연을 늘리는 선택지가 있다: `HKLM\SYSTEM\CurrentControlSet\Control\GraphicsDrivers`의 `TdrDelay`([TDR registry keys, Microsoft Learn](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/tdr-registry-keys), 2026-08-17 확인). **기본값을 바꾸는 것은 진단을 미루는 선택**이므로, 재현되는 TDR을 먼저 기록하고 Gate 2에서 판단한다.
- 시험: 드라이버를 강제로 재시작(`Ctrl+Shift+Win+B`)하고 60초 안에 프레임이 돌아오는지, 돌아오지 않으면 supervisor가 어떤 상태로 가는지 기록한다.

### 5.5 remote-session 종료

원격으로 붙었다 끊는 것이 방송을 끊으면 무인 운영이 아니다.

- **RDP는 콘솔 세션을 밀어낸다.** RDP로 접속하면 기존 콘솔 세션이 연결 해제되고, RDP를 끊으면 세션이 어떤 데스크톱에도 붙지 않은 상태로 남아 GPU 가속 합성이 멈출 수 있다.
- 그래서 원격 접속은 **콘솔 세션에 그대로 붙는 도구**(VNC 계열 등)를 쓰는 것을 기본으로 한다. RDP를 써야 한다면 끊은 뒤 세션을 콘솔로 되돌린다: `query session` → `tscon <세션ID> /dest:console`([tscon, Microsoft Learn](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tscon), 2026-08-17 확인).
- 시험: 원격 접속 → 5분 방송 관찰 → 연결 종료 → 10분 뒤 `/health` frame counter와 OBS 출력이 계속 증가하는가. 멈춘다면 그 원격 도구는 이 호스트에서 쓰지 않는다.
- **로그오프·사용자 전환·`shutdown /l`은 스택을 죽인다.** 잠금(`Win+L`)만 쓴다.

### 5.6 자동 업데이트

| 대상 | 위험 | 조치 |
|---|---|---|
| Windows Update | 예고 없는 재부팅 | 활성 시간(Active hours)을 설정하고, 재부팅 후 5.1·5.2로 스택이 스스로 복귀하는지 확인한다. **재부팅을 막는 것보다 재부팅에서 회복하는 것이 목표다.** |
| OBS 내장 업데이터 | 시작 시 업데이트 대화상자 | 실행기가 `--disable-updater`로 띄운다(3장). 버전은 **32.0.2 / obs-websocket 5.6.3으로 고정**(BOARD D-6, 2026-08-18 사용자 승인, `docs/ops/obs-setup.md` §1) |
| Node.js / npm | 런타임 교체 | 자동 업데이트하지 않는다. 올릴 때는 손으로, `npm ci && npm run build` 뒤 5.1을 다시 시험한다 |
| GPU 드라이버 | TDR 동작 변화 | 올린 뒤 5.4를 다시 시험한다 |

시험: 업데이트를 하나 적용해 재부팅시키고, 사람 손 없이 방송이 돌아오는지 확인한다. 이것이 §11이 요구하는 "자동 업데이트 시험"이다.

### 5.7 OBS 32의 safe-mode 프롬프트 (BOARD D-7, 2026-08-18 채택)

**사실**: OBS는 비정상 종료를 감지하면 시작할 때 "Safe Mode로 시작할까요?" 대화상자를 띄운다. Safe Mode는 서드파티 플러그인과 **obs-websocket을 비활성화**한다([Add Safe Mode, obsproject/obs-studio#8455](https://github.com/obsproject/obs-studio/pull/8455), 2026-08-17 확인) — 즉 우리 제어 경로 전체가 죽는다. 이 대화상자를 끄던 `--disable-shutdown-check`는 **OBS 32.0.0에서 제거됐다**([issue #12650, closed as not planned](https://github.com/obsproject/obs-studio/issues/12650); [OBS 포럼 스레드](https://obsproject.com/forum/threads/obs-version-32-0-0-removed-disable-shutdown-check.190590/), 둘 다 2026-08-17 확인). 우리 고정 버전이 32.0.2다(D-6).

**결정(D-7, 사용자 2026-08-18)**: 우리가 OBS를 띄우는 경로가 **실행 직전에 `%APPDATA%\obs-studio\.sentinel` 안의 파일을 지운다.** 디렉터리 자체는 남긴다.

- **한 곳에서만 한다**: `ObsProcessLauncher.launch()`. 자동시작 3단계(`obs-launch`)와 supervisor의 `obs-process` 재시작이 같은 실행기를 쓰므로 두 경로가 함께 닫힌다. 세 거부(미설정·실행 파일 없음·이미 실행 중)를 모두 통과한 **뒤** spawn 직전에만 지운다 — 일어나지도 않을 기동을 위해 OBS의 파일을 건드리지 않는다.
- **설정**: `obs.process.sentinelDir`. 비워 두면 `%APPDATA%`에서 파생하고, 포터블 설치 등은 `VL_OBS_SENTINEL_DIR`로 지정한다. `APPDATA`가 없는 호스트(CI·POSIX)에서는 지울 것이 없다고 보고 그대로 진행한다.
- **승인한 디렉터리 안에서만 지운다**(리뷰 round 1, B1). `sentinelDir` **자체가 junction/심볼릭 링크(reparse point)면 아무것도 지우지 않고 거부한다** — 링크가 오늘 가리키는 곳은 운영자가 config에서 검토한 디렉터리가 아니고, 그 안의 파일은 OBS의 크래시 표식이 아니다. T17 아카이브가 루트에 대해 하는 거부(`REFUSED (reparse_point)`, 4장)와 같은 판단이다. 목록에 오른 항목도 **삭제 직전에** 다시 확인한다(실경로가 그 디렉터리 바로 안에 있는 일반 파일인가) — 목록과 삭제 사이에 링크로 바뀔 수 있기 때문이다. 하위 디렉터리와 링크 항목은 처음부터 대상이 아니다.
- **남는 기록**: 지운 게 있을 때만 로그 `obs.sentinel_cleared`(개수·경로만), 실패는 `obs.sentinel_clear_failed`(warn). `/health`의 `components[]`에서 `obs-process`의 `lastNote`가 `sentinel_cleared=<n>`이다. 자동시작 경로는 `obs launched: pid … (crash sentinels cleared: n)` 한 줄로 `data\ops\logs\autostart-*.log`에 남는다.
- **사유는 값이 아니라 토큰이다**(리뷰 round 1, m1). `sentinel_dir_reparse_point`(위의 거부), `sentinel_entry_escaped_dir`(삭제 직전 확인 실패), 그 외에는 errno 코드(`EACCES`, `EPERM`, …) 또는 `unknown`. Node의 오류 메시지는 실패한 **파일 이름을 포함**하는데 이 값은 로그와 `/health`로 흘러가므로, 원인은 남기고 파일 이름은 남기지 않는다.
- **실패해도 기동은 계속한다.** 파일이 잠겨 있거나, 디렉터리를 읽지 못하거나, 위의 거부에 걸려도 warn만 남기고 OBS를 띄운다. 그때의 동작은 D-7 이전과 같다: 대화상자가 뜨고, 3단계가 obs-websocket 포트를 기다리다 타임아웃해 **실패로 기록**한다(조용히 성공하지 않는다).

**근거**

1. **Safe Mode가 지키려는 위험이 우리 위험이 아니다.** 우리는 서드파티 플러그인을 설치하지 않는다(스펙 §10.3, `docs/ops/obs-setup.md` §1). Safe Mode가 막아 주는 것은 플러그인 때문에 못 뜨는 OBS인데, 그 대가로 끄는 obs-websocket은 우리의 유일한 제어 경로다.
2. **크래시를 감추지 않는다.** 표식을 지워도 크래시 자체는 남는다. OBS가 계속 죽으면 `obs-process` 재시작 예산이 소진돼 fault matrix F-18대로 `safe_stopped` + 알림이 되고(`docs/ops/fault-matrix.md`), 매 기동 `sentinel_cleared`가 0보다 크다는 것 자체가 크래시 루프의 증거다. 크래시 로그(`%APPDATA%\obs-studio\crashes\`)도 그대로 쌓인다.
3. **무인성**: 정전·BSOD 뒤 사람이 대화상자를 눌러야 방송이 돌아오는 상태는 스펙 §11이 요구하는 "재부팅에서 스스로 회복"과 맞지 않는다.

**caveat — 공식 문서에 없는 방법이다.** `.sentinel` 삭제는 OBS Knowledge Base·릴리스 노트 어디에도 없다. 이 파일의 의미는 소스(PR #8455)와 이 호스트 관측으로만 확인했다. OBS가 이름·위치·의미를 바꾸면 이 조치는 **조용히 무력화되고**, 그때 동작은 위의 "실패해도 기동은 계속한다"와 같다(대화상자 → 3단계 타임아웃 → 실패 기록). 그래서 OBS를 올릴 때는 5.6 절차로 이 항목을 다시 시험한다.

**2026-08-18 관측(이 호스트, BOARD E-7)**: 사용자 기본 씬 컬렉션(WASAPI 마이크·데스크탑 오디오 포함)으로 OBS 32.0.2를 **정상 종료**시켰는데 종료 도중 크래시했다(`obs.dll!copy_audio_data` ← `win-wasapi`가 `obs-browser`의 `obs_module_unload`와 경합; `%APPDATA%\obs-studio\crashes\Crash 2026-08-18 13-58-03.txt`). `.sentinel\run_*`가 남았고, 그 파일을 지운 뒤 다시 띄우니 대화상자 없이 정상 기동해 `npm run obs:probe`가 통과했다. 즉 이 위험은 정전·BSOD에서만 오는 것이 아니라 **정상 종료 경로에서도** 온다.

## 6. 비밀정보 custody (BOARD A-16)

서버는 시작 순서에서 두 가지를 OBS에 **런타임 주입**한다. 운영자는 어느 것도 OBS UI에 입력하지 않는다.

| 값 | 정본 | 주입 | OBS가 남기는 곳 |
|---|---|---|---|
| `youtube.streamKey` | vault | `SetStreamServiceSettings` | `%APPDATA%\obs-studio\basic\profiles\vertical-live\service.json` |
| `server.rendererToken` | vault | `SetInputSettings`(Browser Source URL의 `?token=`) | `%APPDATA%\obs-studio\basic\scenes\vertical-live.json` |

정지할 때 둘 다 **다시 뺀다**:

- `safe_stopped`에 들어가면 서버가 자동으로 뺀다(`onSafeStop` → `clearStreamServiceKey()` + `clearRendererSourceToken()`).
- 그냥 프로세스를 내린 경우에는 OBS가 아직 떠 있을 때 다음을 실행한다.

```powershell
npm run obs:clear -w @vl/server   # 스트림 키·렌더러 토큰을 OBS에서 제거. 값은 출력되지 않는다
```

송출 중에는 거부한다(키를 뺀 채 다음 `StartStream`을 맞으면 조용히 실패하기 때문이다).

### 선택 강화: 디렉터리 ACL

OBS 프로파일·씬 디렉터리와 kill 플래그가 있는 `data\`는 방송 계정만 읽고 쓰면 충분하다. 기본 ACL은 사용자 프로필 아래라면 이미 그 계정과 관리자만 접근 가능하다. 더 조이려면(**사용자가 판단해 실행**):

```powershell
# 상속을 끊고 SYSTEM·Administrators·현재 사용자만 남긴다 (SID로 지정: 그룹 이름은 로케일에 따라 다르다)
icacls "$env:APPDATA\obs-studio\basic\profiles\vertical-live" /inheritance:r `
  /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*S-1-5-32-544:(OI)(CI)F" /grant:r "$env:USERNAME:(OI)(CI)F" /T

# 되돌리기
icacls "$env:APPDATA\obs-studio\basic\profiles\vertical-live" /reset /T
icacls "$env:APPDATA\obs-studio\basic\profiles\vertical-live" /inheritance:e
```

**주의**: ACL을 잘못 잡으면 OBS가 자기 프로파일을 못 읽어 시작하지 못한다. 적용 후 반드시 OBS를 재시작해 프로파일이 로드되는지 확인하고, 안 되면 위 `/reset`으로 되돌린다. 씬 디렉터리(`...\basic\scenes`)와 저장소의 `data\`에도 같은 방식이 적용된다.

## 7. 문제 해결

| 증상 | 먼저 볼 것 | 흔한 원인 |
|---|---|---|
| 재부팅 후 아무것도 안 뜬다 | `schtasks /Query /TN \VerticalLive\vl-autostart /V /FO LIST` | 자동 로그온이 안 됨(5.2), task가 없음, `Last Result`≠0 |
| autostart 로그에 `missing build artifact` | 로그 | `npm run build`를 안 했다 |
| 1·2단계는 되고 OBS만 실패 | `data\ops\logs\autostart-*.log` | `obs.process.enabled=false`(경고만 남긴다), 실행 파일 경로, OBS WebSocket 서버 꺼짐(`docs/ops/obs-setup.md` §2), safe-mode 대화상자(5.7 — `obs sentinel clearing incomplete` 줄이 함께 있으면 표식을 지우지 못한 것이다) |
| `port … answers but belongs to pid … outside <repo>` | 그 PID의 명령행 | 다른 worktree나 무관한 프로세스가 같은 loopback 포트를 잡고 있다. 그 프로세스를 멈추거나, 이 호스트의 포트를 `VL_PORT`/`VL_RENDERER_STATIC_PORT`로 옮긴다 |
| `port … is held by pid … and does not answer` | 그 PID | 포트는 잡혔는데 프로토콜 응답이 없다(죽어가는 프로세스, 무관한 리스너). 준비로 치지 않는 것이 정상 동작이다 |
| `root …: REFUSED (reparse_point)` | `archive.roots[].path` | 그 경로가 junction/심볼릭 링크다. 실제 디렉터리 경로로 바꾼다(4장) |
| `obs launch refused (already_running)` | 작업 관리자 | OBS는 살아 있는데 websocket이 죽었다. 사람이 OBS를 닫고 다시 띄운다 — 서버는 남의 OBS를 죽이지 않는다. **`--minimize-to-tray`로 띄운 OBS는 창 닫기(WM_CLOSE) 요청으로 닫히지 않는 경우가 있다(2026-08-18 이 호스트 관측)** — 트레이 아이콘의 "종료"를 쓴다 |
| 화면은 도는데 렌더러가 안 붙는다 | 서버 로그의 `4401` | 토큰 주입 실패. vault에 `server.rendererToken`이 있는지(`npm run secrets -w @vl/server -- list`) |
| 디스크가 계속 찬다 | `npm run archive -w @vl/server`(dry run) | 루트·확장자가 실제 녹화 경로와 다르거나, 아카이브가 아닌 것이 디스크를 채우고 있다(`WARNING: ... still unmet`) |
| 방송을 즉시 멈춰야 한다 | `docs/ops/supervisor.md` 2장 | `npm run kill -w @vl/server -- --reason "..."` |

## 8. 실행 상태 (이 저장소 기준)

| 항목 | 상태 |
|---|---|
| 스크립트 dry run(`-WhatIf`) 3종 | 이 호스트에서 실행 확인 — `docs/tasks/TASK-T17-windows-ops.md` `## Result` |
| 아카이브 dry run·`--apply` | 이 호스트에서 실행 확인(합성 파일) — 같은 티켓 |
| 자동시작 등록·해제 1사이클 | 티켓 `## Result` 참조 |
| 5장 체크리스트(재부팅·자동 로그온·sleep·GPU reset·remote-session·자동 업데이트) | **사용자 실행 항목.** 이 PR은 절차와 확인 방법만 고정한다(§11은 72시간 soak 전 시험을 요구한다) |
| OBS 32 safe-mode(5.7) | **해결(BOARD D-7, 2026-08-18)** — 실행기가 기동 직전 `.sentinel`을 비운다. 단위 테스트 `apps/server/src/obs/process.test.ts`; 이 호스트에서 "정상 종료 중 크래시 → 표식 잔존 → 제거 후 대화상자 없이 기동"을 관측(BOARD E-7). 공식 문서에 없는 방법이라는 caveat는 5.7 |
| OBS·obs-websocket 버전 고정 | **고정(BOARD D-6, 2026-08-18)** — 32.0.2 / 5.6.3, `docs/ops/obs-setup.md` §1 |
