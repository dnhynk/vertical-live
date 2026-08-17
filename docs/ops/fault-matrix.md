# Fault matrix (스펙 §11)

> 생성물입니다. 정본은 `tools/soak/src/matrix/rows.ts`이고 이 파일은 `npm run soak -- matrix --write`로 만듭니다. 직접 고치지 마세요 — `tools/soak/src/matrix/doc.test.ts`가 어긋남을 잡습니다.

스펙 §11은 각 고장마다 **예상 상태(`retry` · `degraded` · `safe_stopped`)와 데이터 보존 결과를 실행 전에 고정**하라고 요구합니다. 아래 표가 그 고정값이고, `tools/soak/src/matrix/matrix.test.ts`가 행마다 고장을 실제 supervisor·engine·store에 주입해 관측 결과를 이 표와 대조합니다.

## 예상 상태의 뜻 (관측 규칙)

| 예상 상태 | 관측되면 통과인 것 |
|---|---|
| `retry` | 일시적인 조건으로 주입했을 때 사람 개입 없이 재시도·재연결·재시작만으로 `live`로 돌아온다(§9.1 일시 장애 자동 복구). supervisor 아래 계층에서 흡수되면 `live`를 벗어나지 않는다. |
| `degraded` | 조건이 남아 있는 동안 supervisor가 `degraded`/`recovering`을 보고하고, 세계·상태·송출은 계속되며, 수신한 이벤트를 잃지 않는다. 자동으로 멈추지 않는다. |
| `safe_stopped` | supervisor가 `safe_stopped`로 들어가 종료 상태가 되고, 자동 재시작이 없으며, critical alert가 전달된다. |

`retry`·`degraded`·`safe_stopped`는 supervisor 상태 이름이 아니라 **대응 방식**입니다(§9.2의 상태는 `offline → starting → live → degraded → recovering → live | safe_stopped`). 표의 "관측 상태" 열이 그 조건이 있는 동안 드릴이 실제로 관측해야 하는 §9.2 상태입니다.

예상 상태를 harness가 정하지 않습니다. 프로덕션에 분류기가 있는 행은 그 분류기가 정본이고(표의 "분류기" 열), 테스트가 분류기 값과 이 표의 값이 같은지 먼저 확인한 뒤 주입 결과를 확인합니다.

## 행

