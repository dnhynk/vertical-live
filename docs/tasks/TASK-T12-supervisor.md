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
