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
| (없음) 스펙·명세·기존 코드로 전부 확정됨 | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| 리포트 합격선 | **없음** | — | 스펙 §7.5·§11이 p95 합격선을 Gate 2 calibration 뒤에 잠근다(A-15). 리포트는 측정만 하고 판정하지 않는다. `formatLatencyReport`가 그 문장을 항상 출력한다 |
| 리포트 스위트의 clock | `system` | — | 가상 시계 수치는 시나리오 시간이지 지연이 아니다. 가상 시계로 리포트를 뽑으면 헤더에 `clock: virtual` + 경고를 출력한다 |
| 가상 시계 slice | 60,000ms 기본(테스트가 시나리오별로 조정) | provisional | 세계가 "점프"하지 않고 적분되도록 하는 값. 합격선 아님 |
| 시나리오 임계값 상수 | `input.window.*`를 catalog에 주석과 함께 복제 | provisional | 시나리오는 "창 하나에 전환 임계값 이상"이라는 **행동**으로 쓰였고, 테스트는 `config/default.json`에서 읽은 값(`harness.inputConfig.window.maxDirectPerWindow`)과 대조한다 |
| dev 패널 토큰 전달 | `?simToken=` 쿼리 파라미터 | — | 렌더러 토큰(`?token=`)과 같은 경로. OBS Browser Source·브라우저가 헤더를 못 넣는다. 화면·로그 미노출은 `DevPanel.test.tsx`가 강제 |
| `POST /ingest/simulator` CORS | loopback origin만 echo, `simulator.enabled=true`일 때만 | — | 패널이 다른 포트(Vite)에서 호출하려면 preflight 응답이 필요. wildcard 없음, disabled면 preflight도 404 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 모든 시나리오가 CI에서 통과(가상 시계, 실시간 대기 없음) | met | `tools/simulator/src/replay/scenarios.test.ts` — idle-24h(24 가상시간, 8.7s 실시간)·direct-low·aggregate-switch·flood·paid-replay·degraded-window·adversarial 7개 전부. `npm run test:replay` → 4 files / 18 tests passed. `npm run test` → 96 files / 1359 passed |
| 2 | 리포트에 구간별 p95 출력 + 티켓에 로컬 수치 기록 | met | 아래 "지연 리포트" 표. `npm run sim:report` 출력 전문 포함. `tools/simulator/src/report/report.test.ts`가 4구간·경고·합격선 문구를 강제 |
| 3 | `source: "simulator"`로만 표시, `simulator.enabled=false`면 404 | met | `tools/simulator/src/runner/endpoint.test.ts` 5 테스트: 202+row.source=simulator / disabled면 POST·OPTIONS 모두 404 / 무토큰·오토큰 401 / `source:"youtube"` 400 `source_must_be_simulator` / loopback origin만 CORS |
| §11 유료 무결성 | 동일 Super Chat 1회, Gift combo 증가분만, 같은 paid effectId 재전송 시 재시작 없음 | met | `replay/paid-integrity.test.ts` 4 테스트 (inbox unique key + paid ledger 두 방어선을 따로 검증, storedMax 5 유지, 재전송 프레임 > effectStarts) |
| §11 모더레이션 우회 0 | 악성 Unicode·URL·금칙어·flood가 상태·화면 우회 못 함 | met | `replay/moderation-bypass.test.ts` 4 테스트: 거부 벡터 45건 전부 `event_not_a_world_input`, 허용 벡터는 전부 명령이 됨, `LEAK_MARKERS`가 영속 inbox·snapshot·effect 어디에도 없음, flood는 집계로 흡수 |
| §11 상태 복구 | 백엔드 재시작 후 미처리 `ingestSeq` 복구 | met | `replay/state-recovery.test.ts` 3 테스트: 미처리 5행을 남긴 채 재시작 → 순서대로 전부 처리, 유료 이벤트 1회만, 2번째 재시작에도 재적용 없음, revision·deadline 복원 |
| 렌더러 `?mode=dev` 주입 | 시나리오/단일 이벤트를 서버 API 경유로만 | met | `apps/renderer/src/dev/inject.test.ts` 10 테스트 + `components/DevPanel.test.tsx` 13 테스트(버튼 클릭 → `POST /ingest/simulator` 1건, read model 여전히 null, `simToken` 미노출) |

### 지연 리포트 (로컬, 2026-08-17, 이 Windows 11 호스트, `npm run sim:report`)

`clock: system`, in-process 백엔드 + 실 HTTP + 실 WS 스텁 렌더러. 스위트: direct-low(8) · aggregate-switch(49) · flood(600) · paid-replay(11) · adversarial(169) = 837 envelope.

| 구간 | count | p50 ms | p95 ms | max ms |
|---|---|---|---|---|
| API received → state committed | 27 | 19.0 | 64.0 | 68.0 |
| state committed → published | 84 | 0.0 | 1.0 | 1.0 |
| published → renderer ACK | 49 | 13.0 | 59.0 | 62.0 |
| **API received → renderer ACK (end to end)** | 27 | 71.0 | **75.0** | 75.0 |

**합격선은 아니다**(스펙 §7.5, A-15). 이 수치는 같은 프로세스 안의 loopback 측정이며, §7.5가 따로 요구하는 `채팅 게시 → API 수신`과 `인코더 → 일본 실제 모바일 단말` 구간은 포함하지 않는다(Gate 2). `receivedToCommitted`의 count가 837보다 훨씬 작은 것은 집계 창이 여러 명령을 한 번의 commit으로 확정하기 때문이다(§6.4).

