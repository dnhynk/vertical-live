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
| (1) 옮겨온 `store.js`/`App.jsx`의 임의 사용자명 생성·표시명 출력이 `CLAUDE.md` §3과 충돌한다. 그대로 둘까(1A) / T0에서 제거할까(1B) / 렌더러도 legacy로 보낼까(1C)? | **1A**. §T0가 "동작 유지·렌더러 개편 범위 밖", 스펙 §16이 store.js를 T5에서 대체 예정으로 판단. 단 두 파일 맨 위에 동작 변화 없는 표식 주석 1줄을 넣고 티켓·PR에 명시할 것 | 두 파일 맨 위에 표식 주석 추가, 티켓 "알려진 carry-over"·Follow-ups·PR "Scope exclusions"에 기재 |
| (2) `vite@7.2.4`의 dev server 취약점(수정본 7.3.6, semver-minor)을 이 PR에서 올릴까(2A) / 후속 task로 뺄까(2B)? | **2A**. 7.3.6 exact로 올리고 게이트 전부 재실행. 남은 transitive high는 티켓 Follow-ups에 기록만 | `apps/renderer`의 `vite`를 `7.3.6` exact로 고정, 게이트 5종 + 렌더러 기동 재검증, Follow-ups에 잔여 항목 기록 |

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
| 2 | `npm run dev -w @vl/renderer`로 기존과 같이 뜬다 | met | 아래 "Gates (executed) — renderer dev server" 블록. Vite ready, `GET /` 200(기존 `index.html`), `GET /src/main.jsx` 200(JSX 변환됨), `GET /pet.glb` 200 52796 bytes(이동한 `apps/renderer/public/`에서 서빙) |
| 3 | CI가 PR에서 녹색 | met | PR #1, workflow `CI` job `ci` — run 31950064753(head `708e855`) conclusion **success** 33s. `gh run list --branch dnhynk/t0-scaffold --json headSha,conclusion`로 확인 |
| 4 | `legacy/`가 어떤 워크스페이스에서도 import되지 않음 | met | `scripts/check-no-legacy-imports.mjs`가 `npm run lint`에 포함. 위반을 넣었을 때 exit 1(아래 negative test), 제거하면 exit 0 |

### Gates (executed) — fresh clone

```text
$ git clone --branch dnhynk/t0-scaffold --single-branch https://github.com/dnhynk/vertical-live.git <scratch>/fresh2
$ cd <scratch>/fresh2 && git log --oneline -1
708e855 chore(renderer): pin vite 7.3.6 and mark the prototype carry-over

$ npm ci                    -> added 270 packages, and audited 275 packages in 28s
$ npm run format:check      -> Checking formatting... All matched files use Prettier code style!
$ npm run lint              -> eslint 위반 0건; check-no-legacy-imports: ok (0 legacy imports)
$ npm run typecheck         -> tsc --build tsconfig.json (출력 없음 = 오류 0)
$ npm run test              -> RUN v4.1.10 / Test Files 3 passed (3) / Tests 10 passed (10)
$ npm run build             -> @vl/contract tsc --build
                               / @vl/renderer vite v7.3.6, 610 modules transformed, built in 9.90s
                               / @vl/server tsc --build / @vl/simulator tsc --build
```

같은 5개 게이트를 작업 worktree에서도 통과시켰다(vite 7.3.6 반영 후 재실행, 동일 결과).

### Gates (executed) — renderer dev server

vite를 7.3.6으로 올린 뒤 재실행:

```text
$ npm run dev -w @vl/renderer -- --port 5201 --strictPort
  VITE v7.3.6  ready
  ➜  Local:   http://localhost:5201/

$ node -e "fetch(...)"
GET /              -> 200  <title>vertical-live</title>  (기존 index.html, react-refresh 주입됨)
GET /src/main.jsx  -> 200  import __vite__cjsImport0_react_jsxDevRuntime ...  (JSX 변환 정상)
GET /src/store.js  -> 200  // PROTOTYPE (pre-spec v1) — local demo only, ...  (표식 주석 반영)
GET /pet.glb       -> 200  bytes=52796                   (이동한 apps/renderer/public/에서 서빙)
```

