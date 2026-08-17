import type { FaultAction } from '@vl/server'
import type { SupervisorState } from '@vl/server/supervisor'

/**
 * The fault matrix of spec §11, **fixed before it is executed**.
 *
 * > "Gate 2 fault matrix에는 OAuth access-token 만료, refresh-token 철회, API
 * > 403·429와 quota 고갈, DNS·RTMPS 단절, DB lock, disk-full, WebGL context loss,
 * > OBS·host crash를 포함한다. inbox commit·token checkpoint·state commit·effect
 * > ACK 사이 각 crash window도 주입한다. 각 행마다 예상 상태인 `retry`,
 * > `degraded`, `safe_stopped`와 데이터 보존 결과를 먼저 고정한다."
 *
 * This module is the **canonical** statement of those rows.
 * `docs/ops/fault-matrix.md` is generated from it (`vl-soak matrix --write`), so
 * the document cannot drift from what the tests assert, and `matrix.test.ts`
 * injects every row and compares the observed outcome with `expected` /
 * `expectedState`. Its coverage check is derived from the drills that actually
 * ran, so a row added here without one fails.
 *
 * Where the product already owns a classifier, the expectation is **taken from
 * it** rather than restated here: `classifyOAuthError().faultAction` (T3),
 * `classifyYouTubeApiError().action` (T9/T10) and `classifySqliteError()` +
 * `classifyStoreFailure()` (T4/T12) decide `retry` / `degraded` / `safe_stopped`
 * in production, and `classifierSource` names the one that must agree with this
 * row. The harness never gets to invent the answer it then checks.
 */

/** How `expected` is observed on a running system. */
export const OUTCOME_RULES: Readonly<Record<FaultAction, string>> = Object.freeze({
  retry:
    '일시적인 조건으로 주입했을 때 사람 개입 없이 재시도·재연결·재시작만으로 `live`로 돌아온다(§9.1 일시 장애 자동 복구). supervisor 아래 계층에서 흡수되면 `live`를 벗어나지 않는다.',
  degraded:
    '조건이 남아 있는 동안 supervisor가 `degraded`/`recovering`을 보고하고, 세계·상태·송출은 계속되며, 수신한 이벤트를 잃지 않는다. 자동으로 멈추지 않는다.',
  safe_stopped:
    'supervisor가 `safe_stopped`로 들어가 종료 상태가 되고, 자동 재시작이 없으며, critical alert가 전달된다.',
})

export interface FaultMatrixRow {
  /** Stable id used by the generated document and by the test names. */
  readonly id: string
  /** The §11 fault, in the spec's own words. */
  readonly fault: string
  /** Spec clauses this row is taken from. */
  readonly spec: string
  /** How the harness injects it. Test/flag-only; no production branch. */
  readonly injection: string
  /** Expected supervisor response, fixed before execution. */
  readonly expected: FaultAction
  /** The §9.2 state the drill must observe while the condition is present. */
  readonly expectedState: SupervisorState
  /** What must still be true about persisted data afterwards. */
  readonly dataPreservation: string
  /** Production classifier that must agree with `expected`, when one exists. */
  readonly classifierSource: string | null
  /** Anything a reader needs in order to not misread the row. */
  readonly notes?: string
}

