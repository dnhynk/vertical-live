# TASK-T12-supervisor

- Task: T12 supervisor 상태기계·건강 집계·kill switch·알림·dead-man (`docs/tasks/TASK_SPECS.md` §T12)
- Branch: `dnhynk/t12-supervisor` · PR: #<n>
- Orca: task `task_560530cfb813` · dispatch `ctx_58b4803e072e`
- Spec sections read: §2.9, §9.1, §9.2, §9.4, §10.2, §11, §12.3, §12.4, [S23]
- BOARD decisions/assumptions relied on: D-2(Windows 1차 호스트), D-3(Discord webhook = `AlertSink` 첫 구현), A-4(broadcast 전략 `single`), A-14(공용 규격 `/health`·`/admin/kill`), A-15(합격선 숫자는 provisional config), A-16(stream key는 vault → `setStreamServiceFromVault()` 후 `startStream()`), A-18(attempt 마커 제거 후에만 `publish()`)

## Goal

시작 순서·건강 집계·복구·정지를 한 곳에서 결정하는 supervisor를 만든다. 8개 건강 신호(§9.4)를 하나의 집계기로 모아 `offline → starting → live → degraded → recovering → live | safe_stopped`(§9.2) 전이를 **집계 결과로만** 정하고, 컴포넌트마다 **정확히 하나의** restart supervisor(§10.2)가 backoff로 복구하며, 최대 재시도 후 또는 권리·정책·무결성·계정·모더레이션 조건(§9.1, §12.3)에서 자동 재시작 없이 `safe_stopped`로 간다. 사람에게 닿는 경로(Discord `AlertSink`, Uptime Kuma dead-man, kill switch 3경로)와 `/health` 요약을 함께 넣는다.

## Plan

