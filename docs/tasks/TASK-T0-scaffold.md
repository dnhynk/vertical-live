# TASK-T0-scaffold

- Task: T0 모노레포 스캐폴드·CI (`docs/tasks/TASK_SPECS.md` §T0 — 2026-08-16 R-T0-1 리뷰 결과로 재기술된 판, `main` 커밋 `8740d2a`)
- Branch: `dnhynk/t0-scaffold` · PR: #1
- Orca: task `task_658a82e9f356` · dispatch `ctx_2bbec19ecc18` / fix task `task_f975de15c117` · dispatch `ctx_e41e5249c369`(F-T0-1, review round 1 fix)
- Spec sections read: §10.1, §10.2, §10.4, §16, §17 (+ `CLAUDE.md`, `docs/tasks/TASK_SPECS.md` 공통 규약·§T0, `docs/runbooks/agent-orchestration.md` 3장)
- BOARD decisions/assumptions relied on: D-1, D-2, D-4, A-6, A-10, A-12, A-14

## Goal

이후 T1–T17이 전부 같은 툴체인 위에서 돌도록 npm workspaces 모노레포(`packages/contract`, `apps/server`, `apps/renderer`, `tools/simulator`) 뼈대와 루트 게이트(`format:check`/`lint`/`typecheck`/`test`/`build`), GitHub Actions CI(job `ci`)를 만든다. 기존 Vite 프로토타입 중 **R3F 장면 자산만** `apps/renderer`로 옮기고, 스펙 §10.4·§16이 production 경로에서 제외한 자산(`server.py`, `extension/`, `artifacts/`, 그리고 프로토타입 게임 로직·로컬 테스트 패널·overlay)은 `legacy/`로 격리해 어떤 워크스페이스도 import하지 않음을 게이트로 강제한다. 기능 구현·계약 정의·렌더러 개편은 범위 밖이다.

## Plan

1. 파일 이동(git mv)
   - `index.html`, `vite.config.js`, `public/`, `src/` → `apps/renderer/`
   - `server.py`, `extension/`, `artifacts/` → `legacy/` + `legacy/README.md`(§10.4 근거 명시)
   - **(review round 1 추가)** 프로토타입 게임 store·로컬 테스트 패널·overlay(`store.js`, 구 `App.jsx`, 그 UI용 `index.css`, 미사용 Vite 템플릿 잔재) → `legacy/renderer-prototype/`. `apps/renderer`에는 R3F 장면 자산만 남긴다
2. 루트 툴체인
   - 루트 `package.json`: private workspaces `["packages/*", "apps/*", "tools/*"]`, `"type":"module"`, `engines.node >=24`, 스크립트 `format`/`format:check`/`lint`/`typecheck`/`test`/`build`/`dev`
   - `.nvmrc`(24), `.editorconfig`, `tsconfig.base.json`(TS5 strict, ESM NodeNext, composite), 루트 `tsconfig.json`(project references solution)
   - `eslint.config.js`: flat config 하나로 워크스페이스 전체 — TS(typescript-eslint) + 렌더러 JSX(react-hooks/react-refresh, 기존 규칙 보존) + prettier 충돌 해제
   - `.prettierrc.json`, `.prettierignore`
   - `vitest.config.ts`: 루트 1개 프로젝트, `{packages,apps,tools}/*/src/**/*.test.ts`
3. 워크스페이스 최소 내용
   - `packages/contract`: `CONTRACT_VERSION = 1` export + 테스트. **스키마는 만들지 않는다**(이 task는 `[contract]` 아님 — T1 소관)
   - `apps/server`: `node:http` 기반 최소 서버, `GET /health` → `{status:"ok"}`; 성공 경로와 404 거부 경로 둘 다 테스트
   - `apps/renderer`: R3F 장면(`main.jsx`, 9:16 캔버스만 마운트하는 최소 `App.jsx`, `components/{Pet,Background}.jsx`, 최소 `index.css`, `public/pet.glb`) + `@vl/renderer` package.json(dev/build/preview). `Pet.jsx`는 store 대신 시각 전용 props(idle 기본값)만 읽는다
   - `tools/simulator`: 빈 CLI 뼈대(usage 출력 / 알 수 없는 명령 거부) + 두 경로 테스트