export const FAULT_MATRIX: readonly FaultMatrixRow[] = Object.freeze([
  {
    id: 'F-01',
    fault: 'OAuth access-token 만료',
    spec: '§11, §10.2',
    injection:
      '실제 `TokenManager`가 loopback 가짜 토큰 엔드포인트를 향한 채, 캐시된 access token을 버리고 갱신을 강제한다(`TokenManager.forceRefresh()` — T3가 "fault-matrix drills"용으로 남긴 진입점). 엔드포인트는 정상 응답한다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation:
      '보존할 상태 없음 — access token은 메모리에만 있고 refresh token은 vault 그대로다. inbox·checkpoint·state 무변경.',
    classifierSource: null,
    notes:
      'supervisor 아래에서 흡수된다: 갱신이 성공하므로 어떤 §9.4 family도 degraded를 보고하지 않는다.',
  },
  {
    id: 'F-02',
    fault: 'OAuth refresh-token 철회',
    spec: '§11, §9.1',
    injection: '가짜 토큰 엔드포인트가 `invalid_grant`(HTTP 400)로 답한다.',
    expected: 'safe_stopped',
    expectedState: 'safe_stopped',
    dataPreservation:
      'commit된 inbox·checkpoint·state·paid ledger 그대로. 재동의는 사람의 일이므로 재시작하지 않는다.',
    classifierSource: "classifyOAuthError().faultAction === 'safe_stopped'",
    notes:
      '`TokenManager`가 `revoked`로 latch하고 `auth_revoked`를 한 번 낸다 → `Supervisor.onAuthEvent` → `account_action` safe stop.',
  },
  {
    id: 'F-03',
    fault: 'YouTube API 403 (권한·정책)',
    spec: '§11, §9.1',
    injection:
      "가짜 Live API가 403 + `reason: 'insufficientLivePermissions'` 본문으로 답하고, T10의 safe-stop 경로가 이를 전달한다.",
    expected: 'safe_stopped',
    expectedState: 'safe_stopped',
    dataPreservation: '세계 상태는 디스크에 그대로. broadcast 자원은 손대지 않는다.',
    classifierSource: "classifyYouTubeApiError().action === 'safe_stopped'",
    notes:
      'reason 없는 403도 같은 판정이다(분류기 주석: 허용되지 않는 호출을 계속 두드리지 않는다).',
  },
  {
    id: 'F-04',
    fault: 'YouTube API 429 (rate limit)',
    spec: '§11',
    injection:
      "가짜 Live API가 429 + `Retry-After` + `reason: 'rateLimitExceeded'`를 몇 번 답한다.",
    expected: 'retry',
    expectedState: 'live',
    dataPreservation:
      '유실 0 — chat은 `nextPageToken` checkpoint에서 재개하고, 재시도 창에 받은 이벤트는 inbox에 남는다.',
    classifierSource: "classifyYouTubeApiError().action === 'retry'",
  },
  {
    id: 'F-05',
    fault: 'YouTube quota 고갈',
    spec: '§11, §9.1',
    injection: "가짜 Live API가 403 + `reason: 'quotaExceeded'`로 답하고 그 상태를 유지한다.",
    expected: 'degraded',
    expectedState: 'degraded',
    dataPreservation:
      '유실 0. 세계·상태 tick·렌더러는 계속 진행한다(§2.1: 시청자 0명이어도 진행). YouTube 호출만 멈춘다.',
    classifierSource: "classifyYouTubeApiError().action === 'degraded'",
    notes:
      '일일 quota는 태평양 자정에만 회복되므로 재시도가 고치지 못한다. 이 상태가 chat-source 재시작 예산보다 오래 가면 F-18이 된다.',
  },
  {
    id: 'F-06',
    fault: 'DNS 단절',
    spec: '§11',
    injection:
      '가짜 chat transport가 `ENOTFOUND`(Node error code)로 실패하다가 몇 번 뒤 정상으로 돌아온다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation: '유실 0 — 재연결 후 checkpoint에서 재개한다(§11 연결 복구).',
    classifierSource: "classifyYouTubeApiError().action === 'retry'",
  },
  {
    id: 'F-07',
    fault: 'RTMPS 단절',
    spec: '§11, §9.4(5)',
    injection:
      '가짜 OBS 표본이 `outputReconnecting=true`가 되고 `outputBytes`·`outputDurationMs`가 정체한다(프로덕션 `deriveObsHealthSignals`로 신호를 만든다).',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation: '세계 상태 무영향 — 송출만 끊긴다. inbox·state 무변경.',
    classifierSource: null,
    notes: '`obs_output` family degraded → `obs-stream` 재시작(§10.2 component 1:1).',
  },
  {
    id: 'F-08',
    fault: 'OBS process crash (재기동 가능)',
    spec: '§11, §9.4(5)',
    injection:
      'OBS를 관측 불가로 만든다(`unobservableObsHealthSignals`, `connected()=false`). `obs-process` 재기동 액션은 주입돼 있고 성공한다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation: '세계 상태 무영향.',
    classifierSource: null,
    notes:
      '`obs-connection`은 `ObsClient`가 소유한 loop을 관측만 하고(§10.2), 예산을 넘기면 `obs-process`로 승격한다.',
  },
  {
    id: 'F-09',
    fault: 'OBS process crash (재기동 미배선 — 현재 프로덕션)',
    spec: '§11, §9.2',
    injection: 'F-08과 같되 `obs-process` 액션이 거부한다(T17 전 `main.ts`의 실제 동작).',
    expected: 'safe_stopped',
    expectedState: 'safe_stopped',
    dataPreservation: '세계 상태 무영향. 복구할 수 없는 recovering에 남지 않는다.',
    classifierSource: null,
    notes: '승격 대상까지 예산을 소진하면 §9.2 "최대 재시도 후 safe_stopped"다.',
  },
  {
    id: 'F-10',
    fault: 'host crash (프로세스 SIGKILL)',
    spec: '§11 상태 복구',
    injection:
      '자식 프로세스가 프로덕션 `PersistenceStore`·`StateEngine`으로 이벤트를 처리해 상태를 commit하고, 이어 받은 batch는 inbox에만 commit한 채(드레인 전) 그 지점에서 스레드를 멈춘다. 부모가 `SIGKILL`한다. 그 뒤 같은 파일 위에 supervisor를 포함한 시스템을 다시 띄워 복구를 관측한다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation:
      'commit된 것만 남는다: 미처리 `ingestSeq`는 복구 커서 아래로 묻히지 않고 재드레인되며, 마지막 commit 상태와 deadline이 복원된다.',
    classifierSource: null,
  },
  {
    id: 'F-11',
    fault: 'DB lock',
    spec: '§11, BOARD A-5',
    injection:
      '두 번째 연결이 `BEGIN IMMEDIATE`로 write lock을 잡아 `busy_timeout`이 지나게 하고, 그 뒤 놓는다. 진짜 `SQLITE_BUSY`다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation: '부분 commit 없음 — 실패한 pass의 batch는 inbox에 그대로 남아 다시 처리된다.',
    classifierSource: "classifySqliteError().kind === 'busy' (retryable)",
  },
  {
    id: 'F-12',
    fault: 'disk-full',
    spec: '§11, §9.1',
    injection:
      '프로덕션 store가 연 그 연결에서(`openDatabase`를 감싸 포착) `VACUUM` 후 `max_page_count`를 현재 페이지 수로 낮춰 실제로 꽉 찬 파일을 만든다(`max_page_count`는 연결별이고 파일에 저장되지 않음을 측정으로 확인). inbox에 미처리 rows를 남겨 둔 상태이므로 실제 writer pass와 실제 `commitIngestBatch`가 SQLite가 낸 `SQLITE_FULL`로 실패한다.',
    expected: 'degraded',
    expectedState: 'degraded',
    dataPreservation:
      '부분 commit 없음. 이미 commit된 상태·paid ledger는 그대로. 데이터 무결성 사건이 아니므로 자동 정지하지 않는다.',
    classifierSource: "classifyStoreFailure().integrity === false ('SQLITE_FULL')",
    notes: '운영자가 치울 수 있는 조건이다(§9.1). 예산을 넘기면 F-18.',
  },
  {
    id: 'F-13',
    fault: 'WebGL context loss',
    spec: '§11, §9.4(4)',
    injection: '렌더러가 `renderer_health{webglContextLost:true}` 프레임을 보내고, 뒤에 회복한다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation:
      '세계 상태 무영향. 재부착 뒤 snapshot 치환과 미ACK effect 재전송으로 화면이 복구된다(§7.3(7)).',
    classifierSource: null,
    notes: '`renderer` family degraded(`webgl_context_lost`) → `renderer-source` 재시작.',
  },
  {
    id: 'F-14',
    fault: 'crash window: inbox commit 전',
    spec: '§11, §7.3(3)(5)',
    injection:
      '자식 프로세스의 프로덕션 엔진이 `commitIngestBatch` 트랜잭션 안 — 행을 쓴 뒤 checkpoint 시각을 읽는 지점 — 에서 스레드를 멈추고, 부모가 그 상태로 `SIGKILL`한다. COMMIT은 일어나지 않는다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation: 'inbox row도 checkpoint도 남지 않는다. 원본에서 다시 받는다.',
    classifierSource: null,
  },
  {
    id: 'F-15',
    fault: 'crash window: inbox·token checkpoint commit 직후 / state commit 전',
    spec: '§11, §7.3(3)(5)',
    injection:
      '자식 프로세스의 프로덕션 엔진이 ingest 트랜잭션을 COMMIT한 직후, writer pass 전에 멈추고 부모가 `SIGKILL`한다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation:
      'inbox와 `nextPageToken`은 같은 트랜잭션이므로 함께 남고, `processedIngestSeq`는 전진하지 않아 재시작 후 그대로 드레인된다.',
    classifierSource: null,
    notes: 'inbox insert와 checkpoint는 T4에서 한 트랜잭션이다 — 둘 사이에 crash window가 없다.',
  },
  {
    id: 'F-16',
    fault: 'crash window: state commit 직후 / effect 발행 전',
    spec: '§11, §7.3(6)',
    injection:
      '자식 프로세스의 프로덕션 엔진이 상태 전이 트랜잭션을 COMMIT한 직후 `publishSnapshot` 진입 지점에서 멈추고 부모가 `SIGKILL`한다. effect는 outbox에 있으나 published 표시가 없다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation:
      'snapshot·engine state·effect outbox·커서가 한 트랜잭션으로 남고, 미발행 effect는 재시작 후 발행된다.',
    classifierSource: null,
  },
  {
    id: 'F-17',
    fault: 'crash window: effect 발행 직후 / ACK 전',
    spec: '§11, §7.3(7)',
    injection:
      '자식 프로세스의 프로덕션 엔진이 `markEffectPublished`를 commit한 직후 `publishEffect` 진입 지점에서 멈추고 부모가 `SIGKILL`한다. ACK를 보낸 렌더러는 없다.',
    expected: 'retry',
    expectedState: 'live',
    dataPreservation:
      '해당 effect는 미ACK로 복구돼 재전송되고, 같은 `effectId`이므로 렌더러가 연출을 다시 시작하지 않는다.',
    classifierSource: null,
  },
  {
    id: 'F-18',
    fault: '재시작 예산 소진 (지속되는 degraded)',
    spec: '§11 안전 정지, §9.2',
    injection:
      'F-05(quota 고갈)를 chat-source 재시작 예산(`supervisor.restart.maxAttempts`)보다 오래 유지한다.',
    expected: 'safe_stopped',
    expectedState: 'safe_stopped',
    dataPreservation: 'commit된 것 전부 보존. 자동 재시작 없음, critical alert 전달.',
    classifierSource: null,
    notes: '고칠 수 없는 조건을 무한히 재시작하지 않는다는 §9.2의 종점이다.',
  },
])

export function findFaultRow(id: string): FaultMatrixRow | undefined {
  return FAULT_MATRIX.find((row) => row.id === id)
}

export function requireFaultRow(id: string): FaultMatrixRow {
  const row = findFaultRow(id)
  if (row === undefined) throw new Error(`no fault matrix row with id ${id}`)
  return row
}
