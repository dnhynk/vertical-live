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
| `soak.thresholds.maxContinuousOutageMs` | `null` | provisional | Gate 0에서 승인(스펙 §11) — 잠기기 전에는 판정하지 않고 보고만 |
| `soak.thresholds.maxRecoveryMs` | `null` | provisional | 같음 |
| `soak.thresholds.endToEndP95Ms` | `null` | provisional | §7.5는 Gate 2 calibration 후 잠금(A-15) |
| `soak.thresholds.maxFreezeEvents` | `0` | spec invariant | §11 "renderer freeze 허용치"는 미정이나 *관측된 freeze 0*은 허용치와 무관하게 통과 조건 — 0을 초과하면 리포트가 판정을 보류하고 실패로 표시하지 않는다(아래 `freezeVerdict`) |
| `soak.thresholds.maxLostEvents` | `0` | spec invariant | §9.2 "degraded 동안 수신한 이벤트를 조용히 잃지 않는다" |
| `soak.thresholds.maxUnrecoveredInterruptions` | `0` | spec invariant | §11 무인성: 사람 조작 없이 복구 |
| 가속 시계 압축비 | 72h → config `accelerated.virtualDurationMs` | provisional | CI 실행 시간 예산은 스펙에 없음 |

## Result

### Acceptance criteria

| # | 기준 | 상태(met/unmet/unverifiable) | 근거(테스트 파일·명령·출력) |
|---|---|---|---|

### Gates (executed)

```text
```

## Not done / out of scope

- 실시간 72h 실행(§T15 합격 기준 3): 절차만 문서화, 사용자 실행.

## Follow-ups

- Gate 0/2 승인 후 `soak.thresholds`의 `null` 값을 잠근다.