4. `legacy` import 0 강제: `scripts/check-no-legacy-imports.mjs`를 `npm run lint`에 연결(합격 기준 4의 실행 근거)
5. `.github/workflows/ci.yml`: job id/name `ci`, PR + `main` push, Node 24, `npm ci` → format:check → lint → typecheck → test → build
6. `README.md` 상단에 새 구조·실행법 요약(정식 재작성은 T16)
7. 검증: 로컬 게이트 5개 + **새 clone에서 `npm ci` 후 게이트 재실행** + `npm run dev -w @vl/renderer` 기동 로그

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| Node 24 릴리스 라인 | https://nodejs.org/en/about/previous-releases | 2026-08-16 | Node 24 = Active LTS 라인. 호스트 실측 `node -v` = v24.11.1, `npm -v` = 11.6.2 → `.nvmrc` `24`, `engines.node` `>=24.0.0` |
| npm workspaces | https://docs.npmjs.com/cli/v11/using-npm/workspaces | 2026-08-16 | 루트 `workspaces` 글롭 + `npm run <script> --workspaces --if-present`로 워크스페이스 전체 실행 |
| TypeScript project references / `tsc --build` | https://www.typescriptlang.org/docs/handbook/project-references.html | 2026-08-16 | `composite: true` + 루트 solution tsconfig의 `references`로 참조 순서대로 typecheck·빌드 |
| ESLint 9 flat config | https://eslint.org/docs/latest/use/configure/configuration-files | 2026-08-16 | `eslint.config.js` 하나로 루트에서 전 워크스페이스 lint. `ignores`는 최상위 객체에 단독으로 |
| Vitest 설정 | https://vitest.dev/config/ | 2026-08-16 | 루트 `vitest.config.ts`의 `test.include` 글롭으로 전 워크스페이스 테스트 수집 |
| GitHub Actions `actions/setup-node` | https://github.com/actions/setup-node | 2026-08-16 | `node-version: 24` + `cache: npm`, 이후 `npm ci` |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (1) 옮겨온 `store.js`/`App.jsx`의 임의 사용자명 생성·표시명 출력이 `CLAUDE.md` §3과 충돌한다. 그대로 둘까(1A) / T0에서 제거할까(1B) / 렌더러도 legacy로 보낼까(1C)? | **1A**. §T0가 "동작 유지·렌더러 개편 범위 밖", 스펙 §16이 store.js를 T5에서 대체 예정으로 판단. 단 두 파일 맨 위에 동작 변화 없는 표식 주석 1줄을 넣고 티켓·PR에 명시할 것 | 두 파일 맨 위에 표식 주석 추가, 티켓 "알려진 carry-over"·Follow-ups·PR "Scope exclusions"에 기재 |
| (2) `vite@7.2.4`의 dev server 취약점(수정본 7.3.6, semver-minor)을 이 PR에서 올릴까(2A) / 후속 task로 뺄까(2B)? | **2A**. 7.3.6 exact로 올리고 게이트 전부 재실행. 남은 transitive high는 티켓 Follow-ups에 기록만 | `apps/renderer`의 `vite`를 `7.3.6` exact로 고정, 게이트 5종 + 렌더러 기동 재검증, Follow-ups에 잔여 항목 기록 |
| (3, round 1 fix) F-T0-1 디스패치는 "§T0가 main에서 갱신됨"이라 했으나 fetch 시점의 `origin/main`은 여전히 `62ba511`이고 `TASK_SPECS.md`에 변경이 없었다. 합격 기준 2를 (A) 디스패치 재기술 출처로 명시 / (B) 내가 정본을 직접 수정 / (C) 코디네이터 push를 기다렸다가 인용, 중 무엇으로 적을까? | **C**. 이미 push되어 있다 — `origin/main` = `8740d2a`. rebase 후 갱신된 §T0의 범위 문단과 합격 기준 2 문구를 그대로 인용할 것(정본은 worker가 고치지 않는다). rebase 후 게이트 재실행 결과를 반영하고 `--force-with-lease`로 push | `git fetch && git rebase origin/main`(`8740d2a`) 후 게이트 5종 재실행, 합격 기준 표를 §T0 재기술판 문구로 교체, `git push --force-with-lease` |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| dependency 버전 | 전부 exact pin | 결정(A-6) | A-6 "dependency exact version". 기존 caret 범위는 **현재 lockfile이 이미 해석한 버전 그대로** 고정 → 동작 변화 없음 |
| 루트 `typecheck` 범위 | `packages/contract`, `apps/server`, `tools/simulator` (TS) | 결정 | `apps/renderer`는 T0에서 JSX 그대로 유지(§T0 "TS 전환은 T5") → TS 프로젝트 참조에 넣지 않는다. 렌더러 typecheck는 T5 |
| prettier 대상에서 `**/*.md` 제외 | `.prettierignore` | 가정 | 정본 문서(`PROJECT_SPEC.md`)·코디네이터 소유 `BOARD.md`를 재포맷하면 정본 훼손 + main 직접 커밋과 충돌. 문서 포맷 규칙은 T16에서 결정 |
| `legacy/` lint·format 제외 | ignore | 가정 | 스펙 §10.4가 production 경로에서 제외한 참고용 스냅샷. 대신 "legacy import 0"은 게이트로 강제 |
| 워크스페이스 간 import | T0에서 없음 | 가정 | §T0 "최소 export + 테스트" 범위. `@vl/server`가 `@vl/contract`를 쓰는 것은 T1 이후 |

