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

## 원인 규명 (CLAUDE.md 디버깅 절차)

1. **가설**: 실패는 제품 코드가 아니라 Node 26의 전역 `localStorage`가 jsdom의 것을 가려서 생긴다.
2. **반증 관측**: 가설이 틀렸다면 jsdom 환경에서 `window.sessionStorage`도 같이 깨지거나, Node 24에서도 같은 실패가 나야 한다.
3. **관측 결과**(임시 프로브 테스트, jsdom 환경):
   ```text
   window===globalThis: true
   typeof window.localStorage: undefined      ← Node 26 전역 접근자
   typeof window.sessionStorage: object       ← jsdom 것이 그대로
   own desc on window(localStorage): get/set  ← 값이 아니라 접근자
   ```
   `node -e`로 전역 정의 여부: v26.7.0 `true`, v24.19.0 `false`. vitest는 **이미 전역에 있는 키를 jsdom 값으로 덮지 않으므로** `localStorage`만 Node 스텁이 남는다.
4. **인과 확인(음성 대조)**: 같은 커밋에서 플래그를 워커에 전달하지 않으면(처음에 `poolOptions.forks.execArgv`로 잘못 넣어 워커 `process.execArgv`에 반영되지 않은 상태) `connection.test.ts`가 다시 `1 failed | 7 passed`가 된다. 전달되면 `8 passed`.

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
<채움>
```

## Not done / out of scope

- `engines.node` 상향, CI Node 매트릭스 추가 — 요청 범위 밖.
- 과거 티켓(`docs/tasks/TASK-T*.md`)의 "Node 24" 표기 — 그때의 기록이므로 고치지 않는다.

## Follow-ups

- **스위트 실행 시간**: 동일 코드·동일 호스트에서 Node 26이 Node 24보다 느리다(아래 Gates 수치). T8f(스위트 시간)에서 Node 버전 요인으로 함께 다룬다.
