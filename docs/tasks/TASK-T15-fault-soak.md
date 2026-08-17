# TASK-T15-fault-soak

- Task: T15 fault matrix·72시간 soak harness (`docs/tasks/TASK_SPECS.md` §T15)
- Branch: `dnhynk/t15-fault-soak` · PR: #<n>
- Orca: task `task_f32603eaee51` · dispatch `ctx_394217ab9bcb`
- Spec sections read: §9.2, §9.4, §11 (전체), §10.2, §2
- BOARD decisions/assumptions relied on: D-2, D-3, A-5, A-14, A-15, A-16, E-5

## Goal

스펙 §11의 fault matrix를 **실행 전에 고정한 선언**으로 만들고(행마다 주입 방법·예상
상태 `retry|degraded|safe_stopped`·데이터 보존 결과), 모든 행을 실제 supervisor·engine·
store 위에서 자동으로 주입해 선언과 일치하는지 검증한다. 같은 주입 hook 위에 `tools/soak`
harness를 올려 CI에서 도는 **가속 시계 모드**와 호스트에서 도는 **실시간 모드**를 제공하고,
종료 리포트(중단·복구 횟수, 상태·이벤트 유실, freeze 카운터, p95)를 낸다. 합격선 숫자는
Gate 0/2 승인 전이므로 `provisional` config로 두고 잠기지 않은 값은 판정하지 않는다(A-15).

## Plan

1. **선언이 정본**: `tools/soak/src/matrix/rows.ts`에 §11 행 16개를 선언한다(id, 고장,
   주입 방법, 예상 상태, 데이터 보존, 스펙 근거). `docs/ops/fault-matrix.md`는 이 선언에서
   **스크립트로 생성**하고(`npm run soak -- matrix --write`), 체크인된 문서가 생성 결과와
   다르면 테스트가 깨지게 한다(CLAUDE.md §4 "생성물은 스크립트로").
2. **예상 상태의 출처**: 분류기가 이미 있는 행은 프로덕션 분류기가 정본이다 —
   `classifyOAuthError().faultAction`, `classifyYouTubeApiError().action`,
   `classifySqliteError()`. 테스트는 (a) 분류기 값 == 선언값, (b) 주입된 시스템의 관측 상태
   == 선언값을 **둘 다** 확인한다. harness가 스스로 답을 정하지 않는다.
3. **주입 hook (테스트/플래그 전용, `tools/soak/src/injection/`)**: 프로덕션 코드에 고장
   분기를 넣지 않고, T12가 이미 port로 뽑아 둔 자리(`ObsPort`/`BroadcastPort`/`ChatPort`/
   `PreflightProbes`/`ComponentActions`)에 고장 가능한 fake를 꽂는다. 신호는 프로덕션
   파생 함수(`deriveObsHealthSignals`, `deriveBroadcastHealthSignals`,
   `buildChatHealthSignals`)로 만들어 실제 신호 이름·이유 토큰이 aggregator에 들어가게 한다.
   - OAuth 만료·refresh 철회: 실제 `TokenManager` + `OAuthClient` + loopback 가짜 토큰
     엔드포인트(`invalid_grant` 시나리오) → `auth_revoked` → `supervisor.onAuthEvent`.
   - 403·429·quota·DNS: 가짜 API가 실제 응답 모양(reason 코드)으로 실패 → 프로덕션 분류기.
   - RTMPS 단절·OBS crash: `ObsOutputSample`을 재연결/비활성/미관측으로 바꾼다.
   - DB lock: 두 번째 연결이 `BEGIN IMMEDIATE`로 write lock 보유 → 진짜 `SQLITE_BUSY`.
   - disk-full: `PRAGMA max_page_count` → 진짜 `SQLITE_FULL`.
   - WebGL loss: 렌더러 WS 클라이언트가 `renderer_health{webglContextLost:true}` 송신.
   - host crash·crash window 4종: 실제 자식 프로세스를 그 지점까지 몰고 `SIGKILL`.