| # | 고장 | 스펙 | 예상 상태 | 관측 상태 | 데이터 보존 |
|---|---|---|---|---|---|
| F-01 | OAuth access-token 만료 | §11, §10.2 | `retry` | `live` | 보존할 상태 없음 — access token은 메모리에만 있고 refresh token은 vault 그대로다. inbox·checkpoint·state 무변경. |
| F-02 | OAuth refresh-token 철회 | §11, §9.1 | `safe_stopped` | `safe_stopped` | commit된 inbox·checkpoint·state·paid ledger 그대로. 재동의는 사람의 일이므로 재시작하지 않는다. |
| F-03 | YouTube API 403 (권한·정책) | §11, §9.1 | `safe_stopped` | `safe_stopped` | 세계 상태는 디스크에 그대로. broadcast 자원은 손대지 않는다. |
| F-04 | YouTube API 429 (rate limit) | §11 | `retry` | `live` | 유실 0 — chat은 `nextPageToken` checkpoint에서 재개하고, 재시도 창에 받은 이벤트는 inbox에 남는다. |
| F-05 | YouTube quota 고갈 | §11, §9.1 | `degraded` | `degraded` | 유실 0. 세계·상태 tick·렌더러는 계속 진행한다(§2.1: 시청자 0명이어도 진행). YouTube 호출만 멈춘다. |
| F-06 | DNS 단절 | §11 | `retry` | `live` | 유실 0 — 재연결 후 checkpoint에서 재개한다(§11 연결 복구). |
| F-07 | RTMPS 단절 | §11, §9.4(5) | `retry` | `live` | 세계 상태 무영향 — 송출만 끊긴다. inbox·state 무변경. |
| F-08 | OBS process crash (재기동 가능) | §11, §9.4(5) | `retry` | `live` | 세계 상태 무영향. |
| F-09 | OBS process crash (재기동 미배선 — 현재 프로덕션) | §11, §9.2 | `safe_stopped` | `safe_stopped` | 세계 상태 무영향. 복구할 수 없는 recovering에 남지 않는다. |
| F-10 | host crash (프로세스 SIGKILL) | §11 상태 복구 | `retry` | `live` | commit된 것만 남는다: 미처리 `ingestSeq`는 복구 커서 아래로 묻히지 않고 재드레인되며, 마지막 commit 상태와 deadline이 복원된다. |
| F-11 | DB lock | §11, BOARD A-5 | `retry` | `live` | 부분 commit 없음 — 실패한 pass의 batch는 inbox에 그대로 남아 다시 처리된다. |
| F-12 | disk-full | §11, §9.1 | `degraded` | `degraded` | 부분 commit 없음. 이미 commit된 상태·paid ledger는 그대로. 데이터 무결성 사건이 아니므로 자동 정지하지 않는다. |
| F-13 | WebGL context loss | §11, §9.4(4) | `retry` | `live` | 세계 상태 무영향. 재부착 뒤 snapshot 치환과 미ACK effect 재전송으로 화면이 복구된다(§7.3(7)). |
| F-14 | crash window: inbox commit 전 | §11, §7.3(3)(5) | `retry` | `live` | inbox row도 checkpoint도 남지 않는다. 원본에서 다시 받는다. |
| F-15 | crash window: inbox·token checkpoint commit 직후 / state commit 전 | §11, §7.3(3)(5) | `retry` | `live` | inbox와 `nextPageToken`은 같은 트랜잭션이므로 함께 남고, `processedIngestSeq`는 전진하지 않아 재시작 후 그대로 드레인된다. |
| F-16 | crash window: state commit 직후 / effect 발행 전 | §11, §7.3(6) | `retry` | `live` | snapshot·engine state·effect outbox·커서가 한 트랜잭션으로 남고, 미발행 effect는 재시작 후 발행된다. |
| F-17 | crash window: effect 발행 직후 / ACK 전 | §11, §7.3(7) | `retry` | `live` | 해당 effect는 미ACK로 복구돼 재전송되고, 같은 `effectId`이므로 렌더러가 연출을 다시 시작하지 않는다. |
| F-18 | 재시작 예산 소진 (지속되는 degraded) | §11 안전 정지, §9.2 | `safe_stopped` | `safe_stopped` | commit된 것 전부 보존. 자동 재시작 없음, critical alert 전달. |

## 주입 방법

### F-01 — OAuth access-token 만료

- 스펙: §11, §10.2
- 주입: 실제 `TokenManager`가 loopback 가짜 토큰 엔드포인트를 향한 채, 캐시된 access token을 버리고 갱신을 강제한다(`TokenManager.forceRefresh()` — T3가 "fault-matrix drills"용으로 남긴 진입점). 엔드포인트는 정상 응답한다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: 보존할 상태 없음 — access token은 메모리에만 있고 refresh token은 vault 그대로다. inbox·checkpoint·state 무변경.
- 분류기: 없음(관측으로만 판정)
- 비고: supervisor 아래에서 흡수된다: 갱신이 성공하므로 어떤 §9.4 family도 degraded를 보고하지 않는다.

### F-02 — OAuth refresh-token 철회

- 스펙: §11, §9.1
- 주입: 가짜 토큰 엔드포인트가 `invalid_grant`(HTTP 400)로 답한다.
- 예상 상태: `safe_stopped` · 관측 상태: `safe_stopped`
- 데이터 보존: commit된 inbox·checkpoint·state·paid ledger 그대로. 재동의는 사람의 일이므로 재시작하지 않는다.
- 분류기: `classifyOAuthError().faultAction === 'safe_stopped'`
- 비고: `TokenManager`가 `revoked`로 latch하고 `auth_revoked`를 한 번 낸다 → `Supervisor.onAuthEvent` → `account_action` safe stop.

### F-03 — YouTube API 403 (권한·정책)

- 스펙: §11, §9.1
- 주입: 가짜 Live API가 403 + `reason: 'insufficientLivePermissions'` 본문으로 답하고, T10의 safe-stop 경로가 이를 전달한다.
- 예상 상태: `safe_stopped` · 관측 상태: `safe_stopped`
- 데이터 보존: 세계 상태는 디스크에 그대로. broadcast 자원은 손대지 않는다.
- 분류기: `classifyYouTubeApiError().action === 'safe_stopped'`
- 비고: reason 없는 403도 같은 판정이다(분류기 주석: 허용되지 않는 호출을 계속 두드리지 않는다).

### F-04 — YouTube API 429 (rate limit)