## Result

### Acceptance criteria

기준 문구는 `main`의 `docs/tasks/TASK_SPECS.md` §T0(커밋 `8740d2a`, R-T0-1 리뷰 결과 재기술판)를 그대로 인용한다.

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 새 clone에서 `npm ci && npm run lint && npm run typecheck && npm run test && npm run build`가 통과한다(출력을 티켓에 첨부) | met | 아래 "Gates (executed) — fresh clone" 블록(HEAD `c03abc6`) |
| 2 | `apps/renderer`가 `npm run dev -w @vl/renderer`로 떠서 R3F 장면(Background+Pet idle)을 9:16으로 렌더한다(스크린샷 또는 로그). `apps/renderer` 안에 이름 표시·결제 처리·사망·Pokemon 문자열이 없다(grep 증빙) | met | 아래 "Gates (executed) — renderer dev server(9:16 R3F 장면)"와 "Gates (executed) — 금지 패턴 grep" 블록. dev 서버가 `App.jsx`(Canvas+Background+Pet)·`Pet.jsx`·`Background.jsx`·`index.css`를 200으로 서빙하고, 서빙된 `index.css`에 `aspect-ratio: 9 / 16`이 있으며, 활성 워크스페이스 금지 패턴 grep은 0건(legacy 대조군 55건) |
| 3 | CI가 PR에서 녹색이다 | met | PR #1, workflow `CI` job `ci` — round 1 이전 head `708e855`에서 run 31950064753 success. round 2 head의 결과는 PR 본문·`gh pr checks 1`로 확인(worker_done에 기재) |
| 4 | `legacy/`로 이동한 코드는 어떤 워크스페이스에서도 import되지 않는다 | met | `scripts/check-no-legacy-imports.mjs`가 `npm run lint`에 포함. `legacy/renderer-prototype/`을 import하는 파일을 심었을 때 exit 1, 제거하면 exit 0(아래 negative test) |

### Gates (executed) — fresh clone

```text
$ git clone --branch dnhynk/t0-scaffold --single-branch https://github.com/dnhynk/vertical-live.git <scratch>/fresh3
$ cd <scratch>/fresh3 && git log --oneline -1
c03abc6 fix(renderer): keep only the R3F scene, move the prototype UI to legacy

$ npm ci                    -> added 270 packages, and audited 275 packages in 24s
$ npm run format:check      -> Checking formatting... All matched files use Prettier code style!
$ npm run lint              -> eslint 위반 0건; check-no-legacy-imports: ok (0 legacy imports)
$ npm run typecheck         -> tsc --build tsconfig.json (출력 없음 = 오류 0)
$ npm run test              -> Test Files 3 passed (3) / Tests 10 passed (10)
$ npm run build             -> @vl/contract tsc --build
                               / @vl/renderer vite v7.3.6, 609 modules transformed, built in 23.93s
                               / @vl/server tsc --build / @vl/simulator tsc --build
$ npm audit                 -> 10 vulnerabilities (1 low, 1 moderate, 8 high)   [전부 dev-only transitive]
$ npm audit --omit=dev      -> found 0 vulnerabilities
```

같은 5개 게이트를 `origin/main`(`8740d2a`) rebase 후 작업 worktree에서도 재실행해 통과했다(동일 결과, renderer 609 modules / 7.29s).

### Gates (executed) — renderer dev server (9:16 R3F 장면)

