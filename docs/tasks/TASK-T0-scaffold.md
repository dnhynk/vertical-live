# TASK-T0-scaffold

- Task: T0 모노레포 스캐폴드·CI (`docs/tasks/TASK_SPECS.md` §T0)
- Branch: `dnhynk/t0-scaffold` · PR: #(TBD)
- Orca: task `task_658a82e9f356` · dispatch `ctx_2bbec19ecc18`
- Spec sections read: §10.1, §10.2, §10.4, §16, §17 (+ `CLAUDE.md`, `docs/tasks/TASK_SPECS.md` 공통 규약·§T0, `docs/runbooks/agent-orchestration.md` 3장)
- BOARD decisions/assumptions relied on: D-1, D-2, D-4, A-6, A-10, A-12, A-14

## Goal

이후 T1–T17이 전부 같은 툴체인 위에서 돌도록 npm workspaces 모노레포(`packages/contract`, `apps/server`, `apps/renderer`, `tools/simulator`) 뼈대와 루트 게이트(`format:check`/`lint`/`typecheck`/`test`/`build`), GitHub Actions CI(job `ci`)를 만든다. 기존 Vite 프로토타입은 동작을 유지한 채 `apps/renderer`로 옮기고, 스펙 §10.4가 production 경로에서 제외한 자산(`server.py`, `extension/`, `artifacts/`)은 `legacy/`로 격리해 어떤 워크스페이스도 import하지 않음을 게이트로 강제한다. 기능 구현·계약 정의·렌더러 개편은 범위 밖이다.

## Plan

1. 파일 이동(git mv, 내용 변경 없음)
   - `index.html`, `vite.config.js`, `public/`, `src/` → `apps/renderer/`
   - `server.py`, `extension/`, `artifacts/` → `legacy/` + `legacy/README.md`(§10.4 근거 명시)
2. 루트 툴체인
   - 루트 `package.json`: private workspaces `["packages/*", "apps/*", "tools/*"]`, `"type":"module"`, `engines.node >=24`, 스크립트 `format`/`format:check`/`lint`/`typecheck`/`test`/`build`/`dev`
   - `.nvmrc`(24), `.editorconfig`, `tsconfig.base.json`(TS5 strict, ESM NodeNext, composite), 루트 `tsconfig.json`(project references solution)
   - `eslint.config.js`: flat config 하나로 워크스페이스 전체 — TS(typescript-eslint) + 렌더러 JSX(react-hooks/react-refresh, 기존 규칙 보존) + prettier 충돌 해제
   - `.prettierrc.json`, `.prettierignore`
   - `vitest.config.ts`: 루트 1개 프로젝트, `{packages,apps,tools}/*/src/**/*.test.ts`
3. 워크스페이스 최소 내용
   - `packages/contract`: `CONTRACT_VERSION = 1` export + 테스트. **스키마는 만들지 않는다**(이 task는 `[contract]` 아님 — T1 소관)
   - `apps/server`: `node:http` 기반 최소 서버, `GET /health` → `{status:"ok"}`; 성공 경로와 404 거부 경로 둘 다 테스트
   - `apps/renderer`: 이동한 Vite 앱 + `@vl/renderer` package.json(dev/build/preview)
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
| (기재 예정) | | |

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

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | 새 clone에서 `npm ci && lint && typecheck && test && build` 통과 | met | `git clone --branch dnhynk/t0-scaffold` 한 새 디렉터리에서 5개 게이트 전부 통과 — 아래 "Gates (executed) — fresh clone" 블록 |
| 2 | `npm run dev -w @vl/renderer`로 기존과 같이 뜬다 | met | 아래 "Gates (executed) — renderer dev server" 블록. Vite 7.2.4 ready, `GET /` 200(기존 `index.html`), `GET /src/main.jsx` 200(JSX 변환됨), `GET /pet.glb` 200 52796 bytes(이동한 `apps/renderer/public/`에서 서빙) |
| 3 | CI가 PR에서 녹색 | (PR 생성 후 기재) | `.github/workflows/ci.yml` job `ci` — 로컬에서 같은 5개 게이트가 통과함을 확인 |
| 4 | `legacy/`가 어떤 워크스페이스에서도 import되지 않음 | met | `scripts/check-no-legacy-imports.mjs`가 `npm run lint`에 포함. 위반을 넣었을 때 exit 1(아래 negative test), 제거하면 exit 0 |

### Gates (executed) — fresh clone