- 스펙: §11
- 주입: 가짜 Live API가 429 + `Retry-After` + `reason: 'rateLimitExceeded'`를 몇 번 답한다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: 유실 0 — chat은 `nextPageToken` checkpoint에서 재개하고, 재시도 창에 받은 이벤트는 inbox에 남는다.
- 분류기: `classifyYouTubeApiError().action === 'retry'`

### F-05 — YouTube quota 고갈

- 스펙: §11, §9.1
- 주입: 가짜 Live API가 403 + `reason: 'quotaExceeded'`로 답하고 그 상태를 유지한다.
- 예상 상태: `degraded` · 관측 상태: `degraded`
- 데이터 보존: 유실 0. 세계·상태 tick·렌더러는 계속 진행한다(§2.1: 시청자 0명이어도 진행). YouTube 호출만 멈춘다.
- 분류기: `classifyYouTubeApiError().action === 'degraded'`
- 비고: 일일 quota는 태평양 자정에만 회복되므로 재시도가 고치지 못한다. 이 상태가 chat-source 재시작 예산보다 오래 가면 F-18이 된다.

### F-06 — DNS 단절

- 스펙: §11
- 주입: 가짜 chat transport가 `ENOTFOUND`(Node error code)로 실패하다가 몇 번 뒤 정상으로 돌아온다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: 유실 0 — 재연결 후 checkpoint에서 재개한다(§11 연결 복구).
- 분류기: `classifyYouTubeApiError().action === 'retry'`

### F-07 — RTMPS 단절

- 스펙: §11, §9.4(5)
- 주입: 가짜 OBS 표본이 `outputReconnecting=true`가 되고 `outputBytes`·`outputDurationMs`가 정체한다(프로덕션 `deriveObsHealthSignals`로 신호를 만든다).
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: 세계 상태 무영향 — 송출만 끊긴다. inbox·state 무변경.
- 분류기: 없음(관측으로만 판정)
- 비고: `obs_output` family degraded → `obs-stream` 재시작(§10.2 component 1:1).

### F-08 — OBS process crash (재기동 가능)

- 스펙: §11, §9.4(5)
- 주입: OBS를 관측 불가로 만든다(`unobservableObsHealthSignals`, `connected()=false`). `obs-process` 재기동 액션은 주입돼 있고 성공한다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: 세계 상태 무영향.
- 분류기: 없음(관측으로만 판정)
- 비고: `obs-connection`은 `ObsClient`가 소유한 loop을 관측만 하고(§10.2), 예산을 넘기면 `obs-process`로 승격한다.

### F-09 — OBS process crash (재기동 미배선 — 현재 프로덕션)

- 스펙: §11, §9.2
- 주입: F-08과 같되 `obs-process` 액션이 거부한다(T17 전 `main.ts`의 실제 동작).
- 예상 상태: `safe_stopped` · 관측 상태: `safe_stopped`
- 데이터 보존: 세계 상태 무영향. 복구할 수 없는 recovering에 남지 않는다.
- 분류기: 없음(관측으로만 판정)
- 비고: 승격 대상까지 예산을 소진하면 §9.2 "최대 재시도 후 safe_stopped"다.

### F-10 — host crash (프로세스 SIGKILL)

- 스펙: §11 상태 복구
- 주입: 자식 프로세스가 실제 엔진으로 이벤트를 처리한 뒤 `ready`를 보고하고 부모가 `SIGKILL`한다. 같은 DB 파일로 새 엔진을 띄운다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: commit된 것만 남는다: 미처리 `ingestSeq`는 복구 커서 아래로 묻히지 않고 재드레인되며, 마지막 commit 상태와 deadline이 복원된다.
- 분류기: 없음(관측으로만 판정)

### F-11 — DB lock

- 스펙: §11, BOARD A-5
- 주입: 두 번째 연결이 `BEGIN IMMEDIATE`로 write lock을 잡아 `busy_timeout`이 지나게 하고, 그 뒤 놓는다. 진짜 `SQLITE_BUSY`다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: 부분 commit 없음 — 실패한 pass의 batch는 inbox에 그대로 남아 다시 처리된다.
- 분류기: `classifySqliteError().kind === 'busy' (retryable)`

### F-12 — disk-full