```text
$ npm run dev -w @vl/renderer -- --port 5203 --strictPort
  VITE v7.3.6  ready  ->  http://localhost:5203/

$ node -e "fetch(...)"
/                                 -> 200  len=617
/src/main.jsx                     -> 200  len=2018
/src/App.jsx                      -> 200  len=7097
/src/components/Pet.jsx           -> 200  len=8976
/src/components/Background.jsx    -> 200  len=7992
/src/index.css                    -> 200  len=1373
/pet.glb                          -> 200  bytes=52796
aspect-ratio 9/16 in served index.css: true
forbidden pattern in served renderer modules: none

$ node -e "fetch(...)"   # 서빙된 모듈 내용 확인
App.jsx serves Canvas: true
App.jsx serves Background: true
App.jsx serves Pet: true
App.jsx class stage present: true
Pet.jsx imports a store: false
Pet.jsx idle constants: true
```

**실행하지 않았음: 브라우저 픽셀 단위 렌더 확인(스크린샷).** 이유: headless 브라우저(puppeteer/playwright) 의존성 추가가 §T0 범위 밖이다. 대신 위와 같이 (a) dev 서버가 장면 모듈 전부를 200으로 서빙하고, (b) 서빙된 `App.jsx`가 `Canvas`+`Background`+`Pet`을 마운트하며, (c) 서빙된 `index.css`가 `aspect-ratio: 9 / 16`을 갖고, (d) `vite build`가 609 modules를 오류 없이 번들한다는 로그로 대신했다.

### Gates (executed) — 금지 패턴 grep (합격 기준 2 후단)

```text
$ PAT='Pokemon|Pok[eé]mon|authorName|userName|channelId|displayName|revive|isDead|forceDeath|fainted|amountMicros|valueMicros|SUPER_CHAT|SUPER_STICKER|JEWEL|randomName|TEST_NAMES|localNames'

$ grep -rniE "$PAT" apps/renderer/src apps/renderer/index.html apps/renderer/vite.config.js apps/renderer/package.json | wc -l
0

# 활성 워크스페이스 전체(packages, apps, tools, scripts; node_modules·dist 제외)
$ grep -rniE "$PAT" packages apps tools scripts --include='*.ts' --include='*.tsx' --include='*.js' \
    --include='*.jsx' --include='*.mjs' --include='*.css' --include='*.html' --include='*.json' | wc -l
0

# 대조군(패턴이 실제로 매칭됨을 보이기 위한 positive control)
$ grep -rniE "$PAT" legacy/renderer-prototype | wc -l
55
```

### Gates (executed) — legacy import 게이트 negative test

```text
$ printf "import store from '../../../legacy/renderer-prototype/store'\nexport default store\n" \
    > apps/renderer/src/__tmp_legacy_probe.jsx
$ node scripts/check-no-legacy-imports.mjs
legacy/ must not be imported from any workspace (spec §10.4):
  apps/renderer/src/__tmp_legacy_probe.jsx:1 imports '../../../legacy/renderer-prototype/store'
exit=1
$ rm apps/renderer/src/__tmp_legacy_probe.jsx && node scripts/check-no-legacy-imports.mjs
check-no-legacy-imports: ok (0 legacy imports)
exit=0
```

(round 1에서는 같은 검사를 `apps/server` + `legacy/server.py`로도 통과시켰다.)

### `apps/renderer`의 최종 파일 목록

```text
apps/renderer/index.html
apps/renderer/package.json
apps/renderer/vite.config.js
apps/renderer/public/pet.glb
apps/renderer/public/vite.svg
apps/renderer/src/main.jsx
apps/renderer/src/App.jsx                    (신규 — 9:16 캔버스에 Background + Pet idle만)
apps/renderer/src/index.css                  (신규 — 스테이지 레이아웃만)
apps/renderer/src/components/Pet.jsx         (store 의존 제거, 시각 전용 props)
apps/renderer/src/components/Background.jsx  (변경 없음)
```

### 렌더러 파일에 가한 변경