1. **`apps/server/src/supervisor/types.ts`** — `SupervisorState`, 8개 신호 family(§9.4) 식별자, family별 verdict, `SupervisorHealthSummary`.
2. **`signals.ts`** — `HealthAggregator`: T2/T9/T10 `HealthSignal`(push) + 엔진 `EngineHealth`·렌더러 `RendererHealthReport`·dead-man 결과(pull)를 8 family로 접는다. 신호가 `staleAfterMs`를 넘으면 `unknown`(stale). 어떤 producer도 상태를 결정하지 않는다.
3. **`transitions.ts`** — 순수 전이 함수 `nextState(current, input)`. 입력은 (a) family verdict 집합, (b) preflight 결과, (c) 복구 진행 여부, (d) safe-stop 트리거. 신호 조합 → 전이 표를 테스트로 고정.
4. **`preflight.ts`** — `starting` 사전 점검 6종(자격·비밀정보·상태·API·렌더러·인코더, §9.2). 실패 항목이 있으면 `live`로 가지 않는다.
5. **`restart.ts`** — `RestartSupervisor`(컴포넌트 1개 = 인스턴스 1개, `createExponentialBackoff` 재사용, 최대 재시도 후 `exhausted`) + `SupervisorRegistry`(컴포넌트당 1개만 등록 가능, 중복 등록은 throw). `obs-connection`은 **이미 `ObsClient`가 재연결 루프를 소유**하므로 T12는 두 번째 루프를 만들지 않고 `owner: 'obs.ObsClient'` 위임 항목으로 등록해 관찰만 한다(§10.2). 위임 컴포넌트의 예산 소진은 escalation 대상(`obs-process`)으로 넘긴다.
6. **`alerts.ts`** — `AlertSink` 인터페이스, 심각도(`info|warning|critical`), `SuppressingAlertSink`(kind+reason 키, 심각도별 억제 창, 억제 건수 보고), `DiscordWebhookAlertSink`(webhook URL은 vault `alerts.discordWebhookUrl`, fetch 주입, 전달 실패는 로그+결과값이며 throw하지 않음), `RecordingAlertSink`(테스트).
7. **`deadman.ts`** — Uptime Kuma push URL(vault `monitoring.deadManPushUrl`)로 주기 heartbeat. 실패는 로그+신호(8)로만 표면화(외부 감시가 죽었다고 방송을 멈추지 않는다). off-host 사건은 외부에 기록됨을 문서화.
8. **`kill-switch.ts` + `bin/kill.ts`** — 3경로: `POST /admin/kill`(loopback + `server.adminToken` bearer), 파일 플래그(`supervisor.killSwitch.flagFile` 폴링), CLI(`npm run kill -w @vl/server` → HTTP 우선, 실패 시 파일 플래그). 어느 경로든 `safe_stopped` + alert + 자동 재시작 금지.
9. **`screenshot.ts`** — obs-websocket `SaveSourceScreenshot`으로 주기 진단 캡처를 파일로만 저장하고 개수 상한으로 순환. **freeze 판정에 쓰지 않는다**(§9.4)는 것을 코드 주석과 테스트로 고정.
10. **`startup.ts`** — TASK_SPECS §T12 "추가" 항목의 시작 순서를 이름 있는 step 배열로 고정: DB/마이그레이션 → 엔진 복구 → T13 retention/revocation sink → `ensureBound()` → `setStreamServiceFromVault()` → `startStream()` → chat source(liveChatId는 `broadcast_resources` 열린 attempt에서) → 마커 제거 후 `publish()`. 순서와 "앞 step 실패 시 뒤 step 미실행"을 테스트로 고정.
11. **`supervisor.ts`** — 위를 묶는 오케스트레이터. 주기 평가에서 집계 → 전이 → (복구/알림/CTA 지시). CTA는 엔진의 `reportInputHealth()`로 지시한다(입력·모더레이션 불건전 → `input_degraded` → `interactionEnabled=false`, §9.2·§12.3). 엔진 파일은 고치지 않는다.
12. **`server.ts`/`main.ts`/`config/default.json`** — `POST /admin/kill` 라우트와 `/health`의 supervisor 요약 추가, `supervisor` config 블록(전부 provisional), main은 startup 조립만.
13. 테스트: 전이 표(조합별), kill switch 3경로, alert mock, dead-man mock, 컴포넌트당 supervisor 1개 구조 테스트, startup 순서 테스트, screenshot이 freeze 판정에 쓰이지 않음.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| Uptime Kuma push monitor(URL 형식 `/api/push/<token>`, 쿼리 `status`·`msg`·`ping`) | https://github.com/louislam/uptime-kuma/wiki/Push-Monitor | 2026-08-18 | push URL 경로에 토큰이 들어 있으므로 config가 아니라 vault 항목(`monitoring.deadManPushUrl`). GET + `status=up`으로 heartbeat |
| Discord webhook 실행(성공 시 204, JSON `content`) | https://discord.com/developers/docs/resources/webhook#execute-webhook | 2026-08-18 | 2xx만 성공으로 보고, 그 외는 `http_<status>`로 실패 기록. URL은 자격증명이므로 vault(`alerts.discordWebhookUrl`) |
| obs-websocket v5 `SaveSourceScreenshot`(`sourceName`·`imageFormat`·`imageFilePath`·`imageWidth`, 응답 없음) | `node_modules/obs-websocket-js/dist/base-*.d.ts`(설치된 5.0.8 타입 정의) | 2026-08-18 | 진단 캡처는 파일 저장만 가능하고 판정 근거가 될 값을 돌려주지 않는다 — §9.4의 "freeze 판정 아님"과 일치 |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| (없음 — 스펙·TASK_SPECS·BOARD와 공식 문서로 전부 확정) | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `supervisor.*` 임계값 전체(평가 주기, coordinator/state-commit/신호 staleness, unobservable grace, renderer minFps, restart backoff·재시도 수, alert 억제 창, dead-man 주기, screenshot 주기·보관 수) | `config/default.json` | **provisional**(BOARD A-15) | 스펙 §11이 합격선의 *형태*만 정하고 숫자는 Gate 0/2 승인 대상. 코드에 리터럴을 넣지 않으려고 config로 둔 값이며 합격선이 아니다 |
| `supervisor.integrations.{obs,broadcast}` 기본 `false` | 배포 스위치 | 결정(provisional 아님) | 개발 호스트에는 OBS/YouTube 계정이 없다. 꺼져 있으면 시작 step은 `not_configured`로 건너뛰고 대응 사전 점검이 **실패**한다(점검하지 않은 것을 통과로 적지 않는다) |
| 컴포넌트 6종(§10.2의 "엔진·adapter·obs 연결·렌더러 소스·OBS 프로세스"에 `obs-stream` 추가) | `SUPERVISED_COMPONENTS` | 확장 | §9.4(5) `output_inactive`(출력이 꺼졌다)에 대응할 복구 주체가 목록에 없었다. `startStream()`만 담당하는 컴포넌트를 하나 더 두고, 여전히 컴포넌트당 supervisor 1개를 유지 |
| `obs-connection` 소진 → `safe_stopped`가 아니라 `obs-process`로 escalation | `RestartSupervisor.escalatesTo` | 확장 | §10.2가 "OBS 프로세스"를 별도 컴포넌트로 요구하는데, 연결 소진이 곧바로 정지하면 프로세스 재시작 경로에 도달할 수 없다. escalation 대상의 소진은 규칙대로 `safe_stopped` |
| 시작 순서에 `goLive` step 추가(TASK_SPECS 목록에는 없음) | `STARTUP_STEP_ORDER` 7번 | 확장 | `liveChatId`는 방송이 live가 된 뒤에만 존재하고(§T12의 chat step이 그것을 요구), `enableAutoStart`는 거부될 수 있다(§4 `invalidAutoStart`). `goLive()`는 auto-start를 먼저 기다리므로 정상 경로에서는 no-op |
| 시작 순서 전체를 `supervisor.startup.maxAttempts`(5)까지 backoff 재시도 | `config/default.json` | provisional | 호스트가 OBS·네트워크보다 먼저 뜨는 것이 흔한 경우(§9.1 자동 복구). 소진은 §9.2대로 `safe_stopped` |
| `alerts.discordWebhookUrl`·`monitoring.deadManPushUrl`을 `SECRET_NAMES`에 추가 | vault 항목 | 결정 | 두 URL 모두 경로에 토큰이 들어 있어 URL 자체가 자격증명이다(§10.2) |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거 |
|---|---|---|---|
| 1 | 신호 조합별 전이 테이블 테스트(입력 불건전→degraded+CTA off, 복구→live, 정책 오류→safe_stopped 후 자동 재시작 없음) | **met** | `apps/server/src/supervisor/transitions.test.ts`(15행 전이표 + safe_stopped 터미널 + 복구 계획 6건), `supervisor.test.ts`("turns the CTA off when the input path is unhealthy and back on when it recovers", "stops when the grant is revoked and never restarts by itself" — 정지 후 3회 평가에서 재시작 0건), `signals.test.ts`(8 family 집계·침묵≠고장·unobservable escalation) |
| 2 | kill switch 3경로 테스트, alert 전송 mock 테스트, dead-man push mock 테스트 | **met** | `kill-switch.test.ts`(HTTP loopback+token 4건 / 파일 플래그 3건 / CLI 6건), `server.test.ts` "supervisor routes"(라우트 5건), `alerts.test.ts`(억제·Discord mock·전달 실패 로그에 URL 없음 10건), `deadman.test.ts`(push·주기·실패 카운트·URL 비노출 7건) |
| 3 | 각 컴포넌트에 supervisor가 정확히 하나임을 구조 테스트로 고정 | **met** | `restart.test.ts`(중복 등록 throw, 누락 시 `assertComplete()` throw, 위임 컴포넌트 `request()` throw), `supervisor.test.ts` "registers exactly one restart supervisor per component" / "never dials OBS itself: the connection loop stays ObsClient's" |
| 추가 | 시작 순서 고정(§7.3(3)·§9.1) | **met** | `startup.test.ts`(주입 객체 순서를 뒤집어도 실행 순서 불변, 실패 이후 skip), `runtime.test.ts`(포트 호출 순서 9단계) |
| 추가 | `/health`에 상태기계·신호 요약 | **met** | `server.test.ts` "reports the state machine and the family summary under /health", "lets the supervisor, not the engine, decide the status line" |
| 추가 | screenshot은 freeze 판정이 아님(§9.4) | **met** | `screenshot.test.ts` "never feeds a freeze verdict"(구조 검사: health 계약·집계기 import 없음, hash 없음) |
| 추가 | 모더레이션 호출표는 자리만(§12.3 Gate 0) | **met** | `config.test.ts` "ships unapproved and empty" / "refuses to report itself approved, and names what is missing" |