### Gates (executed)

```text
$ git fetch origin && git rebase origin/main
Successfully rebased and updated refs/heads/dnhynk/t11-simulator-replay.

$ npm run format:check
All matched files use Prettier code style!

$ npm run lint
check-no-legacy-imports: ok (0 legacy imports)
check-install-scripts: ok (3 reviewed, better-sqlite3 binding loads)

$ npm run typecheck
(no output — tsc --build clean)

$ npm run test
Test Files  96 passed (96)
     Tests  1359 passed | 1 skipped (1360)
  Duration  33.07s

$ npm run test:replay
Test Files  4 passed (4)
     Tests  18 passed (18)

$ npm run build
schema up to date (6 files) / vite built in 9.93s / copied 4 migration(s) / data-map up to date

$ npm run sim -- list
(7 scenarios, flags: idle-24h·degraded-window = virtual-clock, adversarial = needs-parser)

$ npm run sim -- run degraded-window
controlsApplied   degrade, recover
controlsSkipped   —
refusals          —
clock: virtual + "WARNING: virtual-clock durations are scenario time, not latency."
```

`npm run build`는 `tools/simulator/dist`를 지운 상태에서도 통과하도록 확인했다(`rm -rf packages/contract/dist tools/simulator/dist apps/server/dist apps/renderer/dist && npm run build`). `npm run build --workspaces`가 `tools/*`를 `apps/*`보다 **뒤에** 도는 것을 발견해 렌더러 vite alias로 해결했다(아래 "발견").

## 발견 / 인접 수정 (근거)

1. **`npm run build`의 워크스페이스 순서** — 렌더러가 `@vl/simulator/scenario`에 의존하게 되자 clean build가 깨졌다(`Rollup failed to resolve import`). `apps/renderer/vite.config.ts`에 소스 alias를 추가해 vite가 dist 없이 해결하게 했다(`vitest.config.ts`가 `@vl/contract`에 쓰는 것과 같은 방식). `tsc --build`는 project reference로 여전히 dist 타입을 본다.
2. **`@vl/server` 배럴의 이름 충돌** — `input/index.ts`와 `world/types.ts`가 둘 다 `RejectionReason`/`REJECTION_REASONS`를 export한다. 루트 배럴에 합치면 모든 소비자에게 TS2308이 되므로 `@vl/server/input` 서브패스 export를 추가했다(루트 배럴은 그대로).
3. **`no-fabrication.test.ts`의 `author` 패턴** — HTTP `Authorization` 헤더와 `unauthorized` 결과 토큰이 걸렸다. `author(?!iz)`로 좁혔다. `authorDetails`·`authorName`·`authorChannelId`는 그대로 걸린다(주석에 근거 기록).
4. **`paid_duplicate` 카운터는 정상 replay에서 0** — inbox unique key `(source, broadcast_id, message_id, gift_effective_count)`가 재전달을 먼저 잡는다. paid ledger 방어선은 별도 테스트로 직접 노출시켜 검증했다(`paid-integrity.test.ts`의 3번째 테스트).
5. **degraded 창 관측** — `no_renderer`로 degraded를 만들면 렌더러가 붙어 있지 않아 CTA-off snapshot을 "받아볼" 수 없다. `runScenario`에 `onAdvance` 샘플링 훅을 넣어 엔진 health와 `engine.snapshot()`을 창 안에서 직접 관측했다(커서가 멈춰 있는 것도 같은 훅으로 확인).

## Not done / out of scope

- `packages/contract` 미변경(이 task는 `[contract]` 아님). 확인: `git diff origin/main --stat -- packages/contract` = 빈 출력.
- 렌더러·OBS 재시작 복구는 §11의 다른 두 줄이며 각각 T5·T2/T12 소관. 이 PR은 **백엔드 재시작**만 검증한다.
- fault matrix·72h soak(T15), supervisor·알림(T12), 실제 YouTube 입력(T9)은 범위 밖.
- `--url`로 외부 서버에 주입할 때 `degrade`/`recover` control step은 붙어 있는 스텁 렌더러가 없으므로 실행되지 않고 **`controlsSkipped`로 리포트에 남는다**(조용히 건너뛰지 않음).
- 렌더러 쪽 "같은 effectId를 다시 받아도 연출을 재시작하지 않는다"의 **브라우저 read model 절반**은 T5가 이미 검증한다(`apps/renderer/src/read-model/store.test.ts`). 이 PR은 wire 절반(서버가 같은 id를 재전송하고, 소비자가 distinct id 수만큼만 시작)을 검증한다.

## Follow-ups

- Gate 2 calibration 뒤 p95 합격선이 잠기면 `sim:report`에 판정을 붙일 수 있다(지금은 A-15에 따라 측정만).
- T15가 이 harness(`openSession`/`SimulatorHarness`/`VirtualClock`)를 fault matrix·72h soak의 기반으로 재사용하면 좋다. crash window 주입 지점은 `SimulatorHarness.restart()`.
- `POST /ingest/simulator`의 CORS는 dev 패널 때문에 생겼다. T12/T17이 운영 프로파일에서 `simulator.enabled=false`를 강제하는 사전 점검을 넣으면 이 경로가 프로덕션에 열릴 여지가 사라진다.
