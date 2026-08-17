# TASK-T11-simulator-replay

- Task: T11 로컬 시뮬레이터·replay·지연 계측 (`docs/tasks/TASK_SPECS.md` §T11)
- Branch: `dnhynk/t11-simulator-replay` · PR: #<n>
- Orca: task `task_9470df5be9b8` · dispatch `ctx_67eddda5be64`
- Spec sections read: §2.6, §6.4, §7.3(1)(2)(3)(5)(6)(7)(8), §7.4, §7.5, §9.2, §10.2, §11, §12.3, §15 Gate 1
- BOARD decisions/assumptions relied on: D-1, A-1, A-2, A-3, A-14, A-15, A-17

## Goal

공개 방송과 **같은 이벤트 계약**(`IngestEnvelope` → `POST /ingest/simulator` → 단일 writer)으로 로컬 세계를
구동하는 시뮬레이터를 만든다. 시나리오 파일에서 envelope 시퀀스를 만들어 서버 API로만 주입하고, 가상 시계로
24시간 idle·집계 전환·flood·악성 입력·유료 replay·degraded 창을 실시간 대기 없이 재생한다. `/metrics`의 구간별
p50/p95를 리포트로 뽑고(`npm run sim:report`), 스펙 §11의 세 행(유료 무결성 · 모더레이션 우회 0 · 백엔드
재시작 후 미처리 `ingestSeq` 복구)을 `npm run test:replay`로 고정한다. 렌더러 `?mode=dev` 패널은 같은 시나리오
정의를 써서 서버 API로만 주입한다(렌더러 로컬 상태 조작 없음).

## Plan

1. **시나리오 계층 (브라우저 안전, `@vl/contract`만 의존)** — `tools/simulator/src/scenario/`
   - `schema.ts`: zod 시나리오 스키마(step kind: `command` · `chat`(raw text) · `superChat` · `superSticker` ·
     `gift` · `membership` · `unsupported` · `invalid` · `wait` · `control`).
   - `build.ts`: step → `IngestEnvelope`. `receivedAt`은 **runner가 주는 instant**를 쓴다(가상 시계면 가상 시각,
     실시계면 진짜 now) — 그래야 `/metrics`의 `receivedAt→committedAt`이 조작되지 않는다. ID는 명백한 합성값
     (`msg_sim_<scenario>_<n>`, `brd_sim_<scenario>`, `chat_sim_<scenario>`, §2.6).
   - `catalog.ts`: 내장 시나리오 8종(TS 데이터). 외부 JSON 파일은 CLI가 같은 zod 스키마로 검증해 로드한다.
   - `chat` step은 raw text를 **파서에 넘겨야** envelope가 된다(§7.3(1): raw text는 envelope에 필드가 없다).
     파서는 주입 포트(`parseCommand`)로 받는다 → node runner는 T6의 `parseMessage`를 주입, 브라우저 패널은
     `chat` step이 있는 시나리오를 `requiresParser`로 표시하고 실행 대상에서 제외한다.
2. **runner (node)** — `tools/simulator/src/runner/`
   - `clock.ts`: `VirtualClock`(= `@vl/server`의 `Clock` 구현). 실시간 대기 0.
   - `harness.ts`: 임시 디렉터리 DB + `PersistenceStore` + `StateEngine`(autoTick off) + `RendererHub` +
     `SimulatorIngestEndpoint`(enabled, 합성 토큰) + HTTP 서버를 임시 포트에 띄운다. **주입은 항상 실제 HTTP**로
     한다(엔드포인트의 404/403/401/400 경로가 그대로 걸리도록).
   - `stub-renderer.ts`: `ws` 클라이언트로 `/ws/renderer?token=…` 접속 → `hello` → snapshot/effect 즉시 ACK.
     §7.3(7)대로 이미 본 `effectId`는 다시 "시작"하지 않고 재수신만 센다.
   - `run.ts`: 시나리오를 배치로 나눠 시각 순서대로 주입. 가상 시계 모드는 clock을 offset까지 옮기고
     `engine.runPending()`; 실시계 모드는 offset을 압축(`--speed`)해 진행.
   - `control` step: `degrade`(스텁 렌더러 연결 해제 → `no_renderer`) / `recover`(재연결). 지원하지 않는 runner는
     `skipped`로 리포트에 남긴다(조용히 건너뛰지 않는다).
3. **리포트** — `tools/simulator/src/report/`: `/metrics`를 읽어 4구간(`received→committed`,
   `committed→published`, `published→acked`, `received→acked`) count/p50/p95/max 표 + counters. 합격선은 찍지
   않는다(§7.5, A-15). `--json` 지원. 리포트에 사용한 clock 종류를 명시한다 — 가상 시계 수치는 지연이 아니다.
4. **CLI** — `vl-simulator list | run <scenario|file> [--url --token --speed --json] | report [--url --json]`.
   루트 스크립트 `npm run sim`, `npm run sim:report`(빌드 후 dist 실행), `npm run test:replay`.
5. **replay 테스트** — `tools/simulator/src/replay/*.test.ts` (일반 `npm run test`에도 포함 → CI 통과)
   - `paid-integrity`: 동일 Super Chat 1회만, Gift combo 증가분만, 같은 paid `effectId` 재전송 시 재시작 없음.
   - `moderation-bypass`: T6의 `REJECTED_VECTORS` 전량 주입 → 상태 변화 0, 공표된 snapshot/effect JSON에
     주입 문자열 0건, flood는 집계로 흡수.
   - `state-recovery`: 미처리 `ingestSeq`를 남긴 채 재시작 → 전부 순서대로 처리, 커서 전진.
   - `scenarios`: 내장 시나리오 8종이 가상 시계로 통과(idle 24h 포함).
6. **렌더러 `?mode=dev` 패널** — `apps/renderer/src/dev/`
   - `?simToken=`으로 시뮬레이터 토큰을 받는다(렌더러 토큰과 같은 경로). **화면에 렌더하지 않는다**(R-T8-2).
   - 단일 이벤트 버튼(FEED/PLAY/PET/Super Chat/Gift/Membership)과 시나리오 select+Run. 전부
     `POST /ingest/simulator`로만 나간다. 로컬 상태 조작 0.
   - 응답 코드를 토큰으로 표시(`disabled`(404)/`unauthorized`(401)/`rejected`(400)/`accepted`).
7. **서버 최소 변경**
   - `server.ts`: `simulator.enabled`일 때만 `/ingest/simulator`에 loopback origin CORS(+`OPTIONS` preflight).
     브라우저 패널이 다른 포트(Vite)에서 이 API를 부르려면 필요. disabled면 `OPTIONS`도 404(구분 불가).
   - `index.ts`: `./input/index.js` 배럴 재노출(시뮬레이터가 T6 파서·적대적 벡터를 재사용).
   - `input/index.ts`: 적대적 벡터 fixture 재노출.
   - 엔진·계약 변경 없음. `packages/contract`는 건드리지 않는다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| CORS preflight 요구조건(Authorization 헤더는 단순요청이 아님) | https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS | 2026-08-17 | `Authorization` + `content-type: application/json`이면 `OPTIONS` preflight가 필요하므로 서버가 응답해야 한다 |

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
```

## Not done / out of scope

- …

## Follow-ups

- …