**실행 검증되지 않은 것(정직 표기)**: 실제 OBS·YouTube 계정·Discord webhook·Uptime Kuma 인스턴스에 붙여 본 적이 없다. 모든 테스트는 fake·mock이며, `integrations.obs`/`integrations.broadcast`를 켠 `main.ts` 조립 자체는 실행하지 않았다(실계정·실 OBS 필요 — E-2·E-3, Gate 2, T15 soak 대상).

### Gates (executed)

모두 rebase(`origin/main` = a885e6f, T11 #15 머지 포함) 후 재실행한 결과다.

```text
git fetch origin && git rebase origin/main -> Successfully rebased and updated refs/heads/dnhynk/t12-supervisor
npm run format:check -> All matched files use Prettier code style!
npm run lint         -> eslint 통과, check-no-legacy-imports: ok (0 legacy imports), check-install-scripts: ok (4 reviewed, better-sqlite3 binding loads)
npm run typecheck    -> tsc --build 통과(오류 0)
npm run test         -> Test Files 122 passed, Tests 1689 passed | 1 skipped (1690)
npm run build        -> 전 워크스페이스 통과(@vl/server: copied 5 migration(s), docs/ops/data-map.md up to date)
```

## Not done / out of scope

- **실계정 스모크**: 실제 OBS(E-3)·YouTube 방송·Discord·Uptime Kuma 검증. Gate 2와 T15 soak에서.
- **OBS 프로세스 실행기**: `obs-process` 컴포넌트의 자리·escalation·예산은 있으나 실제 실행 명령은 T17(Windows 자동시작)이 주입한다. 주입 전에는 escalation이 정직하게 실패하고 `safe_stopped`로 간다.
- **`metrics_daily` → retention.json `planned`→`present` 갱신**: 해당 테이블이 아직 없어(마이그레이션 001–005에 없음) 상태를 바꿀 근거가 없다. T15와 함께.
- **렌더러 URL·토큰의 OBS Browser Source 주입 함수**: T17과 분담 항목. `ObsControl.refreshBrowserSource()`(T2)는 `renderer-source` 컴포넌트 복구 동작으로 쓰고 있고, `SetInputSettings`로 URL을 주입하는 함수는 T17이 소유하는 편이 맞다고 판단해 넣지 않았다(현재 URL·토큰 주입 절차는 `docs/ops/obs-setup.md`).
- **시작 순서의 부분 재개**: 재시도는 전체 재실행이다(각 step은 멱등).

## Follow-ups

- T15: fault matrix 각 행의 예상 상태(`retry`/`degraded`/`safe_stopped`)를 이 상태기계에 대고 검증. `supervisor.*` provisional 값을 승인값으로 교체.
- T16: `docs/ops/supervisor.md`를 Gate 체크리스트에 연결하고, 모더레이션 호출표(§12.3) 승인 절차를 Gate 0 항목으로 명시.
- T17: `obs-process` 실행기 주입(`ComponentActions.obsProcess`), 렌더러 URL·토큰 주입, kill 플래그 파일 위치의 ACL.