4. **`tools/soak` 패키지(`@vl/soak`)**: `SoakSystem`(store+engine+hub+HTTP+supervisor+
   renderer를 main.ts와 같은 순서로 조립) 위에서 `runSoak()`가 가속(VirtualClock)/실시간
   (systemClock) 두 모드로 돌고 `SoakReport`를 낸다.
5. **리포트·합격선**: `config/default.json`의 `soak` 절(provisional). 스펙 불변조건에서
   나오는 값(유실 0, 미복구 중단 0)만 판정하고, Gate 0/2가 잠글 시간 값(최대 중단·복구·p95)
   은 `null`로 두고 "not locked"로 보고한다(A-15).
6. **CI·문서**: `npm run soak:ci`를 CI에 추가하고 가속 soak를 `npm run test`에도 포함한다.
   `docs/ops/soak.md`에 실시간 72h 절차(사용자 실행)를 적는다. E-5로 GitHub Actions가
   결제 차단 중이면 로컬 실행 결과를 근거로 적고 "CI 미실행"을 정직하게 표기한다.

## Sources consulted (official docs)

| 주제 | URL | 확인일 | 결론 |
|---|---|---|---|
| SQLite `max_page_count` | https://sqlite.org/pragma.html#pragma_max_page_count | 2026-08-18 | 페이지 상한 초과 시 `SQLITE_FULL` — disk-full을 mock 없이 진짜 오류로 주입 가능 |
| SQLite 결과 코드 | https://sqlite.org/rescode.html | 2026-08-18 | `SQLITE_BUSY`/`SQLITE_FULL` 확장 코드 이름은 `better-sqlite3`의 `error.code` |
| SQLite `BEGIN IMMEDIATE` 잠금 | https://sqlite.org/lang_transaction.html | 2026-08-18 | IMMEDIATE는 즉시 write lock을 잡는다 → 다른 연결은 `busy_timeout` 후 `SQLITE_BUSY` |
| OAuth `invalid_grant` | https://developers.google.com/identity/protocols/oauth2 | 2026-08-18 | 철회·만료된 refresh token은 `invalid_grant` (T3 `errors.ts`가 이미 인용) |

## Questions asked (orca ask) and answers

| 질문 | 답(코디네이터) | 반영 |
|---|---|---|
| — | — | — |

## Assumptions / provisional values

| 항목 | 값 | 라벨 | 이유 |
|---|---|---|---|
| `soak.thresholds.*` 7개 전부 | `null` | provisional | §11이 Gate 0/2에서 잠그라고 한 값(최대 연속 중단·자동복구·freeze 허용치·alert 전달시간·p95·방송/상호작용 가용률). `null`은 "미승인"이며 리포트가 `not-locked`으로 **측정만** 하고 판정하지 않는다(A-15). 승인값을 config에 넣으면 그때부터 판정한다 |
| `soak.accelerated`·`soak.realtime` 실행 형태 | 72h / slice 10s(가속)·5s(실시간) / 5분·1분마다 명령 2건 / 3시간마다 고장 1건 | provisional | 스펙에 실행 예산이 없다. `sliceMs`만은 자유롭지 않다 — `supervisor.coordinatorHeartbeatTimeoutMs`(15s)를 넘으면 §9.4(1) coordinator가 항상 늦은 것으로 판정되므로 harness가 실행을 거부한다 |
| 불변조건(유실 0 / 미복구 중단 0 / 예기치 않은 safe stop 0 / writer 정상 / 종료 시 live) | 강제 | spec invariant | config가 아니라 코드에 두고 항목마다 근거 절을 리포트에 인쇄한다(§9.2, §11, §9.4(2)). 승인되지 않은 임계값이 이 다섯을 면제할 수 없다 |
| fault matrix 행 F-09 (OBS 재기동 미배선) | 별도 행으로 추가 | 코디네이터 판단 필요 없음 | §11은 "OBS crash" 한 항목이지만 현재 `main.ts`의 `obsProcess` 액션은 거부한다(T17 전). 같은 고장이 재기동 유무에 따라 `retry`와 `safe_stopped`로 갈리므로 두 행으로 고정했다 |
| fault matrix 행 F-18 (재시작 예산 소진) | 별도 행으로 추가 | 〃 | §9.2 "최대 재시도 후 safe_stopped"의 종점. F-05/F-12처럼 고칠 수 없는 degraded가 예산보다 오래 갈 때 무엇이 일어나는지 실행 전에 고정해야 한다 |

