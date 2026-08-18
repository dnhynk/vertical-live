# TASK-T18-obs-safemode-policy

- Task: T18 사용자 결정 D-6·D-7 구현과 문서 정합 (`docs/tasks/BOARD.md` §2 D-4/D-6/D-7, §4 E-2·E-3·E-5·E-7; `docs/tasks/TASK_SPECS.md` §T17·§T2)
- Branch: `dnhynk/t18-obs-safemode-policy` · PR: #<n>
- Orca: task `task_0d996db3c12a` · dispatch `ctx_6687d39f7667`
- Spec sections read: §9.2(safe_stopped·재시작 예산), §10.2(비밀정보·restart supervisor 1개), §10.3(OBS 버전 고정), §11(hosting OS·자동 업데이트 시험)
- BOARD decisions/assumptions relied on: D-2, D-4(2026-08-18 public 전환), D-6, D-7, A-16, E-3·E-7 관측

## Goal

사용자가 2026-08-18에 내린 두 결정을 코드와 문서에 반영한다. **D-7**: 우리가 OBS를 띄우는 단 하나의 경로(`ObsProcessLauncher.launch()`)가 spawn 직전에 OBS 설정 디렉터리의 `.sentinel` 안 파일을 지워, 비정상 종료 뒤 첫 기동에서 safe-mode 대화상자(=obs-websocket 비활성화 = 우리 제어 경로 전멸)를 만나지 않게 한다. 자동시작 3단계와 supervisor `obs-process` 재시작이 같은 launcher를 쓰므로 한 곳만 고치면 두 경로가 함께 닫힌다. **D-6**: 32.0.2 / 5.6.3 고정이 승인됐으므로 문서의 "승인 대기" 표기를 정정하고, 2026-08-18 실 OBS 관측(E-3)으로 스모크 상태를 갱신한다. 함께 D-4 갱신(저장소 public)에 따른 문서 문구도 정정한다.

## Plan

1. **config** — `obs.process.sentinelDir`를 추가한다. `config/default.json`에는 `""`(=파생), `loadObsConfig()`가 `VL_OBS_SENTINEL_DIR` → config 값 → `%APPDATA%\obs-studio\.sentinel` → `""`(APPDATA 없음, 예: CI ubuntu) 순으로 해석한다. `provisional`이 아니다(경로는 관측된 사실이지 합격선이 아니다).
2. **launcher** — `ObsProcessLauncher`에 `sentinel?: ObsSentinelFs`(`readdir`/`remove`)를 주입 가능하게 넣고, 세 거부(not_configured / executable_not_found / already_running)를 모두 통과한 **뒤 spawn 직전에** `.sentinel` 안 파일만 지운다(디렉터리 자체는 남긴다). 결과에 `sentinelCleared: number`, `sentinelFailure: string | null`. 디렉터리 없음(ENOENT) → 0·정상 진행. 삭제 실패 → warn 로그 후 launch 계속(= 무력화 시 기존 동작인 "포트 대기 타임아웃 + 실패 기록"으로 떨어진다). `cleared > 0`일 때만 `obs.sentinel_cleared`(개수·경로만) info 로그 — 매 기동 남는 0줄보다 "크래시 표식을 지웠다"는 사건이 반복 크래시의 증거가 된다.
3. **supervisor 최소 배선** — `RestartAction`은 `void`를 반환하므로 액션이 자기 컴포넌트 health로 값을 되돌릴 채널이 없다. `ComponentHealth.lastNote: string | null` 1개 필드 + `RestartSupervisor.note()` + `Supervisor.noteComponent()`만 추가하고(전이 규칙·family·알림 형식은 건드리지 않는다) `main.ts`의 `obsProcess` 액션이 `sentinel_cleared=<n>`을 남긴다. `/health`의 `components[]`는 이미 노출돼 있으므로 이 한 필드로 D-7의 "health detail에 남긴다"가 충족된다.
4. **bin** — `obs-launch.ts`(자동시작 3단계)가 stdout 한 줄에 개수를 적어 `data\ops\logs\autostart-*.log`에 남게 한다. `--dry-run`은 `plan()`만 쓰므로 아무것도 지우지 않는다(테스트로 고정).
5. **테스트** — 파일 있음→삭제·카운트, 없음(ENOENT)→0·정상 launch, readdir/remove 예외→launch 진행+warn+`sentinelFailure`, `plan()` 불변(dry run은 fs를 만지지 않음), config 파생(APPDATA 있음/없음/override).
6. **문서** — `windows-host.md` §5.7(미해결 위험 → D-7 채택·근거·비공식 caveat·2026-08-18 관측)·§3 OBS 실행기·§7 문제 해결·§8 표, `obs-setup.md` §1(D-6 승인)·§6(E-3 probe 결과, 체크 4번 문구 정정). 정지 절차에 E-3의 `--minimize-to-tray`/트레이 종료 관측 한 줄.
7. **'private' 문구** — `CLAUDE.md` §2, `docs/runbooks/agent-orchestration.md` 머리말·0장 표를 public으로 정정하고, `rg`로 남은 서술을 훑어 아래 "Not done"에 목록을 남긴다(BOARD는 코디네이터 소유라 건드리지 않는다).

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|

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
<대기>
```

## Not done / out of scope

- safe-mode 대화상자를 UI 자동화로 누르는 것, OBS 재설치, 씬/프로파일 파일 변경.

## Follow-ups

- …
