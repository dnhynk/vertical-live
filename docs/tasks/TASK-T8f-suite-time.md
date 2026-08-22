# TASK-T8f-suite-time

- Task: T8f loopback `fetch` 정지로 인한 스위트 실행 시간(Node 26 회귀 회피) (`docs/tasks/TASK_SPECS.md` §T8f)
- Branch: `dnhynk/t8f-suite-time` · PR: #<n>
- Orca: 미사용(코디네이터가 직접 구현)
- Spec sections read: §7.3(주입 경로), §10.2(loopback), §T11 계약
- BOARD decisions/assumptions relied on: D-1(2026-08-22 개정 — Node 26), D-2

## Goal

Node 26에서 스위트가 wall 14초 → 103초로 느려진 원인을 규명하고 회피한다. 원인은 제품 코드가 아니라 **Node 26의 `fetch`(undici)가 loopback 평문 HTTP에서 유휴 간격 뒤에 수백 ms 정지하는 것**이다. 시뮬레이터의 loopback 호출 두 곳만 `node:http`로 바꾼다.

## 원인

프로젝트 코드 없이 재현된다(최소 서버 + `fetch`, 요청 사이 `setTimeout` 간격만 변화).

| 요청 간 간격 | Node 26.7.0 `fetch` | Node 24.19.0 `fetch` | 두 버전 `http.request` |
|---|---|---|---|
| 0ms(연속) | p50 0.7ms | p50 6.8ms | p50 0.7ms |
| 5ms | p50 441.0ms | p50 11.5ms | — |
| 20ms | p50 474.6ms | p50 10.7ms | p50 0.9ms |
| 100ms | p50 398.6ms | p50 15.2ms | — |
| 1000ms | p50 1995.2ms | p50 16.0ms | — |

범위를 가른 관측:

- **loopback 평문 HTTP 전용**이다. 외부 HTTPS(`https://api.github.com/zen`)는 Node 26 p50 10~16ms, Node 24 p50 19~27ms로 차이가 없다 → 서버의 바깥 방향 경로(YouTube·Slack·dead-man)는 영향 없음.
- **`fetch`만**이다. `node:http`의 `http.request`(keep-alive agent)는 두 버전 모두 간격과 무관하게 0.7~0.9ms.
- **`fetch` 옵션으로는 못 피한다**: `connection: close`는 p50 2.3ms지만 max 473.8ms, `keepalive: true/false`도 각각 p50 373.6 / 219.5ms.
- CPU 프로파일은 26.4초 중 25.8초가 `(idle)`이다 — 계산이 아니라 대기.
- 일치하는 upstream 이슈는 2026-08-22 검색으로 찾지 못했다.

원래 T8f를 등록하게 한 관측("T20b/T22 머지 후 스위트 CPU 3.7배")은 **코드 원인이 아니었다**: 같은 Node 24에서 T20b 머지 직전 `48a5c00`이 141 files / 2,006 tests / tests CPU 86.21s, 그 뒤 HEAD가 149 files / 2,145 tests / 88~91s(+6%)다.

## 변경

`tools/simulator/src/runner/loopback-http.ts`가 시뮬레이터의 loopback 호출을 담당한다(공유 keep-alive agent). `http:` URL만 이 경로를 타고 그 밖의 스킴은 `fetch`로 떨어지므로 `--url`이 TLS 엔드포인트를 가리켜도 그대로 동작한다. 호출부는 `postEnvelopes`(`POST /ingest/simulator`)와 `fetchMetrics`(`GET /metrics`) 둘뿐이다. 계약은 그대로다 — 여전히 실제 HTTP를 타고 404/403/401/400을 그대로 본다.

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | `run adversarial` wall이 Node 24 수준으로 | met | 25,437ms → **525ms**(Node 24는 1,468ms — `http.request`가 Node 24의 `fetch`보다도 빠르다) |
| 2 | 스위트 wall ≤ 20초 | met | 102.6s → **11.8s**, tests CPU 259.96s → 88.10s |
| 3 | 거부 경로 테스트 무수정 통과 | met | `endpoint.test.ts`(404/403/401/400) 변경 없음 |
| 4 | 게이트 5개 + `soak:ci` + CI | met (CI는 PR에서) | 아래 Gates |

### Gates (executed)

```text
Node 26.7.0 / Windows 11
npm run format:check  -> exit 0
npm run lint          -> exit 0
npm run typecheck     -> exit 0
npm run test          -> 150 files | 2159 passed | 1 skipped (wall 13s)
npm run build         -> exit 0
npm run soak:ci       -> exit 0 (wall 35s)
```

## Not done / out of scope

- 서버의 바깥 방향 `fetch`(YouTube·Slack·dead-man) — 외부 HTTPS는 영향이 없다.
- `endpoint.test.ts`가 직접 쓰는 `fetch` 4곳 — 호출 수가 적어 비용이 무시할 만하고, 그 파일의 목적이 브라우저와 같은 클라이언트로 거부 경로를 보는 것이다.
- upstream 이슈 제출.

## Follow-ups

- Node가 이 회귀를 고치면 `loopback-http.ts`를 지우고 `fetch`로 되돌릴 수 있다. 되돌릴 때는 위 표의 간격별 계측을 다시 떠서 근거를 남긴다.
- 별건: Windows에서 `await setTimeout(0)`이 두 버전 모두 ~12ms다(타이머 해상도). 틱을 여러 번 도는 테스트의 비용은 이 회귀와 무관하게 남는다.