## Result

### Acceptance criteria

| # | 기준 | 상태 | 근거(테스트 파일·명령·출력) |
|---|---|---|---|
| 1 | matrix 모든 행이 자동 테스트로 존재하고 예상 상태와 일치 | met | 18행 전부: F-01~F-13·F-18은 `tools/soak/src/matrix/matrix.test.ts`(실제 supervisor·engine·store에 주입), F-14~F-17은 `tools/soak/src/matrix/crash-windows.test.ts`. 커버리지 자체를 `matrix.test.ts`의 `coverage > every fault matrix row has a drill`이 강제한다. `npx vitest run tools/soak` → **7 files, 44 tests passed** |
| 2 | 가속 soak가 CI에서 통과하고 리포트 산출 | met(로컬) / CI 미실행 | `npm run soak:ci` → 72.00h 시나리오를 53.6s에 완주, `verdict: PASS`, 리포트 인쇄 + `data/diagnostics/soak/accelerated.json`. `.github/workflows/ci.yml`에 `npm run soak:ci` 단계 추가. **CI에서는 실행하지 않았음: BOARD E-5(GitHub Actions 결제 차단)로 이 저장소의 모든 CI run이 2초 만에 실패한다.** 결제 복구 후 재확인 필요 |
| 3 | 실시간 72h는 절차만 문서화 | met | `docs/ops/soak.md` §4(사용자 실행 절차·사전 호스트 시험·리포트 첨부·"24/7 검증 완료"라 쓰지 않기). 실행하지 않았음: §T15가 이 PR의 합격 조건에서 제외 |

추가 근거:

- 행별 예상 상태를 harness가 정하지 않는다. 분류기가 있는 행은 테스트가 먼저
  `classifyOAuthError().faultAction`·`classifyYouTubeApiError().action`·`classifySqliteError()`·
  `classifyStoreFailure()`의 답과 표의 값이 같은지 확인한 뒤 주입 결과를 본다.
- `docs/ops/fault-matrix.md`는 `tools/soak/src/matrix/rows.ts`에서 생성한다(`npm run soak:matrix`).
  체크인된 파일이 생성 결과와 다르면 `doc.test.ts`가 실패하므로 "실행 전에 고정"이 유지된다.
- 고장은 가능한 한 진짜다: `SQLITE_BUSY`는 두 번째 연결의 `BEGIN IMMEDIATE`,
  `SQLITE_FULL`은 `PRAGMA max_page_count`가 소진된 실제 연결, `invalid_grant`는 실제
  `TokenManager`+`OAuthClient`가 loopback 토큰 엔드포인트에 건 실제 HTTP, host crash는 실제
  자식 프로세스 `SIGKILL`, §9.4 신호는 프로덕션 파생 함수가 만든다.

### 72h 가속 soak 리포트 (2026-08-17 18:05 UTC, 로컬)

```text
scenario:   72.00h in 53.6s wall clock      final state: live      verdict: PASS
slices 25920 · envelopes 1728/1728 (refused 0) · processedIngestSeq 1728 · stateRevision 10017
interruptions/recoveries 20/20 · freeze events 5 (5 during an injected drill) · safe stops 0
component restarts  renderer-source=5 obs-stream=4 chat-source=16 engine=1 obs-process=3
alerts  starting=1 restart_attempt=29 preflight_failed=1 live=21 degraded=20 recovering=4 restart_escalated=3
faults injected  F-07·F-06·F-13·F-04·F-11·F-08 × 4 rounds
invariants  no_event_lost ok / every_interruption_recovered ok / no_unexpected_safe_stop ok
            writer_not_wedged ok / ends_live ok
thresholds  7개 전부 not-locked (측정만): maxContinuousOutage 50000ms · maxRecovery 50000ms
            freezeEvents 5 · endToEndP95 0(가상 시계) · broadcastAvailability 0.9983
            interactionAvailability 0.9994
```

