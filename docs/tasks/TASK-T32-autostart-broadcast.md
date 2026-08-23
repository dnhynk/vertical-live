# TASK-T32-autostart-broadcast

- Task: T32 방송 구성이 자동시작 경로에 없어 무인 운전이 성립하지 않는다 (`docs/tasks/TASK_SPECS.md` §T32)
- Branch: `dnhynk/t32-autostart-broadcast` · PR: #<n>
- Spec sections read: §9.2(상태 전이), §11(무인 운전), §2.1
- BOARD decisions/assumptions relied on: D-2, D-7, D-12

## Goal

Gate 2의 72시간 무인 soak을 시작할 수 있게 한다. 지금은 재부팅해도 방송이 켜지지 않아 "무인"이 성립하지 않는다.

## 원인

`-WithObs`(T25)는 OBS 환경변수 둘만 켜고, `VL_YOUTUBE_CHAT_ENABLED`(T26)는 env override를 만들었지만 **자동시작 경로에서 그것을 설정하는 곳이 없다.** 두 task가 각자 자기 문제만 풀었고 셋을 함께 켜는 경로는 아무도 만들지 않았다(T26 티켓 Follow-up이 예고한 그대로다).

2026-08-23 실측:

```text
vl-autostart [Ready] :: powershell.exe … -File "…\Start-VerticalLive.ps1"
                        ^ -WithObs 조차 없음

Start-VerticalLive.ps1  -WithObs → VL_OBS_PROCESS_ENABLED, VL_OBS_ENABLED
                        VL_BROADCAST_ENABLED · VL_YOUTUBE_CHAT_ENABLED → 경로 없음
```

`chat_transport`는 required family이므로 채팅이 꺼진 채로는 `live`에 도달할 수 없다.

## 변경

- `Start-VerticalLive.ps1`에 `-Broadcast`. `-WithObs`와 같은 자리에서, **설정을 읽기 전에** `VL_BROADCAST_ENABLED`·`VL_YOUTUBE_CHAT_ENABLED`를 켜고 OBS 둘도 함께 켠다(`-Broadcast`가 `-WithObs`를 함의한다 — OBS 없이 방송하는 구성은 없다). `-Broadcast -SkipObs`는 거부한다.
- `Register-VerticalLive.ps1`에 같은 스위치. `{{START_ARGS}}`는 `-Broadcast`면 그것만 넣는다(함의하므로 두 스위치를 함께 넣지 않는다).
- **`broadcast config:` 로그 한 줄 추가** — `obsEnabled` / `broadcastEnabled` / `chatEnabled` / `oauthClient`. 무인 로그만 보고 "이번 실행이 실제로 무엇을 켰는가"를 읽을 수 있어야 하고, 이 네 값 중 하나라도 빠지면 스택이 `live`에 도달하지 못한다. 비밀값은 찍지 않는다 — OAuth는 `present`/`absent`만.
- config 기본값은 전부 `false` 유지.

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(명령·출력) |
|---|---|---|---|
| 1 | `-Broadcast`가 네 변수를 켜고 `-WithObs`를 함의하며, `-SkipObs`와 함께 쓰면 거부된다 | met | 아래 `-WhatIf` 네 조합 |
| 2 | `Register -Broadcast`가 등록한 작업 `<Arguments>`에 스위치가 들어간다 | met | `<Arguments>… -File "…\Start-VerticalLive.ps1" -Broadcast</Arguments>` |
| 3 | 실측: 사람 입력 없이 `supervisor.state = live` | met | 아래 실측 |
| 4 | 게이트 5개 + CI 녹색 | met (CI는 PR에서) | 아래 Gates |

**`-WhatIf` 네 조합** (`broadcast config:` 줄):

```text
-Broadcast            obsEnabled=true  broadcastEnabled=true   chatEnabled=true   oauthClient=…
-WithObs              obsEnabled=true  broadcastEnabled=unset  chatEnabled=unset  oauthClient=…
(스위치 없음)          obsEnabled=unset broadcastEnabled=unset  chatEnabled=unset  oauthClient=…
-Broadcast -SkipObs   throw: -Broadcast and -SkipObs contradict each other: a broadcast needs an encoder
```

**실측 (2026-08-23 06:28–06:31 UTC, 호스트 `WORKSTATION`)**: `Register-VerticalLive.ps1 -Broadcast`로 재등록한 뒤 등록된 작업을 그대로 실행했다(사람이 셸에서 환경변수를 넣지 않았다).

```text
06:28:23  broadcast config: obsEnabled=true broadcastEnabled=true chatEnabled=true oauthClient=present
06:28:23  ready: http://127.0.0.1:5173/ (HTTP 200)
06:28:24  ready: http://127.0.0.1:8787/health (health document)
06:28:26  ready: obs-websocket :4455 (obs64.exe)   ← obs launched pid 23260
06:29~06:31  supervisor=live, signals:all_families_ok, 2분+ 유지
             coordinator·state_commit·chat_transport·renderer·obs_output·youtube_broadcast 전부 ok
renderer  {frameCounter: 4741, fps: 30, lastAppliedStateRevision: 2235}
```

`oauthClient=present`가 이 실측의 핵심이다 — **작업이 `VL_GOOGLE_CLIENT_SECRETS_FILE`(User 환경변수)을 상속한다.** 상속하지 않았다면 서버가 `AuthConfigError`로 즉시 죽었을 것이다(같은 날 그 변수를 상속하지 않은 셸에서 실제로 관측했다).

부수 확인 두 가지: `/metrics`가 `command` 블록을 냈고(T31, 시청자 0명이라 값은 전부 0), T30의 재개 경로가 실제로 동작해 **아직 살아 있는 방송 `z6yv6yNbcPw`를 새로 만들지 않고 그대로 이었다**.

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> ok (0 legacy imports; 4 install scripts reviewed)
npm run typecheck    -> exit 0
npm run test         -> 150 files | 2174 passed | 1 skipped
npm run build        -> exit 0
npm run soak:ci      -> exit 0 (임계값 not-locked 유지, A-15)
```

## Not done / out of scope

- **실제 재부팅으로는 확인하지 않았다.** 등록된 작업을 그대로 실행해 로그온 세션 컨텍스트와 환경변수 상속은 확인했지만, 부팅→자동 로그온→작업 트리거의 전 구간은 아니다. 자동 로그온 자체는 2026-08-22에 통과했다(BOARD 이력).
- PowerShell 스크립트용 자동 테스트 하네스는 만들지 않았다. 이 저장소에 그런 하네스가 없고, T25도 `-WhatIf`와 실측으로 확인했다.
- `windows-host.md` §5의 남은 항목(§5.3 잠금 10분 프레임 유지, §5.4 강제 TDR, §5.5 원격 종료)은 별개다. §11이 72h soak 전에 요구한다.

## Follow-ups

- 72h soak 전에 위 §5.3~§5.5를 돈다.
- 실제 재부팅 1회로 전 구간을 한 번 확인한다.
