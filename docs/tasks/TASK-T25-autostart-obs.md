# TASK-T25-autostart-obs

- Task: T25 자동시작에서 OBS를 함께 올리는 스위치 (`docs/tasks/TASK_SPECS.md` §T25)
- Branch: `dnhynk/t25-autostart-obs` · PR: #<n>
- Orca: 미사용(코디네이터가 직접 구현)
- Spec sections read: §11(무인 호스트·자동 시작), §10.2
- BOARD decisions/assumptions relied on: D-2(2026-08-22 정정), D-6, D-7

## Goal

로그온 자동시작이 OBS까지 함께 올리게 한다. config 기본값(`obs.process.enabled`, `supervisor.integrations.obs` = `false`)은 CI·개발 머신을 보호하므로 그대로 두고, 방송 호스트의 작업 정의에서만 켠다. Task Scheduler XML에는 환경변수 요소가 없으므로 실행 인자로 전달한다.

## 변경

- `Start-VerticalLive.ps1 -WithObs`: 설정을 읽기 **전에** `VL_OBS_PROCESS_ENABLED`·`VL_OBS_ENABLED`를 `true`로 놓는다(자식 프로세스가 같은 환경을 물려받는다). `-SkipObs`와 동시에 주면 거부한다.
- `vertical-live-autostart.xml`의 `<Arguments>`에 `{{START_ARGS}}` 자리표시자, `Register-VerticalLive.ps1 -WithObs`가 ` -WithObs`로 치환한다(스위치 없으면 빈 문자열).
- `docs/ops/windows-host.md`: 호스트는 `-WithObs`로 등록한다는 것, 없이 실행하면 `safe_stopped`가 된다는 관측, YouTube 방송이 없으면 `-WithObs`로도 오래 서 있지 못한다는 관측.

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | `-WithObs -WhatIf`의 XML `<Arguments>`에 `-WithObs`가 있고, 스위치 없으면 없다 | met | `… -File "…\Start-VerticalLive.ps1" -WithObs` / `… -File "…\Start-VerticalLive.ps1"` |
| 2 | `-WithObs` 실행 시 OBS가 뜨고 `resolved config`가 `obsProcessEnabled=True` | met | `data\ops\logs\autostart-20260822.log`: `obsProcessEnabled=True`, `obs launched: pid 14252 (crash sentinels cleared: 0)`, `ready: obs-websocket :4455 (obs64.exe)` |
| 3 | 렌더러가 실제로 붙어 그린다 · `renderer-source` 미소진 | met | `/health` renderer `{frameCounter:391, fps:30, lastAppliedStateRevision:12}`, `renderer-source attempts=0/3`. OBS 미리보기에 렌더러 화면이 나온다 |
| 4 | `-WithObs -SkipObs` 거부 | met | `-WithObs and -SkipObs contradict each other: pick one` |
| 5 | 게이트 5개 + CI | met (CI는 PR에서) | 아래 Gates |

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check  -> exit 0
npm run lint          -> exit 0
npm run typecheck     -> exit 0
npm run test          -> 150 files | 2159 passed | 1 skipped
npm run build         -> exit 0
```

## Not done / out of scope

- **YouTube 방송이 없어 스택은 여전히 안전 정지한다.** `-WithObs`로 OBS·렌더러는 정상 기동하지만 `obs-stream`이 `outputActive = true`에 도달하지 못해(스트림 키 없음) 3회 시도 뒤 `safe_stopped`가 된다. 이 정지는 T25 범위 밖이고 D-10/D-16(YouTube 계정·OAuth)에 걸려 있다.
- config 기본값 변경.

## Follow-ups

- **OBS 모달**: 송출 실패 시 OBS가 "방송을 시작하지 못했습니다" 대화상자를 띄운다(2026-08-22 관측). 무인 운전에서 모달은 사람이 닫을 때까지 남는다 — 실제 방송 전에 이 경로가 어떻게 처리되는지 정해야 한다(D-7의 safe-mode sentinel과 같은 성격의 문제).
- 72h soak 전 호스트 시험(§5.3 잠금 10분 프레임 유지, §5.4 강제 TDR, §5.5 원격 종료)은 스택이 계속 서 있어야 하므로 YouTube 설정 뒤에 가능하다.
