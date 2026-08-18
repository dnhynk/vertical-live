# TASK-T17b-ci-path-semantics

- Task: T17b CI 버그픽스 — Windows 경로 의미론을 호스트 플랫폼에 기대는 T17 코드 (`docs/tasks/TASK_SPECS.md` §T17 후속)
- Branch: `dnhynk/t17b-ci-path-semantics` · PR: #<n>
- Orca: task `task_70edf8e8feff` · dispatch `ctx_d817d16e052d`
- Spec sections read: §9.1, §10.2, §11 (T17이 읽은 절), CLAUDE.md §7 검증 게이트
- BOARD decisions/assumptions relied on: D-2(1차 호스트 = Windows 11), A-16(stream key vault 정본), E-5(GitHub Actions 결제 차단 해제 후 첫 실제 CI)

## Goal

E-5(GitHub Actions 결제 차단)가 풀리고 main `06542ff`에서 CI가 처음으로 실제 실행되면서 `npm run test`가
3건 실패했다(run 32074894450). 세 실패 모두 원인이 하나다: **계약상 Windows 경로인 값**
(`obs.process.executablePath` = `C:\Program Files\obs-studio\bin\64bit\obs64.exe`)에 대해 `node:path`의
**호스트 플랫폼 기본 구현**으로 `dirname`/`basename`을 호출한다. 호스트가 Windows일 때는 맞지만
ubuntu runner(posix)에서는 `\`가 평범한 문자라 `dirname` → `'.'`, `basename` → 문자열 전체가 된다.
이 task는 그런 호출을 `path.win32` 구현으로 바꿔 **값의 의미론이 호스트 플랫폼과 무관하게** 결정되도록
한다. repo 경로처럼 실제로 호스트 네이티브인 값은 건드리지 않는다.

테스트를 플랫폼 조건부로 약화시키는 방식(`it.skipIf(process.platform !== 'win32')`)은 채택하지 않는다.
문제는 테스트가 아니라 **프로덕션 값이 호스트 플랫폼에 따라 달라진다는 것**이다: posix 호스트에서
`ObsProcessLauncher.plan().cwd === '.'`는 OBS를 잘못된 작업 디렉터리에서 띄우고,
`OpsConfigView.obs.executableName`이 전체 경로가 되면 `Start-VerticalLive.ps1:190`이 포트 소유자를
영영 인식하지 못한다.

## Plan

1. 가설 검증(디버깅 절차): `path.posix` / `path.win32` / 호스트 기본 구현을 실제 config 값에 돌려
   `'.'`·전체 문자열이 나오는지 관측하고, CI 로그의 assertion 문구와 일치하는지 대조한다.
2. `rg`로 `apps/server/src/{obs,ops,bin,supervisor}`의 `basename(`·`dirname(`·`sep`·`\\`·`process.platform`
   전수 조사 → **계약상 Windows 경로**에 쓰이는 것과 **호스트 네이티브 경로**에 쓰이는 것을 분류하고
   목록을 이 티켓에 남긴다.
3. Windows 경로 부류만 `import { win32 as winPath } from 'node:path'` 로 바꾼다(호스트가 Windows면
   결과 동일, posix 호스트에서도 결정적). 호스트 네이티브 부류는 그대로 둔다.
4. `process.test.ts`의 `cwd: dirname(config.executablePath)` 기대값을 리터럴로 바꾼다 — 프로덕션과 같은
   함수로 기대값을 계산하면 이 결함을 잡을 수 없는 동어반복 단언이다(실제로 이 단언은 ubuntu에서
   `'.' === '.'`로 통과했다).
5. 로컬 게이트 5개 + `soak:ci` 실행, PR 생성, **PR의 GitHub Actions run이 녹색인지 확인**.
   `build`·`soak:ci` 단계도 ubuntu에서 처음 도는 것이므로(soak:ci step은 PR #18에서 추가됐고 그때는
   E-5로 CI가 안 돌았다) 실패하면 원인을 조사해 같은 PR에서 고친다. 범위가 커지면 `orca orchestration ask`.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| `path.win32` / `path.posix` 속성 | https://nodejs.org/docs/latest-v24.x/api/path.html#pathwin32 | 2026-08-18 | `path.win32`는 "Windows 전용 path 메서드"를 제공하며 **어떤 플랫폼에서든** 접근 가능하다. `path.posix`도 대칭. 즉 win32 구현을 명시하면 호스트 플랫폼에 무관하게 같은 결과가 나온다 |
| `path.dirname` / `path.basename` | https://nodejs.org/docs/latest-v24.x/api/path.html#pathdirnamepath | 2026-08-18 | 기본 export는 실행 중인 플랫폼의 구현이다(POSIX에서 `\`는 경로 구분자가 아닌 일반 문자) |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음) | | |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `obs.process.executablePath`는 계약상 **Windows 경로**다 | `C:\Program Files\obs-studio\bin\64bit\obs64.exe` (config 기본값) | 고정 | BOARD D-2(1차 호스트 Windows 11) + `docs/ops/windows-host.md`. `tasklistObsProcessProbe`도 `process.platform !== 'win32'`이면 조회하지 않는다 |

## Result

### 조사 결과 — `apps/server/src/{obs,ops,bin,supervisor}`의 경로 함수 전수 목록

| 파일:줄 | 호출 | 대상 값의 부류 | 조치 |
|---|---|---|---|
| `obs/process.ts:72` | `basename(executablePath)` | 계약상 Windows(`obs.process.executablePath`) | **win32로 변경** (호출은 `process.platform !== 'win32'` 가드 뒤라 런타임 동작은 이미 옳았지만, 값의 의미론을 가드가 아니라 호출이 정하게 한다) |
| `obs/process.ts:140` | `dirname(this.#config.executablePath)` | 계약상 Windows | **win32로 변경** — CI 실패 (1) |
| `obs/process.ts:161` | `basename(plan.command)` | 계약상 Windows | **win32로 변경** (오류 문구용. posix 호스트에서는 전체 경로가 찍혔다) |
| `ops/ops-config.ts:91` | `basename(obs.process.executablePath)` | 계약상 Windows | **win32로 변경** — CI 실패 (2)(3) |
| `ops/ops-config.ts:74` | `resolve(dirname(configPath), '..')` | 호스트 네이티브(repo 경로, `fileURLToPath`) | 변경 없음 |
| `ops/archive/sweep.ts:10` | `isAbsolute/join/relative/resolve` | 호스트 네이티브(archive root, config 값은 `data/archive/recordings` 같은 상대 경로 → cwd 기준) | 변경 없음 |
| `ops/static-server.ts:3` | `isAbsolute/join/relative/resolve` | 호스트 네이티브(`renderer.staticDir`) | 변경 없음 |
| `bin/serve-renderer.ts:2` | `resolve` | 호스트 네이티브 | 변경 없음 |
| `supervisor/kill-switch.ts:122` | `mkdirSync(dirname(path))` | 호스트 네이티브(실제 파일시스템 경로) | 변경 없음 |
| `supervisor/screenshot.ts:2` | `join/resolve` | 호스트 네이티브(진단 디렉터리) | 변경 없음 |
| `obs/config.test.ts:3`, `obs/profile.test.ts:2`, `ops/archive/config.test.ts:3`, `ops/archive/sweep.test.ts:11`, `ops/static-server.test.ts:3`, `supervisor/config.test.ts:3` | `join/resolve` | 호스트 네이티브(tmp 디렉터리) | 변경 없음 |
| `obs/process.test.ts:1,57` | `dirname(config.executablePath)` | 계약상 Windows | **리터럴 기대값으로 교체** — 프로덕션과 같은 함수로 기대값을 만들면 결함을 못 잡는다 |

`sep`·`process.platform` 사용처: `obs/process.ts:71`의 `process.platform !== 'win32'` 가드 1건뿐(그대로 둔다.
tasklist는 Windows 전용 명령이라 플랫폼 분기가 맞다). `node:path`의 `sep` 사용 0건.

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 로컬 게이트 5개 통과 | | |
| 2 | PR의 GitHub Actions run 녹색(test 이후 build·soak:ci 포함) | | |
| 3 | 같은 부류의 다른 사용처를 전수 조사하고 목록을 남겼다 | | |

### Gates (executed)

```text
<채움>
```

## Not done / out of scope

- 테스트를 플랫폼 조건부로 skip하는 방식(명시적으로 기각)
- 호스트 네이티브 경로를 다루는 코드(위 표의 "변경 없음" 행)
- `apps/server/src` 밖(렌더러·contract·simulator·soak)의 경로 처리 — 이번 CI run에서 실패하지 않았고 Windows 경로 계약을 쓰지 않는다

## Follow-ups

- (없으면 비움)