### Gates (executed)

```text
$ git fetch origin && git rebase origin/main      → Successfully rebased (3 commits)
$ npm run format:check                            → All matched files use Prettier code style!
$ npm run lint                                    → eslint ok · check-no-legacy-imports: ok (0) · check-install-scripts: ok (4)
$ npm run typecheck                               → tsc --build, 오류 없음
$ npm run test                                    → 130 files, 1767 passed | 1 skipped (1768), 39.06s
$ npm run build                                   → 전 workspace 성공(마이그레이션 5개 복사, data-map up to date)
$ npm run soak:ci                                 → 72.00h in 53.6s, verdict PASS, exit 0
$ npx vitest run tools/soak                       → 7 files, 44 tests passed
CI(.github/workflows/ci.yml)                      → 실행하지 않았음: BOARD E-5 결제 차단
```

## Not done / out of scope

- 실시간 72h 실행(§T15 합격 기준 3): 절차만 문서화, 사용자 실행.
- 실계정 YouTube 경로(공개 노출·YPP watch-hour·실거래 유료 이벤트)는 mock으로 판정하지 않는다(§11 마지막 문단). fault matrix의 YouTube 행은 API 오류 처리 경로만 다룬다.
- alert **전달시간**은 측정하지 않는다. soak은 외부 서비스에 접속하지 않으므로 Discord sink가 꺼져 있고(`RecordingAlertSink`는 즉시 전달) 측정값이 의미가 없다. 리포트는 `alertDeliveryMs`를 `—`로 낸다.
- 호스트 OS 시험(reboot·자동 시작·sleep·GPU reset·remote-session·자동 업데이트)은 §11이 72h soak **전에** 사람이 하라고 한 항목이며 T17 범위다.

## Follow-ups

- **[발견, T8/T11 후속] `POST /ingest/simulator`가 store 실패에 응답하지 않는다.**
  `apps/server/src/server.ts`가 `readJsonBody(req).then(body => { ... ingest.handle(body) ... })`
  안에서 endpoint를 호출하는데, `SimulatorIngestEndpoint.handle` → `StateEngine.ingest` →
  `commitIngestBatch`가 `SQLITE_BUSY`로 throw하면 그 rejection이 `.then` 밖으로 나가
  **unhandled rejection**이 되고 요청은 응답 없이 열린 채 남는다(호출자는 무한 대기).
  재현: fault matrix F-11(write lock 보유) 중에 `/ingest/simulator`로 POST.
  T15에서는 (a) soak 스케줄이 F-11 보유 중 주입을 건너뛰고(`SoakFault.skipsInjection`,
  이유를 주석에 명시) (b) `SoakSystem.inject()`가 실시간 마감시각을 둬 soak이 멈추지 않게 했다.
  프로덕션 수정(예: 503 응답)은 T8/T11 소유라 이 PR에서 하지 않았다. `simulator.enabled`가
  기본 false라 프로덕션 노출은 없지만, Node의 기본 동작상 unhandled rejection은 프로세스를
  종료시킨다.
- Gate 0/2 승인 후 `config/default.json`의 `soak.thresholds` 7개를 잠근다. 코드 변경은 필요 없다.
- T17이 OBS 재기동 액션을 배선하면 fault matrix F-09(재기동 미배선 → `safe_stopped`)를
  갱신한다. F-08/F-09 두 행이 그 전환을 이미 문서화한다.
- 가속 모드의 지연 수치는 시나리오 시간이라 p95가 0으로 나온다. Gate 2 calibration 때
  실시간 모드로 다시 측정한다(§7.5).
