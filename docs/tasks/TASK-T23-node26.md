# TASK-T23-node26

- Task: T23 Node 26 전환(호스트 통일)과 vitest jsdom web storage 회귀 차단 (`docs/tasks/TASK_SPECS.md` §T23)
- Branch: `dnhynk/t23-node26` · PR: #<n>
- Orca: 미사용(코디네이터가 직접 구현 — 새 호스트에 Orca Run 미재구성)
- Spec sections read: §10.2(호스트·런타임 고정), §11(72h soak 전 호스트 시험)
- BOARD decisions/assumptions relied on: D-1(2026-08-22 개정 — Node 26), D-2(2026-08-22 정정 — 새 호스트 `WORKSTATION`), A-6

## Goal

같은 호스트의 다른 저장소가 Node 26을 요구해 런타임을 26으로 통일한다(D-1 개정). 그대로 올리면 renderer 테스트 1건이 깨지는데, 원인은 제품 코드가 아니라 **Node 26이 Web Storage API를 기본 활성화**해 vitest jsdom 환경의 `window.localStorage`를 가리는 것이다. 테스트 단언을 고쳐 통과시키지 않고, 테스트 워커에서 Node의 web storage를 끄는 것으로 jsdom 환경을 원래대로 되돌린다.

## Plan

1. 원인 확정: Node 26 전역 `localStorage` 접근자 ↔ vitest global populate 규칙(반증 관측 포함).
2. `.nvmrc` `24`→`26`(CI `setup-node`가 이 파일을 읽는다). `engines.node`는 하한이라 `>=24.0.0` 유지.
3. `vitest.config.ts`의 `test.execArgv`에 `--no-experimental-webstorage`.
4. Node 24를 못 박은 산문 갱신(과거 티켓은 기록이므로 손대지 않는다).
5. Node 26·Node 24 양쪽에서 게이트 실행.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| Node 26 CLI 플래그 | 설치 바이너리 `node --help`(v26.7.0) | 2026-08-22 | `--webstorage, --no-experimental-webstorage` — **기본 활성**이고 끄는 플래그가 있다. `--localstorage-file=...` 별도 |
| Node 24 CLI 플래그 | 설치 바이너리 `node --help`(v24.19.0) | 2026-08-22 | `--experimental-webstorage` — **opt-in**. 그래서 24에서는 전역이 정의되지 않아 문제가 없었다 |
| Node 릴리스 라인 | https://nodejs.org/dist/index.json | 2026-08-22 | `v26.7.0 lts=false`(Current), `v24.19.0 lts=Krypton`. 26은 아직 LTS가 아니다 — 사용자가 비용을 인지하고 결정(D-1 개정) |
| vitest `execArgv` | `node_modules/vitest/dist/chunks/reporters.d.*.d.ts` (vitest 4.1.10 타입 정의) | 2026-08-22 | vitest 4에서 `execArgv`는 **`test` 최상위 옵션**이다. `poolOptions.forks.execArgv`에 두면 워커에 전달되지 않는다(관측으로 확인) |

## 원인

Node 26은 Web Storage API를 **기본 활성**으로 두므로 `globalThis.localStorage`가 접근자로 존재하고, `--localstorage-file`이 없으면 `undefined`를 돌려준다(Node 24는 `--experimental-webstorage` opt-in이라 전역이 없다). vitest는 globals를 채울 때 **이미 전역에 있는 키는 jsdom 값으로 덮지 않는다.** 그래서 jsdom 환경에서 이렇게 갈린다.

| | Node 24 | Node 26(플래그 없음) |
|---|---|---|
| `window.localStorage` | jsdom 것 | `undefined` (Node 접근자) |
| `window.sessionStorage` | jsdom 것 | jsdom 것 |

`window === globalThis`(vitest가 jsdom window를 전역에 합친다)이므로 테스트에서 우회할 방법이 없다. 워커에서 Node의 web storage를 끄면 jsdom 것이 정상적으로 채워진다.

**플래그를 빼면 `apps/renderer/src/read-model/connection.test.ts`의 "never writes to browser storage"가 `TypeError: Cannot read properties of undefined (reading 'length')`로 실패한다.** 이것이 이 설정 한 줄의 존재 이유다 — 지우지 말고, 테스트 단언을 고쳐 통과시키지도 말 것.

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `engines.node` | `>=24.0.0` 유지 | 확정 | 하한이지 핀이 아니다. 24·26 양쪽에서 게이트가 통과하는 것을 확인했으므로 하한을 올릴 근거가 없다. 지원 런타임의 정본은 `.nvmrc`와 CI다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | Node 26에서 게이트 5개 + `soak:ci` 통과, 테스트 수가 Node 24와 동일 | met | 아래 Gates — 149 files / 2,145 passed / 1 skipped |
| 2 | Node 24에서도 같은 게이트 통과 | met | 아래 Gates(별도 worktree, v24.19.0) |
| 3 | 플래그를 되돌리면 다시 실패(증상만 덮은 수정이 아님) | met | 위 "인과 확인(음성 대조)" |
| 4 | CI 녹색 | unverified-here | PR 생성 후 확인 |

### Gates (executed)

```text
Node 26.7.0 (호스트 기본, D:/repos/vertical-live)
  format:check / lint / typecheck   exit 0
  test    149 files | 2145 passed | 1 skipped   Duration 102.59s (tests 257.43s)
  build   exit 0
  soak:ci exit 0   (임계값 4종 not-locked — A-15)

Node 24.19.0 (별도 worktree, 같은 커밋)
  format:check / lint / typecheck   exit 0
  test    149 files | 2145 passed | 1 skipped   Duration 14.22s (tests 88.01s)
  build   exit 0
  soak:ci exit 0
```

**스위트 시간은 런타임에 따라 크게 갈린다**: 같은 커밋·같은 호스트에서 Node 26이 wall 102.59s / tests 257.43s, Node 24가 wall 14.22s / tests 88.01s다. 원인 미규명 — T8f에서 다룬다.

## Not done / out of scope

- `engines.node` 상향, CI Node 매트릭스 추가 — 요청 범위 밖.
- 과거 티켓(`docs/tasks/TASK-T*.md`)의 "Node 24" 표기 — 그때의 기록이므로 고치지 않는다.

## Follow-ups

- **스위트 실행 시간**: 동일 코드·동일 호스트에서 Node 26이 Node 24보다 느리다(아래 Gates 수치). T8f(스위트 시간)에서 Node 버전 요인으로 함께 다룬다.