1. **이동(round 1 fix)**: `store.js`, 구 `App.jsx`, 프로토타입 `index.css`, 미사용 Vite 템플릿 잔재(`App.css`, `assets/react.svg`) → `legacy/renderer-prototype/`.
   프로토타입 `index.css`를 함께 옮긴 이유: 그 스타일시트는 제거된 overlay·패널 전용 규칙(`.fainted-panel`, `.event-log-item`, `.stat-fill` 등)이 대부분이고, `fainted` 같은 **금지 패턴 문자열을 포함**해 활성 워크스페이스에 두면 합격 기준 2의 grep을 통과할 수 없다. 대신 스테이지 레이아웃만 담은 최소 `index.css`를 새로 썼다.
2. **`components/Pet.jsx`**: `usePetStore` 의존 제거. `isEating`만 시각 전용 prop(기본값 `false`)으로 남기고 idle 자세 상수(`IDLE_COLOR`/`IDLE_SCALE`/`IDLE_POSITION_Y`/`IDLE_SPIN_SPEED`)로 렌더한다. 사망 자세·색 분기(`isDead`), 능력치 기반 색·속도 분기, `Dance`/`BigGift`/`Revive` 결제 연출 코드는 삭제했다.
3. **`components/Background.jsx`**: 변경 없음(셰이더 그라디언트, 상태 의존 없음).
4. **round 1 이전 커밋의 포맷 변경**: 이동 시 `prettier --write`로 포맷만 바뀌었다(로직 변경 없음). 그 결과 git이 일부 파일을 rename이 아닌 delete+add로 표시한다.
5. `index.html`, `vite.config.js`, `public/`, `main.jsx`는 내용 변경 없이 경로만 바뀌었다.

## Not done / out of scope

- 계약 스키마(T1), 렌더러 read model·TS 전환(T5), 서버 기능(T4·T8), 시뮬레이터 시나리오(T11)
- `README.md`·`docs/ROADMAP.md` 전면 정합화(T16)
- `packages/contract`의 스키마: 이 task는 `[contract]`가 아니므로 `CONTRACT_VERSION` 상수 외에는 만들지 않았다
- 워크스페이스 간 import(`@vl/server` → `@vl/contract` 등): T0 범위가 "최소 export + 테스트"이므로 배선만 두고 실제 사용은 T1 이후

## 알려진 carry-over — 해소됨 (review round 1)

**이전 상태(round 1 이전, 코디네이터 결정 1A):** 프로토타입 게임 store와 로컬 테스트 패널·overlay를 `apps/renderer`에 그대로 둔 채 표식 주석만 달았다. 리뷰어가 이것을 blocker 4건으로 판정했고(결제→부활·성장·게임 파워, 표시명·raw chat 표시, 크리처 사망, Pokemon 문자열), 코디네이터가 **1A를 폐기**하고 §T0/§T5를 재기술했다(`main` `8740d2a`).

**현재 상태:** `apps/renderer`에 프로토타입 게임 코드가 **남아 있지 않다.** `store.js`·구 `App.jsx`·프로토타입 `index.css`·미사용 Vite 템플릿 잔재는 `legacy/renderer-prototype/`으로 옮겼고(`legacy/README.md`에 제외 근거 기재), 활성 워크스페이스 금지 패턴 grep은 0건이다(위 "금지 패턴 grep" 블록). 이동한 두 파일의 표식 주석은 현재 사실에 맞게 갱신했다:

```js
// PROTOTYPE (pre-spec v1) — moved out of apps/renderer during T0 review round 1. Reference only: not a production path, not imported by any workspace (see legacy/README.md).
```

`legacy/` 안에 남은 프로토타입 코드 자체는 스펙 §10.4·§16이 정한 참고용 스냅샷이며 어떤 워크스페이스도 import하지 않는다(합격 기준 4의 게이트로 강제).

## Review round 1

리뷰: PR #1 [pullrequestreview-4946334599](https://github.com/dnhynk/vertical-live/pull/1#pullrequestreview-4946334599), verdict `request_changes`. fix 커밋은 전부 `c03abc6`(`fix(renderer): keep only the R3F scene, move the prototype UI to legacy`) — 리뷰가 지적한 4개 blocker가 같은 원인(활성 렌더러에 남은 프로토타입 게임 코드)이라 하나의 커밋으로 처리했다. 문서 갱신은 뒤따르는 `docs(tasks)` 커밋.