- 스펙: §11, §9.1
- 주입: `PRAGMA max_page_count`가 소진된 연결에서 쓰기가 실패한다. SQLite가 직접 낸 `SQLITE_FULL`을 쓴다(손으로 만든 오류 객체가 아니다).
- 예상 상태: `degraded` · 관측 상태: `degraded`
- 데이터 보존: 부분 commit 없음. 이미 commit된 상태·paid ledger는 그대로. 데이터 무결성 사건이 아니므로 자동 정지하지 않는다.
- 분류기: `classifyStoreFailure().integrity === false ('SQLITE_FULL')`
- 비고: 운영자가 치울 수 있는 조건이다(§9.1). 예산을 넘기면 F-18.

### F-13 — WebGL context loss

- 스펙: §11, §9.4(4)
- 주입: 렌더러가 `renderer_health{webglContextLost:true}` 프레임을 보내고, 뒤에 회복한다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: 세계 상태 무영향. 재부착 뒤 snapshot 치환과 미ACK effect 재전송으로 화면이 복구된다(§7.3(7)).
- 분류기: 없음(관측으로만 판정)
- 비고: `renderer` family degraded(`webgl_context_lost`) → `renderer-source` 재시작.

### F-14 — crash window: inbox commit 전

- 스펙: §11, §7.3(3)(5)
- 주입: inbox row를 연 트랜잭션 안에 쓴 직후, COMMIT 전에 프로세스를 `SIGKILL`한다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: inbox row도 checkpoint도 남지 않는다. 원본에서 다시 받는다.
- 분류기: 없음(관측으로만 판정)

### F-15 — crash window: inbox·token checkpoint commit 직후 / state commit 전

- 스펙: §11, §7.3(3)(5)
- 주입: ingest 트랜잭션이 COMMIT된 직후 `SIGKILL`한다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: inbox와 `nextPageToken`은 같은 트랜잭션이므로 함께 남고, `processedIngestSeq`는 전진하지 않아 재시작 후 그대로 드레인된다.
- 분류기: 없음(관측으로만 판정)
- 비고: inbox insert와 checkpoint는 T4에서 한 트랜잭션이다 — 둘 사이에 crash window가 없다.

### F-16 — crash window: state commit 직후 / effect 발행 전

- 스펙: §11, §7.3(6)
- 주입: 상태 전이 트랜잭션이 COMMIT된 직후, effect를 발행하기 전에 `SIGKILL`한다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: snapshot·engine state·effect outbox·커서가 한 트랜잭션으로 남고, 미발행 effect는 재시작 후 발행된다.
- 분류기: 없음(관측으로만 판정)

### F-17 — crash window: effect 발행 직후 / ACK 전

- 스펙: §11, §7.3(7)
- 주입: effect를 published로 표시한 직후 `SIGKILL`한다.
- 예상 상태: `retry` · 관측 상태: `live`
- 데이터 보존: 해당 effect는 미ACK로 복구돼 재전송되고, 같은 `effectId`이므로 렌더러가 연출을 다시 시작하지 않는다.
- 분류기: 없음(관측으로만 판정)

### F-18 — 재시작 예산 소진 (지속되는 degraded)

- 스펙: §11 안전 정지, §9.2
- 주입: F-05(quota 고갈)를 chat-source 재시작 예산(`supervisor.restart.maxAttempts`)보다 오래 유지한다.
- 예상 상태: `safe_stopped` · 관측 상태: `safe_stopped`
- 데이터 보존: commit된 것 전부 보존. 자동 재시작 없음, critical alert 전달.
- 분류기: 없음(관측으로만 판정)
- 비고: 고칠 수 없는 조건을 무한히 재시작하지 않는다는 §9.2의 종점이다.

## 이 표가 다루지 않는 것

- 실계정 YouTube 경로(공개 9:16 노출, YPP watch-hour, 활성화된 유료 기능의 실거래)는 mock으로 합격 판정하지 않습니다(§11 마지막 문단). 여기의 YouTube 행은 API 오류 처리 경로만 다룹니다.
- 호스트 OS 항목(reboot·자동 시작·sleep·GPU reset·remote-session 종료·자동 업데이트)은 72시간 soak **전에** 사람이 시험합니다(§11). 절차는 `docs/ops/soak.md`와 T17의 `docs/ops/windows-host.md`에 있습니다.
- 합격선 숫자(최대 연속 중단·자동복구 시간·freeze 허용치·alert 전달시간·가용률·p95)는 Gate 0/2가 잠급니다. 이 표는 상태와 데이터 보존만 고정합니다(BOARD A-15).
