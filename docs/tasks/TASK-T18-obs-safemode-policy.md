# TASK-T18-obs-safemode-policy

- Task: T18 사용자 결정 D-6·D-7 구현과 문서 정합 (`docs/tasks/BOARD.md` §2 D-4/D-6/D-7, §4 E-2·E-3·E-5·E-7; `docs/tasks/TASK_SPECS.md` §T17·§T2)
- Branch: `dnhynk/t18-obs-safemode-policy` · PR: [#24](https://github.com/dnhynk/vertical-live/pull/24)
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
| OBS Safe Mode가 무엇을 끄는가 | https://github.com/obsproject/obs-studio/pull/8455 | 2026-08-18 | Safe Mode는 서드파티 plugin과 **obs-websocket·스크립팅**을 비활성화한다. 즉 대화상자를 사람이 "아니오"로 눌러 주지 않으면 우리 제어 경로 전체가 죽는다 → D-7의 근거 |
| `--disable-shutdown-check` 제거 | https://github.com/obsproject/obs-studio/issues/12650 · https://obsproject.com/forum/threads/obs-version-32-0-0-removed-disable-shutdown-check.190590/ | 2026-08-17(T17), 재확인 2026-08-18 | OBS 32.0.0에서 제거, 대체 플래그 없음(closed as not planned). 공식 수단으로는 프롬프트를 끌 수 없다 |
| 공식 launch parameter 목록 | https://obsproject.com/kb/launch-parameters | 2026-08-17(T17) | `.sentinel` 관련 항목 없음. **`.sentinel` 삭제는 공식 문서에 없는 방법**이며 문서에 그대로 적었다(`windows-host.md` 5.7 caveat) |

`.sentinel`이 이 호스트에서 **디렉터리**라는 것과 그 안의 파일이 `run_*`라는 것은 문서가 아니라 관측이다(T17 2026-08-17 `ls -ld`, E-7 2026-08-18). 그래서 구현은 "디렉터리 안의 파일을 지운다"이지 "파일 하나를 지운다"가 아니다.

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) | — | D-6·D-7이 이미 결정이고 E-3·E-7 관측이 명세에 들어 있어 물을 것이 없었다 |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `obs.process.sentinelDir` | `""`(= `%APPDATA%\obs-studio\.sentinel`에서 파생) | **provisional 아님** | 합격선 숫자가 아니라 관측된 경로다(BOARD A-15가 말하는 "숫자"에 해당하지 않는다). 호스트가 다르면 `VL_OBS_SENTINEL_DIR`로 지정한다 |
| 로그를 `cleared > 0`일 때만 남긴다 | — | 설계 결정 | 기동마다 `cleared=0` 한 줄은 정보가 없고, 0보다 큰 값이 이어지는 것 자체가 크래시 루프의 증거다. 항상 보이는 값은 `/health`의 `lastNote`에 있다 |
| `ComponentHealth.lastNote` 신설 | 필드 1개 | supervisor 프로덕션 코드 변경(최소) | D-7이 "health detail에 남긴다"를 요구하는데 `RestartAction`은 `void`를 반환해 액션→health 채널이 없었다. 대안이었던 "새 HealthSignal/family"는 §9.2 전이표에 고장이 아닌 값을 먹이게 되므로 쓰지 않았다. 추가한 것은 `types.ts` 필드 1개 + `RestartSupervisor.note()` + `Supervisor.noteComponent()` 3곳뿐이고 전이·알림·family는 한 줄도 바뀌지 않았다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | `launch()`가 spawn 직전에 `.sentinel` 안 파일을 지운다(디렉터리는 남김), 자동시작·supervisor 두 경로가 한 곳을 쓴다 | met (리뷰 round 1·2에서 B1 고침) | `apps/server/src/obs/process.test.ts` "removes the sentinel files and reports how many, before the spawn"(remove·remove·spawn 순서까지 단언). 두 경로는 `apps/server/src/bin/obs-launch.ts`(자동시작 3단계)와 `apps/server/src/main.ts`의 `actions.obsProcess`가 같은 `ObsProcessLauncher`를 쓰는 기존 구조 그대로다. **승인한 디렉터리 밖으로 나가지 않는다는 부분은 두 번 틀렸다** — round 1은 루트가 junction이면 따라 들어갔고, round 2는 목록을 읽은 뒤 루트가 junction으로 교체되면 따라갔다. 지금은 목록 전에 실루트를 고정하고 확인된 실경로로 지운다. **완전히 닫히지 않은 창이 하나 남는다**(실경로 확인 → `unlink` 사이) — 아래 `## Review round 2`에 근거와 함께 적었다 |
| 2 | 경로는 config(`obs.process.sentinelDir`, `APPDATA` 파생), provisional 아님 | met | `apps/server/src/obs/config.ts` `resolveSentinelDir()`; 테스트 "derives the sentinel directory from APPDATA, with Windows separators" / "has no sentinel directory on a host without APPDATA" / "takes an explicit sentinel directory for a portable OBS install" / "does not call the sentinel path provisional" |
| 3 | fs 주입 가능 | met | `ObsSentinelFs`(`isReparsePoint`/`realPath`/`list`/`canonicalFile`/`remove`) + `ObsProcessLauncherOptions.sentinel`. 모든 새 테스트가 주입해서 돈다. 실 구현(`nodeObsSentinelFs`)은 실 junction/symlink로 따로 검증한다(round 1·2, B1) |
| 4 | 결과에 `sentinelCleared`(+ 실패 사유), 로그 `obs.sentinel_cleared`(개수·경로만) | met (리뷰 round 1에서 m1 고침) | `ObsLaunchResult.sentinelCleared` / `.sentinelFailure`; 로그 단언은 같은 테스트의 `expect(info).toHaveBeenCalledWith('obs.sentinel_cleared', { dir, cleared: 2 })`. **실패 사유는 처음엔 raw `Error.message`라 파일 이름이 섞였다** — 지금은 토큰(errno 코드·`unknown`·두 거부)뿐이다. 아래 `## Review round 1` m1 |
| 5 | supervisor의 기존 health detail에 값이 보인다(최소 배선) | met | `apps/server/src/supervisor/supervisor.test.ts` "puts what a restart action recorded on the health document (BOARD D-7)"(`/health`의 `components[]`에서 `obs-process.lastNote = sentinel_cleared=1`, 다른 컴포넌트는 null), `restart.test.ts` "carries what the action recorded onto /health, and keeps it once healthy" |
| 6 | 디렉터리 없음 → 0·정상 진행 | met | `process.test.ts` "treats a missing sentinel directory as nothing to clear"(ENOENT → cleared 0, failure null, spawn 1회, `obs.sentinel_cleared` 미출력) |
| 7 | 삭제 실패 → warn 후 launch 계속(= 기존 동작으로 강등) | met (리뷰 round 1에서 M1 고침) | "starts OBS anyway when a file will not go, and says which ones did"(EACCES 1건 → cleared 1, failure 기록, warn, pid 반환), "starts OBS anyway when the directory itself cannot be read". **자동시작 경로에서는 그 사유가 로그에 남지 않았다**(stderr로 나갔다) — 지금은 stdout이라 `autostart-*.log`에 남는다. 아래 `## Review round 1` M1 |
| 8 | `plan()` 불변(dry run이 아무것도 지우지 않는다) | met | "leaves the sentinel alone on every refusal, and in a dry run"(`plan()` + 세 거부 경로 모두에서 `list`·`remove` 호출 0) |
| 9 | 문서: `windows-host.md` §5.7·§8, `obs-setup.md` §1·§6 | met (리뷰 round 2에서 고침) | 아래 "문서 변경". §5.7이 "목록과 삭제 사이의 창을 닫는다"고 단언했는데 그것이 사실이 아니었다 — 지금은 3단계 절차와 **남는 창**을 함께 적는다(`78983f4`) |
| 10 | `private` → public 정정 | met | `CLAUDE.md` §2, `docs/runbooks/agent-orchestration.md` 머리말·0장 표, `docs/tasks/TASK_SPECS.md` 공통 규약 머리말 |
| 11 | 게이트 5개 + PR CI 녹색 | met | T17b(PR #23)가 `b414970`으로 머지된 뒤 rebase해서 둘 다 녹색이다. 로컬 게이트 5개 전부 통과(`1896 passed | 1 skipped`), PR CI [run 32107232734](https://github.com/dnhynk/vertical-live/actions/runs/32107232734) **pass**. 아래 "Rebase onto T17b" 참조 |

### 문서 변경

| 문서 | 변경 |
|---|---|
| `docs/ops/windows-host.md` | §3 실행기: `sentinelDir` 설정 블록·동작 한 줄 · §5.6: 버전 고정을 E-2(대기) → D-6(승인) · **§5.7 전면 교체**: "미해결 위험 + 선택지 3개" → D-7 채택 내용(어디서·설정·기록·실패 시 강등), 근거 3개(서드파티 플러그인 미사용 / F-18이 크래시 루프를 표면화 / 무인성), **공식 문서에 없다는 caveat**, 2026-08-18 관측(E-7: 정상 종료 중 WASAPI·obs-browser 경합 crash → sentinel 잔존 → 제거 후 대화상자 없이 기동) · §7: safe-mode 행에 `obs sentinel clearing incomplete` 단서, `already_running` 행에 **트레이 '종료'** 관측(E-3) · §8: safe-mode 행 해결로 갱신 + 버전 고정 행 추가 |
| `docs/ops/obs-setup.md` | §1: "고정 버전 후보 — 사용자 승인 대기" → **고정(D-6, 2026-08-18)**, 2026-08-18 재확인 근거 · §6: "실행하지 않았음" → **통과(E-3)** + probe 결과 표(버전·RPC·`matches 1080x1920@30 yes`·씬·browser source·건강 신호 4개), 체크 4번을 관측대로 정정(`obs.frames`는 송출 전에도 ok — 이유를 `obs/health.ts`의 계산으로 설명) |
| `docs/ops/supervisor.md` | `obs-process` 행에 sentinel 비우기·`lastNote` 한 줄, §8의 "실제 자원 검증은 Gate 2(E-2·E-3)" → OBS는 2026-08-18에 통과했음을 반영 |
| `CLAUDE.md` · `docs/runbooks/agent-orchestration.md` · `docs/tasks/TASK_SPECS.md` | 저장소 서술 public(D-4, 2026-08-18). CLAUDE.md에는 "공개 저장소이므로 비밀정보·개인정보는 티켓·PR·fixture에도 넣지 않는다" 한 줄 추가 |

### `private` grep 결과 (BOARD 제외)

`rg private` 전수 확인. 저장소 공개 여부를 말하는 서술은 위 3곳뿐이었고 모두 고쳤다. 남은 것은 전부 **다른 뜻**이라 건드리지 않았다:

- `privacyStatus`(YouTube 방송 공개 범위) — `apps/server/src/youtube/**`, `config/default.json`, `docs/ops/broadcast-lifecycle.md`, `docs/YOUTUBE_MONETIZATION_RUNBOOK.md`, `docs/ACCOUNT_SETUP_FROM_ZERO.md`
- `"private": true`(npm workspace 패키지 플래그) — `apps/server/package.json`, `apps/renderer/package.json`, `docs/tasks/TASK-T0-scaffold.md`
- TypeScript `private` 멤버 — `apps/server/src/**`
- `private_settings`(OBS 씬 파일 형식) — `ops/obs/scenes/vertical-live.json`
- 지난 티켓 본문의 인용(`TASK-T8c`, `TASK-T10`) — 이력이므로 고치지 않는다
- `docs/tasks/BOARD.md` — 코디네이터 소유

### 수동 확인 (실 파일시스템, 이 호스트)

단위 테스트는 `ObsSentinelFs`를 주입하므로 실제 `readdirSync`/`rmSync` 구현은 따로 확인했다. 빌드 산출물(`apps/server/dist`)의 `ObsProcessLauncher`에 진짜 fs 구현을 쓰게 하고 spawn만 가짜로 둔 스크립트:

```js
// 저장소 밖(임시 디렉터리)에서 돌린 일회용 확인 스크립트. 산출물을 커밋하지 않았으므로 그대로 옮겨 둔다.
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ObsProcessLauncher } from './apps/server/dist/obs/process.js'

const dir = join(mkdtempSync(join(tmpdir(), 'vl-sentinel-')), '.sentinel')
mkdirSync(dir)
writeFileSync(join(dir, 'run_1234'), '')
writeFileSync(join(dir, 'run_5678'), '')
mkdirSync(join(dir, 'nested')) // 하위 디렉터리는 건드리지 않는 것을 같이 본다

const config = {
  enabled: true,
  executablePath: String.raw`C:\Program Files\obs-studio\bin\64bit\obs64.exe`,
  profile: 'vertical-live',
  sceneCollection: 'vertical-live',
  extraArgs: [],
  sentinelDir: dir,
}
const logger = { debug() {}, info: (m, f) => console.log('INFO ', m, JSON.stringify(f)), warn: (m, f) => console.log('WARN ', m, JSON.stringify(f)), error() {} }
const launcher = new ObsProcessLauncher({
  config,
  spawner: { spawn: () => ({ pid: 1234, unref() {} }) }, // 실제 OBS는 띄우지 않는다
  probe: { running: () => false },
  exists: () => true,
  logger,
})

console.log('before:', readdirSync(dir))
const result = launcher.launch()
console.log('after :', readdirSync(dir), '| directory still exists:', existsSync(dir))
console.log('sentinelCleared =', result.sentinelCleared, '| sentinelFailure =', result.sentinelFailure)
console.log('second launch sentinelCleared =', launcher.launch().sentinelCleared)
```

```text
$ npm run build && node <위 스크립트>
before: [ 'nested', 'run_1234', 'run_5678' ]
INFO  obs.sentinel_cleared {"dir":"C:\Users\dongh\AppData\Local\Temp\vl-sentinel-vaMgHX\.sentinel","cleared":2}
INFO  obs process launched {"pid":1234,"profile":"vertical-live","collection":"vertical-live"}
after : [ 'nested' ] | directory still exists: true
sentinelCleared = 2 | sentinelFailure = null
spawn calls = 1
INFO  obs process launched {...}
second launch sentinelCleared = 0 | failure = null
INFO  obs process launched {...}
missing dir  sentinelCleared = 0 | failure = null | pid = 5
```

파일 2개가 지워지고, 디렉터리와 그 안의 하위 디렉터리(`nested`)는 남고, 두 번째 기동은 0이며, 디렉터리가 아예 없어도 기동은 진행된다. **실제 OBS를 띄워 대화상자가 사라지는 것까지는 이 PR에서 실행하지 않았음**: OBS 기동은 호스트 상태를 바꾸는 조작이고, 그 관측은 코디네이터가 2026-08-18에 이미 수행해 BOARD E-7에 있다(sentinel 제거 후 대화상자 없이 기동·probe 성공).

### Gates (executed)

```text
$ npm run format:check     → All matched files use Prettier code style!
$ npm run lint             → eslint 0 problems; check-no-legacy-imports: ok (0); check-install-scripts: ok (4 reviewed)
$ npm run typecheck        → tsc --build, exit 0
$ npm run build            → tsc --build (all workspaces), exit 0
$ npm run test             → Test Files 1 failed | 137 passed (138)
                             Tests 1 failed | 1895 passed | 1 skipped (1897)
```

유일한 실패는 **이 브랜치가 만든 것이 아니다**: `apps/server/src/obs/client.test.ts > does not read the environment when no provider is injected`. 같은 worktree에서 `git stash -u`로 내 변경을 모두 걷어내고 base(`c6d2680`)에서 그대로 재현했다:

```text
$ git stash -u && npx vitest run apps/server/src/obs/client.test.ts
 × does not read the environment when no provider is injected 44ms
 Test Files  1 failed (1) | Tests  1 failed | 12 passed (13)
$ git stash pop
```

원인은 BOARD E-5·T17b에 적힌 대로 이 테스트가 호스트 vault 상태에 의존하기 때문이고(E-3에서 이 호스트의 Credential Manager에 `obs.websocketPassword`가 들어갔다), **T17b(PR #23, 브랜치 `dnhynk/t17b-ci-path-semantics`)가 고치는 중**이었다. #23이 `b414970`으로 머지된 뒤 rebase해서 사라졌다(아래 "Rebase onto T17b").

### PR CI (2026-08-18)

PR [#24](https://github.com/dnhynk/vertical-live/pull/24)의 첫 CI는 **fail**이다: [run 32103525944](https://github.com/dnhynk/vertical-live/actions/runs/32103525944). 실패 3건은 전부 T17b가 고치는 ubuntu 경로 의미론 문제이고 이 브랜치가 만든 것이 아니다.

```text
Test Files  2 failed | 136 passed (138)
     Tests  3 failed | 1892 passed | 2 skipped (1897)

FAIL apps/server/src/obs/process.test.ts > ObsProcessLauncher > runs OBS from its own directory so it finds its data
  AssertionError: expected '.' to be 'C:\Program Files\obs-studio\bin\64bit'
FAIL apps/server/src/ops/ops-config.test.ts > describeOpsConfig > describes the shipped defaults
  AssertionError: expected { …(5) } to match object { …(4) }
FAIL apps/server/src/ops/ops-config.test.ts > describeOpsConfig > honours VL_OBS_EXECUTABLE and reports the name the port owner should have
  AssertionError: expected 'D:\obs\bin\obs64.exe' to be 'obs64.exe'
```

origin/main `cb3db6b`(코디네이터 BOARD 커밋)으로 rebase한 뒤 다시 돌린 [run 32103798353](https://github.com/dnhynk/vertical-live/actions/runs/32103798353)도 **같은 3건**으로 실패한다(`3 failed | 1892 passed | 2 skipped`). 목록이 늘지도 줄지도 않았다.

셋 다 posix 호스트에서 `dirname`/`basename`을 Windows 경로에 쓴 결과다(`'.'`, 경로 전체). BOARD E-5가 기록한 main의 ubuntu 실패 3건과 같은 목록이며, 내가 추가한 sentinel 테스트는 CI에서 전부 통과했다(`ops-config`는 sentinel을 읽지도 않는다: `rg sentinel apps/server/src/ops/` 0건). 로컬 Windows에서는 이 3건이 통과하고 대신 `client.test.ts` 1건이 호스트 vault 때문에 실패한다 — 같은 T17b가 함께 고친다.

**해소됨**(아래 "Rebase onto T17b"): PR을 연 시점(2026-08-18)에 #23은 OPEN이었다. 내가 건드린 `apps/server/src/obs/process.ts`는 T17b도 손대는 파일(`dirname` → `win32.dirname`)이라 rebase에서 충돌 가능성이 있고, 그때는 T17b의 의미론(Windows 경로는 `path.win32`)을 그대로 살린다 — 이번 PR의 `resolveSentinelDir()`도 같은 이유로 `win32.join`을 쓴다.

### Rebase onto T17b (2026-08-18)

T17b가 PR #23으로 main `b414970`에 머지된 뒤 `git fetch origin && git rebase origin/main`으로 재배치했다(merge-base는 `cb3db6b`, 내 커밋 7개). 코드 변경 없음.

**충돌 1건**, `apps/server/src/obs/process.ts`. 두 hunk 모두 T17b와 이 브랜치가 같은 자리에 서로 다른 것을 더한 결과이고, 호출부는 git이 이미 자동 병합했다(`winPath.basename`/`winPath.dirname`).

- import: T17b는 `win32 as winPath`를, 이 브랜치는 `basename, dirname, join`을 들여왔다. 자동 병합이 호출부를 전부 `winPath.*`로 바꿔 `basename`/`dirname`은 쓰이지 않게 됐으므로 `import { join, win32 as winPath } from 'node:path'`로 합쳤다(남겼으면 lint 실패). `join`은 `nodeObsSentinelFs.remove`만 쓰는데, 이쪽은 실행 중인 호스트의 실제 파일 경로라 T17b의 규칙("계약상 Windows 경로만 `path.win32`")대로 호스트 native가 맞다. 계약상 Windows 경로인 `sentinelDir` 파생은 원래부터 `config.ts`의 `win32.join`이다.
- 파일 머리 doc comment: 서로 다른 것을 설명하는 두 문단(T17b의 win32 경로 의미론, D-7의 sentinel 삭제)이라 둘 다 남겼다.

rebase 뒤 로컬 게이트 5개:

```text
$ npm run format:check     → All matched files use Prettier code style!
$ npm run lint             → eslint 0 problems; check-no-legacy-imports: ok (0); check-install-scripts: ok (4 reviewed)
$ npm run typecheck        → tsc --build, exit 0
$ npm run test             → Test Files 138 passed (138)
                             Tests 1896 passed | 1 skipped (1897)
$ npm run build            → vite + tsc --build (all workspaces), exit 0
```

앞서 남아 있던 `client.test.ts` 실패 1건은 T17b가 고쳤다(호스트 vault 대신 "identify되지 않았음"을 단언하도록 바꿨다). 로컬은 이제 완전 녹색이다.

push는 `--force-with-lease`(`136b437...a5c8e11`). PR CI [run 32107232734](https://github.com/dnhynk/vertical-live/actions/runs/32107232734) **pass** (2m20s): `format:check`·`lint`·`typecheck`·`test`·`build`·`soak:ci` 전부 통과. 위 3건의 ubuntu 경로 실패는 T17b가 main에서 고쳐 사라졌다.

## Review round 1

리뷰어 판정 `request_changes`(blocker 1 · major 1 · minor 1). 게이트 7개와 합격 기준 2·3·4·5·6·8·10·11은 리뷰어가 직접 돌려 통과를 확인했고, 아래 셋만 고쳤다.

| 지적 | 고침 |
|---|---|
| **[blocker] `apps/server/src/obs/process.ts:118`** — 프로덕션 `list()`가 `.sentinel` 루트를 따라 들어가서, 루트가 junction/symlink면 `remove()`가 승인된 디렉터리 **밖** 파일을 지운다. 리뷰어 재현: sibling `outside-target`으로 가는 junction → `{targetFileStillExists:false, sentinelCleared:1}` | **고침 `b2579aa`.** 판정을 `ObsSentinelFs`로 올리고 두 곳에서 거부한다. (1) `isReparsePoint(dir)` — 루트가 reparse point면 **읽지도 않고** 거부(`sentinel_dir_reparse_point`, cleared 0, warn). 링크가 오늘 가리키는 곳은 운영자가 config에서 검토한 디렉터리가 아니다. lstat을 못 읽으면 링크로 간주하고(답을 못 하는 검사는 허용이 아니다), 디렉터리가 아예 없는 경우(ENOENT)만 false — 그 경로는 기존대로 `list()`의 ENOENT가 결정한다. (2) `isContainedFile(dir, name)` — **삭제 직전에** 다시 확인한다(`lstat`으로 일반 파일 + 실경로가 실루트 바로 안). 목록과 삭제 사이에 링크로 바뀌는 창(TOCTOU)을 닫는다. 실패 시 삭제 대신 `sentinel_entry_escaped_dir`. 판정 술어는 T17 `sweep.ts`의 `isInside`를 **그대로 재사용**한다(정의를 둘로 늘리지 않는다). 항목 심볼릭 링크·하위 디렉터리는 기존대로 `list()`의 `isFile()`이 애초에 거른다 |
| **[major] `ops/windows/Start-VerticalLive.ps1:201`** — `obs-launch.ts`가 sentinel-clear 실패를 stderr로 쓰는데 스크립트는 stdout만 `$launch`로 잡아 로그에 붙이므로, 숨겨진 예약 작업의 `data\ops\logs\autostart-*.log`에 원인이 남지 않고 `windows-host.md` 7장 절차를 따를 수 없다 | **고침 `d78e87d`.** 두 선택지 중 **`obs-launch.ts`가 stdout에 쓰도록** 했다(스크립트는 손대지 않았다). 근거: T17 스크립트 규약은 "그 단계가 찍은 것을 그대로 로그에 붙인다"(`Write-VLLog -Message (($launch | Out-String).TrimEnd())`)이고, Windows PowerShell 5.1에서 네이티브 명령의 stderr를 `2>&1`로 합치면 줄마다 ErrorRecord로 감싸이며 `$?`가 뒤집힌다 — 스크립트에 리다이렉션을 넣는 쪽이 더 큰 변경이자 더 위험하다. 기동 자체는 성공이므로 exit code는 0 그대로다. 값은 계약상 토큰이라 경로·파일명이 로그에 새로 생기지 않는다 |
| **[minor] `apps/server/src/obs/process.ts:279`** — remove 실패의 raw `Error.message`가 `sentinelFailure`→warn→`/health` `lastNote`로 흘러 파일명(`unlink 'run_locked'`)이 노출된다. PR 본문의 "파일명 미노출" 서술과 불일치 | **고침 `b2579aa`.** `describeError`(메시지) → `errorCode`(`err.code ?? 'unknown'`). 나가는 값은 errno 코드(`EACCES`…)·`unknown`·`sentinel_dir_reparse_point`·`sentinel_entry_escaped_dir` 넷뿐이다. 테스트가 `sentinelFailure`를 `toBe('EACCES')`로 못박고 `.not.toContain('run_locked')`를 함께 단언한다(fake가 던지는 오류 메시지에는 그 파일명이 들어 있다). PR 본문과 `windows-host.md` 5.7 서술도 실제와 맞췄다 |

### 새 테스트 (`apps/server/src/obs/process.test.ts`, 22 → 29건)

주입 fs 5건 — 루트 reparse point 거부(list·remove 호출 0, 토큰, warn, **그래도 spawn 1회**), 삭제 직전 containment 재확인(3개 중 1개가 링크로 바뀐 상황 → 확인 3회·삭제 2회·`sentinel_entry_escaped_dir`), code 없는 오류 → `unknown`, EACCES 토큰 단언 2건.

실 파일시스템 4건 — `describe('nodeObsSentinelFs against real links (review round 1, B1)')`. 리뷰어가 손으로 한 재현을 테스트로 고정했다: 실제 junction을 reparse point로 보고하는지 / 실 디렉터리·없는 디렉터리는 아닌지, **`.sentinel`이 sibling `outside`로 가는 junction일 때 `not-a-sentinel.txt`가 살아남고 cleared 0·`sentinel_dir_reparse_point`인지**, 실 디렉터리에서는 `run_1234`만 지우고 하위 디렉터리·junction 항목·파일 심볼릭 링크는 남기는지, `isContainedFile`이 실 파일 true / junction 항목 false / 없는 이름 false / 파일 심볼릭 링크 false인지.

링크 종류: junction은 권한 없이 만들어지고, 파일 심볼릭 링크는 호스트가 허용할 때만 만들어 그 단언을 켠다(`trySymlinkFile`). **이 호스트에서는 둘 다 만들어졌다** — `node -e` 확인 결과 `file symlink: OK`, `junction: OK`. 따라서 위 단언은 전부 실제로 돌았다.

### 실행 근거 (M1·B1, 실제 실행)

`Start-VerticalLive.ps1`은 바뀌지 않았지만, 그 201–202줄이 하는 것과 **같은 캡처 모양**을 빌드 산출물로 재현했다(리뷰어의 실험과 같은 형태). `where.exe`를 실행 파일로 세워 실제 spawn까지 가게 하고, `.sentinel`을 sibling `outside`로 가는 junction으로 만들었다 — 즉 blocker의 재현 조건 그대로다:

```powershell
cmd /c mklink /J "$base\.sentinel" "$base\outside"
$env:VL_OBS_PROCESS_ENABLED='true'; $env:VL_OBS_EXECUTABLE='C:\Windows\System32\where.exe'
$env:VL_OBS_SENTINEL_DIR="$base\.sentinel"
$launch = & node apps\server\dist\bin\obs-launch.js
($launch | Out-String).TrimEnd()
```

```text
--- captured stdout (what Write-VLLog appends to autostart-*.log) ---
obs launched: pid 37632 (crash sentinels cleared: 0)
obs sentinel clearing incomplete: sentinel_dir_reparse_point
--- exit=0 ---
outside file still exists: True
```

두 줄 모두 `$launch`에 잡히고(= 로그에 그대로 붙는다), junction 밖 파일은 지워지지 않았으며, exit code는 0이라 기동 실패로 오인되지 않는다. 스크립트 자체도 `-WhatIf`로 돌려 그대로 도는 것을 확인했다(`obsProcessEnabled=False`라 OBS 분기는 경고 경로, `start sequence complete`). 실제 OBS를 띄운 확인은 아니다 — 이 워크스테이션에서 OBS를 기동시키지 않았다.

### 게이트 재실행 (round 1 고침 후)

```text
$ npm run format:check   → All matched files use Prettier code style!
$ npm run lint           → eslint exit 0; legacy imports 0; install scripts 4 reviewed
$ npm run typecheck      → tsc --build, exit 0
$ npm run test           → Test Files 138 passed (138)
                           Tests 1903 passed | 1 skipped (1904)
$ npm run build          → vite + tsc --build (all workspaces), exit 0
```

`git fetch origin && git rebase origin/main`(base `6342ac9`, 충돌 없음) 후 위 5개를 다시 돌렸고 결과는 같다. push는 `--force-with-lease`(`a6f0a30...4291d8e`). PR CI [run 32110335065](https://github.com/dnhynk/vertical-live/actions/runs/32110335065) **pass** — head `4291d8e`.

## Review round 2

리뷰어 판정 `request_changes`(blocker 1). round 1의 M1·m1과 정적 junction 시나리오는 리뷰어가 직접 재현해 **해소 확인**했고, 합격 기준 2·3·4·5·6·7·8·10·11도 리뷰어가 게이트를 직접 돌려 통과를 확인했다. 남은 것은 아래 하나다.

| 지적 | 고침 |
|---|---|
| **[blocker] `apps/server/src/obs/process.ts:165`** — `isContainedFile()`이 **삭제 시점에** `realpath(dir)`를 다시 계산해 비교한다. `list()` 직후 진짜 `.sentinel`을 다른 이름으로 옮기고 같은 lexical 경로에 sibling junction을 놓으면 `realpath(dir)`도 `realpath(path)`도 junction 대상 아래로 풀려 165줄이 true를 답하고 348–353줄이 **디렉터리 밖 파일을 지운다**. 리뷰어가 빌드 산출물 + 실 NTFS로 재현: `{"swapped":true,"sentinelCleared":1,"sentinelFailure":null,"originalMarkerStillExists":true,"outsideFileStillExists":false}` | **고침 `6e7d529`.** 판정의 기준점을 **움직이지 않는 값**으로 바꿨다. (1) reparse-point 검사를 통과한 직후, **목록을 읽기 전에** `realPath(dir)`로 승인된 루트를 한 번 고정한다(`list()`도 그 고정값으로 부른다). (2) 각 후보는 `canonicalFile(root, name)`이 그 고정 루트에 대해서만 판단한다 — `lstat`으로 일반 파일인지 보고, `realpath(후보)`가 `isInside(고정 루트, …)`일 때만 **그 canonical 경로를 돌려준다**. 여기서 루트를 다시 `realpath`하지 않는 것이 핵심이다. (3) 삭제는 `remove(그 canonical 경로)` — `join(config 경로, name)`을 다시 만들지 않으므로 config에 적힌 자리가 링크로 바뀌어도 그 링크를 타지 않는다. 모양은 T17 `sweep.ts`의 `canonicalTarget`(고정 `realRoot` + "확인한 그 경로를 지운다")과 같다 |

### 남는 창 — 닫지 못했고, 닫았다고 쓰지 않는다

`realpath(후보)`를 확인한 뒤 `unlink`이 실행되기까지의 순간은 **여전히 열려 있다.** Node는 `openat`/`unlinkat`을 노출하지 않아 "검사한 그 핸들의 디렉터리 항목을 지운다"를 표현할 방법이 없고, `fs.rm`은 언제나 경로를 다시 해석한다. 그 사이에 정확히 끼어드는 교체는 이긴다.

막히는 것은 리뷰어가 실제로 쓴 두 가지다 — **루트 교체**(round 2 B1)와 **항목의 링크 교체**(round 1 B1) — 그리고 주장하는 것도 딱 그만큼이다. `windows-host.md` 5.7도 같은 문장으로 고쳤다. 덧붙이자면 이 경로가 지우는 대상은 `%APPDATA%` 아래 사용자 소유 디렉터리이고 거기에 쓸 수 있는 주체는 이미 이 계정의 프로세스이므로, 남은 창이 실제 위험이 되는 상황은 그 계정이 이미 침해된 경우다. 그래도 "닫았다"고는 쓰지 않는다.

### 새 테스트 (`apps/server/src/obs/process.test.ts`, 29 → 31건)

- **실 파일시스템 1건 (리뷰어 시나리오 그대로)** — `describe('nodeObsSentinelFs when the root is swapped after the listing (review round 2, B1)')`. 실제 `.sentinel`과 sibling `outside`를 만들고 **양쪽에 같은 이름(`run_1234`)**을 둔다. `list`만 감싼 wrapper(나머지는 `nodeObsSentinelFs` 그대로)가 실제 목록을 읽은 **직후** `renameSync(.sentinel → .sentinel-moved)` + `symlinkSync(outside, .sentinel, 'junction')`으로 루트를 바꿔치기한다. 기대: `sentinelCleared` 0, `sentinelFailure` `sentinel_entry_escaped_dir`, `outside\run_1234` 내용까지 그대로, 옮겨진 진짜 표식도 그대로, 그리고 **spawn은 1회**(지우기 거부가 기동 거부가 되지 않는다).
- **주입 fs 1건** — `realPath`가 `ENOENT`를 던지는 경우도 "지울 것 없음"이다(고정 루트를 목록보다 먼저 잡으니, 크래시한 적 없는 호스트에서는 `list`가 아니라 `realPath`가 부재를 알린다).
- 기존 실 파일시스템 4건·주입 5건은 그대로 남기고 포트 시그니처 변경만 반영했다. `isContainedFile`의 실 파일시스템 단언은 `canonicalFile`로 옮겨 **돌려주는 경로가 곧 지워지는 경로**임을 단언한다(`toBe(join(root, 'run_1234'))`).

### 이 테스트가 실제로 그 버그를 잡는지 확인

새 테스트가 회귀를 진짜로 잡는지 보려고, 프로덕션 코드만 round 1 의미(`isInside(realpathSync.native(root), real)` — 즉 삭제 시점에 루트를 다시 푸는 것)로 되돌리고 같은 테스트를 돌렸다:

```text
$ npx vitest run apps/server/src/obs/process.test.ts -t "replaced by a junction after the listing"
 × deletes nothing when the approved root is replaced by a junction after the listing
AssertionError: expected 1 to be +0        // result.sentinelCleared
```

단언 순서를 바꿔 파일 쪽을 먼저 보면 리뷰어가 본 값이 그대로 나온다:

```text
AssertionError: expected false to be true  // existsSync(outside\run_1234)
```

즉 되돌린 코드에서는 **디렉터리 밖 `run_1234`가 실제로 삭제됐다**(리뷰어의 `outsideFileStillExists:false`와 같다). 고친 코드에서는 31건 전부 통과한다. 두 실험 뒤 코드와 단언 순서는 원래대로 되돌렸다.

### 게이트 재실행 (round 2 고침 후)

`git fetch origin && git rebase origin/main`(base `427e7b5`, 충돌 없음) 후 5개를 돌렸다.

```text
$ npm run format:check   → All matched files use Prettier code style!
$ npm run lint           → eslint exit 0; legacy imports 0; install scripts 4 reviewed
$ npm run typecheck      → tsc --build tsconfig.json, exit 0
$ npm run test           → Test Files 138 passed (138)
                           Tests 1905 passed | 1 skipped (1906)
$ npm run build          → contract schema up to date, renderer/server/simulator/soak 빌드, exit 0
```

push는 `--force-with-lease`(`e08c489...<head>`). PR CI <!-- CI_ROUND2 -->

## Not done / out of scope

- safe-mode 대화상자를 UI 자동화로 누르는 것, OBS 재설치, 씬/프로파일 파일 변경 — 명세의 범위 밖.
- 실제 OBS를 띄운 end-to-end 확인 — 위 "수동 확인" 참조(코디네이터가 2026-08-18에 관측, BOARD E-7).
- `docs/tasks/BOARD.md` 갱신 — 코디네이터 소유.
- OBS가 `.sentinel` 안에 **디렉터리**를 만드는 경우는 지우지 않는다(관측된 내용물은 `run_*` 파일뿐이고, 모르는 것을 재귀 삭제하지 않는다).

## Follow-ups

- OBS를 32.0.2 밖으로 올릴 때 `.sentinel`의 이름·위치·의미가 그대로인지 다시 확인한다(`windows-host.md` 5.7 caveat). 무력화되면 조용히 실패하는 것이 아니라 자동시작 3단계가 타임아웃으로 잡아내지만, 그 시점은 이미 방송이 안 뜬 뒤다.
- E-7 관측이 가리키는 **진짜** 크래시(WASAPI ↔ obs-browser 종료 경합)는 이 PR이 고치지 않는다. `vertical-live` 씬 컬렉션에는 WASAPI 오디오 입력이 없지만, 오디오를 넣을 때 같은 경합을 다시 만날 수 있다.