```text
$ git clone --branch dnhynk/t0-scaffold --single-branch https://github.com/dnhynk/vertical-live.git <scratch>/fresh
$ cd <scratch>/fresh && git log --oneline -1
ce511b2 chore(repo): scaffold npm workspaces, TS/vitest/eslint toolchain and CI

$ npm ci                    -> ok (production 취약점 0건; dev 툴체인 취약점은 아래 Follow-ups)
$ npm run format:check      -> Checking formatting... All matched files use Prettier code style!
$ npm run lint              -> eslint 위반 0건; check-no-legacy-imports: ok (0 legacy imports)
$ npm run typecheck         -> tsc --build tsconfig.json (출력 없음 = 오류 0)
$ npm run test              -> RUN v4.1.10 / Test Files 3 passed (3) / Tests 10 passed (10)
$ npm run build             -> @vl/contract tsc --build / @vl/renderer vite build (610 modules, built in 13.48s)
                               / @vl/server tsc --build / @vl/simulator tsc --build
```

같은 5개 게이트를 작업 worktree에서도 먼저 통과시켰다(동일 결과).

### Gates (executed) — renderer dev server

```text
$ npm run dev -w @vl/renderer -- --port 5199 --strictPort
  VITE v7.2.4  ready in 606 ms
  ➜  Local:   http://localhost:5199/

$ node -e "fetch(...)"
GET /              -> 200  (<!doctype html> ... <title>vertical-live</title>, react-refresh 주입됨)
GET /src/main.jsx  -> 200  (import __vite__cjsImport0_react_jsxDevRuntime ... = JSX 변환 정상)
GET /pet.glb       -> 200  bytes=52796
```

### Gates (executed) — legacy import 게이트 negative test

```text
$ printf "import x from '../../legacy/server.py'\nexport default x\n" > apps/server/src/__tmp_legacy_probe.ts
$ node scripts/check-no-legacy-imports.mjs
legacy/ must not be imported from any workspace (spec §10.4):
  apps/server/src/__tmp_legacy_probe.ts:1 imports '../../legacy/server.py'
exit=1
$ rm apps/server/src/__tmp_legacy_probe.ts && node scripts/check-no-legacy-imports.mjs
check-no-legacy-imports: ok (0 legacy imports)
exit=0
```

### 이동 시 발생한 유일한 내용 변경

`apps/renderer/src/{App.jsx,store.js,index.css,components/Pet.jsx,components/Background.jsx}`는 `prettier --write`로 포맷만 바뀌었다(BOM 제거·들여쓰기·세미콜론). 로직 변경 없음. 그 결과 git이 일부 파일을 rename이 아닌 delete+add로 표시한다.

## Not done / out of scope

- 계약 스키마(T1), 렌더러 read model·TS 전환(T5), 서버 기능(T4·T8), 시뮬레이터 시나리오(T11)
- `README.md`·`docs/ROADMAP.md` 전면 정합화(T16)
- `packages/contract`의 스키마: 이 task는 `[contract]`가 아니므로 `CONTRACT_VERSION` 상수 외에는 만들지 않았다
- 워크스페이스 간 import(`@vl/server` → `@vl/contract` 등): T0 범위가 "최소 export + 테스트"이므로 배선만 두고 실제 사용은 T1 이후

## 알려진 carry-over (코디네이터 판단 요청 — Questions 표 참조)

`apps/renderer/src/store.js`·`App.jsx`는 프로토타입 상태 그대로 옮겼고, 그 안에는 로컬 데모용 **임의 사용자명 생성**(`TEST_NAMES = ['Sora', ...]`, `randomName()`)과 이벤트 로그의 **표시명 출력**이 남아 있다. §T0가 "동작 유지, 렌더러 개편은 범위 밖, TS 전환은 T5"라고 못박아 그대로 옮겼으나, `CLAUDE.md` §3의 "가짜 참여를 만들지 않는다"·"표시명을 저장·표시하지 않는다"와 충돌한다. 스펙 §16이 `src/store.js`를 "서버 snapshot의 projection이 되어야 함"이라 판단했으므로 T5에서 제거되는 코드다.

## Follow-ups

- **T5**: `store.js`의 로컬 임의 사용자명·표시명 출력 제거(서버 snapshot projection으로 대체), 렌더러 TS 전환 시 루트 `tsconfig.json` references에 `apps/renderer` 추가
- **T5**: 워크스페이스별 vitest 환경 분리(jsdom 등) — 렌더러 테스트가 생기는 시점
- **dev 의존성 보안**: `npm audit --omit=dev` = 0건이지만 dev 툴체인에 high 9건이 있다. 유일한 직접 의존은 `vite@7.2.4`(dev server path traversal / `server.fs.deny` 우회, 수정본 7.3.6, semver-minor). 나머지는 eslint·babel·rollup의 transitive. T0에서는 "이동한 앱의 동작 유지"를 위해 버전을 그대로 뒀다 — 코디네이터 판단에 따라 이 PR이나 후속 task에서 올린다
- `apps/renderer`에는 아직 테스트가 없다(T5가 read model과 함께 추가)