| finding | 처리(고침 SHA / 반박 근거) |
|---|---|
| [blocker] `apps/renderer/src/store.js:117` — `SUPER_CHAT`/`SUPER_STICKER`/`GIFT`가 `canRevive`에 있고 결제 tier가 life·hunger·evolution XP를 올린다. `App.jsx:104`는 "Send a paid revive event". 결제가 생존·부활·성장·게임 파워를 삼(§2.4, §8.5, `CLAUDE.md` §3) | **고침** `c03abc6` — 해당 store와 패널을 `legacy/renderer-prototype/`으로 이동. 활성 렌더러에는 결제·부활 경로가 존재하지 않는다(grep `revive|amountMicros|valueMicros|SUPER_CHAT` = 0건). `Pet.jsx`의 `BigGift`/`Revive` 연출 분기도 삭제 |
| [blocker] `apps/renderer/src/store.js:26` — `event.user.name`/`event.authorName`과 raw `event.message`를 `userName`/`message`로 저장하고 `App.jsx:110·112·119`가 표시. `store.js:146`은 raw CHAT 텍스트를 label로 사용. identity gate·raw chat 규칙 위반(§12.3, §12.4, `CLAUDE.md` §3) | **고침** `c03abc6` — 같은 이동. 새 `App.jsx`에는 텍스트 출력 자체가 없고(캔버스만 마운트), grep `authorName\|userName\|channelId\|displayName` = 0건 |
| [blocker] `apps/renderer/src/store.js:76` — `forceDeath`가 `isDead=true`/`life=0`을 세우고 `store.js:247`의 무입력 tick도 크리처를 죽인다. 크리처는 죽지 않는다(§6.3, `CLAUDE.md` §3) | **고침** `c03abc6` — 같은 이동. `Pet.jsx`의 사망 자세·회색 처리 분기 삭제. 활성 렌더러에 tick·수명 감소 로직이 없다(grep `isDead\|forceDeath\|fainted` = 0건) |
| [blocker] `apps/renderer/src/App.jsx:86` — 활성 렌더러가 "Pokemon Pet Lab"을 표시. Pokémon 명칭 금지(스펙 §3, `CLAUDE.md` §3) | **고침** `c03abc6` — overlay 전체가 legacy로 이동. 새 `App.jsx`에 브랜드 문자열이 없다(grep `Pokemon\|Pok[eé]mon` = 0건) |
| [minor] `docs/tasks/TASK-T0-scaffold.md:153` — vite bump 후 `npm audit` high를 4건이라 적었으나 실제로는 8건(총 10건) | **고침**(이 문서) — 아래 "audit 수치 정정" 참조. 재현 가능한 값으로 교체했다 |

### audit 수치 정정

내가 "high 9건 → 4건"이라고 쓴 것은 **`npm install` 직후 npm이 출력한 요약 줄**(`5 vulnerabilities (1 low, 4 high)`)을 그대로 옮긴 것으로, 재현 가능한 `npm audit` 결과가 아니었다. 리뷰어 수치가 맞다. 2026-08-16 기준 Node v24.11.1 / npm 11.6.2 / 이 브랜치 lockfile에서 실측:

```text
$ npm audit             -> 10 vulnerabilities (1 low, 1 moderate, 8 high)
$ npm audit --omit=dev  -> found 0 vulnerabilities
```

vite bump 전 같은 명령은 `11 vulnerabilities (1 low, 1 moderate, 9 high)`였다. 즉 **high 9 → 8**(총 11 → 10)이고, production 의존성 취약점은 전후 모두 0이다. 남은 항목은 전부 eslint·babel·rollup 경유의 dev-only transitive이며 직접 의존이 아니다(`brace-expansion`, `flatted`, `js-yaml`, `minimatch`, `nanoid`, `picomatch`, `postcss`, `rollup`, `@babel/core`, `ajv`).

## Follow-ups

- **T5**: 렌더러 read model(서버 snapshot projection·effect 멱등·ACK), TS 전환 시 루트 `tsconfig.json` references에 `apps/renderer` 추가, 워크스페이스별 vitest 환경 분리(jsdom). `Pet.jsx`의 시각 전용 props는 그때 snapshot 필드에 연결한다
- **T14**: 화면 완성(§5.2 4개 고정 정보·감사 연출·i18n). T0의 `App.jsx`는 장면만 마운트하는 최소 골격이다
- 남은 dev-only transitive audit 항목(위 "audit 수치 정정") 처리 — 직접 의존이 아니라 상위 패키지 릴리스를 기다려야 하므로 별도 task 후보
- `apps/renderer`에는 아직 테스트가 없다(T5가 read model과 함께 추가)