(7.2.4 시점에도 같은 4개 요청이 200이었다.)

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

### 이동한 렌더러 파일에 가한 변경 (전부 비-동작 변경)

1. `apps/renderer/src/{App.jsx,store.js,index.css,components/Pet.jsx,components/Background.jsx}` — `prettier --write` 포맷만(들여쓰기·세미콜론). 로직 변경 없음. 그 결과 git이 일부 파일을 rename이 아닌 delete+add로 표시한다.
2. `apps/renderer/src/{store.js,App.jsx}` — 맨 위에 표식 주석 1줄(코디네이터 결정 1A, 위 "알려진 carry-over" 참조).

그 밖에 `index.html`, `vite.config.js`, `public/`, `main.jsx`, `App.css`는 내용 변경 없이 경로만 바뀌었다.

## Not done / out of scope

- 계약 스키마(T1), 렌더러 read model·TS 전환(T5), 서버 기능(T4·T8), 시뮬레이터 시나리오(T11)
- `README.md`·`docs/ROADMAP.md` 전면 정합화(T16)
- `packages/contract`의 스키마: 이 task는 `[contract]`가 아니므로 `CONTRACT_VERSION` 상수 외에는 만들지 않았다
- 워크스페이스 간 import(`@vl/server` → `@vl/contract` 등): T0 범위가 "최소 export + 테스트"이므로 배선만 두고 실제 사용은 T1 이후

## 알려진 carry-over — 프로토타입 코드, T5에서 제거 (코디네이터 결정 1A)

`apps/renderer/src/store.js`·`App.jsx`는 프로토타입 상태 그대로 옮겼고, 그 안에는 로컬 데모용 **임의 사용자명 생성**(`TEST_NAMES = ['Sora', ...]`, `randomName()`)과 이벤트 로그의 **표시명 출력**이 남아 있다. §T0가 "동작 유지, 렌더러 개편은 범위 밖, TS 전환은 T5"라고 못박아 그대로 옮겼으나, `CLAUDE.md` §3의 "가짜 참여를 만들지 않는다"·"표시명을 저장·표시하지 않는다"와 충돌한다. 스펙 §16이 `src/store.js`를 "서버 snapshot의 projection이 되어야 함"이라 판단했으므로 T5에서 제거되는 코드다.

코디네이터 결정에 따라 **두 파일 맨 위에 동작 변화 없는 표식 주석 1줄**을 넣었다(리뷰어가 신규 코드의 §3 위반으로 오판하지 않도록):

```js
// PROTOTYPE (pre-spec v1) — local demo only, not a production path. Removed/replaced in T5 (docs/tasks/TASK_SPECS.md §T5). Random names here violate CLAUDE.md §3 only if used in production.
```

**신규로 작성한 코드(`packages/contract`, `apps/server`, `tools/simulator`, `scripts/`)에는 임의 사용자명·표시명·가짜 이벤트가 없다.**

## Follow-ups

- **T5**: `store.js`·`App.jsx`의 로컬 임의 사용자명 생성·표시명 출력 제거(서버 snapshot projection으로 대체)와 위 표식 주석 삭제, 렌더러 TS 전환 시 루트 `tsconfig.json` references에 `apps/renderer` 추가
- **T5**: 워크스페이스별 vitest 환경 분리(jsdom 등) — 렌더러 테스트가 생기는 시점
- **dev 의존성 보안**: 코디네이터 결정 2A에 따라 이 PR에서 `vite`를 `7.2.4` → `7.3.6`(exact, semver-minor)로 올렸다. 그 결과 `npm audit` high 9건 → 4건. 남은 것은 **전부 dev-only transitive이고 직접 의존이 아니다**(`brace-expansion`, `flatted`, `js-yaml`, `minimatch`, `nanoid`, `picomatch`, `postcss`, `rollup`, `@babel/core`, `ajv` — eslint·babel·rollup 경유). `npm audit --omit=dev` = **0건**. 후속 task 후보로 기록만 한다
- `apps/renderer`에는 아직 테스트가 없다(T5가 read model과 함께 추가)
